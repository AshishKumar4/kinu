/**
 * LocalAgentHost — the durable-agent substrate owned by the local daemon.
 *
 * ONE PHYSICAL WORKSPACE PER TREE, N LOGICAL ACTORS IN IT. A root agent is one
 * SQLite file; every actor beneath it — a hired subordinate, an ask-by-role
 * temporary, an exploration head, a swarm node, a branch — is a row in that
 * file's `workspace_actors` table and its rows are actor-keyed rows in that
 * same file. Nothing under a root opens a database: no `<child>/agent.db`, no
 * per-head scratch, no second identity table. What each actor has of its own is
 * its RUNTIME OBJECTS — session, stores, queue, abort, roles, alarms — and those
 * come from the ONE {@link ActorHost} this host builds over the root's storage
 * and the root's actor directory.
 *
 * The host keeps one LocalAgentSession per bound AGENT for the daemon's whole
 * process lifetime: every root agent it was handed a ref for, and every live
 * subordinate beneath one. A root is not "the workspace" — several roots share
 * one virtual workspace as equal peers (see ./peers), and the workspace itself
 * is the `{ cwd, workspaceId }` pair on their refs rather than any one of them.
 *
 * Durable work still lives in the existing EventLog/background_jobs/fibers/
 * outbox_peer tables; this module adds no second queue and no second execution
 * loop. It owns the process that drains those tables, recovers them after
 * restart, and delivers session events to subscribers.
 */

import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { LanguageModel, ModelMessage } from 'ai';
import {
  EventLog,
  ReplyChannelStore,
  SubordinateRosterStore,
  SubordinateIdentityStore,
  admitSubordinateTask,
  actorReferenceOf,
  canonicalConversationId,
  childContextResolver,
  createActorHost,
  createLocalPeerEndpoint,
  defaultLoopOrigin,
  samePeerGroup,
  createTeamToolDeps,
  createTemporaryAgentPort,
  renderSubordinateInheritedContext,
  delegationBudgetAtDepth,
  delegationExhausted,
  describeSubordinateHandoff,
  inheritedContextFromHistory,
  headAgentName,
  readSubordinateLiveStatus,
  receiveSubordinateEvent,
  renderSoulMarkdown,
  mintSubordinateName,
  subordinateDescriptorSource,
  subordinateRelaysTurnEnd,
  facetHomeReleaser,
  readSoul,
  recoverSubordinateLifecycles,
  SOUL_PATH,
  TEMPORARY_LIFETIME,
  temporaryRunSettles,
  terminalTaskReport,
  type ActorHost,
  type ActorReference,
  type AgentRuntime,
  type AdmittedSubordinateReport,
  type BoundActor,
  type HostedActor,
  type ReportToolDeps,
  type SubordinateReportOrigin,
  type SubordinateEventResult,
  type SubordinateReportHandoff,
  type SubordinateReportStatus,
  type AgentConfigStore,
  type JsonObject,
  type HostedAgentRef,
  type LocalPeerEndpoint,
  type PeerMessage,
  type ReceiveResult,
  subordinateAgentName,
  type SqlExec,
  type SubordinateHandoff,
  type SubordinateLifetime,
  type SubordinateRuntime,
  type TeamToolDeps,
  type TemporaryAgentPort,
  type SerializedMessage,
  type WorkMode,
  type WorkspaceActor,
  type WorkspaceActorDirectory,
  recoverActorTurns,
} from '@kinu.run/core';
import { KinuError, diagnostics, refusalOf, toKinuError } from '@kinu.run/core/obs';
import {
  createCLIRuntime, makeSql, makeExecRaw, makeSqlExec, shareLocalWorkspacePlane,
  buildLocalActorRuntime, cleanupFacetCwdScratch,
  type CLIRuntime,
} from '../runtime';
import type { CLIOpenConfig } from '../open';
import {
  bindLocalActor, bindLocalActorReference, localActorDirectory, localActorMission, localActorOwner,
  adoptLocalActorHandle, cancelLocalCreation, openLocalActor, recoverLocalActorRetirements, registerLocalActor,
  requireLocalActorWorkspace, type LocalActorBinding,
} from '../actor-identity';
import {
  DriverLeaseHold,
  type DriverKind, type DriverLeaseHolder,
} from './driver-lease';
import {
  LocalAgentSession,
  createLocalOrchestration,
  type LocalAgentSessionOpts,
  type LocalOrchestration,
  type LocalParentRelay,
  type SessionEvent,
} from '../local-session';
import type { LocalModelResolver } from '../model-resolver';
import type { ProfileEnvelopeSource } from '../profile-authority';
import type { McpServerConfig } from '../mcp';

/** The one key a subordinate's own depth is read from. */
const CHILD_DEPTH_KEY = 'subordinate.depth';
/** The child's own copy of how long it is meant to live. On its OWN config, like
 *  its depth, so it survives a daemon restart — which is what lets a recovered
 *  actor still owe its caller the one report a task lifetime requires. */
const CHILD_LIFETIME_KEY = 'subordinate.lifetime';

/** Runtime inputs fixed for one bound agent while this host process is alive. */
export interface LocalHostedAgent {
  rt: CLIRuntime;
  /** Provider/auth wiring reused when this agent hires a subordinate. */
  openConfig: CLIOpenConfig;
  modelResolver?: LocalModelResolver;
  staticModel?: LanguageModel;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Where this agent's role/tier catalog comes from, read live.
   *
   * The host FORWARDS it and never builds one: the caller that opened the agent
   * knows whether the authority is an account catalog or the local one, and a
   * host that invented a default would resolve turns against a catalog nobody
   * chose. Absent means the session falls back to its own bootstrap envelope —
   * which is what a daemon-hosted agent silently did for every turn before this
   * was forwarded, so an account's roles and tiers reached interactive sessions
   * and not the daemon that runs its scheduled work.
   */
  profileAuthority?: ProfileEnvelopeSource;
  /**
   * This machine's provider-configuration revision, read live. Forwarded for
   * the same reason as the authority above: the process that opened the agent
   * owns the config file, and a resident daemon has to see a provider the user
   * connected in another process without being restarted.
   */
  providerRevision?: () => number;
}

export interface LocalAgentHostOptions {
  /**
   * Every local agent this host may bind, re-read per call so a ref recorded
   * after the process started becomes reachable without a restart.
   *
   * The refs are the authority on which roots exist and which virtual
   * workspace each belongs to. A root with no ref is not hosted: the mere
   * existence of an `agent.db` is not the inference, a ref is — a root without
   * one has no `cwd` to bind its plane to and no peer group.
   */
  roster(): readonly HostedAgentRef[];
  /** Build one already-created ROOT agent over the host-owned handle. The ref
   *  carries the physical directory its plane must be bound to. */
  open(ref: HostedAgentRef, db: Database, dbPath: string): Promise<LocalHostedAgent>;
  /** Where one ROOT's database is. There is no child equivalent, and that is
   *  the whole of open-38 on this backend: a subordinate has no path because it
   *  has no file. */
  dbPath(name: string): string;
  /**
   * Ask the driver to run another pass no later than `at` — the peer outbox's
   * retry schedule, the local answer to the cloud backend's alarm.
   *
   * Optional because it only SHORTENS a wait already in progress: every
   * {@link LocalAgentHost.tick} folds the soonest pending retry into the delay
   * it returns, so a driver that re-reads that value after each pass already
   * re-drives pending rows.
   */
  wakeAt?(at: number): void;
  /**
   * What kind of driver this process is, which decides only one thing: who may
   * take the driver lease from whom. An interactive process may take it from a
   * live daemon, because a person waiting at a prompt outranks background
   * maintenance; a daemon never takes it from a live interactive owner, because
   * that would interleave its programmatic turns with the user's own.
   *
   * Defaults to `interactive`: a host built without saying is a foreground one,
   * and the daemon is the single caller that has to declare itself.
   */
  driverKind?: DriverKind;
}

/**
 * What one {@link LocalAgentHost.tick} did.
 *
 * `ran` is the whole reason this is an object rather than the schedule alone: a
 * pass another driver owns converts nothing, and a caller handed only a
 * timestamp cannot tell that from a pass that ran and found nothing to do. The
 * foreground `kinu daemon tick` printed a tick it had not performed for exactly
 * that reason.
 */
export interface LocalTickResult {
  /** Whether this process actually drove the pass. */
  readonly ran: boolean;
  /** Soonest moment this agent asks to be re-driven, or null for nothing due.
   *  Read from the durable schedule either way, so a deferred pass still tells
   *  its caller when to come back. */
  readonly nextAt: number | null;
  /** Who is driving, when this pass was deferred. */
  readonly heldBy?: DriverLeaseHolder;
}

/**
 * ONE root's physical workspace: the file, the actor host over it, and this
 * process's single claim on driving it.
 *
 * Shared by every entry in the subtree, because there is exactly one of each
 * per DATABASE. The driver lease especially: `driver_lease` holds one row per
 * file ("one row, one conversation"), so a hold per entry would have each
 * actor's `acquire` mint a new token and silently invalidate its siblings'.
 */
interface HostTree {
  readonly dbPath: string;
  readonly db: Database;
  /** The ONE actor host for every logical actor in this database. */
  readonly host: ActorHost;
  /**
   * The ONE actor directory for this database, held rather than re-derived.
   *
   * `localActorDirectory` refuses a non-root handle — "only the local root owns
   * the actor directory" — so a per-entry `localActorDirectory(entry.ws.rt.actor)`
   * asked the wrong question the moment an entry's runtime carried a CHILD's
   * handle: there is one directory per database and it is the root's. Holding
   * it here makes that shared-per-database fact structural instead of
   * rediscovered from whichever handle happened to be nearest.
   */
  readonly directory: WorkspaceActorDirectory;
  /** This process's ONE hold on this database's driver row. */
  readonly hold: DriverLeaseHold;
  /** Converting operations in flight under that hold. A daemon hands the lease
   *  back when the LAST one finishes: releasing at the end of one pass while a
   *  concurrent pass is mid-flight would cut that pass short at its next
   *  boundary for no reason. */
  driving: number;
  /** Runtimes this host built outside `runtimeFor` — the ROOT's, which is
   *  opened before the host that would otherwise build it. */
  readonly runtimes: Map<string, CLIRuntime>;
  /** Each actor's orchestration, kept from `orchestrationFor` so the session
   *  built for that actor receives the SAME engine, governor and event rail the
   *  host constructed its `ActorSession` from. */
  readonly orchestrations: Map<string, LocalOrchestration>;
}

interface HostEntry {
  /** Address inside this process: root, root/child, root/child/grandchild.
   *  Root and child addresses are unchanged by virtual workspaces — the
   *  grouping is metadata on {@link HostEntry.ref}, not a path segment. */
  key: string;
  /** Roster-local name. */
  name: string;
  /** This agent's own ref. A subordinate INHERITS its root's pair, so every
   *  actor in one subtree binds the same directory and belongs to the same
   *  virtual workspace as the root it hangs from. */
  ref: HostedAgentRef;
  parentKey: string | null;
  /** The physical workspace this actor lives in — shared with every actor in
   *  the tree, which is what open-38 means. */
  tree: HostTree;
  /** This actor as the tree's host bound it: its reference, directory row,
   *  handle, stores, runtime and the ONE ActorSession its turns are claimed on. */
  actor: HostedActor;
  ws: LocalHostedAgent;
  sessionId: string;
  session: LocalAgentSession;
  config: AgentConfigStore;
  eventLog: EventLog;
  roster: SubordinateRosterStore;
  /** The ONE temporary-agent port for this actor. It holds the live waiters, so
   *  it is built with the entry and never per call: `run` parks on it and the
   *  report ingress resolves it. */
  temporary: TemporaryAgentPort;
  team: TeamToolDeps | null;
  /** Peer mail. Roots only: a subordinate holding this could message the root
   *  of another tree and leave its own depth cap behind in one call. */
  peers: LocalPeerEndpoint | null;
  children: Map<string, HostEntry>;
  relay: {
    ownerDriven: boolean;
    reportedThisTurn: boolean;
    /**
     * Has a report that SETTLES a temporary run already gone out this turn?
     *
     * Distinct from `reportedThisTurn` because the two questions differ, and
     * conflating them hung an ask: a task child may file a mid-task `progress`
     * note, that note sets `reportedThisTurn`, and `temporaryRunSettles`
     * correctly does not treat it as the answer — so a child that filed one and
     * then answered had its terminal report suppressed while its caller waited
     * forever. `reportedThisTurn` means "spoke this turn", which the DURABLE
     * relay policy asks; this means "already answered", which the temporary rung
     * asks.
     */
    settledRun: boolean;
    mode: WorkMode;
  } | null;
  /** How long this actor is MEANT to live. Only the child sees its own turn end,
   *  and a `task` child owes its blocked caller one terminal report for every way
   *  that turn can end — including the endings the durable policy withholds. */
  lifetime: SubordinateLifetime;
}

export type AgentEventListener = (agent: string, event: SessionEvent) => void;

export class LocalAgentHost {
  private readonly entries = new Map<string, HostEntry>();
  /**
   * The same entries by ACTOR ID.
   *
   * The actor host's dependencies are handed a reference, not an address, and
   * every one of them has to reach the entry the reference belongs to — the
   * parent whose provider wiring a hire opens with, and the session an
   * orchestration's ports resolve at call time. An id is what the directory
   * issues, so an id is what this is keyed by.
   */
  private readonly byActor = new Map<string, HostEntry>();
  private readonly listeners = new Set<AgentEventListener>();
  /** First-open fence per address. Recovery must run once even when a timer,
   *  client event, and team call arrive together on a cold daemon. */
  private readonly opening = new Map<string, Promise<HostEntry>>();
  /** One physical workspace per root address. */
  private readonly trees = new Map<string, HostTree>();
  private closed = false;

  constructor(private readonly opts: LocalAgentHostOptions) {}

  private get driverKind(): DriverKind {
    return this.opts.driverKind ?? 'interactive';
  }

  /**
   * Run one CONVERTING operation as this workspace's driver, or decline and say
   * who owns it. Converting means it binds durable rows to a turn — a pass, and
   * the recovery drain a cold host performs on open, which is the same
   * conversion with a different trigger.
   *
   * TWO gates, and they answer different questions. The driver lease is
   * CROSS-PROCESS: one row per database, so it says whether this OS process may
   * convert anything in this workspace at all. `host.run` is IN-PROCESS and PER
   * ACTOR: it serializes this actor's own conversions against each other, so a
   * wake that arrives while a pass is running queues behind it rather than
   * interleaving with it, and a sibling actor's pass is unaffected.
   *
   * A daemon hands the lease back when the LAST converting operation finishes,
   * so an interactive process arriving between passes does not have to preempt
   * anything. An interactive host keeps it until the session ends, which is what
   * stops a daemon pass landing in the middle of somebody's conversation.
   */
  private async drive<T>(
    entry: HostEntry,
    run: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false; heldBy: DriverLeaseHolder }> {
    const tree = entry.tree;
    const refusal = tree.hold.acquire();
    if (refusal) {
      diagnostics.event('driver.pass_deferred', {
        agent: entry.key,
        kind: this.driverKind,
        reason: refusal.refused.reason,
      });
      return { ran: false, heldBy: refusal.holder };
    }
    tree.driving += 1;
    try {
      return { ran: true, value: await tree.host.run(entry.actor.reference, () => run()) };
    } finally {
      tree.driving -= 1;
      if (this.driverKind === 'daemon' && tree.driving === 0) tree.hold.release();
    }
  }

  /** Session events stay live after an interactive client disconnects. */
  subscribe(listener: AgentEventListener): () => void {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Open once, recover once, keep alive until close(). Addresses may name a
   *  root or a roster path such as `root/researcher/parser`. */
  async acquire(address: string): Promise<LocalAgentSession> {
    return (await this.resolveEntry(address)).session;
  }

  /** Already-acquired session, or null. */
  peek(name: string): LocalAgentSession | null {
    return this.entries.get(name)?.session ?? null;
  }

  /**
   * One driver pass. The session methods are no-ops when nothing is due, so
   * the host can service cross-process event rows without a second pending-state
   * mirror.
   *
   * Gated on the driver lease, because this pass CONVERTS durable rows — it
   * binds pending events to a synthetic turn and fires due triggers — and two
   * processes doing that over one database convert the same row twice. Refused
   * is a normal outcome, not a failure: the other driver is doing this work, so
   * this pass reports the schedule it read, says it did not run, and waits.
   */
  async tick(name: string, now = Date.now()): Promise<LocalTickResult> {
    return await this.tickEntry(await this.resolveEntry(name), now);
  }

  /** Subordinate operations for one agent — hire, assign, status, dismiss.
   *  Every bound agent has these, root or subordinate, down to the depth cap. */
  async team(address: string): Promise<TeamToolDeps> {
    const entry = await this.resolveEntry(address);
    if (!entry.team) entry.team = this.buildTeam(entry);
    return entry.team;
  }

  /** Peer mail for one ROOT agent — list/ask/send/reply across the equal roots
   *  of its virtual workspace. Null for a subordinate, which has none. */
  async peers(address: string): Promise<LocalPeerEndpoint | null> {
    return (await this.resolveEntry(address)).peers;
  }

  /**
   * Turns this process interrupted, as the durable claims that outlived it.
   *
   * The recovery read: an unsettled claim is a turn something admitted and
   * nothing finished, and it is answered from the rows rather than from
   * anything this process remembers — so a cold host reads exactly what a warm
   * one would. No timer arms it: the caller that just opened the workspace IS
   * the trigger.
   */
  async resumable(address: string, limit?: number): Promise<ReturnType<ActorHost['resumable']>> {
    const entry = await this.resolveEntry(address);
    return limit === undefined ? entry.tree.host.resumable() : entry.tree.host.resumable(limit);
  }

  /** Every actor of one root's workspace, in any lifecycle state, without
   *  starting any of them. */
  async actors(address: string): Promise<readonly WorkspaceActor[]> {
    const entry = await this.resolveEntry(address);
    return entry.tree.host.list().map((reference) => entry.tree.host.describe(reference.actorId))
      .filter((record): record is WorkspaceActor => record !== null);
  }

  /** End every session, then release every database handle. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const openings = await Promise.allSettled(this.opening.values());
    for (const opening of openings) {
      if (opening.status === 'rejected') {
        diagnostics.failure(
          'host.agent_open_failed',
          toKinuError({ doing: 'opening a local agent during host shutdown', cause: opening.reason, otherwise: 'io' }),
        );
      }
    }
    for (const entry of [...this.entries.values()].reverse()) {
      try {
        await entry.session.end();
      } catch (error) {
        diagnostics.failure(
          'host.session_teardown_failed',
          toKinuError({ doing: 'ending a hosted local session', cause: error, otherwise: 'io' }),
          { agent: entry.key },
        );
      }
    }
    // The runtime objects, then the lease, then the file — in that order, and
    // once per TREE rather than once per actor. Released BEFORE the handle
    // closes and only if the row is still ours: an interactive process holds
    // its lease for the whole session, so this is where a daemon becomes able
    // to drive again. Without it a conversation stays locked to a process that
    // has exited and only a liveness check would recover it.
    for (const tree of this.trees.values()) {
      tree.host.releaseAll();
      tree.hold.release();
      tree.db.close();
    }
    this.entries.clear();
    this.byActor.clear();
    this.trees.clear();
  }

  // ── host lifecycle ──────────────────────────────────────────────────
  private async resolveEntry(address: string): Promise<HostEntry> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const pending = this.opening.get(address);
    if (pending) {
      const entry = await pending;
      await this.recoverChildren(entry);
      return entry;
    }
    const existing = this.entries.get(address);
    if (existing) {
      await this.recoverChildren(existing);
      return existing;
    }
    const separator = address.lastIndexOf('/');
    if (separator >= 0) {
      if (separator === 0 || separator === address.length - 1) {
        throw new Error(`invalid local agent address "${address}"`);
      }
      const parent = await this.resolveEntry(address.slice(0, separator));
      const child = await this.openChildEntry(parent, address.slice(separator + 1));
      await this.recoverChildren(child);
      return child;
    }
    return await this.openTopLevelEntry(address);
  }

  private async openTopLevelEntry(name: string): Promise<HostEntry> {
    const pending = this.opening.get(name);
    if (pending) return await pending;
    const existing = this.entries.get(name);
    if (existing) return existing;
    const opening = this.createTopLevel(name);
    this.opening.set(name, opening);
    try {
      const entry = await opening;
      await this.recoverChildren(entry);
      return entry;
    } finally {
      if (this.opening.get(name) === opening) this.opening.delete(name);
    }
  }

  private async createTopLevel(name: string): Promise<HostEntry> {
    const ref = this.opts.roster().find((candidate) => candidate.name === name);
    if (!ref) {
      throw new Error(`agent "${name}" has no local ref — nothing records which`
        + ' directory or virtual workspace it belongs to, so it cannot be bound.');
    }
    const dbPath = this.opts.dbPath(name);
    if (!existsSync(dbPath)) throw new Error(`agent "${name}" does not exist at ${dbPath}`);
    const db = new Database(dbPath);
    try {
      const ws = await this.opts.open(ref, db, dbPath);
      const tree = this.createTree(ref, db, dbPath, ws);
      this.trees.set(name, tree);
      try {
        const actor = await tree.host.acquire(actorReferenceOf(ws.rt.actor));
        return await this.buildEntry({ key: name, name, ref, parentKey: null, tree, actor, ws });
      } catch (error) {
        // THE HOLD GOES WITH THE TREE. This file's own invariant is "the lease
        // is the TREE's and stays … released once, in close()" — but this path
        // never reaches close(): it DISCARDS the tree. Without releasing here
        // the durable `driver_lease` row keeps naming this pid while the tree
        // that owned it is gone, so `holderAt(dbPath)` reports a live
        // interactive holder that does not exist. It only looked harmless
        // because the next acquire happens to build a fresh hold under the same
        // pid and kind; a different process, or the same one after a driverKind
        // change, would inherit a lease nobody holds.
        try { tree.hold.release(); }
        catch (cause) {
          // RECORDED, not swallowed: a hold that cannot be released is already
          // not held, so this must not replace the open failure being thrown
          // below — but a release that fails for any OTHER reason is the stale
          // `driver_lease` row this branch exists to prevent, and it would then
          // be invisible.
          diagnostics.failure('driver.lease_release_failed', toKinuError({
            doing: 'releasing the discarded tree\'s driver lease', cause, otherwise: 'io',
          }), { workspace: name });
        }
        this.trees.delete(name);
        throw error;
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * The ONE actor host over one root's database.
   *
   * Its three factories are the whole of what "a logical actor" means on this
   * backend: `runtimeFor` gives an actor its own agent-state subtree and its own
   * scaffold pointer over the SHARED workspace plane, `loopFor` seeds the
   * promoted loop it runs (a hire starts on the builtin program, a fork inherits
   * its parent's), and `orchestrationFor` gives it its own event rail, engine,
   * governor and client fan-out. None of them opens a file.
   */
  private createTree(
    ref: HostedAgentRef,
    db: Database,
    dbPath: string,
    ws: LocalHostedAgent,
  ): HostTree {
    const { directory } = localActorDirectory(ws.rt.actor);
    const sql = makeSql(db);
    const hubSql = makeSqlExec(db);
    const runtimes = new Map<string, CLIRuntime>([[ws.rt.actor.actorId, ws.rt]]);
    const orchestrations = new Map<string, LocalOrchestration>();
    const host = createActorHost({
      storage: {
        sql,
        transactionSync: (write) => db.transaction(write)(),
        exec: hubSql.exec,
      },
      directory,
      // The local host publishes NO installed build identity for its builtin
      // loop: there is no build stamp on a `bun`-run checkout and the package
      // version in this repo is a placeholder, so a claim for a builtin turn
      // records the build as unknown rather than naming one nobody can verify.
      installedBuild: null,
      runtimeFor: (bound) => this.runtimeFor(runtimes, dbPath, db, bound),
      loopFor: (bound) => {
        const parentId = bound.reference.parentActorId;
        const parentEntry = parentId === null ? null : this.requireActorEntry(parentId);
        // The origin the CREATION SITE named, or this kind's default — never the
        // default alone. The seating session records what it was asked for
        // before it acquires, and only it knows: a head that names ONE version
        // of its parent's lineage was silently given the parent's CURRENT source
        // here while a bare session honoured the request.
        const named = parentEntry?.session.pendingLoopOrigin(bound.reference.actorId);
        return {
          origin: named ?? defaultLoopOrigin(bound.record.kind),
          parent: parentEntry === null ? null : parentEntry.ws.rt,
        };
      },
      orchestrationFor: (bound) => {
        const orchestration = createLocalOrchestration({
          runtime: bound.runtime,
          // This ACTOR's own durable event rail — the queue both of its
          // ingresses publish into.
          eventLog: new EventLog(hubSql, bound.handle),
          // Resolved at CALL time: the host builds orchestration BEFORE the
          // ActorSession exists (it needs orchestration to construct one), and
          // the session that answers these ports is built from that session.
          session: () => this.requireActorEntry(bound.reference.actorId).session,
          oneShot: false,
          autoEvolve: true,
        });
        // Retained only for the kinds that go on to get a HostEntry, and
        // consumed by the one that does. A head's or a node's orchestration is
        // owned by its seat and dies with it, so retaining it here would grow a
        // map for the length of the process and hand a re-acquired id an object
        // from a seat that is already over.
        if (bound.record.kind === 'main' || bound.record.kind === 'subordinate') {
          orchestrations.set(bound.reference.actorId, orchestration);
        }
        return orchestration.deps;
      },
      // The actor whose context moved is the actor the evidence is about, so
      // the recorder is asked per actor rather than defaulted.
      contextEvents: (bound) => bound.stores.eventRecorder,
      discardBytes: (record) => this.discardActorBytes(ref, ws, record),
    });
    return {
      dbPath, db, host, directory, runtimes, orchestrations, driving: 0,
      hold: new DriverLeaseHold({ sql, execRaw: makeExecRaw(db) }, this.driverKind),
    };
  }

  /**
   * One actor's runtime, over the workspace's ONE database.
   *
   * A ROOT's runtime is not built here: it is opened before the host that would
   * build it (the host is constructed FROM the root's storage and directory), so
   * it is prepared and handed back. A HIRE is built from its parent's provider
   * wiring and retained, because the entry built next reads it back. A HEAD or a
   * NODE is built fresh per acquisition and retained nowhere: its runtime
   * belongs to the seat that asked for it, and a memo keyed on an actor id
   * would both grow without bound and hand a re-acquired id a runtime whose
   * seat has ended.
   */
  private async runtimeFor(
    runtimes: Map<string, CLIRuntime>,
    dbPath: string,
    db: Database,
    bound: BoundActor,
  ): Promise<AgentRuntime> {
    const prepared = runtimes.get(bound.reference.actorId);
    if (prepared) return prepared;
    const parentId = bound.reference.parentActorId;
    if (parentId === null) {
      throw new KinuError('missing', 'A local root is opened before its host, never by it.');
    }
    const parent = this.requireActorEntry(parentId);
    if (bound.record.kind !== 'subordinate') {
      // The observer the SEATER named, read off the parent entry's session for
      // the same reason `loopFor` reads the parent entry's runtime: the host
      // builds this runtime, and only the caller that asked for the seat knows
      // what has to watch it. A head run's file attribution is per run, so it
      // reaches here as a slot filled before `acquire` rather than as a wider
      // `runtimeFor`.
      return await buildLocalActorRuntime(
        parent.ws.rt, bound, parent.session.pendingWriteObserver(bound.reference.actorId),
      );
    }
    const binding = bindLocalActorReference(parent.ws.rt.actor, bound.reference);
    // The HOST's handle, not one derived here: a hire is a CHILD, so the
    // identity rule applies with no exemption — the release fence is bound to
    // this object and a second binding of the same child would outlive it.
    adoptLocalActorHandle(parent.ws.rt.actor, bound.reference, bound.handle);
    const openConfig = this.childOpenConfig(parent, binding);
    const built = createCLIRuntime(db, {
      ...openConfig, dbPath, agentName: binding.name, actor: bound.handle,
    });
    const shared = await shareLocalWorkspacePlane(built, parent.ws.rt, openConfig.facet);
    runtimes.set(bound.reference.actorId, shared);
    return shared;
  }

  /**
   * The bytes one destroyed actor owned OUTSIDE the database.
   *
   * Only bytes: its rows go with its directory row, and there is no file to
   * unlink because it never had one. What it does own is a scratch HOME — a
   * directory under the bound project for a physical plane, a uid-confined home
   * in the workspace filesystem otherwise — named from its storage key and its
   * kind, which is what the directory row records.
   */
  private async discardActorBytes(
    ref: HostedAgentRef,
    ws: LocalHostedAgent,
    record: WorkspaceActor,
  ): Promise<void> {
    const agentName = record.kind === 'head'
      ? headAgentName(record.storageKey)
      : subordinateAgentName(record.storageKey);
    if (ref.cwd) {
      cleanupFacetCwdScratch(ref.cwd, agentName);
      return;
    }
    if (ws.rt.nodeHome) await facetHomeReleaser(ws.rt.nodeHome())(agentName);
  }

  private async buildEntry(input: {
    key: string;
    name: string;
    ref: HostedAgentRef;
    parentKey: string | null;
    tree: HostTree;
    actor: HostedActor;
    ws: LocalHostedAgent;
  }): Promise<HostEntry> {
    const config = input.ws.rt.actor.config;
    const hubSql = makeSqlExec(input.tree.db);
    const orchestration = input.tree.orchestrations.get(input.actor.reference.actorId);
    if (!orchestration) {
      throw new KinuError('missing', 'The hosted actor was acquired without an orchestration.');
    }
    // CONSUMED. The session below holds the three objects from here on, so the
    // handover slot is emptied rather than left as a second reference nothing
    // reads and a re-acquisition could pick up.
    input.tree.orchestrations.delete(input.actor.reference.actorId);
    // THE PARENT'S roster: subordinate names are per-parent, so this store is
    // bound to the actor that hires into it — this one.
    const roster = new SubordinateRosterStore(hubSql, input.actor.handle);
    roster.ensureSchema();
    const sessionId = canonicalConversationId(config);
    const sessionOpts: LocalAgentSessionOpts = {
      rt: input.ws.rt,
      db: input.tree.db,
      // THE HOSTED ACTOR. Its session, stores, engine, governor and event rail
      // are the ones this tree's host already built — so the loop a head or a
      // node claims a turn on is the very session this chat runs on.
      hosted: {
        actor: input.actor,
        host: input.tree.host,
        engine: orchestration.engine,
        budget: orchestration.budget,
        eventLog: orchestration.eventLog,
      },
      // The physical plane and the prompt's runtime context read ONE directory:
      // the one on this agent's ref. Every peer and every subordinate under
      // them binds the same bytes.
      cwd: input.ref.cwd,
      onEvent: (event) => this.onSessionEvent(input.key, event),
    };
    // A subagent's prompt names the workspace it works in, and its own config
    // holds only its own title. Read at prompt time rather than captured now:
    // the ROOT is where a rename and an auto-title both land.
    if (input.parentKey !== null) {
      sessionOpts.workspaceTitle = () => this.rootEntry(input.key).config.getDisplayName();
    }
    // A TASK-LIFETIME child records no turn into the evolution window. Its
    // actor answers one `ask` and is dismissed; every later ask mints a fresh
    // actor, and the lessons ledger is actor-scoped — so a review of its turn
    // is a reflection model call, paid on the asking caller's critical path
    // (`dismiss` joins `settleEvolution`), that writes a row nothing ever
    // reads. The hosted engine stays on: the step clock still ticks for it,
    // exactly as it does for a head or a node on `runHeadInference`. A durable
    // hire keeps recording — it persists and reads its own ledger.
    if (input.actor.record.lifetime === 'task') sessionOpts.noAutoEvolve = true;
    if (input.ws.modelResolver) sessionOpts.modelResolver = input.ws.modelResolver;
    if (input.ws.staticModel) sessionOpts.model = input.ws.staticModel;
    if (input.ws.profileAuthority) sessionOpts.profileAuthority = input.ws.profileAuthority;
    if (input.ws.providerRevision) sessionOpts.providerRevision = input.ws.providerRevision;
    const session = new LocalAgentSession(sessionOpts);
    const entry: HostEntry = {
      key: input.key,
      name: input.name,
      ref: input.ref,
      parentKey: input.parentKey,
      tree: input.tree,
      actor: input.actor,
      ws: input.ws,
      sessionId,
      session,
      config,
      eventLog: orchestration.eventLog,
      lifetime: lifetimeOf(config),
      roster,
      temporary: createTemporaryAgentPort({
        roster,
        // The SAME child substrate the roster drives, so a temporary agent is a
        // real local actor with its own session and tool loop — over this
        // workspace's one database, like every other actor here.
        runtime: this.childRuntime(input.key),
        now: () => Date.now(),
        renderInheritedContext: () => renderSubordinateInheritedContext(
          inheritedContextFromHistory(readConversationTail(this.requireEntry(input.key))),
        ),
        createName: mintSubordinateName,
      }),
      team: null,
      peers: null,
      children: new Map(),
      relay: input.parentKey === null
        ? null
        : { ownerDriven: false, reportedThisTurn: false, settledRun: false, mode: 'build' },
    };
    this.entries.set(input.key, entry);
    this.byActor.set(input.actor.reference.actorId, entry);
    // THE REAL TEAM TRANSPORT. The roster needs the session's broadcast, which
    // only exists once the session is constructed — so the deps are installed
    // immediately after, before any turn can run.
    entry.session.setTeam(this.buildTeam(entry));
    // THE ACTORS THIS ONE MANAGES, for its own `/context/agents/` listing. The
    // resolver is the host's, so a subordinate's working history is reachable
    // from its parent's plane without either of them opening anything.
    input.ws.rt.setChildContext?.(childContextResolver({
      host: input.tree.host,
      directory: input.tree.directory,
      parent: input.actor.handle,
      events: (child) => child.stores.eventRecorder,
    }));
    // THE DRIVER LEASE. Same reason it lands here: it closes over the entry.
    // The pump consults it before every turn, so an interactive process takes
    // the lease from a daemon at that boundary rather than interleaving with it.
    // A closed host refuses instead of reaching the lease: the gate can fire
    // from a turn continuation that outlives close(), and close() has already
    // released the holds and closed this tree's database handle.
    entry.session.setDriverGate(() => this.closed
      ? refusalOf(new KinuError('unavailable', 'this host is closed; no driver conversion may start'))
      : entry.tree.hold.acquire()?.refused ?? null);
    // The two transports that split on the same fact, installed here for the
    // same reason as the team deps: both close over this entry's session.
    //
    // Roots get PEER MAIL — their inbox wakes this session, so the session has
    // to exist first. Subordinates get the REPORT SPINE instead. Without it a
    // local child could only ever be relayed as `progress`, so its parent's
    // roster never left `working` on the child's own signal and every
    // delegation decision above it ran on a permanently-busy helper.
    if (input.parentKey === null) {
      entry.peers = this.buildPeerEndpoint(entry, hubSql);
      entry.session.setPeers(entry.peers.deps);
    } else {
      entry.session.setReport(this.buildReport(entry));
      // The AUTOMATIC turn-end report, as an effect the child's own settled turn
      // owes. Beside the report spine because they are the two halves of the same
      // channel: the model's own word, and the answer a parent-driven turn owes
      // whether or not the model said one.
      entry.session.setParentRelay(this.parentRelayFor(entry));
    }

    try {
      if (input.ws.mcpServers && Object.keys(input.ws.mcpServers).length > 0) {
        await session.connectMcp(input.ws.mcpServers);
      }
      await session.recoverBackgroundJobs();
      // A previous process could die after publishing but before its debounce
      // timer fired, or AFTER a drain bound its rows to a turn it never ran.
      // EventLog rows are the queue: reclaim what the dead process left leased,
      // then drain everything pending — in that order, so the reclaimed rows
      // land in this same drain's selection.
      //
      // Under the lease bracket, because both halves convert rows exactly as a
      // pass does: the drain binds pending events to a synthetic turn, and the
      // reclaim's whole authority for calling an open lease dead is that no
      // other process may be driving while this one holds the lease. Opening an
      // agent is not a licence to drive one somebody else is driving, and gating
      // HERE means the rows are never bound in the first place rather than bound
      // and compensated back a moment later.
      //
      // This is also why a local task child needs no `recovered` report: the
      // reclaim hands its assignment back to the pending pool and the drain
      // below RE-RUNS it, so the child answers normally. Its caller's waiter
      // died with the previous process, so that answer takes the waiter-absent
      // path — a correlated report event, and the row released by the roster's
      // own report policy. The cloud child recovers differently (its terminal
      // sequence is claimed per turn, not re-run), which is why the `recovered`
      // ending is emitted there and not here.
      await this.drive(entry, async () => {
        // CLAIMS BEFORE ROWS, and the order is the same one the cf sweep runs:
        // the reclaim below hands a dead process's assignment back to the
        // pending pool and the drain RE-RUNS it, but a turn that process had
        // already admitted still holds an unsettled claim — and per-actor
        // serialization would refuse the re-run rather than start it. So the
        // claims are reconciled first: verified ones resume under the exact
        // bytes they were admitted with, and the rest are settled
        // `indeterminate`, which is what is known about them.
        //
        // This is the caller the recovery read was written for and never had.
        // `resumable` says "no timer arms it: the caller that just opened the
        // workspace IS the trigger" — this is that caller, on both backends now
        // through the one core implementation.
        const recovered = await recoverActorTurns(input.tree.host);
        if (recovered.resumed.length + recovered.refused.length + recovered.unreadable.length > 0) {
          // `unreadable` is reported apart from `refused` because the two mean
          // different things to whoever reads this line: a refused turn was
          // SETTLED indeterminate, an unreadable one is still owed.
          diagnostics.event('actor.turns_recovered', {
            resumed: recovered.resumed.length,
            refused: recovered.refused.length,
            unreadable: recovered.unreadable.length,
          });
        }
        session.reclaimStrandedEventDeliveries();
        await session.flushPendingDrains();
      });
      return entry;
    } catch (error) {
      this.entries.delete(input.key);
      this.byActor.delete(input.actor.reference.actorId);
      const cleanupErrors: Error[] = [];
      try {
        await session.end();
      } catch (cleanupError) {
        cleanupErrors.push(new Error('ending the failed hosted session', { cause: cleanupError }));
      }
      // The runtime objects go back to the host, so a retry re-acquires them
      // rather than reusing half-built ones. The lease is the TREE's and stays:
      // its other actors are still driving under it, and it is released once,
      // in close().
      // A CHILD releases; the ROOT does not. The root's binding belongs to
      // whoever opened the workspace, and `createTopLevel`'s own catch deletes
      // the whole tree — host, hold, runtimes map and database — so releasing
      // an actor from a host that is about to be dropped achieves nothing and
      // the refusal it earns would bury the REAL failure inside an
      // AggregateError: a failed open would report "did not release" instead of
      // the drain error that actually failed it. A child's release is the case
      // this cleanup exists for, and its host is one the retry will reuse.
      if (input.actor.reference.parentActorId !== null) {
        try {
          input.tree.host.release(input.actor.reference);
        } catch (cleanupError) {
          cleanupErrors.push(new Error('releasing the failed hosted actor', { cause: cleanupError }));
        }
      }
      input.tree.orchestrations.delete(input.actor.reference.actorId);
      input.tree.runtimes.delete(input.actor.reference.actorId);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [new Error(`opening hosted agent "${input.key}"`, { cause: error }), ...cleanupErrors],
          `opening hosted agent "${input.key}" failed and its session or hosted actor did not release`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async recoverChildren(parent: HostEntry): Promise<void> {
    for (const roster of parent.roster.list()) {
      if (roster.birth !== null || roster.deleteRequested || parent.children.has(roster.name)) continue;
      try {
        await this.openChildEntry(parent, roster.name);
      } catch (error) {
        diagnostics.failure(
          'host.subordinate_recovery_failed',
          toKinuError({ doing: 'recovering a local subordinate', cause: error, otherwise: 'io' }),
          { parent: parent.key, subordinate: roster.name },
        );
      }
    }
  }

  private async openChildEntry(parent: HostEntry, childName: string): Promise<HostEntry> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const key = `${parent.key}/${childName}`;
    const binding = openLocalActor(parent.ws.rt.actor, childName);
    const openingKey = `${parent.key}/${binding.storageKey}`;
    const pending = this.opening.get(openingKey);
    if (pending) return await pending;
    const existing = parent.children.get(childName);
    if (existing) {
      if (existing.ws.rt.actor.actorId !== binding.reference.actorId) throw new KinuError('denied', 'The cached actor is a different creation.');
      requireLocalActorWorkspace(parent.ws.rt.actor, existing.ws.rt.actor);
      return existing;
    }
    const opening = this.openExistingChild(parent, binding, key);
    this.opening.set(openingKey, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(openingKey) === opening) this.opening.delete(openingKey);
    }
  }

  /**
   * Bind an already-created subordinate.
   *
   * There is nothing to open and nothing to check for existence: the child's
   * state IS its rows in this tree's database, and whether those rows may be
   * bound is the directory's answer — `openLocalActor` already refused a
   * retired creation. The host builds its runtime and its session; the file was
   * opened once, by the root.
   */
  private async openExistingChild(
    parent: HostEntry,
    binding: LocalActorBinding,
    key: string,
  ): Promise<HostEntry> {
    const childName = binding.name;
    const actor = await parent.tree.host.acquire(binding.reference);
    try {
      const rt = parent.tree.runtimes.get(binding.reference.actorId);
      if (!rt) throw new KinuError('missing', 'The hosted subordinate has no bound runtime.');
      const ws: LocalHostedAgent = { rt, openConfig: this.childOpenConfig(parent, binding) };
      if (parent.ws.modelResolver) ws.modelResolver = parent.ws.modelResolver;
      if (parent.ws.staticModel) ws.staticModel = parent.ws.staticModel;
      if (parent.ws.mcpServers) ws.mcpServers = parent.ws.mcpServers;
      // A child resolves its role and tier against its ROOT's authority: the
      // catalog is the account's, not the agent's, so a subordinate that
      // bootstrapped its own would resolve a hired role the catalog never
      // carried.
      if (parent.ws.profileAuthority) ws.profileAuthority = parent.ws.profileAuthority;
      const entry = await this.buildEntry({
        key,
        name: childName,
        ref: childRef(parent, childName),
        parentKey: parent.key,
        tree: parent.tree,
        actor,
        ws,
      });
      requireLocalActorWorkspace(parent.ws.rt.actor, rt.actor);
      parent.children.set(childName, entry);
      return entry;
    } catch (error) {
      parent.tree.host.release(binding.reference);
      throw error;
    }
  }

  /**
   * The provider/auth wiring a subordinate opens with — its parent's, with the
   * bound directory forced to the parent's ref and the child named as the facet
   * it is.
   *
   * Forced rather than inherited verbatim because "a subordinate shares its
   * root's bytes" then holds by construction: whatever the caller put in the
   * root's `openConfig`, a child cannot be opened against a different plane.
   */
  private childOpenConfig(parent: HostEntry, binding: LocalActorBinding): CLIOpenConfig & { facet: string } {
    if (binding.kind !== 'subordinate') throw new KinuError('denied', 'The roster path is not a subordinate actor.');
    return { ...parent.ws.openConfig, cwd: parent.ref.cwd, facet: subordinateAgentName(binding.storageKey), actorBinding: binding };
  }

  /** One agent's peer endpoint, over the same `outbox_peer`/`reply_channels`
   *  tables its own workspace database already holds. */
  private buildPeerEndpoint(entry: HostEntry, hubSql: SqlExec): LocalPeerEndpoint {
    // The store and the endpoint are mutually dependent — a reply routes back
    // over the endpoint's outbox, and the endpoint answers through the store —
    // so the dispatcher reads `entry.peers` at DISPATCH time, by then set.
    const replyChannels = new ReplyChannelStore(hubSql, entry.actor.handle, {
      peer_back: {
        dispatch: async (channel, payload) => {
          const endpoint = entry.peers;
          if (!endpoint) return { delivered: false, detail: 'this agent holds no peer transport' };
          return endpoint.peerBack(channel, payload);
        },
      },
    });
    return createLocalPeerEndpoint({
      self: entry.ref,
      roster: () => this.opts.roster(),
      sql: hubSql,
      log: entry.eventLog,
      replyChannels,
      vfs: () => entry.ws.rt.storage.vfs,
      deliver: (peer, msg) => this.deliverToPeer(entry, peer, msg),
      scheduleDispatch: (at) => this.opts.wakeAt?.(at),
      onAdmitted: () => this.wake(entry, 'peer message'),
    });
  }

  /**
   * The peer hop: open the named root inside this agent's virtual workspace and
   * hand the message to its own endpoint.
   *
   * A name outside the group is REFUSED (the outbox dead-letters it), which is
   * the enforcement half of peer membership — the roster check in the endpoint
   * is the legibility half. A member that cannot be opened THROWS, so the
   * outbox backs off and retries instead of losing the message.
   */
  private async deliverToPeer(
    sender: HostEntry,
    peer: string,
    msg: PeerMessage,
  ): Promise<ReceiveResult> {
    const ref = this.opts.roster().find((candidate) => candidate.name === peer);
    if (!ref || peer === sender.name || !samePeerGroup(ref, sender.ref)) {
      return {
        admitted: false,
        reason: `"${peer}" is not a peer in virtual workspace "${sender.ref.workspaceId}"`,
      };
    }
    const receiver = await this.resolveEntry(peer);
    if (!receiver.peers) {
      throw new Error(`peer "${peer}" is bound without a peer transport`);
    }
    return receiver.peers.receive(msg);
  }

  /**
   * One agent's pass, then each subordinate's.
   *
   * Every actor is bracketed separately, and the bracket is two gates, not
   * one: the tree's cross-process lease says whether this process may convert
   * anything here, and `host.run` serializes THIS actor's conversions. Neither
   * gate is a per-subordinate lease token — gating a subordinate on a token
   * nobody takes for it strands its triggers, drains and evolution silently on
   * a cold host.
   *
   * `ran` describes THIS agent's pass. A subordinate that is busy elsewhere
   * does not make its parent's pass a non-event, but its schedule still rides
   * back so the driver's next sleep covers it.
   */
  private async tickEntry(entry: HostEntry, now: number): Promise<LocalTickResult> {
    const outcome = await this.drive(entry, () => this.runPass(entry, now));
    let nextAt = outcome.ran ? outcome.value : nextTriggerAt(entry.tree.db);
    for (const child of entry.children.values()) {
      const childNext = (await this.tickEntry(child, now)).nextAt;
      if (childNext !== null) nextAt = nextAt === null ? childNext : Math.min(nextAt, childNext);
    }
    return outcome.ran ? { ran: true, nextAt } : { ran: false, nextAt, heldBy: outcome.heldBy };
  }

  /**
   * The converting steps of one agent's pass, under a lease its caller took.
   *
   * The lease is re-checked between each step, not once at the top. Preemption
   * is the reason: an interactive process can take it while this pass is
   * awaiting, and the next durable conversion must not happen after that. A
   * pass that loses it stops and reports its schedule — the work is not lost,
   * the new driver owns it.
   */
  private async runPass(entry: HostEntry, now: number): Promise<number | null> {
    const hold = entry.tree.hold;
    const lifecyclePending = await recoverSubordinateLifecycles(entry.roster, this.childRuntime(entry.key));
    if (!hold.held()) return nextTriggerAt(entry.tree.db);
    if (entry.parentKey === null) {
      // A retirement this process interrupted, finished. The bytes are the only
      // thing outside the database, and the rows the retirement releases are
      // this tree's own — so there is no file walk here, just the
      // storage path the directory recorded.
      await recoverLocalActorRetirements(entry.ws.rt.actor, async (path) => {
        const storageKey = path[path.length - 1];
        if (storageKey === undefined) return;
        const record = entry.tree.host.describe(storageKey);
        if (record) await this.discardActorBytes(entry.ref, entry.ws, record);
      });
      if (!hold.held()) return nextTriggerAt(entry.tree.db);
    }
    await entry.session.fireDueTriggers(now);
    if (!hold.held()) return nextTriggerAt(entry.tree.db);
    await entry.session.flushPendingDrains();
    if (!hold.held()) return nextTriggerAt(entry.tree.db);
    await entry.session.runDueEvolution();

    let next = nextTriggerAt(entry.tree.db);
    if (lifecyclePending) next = next === null ? now : Math.min(next, now);
    // Pending peer mail is durable, so a process that died mid-delivery has
    // rows waiting. Draining here is what re-drives them after a restart, and
    // the soonest retry rides back out so the driver's next sleep covers it.
    if (entry.peers) {
      const retryAt = await entry.peers.dispatch(now);
      if (retryAt !== null) next = next === null ? retryAt : Math.min(next, retryAt);
    }
    return next;
  }

  private onSessionEvent(key: string, event: SessionEvent): void {
    const entry = this.entries.get(key);
    for (const listener of this.listeners) listener(entry?.key ?? key, event);
    if (entry?.relay) this.observeChildTurn(entry, event);
  }

  // ── subordinate reports ─────────────────────────────────────────────

  /**
   * Track what a child's turn IS, for the relay decision its own roster makes.
   *
   * No `turn-end` branch. The child's terminal roster owns the automatic
   * report, through {@link parentRelayFor} — which reads the same two facts
   * this keeps, while the turn's answer is still being committed. Starting it
   * from here as an untracked promise would let a process die before the
   * parent's ingress admitted it, leaving nothing recording that a retry was
   * owed.
   *
   * No `tool-call` branch either. The reported flag is set by the report dep
   * itself (see buildEntry), which is the only place that sees BOTH the native
   * `report` tool and its `report.*` codemode twin — and which sees them when
   * they actually publish rather than when a call starts.
   */
  private observeChildTurn(child: HostEntry, event: SessionEvent): void {
    const state = child.relay;
    if (!state || event.type !== 'turn-start') return;
    state.ownerDriven = event.kind === 'user';
    state.reportedThisTurn = false;
    state.settledRun = false;
    state.mode = event.workMode;
  }

  /**
   * The automatic turn-end report, as an effect the child's settled turn OWES.
   *
   * Core's `subordinateRelaysTurnEnd` decides whether a DURABLE turn relays
   * using the state {@link observeChildTurn} keeps, and `terminalTaskReport`
   * supplies a TASK child's ending text. The child's ledger records the
   * obligation for replay if parent admission is interrupted.
   *
   * There is no `error` branch and no `turn-end` branch here. Two branches each
   * starting their own detached relay is how one failing turn — an `error` event
   * AND a `turn-end` event — reaches the parent twice. The session declares one
   * report per ending, and this port only answers which.
   */
  private parentRelayFor(child: HostEntry): LocalParentRelay {
    return {
      owed: (ending, assistantText) => {
        const state = child.relay;
        // Suppressed by a report that already SETTLED the run — never by a mere
        // progress note, which leaves the caller waiting and therefore leaves the
        // answer owed.
        if (state === null || state.settledRun) return null;
        // A task child ALWAYS reports its ending, including one with nothing to
        // say: the durable policy withholds an empty answer because an answer
        // nobody asked for is not progress, and this child's caller DID ask.
        const task = terminalTaskReport({ lifetime: child.lifetime, ending, assistantText });
        if (task) return task;
        // A hire reaches the SAME selective policy it always had, and only for a
        // turn that finished.
        if (ending !== 'answered') return null;
        return subordinateRelaysTurnEnd({
          reportedThisTurn: state.reportedThisTurn,
          ownerDriven: state.ownerDriven,
          assistantText,
        })
          ? { status: 'progress', content: assistantText }
          : null;
      },
      sequenceId: (messageId) => `${child.key}:turn-end:${messageId}`,
      send: async ({ text, status, mode, sequenceId }) => {
        // RECORDED before the send, so a second terminal path on the same turn is
        // suppressed even while this one is in flight. One question, one result.
        if (child.relay) {
          child.relay.reportedThisTurn = true;
          child.relay.settledRun = true;
        }
        const relayed = await this.relayToParent(
          child, text, mode, status, 'turn_end', sequenceId,
        );
        return relayed.disposition;
      },
    };
  }

  /**
   * Publish one report from a child into its parent's event rail.
   *
   * `status` is the child's own word, never this host's. It decides where the
   * parent's roster row moves — core `applyReport` takes `completed` to idle and
   * `blocked` to awaiting_input — so hardcoding `progress` here left every local
   * subordinate permanently working in its parent's eyes, whatever it said.
   * The automatic turn-end relay still passes `progress`, because an answer
   * nobody was asked for is progress and nothing stronger.
   */
  private async relayToParent(
    child: HostEntry,
    content: string,
    mode: WorkMode,
    status: SubordinateReportStatus,
    origin: SubordinateReportOrigin,
    /** This report's identity on the parent's rail: the key the parent's
     *  ingress deduplicates on, so one report cannot wake it twice. */
    sequenceId: string,
    /** The `report` tool's structured handoff. Absent on the automatic
     *  turn-end relay below, which has only the assistant's closing prose. */
    handoff?: SubordinateReportHandoff,
  ): Promise<SubordinateEventResult> {
    if (!child.parentKey) return { id: '', disposition: 'not_awaited' };
    const parent = this.entries.get(child.parentKey);
    if (!parent) throw new Error(`parent "${child.parentKey}" is not hosted`);
    return receiveSubordinateEvent({
      log: parent.eventLog,
      roster: parent.roster,
      vfs: parent.ws.rt.storage.vfs,
      // REAL, over the workspace's ONE connection — both writes land in the
      // same file, which is also the file the child wrote its answer in.
      // Core's replay fast path reads the dedupe key and answers `already_held`
      // without re-applying the report, so nothing but this transaction keeps an
      // interruption between the event insert and the roster update from leaving
      // a completed child `working` in its parent's eyes forever, with no retry
      // able to correct it.
      transaction: (body) => parent.tree.db.transaction(body)(),
      announce: (report: AdmittedSubordinateReport) => {
        const metadata: JsonObject = {
          kind: 'report',
          subordinate: report.subordinate,
          timestamp: report.timestamp,
        };
        if (report.task) metadata.task = report.task;
        parent.session.broadcast({
          type: 'subordinate_event',
          status: report.status,
          text: report.content,
          metadata,
        });
      },
      onAdmitted: () => this.wake(parent, 'subordinate report'),
      // A temporary child's answer belongs to the `agents.ask` call waiting on
      // it — through the very port that parked the waiter, so it never doubles
      // as an event that wakes this parent.
      temporary: parent.temporary,
    }, {
      fromSubordinate: child.name,
      status,
      content,
      origin,
      sequenceId,
      mode,
      handoff,
    }, Date.now());
  }

  /**
   * The report spine for one subordinate — the CLI peer of SubordinateAgent's
   * `report` wiring.
   *
   * Roots get none: a root has no parent to report to, so the tool is
   * structurally absent rather than present and refusing. The session gates it
   * further to parent-ASSIGNED turns only, because an owner-driven chat with a
   * subordinate is private to that chat.
   */
  private buildReport(child: HostEntry): ReportToolDeps {
    return {
      report: async ({ status, content, handoff }) => {
        const relayed = await this.relayToParent(
          child, content, child.relay?.mode ?? 'build', status, 'report_tool',
          // One in-process tool call is one report — a second call with the
          // same words is a second thing the model chose to say.
          `${child.key}:report:${crypto.randomUUID()}`,
          handoff,
        );
        // Set HERE rather than off a `tool-call` event: this is the one seam
        // both the native tool and the `report.*` codemode namespace publish
        // through, and it fires when the report actually landed.
        if (child.relay) {
          child.relay.reportedThisTurn = true;
          // Only a run-SETTLING report counts as the answer. Same predicate the
          // parent's ingress settles the waiter on.
          child.relay.settledRun ||= temporaryRunSettles({ status, origin: 'report_tool' });
        }
        return { disposition: relayed.disposition, id: relayed.id };
      },
    };
  }

  // ── local SubordinateRuntime ────────────────────────────────────────

  private buildTeam(parent: HostEntry): TeamToolDeps {
    const delegation = delegationBudgetAtDepth(treeDepthOf(parent.config));
    const input: Parameters<typeof createTeamToolDeps>[0] = {
      delegation,
      roster: parent.roster,
      runtime: this.childRuntime(parent.key),
      now: () => Date.now(),
      inheritedContext: (): SerializedMessage[] =>
        inheritedContextFromHistory(readConversationTail(parent)),
      // What this agent is FOR, as its own workspace records it — inherited by
      // an additional agent the owner adds beneath it without saying anything.
      ownMission: () => localActorMission(parent.ws.rt, makeSqlExec(parent.tree.db)) ?? '',
      createName: mintSubordinateName,
      broadcast: (event) => parent.session.broadcast(event),
      broadcastTask: (event) => parent.session.broadcast({
        type: 'subordinate_event',
        status: 'task',
        text: event.content,
        metadata: {
          subordinate: event.subordinate,
          timestamp: event.timestamp,
        },
      }),
    };
    // STRUCTURAL CONTAINMENT AT THE CAP FOR THIS RUNG — the same MECHANISM the
    // cloud backend applies to its whole team surface (`teamProfile()` wires no
    // team deps at all there), at a narrower scope: this drops only the temporary
    // port, so `hire` is still advertised here and is caught by core's dispatch
    // refusal rather than by absence.
    //
    // A role-targeted `ask` births a child through this very runtime, so it adds
    // a level exactly as a hire does. Wiring the port unconditionally left a
    // depth-4 local actor advertising and running it, seeding a depth-5 child
    // that got a port of its own — one call per level, without bound, which is
    // the failure `DELEGATION_MAX_DEPTH` exists to prevent. Absent, the rung is
    // gone from the schema, the sandbox declaration and the prompt; core's
    // dispatch refusal covers the window a cached toolset leaves open.
    if (!delegationExhausted(delegation)) {
      Object.assign(input, { temporary: parent.temporary });
    }
    return createTeamToolDeps(input);
  }

  /**
   * THE child substrate of one hosted agent: birth, assign, status, rename,
   * retire. One object for both rungs — the durable roster and the temporary
   * register — so a temporary agent is the same kind of local actor a hire is,
   * with its own session and its own tool loop over the workspace's one store.
   *
   * Keyed by ADDRESS rather than closing over the entry, because the temporary
   * port is built with the entry and therefore before it is registered. Every
   * method resolves the parent at call time, which is also what keeps it correct
   * across a re-open.
   */
  private childRuntime(parentKey: string): SubordinateRuntime {
    const parentOf = () => this.requireEntry(parentKey);
    return {
      spawn: async (input) => { const child = await this.birthChild(parentOf(), input); return actorReferenceOf(child.ws.rt.actor); },
      cancelBirth: async (input) => {
        const parent = parentOf();
        return await this.retireCreation(parent, {
          name: input.name, creationId: input.creationId, lifetime: input.lifetime,
        });
      },
      assign: async (name, input) => {
        const parent = parentOf();
        const child = await this.openChildEntry(parent, name);
        return this.admitChildWork(parent, child, { kind: 'task', ...input });
      },
      status: async (name) => {
        const child = await this.openChildEntry(parentOf(), name);
        return readSubordinateLiveStatus(makeSqlExec(child.tree.db), child.actor.handle);
      },
      message: async (name, content, mode) => {
        const parent = parentOf();
        const child = await this.openChildEntry(parent, name);
        return this.admitChildWork(parent, child, { kind: 'message', body: content, mode });
      },
      rename: async (name, displayName, nameOrigin) => {
        const child = await this.openChildEntry(parentOf(), name);
        child.config.setDisplayNameOrigin(displayName, nameOrigin);
        child.session.broadcast({ type: 'workspace_renamed', displayName });
      },
      dismiss: async (name, keepHistory, reference) => {
        await this.removeChild(parentOf(), name, keepHistory, reference);
      },
    };
  }

  private requireEntry(key: string): HostEntry {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`local agent "${key}" is not hosted`);
    return entry;
  }

  /** The entry one ISSUED actor id belongs to. The host's dependencies are
   *  handed references, and this is how a reference becomes the actor's own
   *  session, parent wiring and tree. */
  private requireActorEntry(actorId: string): HostEntry {
    const entry = this.byActor.get(actorId);
    if (!entry) throw new KinuError('missing', `local actor "${actorId}" is not hosted`);
    return entry;
  }

  /** The workspace entry at the top of this agent's tree — itself, for a
   *  workspace's own chat. A subordinate hires subordinates, so the immediate
   *  parent is not the workspace past depth 1. */
  private rootEntry(key: string): HostEntry {
    let entry = this.requireEntry(key);
    while (entry.parentKey !== null) entry = this.requireEntry(entry.parentKey);
    return entry;
  }

  /** Birth + seed the child before its LocalAgentSession becomes reachable. */
  private async birthChild(
    parent: HostEntry,
    input: Parameters<LocalAgentHost['birthChildEntry']>[1],
  ): Promise<HostEntry> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const key = `${parent.key}/${input.name}`;
    const binding = registerLocalActor(parent.ws.rt.actor, { name: input.name, creationId: input.creationId, kind: 'subordinate', lifetime: input.lifetime });
    const openingKey = `${parent.key}/${binding.storageKey}`;
    const pending = this.opening.get(openingKey);
    if (pending) return await pending;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.ws.rt.actor.actorId !== binding.reference.actorId) throw new KinuError('denied', 'The actor alias is held by a different creation.');
      return existing;
    }
    const opening = this.birthChildEntry(parent, input, key, binding);
    this.opening.set(openingKey, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(openingKey) === opening) this.opening.delete(openingKey);
    }
  }

  /**
   * Create one subordinate: its descriptor rows, then its hosted actor.
   *
   * NO DATABASE IS CREATED. The child's identity is the `workspace_actors` row
   * its registration wrote, and its descriptor, depth and lifetime are rows in
   * the same file its parent is bound to — so this is a transaction, not a file
   * creation, and there is no window in which a half-made child owns a file
   * nothing points at. The promoted loop it starts on is seeded by the host
   * (`loopFor`), which is why nothing bootstraps a scaffold here.
   */
  private async birthChildEntry(
    parent: HostEntry,
    input: Parameters<SubordinateRuntime['spawn']>[0],
    key: string,
    binding: LocalActorBinding,
  ): Promise<HostEntry> {
    const llm = parent.ws.openConfig.llm;
    if (!llm) {
      throw new Error('No provider configured for this host — subordinate creation needs a connected provider.');
    }
    const tree = parent.tree;
    const exec = makeSqlExec(tree.db);
    const sql = makeSql(tree.db);
    const owner = localActorOwner(parent.ws.rt.actor);
    const depth = treeDepthOf(parent.config) + 1;
    try {
      tree.db.transaction(() => {
        // The child's own handle, bound to its own directory row — the only
        // identity a local actor has. Every store below is scoped to it, so
        // one workspace database holds N descriptors keyed by actor rather
        // than one singleton row that only the last child could own.
        const actor = bindLocalActor(sql, binding);
        const subordinateIdentity = new SubordinateIdentityStore(exec, actor);
        subordinateIdentity.ensureSchema();
        subordinateIdentity.seed({
          name: input.name, mission: input.mission,
          ownerUserId: owner.ownerUserId, parentWorkspace: owner.workspaceName,
          depth, lifetime: input.lifetime,
        });
        actor.config.setDisplayNameOrigin(input.displayName, input.nameOrigin);
        actor.config.setRoleSelection(input.role);
        actor.config.setAssignedTier(input.tier ?? null);
        const inheritedModel = parent.config.getModel();
        if (inheritedModel) actor.config.setModel(inheritedModel);
        actor.config.set(CHILD_DEPTH_KEY, String(depth));
        actor.config.set(CHILD_LIFETIME_KEY, input.lifetime);
      })();
      const actor = await tree.host.acquire(binding.reference);
      const rt = tree.runtimes.get(binding.reference.actorId);
      if (!rt) throw new KinuError('missing', 'The created subordinate has no bound runtime.');
      const config = rt.actor.config;
      const descriptor = subordinateDescriptorSource(config).read();
      if (!descriptor) throw new Error(`subordinate "${input.name}" has no readable descriptor after creation`);
      // SOUL belongs to the AGENT, never to the shared directory. With a bound
      // cwd, `storage.vfs` IS the user's project, so writing there would drop a
      // SOUL.md into their repo and every peer's hire would overwrite the last
      // one. `agentStateVfs` is this agent's own tree; the `??` is the spelling
      // for backends where the two coincide.
      const actorFiles = rt.agentStateVfs ?? rt.storage.vfs;
      if (!(await readSoul(actorFiles))) await actorFiles.writeFile(SOUL_PATH,
        [
          renderSoulMarkdown({ name: descriptor.displayName, mission: input.mission }),
          '',
          '## Role',
          '',
          `Role: ${descriptor.role}${descriptor.tier ? ` (tier ${descriptor.tier})` : ''}`,
        ].join('\n'),
      );
      const ws: LocalHostedAgent = { rt, openConfig: this.childOpenConfig(parent, binding) };
      if (parent.ws.modelResolver) ws.modelResolver = parent.ws.modelResolver;
      if (parent.ws.staticModel) ws.staticModel = parent.ws.staticModel;
      if (parent.ws.mcpServers) ws.mcpServers = parent.ws.mcpServers;
      if (parent.ws.profileAuthority) ws.profileAuthority = parent.ws.profileAuthority;
      const entry = await this.buildEntry({
        key,
        name: input.name,
        ref: childRef(parent, input.name),
        parentKey: parent.key,
        tree,
        actor,
        ws,
      });
      requireLocalActorWorkspace(parent.ws.rt.actor, rt.actor);
      parent.children.set(input.name, entry);
      return entry;
    } catch (error) {
      tree.host.release(binding.reference);
      const installed = this.entries.get(key);
      if (installed?.ws.rt.actor.actorId === binding.reference.actorId) {
        this.entries.delete(key);
        this.byActor.delete(binding.reference.actorId);
      }
      throw error;
    }
  }

  private admitChildWork(
    parent: HostEntry,
    child: HostEntry,
    input: {
      kind: 'task' | 'message';
      body: string;
      mode: WorkMode;
      deliverable?: string;
      inheritedContext?: string;
    },
  ): SubordinateHandoff {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const admission = admitSubordinateTask(child.eventLog, {
      fromWorkspace: parent.name,
      kind: input.kind,
      body: input.body,
      deliverable: input.deliverable,
      inheritedContext: input.inheritedContext,
      mode: input.mode,
      now: Date.now(),
    });
    const handoff = describeSubordinateHandoff({
      admission,
      turnInFlight: child.session.turnInFlight(),
      live: readSubordinateLiveStatus(makeSqlExec(child.tree.db), child.actor.handle),
    });
    if (admission.admitted) this.wake(child, 'subordinate task');
    return handoff;
  }

  /**
   * Retire a creation that was cancelled before it ran.
   *
   * Through the host, like every other retirement: it drops the runtime objects
   * and discards the bytes, and the rows stay or go by the directory's own
   * cancel/release rules.
   */
  private async retireCreation(
    parent: HostEntry,
    input: { name: string; creationId: string; lifetime: WorkspaceActor['lifetime'] },
  ): Promise<ActorReference> {
    // The creation is CANCELLED against the record it was admitted under, not
    // registered and then destroyed: `cancelCreation` refuses a name, kind or
    // lifetime that disagrees with the admitted birth, and never activates the
    // row, so no roster read can see a child that was never born. The physical
    // half still goes through the host, which owns this actor's runtime objects
    // and is the thing that refuses a stale alias.
    const reference = cancelLocalCreation(parent.ws.rt.actor, {
      name: input.name, creationId: input.creationId, kind: 'subordinate', lifetime: input.lifetime,
    });
    await parent.tree.host.retire(parent.actor.reference, {
      reference, name: input.name, destroy: true,
    });
    return reference;
  }

  private async removeChild(parent: HostEntry, name: string, keepHistory: boolean, reference: ActorReference): Promise<void> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const candidate = parent.children.get(name) ?? this.entries.get(`${parent.key}/${name}`);
    const child = candidate?.ws.rt.actor.actorId === reference.actorId ? candidate : undefined;
    if (child) {
      await child.session.end();
      if (parent.children.get(name)?.ws.rt.actor.actorId === reference.actorId) parent.children.delete(name);
      if (this.entries.get(child.key)?.ws.rt.actor.actorId === reference.actorId) this.entries.delete(child.key);
      this.byActor.delete(reference.actorId);
    }
    parent.tree.runtimes.delete(reference.actorId);
    parent.tree.orchestrations.delete(reference.actorId);
    // KEEP HISTORY IS LITERAL. A retained dismissal keeps the actor's history
    // as readable rows in the workspace database, addressable by actor id.
    // Only its scratch bytes are removed.
    const retirement: Parameters<ActorHost['retire']>[1] = {
      reference, name, destroy: !keepHistory,
    };
    await parent.tree.host.retire(parent.actor.reference, retirement);
  }

  /** Drain now because something landed in this agent's inbox. Bracketed like
   *  every other converting operation here: a wake that meets another driver is
   *  simply that driver's work, and its rows are still pending for them. */
  private wake(entry: HostEntry, source: string): void {
    // Wakes arrive from listeners and timers that can outlive close(), and a
    // drive after close() would convert rows over a closed database handle.
    if (this.closed) return;
    queueMicrotask(async () => {
      if (this.closed) return;
      try {
        await this.drive(entry, () => entry.session.flushPendingDrains());
      } catch (cause) {
        diagnostics.failure(
          'host.event_drain_failed',
          toKinuError({ doing: 'draining hosted local events', cause, otherwise: 'io' }),
          { agent: entry.key, source },
        );
      }
    });
  }
}

/** This actor's own lifetime, off its own config. Anything unrecognised — an
 *  actor created before the rung existed, or a root — is DURABLE, which is what
 *  it truly is: nothing is blocked on it. */
function lifetimeOf(config: AgentConfigStore): SubordinateLifetime {
  return config.get(CHILD_LIFETIME_KEY) === TEMPORARY_LIFETIME ? TEMPORARY_LIFETIME : 'durable';
}

function treeDepthOf(config: AgentConfigStore): number {
  const depth = Number(config.get(CHILD_DEPTH_KEY));
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * A subordinate's ref: its own name over its ROOT's pair.
 *
 * This is the whole of subordinate containment on the virtual-workspace axis.
 * A child cannot name a different directory or a different workspace, so it
 * binds its root's bytes and — since only roots hold peer mail — has no way to
 * address anything outside the tree it hangs from.
 */
function childRef(parent: HostEntry, childName: string): HostedAgentRef {
  return { name: childName, cwd: parent.ref.cwd, workspaceId: parent.ref.workspaceId };
}

function readConversationTail(entry: HostEntry): ModelMessage[] {
  const rows = makeSql(entry.tree.db)<{ role: string; content: string }>`
    SELECT role, content FROM messages
    WHERE actor_id = ${entry.ws.rt.actor.actorId} AND session_id = ${entry.sessionId}
      AND role IN ('user', 'assistant')
    ORDER BY created_at DESC, rowid DESC LIMIT 16`;
  return rows.reverse().map((row): ModelMessage => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
  }));
}

/**
 * When this PROCESS must next wake, over every actor in the workspace.
 *
 * Deliberately unscoped, and one of the few reads in this tree that must be.
 * `triggers` is actor-scoped storage, but this is not a read of one actor's
 * state — it is the daemon's own timer, and the daemon hosts every actor in
 * the file. Scoping it to the root would make the process sleep through a
 * hired subordinate's due trigger, which is the failure this fold exists to
 * prevent. The same contract as `hasLiveJobsInWorkspace()`: workspace-wide by
 * design, not by omission. It takes a bare `Database` for exactly that reason
 * — there is no one actor whose handle would be the right one to hold here.
 */
function nextTriggerAt(db: Database): number | null {
  const table = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='triggers'`).get();
  if (!table) return null;
  const row = db.query<{ next_fire_at: number | null }, []>(`
    SELECT MIN(next_fire_at) AS next_fire_at FROM triggers
    WHERE state = 'active' AND next_fire_at IS NOT NULL
  `).get();
  return row?.next_fire_at ?? null;
}
