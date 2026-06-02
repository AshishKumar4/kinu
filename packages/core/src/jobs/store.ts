// Background-job registry — the correlation source of truth for work that a
// tool call detaches to the background (think-heads, long execute_tools/run).
// A job is created when a call crosses the background threshold, settled when
// the detached work resolves, and read back by the synthesis turn the reactor
// wakes. `settle`/`fail` are guarded on status='running' so a duplicate
// completion wake (at-least-once delivery) can't overwrite or double-apply.

import type { SqlExecutor, RawSqlExec } from '../types/primitives.js';

export type BackgroundJobStatus = 'running' | 'completed' | 'failed';

export interface BackgroundJob {
  id: string;
  kind: string;
  label: string | null;
  status: BackgroundJobStatus;
  result: string | null;
  error: string | null;
  createdAt: number;
  settledAt: number | null;
}

interface Row {
  id: string; kind: string; label: string | null; status: string;
  result: string | null; error: string | null; created_at: number; settled_at: number | null;
}

function toJob(r: Row): BackgroundJob {
  const status: BackgroundJobStatus = r.status === 'completed' || r.status === 'failed' ? r.status : 'running';
  return {
    id: r.id, kind: r.kind, label: r.label, status,
    result: r.result, error: r.error, createdAt: r.created_at, settledAt: r.settled_at,
  };
}

/** Serialize a job result for storage — never throws (a non-serializable value,
 *  e.g. a BigInt from execute_tools, falls back to String()), with a truncation
 *  marker so the synthesis turn knows when content was clipped. */
export function serializeJobResult(result: unknown, limit = 16_000): string {
  let s: string;
  try { s = JSON.stringify(result ?? null); } catch { s = String(result); }
  return s.length > limit
    ? s.slice(0, limit) + `\n…[truncated ${s.length - limit} chars; the full result was longer]`
    : s;
}

export function initBackgroundJobsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS background_jobs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    label       TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    result      TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    settled_at  INTEGER
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status)`);
}

export class BackgroundJobStore {
  constructor(private readonly sql: SqlExecutor) {}

  create(opts: { id: string; kind: string; label?: string; now: number }): void {
    this.sql`INSERT OR IGNORE INTO background_jobs (id, kind, label, status, created_at)
      VALUES (${opts.id}, ${opts.kind}, ${opts.label ?? null}, 'running', ${opts.now})`;
  }

  /** Mark a running job completed. No-op if already settled (idempotent wake). */
  settle(id: string, result: string, now: number): void {
    this.sql`UPDATE background_jobs SET status='completed', result=${result}, settled_at=${now}
      WHERE id=${id} AND status='running'`;
  }

  /** Mark a running job failed. No-op if already settled. */
  fail(id: string, error: string, now: number): void {
    this.sql`UPDATE background_jobs SET status='failed', error=${error}, settled_at=${now}
      WHERE id=${id} AND status='running'`;
  }

  get(id: string): BackgroundJob | null {
    const rows = this.sql<Row>`SELECT id, kind, label, status, result, error, created_at, settled_at
      FROM background_jobs WHERE id=${id} LIMIT 1`;
    return rows[0] ? toJob(rows[0]) : null;
  }

  list(limit = 20): BackgroundJob[] {
    return this.sql<Row>`SELECT id, kind, label, status, result, error, created_at, settled_at
      FROM background_jobs ORDER BY created_at DESC LIMIT ${limit}`.map(toJob);
  }
}
