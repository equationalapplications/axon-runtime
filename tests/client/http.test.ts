import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AxonClient, ContractMismatchError, newJobId } from '../../src/client/http.js';
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
    maxGoalBytes: 1024, maxContextBytes: 1024, maxGuidanceBytes: 1024, maxInlinePatchBytes: 1024, artifactTtlDays: 7,
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

describe('AxonClient contract mismatch handling', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function envelopeBody(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      contract_version: 2, job_id: '3f1a6b8e-0000-4000-8000-0000000000f1', node_id: 'n1',
      status: 'rejected', reason: 'queue_full', error_detail: null, result: null,
      telemetry: null, ...over,
    });
  }

  function stubFetchSequence(responses: Array<{ status: number; body: string }>): void {
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const r = responses[Math.min(i++, responses.length - 1)];
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
    }));
  }

  it('parses a v3 terminal envelope', async () => {
    stubFetchSequence([{ status: 200, body: envelopeBody({ contract_version: 3 }) }]);
    const c = new AxonClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    const env = await c.status('3f1a6b8e-0000-4000-8000-0000000000f1');
    expect(env).toMatchObject({ status: 'rejected', contract_version: 3 });
  });

  it('raises ContractMismatchError from status() when a terminal body fails schema validation', async () => {
    stubFetchSequence([{ status: 200, body: envelopeBody({ contract_version: 2 }) }]);
    const c = new AxonClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    await expect(c.status('3f1a6b8e-0000-4000-8000-0000000000f1')).rejects.toThrow(ContractMismatchError);
    await expect(c.status('3f1a6b8e-0000-4000-8000-0000000000f1')).rejects.toThrow(
      /node contract_version 2.*client contract_version 3.*upgrade in lockstep/s,
    );
  });

  it('carries both versions as fields on the error', async () => {
    stubFetchSequence([{ status: 200, body: envelopeBody({ contract_version: 2 }) }]);
    const c = new AxonClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    const err = await c.status('3f1a6b8e-0000-4000-8000-0000000000f1').catch((e) => e);
    expect(err).toBeInstanceOf(ContractMismatchError);
    expect(err.nodeContractVersion).toBe(2);
    expect(err.clientContractVersion).toBe(3);
  });

  it('wait() rethrows ContractMismatchError immediately instead of polling to timeout', async () => {
    stubFetchSequence([{ status: 200, body: envelopeBody({ contract_version: 2 }) }]);
    const c = new AxonClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    await expect(
      c.wait('3f1a6b8e-0000-4000-8000-0000000000f1', { pollMs: 5, timeoutMs: 3000 }),
    ).rejects.toThrow(ContractMismatchError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('wait() keeps retrying when a 5xx handler returns an HTML body', async () => {
    stubFetchSequence([{ status: 502, body: '<html>bad gateway</html>' }]);
    const c = new AxonClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    await expect(c.wait('3f1a6b8e-0000-4000-8000-0000000000f1', { pollMs: 5, timeoutMs: 60 })).rejects.toThrow(
      /timed out/,
    );
  });

  it('wait() keeps retrying a JSON 5xx body (a Fastify default error is NOT a contract mismatch)', async () => {
    stubFetchSequence([{ status: 500, body: '{"statusCode":500,"error":"Internal Server Error"}' }]);
    const c = new AxonClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    await expect(c.wait('3f1a6b8e-0000-4000-8000-0000000000f1', { pollMs: 5, timeoutMs: 60 })).rejects.toThrow(
      /timed out/,
    );
  });

  it('wait() fails fast on a same-version terminal body that fails schema validation (no lockstep hint)', async () => {
    stubFetchSequence([
      { status: 200, body: JSON.stringify({ contract_version: 3, status: 'ok', result: null, bad_field: true }) },
    ]);
    const c = new AxonClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    await expect(c.wait('3f1a6b8e-0000-4000-8000-0000000000f1', { pollMs: 5, timeoutMs: 3000 })).rejects.toThrow(
      /node contract_version 3, client contract_version 3(?!.*lockstep)/s,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
