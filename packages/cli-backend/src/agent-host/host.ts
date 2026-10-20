/**
 * LocalAgentHost: the local daemon's durable-agent substrate. One SQLite file per root; every actor
 * beneath it is a `workspace_actors` row there, with its own runtime objects from one {@link ActorHost}.
 * Durable work stays in the existing EventLog/background_jobs/fibers/outbox_peer tables.
 */

import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import {
  EventLog,
  LiveReadsNotice,
  readsWrittenBy,
  ReplyChannelStore,
  ROSTER_READS,
  SubordinateRosterStore,
  admitHireWork,
  hireLifecycle,
  retireHireSubtree,
  type ActorRetirement,
  type HireLifecyclePorts,
  type SeatedHire,
  AgentDeliveries,
  type InProcessDeliveries,
  MAIN_AGENT,
  actorReferenceOf,
  stoppedBelow,
  deliveryMetadata,
  childContextResolver, hostedChildTree,
  createLocalPeerEndpoint,
  defaultLoopOrigin,
  samePeerGroup,
  createTeamToolDeps,
  createTemporaryAgentPort,
  delegationBudgetOf,
  inheritedContextFromTranscript,
  actorHomeName,
  receiveSubordinateEvent,
  publishSubordinateReport,
  TurnReports,
  type SubordinateReportLedger,
  agentNamer,
  subordinateDescriptorSource,
  missionOf,
  recoverSubordinateLifecycles,
  owedSubordinateTurnReport,
  taskAnswerIsLater,
  type ActorHost,
  type ActorReference, type AgentSignal, type SendOutcome,
  type AgentRuntime,
  type AdmittedSubordinateReport,
  type BoundActor,
  type HostedActor,
  type ReportDeps,
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
  metadataBroadcastEvent,
  type SqlExec,
  type SubordinateRuntime,
  type TeamToolDeps,
  type TemporaryAgentPort,
  type SerializedMessage,
  type WorkMode,
  type WorkspaceActor,
  type WorkspaceActorDirectory,
  readWorkspaceWork, type WorkspaceWork,
  isSubordinateOrigin,
  CHAT_SESSION_ID,
} from '@kinu.run/core';
import { Effect, Result } from 'effect';
import { KinuError, attempt, diagnostics, refusalOf, settle, toKinuError, settleSync, settleLogged, settleLoggedSync, detach } from '@kinu.run/core/obs';
import { watchStatements } from '@kinu.run/core/identity';
import {
  createCLIRuntime, makeSql, makeExecRaw, makeSqlExec, shareLocalWorkspacePlane,
  cleanupFacetScratch, soulOf, writeTransaction,
  type CLIRuntime,
} from '../runtime';
import type { CLIOpenConfig } from '../open';
import {
  bindLocalActor, bindLocalActorReference, localActorDirectory,
  adoptLocalActorHandle, openLocalActor, recoverLocalActorRetirements,
  requireLocalActorWorkspace, type LocalActorBinding,
} from '@kinu.run/core';
import { osLeaseProcess } from './lease-process';
import {
  BACKGROUND_POLICY, DriverLeaseHold, REAL_CLOCK,
  type DriverKind, type DriverLeaseHolder, type InvocationSurface,
  type SessionEvent,
} from '@kinu.run/core';
import {
  LocalAgentSession,
  type LocalAgentSessionOpts,
  type LocalParentRelay,
} from '../local-session';
import { createLocalActorHost } from '../actor-host';
import type { LocalOrchestration } from '../orchestration';
import type { LocalModelResolver } from '../model-resolver';
import type { ProfileEnvelopeSource } from '../profile-authority';
import type { McpServerConfig } from '../mcp';

/** Runtime inputs fixed for one bound agent while this host process is alive. */
export interface LocalHostedAgent {
  rt: CLIRuntime;
  /** Provider/auth wiring reused when this agent hires a subordinate. */
  openConfig: CLIOpenConfig;
  modelResolver?: LocalModelResolver;
  staticModel?: LanguageModel;
  mcpServers?: Record<string, McpServerConfig>;
  /** Role/tier catalog source, forwarded by the opener; the host never invents a default. */
  profileAuthority?: ProfileEnvelopeSource;
  /** Provider-config revision, read live so a daemon sees providers connected elsewhere. */
  providerRevision?: () => number;
  /** This root is the one task a one-shot run opened: its turns are independent tasks, each gated to completion. */
  oneShot?: boolean;
}

export interface LocalAgentHostOptions {
  /** Every bindable local agent, re-read per call; a root with no ref is not hosted. */
  roster(): readonly HostedAgentRef[];
  /** Build one already-created root agent over the host-owned handle. */
  open(ref: HostedAgentRef, db: Database, dbPath: string): Promise<LocalHostedAgent>;
  /** Where one root's database is; a subordinate has no file (open-38). */
  dbPath(name: string): string;
  /** Ask for another pass by `at` (peer outbox retry). Optional: `tick` already returns the soonest retry. */
  wakeAt?(at: number): void;
  /**
   * Decides who may take the driver lease: interactive may preempt a live daemon, never the reverse.
   * Defaults to `interactive`; the daemon declares itself.
   */
  driverKind?: DriverKind;
  /**
   * How this process was invoked, which sets how long it lives: a one-shot run exits after its task, so its actors run
   * long work inline and defer reviews as durable rows. Absent, a process that stays (interactive, daemon).
   */
  surface?: InvocationSurface;
  /** When a tick's `reads_changed` frame goes out: the next task unless a suite ends its ticks itself. */
  deferLiveReads?(flush: () => void): void;
}

/** What one {@link LocalAgentHost.tick} did; `ran` distinguishes a deferred pass from an idle one. */
interface LocalTickResult {
  readonly ran: boolean;
  /** Soonest re-drive moment, or null; read from the durable schedule even when deferred. */
  readonly nextAt: number | null;
  readonly heldBy?: DriverLeaseHolder;
}

/**
 * One root's physical workspace, shared by every entry in the subtree. `driver_lease` holds one row
 * per file, so a hold per entry would have siblings invalidate each other's tokens.
 */
interface HostTree {
  readonly db: Database;
  readonly host: ActorHost;
  /** The root's actor directory, held: `localActorDirectory` refuses a non-root handle. */
  readonly directory: WorkspaceActorDirectory;
  readonly hold: DriverLeaseHold;
  /** Converting operations in flight; a daemon releases the lease when the last one finishes. */
  driving: number;
  /** The root's runtime, opened before the host that would otherwise build it. */
  readonly runtimes: Map<string, CLIRuntime>;
  /** Kept so the actor's session gets the same engine, governor and event rail as its `ActorSession`. */
  readonly orchestrations: Map<string, LocalOrchestration>;
  /** Every write to the file names the reads it moves, to the root's clients. */
  readonly liveReads: LiveReadsNotice;
  /** Every job a session of this tree drives now: the root's and each hire's runners share it, so none counts another's
   *  re-drive as work owed to it. */
  readonly jobsDriven: Set<string>;
}

/** A hire as the lifecycle reaches it on this machine: its hosted entry. */
interface LocalHire extends SeatedHire {
  readonly entry: HostEntry;
}

interface HostEntry {
  /** Address inside this process: root, root/child, root/child/grandchild. */
  key: string;
  name: string;
  /** A subordinate inherits its root's ref pair (directory and virtual workspace). */
  ref: HostedAgentRef;
  parentKey: string | null;
  tree: HostTree;
  actor: HostedActor;
  ws: LocalHostedAgent;
  sessionId: string;
  session: LocalAgentSession;
  config: AgentConfigStore;
  eventLog: EventLog;
  /** What the agent is owed: its assignments, signals and drains, each committed, then handed to its chat. */
  deliveries: InProcessDeliveries;
  roster: SubordinateRosterStore;
  /** Built once with the entry: it holds the live waiters `shell` parks on. */
  temporary: TemporaryAgentPort;
  team: TeamToolDeps | null;
  /** Peer mail, roots only: a subordinate could otherwise escape its depth cap via another tree. */
  peers: LocalPeerEndpoint | null;
  children: Map<string, HostEntry>;
  relay: SubordinateReportLedger & {
    ownerDriven: boolean;
    mode: WorkMode;
    /** The turn the ledger is this turn's; null before the child's first turn starts. */
    turnId: string | null;
  } | null;
}

interface ChildReportRelay {
  child: HostEntry;
  content: string;
  mode: WorkMode;
  status: SubordinateReportStatus;
  origin: SubordinateReportOrigin;
  /** Dedupe key on the parent's rail, so one report cannot wake it twice. */
  sequenceId: string;
  /** The `report` tool's structured handoff; absent on the automatic turn-end relay. */
  handoff?: SubordinateReportHandoff;
  quiet?: true;
}

type AgentEventListener = (agent: string, event: SessionEvent) => void;

export class LocalAgentHost {
  private readonly entries = new Map<string, HostEntry>();
  /** Entries by actor id: host dependencies receive references, not addresses. */
  private readonly byActor = new Map<string, HostEntry>();
  private readonly listeners = new Set<AgentEventListener>();
  /** First-open fence per address; recovery must run once under concurrent cold opens. */
  private readonly opening = new Map<string, Promise<HostEntry>>();
  private readonly trees = new Map<string, HostTree>();
  private closed = false;
  /** Passes started outside a turn; close() joins them before ending the sessions they use. */
  private readonly answerPasses = new Set<Promise<void>>();

  constructor(private readonly opts: LocalAgentHostOptions) {}

  private get driverKind(): DriverKind {
    return this.opts.driverKind ?? 'interactive';
  }

  /**
   * Run a converting operation as driver, or decline naming the owner. Two gates: the cross-process
   * driver lease, and in-process per-actor `host.run`. A daemon releases after its last operation;
   * an interactive host holds until the session ends.
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
      return { ran: true, value: await tree.host.run(entry.actor.reference, { kind: 'actor' }, () => run()) };
    } finally {
      tree.driving -= 1;

      if (this.driverKind === 'daemon' && tree.driving === 0) tree.hold.release();
    }
  }

  /** Session events stay live after an interactive client disconnects. */
  /** A task child's retire; a failure is the outcome. */
  retireTaskChild(work: () => Promise<void>): Promise<Result.Result<void, KinuError>> {
    return settle(Effect.result(attempt({ doing: 'retiring a task child after its answer', otherwise: 'io' }, work)));
  }

  subscribe(listener: AgentEventListener): () => void {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (this.closed) return yield* Effect.die(new Error('LocalAgentHost is closed.'));
      this.listeners.add(listener);

      return () => this.listeners.delete(listener);
    }));
  }

  /** Open once, recover once, keep alive until close(). Accepts a root or a roster path. */
  async acquire(address: string): Promise<LocalAgentSession> {
    return (await this.resolveEntry(address)).session;
  }

  peek(name: string): LocalAgentSession | null {
    return this.entries.get(name)?.session ?? null;
  }

  /** One driver pass, gated on the driver lease; refused is a normal outcome, not a failure. */
  async tick(name: string, now = Date.now()): Promise<LocalTickResult> {
    return await this.tickEntry(await this.resolveEntry(name), now);
  }

  /** The runtime an opened agent works over, as its opener built it. */
  async runtime(address: string): Promise<CLIRuntime> {
    return (await this.resolveEntry(address)).ws.rt;
  }

  /**
   * Takes the driver lease for `address`'s workspace now, as a client does before its person types; the refusal names
   * who holds it. An interactive host keeps it until close.
   */
  async takeDriver(address: string): Promise<ReturnType<DriverLeaseHold['acquire']>> {
    return (await this.resolveEntry(address)).tree.hold.acquire();
  }

  /** Subordinate operations for one agent, root or subordinate, down to the depth cap. */
  async team(address: string): Promise<TeamToolDeps> {
    const entry = await this.resolveEntry(address);

    entry.team ??= this.buildTeam(entry);

    return entry.team;
  }

  /** Peer mail for one root agent; null for a subordinate. */
  async peers(address: string): Promise<LocalPeerEndpoint | null> {
    return (await this.resolveEntry(address)).peers;
  }

  /** Turns interrupted in this process, read from unsettled durable claims so cold and warm hosts agree. */
  async resumable(address: string, limit?: number): Promise<ReturnType<ActorHost['resumable']>> {
    const entry = await this.resolveEntry(address);

    return limit === undefined ? entry.tree.host.resumable() : entry.tree.host.resumable(limit);
  }

  async actors(address: string): Promise<readonly WorkspaceActor[]> {
    return describeActors(await this.resolveEntry(address));
  }

  /** The workspace-wide work read `listWorkspaceWork` exposes over RPC. */
  async workspaceWork(address: string): Promise<WorkspaceWork> {
    const entry = await this.resolveEntry(address);

    return readWorkspaceWork(entry.ws.rt.storage.sql, entry.ws.rt.actor, describeActors(entry));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const openings = await Promise.allSettled(this.opening.values());
    await Promise.all(this.answerPasses);

    for (const opening of openings) {
      if (opening.status === 'rejected') {
        diagnostics.failure(
          'host.agent_open_failed',
          toKinuError({ doing: 'opening a local agent during host shutdown', cause: opening.reason, otherwise: 'io' }),
        );
      }
    }

    for (const entry of [...this.entries.values()].reverse()) {
      await settleLogged('host.session_teardown_failed', { doing: 'ending a hosted local session', otherwise: 'io' }, () => entry.session.end(), { agent: entry.key });
    }

    // Runtime objects, then lease, then file, once per tree. The lease is released before the handle
    // closes so a daemon can drive again after an interactive process exits.
    for (const tree of this.trees.values()) {
      tree.host.releaseAll();
      tree.hold.release();
      tree.db.close();
    }

    this.entries.clear();
    this.byActor.clear();
    this.trees.clear();
  }

  private async resolveEntry(address: string): Promise<HostEntry> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const pending = this.opening.get(address);

    if (pending) return await pending;

    const existing = this.entries.get(address);

    if (existing) return existing;

    const separator = address.lastIndexOf('/');

    if (separator >= 0) {
      if (separator === 0 || separator === address.length - 1) {
        throw new Error(`invalid local agent address "${address}"`);
      }

      const parent = await this.resolveEntry(address.slice(0, separator));

      return await this.openChildEntry(parent, address.slice(separator + 1));
    }

    const opening = this.createTopLevel(address);
    this.opening.set(address, opening);

    try {
      const entry = await opening;

      // Opened here first, so this process opens every hire under it: what each was left, or left owing, runs again.
      await this.openTree(entry);

      return entry;
    } finally {
      if (this.opening.get(address) === opening) this.opening.delete(address);
    }
  }

  private async createTopLevel(name: string): Promise<HostEntry> {
    const ref = this.opts.roster().find((candidate) => candidate.name === name);

    if (!ref) {
      throw new Error(`agent "${name}" has no local ref: nothing records which`
        + ' directory or virtual workspace it belongs to, so it cannot be bound.');
    }

    const dbPath = this.opts.dbPath(name);

    if (!existsSync(dbPath)) throw new Error(`agent "${name}" does not exist at ${dbPath}`);

    const liveReads = new LiveReadsNotice((frame) => { this.entries.get(name)?.session.host.broadcast(frame); }, (flush) => {
      if (this.opts.deferLiveReads) this.opts.deferLiveReads(flush);
      else setImmediate(flush);
    });

    const db = new Database(dbPath);
    watchStatements(db, (query) => { liveReads.moved(readsWrittenBy(query)); });

    try {
      const ws = await this.opts.open(ref, db, dbPath);
      const tree = this.createTree(db, ws, liveReads);
      this.trees.set(name, tree);

      try {
        const actor = await tree.host.acquire(actorReferenceOf(ws.rt.actor), { kind: 'actor' });

        return await this.buildEntry({ key: name, name, ref, parentKey: null, tree, actor, ws });
      } catch (error) {
        // This path discards the tree without reaching close(), so release its lease here or the
        // `driver_lease` row names a holder that no longer exists.
        // Recorded, not thrown: it must not replace the open failure below, but must stay visible.
        settleLoggedSync('driver.lease_release_failed', { doing: 'releasing the discarded tree\'s driver lease', otherwise: 'io' },
          () => tree.hold.release(), { workspace: name });

        this.trees.delete(name);
        throw error;
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** The one actor host over a root's database; none of its factories opens a file. */
  private createTree(
    db: Database,
    ws: LocalHostedAgent,
    liveReads: LiveReadsNotice,
  ): HostTree {
    const { directory } = localActorDirectory(ws.rt.actor);
    const sql = makeSql(db);
    const hubSql = makeSqlExec(db);
    const runtimes = new Map<string, CLIRuntime>([[ws.rt.actor.actorId, ws.rt]]);
    const orchestrations = new Map<string, LocalOrchestration>();

    const host = createLocalActorHost({
      storage: {
        sql,
        transactionSync: (write) => writeTransaction(db, write),
        exec: (query, ...bindings) => hubSql.exec(query, ...bindings),
      },
      directory,
      // No build identity for the builtin loop: a `bun`-run checkout has no build stamp.
      installedBuild: null,
      // What each hire's turn told its hirer, so a restart settles a turn its report already answered.
      answered: (turn) => new TurnReports(sql).answered(turn),
      // Its own entry's port; a seated swarm node has none, and takes no input to be reviewed on.
      advisorPort: (bound) => this.byActor.get(bound.reference.actorId)?.temporary ?? null,
      // Every hirer here, the root included, is an entry of this process.
      sayToParent: (child, signal) => this.sayToHirer(child, signal),
      actorRuntimeFor: (bound) => this.runtimeFor(runtimes, db, bound),
      // The root's runtime is built before its host binds it, with the stores the host then binds it with.
      storesFor: (bound) => runtimes.get(bound.reference.actorId)?.stores,
      parentRuntimeFor: (bound) => bound.reference.parentActorId === null
        ? ws.rt : this.requireActorEntry(bound.reference.parentActorId).ws.rt,
      loopFor: (bound) => {
        const parentId = bound.reference.parentActorId;
        const parentEntry = parentId === null ? null : this.requireActorEntry(parentId);
        // The origin the creation site named, else this kind's default; only the seating session knows.
        const named = parentEntry?.session.pendingLoopOrigin(bound.reference.actorId);

        return {
          origin: named ?? defaultLoopOrigin(bound.record.origin),
          parent: parentEntry === null ? null : parentEntry.ws.rt,
        };
      },
      sessionFor: (bound) => {
        const ownsSession = bound.record.origin !== 'swarm';
        const clientId = ownsSession ? bound.reference.actorId : bound.reference.parentActorId;

        if (clientId === null) throw new KinuError('missing', 'A reporting actor has no session to publish through.');

        return {
          read: () => this.requireActorEntry(clientId).session,
          turnInFlight: () => this.byActor.get(clientId)?.session.turnInFlight() ?? false,
          closed: () => this.byActor.get(clientId)?.session.closed() ?? true,
        };
      },
      oneShot: this.opts.surface === 'one-shot',
      orchestrationCreated: (bound, orchestration) => {
        if (bound.record.origin !== 'swarm') {
          orchestrations.set(bound.reference.actorId, orchestration);
        }
      },
      discardBytes: (record) => this.discardActorBytes(ws, record),
    });

    return {
      db, host, directory, runtimes, orchestrations, liveReads, driving: 0, jobsDriven: new Set(),
      hold: new DriverLeaseHold({ sql, execRaw: makeExecRaw(db), proc: osLeaseProcess(process.pid) }, this.driverKind),
    };
  }

  /**
   * One actor's runtime. A root's is prepared before the host exists; a hire's is retained for the
   * entry built next; a head's or node's is per acquisition and retained nowhere.
   */
  private async runtimeFor(
    runtimes: Map<string, CLIRuntime>,
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

    const binding = bindLocalActorReference(parent.ws.rt.actor, bound.reference);
    // The host's handle: the release fence is bound to this object.
    adoptLocalActorHandle(parent.ws.rt.actor, bound.reference, bound.handle);
    const openConfig = this.childOpenConfig(parent, binding);

    const built = createCLIRuntime(db, {
      ...openConfig, agentName: binding.name, actor: bound.handle, stores: bound.stores,
    });

    const shared = shareLocalWorkspacePlane(built, parent.ws.rt);
    runtimes.set(bound.reference.actorId, shared);

    return shared;
  }

  /** Remove one destroyed actor's scratch home, named from its storage key and kind; its rows go with the directory row. */
  private discardActorBytes(ws: LocalHostedAgent, record: WorkspaceActor): Promise<void> {
    cleanupFacetScratch(ws.rt.space, actorHomeName(record));

    return Promise.resolve();
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

    // Consumed: empty the handover slot so a re-acquisition cannot pick it up.
    input.tree.orchestrations.delete(input.actor.reference.actorId);
    // Subordinate names are per-parent, so this roster is bound to this actor.
    const roster = new SubordinateRosterStore(hubSql, input.actor.handle);
    roster.ensureSchema();
    const sessionId = CHAT_SESSION_ID;

    const sessionOpts: LocalAgentSessionOpts = {
      rt: input.ws.rt,
      db: input.tree.db,
      hosted: {
        actor: input.actor,
        host: input.tree.host,
        orchestration,
        jobsDriven: input.tree.jobsDriven,
        // One queue per workspace: a hire parks on its root's, and the root's wakes the hire it answers.
        ...(input.parentKey === null
          ? { wakeHire: (actorId: string, signal: AgentSignal) => this.wakeHire(input.tree, actorId, signal) }
          : { approvals: this.rootEntry(input.parentKey).session.approvalQueue }),
      },
      cwd: input.ref.cwd,
      backgroundPolicy: BACKGROUND_POLICY[this.opts.surface ?? 'interactive'],
      oneShot: input.parentKey === null && input.ws.oneShot === true,
      onEvent: (event) => this.onSessionEvent(input.key, event),
      // Stop means stop: what the agent was owed and had not taken is cancelled with its queued turns.
      onStop: () => {
        const cutoff = orchestration.deliveries.cancel();

        this.stopSubtree(input.key);

        return cutoff;
      },
      clock: REAL_CLOCK,
    };

    // Read at prompt time: a rename or auto-title lands on the root.
    if (input.parentKey !== null) {
      sessionOpts.workspaceTitle = () => this.rootEntry(input.key).config.getDisplayName();
      sessionOpts.ancestors = () => this.ancestorConfigs(input.key);
    }

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
      deliveries: orchestration.deliveries,
      roster,
      temporary: createTemporaryAgentPort({
        roster,
        runtime: this.childRuntime(input.tree, input.key),
        now: () => Date.now(),
        createName: agentNamer(input.tree.directory, roster),
        afterTurn: (_child, work) => { this.retireOffTurn(input.key, work); },
      }),
      team: null,
      peers: null,
      children: new Map(),
      relay: input.parentKey === null
        ? null
        : { ownerDriven: false, spoke: false, settled: false, mode: 'build', turnId: null },
    };

    this.entries.set(input.key, entry);
    this.byActor.set(input.actor.reference.actorId, entry);
    // The roster needs the session's broadcast, so deps are installed right after construction, before any turn.
    entry.session.setTeam(this.buildTeam(entry));
    input.ws.rt.setChildContext?.(childContextResolver({
      directory: input.tree.directory,
      parent: input.actor.handle,
      tree: hostedChildTree(input.tree.host, (child) => child.stores.eventRecorder),
    }));
    // Consulted before every turn, so an interactive process takes the lease at a turn boundary.
    // A closed host refuses: a turn continuation can outlive close(), which already closed the handle.
    entry.session.setDriverGate(() => this.closed
      ? refusalOf(new KinuError('unavailable', 'this host is closed; no driver conversion may start'))
      : entry.tree.hold.acquire()?.refused ?? null);

    // Roots get peer mail; subordinates get the report spine, without which a parent's roster never
    // leaves `working` on the child's own signal.
    if (input.parentKey === null) {
      entry.peers = this.buildPeerEndpoint(entry, hubSql);
      entry.session.setPeers(entry.peers.deps);
    } else {
      entry.session.setReport(this.buildReport(entry));
      entry.session.setParentRelay(this.parentRelayFor(entry));
    }

    try {
      if (input.ws.mcpServers && Object.keys(input.ws.mcpServers).length > 0) {
        await session.connectMcp(input.ws.mcpServers);
      }

      // Recovery for a process that died after publishing or mid-drain: reclaim leased rows, then run
      // reactor events and parent-admitted assignments. Under the lease bracket because all three
      // convert rows. Nothing else re-drives an assignment after restart, so local task children need
      // no `recovered` report (cf differs: it claims per turn).
      await this.drive(entry, async () => {
        await session.recoverBackgroundJobs();
        session.reclaimStrandedEventDeliveries();
        await session.flushPendingDrains();
        await this.drainAssignedWork(entry);
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

      // Runtime objects go back to the host; the lease stays with the tree until close(). Only a child
      // releases: the root's tree is discarded by `createTopLevel`'s catch, and a release refusal would
      // bury the real failure in an AggregateError.
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

  /**
   * Each hire `parent` has, read from its roster: the tree is the SQL one, never this process's memory, so a pass after a
   * restart reaches every level of it. A hire this process has not opened is opened here; one still being born, or being
   * deleted, is its birth's or its deletion's to finish.
   */
  private async hiresOf(parent: HostEntry): Promise<HostEntry[]> {
    const hires: HostEntry[] = [];

    for (const roster of parent.roster.list()) {
      if (roster.birth !== null || roster.deleteRequested) continue;

      await settleLogged('host.subordinate_recovery_failed', { doing: 'recovering a local subordinate', otherwise: 'io' }, async () => {
        hires.push(await this.openChildEntry(parent, roster.name));
      }, { parent: parent.key, subordinate: roster.name });
    }

    return hires;
  }

  /** Every hire under `entry`, at every level its roster records, opened. */
  private async openTree(entry: HostEntry): Promise<void> {
    for (const hire of await this.hiresOf(entry)) await this.openTree(hire);
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

  /** Bind an already-created subordinate; `openLocalActor` already refused a retired creation. */
  private async openExistingChild(
    parent: HostEntry,
    binding: LocalActorBinding,
    key: string,
  ): Promise<HostEntry> {
    const childName = binding.name;
    const actor = await parent.tree.host.acquire(binding.reference, { kind: 'actor' });

    try {
      const rt = parent.tree.runtimes.get(binding.reference.actorId);

      if (!rt) throw new KinuError('missing', 'The hosted subordinate has no bound runtime.');
      const ws = this.childHostedAgent(parent, binding, rt);

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

  /** The parent's provider wiring, directory forced to the parent's ref: a child binds no other plane. */
  private childOpenConfig(parent: HostEntry, binding: LocalActorBinding): CLIOpenConfig & { facet: string } {
    if (!isSubordinateOrigin(binding.origin)) throw new KinuError('denied', 'The roster path is not a subordinate actor.');

    return { ...parent.ws.openConfig, cwd: parent.ref.cwd, facet: actorHomeName(binding), actorBinding: binding };
  }

  /**
   * A hire, born or reopened, as its parent's model authority serves it: the parent's resolver, model, role and tier
   * catalog and provider revision, so it reaches what its parent reaches and sees a provider connected elsewhere. A
   * workspace with no reachable model hires; its hire's turn refuses as its own would (turn-assembly.ts), not here.
   */
  private childHostedAgent(parent: HostEntry, binding: LocalActorBinding, rt: CLIRuntime): LocalHostedAgent {
    const { modelResolver, staticModel, profileAuthority, providerRevision } = parent.ws;

    return {
      rt, openConfig: this.childOpenConfig(parent, binding),
      ...(modelResolver !== undefined && { modelResolver }), ...(staticModel !== undefined && { staticModel }),
      ...(profileAuthority !== undefined && { profileAuthority }), ...(providerRevision !== undefined && { providerRevision }),
    };
  }

  private buildPeerEndpoint(entry: HostEntry, hubSql: SqlExec): LocalPeerEndpoint {
    // Store and endpoint are mutually dependent; the dispatcher reads `entry.peers` at dispatch time.
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
   * Peer hop into a named root of this virtual workspace. A non-member is refused (dead-lettered);
   * an unopenable member throws so the outbox retries.
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
   * One agent's pass, then each subordinate's, each under the tree lease plus its own `host.run`.
   * `ran` describes this agent; subordinate schedules still ride back.
   */
  private async tickEntry(entry: HostEntry, now: number): Promise<LocalTickResult> {
    const outcome = await this.drive(entry, () => this.runPass(entry, now));
    let nextAt = outcome.ran ? outcome.value : nextTriggerAt(entry.tree.db);

    for (const child of await this.hiresOf(entry)) {
      const childNext = (await this.tickEntry(child, now)).nextAt;

      if (childNext !== null) nextAt = nextAt === null ? childNext : Math.min(nextAt, childNext);
    }

    return outcome.ran ? { ran: true, nextAt } : { ran: false, nextAt, heldBy: outcome.heldBy };
  }

  /** One pass's converting steps; the lease is re-checked between them: an interactive process may preempt. */
  private async runPass(entry: HostEntry, now: number): Promise<number | null> {
    const hold = entry.tree.hold;
    const lifecyclePending = await recoverSubordinateLifecycles(entry.roster, this.childRuntime(entry.tree, entry.key));

    if (!hold.held()) return nextTriggerAt(entry.tree.db);

    if (entry.parentKey === null) {
      // Finish a retirement this process interrupted; only the recorded storage path lives outside the database.
      await recoverLocalActorRetirements(entry.ws.rt.actor, async (_path, reference) => {
        const record = entry.tree.host.describe(reference.actorId);

        if (record) await this.discardActorBytes(entry.ws, record);
      });

      if (!hold.held()) return nextTriggerAt(entry.tree.db);
    }

    await entry.session.fireDueTriggers(now);

    if (!hold.held()) return nextTriggerAt(entry.tree.db);
    await entry.session.flushPendingDrains();

    if (!hold.held()) return nextTriggerAt(entry.tree.db);
    await this.drainAssignedWork(entry);

    if (!hold.held()) return nextTriggerAt(entry.tree.db);
    await entry.session.runDueEvolution();

    let next = nextTriggerAt(entry.tree.db);

    if (lifecyclePending) next = next === null ? now : Math.min(next, now);

    // Re-drives peer mail left pending by a dead process; the soonest retry rides back out.
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

  /**
   * Track a child's turn for the relay decision its roster makes. No `turn-end` branch (the roster
   * owns the automatic report via {@link parentRelayFor}) and no `tool-call` branch (the report dep sets the flag).
   */
  private observeChildTurn(child: HostEntry, event: SessionEvent): void {
    const state = child.relay;

    if (!state || event.type !== 'turn-start') return;
    state.ownerDriven = event.authorship === 'owner';

    // The owner writing to an agent that waits on input answers that wait, as a message from its hirer does.
    if (state.ownerDriven) {
      const roster = this.requireActorEntry(child.actor.record.parentActorId ?? '').roster;

      if (roster.get(child.name)?.status === 'awaiting_input') roster.resumeAfterMessage(child.name);
    }

    state.spoke = false;
    state.settled = false;
    state.mode = event.workMode;
    state.turnId = event.turnId;
  }

  /**
   * The automatic turn-end report the child's settled turn owes. One branch only: separate `error`
   * and `turn-end` relays would report one failing turn twice.
   */
  private parentRelayFor(child: HostEntry): LocalParentRelay {
    return {
      owed: async (turn) => {
        const parent = this.requireActorEntry(child.actor.record.parentActorId ?? '');

        parent.roster.finishTurn(child.name, turn.ending, Date.now());

        const state = child.relay;

        if (state === null) return null;

        return await owedSubordinateTurnReport({
          lifetime: child.actor.record.lifetime, ending: turn.ending, assistantText: turn.assistantText, narration: async () => turn.narration,
          reports: state, ownerDriven: turn.ownerDriven,
          delegating: taskAnswerIsLater({ roster: child.roster, log: child.eventLog, ...(turn.taskId !== null && { turnTaskId: turn.taskId }) }),
        });
      },
      sequenceId: (messageId) => `${child.key}:turn-end:${messageId}`,
      send: async ({ text, status, mode, sequenceId, quiet }) => {
        const relayed = await publishSubordinateReport({ mode, reports: child.relay }, {
          content: text, status, origin: 'turn_end', sequenceId, ...(quiet === true && { quiet }),
        }, report => this.relayToParent({ child, ...report }));

        return relayed.disposition;
      },
    };
  }

  /** Publish one child report into its parent's rail; `status` moves the parent's roster row. */
  private async relayToParent(relay: ChildReportRelay): Promise<SubordinateEventResult> {
    const { child, content, mode, status, origin, sequenceId, handoff, quiet } = relay;

    if (!child.parentKey) return { id: '', disposition: 'not_awaited' };
    const parent = this.entries.get(child.parentKey);

    if (!parent) throw new Error(`parent "${child.parentKey}" is not hosted`);

    return receiveSubordinateEvent({
      log: parent.eventLog,
      roster: parent.roster,
      vfs: parent.ws.rt.storage.vfs,
      // One transaction: core's replay fast path answers `already_held` off the dedupe key, so an
      // interruption between insert and roster update would leave the child `working` forever.
      transaction: (body) => writeTransaction(parent.tree.db, body),
      announce: (report: AdmittedSubordinateReport) => {
        const metadata: JsonObject = {
          kind: 'report',
          subordinate: report.subordinate,
          timestamp: report.timestamp,
        };

        if (report.task) metadata.task = report.task;
        parent.session.host.broadcast(metadataBroadcastEvent(
          'subordinate_event', metadata, { status: report.status, text: report.content },
        ));
      },
      onAdmitted: () => this.wake(parent, 'subordinate report'),
      // No job queue here: the stored answer is the owed delivery, made below and, after a death, at the next start.
      evolutionAnswerStored: () => undefined,
      onEvolutionAnswer: async () => {
        this.answerWake(parent);
        await parent.session.deliverAdvisorAnswers();
      },
      temporary: parent.temporary,
    }, {
      fromSubordinate: child.name,
      status,
      content,
      origin,
      sequenceId,
      mode,
      handoff,
      ...(quiet === true && { quiet }),
    }, Date.now());
  }

  /** The report spine for one subordinate; roots get none. The session limits it to assigned turns. */
  private buildReport(child: HostEntry): ReportDeps {
    return {
      report: async ({ status, content, handoff }) => {
        const relayed = await publishSubordinateReport({ mode: child.relay?.mode ?? 'build', reports: child.relay }, {
          content,
          status,
          origin: 'report_tool',
          sequenceId: `${child.key}:report:${crypto.randomUUID()}`,
          handoff,
        }, report => this.relayToParent({ child, ...report }));

        const turnId = child.relay?.turnId ?? null;

        // Kept as it lands, so a restart knows this turn already answered.
        if (child.relay && turnId !== null) new TurnReports(child.ws.rt.storage.sql).record({ actorId: child.actor.record.actorId, turnId }, child.relay);

        return { disposition: relayed.disposition, id: relayed.id };
      },
    };
  }

  private buildTeam(parent: HostEntry): TeamToolDeps {
    const delegation = delegationBudgetOf((actorId) => parent.tree.host.describe(actorId), parent.actor.record);

    const input: Parameters<typeof createTeamToolDeps>[0] = {
      delegation,
      roster: parent.roster,
      runtime: this.childRuntime(parent.tree, parent.key),
      now: () => Date.now(),
      inheritedContext: (): Promise<SerializedMessage[]> => inheritedContextFromTranscript(parent.actor.session.canonical.transcript(parent.sessionId)),
      originContext: async () => parent.actor.session.history,
      ownMission: () => missionOf(soulOf(parent.tree.db)) ?? '',
      createName: agentNamer(parent.tree.directory, parent.roster),
      rosterMoved: () => { parent.tree.liveReads.moved(ROSTER_READS); },
      broadcastTask: (event) => parent.session.host.broadcast(metadataBroadcastEvent(
        'subordinate_event',
        { subordinate: event.subordinate, timestamp: event.timestamp },
        { status: 'task', text: event.content },
      )),
    };

    // What a capped agent is offered is core's (`offered`): no team at all.
    return createTeamToolDeps({ ...input, temporary: parent.temporary });
  }

  /**
   * The child substrate of one hosted agent, for both durable and temporary rungs: core's one hire lifecycle over this
   * host. Keyed by address because the temporary port is built before the entry is registered.
   */
  private childRuntime(tree: HostTree, parentKey: string): SubordinateRuntime {
    return hireLifecycle(this.lifecyclePorts(tree, parentKey));
  }

  /** What retiring a hire under its hirer asks of this host: its directory and rosters, and what it holds of the hire. */
  private treeRetirement(tree: HostTree): Pick<HireLifecyclePorts<LocalHire>, 'directory' | 'roster' | 'retire'> {
    return {
      directory: tree.directory,
      roster: (hirer) => this.byActor.get(hirer.actorId)?.roster ?? new SubordinateRosterStore(makeSqlExec(tree.db), tree.host.bindStores(hirer).handle),
      retire: (owner, retirement) => this.retireHeld(tree, owner, retirement),
    };
  }

  /** The hire lifecycle's ports over the agent `parentKey` names: every act on this machine's one tree. */
  private lifecyclePorts(tree: HostTree, parentKey: string): HireLifecyclePorts<LocalHire> {
    const parentOf = () => this.requireEntry(parentKey);

    return {
      ...this.treeRetirement(tree),
      parent: () => ({ reference: parentOf().actor.reference, record: parentOf().actor.record }),
      describe: (actorId) => tree.host.describe(actorId),
      born: (reference, name, seed) => this.bornChild(parentOf(), reference, name, seed),
      asHire: async (_reference, name, body) => {
        const entry = await this.openChildEntry(parentOf(), name);

        return await body({ entry, handle: entry.actor.handle, exec: makeSqlExec(entry.tree.db), turnInFlight: () => entry.session.turnInFlight() });
      },
      // Admitted and owed to the child as one: its next pass, under the driver lease, hands it over.
      deliver: async (hire, admit) => {
        if (this.closed) throw new Error('LocalAgentHost is closed.');
        const admission = hire.entry.deliveries.record(admit);

        if (admission.admitted) this.wake(hire.entry, 'subordinate task');

        return admission;
      },
      hirerName: () => (parentOf().parentKey === null ? MAIN_AGENT : parentOf().name),
      // Nothing on this machine is told a title moved: its lists read a hire's title where they draw it.
      announce: () => {},
      // Only a hire this host holds runs jobs here; one it does not hold has none running.
      retireJobs: async (actorId) => await this.byActor.get(actorId)?.session.retireJobs() ?? { stopped: [], refused: [] },
    };
  }

  private requireEntry(key: string): HostEntry {
    const entry = this.entries.get(key);

    if (!entry) throw new Error(`local agent "${key}" is not hosted`);

    return entry;
  }

  /**
   * Tells a hire what the owner decided, as work on its own event log, so an idle or unloaded hire wakes to it as it
   * would to its hirer's message.
   */
  private wakeHire(tree: HostTree, actorId: string, signal: AgentSignal): Effect.Effect<void, KinuError> {
    return Effect.flatMap(this.entryOf(tree, actorId), (child) => {
      const { parentKey } = child;

      return parentKey === null
        ? Effect.fail(new KinuError('denied', 'A root is woken through its own inbox.'))
        : Effect.asVoid(admitHireWork(this.lifecyclePorts(child.tree, parentKey), child.actor.reference, child.name, { kind: 'message', body: signal.text, mode: 'build' }));
    });
  }

  /** The hosted entry of an actor in this tree, opening its ancestors' as needed. */
  private entryOf(tree: HostTree, actorId: string): Effect.Effect<HostEntry, KinuError> {
    const hosted = this.byActor.get(actorId);

    if (hosted !== undefined) return Effect.succeed(hosted);
    const record = tree.directory.retained(actorId);

    if (record === null || record.parentActorId === null || record.deletedAt !== null) {
      return Effect.fail(new KinuError('missing', `No live agent ${actorId} in this workspace.`));
    }

    return Effect.flatMap(this.entryOf(tree, record.parentActorId), (parent) => attempt(
      { doing: `opening ${record.name} to tell it the owner's decision`, otherwise: 'io' },
      () => this.openChildEntry(parent, record.name),
    ));
  }

  /** The entry an issued actor id belongs to. */
  /** A hire's note to its hirer, said in the hirer's conversation. */
  sayToHirer(child: ActorReference, signal: AgentSignal): Promise<SendOutcome> {
    return settle(child.parentActorId === null
      ? Effect.fail(new KinuError('missing', 'A root actor has no hirer to tell.'))
      : Effect.promise(() => this.requireActorEntry(child.parentActorId ?? '').actor.session.orchestrator.signals.send(signal)));
  }

  private requireActorEntry(actorId: string): HostEntry {
    const entry = this.byActor.get(actorId);

    if (!entry) throw new KinuError('missing', `local actor "${actorId}" is not hosted`);

    return entry;
  }

  /** The workspace entry at the top of this agent's tree (itself for a root). */
  private rootEntry(key: string): HostEntry {
    let entry = this.requireEntry(key);

    while (entry.parentKey !== null) entry = this.requireEntry(entry.parentKey);

    return entry;
  }

  /** An entry's ancestors' configuration, nearest first, ending at its root. */
  private ancestorConfigs(key: string): AgentConfigStore[] {
    const ancestors: AgentConfigStore[] = [];

    for (let entry = this.requireEntry(key); entry.parentKey !== null;) {
      entry = this.requireEntry(entry.parentKey);
      ancestors.push(entry.config);
    }

    return ancestors;
  }

  /** A hire the lifecycle just registered, written by `seed` and hosted; a birth already under way is joined. */
  private async bornChild(parent: HostEntry, reference: ActorReference, name: string, seed: (config: AgentConfigStore) => void): Promise<void> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const key = `${parent.key}/${name}`;
    const binding = bindLocalActorReference(parent.ws.rt.actor, reference);

    if (binding.name !== name) throw new KinuError('denied', 'The actor alias does not match its directory record.');
    const openingKey = `${parent.key}/${binding.storageKey}`;
    const pending = this.opening.get(openingKey);

    if (pending) {
      await pending;

      return;
    }

    const existing = this.entries.get(key);

    if (existing) {
      if (existing.ws.rt.actor.actorId !== binding.reference.actorId) throw new KinuError('denied', 'The actor alias is held by a different creation.');

      return;
    }

    const opening = this.birthChildEntry(parent, name, seed, binding);
    this.opening.set(openingKey, opening);

    try {
      await opening;
    } finally {
      if (this.opening.get(openingKey) === opening) this.opening.delete(openingKey);
    }
  }

  /** Create one subordinate: descriptor rows then its hosted actor. A transaction, not a file creation. */
  private async birthChildEntry(
    parent: HostEntry,
    name: string,
    seed: (config: AgentConfigStore) => void,
    binding: LocalActorBinding,
  ): Promise<HostEntry> {
    const key = `${parent.key}/${name}`;
    const tree = parent.tree;
    const sql = makeSql(tree.db);

    try {
      writeTransaction(tree.db, () => {
        // The child's own handle; stores below are scoped to it, so one database holds N descriptors.
        seed(bindLocalActor(sql, binding).config);
      });
      const actor = await tree.host.acquire(binding.reference, { kind: 'actor' });
      const rt = tree.runtimes.get(binding.reference.actorId);

      if (!rt) throw new KinuError('missing', 'The created subordinate has no bound runtime.');
      const config = rt.actor.config;
      const descriptor = subordinateDescriptorSource(config).read();

      if (!descriptor) throw new Error(`subordinate "${name}" has no readable descriptor after creation`);
      const ws = this.childHostedAgent(parent, binding, rt);

      const entry = await this.buildEntry({
        key,
        name,
        ref: childRef(parent, name),
        parentKey: parent.key,
        tree,
        actor,
        ws,
      });

      requireLocalActorWorkspace(parent.ws.rt.actor, rt.actor);
      parent.children.set(name, entry);

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

  private hirerRoster(tree: HostTree, actor: WorkspaceActor): SubordinateRosterStore | null {
    const hirer = actor.parentActorId === null ? null : tree.directory.retained(actor.parentActorId);

    if (hirer === null) return null;

    return this.byActor.get(hirer.actorId)?.roster
      ?? new SubordinateRosterStore(makeSqlExec(tree.db), tree.host.bindStores(actorReferenceOf(hirer)).handle);
  }

  /** Stops the agents below `key` (core `stoppedBelow`): what each was owed and had not taken is cancelled with its
   *  queued turns, whether or not a turn of its runs; one the owner added has its own Stop. */
  private stopSubtree(key: string): void {
    const entry = this.entries.get(key);

    if (entry === undefined || this.closed) return;
    const { tree } = entry;

    for (const actor of stoppedBelow(tree.directory.list(), entry.actor.reference.actorId)) {
      const live = this.byActor.get(actor.actorId);
      const running = live?.actor.session.inFlight === true;

      // What it was owed and had not taken is cancelled and the work it carried dismissed, as the cloud's Stop does; a
      // session here has its queued turns cancelled and its running turn cut off.
      this.cancelOwed(tree, actor);
      live?.session.interrupt();

      // A running turn reports its own end.
      if (running) continue;
      const roster = this.hirerRoster(tree, actor);

      if (roster?.get(actor.name)?.status !== 'working') continue;
      roster.applyReport(actor.name, 'blocked', 'turn_end', Date.now());

      if (actor.lifetime === 'task') this.retireStopped(tree, actor);
    }
  }

  /** What a stopped agent was owed and had not taken: cancelled, and the work it carried dismissed with it. */
  private cancelOwed(tree: HostTree, actor: WorkspaceActor): void {
    const log = new EventLog(makeSqlExec(tree.db), tree.host.bindStores(actorReferenceOf(actor)).handle);
    const deliveries = new AgentDeliveries(makeSql(tree.db));

    tree.db.transaction(() => {
      for (const delivery of deliveries.cancel(actor.actorId)) {
        const drained = deliveryMetadata(delivery)?.drainTurnId;

        if (typeof drained !== 'string') continue;

        for (const event of log.query({ turn_id: drained })) log.dismiss(event.id, 'stopped by the owner', 'system');
      }
    })();
  }

  /** A stopped task agent retired as a dismissal that keeps its history: its hires, then it. */
  private retireStopped(tree: HostTree, actor: WorkspaceActor): void {
    const reference = actorReferenceOf(actor);
    const hirer = tree.directory.retained(actor.parentActorId ?? '');
    const retirement = this.treeRetirement(tree);

    this.retireOffTurn(actor.name, async () => {
      if (hirer === null) return;
      await retireHireSubtree(retirement, reference, true);
      await retirement.retire(actorReferenceOf(hirer), { reference, name: actor.name, destroy: false, interrupt: true });
    });
  }

  /** A task agent's retire, off its turn and joined by close(). */
  private retireOffTurn(agent: string, work: () => Promise<void>): void {
    const pass: Promise<void> = this.retireTaskChild(work).then((outcome) => {
      if (Result.isFailure(outcome)) diagnostics.failure('host.task_child_release_failed', outcome.failure, { agent });
      this.answerPasses.delete(pass);
    });

    this.answerPasses.add(pass);
  }

  /** Every job in the child's subtree stops first: a refusal removes nobody, and no process outlives the agent it answers. */
  /** Retires `retirement`'s actor under `owner`: first what this host holds of it (its session, its entries, its runtime),
   *  then the host's retirement, as every retirement on this machine ends. */
  private async retireHeld(tree: HostTree, owner: ActorReference, retirement: ActorRetirement): Promise<void> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const { actorId } = retirement.reference;
    const held = this.byActor.get(actorId);

    if (held) {
      await held.session.end();
      const parent = held.parentKey === null ? undefined : this.entries.get(held.parentKey);

      if (parent?.children.get(held.name)?.ws.rt.actor.actorId === actorId) parent.children.delete(held.name);

      if (this.entries.get(held.key)?.ws.rt.actor.actorId === actorId) this.entries.delete(held.key);
      this.byActor.delete(actorId);
    }

    tree.runtimes.delete(actorId);
    tree.orchestrations.delete(actorId);
    await tree.host.retire(owner, retirement);
  }

  /** What the agent is owed and has not taken, handed to its chat and run under the driver lease. The root's pass cancels
   *  what agents that are gone were owed: no pass of theirs will take it. */
  private async drainAssignedWork(entry: HostEntry): Promise<void> {
    if (entry.parentKey === null) {
      const live = new Set(entry.tree.directory.list().map((record) => record.actorId));
      const owed = new AgentDeliveries(entry.ws.rt.storage.sql);

      for (const actorId of owed.actors()) {
        if (!live.has(actorId)) diagnostics.event('host.deliveries_cancelled', { agent: entry.key, actor: actorId, count: owed.cancel(actorId).length });
      }
    }

    // Each handed over is run in this pass, as its chat takes it, before the pass lets the actor go; its turn's end, however
    // it ended, closes what it answered.
    for (const taken of await entry.deliveries.crossOwed()) {
      await entry.session.deliveredTurnSettled(taken.id);
      entry.eventLog.markTurnCompleted(taken.id);
    }
  }

  /** Drain after an inbox wake, bracketed like every converting operation. */
  private wake(entry: HostEntry, source: string): void {
    // Wakes can outlive close(); driving after close() would use a closed handle.
    if (this.closed) return;
    queueMicrotask(() => detach(Effect.promise(async () => {
      if (this.closed) return;
      await this.drain(entry, source);
    })));
  }

  private answerWake(entry: HostEntry): void {
    if (this.closed) return;
    const pass = this.drain(entry, 'refiner answer').then(() => { this.answerPasses.delete(pass); });

    this.answerPasses.add(pass);
  }

  private async drain(entry: HostEntry, source: string): Promise<void> {
    await settleLogged('host.event_drain_failed', { doing: 'draining hosted local events', otherwise: 'io' }, async () => {
      // A pass another process holds is reported by `drive`; its own pass drains and routes the same work.
      await this.drive(entry, async () => {
        await entry.session.flushPendingDrains();
        await this.drainAssignedWork(entry);
        await entry.session.runEvolutionAnswer(Date.now());
      });
    }, { agent: entry.key, source });
  }
}

function describeActors(entry: HostEntry): WorkspaceActor[] {
  return entry.tree.host.list().map((reference) => entry.tree.host.describe(reference.actorId))
    .filter((record): record is WorkspaceActor => record !== null);
}

/** A subordinate's ref: its own name over its root's pair, so it cannot bind or address outside its tree. */
function childRef(parent: HostEntry, childName: string): HostedAgentRef {
  return { name: childName, cwd: parent.ref.cwd, workspaceId: parent.ref.workspaceId };
}

/**
 * When this process must next wake, over every actor in the workspace. Unscoped by design: scoping to the root would
 * sleep through a subordinate's trigger.
 */
function nextTriggerAt(db: Database): number | null {
  const row = db.query<{ next_fire_at: number | null }, []>(`
    SELECT MIN(next_fire_at) AS next_fire_at FROM triggers
    WHERE state = 'active' AND next_fire_at IS NOT NULL
  `).get();

  return row?.next_fire_at ?? null;
}
