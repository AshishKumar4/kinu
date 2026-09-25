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
  ReplyChannelStore,
  SubordinateRosterStore,
  SubordinateIdentityStore,
  admitSubordinateTask,
  drainAssignments,
  type SubordinateInheritedContext,
  actorReferenceOf,
  canonicalConversationId,
  childContextResolver,
  createActorHost,
  createLocalPeerEndpoint,
  defaultLoopOrigin,
  samePeerGroup,
  createTeamToolDeps,
  createTemporaryAgentPort,
  delegationBudgetOf,
  delegationExhausted,
  describeSubordinateHandoff,
  inheritedContextFromTranscript,
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
  metadataBroadcastEvent,
  subordinateAgentName,
  type SqlExec,
  type SubordinateHandoff,
  type SubordinateRuntime,
  type TeamToolDeps,
  type TemporaryAgentPort,
  type SerializedMessage,
  type WorkMode,
  type WorkspaceActor,
  type WorkspaceActorDirectory,
  readWorkspaceWork, type WorkspaceWork,
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
import { OS_LEASE_PROCESS } from './lease-process';
import {
  DriverLeaseHold, REAL_CLOCK,
  type DriverKind, type DriverLeaseHolder,
} from '@kinu.run/core';
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

/**
 * Budget bounds one pass (a full pass re-wakes, so the lease can change hands); independent of
 * `HOSTED_DELEGATION_DRAIN_BUDGET`. Grace is zero for the reason core's `NO_STRANDED_DELIVERY_GRACE`
 * is: every conversion runs under the cross-process driver lease; cloud's `STALE_EVENT_DELIVERY_MS`
 * is ten minutes because a Durable Object activation may race its own predecessor, which this lease
 * rules out.
 */
const LOCAL_ASSIGNMENT_BUDGET = 8;

const LOCAL_ASSIGNMENT_LEASE_GRACE_MS = 0;

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
}

/** What one {@link LocalAgentHost.tick} did; `ran` distinguishes a deferred pass from an idle one. */
export interface LocalTickResult {
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
  readonly dbPath: string;
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
  roster: SubordinateRosterStore;
  /** Built once with the entry: it holds the live waiters `shell` parks on. */
  temporary: TemporaryAgentPort;
  team: TeamToolDeps | null;
  /** Peer mail, roots only: a subordinate could otherwise escape its depth cap via another tree. */
  peers: LocalPeerEndpoint | null;
  children: Map<string, HostEntry>;
  relay: {
    ownerDriven: boolean;
    reportedThisTurn: boolean;
    /**
     * Whether a run-settling report went out this turn. Distinct from `reportedThisTurn`: a
     * mid-task `progress` note sets that one, and must not suppress the terminal answer.
     */
    settledRun: boolean;
    mode: WorkMode;
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
}

export type AgentEventListener = (agent: string, event: SessionEvent) => void;

export class LocalAgentHost {
  private readonly entries = new Map<string, HostEntry>();
  /** Entries by actor id: host dependencies receive references, not addresses. */
  private readonly byActor = new Map<string, HostEntry>();
  private readonly listeners = new Set<AgentEventListener>();
  /** First-open fence per address; recovery must run once under concurrent cold opens. */
  private readonly opening = new Map<string, Promise<HostEntry>>();
  private readonly trees = new Map<string, HostTree>();
  private closed = false;

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
    const entry = await this.resolveEntry(address);

    return entry.tree.host.list().map((reference) => entry.tree.host.describe(reference.actorId))
      .filter((record): record is WorkspaceActor => record !== null);
  }

  /** The workspace-wide work read `listWorkspaceWork` exposes over RPC. */
  async workspaceWork(address: string): Promise<WorkspaceWork> {
    const entry = await this.resolveEntry(address);

    const actors = entry.tree.host.list().map((reference) => entry.tree.host.describe(reference.actorId))
      .filter((record): record is WorkspaceActor => record !== null);

    return readWorkspaceWork(entry.ws.rt.storage.sql, entry.ws.rt.actor, actors);
  }

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
      throw new Error(`agent "${name}" has no local ref: nothing records which`
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
        // This path discards the tree without reaching close(), so release its lease here or the
        // `driver_lease` row names a holder that no longer exists.
        try { tree.hold.release(); }
        catch (cause) {
          // Recorded, not thrown: it must not replace the open failure below, but must stay visible.
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

  /** The one actor host over a root's database; none of its factories opens a file. */
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
        exec: (query, ...bindings) => hubSql.exec(query, ...bindings),
      },
      directory,
      // No build identity for the builtin loop: a `bun`-run checkout has no build stamp.
      installedBuild: null,
      runtimeFor: (bound) => this.runtimeFor(runtimes, dbPath, db, bound),
      filesFor: async (bound) => {
        if (!ws.rt.filesForActor) throw new KinuError('missing', 'workspace has no actor file-plane resolver');

        return ws.rt.filesForActor(bound.handle);
      },
      loopFor: (bound) => {
        const parentId = bound.reference.parentActorId;
        const parentEntry = parentId === null ? null : this.requireActorEntry(parentId);
        // The origin the creation site named, else this kind's default; only the seating session knows.
        const named = parentEntry?.session.pendingLoopOrigin(bound.reference.actorId);

        return {
          origin: named ?? defaultLoopOrigin(bound.record.kind),
          parent: parentEntry === null ? null : parentEntry.ws.rt,
        };
      },
      orchestrationFor: (bound) => {
        const ownsSession = bound.record.kind === 'main' || bound.record.kind === 'subordinate';
        const clientId = ownsSession ? bound.reference.actorId : bound.reference.parentActorId;

        if (clientId === null) throw new KinuError('missing', 'A reporting actor has no session to publish through.');

        const orchestration = createLocalOrchestration({
          runtime: bound.runtime,
          history: bound.stores.history,
          eventLog: new EventLog(hubSql, bound.handle),
          // Reporting actors have no LocalAgentSession; resolve the parent's at call time because the host
          // builds orchestration first.
          session: () => this.requireActorEntry(clientId).session,
          oneShot: false,
        });

        // Retained only for kinds that get a HostEntry; head/node orchestration dies with its seat.
        if (ownsSession) {
          orchestrations.set(bound.reference.actorId, orchestration);
        }

        return orchestration.deps;
      },
      contextEvents: (bound) => bound.stores.eventRecorder,
      discardBytes: (record) => this.discardActorBytes(ref, ws, record),
    });

    return {
      dbPath, db, host, directory, runtimes, orchestrations, driving: 0,
      hold: new DriverLeaseHold({ sql, execRaw: makeExecRaw(db), proc: OS_LEASE_PROCESS }, this.driverKind),
    };
  }

  /**
   * One actor's runtime. A root's is prepared before the host exists; a hire's is retained for the
   * entry built next; a head's or node's is per acquisition and retained nowhere.
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
      // The observer the seater named, read off the parent entry's session: only the caller knows what
      // watches this seat.
      return await buildLocalActorRuntime(
        parent.ws.rt, bound, parent.session.pendingWriteObserver(bound.reference.actorId),
      );
    }

    const binding = bindLocalActorReference(parent.ws.rt.actor, bound.reference);
    // The host's handle: the release fence is bound to this object.
    adoptLocalActorHandle(parent.ws.rt.actor, bound.reference, bound.handle);
    const openConfig = this.childOpenConfig(parent, binding);

    const built = createCLIRuntime(db, {
      ...openConfig, dbPath, agentName: binding.name, actor: bound.handle,
    });

    const shared = await shareLocalWorkspacePlane(built, parent.ws.rt, openConfig.facet);
    runtimes.set(bound.reference.actorId, shared);

    return shared;
  }

  /** Remove one destroyed actor's scratch home, named from its storage key and kind; its rows go with the directory row. */
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

    // Consumed: empty the handover slot so a re-acquisition cannot pick it up.
    input.tree.orchestrations.delete(input.actor.reference.actorId);
    // Subordinate names are per-parent, so this roster is bound to this actor.
    const roster = new SubordinateRosterStore(hubSql, input.actor.handle);
    roster.ensureSchema();
    const sessionId = canonicalConversationId(config);

    const sessionOpts: LocalAgentSessionOpts = {
      rt: input.ws.rt,
      db: input.tree.db,
      hosted: {
        actor: input.actor,
        host: input.tree.host,
        engine: orchestration.engine,
        budget: orchestration.budget,
        eventLog: orchestration.eventLog,
      },
      cwd: input.ref.cwd,
      onEvent: (event) => this.onSessionEvent(input.key, event),
      clock: REAL_CLOCK,
    };

    // Read at prompt time: a rename or auto-title lands on the root.
    if (input.parentKey !== null) {
      sessionOpts.workspaceTitle = () => this.rootEntry(input.key).config.getDisplayName();
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
      roster,
      temporary: createTemporaryAgentPort({
        roster,
        runtime: this.childRuntime(input.key),
        now: () => Date.now(),
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
    // The roster needs the session's broadcast, so deps are installed right after construction, before any turn.
    entry.session.setTeam(this.buildTeam(entry));
    input.ws.rt.setChildContext?.(childContextResolver({
      host: input.tree.host,
      directory: input.tree.directory,
      parent: input.actor.handle,
      events: (child) => child.stores.eventRecorder,
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

  /** Bind an already-created subordinate; `openLocalActor` already refused a retired creation. */
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

      // A child resolves role and tier against its root's (account) catalog.
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

  /** The parent's provider wiring with the directory forced to the parent's ref, so a child cannot bind a different plane. */
  private childOpenConfig(parent: HostEntry, binding: LocalActorBinding): CLIOpenConfig & { facet: string } {
    if (binding.kind !== 'subordinate') throw new KinuError('denied', 'The roster path is not a subordinate actor.');

    return { ...parent.ws.openConfig, cwd: parent.ref.cwd, facet: subordinateAgentName(binding.storageKey), actorBinding: binding };
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

    for (const child of entry.children.values()) {
      const childNext = (await this.tickEntry(child, now)).nextAt;

      if (childNext !== null) nextAt = nextAt === null ? childNext : Math.min(nextAt, childNext);
    }

    return outcome.ran ? { ran: true, nextAt } : { ran: false, nextAt, heldBy: outcome.heldBy };
  }

  /** One pass's converting steps; the lease is re-checked between steps since an interactive process may preempt. */
  private async runPass(entry: HostEntry, now: number): Promise<number | null> {
    const hold = entry.tree.hold;
    const lifecyclePending = await recoverSubordinateLifecycles(entry.roster, this.childRuntime(entry.key));

    if (!hold.held()) return nextTriggerAt(entry.tree.db);

    if (entry.parentKey === null) {
      // Finish a retirement this process interrupted; only the recorded storage path lives outside the database.
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
    state.ownerDriven = event.kind === 'user';
    state.reportedThisTurn = false;
    state.settledRun = false;
    state.mode = event.workMode;
  }

  /**
   * The automatic turn-end report the child's settled turn owes. One branch only: separate `error`
   * and `turn-end` relays would report one failing turn twice.
   */
  private parentRelayFor(child: HostEntry): LocalParentRelay {
    return {
      owed: async (ending, assistantText, narration) => {
        const state = child.relay;

        // Suppressed only by a run-settling report, never a progress note.
        if (state === null || state.settledRun) return null;
        // A task child always reports its ending, even an empty one: its caller asked.
        const task = await terminalTaskReport({ lifetime: child.actor.record.lifetime, ending, assistantText, narration });

        if (task) return task;

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
        // Recorded before the send, so a second terminal path on this turn is suppressed.
        if (child.relay) {
          child.relay.reportedThisTurn = true;
          child.relay.settledRun = true;
        }

        const relayed = await this.relayToParent({
          child, content: text, mode, status, origin: 'turn_end', sequenceId,
        });

        return relayed.disposition;
      },
    };
  }

  /** Publish one child report into its parent's rail. `status` is the child's own word; it moves the parent's roster row. */
  private async relayToParent(relay: ChildReportRelay): Promise<SubordinateEventResult> {
    const { child, content, mode, status, origin, sequenceId, handoff } = relay;

    if (!child.parentKey) return { id: '', disposition: 'not_awaited' };
    const parent = this.entries.get(child.parentKey);

    if (!parent) throw new Error(`parent "${child.parentKey}" is not hosted`);

    return receiveSubordinateEvent({
      log: parent.eventLog,
      roster: parent.roster,
      vfs: parent.ws.rt.storage.vfs,
      // One transaction: core's replay fast path answers `already_held` off the dedupe key, so an
      // interruption between insert and roster update would leave the child `working` forever.
      transaction: (body) => parent.tree.db.transaction(body)(),
      announce: (report: AdmittedSubordinateReport) => {
        const metadata: JsonObject = {
          kind: 'report',
          subordinate: report.subordinate,
          timestamp: report.timestamp,
        };

        if (report.task) metadata.task = report.task;
        parent.session.broadcast(metadataBroadcastEvent(
          'subordinate_event', metadata, { status: report.status, text: report.content },
        ));
      },
      onAdmitted: () => this.wake(parent, 'subordinate report'),
      // A temporary child's answer goes to the waiting `agents.ask` port, never as an event waking this parent.
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

  /** The report spine for one subordinate; roots get none. The session limits it to parent-assigned turns. */
  private buildReport(child: HostEntry): ReportToolDeps {
    return {
      report: async ({ status, content, handoff }) => {
        const relayed = await this.relayToParent({
          child,
          content,
          mode: child.relay?.mode ?? 'build',
          status,
          origin: 'report_tool',
          sequenceId: `${child.key}:report:${crypto.randomUUID()}`,
          handoff,
        });

        // Set here, not off a `tool-call` event: the one seam both the native tool and `report.*` codemode publish through.
        if (child.relay) {
          child.relay.reportedThisTurn = true;
          // Only a run-settling report counts, the same predicate the parent's ingress uses.
          child.relay.settledRun ||= temporaryRunSettles({ status, origin: 'report_tool' });
        }

        return { disposition: relayed.disposition, id: relayed.id };
      },
    };
  }

  private buildTeam(parent: HostEntry): TeamToolDeps {
    const delegation = delegationBudgetOf((actorId) => parent.tree.host.describe(actorId), parent.actor.record);

    const input: Parameters<typeof createTeamToolDeps>[0] = {
      delegation,
      roster: parent.roster,
      runtime: this.childRuntime(parent.key),
      now: () => Date.now(),
      inheritedContext: (): Promise<SerializedMessage[]> => inheritedContextFromTranscript(parent.actor.session.canonical.transcript(parent.sessionId)),
      originContext: async () => parent.actor.session.history,
      ownMission: () => localActorMission(parent.ws.rt, makeSqlExec(parent.tree.db)) ?? '',
      createName: mintSubordinateName,
      broadcast: (event) => parent.session.broadcast(event),
      broadcastTask: (event) => parent.session.broadcast(metadataBroadcastEvent(
        'subordinate_event',
        { subordinate: event.subordinate, timestamp: event.timestamp },
        { status: 'task', text: event.content },
      )),
    };

    // At the depth cap, drop the temporary port: a role-targeted `ask` births a child and would
    // otherwise recurse past `DELEGATION_MAX_DEPTH`. `hire` is caught by core's dispatch refusal.
    if (!delegationExhausted(delegation)) {
      Object.assign(input, { temporary: parent.temporary });
    }

    return createTeamToolDeps(input);
  }

  /**
   * The child substrate of one hosted agent, for both durable and temporary rungs. Keyed by address
   * because the temporary port is built before the entry is registered.
   */
  private childRuntime(parentKey: string): SubordinateRuntime {
    const parentOf = () => this.requireEntry(parentKey);

    return {
      spawn: async (input) => {
        const child = await this.birthChild(parentOf(), input);

        return actorReferenceOf(child.ws.rt.actor);
      },
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

  /** The entry an issued actor id belongs to. */
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

  /** Create one subordinate: descriptor rows then its hosted actor. A transaction, not a file creation. */
  private async birthChildEntry(
    parent: HostEntry,
    input: Parameters<SubordinateRuntime['spawn']>[0],
    key: string,
    binding: LocalActorBinding,
  ): Promise<HostEntry> {
    const llm = parent.ws.openConfig.llm;

    if (!llm) {
      throw new Error('No model provider is connected, so this workspace cannot create agents. Connect one: kinu provider connect <provider>.');
    }

    const tree = parent.tree;
    const exec = makeSqlExec(tree.db);
    const sql = makeSql(tree.db);
    const owner = localActorOwner(parent.ws.rt.actor);
    const depth = delegationBudgetOf((actorId) => tree.host.describe(actorId), parent.actor.record).depth + 1;

    try {
      tree.db.transaction(() => {
        // The child's own handle; stores below are scoped to it, so one database holds N descriptors.
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
      })();
      const actor = await tree.host.acquire(binding.reference);
      const rt = tree.runtimes.get(binding.reference.actorId);

      if (!rt) throw new KinuError('missing', 'The created subordinate has no bound runtime.');
      const config = rt.actor.config;
      const descriptor = subordinateDescriptorSource(config).read();

      if (!descriptor) throw new Error(`subordinate "${input.name}" has no readable descriptor after creation`);
      // SOUL belongs to the agent: with a bound cwd `storage.vfs` is the user's project.
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
      inheritedContext?: SubordinateInheritedContext;
      creationId?: string;
    },
  ): SubordinateHandoff {
    if (this.closed) throw new Error('LocalAgentHost is closed.');

    const admission = admitSubordinateTask(child.eventLog, {
      fromWorkspace: parent.name,
      kind: input.kind,
      body: input.body,
      deliverable: input.deliverable,
      inheritedContext: input.inheritedContext,
      creationId: input.creationId,
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

  /** Retire a creation cancelled before it ran, through the host like every retirement. */
  private async retireCreation(
    parent: HostEntry,
    input: { name: string; creationId: string; lifetime: WorkspaceActor['lifetime'] },
  ): Promise<ActorReference> {
    // `cancelCreation`, not register-then-destroy: it refuses a mismatched birth and never activates the row.
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

    // A retained dismissal keeps history as rows; only scratch bytes are removed.
    const retirement: Parameters<ActorHost['retire']>[1] = {
      reference, name, destroy: !keepHistory,
    };

    await parent.tree.host.retire(parent.actor.reference, retirement);
  }

  /**
   * Run parent-admitted assignments through the child's own turn admission, verbatim, not as a
   * reactor digest. `drainTurnId` splices the birth context. Roots have no assignments.
   */
  private async drainAssignedWork(entry: HostEntry): Promise<void> {
    if (entry.parentKey === null) return;

    const swept = await drainAssignments(entry.eventLog, {
      now: Date.now(),
      budget: LOCAL_ASSIGNMENT_BUDGET,
      staleMs: LOCAL_ASSIGNMENT_LEASE_GRACE_MS,
      run: async (task) => {
        const admitted = await entry.session.enqueueTurn({
          text: task.body,
          metadata: { kinuEvent: 'subordinate_task', kinuMode: task.mode, drainTurnId: task.turnId },
          // The row's id, so a re-delivery lands on the same durable message.
          idempotencyKey: task.sequenceId,
        });

        // The turn did not happen; throw so the row's lease stays open and the next pass re-pends it.
        if (admitted.status !== 'queued') {
          throw new KinuError('unavailable', `the local turn queue answered "${admitted.status}"`);
        }
      },
      onFailure: ({ cause }) => {
        diagnostics.failure(
          'host.assignment_turn_failed',
          toKinuError({ doing: 'running an assignment this agent\'s parent admitted', cause, otherwise: 'io' }),
          { agent: entry.key },
        );
      },
    });

    if (swept.truncated) this.wake(entry, 'assignment backlog');
  }

  /** Drain after an inbox wake, bracketed like every converting operation. */
  private wake(entry: HostEntry, source: string): void {
    // Wakes can outlive close(); driving after close() would use a closed handle.
    if (this.closed) return;
    queueMicrotask(async () => {
      if (this.closed) return;

      try {
        await this.drive(entry, async () => {
          await entry.session.flushPendingDrains();
          await this.drainAssignedWork(entry);
        });
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

/** A subordinate's ref: its own name over its root's pair, so it cannot bind or address outside its tree. */
function childRef(parent: HostEntry, childName: string): HostedAgentRef {
  return { name: childName, cwd: parent.ref.cwd, workspaceId: parent.ref.workspaceId };
}

/**
 * When this process must next wake, over every actor in the workspace. Unscoped by design, like
 * `hasUntimedLiveJobsInWorkspace()`: scoping to the root would sleep through a subordinate's trigger.
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
