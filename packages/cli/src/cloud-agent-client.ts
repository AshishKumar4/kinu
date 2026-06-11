import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { ORCHESTRATOR_AGENT_SLUG } from '@proteus/core';
import type {
  CheckpointAvailability, FileCheckpointEntry, FileRestorePlan, FileRestoreResult,
} from '@proteus/core';
import {
  createCloudAgentConnectTicket,
  getCloudAgentMessages,
  getCloudAgentModel,
  getCloudAgentStatus,
  getCloudAgentTools,
  getCloudMctsTree,
  getCloudMemoryContent,
  listCloudAvailableModels,
  listCloudJobs,
  listCloudPendingConsents,
  resolveCloudDeviceConsent,
  setCloudAgentModel,
} from './cloud-api.js';
import {
  createCliSession,
  listCliSessions,
  type CliSession,
  type CliSessionInfo,
  type CliSessionOptions,
} from './session.js';
import { recordAgentClientEvent } from './session-recorder.js';
import { dedupeModelEntries, normalizeModelEntries, type AgentModelEntry } from './model-catalog.js';
import type { AlternateTakeSet, ChangelogEntry, ChangelogRevertResult, TakePickOutcome } from '@proteus/core';
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
} from './agent-client.js';

export interface CloudAgentClientOptions {
  origin: string;
  token: string;
  /** Display/canonical agent name for UI surfaces. */
  agentName: string;
  /** DO instance name on the orchestrator-agent namespace. */
  cloudName: string;
  session?: CliSessionOptions;
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
 * websocket (ticket-authenticated), everything else uses the /api/cli HTTP
 * projection. The DO is the source of truth for chat history and turn
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

  private readonly origin: string;
  private readonly token: string;
  private readonly cloudName: string;
  private readonly sessionOptions: CliSessionOptions;
  private activeCliSession: CliSession;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  /** In-flight @callable RPCs over the agent websocket ({type:'rpc'} frames). */
  private readonly pendingRpcs = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  constructor(opts: CloudAgentClientOptions) {
    this.origin = opts.origin;
    this.token = opts.token;
    this.agentName = opts.agentName;
    this.cloudName = opts.cloudName;
    this.sessionOptions = opts.session ?? {};
    this.activeCliSession = createCliSession(opts.agentName, this.sessionOptions);
    this.consents = {
      listPending: () => listCloudPendingConsents(this.origin, this.token, this.cloudName),
      resolve: (consentId, decision) => resolveCloudDeviceConsent(this.origin, this.token, this.cloudName, consentId, decision),
    };
    // Checkpoints live on the user's device daemon; the DO forwards.
    this.checkpoints = {
      list: async (limit) => await this.callRpc('listFileCheckpoints', [limit ?? 50]) as FileCheckpointEntry[],
      plan: async (dir, id) => await this.callRpc('planFileRestore', [dir, id]) as FileRestorePlan,
      restore: async (dir, id) => await this.callRpc('restoreFileCheckpoints', [dir, id]) as FileRestoreResult,
      status: async () => await this.callRpc('checkpointStatus', []) as CheckpointAvailability,
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

  private async submit(prompt: AgentPrompt, opts: AgentClientSendOptions, steered: boolean): Promise<AgentTurnResult> {
    const text = promptText(prompt).trim();
    const files = promptFiles(prompt);
    if (!text && files.length === 0) throw new Error('prompt required');
    await this.ensureOpen();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Cloud agent connection is not open.');

    // The JSONL log records attachment names, never the data-URL payloads.
    this.activeCliSession.append('user', {
      text,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'cloud',
      ...(steered ? { steered: true } : {}),
      ...(files.length > 0 ? { attachments: files.map((f) => f.filename) } : {}),
    });
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
        ws.send(JSON.stringify({
          id: requestId,
          init: {
            method: 'POST',
            body: JSON.stringify({
              messages: [createUserUiMessage(text, files)],
              trigger: 'submit-message',
              ...(opts.cwd ? { cwd: opts.cwd } : {}),
            }),
          },
          type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
        }));
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
    const rows = await getCloudAgentMessages(this.origin, this.token, this.cloudName);
    const pivot = findForkPivot(rows, point);
    if (pivot < 0) throw new Error('Could not locate that message in the agent’s chat history.');
    if (pivot === 0) throw new Error('Cannot walk back before the first message of a cloud agent.');
    const untilId = rows[pivot - 1]!.id;
    const result = await this.callRpc('forkAgent', [untilId]);
    const forkName = (result as { name?: unknown } | null)?.name;
    if (typeof forkName !== 'string' || !forkName) throw new Error('Cloud fork returned no agent name.');
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

  /** Invoke a @callable agent method over the websocket ({type:'rpc'}). */
  private async callRpc(method: string, args: unknown[]): Promise<unknown> {
    await this.ensureOpen();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Cloud agent connection is not open.');
    const id = randomRequestId();
    return await new Promise<unknown>((resolve, reject) => {
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
   *  partial output so callers return to idle immediately. */
  stop(): void {
    const ws = this.ws;
    for (const [id, turn] of [...this.activeTurns]) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL, id }));
      }
      this.activeTurns.delete(id);
      this.settleTurn(turn);
    }
  }

  async close(): Promise<void> {
    this.failInFlight(new Error('Cloud agent connection closed.'));
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    const rows = await getCloudAgentMessages(this.origin, this.token, this.cloudName);
    return rows.map((row) => ({ id: row.id, role: row.role, content: row.content }));
  }

  listSessions(): CliSessionInfo[] {
    return listCliSessions(this.agentName, this.sessionOptions);
  }

  async resumeConversation(sessionRef: string): Promise<void> {
    // Cloud chat history lives in the DO; only the terminal log is re-pointed.
    this.activeCliSession = createCliSession(this.agentName, { ...this.sessionOptions, session: sessionRef });
  }

  async status(): Promise<AgentClientStatus> {
    const status = await getCloudAgentStatus(this.origin, this.token, this.cloudName);
    return {
      name: status.displayName ?? status.name,
      purpose: status.purpose,
      model: status.model ?? null,
      scaffoldVersion: status.scaffoldVersion,
      messageCount: status.messageCount,
      searchNodeCount: status.searchNodeCount,
      craftedToolCount: status.craftedToolCount,
    };
  }

  async describeTools(): Promise<AgentToolSurface> {
    const tools = await getCloudAgentTools(this.origin, this.token, this.cloudName);
    return {
      builtIn: tools.builtIn.map(({ name, description }) => ({ name, description })),
      crafted: tools.crafted.map(({ name, description }) => ({ name, description })),
    };
  }

  async readMemory(): Promise<string> {
    return (await getCloudMemoryContent(this.origin, this.token, this.cloudName)).content;
  }

  async changelog(limit?: number): Promise<AgentChangelogView> {
    const result = await this.callRpc('getEvolutionChangelog', [{ limit: limit ?? 50 }]) as {
      entries?: ChangelogEntry[]; unseenCount?: number;
    } | null;
    const view: AgentChangelogView = {
      entries: Array.isArray(result?.entries) ? result.entries : [],
      unseenCount: typeof result?.unseenCount === 'number' ? result.unseenCount : 0,
    };
    // Viewing is the acknowledgement — best effort, the digest still renders.
    await this.callRpc('markChangelogSeen', []).catch(() => {});
    return view;
  }

  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    const result = await this.callRpc('revertChangelogEntry', [id]) as ChangelogRevertResult | null;
    return result ?? { ok: false, error: 'cloud revert returned no result' };
  }

  async latestTakes(): Promise<AlternateTakeSet | null> {
    return await this.callRpc('latestAlternateTakes', []) as AlternateTakeSet | null;
  }

  async pickTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    const result = await this.callRpc('pickAlternateTake', [takeId, nodeId]) as TakePickOutcome | null;
    if (!result) throw new Error('cloud pick returned no result');
    return result;
  }

  async searchNodes(): Promise<AgentSearchNode[]> {
    const rows = await getCloudMctsTree(this.origin, this.token, this.cloudName);
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const node = row as Record<string, unknown>;
      if (typeof node.depth !== 'number' || typeof node.status !== 'string') return [];
      return [{
        depth: node.depth,
        status: node.status,
        value: typeof node.value === 'number' ? node.value : 0,
        visits: typeof node.visits === 'number' ? node.visits : 0,
        action: typeof node.action === 'string' ? node.action : null,
      }];
    });
  }

  async listJobs(limit = 20): Promise<AgentJobSummary[]> {
    const jobs = await listCloudJobs(this.origin, this.token, this.cloudName, limit);
    return jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status }));
  }

  async getModelSpec(): Promise<string | null> {
    return (await getCloudAgentModel(this.origin, this.token, this.cloudName)).spec;
  }

  async setModel(spec: string): Promise<{ spec: string }> {
    return { spec: (await setCloudAgentModel(this.origin, this.token, this.cloudName, spec)).spec };
  }

  async listModels(): Promise<AgentModelEntry[]> {
    const rows = normalizeModelEntries(await listCloudAvailableModels(this.origin, this.token));
    if (rows.length === 0) throw new Error('No cloud models are available.');
    return dedupeModelEntries(rows);
  }

  private emit(event: AgentClientEvent): void {
    recordAgentClientEvent(this.activeCliSession, event, 'cloud');
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a render error must not kill the stream */ }
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
      this.failInFlight(new Error('Cloud agent connection closed.'));
    });
    ws.addEventListener('error', () => {
      this.failInFlight(new Error('Cloud agent connection failed.'));
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to cloud agent.')), 15_000);
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
    const payload = parseSocketJson(event.data);
    if (!payload) return;

    if (payload.type === 'rpc' && typeof payload.id === 'string') {
      const pending = this.pendingRpcs.get(payload.id);
      if (!pending) return;
      this.pendingRpcs.delete(payload.id);
      if (payload.success === true) pending.resolve(payload.result);
      else pending.reject(new Error(typeof payload.error === 'string' && payload.error ? payload.error : 'Cloud agent RPC failed.'));
      return;
    }

    // Ack a resuming stream only when it is one of our own turns, so the DO
    // replays its chunks after a reconnect; other clients' streams are ignored.
    if (payload.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING && typeof payload.id === 'string') {
      if (this.activeTurns.has(payload.id)) {
        this.ws?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: payload.id }));
      }
      return;
    }

    if (payload.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || typeof payload.id !== 'string') return;
    const active = this.activeTurns.get(payload.id);
    if (!active) return;
    if (payload.error) {
      this.activeTurns.delete(payload.id);
      const message = typeof payload.body === 'string' && payload.body ? payload.body : 'Cloud agent stream failed.';
      this.emit({ type: 'error', message });
      this.settleTurn(active, true);
      return;
    }
    if (typeof payload.body === 'string' && payload.body.trim()) {
      this.applyChunk(active, payload.body);
    }
    if (payload.done) {
      this.activeTurns.delete(payload.id);
      this.settleTurn(active);
    }
  }

  private applyChunk(active: ActiveTurn, body: string): void {
    let chunk: unknown;
    try { chunk = JSON.parse(body); }
    catch { return; }
    if (!isRecord(chunk) || typeof chunk.type !== 'string') return;
    switch (chunk.type) {
      case 'text-delta': {
        const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
        if (!delta) return;
        active.text += delta;
        this.emit({ type: 'text-delta', delta });
        return;
      }
      case 'tool-input-available': {
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : 'tool';
        const call = { name: toolName, args: chunk.input, result: undefined };
        active.toolCalls.push(call);
        if (typeof chunk.toolCallId === 'string') active.toolById.set(chunk.toolCallId, call);
        this.emit({ type: 'tool-call', toolName, args: asRecord(chunk.input) });
        return;
      }
      case 'tool-output-available':
      case 'tool-output-error': {
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
        const call = active.toolById.get(toolCallId);
        const result = chunk.type === 'tool-output-error'
          ? String(chunk.errorText ?? 'tool error')
          : stringifyToolOutput(chunk.output);
        if (call) call.result = result;
        this.emit({ type: 'tool-result', toolName: call?.name ?? 'tool', result });
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

function parseSocketJson(data: unknown): Record<string, unknown> | null {
  try {
    const text = typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(data)
          : String(data);
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringifyToolOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function randomRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
