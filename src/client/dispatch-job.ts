import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRACT_VERSION, type GuidanceItem, type JobRequest } from '../contract/schema.js';

/**
 * Pure job builder for `axon dispatch`, extracted so the guidance wiring
 * (present-and-items vs absent-key, never []) is testable without importing
 * cli.ts (which runs commander's parse at import time).
 */
export function buildDispatchJob(input: {
  repo: string;
  ref: string;
  goalFile: string;
  output: 'patch' | 'report';
  maxSteps: string;
  timeout: string;
  maxSpend: string;
  guidance?: GuidanceItem[];
}): JobRequest {
  return {
    contract_version: CONTRACT_VERSION,
    job_id: randomUUID(),
    repo: input.repo,
    ref: input.ref,
    goal: readFileSync(input.goalFile, 'utf8'),
    context: [],
    constraints: {
      max_harness_steps: Number(input.maxSteps),
      timeout_seconds: Number(input.timeout),
      max_spend_usd: Number(input.maxSpend),
    },
    output: input.output,
    ...(input.guidance?.length ? { guidance: input.guidance } : {}),
  };
}
