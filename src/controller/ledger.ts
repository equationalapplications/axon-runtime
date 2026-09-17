import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Envelope, JobRequest } from '../contract/schema.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  repo TEXT,
  ref TEXT,
  output TEXT,
  status TEXT,
  reason TEXT,
  exit_reason TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_estimate_usd REAL,
  model_id TEXT,
  runtime_version TEXT,
  harness_version TEXT,
  envelope TEXT,
  dispatched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_node ON jobs(node_id);
`;

export interface NodeMetrics {
  node_id: string;
  jobs: number;
  ok: number;
  error: number;
  rejected: number;
  success_rate: number;
  total_cost_usd: number;
  median_duration_ms: number;
}

export class Ledger {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  recordDispatch(job: JobRequest, nodeId: string): void {
    this.db
      .prepare(
        `INSERT INTO jobs (job_id, node_id, repo, ref, output, status, dispatched_at)
         VALUES (?, ?, ?, ?, ?, 'dispatched', ?)
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .run(job.job_id, nodeId, job.repo, job.ref, job.output, new Date().toISOString());
  }

  recordEnvelope(env: Envelope, nodeId: string): void {
    const t = env.telemetry;
    this.db
      .prepare(
        `INSERT INTO jobs (job_id, node_id, status, reason, exit_reason, started_at, ended_at,
                           duration_ms, tokens_in, tokens_out, cost_estimate_usd, model_id,
                           runtime_version, harness_version, envelope, dispatched_at)
         VALUES (@job_id, @node_id, @status, @reason, @exit_reason, @started_at, @ended_at,
                 @duration_ms, @tokens_in, @tokens_out, @cost, @model_id,
                 @runtime_version, @harness_version, @envelope, @now)
         ON CONFLICT(job_id) DO UPDATE SET
           status = excluded.status, reason = excluded.reason, exit_reason = excluded.exit_reason,
           started_at = excluded.started_at, ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms, tokens_in = excluded.tokens_in,
           tokens_out = excluded.tokens_out, cost_estimate_usd = excluded.cost_estimate_usd,
           model_id = excluded.model_id, runtime_version = excluded.runtime_version,
           harness_version = excluded.harness_version, envelope = excluded.envelope`,
      )
      .run({
        job_id: env.job_id,
        node_id: nodeId,
        status: env.status,
        reason: env.reason,
        exit_reason: t?.exit_reason ?? null,
        started_at: t?.started_at ?? null,
        ended_at: t?.ended_at ?? null,
        duration_ms: t?.duration_ms ?? null,
        tokens_in: t?.tokens_in ?? null,
        tokens_out: t?.tokens_out ?? null,
        cost: t?.cost_estimate_usd ?? 0,
        model_id: t?.model_id ?? null,
        runtime_version: t?.runtime_version ?? null,
        harness_version: t?.harness_version ?? null,
        envelope: JSON.stringify(env),
        now: new Date().toISOString(),
      });
  }

  nodeFor(jobId: string): string | undefined {
    const row = this.db.prepare('SELECT node_id FROM jobs WHERE job_id = ?').get(jobId) as
      | { node_id: string }
      | undefined;
    return row?.node_id;
  }

  metricsFor(nodeId: string): NodeMetrics {
    const rows = this.db
      .prepare('SELECT status, duration_ms, cost_estimate_usd FROM jobs WHERE node_id = ? AND status != ?')
      .all(nodeId, 'dispatched') as { status: string; duration_ms: number | null; cost_estimate_usd: number | null }[];

    const ok = rows.filter((r) => r.status === 'ok').length;
    const rejected = rows.filter((r) => r.status === 'rejected').length;
    const error = rows.length - ok - rejected;
    const durations = rows.map((r) => r.duration_ms ?? 0).sort((a, b) => a - b);

    return {
      node_id: nodeId,
      jobs: rows.length,
      ok,
      error,
      rejected,
      success_rate: rows.length === 0 ? 0 : ok / rows.length,
      total_cost_usd: rows.reduce((sum, r) => sum + (r.cost_estimate_usd ?? 0), 0),
      median_duration_ms: durations.length === 0 ? 0 : durations[Math.floor(durations.length / 2)]!,
    };
  }

  close(): void {
    this.db.close();
  }
}
