import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  ADVISOR_SEVERITIES,
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  JsonValueSchema,
  ORCHESTRATOR_AGENT_SLUG,
  SUBORDINATE_AGENT_SLUG,
  decodeJsonValue,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
  REFINEMENT_DISPOSITIONS, REFINEMENT_EDIT_KINDS, REFINEMENT_SCOPES, REFINEMENT_STAGES,
  REFINEMENT_TRIGGERS,
  type RefinementDecisionInput, type RefinementDecisionResult, type RefinementRequestView,
  type StagedSkillResult,
} from '@kinu.run/core';
import { renderThrownChain, tolerate } from '@kinu.run/core/obs';
import type {
  CheckpointAvailability, FileCheckpointEntry, FileCheckpointListing,
  FileRestorePlan, FileRestoreResult,
} from '@kinu.run/core';
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
  type CliSession,
  type CliSessionOptions,
} from './session';
import { CloudTurnStream, jsonErrorMessage } from './cloud-turn-stream';
import { SessionRecorder } from './session-recorder';
import { normalizeModelMenu, type AgentModelMenu } from './model-catalog';
import { pageSchema, type Page, type SeekCursor } from '@kinu.run/core';
import type { AlternateTakeSet, BranchStatusEvent, ChangelogEntry, ChangelogRevertResult, EvolutionConfigView, ReasoningEffort, TakePickOutcome } from '@kinu.run/core';
import {
  createUserUiMessage,
  findForkPivot,
  promptFiles,
  promptText,
  type AgentChangelogView,
  type AgentRefinementView,
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
const EvolutionConfigSchema: v.GenericSchema<EvolutionConfigView> = v.object({
  reviewModel: v.nullable(v.string()),
  autoPromoteScaffold: v.boolean(),
  gepaEvalBudget: v.number(),
  shadowSampleRate: v.number(),
  scaffoldExploreShare: v.number(),
  advisorEnabled: v.boolean(),
  advisorMinSeverity: v.picklist(ADVISOR_SEVERITIES),
});
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
/** Both additional-agent calls answer with the slug to address the agent by
 *  and its shown title, which is empty until something names it. */
const AdditionalAgentSchema = v.object({ name: v.string(), displayName: v.string() });
const AdditionalAgentEnvelopeSchema = v.object({
  subordinate: AdditionalAgentSchema,
});
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
/** The refinement surface as the wire carries it. Optional-with-default on
 *  every field for the same reason the changelog's schema is: an older
 *  workspace answering a newer client must degrade to an empty listing rather
 *  than to a parse failure the operator cannot act on. */
const RefinementRouteSchema = v.object({
  kind: v.picklist(REFINEMENT_EDIT_KINDS),
  owner: v.optional(v.string(), ''),
  target: v.optional(v.string(), ''),
  disposition: v.picklist(REFINEMENT_DISPOSITIONS),
  reason: v.optional(v.string()),
});
const RefinementRequestViewSchema: v.GenericSchema<unknown, RefinementRequestView> = v.object({
  id: v.string(),
  trigger: v.picklist(REFINEMENT_TRIGGERS),
  scope: v.picklist(REFINEMENT_SCOPES),
  stage: v.picklist(REFINEMENT_STAGES),
  turnIds: v.optional(v.array(v.string()), []),
  routes: v.optional(v.array(RefinementRouteSchema), []),
  detail: v.optional(v.string(), ''),
  createdAt: v.optional(v.number(), 0),
});
const StagedSkillResultSchema: v.GenericSchema<unknown, StagedSkillResult> = v.variant('ok', [
  v.object({
    ok: v.literal(true),
    view: v.object({
      requestId: v.string(),
      routeIndex: v.number(),
      target: v.string(),
      digest: v.string(),
      source: v.string(),
      intact: v.optional(v.boolean(), false),
    }),
  }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);
const RefinementDecisionResultSchema: v.GenericSchema<unknown, RefinementDecisionResult> = v.variant(
  'ok',
  [
    v.object({ ok: v.literal(true), request: RefinementRequestViewSchema, detail: v.string() }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ],
);
const RefinementViewSchema: v.GenericSchema<unknown, AgentRefinementView> = v.object({
  requests: v.optional(v.array(RefinementRequestViewSchema), []),
  debt: v.object({
    turnIds: v.optional(v.array(v.string()), []),
    owed: v.optional(v.boolean(), false),
    key: v.optional(v.string(), ''),
    summary: v.optional(v.string(), ''),
  }),
});
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
  /** Set by the DO on every frame of a stream it replays. */
  replay: v.optional(v.boolean()),
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
  /** Direct facet beneath `cloudName`, when this client is an additional
   * agent rather than the root workspace conversation. */
  subordinateName?: string;
  /** Recorder controls for this process's diagnostic transcript. */
  transcript?: CliSessionOptions;
  /** One task turn, then exit. Stamped on each chat request so the DO knows
   *  this prompt is an independent task rather than a conversational
   *  follow-up, and never grades the previous turn from it. */
  oneShot?: boolean;
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
  readonly rename?: (displayName: string) => Promise<{ name: string; displayName: string }>;

  private readonly origin: string;
  private readonly token: string;
  private readonly cloudName: string;
  private readonly subordinateName: string | null;
  private readonly oneShot: boolean;
  private readonly transcriptOptions: CliSessionOptions;
  private activeCliSession: CliSession;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private readonly recorder = new SessionRecorder('cloud');
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  /** Set by `close()`: the caller is done with this client, so a socket that
   *  dies afterwards must not reconnect to rebind anything. */
  private closed = false;
  private readonly activeTurns = new Map<string, CloudTurnStream>();
  /** In-flight @callable RPCs over the agent websocket ({type:'rpc'} frames). */
  private readonly pendingRpcs = new Map<string, { resolve: (value: JsonValue) => void; reject: (err: Error) => void }>();
  /** Chat streams cancelled by Stop remain visible until the actor confirms its
   * durable cancellation sweep has finished. */
  private readonly stoppingTurnIds = new Set<string>();
  private stopPromise: Promise<void> | null = null;

  constructor(opts: CloudAgentClientOptions) {
    this.origin = opts.origin;
    this.token = opts.token;
    this.agentName = opts.agentName;
    this.cloudName = opts.cloudName;
    this.subordinateName = opts.subordinateName ?? null;
    const subordinateName = this.subordinateName;
    if (subordinateName) {
      this.rename = (displayName) => this.renameAdditionalAgent(subordinateName, displayName);
    }
    this.oneShot = opts.oneShot === true;
    this.transcriptOptions = opts.transcript ?? {};
    this.activeCliSession = createCliSession(opts.agentName, this.transcriptOptions);
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
    void this.submit(prompt, opts, true).catch((err: unknown) => {
      this.emit({ type: 'error', message: renderThrownChain({ cause: err }) });
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
      .catch((err: unknown) => fail(renderThrownChain({ cause: err })));
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
      const turn = new CloudTurnStream((event) => this.emit(event), resolve);
      this.activeTurns.set(requestId, turn);

      try {
        const body: JsonObject = {
          messages: [decodeJsonValue({ value: createUserUiMessage(text, files) })],
          trigger: 'submit-message',
        };
        if (opts.cwd) body.cwd = opts.cwd;
        if (opts.tier) body.tier = opts.tier;
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
        this.emit({ type: 'error', message: renderThrownChain({ cause: err }) });
        turn.settle(true);
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
      transcript: {
        transcriptDir: this.transcriptOptions.transcriptDir,
        noTranscript: this.transcriptOptions.noTranscript,
      },
    });
    return { client: sibling, label: `agent ${forkName}` };
  }

  /** Invoke a named agent method over the generic HTTP RPC transport —
   *  for surfaces that must not force a websocket open (consents polling,
   *  history, status). Live-session ops (branch, fork, takes, checkpoints)
   *  ride callRpc on the already-open socket instead. */
  private callHttp<T>(method: string, schema: v.GenericSchema<T>, args: JsonValue[] = []): Promise<T> {
    if (this.subordinateName) {
      return this.callRpc(method, args).then((result) => v.parse(schema, result));
    }
    return this.callParentHttp(method, schema, args);
  }

  private callParentHttp<T>(method: string, schema: v.GenericSchema<T>, args: JsonValue[] = []): Promise<T> {
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

  /** Cancel in-flight turns through the SDK stream control and the actor's
   * durable cancellation authority. The SDK frame aborts the active chat
   * request; the actor RPC awaits every foreground device outcome. */
  stop(): string[] {
    const ws = this.ws;
    for (const id of this.activeTurns.keys()) {
      try {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL, id }));
        }
      } catch (error) {
        this.emit({
          type: 'error',
          message: `Could not signal stream cancellation: ${renderThrownChain({ cause: error })}`,
        });
      }
      this.stoppingTurnIds.add(id);
    }
    if (this.stoppingTurnIds.size > 0 && !this.stopPromise) {
      this.stopPromise = this.callRpc('cancelCurrentWork', [])
        .then(() => undefined)
        .catch((err: unknown) => {
          this.emit({ type: 'error', message: renderThrownChain({ cause: err }) });
        })
        .finally(() => {
          this.stopPromise = null;
          this.settleStoppedTurns();
        });
    }
    return [];
  }

  private settleStoppedTurns(): void {
    for (const id of this.stoppingTurnIds) {
      this.stoppingTurnIds.delete(id);
      const turn = this.activeTurns.get(id);
      if (!turn) continue;
      this.activeTurns.delete(id);
      turn.settle();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
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

  async status(): Promise<AgentClientStatus> {
    const status = await this.callHttp('getAgentStatus', CloudAgentStatusSchema);
    return {
      name: status.displayName ?? status.name,
      purpose: status.purpose,
      model: status.model ?? null,
      reasoningEffort: status.reasoningEffort ?? null,
      roleId: status.roleId,
      tierId: status.tierId,
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
        message: `Could not mark the changelog as seen: ${renderThrownChain({ cause: error })}`,
      });
    }
    return view;
  }

  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    return v.parse(ChangelogRevertResultSchema, await this.callRpc('revertChangelogEntry', [id]));
  }

  async refinements(limit?: number): Promise<AgentRefinementView> {
    return v.parse(RefinementViewSchema, await this.callRpc('listRefinements', [limit ?? 20]));
  }

  async requestRefinement(opts?: { turnIds?: readonly string[] }): Promise<RefinementRequestView> {
    return v.parse(RefinementRequestViewSchema, await this.callRpc('requestRefinement', [
      opts?.turnIds === undefined ? {} : { turnIds: [...opts.turnIds] },
    ]));
  }

  async decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult> {
    return v.parse(
      RefinementDecisionResultSchema,
      // Spelled out field by field rather than forwarded: the RPC argument
      // channel is JSON, and a readonly interface is not one.
      await this.callRpc('decideRefinement', [{
        requestId: input.requestId,
        routeIndex: input.routeIndex,
        expectedDigest: input.expectedDigest,
        decision: input.decision,
      }]),
    );
  }

  async showRefinement(requestId: string, routeIndex: number): Promise<StagedSkillResult> {
    return v.parse(
      StagedSkillResultSchema,
      await this.callRpc('showRefinement', [requestId, routeIndex]),
    );
  }

  async latestTakes(): Promise<AlternateTakeSet | null> {
    return v.parse(v.nullable(AlternateTakeSetSchema), await this.callRpc('latestAlternateTakes', []));
  }

  async pickTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    return v.parse(TakePickOutcomeSchema, await this.callRpc('pickAlternateTake', [takeId, nodeId]));
  }

  async setRole(roleId: string): Promise<{ role: string }> {
    return v.parse(v.object({ role: v.string() }), await this.callRpc('setRole', [roleId]));
  }

  /** Add an agent to this workspace with nothing said about it: it inherits
   *  the workspace's mission and comes back with a BLANK `displayName`, which
   *  its first owner message replaces. `name` is the slug to open it by. */
  async createAdditionalAgent(): Promise<{ name: string; displayName: string }> {
    const result = this.subordinateName
      ? await this.callParentHttp('createSubordinateAgent', AdditionalAgentSchema)
      : v.parse(AdditionalAgentSchema, await this.callRpc('createSubordinateAgent', []));
    return result;
  }

  /** Open the direct facet socket for an additional agent while retaining the
   * parent workspace name for ticket scope and parent-owned actions. */
  openAdditionalAgent(name: string): CloudAgentClient {
    return new CloudAgentClient({
      origin: this.origin,
      token: this.token,
      agentName: name,
      cloudName: this.cloudName,
      subordinateName: name,
      transcript: this.transcriptOptions,
    });
  }

  /** Name one of this workspace's agents. The title becomes the owner's and is
   *  never auto-replaced afterwards. */
  async renameAdditionalAgent(name: string, displayName: string): Promise<{ name: string; displayName: string }> {
    const result = await this.callParentHttp(
      'renameSubordinateAgent',
      AdditionalAgentEnvelopeSchema,
      [name, displayName],
    );
    return result.subordinate;
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

  async getEvolutionConfig(): Promise<EvolutionConfigView> {
    return await this.callHttp('getEvolutionConfig', EvolutionConfigSchema);
  }

  async setEvolutionConfig(view: Partial<EvolutionConfigView>): Promise<EvolutionConfigView> {
    return await this.callHttp('setEvolutionConfig', EvolutionConfigSchema, [decodeJsonValue({ value: view })]);
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

  private async ensureOpen(): Promise<void> {
    if (this.closed) throw new Error('Cloud workspace client is closed.');
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) {
      await this.connectPromise;
      if (this.closed) throw new Error('Cloud workspace client closed while connecting.');
      return;
    }
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
      if (this.closed) throw new Error('Cloud workspace client closed while connecting.');
    } finally {
      this.connectPromise = null;
    }
  }

  private async openSocket(): Promise<void> {
    if (this.closed) throw new Error('Cloud workspace client is closed.');
    const { ticket } = await createCloudAgentConnectTicket(this.origin, this.token, this.cloudName);
    if (this.closed) throw new Error('Cloud workspace client closed while creating its connect ticket.');
    const actorPath = this.subordinateName
      ? `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(this.cloudName)}`
        + `/sub/${SUBORDINATE_AGENT_SLUG}/${encodeURIComponent(this.subordinateName)}`
      : `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(this.cloudName)}`;
    const url = new URL(actorPath, this.origin.replace(/\/+$/, ''));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);

    const ws = new WebSocket(url.toString());
    this.ws = ws;
    ws.addEventListener('message', (event) => this.handleMessage(event));
    // ONE drop per socket generation: a dying socket fires `error` and then
    // `close`, and handling both would report the same drop twice — which, on
    // the rebind path below, reads as a turn that failed to rebind twice.
    let dropped = false;
    const onDrop = (): void => {
      if (dropped) return;
      dropped = true;
      if (this.ws === ws) this.ws = null;
      this.failPendingRpcs(new Error('Cloud workspace connection closed.'));
      void this.rebindInFlightTurns().catch((cause: unknown) => {
        this.failInFlight(new Error(
          `Could not reconnect to resume this cloud turn: ${renderThrownChain({ cause })}`,
          { cause },
        ));
      });
    };
    ws.addEventListener('close', onDrop);
    ws.addEventListener('error', onDrop);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to cloud workspace.')), 15_000);
      const settle = (outcome: () => void): void => {
        clearTimeout(timeout);
        outcome();
      };
      ws.addEventListener('open', () => {
        settle(resolve);
      }, { once: true });
      ws.addEventListener('error', () => {
        settle(() => reject(new Error('Could not connect to cloud agent.')));
      }, { once: true });
      ws.addEventListener('close', () => {
        settle(() => reject(new Error('Cloud workspace connection closed before it opened.')));
      }, { once: true });
    });
    if (this.closed) {
      ws.close();
      throw new Error('Cloud workspace client closed while connecting.');
    }
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
      const resuming = this.activeTurns.get(payload.id);
      if (resuming) this.ackResume(payload.id, resuming);
      return;
    }

    // The DO holds no stream for us. Every turn still waiting on the rebind is
    // therefore already settled up there, so ack it: with no active stream the
    // ack path replays a retained completed stream, replays a pending terminal,
    // or answers a bare terminal frame — so the turn always ends.
    if (payload.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE) {
      for (const [id, turn] of this.activeTurns) {
        if (turn.awaitingRebind) this.ackResume(id, turn);
      }
      return;
    }

    // Accepted, not streaming yet. The DO guarantees a later STREAM_RESUMING or
    // STREAM_RESUME_NONE, so continuing to wait IS the handling — there is
    // nothing here for this client to time out against.
    if (payload.type === CHAT_MESSAGE_TYPES.STREAM_PENDING) return;

    if (payload.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || !payload.id) return;
    const active = this.activeTurns.get(payload.id);
    if (!active) return;
    // A frame for this turn is its stream bound to the live socket again —
    // read before it is cleared, because the terminal branch below needs to
    // know whether ANYTHING rebound before the stream ended.
    const unbound = active.awaitingRebind;
    active.awaitingRebind = false;
    if (payload.error) {
      if (this.stoppingTurnIds.has(payload.id)) return;
      this.activeTurns.delete(payload.id);
      const message = payload.body || 'Cloud agent stream failed.';
      this.emit({ type: 'error', message });
      active.settle(true);
      return;
    }
    if (payload.body?.trim()) active.apply(payload.body, payload.replay === true);
    if (payload.done) {
      if (this.stoppingTurnIds.has(payload.id)) return;
      this.activeTurns.delete(payload.id);
      // A REPLAYED terminal that is the FIRST frame back is the DO saying it
      // holds no stream under this id: nothing rebound, so whatever this
      // process had is all there is. Settling it as a clean turn would present
      // a truncated answer — or no answer — as a complete one.
      if (payload.replay === true && unbound) {
        this.emit({
          type: 'error',
          message: 'The cloud workspace holds no resumable stream under this turn\'s request id.'
            + ' Read the workspace transcript before sending it again.',
        });
        active.settle(true);
      } else {
        active.settle();
      }
      // This stream ending is the DO going idle behind it: re-probe so a turn
      // still unbound after the drop gets answered instead of waiting behind
      // the stream that was in front of it.
      for (const turn of this.activeTurns.values()) {
        if (!turn.awaitingRebind) continue;
        this.requestStreamResume();
        break;
      }
    }
  }

  private failInFlight(error: Error): void {
    const active = [...this.activeTurns.values()];
    this.activeTurns.clear();
    if (active.length > 0) this.emit({ type: 'error', message: error.message });
    for (const turn of active) turn.settle(true);
    this.failPendingRpcs(error);
  }

  /** Reject what the dead socket was carrying that is NOT durable up there: an
   *  RPC is request/reply, nothing replays it, so its caller has to hear. */
  private failPendingRpcs(error: Error): void {
    const rpcs = [...this.pendingRpcs.values()];
    this.pendingRpcs.clear();
    for (const rpc of rpcs) rpc.reject(error);
  }

  /**
   * A socket carrying acknowledged turns died — rebind them, never drop them.
   *
   * The DO persisted each turn as it accepted it and keeps its stream
   * resumable, so the turn is still running: what died is this process's
   * binding to it. Reconnecting and probing re-establishes that binding, and
   * nothing is re-submitted — the handshake replays the stream the DO already
   * has, so a rebind cannot produce a second turn.
   *
   * A turn that was ALREADY awaiting a rebind made no progress on the socket it
   * just lost, so it is reported rather than chased: its answer is durable in
   * the workspace transcript either way.
   */
  private async rebindInFlightTurns(): Promise<void> {
    if (this.closed || this.activeTurns.size === 0) return;
    // Iterated live rather than over a snapshot: a Map iterator tolerates the
    // deletion of the entry it is standing on, which is the only one deleted
    // here, so the copy bought nothing.
    for (const [id, turn] of this.activeTurns) {
      if (!turn.awaitingRebind) continue;
      this.activeTurns.delete(id);
      this.emit({
        type: 'error',
        message: 'The cloud workspace connection dropped again before this turn could be resumed.'
          + ' It is still running there — its answer lands in the workspace transcript.',
      });
      turn.settle(true);
    }
    if (this.activeTurns.size === 0) return;
    for (const turn of this.activeTurns.values()) {
      turn.awaitingRebind = true;
      turn.resumeAcked = false;
    }
    await this.ensureOpen();
    this.requestStreamResume();
  }

  /** Answer one STREAM_RESUMING, or claim a settled turn's retained replay.
   *  At most once per socket generation per turn: the DO replays the whole
   *  buffer per ack, and the turn's replay accounting spans exactly one. */
  private ackResume(requestId: string, turn: CloudTurnStream): void {
    if (turn.resumeAcked) return;
    turn.resumeAcked = true;
    turn.beginReplay();
    this.ws?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: requestId }));
  }

  /** Ask the DO what it still holds for us. It answers STREAM_RESUMING (a
   *  stream to ack), STREAM_PENDING (accepted, not streaming yet — a RESUMING
   *  or RESUME_NONE follows) or STREAM_RESUME_NONE, so the probe resolves on
   *  the DO's own state rather than on a clock here. */
  private requestStreamResume(): void {
    this.ws?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST }));
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

function randomRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
