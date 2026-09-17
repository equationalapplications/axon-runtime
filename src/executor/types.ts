import type { ExitReason, JobRequest } from '../contract/schema.js';

export interface Workspace {
  jobId: string;
  /** Absolute path to the job's worktree, or null for executors that need no disk. */
  dir: string | null;
  repo?: string;
  ref?: string;
}

export interface RunResult {
  output: 'patch' | 'report';
  patch: string | null;
  summary: string;
  exitReason: ExitReason;
  harnessSteps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  modelId: string;
  endpointBaseUrl: string;
  harnessVersion: string;
}

export interface Executor {
  readonly kind: 'fake' | 'local';
  prepare(job: JobRequest): Promise<Workspace>;
  run(ws: Workspace, job: JobRequest, signal: AbortSignal): Promise<RunResult>;
  teardown(ws: Workspace): Promise<void>;
}
