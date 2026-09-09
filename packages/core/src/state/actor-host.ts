/**
 * ActorHost — the root's runtime objects for every logical actor of ONE
 * workspace database.
 *
 * WHAT THIS REPLACES. A hired subordinate, an ask-by-role temporary, a
 * branching head and a swarm node each used to own a DATABASE: a facet Durable
 * Object with its own `ctx.storage` on the hosted backend, a `<child>/agent.db`
 * or a `heads/<key>.db` file on the local one. Their rows were therefore not in
 * the workspace, and "a SQL-only snapshot of this object contains the
 * workspace" held for the main actor alone. The stores' SQL port is a
 * SYNCHRONOUS tagged template (`SqlExecutor`), so forwarding a facet's state
 * through root RPC cannot make it a synchronous SQLite interface either — the
 * ledgers have to live in the one database, and the logical actor's runtime
 * objects have to live wherever that database is.
 *
 * SO: one physical workspace, N logical actors, one host. This class binds an
 * issued actor's {@link ActorHandle}, its {@link AgentStores} and its
 * {@link ActorSession} over the SAME `Storage` the root already owns, and it
 * owns nothing else. It is not a second agent stack: the session is the common
 * runner, the stores are the common bundle, and the runtime is built by the
 * backend that knows what a runtime is on that backend.
 *
 * WHAT STAYS PER ACTOR. Everything mutable: the session (its context,
 * orchestrator, work mode, abort controller), the store bundle bound to that
 * actor's handle, and this host's per-actor serialization queue. Two hosted
 * actors of one workspace interleave — {@link ActorHost.run} serializes per
 * actor and never across actors, which is what makes a shared database
 * concurrent rather than a shared lock.
 *
 * WHAT IS SHARED. The database, and the workspace file plane the backend
 * chooses to share. Nothing else crosses: every actor-scoped store carries
 * `actor_id` in its primary key and re-validates the handle before each
 * statement, so two actors that pick the same logical row key cannot read or
 * overwrite each other's row.
 *
 * LIFECYCLE. Acquisition is idempotent and fenced, so a timer, a client event
 * and a delegation call arriving together on a cold root build ONE set of
 * runtime objects. Release drops the runtime objects and INVALIDATES the
 * handle's validation callback, so every store bound to a released actor stops
 * authorising statements at the point `assertCurrent` already stops serving
 * stores — a dropped actor cannot keep writing through a store somebody still
 * holds. Rows survive a release; only {@link ActorHost.retire} with
 * `destroy: true` removes them.
 *
 * RECOVERY WITHOUT A TIMER. A root eviction takes every session with it and no
 * row. {@link ActorHost.resumable} reads what is left — the actor rows of the
 * directory joined to the claims those actors admitted and never settled — so
 * the work a dead activation was holding is rebuildable from durable records
 * alone. There is no `waitUntil`, no timer, and no in-memory registry whose
 * loss would lose the work: a claim is the work's identity, and this host only
 * reads it back.
 */

import { KinuError } from '../obs/error';
import type { SqlExec, SqlExecutor, Storage } from '../types/primitives';
import type { AgentRuntime } from '../types/agent-runtime';
import { ActorSession } from '../orchestrator/actor-session';
import type { AgentOrchestratorDeps } from '../orchestrator/agent-orchestrator';
import type { StoredActorClaim } from '../orchestrator/actor-claims';
import { actorReferenceOf, sameActorReference, type ActorHandle, type ActorReference } from './actor-handle';
import { createAgentStores, type AgentStores } from './agent-stores';
import type { WorkspaceActor, WorkspaceActorDirectory } from './workspace-actors';
import type { ActorContextStores, ChildContextResolver } from '../vfs/context-plane';
import type { ContextEventRecorder } from '../orchestrator/context-plane';
import { seedActorLoop, type LoopOrigin } from '../scaffold/bootstrap';
import { verifyClaimedProgram } from '../orchestrator/actor-claims';
import { readVersionedScaffoldSource } from '../scaffold/shadow';
import { sha256Hex } from '../safety/argument-digest';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/** The handle and stores of one issued actor, before its runtime exists. Handed
 *  to the backend so a runtime is built over the SAME handle the stores are
 *  bound to, never over a second binding of the same identity. */
export interface BoundActor {
  readonly reference: ActorReference;
  readonly record: WorkspaceActor;
  readonly handle: ActorHandle;
  readonly stores: AgentStores;
}

/** One logical actor, live in this root. */
export interface HostedActor extends BoundActor {
  readonly runtime: AgentRuntime;
  readonly session: ActorSession;
}

/** A claimed turn a previous activation left admitted, with the actor it
 *  belongs to. What a cold root rebuilds from, in place of a timer. */
export interface ResumableActorTurn {
  readonly reference: ActorReference;
  readonly record: WorkspaceActor;
  readonly claim: StoredActorClaim;
}

/** The loop a newly hosted actor is seeded with, and the parent it reads. */
export interface LoopSeed {
  readonly origin: LoopOrigin;
  readonly parent: AgentRuntime | null;
}

/** A retirement request, as the parent forms it. */
export interface ActorRetirement {
  readonly reference: ActorReference;
  /**
   * The alias the caller believes it is retiring.
   *
   * Checked against the directory row, so a request formed against a name that
   * has since been released and re-created retires nothing: the reference and
   * the alias must agree on ONE row.
   */
  readonly name: string;
  /**
   * The claimed turn the caller observed, when it observed one.
   *
   * Refused when that turn has since been re-admitted under a NEWER epoch —
   * the request was formed against work that is no longer the current work, and
   * destroying rows under a live newer activation is the failure the epoch
   * fence exists to prevent.
   */
  readonly observed?: { readonly turnId: string; readonly epoch: number };
  /** Remove this actor's rows as well as its name. `false` is a retained
   *  dismissal: the name goes, the conversation stays readable. */
  readonly destroy: boolean;
}

export interface ActorHostDeps {
  /**
   * The ONE workspace database. Every hosted actor's rows are in it.
   *
   * Both SQL ports, because both are genuinely needed: the tagged template for
   * every literal statement, and the positional one for the retirement purge,
   * whose table list is read from the live schema and therefore cannot be a
   * literal.
   */
  readonly storage: Pick<Storage, 'sql' | 'transactionSync'> & SqlExec;
  /** Membership authority. A handle issued anywhere else is not authority over
   *  this database, so the host never mints one itself. */
  readonly directory: WorkspaceActorDirectory;
  /** The build the root publishes for its BUILTIN loop, or null when it
   *  publishes none. Recorded in every hosted actor's claims as given. */
  readonly installedBuild: string | null;
  /** Build this actor's runtime over the handle and stores the host bound. */
  runtimeFor(bound: BoundActor): AgentRuntime | Promise<AgentRuntime>;
  /**
   * Where this actor's agentic loop comes from, and the parent whose retained
   * source an inheriting origin reads.
   *
   * Asked by the HOST, not by the caller that created the actor, and that is
   * the whole point: a head and a hosted node used to open a fresh scaffold
   * store, find no row and silently run the shipped bootstrap loop, so the two
   * kinds whose job is to explore the workspace's own program explored with a
   * program the workspace had replaced. Seeding here makes an unseeded hosted
   * actor unrepresentable rather than merely discouraged.
   *
   * `parent` is null for `builtin` and for the workspace's own main actor;
   * an inheriting origin with no parent runtime is refused by `seedActorLoop`.
   */
  loopFor(bound: BoundActor & { readonly runtime: AgentRuntime }): LoopSeed | Promise<LoopSeed>;
  /**
   * Build this actor's OWN orchestration seam — its event log, evolution
   * engine, broadcast channel, mission governor and turn sinks.
   *
   * One per actor rather than the root's, because these are the objects whose
   * sharing crosses actors: a child that ended the root's session window, or
   * broadcast into the root's socket, would be one actor's turn moving another
   * actor's state.
   */
  orchestrationFor(bound: BoundActor & { readonly runtime: AgentRuntime }): AgentOrchestratorDeps | Promise<AgentOrchestratorDeps>;
  /**
   * Where THIS actor's context edits are recorded — the audit half of the
   * working-history plane.
   *
   * Per actor, because the event belongs to the actor whose context moved: a
   * parent's authorized edit of a child is evidence about the child. Returning
   * `null` is the honest spelling for a host that publishes no run events at
   * all; it is not a default, which is why this is asked rather than assumed.
   */
  contextEvents(bound: BoundActor): ContextEventRecorder | null;
  /**
   * Physical bytes this actor owns outside SQL — a scratch directory, a
   * container, a sandbox. Called by {@link ActorHost.retire} with
   * `destroy: true` AFTER the rows are gone, so a failed byte reclaim leaves no
   * readable actor whose files were half removed.
   *
   * Absent when the backend keeps no per-actor bytes outside the database,
   * which is the shape a shared workspace plane has.
   */
  discardBytes?(record: WorkspaceActor): Promise<void>;
}

export interface ActorHost {
  /** Bind or reuse the runtime objects of one issued actor over the one
   *  workspace database. Idempotent and fenced. */
  acquire(reference: ActorReference): Promise<HostedActor>;
  /** The live objects, or null. Never starts anything — the read a status,
   *  roster or inspection surface makes. */
  hosted(reference: ActorReference): HostedActor | null;
  /** The directory record in ANY lifecycle state, or null. A retained actor is
   *  readable through this and through `(sql, actorId)` read models; neither
   *  builds a session, so reading a dismissed actor's history starts no work. */
  describe(actorId: string): WorkspaceActor | null;
  /**
   * The handle and stores of one issued actor, WITHOUT its runtime or session.
   *
   * What a read of somebody else's rows needs and all it needs: a parent
   * inspecting a child's conversation, or managing that child's working
   * context, gets the child's own actor-bound stores and starts no turn, no
   * queue and no model. The binding still refuses a retired or re-parented
   * actor, so a read is not a way around membership.
   */
  bindStores(reference: ActorReference): BoundActor;
  /** Every actor live in this root. */
  list(): readonly ActorReference[];
  /**
   * Run one operation as this actor, serialized against that actor's other
   * operations and against nothing else.
   *
   * The caller's interest in the result is not the work's lifetime: abandoning
   * this promise — a client disconnecting, a request returning — cancels
   * nothing. Cancellation is `session.interrupt()`, which only an explicit
   * cancel calls.
   */
  run<T>(reference: ActorReference, work: (actor: HostedActor) => Promise<T>): Promise<T>;
  /** Drop the runtime objects and invalidate the actor's binding. Rows stay.
   *  Refused while that actor holds a turn in flight. */
  release(reference: ActorReference): void;
  /** Drop every actor's runtime objects — a root shutting down. Rows stay. */
  releaseAll(): void;
  /** Retire an actor under its parent's authority, optionally destroying its
   *  rows and bytes. */
  retire(parent: ActorReference, retirement: ActorRetirement): Promise<void>;
  /** Claims admitted and never settled, across every actor this workspace
   *  retains. Read from durable rows; nothing here depends on a live object. */
  resumable(limit?: number): readonly ResumableActorTurn[];
}

/**
 * The revocation token of ONE binding.
 *
 * Per binding rather than per actor id, and the difference is a real defect
 * this caught: a release that only removed the actor from a map left every
 * store it had handed out authorising statements, because the fence had nothing
 * left to read. And a fence keyed on the id would be REVIVED by the next
 * acquisition of the same actor, handing a caller who still held the old stores
 * a working binding again. So the token is created with the binding, captured
 * by that binding's validation closure, and flipped once and for ever.
 */
interface ReleaseFence {
  released: boolean;
}

/** Per-actor state this host holds. */
interface HostSlot {
  readonly actor: HostedActor;
  /** This binding's revocation token — read by its own validation callback, so
   *  a released actor's stores refuse before their first statement. */
  readonly fence: ReleaseFence;
  /** Tail of this actor's serialization chain. */
  queue: Promise<unknown>;
}

/**
 * Every table of this database that carries an `actor_id` column, read from the
 * live schema rather than from a list somebody maintains.
 *
 * Read off `sqlite_master.sql` — the same walk the workspace archive performs,
 * for the same reason: a hand-kept list is a second statement of the schema and
 * the two drift, and a table missed by a cleanup list is one actor's rows left
 * behind under an id another actor can be issued. `workspace_actors` is
 * excluded because the directory owns that row's lifecycle, and the FTS shadow
 * tables are excluded because they are rebuilt from their virtual table.
 *
 * MODULE-LOCAL, and it stays that way: the only caller is
 * {@link purgeActorRows} below, and nothing outside this file has any business
 * with a table list — a caller holding one is a second cleanup pass whose
 * exclusions are its own. A reader that wants the property this derives asks
 * the host to retire an actor and looks at the rows.
 */
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
    // The reference is validated against its PHYSICAL parent path once, here:
    // the ancestry walk is a recursive read and a per-statement one would put
    // it in front of every row this actor ever writes. What every statement
    // does re-check is the row itself and this host's release fence, which is
    // what the directory's own validation plus `also` below covers.
    deps.directory.validate(reference, deps.directory.storagePath(reference));
    const record = deps.directory.retained(reference.actorId);
    if (!record) throw new KinuError('missing', 'The actor is not registered in this workspace.');
    if (record.workspaceId !== reference.workspaceId || record.parentActorId !== reference.parentActorId) {
      throw new KinuError('denied', 'The actor reference does not match its workspace and parent.');
    }
    // The release fence rides THIS binding's own validation: a store bound to
    // this handle asks it before every statement, so dropping the actor is
    // what stops its writes rather than everybody remembering to stop calling.
    const fence: ReleaseFence = { released: false };
    const handle = deps.directory.openFenced(reference.actorId, () => {
      if (fence.released) {
        throw new KinuError('missing', 'The hosted actor was released by its root.');
      }
    });
    const stores = createAgentStores(
      () => deps.storage.sql,
      () => handle,
      (write) => deps.storage.transactionSync(write),
    );
    return { bound: { reference: actorReferenceOf(reference), record, handle, stores }, fence };
  };

  const build = async (reference: ActorReference): Promise<{ actor: HostedActor; fence: ReleaseFence }> => {
    const { bound, fence } = bind(reference);
    const runtime = await deps.runtimeFor(bound);
    // IDENTITY for a child, SAME ACTOR for the root, and the difference is what
    // the check is actually protecting: a released binding must revoke every
    // statement its runtime can still make. A child's handle is minted by this
    // host, so identity is how that guarantee is expressed — a runtime carrying
    // a second handle for the same child would keep authorising after the
    // release flipped the fence, which is the defect this check exists for.
    //
    // The root is not a hosted child. Its runtime belongs to whoever OPENED the
    // workspace — a `kinu` process or a Durable Object activation — and existed
    // before this host bound anything; on the local backend it carries that
    // process's executors, file plane and MCP connections, and rebuilding it per
    // binding would build a second workspace. `release` refuses the root below,
    // so there is no revocation for a stale root handle to escape, and the
    // exemption cannot widen into the hole the child rule closes.
    const rootBinding = reference.parentActorId === null;
    if (runtime.actor !== bound.handle
      && !(rootBinding && runtime.actor.actorId === bound.handle.actorId)) {
      throw new KinuError('denied', 'A hosted runtime must be built over the handle the host bound.');
    }
    // Before the session exists, so no turn of this actor can be admitted
    // against a program pointer nobody set. Idempotent: an actor that already
    // has a pointer keeps it, and a promotion it has since made stands.
    const seed = await deps.loopFor({ ...bound, runtime });
    await seedActorLoop(runtime, seed.parent, seed.origin);
    const orchestration = await deps.orchestrationFor({ ...bound, runtime });
    const session = new ActorSession({
      runtime, orchestration, claims: bound.stores.claims, installedBuild: deps.installedBuild,
      events: deps.contextEvents(bound),
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
    // The root's runtime is the opener's, not this host's, and `build` accepts
    // the opener's handle for it on that basis. Revoking it here would flip a
    // fence the opener still reads through — the workspace itself would stop
    // authorising statements while its process kept running. `releaseAll` is
    // the arm that may take the root, because that one IS the process ending.
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
      // Chained on the actor's own tail, so this actor's operations are ordered
      // and no other actor's are delayed.
      //
      // The tail waits for SETTLEMENT, not success, and `allSettled` says that
      // in the type rather than in a two-armed `then` whose second arm looks
      // like a swallowed failure. Nothing is swallowed: the rejection is
      // delivered to the caller by `return await result` below, which is the
      // only place it means anything. What the tail must NOT do is carry the
      // failure forward — a refused operation must not poison the next one.
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
        // A destroyed actor's in-flight turn is cut here rather than left to
        // discover its rows are gone; a retained dismissal waits for it.
        if (retirement.destroy) slot.actor.session.interrupt();
        else if (slot.actor.session.inFlight) {
          // WAITS, as the line above says it does. It used to THROW here, which
          // contradicted its own comment and broke the caller the wait was
          // written for: a temporary agent's report is filed FROM INSIDE its
          // turn, so the rung that awaits the answer and then dismisses the
          // child with history kept arrived one line later with the turn still
          // in flight, and got `denied` instead of a completed handoff.
          //
          // `queue` is this actor's own serialization tail, so awaiting it is
          // waiting for exactly the work that has to finish — and swallowing
          // its rejection is right here, because a turn that FAILED has still
          // settled, which is all this retirement needs. The re-check after is
          // what keeps the wait bounded: if a further turn started while we
          // waited, the caller is racing its own child and gets told so rather
          // than waiting behind an unbounded chain.
          // A FAILED turn has still SETTLED, which is all this retirement
          // needs — so the tail's rejection is tolerated here and nowhere
          // else. Recorded rather than swallowed: the caller is retiring the
          // actor, so nobody downstream will ever see why its last turn ended.
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

/**
 * Every row of one actor, gone, in one transaction.
 *
 * Table set from the live schema (see {@link actorScopedTables}) so a table
 * added anywhere is cleaned by the same pass that dumps it into an archive. One
 * transaction because a half-purged actor is worse than either outcome: its
 * name is released, so the id can be re-issued over rows the previous holder
 * left.
 */
function purgeActorRows(storage: Pick<Storage, 'sql' | 'transactionSync'> & SqlExec, actorId: string): void {
  const tables = actorScopedTables(storage.sql);
  storage.transactionSync(() => {
    for (const table of tables) {
      // Positional binding, because the table name is read from the live schema
      // and a tagged template would bind it as a value. The name came from
      // `sqlite_master` of this same database and is quoted, so it is an
      // identifier that exists rather than caller text.
      storage.exec(`DELETE FROM "${table.replace(/"/g, '""')}" WHERE actor_id = ?`, actorId);
    }
  });
}

/** Claims one actor admitted and never settled, read without binding a handle:
 *  a cold root reads what the dead activation left before it can host anybody. */
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
 * A parent's authority over its children's working context, resolved through
 * the actor directory and nothing else.
 *
 * Spec §6.3 requires an authorized parent/owner to manage a child's context, and
 * requires it under the SAME checks the child's own edit gets. That is why this
 * resolves to the CHILD's stores bound to the CHILD's handle rather than to a
 * cross-actor write through the parent's: the staleness, schema, pairing and
 * epoch refusals are then literally the child's own, and a retired child refuses
 * at `assertCurrent` instead of at a rule somebody remembered to add here.
 *
 * Authority is the directory row, never a path segment: a storage key that names
 * a sibling, an unrelated actor or a retired one resolves to null, which the
 * plane reports as an absent path. The key is the child's `storage_key`, the
 * same address `.kinu/agents/<storage-key>/` already uses.
 */
export function childContextResolver(deps: {
  readonly host: Pick<ActorHost, 'bindStores'>;
  readonly directory: WorkspaceActorDirectory;
  readonly parent: ActorHandle;
  /**
   * Where a landed edit of a CHILD's context is recorded, given that child's
   * own bound stores.
   *
   * A function rather than the recorder itself, and required rather than
   * defaulted: the event belongs to the child whose context moved, so it has to
   * be that child's recorder and not the parent's — and a default of "record
   * nothing" is how an authority action ends up with no audit trail. The
   * integration wiring is `(child) => child.stores.eventRecorder`; `() => null`
   * is the honest spelling for a host that publishes no run events at all.
   */
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
      return { actorId: child.actorId, claims: bound.stores.claims, events: deps.events(bound) };
    },
  };
}

/**
 * Rebuild what an eviction interrupted, from the durable claims alone.
 *
 * THE ONLY RECOVERY PATH, and it lives here rather than in a backend because
 * nothing in it is platform-shaped: it reads {@link ActorHost.resumable},
 * acquires each actor through the same host every other caller uses, and
 * verifies the claim with core's own verifier. It used to exist once per
 * backend — written on the cf side and never called, with the cli's own
 * `resumable` exposure equally unreached — so BOTH backends promised resumable
 * hosted work and neither delivered it. One implementation, two callers, is the
 * whole point: a second copy is a second chance for one of them to be the
 * unreached one.
 *
 * There is no timer holding a run alive and no `waitUntil` finishing it in the
 * background. A hosted actor's unsettled claim IS the record that work is owed,
 * and this reads it on the normal activation and alarm path.
 *
 * {@link verifyClaimedProgram} is what makes the resumption honest: a claim
 * names the program version and its digest, so a turn resumes only under the
 * exact bytes it was admitted with, and a promotion that landed meanwhile does
 * not silently take over a turn in flight. A claim whose program no longer
 * verifies is settled `indeterminate` — which is precisely what is known: it
 * was admitted, its bytes are gone, and nothing states how it ended.
 *
 * CALL THIS BEFORE ADMITTING NEW WORK for the same actor. A claimed-but-
 * unfinished turn has to be reconciled first, or the caller issues a second
 * turn against an actor whose first still holds a claim and per-actor
 * serialization refuses it — an honest refusal, of the wrong turn.
 */
export async function recoverActorTurns(
  host: ActorHost,
  limit?: number,
): Promise<{
  readonly resumed: readonly string[];
  readonly refused: readonly string[];
  readonly unreadable: readonly string[];
}> {
  const resumed: string[] = [];
  const refused: string[] = [];
  // THREE OUTCOMES, NOT TWO. A turn whose program no longer verifies is a
  // DECIDED one: it is settled `indeterminate`, which is a durable statement
  // about how it ended. A turn whose actor could not be read at all is not
  // decided by anything — the row is still owed and the next activation will
  // read it again. Folding both into `refused` made a caller unable to tell a
  // settlement from a failure to look, and an operator unable to tell a
  // workspace that answered from one that could not be opened.
  const unreadable: string[] = [];
  for (const turn of host.resumable(limit)) {
    try {
      const actor = await host.acquire(turn.reference);
      const verdict = await verifyClaimedProgram(
        turn.claim,
        (version) => readVersionedScaffoldSource(actor.runtime, version),
        (source) => sha256Hex(source),
        () => actor.stores.claims.consumedContext(turn.claim.turnId),
      );
      // `verified` is the only arm a turn may be resumed under. `source_changed`
      // means the version's retained bytes no longer digest to what the claim
      // named, and `build_unknown` means this host publishes no identity for the
      // builtin loop that was claimed — in both cases what ran cannot be
      // established, so the turn is settled `indeterminate`.
      if (verdict.kind === 'verified') {
        resumed.push(turn.claim.turnId);
        continue;
      }
      refused.push(turn.claim.turnId);
      actor.stores.claims.settleRecovered(turn.claim.turnId, turn.claim.epoch, 'indeterminate');
    }
    catch (cause) {
      // One actor's unreadable state must not end the sweep: the rest of the
      // workspace's owed work is still owed — and this turn stays owed too,
      // which is why it is reported apart from the settled ones.
      unreadable.push(turn.claim.turnId);
      diagnostics.failure('actor.turn_recovery_failed', toKinuError({
        doing: 'recovering an interrupted hosted actor turn', cause, otherwise: 'io',
      }), { actor: turn.record.name });
    }
  }
  return { resumed, refused, unreadable };
}
