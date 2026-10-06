import { Cause, Effect, Exit } from 'effect';
import type { VfsDirent, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Actor-agnostic substrate beneath every full-loop Kinu actor on the Cloudflare backend.
 * Tool gating is structural: a profile with no `team` deps gets no hiring actions on `agents`.
 */

import {
  Agent, callable, getCurrentAgent,
  type AgentContext, type Connection, type ConnectionContext,
  type FiberRecoveryContext, type FiberRecoveryResult,
  type WSMessage,
} from "agents";
import {
  TierIdSchema, inspectSubordinateStorage, writeActivityLog, backgroundJobNotice, recordServingJobs, REAL_CLOCK,
  type BackgroundJob, type BackgroundJobRunnerDeps, type Clock, type WorkspaceJobPorts, WorkspaceJobAuthorities, type JobAuthority,
  actorConnectionTag, actorFromConnectionTags, hostedActorRoute, HOSTED_ACTOR_ID_HEADER, actorReadHandle,
  resetGuardedExec, StoragePredatesResetError, ERROR_STATUS, LiveWorkers,
  type RunEventInput, type SubordinateInspectionAuthority, ConversationSearchStore, type ConversationRecall,
  isSubordinateOrigin, drawnStep, WORKSPACE_ROOT,
} from '@kinu.run/core';
import type { SubordinateInspectionRequest, SubordinateInspectionResult } from '@kinu.run/core';
import type { SubordinateActivityEvent } from '@kinu.run/core';
import type { SubordinateRosterEntry as SubordinateView } from '@kinu.run/core/protocol';
import { MessageType, parseProtocolMessage, sendIfOpen } from "agents/chat";
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
  rpcFrameOf,
  type CliSocketBearer,
  type RpcFrame,
} from "./cli/rpc-gate";
import { codemodeSurface, hostedWindowMay, PAGE_KEEPALIVE, readsWrittenBy, requiredRpcAccess, ROSTER_READS, rpcMovesOverview, type LiveRead, type SqlExec } from "@kinu.run/core";
import { retryTransientDO } from "@kinu.run/core";
import { createWorkersTracer } from "./obs/cf-tracer";
import { createAgentTracing, hold, logged, recording, renderThrownChain, type AgentTracing, settle, settleSync, settleLoggedSync, settleLogged } from "@kinu.run/core/obs";
import {
  createCompactionExtension, createSharedPrefixCompactor, createVfsTranscriptStore,
  createCompactionStateStore, createModelSummarizer, COMPACTION_PRESETS,
  type CompactionStateStore, type Logger as CompactionLogger,
} from "@kinu.run/compaction";
import { convertToModelMessages } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";

import {
  EvolutionEngine, recoverSubordinateLifecycles, actorReferenceOf, sameActorReference, createDbCodemodeProvider,
  type ActorHandle, type ActorHost, type ActorReference, type ChildActorOperation,
  type ActorDirectoryResult, type HostedActor, type WorkspaceActorDirectory,
  type ScaffoldRunOptions,
  initActorClaimTables, ActorClaimStore, initPendingSendTables, PendingSendStore,
  createScaffoldCandidateSurface, createScaffoldCallTool, createScaffoldHistory, type ScaffoldCandidateBinding,
  createJsonJudge, type ScaffoldControl,
  refinementPass, type RefinementDeps,
  type CompletedTurn, type TurnContinuity, UNBOUNDED_STEPS,
  type AdvisorRecoverySnapshot,
  buildActorTools, buildBuiltinTools,
  buildMcpToolSet, McpToolSurfaceCache,
  type WebSearchProvider,
  type BrowserSessions,
  browserSessions,
  buildSystemPromptSync,
  type PromptIdentity,
  turnArtifactBodies, artifactOverrides, currentArtifacts, withToolText, type TurnOpening,
  currentDateForPrompt,
  turnReasonForMetadata,
  workModeForTurnMetadata, authoredTurnMetadata,
  renderUnverifiedInstructions,
  observeSystemPromptHash, steerSkillsBlock, splitTurnSkills, activatedSkillsBlock,
  type DynamicContext, type DynamicApproval, type MissingCapability,
  // Public extension seam — the SAME host contract runChat drives on the CLI
  ExtensionHost,
  type PromptFile, PromptFileSchema,
  // Shared turn lifecycle and run_end classifier, so neither backend chooses the string
  // (see turn-failure.ts).
  TurnAccumulator, AgentOrchestrator, ActorSession, ChatSession, type AgentOrchestratorDeps, type BackendHost,
  type ChatTurnInput, type ComposedRequest, type PreparedTurn, type OwedTerminalEffectsInput, type ActorTurnLease, type ActorExecutionInput,
  type KinuExtension, type OwedEffect,
  type InlineSteer,
  type AgentsToolAction,
  type AgentsToolDeps,
  type AgentsSwarmDeps,
  BUILTIN_TOOLS,
  type BuiltinToolName,
  type TurnReason,
  type PromptModelContext,
  type WorkMode, isWorkMode,
  nanoid,
  type HeadJournal, LiveHeadJournal,
  type HeadStreamFrame,
  type HeadId, type HeadInput, type HeadReport,
  type SerializedMessage, type HeadRuntime, type HeadGrounding,
  readMemoryTail,
  type RunEventRecorder,
  // Spend governor is opt-in: no label means no cap.
  MissionGovernor, type MissionSeam, type MissionBudgetRefusal,
  normalizeUsage, priceCall, type Usage,
  generateReported, type GenerateRequest,
  WORKSPACE_RUN_ID, type ModelCallReport, type ModelOperationSink, type ModelOperationEvent, type CacheWarmingLane,
  recordModelOperations, type ProviderWaitInfo,
  // Prices a model_call row only when the rate belongs to that call's own model.
  buildModelCallEvent,
  type FactsStore,
  createAgentStores, type AgentConfigStore, type SetModelDeps, type ContextSelection, collectDynamicContext, subordinateDelegatesOf,
  nimbusSessionFiles, agentArtifactDirectory, agentHome, MAIN_AGENT,
  CHAT_SESSION_ID, type SessionTranscript,
  type SqlExecutor,
  agentsActionsFor, betaSwarms,
  // Background-job system (#173: auto-background past the surface threshold)
  BackgroundJobRunner, type InvocationSurface,
  invocationBackgroundPolicy,
  type BackgroundJobStore, type TaskListStore,
  BACKGROUNDABLE_TOOLS, resumeBackgroundJob, harvestBackgroundJob, type ActorToolsets,
  cancelCurrentWork, getStoredModelSpec, setModel, getChatHistoryPage,
  type CancelWorkOutcome, type ChatHistoryPage, type Page, type PageRequest, PositionPageRequestSchema, type PositionPageRequest,
  type MctsSearchStore, readSearchTree, isSteerBranchRunId,
  EventLog,
  resolveTurnSkills, filterToolNamesBySkills,
  type ActiveSkillSet,
  inheritedContextFromTranscript,
  PlanReviewActions, planHandoffStillOwed, type PlanDecisionOutcome,
  type PlanEdit, type PlanReview, type ReviewAnnotation,
  type PlanReviewDecision, type PlanReviewResult, type SubmitPlanToolDeps,
  answerParentRpc,
  type ParentExecResult,
  type ParentRpcWrite,
  type TeamToolDeps, type PeersToolDeps, type ReportToolDeps,
  type SubordinateRuntime, type TemporaryAgentPort,
  SubordinateRosterStore, subordinateTitle,
  createTeamToolDeps, createTemporaryAgentPort, receiveSubordinateEvent,
  type SubordinateReportStatus, type SubordinateReportOrigin,
  type SubordinateEventResult,
  // One minting rule for every subordinate, on either backend
  mintSubordinateName,
  // Subordinate tree depth cap: derived per child, never stated by one
  delegationExhausted, deriveChildDelegationBudget, type DelegationBudget,
  readSoul, bootstrapScaffold,
  applyWorkspaceTitle, suggestWorkspaceTitle, type NameOrigin,
  accountDeps, parseModelSpec, specModelInfo, countRequestInputTokens,
  ModelCatalogSession, resolveEffectiveModelSpec, type ModelCatalogRead, type ModelInfo,
  // Shared turn-context assembly: the same ordering runChat runs on the CLI
  measureCompactionTrigger,
  // AGENTS.md discovery, and the trust authority deciding whether discovered bytes earn system placement.
  collectWorkspaceAgentsMd,
  InstructionApprovalStore, trustOfInstructionApprovals,
  type InstructionApproval, type InstructionTrustResolver,
  InstructionApprovalDesk, type AdmittedInstructionDecision,
  type InstructionSourceRow, type InstructionSourceView,
  type ResolvedModelWindow,
  reasoningEffortOptions,
  JsonObjectSchema, JsonValueSchema, changeRoleAsOwner,
  agentsProfileContext, effectiveRoleCatalog, loadProfileAuthorityInputs,
  resolveAgentTurnProfile, resolveRoutingProfile, ownProfileChoices, ancestorPins, createAgentConfigStore, type PinnedProfile,
  captureOperationProfile, currentOperationProfile, withOperationProfile,
  type OperationProfile,
  agentRoleSwitch, createMemoryCodemodeProvider, createTasksCodemodeProvider, createSlateWebCodemodeProvider, createAgentsCodemodeProvider,
  resolveModelRoute, completeOnRoute, routedLlm, tierRefusals, type TierRefusals, type ModelRouteResolution,
  narrowToolSurface, codemodeCapabilitiesFor, slateToolReach, callCodemodeMember, inWorkMode,
  toolSurfaceTokens, McpToolSurfaceSchema, GITHUB_MCP_PRESET, recognizeGitHubMcp, recordGitHubActivity, type SerializableToolDescriptor,
  SUBMIT_PLAN_TOOL, REPORT_TOOL,
  type ActiveRoster, type JsonObject, type JsonValue, type ProfileAuthorityInputs, type ProfileCatalogEnvelope,
  toolsForInvocation, withTaskPlan, type TaskPlan, type TaskPlanContext, providersInWorkMode, currentWorkMode, requireWorkModePermission, McpProtocolFailureSchema, McpToolError,
  type ResolvedTurnProfile, type TierId, type SpendSource, type ModelCallSpend, type ToolSurfaceNarrowing, type CountableRequest, type InputTokenCount,
  type AgentInbox,
  type NimbusSandboxHandle, childContextResolver, localContextTree,
} from "@kinu.run/core";
import {
  bindAgentSql, createCFRuntime, isCFRuntime, MODEL_SETTINGS,
  type CFRuntime, type CFRuntimeHooks, type WorkspaceBoxUse,
} from "./runtime";
import {
  hostNodeSeat, nodeCodemodeTool, hostedSubordinateRuntime,
  type HostedActorSeams,
} from "./hosted-actors";
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
  terminalEffect, chatTerminalEffects,
  RunEndReasonSchema, WorkModeSchema,
  AdvisorRecoverySnapshotSchema,
  type TerminalTransition, type TerminalEffectFault, type TerminalEffectTable,
} from "@kinu.run/core";
import { createCodemodeToolFactory, type CodemodeFactory } from "./codemode-tool";
import { codemodeLauncher, type ProgramLaunch } from "./codemode-sandbox";
import { createHeadRuntime } from "./head-runtime";
import type { AgentProviderRegistry } from "./providers/agent-registry";
import { OwnedModelServices } from "./owned-model-services";
import type { AgentStoreBroker } from "./agent-facets";
import type { CodemodeProvider, DeferredApprovalChannel, SlateBindingRoute, SlateCallResult, SlateOperation, SlateReadModel } from "@kinu.run/core";
import { workspaceOwner } from "./workspace-owner-rpc";
import { CRED_SESSION_USER } from "@nimbus-sh/core/runtime/os-contracts.js";
import type { SlateCaller, SlateCallerHop } from "./slates/bindings";
import { diagnostics, KinuError, refusalOf, refusing, toKinuError, tolerate, type ErrorCode, type Refusal } from "@kinu.run/core/obs";
import type { UserDO } from "./user/user-do";
import type { UserDoRpcMethod } from "./rpc-surface";
import { isWorkspaceTerminal, WorkspaceTerminalInputSchema } from "@kinu.run/core";
import type { WorkspaceTerminal } from "./workspace-host";
import type { UserCaller } from "@kinu.run/core";
import { sha256Hex } from '@kinu.run/core';
import { attributeWorkspace, installAnalyticsDiagnostics } from "@kinu.run/core/analytics";
import { openAnalyticsWindow } from "@kinu.run/core/analytics";
import {
  recordModelRow, recordToolRow, recordTtftRow, recordTurnRow, type AgentKind,
} from "@kinu.run/core/analytics";
import * as v from 'valibot';
import { Hono, type Context } from 'hono';
import { AdviceJobs } from './advice-jobs';
import { KINU_TIMER_JOB, TERMINAL_RETRY_JOB, WakeJobs, type WakePace } from './wake-jobs';
import { rawPath, rethrow } from './api/context';
import { callUserMcpTool } from './user-mcp-call';

/** Named contract so the analytics writer and the actor agree which half is the provider. */
interface ModelDimensions {
  readonly provider: string;
  readonly model: string;
}

/** No model resolved. Empty rather than a plausible default, so unknowns are not misattributed. */
const UNRESOLVED_MODEL: ModelDimensions = { provider: '', model: '' };

const RUN_EVENT_EMIT_FAILED = {
  tool_call_end: 'event.tool_call_end_emit_failed',
  step_finish: 'event.step_finish_emit_failed',
  budget_exhausted: 'event.budget_exhausted_emit_failed',
} as const;

/** The overflow retry earned and the one end reason, already sealed in `run_end`.
 * The terminal roster's `status` is this reason; callers must not reclassify. */
/** Owner-side reads a turn is assembled from, taken before the turn opens. */
interface TurnReads {
  readonly profileInputs: ProfileAuthorityInputs;
  readonly mcpTools: ToolSet;
  readonly identity: PromptIdentity;
  /** The request's model, resolved once: every catalog read of the request sizes against it. */
  readonly catalog: ModelCatalogRead;
  /** What picked that model; the turn's profile resolves from the same choices. */
  readonly choices: TierChoices;
}

type TierChoices = ReturnType<typeof ownProfileChoices>;

interface TurnAssemblyInput {
  readonly history: readonly ModelMessage[];
  /** The actor's raw tool surface for the requested work mode. */
  readonly tools: ToolSet;
  readonly reads: TurnReads;
}

/** The pieces of core's `ChatOptions` only this backend can supply, plus readings the
 * turn's settlement and per-step assembly re-use. */
interface TurnCompositionInput extends TurnAssemblyInput {
  readonly requestedWorkMode: WorkMode;
  readonly cliCwd: string | null;
  readonly item: ChatTurnInput | null;
}

interface AssembledTurn extends ComposedTurn {
  readonly measured: ReturnType<typeof measureCompactionTrigger>;
}

interface ComposedTurn {
  readonly profile: ResolvedTurnProfile;
  readonly profileInputs: ProfileAuthorityInputs;
  readonly system: string;
  readonly model: LanguageModel;
  /** The invocable surface: task-plan and operation-profile wrapped. */
  readonly tools: ToolSet;
  /** MCP and extension tools; only `eval` reaches them. */
  readonly externalTools: ToolSet;
  readonly activeTools: string[];
  /** The exact active subset, for admission counting and the dynamic ledger. */
  readonly activeToolSurface: ToolSet;
  /** The durable history with the CLI's cwd context laid over it. */
  readonly rawMessages: readonly ModelMessage[];
  /** The unapproved instruction files as one message, null for none. */
  readonly instructions: string | null;
  /** The input's `/name` activations, spliced before it for this turn only. */
  readonly activated: string | null;
  readonly activeSkills: ActiveSkillSet | null;
  readonly operation: OperationProfile;
  /** Window for admission, compaction and pruning; records whether figures are the
   * catalog's or the static table's stand-in. */
  readonly window: ResolvedModelWindow;
  readonly memoryTail: string | undefined;
  readonly countInputTokens: (request: CountableRequest) => Promise<InputTokenCount>;
  readonly reasoningOptions: ReturnType<typeof reasoningEffortOptions>;
  readonly promptModel: ReturnType<ActorAgent['promptModelContext']>;
}

interface AsyncTaskOwner {
  promise: Promise<Exit.Exit<void>> | null;
}

/** Only RPC methods rpc-surface.ts declares reachable; any other is a compile error. */
type UserHubClient = Pick<UserDO, UserDoRpcMethod>;

/** One actor's half of its job runner. */
type ActorJobSeams = Pick<BackgroundJobRunnerDeps,
  'store' | 'policy' | 'fiber' | 'inbox' | 'eventLog' | 'scheduleDrain' | 'resume' | 'harvest' | 'scheduleResume'> & {
  readonly notifySettled?: (job: BackgroundJob) => void;
};

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
function actorAgentsActions(deps: ActorToolDeps, swarms: boolean): AgentsToolAction[] {
  return agentsActionsFor({ swarm: {}, swarms, team: deps.team, peers: deps.peers });
}

/**
 * Ledgers that can owe work with no instant and nothing else to watch it. A running background job is not one: its
 * `bg:` fiber holds the object while it runs and re-drives it after a death, and a deferred one is timed (`nextOwedAt`).
 */
export interface UntimedArms {
  readonly openDrainLease?: boolean;
  readonly terminalIncomplete?: boolean;
  readonly unfinishedHeads?: boolean;
  readonly runningSwarms?: boolean;
  readonly retirements?: boolean;
  readonly pendingBirths?: boolean;
  readonly pendingDeletions?: boolean;
  readonly unsettledClaims?: boolean;
  readonly admittedDelegations?: boolean;
  readonly agentTurns?: boolean;
  readonly chatLoop?: boolean;
}

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
function hostedActorSurface(actor: HostedActor, webSearch: WebSearchProvider, conversations: ConversationRecall) {
  // `ActorHostDeps.runtimeFor` is `createCFRuntime` on this backend; core only narrows the type.
  const runtime = actor.runtime;

  if (!isCFRuntime(runtime)) {
    throw new KinuError('unsupported', 'a hosted actor on this backend must run on the cf runtime');
  }

  const providers: CodemodeProvider[] = [
    ...(runtime.executionRouter?.getProviders() ?? []),
    createSlateWebCodemodeProvider(webSearch),
    createDbCodemodeProvider(actor.stores.appData),
    createTasksCodemodeProvider(actor.stores.taskList, actor.stores.config),
    createMemoryCodemodeProvider(() => ({
      memory: runtime.memory, vectorStore: runtime.vectorStore, facts: actor.stores.facts, actor: actor.handle, conversations,
    })),
  ];

  const native = buildBuiltinTools({
    rt: runtime, vectorStore: runtime.vectorStore, facts: actor.stores.facts, webSearch,
    conversations,
    fileLedger: actor.session.orchestrator.acc.files, contextBudget: actor.session.orchestrator.acc.context,
  });

  return { providers, native };
}

export abstract class ActorAgent extends Agent<Env> {
  // Actor profile: these members are the whole difference between actor kinds.

  protected abstract getOwnerUserId(): string | null;
  protected abstract actorHandle(): ActorHandle;
  abstract actorDirectory(operation: ChildActorOperation): Promise<ActorDirectoryResult>;

  private actorRuntimeRefusal(): Refusal | null {
    if (this.storageRefusal !== undefined) return refusalOf(this.storageRefusal);

    try {
      this.actorHandle();

      return null;
    } catch (cause) {
      if (cause instanceof KinuError && cause.code === 'missing') return refusalOf(cause);
      throw cause;
    }
  }

  /** False for a Nimbus sibling, whose alarm is the SDK's. */
  protected hostsActor(): boolean {
    return true;
  }

  override alarm(): Promise<void> {
    if (!this.hostsActor()) return super.alarm();

    // Returned, not thrown: the platform retries a thrown alarm.
    if (this.storageRefusal !== undefined) return Promise.resolve();
    const refusal = this.actorRuntimeRefusal();

    if (refusal) return settle(Effect.fail(new KinuError(refusal.reason, refusal.error)));

    return super.alarm();
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
    this.capabilityToken ??= this.sql<{ token: string }>`SELECT token FROM workspace_capability LIMIT 1`[0]?.token || null;

    return this.capabilityToken;
  }

  /** Read once: {@link installWorkspaceCapability} is the row's only writer, and a destroy ends the isolate. */
  private capabilityToken: string | null | undefined;

  /** Hash of the held token, or null. Safe to share; lets the UserDO detect a mismatch. */
  protected async workspaceCapabilityHash(): Promise<string | null> {
    const token = this.workspaceCapabilityToken();

    return token ? sha256Hex(token) : null;
  }

  /** Worker-side DO RPC only, deliberately not `@callable`. `missed` counts failed subtree
   * pushes; the caller reports them to the UserDO so it can arm reconciliation. */
  installWorkspaceCapability(token: string): Promise<{ ok: true; missed: number }> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!token) return yield* new KinuError('denied', 'capability token required');
      void this.sql`INSERT INTO workspace_capability (id, token) VALUES (1, ${token})
               ON CONFLICT(id) DO UPDATE SET token = excluded.token`;
      this.capabilityToken = token;
      this.invalidateModelCaches();
      // The first tile, so a workspace nobody opens still shows.
      this.overviewChanged();

      // Hosted actors read the single capability row through their runtime, so a reissue applies on
      // their next call; no per-actor copies exist, so `missed` is always zero (callers report it).
      return { ok: true, missed: 0 };
    }));
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
    // In the base constructor: the SDK's fiber recovery reads it before any subclass constructor body.
    try {
      initActorClaimTables(resetGuardedExec((ddl: string) => this.ctx.storage.sql.exec(ddl), this.ctx.storage.sql));
    } catch (cause) {
      if (!(cause instanceof StoragePredatesResetError)) throw cause;
      this.storageRefusal = cause;
      diagnostics.failure('workspace.storage_predates_reset', cause, { table: cause.table });

      return;
    }

    // Same reason.
    initTerminalEffectTable((ddl: string) => this.ctx.storage.sql.exec(ddl));
  }

  /** Structural absence is the gating: an actor returning {} has no roster/peer actions. */
  protected abstract actorToolDeps(): ActorToolDeps;

  /** Spliced between `agents` and `web` so provider order (and the LLM-visible type description)
   *  is stable across actor kinds. */
  protected extraCodemodeProviders(): CodemodeProvider[] { return []; }

  protected abstract get engine(): EvolutionEngine;

  protected abstract notifyOwner(subject: string, body: string): void;

  /** Socket-only RPC policy: DO stub calls bypass onMessage, so trusted worker callers keep
   *  methods denied to client sockets. */
  protected isClientRpcMethodDenied(_method: string): boolean { return false; }

  private clientRpcRefusal(connection: Connection, rpc: RpcFrame): string | null {
    if (this.isClientRpcMethodDenied(rpc.method)) return `${rpc.method} is not available from client connections.`;
    const id = actorFromConnectionTags(connection.tags);

    if (id === null) return null;
    const name = this.hostedWindowName(id);
    // The SDK runs any array of arguments; a window's must be JSON values.
    const args = v.safeParse(v.array(JsonValueSchema), rpc.args);

    if (name === null) return `${rpc.method} from a window whose agent this workspace no longer holds.`;

    if (!args.success) return `${rpc.method} from ${name}'s window carries arguments that are not JSON values.`;

    return hostedWindowMay(rpc.method, args.output, { name, id }) ? null : `${rpc.method} from ${name}'s window may act only on ${name}.`;
  }

  private addressedActor(): string | null {
    const { connection } = getCurrentAgent();

    return connection === undefined ? null : actorFromConnectionTags(connection.tags);
  }

  // The concrete profile decides whether this turn may submit plan reviews: an owner-driven agent
  // does; a task delegated by its parent keeps the report lane instead.

  /** Plan this turn implements when it is a plan approval's handoff; honoured only while the row
   *  still says approved. Null otherwise. */
  private approvedTaskPlan(item: ChatTurnInput | null): TaskPlan | null {

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
    this._planActions ??= new PlanReviewActions(this.stores.planReviews, this.host);

    return this._planActions;
  }

  protected submitPlanEdits(edits: readonly PlanEdit[]): PlanReviewResult | Promise<PlanReviewResult> {
    return this.planActions.submit(edits, this.turnDrivingMetadata());
  }

  @callable()
  async getActivePlanReview(): Promise<PlanReview | null> {
    return this.planActions.active();
  }

  @callable()
  async savePlanReviewAnnotations(
    id: string,
    revision: number,
    annotations: ReviewAnnotation[],
  ): Promise<PlanReviewResult> {
    return this.planActions.saveAnnotations(id, revision, { value: annotations });
  }

  @callable()
  async dismissPlanReview(id: string, revision: number): Promise<PlanReviewResult> {
    return this.planActions.dismiss(id, revision, (prefix) => { this.chatLoop.stopIfRunning(prefix); });
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

  protected abstract hostedSeams(): HostedActorSeams;

  /**
   * Each actor's home is provisioned in this isolate by the host (`actor-hosting.ts` →
   * `hostedHomeName`); its identity is its `workspace_actors` row, so there is no facet port.
   */

  /**
   * At the depth cap the team deps are absent, so the tools cannot be attempted. Core's classified
   * refusal covers a cached ToolSet built before a facet's identity was seeded.
   */
  protected teamProfile(): Pick<ActorToolDeps, 'team'> {
    return delegationExhausted(this.delegationBudget()) ? {} : { team: this.getTeamToolDeps() };
  }

  private _subordinateRoster: SubordinateRosterStore | null = null;

  protected get watchedExec(): SqlExec {
    return {
      exec: (query, ...bindings) => {
        const cursor = this.ctx.storage.sql.exec(query, ...bindings);
        this.liveReadsMoved(readsWrittenBy(query));

        return cursor;
      },
    };
  }

  protected get subordinateRoster(): SubordinateRosterStore {
    if (!this._subordinateRoster) {
      this._subordinateRoster = new SubordinateRosterStore(this.watchedExec, this.actorHandle());
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

    if (entry === null) throw new KinuError('missing', `Subordinate "${name}" is not in the roster`);
    const reference = entry.actorReference;

    if (reference === null) return { ...entry, actorId: null, ...subordinateTitle(entry, null) };

    const record = this.actorDirectoryStore().retained(reference.actorId);

    if (record === null) throw new KinuError('missing', `Subordinate "${name}" names an actor this workspace does not hold.`);

    return { ...entry, actorId: reference.actorId, ...subordinateTitle(entry, actorReadHandle(this.boundSql, record).config) };
  }

  protected async subordinateViews(): Promise<SubordinateView[]> {
    return Promise.all(this.subordinateRoster.listAll().map(
      async (entry) => this.subordinateView(entry.name),
    ));
  }

  protected broadcastSubordinateEvent(
    event: Omit<SubordinateActivityEvent, 'type' | 'id'> & { id?: string },
  ): void {
    this.broadcastToActor(null, JSON.stringify({
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
      this.hostedSeams(),
      () => this.actorHost().bindStores(actorReferenceOf(this.actorHandle())),
    );

    return this._subordinateRuntime;
  }

  protected stopSubtree(_actorId: string): void {}

  protected async agentTurnSettled(_actor: ActorReference): Promise<void> {}

  protected temporaryAgentPort(reference: ActorReference = actorReferenceOf(this.actorHandle())): TemporaryAgentPort {
    return this.actorHost().temporary(reference, (bound) => {
      const seams = this.hostedSeams();
      const roster = seams.roster(bound);
      roster.ensureSchema();

      return createTemporaryAgentPort({
        roster, runtime: hostedSubordinateRuntime(seams, () => bound), now: () => Date.now(), createName: mintSubordinateName,
        afterTurn: (child, work) => {
          this.detachOwned(Effect.promise(async () => {
            await this.agentTurnSettled(child);
            await this.actorHost().run(child, () => Promise.resolve());
            await work();
          }));
        },
      });
    });
  }

  protected getTeamToolDeps(): TeamToolDeps {
    return createTeamToolDeps({
      delegation: this.delegationBudget(),
      roster: this.subordinateRoster,
      runtime: this.subordinateRuntime(),
      temporary: this.temporaryAgentPort(),
      now: () => Date.now(),
      inheritedContext: () => this.readInheritedContext(),
      originContext: () => this.turnOriginContext(),
      ownMission: () => this.ownMission(),
      createName: mintSubordinateName,
      rosterMoved: () => { this.liveReadsMoved(ROSTER_READS); },
      broadcastTask: (event) => this.broadcastSubordinateEvent({
        kind: 'task',
        ...event,
      }),
    });
  }

  /**
   * Called by a child after it wrote its naming state; only names the roster's reads.
   * Must not call the child back (it is mid-turn). Not `@callable`: stub possession authorizes.
   */
  async recordSubordinateTitle(
    name: string,
    displayName: string,
  ): Promise<{ ok: true }> {
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
  getSubordinateBootstrapIdentity(input: { name: string; reference: ActorReference }): Promise<{
    parentWorkspace: string;
    ownerUserId: string;
    model: string | null;
    depth: number | null;
    origin: ActorDirectoryResult['origin'];
    lifetime: ActorDirectoryResult['lifetime'];
    name: string;
    storageKey: string;
    creationId: string;
  } | Refusal> {
    return settle(Effect.gen({ self: this }, function* () {
      return yield* Effect.catchCause(Effect.gen({ self: this }, function* () {
        const child = yield* Effect.promise(async () => this.actorDirectory({ action: 'validate', name: input.name, reference: input.reference }));
        const ownerUserId = this.getOwnerUserId();

        if (!ownerUserId) return yield* new KinuError('missing', 'The workspace has no owner.');
        let depth: number | null = null;

        if (isSubordinateOrigin(child.origin)) {
          const own = this.delegationBudget();

          if (delegationExhausted(own)) return yield* new KinuError('denied', 'The parent cannot create a subordinate below its delegation depth.');
          depth = deriveChildDelegationBudget(own).depth;
        }

        return {
          parentWorkspace: this.workspaceName(), ownerUserId, model: this.config.getModel(),
          depth, origin: child.origin, lifetime: child.lifetime, name: child.name, storageKey: child.storageKey, creationId: child.creationId,
        };
      }), refusing('reading a registered child bootstrap', 'io'));
    }));
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

    return receiveSubordinateEvent({
      log: this.eventLog,
      roster: this.subordinateRoster,
      vfs: this.rt.storage.vfs,
      transaction: (body) => this.ctx.storage.transactionSync(body),
      announce: (report) => {
        this.liveReadsMoved(ROSTER_READS);
        this.broadcastSubordinateEvent({ ...report, kind: 'report' });
      },
      onAdmitted: () => { this.orch.scheduleDrain(); },
      evolutionAnswerStored: () => this.advice.owe(this.actorHandle().actorId),
      onEvolutionAnswer: () => { this.durableWakeOwner()?.(); },
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
    reportModelCall: (report) => { this.reportModelCall(report); },
    currentTurn: (reference) => this.currentTurnOf(reference),
  });

  // The bare prototype must read as sound.
  protected storageRefusal?: StoragePredatesResetError;

  /** Kinu's two durable wakes; see wake-jobs.ts. */
  protected readonly wakes = new WakeJobs({
    [KINU_TIMER_JOB]: () => this._kinuTimerTick(),
    [TERMINAL_RETRY_JOB]: (pace) => this.terminalRetryPass(pace),
  });

  /** An advisor answer's delivery; see advice-jobs.ts. */
  protected readonly advice = new AdviceJobs((actorId) => this.deliverAdviceFor(actorId));

  /** The workspace timer's pass: every source a subclass folds into its next wake. */
  abstract _kinuTimerTick(): Promise<void>;

  /** This actor's held advisor answers; a subclass hosting other actors routes theirs. */
  protected deliverAdviceFor(actorId: string): Promise<boolean> {
    return actorId === this.actorHandle().actorId ? this.actorSession.deliverAdvisorAnswers() : Promise.resolve(true);
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.wakes);
    this.lifecycle.use(this.advice);
    // Must precede any read or write of it; see initCapabilitySchema.
    this.initCapabilitySchema();
    // A Durable Object is a DIFFERENT ISOLATE from the Worker that routes to it,
    // with its own module-level state — so the diagnostics sink installed at the
    // Worker's fetch entry does not exist in here, and every `diagnostics` line
    // an actor produces would reach Workers Logs and no dataset. Installed in the
    // constructor because that is the one point guaranteed to precede every RPC
    // (`onStart` is not — see `OrchestratorAgent.claimOwner`), and idempotent per
    // isolate, so a re-activation costs nothing.
    // The workspace comes from the invocation, not the isolate: `setDiagnosticsSink` is module-global
    // and Cloudflare co-locates Durable Objects, so an install-time default would attribute every
    // co-located actor to the first. The SDK's per-invocation context names the running agent.
    installAnalyticsDiagnostics(this.env, { workspace: ctx.id.name ?? '' });
    attributeWorkspace(ActorAgent.invocationWorkspace);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PAGE_KEEPALIVE.ping, PAGE_KEEPALIVE.pong));
  }

  /**
   * Total only while every subclass fixes its name at construction or refuses to exist, as
   * OrchestratorAgent does; one that does not brings PartyServer's throwing `name` into the logger.
   */
  private static invocationWorkspace(this: void): string {
    const { agent } = getCurrentAgent();

    return agent instanceof ActorAgent ? agent.workspaceName() : '';
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

      const rpc = rpcFrameOf(message);
      const refusal = rpc === null ? null : this.clientRpcRefusal(connection, rpc);

      if (rpc && refusal !== null) {
        connection.send(JSON.stringify({ type: 'rpc', id: rpc.id, success: false, error: refusal }));

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

      await dispatchMessage(connection, message);

      if (rpc !== null && rpcMovesOverview(rpc.method)) this.overviewChanged();
    };

    const baseOnConnect = this.onConnect.bind(this);
    const baseOnClose = this.onClose.bind(this);

    this.onConnect = async (connection, ctx) => {
      if (await this.refuseRevokedSocketAuthority(connection, '')) return;

      // Before anything reads the store.
      if (this.storageRefusal !== undefined) {
        connection.send(JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: 'storage-refused', reason: this.storageRefusal.code,
          body: this.storageRefusal.message, done: true, error: true,
        }));

        return;
      }

      this.connectionOpened();

      await baseOnConnect(connection, ctx);

      const terminal = await this.terminalFor(connection);

      if (terminal) {
        await terminal.attachTerminal(connection);

        return;
      }

      // Claim frames reach only tabs connected at a change: a root tab away at the settle hears the claim here (#30).
      if (actorFromConnectionTags(connection.tags) === null) sendIfOpen(connection, this.turnClaimFrame());
      await this.chatRoomFor(connection)?.onConnect(connection);
    };

    this.onClose = async (connection, code, reason, wasClean) => {
      if (this.storageRefusal !== undefined) return await baseOnClose(connection, code, reason, wasClean);
      const terminal = await this.terminalFor(connection);

      if (terminal) terminal.terminalClose(connection);
      else this.chatRoomFor(connection)?.onClose(connection);
      await baseOnClose(connection, code, reason, wasClean);

      // Exclude the closing socket's id explicitly; the platform's state for it is not guaranteed.
      for (const other of this.getConnections()) if (other.id !== connection.id) return;

      this.lastConnectionClosed();
    };

    const dispatchRequest = this.onRequest.bind(this);
    const requests = new Hono({ getPath: rawPath });

    requests.use('*', async (_c, next) => (this.storageRefusal === undefined
      ? next()
      : Response.json(refusalOf(this.storageRefusal), { status: ERROR_STATUS[this.storageRefusal.code] })));

    // The seed is fetched on the same path the pane's socket opens, so each pane gets its own actor's rows.
    const seed = async (c: Context): Promise<Response> => {
      const hosted = hostedActorRoute(c.req.path) === null ? null : c.req.header(HOSTED_ACTOR_ID_HEADER) ?? '';
      const history = await (hosted === null ? this.chatTranscript.history() : this.hostedChatWire(hosted)?.history());

      if (history === undefined) return Response.json({ reason: 'missing', error: 'The actor is not hosted here.' }, { status: 404 });

      return Response.json(history);
    };

    requests.all('/get-messages', seed);
    requests.all('/:prefix{.*}/get-messages', seed);
    requests.notFound(async (c) => dispatchRequest(c.req.raw));
    requests.onError(rethrow);

    this.onRequest = async (request) => requests.fetch(request);
  }
  /** Lazy: `actorHandle()` resolves the directory row the constructor creates, after field init. */
  private _pendingSends: PendingSendStore | null = null;
  private get pendingSends(): PendingSendStore {
    return this._pendingSends ??= new PendingSendStore(this.boundSql, this.actorHandle().actorId);
  }

  /** True when an open turn or undrained acknowledged send exists; the loop is then built under
   *  a wake, never inside the init gate, because a turn is external work. */
  protected chatLoopOwesWork(): boolean {
    return this.eventRecorder.openRun() !== null || this.pendingSends.restore().length > 0;
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
      ...chatTerminalEffects({ chat: () => this.chatLoop, orchestrator: this.orch, engine: this.engine }),
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
      improvement_lanes: terminalEffect({
        input: v.object({ status: RunEndReasonSchema, turn: JsonValueSchema, workMode: WorkModeSchema }),
        // Lanes read durable queues on re-entry (per-turn snapshots do not survive), and the verdict
        // uses the recorded mode so a fresh activation's default cannot open an unearned lane.
        runSync: ({ status, workMode }) => {
          this.warmUserMcpInBackground();

          if (!this.orch.improvementLanesOpen(status, workMode)) {
            return { status: 'completed', detail: 'improvement lanes closed for this turn' };
          }

          this.settleEvolutionInBackground();

          return { status: 'completed' };
        },
      }),

      // The snapshot is the row's input, so a replay hires on the tool surface the turn had; the hire is
      // keyed on the turn, so a replay hires no second advisor.
      advisor_review: terminalEffect({
        input: v.object({ status: RunEndReasonSchema, workMode: WorkModeSchema, advisor: AdvisorRecoverySnapshotSchema }),
        run: async ({ status, workMode, advisor }) => {
          if (this.orch.improvementLanesOpen(status, workMode)) await this.actorSession.hireAdvisor(advisor);

          return { status: 'completed' };
        },
      }),
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
      settled: () => this.restWhenIdle(),
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

  /** Set by the last maintenance pass. */
  protected maintenanceUnfinished = false;

  /** Nothing owed: a turn's arm goes. */
  private async restWhenIdle(): Promise<void> {
    if (this._chatLoop?.pumping !== true && !this.owedWorkExists()) await this.wakes.cancel(TERMINAL_RETRY_JOB);
  }

  /** One soonest-wins wake per actor. */
  protected scheduleTerminalRetry(atMs: number, pace?: WakePace): Promise<void> {
    return this.wakes.arm(TERMINAL_RETRY_JOB, atMs, pace);
  }

  /** `prior`: the firing job's streak. */
  async terminalRetryPass(prior: WakePace = { laps: 0, arms: null }): Promise<void> {
    // Arm first, drain second: the next-lap wake is durable before any pass runs, so a kill
    // inside this frame leaves a future row. A tick that finds nothing owed releases it at the end.
    const lapAt = Date.now() + recoveryBackoffMs(prior.laps + 1);
    await this.scheduleTerminalRetry(lapAt, { laps: prior.laps + 1, arms: prior.arms });

    // Owed deliveries run every tick; unfinished maintenance re-arms at the shared capped backoff,
    // so a pass that keeps answering unfinished settles at the ceiling, not a one-second loop.
    const sweepsUnfinished = this.maintenanceSweeps();
    const recoveryUnfinished = await this.maintenanceWork();
    this.maintenanceUnfinished = sweepsUnfinished || recoveryUnfinished;
    await this.owedDeliveryWork();
    // Re-entered here because `maintenanceWork` is activation-scoped: later ticks in a warm
    // isolate never reach the job sweep, and a deferred job's wake would find nothing to recover.
    await this.jobRunner.recoverDueResumes();

    // Untimed owed work names no instant, so the lap-paced row is kept (a missing row sleeps until
    // an external event). Only timed work: arm at its instant, soonest-wins. Nothing owed: sleep.
    const nextOwed = this.nextOwedAt();

    const arms = { sweeps: sweepsUnfinished, recovery: recoveryUnfinished, ...this.owedUntimedArms() };
    const named = Object.entries(arms).filter(([, owed]) => owed).map(([arm]) => arm).join(',');

    if (named !== '') {
      if (named !== prior.arms) diagnostics.event('wake.unfinished_arms', { ...arms, workspace: this.name, source: named });

      await this.scheduleTerminalRetry(lapAt, { laps: prior.laps + 1, arms: named });

      if (nextOwed !== null) await this.scheduleTerminalRetry(nextOwed);
    } else {
      await this.wakes.cancel(TERMINAL_RETRY_JOB);

      if (nextOwed !== null) await this.scheduleTerminalRetry(nextOwed, { laps: 0, arms: null });
    }

    // A turn a deploy cut short reads right by the next tick of the wake it armed.
    this.overviewChanged();
  }

  /**
   * Runs every tick regardless of maintenance's answer, so owed replies never queue behind a sweep.
   * Subclasses prepend extra owed lanes here so all ride one durable wake.
   */
  protected async owedDeliveryWork(): Promise<void> {
    await this.terminal.replayOwedAndRearm();
  }

  protected owedWorkExists(): boolean {
    return this.maintenanceUnfinished || this.owedUntimedWork() || this.nextOwedAt() !== null;
  }

  /** While true, the tick keeps its lap-paced row. Base owns no rosters; subclasses override. */
  protected owedUntimedWork(): boolean {
    return Object.values(this.owedUntimedArms()).some(Boolean);
  }

  protected owedUntimedArms(): UntimedArms {
    return {};
  }

  /** Earliest timed obligation instant, or null when only untimed work (or nothing) remains.
   *  Subclasses that own the ledgers override. */
  protected nextOwedAt(): number | null {
    return null;
  }

  /** Test-only deterministic cut point in the terminal sequence. Null in production. */
  protected terminalEffectFault: TerminalEffectFault | null = null;

  protected currentTurnOf(reference: ActorReference): string | null {
    return sameActorReference(reference, actorReferenceOf(this.actorHandle()))
      ? this.actorSession.currentTurnId
      : this.actorHost().hosted(reference)?.session.currentTurnId ?? null;
  }

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
  protected _terminalReported: Promise<Exit.Exit<void>> = Promise.resolve(Exit.void);
  private _terminalReportedOwner: AsyncTaskOwner | null = null;

  /** A settled turn's detached leftovers are still closing in this isolate. */
  protected get terminalClosing(): boolean {
    return this._terminalReportedOwner !== null;
  }

  /**
   * Keep this isolate alive for a terminal close via a durable fiber, since a bare promise is not a
   * wake; the fiber's run row hands leftovers to {@link classifyRecoveredFiber}. Order: hold, join, dispose.
   */
  protected holdTerminalClose(transition: TerminalTransition, close: () => Promise<void>): void {
    const prior = this._terminalReported;
    const owner: AsyncTaskOwner = { promise: null };
    this._terminalReportedOwner = owner;

    const task = hold(Effect.ensuring(Effect.catchCause(Effect.gen({ self: this }, function* () {
      // Chain closes so the latest owner retains every earlier close instead of overwriting a live fiber.
      yield* (yield* Effect.promise(() => prior));
      yield* Effect.promise(() => this.runFiber(TERMINAL_LANE_FIBER, async (ctx) => {
        ctx.stash({ lane: TERMINAL_LANE_FIBER });
        await close();
      }));
    }), (failed) => Effect.promise(() => this.terminal.closeFailed(transition, { cause: Cause.squash(failed) }))), Effect.sync(() => {
      // An eviction needs no cleanup; a rejection that leaves this isolate alive does (above).
      if (this._terminalReportedOwner === owner) {
        this._terminalReportedOwner = null;
        this._terminalReported = Promise.resolve(Exit.void);
      }

      this.overviewChanged();
    })));

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

    return pricing ? priceCall(usage, pricing) : undefined;
  }

  /** Lazy: resolves this actor's handle, whose directory row the subclass constructor creates after
   *  this field initializes. */
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
      model: () => this.effectiveModelSpec(),
      attachments: { files: () => this.rt },
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
    const actorId = ctx.request.headers.get(HOSTED_ACTOR_ID_HEADER);
    const actorTag = actorId === null || hostedActorRoute(new URL(ctx.request.url).pathname) === null ? null : actorConnectionTag(actorId);

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
    const rpc = rpcFrameOf(message);

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
      workspace: this.workspaceName(),
      events: this.stores.eventRecorder,
      recording: this.stores.eventRecorder,
      orchestration: this.orchestrationDeps(),
      advisorPort: () => this.temporaryAgentPort(),
      // While the completion gate waits for its answer, the advisor records its note silently.
      gateOpen: () => this._chatLoop?.completionGate.open ?? false,
      turns: () => this.tracing.turns({ id: this.actorHandle().actorId, kind: 'main' }),
    });

    return this._actorSession;
  }

  private _chatLoop: ChatSession | null = null;
  /** A read never builds the chat to ask. */
  protected get chatTurnOwed(): boolean { return this._chatLoop?.turnOwed ?? false; }
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
          prepareTurn: (item, lease, opening) => this.prepareTurn(item, lease, opening),
          composeRequest: () => this.composeNextRequest(),
          owedTerminalEffects: (input) => this.owedTerminalEffects(input),
          answerMetadata: (turnId, texts) => this.answerMetadata(turnId, texts),
          terminal: () => this.terminal,
          taskList: () => this.stores.taskList,
          // A running job's settle wakes the session; a reminder fired behind it would race that wake.
          hasPendingAsyncWake: () => this.stores.jobs.listRunning(1).total > 0,
          holdTerminalClose: (transition, close) => { this.holdTerminalClose(transition, close); },
          driverGate: () => this.driverGate(),
          // The workspace UI IS the review surface: a plan turn is admitted.
          planTurnRefusal: () => null,
          stillOwed: (metadata) => planHandoffStillOwed(metadata, this.stores.planReviews),
          // Prompt-cache warming belongs to the root actor (it owns the wake chain); hosted actors wire none.
          ...(this.cacheWarmingLane() && { cacheWarming: this.cacheWarmingLane() }),
          // Arm the turn's own wake at its open, so a kill mid-turn leaves both the run row and the wake
          // that re-drives what it owed.
          armTurnWake: async (atMs) => { await this.scheduleTerminalRetry(atMs); },
          owed: () => { this.liveReadsMoved(['listWorkspaceAgents']); },
          quiet: () => {
            this.liveReadsMoved(['listWorkspaceAgents']);
            this.chatTransport.quiet();
            this.overviewChanged();
            this.detachOwned(Effect.promise(() => this.restWhenIdle()));
          },
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
      turnOwed: () => this.chatLoopOwesWork(),
      steps: () => {
        const run = this.eventRecorder.openRun();

        return run === null ? [] : this.eventRecorder.finishedSteps(run).map(({ messages }) => drawnStep(messages));
      },
      broadcast: (message, exclude) => { this.broadcastToActor(null, message, exclude); },
      getConnection: (id) => this.getConnection(id),
      history: (limit) => this.chatTranscript.history(limit),
      admitted: async (id) => this.admittedSend(id),
      send: (input) => this.chatLoop.send({ text: input.text, files: input.files }, { id: input.id, mode: input.mode }),
      retry: (claim) => this.chatLoop.retry(claim),
      interrupt: () => {
        this.chatLoop.interrupt();
        this.stopSubtree(this.actorHandle().actorId);
      },
      clear: () => this.clearConversation(),
    });

    return this._chatTransport;
  }

  /**
   * One actor's windows; `null` is the workspace's, which alone get the root's own frames, while one every window may
   * read (device consents, device availability) goes to all. Built on `broadcast`, the only send that reaches hibernated sockets.
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
    return this._chatRooms ??= new ActorChatRooms(() => this.chatTransport, (actorId) => this.hostedChatWire(actorId));
  }

  /** Null when the addressed actor is no longer hosted here. */
  protected chatRoomFor(connection: Connection): ChatWireTransport | null {
    return this.chatRooms.for(actorFromConnectionTags(connection.tags));
  }

  /** Null when this workspace hosts no such actor; only the workspace root knows its directory. */
  protected abstract hostedChatWire(actorId: string): ChatWire | null;

  protected abstract hostedWindowName(actorId: string): string | null;

  /** Fires for any actor's connection; the root's sleep-time closed-tab trigger overrides both hooks. */
  protected connectionOpened(): void {}

  /** Fires once per emptying, in the close hook, after the room has been told. */
  protected lastConnectionClosed(): void {}

  /** Fires after each committed change to the root actor's turn claims. */
  protected abstract turnClaimChanged(): void;

  /** The root actor's turn claim as it stands, as the frame its tabs hear on connecting and on each change. */
  protected abstract turnClaimFrame(): string;

  protected abstract overviewChanged(): void;

  protected abstract liveReadsMoved(reads: readonly LiveRead[]): void;

  protected get orch(): AgentOrchestrator { return this.actorSession.orchestrator; }

  protected abstract owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[];

  protected answerMetadata(_turnId: string, _texts: () => Promise<readonly string[]>): Promise<JsonObject | null> {
    return Promise.resolve(null);
  }

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

            const runId = this._currentRunId;

            if (runId) this.eventRecorder.emit(runId, { type: 'tool_call_end', ...ev });
          },
          onStepEvent: (ev) => {
            const runId = this._currentRunId;

            if (runId) this.eventRecorder.emit(runId, { type: 'step_finish', ...ev });
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
        this.emitRunEvent({ type: 'budget_exhausted', ...refusal });
      },
    });

    return this._budget;
  }

  /** A run event for the turn in flight; a failed write is logged, never thrown into the turn. */
  private emitRunEvent(event: Extract<RunEventInput, { type: keyof typeof RUN_EVENT_EMIT_FAILED }>): void {
    settleLoggedSync(RUN_EVENT_EMIT_FAILED[event.type], { doing: `recording a ${event.type} run event`, otherwise: 'io' }, () => {
      if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, event);
    });
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
    labels: readonly string[]; calls?: number; spawns?: number; usage?: Usage; spec?: string;
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

  async headJournalCacheMerge(rootId: HeadId, narrative: string): Promise<void> {
    this.headJournal.cacheMerge(rootId, narrative);
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
    owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.promise(() => this.runFiber(EVOLUTION_LANE_FIBER, async (ctx) => {
      ctx.stash({ lane: EVOLUTION_LANE_FIBER });
      await this.orch.settleEvolution();
      await this.orch.runDueSessionEvolution();
    })), recording({ doing: 'settling the turn and session evolution lanes', otherwise: 'unavailable' }, (failure) => {
      diagnostics.failure('evolution.settle_failed', failure);
    })), Effect.sync(() => {
      if (this._evolutionSettling === owner) this._evolutionSettling = null;
    })));
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
    owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.promise(() => this.runFiber(MCP_WARM_LANE_FIBER, async (ctx) => {
      ctx.stash({ lane: MCP_WARM_LANE_FIBER });

      // Same gate as `buildUserMcpTools`: no capability token yet is an ordinary state, not a failure.
      // Checked rather than caught so real read failures still propagate.
      if (!this.workspaceCapabilityToken()) return;
      const { stub, caller } = await this.userHub();
      await stub.userMcp_warmConnections(caller);
    })), recording({ doing: 'establishing the user MCP connections after a settled turn', otherwise: 'unavailable' }, (failure) => {
      diagnostics.failure('mcp.settle_warmup_failed', failure);
    })), Effect.sync(() => {
      if (this._mcpWarmTask === owner) this._mcpWarmTask = null;
    })));
  }

  /** The advisor's input, recorded while the turn is in memory so a cold re-drive reviews the same
   *  tool surface. `reachable` is the turn's own ToolSet keys as reported at the settle. */
  protected advisorSnapshotFor(turn: CompletedTurn, reachable: readonly string[]): AdvisorRecoverySnapshot {
    return {
      turn,
      reachable: [...reachable],
    };
  }

  /** This actor's ports and models for core's scaffold control plane (evolution/control.ts). */
  protected get scaffoldControl(): ScaffoldControl {
    return {
      rt: this.rt,
      events: this.eventRecorder,
      sql: this.boundSql,
      history: this.stores.history,
      surface: (task, context, callScope) => createScaffoldCandidateSurface({
        ...this.scaffoldCandidateModel(),
        tools: () => this.getRawToolsForWorkMode(this.turnWorkMode(), callScope),
        callScope,
        history: this.makeScaffoldHistory(),
        spend: this.scaffoldSpend(),
      }, task, context),
      // `scaffold` is a fixed tier in MODEL_ROUTE_POLICY, not the turn's model.
      model: async () => (await this.modelForSource('scaffold')).model,
      judge: createJsonJudge(
        () => this.getModelForReview(), (report) => this.reportModelCall(report), this.modelOperations,
      ),
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

  private scaffoldCandidateModel(): Pick<ScaffoldCandidateBinding, 'rt' | 'profile' | 'bindModel' | 'modelContext' | 'compose'> {
    return {
      rt: this.rt,
      compose: () => this.composeNextRequest(),
      profile: async () => {
        const mode = await this.preparedWorkMode();

        return this.routingProfile([...Object.keys(this.getRawToolsForWorkMode(mode)), ...codemodeCapabilitiesFor(this.turnCodemodeProviders())], mode);
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
  protected readonly _drainTimerTasks = new Map<string, AsyncTaskOwner>();
  protected get host(): BackendHost {
    if (!this._host) {
      const armWake = this.durableWakeOwner();
      this._host = {
        broadcast: (event) => this.broadcast(JSON.stringify(event)),
        enqueueTurn: (input) => this.chatLoop.enqueueTurn(input),
        // Synchronous read plus same-tick buffer push means the observed turn's prepareStep drains
        // the signal; a turn that settles first re-delivers it from settle().
        turnInFlight: () => this.chatLoop.turnInFlight(),
        closed: () => this.chatLoop.closed,
        // keepAliveWhile holds the DO through the debounce window and drain; if it dies anyway,
        // events stay durable in the EventLog and a later drain picks them up.
        setTimer: (fn, ms) => {
          const timerKey = nanoid();
          const owner: AsyncTaskOwner = { promise: null };
          this._drainTimerTasks.set(timerKey, owner);
          owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.promise(() => this.keepAliveWhile(async () => {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            });

            await settleLogged('drain.timer_callback_failed', { doing: 'running the debounced event drain', otherwise: 'io' }, () => fn());
          })), recording({ doing: 'holding the actor alive across the drain debounce window', otherwise: 'io' }, (failure) => {
            diagnostics.failure('drain.timer_keepalive_failed', failure);
          })), Effect.sync(() => {
            if (this._drainTimerTasks.get(timerKey) === owner) {
              this._drainTimerTasks.delete(timerKey);
            }
          })));
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
  protected _cachedTools: ActorToolsets | null = null;
  protected _cachedToolsKey = "";
  // Cached against the content hash of UserDO's MCP descriptor surface, so closures rebuild
  // exactly when the durable rows differ from what this activation last served.
  private _mcpToolsCache: McpToolSurfaceCache<ToolSet> | null = null;
  /** Rendered into the turn's dynamic context so missing MCP servers are legible. */
  private _mcpUnavailable: MissingCapability[] = [];

  private noteGitHubCall(descriptor: Pick<SerializableToolDescriptor, 'presetId' | 'name'>, args: JsonObject, result: string, actorId: string | null): void {
    if (descriptor.presetId !== GITHUB_MCP_PRESET) return;
    recordGitHubActivity(this.boundSql, recognizeGitHubMcp(descriptor.name, args, result), { actorId, source: 'mcp', at: Date.now() });
  }

  private get mcpToolsCache(): McpToolSurfaceCache<ToolSet> {
    this._mcpToolsCache ??= new McpToolSurfaceCache<ToolSet>(async (descriptors) =>
      // `buildMcpToolSet` puts every non-readOnly tool behind the same durable claim as natives,
      // using ambient turn deps because this cache is shared across turns (KINU-019).
      buildMcpToolSet(descriptors, {
        call: async (d, args, options) => {
          const rawResult = await callUserMcpTool({ stub: this.requireOwnerUserDO(), caller: await this.userCaller() }, d, args, options.abortSignal);

          this.noteGitHubCall(d, args, rawResult, this.actorHandle().actorId);

          const response = v.parse(JsonValueSchema, JSON.parse(rawResult));

          if (v.is(McpProtocolFailureSchema, response)) throw new McpToolError(response);

          return response;
        },
        effectClaims: {
          actor: this.actorHandle(),
          sql: this.rt.storage.sql,
          turnId: () => currentOperationProfile(this.actorHandle())?.turnId ?? this._chatLoop?.currentTurnId ?? WORKSPACE_RUN_ID,
          durable: (callId, signal) => this.actorSession.durableCall(callId, signal),
        },
        clamp: {
          files: this.rt.storage, budget: this.acc.context, producer: 'external_tool',
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
      vfs: nimbusSessionFiles(this.workspaceBox(this.shellId()), { home: WORKSPACE_ROOT, cred: CRED_SESSION_USER }),
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

    if (!isSteerBranchRunId(rootId)) this.broadcastMctsProgress(rootId);
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
      claims.observeRecovered((claim) => {
        this.tracing.turns({ id: this.actorHandle().actorId, kind: 'main' }).recovered(claim, claim.outcome);
      });
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

    settleLoggedSync('event.model_call_emit_failed', { doing: 'recording a model_call run event', otherwise: 'io' }, () => {
      this.eventRecorder.emit(currentOperationProfile(this.actorHandle())?.runId ?? (this._currentRunId || WORKSPACE_RUN_ID), event);
    }, { source: report.source });

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

    settleLoggedSync('event.provider_wait_emit_failed', { doing: 'recording a provider_wait run event', otherwise: 'io' }, () => {
      this.eventRecorder.emit(runId, {
        type: 'provider_wait',
        provider: info.provider,
        waitMs: info.waitMs,
        attempt: info.attempt,
        source: info.source,
        ...(info.modelId !== undefined && { modelId: info.modelId }),
        ...(info.status !== undefined && { status: info.status }),
      });
    }, { provider: info.provider });

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
    this._eventLog ??= new EventLog(this.watchedExec, this.actorHandle());

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
  broadcastMctsProgress(rootId: string): void {
    return settleSync(Effect.catchCause(Effect.sync(() => {
      const nodes = readSearchTree(this.boundSql, this.actorHandle(), rootId);
      const head = this.headJournal.readRun(rootId);

      if (nodes.length === 0 && head === null) return;
      const fingerprint = JSON.stringify([nodes, head]);

      if (fingerprint === this._lastMctsFingerprint.get(rootId)) return;
      this._lastMctsFingerprint.set(rootId, fingerprint);
      const pushSeq = (this._mctsPushSeq.get(rootId) ?? 0) + 1;
      this._mctsPushSeq.set(rootId, pushSeq);
      this.broadcast(JSON.stringify({
        type: 'mcts-progress', rootId, isolateGen: this.isolateGeneration, pushSeq, nodes, head,
      }));
    }), recording({ doing: 'pushing a swarm search tree to connected surfaces', otherwise: 'io' }, (failure) => {
      diagnostics.failure('mcts.progress_broadcast_failed', failure, { rootId });
    })));
  }

  /** Per activation: a reconnecting client is served by the surface's poll, not a resend. */
  private readonly _lastMctsFingerprint = new Map<string, string>();

  private readonly _mctsPushSeq = new Map<string, number>();

  // Background-job lifecycle (detach, settle, wake, cancel, evict-recovery) over the durable fiber
  // and the programmatic-turn wake. Owns the cancel-controller map.
  private _jobRunner: BackgroundJobRunner | null = null;
  protected get jobRunner(): BackgroundJobRunner {
    this._jobRunner ??= this.actorJobRunner(null, {
      store: this.jobs,
      // Foreground half depends on the surface (30s for chat). Wake half never varies: DO alarms deliver
      // wakes with nobody connected, so spawn-shaped work detaches on unwatched turns too.
      policy: () => invocationBackgroundPolicy(this.turnSurface(), true),
      fiber: (name, fn) => this.rt.schedule.fiber(name, fn),
      inbox: this.orch.inbox,
      eventLog: this.eventLog,
      scheduleDrain: () => this.orch.scheduleDrain(),

      // Notify the owner (email on the orchestrator; skips silently when pieces are absent).
      notifySettled: (job) => {
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

  /** The clock job runners detach on. */
  protected jobClock(): Clock {
    return REAL_CLOCK;
  }

  private _jobAuthorities: WorkspaceJobAuthorities | null = null;

  protected get jobAuthorities(): WorkspaceJobAuthorities {
    this._jobAuthorities ??= new WorkspaceJobAuthorities({
      root: () => ({ kind: 'root', actorId: this.actorHandle().actorId, store: this.jobs, runner: this.jobRunner }),
      revive: (actorId) => this.reviveJobAuthority(actorId),
    });

    return this._jobAuthorities;
  }

  protected reviveJobAuthority(_actorId: string): JobAuthority | null {
    return null;
  }

  /** Re-drives a recovered job fiber. */
  protected workspaceJobs(): FiberLaneTransports['jobs'] {
    return this.jobAuthorities;
  }

  /** Every actor's runner; null addresses the root's sockets. */
  protected actorJobRunner(owner: string | null, actor: ActorJobSeams): BackgroundJobRunner {
    const { notifySettled, ...own } = actor;

    return new BackgroundJobRunner({
      ...own,
      ...this.workspaceJobPorts(owner),
      logActivity: (event, detail) => this.logActivity(event, detail),
      onSettled: (job) => {
        notifySettled?.(job);
        this.detachOwned(Effect.promise(() => this.servingMoved()));
      },
    } satisfies BackgroundJobRunnerDeps);
  }

  /** Output goes to its owner's sockets. */
  protected workspaceJobPorts(owner: string | null): WorkspaceJobPorts {
    return {
      clock: this.jobClock(),
      jobOutput: (frame) => { this.broadcastToActor(owner, JSON.stringify(frame)); },
      // Only this request's device work moves; parallel foreground commands remain stoppable.
      onDetached: (jobId, requestIds) => {
        this.detachOwned(Effect.promise(() => this.servingMoved()));

        return this.transferDeviceRequests(jobId, requestIds);
      },
      // A refused device cancel leaves the job running and retryable.
      onCancelled: (jobId) => this.cancelBackgroundDeviceRequests(jobId),
      onSettled: () => { this.detachOwned(Effect.promise(() => this.servingMoved())); },
    };
  }

  /** Even a partial transfer refusal keeps the job's device ownership and running state. */
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

  protected readonly boxUse: WorkspaceBoxUse = { used: false };

  /**
   * Records which running job's command holds each exposed sandbox port when that can move (a port exposed or
   * withdrawn, a job detached or settled), so a listing reads a row and never the box. Only a box this activation
   * used is asked, and one that is down is not read: the next exposure reads again.
   */
  protected async servingMoved(): Promise<void> {
    const holders = this._rt?.sandboxPortHolders() ?? null;

    if (holders !== null) await recordServingJobs(this.jobs, holders);
  }
  protected get config(): AgentConfigStore {
    return this.stores.config;
  }

  protected swarmDeps(rt: AgentsSwarmDeps['rt'], model: AgentsSwarmDeps['model'], originContext: NonNullable<AgentsSwarmDeps['originContext']>, compactShared?: AgentsSwarmDeps['compactShared']): AgentsSwarmDeps {
    const seams = this.hostedSeams();

    return {
      rt, model, originContext, compactShared,
      reportModelCall: (report) => { this.reportModelCall(report); },
      nodeCodemode: (actor) => nodeCodemodeTool(seams, actor),
      webSearch: seams.webSearch(),
      resolveModel: (spec) => this.ownedModelServices.resolveModel(spec),
      hostNode: (node) => hostNodeSeat(seams, node),
      provisionNodeHome: () => async (node) => seams.nodeHome((await hostNodeSeat(seams, node)).actor),
      runtimeForNodeWorkspace: null,
      workers: this.liveWorkers,
      reportNodeDelta: () => (frame) => { this.publishHeadStreamFrame(frame); },
      announceHeadActivity: () => (headId) => { this.announceHeadActivity(headId); },
    };
  }

  /** Same shared swarm-deps factory the CLI wires; rebuilt with the toolset (getRawTools). */
  private getAgentsToolDeps(workMode: WorkMode): AgentsToolDeps {
    const actorDeps = this.actorToolDeps();

    const swarm = this.swarmDeps(this.rt, () => this.getModel(), () => this.turnOriginContext(), createSharedPrefixCompactor({
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
      }));

    const deps: AgentsToolDeps = {
      mode: workMode,
      swarm,
      swarms: this._accountSwarms === true,
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

  /** The last profile a turn or a status read resolved. */
  private _settledProfile: ResolvedTurnProfile | null = null;

  /** The profile this actor runs on now: its operation's, else the one its next turn resolves. */
  protected async currentProfile(): Promise<ResolvedTurnProfile> {
    const live = this.operationProfile()?.profile;

    if (live !== undefined) return live;
    const { profile } = await this.actorProfile({ actor: this.actorHandle(), availableTools: [], workMode: 'build' });

    this._settledProfile = profile;

    return profile;
  }

  private runningProfile(): ResolvedTurnProfile | null {
    return this.operationProfile()?.profile ?? this._settledProfile;
  }
  /** Built in beforeTurn; read by the per-step dynamic context. */
  private _turnActiveSkills: ActiveSkillSet | null = null;
  private _turnExternalTools: ToolSet = {};
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
    return this.engine.recordsTurns && this.turnWorkMode() !== 'plan';
  }

  protected readonly extensions = new ExtensionHost();

  protected _cliCwd: string | null = null;
  /** Whether the current turn is a conversational reply or a one-shot task (`kinu exec`); read at
   * turn end to decide if it may be parked awaiting a follow-up verdict. */
  protected _turnContinuity: TurnContinuity = 'conversation';

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

  /** Persisted once per activation; tracing and swarm-progress frames share it so neither advances the other. */
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
      actor: { id: this.actorHandle().actorId, kind: 'main' },
    });

    return this._tracing;
  }

  protected logActivity(event: string, detail?: string) {
    const elapsed = this._turnT0 > 0 ? Math.round(performance.now() - this._turnT0) : 0;

    writeActivityLog(() => ({ sql: this.boundSql, actor: this.actorHandle() }), {
      event, detail: detail ?? null, elapsedMs: elapsed, createdAt: Date.now(),
    });
  }

  protected get rt(): CFRuntime {
    if (!this._rt) {
      const hooks: CFRuntimeHooks = {
        deferrals: () => this.deferralChannel(),
        slate: (operation) => this.slate(operation),
        reportModelCall: (report) => this.reportModelCall(report),
        modelOperations: this.modelOperations,
        liveReadsMoved: (reads) => { this.liveReadsMoved(reads); },
        servingMoved: () => this.servingMoved(),
        boxUse: this.boxUse,
        resolveProfile: () => this.routingProfile(),
        currentTurn: (reference) => this.currentTurnOf(reference),
        refusals: this.tierRefusals,
        contextPlane: {
          actorId: this.actorHandle().actorId,
          own: () => localContextTree(() => ({ claims: this.claims, events: this.stores.eventRecorder }), { author: this.actorHandle().actorId, child: false }),
          children: childContextResolver({
            directory: this.actorDirectoryStore(),
            parent: this.actorHandle(),
            tree: (child, author) => this.agentStores(child.actorId).contextTree({ author, child: true }),
          }),
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
  private dispatchHostedSlateBinding(
    name: string, rest: readonly SlateCallerHop[], route: SlateBindingRoute, mode: WorkMode,
  ): Effect.Effect<JsonValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (rest.length > 0) {
        return yield* new KinuError('denied', 'A binding path names one hosted actor; a nested path names an actor no directory holds.');
      }

      const entry = this.actorDirectoryStore().apply(
        actorReferenceOf(this.actorHandle()), [], { action: 'resolve', name },
      );

      return yield* Effect.promise(async () => this.actorHost().run(entry.reference, async (actor) => {
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

        const surface = hostedActorSurface(actor, this.ownedModelServices.getWebSearchProvider(), this.agentStores(actor.handle.actorId).conversations());
        const providers = providersInWorkMode(mode, surface.providers);
        // Narrow by the child's own durable, per-actor role.
        const reach = slateToolReach(await this.hostedSlateReach(actor, providers, Object.keys(surface.native)));

        if (route.kind === 'tool') return this.callSlateTool({ rt: actor.runtime, native: surface.native, providers, reach, route, mode });

        return await callCodemodeMember(reach.narrowProviders(providers), route.namespace, route.member, route.args) ?? null;
      }));
    });
  }

  /**
   * One capability route, run as this actor, narrowed by its own current role.
   * Not `@callable`: reached on the stub transport only.
   */
  slateBindingDispatch(path: readonly SlateCallerHop[], route: SlateBindingRoute, mode: WorkMode): Promise<JsonValue> {
    return settle(Effect.gen({ self: this }, function* () {
      // Hops resolve hosted actors through the directory, inside this object, so an unreachable
      // name is refused here rather than as a rejected RPC deeper down.
      const [next, ...rest] = path;

      if (next !== undefined) {
        return yield* this.dispatchHostedSlateBinding(next.name, rest, route, mode);
      }

      switch (route.kind) {
        case 'namespace':
        case 'codemode': {
          const providers = providersInWorkMode(mode, this.slateNamespaces());
          const reach = slateToolReach(yield* Effect.promise(async () => this.slateReach(providers)));

          return (yield* Effect.promise(async () => callCodemodeMember(reach.narrowProviders(providers), route.namespace, route.member, route.args))) ?? null;
        }

        case 'tool': {
          const providers = providersInWorkMode(mode, this.slateNamespaces());
          const reach = slateToolReach(yield* Effect.promise(async () => this.slateReach(providers)));

          return yield* Effect.promise(async () => this.callSlateTool({ rt: this.rt, native: this.getRawToolsForWorkMode(mode), providers, reach, route, mode }));
        }

        case 'mcp': {
          // The role admits MCP tools by descriptor key, same as `toolAllowed(d.toolKey)` in native turns.
          const { stub, caller } = yield* Effect.promise(async () => this.userHub());
          const surface = v.parse(McpToolSurfaceSchema, JSON.parse(yield* Effect.promise(async () => stub.userMcp_toolDescriptors(caller))));
          const descriptor = surface.descriptors.find((d) => d.serverId === route.server && d.name === route.tool);

          if (descriptor === undefined) return yield* new KinuError('missing', `${route.server} offers no tool ${route.tool} to this actor`);
          // Enforce `readOnly` grants here so a read grant cannot write through a non-read-only tool.

          if (route.readOnly === true && descriptor.readOnly !== true) {
            return yield* new KinuError('denied', `${descriptor.toolKey} is read-granted to viewers but ${route.server} does not mark it read-only`);
          }

          requireWorkModePermission(mode, descriptor.readOnly === true, descriptor.toolKey);
          const reach = yield* Effect.promise(async () => this.slateReach(this.slateNamespaces(), [descriptor.toolKey]));

          if (!reach.allowsTool(descriptor.toolKey)) return yield* new KinuError('denied', `${descriptor.toolKey} is not within this actor's reach right now`);

          const answered = yield* Effect.promise(async () => callUserMcpTool({ stub, caller }, descriptor, route.args, undefined));

          // A slate calls on its viewer's behalf, not any agent's.
          this.noteGitHubCall(descriptor, route.args, answered, null);

          return v.parse(JsonValueSchema, JSON.parse(answered));
        }

        case 'agent': {
          const metadata: JsonObject = { slate: route.slate };

          if (route.data !== undefined) metadata.data = route.data;

          if (route.viewer !== undefined) metadata.viewer = route.viewer;

          const outcome = yield* Effect.promise(async () => this.slateInbox().send({
            kind: 'slate',
            text: route.viewer === undefined
              ? `Slate ${route.slate}: ${route.text}`
              : `Slate ${route.slate} (viewer ${route.viewer}): ${route.text}`,
            metadata,
          }));

          return { outcome };
        }

        case 'ai': return yield* Effect.promise(async () => this.slateAiRun(route));

        case 'rpc': return yield* Effect.promise(async () => this.slateReadModel(route.method));
        case 'app': return yield* new KinuError('bad_input', 'An app hop is answered by the slate host, not by an actor');
      }
    }));
  }

  /** The one adapter between a slate's `agent` binding and the turn inbox. */
  private slateInbox(): AgentInbox {
    return this.orch.inbox;
  }

  /**
   * One `ai` binding call: resolve the profile as this actor's turn would, run one model call
   * under a `slate` spend row. `actor` is the hosted actor hopped to, or absent for this actor.
   */
  private async slateAiRun(
    route: Extract<SlateBindingRoute, { kind: 'ai' }>,
    actor?: ActorHandle,
  ): Promise<JsonValue> {
    let profile: ResolvedTurnProfile;

    try {
      profile = (await this.actorProfile({
        actor: actor ?? this.actorHandle(), workMode: 'build', availableTools: [], explicitTier: route.tier,
      })).profile;
    } catch (cause) {
      // The resolver reports bad tiers as plain Errors; surface them as bad input.
      if (cause instanceof Error && /invalid explicit tier|unknown tier/.test(cause.message)) {
        throw new KinuError('bad_input', cause.message, { cause });
      }

      throw cause;
    }

    const spec = profile.tier.model;
    const model = this.ownedModelServices.resolveModel(spec);
    const input: GenerateRequest = { model, prompt: route.prompt };

    if (route.system !== undefined) input.system = route.system;

    const answer = await generateReported(input, {
      spend: { source: 'slate', report: (report) => this.reportModelCall(report), operations: this.modelOperations },
      spec,
    });

    const usage = normalizeUsage(answer.usage);

    return v.parse(JsonValueSchema, { text: answer.text, model: spec, tier: profile.tier.id, usage });
  }

  protected codemodeLaunch(actor: string): (online: boolean) => ProgramLaunch {
    const workspace = this.workspaceName();

    return (online) => codemodeLauncher({ kinuNode: true, egress: online ? { workspace, actor } : null });
  }

  private async callSlateTool(input: {
    rt: HostedActor['runtime']; native: ToolSet; providers: CodemodeProvider[];
    reach: ToolSurfaceNarrowing; route: Extract<SlateBindingRoute, { kind: 'tool' }>; mode: WorkMode;
  }): Promise<JsonValue> {
    const { rt, native, providers, reach, route, mode } = input;
    const executorNames = new Set(rt.executionRouter?.getProviders().map((provider) => provider.name) ?? []);

    const factory = createCodemodeToolFactory({
      launch: this.codemodeLaunch(rt.actor.actorId), rt,
      workspace: this.workspaceName(), webSearch: this.ownedModelServices.getWebSearchProvider(), reach,
      browserSessions: this.browserSessionsFor(rt.actor.actorId),
      extraProviders: () => providers.filter((provider) => !executorNames.has(provider.name) && provider.name !== 'web'),
    });

    return await inWorkMode(mode, () => factory.callTool(codemodeSurface(rt, native), route.name, route.input)) ?? null;
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

    const { profile } = await this.actorProfile({
      actor: this.actorHandle(),
      workMode: 'build',
      availableTools: [...actorActiveTools(this.actorToolDeps()), ...mcpToolKeys, ...codemodeCapabilitiesFor(providers)],
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
    const { profile } = await this.actorProfile({
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
        facts: this.facts, actor: this.actorHandle(), conversations: this.ownConversations(),
      })),
      createTasksCodemodeProvider(this.taskList, this.config),
    ];
  }

  /**
   * Single list read by `beforeTurn` (nameable capabilities) and `getCodemodeToolFactory` (narrowing).
   * Providers outside this list cannot be named by a role nor narrowed, so `db` belongs here.
   * The db provider decides Plan per table scope at invocation.
   */
  protected turnCodemodeProviders(): CodemodeProvider[] {
    return [...this.baseCodemodeProviders(), createDbCodemodeProvider(this.stores.appData), ...this.extraCodemodeProviders()];
  }

  /** The Chrome sessions `actorId` opened; the table lives on the workspace object every actor shares. */
  protected browserSessionsFor(actorId: string): BrowserSessions {
    return browserSessions({ db: this.ctx.storage.sql, binding: this.env.BROWSER, actorId });
  }

  /**
   * Namespaces a slate binding may reach: the build-turn sandbox surfaces minus `tools`/`state`.
   * Read per call: executors attach and detach while this object lives.
   */
  protected slateNamespaces(): CodemodeProvider[] {
    return [
      ...(this.rt.executionRouter?.getProviders() ?? []),
      createSlateWebCodemodeProvider(this.ownedModelServices.getWebSearchProvider()),
      createAgentsCodemodeProvider(() => this.getAgentsToolDeps('build')),
      ...this.turnCodemodeProviders(),
    ];
  }

  /** Built once per DO; crafted tools saved mid-turn still work because craftStore is re-read per call. */
  private getCodemodeToolFactory(mode: WorkMode, profileKey: string): CodemodeFactory {
    // The profile digest is part of the key: two roles can share tool names yet reach
    // different namespaces.
    const profile = this.operationProfile()?.profile;
    const narrowing = narrowToolSurface(profile?.allowedTools);
    const key = `${mode === 'plan' ? 'plan' : 'default'}:${profileKey}:${profile?.digest ?? ''}:${String(this._accountSwarms)}`;

    if (!this._codemodeFactories.has(key)) {
      this._codemodeFactories.set(key, createCodemodeToolFactory({
        launch: this.codemodeLaunch(this.rt.actor.actorId),
        rt: this.rt,
        browserSessions: this.browserSessionsFor(this.rt.actor.actorId),
        reach: narrowing,
        workspace: this.workspaceName(),
        webSearch: this.ownedModelServices.getWebSearchProvider(),
        agents: () => this.getAgentsToolDeps(mode),
        // Narrowed by the same set as the native surface, so the sandbox cannot bypass a role.
        extraProviders: () => narrowing.narrowProviders(this.turnCodemodeProviders()),
        // Drives the UI's default executor; one upsert per executor per turn (reset in beforeTurn).
        onExecutorUsed: (name) => {
          if (this._executorsUsedThisTurn.has(name)) return;
          this._executorsUsedThisTurn.add(name);
          this.config.setLastActiveExecutor(name);
        },
      }));
    }

    const factory = this._codemodeFactories.get(key);

    if (factory === undefined) throw new KinuError('io', `eval profile ${key} was not built`);

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

    if (!stub) throw new KinuError('unavailable', 'Agent has no owner yet. Open it through the authenticated app or CLI first.');

    return stub;
  }

  /** Throws when no capability token exists; an unclaimed workspace reaches nothing. */
  protected async userCaller(): Promise<UserCaller> {
    const workspaceToken = this.workspaceCapabilityToken();

    if (!workspaceToken) {
      throw new KinuError('unavailable', 'This workspace has not been issued a capability token yet. Open it through the authenticated app or CLI first.');
    }

    return { workspaceToken };
  }

  protected async userHub(): Promise<{ stub: UserHubClient; caller: UserCaller }> {
    return { stub: this.requireOwnerUserDO(), caller: await this.userCaller() };
  }

  /** `record` lets core emit the `profile_resolution` run event; this backend only picks where it goes. */
  protected async profileInputs(): Promise<ProfileAuthorityInputs> {
    return loadProfileAuthorityInputs({
      envelope: () => this.profileCatalog(),
      provider: () => this.ownedModelServices.profileProviderSnapshot(),
      record: (event) => this.eventRecorder.emit(this._currentRunId || WORKSPACE_RUN_ID, event),
    });
  }

  protected async profileCatalog(): Promise<ProfileCatalogEnvelope> {
    const { stub, caller } = await this.userHub();

    return stub.getWorkspaceProfileCatalog(caller);
  }

  protected resolvedTurnProfile(): ResolvedTurnProfile | null {
    return this.operationProfile()?.profile ?? null;
  }

  /** A fork reaches these through its `parent` executor. No `@callable`: only a worker-held
   * parent stub can reach them. */
  async readWorkspaceFile(path: string): Promise<Uint8Array> {
    return answerParentRpc(path, async () => this.rt.localVfs.readFile(path));
  }

  async writeWorkspaceFile(input: ParentRpcWrite): Promise<null> {
    return answerParentRpc(input.path, async () => {
      if (input.kind === 'file') await this.rt.localVfs.writeFile(input.path, input.data);
      else await this.rt.localVfs.mkdir(input.path, { recursive: input.recursive });

      return null;
    });
  }

  async listWorkspaceFiles(path: string): Promise<VfsDirent[]> {
    return answerParentRpc(path, async () => this.rt.localVfs.readdir(path));
  }

  async statWorkspaceFile(path: string, options?: { follow?: boolean }): Promise<VfsStat | null> {
    return answerParentRpc(path, async () => this.rt.localVfs.stat(path, options));
  }

  async deleteWorkspaceFile(path: string): Promise<null> {
    return answerParentRpc(path, async () => {
      await this.rt.localVfs.unlink(path);

      return null;
    });
  }

  /** Run a command in this workspace's shell for a fork: one round trip instead of one RPC per
   * file through an emulated shell. */
  execWorkspaceCommand(command: string): Promise<ParentExecResult> {
    return answerParentRpc('', () => {
      const shell = this.rt.shell;

      if (!shell) return settle(Effect.fail(new KinuError('unsupported', 'this workspace has no shell')));

      return shell.exec(command);
    });
  }

  /** Null when unset (registry picks the default). */
  protected getStoredModelId(): string | null {
    return this.config.getModel();
  }


  /** Native owner inspection. Does not initialize the SDK or application tables. */
  async inspectSubordinateStorage(request: SubordinateInspectionRequest, authority: SubordinateInspectionAuthority): Promise<SubordinateInspectionResult> {
    // Core authorizes the directory path before resolving its canonical
    // transcript. Payload reads may await VFS; they never acquire an actor.
    return inspectSubordinateStorage({
      sql: this.boundSql, raw: this.ctx.storage.sql,
      actor: this.actorHandle(), directory: this.actorDirectoryStore(),
      transcriptFor: (actor) => this.transcriptFor(actor),
      ownRows: (actor, own) => this.agentStores(actor.actorId).inspect(own),
    }, request, authority);
  }

  /** Every read or write of an agent's own stores goes here (D9). */
  protected abstract agentStores(actorId: string): AgentStoreBroker;

  protected ownConversations(): ConversationRecall {
    return new ConversationSearchStore(this.rt.storage.sql, this.actorHandle(), (sessionId) => this.stores.history.transcript(sessionId));
  }

  /**
   * One page of one chat: the caller's own by default, or the subordinate a pane names by actor id.
   * The root's pane names none and reads this actor's conversation.
   */
  @callable()
  getChatHistoryPage(request: PositionPageRequest & { actor?: string } = {}): Promise<ChatHistoryPage> {
    return settle(Effect.gen({ self: this }, function* () {
      // Strict: a dropped id cursor from an old client re-reads the newest page forever.
      const { actor, ...page } = v.parse(v.strictObject({ ...PositionPageRequestSchema.entries, actor: v.optional(v.string()) }), request);

      if (actor === undefined) return yield* Effect.promise(async () => getChatHistoryPage(this.chatTranscript, page));
      yield* this.requireSubordinateChat(actor);

      return yield* Effect.promise(async () => this.agentStores(actor).historyPage(page));
    }));
  }

  private requireSubordinateChat(actorId: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const directory = this.actorDirectoryStore();
      const record = directory.retained(actorId);

      if (record === null) return yield* new KinuError('missing', 'The actor is not registered in this workspace.');

      for (let step: typeof record | null = record; step?.actorId !== this.actorHandle().actorId; step = directory.retained(step.parentActorId ?? '')) {
        if (step === null || !isSubordinateOrigin(step.origin)) return yield* new KinuError('denied', 'The actor id does not name a chat this workspace hosts.');
      }
    });
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
    const changed = changeRoleAsOwner({ config: this.config, envelope, to: roleId, active: this.activeRoleLabel() });
    this.chatLoop.reviseContext({ counted: true });
    await this.modelSettingsChanged();

    return changed;
  }
  @callable()
  async setModel(spec: string) {
    return setModel(this.modelSetting(this.config, () => {
      this.invalidateModelCaches();
      this.chatLoop.reviseContext({ counted: true });
    }), spec);
  }

  /** How a model pin is set on `config`: this workspace's registry normalizes the spec. */
  protected modelSetting(config: AgentConfigStore, onChanged: () => void): SetModelDeps {
    return { config, normalize: (s) => this.providerRegistry().normalizeSpecSync(s), onChanged };
  }

  /** Held as a row once landed, or as a reservation from acceptance until then. */
  private admittedSend(id: string): boolean {
    return this.chatTranscript.has(id) || this.pendingSends.has(id);
  }

  /** Resolves on admission, not landing; where the words land reaches clients as steer_status
   * under the same id. Unrecognized mode runs as build. */
  @callable()
  send(text: string, id: string, files: readonly PromptFile[] = [], mode?: WorkMode): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const attachments = v.parse(v.array(PromptFileSchema), files);
      const workMode = isWorkMode(mode) ? mode : 'build';
      const window = this.addressedActor();

      if (window !== null) {
        const wire = this.hostedChatWire(window);

        if (wire === null) return yield* new KinuError('missing', `${window} is not an agent of this workspace`);
        yield* Effect.promise(async () => wire.send({ text, files: attachments, id, mode: workMode }));

        return;
      }

      yield* Effect.promise(async () => this.chatLoop.admit({ text, files: attachments }, { id, mode: workMode }));
    }));
  }

  /** Aborts the in-flight LLM request first so stop works even if the cancel frame is lost.
   * Foreground only: detached jobs are stopped via `cancelBackgroundJob`. */
  @callable()
  async cancelCurrentWork(): Promise<CancelWorkOutcome> {
    const window = this.addressedActor();

    if (window !== null) {
      this.hostedChatWire(window)?.interrupt();

      return { ok: true, abortedTools: 0, deviceCommands: [] };
    }

    this.stopSubtree(this.actorHandle().actorId);

    const turnId = this.durableTurnId();

    return await cancelCurrentWork({
      cancelChats: () => { this.chatLoop.stop(); },
      activeToolControllers: this.jobRunner.foreground,
      broadcast: (payload) => { this.broadcastToActor(null, payload); },
      stopDeviceCommands: turnId === null ? undefined : () => settle(Effect.catchCause(Effect.promise(async () => {
        const { stub, caller } = await this.userHub();

        return stub.cancelDeviceRequestsForTurn(caller, turnId);
      }), (failed) => Effect.sync(() => {
        const err = Cause.squash(failed);
        diagnostics.failure('device.turn_cancel_failed', toKinuError({
          doing: "cancelling this turn's device commands", cause: err, otherwise: 'unavailable',
        }), { turnId });

        // Local controllers are already aborted; report the durable device sweep failure explicitly.
        return [{ outcome: 'failed' as const, detail: renderThrownChain({ cause: err }) }];
      }))),
      onCancelled: (outcome) => this.onWorkCancelled(outcome),
    });
  }

  /** Per-root hook after cancellation; whether Stop settles turn state is the root's business. */
  protected onWorkCancelled(_outcome: Omit<CancelWorkOutcome, 'ok'>): void {}

  /** Model for auxiliary calls and compaction. */
  getModel(): LanguageModel {
    this.actorHandle();
    const spec = this.runningProfile()?.tier.model ?? this.getStoredModelId();

    return settleSync(spec === null
      ? Effect.fail(new KinuError('missing', 'this agent has resolved no profile yet and pins no model'))
      : Effect.sync(() => this.ownedModelServices.resolveModel(spec)));
  }

  /** SOUL.md as this turn read it: any agent may have edited it since the last turn. */
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
  protected abstract ownMission(): Promise<string>;

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
   * One `'fast'` literal feeds both the model route and the spend label, so they cannot disagree. Down the
   * fast tier's chain like every fixed-tier call ({@link completeOnRoute}).
   */
  protected async suggestTitle(mission: string): Promise<string | null> {
    return suggestWorkspaceTitle(await this.oneShotOn('fast'), mission);
  }

  protected async oneShotOn(source: 'fast' | 'logo'): Promise<(system: string, prompt: string) => Promise<string>> {
    const route = resolveModelRoute(source, await this.routingProfile());

    return (system, prompt) => completeOnRoute(route, {
      llm: (resolution) => routedLlm((serving) => this.modelForResolution(serving), resolution, {
        report: (report) => this.reportModelCall(report), operations: this.modelOperations,
      }, system),
      credentialOf: (spec) => this.ownedModelServices.credentialFor(spec),
      refusals: this.tierRefusals,
    }, prompt);
  }

  private refusalNotices: TierRefusals | null = null;

  private modelSettingsChanges = 0;

  protected refusalNoticesFor(actor: ActorHandle): TierRefusals {
    return tierRefusals({
      sql: this.boundSql, actor, config: actor.config, now: Date.now, settings: MODEL_SETTINGS, changes: () => this.modelSettingsChanges,
    });
  }

  /** One for the object's life, shared with the runtime's lanes, so what it said is read once. */
  protected get tierRefusals(): TierRefusals {
    this.refusalNotices ??= this.refusalNoticesFor(this.actorHandle());

    return this.refusalNotices;
  }

  /** The owner changed what decides a tier's model or credential: a parked refusal may answer differently. */
  protected async modelSettingsChanged(): Promise<void> {
    this.modelSettingsChanges += 1;
    this._accountSwarms = null;
    this.invalidateModelCaches();
    await this.terminal.releaseParked();
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
    // Chat view: the turn surface (#173) + operation profile; side-streams use getRawTools(). Starts the turn clock.
    this._turnT0 = performance.now();
    this.actorHandle();

    const tools = this.actorToolsets(this.turnWorkMode()).turn;
    const operation = this.operationProfile();

    return operation ? withOperationProfile(tools, operation) : tools;
  }

  /** Unwrapped tool surface; eval side-streams use it to run tools inline, never auto-backgrounded. */
  protected getRawTools(): ToolSet {
    this.actorHandle();

    return this.getRawToolsForWorkMode(this.turnWorkMode());
  }

  protected getRawToolsForWorkMode(mode: WorkMode, claimScope?: string): ToolSet {
    return this.actorToolsets(mode, claimScope).raw;
  }

  /** One build per mode: the turn surface, and the raw one. */
  protected actorToolsets(mode: WorkMode, claimScope?: string): ActorToolsets {
    const actorDeps = this.actorToolDeps();
    const profileKey = actorActiveTools(actorDeps).join(',');
    // Key includes crafted_tools quality (score filtering depends on recency) and the actor profile,
    // so an owner chat never reuses an assigned turn's upward-reporting surface.
    const cacheKey = `${mode}:${profileKey}:${this.operationProfile()?.profile.digest ?? ''}:${this._craftCacheKey()}:${String(this._accountSwarms)}`;

    // Only the chat surface is cached; a scoped rollout's surface is built once per rollout.
    if (claimScope === undefined && this._cachedTools && cacheKey === this._cachedToolsKey) {
      return this._cachedTools;
    }

    this.logActivity("gettools_rebuilding", `${this._cachedToolsKey} -> ${cacheKey}`);

    try {
      // No registry sync: the eval sandbox reads craftStore.list() fresh at every execute.
      // See docs/CRAFT-ARCHITECTURE.md §3.

      const builtinDeps: Parameters<typeof buildActorTools>[0] = {
        rt: this.rt,
        workMode: mode,
        conversations: this.ownConversations(),
        // `turnId` is a closure because the toolset is cached across turns; it must be the durable
        // message id a recovery replays, not a run id. Rollouts supply their own ({@link
        // makeScaffoldCallTool}).
        effectClaims: {
          actor: this.actorHandle(),
          sql: this.rt.storage.sql,
          turnId: claimScope === undefined
            ? () => currentOperationProfile(this.actorHandle())?.turnId ?? this._chatLoop?.currentTurnId ?? WORKSPACE_RUN_ID
            : () => claimScope,
          durable: (callId, signal) => this.actorSession.durableCall(callId, signal),
        },
        // The sandbox declares the finished native surface, so core builds it last over all other tools.
        codemode: (surface) => this.getCodemodeToolFactory(mode, profileKey).toolFor(surface),
        external: () => this._turnExternalTools,
        // Lives on the accumulator so the cached toolset keeps a stable reference and resets per turn.
        contextBudget: this.acc.context,
        // Same ownership: rides the accumulator so the cached toolset sees the turn's ledger.
        fileLedger: this.acc.files,
        // Turn-scoped like fileLedger; the settle spine writes the durable row.
        escalations: this.acc.escalations,
        // Owner resolution stays lazy per action, so the cached toolset stays valid across claimOwner.
        agents: this.getAgentsToolDeps(mode),
        roleSwitch: agentRoleSwitch(() => this.operationProfile()?.inputs?.envelope ?? null),
        // memory.search uses hybrid retrieval when available; otherwise FTS5-only.
        vectorStore: this.rt.vectorStore,
        facts: this.facts,
        webSearch: this.ownedModelServices.getWebSearchProvider(),
        jobs: { jobRunner: this.jobRunner, backgroundable: BACKGROUNDABLE_TOOLS, mode: () => this.turnWorkMode() },
      };

      if (actorDeps.report) builtinDeps.report = actorDeps.report;

      if (mode === 'plan' && actorDeps.submitPlan) builtinDeps.submitPlan = actorDeps.submitPlan;
      const toolsets = buildActorTools(builtinDeps);

      if (claimScope === undefined) {
        this._cachedTools = toolsets;
        this._cachedToolsKey = cacheKey;
      }

      this.logActivity("gettools_end", `rebuilt: ${Object.keys(toolsets.turn).length} tools`);

      return toolsets;
    } catch (err) {
      diagnostics.failure('tool.surface_build_failed', toKinuError({
        doing: 'assembling the turn tool surface',
        cause: err,
        otherwise: 'io',
      }), { mode });
      throw err;
    }
  }

  /** "Beta: swarms" as the toolset is built; null until read and after a catalog write. */
  private _accountSwarms: boolean | null = null;

  protected async readAccountSwarms(): Promise<boolean> {
    this._accountSwarms ??= await this.currentAccountSwarms();

    return this._accountSwarms;
  }

  protected async currentAccountSwarms(): Promise<boolean> {
    this._accountSwarms = betaSwarms((await this.profileCatalog()).catalog);

    return this._accountSwarms;
  }

  private async turnToolsAndReads(body: JsonObject): Promise<{ tools: ToolSet; reads: TurnReads }> {
    const built = await this.readAccountSwarms();
    const tools = this.getTools();
    const reads = await this.readTurnInputs(tools, body);

    this._accountSwarms = betaSwarms(reads.profileInputs.envelope.catalog);

    return { tools: this._accountSwarms === built ? tools : this.getTools(), reads };
  }

  /** Built lazily once per DO lifetime; heads need the owner for UserDO auth, so undefined without one. */
  private _cfHeadRuntime: HeadRuntime | null = null;
  /** This workspace's running swarm workers and branch heads, each stoppable alone. */
  protected readonly liveWorkers = new LiveWorkers();
  protected getCFHeadRuntime(): HeadRuntime | undefined {
    if (this._cfHeadRuntime) return this._cfHeadRuntime;
    const ownerUserId = this.getOwnerUserId();

    if (!ownerUserId) return undefined;

    const grounding: HeadGrounding = this.rt.judgeModel
      ? { executor: this.rt.executor, explorer: this.rt.llm, judge: this.rt.judgeModel }
      : { executor: this.rt.executor, explorer: this.rt.llm };

    this._cfHeadRuntime = createHeadRuntime({
      host: this.hostedSeams(),
      workers: this.liveWorkers,
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
   * `hostNodeSeat` (`hosted-actors.ts`) is requested per node: search deps are shallow-copied
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
  private async buildUserMcpTools(nativeTools: ToolSet, catalog: Promise<ModelCatalogRead>): Promise<ToolSet> {
    const userId = this.getOwnerUserId();

    if (!userId) return {};

    // No identity, no user-level tools. Checked rather than caught: userCaller() throws only when no
    // token was issued, and a real read failure must not silently empty the surface.
    if (!this.workspaceCapabilityToken()) return {};
    const caller = await this.userCaller();
    // Read beside the model's resolution; a failed read reaches the failure arm through `refresh`.
    const surface = this.requireOwnerUserDO().userMcp_toolDescriptors(caller);
    const [read] = await Promise.allSettled([catalog, surface]);

    // An unresolved profile fails the turn in `readTurnInputs`.
    if (read.status === 'rejected') return {};

    try {
      // Budget is the resolved model's step context limit minus this actor's own tool definitions, read
      // off the same `ModelCatalogSession` as compaction (`McpSurfaceBudget`).
      const tools = await this.mcpToolsCache.refresh(
        async () => v.parse(McpToolSurfaceSchema, JSON.parse(await surface)),
        {
          ...read.value.window(),
          nativeToolTokens: toolSurfaceTokens(nativeTools),
        },
      );

      this._mcpUnavailable = this.mcpToolsCache.unavailable.map((u) => ({
        source: `MCP server "${u.server}"`, reason: u.reason,
      }));
      this.logActivity('mcp_tools_served', `${Object.keys(tools).length} tools`);

      return tools;
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
      live: () => this.runningProfile()?.tier.model,
      stored: () => this.getStoredModelId(),
      normalize: (spec) => (spec === null ? '' : this.providerRegistry().normalizeSpecSync(spec)),
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
    return this.promptModelContextFor(this.effectiveModelSpec());
  }

  private promptModelContextFor(named: string): PromptModelContext {
    const spec = named === '' ? '' : this.providerRegistry().normalizeSpecSync(named);

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

  /** Cached, non-blocking lookup per spec; static fallbacks answer until it lands. Every hosted actor's spend
   *  is priced off it, so a search's estimate and the ledger read one rate. */
  protected readonly modelCatalog = new ModelCatalogSession({
    effectiveSpec: () => this.effectiveModelSpec(),
    lookup: async (spec) => (spec ? this.catalogEntry(spec) : null),
  });

  protected async catalogEntry(spec: string): Promise<ModelInfo | null> {
    const reg = this.providerRegistry();

    return specModelInfo(reg.registry, reg.deps, spec);
  }

  private readonly hostedModels = new Map<string, string>();

  /** Before the task's first call. */
  protected async priceHostedModel(actor: ActorHandle, spec: string): Promise<void> {
    this.hostedModels.set(actor.actorId, spec);
    await this.modelCatalog.warm([spec]);
  }

  protected hostedModelOf(actor: ActorHandle): string | undefined {
    return this.hostedModels.get(actor.actorId);
  }

  /** Source for `turnWorkMode`, `turnProvenance`, and `turnUserMetadata`. */
  private _turnItem: ChatTurnInput | null = null;

  /** The ChatSession's `prepareTurn` port; the loop has already opened the run row and lease. */
  protected async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease, opening: TurnOpening): Promise<PreparedTurn> {
    this._turnItem = item;
    // Read once per turn: a live trial's arm holds for its whole segment, and the prompt prefix moves only with it.

    const artifacts = turnArtifactBodies(this.rt.storage.sql, this.actorHandle(), {
      ...opening, main: this.actorHandle().parentActorId === null,
    });

    this._turnArtifacts = artifactOverrides(artifacts.bodies);

    // Clear the previous turn's profile before anything reads a mode: `turnWorkMode()` prefers the
    // bound profile, and the tool build below is the first reader.
    this._turnOperation = null;
    // The chat view, not the raw surface: a slow `run` must detach into a background job whose
    // settle wakes a turn, and that wrap lives here.
    const body = item.metadata ?? {};
    const surface = await this.turnToolsAndReads(body);
    const tools = withToolText(surface.tools, this._turnArtifacts.tools);
    const { reads } = surface;
    this._executorsUsedThisTurn.clear();
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
    const history = this.actorSession.history;
    // The revision, not a copy: a context:'inherit' hire reads back the conversation the caller had.
    this._turnOrigin = this.actorSession.turnContext;
    const assembled = await this.assembleTurn({ history, tools, reads });
    this._turnDurableLength = assembled.rawMessages.length;
    // Bound exactly once before execution; the CLI adapter binds it at the same point.
    this.actorSession.bindProfile(lease, assembled.profile, assembled.profileInputs);
    const execution = await this.executionFor(assembled);
    const chat: ActorExecutionInput['chat'] = { ...execution.chat, transformTrigger: assembled.measured.trigger };

    if (assembled.measured.providerReportedTokens !== undefined) {
      chat.providerReportedTokens = assembled.measured.providerReportedTokens;
    }

    return {
      execution: { ...execution, chat },
      sessionKey: this.name,
      contextWindow: assembled.window.contextWindow,
      historyLength: assembled.rawMessages.length,
      trial: artifacts.trial,
    };
  }

  /** The turn's evolved text; between turns, the promoted text. */
  private _turnArtifacts: ReturnType<typeof artifactOverrides> | null = null;

  private turnArtifacts(): ReturnType<typeof artifactOverrides> {
    return this._turnArtifacts ?? artifactOverrides(currentArtifacts(this.rt.storage.sql, this.actorHandle()));
  }

  private async composeNextRequest(): Promise<ComposedRequest> {
    const surface = await this.turnToolsAndReads({});
    const tools = withToolText(surface.tools, this.turnArtifacts().tools);
    const { reads } = surface;
    const { messages: history } = await this.stores.history.materialize();

    const composed = await this.composeTurn({
      history, tools, reads, requestedWorkMode: await this.preparedWorkMode(), cliCwd: this._cliCwd, item: null,
    });

    return { execution: await this.executionFor(composed), profile: composed.profile, sessionKey: this.name };
  }

  private async executionFor(composed: ComposedTurn): Promise<Omit<ActorExecutionInput, 'task'>> {
    const liveTurn: ActorExecutionInput['chat'] = {
      model: composed.model,
      modelContext: {
        id: composed.promptModel.id,
        contextWindow: composed.window.contextWindow,
        windowMeasured: composed.window.windowMeasured,
        modelOutputLimit: composed.window.modelOutputLimit,
      },
      system: composed.system,
      attachments: {
        accepts: this.modelCatalog.acceptedMedia(), vfs: this.rt.storage.vfs, budget: this.acc.context,
      },
      tools: composed.tools,
      activeTools: composed.activeTools,
      // No step cap: the loop is bounded by the budget governor and the caller's cancel
      // (see core chat.ts, UNBOUNDED_STEPS).
      stopWhen: UNBOUNDED_STEPS,
      cache: {
        providerId: composed.promptModel.provider,
        modelId: composed.promptModel.id,
        sessionKey: this.ownedModelServices.affinityKey,
        retention: this.config.getCacheRetention(),
      },
      budget: this.budget,
      countInputTokens: composed.countInputTokens,
      observeStream: (chunks, call) => this.chatTransport.observe(chunks, call),
    };

    if (composed.reasoningOptions) liveTurn.providerOptions = composed.reasoningOptions;

    const providers = this.providerRegistry();
    liveTurn.modelSpec = providers.normalizeSpecSync(composed.profile.tier.model);
    liveTurn.credentialOf = (spec) => this.ownedModelServices.credentialFor(spec);
    liveTurn.retries = composed.profile.retries;
    liveTurn.fallbacks = composed.profile.tier.fallbacks.map(({ model: spec, reasoningEffort }) => ({
      spec: providers.normalizeSpecSync(spec),
      accepts: this.modelCatalog.acceptedMedia(spec),
      bind: () => this.ownedModelServices.resolveModelWithEffort(spec, reasoningEffort),
    }));

    return {
      loopVersion: await this.rt.identity.scaffold.version(),
      chat: liveTurn,
      // All registered extensions; the turn adds the orchestrator's inbox extension itself.
      extensions: this.extensions.list(),
      dynamic: (profile, turnTools) => this.dynamicContextSnapshot(profile, turnTools, composed.memoryTail, composed.activeSkills),
      instructions: composed.instructions,
      activated: composed.activated,
      scaffoldSpend: { source: 'scaffold', report: (report) => this.reportModelCall(report), operations: this.modelOperations },
    };
  }

  /** Clears transcript, working history, dynamic ledger and compaction plan. */
  private async clearConversation(): Promise<void> {
    this.stores.history.clearConversation(CHAT_SESSION_ID, () => this._chatLoop?.turnInFlight() === true || this._actorSession?.inFlight === true
      ? Effect.fail(new KinuError('denied', 'Stop the active turn before clearing its conversation'))
      : Effect.void);
    this.actorSession.dynamic.reset();

    await settleLogged('compaction.reset_failed', { doing: 'clearing the persisted compaction plan after clear-history', otherwise: 'io' }, () => this.compactionState.plans.save(this.name, null), { workspace: this.name });

    const unmeasured = await this.chatLoop.measureCleared();

    // The clear frame has no answer; the failure is recorded where the operator's diagnostics read it.
    if (unmeasured !== null) diagnostics.failure('context.clear_measure_failed', unmeasured, { workspace: this.name });
  }

  /** Awaited ahead of `orch.beginTurn`: the turn is not in flight until these reads are back,
   * so a send during a cold workspace's bootstrap is routed as not-in-flight. */
  private async readTurnInputs(tools: ToolSet, body: JsonObject): Promise<TurnReads> {
    await this.ensureOwnedScaffold();

    await this.refreshSoulText();

    const inputs = this.profileInputs();

    // The model the turn's profile will choose: its tier depends on the role, tier and pins, never on the tools, so
    // every catalog read of the request sizes against the model that serves it.
    const chosen = inputs.then((profileInputs) => {
      const choices = this.tierChoices(profileInputs, body);
      const { model } = resolveAgentTurnProfile({ ...profileInputs, ...choices, workMode: 'build', availableTools: [], activeSkills: [] }).tier;

      return { choices, catalog: this.modelCatalog.at(this.providerRegistry().normalizeSpecSync(model)) };
    });

    // Independent UserDO hops, run in parallel; each keeps its own failure arm.
    const [profileInputs, { choices, catalog }, mcpTools, , identity] = await Promise.all([
      inputs,
      chosen,
      // The remote catalog is admitted against the context budget left after the builtins.
      // A failed read answers no tools and the turn runs on builtins.
      this.buildUserMcpTools(tools, chosen.then(({ catalog: read }) => read)),
      // Authoritative hub check: the TTL-cached snapshot can lag a mid-session `kinu connect`.
      // On failure it records and answers the last snapshot.
      this.rt.deviceTransport.refreshStatus(),
      this.promptIdentity(),
    ]);

    return { profileInputs, mcpTools, identity, catalog, choices };
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

  /** What picks the turn's tier and model: the role, the request's tier, then the actor's own pins. */
  private tierChoices(profileInputs: ProfileAuthorityInputs, body: JsonObject): TierChoices {
    return ownProfileChoices(this.config, profileInputs, undefined, { explicitTier: readTurnTier(body) ?? undefined });
  }

  /** Effect-free: a measure between turns uses it. */
  private async composeTurn(input: TurnCompositionInput): Promise<ComposedTurn> {
    const { profileInputs, mcpTools, identity, catalog, choices } = input.reads;
    const { activeRoleId } = choices;
    const roleSkills = effectiveRoleCatalog(profileInputs.envelope.catalog)[activeRoleId]?.skills ?? [];
    // Deps-gated builtins (report) are advertised only when this actor class wires them; the
    // agents ladder renders only actions this profile supports, then the active skills' union.
    const turnActorDeps = this.actorToolDeps();
    const { requestedWorkMode } = input;
    let activeTools: BuiltinToolName[] = actorActiveTools(turnActorDeps);
    const trust = this.instructionTrust();

    const { available: availableSkills, activeSkills: activeSetForPrompt } = await resolveTurnSkills({
      vfs: this.rt.storage.vfs,
      config: this.config,
      userText: extractLastUserText(input.history),
      roleSkills,
      trust,
      limits: catalog.window(),
    });

    if (activeSetForPrompt) activeTools = filterToolNamesBySkills(activeTools, activeSetForPrompt);
    const { pinned, invoked } = splitTurnSkills(activeSetForPrompt);

    const mcpToolNames = Object.keys(mcpTools);

    const extensionTools = Object.fromEntries(
      Object.entries(this.extensions.tools())
        .filter(([name]) => !(name in input.tools) && !(name in mcpTools)),
    );

    const extensionToolNames = Object.keys(extensionTools);
    const availableAgentActions = actorAgentsActions(turnActorDeps, this._accountSwarms === true);
    // `agent` / `llm` are reachable only inside `eval`, so they must be listed here or
    // the role intersection drops them; derived from providers wired for this mode.
    const turnCodemodeProviders = this.turnCodemodeProviders();

    const availableTools = [
      ...activeTools,
      ...mcpToolNames,
      ...extensionToolNames,
      ...(turnActorDeps.submitPlan ? [SUBMIT_PLAN_TOOL] : []),
      ...codemodeCapabilitiesFor(turnCodemodeProviders),
    ];

    const profile = resolveAgentTurnProfile({
      ...profileInputs,
      ...choices,
      workMode: requestedWorkMode,
      availableTools,
      activeSkills: activeSetForPrompt?.active.map((skill) => skill.name) ?? [],
    });

    this._settledProfile = profile;

    const operation = captureOperationProfile({
      actor: this.actorHandle(), profile, inputs: profileInputs,
      runId: this._currentRunId || WORKSPACE_RUN_ID, turnId: this.durableTurnId() ?? this._currentRunId,
    });

    const workMode = profile.workMode;
    const modeTools = workMode === requestedWorkMode ? input.tools : this.actorToolsets(workMode).turn;
    const allowedTools = new Set(profile.allowedTools);
    const toolAllowed = (name: string): boolean => allowedTools.has(name);
    const promptActiveTools = activeTools.filter(toolAllowed);
    const resolvedAgentActions = toolAllowed('agents') ? availableAgentActions : [];

    const planToolNames = workMode === 'plan' && turnActorDeps.submitPlan && toolAllowed(SUBMIT_PLAN_TOOL)
      ? [SUBMIT_PLAN_TOOL]
      : [];

    const effectiveActiveTools = [...promptActiveTools, ...planToolNames];

    const externalTools: ToolSet = toolAllowed('eval') ? Object.fromEntries(
      [...Object.entries(mcpTools), ...Object.entries(extensionTools)]
        .filter(([name]) => toolAllowed(name)),
    ) : {};

    // AGENTS.md is turn-scoped state, so it rides the beforeTurn system override, not the cached
    // base prompt.
    const agentsMd = await collectWorkspaceAgentsMd(
      this.rt.storage.vfs,
      catalog.window(),
      trust,
      this.rt.executionRouter?.getProvider('sandbox'),
    );

    // The cache prefix changes only on real agent events (soul, model, skills, tools, AGENTS.md);
    // live state rides the dynamic ledger instead.
    const execs = this.rt.executionRouter?.listExecutors() ?? [];
    const model = this.promptModelContextFor(profile.tier.model);

    const promptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {
      soulOverride: this.getSoulText(),
      executors: execs,
      availableTools: promptActiveTools,
      agentsActions: resolvedAgentActions,
      temporaryAsk: turnActorDeps.team?.temporary !== undefined,
      backend: 'cf',
      roleSection: profile.role,
      model,
      // Read here, not in the builder: the builder is the byte-stable cacheable prefix and does no I/O.
      sectionOverrides: this.turnArtifacts().sections,
      identity,
    };

    if (availableSkills.lines.length > 0) promptOptions.availableSkills = availableSkills;

    if (pinned) promptOptions.activeSkills = pinned;
    promptOptions.agentsMd = agentsMd;
    const systemOverride = buildSystemPromptSync(this.rt, promptOptions);

    const languageModel = this.turnModel(profile.tier.model);

    // Attachment sanitization is per-part copy-on-write, so the raw count equals the sanitized
    // durable length; recordTurnTelemetry measures against the same number.
    const rawMessages = input.cliCwd ? withCliCwdContext(input.history, input.cliCwd) : input.history;
    // Must be awaited before submission: synchronous catalog reads return static stand-in values
    // while the lookup is in flight (#20).
    const [window] = await Promise.all([catalog.resolved(), this.modelCatalog.warm(profile.tier.fallbacks.map((fallback) => fallback.model))]);
    // The reflection loop assumes the model sees its latest MEMORY.md lessons in-turn; read once
    // here since it is the one dynamic-context input needing an await.
    const memoryTail = await readMemoryTail(this.rt.memory);
    const instructions = renderUnverifiedInstructions({ agentsMd, activeSkills: pinned });

    const submittedTools = modeTools;
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

    const taskPlan: TaskPlanContext = Object.freeze({ sql: Object.freeze([this.boundSql, this.rt.storage.sql]), plan: this.approvedTaskPlan(input.item) });
    const tools = withOperationProfile(withTaskPlan(toolsForInvocation(workMode, modeTools), taskPlan), operation);

    const reasoningOptions = reasoningEffortOptions(
      profile.tier.reasoningEffort,
      tierModel.provider,
    );

    return {
      profile, profileInputs, system: systemOverride, model: languageModel, tools, externalTools, activeTools: effectiveActiveTools, activeToolSurface,
      rawMessages, instructions, activated: invoked ? activatedSkillsBlock(invoked) : null, window, memoryTail, countInputTokens,
      reasoningOptions, promptModel: model, activeSkills: activeSetForPrompt ?? null, operation,
    };
  }

  private async assembleTurn(input: TurnAssemblyInput): Promise<AssembledTurn> {
    this._workspaceInstructionApprovals = null;
    this._turnActiveSkills = null;
    const composed = await this.composeTurn({ ...input, requestedWorkMode: this.turnWorkMode(), cliCwd: this._cliCwd, item: this._turnItem });

    if (composed.activeSkills !== null) {
      this._turnActiveSkills = composed.activeSkills;
      this.logActivity('skills_active', composed.activeSkills.active.map((skill) => skill.name).join(',') || '(none)');
    }

    this._turnOperation = composed.operation;
    this._turnExternalTools = composed.externalTools;
    this.orch.restrictTurnWorkMode(composed.profile.workMode);
    this.recordSystemPromptHash(composed.system);
    this._turnDurableLength = composed.rawMessages.length;
    this._turnContextWindow = composed.window.contextWindow;
    const measured = measureCompactionTrigger(this.compactionState, this.name, composed.rawMessages.length);

    // Forced rebuild is armed by overflow recovery (onChatResponse).
    if (measured.trigger === 'force') this.logActivity('compaction_forced', 'forced context rebuild');

    return { ...composed, measured };
  }

  /** Set in beforeTurn; read by beforeStep's prune budget every step. */
  protected _turnContextWindow = 0;
  private _turnOrigin: ContextSelection | null = null;

  private async turnOriginContext(): Promise<readonly ModelMessage[]> {
    return this._turnOrigin === null ? [] : (await this.actorSession.canonical.materializeAt(this._turnOrigin)).messages;
  }

  /** Subclass-only planes, read per step by the shared assembler; empty here. */
  protected extraDynamicContext(): ActorDynamicContextExtras {
    return {};
  }

  /**
   * The live state of this agent, read fresh for one model step; holds no state of its own.
   * Nothing clock-derived: a wall-clock field would re-fingerprint the block every request.
   */
  protected dynamicContextSnapshot(
    profile: Pick<ResolvedTurnProfile, 'workMode' | 'allowedTools' | 'tier'>, tools: ToolSet, memoryTail: string | undefined,
    activeSkills: ActiveSkillSet | null = this._turnActiveSkills,
  ): DynamicContext {
    const extras = this.extraDynamicContext();

    return collectDynamicContext({
      rt: this.rt,
      stores: this.stores,
      profile,
      tools,
      externalTools: this._turnExternalTools,
      runtime: { backend: 'cf', model: this.promptModelContextFor(profile.tier.model), date: currentDateForPrompt() },
      turn: this.turnReason(),
      ...(activeSkills !== null && { activeSkills }),
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
  protected turnReason(): TurnReason {
    return turnReasonForMetadata(this.turnDrivingMetadata());
  }

  /** Author-stamped, so the plan hold tells the owner's turn from the harness's. */
  private turnDrivingMetadata(): JsonObject | undefined {
    const metadata = this.turnUserMetadata();
    const item = this._chatLoop?.turnInFlight() === true ? this._turnItem : null;

    return item === null ? metadata : authoredTurnMetadata({ kind: item.kind, metadata });
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

  /**
   * The live turn's profile, else one resolved now for durable work without a chat turn.
   * MODEL_ROUTE_POLICY is read against this; resolving a model any other way bypasses routing.
   */
  protected async routingProfile(availableTools: readonly string[] = [], preparedMode?: WorkMode): Promise<ResolvedTurnProfile> {
    return resolveRoutingProfile({
      actor: this.actorHandle(),
      resolve: async () => {
        const inputs = await this.profileInputs();

        return resolveAgentTurnProfile({
          ...inputs,
          ...ownProfileChoices(this.config, inputs),
          workMode: preparedMode ?? await this.preparedWorkMode(),
          availableTools,
          activeSkills: [],
        });
      },
    });
  }
  /** Resolved now, as this root's or hosted actor's next turn would. */
  protected async actorProfile(input: {
    readonly actor: ActorHandle;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
    /** A binding's named tier overrides the actor's assignment for this call. */
    readonly explicitTier?: string | undefined;
  }): Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }> {
    const inputs = await this.profileInputs();

    return {
      profile: resolveAgentTurnProfile({
        ...inputs,
        ...ownProfileChoices(input.actor.config, inputs, input.actor.actorId === this.actorHandle().actorId ? undefined : this.ancestorProfiles(input.actor), {
          explicitTier: input.explicitTier,
        }),
        workMode: input.workMode,
        availableTools: [...input.availableTools],
        activeSkills: [],
      }),
      inputs,
    };
  }

  /** Ancestors' own pins, nearest first, up to the root. */
  private ancestorProfiles(actor: ActorHandle): PinnedProfile[] {
    return ancestorPins(actor.parentActorId, { actorId: this.actorHandle().actorId, pins: this.config }, (id) => {
      const parent = this.actorHost().describe(id);

      return parent === null ? null : { parentActorId: parent.parentActorId, pins: createAgentConfigStore(this.boundSql, id, actor.assertCurrent) };
    });
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
      throw new KinuError('unsupported', `${source} is platform-routed: it has no model in the turn profile`);
    }

    return this.modelForResolution(route);
  }

  /** One model of a side route or of its chain, resolved the one way every side model is. */
  protected modelForResolution(resolution: Pick<ModelRouteResolution, 'model' | 'reasoningEffort'>) {
    return {
      spec: resolution.model,
      ...this.ownedModelServices.resolveModelWithEffort(resolution.model, resolution.reasoningEffort),
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
      jobs: this.workspaceJobs(),
      runDueSessionEvolution: () => this.orch.runDueSessionEvolution(),
      armOwedTerminalRecovery: () => this.terminal.armOwedRecovery(),
      deliverSignal: (signal) => this.orch.inbox.send(signal),
      redrive: (lane, checkpoint, body) => this.redriveRecoveredLane(lane, checkpoint, body),
    };
  }

  /** Declared so the value Kinu reads and the SDK enforces are the same (see fiber-recovery.ts). */
  static options = {
    fiberRecoveryMaxAgeMs: FIBER_RECOVERY_MAX_AGE_MS,
  };

  /** Set when this activation's fiber sweep ran to its end; later ticks skip it. */
  private fiberSweepFinished = false;

  /**
   * Cleanup only; called from `onStart`, synchronous and bounded so safe in the init gate.
   * Failures are logged and dropped so activation still succeeds.
   */
  protected sweepUnrecoverableFiberRows(activation: boolean): boolean {
    // Once per activation: only a truncated or failed pass leaves rows for the wake's ticks.
    if (this.fiberSweepFinished && !activation) return false;
    // A failed pass reports truncated so the caller arms the wake and retries.
    let truncated = true;

    settleLoggedSync('fiber.unrecoverable_sweep_failed', { doing: 'dropping the interrupted-fiber rows the recovery budget refused', otherwise: 'io' }, () => {
      const result = sweepUnrecoverableFibers(fiberRowStore(this.boundSql), Date.now());

      if (result.dropped > 0 || result.truncated) {
        diagnostics.event('fiber.unrecoverable_rows_dropped', {
          dropped: result.dropped,
          scanned: result.scanned,
          truncated: result.truncated,
        });
      }

      truncated = result.truncated;
      this.fiberSweepFinished = !truncated;
    }, { workspace: this.name });

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
  protected detachOwned(body: Effect.Effect<void>): void {
    const owner: AsyncTaskOwner = { promise: null };
    this._backgroundTasks.add(owner);
    owner.promise = hold(Effect.ensuring(Effect.catchCause(body, recording({ doing: 'running a detached activation task', otherwise: 'io' }, (failure) => {
      diagnostics.failure('actor.detached_task_unclassified', failure, { workspace: this.name });
    })), Effect.sync(() => {
      this._backgroundTasks.delete(owner);
    })));
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

    throw new KinuError('io', 
      `settleBackgroundTasks: ${String(this._backgroundTasks.size)} task(s) still detached after 32 `
      + 'laps: something keeps enqueuing work; join a narrower seam instead',
    );
  }

  /** Every budgeted activation sweep; subclasses fold in their own. True if any pass filled its
   *  budget (caller arms the wake). Synchronous so the init gate can run the same seam. `activation`:
   *  the pass `onStart` runs, which sweeps the fiber table whatever a previous pass on this instance found. */
  protected maintenanceSweeps(activation = false): boolean {
    return this.sweepUnrecoverableFiberRows(activation);
  }

  /**
   * Re-drive one interrupted lane off the init gate via `runFiber`, whose synchronous prefix writes
   * the durable `cf_agents_runs` row before this returns; one dispatch per entry (own checkpoint).
   */
  protected redriveRecoveredLane(
    lane: string, checkpoint: JsonValue, body: () => Promise<void>,
  ): void {
    this.detachOwned(logged('fiber.lane_redrive_failed', { doing: `re-driving the "${lane}" lane an interruption left behind`, otherwise: 'unavailable' }, async () => {
      // The stash wrapper writes `initialSnapshot` in the same synchronous prefix as the row insert,
      // so a reset never finds a recoverable lane with a null payload.
      await this._runFiberWithStashWrapper(lane, async () => { await body(); }, {
        initialSnapshot: checkpoint,
      });
    }, { workspace: this.name, lane }));
  }

  protected invalidateModelCaches(): void {
    // Also drops the provider registry (caches per-agent OAuth refreshers) so a disconnected
    // provider stops being marked available.
    this.ownedModelServices.invalidate();
  }

  // All credentials live in UserDO; providers resolve auth headers through the UserDO stub at
  // fetch time, so this agent stores no raw credentials.

  /** Fan-out target of notifyWorkspacesModelSettingsChanged after the owner's credential or profile writes. */
  async onModelSettingsChanged(): Promise<{ ok: true }> {
    await this.modelSettingsChanged();

    return { ok: true };
  }

  /** Re-drive an evicted background job from its checkpoint (B6) over the raw surface, so a
   *  re-drive can't detach a second job. Legacy `fork` and 'think' rows map to the search path. */
  protected async resumeBackgroundJob(
    kind: string,
    input: JsonValue,
    mode: WorkMode,
    signal: AbortSignal,
  ): Promise<JsonValue | undefined> {
    await this.currentAccountSwarms();
    // Work outside a turn runs on the profile the actor resolves now.
    await this.currentProfile();

    return await resumeBackgroundJob({
      rawTools: (resumeMode) => this.getRawToolsForWorkMode(resumeMode),
      kind, input, mode, signal,
    });
  }
}
