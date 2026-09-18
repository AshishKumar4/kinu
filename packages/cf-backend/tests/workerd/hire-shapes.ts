/**
 * The values the hire tier shares across its three sides.
 *
 * Separate from `hire-probe.ts` because that file IS a worker module: workerd's
 * module map accepts only functions and exported handlers as named exports, so
 * a string constant exported from the probe fails the runtime at startup
 * ("Incorrect type for map entry"). The same split `two-turn-shapes.ts` makes,
 * for the same reason.
 */

/** The answer the child's model gives, so a transcript read and a resolved
 *  tool result can both be matched to the child's own words. */
export const CHILD_ANSWER = 'CHILD-ANSWER-42';

/** The mission the root's authored hire carries. */
export const HIRE_MISSION = 'HIRE-BRIEF-ONE-LINE';

/** The root's model id for the task-hire lane. */
export const HIRE_ROOT_MODEL = 'hire-root';

/** The root's model id for the durable hire + message lane. */
export const HIRE_DURABLE_MODEL = 'hire-root-durable';

/** The CHILD's model id. A hosted actor takes its model from the profile
 *  catalog's tier rather than the workspace pin, so the fixture authors an
 *  account catalog whose default tier is this spec — which puts the child on
 *  the same HTTP lane the two-turn tier already proves, instead of the direct
 *  Workers AI binding. */
export const HIRE_CHILD_MODEL = 'hire-child';

/** What the child's model does on its turn. */
export type ChildScript = 'answer' | 'throw' | 'park';

/** One `agent_log` delegation row, reduced to what a bound assertion needs. */
export interface LogRow {
  readonly actorId: string;
  readonly id: string;
  readonly variant: string;
  readonly turnId: string | null;
  readonly consumedAt: number | null;
  readonly kind: string;
  readonly bodyLength: number;
  /** The admitted body itself, so a re-admission loop can be told apart from
   *  legitimately distinct tasks by what the rows SAY. */
  readonly body: string;
}

/** One roster row, including dismissed ones. */
export interface RosterRow {
  readonly actorId: string;
  readonly name: string;
  readonly lifetime: string;
  readonly status: string;
  readonly taskEventId: string | null;
}

/** How many turns each actor actually opened. */
export interface TurnCount {
  readonly actorId: string;
  readonly runs: number;
}

/** What one drive observed, all of it read out of the product's storage. */
export interface HireObservation {
  readonly rootActorId: string;
  readonly roster: readonly RosterRow[];
  readonly log: readonly LogRow[];
  readonly turns: readonly TurnCount[];
  readonly toolResults: readonly string[];
  readonly transcript: readonly string[];
}
