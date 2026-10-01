// Where a trial's wall time went, from its evidence: the harness's timeline (its own phases and the
// arrival of every chunk of each turn's stream, on the machine that ran it) and the deployment's run
// ledger (each step's tokens and each wait on the model provider).
//
// A step's stream runs `start-step`, the model's chunks, the tool results, `finish-step`, and the
// deployment sends `start-step` with the model's first chunk. So a step's request, from the step
// before it (or from the turn's `start`) to its first chunk, holds the product's work between steps,
// any provider wait the ledger records for the step, and the model's time to first token, and the
// stream cannot tell the first and the last apart. Then the model generates until its last chunk,
// the tools run until the last tool result, and the step closes at `finish-step`. The prompt's time
// before the turn's `start` and after its last step is the product's; outside the prompt it is the
// harness's.
import * as v from 'valibot';
import { JsonValueSchema } from '@kinu.run/core';
import type { TimelineEntry } from './timeline';

/** The ledger fields a split reads; every row is kept, so an unread type still has its place in the order. */
export const LedgerRowSchema = v.looseObject({
  type: v.string(), runId: v.string(), eventIndex: v.number(),
  userMessage: v.optional(v.string()),
  usage: v.optional(v.looseObject({ output: v.optional(v.number()), reasoning: v.optional(v.number()) })),
  durationMs: v.optional(v.number()),
  waitMs: v.optional(v.number()),
});

export type LedgerRow = v.InferOutput<typeof LedgerRowSchema>;

export const TimelineEntrySchema = v.object({
  at: v.number(), mark: v.string(), until: v.optional(v.number()), count: v.optional(v.number()), detail: v.optional(JsonValueSchema),
});

/** Whose a chunk of a step is: the model's own output, or a tool's result. Step boundaries are neither. */
function chunkOwner(type: string): 'model' | 'tool' | undefined {
  switch (type) {
    case 'reasoning-start': case 'reasoning-delta': case 'reasoning-end':
    case 'text-start': case 'text-delta': case 'text-end':
    case 'tool-input-start': case 'tool-input-delta': case 'tool-input-available':
      return 'model';
    case 'tool-output-available': case 'tool-output-error':
      return 'tool';
    default:
      return undefined;
  }
}

export type StepTiming = {
  /** From the step before it, or the turn's `start`, to the model's first chunk, less `waitMs`: the product's work
   *  between steps and the model's time to first token. */
  requestMs: number;
  /** Provider waits the ledger records between the step before and this one's `step_finish`. */
  waitMs: number;
  generationMs: number;
  outputTokens: number;
  reasoningTokens: number;
  /** From the model's last chunk to the last tool result. */
  toolsMs: number;
  /** From the last model chunk or tool result to `finish-step`. */
  closeMs: number;
};

export type TurnTiming = {
  /** From the prompt leaving to the turn's `start` chunk, and from the last `finish-step` to the turn's end. */
  openMs: number;
  endMs: number;
  steps: StepTiming[];
  /** The harness's spans during this turn, by name: seed, ledger, settle, read, verify, evict. */
  harness: Record<string, number>;
  /** Polls until the workspace settled, and how many found it still busy. */
  polls: number;
  busyPolls: number;
  /** Of the settle span, the part before the last poll that found the workspace busy: the product still working
   *  after the turn's stream ended, a run the turn woke or one a dropped stream stopped showing. */
  busyMs: number;
};

export type TrialTiming = {
  wallMs: number;
  turns: TurnTiming[];
  /** The harness's spans outside any turn: build, open, arm, and the close. */
  harness: Record<string, number>;
  /** Steps the stream and the ledger disagree on: a split that pairs them is only as good as this is small. */
  unpairedSteps: number;
};

const endOf = (entry: TimelineEntry): number => entry.until ?? entry.at;

function add(record: Record<string, number>, key: string, ms: number): void {
  record[key] = (record[key] ?? 0) + ms;
}

/** A turn's steps, and when its stream started and its last step finished. */
type TurnSteps = { steps: StepTiming[]; started?: number; finished?: number };

/** A turn's steps, off the chunks that arrived during its prompt and the ledger rows of the run it started. */
function stepsOf(chunks: readonly TimelineEntry[], rows: readonly LedgerRow[]): TurnSteps {
  const finishes = rows.filter((row) => row.type === 'step_finish');
  const steps: StepTiming[] = [];
  let started: number | undefined;
  let finished: number | undefined;
  let entries: TimelineEntry[] = [];

  for (const chunk of chunks) {
    const type = chunk.mark.slice('chunk:'.length);

    // A socket that dropped mid-turn is answered with the turn's chunks again, all at once: arrival says nothing.
    if (type === 'replay' || (type === 'start' && started !== undefined)) break;

    if (type === 'start') {
      started = chunk.at;
    } else if (type === 'finish-step') {
      const model = entries.filter((entry) => chunkOwner(entry.mark.slice('chunk:'.length)) === 'model');
      const tools = entries.filter((entry) => chunkOwner(entry.mark.slice('chunk:'.length)) === 'tool');
      const from = finished ?? started ?? chunk.at;
      const modelStart = model[0]?.at ?? chunk.at;
      const modelEnd = Math.max(modelStart, ...model.map(endOf));
      const toolsEnd = Math.max(modelEnd, ...tools.map(endOf));
      const row = finishes[steps.length];
      const after = steps.length === 0 ? -1 : (finishes[steps.length - 1]?.eventIndex ?? Infinity);

      const waited = rows.filter((candidate) => row !== undefined && candidate.type === 'provider_wait'
        && candidate.eventIndex > after && candidate.eventIndex < row.eventIndex)
        .reduce((sum, candidate) => sum + (candidate.waitMs ?? 0), 0);

      const waitMs = Math.min(waited, modelStart - from);

      steps.push({
        requestMs: modelStart - from - waitMs, waitMs,
        generationMs: modelEnd - modelStart,
        outputTokens: row?.usage?.output ?? 0, reasoningTokens: row?.usage?.reasoning ?? 0,
        toolsMs: toolsEnd - modelEnd,
        closeMs: chunk.at - toolsEnd,
      });
      finished = chunk.at;
      entries = [];
    } else {
      entries.push(chunk);
    }
  }

  return { steps, started, finished };
}

/**
 * One trial's time, split. Turn `i` is the harness's `i`th prompt and the ledger's `i`th run a user
 * message started; the stream's steps pair with that run's `step_finish` rows in order.
 */
export function trialTiming(timeline: readonly TimelineEntry[], ledger: readonly LedgerRow[]): TrialTiming {
  const userRuns = ledger.filter((row) => row.type === 'run_start' && row.userMessage !== undefined).map((row) => row.runId);
  const harness: Record<string, number> = {};
  const turns: TurnTiming[] = [];
  let unpairedSteps = 0;
  let closed = false;
  let settledFrom = 0;

  for (const [index, entry] of timeline.entries()) {
    const turn = closed ? undefined : turns.at(-1);
    const until = entry.until;

    if (entry.mark === 'settle') settledFrom = entry.at;

    if (entry.mark === 'turn') {
      turns.push({ openMs: 0, endMs: 0, steps: [], harness: {}, polls: 0, busyPolls: 0, busyMs: 0 });
    } else if (entry.mark === 'close') {
      closed = true;
    } else if (entry.mark === 'poll' && turn !== undefined) {
      turn.polls += 1;

      if (v.is(v.object({ busy: v.literal(true) }), entry.detail)) {
        turn.busyPolls += 1;
        turn.busyMs = entry.at - settledFrom;
      }
    } else if (entry.mark.startsWith('chunk:') || until === undefined) {
      continue;
    } else if (turn === undefined) {
      add(harness, entry.mark, until - entry.at);
    } else if (entry.mark === 'prompt') {
      const chunks = timeline.slice(index + 1).filter((candidate) => candidate.mark.startsWith('chunk:') && candidate.at <= until);
      const runId = userRuns[turns.length - 1];
      const rows = ledger.filter((row) => row.runId === runId).sort((left, right) => left.eventIndex - right.eventIndex);
      const { steps, started, finished } = stepsOf(chunks, rows);

      turn.steps = steps;
      turn.openMs = (started ?? until) - entry.at;
      turn.endMs = until - (finished ?? started ?? until);
      unpairedSteps += Math.abs(rows.filter((row) => row.type === 'step_finish').length - steps.length);
    } else {
      add(turn.harness, entry.mark, until - entry.at);
    }
  }

  const ends = timeline.map(endOf);

  return { wallMs: Math.max(...ends) - Math.min(...timeline.map((entry) => entry.at)), turns, harness, unpairedSteps };
}

/** A trial's milliseconds by what they were spent on; `unattributed` is what no span or step covers. */
export function buckets(timing: TrialTiming) {
  const out: Record<string, number> = {};

  for (const turn of timing.turns) {
    add(out, 'product: prompt to the turn\'s stream', turn.openMs);
    add(out, 'product: last step to the turn\'s end', turn.endMs);

    for (const step of turn.steps) {
      add(out, 'product and model: step request to first token', step.requestMs);
      add(out, 'provider waits', step.waitMs);
      add(out, 'model: generation', step.generationMs);
      add(out, 'tools', step.toolsMs);
      add(out, 'product: step close', step.closeMs);
    }

    add(out, 'product: still working after the turn\'s stream ended', turn.busyMs);

    for (const [name, ms] of Object.entries(turn.harness)) add(out, `harness: ${name}`, name === 'settle' ? ms - turn.busyMs : ms);
  }

  for (const [name, ms] of Object.entries(timing.harness)) add(out, `harness: ${name}`, ms);

  add(out, 'unattributed', timing.wallMs - Object.values(out).reduce((sum, ms) => sum + ms, 0));

  return out;
}
