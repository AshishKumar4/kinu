import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { AgentInfo, AgentRuntime, SearchNode, ShellApprovalMode } from '@proteus/core';
import {
  LocalAgentSession,
  openAgentCLI,
  resolveChatModel,
  type LocalModelResolver,
  type McpServerConfig,
  type SessionEvent,
} from '@proteus/cli-backend';
import {
  CONFIG_PATH,
  agentDbPath,
  createCodexAuthStore,
  resolveMcpServers,
  resolveProviderCredentials,
} from './config.js';
import { createConfiguredLocalModelResolver } from './local-model-resolver.js';
import {
  createCliSession,
  defaultConversationIdForCliOptions,
  listCliSessions,
  readCliSessionTranscript,
  transcriptMessages,
  type CliSession,
  type CliSessionInfo,
  type CliSessionOptions,
} from './session.js';
import { recordAgentClientEvent } from './session-recorder.js';
import { normalizeModelEntries, type AgentModelEntry } from './model-catalog.js';
import {
  promptFiles,
  promptText,
} from './agent-client.js';
import type {
  AgentClient,
  AgentClientEvent,
  AgentClientSendOptions,
  AgentClientStatus,
  AgentPrompt,
  AgentJobSummary,
  AgentSearchNode,
  AgentToolSurface,
  AgentTranscriptMessage,
  AgentTurnResult,
  LocalSessionControls,
} from './agent-client.js';

export interface LocalAgentClientOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
  session?: CliSessionOptions;
}

/** Open a local agent database and wrap its LocalAgentSession as an AgentClient. */
export function openLocalAgentClient(name: string, opts: LocalAgentClientOptions = {}): LocalAgentClient {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);
  }
  const { llmConfig, resolver } = createConfiguredLocalModelResolver(opts);
  const providerCredentials = resolveProviderCredentials();
  const codexAuthStore = createCodexAuthStore();
  const db = new Database(dbPath);
  const openConfig = { llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH };
  const { rt, info } = openAgentCLI(db, dbPath, openConfig);
  return new LocalAgentClient({
    agentName: name,
    rt,
    db,
    dbPath,
    info,
    refreshInfo: () => openAgentCLI(db, dbPath, openConfig).info,
    model: resolveChatModel(llmConfig),
    modelResolver: resolver,
    mcpServers: resolveMcpServers(),
    noAutoEvolve: opts.noAutoEvolve ?? false,
    sessionOptions: opts.session ?? {},
  });
}

export interface LocalAgentClientDeps {
  agentName: string;
  rt: AgentRuntime;
  db: Database;
  dbPath: string;
  info: AgentInfo;
  refreshInfo: () => AgentInfo;
  model: ReturnType<typeof resolveChatModel>;
  modelResolver: LocalModelResolver;
  mcpServers: Record<string, McpServerConfig>;
  noAutoEvolve: boolean;
  sessionOptions: CliSessionOptions;
}

interface PendingLocalTurn {
  result: AgentTurnResult;
}

export class LocalAgentClient implements AgentClient {
  readonly mode = 'local' as const;
  readonly agentName: string;
  readonly consents = null;
  readonly localControls: LocalSessionControls;

  private readonly deps: LocalAgentClientDeps;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private session: LocalAgentSession;
  private activeCliSession: CliSession;
  private pending: PendingLocalTurn | null = null;
  private closed = false;

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
      listModelProviders: async () => (await this.session.listModelProviders()).map((provider) => ({
        id: provider.id,
        available: provider.available,
        unavailableReason: provider.unavailableReason,
      })),
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
    this.activeCliSession.append('user', {
      text,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'local',
      ...(files.length > 0 ? { attachments: files.map((f) => f.filename) } : {}),
    });
    const pending: PendingLocalTurn = {
      result: { text: '', toolCalls: [], steps: 0, durationMs: 0, hadError: false },
    };
    this.pending = pending;
    try {
      await this.session.send(files.length > 0 ? { text, files } : text);
      return pending.result;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  stop(): void {
    this.session.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.end().catch(() => {});
    this.deps.db.close();
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    if (this.activeCliSession.mode !== 'record') return [];
    try {
      const transcript = readCliSessionTranscript(this.agentName, this.activeCliSession.id, this.deps.sessionOptions);
      return transcriptMessages(transcript.entries);
    } catch {
      return [];
    }
  }

  listSessions(): CliSessionInfo[] {
    return listCliSessions(this.agentName, this.deps.sessionOptions);
  }

  async resumeConversation(sessionRef: string): Promise<void> {
    const nextCliSession = createCliSession(this.agentName, { ...this.deps.sessionOptions, session: sessionRef });
    await this.session.end().catch(() => {});
    this.activeCliSession = nextCliSession;
    this.session = this.createAgentSession(this.conversationIdForAgentSession());
    await this.connect();
  }

  async status(): Promise<AgentClientStatus> {
    const info = this.deps.refreshInfo();
    return {
      name: info.name,
      purpose: info.purpose,
      model: this.session.getEffectiveModelSpec(),
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

  async readMemory(): Promise<string> {
    return await this.deps.rt.memory.read('memory/MEMORY.md') ?? '';
  }

  async searchNodes(): Promise<AgentSearchNode[]> {
    const nodes = this.deps.rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
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

  async listModels(): Promise<AgentModelEntry[]> {
    return normalizeModelEntries(await this.session.listAvailableModels());
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
    recordAgentClientEvent(this.activeCliSession, event, 'local');
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a render error must not kill the loop */ }
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
      return { type: 'tool-call', toolName: event.toolName, args: event.args };
    case 'tool-result':
      return { type: 'tool-result', toolName: event.toolName, result: event.result };
    case 'turn-end':
      return {
        type: 'turn-end',
        turn: {
          text: event.turn.assistantResponse,
          steps: event.turn.steps,
          durationMs: event.turn.durationMs,
          hadError: event.turn.hadError,
          toolCalls: event.turn.toolCalls.map((call) => ({
            name: call.name,
            args: call.args,
            result: call.result === undefined ? undefined : String(call.result),
          })),
        },
      };
    case 'evolution':
      return { type: 'evolution', event: event.event, message: event.message };
    case 'broadcast':
      return { type: 'broadcast', event: event.event };
    case 'error':
      return { type: 'error', message: event.message };
  }
}
