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
