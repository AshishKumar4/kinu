/**
 * Local actor identity: one SQLite file, N logical actors, each a `workspace_actors` row.
 * The directory re-validates on every handle touch, so a retired actor stops answering at once.
 */
import { settle, settleSync } from '../obs/effect';
import { Effect } from 'effect';
import { WorkspaceActorDirectory, type CreateWorkspaceActor, type WorkspaceActor } from '../identity/workspace-actors';
import { bindActorHandle, type ActorHandle, type ActorReference } from '../identity/actor-handle';
import { explorationActorKey } from '../identity/actor-key';
import type { SqlExecutor } from '../types/primitives';
import type { NodeIdentity } from '../strategy/node-workspace';
import { KinuError } from '../obs/error';

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

/** Open only. Root birth registers the main actor before calling this function. */
export function openLocalRootActor(sql: SqlExecutor): ActorHandle {
  return settleSync(Effect.gen(function* () {
    const rows = sql<{ id: string; owner_user_id: string }>`SELECT id, owner_user_id FROM workspace_identity`;
    const identity = rows[0];

    if (!identity) return yield* new KinuError('missing', 'The local workspace has no durable identity.');

    if (rows.length !== 1) return yield* new KinuError('denied', 'The database has more than one workspace identity.');
    const directory = new WorkspaceActorDirectory(sql, { workspaceId: identity.id, ownerUserId: identity.owner_user_id });
    const actor = directory.main();
    actors.set(actor, { directory, path: [] });

    return actor;
  }));
}

/** The directory (single membership authority) and storage (single physical store) `createActorHost` is built from. */
export function localActorDirectory(root: ActorHandle) {
  return settleSync(Effect.gen(function* () {
    const scope = yield* scopeFor(root);

    if (root.parentActorId !== null) return yield* new KinuError('denied', 'Only the local root owns the actor directory.');

    return { directory: scope.directory };
  }));
}

function scopeFor(actor: ActorHandle): Effect.Effect<LocalActorScope, KinuError> {
  return Effect.gen(function* () {
    const scope = actors.get(actor);

    if (!scope) return yield* new KinuError('missing', 'The local actor has no root directory binding.');
    scope.directory.validate(actor, scope.path);

    return scope;
  });
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
  return settleSync(Effect.gen(function* () {
    const scope = yield* scopeFor(parent);
    const path = scope.directory.storagePath(reference);
    scope.directory.validate(reference, path);
    actors.set(handle, { ...scope, path });
  }));
}

function bindChild(scope: LocalActorScope, reference: ActorReference, name: string): Effect.Effect<LocalActorBinding, KinuError> {
  return Effect.gen(function* () {
    const binding = bindScoped(scope, reference);

    if (binding.name !== name) return yield* new KinuError('denied', 'The actor alias does not match its directory record.');

    return binding;
  });
}

/** Read from the directory each time: a cache would let a retired creation keep answering. */
export function bindLocalActorReference(caller: ActorHandle, reference: ActorReference): LocalActorBinding {
  return settleSync(Effect.map(scopeFor(caller), (scope) => bindScoped(scope, reference)));
}

type LocalActorCreation = Omit<CreateWorkspaceActor, 'parent'>;

export function registerLocalActor(parent: ActorHandle, input: LocalActorCreation): LocalActorBinding {
  return settleSync(Effect.gen(function* () {
    const scope = yield* scopeFor(parent);
    const entry = scope.directory.apply(parent, scope.path, { action: 'register', creationId: input.creationId, name: input.name, origin: input.origin, lifetime: input.lifetime });

    return yield* bindChild(scope, entry.reference, input.name);
  }));
}

export function openLocalActor(parent: ActorHandle, name: string): LocalActorBinding {
  return settleSync(Effect.gen(function* () {
    const scope = yield* scopeFor(parent);
    const entry = scope.directory.apply(parent, scope.path, { action: 'resolve', name });

    if (entry.state !== 'active') return yield* new KinuError('missing', 'The local actor is retired.');

    return yield* bindChild(scope, entry.reference, name);
  }));
}

/** The one caller wanting a handle without a binding; others use `registerLocalActor` + `bindLocalActor`. */
export function registerLocalNode(parent: ActorHandle, node: NodeIdentity): ActorHandle {
  return settleSync(Effect.gen(function* () {
    const scope = yield* scopeFor(parent);
    const entry = scope.directory.apply(parent, scope.path, { action: 'register', name: explorationActorKey(node.nodeId), creationId: node.nodeId, origin: 'swarm', lifetime: 'task' });
    const actor = scope.directory.open(entry.reference.actorId);
    actors.set(actor, { ...scope, path: scope.directory.storagePath(entry.reference) });

    return actor;
  }));
}

/** Bind a handle to an actor this root issued; the directory row is the binding authority. */
export function bindLocalActor(sql: SqlExecutor, binding: LocalActorBinding): ActorHandle {
  return settleSync(Effect.gen(function* () {
    const scope = bindings.get(binding);

    if (!scope) return yield* new KinuError('denied', 'The actor binding was not issued by a local root.');
    scope.directory.validate(binding.reference, scope.path);
    const validate = () => Effect.sync(() => { scope.directory.validate(binding.reference, scope.path); });

    const actor = bindActorHandle(sql, { ...binding.reference, name: binding.name, storageKey: binding.storageKey }, validate);
    actors.set(actor, scope);

    return actor;
  }));
}

/** Rebind a file plane to an actor that this root has already issued. */
export function requireLocalActorWorkspace(origin: ActorHandle, actor: ActorHandle): void {
  return settleSync(Effect.gen(function* () {
    const owner = yield* scopeFor(origin);
    const child = yield* scopeFor(actor);

    if (owner.directory !== child.directory || origin.workspaceId !== actor.workspaceId) return yield* new KinuError('denied', 'The actor belongs to a different local workspace.');
  }));
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

export function retireLocalActor(parent: ActorHandle, name: string, reference: ActorReference, cleanup: (storageKey: string) => Promise<void>): Promise<void> {
  return settle(Effect.gen(function* () {
    const scope = yield* scopeFor(parent);
    yield* Effect.promise(() => retireLocalCreation({ scope, caller: parent, parentPath: scope.path, name, reference, cleanup }));
  }));
}

/**
 * Cancel a failed birth via `cancelCreation`, never register-then-destroy: `register` accepts
 * mismatched name/kind/lifetime and its row passes through `active`, visible to concurrent reads.
 */
export function cancelLocalCreation(parent: ActorHandle, input: LocalActorCreation): ActorReference {
  return settleSync(Effect.gen(function* () {
    const scope = yield* scopeFor(parent);

    return scope.directory.apply(parent, scope.path, { action: 'cancelCreation', ...input }).reference;
  }));
}

export function recoverLocalActorRetirements(root: ActorHandle, cleanup: (storagePath: readonly string[]) => Promise<void>): Promise<void> {
  return settle(Effect.gen(function* () {
    const scope = yield* scopeFor(root);

    if (root.parentActorId !== null) return yield* new KinuError('denied', 'Only the local root owns physical retirement recovery.');

    for (const actor of scope.directory.retirements()) {
      yield* Effect.promise(() => retireLocalCreation({
        scope,
        caller: actor.caller,
        parentPath: actor.parentPath,
        name: actor.name,
        reference: actor.reference,
        cleanup: (key) => cleanup([...actor.parentPath, key]),
      }));
    }
  }));
}
