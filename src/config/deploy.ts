import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConstraintsSchema, type Constraints } from '../contract/schema.js';

const FileSchema = z
  .object({
    node_id: z.string().min(1),
    home: z.string().min(1),
    bearer_token_env: z.string().min(1),
    max_concurrent_jobs: z.number().int().positive(),
    repo_allowlist: z.array(z.string().min(1)).min(1),
    ceilings: ConstraintsSchema,
    node_daily_spend_usd: z.number().positive(),
    max_goal_bytes: z.number().int().positive().default(32_768),
    max_context_bytes: z.number().int().positive().default(1_048_576),
    max_inline_patch_bytes: z.number().int().positive().default(1_048_576),
    artifact_ttl_days: z.number().int().positive().default(7),
    endpoint: z
      .object({
        base_url: z.string().url(),
        model: z.string().min(1),
        api_key_env: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export interface DeployConfig {
  nodeId: string;
  home: string;
  bearerToken: string;
  maxConcurrentJobs: number;
  repoAllowlist: string[];
  ceilings: Constraints;
  nodeDailySpendUsd: number;
  maxGoalBytes: number;
  maxContextBytes: number;
  maxInlinePatchBytes: number;
  artifactTtlDays: number;
  endpoint: { baseUrl: string; model: string; apiKey: string };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  if (!(name in env)) throw new Error(`deploy config names ${name}, but it is absent from the environment`);
  const value = env[name];
  if (value === '') throw new Error(`deploy config names ${name}, but its environment value is an empty string`);
  return value as string;
}

export function loadDeployConfig(path: string, env: NodeJS.ProcessEnv): DeployConfig {
  const parsed = FileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return {
    nodeId: parsed.node_id,
    home: parsed.home,
    bearerToken: requireEnv(env, parsed.bearer_token_env),
    maxConcurrentJobs: parsed.max_concurrent_jobs,
    repoAllowlist: parsed.repo_allowlist,
    ceilings: parsed.ceilings,
    nodeDailySpendUsd: parsed.node_daily_spend_usd,
    maxGoalBytes: parsed.max_goal_bytes,
    maxContextBytes: parsed.max_context_bytes,
    maxInlinePatchBytes: parsed.max_inline_patch_bytes,
    artifactTtlDays: parsed.artifact_ttl_days,
    endpoint: {
      baseUrl: parsed.endpoint.base_url,
      model: parsed.endpoint.model,
      apiKey: requireEnv(env, parsed.endpoint.api_key_env),
    },
  };
}
