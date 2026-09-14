/** The durable identity a slate's URL is built on, as Nimbus reserves it. */
export interface DurableAppIdentity {
  readonly port: number;
  readonly capability: string;
}

/**
 * Nimbus's durable-application seam, over a workspace.
 *
 * A reservation is a Nimbus-owned record in the workspace object's storage:
 * the port an owner holds and the capability its URL carries. It outlives the
 * process, the isolate and every redeploy; only `remove` ends it.
 */
export interface DurableApps {
  /**
   * Reserve the owner's port — or answer the one it already holds — with the
   * capability minted on first reservation and never rotated after. A
   * declared port that differs from the held one moves the identity: the old
   * reservation is released and a fresh one minted, so the old URL stops
   * resolving and the new one is handed out.
   */
  ensure(input: { readonly owner: string; readonly preferredPort?: number }): Promise<DurableAppIdentity>;
  /** End the owner's contract: its process, its reservation, its retained facet storage. */
  remove(owner: string): Promise<{ readonly removed: boolean; readonly port: number | null }>;
}
