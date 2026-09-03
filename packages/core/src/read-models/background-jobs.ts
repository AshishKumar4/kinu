/**
 * The background-job control plane — what an operator can do to work that has
 * detached from the turn that started it.
 *
 * The lifecycle (detach → settle → wake → recover) is the BackgroundJobRunner's;
 * this is the layer above it: list, inspect, cancel, retry, dismiss, and the
 * foreground abort. Retry is the only one with real policy in it — it
 * reconstructs a tool invocation from the stored input and re-detaches it,
 * which is agent behaviour, not transport.
 *
 * Cancelling detached work always takes a job id. The foreground abort
 * (`cancelCurrentWork`) cannot reach a detached job at all — see its own note.
 *
 * `background_jobs` is a table `initWorkspaceSchema` creates, so a read that
 * fails is a broken workspace rather than an empty task list, and it says so
 * instead of showing the nothing an agent with no detached work shows.
 */

import type { ToolSet } from 'ai';

import type { BackgroundJob, BackgroundJobStore } from '../jobs/store';
import type { WorkMode } from '../prompting/surface';
import { decodeJsonValue, parseJsonValue, type JsonValue } from '../utils/json';
import { resumableAgentsInput } from '../tools/agents-tool';
import { renderThrownChain } from '../obs/index';

/** The three things the control plane asks of a running job registry —
 *  BackgroundJobRunner's public surface, named at the width this plane uses.
 *  `cancelRunning` is deliberately absent: nothing here stops a job whose id it
 *  was not given. */
export interface BackgroundJobControl {
  cancel(jobId: string): Promise<boolean>;
  createRetry(sourceId: string, kind: string, input: JsonValue, mode: WorkMode, controller: AbortController): string | null;
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
  return jobs.get(jobId);
}

/** Recent jobs, newest first. */
export function listBackgroundJobs(jobs: BackgroundJobStore, limit = 20): BackgroundJob[] {
  return jobs.list(limit);
}

/** Hard-cancel a running job: abort the underlying work (its merged
 *  AbortSignal), mark it cancelled, and wake the agent so it stops waiting on
 *  a result that will never arrive. Awaited, because the wake is part of the
 *  cancel: an operator who is told "cancelled" while the agent still believes
 *  the job is in flight is exactly the split this closed. */
export async function cancelBackgroundJob(jobRunner: BackgroundJobControl, jobId: string) {
  return { ok: await jobRunner.cancel(jobId) };
}

/** Remove a settled job from the registry (an operator dismiss). */
export function dismissBackgroundJob(jobs: BackgroundJobStore, jobId: string) {
  try {
    jobs.dismiss(jobId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: renderThrownChain({ cause: error }) };
  }
}

/** Clear all settled jobs, keeping running ones. */
export function clearBackgroundJobs(jobs: BackgroundJobStore) {
  try {
    jobs.clearSettled();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: renderThrownChain({ cause: error }) };
  }
}

/**
 * Re-run a settled job's tool with its original input as a fresh background
 * job. Detaches immediately — the work already proved slow.
 *
 * The stored row goes through the SAME narrowing the evict-resume path uses
 * (`resumableAgentsInput`), and that is the point rather than tidiness: a row is
 * recorded verbatim from whatever the model sent, so a row written before today's
 * surface can carry fields the strict parse now refuses, and one carrying
 * `action:'fork'` or a `settle` names a rung this surface no longer has. Replaying
 * it raw would meet the parse instead of the translation — a translate-on-replay
 * convention that held on the resume path and not on this one would be worse than
 * none, because the two paths differ only in who pressed the button.
 *
 * A kind the narrowing declines (`run`, `execute_tools`, a converse `agents` action)
 * is replayed exactly as stored, which is the behaviour this function already had.
 */
export function retryBackgroundJob(deps: BackgroundJobPlaneDeps, jobId: string): RetryOutcome {
  const job = deps.jobs.get(jobId);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.status === 'running') return { ok: false, error: 'job still running' };
  if (job.retriedBy) return { ok: false, error: `job already retried as ${job.retriedBy}` };
  const inputJson = deps.jobs.getInput(jobId);
  if (inputJson == null) return { ok: false, error: 'no stored input to retry' };
  const tool = deps.rawTools(job.workMode)[job.kind];
  if (!tool?.execute) return { ok: false, error: `tool "${job.kind}" unavailable` };
  let input: JsonValue;
  try { input = parseJsonValue(inputJson); }
  catch (error) { return { ok: false, error: `stored input is unreadable: ${renderThrownChain({ cause: error })}` }; }
  const translated = resumableAgentsInput(job.kind, input);
  if (translated) input = decodeJsonValue({ value: translated });
  const controller = new AbortController();
  const newId = deps.jobRunner.createRetry(jobId, job.kind, input, job.workMode, controller);
  if (newId === null) {
    const replacement = deps.jobs.get(jobId)?.retriedBy;
    return { ok: false, error: replacement ? `job already retried as ${replacement}` : 'job retry could not be reserved' };
  }
  deps.logActivity('bg_job_retry', `${jobId} → ${newId}`);
  const promise = Promise.resolve(tool.execute(input, {
      abortSignal: controller.signal, toolCallId: newId, messages: [],
    })).then((result) => result === undefined ? undefined : decodeJsonValue({ value: result }));
  deps.jobRunner.detach(newId, job.kind, promise);
  return { ok: true, jobId: newId };
}

/** One device command Stop asked its durable owner to cancel. `unknown` is an
 *  honest daemon result, not a success: the request may still be running. */
export interface DeviceStopOutcome {
  /** WHICH command this outcome is about — the identity the daemon registered
   *  its process group under. Every per-request answer carries it, so a `failed`
   *  one can be named to the owner and retried; it is absent only when the
   *  durable sweep itself could not run and the report is about no single
   *  command. */
  readonly requestId?: string;
  readonly outcome: 'terminated' | 'unknown' | 'failed';
  readonly detail?: string;
}

export interface CancelWorkOutcome {
  ok: true;
  abortedTools: number;
  deviceCommands: readonly DeviceStopOutcome[];
}

export interface CancelWorkDeps {
  /** Abort the in-flight LLM request itself, before the Kinu-level abort below.
   *  The framework holds the stream behind its own registry, so tool controllers
   *  alone cannot stop a model that is still writing. Absent on surfaces with
   *  no framework turn to abort. */
  readonly cancelChats?: () => void | Promise<void>;
  /** The foreground tool calls currently holding an abort handle. */
  readonly activeToolControllers: Set<AbortController>;
  readonly broadcast: (payload: string) => void;
  /** Cancel the device commands owned by this durable turn. Absent on hosts
   *  with no device authority; the caller receives the daemon's actual outcome
   *  for every command it did ask to stop. */
  readonly stopDeviceCommands?: () => Promise<readonly DeviceStopOutcome[]>;
  /** Where a backend settles its own turn state once the abort is issued —
   *  clearing an in-flight flag, writing an activity line. Runs before the
   *  broadcast so a client that reacts to it reads settled state. */
  readonly onCancelled?: (outcome: Omit<CancelWorkOutcome, 'ok'>) => void;
}
/**
 * Stop the DISPLAYED turn: abort the in-flight LLM request, then the foreground
 * tool calls it is holding. Queued steers stay queued — the turn settle path
 * re-queues what the model never saw as the next user-origin turn, so nothing
 * returns to the composer. Detached background jobs are deliberately untouched.
 *
 * This used to open with `jobRunner.cancelRunning()`, so pressing Stop on one
 * conversation killed every job that had detached from any earlier turn — a
 * two-hour search, a running release, a laptop command another turn started.
 * Detaching is what a job does when it outlives its turn, so "the turn you can
 * see is over" says nothing about it: the two lifetimes were joined only
 * because both reached the same button.
 *
 * Stopping detached work now needs the job's own identity —
 * {@link cancelBackgroundJob}, which the task roster's per-job control calls.
 * That is the whole property: a caller who names no job stops no job.
 */
export async function cancelCurrentWork(deps: CancelWorkDeps): Promise<CancelWorkOutcome> {
  await deps.cancelChats?.();
  let abortedTools = 0;
  for (const controller of deps.activeToolControllers) {
    if (!controller.signal.aborted) {
      controller.abort(new Error('cancelled by operator'));
      abortedTools++;
    }
    deps.activeToolControllers.delete(controller);
  }
  // ONE awaited sweep before ONE frame. A foreground Stop that said "done"
  // while its turn-owned laptop commands were still running was a split-brain
  // result; device unavailability is an honest empty/failed outcome, never a
  // reason to throw Stop or to sweep commands outside this turn.
  const deviceCommands = await deps.stopDeviceCommands?.() ?? [];
  deps.onCancelled?.({ abortedTools, deviceCommands });
  deps.broadcast(JSON.stringify({
    type: 'work_cancelled',
    abortedTools,
    deviceCommands,
    timestamp: Date.now(),
  }));
  return { ok: true, abortedTools, deviceCommands };
}
