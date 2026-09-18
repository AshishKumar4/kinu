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

/** The spec the fixture writes as the account catalog's DEFAULT TIER. It is
 *  not what the child's turn runs on — every turn of a pinned workspace, a
 *  hosted actor's included, runs on the workspace pin — but every tier slot is
 *  checked against the provider listing at the turn boundary, so the default
 *  tier has to name a spec this fixture's `/v1/models` offers. */
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

/** One `workspace_actors` row: the identity plane behind a roster row, with
 *  the two lifecycle stamps a settled task hire moves. */
export interface ActorRow {
  readonly actorId: string;
  readonly name: string;
  readonly kind: string;
  readonly retiringAt: number | null;
  readonly deletedAt: number | null;
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
  /** Every identity row, retired ones included: what a roster row's actor IS
   *  at observe time, so a count that reads zero can be told apart from a
   *  count whose subject was retired before the read. */
  readonly actors: readonly ActorRow[];
  readonly turns: readonly TurnCount[];
  readonly toolResults: readonly string[];
  readonly transcript: readonly string[];
}
