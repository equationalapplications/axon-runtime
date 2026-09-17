import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../../src/controller/ledger.js';
import { CONTRACT_VERSION, type Envelope, type JobRequest } from '../../src/contract/schema.js';

const A = '3f1a6b8e-0000-4000-8000-0000000000f1';
const B = '3f1a6b8e-0000-4000-8000-0000000000f2';

function job(id: string): JobRequest {
  return {
    contract_version: CONTRACT_VERSION, job_id: id, repo: 'repo', ref: 'main', goal: 'g', context: [],
    constraints: { max_harness_steps: 5, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'patch',
  };
}

function envelope(id: string, over: Partial<Envelope> = {}): Envelope {
  return {
    contract_version: CONTRACT_VERSION, job_id: id, node_id: 'n1', status: 'ok', reason: null, error_detail: null,
    result: { output: 'patch', patch: 'diff', patch_artifact: null, summary: 's' },
    telemetry: {
      started_at: '2026-09-02T10:00:00.000Z', ended_at: '2026-09-02T10:00:10.000Z',
      duration_ms: 10_000, harness_steps: 4, tokens_in: 100, tokens_out: 200,
      cost_estimate_usd: 0.5, exit_reason: 'completed', node_id: 'n1', executor: 'fake',
      model_id: 'm', endpoint_base_url: 'https://x/v1', runtime_version: '0.1.0', harness_version: 'fake',
    },
    ...over,
  } as Envelope;
}

let ledger: Ledger;

beforeEach(() => {
  ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'axon-led-')), 'ledger.db'));
});

describe('Ledger', () => {
  it('remembers which node owns a job id', () => {
    ledger.recordDispatch(job(A), 'n1');
    expect(ledger.nodeFor(A)).toBe('n1');
  });

  it('returns undefined for an unknown job id', () => {
    expect(ledger.nodeFor(B)).toBeUndefined();
  });

  it('records an envelope and counts it in the node metrics', () => {
    ledger.recordDispatch(job(A), 'n1');
    ledger.recordEnvelope(envelope(A), 'n1');
    const m = ledger.metricsFor('n1');
    expect(m).toMatchObject({ node_id: 'n1', jobs: 1, ok: 1, error: 0, rejected: 0 });
    expect(m.total_cost_usd).toBeCloseTo(0.5);
  });

  it('computes success rate controller-side across mixed outcomes', () => {
    ledger.recordDispatch(job(A), 'n1');
    ledger.recordDispatch(job(B), 'n1');
    ledger.recordEnvelope(envelope(A), 'n1');
    ledger.recordEnvelope(
      envelope(B, {
        status: 'error',
        result: null,
        telemetry: { ...envelope(B).telemetry!, exit_reason: 'harness_error' },
      }),
      'n1',
    );
    expect(ledger.metricsFor('n1').success_rate).toBeCloseTo(0.5);
  });

  it('counts a rejected envelope without telemetry', () => {
    ledger.recordDispatch(job(A), 'n1');
    ledger.recordEnvelope(
      envelope(A, { status: 'rejected', reason: 'queue_full', result: null, telemetry: null }),
      'n1',
    );
    const m = ledger.metricsFor('n1');
    expect(m).toMatchObject({ rejected: 1, ok: 0 });
    expect(m.total_cost_usd).toBe(0);
  });

  it('preserves error_detail on a harness_error envelope end-to-end', () => {
    ledger.recordDispatch(job(A), 'n1');
    ledger.recordEnvelope(
      envelope(A, {
        status: 'error',
        result: null,
        error_detail: 'git clone failed: repository not found',
        telemetry: { ...envelope(A).telemetry!, exit_reason: 'harness_error' },
      }),
      'n1',
    );
    expect(ledger.metricsFor('n1')).toMatchObject({ error: 1, ok: 0 });
    const row = ledger['db']
      .prepare("SELECT envelope FROM jobs WHERE job_id = ?")
      .get(A) as { envelope: string };
    const parsed = JSON.parse(row.envelope) as Envelope;
    expect(parsed.error_detail).toBe('git clone failed: repository not found');
  });

  it('is idempotent on a re-recorded envelope', () => {
    ledger.recordDispatch(job(A), 'n1');
    ledger.recordEnvelope(envelope(A), 'n1');
    ledger.recordEnvelope(envelope(A), 'n1');
    expect(ledger.metricsFor('n1').jobs).toBe(1);
  });

  it('reports zeroed metrics for a node with no jobs', () => {
    expect(ledger.metricsFor('n2')).toMatchObject({ jobs: 0, success_rate: 0 });
  });
});
