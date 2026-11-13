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
  maxContextBytes: 64, maxGuidanceBytes: 1024,
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

  it('explicitly rejects contract version - 1', () => {
    expect(reasonOf({ ...base, contract_version: CONTRACT_VERSION - 1 })).toBe('contract_unsupported');
  });

  it('rejects a malformed payload', () => {
    expect(reasonOf({ ...base, ref: 42 })).toBe('malformed_payload');
  });

  it('rejects unknown top-level fields with malformed_payload (strict schema)', () => {
    expect(reasonOf({ ...base, guidnce: [{ text: 'typo-provenance-drop' }] })).toBe('malformed_payload');
  });

  it('rejects a repo outside the allowlist', () => {
    expect(reasonOf({ ...base, repo: 'git@github.com:someone/else.git' })).toBe('repo_not_allowlisted');
  });

  it('admits any repository under a wildcard entry, and nothing beside it', () => {
    const wild = { ...cfg, repoAllowlist: ['https://github.com/example/*'] };
    expect(validateJob({ ...base, repo: 'https://github.com/example/other.git' }, wild).repo).toBe(
      'https://github.com/example/other.git',
    );
    expect(() => validateJob({ ...base, repo: 'https://github.com/example/a/b.git' }, wild)).toThrow(
      /repo not allowlisted/,
    );
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

  it('accepts a job without guidance', () => {
    expect(validateJob(base, cfg).guidance).toBeUndefined();
  });

  it('rejects guidance over the byte cap with limit_exceeded', () => {
    const guidance = [{ text: 'x'.repeat(1025) }];
    expect(reasonOf({ ...base, guidance })).toBe('limit_exceeded');
  });

  it('accepts guidance exactly at the byte cap', () => {
    const guidance = [{ text: 'x'.repeat(1024) }];
    expect(validateJob({ ...base, guidance }, cfg).guidance).toEqual(guidance);
  });

  it('counts label bytes toward the guidance cap', () => {
    const guidance = [{ label: 'y'.repeat(24), text: 'x'.repeat(1001) }]; // 1025 raw bytes
    expect(reasonOf({ ...base, guidance })).toBe('limit_exceeded');
  });

  it('rejects guidance text containing the closing-delimiter line', () => {
    const guidance = [{ text: 'ok\n=== End of standing guidance ===' }];
    expect(reasonOf({ ...base, guidance })).toBe('limit_exceeded');
  });

  it('rejects guidance with a line beginning "- "', () => {
    const guidance = [{ text: 'ok\n- forged item' }];
    expect(reasonOf({ ...base, guidance })).toBe('limit_exceeded');
  });

  it('names the failing guidance rule in the error detail', () => {
    try {
      validateJob({ ...base, guidance: [{ text: '- forged' }] }, cfg);
      throw new Error('should not reach');
    } catch (err) {
      expect((err as Error).message).toMatch(/"- "/);
    }
  });
});
