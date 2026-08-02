// BackgroundJobRunner — the backend-agnostic lifecycle for auto-detached >30s
// tool calls (think-heads, long execute_tools/run). Mints a job, keeps the
// in-flight promise alive in a durable fiber, settles/fails it, and wakes the
// agent with a synthesis turn — all over the AgentRuntime fiber + a BackendHost.
//
// Hoisted out of the cf-backend OrchestratorAgent (re-arch P4) so the CLI gets
// background jobs for free. The platform supplies a durable `fiber` (CF:
// Agent.runFiber; CLI: createLinuxFiber) + a BackendHost (enqueueTurn = the
// programmatic-turn wake). The @callable control-plane RPCs (jobResult/list/
// dismiss/clear/retry) stay on each backend and call BackgroundJobStore + here.

import type { Schedule } from '../types/primitives.js';
import type { BackendHost } from '../types/backend-host.js';
import type { EventLog } from '../events/hub/log.js';
import type { ThresholdDeps } from './threshold.js';
import { BackgroundJobStore, serializeJobResult, type BackgroundJob } from './store.js';
import { nanoid } from '../utils/nanoid.js';

/** The terminal error a non-recoverable job records when it is interrupted by a
 *  DO eviction (no durable checkpoint / not safe to re-run). */
export const EVICTION_INTERRUPT_ERROR = 'interrupted by Durable Object eviction before completion';

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
export type JobResumer = (kind: string, input: unknown, signal: AbortSignal) => Promise<unknown>;

/** Give up re-driving a job after this many evict-recovery attempts, so a job
 *  that evicts on every activation can't loop forever. MCTS makes monotonic
 *  progress (budget strictly decreases per resume) so it converges well within
 *  this; the cap only bounds pathological non-progressing kinds. */
const MAX_RESUME_ATTEMPTS = 5;

export interface BackgroundJobRunnerDeps {
  store: BackgroundJobStore;
  /** Durable fiber — AgentRuntime.schedule.fiber. */
  fiber: Schedule['fiber'];
  /** Programmatic-turn wake + (unused here) broadcast. */
  host: BackendHost;
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

export class BackgroundJobRunner {
  /** Live AbortControllers for in-flight jobs — hard-cancel handles. In-memory:
   *  a DO eviction loses them, and recover() then fails the orphan. */
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: BackgroundJobRunnerDeps) {}

  /** Mint a job row (carrying the tool input for retry) + register its cancel
   *  handle. Returns the job id. Pure — callers log their own lifecycle event
   *  (threshold-detach logs 'bg_job_started'; retry logs 'bg_job_retry'). */
  create(kind: string, input: unknown, controller: AbortController): string {
    const id = `bgjob-${nanoid()}`;
    this.deps.store.create({ id, kind, input: serializeJobResult(input, 8_000), now: Date.now() });
    this.controllers.set(id, controller);
    return id;
  }

  /** ThresholdDeps for withBackgroundThreshold: create the job on cross, detach. */
  thresholdDeps(kind: string, input: unknown, controller: AbortController): ThresholdDeps {
    return {
      createJob: (k) => {
        const id = this.create(k, input, controller);
        this.deps.logActivity?.('bg_job_started', `${k} → ${id}`);
        return id;
      },
      detach: (jobId, promise) => this.detach(jobId, kind, promise),
    };
  }

  /** Keep a backgrounded promise alive in a durable fiber; on settle, record the
   *  result + wake the agent. Settle-vs-fail is driven ONLY by whether the work
   *  resolved — serializing happens separately so a non-serializable success
   *  (e.g. a BigInt) is never mislabelled a failure. */
  detach(jobId: string, kind: string, promise: Promise<unknown>): void {
    this.runToSettlement(jobId, kind, () => promise);
  }

  /** The shared detach → settle/fail → wake body, over a durable fiber that keeps
   *  the DO alive for the work's duration. `exec` is the in-flight work (a
   *  backgrounded promise, or a resumer re-drive). The lease epoch is read once at
   *  fiber start and stamped on the terminal write, so an executor fenced by a
   *  concurrent reclaim (evict-recovery) can no longer settle the job (§5.3). */
  private runToSettlement(jobId: string, kind: string, exec: () => Promise<unknown>): void {
    void this.deps.fiber(`bg:${kind}`, async (ctx) => {
      ctx.stash({ phase: 'running', jobId, kind });
      try {
        await this.settleAndWake(jobId, exec);
      } catch (err) {
        // The settlement path itself threw — a store write, or the undeliverable
        // wake's durable retry breadcrumb. Letting the fiber reject here would
        // strand the job: both fiber implementations DELETE their recovery row in
        // a `finally`, so a rejected body is never handed to onFiberRecovered and
        // the job would sit at 'running' forever — never resumed, never failed.
        console.warn('[proteus] background-job settlement failed:',
          err instanceof Error ? err.message : err);
        this.failUnsettled(jobId, err);
      }
      // Only a job that actually reached a terminal status is 'settled'; if even
      // the force-fail could not write, the snapshot stays 'running' so an
      // eviction in this window still hands the job to recover().
      ctx.stash({ phase: this.isSettled(jobId) ? 'settled' : 'running', jobId, kind });
    });
  }

  /** exec → record the outcome → notify → wake. Throws only when a store write
   *  or the wake's durable retry breadcrumb fails; runToSettlement owns that. */
  private async settleAndWake(jobId: string, exec: () => Promise<unknown>): Promise<void> {
    const epoch = this.deps.store.epochOf(jobId) ?? 0;
    let outcome: { ok: true; result: unknown } | { ok: false; error: string };
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
    this.notifySettled(jobId);
    await this.wake(jobId);
  }

  /** Last-resort terminal write for a job the settlement path left running. A
   *  job whose outcome was already recorded keeps it — only the wake was lost,
   *  and its result stays readable via agent.jobResult. No wake is attempted:
   *  the wake is what usually failed, and the settle notification (which never
   *  throws) already surfaces the job in the Tasks view. */
  private failUnsettled(jobId: string, err: unknown): void {
    try {
      const job = this.deps.store.get(jobId);
      if (!job || job.status !== 'running') return;
      this.deps.store.fail(jobId, job.epoch, err instanceof Error ? err.message : String(err), Date.now());
      this.notifySettled(jobId);
    } catch (failErr) {
      console.warn('[proteus] background-job force-fail failed:',
        failErr instanceof Error ? failErr.message : failErr);
    }
  }

  /** True once the job carries a terminal status. A store that cannot even be
   *  read is reported as not settled — the recoverable answer. */
  private isSettled(jobId: string): boolean {
    try { return this.deps.store.get(jobId)?.status !== 'running'; }
    catch { return false; }
  }

  /** Wake the agent with a synthesis turn carrying the settled job. The metadata
   *  marker makes the chat render it as a background-event card, not a user
   *  bubble. Runs once per job (no self-wake loop). */
  async wake(jobId: string): Promise<void> {
    const job = this.deps.store.get(jobId);
    if (!job) return;
    const text = job.status === 'completed'
      ? `Background ${job.kind} job ${jobId} completed. Read the full result with ` +
        `agent.jobResult('${jobId}'), then synthesize it / continue the work you backgrounded.`
      : `Background ${job.kind} job ${jobId} failed${job.error ? ` (${job.error})` : ''}. ` +
        `Decide whether to retry or report the failure.`;
    try {
      const result = await this.deps.host.enqueueTurn({
        text, metadata: { proteusEvent: 'background_job', jobId, kind: job.kind, status: job.status },
      });
      if (result.status === 'queued') return;
      this.deps.logActivity?.('bg_job_wake_skipped', `${jobId} (${job.status}) — wake preempted; result retained`);
    } catch (err) {
      console.warn('[proteus] wakeForBackgroundJob failed:', err instanceof Error ? err.message : err);
    }
    this.publishWakeRetry(job, text);
  }

  private publishWakeRetry(job: BackgroundJob, text: string): void {
    try {
      this.deps.eventLog.publish({
        descriptor: {
          ingress: 'timer_alarm',
          variant: 'timer',
          payload: {
            trigger_id: `background-job-wake:${job.id}`,
            scheduled_fire_at: job.settledAt ?? job.createdAt,
            label: text,
            user_payload: {
              proteusEvent: 'background_job', jobId: job.id, kind: job.kind, status: job.status,
            },
          },
          trigger_creator_trust: 'self',
        },
        now: Date.now(),
      });
    } catch (err) {
      console.warn('[proteus] background-job retry event publish failed:', err instanceof Error ? err.message : err);
      throw err;
    }
    try { this.deps.scheduleDrain(); }
    catch (err) {
      // The retry is already durable; another ingress or activation can drain it.
      console.warn('[proteus] background-job retry scheduling failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Hard-cancel a running job: abort the underlying work (its AbortSignal) +
   *  mark it cancelled. The detach fiber sees 'cancelled' and won't relabel the
   *  abort rejection or wake the agent. */
  cancel(jobId: string): boolean {
    const job = this.deps.store.get(jobId);
    if (!job || job.status !== 'running') return false;
    this.deps.store.cancel(jobId, job.epoch, Date.now());
    const controller = this.controllers.get(jobId);
    if (controller) { try { controller.abort(new Error('cancelled by operator')); } catch { /* nop */ } }
    this.controllers.delete(jobId);
    this.deps.logActivity?.('bg_job_cancelled', jobId);
    return true;
  }

  /** Cancel all currently-running jobs, newest first. Used by visible Stop
   *  controls that should cancel detached work instead of only stopping the
   *  browser stream. */
  cancelRunning(): string[] {
    const cancelled: string[] = [];
    for (const job of this.deps.store.list(100)) {
      if (job.status !== 'running') continue;
      if (this.cancel(job.id)) cancelled.push(job.id);
    }
    return cancelled;
  }

  /** Recover an orphaned job after its fiber was evicted mid-flight (called from
   *  the backend's onFiberRecovered for bg:* fibers).
   *
   *  A job whose outcome was already persisted (settled/failed) before the fiber
   *  died just gets its wake re-delivered. A job still `running` was interrupted
   *  mid-flight: if a resumer is wired AND the kind is checkpoint-backed, it is
   *  reclaimed under a fresh lease epoch (fencing the dead executor) and re-driven
   *  in a new durable fiber from its durable checkpoint (MCTS continues its
   *  remaining search budget; heads re-run). Without a resumer — or past the
   *  resume-attempt cap — it is failed with the eviction message (legacy). */
  async recover(snapshot: unknown): Promise<void> {
    const snap = (snapshot ?? {}) as { jobId?: unknown; phase?: unknown };
    const jobId = typeof snap.jobId === 'string' ? snap.jobId : '';
    if (!jobId || snap.phase !== 'running') return;
    const job = this.deps.store.get(jobId);
    if (!job || job.status === 'cancelled') return;
    // Outcome already persisted before the settle checkpoint landed → just deliver
    // the wake that the dead fiber never reached.
    if (job.status !== 'running') { await this.wake(jobId); return; }

    if (this.deps.resume) {
      const claim = this.deps.store.reclaim(jobId, Date.now());
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
    let input: unknown;
    if (rawInput != null) { try { input = JSON.parse(rawInput); } catch { input = rawInput; } }
    this.runToSettlement(job.id, job.kind, () => this.deps.resume!(job.kind, input, controller.signal));
  }

  /** Deliver the settle notification without letting a sink error poison the
   *  fiber / recovery path. */
  private notifySettled(jobId: string): void {
    if (!this.deps.onSettled) return;
    const job = this.deps.store.get(jobId);
    if (!job) return;
    try { this.deps.onSettled(job); }
    catch (err) { console.warn('[proteus] job onSettled sink failed:', err instanceof Error ? err.message : err); }
  }
}
