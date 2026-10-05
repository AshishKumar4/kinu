/**
 * Background-job control plane above BackgroundJobRunner: list, inspect, cancel, retry, dismiss,
 * and the foreground abort. Cancelling detached work always takes a job id.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';

import type { BackgroundJob, BackgroundJobStore } from '../jobs/store';
import type { JobOutputFeeds, JobOutputTail } from '../jobs/live-output';
import { CALL_JOB_OPTION, type CallJob } from '../tools/call-job';
import type { BackgroundRetryRequest } from '../jobs/runner';
import type { WorkMode } from '../types/turn';
import { decodeJsonValue, parseJsonValue, type JsonValue } from '../utils/json';
import { resumableAgentsInput } from '../delegation/agents-tool';
import { Effect } from 'effect';
import { renderThrownChain, settle, settleSync } from '../obs/index';

/** BackgroundJobRunner's surface as this plane uses it. `cancelRunning` is deliberately absent:
 *  nothing here stops a job whose id it was not given. */
export interface BackgroundJobControl {
  cancel(jobId: string): Promise<boolean>;
  createRetry(request: BackgroundRetryRequest): string | null;
  detach(jobId: string, kind: string, promise: Promise<JsonValue | undefined>): void;
  readonly output: JobOutputFeeds;
}

export interface BackgroundJobPlaneDeps {
  readonly jobs: BackgroundJobStore;
  readonly jobRunner: BackgroundJobControl;
  /** The job owner's raw tools, so a retry cannot detach a second job on top of the one it replays. */
  readonly rawTools: (mode: WorkMode) => Promise<ToolSet>;
  readonly logActivity: (event: string, detail?: string) => void;
}

export type RetryOutcome = { ok: boolean; jobId?: string; error?: string };

export function jobResult(jobs: BackgroundJobStore, jobId: string): BackgroundJob | null {
  return jobs.get(jobId);
}

export type ListedBackgroundJob = BackgroundJob & { readonly output?: JobOutputTail };

export function listBackgroundJobs(
  jobs: BackgroundJobStore, limit = 20, output?: (jobId: string) => JobOutputTail | undefined,
): ListedBackgroundJob[] {
  return jobs.list(limit).map((job) => {
    const status = job.status === 'running' && job.serves !== null ? 'serving' : job.status;
    const tail = job.status === 'running' ? output?.(job.id) : undefined;

    return { ...job, status, ...(tail !== undefined && { output: tail }) };
  });
}

/** Abort a running job, mark it cancelled, and wake the agent. Awaited: the wake is part of the
 *  cancel, so the operator and the agent never disagree about whether the job is in flight. */
export async function cancelBackgroundJob(jobRunner: BackgroundJobControl, jobId: string) {
  return { ok: await jobRunner.cancel(jobId) };
}

export interface JobCommandOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

export function dismissBackgroundJob(jobs: BackgroundJobStore, jobId: string): JobCommandOutcome {
  return settleSync(Effect.try({ try: () => { jobs.dismiss(jobId); }, catch: (cause) => ({ cause }) }).pipe(Effect.match({
    onSuccess: (): JobCommandOutcome => ({ ok: true }),
    onFailure: (failed): JobCommandOutcome => ({ ok: false, error: renderThrownChain(failed) }),
  })));
}

export function clearBackgroundJobs(jobs: BackgroundJobStore): JobCommandOutcome {
  return settleSync(Effect.try({ try: () => { jobs.clearSettled(); }, catch: (cause) => ({ cause }) }).pipe(Effect.match({
    onSuccess: (): JobCommandOutcome => ({ ok: true }),
    onFailure: (failed): JobCommandOutcome => ({ ok: false, error: renderThrownChain(failed) }),
  })));
}

/**
 * Re-run a settled job's tool with its stored input as a fresh background job. Input goes through
 * the same `resumableAgentsInput` narrowing as the evict-resume path; declined kinds replay as stored.
 */
export async function retryBackgroundJob(deps: BackgroundJobPlaneDeps, jobId: string): Promise<RetryOutcome> {
  return await settle(Effect.gen(function* () {
    const job = deps.jobs.get(jobId);

    if (!job) return { ok: false, error: 'job not found' };

    if (job.status === 'running') return { ok: false, error: 'job still running' };

    if (job.retriedBy) return { ok: false, error: `job already retried as ${job.retriedBy}` };
    const inputJson = deps.jobs.getInput(jobId);

    if (inputJson == null) return { ok: false, error: 'no stored input to retry' };
    const tool = (yield* Effect.promise(() => deps.rawTools(job.workMode)))[job.kind];

    if (!tool?.execute) return { ok: false, error: `tool "${job.kind}" unavailable` };

    const stored = yield* Effect.try({ try: () => parseJsonValue(inputJson), catch: (cause) => ({ cause }) }).pipe(Effect.match({
      onSuccess: (value) => ({ readable: true as const, value }),
      onFailure: (failed) => ({ readable: false as const, why: renderThrownChain(failed) }),
    }));

    if (!stored.readable) return { ok: false, error: `stored input is unreadable: ${stored.why}` };
    let input: JsonValue = stored.value;

    const translated = resumableAgentsInput(job.kind, input);

    if (translated) input = decodeJsonValue({ value: translated });
    const controller = new AbortController();
    const newId = deps.jobRunner.createRetry({ sourceId: jobId, kind: job.kind, input, mode: job.workMode, controller });

    if (newId === null) {
      const replacement = deps.jobs.get(jobId)?.retriedBy;

      return { ok: false, error: replacement ? `job already retried as ${replacement}` : 'job retry could not be reserved' };
    }

    deps.logActivity('bg_job_retry', `${jobId} -> ${newId}`);
    const output = deps.jobRunner.output.open(newId);
    output.live();
    const retried: CallJob = { id: newId, detached: AbortSignal.abort(), output };

    const options: ToolExecutionOptions<unknown> & { [CALL_JOB_OPTION]: CallJob } = {
      abortSignal: controller.signal, toolCallId: newId, messages: [], context: undefined, [CALL_JOB_OPTION]: retried,
    };

    const promise = Promise.resolve(tool.execute(input, options))
      .finally(() => { output.end(); })
      .then((result) => result === undefined ? undefined : decodeJsonValue({ value: result }));

    deps.jobRunner.detach(newId, job.kind, promise);

    return { ok: true, jobId: newId };
  }));
}

/** `unknown` is an honest daemon result, not success: the request may still be running. */
export interface DeviceStopOutcome {
  /** The daemon's process-group id; absent only when the sweep itself could not run. */
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
  /** Abort the in-flight LLM request first: tool controllers alone cannot stop a streaming model. */
  readonly cancelChats?: () => void | Promise<void>;
  readonly activeToolControllers: Set<AbortController>;
  readonly broadcast: (payload: string) => void;
  /** Absent on hosts with no device authority. */
  readonly stopDeviceCommands?: () => Promise<readonly DeviceStopOutcome[]>;
  /** Settles backend turn state; runs before the broadcast so clients read settled state. */
  readonly onCancelled?: (outcome: Omit<CancelWorkOutcome, 'ok'>) => void;
}

/**
 * Stop the displayed turn: abort the LLM request, then its foreground tool calls. Queued steers
 * stay queued. Never calls `jobRunner.cancelRunning()`: detached jobs outlive their turn and
 * stop only through {@link cancelBackgroundJob} by id.
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

  // One awaited sweep before one frame; device unavailability is a failed outcome, never a throw.
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
