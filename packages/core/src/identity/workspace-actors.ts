import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { ActorReferenceSchema, bindActorHandle, type ActorHandle, type ActorReference } from './actor-handle';
import { tableExists } from './schema';
import { isExplorationActorKey, requireSubordinateActorName } from './actor-key';

export interface WorkspaceActorAuthority {
  readonly workspaceId: string;
  readonly ownerUserId: string | null;
}

/** Who made an agent, which decides its preset: `system` is main, `swarm` a swarm worker, `evolution` a background agent. */
const ACTOR_ORIGINS = ['system', 'user', 'agent', 'swarm', 'evolution'] as const;

export type ActorOrigin = (typeof ACTOR_ORIGINS)[number];

/** What an agent is, stored on its row; its preset is the default for its origin, and the table's CHECKs hold it. */
export interface ActorProfile {
  readonly origin: ActorOrigin;
  /** A chat tab on the nav bar. */
  readonly tab: boolean;
  /** The owner may send it messages; false is view-only. */
  readonly input: boolean;
  readonly lifetime: 'durable' | 'task';
  /** Its turns feed the evolution window. */
  readonly evolves: boolean;
}

/** A hired agent: a chat of its own, reached by name through the roster. */
export function isSubordinateOrigin(origin: ActorOrigin): origin is 'user' | 'agent' | 'evolution' {
  return origin === 'user' || origin === 'agent' || origin === 'evolution';
}

/** Read as a home `actorHomeName` derives from a key (`main`, `sub-<key>`, `head-<key>`), so never one's own. */
function mimicsDerivedHome(name: string): boolean {
  return name === 'main' || name.startsWith('sub-') || name.startsWith('head-');
}

/** The preset for a child made with `origin`; only an agent-made hire chooses its lifetime. */
function actorPreset(origin: Exclude<ActorOrigin, 'system'>, lifetime: ActorProfile['lifetime']): ActorProfile {
  switch (origin) {
    case 'user': return { origin, tab: true, input: true, lifetime: 'durable', evolves: false };
    case 'agent': return { origin, tab: false, input: true, lifetime, evolves: false };
    case 'swarm':
    case 'evolution': return { origin, tab: false, input: false, lifetime: 'task', evolves: false };
  }
}

/** The `kinu.actor_kind` span value, unchanged from before origins, so traces and dashboards keep their keys. */
export function tracedActorKind(origin: ActorOrigin): 'main' | 'subordinate' | 'run' {
  if (origin === 'system') return 'main';

  return origin === 'swarm' ? 'run' : 'subordinate';
}

const MAIN_PROFILE: ActorProfile = { origin: 'system', tab: true, input: true, lifetime: 'durable', evolves: true };

export interface WorkspaceActor extends ActorProfile {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly parentActorId: string | null;
  readonly name: string;
  readonly storageKey: string;
  readonly creationId: string;
  readonly createdAt: number;
  readonly retiringAt: number | null;
  readonly deletedAt: number | null;
}

export interface CreateWorkspaceActor {
  readonly parent: ActorHandle;
  readonly name: string;
  readonly creationId: string;
  readonly origin: Exclude<ActorOrigin, 'system'>;
  readonly lifetime: WorkspaceActor['lifetime'];
}

const CreationFields = { creationId: v.pipe(v.string(), v.nonEmpty()), name: v.pipe(v.string(), v.nonEmpty()), lifetime: v.picklist(['durable', 'task']) };

export const ChildActorOperationSchema = v.union([
  v.strictObject({ action: v.literal('register'), ...CreationFields, origin: v.picklist(['user', 'agent', 'swarm', 'evolution']) }),
  v.strictObject({ action: v.literal('cancelCreation'), ...CreationFields, origin: v.picklist(['user', 'agent', 'swarm', 'evolution']) }),
  v.strictObject({ action: v.literal('resolve'), name: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ action: v.literal('resolveStorage'), storageKey: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ action: v.literal('resolveCreation'), creationId: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ action: v.picklist(['validate', 'retire', 'release']), name: v.pipe(v.string(), v.nonEmpty()), reference: ActorReferenceSchema }),
]);

export type ChildActorOperation = v.InferOutput<typeof ChildActorOperationSchema>;

export interface ActorDirectoryResult {
  readonly reference: ActorReference;
  readonly state: 'active' | 'retiring' | 'deleted';
  readonly origin: ActorOrigin;
  readonly lifetime: WorkspaceActor['lifetime'];
  readonly creationId: string;
  readonly createdAt: number;
  readonly name: string;
  readonly storageKey: string;
}

export function initWorkspaceActorTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS workspace_actors (
    actor_id TEXT PRIMARY KEY,
    parent_actor_id TEXT REFERENCES workspace_actors(actor_id),
    name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('system','user','agent','swarm','evolution')),
    tab INTEGER NOT NULL CHECK (tab IN (0,1)),
    input INTEGER NOT NULL CHECK (input IN (0,1)),
    lifetime TEXT NOT NULL CHECK (lifetime IN ('durable','task')),
    evolves INTEGER NOT NULL CHECK (evolves IN (0,1)),
    created_at INTEGER NOT NULL,
    creation_id TEXT NOT NULL,
    retiring_at INTEGER,
    deleted_at INTEGER,
    UNIQUE (parent_actor_id, creation_id),
    UNIQUE (parent_actor_id, storage_key),
    CHECK ((origin = 'system') = (parent_actor_id IS NULL)),
    CHECK (evolves = 0 OR origin = 'system'),
    CHECK (tab = 0 OR origin IN ('system','user')),
    CHECK (origin NOT IN ('swarm','evolution') OR (input = 0 AND lifetime = 'task')),
    CHECK (origin IN ('swarm','evolution') OR input = 1)
  )`);
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_actors_main
    ON workspace_actors(origin) WHERE origin = 'system'`);
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_actors_names
    ON workspace_actors(parent_actor_id, name) WHERE deleted_at IS NULL`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_workspace_actors_parent
    ON workspace_actors(parent_actor_id, created_at, name)`);
}

function requiredIdentity(value: string): string {
  if (value.trim().length === 0) throw new KinuError('bad_input', 'Actor identity and name must not be empty.');

  return value;
}

function mayCreate(owner: WorkspaceActor, child: { readonly origin: ActorOrigin }): boolean {
  return owner.origin !== 'swarm' || child.origin === 'swarm';
}

/** Booleans as SQLite stores them. */
type StoredActorRow = Omit<WorkspaceActor, 'workspaceId' | 'tab' | 'input' | 'evolves'> & { tab: number; input: number; evolves: number };

function sameProfile(row: ActorProfile, profile: ActorProfile): boolean {
  return row.origin === profile.origin && row.tab === profile.tab && row.input === profile.input
    && row.lifetime === profile.lifetime && row.evolves === profile.evolves;
}

/** Deletion outranks retirement. */
function actorState(actor: WorkspaceActor): ActorDirectoryResult['state'] {
  if (actor.deletedAt !== null) return 'deleted';

  if (actor.retiringAt !== null) return 'retiring';

  return 'active';
}

/** Owns membership. A handle issued elsewhere is not authority over this database. */
export class WorkspaceActorDirectory {
  private readonly handles = new WeakSet<ActorHandle>();

  /** Actors this directory retired. It is the only writer of `workspace_actors`, so a handle asks this set, not the row. */
  private readonly ended = new Set<string>();

  constructor(private readonly sql: SqlExecutor, private readonly authority: WorkspaceActorAuthority) {
    if (!tableExists(this.sql, 'workspace_identity') || !tableExists(this.sql, 'workspace_actors')) throw new KinuError('missing', 'The workspace actor directory is not initialized.');
    const owner = this.sql<{ id: string; owner_user_id: string | null }>`SELECT id, owner_user_id FROM workspace_identity`[0];

    if (!owner) throw new KinuError('missing', 'The workspace has no durable identity.');

    if (owner.id !== this.authority.workspaceId || owner.owner_user_id !== this.authority.ownerUserId) {
      throw new KinuError('denied', 'Workspace ownership does not match the actor directory authority.');
    }
  }

  /** The row in any lifecycle state, or null. Issues no handle, so reading a retained actor cannot start it. */
  retained(actorId: string): WorkspaceActor | null {
    const row = this.sql<StoredActorRow>`SELECT actor_id AS actorId,
      parent_actor_id AS parentActorId, name, storage_key AS storageKey, origin, tab, input, lifetime, evolves, created_at AS createdAt, creation_id AS creationId, retiring_at AS retiringAt, deleted_at AS deletedAt
      FROM workspace_actors WHERE actor_id = ${actorId}`[0];

    return row === undefined ? null : this.actorOf(row);
  }

  /** `also` runs after the directory's own checks and can only refuse further, never authorise. */
  private issue(row: WorkspaceActor, also?: () => Effect.Effect<void, KinuError>): ActorHandle {
    const handle = bindActorHandle(this.sql, { actorId: row.actorId, workspaceId: row.workspaceId, parentActorId: row.parentActorId, name: row.name, storageKey: row.storageKey }, () => (this.ended.has(row.actorId)
      ? Effect.fail(new KinuError('missing', 'The actor identity is no longer present.'))
      : also?.() ?? Effect.void));

    this.handles.add(handle);

    return handle;
  }

  describe(handle: ActorHandle): WorkspaceActor {
    if (!this.handles.has(handle)) throw new KinuError('denied', 'The handle belongs to another actor directory.');
    const row = this.retained(handle.actorId);

    if (!row || row.retiringAt !== null || row.deletedAt !== null) throw new KinuError('missing', 'The actor no longer exists in this workspace.');

    return row;
  }

  open(actorId: string, also?: () => Effect.Effect<void, KinuError>): ActorHandle {
    const row = this.retained(actorId);

    if (!row || row.retiringAt !== null || row.deletedAt !== null) throw new KinuError('missing', 'The actor is not registered in this workspace.');

    return this.issue(row, also);
  }

  /** Oldest first, main included. */
  list(options?: { readonly retired?: boolean }): readonly WorkspaceActor[] {
    return this.sql<StoredActorRow>`SELECT actor_id AS actorId,
      parent_actor_id AS parentActorId, name, storage_key AS storageKey, origin, tab, input, lifetime, evolves, created_at AS createdAt, creation_id AS creationId, retiring_at AS retiringAt, deleted_at AS deletedAt
      FROM workspace_actors WHERE ${options?.retired === true ? 1 : 0} = 1 OR (deleted_at IS NULL AND retiring_at IS NULL)
      ORDER BY created_at, actor_id`.map((row) => this.actorOf(row));
  }

  private actorOf(row: StoredActorRow): WorkspaceActor {
    return { ...row, tab: row.tab === 1, input: row.input === 1, evolves: row.evolves === 1, workspaceId: this.authority.workspaceId };
  }

  main(): ActorHandle {
    const row = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE origin = 'system' AND deleted_at IS NULL`[0];

    if (!row) throw new KinuError('missing', 'The workspace has no registered main actor.');

    return this.open(row.actor_id);
  }

  createMain(input: { name: string }): ActorHandle {
    const name = requiredIdentity(input.name);

    const current = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE origin = 'system'`[0];

    if (current) {
      const row = this.retained(current.actor_id);

      if (!row || row.name !== name) throw new KinuError('denied', 'The workspace already has a different main actor.');

      return this.issue(row);
    }

    const actorId = crypto.randomUUID();
    this.insert({ actorId, parentActorId: null, name, storageKey: name, profile: MAIN_PROFILE, creationId: this.authority.workspaceId, ended: null });
    const row = this.retained(actorId);

    if (!row) throw new KinuError('io', 'The main actor was not recorded.');

    return this.issue(row);
  }

  create(input: CreateWorkspaceActor): ActorHandle {
    const parent = this.describe(input.parent);
    const creationId = requiredIdentity(input.creationId);
    const name = requiredIdentity(input.name);

    if (input.origin !== 'swarm') requireSubordinateActorName(name);
    else if (!isExplorationActorKey(name)) throw new KinuError('bad_input', 'Exploration actor names must use the exploration address space.');

    const prior = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE parent_actor_id = ${parent.actorId} AND creation_id = ${creationId}`[0];

    if (prior) {
      const existing = this.retained(prior.actor_id);

      if (!existing || existing.retiringAt !== null || existing.deletedAt !== null) throw new KinuError('missing', 'The admitted actor creation is retired.');

      if (existing.name !== name || !sameProfile(existing, actorPreset(input.origin, input.lifetime))) throw new KinuError('denied', 'The admitted actor creation cannot change its name or profile.');

      return this.issue(existing);
    }

    if (this.childRow(parent.actorId, name)) throw new KinuError('denied', 'The sibling name already exists.');
    const actorId = crypto.randomUUID();
    // A hire whose name no actor of this workspace has had is keyed, and so housed (`actorHomeName`), by that name;
    // a cousin's name, or one used before, keys nothing, and the fresh id does. `insert` decides it as it writes.
    this.insert({
      actorId, parentActorId: parent.actorId, name, storageKey: actorId, keyByName: isSubordinateOrigin(input.origin) && !mimicsDerivedHome(name),
      profile: actorPreset(input.origin, input.lifetime), creationId, ended: null,
    });
    const row = this.retained(actorId);

    if (!row) throw new KinuError('io', 'The child actor was not recorded.');

    return this.issue(row);
  }

  /** Every name and key this workspace's actors have had that is `base` or numbered from it (`base-2`), in one read. */
  namesFrom(base: string): ReadonlySet<string> {
    const numbered = `${base}-%`;

    const rows = this.sql<{ name: string; storage_key: string }>`SELECT name, storage_key FROM workspace_actors
      WHERE name = ${base} OR storage_key = ${base} OR name LIKE ${numbered} OR storage_key LIKE ${numbered}`;

    return new Set(rows.flatMap((row) => [row.name, row.storage_key]));
  }

  /** Null when there is no bindable child; decided on row state, not by catching `open`'s `missing`. */
  resolveChild(parent: ActorHandle, name: string): ActorHandle | null {
    const actor = this.describe(parent);
    const row = this.childRow(actor.actorId, name);

    if (row === null || row.retiringAt !== null || row.deletedAt !== null) return null;

    return this.open(row.actorId);
  }

  private childRow(parentActorId: string, name: string): WorkspaceActor | null {
    const row = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE parent_actor_id = ${parentActorId} AND name = ${name} AND deleted_at IS NULL`[0];

    return row ? this.retained(row.actor_id) : null;
  }

  storagePath(reference: ActorReference): string[] {
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
      WHERE parent_actor_id = ${parent.actorId} AND creation_id = ${input.creationId}`[0];

    if (selected) {
      const row = this.retained(selected.actor_id);

      if (!row) throw new KinuError('missing', 'The actor creation record disappeared.');

      if (row.name !== input.name || !sameProfile(row, actorPreset(input.origin, input.lifetime))) throw new KinuError('denied', 'The cancellation does not match the admitted creation.');

      if (row.retiringAt === null && row.deletedAt === null) this.transitionRetirement(row.actorId, 'retire');
      const updated = this.retained(row.actorId);

      if (!updated) throw new KinuError('missing', 'The actor creation record disappeared.');

      return updated;
    }

    const actorId = crypto.randomUUID();

    this.insert({
      actorId, parentActorId: parent.actorId, name: input.name, storageKey: actorId,
      profile: actorPreset(input.origin, input.lifetime), creationId: input.creationId, ended: Date.now(),
    });
    const row = this.retained(actorId);

    if (!row) throw new KinuError('io', 'The cancelled creation was not recorded.');

    return row;
  }
  /** `ended` stamps a creation that is retired and released as it is recorded. */
  /**
   * `keyByName`: keyed by its name instead of `storageKey` when no actor of the workspace, under any parent, live or
   * gone, has had that name as its name or key. Decided in the one statement that writes, so a second connection
   * cannot claim the name between the check and the row.
   */
  private insert(row: {
    readonly actorId: string; readonly parentActorId: string | null; readonly name: string; readonly storageKey: string;
    readonly keyByName?: boolean; readonly profile: ActorProfile; readonly creationId: string; readonly ended: number | null;
  }): void {
    const { profile } = row;
    const keyByName = row.keyByName === true ? 1 : 0;

    void this.sql`INSERT INTO workspace_actors
      (actor_id, parent_actor_id, name, storage_key, origin, tab, input, lifetime, evolves, created_at, creation_id, retiring_at, deleted_at)
      VALUES (${row.actorId}, ${row.parentActorId}, ${row.name},
        CASE WHEN ${keyByName} = 1 AND NOT EXISTS (SELECT 1 FROM workspace_actors WHERE name = ${row.name} OR storage_key = ${row.name})
          THEN ${row.name} ELSE ${row.storageKey} END,
        ${profile.origin}, ${profile.tab ? 1 : 0},
        ${profile.input ? 1 : 0}, ${profile.lifetime}, ${profile.evolves ? 1 : 0}, ${row.ended ?? Date.now()}, ${row.creationId},
        ${row.ended}, ${row.ended})`;
  }

  apply(caller: ActorReference, path: readonly string[], operation: ChildActorOperation): ActorDirectoryResult {
    const parent = this.validate(caller, path);
    const parsed = v.safeParse(ChildActorOperationSchema, operation);

    if (!parsed.success) throw new KinuError('bad_input', 'Invalid child actor operation.');
    const input = parsed.output;
    let child: WorkspaceActor;

    if (input.action === 'register' || input.action === 'cancelCreation') {
      const owner = this.describe(parent);

      if (!mayCreate(owner, input)) {
        throw new KinuError('denied', 'This agent cannot create the requested kind of child.');
      }

      const creation = { parent, name: input.name, origin: input.origin, lifetime: input.lifetime, creationId: input.creationId };
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
        WHERE parent_actor_id = ${parent.actorId} AND creation_id = ${input.creationId}`[0];

      const row = selected ? this.retained(selected.actor_id) : null;

      if (!row) throw new KinuError('missing', 'The actor creation is not registered.');
      child = row;
    } else {
      const row = this.retained(input.reference.actorId);

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

      const updated = this.retained(row.actorId);

      if (!updated) throw new KinuError('missing', 'The child actor record disappeared.');
      child = updated;
    }

    return this.result(child);
  }

  private result(child: WorkspaceActor): ActorDirectoryResult {
    return {
      reference: { actorId: child.actorId, workspaceId: child.workspaceId, parentActorId: child.parentActorId },
      state: actorState(child),
      origin: child.origin, lifetime: child.lifetime, creationId: child.creationId, createdAt: child.createdAt, name: child.name, storageKey: child.storageKey,
    };
  }

  storageEntry(parent: ActorHandle, storageKey: string): ActorDirectoryResult | null {
    const owner = this.describe(parent);

    const selected = this.sql<{ actor_id: string }>`SELECT actor_id FROM workspace_actors
      WHERE parent_actor_id = ${owner.actorId} AND storage_key = ${storageKey}`[0];

    const row = selected ? this.retained(selected.actor_id) : null;

    return row ? this.result(row) : null;
  }
  private transitionRetirement(actorId: string, action: 'retire' | 'release'): void {
    const now = Date.now();

    const ended = this.sql<{ actor_id: string }>`WITH RECURSIVE subtree(actor_id) AS (
      SELECT actor_id FROM workspace_actors WHERE actor_id = ${actorId}
      UNION ALL SELECT child.actor_id FROM workspace_actors child JOIN subtree ON child.parent_actor_id = subtree.actor_id
    ) UPDATE workspace_actors SET
      retiring_at = CASE WHEN ${action} = 'retire' AND retiring_at IS NULL THEN ${now} ELSE retiring_at END,
      deleted_at = CASE WHEN ${action} = 'release' AND retiring_at IS NOT NULL THEN ${now} ELSE deleted_at END
      WHERE actor_id IN (SELECT actor_id FROM subtree) AND deleted_at IS NULL AND (${action} = 'retire' OR retiring_at IS NOT NULL)
      RETURNING actor_id`;

    for (const row of ended) this.ended.add(row.actor_id);
  }

  hasRetirements(): boolean {
    return this.sql`SELECT actor_id FROM workspace_actors WHERE retiring_at IS NOT NULL AND deleted_at IS NULL LIMIT 1`.length > 0;
  }

  retirements(): { caller: ActorReference; parentPath: string[]; name: string; reference: ActorReference }[] {
    const rows = this.sql<{ actor_id: string }>`SELECT child.actor_id FROM workspace_actors child
      JOIN workspace_actors parent ON parent.actor_id = child.parent_actor_id
      WHERE child.retiring_at IS NOT NULL AND child.deleted_at IS NULL
        AND parent.retiring_at IS NULL AND parent.deleted_at IS NULL ORDER BY child.created_at, child.actor_id`;

    return rows.map((entry) => {
      const child = this.retained(entry.actor_id);

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

/** Hired agents below `actorId`, deepest first. */
export function subordinateDescendants(actors: readonly WorkspaceActor[], actorId: string): readonly WorkspaceActor[] {
  const below: WorkspaceActor[] = [];

  const visit = (parentId: string): void => {
    for (const actor of actors) {
      if (!isSubordinateOrigin(actor.origin) || actor.parentActorId !== parentId) continue;
      visit(actor.actorId);
      below.push(actor);
    }
  };

  visit(actorId);

  return below;
}

/**
 * Keyed by the immutable storage key: a hire's name only when no actor of the workspace had it before (`create`), so
 * renames and reused names never share a directory.
 */
export function actorStateRoot(storageKey: string): string {
  return `.kinu/agents/${encodeURIComponent(storageKey)}`;
}

/** In core so both backends agree: on the shared plane the path is all that separates actors' programs. */
export function actorScaffoldPath(record: Pick<WorkspaceActor, 'origin' | 'storageKey'>): string {
  if (record.origin === 'system') return 'scaffold/agent.js';

  return `${actorStateRoot(record.storageKey)}/scaffold/agent.js`;
}

/** Runs `send` only if the owner may message `actorId`: a view-only agent's `input` is off. */
export function whenActorTakesInput<Result>(sql: SqlExecutor, actorId: string, send: () => Promise<Result>): Promise<Result> {
  const input = sql<{ input: number }>`SELECT input FROM workspace_actors WHERE actor_id = ${actorId}`[0]?.input;

  return settle(input === 0
    ? Effect.fail(new KinuError('denied', 'This agent is view-only: it takes no messages. You can watch it or stop it.'))
    : Effect.promise(send));
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
