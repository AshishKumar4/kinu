/**
 * Actor-agnostic substrate beneath every full-loop Kinu actor on the Cloudflare backend.
 * Tool gating is structural: a profile with no `team` deps gets no hiring actions on `agents`.
 */

import {
  Agent, callable,
  type AgentContext, type Connection, type ConnectionContext,
  type FiberRecoveryContext, type FiberRecoveryResult,
  type Schedule, type WSMessage,
} from "agents";
import {
  TierIdSchema, inspectSubordinateStorage, writeActivityLog, backgroundJobNotice,
  actorConnectionTag, actorFromConnectionTags, hostedActorRoute, actorReadHandle, readSessionTranscript,
  type SubordinateInspectionAuthority, type SessionTranscriptReader,
} from '@kinu.run/core';
import type { SubordinateInspectionRequest, SubordinateInspectionResult } from '@kinu.run/core';
import type { SubordinateActivityEvent } from '@kinu.run/core';
import type { SubordinateRosterEntry as SubordinateView } from '@kinu.run/core/protocol';
import { MessageType, parseProtocolMessage } from "agents/chat";
import {
  ActorChatRooms, ChatWireTransport, type ChatWire,
} from './chat-transport';
import {
  CLI_BEARER_HEADER,
  CLI_SCOPES_HEADER,
  SESSION_BEARER_HEADER,
  cliBearerConnectionTag,
  cliBearerFromTags,
  cliScopesConnectionTag,
  sessionBearerConnectionTag,
  sessionBearerFromTags,
  rejectOutOfScopeRpc,
  type CliSocketBearer,
} from "./cli/rpc-gate";
import { requiredRpcAccess } from "@kinu.run/core";
import { retryTransientDO } from "@kinu.run/core";
import { createWorkersTracer } from "./obs/cf-tracer";
import { createAgentTracing, renderThrownChain, type AgentTracing } from "@kinu.run/core/obs";
import {
  createCompactionExtension, createSharedPrefixCompactor, createVfsTranscriptStore,
  createCompactionStateStore, createModelSummarizer, COMPACTION_PRESETS,
  type CompactionStateStore, type Logger as CompactionLogger,
} from "@kinu.run/compaction";
import { generateText, convertToModelMessages } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import {
  McpToolSurfaceCache,
} from "./user/mcp";

import {
  EvolutionEngine, recoverSubordinateLifecycles, actorReferenceOf, createDbCodemodeProvider,
  type EvolutionConfig, type ActorHandle, type ActorHost, type ActorReference, type ChildActorOperation,
  type ActorDirectoryResult, type HostedActor, type WorkspaceActorDirectory,
  type ActorTurnProgram, type ScaffoldRunOptions,
  initActorClaimTables, ActorClaimStore, initPendingSendTables, PendingSendStore,
  createScaffoldCandidateSurface, createScaffoldCallTool, createScaffoldHistory, type ScaffoldCandidateBinding,
  queueTurnShadowTrial, runQueuedShadowTrials, createJsonJudge, type ScaffoldControl,
  refinementPass, type RefinementDeps,
  type CompletedTurn, type TurnContinuity, UNBOUNDED_STEPS,
  reviewRecordedTurn,
  type AdvisorRecoverySnapshot, type AdvisorDisposition,
  advisorWorkspaceGuidance,
  buildActorTools, buildBuiltinTools,
  buildMcpToolSet, toolSchemaDialect, withToolSchemaDialect,
  type WebSearchProvider,
  buildSystemPromptSync,
  type PromptIdentity,
  activePromptSectionOverrides,
  currentDateForPrompt,
  turnProvenanceForMetadata,
  workModeForTurnMetadata,
  turnLocalContextMessage, unverifiedInstructionsMessage,
  observeSystemPromptHash, steerSkillsBlock,
  type DynamicContext, type DynamicApproval, type MissingCapability,
  // Public extension seam — the SAME host contract runChat drives on the CLI
  ExtensionHost,
  type PromptFile, PromptFileSchema,
  // Shared turn lifecycle and run_end classifier, so neither backend chooses the string
  // (see turn-failure.ts).
  TurnAccumulator, AgentOrchestrator, ActorSession, ChatSession, type AgentOrchestratorDeps, type BackendHost,
  type ChatTurnInput, type PreparedTurn, type OwedTerminalEffectsInput, type ActorTurnLease, type ActorExecutionInput,
  type KinuExtension, type OwedEffect,
  type InlineSteer,
  type AgentsToolAction,
  type AgentsToolDeps,
  type AgentsSwarmDeps,
  BUILTIN_TOOLS,
  type BuiltinToolName,
  type TurnProvenance,
  type PromptModelContext,
  type WorkMode, isWorkMode,
  nanoid,
  type HeadJournal, LiveHeadJournal,
  type HeadStreamFrame,
  type HeadId, type HeadInput, type HeadReport, type MergeStrategy,
  type SerializedMessage, type HeadRuntime, type HeadGrounding, type MergeResult,
  readMemoryTail,
  type RunEventRecorder,
  // Spend governor is opt-in: no label means no cap.
  MissionGovernor, type MissionSeam, type MissionBudgetRefusal,
  normalizeUsage, priceCall, type Usage,
  explorePrompt, reflectionPrompt,
  WORKSPACE_RUN_ID, type ModelCallReport, type ModelOperationSink, type ModelOperationEvent, type CacheWarmingLane,
  recordModelOperations, type ProviderWaitInfo,
  // Prices a model_call row only when the rate belongs to that call's own model.
  buildModelCallEvent,
  type FactsStore,
  observeDevicePresence,
  createAgentStores, type AgentConfigStore, collectDynamicContext, subordinateDelegatesOf,
  nimbusSessionFiles, agentArtifactDirectory, agentHome, MAIN_AGENT,
  CHAT_SESSION_ID, type SessionTranscript,
  type SqlExecutor,
  agentsActionsFor,
  // Background-job system (#173: auto-background past the surface threshold)
  BackgroundJobRunner, type InvocationSurface,
  invocationBackgroundPolicy,
  type BackgroundJobStore, type TaskListStore,
  wrapToolsForBackground, BACKGROUNDABLE_TOOLS, resumeBackgroundJob, harvestBackgroundJob,
  readDeviceRequestChannel, type DeviceRequestChannel,
  cancelCurrentWork, getStoredModelSpec, setModel, getChatHistoryPage,
  type CancelWorkOutcome, type ChatHistoryEntry, type Page, type PageRequest,
  type MctsSearchStore, readSearchTree, isSteerBranchRunId, type MCTSProgressEvent,
  EventLog,
  resolveTurnSkills, filterToolNamesBySkills,
  type ActiveSkillSet,
  inheritedContextFromTranscript,
  type ReleaseToolDeps,
  PlanReviewActions, type PlanDecisionOutcome,
  type PlanEdit, type PlanReview, type PlanReviewAnnotation,
  type PlanReviewDecision, type PlanReviewResult, type SubmitPlanToolDeps,
  isVfsError,
  type ParentRpcResult, type ParentExecResult,
  type ParentRpcWrite,
  type TeamToolDeps, type PeersToolDeps, type ReportToolDeps,
  type SubordinateRuntime, type TemporaryAgentPort,
  SubordinateRosterStore,
  createTeamToolDeps, createTemporaryAgentPort, receiveSubordinateEvent,
  type SubordinatesChangedEvent, type SubordinateReportStatus, type SubordinateReportOrigin,
  type SubordinateEventResult,
  // One minting rule for every subordinate, on either backend
  mintSubordinateName,
  // Subordinate tree depth cap: derived per child, never stated by one
  delegationExhausted, deriveChildDelegationBudget, type DelegationBudget,
  readSoul, bootstrapScaffold,
  applyWorkspaceTitle, suggestWorkspaceTitle, type NameOrigin,
  accountDeps, callAccountOf, parseModelSpec, catalogModelInfo, countRequestInputTokens,
  ModelCatalogSession, resolveEffectiveModelSpec,
  // Shared turn-context assembly: the same ordering runChat runs on the CLI
  measureCompactionTrigger,
  // AGENTS.md discovery, and the trust authority deciding whether discovered bytes earn system placement.
  collectWorkspaceAgentsMd, type AgentsMdSources,
  InstructionApprovalStore, trustOfInstructionApprovals,
  type InstructionApproval, type InstructionTrustResolver,
  InstructionApprovalDesk, type AdmittedInstructionDecision,
  type InstructionSourceRow, type InstructionSourceView,
  type ResolvedModelWindow,
  reasoningEffortOptions,
  JsonObjectSchema, JsonValueSchema, changeRoleAsOwner,
  agentsProfileContext, effectiveRoleCatalog, loadProfileAuthorityInputs,
  resolveAgentTurnProfile, resolveRoutingProfile,
  captureOperationProfile, currentOperationProfile, withOperationProfile,
  type OperationProfile,
  createMemoryCodemodeProvider, createTasksCodemodeProvider, createWebCodemodeProvider, createAgentsCodemodeProvider,
  resolveModelRoute, narrowToolSurface, codemodeCapabilitiesFor, slateToolReach, callCodemodeMember, inWorkMode,
  beginModelOperation, toolSurfaceTokens, McpToolSurfaceSchema,
  SUBMIT_PLAN_TOOL, REPORT_TOOL,
  type ActiveRoster, type JsonObject, type JsonValue, type ProfileAuthorityInputs,
  toolsForInvocation, withTaskPlan, type TaskPlan, type TaskPlanContext, providersInWorkMode, currentWorkMode, requireWorkModePermission, McpProtocolFailureSchema, McpToolError,
  type ResolvedTurnProfile, type TierId, type SpendSource, type ModelCallSpend, type ToolSurfaceNarrowing, type CountableRequest, type InputTokenCount, type DeviceStatus,
  type AgentInbox,
  type NimbusSandboxHandle, childContextResolver,
} from "@kinu.run/core";
import {
  bindAgentSql, createCFRuntime, isCFRuntime,
  type CFRuntime, type CFRuntimeHooks,
} from "./runtime";
import {
  hostNodeSeat, hostBranch, abortHostedBranch, nodeCodemodeTool,
  type ExplorationHostSeams, type BranchRunnerDeps,
} from "./exploration-hosting";
import { hostedSubordinateRuntime, type SubordinateHostSeams } from "./subordinate-hosting";
import {
  classifyRecoveredFiber, EVOLUTION_LANE_FIBER, MCP_WARM_LANE_FIBER,
  TERMINAL_LANE_FIBER,
  // Recovery budget this backend declares to the SDK, applied before the framework allocates.
  sweepUnrecoverableFibers, fiberRowStore,
  FIBER_RECOVERY_MAX_AGE_MS,
  type FiberLaneTransports,
} from "./fiber-recovery";
import {
  // Shared retry pace for notice carrier, this tick's re-arm and the job runner's deferral.
  recoveryBackoffMs,
  // Once-only lifecycle for one settled response; both backends drive this state machine.
  TerminalTransitions, initTerminalEffectTable,
  terminalEffect, overflowRetryTerminalEffect, outputLimitContinuationTerminalEffect, taskReminderTerminalEffect,
  turnRecordTerminalEffect, eventDrainTerminalEffect, shadowTrialTerminalEffect,
  RunEndReasonSchema, WorkModeSchema,
  CompletedTurnSchema, AdvisorRecoverySnapshotSchema,
  type TerminalTransition, type TerminalEffectFault, type TerminalEffectTable,
} from "@kinu.run/core";
import { createCodemodeToolFactory, type CodemodeFactory } from "./codemode-tool";
import { codemodeEgress } from "./codemode-egress";
import { createHeadRuntime } from "./head-runtime";
import type { AgentProviderRegistry } from "./providers/agent-registry";
import { OwnedModelServices } from "./owned-model-services";
import {
  promptCachePlan, markLastToolForAnthropicCache,
} from "@kinu.run/core";
import type { CodemodeProvider, DeferredApprovalChannel, SlateBindingRoute, SlateCallResult, SlateOperation, SlateReadModel } from "@kinu.run/core";
import { workspaceOwner } from "./workspace-owner-rpc";
import { CRED_SESSION_USER } from "@nimbus-sh/core/runtime/os-contracts.js";
import type { SlateCaller, SlateCallerHop } from "./slates/bindings";
import { diagnostics, KinuError, refusalOf, toKinuError, tolerate, type ErrorCode, type Refusal } from "@kinu.run/core/obs";
import type { UserDO } from "./user/user-do";
import type { UserDoRpcMethod } from "./rpc-surface";
import { isWorkspaceTerminal, WorkspaceTerminalInputSchema } from "@kinu.run/core";
import type { WorkspaceTerminal } from "./workspace-host";
import type { UserCaller } from "@kinu.run/core";
import { sha256Hex } from '@kinu.run/core';
import { installAnalyticsDiagnostics } from "@kinu.run/core/analytics";
import { openAnalyticsWindow } from "@kinu.run/core/analytics";
import {
  recordModelRow, recordToolRow, recordTtftRow, recordTurnRow, type AgentKind,
} from "@kinu.run/core/analytics";
import * as v from 'valibot';

interface ClientRpcFrame {
  id: string;
  method: string;
}

/** Named contract so the analytics writer and the actor agree which half is the provider. */
interface ModelDimensions {
  readonly provider: string;
  readonly model: string;
}

/** No model resolved. Empty rather than a plausible default, so unknowns are not misattributed. */
const UNRESOLVED_MODEL: ModelDimensions = { provider: '', model: '' };

/** The overflow retry earned and the one end reason, already sealed in `run_end`.
 * The terminal roster's `status` is this reason; callers must not reclassify. */
/** Owner-side reads a turn is assembled from, taken before the turn opens. */
interface TurnReads {
  readonly profileInputs: ProfileAuthorityInputs;
  readonly mcpTools: ToolSet;
  readonly deviceStatus: DeviceStatus;
  readonly identity: PromptIdentity;
}

interface TurnAssemblyInput {
  readonly history: readonly ModelMessage[];
  /** The actor's raw tool surface for the requested work mode. */
  readonly tools: ToolSet;
  /** The CLI's cwd and the tier ride on this body. */
  readonly body: JsonObject;
  readonly reads: TurnReads;
}

/** The pieces of core's `ChatOptions` only this backend can supply, plus readings the
 * turn's settlement and per-step assembly re-use. */
interface AssembledTurn {
  readonly profile: ResolvedTurnProfile;
  readonly profileInputs: ProfileAuthorityInputs;
  readonly system: string;
  readonly model: LanguageModel;
  /** The invocable surface: task-plan and operation-profile wrapped. */
  readonly tools: ToolSet;
  readonly activeTools: string[];
  /** The exact active subset, for admission counting and the dynamic ledger. */
  readonly activeToolSurface: ToolSet;
  /** The durable history with the CLI's cwd context laid over it. */
  readonly rawMessages: readonly ModelMessage[];
  readonly turnLocal: ModelMessage[];
  readonly measured: ReturnType<typeof measureCompactionTrigger>;
  /** Window for admission, compaction and pruning; records whether figures are the
   * catalog's or the static table's stand-in. */
  readonly window: ResolvedModelWindow;
  readonly memoryTail: string | undefined;
  readonly countInputTokens: (request: CountableRequest) => Promise<InputTokenCount>;
  readonly cacheOptions: ReturnType<typeof promptCachePlan>['providerOptions'];
  readonly reasoningOptions: ReturnType<typeof reasoningEffortOptions>;
  readonly promptModel: ReturnType<ActorAgent['promptModelContext']>;
}

interface AsyncTaskOwner {
  promise: Promise<void> | null;
}

/** Only RPC methods rpc-surface.ts declares reachable; any other is a compile error. */
type UserHubClient = Pick<UserDO, UserDoRpcMethod>;

const ClientRpcFrameSchema = v.object({
  type: v.literal('rpc'), id: v.string(), method: v.string(), args: v.array(JsonValueSchema),
});

function parseClientRpcFrame(message: WSMessage): ClientRpcFrame | null {
  if (!v.is(v.string(), message)) return null;
  const json = tolerate<unknown>(() => JSON.parse(message), 'malformed-input');

  if (json === undefined) return null;
  const frame = v.safeParse(ClientRpcFrameSchema, json);

  return frame.success ? { id: frame.output.id, method: frame.output.method } : null;
}

/** The agents SDK treats this close code as terminal (`isTerminalCloseEvent`), so a
 * client whose authority is gone stops reconnecting. */
const WEBSOCKET_POLICY_CLOSE = 1008;

const CLI_AUTHORITY_REVOKED = 'This CLI authorization is invalid. Sign in again with: kinu auth';

const SESSION_AUTHORITY_REVOKED = 'This session has been signed out. Sign in again.';

const PlanApprovalMetadataSchema = v.looseObject({
  kinuEvent: v.literal('plan_approved'), planId: v.string(),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)), decision: v.literal('approve'),
});

/** Text-only: attachment parts are dropped here but still reach the model via
 * `host.defaultInference()` (see _transformInferenceResult). */
function extractLastUserText(messages: ReadonlyArray<ModelMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];

    if (m.role !== 'user') continue;
    const c = m.content;

    if (v.is(v.string(), c)) return c;

    if (Array.isArray(c)) {
      return c
        .map((part) => {
          const parsed = v.safeParse(v.looseObject({ text: v.optional(v.string()) }), part);

          return parsed.success ? parsed.output.text ?? '' : '';
        })
        .filter(Boolean)
        .join('\n');
    }

    return '';
  }

  return '';
}

function readCliCwd(body?: JsonObject): string | null {
  const cwd = body?.cwd;

  return v.is(v.string(), cwd) && cwd.trim() ? cwd.trim() : null;
}

/** CLI one-shot surfaces (`kinu exec`/`kinu run`) stamp `oneShot`: each is an independent
 * task, not a verdict on the previous turn. Everything else is a conversation. */
function readTurnContinuity(body?: JsonObject): TurnContinuity {
  return body?.oneShot === true ? 'independent_task' : 'conversation';
}

function readTurnTier(body?: JsonObject): TierId | undefined {
  const parsed = v.safeParse(TierIdSchema, body?.tier);

  return parsed.success ? parsed.output : undefined;
}

type UserModelMessage = Extract<ModelMessage, { role: 'user' }>;

function withCliCwdContext(messages: ReadonlyArray<ModelMessage>, cwd: string): ModelMessage[] {
  const prefix = `Current terminal working directory: ${cwd}\n\n`;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (message.role !== 'user') continue;
    const next = [...messages];
    next[i] = {
      ...message,
      content: prefixCliCwdContent(message.content, prefix),
    };

    return next;
  }

  return [...messages];
}

function prefixCliCwdContent(content: UserModelMessage['content'], prefix: string): UserModelMessage['content'] {
  if (v.is(v.string(), content)) return `${prefix}${content}`;

  if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];

  return prefix;
}

const CompactionDetailSchema = v.optional(JsonValueSchema);

type CompactionDetail = v.SafeParseResult<typeof CompactionDetailSchema>;

/** Event names are shared verbatim with `cli-backend/src/local-session.ts` so one query
 * reads both. */
const COMPACTION_OUTCOMES = {
  warn: { event: 'compaction.degraded', code: 'unavailable', activity: 'compaction_warn' },
  error: { event: 'compaction.failed', code: 'io', activity: 'compaction_error' },
} as const;

function compactionLogDetail(message: string, detail: CompactionDetail): string {
  if (!detail.success) {
    // An unserializable detail (cycle, BigInt) must not drop the log line; ship the message alone.
    diagnostics.event('actor.compaction_detail_unserializable', { message });

    return message;
  }

  return detail.output === undefined ? message : `${message} ${JSON.stringify(detail.output)}`;
}

/** Structural absence is the gate: a tool whose deps are not wired is neither in the
 * ToolSet nor advertised in the prompt (actorActiveTools). */
export interface ActorToolDeps {
  /** Wired by `teamProfile()` on every actor with tree left below it; absent at the depth cap. */
  team?: TeamToolDeps;
  /** Orchestrator-only: `hire scope=workspace` mints the root of a fresh tree
   * (see AgentsToolDeps.peers in core delegation/agents-tool.ts). */
  peers?: PeersToolDeps;
  /** Subordinate-only. */
  report?: ReportToolDeps;
  releases?: ReleaseToolDeps | undefined;
  /** Present on actors whose current turn belongs to the owner; surfaced only in Plan mode. */
  submitPlan?: SubmitPlanToolDeps;
}

/** BUILTIN_TOOLS filtered to what this actor's deps wire; the prompt and activeTools must not
 * advertise absent tools. Gated names come from core's `DEPS_GATED_TOOLS`, asserted by test. */
function actorActiveTools(deps: ActorToolDeps): BuiltinToolName[] {
  const gate = {
    [REPORT_TOOL]: deps.report !== undefined,
  } satisfies Partial<Record<BuiltinToolName, boolean>>;

  return BUILTIN_TOOLS.filter((name) => gate[name] ?? true);
}

/** The `agents` actions this actor profile supports, gated by the same rule as the tool's enum. */
function actorAgentsActions(deps: ActorToolDeps): AgentsToolAction[] {
  return agentsActionsFor({ swarm: {}, team: deps.team, peers: deps.peers });
}

/** The codemode tool whose script keeps issuing device execs even after its call has detached. */
const CODEMODE_TOOL_TOOL = 'eval' satisfies BuiltinToolName;

/** Schedule callback finishing a dead activation's terminal sequence. Public because
 * `Agent.schedule()` types its callback as `keyof this`, which excludes protected members. */
export const TERMINAL_RETRY_CALLBACK = '_kinuTerminalRetryTick';

export interface ActorDynamicContextExtras {
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
  readonly extraMissingCapabilities?: () => readonly MissingCapability[];
}

interface WorkspaceTitleInputs {
  readonly displayName: string | null;
  readonly nameOrigin: NameOrigin | null;
}

/** Failure classes under which a turn runs on builtins alone because the MCP catalog was
 * unreachable; every other class is the turn's own fault. */
const MCP_CATALOG_READ_FAILURES: ReadonlySet<ErrorCode> = new Set(['unavailable', 'timeout', 'io']);

/**
 * A hosted actor's binding reaches only its own files, tables, tasks and facts, never the
 * workspace actor's (pinned by `tests/unit-slate-composition.test.ts`).
 */
function hostedActorSurface(actor: HostedActor, webSearch: WebSearchProvider) {
  // `ActorHostDeps.runtimeFor` is `createCFRuntime` on this backend; core only narrows the type.
  const runtime = actor.runtime;

  if (!isCFRuntime(runtime)) {
    throw new KinuError('unsupported', 'a hosted actor on this backend must run on the cf runtime');
  }

  const providers: CodemodeProvider[] = [
    ...(runtime.executionRouter?.getProviders() ?? []),
    createWebCodemodeProvider(webSearch),
    createDbCodemodeProvider(actor.stores.appData),
    createTasksCodemodeProvider(actor.stores.taskList, actor.stores.config),
    createMemoryCodemodeProvider(() => ({
      memory: runtime.memory, vectorStore: runtime.vectorStore,
      facts: actor.stores.facts, sql: runtime.storage.sql, actor: actor.handle,
      transcriptFor: (sessionId) => actor.stores.history.transcript(sessionId),
    })),
  ];

  const native = buildBuiltinTools({
    rt: runtime, vectorStore: runtime.vectorStore, facts: actor.stores.facts, webSearch,
    history: actor.stores.history,
    fileLedger: actor.session.orchestrator.acc.files, contextBudget: actor.session.orchestrator.acc.context,
  });

  return { providers, native };
}

export abstract class ActorAgent extends Agent<Env> {
  // Actor profile: these members are the whole difference between actor kinds.

  /** Owner userId, or null while unclaimed. */
  protected abstract getOwnerUserId(): string | null;
  protected abstract actorHandle(): ActorHandle;
  abstract actorDirectory(operation: ChildActorOperation): Promise<ActorDirectoryResult>;

  private actorRuntimeRefusal(): Refusal | null {
    try {
      this.actorHandle();

      return null;
    } catch (cause) {
      if (cause instanceof KinuError && cause.code === 'missing') return refusalOf(cause);
      throw cause;
    }
  }

  override async alarm(): Promise<void> {
    const refusal = this.actorRuntimeRefusal();

    if (refusal) throw new KinuError(refusal.reason, refusal.error);
    await super.alarm();
  }
  /** Actor kind for the operational dataset's `agentKind` dimension. Abstract because a
   * bundler may rewrite `constructor.name`. */
  protected abstract actorKind(): AgentKind;

  /** The workspace whose exec planes this actor rides; a facet actor overrides with its parent's. */
  protected workspaceName(): string { return this.name; }

  protected shellId(): string { return `agent:${this.name}`; }

  /** One Durable Object owns the workspace bytes: a top-level workspace DO serves from its own
   * storage; a facet actor returns a client onto that object. */
  protected abstract workspaceBox(shellId: string): NimbusSandboxHandle;

  protected scaffoldPath(): string { return 'scaffold/agent.js'; }

  /** Workspace identity token for the owner's UserDO; facets hold a pushed copy of the parent's.
   * Null before claim. Kept out of actor_config and never readable via RPC. */
  protected workspaceCapabilityToken(): string | null {
    // The constructor owns the table, so a failure here is real, never "no token".
    const rows = this.sql<{ token: string }>`SELECT token FROM workspace_capability LIMIT 1`;

    return rows[0]?.token || null;
  }

  /** Hash of the held token, or null. Safe to share; lets the UserDO detect a mismatch. */
  protected async workspaceCapabilityHash(): Promise<string | null> {
    const token = this.workspaceCapabilityToken();

    return token ? sha256Hex(token) : null;
  }

  /** Worker-side DO RPC only, deliberately not `@callable`. `missed` counts failed subtree
   * pushes; the caller reports them to the UserDO so it can arm reconciliation. */
  async installWorkspaceCapability(token: string): Promise<{ ok: true; missed: number }> {
    if (!token) throw new Error('capability token required');
    // A native DO RPC does not route through partyserver, so it can land before `onStart` has run
    // (same race as `OrchestratorAgent.claimOwner`). Flag-gated: a no-op once initialized.
    this.ensureSchema();
    void this.sql`INSERT INTO workspace_capability (id, token) VALUES (1, ${token})
             ON CONFLICT(id) DO UPDATE SET token = excluded.token`;
    this.invalidateModelCaches();

    // Hosted actors read the single capability row through their runtime, so a reissue applies on
    // their next call; no per-actor copies exist, so `missed` is always zero (callers report it).
    return { ok: true, missed: 0 };
  }

  /** Re-run the subtree push with the token this root holds; only the root stores the plaintext,
   *  so retries go through it. Idempotent: same push and same committed token. */
  async repushWorkspaceCapability(): Promise<{ missed: number }> {
    const token = this.workspaceCapabilityToken();

    if (!token) return { missed: 0 };
    const result = await this.installWorkspaceCapability(token);

    return { missed: result.missed };
  }

  /**
   * Created in the constructor: the only point guaranteed to precede every access on both cf roots
   * (`onStart` may follow an RPC). Per-root by design; `core/conformance/manifest.ts` marks it
   * absent for cli.
   */
  private initCapabilitySchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_capability (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL
    )`);
    // Pending-send ledger is declared once in core (`initPendingSendTables`) because the CLI
    // backend shares the table names with a nullable `turn_id`; one writer keeps creation order
    // from picking the shape.
    initPendingSendTables((ddl: string) => this.ctx.storage.sql.exec(ddl));
    // Per-actor admission ledger (one workspace-wide pointer cannot distinguish concurrent actors).
    // Initialized here because onStart recovery can read it before a root's ensureSchema runs.
    initActorClaimTables((ddl: string) => this.ctx.storage.sql.exec(ddl));
    // Same reason: the onStart recovery sweep can read it before a root's `ensureSchema`.
    initTerminalEffectTable((ddl: string) => this.ctx.storage.sql.exec(ddl));
  }
  /** Declared here because `installWorkspaceCapability`, reachable before `onStart`, must demand it. */
  protected abstract ensureSchema(): void;

  /** Structural absence is the gating: an actor returning {} has no roster/peer actions or release tool. */
  protected abstract actorToolDeps(): ActorToolDeps;

  /** Spliced between `agents` and `web` so provider order (and the LLM-visible type description)
   *  is stable across actor kinds. */
  protected extraCodemodeProviders(): CodemodeProvider[] { return []; }

  protected abstract get engine(): EvolutionEngine;

  /** Wired here rather than per subclass: a facet that queues trials without a runner stalls on its
   *  first proposal. */
  protected get shadowTrialPorts(): Pick<EvolutionConfig, 'shadowTrialQueue' | 'shadowTrialRunner'> {
    return {
      shadowTrialQueue: (turn, opts) => queueTurnShadowTrial(this.scaffoldControl, turn, opts),
      shadowTrialRunner: () => runQueuedShadowTrials(this.scaffoldControl),
    };
  }

  protected abstract notifyOwner(subject: string, body: string): void;

  /** Socket-only RPC policy: DO stub calls bypass onMessage, so trusted worker callers keep
   *  methods denied to client sockets. */
  protected isClientRpcMethodDenied(_method: string): boolean { return false; }

  // The concrete profile decides whether this turn may submit plan reviews: an owner-driven agent
  // does; a task delegated by its parent keeps the report lane instead.

  /** Plan this turn implements when it is a plan approval's handoff; honoured only while the row
   *  still says approved. Null otherwise. */
  private approvedTaskPlan(): TaskPlan | null {
    const item = this._turnItem;

    if (item === null || item.kind !== 'programmatic') return null;
    const parsed = v.safeParse(PlanApprovalMetadataSchema, item.metadata);

    if (!parsed.success) return null;
    const input = parsed.output;
    const prefix = `plan:${input.planId}:${input.revision}:approve:`;
    const key = item.idempotencyKey ?? '';

    if (!key.startsWith(prefix) || !/^\d+$/.test(key.slice(prefix.length))) return null;
    const plan = this.stores.planReviews.get(input.planId, input.revision);

    if (plan?.status === 'approved' && plan.sessionId === 'default') {
      return Object.freeze({ id: plan.id, revision: plan.revision, sessionId: plan.sessionId });
    }

    return null;
  }

  private _planActions: PlanReviewActions | null = null;

  private get planActions(): PlanReviewActions {
    this._planActions ??= new PlanReviewActions(this.stores.planReviews, (plan) => this.host.broadcast({ type: 'plan_updated', plan }));

    return this._planActions;
  }

  protected submitPlanEdits(edits: readonly PlanEdit[]): PlanReviewResult | Promise<PlanReviewResult> {
    return this.planActions.submit(edits);
  }

  @callable()
  async getActivePlanReview(): Promise<PlanReview | null> {
    return this.planActions.active();
  }

  @callable()
  async savePlanReviewAnnotations(
    id: string,
    revision: number,
    annotations: PlanReviewAnnotation[],
  ): Promise<PlanReviewResult> {
    return this.planActions.saveAnnotations(id, revision, { value: annotations });
  }

  @callable()
  async decidePlanReview(
    id: string,
    revision: number,
    decision: PlanReviewDecision,
    feedback?: string,
  ): Promise<PlanDecisionOutcome> {
    return this.planActions.decideAndHandOff({ id, revision, decision, feedback }, (turn) => this.host.enqueueTurn(turn));
  }

  /** The orchestrator answers with the root budget; a facet actor answers from durable storage,
   * so an eviction cannot reset it. */
  protected abstract delegationBudget(): DelegationBudget;

  /** The workspace's one actor host; every logical actor is acquired from it over this object's SQL.
   * Abstract because it is built from root state this base class does not hold. */
  protected abstract actorHost(): ActorHost;

  /** Read directly by the inspection path and slate descent, which resolve actors by name. */
  protected abstract actorDirectoryStore(): WorkspaceActorDirectory;

  protected abstract explorationSeams(): ExplorationHostSeams;

  protected abstract subordinateSeams(): SubordinateHostSeams;

  /**
   * Each actor's home is provisioned in this isolate by the host (`actor-hosting.ts` →
   * `hostedActorAgentName`); its identity is its `workspace_actors` row, so there is no facet port.
   */

  /**
   * At the depth cap the team deps are absent, so the tools cannot be attempted. Core's classified
   * refusal covers a cached ToolSet built before a facet's identity was seeded.
   */
  protected teamProfile(): Pick<ActorToolDeps, 'team'> {
    return delegationExhausted(this.delegationBudget()) ? {} : { team: this.getTeamToolDeps() };
  }

  private _subordinateRoster: SubordinateRosterStore | null = null;

  protected get subordinateRoster(): SubordinateRosterStore {
    if (!this._subordinateRoster) {
      this._subordinateRoster = new SubordinateRosterStore(this.ctx.storage.sql, this.actorHandle());
      this._subordinateRoster.ensureSchema();
    }

    return this._subordinateRoster;
  }

  protected subordinateDelegates() {
    return subordinateDelegatesOf(this.subordinateRoster.list());
  }

  /**
   * One roster row as a chat surface draws it: lifecycle from the roster, title and role from config.
   * Config is read via the presence-fenced handle, not by name: a kept dismissal releases the name.
   */
  protected async subordinateView(name: string): Promise<SubordinateView> {
    const entry = this.subordinateRoster.get(name);

    if (entry === null) throw new Error(`Subordinate "${name}" is not in the roster`);
    const reference = entry.actorReference;

    if (reference === null) {
      // Admitted and not yet born: its seed is the only descriptor it has.
      const seed = entry.birth?.seed;

      if (seed === undefined) throw new KinuError('io', `Subordinate "${name}" has neither an actor nor a birth.`);

      return { ...entry, actorId: null, displayName: seed.displayName, role: seed.role };
    }

    const record = this.actorDirectoryStore().retained(reference.actorId);

    if (record === null) throw new KinuError('missing', `Subordinate "${name}" names an actor this workspace does not hold.`);
    const config = actorReadHandle(this.boundSql, record).config;

    return { ...entry, actorId: reference.actorId, displayName: config.getDisplayName() ?? entry.name, role: config.getRoleSelection() };
  }

  protected async subordinateViews(): Promise<SubordinateView[]> {
    return Promise.all(this.subordinateRoster.listAll().map(
      async (entry) => this.subordinateView(entry.name),
    ));
  }

  private _subordinateRosterBroadcast: AsyncTaskOwner | null = null;
  private _subordinateRosterBroadcastPending = false;

  protected broadcastSubordinatesChanged(_event?: SubordinatesChangedEvent): void {
    this._subordinateRosterBroadcastPending = true;

    if (this._subordinateRosterBroadcast !== null) return;
    const owner: AsyncTaskOwner = { promise: null };
    this._subordinateRosterBroadcast = owner;
    owner.promise = (async () => {
      try {
        while (this._subordinateRosterBroadcastPending) {
          this._subordinateRosterBroadcastPending = false;
          const subordinates = await this.subordinateViews();
          this.broadcast(JSON.stringify({ type: 'subordinates_changed', subordinates }));
        }
      } catch (cause) {
        diagnostics.failure('subordinate.roster_broadcast_failed', toKinuError({
          doing: 'building the subordinate roster read model',
          cause,
          otherwise: 'unavailable',
        }));
      } finally {
        if (this._subordinateRosterBroadcast === owner) {
          this._subordinateRosterBroadcast = null;

          if (this._subordinateRosterBroadcastPending) this.broadcastSubordinatesChanged();
        }
      }
    })();
  }

  protected broadcastSubordinateEvent(
    event: Omit<SubordinateActivityEvent, 'type' | 'id'> & { id?: string },
  ): void {
    this.broadcast(JSON.stringify({
      type: 'subordinate_event',
      id: event.id ?? nanoid(),
      kind: event.kind,
      subordinate: event.subordinate,
      status: event.status,
      content: event.content,
      task: event.task,
      timestamp: event.timestamp,
    } satisfies SubordinateActivityEvent));
  }

  /**
   * Hosted actors have no facet hop: `agent-routing.ts` refuses `sub` publicly and
   * `resolveHostedActorRoute` checks the directory and roster before the request reaches an actor.
   */
  private _subordinateRuntime: SubordinateRuntime | null = null;

  /** Memoized so the durable roster and the temporary register address the same actors. */
  protected subordinateRuntime(): SubordinateRuntime {
    this._subordinateRuntime ??= hostedSubordinateRuntime(
      this.subordinateSeams(),
      () => this.actorHost().bindStores(actorReferenceOf(this.actorHandle())),
    );

    return this._subordinateRuntime;
  }

  private _temporaryAgentPort: TemporaryAgentPort | null = null;

  /** Built once per actor: `shell` parks a waiter that the report ingress later resolves on this
   * isolate; a per-call port would leave every ask hanging. */
  protected temporaryAgentPort(): TemporaryAgentPort {
    this._temporaryAgentPort ??= createTemporaryAgentPort({
      roster: this.subordinateRoster,
      runtime: this.subordinateRuntime(),
      now: () => Date.now(),
      createName: mintSubordinateName,
    });

    return this._temporaryAgentPort;
  }

  protected getTeamToolDeps(): TeamToolDeps {
    return createTeamToolDeps({
      delegation: this.delegationBudget(),
      roster: this.subordinateRoster,
      runtime: this.subordinateRuntime(),
      temporary: this.temporaryAgentPort(),
      now: () => Date.now(),
      inheritedContext: () => this.readInheritedContext(),
      originContext: async () => this._turnOriginContext,
      ownMission: () => this.ownMission(),
      createName: mintSubordinateName,
      broadcast: (event) => this.broadcastSubordinatesChanged(event),
      broadcastTask: (event) => this.broadcastSubordinateEvent({
        kind: 'task',
        ...event,
      }),
    });
  }

  /**
   * Called by a child after it wrote its naming state; only fans `subordinates_changed`.
   * Must not call the child back (it is mid-turn). Not `@callable`: stub possession authorizes.
   */
  async recordSubordinateTitle(
    name: string,
    displayName: string,
  ): Promise<{ ok: true }> {
    this.ensureSchema();
    await this.getTeamToolDeps().recordTitle({ name, displayName });

    return { ok: true };
  }

  protected activeRoleLabel(): string {
    return this.config.getRoleSelection();
  }
  /**
   * Facet bootstrap authority, worker-side DO RPC only. The child's depth is decided here, never
   * from its own arguments, and seeding refuses at the cap even for a stale ToolSet.
   */
  async getSubordinateBootstrapIdentity(input: { name: string; reference: ActorReference }): Promise<{
    parentWorkspace: string;
    ownerUserId: string;
    model: string | null;
    depth: number | null;
    kind: ActorDirectoryResult['kind'];
    lifetime: ActorDirectoryResult['lifetime'];
    name: string;
    storageKey: string;
    creationId: string;
  } | Refusal> {
    try {
      this.ensureSchema();
      const child = await this.actorDirectory({ action: 'validate', name: input.name, reference: input.reference });
      const ownerUserId = this.getOwnerUserId();

      if (!ownerUserId) throw new KinuError('missing', 'The workspace has no owner.');
      let depth: number | null = null;

      if (child.kind === 'subordinate') {
        const own = this.delegationBudget();

        if (delegationExhausted(own)) throw new KinuError('denied', 'The parent cannot create a subordinate below its delegation depth.');
        depth = deriveChildDelegationBudget(own).depth;
      }

      return {
        parentWorkspace: this.workspaceName(), ownerUserId, model: this.config.getModel(),
        depth, kind: child.kind, lifetime: child.lifetime, name: child.name, storageKey: child.storageKey, creationId: child.creationId,
      };
    } catch (cause) {
      return refusalOf(toKinuError({ doing: 'reading a registered child bootstrap', cause, otherwise: 'io' }));
    }
  }

  /** Worker-side DO RPC only (not `@callable`). Reports use the same EventLog → drain rail as
   * mission inbox. */
  async receiveSubordinateEvent(input: {
    fromSubordinate: string;
    status: SubordinateReportStatus;
    content: string;
    origin: SubordinateReportOrigin;
    mode: WorkMode;
    /** Ingress dedupe key: a replayed report is one the parent already holds. */
    sequenceId: string;
  }): Promise<SubordinateEventResult> {
    this.ensureSchema();

    return receiveSubordinateEvent({
      log: this.eventLog,
      roster: this.subordinateRoster,
      vfs: this.rt.storage.vfs,
      transaction: (body) => this.ctx.storage.transactionSync(body),
      announce: (report) => {
        this.broadcastSubordinatesChanged();
        this.broadcastSubordinateEvent({ ...report, kind: 'report' });
      },
      onAdmitted: () => { this.orch.scheduleDrain(); },
      // A temporary child's answer belongs to the waiting `agents.ask` call, so the register gets
      // first refusal on the name through the port that parked the waiter.
      temporary: this.temporaryAgentPort(),
    }, input, Date.now());
  }

  /** Protected: the workspace root builds every hosted actor's model seams from this one
   *  owner-scoped service, so a head's spend resolves against the turn's provider snapshot. */
  protected readonly ownedModelServices = new OwnedModelServices({
    env: this.env,
    agentName: () => this.actorHandle().name,
    appTitle: 'Kinu',
    ownerRequired: true,
    getOwnerUserId: () => this.getOwnerUserId(),
    getUserCaller: () => this.userCaller(),
    // Asked of the same UserDO the registry reads, so a missed fan-out notification self-heals.
    getCredentialsRevision: async () => {
      const { stub, caller } = await this.userHub();

      return stub.getCredentialsRevision(caller);
    },
    onProviderWait: (info) => { this.noteProviderWait(info); },
    accountFor: (provider) => this.config.getProviderAccounts()[provider]
      ?? this.actorSession.profileInputs?.envelope.catalog.accounts?.[provider],
  });

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Must precede any read or write of it; see initCapabilitySchema.
    this.initCapabilitySchema();
    // A Durable Object is a DIFFERENT ISOLATE from the Worker that routes to it,
    // with its own module-level state — so the diagnostics sink installed at the
    // Worker's fetch entry does not exist in here, and every `diagnostics` line
    // an actor produces would reach Workers Logs and no dataset. Installed in the
    // constructor because that is the one point guaranteed to precede every RPC
    // (`onStart` is not — see `OrchestratorAgent.claimOwner`), and idempotent per
    // isolate, so a re-activation costs nothing.
    // The workspace is NOT passed. An isolate-level default would be wrong the
    // moment two actors share an isolate — `setDiagnosticsSink` is module-global
    // and Cloudflare co-locates Durable Objects, so the first actor to install
    // would own the attribution of every actor beside it. Each emit that knows
    // its workspace says so, as a `workspace` field; the rest are honestly
    // unattributed. See `analytics/install.ts`.
    installAnalyticsDiagnostics(this.env);
  }
  protected installClientMessageGate(): void {
    const dispatchMessage = this.onMessage.bind(this);
    this.onMessage = async (connection, message) => {
      if (await this.refuseRevokedSocketAuthority(connection, message)) return;
      const terminal = await this.terminalFor(connection);

      if (terminal) {
        await this.forwardTerminalFrame(terminal, connection, message);

        return;
      }

      const rejection = rejectOutOfScopeRpc(connection.tags, message);

      if (rejection) {
        connection.send(rejection);

        return;
      }

      const rpc = parseClientRpcFrame(message);

      if (rpc && this.isClientRpcMethodDenied(rpc.method)) {
        connection.send(JSON.stringify({
          type: 'rpc',
          id: rpc.id,
          success: false,
          error: `${rpc.method} is not available from client connections.`,
        }));

        return;
      }

      const event = v.is(v.string(), message) ? parseProtocolMessage(message) : null;
      const unavailable = this.actorRuntimeRefusal();
      const inspection = rpc && (requiredRpcAccess(rpc.method) === 'workspace.read' || rpc.method === 'inspectSubordinate' || rpc.method === 'exportWorkspaceArchive');

      if (unavailable && !inspection) {
        if (rpc) connection.send(JSON.stringify({ ...unavailable, type: 'rpc', id: rpc.id, success: false }));
        else if (event?.type === 'chat-request' || event?.type === 'stream-resume-ack') {
          connection.send(JSON.stringify({ reason: unavailable.reason, type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: event.id, body: unavailable.error, done: true, error: true }));
        } else connection.send(JSON.stringify({ ...unavailable, type: 'error' }));

        return;
      }

      // Chat frames go to the room; other frames (RPC, state sync) are the Agent base's.
      // A frame for an actor no longer hosted here is refused.
      if (v.is(v.string(), message)) {
        const room = this.chatRoomFor(connection);

        if (room === null) {
          connection.send(JSON.stringify({ type: 'error', error: 'The actor this connection addressed is no longer hosted here.' }));

          return;
        }

        if (await room.onMessage(connection, message)) return;
      }

      return await dispatchMessage(connection, message);
    };

    const baseOnConnect = this.onConnect.bind(this);
    const baseOnClose = this.onClose.bind(this);

    this.onConnect = async (connection, ctx) => {
      if (await this.refuseRevokedSocketAuthority(connection, '')) return;
      this.connectionOpened();

      await baseOnConnect(connection, ctx);
      const terminal = await this.terminalFor(connection);

      if (terminal) await terminal.attachTerminal(connection);
      else await this.chatRoomFor(connection)?.onConnect(connection);
    };

    this.onClose = async (connection, code, reason, wasClean) => {
      const terminal = await this.terminalFor(connection);

      if (terminal) terminal.terminalClose(connection);
      else this.chatRoomFor(connection)?.onClose(connection);
      await baseOnClose(connection, code, reason, wasClean);

      // Exclude the closing socket's id explicitly; the platform's state for it is not guaranteed.
      for (const other of this.getConnections()) if (other.id !== connection.id) return;

      this.lastConnectionClosed();
    };

    const dispatchRequest = this.onRequest.bind(this);

    this.onRequest = async (request) => {
      const url = new URL(request.url);

      if (url.pathname === '/get-messages' || url.pathname.endsWith('/get-messages')) {
        // The seed is fetched on the same path the pane's socket opens, so each pane gets its own
        // actor's rows.
        const hosted = hostedActorRoute(url.pathname);
        const history = await (hosted === null ? this.chatTranscript.history() : this.hostedChatWire(hosted.name)?.history());

        if (history === undefined) return Response.json({ reason: 'missing', error: 'The actor is not hosted here.' }, { status: 404 });

        return Response.json(history);
      }

      return await dispatchRequest(request);
    };
  }
  /** Lazy: `actorHandle()` resolves the directory row `ensureSchema` creates, after field init. */
  private _pendingSends: PendingSendStore | null = null;
  private get pendingSends(): PendingSendStore {
    return this._pendingSends ??= new PendingSendStore(this.boundSql, this.actorHandle().actorId);
  }

  /** True when an open turn or undrained acknowledged send exists; the loop is then built under
   *  a wake, never inside the init gate, because a turn is external work. */
  protected chatLoopOwesWork(): boolean {
    return this.eventRecorder.openTurn() !== null || this.pendingSends.restore().length > 0;
  }

  /** Constructing the loop re-opens the last open turn and reruns acknowledged sends. */
  protected resumeChatLoop(): ChatSession {
    return this.chatLoop;
  }

  /** Reads SQL, not the RAM drain, which an eviction loses. Only turn-bound rows are steers;
   *  unbound rows are the loop's own sends, already shown as messages, never as chips. */
  protected pendingSteerRuns(): InlineSteer[] {
    return this.pendingSends.restore()
      .filter((row) => row.turnId !== null)
      .map((row) => ({ id: row.id, text: row.text, state: 'queued' as const, atStep: null }));
  }

  // A durable turn ends once; its effects are claimed in `tool_effect_claims` keyed on the
  // durable turn id, written before the first effect and settled after the last.
  // Not exactly-once externally: each external effect relies on its own idempotency key.

  /** Effect bodies shared by every actor; per-actor effects live in each actor's own table. */
  protected sharedTerminalEffects(): TerminalEffectTable {
    return {
      turn_end_extensions: terminalEffect({
        input: v.object({ messageId: v.string() }),
        // Replayed from the recorded message, not a live tree; the row stops a second announcement.
        // Convert inside the durable effect so an eviction leaves an owed announcement.
        run: async ({ messageId }) => {
          const message = await this.chatTranscript.message(messageId);

          if (message === null) throw new KinuError('missing', 'terminal effect has no canonical answer');
          const projected = await this.chatTranscript.project(messageId);

          if (projected === null) throw new KinuError('missing', 'terminal effect has no canonical answer');
          const text = projected.content;
          // A refusal, not a retry: the stored message is fixed, so a part tree the converter rejects
          // never parses later and an owed row would retry forever. The announcement still fires.
          let responseMessages: ModelMessage[] = [];
          let refusal: string | undefined;

          try {
            responseMessages = await convertToModelMessages(
              [message], { ignoreIncompleteToolCalls: true },
            );
          } catch (err) {
            const failure = toKinuError({
              doing: "reading the recorded assistant message this turn's extensions announce",
              cause: err,
              otherwise: 'bad_input',
            });

            diagnostics.failure('turn.turn_end_messages_unreadable', failure);
            refusal = failure.message;
          }

          await this.extensions.emitTurnEnd({ text, responseMessages });

          return refusal === undefined
            ? { status: 'completed' }
            : { status: 'completed', detail: refusal };
        },
      }),
      // Follow-up turns a settled turn can owe; each is owed until its own turn is on disk.
      overflow_retry: overflowRetryTerminalEffect(() => this.chatLoop),
      output_continuation: outputLimitContinuationTerminalEffect(() => this.chatLoop),
      task_reminder: taskReminderTerminalEffect(() => this.chatLoop),

      turn_record: turnRecordTerminalEffect(this.orch),
      event_drain: eventDrainTerminalEffect(this.orch),

      improvement_lanes: terminalEffect({
        input: v.object({
          status: RunEndReasonSchema, turn: JsonValueSchema, workMode: WorkModeSchema,
          advisor: JsonValueSchema,
        }),
        // Lanes read durable queues on re-entry (per-turn snapshots do not survive), and the verdict
        // uses the recorded mode so a fresh activation's default cannot open an unearned lane.
        run: async ({ status, turn, workMode, advisor }) => {
          this.warmUserMcpInBackground();

          if (!this.orch.improvementLanesOpen(status, workMode)) {
            return { status: 'completed', detail: 'improvement lanes closed for this turn' };
          }

          this.settleEvolutionInBackground();
          const snapshot = v.parse(AdvisorRecoverySnapshotSchema, advisor);
          // Awaited to the lane's checkpoint, not its finish: `runFiber` awaits `keepAlive()` before its
          // body, and a later turn's tool set must not bleed into this review.
          await this.actorSession.startAdvisorLane({
            turn: v.parse(CompletedTurnSchema, turn),
            snapshot: advisor,
            carry: (name, body) => this.runFiber(name, body),
            review: async () => { await this.runAdvisorReview(snapshot); },
          });

          return { status: 'completed' };
        },
      }),

      shadow_trial: shadowTrialTerminalEffect(this.engine),
    };
  }

  /** The effects this actor's terminal sequence can owe; both actor kinds spread in {@link
   *  sharedTerminalEffects}. */
  protected terminalEffectTable(): TerminalEffectTable {
    return {};
  }

  private _terminalTransitions: TerminalTransitions | null = null;

  /** Core's once-only lifecycle; the DO supplies only effect bodies and the wake, as the CLI does. */
  protected get terminal(): TerminalTransitions {
    this._terminalTransitions ??= new TerminalTransitions({
      actor: this.actorHandle(),
      sql: this.boundSql,
      effects: this.terminalEffectTable(),
      now: () => Date.now(),
      fault: () => this.terminalEffectFault,
      // A synchronous DO run is already atomic; transactionSync keeps the claim and roster one unit
      // regardless of what core later puts between them.
      transaction: (body) => this.ctx.storage.transactionSync(body),
      // Release must not run while an auto-continuation is calling tools under this turn before it
      // has its own terminal claim; see {@link turnMayStillRun}.
      turnIsLive: (turnId) => this.turnMayStillRun(turnId),
      scheduleRetry: async (atMs: number) => { await this.scheduleTerminalRetry(atMs); },
    });

    return this._terminalTransitions;
  }

  /**
   * Whether another response of this turn may still run. `_inFlight` misses a fresh activation
   * after isolate death, and `durableTurnId` alone outlives its turn.
   */
  private turnMayStillRun(turnId: string): boolean {
    if (this._inFlight && this.durableTurnId() === turnId) return true;

    // A ledger-open run for this turn will be re-opened as a continuation on restart; the settling
    // response's own run is already closed.
    return this.eventRecorder.openTurn()?.turn.turnId === turnId;
  }

  /**
   * Idempotent soonest-wins arm of one durable wake row per `callback`; shared by all Kinu wake chains.
   * Writes before collapsing, re-reads after the write so racers converge, and counts future rows only.
   */
  protected async armWakeRow(callback: keyof this & string, atMs: number): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    // Round up: the SDK stores whole seconds, and waking early would re-arm and busy-spin the alarm.
    const targetSec = Math.max(Math.ceil(atMs / 1000), nowSec + 1);

    const pending = async (): Promise<{ id: string; time: number }[]> =>
      (await this.listSchedules())
        .filter((row) => row.callback === callback && row.time > nowSec)
        .map((row) => ({ id: row.id, time: row.time }));

    const armed = await pending();
    const desired = Math.min(targetSec, ...armed.map((row) => row.time));

    if (armed.length === 1 && armed[0].time === desired) return armed[0].id;
    await this.schedule(new Date(desired * 1000), callback);
    const settled = await pending();

    const keeper = settled.reduce((best, row) =>
      row.time < best.time || (row.time === best.time && row.id < best.id) ? row : best);

    // The keeper is never cancelled, so failure leaves extra wakes, never zero; errors propagate.
    for (const row of settled) {
      if (row.id !== keeper.id) await this.cancelSchedule(row.id);
    }

    return keeper.id;
  }

  /** One soonest-wins row per actor; returns the surviving row's id so a caller can release it. */
  protected scheduleTerminalRetry(atMs: number): Promise<string> {
    return this.armWakeRow(TERMINAL_RETRY_CALLBACK, atMs);
  }

  /** Public because `Agent.schedule()` types callbacks as `keyof this`; idempotent, re-arms from storage. */
  /**
   * `armWakeRow` collapses future rows only, so repeated deaths inside the tick leave overdue rows
   * the SDK runs in one alarm. Retire every other due row first; the SDK passes this callback its own.
   */
  async _kinuTerminalRetryTick(_payload: undefined, own: Schedule<undefined>): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);

    for (const row of await this.listSchedules()) {
      if (row.callback === TERMINAL_RETRY_CALLBACK && row.time <= nowSec && row.id !== own.id) await this.cancelSchedule(row.id);
    }

    await this.terminalRetryPass();
  }

  async terminalRetryPass(): Promise<void> {
    // Arm first, drain second: the next-lap wake is durable before any pass runs, so a kill
    // inside this frame leaves a future row. A tick that finds nothing owed releases it at the end.
    const armedRowId = await this.scheduleTerminalRetry(
      Date.now() + recoveryBackoffMs(this.#maintenanceLaps + 1));

    // Owed deliveries run every tick; unfinished maintenance re-arms at the shared capped backoff,
    // so a pass that keeps answering unfinished settles at the ceiling, not a one-second loop.
    const sweepsUnfinished = this.maintenanceSweeps();
    const recoveryUnfinished = await this.maintenanceWork();
    await this.owedDeliveryWork();
    // Re-entered here because `maintenanceWork` is activation-scoped: later ticks in a warm
    // isolate never reach the job sweep, and a deferred job's wake would find nothing to recover.
    await this.jobRunner.recoverDueResumes();

    // Untimed owed work names no instant, so the lap-paced row is kept (a missing row sleeps until
    // an external event). Only timed work: arm at its instant, soonest-wins. Nothing owed: sleep.
    const nextOwed = this.nextOwedAt();

    if (sweepsUnfinished || recoveryUnfinished || this.owedUntimedWork()) {
      this.#maintenanceLaps = this.#maintenanceLaps + 1;

      if (nextOwed !== null) await this.scheduleTerminalRetry(nextOwed);
    } else {
      this.#maintenanceLaps = 0;
      await this.cancelSchedule(armedRowId);

      if (nextOwed !== null) await this.scheduleTerminalRetry(nextOwed);
    }
  }

  /**
   * Consecutive unfinished laps; paces the re-arm. In-memory is enough: the delay is baked into
   * the schedule row, so a restart only resets the ramp and cannot shorten an armed wake.
   */
  #maintenanceLaps = 0;

  /**
   * Runs every tick regardless of maintenance's answer, so owed replies never queue behind a sweep.
   * Subclasses prepend extra owed lanes here so all ride one durable wake.
   */
  protected async owedDeliveryWork(): Promise<void> {
    await this.terminal.replayOwedAndRearm();
  }

  protected owedWorkExists(): boolean {
    return this.owedUntimedWork() || this.nextOwedAt() !== null;
  }

  /** While true, the tick keeps its lap-paced row. Base owns no rosters; subclasses override. */
  protected owedUntimedWork(): boolean {
    return false;
  }

  /** Earliest timed obligation instant, or null when only untimed work (or nothing) remains.
   *  Subclasses that own the ledgers override. */
  protected nextOwedAt(): number | null {
    return null;
  }

  /** Test-only deterministic cut point in the terminal sequence. Null in production. */
  protected terminalEffectFault: TerminalEffectFault | null = null;

  /** Read at the start of a terminal sequence and carried through: the loop's live turn becomes
   *  the next one as soon as it opens, so a detached re-read could close the wrong claim. */
  protected durableTurnId(): string | null {
    const live = this._chatLoop?.currentTurnId;

    if (live !== undefined && live !== null) return live;

    // Cold activation has no live turn: the newest unsettled claim this actor admitted is the turn.
    return this.stores.claims.unsettled(1)[0]?.turnId ?? null;
  }

  /**
   * Cloudflare version metadata id, the only real build identity inside a DO; null when unbound.
   * Never substitute the package version or a digest that would read back as verified.
   */
  private installedBuildIdentity(): string | null {
    return this.env.CF_VERSION_METADATA?.id ?? null;
  }

  /**
   * The terminal sequence this actor started most recently, resolved once its disposition is written.
   * Retained because the close is detached; an unnamed detached chain could never be joined.
   */
  protected _terminalReported: Promise<void> = Promise.resolve();
  private _terminalReportedOwner: AsyncTaskOwner | null = null;

  /**
   * Keep this isolate alive for a terminal close via a durable fiber, since a bare promise is not a
   * wake; the fiber's run row hands leftovers to {@link classifyRecoveredFiber}. Order: hold, join, dispose.
   */
  protected holdTerminalClose(transition: TerminalTransition, close: () => Promise<void>): void {
    const prior = this._terminalReported;
    const owner: AsyncTaskOwner = { promise: null };
    this._terminalReportedOwner = owner;

    const task = (async () => {
      try {
        // Chain closes so the latest owner retains every earlier close instead of overwriting a live fiber.
        await prior;
        await this.runFiber(TERMINAL_LANE_FIBER, async (ctx) => {
          ctx.stash({ lane: TERMINAL_LANE_FIBER });
          await close();
        });
      } catch (cause) {
        // An eviction needs no cleanup; a rejection that leaves this isolate alive does.
        await this.terminal.closeFailed(transition, { cause });
      } finally {
        if (this._terminalReportedOwner === owner) {
          this._terminalReportedOwner = null;
          this._terminalReported = Promise.resolve();
        }
      }
    })();

    owner.promise = task;
    this._terminalReported = task;
  }

  /** Uses `effectiveModelSpec`: the stored spec can be null or an un-normalized alias. */
  private analyticsModel(): ModelDimensions {
    return this.analyticsModelOf(this.effectiveModelSpec());
  }

  /**
   * `parseModelSpec` throws on unknown shapes and `report.spec` comes from many producers, so a
   * malformed spec costs the row its dimensions rather than the caller its turn.
   */
  private analyticsModelOf(spec: string): ModelDimensions {
    if (!spec) return UNRESOLVED_MODEL;

    try {
      const { provider, modelId } = parseModelSpec(spec);

      return { provider, model: modelId };
    } catch (error) {
      diagnostics.event('actor.model_spec_unparseable', {
        workspace: this.name, error: renderThrownChain({ cause: error }),
      });

      return UNRESOLVED_MODEL;
    }
  }

  /** Cost at the model's current catalog rate; undefined when the catalog has no rate. */
  private priceAt(usage: Usage): number | undefined {
    const pricing = this.modelCatalog.pricing();

    return pricing ? priceCall(usage, pricing)?.usd : undefined;
  }

  /** Lazy: resolves this actor's handle, whose directory row does not exist until `ensureSchema`
   *  runs; resolving in the constructor throws on a fresh database. */
  private _compactionState: CompactionStateStore | null = null;
  protected get compactionState(): CompactionStateStore {
    return (this._compactionState ??= createCompactionStateStore(this.boundSql, this.actorHandle()));
  }

  /** Durable-history length (ModelMessage count) the turn's prompt-token measurement is bound to. */
  protected _turnDurableLength = 0;

  /** Shared by the per-turn extension and swarm ladder so outcome names cannot drift. */
  private readonly compactionLogger: CompactionLogger = {
    info: (message, data) => this.logActivity('compaction', compactionLogDetail(message, v.safeParse(CompactionDetailSchema, data))),
    debug: (message) => diagnostics.event('compaction.debug', { message }),
    warn: (message, data) => { this.reportCompaction('warn', message, v.safeParse(CompactionDetailSchema, data)); },
    error: (message, data) => { this.reportCompaction('error', message, v.safeParse(CompactionDetailSchema, data)); },
  };

  private reportCompaction(outcome: keyof typeof COMPACTION_OUTCOMES, message: string, detail: CompactionDetail): void {
    const { event, code, activity } = COMPACTION_OUTCOMES[outcome];

    diagnostics.failure(event, new KinuError(code, message));
    this.logActivity(activity, compactionLogDetail(message, detail));
  }

  /** Registered from `ensureSchema`, not the constructor: its plan port resolves this actor's
   *  handle, which needs the directory row `ensureSchema` creates. */
  /** Handed to every turn; core adds the inbox's own turn extension itself. */
  private _compactionExtension: KinuExtension | null = null;

  protected registerCompactionExtension(): void {
    this._compactionExtension = createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => this.rt.storage.vfs),
        plans: this.compactionState.plans,
        logger: this.compactionLogger,
      },
      archive: this.compactionState.archive,
      summarize: createModelSummarizer(() => this.getModel(), {
        source: 'compaction', report: (report) => this.reportModelCall(report),
        operations: this.modelOperations,
      }),
      // The ladder's first rung prunes this session ledger before any tool output.
      ephemeral: this.actorSession.dynamic,
      onOutcome: ({ outcome }) => {
        // A new or invalidated plan makes the dynamic ledger's frozen block positions meaningless; this
        // fires before the first step weave. A byte-stable replay keeps positions valid.
        if (outcome !== 'replayed') this.actorSession.dynamic.reset();
      },
    });
    this.extensions.register(this._compactionExtension);
  }

  /** Tags ride the WebSocket attachment, so the rpc gate, both identities and the pane's chat room
   *  survive DO hibernation (edge-set headers, see appendIdentityHeaders). */
  override async getConnectionTags(connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const tags = await super.getConnectionTags(connection, ctx);
    const scopeTag = cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER));
    const bearerTag = cliBearerConnectionTag(ctx.request.headers.get(CLI_BEARER_HEADER));
    const sessionTag = sessionBearerConnectionTag(ctx.request.headers.get(SESSION_BEARER_HEADER));
    // server.ts routes a hosted actor's chat without rewriting the path, so the addressed actor
    // is readable only here.
    const actorTag = actorConnectionTag(new URL(ctx.request.url).pathname);

    return [
      ...tags,
      ...(scopeTag === null ? [] : [scopeTag]),
      ...(bearerTag === null ? [] : [bearerTag]),
      ...(sessionTag === null ? [] : [sessionTag]),
      ...(actorTag === null ? [] : [actorTag]),
    ];
  }

  /**
   * Close every CLI websocket admitted before `generation`; called by the owner's UserDO on revocation.
   * A silent client sends no frames but keeps receiving the stream; unreadable bearers are closed.
   */
  async closeRevokedCliSockets(generation: number): Promise<{ closed: number }> {
    let closed = 0;

    for (const connection of this.getConnections()) {
      const bearer = cliBearerFromTags(connection.tags);

      if (bearer === null) continue;

      if (bearer.readable && bearer.generation >= generation) continue;
      connection.close(WEBSOCKET_POLICY_CLOSE, CLI_AUTHORITY_REVOKED);
      closed += 1;
    }

    if (closed > 0) {
      diagnostics.event('auth.cli_sockets_closed', { outcome: 'denied', closed, generation });
    }

    return { closed };
  }

  /**
   * Close every websocket authenticated on the named browser session; called by UserDO on logout.
   * A silent socket never reaches the frame-time check, so revocation has to push.
   */
  async closeRevokedSessionSockets(sessionTokenHash: string): Promise<{ closed: number }> {
    let closed = 0;

    for (const connection of this.getConnections()) {
      const session = sessionBearerFromTags(connection.tags);

      if (session === null) continue;

      if (!('tokenHash' in session) || session.tokenHash !== sessionTokenHash) continue;
      connection.close(WEBSOCKET_POLICY_CLOSE, SESSION_AUTHORITY_REVOKED);
      closed += 1;
    }

    if (closed > 0) {
      diagnostics.event('auth.session_sockets_closed', { outcome: 'denied', closed });
    }

    return { closed };
  }

  /**
   * Upgrade checks authority once and hibernated sockets resume without it, so re-check per frame.
   * Asks the owning UserDO (no cached verdict); an unreachable UserDO refuses the frame.
   */
  private async refuseRevokedSocketAuthority(connection: Connection, message: WSMessage): Promise<boolean> {
    const denial = await this.socketAuthorityDenial(connection);

    if (denial === null) return false;
    const rpc = parseClientRpcFrame(message);

    // The rpc reply carries the authority's reason so a pending call fails instead of hanging;
    // the close reason is the user-facing instruction for the token kind.
    if (rpc) connection.send(JSON.stringify({ type: 'rpc', id: rpc.id, success: false, error: denial.why }));
    connection.close(WEBSOCKET_POLICY_CLOSE, denial.close);
    diagnostics.event('auth.socket_frame_denied', { outcome: 'denied', reason: 'authority_not_live' });

    return true;
  }

  /** Denial reason plus client instruction, or null when the connection may act.
   *  Bearer and session each fail closed; a connection carrying both is refused by whichever died. */
  private async socketAuthorityDenial(
    connection: Connection,
  ): Promise<{ why: string; close: string } | null> {
    const bearer = cliBearerFromTags(connection.tags);

    if (bearer !== null) {
      const denial = await this.cliBearerDenial(bearer);

      if (denial !== null) return { why: denial, close: CLI_AUTHORITY_REVOKED };
    }

    const session = sessionBearerFromTags(connection.tags);

    if (session !== null) {
      const denial = await this.sessionBearerDenial(session);

      // A session denial is already an instruction, so it doubles as the close reason.
      if (denial !== null) return { why: denial, close: denial };
    }

    return null;
  }

  /** Unreadable tag or unreachable UserDO both refuse: authority must be confirmable. */
  private async sessionBearerDenial(session: { tokenHash: string } | { unreadable: true }): Promise<string | null> {
    if ('unreadable' in session) {
      return 'This connection carries no readable session. Reload the page to sign in again.';
    }

    try {
      const { stub, caller } = await this.userHub();

      const verified = await retryTransientDO('verifySocketSession',
        () => stub.verifySocketSession(caller, session.tokenHash));

      return verified.live ? null : SESSION_AUTHORITY_REVOKED;
    } catch (cause) {
      diagnostics.failure('auth.session_bearer_check_failed', toKinuError({
        doing: 'checking whether a websocket\'s browser session is still live',
        cause,
        otherwise: 'unavailable',
      }), { workspace: this.name });

      return 'This connection\'s authorization could not be confirmed. Reload the page to sign in again.';
    }
  }

  /** Denial reason for the CLI bearer, or null. A generation newer than the account's is refused. */
  private async cliBearerDenial(bearer: CliSocketBearer): Promise<string | null> {
    if (!bearer.readable) return 'This connection carries no readable authorization. Reconnect with: kinu auth';

    try {
      const { stub, caller } = await this.userHub();

      const verified = await retryTransientDO('verifyCliSocketBearer',
        () => stub.verifyCliSocketBearer(caller, bearer.tokenHash));

      if (verified.live && verified.generation <= bearer.generation) return null;

      return verified.error ?? CLI_AUTHORITY_REVOKED;
    } catch (cause) {
      diagnostics.failure('auth.cli_bearer_check_failed', toKinuError({
        doing: 'checking whether a websocket\'s CLI bearer is still live',
        cause,
        otherwise: 'unavailable',
      }), { workspace: this.name });

      return 'This connection\'s authorization could not be confirmed. Reconnect with: kinu auth';
    }
  }

  /** Scoped access-token connections may chat but never write agent state. */
  override shouldConnectionBeReadonly(connection: Connection, ctx: ConnectionContext): boolean {
    return this.actorRuntimeRefusal() !== null || super.shouldConnectionBeReadonly(connection, ctx)
      || ctx.request.headers.get(CLI_SCOPES_HEADER) !== null;
  }

  private _rt: CFRuntime | null = null;
  /**
   * The workspace root's ActorSession; children build theirs in `actor-hosting.ts`.
   * Built synchronously because `onStart` may not await.
   */
  private _actorSession: ActorSession | null = null;
  protected get actorSession(): ActorSession {
    this._actorSession ??= new ActorSession({
      runtime: this.rt,
      claims: this.claims,
      history: this.stores.history,
      installedBuild: this.installedBuildIdentity(),
      events: this.stores.eventRecorder,
      orchestration: this.orchestrationDeps(),
    });

    return this._actorSession;
  }

  /** The core turn loop; see {@link ChatSession} for the invariants. */
  private _chatLoop: ChatSession | null = null;
  protected get chatLoop(): ChatSession {
    if (!this._chatLoop) {
      this._chatLoop = new ChatSession({
        actorSession: this.actorSession,
        sessionId: 'default',
        transcript: this.chatTranscript,
        pendingSends: this.pendingSends,
        eventLog: this.eventLog,
        eventRecorder: this.eventRecorder,
        compactionState: this.compactionState,
        // Use the platform's transaction so the commit stays one unit whatever core puts between statements.
        transaction: (body) => this.ctx.storage.transactionSync(body),
        transport: this.chatTransport,
        mintAnswerId: () => this.mintAnswerId(),
        ports: {
          prepareTurn: (item, lease) => this.prepareTurn(item, lease),
          owedTerminalEffects: (input) => this.owedTerminalEffects(input),
          terminal: () => this.terminal,
          taskList: () => this.stores.taskList,
          // A running job's settle wakes the session; a reminder fired behind it would race that wake.
          hasPendingAsyncWake: () => this.stores.jobs.listRunning(1).total > 0,
          holdTerminalClose: (transition, close) => { this.holdTerminalClose(transition, close); },
          driverGate: () => this.driverGate(),
          // The workspace UI IS the review surface: a plan turn is admitted.
          planTurnRefusal: () => null,
          // Prompt-cache warming belongs to the root actor (it owns the wake chain); hosted actors wire none.
          ...(this.cacheWarmingLane() && { cacheWarming: this.cacheWarmingLane() }),
          // Arm the turn's own wake at its open, so a kill mid-turn leaves both the run row and the wake
          // that re-drives what it owed.
          armTurnWake: async (atMs) => { await this.scheduleTerminalRetry(atMs); },
          steerSkills: (text) => steerSkillsBlock({
            vfs: this.rt.storage.vfs,
            config: this.config,
            userText: text,
            trust: this.instructionTrust(),
            limits: this.modelCatalog.window(),
            alreadyActive: new Set(this._turnActiveSkills?.active.map((skill) => skill.name) ?? []),
          }),
        },
      });
      this.observeFleetRows();
    }

    return this._chatLoop;
  }

  private _chatTransport: ChatWireTransport | null = null;
  protected get chatTransport(): ChatWireTransport {
    this._chatTransport ??= new ChatWireTransport({
      sql: this.boundSql,
      broadcast: (message, exclude) => { this.broadcastToActor(null, message, exclude); },
      getConnection: (id) => this.getConnection(id),
      history: () => this.chatTranscript.history(),
      admitted: (id) => this.admittedSend(id),
      send: (input) => this.chatLoop.send({ text: input.text, files: input.files }, { id: input.id, mode: input.mode }),
      interrupt: () => { this.chatLoop.interrupt(); },
      clear: () => this.clearConversation(),
    });

    return this._chatTransport;
  }

  /**
   * Send only to the sockets addressing one actor; for the root, connections with no actor tag,
   * which `getConnections(tag)` cannot express. Uses `broadcast` since only it reaches hibernated sockets.
   */
  protected broadcastToActor(actor: string | null, message: string, exclude?: readonly string[]): void {
    const elsewhere: string[] = [];

    for (const connection of this.getConnections()) {
      if (actorFromConnectionTags(connection.tags) !== actor) elsewhere.push(connection.id);
    }

    this.broadcast(message, [...new Set([...(exclude ?? []), ...elsewhere])]);
  }

  /** The runtime shell a socket addresses, or null for a chat or RPC socket; the base always returns null. */
  protected terminalFor(_connection: Pick<Connection, 'tags'>): Promise<WorkspaceTerminal | null> {
    return Promise.resolve(null);
  }

  /**
   * Validates the frame at the client boundary; a socket sending any other shape is closed with the reason.
   */
  private async forwardTerminalFrame(terminal: WorkspaceTerminal, connection: Pick<Connection, 'send' | 'close'>, message: WSMessage): Promise<void> {
    const frame = v.is(v.string(), message)
      ? v.safeParse(WorkspaceTerminalInputSchema, tolerate(() => JSON.parse(message), 'malformed-input'))
      : null;

    if (frame === null || !frame.success) {
      connection.close(WEBSOCKET_POLICY_CLOSE, 'terminal frame refused: not an input or resize frame');

      return;
    }

    await terminal.terminalFrame(connection, JSON.stringify(frame.output));
  }

  /** Excludes terminal sockets: they carry only shell frames, not the actor protocol. */
  override broadcast(message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
    const terminals: string[] = [];

    for (const connection of this.getConnections()) {
      if (isWorkspaceTerminal(connection.tags)) terminals.push(connection.id);
    }

    super.broadcast(message, terminals.length === 0 ? without : [...(without ?? []), ...terminals]);
  }

  private _chatRooms: ActorChatRooms | null = null;
  protected get chatRooms(): ActorChatRooms {
    return this._chatRooms ??= new ActorChatRooms(() => this.chatTransport, (name) => this.hostedChatWire(name));
  }

  /** Null when the addressed actor is no longer hosted here. */
  protected chatRoomFor(connection: Connection): ChatWireTransport | null {
    return this.chatRooms.for(actorFromConnectionTags(connection.tags));
  }

  /** Null when this workspace hosts no such actor; only the workspace root knows its directory. */
  protected abstract hostedChatWire(name: string): ChatWire | null;

  /** Fires for any actor's connection; the root's sleep-time closed-tab trigger overrides both hooks. */
  protected connectionOpened(): void {}

  /** Fires once per emptying, in the close hook, after the room has been told. */
  protected lastConnectionClosed(): void {}

  /** Fires after each committed change to the root actor's turn claims. */
  protected abstract turnClaimChanged(): void;

  protected get orch(): AgentOrchestrator { return this.actorSession.orchestrator; }

  protected abstract owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[];

  private orchestrationDeps(): AgentOrchestratorDeps {
    {
      return {
        host: this.host,
        engine: this.engine,
        eventLog: this.eventLog,
        budget: this.budget,
        // Runs on the single off-turn cadence pass, beside the promotion gate's trials; every actor wires it.
        refinementLane: async () => { await refinementPass(this.refinementDeps); },
        sinks: {
          logActivity: (e, d) => {
            // Measured from the turn's own start: user-visible first token, not a transport first byte.
            if (e === 'first_chunk' && this.acc.startedAt > 0) {
              recordTtftRow(this.env, {
                workspace: this.workspaceName(),
                agentKind: this.actorKind(),
                ...this.analyticsModel(),
                ttftMs: Date.now() - this.acc.startedAt,
              });
            }

            this.logActivity(e, d);
          },
          onToolCallEvent: (ev) => {
            // Record the fleet row first: the durable emit below can throw and must not cost the count.
            // Name, verdict and duration only; `args` and `result` carry user workspace content.
            recordToolRow(this.env, {
              workspace: this.workspaceName(),
              agentKind: this.actorKind(),
              tool: ev.name,
              failed: ev.error !== undefined && ev.error !== '',
              durationMs: ev.durationMs ?? 0,
            });

            try {
              if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, { type: 'tool_call_end', ...ev });
            } catch (err) {
              diagnostics.failure('event.tool_call_end_emit_failed', toKinuError({
                doing: 'recording a tool_call_end run event',
                cause: err,
                otherwise: 'io',
              }));
            }
          },
          onStepEvent: (ev) => {
            try {
              if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, { type: 'step_finish', ...ev });
            } catch (err) {
              diagnostics.failure('event.step_finish_emit_failed', toKinuError({
                doing: 'recording a step_finish run event',
                cause: err,
                otherwise: 'io',
              }));
            }
          },
        },
      };
    }
  }

  protected get acc(): TurnAccumulator { return this.orch.acc; }

  /** Cumulative cap a scheduled run or fork opts into; costs nothing with no active label.
   * Public so the `agent.*` namespace uses the same object the enforcement seams hold. */
  private _budget: MissionGovernor | null = null;
  get budget(): MissionGovernor {
    this._budget ??= new MissionGovernor({
      actor: this.actorHandle(),
      storage: this.rt.storage,
      // Real USD from catalog rates; null until the lookup lands, then the ledger blends and says so.
      pricing: (spec) => this.modelCatalog.pricing(spec),
      onExhausted: ({ error: _error, ...refusal }) => {
        try {
          if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, { type: 'budget_exhausted', ...refusal });
        } catch (err) {
          diagnostics.failure('event.budget_exhausted_emit_failed', toKinuError({
            doing: 'recording a budget_exhausted run event',
            cause: err,
            otherwise: 'io',
          }));
        }
      },
    });

    return this._budget;
  }

  /**
   * Mission ledger for facets, which run as separate DOs the governed `LLM` never sees; called over
   * a cross-DO stub. Not `@callable`: a spend ledger must not be writable over public WS/HTTP.
   * Inert with an empty label set.
   */
  async missionGuard(
    seam: MissionSeam, labels: readonly string[],
  ): Promise<MissionBudgetRefusal | null> {
    return this.budget.guard(seam, labels);
  }

  async missionDebit(tokens: number, opts: {
    labels: readonly string[]; calls?: number; spawns?: number; usage?: Usage;
  }): Promise<void> {
    this.budget.debit(tokens, opts);
  }

  /**
   * A facet's non-turn model call, filed in the root workspace's event log so spend is not stranded
   * in facet SQLite. Not `@callable` (spend must not be writable over WS/HTTP); allowlisted in
   * rpc-surface.ts.
   */
  async reportFacetModelCall(report: ModelCallReport): Promise<void> {
    this.reportModelCall(report);
  }

  /** A facet's model-operation frames, to the same root log as reportFacetModelCall.
   *  Not `@callable`; allowlisted in rpc-surface.ts. */
  async reportFacetModelOperation(event: ModelOperationEvent): Promise<void> {
    this.modelOperations(event);
  }

  // Head-journal writes for a recursive split run in this isolate (orchestrator.ts `runHostedSplit`),
  // so spawn/report rows land beside their head_steps. Never `@callable`; allowlisted in rpc-surface.ts.

  async headJournalRecordSplit(rootId: HeadId, rationale: string, spawnedAt: number): Promise<void> {
    this.headJournal.recordSplit(rootId, rationale, spawnedAt);
  }

  async headJournalInsertSpawn(input: HeadInput): Promise<void> {
    this.headJournal.insertSpawn(input);
  }

  async headJournalRecordReport(report: HeadReport): Promise<void> {
    // The journal write publishes the report's announcement; do not broadcast again here.
    this.headJournal.recordReport(report);
  }

  async headJournalCacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): Promise<void> {
    this.headJournal.cacheMerge(rootId, result, strategy);
  }

  private _evolutionSettling: AsyncTaskOwner | null = null;

  /**
   * Settle both evolution lanes (turn lane and cadence session pass) in a durable fiber, detached so
   * the chat queue is not blocked. A fiber, not `keepAliveWhile`: its `cf_agents_runs` row lets
   * {@link onFiberRecovered} resume a lane lost to deploy/restart. Inputs are re-read from durable
   * queues, so the stash holds only the lane name. One lane at a time.
   */
  protected settleEvolutionInBackground(): void {
    if (this._evolutionSettling !== null) return;
    const owner: AsyncTaskOwner = { promise: null };
    this._evolutionSettling = owner;
    owner.promise = (async () => {
      try {
        await this.runFiber(EVOLUTION_LANE_FIBER, async (ctx) => {
          ctx.stash({ lane: EVOLUTION_LANE_FIBER });
          await this.orch.settleEvolution();
          await this.orch.runDueSessionEvolution();
        });
      } catch (cause) {
        diagnostics.failure('evolution.settle_failed', toKinuError({
          doing: 'settling the turn and session evolution lanes',
          cause,
          otherwise: 'unavailable',
        }));
      } finally {
        if (this._evolutionSettling === owner) this._evolutionSettling = null;
      }
    })();
  }

  /**
   * Warm this user's MCP connections for the next turn, detached on a durable fiber, via
   * `userMcp_warmConnections`. Covers alarm/email/post-eviction turns the HTTP warmup misses.
   * Failures are dropped; the next settled turn retries.
   */
  protected _mcpWarmTask: AsyncTaskOwner | null = null;

  protected warmUserMcpInBackground(): void {
    if (!this.getOwnerUserId() || this._mcpWarmTask !== null) return;
    const owner: AsyncTaskOwner = { promise: null };
    this._mcpWarmTask = owner;
    owner.promise = (async () => {
      try {
        await this.runFiber(MCP_WARM_LANE_FIBER, async (ctx) => {
          ctx.stash({ lane: MCP_WARM_LANE_FIBER });

          // Same gate as `buildUserMcpTools`: no capability token yet is an ordinary state, not a failure.
          // Checked rather than caught so real read failures still propagate.
          if (!this.workspaceCapabilityToken()) return;
          const { stub, caller } = await this.userHub();
          await stub.userMcp_warmConnections(caller);
        });
      } catch (cause) {
        diagnostics.failure('mcp.settle_warmup_failed', toKinuError({
          doing: 'establishing the user MCP connections after a settled turn',
          cause,
          otherwise: 'unavailable',
        }));
      } finally {
        if (this._mcpWarmTask === owner) this._mcpWarmTask = null;
      }
    })();
  }

  /** The advisor's input, recorded while the turn is in memory so a cold re-drive reviews the same
   *  tool surface. `reachable` is the turn's own ToolSet keys as reported at the settle. */
  protected advisorSnapshotFor(turn: CompletedTurn, reachable: readonly string[]): AdvisorRecoverySnapshot {
    return {
      turn,
      reachable: [...reachable],
      minSeverity: this.config.getAdvisorMinSeverity(),
      recent: [...this.engine.recentAdvisorNotes()],
    };
  }

  /**
   * Shared body for the live lane and its recovery, so both review against the snapshot.
   * The model, signal seam, and note store are re-resolved by whoever runs it.
   */
  private async runAdvisorReview(snapshot: AdvisorRecoverySnapshot): Promise<AdvisorDisposition | null> {
    return reviewRecordedTurn({
      snapshot,
      llm: this.rt.advisorLlm,
      guidance: await advisorWorkspaceGuidance({
        vfs: this.rt.agentStateVfs ?? this.rt.storage.vfs,
        limits: async () => this.modelCatalog.contextFor((await this.modelForSource('advisor')).spec),
      }),
      govern: (llm, labels) => this.budget.govern(llm, labels),
      gateOpen: false,
      send: (signal) => this.orch.inbox.send(signal),
      record: (note, turnId) => { this.engine.recordAdvisorNote(note, turnId); },
    });
  }

  /**
   * This actor's ports and models for core's scaffold control plane (evolution/control.ts).
   * On the substrate because the shadow trial queue fills for every actor, facets included.
   */
  protected get scaffoldControl(): ScaffoldControl {
    return {
      rt: this.rt,
      events: this.eventRecorder,
      sql: this.boundSql,
      history: this.stores.history,
      config: this.config,
      surface: (task, context, callScope) => createScaffoldCandidateSurface({
        ...this.scaffoldCandidateModel(),
        tools: () => this.getRawToolsForWorkMode(this.turnWorkMode(), callScope),
        callScope,
        history: this.makeScaffoldHistory(),
        spend: this.scaffoldSpend(),
      }, task, context),
      // `scaffold` is a fixed tier in MODEL_ROUTE_POLICY, not the turn's model.
      model: async () => (await this.modelForSource('scaffold')).model,
      judge: createJsonJudge(() => this.getModelForReview()),
      // Attribution sinks for the plane, including the reflection LM.
      reportModelCall: (report) => this.reportModelCall(report),
      operations: this.modelOperations,
    };
  }

  /** On the substrate like `scaffoldControl`: facets accrue evolution debt too. */
  protected get refinementDeps(): RefinementDeps {
    return {
      control: this.scaffoldControl,
      facts: this.facts,
      refiner: this.temporaryAgentPort(),
      approvals: this.instructionApprovals(),
    };
  }

  private scaffoldCandidateModel(): Pick<ScaffoldCandidateBinding, 'rt' | 'profile' | 'bindModel' | 'modelContext'> {
    return {
      rt: this.rt,
      profile: async () => {
        const mode = await this.preparedWorkMode();

        return this.routingProfile([...Object.keys(this.getRawToolsForWorkMode(mode)), ...codemodeCapabilitiesFor(this.turnCodemodeProviders('build'))], mode);
      },
      bindModel: spec => this.ownedModelServices.resolveModel(spec),
      modelContext: spec => this.modelCatalog.contextFor(spec),
    };
  }

  /** No step cap: the scaffold runs as long as the live turn it may replace (owner ruling,
   * 2026-08-21). Tool names resolve against the raw surface per call. */
  protected makeScaffoldLLMStream(signal?: AbortSignal): ScaffoldRunOptions['llmStream'] {
    return createScaffoldCandidateSurface({
      ...this.scaffoldCandidateModel(),
      tools: () => this.getRawTools(),
      history: undefined,
      signal,
      spend: this.scaffoldSpend(),
    }, '').llmStream;
  }

  /**
   * `callScope` gives stable call ids and claim turn identity so a re-driven trial matches
   * prior tool-effect claims; this narrows duplicates only as far as the rollout is deterministic.
   */
  protected makeScaffoldCallTool(callScope?: string, signal?: AbortSignal): NonNullable<ScaffoldRunOptions['callTool']> {
    let prepared: Promise<NonNullable<ScaffoldRunOptions['callTool']>> | undefined;

    return async (name, args) => {
      prepared ??= this.preparedWorkMode().then((mode) => {
        const tools = this.getRawToolsForWorkMode(mode, callScope);

        return createScaffoldCallTool(() => tools, callScope, signal);
      });

      return (await prepared)(name, args);
    };
  }

  /** Read per call: a scaffold spanning a turn sees the prepared messages as they stand now. */
  protected makeScaffoldHistory(): NonNullable<ScaffoldRunOptions['history']> {
    return createScaffoldHistory(async () => (await this.stores.history.materialize()).messages);
  }

  // Platform fan-out and wake ownership around core's serialized chat loop.
  private _host: BackendHost | null = null;
  private readonly _drainTimerTasks = new Map<string, AsyncTaskOwner>();
  protected get host(): BackendHost {
    if (!this._host) {
      const armWake = this.durableWakeOwner();
      this._host = {
        broadcast: (event) => this.broadcast(JSON.stringify(event)),
        enqueueTurn: (input) => this.chatLoop.enqueueTurn(input),
        // Synchronous read plus same-tick buffer push means the observed turn's prepareStep drains
        // the signal; a turn that settles first re-delivers it from settle().
        turnInFlight: () => this.chatLoop.turnInFlight(),
        // keepAliveWhile holds the DO through the debounce window and drain; if it dies anyway,
        // events stay durable in the EventLog and a later drain picks them up.
        setTimer: (fn, ms) => {
          const timerKey = nanoid();
          const owner: AsyncTaskOwner = { promise: null };
          this._drainTimerTasks.set(timerKey, owner);
          owner.promise = (async () => {
            try {
              await this.keepAliveWhile(async () => {
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, ms);
                });

                try {
                  await fn();
                } catch (cause) {
                  diagnostics.failure('drain.timer_callback_failed', toKinuError({
                    doing: 'running the debounced event drain',
                    cause,
                    otherwise: 'io',
                  }));
                }
              });
            } catch (cause) {
              diagnostics.failure('drain.timer_keepalive_failed', toKinuError({
                doing: 'holding the actor alive across the drain debounce window',
                cause,
                otherwise: 'io',
              }));
            } finally {
              if (this._drainTimerTasks.get(timerKey) === owner) {
                this._drainTimerTasks.delete(timerKey);
              }
            }
          })();
        },
      };

      // Assigned rather than spread so an actor with no wake chain leaves the key absent: core reads
      // the seam's presence as a claim the host can deliver an unwatched wake.
      if (armWake) this._host.reconcileDurableWake = armWake;
    }

    return this._host;
  }

  /** Null when this actor's next wake is somebody else's event; only a root owning a Kinu timer
   *  chain answers. See `BackendHost.reconcileDurableWake`, `OrchestratorAgent.armDurableWake`. */
  protected durableWakeOwner(): (() => void) | null {
    return null;
  }
  /** Debounces the last-active-executor write to one SQL upsert per executor per turn. */
  protected _executorsUsedThisTurn = new Set<string>();
  protected _cachedTools: ToolSet | null = null;
  protected _cachedToolsKey = "";
  // Cached against the content hash of UserDO's MCP descriptor surface, so closures rebuild
  // exactly when the durable rows differ from what this activation last served.
  private _mcpToolsCache: McpToolSurfaceCache<ToolSet> | null = null;
  /** Rendered into the turn's dynamic context so missing MCP servers are legible. */
  private _mcpUnavailable: MissingCapability[] = [];

  private get mcpToolsCache(): McpToolSurfaceCache<ToolSet> {
    this._mcpToolsCache ??= new McpToolSurfaceCache<ToolSet>(async (descriptors) =>
      // `buildMcpToolSet` puts every non-readOnly tool behind the same durable claim as natives,
      // using ambient turn deps because this cache is shared across turns (KINU-019).
      buildMcpToolSet(descriptors, {
        call: async (d, args) => {
          const rawResult = await this.requireOwnerUserDO()
            .userMcp_callTool(await this.userCaller(), d.serverId, d.name, args);

          const response = v.parse(JsonValueSchema, JSON.parse(rawResult));

          if (v.is(McpProtocolFailureSchema, response)) throw new McpToolError(response);

          return response;
        },
        effectClaims: {
          actor: this.actorHandle(),
          sql: this.rt.storage.sql,
          turnId: () => currentOperationProfile(this.actorHandle())?.turnId ?? this._chatLoop?.currentTurnId ?? WORKSPACE_RUN_ID,
        },
        clamp: {
          vfs: this.rt.storage.vfs, budget: this.acc.context, producer: 'external_tool',
        },
      }));

    return this._mcpToolsCache;
  }

  // The eval sandbox reads craftStore.list() on every execute, so saved tools appear without
  // cache coherence work.
  private readonly _codemodeFactories = new Map<string, CodemodeFactory>();

  /** Lazy: `boundSql` is not touched until a store is first read, so this can be built here
   *  rather than in the constructor body. */
  protected readonly stores = createAgentStores(
    () => this.boundSql, () => this.actorHandle(), write => this.ctx.storage.transactionSync(write),
    async () => ({
      vfs: nimbusSessionFiles(this.workspaceBox(this.shellId()), CRED_SESSION_USER),
      artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)),
    }),
  );

  private _liveHeadJournal: LiveHeadJournal | null = null;

  /** Announcing wrapper over the head store, shared by every head-journal write and getHeadRuns;
   *  core's swarm runner has no progress seam, so liveness hangs here. */
  protected get headJournal(): HeadJournal {
    return (this._liveHeadJournal ??= new LiveHeadJournal(
      this.boundSql,
      this.actorHandle(),
      (headId: HeadId) => this.announceHeadActivity(headId),
    ));
  }

  /** Called by {@link LiveHeadJournal} only after its write returns; throws never reach core.
   *  Protected because hosted actors announce through the workspace's socket too. */
  protected announceHeadActivity(headId: string): void {
    this.broadcast(JSON.stringify({ type: 'head_activity', headId }));
    const rootId = this.headJournal.readHead(headId)?.root_id ?? headId;

    if (!isSteerBranchRunId(rootId)) this.broadcastMctsProgress(rootId, 'head-activity');
  }

  /** Broadcast only, no state: a missed frame is corrected by the `head_activity` sent when its
   *  step lands. */
  protected publishHeadStreamFrame(frame: HeadStreamFrame): void {
    this.broadcast(JSON.stringify({ type: 'head_stream', ...frame }));
  }

  protected get eventRecorder(): RunEventRecorder {
    return this.stores.eventRecorder;
  }

  /** Fleet row read at `run_end` (emitted synchronously while the accumulator holds turn numbers);
   *  only for runs the loop ran, not reconcile seals from `closeUnterminatedRuns`. */
  private _fleetRowsObserved = false;
  protected observeFleetRows(): void {
    if (this._fleetRowsObserved) return;
    this._fleetRowsObserved = true;
    this.eventRecorder.observe((event) => {
      if (event.type !== 'run_end') return;

      if (event.runId !== this._chatLoop?.currentRunId) return;
      let outcome: 'ok' | 'refused' | 'failed' = 'ok';

      if (event.reason !== 'completed') outcome = event.error === undefined ? 'refused' : 'failed';

      recordTurnRow(this.env, {
        workspace: this.workspaceName(),
        agentKind: this.actorKind(),
        ...this.analyticsModel(),
        outcome,
        code: '',
        durationMs: this.acc.startedAt > 0 ? Date.now() - this.acc.startedAt : 0,
        steps: this.acc.stepCount,
        toolCalls: this.acc.toolCalls.length,
        usage: this.acc.usage,
        usd: this.priceAt(this.acc.usage),
      });
    });
  }

  /** Undefined for hosted actors: they have neither the workspace wake chain nor the conversation
   *  whose prefix a refresh keeps alive. */
  protected cacheWarmingLane(): CacheWarmingLane | undefined {
    return undefined;
  }

  private _claimsObserved = false;

  /** Protected because a subclass settles and recovers claims it did not admit. The one way this object reaches
   *  its claims, so every change it makes to them reaches {@link turnClaimChanged}. */
  protected get claims(): ActorClaimStore {
    const claims = this.stores.claims;

    if (!this._claimsObserved) {
      this._claimsObserved = true;
      claims.observe(() => { this.turnClaimChanged(); });
    }

    return claims;
  }

  /**
   * Record one non-turn model call (judges, fast tier, evolution, compaction, AI bindings) as a
   * `model_call` row; filed under the current run or the workspace id. Row shape and pricing guard
   * live in core's `buildModelCallEvent`.
   */
  protected reportModelCall(report: ModelCallReport): void {
    const event = buildModelCallEvent(report, {
      effectiveSpec: this.effectiveModelSpec(),
      pricing: this.modelCatalog.pricing(),
    });

    try {
      this.eventRecorder.emit(currentOperationProfile(this.actorHandle())?.runId ?? (this._currentRunId || WORKSPACE_RUN_ID), event);
    } catch (err) {
      diagnostics.failure('event.model_call_emit_failed', toKinuError({
        doing: 'recording a model_call run event',
        cause: err,
        otherwise: 'io',
      }), { source: report.source });
    }

    // `spec` is absent on seams that never had one; the actor's effective model stands in so the
    // row stays countable against the provider it reached.
    const dimensions = report.spec === undefined
      ? this.analyticsModel()
      : this.analyticsModelOf(report.spec);

    recordModelRow(this.env, {
      workspace: this.workspaceName(),
      agentKind: this.actorKind(),
      provider: dimensions.provider,
      model: report.modelId ?? dimensions.model,
      source: report.source,
      usage: report.usage,
      // Reuse the durable row's number; re-deriving it can disagree with the ledger if the catalog
      // resolves a rate between the two reads.
      usd: event.usd,
    });
  }

  /**
   * Records direct model operations' start and end via core's shared mapper.
   * A start row with no end means the platform destroyed the frame mid-call.
   */
  protected readonly modelOperations: ModelOperationSink = recordModelOperations(
    // Resolve the recorder per emit: field initializers run in the DO constructor, and the store
    // bundle needs the actor directory that exists only after `onStart`.
    { emit: (runId, input) => { this.eventRecorder.emit(runId, input); } },
    () => currentOperationProfile(this.actorHandle())?.runId ?? (this._currentRunId || WORKSPACE_RUN_ID),
  );

  /** Records a provider-mandated wait to the ledger (`provider_wait`) and the workspace socket.
   *  Recorder faults are contained so a ledger write never kills the sleep. */
  private noteProviderWait(info: ProviderWaitInfo): void {
    const runId = currentOperationProfile(this.actorHandle())?.runId ?? (this._currentRunId || WORKSPACE_RUN_ID);

    try {
      this.eventRecorder.emit(runId, {
        type: 'provider_wait',
        provider: info.provider,
        waitMs: info.waitMs,
        attempt: info.attempt,
        source: info.source,
        ...(info.modelId !== undefined && { modelId: info.modelId }),
        ...(info.status !== undefined && { status: info.status }),
      });
    } catch (cause) {
      diagnostics.failure('event.provider_wait_emit_failed', toKinuError({
        doing: 'recording a provider_wait run event',
        cause,
        otherwise: 'io',
      }), { provider: info.provider });
    }

    this.broadcast(JSON.stringify({
      type: 'provider_wait',
      actorId: this.actorHandle().actorId,
      provider: info.provider,
      modelId: info.modelId,
      waitMs: info.waitMs,
      attempt: info.attempt,
      source: info.source,
      status: info.status,
    }));
  }

  // EventsHub primitives. Spec: docs/ARCHITECTURE.md — "Events and ingress"
  private _eventLog: EventLog | null = null;
  protected get eventLog(): EventLog {
    this._eventLog ??= new EventLog(this.ctx.storage.sql, this.actorHandle());

    return this._eventLog;
  }
  protected get facts(): FactsStore {
    return this.stores.facts;
  }

  // Work auto-detached past the 30s threshold (#173).
  protected get jobs(): BackgroundJobStore {
    return this.stores.jobs;
  }

  // Written by the `tasks` tool; read for the live context block and the Tasks surface.
  protected get taskList(): TaskListStore {
    return this.stores.taskList;
  }

  /** Precondition of running a turn; never await from `onStart()` (inside blockConcurrencyWhile,
   *  reset at 30s per `do.block_concurrency.cancel_ms`). Owner-gated and latched per activation. */
  protected _scaffoldReady = false;
  protected async ensureOwnedScaffold(): Promise<void> {
    if (this._scaffoldReady || !this.getOwnerUserId()) return;

    if (!(await this.rt.identity.scaffold.exists())) {
      await bootstrapScaffold(this.rt);
      diagnostics.event('scaffold.bootstrapped', { workspace: this.workspaceName() });
    }

    this._scaffoldReady = true;
  }

  // Resume record for an evicted `action:'swarm'` search (B6); keyed by search root id.
  protected get mctsSearchStore(): MctsSearchStore {
    return this.stores.mctsSearchStore;
  }

  /**
   * Push one search's tree (search_nodes plus head journal), scoped by `rootId` since searches run
   * concurrently. `(isolateGen, pushSeq)` orders a root's frames across isolates.
   */
  broadcastMctsProgress(rootId: string, phase: string, iteration?: number, budget?: number): void {
    try {
      const nodes = readSearchTree(this.boundSql, this.actorHandle(), rootId);
      const head = this.headJournal.readRun(rootId);

      if (nodes.length === 0 && head === null) return;
      const fingerprint = JSON.stringify([nodes, head]);

      if (fingerprint === this._lastMctsFingerprint.get(rootId)) return;
      this._lastMctsFingerprint.set(rootId, fingerprint);
      const pushSeq = (this._mctsPushSeq.get(rootId) ?? 0) + 1;
      this._mctsPushSeq.set(rootId, pushSeq);
      this.broadcast(JSON.stringify({
        type: 'mcts-progress', rootId, isolateGen: this.isolateGeneration, pushSeq, phase, iteration, budget,
        nodeCount: nodes.length, nodes, head,
      }));
    } catch (err) {
      diagnostics.failure('mcts.progress_broadcast_failed', toKinuError({
        doing: 'pushing an MCTS search tree to connected surfaces',
        cause: err,
        otherwise: 'io',
      }), { rootId, phase });
    }
  }

  /** Per activation: a reconnecting client is served by the surface's poll, not a resend. */
  private readonly _lastMctsFingerprint = new Map<string, string>();

  private readonly _mctsPushSeq = new Map<string, number>();

  protected onMctsProgress(event: MCTSProgressEvent): void {
    const phase = event.type === 'phase' ? event.phase : event.type;
    const budget = event.type === 'branch-failed' ? undefined : event.remainingBudget;
    this.broadcastMctsProgress(event.rootId, phase, event.iteration, budget);
  }
  // Background-job lifecycle (detach, settle, wake, cancel, evict-recovery) over the durable fiber
  // and the programmatic-turn wake. Owns the cancel-controller map.
  private _jobRunner: BackgroundJobRunner | null = null;
  protected get jobRunner(): BackgroundJobRunner {
    this._jobRunner ??= new BackgroundJobRunner({
      store: this.jobs,
      // Foreground half depends on the surface (30s for chat). Wake half never varies: DO alarms deliver
      // wakes with nobody connected, so spawn-shaped work detaches on unwatched turns too.
      policy: () => invocationBackgroundPolicy(this.turnSurface(), true),
      fiber: (name, fn) => this.rt.schedule.fiber(name, fn),
      inbox: this.orch.inbox,
      eventLog: this.eventLog,
      scheduleDrain: () => this.orch.scheduleDrain(),
      logActivity: (event, detail) => this.logActivity(event, detail),
      // Transfer by request id, never by turn: only the detaching call's device work changes hands,
      // so parallel foreground commands stay reachable by Stop.
      onDetached: (jobId, requestIds) => this.transferDeviceRequests(jobId, requestIds),
      // Throws when the device cannot confirm the cancel; runner calls this before any state change,
      // so a refused cancel leaves the job running and retryable.
      onCancelled: (jobId) => this.cancelBackgroundDeviceRequests(jobId),
      // Notify the owner (email on the orchestrator; skips silently when pieces are absent).
      onSettled: (job) => {
        const notice = backgroundJobNotice(job);
        this.notifyOwner(notice.subject, notice.body);
      },
      // Evict-resume (B6): re-drive from the durable checkpoint. Side-effecting kinds (eval / run)
      // decline and fall back to the eviction failure.
      resume: (kind, input, mode, signal) => this.resumeBackgroundJob(kind, input, mode, signal),
      // Same predicate as `resume`: a kind that cannot be re-driven has no harvestable partial.
      harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
        { sql: this.boundSql, actor: this.actorHandle(), ledger: this.mctsSearchStore }, kind, input,
      )),
      // Arms the actor's single terminal-retry row (soonest-wins); its tick re-enters the job sweep,
      // since the fork reconcile runs at most once per activation and a deferred job outlives that.
      scheduleResume: async (atMs) => { await this.scheduleTerminalRetry(atMs); },
    });

    return this._jobRunner;
  }

  /**
   * Throws on any `transferred: false` (possibly after a partial transfer); the job keeps ownership
   * and is not aborted, cancelled, or released.
   */
  private async transferDeviceRequests(
    jobId: string, requestIds: readonly string[],
  ): Promise<void> {
    if (requestIds.length === 0) return;
    const { stub, caller } = await this.userHub();

    for (const requestId of requestIds) {
      const { transferred } = await stub.transferDeviceRequestToBackgroundJob(caller, requestId, jobId);

      if (!transferred) {
        throw new KinuError(
          'unavailable',
          `device request ${requestId} could not be handed to background job ${jobId}`,
        );
      }
    }
  }

  /**
   * `terminated` and `unknown` count as settled; any `failed` (command may still run) throws,
   * keeping the job `running` so the cancel can be retried.
   */
  private async cancelBackgroundDeviceRequests(jobId: string): Promise<void> {
    const { stub, caller } = await this.userHub();
    const outcomes = await stub.cancelDeviceRequestsForBackgroundJob(caller, jobId);
    const unconfirmed = outcomes.filter((outcome) => outcome.outcome === 'failed');

    if (unconfirmed.length === 0) return;
    throw new KinuError('unavailable', `background job ${jobId} still holds ${unconfirmed.length} `
      + `device command(s) nothing confirmed stopped: `
      + unconfirmed.map((o) => `${o.requestId} (${o.detail ?? 'no detail'})`).join('; '));
  }

  /**
   * Is there work in this actor's SUBTREE that may still touch the container?
   *
   * Asked by the sandbox's own Durable Object before it does anything a live
   * user of the container would notice. It is a question about safety, so it is
   * answered conservatively in one direction only: a wrong `true` costs a warm
   * container, a wrong `false` pulls the filesystem out from under running work.
   * Every source below is therefore admitted on "may use", never on "will use" —
   * a `shell` and an `eval` reach the container directly, and every other
   * kind of work can call one.
   *
   * Four durable sources plus one in-memory one, and each answers a question
   * the others cannot:
   *   • detached tool calls  — `background_jobs` rows still `running`, which is
   *     the only record of work whose executor may be in another activation;
   *   • admitted work       — open turns, pending sends and hosted claims the
   *     workspace's durable wake must finish, even with no connected client;
   *   • managed fibers       — anything durably accepted through the fiber
   *     ledger and not yet settled, `interrupted` included: an interrupted row
   *     is work a recovery is about to re-drive, not work that has stopped;
   *   • the live turn        — in memory by nature, and the single most likely
   *     caller of a container tool.
   *
   * No subtree walk: every hosted actor shares this workspace's container, and
   * `countRunningInWorkspace()` is workspace-wide by contract. Asking that
   * global question once per child would return the same answer N times, not N
   * answers.
   */
  async hasSandboxBackgroundWork(): Promise<boolean> {
    if (this._inFlight) return true;

    if (this.jobs.countRunningInWorkspace() > 0) return true;

    if (this.owedUntimedWork()) return true;
    const fibers = await this.listFibers({ status: ['pending', 'running', 'interrupted'] });

    if (fibers.length > 0) return true;

    return false;
  }
  /** Controllers for foreground long tools; once detached, BackgroundJobRunner owns cancellation. */
  protected readonly _activeToolControllers = new Set<AbortController>();

  protected get config(): AgentConfigStore {
    return this.stores.config;
  }

  /** Same shared swarm-deps factory the CLI wires; rebuilt with the toolset (getRawTools). */
  private getAgentsToolDeps(workMode: WorkMode): AgentsToolDeps {
    const actorDeps = this.actorToolDeps();
    // Seat factory is asked per node: node deps are shallow-copied per child, so one shared actor
    // would give a whole wave one claim ledger and loop pointer.
    const seams = this.explorationSeams();

    // The one production construction site of `AgentsSwarmDeps` on this backend; the CLI's
    // `buildAgentsSwarmDeps` is its twin.
    const swarm: AgentsSwarmDeps = {
      rt: this.rt,
      model: this.getModel(),
      reportModelCall: (report) => { this.reportModelCall(report); },
      nodeCodemode: (actor) => nodeCodemodeTool(seams, actor),
      webSearch: seams.webSearch(),
      originContext: () => this._turnOriginContext,
      resolveModel: (spec: string) => this.ownedModelServices.resolveModel(spec),
      // Same catalog session as the context window and mission ledger, so a search's estimate
      // and the ledger debit read one rate.
      costModel: () => ({
        spec: this.effectiveModelSpec(),
        pricing: this.modelCatalog.pricing(),
      }),
      // Resolved per node when the wave reaches it, not captured with the deps.
      hostNode: (node) => hostNodeSeat(seams, node),
      /**
       * Reports the node's private home so its isolation disclosure is true (absent, nodes are told
       * `shared-origin-plane`). The seat call is idempotent and keys the home on the actor's storage key.
       */
      provisionNodeHome: () => async (node) => seams.nodeHome((await hostNodeSeat(seams, node)).actor),
      runtimeForNodeWorkspace: null,
      // In-isolate nodes publish directly; hosted nodes publish over their own RPC and leave this unread.
      reportNodeDelta: () => (frame) => { this.publishHeadStreamFrame(frame); },
      // Durable half of liveness, on the same listener `headJournal` announces through, so every
      // writer of a search's journal announces to open surfaces.
      announceHeadActivity: () => (headId) => { this.announceHeadActivity(headId); },
      compactShared: createSharedPrefixCompactor({
        ports: {
          transcripts: createVfsTranscriptStore(() => this.rt.storage.vfs),
          plans: this.compactionState.plans,
          logger: this.compactionLogger,
        },
        archive: this.compactionState.archive,
        summarize: createModelSummarizer(() => this.getModel(), {
          source: 'compaction', report: (report) => this.reportModelCall(report),
          operations: this.modelOperations,
        }),
        // Explicitly the light preset, matching every other production compaction path.
        profile: COMPACTION_PRESETS.light,
      }),
    };

    const deps: AgentsToolDeps = {
      mode: workMode,
      swarm,
      budget: this.budget,
    };

    deps.profile = () => {
      const operation = this.operationProfile();

      return agentsProfileContext(operation?.profile ?? null, operation?.inputs ?? null);
    };

    if (actorDeps.team) deps.team = actorDeps.team;

    if (actorDeps.peers) deps.peers = actorDeps.peers;

    return deps;
  }

  /** The loop's current run id; empty between turns and before the loop exists, so such emits
   *  file under the workspace aggregate. */
  protected get _currentRunId(): string {
    return this._chatLoop?.currentRunId ?? '';
  }

  /** Resolved once for the active turn; immutable. */
  private _turnOperation: OperationProfile | null = null;

  private operationProfile(): OperationProfile | null {
    return currentOperationProfile(this.actorHandle()) ?? (this._inFlight ? this._turnOperation : null);
  }
  /** Built in beforeTurn; read by the per-step dynamic context and the turn-local tail. */
  private _turnActiveSkills: ActiveSkillSet | null = null;
  /** Instruction trust (KINU-N028): one store over actor SQL, scoped to this workspace so a forked
   *  or copied root starts unapproved. */
  private _instructionApprovals: InstructionApprovalStore | null = null;
  protected _workspaceInstructionApprovals: readonly InstructionApproval[] | null = null;
  private instructionApprovals(): InstructionApprovalStore {
    this._instructionApprovals ??= new InstructionApprovalStore(
      this.rt.storage.sql,
      this.actorHandle(),
      `cf:${this.workspaceName()}`,
    );

    return this._instructionApprovals;
  }

  /** A facet replaces this with the root authority snapshot. */
  private _instructionTrust: InstructionTrustResolver | null = null;
  protected instructionTrust(): InstructionTrustResolver {
    const approvals = this._workspaceInstructionApprovals;

    if (approvals !== null) {
      return (path, content) => trustOfInstructionApprovals(approvals, path, content);
    }

    const store = this.instructionApprovals();
    this._instructionTrust ??= store.trustOf.bind(store);

    return this._instructionTrust;
  }

  /** The workspace root's authoritative approval rows. Facets fetch this before each turn and
   * never consult their private SQL for shared files. */
  @callable()
  async getWorkspaceInstructionApprovals(): Promise<readonly InstructionApproval[]> {
    this._workspaceInstructionApprovals = null;

    return this.instructionApprovals().list();
  }

  private _instructionDesk: InstructionApprovalDesk | null = null;
  private instructionDesk(): InstructionApprovalDesk {
    this._instructionDesk ??= new InstructionApprovalDesk({
      agentsMd: (window, trust) =>
        collectWorkspaceAgentsMd(this.rt.storage.vfs, window, trust, this.rt.executionRouter?.getProvider('sandbox')),
      skillsVfs: this.rt.storage.vfs,
      approvals: this.instructionApprovals(),
      window: () => this.modelCatalog.window(),
    });

    return this._instructionDesk;
  }

  /** Derived on read, never stored, so the agent cannot fill the queue by writing files. */
  @callable()
  async listInstructionApprovals(request: PageRequest = {}): Promise<Page<InstructionSourceRow>> {
    this._workspaceInstructionApprovals = null;

    return this.instructionDesk().list(request);
  }

  @callable()
  async readInstructionApproval(path: string): Promise<InstructionSourceView | null> {
    this._workspaceInstructionApprovals = null;

    return this.instructionDesk().read(path);
  }

  /** Grants these bytes at this path system placement; the digest is re-checked against the file. */
  @callable()
  async approveInstruction(path: string, reviewedDigest: string): Promise<AdmittedInstructionDecision> {
    this._workspaceInstructionApprovals = null;

    return this.instructionDesk().approve(path, reviewedDigest);
  }

  /** The refusal is kept, so nothing can re-grant it without the owner deciding again. */
  @callable()
  async revokeInstruction(path: string): Promise<AdmittedInstructionDecision> {
    this._workspaceInstructionApprovals = null;

    return this.instructionDesk().revoke(path);
  }

  private _turnT0 = 0;

  /** A turn is running, read live from the loop; routes signals into the turn, keeps tool claims,
   * and reports the actor busy (forkAgent rejects with "agent busy"). */
  protected get _inFlight(): boolean { return this._chatLoop?.pumping === true && this._chatLoop.currentTurnId !== null; }
  /** Whether this turn records evolution state, captured at turn open; `engine.enabled` is a live
   * read that a mid-turn toggle or a recovering host could answer differently. */
  protected _turnEvolutionEnabled = false;
  /** Core's derivation of the gate (`AgentOrchestrator.beginTurn`); the harness needs it for suites
   * that drive `onChatResponse` with no turn to open. */
  protected turnRecordsEvolution(): boolean {
    return this.engine.enabled && this.turnWorkMode() !== 'plan';
  }

  protected readonly extensions = new ExtensionHost();

  protected _cliCwd: string | null = null;
  /** Whether the current turn is a conversational reply or a one-shot task (`kinu exec`); read at
   * turn end to decide if it may be parked awaiting a follow-up verdict. */
  protected _turnContinuity: TurnContinuity = 'conversation';

  // Captured for shadow evaluation; ChatSession serializes turns, a cold activation reconstructs it.
  private _turnProgram: { readonly program: ActorTurnProgram; readonly signal: AbortSignal | undefined } | null = null;
  /** Read per call, never captured: long-lived collaborators (the release engine) must see the
   * current turn's cancellation. */
  protected currentTurnSignal(): AbortSignal | undefined {
    return this._turnProgram?.signal;
  }

  getCliCwdForDevice(): string | null {
    return this._cliCwd;
  }

  getCheckpointMetaForDevice(): { turnId: string; sessionId: string } | null {
    // The loop's live turn: the id a Stop sweep names and the daemon's checkpoint key.
    const turnId = this._chatLoop?.currentTurnId;

    return turnId === undefined || turnId === null ? null : { turnId, sessionId: 'default' };
  }

  // `this.sql` needs `this` bound; this closure can be passed by reference to helpers safely.
  private _boundSql: SqlExecutor | null = null;
  protected get boundSql(): SqlExecutor {
    this._boundSql ??= bindAgentSql(this);

    return this._boundSql;
  }

  private _chatTranscript: SessionTranscript | null = null;
  protected get chatTranscript(): SessionTranscript {
    return this._chatTranscript ??= this.stores.history.transcript(CHAT_SESSION_ID);
  }

  /** Persisted once per activation; tracing and MCTS frames share it so neither advances the other. */
  private _isolateGeneration: number | null = null;
  protected get isolateGeneration(): number {
    return (this._isolateGeneration ??= this.config.countIsolateGeneration());
  }
  private _tracing: AgentTracing | null = null;
  /**
   * Lazy so `isolateGen` bumps once per construction, incl. `ctx.facets.abort()`; not in `onStart`,
   * which blocks all requests and resets after 30s (`do.block_concurrency.cancel_ms`).
   * Keyed by `selfPath`, not `ctx.id`: facets report the root's id (`do.facet.id_is_root_namespace`).
   */
  protected get tracing(): AgentTracing {
    this._tracing ??= createAgentTracing({
      tracer: createWorkersTracer(),
      isolateGen: this.isolateGeneration,
      selfPath: this.selfPath,
    });

    return this._tracing;
  }

  protected logActivity(event: string, detail?: string) {
    const elapsed = this._turnT0 > 0 ? Math.round(performance.now() - this._turnT0) : 0;

    writeActivityLog(() => ({ sql: this.boundSql, actor: this.actorHandle() }), {
      event, detail: detail ?? null, elapsedMs: elapsed, createdAt: Date.now(),
    });
  }

  /**
   * Spec is already resolved by `hostBranch`; do not re-resolve. The operation frame opens before
   * the request and fails closed; spend is not reported here (engine bills from returned `usage`).
   */
  private branchRunnerDeps(): BranchRunnerDeps {
    return {
      explorePrompt,
      reflectionPrompt,
      complete: async ({ spec, effort, system, user }) => {
        // Use the route's effort, resolved with the spec; not `REASONING_EFFORT_FOR_STAGE`.
        const { model, providerOptions } = this.ownedModelServices.resolveModelWithEffort(spec, effort);

        const request: Parameters<typeof generateText>[0] = {
          model,
          messages: [{ role: 'user' as const, content: user }],
        };

        if (system !== undefined) request.system = system;

        if (providerOptions) request.providerOptions = providerOptions;

        const operation = beginModelOperation(
          { source: 'mcts', operations: this.modelOperations }, 'complete', { spec },
        );

        let answer;

        try {
          answer = await generateText(request);
        } catch (cause) {
          operation.failed({ cause });
          throw cause;
        }

        const usage = normalizeUsage(answer.usage);
        operation.completed({ usage, modelId: spec });

        return { text: answer.text.trim(), usage };
      },
    };
  }

  protected get rt(): CFRuntime {
    if (!this._rt) {
      const hooks: CFRuntimeHooks = {
        deferrals: () => this.deferralChannel(),
        slate: (operation) => this.slate(operation),
        reportModelCall: (report) => this.reportModelCall(report),
        resolveProfile: () => this.routingProfile(),
        contextPlane: {
          actorId: this.actorHandle().actorId,
          claims: () => this.claims,
          events: () => this.stores.eventRecorder,
          children: childContextResolver({
            host: { bindStores: (reference) => this.actorHost().bindStores(reference) },
            directory: this.actorDirectoryStore(),
            parent: this.actorHandle(),
            events: (child) => child.stores.eventRecorder,
          }),
        },
        // Both members or neither: `requireBranches` refuses when the hook is absent.
        branches: {
          spawn: (branchId) => hostBranch(this.explorationSeams(), branchId, this.branchRunnerDeps()),
          abort: (branchId) => abortHostedBranch(this.explorationSeams(), branchId),
        },
      };

      // No `workspaceExecution`: the main actor runs as the session user. Hosted actors get the home
      // assigned (not spread) by the host, because the factory reads the key's presence.
      // No onToolRegistered hook: the eval sandbox reads craftStore.list() fresh each call
      // (see docs/CRAFT-ARCHITECTURE.md §3).
      const runtime = createCFRuntime(this, {
        env: this.env,
        ctx: this.ctx,
        workspaceBox: (shellId) => this.workspaceBox(shellId),
        acc: () => this.acc,
        getCliCwdForDevice: () => this.getCliCwdForDevice(),
        getCheckpointMetaForDevice: () => this.getCheckpointMetaForDevice(),
      }, {
        actor: this.actorHandle(),
        rootActor: true,
        ownerUserId: () => this.getOwnerUserId(),
        workspaceName: this.workspaceName(),
        shellId: this.shellId(),
        scaffoldPath: this.scaffoldPath(),
        capabilityToken: () => this.workspaceCapabilityToken(),
      }, hooks);

      this.configureRuntime(runtime);
      this._rt = runtime;
    }

    return this._rt;
  }

  /** Synchronous post-construction hook. The runtime is not cached until this returns, so use the
   * argument and do not re-enter `this.rt`. */
  protected configureRuntime(_runtime: CFRuntime): void {}

  /**
   * Deferral target for gated commands with no approver; subordinates have no queue, the
   * orchestrator overrides. Resolved at exec time, never during runtime construction (reaching the
   * queue re-enters `rt`).
   */
  protected deferralChannel(): DeferredApprovalChannel | undefined { return undefined; }

  /**
   * The actor a slate acts for; never client-reachable. Hosted actors' callers are minted by the
   * host from the directory row, never from a facet chain's class names.
   */
  protected slateCaller(): SlateCaller {
    return { path: [], cred: CRED_SESSION_USER, workMode: currentWorkMode() };
  }

  /** Every actor's slate operations run on the object that owns its workspace, as this actor. */
  async slate(operation: SlateOperation): Promise<SlateCallResult> {
    return workspaceOwner(this.env, this.workspaceName()).slateAs(this.slateCaller(), operation);
  }

  /**
   * Descend one binding hop; the target answers with its own surface narrowed by its own current
   * role, so a binding never reaches more than the actor holding it.
   */
  private async dispatchHostedSlateBinding(
    name: string, rest: readonly SlateCallerHop[], route: SlateBindingRoute, mode: WorkMode,
  ): Promise<JsonValue> {
    if (rest.length > 0) {
      throw new KinuError('denied', 'A binding path names one hosted actor; a nested path names an actor no directory holds.');
    }

    const entry = this.actorDirectoryStore().apply(
      actorReferenceOf(this.actorHandle()), [], { action: 'resolve', name },
    );

    return await this.actorHost().run(entry.reference, async (actor) => {
      if (route.kind === 'ai') {
        // A hosted actor runs the model call through its own profile, resolved now.
        return await this.slateAiRun(route, actor.handle);
      }

      if (route.kind === 'agent') {
        throw new KinuError('denied', 'a hosted actor has no inbox of its own; the agent binding answers on the workspace actor');
      }

      if (route.kind !== 'namespace' && route.kind !== 'tool' && route.kind !== 'codemode') {
        // Hosted actors hold no MCP servers or slate read model; those belong to the main actor.
        throw new KinuError('denied', `a hosted actor has no ${route.kind} surface; that route belongs to the workspace actor`);
      }

      const surface = hostedActorSurface(actor, this.ownedModelServices.getWebSearchProvider());
      const providers = providersInWorkMode(mode, surface.providers);
      // Narrow by the child's own durable, per-actor role.
      const reach = slateToolReach(await this.hostedSlateReach(actor, providers, Object.keys(surface.native)));

      if (route.kind === 'tool') return this.callSlateTool({ rt: actor.runtime, native: surface.native, providers, reach, route, mode });

      return await callCodemodeMember(reach.narrowProviders(providers), route.namespace, route.member, route.args) ?? null;
    });
  }

  /**
   * One capability route, run as this actor, narrowed by its own current role.
   * Not `@callable`: reached on the stub transport only.
   */
  async slateBindingDispatch(path: readonly SlateCallerHop[], route: SlateBindingRoute, mode: WorkMode): Promise<JsonValue> {
    // Hops resolve hosted actors through the directory, inside this object, so an unreachable
    // name is refused here rather than as a rejected RPC deeper down.
    const [next, ...rest] = path;

    if (next !== undefined) {
      return await this.dispatchHostedSlateBinding(next.name, rest, route, mode);
    }

    switch (route.kind) {
      case 'namespace':
      case 'codemode': {
        const providers = providersInWorkMode(mode, this.slateNamespaces());
        const reach = slateToolReach(await this.slateReach(providers));

        return await callCodemodeMember(reach.narrowProviders(providers), route.namespace, route.member, route.args) ?? null;
      }

      case 'tool': {
        const providers = providersInWorkMode(mode, this.slateNamespaces());
        const reach = slateToolReach(await this.slateReach(providers));

        return this.callSlateTool({ rt: this.rt, native: this.getRawToolsForWorkMode(mode), providers, reach, route, mode });
      }

      case 'mcp': {
        // The role admits MCP tools by descriptor key, same as `toolAllowed(d.toolKey)` in native turns.
        const { stub, caller } = await this.userHub();
        const surface = v.parse(McpToolSurfaceSchema, JSON.parse(await stub.userMcp_toolDescriptors(caller)));
        const descriptor = surface.descriptors.find((d) => d.serverId === route.server && d.name === route.tool);

        if (descriptor === undefined) throw new KinuError('missing', `${route.server} offers no tool ${route.tool} to this actor`);
        // Enforce `readOnly` grants here so a read grant cannot write through a non-read-only tool.

        if (route.readOnly === true && descriptor.readOnly !== true) {
          throw new KinuError('denied', `${descriptor.toolKey} is read-granted to viewers but ${route.server} does not mark it read-only`);
        }

        requireWorkModePermission(mode, descriptor.readOnly === true, descriptor.toolKey);
        const reach = await this.slateReach(this.slateNamespaces(), [descriptor.toolKey]);

        if (!reach.allowsTool(descriptor.toolKey)) throw new KinuError('denied', `${descriptor.toolKey} is not within this actor's reach right now`);

        return v.parse(JsonValueSchema, JSON.parse(await stub.userMcp_callTool(caller, route.server, route.tool, route.args)));
      }

      case 'agent': {
        const metadata: JsonObject = { slate: route.slate };

        if (route.data !== undefined) metadata.data = route.data;

        if (route.viewer !== undefined) metadata.viewer = route.viewer;

        const outcome = await this.slateInbox().send({
          kind: 'slate',
          text: route.viewer === undefined
            ? `Slate ${route.slate}: ${route.text}`
            : `Slate ${route.slate} (viewer ${route.viewer}): ${route.text}`,
          metadata,
        });

        return { outcome };
      }

      case 'ai': return await this.slateAiRun(route);

      case 'rpc': return this.slateReadModel(route.method);
      case 'app': throw new KinuError('bad_input', 'An app hop is answered by the slate host, not by an actor');
    }
  }

  /** The one adapter between a slate's `agent` binding and the turn inbox. */
  private slateInbox(): AgentInbox {
    return this.orch.inbox;
  }

  /**
   * One `ai` binding call: resolve the profile as this actor's turn would, run one `generateText`
   * under a `slate` spend row. `actor` is the hosted actor hopped to, or absent for this actor.
   */
  private async slateAiRun(
    route: Extract<SlateBindingRoute, { kind: 'ai' }>,
    actor?: ActorHandle,
  ): Promise<JsonValue> {
    let profile: ResolvedTurnProfile;

    try {
      if (actor === undefined) {
        profile = resolveAgentTurnProfile({
          ...(await this.profileInputs()),
          activeRoleId: this.activeRoleLabel(),
          workMode: 'build',
          availableTools: [],
          activeSkills: [],
          explicitTier: route.tier ?? this.config.getAssignedTier() ?? undefined,
        });
      } else {
        profile = (await this.hostedActorProfile({
          actor, workMode: 'build', availableTools: [], explicitTier: route.tier,
        })).profile;
      }
    } catch (cause) {
      // The resolver reports bad tiers as plain Errors; surface them as bad input.
      if (cause instanceof Error && /invalid explicit tier|unknown tier/.test(cause.message)) {
        throw new KinuError('bad_input', cause.message, { cause });
      }

      throw cause;
    }

    const spec = profile.tier.model;
    const model = this.ownedModelServices.resolveModel(spec);

    const operation = beginModelOperation(
      { source: 'slate', operations: this.modelOperations }, 'complete', { spec },
    );

    let answer;

    try {
      const input: Parameters<typeof generateText>[0] = { model, prompt: route.prompt };

      if (route.system !== undefined) input.system = route.system;

      answer = await generateText(input);
    } catch (cause) {
      operation.failed({ cause });
      throw cause;
    }

    const usage = normalizeUsage(answer.usage);
    operation.completed({ usage, modelId: spec });

    return v.parse(JsonValueSchema, { text: answer.text, model: spec, tier: profile.tier.id, usage });
  }

  private async callSlateTool(input: {
    rt: HostedActor['runtime']; native: ToolSet; providers: CodemodeProvider[];
    reach: ToolSurfaceNarrowing; route: Extract<SlateBindingRoute, { kind: 'tool' }>; mode: WorkMode;
  }): Promise<JsonValue> {
    const { rt, native, providers, reach, route, mode } = input;
    const executorNames = new Set(rt.executionRouter?.getProviders().map((provider) => provider.name) ?? []);

    const factory = createCodemodeToolFactory({
      loader: this.env.LOADER, egress: codemodeEgress(), rt,
      sql: rt.storage.sql, workspace: this.workspaceName(), webSearch: this.ownedModelServices.getWebSearchProvider(), reach,
      extraProviders: () => providers.filter((provider) => !executorNames.has(provider.name) && provider.name !== 'web'),
    });

    return await inWorkMode(mode, () => factory.callTool(native, route.name, route.input)) ?? null;
  }

  /** Workspace read models belong to the root; the orchestrator supplies them. */
  protected async slateReadModel(source: SlateReadModel): Promise<JsonValue> {
    throw new KinuError('denied', `${source} is a workspace read model this actor does not hold`);
  }

  /**
   * Current tool reach for a binding call: the in-flight turn's profile (not the cached one, which
   * outlives its turn), else the role resolved now over native, codemode, and given MCP tools.
   */
  private async slateReach(providers: readonly CodemodeProvider[], mcpToolKeys: readonly string[] = []): Promise<ToolSurfaceNarrowing> {
    const operation = this.operationProfile();

    if (operation) return narrowToolSurface(operation.profile.allowedTools);

    const profile = resolveAgentTurnProfile({
      ...(await this.profileInputs()),
      activeRoleId: this.activeRoleLabel(),
      workMode: 'build',
      availableTools: [...actorActiveTools(this.actorToolDeps()), ...mcpToolKeys, ...codemodeCapabilitiesFor(providers)],
      activeSkills: [],
      explicitTier: this.config.getAssignedTier() ?? undefined,
    });

    return narrowToolSurface(profile.allowedTools);
  }

  /**
   * Hosted actor's reach: not `slateReach`, which reads the root's turn and surface.
   * Resolves the role now over the child's own surface, so a role change is seen on the next call.
   */
  private async hostedSlateReach(
    actor: HostedActor, providers: readonly CodemodeProvider[], native: readonly string[],
  ): Promise<ToolSurfaceNarrowing> {
    const { profile } = await this.hostedActorProfile({
      actor: actor.handle,
      availableTools: [...native, ...codemodeCapabilitiesFor(providers)],
      workMode: 'build',
    });

    return narrowToolSurface(profile.allowedTools);
  }

  /** Unconditional on every ActorAgent; tasks reuses `this.taskList`, the store the snapshot reads. */
  private baseCodemodeProviders(): CodemodeProvider[] {
    return [
      createMemoryCodemodeProvider(() => ({
        memory: this.rt.memory, vectorStore: this.rt.vectorStore,
        facts: this.facts, sql: this.rt.storage.sql, actor: this.actorHandle(),
        transcriptFor: (sessionId) => this.stores.history.transcript(sessionId),
      })),
      createTasksCodemodeProvider(this.taskList, this.config),
    ];
  }

  /**
   * Single list read by `beforeTurn` (nameable capabilities) and `getCodemodeToolFactory` (narrowing).
   * Plan mode omits `release`.
   */
  /**
   * Providers outside this list cannot be named by a role nor narrowed, so `db` belongs here.
   * The db provider decides Plan per table scope at invocation, so it is not in the Plan filter.
   */
  protected turnCodemodeProviders(mode: WorkMode): CodemodeProvider[] {
    return [...this.baseCodemodeProviders(), createDbCodemodeProvider(this.stores.appData), ...this.extraCodemodeProviders()]
      .filter((provider) => mode !== 'plan' || provider.name !== 'release');
  }

  /**
   * Namespaces a slate binding may reach: the build-turn sandbox surfaces minus `tools`/`state`.
   * Read per call: executors attach and detach while this object lives.
   */
  protected slateNamespaces(): CodemodeProvider[] {
    return [
      ...(this.rt.executionRouter?.getProviders() ?? []),
      createWebCodemodeProvider(this.ownedModelServices.getWebSearchProvider()),
      createAgentsCodemodeProvider(() => this.getAgentsToolDeps('build')),
      ...this.turnCodemodeProviders('build'),
    ];
  }

  /** Built once per DO; crafted tools saved mid-turn still work because craftStore is re-read per call. */
  private getCodemodeToolFactory(mode: WorkMode, profileKey: string): CodemodeFactory {
    // The profile digest is part of the key: two roles can share tool names yet reach
    // different namespaces.
    const profile = this.operationProfile()?.profile;
    const narrowing = narrowToolSurface(profile?.allowedTools);
    const key = `${mode === 'plan' ? 'plan' : 'default'}:${profileKey}:${profile?.digest ?? ''}`;

    if (!this._codemodeFactories.has(key)) {
      this._codemodeFactories.set(key, createCodemodeToolFactory({
        loader: this.env.LOADER,
        egress: codemodeEgress(),
        rt: this.rt,
        reach: narrowing,
        sql: this.boundSql,
        workspace: this.workspaceName(),
        webSearch: this.ownedModelServices.getWebSearchProvider(),
        agents: () => this.getAgentsToolDeps(mode),
        // Read per provider call: a detach can change the owning channel mid-call.
        deviceRequests: () => this._activeDeviceRequests ?? undefined,
        // Narrowed by the same set as the native surface, so the sandbox cannot bypass a role.
        extraProviders: () => narrowing.narrowProviders(this.turnCodemodeProviders(mode)),
        // Drives the UI's default executor; one upsert per executor per turn (reset in beforeTurn).
        onExecutorUsed: (name) => {
          if (this._executorsUsedThisTurn.has(name)) return;
          this._executorsUsedThisTurn.add(name);
          this.config.setLastActiveExecutor(name);
        },
      }));
    }

    const factory = this._codemodeFactories.get(key);

    if (factory === undefined) throw new Error(`eval profile ${key} was not built`);

    return factory;
  }

  /** One object so a cost can never be filed for an operation that was never opened. */
  private scaffoldSpend(): ModelCallSpend {
    return {
      source: 'scaffold',
      report: (report) => this.reportModelCall(report),
      operations: this.modelOperations,
    };
  }

  protected providerRegistry(): AgentProviderRegistry {
    return this.ownedModelServices.providerRegistry();
  }

  protected getOwnerUserDO(): UserHubClient | null {
    const userId = this.getOwnerUserId();

    if (!userId) return null;
    const stub: UserHubClient = this.env.UserDO.get(this.env.UserDO.idFromName(userId));

    return stub;
  }

  protected requireOwnerUserDO(): UserHubClient {
    const stub = this.getOwnerUserDO();

    if (!stub) throw new Error('Agent has no owner yet. Open it through the authenticated app or CLI first.');

    return stub;
  }

  /** Throws when no capability token exists; an unclaimed workspace reaches nothing. */
  protected async userCaller(): Promise<UserCaller> {
    const workspaceToken = this.workspaceCapabilityToken();

    if (!workspaceToken) {
      throw new Error('This workspace has not been issued a capability token yet. Open it through the authenticated app or CLI first.');
    }

    return { workspaceToken };
  }

  protected async userHub(): Promise<{ stub: UserHubClient; caller: UserCaller }> {
    return { stub: this.requireOwnerUserDO(), caller: await this.userCaller() };
  }

  /** `record` lets core emit the `profile_resolution` run event; this backend only picks where it goes. */
  protected async profileInputs(): Promise<ProfileAuthorityInputs> {
    const { stub, caller } = await this.userHub();

    return loadProfileAuthorityInputs({
      envelope: () => stub.getWorkspaceProfileCatalog(caller),
      provider: () => this.ownedModelServices.profileProviderSnapshot(),
      record: (event) => this.eventRecorder.emit(this._currentRunId || WORKSPACE_RUN_ID, event),
    });
  }

  protected resolvedTurnProfile(): ResolvedTurnProfile | null {
    return this.operationProfile()?.profile ?? null;
  }

  /** A fork reaches these through its `parent` executor. No `@callable`: only a worker-held
   * parent stub can reach them. */
  /** Answers one file operation for a fork: the value, or the VFS error code and its path. */
  private async workspaceFileAnswer<T>(path: string, operate: () => Promise<T>): Promise<ParentRpcResult<T>> {
    try {
      return { ok: true, value: await operate() };
    } catch (cause) {
      return {
        ok: false,
        error: { code: isVfsError(cause) ? cause.code : 'EIO', message: renderThrownChain({ cause }), path },
      };
    }
  }

  async readWorkspaceFile(path: string): Promise<ParentRpcResult<Uint8Array>> {
    return this.workspaceFileAnswer(path, async () => {
      const content = await this.rt.localVfs.readFile(path);

      return v.is(v.string(), content) ? new TextEncoder().encode(content) : content;
    });
  }

  async writeWorkspaceFile(input: ParentRpcWrite): Promise<ParentRpcResult<null>> {
    return this.workspaceFileAnswer(input.path, async () => {
      if (input.kind === 'file') await this.rt.localVfs.writeFile(input.path, input.data);
      else await this.rt.localVfs.mkdir(input.path, { recursive: input.recursive });

      return null;
    });
  }

  async listWorkspaceFiles(path: string): Promise<ParentRpcResult<string[]>> {
    return this.workspaceFileAnswer(path, () => this.rt.localVfs.readdir(path));
  }

  async statWorkspaceFile(path: string): Promise<ParentRpcResult<{ size: number; mtimeMs: number; isDir: boolean } | null>> {
    return this.workspaceFileAnswer(path, () => this.rt.localVfs.stat(path));
  }

  async deleteWorkspaceFile(path: string): Promise<ParentRpcResult<null>> {
    return this.workspaceFileAnswer(path, async () => {
      await this.rt.localVfs.unlink(path);

      return null;
    });
  }

  /** Run a command in this workspace's shell for a fork: one round trip instead of one RPC per
   * file through an emulated shell. */
  async execWorkspaceCommand(command: string): Promise<ParentRpcResult<ParentExecResult>> {
    return this.workspaceFileAnswer('', async () => {
      const shell = this.rt.shell;

      if (!shell) throw new Error('this workspace has no shell');

      return shell.exec(command);
    });
  }

  /** Null when unset (registry picks the default). */
  protected getStoredModelId(): string | null {
    return this.config.getModel();
  }

  // `ensureSchema()` first on each: a native DO RPC does not route through partyserver and can
  // land before `onStart` (see `installWorkspaceCapability`). It is flag-gated and idempotent.

  /** Native owner inspection. Does not initialize the SDK or application tables. */
  async inspectSubordinateStorage(request: SubordinateInspectionRequest, authority: SubordinateInspectionAuthority): Promise<SubordinateInspectionResult> {
    // Core authorizes the directory path before resolving its canonical
    // transcript. Payload reads may await VFS; they never acquire an actor.
    return inspectSubordinateStorage({
      sql: this.boundSql, raw: this.ctx.storage.sql,
      actor: this.actorHandle(), directory: this.actorDirectoryStore(),
      transcriptFor: (actor) => this.transcriptFor(actor),
    }, request, authority);
  }

  /**
   * One page of one chat: the caller's own by default, or the subordinate a pane names by actor id.
   * The root's pane names none and reads this actor's conversation.
   */
  @callable()
  async getChatHistoryPage(request?: PageRequest & { actor?: string }): Promise<Page<ChatHistoryEntry>> {
    this.ensureSchema();
    const { actor, ...page } = request ?? {};

    return getChatHistoryPage(actor === undefined ? this.chatTranscript : this.subordinateChat(actor), page);
  }

  /**
   * The chat behind a pane's actor id; the directory refuses ids it never issued or non-children.
   * A retired actor is unbound, so it reads via the presence-fenced handle with no file plane.
   */
  private subordinateChat(actorId: string): SessionTranscriptReader {
    const directory = this.actorDirectoryStore();
    const record = directory.retained(actorId);

    if (record === null) throw new KinuError('missing', 'The actor is not registered in this workspace.');

    if (record.parentActorId !== this.actorHandle().actorId || record.kind !== 'subordinate') {
      throw new KinuError('denied', 'The actor id does not name a chat this workspace hosts.');
    }

    if (record.retiringAt === null && record.deletedAt === null) return this.transcriptFor(directory.open(actorId));

    return readSessionTranscript(this.boundSql, actorReadHandle(this.boundSql, record), CHAT_SESSION_ID, null);
  }

  /** Used to preselect a menu entry; the model list comes from /api/user/models (user-scoped). */
  @callable()
  async getStoredModelSpec(): Promise<{ spec: string | null }> {
    return getStoredModelSpec(this.config);
  }

  /** Takes effect on the next resolved turn: `beforeTurn` re-reads
   * `config.getRoleSelection()` (core profiles/role-change.ts:1-5). */
  @callable() async setRole(roleId: string): Promise<{ role: string }> {
    const { envelope } = await this.profileInputs();

    return changeRoleAsOwner({ config: this.config, envelope, to: roleId, active: this.activeRoleLabel() });
  }
  @callable()
  async setModel(spec: string) {
    this.ensureSchema();

    return setModel({
      config: this.config,
      normalize: (s) => this.providerRegistry().normalizeSpecSync(s),
      onChanged: () => this.invalidateModelCaches(),
    }, spec);
  }

  /** Held as a row once landed, or as a reservation from acceptance until then. */
  private admittedSend(id: string): boolean {
    return this.chatTranscript.has(id) || this.pendingSends.has(id);
  }

  /** Resolves on admission, not landing; where the words land reaches clients as steer_status
   * under the same id. Unrecognized mode runs as build. */
  @callable()
  async send(text: string, id: string, files: readonly PromptFile[] = [], mode?: WorkMode): Promise<void> {
    this.ensureSchema();
    const attachments = v.parse(v.array(PromptFileSchema), files);

    await this.chatLoop.admit({ text, files: attachments }, { id, mode: isWorkMode(mode) ? mode : 'build' });
  }

  /** Aborts the in-flight LLM request first so stop works even if the cancel frame is lost.
   * Foreground only: detached jobs are stopped via `cancelBackgroundJob`. */
  @callable()
  async cancelCurrentWork(): Promise<CancelWorkOutcome> {
    this.ensureSchema();
    const turnId = this.durableTurnId();

    return await cancelCurrentWork({
      cancelChats: () => { this.chatLoop.stop(); },
      activeToolControllers: this._activeToolControllers,
      broadcast: (payload) => this.broadcast(payload),
      stopDeviceCommands: turnId === null ? undefined : async () => {
        try {
          const { stub, caller } = await this.userHub();

          return await stub.cancelDeviceRequestsForTurn(caller, turnId);
        } catch (err) {
          diagnostics.failure('device.turn_cancel_failed', toKinuError({
            doing: "cancelling this turn's device commands", cause: err, otherwise: 'unavailable',
          }), { turnId });

          // Local controllers are already aborted; report the durable device sweep failure explicitly.
          return [{ outcome: 'failed' as const, detail: renderThrownChain({ cause: err }) }];
        }
      },
      onCancelled: (outcome) => this.onWorkCancelled(outcome),
    });
  }

  /** Per-root hook after cancellation; whether Stop settles turn state is the root's business. */
  protected onWorkCancelled(_outcome: Omit<CancelWorkOutcome, 'ok'>): void {}

  /** Model for auxiliary calls and compaction. */
  getModel(): LanguageModel {
    this.actorHandle();
    const spec = this.operationProfile()?.profile.tier.model ?? this.getStoredModelId();

    return this.ownedModelServices.resolveModel(spec);
  }

  /**
   * Cached SOUL.md text, refreshed at turn start and invalidated by setSoul().
   * Cached because the soul is a workspace file and `beforeTurn` is the one place that can await it.
   */
  protected _cachedSoulText: string | null = null;
  protected async loadSoulText(): Promise<string> {
    return (await readSoul(this.rt.storage.vfs)) ?? '';
  }
  protected async refreshSoulText(): Promise<void> {
    this._cachedSoulText = await this.loadSoulText();
  }
  /** Protected because a hosted actor's turn is framed with the same workspace soul. */
  protected getSoulText(): string {
    return this._cachedSoulText ?? '';
  }

  /**
   * The workspace's purpose as this actor knows it: the auto-title source, and what an
   * added agent inherits. Each root answers from wherever its mission durably lives.
   */
  protected abstract ownMission(): string;

  /**
   * Failures propagate so the durable caller keeps the row owed and the ledger retries it.
   * Decision is core's (`planWorkspaceTitle`); `persistAutoTitle` refuses if the owner claimed first.
   */
  protected async applyAutoTitle(mission: string, standIn: boolean): Promise<string | null> {
    // Read stored naming state before a cold activation plans a title.
    await this.hydrateTitleInputs();

    const title = await applyWorkspaceTitle({
      slug: this.actorHandle().name,
      ...this.titleInputs(),
      mission,
      standIn,
    }, {
      persist: (name) => this.persistAutoTitle(name),
      suggest: (text) => this.suggestTitle(text),
    });

    if (title) diagnostics.event('agent.auto_titled', { workspace: this.name, title });
    // Always publish, even with no new title, so the roster never keeps the placeholder.
    // Throws, so the owed row carries the retry.
    await this.publishAutoTitle();

    return title;
  }

  /** Publish the stored title to readers outside this actor's storage; no-op in the base. */
  protected async publishAutoTitle(): Promise<void> {}

  /** Fill the activation-local view {@link titleInputs} reads; no-op when naming is local. */
  protected async hydrateTitleInputs(): Promise<void> {}

  protected async titlingRefusal(): Promise<string | null> {
    return null;
  }

  /** `false` means a manual rename claimed the title first, so the owner's choice wins the race. */
  protected abstract persistAutoTitle(displayName: string): Promise<boolean>;

  /** The base reads its own config; the workspace root overrides with its cache of the UserDO
   *  registry row, since an actor_config mirror would drift against other writers. */
  protected titleInputs(): WorkspaceTitleInputs {
    return { displayName: this.config.getDisplayName(), nameOrigin: this.config.getNameOrigin() };
  }

  /** The workspace name, plus the actor's own name when it is a subagent. */
  protected abstract promptIdentity(): Promise<PromptIdentity>;

  /**
   * One `'fast'` literal feeds both the model route and the spend label, so they cannot disagree.
   */
  protected async suggestTitle(mission: string): Promise<string | null> {
    const { model, spec, providerOptions } = await this.modelForSource('fast');

    return suggestWorkspaceTitle(async (system, prompt) => {
      // Opened before the request so a call that never returns still leaves a start row.
      const operation = beginModelOperation(
        { source: 'fast', operations: this.modelOperations },
        'complete',
        { spec },
      );

      let result;

      try {
        const request: Parameters<typeof generateText>[0] = {
          model,
          system,
          prompt,
          // No output cap: reasoning models spend budget thinking and a cap starves the JSON.
        };

        if (providerOptions) request.providerOptions = providerOptions;
        result = await generateText(request);
      } catch (err) {
        operation.failed({ cause: err });
        throw err;
      }

      // `spec` is the priced model string; `modelId` is what the provider served; keep both.
      // The operation completes before the parse: bill first, judge the answer after.
      const modelId = result.response?.modelId;
      const usage = normalizeUsage(result.usage);
      operation.completed({ usage, modelId: modelId ?? spec });
      const account = callAccountOf(result.response ?? {});

      this.reportModelCall(
        modelId
          ? { source: 'fast', usage, spec, modelId, account }
          : { source: 'fast', usage, spec, account },
      );

      return result.text;
    }, mission);
  }

  /**
   * Cache key over CraftStore + quality state; includes MAX(last_used_at) because effective-score
   * filtering depends on recency. Unscoped on purpose: crafted_tools has no actor_id column.
   */
  private _craftCacheKey(): string {
    const row = this.sql<{ cnt: number; latest: number; lastUsed: number }>`
      SELECT COUNT(*) as cnt, COALESCE(MAX(updated_at), 0) as latest,
             COALESCE(MAX(last_used_at), 0) as lastUsed
      FROM crafted_tools`[0] ?? { cnt: 0, latest: 0, lastUsed: 0 };

    return `${row.cnt}:${row.latest}:${row.lastUsed}`;
  }

  getTools(): ToolSet {
    // Chat view: raw surface + auto-background wrap (#173) + operation profile. Eval side-streams use
    // getRawTools() so they never detach a job. Also starts the turn clock for activity lines.
    this._turnT0 = performance.now();

    const tools = this.wrapToolsForBackground(this.getRawTools());
    const operation = this.operationProfile();

    return operation ? withOperationProfile(tools, operation) : tools;
  }

  /** Unwrapped tool surface; eval side-streams use it to run tools inline, never auto-backgrounded. */
  protected getRawTools(): ToolSet {
    this.actorHandle();

    return this.getRawToolsForWorkMode(this.turnWorkMode());
  }

  protected getRawToolsForWorkMode(mode: WorkMode, claimScope?: string): ToolSet {
    const actorDeps = this.actorToolDeps();
    const profileKey = actorActiveTools(actorDeps).join(',');
    // Key includes crafted_tools quality (score filtering depends on recency) and the actor profile,
    // so an owner chat never reuses an assigned turn's upward-reporting surface.
    const cacheKey = `${mode}:${profileKey}:${this.operationProfile()?.profile.digest ?? ''}:${this._craftCacheKey()}`;

    // Only the chat surface is cached; a scoped rollout's surface is built once per rollout.
    if (claimScope === undefined && this._cachedTools && cacheKey === this._cachedToolsKey) {
      return this._cachedTools;
    }

    this.logActivity("gettools_rebuilding", `${this._cachedToolsKey} → ${cacheKey}`);

    try {
      // No registry sync: the eval sandbox reads craftStore.list() fresh at every execute.
      // See docs/CRAFT-ARCHITECTURE.md §3.

      const builtinDeps: Parameters<typeof buildActorTools>[0] = {
        rt: this.rt,
        workMode: mode,
        history: this.stores.history,
        // `turnId` is a closure because the toolset is cached across turns; it must be the durable
        // message id a recovery replays, not a run id. Rollouts supply their own ({@link
        // makeScaffoldCallTool}).
        effectClaims: {
          actor: this.actorHandle(),
          sql: this.rt.storage.sql,
          turnId: claimScope === undefined
            ? () => currentOperationProfile(this.actorHandle())?.turnId ?? this._chatLoop?.currentTurnId ?? WORKSPACE_RUN_ID
            : () => claimScope,
        },
        // The sandbox declares the finished native surface, so core builds it last over all other tools.
        codemode: ({ native }) => this.getCodemodeToolFactory(mode, profileKey).toolFor(native),
        craftedToolExecute: null,
        // Lives on the accumulator so the cached toolset keeps a stable reference and resets per turn.
        contextBudget: this.acc.context,
        // Same ownership: rides the accumulator so the cached toolset sees the turn's ledger.
        fileLedger: this.acc.files,
        // Turn-scoped like fileLedger; the settle spine writes the durable row.
        escalations: this.acc.escalations,
        // Owner resolution stays lazy per action, so the cached toolset stays valid across claimOwner.
        agents: this.getAgentsToolDeps(mode),
        roleAuthority: () => this.operationProfile()?.inputs?.envelope ?? null,
        // memory.search uses hybrid retrieval when available; otherwise FTS5-only.
        vectorStore: this.rt.vectorStore,
        facts: this.facts,
        // The release lane is codemode-only (release.*), not a BuiltinToolDeps field.
        webSearch: this.ownedModelServices.getWebSearchProvider(),
      };

      if (actorDeps.report) builtinDeps.report = actorDeps.report;

      if (mode === 'plan' && actorDeps.submitPlan) builtinDeps.submitPlan = actorDeps.submitPlan;
      const tools = buildActorTools(builtinDeps);

      // One Anthropic cache breakpoint on the last tool caches the whole tool surface;
      // inert for non-Anthropic providers.
      markLastToolForAnthropicCache(tools, this.config.getCacheRetention());

      if (claimScope === undefined) {
        this._cachedTools = tools;
        this._cachedToolsKey = cacheKey;
      }

      this.logActivity("gettools_end", `rebuilt — ${Object.keys(tools).length} tools`);

      return tools;
    } catch (err) {
      diagnostics.failure('tool.surface_build_failed', toKinuError({
        doing: 'assembling the turn tool surface',
        cause: err,
        otherwise: 'io',
      }), { mode });
      throw err;
    }
  }

  /** Built lazily once per DO lifetime; heads need the owner for UserDO auth, so undefined without one. */
  private _cfHeadRuntime: HeadRuntime | null = null;
  protected getCFHeadRuntime(): HeadRuntime | undefined {
    if (this._cfHeadRuntime) return this._cfHeadRuntime;
    const ownerUserId = this.getOwnerUserId();

    if (!ownerUserId) return undefined;

    const grounding: HeadGrounding = this.rt.judgeModel
      ? { executor: this.rt.executor, explorer: this.rt.llm, judge: this.rt.judgeModel }
      : { executor: this.rt.executor, explorer: this.rt.llm };

    this._cfHeadRuntime = createHeadRuntime({
      host: this.explorationSeams(),
      models: this.ownedModelServices,
      // The merge is a judge call: its model and effort come from the route table via this profile,
      // not from the actor's stored chat spec.
      profile: () => this.routingProfile(),
      reportModelCall: (report) => this.reportModelCall(report),
      operations: this.modelOperations,
      grounding,
    });

    return this._cfHeadRuntime;
  }

  /**
   * `hostNodeSeat` (`exploration-hosting.ts`) is requested per node: search deps are shallow-copied
   * per child, so a shared seat would give a whole wave one claim ledger and one loop pointer.
   */

  /**
   * An actor's recent conversation (last N messages), handed to each spawned head as context.
   * A hosted actor hiring its own child must pass its own transcript, not the workspace root's.
   */
  protected abstract transcriptFor(actor: ActorHandle): SessionTranscript;

  protected readInheritedContext(actor: ActorHandle = this.actorHandle()): Promise<SerializedMessage[]> {
    return inheritedContextFromTranscript(this.transcriptFor(actor));
  }

  /**
   * Rebuilds AI-SDK tools from MCP descriptors; cache invalidates on descriptor content hash, and a
   * failed read keeps the last good build. `execute` dispatches as the parent workspace's token.
   */
  private async buildUserMcpTools(nativeTools: ToolSet): Promise<ToolSet> {
    const userId = this.getOwnerUserId();

    if (!userId) return {};

    // No identity, no user-level tools. Checked rather than caught: userCaller() throws only when no
    // token was issued, and a real read failure must not silently empty the surface.
    if (!this.workspaceCapabilityToken()) return {};
    const caller = await this.userCaller();

    try {
      // Budget is the resolved model's step context limit minus this actor's own tool definitions, read
      // off the same `ModelCatalogSession` as compaction (`McpSurfaceBudget`).
      const tools = await this.mcpToolsCache.refresh(
        () => this.requireOwnerUserDO().userMcp_toolDescriptors(caller),
        {
          ...this.modelCatalog.window(),
          nativeToolTokens: toolSurfaceTokens(nativeTools),
        },
      );

      this._mcpUnavailable = this.mcpToolsCache.unavailable.map((u) => ({
        source: `MCP server "${u.server}"`, reason: u.reason,
      }));
      this.logActivity('mcp_tools_served', `${Object.keys(tools).length} tools`);

      return withToolSchemaDialect(tools, toolSchemaDialect(this.effectiveModelSpec()));
    } catch (err) {
      const failure = toKinuError({
        doing: 'building the user MCP tool adapters for this turn',
        cause: err,
        otherwise: 'unavailable',
      });

      // Only an unreachable/unfinished catalog read is tolerated (turn runs on builtins alone); denied
      // callers, bad descriptors or cancellation are this turn's faults and rethrow.
      if (!MCP_CATALOG_READ_FAILURES.has(failure.code)) throw failure;
      diagnostics.failure('mcp.tool_surface_failed', failure);
      this._mcpUnavailable = [{
        source: 'MCP catalog',
        reason: 'The descriptor read failed. No MCP tool is available for this turn.',
      }];

      return {};
    }
  }

  /** Resolved `<provider>/<modelId>` for the next turn; falls back to the raw spec pre-claim.
   *  Protected: a hosted actor's search prices its estimate against this resolution. */
  protected effectiveModelSpec(): string {
    return resolveEffectiveModelSpec({
      live: () => this.operationProfile()?.profile.tier.model,
      stored: () => this.getStoredModelId(),
      normalize: (spec) => this.providerRegistry().normalizeSpecSync(spec),
    });
  }

  protected effectiveModelProviderFamily(): string {
    const spec = this.effectiveModelSpec();

    if (!spec) return '';

    return parseModelSpec(spec).provider;
  }

  /** Uses the resolved spec: the raw stored id is null on default-configured agents,
   *  which would leave model-family guidance inert. */
  protected promptModelContext(): PromptModelContext {
    const spec = this.effectiveModelSpec();

    if (!spec) return {};

    try {
      const { provider, modelId } = parseModelSpec(spec);

      return { id: modelId, provider };
    } catch (error) {
      diagnostics.event('actor.model_spec_unparseable', {
        workspace: this.name, error: renderThrownChain({ cause: error }),
      });

      return { id: spec };
    }
  }

  /** Cached, non-blocking lookup per spec; static fallbacks answer until it lands. */
  /** Protected: the workspace's mission ledger prices every hosted actor's spend off this catalog,
   *  so a search's estimate and the ledger read one rate. */
  protected readonly modelCatalog = new ModelCatalogSession({
    effectiveSpec: () => this.effectiveModelSpec(),
    lookup: async (spec) => {
      if (!spec) return null;
      const { provider, modelId, account } = parseModelSpec(spec);
      const reg = this.providerRegistry();

      return catalogModelInfo(reg.registry.get(provider), accountDeps(reg.deps, provider, account), modelId);
    },
  });

  /**
   * Unapproved instruction files ride a sealed user message (agent-writable, not system plane).
   * Never persisted: appended after the transformContext seam, so compaction never sees it.
   */
  private turnLocalTail(
    deviceNotice: string | null,
    agentsMd: AgentsMdSources,
    activeSkills: ActiveSkillSet | undefined,
  ): ModelMessage[] {
    // Provenance rides here, not in the system prompt: it flips mid-session and would rewrite the
    // cacheable prefix (core prompting/volatile-context.ts).
    const turnLocalOptions: Parameters<typeof turnLocalContextMessage>[0] = {
      deviceNotice,
      provenance: this.turnProvenance(),
    };

    if (this._turnActiveSkills) turnLocalOptions.activeSkills = this._turnActiveSkills;
    const turnLocal = turnLocalContextMessage(turnLocalOptions);

    const unverified = unverifiedInstructionsMessage(
      activeSkills ? { agentsMd, activeSkills } : { agentsMd },
    );

    return [
      ...(unverified ? [unverified] : []),
      ...(turnLocal ? [turnLocal] : []),
    ];
  }

  /** Source for `turnWorkMode`, `turnProvenance`, and `turnUserMetadata`. */
  private _turnItem: ChatTurnInput | null = null;

  /** The ChatSession's `prepareTurn` port; the loop has already opened the run row and lease. */
  protected async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease): Promise<PreparedTurn> {
    this._turnItem = item;
    this._turnProgram = null;

    // Clear the previous turn's profile before anything reads a mode: `turnWorkMode()` prefers the
    // bound profile, and the tool build below is the first reader.
    this._turnOperation = null;
    // The chat view, not the raw surface: a slow `run` must detach into a background job whose
    // settle wakes a turn, and that wrap lives here.
    const tools = this.getTools();
    const reads = await this.readTurnInputs(tools);
    this._executorsUsedThisTurn.clear();
    const body = item.metadata ?? {};
    this._cliCwd = readCliCwd(body);
    this._turnContinuity = readTurnContinuity(body);
    // Read where the turn opens: the recorded turn carries it so a recovering host's engine
    // cannot re-judge a turn it did not run.
    this._turnEvolutionEnabled = this.turnRecordsEvolution();

    // A real user message is the verdict on the previous turn; programmatic turns
    // (reactor / job wake) are not.
    if (item.kind === 'user') this.orch.observeUserTurn(item.text, this._turnContinuity);
    openAnalyticsWindow(this.env);

    // The loop already placed the turn's input on the working history before handing it here.
    const { messages: history } = await this.stores.history.materialize();
    // Frozen so a background re-drive of a context:'inherit' hire carries the conversation
    // the caller actually had.
    this._turnOriginContext = Object.freeze(structuredClone([...history]));
    const assembled = await this.assembleTurn({ history, tools, body, reads });
    this._turnDurableLength = assembled.rawMessages.length;
    // Bound exactly once before execution; the CLI adapter binds it at the same point.
    this.actorSession.bindProfile(lease, assembled.profile, assembled.profileInputs);

    const liveTurn: ActorExecutionInput['chat'] = {
      model: assembled.model,
      modelContext: {
        id: assembled.promptModel.id,
        contextWindow: assembled.window.contextWindow,
        windowMeasured: assembled.window.windowMeasured,
        modelOutputLimit: assembled.window.modelOutputLimit,
      },
      system: assembled.system,
      attachments: {
        accepts: this.modelCatalog.acceptedMedia(), vfs: this.rt.storage.vfs, budget: this.acc.context,
      },
      turnLocal: assembled.turnLocal.length > 0 ? assembled.turnLocal : undefined,
      tools: assembled.tools,
      activeTools: assembled.activeTools,
      // No step cap: the loop is bounded by the budget governor and the caller's cancel
      // (see core chat.ts, UNBOUNDED_STEPS).
      stopWhen: UNBOUNDED_STEPS,
      transformTrigger: assembled.measured.trigger,
      cache: {
        providerId: assembled.promptModel.provider,
        modelId: assembled.promptModel.id,
        sessionKey: this.ownedModelServices.affinityKey,
        retention: this.config.getCacheRetention(),
      },
      budget: this.budget,
      countInputTokens: assembled.countInputTokens,
      observeStream: (chunks, call) => this.chatTransport.observe(chunks, call),
    };

    if (assembled.measured.providerReportedTokens !== undefined) {
      liveTurn.providerReportedTokens = assembled.measured.providerReportedTokens;
    }

    if (assembled.reasoningOptions) liveTurn.providerOptions = assembled.reasoningOptions;

    liveTurn.fallbacks = assembled.profile.tier.fallbacks.map((spec) => ({
      spec,
      bind: () => this.ownedModelServices.resolveModelWithEffort(spec, assembled.profile.tier.reasoningEffort),
    }));

    const runtime = this.rt;

    return {
      execution: {
        loopVersion: await runtime.identity.scaffold.version(),
        chat: liveTurn,
        // All registered extensions; the turn adds the orchestrator's inbox extension itself.
        extensions: this.extensions.list(),
        dynamic: (profile, turnTools) => this.dynamicContextSnapshot(profile, turnTools, assembled.memoryTail),
        scaffoldSpend: { source: 'scaffold', report: (report) => this.reportModelCall(report), operations: this.modelOperations },
      },
      sessionKey: this.name,
      contextWindow: assembled.window.contextWindow,
      historyLength: assembled.rawMessages.length,
    };
  }

  /** Clears transcript, working history, dynamic ledger and compaction plan. */
  private async clearConversation(): Promise<void> {
    this.stores.history.clearConversation(CHAT_SESSION_ID, () => {
      if (this._chatLoop?.turnInFlight() === true || this._actorSession?.inFlight === true) {
        throw new KinuError('denied', 'Stop the active turn before clearing its conversation');
      }
    });
    this.actorSession.dynamic.reset();

    try {
      await this.compactionState.plans.save(this.name, null);
    } catch (err) {
      diagnostics.failure('compaction.reset_failed', toKinuError({
        doing: 'clearing the persisted compaction plan after clear-history',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    }
  }

  /** Awaited ahead of `orch.beginTurn`: the turn is not in flight until these reads are back,
   * so a send during a cold workspace's bootstrap is routed as not-in-flight. */
  private async readTurnInputs(tools: ToolSet): Promise<TurnReads> {
    await this.ensureOwnedScaffold();

    if (this._cachedSoulText === null) await this.refreshSoulText();

    // Independent UserDO hops, run in parallel; each keeps its own failure arm.
    const [profileInputs, mcpTools, deviceStatus, identity] = await Promise.all([
      this.profileInputs(),
      // The remote catalog is admitted against the context budget left after the builtins.
      // A failed read answers no tools and the turn runs on builtins.
      this.buildUserMcpTools(tools),
      // Authoritative hub check: the TTL-cached snapshot can lag a mid-session `kinu connect`.
      // On failure it records and answers the last snapshot.
      this.rt.deviceTransport.refreshStatus(),
      this.promptIdentity(),
    ]);

    return { profileInputs, mcpTools, deviceStatus, identity };
  }

  /** Runs after the turn is open (`orch.beginTurn`, the run row) and before the first model call. */
  /** Every durable row of the answer is keyed on this id. A harness that must read those rows
   * back overrides this. */
  protected mintAnswerId(): string {
    return crypto.randomUUID();
  }

  /** Always allows: the platform serializes activations of one Durable Object. Overridable
   * so a suite can state the refusal the loop answers a send with. */
  protected driverGate(): Refusal | null {
    return null;
  }

  /** The one override point for a harness to script a turn's model. */
  protected turnModel(spec: string): LanguageModel {
    return this.ownedModelServices.resolveModel(spec);
  }

  private async assembleTurn(input: TurnAssemblyInput): Promise<AssembledTurn> {
    const { profileInputs, mcpTools, deviceStatus, identity } = input.reads;
    const activeRoleId = this.activeRoleLabel();
    const roleSkills = effectiveRoleCatalog(profileInputs.envelope.catalog)[activeRoleId]?.skills ?? [];
    this._workspaceInstructionApprovals = null;
    this._turnActiveSkills = null;
    // Deps-gated builtins (report) are advertised only when this actor class wires them; the
    // agents ladder renders only actions this profile supports, then the active skills' union.
    const turnActorDeps = this.actorToolDeps();
    const requestedWorkMode = this.turnWorkMode();
    let activeTools: BuiltinToolName[] = actorActiveTools(turnActorDeps);
    const trust = this.instructionTrust();

    const { available: availableSkills, activeSkills: activeSetForPrompt } = await resolveTurnSkills({
      vfs: this.rt.storage.vfs,
      config: this.config,
      userText: extractLastUserText(input.history),
      roleSkills,
      trust,
      limits: this.modelCatalog.window(),
    });

    if (activeSetForPrompt) {
      this._turnActiveSkills = activeSetForPrompt;
      activeTools = filterToolNamesBySkills(activeTools, activeSetForPrompt);
      this.logActivity('skills_active',
        activeSetForPrompt.active.map(s => s.name).join(',') || '(none)');
    }

    const mcpToolNames = Object.keys(mcpTools);

    const extensionTools = Object.fromEntries(
      Object.entries(this.extensions.tools())
        .filter(([name]) => !(name in input.tools) && !(name in mcpTools)),
    );

    const extensionToolNames = Object.keys(extensionTools);
    const availableAgentActions = actorAgentsActions(turnActorDeps);
    // `release` / `agent` / `llm` are reachable only inside `eval`, so they must be listed here or
    // the role intersection drops them; derived from providers wired for this mode.
    const turnCodemodeProviders = this.turnCodemodeProviders(requestedWorkMode);

    const availableTools = [
      ...activeTools,
      ...mcpToolNames,
      ...extensionToolNames,
      ...(turnActorDeps.submitPlan ? [SUBMIT_PLAN_TOOL] : []),
      ...codemodeCapabilitiesFor(turnCodemodeProviders),
    ];

    const profile = resolveAgentTurnProfile({
      ...profileInputs,
      activeRoleId: this.activeRoleLabel(),
      workMode: requestedWorkMode,
      availableTools,
      activeSkills: activeSetForPrompt?.active.map((skill) => skill.name) ?? [],
      // Request tier, then the tier pinned at hire, then the role's own default.
      // An absent pin must not read as the workspace default.
      explicitTier: readTurnTier(input.body) ?? this.config.getAssignedTier() ?? undefined,
      // The workspace's pinned model overrides the role's tier model; without it a setModel pin
      // is accepted but never used.
      workspaceModel: this.config.getModel(),
      explicitEffort: this.config.getReasoningEffort(),
    });

    const operation = captureOperationProfile({
      actor: this.actorHandle(), profile, inputs: profileInputs,
      runId: this._currentRunId || WORKSPACE_RUN_ID, turnId: this.durableTurnId() ?? this._currentRunId,
    });

    this._turnOperation = operation;
    const workMode = profile.workMode;
    this.orch.restrictTurnWorkMode(workMode);
    const modeTools = workMode === requestedWorkMode ? input.tools : this.getRawToolsForWorkMode(workMode);
    const allowedTools = new Set(profile.allowedTools);
    const toolAllowed = (name: string): boolean => allowedTools.has(name);
    const promptActiveTools = activeTools.filter(toolAllowed);
    const resolvedAgentActions = toolAllowed('agents') ? availableAgentActions : [];

    const planToolNames = workMode === 'plan' && turnActorDeps.submitPlan && toolAllowed(SUBMIT_PLAN_TOOL)
      ? [SUBMIT_PLAN_TOOL]
      : [];

    const effectiveActiveTools = [
      ...promptActiveTools,
      ...planToolNames,
      ...mcpToolNames.filter(toolAllowed),
      ...extensionToolNames.filter(toolAllowed),
    ];

    const effectiveTools: ToolSet = Object.fromEntries(
      [...Object.entries(mcpTools), ...Object.entries(extensionTools)]
        .filter(([name]) => toolAllowed(name)),
    );

    // The persisted watermark is only a diff anchor for the change notice; the hub is the source
    // of truth.
    let deviceNotice: string | null = null;

    try {
      deviceNotice = observeDevicePresence(this.config, deviceStatus).notice;
    } catch (err) {
      diagnostics.failure('device.status_refresh_failed', toKinuError({
        doing: 'recording the device hub presence for this turn',
        cause: err,
        otherwise: 'unavailable',
      }));
    }

    // AGENTS.md is turn-scoped state, so it rides the beforeTurn system override, not the cached
    // base prompt.
    const agentsMd = await collectWorkspaceAgentsMd(
      this.rt.storage.vfs,
      this.modelCatalog.window(),
      trust,
      this.rt.executionRouter?.getProvider('sandbox'),
    );

    // The cache prefix changes only on real agent events (soul, model, skills, tools, AGENTS.md);
    // system and turn-local state ride the dynamic ledger and a trailing message instead.
    const execs = this.rt.executionRouter?.listExecutors() ?? [];
    const model = this.promptModelContext();

    const promptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {
      soulOverride: this.getSoulText(),
      executors: execs,
      availableTools: promptActiveTools,
      agentsActions: resolvedAgentActions,
      temporaryAsk: turnActorDeps.team?.temporary !== undefined,
      externalTools: mcpToolNames.filter(toolAllowed)
        .map((name) => ({ name, source: 'mcp' as const })),
      backend: 'cf',
      roleSection: profile.role,
      model,
      currentDate: currentDateForPrompt(),
      // Read here, not in the builder: the builder is the byte-stable cacheable prefix and does no I/O.
      sectionOverrides: activePromptSectionOverrides(this.rt.storage.sql, this.actorHandle()),
      identity,
    };

    if (availableSkills.lines.length > 0) promptOptions.availableSkills = availableSkills;

    if (activeSetForPrompt) promptOptions.activeSkills = activeSetForPrompt;
    promptOptions.agentsMd = agentsMd;
    const systemOverride = buildSystemPromptSync(this.rt, promptOptions);
    this.recordSystemPromptHash(systemOverride);

    const languageModel = this.turnModel(profile.tier.model);

    // Attachment sanitization is per-part copy-on-write, so the raw count equals the sanitized
    // durable length; recordTurnTelemetry measures against the same number.
    const rawMessages = this._cliCwd ? withCliCwdContext(input.history, this._cliCwd) : input.history;
    this._turnDurableLength = rawMessages.length;
    // Must be awaited before submission: synchronous catalog reads return static stand-in values
    // while the lookup is in flight (#20).
    const [window] = await Promise.all([this.modelCatalog.resolved(), this.modelCatalog.warm(profile.tier.fallbacks)]);
    this._turnContextWindow = window.contextWindow;
    const measured = measureCompactionTrigger(this.compactionState, this.name, rawMessages.length);

    // Forced rebuild is armed by overflow recovery (onChatResponse) or by agent.compactNow.
    if (measured.trigger === 'force') this.logActivity('compaction_forced', 'forced context rebuild');
    // The reflection loop assumes the model sees its latest MEMORY.md lessons in-turn; read once
    // here since it is the one dynamic-context input needing an await.
    const memoryTail = await readMemoryTail(this.rt.memory);
    const turnLocal = this.turnLocalTail(deviceNotice, agentsMd, activeSetForPrompt);

    const submittedTools = { ...modeTools, ...effectiveTools };
    const providers = this.providerRegistry();
    // Normalise via the serving registry first: `parseModelSpec` throws on a bare model id and
    // parses a bare `@cf/…` to an unknown provider. One parse serves admission and reasoning effort.
    const tierModel = parseModelSpec(providers.normalizeSpecSync(profile.tier.model));

    const activeToolSurface = Object.fromEntries(effectiveActiveTools.flatMap((name) => {
      const entry = submittedTools[name];

      return entry === undefined ? [] : [[name, entry]];
    }));

    const countInputTokens = (request: CountableRequest): Promise<InputTokenCount> => countRequestInputTokens(
      providers.registry.get(tierModel.provider), tierModel.modelId,
      accountDeps(providers.deps, tierModel.provider, tierModel.account), request,
    );

    const taskPlan: TaskPlanContext = Object.freeze({ sql: Object.freeze([this.boundSql, this.rt.storage.sql]), plan: this.approvedTaskPlan() });
    const tools = withOperationProfile(withTaskPlan(toolsForInvocation(workMode, { ...modeTools, ...effectiveTools }), taskPlan), operation);

    // Shares `promptCachePlan` with the other loop. Request cache routing rides
    // TurnConfig.providerOptions; system/tail breakpoints ride beforeStep (TurnConfig.system is string).
    const cachePlan = promptCachePlan({
      providerId: model.provider,
      modelId: model.id,
      system: systemOverride,
      sessionKey: this.ownedModelServices.affinityKey,
      retention: this.config.getCacheRetention(),
    });

    const cacheOptions = cachePlan.providerOptions;

    const reasoningOptions = reasoningEffortOptions(
      profile.tier.reasoningEffort,
      tierModel.provider,
    );

    return {
      profile, profileInputs, system: systemOverride, model: languageModel, tools, activeTools: effectiveActiveTools, activeToolSurface,
      rawMessages, turnLocal, measured, window, memoryTail, countInputTokens,
      cacheOptions, reasoningOptions, promptModel: model,
    };
  }

  /** Set in beforeTurn; read by beforeStep's prune budget every step. */
  protected _turnContextWindow = 0;
  private _turnOriginContext: readonly ModelMessage[] = [];

  /** Subclass-only planes, read per step by the shared assembler; empty here. */
  protected extraDynamicContext(): ActorDynamicContextExtras {
    return {};
  }

  /**
   * The live state of this agent, read fresh for one model step; holds no state of its own.
   * Nothing clock-derived: a wall-clock field would re-fingerprint the block every request.
   */
  protected dynamicContextSnapshot(profile: Pick<ResolvedTurnProfile, 'workMode' | 'allowedTools'>, tools: ToolSet, memoryTail: string | undefined): DynamicContext {
    const extras = this.extraDynamicContext();

    return collectDynamicContext({
      rt: this.rt,
      stores: this.stores,
      profile,
      tools,
      memoryTail,
      missingCapabilities: [
        ...this._mcpUnavailable,
        ...(extras.extraMissingCapabilities?.() ?? []),
      ],
      subordinateDelegates: () => this.subordinateDelegates(),
      approvals: extras.approvals,
    });
  }

  /** The system prompt hash should change only on real agent events (soul/skill/craft/device/model),
   *  never between two vanilla consecutive turns; an unexplained change is a cache-prefix regression. */
  private _lastSystemPromptHash: string | null = null;
  private recordSystemPromptHash(system: string): void {
    const { hash, status } = observeSystemPromptHash(this._lastSystemPromptHash, system);
    this._lastSystemPromptHash = hash;
    this.logActivity('system_prompt_hash', status === 'first' ? hash : `${hash} (${status})`);
  }

  /** A queued signal stamps kinuEvent metadata on the saved user message; real chat carries none. */
  protected lastUserTurnIsProgrammatic(): boolean {
    return this.turnUserMessageEvent() !== null;
  }

  /** Chat turns are interactive: slow work must hand back a handle fast. Signal-driven turns are
   *  one-shot: detaching there costs a truncated turn plus a synthesis turn and buys nothing. */
  protected turnSurface(): InvocationSurface {
    // Either marks one-shot: a CLI `oneShot` request (continuity 'independent_task') or a
    // signal-driven turn carrying `kinuEvent` metadata; continuity alone misses autonomous turns.
    const programmatic = this.turnUserMessageEvent() !== null;

    // A landed steer means a human is watching from that step on, whatever drove the turn.
    if (this.actorSession.landedSteers.length > 0) return 'interactive';

    return programmatic || this._turnContinuity === 'independent_task' ? 'one-shot' : 'interactive';
  }

  /** Read off the item the loop admitted; null for real chat turns. */
  protected turnUserMessageEvent(): string | null {
    const metadata = this.turnUserMetadata();

    return metadata !== undefined && v.is(v.string(), metadata.kinuEvent) ? metadata.kinuEvent : null;
  }
  /** Plan is explicit user intent on the driving message; everything else is unconstrained. */
  protected turnWorkMode(): WorkMode {
    return this.workModeForMetadata(this.turnDrivingMetadata());
  }

  protected workModeForMetadata(metadata: JsonObject | undefined): WorkMode {
    return this.operationProfile()?.profile.workMode ?? workModeForTurnMetadata(metadata);
  }

  protected async preparedWorkMode(): Promise<WorkMode> {
    if (this._chatLoop?.turnInFlight() === true) return this.turnWorkMode();

    return this.workModeForMetadata(await this.chatTranscript.lastUserMetadata());
  }

  /** Read from the event alone, never from the work mode stamped beside it. */
  protected turnProvenance(): TurnProvenance {
    return turnProvenanceForMetadata(this.turnDrivingMetadata());
  }

  private turnDrivingMetadata(): JsonObject | undefined {
    return this.turnUserMetadata();
  }

  /** Active turn metadata only. Idle operations await canonical metadata in
   *  preparedWorkMode before constructing their synchronous tool surface. */
  protected turnUserMetadata(): JsonObject | undefined {
    // The item belongs to the turn only while the loop holds it (through settle).
    // Read the loop only if it exists: an idle read must not build it.
    const metadata = this._chatLoop?.turnInFlight() === true ? this._turnItem?.metadata : undefined;

    if (metadata === undefined) return undefined;
    const parsed = v.safeParse(JsonObjectSchema, metadata);

    return parsed.success ? parsed.output : undefined;
  }

  /** Only the named set detaches (30s threshold, per-call gates); a confined surface names its own,
   *  which keeps containment structural. The tracking hook keeps foreground cancellation working. */
  private wrapToolsForBackground(raw: ToolSet): ToolSet {
    return wrapToolsForBackground(this.publishDeviceRequestChannel(raw), {
      jobRunner: this.jobRunner,
      backgroundable: BACKGROUNDABLE_TOOLS,
      mode: () => this.turnWorkMode(),
      trackController: (controller) => {
        this._activeToolControllers.add(controller);

        return () => this._activeToolControllers.delete(controller);
      },
    });
  }

  /** Channel the running `eval` call was armed with, or null outside one. */
  private _activeDeviceRequests: DeviceRequestChannel | null = null;

  /**
   * Per-invocation channel carrying the owning job into device execs, even after detach; not a
   * constructor arg since codemode namespaces are built once per DO. Applied inside the background
   * wrap; restored (not cleared) on exit. The raw surface must stay unwrapped for eval side-streams.
   */
  private publishDeviceRequestChannel(raw: ToolSet): ToolSet {
    const entry = raw[CODEMODE_TOOL_TOOL];
    const exec = entry?.execute;

    if (entry === undefined || exec === undefined) return raw;

    return {
      ...raw,
      [CODEMODE_TOOL_TOOL]: {
        ...entry,
        execute: async (input, options) => {
          const outer = this._activeDeviceRequests;
          this._activeDeviceRequests = readDeviceRequestChannel({ toolOptions: options }) ?? null;

          try {
            return await exec(input, options);
          } finally {
            this._activeDeviceRequests = outer;
          }
        },
      },
    };
  }

  /**
   * The live turn's profile, else one resolved now for durable work without a chat turn.
   * MODEL_ROUTE_POLICY is read against this; resolving a model any other way bypasses routing.
   */
  protected async routingProfile(availableTools: readonly string[] = [], preparedMode?: WorkMode): Promise<ResolvedTurnProfile> {
    return resolveRoutingProfile({
      actor: this.actorHandle(),
      resolve: async () => resolveAgentTurnProfile({
        ...(await this.profileInputs()),
        activeRoleId: this.activeRoleLabel(),
        workMode: preparedMode ?? await this.preparedWorkMode(),
        availableTools,
        activeSkills: [],
        explicitTier: this.config.getAssignedTier() ?? undefined,
      }),
    });
  }
  /**
   * Routing profile resolved for one hosted actor, not the root: role comes from the actor's own handle.
   * Workspace inputs and pinned model still apply, so an unpublished role narrows to nothing.
   */
  protected async hostedActorProfile(input: {
    readonly actor: ActorHandle;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
    /** A binding's named tier overrides the actor's assignment for this call. */
    readonly explicitTier?: string | undefined;
  }): Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }> {
    const inputs = await this.profileInputs();
    const config = input.actor.config;

    return {
      profile: await resolveAgentTurnProfile({
        ...inputs,
        activeRoleId: config.getRoleSelection(),
        workMode: input.workMode,
        availableTools: [...input.availableTools],
        activeSkills: [],
        explicitTier: input.explicitTier ?? config.getAssignedTier() ?? undefined,
        workspaceModel: this.config.getModel(),
        // The actor's own pin and effort, written by its pane; else the workspace's.
        actorModel: config.getModel(),
        explicitEffort: config.getReasoningEffort() ?? this.config.getReasoningEffort(),
      }),
      inputs,
    };
  }

  /**
   * Model, pricing spec and effort options are one decision, returned together so callers cannot
   * re-derive a disagreeing one; `unit-turn-pipeline-correctness.test.ts` pins the invariant.
   */
  protected async modelForSource(source: SpendSource): Promise<{
    model: LanguageModel;
    spec: string;
    providerOptions: ReturnType<OwnedModelServices['resolveModelWithEffort']>['providerOptions'];
  }> {
    const route = resolveModelRoute(source, await this.routingProfile());

    if (!route) {
      throw new Error(`${source} is platform-routed: it has no model in the turn profile`);
    }

    return {
      spec: route.model,
      ...this.ownedModelServices.resolveModelWithEffort(route.model, route.reasoningEffort),
    };
  }

  protected async getModelForReview(): Promise<LanguageModel> {
    return (await this.modelForSource('judge')).model;
  }

  // Work that outlives its request goes through `runFiber` (a `cf_agents_runs` row);
  // recovery classification lives in ./fiber-recovery.ts.

  /**
   * Not `async` on purpose: the SDK awaits this inside `blockConcurrencyWhile`, which resets the object
   * at `do.block_concurrency.cancel_ms`; re-drives go to {@link redriveRecoveredLane}. Must never throw.
   */
  override onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
    this.actorHandle();

    return Promise.resolve(classifyRecoveredFiber(this.fiberLanes, ctx));
  }

  /** Built fresh per recovery rather than captured at interruption time. */
  private get fiberLanes(): FiberLaneTransports {
    return {
      jobs: this.jobRunner,
      runDueSessionEvolution: () => this.orch.runDueSessionEvolution(),
      hasAdvisorNoteForTurn: (turnId) => this.engine.hasAdvisorNoteForTurn(turnId),
      reviewAdvisorSnapshot: (snapshot) => this.runAdvisorReview(snapshot),
      sql: this.boundSql,
      actor: this.actorHandle(),
      appendMemory: (path, text) => this.rt.memory.append(path, text),
      armOwedTerminalRecovery: () => this.terminal.armOwedRecovery(),
      deliverSignal: (signal) => this.orch.inbox.send(signal),
      redrive: (lane, checkpoint, body) => this.redriveRecoveredLane(lane, checkpoint, body),
    };
  }

  /** Declared so the value Kinu reads and the SDK enforces are the same (see fiber-recovery.ts). */
  static options = {
    fiberRecoveryMaxAgeMs: FIBER_RECOVERY_MAX_AGE_MS,
  };

  /**
   * Cleanup only; called from `onStart`, synchronous and bounded so safe in the init gate.
   * Failures are logged and dropped so activation still succeeds.
   */
  protected sweepUnrecoverableFiberRows(): boolean {
    // A failed pass reports truncated so the caller arms the wake and retries.
    let truncated = true;

    try {
      const result = sweepUnrecoverableFibers(fiberRowStore(this.boundSql), Date.now());

      if (result.dropped > 0 || result.truncated) {
        diagnostics.event('fiber.unrecoverable_rows_dropped', {
          dropped: result.dropped,
          scanned: result.scanned,
          truncated: result.truncated,
        });
      }

      truncated = result.truncated;
    } catch (err) {
      diagnostics.failure('fiber.unrecoverable_sweep_failed', toKinuError({
        doing: 'dropping the interrupted-fiber rows the recovery budget refused',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    }

    return truncated;
  }

  /**
   * Async maintenance that may queue turns or cross objects, so it runs in the alarm, never activation.
   * Idempotent; returns whether the budget filled and work must continue next tick.
   */
  protected async maintenanceWork(): Promise<boolean> {
    return recoverSubordinateLifecycles(this.subordinateRoster, this.subordinateRuntime());
  }

  /** Detached work this actor owns until its lexical error boundary settles. */
  protected readonly _backgroundTasks = new Set<AsyncTaskOwner>();

  /**
   * Owns a detached task so it can be joined; a reset cancels promises silently
   * (`do.background_task.cancelled_on_reset`). Not durable; the body names its own failures.
   */
  protected detachOwned(body: () => Promise<void>): void {
    const owner: AsyncTaskOwner = { promise: null };
    this._backgroundTasks.add(owner);
    owner.promise = (async () => {
      try {
        await body();
      } catch (cause) {
        diagnostics.failure('actor.detached_task_unclassified', toKinuError({
          doing: 'running a detached activation task', cause, otherwise: 'io',
        }), { workspace: this.name });
      } finally {
        this._backgroundTasks.delete(owner);
      }
    })();
  }

  /**
   * Await every detached task this activation owns; a test seam, since production tasks are fenced.
   * Bounded laps: a task that keeps replenishing the set fails the caller instead of hanging.
   */
  protected async settleBackgroundTasks(): Promise<void> {
    for (let lap = 0; lap < 32; lap++) {
      if (this._backgroundTasks.size === 0) return;
      await Promise.all([...this._backgroundTasks].map((task) => task.promise ?? Promise.resolve()));
    }

    throw new Error(
      `settleBackgroundTasks: ${String(this._backgroundTasks.size)} task(s) still detached after 32 `
      + 'laps — something keeps enqueuing work; join a narrower seam instead',
    );
  }

  /** Every budgeted activation sweep; subclasses fold in their own. True if any pass filled its
   *  budget (caller arms the wake). Synchronous so the init gate can run the same seam. */
  protected maintenanceSweeps(): boolean {
    return this.sweepUnrecoverableFiberRows();
  }

  /**
   * Re-drive one interrupted lane off the init gate via `runFiber`, whose synchronous prefix writes
   * the durable `cf_agents_runs` row before this returns; one dispatch per entry (own checkpoint).
   */
  protected redriveRecoveredLane(
    lane: string, checkpoint: JsonValue, body: () => Promise<void>,
  ): void {
    this.detachOwned(async () => {
      try {
        // The stash wrapper writes `initialSnapshot` in the same synchronous prefix as the row insert,
        // so a reset never finds a recoverable lane with a null payload.
        await this._runFiberWithStashWrapper(lane, async () => { await body(); }, {
          initialSnapshot: checkpoint,
        });
      } catch (cause) {
        diagnostics.failure('fiber.lane_redrive_failed', toKinuError({
          doing: `re-driving the "${lane}" lane an interruption left behind`,
          cause,
          otherwise: 'unavailable',
        }), { workspace: this.name, lane });
      }
    });
  }

  protected invalidateModelCaches(): void {
    // Also drops the provider registry (caches per-agent OAuth refreshers) so a disconnected
    // provider stops being marked available.
    this.ownedModelServices.invalidate();
  }

  // All credentials live in UserDO; providers resolve auth headers through the UserDO stub at
  // fetch time, so this agent stores no raw credentials.

  /** Fan-out target of notifyWorkspacesCredentialsChanged after UserDO credential mutations. */
  async onCredentialsChanged(): Promise<{ ok: true }> {
    this.invalidateModelCaches();

    return { ok: true };
  }

  /** Re-drive an evicted background job from its checkpoint (B6) over the raw surface, so a
   *  re-drive can't detach a second job. Legacy `fork` and 'think' rows map to the search path. */
  protected resumeBackgroundJob(
    kind: string,
    input: JsonValue,
    mode: WorkMode,
    signal: AbortSignal,
  ): Promise<JsonValue | undefined> {
    return resumeBackgroundJob({
      rawTools: (resumeMode) => this.getRawToolsForWorkMode(resumeMode),
      kind, input, mode, signal,
    });
  }
}
