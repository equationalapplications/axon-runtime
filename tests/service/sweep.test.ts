import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { sweepOnStartup } from '../../src/service/sweep.js';
import { JobStore } from '../../src/state/store.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';

const A = '3f1a6b8e-0000-4000-8000-0000000000c1';
const B = '3f1a6b8e-0000-4000-8000-0000000000c2';

function job(id: string): JobRequest {
  return {
    contract_version: CONTRACT_VERSION, job_id: id, repo: 'repo', ref: 'main', goal: 'g', context: [],
    constraints: { max_harness_steps: 5, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'patch',
  };
}

function ageDir(path: string, days: number): void {
  const t = new Date(Date.now() - days * 86_400_000);
  utimesSync(path, t, t);
}

let home: string;
let store: JobStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'axon-sweep-'));
  mkdirSync(join(home, 'workspaces'), { recursive: true });
  mkdirSync(join(home, 'artifacts'), { recursive: true });
  store = new JobStore(join(home, 'jobs.db'));
});

describe('sweepOnStartup', () => {
  it('marks jobs left running as interrupted', () => {
    store.create(job(A));
    expect(sweepOnStartup({ home, store, artifactTtlDays: 7 }).interrupted).toEqual([A]);
    expect(store.get(A)!.status).toBe('interrupted');
  });

  it('removes a workspace whose job is terminal', () => {
    store.create(job(A));
    store.finish(A, 'ok', null, null);
    const ws = join(home, 'workspaces', A);
    mkdirSync(ws, { recursive: true });
    sweepOnStartup({ home, store, artifactTtlDays: 7 });
    expect(existsSync(ws)).toBe(false);
  });

  it('removes a workspace whose job is unknown to the store', () => {
    const ws = join(home, 'workspaces', 'orphan');
    mkdirSync(ws, { recursive: true });
    sweepOnStartup({ home, store, artifactTtlDays: 7 });
    expect(existsSync(ws)).toBe(false);
  });

  it('purges artifacts older than the TTL', () => {
    const dir = join(home, 'artifacts', A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'patch.diff'), 'old');
    ageDir(dir, 10);
    expect(sweepOnStartup({ home, store, artifactTtlDays: 7 }).artifactsPurged).toEqual([A]);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps artifacts inside the TTL, even for a finished job', () => {
    store.create(job(B));
    store.finish(B, 'ok', null, null);
    const dir = join(home, 'artifacts', B);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'patch.diff'), 'fresh');
    sweepOnStartup({ home, store, artifactTtlDays: 7 });
    expect(existsSync(dir)).toBe(true);
  });
});
