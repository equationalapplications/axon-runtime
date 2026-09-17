import type { DeployConfig } from '../config/deploy.js';
import { RejectError } from '../contract/errors.js';
import { EnvelopeSchema, CONTRACT_VERSION, type Envelope, type ExitReason, type JobRequest, type JobStatus, type RejectReason, type Telemetry, type SubmitResult } from '../contract/schema.js';
import type { Executor, RunResult, Workspace } from '../executor/types.js';
import type { BudgetGuard } from '../harness/budget.js';
import type { ArtifactStore } from './artifacts.js';
import type { JobStore } from '../state/store.js';
import { validateJob } from './validate.js';

export type { SubmitResult } from '../contract/schema.js';

export interface PoolOptions {
  cfg: DeployConfig;
  store: JobStore;
  executor: Executor;
  budget: BudgetGuard;
  artifacts: ArtifactStore;
  runtimeVersion: string;
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

export class JobPool {
  private readonly running = new Map<string, Running>();

  constructor(private readonly opts: PoolOptions) {}

  activeCount(): number {
    return this.running.size;
  }

  /**
   * Admission is synchronous from first byte to `running.set`, which is what
   * serializes it: Node runs this whole method without yielding, so two
   * dispatches cannot both observe the same free slot or the same remaining
   * daily budget.
   */
  submit(body: unknown): SubmitResult {
    const jobId = (body as { job_id?: unknown } | null)?.job_id;
    if (typeof jobId === 'string') {
      const existing = this.opts.store.get(jobId);
      if (existing) return { job_id: jobId, status: 'accepted' };
    }

    let job: JobRequest;
    try {
      job = validateJob(body, this.opts.cfg);
      if (this.running.size >= this.opts.cfg.maxConcurrentJobs) {
        throw new RejectError('queue_full', `node is at ${this.opts.cfg.maxConcurrentJobs} concurrent jobs`);
      }
      this.opts.budget.admit();
    } catch (err) {
      if (err instanceof RejectError) {
        // A malformed payload may lack a usable job_id; the rejection is still
        // a 400-class reply (only recordable rejections hit the store).
        if (typeof jobId === 'string') this.storeRejection(jobId, err.reason);
        return { job_id: typeof jobId === 'string' ? jobId : '', status: 'rejected', reason: err.reason };
      }
      throw err;
    }

    this.opts.store.create(job);
    const controller = new AbortController();
    const done = this.execute(job, controller.signal);
    this.running.set(job.job_id, { controller, done });
    void done.finally(() => this.running.delete(job.job_id));
    return { job_id: job.job_id, status: 'accepted' };
  }

  cancel(jobId: string): boolean {
    const entry = this.running.get(jobId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  envelope(jobId: string): Envelope | undefined {
    const rec = this.opts.store.get(jobId);
    if (!rec) return undefined;
    if (rec.status === 'running') return undefined;
    return EnvelopeSchema.parse({
      contract_version: CONTRACT_VERSION,
      job_id: rec.jobId,
      node_id: this.opts.cfg.nodeId,
      status: rec.status,
      reason: rec.status === 'rejected' ? (JSON.parse(rec.resultJson ?? '{}').reason ?? null) : null,
      error_detail: rec.errorDetail,
      result: rec.status === 'rejected' ? null : (rec.resultJson ? JSON.parse(rec.resultJson) : null),
      telemetry: rec.telemetryJson ? JSON.parse(rec.telemetryJson) : null,
    });
  }

  private storeRejection(jobId: string, reason: RejectReason): void {
    const store = this.opts.store;
    if (!store.get(jobId)) {
      store.createRejected(jobId, reason);
    }
  }

  private finishWithHarnessError(job: JobRequest, startedAt: Date, err: unknown): void {
    const endedAt = new Date();
    const telemetry: Telemetry = {
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      harness_steps: 0,
      tokens_in: 0,
      tokens_out: 0,
      cost_estimate_usd: 0,
      exit_reason: 'harness_error',
      node_id: this.opts.cfg.nodeId,
      executor: this.opts.executor.kind,
      model_id: this.opts.cfg.endpoint.model,
      endpoint_base_url: this.opts.cfg.endpoint.baseUrl,
      runtime_version: this.opts.runtimeVersion,
      harness_version: 'unknown',
    };
    const detail = errorDetailFor(err);
    this.opts.store.finish(job.job_id, 'error', null, telemetry, detail);
    // Log the Error itself (with stack) when present; fall back to the
    // sanitized detail for non-Error throwables since console.error would
    // otherwise stringify an arbitrary object as "[object Object]".
    if (err instanceof Error) {
      console.error(`job ${job.job_id} failed in prepare():`, err);
    } else {
      console.error(`job ${job.job_id} failed in prepare():`, detail);
    }
  }

  private timeoutElapsed(startedAt: Date, job: JobRequest): boolean {
    return Date.now() - startedAt.getTime() >= job.constraints.timeout_seconds * 1000;
  }

  private async execute(job: JobRequest, signal: AbortSignal): Promise<void> {
    const startedAt = new Date();
    let ws: Workspace;
    try {
      ws = await this.opts.executor.prepare(job);
    } catch (err) {
      // prepare() never yielded a workspace: record a terminal outcome so the
      // job is not stranded in 'running', then rethrow nothing — the slot is
      // released by submit()'s finally on `done`.
      this.finishWithHarnessError(job, startedAt, err);
      return;
    }
    let result: RunResult | null = null;
    let exitReason: ExitReason = 'completed';

    // Wall-clock cap: abort the executor's signal when the job outruns its
    // per-job timeout, then classify the outcome as 'timeout' regardless of
    // what the executor reports — the clock, not the harness, decided.
    const timer = setTimeout(() => this.cancel(job.job_id), job.constraints.timeout_seconds * 1000);

    let runError: unknown;
    try {
      result = await this.opts.executor.run(ws, job, signal);
      if (signal.aborted && this.timeoutElapsed(startedAt, job)) exitReason = 'timeout';
      else exitReason = result.exitReason;
    } catch (err) {
      runError = err;
      exitReason = signal.aborted && this.timeoutElapsed(startedAt, job) ? 'timeout' : 'harness_error';
    } finally {
      clearTimeout(timer);
      await this.opts.executor.teardown(ws).catch(() => undefined);
    }

    const endedAt = new Date();
    const telemetry: Telemetry = {
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      harness_steps: result?.harnessSteps ?? this.opts.store.get(job.job_id)?.harnessSteps ?? 0,
      tokens_in: result?.tokensIn ?? 0,
      tokens_out: result?.tokensOut ?? 0,
      cost_estimate_usd: result?.costUsd ?? this.opts.budget.jobSpend(job.job_id),
      exit_reason: exitReason,
      node_id: this.opts.cfg.nodeId,
      executor: this.opts.executor.kind,
      model_id: result?.modelId ?? this.opts.cfg.endpoint.model,
      endpoint_base_url: result?.endpointBaseUrl ?? this.opts.cfg.endpoint.baseUrl,
      runtime_version: this.opts.runtimeVersion,
      harness_version: result?.harnessVersion ?? 'unknown',
    };

    let patch = result?.patch ?? null;
    let patchArtifact: string | null = null;
    if (patch !== null && Buffer.byteLength(patch, 'utf8') > this.opts.cfg.maxInlinePatchBytes) {
      patchArtifact = this.opts.artifacts.write(job.job_id, 'patch.diff', patch);
      patch = null;
    }

    this.opts.store.finish(job.job_id, statusFor(exitReason), result && {
      output: result.output,
      patch,
      patch_artifact: patchArtifact,
      summary: result.summary,
    }, telemetry, exitReason === 'harness_error' ? errorDetailFor(runError) : null);
  }
}

export function statusFor(exitReason: ExitReason): JobStatus {
  switch (exitReason) {
    case 'completed':
      return 'ok';
    case 'timeout':
      return 'timeout';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'error';
  }
}

/**
 * Format a thrown error into the durable `error_detail` string surfaced on the
 * envelope when `exit_reason === 'harness_error'`. Sanitize rather than drop:
 * cap length, fall back to a non-empty placeholder when the throwable carried
 * nothing (e.g. `throw {}`), and tolerate throwables whose coercion throws
 * (e.g. `Object.create(null)`, an Error subclass whose `message` getter
 * throws, or one with a throwing `toString`).
 */
export function errorDetailFor(err: unknown): string {
  let raw: string;
  try {
    if (err instanceof Error) {
      raw = typeof err.message === 'string' ? err.message : '';
    } else {
      raw = String(err);
    }
  } catch {
    raw = '';
  }
  return raw.trim().length === 0 ? 'unknown error' : raw.slice(0, 2048);
}
