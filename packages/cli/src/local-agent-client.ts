import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { AgentConfigStore, AgentRuntime, EvolutionConfigView, InvocationSurface, ShellApprovalMode, ReasoningEffort, JsonObject, RefinementDecisionInput, RefinementDecisionResult, RefinementRequestView, StagedSkillResult } from '@kinu.run/core';
import type { WorkspaceInfo } from '@kinu.run/cli-backend';
import { applyWorkspaceTitle, persistAutoTitle, canonicalConversationId, getEvolutionConfig, initAgentConfigTable, readLatestSearchTree, setEvolutionConfig, BACKGROUND_POLICY, decodeJsonValue, usageReported, renderToolResult, type GepaOptimizationResult } from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import {
  DriverLeaseHold,
  OS_LEASE_PROCESS,
  makeExecRaw,
  makeSql,
  LOCAL_MAX_INLINE_ATTACHMENT_BYTES,
  LocalAgentSession,
  openWorkspaceCLI,
  type CLIRuntime,
  type LocalModelResolver,
  type McpServerConfig,
  type LocalAgentSessionOpts,
  type SessionEvent,
} from '@kinu.run/cli-backend';
import {
  CONFIG_PATH,
  agentDbPath,
  createCodexAuthStore,
  loadConfigFile,
  readProviderRevision,
  resolveMcpServers,
  resolveProviderCredentials,
} from './config';
import {
  renameLocalAgent,
  suggestAgentIdentityFromMission,
  type SuggestAgentIdentityOptions,
} from './agent-create';
import { createConfiguredLocalModelResolver } from './local-model-resolver';
import { createProfileAuthorityReader } from './profiles';
import {
  createCliSession,
  readCliSessionTranscript,
  transcriptMessages,
  type CliSession,
  type CliSessionOptions,
} from './session';
import { SessionRecorder } from './session-recorder';
import { normalizeModelMenu, type AgentModelMenu } from '@kinu.run/core';
import {
  findForkPivot,
  promptFiles,
  promptText,
} from './agent-client';
import { asRecord } from './options';
import type {
  AgentChangelogView,
  AgentRefinementView,
  AgentClient,
  AgentClientEvent,
  AgentClientSendOptions,
  AgentClientStatus,
  AgentForkResult,
  AgentPrompt,
  AgentJobSummary,
  AgentSearchNode,
  AgentToolSurface,
  AgentTranscriptMessage,
  AgentSendResult,
  AgentTurnResult,
  FileCheckpointSurface,
  ForkPoint,
  LocalSessionControls,
  PlanReviewSurface,
} from './agent-client';

export interface LocalAgentClientOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
  /** One task turn, then exit — see LocalAgentClientDeps.oneShot. */
  oneShot?: boolean;
  /** Recorder controls for this process's diagnostic transcript. */
  transcript?: CliSessionOptions;
  /** Which invocation surface drives background policy. Default:
   *  'interactive'. */
  surface?: InvocationSurface;
  /** Canonical directory the workspace file and shell tools bind to — the
   *  placement recorded on the agent's ref, shared by its peers. Absent leaves
   *  the runtime on its own in-database plane. */
  cwd?: string;
}

/** Open a local agent database and wrap its LocalAgentSession as an AgentClient. */
export async function openLocalAgentClient(name: string, opts: LocalAgentClientOptions = {}): Promise<LocalAgentClient> {
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) {
    throw new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`);
  }

  const { llmConfig, resolver } = createConfiguredLocalModelResolver({ ...opts, agentName: name });
  const providerCredentials = resolveProviderCredentials();
  const codexAuthStore = createCodexAuthStore();
  const db = new Database(dbPath);

  const openConfig = {
    llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH,
    checkpointKeep: loadConfigFile().checkpointKeep,
    cwd: opts.cwd,
  };

  const { rt, info } = await openWorkspaceCLI(db, dbPath, openConfig);

  const client = new LocalAgentClient({
    agentName: name,
    rt,
    db,
    dbPath,
    info,
    refreshInfo: async () => (await openWorkspaceCLI(db, dbPath, openConfig)).info,
    modelResolver: resolver,
    mcpServers: resolveMcpServers(),
    noAutoEvolve: opts.noAutoEvolve ?? false,
    transcript: opts.transcript ?? {},
    naming: opts,
    surface: opts.surface ?? 'interactive',
  });

  return client;
}

/**
 * Run one GEPA optimisation pass over a local workspace's scaffold.
 *
 * The pass itself is core's evolution control plane — the same one the cloud
 * backend drives, which is what makes it reachable from a local workspace at
 * all instead of only through a Durable Object.
 */
export async function runLocalGepa(
  name: string,
  opts?: { maxIterations?: number; evalSize?: number; maxMetricCalls?: number },
): Promise<GepaOptimizationResult> {
  // One-shot surface: the pass is the whole job, and auto-evolution must not
  // race the candidate it is measuring.
  const client = await openLocalAgentClient(name, { surface: 'one-shot', noAutoEvolve: true });

  try {
    return await client.runScaffoldGepaOptimization(opts);
  } finally {
    await client.close();
  }
}

/**
 * Automatic titling for a local agent from its first owner message
 * (`applyWorkspaceTitle`).
 *
 * It runs when the owner speaks to an agent that has no title at all — one
 * they added to a virtual workspace without naming it. Its mission is the
 * workspace's, shared with every peer, so naming it from that would give the
 * whole group one name; what distinguishes it is what the owner brings to it.
 *
 * The persistent client owns the operation and settles it before closing the
 * workspace database. A failure stays visible to that owner; this operation
 * deliberately does not detach or reinterpret it.
 */
export async function autoTitleLocalWorkspace(
  name: string,
  rt: AgentRuntime,
  source: { mission: string },
  opts: SuggestAgentIdentityOptions,
): Promise<void> {
  initAgentConfigTable(rt.storage.execRaw);
  const config = rt.actor.config;
  await applyWorkspaceTitle({
    slug: name,
    displayName: config.getDisplayName(),
    nameOrigin: config.getNameOrigin(),
    mission: source.mission,
  }, {
    persist: (title, origin) => persistAutoTitle(config, title, origin),
    suggest: async (text) => (await suggestAgentIdentityFromMission(text, opts)).displayName,
  });
}

export interface LocalAgentClientDeps {
  agentName: string;
  /** `CLIRuntime`, not `AgentRuntime`: the session installs itself as this
   *  runtime's model-call ledger, and typing the field down to `AgentRuntime`
   *  would hide the channel the non-turn spend rows travel on. */
  rt: CLIRuntime;
  db: Database;
  dbPath: string;
  info: WorkspaceInfo;
  refreshInfo: () => Promise<WorkspaceInfo>;
  /** The static-model fallback for sessions built without a resolver — the
   *  interactive client always wires a resolver, so this stays undefined. */
  model?: LanguageModel;
  modelResolver: LocalModelResolver;
  /** Override only at composition/test boundaries. Production reads the one
   *  profile authority through createProfileAuthorityReader(). */
  profileAuthority?: LocalAgentSessionOpts['profileAuthority'];
  mcpServers: Record<string, McpServerConfig>;
  noAutoEvolve: boolean;
  transcript: CliSessionOptions;
  /** How to reach the naming model, for the first-message title of an agent
   *  that was added without one. */
  naming: SuggestAgentIdentityOptions;
  /** Which surface this process is. 'one-shot' (`kinu exec`/`shell`) both
   *  selects the background detach/grace policy AND decides turn continuity
   *  for the outcome ledger, keeping the cadence-heavy evolution pass off the
   *  exit path. One fact, one field. */
  surface: InvocationSurface;
}

/** One send awaiting its landing, under the id it went to the session by. */
interface PendingLocalTurn {
  /** The message's row for the CLI transcript, appended when the turn that
   *  runs it opens — or, marked steered, when the running turn read it. */
  readonly entry: JsonObject;
  /** Null until the turn's own `turn-end` arrives — see `unfinishedTurn`. */
  result: AgentTurnResult | null;
}

interface AutoTitleOperation {
  readonly controller: AbortController;
  promise: Promise<void> | null;
}

/**
 * What a turn that never reported an end is worth.
 *
 * `send()` resolves when the pump lets go of the queued item, which it also
 * does when the turn died in a way that produced no `turn-end` at all. Seeding
 * the pending turn with a zeroed SUCCESS made that indistinguishable from a
 * clean empty answer, and `kinu exec` exited 0 on a turn that never ran —
 * the one thing a CI consumer cannot recover from.
 *
 * The turn lifecycle itself is now total (LocalAgentSession.processTurn), so
 * nothing in this process can reach this state; it is kept because the exit
 * code has to stay honest for causes that are NOT in this process, and because
 * "no completion" must never again be spelled the same way as "completed with
 * nothing to say".
 */
function unfinishedTurn(): AgentTurnResult {
  return { text: '', toolCalls: [], steps: 0, durationMs: 0, hadError: true };
}

export class LocalAgentClient implements AgentClient {
  readonly mode = 'local' as const;
  readonly agentName: string;
  readonly consents = null;
  readonly localControls: LocalSessionControls;
  readonly checkpoints: FileCheckpointSurface;
  readonly plans: PlanReviewSurface;
  private readonly deps: LocalAgentClientDeps;
  readonly inlineAttachmentLimitBytes = LOCAL_MAX_INLINE_ATTACHMENT_BYTES;
  readonly rename = async (displayName: string) => renameLocalAgent(this.agentName, displayName);

  /** Workspace-level actor_config, read straight off the same database the
   *  session uses. Config outlives the session, so a walk-back fork's session
   *  swap does not invalidate this. */
  private readonly config: AgentConfigStore;
  /** Product state: the one durable conversation this workspace keeps.
   *  JSONL transcripts are diagnostics/export artifacts and carry this id so
   *  an export can be tied back to the conversation it recorded. */
  private readonly canonicalConversation: string;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private session: LocalAgentSession;
  private activeCliSession: CliSession;
  /** The sends whose landing is awaited, by the id each went under. The turn
   *  that opens under that id answers the send: the turn an idle send starts,
   *  or the rerun of words a running turn ended before reading. A send the
   *  running turn read leaves here at that landing. */
  private readonly awaiting = new Map<string, PendingLocalTurn>();
  /** The awaited sends whose turn is open now — one, or every leftover a
   *  rerun carried — each filled at its `turn-end`. */
  private live: readonly PendingLocalTurn[] = [];
  private closed = false;
  /** The one title operation may outlive opening or a turn, but never the
   * workspace database. Its owning client joins it during close. */
  private autoTitleTask: AutoTitleOperation | null = null;
  private readonly recorder = new SessionRecorder('local');
  /**
   * This process's claim on the one durable conversation in that database.
   *
   * Held for the CLIENT's lifetime rather than per turn, and that is the point:
   * `kinu chat`, `shell` and the TUI all auto-start the resident scheduler daemon,
   * so the daemon and this process are BOTH live over one SQLite file. They
   * drive the same durable work — the pending event drain, the trigger
   * registry, the queued-turn pump — and `EventLog.markConsumed` has no
   * compare-and-set predicate, so two drivers bind the same rows and one
   * external event becomes two turns.
   *
   * `interactive`, so it takes the conversation from a live daemon: a person
   * waiting at a prompt outranks background maintenance. It survives a
   * walk-back fork, which replaces the session but not the database.
   */
  private readonly driverLease: DriverLeaseHold;

  constructor(deps: LocalAgentClientDeps) {
    this.deps = deps;
    this.agentName = deps.agentName;
    initAgentConfigTable(deps.rt.storage.execRaw);
    this.config = deps.rt.actor.config;
    this.canonicalConversation = canonicalConversationId(this.config);
    // Every artifact records which durable conversation it observed, so a
    // diagnostic export stays interpretable outside the workspace database.
    this.activeCliSession = createCliSession(deps.agentName, {
      ...deps.transcript,
      conversationId: deps.transcript.conversationId ?? this.canonicalConversation,
    });
    // Built BEFORE the session, because createAgentSession installs it as the
    // session's driver gate.
    this.driverLease = new DriverLeaseHold(
      { sql: makeSql(deps.db), execRaw: makeExecRaw(deps.db), proc: OS_LEASE_PROCESS },
      'interactive',
    );
    this.session = this.createAgentSession();
    this.localControls = {
      getAlwaysActiveSkills: () => this.session.getAlwaysActiveSkills(),
      setAlwaysActiveSkills: (names) => this.session.setAlwaysActiveSkills(names),
      getShellApprovalMode: () => this.session.getShellApprovalMode().mode,
      setShellApprovalMode: (mode: ShellApprovalMode) => this.session.setShellApprovalMode(mode).mode,
      setShellApprovalHandler: (handler) => this.session.setShellApprovalHandler(handler),
      listDeferredApprovals: () => this.session.listDeferredApprovals(),
      decideDeferredApprovals: (ids, decision) => this.session.decideDeferredApprovals(ids, decision),
      listInstructionApprovals: (request) => this.session.listInstructionApprovals(request),
      readInstructionApproval: (path) => this.session.readInstructionApproval(path),
      approveInstruction: (path, digest) => this.session.approveInstruction(path, digest),
      revokeInstruction: (path) => this.session.revokeInstruction(path),
      listModelProviders: async () => (await this.session.listModelProviders()).map((provider) => ({
        id: provider.id,
        available: provider.available,
        unavailableReason: provider.unavailableReason,
      })),
    };
    // Closures read this.session so the surface survives walk-back forks.
    this.checkpoints = {
      list: (limit, turnId) => this.session.listFileCheckpoints(limit, turnId),
      plan: (dir, id) => this.session.planFileRestore(dir, id),
      restore: (dir, id) => this.session.restoreFileCheckpoint(dir, id),
    };
    // Same closure rule, and the same three actions the cloud RPCs expose.
    this.plans = {
      active: () => this.session.getActivePlanReview(),
      saveAnnotations: (id, revision, annotations) => this.session.savePlanReviewAnnotations(id, revision, annotations),
      decide: (id, revision, decision, feedback) => this.session.decidePlanReview(id, revision, decision, feedback),
    };
  }

  /** Start one title operation and retain its settlement on this client. */
  startAutoTitle(source: { mission: string }): void {
    if (this.closed || this.autoTitleTask !== null) return;

    const owner: AutoTitleOperation = {
      controller: new AbortController(),
      promise: null,
    };

    this.autoTitleTask = owner;
    owner.promise = (async () => {
      // The rejection leaves the handler as a value rather than being judged
      // inside it: what a failure here MEANS is a fact about this client — only
      // `close()` aborts this controller — and not a fact about the error.
      let failure: { readonly cause: unknown } | undefined;

      try {
        await autoTitleLocalWorkspace(this.agentName, this.deps.rt, source, {
          ...this.deps.naming,
          signal: owner.controller.signal,
        });
      } catch (cause) {
        failure = { cause };
      } finally {
        if (this.autoTitleTask === owner) this.autoTitleTask = null;
      }

      // `close()` aborts this controller and the abort reason travels as the
      // rejection, so a failure standing here after it is the cancellation the
      // caller asked for. Filed as `title_save_failed` it would report the
      // owner's own exit as an io fault against a save never allowed to finish.
      if (failure !== undefined && !owner.controller.signal.aborted) {
        diagnostics.failure(
          'workspace.title_save_failed',
          toKinuError({
            doing: 'saving the workspace title', cause: failure.cause, otherwise: 'io',
          }),
          { workspace: this.agentName },
        );
      }
    })();
  }

  get cliSession(): CliSession {
    return this.activeCliSession;
  }

  /**
   * Become this conversation's driver, then bring up MCP.
   *
   * The lease comes first because it has to be held before ANY pump: every
   * driving surface calls this before its first `send`, and a client that drove
   * without it would interleave with the daemon it just auto-started. Refusing
   * here rather than at the first message is the honest order — the person
   * learns the conversation is taken before they type into it.
   */
  async connect(): Promise<void> {
    const refusal = this.driverLease.acquire();

    if (refusal) {
      throw new KinuError(
        refusal.refused.reason,
        `${refusal.refused.error}. Close that session, or continue the conversation there.`,
      );
    }

    if (Object.keys(this.deps.mcpServers).length > 0) {
      await this.session.connectMcp(this.deps.mcpServers);
    }
  }

  subscribe(listener: (event: AgentClientEvent) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  async send(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): Promise<AgentSendResult> {
    const text = promptText(prompt);
    const files = promptFiles(prompt);
    const payload = files.length > 0 ? { text, files } : text;

    // The JSONL log records attachment names, never the data-URL payloads.
    const sessionEntry: JsonObject = {
      text,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'local',
    };

    if (files.length > 0) sessionEntry.attachments = files.map((file) => file.filename);

    // The session decides where the words go — the running turn's next step,
    // or a turn of their own, at once or as the rerun of what that turn ended
    // before reading — and answers once it is decided. The id minted here is
    // the id that turn opens under, which is how its result is this send's.
    const id = crypto.randomUUID();
    const pending: PendingLocalTurn = { entry: sessionEntry, result: null };
    const first = this.awaiting.size === 0;
    this.awaiting.set(id, pending);

    try {
      const landed = await this.session.send(payload, { tier: opts.tier, id, mode: opts.mode });

      if (landed === 'mid-turn') {
        this.activeCliSession.append('user', { ...sessionEntry, steered: true });

        return { landed };
      }

      // An agent the owner added without naming has no title yet. What the
      // owner brings to it is the only thing that distinguishes it from the
      // peers it shares a mission with, so that is what names it — once, since
      // persisting marks `name_origin` and the shared policy stops matching.
      if (first) this.startAutoTitle({ mission: text });

      return { landed, ...(pending.result ?? unfinishedTurn()) };
    } finally {
      this.awaiting.delete(id);
      this.live = this.live.filter((open) => open !== pending);
    }
  }

  /** Steer-as-Branch: the in-process session runs the redirect as one
   *  budgeted head against the live turn's input history (text-only — the
   *  head task is a string). */
  branch(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): boolean {
    const text = promptText(prompt);

    if (!this.session.branch(text)) return false;
    this.activeCliSession.append('user', {
      text,
      branched: true,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'local',
    });

    return true;
  }

  /** Walk-back: the conversation continues from before the picked user
   *  message, on the context the actor held there. A fresh transcript
   *  artifact takes the entries recorded after the walk-back. */
  async fork(point: ForkPoint): Promise<AgentForkResult> {
    if (this.awaiting.size > 0) throw new Error('Cannot fork while a turn is running.');
    const transcript = this.deps.rt.stores.history.transcript(this.canonicalConversation);
    const rows: Array<{ id: string; role: string; content: string }> = [];

    for (const entry of transcript.ancestry()) {
      if (entry.role !== 'user' && entry.role !== 'assistant') continue;
      const projected = await transcript.project(entry.id);

      if (projected !== null) rows.push({ id: entry.id, role: entry.role, content: projected.content });
    }

    const pivotRow = rows[findForkPivot(rows, point)];

    if (pivotRow === undefined) throw new Error('Could not locate that message in the durable conversation.');
    await this.session.revertConversation(pivotRow.id);
    await this.session.end();
    this.activeCliSession = createCliSession(this.agentName, {
      ...this.deps.transcript,
      conversationId: this.canonicalConversation,
    });
    this.session = this.createAgentSession();
    await this.connect();

    return { client: this, label: `branch ${this.activeCliSession.id}` };
  }

  stop(): string[] {
    return this.session.interrupt();
  }

  /** Run everything the task turn left queued — detached jobs' wake turns, the
   *  one-shot completion gate's confirming turn — to completion, streaming
   *  through the live subscription, before the caller closes. No-op once
   *  closed. */
  async settleBackgroundWork(): Promise<void> {
    if (this.closed) return;
    await this.session.settleBackgroundWork();
  }

  /** One GEPA optimisation pass over this workspace's scaffold (core's
   *  evolution control plane, over this session's local surface). */
  runScaffoldGepaOptimization(
    opts?: { maxIterations?: number; evalSize?: number; maxMetricCalls?: number },
  ): Promise<GepaOptimizationResult> {
    return this.session.runScaffoldGepaOptimization(opts);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const autoTitleTask = this.autoTitleTask;
    autoTitleTask?.controller.abort(new Error('the client is closing'));

    try {
      if (autoTitleTask?.promise) await autoTitleTask.promise;
      await this.session.end();
    } finally {
      // Released BEFORE the handle closes, and even when settling threw: an
      // interactive lease is held for the whole session, so this is the moment
      // the daemon becomes able to drive this conversation again. Skipping it
      // would leave the row naming a process that has exited, recoverable only
      // by the next driver's liveness check — slower, and less obvious.
      this.driverLease.release();
      // The handle goes back even when settling failed, or the next open finds the file locked.
      this.deps.db.close();
    }
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    if (this.activeCliSession.mode !== 'record') return [];
    const transcript = readCliSessionTranscript(this.agentName, this.activeCliSession.id, this.deps.transcript);

    return transcriptMessages(transcript.entries);
  }

  async status(): Promise<AgentClientStatus> {
    const info = await this.deps.refreshInfo();

    return {
      name: info.name,
      purpose: info.purpose,
      model: this.session.getEffectiveModelSpec(),
      reasoningEffort: this.session.getReasoningEffort().effort,
      roleId: this.session.getActiveRoleId(),
      tierId: this.session.getEffectiveTierId(),
      scaffoldVersion: info.scaffoldVersion,
      searchNodeCount: info.searchNodeCount,
      craftedToolCount: info.craftedToolCount,
      taskCount: info.taskCount,
      memorySize: info.memorySize,
      dbSize: statSync(this.deps.dbPath).size,
      toolCount: this.session.toolNames().length,
      autoEvolve: !this.deps.noAutoEvolve,
    };
  }

  async describeTools(): Promise<AgentToolSurface> {
    return {
      builtIn: this.session.describeTools(),
      crafted: this.deps.rt.craftStore.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    };
  }

  async changelog(limit?: number): Promise<AgentChangelogView> {
    const view = this.session.getEvolutionChangelog(limit);
    this.session.markChangelogSeen();

    return { entries: view.entries, unseenCount: view.unseenCount };
  }

  async revertChangelogEntry(id: string) {
    return this.session.revertChangelogEntry(id);
  }

  async refinements(limit?: number): Promise<AgentRefinementView> {
    return this.session.listRefinements(limit);
  }

  async requestRefinement(opts?: { turnIds?: readonly string[] }): Promise<RefinementRequestView> {
    return this.session.requestRefinement(opts);
  }

  async decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult> {
    return this.session.decideRefinement(input);
  }

  async showRefinement(requestId: string, routeIndex: number): Promise<StagedSkillResult> {
    return this.session.showRefinement(requestId, routeIndex);
  }

  async latestTakes() {
    return this.session.latestAlternateTakes();
  }

  async pickTake(takeId: string, nodeId: string) {
    return this.session.pickAlternateTake(takeId, nodeId);
  }

  async setRole(roleId: string): Promise<{ role: string }> {
    return this.session.setRole(roleId);
  }

  async readMemory(): Promise<string> {
    return await this.deps.rt.memory.read('memory/MEMORY.md') ?? '';
  }

  async searchNodes(): Promise<AgentSearchNode[]> {
    // The latest search only — the same projection the cloud getMctsTree serves.
    const nodes = readLatestSearchTree(this.deps.rt.storage.sql, this.deps.rt.actor);

    return nodes.map((node) => ({
      depth: node.depth,
      status: node.status,
      value: node.value,
      visits: node.visits,
      action: node.action,
    }));
  }

  async listJobs(limit = 20): Promise<AgentJobSummary[]> {
    const jobs = await this.session.listBackgroundJobs(limit);

    return jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status }));
  }

  async getModelSpec(): Promise<string | null> {
    return this.session.getEffectiveModelSpec();
  }

  async setModel(spec: string): Promise<{ spec: string }> {
    return { spec: this.session.setModel(spec).spec };
  }

  async getReasoningEffort(): Promise<ReasoningEffort | null> {
    return this.session.getReasoningEffort().effort;
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }> {
    return { effort: this.session.setReasoningEffort(effort).effort };
  }

  async getEvolutionConfig(): Promise<EvolutionConfigView> {
    return getEvolutionConfig(this.config);
  }

  async setEvolutionConfig(view: Partial<EvolutionConfigView>): Promise<EvolutionConfigView> {
    return setEvolutionConfig(this.config, view);
  }

  async listModels(): Promise<AgentModelMenu> {
    return normalizeModelMenu({ payload: await this.session.listAvailableModels() });
  }

  private createAgentSession(): LocalAgentSession {
    const options: LocalAgentSessionOpts = {
      rt: this.deps.rt,
      db: this.deps.db,
      model: this.deps.model,
      modelResolver: this.deps.modelResolver,
      noAutoEvolve: this.deps.noAutoEvolve,
      backgroundPolicy: BACKGROUND_POLICY[this.deps.surface],
      oneShot: this.deps.surface === 'one-shot',
      onEvent: (event) => this.handleSessionEvent(event),
      // The same reader the daemon hands its hosted agents, so one agent
      // resolves one catalog whichever process drives it. Read per turn, not
      // captured: `/model` and `/effort` write the authority, and the turn
      // after one runs under what it wrote.
      profileAuthority: this.deps.profileAuthority ?? createProfileAuthorityReader(),
      // Same reason, other file: a chat session that stays open for hours must
      // see a provider connected in another process on its next turn.
      providerRevision: readProviderRevision,
    };

    const session = new LocalAgentSession(options);
    // The lease RE-CHECKED at every turn boundary, not trusted from connect():
    // preemption means a lease can be lost between turns, and a session that
    // kept driving after losing it is the interleaving this exists to prevent.
    // Installed on every session, including the one a walk-back fork builds.
    session.setDriverGate(() => this.driverLease.acquire()?.refused ?? null);

    return session;
  }

  private handleSessionEvent(event: SessionEvent): void {
    const mapped = mapSessionEvent(event);

    if (!mapped) return;

    if (event.type === 'turn-start') {
      // The turn under an awaited send's id is that send's turn, and so is
      // one it carried: each row goes into the CLI transcript ahead of the
      // turn's events, and its end is each send's result. Any other turn — a
      // wake, a delegation — is nobody's.
      this.live = [event.turnId, ...event.carried].flatMap((id) => this.awaiting.get(id) ?? []);

      for (const pending of this.live) this.activeCliSession.append('user', pending.entry);
    }

    if (mapped.type === 'turn-end') for (const pending of this.live) pending.result = mapped.turn;
    this.emit(mapped);
  }

  private emit(event: AgentClientEvent): void {
    this.recorder.record(this.activeCliSession, event);

    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function mapSessionEvent(event: SessionEvent): AgentClientEvent | null {
  switch (event.type) {
    case 'turn-start':
      return { type: 'turn-start', kind: event.kind, text: event.text, event: event.event };
    case 'text-delta':
      return { type: 'text-delta', delta: event.delta };
    case 'tool-call':
      return { type: 'tool-call', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
    case 'tool-result':
      return event;
    case 'turn-end':
      const turn: AgentTurnResult = {
        text: event.turn.assistantResponse,
        steps: event.turn.steps,
        durationMs: event.turn.durationMs,
        hadError: event.turn.hadError,
        toolCalls: event.turn.toolCalls.map((call) => ({
          name: call.name,
          args: asRecord({ value: decodeJsonValue({ value: call.args }) }, 'input'),
          result: call.result === undefined ? undefined : renderToolResult(call.result),
          outcome: call.outcome,
        })),
      };

      // An all-absent report is an object, and a truthy one — gate on the
      // contract's own predicate so a turn nobody metered does not travel
      // looking like a measurement.
      if (event.turn.usage && usageReported(event.turn.usage)) turn.usage = event.turn.usage;

      return {
        type: 'turn-end',
        turn,
      };
    case 'evolution':
      return { type: 'evolution', event: event.event, message: event.message };
    case 'background':
      return { type: 'background', event: event.event, message: event.message };
    case 'broadcast':
      return { type: 'broadcast', event: event.event };
    case 'run-event':
      return { type: 'run-event', event: event.event };
    case 'error':
      return { type: 'error', message: event.message };
    // The walk-back's redraw is for a surface that keeps the conversation on
    // screen. This client rebuilds the session around the reverted head
    // ({@link fork}) and prints the transcript from the store after it, so
    // there is nothing here to redraw.
    case 'history-reverted':
      return null;
  }
}
