/** Temporary-agent port and run contract; the subordinates plane implements it. */

import type { ErrorCode } from '../obs/error';
import type { SubordinateReportStatus } from '../events/hub/types';
import type { WorkMode } from './turn';
import type { RoleId } from './profile';
import * as v from 'valibot';
import type { SerializedMessage } from './heads';

/**
 * The conversation a child is forked from. The `kind` tag stays because the value is persisted in
 * an `agent_log` payload: a second shape must be a schema change, not a reinterpretation.
 */
export const SubordinateInheritedContextSchema = v.strictObject({
  kind: v.literal('fork'),
  messages: v.array(v.strictObject({
    id: v.string(),
    role: v.picklist(['system', 'user', 'assistant', 'tool']),
    content: v.string(),
    createdAt: v.number(),
    toolName: v.optional(v.string()),
  })),
});

export type SubordinateInheritedContext = v.InferOutput<typeof SubordinateInheritedContextSchema>;

export function subordinateBirthContext(
  messages: SerializedMessage[] | undefined,
): SubordinateInheritedContext | undefined {
  return messages === undefined ? undefined : { kind: 'fork', messages };
}

/** The lifetime a task-lifetime hire is listed under. */
export const TEMPORARY_LIFETIME = 'task';

export interface TemporaryRunRequest {
  /** Already resolved by the caller's profile authority. */
  readonly role: RoleId;
  readonly roleLabel: string;
  readonly task: string;
  readonly inheritedContext?: SerializedMessage[];
  /** Workspace paths the child reads itself; programmatic callers only, not model-facing. */
  readonly contextRefs?: readonly string[];
  readonly mode: WorkMode;
  readonly signal?: AbortSignal;
}

/**
 * One shape once the child exists, whether it answered, failed, or was cancelled; `reason`
 * appears only on failure.
 */
export interface TemporaryRunOutcome {
  readonly status: 'completed' | 'failed';
  readonly agent: string;
  readonly lifetime: typeof TEMPORARY_LIFETIME;
  readonly role: string;
  readonly answer: string;
  /** `none` means the child was never created; `kept` history is read via the agent name. */
  readonly transcript: 'kept' | 'none';
  readonly elapsed_ms: number;
  readonly reason?: ErrorCode;
}

/** A refusal raised before the child exists, so there is no agent to report on. */
export interface TemporaryRunRefusal {
  readonly reason: ErrorCode;
  readonly error: string;
}

/**
 * No `active()`/`history()`: the one roster (`agents.list`) already answers both.
 * Optional in the type, required wherever a backend wires a roster.
 */
export interface TemporaryAgentPort {
  /**
   * Provision a child, run it to its single answer, release it. No elapsed bound: it ends on the
   * answer or `signal`. A task child emits exactly one run-settling report per way its turn can
   * end; a mid-task `progress` note ({@link temporaryRunSettles}) must not discharge it.
   */
  run(request: TemporaryRunRequest): Promise<TemporaryRunOutcome | TemporaryRunRefusal>;
  /**
   * Hand one report to the run waiting on it. `false` means no live caller, so the ingress
   * publishes it as an ordinary `subordinate_report` event.
   */
  settle(input: {
    readonly name: string;
    readonly taskEventId: string | null;
    readonly status: SubordinateReportStatus;
    readonly content: string;
    readonly origin: 'report_tool' | 'turn_end';
  }): boolean;
}
