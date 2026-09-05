/**
 * LocalAgentHost — the durable-agent substrate owned by the local daemon.
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

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type { LanguageModel, ModelMessage } from 'ai';
import {
  EventLog,
  ReplyChannelStore,
  SubordinateRosterStore,
  admitSubordinateTask,
  createAgentConfigStore,
  canonicalConversationId,
  createLocalPeerEndpoint,
  samePeerGroup,
  createTeamToolDeps,
  createTemporaryAgentPort,
  renderSubordinateInheritedContext,
  delegationBudgetAtDepth,
  delegationExhausted,
  describeSubordinateHandoff,
  inheritedContextFromHistory,
  initWorkspaceSchema,
  readSubordinateLiveStatus,
  receiveSubordinateEvent,
  readMission,
  renderSoulMarkdown,
  mintSubordinateName,
  subordinateDescriptorSource,
  subordinateRelaysTurnEnd,
  TEMPORARY_LIFETIME,
  temporaryRunSettles,
  terminalTaskReport,
  writeSoul,
  InstructionApprovalStore,
  type AdmittedSubordinateReport,
  type ReportToolDeps,
  type SubordinateReportOrigin,
  type SubordinateEventResult,
  type SubordinateReportStatus,
  type AgentConfigStore,
  type JsonObject,
  type HostedAgentRef,
  type LocalPeerEndpoint,
  type PeerMessage,
  type ReceiveResult,
  type RoleSelection,
  type SqlExec,
  type SubordinateHandoff,
  type SubordinateLifetime,
  type SubordinateRuntime,
  type TeamToolDeps,
  type TemporaryAgentPort,
  type TierId,
  type SerializedMessage,
  type WorkMode,
} from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/identity';
import { KinuError, diagnostics, refusalOf, toKinuError } from '@kinu.run/core/obs';
import {
  makeSql, makeExecRaw, makeSqlExec, makeWorkspaceSchemaSql, shareLocalWorkspacePlane,
  type CLIRuntime,
} from '../runtime';
import { openWorkspaceCLI, type CLIOpenConfig } from '../open';
import {
  DriverLeaseHold,
  type DriverKind, type DriverLeaseHolder,
} from './driver-lease';
import {
  LocalAgentSession,
  type LocalAgentSessionOpts,
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
   * workspace each belongs to. A root with no ref is not hosted: it has no
   * `cwd` to bind its plane to and no peer group, and binding it from the
   * mere existence of an `agent.db` is the inference this cutover removes.
   */
  roster(): readonly HostedAgentRef[];
  /** Build one already-created ROOT agent over the host-owned handle. The ref
   *  carries the physical directory its plane must be bound to. */
  open(ref: HostedAgentRef, db: Database, dbPath: string): Promise<LocalHostedAgent>;
  dbPath(name: string): string;
  /** Return `<child-root>/agent.db`. The host owns that child root and deletes
   *  it recursively only for explicit keepHistory=false. */
  childDbPath(parentDbPath: string, child: string): string;
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
  dbPath: string;
  db: Database;
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
  private readonly listeners = new Set<AgentEventListener>();
  /** First-open fence per address. Recovery must run once even when a timer,
   *  client event, and team call arrive together on a cold daemon. */
  private readonly opening = new Map<string, Promise<HostEntry>>();
  /** This process's lease on each bound agent's conversation. One per address,
   *  built when the entry is, so every driving boundary asks the same object. */
  private readonly driverHolds = new Map<string, DriverLeaseHold>();
  private closed = false;

  constructor(private readonly opts: LocalAgentHostOptions) {}

  private get driverKind(): DriverKind {
    return this.opts.driverKind ?? 'interactive';
  }

  /** This process's hold on one agent's conversation, created on first use. */
  private driverHold(entry: HostEntry): DriverLeaseHold {
    const existing = this.driverHolds.get(entry.key);
    if (existing) return existing;
    const hold = new DriverLeaseHold(
      { sql: makeSql(entry.db), execRaw: makeExecRaw(entry.db) },
      this.driverKind,
    );
    this.driverHolds.set(entry.key, hold);
    return hold;
  }

  /**
   * Run one CONVERTING operation as this agent's driver, or decline and say who
   * owns it. Converting means it binds durable rows to a turn — a pass, and the
   * recovery drain a cold host performs on open, which is the same conversion
   * with a different trigger.
   *
   * A daemon hands the lease back at the end, so an interactive process
   * arriving between passes does not have to preempt anything. An interactive
   * host keeps it until the session ends, which is what stops a daemon pass
   * landing in the middle of somebody's conversation.
   */
  private async drive<T>(
    entry: HostEntry,
    run: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false; heldBy: DriverLeaseHolder }> {
    const hold = this.driverHold(entry);
    const refusal = hold.acquire();
    if (refusal) {
      diagnostics.event('driver.pass_deferred', {
        agent: entry.key,
        kind: this.driverKind,
        reason: refusal.refused.reason,
      });
      return { ran: false, heldBy: refusal.holder };
    }
    try {
      return { ran: true, value: await run() };
    } finally {
      if (this.driverKind === 'daemon') hold.release();
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
      // Released BEFORE the handle closes, and only if the row is still ours.
      // An interactive process holds its lease for the whole session, so this is
      // where a daemon becomes able to drive again — without it, a conversation
      // stays locked to a process that has exited and only a liveness check
      // would recover it, which is the slower and less obvious path.
      this.driverHolds.get(entry.key)?.release();
      entry.db.close();
    }
    this.entries.clear();
    this.driverHolds.clear();
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
      return await this.buildEntry({
        key: name,
        name,
        ref,
        parentKey: null,
        dbPath,
        db,
        ws,
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private async buildEntry(input: {
    key: string;
    name: string;
    ref: HostedAgentRef;
    parentKey: string | null;
    dbPath: string;
    db: Database;
    ws: LocalHostedAgent;
    instructionApprovals?: InstructionApprovalStore;
  }): Promise<HostEntry> {
    const config = createAgentConfigStore(input.ws.rt.storage.sql);
    const hubSql = makeSqlExec(input.db);
    const roster = new SubordinateRosterStore(hubSql, makeSql(input.db));
    roster.ensureSchema();
    const sessionId = canonicalConversationId(config);
    const sessionOpts: LocalAgentSessionOpts = {
      rt: input.ws.rt,
      db: input.db,
      // The physical plane and the prompt's runtime context read ONE directory:
      // the one on this agent's ref. Every peer and every subordinate under
      // them binds the same bytes.
      cwd: input.ref.cwd,
      onEvent: (event) => this.onSessionEvent(input.key, event),
      instructionApprovals: input.instructionApprovals,
    };
    // A subagent's prompt names the workspace it works in, and its own config
    // holds only its own title. Read at prompt time rather than captured now:
    // the ROOT is where a rename and an auto-title both land.
    if (input.parentKey !== null) {
      sessionOpts.workspaceTitle = () => this.rootEntry(input.key).config.getDisplayName();
    }
    if (input.ws.modelResolver) sessionOpts.modelResolver = input.ws.modelResolver;
    if (input.ws.staticModel) sessionOpts.model = input.ws.staticModel;
    if (input.ws.profileAuthority) sessionOpts.profileAuthority = input.ws.profileAuthority;
    if (input.ws.providerRevision) sessionOpts.providerRevision = input.ws.providerRevision;
    const session = new LocalAgentSession(sessionOpts);
    const entry: HostEntry = {
      ...input,
      sessionId,
      session,
      config,
      eventLog: new EventLog(hubSql),
      lifetime: lifetimeOf(config),
      roster,
      temporary: createTemporaryAgentPort({
        roster,
        // The SAME child substrate the roster drives, so a temporary agent is a
        // real local actor with its own database, session and tool loop.
        runtime: this.childRuntime(input.key),
        now: () => Date.now(),
        renderInheritedContext: () => renderSubordinateInheritedContext(
          inheritedContextFromHistory(readConversationTail(this.requireEntry(input.key))),
        ),
        createName: mintSubordinateName,
        // Existence only — the bytes are the child's to read, never this
        // actor's, which is the saving the channel exists for.
        statRef: async (path) => (await input.ws.rt.storage.vfs.stat(path)) !== null,
      }),
      team: null,
      peers: null,
      children: new Map(),
      relay: input.parentKey === null
        ? null
        : { ownerDriven: false, reportedThisTurn: false, settledRun: false, mode: 'build' },
    };
    this.entries.set(input.key, entry);
    // THE REAL TEAM TRANSPORT. The roster needs the session's broadcast, which
    // only exists once the session is constructed — so the deps are installed
    // immediately after, before any turn can run.
    entry.session.setTeam(this.buildTeam(entry));
    // THE DRIVER LEASE. Same reason it lands here: it closes over the entry.
    // The pump consults it before every turn, so an interactive process takes
    // the lease from a daemon at that boundary rather than interleaving with it.
    // A closed host refuses instead of reaching the lease: the gate can fire
    // from a turn continuation that outlives close(), and close() has already
    // released the holds and closed this entry's database handle.
    entry.session.setDriverGate(() => this.closed
      ? refusalOf(new KinuError('unavailable', 'this host is closed; no driver conversion may start'))
      : this.driverHold(entry).acquire()?.refused ?? null);
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
        session.reclaimStrandedEventDeliveries();
        await session.flushPendingDrains();
      });
      return entry;
    } catch (error) {
      this.entries.delete(input.key);
      const cleanupErrors: Error[] = [];
      try {
        await session.end();
      } catch (cleanupError) {
        cleanupErrors.push(new Error('ending the failed hosted session', { cause: cleanupError }));
      }
      // Released and forgotten before the caller closes `input.db`. Leaving the
      // hold in this map poisons a retry: `driverHold` returns the old object,
      // whose SQL executor closes over the failed entry's now-closed Database.
      // It also leaves the interactive lease row owned by a host that never
      // opened. Each caller owns the handle itself and closes it after this
      // throws; this method owns the memoized object it created.
      const hold = this.driverHolds.get(input.key);
      try {
        hold?.release();
      } catch (cleanupError) {
        cleanupErrors.push(new Error('releasing the failed hosted session driver lease', { cause: cleanupError }));
      }
      this.driverHolds.delete(input.key);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [new Error(`opening hosted agent "${input.key}"`, { cause: error }), ...cleanupErrors],
          `opening hosted agent "${input.key}" failed and its session or driver lease did not close`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async recoverChildren(parent: HostEntry): Promise<void> {
    for (const roster of parent.roster.list()) {
      if (parent.children.has(roster.name) || this.opening.has(`${parent.key}/${roster.name}`)) continue;
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
    const pending = this.opening.get(key);
    if (pending) return await pending;
    const existing = parent.children.get(childName);
    if (existing) return existing;

    const opening = this.openExistingChild(parent, childName, key);
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(key) === opening) this.opening.delete(key);
    }
  }

  private async openExistingChild(
    parent: HostEntry,
    childName: string,
    key: string,
  ): Promise<HostEntry> {
    const dbPath = this.opts.childDbPath(parent.dbPath, childName);
    if (!existsSync(dbPath)) {
      throw new Error(`subordinate "${childName}" has a roster row but no actor state at ${dbPath}`);
    }
    const db = new Database(dbPath);
    try {
      const openConfig = this.childOpenConfig(parent);
      const opened = await openWorkspaceCLI(db, dbPath, openConfig);
      const rt = shareLocalWorkspacePlane(opened.rt, parent.ws.rt);
      const ws: LocalHostedAgent = { rt, openConfig };
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
        dbPath,
        db,
        ws,
        instructionApprovals: parent.session.instructionApprovalAuthority(),
      });
      parent.children.set(childName, entry);
      return entry;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * The provider/auth wiring a subordinate opens with — its parent's, with the
   * bound directory forced to the parent's ref.
   *
   * Forced rather than inherited verbatim because "a subordinate shares its
   * root's bytes" then holds by construction: whatever the caller put in the
   * root's `openConfig`, a child cannot be opened against a different plane.
   */
  private childOpenConfig(parent: HostEntry): CLIOpenConfig {
    return { ...parent.ws.openConfig, cwd: parent.ref.cwd };
  }

  /** One agent's peer endpoint, over the same `outbox_peer`/`reply_channels`
   *  tables its own SQLite file already holds. */
  private buildPeerEndpoint(entry: HostEntry, hubSql: SqlExec): LocalPeerEndpoint {
    // The store and the endpoint are mutually dependent — a reply routes back
    // over the endpoint's outbox, and the endpoint answers through the store —
    // so the dispatcher reads `entry.peers` at DISPATCH time, by then set.
    const replyChannels = new ReplyChannelStore(hubSql, {
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
   * Every actor here has its OWN database and therefore its own driver row, so
   * every one of them is bracketed separately. A subordinate used to be gated
   * on a token nobody had taken for it, which meant its triggers, drains and
   * evolution silently never ran on a cold host.
   *
   * `ran` describes THIS agent's pass. A subordinate that is busy elsewhere
   * does not make its parent's pass a non-event, but its schedule still rides
   * back so the driver's next sleep covers it.
   */
  private async tickEntry(entry: HostEntry, now: number): Promise<LocalTickResult> {
    const outcome = await this.drive(entry, () => this.runPass(entry, now));
    let nextAt = outcome.ran ? outcome.value : nextTriggerAt(entry.db);
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
    const hold = this.driverHold(entry);
    await entry.session.fireDueTriggers(now);
    if (!hold.held()) return nextTriggerAt(entry.db);
    await entry.session.flushPendingDrains();
    if (!hold.held()) return nextTriggerAt(entry.db);
    await entry.session.runDueEvolution();

    let next = nextTriggerAt(entry.db);
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
   * No `turn-end` branch any more. The automatic report used to be started from
   * here as an untracked promise, so a process that died before the parent's
   * ingress admitted it left nothing recording that a retry was owed. The child's
   * terminal roster owns it now, through {@link parentRelayFor} — which reads the
   * same two facts this keeps, while the turn's answer is still being committed.
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
   * Every decision stays where it already lived: whether a DURABLE turn relays is
   * core's `subordinateRelaysTurnEnd` over the state {@link observeChildTurn}
   * keeps, and which words a TASK child's ending earns is core's closed
   * `terminalTaskReport` map. What changes is that the child's ledger now holds
   * the obligation, so an interruption before the parent admitted it leaves a row
   * a later start replays.
   *
   * There is no `error` branch and no `turn-end` branch here any more. Both used
   * to start their own detached relay, which is how one failing turn — an `error`
   * event AND a `turn-end` event — could reach the parent twice. The session
   * declares one report per ending now, and this port only answers which.
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
  ): Promise<SubordinateEventResult> {
    if (!child.parentKey) return { id: '', disposition: 'not_awaited' };
    const parent = this.entries.get(child.parentKey);
    if (!parent) throw new Error(`parent "${child.parentKey}" is not hosted`);
    return receiveSubordinateEvent({
      log: parent.eventLog,
      roster: parent.roster,
      vfs: parent.ws.rt.storage.vfs,
      // REAL, over the PARENT's connection — both writes land in its database.
      // Core's replay fast path reads the dedupe key and answers `already_held`
      // without re-applying the report, so an interruption between the event
      // insert and the roster update used to leave a completed child `working`
      // in its parent's eyes forever, with no retry able to correct it.
      transaction: (body) => parent.db.transaction(body)(),
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
      report: async ({ status, content }) => {
        const relayed = await this.relayToParent(
          child, content, child.relay?.mode ?? 'build', status, 'report_tool',
          // One in-process tool call is one report — a second call with the
          // same words is a second thing the model chose to say.
          `${child.key}:report:${crypto.randomUUID()}`,
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
      ownMission: () => readMission(parent.ws.rt.storage.sql) ?? '',
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
   * with its own database, its own session and its own tool loop.
   *
   * Keyed by ADDRESS rather than closing over the entry, because the temporary
   * port is built with the entry and therefore before it is registered. Every
   * method resolves the parent at call time, which is also what keeps it correct
   * across a re-open.
   */
  private childRuntime(parentKey: string): SubordinateRuntime {
    const parentOf = () => this.requireEntry(parentKey);
    return {
      spawn: async (input) => { await this.birthChild(parentOf(), input); },
      assign: async (name, input) => {
        const parent = parentOf();
        const child = await this.openChildEntry(parent, name);
        return this.admitChildWork(parent, child, { kind: 'task', ...input });
      },
      status: async (name) => {
        const child = await this.openChildEntry(parentOf(), name);
        return readSubordinateLiveStatus(makeSqlExec(child.db));
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
      dismiss: async (name, keepHistory) => {
        await this.removeChild(parentOf(), name, keepHistory);
      },
    };
  }

  private requireEntry(key: string): HostEntry {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`local agent "${key}" is not hosted`);
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

  /** Birth + seed the child before its LocalAgentSession becomes reachable.
   *  The role is one tagged selection, so catalog and legacy roles never
   *  become independent parent-side mirrors. */
  private async birthChild(
    parent: HostEntry,
    input: Parameters<LocalAgentHost['birthChildEntry']>[1],
  ): Promise<HostEntry> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const key = `${parent.key}/${input.name}`;
    if (this.opening.has(key) || this.entries.has(key)) {
      throw new Error(`subordinate "${input.name}" is already being created`);
    }
    const opening = this.birthChildEntry(parent, input, key);
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(key) === opening) this.opening.delete(key);
    }
  }

  private async birthChildEntry(
    parent: HostEntry,
    input: {
      name: string;
      /** Empty when nothing the caller said can name this agent yet. */
      displayName: string;
      nameOrigin: 'user' | 'auto';
      role: RoleSelection;
      tier?: TierId;
      mission: string;
      lifetime: SubordinateLifetime;
    },
    key: string,
  ): Promise<HostEntry> {
    const llm = parent.ws.openConfig.llm;
    if (!llm) {
      throw new Error('No provider configured for this host — subordinate creation needs a connected provider.');
    }
    const dbPath = this.opts.childDbPath(parent.dbPath, input.name);
    if (existsSync(dbPath)) {
      throw new Error(`subordinate "${input.name}" already has actor state at ${dbPath}`);
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    try {
      await createWorkspace(db, {
        // Address and title, separately. `input.name` is the slug the tree
        // addresses this subagent by; the title is what a person calls it, and
        // a one-click hire has none until its first message names it.
        name: input.name,
        title: input.displayName,
        purpose: input.mission,
        llm,
      });
      initWorkspaceSchema(makeWorkspaceSchemaSql(db));
      const openConfig = this.childOpenConfig(parent);
      const opened = await openWorkspaceCLI(db, dbPath, openConfig);
      const rt = shareLocalWorkspacePlane(opened.rt, parent.ws.rt);
      const config = createAgentConfigStore(rt.storage.sql);
      config.setDisplayNameOrigin(input.displayName, input.nameOrigin);
      config.setRoleSelection(input.role);
      config.setAssignedTier(input.tier ?? null);
      const descriptor = subordinateDescriptorSource(config).read();
      if (!descriptor) throw new Error(`subordinate "${input.name}" has no readable descriptor after creation`);
      // The child keeps the parent's model only as its STARTING point; its
      // tier (when it has one) resolves at its own turn boundary. No model
      // spec travels with a hire — tier is the one routing input.
      const inheritedModel = parent.config.getModel();
      if (inheritedModel) config.setModel(inheritedModel);
      config.set(CHILD_DEPTH_KEY, String(treeDepthOf(parent.config) + 1));
      config.set(CHILD_LIFETIME_KEY, input.lifetime);
      // SOUL belongs to the AGENT, never to the shared directory. With a bound
      // cwd, `storage.vfs` IS the user's project, so writing there would drop a
      // SOUL.md into their repo and every peer's hire would overwrite the last
      // one. `agentStateVfs` is this agent's own tree; the `??` is the spelling
      // for backends where the two coincide.
      await writeSoul(
        rt.agentStateVfs ?? rt.storage.vfs,
        rt.storage.sql,
        [
          renderSoulMarkdown({ name: descriptor.displayName, mission: input.mission }),
          '',
          '## Role',
          '',
          descriptor.role.kind === 'catalog'
            ? `Role: ${descriptor.role.roleId}${descriptor.tier ? ` (tier ${descriptor.tier})` : ''}`
            : [
              'Legacy role (assigned before this workspace had a role catalog):',
              descriptor.role.text,
              'You keep these instructions until you are explicitly assigned a catalog role.',
            ].join('\n'),
        ].join('\n'),
      );
      const ws: LocalHostedAgent = { rt, openConfig };
      if (parent.ws.modelResolver) ws.modelResolver = parent.ws.modelResolver;
      if (parent.ws.staticModel) ws.staticModel = parent.ws.staticModel;
      if (parent.ws.mcpServers) ws.mcpServers = parent.ws.mcpServers;
      if (parent.ws.profileAuthority) ws.profileAuthority = parent.ws.profileAuthority;
      const entry = await this.buildEntry({
        key,
        name: input.name,
        ref: childRef(parent, input.name),
        parentKey: parent.key,
        dbPath,
        db,
        ws,
        instructionApprovals: parent.session.instructionApprovalAuthority(),
      });
      parent.children.set(input.name, entry);
      return entry;
    } catch (error) {
      db.close();
      removeChildState(dbPath);
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
      deadlineHint?: string;
      inheritedContext?: string;
    },
  ): SubordinateHandoff {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const admission = admitSubordinateTask(child.eventLog, {
      fromWorkspace: parent.name,
      kind: input.kind,
      body: input.body,
      deliverable: input.deliverable,
      deadlineHint: input.deadlineHint,
      inheritedContext: input.inheritedContext,
      mode: input.mode,
      now: Date.now(),
    });
    const handoff = describeSubordinateHandoff({
      admission,
      turnInFlight: child.session.turnInFlight(),
      live: readSubordinateLiveStatus(makeSqlExec(child.db)),
    });
    if (admission.admitted) this.wake(child, 'subordinate task');
    return handoff;
  }

  private async removeChild(parent: HostEntry, name: string, keepHistory: boolean): Promise<void> {
    if (this.closed) throw new Error('LocalAgentHost is closed.');
    const child = parent.children.get(name);
    const dbPath = child?.dbPath ?? this.opts.childDbPath(parent.dbPath, name);
    if (child) {
      await child.session.end();
      child.db.close();
      parent.children.delete(name);
      this.entries.delete(child.key);
    }
    if (!keepHistory) removeChildState(dbPath);
  }

  /** Drain now because something landed in this agent's inbox. Bracketed like
   *  every other converting operation here: a wake that meets another driver is
   *  simply that driver's work, and its rows are still pending for them. */
  private wake(entry: HostEntry, source: string): void {
    // Wakes arrive from listeners and timers that can outlive close(), and a
    // drive after close() would recreate a lease hold on a closed database.
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
  const rows = makeSql(entry.db)<{ role: string; content: string }>`
    SELECT role, content FROM messages
    WHERE session_id = ${entry.sessionId} AND role IN ('user', 'assistant')
    ORDER BY created_at DESC, rowid DESC LIMIT 16`;
  return rows.reverse().map((row): ModelMessage => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
  }));
}

function nextTriggerAt(db: Database): number | null {
  const table = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='triggers'`).get();
  if (!table) return null;
  const row = db.query<{ next_fire_at: number | null }, []>(`
    SELECT MIN(next_fire_at) AS next_fire_at FROM triggers
    WHERE state = 'active' AND next_fire_at IS NOT NULL
  `).get();
  return row?.next_fire_at ?? null;
}

function removeChildState(dbPath: string): void {
  const root = dirname(dbPath);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
