/** Dynamic-context rows the prompt renders and the safety/events planes
 *  supply, declared at the platform layer so neither imports the prompt
 *  assembler. */

/** A decision parked on the user. Live so the agent stops guessing whether a
 *  gated action is stuck on it or on the human. */
export interface DynamicApproval {
  readonly id: string;
  /** What kind of decision is waiting — 'device consent', … */
  readonly kind: string;
  readonly detail: string;
}

/** One promised capability that is not reachable this turn, and why. */
export interface MissingCapability {
  /** What is missing, in the words the user configured it under. */
  readonly source: string;
  /** Why it is not here — a timeout, a crash, an auth failure. */
  readonly reason: string;
}
