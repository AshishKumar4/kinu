// Runtime objects for every logical actor of one workspace database. Actor rows live in the
// workspace (the SQL port is synchronous, so they cannot sit behind RPC). Mutable state and
// serialization are per actor; actor-scoped stores key on `actor_id` and re-validate the handle.
// Release invalidates the handle's fence; rows survive until `retire` with `destroy: true`.
// Recovery reads unsettled claims from durable rows: no timer, no in-memory registry.

import * as v from 'valibot';
import { KinuError } from '../obs/error';
import type { SqlExec, SqlExecutor, Storage } from '../types/primitives';
import type { AgentRuntime } from '../types/agent-runtime';
import { ActorSession } from '../orchestrator/actor-session';
import type { AgentOrchestratorDeps } from '../orchestrator/agent-orchestrator';
import type { ContextRevision, StoredActorClaim } from '../orchestrator/actor-claims';
import type { SessionFilePlane } from '../session/payload';
import type { PreparedRequest } from '../session/requests';
import { actorReferenceOf, sameActorReference, type ActorHandle, type ActorReference } from '../identity/actor-handle';
import { createAgentStores, type AgentStores } from './agent-stores';
import type { WorkspaceActor, WorkspaceActorDirectory } from '../identity/workspace-actors';
import type { ActorContextStores, ChildContextResolver } from '../vfs/context-plane';
import type { ContextEventRecorder } from '../types/context-plane';
import { seedActorLoop, type LoopOrigin } from '../scaffold/bootstrap';
import { verifyClaimedProgram } from '../orchestrator/actor-claims';
import { readVersionedScaffoldSource } from '../scaffold/shadow';
import { sha256Hex } from '../safety/argument-digest';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

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
  /** End an in-flight turn rather than wait for it; implied by `destroy`. */
  readonly interrupt: boolean;
}

export interface ActorHostDeps {
  /** Positional `exec` is needed for the purge, whose table names come from the live schema. */
  readonly storage: Pick<Storage, 'sql' | 'transactionSync'> & SqlExec;
  readonly directory: WorkspaceActorDirectory;
  readonly installedBuild: string | null;
  runtimeFor(bound: BoundActor): AgentRuntime | Promise<AgentRuntime>;
  filesFor(bound: Pick<BoundActor, 'reference' | 'record' | 'handle'>): Promise<SessionFilePlane>;
  /** Asked by the host so no hosted actor silently runs the shipped bootstrap loop. */
  loopFor(bound: BoundActor & { readonly runtime: AgentRuntime }): LoopSeed | Promise<LoopSeed>;
  /** Per actor: sharing the root's would let one actor's turn move another's state. */
  orchestrationFor(bound: BoundActor & { readonly runtime: AgentRuntime }): AgentOrchestratorDeps | Promise<AgentOrchestratorDeps>;
  /** `null` only for a host that publishes no run events. */
  contextEvents(bound: BoundActor): ContextEventRecorder | null;
  /** Called after the rows are gone, so a failed reclaim leaves no half-removed readable actor. */
  discardBytes?(record: WorkspaceActor): Promise<void>;
}

export interface ActorHost {
  acquire(reference: ActorReference): Promise<HostedActor>;
  /** Never starts anything. */
  hosted(reference: ActorReference): HostedActor | null;
  /** Any lifecycle state; builds no session. */
  describe(actorId: string): WorkspaceActor | null;
  /** Stores without runtime or session; still refuses a retired or re-parented actor. */
  bindStores(reference: ActorReference): BoundActor;
  list(): readonly ActorReference[];
  /** Serialized per actor only. Abandoning the promise cancels nothing; use `session.interrupt()`. */
  run<T>(reference: ActorReference, work: (actor: HostedActor) => Promise<T>): Promise<T>;
  /** Rows stay. Refused while a turn is in flight. */
  release(reference: ActorReference): void;
  releaseAll(): void;
  retire(parent: ActorReference, retirement: ActorRetirement): Promise<void>;
  resumable(limit?: number): readonly ResumableActorTurn[];
  /** The build this host runs on, which each run's admission records. */
  readonly installedBuild: string | null;
}

/** The parent reference the directory row records; the row is the only authority on it. */
export function registeredParent(
  host: Pick<ActorHost, 'describe'>,
  child: Pick<WorkspaceActor, 'parentActorId'>,
  refusal: { readonly orphan: string; readonly unregistered: string },
): ActorReference {
  const parentId = child.parentActorId;

  if (parentId === null) throw new KinuError('denied', refusal.orphan);
  const parent = host.describe(parentId);

  if (parent === null) throw new KinuError('missing', refusal.unregistered);

  return { actorId: parent.actorId, workspaceId: parent.workspaceId, parentActorId: parent.parentActorId };
}

// Per binding, not per actor id: an id-keyed fence would be revived by the next acquisition.
interface ReleaseFence {
  released: boolean;
}

interface HostSlot {
  readonly actor: HostedActor;
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
  const opening = new Map<string, Promise<HostedActor>>();

  const slotFor = (reference: ActorReference): HostSlot | null => {
    const slot = slots.get(reference.actorId);

    if (!slot) return null;

    if (!sameActorReference(slot.actor.reference, reference)) {
      throw new KinuError('denied', 'The hosted actor reference does not match the one this root issued.');
    }

    return slot;
  };

  const bind = (reference: ActorReference) => {
    // Ancestry is validated once here; per statement only the row and the release fence are checked.
    deps.directory.validate(reference, deps.directory.storagePath(reference));
    const record = deps.directory.retained(reference.actorId);

    if (!record) throw new KinuError('missing', 'The actor is not registered in this workspace.');

    if (record.workspaceId !== reference.workspaceId || record.parentActorId !== reference.parentActorId) {
      throw new KinuError('denied', 'The actor reference does not match its workspace and parent.');
    }

    const fence: ReleaseFence = { released: false };

    const handle = deps.directory.openFenced(reference.actorId, () => {
      if (fence.released) {
        throw new KinuError('missing', 'The hosted actor was released by its root.');
      }
    });

    const binding = { reference: actorReferenceOf(reference), record, handle };

    const stores = createAgentStores(
      () => deps.storage.sql,
      () => handle,
      (write) => deps.storage.transactionSync(write),
      () => deps.filesFor(binding),
    );

    return { bound: { ...binding, stores }, fence };
  };

  const build = async (reference: ActorReference): Promise<{ actor: HostedActor; fence: ReleaseFence }> => {
    const { bound, fence } = bind(reference);
    const runtime = await deps.runtimeFor(bound);
    // Children need handle identity so release revokes every statement. The root's runtime
    // belongs to its opener and is never released individually, so same actor id suffices.
    const rootBinding = reference.parentActorId === null;

    if (runtime.actor !== bound.handle
      && !(rootBinding && runtime.actor.actorId === bound.handle.actorId)) {
      throw new KinuError('denied', 'A hosted runtime must be built over the handle the host bound.');
    }

    // Seeded before the session so no turn is admitted without a program pointer.
    const seed = await deps.loopFor({ ...bound, runtime });
    await seedActorLoop(runtime, seed.parent, seed.origin);
    const orchestration = await deps.orchestrationFor({ ...bound, runtime });

    const session = new ActorSession({
      runtime, orchestration, claims: bound.stores.claims, installedBuild: deps.installedBuild,
      history: bound.stores.history,
      events: deps.contextEvents(bound),
      advisor: reference.parentActorId === null ? undefined : {
        config: deps.directory.main().config,
        workspace: async () => {
          const root = await acquire(actorReferenceOf(deps.directory.main()));

          return root.runtime.agentStateVfs ?? root.runtime.storage.vfs;
        },
        parent: async (signal) => {
          const parentId = reference.parentActorId;

          if (parentId === null) throw new KinuError('missing', 'A non-root advisor has no parent actor.');
          const parent = await acquire(actorReferenceOf(deps.directory.open(parentId)));

          return parent.session.orchestrator.inbox.send(signal);
        },
      },
    });

    return { actor: { ...bound, runtime, session }, fence };
  };

  const acquire = async (reference: ActorReference): Promise<HostedActor> => {
    const live = slotFor(reference);

    if (live && !live.fence.released) return live.actor;
    const pending = opening.get(reference.actorId);

    if (pending) return await pending;

    const work = build(reference).then(({ actor, fence }) => {
      slots.set(reference.actorId, { actor, fence, queue: Promise.resolve() });

      return actor;
    });

    opening.set(reference.actorId, work);

    try {
      return await work;
    } finally {
      if (opening.get(reference.actorId) === work) opening.delete(reference.actorId);
    }
  };

  const requireSlot = (reference: ActorReference): HostSlot => {
    const slot = slotFor(reference);

    if (!slot || slot.fence.released) throw new KinuError('missing', 'The actor is not hosted by this root.');

    return slot;
  };

  const release = (reference: ActorReference): void => {
    // The root's fence is read by its opener; only `releaseAll` (process end) may take it.
    if (reference.parentActorId === null) {
      throw new KinuError('denied',
        'The workspace root is not released individually; its runtime belongs to whoever opened the workspace.');
    }

    const slot = slotFor(reference);

    if (!slot || slot.fence.released) return;

    if (slot.actor.session.inFlight) {
      throw new KinuError('denied', 'An actor holding a turn in flight cannot be released; cancel or settle the turn first.');
    }

    slot.fence.released = true;
    slots.delete(reference.actorId);
  };

  return {
    acquire,
    hosted: (reference) => {
      const slot = slotFor(reference);

      return slot && !slot.fence.released ? slot.actor : null;
    },
    describe: (actorId) => deps.directory.retained(actorId),
    bindStores: (reference) => bind(reference).bound,
    list: () => [...slots.values()].filter((slot) => !slot.fence.released).map((slot) => slot.actor.reference),
    run: async <T>(reference: ActorReference, work: (actor: HostedActor) => Promise<T>): Promise<T> => {
      const actor = await acquire(reference);
      const slot = requireSlot(reference);
      // The tail waits for settlement so a failure does not poison the next operation;
      // the caller still receives the rejection.
      const result = slot.queue.then(() => work(actor));
      slot.queue = Promise.allSettled([result]);

      return await result;
    },
    release,
    releaseAll: () => {
      for (const reference of [...slots.values()].map((slot) => slot.actor.reference)) {
        const slot = slotFor(reference);

        if (!slot) continue;
        slot.fence.released = true;
        slots.delete(reference.actorId);
      }
    },
    retire: async (parent, retirement) => {
      const record = deps.directory.retained(retirement.reference.actorId);

      if (!record) throw new KinuError('missing', 'The actor is not registered in this workspace.');

      if (record.name !== retirement.name) {
        throw new KinuError('denied', 'The retirement names an alias this actor no longer holds.');
      }

      if (retirement.observed) {
        const owner = deps.storage.sql<{ epoch: number }>`
          SELECT epoch FROM actor_turn_claims
          WHERE actor_id = ${record.actorId} AND turn_id = ${retirement.observed.turnId} LIMIT 1`[0]?.epoch;

        if (owner !== undefined && owner > retirement.observed.epoch) {
          throw new KinuError('denied',
            `this retirement was formed against execution epoch ${retirement.observed.epoch}, and epoch ${owner} owns the turn`);
        }
      }

      const slot = slotFor(retirement.reference);

      if (slot && !slot.fence.released) {
        if (retirement.destroy || retirement.interrupt) slot.actor.session.interrupt();

        if (!retirement.destroy && slot.actor.session.inFlight) {
          // A temporary agent files its report from inside its turn, so its release waits; an interrupted turn ends soon.
          // A failed turn has still settled; the re-check below bounds the wait.
          try { await slot.queue; }
          catch (cause) {
            diagnostics.event('actor.retirement_waited_on_failed_turn', {
              actor: record.name, cause: renderThrownChain({ cause }),
            });
          }

          if (slot.actor.session.inFlight) {
            throw new KinuError('denied', 'This actor holds a turn in flight; retire it once the turn settles.');
          }
        }

        slot.fence.released = true;
        slots.delete(retirement.reference.actorId);
      }

      const parentPath = deps.directory.storagePath(parent);
      deps.directory.apply(parent, parentPath, {
        action: 'retire', name: retirement.name, reference: retirement.reference,
      });

      if (retirement.destroy) {
        purgeActorRows(deps.storage, record.actorId);
        await deps.discardBytes?.(record);
      }

      deps.directory.apply(parent, parentPath, {
        action: 'release', name: retirement.name, reference: retirement.reference,
      });
    },
    installedBuild: deps.installedBuild,
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
}

// Read without a handle: a cold root reads these before it hosts anybody.
function unsettledClaimsOf(sql: SqlExecutor, actorId: string, limit: number): readonly StoredActorClaim[] {
  const rows = sql<{
    turn_id: string; run_id: string; epoch: number; work_mode: 'plan' | 'build';
    program_kind: 'builtin' | 'scaffold'; program_version: number; program_digest: string | null;
    program_build: string | null; consumed_revision: number | null; claimed_at: number;
  }>`SELECT turn_id, run_id, epoch, work_mode, program_kind, program_version, program_digest,
            program_build, consumed_revision, claimed_at
     FROM actor_turn_claims WHERE actor_id = ${actorId} AND status = 'admitted'
     ORDER BY claimed_at DESC LIMIT ${limit}`;

  return rows.map((row) => Object.freeze({
    actorId, turnId: row.turn_id, runId: row.run_id, epoch: row.epoch, workMode: row.work_mode,
    program: Object.freeze({
      kind: row.program_kind, version: row.program_version,
      digest: row.program_digest, build: row.program_build,
    }),
    status: 'admitted' as const, outcome: null,
    consumedRevision: row.consumed_revision, claimedAt: row.claimed_at,
  }));
}

/**
 * Spec §6.3: a parent edits a child's context under the child's own checks, so this resolves
 * the child's stores. Authority is the directory row; non-children resolve to null.
 */
export function childContextResolver(deps: {
  readonly host: Pick<ActorHost, 'bindStores'>;
  readonly directory: WorkspaceActorDirectory;
  readonly parent: ActorHandle;
  /** The child's recorder, not the parent's. Required so an authority action is never unaudited. */
  readonly events: (child: BoundActor) => ActorContextStores['events'];
}): ChildContextResolver {
  const children = (): readonly WorkspaceActor[] => {
    const parent = deps.directory.describe(deps.parent);

    return deps.directory.list().filter((actor) => actor.parentActorId === parent.actorId);
  };

  return {
    list: () => children().map((actor) => actor.storageKey),
    resolve: (storageKey: string): ActorContextStores | null => {
      const child = children().find((actor) => actor.storageKey === storageKey);

      if (!child) return null;

      const bound = deps.host.bindStores({
        actorId: child.actorId, workspaceId: child.workspaceId, parentActorId: child.parentActorId,
      });

      return { claims: bound.stores.claims, events: deps.events(bound) };
    },
  };
}

/** The claim's consumed request, or why its own rows cannot be read: a failure no later sweep reads differently. */
async function consumedEvidence(stores: AgentStores, claim: StoredActorClaim): Promise<{ readonly context: ContextRevision | null } | { readonly failure: KinuError }> {
  try {
    return { context: await stores.claims.consumedContext(claim.turnId) };
  } catch (cause) {
    return { failure: toKinuError({ doing: 'reading the request record of an interrupted turn', cause, otherwise: 'io' }) };
  }
}

/** The furthest model step one run of a turn reached, by the run's epoch: -1 for a run that called no model. */
function furthestStep(requests: readonly { readonly epoch: number; readonly step: number | null }[], epoch: number): number {
  return requests.reduce((far, request) => (request.epoch === epoch && request.step !== null ? Math.max(far, request.step) : far), -1);
}

const AdmittedBuildSchema = v.looseObject({ installedBuild: v.nullable(v.string()) });

/** The build a run was admitted on, as its admission recorded it; undefined for an admission that recorded none. */
async function admittedBuild(stores: Pick<AgentStores, 'history'>, admission: PreparedRequest | undefined): Promise<string | null | undefined> {
  if (admission === undefined) return undefined;
  const recorded = v.safeParse(AdmittedBuildSchema, await stores.history.messages.payloads.read(admission.metadata));

  return recorded.success ? recorded.output.installedBuild : undefined;
}

/**
 * Whether an interrupted run got no further than the run before it. Each run of a turn starts again from its input, so a
 * run that died no further than the last one did repeats the reset that ended both (a memory or wall limit its
 * activation hit), and running it again repeats it again. A deploy restarts every object on the build it ships, so a
 * run whose next one ran on another build ended for a reason of ours, not its own: the two runs judged must share
 * this host's build. The CLI's host has none, and cannot tell a relaunch from a reset, so it judges no pair.
 */
async function stalledRun(stores: Pick<AgentStores, 'history'>, claim: StoredActorClaim, installedBuild: string | null): Promise<boolean> {
  if (claim.epoch < 2 || installedBuild === null) return false;
  const requests = stores.history.requests.forTurn(claim.turnId);
  const admission = (epoch: number) => requests.find((request) => request.epoch === epoch && request.step === null);
  const builds = await Promise.all([admittedBuild(stores, admission(claim.epoch - 1)), admittedBuild(stores, admission(claim.epoch))]);

  if (builds.some((build) => build !== installedBuild)) return false;

  return furthestStep(requests, claim.epoch) <= furthestStep(requests, claim.epoch - 1);
}

/**
 * Call only with recovery authority. Verified claims stay owed: bytes alone do not prove the turn finished. A claim whose
 * record fails to read settles `error` once; an actor that cannot be opened stays owed. A run that got no further than
 * the run before it settles `error` as stalled, and its caller tells whoever is owed the turn why it ended.
 */
export async function recoverActorTurns(
  host: Pick<ActorHost, 'resumable' | 'installedBuild'> & {
    acquire(reference: ActorReference): Promise<Pick<HostedActor, 'runtime' | 'stores'> & {
      readonly session: Pick<ActorSession, 'turnOpen'>;
    }>;
  },
  limit?: number,
): Promise<{
  readonly verified: readonly string[];
  readonly refused: readonly string[];
  readonly failed: readonly string[];
  readonly unreadable: readonly string[];
  readonly active: readonly string[];
  readonly stalled: readonly ResumableActorTurn[];
}> {
  const verified: string[] = [];
  const refused: string[] = [];
  const failed: string[] = [];
  const unreadable: string[] = [];
  const active: string[] = [];
  const stalled: ResumableActorTurn[] = [];

  for (const turn of host.resumable(limit)) {
    try {
      const actor = await host.acquire(turn.reference);

      if (actor.session.turnOpen) {
        active.push(turn.claim.turnId);
        continue;
      }

      const evidence = await consumedEvidence(actor.stores, turn.claim);

      if (actor.session.turnOpen) {
        active.push(turn.claim.turnId);
        continue;
      }

      if ('failure' in evidence) {
        actor.stores.claims.settleRecovered(turn.claim.turnId, turn.claim.epoch, 'error');
        failed.push(turn.claim.turnId);
        diagnostics.failure('actor.turn_record_unreadable', evidence.failure, { actor: turn.record.name, turn: turn.claim.turnId });
        continue;
      }

      const verdict = await verifyClaimedProgram(
        turn.claim,
        (version) => readVersionedScaffoldSource(actor.runtime, version),
        (source) => sha256Hex(source),
        evidence.context,
      );

      const stalledTurn = verdict.kind === 'verified' && await stalledRun(actor.stores, turn.claim, host.installedBuild);

      if (actor.session.turnOpen) {
        active.push(turn.claim.turnId);
        continue;
      }

      if (stalledTurn) {
        actor.stores.claims.settleRecovered(turn.claim.turnId, turn.claim.epoch, 'error');
        stalled.push(turn);
        diagnostics.event('actor.turn_stalled', { actor: turn.record.name, turn: turn.claim.turnId, runs: turn.claim.epoch });
        continue;
      }

      if (verdict.kind === 'verified') {
        verified.push(turn.claim.turnId);
        continue;
      }

      actor.stores.claims.settleRecovered(turn.claim.turnId, turn.claim.epoch, 'indeterminate');
      refused.push(turn.claim.turnId);
    }
    catch (cause) {
      // One unreadable actor must not end the sweep; this turn stays owed.
      unreadable.push(turn.claim.turnId);
      diagnostics.failure('actor.turn_recovery_failed', toKinuError({
        doing: 'recovering an interrupted hosted actor turn', cause, otherwise: 'io',
      }), { actor: turn.record.name });
    }
  }

  return { verified, refused, failed, unreadable, active, stalled };
}
