/**
 * Tool-failure attribution from `tool_call_end` rows, split into disjoint parts: a correct refusal,
 * the work failing, an absent runtime, or a break. Only reasons the producing code wrote are used;
 * anything else is `unclassified`. The vocabulary is shared with `obs/error.ts`.
 */

import * as v from 'valibot';
import { FAILURE_WITHOUT_ERROR, type RunEvent } from '../events/types';
import { JsonObjectSchema } from '../utils/json';
import { CODE_IS_REFUSAL, ERROR_CODES } from '../obs/index';
import { FILE_REFUSAL_REASONS } from '../tools/file-edit';
import type { BindingFailure } from '../types/tool-outcome';

const ToolReasonSchema = v.picklist([...ERROR_CODES, ...FILE_REFUSAL_REASONS]);

/** Spread from `CODE_IS_REFUSAL` (total over `ErrorCode`) so a new code cannot arrive undecided. */
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

/** Exit codes meaning the work never ran: shell 127/126, `timeout(1)` 124. */
const EXEC_REASON_BY_EXIT = new Map([
  [127, 'command_not_found'],
  [126, 'not_executable'],
  [124, 'timeout'],
]);

/** A missing program (exit 127) is a platform gap: Kinu provisions no Nimbus runtimes. 126 (present
 *  but not executable) is a different fact. */
const RUNTIME_ABSENT_REASON = 'command_not_found';

/** Disjoint census parts; only `broke` is a candidate defect. */
export type ToolFailurePart = 'refused' | 'work-failed' | 'runtime-absent' | 'broke';

/** The one place a reason's part is decided, shared by live census and persisted keys. Unknown
 *  reasons read as `broke`. */
function partOfReason(reason: string): ToolFailurePart {
  if (/^exit_-?\d+$/.test(reason)) return 'work-failed';

  if (reason === RUNTIME_ABSENT_REASON) return 'runtime-absent';
  const known = v.safeParse(ToolReasonSchema, reason);

  if (!known.success) return 'broke';

  if (known.output === 'unavailable') return 'runtime-absent';

  return REASON_IS_REFUSAL[known.output] ? 'refused' : 'broke';
}

function attribute(reason: string): Pick<ToolFailure, 'reason' | 'refused' | 'workFailed' | 'runtimeMissing'> {
  const part = partOfReason(reason);

  return {
    reason,
    refused: part === 'refused',
    workFailed: part === 'work-failed',
    runtimeMissing: part === 'runtime-absent',
  };
}

export interface ToolFailure {
  readonly tool: string;
  readonly action: string | null;
  /** An `ErrorCode`, `exit_<N>`, a shell exit code name, `threw`, `returned_error`,
   *  `failed_without_error`, or `unclassified`. */
  readonly reason: string;
  readonly refused: boolean;
  /** The work itself failed (a failing test or build), not the tool. */
  readonly workFailed: boolean;
  /** Exit 127 or `unavailable`: a platform gap, neither a tool defect nor the work failing. */
  readonly runtimeMissing: boolean;
}

/** Attribute only the recorded invocation outcome, never a successful tool's data. */
export function classifyToolFailure(
  row: Extract<RunEvent, { type: 'tool_call_end' }>,
): ToolFailure | null {
  const inner = row.outcome?.failures?.[0];

  if (inner !== undefined) return classifyBindingFailure(inner);
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

function classifyBindingFailure(failure: BindingFailure): ToolFailure {
  const exit = failure.execution?.exitCode;

  const reason = exit !== undefined && exit !== 0
    ? EXEC_REASON_BY_EXIT.get(exit) ?? 'exit_' + String(exit)
    : failure.reason ?? 'unclassified';

  return { tool: failure.tool, action: failure.action, ...attribute(reason) };
}

/** `tool·action·reason`; action omitted when the tool has none. */
export function toolFailureKey(f: ToolFailure): string {
  return f.action === null ? `${f.tool}·${f.reason}` : `${f.tool}·${f.action}·${f.reason}`;
}

export interface ToolFailureCensus {
  readonly failures: readonly ToolFailure[];
  readonly byKey: readonly (readonly [string, number])[];
  readonly refused: number;
  readonly workFailed: number;
  readonly runtimeMissing: number;
  readonly broke: number;
}

/** `refused + workFailed + runtimeMissing + broke === failures.length` by construction. */
export function censusToolFailures(
  rows: readonly Extract<RunEvent, { type: 'tool_call_end' }>[],
): ToolFailureCensus {
  const failures: ToolFailure[] = [];

  for (const row of rows) {
    if (row.outcome?.failures?.length) {
      failures.push(...row.outcome.failures.map(classifyBindingFailure));
      continue;
    }

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
