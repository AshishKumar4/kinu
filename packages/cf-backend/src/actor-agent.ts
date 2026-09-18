/**
 * ActorAgent is the actor-agnostic substrate beneath every full-loop Kinu
 * actor on the Cloudflare backend.
 *
 * OrchestratorAgent (the top-level workspace DO) and any future facet actor
 * (there is one: the workspace root) are Think subclasses
 * that differ only in the profile members below: identity bootstrap
 * (getOwnerUserId), exec-plane keying (workspaceName), tool surface
 * (actorToolDeps / extraCodemodeProviders), evolution engine, and owner
 * notification. Everything else lives here, once: the CF runtime assembly,
 * the BackendHost, the shared AgentOrchestrator, ExtensionHost + compaction,
 * the dynamic ledger, prompt/model/tool caches, and the Think hook bridge
 * (beforeTurn / beforeStep / tool hooks).
 *
 * Tool gating is structural: an actor whose profile wires no `team` deps has
 * no hiring actions on its `agents` tool. No flags.
 */

import {
  callable,
  type AgentContext, type Connection, type ConnectionContext,
  type FiberRecoveryContext, type FiberRecoveryResult,
  type WSMessage,
} from "agents";
import {
  TierIdSchema, usesPaneStore, inspectSubordinateStorage, writeActivityLog, backgroundJobNotice,
  actorConnectionTag, actorFromConnectionTags, hostedActorRoute,
  type SubordinateInspectionAuthority,
} from '@kinu.run/core';
import type { SubordinateInspectionRequest, SubordinateInspectionResult } from '@kinu.run/core';
import type { SubordinateActivityEvent } from '@kinu.run/core';
import type { SubordinateRosterEntry as SubordinateView } from '@kinu.run/core/protocol';
import { MessageType, parseProtocolMessage } from "agents/chat";
import { AssistantMessagesTranscript } from './chat-transcript';
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
  rejectOutOfScopeRpc, requiredRpcAccess,
  type CliSocketBearer,
} from "./cli/rpc-gate";
import { retryTransientDO } from "@kinu.run/core";
import { createWorkersTracer } from "./obs/cf-tracer";
import { createAgentTracing, renderThrownChain, type AgentTracing } from "@kinu.run/core/obs";
import {
  createCompactionExtension, createSharedPrefixCompactor, createVfsTranscriptStore,
  createCompactionStateStore, createModelSummarizer, COMPACTION_PRESETS,
  type CompactionStateStore, type Logger as CompactionLogger,
} from "@kinu.run/compaction";
import { Think } from "@cloudflare/think";
import { generateText, convertToModelMessages } from "ai";
import type { LanguageModel, ModelMessage, ToolSet, UIMessage, UIMessageChunk } from "ai";
import {
  McpToolSurfaceCache,
} from "./user/mcp";

import {
  EvolutionEngine, recoverSubordinateLifecycles, actorReferenceOf, createDbCodemodeProvider,
  type EvolutionConfig, type ActorHandle, type ActorHost, type ActorReference, type ChildActorOperation,
  type ActorDirectoryResult, type HostedActor, type WorkspaceActorDirectory,
  // Scaffold loop closure — the evolved inference loop + its sampled
  // shadow rollout. Shared by every actor that carries an EvolutionEngine.
  type ActorTurnProgram, type ScaffoldRunOptions,
  // Durable admission — the claim a turn is issued under, and the per-step
  // context plane its revisions are recorded on.
  initActorClaimTables, ActorClaimStore, initPendingSendTables, PendingSendStore,
  createActorContextPlane, type ActorContextPlane,
  createScaffoldCandidateSurface, createScaffoldCallTool, createScaffoldHistory,
  queueTurnShadowTrial, runQueuedShadowTrials, createJsonJudge, type ScaffoldControl,
  // Continual refinement — the lane's deps come from four seams this class
  // already owns; nothing about it is Cloudflare-shaped.
  advanceRefinementLane, refinementDebtRequest, type RefinementDeps,
  type CompletedTurn, type TurnContinuity, UNBOUNDED_STEPS, UNBOUNDED_MAX_STEPS,
  advisorLaneStarted, markAdvisorLaneStarted, reviewRecordedTurn, ADVISOR_LANE_FIBER,
  type AdvisorRecoverySnapshot, type AdvisorDisposition,
  advisorWorkspaceGuidance,
  // canonical tool + prompt surface — single source of truth
  buildActorTools, buildBuiltinTools,
  buildMcpToolSet,
  type WebSearchProvider,
  buildSystemPromptSync,
  type PromptIdentity,
  activePromptSectionOverrides,
  currentDateForPrompt,
  turnProvenanceForMetadata,
  workModeForTurnMetadata,
  DynamicContextLedger, turnLocalContextMessage, unverifiedInstructionsMessage,
  observeSystemPromptHash, steerSkillsBlock,
  type DynamicContext, type DynamicApproval, type MissingCapability,
  // Public extension seam — the SAME host contract runChat drives on the CLI
  ExtensionHost,
  type SendLanding, type PromptFile, PromptFileSchema,
  // Overflow recovery — the shared turn-failure policy (see turn-failure.ts)
  // Shared turn lifecycle (run bracket, prompt-token trigger, overflow apply)
  // plus the run_end vocabulary and the classifier that derives it from raw
  // facts, so neither backend chooses the string — and the output-limit
  // continuation policy, which is the same three facts asked of a turn that
  // finished with more to say.
  // backend-agnostic per-turn accounting + orchestration (shared by cf + cli)
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
  // Branching heads
  type HeadJournal, LiveHeadJournal,
  type HeadStreamFrame,
  type HeadId, type HeadInput, type HeadReport, type MergeStrategy,
  type SerializedMessage, type HeadRuntime, type HeadGrounding, type MergeResult,
  // Canonical memory-note read (the dynamic-context MEMORY.md tail)
  readMemoryTail,
  // Durable run-event log
  type RunEventRecorder,
  // Cumulative, label-scoped spend governor (opt-in; no label = no cap)
  MissionGovernor, type MissionSeam, type MissionBudgetRefusal,
  // The one normalized provider usage report
  normalizeUsage, priceCall, type Usage,
  explorePrompt, reflectionPrompt,
  // Non-turn model calls: the row type, its sink, and where a call with no run
  // open is filed. The other 25 producers of workspace spend arrive this way.
  WORKSPACE_RUN_ID, type ModelCallReport, type ModelOperationSink, type ModelOperationEvent, type CacheWarmingLane,
  recordModelOperations, type ProviderWaitInfo,
  // The one builder for a model_call row: its shape AND the price-only-when-the
  // -rate-is-this-call's-own guard, spelled once for all three call sites.
  buildModelCallEvent,
  // The ONE catalog pricing, so a model_call row prices exactly as the ledger
  // debits — and only when the rate belongs to the model that served it.
  // agent_facts world model
  type FactsStore,
  // Per-turn device awareness (device runtime presence + change notice)
  observeDevicePresence,
  // The stores every agent has, built once from its one SQL handle, and the
  // one binding of the live per-step planes to them.
  createAgentStores, type AgentConfigStore, collectDynamicContext, subordinateDelegatesOf,
  type SqlExecutor,
  // The agents tool's shared swarm substrate
  agentsActionsFor,
  // Background-job system (#173 — auto-background past the surface threshold)
  BackgroundJobRunner, type InvocationSurface,
  invocationBackgroundPolicy,
  type BackgroundJobStore, type TaskListStore,
  wrapToolsForBackground, BACKGROUNDABLE_TOOLS, resumeBackgroundJob, harvestBackgroundJob,
  // Per-invocation device-request ownership, read off the tool-call options bag
  // the background wrapper armed.
  readDeviceRequestChannel, type DeviceRequestChannel,
  // The control plane both roots expose over the same core implementations.
  cancelCurrentWork, getStoredModelSpec, setModel, getChatHistoryPage,
  type CancelWorkOutcome, type ChatHistoryEntry, type Page, type PageRequest,
  type MctsSearchStore, readSearchTree, isSteerBranchRunId, type MCTSProgressEvent,
  // EventsHub primitives (spec §1)
  EventLog,
  // Skills + per-turn surface (core turn-surface)
  resolveTurnSkills, filterToolNamesBySkills, skillsVfsOver,
  type ActiveSkillSet, type SkillsVfs,
  // Heads support (inherited-context digest)
  INHERITED_CONTEXT_CAP,
  inheritedContextFromRows,
  type ReleaseToolDeps,
  PlanReviewStore, admitPlanReviewAnnotations, formatPlanWithLineNumbers,
  type PlanEdit, type PlanReview, type PlanReviewAnnotation,
  type PlanReviewDecision, type PlanReviewResult, type SubmitPlanToolDeps,
  isVfsError,
  type ParentRpcResult, type ParentExecResult,
  type ParentRpcWrite,
  // Subordinate teams + cross-workspace peers + the report spine
  type TeamToolDeps, type PeersToolDeps, type ReportToolDeps,
  type SubordinateRuntime, type TemporaryAgentPort,
  SubordinateRosterStore,
  createTeamToolDeps, createTemporaryAgentPort, receiveSubordinateEvent,
  type SubordinatesChangedEvent, type SubordinateReportStatus, type SubordinateReportOrigin,
  type SubordinateEventResult,
  // One minting rule for every subordinate, on either backend
  mintSubordinateName,
  // The subordinate tree's depth cap — derived per child, never stated by one
  delegationExhausted, deriveChildDelegationBudget, type DelegationBudget,
  readSoul, bootstrapScaffold,
  // Automatic titling — one policy for every root that can be talked to
  applyWorkspaceTitle, suggestWorkspaceTitle,
  parseModelSpec, catalogModelInfo, countRequestInputTokens,
  // Model-capability attachment sanitization (the PDF-400 fix)
  type MediaModality,
  // Shared catalog view of the resolved model
  ModelCatalogSession, resolveEffectiveModelSpec,
  // Shared turn-context assembly — the SAME ordering runChat runs on the CLI
  measureCompactionTrigger,
  // AGENTS.md (agents.md standard) — cloud workspace discovery, and the trust
  // authority that decides whether discovered bytes earn system placement.
  collectWorkspaceAgentsMd, type AgentsMdSources,
  InstructionApprovalStore, trustOfInstructionApprovals,
  type InstructionApproval, type InstructionTrustResolver,
  listInstructionApprovals, gatherApprovableInstructions,
  openInstructionSource, admitInstructionDecision,
  type InstructionSourceRow, type InstructionSourceView,
  stepContextLimit,
  reasoningEffortOptions,
  uiMessageText, tableExists,
  // memory.* / tasks.* — codemode projections of the same-named native tools
  JsonObjectSchema, JsonValueSchema, changeActiveRole,
  agentsProfileContext, effectiveRoleCatalog, loadProfileAuthorityInputs,
  resolveAgentTurnProfile, resolveRoutingProfile,
  captureOperationProfile, currentOperationProfile, withOperationProfile,
  type OperationProfile,
  createMemoryCodemodeProvider, createTasksCodemodeProvider, createWebCodemodeProvider, createAgentsCodemodeProvider,
  resolveModelRoute, roleChangeOutcomeText, narrowToolSurface, codemodeCapabilitiesFor, slateToolReach, callCodemodeMember, inWorkMode,
  beginModelOperation, toolSurfaceTokens, McpToolSurfaceSchema,
  // Plan mode's one completion surface and the deps-gated report tool. Both sat
  // outside BUILTIN_TOOLS as bare strings with no link to the tools they name.
  SUBMIT_PLAN_TOOL, REPORT_TOOL,
  type ActiveRoster, type JsonObject, type JsonValue, type ProfileAuthorityInputs,
  toolsForInvocation, withTaskPlan, type TaskPlan, type TaskPlanContext, providersInWorkMode, currentWorkMode, requireWorkModePermission, McpProtocolFailureSchema, McpToolError,
  type ResolvedTurnProfile, type TierId, type SpendSource, type ModelCallSpend, type ToolSurfaceNarrowing, type CountableRequest, type InputTokenCount, type DeviceStatus,
  type AgentInbox,
  type NimbusSandboxHandle, childContextResolver,
} from "@kinu.run/core";
import {
  bindAgentSql, createCFRuntime,
  type CFRuntime, type CFRuntimeHooks,
} from "./runtime";
import {
  hostNodeSeat, hostBranch, abortHostedBranch,
  type ExplorationHostSeams, type BranchRunnerDeps,
} from "./exploration-hosting";
import { hostedSubordinateRuntime, type SubordinateHostSeams } from "./subordinate-hosting";
import {
  // The durable lanes' recovery roster — synchronous classification, six arms,
  // terminal-result discipline — and this backend's three cf-minted lane names.
  classifyRecoveredFiber, EVOLUTION_LANE_FIBER, MCP_WARM_LANE_FIBER,
  TERMINAL_LANE_FIBER,
  // The recovery budget this backend DECLARES (handed to the SDK below), and
  // the budget-first pass that applies it before the framework allocates.
  sweepUnrecoverableFibers, fiberRowStore,
  FIBER_RECOVERY_MAX_AGE_MS,
  type FiberLaneTransports,
} from "./fiber-recovery";
import {
  // The pace every durable recovery lane retries at, from core: the notice
  // carrier, this tick's own re-arm and the job runner's deferral share it.
  recoveryBackoffMs,
  // Core's once-only lifecycle for one settled response, and the per-effect
  // ledger it wraps. Both backends drive this same state machine.
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
  // Prompt-cache breakpoints — single source in core prompting/cache-breakpoints.ts
  promptCachePlan, markLastToolForAnthropicCache,
} from "@kinu.run/core";
import type { CodemodeProvider, DeferredApprovalChannel, SlateBindingRoute, SlateCallResult, SlateOperation, SlateReadModel } from "@kinu.run/core";
import { workspaceOwner } from "./workspace-owner-rpc";
import { CRED_SESSION_USER } from "@nimbus-sh/core/runtime/os-contracts.js";
import type { SlateCaller, SlateCallerHop } from "./slates/bindings";
import { diagnostics, KinuError, refusalOf, toKinuError, tolerate, type ErrorCode, type Refusal } from "@kinu.run/core/obs";
import type { UserDO } from "./user/user-do";
import type { UserDoRpcMethod } from "./rpc-surface";
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

/**
 * The two dimensions a fleet row files a model call under. A named contract
 * rather than an inferred pair, so the analytics writer and the actor cannot
 * disagree about which half is the provider.
 */
interface ModelDimensions {
  readonly provider: string;
  readonly model: string;
}

/** No model resolved. Empty rather than a plausible default: a dataset that
 *  attributed an unresolvable spec to some real provider would be worse than one
 *  that says it does not know. */
const UNRESOLVED_MODEL: ModelDimensions = { provider: '', model: '' };

/** What the settled turn's telemetry established for the roster that follows it:
 *  the retry the overflow policy earned, and the ONE name this turn's end
 *  carries.
 *
 *  The name travels because it is already decided here — the durable `run_end`
 *  row has been sealed with it — and a caller that classified the same facts a
 *  second time would be deriving one answer twice, exactly what
 *  `outputContinuation` above is derived once for both actors to avoid. It is
 *  also what makes the ledger and the roster agree by construction: the terminal
 *  roster's `status` IS this reason, not a parallel reading of the same turn. */
/** What {@link ActorAgent.readTurnInputs} answers: the owner-side reads a
 *  turn is assembled from, taken before the turn opens. */
interface TurnReads {
  readonly profileInputs: ProfileAuthorityInputs;
  readonly mcpTools: ToolSet;
  readonly deviceStatus: DeviceStatus;
  readonly identity: PromptIdentity;
}

/** What {@link ActorAgent.assembleTurn} reads: the turn's history, the raw
 *  tool surface for its work mode, the chat request's body, and the reads. */
interface TurnAssemblyInput {
  /** The durable history the turn runs on. */
  readonly history: readonly ModelMessage[];
  /** The actor's raw tool surface for the requested work mode. */
  readonly tools: ToolSet;
  /** The chat request's body — the CLI's cwd and the tier ride on it. */
  readonly body: JsonObject;
  readonly reads: TurnReads;
}

/**
 * What {@link ActorAgent.assembleTurn} produces for one turn, in the loop's
 * vocabulary: the pieces of core's `ChatOptions` only this backend can supply,
 * plus the readings the turn's settlement and per-step assembly re-use.
 */
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
  readonly contextWindow: number;
  readonly memoryTail: string | undefined;
  readonly countInputTokens: (request: CountableRequest) => Promise<InputTokenCount>;
  readonly cacheOptions: ReturnType<typeof promptCachePlan>['providerOptions'];
  readonly reasoningOptions: ReturnType<typeof reasoningEffortOptions>;
  readonly promptModel: ReturnType<ActorAgent['promptModelContext']>;
}

interface AsyncTaskOwner {
  promise: Promise<void> | null;
}

/** A UserDO stub as this actor sees it: the RPC methods rpc-surface.ts declares
 *  reachable, plus fetch. A method outside that list is a compile error here,
 *  which is the gate's own rule stated once. */
type UserHubClient = Pick<UserDO, UserDoRpcMethod> & Pick<Fetcher, 'fetch'>;

const ClientRpcFrameSchema = v.object({
  type: v.literal('rpc'), id: v.string(), method: v.string(), args: v.array(JsonValueSchema),
});

function parseClientRpcFrame<Message>(message: Message): ClientRpcFrame | null {
  if (!v.is(v.string(), message)) return null;
  const json = tolerate<unknown>(() => JSON.parse(message), 'malformed-input');

  if (json === undefined) return null;
  const frame = v.safeParse(ClientRpcFrameSchema, json);

  return frame.success ? { id: frame.output.id, method: frame.output.method } : null;
}

/** The close code the agents SDK treats as TERMINAL (`isTerminalCloseEvent`),
 *  so a client whose authority is gone stops reconnecting and surfaces the
 *  reason instead of retrying a socket it can never hold again. */
const WEBSOCKET_POLICY_CLOSE = 1008;

const CLI_AUTHORITY_REVOKED = 'This CLI authorization is invalid. Sign in again with: kinu auth';

const SESSION_AUTHORITY_REVOKED = 'This session has been signed out. Sign in again.';


function jsonObject<Input>(input: Input): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, input);

  return parsed.success ? parsed.output : {};
}

/** The envelope a stored assistant message is read back through. The PARTS are
 *  the SDK's own discriminated union and restating it here would drift on every
 *  release, so what is validated is the shape the conversion indexes and the
 *  parts travel as the JSON the row stored them as. */
const RecordedUiMessageSchema = v.object({
  role: v.picklist(['user', 'assistant', 'system']),
  metadata: v.optional(JsonValueSchema),
  parts: v.array(v.looseObject({ type: v.string() })),
});

/**
 * The assistant message a terminal effect row recorded, back at the SDK boundary
 * it came from.
 *
 * `convertToModelMessages` is an AWAIT, so the conversion runs inside the
 * effect where the claim already exists. On the live path between the
 * persisted answer and that claim, an eviction leaves a durable answer with
 * no incomplete transition and `resumeAll()` finds nothing to replay. The
 * row carries the message instead.
 */
function recordedUiMessage(value: JsonValue): Omit<UIMessage, 'id'> {
  const row = v.parse(RecordedUiMessageSchema, value);

  const recorded: Omit<UIMessage, 'id'> = {
    role: row.role,
    // SAFETY: the part union is the SDK's, and `convertToModelMessages` is its
    // only reader. Validating `type` is what makes the array a part list; the
    // conversion itself rejects a part it cannot read.
    parts: row.parts as UIMessage['parts'],
  };

  if (row.metadata !== undefined) recorded.metadata = row.metadata;

  return recorded;
}

const PlanApprovalMetadataSchema = v.looseObject({
  kinuEvent: v.literal('plan_approved'), planId: v.string(),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)), decision: v.literal('approve'),
});

/** Extract plain text from the last user message in a ModelMessage[]. Used
 *  by skills resolution to look for `/skill-name` invocations and keyword
 *  matches without needing to know the AI SDK content-part union shape.
 *  Deliberately text-only: file/image attachment parts are dropped here, but
 *  they still reach the model — the evolved-scaffold path hands this flattened
 *  text to the scaffold as `task` while `host.defaultInference()` streams the
 *  prepared turn with all parts intact (see _transformInferenceResult). */
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

/**
 * Turn continuity for the arriving message (core's TurnContinuity). The CLI's
 * one-shot surfaces (`kinu exec`/`kinu run` against a cloud workspace)
 * stamp `oneShot` on the chat request body: each invocation is an independent
 * task by a process that never saw the previous answer, so its prompt is not a
 * verdict on the previous turn. Everything else — the web chat, the API, the
 * REPL over this socket — is a real conversation.
 */
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

/** One activity-log line per compaction engine event: message + compact JSON. */
function compactionLogDetail<Data>(message: string, data?: Data): string {
  if (data === undefined) return message;

  try {
    return `${message} ${JSON.stringify(data)}`;
  } catch (error) {
    // A detail that cannot serialize (a cycle, a BigInt) must not take the
    // activity-log line down with it: record why and ship the message alone.
    diagnostics.event('actor.compaction_detail_unserializable', { error: renderThrownChain({ cause: error }) });

    return message;
  }
}

/** The per-actor-class tool deps `getRawTools` wires into the shared
 *  builtin factory. Structural absence IS the gate: a tool whose deps an
 *  actor class does not wire neither exists in the ToolSet nor is advertised
 *  in the prompt (actorActiveTools). */
export interface ActorToolDeps {
  /** In-workspace subordinate management. Wired by `teamProfile()` on EVERY
   *  actor that still has tree left below it — a subordinate tree is recursive
   *  — and absent at the depth cap. */
  team?: TeamToolDeps;
  /** Cross-workspace peer messaging — orchestrator-only, because
   *  `hire scope=workspace` mints the root of a fresh tree (see
   *  AgentsToolDeps.peers in core delegation/agents-tool.ts). */
  peers?: PeersToolDeps;
  /** Subordinate → parent progress spine — subordinate-only. */
  report?: ReportToolDeps;
  releases?: ReleaseToolDeps | undefined;
  /** Owner-chat plan review submitter. Present structurally on actors whose
   * current turn belongs to the owner, then surfaced only in Plan mode. */
  submitPlan?: SubmitPlanToolDeps;
}

/** BUILTIN_TOOLS filtered to what this actor's deps actually wire — the prompt
 *  and the activeTools whitelist must not advertise structurally absent tools.
 *
 *  WHICH names are deps-gated is core's `DEPS_GATED_TOOLS`, and each is spelled
 *  by its registry constant. A bare `['report']` spelled here would carry
 *  no link to the tool it names, so renaming the builtin leaves a gate
 *  matching nothing. The `agents` tool is never dropped on cf — every
 *  actor has the swarm substrate — but its ACTIONS gate on the same profile (see
 *  actorAgentsActions). `release` is not a native tool at all (release.* is
 *  codemode-only), so `deps.releases` gates nothing here; it feeds that codemode
 *  namespace directly.
 *
 *  That every gated name is answered here is asserted by test, not by the
 *  compiler: core declares the set as `readonly BuiltinToolName[]`, which is the
 *  right type for a shared list and cannot key an exhaustive table. */
function actorActiveTools(deps: ActorToolDeps): BuiltinToolName[] {
  const gate = {
    [REPORT_TOOL]: !!deps.report,
  } satisfies Partial<Record<BuiltinToolName, boolean>>;

  return BUILTIN_TOOLS.filter((name) => gate[name] ?? true);
}

/** The `agents` actions this actor profile supports, for the prompt's
 *  Delegation ladder — the same gating rule the tool's enum uses. Fork is
 *  universal on cf (every ActorAgent owns the strategy registry + facet
 *  substrate); hiring and peer converse ride the actor profile. */
function actorAgentsActions(deps: ActorToolDeps): AgentsToolAction[] {
  return agentsActionsFor({ swarm: {}, team: deps.team, peers: deps.peers });
}

/** The codemode tool whose script keeps issuing device execs for as long as it
 *  runs — including after its own call has detached. Named against the builtin
 *  union rather than written as a bare string, so a rename breaks the build
 *  instead of leaving this silently matching nothing. */
const CODEMODE_TOOL_TOOL = 'eval' satisfies BuiltinToolName;

/** The schedule callback that finishes what a dead activation's terminal
 *  sequence still owed. Public on the actor because `Agent.schedule()` types its
 *  callback as `keyof this`, which excludes protected members. */
export const TERMINAL_RETRY_CALLBACK = '_kinuTerminalRetryTick';



export interface ActorDynamicContextExtras {
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
  readonly extraMissingCapabilities?: () => readonly MissingCapability[];
}

interface WorkspaceTitleInputs {
  readonly displayName: string | null;
  readonly nameOrigin: 'user' | 'auto' | null;
}



/** The failure classes under which a turn runs on builtins alone because the
 *  owner's MCP catalog could not be reached or finished: a hop that failed, timed
 *  out or broke mid-read. Every other class is the turn's own fault. */
const MCP_CATALOG_READ_FAILURES: ReadonlySet<ErrorCode> = new Set(['unavailable', 'timeout', 'io']);

/**
 * WHAT A HOSTED ACTOR'S BINDING REACHES: its OWN files, its OWN tables, its OWN
 * tasks and its OWN facts — never the workspace actor's.
 *
 * Built from that actor's runtime and store bundle rather than from the root's,
 * which is the whole of the property `tests/unit-slate-composition.test.ts`
 * pins: a binding held by a subordinate must land in the subordinate's tree
 * under the subordinate's uid. The runtime the host built for it already carries
 * both — its execution router's providers act as its credential on both planes —
 * so this is a list, not a policy.
 *
 * Web uses the same provider the hosted turn receives. Delegation and the MCP
 * descriptor cache are not lent to a slate.
 */
function hostedActorSurface(actor: HostedActor, webSearch: WebSearchProvider) {
  // SAFETY: this runtime came from `ActorHostDeps.runtimeFor`, which on this
  // backend IS `createCFRuntime` — the core seam narrows the RETURN type to
  // `AgentRuntime`, it does not narrow the value, and `CFRuntime` always builds
  // a vector store (a noop one when the bindings are absent). The alternative
  // is teaching core about Vectorize to satisfy a cf read, which is backwards:
  // the whole point of `runtimeFor` is that the BACKEND owns the runtime.
  const runtime = actor.runtime as CFRuntime;

  const providers: CodemodeProvider[] = [
    ...(runtime.executionRouter?.getProviders() ?? []),
    createWebCodemodeProvider(webSearch),
    createDbCodemodeProvider(actor.stores.appData),
    createTasksCodemodeProvider(actor.stores.taskList, actor.stores.config),
    createMemoryCodemodeProvider(() => ({
      memory: runtime.memory, vectorStore: runtime.vectorStore,
      facts: actor.stores.facts, sql: runtime.storage.sql, actor: actor.handle,
    })),
  ];

  const native = buildBuiltinTools({
    rt: runtime, vectorStore: runtime.vectorStore, facts: actor.stores.facts, webSearch,
    fileLedger: actor.session.orchestrator.acc.files, contextBudget: actor.session.orchestrator.acc.context,
  });

  return { providers, native };
}

export abstract class ActorAgent extends Think<Env> {
  // ── The actor profile — what a concrete actor class supplies ─────────
  // The rest of this class is actor-agnostic; these members are the whole
  // difference between actor kinds (orchestrator vs a future facet actor).

  /** Owner userId, or null while unclaimed — the actor's identity bootstrap.
   *  The orchestrator reads workspace_identity; a facet actor reads the
   *  owner row its parent seeded. */
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
  /**
   * Which kind of actor this class is, for the operational dataset's `agentKind`
   * dimension.
   *
   * Abstract rather than derived from `constructor.name`, which a bundler is free
   * to rewrite, and rather than a string at each emit site, which is how a
   * dimension ends up with three spellings of one value. It sits in the actor
   * profile with the rest of "the whole difference between actor kinds", so a new
   * actor class cannot be added without deciding how its work is attributed.
   */
  protected abstract actorKind(): AgentKind;

  /** The workspace whose exec planes (authoritative workspace, sandbox,
   *  /pc device consent) this actor rides. A top-level workspace DO is its
   *  own workspace; a facet actor overrides with its parent's name. */
  protected workspaceName(): string { return this.name; }

  protected shellId(): string { return `agent:${this.name}`; }

  /**
   * The workspace's process/port/runtime/exec plane, for one named durable
   * shell.
   *
   * ONE DURABLE OBJECT OWNS THE BYTES. A top-level workspace DO composes Nimbus
   * over its own `ctx.storage.sql` and answers from there; a facet actor —
   * its own Durable Object with its own SQLite, sharing the workspace's tree —
   * answers with a client onto the object that does. In the actor profile
   * because it is exactly "the whole difference between actor kinds": a new
   * actor class cannot be added without deciding whether it owns a workspace.
   */
  protected abstract workspaceBox(shellId: string): NimbusSandboxHandle;

  /** The default agent owns the workspace's canonical scaffold. Facet actors
   * override this with an actor-private path inside the same workspace. */
  protected scaffoldPath(): string { return 'scaffold/agent.js'; }

  /** This actor's proof of workspace identity to the owner's UserDO. A
   *  top-level workspace DO holds its own token; a facet actor holds a pushed
   *  copy of its PARENT's, which is why every facet of a workspace is
   *  attenuated exactly as the workspace is, with no per-facet bookkeeping to
   *  forget. Null before the Worker has claimed the workspace and issued one.
   *
   *  Stored in its own table rather than actor_config: it is identity, not
   *  configuration, and must not be reachable through any config or snapshot
   *  surface. There is deliberately no RPC that reads it back out — the token
   *  only ever travels parent -> facet, so nothing name-addressable can be
   *  asked for another workspace's secret. */
  protected workspaceCapabilityToken(): string | null {
    // A plain read; the constructor owns the table (`initCapabilitySchema`),
    // so a failure here is a real failure and never reads as "no token".
    const rows = this.sql<{ token: string }>`SELECT token FROM workspace_capability LIMIT 1`;

    return rows[0]?.token || null;
  }

  /** The hash of the token this workspace holds, or null when it holds none.
   *  Safe to hand out — it is what lets the owner's UserDO detect that the two
   *  sides disagree without either of them exchanging the secret. */
  protected async workspaceCapabilityHash(): Promise<string | null> {
    const token = this.workspaceCapabilityToken();

    return token ? sha256Hex(token) : null;
  }

  /** Install the capability token the owner's UserDO minted for this
   *  workspace. Worker-side DO RPC only — deliberately not `@callable`.
   *
   *  `missed` counts the subtree pushes that failed. A suppressed push is not
   *  the end of the story: the caller reports it to the UserDO, which arms a
   *  reconciliation intent, because the child it stranded keeps presenting the
   *  now-unrecognized token until something retries — and nothing else does. */
  async installWorkspaceCapability(token: string): Promise<{ ok: true; missed: number }> {
    if (!token) throw new Error('capability token required');
    // A native DO RPC does not route through partyserver, so it can land before
    // `onStart` has run — the same race `OrchestratorAgent.claimOwner` handles
    // this way. Flag-gated, so it is a no-op once the activation is initialized.
    this.ensureSchema();
    void this.sql`INSERT INTO workspace_capability (id, token) VALUES (1, ${token})
             ON CONFLICT(id) DO UPDATE SET token = excluded.token`;
    this.invalidateModelCaches();

    // Hosted actors read the workspace's single capability row through their
    // runtime, so a reissue takes effect on their next call without
    // propagating token copies. Per-actor copies would require reconciliation
    // and could keep presenting revoked tokens; `missed` is always zero
    // because this design has no such copies, and it is kept in the answer
    // because callers report it.
    return { ok: true, missed: 0 };
  }

  /** Re-run the subtree push with the token this root already holds. The
   *  recovery half of the reconciliation intent: only the root stores the
   *  plaintext, so a retry that missed a replica has to be asked of the root.
   *  Idempotent by construction — the push is the same one `installWorkspaceCapability`
   *  runs, and the token is the same one the registry already committed. */
  async repushWorkspaceCapability(): Promise<{ missed: number }> {
    const token = this.workspaceCapabilityToken();

    if (!token) return { missed: 0 };
    const result = await this.installWorkspaceCapability(token);

    return { missed: result.missed };
  }

  /** The workspace's identity table. Created from the constructor rather than a
   *  root's `ensureSchema()` because the constructor is the only point guaranteed
   *  to precede every read and write of it on BOTH cf roots: the SDK does not
   *  guarantee `onStart` runs before an RPC (see `OrchestratorAgent.claimOwner`),
   *  and the orchestrator installs a token into a subordinate by a direct DO RPC
   *  that enters no root's `ensureSchema`.
   *
   *  Creation belongs in the constructor because it is the only point
   *  guaranteed to precede every read and write on BOTH cf roots (see
   *  above). A table that exists because an unrelated call threw is a
   *  table with no owner.
   *
   *  Per-root by design — `cli` has no user plane, so core's
   *  `initWorkspaceSchema` must NOT own it: `core/conformance/manifest.ts`
   *  declares `workspace_capability` WIRED for cf-orchestrator and cf-subordinate
   *  and absent for cli. */
  private initCapabilitySchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_capability (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL
    )`);
    // ONE pending-send ledger, declared once in core (`initPendingSendTables`)
    // because the CLI backend carries the same-named tables with a nullable
    // `turn_id` (NULL = idle-queued — a state this backend does not have; cf
    // admits the send as an `assistant_messages` row first). Two declarations
    //  would let first-creation order pick the shape, so the shared function
    //  is the only writer.
    initPendingSendTables((ddl: string) => this.ctx.storage.sql.exec(ddl));
    // The admission ledger records the issued actor, run, execution epoch,
    // selected program and admitted context; one workspace-wide turn pointer
    // cannot distinguish concurrent actors or evicted activations. Initialize
    // it here because onStart recovery can read it before a root's
    // ensureSchema runs.
    initActorClaimTables((ddl: string) => this.ctx.storage.sql.exec(ddl));
    // Here for the same reason as the row above it: the recovery sweep reads
    // it from `onStart`, which is not guaranteed to follow a root's
    // `ensureSchema`. Idempotent DDL, so a re-activation costs nothing.
    initTerminalEffectTable((ddl: string) => this.ctx.storage.sql.exec(ddl));
  }
  /** Every table this root carries, created before any read. Declared here
   *  because `installWorkspaceCapability` — a native DO RPC reachable before
   *  `onStart` — has to be able to demand it. */
  protected abstract ensureSchema(): void;

  /** Tool deps only this actor class wires. Structural absence is the gating
   *  mechanism (the same way hiring is absent on the CLI backend): an actor
   *  that returns {} has no roster/peer actions and no release tool. */
  protected abstract actorToolDeps(): ActorToolDeps;

  /** Codemode providers beyond the shared set. Spliced between `agents` and
   *  `web` so provider order — and therefore the LLM-visible type
   *  description — is stable across actor kinds. */
  protected extraCodemodeProviders(): CodemodeProvider[] { return []; }

  /** The evolution engine the shared AgentOrchestrator drives. */
  protected abstract get engine(): EvolutionEngine;

  /** The promotion gate's two ports, over this actor's control plane — the
   *  engine config every actor's engine must carry. Here rather than in each
   *  subclass's constructor for the same reason `settleCompletedTurn` is:
   *  a facet that queues trials but wires no runner stalls on the first
   *  proposal it makes, and one that wires neither scores none at all. */
  protected get shadowTrialPorts(): Pick<EvolutionConfig, 'shadowTrialQueue' | 'shadowTrialRunner'> {
    return {
      shadowTrialQueue: (turn, opts) => queueTurnShadowTrial(this.scaffoldControl, turn, opts),
      shadowTrialRunner: () => runQueuedShadowTrials(this.scaffoldControl),
    };
  }

  /** Out-of-band owner notification (mission-inbox email on the
   *  orchestrator). Fired when a background job settles. */
  protected abstract notifyOwner(subject: string, body: string): void;

  /** Browser/socket-only RPC policy. Durable Object stub calls do not pass
   * through onMessage, so subclasses can keep bootstrap methods available to
   * trusted worker callers while denying the same method to client sockets. */
  protected isClientRpcMethodDenied(_method: string): boolean { return false; }

  // ── Plan review ─────────────────────────────────────────────────────
  // Every full-loop actor owns its own review stream. The concrete profile
  // decides whether THIS turn may submit into it: an owner-driven additional
  // agent does; a task delegated by its parent keeps the report lane instead.

  /** The approved plan the running turn implements, when the turn IS a plan
   *  approval's handoff: read off the admitted item — its metadata names the
   *  plan, its idempotency key is the decision's — and honoured only while
   *  the row still says approved. Null for every other turn. */
  private approvedTaskPlan(): TaskPlan | null {
    const item = this._turnItem;

    if (item === null || item.kind !== 'programmatic') return null;
    const parsed = v.safeParse(PlanApprovalMetadataSchema, item.metadata);

    if (!parsed.success) return null;
    const input = parsed.output;
    const prefix = `plan:${input.planId}:${input.revision}:approve:`;
    const key = item.idempotencyKey ?? '';

    if (!key.startsWith(prefix) || !/^\d+$/.test(key.slice(prefix.length))) return null;
    const plan = this.planReviews.get(input.planId, input.revision);

    if (plan?.status === 'approved' && plan.sessionId === 'default') {
      return Object.freeze({ id: plan.id, revision: plan.revision, sessionId: plan.sessionId });
    }

    return null;
  }

  private _planReviews: PlanReviewStore | null = null;

  /** One SQL-backed review stream, local to this actor's durable storage. */
  protected get planReviews(): PlanReviewStore {
    if (!this._planReviews) this._planReviews = new PlanReviewStore(this.boundSql, this.actorHandle());

    return this._planReviews;
  }

  protected submitPlanEdits(edits: readonly PlanEdit[]): PlanReviewResult | Promise<PlanReviewResult> {
    const result = this.planReviews.submit('default', edits);

    if (result.ok) this.broadcastPlanUpdate(result.plan);

    return result;
  }

  private broadcastPlanUpdate(plan: PlanReview): void {
    this.host.broadcast({ type: 'plan_updated', plan });
  }

  @callable()
  async getActivePlanReview(): Promise<PlanReview | null> {
    return this.planReviews.getActive('default');
  }

  @callable()
  async savePlanReviewAnnotations(
    id: string,
    revision: number,
    annotations: PlanReviewAnnotation[],
  ): Promise<PlanReviewResult> {
    const admitted = admitPlanReviewAnnotations(annotations);

    if (!admitted.ok) {
      return { ok: false, error: admitted.error, plan: this.planReviews.get(id, revision) };
    }

    const result = this.planReviews.saveAnnotations(id, revision, admitted.annotations);

    if (result.ok) this.broadcastPlanUpdate(result.plan);

    return result;
  }

  /** Persist the verdict before starting the next turn. The queued handoff
   * keeps implementation outside the Plan tool surface. */
  @callable()
  async decidePlanReview(
    id: string,
    revision: number,
    decision: PlanReviewDecision,
    feedback?: string,
  ): Promise<PlanReviewResult | {
    readonly ok: true;
    readonly plan: PlanReview;
    readonly queued: boolean;
    readonly queueError?: string;
  }> {
    const result = this.planReviews.decide(id, revision, decision, feedback);

    if (!result.ok) return result;

    if (result.plan.handoffAccepted) {
      return { ok: true, plan: result.plan, queued: true };
    }

    this.broadcastPlanUpdate(result.plan);

    const plan = result.plan;

    const text = decision === 'request_changes'
      ? [
          `The owner requested changes to plan ${plan.id} revision ${plan.revision}.`,
          '',
          '## Review feedback',
          plan.feedback ?? '',
          '',
          `## Current plan (${plan.content.split('\n').length} lines)`,
          'Use these exact pre-edit line numbers in the next submit_plan call:',
          '',
          '```',
          formatPlanWithLineNumbers(plan.content),
          '```',
          '',
          'Revise the plan with targeted submit_plan edits. Do not implement or create previews.',
        ].join('\n')
      : [
          `The owner approved plan ${plan.id} revision ${plan.revision}.`,
          ...(plan.feedback ? ['', 'Approval notes:', plan.feedback] : []),
          '',
          'Implement the exact approved plan below. Verify the result and report any necessary deviation explicitly.',
          '',
          '<approved-plan>',
          plan.content,
          '</approved-plan>',
        ].join('\n');

    const metadata = {
      kinuEvent: decision === 'approve' ? 'plan_approved' : 'plan_feedback',
      kinuMode: decision === 'approve' ? 'build' : 'plan',
      planId: plan.id,
      revision: plan.revision,
      decision,
    };

    const enqueue = (attempt: number) => this.host.enqueueTurn({
      text,
      metadata,
      idempotencyKey: `plan:${plan.id}:${plan.revision}:${decision}:${attempt}`,
    });

    try {
      let attempt = this.planReviews.handoffAttempt(plan.id, plan.revision);
      let queued = await enqueue(attempt);

      if (queued.status === 'skipped'
        && queued.durable
        && !queued.durable.accepted
        && (queued.durable.status === 'aborted'
          || queued.durable.status === 'skipped'
          || queued.durable.status === 'error')) {
        attempt = this.planReviews.advanceHandoffAttempt(plan.id, plan.revision, attempt);
        queued = await enqueue(attempt);
      }

      if (queued.status !== 'queued') {
        return { ok: true, plan, queued: false, queueError: 'the durable turn submission was skipped' };
      }

      const accepted = this.planReviews.markHandoffAccepted(plan.id, plan.revision);

      if (!accepted.ok) return accepted;
      this.broadcastPlanUpdate(accepted.plan);

      return { ok: true, plan: accepted.plan, queued: true };
    } catch (error) {
      return {
        ok: true,
        plan,
        queued: false,
        queueError: renderThrownChain({ cause: error }),
      };
    }
  }


  // ── The subordinate tree ────────────────────────────────────────────
  // Hoisted here from the orchestrator when `hire` became recursive: an actor
  // that can hold a roster is not a kind of actor, it is every actor with tree
  // left below it. The orchestrator is depth 0, a subordinate reads its own
  // depth off the immutable identity row its parent seeded, and both run the
  // identical roster/ingress/broadcast machinery — there is no second
  // implementation to drift.

  /** This actor's position in the workspace's subordinate tree, and the room
   *  left below it. The orchestrator answers with the root budget; a facet
   *  actor answers from durable storage, so an eviction cannot reset it. */
  protected abstract delegationBudget(): DelegationBudget;

  /** The workspace's ONE actor host. Every logical actor — a hire, an
   *  ask-by-role temporary, a head, a node, a rollout branch — is acquired from
   *  it, over this object's own SQL. Abstract because the host is built from the
   *  root's workspace, home registry and profile authority, none of which this
   *  base class holds. */
  protected abstract actorHost(): ActorHost;

  /** The directory that owns membership of this workspace. Read directly by the
   *  inspection path and the slate descent, which both resolve an actor by name
   *  rather than by holding a handle. */
  protected abstract actorDirectoryStore(): WorkspaceActorDirectory;

  /** What an exploration runner needs of this workspace: the host, the model
   *  and profile authority, and where a step and a frame go. */
  protected abstract explorationSeams(): ExplorationHostSeams;

  /** What the subordinate rung needs of this workspace. */
  protected abstract subordinateSeams(): SubordinateHostSeams;

  /**
   * A SUBORDINATE IS NEVER TOLD ANYTHING ABOUT ITSELF, and there is no facet
   * port for it to be told over.
   *
   * `confinePrincipal` has no RPC and the uid registry lives only on the object
   * that owns the workspace, so a child that had to reach that registry would
   * need a port of its own; a child running as its own Durable Object class
   * would need that class named; and a child keeping its own storage would have
   * to re-read its home after every eviction to be rebuilt as itself rather
   * than as the origin.
   *
   * There is no child class to name, no hop to reach the registry across, and
   * no per-child storage to re-read: the host provisions each actor's home in
   * this isolate and hands it to that actor's runtime
   * (`actor-hosting.ts` → `hostedActorAgentName`), and the actor's identity is
   * its `workspace_actors` row. This actor's OWN home is a property of its
   * runtime, not of this class.
   */

  /**
   * The roster half of the actor profile — wired only while this actor has room
   * below it.
   *
   * At the cap the deps are ABSENT rather than present-and-refusing, so
   * hire/ask/send/list/dismiss are not in the tool enum, not in the codemode
   * namespace and not in the prompt's ladder. That is this repo's structural
   * containment doctrine and the stronger of the two mechanisms in use: a tool
   * that is not there cannot be attempted. It is also what oh-my-pi does
   * (`canSpawnAtDepth` drops `task` below its cap) rather than what dsh does
   * (keeps the tool and throws a typed SubagentDepthError).
   *
   * The classified refusal in core's dispatch is NOT a second opinion on the
   * same question — it covers the one window absence cannot: a ToolSet is cached
   * across turns and a facet's identity is seeded after it is constructed, so a
   * build that ran before the seed could offer `hire` to an actor that turns out
   * to be at the cap. Absence for the steady state, a reason for the seam that
   * absence cannot reach; and the prompt states the cap for an actor sitting on
   * it, so silence is never the whole answer.
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

  /** This actor's hires, for the per-step dynamic context. */
  protected subordinateDelegates() {
    return subordinateDelegatesOf(this.subordinateRoster.list());
  }

  protected async subordinateView(name: string): Promise<SubordinateView> {
    const entry = this.subordinateRoster.get(name);

    if (entry === null) throw new Error(`Subordinate "${name}" is not in the roster`);

    try {
      // The child's OWN config rows, read through the host's binder rather than
      // fetched over a stub: `getSubordinateSnapshot` was an RPC because the
      // display name and the role lived in the child's private database, and
      // they are `actor_id`-scoped rows in this one now.
      const child = this.actorHost().bindStores(
        this.actorDirectoryStore().apply(actorReferenceOf(this.actorHandle()), [], { action: 'resolve', name }).reference,
      );

      return {
        ...entry,
        displayName: child.stores.config.getDisplayName() ?? entry.name,
        role: child.stores.config.getRoleSelection(),
      };
    } catch (error) {
      diagnostics.failure('subordinate.descriptor_unavailable', toKinuError({
        doing: 'reading a subordinate descriptor from its agent config',
        cause: error,
        otherwise: 'unavailable',
      }), { subordinate: name });

      return { ...entry, displayName: name, role: 'Unavailable' };
    }
  }

  protected async subordinateViews(): Promise<SubordinateView[]> {
    return Promise.all(this.subordinateRoster.list().map(
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
   * A HOSTED ACTOR IS NOT REACHED OVER THE FACET SPINE.
   *
   * There is no child Durable Object and no `/sub/<class>/<key>` hop for an
   * `onBeforeSubAgent` hook to gate — every actor lives in this one. Admission
   * happens where the address is resolved: `agent-routing.ts` refuses the `sub`
   * segment outright on the public transport, and `resolveHostedActorRoute`
   * checks the logical name against the directory and the roster before the
   * request reaches an actor.
   *
   * Every subordinate verb is likewise a call on this workspace's one
   * `ActorHost` (`subordinate-hosting.ts`), which validates the same directory
   * row and holds no facet stub at all.
   */
  private _subordinateRuntime: SubordinateRuntime | null = null;

  /**
   * THE child substrate of this actor: how a subordinate is born, addressed and
   * retired on this platform.
   *
   * One memoized hosted subordinate runtime serves both the durable roster and
   * the temporary register, so both address the same actors. Actor creation is
   * owned by `subordinate-hosting.ts` and does not allocate a separately seeded
   * facet database that could remain charged to the workspace quota after
   * failed reclamation.
   */
  protected subordinateRuntime(): SubordinateRuntime {
    this._subordinateRuntime ??= hostedSubordinateRuntime(
      this.subordinateSeams(),
      () => this.actorHost().bindStores(actorReferenceOf(this.actorHandle())),
    );

    return this._subordinateRuntime;
  }

  private _temporaryAgentPort: TemporaryAgentPort | null = null;

  /**
   * The temporary rung's port, built ONCE per actor.
   *
   * The lifetime is the point: `shell` parks a waiter here and the report ingress
   * resolves it, and those are two different calls on the same isolate. A port
   * rebuilt per call would hand the ingress an empty waiter map and leave every
   * ask hanging on an answer that had already arrived.
   */
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
      originContext: () => this._turnOriginContext,
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
   * Record a title one of this actor's own children settled on.
   *
   * Called BY that child, over the facet spine, right after it wrote its own
   * naming state — so it refreshes this roster's listeners and nothing else.
   * Calling the child back from here would re-enter a Durable Object that is
   * mid-turn. The parent holds NO title mirror (core owns the one-writer
   * contract): this only fans the `subordinates_changed` broadcast.
   *
   * Not a `@callable`: the browser renames through `rename`, which writes
   * both sides. This is worker-side facet RPC, in the same trust domain as
   * `receiveSubordinateEvent` — possession of the parent stub is the
   * authorization.
   */
  async recordSubordinateTitle(
    name: string,
    displayName: string,
  ): Promise<{ ok: true }> {
    this.ensureSchema();
    await this.getTeamToolDeps().recordTitle({ name, displayName });

    return { ok: true };
  }

  /** This actor's role as ONE label. It reads core's one `role_selection` row. */
  protected activeRoleLabel(): string {
    return this.config.getRoleSelection();
  }
  /**
   * Facet bootstrap authority. Worker-side DO RPC only. The child verifies its
   * supplied owner/workspace against this source before persisting its immutable
   * identity row — and takes its DEPTH from here, never from its own arguments.
   *
   * This is the one place a child's depth is decided, which is what makes the cap
   * unbypassable by a subordinate that simply does not check: the number it would
   * have to lie about is one it never supplies. The seeding authority refuses at
   * the cap too, so even a stale ToolSet that offered `hire` cannot produce a
   * child past it.
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

  /** Subordinate progress ingress. Worker-side DO RPC only: the method is not
   * `@callable`, and the public route exposes only the subordinate's own chat
   * surface. Reports use the same EventLog → drain rail as mission inbox. */
  async receiveSubordinateEvent(input: {
    fromSubordinate: string;
    status: SubordinateReportStatus;
    content: string;
    origin: SubordinateReportOrigin;
    mode: WorkMode;
    /** The child's terminal sequence that owes this report. It is the ingress
     *  DEDUPE KEY: a replayed report is the one the parent already holds, not a
     *  second piece of progress. */
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
      // A temporary child's answer belongs to the `agents.ask` call waiting on
      // it, so the register gets first refusal on the name — through the very
      // port that parked the waiter.
      temporary: this.temporaryAgentPort(),
    }, input, Date.now());
  }

  /** Protected, because the workspace root builds every hosted actor's model
   *  seams from this ONE owner-scoped service rather than each actor holding a
   *  second registry — which is what a facet did, and what made a head's spend
   *  resolve against a provider snapshot the turn had never seen. */
  protected readonly ownedModelServices = new OwnedModelServices({
    env: this.env,
    agentName: () => this.actorHandle().name,
    appTitle: 'Kinu',
    ownerRequired: true,
    getOwnerUserId: () => this.getOwnerUserId(),
    getUserCaller: () => this.userCaller(),
    // The account's credential revision, asked of the same UserDO the registry
    // reads — one more round trip per profile resolution, and the one that
    // makes a missed fan-out notification self-healing instead of durable.
    getCredentialsRevision: async () => {
      const { stub, caller } = await this.userHub();

      return stub.getCredentialsRevision(caller);
    },
    onProviderWait: (info) => { this.noteProviderWait(info); },
  });

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Set on the INSTANCE as well as on each turn's `TurnConfig` (see
    // `beforeTurn`) because the resolution is `config.maxSteps ?? this.maxSteps`:
    // the per-turn value is what production reads, and this is what any Think
    // inference path that does not run through our `beforeTurn` reads. One
    // constant, applied at both seams Think resolves through.
    this.maxSteps = UNBOUNDED_MAX_STEPS;
    // Before any read or write of it can happen — see initCapabilitySchema.
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
    // The vendor base's connection hooks, captured before Think's `onStart`
    // rebinds them around its own chat handshake: Think's connect serves its
    // in-memory message cache, which this backend no longer keeps fresh —
    // the transcript store writes straight through the SDK provider — so the
    // gate below reaches the base directly and the transport serves the
    // durable rows. Captured here because the base installs its own wrappers
    // in ITS constructor, which ran before this line.
    this.baseOnConnect = this.onConnect;
    this.baseOnClose = this.onClose;
  }
  /** The vendor base's connection hooks, before Think's `onStart` rebinds
   *  them: see the constructor. Null until it runs, which is before any
   *  socket arrives. */
  private baseOnConnect: ActorAgent['onConnect'] | null = null;
  private baseOnClose: ActorAgent['onClose'] | null = null;
  /** Think installs protocol dispatch before the actor onStart callback. */
  protected installClientMessageGate(): void {
    const dispatchMessage = this.onMessage;
    this.onMessage = async (connection, message) => {
      if (await this.refuseRevokedSocketAuthority(connection, message)) return;
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

      // The chat protocol is the room's — core's loop over the SDK's own
      // primitives for the root, this actor's own queue for a hosted one;
      // every other frame (RPC, state sync) is the Agent base's. A frame on a
      // socket whose actor this workspace no longer hosts has no room to
      // reach and is refused here.
      if (v.is(v.string(), message)) {
        const room = this.chatRoomFor(connection);

        if (room === null) {
          connection.send(JSON.stringify({ type: 'error', error: 'The actor this connection addressed is no longer hosted here.' }));

          return;
        }

        if (await room.onMessage(connection, message)) return;
      }

      return await dispatchMessage.call(this, connection, message);
    };

    // The connect and close the transport was built for: a socket that opens
    // mid-turn is told what is resuming and reads the transcript as it is
    // NOW — the loop's durable rows, not the vendor cache Think's own
    // handshake would serve. Reached past Think's wrappers (see the
    // constructor): a chat connection never sees Think's handshake, a
    // sub-agent connection never sees ours.
    const baseOnConnect = this.baseOnConnect;
    const baseOnClose = this.baseOnClose;

    this.onConnect = async (connection, ctx) => {
      if (await this.refuseRevokedSocketAuthority(connection, '')) return;

      if (this._cf_requestTargetsSubAgent(ctx.request)) return await baseOnConnect?.call(this, connection, ctx);

      await baseOnConnect?.call(this, connection, ctx);
      this.chatRoomFor(connection)?.onConnect(connection);
    };

    this.onClose = async (connection, code, reason, wasClean) => {
      this.chatRoomFor(connection)?.onClose(connection);
      await baseOnClose?.call(this, connection, code, reason, wasClean);
    };

    // The transcript seed the hook fetches: Think's route serves its
    // in-memory cache, stale since the store moved beneath it, so the gate
    // answers this one path from the durable rows instead.
    const dispatchRequest = this.onRequest;


    this.onRequest = async (request) => {
      const url = new URL(request.url);

      if (url.pathname === '/get-messages' || url.pathname.endsWith('/get-messages')) {
        // Whose transcript: the seed is fetched on the SAME path the pane's
        // socket opens, so a hosted actor's pane is seeded from that actor's
        // own rows and the workspace's from the root's.
        const hosted = hostedActorRoute(url.pathname);
        const history = hosted === null ? this.chatTranscript.history() : this.hostedChatWire(hosted.name)?.history();

        if (history === undefined) return Response.json({ reason: 'missing', error: 'The actor is not hosted here.' }, { status: 404 });

        return Response.json(history);
      }

      return await dispatchRequest.call(this, request);
    };
  }
  /**
   * The ONE pending-send store — core's {@link PendingSendStore} over this
   * actor's executor and actor id. Lazy for the reason every store here is:
   * `actorHandle()` resolves the directory row `ensureSchema` creates, which
   * field initializers run before.
   */
  private _pendingSends: PendingSendStore | null = null;
  private get pendingSends(): PendingSendStore {
    return this._pendingSends ??= new PendingSendStore(this.boundSql, this.actorHandle().actorId);
  }

  /** Does the loop owe a turn nothing in this activation is running: a run
   *  the last process died inside, or a send it acknowledged and never
   *  drained? Both are rows the loop's own construction re-opens and reruns,
   *  so an activation that finds either owes a wake — the loop is built under
   *  that wake, never inside the init gate, because a turn is external work. */
  protected chatLoopOwesWork(): boolean {
    return this.eventRecorder.openTurn() !== null || this.pendingSends.restore().length > 0;
  }

  /** The loop's own recovery, under the wake: constructing it re-opens the
   *  turn the last process left and reruns the sends it acknowledged. Idle
   *  otherwise — a loop with nothing owed is just built. */
  protected resumeChatLoop(): ChatSession {
    return this.chatLoop;
  }


  /** The reconnect snapshot reads SQL, not the RAM drain: RAM vanishes on an
   *  eviction while these rows are the acknowledged steers still awaiting a
   *  step boundary. A STEER is a row bound to a turn — accepted mid-turn, or
   *  swept to a rerun of a dead one. The unbound rows are the loop's own
   *  sends: the message a running or queued turn was admitted from, which the
   *  transport already wrote to the transcript and the tab already shows as
   *  the message it is, never as a chip. */
  protected pendingSteerRuns(): InlineSteer[] {
    return this.pendingSends.restore()
      .filter((row) => row.turnId !== null)
      .map((row) => ({ id: row.id, text: row.text, state: 'queued' as const, atStep: null }));
  }


  // ── The terminal transition ───────────────────────────────────────────
  //
  // One durable turn ends once, and everything a settled turn causes hangs off
  // that single moment: the reply an answered email batch owes, the takes
  // claim, the extension turn-end, the between-turn evolution lanes. Until this
  // existed the sequence had no durable marker at all — it ran, or it stopped
  // half-way and nothing recorded which half. There was no state a later
  // activation could read to tell "this turn's effects are done" from "this
  // turn's effects were interrupted", so there was no safe way to replay any of
  // them, and the honest choice was to replay none.
  //
  // The ledger is the one Kinu already has for exactly this shape:
  // `tool_effect_claims`, keyed on the DURABLE turn id (the id of the message
  // the turn opened on) — the same key a claimed tool's own row uses, so one
  // release covers both and the two cannot disagree about which turn they
  // belong to. The claim is written BEFORE the first effect and settled AFTER
  // the last one, so an interrupted sequence is identifiable, by absence of a
  // result, on the next activation.
  //
  // NOTHING here promises exactly-once to an external service. It cannot: a
  // send that crashed between the call and its status write is indeterminate at
  // the wire, and no local row makes it otherwise. What each external effect
  // already carries is its own idempotency key — the outbound-email intent log
  // stamps a deterministic Message-ID per reply channel, so a re-drive is a
  // recognisably-identical message rather than a second one. The claim below
  // decides whether the sequence is re-entered; the key decides what a
  // re-entered send means.


  /**
   * The effect bodies EVERY actor here shares.
   *
   * Five of them were written out twice — once on the workspace root and once on
   * the subordinate facet — and the copies drifted: an unused field in one
   * schema, a comment explaining a guard the other had lost, and (twice, caught
   * in review) a fix applied to one and not the other. They are not per-actor
   * decisions. Each is the same call into the same shared surface, so it is
   * declared once and spread into both tables.
   *
   * What stays per-actor is what genuinely differs: the root's takes, craft usage
   * and event replies, the facet's parent report, and each one's own titling.
   */
  protected sharedTerminalEffects(): TerminalEffectTable {
    return {
      turn_end_extensions: terminalEffect({
        input: v.object({ text: v.string(), message: JsonValueSchema }),
        // Keyed on the assistant message by its row, and replayed from the
        // recorded text and the recorded message rather than from a live tree,
        // which an interrupted activation cannot supply. The host's own
        // turn-end handlers are idempotent per turn, so the row is what stops
        // a SECOND announcement of one answer without dropping the first
        // when the cut came before it.
        //
        // The CONVERSION runs here, not at the hook. It is the only await between
        // the answer Think has already persisted and the claim that makes the
        // answer's effects recoverable, and an eviction inside it left a durable
        // answer no recovery could find anything owed for.
        run: async ({ text, message }) => {
          // A REFUSAL, not a retry. The stored message is fixed, so a part tree
          // the converter rejects will not start parsing on a later attempt, and
          // an owed row over it would retry forever. The announcement's own
          // subject — the text — survived, so it still fires, with the failure
          // named and recorded on the row.
          let responseMessages: ModelMessage[] = [];
          let refusal: string | undefined;

          try {
            responseMessages = await convertToModelMessages(
              [recordedUiMessage(message)], { ignoreIncompleteToolCalls: true },
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
      overflow_retry: overflowRetryTerminalEffect(this.orch.inbox),
      // The other follow-up a settled turn can owe, and the shape is identical
      // because the obligation is: one signal, keyed on this response, still
      // owed until it is delivered. What differs is which turn earns it — the
      // retry answers a context-length FAILURE, this one an answer the provider
      // cut at its output limit while the model had more to say.
      output_continuation: outputLimitContinuationTerminalEffect(this.orch.inbox),

      turn_record: turnRecordTerminalEffect(this.orch),
      event_drain: eventDrainTerminalEffect(this.orch),

      // The third signal a settled turn can owe: it ended while its task list
      // still held open items. One queued turn, keyed on this response — the
      // ledger, not RAM, says the once.
      task_reminder: taskReminderTerminalEffect(this.orch.inbox),

      improvement_lanes: terminalEffect({
        input: v.object({
          status: RunEndReasonSchema, turn: JsonValueSchema, workMode: WorkModeSchema,
          advisor: JsonValueSchema,
        }),
        // Every lane below is driven by a DURABLE queue or window, so re-entry
        // reads its input from storage rather than from a per-turn snapshot,
        // which does not survive the turn. The verdict is core's one derivation,
        // asked with the RECORDED mode so a fresh activation's default cannot
        // open a lane the turn never earned.
        run: async ({ status, turn, workMode, advisor }) => {
          this.warmUserMcpInBackground();

          if (!this.orch.improvementLanesOpen(status, workMode)) {
            return { status: 'completed', detail: 'improvement lanes closed for this turn' };
          }

          const completed = v.parse(CompletedTurnSchema, turn);
          this.settleEvolutionInBackground();
          // AWAITED to its CHECKPOINT, not to its finish. The lane is durable from
          // that instant, so completing this row before it left a cut in between
          // with a null snapshot and a review recovery terminalized as an error —
          // a review nobody ran and nobody was owed.
          await this.reviewTurnInBackground(completed, v.parse(AdvisorRecoverySnapshotSchema, advisor));

          return { status: 'completed' };
        },
      }),

      shadow_trial: shadowTrialTerminalEffect(this.engine),
    };
  }

  /**
   * The effects THIS actor's terminal sequence can owe.
   *
   * Declared by the actor because the sequence IS the actor's: a workspace root
   * owes alternate takes, craft usage and event replies; a subordinate owes
   * neither of the first two. Both spread {@link sharedTerminalEffects} in, so
   * the five they have in common exist once. The ledger owns only disposition.
   */
  protected terminalEffectTable(): TerminalEffectTable {
    return {};
  }

  private _terminalTransitions: TerminalTransitions | null = null;

  /**
   * The once-only lifecycle this actor's settled responses run through.
   *
   * Core's, not this backend's. What a Durable Object supplies is the two things
   * it genuinely owns — the effect BODIES above, and the WAKE below — and the
   * CLI supplies its own pair to the same class, which is what stops the two
   * from drifting into different answers about an interrupted turn.
   */
  protected get terminal(): TerminalTransitions {
    if (!this._terminalTransitions) {
      this._terminalTransitions = new TerminalTransitions({
        actor: this.actorHandle(),
        sql: this.boundSql,
        effects: this.terminalEffectTable(),
        now: () => Date.now() + this._terminalClockSkewMs,
        fault: () => this.terminalEffectFault,
        // A synchronous run inside a Durable Object is already atomic, so this is
        // the honest identity — but answering through the platform's own primitive
        // keeps the claim and its whole roster one unit whatever core comes to put
        // between them.
        transaction: (body) => this.ctx.storage.transactionSync(body),
        // The one state the turn-wide release must not run in — an
        // auto-continuation already calling tools under this turn before it has
        // a terminal claim of its own. Neither flag alone names it, which is
        // what {@link turnMayStillRun} is for.
        turnIsLive: (turnId) => this.turnMayStillRun(turnId),
        scheduleRetry: async (atMs: number) => { await this.scheduleTerminalRetry(atMs); },
      });
    }

    return this._terminalTransitions;
  }

  /**
   * Can another response of this turn still do something?
   *
   * `_inFlight` answers only for THIS activation, and the state that matters
   * most is the one it cannot see: an isolate that died while an
   * auto-continuation was executing a claimed tool leaves a FRESH actor with
   * `_inFlight === false` while its durable turn claim still names that turn. So
   * closing the earlier response released the continuation's tool claims before
   * chat recovery had replayed it, and the external call ran a second time.
   * `durableTurnId` cannot be the witness on its own either — it deliberately
   * outlives its turn, so it would hold every turn's claims for good.
   *
   * Think's own recovery roster is the honest witness, because a row there is
   * exactly "a response that started and has not finished". The response being
   * closed is excluded: the close can reach `end()` before Think's fiber
   * returns, and the question is whether somebody ELSE may still run.
   */
  private turnMayStillRun(turnId: string): boolean {
    if (this._inFlight && this.durableTurnId() === turnId) return true;

    // A run the ledger holds open for this turn is a response that started and
    // has not finished: the restart re-opens it as a continuation. The
    // settling response's own run is already closed when it settles, so it is
    // never mistaken for one still running.
    return this.eventRecorder.openTurn()?.turn.turnId === turnId;
  }


  /**
   * Idempotent soonest-wins arm of ONE durable wake row for `callback`.
   *
   * THE convergence rule for every Kinu wake chain — the terminal retry here,
   * the workspace timer in `OrchestratorAgent.armTimer` — because both chains
   * ask the same question of the same registry and an answer that differed
   * between them would be a second, silently divergent collapse. A JavaScript
   * reference to a pending promise is not a wake: once an invocation returns
   * the runtime may terminate the isolate with replies, RPCs and model lanes
   * still in flight, and the schedule row is what makes the work exist
   * independently of this activation.
   *
   * WRITE FIRST, then collapse. Cancelling before scheduling opens a window
   * with NO wake row in it, and a failure inside that window ends the chain for
   * good — nothing re-arms a workspace whose only wake was the one just
   * cancelled. An extra row is the harmless failure instead: every tick is
   * idempotent and re-arms from durable state, so it costs one early wake.
   *
   * The collapse READS AFTER ITS OWN WRITE, and that is what makes two
   * concurrent arms converge. Every `await` here is a suspension point, so two
   * callers can both pre-read an empty registry and both write; a collapse over
   * either caller's own PRE-read set cancels nothing and leaves two rows
   * permanently. The POST-write set contains every racing row, and the survivor
   * is chosen by a rule both callers compute identically — earliest wake, ties
   * broken by the SDK's own row id — so they agree without coordinating and the
   * loser's second cancel of an already-cancelled id is a no-op.
   *
   * FUTURE ROWS ONLY. While a tick runs, the SDK keeps its own one-shot row in
   * `listSchedules()` until the callback returns — so a collapse that counted it
   * would pick the overdue executing row as the earliest keeper, cancel the
   * future row this call just wrote, and then lose the keeper when the SDK
   * deletes it. A target in the past therefore becomes the NEXT second rather
   * than this one: a row at `nowSec` is one this method would immediately read
   * as un-armed, so it would be written again on the next call.
   */
  protected async armWakeRow(callback: keyof this & string, atMs: number): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    // Round UP: the SDK stores schedule times in whole seconds, and waking
    // before the target leaves the work not-yet-due, which would re-arm for
    // the same second and busy-spin the alarm until the millisecond passed.
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

    // The keeper is never cancelled, so a failure here leaves EXTRA wakes and
    // never zero, and it propagates: the caller's own write is what the output
    // gate is holding, and a silent collapse failure would report a converged
    // registry that is not.
    for (const row of settled) {
      if (row.id !== keeper.id) await this.cancelSchedule(row.id);
    }

    return keeper.id;
  }

  /** The terminal-retry chain's arm: the wake that carries every post-activation
   *  obligation — owed effects, budgeted sweep remainders, activation-scoped
   *  recovery. One row per actor, soonest-wins. Answers the survivor row's id
   *  so a caller that armed pessimistically can release exactly that row. */
  protected scheduleTerminalRetry(atMs: number): Promise<string> {
    return this.armWakeRow(TERMINAL_RETRY_CALLBACK, atMs);
  }

  /**
   * The durable wake that finishes what a dead activation still owed.
   *
   * Public because `Agent.schedule()` types its callback as `keyof this`, which
   * excludes protected members. Idempotent: it reads the owed roster from
   * storage and re-arms from what is left, so a duplicate wake costs one read.
   */
  async _kinuTerminalRetryTick(): Promise<void> {
    // ARM FIRST, drain second: the pessimistic next-lap wake is durable before
    // any pass runs, so a kill anywhere inside this frame leaves a future row
    // rather than relying on the platform's preservation of the executing one.
    // The collapse keeps it one row when another arm races in, and a tick that
    // finds nothing owed releases the row it wrote at the end.
    const armedRowId = await this.scheduleTerminalRetry(
      Date.now() + recoveryBackoffMs(this.#maintenanceLaps + 1));

    // Maintenance first: the budgeted sweeps and the activation-scoped
    // recovery run in this alarm frame, then the owed external deliveries.
    // One wake, one carrier, collapse semantics included — a pass that left
    // work unfinished re-arms THIS tick through the same singleton-safe armer,
    // at the shared capped backoff: a deep backlog drains at a growing pace,
    // and a pass that keeps answering unfinished settles at the ceiling
    // instead of a one-second loop.
    const sweepsUnfinished = this.maintenanceSweeps();
    const recoveryUnfinished = await this.maintenanceWork();
    await this.owedDeliveryWork();
    // The deferred-attempt wake. It is re-entered HERE rather than left to
    // `maintenanceWork` because that pass is ACTIVATION-SCOPED — the orchestrator
    // clears its own pending flag after the first one — so the second and later
    // ticks inside one warm isolate never reach the job sweep. An interrupted
    // job's wake is armed up to sixty seconds out, which a warm actor serves from
    // that same isolate, and without this line it would fire into a frame that
    // had already decided it had nothing to recover.
    await this.jobRunner.recoverDueResumes();

    // What the registry holds after this tick is decided by the ledgers, not
    // by the laps. UNTIMED owed work — a turn the run ledger holds open, a
    // job running with no resume instant, an open drain lease — names no
    // instant, so the pessimistic row is KEPT at the lap pace: the isolate may
    // die at any point of that work, and a registry with no row would sleep
    // until an external event (which is exactly what the turn-open arm exists
    // to prevent, and a finished pass that released the row undid it one tick
    // later). The pace climbs like an unfinished pass, so a long turn costs a
    // wake at the ceiling and never a two-second loop. A TIMED obligation
    // waits for its own instant, folded in soonest-wins; with only timed work
    // left the pessimistic row is released for that instant, so a lone
    // deferred job costs ONE wake at its instant, not a chain that arrives
    // early and does nothing. Nothing owed at all sleeps empty.
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
   * Consecutive unfinished maintenance laps — the pace input for the tick's
   * own re-arm.
   *
   * In-memory, and the durability that matters lives one level down: the delay
   * is baked into the schedule ROW the re-arm writes, so nothing — not an
   * eviction, not a concurrent arm — can shorten a wake already armed. A
   * restart resets the counter and the ramp re-climbs, five sub-minute wakes to
   * the sixty-second ceiling, which is why the count does not ride the row
   * itself: carrying it there saved one re-climb per restart and cost a
   * max-fold over every armed row plus a rewrite of the keeper on every
   * activation that pulls the wake forward.
   */
  #maintenanceLaps = 0;

  /**
   * Everything a wake dispatches after the maintenance passes, in the one order
   * that cannot lose work.
   *
   * SEPARATE from {@link maintenanceWork} rather than folded into it, because
   * the tick treats the two differently and must: maintenance answers
   * "unfinished" and paces the re-arm, while these deliveries run on EVERY tick
   * whatever maintenance answered — an owed reply is an answer somebody is
   * waiting on, and it must not queue behind a budgeted sweep's remainder.
   *
   * A seam so a subclass with MORE owed external lanes (the orchestrator's
   * event-drain replies) prepends them here and the whole set rides ONE durable
   * wake — the init gate arms this and never runs it, per the ruling that an
   * activation launches no external work.
   */
  protected async owedDeliveryWork(): Promise<void> {
    await this.terminal.replayOwedAndRearm();
  }


  /** Whether anything anywhere still owes this actor a wake: untimed work,
   *  or a timed obligation with an instant. The activation asks this to arm
   *  at all; the tick asks the two halves separately, because they decide
   *  different things about the row it armed. */
  protected owedWorkExists(): boolean {
    return this.owedUntimedWork() || this.nextOwedAt() !== null;
  }

  /** Whether work that names NO instant still owes this actor a wake — an
   *  open turn, a running job with no resume instant, an open drain lease.
   *  The tick keeps its lap-paced row while this answers true. The base owns
   *  none of the rosters the predicate reads, so it answers false; the
   *  subclass that knows its owed surfaces overrides. */
  protected owedUntimedWork(): boolean {
    return false;
  }

  /** The earliest instant anything timed owes this actor a wake, or null
   *  when only untimed work — or nothing — remains. A finished tick arms at
   *  this instant instead of keeping its pessimistic next-lap row, so a lone
   *  deferred obligation costs one wake at its own instant rather than a
   *  chain of laps that arrive early and do nothing. The base times nothing,
   *  so it answers null; the subclass that owns the ledgers overrides. */
  protected nextOwedAt(): number | null {
    return null;
  }

  /**
   * A deterministic cut point in the terminal sequence. Null in production.
   *
   * Exactly-once across an interruption is a claim about WHERE the interruption
   * landed, and the only way to test a claim about a specific instant is to
   * create that instant. A test arms this, drives one terminal sequence, and
   * then re-drives recovery over the same storage.
   */
  protected terminalEffectFault: TerminalEffectFault | null = null;

  /**
   * How far ahead of the wall clock the ledger reads. Zero in production.
   *
   * A retry that is due in five seconds is not observable inside one test tick,
   * and a test that slept would bind its runtime to the backoff schedule. The
   * skew moves the LEDGER's clock, which is the only clock the due-check reads.
   */
  protected _terminalClockSkewMs = 0;


  /** The durable identity of the turn now settling — the id of the message it
   *  opened on. Read at the START of a terminal sequence and carried through
   *  it, because the loop's live turn is the NEXT one as soon as it opens, and
   *  a detached effect that re-read it could close the wrong turn's claim. */
  protected durableTurnId(): string | null {
    const live = this._chatLoop?.currentTurnId;

    if (live !== undefined && live !== null) return live;

    // A cold activation has no loop running a turn yet. The claim ledger is
    // the handoff: the newest claim this ACTOR admitted and never settled is the
    // turn a Stop sweep must identify, and being actor-scoped it cannot answer
    // with a sibling actor's turn the way the old single `id = 1` row could.
    return this.stores.claims.unsettled(1)[0]?.turnId ?? null;
  }



  /**
   * THE actor's context plane, ONE per activation.
   *
   * One object rather than a plane rebuilt per read, because the plane holds
   * the turn's rebase: an edit that lands mid-turn produces a later revision,
   * and the array the SDK is still carrying begins with the PRE-edit prefix —
   * a `prepareStep` override shapes one request and never becomes the next
   * step's input. A host that kept its own array and shaped requests around it
   * therefore discarded every mid-turn edit at the turn boundary, silently. So
   * admission takes `startTurn`'s messages AS the turn's history and the
   * boundary adopts `endTurn`'s, on every path including failure and interrupt.
   */
  private _contextPlane: ActorContextPlane | null = null;
  private get contextPlane(): ActorContextPlane {
    // LAZY, and it has to be: field initialisers run in declaration order and
    // `stores` is declared below this one, so forcing it here read an
    // uninitialised bundle. Lazy also matches what the rest of this class does
    // with storage — a Durable Object must not touch SQL while its fields
    // initialise.
    this._contextPlane ??= createActorContextPlane({ claims: this.stores.claims, events: this.stores.eventRecorder });

    return this._contextPlane;
  }

  /**
   * The installed build this host publishes for its BUILTIN loop.
   *
   * Cloudflare's own version metadata, which is the only real build identity
   * reachable from inside a Durable Object. Absent binding — a deployment older
   * than the binding, or a local `wrangler dev` without it — answers null, and
   * the claim then records the build as unknown. It is never substituted with
   * the package version (a placeholder in this repo), a descriptor digest, or
   * anything else that would read back as a verified build.
   */
  private installedBuildIdentity(): string | null {
    return this.env.CF_VERSION_METADATA?.id ?? null;
  }

  /**
   * The terminal sequence this actor started most recently, resolved once its
   * disposition is written.
   *
   * Retained rather than dropped: the close is detached (a person waiting on
   * their next message must not wait on an SMTP round trip), and an unnamed
   * detached chain is one nothing can ever join — not an activation, and not a
   * suite asserting what a sequence settled as.
   */
  protected _terminalReported: Promise<void> = Promise.resolve();
  private _terminalReportedOwner: AsyncTaskOwner | null = null;

  /**
   * Keep this isolate alive for a terminal close, and carry it if the isolate
   * dies anyway.
   *
   * The Durable Object's half of core's settle: core decides WHEN a transition
   * may close, this decides what stays alive until it does. A bare promise is
   * not a wake — once `onChatResponse` returns the runtime may terminate the
   * isolate with email replies, parent RPCs and model lanes still pending — so
   * the close rides a DURABLE FIBER, which holds the object open and writes the
   * `cf_agents_runs` row that hands the remainder to
   * {@link classifyRecoveredFiber}, which arms the ledger's retry wake for it
   * rather than replaying inside the init gate.
   *
   * Shared by every actor here: the ordering — hold, join, then dispose — is the
   * guarantee, not a per-actor preference.
   */
  protected holdTerminalClose(transition: TerminalTransition, close: () => Promise<void>): void {
    const prior = this._terminalReported;
    const owner: AsyncTaskOwner = { promise: null };
    this._terminalReportedOwner = owner;

    const task = (async () => {
      try {
        // Chain terminal closures so the latest owner retains every earlier
        // close until it settled, rather than overwriting a live fiber.
        await prior;
        await this.runFiber(TERMINAL_LANE_FIBER, async (ctx) => {
          ctx.stash({ lane: TERMINAL_LANE_FIBER });
          await close();
        });
      } catch (cause) {
        // RELEASED on a handled rejection. An eviction needs no cleanup — nothing
        // runs after it — but a rejection that leaves this isolate alive with the
        // sequence still marked in flight makes every retry alarm and recovery
        // fiber skip it forever, which is the one way this design can wedge.
        this.terminal.leave(transition);
        diagnostics.failure('turn.terminal_transition_close_failed', toKinuError({
          doing: "recording that a settled turn's effects had all reported",
          cause,
          otherwise: 'io',
        }), { turnId: transition.turnId, messageId: transition.messageId });

        // RE-ARMED, for the reason the initial arm is. The close carries the
        // ledger's own final wake, so this rejection can BE that wake failing —
        // and the fiber is about to be disposed. Without this the rows stay owed
        // with the alarm that would have carried them already spent.
        try {
          await this.terminal.armRecovery(transition, { cause });
        } catch (recoveryCause) {
          diagnostics.failure('turn.terminal_transition_recovery_failed', toKinuError({
            doing: 're-arming the terminal transition after its close failed',
            cause: recoveryCause,
            otherwise: 'io',
          }), { turnId: transition.turnId, messageId: transition.messageId });
        }
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


  /**
   * The provider and model dimensions of a fleet row, for the actor's own model.
   *
   * `effectiveModelSpec` rather than the stored spec, for the reason that method
   * exists: the stored value can be null or an un-normalized alias, and a dataset
   * whose `model` column holds three spellings of one model cannot be grouped by
   * it.
   */
  private analyticsModel(): ModelDimensions {
    return this.analyticsModelOf(this.effectiveModelSpec());
  }

  /**
   * The same two dimensions for an arbitrary resolved spec.
   *
   * `parseModelSpec` throws on a shape it does not recognise, and `report.spec`
   * arrives from twenty-five producers rather than from the registry — so a
   * malformed one is a real possibility here in a way it is not for
   * `effectiveModelSpec`. It costs the row its two dimensions and nothing else;
   * throwing would cost the caller its turn.
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

  /** What a usage report costs at the catalog rate the model carries now —
   *  the fleet row's price, undefined when the catalog has no rate for it. */
  private priceAt(usage: Usage): number | undefined {
    const pricing = this.modelCatalog.pricing();

    return pricing ? priceCall(usage, pricing)?.usd : undefined;
  }

  /** Durable per-session compaction state (plan snapshot + the measured
   *  prompt-token trigger signal) in DO SQLite. Table created in ensureSchema.
   *
   *  LAZY, and the registration below moves with it: both resolve this actor's
   *  handle, whose directory row does not exist until `ensureSchema` runs.
   *  Resolving either in the constructor makes construction throw on a fresh
   *  database — every harness and every cold activation — before anything has
   *  created the schema. */
  private _compactionState: CompactionStateStore | null = null;
  protected get compactionState(): CompactionStateStore {
    return (this._compactionState ??= createCompactionStateStore(this.boundSql, this.actorHandle()));
  }

  /** Durable-history length (ModelMessage count) at the in-flight turn's
   *  assembly — the length the turn's prompt-token measurement is bound to. */
  protected _turnDurableLength = 0;

  /** `agent.compactNow()` — the agent folding a finished phase itself instead
   *  of waiting for the token trigger. It rides the SAME one-shot flag
   *  overflow recovery arms, so there is one forced-rebuild path and a repeat
   *  call can never loop the ladder. The in-flight turn's context is already
   *  assembled, so the fold lands on the next one. */
  armCompactNow(): void {
    this.compactionState.armForceCompaction(this.name);
  }

  /** One compaction logger for both compaction entries — the per-turn extension and the
   *  swarm shared-prefix ladder — so the two cannot drift into different outcome names. */
  private readonly compactionLogger: CompactionLogger = {
    info: (message, data) => this.logActivity('compaction', compactionLogDetail(message, data)),
    debug: (message) => diagnostics.event('compaction.debug', { message }),
    // `degraded`/`failed` rather than `warn`/`error`: a level is not an outcome, and these two names
    // are shared verbatim with `cli-backend/src/local-session.ts`, which adapts the same
    // `@better-compact/core` Logger port to the same outcomes. One query reads both backends.
    warn: (message, data) => {
      diagnostics.failure('compaction.degraded', new KinuError('unavailable', message));
      this.logActivity('compaction_warn', compactionLogDetail(message, data));
    },
    error: (message, data) => {
      diagnostics.failure('compaction.failed', new KinuError('io', message));
      this.logActivity('compaction_error', compactionLogDetail(message, data));
    },
  };

  /** Better-compact is THE default (and only) compaction path: the staged
   *  pruning ladder runs as a transformContext extension once per turn
   *  assembly, replaying its persisted plan byte-stably until the context
   *  regrows. Registered unconditionally, but from `ensureSchema` rather than
   *  the constructor: its plan port resolves this actor's handle, which needs
   *  the directory row `ensureSchema` creates. Every other port dereferences
   *  `this` lazily, so nothing heavy (the CF runtime, the model) is built
   *  before it is first needed. */
  /** The compaction extension this actor registered, handed to every turn the
   *  loop runs; core adds the inbox's own turn extension itself. */
  private _compactionExtension: KinuExtension | null = null;

  protected registerCompactionExtension(): void {
    this._compactionExtension = createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => this.rt.storage.vfs),
        plans: this.compactionState.plans,
        logger: this.compactionLogger,
      },
      archive: this.compactionState.archive,
      // The sink the summarizer already accepts, finally passed. `compaction`
      // was a declared SPEND_SOURCE that could never appear in the panel:
      // folding history is the producer that fires precisely when a
      // conversation got expensive, so the workspace total understated exactly
      // the sessions an owner asks about.
      summarize: createModelSummarizer(() => this.getModel(), {
        source: 'compaction', report: (report) => this.reportModelCall(report),
        operations: this.modelOperations,
      }),
      // The ladder's first rung prunes this plane before any tool output.
      ephemeral: this.dynamicLedger,
      onOutcome: ({ outcome }) => {
        // The model-visible stream changed shape — a NEW plan rewrote it
        // ('planned') or a cached plan was discarded after a history rewrite
        // ('invalidated') — so the dynamic ledger's frozen block positions
        // are meaningless. This fires inside runTransformContext, BEFORE the
        // turn's first step weave, so the next weave starts over with one
        // fresh block at the tail. A byte-stable replay keeps positions valid.
        if (outcome !== 'replayed') this.dynamicLedger.reset();
      },
    });
    this.extensions.register(this._compactionExtension);
  }

  /** Persist the verified connect-ticket scopes, the CLI bearer behind them,
   *  the browser session behind a cookie-authenticated connection (edge-set
   *  headers, see appendIdentityHeaders) AND the actor this socket addressed
   *  as connection tags — tags ride the WebSocket attachment, so the rpc gate,
   *  both identities and the pane's own chat room survive DO hibernation. */
  override async getConnectionTags(connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const tags = await super.getConnectionTags(connection, ctx);
    const scopeTag = cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER));
    const bearerTag = cliBearerConnectionTag(ctx.request.headers.get(CLI_BEARER_HEADER));
    const sessionTag = sessionBearerConnectionTag(ctx.request.headers.get(SESSION_BEARER_HEADER));
    // The path reaches this object UNCHANGED (server.ts routes a hosted
    // actor's chat without rewriting it), so the addressed actor is readable
    // right here and nowhere later.
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
   * Close every CLI websocket admitted before `generation`.
   *
   * Called by the owner's UserDO the moment it records a revocation, and it is
   * the half a per-frame check cannot cover: a client that says nothing sends
   * no frames, while the connection it is holding keeps RECEIVING this
   * workspace's stream. A revoked CI token has to lose that too.
   *
   * Best-effort by construction, and the frame-time check is what makes the
   * revocation true either way — this only makes it immediate. A connection
   * whose recorded bearer cannot be read is closed rather than kept, because
   * there is nothing left to compare it against.
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
   * Close every websocket that authenticated on the named browser session.
   *
   * The session-side twin of {@link closeRevokedCliSockets}, called by the
   * owner's UserDO the moment a logout deletes the session's row. A copied
   * cookie that opened this socket keeps RECEIVING the workspace's stream
   * after the cookie is dead, for exactly as long as it says nothing — the
   * frame-time check below can never reach it, so the revocation has to push.
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
   * Refuse a frame from a connection whose authority is gone. That is the
   * CLI bearer it upgraded with, or the browser session behind its cookie.
   *
   * FRAME TIME, AND AGAINST THE AUTHORITY, because the upgrade checks each
   * exactly once: revoke the token or log out the session afterwards and a
   * socket trusted at upgrade keeps its full @callable surface until the
   * client disconnects, which for a CI runner is as long as it likes. A
   * hibernated connection resumes without passing the upgrade again, so the
   * upgrade check alone never sees it go stale.
   *
   * The question goes to the UserDO that owns the revocation, so there is no
   * cached verdict to be stale. Only connections carrying an identity tag pay
   * for it: an untagged connection is not one this edge ever admitted to a
   * workspace websocket. A UserDO that cannot be reached refuses the frame —
   * the alternative is a socket that keeps acting precisely when its authority
   * cannot be confirmed.
   */
  private async refuseRevokedSocketAuthority(connection: Connection, message: WSMessage): Promise<boolean> {
    const denial = await this.socketAuthorityDenial(connection);

    if (denial === null) return false;
    const rpc = parseClientRpcFrame(message);

    // TWO ANSWERS, because they are read by two different things. The rpc reply
    // carries the authority's own WHY — a pending call fails with a reason
    // instead of hanging until it notices the close — while the close reason is
    // the standing instruction for the token kind, which is the line a human
    // sees when the socket goes away. Collapsing them put a store-level
    // sentence about the token where the client's next step belongs.
    if (rpc) connection.send(JSON.stringify({ type: 'rpc', id: rpc.id, success: false, error: denial.why }));
    connection.close(WEBSOCKET_POLICY_CLOSE, denial.close);
    diagnostics.event('auth.socket_frame_denied', { outcome: 'denied', reason: 'authority_not_live' });

    return true;
  }

  /** Why this connection's authority cannot act, and what to tell the
   *  client to do about it — or null when it may act.
   *
   *  Names the CLI bearer and the browser session in ONE question, because
   *  revocation has one design and two token kinds: each check fails closed
   *  on its own, and a connection carrying both is refused by whichever died.
   *  The instruction is the kind's, not the store's: `kinu auth` for a bearer,
   *  a fresh sign-in for a cookie. */
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

      // A session denial is already written as an instruction — signed out,
      // unreadable, unconfirmable — so it is its own close reason.
      if (denial !== null) return { why: denial, close: denial };
    }

    return null;
  }

  /** The session-side frame check. An unreadable tag is a refusal for the same
   *  reason an unreadable CLI bearer is; a UserDO that cannot be reached is
   *  one too, and for the same reason: the socket keeps acting precisely when
   *  its authority cannot be confirmed. */
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

  /**
   * Why this connection's CLI bearer cannot act, or null when it may.
   *
   *  A generation from the FUTURE is refused as well: this workspace is asking
   *  the object that owns the counter, so a connection claiming to have been
   *  admitted under a later authority state than the account has ever reached
   *  is not a socket to keep. */
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
      || !!ctx.request.headers.get(CLI_SCOPES_HEADER);
  }

  private _rt: CFRuntime | null = null;
  /** Backend-agnostic per-turn accounting (tool calls, steps, usage, errors).
   *  Lazily built with cf sinks → activity_log + the durable run-event recorder.
   *  Shared with the CLI backend (core/orchestrator/turn-accumulator). */
  // The backend-agnostic agent logic (per-turn accounting + session-evolution
  // cadence + the event→turn reactor). The DO provides the BackendHost
  // (broadcast + programmatic-turn via saveMessages) + the cf sinks. The CLI
  // backend builds the same AgentOrchestrator with its own host.
  /**
   * THE ONE ActorSession for the workspace root. The subordinate host builds
   * every child's session from these same seams (`actor-hosting.ts`); the root
   * builds its own here, synchronously, because `onStart` may not await and
   * every turn of this actor claims against it.
   */
  private _actorSession: ActorSession | null = null;
  protected get actorSession(): ActorSession {
    if (!this._actorSession) {
      this._actorSession = new ActorSession({
        runtime: this.rt,
        claims: this.stores.claims,
        installedBuild: this.installedBuildIdentity(),
        events: this.stores.eventRecorder,
        orchestration: this.orchestrationDeps(),
      });
    }

    return this._actorSession;
  }

  /** The turn loop, from core — see {@link ChatSession} for the invariants.
   *  This actor is its adapter: the driver API delegates to it, and the ports
   *  it was built over are this actor's own methods. */
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
        // A synchronous run inside a Durable Object is already atomic;
        // answering through the platform's own primitive keeps the commit one
        // unit whatever core comes to put between the statements.
        transaction: (body) => this.ctx.storage.transactionSync(body),
        transport: this.chatTransport,
        mintAnswerId: () => this.mintAnswerId(),
        ports: {
          prepareTurn: (item, lease) => this.prepareTurn(item, lease),
          owedTerminalEffects: (input) => this.owedTerminalEffects(input),
          terminal: () => this.terminal,
          taskList: () => this.stores.taskList,
          // A running job's own settle wakes the session: a reminder fired
          // behind it would race that wake.
          hasPendingAsyncWake: () => this.stores.jobs.listRunning(1).total > 0,
          holdTerminalClose: (transition, close) => { this.holdTerminalClose(transition, close); },
          driverGate: () => this.driverGate(),
          // The workspace UI IS the review surface: a plan turn is admitted.
          planTurnRefusal: () => null,
          // Prompt-cache warming is the ROOT actor's: it owns the workspace's
          // one wake chain and the conversation whose prefix stays warm. A
          // hosted actor's own loop wires none, so its turns arm nothing.
          ...(this.cacheWarmingLane() && { cacheWarming: this.cacheWarmingLane() }),
          // The turn's own wake at its open: a kill mid-turn leaves the run
          // row AND the wake that re-drives what it owed. The loop names the
          // instant; the tick keeps a row while the turn is open.
          armTurnWake: async (atMs) => { await this.scheduleTerminalRetry(atMs); },
          modelWindow: () => ({
            contextWindow: this.sessionContextWindow(),
            modelOutputLimit: this.modelCatalog.modelOutputLimit(),
          }),
          steerSkills: (text) => steerSkillsBlock({
            vfs: this.getSkillsVfs(),
            config: this.config,
            userText: text,
            trust: this.instructionTrust(),
            limits: { contextWindow: this.sessionContextWindow(), modelOutputLimit: this.modelCatalog.modelOutputLimit() },
            alreadyActive: new Set(this._turnActiveSkills?.active.map((skill) => skill.name) ?? []),
          }),
        },
      });
      this.chatTranscript.answersFrom({
        answer: (id) => this.chatTransport.answer(id),
        streamed: (id) => this.chatTransport.streamed(id),
      });
      this.observeFleetRows();
      // The working history this activation resumes from — the recorded
      // working revision, else the transcript — BEFORE the loop's first pump,
      // which the constructor deferred to a microtask: a turn re-opened from
      // the ledger continues over the conversation it was admitted against.
      this._chatLoop.restoreHistory();
    }

    return this._chatLoop;
  }

  /** The chat protocol over this actor's sockets — core's ChatTransport on the
   *  SDK's own primitives. What it asks of the actor is the connection set,
   *  the transcript as the client sees it, and the loop's driver API. */
  private _chatTransport: ChatWireTransport | null = null;
  protected get chatTransport(): ChatWireTransport {
    if (!this._chatTransport) {
      this._chatTransport = new ChatWireTransport({
        sql: this.boundSql,
        broadcast: (message, exclude) => { this.broadcastToActor(null, message, exclude); },
        getConnection: (id) => this.getConnection(id),
        history: () => this.chatTranscript.history(),
        // Held by the loop: as a row once it landed, as a reservation from
        // the moment the send was accepted until then.
        admitted: (id) => this.chatTranscript.has(id) || this.pendingSends.has(id),
        send: (input) => this.chatLoop.send({ text: input.text, files: input.files }, { id: input.id, mode: input.mode }),
        interrupt: () => { this.chatLoop.interrupt(); },
        clear: () => this.clearConversation(),
      });
    }

    return this._chatTransport;
  }

  /**
   * Send to the sockets that addressed ONE actor, and to no others.
   *
   * The object's own `broadcast` reaches every connection, which is exactly
   * what a shared room is: the root's chat frames landed in a hired agent's
   * pane and the agent's in the workspace's. The addressed actor is a
   * connection TAG, so the recipient set is "every connection whose actor tag
   * is this one" — and for the root that is every connection carrying NO
   * actor tag, which `getConnections(tag)` cannot express and this can.
   *
   * Still emitted through `broadcast`, deliberately: it is the object's one
   * fan-out and the only thing that knows how to write to a hibernated
   * socket, so the scoping is expressed as the EXCLUSION of every connection
   * outside the set rather than as a second send path beside it.
   */
  protected broadcastToActor(actor: string | null, message: string, exclude?: readonly string[]): void {
    const elsewhere: string[] = [];

    for (const connection of this.getConnections()) {
      if (actorFromConnectionTags(connection.tags) !== actor) elsewhere.push(connection.id);
    }

    this.broadcast(message, [...new Set([...(exclude ?? []), ...elsewhere])]);
  }

  /** The chat rooms of this object: the root's transport, and one per hosted
   *  actor a socket has addressed by name. */
  private _chatRooms: ActorChatRooms | null = null;
  protected get chatRooms(): ActorChatRooms {
    return this._chatRooms ??= new ActorChatRooms(() => this.chatTransport, (name) => this.hostedChatWire(name));
  }

  /** The room one socket's chat frames belong to, resolved from the actor it
   *  addressed; null when that actor is no longer hosted here. */
  protected chatRoomFor(connection: Connection): ChatWireTransport | null {
    return this.chatRooms.for(actorFromConnectionTags(connection.tags));
  }

  /** One hosted actor's chat wire — its transcript, its queue and its own
   *  connections — or null when this workspace hosts no such actor. Only the
   *  workspace root knows its directory, so the wire is built there. */
  protected abstract hostedChatWire(name: string): ChatWire | null;

  protected get orch(): AgentOrchestrator { return this.actorSession.orchestrator; }

  /** What the settled turn owes, as this actor's roster declares it. */
  protected abstract owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[];

  /** The orchestration this actor's session runs over: the host seam, the
   *  engine, the event log, the governor, and the cf sinks. */
  private orchestrationDeps(): AgentOrchestratorDeps {
    {
      return {
        host: this.host,
        engine: this.engine,
        eventLog: this.eventLog,
        budget: this.budget,
        // The refinement lane runs on the ONE off-turn cadence pass, beside the
        // promotion gate's trials. Every actor wires it: a facet accrues
        // evolution debt like any agent, and its refiner is the port above.
        refinementLane: () => this.runRefinementLane(),
        sinks: {
          logActivity: (e, d) => {
            // Time to first token, at the accumulator's own once-only latch —
            // the activity line it writes for it. Measured from the turn's own
            // start, so it is USER-VISIBLE first token on whatever provider
            // served it, not a transport first byte.
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
            // The fleet row first, because the durable emit below is the one that
            // can throw and a caught failure there must not also cost the count.
            // Name, verdict and duration only: `ev` carries `args` and `result`,
            // which are whatever the user's workspace contains.
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

  /** The actor's mission budget governor — the cumulative cap a scheduled run
   *  or a fork opts into. Its refusals land in the run's durable event log next
   *  to `context_budget`; with no active label it costs nothing. Public so the
   *  `agent.*` self-direction namespace declares and reads budgets through the
   *  same object the two enforcement seams hold. */
  private _budget: MissionGovernor | null = null;
  get budget(): MissionGovernor {
    this._budget ??= new MissionGovernor({
      actor: this.actorHandle(),
      storage: this.rt.storage,
      // Real USD: the catalog rates for whatever model the next turn resolves
      // to. Null until the lookup lands — the ledger then blends, and says so.
      pricing: () => this.modelCatalog.pricing(),
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
   * The mission ledger, reached from a facet.
   *
   * A forked head runs as its own Durable Object with its own storage and its
   * own resolved model, so the governed `LLM` the fork seam wraps never sees
   * the calls it actually makes. These two are the ledger's other end: the head
   * guards before each step and debits after it, over a cross-DO stub back to
   * the actor that declared the budget.
   *
   * NOT `@callable`: cross-DO stub RPC never needed the decorator, and a
   * spend ledger must not be writable over the public WS/HTTP transport. They
   * are also inert without labels — `guard`/`debit` with an empty label set
   * return immediately and touch no storage — so an unbudgeted head that
   * somehow called them would still not create a cap.
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
   * A facet's non-turn model call, filed in the ROOT workspace's event log.
   *
   * Same reason the mission ledger and the head journal are reached this way: a
   * facet has its own SQLite, so a row it wrote locally would strand a
   * workspace's spend one Durable Object away from the total that has to
   * account for it. The owner asks what the WORKSPACE cost, and a recursive
   * split's merge synthesis is part of that answer.
   *
   * Not `@callable`, exactly like `missionDebit`: a spend record must not be
   * writable over the public WS/HTTP transport. Allowlisted in rpc-surface.ts.
   */
  async reportFacetModelCall(report: ModelCallReport): Promise<void> {
    this.reportModelCall(report);
  }

  /** A facet's model-operation frames (the begin/end pair around one non-turn
   *  call), to the same root log as reportFacetModelCall — an operation row
   *  explains a spend row, so neither may strand in facet SQLite. Same
   *  non-@callable, rpc-surface-allowlisted discipline as its twin above. */
  async reportFacetModelOperation(event: ModelOperationEvent): Promise<void> {
    this.modelOperations(event);
  }

  // ── The subtree's head journal, over this actor's control plane ──────
  //
  // A recursive split runs in this isolate against the workspace's journal, so
  // its spawn and report rows land where the head_steps they must join against
  // already are. These four are the writes HeadController performs, exposed as
  // methods the hosted split port calls locally (orchestrator.ts
  // `runHostedSplit`): never `@callable`, allowlisted in rpc-surface.ts.

  async headJournalRecordSplit(rootId: HeadId, rationale: string, spawnedAt: number): Promise<void> {
    this.headJournal.recordSplit(rootId, rationale, spawnedAt);
  }

  async headJournalInsertSpawn(input: HeadInput): Promise<void> {
    this.headJournal.insertSpawn(input);
  }

  async headJournalRecordReport(report: HeadReport): Promise<void> {
    // The announcement is the JOURNAL's, not this method's: every report
    // publishes its summary, status and wall clock through that one write,
    // regardless of which producer records it. This method delegates the
    // write without adding another broadcast.
    this.headJournal.recordReport(report);
  }

  async headJournalCacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): Promise<void> {
    this.headJournal.cacheMerge(rootId, result, strategy);
  }

  /** The owner while this activation's evolution recovery fiber is live. */
  private _evolutionSettling: AsyncTaskOwner | null = null;

  /**
   * Settle the evolution this turn dispatched, inside a DURABLE fiber — the cf
   * peer of the CLI's `await orch.settleEvolution()` before process exit.
   *
   * Evolution is deliberately detached so it never blocks Think's TurnQueue,
   * but its LLM calls (outcome classification, reflection, session reflection)
   * take 5-30s and outlive the request that woke the DO.
   *
   * A FIBER RATHER THAN A BARE `keepAliveWhile`, and that is the whole of this
   * change. `keepAlive` only resets the idle timer: it holds the object open
   * against inactivity and buys nothing against a deploy, a runtime restart or
   * an alarm-boundary reset, which are the evictions nobody schedules. When one
   * of those landed here the lane simply vanished — no row, no event, nothing to
   * resume from, and the durable window it had claimed sat un-drained until some
   * later turn happened to fill it again. `runFiber` holds the SAME heartbeat
   * (it takes `keepAlive()` for the duration) AND writes a `cf_agents_runs` row
   * with the stashed lane identity, so an interrupted lane is handed to
   * {@link onFiberRecovered} on the next activation — alarm-driven, with no
   * client and no request required.
   *
   * The stash carries the lane name and nothing else, because nothing else is
   * needed: every unit of work below is driven by a DURABLE queue or window
   * (the shadow-trial queue, the session window), so re-entry reads its input
   * from storage rather than from a snapshot of an in-memory turn.
   *
   * Fire-and-forget by construction: awaiting it here would re-block the queue.
   * One lane at a time — settleEvolution() drains whatever is in flight when it
   * runs, so a turn that completes while a lane is live is already covered.
   *
   * BOTH evolution lanes run here (core's exit contract): the turn lane via
   * settleEvolution(), and the cadence session pass via
   * runDueSessionEvolution(). The DO is the host that CAN afford the heavy
   * pass, so unlike `kinu exec` it waits for it rather than carrying it forward.
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
   * Establish this user's MCP connections for the NEXT turn, off this one.
   *
   * `userMcp_toolDescriptors` reads a connection snapshot and starts nothing:
   * it is on the turn's critical path, and hydrating there awaited an unbounded
   * `_connectWithRetry` (`agents/dist/client-zqKcsyFa.js:2046`). Establishment
   * therefore belongs off the turn, and the HTTP first-hit warmup
   * (`user/routes.ts`) covers only the first INTERACTIVE turn — an alarm, an
   * inbound email or a peer's task wakes a workspace with no request behind it,
   * and after an eviction the isolate's first-hit flag is already spent. Without
   * this those turns would report every server unavailable forever.
   *
   * ONE authority: the same `userMcp_warmConnections` the HTTP path calls, with
   * this actor's own capability. Nothing new is stored and nothing is scheduled
   * on a clock — the trigger is the settle that just happened.
   *
   * DETACHED, on a durable fiber, for the reason the evolution lane is: this
   * runs inside Think's TurnQueue and awaiting a third-party connect here would
   * hold the next message behind it. A failure is named and dropped; the next
   * settled turn warms again, so the retry needs no record. One autonomous or
   * post-eviction turn may honestly lack MCP tools and says so on its surface.
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

          // The same gate `buildUserMcpTools` uses, for the same reason: an owned
          // workspace that has not been issued a capability token yet reaches
          // nothing, and that is an ordinary state rather than a failure to report.
          // Asked rather than caught, so a real failure reading one still travels.
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

  /** The advisor's whole input, recorded by the roster that OWES the review
   *  while the turn is still in memory: an advisor that re-derived
   *  `reachable` on a cold activation would review a different tool surface
   *  from the one the turn ran with. `reachable` is the turn's OWN ToolSet
   *  keys — what the actor demonstrably had, not what this actor class can
   *  have — as the loop reports them at the settle. */
  protected advisorSnapshotFor(turn: CompletedTurn, reachable: readonly string[]): AdvisorRecoverySnapshot {
    return {
      turn,
      reachable: [...reachable],
      minSeverity: this.config.getAdvisorMinSeverity(),
      recent: [...this.engine.recentAdvisorNotes()],
    };
  }

  private readonly _advisorReviewTasks = new Map<string, AsyncTaskOwner>();

  /**
   * The advisor lane: one review of the turn that just ended, started on its
   * own durable lane. Resolves once that lane has CHECKPOINTED, not once the
   * review is done.
   *
   * Detached because it is a model call on a path the turn queue is holding,
   * and durable because a deploy or an alarm-boundary reset would otherwise
   * take the review with it, leaving no row and no event. A reviewer that
   * FAILS leaves a turn with no advice, never a failed turn.
   *
   * The caller is a terminal effect, and what it owes is a recoverable review
   * rather than a finished one. Resolving at the checkpoint is what makes those
   * the same thing: before it, an eviction between the effect's completion and
   * the fiber's first tick left recovery reading a null snapshot and
   * terminalizing a review that never ran. After it, the fiber is re-drivable
   * on its own.
   *
   * The stash carries the WHOLE review: the completed turn, the tool names it
   * ran with, the severity floor and the dedupe window. That snapshot is what
   * makes {@link recoverAdvisorLane} a re-drive rather than an obituary.
   * `AdvisorRecoverySnapshotSchema` mirrors the lane's own deps through the same
   * `CompletedTurnSchema` the `completed_turns` table persists a turn with, so
   * the size policy lives upstream where the turn's parts are clamped.
   *
   * The snapshot is recorded by the roster at the settle, BEFORE the fiber
   * starts: `runFiber` awaits `keepAlive()` before it runs the body, and a
   * read inside would come after that await, which is how a later turn's tool
   * set would bleed into this turn's review.
   *
   * Governed off the TURN's labels rather than the governor's active scope, as
   * the engine's own review is: this runs after the turn ended, when the active
   * scope is either empty or some later turn's. There is no completion gate on
   * this backend (it is the one-shot CLI surface's mechanism), so `gateOpen` is
   * false here by construction.
   */
  protected reviewTurnInBackground(turn: CompletedTurn, snapshot: AdvisorRecoverySnapshot): Promise<void> {
    if (this.rt.advisorLlm === undefined || !this.config.getAdvisorEnabled()) return Promise.resolve();

    // ONE lane per turn, ever STARTED. A terminal replay arriving after the
    // checkpoint but before its row recorded `completed` would otherwise open a
    // second fiber beside the first — which the SDK can still recover — and two
    // advisors would review one turn, each spending a model call and appending
    // its own note. Recovery re-drives the fiber this accepted; it does not come
    // back through here. An unkeyed turn has no replay to guard against.
    if (advisorLaneStarted(this.boundSql, this.actorHandle(), turn)) return Promise.resolve();
    const checkpointed = Promise.withResolvers<void>();
    const taskKey = nanoid();
    const owner: AsyncTaskOwner = { promise: null };
    this._advisorReviewTasks.set(taskKey, owner);
    owner.promise = (async () => {
      try {
        await this.runFiber(ADVISOR_LANE_FIBER, async (ctx) => {
          // The checkpoint IS what the caller owes. A lane that could not write one
          // is a review no eviction can resume, so the failure travels to the owed
          // row rather than being absorbed here — the earlier "named and dropped"
          // reported an unrecoverable lane as a completed obligation.
          try {
            ctx.stash(snapshot);
          } catch (cause) {
            const failure = toKinuError({
              doing: 'checkpointing the advisor review so an eviction can resume it',
              cause,
              otherwise: 'io',
            });

            diagnostics.failure('advisor.snapshot_failed', failure, { turnId: turn.turnId ?? '(none)' });
            checkpointed.reject(failure);
            // The caller owes a resumable review, not a finished one: a body that
            // returned here would let the fiber retire as complete with no
            // checkpoint on disk, so the same rejection the owed row already sees
            // must reach the lane catch below, which records it as lane work.
            throw failure;
          }

          // Adjacent to the stash: from this instant the lane is recoverable on its
          // own, which is exactly when a second one becomes a duplicate.
          markAdvisorLaneStarted(this.boundSql, this.actorHandle(), turn);
          checkpointed.resolve();
          await this.runAdvisorReview(snapshot);
        });
      } catch (cause) {
        const failure = toKinuError({
          doing: 'reviewing the completed turn',
          cause,
          otherwise: 'unavailable',
        });

        diagnostics.failure('advisor.review_failed', failure);
        // A fiber that never reached its body leaves the caller waiting on a
        // checkpoint that will never be written. Rejecting is what keeps the row
        // owed; once the stash landed, this settles nothing and the review's own
        // failure is the lane's, not the ledger's.
        checkpointed.reject(failure);
      } finally {
        if (this._advisorReviewTasks.get(taskKey) === owner) {
          this._advisorReviewTasks.delete(taskKey);
        }
      }
    })();

    return checkpointed.promise;
  }

  /**
   * One review, from a snapshot — the single body both the live lane and its
   * recovery run.
   *
   * Shared rather than duplicated because the two would drift on exactly the
   * fields that matter: a recovery that re-derived `reachable` from the CURRENT
   * tool set, or `recent` from the CURRENT dedupe window, would be reviewing a
   * turn against a world it did not run in. The three deps NOT in the snapshot
   * are the three that must be re-resolved by whoever is running: the advisor
   * model (through `rt.advisorLlm`, which resolves the 'advisor' lane off the
   * routing profile — a fixed tier, so it is answerable on a cold activation
   * with no turn), the signal seam, and the note store.
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
   * The scaffold evolution control plane's view of this actor: the four ports
   * a candidate loop runs against, plus the two models it needs. The plane
   * itself is core's (evolution/control.ts); this is the whole of what being a
   * Durable Object contributes to it.
   *
   * On the substrate rather than on the orchestrator because the shadow trial
   * queue above fills for EVERY actor, and a facet with a control plane it
   * cannot reach would score no proposal at all.
   */
  protected get scaffoldControl(): ScaffoldControl {
    return {
      rt: this.rt,
      events: this.eventRecorder,
      sql: this.boundSql,
      config: this.config,
      surface: (task, context, callScope) => createScaffoldCandidateSurface({
        rt: this.rt,
        profile: () => this.routingProfile([...Object.keys(this.getRawTools()), ...codemodeCapabilitiesFor(this.turnCodemodeProviders('build'))]),
        bindModel: spec => this.ownedModelServices.resolveModel(spec),
        modelContext: spec => this.modelCatalog.contextFor(spec),
        tools: () => this.getRawToolsForWorkMode(this.turnWorkMode(), callScope),
        callScope,
        history: this.makeScaffoldHistory(),
        spend: this.scaffoldSpend(),
      }, task, context),
      // The scaffold plane's own chat model. `scaffold` is a FIXED tier in
      // MODEL_ROUTE_POLICY, so a candidate is judged on the tier the account
      // assigned that work rather than on whatever the turn happened to run.
      model: async () => (await this.modelForSource('scaffold')).model,
      judge: createJsonJudge(() => this.getModelForReview()),
      // The two halves of the plane's attribution, which the actor never wired:
      // the reflection LM that rewrites the scaffold had no sink at all.
      reportModelCall: (report) => this.reportModelCall(report),
      operations: this.modelOperations,
    };
  }

  /**
   * The continual-refinement lane's view of this actor.
   *
   * Four existing seams and nothing new: the scaffold control plane (so a
   * refinement is measured by the same judge as everything else about this
   * agent), the one `agent_facts` authority, the temporary-agent port that IS
   * the read-only refiner, and the owner's instruction-trust authority a
   * proposed skill's digest is reported to.
   *
   * On the substrate rather than on the orchestrator for the same reason
   * `scaffoldControl` is: a facet accrues evolution debt like any actor, and one
   * that could not reach the lane would accumulate corrections nothing reviews.
   */
  protected get refinementDeps(): RefinementDeps {
    return {
      control: this.scaffoldControl,
      facts: this.facts,
      refiner: this.temporaryAgentPort(),
      approvals: this.instructionApprovals(),
    };
  }

  /**
   * One step of the continual-refinement lane, plus the automatic trigger.
   *
   * Both halves are core policy over {@link refinementDeps}; the order is the
   * only thing decided here, and it is decided once: open what the debt owes,
   * then advance one request. Opening first means a workspace that has just
   * crossed the threshold does not wait a whole cadence to be looked at.
   *
   * Awaited by the cadence pass, so an eviction mid-lane leaves a `planning`
   * claim the next activation re-queues. The refiner is read only — re-driving
   * a claim can cost one child agent and can never double-apply.
   */
  protected async runRefinementLane(): Promise<void> {
    const deps = this.refinementDeps;
    await refinementDebtRequest(deps);
    await advanceRefinementLane(deps);
  }

  /** The scaffold's host.llmStream bridge (core scaffold-host): tool names
   *  resolve against the RAW surface per call, multi-step, scaffold-stage
   *  reasoning effort. No step cap here — the scaffold's loop runs exactly as
   *  long as the live turn it may replace would (owner ruling, 2026-08-21), so
   *  comparisons between them measure the scaffold, not a handicap. */
  protected makeScaffoldLLMStream(signal?: AbortSignal): ScaffoldRunOptions['llmStream'] {
    return createScaffoldCandidateSurface({
      rt: this.rt,
      profile: () => this.routingProfile([...Object.keys(this.getRawTools()), ...codemodeCapabilitiesFor(this.turnCodemodeProviders('build'))]),
      bindModel: spec => this.ownedModelServices.resolveModel(spec),
      modelContext: spec => this.modelCatalog.contextFor(spec),
      tools: () => this.getRawTools(),
      history: undefined,
      signal,
      spend: this.scaffoldSpend(),
    }, '').llmStream;
  }

  /**
   * The scaffold's host.callTool bridge (core scaffold-host) over this actor's
   * RAW ToolSet.
   *
   * `callScope` is the stable per-invocation id source. Without it every replay
   * of a rollout gave each call a fresh `scaffold-<now>` id, so the tool-effect
   * claim had nothing to match and a re-driven trial could send the same mail
   * twice. With it the ids are the scope plus the call's ordinal — which lines up
   * only as far as the rollout is deterministic, so this NARROWS the duplicate
   * window rather than closing it: a candidate whose model answers differently on
   * the replay makes different calls, and the claim then sees work that genuinely
   * is different.
   *
   * The scope is ALSO the claim's turn identity, because the call id is only
   * half the key. The other half is the ambient turn the surface was built with,
   * and a trial queued right after its turn reads that turn's checkpoint while
   * the same trial re-driven on a cold activation reads `WORKSPACE_RUN_ID` — so
   * `<scope>#0` missed its own prior claim and the call ran again. A rollout
   * with no scope keeps the ambient turn: nothing re-drives it, so it has
   * nothing to recognise.
   */
  protected makeScaffoldCallTool(callScope?: string, signal?: AbortSignal): NonNullable<ScaffoldRunOptions['callTool']> {
    if (callScope === undefined) return createScaffoldCallTool(() => this.getRawTools(), undefined, signal);
    // Built ONCE for the rollout and held: the thunk is asked per dispatch.
    let scoped: ToolSet | undefined;

    return createScaffoldCallTool(
      () => (scoped ??= this.getRawToolsForWorkMode(this.turnWorkMode(), callScope)),
      callScope, signal,
    );
  }

  /** The scaffold's host.history bridge (core scaffold-host): a read-only,
   *  budgeted page of THIS turn's prepared messages — the same stream the
   *  scaffold is the inference loop for. Read per call, so a scaffold running
   *  across a turn sees the messages as they stand when it looks. */
  protected makeScaffoldHistory(): NonNullable<ScaffoldRunOptions['history']> {
    return createScaffoldHistory(() => this.actorSession.history);
  }

  // The BackendHost the core orchestrator runs against. broadcast → DO fan-out;
  // enqueueTurn → Think.saveMessages (TurnQueue-serialized programmatic turn) —
  // the queued half of signal delivery, reached only through the core seam.
  private _host: BackendHost | null = null;
  private readonly _drainTimerTasks = new Map<string, AsyncTaskOwner>();
  protected get host(): BackendHost {
    if (!this._host) {
      const getHeadRuntime = () => this.getCFHeadRuntime();
      const armWake = this.durableWakeOwner();
      this._host = {
        broadcast: (event) => this.broadcast(JSON.stringify(event)),
        // Every programmatic turn — a wake, a drain, a rerun of the operator's
        // own words — is admitted by the ONE loop, behind everything queued,
        // under the producer's own name for the fact it announces.
        enqueueTurn: (input) => this.chatLoop.enqueueTurn(input),
        // A signal lands on the agent's next step, so this answers whether
        // there will be one. The read is synchronous and the seam's buffer
        // push happens in the same tick, so the turn observed here is the one
        // whose prepareStep will drain it (turns are TurnQueue-serialized); a
        // turn that settles first re-delivers the signal from settle().
        turnInFlight: () => this.chatLoop.turnInFlight(),
        // The drain-debounce timer. keepAliveWhile (the agents-SDK heartbeat
        // the evolution hooks already rely on) holds the DO through the window
        // + the drain so the debounced drain completes within the live
        // activation instead of racing eviction. If the DO dies anyway, the
        // events are still durable in the EventLog — the next ingress / cron
        // alarm / post-turn drain picks them up (delayed, never dropped).
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
        // Branching-heads runtime (Facet spawner + merge LLM), resolved lazily —
        // heads need the owner for UserDO auth, set by first-turn time.
        get headRuntime() { return getHeadRuntime(); },
      };

      // Assigned rather than spread, so an actor with no wake chain of its own
      // leaves the key ABSENT: core reads the seam's presence as the host's
      // claim that it can deliver a wake with nobody watching, and a stub would
      // make that claim falsely.
      if (armWake) this._host.reconcileDurableWake = armWake;
    }

    return this._host;
  }

  /** This actor's durable-wake owner, or null when its next wake is somebody
   *  else's event. Only a root that owns a Kinu timer chain can answer — see
   *  `BackendHost.reconcileDurableWake` and `OrchestratorAgent.armDurableWake`. */
  protected durableWakeOwner(): (() => void) | null {
    return null;
  }
  /** Executors whose tools ran this turn — debounces the last-active-executor
   *  write to one SQL upsert per executor per turn. Reset in beforeTurn. */
  protected _executorsUsedThisTurn = new Set<string>();
  // ── Tool cache: avoid rebuilding the built-in ToolSet + codemode types every turn ──
  protected _cachedTools: ToolSet | null = null;
  protected _cachedToolsKey: string = "";
  // ── User MCP tools cache ─────────────────────────────────────────────
  // Per-user MCP tools live in UserDO. Per turn we fetch the canonical
  // descriptor surface and cache the rebuilt closures against ITS CONTENT
  // HASH, so we rebuild exactly when the durable rows differ from what this
  // activation last served — across cold starts, edits, deletions and OAuth
  // completions alike. No watermark exists to lose or misread.
  private _mcpToolsCache: McpToolSurfaceCache<ToolSet> | null = null;
  /** Configured MCP servers whose tools did not make it onto this surface —
   *  rendered into the turn's dynamic context so their absence is legible. */
  private _mcpUnavailable: MissingCapability[] = [];

  private get mcpToolsCache(): McpToolSurfaceCache<ToolSet> {
    this._mcpToolsCache ??= new McpToolSurfaceCache<ToolSet>(async (descriptors) =>
      // The admitted surface arrives already claimed: `buildMcpToolSet` puts
      // every non-readOnly tool behind the same durable claim the natives run
      // under, with the same turn deps — the ambient closure, because this
      // cache is content-keyed and shared across turns. KINU-019: building
      // the adapters here and merging them unwrapped let an MCP effect start
      // unclaimed and replay after a reset.
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


  // The eval factory is built once per DO lifetime. Its sandbox
  // reads craftStore.list() on every execute call, so newly-saved tools appear
  // on the next eval invocation without any registry or cache
  // coherence work.
  private readonly _codemodeFactories = new Map<string, CodemodeFactory>();

  /** The stores every agent has, from core — one list both backends inherit,
   *  so a store added there exists for this actor too. Lazy inside: the bundle
   *  never touches `boundSql` until a store is first read, which is what lets
   *  it be built here rather than in the constructor body. */
  private readonly stores = createAgentStores(() => this.boundSql, () => this.actorHandle(), write => this.ctx.storage.transactionSync(write));

  private _liveHeadJournal: LiveHeadJournal | null = null;

  /**
   * The orchestrator's view of head activity (journal + runs + steps). Shared by
   * every head-journal write (the cross-DO facet RPCs, steer-as-branch) and
   * getHeadRuns (read path).
   *
   * ANNOUNCING, and that is the whole of the liveness fix. This handed out the
   * raw store, so every write core made through it — a node's spawn, its steps
   * on the unhosted path, its report, the settle — landed durably and told
   * nobody. Wrapping the one instance both paths already share is what makes a
   * search live without a line in `packages/core`, whose swarm runner carries no
   * progress seam to hang a callback on.
   */
  protected get headJournal(): HeadJournal {
    return (this._liveHeadJournal ??= new LiveHeadJournal(
      this.boundSql,
      this.actorHandle(),
      (headId: HeadId) => this.announceHeadActivity(headId),
    ));
  }

  /** Tell every open client that one branch's ledger moved. Ordering and
   *  failure isolation belong to {@link LiveHeadJournal}, which calls this only
   *  after its write has returned and never lets a throw here reach core.
   *
   *  Protected because a HOSTED actor's search announces through the same
   *  listener: the workspace owns the socket, whichever of its actors spawned
   *  the head whose row moved. */
  protected announceHeadActivity(headId: string): void {
    this.broadcast(JSON.stringify({ type: 'head_activity', headId }));
    const rootId = this.headJournal.readHead(headId)?.root_id ?? headId;

    if (!isSteerBranchRunId(rootId)) this.broadcastMctsProgress(rootId, 'head-activity');
  }

  /**
   * Paint what a running branch is producing right now — the transient half of
   * head liveness, beside {@link announceHeadActivity}'s durable half.
   *
   * BROADCAST ONLY: no SQL, no state, nothing read back. A frame is superseded
   * by the step that contains it, so a client that missed one is corrected by
   * the `head_activity` this actor sends when that step lands.
   *
   * The payload is core's {@link HeadStreamFrame}, declared once and spread
   * rather than rebuilt field by field; the channel name is spelled here beside
   * its twin above, which is also where the broadcast-wiring gate reads it.
   */
  protected publishHeadStreamFrame(frame: HeadStreamFrame): void {
    this.broadcast(JSON.stringify({ type: 'head_stream', ...frame }));
  }

  // Durable run-event recorder (Flue-style discriminated union, SSE-resumable).
  // Backed by `agent_log` rows of kind in {step, tool_call, tool_result,
  // reactor_decision}. The RunEventRecorder adapts the emit() API to the
  // unified log so the SSE stream and the events sidebar share one source of
  // truth.
  protected get eventRecorder(): RunEventRecorder {
    return this.stores.eventRecorder;
  }

  /** The fleet row, at the run ledger's own seal. Separate from the durable
   * run the loop just closed and deliberately not a projection of it:
   * `closeTurnRun` writes one workspace's own history, which is only readable
   * by opening that workspace, and the question this answers — are turns
   * getting slower, is one model failing, what is the fleet spending — cannot
   * be asked of a per-workspace log at all. It carries no message and no
   * error text; the classification and the numbers are the whole row. Read
   * at the `run_end` event itself, which the loop emits synchronously while
   * the accumulator still holds the turn's numbers.
   *
   * Only for runs the loop itself ran: the wake reconcile seals runs a dead
   * activation left open (`closeUnterminatedRuns`), and those seals carry no
   * turn — no accumulator numbers, no `startedAt` — so a row for one is a row
   * about whatever turn happens to be live. The loop's current run is the
   * membership: `closeRun` seals through this same event path while it is
   * still the current run, and a reconcile seal names a run the loop never
   * opened. */
  private _fleetRowsObserved = false;
  protected observeFleetRows(): void {
    if (this._fleetRowsObserved) return;
    this._fleetRowsObserved = true;
    this.eventRecorder.observe((event) => {
      if (event.type !== 'run_end') return;

      if (event.runId !== this._chatLoop?.currentRunId) return;
      recordTurnRow(this.env, {
        workspace: this.workspaceName(),
        agentKind: this.actorKind(),
        ...this.analyticsModel(),
        outcome: event.reason === 'completed' ? 'ok' : event.error === undefined ? 'refused' : 'failed',
        code: '',
        durationMs: this.acc.startedAt > 0 ? Date.now() - this.acc.startedAt : 0,
        steps: this.acc.stepCount,
        toolCalls: this.acc.toolCalls.length,
        usage: this.acc.usage,
        usd: this.priceAt(this.acc.usage),
      });
    });
  }

  /** The workspace's prompt-cache warming lane, for the root actor that owns
   *  one. Undefined here: a hosted actor (subordinate, exploration head, swarm
   *  node) has neither the workspace's wake chain nor the conversation whose
   *  prefix a refresh keeps alive. */
  protected cacheWarmingLane(): CacheWarmingLane | undefined {
    return undefined;
  }

  /** The actor's durable claim ledger — the identity a turn's effects are
   *  issued under. Exposed at the same visibility as the event log above
   *  because a subclass settles and recovers claims it did not admit. */
  protected get claims(): ActorClaimStore {
    return this.stores.claims;
  }

  /**
   * Record one non-turn model call in the durable run-event log.
   *
   * The turn loop's spend arrives as `step_finish` (`onStepEvent` above). This is
   * the other 25 producers — judges, the fast tier, the evolution engine,
   * compaction, a scaffold's own loop, the platform AI bindings. Same log,
   * same `Usage`; a `model_call` row rather
   * than a `step_finish` one, so a judge's cold prompt never enters the turn
   * loop's prefix-cache window.
   *
   * FILED UNDER THE CURRENT RUN, OR THE WORKSPACE. Half of these fire between
   * runs (an evolution pass on a fiber, an embedding backfill at boot), and
   * `_currentRunId` is empty then. Dropping those is the dishonesty this row
   * exists to remove, so they go to the reserved workspace id instead.
   *
   * PRICED ONLY WHERE THE RATE IS THE CALL'S OWN. The catalog session tracks the
   * ACTOR's model; a judge deliberately runs on a different one
   * (`selectJudgeModel` picks cross-family on purpose). Pricing a judge call at
   * the actor's rate would put a fabricated number in the ledger, so `usd` stays
   * absent unless the call ran on the very model the catalog resolved — and an
   * absent `usd` already means unpriced, never free.
   *
   * BOTH RULES ARE CORE'S NOW (`buildModelCallEvent`). The row shape and that
   * pricing guard were hand-written here, again in the fleet row below, and a
   * third time on the CLI — where the usage-field policy had drifted the other
   * way: this backend omitted `usage` when the provider reported nothing, so an
   * unmeasured call was indistinguishable from an unrecorded one to any reader
   * of both backends' ledgers. Core's rule is the CLI's stated one: `usage` is
   * always present, `{}` when unmeasured, because unmeasured spend must read as
   * unmeasured and never as free.
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

    // The fleet row. Every producer, not just the turn loop: a judge, the fast
    // tier, an evolution pass, a compaction fold. `spec` is what the caller
    // resolved and is absent on the seams that never had one, so the actor's own
    // effective model stands in — an absent model column would make the row
    // uncountable against the provider it actually reached.
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
      // The durable row's own number, not a second application of the guard —
      // re-deriving it here disagrees with the ledger whenever the catalog
      // resolves a rate between the two reads.
      usd: event.usd,
    });
  }

  /**
   * Where this actor's direct model operations record their start and end —
   * the same log, projected through core's one shared mapper so both backends
   * cannot drift. A start row with no end is the durable signature of a frame
   * the platform destroyed mid-call; nothing here reads a clock.
   */
  protected readonly modelOperations: ModelOperationSink = recordModelOperations(
    // The recorder is reached PER EMIT, not once here. A field initializer runs
    // inside the Durable Object constructor, and the actor-scoped store bundle
    // resolves the actor handle on first access — which needs the workspace
    // actor directory, and that does not exist until `onStart`. Forcing the
    // getter here therefore threw in the constructor of a cold actor. This is
    // the same rule `state/agent-stores.ts` states for its own laziness: a
    // Durable Object must not reach storage while field initializers run.
    { emit: (runId, input) => { this.eventRecorder.emit(runId, input); } },
    () => currentOperationProfile(this.actorHandle())?.runId ?? (this._currentRunId || WORKSPACE_RUN_ID),
  );

  /** A model request is about to sleep on a provider-mandated wait. The row
   *  lands in the run-event ledger (`provider_wait`) AND crosses the workspace
   *  socket, because the two surfaces that read them differ: the ledger is
   *  durable evidence of where a turn spent its time, the socket is what the
   *  open pane renders to say the agent is waiting, not thinking. A recorder
   *  fault is contained — a ledger write must never kill the sleep it was
   *  annotating (the listener inside the retry layer catches its own, but a
   *  throw here would still reach it). */
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

  // ── EventsHub: per-agent ingress + persistence + dispatch. ──────────────
  // Load-bearing primitives (spec §1):
  //   - `agent_log`     unified append-only ledger (initEventsHubTables)
  //   - EventLog        publish/pending/defer/dismiss/query
  //   - TriggerRegistry durable subscriptions (webhooks, timers, watches)
  //   - ReplyChannelStore  durable reply-channel rows + dispatchers
  // Spec: docs/ARCHITECTURE.md — "Events and ingress"
  private _eventLog: EventLog | null = null;
  protected get eventLog(): EventLog {
    if (!this._eventLog) {
      this._eventLog = new EventLog(this.ctx.storage.sql, this.actorHandle());
    }

    return this._eventLog;
  }
  // agent_facts world model — typed, idempotent, keyed.
  protected get facts(): FactsStore {
    return this.stores.facts;
  }

  // Background-job registry — work auto-detached past the 30s threshold (#173).
  protected get jobs(): BackgroundJobStore {
    return this.stores.jobs;
  }

  // The agent's own task list — written by the `tasks` tool, read here for the
  // live context block and by the Tasks surface.
  protected get taskList(): TaskListStore {
    return this.stores.taskList;
  }

  /** The scaffold is the program a turn executes (core reads it in
   *  scaffold/executor.ts), so its existence is a precondition of RUNNING A
   *  TURN — deliberately not of activating the Durable Object.
   *
   *  It must never be awaited from `onStart()`: partyserver runs `onStart` inside
   *  `ctx.blockConcurrencyWhile`, which `fetch`, `webSocketMessage`,
   *  `webSocketClose` and `alarm` all await, and the hosted file plane is a
   *  SECOND Durable Object. Awaiting it there stalls every request on this
   *  object — pure `@callable` reads included — for as long as that object takes
   *  to answer, and the Workers runtime cancels the block and resets the object
   *  at 30s (`do.block_concurrency.cancel_ms`). Measured: a bare `SELECT` took
   *  25212ms behind a filesystem object busy for 25s, against 266ms with the same
   *  object busy and a clean `onStart`.
   *
   *  Owner-gated because the hosted file plane is owner-namespaced, and latched
   *  per activation like `_schemaReady`: once this activation has seen the
   *  scaffold, later turns re-probe nothing. Protected for the same reason
   *  `_cachedSoulText` is: a harness with no filesystem declares the two
   *  file-backed turn preconditions satisfied rather than faking a filesystem. */
  protected _scaffoldReady = false;
  protected async ensureOwnedScaffold(): Promise<void> {
    if (this._scaffoldReady || !this.getOwnerUserId()) return;

    if (!(await this.rt.identity.scaffold.exists())) {
      await bootstrapScaffold(this.rt);
      diagnostics.event('scaffold.bootstrapped', { workspace: this.workspaceName() });
    }

    this._scaffoldReady = true;
  }

  // Durable MCTS search checkpoints — the resume record an `action:'swarm'`
  // search evicted mid-flight continues from (B6). One per DO; keyed by search
  // root id.
  protected get mctsSearchStore(): MctsSearchStore {
    return this.stores.mctsSearchStore;
  }

  /**
   * Push ONE search's tree to every connected client, after each of its MCTS
   * iterations. The one broadcast both producers use — the lifetime evolution
   * cycle and an agent-initiated `agents` fork (see getAgentsToolDeps). It sits
   * on `ActorAgent`, not on the orchestrator: an orchestrator-only broadcast is
   * reachable from the first of those alone, so a search an operator started
   * emits nothing and its tree sits still for as long as it runs.
   *
   * Scoped by the `rootId` the event carries, NOT by "which tree was written to
   * most recently". A workspace runs concurrent searches — two detached
   * `action:'swarm'` calls — and the latest-tree read made every event a coin
   * flip between them: one search's iteration shipped the other's nodes under
   * its own phase and budget, and a backpropagation (visits change, no insert,
   * so never "latest") was suppressed by the shared fingerprint as a no-change.
   *
   * Each payload carries BOTH durable halves of a run. `search_nodes` contains
   * scored candidates; the head journal is the only row for an agent node while
   * it is still working. Sending only the former made a live overlay replace a
   * poll's complete tree with a lone root until every node settled.
   *
   * `(isolateGen, pushSeq)` orders a root's frames. A cold isolate starts its
   * local sequence at one, so its persisted generation distinguishes that fresh
   * frame from a replay the prior isolate sent.
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

  /** The tree last pushed, per search. Per activation, which is the right
   *  lifetime: a reconnecting client is served by the surface's own poll, not by
   *  a resend. */
  private readonly _lastMctsFingerprint = new Map<string, string>();

  /** Last accepted live frame per root. A root's sequence never shares a
   * counter with another concurrent search. */
  private readonly _mctsPushSeq = new Map<string, number>();

  /** One MCTS progress event → the broadcast, whichever producer raised it. */
  protected onMctsProgress(event: MCTSProgressEvent): void {
    const phase = event.type === 'phase' ? event.phase : event.type;
    const budget = event.type === 'branch-failed' ? undefined : event.remainingBudget;
    this.broadcastMctsProgress(event.rootId, phase, event.iteration, budget);
  }
  // The backend-agnostic background-job lifecycle (detach → settle → wake +
  // cancel + evict-recovery), running over the durable fiber (rt.schedule.fiber)
  // and the BackendHost programmatic-turn wake. Owns the cancel-controller map.
  private _jobRunner: BackgroundJobRunner | null = null;
  protected get jobRunner(): BackgroundJobRunner {
    if (!this._jobRunner) {
      this._jobRunner = new BackgroundJobRunner({
        store: this.jobs,
        // The surface decides the FOREGROUND half — who watches the stream
        // decides what detaching costs. 30s keeps chat responsive; anything
        // with nobody watching wants its work finished in-turn. The WAKE half
        // never varies here: a DO outlives every turn (its alarms deliver
        // wakes with nobody connected, which is the whole recovery design), so
        // spawn-shaped work detaches on unwatched turns too.
        policy: () => invocationBackgroundPolicy(this.turnSurface(), true),
        fiber: this.rt.schedule.fiber,
        inbox: this.orch.inbox,
        eventLog: this.eventLog,
        scheduleDrain: () => this.orch.scheduleDrain(),
        logActivity: (event, detail) => this.logActivity(event, detail),
        // The device requests THIS tool call issued, handed to the job that now
        // owns them — by request id, never by turn. A turn can hold several
        // parallel device commands and only the detaching call changes hands, so
        // a turn-wide handover would move work that never left the foreground
        // and put it beyond the reach of Stop.
        onDetached: (jobId, requestIds) => this.transferDeviceRequests(jobId, requestIds),
        // Cancel exactly this job's device work, and REFUSE the cancel when the
        // device could not confirm it. Throwing is the propagation: the runner
        // calls this before any job state changes, so a refused cancel leaves the
        // job running and retryable rather than marking it terminal while the
        // command it owns is still on somebody's machine.
        onCancelled: (jobId) => this.cancelBackgroundDeviceRequests(jobId),
        // Mission Inbox: a settled background job also notifies the owner
        // (email on the orchestrator; skips silently when pieces are absent).
        onSettled: (job) => {
          const notice = backgroundJobNotice(job);
          this.notifyOwner(notice.subject, notice.body);
        },
        // Evict-resume (B6): re-drive an interrupted job from its durable
        // checkpoint. A fork re-runs the raw agents tool — MCTS continues its
        // remaining search budget via the search store; heads re-run from input.
        // Side-effecting kinds (eval / run) are not safe to blindly
        // re-execute, so they decline and fall back to the eviction failure.
        resume: (kind, input, mode, signal) => this.resumeBackgroundJob(kind, input, mode, signal),
        // What a bounded-out job already produced. Same predicate as `resume` above,
        // so a kind that cannot be re-driven has nothing partial to read either —
        // and a SEARCH does: two completed candidates are a harvestable
        // partial.
        harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
          { sql: this.boundSql, actor: this.actorHandle(), ledger: this.mctsSearchStore }, kind, input,
        )),
        // The wake for an attempt this activation deliberately did not start.
        // It arms the actor's ONE terminal-retry row (soonest-wins), so a job
        // waiting out its backoff costs no timer, no second callback, and no
        // schedule row of its own — and the tick that row fires re-enters the
        // job sweep itself, because the fork reconcile behind it runs at most
        // once per activation and a deferred job outlives that.
        scheduleResume: async (atMs) => { await this.scheduleTerminalRetry(atMs); },
      });
    }

    return this._jobRunner;
  }

  /**
   * Hand every device request one detaching tool call issued to the job that now
   * owns it.
   *
   * Each transfer is asserted, not assumed. `transferred: false` means the row
   * was not there to move because it finished, another job already claimed it,
   * or it was never durable. Failure may follow a partial transfer. The job
   * retains ownership and settles the live work, while this throw records the
   * unconfirmed handoff. It does not abort, cancel, or release the job.
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
   * Stop the device work one background job owns, and refuse the cancel unless
   * every command reported a kernel-confirmed outcome.
   *
   * `terminated` and `unknown` are both settled: the first is a confirmed kill,
   * the second is a daemon holding no record of the request, which means nothing
   * of it is running. `failed` is neither — the device was unreachable or the
   * kill was refused — and the command may still be executing on the user's
   * machine. Raising it keeps the job `running`, so the operator can try again
   * and the roster does not report a stopped job over live work.
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
   *   • queued turns         — Think submissions `pending`/`running`, i.e. turns
   *     admitted but not yet answered, including the ones a wake queued while
   *     nothing was connected;
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
    const submissions = await this.listSubmissions({ status: ['pending', 'running'] });

    if (submissions.length > 0) return true;
    const fibers = await this.listFibers({ status: ['pending', 'running', 'interrupted'] });

    if (fibers.length > 0) return true;

    return false;
  }
  /** Foreground long-tool controllers before they cross the background
   *  threshold. Once detached, BackgroundJobRunner owns cancellation. */
  protected readonly _activeToolControllers = new Set<AbortController>();

  // Typed accessors over the `actor_config` key/value table — replaces
  // scattered raw SQL with a single deep module.
  protected get config(): AgentConfigStore {
    return this.stores.config;
  }

  /** The unified `agents` tool's deps: the swarm substrate is universal on cf
   *  actors — the SAME shared factory the CLI wires (core swarm-deps), with
   *  the host-injected infrastructure recomputed per swarm call; the
   *  roster/peer halves ride this actor's profile (actorToolDeps). Rebuilt
   *  with the toolset (getRawTools), so the swarm model refreshes exactly
   *  when the toolset does. */
  private getAgentsToolDeps(workMode: WorkMode): AgentsToolDeps {
    const actorDeps = this.actorToolDeps();
    // The per-node seat factory, asked PER NODE. Node deps are built once per
    // search and shallow-copied per child, so a single actor on those deps
    // would hand a whole wave one claim ledger and one loop pointer — a
    // cross-actor collision this makes impossible.
    const seams = this.explorationSeams();

    // Named and annotated rather than nested inline: this is the ONE production
    // construction site of `AgentsSwarmDeps` on this backend, and a literal buried
    // inside the outer one is a supply no reader — human or gate — can attribute
    // to the interface it satisfies. The CLI's `buildAgentsSwarmDeps` is its twin.
    const swarm: AgentsSwarmDeps = {
      rt: this.rt,
      model: this.getModel(),
      originContext: () => this._turnOriginContext,
      resolveModel: (spec: string) => this.ownedModelServices.resolveModel(spec),
      // Same catalog session that answers the context window and prices the
      // mission ledger — so a search's pre-run estimate and the ledger that
      // later debits it read one rate.
      costModel: () => ({
        spec: this.effectiveModelSpec(),
        pricing: this.modelCatalog.pricing(),
      }),
      // Each node's OWN actor, run id, profile and live-context plane, asked
      // when the wave reaches that node rather than captured with the deps.
      hostNode: (node) => hostNodeSeat(seams, node),
      /**
       * The node's private home, REPORTED as well as provisioned.
       *
       * The host already provisions this to build the node actor's runtime, and
       * the loop runs on `seat.actor.runtime`, so the credential was always
       * real. What was missing was telling the node: absent, `nodeWorkspace`
       * answers `shared-origin-plane` with `home: '.'`, so every node on this
       * backend was told it shares one plane with its siblings and should treat
       * the tree as read-mostly — while owning a private directory at
       * `/home/head-<key>`. `isolationDisclosure` puts that sentence in the
       * node's own prompt, so the disclosure was actively false.
       *
       * `hostNodeSeat` here is not a second bind: register and acquire are both
       * idempotent, and `runNodeAgent` acquires the same seat immediately after
       * for the loop. Going through the seat is what keys the home on the
       * ACTOR's storage key rather than on the raw node id the search minted.
       */
      provisionNodeHome: () => async (node) => seams.nodeHome((await hostNodeSeat(seams, node)).actor),
      runtimeForNodeWorkspace: null,
      // An IN-ISOLATE node runs beside this actor's socket, so its transient
      // frames need no wire at all. A HOSTED node's facet publishes over the RPC
      // it already holds, and agents-tool leaves this unread in that case.
      reportNodeDelta: () => (frame) => { this.publishHeadStreamFrame(frame); },
      // And the DURABLE half of the same liveness, on the SAME listener this
      // actor's own `headJournal` announces through — so a search's journal is
      // the announcing one whether its writes came from the head controller, a
      // facet calling `recordHeadStep`, or the swarm runner in this isolate.
      // Without it the engine built a raw journal of its own and a running
      // search told its open surfaces nothing.
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
        // The swarm half compacts on the same policy every other production
        // path runs — the light preset — chosen here rather than inherited
        // from an internal default, because this is the one construction
        // site of the seam.
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

  /** The run the loop holds open right now, for event emission — one run per
   *  turn, minted by the loop; empty between turns and before the loop exists,
   *  so a between-turn emit files under the workspace aggregate. */
  protected get _currentRunId(): string {
    return this._chatLoop?.currentRunId ?? '';
  }

  // ── Skills (turn-scoped) ───────────────────────────────────────
  /** Immutable role/tier/tool profile resolved once for the active turn. */
  private _turnOperation: OperationProfile | null = null;

  private operationProfile(): OperationProfile | null {
    return currentOperationProfile(this.actorHandle()) ?? (this._inFlight ? this._turnOperation : null);
  }
  /** Resolved active skill set for the current turn. Built in beforeTurn, read
   *  by the per-step dynamic context and the turn-local tail. */
  private _turnActiveSkills: ActiveSkillSet | null = null;
  /** Lazy SkillsVfs adapter over rt.storage.vfs — built once, reused. */
  private _skillsVfs: SkillsVfs | null = null;
  private getSkillsVfs(): SkillsVfs {
    if (!this._skillsVfs) this._skillsVfs = skillsVfsOver(this.rt.storage.vfs);

    return this._skillsVfs;
  }

  /** Instruction trust for this activation (KINU-N028). ONE store over the
   *  actor's own SQL, scoped to this workspace so a forked or copied root starts
   *  unapproved. The owner's decisions and the turn's classification read the
   *  same rows — there is no second authority to drift from. */
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

  /** Bound once — a facet replaces this with the root authority snapshot. */
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


  /** The workspace root's authoritative approval rows. Facets fetch this before
   * each turn; they never consult their private actor SQL for shared files. */
  @callable()
  async getWorkspaceInstructionApprovals(): Promise<readonly InstructionApproval[]> {
    this._workspaceInstructionApprovals = null;

    return this.instructionApprovals().list();
  }
  /**
   * The owner's approval surface: every instruction file this workspace would
   * carry, what its bytes are doing now, and what approving them would bind.
   *
   * Derived on read, never stored. A "waiting" list held in a table would be a
   * table the AGENT could fill by writing files, aimed at the one queue the
   * owner trusts.
   */
  @callable()
  async listInstructionApprovals(request: PageRequest = {}): Promise<Page<InstructionSourceRow>> {
    this._workspaceInstructionApprovals = null;
    const agentsMd = await this.discoverInstructionSources();

    return listInstructionApprovals({
      ...request,
      sources: await gatherApprovableInstructions({
        agentsMd,
        skillsVfs: this.getSkillsVfs(),
        admissionTokens: stepContextLimit({
        contextWindow: this.sessionContextWindow(),
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      }),
      }),
      decisions: this.instructionApprovals().list(),
    });
  }

  /** One row, opened: the bytes of THAT file and nothing else. */
  @callable()
  async readInstructionApproval(path: string): Promise<InstructionSourceView | null> {
    this._workspaceInstructionApprovals = null;
    const clean = path.trim();

    if (clean === '') return null;

    return openInstructionSource({
      path: clean,
      agentsMd: await this.discoverInstructionSources(),
      skillsVfs: this.getSkillsVfs(),
      trust: this.instructionTrust(),
      decisions: this.instructionApprovals().list(),
      admissionTokens: stepContextLimit({
        contextWindow: this.sessionContextWindow(),
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      }),
    });
  }

  /** AGENTS.md as the owner's surface sees it: discovered fresh, because a
   *  digest shown from a stale read would authorize bytes that already moved. */
  private async discoverInstructionSources(): Promise<AgentsMdSources> {
    return collectWorkspaceAgentsMd(
      this.rt.storage.vfs,
      { contextWindow: this.sessionContextWindow(), modelOutputLimit: this.modelCatalog.modelOutputLimit() },
      this.instructionTrust(),
      this.rt.executionRouter?.getProvider('sandbox'),
    );
  }

  /**
   * The owner grants THESE bytes at THIS path system placement.
   *
   * `digest` is the one the owner was shown. If the file has changed since, the
   * approval binds stale bytes, the next turn's lookup misses
   * and the file stays reference material — so the approve/preview gap fails
   * closed instead of granting force to something nobody read.
   */
  @callable()
  async approveInstruction(
    path: string, reviewedDigest: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    this._workspaceInstructionApprovals = null;
    const admitted = admitInstructionDecision(path, reviewedDigest);

    if (!admitted.ok) return admitted;
    const current = await this.readInstructionApproval(admitted.path);

    if (!current || current.digest !== admitted.digest) {
      return { ok: false, error: 'the file changed or could not be read after review; read it again before approving' };
    }

    this.instructionApprovals().approve(admitted.path, admitted.digest);

    return { ok: true };
  }

  /** The owner withdraws trust from a path. The refusal is KEPT, so nothing can
   *  re-grant it without the owner saying so again. */
  @callable()
  async revokeInstruction(
    path: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    this._workspaceInstructionApprovals = null;
    const admitted = admitInstructionDecision(path);

    if (!admitted.ok) return admitted;
    this.instructionApprovals().revoke(admitted.path);

    return { ok: true };
  }

  // ── Activity logging: persisted + broadcast to Logs pane ──
  private _turnT0 = 0;

  // Per-turn in-flight flag — forkAgent rejects with "agent busy" while set.
  /** A turn is running: the loop's own answer, read live. What routes a
   *  signal into the running turn's next step, keeps its tool claims, and
   *  reports the actor busy — one source of truth, cleared by nothing here
   *  because the loop's pump is the thing that ends. */
  protected get _inFlight(): boolean { return this._chatLoop?.pumping === true && this._chatLoop.currentTurnId !== null; }
  /**
   * Whether THIS turn records evolution state: core's own derivation, captured
   * where the turn opened.
   *
   * The recorded `turn_record` row carries it, because `engine.enabled` is a
   * live config read that a mid-turn toggle — or a recovering host that simply
   * has evolution off — would answer differently from the session that produced
   * the turn.
   */
  protected _turnEvolutionEnabled = false;
  /** Core's own derivation of that gate (`AgentOrchestrator.beginTurn`), asked
   *  where a turn opens. Named because the harness has to establish the same
   *  fact for a suite that drives `onChatResponse` with no turn to open. */
  protected turnRecordsEvolution(): boolean {
    return this.engine.enabled && this.turnWorkMode() !== 'plan';
  }

  /** The public extension seam on the cloud backend — the SAME ExtensionHost
   *  contract `runChat` drives on the CLI, bridged onto Think's subclass
   *  hooks: beforeTurn → onTurnStart + transformContext, beforeStep → the
   *  shared step pipeline (composePrepareStep), beforeToolCall/afterToolCall
   *  → onToolCall/onToolResult, onChatResponse → onTurnEnd. Persistent for
   *  the DO activation. The default compaction extension registers here at
   *  construction (registerCompactionExtension). */
  protected readonly extensions = new ExtensionHost();

  /** Dynamic-context blocks for this DO activation (core volatile-context.ts),
   *  re-read and re-woven at every model step by the shared step pipeline.
   *  In-memory only — hibernation/reset empties it, so a cold start attaches
   *  exactly one fresh block; the compaction extension's onOutcome resets it
   *  whenever the model-visible stream changed shape ('planned'/'invalidated')
   *  because the frozen block positions are meaningless against a rewritten
   *  stream. */
  protected readonly dynamicLedger = new DynamicContextLedger();
  protected _cliCwd: string | null = null;
  /** Whether the message that opened the CURRENT turn was a conversational
   *  reply or an independent one-shot task (`kinu exec` against this
   *  workspace). Set in beforeTurn from the chat request; read at turn end to
   *  decide whether this turn may be parked awaiting a follow-up verdict.
   *  Defaults to a conversation — every non-CLI surface (web chat, API, the
   *  REPL) is one. */
  protected _turnContinuity: TurnContinuity = 'conversation';

  // The prepared streamText opts of the LAST live chat inference, stashed at
  // the end of beforeTurn — Think 0.8's one turn-assembly hook on the live
  // inference path (the effective TurnConfig: final system/messages/tools/
  // model; Think then only wraps tool execute and re-applies the same values,
  // so a replay of these opts is the same request modulo per-step cache
  // markers, which are inert decoration). The shadow eval replays these for
  // the pending scaffold's host.defaultInference so the A/B measures the
  // scaffold delta, not a context handicap: the live answer sees the whole
  // conversation while a task-only reconstruction sees only the task
  // text — structurally tie-prone. Also the task source for the evolved-
  // scaffold inference transform. In-memory only: turns are serialized on
  // the TurnQueue and the shadow eval captures the reference synchronously
  // in the same onChatResponse, so it cannot be overwritten by a later turn;
  // after a DO restart the shadow falls back to the task-only reconstruction.
  private _turnProgram: { readonly program: ActorTurnProgram; readonly signal: AbortSignal | undefined } | null = null;
  /** The signal of the turn running right now, or undefined between turns.
   *  Read per call, never captured: a long-lived collaborator built once (the
   *  release engine) has to see the CURRENT turn's cancellation, not the one
   *  that happened to be running when it was constructed. */
  protected currentTurnSignal(): AbortSignal | undefined {
    return this._turnProgram?.signal;
  }

  getCliCwdForDevice(): string | null {
    return this._cliCwd;
  }

  getCheckpointMetaForDevice(): { turnId: string; sessionId: string } | null {
    // The turn a device command belongs to is the loop's live turn: the id a
    // Stop sweep names, and the key the daemon's pre-mutation checkpoint is
    // filed under.
    const turnId = this._chatLoop?.currentTurnId;

    return turnId === undefined || turnId === null ? null : { turnId, sessionId: 'default' };
  }

  // ── Bound SQL executor ────────────────────────────────────────────────
  // `this.sql` is a plain method on the Agent base class — it needs `this`
  // bound to reach `this.ctx.storage.sql`. Passing `this.sql` as a bare
  // function reference to any helper (readForkLineage, forkWorkspaceStorage)
  // loses the binding and fails with `Cannot read properties of undefined
  // (reading 'ctx')`. This closure captures `this` once and can be safely
  // passed by reference.
  private _boundSql: SqlExecutor | null = null;
  protected get boundSql(): SqlExecutor {
    if (!this._boundSql) this._boundSql = bindAgentSql(this);

    return this._boundSql;
  }

  /** The root's transcript, through the SDK's own session provider — core's
   *  TranscriptStore over `assistant_messages`. Lazy for the reason every store
   *  here is: `actorHandle()` resolves the directory row `ensureSchema` creates. */
  private _chatTranscript: AssistantMessagesTranscript | null = null;
  /** Build the transcript store, and with it its table, before anything asks. */
  protected resumeChatTranscript(): AssistantMessagesTranscript {
    return this.chatTranscript;
  }

  protected get chatTranscript(): AssistantMessagesTranscript {
    return this._chatTranscript ??= new AssistantMessagesTranscript(this, this.boundSql, this.actorHandle());
  }


  /** Persisted once per activation. Both tracing and live MCTS frames consume
   * this getter, so observing one cannot advance the other into a new isolate. */
  private _isolateGeneration: number | null = null;
  protected get isolateGeneration(): number {
    return (this._isolateGeneration ??= this.config.countIsolateGeneration());
  }
  private _tracing: AgentTracing | null = null;
  /**
   * The tracing seam, one per construction of this object.
   *
   * LAZY, and that is what makes `isolateGen` correct rather than merely present.
   * The generation is bumped on FIRST use inside an activation, so exactly one
   * bump happens per construction — including the case a boot-time counter cannot
   * see, `ctx.facets.abort()`, which reuses the isolate and is how a Kinu fork
   * most commonly dies. It is deliberately NOT bumped in `onStart`: that runs
   * inside `ctx.blockConcurrencyWhile`, where every added write stalls every
   * request on this object and 30s of it RESETS the object
   * (`do.block_concurrency.cancel_ms`), and an observability counter has no
   * business on that path.
   *
   * `selfPath` rather than `ctx.id`: measured on the deployed runtime, two facets
   * with distinct ids both reported under the ROOT's `durableObjectId`, so an
   * id-keyed trace collapses every head and subordinate into one orchestrator
   * (`do.facet.id_is_root_namespace`).
   */
  protected get tracing(): AgentTracing {
    if (!this._tracing) {
      this._tracing = createAgentTracing({
        tracer: createWorkersTracer(),
        isolateGen: this.isolateGeneration,
        selfPath: this.selfPath,
      });
    }

    return this._tracing;
  }

  /** The platform's monotonic turn clock, over the shared durable trace. */
  protected logActivity(event: string, detail?: string) {
    const elapsed = this._turnT0 > 0 ? Math.round(performance.now() - this._turnT0) : 0;

    writeActivityLog(() => ({ sql: this.boundSql, actor: this.actorHandle() }), {
      event, detail: detail ?? null, elapsedMs: elapsed, createdAt: Date.now(),
    });
  }

  /**
   * What a hosted MCTS branch reasons with: core's two prompts and one bare
   * model call.
   *
   * PURE COMPOSITION, deliberately. `explorePrompt` and `reflectionPrompt` are
   * core's — the same builders the swarm expansion and the local rollout use,
   * so a branch on this backend asks the question every substrate asks. What
   * only the root can supply is the transport: its provider registry, its
   * effort policy and its operation sink.
   *
   * `resolveModelRoute('mcts', …)` happens inside `hostBranch`, against the
   * profile the TURN resolved, so the spec arriving here is already the tier's
   * and this must not re-resolve one.
   *
   * The operation frame opens BEFORE the request and fails closed, because a
   * branch killed mid-call has to leave a start row naming the rollout rather
   * than nothing at all — that absence is exactly what `swarm.node_silent`
   * could not distinguish. Spend is NOT reported here: the engine files a
   * branch's cost from the `usage` this returns, so reporting it again would
   * bill one rollout twice.
   */
  private branchRunnerDeps(): BranchRunnerDeps {
    return {
      explorePrompt,
      reflectionPrompt,
      complete: async ({ spec, effort, system, user }) => {
        // The ROUTE's effort, carried on the request. `resolveModelRoute('mcts',
        // …)` resolved the spec and the effort together, so reaching for
        // `REASONING_EFFORT_FOR_STAGE` here would compute the route's own answer
        // and then substitute a constant for it.
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
          claims: () => this.stores.claims,
          events: () => this.stores.eventRecorder,
          children: childContextResolver({
            host: { bindStores: (reference) => this.actorHost().bindStores(reference) },
            directory: this.actorDirectoryStore(),
            parent: this.actorHandle(),
            events: (child) => child.stores.eventRecorder,
          }),
        },
        // MCTS rollouts. Both members or neither: `requireBranches` refuses
        // when the hook is absent, and an absent hook makes every rollout answer
        // "I cannot" on a kind this backend declares, with `hostBranch` sitting
        // here as an unreached producer. These two members ARE the wire between
        // the declared kind and the branch this object hosts.
        branches: {
          spawn: (branchId) => hostBranch(this.explorationSeams(), branchId, this.branchRunnerDeps()),
          abort: (branchId) => abortHostedBranch(this.explorationSeams(), branchId),
        },
      };

      // NO `workspaceExecution`: this is the workspace's MAIN actor, which runs
      // as the session user because the tree is its own. Every other actor's
      // runtime is built by the host, which assigns the home it provisioned —
      // and assigns it rather than spreading it, because the factory reads the
      // key's PRESENCE to decide whose credential both planes carry.
      // No onToolRegistered hook: the eval sandbox reads
      // craftStore.list() fresh on every call, so mid-turn saves propagate
      // without any registry plumbing (see docs/CRAFT-ARCHITECTURE.md §3).
      // `this` (a subclass) DOES have access to its protected env/ctx; cast to
      // the AgentHost view createCFRuntime needs.
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

  /** Synchronous post-construction hook for actor-specific mounts. The runtime
   * is not cached until this returns, so implementations must use the argument
   * and must not re-enter `this.rt`. */
  protected configureRuntime(_runtime: CFRuntime): void {}

  /**
   * Where a gated command goes when nobody is there to approve it.
   *
   * None here. A subordinate has no needs-you queue of its own — it is a
   * workspace-level surface reached through its orchestrator — so parking an
   * action on this actor would put a decision somewhere nobody looks. It keeps
   * 'strict''s explanatory refusal, and the orchestrator (which owns the queue,
   * the UI and the wake) overrides this.
   *
   * Resolved at exec time, never during runtime construction: reaching the
   * queue means reaching `this.orch` for the wake's signal seam, and the
   * runtime is built inside this actor's own lazy `rt` getter.
   */
  protected deferralChannel(): DeferredApprovalChannel | undefined { return undefined; }

  /**
   * The actor a slate acts FOR, minted here and nowhere a client can reach.
   *
   * The MAIN actor, as the session user: this class is the workspace's one
   * Durable Object, so its own caller is the empty path. A hosted actor's
   * caller is minted by the host instead, from the directory row that states
   * its ancestry and the home the host provisioned for it, never a `parentPath`
   * read off an SDK facet chain with a class name stamped into every hop: a
   * class name is not an identity.
   */
  protected slateCaller(): SlateCaller {
    return { path: [], cred: CRED_SESSION_USER, workMode: currentWorkMode() };
  }

  /** Every actor's slate operations run on the object that owns its workspace, as this actor. */
  async slate(operation: SlateOperation): Promise<SlateCallResult> {
    return workspaceOwner(this.env, this.workspaceName()).slateAs(this.slateCaller(), operation);
  }

  /**
   * Descend one hop of a binding path into the hosted actor it names.
   *
   * The actor at the end answers with its OWN surface narrowed by its OWN
   * current role — the same resolver and narrowing its native tools and its
   * `eval` sandbox are built from — so a binding never reaches more
   * than the actor holding it does, and a role change is seen on the next call.
   * What changed is only where the hop goes: the directory resolves the name
   * under this actor, and the host runs the rest of the path on that actor's
   * own runtime inside this object.
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
        // A hosted actor runs the model call through its OWN profile, resolved
        // now — the same authority a hosted native call resolves under.
        return await this.slateAiRun(route, actor.handle);
      }

      if (route.kind === 'agent') {
        throw new KinuError('denied', 'a hosted actor has no inbox of its own; the agent binding answers on the workspace actor');
      }

      if (route.kind !== 'namespace' && route.kind !== 'tool' && route.kind !== 'codemode') {
        // A hosted actor connects no MCP servers and holds no slate read model
        // of its own: those are workspace-level surfaces reached through the
        // main actor. A true reason, not a narrowing.
        throw new KinuError('denied', `a hosted actor has no ${route.kind} surface; that route belongs to the workspace actor`);
      }

      const surface = hostedActorSurface(actor, this.getWebSearchProvider());
      const providers = providersInWorkMode(mode, surface.providers);
      // NARROWED BY THE CHILD'S OWN ROLE, which is what the header above has
      // always promised and what this path did not do: it went straight from the
      // namespaces to the lookup, so a child restricted to `scribe` still
      // answered `readFile ok:true` down a binding hop. The role is durable and
      // per actor, so the only thing missing was asking it.
      const reach = slateToolReach(await this.hostedSlateReach(actor, providers, Object.keys(surface.native)));

      if (route.kind === 'tool') return this.callSlateTool({ rt: actor.runtime, native: surface.native, providers, reach, route, mode });

      return await callCodemodeMember(reach.narrowProviders(providers), route.namespace, route.member, route.args) ?? null;
    });
  }

  /**
   * One capability route, run AS THIS ACTOR for a slate it holds a binding to.
   *
   * The workspace root forwards a facet's binding call down the facet's own path,
   * one hop at a time, and the actor at the end answers with its own surface
   * narrowed by its own current role — the same resolver and the same narrowing
   * its native tools and its `eval` sandbox are built from — so a
   * binding never reaches more than the actor holding it does, and a role change
   * is seen on the next call.
   *
   * Deliberately NOT `@callable`: reached on the stub transport only.
   */
  async slateBindingDispatch(path: readonly SlateCallerHop[], route: SlateBindingRoute, mode: WorkMode): Promise<JsonValue> {
    // A hop names a hosted ACTOR, resolved through the directory rather than
    // forwarded down a facet chain one Durable Object at a time. The dispatch
    // still descends — a binding held by a subordinate must answer with THAT
    // actor's surface, narrowed by THAT actor's role — but every hop is a call
    // inside this object, so an unreachable name is a refusal here instead of a
    // rejected RPC three objects deep.
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
        // The nameable unit of an MCP tool on this actor's surface is its
        // descriptor key, and the role admits it by that key — the same
        // `toolAllowed(d.toolKey)` the native turn applies.
        const { stub, caller } = await this.userHub();
        const surface = v.parse(McpToolSurfaceSchema, JSON.parse(await stub.userMcp_toolDescriptors(caller)));
        const descriptor = surface.descriptors.find((d) => d.serverId === route.server && d.name === route.tool);

        if (descriptor === undefined) throw new KinuError('missing', `${route.server} offers no tool ${route.tool} to this actor`);
        // A viewer granted a read member gets `readOnly` on the route: the
        // dispatch enforces it here, so a granted tool the server does not
        // mark read-only cannot write through a read grant.

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

  /** The ONE adapter site between a slate's `agent` binding and the inbox the
   *  turn machinery owns: a slate's message is one more producer on `send`. */
  private slateInbox(): AgentInbox {
    return this.orch.inbox;
  }

  /**
   * One `ai` binding call: resolve the profile the way this actor's own turn
   *  would — the live role label and the call's tier as the explicit tier —
   *  then run a single `generateText` under a spend row keyed `slate`.
   *
   * `actor` is the hosted actor the binding hopped to, or absent for this
   *  actor itself; the two differ only in whose profile resolves.
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
      // The resolver names an unknown or malformed tier in a plain Error; the
      // binding surface reports it as bad input, not as an internal failure.
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

  /** Native and crafted calls share the codemode factory over this caller's runtime. */
  private async callSlateTool(input: {
    rt: HostedActor['runtime']; native: ToolSet; providers: CodemodeProvider[];
    reach: ToolSurfaceNarrowing; route: Extract<SlateBindingRoute, { kind: 'tool' }>; mode: WorkMode;
  }): Promise<JsonValue> {
    const { rt, native, providers, reach, route, mode } = input;
    const executorNames = new Set(rt.executionRouter?.getProviders().map((provider) => provider.name) ?? []);

    const factory = createCodemodeToolFactory({
      loader: this.env.LOADER, egress: codemodeEgress(), rt,
      sql: rt.storage.sql, workspace: this.workspaceName(), webSearch: this.getWebSearchProvider(), reach,
      extraProviders: () => providers.filter((provider) => !executorNames.has(provider.name) && provider.name !== 'web'),
    });

    return await inWorkMode(mode, () => factory.callTool(native, route.name, route.input)) ?? null;
  }

  /** Workspace read models belong to the root; the orchestrator supplies them. */
  protected async slateReadModel(source: SlateReadModel): Promise<JsonValue> {
    throw new KinuError('denied', `${source} is a workspace read model this actor does not hold`);
  }

  /**
   * This actor's CURRENT tool reach, for a binding call.
   *
   * The open turn's resolved profile while a turn is IN FLIGHT — `_inFlight`,
   * not the cached profile, which outlives its turn until the next `beforeTurn`
   * and would let a role revoked between turns keep the old reach — else the
   * role resolved now over the same nameable surface a turn offers: native
   * tools, the codemode capabilities the wired providers carry, and any MCP
   * tool keys the caller is deciding on.
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
   * A HOSTED actor's current tool reach, for a binding call that hopped to it.
   *
   * Deliberately not `slateReach`: that one reads `this._inFlight` and
   * the root's admitted operation, and `this.actorToolDeps()`,
   * which is the root's surface. Using it for a child answered every binding
   * hop with the root's unrestricted reach — the defect this exists to close.
   *
   * No live-turn shortcut at all. The child's own open turn is not reachable
   * from here, and the root's is the wrong answer, so the role is resolved NOW
   * over the child's own nameable surface. That is also what the hop's contract
   * promises: a role change is seen on the next call.
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

  /** `memory.*` / `tasks.*` — unconditional on every ActorAgent (orchestrator
   *  and subordinate alike), the same way the native `memory` and `tasks`
   *  tools are. Deps read live per provider's own convention (memory's facts/
   *  vectorStore can rebind; tasks reuses `this.taskList`, the same
   *  TaskListStore instance the dynamic-context snapshot reads). */
  private baseCodemodeProviders(): CodemodeProvider[] {
    return [
      createMemoryCodemodeProvider(() => ({
        memory: this.rt.memory, vectorStore: this.rt.vectorStore,
        facts: this.facts, sql: this.rt.storage.sql, actor: this.actorHandle(),
      })),
      createTasksCodemodeProvider(this.taskList, this.config),
    ];
  }

  /**
   * Every codemode namespace this turn wires, in one place.
   *
   * ONE list with two readers: `beforeTurn` asks it which codemode-only
   * capabilities exist so a role can name them, and `getCodemodeToolFactory` asks
   * it what to narrow. Two lists would let a role allow a capability whose
   * provider is absent, or narrow a set the resolver never saw.
   *
   * Plan mode is the only turn whose set differs: `release` is physically absent
   * from the type declaration and the dispatcher, while every ordinary
   * executor/provider stays present.
   */
  /**
   * The codemode namespaces this turn reaches — and the ONE place they are
   * listed, which is why `db` belongs here and not in `codemode-tool.ts`.
   *
   * This method has two readers. The second is
   * `codemodeCapabilitiesFor(turnCodemodeProviders)`, which is what lets a ROLE
   * name a codemode-only capability at all: `db` is a declared `TOOL_REACH`
   * namespace, so a provider registered outside this list can never be named by
   * a narrowed role — every narrowed role would silently lose the namespace —
   * and it would bypass `narrowing.narrowProviders` as well.
   *
   * `createDbCodemodeProvider` takes the store and NOT the mode, deliberately:
   * the Plan decision depends on the resolved table SCOPE, which the provider
   * only knows at invocation (actor-scope writes are Plan-allowed,
   * workspace-scope writes are refused in Plan, `dropTable` is Build-only), so a
   * mode captured here would be a staler copy of the same fact. `db` is
   * therefore NOT in the Plan filter below.
   */
  protected turnCodemodeProviders(mode: WorkMode): CodemodeProvider[] {
    return [...this.baseCodemodeProviders(), createDbCodemodeProvider(this.stores.appData), ...this.extraCodemodeProviders()]
      .filter((provider) => mode !== 'plan' || provider.name !== 'release');
  }

  /**
   * Every namespace a slate's namespace binding may reach: the surfaces the
   * agent's own `eval` sandbox dispatches to on a build turn, minus the
   * sandbox's two internal ones (`tools`, `state`). The router's providers come
   * gated exactly as codemode receives them (execution/approval.ts), and the
   * projected namespaces are the same factories the sandbox is built from, so a
   * member runs for a slate precisely as it runs for the agent. Read per call:
   * an executor attaches and detaches while this object lives.
   */
  protected slateNamespaces(): CodemodeProvider[] {
    return [
      ...(this.rt.executionRouter?.getProviders() ?? []),
      createWebCodemodeProvider(this.getWebSearchProvider()),
      createAgentsCodemodeProvider(() => this.getAgentsToolDeps('build')),
      ...this.turnCodemodeProviders('build'),
    ];
  }

  /** Build (or return cached) this DO's eval tool. Construction (see
   *  codemode-tool.ts) is once per DO lifetime; crafted tools saved mid-turn
   *  still become callable because the executor re-reads craftStore per call. */
  private getCodemodeToolFactory(mode: WorkMode, profileKey: string): CodemodeFactory {
    // The role's narrowing is PART OF THE KEY. `profileKey` is the actor's
    // active tool names, which two roles can share while reaching different
    // namespaces — so without the digest the first role's provider set is
    // served to the next one for the rest of this DO's life.
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
        webSearch: this.getWebSearchProvider(),
        // `agents.*` in the sandbox — the same deps the top-level tool holds,
        // so a script delegates through the one path with the one action gate.
        agents: () => this.getAgentsToolDeps(mode),
        // The channel this invocation was armed with, read PER PROVIDER CALL: a
        // script's later device execs must carry whatever owns them by then, and
        // a detach changes that mid-call.
        deviceRequests: () => this._activeDeviceRequests ?? undefined,
        // Narrowed by the SAME set the native surface is narrowed by, so a role
        // cannot lose a tool natively and keep it through the sandbox.
        extraProviders: () => narrowing.narrowProviders(this.turnCodemodeProviders(mode)),
        // Record which executor the agent actually works in, so the UI (diff /
        // file manager) defaults to where work happened. One upsert per executor
        // per turn (debounced via _executorsUsedThisTurn, reset in beforeTurn).
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

  /** The spend seam every scaffold-plane producer files through — one object so
   *  a cost can never be filed for an operation that was never opened. */
  private scaffoldSpend(): ModelCallSpend {
    return {
      source: 'scaffold',
      report: (report) => this.reportModelCall(report),
      operations: this.modelOperations,
    };
  }

  // ── Model resolution ───────────────────────────────────────────

  protected providerRegistry(): AgentProviderRegistry {
    return this.ownedModelServices.providerRegistry();
  }

  protected getOwnerUserDO(): UserHubClient | null {
    const userId = this.getOwnerUserId();

    if (!userId) return null;
    const stub: Pick<Fetcher, 'fetch'> = this.env.UserDO.get(this.env.UserDO.idFromName(userId));

    // SAFETY: the stub carries every method on the declared UserDO RPC surface
    // plus fetch. `DurableObjectStub<UserDO>` is the platform's own type for it,
    // and its RPC mapping over the JSON-carrying experience methods exceeds
    // TypeScript's instantiation depth (TS2589 at the publish call, 2026-09-05).
    return stub as UserHubClient;
  }

  protected requireOwnerUserDO(): UserHubClient {
    const stub = this.getOwnerUserDO();

    if (!stub) throw new Error('Agent has no owner yet. Open it through the authenticated app or CLI first.');

    return stub;
  }

  /** The identity this actor presents on every privileged user-level call.
   *  Throws rather than falling back when no token exists — an unclaimed
   *  workspace reaches nothing. */
  protected async userCaller(): Promise<UserCaller> {
    const workspaceToken = this.workspaceCapabilityToken();

    if (!workspaceToken) {
      throw new Error('This workspace has not been issued a capability token yet. Open it through the authenticated app or CLI first.');
    }

    return { workspaceToken };
  }

  /** The owner's UserDO paired with this actor's identity. */
  protected async userHub(): Promise<{ stub: UserHubClient; caller: UserCaller }> {
    return { stub: this.requireOwnerUserDO(), caller: await this.userCaller() };
  }

  /**
   * The two authority inputs a turn profile resolves against.
   *
   * `record` is handed down so core emits the `profile_resolution` run event
   * from inside `loadProfileAuthorityInputs`. The event was declared in core and
   * emitted by the CLI only, so "why did this turn resolve this model, and what
   * did resolution cost" was answerable on a device and unanswerable in
   * production. Whether the row exists is not a per-backend choice, so this
   * backend does not make it — it only says WHERE the row goes, which is the
   * one genuinely per-backend part: the same recorder and the same
   * run-or-workspace fallback every other non-turn row here uses.
   */
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

  // ── Parent workspace file plane (worker-side DO RPC only) ──────────────

  /** A fork reaches these through its `parent` executor. They deliberately
   * carry no `@callable`: only a worker-held parent stub can reach them. */
  private workspaceFileFailure<T, Thrown>(path: string, error: Thrown): ParentRpcResult<T> {
    return {
      ok: false,
      error: {
        code: isVfsError(error) ? error.code : 'EIO',
        message: renderThrownChain({ cause: error }),
        path,
      },
    };
  }

  async readWorkspaceFile(path: string): Promise<ParentRpcResult<Uint8Array>> {
    try {
      const content = await this.rt.localVfs.readFile(path);

      return { ok: true, value: v.is(v.string(), content) ? new TextEncoder().encode(content) : content };
    } catch (error) {
      return this.workspaceFileFailure(path, error);
    }
  }

  async writeWorkspaceFile(input: ParentRpcWrite): Promise<ParentRpcResult<null>> {
    try {
      if (input.kind === 'file') await this.rt.localVfs.writeFile(input.path, input.data);
      else await this.rt.localVfs.mkdir(input.path, { recursive: input.recursive });

      return { ok: true, value: null };
    } catch (error) {
      return this.workspaceFileFailure(input.path, error);
    }
  }

  async listWorkspaceFiles(path: string): Promise<ParentRpcResult<string[]>> {
    try {
      return { ok: true, value: await this.rt.localVfs.readdir(path) };
    } catch (error) {
      return this.workspaceFileFailure(path, error);
    }
  }

  async statWorkspaceFile(path: string): Promise<ParentRpcResult<{ size: number; mtimeMs: number; isDir: boolean } | null>> {
    try {
      return { ok: true, value: await this.rt.localVfs.stat(path) };
    } catch (error) {
      return this.workspaceFileFailure(path, error);
    }
  }

  async deleteWorkspaceFile(path: string): Promise<ParentRpcResult<null>> {
    try {
      await this.rt.localVfs.unlink(path);

      return { ok: true, value: null };
    } catch (error) {
      return this.workspaceFileFailure(path, error);
    }
  }

  /**
   * Run a command in THIS workspace's shell on behalf of a fork.
   *
   * The reason `parent` is worth being an executor rather than a file view:
   * walking the tree one RPC per file through an emulated shell costs a round
   * trip per file; this is one round trip into the real shell, with the whole
   * coreutils set behind it.
   */
  async execWorkspaceCommand(command: string): Promise<ParentRpcResult<ParentExecResult>> {
    const shell = this.rt.shell;

    if (!shell) return this.workspaceFileFailure('', new Error('this workspace has no shell'));

    try {
      return { ok: true, value: await shell.exec(command) };
    } catch (error) {
      return this.workspaceFileFailure('', error);
    }
  }

  /** The web search + fetch provider — built once per DO lifetime. Key-less by
   *  default (DuckDuckGo + Markdown-for-Agents); a stored `tavily` credential,
   *  resolved through the registry's getAuth seam, upgrades search. HTML→markdown
   *  routes through env.AI.toMarkdown when the AI binding is present. */
  private getWebSearchProvider(): WebSearchProvider {
    return this.ownedModelServices.getWebSearchProvider();
  }

  /** Stored model spec, or null when unset (registry will pick the default). */
  protected getStoredModelId(): string | null {
    return this.config.getModel();
  }

  // ── The control plane every root exposes ────────────────────────
  //
  // Declared twice, once per root, over the same core implementations: a chat is a
  // chat, so what stops a turn and what changes the model are the same question
  // wherever the chat is. `ensureSchema()` first on each, because a native DO RPC
  // does not route through partyserver and can land before `onStart` — the race
  // `installWorkspaceCapability` documents. It is flag-gated and idempotent.

  /** Native owner inspection. Does not initialize the SDK or application tables. */
  async inspectSubordinateStorage(request: SubordinateInspectionRequest, authority: SubordinateInspectionAuthority): Promise<SubordinateInspectionResult> {
    // SYNCHRONOUS. Core walks `directory.resolveChild` from the caller's own
    // actor and reads the target's rows in this one database, so there is no
    // per-hop RPC port to resolve, no stored parent path to check and no
    // class-name comparison — the last two being values a worker reports about
    // itself.
    return inspectSubordinateStorage({
      sql: this.boundSql, raw: this.ctx.storage.sql,
      actor: this.actorHandle(), directory: this.actorDirectoryStore(),
    }, request, authority);
  }

  /**
   * One page of ONE chat: the caller's own by default, or the chat of the
   * hosted actor a pane names.
   *
   * A pane addresses its own actor by the id its snapshot already carries
   * (`SubordinateSnapshot.actorId`); the root's pane names none and reads this
   * actor's conversation. Before the parameter existed every caller was
   * answered from `actorHandle()`, so an actor pane's scroll-up paged the
   * WORKSPACE's rows into a helper's chat — the same leak the pane's live
   * transcript had, one surface later.
   */
  @callable()
  async getChatHistoryPage(request?: PageRequest & { actor?: string }): Promise<Page<ChatHistoryEntry>> {
    this.ensureSchema();
    const { actor, ...page } = request ?? {};

    return getChatHistoryPage(this.boundSql, actor === undefined ? this.actorHandle() : this.hostedChatActor(actor), page);
  }

  /**
   * The actor behind a pane's id, refused when this workspace hosts no chat
   * under it.
   *
   * The DIRECTORY answers, because the id it issued is what the pane holds: it
   * refuses an actor this workspace never registered or has retired, and the
   * two further checks are the ones `resolveHostedActorRoute` makes of the
   * socket serving the same chat — a child of THIS actor, of the one kind
   * whose pane has a conversation. The page itself then comes off the rows
   * that actor's own chat wire serves (`actor_messages` under
   * `CHAT_SESSION_ID`, through the canonical read model), not a reader of this
   * RPC's own.
   */
  private hostedChatActor(actorId: string): ActorHandle {
    const directory = this.actorDirectoryStore();
    const handle = directory.open(actorId);
    const record = directory.describe(handle);

    if (record.parentActorId !== this.actorHandle().actorId || record.kind !== 'subordinate') {
      throw new KinuError('denied', 'The actor id does not name a chat this workspace hosts.');
    }

    return handle;
  }

  /** The agent's stored model spec. The UI preselects a menu entry with it; the
   *  available-models list comes from /api/user/models so it stays user-scoped. */
  @callable()
  async getStoredModelSpec(): Promise<{ spec: string | null }> {
    return getStoredModelSpec(this.config);
  }

  /**
   * Change the durable active role. Takes effect on the NEXT resolved turn —
   * `beforeTurn` re-reads `config.getRoleSelection()` every time, so there is no
   * resolved (core profiles/role-change.ts:1-5). Clearing the memo instead
   * mutated a turn that had already resolved its model and tools, and clearing
   * it before the outcome check did that even for a change that never landed.
   */
  @callable() async setRole(roleId: string): Promise<{ role: string }> {
    const { envelope } = await this.profileInputs();

    const changed = changeActiveRole({
      config: this.config,
      envelope,
      to: roleId,
      actor: 'user',
    });

    if (changed.kind !== 'applied') {
      throw new Error(roleChangeOutcomeText(roleId, changed, this.activeRoleLabel()));
    }

    return { role: changed.to };
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

  /**
   * Send the user a message to this actor — the composer's one submit, whatever
   * the actor is doing. A running turn takes it at its next step
   * (`'mid-turn'`); an idle actor runs it as the next ordinary turn (`'turn'`),
   * atomically with the decision, in its own turn queue. "It went into the
   * running turn" and "it started a new one" are different events for the
   * person who typed it, so the answer still says which, and no caller
   * re-sends. Attachments ride the same path, as file parts on the message.
   *
   * `files` and `mode` arrive over the wire, so they are parsed rather than
   * trusted; an unrecognized mode runs as ordinary build work, exactly as
   * `workModeForTurnMetadata` reads an unrecognized stored `kinuMode`.
   */
  @callable()
  async send(text: string, files: readonly PromptFile[] = [], mode?: WorkMode): Promise<{ landed: SendLanding }> {
    this.ensureSchema();
    const attachments = v.parse(v.array(PromptFileSchema), files);

    return { landed: await this.chatLoop.send({ text, files: attachments }, { mode: isWorkMode(mode) ? mode : 'build' }) };
  }

  /** Stop the turn on screen — the composer's Stop button. Aborts the in-flight
   *  LLM request itself first, so the turn stops even when the client's cancel
   *  frame is lost; queued steers stay queued and the turn settle path re-queues
   *  what the model never saw as the next user-origin turn.
   *
   *  Foreground only. Work that has DETACHED from its turn keeps running: the
   *  task roster's per-job control stops it by id (`cancelBackgroundJob`),
   *  because the turn on screen says nothing about a job that outlived an
   *  earlier one. */
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

          // Stop is still complete — local controllers were already aborted —
          // but the frame must say the durable device sweep failed rather than
          // silently claiming commands stopped.
          return [{ outcome: 'failed' as const, detail: renderThrownChain({ cause: err }) }];
        }
      },
      onCancelled: (outcome) => this.onWorkCancelled(outcome),
    });
  }

  /**
   * What this root does once its work is actually cancelled — the ONE thing that
   * differed between the two copies above, kept as a difference: the orchestrator
   * clears its in-flight flag and files an activity line, and whether a root's
   * Stop settles its own turn state is that root's business, not the substrate's.
   */
  protected onWorkCancelled(_outcome: Omit<CancelWorkOutcome, 'ok'>): void {}

  // ── Think lifecycle overrides ──────────────────────────────────

  /** Think asks for a model before beforeTurn. The prior resolved profile is
   * a warm hint; beforeTurn always overrides this turn with its fresh profile. */
  getModel(): LanguageModel {
    this.actorHandle();
    const spec = this.operationProfile()?.profile.tier.model ?? this.getStoredModelId();

    return this.ownedModelServices.resolveModel(spec);
  }

  /**
   * Cached SOUL.md text, refreshed at turn start and invalidated by setSoul().
   *
   * A cache rather than a read because the soul is a FILE in the workspace
   * filesystem and `beforeTurn` is the one place with a promise to await it on.
   * A cold activation that has not reached a turn yet renders the default
   * identity, exactly as an unwritten SOUL.md always did.
   */
  protected _cachedSoulText: string | null = null;
  protected async loadSoulText(): Promise<string> {
    return (await readSoul(this.rt.storage.vfs)) ?? '';
  }
  protected async refreshSoulText(): Promise<void> {
    this._cachedSoulText = await this.loadSoulText();
  }
  /** The workspace soul as the last refresh read it. Protected because a
   *  hosted actor's turn is framed with the same one: its world is this
   *  workspace, so the document that says what this workspace is for is the
   *  document it works under too. */
  protected getSoulText(): string {
    return this._cachedSoulText ?? '';
  }

  /**
   * This actor's own mission — the workspace's purpose as it knows it.
   *
   * Read for two things: the source an auto-title may be derived from, and
   * what an additional agent the owner adds INHERITS, because an agent added
   * to a workspace is there for what the workspace is for. Each root answers
   * from wherever its mission durably lives.
   */
  protected abstract ownMission(): string;

  /**
   * Automatic titling — one path, shared by every root that can be talked to.
   *
   * The decision is core's (`planWorkspaceTitle`): a title the operator chose
   * is never touched, an actor with nothing to be named from is left alone,
   * and persisting an auto title marks `name_origin`, so this runs at most
   * once. The slug is NOT part of it: fixed at creation and permanent.
   *
   * A failed generation is not swallowed into silence — the deterministic
   * title has already landed by then, so the failure is reported and the
   * title that landed stands.
   */
  protected async maybeAutoTitle(mission: string): Promise<void> {
    try {
      await this.applyAutoTitle(mission);
    } catch (err) {
      // `workspace`, not `agent`: the analytics sink publishes from a closed set
      // of field NAMES, and `agent` is not one of them — so this actor's
      // identity was being dropped on the way to the dataset while looking like
      // it was reported. `title` is deliberately still not published; it is
      // derived from the mission, which is the person's own sentence.
      diagnostics.failure('agent.auto_title_failed', toKinuError({
        doing: 'deriving a title from the mission',
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: this.name });
    }
  }

  /**
   * The same titling, with its failure left to travel.
   *
   * The absorbing wrapper above is right for a caller that is opportunistic — a
   * wake-time heal, a soul read — and wrong for one that OWES the title: a
   * transient registry failure there was recorded as a completed effect and
   * pruned rather than retried. The durable caller uses this and completes only
   * once the boundary has answered.
   *
   * `persistAutoTitle` is the once-only boundary either way: it stamps
   * `name_origin`, so a replay of an already-titled workspace changes nothing and
   * a manual rename that claimed the title first still wins.
   */
  protected async applyAutoTitle(mission: string): Promise<string | null> {
    // Read stored naming state before a cold activation plans a title.
    await this.hydrateTitleInputs();

    const title = await applyWorkspaceTitle({
      slug: this.actorHandle().name,
      ...this.titleInputs(),
      mission,
    }, {
      persist: (name) => this.persistAutoTitle(name),
      suggest: (text) => this.suggestTitle(text),
    });

    if (title) diagnostics.event('agent.auto_titled', { workspace: this.name, title });
    // ALWAYS, not only when this pass produced a title: persisting stamps
    // `name_origin`, which stops matching the naming policy above — so a
    // replay after a failed publish plans nothing, and a roster that never heard
    // about the stored title would keep the placeholder with nothing owed to fix
    // it. Throws, so the owed row carries the retry.
    await this.publishAutoTitle();

    return title;
  }

  /** Make this actor's STORED title visible wherever its naming is read from
   *  outside its own storage. The base's title lives where every reader already
   *  looks, so there is nothing to publish. */
  protected async publishAutoTitle(): Promise<void> {}

  /** Fill whatever activation-local view {@link titleInputs} reads, for an actor
   *  whose naming authority is not its own storage. The base owns its config
   *  row outright, so there is nothing to fetch. */
  protected async hydrateTitleInputs(): Promise<void> {}

  /** Why this actor cannot title itself right now, or null when it can. An
   *  actor whose naming authority is its own storage always can. */
  protected async titlingRefusal(): Promise<string | null> {
    return null;
  }

  /** Commit one auto title wherever this root's naming state is authoritative.
   *  `false` means a manual rename claimed the title first, which is what
   *  makes the owner's choice win a race with the model call above. */
  protected abstract persistAutoTitle(displayName: string): Promise<boolean>;

  /** The naming state the title policy decides against. The base reads the
   *  actor's own config — which IS the authority for a subordinate's
   *  descriptor — while the workspace root overrides it with its activation
   *  cache of the ROOT registry row (UserDO), where an actor_config mirror
   *  would drift against every other writer of that row. */
  protected titleInputs(): WorkspaceTitleInputs {
    return { displayName: this.config.getDisplayName(), nameOrigin: this.config.getNameOrigin() };
  }

  /**
   * The names this actor's prompt introduces it by: the workspace it works in,
   * and its own name when it is a subagent of that workspace.
   *
   * Abstract because the two actors answer from different places and neither
   * answer is a sensible default for the other. A workspace root's title lives
   * in the owner's registry; a subagent's lives in its own config, and the
   * workspace's is a hop away.
   */
  protected abstract promptIdentity(): Promise<PromptIdentity>;


  /**
   * The shared naming round-trip: the same prompt and parser the create path
   * uses.
   *
   * Filed as `fast`, and RUN as `fast`. Naming is mechanical work, so
   * grouping it with the judges would make "what did grading cost" answer a
   * question it did not ask — and because `MODEL_ROUTE_POLICY.fast` is the
   * `fast` tier, that same attribution decides the model. One `'fast'`
   * literal feeds both the route and the spend label, so the two cannot
   * disagree.
   */
  protected async suggestTitle(mission: string): Promise<string | null> {
    const { model, spec, providerOptions } = await this.modelForSource('fast');

    // The prompt pair and the parse are core's (suggestWorkspaceTitle); what
    // stays here is which model answers and the operation/spend framing.
    return suggestWorkspaceTitle(async (system, prompt) => {
      // The frame opens BEFORE the request, so a call that never returns leaves
      // a start row naming the naming pass rather than nothing at all.
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
          // No output cap: reasoning models spend their budget thinking before
          // the JSON, and a cap starves them into empty text.
        };

        if (providerOptions) request.providerOptions = providerOptions;
        result = await generateText(request);
      } catch (err) {
        operation.failed({ cause: err });
        throw err;
      }

      // `spec` came back with the model it built, so it is the exact string the
      // call was priced against rather than a second resolution that could
      // disagree; `modelId` is what the provider says served it, and the two are
      // worth keeping apart. The OPERATION closes here too — completed before
      // the parse, like every seam that bills first and judges the answer after.
      const modelId = result.response?.modelId;
      const usage = normalizeUsage(result.usage);
      operation.completed({ usage, modelId: modelId ?? spec });
      this.reportModelCall(
        modelId
          ? { source: 'fast', usage, spec, modelId }
          : { source: 'fast', usage, spec },
      );

      return result.text;
    }, mission);
  }

  /**
   * Think's fallback system prompt. Never the prompt a turn runs on: Think
   * reads it before `beforeTurn` and keeps it only when the turn config
   * carries no `system` (`think.js` `_prepareTurn`), and `beforeTurn` below
   * always returns one. The soul is the honest answer for the one path that
   * can still read it.
   */
  getSystemPrompt(): string {
    return this.getSoulText();
  }

  /**
   * Compute a lightweight cache key from CraftStore + quality state. Quality
   * lives on the crafted_tools row itself (score/uses/last_used_at), and
   * effective-score filtering depends on recency — without MAX(last_used_at)
   * in the key, the cached ToolSet would keep re-using a stale score-filtered
   * view across turns even as usage shifts.
   *
   * UNSCOPED ON PURPOSE, and it must stay that way while the store is. This
   * key guards a cache of what `craftStore.list()` returned, and that store is
   * `new CraftStore(sql)` over the workspace's one database — `crafted_tools`
   * is keyed by `name` alone and carries no `actor_id` column at all. A
   * `WHERE actor_id = …` here does not narrow the key, it throws `no such
   * column` on the first turn; and were the column added without narrowing the
   * store, the key would cover a subset of what the cache holds, which is the
   * stale-surface bug this key exists to prevent. Per-actor crafted tools are a
   * change to the TABLE, the store and every reader of it, not to this query.
   */
  private _craftCacheKey(): string {
    const row = this.sql<{ cnt: number; latest: number; lastUsed: number }>`
      SELECT COUNT(*) as cnt, COALESCE(MAX(updated_at), 0) as latest,
             COALESCE(MAX(last_used_at), 0) as lastUsed
      FROM crafted_tools`[0] ?? { cnt: 0, latest: 0, lastUsed: 0 };

    return `${row.cnt}:${row.latest}:${row.lastUsed}`;
  }

  getTools(): ToolSet {
    // The chat turn's tool source, read once per turn as prepareTurn opens.
    // Returns the CHAT view = the raw surface + the auto-background wrap (#173)
    // + the operation profile. Internal eval side-streams use getRawTools()
    // instead, so a >30s tool run inside a shadow-eval / scaffold / GEPA
    // evaluation never detaches a job or injects an unsolicited "job
    // completed" turn into the user's chat. Also starts the turn clock every
    // activity line is stamped against.
    this._turnT0 = performance.now();

    const tools = this.wrapToolsForBackground(this.getRawTools());
    const operation = this.operationProfile();

    return operation ? withOperationProfile(tools, operation) : tools;
  }

  /** The UNWRAPPED tool surface — built + cached. Shared by the chat path (via
   *  getTools, which adds the background wrap) and by internal eval side-streams
   *  that must run tools to completion inline (never auto-background). */
  protected getRawTools(): ToolSet {
    this.actorHandle();

    return this.getRawToolsForWorkMode(this.turnWorkMode());
  }

  protected getRawToolsForWorkMode(mode: WorkMode, claimScope?: string): ToolSet {
    const actorDeps = this.actorToolDeps();
    const profileKey = actorActiveTools(actorDeps).join(',');
    // Cache key includes CraftStore updated_at AND the crafted_tools quality
    // because effective-score filtering depends on recency. The actor profile
    // is turn-sensitive for subordinate reporting: an owner chat must never
    // reuse an assigned turn's upward-reporting surface.
    const cacheKey = `${mode}:${profileKey}:${this.operationProfile()?.profile.digest ?? ''}:${this._craftCacheKey()}`;

    // The cache is the CHAT surface's. A scoped rollout's surface differs only
    // in the identity its effect claims key on and is asked for once per
    // rollout, so caching it would evict the surface every later turn wants for
    // a build nothing asks for twice.
    if (claimScope === undefined && this._cachedTools && cacheKey === this._cachedToolsKey) {
      return this._cachedTools;
    }

    this.logActivity("gettools_rebuilding", `${this._cachedToolsKey} → ${cacheKey}`);

    try {
      // No registry sync: the eval sandbox reads craftStore.list()
      // fresh at every execute. See docs/CRAFT-ARCHITECTURE.md §3.

      const builtinDeps: Parameters<typeof buildActorTools>[0] = {
        rt: this.rt,
        workMode: mode,
        // The once-only boundary for tools whose effects leave this object.
        // `turnId` is a closure because the toolset is cached across turns; the
        // checkpoint's turn id is the DURABLE id of the message this turn opened
        // on, which is what a recovery replays and a run id is not. A rollout
        // supplies its own recoverable identity instead — see
        // {@link makeScaffoldCallTool}.
        effectClaims: {
          actor: this.actorHandle(),
          sql: this.rt.storage.sql,
          turnId: claimScope === undefined
            ? () => currentOperationProfile(this.actorHandle())?.turnId ?? this._chatLoop?.currentTurnId ?? WORKSPACE_RUN_ID
            : () => claimScope,
        },
        // The sandbox declares the FINISHED native surface, so core builds it
        // last, over the set that holds every other tool, and wraps it with
        // the clamp and the effect claim the registry declares for it.
        codemode: ({ native }) => this.getCodemodeToolFactory(mode, profileKey).toolFor(native),
        craftedToolExecute: null,
        // The turn's cumulative bulk budget lives on the accumulator, so the
        // cached toolset holds a stable reference across turns and the reset
        // rides the turn's own accounting.
        contextBudget: this.acc.context,
        // Same ownership: read-before-edit state and the per-edit outcome
        // counters ride the accumulator, so the cached toolset sees the turn's
        // ledger and the reset rides the turn's own accounting.
        fileLedger: this.acc.files,
        // Same turn-scoped ownership as fileLedger: the `shell` dispatch records
        // each escalation decision here, and the settle spine above writes the
        // durable row.
        escalations: this.acc.escalations,
        // The unified `agents` delegation tool — swarm substrate (heads / mcts
        // settle) is universal; hire/ask/send actions appear only when this
        // actor's profile wires the team/peers transports. Owner resolution
        // stays lazy per action, so the cached toolset stays valid across
        // claimOwner.
        agents: this.getAgentsToolDeps(mode),
        roleAuthority: () => this.operationProfile()?.inputs?.envelope ?? null,
        // Vectorize-backed semantic memory. memory.search auto-uses
        // hybrid retrieval when this is provided + available; FTS5-only fallback.
        vectorStore: this.rt.vectorStore,
        // Typed, keyed world-model store — exposes the `fact` tool.
        facts: this.facts,
        // The remaining actor-profile dep: the subordinate report spine.
        // The release lane is codemode-only now (release.* — see
        // getCodemodeToolFactory below), not a BuiltinToolDeps field.
        // Web research — key-less default, codemode web.* wired below.
        webSearch: this.getWebSearchProvider(),
      };

      if (actorDeps.report) builtinDeps.report = actorDeps.report;

      if (mode === 'plan' && actorDeps.submitPlan) builtinDeps.submitPlan = actorDeps.submitPlan;
      const tools = buildActorTools(builtinDeps);

      // Anthropic prompt-caching: one breakpoint on the last tool caches the
      // whole stable tool surface (tools precede system+messages in Anthropic's
      // cache hierarchy). Namespaced → inert for non-Anthropic providers.
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

  /** Build the CF HeadRuntime (Facet spawner + merge LLM) once per DO lifetime,
   *  lazily — heads need the agent's owner for UserDO auth. undefined when the
   *  agent has no owner; surfaced via host.headRuntime. */
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
      // The merge is a JUDGE call, so its model and its effort come from the
      // route table rather than from the actor's stored chat spec at a constant
      // effort — the head runtime resolves the route from this profile.
      profile: () => this.routingProfile(),
      reportModelCall: (report) => this.reportModelCall(report),
      operations: this.modelOperations,
      grounding,
    });

    return this._cfHeadRuntime;
  }

  /**
   * A node loop runs in the search's isolate with an arbiter closure over the
   * live remaining-children budget; its host provisions the home from its
   * directory row.
   *
   * `hostNodeSeat` (`exploration-hosting.ts`) is requested PER NODE because
   * search deps are shallow-copied per child, and sharing one seat would give
   * a whole wave one claim ledger and one loop pointer.
   */

  /**
   * The SDK's transcript store, asserted present at wake.
   *
   * Think's own `onStart` hydrates its session before it reaches this actor's
   * (`@cloudflare/think` 0.17.0 `think.js` `startThink`: the
   * `transcript-hydration` step runs `_syncMessages`, whose first session read
   * declares the provider's DDL, and `_onStart` — the subclass's — is awaited
   * after it; read 2026-09-15). So by the time this runs, the vendor has
   * declared whatever table it keeps the transcript in, and the question is
   * whether that table is the one Kinu's readers name. Every conversational
   * reader in core answers from `assistant_messages` where it exists and
   * falls to plain `actor_messages` where it does not
   * (`identity/conversation-store.ts` `hasPaneStore`): right for a local
   * workspace, and silently WRONG for a hosted workspace whose SDK has moved
   * the transcript. The Agents SDK's `brisk-chats-branch` changeset lifts
   * `assistant_messages`, `assistant_compactions` and `assistant_config` into
   * `cf_agents_session_*` and drops them, after which the fork cut, the
   * archive export, conversation search, the eval split and
   * {@link readInheritedContext} would each read an empty default chat and
   * report a conversation of zero messages.
   *
   * Asked BEFORE this actor's own store is built, with `tableExists` and never
   * by catching. The store's provider is the same vendor provider, so building
   * it first would declare the table this guard then finds — under every SDK,
   * including the one that moved it — and the guard would never fire.
   */
  protected assertSessionStore(): void {
    if (tableExists(this.boundSql, 'assistant_messages')) {
      this.resumeChatTranscript();

      return;
    }

    throw new Error(
      'The transcript store booted but the workspace database has no `assistant_messages` table: '
      + 'the SDK stores the transcript somewhere Kinu\'s conversational readers '
      + '(fork, archive, search, eval split, inherited context) do not read. Refusing to wake, '
      + 'because every one of them would otherwise answer with an empty conversation. '
      + 'This is the Agents SDK session replatform (changeset `brisk-chats-branch`, '
      + '`cf_agents_session_*`); the readers must move with it before this version ships.',
    );
  }

  /**
   * ONE actor's recent conversation, handed to each spawned head so it sees the
   * full context. Capped to the last N messages to bound head LLM context over
   * long sessions (Think Session already compacts the table at the
   * orchestrator level; this is a second safety net for head spawns).
   *
   * WHOSE conversation is an argument, defaulting to this object's own actor.
   * The transcript table is `actor_id`-scoped, and a HOSTED actor hiring a
   * child of its own passes what IT has said rather than what the workspace
   * root has: a hire handed the root's transcript inherits a conversation it
   * was never party to.
   */
  protected readInheritedContext(actor: ActorHandle = this.actorHandle()): SerializedMessage[] {
    // The agents SDK's session provider creates assistant_messages on its first
    // session read — Think's boot on a hosted activation, so an agent whose
    // Think never booted (the bun harness) has none. Asked directly:
    // catching instead made "no conversation yet" indistinguishable from a read
    // that blew up, and a head handed [] reports "I found nothing" rather than
    // "I could not see the parent" — the defect owners actually hit.
    if (!usesPaneStore(this.boundSql, actor)) return [];

    type Row = { id: string; role: string; content: string; created_at: string };

    // `created_at` is second-grained, and a turn writes its rows inside one
    // second: the rowid is the order they were written in, and the only
    // order two rows of one second have.
    const rows = this.sql<Row>`
      SELECT id, role, content, created_at
      FROM (
        SELECT id, role, content, created_at, rowid AS written
        FROM assistant_messages
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${INHERITED_CONTEXT_CAP}
      ) sub
      ORDER BY created_at ASC, written ASC`;

    // The SAME predicate on the total: a count over every actor's transcript
    // beside a page from one actor's would report a fork inheriting context it
    // was never given, which is the reading this cap exists to bound.
    const total = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM assistant_messages`[0]?.n ?? rows.length;

    return inheritedContextFromRows(
      rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: uiMessageText(r.content),
        createdAt: Date.parse(r.created_at) || 0,
      })),
      total,
    );
  }

  /**
   * Fetch the user's MCP tool descriptors and reconstruct AI-SDK Tool
   * adapters whose `execute` closures dispatch back to UserDO via RPC.
   *
   * Cache invalidation is the descriptor surface's CONTENT HASH (see
   * `McpToolSurfaceCache`): cold reconstruction, add/remove/edit and OAuth
   * completion each invalidate exactly when the durable rows differ from what
   * this activation last served. A failed read keeps the last good build — an
   * actor mid-turn must not lose its tools because one RPC failed.
   *
   * Closure boundary: the descriptor that crosses RPC carries only the JSON
   * Schema + name + serverId; we re-construct the AI-SDK `Tool` here so the
   * `execute` arrow can capture `userDOStub`, the caller identity, `serverId`,
   * and `name` lexically. The identity is the workspace capability token, so a
   * facet dispatches as its parent workspace and cannot name another.
   */
  private async buildUserMcpTools(nativeTools: ToolSet): Promise<ToolSet> {
    const userId = this.getOwnerUserId();

    if (!userId) return {};

    // No identity, no user-level tools: advertising descriptors the actor cannot
    // dispatch just spends context on calls that will be refused.
    // Asked rather than caught: userCaller() throws only when no token has been
    // issued, and a real failure reading one must not silently empty the surface.
    if (!this.workspaceCapabilityToken()) return {};
    const caller = await this.userCaller();

    try {
      // What the admission divides is the step context limit for the RESOLVED
      // model — its window less the output allowance the request has to leave
      // room for — minus what this actor's OWN tool definitions already spend of
      // it. Both model figures come off the one `ModelCatalogSession` the
      // compaction trigger and the step-prune budget read, so there is no second
      // source and no MCP percentage: a remote catalog gets the remainder of an
      // allocation that exists, priced on the same scale as the tools it sits
      // beside (`McpSurfaceBudget`).
      const tools = await this.mcpToolsCache.refresh(
        () => this.requireOwnerUserDO().userMcp_toolDescriptors(caller),
        {
          contextWindow: this.sessionContextWindow(),
          modelOutputLimit: this.modelCatalog.modelOutputLimit(),
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

      // Only a catalog the turn could not REACH or FINISH reading is tolerated:
      // the turn proceeds on builtins alone, the failure is recorded whole, and
      // the surface state records what this turn will actually advertise —
      // none of it, by name. A denied caller, a bad descriptor or a cancelled
      // turn is a fault of this turn, and builtins-only would paper over it.
      if (!MCP_CATALOG_READ_FAILURES.has(failure.code)) throw failure;
      diagnostics.failure('mcp.tool_surface_failed', failure);
      this._mcpUnavailable = [{
        source: 'MCP catalog',
        reason: 'The descriptor read failed. No MCP tool is available for this turn.',
      }];

      return {};
    }
  }

  /** Resolved `<provider>/<modelId>` the next turn will actually use — core's
   *  one resolution, over this actor's registry. Falls back to the raw spec
   *  only pre-claim (no provider registry yet).
   *
   *  Protected because a hosted actor's search prices its estimate against the
   *  workspace's own catalog session, which is this resolution. */
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

  /** Prompt model context from the RESOLVED spec. The raw stored id is null
   *  on default-configured agents, which leaves model-family guidance
   *  inert on the primary hosted path without it — the same raw-spec class
   *  of bug effectiveModelSpec() fixes for the compaction threshold. */
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

  /** The shared catalog view of the resolved model (core model-catalog):
   *  one cached, non-blocking lookup per spec; static fallbacks (window
   *  table / conservative media policy) answer until it lands. */
  /** Protected: the workspace's mission ledger prices every hosted actor's
   *  spend off this one catalog, so a search's estimate and the ledger that
   *  debits it read one rate. */
  protected readonly modelCatalog = new ModelCatalogSession({
    effectiveSpec: () => this.effectiveModelSpec(),
    lookup: async (spec) => {
      if (!spec) return null;
      const { provider, modelId } = parseModelSpec(spec);
      const reg = this.providerRegistry();

      return catalogModelInfo(reg.registry.get(provider), reg.deps, modelId);
    },
  });

  /** The resolved model's context window — feeds the compaction extension
   *  through the transformContext seam. */
  protected sessionContextWindow(): number {
    return this.modelCatalog.contextWindow();
  }

  /** Media kinds the next turn's model request can carry — the attachment
   *  sanitizer's policy input (the proven Workers AI PDF-400 fix). */
  private sessionAcceptedMedia(): ReadonlySet<MediaModality> {
    return this.modelCatalog.acceptedMedia();
  }

  // ── Think lifecycle hooks ──────────────────────────────────────

  // Tools the model is allowed to call. Think merges workspace tools (read, write,
  // edit, list, find, grep, delete) with ours, bloating the request by ~2800 tokens.
  // activeTools restricts the model to the built-in tools + session context tools,
  // preventing Think's workspace tools from being sent in the request payload.
  // BUILTIN_TOOLS is sourced from @kinu.run/core/tools/registry (single truth).

  /**
   * The turn-local message tail: the unapproved instruction files, then the
   * volatile turn-local block — the order they ride ahead of the turn in.
   *
   * Both are turn-scoped user messages that are absent more often than not,
   * which is the whole of the branching here: three independent "is there
   * anything to say" decisions whose only shared answer is this array. The
   * unapproved half of the two instruction sources the system prompt just
   * rendered is agent-writable, so it rides one sealed user message instead of
   * the system plane, and it is null when every discovered file was approved.
   *
   * Never persisted: `assembleTurnMessages` appends this after the extension
   * transformContext seam, so compaction never sees it.
   */
  private turnLocalTail(
    deviceNotice: string | null,
    agentsMd: AgentsMdSources,
    activeSkills: ActiveSkillSet | undefined,
  ): ModelMessage[] {
    // Provenance rides here, not in the system prompt: it flips whenever a
    // background job lands mid-session, and at system placement that flip
    // rewrote the whole cacheable prefix twice — once into the wake and once
    // back out (core prompting/volatile-context.ts).
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

  /** The item the loop admitted for the turn in flight: what the three
   *  readers of the driving message's metadata (`turnWorkMode`,
   *  `turnProvenance`, `turnUserMetadata`) answer from. */
  private _turnItem: ChatTurnInput | null = null;

  /**
   * Assemble one admitted turn — the ChatSession's `prepareTurn` port.
   *
   * The loop has opened the turn (the run row, the lease); this backend
   * supplies what only it knows — the owner-side reads, the profile, the
   * skills and MCP tools, the prompt, the model, the tools — and places the
   * turn's input on the actor's working history. Everything after the reads is
   * `assembleTurn`, unchanged from the turn Think used to run.
   */
  protected async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease): Promise<PreparedTurn> {
    this._turnItem = item;
    this._turnProgram = null;

    // The previous turn's resolved profile ends HERE, before anything reads a
    // mode: `turnWorkMode()` prefers the bound profile over the driving
    // message, so a profile left bound from the last turn answered for this
    // one — and the tool build below is the first reader. Clearing it in the
    // owner-side reads instead ran one call too late and cost a composer's
    // Plan press its `submit_plan` on every turn but a workspace's first.
    this._turnOperation = null;
    // The CHAT view, not the raw surface: a slow `run` must detach into a
    // background job whose settle wakes a turn, and that wrap lives here. The
    // workerd background-wake proof is what tells the two apart.
    const tools = this.getTools();
    const reads = await this.readTurnInputs(tools);
    this._executorsUsedThisTurn.clear();
    const body = item.metadata === undefined ? {} : jsonObject(item.metadata);
    this._cliCwd = readCliCwd(body);
    this._turnContinuity = readTurnContinuity(body);
    // The evolution gate, read WHERE THE TURN OPENS: core derives the same value
    // at `beginTurn`, and the recorded turn carries it so a recovering host's
    // own engine cannot re-judge a turn it did not run.
    this._turnEvolutionEnabled = this.turnRecordsEvolution();

    // A real user message is the verdict on the previous turn — dispatch the
    // detached outcome review. Programmatic turns (reactor / job wake) are not
    // user verdicts.
    if (item.kind === 'user') this.orch.observeUserTurn(item.text, this._turnContinuity);
    // Each run opens a new analytics write window.
    openAnalyticsWindow(this.env);

    // The turn's input is already on the working history: the loop placed it
    // there (core's one rule for where a turn's conversation comes from)
    // before handing the turn here.
    const history = this.actorSession.history;
    // The conversation this turn was opened over, its own message included —
    // what a hire with context:'inherit' is born from, frozen here so a
    // background re-drive carries the conversation the caller actually had.
    this._turnOriginContext = Object.freeze(structuredClone([...history]));
    const assembled = await this.assembleTurn({ history, tools, body, reads });
    this._turnDurableLength = assembled.rawMessages.length;
    // The profile the turn runs under, bound exactly once before execution —
    // the actor session's own guard, and where the CLI adapter binds it too.
    this.actorSession.bindProfile(lease, assembled.profile, assembled.profileInputs);

    const liveTurn: ActorExecutionInput['chat'] = {
      model: assembled.model,
      modelContext: {
        id: assembled.promptModel.id,
        contextWindow: assembled.contextWindow,
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      },
      system: assembled.system,
      attachments: {
        accepts: this.sessionAcceptedMedia(), vfs: this.rt.storage.vfs, budget: this.acc.context,
      },
      turnLocal: assembled.turnLocal.length > 0 ? assembled.turnLocal : undefined,
      tools: assembled.tools,
      activeTools: assembled.activeTools,
      // NO STEP CAP, stated rather than inherited: the agentic loop runs until
      // the model stops calling tools, and what bounds it is the budget
      // governor and the caller's cancel (see core chat.ts, UNBOUNDED_STEPS).
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
      observeStream: (chunks: ReadableStream<UIMessageChunk>) => this.chatTransport.observe(chunks),
    };

    if (assembled.measured.providerReportedTokens !== undefined) {
      liveTurn.providerReportedTokens = assembled.measured.providerReportedTokens;
    }

    if (assembled.reasoningOptions) liveTurn.providerOptions = assembled.reasoningOptions;
    const runtime = this.rt;
    this.acc.composition.openTurn({ system: assembled.system, tools: assembled.tools });

    return {
      execution: {
        loopVersion: await runtime.identity.scaffold.version(),
        chat: liveTurn,
        // This actor's registered extensions, every one: the turn composes its
        // own host over them and adds the orchestrator's inbox extension itself.
        extensions: this.extensions.list(),
        dynamic: (profile, tools) => this.dynamicContextSnapshot(profile, tools, assembled.memoryTail),
        scaffoldSpend: { source: 'scaffold', report: (report) => this.reportModelCall(report), operations: this.modelOperations },
      },
      sessionKey: this.name,
      contextWindow: assembled.contextWindow,
      historyLength: assembled.rawMessages.length,
    };
  }

  /** The conversation cleared, on the client's ask: the transcript, the
   *  working history, the dynamic ledger, the compaction plan. */
  private async clearConversation(): Promise<void> {
    this.chatTranscript.clear();
    this.dynamicLedger.reset();
    this.contextPlane.hydrate([]);
    this.actorSession.restoreWorkingHistory(() => []);

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

  /**
   * Everything a turn reads BEFORE it opens: the scaffold and the soul, then
   * the four owner-side reads. Awaited ahead of `orch.beginTurn`, so a send
   * that arrives during a cold workspace's bootstrap is routed as it was
   * before the assembly moved — the turn is not in flight until the reads are
   * back.
   */
  private async readTurnInputs(tools: ToolSet): Promise<TurnReads> {
    // The scaffold and the soul are both files this turn is about to read, and
    // this is the first place with a promise to await them on.
    await this.ensureOwnedScaffold();

    if (this._cachedSoulText === null) await this.refreshSoulText();

    // Four reads of the owner's UserDO, each a Durable Object hop, started
    // together: the profile catalog, the MCP descriptor surface, the device
    // presence and the workspace title. None depends on another, so the turn
    // pays one hop of latency instead of four. Each keeps its own failure arm.
    const [profileInputs, mcpTools, deviceStatus, identity] = await Promise.all([
      this.profileInputs(),
      // `tools` is the actor's own surface, handed over because the remote
      // catalog is admitted against what the step context limit has LEFT after
      // it: the builtins are not negotiable, so they are priced first. A failed
      // read answers no tools and records why; the turn runs on builtins.
      this.buildUserMcpTools(tools),
      // One authoritative hub check so the executor list reflects the CURRENT
      // device state; the transport's TTL-cached snapshot can lag a mid-session
      // `kinu connect` by a turn. `refreshStatus` records its own failure and
      // answers the last snapshot.
      this.rt.deviceTransport.refreshStatus(),
      // Names, on the authoritative prompt only: a title is read from the
      // owner's registry, which is an await.
      this.promptIdentity(),
    ]);

    return { profileInputs, mcpTools, deviceStatus, identity };
  }

  /**
   * One turn's surface, assembled: the profile, the skills and MCP tools on
   * this surface, the device presence, AGENTS.md, the prompt, the model, the
   * active tools, the cache plan and the measured compaction trigger.
   *
   * Everything here is this backend's composition of the turn; the loop that
   * runs it is core's, and reads the result in its own vocabulary. Runs after
   * the turn is open (`orch.beginTurn`, the run row) and before the first
   * model call.
   */
  /** The id a turn's answer is persisted under — every durable row of the
   *  answer is keyed on it. Random here; a harness that must read the rows it
   *  names back overrides this and nothing else about the identity. */
  protected mintAnswerId(): string {
    return crypto.randomUUID();
  }

  /** Whether this process may drive the loop right now. Nothing coordinates
   *  two activations of one Durable Object — the platform serializes them —
   *  so it always may; named so a suite can state the one refusal the loop
   *  answers a send with. */
  protected driverGate(): Refusal | null {
    return null;
  }

  /** The model a turn runs on, bound from the profile's tier. ONE override
   *  point: a harness scripts the model here and nothing else about a turn. */
  protected turnModel(spec: string): LanguageModel {
    return this.ownedModelServices.resolveModel(spec);
  }

  private async assembleTurn(input: TurnAssemblyInput): Promise<AssembledTurn> {
    const { profileInputs, mcpTools, deviceStatus, identity } = input.reads;
    const activeRoleId = this.activeRoleLabel();
    const roleSkills = effectiveRoleCatalog(profileInputs.envelope.catalog)[activeRoleId]?.skills ?? [];
    this._workspaceInstructionApprovals = null;
    // ── Skills resolution for this turn (core turn-surface) ──────────────
    this._turnActiveSkills = null;
    // The actor's REAL tool surface: deps-gated builtins (report) are
    // advertised only when this actor class wires them, and the agents
    // ladder renders only the actions this profile supports — then
    // restricted to the active skills' allowed union (core turn-surface).
    const turnActorDeps = this.actorToolDeps();
    const requestedWorkMode = this.turnWorkMode();
    let activeTools: BuiltinToolName[] = actorActiveTools(turnActorDeps);
    const trust = this.instructionTrust();

    const { available: availableSkills, activeSkills: activeSetForPrompt } = await resolveTurnSkills({
      vfs: this.getSkillsVfs(),
      config: this.config,
      userText: extractLastUserText(input.history),
      roleSkills,
      trust,
      limits: {
        contextWindow: this.sessionContextWindow(),
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      },
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
    // The turn's WHOLE nameable surface. `release` / `agent` / `llm` are
    // reachable only inside `eval`, so no native tool id names them and
    // without them here the role intersection drops every one — a narrowed role
    // would silently lose its codemode lanes wholesale. Derived from the
    // providers actually wired for this mode, so a capability is never offered
    // whose namespace is absent (Plan mode drops `release` for free).
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
      // Most specific first: the tier named on THIS request, then the tier the
      // parent pinned when it hired this agent, then nothing — which lets the
      // resolver take the role's own default. An absent pin must not read as
      // "the workspace default"; the role's tier is what an unpinned hire asked
      // for.
      explicitTier: readTurnTier(input.body) ?? this.config.getAssignedTier() ?? undefined,
      // The workspace's pinned model overrides the role's tier model inside
      // the resolver. Without it a setModel pin is accepted and never run on.
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

    // The persisted watermark is only a diff anchor for the one-turn change
    // notice; the hub stays the single source of truth.
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

    // AGENTS.md (agents.md standard) — agent VFS root + the sandbox workspace
    // when one is already active. Like skills/MCP, this is turn-scoped state,
    // so it rides the beforeTurn system override, not the cached base prompt.
    const agentsMd = await collectWorkspaceAgentsMd(
      this.rt.storage.vfs,
      {
        contextWindow: this.sessionContextWindow(),
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      },
      trust,
      this.rt.executionRouter?.getProvider('sandbox'),
    );

    // The per-turn system prompt is ALWAYS assembled here (TurnConfig.system
    // overrides) — Think calls getSystemPrompt() BEFORE beforeTurn, so only
    // this path can reflect the turn's active skills and MCP tools. It is the
    // byte-stable cache prefix: it changes only on real agent events (soul,
    // model, skill set, tool surface, AGENTS.md). System state — facts, the
    // live executor status — rides the dynamic ledger's frozen blocks, and
    // turn-local state — the device notice, activation reasons — rides one
    // trailing message (prompting/volatile-context.ts), so neither ever
    // re-prefills the prefix.
    const execs = this.rt.executionRouter?.listExecutors() ?? [];
    const model = this.promptModelContext();

    const promptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {
      soulOverride: this.getSoulText(),
      executors: execs,
      availableTools: promptActiveTools,
      agentsActions: resolvedAgentActions,
      // The temporary rung is wired wherever this actor holds team deps, and
      // the ladder's middle rung has to be advertised on the ONE authoritative
      // prompt (this object; TurnConfig.system overrides getSystemPrompt's
      // cached base) or no shipped turn ever mentions it.
      temporaryAsk: turnActorDeps.team?.temporary !== undefined,
      externalTools: mcpToolNames.filter(toolAllowed)
        .map((name) => ({ name, source: 'mcp' as const })),
      backend: 'cf',
      roleSection: profile.role,
      model,
      currentDate: currentDateForPrompt(),
      // Prompt sections the evolution loop promoted. Read here, not inside the
      // builder: the builder is the byte-stable cacheable prefix and does no
      // I/O, exactly as with the soul.
      sectionOverrides: activePromptSectionOverrides(this.rt.storage.sql, this.actorHandle()),
      identity,
    };

    if (availableSkills.lines.length > 0) promptOptions.availableSkills = availableSkills;

    if (activeSetForPrompt) promptOptions.activeSkills = activeSetForPrompt;
    promptOptions.agentsMd = agentsMd;
    const systemOverride = buildSystemPromptSync(this.rt, promptOptions);
    this.recordSystemPromptHash(systemOverride);


    const languageModel = this.turnModel(profile.tier.model);

    // The measured compaction trigger, read from the durable state by core in
    // the one correct order (orchestrator/turn-context.ts). Attachment
    // sanitization is copy-on-write per message with per-part replacement, so
    // the raw count IS the sanitized durable length — and it is stashed because
    // recordTurnTelemetry writes the next measurement against the same number.
    const rawMessages = this._cliCwd ? withCliCwdContext(input.history, this._cliCwd) : input.history;
    this._turnDurableLength = rawMessages.length;
    this._turnContextWindow = this.sessionContextWindow();
    const measured = measureCompactionTrigger(this.compactionState, this.name, rawMessages.length);

    // The forced rebuild was armed either by overflow recovery (onChatResponse,
    // on a context_length failure) or by the agent itself (agent.compactNow).
    if (measured.trigger === 'force') this.logActivity('compaction_forced', 'forced context rebuild');
    // The newest MEMORY.md lessons/reflections ride the dynamic block too (the
    // same bounded tail the CLI supplies) — the reflection loop assumes the
    // model sees its latest lessons in-turn. Read once here rather than per
    // step: it is the one dynamic-context input that needs an await.
    const memoryTail = await readMemoryTail(this.rt.memory);
    const turnLocal = this.turnLocalTail(deviceNotice, agentsMd, activeSetForPrompt);

    const submittedTools = { ...modeTools, ...effectiveTools };
    const providers = this.providerRegistry();
    // NORMALISED, and by the same registry that will serve the request. The
    // model actually submitted comes from `resolveModel`, which normalises
    // first, so parsing the RAW tier spec answered differently for exactly the
    // forms normalisation exists to accept: a bare model id has no slash and
    // `parseModelSpec` THROWS on it inside turn assembly, and a bare `@cf/…`
    // parses to provider `@cf`, which no registry knows.
    //
    // ONE parse, read by both the admission counter and the reasoning-effort
    // options below. Those were two separate raw parses of the same field, and
    // `owned-model-services.ts` already did the normalised thing for its own
    // copy — three answers to one question.
    const tierModel = parseModelSpec(providers.normalizeSpecSync(profile.tier.model));

    const activeToolSurface = Object.fromEntries(effectiveActiveTools.flatMap((name) => {
      const entry = submittedTools[name];

      return entry === undefined ? [] : [[name, entry]];
    }));


    const countInputTokens = (request: CountableRequest): Promise<InputTokenCount> => countRequestInputTokens(
      providers.registry.get(tierModel.provider), tierModel.modelId, providers.deps, request,
    );

    const taskPlan: TaskPlanContext = Object.freeze({ sql: Object.freeze([this.boundSql, this.rt.storage.sql]), plan: this.approvedTaskPlan() });
    const tools = withOperationProfile(withTaskPlan(toolsForInvocation(workMode, { ...modeTools, ...effectiveTools }), taskPlan), operation);


    // uses (prompting/cache-breakpoints.ts `promptCachePlan`), so a change to
    // strategy resolution, system eligibility or routing reaches both loops.
    // Only the message tail differs: request-level cache routing rides
    // TurnConfig.providerOptions, while the cache-eligible system message and
    // the rolling tail breakpoints for marker providers (Anthropic) ride
    // beforeStep — PrepareStepResult carries typed system/messages overrides
    // for every step's request, whereas TurnConfig.system is string-typed.
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
      rawMessages, turnLocal, measured, contextWindow: this._turnContextWindow, memoryTail, countInputTokens,
      cacheOptions, reasoningOptions, promptModel: model,
    };
  }


  /** The in-flight turn's resolved context window — set in beforeTurn, read
   *  by beforeStep's prune budget every step. */
  protected _turnContextWindow = 0;
  private _turnOriginContext: readonly ModelMessage[] = [];


  /**
   * The planes only a subclass's own stores can answer, as typed source
   * callbacks read per step by the shared assembler. Empty here; the
   * orchestrator supplies the decisions parked on its user and the notices only
   * it learns.
   */
  protected extraDynamicContext(): ActorDynamicContextExtras {
    return {};
  }

  /**
   * The live state of this agent, read fresh for ONE model step.
   *
   * Every field comes from its existing store — nothing here holds state of its
   * own — and nothing is clock-derived: a wall-clock field would re-fingerprint
   * the block on every request and append a block per step.
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

  /** The byte-stability invariant as telemetry: the system prompt hash should
   *  change only on real agent events (soul/skill/craft/device/model), never
   *  between two vanilla consecutive turns. A "(changed)" entry in the
   *  activity log without a nearby skills_active / device / craft event is a
   *  cache-prefix regression. */
  private _lastSystemPromptHash: string | null = null;
  private recordSystemPromptHash(system: string): void {
    const { hash, status } = observeSystemPromptHash(this._lastSystemPromptHash, system);
    this._lastSystemPromptHash = hash;
    this.logActivity('system_prompt_hash', status === 'first' ? hash : `${hash} (${status})`);
  }

  /** Whether the in-flight turn was injected programmatically (an event drain,
   *  a background-job wake, an overflow retry) — a queued signal stamps
   *  kinuEvent metadata on the saved user message; real chat messages carry
   *  none. */
  protected lastUserTurnIsProgrammatic(): boolean {
    return this.turnUserMessageEvent() !== null;
  }

  /** The surface THIS turn runs on. A chat turn is interactive — a human is
   *  watching the stream, so slow work must hand back a handle fast. Anything
   *  driven by a queued signal (an event drain, a background-job wake, a timer,
   *  an overflow retry) has nobody watching and is one-shot: detaching there
   *  buys nothing and costs a truncated turn plus a synthesis turn, and the
   *  model answers by polling its own jobs instead of working. */
  protected turnSurface(): InvocationSurface {
    // Two independent ways a turn can have nobody watching a stream, and both
    // count. A CLI one-shot invocation against this workspace stamps `oneShot`
    // on the request body (readTurnContinuity → 'independent_task'). A turn a
    // queued signal drove — an event drain, a background-job wake, a timer, an
    // overflow retry — carries `kinuEvent` metadata on the message that
    // drives it, the same discriminator every other programmatic-turn decision
    // reads. Continuity alone would miss the whole autonomous population,
    // which is the population the one-shot policy was measured on.
    const programmatic = this.turnUserMessageEvent() !== null;

    // A human typed into this turn while it ran: from that step on someone
    // IS watching the stream, whatever drove the turn. The first-run
    // background-settle row on build cba44dcb9 landed its ask as a steer
    // inside the genesis turn, and the run tool kept the one-shot window, so
    // a 45 s sleep ran inline and no wake ever engaged.
    if (this.actorSession.landedSteers.length > 0) return 'interactive';

    return programmatic || this._turnContinuity === 'independent_task' ? 'one-shot' : 'interactive';
  }

  /** The turn's kinuEvent metadata value — off the item the loop admitted.
   *  Null for real chat turns. */
  protected turnUserMessageEvent(): string | null {
    const metadata = this.turnUserMetadata();

    return metadata !== undefined && v.is(v.string(), metadata.kinuEvent) ? metadata.kinuEvent : null;
  }
  /** What the turn may do. Plan is explicit user intent on the driving
   * message; everything else is ordinary unconstrained work. */
  protected turnWorkMode(): WorkMode {
    return this.operationProfile()?.profile.workMode ?? workModeForTurnMetadata(this.turnDrivingMetadata());
  }

  /** Why the turn is running — read from the event alone, never from the work
   * mode stamped beside it. */
  protected turnProvenance(): TurnProvenance {
    return turnProvenanceForMetadata(this.turnDrivingMetadata());
  }

  /** The metadata of the message driving this turn: the active programmatic
   * message when one drove it, else the last durable user message. Parsed at
   * this boundary so both axes read one already-narrowed shape. */
  private turnDrivingMetadata(): JsonObject | undefined {
    return this.turnUserMetadata();
  }

  /** What this turn was started BY: the metadata on the item the loop admitted
   *  — a signal's `kinuEvent` / `signalId` / mission labels, the composer's
   *  mode, or nothing at all for a chat turn the operator typed. With no turn
   *  running, the newest user row's: the idle reads (the tool listing) narrow
   *  their mode off the last message, as they did off Think's cache. */
  protected turnUserMetadata(): JsonObject | undefined {
    // The item is the turn's for as long as the loop holds the turn — through
    // its settle — and a finished turn's item names nothing any more. Read off
    // the loop only when one exists: an idle read must not build it.
    const metadata = this._chatLoop?.turnInFlight() === true ? this._turnItem?.metadata : undefined;

    if (metadata === undefined) return this.chatTranscript.lastUserMetadata();
    const parsed = v.safeParse(JsonObjectSchema, metadata);

    return parsed.success ? parsed.output : undefined;
  }

  /** The shared background wrap (core jobs/background-wrap): shallow clone, 30s
   *  threshold on the named set (with its per-call gate — `agents` detaches only
   *  the search rung), per-call AbortController merged with the turn's signal. The
   *  tracking hook keeps foreground cancellation working until a call settles or
   *  detaches. An ACTOR names the full set; a confined surface names its own, which
   *  is what keeps containment structural rather than incidental. */
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

  /** The device-request channel the `eval` call now running was armed
   *  with, or null outside one. */
  private _activeDeviceRequests: DeviceRequestChannel | null = null;

  /**
   * Publish the per-invocation device-request channel for the duration of one
   * `eval` call.
   *
   * A codemode script issues device execs for as long as it runs — including
   * after its call has detached into a background job — and the channel is what
   * carries the owning job into each of those execs. It cannot be a construction
   * argument: `createCodemodeToolFactory` builds its provider namespaces once per DO
   * lifetime, while the channel belongs to one invocation.
   *
   * Applied INSIDE the background wrap, because the wrap is what arms the bag:
   * core's wrapper reads the options, arms the channel, and calls this. Restored
   * rather than cleared on the way out, so a nested or inline call cannot inherit
   * a finished invocation's owner. The raw surface is untouched — the eval
   * side-streams share that object and must stay unwrapped.
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
          this._activeDeviceRequests = readDeviceRequestChannel(options) ?? null;

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
   * The profile every producer's model routes through: the live turn's when a
   * turn is open, else one resolved now for durable work that began without a
   * chat turn (the review lane, a recovered fiber, a background job's wake).
   *
   * MODEL_ROUTE_POLICY is read against THIS, so a producer that resolves a
   * model any other way has bypassed the one routing table.
   */
  protected async routingProfile(availableTools: readonly string[] = []): Promise<ResolvedTurnProfile> {
    return resolveRoutingProfile({
      actor: this.actorHandle(),
      resolve: async () => resolveAgentTurnProfile({
        ...(await this.profileInputs()),
        activeRoleId: this.activeRoleLabel(),
        workMode: this.turnWorkMode(),
        availableTools,
        activeSkills: [],
        explicitTier: this.config.getAssignedTier() ?? undefined,
      }),
    });
  }
  /**
   * THE SAME AUTHORITY, resolved for ONE hosted actor rather than for the root.
   *
   * A hosted turn — a head, a node, a delegated hire, a slate call down the hop
   * path — resolving `routingProfile()` would read `this.activeRoleLabel()` and
   * `this.config`: the ROOT's role and the root's tier. A child narrowed to
   * `scribe` would be answered with the root's unrestricted surface, and the
   * seams that take an `actor` argument to say whose profile they want would
   * ignore it — a role restriction that is durable, per actor and enforced
   * nowhere.
   *
   * The child's role comes off its OWN handle: `ActorHandle.config` is bound to
   * that actor's id and re-validates the binding on every read, so this cannot
   * name a retired or re-parented actor's rows.
   *
   * `profileInputs()` stays the WORKSPACE's — the catalog envelope, the
   * provider snapshot — which is what makes this a NARROWING. The resolver
   * intersects the requested role against the roles the workspace actually
   * offers, so a child whose stored selection names a role this workspace does
   * not publish narrows to nothing rather than widening to everything. That
   * intersection is `resolveAgentTurnProfile`'s own rule for a chat turn, which
   * is exactly why the role is handed to it instead of applied here.
   *
   * The requested actor resolves its own authority; the root's admitted
   * operation is not this actor's profile.
   *
   * THE WORKSPACE'S PINNED MODEL IS PASSED, exactly as the root's own chat turn
   * passes it (`beforeTurn`), because the pin is the workspace's and a hosted
   * actor's turn is one of that workspace's turns. Without it every hosted turn
   * — an actor pane's chat, a hire's delegated turn, a head, a node — ran on
   * the account catalog's tier model while the workspace said it was pinned:
   * measured 2026-09-18 on a local dev build, a workspace pinned to
   * `openai-compat/fake-live` answered its subordinate pane's message on
   * `workers-ai/@cf/zai-org/glm-5.3`. The role still decides the TIER; the pin
   * decides the model, and `tier.source` records which one the turn ran under.
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
   * One producer's resolved model, with the spec that prices it and the provider
   * options for the effort its tier chose.
   *
   * All three are ONE decision, so they are returned together: a caller that
   * re-derived any of them beside this could disagree with the route it came
   * from — a spend row priced against a different spec than the call used, or an
   * effort nobody chose. Effort derivation stays inside `owned-model-services`,
   * which is what keeps the three-site invariant that
   * `unit-turn-pipeline-correctness.test.ts` pins.
   *
   * Reading `profile.tiers.<name>` at a callsite instead would re-state that
   * producer's routing decision beside the table that owns it, so a change to
   * MODEL_ROUTE_POLICY would leave the callsite silently on the old tier —
   * same shape, wrong model, correct-looking spend row.
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

  /** Review and judge work. The route table says which tier that is. */
  protected async getModelForReview(): Promise<LanguageModel> {
    return (await this.modelForSource('judge')).model;
  }

  // ── Durable execution — surviving Durable Object eviction ─────────
  //
  // Three kinds of work outlive the request that started them: a search
  // (`mcts`, from mcts/engine.ts via rt.schedule.fiber), a detached tool call
  // (`bg:<kind>`, from the core BackgroundJobRunner), and the two post-turn
  // lanes above. All four go through `runFiber`, so each writes a
  // `cf_agents_runs` row with its stashed identity before it runs. What an
  // interrupted row BECOMES is the recovery roster's business, and that lives
  // in ./fiber-recovery.ts beside this backend's two cf-minted lane names;
  // `onFiberRecovered` hands it this actor's transports and nothing else.

  /**
   * Classify each interrupted fiber, and hand its work to a carrier that is
   * allowed to take as long as the work takes.
   *
   * NOT `async`, and that is the enforcement rather than a style. The SDK awaits
   * this hook from `_checkRunFibers`, which `startAgent` awaits inside
   * partyserver's `blockConcurrencyWhile` — so a promise this method hands back
   * is a promise every `fetch`, websocket frame and alarm on this object waits
   * on, and at `do.block_concurrency.cancel_ms` the runtime cancels the gate and
   * RESETS the object. A non-async method cannot await, so the only thing the
   * gate can wait on here is the classification itself, which is synchronous by
   * construction (./fiber-recovery.ts) and hands every re-drive to
   * {@link redriveRecoveredLane}. `scripts/do-init-gate.ts` holds both halves of
   * that shape.
   *
   * The roster owns the dispatch, the per-lane semantics and the terminal-result
   * discipline — it never throws, because a thrown hook re-offers the row for a
   * day; this override only supplies what a fresh activation can re-resolve.
   */
  override onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
    this.actorHandle();

    return Promise.resolve(classifyRecoveredFiber(this.fiberLanes, ctx));
  }

  /** The transports {@link onFiberRecovered}'s arms classify against and hand
   *  their re-drives to: stub calls, a fresh model route, this activation's own
   *  storage. Built fresh per recovery rather than captured at interruption time
   *  — the whole point of a wake is that the world moved. */
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

  /**

  /**
   * The recovery budgets this backend DECLARES rather than inherits.
   *
   * Both were the SDK's defaults, and a default is not a decision — one of them
   * was already hand-mirrored into `orchestrator.ts` to decide which overdue
   * schedule rows are unrunnable, which made the number one nobody owned.
   * Declaring them here means the value Kinu reads and the value the framework
   * enforces are the same value (see fiber-recovery.ts).
   */
  static options = {
    fiberRecoveryMaxAgeMs: FIBER_RECOVERY_MAX_AGE_MS,
  };

  /**
   * Drop the interrupted-fiber rows the recovery budget has already refused.
   *
   * This is cleanup only. It clears rows the budget has already ruled out; it
   * is not proof that activation avoids snapshot allocation, which the SDK's
   * recovery scan owns independently.
   *
   * Called from each actor's `onStart`. Synchronous and cheap by construction
   * (metadata pages, one bounded pass), it is safe inside the init gate; a
   * failure is named and dropped, because a workspace that cannot prune is
   * still a workspace that must activate.
   */
  protected sweepUnrecoverableFiberRows(): boolean {
    // A failed pass is UNFINISHED work, not a clean tree: it answers truncated
    // so the caller arms the wake and the next tick retries the same bounded
    // sweep — the value a caller can tell apart from "swept and found nothing".
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

  /** The asynchronous half of maintenance — recovery work that may queue turns
   *  or cross objects, which is why it lives in the alarm frame and never in
   *  an activation. Idempotent by contract; the base owns none. Answers
   *  whether the pass filled a budget and must continue on the next tick. */
  protected async maintenanceWork(): Promise<boolean> {
    return recoverSubordinateLifecycles(this.subordinateRoster, this.subordinateRuntime());
  }

  /** Detached work this actor owns until its lexical error boundary settles. */
  protected readonly _backgroundTasks = new Set<AsyncTaskOwner>();

  /**
   * Hold one detached task for as long as this activation owns it.
   *
   * The plumbing every detached chain in this backend had written out by hand:
   * take an owner, run the body, release the owner whatever happened. Written
   * once because the ownership is the point — a Durable Object cancels an
   * in-flight promise on reset with its rejection swallowed
   * (`do.background_task.cancelled_on_reset`), so a floating promise is work
   * nothing can join, name or report. This is NOT durability: a task that must
   * survive an eviction rides a fiber row ({@link redriveRecoveredLane}).
   *
   * THE BODY CLASSIFIES ITS OWN FAILURE, and that division is deliberate: an
   * event name is only queryable where it is written as a constant, so the
   * outcome is named by the site that owns it rather than handed here as a
   * parameter. The catch below is a backstop for a body that broke that
   * contract, not the reporting path — an unhandled rejection in a Durable
   * Object is invisible, and one named event is what makes it not.
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
   * Await every detached task this activation currently owns.
   *
   * The harness seam for suites that assert against the SETTLED
   * post-activation world: every detached task is fenced or idempotent, so
   * production never needs this — but a test snapshotting state the
   * activation's own sweeps also touch must join them explicitly rather than
   * assume a scheduling order. Laps because a task may enqueue another, and
   * BOUNDED so a task that keeps replenishing the set — a genesis turn, a
   * re-armed timer — fails the caller by name instead of hanging it.
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

  /** Every budgeted activation sweep this actor owns; a subclass with more
   *  tables overrides and folds its own in. Answers whether ANY pass filled
   *  its budget — the caller arms the wake on true. Synchronous and bounded by
   *  construction, which is what lets the init gate run the SAME seam the alarm
   *  frame runs instead of a hand-folded copy of it. */
  protected maintenanceSweeps(): boolean {
    return this.sweepUnrecoverableFiberRows();
  }

  /**
   * Re-drive one interrupted lane OFF the init gate, durably.
   *
   * The half of fiber recovery that may take as long as its work does: a model
   * call, a turn queued by a job's wake, an SMTP round trip behind a terminal
   * wake. A `runFiber` rather than a bare promise, for the same reason the
   * terminal close is one — a JavaScript reference to a pending promise is not
   * durable, while the fiber's `cf_agents_runs` row is written by the
   * SYNCHRONOUS prefix of `runFiber`, before this method returns. So the
   * obligation the SDK is about to delete has a replacement carrier by the time
   * the hook answers, and an interruption of the re-drive is handed back to the
   * same classification, under the same lane name, with the same checkpoint.
   *
   * The DURABLE carrier is the fiber row; the in-memory owner is
   * {@link detachOwned}'s, shared with every other detached chain here — one
   * dispatch per entry, because a single scan can offer two rows of one lane
   * and each carries its own checkpoint.
   */
  protected redriveRecoveredLane(
    lane: string, checkpoint: JsonValue, body: () => Promise<void>,
  ): void {
    this.detachOwned(async () => {
      try {
        // The SDK's protected stash wrapper writes `initialSnapshot` in the SAME
        // synchronous prefix as the row insert (`agents/dist/index.js`
        // `_runFiberInternal`: the INSERT, then `writeSnapshot`, both before the
        // first await) — so there is no window in which a reset finds a
        // recoverable lane with a null payload. The public `runFiber` reaches
        // the same internal with no options; this seam is that composition.
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

  /** Invalidate every cache that depends on the resolved model so the next
   *  getModel() / providerRegistry() call rebuilds. */
  protected invalidateModelCaches(): void {
    // Drops the resolved model AND the provider registry, which caches
    // per-agent OAuth refreshers — rebuilt so a disconnected provider stops
    // being marked available.
    this.ownedModelServices.invalidate();
  }

  // ── Credentials & Codex OAuth ─────────────────────────────────────
  //
  // All credentials live in UserDO (single source of truth across the user's
  // agents). The orchestrator stores, refreshes, and reads no raw
  // credentials — providers resolve auth headers through the UserDO
  // stub at fetch time. Use the `/api/user/codex/*` routes (or the user
  // settings UI) to connect ChatGPT / save BYO API keys.

  /** Worker fan-out target (user/workspace-access notifyWorkspacesCredentialsChanged):
   *  invoked after credential mutations in UserDO so cached provider/model
   *  state in this agent is dropped. Cheap; no-op if nothing is cached. */
  async onCredentialsChanged(): Promise<{ ok: true }> {
    this.invalidateModelCaches();

    return { ok: true };
  }

  /** Re-drive an evicted background job from its durable checkpoint (B6) —
   *  the shared resume gate (core background-tools) over the RAW surface, so a
   *  re-drive can't detach a second job. Rows stored under the removed `fork`
   *  action, and 'think' rows older still, translate onto the search path. */
  protected resumeBackgroundJob(
    kind: string,
    input: JsonValue,
    mode: WorkMode,
    signal: AbortSignal,
  ): Promise<JsonValue | undefined> {
    return resumeBackgroundJob(
      (resumeMode) => this.getRawToolsForWorkMode(resumeMode),
      kind,
      input,
      mode,
      signal,
    );
  }
}
