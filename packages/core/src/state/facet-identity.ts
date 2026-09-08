/** Persists one root-validated facet identity. It never owns a directory. */
import * as v from 'valibot';
import { ActorIdentitySchema, ActorReferenceSchema, sameActorReference, type ActorIdentity, type ActorReference } from './actor-handle';
import { parseJsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import type { SqlExec } from '../types/primitives';

export interface FacetIdentityRow {
  readonly ownerUserId: string | null;
  readonly capabilityToken: string | null;
  readonly parentWorkspace: string | null;
  readonly actor: ActorReference | null;
  readonly name: string | null;
  readonly storageKey: string | null;
}

const EMPTY: FacetIdentityRow = Object.freeze({ ownerUserId: null, capabilityToken: null, parentWorkspace: null, actor: null, name: null, storageKey: null });
const StoredFacetIdentitySchema = v.object({
  user_id: v.string(), capability_token: v.nullable(v.string()),
  parent_workspace: v.string(), actor_reference: v.string(),
  logical_name: v.string(), storage_key: v.string(),
});

export class FacetIdentity {
  private schemaReady = false;
  private cached: FacetIdentityRow | null = null;

  constructor(private readonly sql: SqlExec) {}

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS actor_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT, capability_token TEXT,
      parent_workspace TEXT, actor_reference TEXT, logical_name TEXT, storage_key TEXT
    )`);
    this.schemaReady = true;
  }

  read(): FacetIdentityRow {
    if (this.cached) return this.cached;
    this.ensureSchema();
    const rows = this.sql.exec(`SELECT user_id, capability_token, parent_workspace, actor_reference, logical_name, storage_key
      FROM actor_identity WHERE id = 1`).toArray();
    if (!rows[0]) return EMPTY;
    const parsed = v.safeParse(StoredFacetIdentitySchema, rows[0]);
    if (!parsed.success) throw new KinuError('io', 'The stored facet identity is malformed.');
    const row = parsed.output;
    this.cached = Object.freeze({
      ownerUserId: row.user_id, capabilityToken: row.capability_token, parentWorkspace: row.parent_workspace,
      actor: Object.freeze(v.parse(ActorReferenceSchema, parseJsonValue(row.actor_reference))),
      name: row.logical_name, storageKey: row.storage_key,
    });
    return this.cached;
  }

  seed(input: { actor: ActorIdentity; ownerUserId: string; parentWorkspace: string; capabilityToken: string | null }): void {
    const actor = v.parse(ActorIdentitySchema, input.actor);
    const current = this.read();
    if (current.actor) {
      if (!sameActorReference(current.actor, actor) || current.name !== actor.name || current.storageKey !== actor.storageKey
        || current.ownerUserId !== input.ownerUserId || current.parentWorkspace !== input.parentWorkspace) {
        throw new KinuError('denied', 'The facet identity is immutable.');
      }
      return;
    }

    const reference = { actorId: actor.actorId, workspaceId: actor.workspaceId, parentActorId: actor.parentActorId };
    this.sql.exec(`INSERT INTO actor_identity (id, user_id, capability_token, parent_workspace, actor_reference, logical_name, storage_key)
      VALUES (1, ?, ?, ?, ?, ?, ?)`, input.ownerUserId, input.capabilityToken, input.parentWorkspace, JSON.stringify(reference), actor.name, actor.storageKey);
    this.cached = null;
  }

  setOwner(ownerUserId: string, capabilityToken: string | null): void {
    const current = this.read();
    if (!current.actor) throw new KinuError('missing', 'The facet has no registered actor identity.');
    if (current.ownerUserId !== ownerUserId) throw new KinuError('denied', 'Facet ownership is immutable.');
    this.sql.exec('UPDATE actor_identity SET capability_token = ? WHERE id = 1', capabilityToken);
    this.cached = null;
  }

  invalidate(): void {
    this.cached = null;
    this.schemaReady = false;
  }

  ownerUserId(): string | null { return this.read().ownerUserId; }
  capabilityToken(): string | null { return this.read().capabilityToken; }
  parentWorkspace(): string | null { return this.read().parentWorkspace; }
}
