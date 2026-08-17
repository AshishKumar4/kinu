/**
 * FacetIdentity — the one store for what a spawned facet knows about itself.
 *
 * A facet is seeded by its parent immediately after `subAgent()` returns, and a
 * parent and its facets are evicted JOINTLY after a couple of minutes idle, so
 * none of this may live on the instance: every value is persisted and re-read
 * after a cold activation.
 *
 * Replaces the `facet_owner` + `facet_parent` pair that ExplorationAgent used to
 * hand-roll. They were two tables, two `CREATE TABLE` sites and two lookup
 * helpers for one question — "who owns me, and whose workspace am I forking?" —
 * and the owner lookup carried a read-path `ALTER TABLE` plus a
 * `catch { return null }` to survive its own migration. Both are gone: one table,
 * created in one place, so a missing column is not a condition that can arise and
 * an owner lookup can no longer silently answer "unowned" (which is how a head
 * loses its identity and then resolves the wrong model).
 *
 * Reads are memoized because the head path asks for the owner and the parent on
 * every step; writes invalidate, so the capability-token push a parent fans out
 * takes effect immediately.
 */

export interface FacetIdentityRow {
  readonly ownerUserId: string | null;
  /** The SPAWNER's workspace capability token, so this facet reaches the owner's
   *  credentials as its parent workspace and is attenuated exactly as it is. */
  readonly capabilityToken: string | null;
  /** The ROOT workspace this facet forks — its exec planes, its files, and the
   *  journal every split in the tree writes to. Propagated UNCHANGED through
   *  recursive splits so an intermediate head never becomes the tree's root. */
  readonly parentWorkspace: string | null;
}

const EMPTY: FacetIdentityRow = { ownerUserId: null, capabilityToken: null, parentWorkspace: null };

export class FacetIdentity {
  private schemaReady = false;
  private cached: FacetIdentityRow | null = null;

  constructor(private readonly sql: SqlStorage) {}

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS facet_identity (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      user_id          TEXT,
      capability_token TEXT,
      parent_workspace TEXT
    )`);
    this.schemaReady = true;
  }

  read(): FacetIdentityRow {
    if (this.cached) return this.cached;
    this.ensureSchema();
    const rows = this.sql.exec<{
      user_id: string | null; capability_token: string | null; parent_workspace: string | null;
    }>(`SELECT user_id, capability_token, parent_workspace FROM facet_identity WHERE id = 1`).toArray();
    const row = rows[0];
    this.cached = row
      ? {
        ownerUserId: row.user_id,
        capabilityToken: row.capability_token,
        parentWorkspace: row.parent_workspace,
      }
      : EMPTY;
    return this.cached;
  }

  setOwner(ownerUserId: string, capabilityToken: string | null): void {
    this.ensureSchema();
    this.sql.exec(
      `INSERT INTO facet_identity (id, user_id, capability_token) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id,
                                     capability_token = excluded.capability_token`,
      ownerUserId, capabilityToken,
    );
    this.cached = null;
  }

  setParentWorkspace(agentName: string): void {
    this.ensureSchema();
    this.sql.exec(
      `INSERT INTO facet_identity (id, parent_workspace) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET parent_workspace = excluded.parent_workspace`,
      agentName,
    );
    this.cached = null;
  }

  ownerUserId(): string | null { return this.read().ownerUserId; }
  capabilityToken(): string | null { return this.read().capabilityToken; }
  parentWorkspace(): string | null { return this.read().parentWorkspace; }
}
