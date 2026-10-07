import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  ADVISOR_SEVERITIES,
  CHANGELOG_ENTRY_KINDS,
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  JsonValueSchema,
  PlanReviewSchema,
  ChatHistoryEntrySchema, SendStateSchema, type SendState,
  ORCHESTRATOR_AGENT_SLUG,
  hostedActorSocketPath,
  decodeJsonValue,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
  REFINEMENT_DISPOSITIONS, REFINEMENT_EDIT_KINDS, REFINEMENT_SCOPES, REFINEMENT_STAGES,
  REFINEMENT_TRIGGERS,
  type RefinementDecisionInput, type RefinementDecisionResult, type RefinementRequestView,
  type StagedSkillResult,
  type ModelTestResult,
} from '@kinu.run/core';
import { attempt, detach, diagnostics, renderThrownChain, settle, tolerate } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import {
  AlternateTakeCandidateSchema, CheckpointAvailabilitySchema, FileCheckpointEntrySchema, FileRestorePlanSchema,
  FileRestoreResultSchema, type FileCheckpointListing, type PlanReviewResult, type WorkspaceSpend,
} from '@kinu.run/core';
import {
  ActivitySpendSchema,
  callAgentRpc,
  CloudAgentStatusSchema,
  CancelJobSchema,
  CloudBackgroundJobSchema,
  CloudToolDescriptionsSchema,
  createCloudAgentConnectTicket,
  listCloudAvailableModels,
  testCloudModel,
} from './cloud-api';
import {
  createCliSession,
  type CliSession,
  type CliSessionOptions,
} from './session';
import { CloudTurnStream, jsonErrorMessage } from './cloud-turn-stream';
import { SessionRecorder } from './session-recorder';
import { cloudFileLinks, JobOutputFrameSchema, LIVE_READS, READS_CHANGED_EVENT, type AgentModelMenu, type AgentRpcMethod, type FileLinks } from '@kinu.run/core';
import { hostedWindowCalls, positionPageSchema, SubordinateInspectionRequestSchema, SubordinateInspectionResultSchema, WorkspaceWorkSchema, type WorkspaceWork, type SubordinateInspectionRequest, type SubordinateInspectionResult } from '@kinu.run/core';
import type { AlternateTakeSet, BranchStatusEvent, ChangelogEntry, ChangelogRevertResult, EvolutionConfigView, ReasoningEffort, TakePickOutcome } from '@kinu.run/core';
import {
  createUserUiMessage,
  findForkPivot,
  readConversation,
  recordedAnswer,
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
  type AgentSendResult,
  type DeviceConsentSurface,
  type FileCheckpointSurface,
  type ForkPoint,
  type PendingDeviceConsent,
  type PlanReviewSurface,
} from './agent-client';
import * as v from 'valibot';


const ReasoningEffortSchema = v.picklist(['low', 'medium', 'high'] satisfies ReasoningEffort[]);

const EvolutionConfigSchema: v.GenericSchema<EvolutionConfigView> = v.object({
  learning: v.boolean(),
  liveTrials: v.boolean(),
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

const FileCheckpointListingSchema: v.GenericSchema<FileCheckpointListing> = v.object({
  availability: CheckpointAvailabilitySchema,
  entries: v.array(FileCheckpointEntrySchema),
});

/** Core's own `PlanReviewSchema`, so a forged annotation cannot arrive by a route the workspace UI lacks. */
const CloudPlanReviewSchema = v.nullable(PlanReviewSchema);

const CloudPlanReviewResultSchema: v.GenericSchema<unknown, PlanReviewResult> = v.variant('ok', [
  v.object({ ok: v.literal(true), plan: PlanReviewSchema }),
  v.object({ ok: v.literal(false), error: v.string(), plan: CloudPlanReviewSchema }),
]);

const CloudChatPageSchema = positionPageSchema(ChatHistoryEntrySchema);

const BranchTurnResultSchema = v.nullable(v.object({
  accepted: v.optional(v.boolean()),
  reason: v.optional(v.string()),
}));

const AdditionalAgentSchema = v.object({ name: v.string(), displayName: v.string() });

const AdditionalAgentEnvelopeSchema = v.object({
  subordinate: AdditionalAgentSchema,
});

const ChangelogRevertActionSchema = v.variant('type', [
  v.object({ type: v.literal('scaffold_rollback'), target: v.string() }),
  v.object({ type: v.literal('fact_forget'), target: v.string() }),
  v.object({ type: v.literal('fact_forget_many'), targets: v.array(v.string()) }),
]);

const ChangelogEntrySchema: v.GenericSchema<ChangelogEntry> = v.lazy(() => v.object({
  id: v.string(),
  kind: v.picklist(CHANGELOG_ENTRY_KINDS),
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

/** Optional-with-default fields so an older workspace degrades to an empty listing, not a parse failure. */
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

const AlternateTakeSetSchema: v.GenericSchema<AlternateTakeSet> = v.object({
  id: v.string(),
  turnId: v.nullable(v.string()),
  sessionId: v.nullable(v.string()),
  task: v.string(),
  winnerNodeId: v.string(),
  chosenNodeId: v.nullable(v.string()),
  candidates: v.array(AlternateTakeCandidateSchema),
  createdAt: v.number(),
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

const ActorSnapshotSchema = v.object({
  displayName: v.string(),
  role: v.string(),
  mission: v.string(),
  model: v.object({ model: v.string() }),
  reasoningEffort: v.nullable(ReasoningEffortSchema),
});

const SetModelResultSchema = v.object({ ok: v.literal(true), spec: v.string() });

const ReasoningEffortResultSchema = v.object({ effort: v.nullable(ReasoningEffortSchema) });

const SetReasoningEffortResultSchema = v.object({ ok: v.literal(true), effort: ReasoningEffortSchema });

const ProviderAccountsResultSchema = v.object({ accounts: v.record(v.string(), v.string()) });

const SocketFrameSchema = v.objectWithRest({
  type: v.string(),
  id: v.optional(v.string()),
  success: v.optional(v.boolean()),
  result: v.optional(JsonValueSchema),
  error: v.optional(JsonValueSchema),
  body: v.optional(v.string()),
  done: v.optional(v.boolean()),
  landed: v.optional(v.picklist(['mid-turn', 'turn'])),
}, JsonValueSchema);

type SocketFrame = v.InferOutput<typeof SocketFrameSchema>;

/** A send's settled state, and the answer its own turn recorded; none for a splice or a turn that recorded none. */
interface SendEnd {
  readonly state: SendState;
  readonly answer: string | null;
}

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
    message: v.optional(v.string(), 'branch failed'),
  }),
]);

/** The executors read as chat links need it: a device fleet's live machines, by the segment each mounts under. */
const ExecutorMountsSchema = v.array(v.object({ mounts: v.optional(v.array(v.string())) }));

const BroadcastFrameSchema = v.union([
  BranchStatusEventSchema,
  v.object({ type: v.literal(READS_CHANGED_EVENT), reads: v.array(v.picklist(LIVE_READS)) }),
  JobOutputFrameSchema,
  v.object({ type: v.literal('model_fallback'), message: v.string() }),
  v.object({ type: v.literal('context_fill'), contextTokens: v.optional(v.number()), contextWindow: v.optional(v.number()) }),
]);

interface CloudAgentClientOptions {
  origin: string;
  token: string;
  agentName: string;
  cloudName: string;
  /** A hosted actor beneath `cloudName`, not a store of its own: the subordinate tree lives in the root's database. */
  subordinateName?: string;
  transcript?: CliSessionOptions;
  /** Stamped on each chat request so the DO never grades the previous turn from this prompt. */
  oneShot?: boolean;
}

/**
 * AgentClient over the OrchestratorAgent DO. Chat rides the agent websocket; other calls use the RPC
 * transport. The DO owns history and context: each send carries only the new user message.
 */
export class CloudAgentClient implements AgentClient {
  readonly mode = 'cloud' as const;
  readonly agentName: string;
  readonly consents: DeviceConsentSurface;
  readonly localControls = null;
  readonly checkpoints: FileCheckpointSurface | null;
  readonly plans: PlanReviewSurface | null;
  readonly inlineAttachmentLimitBytes = CLOUD_MAX_INLINE_ATTACHMENT_BYTES;
  readonly planes = null;
  readonly rename?: (displayName: string) => Promise<{ name: string; displayName: string }>;

  private readonly origin: string;
  private readonly token: string;
  private readonly cloudName: string;
  private readonly subordinateName: string | null;
  private readonly oneShot: boolean;
  private readonly transcriptOptions: CliSessionOptions;
  private readonly activeCliSession: CliSession;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private readonly recorder = new SessionRecorder('cloud');
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  /** A socket that dies after close() must not reconnect. */
  private closed = false;
  private readonly activeTurns = new Map<string, CloudTurnStream>();
  /** Turns whose connection dropped, asked of the workspace instead of read off their stream. */
  private readonly reacquiring = new Set<string>();
  private readonly pendingRpcs = new Map<string, { resolve: (value: JsonValue) => void; reject: (err: Error) => void }>();
  /** Kept visible until the actor confirms its durable cancellation sweep. */
  private readonly stoppingTurnIds = new Set<string>();
  private stopPromise: Promise<void> | null = null;
  /** Held until the submission or RPC ack reaches the event stream; ids keep cleanup identity-safe. */
  private readonly launchedTasks = new Map<string, Promise<void>>();
  /** Every prefix, and each live machine's own name once {@link readMachines} has listed them. */
  private links: FileLinks;

  constructor(opts: CloudAgentClientOptions) {
    this.origin = opts.origin;
    this.links = cloudFileLinks(opts.origin, opts.cloudName);
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
    this.checkpoints = subordinateName ? null : {
      list: async (limit, turnId) => v.parse(
        FileCheckpointListingSchema,
        await this.callRpc('listFileCheckpoints', [limit ?? 50, turnId ?? null]),
      ),
      plan: async (dir, id) => v.parse(FileRestorePlanSchema, await this.callRpc('planFileRestore', [dir, id])),
      restore: async (dir, id) => v.parse(
        FileRestoreResultSchema, await this.callRpc('restoreFileCheckpoint', [dir, id]),
      ),
    };
    // The sealed plan RPCs (`agent-rpc-access.ts`).
    this.plans = subordinateName ? null : {
      active: async () => v.parse(CloudPlanReviewSchema, await this.callRpc('getActivePlanReview', [])),
      saveAnnotations: async (id, revision, annotations) => v.parse(
        CloudPlanReviewResultSchema,
        await this.callRpc('savePlanReviewAnnotations', [id, revision, v.parse(JsonValueSchema, annotations)]),
      ),
      decide: async (id, revision, decision, feedback) => v.parse(
        CloudPlanReviewResultSchema,
        await this.callRpc('decidePlanReview', [id, revision, decision, feedback ?? null]),
      ),
      dismiss: async (id, revision) => v.parse(CloudPlanReviewResultSchema, await this.callRpc('dismissPlanReview', [id, revision])),
    };
  }

  get cliSession(): CliSession {
    return this.activeCliSession;
  }

  get fileLinks(): FileLinks {
    return this.links;
  }

  /** The socket opens on first use; connecting reads which machines a chat links by their own name. */
  async connect(): Promise<void> {
    await this.readMachines();
  }

  /**
   * Re-reads the live machines, so `<name>://` references link; on connect, and before reporting that the executors
   * moved. A window that may not read them links none, and a read that fails keeps the names already read.
   */
  readMachines(): Promise<void> {
    if (!this.mayCall('getExecutors')) return Promise.resolve();

    const read = attempt(
      { doing: 'reading the workspace\'s machines for chat links', otherwise: 'unavailable' },
      () => this.callHttp('getExecutors', ExecutorMountsSchema),
    );

    return settle(Effect.match(read, {
      onSuccess: (executors) => { this.links = cloudFileLinks(this.origin, this.cloudName, executors.flatMap((executor) => executor.mounts ?? [])); },
      onFailure: (unread) => { diagnostics.failure('chat.machines_unread', unread); },
    }));
  }

  subscribe(listener: (event: AgentClientEvent) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** A submit arriving mid-turn is routed through the server inbox and answered with where it landed. */
  async send(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): Promise<AgentSendResult> {
    return this.submit(prompt, opts, this.activeTurns.size > 0);
  }

  branch(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): boolean {
    if (this.activeTurns.size === 0 || !this.mayCall('branchTurn')) return false;
    const text = promptText(prompt).trim();

    if (!text) return false;
    this.activeCliSession.append('user', { text, branched: true, cwd: opts.cwd ?? process.cwd(), backend: 'cloud' });

    const fail = (message: string) => {
      const event: BranchStatusEvent = { type: 'branch_status', status: 'error', branchId: '', task: text, message };
      this.emit({ type: 'broadcast', event });
    };

    const taskId = randomRequestId();
    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        const result = await this.callRpc('branchTurn', [text]);
        const r = v.parse(BranchTurnResultSchema, result);

        if (!r?.accepted) fail(r?.reason ?? 'The cloud agent rejected the branch.');
      } catch (cause) {
        fail(renderThrownChain({ cause }));
      } finally {
        if (this.launchedTasks.get(taskId) === task) this.launchedTasks.delete(taskId);
      }
    })();
    this.launchedTasks.set(taskId, task);

    return true;
  }

  private async submit(prompt: AgentPrompt, opts: AgentClientSendOptions, steered: boolean): Promise<AgentSendResult> {
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

    // A message to a running turn starts no turn; turn-start is announced only if a stream comes back.
    if (!steered) this.emit({ type: 'turn-start', kind: 'user', text });

    const requestId = randomRequestId();

    return await new Promise<AgentSendResult>((resolve) => {
      const turn = new CloudTurnStream((event) => this.emit(event), resolve, { deferStart: steered ? text : null });
      this.activeTurns.set(requestId, turn);

      try {
        const body: JsonObject = {
          messages: [decodeJsonValue({ value: createUserUiMessage(requestId, text, files, opts.mode) })],
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
        this.activeTurns.delete(requestId);
        this.emit({ type: 'error', message: renderThrownChain({ cause: err }) });
        turn.settle(true);
      }
    });
  }

  async fork(point: ForkPoint): Promise<AgentForkResult> {
    if (this.activeTurns.size > 0) throw new Error('Cannot fork while a turn is running.');
    const rows = await this.history();
    const pivotRow = rows[findForkPivot(rows, point)];

    if (pivotRow === undefined) throw new Error("Could not locate that message in the agent's chat history.");
    await this.callRpc('revertConversation', [pivotRow.id]);

    return { client: this, label: `before ${pivotRow.id}` };
  }

  /** For surfaces that must not force a websocket open; live-session ops use callRpc. */
  private callHttp<T>(method: AgentRpcMethod, schema: v.GenericSchema<T>, args: JsonValue[] = []): Promise<T> {
    if (this.subordinateName) {
      return this.callRpc(method, args).then((result) => v.parse(schema, result));
    }

    return this.callParentHttp(method, schema, args);
  }

  private mayCall(method: AgentRpcMethod): boolean {
    return this.subordinateName === null || hostedWindowCalls(method);
  }

  private callParentHttp<Input, T = Input>(method: AgentRpcMethod, schema: v.GenericSchema<Input, T>, args: JsonValue[] = []): Promise<T> {
    return callAgentRpc({ origin: this.origin, token: this.token, name: this.cloudName, method, schema, args });
  }

  private async callRpc(method: AgentRpcMethod, args: JsonValue[]): Promise<JsonValue> {
    if (!this.mayCall(method)) throw new Error(`${method} is not available in an additional agent's session.`);
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

  /** The SDK frame aborts the chat request; the actor RPC awaits every foreground device outcome. */
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
      this.stopPromise = this.settleStoppedTurns();
    }

    return [];
  }

  private async settleStoppedTurns(): Promise<void> {
    try {
      await this.callRpc('cancelCurrentWork', []);
    } catch (cause) {
      this.emit({ type: 'error', message: renderThrownChain({ cause }) });
    } finally {
      this.stopPromise = null;

      for (const id of this.stoppingTurnIds) {
        this.stoppingTurnIds.delete(id);
        const turn = this.activeTurns.get(id);

        if (!turn) continue;
        this.activeTurns.delete(id);
        turn.settle();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failInFlight(new Error('Cloud workspace connection closed.'));
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
    await Promise.all([
      ...this.launchedTasks.values(),
      ...(this.stopPromise ? [this.stopPromise] : []),
    ]);
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    return readConversation((request) => this.historyPage(request));
  }

  private async historyPage(request: Parameters<Parameters<typeof readConversation>[0]>[0]): Promise<v.InferOutput<typeof CloudChatPageSchema>> {
    const name = this.subordinateName;

    if (name === null) {
      return await this.callHttp('getChatHistoryPage', CloudChatPageSchema, [request.cursor === undefined ? {} : { cursor: { before: request.cursor.before } }]);
    }

    const read = await this.inspectSubordinate({ path: [name], view: 'history', page: request });

    if (read.view !== 'history') throw new Error(read.view === 'missing' ? read.error : `the conversation read answered "${read.view}"`);

    return read.page;
  }

  private async ownSnapshot(name: string): Promise<v.InferOutput<typeof ActorSnapshotSchema>> {
    return v.parse(ActorSnapshotSchema, await this.callRpc('getActorSnapshot', [name]));
  }

  async status(): Promise<AgentClientStatus> {
    if (this.subordinateName !== null) {
      const own = await this.ownSnapshot(this.subordinateName);

      return { name: own.displayName, purpose: own.mission, model: own.model.model, reasoningEffort: own.reasoningEffort, roleId: own.role };
    }

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
      context: status.context ?? null,
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

  async changelog(): Promise<AgentChangelogView> {
    const result = v.parse(
      ChangelogViewSchema, await this.callRpc('getEvolutionChangelog', [{ limit: 50 }]),
    );

    const view: AgentChangelogView = {
      entries: result?.entries ?? [],
      unseenCount: result?.unseenCount ?? 0,
    };

    // A silently dropped ack leaves the digest unseen forever; report it through the error channel.
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

  async refinements(): Promise<AgentRefinementView> {
    return v.parse(RefinementViewSchema, await this.callRpc('listRefinements', [20]));
  }

  async requestRefinement(opts?: { turnIds?: readonly string[] }): Promise<RefinementRequestView> {
    return v.parse(RefinementRequestViewSchema, await this.callRpc('requestRefinement', [
      opts?.turnIds === undefined ? {} : { turnIds: [...opts.turnIds] },
    ]));
  }

  async decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult> {
    return v.parse(
      RefinementDecisionResultSchema,
      // Spelled out: the RPC argument channel is JSON and a readonly interface is not.
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
  async inspectSubordinate(request: SubordinateInspectionRequest): Promise<SubordinateInspectionResult> {
    const input = v.parse(SubordinateInspectionRequestSchema, request);

    return this.callParentHttp('inspectSubordinate', SubordinateInspectionResultSchema, [decodeJsonValue({ value: input })]);
  }

  async workspaceWork(): Promise<WorkspaceWork> {
    return this.callParentHttp('listWorkspaceWork', WorkspaceWorkSchema);
  }

  async latestTakes(): Promise<AlternateTakeSet | null> {
    if (!this.mayCall('latestAlternateTakes')) return null;

    return v.parse(v.nullable(AlternateTakeSetSchema), await this.callRpc('latestAlternateTakes', []));
  }

  async pickTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    return v.parse(TakePickOutcomeSchema, await this.callRpc('pickAlternateTake', [takeId, nodeId]));
  }

  async setRole(roleId: string): Promise<{ role: string }> {
    return v.parse(v.object({ role: v.string() }), await this.callRpc('setRole', [roleId]));
  }

  /** Inherits the workspace mission with a blank `displayName`; `name` is the slug to open it by. */
  async createAdditionalAgent(): Promise<{ name: string; displayName: string }> {
    const result = this.subordinateName
      ? await this.callParentHttp('createSubordinateAgent', AdditionalAgentSchema)
      : v.parse(AdditionalAgentSchema, await this.callRpc('createSubordinateAgent', []));

    return result;
  }

  /** Keeps the parent workspace name for ticket scope and parent-owned actions. */
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

  async listJobs(limit = 20, actor?: string): Promise<AgentJobSummary[]> {
    const owner = actor ?? this.subordinateName;
    const args: JsonValue[] = owner === null ? [limit] : [limit, owner];
    const jobs = await this.callHttp('listBackgroundJobs', v.array(CloudBackgroundJobSchema), args);

    return jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status, label: job.label ?? null, ...(job.output !== undefined && { output: job.output }) }));
  }

  async cancelJob(jobId: string): Promise<{ ok: boolean }> {
    return await this.callHttp('cancelBackgroundJob', CancelJobSchema, this.subordinateName === null ? [jobId] : [jobId, this.subordinateName]);
  }

  async getModelSpec(): Promise<string | null> {
    if (this.subordinateName !== null) return (await this.ownSnapshot(this.subordinateName)).model.model;

    return (await this.callHttp('getStoredModelSpec', ModelSpecSchema)).spec;
  }

  async setModel(spec: string): Promise<{ spec: string }> {
    const name = this.subordinateName;

    if (name !== null) return { spec: v.parse(SetModelResultSchema, await this.callRpc('setActorModel', [name, spec])).spec };

    return { spec: (await this.callHttp('setModel', SetModelResultSchema, [spec])).spec };
  }

  async getReasoningEffort(): Promise<ReasoningEffort | null> {
    if (this.subordinateName !== null) return (await this.ownSnapshot(this.subordinateName)).reasoningEffort;

    return (await this.callHttp('getReasoningEffort', ReasoningEffortResultSchema)).effort;
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }> {
    const args: JsonValue[] = this.subordinateName === null ? [effort] : [effort, this.subordinateName];

    return {
      effort: (await this.callHttp('setReasoningEffort', SetReasoningEffortResultSchema, args)).effort,
    };
  }

  async workspaceSpend(): Promise<WorkspaceSpend> {
    return (await this.callHttp('getActivitySnapshot', ActivitySpendSchema)).spend;
  }

  async getProviderAccounts(): Promise<Readonly<Record<string, string>>> {
    return (await this.callHttp('getProviderAccounts', ProviderAccountsResultSchema)).accounts;
  }

  async setProviderAccount(provider: string, account: string | null): Promise<Readonly<Record<string, string>>> {
    return (await this.callHttp('setProviderAccount', ProviderAccountsResultSchema, [provider, account])).accounts;
  }

  async getEvolutionConfig(): Promise<EvolutionConfigView> {
    return await this.callHttp('getEvolutionConfig', EvolutionConfigSchema);
  }

  async setEvolutionConfig(view: Partial<EvolutionConfigView>): Promise<EvolutionConfigView> {
    return await this.callHttp('setEvolutionConfig', EvolutionConfigSchema, [decodeJsonValue({ value: view })]);
  }

  async listModels(): Promise<AgentModelMenu> {
    const menu = await listCloudAvailableModels(this.origin, this.token);

    // Only an empty menu with no failures is an error; provider failures are reported to the picker.
    if (menu.models.length === 0 && menu.failures.length === 0) {
      throw new Error('No cloud models are available.');
    }

    return menu;
  }

  async testModel(spec: string, signal: AbortSignal): Promise<ModelTestResult> {
    return testCloudModel(this.origin, this.token, spec, signal);
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

    // The actor segment under the workspace room, shared with the browser and the edge. There is no child
    // Durable Object, so the SDK's facet hop answers not-found.
    const room = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(this.cloudName)}`;

    const actorPath = this.subordinateName
      ? `${room}/${hostedActorSocketPath(this.subordinateName)}`
      : room;

    const url = new URL(actorPath, this.origin.replace(/\/+$/, ''));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);

    const ws = new WebSocket(url.toString());
    this.ws = ws;
    ws.addEventListener('message', (event) => this.handleMessage(event));
    // One drop per socket generation: `error` then `close` would report it twice.
    let dropped = false;

    const onDrop = async (): Promise<void> => {
      if (dropped) return;
      dropped = true;

      if (this.ws === ws) this.ws = null;
      this.failPendingRpcs(new Error('Cloud workspace connection closed.'));
      await this.reacquireInFlightTurns();
    };

    const droppedConnection = () => detach(Effect.promise(onDrop));
    ws.addEventListener('close', droppedConnection);
    ws.addEventListener('error', droppedConnection);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to cloud workspace.')), 15_000);

      const finish = (outcome: () => void): void => {
        clearTimeout(timeout);
        outcome();
      };

      ws.addEventListener('open', () => {
        finish(resolve);
      }, { once: true });
      ws.addEventListener('error', () => {
        finish(() => reject(new Error('Could not connect to cloud agent.')));
      }, { once: true });
      ws.addEventListener('close', () => {
        finish(() => reject(new Error('Cloud workspace connection closed before it opened.')));
      }, { once: true });
    });

    if (this.closed) {
      ws.close();
      throw new Error('Cloud workspace client closed while connecting.');
    }
  }

  /** A broadcast that moved the executors is reported once the machines are re-read, so its hearer renders their links. */
  private reportBroadcast(frame: v.InferOutput<typeof BroadcastFrameSchema>): void {
    if (frame.type !== READS_CHANGED_EVENT || !frame.reads.includes('getExecutors')) {
      this.emit({ type: 'broadcast', event: frame });

      return;
    }

    const taskId = randomRequestId();

    const task: Promise<void> = this.readMachines().then(() => {
      this.emit({ type: 'broadcast', event: frame });
    }).finally(() => {
      if (this.launchedTasks.get(taskId) === task) this.launchedTasks.delete(taskId);
    });

    this.launchedTasks.set(taskId, task);
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

    const broadcast = v.safeParse(BroadcastFrameSchema, payload);

    if (broadcast.success) {
      this.reportBroadcast(broadcast.output);

      return;
    }

    if (payload.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || !payload.id) return;
    const { id } = payload;
    const active = this.activeTurns.get(id);

    // A turn being asked how it ended is not read off its stream.
    if (!active || this.reacquiring.has(id)) return;

    if (payload.error) {
      if (this.stoppingTurnIds.has(id)) return;
      this.activeTurns.delete(id);
      const body = payload.body ?? '';
      const message = body === '' ? 'Cloud agent stream failed.' : body;
      this.emit({ type: 'error', message });
      active.settle(true);

      return;
    }

    // Landed mid-turn: no stream. Checked before apply, which would fire a turn-start that never ends.
    if (payload.done && payload.landed === 'mid-turn') {
      this.activeTurns.delete(id);
      active.landedMidTurn();

      return;
    }

    active.apply(payload.body);

    if (payload.done) {
      if (this.stoppingTurnIds.has(id)) return;
      this.activeTurns.delete(id);
      active.settle();
    }
  }

  private failInFlight(error: Error): void {
    const active = [...this.activeTurns.values()];
    this.activeTurns.clear();

    if (active.length > 0) this.emit({ type: 'error', message: error.message });

    for (const turn of active) turn.settle(true);
    this.failPendingRpcs(error);
  }

  /** RPCs are request/reply and never replayed, so callers must hear the failure. */
  private failPendingRpcs(error: Error): void {
    const rpcs = [...this.pendingRpcs.values()];
    this.pendingRpcs.clear();

    for (const rpc of rpcs) rpc.reject(error);
  }

  /**
   * A dropped connection ends no turn and is not chased by its stream: each turn's end is asked of the workspace's
   * durable record (`awaitSend`), again on every new connection, and its answer read from the turn the record names.
   * The SDK's resume stream restates a turn from its first chunk for `useChat` to replace its message; a terminal cannot
   * unprint, so following it would need a chunk cursor of its own. A turn being asked stays within Stop's reach.
   */
  private async reacquireInFlightTurns(): Promise<void> {
    const turns = [...this.activeTurns].filter(([id]) => !this.reacquiring.has(id));

    for (const [id] of turns) this.reacquiring.add(id);
    await Promise.allSettled(turns.map(([id, turn]) => this.reacquire(id, turn)));
  }

  private async reacquire(id: string, turn: CloudTurnStream): Promise<void> {
    const [ended] = await Promise.allSettled([this.endOf(id)]);

    this.reacquiring.delete(id);

    // A Stop or a close settled it meanwhile.
    if (this.activeTurns.get(id) !== turn) return;
    this.activeTurns.delete(id);

    if (ended.status === 'rejected') {
      this.emit({ type: 'error', message: `Could not learn how this turn ended (${renderThrownChain({ cause: ended.reason })}). Its answer, if any, is in the workspace transcript.` });

      return turn.settle(true);
    }

    const { state, answer } = ended.value;

    if (state.status !== 'settled') {
      this.emit({ type: 'error', message: 'No turn took this message: it was handed back or refused before one read it.' });

      return turn.settle(true);
    }

    if (state.landed === 'mid-turn') return turn.landedMidTurn();

    if (answer !== null) turn.finish(answer);

    if (state.outcome === 'completed' || state.outcome === 'aborted') return turn.settle();
    this.emit({ type: 'error', message: `The turn ended ${state.outcome} while the connection was down.` });
    turn.settle(true);
  }

  private async endOf(id: string): Promise<SendEnd> {
    const state = v.parse(SendStateSchema, await this.askAwaitSend(id));
    const turnId = state.status === 'settled' && state.landed === 'turn' ? state.turnId : null;

    return { state, answer: turnId === null ? null : await recordedAnswer((request) => this.historyPage(request), turnId) };
  }

  /** Asked again on each new connection while connections drop. On one that held, a rejection is the workspace's
   *  refusal, and asking again would be refused again. */
  private async askAwaitSend(id: string): Promise<JsonValue> {
    for (;;) {
      await this.ensureOpen();
      const asking = this.callRpc('awaitSend', [id]);
      const [asked] = await Promise.allSettled([asking]);

      if (asked.status === 'fulfilled' || this.ws?.readyState === WebSocket.OPEN) return asking;
    }
  }
}

function frameText(
  text: v.SafeParseResult<v.StringSchema<undefined>>,
  buffer: v.SafeParseResult<v.InstanceSchema<typeof ArrayBuffer, undefined>>,
  bytes: v.SafeParseResult<v.InstanceSchema<typeof Uint8Array, undefined>>,
): string {
  if (text.success) return text.output;

  if (buffer.success) return new TextDecoder().decode(buffer.output);

  if (bytes.success) return new TextDecoder().decode(bytes.output);

  return '';
}

function parseSocketJson(event: MessageEvent): SocketFrame | null {
  const data: unknown = event.data;
  const textResult = v.safeParse(v.string(), data);
  const bufferResult = v.safeParse(v.instance(ArrayBuffer), data);
  const bytesResult = v.safeParse(v.instance(Uint8Array), data);

  const text = frameText(textResult, bufferResult, bytesResult);

  // A frame off the wire is untrusted input: unparseable text is a frame we drop, and only that.
  const parsed = tolerate(() => parseJsonValue(text), 'malformed-input');

  if (parsed === undefined) return null;
  const frame = v.safeParse(SocketFrameSchema, parsed);

  return frame.success ? frame.output : null;
}

function randomRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
