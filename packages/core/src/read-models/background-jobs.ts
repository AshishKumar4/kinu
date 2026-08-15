/**
 * The background-job control plane — what an operator can do to work that has
 * detached from the turn that started it.
 *
 * The lifecycle (detach → settle → wake → recover) is the BackgroundJobRunner's;
 * this is the layer above it: list, inspect, cancel, retry, dismiss, and the
 * stop-everything abort. Retry is the only one with real policy in it — it
 * reconstructs a tool invocation from the stored input and re-detaches it,
 * which is agent behaviour, not transport.
 *
 * Reads never throw: a workspace that predates `background_jobs` should show
 * an empty task list, not a failed surface.
 */

import type { ToolSet } from 'ai';

import type { BackgroundJob, BackgroundJobStore } from '../jobs/store.js';
import type { WorkMode } from '../prompting/surface.js';
import { decodeJsonValue, parseJsonValue, type JsonValue } from '../utils/json.js';

/** The four things the control plane asks of a running job registry —
 *  BackgroundJobRunner's public surface, named at the width this plane uses. */
export interface BackgroundJobControl {
  cancel(jobId: string): boolean;
  cancelRunning(): string[];
  create(kind: string, input: JsonValue, mode: WorkMode, controller: AbortController): string;
  detach(jobId: string, kind: string, promise: Promise<JsonValue | undefined>): void;
}

export interface BackgroundJobPlaneDeps {
  readonly jobs: BackgroundJobStore;
  readonly jobRunner: BackgroundJobControl;
  /** The RAW tool surface a retry re-invokes through — raw, so a re-drive
   *  cannot detach a second job on top of the one it is replaying. */
  readonly rawTools: (mode: WorkMode) => ToolSet;
  readonly logActivity: (event: string, detail?: string) => void;
}

export type RetryOutcome = { ok: boolean; jobId?: string; error?: string };

/** One job's record, or null when it is unknown. */
export function jobResult(jobs: BackgroundJobStore, jobId: string): BackgroundJob | null {
  try { return jobs.get(jobId); } catch { return null; }
}

/** Recent jobs, newest first. */
export function listBackgroundJobs(jobs: BackgroundJobStore, limit = 20): BackgroundJob[] {
  try { return jobs.list(limit); } catch { return []; }
}

/** Hard-cancel a running job: abort the underlying work (its merged
 *  AbortSignal) and mark it cancelled. The detach fiber sees 'cancelled' and
 *  won't relabel the abort rejection or wake the agent. */
export function cancelBackgroundJob(jobRunner: BackgroundJobControl, jobId: string) {
  return { ok: jobRunner.cancel(jobId) };
}

/** Remove a settled job from the registry (an operator dismiss). */
export function dismissBackgroundJob(jobs: BackgroundJobStore, jobId: string) {
  try { jobs.dismiss(jobId); return { ok: true }; } catch { return { ok: false }; }
}

/** Clear all settled jobs, keeping running ones. */
export function clearBackgroundJobs(jobs: BackgroundJobStore) {
  try { jobs.clearSettled(); return { ok: true }; } catch { return { ok: false }; }
}

/**
 * Re-run a settled job's tool with its original input as a fresh background
 * job. Detaches immediately — the work already proved slow.
 */
export function retryBackgroundJob(deps: BackgroundJobPlaneDeps, jobId: string): RetryOutcome {
  const job = deps.jobs.get(jobId);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.status === 'running') return { ok: false, error: 'job still running' };
  const inputJson = deps.jobs.getInput(jobId);
  if (inputJson == null) return { ok: false, error: 'no stored input to retry' };
  const tool = deps.rawTools(job.workMode)[job.kind];
  if (!tool?.execute) return { ok: false, error: `tool "${job.kind}" unavailable` };
  let input: JsonValue;
  try { input = parseJsonValue(inputJson); } catch { return { ok: false, error: 'stored input is unreadable' }; }
  const controller = new AbortController();
  const newId = deps.jobRunner.create(job.kind, input, job.workMode, controller);
  deps.logActivity('bg_job_retry', `${jobId} → ${newId}`);
  const promise = Promise.resolve(tool.execute(input, {
      abortSignal: controller.signal, toolCallId: newId, messages: [],
    })).then((result) => result === undefined ? undefined : decodeJsonValue({ value: result }));
  deps.jobRunner.detach(newId, job.kind, promise);
  return { ok: true, jobId: newId };
}

export interface CancelWorkOutcome {
  ok: true;
  cancelledJobs: string[];
  abortedTools: number;
}

export interface CancelWorkDeps {
  readonly jobRunner: Pick<BackgroundJobControl, 'cancelRunning'>;
  /** The foreground tool calls currently holding an abort handle. */
  readonly activeToolControllers: Set<AbortController>;
  readonly broadcast: (payload: string) => void;
  /** Where a backend settles its own turn state once the abort is issued —
   *  clearing an in-flight flag, writing an activity line. Runs before the
   *  broadcast so a client that reacts to it reads settled state. */
  readonly onCancelled?: (outcome: Omit<CancelWorkOutcome, 'ok'>) => void;
}

/** Stop visible work: abort foreground tool calls and cancel detached jobs. */
export function cancelCurrentWork(deps: CancelWorkDeps): CancelWorkOutcome {
  const cancelledJobs = deps.jobRunner.cancelRunning();
  let abortedTools = 0;
  for (const controller of deps.activeToolControllers) {
    if (!controller.signal.aborted) {
      try { controller.abort(new Error('cancelled by operator')); } catch { /* nop */ }
      abortedTools++;
    }
    deps.activeToolControllers.delete(controller);
  }
  deps.onCancelled?.({ cancelledJobs, abortedTools });
  try {
    deps.broadcast(JSON.stringify({
      type: 'work_cancelled',
      cancelledJobs,
      abortedTools,
      timestamp: Date.now(),
    }));
  } catch { /* no connected clients */ }
  return { ok: true, cancelledJobs, abortedTools };
}
