import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  ADVISOR_SEVERITIES,
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  JsonValueSchema,
  PlanReviewSchema,
  ChatHistoryEntrySchema, type ChatHistoryEntry,
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
} from '@kinu.run/core';
import { renderThrownChain, tolerate } from '@kinu.run/core/obs';
import type {
  CheckpointAvailability, FileCheckpointEntry, FileCheckpointListing,
  FileRestorePlan, FileRestoreResult,
  PlanReviewResult,
} from '@kinu.run/core';
import {
  callAgentRpc,
  CloudAgentStatusSchema,
  CloudBackgroundJobSchema,
  CloudToolDescriptionsSchema,
  createCloudAgentConnectTicket,
  listCloudAvailableModels,
} from './cloud-api';
import {
  createCliSession,
  type CliSession,
  type CliSessionOptions,
} from './session';
import { CloudTurnStream, jsonErrorMessage } from './cloud-turn-stream';
import { SessionRecorder } from './session-recorder';
import { normalizeModelMenu, type AgentModelMenu } from '@kinu.run/core';
import { pageSchema, SubordinateInspectionRequestSchema, SubordinateInspectionResultSchema, type SubordinateInspectionRequest, type SubordinateInspectionResult, type Page, type SeekCursor } from '@kinu.run/core';
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

/** Core's own `PlanReviewSchema`, so a forged annotation cannot arrive by a route the workspace UI lacks. */
const CloudPlanReviewSchema = v.nullable(PlanReviewSchema);

const CloudPlanReviewResultSchema: v.GenericSchema<unknown, PlanReviewResult> = v.variant('ok', [
  v.object({ ok: v.literal(true), plan: PlanReviewSchema }),
  v.object({ ok: v.literal(false), error: v.string(), plan: CloudPlanReviewSchema }),
]);

const CloudChatPageSchema = pageSchema(ChatHistoryEntrySchema);

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
  kind: v.picklist(['scaffold', 'tool', 'fact', 'gepa', 'replay', 'outcomes']),
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
  replay: v.optional(v.boolean()),
  landed: v.optional(v.picklist(['mid-turn', 'turn'])),
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
  readonly checkpoints: FileCheckpointSurface;
  readonly plans: PlanReviewSurface;
  readonly inlineAttachmentLimitBytes = CLOUD_MAX_INLINE_ATTACHMENT_BYTES;
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
  private readonly pendingRpcs = new Map<string, { resolve: (value: JsonValue) => void; reject: (err: Error) => void }>();
  /** Kept visible until the actor confirms its durable cancellation sweep. */
  private readonly stoppingTurnIds = new Set<string>();
  private stopPromise: Promise<void> | null = null;
  /** Held until the submission or RPC ack reaches the event stream; ids keep cleanup identity-safe. */
  private readonly launchedTasks = new Map<string, Promise<void>>();

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
    // The sealed plan RPCs (`rpc-gate.ts`).
    this.plans = {
      active: async () => v.parse(CloudPlanReviewSchema, await this.callRpc('getActivePlanReview', [])),
      saveAnnotations: async (id, revision, annotations) => v.parse(
        CloudPlanReviewResultSchema,
        await this.callRpc('savePlanReviewAnnotations', [id, revision, v.parse(JsonValueSchema, annotations)]),
      ),
      decide: async (id, revision, decision, feedback) => v.parse(
        CloudPlanReviewResultSchema,
        await this.callRpc('decidePlanReview', [id, revision, decision, feedback ?? null]),
      ),
    };
  }

  get cliSession(): CliSession {
    return this.activeCliSession;
  }

  async connect(): Promise<void> {
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
    if (this.activeTurns.size === 0) return false;
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
          messages: [decodeJsonValue({ value: createUserUiMessage(text, files, opts.mode) })],
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
    const rows = await this.transcript();
    const pivotRow = rows[findForkPivot(rows, point)];

    if (pivotRow === undefined) throw new Error("Could not locate that message in the agent's chat history.");
    await this.callRpc('revertConversation', [pivotRow.id]);

    return { client: this, label: `before ${pivotRow.id}` };
  }

  /** For surfaces that must not force a websocket open; live-session ops use callRpc. */
  private callHttp<T>(method: string, schema: v.GenericSchema<T>, args: JsonValue[] = []): Promise<T> {
    if (this.subordinateName) {
      return this.callRpc(method, args).then((result) => v.parse(schema, result));
    }

    return this.callParentHttp(method, schema, args);
  }

  private callParentHttp<Input, T = Input>(method: string, schema: v.GenericSchema<Input, T>, args: JsonValue[] = []): Promise<T> {
    return callAgentRpc({ origin: this.origin, token: this.token, name: this.cloudName, method, schema, args });
  }

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
    return (await this.transcript()).map((row) => ({
      id: row.id, role: row.role, content: row.content, metadata: row.metadata,
    }));
  }

  /** Paged, never capped: `fork()` would report a message past the cap as not found. */
  private async transcript(): Promise<ChatHistoryEntry[]> {
    const rows: ChatHistoryEntry[] = [];
    let cursor: SeekCursor | null = null;

    for (;;) {
      const page: Page<ChatHistoryEntry> = await this.callHttp(
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

  async latestTakes(): Promise<AlternateTakeSet | null> {
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

    // Only an empty menu with no failures is an error; provider failures are reported to the picker.
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

      try {
        await this.rebindInFlightTurns();
      } catch (cause) {
        this.failInFlight(new Error(
          `Could not reconnect to resume this cloud turn: ${renderThrownChain({ cause })}`,
          { cause },
        ));
      }
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

    if (payload.type === 'branch_status') {
      const branchStatus = parseBranchStatusEvent(payload);

      if (branchStatus) this.emit({ type: 'broadcast', event: branchStatus });

      return;
    }

    // Ack only our own turns, so the DO replays their chunks after a reconnect.
    if (payload.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING && payload.id) {
      const resuming = this.activeTurns.get(payload.id);

      if (resuming) this.ackResume(payload.id, resuming);

      return;
    }

    // The DO holds no stream for us, so every turn awaiting rebind is settled there; acking replays its end.
    if (payload.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE) {
      for (const [id, turn] of this.activeTurns) {
        if (turn.awaitingRebind) this.ackResume(id, turn);
      }

      return;
    }

    // The DO guarantees a later STREAM_RESUMING or STREAM_RESUME_NONE, so waiting is the handling.
    if (payload.type === CHAT_MESSAGE_TYPES.STREAM_PENDING) return;

    if (payload.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || !payload.id) return;
    const active = this.activeTurns.get(payload.id);

    if (!active) return;
    // Read before clearing: the terminal branch needs to know whether anything rebound.
    const unbound = active.awaitingRebind;
    active.awaitingRebind = false;

    if (payload.error) {
      if (this.stoppingTurnIds.has(payload.id)) return;
      this.activeTurns.delete(payload.id);
      const body = payload.body ?? '';
      const message = body === '' ? 'Cloud agent stream failed.' : body;
      this.emit({ type: 'error', message });
      active.settle(true);

      return;
    }

    // Landed mid-turn: no stream. Checked before apply, which would fire a turn-start that never ends.
    if (payload.done && payload.landed === 'mid-turn') {
      this.activeTurns.delete(payload.id);
      active.landedMidTurn();

      return;
    }

    if (payload.body?.trim()) active.apply(payload.body, payload.replay === true);

    if (payload.done) {
      if (this.stoppingTurnIds.has(payload.id)) return;
      this.activeTurns.delete(payload.id);

      // A replayed terminal as the first frame back means nothing rebound; settling it clean would present a
      // truncated answer as complete.
      if (payload.replay === true && unbound) {
        this.emit({
          type: 'error',
          message: 'The cloud workspace has no stream to resume for this turn.'
            + ' Read the workspace transcript before sending it again.',
        });
        active.settle(true);
      } else {
        active.settle();
      }

      // The DO went idle: re-probe so a turn still unbound after the drop gets answered.
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

  /** RPCs are request/reply and never replayed, so callers must hear the failure. */
  private failPendingRpcs(error: Error): void {
    const rpcs = [...this.pendingRpcs.values()];
    this.pendingRpcs.clear();

    for (const rpc of rpcs) rpc.reject(error);
  }

  /**
   * Rebind, never resubmit: the DO persisted each turn and keeps its stream resumable, so a rebind cannot produce a
   * second turn. A turn already awaiting rebind made no progress and is reported instead.
   */
  private async rebindInFlightTurns(): Promise<void> {
    if (this.closed || this.activeTurns.size === 0) return;

    for (const [id, turn] of this.activeTurns) {
      if (!turn.awaitingRebind) continue;
      this.activeTurns.delete(id);
      this.emit({
        type: 'error',
        message: 'The cloud workspace connection dropped again before this turn could be resumed.'
          + ' It is still running there. Its answer lands in the workspace transcript.',
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

  /** At most once per socket generation per turn: the DO replays the whole buffer per ack. */
  private ackResume(requestId: string, turn: CloudTurnStream): void {
    if (turn.resumeAcked) return;
    turn.resumeAcked = true;
    turn.beginReplay();
    this.ws?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: requestId }));
  }

  /** Resolves on the DO's own state (RESUMING, PENDING, or RESUME_NONE), not a local clock. */
  private requestStreamResume(): void {
    this.ws?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST }));
  }
}

function parseBranchStatusEvent(payload: SocketFrame): BranchStatusEvent | null {
  const result = v.safeParse(BranchStatusEventSchema, payload);

  if (!result.success) return null;
  const event = result.output;

  if (event.status !== 'error') return event;

  return { ...event, message: event.message ?? 'branch failed' };
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
