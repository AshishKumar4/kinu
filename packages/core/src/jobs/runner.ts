// BackgroundJobRunner — the backend-agnostic lifecycle for auto-detached >30s
// tool calls (think-heads, long execute_tools/run). Mints a job, keeps the
// in-flight promise alive in a durable fiber, settles/fails it, and wakes the
// agent with a synthesis signal — over the AgentRuntime fiber + the one
// signal-delivery seam.
//
// Hoisted out of the cf-backend OrchestratorAgent (re-arch P4) so the CLI gets
// background jobs for free. The platform supplies a durable `fiber` (CF:
// Agent.runFiber; CLI: createLinuxFiber); the wake is a plain
// SignalDelivery.deliver, so this never picks a delivery mechanism of its own.
// The @callable control-plane RPCs (jobResult/list/
// dismiss/clear/retry) stay on each backend and call BackgroundJobStore + here.

import type { Schedule } from '../types/primitives';
import type { SignalDeliverer } from '../types/signals';
import type { EventLog } from '../events/hub/log';
import { BACKGROUND_POLICY, type BackgroundPolicy, type DetachOutcome, type ThresholdDeps } from './threshold';
import { BackgroundJobStore, serializeJobResult, type BackgroundJob } from './store';
import { nanoid } from '../utils/nanoid';
import type { WorkMode } from '../prompting/surface';
import * as v from 'valibot';
import { parseJsonValue, type JsonValue } from '../utils/json';
import { diagnostics, toProteusError } from '../obs/index';

/** The terminal error a non-recoverable job records when it is interrupted by a
 *  DO eviction (no durable checkpoint / not safe to re-run).
 *
 *  Proteus stamps this itself because `do.evict.no_signal` says the platform
 *  delivers nothing: a `running` row with nothing in this isolate owning it IS
 *  an orphan, whatever became of the fiber, and that inference is the only
 *  evidence available. */
export const EVICTION_INTERRUPT_ERROR = 'interrupted by Durable Object eviction before completion';

/**
 * The identity of ONE job's settle announcement.
 *
 * Recovery is at-least-once by construction: `recoverOrphans` sweeps the
 * registry on every cold activation and `recover` replays every surviving
 * `bg:*` fiber row, so a job whose outcome was already persisted has its wake
 * re-delivered each time an activation starts — with no state it could write
 * back to stop itself, because the only thing left to record is that the agent
 * was told, and an activation that dies before recording it must still tell.
 *
 * So the write is made unable to duplicate instead. This one string names the
 * announcement on both rails that carry it — the durable retry breadcrumb's
 * `trigger_id` (whose EventLog dedupe key is derived from it) and the queued
 * turn's `idempotencyKey` (from which the backend derives the message id) — so
 * the two identities of one fact cannot drift apart.
 *
 * Keyed on the job and nothing else. A job has exactly one terminal status
 * (every settle path is guarded on `status`), so its announcement is unique
 * without the status in the key, and leaving it out means a re-delivery that
 * read the row a moment later still collides with the first.
 */
export function backgroundJobWakeTrigger(jobId: string): string {
  return `background-job-wake:${jobId}`;
}

/** Thrown by a resumer for a kind it cannot re-drive (e.g. `run`/`execute_tools`,
 *  whose partial side effects make blind re-execution unsafe). The runner treats
 *  it as "not resumable" → the job is failed with the eviction message, exactly
 *  as before this recovery path existed. A closed signal, not a bare Error. */
export class JobNotResumable extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`background job kind "${kind}" is not resumable`);
    this.name = 'JobNotResumable';
    this.kind = kind;
  }
}

/** Re-drives an evicted job from its durable checkpoint. Resolves with the same
 *  result shape the original tool call produced (settled onto the job), or throws
 *  — `JobNotResumable` to fall back to the fail path, any other error to fail with
 *  that message. Provided by the backend, which owns the tool/runtime wiring. */
export type JobResumer = (
  kind: string,
  input: JsonValue,
  mode: WorkMode,
  signal: AbortSignal,
) => Promise<JsonValue | undefined>;

/** Give up re-driving a job after this many evict-recovery attempts, so a job
 *  that evicts on every activation can't loop forever. MCTS makes monotonic
 *  progress (budget strictly decreases per resume) so it converges well within
 *  this; the cap only bounds pathological non-progressing kinds. */
const MAX_RESUME_ATTEMPTS = 5;

/**
 * Ceiling on jobs detached at once. Every detached job is a live process tree
 * the agent is no longer watching, and a model that sees no result from a slow
 * call reliably launches another: one benchmark trial forked 52 concurrent
 * `pystan` builds this way and took the whole container down with an OOM kill.
 * Past the cap the detach is refused and the work is cancelled, so the storm
 * cannot compound — the agent is told what is already running instead.
 */
export const MAX_CONCURRENT_DETACHED_JOBS = 8;

export interface BackgroundJobRunnerDeps {
  store: BackgroundJobStore;
  /** How long work may run before it detaches, and how long teardown waits on
   *  it — the surface's policy, resolved per read. A thunk because the surface
   *  is not always session-scoped: the CLI pins one policy per process, but a
   *  cf workspace DO serves human-watched web chat, one-shot `proteus exec`
   *  invocations, and unwatched email/timer/peer drains through the SAME
   *  runner, so only the turn in flight knows which it is. Read at threshold
   *  time. Defaults to the interactive policy. */
  policy?: () => BackgroundPolicy;
  /** Durable fiber — AgentRuntime.schedule.fiber. */
  fiber: Schedule['fiber'];
  /** The one signal-delivery seam — the wake at the end of a settled job. */
  signals: SignalDeliverer;
  /** Durable retry breadcrumb consumed by the standard event drain. */
  eventLog: EventLog;
  /** Existing ingress drain scheduler; called after publishing a retry event. */
  scheduleDrain(): void;
  /** Activity-log sink (optional). */
  logActivity?(event: string, detail?: string): void;
  /** Fires once per job settle (completed/failed), before the wake turn —
   *  the backend's notification seam (e.g. Mission Inbox owner emails).
   *  Never throws into the fiber. */
  onSettled?(job: BackgroundJob): void;
  /** Re-drive an evicted job from its durable checkpoint. When absent, an evicted
   *  running job is failed (legacy behavior); when present, the runner reclaims
   *  the job under a fresh lease epoch and re-drives it in a new durable fiber. */
  resume?: JobResumer;
}

/** What the model reads when a detach is refused. Honest about what happened to
 *  its call, and specific about the work already in flight, so the answer is
 *  "wait for these" rather than "try launching it again". */
function refusalMessage(kind: string, running: readonly BackgroundJob[]): string {
  const roster = running.map((j) => `${j.id} (${j.kind})`).join(', ');
  return (
    `The "${kind}" call needed to move to the background, but this workspace already has ` +
    `${running.length} background job(s) running — the maximum — so it was CANCELLED instead of ` +
    `being detached. Nothing was left running from this call. Already in flight: ${roster}. ` +
    `Wait for those to finish (you are woken as each one settles, and agent.jobResult('<id>') ` +
    `reads a settled one), or cancel the ones you no longer need, before starting more ` +
    `long-running work. Launching another copy will not make the running ones finish sooner.`
  );
}

/** A short, human-readable description of what a backgrounded call is
 *  actually doing — read straight off the tool input, duck-typed rather than
 *  importing each tool's own input type (this module stays generic over
 *  every backgroundable kind). This is what turns "bgjob-3z agents running"
 *  into something an operator can act on without decoding the stored
 *  input_json themselves; `BackgroundJob.label` already existed for exactly
 *  this and was never populated by the real runtime (only test fixtures set
 *  it directly on the store). Truncated to match the short-snippet
 *  convention every other debug summary line already uses (task.slice(0,60)
 *  for head runs, etc.) — this is a label, not a payload dump. */
const ForkJobInputSchema = v.object({ task: v.string() });
const RunJobInputSchema = v.object({ command: v.string(), runtime: v.optional(v.string()) });
const ExecuteJobInputSchema = v.object({ code: v.string() });

function describeJobInput<T>(kind: string, input: T): string | undefined {
  if (kind === 'agents') {
    const parsed = v.safeParse(ForkJobInputSchema, input);
    if (parsed.success) {
      return `fork: ${parsed.output.task.slice(0, 80)}`;
    }
  }
  if (kind === 'run') {
    const parsed = v.safeParse(RunJobInputSchema, input);
    if (parsed.success) {
      const runtime = parsed.output.runtime ? `${parsed.output.runtime}: ` : '';
      return `${runtime}${parsed.output.command.slice(0, 80)}`;
    }
  }
  if (kind === 'execute_tools') {
    const parsed = v.safeParse(ExecuteJobInputSchema, input);
    if (parsed.success) return parsed.output.code.trim().slice(0, 80);
  }
  return undefined;
}

export class BackgroundJobRunner {
  /** Live AbortControllers for in-flight jobs — hard-cancel handles. In-memory:
   *  a DO eviction loses them, and recover() then fails the orphan. */
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: BackgroundJobRunnerDeps) {}

  /** Mint a job row (carrying the tool input for retry) + register its cancel
   *  handle. Returns the job id. Pure — callers log their own lifecycle event
   *  (threshold-detach logs 'bg_job_started'; retry logs 'bg_job_retry'). */
  create<T>(kind: string, input: T, mode: WorkMode, controller: AbortController): string {
    const id = `bgjob-${nanoid()}`;
    this.deps.store.create({
      id, kind, workMode: mode, input: serializeJobResult(input), now: Date.now(),
      label: describeJobInput(kind, input),
    });
    this.controllers.set(id, controller);
    return id;
  }

  /** The surface's background policy — the detach threshold and the teardown
   *  grace, read by the backend that owns the session lifecycle. */
  get policy(): BackgroundPolicy {
    return this.deps.policy?.() ?? BACKGROUND_POLICY.interactive;
  }

  /** ThresholdDeps for withBackgroundThreshold: on cross, mint a job and keep
   *  the live work alive durably — unless the concurrency cap is already full,
   *  in which case the work is cancelled and the model is told why. */
  thresholdDeps<T>(kind: string, input: T, mode: WorkMode, controller: AbortController): ThresholdDeps {
    return {
      thresholdMs: this.policy.detachAfterMs,
      onThreshold: (k, promise) => this.onThreshold(k, input, mode, controller, promise),
    };
  }

  private onThreshold<T>(
    kind: string, input: T, mode: WorkMode, controller: AbortController, promise: Promise<T>,
  ): DetachOutcome {
    const running = this.deps.store.countRunning();
    if (running >= MAX_CONCURRENT_DETACHED_JOBS) {
      controller.abort(new Error('background-job concurrency cap reached'));
      this.deps.logActivity?.('bg_job_refused', `${kind} — ${running} jobs already running`);
      return { detached: false, reason: refusalMessage(kind, this.deps.store.listRunning(MAX_CONCURRENT_DETACHED_JOBS)) };
    }
    const jobId = this.create(kind, input, mode, controller);
    this.deps.logActivity?.('bg_job_started', `${kind} → ${jobId}`);
    this.detach(jobId, kind, promise);
    return { detached: true, jobId };
  }

  /** Keep a backgrounded promise alive in a durable fiber; on settle, record the
   *  result + wake the agent. Settle-vs-fail is driven ONLY by whether the work
   *  resolved — serializing happens separately so a non-serializable success
   *  (e.g. a BigInt) is never mislabelled a failure. */
  detach<T>(jobId: string, kind: string, promise: Promise<T>): void {
    this.runToSettlement(jobId, kind, () => promise);
  }

  /** The shared detach → settle/fail → wake body, over a durable fiber that keeps
   *  the DO alive for the work's duration. `exec` is the in-flight work (a
   *  backgrounded promise, or a resumer re-drive). The lease epoch is read once at
   *  fiber start and stamped on the terminal write, so an executor fenced by a
   *  concurrent reclaim (evict-recovery) can no longer settle the job (§5.3). */
  private runToSettlement<T>(jobId: string, kind: string, exec: () => Promise<T>): void {
    void this.deps.fiber(`bg:${kind}`, async (ctx) => {
      ctx.stash({ phase: 'running', jobId, kind });
      let settled: boolean;
      try {
        await this.settleAndWake(jobId, exec);
        // A fenced executor's terminal write is a no-op (§5.3), so the store —
        // not this fiber's own success — decides whether the job settled.
        settled = this.deps.store.get(jobId)?.status !== 'running';
      } catch (err) {
        // The settlement path itself threw — a store write, the post-settle
        // status read, or the undeliverable wake's durable retry breadcrumb.
        // Letting the fiber reject here would lose the force-fail below: both
        // fiber implementations DELETE their recovery row in a `finally`, so a
        // rejected body is never handed to onFiberRecovered. When the store is
        // gone entirely (teardown closed it under us) neither write lands and
        // the row stays `running` — which is recoverable, but only because
        // recoverOrphans() sweeps the registry at the next start rather than
        // trusting a fiber row to survive.
        diagnostics.failure(
          'jobs.settlement_failed',
          toProteusError({ doing: 'settle a background job and wake the agent', cause: err, otherwise: 'io' }),
          { jobId },
        );
        settled = this.failUnsettled(jobId, err);
      }
      // Only a job that actually reached a terminal status is 'settled'; if even
      // the force-fail could not write, the snapshot stays 'running' so an
      // eviction in this window still hands the job to recover().
      ctx.stash({ phase: settled ? 'settled' : 'running', jobId, kind });
    });
  }

  /** exec → record the outcome → notify → wake. Throws only when a store write
   *  or the wake's durable retry breadcrumb fails; runToSettlement owns that. */
  private async settleAndWake<T>(jobId: string, exec: () => Promise<T>): Promise<void> {
    const epoch = this.deps.store.epochOf(jobId) ?? 0;
    let outcome: { ok: true; result: T } | { ok: false; error: string };
    try { outcome = { ok: true, result: await exec() }; }
    catch (err) {
      // A kind the resumer can't re-drive is a clean interruption, not a crash:
      // record the same eviction message a non-resumable job always has.
      const error = err instanceof JobNotResumable ? EVICTION_INTERRUPT_ERROR
        : err instanceof Error ? err.message : String(err);
      outcome = { ok: false, error };
    }
    this.controllers.delete(jobId);
    // A cancelled job was already marked; its promise rejects with the abort,
    // which we must NOT relabel as a generic failure.
    if (this.deps.store.get(jobId)?.status === 'cancelled') return;
    if (outcome.ok) this.deps.store.settle(jobId, epoch, serializeJobResult(outcome.result), Date.now());
    else this.deps.store.fail(jobId, epoch, outcome.error, Date.now());
    // The lifecycle's OTHER end: start/refuse/cancel/resume already reach
    // logActivity (console.log + the queryable activity_log table), but the
    // terminal settle/fail never did — the one event that actually answers
    // "is this job still running", silently missing from both `wrangler tail`
    // and the activity log an operator would otherwise check.
    this.deps.logActivity?.('bg_job_settled', outcome.ok ? `${jobId} completed` : `${jobId} failed — ${outcome.error}`);
    this.notifySettled(jobId);
    await this.wake(jobId);
  }

  /** Last-resort terminal write for a job the settlement path left running, and
   *  whether the job carries a terminal status once it returns. A job whose
   *  outcome was already recorded keeps it — only the wake was lost, and its
   *  result stays readable via agent.jobResult. No wake is attempted: the wake
   *  is what usually failed, and the settle notification (which never throws)
   *  already surfaces the job in the Tasks view. */
  private failUnsettled<T>(jobId: string, err: T): boolean {
    try {
      const job = this.deps.store.get(jobId);
      if (!job || job.status !== 'running') return true;
      this.deps.store.fail(jobId, job.epoch, err instanceof Error ? err.message : String(err), Date.now());
      this.notifySettled(jobId);
      return true;
    } catch (failErr) {
      diagnostics.failure(
        'jobs.force_fail_failed',
        toProteusError({ doing: 'force-fail a job the settlement path left running', cause: failErr, otherwise: 'io' }),
        { jobId },
      );
      return false;
    }
  }

  /** Wake the agent with a synthesis signal carrying the settled job — at its
   *  next step if it is working, as its own turn if it is idle. The
   *  `background_job` kind makes a woken turn render as a background-event
   *  card, not a user bubble. An undelivered wake leaves a durable retry
   *  breadcrumb the standard drain picks up.
   *
   *  Callable more than once for the same job and deliberately so — recovery
   *  re-delivers a wake whose fiber died before it landed. What stops that from
   *  multiplying the conversation is {@link backgroundJobWakeTrigger}: the
   *  announcement's identity, from which the backend derives the queued turn's
   *  message id, so every re-delivery lands on the row the first one wrote. */
  async wake(jobId: string): Promise<void> {
    const job = this.deps.store.get(jobId);
    if (!job) return;
    const text = job.status === 'completed'
      ? `Background ${job.kind} job ${jobId} completed. Read the full result with ` +
        `agent.jobResult('${jobId}'), then synthesize it / continue the work you backgrounded.`
      // A cancel is neither a success nor a crash: the work is GONE, no result
      // will arrive, and the agent had been told to wait for one. Saying so is
      // the only thing that stops it reasoning from its own transcript.
      : job.status === 'cancelled'
        ? `Background ${job.kind} job ${jobId} was CANCELLED by the operator and is no longer ` +
          `running. There is no result to collect. Re-run that work if you still need it, or ` +
          `continue without it and say what is missing.`
        : `Background ${job.kind} job ${jobId} failed${job.error ? ` (${job.error})` : ''}. ` +
          `Decide whether to retry or report the failure.`;
    await this.deps.signals.deliver({
      kind: 'background_job',
      text,
      idempotencyKey: backgroundJobWakeTrigger(jobId),
      metadata: { proteusMode: job.workMode, jobId, kind: job.kind, status: job.status },
      compensate: (reason) => {
        if (reason === 'preempted') {
          this.deps.logActivity?.('bg_job_wake_skipped', `${jobId} (${job.status}) — wake preempted; result retained`);
        }
        this.publishWakeRetry(job, text);
      },
    });
  }

  private publishWakeRetry(job: BackgroundJob, text: string): void {
    try {
      this.deps.eventLog.publish({
        descriptor: {
          ingress: 'timer_alarm',
          variant: 'timer',
          payload: {
            trigger_id: backgroundJobWakeTrigger(job.id),
            scheduled_fire_at: job.settledAt ?? job.createdAt,
            label: text,
            user_payload: {
              proteusEvent: 'background_job', proteusMode: job.workMode,
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
        toProteusError({ doing: 'publish the background-job wake retry', cause: err, otherwise: 'io' }),
        { jobId: job.id, kind: job.kind },
      );
      throw err;
    }
    try { this.deps.scheduleDrain(); }
    catch (err) {
      // The retry is already durable; another ingress or activation can drain it.
      diagnostics.failure(
        'jobs.retry_drain_schedule_failed',
        toProteusError({ doing: 'schedule the drain for a background-job wake retry', cause: err, otherwise: 'io' }),
        { jobId: job.id },
      );
    }
  }

  /**
   * Hard-cancel one running job: abort the underlying work (its AbortSignal),
   * mark it cancelled, and TELL the agent.
   *
   * The wake is the point. This is an operator cancelling one detached job
   * while the agent goes on working — the agent was told to wait for that
   * job's result, so a cancel that only writes a row leaves it waiting on
   * something that no longer exists, with nothing in the request to correct
   * it. It rides the same `background_job` signal a completion does, because
   * it is the same fact (this job will never hand you a result) with a
   * different cause.
   *
   * The detach fiber still sees 'cancelled' and won't relabel the abort
   * rejection or wake a second time.
   */
  async cancel(jobId: string): Promise<boolean> {
    if (!this.settleCancelled(jobId)) return false;
    await this.wake(jobId);
    return true;
  }

  /**
   * Cancel every currently-running job, newest first — the visible Stop
   * control.
   *
   * Deliberately no wake, and that is the whole difference from
   * {@link cancel}: Stop stops the AGENT as well as its detached work, so
   * there is no next step to inform, and a wake here would queue a turn that
   * restarts the work the operator just stopped. The next turn reads the truth
   * from the dynamic-context roster instead, which no longer carries a
   * cancelled job.
   */
  cancelRunning(): string[] {
    const cancelled: string[] = [];
    for (const job of this.deps.store.list(100)) {
      if (job.status !== 'running') continue;
      if (this.settleCancelled(job.id)) cancelled.push(job.id);
    }
    return cancelled;
  }

  /** The cancel write itself: registry row + abort handle. Shared by the two
   *  public verbs above, which differ only in whether the agent is woken. */
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

  /** Recover an orphaned job after its fiber was evicted mid-flight (called from
   *  the backend's onFiberRecovered for bg:* fibers). The fiber row carries one
   *  fact the registry does not — that this job's executor is dead — which is
   *  what lets a job that already settled get its lost wake re-delivered. */
  async recover<T>(snapshot: T): Promise<void> {
    const parsed = v.safeParse(v.object({ jobId: v.string(), phase: v.literal('running') }), snapshot);
    if (!parsed.success) return;
    await this.recoverJob(parsed.output.jobId);
  }

  /**
   * Recover every job the registry still shows as `running` — the start-of-life
   * sweep, run once per process/isolate start.
   *
   * Nothing in memory owns a job at that point, so a `running` row IS an orphan
   * whatever became of the fiber that was driving it. Keying recovery off the
   * JOB rows rather than off surviving fiber rows is what makes the lifecycle
   * total: a settlement whose store closed under it during teardown writes
   * nothing (neither the outcome nor the force-fail), and a fiber row can die
   * with the process that owned it — either way the row is left `running` with
   * no fiber pointing at it, and a fiber-keyed recovery never looks at it
   * again. It would then never resume, never fail, and never stop consuming one
   * of the MAX_CONCURRENT_DETACHED_JOBS slots.
   *
   * Every recovery here goes through the same reclaim, so MAX_RESUME_ATTEMPTS
   * bounds it: at most that many re-drives, then a terminal `failed`.
   */
  async recoverOrphans(): Promise<void> {
    for (const jobId of this.deps.store.runningIds()) await this.recoverJob(jobId);
  }

  /**
   * Settle or re-drive one orphaned job.
   *
   * A job whose outcome was already persisted (settled/failed) before its
   * executor died just gets its wake re-delivered. A job still `running` was
   * interrupted mid-flight: if a resumer is wired AND the kind is
   * checkpoint-backed, it is reclaimed under a fresh lease epoch (fencing the
   * dead executor) and re-driven in a new durable fiber from its durable
   * checkpoint (MCTS continues its remaining search budget; heads re-run).
   * Without a resumer — or past the resume-attempt cap — it is failed with the
   * eviction message.
   *
   * A job THIS runner is already driving is left alone. Both entry points can
   * name the same job in one activation — a resume leaves its own fiber row, so
   * a cold start can recover two fibers for one job, and the registry sweep
   * names every running row besides — and re-driving one twice would reclaim it
   * out from under the executor that is making progress on it.
   */
  private async recoverJob(jobId: string): Promise<void> {
    if (this.controllers.has(jobId)) return;
    const job = this.deps.store.get(jobId);
    if (!job || job.status === 'cancelled') return;
    // Outcome already persisted before the settle checkpoint landed → just deliver
    // the wake that the dead fiber never reached.
    if (job.status !== 'running') { await this.wake(jobId); return; }

    if (this.deps.resume) {
      const claim = this.deps.store.reclaim(jobId);
      if (!claim) return; // lost the race — another activation already reclaimed it
      if (claim.attempts > MAX_RESUME_ATTEMPTS) {
        this.deps.store.fail(
          jobId, claim.epoch,
          `${EVICTION_INTERRUPT_ERROR} (gave up after ${MAX_RESUME_ATTEMPTS} resume attempts)`,
          Date.now(),
        );
        this.notifySettled(jobId);
        await this.wake(jobId);
        return;
      }
      this.deps.logActivity?.('bg_job_resume', `${job.kind} → ${jobId} (attempt ${claim.attempts}, epoch ${claim.epoch})`);
      this.driveResume(job);
      return;
    }

    // No resumer: fail the orphan with the eviction message (fencing the write on
    // the job's current epoch so a zombie can't later overwrite it).
    this.deps.store.fail(jobId, job.epoch, EVICTION_INTERRUPT_ERROR, Date.now());
    this.notifySettled(jobId);
    await this.wake(jobId);
  }

  /** Re-drive a reclaimed job from its durable checkpoint in a fresh durable
   *  fiber. Reuses the detach settlement body, so this resume is itself
   *  evict-recoverable: a second eviction re-enters recover() and re-drives under
   *  a newer epoch, and the search's own checkpoint means no budget is redone. */
  private driveResume(job: BackgroundJob): void {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const rawInput = this.deps.store.getInput(job.id);
    let input: JsonValue = null;
    if (rawInput !== null) {
      try { input = parseJsonValue(rawInput); }
      catch { input = rawInput; }
    }
    this.runToSettlement(job.id, job.kind, () => this.deps.resume!(job.kind, input, job.workMode, controller.signal));
  }

  /** Deliver the settle notification without letting a sink error poison the
   *  fiber / recovery path. */
  private notifySettled(jobId: string): void {
    if (!this.deps.onSettled) return;
    const job = this.deps.store.get(jobId);
    if (!job) return;
    try { this.deps.onSettled(job); }
    catch (err) {
      diagnostics.failure(
        'jobs.settle_sink_failed',
        toProteusError({ doing: 'deliver the job settle notification', cause: err, otherwise: 'io' }),
        { jobId },
      );
    }
  }
}
