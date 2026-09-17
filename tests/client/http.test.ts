import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AxonClient, newJobId } from '../../src/client/http.js';
import { buildServer } from '../../src/service/server.js';
import { JobPool } from '../../src/service/pool.js';
import { ArtifactStore } from '../../src/service/artifacts.js';
import { JobStore } from '../../src/state/store.js';
import { BudgetGuard } from '../../src/harness/budget.js';
import { FakeExecutor } from '../../src/executor/fake.js';
import type { DeployConfig } from '../../src/config/deploy.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';

let app: FastifyInstance;
let client: AxonClient;

function job(over: Partial<JobRequest> = {}): JobRequest {
  return {
    contract_version: CONTRACT_VERSION, job_id: newJobId(), repo: 'repo', ref: 'main', goal: 'g', context: [],
    constraints: { max_harness_steps: 5, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'report', ...over,
  };
}

beforeEach(async () => {
  const home = mkdtempSync(join(tmpdir(), 'axon-cli-'));
  const cfg: DeployConfig = {
    nodeId: 'n1', home, bearerToken: 'tok', maxConcurrentJobs: 2, repoAllowlist: ['repo'],
    ceilings: { max_harness_steps: 40, timeout_seconds: 1800, max_spend_usd: 2 },
    nodeDailySpendUsd: 20,
    maxGoalBytes: 1024, maxContextBytes: 1024, maxInlinePatchBytes: 1024, artifactTtlDays: 7,
    endpoint: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'test-endpoint-key' },
  };
  const store = new JobStore(join(home, 'jobs.db'));
  const artifacts = new ArtifactStore(home);
  const pool = new JobPool({
    cfg, store, artifacts, executor: new FakeExecutor(),
    budget: new BudgetGuard(store, cfg), runtimeVersion: '0.1.0',
  });
  app = buildServer({ cfg, pool, artifacts, runtimeVersion: '0.1.0' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  client = new AxonClient({ baseUrl: address, token: 'tok' });
});

afterEach(async () => { await app.close(); });

describe('AxonClient', () => {
  it('mints distinct job ids', () => {
    expect(newJobId()).not.toBe(newJobId());
  });

  it('dispatches and waits for a terminal envelope', async () => {
    const j = job();
    await client.dispatch(j);
    const env = await client.wait(j.job_id, { pollMs: 10 });
    expect(env.status).toBe('ok');
    expect(env.result!.summary).toContain('g');
  });

  it('validates the envelope it receives against the shared schema', async () => {
    const j = job();
    await client.dispatch(j);
    const env = await client.wait(j.job_id, { pollMs: 10 });
    expect(env.contract_version).toBe(CONTRACT_VERSION);
    expect(env.telemetry!.node_id).toBe('n1');
  });

  it('surfaces a rejection with its reason', async () => {
    const res = await client.dispatch(job({ repo: 'other' }));
    expect(res).toMatchObject({ status: 'rejected', reason: 'repo_not_allowlisted' });
  });

  it('reads node info', async () => {
    expect((await client.nodeinfo()).node_id).toBe('n1');
  });

  it('fails loudly on a bad token', async () => {
    const bad = new AxonClient({ baseUrl: client.baseUrl, token: 'wrong' });
    await expect(bad.nodeinfo()).rejects.toThrow(/401/);
  });

  it('times out waiting rather than polling forever', async () => {
    await expect(
      client.wait('3f1a6b8e-0000-4000-8000-0000000000e9', { pollMs: 5, timeoutMs: 40 }),
    ).rejects.toThrow(/timed out/);
  });
});
