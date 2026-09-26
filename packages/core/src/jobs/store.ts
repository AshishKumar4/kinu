// Background-job registry for detached tool work. `settle`/`fail` are guarded on status='running'
// and on a lease `epoch` that `reclaim` bumps, which fences zombie executors (agent-core SPEC §5.3 / §10.3).
// Rows are actor-owned; `*InWorkspace` reads are machine-wide (cap, wake instant) by contract.

import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { WorkMode } from '../types/turn';
import { renderThrownChain } from '../obs/index';
import type { ActiveRoster } from '../types/dynamic-context';
import type { BackgroundJob, BackgroundJobStatus } from '../types/jobs';

export type { BackgroundJob, BackgroundJobStatus } from '../types/jobs';

export function backgroundJobNotice(job: BackgroundJob) {
  return {
    subject: `Background ${job.kind} job ${job.status}`,
    body: job.status === 'completed'
      ? `Background ${job.kind} job ${job.id} completed.\n\nResult:\n${job.result ?? '(empty)'}`
      : `Background ${job.kind} job ${job.id} ${job.status}${job.error ? `:\n\n${job.error}` : '.'}`,
  };
}

export interface JobClaim {
  epoch: number;
  /** Re-drives so far (1 on the first recovery). */
  attempts: number;
}

interface Row {
  id: string; kind: string; label: string | null; status: string;
  work_mode: string;
  result: string | null; error: string | null; created_at: number; settled_at: number | null;
  epoch: number; resume_attempts: number; attempt_started_at: number | null; retried_by: string | null;
  resume_after: number | null;
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
    attemptStartedAt: r.attempt_started_at ?? r.created_at,
    resumeAfter: r.resume_after ?? null,
  };
}

/** Never throws. Stored whole: the wake promises the full result, and driveResume JSON.parses inputs. */
export function serializeJobResult(input: { value: unknown }): string {
  try { return JSON.stringify(input.value ?? null); }
  catch (error) {
    return `unserializable job result: ${renderThrownChain({ cause: error })}`;
  }
}

export function initBackgroundJobsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS background_jobs (
    actor_id    TEXT NOT NULL,
    id          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    label       TEXT,
    work_mode   TEXT NOT NULL DEFAULT 'build',
    status      TEXT NOT NULL DEFAULT 'running',
    result      TEXT,
    error       TEXT,
    input_json  TEXT,
    epoch       INTEGER NOT NULL DEFAULT 0,
    resume_attempts INTEGER NOT NULL DEFAULT 0,
    attempt_started_at INTEGER,
    resume_after INTEGER,
    retried_by TEXT,
    retry_of TEXT,
    created_at  INTEGER NOT NULL,
    settled_at  INTEGER,
    PRIMARY KEY (actor_id, id)
  )`);
  // Status-leading index serves workspace-wide reads; the actor index serves owned reads.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_background_jobs_actor_status ON background_jobs(actor_id, status, created_at DESC)`);
  // One retry per source within an owner; table-wide uniqueness would collide across actors' ids.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_retry_of
    ON background_jobs(actor_id, retry_of) WHERE retry_of IS NOT NULL`);
}

export class BackgroundJobStore {
  private readonly actorId: string;

  /** `assertCurrent()` runs before every statement, including workspace-wide reads. */
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  create(opts: { id: string; kind: string; workMode: WorkMode; label?: string; input?: string; now: number }): void {
    this.actor.assertCurrent();
    void this.sql`INSERT OR IGNORE INTO background_jobs (actor_id, id, kind, label, work_mode, status, input_json, epoch, resume_attempts, created_at, attempt_started_at)
      VALUES (${this.actorId}, ${opts.id}, ${opts.kind}, ${opts.label ?? null}, ${opts.workMode}, 'running', ${opts.input ?? null}, 0, 0, ${opts.now}, ${opts.now})`;
  }

  /** Create a replacement and claim its settled source in one statement; unique `retry_of` blocks a second. */
  createRetry(opts: {
    sourceId: string;
    id: string;
    kind: string;
    workMode: WorkMode;
    label?: string;
    input: string;
    now: number;
  }): boolean {
    this.actor.assertCurrent();
    void this.sql`INSERT OR IGNORE INTO background_jobs
      (actor_id, id, kind, label, work_mode, status, input_json, epoch, resume_attempts,
       created_at, attempt_started_at, retry_of)
      SELECT source.actor_id, ${opts.id}, ${opts.kind}, ${opts.label ?? null}, ${opts.workMode},
             'running', ${opts.input}, 0, 0, ${opts.now}, ${opts.now}, source.id
      FROM background_jobs source
      WHERE source.actor_id=${this.actorId} AND source.id=${opts.sourceId} AND source.status != 'running'
        AND NOT EXISTS (
          SELECT 1 FROM background_jobs replacement
          WHERE replacement.actor_id=source.actor_id AND replacement.retry_of=source.id
        )`;

    return this.sql<{ id: string }>`
      SELECT id FROM background_jobs WHERE actor_id=${this.actorId} AND id=${opts.id} LIMIT 1`.length === 1;
  }

  /** No-op if already settled or `epoch` is stale (§5.3). */
  settle(id: string, epoch: number, result: string, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs SET status='completed', result=${result}, settled_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running' AND epoch=${epoch}`;
  }

  fail(id: string, epoch: number, error: string, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs SET status='failed', error=${error}, settled_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running' AND epoch=${epoch}`;
  }

  cancel(id: string, epoch: number, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs SET status='cancelled', error='cancelled by operator', settled_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /**
   * Claim a running job for re-drive: atomically bump epoch, attempts and attempt clock, and clear the
   * served `resume_after`. Null when no longer running.
   */
  reclaim(id: string, now = Date.now()): JobClaim | null {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs
      SET epoch = epoch + 1, resume_attempts = resume_attempts + 1, attempt_started_at = ${now},
          resume_after = NULL
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running'`;

    const rows = this.sql<{ epoch: number; resume_attempts: number; status: string }>`
      SELECT epoch, resume_attempts, status FROM background_jobs
      WHERE actor_id=${this.actorId} AND id=${id} LIMIT 1`;

    const row = rows[0];

    if (!row || row.status !== 'running') return null;

    return { epoch: row.epoch, attempts: row.resume_attempts };
  }

  /** Earliest next-attempt instant; absolute so it survives eviction. Running rows only. */
  deferResume(id: string, at: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs SET resume_after=${at}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running'`;
  }

  /** Soonest armed instant across the workspace; the host arms one timer for every actor. */
  nextResumeAtInWorkspace(): number | null {
    this.actor.assertCurrent();

    const rows = this.sql<{ at: number | null }>`SELECT MIN(resume_after) AS at
      FROM background_jobs WHERE status='running' AND resume_after IS NOT NULL`;

    return rows[0]?.at ?? null;
  }

  /** Workspace running jobs not yet due at `now`; same population as {@link countRunningInWorkspace}. */
  resumeOwedIdsInWorkspace(now: number): string[] {
    this.actor.assertCurrent();

    return this.sql<{ id: string }>`SELECT id FROM background_jobs
      WHERE status='running' AND resume_after IS NOT NULL AND resume_after > ${now}`
      .map((r) => r.id);
  }

  /** Null when absent or owned by another actor. */
  epochOf(id: string): number | null {
    this.actor.assertCurrent();

    const rows = this.sql<{ epoch: number }>`SELECT epoch FROM background_jobs
      WHERE actor_id=${this.actorId} AND id=${id} LIMIT 1`;

    return rows[0]?.epoch ?? null;
  }

  dismiss(id: string): void {
    this.actor.assertCurrent();
    void this.sql`DELETE FROM background_jobs
      WHERE actor_id=${this.actorId} AND id=${id} AND status != 'running'`;
  }

  /** Any running job in the workspace with no `resume_after`; workspace-wide like {@link nextResumeAtInWorkspace}. */
  hasUntimedLiveJobsInWorkspace(): boolean {
    // `assertCurrent` validates the binding, not the scope; this read is workspace-wide.
    this.actor.assertCurrent();

    return this.sql<{ present: number }>`
      SELECT 1 AS present FROM background_jobs WHERE status = 'running' AND resume_after IS NULL LIMIT 1`.length > 0;
  }

  /** Remove this actor's settled jobs only. */
  clearSettled(): void {
    this.actor.assertCurrent();
    void this.sql`DELETE FROM background_jobs WHERE actor_id=${this.actorId} AND status != 'running'`;
  }

  /** Serialized tool input, the re-run source for retry. */
  getInput(id: string): string | null {
    this.actor.assertCurrent();

    const rows = this.sql<{ input_json: string | null }>`
      SELECT input_json FROM background_jobs WHERE actor_id=${this.actorId} AND id=${id} LIMIT 1`;

    return rows[0]?.input_json ?? null;
  }

  get(id: string): BackgroundJob | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`SELECT job.id, job.kind, job.label, job.work_mode,
      job.status, job.result, job.error, job.created_at, job.settled_at,
      job.epoch, job.resume_attempts, job.attempt_started_at, job.resume_after,
      COALESCE(job.retried_by, replacement.id) AS retried_by
      FROM background_jobs job
      LEFT JOIN background_jobs replacement
        ON replacement.actor_id=job.actor_id AND replacement.retry_of=job.id
      WHERE job.actor_id=${this.actorId} AND job.id=${id} LIMIT 1`;

    return rows[0] ? toJob(rows[0]) : null;
  }

  list(limit = 20): BackgroundJob[] {
    this.actor.assertCurrent();

    return this.sql<Row>`SELECT job.id, job.kind, job.label, job.work_mode,
      job.status, job.result, job.error, job.created_at, job.settled_at,
      job.epoch, job.resume_attempts, job.attempt_started_at, job.resume_after,
      COALESCE(job.retried_by, replacement.id) AS retried_by
      FROM background_jobs job
      LEFT JOIN background_jobs replacement
        ON replacement.actor_id=job.actor_id AND replacement.retry_of=job.id
      WHERE job.actor_id=${this.actorId}
      ORDER BY job.created_at DESC LIMIT ${limit}`.map(toJob);
  }

  /** Workspace-wide running count for the concurrent-detach cap; per-actor would multiply the machine ceiling. */
  countRunningInWorkspace(): number {
    this.actor.assertCurrent();
    const rows = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM background_jobs WHERE status='running'`;

    return rows[0]?.n ?? 0;
  }

  /**
   * This actor's running ids, oldest first, for the recovery sweep. Unbounded so no stuck job is skipped;
   * actor-scoped because the sweep can only claim owned ids.
   */
  runningIds(): string[] {
    this.actor.assertCurrent();

    return this.sql<{ id: string }>`SELECT id FROM background_jobs
      WHERE actor_id=${this.actorId} AND status='running' ORDER BY created_at ASC`.map((r) => r.id);
  }

  /** This actor's running jobs, newest first; `total` is the true count beyond `limit`. */
  listRunning(limit = 20): ActiveRoster<BackgroundJob> {
    this.actor.assertCurrent();

    const items = this.sql<Row>`SELECT id, kind, label, work_mode, status, result, error, created_at, settled_at, epoch, resume_attempts, attempt_started_at, resume_after, retried_by
      FROM background_jobs WHERE actor_id=${this.actorId} AND status='running'
      ORDER BY created_at DESC LIMIT ${limit}`.map(toJob);

    const total = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM background_jobs
      WHERE actor_id=${this.actorId} AND status='running'`[0]?.n ?? 0;

    return { items, total };
  }
}
