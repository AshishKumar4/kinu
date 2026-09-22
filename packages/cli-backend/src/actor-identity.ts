/**
 * Local actor identity: one SQLite file, N logical actors, each a `workspace_actors` row.
 * The directory re-validates on every handle touch, so a retired actor stops answering at once.
 */
import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  ActorReferenceSchema, SubordinateIdentityStore, readMission, WorkspaceActorDirectory, bindActorHandle, explorationActorKey,
  type ActorHandle, type ActorReference, type SqlExec, type SqlExecutor,
  type WorkspaceActor, type NodeIdentity,
} from '@kinu.run/core';
import type { AgentRuntime } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';

interface LocalActorScope {
  readonly directory: WorkspaceActorDirectory;
  readonly workspaceName: string;
  readonly ownerUserId: string;
  readonly rootDbPath: string;
  readonly path: readonly string[];
}

/** No `dbPath`: every local actor lives in the root's database; a path would invite a second handle. */
export interface LocalActorBinding {
  readonly reference: ActorReference;
  readonly name: string;
  readonly storageKey: string;
  readonly kind: WorkspaceActor['kind'];
  readonly createdAt: number;
}

export type LocalActorConfig =
  | { readonly facet?: undefined; readonly actorBinding?: undefined; readonly actor?: undefined }
  /**
   * The handle the host bound; `ActorHost` refuses a runtime not carrying the handle it issued,
   * since release revokes that handle. Absent for the process-bootstrapped facet, which binds its own.
   */
  | { readonly facet: string; readonly actorBinding: LocalActorBinding; readonly actor?: ActorHandle };

export const LocalActorProcessBootstrapSchema = v.strictObject({
  reference: ActorReferenceSchema, parent: ActorReferenceSchema, rootDbPath: v.string(),
  parentStoragePath: v.array(v.string()), name: v.string(), storageKey: v.string(),
});

export type LocalActorProcessBootstrap = v.InferOutput<typeof LocalActorProcessBootstrapSchema>;

/**
 * Binding for a local actor in another OS process. `rootDbPath` is the workspace's one database;
 * the process opens it itself (WAL) since a `bun:sqlite` handle cannot cross processes.
 */
export function localActorProcessBootstrap(parent: ActorHandle, binding: LocalActorBinding): LocalActorProcessBootstrap {
  const scope = scopeFor(parent);
  const child = bindings.get(binding);

  if (!child || child.directory !== scope.directory || binding.reference.parentActorId !== parent.actorId) throw new KinuError('denied', 'The process bootstrap has a different parent.');
  scope.directory.validate(binding.reference, child.path);

  return { reference: binding.reference, parent: { actorId: parent.actorId, workspaceId: parent.workspaceId, parentActorId: parent.parentActorId },
    rootDbPath: scope.rootDbPath, parentStoragePath: [...scope.path], name: binding.name, storageKey: binding.storageKey };
}

export function localActorMission(rt: AgentRuntime, exec: SqlExec): string | null {
  if (rt.actor.parentActorId === null) return readMission(rt.storage.sql);
  // One workspace database holds every child's descriptor; the handle selects whose.
  const identity = new SubordinateIdentityStore(exec, rt.actor).read();

  if (!identity) throw new KinuError('missing', 'The subordinate has no mission identity.');

  return identity.mission;
}

const actors = new WeakMap<ActorHandle, LocalActorScope>();

const bindings = new WeakMap<LocalActorBinding, LocalActorScope>();

function databasePath(path: string): string {
  return path === ':memory:' ? path : resolve(path);
}

export function requireLocalDatabasePath(db: Database, path: string): void {
  if (databasePath(db.filename) !== databasePath(path)) throw new KinuError('denied', 'The runtime path does not match its database.');
}

/** Open only. Root birth registers the main actor before calling this function. */
export function openLocalRootActor(db: Database, sql: SqlExecutor): ActorHandle {
  const rows = sql<{ id: string; name: string; owner_user_id: string }>`SELECT id, name, owner_user_id FROM workspace_identity`;
  const identity = rows[0];

  if (!identity) throw new KinuError('missing', 'The local workspace has no durable identity.');

  if (rows.length !== 1) throw new KinuError('denied', 'The database has more than one workspace identity.');
  const directory = new WorkspaceActorDirectory(sql, { workspaceId: identity.id, ownerUserId: identity.owner_user_id });
  const actor = directory.main();
  actors.set(actor, { directory, workspaceName: identity.name, ownerUserId: identity.owner_user_id, path: [], rootDbPath: databasePath(db.filename) });

  return actor;
}

/** The directory (single membership authority) and storage (single physical store) `createActorHost` is built from. */
export function localActorDirectory(root: ActorHandle) {
  const scope = scopeFor(root);

  if (root.parentActorId !== null) throw new KinuError('denied', 'Only the local root owns the actor directory.');

  return { directory: scope.directory, rootDbPath: scope.rootDbPath };
}

/** Owner and name from `workspace_identity`, the only place the pair exists. */
export function localActorOwner(actor: ActorHandle) {
  const scope = scopeFor(actor);

  return { ownerUserId: scope.ownerUserId, workspaceName: scope.workspaceName };
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
  const binding = Object.freeze({ reference: Object.freeze(reference), name: row.name, storageKey: row.storageKey, kind: row.kind, createdAt: row.createdAt });
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

export function registerLocalActor(
  parent: ActorHandle,
  input: { name: string; creationId: string; kind: Exclude<WorkspaceActor['kind'], 'main'>; lifetime: WorkspaceActor['lifetime'] },
): LocalActorBinding {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'register', creationId: input.creationId, name: input.name, kind: input.kind, lifetime: input.lifetime });

  return bindChild(scope, entry.reference, input.name);
}

export function openLocalActor(parent: ActorHandle, name: string): LocalActorBinding {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'resolve', name });

  if (entry.state !== 'active') throw new KinuError('missing', 'The local actor is retired.');

  return bindChild(scope, entry.reference, name);
}

export function registerLocalNode(parent: ActorHandle, node: NodeIdentity): ActorHandle {
  return registerLocalActorState(parent, { name: explorationActorKey(node.nodeId), creationId: node.nodeId, kind: 'head', lifetime: 'task' });
}

/** Module-local: only `registerLocalNode` wants a handle without a binding; others use `registerLocalActor` + `bindLocalActor`. */
function registerLocalActorState(parent: ActorHandle, input: { name: string; creationId: string; kind: Exclude<WorkspaceActor['kind'], 'main'>; lifetime: WorkspaceActor['lifetime'] }): ActorHandle {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'register', ...input });
  const actor = scope.directory.open(entry.reference.actorId);
  actors.set(actor, { ...scope, path: scope.directory.storagePath(entry.reference) });

  return actor;
}

function requireBinding(binding: LocalActorBinding): LocalActorScope {
  const scope = bindings.get(binding);

  if (!scope) throw new KinuError('denied', 'The actor binding was not issued by a local root.');
  scope.directory.validate(binding.reference, scope.path);

  return scope;
}

/** Bind a handle to an actor this root issued; the directory row is the binding authority. */
export function bindLocalActor(sql: SqlExecutor, binding: LocalActorBinding): ActorHandle {
  const scope = requireBinding(binding);
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
export function cancelLocalCreation(
  parent: ActorHandle,
  input: { name: string; creationId: string; kind: Exclude<WorkspaceActor['kind'], 'main'>; lifetime: WorkspaceActor['lifetime'] },
): ActorReference {
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
