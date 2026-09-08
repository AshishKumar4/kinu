import * as v from 'valibot';
import { KinuError } from '../obs/error';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { ActorReferenceSchema, bindActorHandle, type ActorHandle, type ActorReference } from './actor-handle';
import { tableExists } from '../identity/schema';
import { isExplorationActorKey, requireSubordinateActorName } from './actor-key';
export interface WorkspaceActorAuthority {
  readonly workspaceId: string;
  readonly ownerUserId: string | null;
}
const ActorSchema = v.object({
  actorId: v.string(), workspaceId: v.string(), parentActorId: v.nullable(v.string()),
  name: v.string(), storageKey: v.string(), kind: v.picklist(['main', 'subordinate', 'head', 'node', 'branch']),
  creationId: v.string(), lifetime: v.picklist(['durable', 'task']), createdAt: v.number(), retiringAt: v.nullable(v.number()), deletedAt: v.nullable(v.number()),
});
export type WorkspaceActor = v.InferOutput<typeof ActorSchema>;
export interface CreateWorkspaceActor {
  readonly parent: ActorHandle;
  readonly name: string;
  readonly creationId: string;
  readonly kind: Exclude<WorkspaceActor['kind'], 'main'>;
  readonly lifetime: WorkspaceActor['lifetime'];
}
const CreationFields = { creationId: v.pipe(v.string(), v.nonEmpty()), name: v.pipe(v.string(), v.nonEmpty()), kind: v.picklist(['subordinate', 'head', 'node', 'branch']), lifetime: v.picklist(['durable', 'task']) };
export const ChildActorOperationSchema = v.union([
  v.strictObject({ action: v.literal('register'), ...CreationFields }),
  v.strictObject({ action: v.literal('cancelCreation'), ...CreationFields }),
  v.strictObject({ action: v.literal('resolve'), name: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ action: v.literal('resolveStorage'), storageKey: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ action: v.literal('resolveCreation'), creationId: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ action: v.picklist(['validate', 'retire', 'release']), name: v.pipe(v.string(), v.nonEmpty()), reference: ActorReferenceSchema }),
]);
export type ChildActorOperation = v.InferOutput<typeof ChildActorOperationSchema>;
export interface ActorDirectoryResult {
  readonly reference: ActorReference;
  readonly state: 'active' | 'retiring' | 'deleted';
  readonly kind: WorkspaceActor['kind'];
  readonly lifetime: WorkspaceActor['lifetime'];
  readonly creationId: string;
  readonly createdAt: number;
  readonly name: string;
  readonly storageKey: string;
}

export function initWorkspaceActorTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS workspace_actors (
    actor_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    parent_actor_id TEXT REFERENCES workspace_actors(actor_id),
    name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('main','subordinate','head','node','branch')),
    lifetime TEXT NOT NULL CHECK (lifetime IN ('durable','task')),
    created_at INTEGER NOT NULL,
    creation_id TEXT NOT NULL,
    retiring_at INTEGER,
    deleted_at INTEGER,
    UNIQUE (workspace_id, parent_actor_id, creation_id),
    UNIQUE (workspace_id, parent_actor_id, storage_key),
    CHECK ((kind = 'main' AND parent_actor_id IS NULL) OR (kind != 'main' AND parent_actor_id IS NOT NULL))
  )`);
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_actors_main
    ON workspace_actors(workspace_id) WHERE kind = 'main'`);
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_actors_names
    ON workspace_actors(workspace_id, parent_actor_id, name) WHERE deleted_at IS NULL`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_workspace_actors_parent
    ON workspace_actors(workspace_id, parent_actor_id, created_at, name)`);
}

function requiredIdentity(value: string): string {
  if (value.trim().length === 0) throw new KinuError('bad_input', 'Actor identity and name must not be empty.');
  return value;
}

/** Owns membership. A handle issued elsewhere is not authority over this database. */
export class WorkspaceActorDirectory {
  private readonly handles = new WeakSet<ActorHandle>();

  constructor(private readonly sql: SqlExecutor, private readonly authority: WorkspaceActorAuthority) {
    this.requireOwnership();
  }

  private requireOwnership(): void {
    if (!tableExists(this.sql, 'workspace_identity') || !tableExists(this.sql, 'workspace_actors')) throw new KinuError('missing', 'The workspace actor directory is not initialized.');
    const rows = this.sql<{ id: string; owner_user_id: string | null }>`SELECT id, owner_user_id FROM workspace_identity`;
    const owner = rows[0];
    if (!owner) throw new KinuError('missing', 'The workspace has no durable identity.');
    if (rows.length !== 1 || owner.id !== this.authority.workspaceId || owner.owner_user_id !== this.authority.ownerUserId) {
      throw new KinuError('denied', 'Workspace ownership does not match the actor directory authority.');
    }
  }

  private row(actorId: string): WorkspaceActor | null {
    const rows = this.sql<WorkspaceActor>`SELECT actor_id AS actorId, workspace_id AS workspaceId,
      parent_actor_id AS parentActorId, name, storage_key AS storageKey, kind, lifetime, created_at AS createdAt, creation_id AS creationId, retiring_at AS retiringAt, deleted_at AS deletedAt
      FROM workspace_actors WHERE workspace_id = ${this.authority.workspaceId} AND actor_id = ${actorId}`;
    const row = rows[0];
    return row ? v.parse(ActorSchema, row) : null;
  }

  private issue(row: WorkspaceActor): ActorHandle {
    const handle = bindActorHandle(this.sql, { actorId: row.actorId, workspaceId: row.workspaceId, parentActorId: row.parentActorId, name: row.name, storageKey: row.storageKey }, () => {
      this.requireOwnership();
      const current = this.row(row.actorId);
      if (!current || current.retiringAt !== null || current.deletedAt !== null || current.parentActorId !== row.parentActorId) throw new KinuError('missing', 'The actor identity is no longer present.');
    });
    this.handles.add(handle);
    return handle;
  }

  describe(handle: ActorHandle): WorkspaceActor {
    this.requireOwnership();
    if (!this.handles.has(handle)) throw new KinuError('denied', 'The handle belongs to another actor directory.');
    const row = this.row(handle.actorId);
    if (!row || row.retiringAt !== null || row.deletedAt !== null) throw new KinuError('missing', 'The actor no longer exists in this workspace.');
    return row;
  }

  open(actorId: string): ActorHandle {
    this.requireOwnership();
    const row = this.row(actorId);
    if (!row || row.retiringAt !== null || row.deletedAt !== null) throw new KinuError('missing', 'The actor is not registered in this workspace.');
    return this.issue(row);
  }

  main(): ActorHandle {
    this.requireOwnership();
    const row = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE workspace_id = ${this.authority.workspaceId} AND kind = 'main' AND deleted_at IS NULL`[0];
    if (!row) throw new KinuError('missing', 'The workspace has no registered main actor.');
    return this.open(row.actor_id);
  }

  createMain(input: { name: string }): ActorHandle {
    this.requireOwnership();
    const name = requiredIdentity(input.name);
    const current = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE workspace_id = ${this.authority.workspaceId} AND kind = 'main'`[0];
    if (current) {
      const row = this.row(current.actor_id);
      if (!row || row.name !== name) throw new KinuError('denied', 'The workspace already has a different main actor.');
      return this.issue(row);
    }
    const actorId = crypto.randomUUID();
    void this.sql`INSERT INTO workspace_actors (actor_id, workspace_id, parent_actor_id, name, storage_key, kind, lifetime, created_at, creation_id)
      VALUES (${actorId}, ${this.authority.workspaceId}, NULL, ${name}, ${name}, 'main', 'durable', ${Date.now()}, ${this.authority.workspaceId})`;
    const row = this.row(actorId);
    if (!row) throw new KinuError('io', 'The main actor was not recorded.');
    return this.issue(row);
  }

  create(input: CreateWorkspaceActor): ActorHandle {
    const parent = this.describe(input.parent);
    const creationId = requiredIdentity(input.creationId);
    const name = requiredIdentity(input.name);
    if (input.kind === 'subordinate') requireSubordinateActorName(name);
    else if (!isExplorationActorKey(name)) throw new KinuError('bad_input', 'Exploration actor names must use the exploration address space.');
    const prior = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE workspace_id = ${this.authority.workspaceId} AND parent_actor_id = ${parent.actorId} AND creation_id = ${creationId}`[0];
    if (prior) {
      const existing = this.row(prior.actor_id);
      if (!existing || existing.retiringAt !== null || existing.deletedAt !== null) throw new KinuError('missing', 'The admitted actor creation is retired.');
      if (existing.name !== name || existing.kind !== input.kind || existing.lifetime !== input.lifetime) throw new KinuError('denied', 'The admitted actor creation cannot change its name, kind or lifetime.');
      return this.issue(existing);
    }
    if (this.childRow(parent.actorId, name)) throw new KinuError('denied', 'The sibling name already exists.');
    const actorId = crypto.randomUUID();
    void this.sql`INSERT INTO workspace_actors (actor_id, workspace_id, parent_actor_id, name, storage_key, kind, lifetime, created_at, creation_id)
      VALUES (${actorId}, ${this.authority.workspaceId}, ${parent.actorId}, ${name}, ${actorId}, ${input.kind}, ${input.lifetime}, ${Date.now()}, ${creationId})`;
    const row = this.row(actorId);
    if (!row) throw new KinuError('io', 'The child actor was not recorded.');
    return this.issue(row);
  }

  resolveChild(parent: ActorHandle, name: string): ActorHandle | null {
    const actor = this.describe(parent);
    const rows = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE workspace_id = ${this.authority.workspaceId} AND parent_actor_id = ${actor.actorId} AND name = ${name} AND deleted_at IS NULL`;
    const id = rows[0]?.actor_id;
    return id === undefined ? null : this.open(id);
  }

  private childRow(parentActorId: string, name: string): WorkspaceActor | null {
    const row = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE workspace_id = ${this.authority.workspaceId} AND parent_actor_id = ${parentActorId} AND name = ${name} AND deleted_at IS NULL`[0];
    return row ? this.row(row.actor_id) : null;
  }

  resolvePath(path: readonly string[]): ActorHandle {
    let actor = this.main();
    for (const name of path) {
      const child = this.resolveChild(actor, name);
      if (!child) throw new KinuError('missing', 'The actor path is not registered.');
      actor = child;
    }
    return actor;
  }

  storagePath(reference: ActorReference): string[] {
    this.requireOwnership();
    const path: string[] = [];
    const seen = new Set<string>();
    let current = this.describe(this.open(reference.actorId));
    if (current.workspaceId !== reference.workspaceId || current.parentActorId !== reference.parentActorId) throw new KinuError('denied', 'The actor reference does not match its workspace and parent.');
    while (current.parentActorId !== null) {
      if (seen.has(current.actorId)) throw new KinuError('denied', 'The actor ancestry contains a cycle.');
      seen.add(current.actorId);
      path.push(current.storageKey);
      current = this.describe(this.open(current.parentActorId));
    }
    return path.reverse();
  }

  validate(reference: ActorReference, storagePath: readonly string[]): ActorHandle {
    const actor = this.open(reference.actorId);
    const expected = this.storagePath(reference);
    if (expected.length !== storagePath.length || expected.some((key, index) => key !== storagePath[index])) {
      throw new KinuError('denied', 'The actor reference does not match its physical parent path.');
    }
    return actor;
  }

  private cancelCreation(input: CreateWorkspaceActor): WorkspaceActor {
    const parent = this.describe(input.parent);
    const selected = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE workspace_id = ${this.authority.workspaceId} AND parent_actor_id = ${parent.actorId} AND creation_id = ${input.creationId}`[0];
    if (selected) {
      const row = this.row(selected.actor_id);
      if (!row) throw new KinuError('missing', 'The actor creation record disappeared.');
      if (row.name !== input.name || row.kind !== input.kind || row.lifetime !== input.lifetime) throw new KinuError('denied', 'The cancellation does not match the admitted creation.');
      if (row.retiringAt === null && row.deletedAt === null) this.transitionRetirement(row.actorId, 'retire');
      const updated = this.row(row.actorId);
      if (!updated) throw new KinuError('missing', 'The actor creation record disappeared.');
      return updated;
    }
    const actorId = crypto.randomUUID();
    const now = Date.now();
    void this.sql`INSERT INTO workspace_actors (actor_id, workspace_id, parent_actor_id, name, storage_key, kind, lifetime, created_at, creation_id, retiring_at, deleted_at)
      VALUES (${actorId}, ${this.authority.workspaceId}, ${parent.actorId}, ${input.name}, ${actorId}, ${input.kind}, ${input.lifetime}, ${now}, ${input.creationId}, ${now}, ${now})`;
    const row = this.row(actorId);
    if (!row) throw new KinuError('io', 'The cancelled creation was not recorded.');
    return row;
  }
  apply(caller: ActorReference, path: readonly string[], operation: ChildActorOperation): ActorDirectoryResult {
    const parent = this.validate(caller, path);
    const parsed = v.safeParse(ChildActorOperationSchema, operation);
    if (!parsed.success) throw new KinuError('bad_input', 'Invalid child actor operation.');
    const input = parsed.output;
    let child: WorkspaceActor;
    if (input.action === 'register' || input.action === 'cancelCreation') {
      const parentKind = this.describe(parent).kind;
      if (parentKind === 'branch' || ((parentKind === 'head' || parentKind === 'node') && input.kind !== 'head')) {
        throw new KinuError('denied', 'This actor kind cannot create the requested child kind.');
      }
      if (input.kind !== 'subordinate' && input.lifetime !== 'task') throw new KinuError('bad_input', 'Exploration actors have task lifetime.');
      const creation = { parent, name: input.name, kind: input.kind, lifetime: input.lifetime, creationId: input.creationId };
      child = input.action === 'register' ? this.describe(this.create(creation)) : this.cancelCreation(creation);
    } else if (input.action === 'resolve') {
      const existing = this.childRow(parent.actorId, input.name);
      if (!existing) throw new KinuError('missing', 'The child actor is not registered.');
      child = existing;
    } else if (input.action === 'resolveStorage') {
      const result = this.storageEntry(parent, input.storageKey);
      if (!result) throw new KinuError('missing', 'The physical actor key is not registered.');
      return result;
    } else if (input.action === 'resolveCreation') {
      const selected = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
        WHERE workspace_id = ${this.authority.workspaceId} AND parent_actor_id = ${parent.actorId} AND creation_id = ${input.creationId}`[0];
      const row = selected ? this.row(selected.actor_id) : null;
      if (!row) throw new KinuError('missing', 'The actor creation is not registered.');
      child = row;
    } else {
      const row = this.row(input.reference.actorId);
      if (!row) throw new KinuError('missing', 'The child actor is not registered.');
      if (row.parentActorId !== parent.actorId || row.name !== input.name || row.workspaceId !== input.reference.workspaceId || row.parentActorId !== input.reference.parentActorId) {
        throw new KinuError('denied', 'The child reference does not match its parent and name.');
      }
      if (input.action === 'validate' && (row.retiringAt !== null || row.deletedAt !== null)) throw new KinuError('missing', 'The child actor is retired.');
      if (input.action === 'retire' && row.retiringAt === null && row.deletedAt === null) {
        this.transitionRetirement(row.actorId, 'retire');
      }
      if (input.action === 'release' && row.deletedAt === null) {
        if (row.retiringAt === null) throw new KinuError('denied', 'Retirement must start before its name is released.');
        this.transitionRetirement(row.actorId, 'release');
      }
      const updated = this.row(row.actorId);
      if (!updated) throw new KinuError('missing', 'The child actor record disappeared.');
      child = updated;
    }
    return this.result(child);
  }

  private result(child: WorkspaceActor): ActorDirectoryResult {
    return {
      reference: { actorId: child.actorId, workspaceId: child.workspaceId, parentActorId: child.parentActorId },
      state: child.deletedAt !== null ? 'deleted' : child.retiringAt !== null ? 'retiring' : 'active',
      kind: child.kind, lifetime: child.lifetime, creationId: child.creationId, createdAt: child.createdAt, name: child.name, storageKey: child.storageKey,
    };
  }

  storageEntry(parent: ActorHandle, storageKey: string): ActorDirectoryResult | null {
    const owner = this.describe(parent);
    const selected = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE workspace_id = ${this.authority.workspaceId} AND parent_actor_id = ${owner.actorId} AND storage_key = ${storageKey}`[0];
    const row = selected ? this.row(selected.actor_id) : null;
    return row ? this.result(row) : null;
  }
  private transitionRetirement(actorId: string, action: 'retire' | 'release'): void {
    const now = Date.now();
    void this.sql`WITH RECURSIVE subtree(actor_id) AS (
      SELECT actor_id FROM workspace_actors WHERE actor_id = ${actorId}
      UNION ALL SELECT child.actor_id FROM workspace_actors child JOIN subtree ON child.parent_actor_id = subtree.actor_id
    ) UPDATE workspace_actors SET
      retiring_at = CASE WHEN ${action} = 'retire' AND retiring_at IS NULL THEN ${now} ELSE retiring_at END,
      deleted_at = CASE WHEN ${action} = 'release' AND retiring_at IS NOT NULL THEN ${now} ELSE deleted_at END
      WHERE actor_id IN (SELECT actor_id FROM subtree) AND deleted_at IS NULL`;
  }

  hasRetirements(): boolean {
    this.requireOwnership();
    return this.sql`SELECT actor_id FROM workspace_actors WHERE workspace_id = ${this.authority.workspaceId} AND retiring_at IS NOT NULL AND deleted_at IS NULL LIMIT 1`.length > 0;
  }

  retirements(): { caller: ActorReference; parentPath: string[]; name: string; reference: ActorReference }[] {
    this.requireOwnership();
    const rows = this.sql<{ actor_id: string }>`SELECT child.actor_id FROM workspace_actors child
      JOIN workspace_actors parent ON parent.actor_id = child.parent_actor_id
      WHERE child.workspace_id = ${this.authority.workspaceId} AND child.retiring_at IS NOT NULL AND child.deleted_at IS NULL
        AND parent.retiring_at IS NULL AND parent.deleted_at IS NULL ORDER BY child.created_at, child.actor_id`;
    return rows.map((entry) => {
      const child = this.row(entry.actor_id);
      if (!child || !child.parentActorId) throw new KinuError('missing', 'The retiring actor has no parent.');
      const parent = this.open(child.parentActorId);
      return {
        caller: { actorId: parent.actorId, workspaceId: parent.workspaceId, parentActorId: parent.parentActorId },
        parentPath: this.storagePath(parent), name: child.name,
        reference: { actorId: child.actorId, workspaceId: child.workspaceId, parentActorId: child.parentActorId },
      };
    });
  }
}

/** Local database access is already owner-authorized. This read never registers an actor. */
export function openWorkspaceMainActor(sql: SqlExecutor): ActorHandle {
  if (!tableExists(sql, 'workspace_identity')) throw new KinuError('missing', 'The workspace has no durable identity.');
  const rows = sql<{ id: string; owner_user_id: string | null }>`SELECT id, owner_user_id FROM workspace_identity`;
  const owner = rows[0];
  if (!owner) throw new KinuError('missing', 'The workspace has no durable identity.');
  if (rows.length !== 1) throw new KinuError('denied', 'The database has more than one workspace identity.');
  return new WorkspaceActorDirectory(sql, { workspaceId: owner.id, ownerUserId: owner.owner_user_id }).main();
}
