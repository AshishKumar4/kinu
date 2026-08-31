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

import { reconcileColumns } from '../identity/columns';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { WorkMode } from '../prompting/surface';
import { renderThrownChain } from '../obs/index';
import type { ActiveRoster } from '../prompting/volatile-context';

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundJob {
  id: string;
  kind: string;
  label: string | null;
  workMode: WorkMode;
  status: BackgroundJobStatus;
  result: string | null;
  error: string | null;
  createdAt: number;
  settledAt: number | null;
  /** Monotonic lease epoch — bumped by `reclaim` on evict-recovery (§5.3). */
  epoch: number;
  /** How many times evict-recovery has re-driven this job (bounds resume loops). */
  resumeAttempts: number;
  /** Replacement job created by an operator retry; null until handled. */
  retriedBy: string | null;
  /**
   * When the attempt CURRENTLY driving this job began — `createdAt` for a first
   * drive, bumped by every {@link BackgroundJobStore.reclaim}.
   *
   * The job's own lifetime was previously unreadable: `createdAt` says when the work
   * was first asked for and `settledAt` is null while it runs, so nothing could
   * answer "how long has this generation been going" and nothing bounded it. A live
   * job was measured `running` 28 minutes into its third generation with two
   * completed candidates its caller could not see.
   */
  attemptStartedAt: number;
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
  work_mode: string;
  result: string | null; error: string | null; created_at: number; settled_at: number | null;
  epoch: number; resume_attempts: number; attempt_started_at: number | null; retried_by: string | null;
}

function toJob(r: Row): BackgroundJob {
  const status: BackgroundJobStatus = r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'
    ? r.status
    : 'running';
  return {
    id: r.id, kind: r.kind, label: r.label, workMode: r.work_mode === 'plan' ? 'plan' : 'build', status,
    result: r.result, error: r.error, createdAt: r.created_at, settledAt: r.settled_at,
    epoch: r.epoch ?? 0,
    resumeAttempts: r.resume_attempts ?? 0,
    retriedBy: r.retried_by ?? null,
    // Null for a row written before this column existed. `created_at` is the honest
    // reading there: its first attempt is the only one anything recorded.
    attemptStartedAt: r.attempt_started_at ?? r.created_at,
  };
}

/** Serialize a job result for storage — never throws (a non-serializable value,
 *  e.g. a BigInt from execute_tools, falls back to String()). Stored WHOLE:
 *  the wake message promises "read the full result with agent.jobResult", and
 *  a row truncated at storage time made that a lie with no recovery path —
 *  while the read-back already rides the execute_tools clamp, which windows an
 *  oversize result and spills the full text with an address. Inputs must be
 *  whole for a different reason: driveResume JSON.parses them, and a marker
 *  appended to a clipped input turned every resumed fork into a corrupted
 *  string input. Both are model-authored payloads, bounded far below the row
 *  ceiling by the tool-result clamp and provider output limits. */
export function serializeJobResult<Result>(result: Result): string {
  try { return JSON.stringify(result ?? null); }
  catch (error) {
    return `unserializable job result: ${renderThrownChain({ cause: error })}`;
  }
}

export function initBackgroundJobsTable(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(`CREATE TABLE IF NOT EXISTS background_jobs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    label       TEXT,
    work_mode   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',
    result      TEXT,
    error       TEXT,
    input_json  TEXT,
    epoch       INTEGER NOT NULL DEFAULT 0,
    resume_attempts INTEGER NOT NULL DEFAULT 0,
    attempt_started_at INTEGER,
    retried_by TEXT,
    retry_of TEXT UNIQUE,
    created_at  INTEGER NOT NULL,
    settled_at  INTEGER
  )`);
  reconcileColumns(sql, execRaw, 'background_jobs', {
    work_mode: `TEXT NOT NULL DEFAULT 'build'`,
    input_json: 'TEXT',
    epoch: 'INTEGER NOT NULL DEFAULT 0',
    resume_attempts: 'INTEGER NOT NULL DEFAULT 0',
    attempt_started_at: 'INTEGER',
    retried_by: 'TEXT',
    retry_of: 'TEXT',
  });
  execRaw(`CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status)`);
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_retry_of
    ON background_jobs(retry_of) WHERE retry_of IS NOT NULL`);
}

export class BackgroundJobStore {
  constructor(private readonly sql: SqlExecutor) {}

  create(opts: { id: string; kind: string; workMode: WorkMode; label?: string; input?: string; now: number }): void {
    void this.sql`INSERT OR IGNORE INTO background_jobs (id, kind, label, work_mode, status, input_json, epoch, resume_attempts, created_at, attempt_started_at)
      VALUES (${opts.id}, ${opts.kind}, ${opts.label ?? null}, ${opts.workMode}, 'running', ${opts.input ?? null}, 0, 0, ${opts.now}, ${opts.now})`;
  }

  /** Create one replacement job and claim its settled source in the same SQL
   *  statement. The unique `retry_of` edge prevents a reset or double click
   *  from creating a second replacement. */
  createRetry(opts: {
    sourceId: string;
    id: string;
    kind: string;
    workMode: WorkMode;
    label?: string;
    input: string;
    now: number;
  }): boolean {
    void this.sql`INSERT OR IGNORE INTO background_jobs
      (id, kind, label, work_mode, status, input_json, epoch, resume_attempts,
       created_at, attempt_started_at, retry_of)
      SELECT ${opts.id}, ${opts.kind}, ${opts.label ?? null}, ${opts.workMode},
             'running', ${opts.input}, 0, 0, ${opts.now}, ${opts.now}, source.id
      FROM background_jobs source
      WHERE source.id=${opts.sourceId} AND source.status != 'running'
        AND NOT EXISTS (
          SELECT 1 FROM background_jobs replacement
          WHERE replacement.retry_of=source.id
        )`;
    return this.sql<{ id: string }>`
      SELECT id FROM background_jobs WHERE id=${opts.id} LIMIT 1`.length === 1;
  }

  /** Mark a running job completed. No-op if already settled (idempotent wake) or
   *  if `epoch` is stale — i.e. a zombie executor from a dead process fenced by a
   *  reclaim that already bumped the epoch (§5.3). */
  settle(id: string, epoch: number, result: string, now: number): void {
    void this.sql`UPDATE background_jobs SET status='completed', result=${result}, settled_at=${now}
      WHERE id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Mark a running job failed. No-op if already settled or the epoch is stale. */
  fail(id: string, epoch: number, error: string, now: number): void {
    void this.sql`UPDATE background_jobs SET status='failed', error=${error}, settled_at=${now}
      WHERE id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Mark a running job cancelled (operator hard-cancel). No-op if settled or the
   *  epoch is stale. */
  cancel(id: string, epoch: number, now: number): void {
    void this.sql`UPDATE background_jobs SET status='cancelled', error='cancelled by operator', settled_at=${now}
      WHERE id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Claim a still-running job for an evict-recovery re-drive: bump the lease
   *  epoch (fencing any executor still holding the old one), the resume-attempt
   *  counter and the attempt clock, atomically. Returns the new epoch + attempt
   *  count, or null when the job is no longer running (already settled/cancelled,
   *  or gone).
   *
   *  `attempt_started_at` moves with the epoch because they name the same event: a
   *  new lease IS a new generation, and a generation with no start time is one
   *  nothing can bound. */
  reclaim(id: string, now = Date.now()): JobClaim | null {
    void this.sql`UPDATE background_jobs
      SET epoch = epoch + 1, resume_attempts = resume_attempts + 1, attempt_started_at = ${now}
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
    void this.sql`DELETE FROM background_jobs WHERE id=${id} AND status != 'running'`;
  }


  /** Remove all settled jobs. Running jobs are kept. Returns nothing. */
  /** Whether ANY job row is still live — one LIMIT-1 read, for the
   *  activation-time arm decision that must not materialize the registry. */
  hasLiveJobs(): boolean {
    return this.sql<{ present: number }>`
      SELECT 1 AS present FROM background_jobs WHERE status = 'running' LIMIT 1`.length > 0;
  }

  clearSettled(): void {
    void this.sql`DELETE FROM background_jobs WHERE status != 'running'`;
  }

  /** The serialized tool input a job was created with — re-run source for retry. */
  getInput(id: string): string | null {
    const rows = this.sql<{ input_json: string | null }>`
      SELECT input_json FROM background_jobs WHERE id=${id} LIMIT 1`;
    return rows[0]?.input_json ?? null;
  }

  get(id: string): BackgroundJob | null {
    const rows = this.sql<Row>`SELECT job.id, job.kind, job.label, job.work_mode,
      job.status, job.result, job.error, job.created_at, job.settled_at,
      job.epoch, job.resume_attempts, job.attempt_started_at,
      COALESCE(job.retried_by, replacement.id) AS retried_by
      FROM background_jobs job
      LEFT JOIN background_jobs replacement ON replacement.retry_of=job.id
      WHERE job.id=${id} LIMIT 1`;
    return rows[0] ? toJob(rows[0]) : null;
  }

  list(limit = 20): BackgroundJob[] {
    return this.sql<Row>`SELECT job.id, job.kind, job.label, job.work_mode,
      job.status, job.result, job.error, job.created_at, job.settled_at,
      job.epoch, job.resume_attempts, job.attempt_started_at,
      COALESCE(job.retried_by, replacement.id) AS retried_by
      FROM background_jobs job
      LEFT JOIN background_jobs replacement ON replacement.retry_of=job.id
      ORDER BY job.created_at DESC LIMIT ${limit}`.map(toJob);
  }

  /** How many jobs are still in flight — the input to the concurrent-detach
   *  cap. Counted in SQL rather than from `listRunning`, whose limit would
   *  silently under-report exactly when the cap matters. */
  countRunning(): number {
    const rows = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM background_jobs WHERE status='running'`;
    return rows[0]?.n ?? 0;
  }

  /** Every job still in flight, oldest first — the startup recovery sweep's
   *  input. Deliberately unbounded, unlike `listRunning`: a display limit that
   *  silently dropped rows would skip exactly the stuck jobs the sweep exists
   *  to settle. Ids only — the sweep re-reads each row under its own claim. */
  runningIds(): string[] {
    return this.sql<{ id: string }>`SELECT id FROM background_jobs
      WHERE status='running' ORDER BY created_at ASC`.map((r) => r.id);
  }

  /** Only the jobs still in flight, newest first — the dynamic-context roster.
   *  `limit` bounds the returned page; `total` is the TRUE running count, so a
   *  renderer can state its elision honestly even when the page was cut. */
  listRunning(limit = 20): ActiveRoster<BackgroundJob> {
    const items = this.sql<Row>`SELECT id, kind, label, work_mode, status, result, error, created_at, settled_at, epoch, resume_attempts, attempt_started_at
      FROM background_jobs WHERE status='running' ORDER BY created_at DESC LIMIT ${limit}`.map(toJob);
    return { items, total: this.countRunning() };
  }
}
