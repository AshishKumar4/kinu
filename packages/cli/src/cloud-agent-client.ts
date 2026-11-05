import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  JsonValueSchema,
  OwedIntentSchema, PlanDecisionOutcomeSchema, PlanReviewResultSchema, PlanReviewSchema,
  AskingAgentSchema,
  DeferredApprovalSchema,
  ChatHistoryEntrySchema, SendStateSchema, type SendState,
  ORCHESTRATOR_AGENT_SLUG,
  hostedActorSocketPath,
  decodeJsonValue,
  ChatResponseFrameSchema, terminalChatError,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
  AlternateTakeSetSchema, BranchTurnResultSchema, ChangelogRevertResultSchema, EvolutionChangelogViewSchema,
  FileCheckpointListingSchema, PendingDeviceConsentSchema, ResolvedDeviceConsentSchema,
  EvolutionConfigViewSchema, ProviderAccountsSchema, ReasoningEffortViewSchema, ReasoningEffortWriteSchema, SetModelResultSchema,
  StoredModelSpecSchema,
  RefinementListingSchema, RefinementRequestViewSchema, TakePickOutcomeSchema,
  type RefinementRequestView,
  type ModelTestResult,
} from '@kinu.run/core';
import { attemptInItsWords, detach, diagnostics, flight, inItsWords, KinuError, renderThrownChain, settle, settleSync, tolerate } from '@kinu.run/core/obs';
import { Effect, Result } from 'effect';
import {
  FileRestorePlanSchema, FileRestoreResultSchema, ReasoningEffortSchema, type WorkspaceSpend,
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
import { cloudFileLinks, JOB_OUTPUT_EVENT, READS_CHANGED_EVENT, TERMINAL_TURN_KEY, WorkspaceBroadcastSchema, type WorkspaceBroadcast, type AgentModelMenu, type AgentRpcMethod, type FileLinks } from '@kinu.run/core';
import { hostedWindowCalls, positionPageSchema, readConversation, SubagentInspectionRequestSchema, SubagentInspectionResultSchema, WorkspaceWorkSchema, type WorkspaceWork, type SubagentInspectionRequest, type SubagentInspectionResult } from '@kinu.run/core';
import type { AlternateTakeSet, BranchStatusEvent, SendMetadata, ChangelogRevertResult, RefinementListing, EvolutionConfigView, ReasoningEffort, TakePickOutcome } from '@kinu.run/core';
import {
  createUserUiMessage,
  findForkPivot,
  recordedAnswer,
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
  type AgentSendResult,
  type DeviceConsentSurface,
  type ForkPoint,
} from './agent-client';
import type { FileCheckpointSurface, OwnerQuestionSurface, PlanReviewSurface, WaitingApprovalSurface } from '@kinu.run/core';
import * as v from 'valibot';


/** An opening socket that neither opens nor fails, on a network that drops it silently. */
const WEBSOCKET_OPEN_WAIT_MS = 15_000;

/** Core's own `PlanReviewSchema`, so a forged annotation cannot arrive by a route the workspace UI lacks. */
const CloudPlanReviewSchema = v.nullable(PlanReviewSchema);

const CloudChatPageSchema = positionPageSchema(ChatHistoryEntrySchema);

const AdditionalAgentSchema = v.object({ name: v.string(), displayName: v.string() });

const AdditionalAgentEnvelopeSchema = v.object({
  subagent: AdditionalAgentSchema,
});

/** A write of an effort answers that effort; only a write of none clears it, which this client never asks. */
const SetEffortAnswerSchema = v.object({ ...ReasoningEffortWriteSchema.entries, effort: ReasoningEffortSchema });

const SearchNodeProjectionSchema = v.object({
  depth: v.number(),
  status: v.string(),
  value: v.optional(v.number()),
  visits: v.optional(v.number()),
  action: v.optional(v.nullable(v.string())),
});

const ActorSnapshotSchema = v.object({
  displayName: v.string(),
  role: v.string(),
  mission: v.string(),
  model: v.object({ model: v.string() }),
  reasoningEffort: v.nullable(ReasoningEffortSchema),
});

/** Every frame the socket carries: a turn frame's fields as core reads them, beside an RPC reply's and a broadcast's. */
const SocketFrameSchema = v.objectWithRest({
  ...ChatResponseFrameSchema.entries,
  type: v.string(),
  success: v.optional(v.boolean()),
  result: v.optional(JsonValueSchema),
  error: v.optional(JsonValueSchema),
}, JsonValueSchema);

type SocketFrame = v.InferOutput<typeof SocketFrameSchema>;

/** A send's settled state, and the answer its own turn recorded; none for a splice or a turn that recorded none. */
interface SendEnd {
  readonly state: SendState;
  readonly answer: string | null;
}

/** The executors read as chat links need it: a device fleet's live machines, by the segment each mounts under. */
const ExecutorMountsSchema = v.array(v.object({ mounts: v.optional(v.array(v.string())) }));

/** The workspace's broadcasts the terminal renders; a hosted actor's stamped frames and the browser's panels are not. */
const RENDERED_BROADCASTS = ['branch_status', READS_CHANGED_EVENT, JOB_OUTPUT_EVENT, 'model_fallback', 'context_fill', 'plan_updated'] as const;

type RenderedBroadcast = Extract<WorkspaceBroadcast, { type: typeof RENDERED_BROADCASTS[number] }>;

function rendered(frame: WorkspaceBroadcast): frame is RenderedBroadcast {
  return RENDERED_BROADCASTS.some((type) => type === frame.type);
}

interface CloudAgentClientOptions {
  origin: string;
  token: string;
  agentName: string;
  cloudName: string;
  /** A hosted actor beneath `cloudName`, not a store of its own: the subagent tree lives in the root's database. */
  subagentName?: string;
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
  readonly questions: OwnerQuestionSurface | null;
  readonly approvals: WaitingApprovalSurface | null;
  readonly inlineAttachmentLimitBytes = CLOUD_MAX_INLINE_ATTACHMENT_BYTES;
  readonly planes = null;
  readonly rename?: (displayName: string) => Promise<{ name: string; displayName: string }>;

  private readonly origin: string;
  private readonly token: string;
  private readonly cloudName: string;
  private readonly subagentName: string | null;
  private readonly oneShot: boolean;
  private readonly transcriptOptions: CliSessionOptions;
  private readonly activeCliSession: CliSession;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private readonly recorder = new SessionRecorder('cloud');
  private ws: WebSocket | null = null;
  /** The connection being opened, every asker meanwhile joining it. */
  private readonly connecting = flight(() => this.openSocket());
  /** A socket that dies after close() must not reconnect. */
  private closed = false;
  private readonly activeTurns = new Map<string, CloudTurnStream>();
  /** Turns whose connection dropped, asked of the workspace instead of read off their stream. */
  private readonly reacquiring = new Set<string>();
  private readonly pendingRpcs = new Map<string, { resolve: (value: JsonValue) => void; reject: (err: Error) => void }>();
  /** Kept visible until the actor confirms its durable cancellation sweep. */
  private readonly stoppingTurnIds = new Set<string>();
  private sweeping = false;
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
    this.subagentName = opts.subagentName ?? null;
    const subagentName = this.subagentName;

    if (subagentName) {
      this.rename = (displayName) => this.renameAdditionalAgent(subagentName, displayName);
    }

    this.oneShot = opts.oneShot === true;
    this.transcriptOptions = opts.transcript ?? {};
    this.activeCliSession = createCliSession(opts.agentName, this.transcriptOptions);
    this.consents = {
      listPending: () => settle(this.http('listPendingConsents', v.array(PendingDeviceConsentSchema))),
      resolve: (consentId, decision) => settle(this.http('resolveDeviceConsent', ResolvedDeviceConsentSchema, [consentId, decision])),
    };
    this.checkpoints = subagentName ? null : {
      list: (limit, turnId) => settle(this.rpcAs('listFileCheckpoints', [limit ?? 50, turnId ?? null], FileCheckpointListingSchema)),
      plan: (dir, id) => settle(this.rpcAs('planFileRestore', [dir, id], FileRestorePlanSchema)),
      restore: (dir, id) => settle(this.rpcAs('restoreFileCheckpoint', [dir, id], FileRestoreResultSchema)),
    };
    // The agent's questions, the workspace agent's: a window on a subagent answers its hirer, not the owner.
    this.questions = subagentName ? null : {
      // A hosted agent's questions are answered from the web app's stack, where its window is.
      list: () => settle(Effect.map(this.rpcAs('listOwnerQuestions', [], v.array(AskingAgentSchema)), (asked) => asked.filter((asking) => asking.actor === null))),
      answer: (id, answers) => settle(Effect.suspend(() => this.rpcAs('answerOwnerQuestions', [id, v.parse(JsonValueSchema, answers)], v.nullable(OwedIntentSchema)))),
    };
    // The workspace's one queue, its hosted agents' commands included, as the web's main stack shows it.
    this.approvals = subagentName ? null : {
      list: () => settle(this.rpcAs('listDeferredApprovals', [], v.array(DeferredApprovalSchema))),
      decide: (ids, decision) => settle(this.rpcAs('decideDeferredApprovals', [ids, decision], v.object({ decided: v.array(v.string()) }))),
    };
    // The sealed plan RPCs (`agent-rpc-access.ts`).
    this.plans = subagentName ? null : {
      active: () => settle(this.rpcAs('getActivePlanReview', [], CloudPlanReviewSchema)),
      saveAnnotations: (id, revision, annotations) => settle(Effect.suspend(() => this.rpcAs('savePlanReviewAnnotations', [id, revision, v.parse(JsonValueSchema, annotations)], PlanReviewResultSchema))),
      decide: (id, revision, decision, feedback) => settle(this.rpcAs('decidePlanReview', [id, revision, decision, feedback ?? null], v.union([OwedIntentSchema, PlanDecisionOutcomeSchema]))),
      dismiss: (id, revision) => settle(this.rpcAs('dismissPlanReview', [id, revision], PlanReviewResultSchema)),
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

    return settle(Effect.match(this.http('getExecutors', ExecutorMountsSchema), {
      onSuccess: (executors) => { this.links = cloudFileLinks(this.origin, this.cloudName, executors.flatMap((executor) => executor.mounts ?? [])); },
      onFailure: (unread) => { diagnostics.failure('chat.machines_unread', unread); },
    }));
  }

  subscribe(listener: (event: AgentClientEvent) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** A submit arriving mid-turn is routed through the server inbox and answered with where it landed. */
  send(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): Promise<AgentSendResult> {
    return settle(this.submit(prompt, opts, this.activeTurns.size > 0));
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

    this.waitUntil(settle(Effect.match(this.rpcAs('branchTurn', [text], BranchTurnResultSchema), {
      onSuccess: (admitted) => { if (!admitted.accepted) fail(admitted.reason); },
      onFailure: (failure) => { fail(failure.message); },
    })));

    return true;
  }

  private submit(prompt: AgentPrompt, opts: AgentClientSendOptions, steered: boolean): Effect.Effect<AgentSendResult, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const text = promptText(prompt).trim();
      const files = promptFiles(prompt);

      if (!text && files.length === 0) return yield* new KinuError('bad_input', 'prompt required');
      const ws = yield* this.opened();

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
      const answered = Promise.withResolvers<AgentSendResult>();
      const turn = new CloudTurnStream((event) => this.emit(event), answered, { deferStart: steered ? text : null });
      this.activeTurns.set(requestId, turn);

      const sent = Effect.try({
        try: () => {
          // A turn this send opens is a one-shot run's own task, run where the CLI is; a send into a running turn steers it.
          // The terminal draws no pages, so the agent answering this turn writes none.
          const opened: JsonObject = {
            [TERMINAL_TURN_KEY]: true, ...(this.oneShot && { oneShot: true }), ...(opts.cwd !== undefined && opts.cwd !== '' && { cwd: opts.cwd }),
          };

          const metadata: SendMetadata = {
            ...(opts.mode !== undefined && { kinuMode: opts.mode }), ...(opts.tier !== undefined && { kinuTier: opts.tier }),
            ...(!steered && Object.keys(opened).length > 0 && { kinuTurn: opened }),
          };

          const body: JsonObject = {
            messages: [decodeJsonValue({ value: createUserUiMessage(requestId, text, files, metadata) })],
            trigger: 'submit-message',
          };

          const request: JsonObject = {
            id: requestId,
            init: {
              method: 'POST',
              body: JSON.stringify(body),
            },
            type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
          };

          ws.send(JSON.stringify(request));
        },
        catch: (cause) => cause,
      });

      // The request never left: a failed send, not a turn that failed.
      yield* Effect.catch(sent, (cause) => Effect.sync(() => {
        this.activeTurns.delete(requestId);
        turn.refused(renderThrownChain({ cause }));
      }));

      return yield* attemptInItsWords('unavailable', () => answered.promise);
    });
  }

  fork(point: ForkPoint): Promise<AgentForkResult> {
    return settle(Effect.gen({ self: this }, function* () {
      if (this.activeTurns.size > 0) return yield* new KinuError('denied', 'Cannot fork while a turn is running.');
      const rows = yield* attemptInItsWords('unavailable', () => this.history());
      const pivotRow = rows[findForkPivot(rows, point)];

      if (pivotRow === undefined) return yield* new KinuError('missing', "Could not locate that message in the agent's chat history.");
      // A walk-back leaves files as they are: the agent is told what its rewound turns left.
      yield* this.rpc('revertConversation', [pivotRow.id, { chatOnly: true }]);

      return { client: this, label: `before ${pivotRow.id}` };
    }));
  }

  /** For surfaces that must not force a websocket open; live-session ops use the socket. */
  private http<T>(method: AgentRpcMethod, schema: v.GenericSchema<unknown, T>, args: JsonValue[] = []): Effect.Effect<T, KinuError> {
    return this.subagentName ? this.rpcAs(method, args, schema) : this.parentHttp(method, schema, args);
  }

  private mayCall(method: AgentRpcMethod): boolean {
    return this.subagentName === null || hostedWindowCalls(method);
  }

  private parentHttp<Input, T = Input>(method: AgentRpcMethod, schema: v.GenericSchema<Input, T>, args: JsonValue[] = []): Effect.Effect<T, KinuError> {
    return attemptInItsWords('unavailable', () => callAgentRpc({ origin: this.origin, token: this.token, name: this.cloudName, method, schema, args }));
  }

  /** `method` asked of the workspace over the socket, opened first if it is not. */
  private rpc(method: AgentRpcMethod, args: JsonValue[]): Effect.Effect<JsonValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (!this.mayCall(method)) return yield* new KinuError('denied', `${method} is not available in an additional agent's session.`);
      const ws = yield* this.opened();
      const id = randomRequestId();

      // A send that throws rejects the answer it was waiting for, and its entry goes with it.
      const answered = attemptInItsWords('unavailable', () => new Promise<JsonValue>((resolve, reject) => {
        this.pendingRpcs.set(id, { resolve, reject });
        ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
      }));

      return yield* Effect.tapError(answered, () => Effect.sync(() => { this.pendingRpcs.delete(id); }));
    });
  }

  /** {@link rpc}'s answer read as `schema`: an answer of another shape is a failure, not a defect. */
  private rpcAs<T>(method: AgentRpcMethod, args: JsonValue[], schema: v.GenericSchema<unknown, T>): Effect.Effect<T, KinuError> {
    return Effect.flatMap(this.rpc(method, args), (answer) => inItsWords('unavailable', Effect.sync(() => v.parse(schema, answer))));
  }

  /** The SDK frame aborts the chat request; the actor RPC awaits every foreground device outcome. */
  stop(): string[] {
    return settleSync(Effect.gen({ self: this }, function* () {
      const ws = this.ws;

      for (const id of this.activeTurns.keys()) {
        if (ws?.readyState === WebSocket.OPEN) {
          const cancelled = Effect.try({ try: () => { ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL, id })); }, catch: (cause) => cause });

          yield* Effect.catch(cancelled, (cause) => Effect.sync(() => {
            this.emit({ type: 'error', message: `Could not signal stream cancellation: ${renderThrownChain({ cause })}` });
          }));
        }

        this.stoppingTurnIds.add(id);
      }

      if (this.stoppingTurnIds.size > 0 && !this.sweeping) {
        this.sweeping = true;
        this.waitUntil(settle(this.settleStoppedTurns()));
      }

      return [];
    }));
  }

  /** The actor's durable cancellation sweep; the turns stay visible until it answers, whichever way. */
  private settleStoppedTurns(): Effect.Effect<void> {
    const swept = Effect.catch(Effect.asVoid(this.rpc('cancelCurrentWork', [])), (failure) => Effect.sync(() => {
      this.emit({ type: 'error', message: failure.message });
    }));

    return Effect.ensuring(swept, Effect.sync(() => {
      this.sweeping = false;

      for (const id of this.stoppingTurnIds) {
        this.stoppingTurnIds.delete(id);
        const turn = this.activeTurns.get(id);

        if (!turn) continue;
        this.activeTurns.delete(id);
        turn.settle();
      }
    }));
  }

  /** Holds a run nothing awaits until it ends, so `close` waits for it; the run answers its own failures. */
  private waitUntil(run: Promise<void>): void {
    const id = randomRequestId();

    this.launchedTasks.set(id, run.finally(() => { this.launchedTasks.delete(id); }));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failInFlight(new KinuError('unavailable', 'Cloud workspace connection closed.'));
    this.ws?.close();
    this.ws = null;
    await Promise.all(this.launchedTasks.values());
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    return readConversation((request) => this.historyPage(request));
  }

  /** One page of the conversation, newest first, as `readConversation` and `recordedAnswer` walk it. */
  historyPage(request: Parameters<Parameters<typeof readConversation>[0]>[0]): Promise<v.InferOutput<typeof CloudChatPageSchema>> {
    const name = this.subagentName;

    if (name === null) {
      return settle(this.http('getChatHistoryPage', CloudChatPageSchema, [request.cursor === undefined ? {} : { cursor: { before: request.cursor.before } }]));
    }

    return settle(Effect.flatMap(this.inspect({ path: [name], view: 'history', page: request }), (read) => (read.view === 'history'
      ? Effect.succeed(read.page)
      : Effect.fail(new KinuError('missing', read.view === 'missing' ? read.error : `the conversation read answered "${read.view}"`)))));
  }

  private ownSnapshot(name: string): Effect.Effect<v.InferOutput<typeof ActorSnapshotSchema>, KinuError> {
    return this.rpcAs('getActorSnapshot', [name], ActorSnapshotSchema);
  }

  status(): Promise<AgentClientStatus> {
    if (this.subagentName !== null) {
      return settle(Effect.map(this.ownSnapshot(this.subagentName), (own) => ({
        name: own.displayName, purpose: own.mission, model: own.model.model, reasoningEffort: own.reasoningEffort, roleId: own.role,
      })));
    }

    return settle(Effect.map(this.http('getAgentStatus', CloudAgentStatusSchema), (status) => ({
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
    })));
  }

  describeTools(): Promise<AgentToolSurface> {
    return settle(Effect.map(this.http('getToolDescriptions', CloudToolDescriptionsSchema), (tools) => ({
      builtIn: tools.builtIn.map(({ name, description }) => ({ name, description })),
      crafted: tools.crafted.map(({ name, description }) => ({ name, description })),
    })));
  }

  async readMemory(): Promise<string> {
    return await settle(this.http('getMemoryContent', v.string()));
  }

  changelog(): Promise<AgentChangelogView> {
    return settle(Effect.gen({ self: this }, function* () {
      const result = yield* this.rpcAs('getEvolutionChangelog', [{ limit: 50 }], EvolutionChangelogViewSchema);

      // A silently dropped ack leaves the digest unseen forever; report it through the error channel.
      yield* Effect.catch(this.rpc('markChangelogSeen', []), (failure) => Effect.sync(() => {
        this.emit({ type: 'error', message: `Could not mark the changelog as seen: ${failure.message}` });
      }));

      return { entries: result.entries, unseenCount: result.unseenCount };
    }));
  }

  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    return await settle(this.rpcAs('revertChangelogEntry', [id], ChangelogRevertResultSchema));
  }

  async refinements(): Promise<RefinementListing> {
    return await settle(this.rpcAs('listRefinements', [20], RefinementListingSchema));
  }

  async requestRefinement(opts?: { turnIds?: readonly string[] }): Promise<RefinementRequestView> {
    return await settle(this.rpcAs('requestRefinement', [
      opts?.turnIds === undefined ? {} : { turnIds: [...opts.turnIds] },
    ], RefinementRequestViewSchema));
  }

  inspectSubagent(request: SubagentInspectionRequest): Promise<SubagentInspectionResult> {
    return settle(this.inspect(request));
  }

  private inspect(request: SubagentInspectionRequest): Effect.Effect<SubagentInspectionResult, KinuError> {
    return Effect.suspend(() => this.parentHttp('inspectSubagent', SubagentInspectionResultSchema, [decodeJsonValue({ value: v.parse(SubagentInspectionRequestSchema, request) })]));
  }

  async workspaceWork(): Promise<WorkspaceWork> {
    return settle(this.parentHttp('listWorkspaceWork', WorkspaceWorkSchema));
  }

  async latestTakes(): Promise<AlternateTakeSet | null> {
    if (!this.mayCall('latestAlternateTakes')) return null;

    return await settle(this.rpcAs('latestAlternateTakes', [], v.nullable(AlternateTakeSetSchema)));
  }

  async pickTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    return await settle(this.rpcAs('pickAlternateTake', [takeId, nodeId], TakePickOutcomeSchema));
  }

  async setRole(roleId: string): Promise<{ role: string }> {
    return await settle(this.rpcAs('setRole', [roleId], v.object({ role: v.string() })));
  }

  /** Inherits the workspace mission with a blank `displayName`; `name` is the slug to open it by. */
  createAdditionalAgent(): Promise<{ name: string; displayName: string }> {
    return settle(this.subagentName ? this.parentHttp('createSubagentAgent', AdditionalAgentSchema) : this.rpcAs('createSubagentAgent', [], AdditionalAgentSchema));
  }

  /** Keeps the parent workspace name for ticket scope and parent-owned actions. */
  openAdditionalAgent(name: string): CloudAgentClient {
    return new CloudAgentClient({
      origin: this.origin,
      token: this.token,
      agentName: name,
      cloudName: this.cloudName,
      subagentName: name,
      transcript: this.transcriptOptions,
    });
  }

  renameAdditionalAgent(name: string, displayName: string): Promise<{ name: string; displayName: string }> {
    return settle(Effect.map(this.parentHttp('renameSubagentAgent', AdditionalAgentEnvelopeSchema, [name, displayName]), (renamed) => renamed.subagent));
  }

  searchNodes(): Promise<AgentSearchNode[]> {
    return settle(Effect.map(this.http('getMctsTree', v.array(SearchNodeProjectionSchema)), (rows) => rows.map((node) => ({
      depth: node.depth,
      status: node.status,
      value: node.value ?? 0,
      visits: node.visits ?? 0,
      action: node.action ?? null,
    }))));
  }

  async listJobs(limit = 20, actor?: string): Promise<AgentJobSummary[]> {
    const owner = actor ?? this.subagentName;
    const args: JsonValue[] = owner === null ? [limit] : [limit, owner];

    return settle(Effect.map(this.http('listBackgroundJobs', v.array(CloudBackgroundJobSchema), args), (jobs) => jobs.map((job) => ({
      id: job.id, kind: job.kind, status: job.status, label: job.label ?? null, ...(job.output !== undefined && { output: job.output }),
    }))));
  }

  async cancelJob(jobId: string): Promise<{ ok: boolean }> {
    return await settle(this.http('cancelBackgroundJob', CancelJobSchema, this.subagentName === null ? [jobId] : [jobId, this.subagentName]));
  }

  async getModelSpec(): Promise<string | null> {
    if (this.subagentName !== null) return settle(Effect.map(this.ownSnapshot(this.subagentName), (answer) => answer.model.model));

    return settle(Effect.map(this.http('getStoredModelSpec', StoredModelSpecSchema), (answer) => answer.spec));
  }

  async setModel(spec: string): Promise<{ spec: string }> {
    const name = this.subagentName;

    if (name !== null) return settle(Effect.map(this.rpcAs('setModel', [spec, name], SetModelResultSchema), (answer) => ({ spec: answer.spec })));

    return settle(Effect.map(this.http('setModel', SetModelResultSchema, [spec]), (answer) => ({ spec: answer.spec })));
  }

  async getReasoningEffort(): Promise<ReasoningEffort | null> {
    if (this.subagentName !== null) return settle(Effect.map(this.ownSnapshot(this.subagentName), (answer) => answer.reasoningEffort));

    return settle(Effect.map(this.http('getReasoningEffort', ReasoningEffortViewSchema), (answer) => answer.effort));
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }> {
    const args: JsonValue[] = this.subagentName === null ? [effort] : [effort, this.subagentName];

    return settle(Effect.map(this.http('setReasoningEffort', SetEffortAnswerSchema, args), (answer) => ({ effort: answer.effort })));
  }

  async workspaceSpend(): Promise<WorkspaceSpend> {
    return settle(Effect.map(this.http('getActivitySnapshot', ActivitySpendSchema), (answer) => answer.spend));
  }

  async getProviderAccounts(): Promise<Readonly<Record<string, string>>> {
    return settle(Effect.map(this.http('getProviderAccounts', ProviderAccountsSchema), (answer) => answer.accounts));
  }

  async setProviderAccount(provider: string, account: string | null): Promise<Readonly<Record<string, string>>> {
    return settle(Effect.map(this.http('setProviderAccount', ProviderAccountsSchema, [provider, account]), (answer) => answer.accounts));
  }

  async getEvolutionConfig(): Promise<EvolutionConfigView> {
    return await settle(this.http('getEvolutionConfig', EvolutionConfigViewSchema));
  }

  async setEvolutionConfig(view: Partial<EvolutionConfigView>): Promise<EvolutionConfigView> {
    return await settle(this.http('setEvolutionConfig', EvolutionConfigViewSchema, [decodeJsonValue({ value: view })]));
  }

  async listModels(): Promise<AgentModelMenu> {
    const menu = await listCloudAvailableModels(this.origin, this.token);

    // Only an empty menu with no failures is an error; provider failures are reported to the picker.
    if (menu.models.length === 0 && menu.failures.length === 0) {
      return settle(Effect.fail(new KinuError('missing', 'No cloud models are available.')));
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

  /** The open socket: opened first if it is not, by the one connection every asker meanwhile joins. */
  private opened(): Effect.Effect<WebSocket, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (this.closed) return yield* new KinuError('unavailable', 'Cloud workspace client is closed.');

      if (this.ws?.readyState !== WebSocket.OPEN) yield* this.connecting();

      if (this.closed) return yield* new KinuError('unavailable', 'Cloud workspace client closed while connecting.');
      const ws = this.ws;

      if (ws?.readyState !== WebSocket.OPEN) return yield* new KinuError('unavailable', 'Cloud workspace connection is not open.');

      return ws;
    });
  }

  private openSocket(): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { ticket } = yield* attemptInItsWords('unavailable', () => createCloudAgentConnectTicket(this.origin, this.token, this.cloudName));

      if (this.closed) return yield* new KinuError('unavailable', 'Cloud workspace client closed while creating its connect ticket.');

      // The actor segment under the workspace room, shared with the browser and the edge. There is no child
      // Durable Object, so the SDK's facet hop answers not-found.
      const room = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(this.cloudName)}`;

      const actorPath = this.subagentName
        ? `${room}/${hostedActorSocketPath(this.subagentName)}`
        : room;

      const url = new URL(actorPath, this.origin.replace(/\/+$/, ''));
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', ticket);

      const ws = new WebSocket(url.toString());
      this.ws = ws;
      ws.addEventListener('message', (event) => this.handleMessage(event));
      // One drop per socket generation: `error` then `close` would report it twice.
      let dropped = false;

      const onDrop = Effect.suspend(() => {
        if (dropped) return Effect.void;
        dropped = true;

        if (this.ws === ws) this.ws = null;
        this.failPendingRpcs(new KinuError('unavailable', 'Cloud workspace connection closed.'));

        return this.reacquireInFlightTurns();
      });

      const droppedConnection = () => detach(onDrop);
      ws.addEventListener('close', droppedConnection);
      ws.addEventListener('error', droppedConnection);

      yield* attemptInItsWords('unavailable', () => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new KinuError('timeout', 'Timed out connecting to cloud workspace.')), WEBSOCKET_OPEN_WAIT_MS);

        const finish = (outcome: () => void): void => {
          clearTimeout(timeout);
          outcome();
        };

        ws.addEventListener('open', () => {
          finish(resolve);
        }, { once: true });
        ws.addEventListener('error', () => {
          finish(() => reject(new KinuError('unavailable', 'Could not connect to cloud agent.')));
        }, { once: true });
        ws.addEventListener('close', () => {
          finish(() => reject(new KinuError('unavailable', 'Cloud workspace connection closed before it opened.')));
        }, { once: true });
      }));

      if (this.closed) {
        ws.close();

        return yield* new KinuError('unavailable', 'Cloud workspace client closed while connecting.');
      }
    });
  }

  /** A broadcast that moved the executors is reported once the machines are re-read, so its hearer renders their links. */
  private reportBroadcast(frame: RenderedBroadcast): void {
    if (frame.type !== READS_CHANGED_EVENT || !frame.reads.includes('getExecutors')) {
      this.emit({ type: 'broadcast', event: frame });

      return;
    }

    this.waitUntil(this.readMachines().then(() => {
      this.emit({ type: 'broadcast', event: frame });
    }));
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

    const broadcast = v.safeParse(WorkspaceBroadcastSchema, payload);

    if (broadcast.success) {
      if (rendered(broadcast.output)) this.reportBroadcast(broadcast.output);

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
      const ended = terminalChatError({ type: payload.type, error: true, done: payload.done, body: payload.body, reason: payload.reason });

      // Refused at the door, the send was never admitted: it fails as a send, and no turn is said to have run.
      if (ended?.refused === true) {
        active.refused(message);

        return;
      }

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
  private reacquireInFlightTurns(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const turns = [...this.activeTurns].filter(([id]) => !this.reacquiring.has(id));

      for (const [id] of turns) this.reacquiring.add(id);

      return Effect.asVoid(Effect.all(turns.map(([id, turn]) => this.reacquire(id, turn)), { concurrency: 'unbounded' }));
    });
  }

  private reacquire(id: string, turn: CloudTurnStream): Effect.Effect<void> {
    return Effect.map(Effect.result(this.endOf(id)), (ended) => {
      this.reacquiring.delete(id);

      // A Stop or a close settled it meanwhile.
      if (this.activeTurns.get(id) !== turn) return;
      this.activeTurns.delete(id);

      if (Result.isFailure(ended)) {
        this.emit({ type: 'error', message: `Could not learn how this turn ended (${ended.failure.message}). Its answer, if any, is in the workspace transcript.` });

        return turn.settle(true);
      }

      this.ended(turn, ended.success);
    });
  }

  private ended(turn: CloudTurnStream, { state, answer }: SendEnd): void {
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

  private endOf(id: string): Effect.Effect<SendEnd, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const state = yield* this.askAwaitSend(id);
      const turnId = state.status === 'settled' && state.landed === 'turn' ? state.turnId : null;

      if (turnId === null) return { state, answer: null };

      return { state, answer: yield* attemptInItsWords('unavailable', () => recordedAnswer((request) => this.historyPage(request), turnId)) };
    });
  }

  /** Asked again on each new connection while connections drop. On one that held, a refusal is the workspace's,
   *  and asking again would be refused again. */
  private askAwaitSend(id: string): Effect.Effect<v.InferOutput<typeof SendStateSchema>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        yield* this.opened();
        const asked = yield* Effect.result(this.rpcAs('awaitSend', [id], SendStateSchema));

        if (Result.isSuccess(asked)) return asked.success;

        if (this.ws?.readyState === WebSocket.OPEN) return yield* asked.failure;
      }
    });
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
