import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  JsonObjectSchema,
  JsonValueSchema,
  ORCHESTRATOR_AGENT_SLUG,
  decodeJsonValue,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
} from '@proteus/core';
import { tolerate } from '@proteus/core/obs';
import type {
  CheckpointAvailability, FileCheckpointEntry, FileCheckpointListing,
  FileRestorePlan, FileRestoreResult,
} from '@proteus/core';
import {
  callAgentRpc,
  CloudAgentStatusSchema,
  CloudBackgroundJobSchema,
  CloudToolDescriptionsSchema,
  createCloudAgentConnectTicket,
  listCloudAvailableModels,
  type CloudChatMessage,
} from './cloud-api';
import {
  createCliSession,
  listCliSessions,
  type CliSession,
  type CliSessionInfo,
  type CliSessionOptions,
} from './session';
import { SessionRecorder } from './session-recorder';
import { normalizeModelMenu, type AgentModelMenu } from './model-catalog';
import { pageSchema, type Page, type SeekCursor } from '@proteus/core';
import type { AlternateTakeSet, BranchStatusEvent, ChangelogEntry, ChangelogRevertResult, ReasoningEffort, TakePickOutcome } from '@proteus/core';
import {
  asRecord,
  createUserUiMessage,
  findForkPivot,
  promptFiles,
  promptText,
  type AgentChangelogView,
  type AgentClient,
  type AgentClientEvent,
  type AgentClientSendOptions,
  type AgentForkResult,
  type AgentPrompt,
  type AgentClientStatus,
  type AgentJobSummary,
  type AgentSearchNode,
  type AgentToolSurface,
  type AgentTranscriptMessage,
  type AgentTurnResult,
  type DeviceConsentSurface,
  type FileCheckpointSurface,
  type ForkPoint,
  type PendingDeviceConsent,
} from './agent-client';
import * as v from 'valibot';

const ReasoningEffortSchema = v.picklist(['low', 'medium', 'high'] satisfies ReasoningEffort[]);
const PendingDeviceConsentSchema: v.GenericSchema<PendingDeviceConsent> = v.object({
  consentId: v.string(),
  deviceLabel: v.string(),
  method: v.string(),
  command: v.string(),
});
const ResolveDeviceConsentSchema = v.object({ ok: v.boolean() });
const FileRestoreChangeSchema = v.object({
  path: v.string(),
  kind: v.picklist(['modify', 'create', 'delete']),
});
const FileCheckpointEntrySchema: v.GenericSchema<FileCheckpointEntry> = v.object({
  id: v.string(),
  dir: v.string(),
  at: v.number(),
  turnId: v.nullable(v.string()),
  sessionId: v.nullable(v.string()),
  reason: v.string(),
});
const FileRestorePlanSchema: v.GenericSchema<FileRestorePlan> = v.object({
  dir: v.string(),
  id: v.string(),
  files: v.array(FileRestoreChangeSchema),
});
const FileRestoreResultSchema: v.GenericSchema<FileRestoreResult> = v.object({
  dir: v.string(),
  id: v.string(),
  files: v.array(FileRestoreChangeSchema),
  preRestoreId: v.nullable(v.string()),
});
const CheckpointAvailabilitySchema: v.GenericSchema<CheckpointAvailability> = v.object({
  available: v.boolean(),
  reason: v.optional(v.string()),
});
const FileCheckpointListingSchema: v.GenericSchema<FileCheckpointListing> = v.object({
  availability: CheckpointAvailabilitySchema,
  entries: v.array(FileCheckpointEntrySchema),
});
const CloudChatMessageSchema: v.GenericSchema<CloudChatMessage> = v.object({
  id: v.string(),
  role: v.picklist(['user', 'assistant', 'system']),
  content: v.string(),
  createdAt: v.union([v.string(), v.number()]),
});
const CloudChatPageSchema: v.GenericSchema<Page<CloudChatMessage>> = pageSchema(CloudChatMessageSchema);
const BranchTurnResultSchema = v.nullable(v.object({
  accepted: v.optional(v.boolean()),
  reason: v.optional(v.string()),
}));
const ForkAgentResultSchema = v.nullable(v.object({ name: v.optional(v.string()) }));
const ChangelogRevertActionSchema = v.variant('type', [
  v.object({ type: v.literal('scaffold_rollback'), target: v.string() }),
  v.object({ type: v.literal('craft_retire'), target: v.string() }),
  v.object({ type: v.literal('view_revert'), target: v.string() }),
  v.object({ type: v.literal('fact_forget'), target: v.string() }),
  v.object({ type: v.literal('fact_forget_many'), targets: v.array(v.string()) }),
]);
const ChangelogEntrySchema: v.GenericSchema<ChangelogEntry> = v.lazy(() => v.object({
  id: v.string(),
  kind: v.picklist(['scaffold', 'tool', 'view', 'fact', 'gepa', 'replay', 'outcomes']),
  at: v.number(),
  summary: v.string(),
  evidence: v.string(),
  revert: v.optional(ChangelogRevertActionSchema),
  scaffoldVersion: v.optional(v.number()),
  items: v.optional(v.array(ChangelogEntrySchema)),
}));
const ChangelogViewSchema = v.nullable(v.object({
  entries: v.optional(v.array(ChangelogEntrySchema), []),
  unseenCount: v.optional(v.number(), 0),
}));
const ChangelogRevertResultSchema: v.GenericSchema<ChangelogRevertResult> = v.object({
  ok: v.boolean(),
  detail: v.optional(v.string()),
  error: v.optional(v.string()),
});
const AlternateTakeCandidateSchema = v.object({
  nodeId: v.string(),
  text: v.string(),
  score: v.number(),
  visits: v.number(),
  depth: v.number(),
  origin: v.optional(v.picklist(['live', 'branch'])),
});
const AlternateTakeSetSchema: v.GenericSchema<AlternateTakeSet> = v.object({
  id: v.string(),
  turnId: v.nullable(v.string()),
  sessionId: v.nullable(v.string()),
  task: v.string(),
  source: v.picklist(['mcts', 'branch', 'heads']),
  winnerNodeId: v.string(),
  chosenNodeId: v.nullable(v.string()),
  candidates: v.array(AlternateTakeCandidateSchema),
  createdAt: v.number(),
  pickedAt: v.nullable(v.number()),
});
const TakePickOutcomeSchema: v.GenericSchema<TakePickOutcome> = v.object({
  outcome: v.picklist(['accepted', 'corrected']),
  changedAnswer: v.boolean(),
  chosen: AlternateTakeCandidateSchema,
  set: AlternateTakeSetSchema,
  continuationQueued: v.boolean(),
});
const SearchNodeProjectionSchema = v.object({
  depth: v.number(),
  status: v.string(),
  value: v.optional(v.number()),
  visits: v.optional(v.number()),
  action: v.optional(v.nullable(v.string())),
});
const ModelSpecSchema = v.object({ spec: v.nullable(v.string()) });
const SetModelResultSchema = v.object({ ok: v.literal(true), spec: v.string() });
const ReasoningEffortResultSchema = v.object({ effort: v.nullable(ReasoningEffortSchema) });
const SetReasoningEffortResultSchema = v.object({ ok: v.literal(true), effort: ReasoningEffortSchema });

const SocketFrameSchema = v.objectWithRest({
  type: v.string(),
  id: v.optional(v.string()),
  success: v.optional(v.boolean()),
  result: v.optional(JsonValueSchema),
  error: v.optional(JsonValueSchema),
  body: v.optional(v.string()),
  done: v.optional(v.boolean()),
}, JsonValueSchema);
type SocketFrame = v.InferOutput<typeof SocketFrameSchema>;

const BranchStatusEventSchema = v.variant('status', [
  v.object({
    type: v.literal('branch_status'), status: v.literal('running'), branchId: v.string(), task: v.string(),
  }),
  v.object({
    type: v.literal('branch_status'), status: v.literal('settled'), branchId: v.string(), task: v.string(),
    takeSetId: v.string(), turnId: v.string(),
  }),
  v.object({
    type: v.literal('branch_status'), status: v.literal('error'), branchId: v.string(), task: v.string(),
    message: v.optional(v.string()),
  }),
]);

export interface CloudAgentClientOptions {
  origin: string;
  token: string;
  /** Display/canonical agent name for UI surfaces. */
  agentName: string;
  /** DO instance name on the orchestrator-agent namespace. */
  cloudName: string;
  session?: CliSessionOptions;
  /** One task turn, then exit. Stamped on each chat request so the DO knows
   *  this prompt is an independent task rather than a conversational
   *  follow-up, and never grades the previous turn from it. */
  oneShot?: boolean;
}

interface ActiveTurn {
  startedAt: number;
  text: string;
  steps: number;
  toolCalls: AgentTurnResult['toolCalls'];
  toolById: Map<string, AgentTurnResult['toolCalls'][number]>;
  resolve: (result: AgentTurnResult) => void;
}

/**
 * AgentClient over the OrchestratorAgent DO: chat turns ride the real agent
 * websocket (ticket-authenticated), everything else calls agent methods by
 * name over the generic /api/cli/workspaces/:name/rpc transport (or the
 * socket's own {type:'rpc'} frames once it is open). The DO is the source
 * of truth for chat history and turn
 * execution: each send transmits only the new user message (the server
 * reconciles it into its canonical store and builds model context
 * server-side), so the client never mirrors history.
 */
export class CloudAgentClient implements AgentClient {
  readonly mode = 'cloud' as const;
  readonly agentName: string;
  readonly consents: DeviceConsentSurface;
  readonly localControls = null;
  readonly checkpoints: FileCheckpointSurface;
  readonly inlineAttachmentLimitBytes = CLOUD_MAX_INLINE_ATTACHMENT_BYTES;

  private readonly origin: string;
  private readonly token: string;
  private readonly cloudName: string;
  private readonly oneShot: boolean;
  private readonly sessionOptions: CliSessionOptions;
  private activeCliSession: CliSession;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private readonly recorder = new SessionRecorder('cloud');
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  /** In-flight @callable RPCs over the agent websocket ({type:'rpc'} frames). */
  private readonly pendingRpcs = new Map<string, { resolve: (value: JsonValue) => void; reject: (err: Error) => void }>();

  constructor(opts: CloudAgentClientOptions) {
    this.origin = opts.origin;
    this.token = opts.token;
    this.agentName = opts.agentName;
    this.cloudName = opts.cloudName;
    this.oneShot = opts.oneShot === true;
    this.sessionOptions = opts.session ?? {};
    this.activeCliSession = createCliSession(opts.agentName, this.sessionOptions);
    this.consents = {
      listPending: () => this.callHttp('listPendingConsents', v.array(PendingDeviceConsentSchema)),
      resolve: (consentId, decision) => this.callHttp(
        'resolveDeviceConsent', ResolveDeviceConsentSchema, [consentId, decision],
      ),
    };
    // Checkpoints live on the user's device daemon; the DO forwards.
    this.checkpoints = {
      list: async (limit, turnId) => v.parse(
        FileCheckpointListingSchema,
        await this.callRpc('listFileCheckpoints', [limit ?? 50, turnId ?? null]),
      ),
      plan: async (dir, id) => v.parse(FileRestorePlanSchema, await this.callRpc('planFileRestore', [dir, id])),
      restore: async (dir, id) => v.parse(
        FileRestoreResultSchema, await this.callRpc('restoreFileCheckpoint', [dir, id]),
      ),
    };
  }

  get cliSession(): CliSession {
    return this.activeCliSession;
  }

  async connect(): Promise<void> {
    // The websocket is opened lazily on first send; nothing to bring up.
  }

  subscribe(listener: (event: AgentClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): Promise<AgentTurnResult> {
    return this.submit(prompt, opts, false);
  }

  /** Cloud steer: the DO persists an incoming chat request immediately and
   *  serializes it on its TurnQueue, so a mid-turn submit reaches the agent
   *  now and runs as the next turn at the boundary. Fire-and-forget — the
   *  response (and any pre-flight failure) streams through the event feed. */
  steer(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): boolean {
    if (this.activeTurns.size === 0) return false;
    void this.submit(prompt, opts, true).catch((err) => {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  /** Steer-as-Branch: fire the branchTurn RPC — the DO spawns the head and
   *  streams 'branch_status' broadcasts back over this websocket (forwarded
   *  as broadcast events). A rejected branch surfaces as an error status. */
  branch(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): boolean {
    if (this.activeTurns.size === 0) return false;
    const text = promptText(prompt).trim();
    if (!text) return false;
    this.activeCliSession.append('user', { text, branched: true, cwd: opts.cwd ?? process.cwd(), backend: 'cloud' });
    const fail = (message: string) => {
      const event: BranchStatusEvent = { type: 'branch_status', status: 'error', branchId: '', task: text, message };
      this.emit({ type: 'broadcast', event });
    };
    void this.callRpc('branchTurn', [text])
      .then((result) => {
        const r = v.parse(BranchTurnResultSchema, result);
        if (!r?.accepted) fail(r?.reason ?? 'The cloud agent rejected the branch.');
      })
      .catch((err) => fail(err instanceof Error ? err.message : String(err)));
    return true;
  }

  private async submit(prompt: AgentPrompt, opts: AgentClientSendOptions, steered: boolean): Promise<AgentTurnResult> {
    const text = promptText(prompt).trim();
    const files = promptFiles(prompt);
    if (!text && files.length === 0) throw new Error('prompt required');
    await this.ensureOpen();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Cloud workspace connection is not open.');

    // The JSONL log records attachment names, never the data-URL payloads.
    const sessionEntry: JsonObject = {
      text,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'cloud',
    };
    if (steered) sessionEntry.steered = true;
    if (files.length > 0) sessionEntry.attachments = files.map((file) => file.filename);
    this.activeCliSession.append('user', sessionEntry);
    this.emit({ type: 'turn-start', kind: 'user', text });

    const requestId = randomRequestId();
    return await new Promise<AgentTurnResult>((resolve) => {
      const turn: ActiveTurn = {
        startedAt: Date.now(),
        text: '',
        steps: 0,
        toolCalls: [],
        toolById: new Map(),
        resolve,
      };
      this.activeTurns.set(requestId, turn);

      try {
        const body: JsonObject = {
          messages: [decodeJsonValue({ value: createUserUiMessage(text, files) })],
          trigger: 'submit-message',
        };
        if (opts.cwd) body.cwd = opts.cwd;
        if (this.oneShot) body.oneShot = true;
        const request: JsonObject = {
          id: requestId,
          init: {
            method: 'POST',
            body: JSON.stringify(body),
          },
          type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
        };
        ws.send(JSON.stringify(request));
      } catch (err) {
        // The turn-start already went out — keep the lifecycle paired.
        this.activeTurns.delete(requestId);
        this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        this.settleTurn(turn, true);
      }
    });
  }

  /** Walk-back fork: the cloud's fork primitive is agent-level — forkAgent
   *  copies SOUL/memory/messages up to a message id into a NEW agent DO. We
   *  fork at the message preceding the picked user message and hand back a
   *  sibling client pointed at the fork. */
  async fork(point: ForkPoint): Promise<AgentForkResult> {
    if (this.activeTurns.size > 0) throw new Error('Cannot fork while a turn is running.');
    const rows = await this.transcript();
    const pivot = findForkPivot(rows, point);
    if (pivot < 0) throw new Error('Could not locate that message in the agent’s chat history.');
    if (pivot === 0) throw new Error('Cannot walk back before the first message of a cloud workspace.');
    const untilId = rows[pivot - 1]!.id;
    const forkName = v.parse(ForkAgentResultSchema, await this.callRpc('forkAgent', [untilId]))?.name;
    if (!forkName) throw new Error('Cloud fork returned no agent name.');
    const sibling = new CloudAgentClient({
      origin: this.origin,
      token: this.token,
      agentName: forkName,
      cloudName: forkName,
      session: {
        sessionDir: this.sessionOptions.sessionDir,
        noSession: this.sessionOptions.noSession,
      },
    });
    return { client: sibling, label: `agent ${forkName}` };
  }

  /** Invoke a named agent method over the generic HTTP RPC transport —
   *  for surfaces that must not force a websocket open (consents polling,
   *  history, status). Live-session ops (branch, fork, takes, checkpoints)
   *  ride callRpc on the already-open socket instead. */
  private callHttp<T>(method: string, schema: v.GenericSchema<T>, args: JsonValue[] = []): Promise<T> {
    return callAgentRpc(this.origin, this.token, this.cloudName, method, schema, args);
  }

  /** Invoke a @callable agent method over the websocket ({type:'rpc'}). */
  private async callRpc(method: string, args: JsonValue[]): Promise<JsonValue> {
    await this.ensureOpen();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Cloud workspace connection is not open.');
    const id = randomRequestId();
    return await new Promise<JsonValue>((resolve, reject) => {
      this.pendingRpcs.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
      } catch (err) {
        this.pendingRpcs.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Cancel in-flight turns: ask the DO to abort, resolve locally with the
   *  partial output so callers return to idle immediately. Cloud steers are
   *  persisted by the DO the moment they are submitted, so nothing typed is
   *  ever dropped here. */
  stop(): string[] {
    const ws = this.ws;
    for (const [id, turn] of this.activeTurns) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL, id }));
      }
      this.activeTurns.delete(id);
      this.settleTurn(turn);
    }
    return [];
  }

  async close(): Promise<void> {
    this.failInFlight(new Error('Cloud workspace connection closed.'));
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    return (await this.transcript()).map((row) => ({ id: row.id, role: row.role, content: row.content }));
  }

  /**
   * The WHOLE durable transcript, oldest first.
   *
   * Walked page by page rather than asked for in one call. Both callers need
   * completeness and neither can detect its absence: `history()` seeds the
   * TUI's message list, and `fork()` searches the result for a pivot message
   * and reports "could not locate that message" when it is not there — which
   * is what a silent cap reads as for any conversation past the page size.
   */
  private async transcript(): Promise<CloudChatMessage[]> {
    const rows: CloudChatMessage[] = [];
    let cursor: SeekCursor | null = null;
    for (;;) {
      const page: Page<CloudChatMessage> = await this.callHttp(
        'getChatHistoryPage', CloudChatPageSchema,
        [cursor === null ? {} : { cursor: { after: cursor.after } }],
      );
      rows.unshift(...page.items);
      if (page.status === 'end') return rows;
      cursor = page.next;
    }
  }

  listSessions(): CliSessionInfo[] {
    return listCliSessions(this.agentName, this.sessionOptions);
  }

  async resumeConversation(sessionRef: string): Promise<void> {
    // Cloud chat history lives in the DO; only the terminal log is re-pointed.
    this.activeCliSession = createCliSession(this.agentName, { ...this.sessionOptions, session: sessionRef });
  }

  async status(): Promise<AgentClientStatus> {
    const status = await this.callHttp('getAgentStatus', CloudAgentStatusSchema);
    return {
      name: status.displayName ?? status.name,
      purpose: status.purpose,
      model: status.model ?? null,
      reasoningEffort: status.reasoningEffort ?? null,
      scaffoldVersion: status.scaffoldVersion,
      messageCount: status.messageCount,
      searchNodeCount: status.searchNodeCount,
      craftedToolCount: status.craftedToolCount,
    };
  }

  async describeTools(): Promise<AgentToolSurface> {
    const tools = await this.callHttp('getToolDescriptions', CloudToolDescriptionsSchema);
    return {
      builtIn: tools.builtIn.map(({ name, description }) => ({ name, description })),
      crafted: tools.crafted.map(({ name, description }) => ({ name, description })),
    };
  }

  async readMemory(): Promise<string> {
    return await this.callHttp('getMemoryContent', v.string());
  }

  async changelog(limit?: number): Promise<AgentChangelogView> {
    const result = v.parse(
      ChangelogViewSchema, await this.callRpc('getEvolutionChangelog', [{ limit: limit ?? 50 }]),
    );
    const view: AgentChangelogView = {
      entries: result?.entries ?? [],
      unseenCount: result?.unseenCount ?? 0,
    };
    // Viewing is the acknowledgement. A failed ack is reported through the client's own error
    // channel: silently dropped, the same digest returns as unseen forever with no reason given.
    try {
      await this.callRpc('markChangelogSeen', []);
    } catch (error) {
      this.emit({
        type: 'error',
        message: `Could not mark the changelog as seen: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return view;
  }

  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    return v.parse(ChangelogRevertResultSchema, await this.callRpc('revertChangelogEntry', [id]));
  }

  async latestTakes(): Promise<AlternateTakeSet | null> {
    return v.parse(v.nullable(AlternateTakeSetSchema), await this.callRpc('latestAlternateTakes', []));
  }

  async pickTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    return v.parse(TakePickOutcomeSchema, await this.callRpc('pickAlternateTake', [takeId, nodeId]));
  }

  async searchNodes(): Promise<AgentSearchNode[]> {
    const rows = await this.callHttp('getMctsTree', v.array(SearchNodeProjectionSchema));
    return rows.map((node) => ({
      depth: node.depth,
      status: node.status,
      value: node.value ?? 0,
      visits: node.visits ?? 0,
      action: node.action ?? null,
    }));
  }

  async listJobs(limit = 20): Promise<AgentJobSummary[]> {
    const jobs = await this.callHttp('listBackgroundJobs', v.array(CloudBackgroundJobSchema), [limit]);
    return jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status }));
  }

  async getModelSpec(): Promise<string | null> {
    return (await this.callHttp('getStoredModelSpec', ModelSpecSchema)).spec;
  }

  async setModel(spec: string): Promise<{ spec: string }> {
    return { spec: (await this.callHttp('setModel', SetModelResultSchema, [spec])).spec };
  }

  async getReasoningEffort(): Promise<ReasoningEffort | null> {
    return (await this.callHttp('getReasoningEffort', ReasoningEffortResultSchema)).effort;
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }> {
    return {
      effort: (await this.callHttp('setReasoningEffort', SetReasoningEffortResultSchema, [effort])).effort,
    };
  }

  async listModels(): Promise<AgentModelMenu> {
    const menu = normalizeModelMenu({ payload: await listCloudAvailableModels(this.origin, this.token) });
    // Only a menu with nothing in it AND nothing to explain is an error; a
    // provider that failed is reported to the picker, not thrown at it.
    if (menu.models.length === 0 && menu.failures.length === 0) {
      throw new Error('No cloud models are available.');
    }
    return menu;
  }

  private emit(event: AgentClientEvent): void {
    this.recorder.record(this.activeCliSession, event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Settle a turn: every turn-start is followed by exactly ONE turn-end —
   *  failures carry hadError (the error event precedes it) so surfaces can
   *  track turn lifecycle by pairing starts with ends. */
  private settleTurn(turn: ActiveTurn, hadError = false): void {
    const result: AgentTurnResult = {
      text: turn.text,
      toolCalls: turn.toolCalls,
      steps: turn.steps,
      durationMs: Date.now() - turn.startedAt,
      hadError,
    };
    this.emit({ type: 'turn-end', turn: result });
    turn.resolve(result);
  }

  private async ensureOpen(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return await this.connectPromise;
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async openSocket(): Promise<void> {
    const { ticket } = await createCloudAgentConnectTicket(this.origin, this.token, this.cloudName);
    const url = new URL(`/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(this.cloudName)}`, this.origin.replace(/\/+$/, ''));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);

    const ws = new WebSocket(url.toString());
    this.ws = ws;
    ws.addEventListener('message', (event) => this.handleMessage(event));
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.failInFlight(new Error('Cloud workspace connection closed.'));
    });
    ws.addEventListener('error', () => {
      this.failInFlight(new Error('Cloud workspace connection failed.'));
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to cloud workspace.')), 15_000);
      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Could not connect to cloud agent.'));
      }, { once: true });
    });
  }

  private handleMessage(event: MessageEvent): void {
    const payload = parseSocketJson(event);
    if (!payload) return;

    if (payload.type === 'rpc' && payload.id) {
      const pending = this.pendingRpcs.get(payload.id);
      if (!pending) return;
      this.pendingRpcs.delete(payload.id);
      if (payload.success === true) pending.resolve(payload.result ?? null);
      else pending.reject(new Error(jsonErrorMessage(payload.error, 'Cloud workspace RPC failed.')));
      return;
    }

    // Branch progress broadcasts (the DO fans them to every ws client) feed
    // the TUI's branch segment + settle hint. Narrowed field-by-field like
    // every other frame in this handler — no wholesale re-typing.
    if (payload.type === 'branch_status') {
      const event = parseBranchStatusEvent(payload);
      if (event) this.emit({ type: 'broadcast', event });
      return;
    }

    // Ack a resuming stream only when it is one of our own turns, so the DO
    // replays its chunks after a reconnect; other clients' streams are ignored.
    if (payload.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING && payload.id) {
      if (this.activeTurns.has(payload.id)) {
        this.ws?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: payload.id }));
      }
      return;
    }

    if (payload.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || !payload.id) return;
    const active = this.activeTurns.get(payload.id);
    if (!active) return;
    if (payload.error) {
      this.activeTurns.delete(payload.id);
      const message = payload.body || 'Cloud agent stream failed.';
      this.emit({ type: 'error', message });
      this.settleTurn(active, true);
      return;
    }
    if (payload.body?.trim()) {
      this.applyChunk(active, payload.body);
    }
    if (payload.done) {
      this.activeTurns.delete(payload.id);
      this.settleTurn(active);
    }
  }

  private applyChunk(active: ActiveTurn, body: string): void {
    const parsed = tolerate(() => parseJsonValue(body), 'malformed-input');
    if (parsed === undefined) return;
    const result = v.safeParse(JsonObjectSchema, parsed);
    if (!result.success) return;
    const chunk = result.output;
    const type = v.safeParse(v.string(), chunk.type);
    if (!type.success) return;
    switch (type.output) {
      case 'text-delta': {
        const delta = jsonString(chunk.delta, '');
        if (!delta) return;
        active.text += delta;
        this.emit({ type: 'text-delta', delta });
        return;
      }
      case 'tool-input-available': {
        const toolName = jsonString(chunk.toolName, 'tool');
        const toolCallId = jsonString(chunk.toolCallId, '');
        const args = asRecord({ value: chunk.input ?? null });
        const call = { name: toolName, args, result: undefined };
        active.toolCalls.push(call);
        if (toolCallId) active.toolById.set(toolCallId, call);
        this.emit({ type: 'tool-call', toolName, toolCallId, args });
        return;
      }
      case 'tool-output-available':
      case 'tool-output-error': {
        const toolCallId = jsonString(chunk.toolCallId, '');
        const call = active.toolById.get(toolCallId);
        const result = type.output === 'tool-output-error'
          ? jsonErrorMessage(chunk.errorText, 'tool error')
          : stringifyToolOutput(chunk.output ?? null);
        if (call) call.result = result;
        this.emit({
          type: 'tool-result', toolName: call?.name ?? 'tool', toolCallId, result,
          success: type.output !== 'tool-output-error',
        });
        return;
      }
      case 'finish-step': {
        active.steps += 1;
        this.emit({ type: 'step-finish', stepIndex: active.steps });
        return;
      }
    }
  }

  private failInFlight(error: Error): void {
    const active = [...this.activeTurns.values()];
    this.activeTurns.clear();
    if (active.length > 0) this.emit({ type: 'error', message: error.message });
    for (const turn of active) this.settleTurn(turn, true);
    const rpcs = [...this.pendingRpcs.values()];
    this.pendingRpcs.clear();
    for (const rpc of rpcs) rpc.reject(error);
  }
}

/** Narrow a branch_status frame to the fields its consumers rely on
 *  (describeBranchStatus switches on status; the TUI keys on branchId). */
function parseBranchStatusEvent(payload: SocketFrame): BranchStatusEvent | null {
  const result = v.safeParse(BranchStatusEventSchema, payload);
  if (!result.success) return null;
  const event = result.output;
  if (event.status !== 'error') return event;
  return { ...event, message: event.message ?? 'branch failed' };
}

function parseSocketJson(event: MessageEvent): SocketFrame | null {
  const data: unknown = event.data;
  const textResult = v.safeParse(v.string(), data);
  const bufferResult = v.safeParse(v.instance(ArrayBuffer), data);
  const bytesResult = v.safeParse(v.instance(Uint8Array), data);
  const text = textResult.success
    ? textResult.output
    : bufferResult.success
      ? new TextDecoder().decode(bufferResult.output)
      : bytesResult.success
        ? new TextDecoder().decode(bytesResult.output)
        : String(data);
  // A frame off the wire is untrusted input: unparseable text is a frame we drop, and only that.
  const parsed = tolerate(() => parseJsonValue(text), 'malformed-input');
  if (parsed === undefined) return null;
  const frame = v.safeParse(SocketFrameSchema, parsed);
  return frame.success ? frame.output : null;
}

function stringifyToolOutput(output: JsonValue): string {
  const text = v.safeParse(v.string(), output);
  return text.success ? text.output : JSON.stringify(output);
}

function jsonErrorMessage(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const text = v.safeParse(v.string(), value);
  return text.success && text.output ? text.output : String(value);
}

function jsonString(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const text = v.safeParse(v.string(), value);
  return text.success ? text.output : fallback;
}

function randomRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
