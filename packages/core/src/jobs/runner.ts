// BackgroundJobRunner: backend-agnostic lifecycle for auto-detached tool calls. Keeps the
// work alive in a platform-supplied durable fiber and wakes the agent via Inbox.send.

import type { Schedule } from '../types/primitives';
import type { AgentSignal, AgentInbox, SignalUndeliveredReason } from '../types/signals';
import type { EventLog } from '../events/hub/log';
import { BACKGROUND_POLICY, type BackgroundPolicy, type DetachOutcome, type ThresholdDeps } from './threshold';
import { REAL_CLOCK } from '../types/clock';
import type { DeviceRequestOwnership } from './device-ownership';
import { BackgroundJobStore, serializeJobResult, type BackgroundJob } from './store';
import { nanoid } from '../utils/nanoid';
import { runWorkModeInvocation } from '../execution/work-mode';
import { recoveryBackoffMs } from '../utils/recovery-backoff';
import type { WorkMode } from '../types/turn';
import * as v from 'valibot';
import { parseJsonValue, type JsonValue } from '../utils/json';
import { classify, diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/** Stamped by Kinu: `do.evict.no_signal` means the platform delivers no eviction notice. */
const EVICTION_INTERRUPT_ERROR = 'interrupted by Durable Object eviction before completion';

/** Shared with each backend's fiber-recovery hook, which matches on it. */
export const BACKGROUND_FIBER_PREFIX = 'bg:';

/**
 * Identity of one job's settle announcement. Recovery re-delivers wakes (at-least-once), so this
 * key dedupes both the retry breadcrumb's `trigger_id` and the queued turn's `idempotencyKey`.
 */
export function backgroundJobWakeTrigger(jobId: string): string {
  return `background-job-wake:${jobId}`;
}

/** Thrown by a resumer for a kind unsafe to re-drive (e.g. `shell`/`eval`). */
export class JobNotResumable extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`background job kind "${kind}" is not resumable`);
    this.name = 'JobNotResumable';
    this.kind = kind;
  }
}

/** Re-drives an evicted job from its checkpoint; throw `JobNotResumable` to fall back to failing. */
export type JobResumer = (
  kind: string,
  input: JsonValue,
  mode: WorkMode,
  signal: AbortSignal,
) => Promise<JsonValue | undefined>;

/** Partial results for a job that will not be driven again; null for side-effecting kinds. */
export type JobHarvester = (
  kind: string,
  input: JsonValue,
) => Promise<JsonValue | null>;

/** `deferred` (will continue; keep its fork run) differs from `none` (retire it). */
type JobRecoveryOutcome =
  | { readonly state: 'redriven'; readonly job: BackgroundJob }
  | { readonly state: 'deferred'; readonly job: BackgroundJob }
  | { readonly state: 'none' };

/** Each detached job is a live process tree; past the cap the detach is refused and cancelled. */
export const MAX_CONCURRENT_DETACHED_JOBS = 8;

export interface BackgroundRetryRequest {
  readonly sourceId: string;
  readonly kind: string;
  readonly input: JsonValue;
  readonly mode: WorkMode;
  readonly controller: AbortController;
}

interface DetachRequest {
  readonly kind: string;
  readonly input: JsonValue;
  readonly mode: WorkMode;
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  readonly ownership?: DeviceRequestOwnership;
}

export interface BackgroundJobRunnerDeps {
  store: BackgroundJobStore;
  /** Resolved per read: one runner can serve watched and unwatched surfaces. Defaults to interactive. */
  policy?: () => BackgroundPolicy;
  fiber: Schedule['fiber'];
  inbox: AgentInbox;
  /** Durable wake retry plane; both or neither. Absent for agents with no later activation (swarm nodes). */
  eventLog?: EventLog;
  scheduleDrain?: () => void;
  logActivity?(event: string, detail?: string): void;
  /** Fires once per settle, before the wake turn. Never throws into the fiber. */
  onSettled?(job: BackgroundJob): void;
  /** Transfer requests issued before the threshold to the job's identity. A throw may follow a partial
   *  move. null: no separately owned remote requests. */
  onDetached?: ((jobId: string, requestIds: readonly string[]) => Promise<void> | void) | null;
  /** Throw to refuse the cancel, leaving the job running and retryable. */
  onCancelled?: ((jobId: string) => Promise<void> | void) | null;
  /** Absent: evicted running jobs are failed. */
  resume?: JobResumer;
  /** Absent: bounded terminals settle with nothing. Never throws into the fiber. */
  harvest?: JobHarvester;
  /** Wake at `atMs` to retry a deferred attempt; absent when no later activation exists. */
  scheduleResume?: (atMs: number) => Promise<void> | void;
}

/** Short label derived from tool input, truncated like other debug summaries. */
const SearchJobInputSchema = v.object({ task: v.string() });

const RunJobInputSchema = v.object({ command: v.string(), runtime: v.optional(v.string()) });

const ExecuteJobInputSchema = v.object({ code: v.string() });

function describeJobInput(kind: string, input: JsonValue): string | undefined {
  if (kind === 'agents') {
    const parsed = v.safeParse(SearchJobInputSchema, input);

    if (parsed.success) {
      return `search: ${parsed.output.task.slice(0, 80)}`;
    }
  }

  if (kind === 'shell') {
    const parsed = v.safeParse(RunJobInputSchema, input);

    if (parsed.success) {
      const runtime = parsed.output.runtime ? `${parsed.output.runtime}: ` : '';

      return `${runtime}${parsed.output.command.slice(0, 80)}`;
    }
  }

  if (kind === 'eval') {
    const parsed = v.safeParse(ExecuteJobInputSchema, input);

    if (parsed.success) return parsed.output.code.trim().slice(0, 80);
  }

  return undefined;
}

/** Wake text differs by outcome because the agent's next action does. */
function wakeText(job: BackgroundJob): string {
  const generation = job.resumeAttempts > 0
    ? ` (generation ${String(job.resumeAttempts + 1)} — it was interrupted and re-driven)`
    : '';

  if (job.status === 'completed') {
    return `Background ${job.kind} job ${job.id} completed${generation}. Read the full result with `
      + `agent.jobResult('${job.id}'), then synthesize it / continue the work you backgrounded. `
      + `The result says whether it is COMPLETE or PARTIAL — say which when you report it.`;
  }

  // Cancelled: no result will arrive, and the agent was told to wait for one.
  if (job.status === 'cancelled') {
    return `Background ${job.kind} job ${job.id} was CANCELLED by the operator and is no longer `
      + `running. There is no result to collect. Re-run that work if you still need it, or `
      + `continue without it and say what is missing.`;
  }

  const detail = job.error === null || job.error === '' ? '' : ` (${job.error})`;

  // A failed search is continued, never re-spawned (retrying spawns a duplicate tree).
  if (job.kind === 'agents') {
    return `Background ${job.kind} job ${job.id} failed${generation}${detail}. Report the failure `
      + `and what it cost. Do not re-spawn the same work: a search keeps its tree, so a genuine `
      + `retry continues that one rather than starting another, and an identical spawn is refused.`;
  }

  return `Background ${job.kind} job ${job.id} failed${generation}${detail}. This is yours to fix: `
    + `read the error, change what it names, and run the command again. Report what was wrong and `
    + `what you changed.`;
}

export class BackgroundJobRunner {
  /** In-memory: eviction loses them, and recover() fails the orphan. */
  private readonly controllers = new Map<string, AbortController>();

  private readonly fiberDrivers = new Map<string, Promise<void>>();

  /**
   * Cancels in flight, fencing the settle path until external teardown is confirmed. In-memory by
   * design. A fenced outcome is replayed if the cancel is refused, dropped if it succeeds.
   */
  private readonly cancelling = new Set<string>();
  private readonly fenced = new Map<string, () => Promise<void>>();

  constructor(private readonly deps: BackgroundJobRunnerDeps) {}

  /** Pure: callers log their own lifecycle event. */
  create(kind: string, input: JsonValue, mode: WorkMode, controller: AbortController): string {
    const id = `bgjob-${nanoid()}`;
    this.deps.store.create({
      id, kind, workMode: mode, input: serializeJobResult({ value: input }), now: Date.now(),
      label: describeJobInput(kind, input),
    });
    this.controllers.set(id, controller);

    return id;
  }

  /** Null means another retry already owns the source row. */
  createRetry(request: BackgroundRetryRequest): string | null {
    const id = `bgjob-${nanoid()}`;

    const created = this.deps.store.createRetry({
      sourceId: request.sourceId,
      id,
      kind: request.kind,
      workMode: request.mode,
      input: serializeJobResult({ value: request.input }),
      now: Date.now(),
      label: describeJobInput(request.kind, request.input),
    });

    if (!created) return null;
    this.controllers.set(id, request.controller);

    return id;
  }

  get policy(): BackgroundPolicy {
    return this.deps.policy?.() ?? BACKGROUND_POLICY.interactive;
  }

  /** Jobs this runner drives; not the store count, which is shared across runners in the workspace. */
  get inFlight(): number {
    return this.controllers.size;
  }

  /** If the cap is full, the promise stays foreground-owned. A detach drains `ownership` so later
   *  requests register under the job directly. */
  thresholdDeps(
    input: JsonValue,
    mode: WorkMode,
    controller: AbortController,
    ownership?: DeviceRequestOwnership,
  ): ThresholdDeps {
    return {
      thresholdMs: this.policy.detachAfterMs,
      clock: REAL_CLOCK,
      onThreshold: async (kind, promise) =>
        await this.onThreshold({ kind, input, mode, controller, promise, ownership }),
    };
  }

  private async onThreshold(request: DetachRequest): Promise<DetachOutcome> {
    const { kind, input, mode, controller, promise, ownership } = request;
    const running = this.liveDetachedCount();

    if (running >= MAX_CONCURRENT_DETACHED_JOBS) {
      this.deps.logActivity?.('bg_job_refused', `${kind} — ${running} jobs already running`);

      return { detached: false, reason: 'too many jobs already running' };
    }

    const jobId = this.create(kind, input, mode, controller);
    this.deps.logActivity?.('bg_job_started', `${kind} → ${jobId}`);
    await this.beginDetachedWork(jobId, kind, promise, ownership);

    return { detached: true, jobId };
  }

  /**
   * Live detached work for the cap: excludes deferred jobs this runner is not driving (no process
   * tree). Exact because one workspace has one driver.
   */
  private liveDetachedCount(): number {
    const owed = this.deps.store.resumeOwedIdsInWorkspace(Date.now());
    let idle = 0;

    for (const jobId of owed) if (!this.controllers.has(jobId)) idle++;

    return this.deps.store.countRunningInWorkspace() - idle;
  }

  /** A failed transfer may have moved a prefix, so the job keeps its claim rather than aborting. */
  private async beginDetachedWork<T>(
    jobId: string,
    kind: string,
    promise: Promise<T>,
    ownership?: DeviceRequestOwnership,
  ): Promise<void> {
    // Drained before awaiting the transfer so no request id falls between the two.
    const requestIds = ownership?.drain(jobId) ?? [];

    try {
      await this.deps.onDetached?.(jobId, requestIds);
    } catch (err) {
      this.deps.logActivity?.(
        'bg_job_transfer_failed',
        `${kind} → ${jobId}; external-work transfer was not confirmed — ${renderThrownChain({ cause: err })}`,
      );
    }

    this.detach(jobId, kind, promise);
  }

  /** Settle-vs-fail depends only on resolution; a non-serializable success is not a failure. */
  detach<T>(jobId: string, kind: string, promise: Promise<T>): void {
    this.runToSettlement(jobId, kind, () => promise);
  }

  /** Lease epoch read at fiber start fences executors a concurrent reclaim replaced (§5.3). */
  private runToSettlement<T>(jobId: string, kind: string, exec: () => Promise<T>): void {
    let driver: Promise<void> | undefined;

    const drive = async (): Promise<void> => {
      try {
        await this.deps.fiber(`${BACKGROUND_FIBER_PREFIX}${kind}`, async (ctx) => {
          ctx.stash({ phase: 'running', jobId, kind });
          let settled: boolean;

          try {
            await this.settleAndWake(jobId, exec);
            // A fenced write is a no-op (§5.3), so the store decides whether the job settled.
            settled = this.deps.store.get(jobId)?.status !== 'running';
          } catch (err) {
            // Must not reject: both fiber implementations delete their recovery row in `finally`.
            diagnostics.failure(
              'jobs.settlement_failed',
              toKinuError({ doing: 'settle a background job and wake the agent', cause: err, otherwise: 'io' }),
              { jobId },
            );
            settled = this.failUnsettled(jobId, { cause: err });
          }

          ctx.stash({ phase: settled ? 'settled' : 'running', jobId, kind });
        });
      } catch (cause) {
        diagnostics.failure(
          'jobs.fiber_start_failed',
          toKinuError({ doing: 'run the durable fiber for a background job', cause, otherwise: 'io' }),
          { jobId, kind },
        );

        try {
          if (this.deps.store.get(jobId)?.status === 'running') {
            await this.settleAndWake(jobId, async () => { throw cause; });
          }
        } catch (err) {
          diagnostics.failure(
            'jobs.settlement_failed',
            toKinuError({ doing: 'settle a background job and wake the agent', cause: err, otherwise: 'io' }),
            { jobId },
          );
          this.failUnsettled(jobId, { cause: err });
        }
      } finally {
        if (driver && this.fiberDrivers.get(jobId) === driver) this.fiberDrivers.delete(jobId);
      }
    };

    driver = drive();
    this.fiberDrivers.set(jobId, driver);
  }

  /** Throws only when a store write or the durable retry breadcrumb fails. */
  private async settleAndWake<T>(jobId: string, exec: () => Promise<T>): Promise<void> {
    const job = this.deps.store.get(jobId);

    if (job === null) throw new Error('Cannot execute a background job with no durable authority record');
    const epoch = job.epoch;

    type Recorded =
      | { readonly kind: 'settled'; readonly result: T }
      | { readonly kind: 'failed'; readonly error: string }
      | { readonly kind: 'bounded'; readonly why: string };

    let outcome: Recorded;

    try { outcome = { kind: 'settled', result: await runWorkModeInvocation(job.workMode, exec) }; }
    catch (err) {
      outcome = err instanceof JobNotResumable
        ? { kind: 'bounded', why: 'this kind cannot be re-driven from a durable checkpoint' }
        : { kind: 'failed', error: renderThrownChain({ cause: err }) };
    }

    this.controllers.delete(jobId);

    // Already cancelled: do not relabel the abort as a failure.
    if (this.deps.store.get(jobId)?.status === 'cancelled') return;

    const record = async (): Promise<void> => {
      if (outcome.kind === 'bounded') {
        await this.settleBounded(jobId, epoch, outcome.why);

        return;
      }

      if (outcome.kind === 'settled') this.deps.store.settle(jobId, epoch, serializeJobResult({ value: outcome.result }), Date.now());
      else this.deps.store.fail(jobId, epoch, outcome.error, Date.now());
      this.deps.logActivity?.('bg_job_settled',
        outcome.kind === 'settled' ? `${jobId} completed` : `${jobId} failed — ${outcome.error}`);
      this.notifySettled(jobId);
      await this.wake(jobId);
    };

    // A cancel in flight decides the terminal row; hold the outcome for it.
    if (this.cancelling.has(jobId)) {
      this.fenced.set(jobId, record);

      return;
    }

    await record();
  }

  /** `completed` when the harvest yields something, `failed` only when there is nothing. */
  private async settleBounded(jobId: string, epoch: number, why: string): Promise<void> {
    const job = this.deps.store.get(jobId);
    const harvested = job ? await this.harvestOf(job) : { ok: true, value: null } as const;
    const now = Date.now();

    if (!harvested.ok) {
      this.deps.store.fail(jobId, epoch, `${EVICTION_INTERRUPT_ERROR} — ${why}, and reading `
        + `what it had produced failed: ${harvested.error}`, now);
      this.deps.logActivity?.('bg_job_bounded', `${jobId} failed unreadable — ${why}`);
    } else if (harvested.value === null) {
      this.deps.store.fail(jobId, epoch, `${EVICTION_INTERRUPT_ERROR} — ${why}, and it had `
        + 'produced no partial result to hand back', now);
      this.deps.logActivity?.('bg_job_bounded', `${jobId} failed empty — ${why}`);
    } else {
      this.deps.store.settle(jobId, epoch, serializeJobResult({ value: {
        partial: true,
        why: `This result is PARTIAL: ${why}. It is what the work had completed, not a `
          + 'finished answer — say so if you use it.',
        generation: (job?.resumeAttempts ?? 0) + 1,
        result: harvested.value,
      } }), now);
      this.deps.logActivity?.('bg_job_bounded', `${jobId} settled partial — ${why}`);
    }

    this.notifySettled(jobId);
    await this.wake(jobId);
  }

  /** Never throws: a failed harvest must not stop the job settling, nor read as "nothing". */
  private async harvestOf(job: BackgroundJob): Promise<
    { ok: true; value: JsonValue | null } | { ok: false; error: string }
  > {
    const harvest = this.deps.harvest;

    if (!harvest) return { ok: true, value: null };
    const input = this.storedInput(job.id);

    try {
      return { ok: true, value: await harvest(job.kind, input) };
    } catch (err) {
      diagnostics.failure(
        'jobs.harvest_failed',
        toKinuError({ doing: 'read what a bounded-out background job already produced', cause: err, otherwise: 'io' }),
        { jobId: job.id, kind: job.kind },
      );

      return { ok: false, error: renderThrownChain({ cause: err }) };
    }
  }

  /** Last-resort terminal write; keeps an already-recorded outcome and attempts no wake. */
  private failUnsettled(jobId: string, thrown: { cause: unknown }): boolean {
    if (this.cancelling.has(jobId)) return false;

    try {
      const job = this.deps.store.get(jobId);

      if (!job || job.status !== 'running') return true;
      this.deps.store.fail(jobId, job.epoch, renderThrownChain(thrown), Date.now());
      this.notifySettled(jobId);

      return true;
    } catch (failErr) {
      diagnostics.failure(
        'jobs.force_fail_failed',
        toKinuError({ doing: 'force-fail a job the settlement path left running', cause: failErr, otherwise: 'io' }),
        { jobId },
      );

      return false;
    }
  }

  /** Safe to repeat: {@link backgroundJobWakeTrigger} dedupes re-deliveries to one message. */
  async wake(jobId: string): Promise<void> {
    const job = this.deps.store.get(jobId);

    if (!job) return;
    const text = wakeText(job);

    const base = {
      kind: 'background_job',
      text,
      idempotencyKey: backgroundJobWakeTrigger(jobId),
      metadata: { kinuMode: job.workMode, jobId, kind: job.kind, status: job.status },
    } as const satisfies Omit<AgentSignal, 'compensate'>;

    // `compensate` is offered only with a durable retry plane behind it.
    const retry = this.publishWakeRetryIfDurable(job, text);
    await this.deps.inbox.send(retry ? { ...base, compensate: retry } : base);
  }

  private publishWakeRetryIfDurable(
    job: BackgroundJob, text: string,
  ): ((reason: SignalUndeliveredReason) => void) | null {
    const eventLog = this.deps.eventLog;
    const scheduleDrain = this.deps.scheduleDrain;

    if (!eventLog || !scheduleDrain) return null;

    return (reason) => {
      if (reason === 'preempted') {
        this.deps.logActivity?.('bg_job_wake_skipped', `${job.id} (${job.status}) — wake preempted; result retained`);
      }

      this.publishWakeRetry(eventLog, scheduleDrain, job, text);
    };
  }

  private publishWakeRetry(
    eventLog: EventLog, scheduleDrain: () => void, job: BackgroundJob, text: string,
  ): void {
    try {
      eventLog.publish({
        descriptor: {
          ingress: 'timer_alarm',
          variant: 'timer',
          payload: {
            trigger_id: backgroundJobWakeTrigger(job.id),
            scheduled_fire_at: job.settledAt ?? job.createdAt,
            label: text,
            user_payload: {
              kinuEvent: 'background_job', kinuMode: job.workMode,
              jobId: job.id, kind: job.kind, status: job.status,
            },
          },
          trigger_creator_trust: 'self',
        },
        now: Date.now(),
      });
    } catch (err) {
      diagnostics.failure(
        'jobs.retry_publish_failed',
        toKinuError({ doing: 'publish the background-job wake retry', cause: err, otherwise: 'io' }),
        { jobId: job.id, kind: job.kind },
      );
      throw err;
    }

    try { scheduleDrain(); }
    catch (err) {
      diagnostics.failure(
        'jobs.retry_drain_schedule_failed',
        toKinuError({ doing: 'schedule the drain for a background-job wake retry', cause: err, otherwise: 'io' }),
        { jobId: job.id },
      );
    }
  }

  /** Abort, mark cancelled, and wake the agent, which was told to wait for this result. */
  async cancel(jobId: string): Promise<boolean> {
    if (this.deps.store.get(jobId)?.status !== 'running') return false;

    if (this.cancelling.has(jobId)) return false;
    this.cancelling.add(jobId);
    let refusal: { readonly error: unknown } | undefined;

    try {
      // External owner confirms first so a refused device cancel stays retryable.
      await this.deps.onCancelled?.(jobId);
    } catch (err) {
      refusal = { error: err };
    } finally {
      // Everything below is synchronous up to the wake, so settle cannot interleave.
      this.cancelling.delete(jobId);
    }

    const held = this.fenced.get(jobId);
    this.fenced.delete(jobId);

    if (refusal) {
      diagnostics.failure('jobs.external_cancel_failed', toKinuError({
        doing: 'cancel external work transferred to a background job', cause: refusal.error, otherwise: 'unavailable',
      }), { jobId });

      if (held) await held();

      return false;
    }

    if (!this.settleCancelled(jobId)) return false;
    await this.wake(jobId);

    return true;
  }

  /**
   * Stop: cancel this runner's jobs without a wake (a wake would restart stopped work). Scoped to
   * `controllers`: the store is shared, and orphaned rows belong to `recoverOrphans()`.
   */
  cancelRunning(): string[] {
    const cancelled: string[] = [];

    // Deleting the current key during Map iteration is allowed.
    for (const jobId of this.controllers.keys()) {
      if (this.settleCancelled(jobId)) cancelled.push(jobId);
    }

    return cancelled;
  }

  private settleCancelled(jobId: string): boolean {
    const job = this.deps.store.get(jobId);

    if (!job || job.status !== 'running') return false;
    this.deps.store.cancel(jobId, job.epoch, Date.now());
    const controller = this.controllers.get(jobId);

    if (controller) controller.abort(new Error('cancelled by operator'));
    this.controllers.delete(jobId);
    this.deps.logActivity?.('bg_job_cancelled', jobId);

    return true;
  }

  /** Returns the job only if this call re-drove it. */
  async recover(snapshot: JsonValue): Promise<BackgroundJob | null> {
    const parsed = v.safeParse(v.object({ jobId: v.string(), phase: v.literal('running') }), snapshot);

    if (!parsed.success) return null;
    const outcome = await this.recoverJob(parsed.output.jobId);

    return outcome.state === 'redriven' ? outcome.job : null;
  }

  /**
   * Start-of-life sweep: every `running` row is an orphan. Never gives up; the bound is pace.
   * Returns jobs in flight, including already-driving and deferred ones, because
   * `jobRedriveResumeGate` retires the fork run of any job absent from the set.
   */
  async recoverOrphans(): Promise<readonly BackgroundJob[]> {
    const inFlight = new Set<string>();

    for (const jobId of this.deps.store.runningIds()) {
      const outcome = await this.recoverJob(jobId);

      if (outcome.state === 'deferred') inFlight.add(jobId);
    }

    for (const jobId of this.controllers.keys()) inFlight.add(jobId);

    return [...inFlight]
      .map((jobId) => this.deps.store.get(jobId))
      .filter((job): job is BackgroundJob => job !== null && job !== undefined);
  }

  nextResumeAt(): number | null {
    return this.deps.store.nextResumeAtInWorkspace();
  }

  /** Timer entry: one MIN read; re-arms a not-yet-due attempt, since its schedule row can be lost. */
  async recoverDueResumes(): Promise<void> {
    const next = this.deps.store.nextResumeAtInWorkspace();

    if (next === null) return;

    if (next > Date.now()) {
      await this.deps.scheduleResume?.(next);

      return;
    }

    await this.recoverOrphans();
  }

  /**
   * Settle, re-drive, or pace one orphan. Interruptions are not failures: attempts are unbounded,
   * paced by {@link recoveryBackoffMs}. No wall clock: eviction time is not work time.
   */
  private async recoverJob(jobId: string): Promise<JobRecoveryOutcome> {
    if (this.controllers.has(jobId)) return { state: 'none' };
    const job = this.deps.store.get(jobId);

    if (!job || job.status === 'cancelled') return { state: 'none' };

    // Already settled: only re-deliver the lost wake.
    if (job.status !== 'running') {
      await this.wake(jobId);

      return { state: 'none' };
    }

    if (this.deps.resume) {
      const now = Date.now();

      if (job.resumeAfter !== null && job.resumeAfter > now) {
        return await this.deferRecovery(job, job.resumeAfter);
      }

      const claim = this.deps.store.reclaim(jobId, now);

      if (!claim) return { state: 'none' }; // lost the race — another activation reclaimed it
      // Armed before the drive: an eviction during it cannot write the wait afterwards.
      this.deps.store.deferResume(jobId, now + recoveryBackoffMs(claim.attempts - 1));
      this.deps.logActivity?.('bg_job_resume', `${job.kind} → ${jobId} (attempt ${claim.attempts}, epoch ${claim.epoch})`);
      this.driveResume(job, this.deps.resume);

      return { state: 'redriven', job };
    }

    await this.settleBounded(jobId, job.epoch, 'its executor was lost and this kind cannot be re-driven');

    return { state: 'none' };
  }

  /** Re-arm the wake on every sweep (the schedule row can be lost) and announce the deferral. */
  private async deferRecovery(job: BackgroundJob, at: number): Promise<JobRecoveryOutcome> {
    const delayMs = at - Date.now();
    diagnostics.event('jobs.resume_deferred', {
      jobId: job.id, kind: job.kind, attempts: job.resumeAttempts, delayMs, resumeAfter: at,
    });
    this.deps.logActivity?.(
      'bg_job_resume_deferred',
      `${job.kind} → ${job.id} was interrupted ${String(job.resumeAttempts)} time(s); `
      + `next attempt in ${String(Math.ceil(delayMs / 1000))}s`,
    );
    await this.deps.scheduleResume?.(at);

    return { state: 'deferred', job };
  }

  /** Input is read inside the attempt so an unreadable row fails through the settlement path. */
  private driveResume(job: BackgroundJob, resume: JobResumer): void {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.runToSettlement(job.id, job.kind, () => resume(job.kind, this.storedInput(job.id), job.workMode, controller.signal));
  }

  private storedInput(jobId: string): JsonValue {
    const raw = this.deps.store.getInput(jobId);

    if (raw === null) return null;

    try { return parseJsonValue(raw); }
    catch (error) {
      if (classify({ cause: error }) !== 'malformed-input') throw error;

      return raw;
    }
  }

  /** Sink errors must not reach the fiber or recovery path. */
  private notifySettled(jobId: string): void {
    if (!this.deps.onSettled) return;
    const job = this.deps.store.get(jobId);

    if (!job) return;

    try { this.deps.onSettled(job); }
    catch (err) {
      diagnostics.failure(
        'jobs.settle_sink_failed',
        toKinuError({ doing: 'deliver the job settle notification', cause: err, otherwise: 'io' }),
        { jobId },
      );
    }
  }
}
