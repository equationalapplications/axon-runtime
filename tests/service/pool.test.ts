import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobPool, errorDetailFor } from '../../src/service/pool.js';
import { JobStore } from '../../src/state/store.js';
import { BudgetGuard } from '../../src/harness/budget.js';
import { FakeExecutor } from '../../src/executor/fake.js';
import { ArtifactStore } from '../../src/service/artifacts.js';
import type { DeployConfig } from '../../src/config/deploy.js';
import type { Executor, RunResult, Workspace } from '../../src/executor/types.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';

const cfg: DeployConfig = {
  nodeId: 'n1', home: '/home/axon', bearerToken: 'tok',
  maxConcurrentJobs: 1,
  repoAllowlist: ['repo'],
  ceilings: { max_harness_steps: 40, timeout_seconds: 1800, max_spend_usd: 2 },
  nodeDailySpendUsd: 20,
  maxGoalBytes: 1024, maxContextBytes: 1024, maxInlinePatchBytes: 1024, artifactTtlDays: 7,
  endpoint: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
};

function body(id: string, over: Partial<JobRequest> = {}): unknown {
  return {
    contract_version: CONTRACT_VERSION, job_id: id, repo: 'repo', ref: 'main', goal: 'g',
    constraints: { max_harness_steps: 5, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'report', ...over,
  };
}

const A = '3f1a6b8e-0000-4000-8000-0000000000a1';
const B = '3f1a6b8e-0000-4000-8000-0000000000a2';

/** An executor that blocks until released, so concurrency is observable. */
class BlockingExecutor implements Executor {
  readonly kind = 'fake' as const;
  private release!: () => void;
  readonly started: Promise<void>;
  private startedResolve!: () => void;
  private gate = new Promise<void>((r) => { this.release = r; });

  constructor() {
    this.started = new Promise<void>((r) => { this.startedResolve = r; });
  }

  async prepare(job: JobRequest): Promise<Workspace> { return { jobId: job.job_id, dir: null }; }

  async run(_ws: Workspace, job: JobRequest, signal: AbortSignal): Promise<RunResult> {
    this.startedResolve();
    await this.gate;
    return {
      output: job.output, patch: null, summary: 'blocked',
      exitReason: signal.aborted ? 'cancelled' : 'completed',
      harnessSteps: 1, tokensIn: 0, tokensOut: 0, costUsd: 0,
      modelId: 'fake', endpointBaseUrl: 'fake://local', harnessVersion: 'fake',
    };
  }

  async teardown(): Promise<void> {}
  finish(): void { this.release(); }
}

function makePool(executor: Executor, over: Partial<DeployConfig> = {}) {
  const store = new JobStore(join(mkdtempSync(join(tmpdir(), 'axon-pool-')), 'jobs.db'));
  const artifacts = new ArtifactStore(mkdtempSync(join(tmpdir(), 'axon-pool-art-')));
  const merged = { ...cfg, ...over };
  const budget = new BudgetGuard(store, merged);
  return {
    store,
    artifacts,
    pool: new JobPool({ cfg: merged, store, executor, budget, artifacts, runtimeVersion: '0.1.0' }),
  };
}

let harness: ReturnType<typeof makePool>;

beforeEach(() => { harness = makePool(new FakeExecutor()); });

describe('JobPool admission', () => {
  it('accepts a valid job', () => {
    expect(harness.pool.submit(body(A)).status).toBe('accepted');
  });

  it('rejects an invalid job with its reason', () => {
    const res = harness.pool.submit(body(A, { repo: 'other' } as Partial<JobRequest>));
    expect(res).toMatchObject({ status: 'rejected', reason: 'repo_not_allowlisted' });
  });

  it('stores a rejected envelope with null telemetry', async () => {
    harness.pool.submit(body(A, { repo: 'other' } as Partial<JobRequest>));
    const env = harness.pool.envelope(A)!;
    expect(env.status).toBe('rejected');
    expect(env.telemetry).toBeNull();
    expect(env.reason).toBe('repo_not_allowlisted');
  });

  it('rejects with queue_full when the node is at max_concurrent_jobs', async () => {
    const blocking = new BlockingExecutor();
    const h = makePool(blocking, { maxConcurrentJobs: 1 });
    h.pool.submit(body(A));
    await blocking.started;
    expect(h.pool.submit(body(B))).toMatchObject({ status: 'rejected', reason: 'queue_full' });
    blocking.finish();
    await h.pool.drain();
  });

  it('admits a second job when max_concurrent_jobs is 2', async () => {
    const blocking = new BlockingExecutor();
    const h = makePool(blocking, { maxConcurrentJobs: 2 });
    h.pool.submit(body(A));
    await blocking.started;
    expect(h.pool.submit(body(B)).status).toBe('accepted');
    blocking.finish();
    await h.pool.drain();
  });

  it('refuses admission when the node daily cap is spent', () => {
    const h = makePool(new FakeExecutor(), { nodeDailySpendUsd: 1 });
    h.store.create({ ...(body(B) as JobRequest), context: [] });
    h.store.addSpend(B, 1);
    expect(h.pool.submit(body(A))).toMatchObject({ status: 'rejected', reason: 'budget_exhausted' });
  });
});

describe('JobPool lifecycle', () => {
  it('produces an ok envelope with telemetry once the job completes', async () => {
    harness.pool.submit(body(A));
    await harness.pool.drain();
    const env = harness.pool.envelope(A)!;
    expect(env.status).toBe('ok');
    expect(env.error_detail).toBeNull();
    expect(env.telemetry!.exit_reason).toBe('completed');
    expect(env.telemetry!.node_id).toBe('n1');
    expect(env.telemetry!.executor).toBe('fake');
  });

  it('is idempotent: resubmitting a known job_id does not start a second run', async () => {
    harness.pool.submit(body(A));
    await harness.pool.drain();
    expect(harness.pool.submit(body(A)).status).toBe('accepted');
    expect(harness.pool.envelope(A)!.status).toBe('ok');
  });

  it('cancels a running job, ending it as cancelled', async () => {
    const blocking = new BlockingExecutor();
    const h = makePool(blocking);
    h.pool.submit(body(A));
    await blocking.started;
    expect(h.pool.cancel(A)).toBe(true);
    blocking.finish();
    await h.pool.drain();
    expect(h.pool.envelope(A)!.telemetry!.exit_reason).toBe('cancelled');
  });

  it('reports cancel of an unknown job as false', () => {
    expect(harness.pool.cancel(B)).toBe(false);
  });

  it('ends a job as error with exit_reason harness_error when the executor throws', async () => {
    const throwing: Executor = {
      kind: 'fake',
      async prepare(job) { return { jobId: job.job_id, dir: null }; },
      async run() { throw new Error('boom'); },
      async teardown() {},
    };
    const h = makePool(throwing);
    h.pool.submit(body(A));
    await h.pool.drain();
    const env = h.pool.envelope(A)!;
    expect(env.status).toBe('error');
    expect(env.error_detail).toBe('boom');
    expect(env.telemetry!.exit_reason).toBe('harness_error');
  });

  it('captures error_detail from a non-Error throwable as a string fallback', async () => {
    const throwing: Executor = {
      kind: 'fake',
      async prepare(job) { return { jobId: job.job_id, dir: null }; },
      async run() { throw 'plain string thrown'; },
      async teardown() {},
    };
    const h = makePool(throwing);
    h.pool.submit(body(A));
    await h.pool.drain();
    expect(h.pool.envelope(A)!.error_detail).toBe('plain string thrown');
  });

  it('records prepare() failures without throwing when the throwable cannot coerce', async () => {
    // Object.create(null) has no prototype, so String() throws. The formatter
    // must still produce a placeholder so the job lands in a terminal state
    // instead of stranding the slot.
    const objectWithoutProto = Object.create(null) as unknown;
    expect(() => errorDetailFor(objectWithoutProto)).not.toThrow();
    expect(errorDetailFor(objectWithoutProto)).toBe('unknown error');

    // An Error subclass whose `message` getter throws must also be tolerated —
    // the formatter accesses `.message` only through `typeof === 'string'`.
    class ThrowingMessage extends Error {
      get message(): string { throw new Error('boom'); }
    }
    const throwingMessage = new ThrowingMessage();
    expect(() => errorDetailFor(throwingMessage)).not.toThrow();
    expect(errorDetailFor(throwingMessage)).toBe('unknown error');

    const throwing: Executor = {
      kind: 'fake',
      async prepare() { throw objectWithoutProto; },
      async run() { throw new Error('unreachable'); },
      async teardown() {},
    };
    const h = makePool(throwing);
    h.pool.submit(body(A));
    await h.pool.drain();
    const env = h.pool.envelope(A)!;
    expect(env.status).toBe('error');
    expect(env.error_detail).toBe('unknown error');
    expect(env.telemetry!.exit_reason).toBe('harness_error');
  });

  it('tears down the workspace even when the run throws', async () => {
    let tornDown = false;
    const throwing: Executor = {
      kind: 'fake',
      async prepare(job) { return { jobId: job.job_id, dir: null }; },
      async run() { throw new Error('boom'); },
      async teardown() { tornDown = true; },
    };
    const h = makePool(throwing);
    h.pool.submit(body(A));
    await h.pool.drain();
    expect(tornDown).toBe(true);
  });
});

describe('JobPool patch spill', () => {
  it('spills a patch larger than max_inline_patch_bytes to an artifact', async () => {
    const big = 'diff --git a/x b/x\n' + 'y'.repeat(2000);
    const bigExecutor: Executor = {
      kind: 'fake',
      async prepare(job) { return { jobId: job.job_id, dir: null }; },
      async run(_ws, job) {
        return {
          output: 'patch', patch: big, summary: 's', exitReason: 'completed',
          harnessSteps: 1, tokensIn: 0, tokensOut: 0, costUsd: 0,
          modelId: 'fake', endpointBaseUrl: 'fake://local', harnessVersion: 'fake',
        };
      },
      async teardown() {},
    };
    const h = makePool(bigExecutor, { maxInlinePatchBytes: 1024 });
    h.pool.submit(body(A, { output: 'patch' }));
    await h.pool.drain();
    const env = h.pool.envelope(A)!;
    expect(env.result!.patch).toBeNull();
    expect(env.result!.patch_artifact).toBe('patch.diff');
  });

  it('keeps a small patch inline', async () => {
    const h = makePool(new FakeExecutor(), { maxInlinePatchBytes: 1024 });
    h.pool.submit(body(A, { output: 'patch' }));
    await h.pool.drain();
    expect(h.pool.envelope(A)!.result!.patch).toMatch(/^diff --git /);
    expect(h.pool.envelope(A)!.result!.patch_artifact).toBeNull();
  });

  it('round-trips the spilled artifact through the store', async () => {
    const big = 'diff --git a/x b/x\n' + 'z'.repeat(2000);
    const bigExecutor: Executor = {
      kind: 'fake',
      async prepare(job) { return { jobId: job.job_id, dir: null }; },
      async run(_ws, job) {
        return {
          output: 'patch', patch: big, summary: 's', exitReason: 'completed',
          harnessSteps: 1, tokensIn: 0, tokensOut: 0, costUsd: 0,
          modelId: 'fake', endpointBaseUrl: 'fake://local', harnessVersion: 'fake',
        };
      },
      async teardown() {},
    };
    const h = makePool(bigExecutor, { maxInlinePatchBytes: 1024 });
    h.pool.submit(body(A, { output: 'patch' }));
    await h.pool.drain();
    expect(h.artifacts.read(A, 'patch.diff')).toBe(big);
  });
});

describe('JobPool prepare failure', () => {
  it('lands the job in a terminal error state when prepare() throws', async () => {
    const failing: Executor = {
      kind: 'fake',
      async prepare() { throw new Error('worktree clone failed'); },
      async run() { throw new Error('unreachable: prepare failed'); },
      async teardown() {},
    };
    const h = makePool(failing);
    expect(h.pool.submit(body(A)).status).toBe('accepted');
    await h.pool.drain();
    const env = h.pool.envelope(A)!;
    expect(env.status).toBe('error');
    expect(env.error_detail).toBe('worktree clone failed');
    expect(env.telemetry!.exit_reason).toBe('harness_error');
  });

  it('releases the concurrency slot after a prepare() failure', async () => {
    const failing: Executor = {
      kind: 'fake',
      async prepare() { throw new Error('worktree clone failed'); },
      async run() { throw new Error('unreachable: prepare failed'); },
      async teardown() {},
    };
    const h = makePool(failing, { maxConcurrentJobs: 1 });
    h.pool.submit(body(A));
    await h.pool.drain();
    expect(h.pool.activeCount()).toBe(0);
  });
});

describe('JobPool timeout', () => {
  it('ends a job as timeout when it outruns its wall-clock cap', async () => {
    const slow: Executor = {
      kind: 'fake',
      async prepare(job) { return { jobId: job.job_id, dir: null }; },
      async run(_ws, job, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          output: job.output, patch: null, summary: 'slow', exitReason: 'completed',
          harnessSteps: 1, tokensIn: 0, tokensOut: 0, costUsd: 0,
          modelId: 'fake', endpointBaseUrl: 'fake://local', harnessVersion: 'fake',
        };
      },
      async teardown() {},
    };
    const h = makePool(slow);
    h.pool.submit(body(A, { constraints: { max_harness_steps: 5, timeout_seconds: 1, max_spend_usd: 1 } }));
    await h.pool.drain();
    const env = h.pool.envelope(A)!;
    expect(env.status).toBe('timeout');
    expect(env.error_detail).toBeNull();
    expect(env.telemetry!.exit_reason).toBe('timeout');
  }, 10_000);
});

describe('JobPool interrupted recovery (M1)', () => {
  it('serves an envelope for a record swept to interrupted with no telemetry', () => {
    const h = makePool(new FakeExecutor());
    h.store.create({ ...(body(A) as JobRequest), context: [] });
    h.store.checkpoint(A, { harnessSteps: 3 });
    h.store.finish(A, 'interrupted', null, null);
    const env = h.pool.envelope(A);
    expect(env).toBeDefined();
    expect(env!.status).toBe('interrupted');
    expect(env!.telemetry).toBeNull();
  });
});
