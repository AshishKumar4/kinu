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
 * file-tool.ts), and an exec-shaped result carries its exit code in the
 * `Error (exit N)` prefix this codebase's own renderer produced (execution/
 * exec-result.ts:72). A row that fits neither is reported as `unclassified`
 * rather than filed under a guess — an instrument that cannot explain a failure
 * must say so, because a wrong attribution costs more than an absent one.
 */

import * as v from 'valibot';
import { isFailingResultText } from '../execution/exec-result.js';
import { FAILURE_WITHOUT_ERROR, type RunEvent } from '../events/types.js';
import { JsonObjectSchema, parseJsonValue, type JsonValue } from '../utils/json.js';
import { tolerate } from '../obs/index.js';

/** The `file` tool's own reason vocabulary, as it appears on a result. */
const FileReasonSchema = v.picklist([
  'empty_anchor', 'not_found', 'ambiguous', 'overlap', 'no_change',
  'unread', 'stale', 'missing', 'io', 'bad_input',
]);

/**
 * Reasons a failure is the tool doing its job. Each one is a refusal the tool
 * made deliberately, having established that proceeding would be wrong:
 *
 *   not_found / ambiguous / empty_anchor / overlap — the anchor does not
 *     identify one span, so a splice would be a guess at where to write.
 *   no_change — the replacement equals what it replaces.
 *   unread / stale — the read-before-write contract: the caller does not know
 *     what it would discard.
 *   bad_input — the arguments do not describe an operation.
 *
 * `missing` and `io` are NOT here: a path that does not exist and a filesystem
 * that refused are things that went wrong, not decisions the tool made.
 */
const RefusalReasonSchema = v.picklist([
  'empty_anchor', 'not_found', 'ambiguous', 'overlap', 'no_change',
  'unread', 'stale', 'bad_input',
]);

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
 * (`preinstall`/`install`/`ensure`) and Proteus never asks for one, so `bun`,
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

/** One attributed failure. */
export interface ToolFailure {
  readonly tool: string;
  /** The dispatcher action, from the call's own args. Null for a tool that has
   *  no actions (`run`) or a call whose args did not survive as an object. */
  readonly action: string | null;
  /**
   * Why. `file` reasons come from the tool; `exit_<N>` is a command that ran
   * and exited N; `command_not_found` / `not_executable` / `timeout` are the
   * shell's own codes; `threw` is a tool that raised out of its own execute;
   * `returned_error` is a tool that answered with an error body instead of
   * raising one; `failed_without_error` is a tool that reported failure and said
   * nothing — a defect in the tool's own contract, and the class that used to be
   * recorded as a clean call; `unclassified` is a failure this cannot explain,
   * reported rather than filed under a guess.
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
  /** True when the workspace has no such program (exit 127). A PLATFORM gap —
   *  Proteus never asks Nimbus to install a runtime — so it is neither a tool
   *  defect nor the work failing. See {@link RUNTIME_ABSENT_REASON}. */
  readonly runtimeMissing: boolean;
}

/** Exit code from the prefix `formatExecResult` writes, or null. */
function exitCodeOf(text: string): number | null {
  const match = /^Error \(exit (-?\d+)\)/.exec(text.trimStart());
  if (!match?.[1]) return null;
  const code = Number.parseInt(match[1], 10);
  return Number.isNaN(code) ? null : code;
}

/**
 * The result as an object, on either backend. The cf sink stores the tool's
 * structured output as-is; the CLI sink renders it through `JSON.stringify`
 * first (chat.ts `renderToolResult`), so the same payload arrives as a JSON
 * string. Both are read here so an attribution is not backend-specific — the
 * defect class this whole tier exists to catch.
 */
function resultObject(result: JsonValue | undefined): Record<string, JsonValue> | null {
  const direct = v.safeParse(JsonObjectSchema, result);
  if (direct.success) return direct.output;
  const text = v.safeParse(v.string(), result);
  if (!text.success || !text.output.trimStart().startsWith('{')) return null;
  const parsed = tolerate(() => parseJsonValue(text.output), 'malformed-input');
  const object = v.safeParse(JsonObjectSchema, parsed);
  return object.success ? object.output : null;
}

/**
 * Attribute one completed call, or null when it did not fail.
 *
 * Two kinds of failure and both are read, because counting only the first was
 * a real defect: `error` is the TRANSPORT discriminator — the tool threw — and
 * a command that ran and exited non-zero is an ordinary SUCCESSFUL result whose
 * text begins `Error (exit N)`. A reader consulting only `error` scored a
 * failing build as a success.
 */
export function classifyToolFailure(
  row: Extract<RunEvent, { type: 'tool_call_end' }>,
): ToolFailure | null {
  const args = v.safeParse(JsonObjectSchema, row.args);
  const action = args.success ? v.safeParse(v.string(), args.output.action) : null;
  // `runtimeMissing` defaults false here so only the one branch that can prove
  // it — the shell's own 127 — ever sets it.
  const base = {
    tool: row.name, action: action?.success ? action.output : null, runtimeMissing: false,
  };

  const threw = row.error != null && row.error !== '';
  const resultText = v.safeParse(v.string(), row.result);
  const failingResult = resultText.success && isFailingResultText(resultText.output);
  const object = resultObject(row.result);
  const objectReason = object ? v.safeParse(FileReasonSchema, object.reason) : null;
  // A structured `{error, …}` payload is a failure however it is carried: the
  // cf sink keeps it an object, where `isFailingResultText` never sees it.
  const failingObject = object !== null && object.error !== undefined;
  if (!threw && !failingResult && !failingObject) return null;

  if (objectReason?.success) {
    return {
      ...base,
      reason: objectReason.output,
      refused: v.is(RefusalReasonSchema, objectReason.output),
      workFailed: false,
    };
  }

  const exit = resultText.success ? exitCodeOf(resultText.output) : null;
  if (exit !== null && exit !== 0) {
    const named = EXEC_REASON_BY_EXIT.get(exit);
    return {
      ...base,
      reason: named ?? `exit_${String(exit)}`,
      refused: false,
      // A named shell code means the work never ran. Any other non-zero exit is
      // the work itself failing — which on a repair task is the finding.
      workFailed: named === undefined,
      // 127 is the workspace lacking the program outright — a platform gap, and
      // the reason `bun test …` must not be counted as a failing suite.
      runtimeMissing: named === RUNTIME_ABSENT_REASON,
    };
  }

  if (threw) {
    return {
      ...base,
      reason: row.error === FAILURE_WITHOUT_ERROR ? 'failed_without_error' : 'threw',
      refused: false,
      workFailed: false,
    };
  }
  // The tool answered with an error instead of raising one. Its own bucket
  // rather than the residual: WHY is unknown, but WHERE is not, and calling that
  // unclassified would hide a whole class — every `execute_tools` block that
  // failed inside a runtime missing the method it called arrived exactly here.
  if (failingObject) return { ...base, reason: 'returned_error', refused: false, workFailed: false };
  return { ...base, reason: 'unclassified', refused: false, workFailed: false };
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
