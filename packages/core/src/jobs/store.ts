// Background-job registry — the correlation source of truth for work that a
// tool call detaches to the background (think-heads, long execute_tools/run).
// A job is created when a call crosses the background threshold, settled when
// the detached work resolves, and read back by the synthesis turn the reactor
// wakes. `settle`/`fail` are guarded on status='running' so a duplicate
// completion wake (at-least-once delivery) can't overwrite or double-apply.
//
// Lease-epoch fencing (agent-core SPEC §5.3 / §10.3): every job carries a
// monotonic `epoch`. The executor that owns a detach captures the epoch and
// stamps it on its terminal write; a DO eviction + recovery `reclaim`s the job,
// bumping the epoch so a stale/zombie executor from the dead process can no
// longer settle it — its write carries a stale epoch and is rejected. On a
// platform with no fenced DO callback (Queues/alarms are at-least-once) this
// epoch check IS the fence.

import type { SqlExecutor, RawSqlExec } from '../types/primitives.js';

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export interface BackgroundJob {
  id: string;
  kind: string;
  label: string | null;
  status: BackgroundJobStatus;
  result: string | null;
  error: string | null;
  createdAt: number;
  settledAt: number | null;
  /** Monotonic lease epoch — bumped by `reclaim` on evict-recovery (§5.3). */
  epoch: number;
  /** How many times evict-recovery has re-driven this job (bounds resume loops). */
  resumeAttempts: number;
}

/** The result of claiming a job for an evict-recovery re-drive. */
export interface JobClaim {
  /** The new lease epoch every write from this attempt must carry. */
  epoch: number;
  /** How many re-drives this job has now had (1 on the first recovery). */
  attempts: number;
}

interface Row {
  id: string; kind: string; label: string | null; status: string;
  result: string | null; error: string | null; created_at: number; settled_at: number | null;
  epoch: number; resume_attempts: number;
}

function toJob(r: Row): BackgroundJob {
  const status: BackgroundJobStatus = SETTLED.has(r.status) ? r.status as BackgroundJobStatus : 'running';
  return {
    id: r.id, kind: r.kind, label: r.label, status,
    result: r.result, error: r.error, createdAt: r.created_at, settledAt: r.settled_at,
    epoch: r.epoch ?? 0, resumeAttempts: r.resume_attempts ?? 0,
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
    input_json  TEXT,
    epoch       INTEGER NOT NULL DEFAULT 0,
    resume_attempts INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    settled_at  INTEGER
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status)`);
  // Older DOs predate these columns (retry needs the original tool input; the
  // epoch/resume_attempts pair is the lease fence + resume-loop bound).
  try { execRaw(`ALTER TABLE background_jobs ADD COLUMN input_json TEXT`); } catch { /* exists */ }
  try { execRaw(`ALTER TABLE background_jobs ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { execRaw(`ALTER TABLE background_jobs ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
}

export class BackgroundJobStore {
  constructor(private readonly sql: SqlExecutor) {}

  create(opts: { id: string; kind: string; label?: string; input?: string; now: number }): void {
    this.sql`INSERT OR IGNORE INTO background_jobs (id, kind, label, status, input_json, epoch, resume_attempts, created_at)
      VALUES (${opts.id}, ${opts.kind}, ${opts.label ?? null}, 'running', ${opts.input ?? null}, 0, 0, ${opts.now})`;
  }

  /** Mark a running job completed. No-op if already settled (idempotent wake) or
   *  if `epoch` is stale — i.e. a zombie executor from a dead process fenced by a
   *  reclaim that already bumped the epoch (§5.3). */
  settle(id: string, epoch: number, result: string, now: number): void {
    this.sql`UPDATE background_jobs SET status='completed', result=${result}, settled_at=${now}
      WHERE id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Mark a running job failed. No-op if already settled or the epoch is stale. */
  fail(id: string, epoch: number, error: string, now: number): void {
    this.sql`UPDATE background_jobs SET status='failed', error=${error}, settled_at=${now}
      WHERE id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Mark a running job cancelled (operator hard-cancel). No-op if settled or the
   *  epoch is stale. */
  cancel(id: string, epoch: number, now: number): void {
    this.sql`UPDATE background_jobs SET status='cancelled', error='cancelled by operator', settled_at=${now}
      WHERE id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Claim a still-running job for an evict-recovery re-drive: bump the lease
   *  epoch (fencing any executor still holding the old one) and the resume-attempt
   *  counter, atomically. Returns the new epoch + attempt count, or null when the
   *  job is no longer running (already settled/cancelled, or gone). */
  reclaim(id: string, _now: number): JobClaim | null {
    this.sql`UPDATE background_jobs SET epoch = epoch + 1, resume_attempts = resume_attempts + 1
      WHERE id=${id} AND status='running'`;
    const rows = this.sql<{ epoch: number; resume_attempts: number; status: string }>`
      SELECT epoch, resume_attempts, status FROM background_jobs WHERE id=${id} LIMIT 1`;
    const row = rows[0];
    if (!row || row.status !== 'running') return null;
    return { epoch: row.epoch, attempts: row.resume_attempts };
  }

  /** The current lease epoch of a job — captured by an executor at detach so its
   *  terminal write can carry it. Null when the job is absent. */
  epochOf(id: string): number | null {
    const rows = this.sql<{ epoch: number }>`SELECT epoch FROM background_jobs WHERE id=${id} LIMIT 1`;
    return rows[0]?.epoch ?? null;
  }

  /** Remove a settled job from the registry. No-op if still running. */
  dismiss(id: string): void {
    this.sql`DELETE FROM background_jobs WHERE id=${id} AND status != 'running'`;
  }

  /** Remove all settled jobs. Running jobs are kept. Returns nothing. */
  clearSettled(): void {
    this.sql`DELETE FROM background_jobs WHERE status != 'running'`;
  }

  /** The serialized tool input a job was created with — re-run source for retry. */
  getInput(id: string): string | null {
    const rows = this.sql<{ input_json: string | null }>`
      SELECT input_json FROM background_jobs WHERE id=${id} LIMIT 1`;
    return rows[0]?.input_json ?? null;
  }

  get(id: string): BackgroundJob | null {
    const rows = this.sql<Row>`SELECT id, kind, label, status, result, error, created_at, settled_at, epoch, resume_attempts
      FROM background_jobs WHERE id=${id} LIMIT 1`;
    return rows[0] ? toJob(rows[0]) : null;
  }

  list(limit = 20): BackgroundJob[] {
    return this.sql<Row>`SELECT id, kind, label, status, result, error, created_at, settled_at, epoch, resume_attempts
      FROM background_jobs ORDER BY created_at DESC LIMIT ${limit}`.map(toJob);
  }

  /** Only the jobs still in flight, newest first — the dynamic-context roster.
   *  Narrower than `list`, which a settled backlog can crowd out entirely. */
  listRunning(limit = 20): BackgroundJob[] {
    return this.sql<Row>`SELECT id, kind, label, status, result, error, created_at, settled_at, epoch, resume_attempts
      FROM background_jobs WHERE status='running' ORDER BY created_at DESC LIMIT ${limit}`.map(toJob);
  }
}
