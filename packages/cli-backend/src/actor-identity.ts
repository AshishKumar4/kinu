import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  ActorReferenceSchema, FacetIdentity, SubordinateIdentityStore, readMission, WorkspaceActorDirectory, bindActorHandle, explorationActorKey,
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

export interface LocalActorBinding {
  readonly reference: ActorReference;
  readonly name: string;
  readonly storageKey: string;
  readonly kind: WorkspaceActor['kind'];
  readonly createdAt: number;
  readonly dbPath: string;
}

export type LocalActorConfig =
  | { readonly facet?: undefined; readonly actorBinding?: undefined }
  | { readonly facet: string; readonly actorBinding: LocalActorBinding };

export const LocalActorProcessBootstrapSchema = v.strictObject({
  reference: ActorReferenceSchema, parent: ActorReferenceSchema, rootDbPath: v.string(),
  parentStoragePath: v.array(v.string()), name: v.string(), storageKey: v.string(),
});
export type LocalActorProcessBootstrap = v.InferOutput<typeof LocalActorProcessBootstrapSchema>;

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
  const identity = new SubordinateIdentityStore(exec).read();
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

function scopeFor(actor: ActorHandle): LocalActorScope {
  const scope = actors.get(actor);
  if (!scope) throw new KinuError('missing', 'The local actor has no root directory binding.');
  scope.directory.validate(actor, scope.path);
  return scope;
}

function bindChild(scope: LocalActorScope, reference: ActorReference, name: string, dbPath: string): LocalActorBinding {
  const path = scope.directory.storagePath(reference);
  const actor = scope.directory.validate(reference, path);
  const row = scope.directory.describe(actor);
  if (row.name !== name) throw new KinuError('denied', 'The actor alias does not match its directory record.');
  const binding = Object.freeze({ reference: Object.freeze(reference), name, storageKey: row.storageKey, kind: row.kind, createdAt: row.createdAt, dbPath: databasePath(dbPath) });
  bindings.set(binding, { ...scope, path });
  return binding;
}

export function registerLocalActor(
  parent: ActorHandle,
  input: { name: string; creationId: string; kind: Exclude<WorkspaceActor['kind'], 'main'>; lifetime: WorkspaceActor['lifetime']; dbPathForKey: (storageKey: string) => string },
): LocalActorBinding {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'register', creationId: input.creationId, name: input.name, kind: input.kind, lifetime: input.lifetime });
  return bindChild(scope, entry.reference, input.name, input.dbPathForKey(entry.storageKey));
}

export function openLocalActor(parent: ActorHandle, name: string, dbPathForKey: (storageKey: string) => string): LocalActorBinding {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'resolve', name });
  if (entry.state !== 'active') throw new KinuError('missing', 'The local actor is retired.');
  return bindChild(scope, entry.reference, name, dbPathForKey(entry.storageKey));
}

export function registerLocalNode(parent: ActorHandle, node: NodeIdentity): ActorHandle {
  return registerLocalActorState(parent, { name: explorationActorKey(node.nodeId), creationId: node.nodeId, kind: 'node', lifetime: 'task' });
}

export function registerLocalActorState(parent: ActorHandle, input: { name: string; creationId: string; kind: Exclude<WorkspaceActor['kind'], 'main'>; lifetime: WorkspaceActor['lifetime'] }): ActorHandle {
  const scope = scopeFor(parent);
  const entry = scope.directory.apply(parent, scope.path, { action: 'register', ...input });
  const actor = scope.directory.open(entry.reference.actorId);
  actors.set(actor, { ...scope, path: scope.directory.storagePath(entry.reference) });
  return actor;
}
function requireBinding(db: Database, binding: LocalActorBinding): LocalActorScope {
  const scope = bindings.get(binding);
  if (!scope) throw new KinuError('denied', 'The facet binding was not issued by a local root.');
  requireLocalDatabasePath(db, binding.dbPath);
  scope.directory.validate(binding.reference, scope.path);
  return scope;
}

export function seedLocalActor(db: Database, exec: SqlExec, binding: LocalActorBinding): void {
  const scope = requireBinding(db, binding);
  const identity = new FacetIdentity(exec);
  identity.seed({
    actor: { ...binding.reference, name: binding.name, storageKey: binding.storageKey },
    ownerUserId: scope.ownerUserId, parentWorkspace: scope.workspaceName, capabilityToken: null,
  });
}

export function bindLocalActor(db: Database, sql: SqlExecutor, exec: SqlExec, binding: LocalActorBinding): ActorHandle {
  const scope = requireBinding(db, binding);
  const identity = new FacetIdentity(exec);
  const validate = () => {
    scope.directory.validate(binding.reference, scope.path);
    const stored = identity.read();
    if (!stored.actor) throw new KinuError('missing', 'The local facet has no durable actor reference.');
    if (stored.actor.actorId !== binding.reference.actorId || stored.actor.workspaceId !== binding.reference.workspaceId
      || stored.actor.parentActorId !== binding.reference.parentActorId || stored.parentWorkspace !== scope.workspaceName
      || stored.ownerUserId !== scope.ownerUserId || stored.name !== binding.name || stored.storageKey !== binding.storageKey) throw new KinuError('denied', 'The local facet identity does not match its root-issued binding.');
  };
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

async function retireLocalCreation(scope: LocalActorScope, caller: ActorReference, parentPath: readonly string[], name: string, reference: ActorReference, cleanup: (storageKey: string) => Promise<void>): Promise<void> {
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
  await retireLocalCreation(scope, parent, scope.path, name, reference, cleanup);
}

export async function cancelLocalActor(parent: ActorHandle, input: { name: string; creationId: string; kind: Exclude<WorkspaceActor['kind'], 'main'>; lifetime: WorkspaceActor['lifetime'] }, cleanup: (storageKey: string) => Promise<void>): Promise<ActorReference> {
  const scope = scopeFor(parent);
  const actor = scope.directory.apply(parent, scope.path, { action: 'cancelCreation', ...input });
  await retireLocalCreation(scope, parent, scope.path, input.name, actor.reference, cleanup);
  return actor.reference;
}

export async function recoverLocalActorRetirements(root: ActorHandle, cleanup: (storagePath: readonly string[]) => Promise<void>): Promise<void> {
  const scope = scopeFor(root);
  if (root.parentActorId !== null) throw new KinuError('denied', 'Only the local root owns physical retirement recovery.');
  for (const actor of scope.directory.retirements()) {
    await retireLocalCreation(scope, actor.caller, actor.parentPath, actor.name, actor.reference, (key) => cleanup([...actor.parentPath, key]));
  }
}
