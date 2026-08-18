import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { AgentRuntime, SessionSurface, ShellApprovalMode, ReasoningEffort, JsonObject } from '@proteus/core';
import type { WorkspaceInfo } from '@proteus/core/identity';
import { applyWorkspaceTitle, createAgentConfigStore, initAgentConfigTable, readLatestSearchTree, BACKGROUND_POLICY, decodeJsonValue, usageReported, type GepaOptimizationResult } from '@proteus/core';
import { diagnostics, toProteusError } from '@proteus/core/obs';
import {
  LOCAL_MAX_INLINE_ATTACHMENT_BYTES,
  LocalAgentSession,
  openWorkspaceCLI,
  resolveChatModel,
  type CLIRuntime,
  type LocalModelResolver,
  type McpServerConfig,
  type SessionEvent,
} from '@proteus/cli-backend';
import {
  CONFIG_PATH,
  agentDbPath,
  createCodexAuthStore,
  listConfiguredAgentRefs,
  loadConfigFile,
  resolveMcpServers,
  resolveProviderCredentials,
  upsertAgentConfig,
} from './config';
import { suggestAgentIdentityFromMission, type SuggestAgentIdentityOptions } from './agent-create';
import { createConfiguredLocalModelResolver } from './local-model-resolver';
import {
  createCliSession,
  defaultConversationIdForCliOptions,
  listCliSessions,
  readCliSessionTranscript,
  transcriptMessages,
  type CliSession,
  type CliSessionInfo,
  type CliSessionOptions,
} from './session';
import { SessionRecorder } from './session-recorder';
import { normalizeModelMenu, type AgentModelMenu } from './model-catalog';
import {
  findForkPivot,
  asRecord,
  promptFiles,
  promptText,
} from './agent-client';
import type {
  AgentChangelogView,
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
  AgentTurnResult,
  FileCheckpointSurface,
  ForkPoint,
  LocalSessionControls,
} from './agent-client';

export interface LocalAgentClientOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
  /** One task turn, then exit — see LocalAgentClientDeps.oneShot. */
  oneShot?: boolean;
  session?: CliSessionOptions;
  /** Who is driving — fixes the session's background policy. Default:
   *  'interactive'. */
  surface?: SessionSurface;
}

/** Open a local agent database and wrap its LocalAgentSession as an AgentClient. */
export async function openLocalAgentClient(name: string, opts: LocalAgentClientOptions = {}): Promise<LocalAgentClient> {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);
  }
  const { llmConfig, resolver } = createConfiguredLocalModelResolver({ ...opts, agentName: name });
  const providerCredentials = resolveProviderCredentials();
  const codexAuthStore = createCodexAuthStore();
  const db = new Database(dbPath);
  const openConfig = {
    llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH,
    checkpointKeep: loadConfigFile().checkpointKeep,
  };
  const { rt, info } = await openWorkspaceCLI(db, dbPath, openConfig);
  autoTitleLocalWorkspace(name, rt, info.purpose, opts);
  return new LocalAgentClient({
    agentName: name,
    rt,
    db,
    dbPath,
    info,
    refreshInfo: async () => (await openWorkspaceCLI(db, dbPath, openConfig)).info,
    model: resolveChatModel(llmConfig),
    modelResolver: resolver,
    mcpServers: resolveMcpServers(),
    noAutoEvolve: opts.noAutoEvolve ?? false,
    sessionOptions: opts.session ?? {},
    surface: opts.surface ?? 'interactive',
  });
}

/**
 * Run one GEPA optimisation pass over a local workspace's scaffold.
 *
 * The pass itself is core's evolution control plane — the same one the cloud
 * backend drives. It used to be a Durable Object method, so this was simply
 * not reachable from a local workspace at all.
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

/** Workspaces created before mission-derived titling still show their raw
 *  directory name. Title them from SOUL.md's mission on open, through the same
 *  identity path `proteus create` uses. The deterministic title lands before
 *  this returns; the model call runs in the background and never blocks the
 *  CLI, and failing it leaves the title that already landed. */
export function autoTitleLocalWorkspace(
  name: string,
  rt: AgentRuntime,
  mission: string,
  opts: SuggestAgentIdentityOptions,
): void {
  initAgentConfigTable(rt.storage.execRaw);
  const config = createAgentConfigStore(rt.storage.sql);
  void (async () => {
    try {
      await applyWorkspaceTitle({
        slug: name,
        displayName: config.getDisplayName(),
        nameOrigin: config.getNameOrigin(),
        mission,
      }, {
        persist: (title) => {
          config.setDisplayName(title);
          config.setNameOrigin('auto');
          const configured = listConfiguredAgentRefs()
            .find((agent) => agent.mode === 'local' && (agent.localName ?? agent.name) === name);
          upsertAgentConfig({ ...(configured ?? { name, mode: 'local', localName: name }), displayName: title });
        },
        suggest: async (text) => (await suggestAgentIdentityFromMission(text, opts)).displayName,
      });
    } catch (error) {
      // The naming model refusing, or our database/config.json refusing the write:
      // `applyWorkspaceTitle` absorbs neither, and the deterministic title has landed
      // by the time either can happen.
      diagnostics.failure(
        'workspace.title_save_failed',
        toProteusError({ doing: 'saving the workspace title', cause: error, otherwise: 'io' }),
        { workspace: name },
      );
    }
  })();
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
  model: ReturnType<typeof resolveChatModel>;
  modelResolver: LocalModelResolver;
  mcpServers: Record<string, McpServerConfig>;
  noAutoEvolve: boolean;
  sessionOptions: CliSessionOptions;
  /** Which surface this process is. 'one-shot' (`proteus exec`/`run`) both
   *  selects the background detach/grace policy AND decides turn continuity
   *  for the outcome ledger, keeping the cadence-heavy evolution pass off the
   *  exit path. One fact, one field. */
  surface: SessionSurface;
}

interface PendingLocalTurn {
  /** Null until the turn's own `turn-end` arrives — see `unfinishedTurn`. */
  result: AgentTurnResult | null;
}

/**
 * What a turn that never reported an end is worth.
 *
 * `send()` resolves when the pump lets go of the queued item, which it also
 * does when the turn died in a way that produced no `turn-end` at all. Seeding
 * the pending turn with a zeroed SUCCESS made that indistinguishable from a
 * clean empty answer, and `proteus exec` exited 0 on a turn that never ran —
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
  readonly inlineAttachmentLimitBytes = LOCAL_MAX_INLINE_ATTACHMENT_BYTES;

  private readonly deps: LocalAgentClientDeps;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private session: LocalAgentSession;
  private activeCliSession: CliSession;
  private pending: PendingLocalTurn | null = null;
  private closed = false;
  private readonly recorder = new SessionRecorder('local');

  constructor(deps: LocalAgentClientDeps) {
    this.deps = deps;
    this.agentName = deps.agentName;
    this.activeCliSession = createCliSession(deps.agentName, {
      ...deps.sessionOptions,
      conversationId: deps.sessionOptions.conversationId
        ?? defaultConversationIdForCliOptions(deps.sessionOptions),
    });
    this.session = this.createAgentSession(this.conversationIdForAgentSession());
    this.localControls = {
      getAlwaysActiveSkills: () => this.session.getAlwaysActiveSkills(),
      setAlwaysActiveSkills: (names) => this.session.setAlwaysActiveSkills(names),
      getShellApprovalMode: () => this.session.getShellApprovalMode().mode,
      setShellApprovalMode: (mode: ShellApprovalMode) => this.session.setShellApprovalMode(mode).mode,
      setShellApprovalHandler: (handler) => this.session.setShellApprovalHandler(handler),
      listModelProviders: async () => (await this.session.listModelProviders()).map((provider) => ({
        id: provider.id,
        available: provider.available,
        unavailableReason: provider.unavailableReason,
      })),
    };
    // Closures read this.session so the surface survives fork/resume swaps.
    this.checkpoints = {
      list: (limit, turnId) => this.session.listFileCheckpoints(limit, turnId),
      plan: (dir, id) => this.session.planFileRestore(dir, id),
      restore: (dir, id) => this.session.restoreFileCheckpoint(dir, id),
    };
  }

  get cliSession(): CliSession {
    return this.activeCliSession;
  }

  async connect(): Promise<void> {
    if (Object.keys(this.deps.mcpServers).length > 0) {
      await this.session.connectMcp(this.deps.mcpServers);
    }
    await this.session.recoverBackgroundJobs();
  }

  subscribe(listener: (event: AgentClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): Promise<AgentTurnResult> {
    if (this.pending) throw new Error('A turn is already in progress.');
    const text = promptText(prompt);
    const files = promptFiles(prompt);
    // The JSONL log records attachment names, never the data-URL payloads.
    const sessionEntry: JsonObject = {
      text,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'local',
    };
    if (files.length > 0) sessionEntry.attachments = files.map((file) => file.filename);
    this.activeCliSession.append('user', sessionEntry);
    const pending: PendingLocalTurn = { result: null };
    this.pending = pending;
    try {
      await this.session.send(files.length > 0 ? { text, files } : text);
      return pending.result ?? unfinishedTurn();
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  steer(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): boolean {
    const text = promptText(prompt);
    const files = promptFiles(prompt);
    const accepted = this.session.steer(files.length > 0 ? { text, files } : text);
    if (!accepted) return false;
    const sessionEntry: JsonObject = {
      text,
      steered: true,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'local',
    };
    if (files.length > 0) sessionEntry.attachments = files.map((file) => file.filename);
    this.activeCliSession.append('user', sessionEntry);
    return true;
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

  /** Walk-back fork: copy the durable conversation strictly before the picked
   *  user message into a fresh conversation, recorded as a forked CLI session
   *  (the existing --fork lineage), and re-point this client at it. */
  async fork(point: ForkPoint): Promise<AgentForkResult> {
    if (this.pending) throw new Error('Cannot fork while a turn is running.');
    if (this.activeCliSession.mode === 'none') {
      throw new Error('This chat is not recorded (--no-session), so there is no conversation to fork.');
    }
    const conversationId = this.conversationIdForAgentSession();
    const rows = this.deps.rt.storage.sql<{ id: string; parent_id: string | null; role: string; content: string; created_at: number }>`
      SELECT id, parent_id, role, content, created_at
      FROM messages
      WHERE session_id = ${conversationId} AND role IN ('user', 'assistant')
      ORDER BY created_at ASC, rowid ASC`;
    const pivot = findForkPivot(rows, point);
    if (pivot < 0) {
      throw new Error('Could not locate that message in the durable conversation; it may predate recording.');
    }

    const next = createCliSession(this.agentName, {
      ...this.deps.sessionOptions,
      fork: this.activeCliSession.id,
      session: undefined,
      continue: undefined,
      resume: undefined,
      conversationId: undefined,
    });
    // Copy rows before the pivot under fresh ids (id is the table PK), keeping
    // timestamps and remapping the parent chain.
    const idMap = new Map<string, string>();
    for (const row of rows.slice(0, pivot)) {
      const newId = crypto.randomUUID();
      idMap.set(row.id, newId);
      const parent = row.parent_id ? idMap.get(row.parent_id) ?? null : null;
      void this.deps.rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
                                    VALUES (${newId}, ${next.conversationId}, ${parent}, ${row.role}, ${row.content}, ${row.created_at})`;
    }

    await this.session.end();
    this.activeCliSession = next;
    this.session = this.createAgentSession(this.conversationIdForAgentSession());
    await this.connect();
    return { client: this, label: `session ${next.id}` };
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
    try {
      await this.session.end();
    } finally {
      // The handle goes back even when settling failed, or the next open finds the file locked.
      this.deps.db.close();
    }
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    if (this.activeCliSession.mode !== 'record') return [];
    const transcript = readCliSessionTranscript(this.agentName, this.activeCliSession.id, this.deps.sessionOptions);
    return transcriptMessages(transcript.entries);
  }

  listSessions(): CliSessionInfo[] {
    return listCliSessions(this.agentName, this.deps.sessionOptions);
  }

  async resumeConversation(sessionRef: string): Promise<void> {
    const nextCliSession = createCliSession(this.agentName, { ...this.deps.sessionOptions, session: sessionRef });
    await this.session.end();
    this.activeCliSession = nextCliSession;
    this.session = this.createAgentSession(this.conversationIdForAgentSession());
    await this.connect();
  }

  async status(): Promise<AgentClientStatus> {
    const info = await this.deps.refreshInfo();
    return {
      name: info.name,
      purpose: info.purpose,
      model: this.session.getEffectiveModelSpec(),
      reasoningEffort: this.session.getReasoningEffort().effort,
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

  async latestTakes() {
    return this.session.latestAlternateTakes();
  }

  async pickTake(takeId: string, nodeId: string) {
    return this.session.pickAlternateTake(takeId, nodeId);
  }

  async readMemory(): Promise<string> {
    return await this.deps.rt.memory.read('memory/MEMORY.md') ?? '';
  }

  async searchNodes(): Promise<AgentSearchNode[]> {
    // The latest search only — the same projection the cloud getMctsTree serves.
    const nodes = readLatestSearchTree(this.deps.rt.storage.sql);
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

  async listModels(): Promise<AgentModelMenu> {
    return normalizeModelMenu({ payload: await this.session.listAvailableModels() });
  }

  private conversationIdForAgentSession(): string {
    return this.activeCliSession.mode === 'none'
      ? this.activeCliSession.id
      : this.activeCliSession.conversationId;
  }

  private createAgentSession(sessionId: string): LocalAgentSession {
    return new LocalAgentSession({
      rt: this.deps.rt,
      db: this.deps.db,
      model: this.deps.model,
      modelResolver: this.deps.modelResolver,
      noAutoEvolve: this.deps.noAutoEvolve,
      backgroundPolicy: BACKGROUND_POLICY[this.deps.surface],
      oneShot: this.deps.surface === 'one-shot',
      sessionId,
      persistMessages: this.activeCliSession.mode !== 'none',
      onEvent: (event) => this.handleSessionEvent(event),
    });
  }

  private handleSessionEvent(event: SessionEvent): void {
    const mapped = mapSessionEvent(event);
    if (!mapped) return;
    if (mapped.type === 'turn-end' && this.pending) this.pending.result = mapped.turn;
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
      return { type: 'tool-result', toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, success: event.success };
    case 'turn-end':
      const turn: AgentTurnResult = {
        text: event.turn.assistantResponse,
        steps: event.turn.steps,
        durationMs: event.turn.durationMs,
        hadError: event.turn.hadError,
        toolCalls: event.turn.toolCalls.map((call) => ({
          name: call.name,
          args: asRecord({ value: decodeJsonValue({ value: call.args }) }),
          result: call.result === undefined ? undefined : String(call.result),
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
    case 'broadcast':
      return { type: 'broadcast', event: event.event };
    case 'run-event':
      return { type: 'run-event', event: event.event };
    case 'error':
      return { type: 'error', message: event.message };
  }
}
