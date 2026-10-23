/** Temporary-agent port and run contract; the subagents plane implements it. */

import type { ErrorCode } from '../obs/error';
import type { WorkMode } from './turn';
import type { RoleId } from './profile';
import * as v from 'valibot';
import type { SerializedMessage } from './heads';

/**
 * The conversation a child is forked from. The `kind` tag stays because the value is persisted in
 * an `agent_log` payload: a second shape must be a schema change, not a reinterpretation.
 */
export const SubagentInheritedContextSchema = v.strictObject({
  kind: v.literal('fork'),
  messages: v.array(v.strictObject({
    id: v.string(),
    role: v.picklist(['system', 'user', 'assistant', 'tool']),
    content: v.string(),
    createdAt: v.number(),
    toolName: v.optional(v.string()),
  })),
});

export type SubagentInheritedContext = v.InferOutput<typeof SubagentInheritedContextSchema>;

export function subagentBirthContext(
  messages: SerializedMessage[] | undefined,
): SubagentInheritedContext | undefined {
  return messages === undefined ? undefined : { kind: 'fork', messages };
}

export const TEMPORARY_LIFETIME = 'task';

export interface TemporaryRunRequest {
  /** Already resolved by the caller's profile authority. */
  readonly role: RoleId;
  readonly roleLabel: string;
  readonly task: string;
  /** What the hirer named it: its name is minted from this, and it shows as this. */
  readonly name?: string;
  readonly inheritedContext?: SerializedMessage[];
  /** Workspace paths the child reads itself; programmatic callers only, not model-facing. */
  readonly contextRefs?: readonly string[];
  readonly mode: WorkMode;
}

/** A task hire's result, returned at once; `failed` only when the child could not start. */
export interface TemporaryRunOutcome {
  readonly status: 'working' | 'failed';
  readonly agent: string;
  readonly lifetime: typeof TEMPORARY_LIFETIME;
  readonly role: string;
  readonly answer: string;
  /** `none` means the child was never created; `kept` history is read via the agent name. */
  readonly transcript: 'kept' | 'none';
  readonly reason?: ErrorCode;
}

/** No `active()`/`history()`: the one roster (`agents.list`) already answers both. Required wherever a backend
 *  wires a roster. */
export interface TemporaryAgentPort {
  /** Start a child on its brief and return; its settling report reaches the hirer's rail. A brief with no mission or
   *  role is refused (`bad_input`) before any child exists. */
  start(request: TemporaryRunRequest): Promise<TemporaryRunOutcome>;
  /** Called inside the child's turn, so it only schedules the retire. */
  release(name: string): void;
}
