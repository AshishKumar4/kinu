import { Cause, Effect } from 'effect';
import { markStoreChanged } from '@kinu.run/agent-utils';
// Runtime objects for each logical actor of one workspace database; its rows live in the workspace because the
// SQL port is synchronous. State, serialization and `actor_id`-keyed stores are per actor and re-validate the
// handle. Release invalidates the fence; rows survive until `retire` with `destroy: true`. Recovery reads
// unsettled claims from durable rows, with no timer or in-memory registry.

import { KinuError } from '../obs/error';
import type { SqlExec, SqlExecutor, Storage } from '../types/primitives';
import type { AgentRuntime } from '../types/agent-runtime';
import { ActorSession } from '../orchestrator/actor-session';
import type { AgentOrchestratorDeps } from '../orchestrator/agent-orchestrator';
import type { StoredActorClaim } from '../orchestrator/actor-claims';
import type { SessionFilePlane } from '../session/payload';
import { actorReferenceOf, sameActorReference, type ActorHandle, type ActorReference } from '../identity/actor-handle';
import { createAgentStores, type AgentStores } from './agent-stores';
import { tracedActorKind, type WorkspaceActor, type WorkspaceActorDirectory } from '../identity/workspace-actors';
import { localContextTree, type ActorContextStores, type ChildContextResolver, type ContextTree } from '../vfs/context-plane';
import type { ContextEventRecorder } from '../types/context-plane';
import type { TemporaryAgentPort } from '../types/subordinates';
import type { AgentSignal, SendOutcome } from '../types/signals';
import { seedActorLoop, type LoopOrigin } from '../scaffold/bootstrap';
import { decideInterruptedTurn } from '../orchestrator/turn-recovery';
import { readVersionedScaffoldSource, type VersionedScaffoldSource } from '../scaffold/versions';
import type { ReportedTurn } from '../subordinates/turn-reports';
import type { WriteObserver } from '../vfs/write-events';
import { diagnostics, flight, settle, settleSync, toKinuError, type AgentTracing } from '../obs/index';

/** The runtime must be built over this same handle, never a second binding. */
export interface BoundActor {
  readonly reference: ActorReference;
  readonly record: WorkspaceActor;
  readonly handle: ActorHandle;
  readonly stores: AgentStores;
}

export interface HostedActor extends BoundActor {
  readonly runtime: AgentRuntime;
  readonly session: ActorSession;
}

export interface ActorSeat {
  readonly kind: 'actor' | 'head' | 'node';
  readonly writes?: WriteObserver;
}

export interface ResumableActorTurn {
  readonly reference: ActorReference;
  readonly record: WorkspaceActor;
  readonly claim: StoredActorClaim;
}

export interface LoopSeed {
  readonly origin: LoopOrigin;
  readonly parent: AgentRuntime | null;
}

export interface ActorRetirement {
  readonly reference: ActorReference;
  /** Must match the directory row, so a re-created name is not retired. */
  readonly name: string;
  /** Refused if the turn was since re-admitted under a newer epoch. */
  readonly observed?: { readonly turnId: string; readonly epoch: number };
  /** `false`: the name goes, the conversation stays readable. */
  readonly destroy: boolean;
  /** End an in-flight turn, not wait for it; `destroy` implies it. */
  readonly interrupt: boolean;
}

export interface ActorHostDeps {
  /** Positional `exec` is needed for the purge, whose table names come from the live schema. */
  readonly storage: Pick<Storage, 'sql' | 'transactionSync'> & SqlExec;
  readonly directory: WorkspaceActorDirectory;
  readonly installedBuild: string | null;
  readonly workspace?: string;
  /** Whether a hosted turn already gave its hirer the report that answers its assignment. */
  readonly answered?: (turn: ReportedTurn) => boolean;
  runtimeFor(bound: BoundActor, seat: ActorSeat): AgentRuntime | Promise<AgentRuntime>;
  filesFor(bound: Pick<BoundActor, 'reference' | 'record' | 'handle'>): Promise<SessionFilePlane>;
  /** Program bytes may live on a state plane distinct from session payloads and tools. */
  scaffoldFor(bound: Pick<BoundActor, 'reference' | 'record' | 'handle'>): Promise<VersionedScaffoldSource>;
  /** Asked by the host so no hosted actor silently runs the shipped bootstrap loop. */
  loopFor(bound: BoundActor & { readonly runtime: AgentRuntime }): LoopSeed | Promise<LoopSeed>;
  /** Per actor: sharing the root's would let one actor's turn move another's state. */
  orchestrationFor(bound: BoundActor & { readonly runtime: AgentRuntime }): AgentOrchestratorDeps | Promise<AgentOrchestratorDeps>;
  /** `null` only for a host that publishes no run events. */
  contextEvents(bound: BoundActor): ContextEventRecorder | null;
  /** Called after the rows are gone, so a failed reclaim leaves no half-removed readable actor. */
  discardBytes?(record: WorkspaceActor): Promise<void>;
  /** The port a hosted actor hires its advisor through; absent, hosted turns are not reviewed. */
  advisorPort?(bound: BoundActor): TemporaryAgentPort | null;
  sayToParent?(child: ActorReference, signal: AgentSignal): Promise<SendOutcome>;
  readonly tracing: (() => AgentTracing) | undefined;
}

export interface ActorHost {
  acquire(reference: ActorReference, seat: ActorSeat): Promise<HostedActor>;
  /** Never starts anything. */
  hosted(this: void, reference: ActorReference): HostedActor | null;
  /** Any lifecycle state; builds no session. */
  describe(actorId: string): WorkspaceActor | null;
  /** Stores without runtime or session; still refuses a retired or re-parented actor. */
  bindStores(this: void, reference: ActorReference): BoundActor;
  /** Reads retained source bytes without choosing an execution seat. */
  readScaffold(this: void, reference: ActorReference, version: number): Promise<string | null>;
  list(): readonly ActorReference[];
  /** Serialized per actor only. Abandoning the promise cancels nothing; use `session.interrupt()`. */
  run<T>(reference: ActorReference, seat: ActorSeat, work: (actor: HostedActor) => Promise<T>): Promise<T>;
  /** Work on an already composed actor, serialized on the same queue; never chooses a different seat. */
  runHosted<T>(reference: ActorReference, work: (actor: HostedActor) => Promise<T>): Promise<T>;
  /** Rows stay. Refused while a turn is in flight. */
  release(reference: ActorReference): void;
  releaseAll(): void;
  retire(parent: ActorReference, retirement: ActorRetirement): Promise<void>;
  temporary(reference: ActorReference, build: (bound: BoundActor) => TemporaryAgentPort): TemporaryAgentPort;
  resumable(limit?: number): readonly ResumableActorTurn[];
  readonly installedBuild: string | null;
  readonly workspace?: string;
}

/** The parent reference the directory row records; the row is the only authority on it. */
export function registeredParent(
  host: Pick<ActorHost, 'describe'>,
  child: Pick<WorkspaceActor, 'parentActorId'>,
  refusal: { readonly orphan: string; readonly unregistered: string },
): ActorReference {
  const parentId = child.parentActorId;

  if (parentId === null) return settleSync(Effect.fail(new KinuError('denied', refusal.orphan)));
  const parent = host.describe(parentId);

  if (parent === null) return settleSync(Effect.fail(new KinuError('missing', refusal.unregistered)));

  return { actorId: parent.actorId, workspaceId: parent.workspaceId, parentActorId: parent.parentActorId };
}

// Per binding, not per actor id: an id-keyed fence would be revived by the next acquisition.
interface ReleaseFence {
  released: boolean;
}

interface HostSlot {
  readonly actor: HostedActor;
  readonly seat: ActorSeat;
  readonly fence: ReleaseFence;
  queue: Promise<unknown>;
}

// Read from the live schema, not a maintained list. `workspace_actors` belongs to the directory;
// virtual (FTS) tables are rebuilt from their sources.
function actorScopedTables(sql: SqlExecutor): readonly string[] {
  const rows = sql<{ name: string; sql: string }>`
    SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`;

  const names: string[] = [];

  for (const row of rows) {
    if (row.name === 'workspace_actors' || row.name.startsWith('sqlite_')) continue;

    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql)) continue;

    if (!/\bactor_id\b/.test(row.sql)) continue;
    names.push(row.name);
  }

  return names;
}

export function createActorHost(deps: ActorHostDeps): ActorHost {
  const slots = new Map<string, HostSlot>();
  const ports = new Map<string, TemporaryAgentPort>();
  const opening = new Map<string, { readonly reference: ActorReference; readonly seat: ActorSeat }>();

  const slotFor = (reference: ActorReference): Effect.Effect<HostSlot | null, KinuError> => {
    const slot = slots.get(reference.actorId);

    if (!slot) return Effect.succeed(null);

    return sameActorReference(slot.actor.reference, reference)
      ? Effect.succeed(slot)
      : Effect.fail(new KinuError('denied', 'The hosted actor reference does not match the one this root issued.'));
  };

  const bind = (reference: ActorReference) => Effect.gen(function* () {
    // Ancestry is validated once here; per statement only the row and the release fence are checked.
    deps.directory.validate(reference, deps.directory.storagePath(reference));
    const record = deps.directory.retained(reference.actorId);

    if (!record) return yield* new KinuError('missing', 'The actor is not registered in this workspace.');

    if (record.workspaceId !== reference.workspaceId || record.parentActorId !== reference.parentActorId) {
      return yield* new KinuError('denied', 'The actor reference does not match its workspace and parent.');
    }

    const fence: ReleaseFence = { released: false };

    const handle = deps.directory.open(reference.actorId, () => (fence.released
      ? Effect.fail(new KinuError('missing', 'The hosted actor was released by its root.'))
      : Effect.void));

    const binding = { reference: actorReferenceOf(reference), record, handle };

    const stores = createAgentStores(
      () => deps.storage.sql,
      () => handle,
      (write) => deps.storage.transactionSync(write),
      () => deps.filesFor(binding),
    );

    const tracing = deps.tracing;

    if (tracing !== undefined) {
      stores.claims.observeRecovered((claim) => {
        tracing().turns({ id: record.actorId, kind: tracedActorKind(record.origin) }).recovered(claim, claim.outcome);
      });
    }

    return { bound: { ...binding, stores }, fence };
  });

  const build = (reference: ActorReference, seat: ActorSeat): Effect.Effect<{ actor: HostedActor; fence: ReleaseFence }, KinuError> => Effect.gen(function* () {
    const { bound, fence } = yield* bind(reference);
    const runtime = yield* Effect.promise(async () => deps.runtimeFor(bound, seat));

    const session = Effect.gen(function* () {
      // Children need handle identity so release revokes every statement. The root's runtime
      // belongs to its opener and is never released individually, so same actor id suffices.
      const rootBinding = reference.parentActorId === null;

      if (runtime.actor !== bound.handle
        && !(rootBinding && runtime.actor.actorId === bound.handle.actorId)) {
        return yield* new KinuError('denied', 'A hosted runtime must be built over the handle the host bound.');
      }

      // Seeded before the session so no turn is admitted without a program pointer.
      const seed = yield* Effect.promise(async () => deps.loopFor({ ...bound, runtime }));
      yield* Effect.promise(() => seedActorLoop(runtime, seed.parent, seed.origin));
      const orchestration = yield* Effect.promise(async () => deps.orchestrationFor({ ...bound, runtime }));

      const tracing = deps.tracing;
      const actor = { id: bound.record.actorId, kind: tracedActorKind(bound.record.origin) };
      const parentId = reference.parentActorId;

      return new ActorSession({
        runtime, orchestration, claims: bound.stores.claims, installedBuild: deps.installedBuild,
        ...(deps.workspace !== undefined && { workspace: deps.workspace }),
        ...(deps.answered !== undefined && { answered: deps.answered }),
        turns: tracing && (() => tracing().turns(actor)),
        history: bound.stores.history,
        events: deps.contextEvents(bound),
        recording: bound.stores.eventRecorder,
        advisorPort: () => deps.advisorPort?.(bound) ?? null,
        reviewed: bound.record.input,
        advisor: parentId === null ? undefined : {
          config: deps.directory.main().config,
          workspace: async () => {
            const root = await host.acquire(actorReferenceOf(deps.directory.main()), { kind: 'actor' });

            return root.runtime.agentStateVfs ?? root.runtime.storage.vfs;
          },
          parent: async (signal) => {
            if (deps.sayToParent !== undefined) return await deps.sayToParent(reference, signal);
            const parentReference = actorReferenceOf(deps.directory.open(parentId));
            const parent = host.hosted(parentReference) ?? await host.acquire(parentReference, { kind: 'actor' });

            return parent.session.orchestrator.inbox.send(signal);
          },
        },
      });
    });

    // A failed build still lets its runtime go.
    const built = yield* Effect.onError(session, () => Effect.sync(() => runtime.release?.()));

    return { actor: { ...bound, runtime, session: built }, fence };
  });

  const opened = flight(({ reference, seat }: { readonly reference: ActorReference; readonly seat: ActorSeat }) => Effect.ensuring(
    Effect.map(build(reference, seat), ({ actor, fence }) => {
      slots.set(reference.actorId, { actor, fence, seat, queue: Promise.resolve() });

      return actor;
    }),
    Effect.sync(() => { opening.delete(reference.actorId); }),
  ), { key: ({ reference }) => reference.actorId });

  const acquired = (reference: ActorReference, seat: ActorSeat): Effect.Effect<HostedActor, KinuError> => Effect.gen(function* () {
    const live = yield* slotFor(reference);
    const pending = opening.get(reference.actorId);
    const selected = live?.seat ?? pending?.seat;

    if (pending !== undefined && !sameActorReference(pending.reference, reference)) {
      return yield* new KinuError('denied', 'The actor reference differs from its acquisition in progress.');
    }

    if (selected !== undefined && (selected.kind !== seat.kind || selected.writes !== seat.writes)) {
      return yield* new KinuError('denied', 'The actor is already bound to another seat kind or write observer.');
    }

    if (live && !live.fence.released) return live.actor;

    if (pending === undefined) opening.set(reference.actorId, { reference: actorReferenceOf(reference), seat });

    return yield* opened({ reference, seat });
  });

  const drop = (slot: HostSlot): void => {
    slot.fence.released = true;
    slots.delete(slot.actor.reference.actorId);
    slot.actor.runtime.release?.();
  };

  const requireSlot = (reference: ActorReference): Effect.Effect<HostSlot, KinuError> => Effect.flatMap(slotFor(reference), (slot) => (!slot || slot.fence.released
    ? Effect.fail(new KinuError('missing', 'The actor is not hosted by this root.'))
    : Effect.succeed(slot)));

  const queued = <T>(reference: ActorReference, work: (actor: HostedActor) => Promise<T>): Effect.Effect<T, KinuError> => Effect.gen(function* () {
    const slot = yield* requireSlot(reference);
    // A failed operation cannot poison this actor's queue; other actors have their own tails.
    const result = slot.queue.then(() => work(slot.actor));
    slot.queue = Promise.allSettled([result]);

    return yield* Effect.promise(() => result);
  });

  const released = (reference: ActorReference): Effect.Effect<void, KinuError> => Effect.gen(function* () {
    // The root's fence is read by its opener; only `releaseAll` (process end) may take it.
    if (reference.parentActorId === null) {
      return yield* new KinuError('denied',
        'The workspace root is not released individually; its runtime belongs to whoever opened the workspace.');
    }

    const slot = yield* slotFor(reference);

    if (!slot || slot.fence.released) {
      ports.delete(reference.actorId);

      return;
    }

    if (slot.actor.session.inFlight) {
      return yield* new KinuError('denied', 'An actor holding a turn in flight cannot be released; cancel or settle the turn first.');
    }

    drop(slot);
    ports.delete(reference.actorId);
  });

  const host: ActorHost = {
    acquire: (reference, seat) => settle(acquired(reference, seat)),
    hosted: (reference) => settleSync(Effect.map(slotFor(reference), (slot) => (slot && !slot.fence.released ? slot.actor : null))),
    describe: (actorId) => deps.directory.retained(actorId),
    bindStores: (reference) => settleSync(Effect.map(bind(reference), ({ bound }) => bound)),
    readScaffold: (reference, version) => settle(Effect.gen(function* () {
      const { bound } = yield* bind(reference);
      const source = yield* Effect.promise(() => deps.scaffoldFor(bound));

      return yield* Effect.promise(() => readVersionedScaffoldSource(source, version));
    })),
    list: () => [...slots.values()].filter((slot) => !slot.fence.released).map((slot) => slot.actor.reference),
    run: <T>(reference: ActorReference, seat: ActorSeat, work: (actor: HostedActor) => Promise<T>): Promise<T> => settle(Effect.gen(function* () {
      yield* acquired(reference, seat);

      return yield* queued(reference, work);
    })),
    runHosted: <T>(reference: ActorReference, work: (actor: HostedActor) => Promise<T>): Promise<T> => settle(queued(reference, work)),
    release: (reference) => settleSync(released(reference)),
    temporary: (reference, portFor) => {
      const known = ports.get(reference.actorId);

      if (known !== undefined) return known;

      return settleSync(Effect.map(bind(reference), ({ bound }) => {
        const port = portFor(bound);
        ports.set(reference.actorId, port);

        return port;
      }));
    },
    releaseAll: () => {
      for (const slot of slots.values()) drop(slot);
      ports.clear();
    },
    retire: (parent, retirement) => settle(Effect.gen(function* () {
      const record = deps.directory.retained(retirement.reference.actorId);

      if (!record) return yield* new KinuError('missing', 'The actor is not registered in this workspace.');

      if (record.name !== retirement.name) {
        return yield* new KinuError('denied', 'The retirement names an alias this actor no longer holds.');
      }

      if (retirement.observed) {
        const owner = deps.storage.sql<{ epoch: number }>`
          SELECT epoch FROM actor_turn_claims
          WHERE actor_id = ${record.actorId} AND turn_id = ${retirement.observed.turnId} LIMIT 1`[0]?.epoch;

        if (owner !== undefined && owner > retirement.observed.epoch) {
          return yield* new KinuError('denied',
            `this retirement was formed against execution epoch ${retirement.observed.epoch}, and epoch ${owner} owns the turn`);
        }
      }

      const slot = yield* slotFor(retirement.reference);

      if (slot && !slot.fence.released) {
        if (retirement.destroy || retirement.interrupt) slot.actor.session.interrupt();

        if (!retirement.destroy && slot.actor.session.inFlight) {
          // A temporary agent reports from inside its turn, so its release waits; the queue settles, never rejects.
          yield* Effect.promise(() => slot.queue);

          if (slot.actor.session.inFlight) {
            return yield* new KinuError('denied', 'This actor holds a turn in flight; retire it once the turn settles.');
          }
        }

        drop(slot);
      }

      ports.delete(retirement.reference.actorId);

      const parentPath = deps.directory.storagePath(parent);
      deps.directory.apply(parent, parentPath, {
        action: 'retire', name: retirement.name, reference: retirement.reference,
      });

      if (retirement.destroy) {
        purgeActorRows(deps.storage, record.actorId);
        yield* Effect.promise(async () => deps.discardBytes?.(record));
      }

      deps.directory.apply(parent, parentPath, {
        action: 'release', name: retirement.name, reference: retirement.reference,
      });
    })),
    installedBuild: deps.installedBuild,
    ...(deps.workspace !== undefined && { workspace: deps.workspace }),
    resumable: (limit = 50) => {
      const resumable: ResumableActorTurn[] = [];

      for (const record of deps.directory.list()) {
        const claims = unsettledClaimsOf(deps.storage.sql, record.actorId, limit);

        for (const claim of claims) {
          resumable.push({
            reference: { actorId: record.actorId, workspaceId: record.workspaceId, parentActorId: record.parentActorId },
            record, claim,
          });
        }
      }

      return resumable;
    },
  };

  return host;
}

// One transaction: a half-purged actor's id could be re-issued over leftover rows.
function purgeActorRows(storage: Pick<Storage, 'sql' | 'transactionSync'> & SqlExec, actorId: string): void {
  const tables = actorScopedTables(storage.sql);
  storage.transactionSync(() => {
    // All actor-owned references disappear in this transaction; validate at commit, not discovery order.
    storage.exec('PRAGMA defer_foreign_keys = ON');

    for (const table of tables) {
      // Table name comes from `sqlite_master` and is quoted, not caller text.
      storage.exec(`DELETE FROM "${table.replace(/"/g, '""')}" WHERE actor_id = ?`, actorId);
    }
  });
  markStoreChanged(storage.sql);
}

// Read without a handle: a cold root reads these before it hosts anybody.
function unsettledClaimsOf(sql: SqlExecutor, actorId: string, limit: number): readonly StoredActorClaim[] {
  const rows = sql<{
    turn_id: string; run_id: string; epoch: number; work_mode: 'plan' | 'build';
    program_kind: 'builtin' | 'scaffold'; program_version: number; program_digest: string | null;
    program_build: string | null; claimed_at: number;
  }>`SELECT turn_id, run_id, epoch, work_mode, program_kind, program_version, program_digest,
            program_build, claimed_at
     FROM actor_turn_claims WHERE actor_id = ${actorId} AND outcome IS NULL
     ORDER BY claimed_at DESC LIMIT ${limit}`;

  return rows.map((row) => Object.freeze({
    actorId, turnId: row.turn_id, runId: row.run_id, epoch: row.epoch, workMode: row.work_mode,
    program: Object.freeze({
      kind: row.program_kind, version: row.program_version,
      digest: row.program_digest, build: row.program_build,
    }),
    status: 'admitted' as const, outcome: null,
    claimedAt: row.claimed_at,
  }));
}

/**
 * Spec §6.3: a parent edits a child's context under the child's own checks, so this resolves the child's tree.
 */
export function childContextResolver(deps: {
  readonly directory: WorkspaceActorDirectory;
  readonly parent: ActorHandle;
  readonly tree: (child: WorkspaceActor, author: string) => ContextTree;
}): ChildContextResolver {
  const children = (): readonly WorkspaceActor[] => {
    const parent = deps.directory.describe(deps.parent);

    return deps.directory.list().filter((actor) => actor.parentActorId === parent.actorId);
  };

  return {
    list: () => children().map((actor) => actor.storageKey),
    tree: (storageKey, author) => {
      const child = children().find((actor) => actor.storageKey === storageKey);

      return child === undefined ? null : deps.tree(child, author);
    },
  };
}

/** `events` is the child's recorder, so an authority action is never unaudited. */
export function hostedChildTree(host: Pick<ActorHost, 'bindStores'>, events: (child: BoundActor) => ActorContextStores['events']) {
  return (child: WorkspaceActor, author: string): ContextTree => localContextTree(() => {
    const bound = host.bindStores(actorReferenceOf(child));

    return { claims: bound.stores.claims, events: events(bound) };
  }, { author, child: true });
}

/**
 * Call only with recovery authority. Verified claims stay owed: bytes alone do not prove the turn finished. An
 * unreadable claim record settles `error` once; an actor that cannot be opened stays owed.
 */
export function recoverActorTurns(
  host: Pick<ActorHost, 'resumable' | 'installedBuild' | 'workspace'> & {
    /** Whether a turn already gave its hirer the report that answers its assignment. */
    readonly answered?: (turn: ReportedTurn) => boolean;
    bindStores(reference: ActorReference): Pick<BoundActor, 'stores'>;
    readScaffold(reference: ActorReference, version: number): Promise<string | null>;
    hosted(reference: ActorReference): {
      readonly session: Pick<ActorSession, 'turnOpen'>;
    } | null;
  },
): Promise<{
  readonly verified: readonly string[];
  readonly refused: readonly string[];
  readonly failed: readonly string[];
  readonly unreadable: readonly string[];
  readonly active: readonly string[];
  readonly stalled: readonly ResumableActorTurn[];
}> {
  return settle(Effect.gen(function* () {
    const verified: string[] = [];
    const refused: string[] = [];
    const failed: string[] = [];
    const unreadable: string[] = [];
    const active: string[] = [];
    const stalled: ResumableActorTurn[] = [];

    const recoverOne = (turn: ResumableActorTurn): Effect.Effect<void, KinuError> => Effect.gen(function* () {
        const actor = host.bindStores(turn.reference);

        const verdict = yield* decideInterruptedTurn({
          source: (version) => host.readScaffold(turn.reference, version), stores: actor.stores, runs: actor.stores.eventRecorder, installedBuild: host.installedBuild,
          workspace: host.workspace ?? '', actor: turn.record.name, runId: turn.claim.runId, claim: turn.claim,
          ...(host.answered !== undefined && { answered: host.answered }),
          turnOpen: () => host.hosted(turn.reference)?.session.turnOpen ?? false,
        });

        if (verdict.kind === 'active') active.push(turn.claim.turnId);
        else if (verdict.kind === 'continue') verified.push(turn.claim.turnId);
        else if (verdict.cause === 'stalled') stalled.push(turn);
        else if (verdict.cause === 'record_unreadable') failed.push(turn.claim.turnId);
        else refused.push(turn.claim.turnId);
    });

    for (const turn of host.resumable()) {
      yield* Effect.catchCause(recoverOne(turn), (cause) => Effect.sync(() => {
        // One unreadable actor must not end the sweep; this turn stays owed.
        unreadable.push(turn.claim.turnId);
        diagnostics.failure('actor.turn_recovery_failed', toKinuError({
          doing: 'recovering an interrupted hosted actor turn', cause: Cause.squash(cause), otherwise: 'io',
        }), { actor: turn.record.name });
      }));
    }

    return { verified, refused, failed, unreadable, active, stalled };
  }));
}
