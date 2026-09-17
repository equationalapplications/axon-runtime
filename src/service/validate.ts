import type { DeployConfig } from '../config/deploy.js';
import { RejectError } from '../contract/errors.js';
import { CONTRACT_VERSION, JobRequestSchema, type JobRequest } from '../contract/schema.js';

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function validateJob(body: unknown, cfg: DeployConfig): JobRequest {
  const version = (body as { contract_version?: unknown } | null)?.contract_version;
  if (version !== CONTRACT_VERSION) {
    throw new RejectError('contract_unsupported', `unsupported contract_version: ${String(version)}`);
  }

  const parsed = JobRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new RejectError('malformed_payload', parsed.error.issues[0]?.message ?? 'invalid payload');
  }
  const job = parsed.data;

  if (!cfg.repoAllowlist.includes(job.repo)) {
    throw new RejectError('repo_not_allowlisted', `repo not allowlisted: ${job.repo}`);
  }

  if (byteLength(job.goal) > cfg.maxGoalBytes) {
    throw new RejectError('limit_exceeded', `goal exceeds ${cfg.maxGoalBytes} bytes`);
  }

  const contextBytes = job.context.reduce((n, f) => n + byteLength(f.content), 0);
  if (contextBytes > cfg.maxContextBytes) {
    throw new RejectError('limit_exceeded', `context exceeds ${cfg.maxContextBytes} bytes`);
  }

  return {
    ...job,
    constraints: {
      max_harness_steps: Math.min(job.constraints.max_harness_steps, cfg.ceilings.max_harness_steps),
      timeout_seconds: Math.min(job.constraints.timeout_seconds, cfg.ceilings.timeout_seconds),
      max_spend_usd: Math.min(job.constraints.max_spend_usd, cfg.ceilings.max_spend_usd),
    },
  };
}
