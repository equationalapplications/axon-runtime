import Database from 'better-sqlite3';
import type { JobRequest, JobStatus, Telemetry } from '../contract/schema.js';

export interface JobRecord {
  jobId: string;
  status: JobStatus | 'running';
  request: JobRequest;
  harnessSteps: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  resultJson: string | null;
  telemetryJson: string | null;
  errorDetail: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  request TEXT NOT NULL,
  harness_steps INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT,
  telemetry TEXT,
  error_detail TEXT
);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  usd REAL NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_at ON spend(at);
`;

// Columns added after the initial v1 release. CREATE TABLE IF NOT EXISTS leaves
// an already-created `jobs` table untouched, so an in-place upgrade would crash
// `finish()` with `no such column: error_detail` and strand the job in
// `running`. Each entry adds the column once on startup if it is missing.
interface ColumnMigration {
  table: string;
  name: string;
  ddl: string;
  // Optional backfill: rows that match `where` get `update` applied after the
  // column exists. Required when a refine on the envelope schema makes a NULL
  // in the new column illegal under a pre-existing exit_reason — leaving the
  // NULL would crash EnvelopeSchema.parse and freeze dispatch polling forever.
  backfill?: { update: string; where: string };
}
const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  {
    table: 'jobs',
    name: 'error_detail',
    ddl: 'ALTER TABLE jobs ADD COLUMN error_detail TEXT',
    // Pre-v2 jobs ended with exit_reason='harness_error' but no error_detail;
    // the v2 envelope refine requires error_detail !== null in that case. Backfill
    // with the same placeholder the live formatter uses so the envelope parses.
    backfill: {
      update: "error_detail = 'unknown error'",
      where: "error_detail IS NULL AND json_extract(telemetry, '$.exit_reason') = 'harness_error'",
    },
  },
];

function runColumnMigrations(db: Database.Database): void {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === m.name)) continue;
    db.exec(m.ddl);
    if (m.backfill) {
      db.exec(`UPDATE ${m.table} SET ${m.backfill.update} WHERE ${m.backfill.where}`);
    }
  }
}

type Row = {
  job_id: string; status: string; request: string; harness_steps: number;
  cost_usd: number; started_at: string; ended_at: string | null;
  result: string | null; telemetry: string | null; error_detail: string | null;
};

function toRecord(row: Row): JobRecord {
  return {
    jobId: row.job_id,
    status: row.status as JobRecord['status'],
    request: JSON.parse(row.request) as JobRequest,
    harnessSteps: row.harness_steps,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    resultJson: row.result,
    telemetryJson: row.telemetry,
    errorDetail: row.error_detail,
  };
}

export class JobStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    runColumnMigrations(this.db);
  }

  create(req: JobRequest): JobRecord {
    const existing = this.get(req.job_id);
    if (existing) return existing;
    this.db
      .prepare('INSERT INTO jobs (job_id, status, request, started_at) VALUES (?, ?, ?, ?)')
      .run(req.job_id, 'running', JSON.stringify(req), new Date().toISOString());
    return this.get(req.job_id)!;
  }

  get(jobId: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  createRejected(jobId: string, reason: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO jobs (job_id, status, request, started_at, ended_at, result) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(jobId, 'rejected', '{}', new Date().toISOString(), new Date().toISOString(), JSON.stringify({ reason }));
  }

  checkpoint(jobId: string, patch: Partial<Pick<JobRecord, 'harnessSteps' | 'costUsd'>>): void {
    if (patch.harnessSteps !== undefined) {
      this.db.prepare('UPDATE jobs SET harness_steps = ? WHERE job_id = ?').run(patch.harnessSteps, jobId);
    }
    if (patch.costUsd !== undefined) {
      this.db.prepare('UPDATE jobs SET cost_usd = ? WHERE job_id = ?').run(patch.costUsd, jobId);
    }
  }

  finish(jobId: string, status: JobStatus, result: unknown | null, telemetry: Telemetry | null, errorDetail: string | null = null): void {
    this.db
      .prepare('UPDATE jobs SET status = ?, ended_at = ?, result = ?, telemetry = ?, error_detail = ? WHERE job_id = ?')
      .run(
        status,
        new Date().toISOString(),
        result === null ? null : JSON.stringify(result),
        telemetry === null ? null : JSON.stringify(telemetry),
        errorDetail,
        jobId,
      );
  }

  activeCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'").get() as { n: number };
    return row.n;
  }

  recoverInterrupted(): string[] {
    const rows = this.db.prepare("SELECT job_id FROM jobs WHERE status = 'running'").all() as { job_id: string }[];
    const ids = rows.map((r) => r.job_id);
    this.db.prepare("UPDATE jobs SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
    return ids;
  }

  addSpend(jobId: string, usd: number): void {
    this.db.prepare('INSERT INTO spend (job_id, usd, at) VALUES (?, ?, ?)')
      .run(jobId, usd, new Date().toISOString());
  }

  spendSince(sinceIso: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE at >= ?')
      .get(sinceIso) as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}
