export interface DurableAppIdentity {
  readonly port: number;
  readonly capability: string;
}

/** Reservations live in workspace storage and outlive process, isolate and redeploys; only `remove` ends them. */
export interface DurableApps {
  /** The capability is never rotated; a different declared port releases the old reservation and mints a new one. */
  ensure(input: { readonly owner: string; readonly preferredPort?: number }): Promise<DurableAppIdentity>;
  /** End the owner's contract: its process, its reservation, its retained facet storage. */
  remove(owner: string): Promise<{ readonly removed: boolean; readonly port: number | null }>;
}
