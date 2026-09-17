import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, EnvelopeSchema, JobRequestSchema } from '../../src/contract/schema.js';

const validJob = {
  contract_version: CONTRACT_VERSION,
  job_id: '3f1a6b8e-0000-4000-8000-000000000001',
  repo: 'git@github.com:example/project.git',
  ref: 'main',
  goal: 'Add a README section.',
  constraints: { max_harness_steps: 40, timeout_seconds: 1800, max_spend_usd: 2 },
  output: 'patch',
};

describe('JobRequestSchema', () => {
  it('accepts a minimal valid job', () => {
    expect(JobRequestSchema.parse(validJob).job_id).toBe(validJob.job_id);
  });

  it('defaults context to an empty array', () => {
    expect(JobRequestSchema.parse(validJob).context).toEqual([]);
  });

  it('rejects a non-uuid job_id', () => {
    expect(() => JobRequestSchema.parse({ ...validJob, job_id: 'nope' })).toThrow();
  });

  it('rejects an unknown output mode', () => {
    expect(() => JobRequestSchema.parse({ ...validJob, output: 'branch' })).toThrow();
  });

  it('rejects a non-positive spend cap', () => {
    const constraints = { ...validJob.constraints, max_spend_usd: 0 };
    expect(() => JobRequestSchema.parse({ ...validJob, constraints })).toThrow();
  });
});

describe('EnvelopeSchema', () => {
  it('accepts a rejected envelope with no telemetry', () => {
    const env = {
      contract_version: CONTRACT_VERSION,
      job_id: validJob.job_id,
      node_id: 'node-01',
      status: 'rejected',
      reason: 'queue_full',
      error_detail: null,
      result: null,
      telemetry: null,
    };
    expect(EnvelopeSchema.parse(env).status).toBe('rejected');
  });

  it('rejects an ok envelope without telemetry', () => {
    const env = {
      contract_version: CONTRACT_VERSION,
      job_id: validJob.job_id,
      node_id: 'node-01',
      status: 'ok',
      reason: null,
      error_detail: null,
      result: { output: 'patch', patch: 'diff', patch_artifact: null, summary: 'done' },
      telemetry: null,
    };
    expect(() => EnvelopeSchema.parse(env)).toThrow();
  });

  it('accepts an interrupted envelope with telemetry null (crash before any checkpoint)', () => {
    const env = {
      contract_version: CONTRACT_VERSION,
      job_id: validJob.job_id,
      node_id: 'node-01',
      status: 'interrupted',
      reason: null,
      error_detail: null,
      result: null,
      telemetry: null,
    };
    expect(EnvelopeSchema.parse(env).status).toBe('interrupted');
  });

  it('still accepts an interrupted envelope that retained telemetry', () => {
    const env = {
      contract_version: CONTRACT_VERSION,
      job_id: validJob.job_id,
      node_id: 'node-01',
      status: 'interrupted',
      reason: null,
      error_detail: null,
      result: null,
      telemetry: {
        started_at: '2026-09-02T00:00:00.000Z',
        ended_at: '2026-09-02T00:01:00.000Z',
        duration_ms: 60_000,
        harness_steps: 2,
        tokens_in: 10,
        tokens_out: 5,
        cost_estimate_usd: 0.001,
        exit_reason: 'interrupted',
        node_id: 'node-01',
        executor: 'local',
        model_id: 'm',
        endpoint_base_url: 'https://x/v1',
        runtime_version: '0.1.0',
        harness_version: 'deepseek-harness-0.1.0',
      },
    };
    expect(EnvelopeSchema.parse(env).status).toBe('interrupted');
  });

  it('requires error_detail when telemetry.exit_reason is harness_error', () => {
    const env = {
      contract_version: CONTRACT_VERSION,
      job_id: validJob.job_id,
      node_id: 'node-01',
      status: 'error',
      reason: null,
      result: null,
      error_detail: null,
      telemetry: {
        started_at: '2026-09-02T00:00:00.000Z',
        ended_at: '2026-09-02T00:00:01.000Z',
        duration_ms: 1_000,
        harness_steps: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_estimate_usd: 0,
        exit_reason: 'harness_error',
        node_id: 'node-01',
        executor: 'local',
        model_id: 'm',
        endpoint_base_url: 'https://x/v1',
        runtime_version: '0.1.0',
        harness_version: 'unknown',
      },
    };
    expect(() => EnvelopeSchema.parse(env)).toThrow(/error_detail/);
  });

  it('requires error_detail to be null when exit_reason is anything else', () => {
    const env = {
      contract_version: CONTRACT_VERSION,
      job_id: validJob.job_id,
      node_id: 'node-01',
      status: 'error',
      reason: null,
      result: null,
      error_detail: 'should have been null',
      telemetry: {
        started_at: '2026-09-02T00:00:00.000Z',
        ended_at: '2026-09-02T00:00:01.000Z',
        duration_ms: 1_000,
        harness_steps: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_estimate_usd: 0,
        exit_reason: 'step_cap',
        node_id: 'node-01',
        executor: 'local',
        model_id: 'm',
        endpoint_base_url: 'https://x/v1',
        runtime_version: '0.1.0',
        harness_version: 'unknown',
      },
    };
    expect(() => EnvelopeSchema.parse(env)).toThrow(/error_detail/);
  });

  it('accepts an error envelope with error_detail set when exit_reason is harness_error', () => {
    const env = {
      contract_version: CONTRACT_VERSION,
      job_id: validJob.job_id,
      node_id: 'node-01',
      status: 'error',
      reason: null,
      result: null,
      error_detail: 'worktree clone failed: repository not found',
      telemetry: {
        started_at: '2026-09-02T00:00:00.000Z',
        ended_at: '2026-09-02T00:00:01.000Z',
        duration_ms: 1_000,
        harness_steps: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_estimate_usd: 0,
        exit_reason: 'harness_error',
        node_id: 'node-01',
        executor: 'local',
        model_id: 'm',
        endpoint_base_url: 'https://x/v1',
        runtime_version: '0.1.0',
        harness_version: 'unknown',
      },
    };
    const parsed = EnvelopeSchema.parse(env);
    expect(parsed.error_detail).toBe('worktree clone failed: repository not found');
  });
});
