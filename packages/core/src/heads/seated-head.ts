import { REAL_CLOCK } from '../types/clock';
import type { MissionScope } from '../mission-budget';
import type { WebSearchProvider } from '../web/provider';
import type { WriteObserver } from '../vfs/write-events';
import type { HostedNodeSeat } from '../strategy/node-agent';
import type { SpawnedHead } from './controller';
import { buildHeadSystemPrompt, HeadCapture, type RunInference } from './head-inference';
import { CONFINED_BACKGROUNDABLE_TOOLS } from '../jobs/background-wrap';
import { stepLoopJobs } from '../jobs/step-loop';
import { buildHeadToolSet, type HeadSplitRequest, type HeadSplitResult, type HeadToolDeps } from './head-tools';
import type { ReportHeadDelta } from './head-stream';
import type { HeadInput, HeadReport, HeadStep } from './types';

export interface HeadSeat extends HostedNodeSeat {
  release(): Promise<void>;
  /** The host's per-actor queue, where it keeps one. */
  queue?<Result>(body: () => Promise<Result>): Promise<Result>;
}

export interface SeatedHeadDeps {
  seat(input: HeadInput, writes: WriteObserver): Promise<HeadSeat>;
  codemodeTool(seat: HeadSeat): HeadToolDeps['codemodeTool'];
  readonly webSearch: WebSearchProvider;
  split(seat: HeadSeat, input: HeadInput): (request: HeadSplitRequest) => Promise<HeadSplitResult>;
  mission(input: HeadInput, spec: string | null): MissionScope | null;
  reportStep(headId: string, seq: number, step: HeadStep): void | Promise<void>;
  readonly reportDelta: ReportHeadDelta;
}

/** The one head runner, on the head's own actor. */
export function spawnSeatedHead(input: HeadInput, deps: SeatedHeadDeps): SpawnedHead {
  const abort = new AbortController();
  let stopped: string | null = null;

  const run = async (seat: HeadSeat, capture: HeadCapture): Promise<HeadReport> => {
    // Long calls detach into its jobs; a settle wakes it.
    const { runner, next, detach } = stepLoopJobs({ actor: seat.actor, seat: seat.jobs });

    const inference: RunInference = {
      actor: seat.actor,
      runId: seat.runId,
      clock: REAL_CLOCK,
      sources: seat.sources,
      tools: buildHeadToolSet({
        input, capture, rt: seat.actor.runtime, conversations: seat.conversations,
        codemodeTool: deps.codemodeTool(seat), webSearch: deps.webSearch, split: deps.split(seat, input),
        jobs: { jobRunner: runner, backgroundable: CONFINED_BACKGROUNDABLE_TOOLS, mode: () => input.mode },
      }),
      brief: (callable) => buildHeadSystemPrompt(input, callable),
      capture,
      signal: abort.signal,
      isAborted: () => stopped !== null,
      abortReason: () => stopped,
      reportStep: (seq, step) => deps.reportStep(input.id, seq, step),
      reportDelta: deps.reportDelta,
      resume: next,
    };

    const mission = deps.mission(input, input.model ?? null);

    if (mission !== null) inference.mission = mission;

    try {
      return await seat.infer(input, inference);
    } finally {
      // Its jobs' results have no reader left.
      runner.cancelRunning();
      detach();
    }
  };

  return {
    id: input.id,
    run: async () => {
      const capture = new HeadCapture();
      const seat = await deps.seat(input, capture.files);

      try {
        return seat.queue === undefined ? await run(seat, capture) : await seat.queue(() => run(seat, capture));
      } finally {
        await seat.release();
      }
    },
    abort: async (reason: string) => {
      stopped = reason;
      abort.abort(new Error(reason));
    },
  };
}
