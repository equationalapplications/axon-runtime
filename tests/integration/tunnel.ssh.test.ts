import { execa, type ResultPromise } from 'execa';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/service/server.js';
import { JobPool } from '../../src/service/pool.js';
import { ArtifactStore } from '../../src/service/artifacts.js';
import { JobStore } from '../../src/state/store.js';
import { BudgetGuard } from '../../src/harness/budget.js';
import { FakeExecutor } from '../../src/executor/fake.js';
import { AxonClient, newJobId } from '../../src/client/http.js';
import { Ledger } from '../../src/controller/ledger.js';
import type { DeployConfig } from '../../src/config/deploy.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';

const NODE_ID = 'loopback-01';
const TOKEN = 'integration-token';

let app: FastifyInstance;
let tunnel: ResultPromise | undefined;
let client: AxonClient;
let ledger: Ledger;
let localPort: number;

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return await new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), 'axon-int-'));
  const cfg: DeployConfig = {
    nodeId: NODE_ID, home, bearerToken: TOKEN, maxConcurrentJobs: 2, repoAllowlist: ['repo'],
    ceilings: { max_harness_steps: 40, timeout_seconds: 1800, max_spend_usd: 2 },
    nodeDailySpendUsd: 20,
    maxGoalBytes: 32_768, maxContextBytes: 1_048_576, maxInlinePatchBytes: 1_048_576, artifactTtlDays: 7,
    endpoint: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'integration-key' },
  };
  const store = new JobStore(join(home, 'jobs.db'));
  const artifacts = new ArtifactStore(home);
  const pool = new JobPool({
    cfg, store, artifacts, executor: new FakeExecutor(),
    budget: new BudgetGuard(store, cfg), runtimeVersion: '0.1.0',
  });
  app = buildServer({ cfg, pool, artifacts, runtimeVersion: '0.1.0' });

  const workerPort = await freePort();
  await app.listen({ host: '127.0.0.1', port: workerPort });

  localPort = await freePort();
  // ssh to ourselves: the same command shape deploy/ uses for a real node.
  tunnel = execa('ssh', [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `${localPort}:127.0.0.1:${workerPort}`,
    'localhost',
  ]);
  tunnel.catch(() => undefined);

  client = new AxonClient({ baseUrl: `http://127.0.0.1:${localPort}`, token: TOKEN });
  for (let i = 0; i < 50; i++) {
    try {
      await client.nodeinfo();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  ledger = new Ledger(join(home, 'ledger.db'));
}, 30_000);

afterAll(async () => {
  tunnel?.kill('SIGTERM');
  await app.close();
});

function job(): JobRequest {
  return {
    contract_version: CONTRACT_VERSION, job_id: newJobId(), repo: 'repo', ref: 'main',
    goal: 'M1 end-to-end echo', context: [],
    constraints: { max_harness_steps: 5, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'patch',
  };
}

describe('M1: dispatch over an SSH tunnel', () => {
  it('reaches the worker through the forwarded port', async () => {
    expect((await client.nodeinfo()).node_id).toBe(NODE_ID);
  });

  it('completes the round trip: dispatch, poll, envelope, ledger', async () => {
    const j = job();
    ledger.recordDispatch(j, NODE_ID);
    expect((await client.dispatch(j)).status).toBe('accepted');

    const envelope = await client.wait(j.job_id, { pollMs: 50, timeoutMs: 20_000 });
    expect(envelope.status).toBe('ok');
    expect(envelope.node_id).toBe(NODE_ID);
    expect(envelope.telemetry!.executor).toBe('fake');
    expect(envelope.result!.patch).toMatch(/^diff --git /);

    ledger.recordEnvelope(envelope, NODE_ID);
    expect(ledger.nodeFor(j.job_id)).toBe(NODE_ID);
    expect(ledger.metricsFor(NODE_ID).ok).toBeGreaterThanOrEqual(1);
  });

  it('rejects a request carrying no bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/nodeinfo`);
    expect(res.status).toBe(401);
  });
});
