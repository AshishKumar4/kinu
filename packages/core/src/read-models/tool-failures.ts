/**
 * Why a tool call failed — the attribution read off `tool_call_end` rows.
 *
 * The question this answers is "why do the tool calls fail", and until the rows
 * carried `args` it was unanswerable from the ledger: a durable row named the
 * tool and carried a bit, so a run with 34 failures could report `file×13` and
 * never which action, still less which of the nine distinct things a `file`
 * call can refuse to do.
 *
 * The distinction that matters more than the count: a tool that REFUSED
 * correctly and a tool that BROKE are opposite facts, and a rate that pools
 * them is worse than no rate. `file` refusing an edit whose `old_text` is not
 * in the file is the FAIL-loudly contract working — the alternative is a
 * guessed splice. A repair task's `run pytest` exiting 1 is the agent
 * discovering the broken test it was sent to fix; counting that as a tool
 * failure indicts the agent for doing its job. Neither is a defect, and both
 * were inside the same number.
 *
 * Nothing here guesses. Every reason is one the producing code computed and
 * wrote: `file` puts its `FileToolFailureReason` on the result (tools/
 * file-tool.ts), the `agents` fork puts `bad_input` on a call whose arguments do
 * not describe a fork (tools/agents-tool.ts), the `run` tool puts an `ErrorCode`
 * on every refusal it returns (tools/builtins.ts), and an exec-shaped result
 * carries its exit code in the `Error (exit N)` prefix this codebase's own
 * renderer produced (execution/exec-result.ts:72). A row that fits none of those
 * is reported as `unclassified` rather than filed under a guess — an instrument
 * that cannot explain a failure must say so, because a wrong attribution costs
 * more than an absent one.
 *
 * The reason vocabulary is SHARED with `obs/error.ts` rather than restated here.
 * A local picklist would cost immediately: the `run` tool's unprovisioned-runtime
 * refusal carries no reason such a list recognises, so a runtime that was never
 * there — a platform gap the agent did nothing to cause — would be reported as
 * `returned_error` with `refused: false`, in the `broke` bucket, indicting the
 * tool for correctly declining.
 */

import * as v from 'valibot';
import { FAILURE_WITHOUT_ERROR, type RunEvent } from '../events/types';
import { JsonObjectSchema } from '../utils/json';
import { CODE_IS_REFUSAL, ERROR_CODES } from '../obs/index';
import { FILE_REFUSAL_REASONS } from '../tools/file-edit';

/**
 * The reason vocabulary a tool writes onto its own result: every `ErrorCode`,
 * plus the file plane's anchor reasons. Read off ANY tool's payload, so it is not
 * one tool's private list.
 */
const ToolReasonSchema = v.picklist([...ERROR_CODES, ...FILE_REFUSAL_REASONS]);

/**
 * Whether a reason means the tool declined correctly rather than broke.
 *
 * The `ErrorCode` half is SPREAD from `obs/error.ts` rather than restated, so a
 * new code cannot reach this reader undecided: `CODE_IS_REFUSAL` is total over
 * `ErrorCode`, and adding a member there without a verdict does not compile.
 * Every key is a member of `ToolReasonSchema`'s own picklist, which is what makes
 * the lookup below total without an index signature.
 */
const REASON_IS_REFUSAL = {
  ...CODE_IS_REFUSAL,
  empty_anchor: true,
  not_found: true,
  ambiguous: true,
  overlap: true,
  no_change: true,
  unread: true,
  stale: true,
} satisfies Readonly<Record<v.InferOutput<typeof ToolReasonSchema>, boolean>>;

/**
 * Exit codes that mean the tool never ran the work, as opposed to running it
 * and finding it broken. 127 and 126 are the shell's own: no such command, and
 * found but not executable. 124 is `timeout(1)`'s.
 */
const EXEC_REASON_BY_EXIT = new Map([
  [127, 'command_not_found'],
  [126, 'not_executable'],
  [124, 'timeout'],
]);

/**
 * The workspace does not HAVE the program the agent asked for.
 *
 * Its own bucket, and not part of `broke`, because it is neither a tool defect
 * nor anything the model did wrong: Nimbus supports installable runtimes
 * (`preinstall`/`install`/`ensure`) and Kinu never asks for one, so `bun`,
 * `npm`, `git`, `python3`, `sh`, `bash`, `make`, `tsc` and `jq` all exit 127 in
 * every workspace the agent has ever had. Measured through the agent's own
 * `run` tool over 19 commands: only `node` (v20.0.0, /usr/local/bin/node) and
 * coreutils answered.
 *
 * Counting these as broken tools blames the model for a platform omission, and
 * counting them as the WORK failing is worse — it reads a missing interpreter as
 * the agent successfully finding a broken test. `bun test src/broken.test.ts` on
 * `ws-fix-broken` is exactly that call.
 *
 * 126 is deliberately NOT here: a program that exists but cannot be executed is
 * a different fact from one that is absent.
 */
const RUNTIME_ABSENT_REASON = 'command_not_found';

/**
 * Which part of the census a failure belongs to.
 *
 * The four are disjoint and the whole finding is which one a number sits in:
 * `refused` is the fail-loudly contract working, `work-failed` is a command that
 * ran and found something broken, `runtime-absent` is a platform gap, and `broke`
 * is the only part that is a candidate defect.
 */
export type ToolFailurePart = 'refused' | 'work-failed' | 'runtime-absent' | 'broke';

/**
 * The part a REASON belongs to — the one place that decision is made.
 *
 * `classifyToolFailure` sets `ToolFailure`'s three booleans from this, and
 * `toolFailurePartOfKey` reads it back off a persisted key, so a published
 * failure mix in a run record and the live census cannot disagree about what a
 * reason means. One function decides it, so a platform gap cannot land in
 * `broke` the way three parallel expressions would let it.
 *
 * A reason outside the shared vocabulary reads as `broke`, which is where
 * `unclassified` and `threw` belong anyway: this cannot explain it, and it says
 * so rather than guessing a kinder part.
 */
function partOfReason(reason: string): ToolFailurePart {
  if (/^exit_-?\d+$/.test(reason)) return 'work-failed';
  if (reason === RUNTIME_ABSENT_REASON) return 'runtime-absent';
  const known = v.safeParse(ToolReasonSchema, reason);
  if (!known.success) return 'broke';
  if (known.output === 'unavailable') return 'runtime-absent';
  return REASON_IS_REFUSAL[known.output] ? 'refused' : 'broke';
}

/** The reason and its three flags, so a branch below states the reason once. */
function attribute(reason: string): Pick<ToolFailure, 'reason' | 'refused' | 'workFailed' | 'runtimeMissing'> {
  const part = partOfReason(reason);
  return {
    reason,
    refused: part === 'refused',
    workFailed: part === 'work-failed',
    runtimeMissing: part === 'runtime-absent',
  };
}

/** One attributed failure. */
export interface ToolFailure {
  readonly tool: string;
  /** The dispatcher action, from the call's own args. Null for a tool that has
   *  no actions (`run`) or a call whose args did not survive as an object. */
  readonly action: string | null;
  /**
   * Why. An `ErrorCode` when the tool classified its own failure (`file`'s
   * reasons, the `run` tool's refusals — obs/error.ts); `exit_<N>` is a command
   * that ran and exited N; `command_not_found` / `not_executable` / `timeout` are
   * the shell's own codes; `threw` is a tool that raised out of its own execute;
   * `returned_error` is a tool that answered with an error body carrying no
   * classification; `failed_without_error` is a tool that reported failure and
   * said nothing — a defect in the tool's own contract, and the class that
   * keeps it from counting as a clean call; `unclassified` is a failure this
   * cannot explain, reported rather than filed under a guess.
   */
  readonly reason: string;
  /** True when the tool declined correctly rather than breaking. A command
   *  that ran and exited non-zero is neither — it is the WORK failing, and
   *  `workFailed` carries it. */
  readonly refused: boolean;
  /** True when the tool ran the work and the work itself failed: a failing
   *  test, a failing build. On a repair task this is the agent finding what it
   *  was sent to find, and it is not a defect in the harness or the tool. */
  readonly workFailed: boolean;
  /**
   * True when the environment the call addressed is not there: a program the
   * workspace does not have (exit 127, {@link RUNTIME_ABSENT_REASON}), or a
   * runtime that was never provisioned (`unavailable`).
   *
   * A PLATFORM gap in both spellings — Kinu never asks Nimbus to install a
   * runtime, and it never pre-provisions a sandbox — so it is neither a tool
   * defect nor the work failing, which is why it is its own part of the census
   * and reads as "runtime absent" in the eval report.
   */
  readonly runtimeMissing: boolean;
}

/** Attribute only the recorded invocation outcome, never a successful tool's data. */
export function classifyToolFailure(
  row: Extract<RunEvent, { type: 'tool_call_end' }>,
): ToolFailure | null {
  const args = v.safeParse(JsonObjectSchema, row.args);
  const action = args.success ? v.safeParse(v.string(), args.output.action) : null;
  const base = { tool: row.name, action: action?.success ? action.output : null };
  const outcome = row.outcome;
  if (outcome === undefined) {
    return row.error != null && row.error !== ''
      ? { ...base, ...attribute(row.error === FAILURE_WITHOUT_ERROR ? 'failed_without_error' : 'threw') }
      : null;
  }
  if (outcome.success) return null;
  const exit = outcome.execution?.exitCode;
  if (exit !== undefined && exit !== 0) {
    return { ...base, ...attribute(EXEC_REASON_BY_EXIT.get(exit) ?? 'exit_' + String(exit)) };
  }
  return { ...base, ...attribute(outcome.reason ?? 'unclassified') };
}

/**
 * The part a PERSISTED key belongs to — `toolFailureKey`'s own output, read back.
 *
 * A run record publishes the census as `tool·action·reason×N` text
 * (`toolOutcomes` in test-utils/agent-evals.ts), and a later reader — eval
 * triage — has to know which part each key sat in to say whether a failure is a
 * defect, a platform gap or the work failing. Reading it back through the same
 * policy the census used is what keeps the two verdicts one verdict.
 */
export function toolFailurePartOfKey(key: string): ToolFailurePart {
  return partOfReason(key.slice(key.lastIndexOf('·') + 1));
}

/**
 * `tool·action·reason` — the grouping key a distribution is counted over.
 * Action is omitted when the tool has none, so `run` does not read `run·null`.
 */
export function toolFailureKey(f: ToolFailure): string {
  return f.action === null ? `${f.tool}·${f.reason}` : `${f.tool}·${f.action}·${f.reason}`;
}

export interface ToolFailureCensus {
  /** Every failing call, in ledger order. */
  readonly failures: readonly ToolFailure[];
  /** Counts by `tool·action·reason`, heaviest first. */
  readonly byKey: readonly (readonly [string, number])[];
  /** Failures the tool declined correctly — the contract working. */
  readonly refused: number;
  /** Failures that are the WORK failing: a failing test, a failing build. */
  readonly workFailed: number;
  /** Failures where the workspace had no such program (exit 127) — a PLATFORM
   *  gap, not a defect in the tool and not the agent doing anything wrong. */
  readonly runtimeMissing: number;
  /** What is left: the tool broke, or this cannot say why. The only part of
   *  the count that is a candidate defect. */
  readonly broke: number;
}

/**
 * The census over a run's completed calls.
 *
 * Reported as four disjoint parts and never as one rate, because the whole
 * finding is which part a number sits in. `refused + workFailed +
 * runtimeMissing + broke === failures.length` by construction.
 */
export function censusToolFailures(
  rows: readonly Extract<RunEvent, { type: 'tool_call_end' }>[],
): ToolFailureCensus {
  const failures: ToolFailure[] = [];
  for (const row of rows) {
    const failure = classifyToolFailure(row);
    if (failure) failures.push(failure);
  }
  const counts = new Map<string, number>();
  for (const failure of failures) {
    const key = toolFailureKey(failure);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    failures,
    byKey: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    refused: failures.filter((f) => f.refused).length,
    workFailed: failures.filter((f) => f.workFailed).length,
    runtimeMissing: failures.filter((f) => f.runtimeMissing).length,
    broke: failures.filter((f) => !f.refused && !f.workFailed && !f.runtimeMissing).length,
  };
}
