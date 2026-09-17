import { describe, expect, it } from 'vitest';
import { validateJob } from '../../src/service/validate.js';
import { RejectError } from '../../src/contract/errors.js';
import { CONTRACT_VERSION } from '../../src/contract/schema.js';
import type { DeployConfig } from '../../src/config/deploy.js';

const cfg: DeployConfig = {
  nodeId: 'n1',
  home: '/home/axon',
  bearerToken: 'tok',
  maxConcurrentJobs: 2,
  repoAllowlist: ['git@github.com:example/project.git'],
  ceilings: { max_harness_steps: 40, timeout_seconds: 1800, max_spend_usd: 2 },
  nodeDailySpendUsd: 20,
  maxGoalBytes: 32,
  maxContextBytes: 64,
  maxInlinePatchBytes: 1024,
  artifactTtlDays: 7,
  endpoint: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'test-key' },
};

const base = {
  contract_version: CONTRACT_VERSION,
  job_id: '3f1a6b8e-0000-4000-8000-00000000000d',
  repo: 'git@github.com:example/project.git',
  ref: 'main',
  goal: 'short goal',
  constraints: { max_harness_steps: 10, timeout_seconds: 60, max_spend_usd: 1 },
  output: 'patch',
};

function reasonOf(body: unknown): string {
  try {
    validateJob(body, cfg);
    return 'no-throw';
  } catch (err) {
    return err instanceof RejectError ? err.reason : 'wrong-error';
  }
}

describe('validateJob', () => {
  it('accepts a valid job', () => {
    expect(validateJob(base, cfg).job_id).toBe(base.job_id);
  });

  it('rejects an unknown contract version', () => {
    expect(reasonOf({ ...base, contract_version: CONTRACT_VERSION + 1 })).toBe('contract_unsupported');
  });

  it('rejects a malformed payload', () => {
    expect(reasonOf({ ...base, ref: 42 })).toBe('malformed_payload');
  });

  it('rejects a repo outside the allowlist', () => {
    expect(reasonOf({ ...base, repo: 'git@github.com:someone/else.git' })).toBe('repo_not_allowlisted');
  });

  it('rejects an oversized goal', () => {
    expect(reasonOf({ ...base, goal: 'x'.repeat(33) })).toBe('limit_exceeded');
  });

  it('rejects oversized context', () => {
    const context = [{ path: 'a.md', content: 'x'.repeat(65) }];
    expect(reasonOf({ ...base, context })).toBe('limit_exceeded');
  });

  it('checks the contract version before the payload shape', () => {
    expect(reasonOf({ ...base, contract_version: CONTRACT_VERSION + 1, ref: 42 })).toBe('contract_unsupported');
  });

  it('clamps constraints down to the node ceilings', () => {
    const constraints = { max_harness_steps: 999, timeout_seconds: 99_999, max_spend_usd: 99 };
    expect(validateJob({ ...base, constraints }, cfg).constraints).toEqual(cfg.ceilings);
  });

  it('leaves constraints below the ceilings untouched', () => {
    expect(validateJob(base, cfg).constraints).toEqual(base.constraints);
  });
});
