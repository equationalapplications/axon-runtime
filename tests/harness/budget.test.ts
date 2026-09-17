import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BudgetGuard, startOfDayIso } from '../../src/harness/budget.js';
import { JobStore } from '../../src/state/store.js';
import { RejectError } from '../../src/contract/errors.js';
import type { DeployConfig } from '../../src/config/deploy.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';

const cfg = { nodeDailySpendUsd: 5 } as DeployConfig;
const A = '3f1a6b8e-0000-4000-8000-00000000000e';

function job(id: string): JobRequest {
  return {
    contract_version: CONTRACT_VERSION, job_id: id,
    repo: 'r', ref: 'main', goal: 'g', context: [],
    constraints: { max_harness_steps: 10, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'report',
  };
}

let store: JobStore;
let guard: BudgetGuard;

beforeEach(() => {
  store = new JobStore(join(mkdtempSync(join(tmpdir(), 'axon-bud-')), 'jobs.db'));
  guard = new BudgetGuard(store, cfg);
  store.create(job(A));
});

describe('BudgetGuard', () => {
  it('admits a job when the daily cap has room', () => {
    expect(() => guard.admit()).not.toThrow();
  });

  it('refuses admission once the daily cap is spent', () => {
    guard.record(A, 5);
    expect(() => guard.admit()).toThrow(RejectError);
  });

  it('refuses with reason budget_exhausted', () => {
    guard.record(A, 6);
    try {
      guard.admit();
      throw new Error('expected a rejection');
    } catch (err) {
      expect((err as RejectError).reason).toBe('budget_exhausted');
    }
  });

  it('admits both of two concurrent callers only while room remains', () => {
    guard.record(A, 4.5);
    expect(() => guard.admit()).not.toThrow();
    guard.record(A, 0.6);
    expect(() => guard.admit()).toThrow(RejectError);
  });

  it('tracks per-job spend separately from the node total', () => {
    guard.record(A, 0.75);
    expect(guard.jobSpend(A)).toBeCloseTo(0.75);
  });

  it('rejects a negative spend amount', () => {
    expect(() => guard.record(A, -1)).toThrow(/negative/);
    expect(guard.jobSpend(A)).toBe(0);
    expect(store.spendSince(startOfDayIso())).toBe(0);
  });
});
