import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { AgentConfigStore, AgentRuntime, EvolutionConfigView, InvocationSurface, ShellApprovalMode, ReasoningEffort, JsonObject, RefinementDecisionInput, RefinementDecisionResult, RefinementRequestView, StagedSkillResult, SubordinateInspectionRequest, SubordinateInspectionResult } from '@kinu.run/core';
import type { WorkspaceInfo } from '@kinu.run/cli-backend';
import { applyWorkspaceTitle, getChatHistoryPage, persistAutoTitle, canonicalConversationId, getEvolutionConfig, initAgentConfigTable, readLatestSearchTree, setEvolutionConfig, BACKGROUND_POLICY, REAL_CLOCK, decodeJsonValue, usageReported, renderToolResult, type GepaOptimizationResult } from '@kinu.run/core';
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
import { inspectLocalSubordinate } from './local-inspection';
import { createConfiguredLocalModelResolver } from './local-model-resolver';
import { createProfileAuthorityReader } from './profiles';
import {
  createCliSession,
  type CliSession,
  type CliSessionOptions,
} from './session';
import { SessionRecorder } from './session-recorder';
import { normalizeModelMenu, type AgentModelMenu } from '@kinu.run/core';
import {
  findForkPivot,
  readConversation,
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
  transcript?: CliSessionOptions;
  surface?: InvocationSurface;
  /** The ref's recorded placement, shared by peers. Absent leaves the runtime on its in-database plane. */
  cwd?: string;
}

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

/** Core's evolution control plane, the same one the cloud backend drives. */
export async function runLocalGepa(
  name: string,
  opts?: { maxIterations?: number; evalSize?: number; maxMetricCalls?: number },
): Promise<GepaOptimizationResult> {
  // Auto-evolution must not race the candidate being measured.
  const client = await openLocalAgentClient(name, { surface: 'one-shot', noAutoEvolve: true });

  try {
    return await client.runScaffoldGepaOptimization(opts);
  } finally {
    await client.close();
  }
}

/** Titles an untitled agent from its first owner message: its mission is shared with every peer, so the
 * owner's words are what distinguish it. The client settles the operation before closing the database. */
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
    persist: (title) => persistAutoTitle(config, title),
    suggest: async (text) => (await suggestAgentIdentityFromMission(text, opts)).displayName,
  });
}

export interface LocalAgentClientDeps {
  agentName: string;
  /** The session installs itself as this runtime's model-call ledger; `AgentRuntime` would hide that channel. */
  rt: CLIRuntime;
  db: Database;
  dbPath: string;
  info: WorkspaceInfo;
  refreshInfo: () => Promise<WorkspaceInfo>;
  /** Unset for the interactive client, which always wires a resolver. */
  model?: LanguageModel;
  modelResolver: LocalModelResolver;
  /** Override only at composition/test boundaries. */
  profileAuthority?: LocalAgentSessionOpts['profileAuthority'];
  mcpServers: Record<string, McpServerConfig>;
  noAutoEvolve: boolean;
  transcript: CliSessionOptions;
  naming: SuggestAgentIdentityOptions;
  /** 'one-shot' selects the background detach policy and marks turn continuity for the outcome ledger. */
  surface: InvocationSurface;
}

interface PendingLocalTurn {
  /** Appended when the running turn opens, or marked steered when the running turn read it. */
  readonly entry: JsonObject;
  /** Null until the turn's own `turn-end` arrives; see `unfinishedTurn`. */
  result: AgentTurnResult | null;
}

interface AutoTitleOperation {
  readonly controller: AbortController;
  promise: Promise<void> | null;
}

/** A turn that never reported an end must not read as a clean empty success, or `kinu exec` exits 0 on a turn
 * that never ran. */
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

  /** Outlives the session, so a walk-back fork does not invalidate it. */
  private readonly config: AgentConfigStore;
  /** JSONL transcripts carry this id so an export ties back to its conversation. */
  private readonly canonicalConversation: string;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private session: LocalAgentSession;
  private activeCliSession: CliSession;
  /** The turn opening under a send's id answers it; a send the running turn read leaves at that landing. */
  private readonly awaiting = new Map<string, PendingLocalTurn>();
  private live: readonly PendingLocalTurn[] = [];
  private closed = false;
  /** May outlive opening or a turn, never the workspace database; close() joins it. */
  private autoTitleTask: AutoTitleOperation | null = null;
  private readonly recorder = new SessionRecorder('local');
  /**
     * Held for the client's lifetime: the auto-started daemon drives the same durable work over one SQLite file and
     * `EventLog.markConsumed` has no compare-and-set, so two drivers turn one event into two turns. Interactive, so
     * it takes the conversation from the daemon. Survives walk-back forks.
     */
  private readonly driverLease: DriverLeaseHold;

  constructor(deps: LocalAgentClientDeps) {
    this.deps = deps;
    this.agentName = deps.agentName;
    initAgentConfigTable(deps.rt.storage.execRaw);
    this.config = deps.rt.actor.config;
    this.canonicalConversation = canonicalConversationId(this.config);
    this.activeCliSession = createCliSession(deps.agentName, {
      ...deps.transcript,
      conversationId: deps.transcript.conversationId ?? this.canonicalConversation,
    });
    // Before the session: createAgentSession installs it as the driver gate.
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
    this.plans = {
      active: () => this.session.getActivePlanReview(),
      saveAnnotations: (id, revision, annotations) => this.session.savePlanReviewAnnotations(id, revision, annotations),
      decide: (id, revision, decision, feedback) => this.session.decidePlanReview(id, revision, decision, feedback),
    };
  }

  startAutoTitle(source: { mission: string }): void {
    if (this.closed || this.autoTitleTask !== null) return;

    const owner: AutoTitleOperation = {
      controller: new AbortController(),
      promise: null,
    };

    this.autoTitleTask = owner;
    owner.promise = (async () => {
      // Only `close()` aborts this controller, so a failure after the abort is the requested cancellation, not a
      // `title_save_failed` io fault.
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

  /** The lease is taken before any pump, so the person learns the conversation is taken before typing. */
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

    // The session decides where the words land; the minted id is the id that turn opens under.
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

      // Names the agent once: persisting marks `name_origin` and the shared policy stops matching.
      if (first) this.startAutoTitle({ mission: text });

      return { landed, ...(pending.result ?? unfinishedTurn()) };
    } finally {
      this.awaiting.delete(id);
      this.live = this.live.filter((open) => open !== pending);
    }
  }

  /** Text-only: the head task is a string. */
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

  /** A fresh transcript artifact takes the entries recorded after the walk-back. */
  async fork(point: ForkPoint): Promise<AgentForkResult> {
    if (this.awaiting.size > 0) throw new Error('Cannot fork while a turn is running.');
    const rows = await this.history();
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

  /** Runs queued wake turns and the one-shot completion gate before the caller closes. */
  async settleBackgroundWork(): Promise<void> {
    if (this.closed) return;
    await this.session.settleBackgroundWork();
  }

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
      // Released before the handle closes, even when settling threw, so the daemon can drive again at once.
      this.driverLease.release();
      // The handle goes back even when settling failed, or the next open finds the file locked.
      this.deps.db.close();
    }
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    const transcript = this.deps.rt.stores.history.transcript(this.canonicalConversation);

    return readConversation((request) => getChatHistoryPage(transcript, request));
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

  async inspectSubordinate(request: SubordinateInspectionRequest): Promise<SubordinateInspectionResult> {
    return inspectLocalSubordinate(this.agentName, request);
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
      clock: REAL_CLOCK,
      // The daemon's reader, read per turn: `/model` and `/effort` write the authority.
      profileAuthority: this.deps.profileAuthority ?? createProfileAuthorityReader(),
      // A long-open session must see a provider connected in another process.
      providerRevision: readProviderRevision,
    };

    const session = new LocalAgentSession(options);
    // Re-checked every turn boundary: preemption can take the lease between turns. Installed on forked sessions too.
    session.setDriverGate(() => this.driverLease.acquire()?.refused ?? null);

    return session;
  }

  private handleSessionEvent(event: SessionEvent): void {
    const mapped = mapSessionEvent(event);

    if (!mapped) return;

    if (event.type === 'turn-start') {
      // Turns under an awaited send's id (or carried by it) belong to that send; wakes and delegations to nobody.
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

      // An all-absent report is truthy; gate on `usageReported` so an unmetered turn does not look measured.
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
    // This client rebuilds the session on fork and reprints from the store; nothing to redraw.
    case 'history-reverted':
      return null;
  }
}
