/**
 * Local actor identity: one SQLite file, N logical actors, each a `workspace_actors` row.
 * The directory re-validates on every handle touch, so a retired actor stops answering at once.
 */
import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  WorkspaceActorDirectory, bindActorHandle, explorationActorKey,
  type ActorHandle, type ActorReference, type CreateWorkspaceActor, type SqlExecutor,
  type WorkspaceActor, type NodeIdentity,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';

interface LocalActorScope {
  readonly directory: WorkspaceActorDirectory;
  readonly path: readonly string[];
}

/** No `dbPath`: every local actor lives in the root's database; a path would invite a second handle. */
export interface LocalActorBinding {
  readonly reference: ActorReference;
  readonly name: string;
  readonly storageKey: string;
  readonly origin: WorkspaceActor['origin'];
  readonly createdAt: number;
}

export type LocalActorConfig =
  | { readonly facet?: undefined; readonly actorBinding?: undefined; readonly actor?: undefined }
  /**
   * The handle the host bound; `ActorHost` refuses a runtime not carrying the handle it issued,
   * since release revokes that handle. Absent for the process-bootstrapped facet, which binds its own.
   */
  | { readonly facet: string; readonly actorBinding: LocalActorBinding; readonly actor?: ActorHandle };

const actors = new WeakMap<ActorHandle, LocalActorScope>();

const bindings = new WeakMap<LocalActorBinding, LocalActorScope>();

function databasePath(path: string): string {
  return path === ':memory:' ? path : resolve(path);
}

export function requireLocalDatabasePath(db: Database, path: string): void {
  if (databasePath(db.filename) !== databasePath(path)) throw new KinuError('denied', 'The runtime path does not match its database.');
}

/** Open only. Root birth registers the main actor before calling this function. */
export function openLocalRootActor(sql: SqlExecutor): ActorHandle {
  const rows = sql<{ id: string; owner_user_id: string }>`SELECT id, owner_user_id FROM workspace_identity`;
  const identity = rows[0];

  if (!identity) throw new KinuError('missing', 'The local workspace has no durable identity.');

  if (rows.length !== 1) throw new KinuError('denied', 'The database has more than one workspace identity.');
  const directory = new WorkspaceActorDirectory(sql, { workspaceId: identity.id, ownerUserId: identity.owner_user_id });
  const actor = directory.main();
  actors.set(actor, { directory, path: [] });

  return actor;
}

/** The directory (single membership authority) and storage (single physical store) `createActorHost` is built from. */
export function localActorDirectory(root: ActorHandle) {
  const scope = scopeFor(root);

  if (root.parentActorId !== null) throw new KinuError('denied', 'Only the local root owns the actor directory.');

  return { directory: scope.directory };
}

function scopeFor(actor: ActorHandle): LocalActorScope {
  const scope = actors.get(actor);

  if (!scope) throw new KinuError('missing', 'The local actor has no root directory binding.');
  scope.directory.validate(actor, scope.path);

  return scope;
}

function bindScoped(scope: LocalActorScope, reference: ActorReference): LocalActorBinding {
  const path = scope.directory.storagePath(reference);
  const actor = scope.directory.validate(reference, path);
  const row = scope.directory.describe(actor);
  const binding = Object.freeze({ reference: Object.freeze(reference), name: row.name, storageKey: row.storageKey, origin: row.origin, createdAt: row.createdAt });
  bindings.set(binding, { ...scope, path });

  return binding;
}

/**
 * Adopt a handle `ActorHost` minted into this root's scope map; the host's handle carries the
 * release fence, so without this every local-identity read for it fails `missing`.
 */
export function adoptLocalActorHandle(
  parent: ActorHandle,
  reference: ActorReference,
  handle: ActorHandle,
): void {
  const scope = scopeFor(parent);
  const path = scope.directory.storagePath(reference);
  scope.directory.validate(reference, path);
  actors.set(handle, { ...scope, path });
}

function bindChild(scope: LocalActorScope, reference: ActorReference, name: string): LocalActorBinding {
  const binding = bindScoped(scope, reference);

  if (binding.name !== name) throw new KinuError('denied', 'The actor alias does not match its directory record.');

  return binding;
}

/** Read from the directory each time: a cache would let a retired creation keep answering. */
export function bindLocalActorReference(caller: ActorHandle, reference: ActorReference): LocalActorBinding {
  return bindScoped(scopeFor(caller), reference);
}

type LocalActorCreation = Omit<CreateWorkspaceActor, 'parent'>;

export function registerLocalActor(parent: ActorHandle, input: LocalActorCreation): LocalActorBinding {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'register', creationId: input.creationId, name: input.name, origin: input.origin, lifetime: input.lifetime });

  return bindChild(scope, entry.reference, input.name);
}

export function openLocalActor(parent: ActorHandle, name: string): LocalActorBinding {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'resolve', name });

  if (entry.state !== 'active') throw new KinuError('missing', 'The local actor is retired.');

  return bindChild(scope, entry.reference, name);
}

/** The one caller wanting a handle without a binding; others use `registerLocalActor` + `bindLocalActor`. */
export function registerLocalNode(parent: ActorHandle, node: NodeIdentity): ActorHandle {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'register', name: explorationActorKey(node.nodeId), creationId: node.nodeId, origin: 'swarm', lifetime: 'task' });
  const actor = scope.directory.open(entry.reference.actorId);
  actors.set(actor, { ...scope, path: scope.directory.storagePath(entry.reference) });

  return actor;
}

/** Bind a handle to an actor this root issued; the directory row is the binding authority. */
export function bindLocalActor(sql: SqlExecutor, binding: LocalActorBinding): ActorHandle {
  const scope = bindings.get(binding);

  if (!scope) throw new KinuError('denied', 'The actor binding was not issued by a local root.');
  scope.directory.validate(binding.reference, scope.path);
  const validate = () => { scope.directory.validate(binding.reference, scope.path); };

  const actor = bindActorHandle(sql, { ...binding.reference, name: binding.name, storageKey: binding.storageKey }, validate);
  actors.set(actor, scope);

  return actor;
}

/** Rebind a file plane to an actor that this root has already issued. */
export function requireLocalActorWorkspace(origin: ActorHandle, actor: ActorHandle): void {
  const owner = scopeFor(origin);
  const child = scopeFor(actor);

  if (owner.directory !== child.directory || origin.workspaceId !== actor.workspaceId) throw new KinuError('denied', 'The actor belongs to a different local workspace.');
}

const retiring = new WeakMap<WorkspaceActorDirectory, Map<string, Promise<void>>>();

/** One retirement; the physical cleanup must succeed before the row is released. */
interface LocalRetirement {
  scope: LocalActorScope;
  caller: ActorReference;
  parentPath: readonly string[];
  name: string;
  reference: ActorReference;
  cleanup: (storageKey: string) => Promise<void>;
}

async function retireLocalCreation(retirement: LocalRetirement): Promise<void> {
  const { scope, caller, parentPath, name, reference, cleanup } = retirement;
  let pending = retiring.get(scope.directory);

  if (!pending) { pending = new Map(); retiring.set(scope.directory, pending); }

  const existing = pending.get(reference.actorId);

  if (existing) return await existing;

  const work = (async () => {
    const actor = scope.directory.apply(caller, parentPath, { action: 'retire', name, reference });
    await cleanup(actor.storageKey);

    if (actor.state !== 'deleted') scope.directory.apply(caller, parentPath, { action: 'release', name, reference });
  })();

  pending.set(reference.actorId, work);

  try { await work; } finally { if (pending.get(reference.actorId) === work) pending.delete(reference.actorId); }
}

export async function retireLocalActor(parent: ActorHandle, name: string, reference: ActorReference, cleanup: (storageKey: string) => Promise<void>): Promise<void> {
  const scope = scopeFor(parent);
  await retireLocalCreation({ scope, caller: parent, parentPath: scope.path, name, reference, cleanup });
}

/**
 * Cancel a failed birth via `cancelCreation`, never register-then-destroy: `register` accepts
 * mismatched name/kind/lifetime and its row passes through `active`, visible to concurrent reads.
 */
export function cancelLocalCreation(parent: ActorHandle, input: LocalActorCreation): ActorReference {
  const scope = scopeFor(parent);

  return scope.directory.apply(parent, scope.path, { action: 'cancelCreation', ...input }).reference;
}

export async function recoverLocalActorRetirements(root: ActorHandle, cleanup: (storagePath: readonly string[]) => Promise<void>): Promise<void> {
  const scope = scopeFor(root);

  if (root.parentActorId !== null) throw new KinuError('denied', 'Only the local root owns physical retirement recovery.');

  for (const actor of scope.directory.retirements()) {
    await retireLocalCreation({
      scope,
      caller: actor.caller,
      parentPath: actor.parentPath,
      name: actor.name,
      reference: actor.reference,
      cleanup: (key) => cleanup([...actor.parentPath, key]),
    });
  }
}
