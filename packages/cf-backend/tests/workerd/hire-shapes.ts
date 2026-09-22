/**
 * Shared hire-tier values, kept out of `hire-probe.ts` because workerd's module map rejects non-handler named exports
 * from a worker module ("Incorrect type for map entry").
 */

export const CHILD_ANSWER = 'CHILD-ANSWER-42';

export const HIRE_MISSION = 'HIRE-BRIEF-ONE-LINE';

export const HIRE_ROOT_MODEL = 'hire-root';

export const HIRE_DURABLE_MODEL = 'hire-root-durable';

/** The catalog's default tier: not what the child runs on (the workspace pin), but every tier slot must be offered by `/v1/models`. */
export const HIRE_CHILD_MODEL = 'hire-child';

export type ChildScript = 'answer' | 'throw' | 'park';

export interface LogRow {
  readonly actorId: string;
  readonly id: string;
  readonly variant: string;
  readonly turnId: string | null;
  readonly consumedAt: number | null;
  readonly kind: string;
  readonly bodyLength: number;
  /** Tells a re-admission loop apart from distinct tasks. */
  readonly body: string;
}

export interface RosterRow {
  readonly actorId: string;
  readonly name: string;
  readonly lifetime: string;
  readonly status: string;
  readonly taskEventId: string | null;
}

export interface ActorRow {
  readonly actorId: string;
  readonly name: string;
  readonly kind: string;
  readonly retiringAt: number | null;
  readonly deletedAt: number | null;
}

export interface TurnCount {
  readonly actorId: string;
  readonly runs: number;
}

/** Everything read out of the product's storage. */
export interface HireObservation {
  readonly rootActorId: string;
  readonly roster: readonly RosterRow[];
  readonly log: readonly LogRow[];
  /** Retired included, so a zero count is distinguishable from a subject retired before the read. */
  readonly actors: readonly ActorRow[];
  readonly turns: readonly TurnCount[];
  readonly toolResults: readonly string[];
  readonly transcript: readonly string[];
}
