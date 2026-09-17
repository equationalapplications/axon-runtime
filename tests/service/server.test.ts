import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/service/server.js';
import { JobPool } from '../../src/service/pool.js';
import { ArtifactStore } from '../../src/service/artifacts.js';
import { JobStore } from '../../src/state/store.js';
import { BudgetGuard } from '../../src/harness/budget.js';
import { FakeExecutor } from '../../src/executor/fake.js';
import type { DeployConfig } from '../../src/config/deploy.js';
import { CONTRACT_VERSION } from '../../src/contract/schema.js';

const A = '3f1a6b8e-0000-4000-8000-0000000000d1';

const jobBody = {
  contract_version: CONTRACT_VERSION, job_id: A, repo: 'repo', ref: 'main', goal: 'g',
  constraints: { max_harness_steps: 5, timeout_seconds: 60, max_spend_usd: 1 },
  output: 'report',
};

let app: FastifyInstance;
let pool: JobPool;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'axon-srv-'));
  const cfg: DeployConfig = {
    nodeId: 'n1', home, bearerToken: 'tok', maxConcurrentJobs: 2,
    repoAllowlist: ['repo'],
    ceilings: { max_harness_steps: 40, timeout_seconds: 1800, max_spend_usd: 2 },
    nodeDailySpendUsd: 20,
    maxGoalBytes: 1024, maxContextBytes: 1024, maxInlinePatchBytes: 1024, artifactTtlDays: 7,
    endpoint: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k-env' },
  };
  const store = new JobStore(join(home, 'jobs.db'));
  const artifacts = new ArtifactStore(home);
  pool = new JobPool({
    cfg, store, artifacts, executor: new FakeExecutor(),
    budget: new BudgetGuard(store, cfg), runtimeVersion: '0.1.0',
  });
  app = buildServer({ cfg, pool, artifacts, runtimeVersion: '0.1.0' });
});

afterEach(async () => { await app.close(); });

const auth = { authorization: 'Bearer tok' };

describe('auth', () => {
  it('serves /healthz without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('rejects /nodeinfo without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/nodeinfo' })).statusCode).toBe(401);
  });

  it('rejects /nodeinfo with the wrong token', async () => {
    const res = await app.inject({ method: 'GET', url: '/nodeinfo', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('serves /nodeinfo with the right token', async () => {
    const res = await app.inject({ method: 'GET', url: '/nodeinfo', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      node_id: 'n1', contract_version: CONTRACT_VERSION, active_jobs: 0, max_concurrent_jobs: 2,
    });
  });
});

describe('jobs', () => {
  it('accepts a job and returns 202', async () => {
    const res = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: jobBody });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ job_id: A, status: 'accepted' });
  });

  it('returns 400 with the reason for a rejected job', async () => {
    const res = await app.inject({
      method: 'POST', url: '/jobs', headers: auth, payload: { ...jobBody, repo: 'other' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 'rejected', reason: 'repo_not_allowlisted' });
  });

  it('returns 400 (not 500) for a payload without a string job_id', async () => {
    const res = await app.inject({
      method: 'POST', url: '/jobs', headers: auth,
      payload: { ...jobBody, job_id: { nested: true } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 'rejected', reason: 'malformed_payload' });
  });

  it('reports a running job as 200 with status running', async () => {
    await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: jobBody });
    await pool.drain();
    const res = await app.inject({ method: 'GET', url: `/jobs/${A}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('returns 404 for an unknown job', async () => {
    const unknown = '3f1a6b8e-0000-4000-8000-0000000000d9';
    expect((await app.inject({ method: 'GET', url: `/jobs/${unknown}`, headers: auth })).statusCode).toBe(404);
  });

  it('returns 404 when cancelling a job that is not running', async () => {
    const res = await app.inject({ method: 'POST', url: `/jobs/${A}/cancel`, headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an artifact that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: `/jobs/${A}/artifact?id=patch.diff`, headers: auth });
    expect(res.statusCode).toBe(404);
  });
});
