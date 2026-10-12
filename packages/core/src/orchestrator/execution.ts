/**
 * One execution of an agent (design v2 §2-§3): the logical turn it answers and the run answering it. Chat input,
 * Retry, recovery and a head's `#n` rounds all name one this way; the canonical claim's epoch only fences it.
 *
 * Its life: the agent claims the key as `preparing`, minting the epoch, which is the {@link TurnCapability}; the
 * workspace opens the turn under it and prepares it; the agent binds the final profile, freezing it with its authority
 * inputs under the key (`FrozenAuthority`) before any model or tool work. Recovery of a `preparing` claim prepares again
 * under the next epoch (nothing ran); recovery of a bound one rebuilds from what it froze and resolves nothing. Its
 * close names its opening (`ClosedExecution`), which outlives Stop and any newer execution.
 */
import type { TaskPlan } from '../tools/task-plan-scope';
import type { TierId } from '../types/profile';
import type { TurnAuthorship, WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import type { TurnOpening } from './chat-session';

export interface ExecutionKey {
  readonly actorId: string;
  /** The logical turn: a chat turn's input id, a head round's `turnId#n`. */
  readonly turnId: string;
  /** The run answering it: a Retry mints a new one, recovery keeps it. */
  readonly runId: string;
}

/** Carried by an execution's preparation, steps and tool calls. Refused once Stop, its close, or a later epoch
 *  supersedes it. Its epoch is the opening's place in the agent's sequence, minted as the agent prepares its claim. */
export interface TurnCapability extends ExecutionKey {
  readonly epoch: number;
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
