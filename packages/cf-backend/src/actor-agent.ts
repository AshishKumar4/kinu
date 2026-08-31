/**
 * ActorAgent — the actor-agnostic substrate beneath every full-loop Kinu
 * actor on the Cloudflare backend.
 *
 * OrchestratorAgent (the top-level workspace DO) and any future facet actor
 * (a subordinate riding the workspace via subAgent()) are Think subclasses
 * that differ only in the profile members below — identity bootstrap
 * (getOwnerUserId), exec-plane keying (workspaceName), tool surface
 * (actorToolDeps / extraCodemodeProviders), evolution engine, and owner
 * notification. Everything else — the CF runtime assembly, the BackendHost,
 * the shared AgentOrchestrator, ExtensionHost + compaction, the dynamic
 * ledger, prompt/model/tool caches, and the Think hook bridge (beforeTurn /
 * beforeStep / tool hooks) — lives here, once.
 *
 * Tool gating is structural: an actor whose profile wires no `team` deps has
 * no hiring actions on its `agents` tool. No flags.
 */

import {
  callable,
  type AgentContext, type Connection, type ConnectionContext, type SubAgentClass,
  type WSMessage,
  type FiberRecoveryContext, type FiberRecoveryResult,
} from "agents";
import { ExplorationAgent } from './exploration';
// Type-only, so it is erased and the base class carries no runtime import of
// its own subclass. The VALUE comes from `subordinateFacet()`, which each
// concrete root supplies.
import type { SubordinateAgent } from './subordinate-agent';
import type {
  SubordinateActivityEvent,
  SubordinateRosterEntry as SubordinateView,
} from './lib/protocol';
import { parseProtocolMessage } from "agents/chat";
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
import { retryTransientDO } from "./lib/do-rpc";
import { createWorkersTracer } from "./obs/cf-tracer";
import { createAgentTracing, renderThrownChain, type AgentTracing } from "@kinu.run/core/obs";
import {
  createCompactionExtension, createSharedPrefixCompactor, createVfsTranscriptStore,
  createCompactionStateStore, createModelSummarizer, COMPACTION_PRESETS,
  type CompactionStateStore, type Logger as CompactionLogger,
} from "@kinu.run/compaction";
import { Think, Session } from "@cloudflare/think";
import { streamText, generateText, tool, jsonSchema, convertToModelMessages } from "ai";
import type { LanguageModel, ModelMessage, SystemModelMessage, ToolSet, UIMessage } from "ai";
import {
  McpToolSurfaceCache, toolSurfaceTokens,
} from "./user/mcp";

import type {
  TurnContext, TurnConfig,
  ToolCallResultContext, StepContext, ChunkContext,
  PrepareStepContext, StepConfig,
  ToolCallContext as ThinkToolCallContext,
  ChatResponseResult,
  StreamableResult,
} from "@cloudflare/think";
import {
  EvolutionEngine, type EvolutionConfig,
  // Scaffold loop closure — the evolved inference loop + its sampled
  // shadow rollout. Shared by every actor that carries an EvolutionEngine.
  scaffoldInferenceTransform, type ScaffoldRunOptions,
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  queueTurnShadowTrial, runQueuedShadowTrials, createJsonJudge, type ScaffoldControl,
  // Continual refinement — the lane's deps come from four seams this class
  // already owns; nothing about it is Cloudflare-shaped.
  advanceRefinementLane, refinementDebtRequest, type RefinementDeps,
  effortFor, type CompletedTurn, type TurnContinuity, UNBOUNDED_STEPS, UNBOUNDED_MAX_STEPS,
  runAdvisorLane,
  type AdvisorRecoverySnapshot, type AdvisorDisposition,
  // canonical tool + prompt surface — single source of truth
  buildActorTools,
  withClampedToolResults,
  type WebSearchProvider,
  buildSystemPromptSync,
  activePromptSectionOverrides,
  currentDateForPrompt,
  turnProvenanceForMetadata,
  workModeForTurnMetadata,
  DynamicContextLedger, turnLocalContextMessage, unverifiedInstructionsMessage,
  observeSystemPromptHash,
  type DynamicContext, type DynamicApproval, type MissingCapability,
  // Public extension seam — the SAME host contract runChat drives on the CLI
  ExtensionHost, composePrepareStep,
  UserSteerDrain, describeLandedSteers,
  type UserSteer, type SteerStatusEvent, type SteerStatusDetail,
  // Overflow recovery — the shared turn-failure policy (see turn-failure.ts)
  OVERFLOW_RETRY_EVENT, type OverflowRecoveryDecision,
  // Shared turn lifecycle (run bracket, prompt-token trigger, overflow apply)
  // plus the run_end vocabulary and the classifier that derives it from raw
  // facts, so neither backend chooses the string.
  openTurnRun, closeTurnRun, classifyRunEnd, persistMeasuredPromptTokens, applyOverflowRecovery,
  // backend-agnostic per-turn accounting + orchestration (shared by cf + cli)
  TurnAccumulator, AgentOrchestrator, type BackendHost,
  type SettledSignals, type InlineSteer,
  type AgentsToolAction,
  type AgentsToolDeps,
  type AgentsForkDeps,
  type BuiltinToolName,
  type TurnProvenance,
  type PromptModelContext,
  type WorkMode, isWorkMode,
  ACTIVE_TOOLS,
  nanoid,
  // Branching heads
  type HeadJournal, LiveHeadJournal,
  type HeadStreamFrame,
  type HeadId, type HeadInput, type HeadReport, type MergeStrategy,
  type SerializedMessage, type HeadRuntime, type HeadGrounding, type MergeResult,
  type NodeLoopHost, type NodeArbiter, type BranchProposal, type BranchDecision,
  type NodeWorkspaceProvisioner,
  // Canonical memory-note read (the dynamic-context MEMORY.md tail)
  readMemoryTail,
  // Durable run-event log
  type RunEventRecorder,
  // Cumulative, label-scoped spend governor (opt-in; no label = no cap)
  MissionGovernor, type MissionSeam, type MissionBudgetRefusal,
  // The one normalized provider usage report
  normalizeUsage, type Usage,
  // Non-turn model calls: the row type, its sink, and where a call with no run
  // open is filed. The other 25 producers of workspace spend arrive this way.
  WORKSPACE_RUN_ID, type ModelCallReport, type ModelOperationSink, type ModelOperationEvent,
  recordModelOperations,
  effectAlreadyDone, recordEffectDone,
  // The one builder for a model_call row: its shape AND the price-only-when-the
  // -rate-is-this-call's-own guard, which used to be spelled three times.
  buildModelCallEvent,
  // The ONE catalog pricing, so a model_call row prices exactly as the ledger
  // debits — and only when the rate belongs to the model that served it.
  priceCall,
  // agent_facts world model
  type FactsStore,
  // Per-turn device awareness (laptop runtime presence + change notice)
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
  renderSubordinateInheritedContext,
  type SubordinatesChangedEvent, type SubordinateReportStatus, type SubordinateReportOrigin,
  type SubordinateEventResult,
  // One minting rule for every subordinate, on either backend
  mintSubordinateName,
  // The subordinate tree's depth cap — derived per child, never stated by one
  DELEGATION_MAX_DEPTH,
  delegationExhausted, deriveChildDelegationBudget, type DelegationBudget,
  readSoul, bootstrapScaffold,
  // Automatic titling — one policy for every root that can be talked to
  applyWorkspaceTitle, suggestWorkspaceTitle,
  parseModelSpec, catalogModelInfo, countRequestInputTokens,
  // Model-capability attachment sanitization (the PDF-400 fix)
  type MediaModality,
  // Shared catalog view of the resolved model
  ModelCatalogSession,
  // Shared turn-context assembly — the SAME ordering runChat runs on the CLI
  assembleTurnMessages, measureCompactionTrigger,
  // The tool-call pairing invariant — applied wherever messages reach the model
  // WITHOUT going through assembleTurnMessages (the scaffold replay below).
  settleUnpairedToolCalls,
  // AGENTS.md (agents.md standard) — cloud workspace discovery, and the trust
  // authority that decides whether discovered bytes earn system placement.
  collectWorkspaceAgentsMd, type AgentsMdSources,
  InstructionApprovalStore, trustOfInstructionApprovals,
  type InstructionApproval, type InstructionTrustResolver,
  listInstructionApprovals, gatherApprovableInstructions, snapshotExistingInstructions,
  openInstructionSource, admitInstructionDecision,
  type InstructionSourceRow, type InstructionSourceView,
  stepContextLimit,
  mergeProviderOptions, reasoningEffortOptions,
  uiMessageText, tableExists, PROGRAMMATIC_MESSAGE_ID_PREFIX,
  TURN_AUTHOR_METADATA_KEY, stampTurnAuthor,
  // memory.* / tasks.* — codemode projections of the same-named native tools
  JsonObjectSchema, JsonValueSchema, TIER_IDS, projectJsonValue, changeActiveRole,
  agentsProfileContext, effectiveRoleCatalog, loadProfileAuthorityInputs,
  resolveAgentTurnProfile, resolveRoutingProfile,
  createMemoryCodemodeProvider, createTasksCodemodeProvider,
  resolveModelRoute, roleChangeOutcomeText, narrowToolSurface, codemodeCapabilitiesFor,
  beginModelOperation,
  // Plan mode's one completion surface and the deps-gated report tool. Both sat
  // outside BUILTIN_TOOLS as bare strings with no link to the tools they name.
  SUBMIT_PLAN_TOOL, REPORT_TOOL,
  type ActiveRoster, type JsonObject, type JsonValue, type ProfileAuthorityInputs,
  type ResolvedTurnProfile, type TierId, type SpendSource, type ModelCallSpend,
  type NimbusSandboxHandle,
} from "@kinu.run/core";
import {
  bindAgentSql, createCFRuntime,
  type CFRuntime, type HostedNodeHome,
} from "./runtime";
import { cleanupNimbusNodeHome, createNimbusNodeHomeProvisioner } from "./node-home";
import {
  recoveryBackoffMs,
  // The durable lanes' recovery roster — synchronous classification, six arms,
  // terminal-result discipline — and this backend's three cf-minted lane names.
  classifyRecoveredFiber, EVOLUTION_LANE_FIBER, ADVISOR_LANE_FIBER, MCP_WARM_LANE_FIBER,
  TERMINAL_LANE_FIBER,
  // What the chat roster knows about a turn this isolate is not running.
  openChatTurnResponses,
  // The recovery budget this backend DECLARES (handed to the SDK below), and
  // the budget-first pass that applies it before the framework allocates.
  sweepUnrecoverableFibers, fiberRowStore,
  FIBER_RECOVERY_MAX_AGE_MS,
  type FiberLaneTransports,
} from "./fiber-recovery";
import {
  // Core's once-only lifecycle for one settled response, and the per-effect
  // ledger it wraps. Both backends drive this same state machine.
  TerminalTransitions, initTerminalEffectTable,
  terminalEffect, overflowRetryTerminalEffect, keyedScope,
  RunEndReasonSchema, ModelMessagesSchema, WorkModeSchema, TurnContinuitySchema,
  CompletedTurnSchema, AdvisorRecoverySnapshotSchema,
  type TerminalTransition, type TerminalEffectFault, type TerminalEffectTable,
} from "@kinu.run/core";
import { createExecuteToolsTool } from "./execute-tools";
import { createHeadRuntime } from "./head-runtime";
import { spawnNodeFacet } from "./facet-spawn";
import type { AgentProviderRegistry } from "./providers/agent-registry";
import { OwnedModelServices } from "./owned-model-services";
import {
  // Prompt-cache breakpoints — single source in core prompting/cache-breakpoints.ts
  promptCachePlan, hasCacheMarkers, markLastToolForAnthropicCache,
  type PromptCacheStrategy,
} from "@kinu.run/core";
import type { CodemodeProvider, DeferredApprovalChannel } from "@kinu.run/core";
import { diagnostics, KinuError, toKinuError, tolerate } from "@kinu.run/core/obs";
import type { UserDO } from "./user/user-do";
import type { UserCaller } from "./user/workspace-capability";
import { sha256Hex } from "./lib/crypto";
import { installAnalyticsDiagnostics } from "./analytics/install";
import { openAnalyticsWindow } from "./analytics/writer";
import {
  recordModelRow, recordToolRow, recordTtftRow, recordTurnRow, type AgentKind,
} from "./analytics/record";
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

interface SettledTurnEvents {
  drainTurnId: string | undefined;
  programmaticUserMessage: UIMessage | null;
  errorText: string | undefined;
  completed: boolean;
  injectedSignals: SettledSignals;
}

interface AsyncTaskOwner {
  promise: Promise<void> | null;
}

interface UserHubCoreClient {
  readonly hasPeerGrant: UserDO['hasPeerGrant'];
  /** Whether the CLI bearer behind a live websocket on this workspace may
   *  still act — asked at frame time, so the answer comes from the object that
   *  owns revocation rather than from a verdict cached at the upgrade. */
  readonly verifyCliSocketBearer: UserDO['verifyCliSocketBearer'];
  /** Whether the browser session behind a live websocket on this workspace may
   *  still act — the same question for the other token kind, answered by the
   *  same authority for the same reason. */
  readonly verifySocketSession: UserDO['verifySocketSession'];
  /** The account's credential revision — the number a cached provider listing
   *  is compared against at use, so a missed fan-out heals instead of standing. */
  readonly getCredentialsRevision: UserDO['getCredentialsRevision'];
  readonly hasWorkspace: UserDO['hasWorkspace'];
  readonly listActiveWorkspaces: UserDO['listActiveWorkspaces'];
  readonly publishExperience: UserDO['publishExperience'];
  readonly searchExperience: UserDO['searchExperience'];
  readonly getExperienceEntry: UserDO['getExperienceEntry'];
  readonly getReleaseBoard: UserDO['getReleaseBoard'];
  readonly upsertReleaseSource: UserDO['upsertReleaseSource'];
  readonly createReleaseChange: UserDO['createReleaseChange'];
  readonly updateReleaseChange: UserDO['updateReleaseChange'];
  readonly transitionReleaseChange: UserDO['transitionReleaseChange'];
  readonly recordReleaseCheck: UserDO['recordReleaseCheck'];
  readonly requestReleaseApproval: UserDO['requestReleaseApproval'];
  readonly recordReleaseDeployment: UserDO['recordReleaseDeployment'];
  readonly getReleaseDetail: UserDO['getReleaseDetail'];
  readonly decideReleaseApproval: UserDO['decideReleaseApproval'];
  readonly getAuthHeaders: UserDO['getAuthHeaders'];
  readonly listCredentials: UserDO['listCredentials'];
  readonly getCredentialBaseURL: UserDO['getCredentialBaseURL'];
  readonly getWorkspaceTitle: UserDO['getWorkspaceTitle'];
  readonly setWorkspaceDisplayName: UserDO['setWorkspaceDisplayName'];
  readonly deviceRpc: UserDO['deviceRpc'];
  readonly getProfile: UserDO['getProfile'];
  readonly getWorkspaceProfileCatalog: UserDO['getWorkspaceProfileCatalog'];
  readonly getConfig: UserDO['getConfig'];
  readonly registerWorkspace: UserDO['registerWorkspace'];
  readonly reserveWorkspace: UserDO['reserveWorkspace'];
  readonly renewWorkspaceReservation: UserDO['renewWorkspaceReservation'];
  readonly releaseWorkspaceReservation: UserDO['releaseWorkspaceReservation'];
  readonly publishWorkspaceReservation: UserDO['publishWorkspaceReservation'];
  readonly ensureWorkspaceCapability: UserDO['ensureWorkspaceCapability'];
  readonly removeWorkspace: UserDO['removeWorkspace'];
}

export interface UserHubClient extends UserHubCoreClient {
  userMcp_toolDescriptors(caller: UserCaller): Promise<string>;
  /** Stop the FOREGROUND device work of one durable turn. Rows a background job
   *  now owns are excluded by the provider, so Stop never reaches work that
   *  outlived the turn on screen. */
  readonly cancelDeviceRequestsForTurn: UserDO['cancelDeviceRequestsForTurn'];
  /** Hand ONE live device request to the durable job that now owns it. Per
   *  request, because a turn can hold several parallel device calls and only the
   *  detaching one changes hands. */
  readonly transferDeviceRequestToBackgroundJob: UserDO['transferDeviceRequestToBackgroundJob'];
  readonly cancelDeviceRequestsForBackgroundJob: UserDO['cancelDeviceRequestsForBackgroundJob'];

  /** Establish this user's MCP connections. The ONE establishment authority
   *  (UserDO.hydrateUserMcp behind it), shared with the HTTP first-hit warmup —
   *  the turn's settle calls the same method rather than a second one. */
  userMcp_warmConnections(caller: UserCaller): Promise<{ servers: number }>;

  userMcp_callTool(
    caller: UserCaller,
    serverId: string,
    name: string,
    args: JsonObject,
  ): Promise<string>;
}

type UserHubRpcClient = UserHubClient & Pick<Fetcher, 'fetch'>;
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
const CLI_AUTHORITY_REVOKED = 'This CLI authorization is no longer valid. Sign in again with: kinu auth';
const SESSION_AUTHORITY_REVOKED = 'This session has been signed out. Sign in again.';


function jsonObject<Input>(input: Input): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, input);
  return parsed.success ? parsed.output : {};
}

async function* projectDefaultInference<Chunk>(stream: AsyncIterable<Chunk>) {
  for await (const chunk of stream) yield { value: projectJsonValue({ value: chunk }) };
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
 * `convertToModelMessages` is an AWAIT, and on the live path it used to run
 * between the answer Think had already persisted and the claim that makes that
 * answer's effects recoverable — so an eviction inside it left a durable answer
 * with no incomplete transition, and `resumeAll()` found nothing to replay. The
 * row carries the message instead and the conversion happens inside the effect,
 * where the claim already exists.
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

/** Extract plain text from the last user message in a ModelMessage[]. Used
 *  by skills resolution to look for `/skill-name` invocations and keyword
 *  matches without needing to know the AI SDK content-part union shape.
 *  Deliberately text-only: file/image attachment parts are dropped here, but
 *  they still reach the model — the evolved-scaffold path hands this flattened
 *  text to the scaffold as `task` while `host.defaultInference()` streams the
 *  prepared turn with all parts intact (see _transformInferenceResult). */
export function extractLastUserText(messages: ReadonlyArray<ModelMessage>): string {
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
  const parsed = v.safeParse(v.picklist(TIER_IDS), body?.tier);
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
   *  AgentsToolDeps.peers in core tools/agents-tool.ts). */
  peers?: PeersToolDeps;
  /** Subordinate → parent progress spine — subordinate-only. */
  report?: ReportToolDeps;
  releases?: ReleaseToolDeps | undefined;
  /** Owner-chat plan review submitter. Present structurally on actors whose
   * current turn belongs to the owner, then surfaced only in Plan mode. */
  submitPlan?: SubmitPlanToolDeps;
}

/** ACTIVE_TOOLS filtered to what this actor's deps actually wire — the prompt
 *  and the activeTools whitelist must not advertise structurally absent tools.
 *
 *  WHICH names are deps-gated is core's `DEPS_GATED_TOOLS`, and each is spelled
 *  by its registry constant. This file used to declare the set itself, as a bare
 *  `['report']` with no link to the tool it named, so renaming the builtin left
 *  a gate matching nothing. The `agents` tool is never dropped on cf — every
 *  actor has the fork substrate — but its ACTIONS gate on the same profile (see
 *  actorAgentsActions). `release` is not a native tool anymore (release.* is
 *  codemode-only), so `deps.releases` gates nothing here; it feeds that codemode
 *  namespace directly.
 *
 *  That every gated name is answered here is asserted by test, not by the
 *  compiler: core declares the set as `readonly BuiltinToolName[]`, which is the
 *  right type for a shared list and cannot key an exhaustive table. */
export function actorActiveTools(deps: ActorToolDeps): BuiltinToolName[] {
  const gate = {
    [REPORT_TOOL]: !!deps.report,
  } satisfies Partial<Record<BuiltinToolName, boolean>>;
  return ACTIVE_TOOLS.filter((name) => gate[name] ?? true);
}

/** The `agents` actions this actor profile supports, for the prompt's
 *  Delegation ladder — the same gating rule the tool's enum uses. Fork is
 *  universal on cf (every ActorAgent owns the strategy registry + facet
 *  substrate); hiring and peer converse ride the actor profile. */
export function actorAgentsActions(deps: ActorToolDeps): AgentsToolAction[] {
  return agentsActionsFor({ fork: {}, team: deps.team, peers: deps.peers });
}

/** The codemode tool whose script keeps issuing device execs for as long as it
 *  runs — including after its own call has detached. Named against the builtin
 *  union rather than written as a bare string, so a rename breaks the build
 *  instead of leaving this silently matching nothing. */
const EXECUTE_TOOLS_TOOL = 'execute_tools' satisfies BuiltinToolName;

/** The schedule callback that finishes what a dead activation's terminal
 *  sequence still owed. Public on the actor because `Agent.schedule()` types its
 *  callback as `keyof this`, which excludes protected members. */
export const TERMINAL_RETRY_CALLBACK = '_kinuTerminalRetryTick';


/** Where a turn records that its advisor lane was ACCEPTED — started and
 *  checkpointed, so recovery owns it. Not that the review finished: what must
 *  not happen twice is the lane being opened, and the fiber's own row is what
 *  carries it from there. */
const ADVISOR_LANE_SCOPE = 'advisor_lane';



export interface ActorDynamicContextExtras {
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
  readonly extraMissingCapabilities?: () => readonly MissingCapability[];
}

interface WorkspaceTitleInputs {
  readonly displayName: string | null;
  readonly nameOrigin: 'user' | 'auto' | null;
}



/**
 * Where `steerTurn` put the operator's words. Unlike the drain's own
 * {@link UserSteerDrain.accept} outcome, this never says `idle`: an idle actor
 * queues the text as the next ordinary turn itself, so every answer names a
 * place the words now are, never work the caller still owes.
 */
export type SteerTurnLanding = 'mid-turn' | 'queued';


/**
 * The durable shell a node home is provisioned and reclaimed through.
 *
 * A shell of its own, not the actor's: provisioning runs `mkdir`/`chown`/`chmod`
 * as uid 0 from `/`, and doing that in the actor's own shell would move the
 * agent's working directory out from under its next command.
 */
const NODE_HOME_SHELL_ID = 'hosted-node-home';

export abstract class ActorAgent extends Think<Env> {
  // ── The actor profile — what a concrete actor class supplies ─────────
  // The rest of this class is actor-agnostic; these members are the whole
  // difference between actor kinds (orchestrator vs a future facet actor).

  /** Owner userId, or null while unclaimed — the actor's identity bootstrap.
   *  The orchestrator reads workspace_identity; a facet actor reads the
   *  owner row its parent seeded. */
  protected abstract getOwnerUserId(): string | null;

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
   *  Stored in its own table rather than agent_config: it is identity, not
   *  configuration, and must not be reachable through any config or snapshot
   *  surface. There is deliberately no RPC that reads it back out — the token
   *  only ever travels parent -> facet, so nothing name-addressable can be
   *  asked for another workspace's secret. */
  protected async workspaceCapabilityToken(): Promise<string | null> {
    // A plain read. It used to create the table it selects from and swallow
    // every failure as `null`, which is what made a missing `workspace_capability`
    // read as "this workspace holds no token" — indistinguishable from the truth,
    // and the reason nobody noticed the table had no owner. The constructor owns
    // it now (`initCapabilitySchema`), so a failure here is a real failure.
    const rows = this.sql<{ token: string }>`SELECT token FROM workspace_capability LIMIT 1`;
    return rows[0]?.token || null;
  }

  /** The hash of the token this workspace holds, or null when it holds none.
   *  Safe to hand out — it is what lets the owner's UserDO detect that the two
   *  sides disagree without either of them exchanging the secret. */
  protected async workspaceCapabilityHash(): Promise<string | null> {
    const token = await this.workspaceCapabilityToken();
    return token ? sha256Hex(token) : null;
  }

  /** Install the capability token the owner's UserDO minted for this
   *  workspace. Worker-side DO RPC only — deliberately not `@callable`.
   *
   *  `missed` counts the subtree pushes that failed. A suppressed push is no
   *  longer the end of the story: the caller reports it to the UserDO, which
   *  arms a reconciliation intent, because the child it stranded keeps
   *  presenting the now-unrecognized token until something retries — and
   *  nothing else ever did. */
  async installWorkspaceCapability(token: string): Promise<{ ok: true; missed: number }> {
    if (!token) throw new Error('capability token required');
    // A native DO RPC does not route through partyserver, so it can land before
    // `onStart` has run — the same race `OrchestratorAgent.claimOwner` handles
    // this way. Flag-gated, so it is a no-op once the activation is initialized.
    this.ensureSchema();
    void this.sql`INSERT INTO workspace_capability (id, token) VALUES (1, ${token})
             ON CONFLICT(id) DO UPDATE SET token = excluded.token`;
    this.invalidateModelCaches();
    // …then push it down this actor's own subtree. Facets present the PARENT
    // workspace's identity, so the token travels down rather than being read
    // back out of a DO — nothing name-addressable ever hands the secret to a
    // caller. Recursive by construction: each hire re-enters here for its own
    // hires, so a reissued token reaches the whole tree, not just its first row.
    let missed = 0;
    const facet = this.subordinateFacet();
    for (const entry of this.subordinateRoster.list()) {
      try {
        const stub = await this.subAgent(facet, entry.name);
        await stub.installWorkspaceCapability(token);
      } catch (err) {
        missed += 1;
        diagnostics.failure('capability.subordinate_push_failed', toKinuError({
          doing: 'pushing the workspace capability token to a subordinate',
          cause: err,
          otherwise: 'unavailable',
        }), { subordinate: entry.name });
      }
    }
    // Exploration facets read the token at SPAWN time, so a reissued token
    // reaches future spawns for free — but a LONG-RUNNING head or node would
    // otherwise keep presenting the revoked one until it finished. Push it
    // down over the SDK's own facet registry; same secret, no second copy.
    const ownerUserId = this.getOwnerUserId();
    if (ownerUserId !== null) {
      for (const entry of this.listSubAgents(this.explorationFacet())) {
        try {
          const stub = await this.subAgent(this.explorationFacet(), entry.name);
          await stub.setOwner(ownerUserId, token);
        } catch (err) {
          missed += 1;
          diagnostics.failure('capability.exploration_push_failed', toKinuError({
            doing: 'pushing the workspace capability token to an exploration facet',
            cause: err,
            otherwise: 'unavailable',
          }), { facet: entry.name });
        }
      }
    }
    return { ok: true, missed };
  }

  /** Re-run the subtree push with the token this root already holds. The
   *  recovery half of the reconciliation intent: only the root stores the
   *  plaintext, so a retry that missed a replica has to be asked of the root.
   *  Idempotent by construction — the push is the same one `installWorkspaceCapability`
   *  runs, and the token is the same one the registry already committed. */
  async repushWorkspaceCapability(): Promise<{ missed: number }> {
    const token = await this.workspaceCapabilityToken();
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
   *  It earns that placement the hard way: it used to be created lazily by
   *  `workspaceCapabilityToken()`, i.e. by a READ performing DDL, and its only
   *  reliable creator turned out to be `onStart`'s scaffold probe failing on its
   *  way into the workspace filesystem. A table that exists because an unrelated
   *  call threw is a table with no owner.
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
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pending_steers (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      id      TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      mode    TEXT NOT NULL CHECK (mode IN ('plan','build')),
      text    TEXT NOT NULL
    )`);
    // This survives the reset window between an in-flight turn's eviction and
    // its fiber recovery. Stop must still identify that turn's device work.
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS active_durable_turn (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      turn_id TEXT NOT NULL
    )`);
    // Here for the same reason as the row above it, and one more: the recovery
    // sweep reads it from `onStart`, which is not guaranteed to follow a root's
    // `ensureSchema`. Idempotent DDL, so a re-activation costs nothing.
    initTerminalEffectTable(this.boundSql, (ddl: string) => this.ctx.storage.sql.exec(ddl));
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

  private _planReviews: PlanReviewStore | null = null;

  /** One SQL-backed review stream, local to this actor's durable storage. */
  protected get planReviews(): PlanReviewStore {
    if (!this._planReviews) this._planReviews = new PlanReviewStore(this.boundSql);
    return this._planReviews;
  }

  protected submitPlanEdits(edits: readonly PlanEdit[]): PlanReviewResult {
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

  /** The facet class a hire runs as. Supplied by each concrete root because the
   *  base class must not import its own subclass — the TYPE is imported (and
   *  erased), the VALUE comes from here. */
  protected abstract subordinateFacet(): SubAgentClass<SubordinateAgent>;

  /** Exploration facets (heads, branches, swarm nodes) of this actor. The VALUE
   *  lives here rather than in facet-spawn.ts so that helper carries no runtime
   *  import of the class it spawns — that import closed a cycle through
   *  runtime.ts and head-runtime.ts. */
  explorationFacet(): SubAgentClass<ExplorationAgent> { return ExplorationAgent; }

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
      this._subordinateRoster = new SubordinateRosterStore(this.ctx.storage.sql, this.boundSql);
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
      const snapshot = await (await this.subAgent(this.subordinateFacet(), name)).getSubordinateSnapshot();
      const role = snapshot.role.kind === 'catalog' ? snapshot.role.roleId : snapshot.role.text;
      return { ...entry, displayName: snapshot.displayName, role };
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

  /** A facet is reachable only while its own roster still lists it. */
  override async onBeforeSubAgent(
    request: Request,
    child: { className: string; name: string },
  ): Promise<Request | Response | void> {
    if (child.className !== this.subordinateFacet().name) {
      return new Response('Not found', { status: 404 });
    }
    const rosterEntry = this.subordinateRoster.get(child.name);
    if (!rosterEntry || rosterEntry.status === 'dismissed'
      || !this.hasSubAgent(child.className, child.name)) {
      return new Response('Not found', { status: 404 });
    }
    return request;
  }

  private _subordinateRuntime: SubordinateRuntime | null = null;

  /**
   * THE child substrate of this actor: how a subordinate is born, addressed and
   * retired on this platform.
   *
   * One object, memoized, because two rungs ride it — the durable roster and the
   * temporary register — and a second copy would be a second `subAgent` path to
   * the same facets.
   */
  protected subordinateRuntime(): SubordinateRuntime {
    if (this._subordinateRuntime) return this._subordinateRuntime;
    const facet = this.subordinateFacet();
    this._subordinateRuntime = {
      spawn: async (input) => {
        const ownerUserId = this.getOwnerUserId();
        if (!ownerUserId) throw new Error('Agent has no owner yet — subordinate creation needs an owned workspace.');
        const stub = await this.subAgent(facet, input.name);
        const capabilityToken = await this.workspaceCapabilityToken();
        try {
          const identity = {
            name: input.name,
            displayName: input.displayName,
            nameOrigin: input.nameOrigin,
            role: input.role,
            mission: input.mission,
            tier: input.tier,
            // The child's own copy of the fact its terminal-report policy turns
            // on, pushed at seed time because only the child sees its turn end.
            lifetime: input.lifetime,
            capabilityToken: capabilityToken ?? undefined,
          };
          await stub.setSubordinateIdentity(identity);
        } catch (error) {
          // A cleanup path that discards its own failure cannot be trusted to
          // have cleaned up. `deleteSubAgent` is what WIPES the half-seeded
          // facet's storage, so a swallowed failure here leaves a permanent
          // database inside this DO charged against the quota every facet
          // shares — reported with the seeding failure as its cause, never
          // hidden behind it.
          try {
            await this.deleteSubAgent(facet, input.name);
          } catch (cleanupError) {
            throw new Error(
              `Subordinate ${input.name} failed to seed and its storage could not be reclaimed: `
              + `${renderThrownChain({ cause: cleanupError })}`,
              { cause: error },
            );
          }
          throw error;
        }
      },
      assign: async (name, input) => {
        const stub = await this.subAgent(facet, name);
        const task = {
          kind: 'task',
          body: input.body,
          mode: input.mode,
          deliverable: input.deliverable,
          deadlineHint: input.deadlineHint,
          inheritedContext: input.inheritedContext,
        } as const;
        return stub.enqueueSubordinateTask(task);
      },
      status: async (name) => (await this.subAgent(facet, name)).getSubordinateStatus(),
      message: async (name, content, mode) => {
        return (await this.subAgent(facet, name))
          .enqueueSubordinateTask({ kind: 'message', body: content, mode });
      },
      rename: async (name, displayName, nameOrigin) => {
        await (await this.subAgent(facet, name)).setSubordinateNaming(displayName, nameOrigin);
      },
      dismiss: async (name, keepHistory) => {
        if (!keepHistory) await this.deleteSubAgent(facet, name);
      },
    };
    return this._subordinateRuntime;
  }

  private _temporaryAgentPort: TemporaryAgentPort | null = null;

  /**
   * The temporary rung's port, built ONCE per actor.
   *
   * The lifetime is the point: `run` parks a waiter here and the report ingress
   * resolves it, and those are two different calls on the same isolate. A port
   * rebuilt per call would hand the ingress an empty waiter map and leave every
   * ask hanging on an answer that had already arrived.
   */
  protected temporaryAgentPort(): TemporaryAgentPort {
    this._temporaryAgentPort ??= createTemporaryAgentPort({
      roster: this.subordinateRoster,
      runtime: this.subordinateRuntime(),
      now: () => Date.now(),
      renderInheritedContext: () => renderSubordinateInheritedContext(this.readInheritedContext()),
      createName: mintSubordinateName,
      // Existence only. The temporary rung's whole point is that the material
      // reaches the CHILD's window and not this one, so this side authorizes the
      // path through the workspace VFS and never reads the bytes.
      statRef: async (path) => (await this.rt.storage.vfs.stat(path)) !== null,
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

  /** This actor's role as ONE label: the catalog id of a catalog hire, or the
   *  freeform line a pre-catalog hire carries — core's one `role_selection`
   *  row, read through getRoleSelection(). Surfaces that key into the catalog
   *  match only the catalog arm; a legacy line matches nothing, exactly as an
   *  unknown id did. */
  protected activeRoleLabel(): string {
    const selection = this.config.getRoleSelection();
    // A legacy line is prompt prose, not a catalog key. Its tool/tier policy
    // is the general role until the owner assigns a catalog role.
    return selection.kind === 'catalog' ? selection.roleId : 'general';
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
  async getSubordinateBootstrapIdentity(): Promise<{
    parentWorkspace: string;
    ownerUserId: string;
    model: string | null;
    depth: number;
  }> {
    // Deliberately carries no capability token: this method is reachable by any
    // holder of a stub to this workspace, so it must never hand out a secret.
    // The token reaches subordinates by push (setSubordinateIdentity +
    // installWorkspaceCapability), never by read-back.
    this.ensureSchema();
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) throw new Error('Workspace must be owned before creating subordinates.');
    const own = this.delegationBudget();
    if (delegationExhausted(own)) {
      throw new Error(
        `Delegation depth cap reached: this agent is at depth ${own.depth} of ${DELEGATION_MAX_DEPTH} `
        + 'and cannot seed a subordinate below it.',
      );
    }
    return {
      parentWorkspace: this.workspaceName(),
      ownerUserId,
      model: this.config.getModel(),
      depth: deriveChildDelegationBudget(own).depth,
    };
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


  private readonly ownedModelServices = new OwnedModelServices({
    env: this.env,
    agentName: () => this.name,
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
    // Scoped `pta_…` access tokens reach this DO over ticket-authenticated
    // websockets, and the REST scope gate never sees websocket frames — so
    // out-of-scope @callable requests are rejected here, ahead of the
    // agents-SDK rpc dispatcher (installed as an own-property onMessage
    // wrapper by the Agent constructor, hence the re-wrap instead of an
    // onMessage override). Chat frames pass through untouched.
    //
    // WHETHER the connection's authority may still act is asked FIRST — its
    // CLI bearer, or the browser session behind its cookie — because the scope
    // gate answers a different question: it pins a connection to what its token
    // was granted, and says nothing about whether that token still exists. The
    // upgrade verifies each once, so without the check below a revoked CLI token
    // or a logged-out cookie kept this workspace's whole surface for as long as
    // it held the socket — across every await, and across hibernation, which
    // restored the connection from its tags with its scopes intact.
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
      try {
        return await dispatchMessage.call(this, connection, message);
      } finally {
        if (event?.type === 'clear') {
          this.dynamicLedger.reset();
          this._pendingDrainReplyTurns.clear();
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
      }
    };
    // Constructor body (not a field initializer): boundSql's memo field must
    // be initialized before the getter caches its closure.
    this.compactionState = createCompactionStateStore(this.boundSql);
    this.registerCompactionExtension();
    // The user steer-drain registers BEFORE the orchestrator's signal
    // extension: a signal splice must never shift the indices the user-steer
    // drain replays into durable history (the same ordering the CLI's
    // ExtensionHost uses).
    this.extensions.register({
      name: 'kinu.user-steer',
      prepareStep: (ctx) => this.userSteer.prepareStep(ctx),
    });
    // The orchestrator's per-turn extension: the turn steering's observation
    // hooks plus the ONE mid-turn signal drain every producer feeds. Forwarded
    // through closures because `orch` is built lazily and this runs in the
    // constructor.
    this.extensions.register({
      name: 'kinu.signals',
      onToolCall: (ctx) => this.orch.turnExtension.onToolCall?.(ctx),
      onToolResult: (ctx) => this.orch.turnExtension.onToolResult?.(ctx),
      prepareStep: (ctx) => this.orch.turnExtension.prepareStep?.(ctx),
    });
  }

  /** The settled turn's actor-generic front half — every actor's
   *  onChatResponse calls this FIRST (before anything that can throw or
   *  return early). Resolves the drain identity, clears in-flight turn
   *  state, and settles mid-turn signal delivery: absorbed signals keep their
   *  reply dispatch with this turn's answer, and whatever the model never saw
   *  re-delivers through the same seam (which queues it, since the turn is
   *  over) — so the event card and reply dispatch work unchanged. */
  protected settleTurnEvents(result: ChatResponseResult): SettledTurnEvents {
    // Three sources, in order of how close each is to the turn that ran:
    // the in-memory stash of a turn this activation itself enqueued, the
    // re-delivery map of a batch whose replies were still pending, and — for a
    // turn that arrived through DURABLE ADMISSION — the `drainTurnId` the
    // enqueue seam stamped on the message itself. The third is what makes an
    // admitted-then-evicted drain answerable at all: the activation that runs it
    // is not the one that submitted it, so it holds no stash, and without this
    // its batch's replies were never dispatched and its lease never closed.
    const drainTurnId = this._activeDrainTurnId
      ?? this._pendingDrainReplyTurns.get(result.requestId)
      ?? this.turnDrainTurnId();
    const programmaticUserMessage = this._activeProgrammaticUserMessage;
    this._activeDrainTurnId = null;
    this._activeProgrammaticUserMessage = null;
    // Persist the provider error TEXT, not just the status — Think keeps only
    // the LAST terminal error, which the next failure overwrites, so this row
    // (and the run_end event in recordTurnTelemetry) is the durable evidence
    // trail.
    const errorText = result.error?.slice(0, 500);
    this.logActivity("response_complete", errorText ? `${result.status} — ${errorText}` : result.status);
    // Clear the in-flight flag once the turn is durably completed — forkAgent
    // is allowed again from here forward. Evolution (the orchestrator's detached engine.reviewTurn)
    // runs fire-and-forget and does NOT extend the busy window.
    this._inFlight = false;
    this._cliCwd = null;
    const activeTurnId = this._turnCheckpoint?.turnId;
    if (activeTurnId) {
      this.ctx.storage.sql.exec('DELETE FROM active_durable_turn WHERE turn_id = ?', activeTurnId);
    }
    // Order matters: the flag is already clear, so the leftover steer enqueues
    // as a turn of its own instead of buffering for a turn that is over.
    this.rerunLeftoverSteers();
    const completed = result.status === 'completed';
    const injectedSignals = this.orch.signals.settle({ completed });
    return { drainTurnId, programmaticUserMessage, errorText, completed, injectedSignals };
  }

  /**
   * Accept a message the user typed while a turn is running — or, when the turn
   * ended before it arrived, commit it as the NEXT ordinary user turn right
   * here. The decision and its commitment share one synchronous slice of this
   * actor: `accept` reads the in-flight flag in this tick, and the idle branch
   * hands the text to the turn queue before any other input runs. The caller
   * never re-sends, so the race where mid-turn guidance became an ordinary
   * turn at some later, unpredictable point is structurally gone (KINU-N026).
   *
   * `'mid-turn'` is announced immediately, before the model has it: the person
   * who pressed Enter needs to know their words were taken and are waiting for
   * the next step, which is a different fact from "the model read them"
   * (announced again, as `landed`, when the drain actually happens). The id is
   * minted HERE and carried through both announcements and the durable row, so
   * a surface tracking a steer never sees the same one twice under two names.
   *
   * `mode` rides the enqueued turn as its `kinuMode`, so a Plan composer's
   * fallback turn keeps the Plan bar the ordinary send path would have given it.
   */
  protected async acceptUserSteer(text: string, mode: WorkMode): Promise<SteerTurnLanding> {
    const body = text.trim();
    if (!body) throw new Error('steerTurn requires the message text');
    const id = `steer-${nanoid(12)}`;
    // The decision and durable reservation are one synchronous actor slice.
    // A mid-turn steer exists in SQL before the client hears it queued, so an
    // eviction cannot turn an acknowledged chip into forgotten RAM.
    if (this._inFlight) {
      const turnId = this.durableTurnId();
      if (turnId === null) throw new Error('running turn has no durable identity');
      void this.sql`INSERT INTO pending_steers (id, turn_id, mode, text)
        VALUES (${id}, ${turnId}, ${mode}, ${body})`;
      const outcome = this.userSteer.accept({ id, text: body });
      if (outcome !== 'mid-turn') throw new Error('turn changed while accepting a steer');
      this.broadcastSteerStatus({ status: 'queued', steerId: id, text: body });
      this.logActivity('steer_queued', body.slice(0, 120));
      return 'mid-turn';
    }
    // The operator's own words, exactly as the ordinary send path would have
    // written them — author-stamped so the row wears the user bubble, never
    // filed as the harness speaking (the rerunLeftoverSteers precedent).
    const queued = await this.host.enqueueTurn({
      text: body,
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: mode },
    });
    if (queued.status !== 'queued') {
      throw new Error('the turn had already finished and this could not be queued as a new message — send it again');
    }
    return 'queued';
  }

  /**
   * A drain happened: the model has these steers as of the step now starting.
   *
   * Each becomes a VERBATIM user row in the session tree — `addMessages`
   * appends without enqueuing a turn and is explicitly safe from inside a live
   * one, and the row parents off the current leaf (the message that started
   * this turn), so the assistant answer chains after it. That chain is what
   * makes the walk-back fork able to cut at a steer, exactly as it can on the
   * CLI (local-session persist()).
   *
   * The row keeps the steer's own id, so the live chip and the durable message
   * are the same thing to the chat pane and it renders one, never both.
   *
   * It also keeps `atStep`. A turn is ONE assistant message — Think persists it
   * once, after the stream drains — so a row appended beside it sorts before or
   * after the whole turn and nowhere else. The step index is the only durable
   * statement of where inside the turn the model actually read this, and both
   * the live splice and the reloaded transcript place the bubble from it.
   */
  private async recordLandedSteers(steers: readonly UserSteer[], atStep: number): Promise<void> {
    // Core builds the rows: it assigns the fallback id and stamps BOTH metadata
    // keys together — a row carrying the steer key without the step key is
    // indistinguishable from an ordinary user turn at rest. What stays here is
    // transport: Durable Object messages and this class's broadcast channel.
    const rows = describeLandedSteers(steers, atStep);
    await this.addMessages(rows.map((row) => ({
      id: row.id,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: row.text }],
      metadata: row.metadata,
    })));
    for (const row of rows) {
      void this.sql`DELETE FROM pending_steers WHERE id = ${row.id}`;
      this.broadcastSteerStatus({ status: 'landed', steerId: row.id, text: row.text, atStep: row.atStep });
    }
  }

  /**
   * Drop the in-flight turn's pending steers and hand their texts back — the
   * abort path's half of the steer contract (core cancelCurrentWork calls this
   * through `interruptSteers`). Stop means stop; it does not mean "stop and
   * then do what I typed". But the surface already rendered them as sent, so
   * they come back to the composer rather than disappearing.
   */
  protected async interruptUserSteers(): Promise<string[]> {
    await this.userSteer.waitForLanding();
    const dropped = this.userSteer.interrupt();
    try {
      for (const steer of dropped) {
        if (steer.id) this.ctx.storage.sql.exec('DELETE FROM pending_steers WHERE id = ?', steer.id);
      }
    } catch (err) {
      // The SQL row is still authority. Put the exact prefix back in RAM before
      // surfacing failure, so a second Stop in this activation sees what SQL says
      // is queued; never emit returned for a transition that did not commit.
      this.userSteer.restoreInterrupted(dropped);
      throw err;
    }
    for (const steer of dropped) {
      if (steer.id) this.broadcastSteerStatus({ status: 'returned', steerId: steer.id, text: steer.text });
    }
    return dropped.map((steer) => steer.text);
  }

  /** The one place a steer's lifecycle reaches connected surfaces. Written as a
   *  literal so the broadcast-wiring gate can see the channel it must prove has
   *  a consumer. */
  /** The reconnect snapshot reads SQL, not the RAM drain: RAM vanishes on an
   *  eviction while these rows are the acknowledged steers still awaiting a
   *  step boundary. */
  protected pendingSteerRuns(): InlineSteer[] {
    return this.sql<{ id: string; text: string }>`
      SELECT id, text FROM pending_steers ORDER BY seq ASC`
      .map((row) => ({ ...row, state: 'queued' as const, atStep: null }));
  }

  private broadcastSteerStatus(detail: SteerStatusDetail): void {
    this.broadcast(JSON.stringify({ type: 'steer_status', ...detail } satisfies SteerStatusEvent));
  }

  /**
   * Steers that never saw a step boundary (the model was already writing its
   * final answer) rerun as a USER-origin turn. It carries the operator's own
   * words, so it says so: without the stamp the enqueue seam would read a row
   * with no author and the programmatic id prefix it gives every row, and file
   * the operator's sentence as the harness's. Detached: a turn must never block
   * on the next one's queue slot.
   */
  private readonly _rerunningSteerKeys = new Set<string>();
  private _rerunningSteerTask: AsyncTaskOwner | null = null;
  private _rerunningSteerPending = false;

  private rerunLeftoverSteers(): void {
    this._rerunningSteerPending = true;
    if (this._rerunningSteerTask !== null) return;
    const owner: AsyncTaskOwner = { promise: null };
    this._rerunningSteerTask = owner;
    owner.promise = (async () => {
      let steers = 0;
      try {
        await this.runFiber(TERMINAL_LANE_FIBER, async (ctx) => {
          ctx.stash({ lane: TERMINAL_LANE_FIBER });
          while (this._rerunningSteerPending) {
            this._rerunningSteerPending = false;
            // Terminal leftovers come from SQL, not the RAM drain: a reset has
            // already lost RAM, while these rows are the operator words we
            // acknowledged. Keep seq order and mode boundaries; merging a Plan
            // steer with Build would run it on the wrong tool surface.
            const rows = this.sql<{ id: string; turn_id: string; mode: WorkMode; text: string }>`
              SELECT id, turn_id, mode, text FROM pending_steers ORDER BY seq ASC`;
            steers = rows.length;
            let index = 0;
            while (index < rows.length) {
              const first = rows[index]!;
              const group = [first];
              index++;
              while (index < rows.length && rows[index]!.mode === first.mode && rows[index]!.turn_id === first.turn_id) group.push(rows[index++]!);
              const idempotencyKey = `steer-rerun:${first.turn_id}:${first.mode}:${first.id}`;
              // A duplicate terminal callback can arrive before the first admission
              // resolves. RAM closes that window; the durable idempotency key closes
              // the same window across an activation reset.
              if (this._rerunningSteerKeys.has(idempotencyKey)) continue;
              this._rerunningSteerKeys.add(idempotencyKey);
              try {
                const queued = await this.host.enqueueTurn({
                  text: group.map((row) => row.text).join('\n\n'),
                  metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: first.mode },
                  idempotencyKey,
                });
                const duplicateAdmission = queued.durable?.accepted === false
                  && (queued.durable.status === 'pending' || queued.durable.status === 'running'
                    || queued.durable.status === 'completed');
                if (queued.status !== 'queued' && !duplicateAdmission) continue;
                for (const row of group) this.ctx.storage.sql.exec('DELETE FROM pending_steers WHERE id = ?', row.id);
              } finally {
                this._rerunningSteerKeys.delete(idempotencyKey);
              }
            }
          }
        });
      } catch (cause) {
        diagnostics.failure('steer.rerun_failed', toKinuError({
          doing: 'enqueuing terminal leftover steers', cause, otherwise: 'io',
        }), { steers });
      } finally {
        if (this._rerunningSteerTask === owner) {
          this._rerunningSteerTask = null;
          if (this._rerunningSteerPending) this.rerunLeftoverSteers();
        }
      }
    })();
  }

  /** The settled turn's telemetry — the measured compaction trigger, the
   *  shared overflow-recovery policy, and the durable turn_end/run_end
   *  events. Runs for completed AND aborted/errored turns. */
  protected recordTurnTelemetry(result: ChatResponseResult, turn: {
    errorText: string | undefined;
    completed: boolean;
    programmaticUserMessage: UIMessage | null;
  }): OverflowRecoveryDecision | null {
    const { errorText, completed, programmaticUserMessage } = turn;
    let overflowRecovery: OverflowRecoveryDecision | null = null;
    // The NEXT turn's measured compaction trigger (core turn-lifecycle).
    persistMeasuredPromptTokens(this.compactionState, this.name, this.acc.lastPromptTokens, this._turnDurableLength);
    // Overflow planning and compaction arming are synchronous. If this turn
    // earned a retry, the caller records it as `overflow_retry` in the terminal
    // roster before any asynchronous effect runs.
    if (!completed && result.error) {
      overflowRecovery = applyOverflowRecovery({
        error: result.error,
        lastPromptTokens: this.acc.lastPromptTokens,
        contextWindow: this._turnContextWindow > 0 ? this._turnContextWindow : this.sessionContextWindow(),
        turnWasOverflowRetry: this.turnUserMessageEvent(programmaticUserMessage) === OVERFLOW_RETRY_EVENT,
        state: this.compactionState,
        sessionKey: this.name,
      });
      if (overflowRecovery.forceCompaction) {
        this.logActivity('overflow_detected',
          `${overflowRecovery.failureClass} — force compaction armed${overflowRecovery.enqueueRetry ? ', retry owed' : ''}`);
      }
    }
    // Seal the durable run: turn_end + run_end (core turn-lifecycle).
    //
    // `reason` used to be Think's `result.status` passed straight through, and
    // `reason` was typed as a bare string, so the two backends spelled the same
    // user action differently: a Stop sealed 'aborted' here and 'error' on the
    // CLI, and every cross-backend reader of run ledgers counted local stops as
    // failures. The vocabulary is core's now and the classifier takes RAW FACTS,
    // so neither backend picks a string. It returns the error text too: a run
    // sealed 'aborted' must not still carry an interruption sentence in `error`,
    // which is the same drift wearing a new label.
    //
    // `lastFinishReason` is the fourth fact, and it is the one this backend was
    // missing entirely: Think reports status 'completed' for a turn its own stop
    // condition cut, so `completed` alone cannot tell a finished turn from a
    // truncated one. The model's last word can.
    const end = classifyRunEnd({
      completed,
      interrupted: result.status === 'aborted',
      errorText,
      lastFinishReason: this.acc.lastFinishReason,
    });
    if (this._currentRunId) {
      closeTurnRun(this.eventRecorder, this._currentRunId, {
        turnIndex: this.orch.sessionTurnIndex,
        usage: this.acc.usage,
        context: this.acc.context,
        files: this.acc.files,
        escalations: this.acc.escalations,
        delegation: this.orch.steering.delegationSnapshot(),
        steering: this.orch.steering.snapshot(),
        craft: this.orch.craft.snapshot(),
        recoveries: this.orch.recoverySnapshot(),
        workMode: this.turnWorkMode(),
        ...end,
      });
    }
    // The effect claims are NOT released here, and the ordering is the whole
    // point. This method runs at the TOP of every actor's onChatResponse, and
    // everything with a downstream effect runs after it: the reply a drained
    // email batch owes, the takes claim, the extension turn-end, the evolution
    // lanes. Releasing the claims here dropped the once-only ledger before the
    // effects it exists to protect had happened, so an interruption anywhere in
    // that sequence left a prefix nobody could tell from a completed turn.
    // Core's `TerminalTransitions.end` owns the release now, at the far end,
    // and only once the ledger holds nothing owed.
    // The fleet row. Separate from the durable run above and deliberately not a
    // projection of it: `closeTurnRun` writes one workspace's own history, which
    // is only readable by opening that workspace, and the question this answers —
    // are turns getting slower, is one model failing, what is the fleet spending
    // — cannot be asked of a per-workspace log at all. It carries no message and
    // no error text; the classification and the numbers are the whole row.
    recordTurnRow(this.env, {
      workspace: this.workspaceName(),
      agentKind: this.actorKind(),
      ...this.analyticsModel(),
      outcome: completed ? 'ok' : errorText === undefined ? 'refused' : 'failed',
      code: '',
      durationMs: this.acc.startedAt > 0 ? Date.now() - this.acc.startedAt : 0,
      steps: this.acc.stepCount,
      toolCalls: this.acc.toolCalls.length,
      usage: this.acc.usage,
      usd: this.priceAt(this.acc.usage),
    });
    return overflowRecovery;
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
        // recorded text and the recorded message rather than from a live tree an
        // interrupted activation no longer has. The host's own turn-end handlers
        // are idempotent per turn, so the row is what stops a SECOND announcement
        // of one answer without dropping the first when the cut came before it.
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
      overflow_retry: overflowRetryTerminalEffect(this.orch.signals),


      turn_record: terminalEffect({
        input: v.object({
          messageId: v.string(), status: RunEndReasonSchema, turn: JsonValueSchema,
          continuity: TurnContinuitySchema, workMode: WorkModeSchema, recordedAt: v.number(),
          autoEvolve: v.boolean(),
        }),
        // The window append is idempotent on the assistant message's own durable
        // identity, so a replay leaves ONE window row and counts the session
        // cadence once — the property that makes the recording replayable at all.
        // Continuity, mode and the evolution gate come off the ROW, never off
        // activation-local state a fresh isolate would default to
        // `conversation`, `build`, and whatever THIS host's engine is set to.
        run: ({ messageId, status, turn, continuity, workMode, recordedAt, autoEvolve }) => {
          if (workMode === 'plan') {
            // The live plan path records nothing, and a replay must not either.
            return { status: 'completed', detail: 'a plan turn records no evolution state' };
          }
          // Unkeyed for an empty id: every such response would share one key, and
          // the second would read the first's append as its own.
          const recordedId = keyedScope(messageId);
          this.orch.recordTurn(
            this.orch.recordedTurn(status, v.parse(CompletedTurnSchema, turn)),
            continuity,
            recordedId === undefined
              ? { recordedAt, enabled: autoEvolve }
              : { recordedAt, enabled: autoEvolve, id: `turn-${recordedId}` },
          );
          return { status: 'completed' };
        },
      }),

      event_drain: terminalEffect({
        input: v.object({}),
        // Idempotent by construction: the drain selects only PENDING, unbound
        // rows, so a replay picks up whatever is still pending and re-delivers
        // nothing already bound to a turn.
        run: async () => {
          // RETHROWING. The drain absorbs its own selection and binding failures
          // for its ambient callers, which have nothing owed to retry them. This
          // row does, and reporting `completed` over a half-bound batch strands
          // the assignment behind it.
          await this.orch.drainPendingEvents({ rethrow: true });
          return { status: 'completed' };
        },
      }),

      improvement_lanes: terminalEffect({
        input: v.object({
          status: RunEndReasonSchema, turn: JsonValueSchema, workMode: WorkModeSchema,
          advisor: JsonValueSchema,
        }),
        // Every lane below is driven by a DURABLE queue or window, so re-entry
        // reads its input from storage rather than from a snapshot of a turn that
        // no longer exists. The verdict is core's one derivation, asked with the
        // RECORDED mode so a fresh activation's default cannot open a lane the
        // turn never earned.
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

      shadow_trial: terminalEffect({
        input: v.object({
          turn: JsonValueSchema, trialContext: JsonValueSchema, pendingVersion: v.number(),
        }),
        // Its OWN row, not a step inside the lanes above: a full queue is a
        // refusal a later drain clears, so the trial stays owed while the review
        // beside it does not wait for a slot — nor repeat when the trial retries.
        run: ({ turn, trialContext, pendingVersion }, scope) => {
          const trialScope = keyedScope(scope);
          const queued = this.engine.queueShadowTrial(
            v.parse(CompletedTurnSchema, turn), v.parse(ModelMessagesSchema, trialContext),
            trialScope === undefined
              ? { pendingVersion }
              : { pendingVersion, id: `trial-${trialScope}` },
          );
          // A REFUSAL is not a deferral, and conflating them wedged the whole
          // transition: a session with evolution off answers `not_sampled`
          // forever, so an owed row for it holds the outer claim open across
          // every later start. `not_sampled` and `no_pending` mean there is
          // nothing to queue and never will be for this turn — the obligation is
          // discharged. Only a full queue or a failed insert is worth coming back
          // for, and both clear on their own.
          if (queued === 'queue_full' || queued === 'failed') {
            return { status: 'owed', detail: `the shadow trial for this turn is ${queued}` };
          }
          return queued === 'queued'
            ? { status: 'completed' }
            : { status: 'completed', detail: `no trial to queue: ${queued}` };
        },
      }),
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
        scheduleRetry: (atMs: number) => this.scheduleTerminalRetry(atMs),
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
   * `_inFlight === false` while `active_durable_turn` still names that turn. So
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
    return openChatTurnResponses(this.boundSql, turnId)
      .some((requestId) => !this._settlingChatRequests.has(requestId));
  }


  /**
   * Arm a DURABLE wake for the terminal effects still owed.
   *
   * A JavaScript reference to a pending promise is not a wake: once
   * `onChatResponse` returns, the runtime may terminate the isolate with email
   * replies, parent RPCs and model lanes still in flight, and an idle workspace
   * would then owe a reply that nothing ever retries. The schedule row is what
   * makes the retry exist independently of this activation.
   *
   * One row per actor, soonest-wins: the write comes FIRST and the collapse
   * reads after it, because cancelling before scheduling opens a window with no
   * wake row in it, and a failure inside that window ends the retry chain for
   * good. An extra row is the harmless failure instead — the tick is idempotent
   * and re-arms from durable state, so it costs one early wake.
   */
  protected async scheduleTerminalRetry(atMs: number): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    // Round UP: the SDK stores schedule times in whole seconds, and waking
    // before the target leaves the retry not-yet-due, which would re-arm for the
    // same second and busy-spin the alarm until the millisecond passed.
    const targetSec = Math.max(Math.ceil(atMs / 1000), nowSec + 1);
    await this.schedule(new Date(targetSec * 1000), TERMINAL_RETRY_CALLBACK);
    // FUTURE rows only. While `_kinuTerminalRetryTick` runs, the SDK keeps its
    // own one-shot row in `listSchedules()` until the callback returns — so a
    // collapse that counted it would pick the overdue executing row as the
    // earliest keeper, cancel the future row this call just wrote, and then lose
    // the keeper when the SDK deletes it. Any effect needing a second alarm
    // attempt would stop retrying. Same exclusion, same reason, as `armTimer`.
    const armed = (await this.listSchedules())
      .filter((row) => row.callback === TERMINAL_RETRY_CALLBACK && row.time > nowSec);
    if (armed.length <= 1) return;
    // The keeper is chosen by a rule every concurrent arm computes identically —
    // earliest wake, ties broken by the SDK's own row id — so two arms converge
    // on the same survivor without coordinating, and the loser's second cancel of
    // an already-cancelled id is a no-op.
    const keeper = armed.reduce((best, row) =>
      row.time < best.time || (row.time === best.time && row.id < best.id) ? row : best);
    for (const row of armed) {
      if (row.id !== keeper.id) await this.cancelSchedule(row.id);
    }
  }

  /**
   * The durable wake that finishes what a dead activation still owed.
   *
   * Public because `Agent.schedule()` types its callback as `keyof this`, which
   * excludes protected members. Idempotent: it reads the owed roster from
   * storage and re-arms from what is left, so a duplicate wake costs one read.
   */
  async _kinuTerminalRetryTick(): Promise<void> {
    // Maintenance first: the budgeted sweeps and the activation-scoped
    // recovery run in this alarm frame, then the owed external deliveries.
    // One wake, one carrier, collapse semantics included — a pass that left
    // work unfinished re-arms THIS tick through the same singleton-safe armer,
    // at the shared capped backoff: a deep backlog drains at a growing pace,
    // and a persistently FAILING sweep (which also answers unfinished) settles
    // at the ceiling instead of a one-second loop. The lap count is the
    // isolate's own; an eviction resets pace and backlog reads together.
    const sweepsUnfinished = this.maintenanceSweeps();
    const recoveryUnfinished = await this.maintenanceWork();
    await this.owedDeliveryWork();
    if (sweepsUnfinished || recoveryUnfinished) {
      this.#maintenanceLaps = this.#maintenanceLaps + 1;
      await this.scheduleTerminalRetry(Date.now() + recoveryBackoffMs(this.#maintenanceLaps));
    } else {
      this.#maintenanceLaps = 0;
    }
  }

  /** Consecutive unfinished maintenance laps — the pace input for the tick's
   *  own re-arm. In-memory on purpose: the pace only has to hold within one
   *  isolate, and evictions are slower than the ceiling it caps. */
  #maintenanceLaps = 0;

  /**
   * When this activation began — the isolate's own construction instant.
   *
   * The recovery cutoff: a head spawned AFTER this moment belongs to a live
   * request of THIS activation (requests can land between construction and
   * the wake's first tick), and no recovery pass may mark it.
   */
  protected readonly activationStartedAt = Date.now();

  /**
   * Whether this activation still owes its ONE recovery pass.
   *
   * In-memory ON PURPOSE: "once per activation" is a property of the isolate,
   * and an eviction resets both together. It is what keeps the recovery in
   * `maintenanceWork` off the ordinary terminal retries that arm the same
   * wake mid-activation — `reconcileInterruptedForks` assumes every running
   * head it sees is stale, which is true for heads spawned before
   * {@link activationStartedAt} and FALSE for live ones after it.
   */
  protected activationRecoveryPending = true;

  /**
   * Everything a wake dispatches, in the one order that cannot lose work.
   *
   * A seam rather than the tick body so a subclass with MORE owed external
   * lanes (the orchestrator's event drain replies) prepends them here and the
   * whole set rides ONE durable wake — the init gate arms this and never runs
   * it, per the ruling that an activation launches no external work.
   */
  protected async owedDeliveryWork(): Promise<void> {
    await this.terminal.replayOwedAndRearm();
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
   *  it: `_turnCheckpoint` outlives the turn on purpose (a background
   *  continuation keeps tagging its originating turn) and the NEXT turn
   *  overwrites it, so a detached effect that re-read it could close the wrong
   *  turn's claim. */
  protected durableTurnId(): string | null {
    const live = this._turnCheckpoint?.turnId;
    if (live !== undefined) return live;
    // A cold activation has no checkpoint in RAM yet. The one-row handoff
    // lets a Stop sweep the original turn's device requests before recovery
    // re-enters beforeTurn and rebuilds the live checkpoint.
    return this.sql<{ turn_id: string }>`SELECT turn_id FROM active_durable_turn WHERE id = 1`[0]?.turn_id ?? null;
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
  protected holdTerminalClose(
    transition: TerminalTransition, close: () => Promise<void>, chatRequestId: string,
  ): void {
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
          // NAMED for the duration of the close, because the close asks the chat
          // roster whether anything else may still act under this turn and the
          // response being closed usually still owns a row of its own.
          this._settlingChatRequests.add(chatRequestId);
          try {
            await close();
          } finally {
            this._settlingChatRequests.delete(chatRequestId);
          }
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

  /**
   * A usage report priced at the actor's own catalog rate, or undefined when the
   * catalog holds none.
   *
   * Undefined rather than 0: an unpriced call and a free one are different facts,
   * and the dataset keeps them apart with its own `priced` witness so an average
   * cost cannot be diluted by calls nobody could price. Whether the rate IS the
   * call's own is the CALLER's guard — pricing a judge, which `selectJudgeModel`
   * sends cross-family on purpose, at the actor's rate would put a fabricated
   * number in the dataset.
   */
  private priceAt(usage: Usage): number | undefined {
    const pricing = this.modelCatalog.pricing();
    return pricing ? priceCall(usage, pricing) : undefined;
  }

  /** Durable per-session compaction state (plan snapshot + the measured
   *  prompt-token trigger signal) in DO SQLite. Table created in ensureSchema. */
  protected readonly compactionState: CompactionStateStore;

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

  /** Better-compact is THE default (and only) compaction path: the staged
   *  pruning ladder runs as a transformContext extension once per turn
   *  assembly, replaying its persisted plan byte-stably until the context
   *  regrows. Registered unconditionally at construction; every port
   *  dereferences `this` lazily, so nothing heavy (the CF runtime, the model)
   *  is built before it is first needed. */
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

  private registerCompactionExtension(): void {
    this.extensions.register(createCompactionExtension({
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
    }));
  }

  /** Persist the verified connect-ticket scopes, the CLI bearer behind them,
   *  AND the browser session behind a cookie-authenticated connection (edge-set
   *  headers, see appendIdentityHeaders) as connection tags — tags ride the
   *  WebSocket attachment, so the rpc gate and both identities survive DO
   *  hibernation. */
  override async getConnectionTags(connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const tags = await super.getConnectionTags(connection, ctx);
    const scopeTag = cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER));
    const bearerTag = cliBearerConnectionTag(ctx.request.headers.get(CLI_BEARER_HEADER));
    const sessionTag = sessionBearerConnectionTag(ctx.request.headers.get(SESSION_BEARER_HEADER));
    return [
      ...tags,
      ...(scopeTag === null ? [] : [scopeTag]),
      ...(bearerTag === null ? [] : [bearerTag]),
      ...(sessionTag === null ? [] : [sessionTag]),
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
   * Refuse a frame from a connection whose authority no longer holds — the
   * CLI bearer it upgraded with, or the browser session behind its cookie.
   *
   * FRAME TIME, AND AGAINST THE AUTHORITY, because the upgrade checks each
   * exactly once and everything after that used to be unconditional trust:
   * revoke the token or log out the session, and the socket kept its full
   * @callable surface until the client disconnected, which for a CI runner is
   * as long as it likes. Hibernation made it worse, since the connection came
   * back from its tags with its scopes and no identity to check at all.
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
    // sentence ('the CLI token behind this connection is no longer valid')
    // where the client's next step belongs.
    if (rpc) connection.send(JSON.stringify({ type: 'rpc', id: rpc.id, success: false, error: denial.why }));
    connection.close(WEBSOCKET_POLICY_CLOSE, denial.close);
    diagnostics.event('auth.socket_frame_denied', { outcome: 'denied', reason: 'authority_not_live' });
    return true;
  }

  /** Why this connection's authority may no longer act, and what to tell the
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
   * Why this connection's CLI bearer may no longer act, or null when it may.
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
    return super.shouldConnectionBeReadonly(connection, ctx)
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
  private _orch: AgentOrchestrator | null = null;
  protected get orch(): AgentOrchestrator {
    if (!this._orch) {
      this._orch = new AgentOrchestrator({
        host: this.host,
        engine: this.engine,
        eventLog: this.eventLog,
        budget: this.budget,
        // The refinement lane runs on the ONE off-turn cadence pass, beside the
        // promotion gate's trials. Every actor wires it: a facet accrues
        // evolution debt like any agent, and its refiner is the port above.
        refinementLane: () => this.runRefinementLane(),
        roleCatalog: () => this._turnProfileInputs
          ? Object.keys(effectiveRoleCatalog(this._turnProfileInputs.envelope.catalog))
          : undefined,
        sinks: {
          logActivity: (e, d) => this.logActivity(e, d),
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
      });
    }
    return this._orch;
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
  // A recursive split runs on a facet with its own SQLite, so a journal it
  // wrote locally would strand its rows one DO away from the head_steps they
  // must join against — the C2 defect that made a depth-2 head unreadable.
  // These four are the writes HeadController performs, exposed as the same kind
  // of cross-DO port missionGuard/missionDebit use: worker-side DO RPC reachable
  // on a stub and nowhere else, never `@callable`, allowlisted in rpc-surface.ts.

  async headJournalRecordSplit(rootId: HeadId, rationale: string, spawnedAt: number): Promise<void> {
    this.headJournal.recordSplit(rootId, rationale, spawnedAt);
  }

  async headJournalInsertSpawn(input: HeadInput): Promise<void> {
    this.headJournal.insertSpawn(input);
  }

  async headJournalRecordReport(report: HeadReport): Promise<void> {
    // The announcement is the JOURNAL's now, not this method's. It used to
    // broadcast here, which made a branch's last write — the summary, the status
    // and the wall clock — live for a recursive split and for nothing else,
    // because this RPC is only reachable from a facet calling its parent.
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
  private _mcpWarmTask: AsyncTaskOwner | null = null;

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
          if (!(await this.workspaceCapabilityToken())) return;
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

  /** The current MCP warm's observable settlement, for lifecycle joins. */
  protected mcpWarmSettlement(): Promise<void> {
    return this._mcpWarmTask?.promise ?? Promise.resolve();
  }

  /**
   * The advisor lane: one review of the turn that just ended.
   *
   * Detached for the same reason the evolution lane is — it is a model call on
   * a path the turn queue is holding — and durable for the same reason: a
   * deploy or an alarm-boundary reset used to take the review with it, leaving
   * no row and no event, so a turn silently got no advice and nothing said so.
   * A reviewer that FAILS leaves a turn with no advice, never a failed turn, so
   * nothing here can reach the caller.
   *
   * The stash carries the WHOLE review, not a pointer to it: the completed
   * turn, the tool names it ran with, the severity floor and the dedupe window.
   * That snapshot is what makes {@link recoverAdvisorLane} a re-drive rather
   * than an obituary — a lane interrupted near a deploy used to terminalize as
   * lost, so a turn that ended at the wrong moment silently got no advice.
   * Nothing is truncated to fit: `AdvisorRecoverySnapshotSchema` mirrors the
   * lane's own deps through the same `CompletedTurnSchema` that the unified
   * `completed_turns` table already persists a turn with, so a turn that could
   * not be snapshotted here could not have been stored there either — the size
   * policy lives upstream where the turn's parts are clamped, and a second
   * weaker copy of it here would be the bound nobody measured.
   *
   * Both reads off `_lastTurnOpts` happen BEFORE the fiber starts. `runFiber`
   * awaits `keepAlive()` before it runs the body, so reading them inside would
   * be reading them after an await — which is how a later turn's tool set
   * bleeds into this turn's review.
   *
   * Governed off the TURN's labels rather than the governor's active scope, the
   * same way the engine's own review is: this runs after the turn ended, when
   * the active scope is either empty or some later turn's, and debiting a
   * mission for work it did not cause is worse than not debiting at all.
   *
   * There is no completion gate on this backend — it is the one-shot CLI
   * surface's mechanism — so `gateOpen` is false here by construction rather
   * than by omission.
   */
  /** The advisor's whole input, read while the turn is still in memory. Recorded
   *  by the caller that OWES the review, because `_lastTurnOpts` is null on a
   *  cold activation and an advisor that re-derived `reachable` there would
   *  review a different tool surface from the one the turn ran with. */
  protected advisorSnapshotFor(turn: CompletedTurn): AdvisorRecoverySnapshot {
    return {
      turn,
      // The turn's OWN ToolSet keys: what the actor demonstrably had, not what
      // this actor class can have. A capability the turn never carried must
      // never be named at it.
      reachable: Object.keys(this._lastTurnOpts?.tools ?? {}),
      minSeverity: this.config.getAdvisorMinSeverity(),
      recent: [...this.engine.recentAdvisorNotes()],
    };
  }

  /**
   * Start the advisor review on its own durable lane, and resolve once that lane
   * has CHECKPOINTED — not once the review is done.
   *
   * The caller is a terminal effect, and what it owes is a recoverable review
   * rather than a finished one. Resolving at the checkpoint is what makes those
   * the same thing: before it, an eviction between the effect's completion and
   * the fiber's first tick left recovery reading a null snapshot and terminalizing
   * a review that never ran. After it, the fiber is re-drivable on its own.
   */
  private readonly _advisorReviewTasks = new Map<string, AsyncTaskOwner>();

  protected reviewTurnInBackground(turn: CompletedTurn, recorded?: AdvisorRecoverySnapshot): Promise<void> {
    if (this.rt.advisorLlm === undefined || !this.config.getAdvisorEnabled()) return Promise.resolve();
    // ONE lane per turn, ever STARTED. A terminal replay arriving after the
    // checkpoint but before its row recorded `completed` would otherwise open a
    // second fiber beside the first — which the SDK can still recover — and two
    // advisors would review one turn, each spending a model call and appending
    // its own note. Recovery re-drives the fiber this accepted; it does not come
    // back through here. An unkeyed turn has no replay to guard against.
    const laneKey = turn.turnId === undefined || turn.turnId === '' ? null : turn.turnId;
    if (laneKey !== null && effectAlreadyDone(this.boundSql, ADVISOR_LANE_SCOPE, laneKey)) {
      return Promise.resolve();
    }
    const snapshot: AdvisorRecoverySnapshot = recorded ?? this.advisorSnapshotFor(turn);
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
          if (laneKey !== null) recordEffectDone(this.boundSql, ADVISOR_LANE_SCOPE, laneKey);
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
    const llm = this.rt.advisorLlm;
    if (llm === undefined) return null;
    const labels = snapshot.turn.missionLabels ?? [];
    return await runAdvisorLane({
      turn: snapshot.turn,
      llm: labels.length === 0 ? llm : this.budget.govern(llm, labels),
      enabled: true,
      minSeverity: snapshot.minSeverity,
      recent: snapshot.recent,
      gateOpen: false,
      reachable: snapshot.reachable,
      deliver: (signal) => this.orch.signals.deliver(signal),
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
      sql: this.boundSql,
      config: this.config,
      surface: (task, context, callScope) => ({
        llmStream: this.makeScaffoldLLMStream(),
        // The same tool dispatcher the production chat path uses, so a
        // candidate runs with the real tool surface rather than the disabled
        // tool-call fallback that penalizes any tool-using candidate.
        //
        // The SCOPE is what makes a re-driven rollout's external calls
        // recognisable: a queued trial hands its row id down, so each invocation
        // gets the same id on a replay and the generic tool-effect claim can
        // refuse the second one. A preview or a GEPA rollout has no durable
        // identity and passes none.
        callTool: this.makeScaffoldCallTool(callScope),
        history: this.makeScaffoldHistory(),
        // With a replay context this re-runs the trial turn's OWN conversation
        // — the parity a delegating candidate needs to be judged on the
        // scaffold delta rather than on a context handicap. Without one (a
        // preview, a GEPA rollout) the task is all there is.
        //
        // The replay goes straight to streamText rather than through
        // assembleTurnMessages, so the pairing invariant is applied here: a
        // context captured from a turn that was interrupted between a tool call
        // and its result would make streamText throw before the request left
        // the isolate, failing the shadow trial for a reason that has nothing
        // to do with the scaffold being judged. The CLI's replay reaches the
        // invariant through runChat (cli-backend local-session.ts); this is the
        // other half of that one path.
        defaultInference: () => {
          const spend = this.scaffoldSpend();
          // Opened before the request, drained on finish. A raw `streamText` has
          // no spend seam of its own, so without this the candidate's whole
          // replay — the most expensive thing the scaffold plane runs — filed
          // neither a cost nor an in-flight row, and a process that died here
          // left nothing naming what was running.
          const operation = beginModelOperation(spend, 'stream');
          return projectDefaultInference(streamText({
            model: this.ownedModelServices.resolveModel(this.modelSpecForSource('scaffold')),
            messages: context && context.length > 0
              ? settleUnpairedToolCalls(context) ?? [...context]
              : [{ role: 'user', content: task }],
            tools: this.getRawTools(),
            ...effortFor('scaffold_mutation'),
            // `totalUsage`, not the last step's: this is a real multi-step loop
            // and the last step alone would omit every step before it.
            onFinish: (event) => {
              const usage = normalizeUsage(event.totalUsage);
              const modelId = event.response.modelId;
              operation.completed({ usage, modelId });
              spend.report({ source: 'scaffold', usage, modelId });
            },
            onError: (event) => { operation.failed({ cause: event.error }); },
          }).toUIMessageStream());
        },
      }),
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
  protected makeScaffoldLLMStream(): ScaffoldRunOptions['llmStream'] {
    return createScaffoldLLMStream({
      model: this.ownedModelServices.resolveModel(this.modelSpecForSource('scaffold')),
      tools: () => this.getRawTools(),
      streamOptions: effortFor('scaffold_mutation'),
      // The bridge already opens an operation and reports `totalUsage` once the
      // loop drains — it just needed a seam to report THROUGH.
      spend: this.scaffoldSpend(),
    });
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
  protected makeScaffoldCallTool(callScope?: string): NonNullable<ScaffoldRunOptions['callTool']> {
    if (callScope === undefined) return createScaffoldCallTool(() => this.getRawTools());
    // Built ONCE for the rollout and held: the thunk is asked per dispatch.
    let scoped: ToolSet | undefined;
    return createScaffoldCallTool(
      () => (scoped ??= this.getRawToolsForWorkMode(this.turnWorkMode(), callScope)),
      callScope,
    );
  }

  /** The scaffold's host.history bridge (core scaffold-host): a read-only,
   *  budgeted page of THIS turn's prepared messages — the same stream the
   *  scaffold is the inference loop for. Read per call, so a scaffold running
   *  across a turn sees the messages as they stand when it looks. */
  protected makeScaffoldHistory(): NonNullable<ScaffoldRunOptions['history']> {
    return createScaffoldHistory(() => this._lastTurnOpts?.messages ?? []);
  }

  /**
   * Inference seam override — THE single production chat path on Think, for
   * EVERY actor. A facet that evolves a scaffold it cannot run is a dead
   * loop, so this lives on the substrate, not on one subclass.
   *
   * Think's `_runInferenceLoop` is private and calls the AI SDK `streamText`
   * itself; this protected transform is the one seam a subclass gets that can
   * replace the stream every turn entry path consumes (the old
   * `runStreamText` override had zero callers on 0.8.2 — the scaffold was
   * silently dead until this re-wire). We route through the agent's mutable
   * scaffold IFF it has evolved one (current version > 0). An un-evolved
   * agent (still on the bootstrap v0) returns Think's result untouched —
   * same behaviour as before, zero overhead — until the evolution loop
   * proves + promotes a better scaffold via shadow eval. Once promoted, that
   * scaffold becomes the agent's live inference loop. One method, one
   * decision, no parallel paths (core scaffold/inference-transform.ts owns
   * the routing + orphan-stream semantics).
   *
   * The scaffold runs in the codemode sandbox and reaches the model/tools/
   * memory only through the `host.*` bridge (the live result object can't
   * cross the boundary). `host.defaultInference()` streams exactly THIS
   * prepared result back, so a delegating scaffold is byte-faithful to the
   * default; a custom scaffold can wrap or replace it.
   */
  protected _transformInferenceResult(result: StreamableResult): StreamableResult {
    const version = this.sql<{ v: number }>`
      SELECT COALESCE(MAX(version), 0) AS v FROM scaffold_versions WHERE status = 'current'`[0]?.v ?? 0;

    return scaffoldInferenceTransform({
      currentVersion: version,
      result,
      run: {
        rt: this.rt,
        // beforeTurn stashed this turn's prepared opts just before streamText
        // fired (turns are serialized on the TurnQueue, so it is THIS turn's).
        task: extractLastUserText(this._lastTurnOpts?.messages ?? []),
        llmStream: this.makeScaffoldLLMStream(),
        callTool: this.makeScaffoldCallTool(),
        history: this.makeScaffoldHistory(),
      },
    });
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
        enqueueTurn: async ({ text, metadata, idempotencyKey }) => {
          const drainTurnId = v.is(v.string(), metadata?.drainTurnId)
            ? metadata.drainTurnId
            : null;
          // The id is the row's provenance FALLBACK (core transcriptRole): every
          // turn the harness enqueues is prefixed, keyed or not. Where the
          // producer named the FACT, the id is that name — and the message
          // store's primary key is then what makes a re-announcement land on the
          // row the first one wrote instead of beside it.
          //
          // The AUTHOR is stamped here rather than left to the producer, because
          // this is the seam every programmatic row is written through: a turn
          // that reaches it without saying who wrote it is the harness speaking,
          // and the chat pane must never draw it as the owner's bubble.
          const message: UIMessage = {
            id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${idempotencyKey ?? crypto.randomUUID()}`,
            role: 'user' as const, parts: [{ type: 'text' as const, text }],
            metadata: stampTurnAuthor(metadata),
          };
          if (idempotencyKey) {
            const result = await this.submitMessages([message], { idempotencyKey, metadata });
            return {
              status: result.status === 'aborted' || result.status === 'skipped' || result.status === 'error'
                ? 'skipped'
                : 'queued',
              durable: {
                submissionId: result.submissionId,
                accepted: result.accepted,
                status: result.status,
              },
            };
          }
          try {
            const result = await this.saveMessages(() => {
              this._activeDrainTurnId = drainTurnId;
              this._activeProgrammaticUserMessage = message;
              return [message];
            });
            return { status: result.status === 'completed' ? 'queued' : 'skipped' };
          } finally {
            if (this._activeProgrammaticUserMessage === message) {
              this._activeDrainTurnId = null;
              this._activeProgrammaticUserMessage = null;
            }
          }
        },
        // A signal lands on the agent's next step, so this answers whether
        // there will be one. The read is synchronous and the seam's buffer
        // push happens in the same tick, so the turn observed here is the one
        // whose prepareStep will drain it (turns are TurnQueue-serialized); a
        // turn that settles first re-delivers the signal from settle().
        turnInFlight: () => this._inFlight,
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
    this._mcpToolsCache ??= new McpToolSurfaceCache<ToolSet>(async (descriptors) => {
      const tools: ToolSet = {};
      for (const d of descriptors) {
        const serverId = d.serverId;
        const mcpName = d.name;
        tools[d.toolKey] = tool({
          description: d.description ?? `${d.serverName}/${mcpName}`,
          inputSchema: jsonSchema<JsonObject>(d.inputSchema ?? { type: 'object' }),
          execute: async (args) => {
            try {
              const rawResult = await this.requireOwnerUserDO()
                .userMcp_callTool(await this.userCaller(), serverId, mcpName, args);
              return projectJsonValue({ value: v.parse(JsonValueSchema, JSON.parse(rawResult)) });
            } catch (err) { return { isError: true, error: renderThrownChain({ cause: err }) }; }
          },
        });
      }
      // An MCP server is a bulk producer like any other. Apply the same result
      // clamp and spill path as built-in tools.
      return withClampedToolResults(tools, {
        vfs: this.rt.storage.vfs, budget: this.acc.context, producer: 'external_tool',
      });
    });
    return this._mcpToolsCache;
  }


  // Preamble-injection: the codemode tool is built once per DO lifetime.
  // Its executor (PreambleCraftedExecutor) reads craftStore.list() on every
  // execute call, so newly-saved tools appear on the next execute_tools
  // invocation without any registry or cache coherence work.
  private readonly _craftExecTools = new Map<string, ReturnType<typeof createExecuteToolsTool>>();

  /** The stores every agent has, from core — one list both backends inherit,
   *  so a store added there exists for this actor too. Lazy inside: the bundle
   *  never touches `boundSql` until a store is first read, which is what lets
   *  it be built here rather than in the constructor body. */
  private readonly stores = createAgentStores(() => this.boundSql);

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
      (headId) => this.announceHeadActivity(headId),
    ));
  }

  /** Tell every open client that one branch's ledger moved. Ordering and
   *  failure isolation belong to {@link LiveHeadJournal}, which calls this only
   *  after its write has returned and never lets a throw here reach core. */
  private announceHeadActivity(headId: string): void {
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
  // reactor_decision}. The RunEventRecorder shim adapts the existing emit()
  // API to the unified log so the SSE stream and the events sidebar share
  // one source of truth.
  protected get eventRecorder(): RunEventRecorder {
    return this.stores.eventRecorder;
  }

  /**
   * Record one non-turn model call in the durable run-event log.
   *
   * The turn loop's spend arrives as `step_finish` (`onStepEvent` above). This is
   * the other 25 producers — judges, the fast tier, the evolution engine,
   * compaction, a scaffold's own loop, the
   * platform AI bindings — each of which used to drop the provider's report on
   * the line that received it. Same log, same `Usage`; a `model_call` row rather
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
      this.eventRecorder.emit(this._currentRunId || WORKSPACE_RUN_ID, event);
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
      // this line used to re-derive it and could disagree with the ledger if the
      // catalog resolved a rate between the two reads.
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
    this.eventRecorder,
    () => this._currentRunId || WORKSPACE_RUN_ID,
  );

  // ── EventsHub: per-agent ingress + persistence + dispatch. ──────────────
  // Load-bearing primitives (spec §1):
  //   - `agent_log`     unified append-only ledger (initEventsHubTables)
  //   - EventLog        publish/pending/defer/dismiss/query
  //   - TriggerRegistry durable subscriptions (webhooks, timers, watches)
  //   - ReplyChannelStore  durable reply-channel rows + dispatchers
  // Spec: docs/ARCHITECTURE.md — "Events and ingress"
  private _eventLog: import('@kinu.run/core').EventLog | null = null;
  protected get eventLog(): EventLog {
    if (!this._eventLog) {
      this._eventLog = new EventLog(this.ctx.storage.sql);
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
   * cycle and an agent-initiated `agents` fork (see getAgentsToolDeps). It used
   * to hang off the orchestrator and be reachable only from the first of those,
   * so a search an operator started emitted nothing and its tree sat still for
   * as long as it ran.
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
      const nodes = readSearchTree(this.boundSql, rootId);
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
        signals: this.orch.signals,
        eventLog: this.eventLog,
        scheduleDrain: () => this.orch.scheduleDrain(),
        logActivity: (event, detail) => this.logActivity(event, detail),
        // The device requests THIS tool call issued, handed to the job that now
        // owns them — by request id, never by turn. A turn can hold several
        // parallel laptop commands and only the detaching call changes hands, so
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
        onSettled: (job) => this.notifyOwner(
          `Background ${job.kind} job ${job.status}`,
          job.status === 'completed'
            ? `Background ${job.kind} job ${job.id} completed.\n\nResult:\n${job.result ?? '(empty)'}`
            : `Background ${job.kind} job ${job.id} ${job.status}${job.error ? `:\n\n${job.error}` : '.'}`,
        ),
        // Evict-resume (B6): re-drive an interrupted job from its durable
        // checkpoint. A fork re-runs the raw agents tool — MCTS continues its
        // remaining search budget via the search store; heads re-run from input.
        // Side-effecting kinds (execute_tools / run) are not safe to blindly
        // re-execute, so they decline and fall back to the eviction failure.
        resume: (kind, input, mode, signal) => this.resumeBackgroundJob(kind, input, mode, signal),
        // What a bounded-out job already produced. Same predicate as `resume` above,
        // so a kind that cannot be re-driven has nothing partial to read either —
        // and a SEARCH does, which is the case that used to settle empty over two
        // completed candidates.
        harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
          { sql: this.boundSql, ledger: this.mctsSearchStore }, kind, input,
        )),
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
   * a `run` and an `execute_tools` reach the container directly, and every other
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
   *     caller of a container tool;
   *   • the subtree          — a subordinate rides its PARENT's container
   *     (`workspaceName()` resolves to the parent), so a root that answered only
   *     for itself would declare the container idle while a hire was building in
   *     it. Recursive, so depth is bounded by the delegation cap rather than by
   *     anything here.
   *
   * A subordinate that cannot be reached counts as busy: its facet is
   * registered, so the honest reading of a failed call is "unknown", and unknown
   * resolves the same way every other ambiguity here does.
   */
  async hasSandboxBackgroundWork(): Promise<boolean> {
    if (this._inFlight) return true;
    if (this.jobs.countRunning() > 0) return true;
    const submissions = await this.listSubmissions({ status: ['pending', 'running'] });
    if (submissions.length > 0) return true;
    const fibers = await this.listFibers({ status: ['pending', 'running', 'interrupted'] });
    if (fibers.length > 0) return true;
    return await this.subtreeHasSandboxBackgroundWork();
  }

  /** The recursive half, split out so the local answer above reads as one list
   *  of sources rather than one list plus a fan-out. */
  private async subtreeHasSandboxBackgroundWork(): Promise<boolean> {
    const facet = this.subordinateFacet();
    for (const entry of this.subordinateRoster.list()) {
      try {
        const stub = await this.subAgent(facet, entry.name);
        if (await stub.hasSandboxBackgroundWork()) return true;
      } catch (err) {
        diagnostics.failure('sandbox.subordinate_work_probe_failed', toKinuError({
          doing: 'asking a subordinate whether it still holds container work',
          cause: err,
          otherwise: 'unavailable',
        }), { subordinate: entry.name });
        return true;
      }
    }
    return false;
  }
  /** Foreground long-tool controllers before they cross the background
   *  threshold. Once detached, BackgroundJobRunner owns cancellation. */
  protected readonly _activeToolControllers = new Set<AbortController>();

  // Typed accessors over the `agent_config` key/value table — replaces
  // scattered raw SQL with a single deep module.
  protected get config(): AgentConfigStore {
    return this.stores.config;
  }

  /** The unified `agents` tool's deps: the fork substrate is universal on cf
   *  actors — the SAME shared factory the CLI wires (core fork-deps), with
   *  the host-injected infrastructure recomputed per fork call; the
   *  roster/peer halves ride this actor's profile (actorToolDeps). Rebuilt
   *  with the toolset (getRawTools), so the fork model refreshes exactly
   *  when the toolset does. */
  private getAgentsToolDeps(workMode: WorkMode): AgentsToolDeps {
    const actorDeps = this.actorToolDeps();
    // Called directly rather than through the BackendHost seam. That seam is a
    // TYPES-layer contract, and routing a facet host through it made types/
    // depend on strategy/ — an inverted edge the layer gate refused, correctly.
    // Nothing outside this class ever read it, so the indirection bought nothing.
    const nodeLoopHost = this.getCFNodeHost();
    const nodeHomeProvisioner = this.hostedNodeHomeProvisioner();
    // Named and annotated rather than nested inline: this is the ONE production
    // construction site of `AgentsForkDeps` on this backend, and a literal buried
    // inside the outer one is a supply no reader — human or gate — can attribute
    // to the interface it satisfies. The CLI's `buildAgentsForkDeps` is its twin.
    const fork: AgentsForkDeps = {
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
      // Hosted nodes use a facet for their loop; local runtimes leave this
      // absent and execute the same core loop in-process.
      nodeHost: nodeLoopHost === undefined ? undefined : () => nodeLoopHost,
      // Every hosted node is provisioned before the engine opens its journal
      // row or hands a spec to a facet. The canonical Nimbus session is still
      // the one global filesystem; only the node's HOME, credential and shell
      // state are private.
      provisionNodeHome: nodeHomeProvisioner === undefined ? undefined : () => nodeHomeProvisioner,
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
      fork,
      budget: this.budget,
    };
    deps.profile = () => agentsProfileContext(this._turnProfile, this._turnProfileInputs);
    if (actorDeps.team) deps.team = actorDeps.team;
    if (actorDeps.peers) deps.peers = actorDeps.peers;
    return deps;
  }

  /** Convenience: current runId for event emission. One run per turn. */
  protected _currentRunId = '';

  // ── Skills (turn-scoped) ───────────────────────────────────────
  /** Resolved active set for the current turn. Built in beforeTurn, read by
   *  the system-prompt assembly via TurnConfig.system override. */
  /** Immutable role/tier/tool profile resolved once for the active turn. */
  private _turnProfileInputs: ProfileAuthorityInputs | null = null;
  private _turnProfile: ResolvedTurnProfile | null = null;
  private _turnActiveSkills: ActiveSkillSet | null = null;
  /** Lazy SkillsVfs shim around rt.storage.vfs — built once, reused. */
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
  private _instructionMigration: AsyncTaskOwner | null = null;
  protected _workspaceInstructionApprovals: readonly InstructionApproval[] | null = null;
  private instructionApprovals(): InstructionApprovalStore {
    this._instructionApprovals ??= new InstructionApprovalStore(
      this.rt.storage.sql,
      `cf:${this.workspaceName()}`,
      (body) => this.ctx.storage.transactionSync(body),
    );
    return this._instructionApprovals;
  }

  /** Bound once — a facet replaces this with the root authority snapshot. */
  private _instructionTrust: InstructionTrustResolver | null = null;
  protected instructionTrust(): InstructionTrustResolver {
    if (this._workspaceInstructionApprovals !== null) {
      return (path, content) =>
        trustOfInstructionApprovals(this._workspaceInstructionApprovals!, path, content);
    }
    const store = this.instructionApprovals();
    this._instructionTrust ??= store.trustOf.bind(store);
    return this._instructionTrust;
  }

  protected async refreshInstructionApprovalAuthority(): Promise<void> {
    await this.ensureInstructionApprovalMigration();
    this._workspaceInstructionApprovals = null;
  }

  /**
   * Snapshot existing instruction files before the first post-upgrade turn.
   *
   * The durable marker makes this asynchronous activation boundary the only
   * place a grandfather row is written. Later agent-created paths have no row
   * and resolve unverified.
   */
  protected ensureInstructionApprovalMigration(): Promise<void> {
    const existing = this._instructionMigration;
    if (existing !== null && existing.promise !== null) return existing.promise;
    const owner: AsyncTaskOwner = { promise: null };
    this._instructionMigration = owner;
    const migration = (async () => {
      try {
        const limits = {
          contextWindow: this.sessionContextWindow(),
          modelOutputLimit: this.modelCatalog.modelOutputLimit(),
        };
        const agentsMd = await collectWorkspaceAgentsMd(
          this.rt.storage.vfs,
          limits,
          () => 'unverified',
          this.rt.executionRouter?.getProvider('sandbox') ?? undefined,
        );
        const entries = await snapshotExistingInstructions({
          agentsMd,
          skillsVfs: this.getSkillsVfs(),
          admissionTokens: stepContextLimit(limits),
        });
        this.instructionApprovals().grandfatherExisting(entries);
      } catch (cause) {
        if (this._instructionMigration === owner) this._instructionMigration = null;
        throw cause;
      }
    })();
    owner.promise = migration;
    return migration;
  }


  /** The workspace root's authoritative approval rows. Facets fetch this before
   * each turn; they never consult their private actor SQL for shared files. */
  @callable()
  async getWorkspaceInstructionApprovals(): Promise<readonly InstructionApproval[]> {
    await this.refreshInstructionApprovalAuthority();
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
    await this.refreshInstructionApprovalAuthority();
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
    await this.refreshInstructionApprovalAuthority();
    const clean = path.trim();
    if (clean === '') return null;
    return openInstructionSource({
      path: clean,
      agentsMd: await this.discoverInstructionSources(),
      skillsVfs: this.getSkillsVfs(),
      trust: this.instructionTrust(),
      decisions: this.instructionApprovals().list(),
    });
  }

  /** AGENTS.md as the owner's surface sees it: discovered fresh, because a
   *  digest shown from a stale read would authorize bytes that already moved. */
  private async discoverInstructionSources(): Promise<AgentsMdSources> {
    return collectWorkspaceAgentsMd(
      this.rt.storage.vfs,
      { contextWindow: this.sessionContextWindow(), modelOutputLimit: this.modelCatalog.modelOutputLimit() },
      this.instructionTrust(),
      this.rt.executionRouter?.getProvider('sandbox') ?? undefined,
    );
  }

  /**
   * The owner grants THESE bytes at THIS path system placement.
   *
   * `digest` is the one the owner was shown. If the file has changed since, the
   * approval binds bytes that are no longer there, the next turn's lookup misses
   * and the file stays reference material — so the approve/preview gap fails
   * closed instead of granting force to something nobody read.
   */
  @callable()
  async approveInstruction(
    path: string, reviewedDigest: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    await this.refreshInstructionApprovalAuthority();
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
    await this.refreshInstructionApprovalAuthority();
    const admitted = admitInstructionDecision(path);
    if (!admitted.ok) return admitted;
    this.instructionApprovals().revoke(admitted.path);
    return { ok: true };
  }

  // ── Activity logging: persisted + broadcast to Logs pane ──
  private _turnT0 = 0;

  // Per-turn in-flight flag — forkAgent rejects with "agent busy" while set.
  // Set in beforeTurn, cleared in onChatResponse (after durable persist;
  // evolution is fire-and-forget and does not extend the busy window).
  protected _inFlight = false;
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
  /** The chat requests whose terminal close this activation is running — the
   *  responses {@link turnMayStillRun} must not read as somebody else. */
  private readonly _settlingChatRequests = new Set<string>();
  /** Synthetic drain id captured when its programmatic queue entry actually
   *  starts. `this.messages` may already contain a newer queued user message
   *  by the time this turn finishes. */
  protected _activeDrainTurnId: string | null = null;
  protected _activeProgrammaticUserMessage: UIMessage | null = null;
  /** Standalone drains may span Think auto-continuations under one request id. */
  protected readonly _pendingDrainReplyTurns = new Map<string, string>();

  /**
   * Mid-turn steers — what the user typed while this turn was running. The
   * SHARED core drain, so the USER semantics are defined in exactly one place
   * for both backends: each steer persists as a verbatim user row (the
   * walk-back fork cuts at user messages), an interrupt hands what the model
   * never saw back to the composer, and anything left over reruns as a
   * user-origin turn.
   *
   * Deliberately NOT `orch.signals`: a signal is never persisted and always
   * re-delivers as a turn of its own, which is the opposite of all three.
   */
  protected readonly userSteer = new UserSteerDrain({
    turnInFlight: () => this._inFlight,
    // A drain is the moment the steer stops being "queued" and becomes
    // something the model has. Both halves of saying so happen here: the
    // durable user row (so the fork and every read model see it) and the
    // broadcast every open surface renders it from.
    onDrain: (steers, atStep) => this.recordLandedSteers(steers, atStep),
  });

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
  private readonly dynamicLedger = new DynamicContextLedger();
  protected _cliCwd: string | null = null;
  /** Whether the message that opened the CURRENT turn was a conversational
   *  reply or an independent one-shot task (`kinu exec` against this
   *  workspace). Set in beforeTurn from the chat request; read at turn end to
   *  decide whether this turn may be parked awaiting a follow-up verdict.
   *  Defaults to a conversation — every non-CLI surface (web chat, API, the
   *  REPL) is one. */
  protected _turnContinuity: TurnContinuity = 'conversation';
  // Current turn identity for the device daemon's pre-mutation shadow-git
  // snapshot (set in beforeTurn; the daemon dedupes per turnId). Survives the
  // turn so background tool continuations keep tagging their originating turn.
  protected _turnCheckpoint: { turnId: string; sessionId: string } | null = null;

  // The prepared streamText opts of the LAST live chat inference, stashed at
  // the end of beforeTurn — Think 0.8's one turn-assembly hook on the live
  // inference path (the effective TurnConfig: final system/messages/tools/
  // model; Think then only wraps tool execute and re-applies the same values,
  // so a replay of these opts is the same request modulo per-step cache
  // markers, which are inert decoration). The shadow eval replays these for
  // the pending scaffold's host.defaultInference so the A/B measures the
  // scaffold delta, not a context handicap: the live answer saw the whole
  // conversation while the shadow's reconstruction used to see only the task
  // text — structurally tie-prone. Also the task source for the evolved-
  // scaffold inference transform. In-memory only: turns are serialized on
  // the TurnQueue and the shadow eval captures the reference synchronously
  // in the same onChatResponse, so it cannot be overwritten by a later turn;
  // after a DO restart the shadow falls back to the task-only reconstruction.
  protected _lastTurnOpts: Parameters<typeof streamText>[0] | null = null;

  getCliCwdForDevice(): string | null {
    return this._cliCwd;
  }

  getCheckpointMetaForDevice(): { turnId: string; sessionId: string } | null {
    return this._turnCheckpoint;
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

  /**
   * Best-effort tracing, where best-effort is a CONTRACT and not a hope.
   *
   * Every call site is fire-and-forget from inside work whose result must not
   * depend on a log row landing. `this.sql` is SYNCHRONOUS (`sql(...): T[]` on
   * the SDK's Agent) so `void` discards a row array, not a promise, and a
   * failing insert — a full database, a table a migration has not reached — is a
   * throw on the caller's own stack. Without this catch it becomes the caller's
   * failure, and it already did: the sandbox lifecycle seam logs before it
   * answers the container, so one unwritable row turned an announcement the
   * agent had ALREADY been given into a rejected RPC, and the container then
   * retried an incident that was on record forever, being refused by a log line
   * every time.
   *
   * The event NAME is reported and the detail is NOT. The name is a closed word
   * from this file; the detail is caller prose that can carry workspace text.
   */
  protected logActivity(event: string, detail?: string) {
    const elapsed = this._turnT0 > 0 ? Math.round(performance.now() - this._turnT0) : 0;
    const now = Date.now();
    try {
      void this.sql`INSERT INTO activity_log (event, detail, elapsed_ms, created_at)
        VALUES (${event}, ${detail ?? null}, ${elapsed}, ${now})`;
    } catch (cause) {
      diagnostics.failure('activity_log.write_failed', toKinuError({
        doing: 'recording an activity-log row',
        cause,
        otherwise: 'io',
      }), { source: event });
    }
  }

  protected get rt(): CFRuntime {
    if (!this._rt) {
      // No onToolRegistered hook: PreambleCraftedExecutor reads craftStore.list()
      // fresh on every execute_tools call, so mid-turn saves propagate
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
        ownerUserId: () => this.getOwnerUserId(),
        workspaceName: this.workspaceName(),
        shellId: this.shellId(),
        scaffoldPath: this.scaffoldPath(),
        capabilityToken: () => this.workspaceCapabilityToken(),
      }, {
        deferrals: () => this.deferralChannel(),
        reportModelCall: (report) => this.reportModelCall(report),
        turnProfile: () => this._turnProfile,
        resolveProfile: () => this.routingProfile(),
      });
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

  /** `memory.*` / `tasks.*` — unconditional on every ActorAgent (orchestrator
   *  and subordinate alike), the same way the native `memory` and `tasks`
   *  tools are. Deps read live per provider's own convention (memory's facts/
   *  vectorStore can rebind; tasks reuses `this.taskList`, the same
   *  TaskListStore instance the dynamic-context snapshot reads). */
  private baseCodemodeProviders(): CodemodeProvider[] {
    return [
      createMemoryCodemodeProvider(() => ({
        memory: this.rt.memory, vectorStore: this.rt.vectorStore,
        facts: this.facts, sql: this.rt.storage.sql,
      })),
      createTasksCodemodeProvider(this.taskList, this.config),
    ];
  }

  /**
   * Every codemode namespace this turn wires, in one place.
   *
   * ONE list with two readers: `beforeTurn` asks it which codemode-only
   * capabilities exist so a role can name them, and `getExecuteToolsTool` asks
   * it what to narrow. Two lists would let a role allow a capability whose
   * provider is absent, or narrow a set the resolver never saw.
   *
   * Plan mode is the only turn whose set differs: `release` is physically absent
   * from the type declaration and the dispatcher, while every ordinary
   * executor/provider stays present.
   */
  protected turnCodemodeProviders(mode: WorkMode): CodemodeProvider[] {
    return [...this.baseCodemodeProviders(), ...this.extraCodemodeProviders()]
      .filter((provider) => mode !== 'plan' || provider.name !== 'release');
  }

  /** Build (or return cached) this DO's execute_tools tool. Construction (see
   *  execute-tools.ts) is once per DO lifetime; crafted tools saved mid-turn
   *  still become callable because the executor re-reads craftStore per call. */
  private getExecuteToolsTool(mode: WorkMode, profileKey: string): ReturnType<typeof createExecuteToolsTool> {
    // The role's narrowing is PART OF THE KEY. `profileKey` is the actor's
    // active tool names, which two roles can share while reaching different
    // namespaces — so without the digest the first role's provider set is
    // served to the next one for the rest of this DO's life.
    const narrowing = narrowToolSurface(this._turnProfile?.allowedTools);
    const key = `${mode === 'plan' ? 'plan' : 'default'}:${profileKey}:${this._turnProfile?.digest ?? ''}`;
    if (!this._craftExecTools.has(key)) {
      this._craftExecTools.set(key, createExecuteToolsTool({
        loader: this.env.LOADER,
        rt: this.rt,
        sql: this.boundSql,
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
    const tool = this._craftExecTools.get(key);
    if (tool === undefined) throw new Error(`execute_tools profile ${key} was not built`);
    return tool;
  }

  /**
   * One producer's model SPEC, read synchronously from the turn's profile.
   *
   * The async {@link modelForSource} is the general path; this exists for the
   * seams whose types are synchronous — the sandbox's `modelSpec` and the
   * scaffold bridge's `model`. Both run inside a turn or in a trial detached
   * from one, so the profile is present; the stored id is the same fallback
   * `effectiveModelSpec` uses for a producer that somehow ran before any turn
   * resolved, and it keeps a mis-timed call working rather than throwing.
   *
   * Still the route table, never `profile.tiers.<name>`: a hand-picked tier here
   * would stop following MODEL_ROUTE_POLICY the moment the policy moved.
   */
  private modelSpecForSource(source: SpendSource): string | null {
    const profile = this._turnProfile;
    if (!profile) return this.getStoredModelId();
    return resolveModelRoute(source, profile)?.model ?? this.getStoredModelId();
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
    // SAFETY: the generated UserDO namespace contract provides both the
    // standard Fetcher surface and every UserDO RPC method in UserHubClient.
    return stub as UserHubRpcClient;
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
    const workspaceToken = await this.workspaceCapabilityToken();
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
   * did resolution cost" was answerable on a laptop and unanswerable in
   * production. Whether the row exists is not a per-backend choice, so this
   * backend no longer makes it — it only says WHERE the row goes, which is the
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
    return this._turnProfile;
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
   * The reason `parent` is worth being an executor rather than a file view: a
   * fork searching its parent used to walk the tree one RPC per file through an
   * emulated shell; this is one round trip into the real one, with the whole
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

  /**
   * One page of the durable transcript, oldest-first within the page, newest
   * page when called with no cursor.
   *
   * `@callable()` because a chat pane calls it over the socket. The pane is
   * SEEDED by the SDK's own `get-messages` route — `Think.messages`, a bounded
   * newest window governed by `hydrationByteBudget` — and this is the only way
   * to reach anything older than that window.
   *
   * On the substrate rather than on the workspace root, because a facet runs
   * `initWorkspaceSchema` against its own `ctx.storage.sql` and therefore has
   * its own conversation. Declared on the root alone, a subordinate's chat had
   * no way to ask for a page of its own history, so the column drove its
   * scroller with nothing to fetch and everything past the hydration window was
   * unreachable rather than slow.
   */
  @callable()
  async getChatHistoryPage(request?: PageRequest): Promise<Page<ChatHistoryEntry>> {
    this.ensureSchema();
    return getChatHistoryPage(this.boundSql, request ?? {});
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
   * Steer the running turn with something the user just typed — the third
   * composer action beside Stop and Branch, and the only one that neither
   * abandons the turn nor forks it.
   *
   * `'queued'` means the turn ended before this arrived, so this actor queued
   * the text as the next ordinary turn itself — atomically with the decision,
   * in its own turn queue. "It went into the running turn" and "it started a
   * new one" are different events for the person who typed it, so the answer
   * still says which; what no caller does any more is re-send.
   *
   * `mode` arrives over the wire, so it is admitted by `isWorkMode` rather
   * than trusted; anything unrecognized runs as ordinary build work, exactly
   * as `workModeForTurnMetadata` reads an unrecognized stored `kinuMode`.
   */
  @callable()
  async steerTurn(text: string, mode?: WorkMode): Promise<{ landed: SteerTurnLanding }> {
    this.ensureSchema();
    return { landed: await this.acceptUserSteer(text, isWorkMode(mode) ? mode : 'build') };
  }

  /** Stop the turn on screen — the composer's Stop button.
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
      activeToolControllers: this._activeToolControllers,
      broadcast: (payload) => this.broadcast(payload),
      interruptSteers: () => this.interruptUserSteers(),
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
    this.logActivity("getmodel");
    const spec = this._turnProfile?.tier.model ?? this.getStoredModelId();
    return this.ownedModelServices.resolveModel(spec);
  }

  /**
   * Delegates to @kinu.run/core's canonical prompt builder, which documents the
   * crafted-tool call form core's sandbox contract declares — `tools.<name>`,
   * the preamble-injected object literal spliced into the sandbox arrow. This
   * comment used to assert the opposite, that `codemode.*` was "the real
   * namespace crafted tools land in", which contradicted the correction this
   * backend's own crafted dispatcher raises. Cached across turns; invalidated
   * when the soul text or the registered executor set changes.
   */
  protected _cachedSystemPrompt: string | null = null;
  protected _cachedSystemPromptKey: string = "";
  /**
   * Cached SOUL.md text, refreshed at turn start and invalidated by setSoul().
   *
   * A cache rather than a read because `getSystemPrompt` is synchronous — Think
   * calls it that way, and the prompt it builds is the byte-stable cacheable
   * prefix — while the soul is a FILE in the workspace filesystem. So the read
   * happens where there is a promise to await (refreshSoulText, from
   * beforeTurn), and the prefix builder only ever consults what is already
   * loaded. A cold activation that has not reached a turn yet renders the
   * default identity, exactly as an unwritten SOUL.md always did.
   */
  protected _cachedSoulText: string | null = null;
  protected async loadSoulText(): Promise<string> {
    return (await readSoul(this.rt.storage.vfs)) ?? '';
  }
  protected async refreshSoulText(): Promise<void> {
    this._cachedSoulText = await this.loadSoulText();
  }
  private getSoulText(): string {
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
    // Authoritative state FIRST. `titleInputs` is synchronous, so an actor whose
    // naming lives elsewhere answers it from an activation cache that a cold
    // start has not filled — and a replayed title would then plan over a title
    // its own first attempt had already persisted.
    await this.hydrateTitleInputs();
    const title = await applyWorkspaceTitle({
      slug: this.name,
      ...this.titleInputs(),
      mission,
    }, {
      persist: (name) => this.persistAutoTitle(name),
      suggest: (text) => this.suggestTitle(text),
    });
    if (title) diagnostics.event('agent.auto_titled', { workspace: this.name, title });
    // ALWAYS, not only when this pass produced a title: persisting stamps
    // `name_origin`, after which the naming policy above no longer matches — so a
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
   *  cache of the ROOT registry row (UserDO), where an agent_config mirror
   *  would drift against every other writer of that row. */
  protected titleInputs(): WorkspaceTitleInputs {
    return { displayName: this.config.getDisplayName(), nameOrigin: this.config.getNameOrigin() };
  }


  /**
   * The shared naming round-trip: the same prompt and parser the create path
   * uses.
   *
   * Filed as `fast`, and RUN as `fast`. Naming is mechanical work, so
   * grouping it with the judges would make "what did grading cost" answer a
   * question it did not ask — and because `MODEL_ROUTE_POLICY.fast` is the
   * `tiny` tier, that same attribution decides the model. One `'fast'`
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

  getSystemPrompt(): string {
    this.logActivity("getsystemprompt_start");
    const execs = this.rt.executionRouter?.listExecutors() ?? [];
    const execKey = execs.map(e =>
      `${e.name}:${e.available ? 1 : 0}:${e.configured ? 1 : 0}:${e.active ? 1 : 0}:${e.status}`,
    ).join(",");
    const model = this.promptModelContext();
    const actorDeps = this.actorToolDeps();
    const availableTools = actorActiveTools(actorDeps);
    const agentsActions = actorAgentsActions(actorDeps);
    const profileDigest = this._turnProfile?.digest ?? '';
    // The temporary rung is NOT a constant of this backend, and treating it as
    // one made the cached base advertise `ask` by `role` on an actor whose
    // dispatch refuses it: a depth-capped subordinate wires no team deps at all
    // (`teamProfile`), so the rung is absent from its schema, its sandbox
    // namespace and its authoritative beforeTurn prompt. Read from the SAME fact
    // that path reads, and keyed, because depth is per-actor.
    const temporaryAsk = !delegationExhausted(this.delegationBudget());
    const key = `${this.getSoulText()}\u0000${execKey}\u0000${model.provider ?? ''}/${model.id ?? ''}\u0000${availableTools.join(',')}\u0000${agentsActions.join(',')}\u0000${profileDigest}\u0000${String(temporaryAsk)}`;
    let base: string;
    if (this._cachedSystemPrompt && this._cachedSystemPromptKey === key) {
      base = this._cachedSystemPrompt;
      this.logActivity("getsystemprompt_end", "cache hit");
    } else {
      // Always build the BASE prompt here — no turn-scoped state. The
      // authoritative per-turn prompt (skills, MCP tools, fresh device
      // status, change notice) is assembled in `beforeTurn` and ALWAYS
      // returned via TurnConfig.system, which overrides this one for chat
      // turns (Think calls getSystemPrompt() BEFORE beforeTurn()). Mixing
      // turn state in here would poison the cache across turns.
      base = buildSystemPromptSync(this.rt, {
        soulOverride: this.getSoulText(),
        executors: execs,
        availableTools,
        agentsActions,
        temporaryAsk,
        backend: 'cf',
        model,
      });
      this._cachedSystemPrompt = base;
      this._cachedSystemPromptKey = key;
      this.logActivity("getsystemprompt_end", `${base.length} chars`);
    }
    // BYTE-STABLE: no per-turn state rides here. The volatile half (facts,
    // executor status, device notice, skill activations) is appended to the
    // turn's MESSAGES in beforeTurn — see prompting/volatile-context.ts.
    return base;
  }

  /**
   * Compute a lightweight cache key from CraftStore + quality state. Quality
   * lives on the crafted_tools row itself (score/uses/last_used_at), and
   * effective-score filtering depends on recency — without MAX(last_used_at)
   * in the key, the cached ToolSet would keep re-using a stale score-filtered
   * view across turns even as usage shifts.
   */
  private _craftCacheKey(): string {
    const row = this.sql<{ cnt: number; latest: number; lastUsed: number }>`
      SELECT COUNT(*) as cnt, COALESCE(MAX(updated_at), 0) as latest,
             COALESCE(MAX(last_used_at), 0) as lastUsed
      FROM crafted_tools`[0] ?? { cnt: 0, latest: 0, lastUsed: 0 };
    return `${row.cnt}:${row.latest}:${row.lastUsed}`;
  }

  getTools(): ToolSet {
    // The Think chat loop's tool source (first hook called by _runInferenceLoop).
    // Returns the CHAT view = the raw surface + the auto-background wrap (#173).
    // Internal eval side-streams use getRawTools() instead, so a >30s tool run
    // inside a shadow-eval / scaffold / GEPA evaluation never detaches a job or
    // injects an unsolicited "job completed" turn into the user's chat.
    this._turnT0 = performance.now();
    this.logActivity("gettools_start");
    return this.wrapToolsForBackground(this.getRawTools());
  }

  /** The UNWRAPPED tool surface — built + cached. Shared by the chat path (via
   *  getTools, which adds the background wrap) and by internal eval side-streams
   *  that must run tools to completion inline (never auto-background). */
  protected getRawTools(): ToolSet {
    return this.getRawToolsForWorkMode(this.turnWorkMode());
  }

  protected getRawToolsForWorkMode(mode: WorkMode, claimScope?: string): ToolSet {
    const actorDeps = this.actorToolDeps();
    const profileKey = actorActiveTools(actorDeps).join(',');
    // Cache key includes CraftStore updated_at AND the crafted_tools quality
    // because effective-score filtering depends on recency. The actor profile
    // is turn-sensitive for subordinate reporting: an owner chat must never
    // reuse an assigned turn's upward-reporting surface.
    const cacheKey = `${mode}:${profileKey}:${this._craftCacheKey()}`;
    // The cache is the CHAT surface's. A scoped rollout's surface differs only
    // in the identity its effect claims key on and is asked for once per
    // rollout, so caching it would evict the surface every later turn wants for
    // a build nothing asks for twice.
    if (claimScope === undefined && this._cachedTools && cacheKey === this._cachedToolsKey) {
      return this._cachedTools;
    }
    this.logActivity("gettools_rebuilding", `${this._cachedToolsKey} → ${cacheKey}`);

    try {
      // No registry sync: PreambleCraftedExecutor reads craftStore.list()
      // fresh at every execute. See docs/CRAFT-ARCHITECTURE.md §3.

      const builtinDeps: Parameters<typeof buildActorTools>[0] = {
        rt: this.rt,
        // The once-only boundary for tools whose effects leave this object.
        // `turnId` is a closure because the toolset is cached across turns; the
        // checkpoint's turn id is the DURABLE id of the message this turn opened
        // on, which is what a recovery replays and a run id is not. A rollout
        // supplies its own recoverable identity instead — see
        // {@link makeScaffoldCallTool}.
        effectClaims: {
          sql: this.rt.storage.sql,
          turnId: claimScope === undefined
            ? () => this._turnCheckpoint?.turnId ?? WORKSPACE_RUN_ID
            : () => claimScope,
        },
        preBuiltExecuteTool: this.getExecuteToolsTool(mode, profileKey),
        // The turn's cumulative bulk budget lives on the accumulator, so the
        // cached toolset holds a stable reference across turns and the reset
        // rides the turn's own accounting.
        contextBudget: this.acc.context,
        // Same ownership: read-before-edit state and the per-edit outcome
        // counters ride the accumulator, so the cached toolset sees the turn's
        // ledger and the reset rides the turn's own accounting.
        fileLedger: this.acc.files,
        // Same turn-scoped ownership as fileLedger: the `run` dispatch records
        // each escalation decision here, and the settle spine above writes the
        // durable row.
        escalations: this.acc.escalations,
        // The unified `agents` delegation tool — fork substrate (heads / mcts
        // settle) is universal; hire/ask/send actions appear only when this
        // actor's profile wires the team/peers transports. Owner resolution
        // stays lazy per action, so the cached toolset stays valid across
        // claimOwner.
        agents: this.getAgentsToolDeps(mode),
        roleAuthority: () => this._turnProfileInputs?.envelope ?? null,
        // Vectorize-backed semantic memory. memory.search auto-uses
        // hybrid retrieval when this is provided + available; FTS5-only fallback.
        vectorStore: this.rt.vectorStore,
        // Typed, keyed world-model store — exposes the `fact` tool.
        facts: this.facts,
        // The remaining actor-profile dep: the subordinate report spine.
        // The release lane is codemode-only now (release.* — see
        // getExecuteToolsTool below), not a BuiltinToolDeps field.
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
      host: this,
      identity: async () => ({
        ownerUserId,
        capabilityToken: await this.workspaceCapabilityToken(),
        // The REGISTERED workspace, never this actor's own DO name — the file
        // plane is keyed by it, so a self-named head derives a second, empty
        // filesystem (unit-head-fork.test.ts).
        sharedParent: this.workspaceName(),
      }),
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
   * Run a tool-using node's loop in an `ExplorationAgent` facet.
   *
   * Undefined before the agent has an owner, for `getCFHeadRuntime`'s reason: a
   * facet reaches the owner's credentials as its workspace, so without an owner
   * there is nothing to attenuate. Undefined is not a failure here — an absent
   * host runs the same loop in this isolate.
   *
   * The arbiter is published under this node's id for the LIFE OF THE RUN and
   * withdrawn in `finally`, because that registration is the only route a facet
   * has back to a budget that exists solely in this isolate. Withdrawing it is
   * not tidiness: an entry that outlived its run would answer a later node
   * against a settled search, and `nodeArbitrate` refuses rather than granting
   * children nobody would create.
   *
   * A facet per node buys a storage boundary and a teardown verb, NOT
   * parallelism — `do.facet.cpu_shared` is the governing fact, so a wave of
   * hosted nodes serialises exactly as one isolate's `Promise.allSettled`
   * already did. No concurrency bound is imposed here because none is needed for
   * that reason: the width cap the search already enforces bounds how many
   * facets exist at once, and adding a second limiter would be one policy in two
   * places.
   */
  protected getCFNodeHost(): NodeLoopHost | undefined {
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) return undefined;
    return async (spec, arbitrate) => {
      const release = arbitrate
        ? this.registerNodeArbiter(spec.headInput.id, arbitrate)
        : null;
      try {
        const node = await spawnNodeFacet(this, spec, {
          ownerUserId,
          capabilityToken: await this.workspaceCapabilityToken(),
          // The PARENT's workspace, never this facet's own name: the file plane
          // is keyed by it, so a self-named node would derive a second, empty
          // filesystem — the regression unit-head-fork.test.ts pins.
          sharedParent: this.workspaceName(),
        });
        return await node.run();
      } finally {
        try {
          await this.cleanupNodeHome(spec.headInput.id);
        } finally {
          release?.();
        }
      }
    };
  }
  /** The parent-owned home provisioner. Its durable mapping survives a reset;
   * active work does not, because activity belongs to the live search/facet.
   *
   * The uid allocation is a row in the SAME database as the filesystem the home
   * is created in — `resolveHostedNodeHome` is only ever reached on the object
   * that owns the workspace — so two nodes cannot be handed one uid. */
  private _hostedNodeHomeProvisioner: NodeWorkspaceProvisioner | undefined;

  protected hostedNodeHomeProvisioner(): NodeWorkspaceProvisioner | undefined {
    if (!this.getOwnerUserId()) return undefined;
    this._hostedNodeHomeProvisioner ??= createNimbusNodeHomeProvisioner(
      this.ctx.storage.sql,
      this.workspaceBox(NODE_HOME_SHELL_ID),
    );
    return this._hostedNodeHomeProvisioner;
  }

  /** The facet-facing half: provision, then hand back the three things a facet
   *  rebuilds its runtime from. The shared-plane variant is REFUSED rather than
   *  unwrapped — a facet given a home with no credential would run as the origin
   *  under a private path, which is the one outcome worse than no home. */
  async resolveHostedNodeHome(
    nodeId: string,
    rootId: string,
    depth: number,
  ): Promise<HostedNodeHome> {
    const provision = this.hostedNodeHomeProvisioner();
    if (!provision) throw new Error('Hosted node home requires a claimed workspace owner');
    const workspace = await provision({ nodeId, rootId, depth });
    if (workspace.isolation !== 'private-home') {
      throw new Error(`Node ${nodeId} was provisioned without a credential; a hosted node cannot run on the shared plane`);
    }
    return { home: workspace.home, tmp: workspace.tmp, cred: workspace.cred };
  }

  private async cleanupNodeHome(nodeId: string): Promise<void> {
    if (!this.getOwnerUserId()) return;
    await cleanupNimbusNodeHome(this.workspaceBox(NODE_HOME_SHELL_ID), nodeId);
  }

  /**
   * The arbiters of searches running in THIS isolate right now, by node id.
   *
   * In memory and not a table, because that is what it is: a verdict is decided
   * against a live remaining-children count, so an entry outliving its wave would
   * be answering for a budget that no longer exists. A `Map` rather than a record
   * because the keys are minted ids and entries are added and deleted as waves
   * open and settle.
   */
  private readonly nodeArbiters = new Map<string, NodeArbiter>();

  /**
   * Arbitrate a HOSTED node's branch request, on behalf of the search that owns
   * the budget.
   *
   * Why this exists when `recordHeadStep` was reusable and this is not: a step is
   * a write to a table this actor holds, so any caller can perform it. A verdict
   * is a decision against a LIVE budget — the remaining-children count of a
   * search that is running right now, in this isolate — and that budget is not a
   * row anyone can read. So the arbiter registers itself here for the life of its
   * wave and this method is the route a facet reaches it by.
   *
   * Refuses rather than assumes when no arbiter is registered. A node whose
   * search has already settled must not be handed a grant nobody will honour: the
   * children would be reserved against a budget that is gone, and the node would
   * report having been given work the engine never created.
   *
   * TRACED as its own invocation, because that is exactly what it is: an RPC
   * INTO this object from a facet running elsewhere, and the node is blocked on
   * the answer. A node that stalls waiting for a verdict and a node that stalls
   * before asking for one are indistinguishable from the node's side and from
   * every row either writes.
   */
  async nodeArbitrate(nodeId: string, proposal: BranchProposal): Promise<BranchDecision> {
    return await this.tracing.invocation('rpc', 'swarm.arbitrate', async (_invocation, span) => {
      span.setAttribute('kinu.node_id', nodeId);
      const arbiter = this.nodeArbiters.get(nodeId);
      if (!arbiter) {
        // `budget-exhausted` rather than a sixth policy value: the vocabulary is
        // closed on purpose, and this IS that fact — a settled search has no
        // remaining children, so none can be reserved. The prose carries the
        // detail, and the prose is what the node reads.
        span.setAttribute('kinu.arbiter_registered', false);
        return {
          kind: 'refused',
          policy: 'budget-exhausted',
          error: 'The search that spawned this node is no longer arbitrating, so no branch can be '
            + 'reserved. Finish your own task and report.',
        };
      }
      span.setAttribute('kinu.arbiter_registered', true);
      const decision = await arbiter(proposal);
      span.setAttribute('kinu.decision', decision.kind);
      return decision;
    });
  }

  /**
   * Register a hosted node's arbiter for the life of its run, and return the
   * handle that unregisters it.
   *
   * A returned disposer rather than a second `unregister` call, because the two
   * MUST be paired: an entry that outlived its wave would answer a later node
   * against a settled budget, which is the exact failure the refusal above
   * describes and this shape makes hard to cause.
   */
  registerNodeArbiter(nodeId: string, arbiter: NodeArbiter): () => void {
    this.nodeArbiters.set(nodeId, arbiter);
    return () => { this.nodeArbiters.delete(nodeId); };
  }

  /**
   * The parent's recent conversation, handed to each spawned head so it sees
   * the full context. Capped to the last N messages to bound head LLM context
   * over long sessions (Think Session already compacts the table at the
   * orchestrator level; this is a second safety net for head spawns).
   */
  protected readInheritedContext(): SerializedMessage[] {
    // The agents SDK's session provider creates assistant_messages on its first
    // append, so an agent that has not run a turn has none. Asked directly:
    // catching instead made "no conversation yet" indistinguishable from a read
    // that blew up, and a head handed [] reports "I found nothing" rather than
    // "I could not see the parent" — the defect owners actually hit.
    if (!tableExists(this.boundSql, 'assistant_messages')) return [];
    type Row = { id: string; role: string; content: string; created_at: string };
    const rows = this.sql<Row>`
      SELECT id, role, content, created_at
      FROM (
        SELECT id, role, content, created_at
        FROM assistant_messages
        ORDER BY created_at DESC
        LIMIT ${INHERITED_CONTEXT_CAP}
      ) sub
      ORDER BY created_at ASC`;
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

    // No identity, no user-level tools: advertising descriptors the actor can
    // no longer dispatch just spends context on calls that will be refused.
    // Asked rather than caught: userCaller() throws only when no token has been
    // issued, and a real failure reading one must not silently empty the surface.
    if (!(await this.workspaceCapabilityToken())) return {};
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
      // An unreadable catalog is not the same thing as an unconfigured one, and
      // the only caller draws that line: `prepareTurn` catches this rethrow,
      // records `mcp.tool_surface_failed` and proceeds on builtins alone. The
      // failure travels WHOLE; the surface state here records what this turn
      // will actually advertise — none of it, by name.
      this._mcpUnavailable = [{
        source: 'MCP catalog',
        reason: 'The descriptor read failed. No MCP tool is available for this turn.',
      }];
      throw err;
    }
  }

  configureSession(session: Session): Session {
    // The agent's durable context is `getSystemPrompt()` (soul + tools) plus
    // the persisted conversation and the dynamic/turn-local context split —
    // a single source of truth, not Think's freezable context blocks. No
    // Session policy attaches here: compaction is the transformContext
    // extension (registerCompactionExtension), which rewrites the turn's
    // model-visible history without ever touching the stored messages.
    return session;
  }

  /** Resolved `<provider>/<modelId>` the next turn will actually use — the
   *  same resolution getModel() applies. Computing the threshold from the raw
   *  stored spec leaves an unset model on the generic context window instead
   *  of the resolved default model's real limit. Falls back to the raw spec
   *  only pre-claim (no provider registry yet). */
  private effectiveModelSpec(): string {
    const stored = this._turnProfile?.tier.model ?? this.getStoredModelId();
    try {
      return this.providerRegistry().normalizeSpecSync(stored);
    } catch (error) {
      diagnostics.event('actor.model_spec_unresolvable', { error: renderThrownChain({ cause: error }) });
      return stored ?? '';
    }
  }

  protected effectiveModelProviderFamily(): string {
    const spec = this.effectiveModelSpec();
    if (!spec) return '';
    return parseModelSpec(spec).provider;
  }

  /** Prompt model context from the RESOLVED spec. The raw stored id is null
   *  on default-configured agents, which used to leave model-family guidance
   *  inert on the primary hosted path — the same raw-spec class of bug
   *  effectiveModelSpec() fixed for the compaction threshold. */
  private promptModelContext(): PromptModelContext {
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
  private readonly modelCatalog = new ModelCatalogSession({
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
  // ACTIVE_TOOLS is sourced from @kinu.run/core/tools/registry (single truth).

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    // The scaffold and the soul are both files this turn is about to read, and
    // this is the first place with a promise to await them on.
    await this.ensureOwnedScaffold();
    if (this._cachedSoulText === null) await this.refreshSoulText();
    this._turnProfile = null;
    const profileInputs = await this.profileInputs();
    this._turnProfileInputs = profileInputs;
    const activeRoleId = this.activeRoleLabel();
    const roleSkills = effectiveRoleCatalog(profileInputs.envelope.catalog)[activeRoleId]?.skills ?? [];
    // Per-turn accounting reset + the turn's mission scope, together: what the
    // turn is allowed to spend is part of what the turn is.
    // The continuation flag resets mid-turn signal splice state: a continuation
    // turn re-absorbs the just-settled signals so they ride into it the way the
    // queued path's durable message does. Signals still waiting ride either way.
    this.orch.beginTurn(Date.now(), this.turnUserMetadata(), ctx.continuation);
    this._executorsUsedThisTurn.clear();
    const body = jsonObject(ctx.body);
    this._cliCwd = readCliCwd(body);
    this._turnContinuity = readTurnContinuity(body);
    this._inFlight = true;
    // The evolution gate, read WHERE THE TURN OPENS: core derives the same value
    // at `beginTurn`, and the recorded turn carries it so a recovering host's
    // own engine cannot re-judge a turn it did not run.
    this._turnEvolutionEnabled = this.turnRecordsEvolution();
    this._turnOriginContext = Object.freeze(structuredClone([...ctx.messages]));
    // Fresh splice coordinates for this streamText call. Steers already
    // buffered survive — they were typed for the turn that is about to run.
    this.userSteer.beginTurn();
    this.logActivity("beforeturn", "streamText() called next");
    // A real user message is the verdict on the previous turn — dispatch the
    // detached outcome review (Hermes-style forked background review). Runs
    // concurrently with this turn; never blocks it. Programmatic turns
    // (reactor / job wake) are not user verdicts.
    if (!this.lastUserTurnIsProgrammatic()) {
      this.orch.observeUserTurn(extractLastUserText(ctx.messages), this._turnContinuity);
    }
    // Start a new run for the event log, with provenance so cross-run history
    // (Supervise altitude) can show what kicked each run off. This is the chat
    // path → caused_by:'chat'; event-triggered runs set ingress_kind/trigger_id.
    this._currentRunId = `run-${nanoid()}`;
    // A new analytics write window. The platform caps writes per INVOCATION,
    // which is not a thing this code can observe from inside a Durable Object; a
    // TURN is, and it is the unit whose row count can actually run away (a turn
    // with two hundred tool calls writes four hundred rows). Opening it here
    // makes the cap bound the thing that can exceed it.
    openAnalyticsWindow(this.env);
    // Tag this turn for device-side file checkpoints: the user message id is
    // what the web turn card holds, so restore-by-turn resolves directly.
    {
      const userMessages = this.messages.filter((m) => m.role === 'user');
      const lastUserId = userMessages[userMessages.length - 1]?.id;
      this._turnCheckpoint = { turnId: lastUserId ?? this._currentRunId, sessionId: 'default' };
      this.ctx.storage.sql.exec(
        'INSERT INTO active_durable_turn (id, turn_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET turn_id = excluded.turn_id',
        this._turnCheckpoint.turnId,
      );
      // A reset loses UserSteerDrain RAM, never the acknowledged rows. This turn
      // may restore only its OWN steers; rows from a finished turn are handled by
      // terminal leftover routing, never spliced into a later conversation.
      const pending = this.sql<{ id: string; text: string }>`
        SELECT id, text FROM pending_steers WHERE turn_id = ${this._turnCheckpoint.turnId} ORDER BY seq ASC`;
      if (pending.length > 0) this.userSteer.restorePending(pending);
    }
    openTurnRun(this.eventRecorder, this._currentRunId, {
      agentId: this.name,
      causedBy: 'chat',
      userMessage: extractLastUserText(ctx.messages),
      turnIndex: this.orch.sessionTurnIndex,
    });

    await this.refreshInstructionApprovalAuthority();
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
      userText: extractLastUserText(ctx.messages),
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

    // Per-user MCP tools — fetched from UserDO, dispatched back via RPC.
    // Failure is non-fatal; the turn proceeds with builtins only and the UI
    // surfaces the broken-server status via /api/user/mcp/servers polling.
    //
    // `ctx.tools` is the actor's own surface, and it is handed over because the
    // remote catalog is admitted against what the step context limit has LEFT
    // after it — the builtins are not negotiable, so they are priced first.
    let mcpTools: ToolSet = {};
    try { mcpTools = await this.buildUserMcpTools(ctx.tools); }
    catch (err) {
      diagnostics.failure('mcp.tool_surface_failed', toKinuError({
        doing: 'building the user MCP tool adapters for this turn',
        cause: err,
        otherwise: 'unavailable',
      }));
    }

    const mcpToolNames = Object.keys(mcpTools);
    const extensionTools = Object.fromEntries(
      Object.entries(this.extensions.tools())
        .filter(([name]) => !(name in ctx.tools) && !(name in mcpTools)),
    );
    const extensionToolNames = Object.keys(extensionTools);
    const availableAgentActions = actorAgentsActions(turnActorDeps);
    // The turn's WHOLE nameable surface. `release` / `agent` / `llm` are
    // reachable only inside `execute_tools`, so no native tool id names them and
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
      explicitTier: readTurnTier(body) ?? this.config.getAssignedTier() ?? undefined,
    });
    this._turnProfile = profile;
    const workMode = profile.workMode;
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

    // ── Per-turn device awareness ────────────────────────────────
    // One authoritative hub check (a cheap DO-to-DO RPC) so the executor list
    // below reflects the CURRENT device state — the transport's TTL-cached
    // snapshot can lag a mid-session `kinu connect` by a turn. The persisted
    // watermark is only a diff anchor for the one-turn change notice; the hub
    // stays the single source of truth.
    let deviceNotice: string | null = null;
    try {
      const status = await this.rt.deviceTransport.refreshStatus();
      deviceNotice = observeDevicePresence(this.config, status).notice;
    } catch (err) {
      diagnostics.failure('device.status_refresh_failed', toKinuError({
        doing: 'refreshing the device hub presence for this turn',
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
      this.rt.executionRouter?.getProvider('sandbox') ?? undefined,
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
      workMode,
      provenance: this.turnProvenance(),
      roleSection: profile.role,
      planSubmissionAvailable: workMode === 'plan' && turnActorDeps.submitPlan !== undefined,
      model,
      currentDate: currentDateForPrompt(),
      // Prompt sections the evolution loop promoted. Read here, not inside the
      // builder: the builder is the byte-stable cacheable prefix and does no
      // I/O, exactly as with the soul.
      sectionOverrides: activePromptSectionOverrides(this.rt.storage.sql),
    };
    if (availableSkills.lines.length > 0) promptOptions.availableSkills = availableSkills;
    if (activeSetForPrompt) promptOptions.activeSkills = activeSetForPrompt;
    promptOptions.agentsMd = agentsMd;
    const systemOverride = buildSystemPromptSync(this.rt, promptOptions);
    this.recordSystemPromptHash(systemOverride);

    const cfg: TurnConfig = {
      system: systemOverride,
      model: this.ownedModelServices.resolveModel(profile.tier.model),
    };

    // The measured compaction trigger, read from the durable state by core in
    // the one correct order (orchestrator/turn-context.ts). Attachment
    // sanitization is per-part in-place replacement, so the raw count IS the
    // sanitized durable length — and it is stashed because
    // recordTurnTelemetry writes the next measurement against the same number.
    const rawMessages = this._cliCwd ? withCliCwdContext(ctx.messages, this._cliCwd) : ctx.messages;
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
    this._turnMemoryTail = await readMemoryTail(this.rt.memory);
    const turnLocalOptions: Parameters<typeof turnLocalContextMessage>[0] = { deviceNotice };
    if (this._turnActiveSkills) turnLocalOptions.activeSkills = this._turnActiveSkills;
    const turnLocal = turnLocalContextMessage(turnLocalOptions);
    // The unapproved half of the two instruction sources the system prompt just
    // rendered. Those bytes are agent-writable, so they ride one sealed user
    // message ahead of the turn-local tail instead of the system plane; null
    // when every discovered file was approved.
    const unverified = unverifiedInstructionsMessage(
      activeSetForPrompt ? { agentsMd, activeSkills: activeSetForPrompt } : { agentsMd },
    );
    // The shared turn-context assembly (core orchestrator/turn-context.ts) —
    // the SAME ordering runChat runs on the CLI: attachment sanitize →
    // extension onTurnStart → awaited transformContext (compaction, over the
    // DURABLE history only) → turn-local tail. Dynamic context is NOT assembled
    // here: it is re-read and re-woven at every step by beforeStep.
    const assembly: Parameters<typeof assembleTurnMessages>[0] = {
      system: systemOverride,
      history: rawMessages,
      attachments: {
        accepts: this.sessionAcceptedMedia(), vfs: this.rt.storage.vfs, budget: this.acc.context,
      },
      extensions: this.extensions,
      turnLocal: [
        ...(unverified ? [unverified] : []),
        ...(turnLocal ? [turnLocal] : []),
      ],
      sessionKey: this.name,
      contextWindow: this._turnContextWindow,
      trigger: measured.trigger,
    };
    if (measured.providerReportedTokens !== undefined) {
      assembly.providerReportedTokens = measured.providerReportedTokens;
    }
    const submittedTools = { ...ctx.tools, ...effectiveTools };
    const admissionModel = parseModelSpec(profile.tier.model);
    const providers = this.providerRegistry();
    assembly.admission = {
      count: (request) => countRequestInputTokens(
        providers.registry.get(admissionModel.provider), admissionModel.modelId, providers.deps, request,
      ),
      // Think filters the merged surface by activeTools before submission.
      // Count that exact subset: including inactive workspace tools inflates
      // the request while omitting native active tools undercounts it.
      tools: Object.fromEntries(
        effectiveActiveTools.flatMap((name) => {
          const entry = submittedTools[name];
          return entry === undefined ? [] : [[name, entry]];
        }),
      ),
      limits: { contextWindow: this._turnContextWindow, modelOutputLimit: this.modelCatalog.modelOutputLimit() },
    };
    cfg.messages = await assembleTurnMessages(assembly);

    if (Object.keys(effectiveTools).length > 0) cfg.tools = effectiveTools;
    cfg.activeTools = effectiveActiveTools;

    // Prompt-cache plan for this turn — the same core derivation `runChat`
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
    this._turnCachePlan = hasCacheMarkers(cachePlan.strategy)
      ? { strategy: cachePlan.strategy, system: cachePlan.system }
      : null;
    const cacheOptions = cachePlan.providerOptions;
    const reasoningOptions = reasoningEffortOptions(
      profile.tier.reasoningEffort,
      parseModelSpec(profile.tier.model).provider,
    );
    const providerOptions = mergeProviderOptions(cacheOptions, reasoningOptions);
    if (providerOptions) cfg.providerOptions = providerOptions;

    // THE TURN'S STEP BOUND, on the config Think actually consumes.
    //
    // `UNBOUNDED_STEPS` used to be set on `_lastTurnOpts` alone — a mirror only
    // the shadow-eval replay reads, and only ever for its `messages` and
    // `tools`. So the one place the words "unbounded steps" appeared in this
    // backend was a field the live loop never sees, and `git grep maxSteps --
    // packages/cf-backend/src` returned nothing at all. Reading either was
    // enough to conclude the cloud loop was unbounded. It was capped at ten.
    //
    // `maxSteps` is the lever: Think resolves `config.maxSteps ?? this.maxSteps`
    // and OR-s `stepCountIs(...)` of it ahead of anything the caller passes.
    // `stopWhen` rides beside it so the caller's slot is declared where the live
    // config is assembled — a future real stop condition composes here, and a
    // grep for the name now lands on the loop instead of the mirror.
    cfg.maxSteps = UNBOUNDED_MAX_STEPS;
    cfg.stopWhen = UNBOUNDED_STEPS;

    // Shadow-eval context parity + the evolved-scaffold task source (see the
    // _lastTurnOpts field doc): the effective opts the streamText Think runs
    // next will see — final system/messages/merged tools/model. Think only
    // adds its tool-decision wrapping and, per step, the cache markers and the
    // dynamic-context block — all inert for a replay.
    const lastTurnOpts: Parameters<typeof streamText>[0] = {
      model: cfg.model ?? ctx.model,
      system: systemOverride,
      messages: cfg.messages,
      tools: { ...ctx.tools, ...cfg.tools },
      activeTools: cfg.activeTools,
    };
    if (providerOptions) lastTurnOpts.providerOptions = providerOptions;
    this._lastTurnOpts = lastTurnOpts;
    // The turn's constants for the per-step context breakdown. Tool schemas
    // ride every request of the turn and are otherwise invisible to anyone
    // asking where the window went.
    this.acc.composition.openTurn({ system: systemOverride, tools: this._lastTurnOpts.tools });
    return cfg;
  }

  /** The in-flight turn's prompt-cache plan — set in beforeTurn, non-null only
   *  for marker strategies (Anthropic / OpenRouter-Claude), whose breakpoints
   *  beforeStep re-rolls onto the newest tail each step. */
  private _turnCachePlan: { strategy: PromptCacheStrategy; system: string | SystemModelMessage } | null = null;

  /** The in-flight turn's resolved context window — set in beforeTurn, read
   *  by beforeStep's prune budget every step. */
  protected _turnContextWindow = 0;
  private _turnOriginContext: readonly ModelMessage[] = [];

  /** The bounded MEMORY.md tail read at turn assembly — the one dynamic-context
   *  input behind an await, so the per-step snapshot closes over it. */
  private _turnMemoryTail: string | undefined;

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
  protected dynamicContextSnapshot(): DynamicContext {
    const extras = this.extraDynamicContext();
    return collectDynamicContext({
      rt: this.rt,
      stores: this.stores,
      memoryTail: this._turnMemoryTail,
      missingCapabilities: [
        ...this._mcpUnavailable,
        ...(extras.extraMissingCapabilities?.() ?? []),
      ],
      subordinateDelegates: () => this.subordinateDelegates(),
      approvals: extras.approvals,
    });
  }

  beforeStep(ctx: PrepareStepContext): StepConfig | void {
    // The shared step pipeline (core prompting/prepare-step.ts, identical on
    // the CLI): extension prepareStep rewrites first, step-boundary tool-output
    // pruning against the window budget next, then the dynamic-context weave,
    // then the replay re-key for the provider about to receive this request,
    // then the cache plan rolls the tail breakpoints onto the FINAL message
    // array so each request of the agentic loop reads the prefix the previous
    // step wrote.
    //
    // `destinationProviderId` is read here rather than stashed by `beforeTurn`,
    // from the same synchronous resolution the cache plan reads: the
    // destination is a property of the request being composed, and a per-turn
    // mirror of it would be a second place for the answer to be stale.
    return composePrepareStep({
      extensions: this.extensions,
      cache: this._turnCachePlan,
      destinationProviderId: this.promptModelContext().provider,
      prune: this._turnContextWindow > 0
        ? {
          contextWindow: this._turnContextWindow,
          modelOutputLimit: this.modelCatalog.modelOutputLimit(),
        }
        : null,
      budget: this.budget,
      dynamic: { ledger: this.dynamicLedger, snapshot: () => this.dynamicContextSnapshot() },
      meter: this.acc.composition,
    }, { stepNumber: ctx.stepNumber, messages: ctx.messages });
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

  onChunk(_ctx: ChunkContext): void {
    // Time to first token, read before the accumulator latches its flag: this is
    // the last moment the answer to "was this the first chunk" is still yes.
    //
    // Measured from the turn's own start, so it is USER-VISIBLE first token on
    // whatever provider served it — not a transport first byte, which excludes
    // SDK parsing and only exists on one of the two transports.
    if (!this.acc.firstChunkSeen && this.acc.startedAt > 0) {
      recordTtftRow(this.env, {
        workspace: this.workspaceName(),
        agentKind: this.actorKind(),
        ...this.analyticsModel(),
        ttftMs: Date.now() - this.acc.startedAt,
      });
    }
    this.acc.onFirstChunk();
  }

  /** Whether the in-flight turn was injected programmatically (an event drain,
   *  a background-job wake, an overflow retry) — a queued signal stamps
   *  kinuEvent metadata on the saved user message; real chat messages carry
   *  none. */
  protected lastUserTurnIsProgrammatic(): boolean {
    return this.turnUserMessageEvent(null) !== null;
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
    const programmatic = this.turnUserMessageEvent(this._activeProgrammaticUserMessage) !== null;
    return programmatic || this._turnContinuity === 'independent_task' ? 'one-shot' : 'interactive';
  }

  /** The synthetic drain turn this turn is answering, off the DURABLE metadata
   *  of the message that drove it. The same stamp `SignalDelivery` writes for
   *  every queued signal, read back — so a drain that crossed an eviction on
   *  the submission ledger still knows which batch it owes a reply to. */
  private turnDrainTurnId(): string | undefined {
    const metadata = this.turnDrivingMetadata();
    return v.is(v.string(), metadata?.drainTurnId) ? metadata.drainTurnId : undefined;
  }

  /** The turn's kinuEvent metadata value — from the active programmatic
   *  message when one drove the turn, else the last durable user message.
   *  Null for real chat turns. */
  protected turnUserMessageEvent(programmaticUserMessage: { metadata?: unknown } | null): string | null {
    const metadata = programmaticUserMessage ? programmaticUserMessage.metadata : this.turnUserMetadata();
    const parsed = v.safeParse(JsonObjectSchema, metadata);
    if (!parsed.success) return null;
    return v.is(v.string(), parsed.output.kinuEvent) ? parsed.output.kinuEvent : null;
  }

  /** What the turn may do. Plan is explicit user intent on the driving
   * message; everything else is ordinary unconstrained work. */
  protected turnWorkMode(): WorkMode {
    return workModeForTurnMetadata(this.turnDrivingMetadata());
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
    if (!this._activeProgrammaticUserMessage) return this.turnUserMetadata();
    const parsed = v.safeParse(JsonObjectSchema, this._activeProgrammaticUserMessage.metadata);
    return parsed.success ? parsed.output : undefined;
  }

  /** What this turn was started BY: the metadata on the message that drives it
   *  — a signal's `kinuEvent` / `signalId` / mission labels, or nothing at
   *  all for a chat turn the operator typed. */
  protected turnUserMetadata(): JsonObject | undefined {
    const source = this.messages.filter(m => m.role === 'user').at(-1);
    if (!source) return undefined;
    const parsed = v.safeParse(JsonObjectSchema, source.metadata);
    return parsed.success ? parsed.output : undefined;
  }

  async beforeToolCall(ctx: ThinkToolCallContext): Promise<void> {
    // Extension observation before the tool's execute runs (returning void =
    // allow with the original input — the seam observes, it does not gate).
    await this.extensions.emitToolCall({
      toolName: ctx.toolName,
      args: jsonObject(ctx.input),
    });
  }

  async afterToolCall(ctx: ToolCallResultContext): Promise<void> {
    // Think 0.4 shape (toolName/input/output/success/durationMs) → the core
    // accumulator records it + fires the activity log + run-event sinks.
    const input = jsonObject(ctx.input);
    const recorded: Parameters<TurnAccumulator['recordToolCall']>[0] = {
      toolName: ctx.toolName,
      input,
      durationMs: ctx.durationMs,
      success: ctx.success,
    };
    if (ctx.success && ctx.output !== undefined) recorded.output = projectJsonValue({ value: ctx.output });
    if (!ctx.success) recorded.error = ctx.error;
    this.acc.recordToolCall(recorded);
    await this.extensions.emitToolResult({
      toolName: ctx.toolName,
      args: input,
      // Same shape the CLI seam emits: the FULL stringified result. The turn
      // steering hashes this as the call's identity and reads it to decide
      // failure, so a head slice made two different outputs sharing a long
      // preamble indistinguishable and hid every >1000-char structured error.
      result: String(ctx.success ? ctx.output ?? '' : ctx.error ?? ''),
      success: ctx.success,
    });
  }

  onStepFinish(ctx: StepContext): void {
    // The SDK seam. Two things are read here and nowhere else: the provider's
    // usage dialect, normalized once so everything downstream speaks `Usage`,
    // and the getter-backed fields of the SDK's StepResult — `text`,
    // `toolCalls` and `toolResults` live on its PROTOTYPE (ai
    // dist/index.js:3964-3994), so handing the object on by spread would drop
    // them and the step would log as empty.
    this.acc.recordStep({
      text: ctx.text,
      finishReason: ctx.finishReason,
      toolCalls: ctx.toolCalls,
      toolResults: ctx.toolResults,
      usage: normalizeUsage(ctx.usage),
      response: ctx.response,
    });
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

  /** The device-request channel the `execute_tools` call now running was armed
   *  with, or null outside one. */
  private _activeDeviceRequests: DeviceRequestChannel | null = null;

  /**
   * Publish the per-invocation device-request channel for the duration of one
   * `execute_tools` call.
   *
   * A codemode script issues device execs for as long as it runs — including
   * after its call has detached into a background job — and the channel is what
   * carries the owning job into each of those execs. It cannot be a construction
   * argument: `createExecuteToolsTool` builds its provider namespaces once per DO
   * lifetime, while the channel belongs to one invocation.
   *
   * Applied INSIDE the background wrap, because the wrap is what arms the bag:
   * core's wrapper reads the options, arms the channel, and calls this. Restored
   * rather than cleared on the way out, so a nested or inline call cannot inherit
   * a finished invocation's owner. The raw surface is untouched — the eval
   * side-streams share that object and must stay unwrapped.
   */
  private publishDeviceRequestChannel(raw: ToolSet): ToolSet {
    const entry = raw[EXECUTE_TOOLS_TOOL];
    const exec = entry?.execute;
    if (entry === undefined || exec === undefined) return raw;
    return {
      ...raw,
      [EXECUTE_TOOLS_TOOL]: {
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
  protected async routingProfile(): Promise<ResolvedTurnProfile> {
    return resolveRoutingProfile({
      live: () => this._turnProfile,
      resolve: async () => resolveAgentTurnProfile({
        ...(await this.profileInputs()),
        activeRoleId: this.activeRoleLabel(),
        workMode: this.turnWorkMode(),
        availableTools: [],
        activeSkills: [],
        explicitTier: this.config.getAssignedTier() ?? undefined,
      }),
    });
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
   * Wrap every chat turn in a recovery fiber, so an interrupted turn resumes
   * after eviction with nobody watching.
   *
   * Set EXPLICITLY, and as a class field rather than in `onStart`, for two
   * separate reasons the SDK states. It defaults to `true` today, and a default
   * is not a decision: every owner turn and every subordinate turn on this
   * substrate depends on it, so it is declared here rather than inherited. And
   * the SDK evaluates recovery budgets on every wake — it may seal an
   * interrupted turn before `onStart` runs — so a value assigned there would
   * arrive after the recovery it was meant to configure.
   */
  override chatRecovery = true;

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
  protected async maintenanceWork(): Promise<boolean> { return false; }

  /** Every budgeted activation sweep this actor owns; a subclass with more
   *  tables overrides and folds its own in. Answers whether ANY pass filled
   *  its budget — the caller arms the wake on true. */
  /** Detached work this actor owns until its lexical error boundary settles. */
  protected readonly _backgroundTasks = new Set<AsyncTaskOwner>();

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

  protected maintenanceSweeps(): boolean {
    return this.sweepUnrecoverableFiberRows();
  }

  /**
   * No stall watchdog, stated as a value rather than left to a default.
   *
   * The watchdog measures the gap between UI-message-stream chunks, and no
   * chunks flow while a server-side tool runs — so any finite value is a
   * wall-clock bound on a TURN wearing a transport timeout, and this project
   * does not bound a turn by elapsed time (core/src/chat.ts: a turn runs until
   * its work is done, the caller cancels it, or the provider or a tool fails
   * definitively). A hung provider is caught by the same recovery path above,
   * which is bounded by attempts rather than by seconds.
   */
  override chatStreamStallTimeoutMs = 0;

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
      appendMemory: (path, text) => this.rt.memory.append(path, text),
      armOwedTerminalRecovery: () => this.terminal.armOwedRecovery(),
      deliverSignal: (signal) => this.orch.signals.deliver(signal),
      redrive: (lane, checkpoint, body) => this.redriveRecoveredLane(lane, checkpoint, body),
    };
  }

  /** Detached lane re-drives this activation dispatched and still owns — the
   *  same ownership every detached chain in this class has, so a re-drive is a
   *  task something holds rather than a floating promise. One entry per DISPATCH
   *  rather than per lane: a single scan can offer two rows of one lane, and each
   *  carries its own checkpoint. */
  private readonly _laneRedrives = new Set<AsyncTaskOwner>();

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
   */
  protected redriveRecoveredLane(
    lane: string, checkpoint: JsonValue, body: () => Promise<void>,
  ): void {
    const owner: AsyncTaskOwner = { promise: null };
    this._laneRedrives.add(owner);
    owner.promise = (async () => {
      try {
        // The SDK's protected stash wrapper writes `initialSnapshot` in the
        // SAME synchronous prefix as the row insert — so there is no window in
        // which a reset finds a recoverable lane with a null payload. The
        // public `runFiber` has no such option; this seam exists for exactly
        // this composition.
        await this._runFiberWithStashWrapper(lane, async () => { await body(); }, {
          initialSnapshot: checkpoint,
        });
      } catch (cause) {
        diagnostics.failure('fiber.lane_redrive_failed', toKinuError({
          doing: `re-driving the "${lane}" lane an interruption left behind`,
          cause,
          otherwise: 'unavailable',
        }), { workspace: this.name, lane });
      } finally {
        this._laneRedrives.delete(owner);
      }
    })();
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
  // agents). The orchestrator no longer stores, refreshes, or even reads
  // raw credentials — providers resolve auth headers through the UserDO
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
