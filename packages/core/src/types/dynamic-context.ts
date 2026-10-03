/** A decision parked on the user, so the agent knows a gated action waits on the human. */
export interface DynamicApproval {
  readonly id: string;
  readonly kind: string;
  readonly detail: string;
}

export interface MissingCapability {
  /** In the words the user configured it under. */
  readonly source: string;
  readonly reason: string;
}

/** `total` counts past the page, so the renderer states elision. */
export interface ActiveRoster<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** A tool lesson as a step lists it; the turn keeps the id and revision it was shown. */
export interface ShownLesson {
  readonly id: string;
  readonly revision: number;
  readonly line: string;
}

/** The roles and tiers this actor's `agents` tool takes, which stay out of the tool's own bytes. */
export interface DelegationChoices {
  /** `id: description`. */
  readonly roles: readonly string[];
  readonly tiers: readonly string[];
}
