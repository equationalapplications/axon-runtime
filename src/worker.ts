import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadDeployConfig } from './config/deploy.js';
import { FakeExecutor } from './executor/fake.js';
import { LocalExecutor } from './executor/local.js';
import { BudgetGuard } from './harness/budget.js';
import { ArtifactStore } from './service/artifacts.js';
import { JobPool } from './service/pool.js';
import { buildServer } from './service/server.js';
import { sweepOnStartup } from './service/sweep.js';
import { JobStore } from './state/store.js';

export const RUNTIME_VERSION = '0.1.0';

export async function startWorker(configPath: string, port = 8787): Promise<FastifyInstance> {
  const cfg = loadDeployConfig(configPath, process.env);
  for (const sub of ['workspaces', 'artifacts', 'cache', 'state']) {
    mkdirSync(join(cfg.home, sub), { recursive: true });
  }

  const store = new JobStore(join(cfg.home, 'state', 'jobs.db'));
  sweepOnStartup({ home: cfg.home, store, artifactTtlDays: cfg.artifactTtlDays });

  const artifacts = new ArtifactStore(cfg.home);
  const budget = new BudgetGuard(store, cfg);
  const executor = process.env.AXON_EXECUTOR === 'fake' ? new FakeExecutor() : new LocalExecutor(cfg, {
    // Every completed harness step is recorded durably: BudgetGuard.record
    // appends to the spend ledger (feeding the node daily cap) and
    // checkpoints cost_usd (feeding crash recovery). Spec §8, §9.3.
    onStep: (jobId, _step, costUsd) => budget.record(jobId, costUsd - budget.jobSpend(jobId)),
  });

  const pool = new JobPool({
    cfg, store, artifacts, executor,
    budget,
    runtimeVersion: RUNTIME_VERSION,
  });

  const app = buildServer({ cfg, pool, artifacts, runtimeVersion: RUNTIME_VERSION });
  // Loopback-only bind: the Global Constraint for every node socket.
  await app.listen({ host: '127.0.0.1', port });
  return app;
}

if (process.argv[1]?.endsWith('worker.js')) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('usage: axon-worker <deploy/nodes/<node>.json>');
    process.exit(2);
  }
  await startWorker(configPath, Number(process.env.AXON_PORT ?? 8787));
}
