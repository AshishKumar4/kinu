/**
 * One execution of an agent (design v2 §2-§3): the logical turn it answers and the run answering it. Chat input,
 * Retry, recovery and a head's `#n` rounds all name one this way; the canonical claim's epoch only fences it.
 *
 * Its life: the agent admits the input and claims the key as `preparing` (epoch minted), which mints the
 * {@link TurnCapability}; the workspace opens the turn under it and prepares it; the agent resolves the final profile and
 * freezes it as the {@link FrozenTurn} with the claim's program and context before any model or tool work. Recovery of a
 * `preparing` claim prepares again under the next epoch (nothing ran); recovery of a bound one rebuilds from the frozen
 * turn and resolves nothing. Its close runs under a {@link CloseCapability}, which outlives Stop and any newer execution.
 */
import type { ResolvedTurnProfile } from '../profiles/resolve';
import type { TaskPlan } from '../tools/task-plan-scope';
import type { TierId } from '../types/profile';
import type { TurnAuthorship, WorkMode } from '../types/turn';
import type { JsonObject, JsonValue } from '../utils/json';
import type { AgentToolAnswer, AgentTurnActivity } from '../subordinates/agent-isolate';
import type { TurnOpening } from './chat-session';
import type { TurnFacts } from './turn-facts';

export interface ExecutionKey {
  readonly actorId: string;
  /** The logical turn: a chat turn's input id, a head round's `turnId#n`. */
  readonly turnId: string;
  /** The run answering it: a Retry mints a new one, recovery keeps it. */
  readonly runId: string;
}

/** Carried by an execution's preparation, steps and tool calls. Refused once Stop, its close, or a later epoch of the
 *  same key supersedes it. */
export interface TurnCapability extends ExecutionKey {
  readonly epoch: number;
}

/** Carried by an execution's close: preparing the answer, final charges, receipt repair and the handoff. It outlives
 *  Stop and a newer execution; each write it makes is idempotent per sequence. */
export interface CloseCapability extends ExecutionKey {
  readonly sequenceId: string;
}

/** The lane an execution was admitted in, which its surface's reach is decided from. */
export interface ExecutionLane {
  readonly authorship: TurnAuthorship;
  readonly mode: WorkMode;
  readonly parentDriven: boolean;
  /** The input's author-stamped metadata. */
  readonly driving?: JsonObject;
  readonly opening?: TurnOpening;
  readonly taskPlan?: TaskPlan;
  readonly explicitTier?: TierId;
  /** A plan of this agent's that the owner sent back with comments awaits its replies; decided by the agent at open. */
  readonly awaitsReply: boolean;
}

/** What an execution is rebuilt from: frozen in the agent's store before any model or tool work, never resolved again. */
export interface FrozenTurn {
  readonly key: ExecutionKey;
  readonly profile: ResolvedTurnProfile;
  readonly accounts: Readonly<Record<string, string>>;
  /** The account credentials revision it opened under; credentials held from another are read again. */
  readonly credentialsRevision: number | null;
  readonly facts: TurnFacts;
  readonly lane: ExecutionLane;
}

/** A remote effect's receipt, as the store its effect commits to answers for it. An absent receipt never started, so a
 *  re-ask runs it; an indeterminate one started and never settled, so a re-ask is refused. */
export type RemoteReceipt =
  | { readonly status: 'settled'; readonly output: JsonValue }
  | { readonly status: 'indeterminate' };

export interface TurnToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly activity: readonly AgentTurnActivity[];
}

/**
 * An execution's calls to its workspace, bound to its {@link TurnCapability} (design v2 §3): the workspace refuses each
 * once Stop, the execution's close or a later epoch of its key supersedes the capability. Receipts are read under its
 * close and never execute anything.
 */
export interface TurnPort {
  readonly capability: TurnCapability;
  executeTool(call: TurnToolCall): Promise<AgentToolAnswer>;
  /** The workspace's receipts for calls whose agent row is a pointer; a call with no receipt is absent. */
  receipts(callIds: readonly string[]): Promise<ReadonlyMap<string, RemoteReceipt>>;
}
