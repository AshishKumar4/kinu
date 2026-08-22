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
import type { AgentSignal, SignalDeliverer, SignalUndeliveredReason } from '../types/signals';
import type { EventLog } from '../events/hub/log';
import { BACKGROUND_POLICY, type BackgroundPolicy, type DetachOutcome, type ThresholdDeps } from './threshold';
import { BackgroundJobStore, serializeJobResult, type BackgroundJob } from './store';
import { nanoid } from '../utils/nanoid';
import type { WorkMode } from '../prompting/surface';
import * as v from 'valibot';
import { parseJsonValue, type JsonValue } from '../utils/json';
import { classify, diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/** The terminal error a non-recoverable job records when it is interrupted by a
 *  DO eviction (no durable checkpoint / not safe to re-run).
 *
 *  Kinu stamps this itself because `do.evict.no_signal` says the platform
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
 * What a job has already produced, for a job that will not be driven again.
 *
 * PARTIAL CANDIDATES ARE RESULTS, and that is the whole reason this seam exists. The
 * bounded-out and force-fail paths used to settle with an eviction string, so the
 * incident's job reported nothing while its search held two completed candidates with
 * real content. A harvester answers "what does this work have RIGHT NOW", read out of
 * the durable rows the work already wrote.
 *
 * Null when the kind has nothing partial to give, which is the honest answer for a
 * side-effecting call: `run` and `execute_tools` either happened or did not.
 */
export type JobHarvester = (
  kind: string,
  input: JsonValue,
) => Promise<JsonValue | null>;

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
   *  cf workspace DO serves human-watched web chat, one-shot `kinu exec`
   *  invocations, and unwatched email/timer/peer drains through the SAME
   *  runner, so only the turn in flight knows which it is. Read at threshold
   *  time. Defaults to the interactive policy. */
  policy?: () => BackgroundPolicy;
  /** Durable fiber — AgentRuntime.schedule.fiber. */
  fiber: Schedule['fiber'];
  /** The one signal-delivery seam — the wake at the end of a settled job. */
  signals: SignalDeliverer;
  /**
   * The DURABLE half of the wake: a breadcrumb the standard event drain picks up
   * when a settle announcement could not be delivered, and the scheduler that
   * runs that drain.
   *
   * Both or neither, and absent is a real wiring rather than a gap. They exist
   * for an agent that OUTLIVES the activation that queued the wake, which is what
   * a durable message table buys an actor. A runner whose agent's lifetime is its
   * spawner's activation — a swarm node, abandoned with the run that spawned it —
   * has no later activation to hand a breadcrumb to, and its deliverer is an
   * in-process queue that cannot fail to deliver. So no `compensate` is offered
   * at all (see {@link BackgroundJobRunner.wake}) and nothing here is reachable
   * with a promise nobody keeps.
   */
  eventLog?: EventLog;
  scheduleDrain?(): void;
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
  /** What a job that will not be driven again has already produced, for the two
   *  terminals that reach settle-with-what-you-have: the resume cap and the
   *  no-resumer case.
   *
   * Absent means "settle with nothing", which is what every one of those paths used
   * to do unconditionally. Present, the job settles `completed` carrying the partial
   * result, because a search that measured two of five answers measured two answers.
   * Never throws into the fiber: a harvester that fails leaves the job settling the
   * way it would have without one.
   */
  harvest?: JobHarvester;
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
const SearchJobInputSchema = v.object({ task: v.string() });
const RunJobInputSchema = v.object({ command: v.string(), runtime: v.optional(v.string()) });
const ExecuteJobInputSchema = v.object({ code: v.string() });

function describeJobInput<T>(kind: string, input: T): string | undefined {
  if (kind === 'agents') {
    const parsed = v.safeParse(SearchJobInputSchema, input);
    if (parsed.success) {
      // `search:`, not `fork:` — the only backgroundable `agents` action is
      // swarm, and this label is rendered into the live-state block the model
      // reads its own running work off.
      return `search: ${parsed.output.task.slice(0, 80)}`;
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

  /**
   * How many jobs THIS RUNNER is driving right now — the ones it detached and has
   * not yet settled.
   *
   * Scoped to the runner and not read off the store, and that is the whole point
   * of it: one workspace's `background_jobs` table is shared by every runner over
   * its SQL — an actor's, and now each of its swarm nodes' — so `countRunning()`
   * answers a question about the WORKSPACE. An agent asking "am I still holding
   * work, so is my turn unfinished" must not be answered with its parent's jobs,
   * or it would wait forever on work it cannot see the result of.
   *
   * The concurrency cap deliberately keeps reading the store instead: that one IS
   * a question about the machine, because every detached job is a live process
   * tree whichever agent launched it.
   */
  get inFlight(): number {
    return this.controllers.size;
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
          toKinuError({ doing: 'settle a background job and wake the agent', cause: err, otherwise: 'io' }),
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
        : renderThrownChain({ cause: err });
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

  /**
   * Settle a job nothing will drive again, carrying what it already has.
   *
   * `completed` when the harvest yields something, and that is the decision the
   * incident turned on: root `2rye1eyny1efm9583sqye` held two completed candidates
   * with real content while its job reported nothing, so the owner was handed an empty
   * failure over work that had really been done. `failed` only when there is genuinely
   * nothing — a side-effecting kind, an absent harvester, or a search that had not
   * measured one answer yet.
   */
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
      this.deps.store.settle(jobId, epoch, serializeJobResult({
        partial: true,
        why: `This result is PARTIAL: ${why}. It is what the work had completed, not a `
          + 'finished answer — say so if you use it.',
        generation: (job?.resumeAttempts ?? 0) + 1,
        result: harvested.value,
      }), now);
      this.deps.logActivity?.('bg_job_bounded', `${jobId} settled partial — ${why}`);
    }
    this.notifySettled(jobId);
    await this.wake(jobId);
  }

  /** The harvest as a value that says which of the three cases held: something to
   *  settle, genuinely nothing, or a read that failed. Never a throw into the
   *  settle path — a harvester that fails must not turn a job that could settle
   *  partially into one that cannot settle at all — and never a bare null, which
   *  would report a blown read as "this search produced nothing". */
  private async harvestOf(job: BackgroundJob): Promise<
    { ok: true; value: JsonValue | null } | { ok: false; error: string }
  > {
    const harvest = this.deps.harvest;
    if (!harvest) return { ok: true, value: null };
    const raw = this.deps.store.getInput(job.id);
    let input: JsonValue = null;
    if (raw !== null) {
      try { input = parseJsonValue(raw); }
      catch (error) {
        if (classify({ cause: error }) !== 'malformed-input') throw error;
        input = raw;
      }
    }
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
      this.deps.store.fail(jobId, job.epoch, renderThrownChain({ cause: err }), Date.now());
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
    // HOW MANY GENERATIONS IT TOOK, where that is more than one. The count was
    // durable all along and appeared nowhere a reader could see it: the owner watched
    // a job sit `running` through three generations and asked why it would not give up
    // its turn, with nothing in the conversation able to answer him.
    const generation = job.resumeAttempts > 0
      ? ` (generation ${String(job.resumeAttempts + 1)} — it was interrupted and re-driven)`
      : '';
    const text = job.status === 'completed'
      ? `Background ${job.kind} job ${jobId} completed${generation}. Read the full result with ` +
        `agent.jobResult('${jobId}'), then synthesize it / continue the work you backgrounded. ` +
        `The result says whether it is COMPLETE or PARTIAL — say which when you report it.`
      // A cancel is neither a success nor a crash: the work is GONE, no result
      // will arrive, and the agent had been told to wait for one. Saying so is
      // the only thing that stops it reasoning from its own transcript.
      : job.status === 'cancelled'
        ? `Background ${job.kind} job ${jobId} was CANCELLED by the operator and is no longer ` +
          `running. There is no result to collect. Re-run that work if you still need it, or ` +
          `continue without it and say what is missing.`
        // NOT "decide whether to retry". That sentence is how the duplicate-root defect
        // happened: the model retried by calling the tool again, over a search that was
        // still running, and got a second tree. The engine refuses that now, so advising
        // it would be advising a refusal.
        : `Background ${job.kind} job ${jobId} failed${generation}` +
          `${job.error ? ` (${job.error})` : ''}. Report the failure and what it cost. Do not ` +
          `re-spawn the same work: a search keeps its tree, so a genuine retry continues that ` +
          `one rather than starting another, and an identical spawn is refused.`;
    const base = {
      kind: 'background_job',
      text,
      idempotencyKey: backgroundJobWakeTrigger(jobId),
      metadata: { kinuMode: job.workMode, jobId, kind: job.kind, status: job.status },
    } as const satisfies Omit<AgentSignal, 'compensate'>;
    // `compensate` is a PROMISE to retry, so it is offered only where one can be
    // kept: with a durable retry plane behind it. A runner without one serves an
    // agent whose lifetime is its spawner's activation, over an in-process queue
    // that cannot fail to deliver — there is nothing to compensate and no later
    // activation to compensate into, and offering a callback that would silently
    // drop the wake is worse than not offering one.
    const retry = this.publishWakeRetryIfDurable(job, text);
    await this.deps.signals.deliver(retry ? { ...base, compensate: retry } : base);
  }

  /** The compensation callback, when this runner has the plane to honour it. */
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
      // The retry is already durable; another ingress or activation can drain it.
      diagnostics.failure(
        'jobs.retry_drain_schedule_failed',
        toKinuError({ doing: 'schedule the drain for a background-job wake retry', cause: err, otherwise: 'io' }),
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
   * Cancel every job THIS RUNNER is driving — the visible Stop control, and a
   * confined agent's teardown when it finishes holding work nobody will read.
   *
   * Deliberately no wake, and that is the whole difference from {@link cancel}:
   * Stop stops the AGENT as well as its detached work, so there is no next step to
   * inform, and a wake here would queue a turn that restarts the work the operator
   * just stopped. The next turn reads the truth from the dynamic-context roster
   * instead, which no longer carries a cancelled job.
   *
   * Scoped to `controllers` rather than sweeping the store, because the store is
   * shared by every runner over one workspace's SQL. A store-wide sweep writes
   * `cancelled` on a row whose abort handle lives in a DIFFERENT runner, so the
   * work goes on running while the row says it stopped — the absent-versus-broken
   * confusion, with the store taking the wrong side. A row left `running` by a
   * dead activation is not Stop's to settle either: `recoverOrphans()` owns that,
   * and Stop stops what is running NOW.
   */
  cancelRunning(): string[] {
    const cancelled: string[] = [];
    // Iterated in place: `settleCancelled` deletes the key it just handled, and a
    // Map iterator is specified to tolerate exactly that.
    for (const jobId of this.controllers.keys()) {
      if (this.settleCancelled(jobId)) cancelled.push(jobId);
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
   *  what lets a job that already settled get its lost wake re-delivered.
   *
   *  Returns the job if this call RE-DROVE it, so a caller can tell what durable
   *  work is now in flight. Null covers every other outcome: already driven here,
   *  already settled, cancelled, or refused. */
  async recover<T>(snapshot: T): Promise<BackgroundJob | null> {
    const parsed = v.safeParse(v.object({ jobId: v.string(), phase: v.literal('running') }), snapshot);
    if (!parsed.success) return null;
    return await this.recoverJob(parsed.output.jobId);
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
   *
   * Returns every job that is IN FLIGHT when it returns — the ones it re-drove
   * plus the ones this runner was already driving. That is what makes the sweep
   * usable as a resume gate by a caller reconciling other durable state: it can
   * tell which of that state is being continued and which nothing will ever pick
   * up again, and a refused job is absent, so refusal is a fact rather than a
   * timeout.
   *
   * ALREADY-DRIVING COUNTS AS IN FLIGHT, and the distinction is load-bearing.
   * `recoverJob` declines a job this runner already holds, because re-driving one
   * twice would reclaim it out from under the executor making progress on it —
   * but to a resume gate "another entry point started it a moment ago" and
   * "nothing will ever run this" are opposite answers. Both entry points can name
   * the same job in one activation, so reading the decline as a refusal would
   * retire a fork whose job had just been re-driven by the fiber callback.
   */
  async recoverOrphans(): Promise<readonly BackgroundJob[]> {
    for (const jobId of this.deps.store.runningIds()) await this.recoverJob(jobId);
    return [...this.controllers.keys()]
      .map((jobId) => this.deps.store.get(jobId))
      .filter((job): job is BackgroundJob => job !== null && job !== undefined);
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
   *
   * PAST A BOUND IT SETTLES WITH WHAT IT HAS. The one bound that reaches here is
   * the resume-attempt cap, and it settles through {@link settleBounded} rather
   * than writing an eviction string over work that had really been done — the
   * incident's job was one reclaim short of the cap with two completed candidates
   * in its journal, and the next eviction would have discarded them.
   *
   * THERE IS NO WALL CLOCK HERE, and that is a decision rather than an omission,
   * twice over. Time since `createdAt` is the wrong quantity: a Durable Object
   * evicted overnight was not WORKING overnight. And no attempt clock exists
   * either any more: every hang class inside the work is bounded per LLM call by
   * the shared turn loop's silence window (owner ruling, 2026-08-21), so a fixed
   * attempt bound could only ever kill sanctioned long work. Across generations,
   * the cap is the bound.
   *
   * A job THIS runner is already driving is left alone. Both entry points can
   * name the same job in one activation — a resume leaves its own fiber row, so
   * a cold start can recover two fibers for one job, and the registry sweep
   * names every running row besides — and re-driving one twice would reclaim it
   * out from under the executor that is making progress on it.
   *
   * Every refusal returns null, so a caller using this as a resume gate reads one
   * fact with one spelling rather than inferring it from a timeout.
   */
  private async recoverJob(jobId: string): Promise<BackgroundJob | null> {
    if (this.controllers.has(jobId)) return null;
    const job = this.deps.store.get(jobId);
    if (!job || job.status === 'cancelled') return null;
    // Outcome already persisted before the settle checkpoint landed → just deliver
    // the wake that the dead fiber never reached.
    if (job.status !== 'running') { await this.wake(jobId); return null; }

    if (this.deps.resume) {
      if (job.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
        await this.settleBounded(jobId, job.epoch,
          `it was re-driven ${String(MAX_RESUME_ATTEMPTS)} times without finishing, so it gave up`);
        return null;
      }
      const claim = this.deps.store.reclaim(jobId);
      if (!claim) return null; // lost the race — another activation already reclaimed it
      // NO WALL-CLOCK CHECK HERE, and that is a decision rather than an omission.
      // Time since `createdAt` is the wrong quantity: a Durable Object evicted
      // overnight was not WORKING overnight, and bounding a job on it would make a
      // workspace resumed after an idle night discard a search instead of continuing
      // it. The time bound belongs where the time is real — {@link raceAttemptBound},
      // on the attempt this process is actually driving, measured from a clock the
      // reclaim above just wrote. Across generations, the cap is the bound.
      this.deps.logActivity?.('bg_job_resume', `${job.kind} → ${jobId} (attempt ${claim.attempts}, epoch ${claim.epoch})`);
      this.driveResume(job);
      return job;
    }

    // No resumer: this job's work is gone and nothing will re-run it. It still
    // settles with whatever it produced rather than with the eviction string alone.
    await this.settleBounded(jobId, job.epoch, 'its executor was lost and this kind cannot be re-driven');
    return null;
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
      catch (error) {
        if (classify({ cause: error }) !== 'malformed-input') throw error;
        input = rawInput;
      }
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
        toKinuError({ doing: 'deliver the job settle notification', cause: err, otherwise: 'io' }),
        { jobId },
      );
    }
  }
}
