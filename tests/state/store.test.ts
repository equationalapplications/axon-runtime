import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../../src/state/store.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';

function job(id: string): JobRequest {
  return {
    contract_version: CONTRACT_VERSION,
    job_id: id,
    repo: 'git@github.com:example/project.git',
    ref: 'main',
    goal: 'do the thing',
    context: [],
    constraints: { max_harness_steps: 10, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'patch',
  };
}

const A = '3f1a6b8e-0000-4000-8000-00000000000a';
const B = '3f1a6b8e-0000-4000-8000-00000000000b';

let store: JobStore;
let dbPath: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'axon-db-')), 'jobs.db');
  store = new JobStore(dbPath);
});

describe('JobStore', () => {
  it('creates a job in the running state', () => {
    expect(store.create(job(A)).status).toBe('running');
  });

  it('returns the existing record when the same job_id is created twice', () => {
    store.create(job(A));
    store.checkpoint(A, { harnessSteps: 3 });
    expect(store.create(job(A)).harnessSteps).toBe(3);
  });

  it('counts only running jobs as active', () => {
    store.create(job(A));
    store.create(job(B));
    store.finish(A, 'ok', null, null);
    expect(store.activeCount()).toBe(1);
  });

  it('moves running jobs to interrupted on recovery, keeping checkpointed telemetry', () => {
    store.create(job(A));
    store.checkpoint(A, { harnessSteps: 5, costUsd: 0.25 });
    store.close();

    const reopened = new JobStore(dbPath);
    expect(reopened.recoverInterrupted()).toEqual([A]);
    const rec = reopened.get(A)!;
    expect(rec.status).toBe('interrupted');
    expect(rec.harnessSteps).toBe(5);
    expect(rec.costUsd).toBe(0.25);
  });

  it('sums spend across jobs since a timestamp', () => {
    store.create(job(A));
    store.create(job(B));
    store.addSpend(A, 1.5);
    store.addSpend(B, 2.25);
    expect(store.spendSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(3.75);
  });

  it('excludes spend recorded before the window', () => {
    store.create(job(A));
    store.addSpend(A, 1.5);
    expect(store.spendSince('2999-01-01T00:00:00.000Z')).toBe(0);
  });

  it('migrates an older v1 schema by adding error_detail so finish() does not crash', () => {
    // Recreate the v1 schema (no error_detail column) and insert a running job,
    // then reopen with JobStore: the upgrade path must add the column so
    // finish() can persist error_detail without `no such column`. Use a fresh
    // dbPath — the shared `beforeEach` has already created the v2 schema.
    const legacyDbPath = join(mkdtempSync(join(tmpdir(), 'axon-legacy-')), 'jobs.db');
    const raw = new Database(legacyDbPath);
    raw.exec(`
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request TEXT NOT NULL,
        harness_steps INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        result TEXT,
        telemetry TEXT
      );
    `);
    raw.prepare(
      'INSERT INTO jobs (job_id, status, request, started_at) VALUES (?, ?, ?, ?)',
    ).run(A, 'running', JSON.stringify(job(A)), new Date().toISOString());
    raw.close();

    const reopened = new JobStore(legacyDbPath);
    expect(() => reopened.finish(A, 'error', null, null, 'boom')).not.toThrow();
    expect(reopened.get(A)!.errorDetail).toBe('boom');
  });

  it('backfills error_detail for v1 harness_error rows so the v2 envelope refines', () => {
    // A row already finished in v1 (harness_error, telemetry present, no
    // error_detail) must come out of upgrade with error_detail populated,
    // otherwise EnvelopeSchema.parse refuses the envelope and dispatch --wait
    // never returns.
    const legacyDbPath = join(mkdtempSync(join(tmpdir(), 'axon-legacy-')), 'jobs.db');
    const raw = new Database(legacyDbPath);
    raw.exec(`
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request TEXT NOT NULL,
        harness_steps INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        result TEXT,
        telemetry TEXT
      );
    `);
    raw.prepare(
      'INSERT INTO jobs (job_id, status, request, started_at, ended_at, telemetry) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      A,
      'error',
      JSON.stringify(job(A)),
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify({ exit_reason: 'harness_error' }),
    );
    raw.close();

    const reopened = new JobStore(legacyDbPath);
    expect(reopened.get(A)!.errorDetail).toBe('unknown error');
  });
});
