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
//
// OWNERSHIP IS SPLIT, AND THE INTERFACE SAYS WHICH HALF EVERY READ IS IN.
// A job ROW belongs to the actor that detached it: its roster is carried into
// that actor's model steps, `clearSettled` is that actor's history, and an id
// alone is not authority to settle a sibling's work. But `runner.ts` states the
// other half in source — "every detached job is a live process tree whichever
// agent launched it" — so the concurrency cap and the wake instant are
// questions about the MACHINE. Those four carry `InWorkspace` in their names:
// narrowing the cap would let N actors each open MAX_CONCURRENT_DETACHED_JOBS
// process trees, and widening a roster would render a sibling's jobs into this
// actor's prompt. The recovery sweep {@link BackgroundJobStore.runningIds} is
// the actor's, because a sweep can only act through the point operations above
// it and those are the actor's: a foreign id would be swept, refused, and then
// reported to the resume gate as work nothing will continue.

import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../state/actor-handle';
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
  /**
   * The instant before which this job's NEXT attempt must not start, or null
   * when nothing is owed.
   *
   * Written FORWARD, at claim time, for the attempt after the one being
   * claimed — because the event it paces is unobservable by the process it
   * kills. An isolate evicted mid-attempt writes nothing, so a pause recorded
   * after a failure would never be recorded at all; the claim is the last
   * moment anything can still speak for the attempt it is starting.
   *
   * So a live attempt carries one too, and that is not a contradiction: it says
   * "if I am still `running` after this instant, whoever finds me may drive me
   * again". A settle clears the question by ending the job, and the next
   * {@link BackgroundJobStore.reclaim} clears the column.
   */
  resumeAfter: number | null;
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
    // `created_at` is the honest reading when no attempt start was recorded:
    // its first attempt is the only one anything recorded.
    attemptStartedAt: r.attempt_started_at ?? r.created_at,
    // Null for every job that has never been interrupted: nothing is owed,
    // so nothing is waited on.
    resumeAfter: r.resume_after ?? null,
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
  // Status alone still has to be answerable: the cap and the wake instant are
  // workspace-wide questions, so the host half keeps a status-leading path
  // while the actor half gets one that starts at the owner.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_background_jobs_actor_status ON background_jobs(actor_id, status, created_at DESC)`);
  // The retry edge is one-per-source WITHIN an owner: a retry claims a job this
  // actor owns, and a table-wide unique index would let one actor's retry of
  // its own `job-1` block another actor's retry of its own.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_retry_of
    ON background_jobs(actor_id, retry_of) WHERE retry_of IS NOT NULL`);
}

export class BackgroundJobStore {
  private readonly actorId: string;

  /** Bind the registry to ONE actor. `actorId` is captured from the handle once
   *  and `assertCurrent()` runs before every statement, including the
   *  workspace-wide reads: those answer a machine question, but only a live
   *  actor is entitled to ask it. */
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  create(opts: { id: string; kind: string; workMode: WorkMode; label?: string; input?: string; now: number }): void {
    this.actor.assertCurrent();
    void this.sql`INSERT OR IGNORE INTO background_jobs (actor_id, id, kind, label, work_mode, status, input_json, epoch, resume_attempts, created_at, attempt_started_at)
      VALUES (${this.actorId}, ${opts.id}, ${opts.kind}, ${opts.label ?? null}, ${opts.workMode}, 'running', ${opts.input ?? null}, 0, 0, ${opts.now}, ${opts.now})`;
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

  /** Mark a running job completed. No-op if already settled (idempotent wake) or
   *  if `epoch` is stale — i.e. a zombie executor from a dead process fenced by a
   *  reclaim that already bumped the epoch (§5.3). */
  settle(id: string, epoch: number, result: string, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs SET status='completed', result=${result}, settled_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Mark a running job failed. No-op if already settled or the epoch is stale. */
  fail(id: string, epoch: number, error: string, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs SET status='failed', error=${error}, settled_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Mark a running job cancelled (operator hard-cancel). No-op if settled or the
   *  epoch is stale. */
  cancel(id: string, epoch: number, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs SET status='cancelled', error='cancelled by operator', settled_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running' AND epoch=${epoch}`;
  }

  /** Claim a still-running job for an evict-recovery re-drive: bump the lease
   *  epoch (fencing any executor still holding the old one), the resume-attempt
   *  counter and the attempt clock, atomically. Returns the new epoch + attempt
   *  count, or null when the job is no longer running (already settled/cancelled,
   *  or gone).
   *
   *  `attempt_started_at` moves with the epoch because they name the same event: a
   *  new lease IS a new generation, and a generation with no start time is one
   *  nothing can bound.
   *
   *  `resume_after` is CLEARED for the same reason it exists: it paced the attempt
   *  this claim just started, and a wait that has been served is not still owed.
   *  The claimer arms the next one through {@link deferResume}. */
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

  /**
   * Arm the instant before which this job's next attempt must not start.
   *
   * Only over a `running` row: a settled job is owed nothing, and a wait written
   * onto one would be read by the next sweep as work still to come.
   *
   * The value is absolute rather than a duration, so it survives the process that
   * wrote it. That is the whole point of the column — the isolate that would have
   * counted a duration down is the one the eviction kills.
   */
  deferResume(id: string, at: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE background_jobs SET resume_after=${at}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='running'`;
  }

  /**
   * The soonest armed instant across every running job in the WORKSPACE that has
   * one, or null when nothing is waiting. One indexed MIN, for a caller deciding
   * whether a wake is owed at all before it sweeps the registry.
   *
   * Workspace-wide because the host arms ONE timer. Narrowed to this actor it
   * would arm for this actor's soonest job and sleep through a sibling's earlier
   * one, and the sibling has no timer of its own to fall back on.
   */
  nextResumeAtInWorkspace(): number | null {
    this.actor.assertCurrent();
    const rows = this.sql<{ at: number | null }>`SELECT MIN(resume_after) AS at
      FROM background_jobs WHERE status='running' AND resume_after IS NOT NULL`;
    return rows[0]?.at ?? null;
  }

  /**
   * Every running job in the WORKSPACE whose next attempt is not yet due at
   * `now` — the rows a reader must not assume are being worked on. Ids only: the
   * caller pairs them with what it knows is live in memory, which no row can say.
   *
   * Workspace-wide because it is the subtrahend of
   * {@link countRunningInWorkspace}: the cap counts every actor's live process
   * trees, so the discount for the ones nothing is driving has to count over the
   * same population or the difference is not a count of anything.
   */
  resumeOwedIdsInWorkspace(now: number): string[] {
    this.actor.assertCurrent();
    return this.sql<{ id: string }>`SELECT id FROM background_jobs
      WHERE status='running' AND resume_after IS NOT NULL AND resume_after > ${now}`
      .map((r) => r.id);
  }

  /** The current lease epoch of a job — captured by an executor at detach so its
   *  terminal write can carry it. Null when the job is absent, which is also the
   *  answer for a job id another actor owns. */
  epochOf(id: string): number | null {
    this.actor.assertCurrent();
    const rows = this.sql<{ epoch: number }>`SELECT epoch FROM background_jobs
      WHERE actor_id=${this.actorId} AND id=${id} LIMIT 1`;
    return rows[0]?.epoch ?? null;
  }

  /** Remove a settled job from the registry. No-op if still running. */
  dismiss(id: string): void {
    this.actor.assertCurrent();
    void this.sql`DELETE FROM background_jobs
      WHERE actor_id=${this.actorId} AND id=${id} AND status != 'running'`;
  }

  /**
   * Whether ANY job row in the WORKSPACE is still live — one LIMIT-1 read, for
   * the activation-time arm decision that must not materialize the registry.
   *
   * Workspace-wide for the same reason as {@link nextResumeAtInWorkspace}: the
   * decision it feeds is whether the HOST arms at all, and a host that skipped
   * arming because this actor happened to be idle would strand every sibling's
   * interrupted work until something else woke the workspace.
   */
  hasLiveJobsInWorkspace(): boolean {
    this.actor.assertCurrent();
    return this.sql<{ present: number }>`
      SELECT 1 AS present FROM background_jobs WHERE status = 'running' LIMIT 1`.length > 0;
  }

  /** Remove THIS actor's settled jobs. Running jobs are kept, and a sibling's
   *  history is not this actor's to discard. */
  clearSettled(): void {
    this.actor.assertCurrent();
    void this.sql`DELETE FROM background_jobs WHERE actor_id=${this.actorId} AND status != 'running'`;
  }

  /** The serialized tool input a job was created with — re-run source for retry. */
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

  /**
   * How many jobs are still in flight ACROSS THE WORKSPACE — the input to the
   * concurrent-detach cap. Counted in SQL rather than from {@link listRunning},
   * whose limit would silently under-report exactly when the cap matters.
   *
   * NOT narrowed to this actor, and `runner.ts` says why in source: "every
   * detached job is a live process tree whichever agent launched it". Per-actor,
   * N actors would each open MAX_CONCURRENT_DETACHED_JOBS trees and the machine
   * ceiling would be multiplied by the actor count.
   */
  countRunningInWorkspace(): number {
    this.actor.assertCurrent();
    const rows = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM background_jobs WHERE status='running'`;
    return rows[0]?.n ?? 0;
  }

  /**
   * THIS ACTOR's jobs still in flight, oldest first — the startup recovery
   * sweep's input. Deliberately unbounded, unlike {@link listRunning}: a display
   * limit that silently dropped rows would skip exactly the stuck jobs the sweep
   * exists to settle. Ids only — the sweep re-reads each row under its own claim.
   *
   * ACTOR-SCOPED, unlike the cap beside it, because a sweep can only act through
   * `reclaim`/`settle`/`get`, and those refuse an id this actor does not own. A
   * workspace-wide list here would hand the sweep ids it cannot claim, and the
   * resume gate reads absence from that sweep as "nothing will continue this" —
   * so a sibling's live fork would be retired underneath it. Each actor's runner
   * sweeps its own registry, which is exactly what a database per actor did.
   */
  runningIds(): string[] {
    this.actor.assertCurrent();
    return this.sql<{ id: string }>`SELECT id FROM background_jobs
      WHERE actor_id=${this.actorId} AND status='running' ORDER BY created_at ASC`.map((r) => r.id);
  }

  /** Only THIS actor's jobs still in flight, newest first — the dynamic-context
   *  roster. `limit` bounds the returned page; `total` is this actor's TRUE
   *  running count, so a renderer can state its elision honestly even when the
   *  page was cut. The workspace count is a different question and has a
   *  different name ({@link countRunningInWorkspace}); rendering it here would
   *  put a sibling's work in this actor's prompt. */
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
