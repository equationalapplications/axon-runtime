import type { JobRequest } from '../contract/schema.js';
import type { Executor, RunResult, Workspace } from './types.js';

const FAKE_PATCH = `diff --git a/AXON_ECHO.md b/AXON_ECHO.md
new file mode 100644
--- /dev/null
+++ b/AXON_ECHO.md
@@ -0,0 +1 @@
+echo
`;

export class FakeExecutor implements Executor {
  readonly kind = 'fake' as const;

  async prepare(job: JobRequest): Promise<Workspace> {
    return { jobId: job.job_id, dir: null };
  }

  async run(_ws: Workspace, job: JobRequest, signal: AbortSignal): Promise<RunResult> {
    return {
      output: job.output,
      patch: job.output === 'patch' ? FAKE_PATCH : null,
      summary: `fake executor echo: ${job.goal}`,
      exitReason: signal.aborted ? 'cancelled' : 'completed',
      harnessSteps: 1,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      modelId: 'fake',
      endpointBaseUrl: 'fake://local',
      harnessVersion: 'fake',
    };
  }

  async teardown(_ws: Workspace): Promise<void> {}
}
