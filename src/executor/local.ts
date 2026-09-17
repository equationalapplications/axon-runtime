import type { DeployConfig } from '../config/deploy.js';
import type { JobRequest } from '../contract/schema.js';
import { HARNESS_VERSION, HarnessAdapter } from '../harness/adapter.js';
import type { Executor, RunResult, Workspace } from './types.js';
import { WorkspaceManager } from './workspace.js';

export class LocalExecutor implements Executor {
  readonly kind = 'local' as const;
  private readonly workspaces: WorkspaceManager;

  constructor(
    private readonly cfg: DeployConfig,
    private readonly deps: {
      fetchImpl?: typeof fetch;
      /** Called after each completed harness step with the running cost. */
      onStep?: (jobId: string, step: number, costUsd: number) => void;
    } = {},
  ) {
    this.workspaces = new WorkspaceManager(cfg.home);
  }

  async prepare(job: JobRequest): Promise<Workspace> {
    return await this.workspaces.create(job.job_id, job.repo, job.ref);
  }

  async run(ws: Workspace, job: JobRequest, signal: AbortSignal): Promise<RunResult> {
    // The per-job spend cap is enforced here rather than in the adapter: the
    // adapter reports cost per step, and this controller aborts the loop by
    // abusing nothing more exotic than the same AbortSignal the pool uses.
    const budgetAbort = new AbortController();
    const forward = () => budgetAbort.abort();
    signal.addEventListener('abort', forward, { once: true });

    let breachedCap = false;
    const adapter = new HarnessAdapter({
      endpoint: this.cfg.endpoint,
      fetchImpl: this.deps.fetchImpl,
      onStep: (step, costUsd) => {
        this.deps.onStep?.(job.job_id, step, costUsd);
        if (costUsd > job.constraints.max_spend_usd) {
          breachedCap = true;
          budgetAbort.abort();
        }
      },
    });

    try {
      const outcome = await adapter.run(ws, job, budgetAbort.signal);
      const patch = job.output === 'patch' ? await this.workspaces.diff(ws) : null;
      return {
        output: job.output,
        patch,
        summary: outcome.summary,
        exitReason: breachedCap ? 'budget_exceeded' : outcome.exitReason,
        harnessSteps: outcome.steps,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        costUsd: outcome.costUsd,
        modelId: outcome.modelId,
        endpointBaseUrl: this.cfg.endpoint.baseUrl,
        harnessVersion: HARNESS_VERSION,
      };
    } finally {
      signal.removeEventListener('abort', forward);
    }
  }

  async teardown(ws: Workspace): Promise<void> {
    await this.workspaces.remove(ws);
  }
}
