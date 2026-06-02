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
import type { ThresholdDeps } from './threshold.js';
import { BackgroundJobStore, serializeJobResult } from './store.js';
import { nanoid } from '../utils/nanoid.js';

export interface BackgroundJobRunnerDeps {
  store: BackgroundJobStore;
  /** Durable fiber — AgentRuntime.schedule.fiber. */
  fiber: Schedule['fiber'];
  /** Programmatic-turn wake + (unused here) broadcast. */
  host: BackendHost;
  /** Activity-log sink (optional). */
  logActivity?(event: string, detail?: string): void;
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
    void this.deps.fiber(`bg:${kind}`, async (ctx) => {
      ctx.stash({ phase: 'running', jobId, kind });
      let outcome: { ok: true; result: unknown } | { ok: false; error: string };
      try { outcome = { ok: true, result: await promise }; }
      catch (err) { outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
      this.controllers.delete(jobId);
      // A cancelled job was already marked; its promise rejects with the abort,
      // which we must NOT relabel as a generic failure.
      if (this.deps.store.get(jobId)?.status === 'cancelled') { ctx.stash({ phase: 'settled', jobId, kind }); return; }
      if (outcome.ok) this.deps.store.settle(jobId, serializeJobResult(outcome.result), Date.now());
      else this.deps.store.fail(jobId, outcome.error, Date.now());
      ctx.stash({ phase: 'settled', jobId, kind });
      await this.wake(jobId);
    });
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
      if (result.status === 'skipped') {
        this.deps.logActivity?.('bg_job_wake_skipped', `${jobId} (${job.status}) — wake preempted; result retained`);
      }
    } catch (err) {
      console.warn('[proteus] wakeForBackgroundJob failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Hard-cancel a running job: abort the underlying work (its AbortSignal) +
   *  mark it cancelled. The detach fiber sees 'cancelled' and won't relabel the
   *  abort rejection or wake the agent. */
  cancel(jobId: string): boolean {
    const job = this.deps.store.get(jobId);
    if (!job || job.status !== 'running') return false;
    this.deps.store.cancel(jobId, Date.now());
    const controller = this.controllers.get(jobId);
    if (controller) { try { controller.abort(new Error('cancelled by operator')); } catch { /* nop */ } }
    this.controllers.delete(jobId);
    this.deps.logActivity?.('bg_job_cancelled', jobId);
    return true;
  }

  /** Recover an orphaned job after its fiber was evicted mid-flight (called from
   *  the backend's onFiberRecovered for bg:* fibers). Only a job stashed
   *  'running' is orphaned — one 'settled' already recorded its outcome + woke. */
  async recover(snapshot: unknown): Promise<void> {
    const snap = (snapshot ?? {}) as { jobId?: unknown; phase?: unknown };
    const jobId = typeof snap.jobId === 'string' ? snap.jobId : '';
    if (jobId && snap.phase === 'running') {
      this.deps.store.fail(jobId, 'interrupted by Durable Object eviction before completion', Date.now());
      await this.wake(jobId);
    }
  }
}
