/**
 * Local actor identity — ONE physical database, N logical actors.
 *
 * A local workspace is one SQLite file. Every actor in it — the main agent, a
 * hired subordinate, an ask-by-role temporary, an exploration head (a swarm
 * node seats as one), a branch — is a row in `workspace_actors` on that one
 * database, and that row IS its identity. There is no second identity store:
 * nothing seeds a per-actor `actor_identity` row, because such a row can only
 * exist once per FILE and one file holds every actor a workspace has.
 *
 * So a binding here carries no path. What it carries is the reference the
 * root's directory issued, and the authority to bind a handle to it: the
 * directory is re-validated on every handle touch (`bindActorHandle` calls the
 * validator on `config`/`programState` as well as at bind time), so a retired
 * or re-created actor stops answering the moment its row says so.
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

/**
 * One actor as its root issued it. No `dbPath`: every local actor lives in the
 * root's database, so a path here could only ever name that one file — and a
 * binding that carried it invited a caller to open a second handle on it.
 */
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
   * `actor` is the handle the HOST bound, when a host bound one.
   *
   * `ActorHost` requires a hosted runtime to carry the very handle it issued,
   * because releasing the binding revokes THAT handle — a runtime holding a
   * second binding of the same child would keep authorising statements after
   * the fence flipped. `bindLocalActor` mints a fresh frozen handle per call,
   * so deriving one from `actorBinding` here produced a runtime the host
   * refused, and every hire failed at `completing an admitted actor birth`.
   * Absent for the process-bootstrapped facet, which has no host in its
   * isolate and binds its own.
   */
  | { readonly facet: string; readonly actorBinding: LocalActorBinding; readonly actor?: ActorHandle };

export const LocalActorProcessBootstrapSchema = v.strictObject({
  reference: ActorReferenceSchema, parent: ActorReferenceSchema, rootDbPath: v.string(),
  parentStoragePath: v.array(v.string()), name: v.string(), storageKey: v.string(),
});

export type LocalActorProcessBootstrap = v.InferOutput<typeof LocalActorProcessBootstrapSchema>;

/**
 * What a local actor running in ANOTHER OS process needs to bind itself.
 *
 * `rootDbPath` is the workspace's one database — the same file the parent has
 * open. A separate process cannot share a `bun:sqlite` handle, so it opens that
 * file itself (WAL, which is what a running workspace is already in) and binds
 * its own row over it. It does NOT get a database of its own: a second file
 * would be a second state store for one logical actor.
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
  // The subordinate's OWN descriptor, keyed by its own actor. One workspace
  // database holds every child's, so the handle is what selects whose.
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

/**
 * The directory every actor in this tree is a row in, and the one database
 * those rows live on.
 *
 * The ActorHost is built from this pair: `createActorHost` owns admission for
 * every logical actor beneath the root, so the root's directory is the single
 * membership authority and the root's storage is the single physical store.
 */
export function localActorDirectory(root: ActorHandle) {
  const scope = scopeFor(root);

  if (root.parentActorId !== null) throw new KinuError('denied', 'Only the local root owns the actor directory.');

  return { directory: scope.directory, rootDbPath: scope.rootDbPath };
}

/**
 * Who owns this workspace, and what it is called.
 *
 * Read from `workspace_identity` — the one row a local database has — because
 * that is the only place the pair exists. A subordinate's own descriptor needs
 * both and reads them from here, so no per-actor copy seeded from this row can
 * drift away from it.
 */
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
 * Give a handle THIS root issued elsewhere its local scope.
 *
 * `actors` maps a handle to the root scope that answers "which directory,
 * which path, whose workspace" for it, and only the handles minted in this
 * module were in it. But `ActorHost` mints the handle a hosted runtime must
 * carry — the release fence is bound to that object — so a runtime built over
 * the host's handle reached `scopeFor` with a handle this map had never seen
 * and every local-identity read failed `missing`. Adopting it here is the
 * honest fix: the scope is the SAME scope, keyed by the reference the host and
 * this module both name, and the directory still validates the handle against
 * the path before anything is answered.
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

/**
 * The identity one issued reference stands for, read back from the directory.
 *
 * The DIRECTORY is the registry: an `ActorHost` hands its dependencies a
 * reference, and the name, storage key, kind and creation time that reference
 * was issued with are all rows there. So nothing here caches bindings by id —
 * a cache would be a second copy of the membership table, and a stale entry in
 * it would let a retired creation keep answering.
 */
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

/**
 * Register a child and return its bound HANDLE, without a runtime.
 *
 * MODULE-LOCAL, because `registerLocalNode` is the only shape that wants a
 * handle and no binding: a swarm node is registered and immediately acted as,
 * with nothing in between to hand a binding to. Every caller outside this
 * module registers with `registerLocalActor` and binds with `bindLocalActor` —
 * the pair a hire and a head already go through, and the one that mints a
 * handle a host can fence.
 */
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

/**
 * Bind a handle to an actor this root issued.
 *
 * The directory row is the binding authority; comparing it with an identity
 * mirror seeded from that directory adds no independent validation. A singleton
 * identity row cannot represent the N actors sharing this database.
 */
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

/**
 * Cancel a birth that FAILED, against the record it was admitted under.
 *
 * `cancelCreation`, never `register`. Registering the child and then destroying
 * it is wrong twice over: `register` accepts a name, kind or lifetime that does
 * NOT match the admitted creation (the directory's own `cancelCreation`
 * refuses that as `denied`), and the row it writes passes through `active`, so
 * a roster or inspection read landing between the two statements sees a live
 * child that was never born. This returns the reference so the caller can
 * complete the physical half through whichever host owns the actor's runtime
 * objects.
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
    await retireLocalCreation(scope, actor.caller, actor.parentPath, actor.name, actor.reference, (key) => cleanup([...actor.parentPath, key]));
  }
}
