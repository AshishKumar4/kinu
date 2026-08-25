/**
 * LocalAgentSession — the local backend's realization of the Kinu agent loop.
 *
 * The cf-backend runs the agent inside a @cloudflare/think Durable Object; this
 * is its peer for a local Bun process. It owns the SAME core orchestration
 * (AgentOrchestrator: per-turn accounting, session-evolution cadence, the
 * event→turn reactor) plus background jobs over a durable local fiber — and
 * implements the BackendHost seam so all of that is wired identically to the DO.
 *
 * Both CLI frontends (the readline REPL and the @opentui/react TUI) drive ONE of
 * these via send()/end() and render its SessionEvent stream, so the turn logic
 * lives here once instead of being duplicated per frontend.
 */

import {
  generateText, stepCountIs,
  type LanguageModel, type ModelMessage, type ToolSet,
} from 'ai';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  createCompactionExtension, createVfsTranscriptStore,
  createCompactionStateStore, createModelSummarizer,
  type CompactionStateStore,
} from '@kinu.run/compaction';
import type {
  ChatOptions, ChatEvent,
  CompletedTurn, TurnContinuity, FiberCtx,
  LLM, ModelCallSink, ModelRouteResolution,
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult, PromptFile,
  SkillsVfs, ActiveSkillSet, TurnSkillSurface, FactsStore, KinuExtension,
  HeadRuntime, HeadGrounding, SerializedMessage, AgentConfigStore, ShellApprovalMode,
  ShellApprovalRequest, ShellApprovalOutcome, RequestShellApproval,
  AgentsForkDeps, AgentsToolDeps, TeamToolDeps, PeersToolDeps,
  IngressDescriptor, KinuEvent, EventVariant, MissingCapability,
  RunEvent, RunEventInput, RunEventQuery, StepLike,
  ReleaseStore, ReleaseToolDeps, BuiltinToolName,
  FileCheckpoints, FileCheckpointListing, FileRestorePlan, FileRestoreResult,
  CheckpointAvailability,
  WorkMode,
} from '@kinu.run/core';
import {
  AgentOrchestrator,
  type TurnSteering,
  createAgentStores, type AgentStores, collectDynamicContext,
  type BackgroundJobStore, BackgroundJobRunner, type TaskListStore,
  wrapToolsForBackground, BACKGROUNDABLE_TOOLS, resumeBackgroundJob, harvestBackgroundJob,
  BACKGROUND_POLICY, type BackgroundPolicy,
  type MctsSearchStore,
  EventLog, ReplyChannelStore,
  type RunEventRecorder,
  TriggerRegistry,
  // Ingress — core owns the gates; this session owns the local clock and the
  // process boundary in front of them.
  acceptWebhookDelivery, registerDurableWebhook, createWebhookSecretStore,
  initWebhookRateLimitTables,
  createTimerTrigger, cancelTrigger, listTriggers, fireDueTriggers,
  EvolutionEngine,
  readMemoryTail,
  listProposedTasks, updateProposedTaskStatus,
  agentsActionsFor,
  type HeadJournal, reconcileInterruptedForks,
  jobRedriveResumeGate, resumableForkRoots,
  skillsVfsOver, resolveTurnSkills, filterToolSetBySkills, renderFactsForTurn,
  inheritedContextFromHistory,
  ModelCatalogSession,
  BUILTIN_TOOL_NAMES, isMcpToolKey,
  buildActorTools, withClampedToolResults, buildSystemPromptSync, currentDateForPrompt,
  type ActorToolsetDeps,
  activePromptSectionOverrides,
  turnProvenanceForMetadata, workModeForTurnMetadata,
  runChat, estimateTokens, INTERRUPTED_TURN,
  parseModelSpec, agentAffinityKey,
  OVERFLOW_RETRY_EVENT,
  openTurnRun, closeTurnRun, snapshotCompletedTurn, creditedTurnId,
  classifyRunEnd, type RunEndFacts, type RunEndReason,
  normalizeUsage,
  persistMeasuredPromptTokens, applyOverflowRecovery, measureCompactionTrigger,
  CompletionGate, observeCompletionState, completionGateText, COMPLETION_GATE_EVENT,
  runAdvisorLane,
  PROGRAMMATIC_MESSAGE_ID_PREFIX, stampTurnAuthor,
  type JsonObject,
  ExtensionHost, UserSteerDrain,
  STEER_METADATA_KEY, STEER_STEP_METADATA_KEY, describeLandedSteers,
  type UserSteer, type SteerStatusDetail, type SteerStatusEvent,
  createDefaultWebSearchProvider, createWebCodemodeProvider, createRLMProvider, type WebSearchProvider,
  createAgentsCodemodeProvider, createReleaseCodemodeProvider, type CodemodeProvider,
  createMemoryCodemodeProvider, createTasksCodemodeProvider,
  createReportCodemodeProvider, REPORT_TOOL, type ReportToolDeps,
  MissionGovernor,
  DynamicContextLedger, turnLocalContextMessage, observeSystemPromptHash,
  type DynamicContext,
  type MediaModality,
  createReleaseStore, initReleaseTables, releaseSqlFromExec,
  initWorkspaceBaselineTable, initWorkspaceSchema,
  // The scaffold evolution control plane — core owns the drivers; this session
  // supplies the local surface they run against.
  applyScaffoldDecision, createLlmJsonJudge, getShadowStatus, listGepaRuns, listScaffoldVersions,
  previewScaffoldLive, proposeScaffold, runScaffoldGepaOptimization, runScaffoldOnce,
  queueTurnShadowTrial, runQueuedShadowTrials,
  type GepaOptimizationResult, type GepaRunSummary, type ScaffoldControl,
  type ScaffoldDecisionResult, type ScaffoldReplayContext, type ScaffoldVersionView,
  type ShadowStatus,
  listReplayEvals, type ReplayEvalSummary,
  revertChangelogEntryById, type ChangelogRevertResult,
  claimAlternateTakesForTurn, purgeUnclaimedAlternateTakes, latestAlternateTakeSet,
  getCurrentScaffoldVersion,
  scaffoldChatTransform, type ScaffoldRunOptions,
  bootstrapScaffold,
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  type AlternateTakeSet, type TakePickOutcome,
  startBranchHead, settlePendingBranches, newBranchId,
  type PendingBranch, type BranchStatusEvent,
  type AlarmScheduler, type BackgroundJob, type SqlExec,
  type TimerTrigger, type TimerTriggerOpts, type TriggerView,
  type WebhookDelivery, type WebhookDeliveryResult, type WebhookSecretStore,
  reasoningEffortOptions,
  BUILTIN_PROFILE_CATALOG, TIER_IDS, effectiveRoleCatalog,
  changeActiveRole, agentsProfileContext, canonicalConversationId,
  resolveAgentTurnProfile, resolveModelRoute,
  buildModelCallEvent,
  applyWorkspaceTitle, planWorkspaceTitle, suggestWorkspaceTitle,
  isPlaceholderMission, readMission, type WorkspaceTitleState,
  roleChangeOutcomeText, narrowToolSurface, codemodeCapabilitiesFor,
  readSoul,
  type ProfileCatalogEnvelope, type ProviderCatalogSnapshot,
  type ResolvedTurnProfile, type TierId,
  decodeJsonValue, projectJsonValue,
  createAgentSelfProvider,
  // ── Read models: the same implementations the cloud backend's RPCs call ──
  cancelBackgroundJob, jobResult, listBackgroundJobs,
  getAlwaysActiveSkills, getReasoningEffort, getShellApprovalMode, getStoredModelSpec,
  getShellApprovalGrants, revokeShellApprovalGrants, gatedGrants, type ApprovalGrant,
  setAlwaysActiveSkills, setModel, setReasoningEffort, setShellApprovalMode,
  getEvolutionChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
  type EvolutionChangelogView,
  getRunEvents, listRuns, type RunListEntry, type Page, type PageRequest,
  WORKSPACE_RUN_ID,
  recordModelOperations, type ModelOperationSink,
} from '@kinu.run/core';
import { diagnostics, KinuError, renderThrownChain, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { makeSqlExec, type CLIRuntime } from './runtime';
import { discoverAgentsMd } from './agents-md';
import { createNodeCraftedExecute } from './craft-executor';
import { createNodeExecuteToolFactory } from './execute-tools-factory';
import { createCLIHeadRuntime } from './head-runtime';
import { detectOrphanedFibers } from './fiber';
import { connectMcpServers, type McpServerConfig } from './mcp';
import type { LocalModelResolver } from './model-resolver';
import {
  STATIC_MODEL_SPEC, resolverModelPlane, staticModelPlane,
  type LocalProfileAuthority, type ProfileAuthorityRefinement, type ProfileEnvelopeSource,
} from './profile-authority';


/**
 * The head of a transcript that could not be restored whole.
 *
 * A restore bounded by the context window can still leave older turns behind
 * on a long-lived session. Saying so is the difference between an agent that
 * knows it is reading the tail of its own conversation and one that believes
 * the conversation started there — and the session store is still queryable,
 * so the notice names where the rest is rather than only that it is gone.
 */
function olderHistoryNotice(omitted: number, sessionId: string): ModelMessage {
  return {
    role: 'user',
    content:
      `[Runtime note — written by the Kinu harness, not by the user.]\n\n`
      + `${omitted} earlier message${omitted === 1 ? '' : 's'} from this session `
      + `are not in your context: the transcript is longer than this model's context window, `
      + `so it was restored from the newest end. They are not lost — they are in this `
      + `workspace's local session store under session id "${sessionId}", readable with your `
      + `normal tools. Say so rather than guessing if something earlier in the conversation matters.`,
  };
}

/** A turn's inference, replayable outside the turn that ran it: everything
 *  runChat needs except the two things that belong to one live turn only —
 *  its abort signal and its extension host. */
type LiveTurnOpts = Omit<ChatOptions, 'signal' | 'extensions'>;

type ToolCallArguments = Extract<ChatEvent, { type: 'tool-call' }>['args'];
type PromptCacheIdentity = NonNullable<ChatOptions['cache']>;

/**
 * Per-message AGGREGATE cap on raw attachment bytes inlined into a chat message
 * as data-URL file parts, for agents running on THIS backend.
 *
 * The cloud backend's cap (CLOUD_MAX_INLINE_ATTACHMENT_BYTES, 1 MiB) exists
 * because of `do.sqlite.row_bytes`, and a local session has no such limit:
 * messages go
 * into bun:sqlite, which stores a blob far larger than any attachment worth
 * inlining. What does bind here is the provider request — an inlined part is
 * base64 (4/3 × raw) inside a JSON body that is re-sent on EVERY later turn of
 * the conversation, since the attachment stays in the transcript. So the number
 * is chosen against request size and repeat cost, not storage: 8 MiB raw ≈ 11 MB
 * on the wire, comfortably inside the request-body limits of the providers the
 * local backend can reach, and eight times what a cloud agent accepts.
 *
 * Anything larger stays a path reference, which locally is the better answer
 * anyway: the agent's fs tools read the real file, at full fidelity, on demand.
 */
export const LOCAL_MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** The minimal bun:sqlite handle the EventsHub SqlExec adapter needs. */
export type LocalSessionDb = Pick<Database, 'prepare'>;

// The spec a session with no `modelResolver` reports for its one model lives
// with the plane that answers it (profile-authority.ts); it is re-exported
// below because callers of this module name it.

/** What the frontends render. A superset of runChat's ChatEvent with the
 *  lifecycle + side-channel (evolution, broadcast, background) events. */
export type SessionEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: ToolCallArguments }
  | { type: 'tool-result'; toolName: string; toolCallId: string; result: string; success: boolean }
  | { type: 'turn-end'; turn: CompletedTurn }
  | { type: 'error'; message: string }
  | { type: 'evolution'; event: string; message: string }
  | { type: 'broadcast'; event: BroadcastEvent }
  /** One durable run-event, forwarded live as the recorder writes it. The
   *  run_events table is the agent's instrumentation ledger (nudges, context
   *  budget, refused budgets); a container-scoped database dies with the
   *  container, so the stream is the only way an outside observer sees it. */
  | { type: 'run-event'; event: RunEvent };

/** An interactive answer to a gated shell command. Resolving null declines to
 *  decide, leaving the standing approval mode's own answer in force. */
export type ShellApprovalHandler =
  (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>;

export interface LocalPublishEventInput {
  descriptor: IngressDescriptor;
  now?: number;
  caused_by?: string;
}

export interface LocalPublishEventResult {
  event_id: string;
  admitted: boolean;
}

export interface LocalDurableWebhook {
  trigger_id: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret: string | null;
}

export interface LocalAgentSessionOpts {
  rt: CLIRuntime;
  /** Raw bun:sqlite handle — backs the EventsHub SqlExec adapter. */
  db: LocalSessionDb;
  /** The ai-SDK chat model runChat drives on a STATIC session — one built
   *  without a modelResolver. Required there; with a resolver, turns resolve
   *  through the registry and this is only the pre-claim fallback. */
  model?: LanguageModel;
  /** Optional provider-style resolver. */
  modelResolver?: LocalModelResolver;
  /** Canonical role/tier authority for this local agent, read live. */
  profileAuthority?: ProfileEnvelopeSource;
  /**
   * This machine's provider-configuration revision, read live — a counter every
   * credential connected, revoked or signed in advances.
   *
   * It exists because the provider listing is invalidated by SIGNAL and never
   * by elapsed time, and the one signal a long-lived session cannot see is a
   * mutation made by ANOTHER PROCESS: `kinu provider connect` runs in its own
   * process while a daemon or a chat session stays resident, so nothing in this
   * process is there to call {@link LocalAgentSession.refreshProviderListing}.
   * A number in the canonical config crosses that boundary; comparing it at
   * every resolution is what turns a file edit into the missing signal.
   *
   * Absent means nobody is publishing one, and the listing is then invalidated
   * only from inside this process — correct for a fixture, and for a session
   * whose credentials cannot change under it.
   */
  providerRevision?: () => number;
  onEvent: (event: SessionEvent) => void;
  /** Disable auto-evolution (turn + session reflection). Default: enabled. */
  noAutoEvolve?: boolean;
  /** This process runs ONE task turn and exits (`kinu exec`/`kinu run`).
   *  Two consequences, both about honesty rather than throttling:
   *    • the next invocation's prompt is NOT a conversational follow-up, so it
   *      never grades the previous turn (it would read as `accepted`);
   *    • the cadence-heavy evolution pass is not started here, because this
   *      process cannot finish it — the durable window carries the turns to
   *      the local scheduler daemon instead.
   *  Default false: the REPL, TUI and daemon are all long-lived. */
  oneShot?: boolean;
  /** Working directory for AGENTS.md discovery and the prompt's runtime
   *  context. Defaults to the runtime's own bound plane, so the directory the
   *  agent reads project instructions from is the directory its `file` tool and
   *  its shell work in. Only a runtime with no bound plane falls back to the
   *  process's own directory. */
  cwd?: string;
  /** How long a tool call may run before it is moved to the background, and how
   *  long teardown waits on work that has not settled. Fixed by the surface that
   *  opened the session (BACKGROUND_POLICY). Default: the interactive policy. */
  backgroundPolicy?: BackgroundPolicy;
}

const TurnTierMetadataSchema = v.object({
  profile_tier: v.optional(v.picklist(TIER_IDS)),
});

function tierFromMetadata(metadata: ProgrammaticTurn['metadata']): TierId | undefined {
  if (metadata === undefined) return undefined;
  const parsed = v.safeParse(TurnTierMetadataSchema, metadata);
  return parsed.success ? parsed.output.profile_tier : undefined;
}

interface QueueItem {
  text: string;
  /** Attachments for a user turn — forwarded to the model as file parts. */
  files?: ReadonlyArray<PromptFile>;
  metadata?: ProgrammaticTurn['metadata'];
  /** The producer's name for the fact this programmatic turn announces. The
   *  durable row's id is derived from it, so a re-announcement collides with
   *  the row the first one wrote (see `persist`). */
  idempotencyKey?: string;
  kind: 'user' | 'programmatic';
  /**
   * Settle whoever queued this item — exactly once, and told whether the turn
   * RAN.
   *
   * A refusal is the driver lease saying another process owns this
   * conversation, which means this turn did not happen. That has to reach the
   * producer, because the producer is the only one who can put things back: an
   * event drain has rows bound to a turn nobody will run, and a person has a
   * message that was never sent. Reporting a refused item as a completed one
   * (this used to be a bare success-only `resolve()`) loses the event and
   * discards the message in silence.
   */
  settle: (refusal: Refusal | null) => void;
}

type CurriculumStatus = 'pending' | 'accepted' | 'rejected' | 'completed';

export class LocalAgentSession implements BackendHost {
  private readonly rt: CLIRuntime;
  private readonly fallbackModel: LanguageModel | null;
  private readonly modelResolver: LocalModelResolver | null;
  private cachedModel: LanguageModel | null = null;
  private cachedModelSpec: string | null = null;
  private tools: ToolSet = {};
  /** The UNWRAPPED tool surface (no 30s background threshold). The turn path
   *  uses `tools`; job resume runs the raw tool so a re-drive can't detach a
   *  second job (the DO's getRawTools). */
  private rawTools: ToolSet = {};
  private readonly toolSets: Partial<Record<WorkMode, { raw: ToolSet; wrapped: ToolSet }>> = {};
  private readonly engine: EvolutionEngine;
  private readonly orch: AgentOrchestrator;

  /** The per-turn mechanical-steering ledger — what fired at which step and
   *  what came of it. A read-only named view; the orchestrator owns writes. */
  get steering(): TurnSteering {
    return this.orch.steering;
  }

  /** The stores every agent has, from core — one list both backends inherit.
   *  The named fields below are its members, kept as fields because the call
   *  sites reach them by name. */
  private readonly stores: AgentStores;
  private readonly jobs: BackgroundJobStore;
  /** The agent's own task list — the `tasks` tool writes it, the live context
   *  block reads it. */
  private readonly taskList: TaskListStore;
  private readonly jobRunner: BackgroundJobRunner;
  /** Durable MCTS search checkpoint — what makes an interrupted think(mcts)
   *  resumable instead of losing its whole budget. runMCTS creates the table
   *  on first use. */
  private readonly mctsSearchStore: MctsSearchStore;
  private readonly factsStore: FactsStore;
  private readonly config: AgentConfigStore;
  private readonly eventLog: EventLog;
  /** Durable per-run event log (run_events) — parity with the DO's recorder. */
  private readonly eventRecorder: RunEventRecorder;
  /** The actor's cumulative, label-scoped spend governor (opt-in). Public so
   *  the `agent.*` self-direction namespace declares and reads budgets through
   *  the same object the two enforcement seams hold. */
  readonly budget: MissionGovernor;
  /** The run the in-flight turn belongs to; null between turns. */
  private currentRunId: string | null = null;
  /**
   * Where every non-turn model call in this workspace reports what it cost.
   *
   * The turn loop's own spend reaches this same log as `step_finish`. The judge,
   * the fast tier, the reflection seam and the heads' merge synthesis are
   * invisible to that row, and each of them used to drop the provider's usage on
   * the line that received it — so a workspace total read off `step_finish`
   * alone was the orchestrator's turns while looking like it was everything.
   *
   * The row itself — usage always present, `usd` only when the rate belongs to
   * the model that served the call — is built by core, because it was built
   * twice and the two copies disagreed about exactly that field.
   */
  private readonly modelCallSink: ModelCallSink = (report) => {
    const event = buildModelCallEvent(report, {
      effectiveSpec: this.effectiveModelSpec(),
      pricing: this.modelCatalog.pricing(),
    });
    // Half of these producers fire BETWEEN runs — an evolution pass on a fiber,
    // a workspace title before the first turn exists — and the log is keyed by
    // run, so those calls are filed under the reserved workspace run rather than
    // dropped. Dropping them is the dishonesty this row type exists to remove.
    this.recordRunEvent(event, this.currentRunId ?? WORKSPACE_RUN_ID);
  };

  /**
   * Where this session's direct model operations record their start and end —
   * the same log as `modelCallSink`, projected through core's one shared
   * mapper. A start row with no end names the operation a dead process left
   * in flight; nothing here reads a clock.
   */
  private readonly modelOperations: ModelOperationSink = recordModelOperations(
    { emit: (runId, input): void => { this.recordRunEvent(input, runId); } },
    () => this.currentRunId ?? WORKSPACE_RUN_ID,
  );
  private readonly triggerRegistry: TriggerRegistry;
  /** Durable reply sinks for the events this session admits — the same table
   *  and TTLs the cloud backend writes, with no dispatcher in front of them:
   *  a local session has no socket, mail or peer transport to answer over. */
  private readonly replyChannels: ReplyChannelStore;
  /** Where this workspace's webhook secrets live. */
  private readonly webhookSecrets: WebhookSecretStore;
  /** The positional-binding handle the hub stores share (bun:sqlite adapter). */
  private readonly hubSql: SqlExec;
  private readonly releases: ReleaseStore;
  private _webSearchProvider: WebSearchProvider | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledAlarmAt: number | null = null;
  private ended = false;
  /** Branching-heads runtime — local heads run in-process over isolated
   *  ephemeral runtimes. */
  private _headRuntime: HeadRuntime;
  private readonly onEvent: (event: SessionEvent) => void;
  private shellApprovalHandler: ShellApprovalHandler | null = null;
  private turnProfile: ResolvedTurnProfile | null = null;
  private turnProfileInputs: {
    envelope: ProfileCatalogEnvelope;
    provider: ProviderCatalogSnapshot;
  } | null = null;
  private readonly sessionId: string;
  /** True when this process runs one task turn and exits — see the `oneShot`
   *  option. Decides turn continuity and whether the cadence lane may start. */
  private readonly oneShot: boolean;
  /** The mechanical completion gate (core completion-gate.ts). Armed only by a
   *  one-shot task turn: on the interactive surface the human reading the
   *  answer is the check, so it never arms and costs nothing. */
  private readonly completionGate = new CompletionGate();
  /** Whether a message arriving in THIS process can be a verdict on the turn
   *  before it. A one-shot process holds no conversation: its prompt came from
   *  a caller who never saw the previous answer. */
  private get turnContinuity(): TurnContinuity {
    return this.oneShot ? 'independent_task' : 'conversation';
  }
  private readonly cwd: string;
  private readonly history: ModelMessage[] = [];
  private turnWorkMode: WorkMode = 'build';
  /** Whether the message driving THIS turn came from this agent's parent
   *  rather than from whoever is chatting with it. A parent assignment is
   *  admitted as an event and drains as a programmatic turn, so the turn's own
   *  kind is the fact — and it is what gates the `report` surface. */
  private turnIsParentAssigned = false;

  /** Dynamic-context blocks for this CLI session (core volatile-context.ts),
   *  re-read and re-woven at every model step by the shared step pipeline.
   *  In-memory only — a new session starts empty, so the first step attaches
   *  exactly one fresh block. The compaction extension's onOutcome resets it
   *  whenever the model-visible stream changed shape ('planned'/'invalidated')
   *  because the frozen block positions are meaningless against a rewritten
   *  stream; byte-stable replays keep them valid. */
  private readonly dynamicLedger = new DynamicContextLedger();

  /** The head journal this session's controller writes to — also the live fork
   *  roster the per-step dynamic context reads. */
  private readonly headJournal: HeadJournal;

  /** Durable per-session compaction state (plan snapshot + the measured
   *  prompt-token trigger signal) in agent.db, and the default compaction
   *  extension itself — the SAME better-compact transformContext path the
   *  cloud backend registers, over the same shared stores. Registered on
   *  every turn's ExtensionHost in processTurn. */
  private readonly compactionState: CompactionStateStore;
  private readonly compactionExtension: KinuExtension;

  private skillsVfs: SkillsVfs | null = null;

  /** Tools from connected MCP servers, merged into the turn surface. Connected
   *  lazily via connectMcp; closed on end. */
  private extraTools: ToolSet = {};
  private mcpClose: (() => Promise<void>) | null = null;

  /** FIFO of turns to run — user inputs + programmatic injects (reactor / job
   *  wake), drained by a single serialized pump so turns never interleave. */
  private readonly queue: QueueItem[] = [];
  private pumping = false;
  /** The active pump run's completion, or null when idle — the awaitable
   *  settleBackgroundWork() joins so a one-shot run can wait for wake turns. */
  private pumpPromise: Promise<void> | null = null;
  /** The in-flight turn's abort handle — interrupt() aborts it. */
  private currentAbort: AbortController | null = null;
  /** Mid-turn steers awaiting the next step boundary — the shared core
   *  drain, whose USER semantics (persist verbatim, hand back on interrupt,
   *  rerun as a user-origin turn) both backends now get from one place.
   *
   *  `onDrain` is the moment a steer stops being queued and becomes something
   *  the model has, and both halves of saying so hang off it: the live
   *  `steer_status` every open surface renders from, and the step index the
   *  durable row is stamped with. */
  private readonly userSteer = new UserSteerDrain({
    turnInFlight: () => this.pumping,
    onDrain: (steers, atStep) => this.recordLandedSteers(steers, atStep),
  });
  /** The steers this turn's drains actually delivered, with the step each
   *  landed at — what `persist` writes the durable rows from. Reset per turn
   *  by `beginTurn`, so a row is never stamped with a previous turn's index. */
  private landedSteers: Array<{ id: string; text: string; atStep: number }> = [];
  /** Steer-as-Branch redirects launched against the in-flight turn — each runs
   *  as one budgeted head and settles into Alternate Takes at turn end. */
  private pendingBranches: PendingBranch[] = [];

  constructor(opts: LocalAgentSessionOpts) {
    this.rt = opts.rt;
    this.onEvent = opts.onEvent;
    this.oneShot = opts.oneShot === true;
    this.cwd = opts.cwd ?? this.rt.cwd ?? process.cwd();
    this.fallbackModel = opts.model ?? null;
    this.modelResolver = opts.modelResolver ?? null;
    this.rt.setModelForRoute?.((resolution) => this.localRouteLlm(resolution));

    // A session with neither a resolver nor a static model has no brain; the
    // failure belongs at the first use that needs one, named for that use.
    if (!opts.model && !this.modelResolver) {
      throw new Error(
        'No model for this session: construct it with a modelResolver or a static model.'
      );
    }

    // The cumulative spend governor — a scheduled run or a fork opts into a
    // label, and its refusals land in this run's durable event log. No label
    // means no cap, which is every ordinary session.
    this.budget = new MissionGovernor({
      storage: this.rt.storage,
      // Real USD: the catalog rates for whatever model the next turn resolves
      // to. Null until the lookup lands — the ledger then blends, and says so.
      pricing: () => this.modelCatalog.pricing(),
      onExhausted: ({ error: _error, ...refusal }) =>
        this.recordRunEvent({ type: 'budget_exhausted', ...refusal }),
    });
    this.engine = new EvolutionEngine(this.rt, {
      enabled: !opts.noAutoEvolve,
      // The turn review's own model calls debit the mission the reviewed turn
      // ran under — the same ledger, through the same seam, as the work it
      // reviews. Unbudgeted turns never reach it.
      governor: this.budget,
      // Replay-eval rollout: the current system prompt (lessons/facts/soul) +
      // model, tools disabled. Unlike the DO's sandboxed scaffold rollout, a
      // local re-run with tools would re-execute shell work on the user's
      // machine and can block on shell approvals — so CLI replay measures the
      // prompt/model config, not tool trajectories.
      replayTaskRunner: (task) => this.runReplayTask(task),
      shadowTrialQueue: (turn) => queueTurnShadowTrial(this.scaffoldControl, turn),
      // The trial itself runs on the cadence lane. A resolved gate changes the
      // live scaffold under us, so the session's model-bound state is dropped
      // and the decision is surfaced like any other self-change.
      shadowTrialRunner: async () => {
        const drain = await runQueuedShadowTrials(this.scaffoldControl);
        if (drain.applied) {
          this.emit({
            type: 'evolution',
            event: drain.applied === 'promote' ? 'scaffold_promotion' : 'scaffold_rollback',
            message: `Shadow eval ${drain.applied}d the pending scaffold after ${drain.trials} trial(s)`,
          });
          this.invalidateModelState();
        }
        return drain;
      },
    });
    this.engine.onEvent((e) => this.emit({ type: 'evolution', event: e.type, message: e.message }));

    // Every table a workspace has, on any backend — one list, in core. A
    // session can be constructed against a database that no open path touched
    // (a benchmark harness, `kinu exec` on a fresh clone), so it runs here
    // too rather than trusting an earlier caller.
    const hubSql = makeSqlExec(opts.db);
    initWorkspaceSchema({ execRaw: this.rt.storage.execRaw, sql: this.rt.storage.sql, exec: hubSql });
    initWorkspaceBaselineTable(this.rt.storage.execRaw);

    // The stores every agent has, from core — one list both backends inherit.
    // Background-job lifecycle rides the durable local fiber (createLinuxFiber)
    // with this session as the BackendHost (enqueueTurn wakes the agent).
    this.stores = createAgentStores(() => this.rt.storage.sql);
    const stores = this.stores;
    this.jobs = stores.jobs;
    this.taskList = stores.taskList;
    this.headJournal = stores.headJournal;
    this.mctsSearchStore = stores.mctsSearchStore;
    this.config = stores.config;
    this.sessionId = canonicalConversationId(this.config);
    // The runtime already resolves profiles — that is what makes a session-less
    // workspace routable. What a session adds is a RICHER set of inputs to the
    // same authority: a provider registry that can list an account, the caller's
    // catalog authority, and a durable log for the resolution evidence. Refining
    // rather than installing a second resolver is what keeps a routed lane and a
    // turn on one answer.
    const refinement: ProfileAuthorityRefinement = {
      plane: this.modelResolver
        ? resolverModelPlane(this.modelResolver, opts.providerRevision)
        : staticModelPlane(),
      record: (event) => { this.recordRunEvent(event); },
    };
    if (opts.profileAuthority) refinement.envelope = opts.profileAuthority;
    // Not optional-chained: a runtime with no authority cannot resolve a model
    // for anything, and saying so here costs one line where saying it at the
    // first lane costs a turn.
    this.profiles().refine(refinement);
    this.factsStore = stores.facts;
    this.eventRecorder = stores.eventRecorder;

    // Better-compact is THE default (and only) compaction path — the same
    // staged transformContext ladder the cloud backend registers, over the
    // same shared stores (transcripts in the canonical VFS, plan + trigger
    // state in agent.db). The summarizer rides the session's active model.
    this.compactionState = createCompactionStateStore(this.rt.storage.sql);
    this.compactionExtension = createCompactionExtension({
      ports: {
        // The plane the agent's own `file` tool reads, because a compacted
        // range's transcript path is CITED to the model and has to be readable
        // back (compaction/extension.ts's citablePath contract). Every spill
        // under `.kinu/` is on this plane for the same reason; what moves to the
        // private plane is what the agent IS, not what it can be told to read.
        transcripts: createVfsTranscriptStore(() => this.rt.storage.vfs),
        plans: this.compactionState.plans,
        // `@better-compact/core`'s `Logger` requires all four levels, so none can be
        // dropped as scaffolding. `info`/`debug` go through `event`, NOT through
        // `failure` with an invented code: `failure` demands a classification
        // precisely so a failure line cannot omit which kind it was, and stamping
        // `unavailable` on a debug line would put that code into every
        // failure-rate read. The `data` argument is an object nobody looked
        // inside — `message` is the whole scalar fact, so it rides as a field.
        logger: {
          info: (message) => { diagnostics.event('compaction.info', { message }); },
          debug: (message) => { diagnostics.event('compaction.debug', { message }); },
          warn: (message) => { diagnostics.failure('compaction.degraded', new KinuError('unavailable', message)); },
          error: (message) => { diagnostics.failure('compaction.failed', new KinuError('io', message)); },
        },
      },
      archive: this.compactionState.archive,
      // The sink the summarizer already accepts, finally passed — see the same
      // call on the cloud actor. Without it `compaction` was a declared
      // SPEND_SOURCE that could never appear in the panel.
      summarize: createModelSummarizer(() => this.ensureModelState(), {
        source: 'compaction', report: (report) => this.modelCallSink(report),
      }),
      // The ladder's first rung prunes this plane before any tool output.
      ephemeral: this.dynamicLedger,
      onOutcome: ({ outcome }) => {
        // Fires inside runTransformContext, BEFORE the turn's first step
        // weave — a fresh plan ('planned') or a discarded one ('invalidated')
        // invalidates the frozen block positions; a byte-stable replay
        // keeps them.
        if (outcome !== 'replayed') this.dynamicLedger.reset();
      },
    });

    const headRuntimeOptions: Parameters<typeof createCLIHeadRuntime>[0] = {
      model: () => this.cachedModel ?? this.defaultModel("a head with no model of its own"),
      providerFamily: parseModelSpec(STATIC_MODEL_SPEC).provider,
      // A static session has ONE model, so this constant IS its spec. On a
      // resolver session it is the wrong label: the head runs on `model` above,
      // whatever `cachedModelSpec` resolved, and its calls are reported as the
      // static spec regardless. `effectiveModelSpec()` is the honest answer for
      // both fields, but `providerFamily` is a value read once at construction
      // rather than a callback, so the two move together or not at all.
      reportModelCall: (report) =>
        this.modelCallSink({ ...report, spec: STATIC_MODEL_SPEC }),
      operations: this.modelOperations,
      parentRuntime: this.rt,
      webSearch: this.getWebSearchProvider(),
      codemodeExtras: () => this.headCodemodeExtras(),
      grounding: this.buildHeadGrounding(),
      governor: () => this.budget,
      journal: () => this.headJournal,
    };
    // Per-fork models only mean something where a resolver exists; a static
    // model session has one model and every fork inherits it, as before.
    if (this.modelResolver) {
      const modelResolver = this.modelResolver;
      headRuntimeOptions.resolveModel = (spec) => modelResolver.resolveModel(spec);
    }
    this._headRuntime = createCLIHeadRuntime(headRuntimeOptions);

    // The EventsHub substrate (reactor source of truth). Local external
    // ingresses enter through publishEvent(), then drain via AgentOrchestrator.
    // The release board is the one local-only plane: on cf it lives in
    // the owner's UserDO (core/conformance/manifest.ts records that).
    initReleaseTables(hubSql);
    this.releases = createReleaseStore(releaseSqlFromExec(hubSql), {
      validateAgentName: (name) => {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('invalid agent name');
      },
    });
    this.eventLog = new EventLog(hubSql);
    const alarmScheduler: AlarmScheduler = {
      // Synchronous here: the local host's wake-up is a process timer, not a
      // storage write, so there is nothing to await. The seam returns a promise
      // because the cloud host's arm is a Durable Object write that must land
      // inside its invocation (`do.wait_until.no_op`).
      scheduleAt: async (ts) => { this.scheduleLocalAlarm(ts); },
      currentAlarm: () => this.scheduledAlarmAt,
    };
    this.triggerRegistry = new TriggerRegistry(hubSql, alarmScheduler);
    this.replyChannels = new ReplyChannelStore(hubSql);
    this.hubSql = hubSql;
    this.webhookSecrets = createWebhookSecretStore(hubSql);
    // Webhook + inbound-email deliveries count against a per-minute window
    // (core events/ingress/rate-limit.ts), which needs its table at boot.
    initWebhookRateLimitTables(hubSql);

    // The durable per-run event log (run_events) — the same recorder, table and
    // RunEvent union the cloud backend records, over local SQLite — is written…
    // …and forwarded to the frontends as it is written. The table alone is
    // observable only to something that outlives the database, which a
    // benchmark container or a one-shot `kinu exec` does not.
    this.eventRecorder.observe((event) => this.emit({ type: 'run-event', event }));

    this.orch = new AgentOrchestrator({
      host: this,
      engine: this.engine,
      eventLog: this.eventLog,
      budget: this.budget,
      oneShot: opts.oneShot === true,
      roleCatalog: () => this.turnProfileInputs
        ? Object.keys(effectiveRoleCatalog(this.turnProfileInputs.envelope.catalog))
        : undefined,
      sinks: {
        onToolCallEvent: (ev) => this.recordRunEvent({ type: 'tool_call_end', ...ev }),
        onStepEvent: (ev) => this.recordRunEvent({ type: 'step_finish', ...ev }),
      },
    });
    this.rt.setTurnFileLedgerProvider?.(() => this.orch.acc.files);
    // The runtime's judge / fast / reflection seams were built before this
    // session existed (createCLIRuntime), so this is the moment their reports
    // find a ledger. A runtime holds ONE sink: the live session's, exactly as it
    // holds one turn file ledger and one approval channel.
    this.rt.setModelCallSink?.(this.modelCallSink);
    this.rt.setModelOperations?.(this.modelOperations);
    this.jobRunner = new BackgroundJobRunner({
      store: this.jobs,
      policy: () => opts.backgroundPolicy ?? BACKGROUND_POLICY.interactive,
      fiber: (name, fn) => this.trackFiber(name, fn),
      signals: this.orch.signals,
      eventLog: this.eventLog,
      scheduleDrain: () => this.orch.scheduleDrain(),
      logActivity: (event, detail) => this.emit({ type: 'evolution', event, message: detail ?? '' }),
      // Process exit is the local analogue of a DO eviction: re-drive an
      // interrupted job from its durable checkpoint instead of failing it.
      resume: (kind, input, mode, signal) => this.resumeBackgroundJob(kind, { value: input }, mode, signal),
      // What a bounded-out job already produced. Same predicate as `resume`, so a
      // side-effecting kind has nothing partial to read and a SEARCH does — the case
      // that used to settle empty over candidates it had really measured.
      harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
        { sql: this.rt.storage.sql, ledger: this.mctsSearchStore }, kind, input,
      )),
    });
    // Scaffold cold-start heal (the DO's onStart parity): a workspace created
    // before scaffold bootstrap landed has no scaffold/agent.js, and
    // engine.maybeEvolveScaffold returns early when it is absent — silently
    // disabling the WHOLE scaffold-evolution loop on that workspace forever.
    // bootstrapScaffold is idempotent (exists-check + INSERT OR IGNORE v0);
    // tracked so end()/settleEvolution joins it before the process exits.
    this.orch.track(bootstrapScaffold(this.rt), 'Scaffold bootstrap');
    this.restoreHistory();
    this.ensureModelState();
    this.rearmLocalAlarm();
  }

  /** Tool names for the banner (built-ins + connected MCP). */
  toolNames(): string[] {
    this.ensureModelState();
    return [...Object.keys(this.tools), ...Object.keys(this.extraTools)];
  }

  /** Built-in + MCP tools with descriptions for the /tools view. */
  describeTools(): Array<{ name: string; description: string }> {
    this.ensureModelState();
    return Object.entries({ ...this.tools, ...this.extraTools }).map(([name, t]) => ({
      name, description: t.description ?? '',
    }));
  }

  /** Skills pinned always-active for this agent (the `/always` command). */
  getAlwaysActiveSkills(): string[] { return getAlwaysActiveSkills(this.config).names; }
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void { setAlwaysActiveSkills(this.config, names); }

  /**
   * Shadow-git file checkpoints (newest first) with the store's reachability, so
   * a caller cannot read an empty list as "this turn changed nothing" — the
   * store may simply not be configured, or git may be missing.
   *
   * `turnId` narrows IN THE STORE. A caller after one turn must pass it rather
   * than filter a window itself: retention is per working directory and the
   * limit is global, so a self-filtered window silently drops turns whose
   * checkpoints still exist. See FileCheckpoints.list.
   */
  async listFileCheckpoints(limit?: number, turnId?: string): Promise<FileCheckpointListing> {
    const availability = await this.checkpointStatus();
    if (!availability.available || !this.rt.checkpoints) return { availability, entries: [] };
    return { availability, entries: await this.rt.checkpoints.list({ limit, turnId }) };
  }

  async planFileRestore(dir: string, id: string): Promise<FileRestorePlan> {
    return this.requireCheckpoints().plan(dir, id);
  }

  async restoreFileCheckpoint(dir: string, id: string): Promise<FileRestoreResult> {
    return this.requireCheckpoints().restore(dir, id);
  }

  checkpointStatus(): Promise<CheckpointAvailability> {
    return this.rt.checkpoints?.status()
      ?? Promise.resolve({ available: false, reason: 'checkpoints are not configured for this session' });
  }

  private requireCheckpoints(): FileCheckpoints {
    if (!this.rt.checkpoints) throw new Error('checkpoints are not configured for this session');
    return this.rt.checkpoints;
  }

  getShellApprovalMode(): { mode: ShellApprovalMode } {
    return getShellApprovalMode(this.config);
  }

  setShellApprovalMode(mode: ShellApprovalMode): ReturnType<typeof setShellApprovalMode> {
    return setShellApprovalMode({ config: this.config, onChanged: () => this.rebuildToolSurface() }, mode);
  }

  /** Every rule the owner has said "always" to, and where. The revoke list. */
  getShellApprovalGrants(): { grants: ApprovalGrant[] } {
    return getShellApprovalGrants(this.config);
  }

  /** Take a standing grant back. Read live by the gate, so the next command
   *  of that kind asks again — no rebuild, no restart. */
  revokeShellApprovalGrants(grants: ApprovalGrant[]): { ok: boolean; grants: ApprovalGrant[] } {
    return revokeShellApprovalGrants(this.config, grants);
  }

  /** Install the interactive approval channel for gated shell commands, or
   *  null to remove it. Surfaces that own a live user (ACP) set this; without
   *  one, 'strict' keeps rejecting gate hits with its explanatory message.
   *  Wired straight onto `rt.setShellApprovalChannel` — the SAME channel
   *  `rt.shell` and every `rt.executionRouter` provider consult, so an
   *  approval answers `run` and every registered codemode executor's `exec()`
   *  call identically. Returns a disposer so
   *  a surface can detach on disconnect. */
  setShellApprovalHandler(handler: ShellApprovalHandler | null): () => void {
    this.shellApprovalHandler = handler;
    this.rt.setShellApprovalChannel?.(handler ? this.wrapShellApprovalHandler(handler) : null);
    return () => {
      if (this.shellApprovalHandler === handler) {
        this.shellApprovalHandler = null;
        this.rt.setShellApprovalChannel?.(null);
      }
    };
  }

  /**
   * `allow_always` is remembered here rather than in the gate, because the
   * session owns the config store the grant lives in.
   *
   * It used to switch the whole agent to `allow_all` — one click on one
   * `sudo` prompt and every gated command everywhere, on the owner's laptop
   * included, ran unasked for the rest of the session. Now it grants exactly
   * the rules that were asked about, on the executor they were asked about
   * (safety/approval-gate.ts's ApprovalGrant), which is what the button says
   * it does. Revocable from the same config plane that reads it.
   */
  private wrapShellApprovalHandler(handler: ShellApprovalHandler): RequestShellApproval {
    return async (req) => {
      const outcome = await handler(req) ?? null;
      if (outcome === 'allow_always') {
        this.config.grantShellApproval(gatedGrants(req.review, req.executor));
      }
      return outcome;
    };
  }

  /** Stored model spec, or null when unset (parity with DO getStoredModelSpec). */
  getStoredModelSpec(): { spec: string | null } {
    return getStoredModelSpec(this.config);
  }

  /** Effective normalized model spec used for new turns. */
  getEffectiveModelSpec(): string {
    return this.turnProfile?.tier.model ?? this.profiles().normalizeSpec(this.config.getModel());
  }

  getActiveRoleId(): string {
    return this.turnProfile?.role.id ?? this.config.getActiveRoleId();
  }

  getEffectiveTierId(): string {
    if (this.turnProfile) return this.turnProfile.tier.id;
    const roleId = this.config.getActiveRoleId();
    return effectiveRoleCatalog(BUILTIN_PROFILE_CATALOG)[roleId]?.tier ?? 'default';
  }

  /**
   * Change the durable active role. Takes effect on the NEXT resolved turn —
   * `runTurn` re-reads `config.getActiveRoleId()` every time, so there is no
   * cache to invalidate here and the running turn keeps the profile it already
   * resolved (core profiles/role-change.ts:1-5). Clearing the memo instead
   * would mutate a turn that had already resolved its model and tools, and
   * clearing it before the outcome check did that even for a change that never
   * landed.
   */
  async setRole(roleId: string): Promise<{ role: string }> {
    const envelope = await this.profiles().envelope();
    const changed = changeActiveRole({
      config: this.config,
      envelope,
      to: roleId,
      actor: 'user',
    });
    if (changed.kind !== 'applied') {
      throw new Error(roleChangeOutcomeText(roleId, changed, this.config.getActiveRoleId()));
    }
    return { role: changed.to };
  }

  /** Validate + store a new model spec. Effective on the next turn and for new
   *  think/head runs, matching the DO backend's setModel behavior. */
  setModel(spec: string): ReturnType<typeof setModel> {
    return setModel({
      config: this.config,
      normalize: (s) => this.profiles().normalizeSpec(s),
      onChanged: () => this.rebuildToolSurface(),
    }, spec);
  }

  getReasoningEffort() {
    return { effort: this.turnProfile?.tier.reasoningEffort ?? getReasoningEffort(this.config).effort };
  }

  setReasoningEffort(
    effort: Parameters<typeof setReasoningEffort>[1],
  ): ReturnType<typeof setReasoningEffort> {
    return setReasoningEffort(this.config, effort);
  }

  /** Drop the model-bound state and rebuild it now, so a config change is
   *  visible to the very next turn rather than at the next resolve. */
  private rebuildToolSurface(): void {
    this.invalidateModelState();
    this.ensureModelState();
  }

  listModelProviders() {
    return this.modelResolver?.listProviders() ?? Promise.resolve([]);
  }

  listAvailableModels() {
    return this.modelResolver?.listModels() ?? Promise.resolve({ models: [], failures: [] });
  }

  /** Local ingress parity with the DO EventsHub routes: publish through the
   *  append-only EventLog, then wake the same serialized turn queue (debounced,
   *  so an event burst drains as ONE programmatic turn). */
  async publishEvent(input: LocalPublishEventInput): Promise<LocalPublishEventResult> {
    const { id, admitted } = this.eventLog.publish({
      descriptor: input.descriptor,
      now: input.now ?? Date.now(),
      caused_by: input.caused_by,
    });
    this.orch.scheduleDrain();
    return { event_id: id, admitted };
  }

  pendingEvents(limit = 50): KinuEvent[] {
    return this.eventLog.pending({ limit });
  }

  listRecentEvents(opts: { variant?: EventVariant; since?: number; limit?: number } = {}): KinuEvent[] {
    return this.eventLog.query(opts);
  }

  listTriggers(): { triggers: TriggerView[] } {
    return listTriggers(this.triggerRegistry);
  }

  cancelTrigger(trigger_id: string): ReturnType<typeof cancelTrigger> {
    const result = cancelTrigger(this.triggerRegistry, trigger_id, Date.now());
    this.rearmLocalAlarm();
    return result;
  }

  async createTimerTrigger(opts: TimerTriggerOpts): Promise<TimerTrigger> {
    return await createTimerTrigger(this.triggerRegistry, opts, Date.now());
  }

  /** The local clock's half of timer ingress: fire what is due, then re-arm
   *  the process timer that will call this again. */
  async fireDueTriggers(now = Date.now()): Promise<{ fired: number; nextAlarmAt: number | null }> {
    if (this.ended) return { fired: 0, nextAlarmAt: null };
    if (this.scheduledAlarmAt !== null && this.scheduledAlarmAt <= now) this.clearLocalAlarm();
    const { fired } = await fireDueTriggers({ registry: this.triggerRegistry, log: this.eventLog }, now);
    if (fired > 0) this.orch.scheduleDrain();
    this.rearmLocalAlarm();
    return { fired, nextAlarmAt: this.scheduledAlarmAt };
  }

  /**
   * Register a webhook trigger on this local workspace.
   *
   * A local session has no inbound HTTP transport, so it mints no URL: what
   * this creates is the trigger and its secret, and {@link acceptWebhookDelivery}
   * is the door a transport in front of it delivers through.
   */
  async createDurableWebhook(opts: {
    label: string;
    auth_mode: 'hmac' | 'bearer' | 'mtls';
    secret?: string;
    accepted_content_type?: string;
    rate_limit_per_min?: number;
  }): Promise<LocalDurableWebhook> {
    const now = Date.now();
    const webhook = await registerDurableWebhook(this.triggerRegistry, opts, now);
    if (opts.secret) this.webhookSecrets.put(webhook.secret_id, webhook.trigger_id, opts.secret, now);
    return {
      trigger_id: webhook.trigger_id,
      auth_mode: webhook.auth_mode,
      secret: opts.secret ?? null,
    };
  }

  /** Gate one webhook delivery and publish it — the same content-type pin,
   *  HMAC/bearer/mTLS verification, replay window and rate limit the cloud
   *  backend applies, because both call the one implementation. */
  async acceptWebhookDelivery(opts: WebhookDelivery): Promise<WebhookDeliveryResult> {
    return acceptWebhookDelivery({
      triggers: this.triggerRegistry,
      log: this.eventLog,
      replies: this.replyChannels,
      vfs: this.rt.storage.vfs,
      secrets: this.webhookSecrets,
      sql: this.hubSql,
      onAdmitted: () => { this.orch.scheduleDrain(); },
    }, opts);
  }

  async jobResult(jobId: string): Promise<BackgroundJob | null> {
    return jobResult(this.jobs, jobId);
  }

  async listBackgroundJobs(limit = 20): Promise<BackgroundJob[]> {
    return listBackgroundJobs(this.jobs, limit);
  }

  async cancelBackgroundJob(jobId: string): Promise<{ ok: boolean }> {
    return cancelBackgroundJob(this.jobRunner, jobId);
  }

  /** Run one replay-eval pass now (also runs periodically inside lifetime
   *  evolution). Returns the persisted loss entry, or null when no
   *  outcome-labeled turns exist yet. */
  async runReplayEval(sampleSize?: number): Promise<ReplayEvalSummary | null> {
    return this.engine.runReplayEval(sampleSize);
  }

  /** The persisted replay-eval loss curve, newest first (read-only). */
  async getReplayEvals(limit?: number): Promise<ReplayEvalSummary[]> {
    return listReplayEvals(this.rt.storage.sql, limit);
  }

  // ── Evolution Changelog (parity with the DO's RPCs) ───────────────

  /** The self-change digest over the durable ledgers (core buildChangelog). */
  getEvolutionChangelog(limit = 50): EvolutionChangelogView {
    return getEvolutionChangelog(this.config, this.rt.storage.sql, limit);
  }

  /** The operator viewed the changelog — zero the unseen badge. */
  markChangelogSeen(): ReturnType<typeof markChangelogSeen> {
    return markChangelogSeen(this.config);
  }

  /** Revert one changelog entry through the real machinery (scaffold
   *  rollback / craft retire / fact forget). Invalidates the model-bound
   *  state so a retired crafted tool disappears from the next turn. */
  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    const result = await revertChangelogEntryById({ rt: this.rt, facts: this.factsStore }, id);
    if (result.ok) this.invalidateModelState();
    return result;
  }

  // ── Alternate Takes (parity with the DO's RPCs) ───────────────────

  /** The newest take set, picked or not — the surfaces' comparison source. */
  latestAlternateTakes(): AlternateTakeSet | null {
    return latestAlternateTakeSet(this.rt.storage.sql);
  }

  /** Record the user's pick (the explicit preference signal) and, when the
   *  pick differs from the answered take, queue a gentle programmatic turn
   *  asking the agent to continue with the chosen approach. */
  async pickAlternateTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    return pickAlternateTake(
      { sql: this.rt.storage.sql, engine: this.engine, signals: this.orch.signals }, takeId, nodeId);
  }

  async proposeCurriculumTasks(count?: number) {
    return proposeCurriculumTasks(this.rt, count);
  }

  async listCurriculumTasks(status?: CurriculumStatus) {
    return listProposedTasks(this.rt, status);
  }

  async setCurriculumTaskStatus(id: string, status: CurriculumStatus): Promise<{ ok: true }> {
    updateProposedTaskStatus(this.rt, id, status);
    return { ok: true };
  }

  // ── BackendHost ────────────────────────────────────────────────────

  broadcast(event: BroadcastEvent): void {
    this.emit({ type: 'broadcast', event });
  }

  get headRuntime(): HeadRuntime {
    this.ensureModelState();
    return this._headRuntime;
  }

  /** The execution-grounding seam handed to the head runtime — the SAME executor
   *  + judge the MCTS engine scores branches with, so head outcomes and the merge
   *  are grounded. Sample knobs default from DEFAULT_CONFIG inside core. */
  private buildHeadGrounding(): HeadGrounding {
    if (this.rt.judgeModel) return {
      executor: this.rt.executor,
      explorer: this.rt.llm,
      judge: this.rt.judgeModel,
    };
    return { executor: this.rt.executor, explorer: this.rt.llm };
  }

  /** The codemode namespaces a head's execute_tools gets beyond its runtime's
   *  own executors: `web.*` and (when a resolver exists) `llm.query`. Pointedly
   *  NOT `agents.*`/`agent.*` — a head forks its parent's resources, never its
   *  authority to delegate. */
  private headCodemodeExtras(): CodemodeProvider[] {
    const providers: CodemodeProvider[] = [createWebCodemodeProvider(this.getWebSearchProvider())];
    if (this.modelResolver) {
      providers.push(createRLMProvider(this.modelResolver, () => this.getEffectiveModelSpec()));
    }
    return providers;
  }

  /** The drain-debounce timer (BackendHost seam) — a plain one-shot timeout.
   *  Skips a window that outlives the session so consumed events are never
   *  bound to a turn a dead pump will not run. */
  setTimer(fn: () => Promise<void>, ms: number): void {
    setTimeout(() => {
      if (this.ended) return;
      void fn().catch((error) => diagnostics.failure(
        'drain.timer_callback_failed',
        toKinuError({ doing: 'running the drain-debounce timer callback', cause: error, otherwise: 'io' }),
      ));
    }, ms);
  }

  /** Inject a programmatic turn into the same serialized loop the user drives —
   *  backs the reactor + background-job wake. Self-starts the pump when idle so
   *  a job that settles mid-idle wakes the agent immediately.
   *
   *  A producer that named the fact it is announcing (`idempotencyKey`) gets
   *  that name carried onto the durable row, and a re-announcement of a fact
   *  this session already recorded starts no turn at all: the row is already
   *  there and already answered, so 'queued' is the truth the producer needs
   *  (nothing was lost, do not compensate) without a second turn spent saying
   *  it again. The check reads the same durable table the write lands in — the
   *  ledger IS the store here — so a later process reaches the same answer. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    if (workModeForTurnMetadata(input.metadata) === 'plan') {
      return Promise.reject(new Error(
        'Plan review is available in the hosted workspace UI; this local session has no review surface.',
      ));
    }
    // A job settling during shutdown must not start a turn the ending session
    // will never drain: 'skipped' sends the caller down its durable-breadcrumb
    // path instead, and the next run drains it from the event log.
    if (this.ended) return Promise.resolve({ status: 'skipped' });
    if (input.idempotencyKey !== undefined && this.hasAnnounced(input.idempotencyKey)) {
      return Promise.resolve({ status: 'queued' });
    }
    const { promise, resolve } = Promise.withResolvers<EnqueueTurnResult>();
    const item: QueueItem = {
      text: input.text,
      metadata: input.metadata,
      kind: 'programmatic',
      // 'skipped' is what a producer with a durable retry plane acts on: the
      // signal seam compensates on anything but 'queued', which is how an event
      // drain gets its rows back when another process holds the driver lease.
      settle: (refusal) => resolve({ status: refusal ? 'skipped' : 'queued' }),
    };
    if (input.idempotencyKey !== undefined) item.idempotencyKey = input.idempotencyKey;
    this.queue.push(item);
    void this.pump();
    return promise;
  }

  /** Is this fact already recorded in the durable transcript, or already queued
   *  to be? Both halves matter: a cold activation asks the table, and a second
   *  delivery inside one activation (recover + recoverOrphans naming the same
   *  job) asks the queue, because the first has not persisted yet. */
  private hasAnnounced(identity: string): boolean {
    const id = `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${identity}`;
    if (this.queue.some((item) => item.idempotencyKey === identity)) return true;
    return this.rt.storage.sql<{ id: string }>`
      SELECT id FROM messages WHERE id = ${id} AND session_id = ${this.sessionId}
    `.length > 0;
  }

  /** BackendHost seam — will there be a next step for a signal to land on?
   *
   *  `currentAbort` is set for exactly the streaming window of one turn and
   *  cleared in its `finally`, BEFORE settle() runs, so a signal that arrives
   *  as the turn is ending either buffers for a step that still exists or is
   *  told there is no turn — never both, never neither.
   *
   *  The user steer-drain's USER semantics (each steer persists as a verbatim
   *  user row for the walk-back fork, interrupt() hands pending steers back to
   *  the composer, leftover steers rerun as a user-origin turn) are properties
   *  of core's `UserSteerDrain`, which signals do not touch: they ride the core
   *  seam's own buffer, are never persisted, and settle back into turns of
   *  their own.
   *  Two independent splices land at the same step tail as two adjacent
   *  user-role messages, which every provider adapter groups into one turn. */
  turnInFlight(): boolean {
    return this.currentAbort !== null;
  }

  // ── Public driver API ──────────────────────────────────────────────

  /** Run a user turn (and any programmatic turns it cascades). Resolves when
   *  the user's own turn has finished. Attachments (data-URL PromptFiles)
   *  become file parts on the turn's user message.
   *
   *  REJECTS when another process holds this conversation's driver lease. The
   *  message was not sent and no turn ran, so resolving would tell the person
   *  their words landed when they were dropped; the rejection names the holder
   *  and what to do about it. */
  send(
    input: string | { text: string; files: ReadonlyArray<PromptFile> },
    opts: { tier?: TierId } = {},
  ): Promise<void> {
    const { text, files } = normalizePromptInput(input);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const metadata = opts.tier === undefined ? undefined : { profile_tier: opts.tier };
    this.queue.push({
      text, files, metadata, kind: 'user',
      settle: (refusal) => {
        if (!refusal) { resolve(); return; }
        reject(new KinuError(
          refusal.reason,
          `${refusal.error}. Close that session, or send this from it.`,
        ));
      },
    });
    this.pump();
    return promise;
  }

  /**
   * Steer the in-flight turn: queue the message for injection at the next step
   * boundary (prepareStep), where everything pending drains into one merged
   * user message. Input that never sees a boundary (the model was already
   * writing its final answer) runs as the immediate next turn instead.
   * Returns false when no turn is active — callers should send() normally.
   */
  steer(input: string | { text: string; files: ReadonlyArray<PromptFile> }): boolean {
    const parts = normalizePromptInput(input);
    // Identity is assigned on ACCEPTANCE, so the queued announcement, the
    // landed one and the durable row are all the same steer to a surface —
    // which is what stops one steer being rendered twice under two names.
    const id = `steer-${crypto.randomUUID().slice(0, 12)}`;
    if (this.userSteer.accept({ ...parts, id }) !== 'mid-turn') return false;
    this.announceSteer({ status: 'queued', steerId: id, text: parts.text });
    return true;
  }

  /**
   * Run a mid-turn redirect as a parallel BRANCH: one budgeted head over the
   * live turn's input conversation (this.history already holds it), never
   * touching the live turn. When both finish, the pair settles into the
   * Alternate Takes pipeline claimed on this turn (core steer-branch.ts);
   * progress streams as 'branch_status' broadcasts. Returns false when no
   * turn is in flight — callers should send() instead.
   */
  branch(text: string): boolean {
    if (!this.pumping) return false;
    const task = text.trim();
    if (!task) return false;
    this.ensureModelState();
    const id = newBranchId();
    const handle = startBranchHead(this._headRuntime, this.headJournal, {
      id, task, inheritedContext: this.readInheritedContext(),
    });
    this.pendingBranches.push({ id, task, handle });
    this.broadcast({ type: 'branch_status', status: 'running', branchId: id, task } satisfies BranchStatusEvent);
    return true;
  }

  /** Abort the in-flight turn (Ctrl+C / Esc). Pending steers are dropped —
   *  an interrupt means "stop", not "stop and do what I typed" — but the
   *  dropped texts are RETURNED so the surface can hand them back to the
   *  user (the composer restore), never lose them silently: the chat already
   *  rendered them as sent. */
  interrupt(): string[] {
    const dropped = this.userSteer.interrupt();
    for (const steer of dropped) {
      if (steer.id) this.announceSteer({ status: 'returned', steerId: steer.id, text: steer.text });
    }
    this.currentAbort?.abort();
    return dropped.map((steer) => steer.text);
  }

  /**
   * A drain happened: the model has these steers as of the step now starting.
   *
   * The step index is the whole reason this is recorded rather than derived at
   * persist time. A turn is ONE assistant message, so a row appended beside it
   * can only sort before or after the entire turn; the index is the position
   * INSIDE it, and it is what lets a reloaded transcript draw the bubble where
   * the model actually read it.
   */
  private recordLandedSteers(steers: readonly UserSteer[], atStep: number): void {
    // Core builds the rows: it assigns the fallback id and stamps BOTH metadata
    // keys together, which is the point — a row carrying the steer key without
    // the step key is indistinguishable from an ordinary user turn. What is left
    // here is transport: this session's ledger and its broadcast channel.
    for (const row of describeLandedSteers(steers, atStep)) {
      this.landedSteers.push(row);
      this.announceSteer({ status: 'landed', steerId: row.id, text: row.text, atStep: row.atStep });
    }
  }

  /** The one place a steer's lifecycle reaches connected surfaces — the same
   *  `steer_status` union the cloud backend broadcasts (core user-steer.ts). */
  private announceSteer(detail: SteerStatusDetail): void {
    const event: SteerStatusEvent = { type: 'steer_status', ...detail };
    this.broadcast(event);
  }

  /** Fold the history at this point: the next turn's context transform runs
   *  with `force`, so the ladder rebuilds now instead of waiting for the
   *  measured token trigger. One-shot — `takeForceCompaction` consumes the
   *  flag, so this can never loop. The session owns its compaction key, so a
   *  caller marking a phase boundary never has to reconstruct it. */
  armForcedCompaction(): void {
    this.compactionState.armForceCompaction(this.cacheIdentity().sessionKey);
  }

  /** Connect configured stdio MCP servers + merge their tools into the surface.
   *  Call once at startup (no-op for empty config). Idempotent-safe to skip. */
  async connectMcp(servers: Record<string, McpServerConfig>): Promise<void> {
    if (!servers || Object.keys(servers).length === 0) return;
    const conn = await connectMcpServers(servers, (msg) => this.emit({ type: 'evolution', event: 'mcp', message: msg }));
    // MCP servers are bulk producers like any other tool — same clamp, same
    // spill path, same turn budget as the builtins.
    this.extraTools = withClampedToolResults(conn.tools, {
      vfs: this.rt.storage.vfs, budget: this.orch.acc.context, producer: 'external_tool',
    });
    this.mcpClose = conn.close;
    // A server that never came up is stated in the turn's live context, not
    // only in a diagnostic the model never sees. Its tools are simply ABSENT
    // otherwise, so the model plans as if a capability the user configured
    // does not exist and cannot explain why.
    this.mcpUnavailable = conn.diagnostics
      .filter((d) => d.status === 'failed')
      .map((d) => ({
        source: `MCP server "${d.server}"`,
        reason: d.reason ?? 'failed to start — its tools are absent from this turn',
      }));
  }

  /** Configured MCP servers whose tools are not on this session's surface. */
  private mcpUnavailable: MissingCapability[] = [];

  /** Run any pending event drain to completion NOW, bypassing the ~250ms
   *  debounce window. The scheduler daemon fires due triggers then ends the
   *  session immediately, so the debounced drain fireDueTriggers armed would
   *  never fire (end() sets `ended`, and the drain timer skips when ended) —
   *  the fired trigger's autonomous turn would be silently dropped. A batch
   *  tick calls this before end() to flush its work synchronously. A direct
   *  drain is safe: pending events are durable in the EventLog until
   *  markConsumed, so drainPendingEvents consumes-or-returns them exactly once.
   *  Interactive sessions keep the debounced path untouched — end() on Ctrl-C
   *  must not suddenly run an autonomous turn. */
  async flushPendingDrains(): Promise<void> {
    if (this.ended) return;
    // Gated HERE as well as at the pump, because the drain BINDS the rows it
    // selects (markConsumed) on its way to the pump. A refusal one step later
    // is recoverable — the queue item settles refused and the drain hands the
    // rows back — but a refusal here means they were never bound at all, which
    // is the outcome to prefer when the answer is already knowable. The gate is
    // the same object either way, and re-asking it costs one row read.
    const refusal = this.driverGate?.();
    if (refusal) {
      diagnostics.event('driver.drain_deferred', { reason: refusal.reason });
      return;
    }
    await this.orch.drainPendingEvents();
  }

  /**
   * Run the session/lifetime evolution pass the durable window is due for, to
   * completion. This is the CADENCE LANE (AgentOrchestrator's exit contract),
   * and this method is how a host that CAN afford it claims the work a
   * one-shot `kinu exec` process deliberately left behind: the scheduler
   * daemon calls it on its tick, in a process whose wall clock is charged to
   * nobody's task.
   *
   * Resolves immediately when nothing is due. Never rejects — the pass absorbs
   * its own failures and the window carries forward.
   */
  async runDueEvolution(): Promise<void> {
    if (this.ended) return;
    await this.orch.runDueSessionEvolution();
  }

  /** End the session: let the evolution this run started finish, then let any
   *  detached background fiber settle, then disconnect MCP. Both windows are
   *  durable, so whatever does not finish carries over to the next run rather
   *  than being force-closed here. */
  async end(): Promise<void> {
    this.ended = true;
    this.clearLocalAlarm();
    const t0 = Date.now();
    await this.orch.settleEvolution();
    const t1 = Date.now();
    await this.joinBackgroundFibers(this.drainDeadline());
    const t2 = Date.now();
    await this.mcpClose?.();
    const t3 = Date.now();
    // The exit tail, attributed — see evolution.settled for WHAT the first
    // phase waited on. Quiet under 1s: a fast exit stays silent (the --json
    // contract promises an empty stderr), a slow tail still names itself.
    if (t3 - t0 > 1_000) {
      diagnostics.event('session.settle_timings', {
        evolutionMs: t1 - t0, fibersMs: t2 - t1, mcpMs: t3 - t2,
      });
    }
  }

  /** Durable fibers detached from a turn — a backgrounded tool call, or an
   *  evict-recovery resume. The DO stays alive for its fiber's duration; the
   *  CLI's equivalent is refusing to close the database out from under one,
   *  which would abort the settle write mid-flight. */
  private readonly backgroundFibers = new Set<Promise<unknown>>();

  /** The ONE wall-clock budget this session spends waiting on work that has not
   *  settled, armed the first time a drain asks for it. settleBackgroundWork()
   *  and end() share it, so a one-shot run — which calls both, back to back, on
   *  the same never-settling job — cannot pay the grace twice. */
  private settleDeadline: number | null = null;
  private drainDeadline(): number {
    return this.settleDeadline ??= Date.now() + this.jobRunner.policy.settleGraceMs;
  }
  private trackFiber<T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> {
    const running = this.rt.schedule.fiber(name, fn);
    // Tracked as a SETTLEMENT rather than as an outcome: joinBackgroundFibers
    // awaits this set with allSettled, and the work's result belongs to the
    // caller holding `running`. What reaches here instead is a fiber that could
    // not even record its own outcome — a stash or row-delete against a
    // database closed under it at teardown — which has no other reader, so it
    // is stated rather than dropped as an unhandled rejection.
    const settled = Promise.allSettled([running]);
    this.backgroundFibers.add(settled);
    void settled.then(([outcome]) => {
      this.backgroundFibers.delete(settled);
      if (outcome.status === 'rejected') {
        diagnostics.failure(
          'fiber.settle_failed',
          toKinuError({ doing: 'settling a durable background fiber', cause: outcome.reason, otherwise: 'io' }),
          { fiber: name },
        );
      }
    });
    return running;
  }

  /**
   * Await in-flight background fibers until they settle or `deadline` passes.
   *
   * The wait has to be bounded because the work behind a fiber may never
   * finish: the calls that detach are the ones that ran long, and the longest
   * of those are servers and VMs the agent deliberately left running. An
   * unbounded join on those was 6.4 of 16.2 agent-hours of dead idle across a
   * benchmark run, every second of it after the agent had already answered.
   *
   * Whatever is still running at the deadline is LEFT running — not cancelled.
   * Its shell children live in their own process groups and outlive this
   * process, which is the whole point of "I started the server in the
   * background", and its durable job row stays `running`, so the next start's
   * orphan recovery treats it exactly as it treats a job interrupted by a kill.
   * Returns true when everything settled inside the grace.
   */
  private async joinBackgroundFibers(deadline: number): Promise<boolean> {
    if (this.backgroundFibers.size === 0) return true;
    this.emit({
      type: 'evolution', event: 'bg_jobs_settling',
      message: `${this.backgroundFibers.size} background job(s) still running — waiting for their results`,
    });
    while (this.backgroundFibers.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.announceAbandonedJobs();
        return false;
      }
      await raceDeadline(Promise.allSettled(this.backgroundFibers), remaining);
    }
    return true;
  }

  /**
   * Say plainly what is being left behind, because the answer is not "nothing".
   *
   * The in-flight work dies with this process, but the job rows stay `running`
   * and are checkpoint-backed, so the next start of this workspace re-drives
   * them — and one of the things that starts this workspace is the local
   * scheduler daemon, with nobody watching. A resumed job runs the agent's own
   * tools: it executes commands and writes files here, minutes after the
   * command that started it returned. That is a thing an operator has to be
   * told BEFORE it happens, so the notice goes to stderr as well as to the
   * event stream — stderr is the one channel every surface shows and no
   * machine-readable stdout stream can be corrupted by.
   */
  private announceAbandonedJobs(): void {
    const interrupted = this.jobs.listRunning();
    const roster = interrupted
      .map((job) => `${job.id} (${job.kind}${job.label ? `: ${job.label}` : ''})`)
      .join(', ');
    const message =
      `${this.backgroundFibers.size} background job(s) did not finish in time and were interrupted by this ` +
      'exit. They are checkpointed, so this workspace resumes them the next time it starts — including ' +
      'unattended, under the local scheduler daemon — and a resumed job runs commands and writes files on ' +
      `this machine. Cancel with: kinu jobs ${this.agentName()} cancel <id>.` +
      (roster ? ` Interrupted: ${roster}.` : '');
    this.emit({ type: 'evolution', event: 'bg_jobs_abandoned', message });
    diagnostics.failure('jobs.abandoned_at_exit', new KinuError('timeout', message), {
      jobs: interrupted.length,
    });
  }

  /**
   * Recover the work a previous CLI exit interrupted: the fork journal and the
   * background-job registry, in ONE pass rather than two.
   *
   * They used to be sequential, and the order was the defect. `head_journal.status
   * = 'running'` means "spawned, no report recorded", nothing carries a head across
   * a process exit, and left alone that row feeds "N of M heads running" into every
   * model step forever — so the journal has to be reconciled. But retiring a run is
   * not the same act as correcting that claim, and doing both first meant a search
   * whose durable job was still re-drivable was told, in the agent's own
   * conversation, that nothing was left to run it. `reconcileInterruptedForks` now
   * marks the stale rows non-terminally, hands their roots to the job sweep, and
   * retires only the runs that sweep refused.
   *
   * Fiber rows are read first, because an interrupted `bg:*` fiber row says its
   * job's executor died AFTER settling, which is the only way a lost wake can be
   * re-delivered (DO onFiberRecovered parity). The registry sweep inside the gate
   * then names every job still `running`, including the ones whose fiber row did
   * not survive: a settlement whose database was closed under it at teardown wrote
   * neither its outcome nor its force-fail, and a fiber-keyed recovery can never
   * reach that row. Stale fiber rows are cleared as they are read — a resume runs
   * in a NEW fiber row, so this never deletes it.
   *
   * Then the turn reviews a previous one-shot process deferred. Same reason as the
   * jobs: `kinu exec` exits before the outcome review it owes, so the review is a
   * durable row and this is the next host that can afford it (core's
   * AgentOrchestrator.runDeferredTurnReviews — a one-shot session declines it
   * there, so the cost never lands back on an exec invocation). Bounded per open,
   * so a backlog is not this session's first turn's latency.
   *
   * Call once at startup: no fibers are live yet, so every row is an orphan.
   *
   * Nothing here is optional. Each step used to absorb its own failure, so a
   * workspace whose fiber rows could not be read recovered NOTHING and then looked
   * exactly like one that had no interrupted work — while the notice the previous
   * exit printed promised the operator these jobs would resume.
   */
  async recoverBackgroundJobs(): Promise<void> {
    for (const orphan of detectOrphanedFibers(this.rt.storage.sql)) {
      if (orphan.name.startsWith('bg:')) await this.jobRunner.recover(orphan.snapshot);
      void this.rt.storage.sql`DELETE FROM fibers WHERE id = ${orphan.id}`;
    }
    await reconcileInterruptedForks({
      journal: this.headJournal,
      signals: this.orch.signals,
      search: this.mctsSearchStore,
      runEvents: this.eventRecorder,
      resume: jobRedriveResumeGate({
        recoverOrphans: () => this.jobRunner.recoverOrphans(),
        inputOf: (jobId) => this.jobs.getInput(jobId),
        rootsForTask: (task) => resumableForkRoots(
          { ledger: this.mctsSearchStore, journal: this.headJournal }, task,
        ),
      }),
      logActivity: (event, detail) => this.emit({ type: 'evolution', event, message: detail ?? '' }),
    });
    const reviews = await this.orch.runDeferredTurnReviews();
    if (reviews.reviewed > 0 || reviews.refused.length > 0) {
      // Each reason states a different fate for the row, so they are counted
      // apart: an unreadable row is gone, a budget-refused one is still owed.
      const unreadable = reviews.refused.filter((r) => r.reason === 'unreadable').length;
      const overBudget = reviews.refused.length - unreadable;
      this.emit({
        type: 'evolution', event: 'deferred_reviews_drained',
        message: `${reviews.reviewed} deferred turn review(s) run`
          + (unreadable > 0 ? `, ${unreadable} unreadable row(s) dropped` : '')
          + (overBudget > 0 ? `, ${overBudget} left queued: the mission is over its budget` : ''),
      });
    }
  }

  /** Re-drive a background job interrupted by a previous process exit — the
   *  shared resume gate (core background-tools) over the RAW surface, so a
   *  re-drive can't detach a second job. Rows stored under the removed `fork`
   *  action, and 'think' rows older still, translate onto the search path; the
   *  model-bound surface resolves inside the thunk, only for a resumable kind. */
  private resumeBackgroundJob(
    kind: string,
    input: { value: unknown },
    mode: WorkMode,
    signal: AbortSignal,
  ) {
    return resumeBackgroundJob((resumeMode) => {
      this.ensureModelState();
      return this.toolSets[resumeMode]?.raw ?? {};
    }, kind, decodeJsonValue({ value: input.value }), mode, signal).then((value) =>
      value === undefined ? undefined : decodeJsonValue({ value }));
  }

  // ── Internals ──────────────────────────────────────────────────────

  private emit(event: SessionEvent): void {
    try {
      this.onEvent(event);
    } catch (error) {
      // A frontend render error must not kill the agent loop — but it is still a
      // defect, and the event stream that would have shown it is the thing that
      // just failed, so stderr is the only channel left.
      diagnostics.failure(
        'session.event_listener_failed',
        toKinuError({ doing: 'delivering a session event to the frontend listener', cause: error, otherwise: 'io' }),
        { eventType: event.type },
      );
    }
  }

  private scheduleLocalAlarm(ts: number): void {
    if (this.ended) return;
    if (this.scheduledAlarmAt !== null && this.scheduledAlarmAt <= ts) return;
    this.clearLocalAlarm();
    this.scheduledAlarmAt = ts;
    const delay = Math.max(0, ts - Date.now());
    this.alarmTimer = setTimeout(() => {
      this.alarmTimer = null;
      this.scheduledAlarmAt = null;
      void this.fireDueTriggers();
    }, Math.min(delay, 2_147_483_647));
  }

  private clearLocalAlarm(): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    this.scheduledAlarmAt = null;
  }

  private rearmLocalAlarm(): void {
    if (this.ended) return;
    const next = this.nextScheduledTriggerAt();
    if (next === null) {
      if (this.scheduledAlarmAt !== null) this.clearLocalAlarm();
      return;
    }
    if (this.scheduledAlarmAt !== null && this.scheduledAlarmAt !== next) this.clearLocalAlarm();
    this.scheduleLocalAlarm(next);
  }

  private nextScheduledTriggerAt(): number | null {
    const upcoming = this.triggerRegistry.list({ state: 'active' })
      .map((t) => t.next_fire_at)
      .flatMap((value) => {
        const parsed = v.safeParse(v.number(), value);
        return parsed.success ? [parsed.output] : [];
      })
      .sort((a, b) => a - b)[0];
    return upcoming ?? null;
  }

  /**
   * The owning host's driver-lease check, installed right after construction
   * like the team and peer transports.
   *
   * Absent means nothing is coordinating this database — a bare session in a
   * fixture, or a single process that is the only driver by construction — and
   * an absent gate drives freely. It is not a degrade: with no second process
   * there is no interleaving to prevent.
   */
  private driverGate: (() => Refusal | null) | null = null;

  setDriverGate(gate: () => Refusal | null): void {
    this.driverGate = gate;
  }

  /** Kick the serialized turn pump if idle — idempotent, so a concurrent
   *  enqueueTurn just appends and the running pump picks it up. The active
   *  run's promise is tracked (pumpPromise) so settleBackgroundWork() can
   *  await wake turns to completion. */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.pumpPromise = this.runPump();
  }

  private async runPump(): Promise<void> {
    try {
      let item: QueueItem | undefined;
      while ((item = this.queue.shift())) {
        // Checked per ITEM, immediately before the turn runs. A turn is the
        // longest thing this process does and it writes the conversation, so
        // two processes running turns over one database interleave them. An
        // interactive gate takes the lease from a daemon here, which is what
        // stops a user's turn landing inside a daemon-driven one; a gate that
        // refuses means another process of this same kind is driving, and
        // there is nothing to wait for.
        //
        // Settled with the refusal rather than emitted as an error: this turn
        // did not run, and the ONE thing that must happen is that its producer
        // hears so — an event drain compensates its rows back to pending, a
        // person's send fails loudly. The producer owns what to say about it.
        const refusal = this.driverGate?.();
        if (refusal) {
          diagnostics.event('driver.turn_deferred', { kind: item.kind, reason: refusal.reason });
          item.settle(refusal);
          continue;
        }
        try {
          await this.processTurn(item);
        } catch (err) {
          diagnostics.failure(
            'turn.processing_failed',
            toKinuError({ doing: 'processing a queued turn', cause: err, otherwise: 'io' }),
          );
        } finally {
          item.settle(null);
        }
      }
    } finally {
      // Cleared synchronously as the loop exits — NOT in a .finally() callback,
      // whose microtask would run after a just-resolved send()'s continuation
      // and leave `pumping` stale-true, so the next send()'s pump() would no-op
      // and orphan its queued turn.
      this.pumping = false;
      this.pumpPromise = null;
    }
  }

  /**
   * Drain in-flight background work: await detached job fibers, run the wake
   * turns their settlement enqueues, and repeat until nothing is detached,
   * queued, or pumping. Unlike end() this never marks the session ended, so the
   * wakes actually run (enqueueTurn only skips once ended) — and because a
   * settled fiber awaits its own wake turn (host.enqueueTurn resolves when that
   * turn finishes), awaiting the fibers awaits the wakes too. A one-shot
   * `kinu run`/`exec` calls this after its turn and before it stops
   * listening/closes, so a turn that backgrounded work streams its second half
   * instead of being cut off at process exit.
   *
   * The two waits are bounded differently on purpose. A TURN already in flight
   * is always run to completion — truncating a wake turn is the exact defect
   * this method exists to prevent, and a turn is bounded by its own budget.
   * Waiting on work that has NOT settled is bounded by the surface's grace:
   * that work may be a server which never settles at all.
   */
  async settleBackgroundWork(): Promise<void> {
    const deadline = this.drainDeadline();
    for (;;) {
      // A queued turn always has a live pump (enqueueTurn kicks it), so awaiting
      // the pump drains the queue too.
      if (this.pumpPromise) { await this.pumpPromise; continue; }
      if (this.backgroundFibers.size === 0) return;
      if (!await this.joinBackgroundFibers(deadline)) return;
    }
  }

  /** Append to the durable run-event log. Scoped to the in-flight run by
   *  default (`runId` omitted); a caller with its OWN run id passes it
   *  explicitly so the row lands on that run once the calling turn has moved
   *  on. Never throws: losing a history row must not fail a turn. */
  private recordRunEvent(input: RunEventInput, runId?: string | null): void {
    const id = runId !== undefined ? runId : this.currentRunId;
    if (!id) return;
    try { this.eventRecorder.emit(id, input); }
    catch (err) {
      diagnostics.failure(
        'event.run_row_write_failed',
        toKinuError({ doing: 'appending a row to the durable run-event log', cause: err, otherwise: 'io' }),
      );
    }
  }

  /**
   * Seal the in-flight run via the shared core turn-lifecycle bracket.
   * Idempotent per run — clearing the id makes a second call a no-op.
   *
   * FACTS in, name out. This used to compute `hadError ? 'error' : 'completed'`
   * itself, and since an interrupt throws `INTERRUPTED_TURN` and the catch folds
   * that into `hadError`, pressing Stop sealed the run `'error'` here and
   * `'aborted'` in the cloud — the same user action counted as a failure on one
   * backend and a choice on the other. `classifyRunEnd` owns the vocabulary now;
   * this method reports what it saw and returns the reason it was given.
   */
  private closeRun(facts: RunEndFacts): RunEndReason {
    const end = classifyRunEnd(facts);
    if (!this.currentRunId) return end.reason;
    const outcome: Parameters<typeof closeTurnRun>[2] = {
      turnIndex: this.orch.sessionTurnIndex,
      usage: this.orch.acc.reportedUsage(),
      context: this.orch.acc.context,
      files: this.orch.acc.files,
      escalations: this.orch.acc.escalations,
      steering: this.orch.steering.snapshot(),
      delegation: this.orch.steering.delegationSnapshot(),
      completionGate: this.completionGate.take(),
      craft: this.orch.craft.snapshot(),
      recoveries: this.orch.recoverySnapshot(),
      reason: end.reason,
    };
    if (end.error) outcome.error = end.error;
    closeTurnRun(this.eventRecorder, this.currentRunId, outcome);
    this.currentRunId = null;
    return end.reason;
  }

  /** A single run's durable events — the local peer of the DO's getRunEvents,
   *  and what an SSE resume replays from (`since` = last seen index). */
  getRunEvents(runId: string, opts: RunEventQuery = {}): RunEvent[] {
    return getRunEvents(this.eventRecorder, runId, opts);
  }

  /** A page of recent runs, newest first — the local peer of the DO's listRuns. */
  listRuns(request?: PageRequest): Page<RunListEntry> {
    return listRuns(this.eventRecorder, request?.cursor ?? null, request?.limit);
  }

  /**
   * Run one queued turn under the guarantee every surface above depends on: a
   * turn that starts always terminates — exactly one `turn-end`, and a run that
   * is always closed.
   *
   * The turn's own stream has a failure path that emits `error`, flags the
   * accumulator and finalizes normally. Everything BEFORE that stream exists —
   * resolving the model, the skills, the system prompt — had no such path and
   * threw straight out of the method, past an opened run and before any
   * `turn-end`. The pump then logged it to stderr and resolved the caller, so a
   * turn that never ran a step was reported as a turn that succeeded.
   */
  private async processTurn(item: QueueItem): Promise<void> {
    const parsedEvent = v.safeParse(v.string(), item.metadata?.kinuEvent);
    const event = parsedEvent.success ? parsedEvent.output : undefined;
    this.turnWorkMode = workModeForTurnMetadata(item.metadata);
    this.emit({ type: 'turn-start', kind: item.kind, text: item.text, event });

    const startedAt = Date.now();
    // Per-turn accounting reset + the turn's mission scope, together: what the
    // turn is allowed to spend is part of what the turn is.
    this.orch.beginTurn(startedAt, item.metadata);
    // Open this turn's run in the durable event log (core turn-lifecycle).
    // Provenance mirrors the DO's: a real chat turn is 'chat', a programmatic
    // one names its trigger.
    this.currentRunId = `run-${crypto.randomUUID()}`;
    openTurnRun(this.eventRecorder, this.currentRunId, {
      agentId: this.agentName(),
      causedBy: event ?? 'chat',
      userMessage: item.text,
      turnIndex: this.orch.sessionTurnIndex,
    });
    try {
      await this.runTurn(item, event, startedAt);
    } catch (error) {
      const message = renderThrownChain({ cause: error });
      // Assembly threw before the stream existed, so there is nothing here a
      // user could have interrupted: this arm is always a genuine failure.
      this.orch.acc.hadError = true;
      this.closeRun({ completed: false, interrupted: false, errorText: message.slice(0, 500) });
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });
    } finally {
      // The turn's profile is immutable FOR the turn, so it is released here
      // rather than by whatever changed the config underneath it. Between turns
      // the role/tier/model readers fall through to the durable config, which is
      // how a role changed mid-turn becomes visible exactly once the turn it
      // could not affect is over. The RUNTIME keeps its copy on purpose: the
      // detached review and advisor lanes belong to the turn that just ran and
      // route against its profile.
      this.turnProfile = null;
      this.turnProfileInputs = null;
    }
  }

  /** The turn as it stands — the one shape the normal end and both failure
   *  paths report. */
  private snapshotTurn(item: QueueItem, assistantResponse: string, turnId?: string | null): CompletedTurn {
    const completedTurn: Parameters<typeof snapshotCompletedTurn>[1] = {
      userMessage: item.text,
      assistantResponse,
      sessionId: this.sessionId,
      origin: item.kind,
    };
    if (turnId) completedTurn.turnId = turnId;
    return snapshotCompletedTurn(this.orch.acc, completedTurn);
  }

  /** The turn itself: assemble it, stream it, finalize it. Everything here may
   *  throw; processTurn owns what that means. */
  private async runTurn(item: QueueItem, event: string | undefined, startedAt: number): Promise<void> {
    // substrate — see core checkpoints/types.ts).
    this.rt.checkpoints?.beginTurn({ turnId: crypto.randomUUID(), sessionId: this.sessionId });
    // Before anything reads the tool surface: the report gate is a property of
    // THIS turn, and both the profile resolution below and the toolset rebuild
    // after it consult it.
    this.turnIsParentAssigned = item.kind === 'programmatic';
    const profileInputs = await this.profiles().inputs();
    const activeRoleId = this.config.getActiveRoleId();
    const roleSkills = effectiveRoleCatalog(profileInputs.envelope.catalog)[activeRoleId]?.skills ?? [];
    // A real user message grades the previous turn — dispatch the detached
    // outcome review (same core pipeline as the DO's beforeTurn hook). In a
    // one-shot process the previous turn belongs to an already-exited
    // invocation, so this prompt is a fresh task, not a verdict on it.
    if (item.kind === 'user') this.orch.observeUserTurn(item.text, this.turnContinuity);
    if (item.kind === 'user' && this.oneShot) this.completionGate.arm(item.text);
    const executors = this.rt.executionRouter?.listExecutors() ?? [];
    const { available: availableSkills, activeSkills } = await this.resolveTurnSkills(
      item.text,
      roleSkills,
    );
    const candidateBuiltins = this.filterToolsBySkills(activeSkills);
    const candidateBuiltinNames = Object.keys(candidateBuiltins).filter(
      (name): name is BuiltinToolName => BUILTIN_TOOL_NAMES.has(name),
    );
    const candidateExternalNames = Object.keys(this.extraTools);
    const candidateAgentActions = agentsActionsFor(this.agentsToolDeps(this.turnWorkMode));
    const profile = resolveAgentTurnProfile({
      ...profileInputs,
      activeRoleId: this.config.getActiveRoleId(),
      workMode: this.turnWorkMode,
      availableTools: [
        ...candidateBuiltinNames,
        ...candidateExternalNames,
        // `report` is wired for a parent-assigned turn only, and the toolset it
        // lives in is rebuilt AFTER this resolution — so the candidate list
        // cannot see it yet. Named here for the same reason the codemode
        // capabilities are: without it the intersection drops the tool from any
        // role that declares a tool list, and the child silently loses the one
        // surface that can end its assignment.
        ...(this.reportGateOpen() ? [REPORT_TOOL] : []),
        // `release` / `agent` / `llm` are reachable only inside the sandbox, so
        // no native tool id names them. Without them here the intersection
        // drops every one from a role that declares a tool list, and a narrowed
        // role silently loses its codemode lanes wholesale. Derived from the
        // providers actually wired, so a capability can never be offered whose
        // namespace is absent.
        ...codemodeCapabilitiesFor(this.codemodeProviders(this.turnWorkMode)),
      ],
      activeSkills: activeSkills?.active.map((skill) => skill.name) ?? [],
      // Most specific first: the tier named on THIS message, then the tier the
      // parent pinned when it hired this agent, then nothing — which lets the
      // resolver take the role's own default. An absent pin must not read as
      // "the workspace default"; the role's tier is what an unpinned hire asked
      // for.
      explicitTier: tierFromMetadata(item.metadata) ?? this.config.getAssignedTier() ?? undefined,
    });
    this.turnProfile = profile;
    this.turnProfileInputs = profileInputs;
    this.turnWorkMode = profile.workMode;
    this.rt.setTurnProfile?.(profile);
    this.invalidateModelState();
    const model = this.ensureModelState();
    this.activateToolMode(this.turnWorkMode);
    const allowedTools = new Set(profile.allowedTools);
    const toolAllowed = (name: string): boolean => allowedTools.has(name);
    const filteredBuiltins = Object.fromEntries(
      Object.entries(this.filterToolsBySkills(activeSkills)).filter(([name]) => toolAllowed(name)),
    );
    const filteredExternal = Object.fromEntries(
      Object.entries(this.extraTools).filter(([name]) => toolAllowed(name)),
    );
    const turnTools = { ...filteredBuiltins, ...filteredExternal };
    const availableBuiltins = Object.keys(filteredBuiltins).filter(
      (name): name is BuiltinToolName => BUILTIN_TOOL_NAMES.has(name),
    );
    const externalTools = Object.keys(filteredExternal).map((name) => ({
      name,
      source: isMcpToolKey(name) ? 'mcp' as const : 'external' as const,
    }));
    const resolvedAgentActions = toolAllowed('agents') ? candidateAgentActions : [];
    const memoryTail = await readMemoryTail(this.rt.memory);
    // Nearest-file-wins AGENTS.md chain, re-read each turn so edits land
    // immediately (a handful of stat calls — negligible next to the LLM call).
    const agentsMd = discoverAgentsMd(this.cwd);
    // The agent's SOUL.md, re-read each turn for the same reason as AGENTS.md.
    // agentStateVfs is the identity tree when it differs from the working VFS;
    // absent override renders the default soul, never an empty one.
    const soul = await readSoul(this.rt.agentStateVfs ?? this.rt.storage.vfs);
    // The byte-stable cache prefix — system state (facts, executor status)
    // rides the dynamic ledger and activation reasons ride the turn-local
    const systemPromptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {
      executors,
      availableTools: availableBuiltins,
      agentsActions: resolvedAgentActions,
      // Matches the execute_tools wiring: llm.query exists only with a resolver.
      rlmAvailable: this.modelResolver !== null,
      externalTools,
      backend: 'cli-local',
      workMode: this.turnWorkMode,
      provenance: turnProvenanceForMetadata(item.metadata),
      roleSection: profile.role,
      planSubmissionAvailable: false,
      model: { id: this.effectiveModelSpec() },
      cwd: this.cwd,
      currentDate: currentDateForPrompt(),
      // Prompt sections the evolution loop promoted. Read here, not inside the
      // builder: the builder is the byte-stable cacheable prefix and does no
      // I/O, exactly as with the soul.
      sectionOverrides: activePromptSectionOverrides(this.rt.storage.sql),
    };
    if (agentsMd.length > 0) systemPromptOptions.agentsMd = agentsMd;
    if (availableSkills.length > 0) systemPromptOptions.availableSkills = availableSkills;
    if (activeSkills) systemPromptOptions.activeSkills = activeSkills;
    if (soul) systemPromptOptions.soulOverride = soul;
    const systemPrompt = buildSystemPromptSync(this.rt, systemPromptOptions);
    this.recordSystemPromptHash(systemPrompt);

    // Attachments ride as ModelMessage file parts (the same shape ai's
    // convertToModelMessages emits for FileUIParts on the cloud path), so
    // multimodal models receive them natively from streamText.
    const fileParts = (item.files ?? []).map((f) => ({
      type: 'file' as const, data: f.url, mediaType: f.mediaType, filename: f.filename,
    }));
    this.history.push(fileParts.length > 0
      ? { role: 'user', content: [...fileParts, { type: 'text' as const, text: item.text }] }
      : { role: 'user', content: item.text });

    // Live state (facts, memory tail, executor status, running background work,
    // the open fork roster) rides the dynamic-context ledger — the shared step
    // pipeline re-reads it at EVERY model step and appends a block only when
    // the render changed, weaving the frozen ones back at their birth index.
    // Turn-local state (activation reasons) rides one trailing message for THIS
    // turn only. Neither is ever pushed into the durable history, so the stable
    // prefix stays cacheable.
    const dynamicContext = {
      ledger: this.dynamicLedger,
      snapshot: () => this.dynamicContextSnapshot(memoryTail),
    };
    const turnLocalMsg = turnLocalContextMessage(activeSkills ? { activeSkills } : {});

    const pendingCalls: Array<{ toolName: string; toolCallId: string; args: ToolCallArguments }> = [];
    let fullText = '';
    /** The turn's terminal failure text, persisted on run_end so a post-hoc
     *  read of the log carries the same evidence the cf run_end does. */
    let runError: string | null = null;
    /** Whether the turn was CUT rather than failed. Kept apart from `runError`
     *  because an interrupt throws too, and folding the two together is what
     *  made a user's Stop read as an agent failure in the local run ledger. */
    let interrupted = false;
    const abort = new AbortController();
    this.currentAbort = abort;

    // Steer-drain bookkeeping (Hermes conversation_loop pattern) is the shared
    // core UserSteerDrain — a fresh turn resets its splice coordinates while
    // keeping steers typed for the turn that is about to run. The landed ledger
    // resets with it: its step indices are coordinates INSIDE this turn.
    this.userSteer.beginTurn();
    this.landedSteers = [];

    // The compaction extension + the steer-drain ride the public extension
    // seam — the same host external plugins register on. One hook path, not
    // a private callback + a plugin API.
    // The orchestrator's signal extension registers LAST: its splice must never
    // shift the indices the user-steer drain replays into durable history.
    const extensions = new ExtensionHost()
      .register(this.compactionExtension)
      .register({ name: 'kinu.steering', prepareStep: (ctx) => this.userSteer.prepareStep(ctx) })
      .register(this.orch.turnExtension);
    const cache = this.cacheIdentity();
    const providerOptions = reasoningEffortOptions(
      profile.tier.reasoningEffort,
      parseModelSpec(profile.tier.model).provider,
    );
    // The measured compaction trigger, read from the durable state by core in
    // the one correct order (orchestrator/turn-context.ts). `historyLength` is
    // the durable length the measurement is bound to, so it is also what
    // persistMeasuredPromptTokens writes against at turn end.
    const historyLength = this.history.length;
    const measured = measureCompactionTrigger(this.compactionState, cache.sessionKey, historyLength);
    // Resolved once for the whole turn so compaction, the step-prune budget,
    // and overflow recovery all budget against the same number.
    const contextWindow = this.sessionContextWindow();

    // The turn's inference exactly as it ran, minus the two things that belong
    // to THIS turn and nothing else (its abort signal and its extension host).
    // Kept as a value so the shadow evaluation of a delegating pending scaffold
    // replays the live turn rather than a reconstruction of it — the local peer
    // of the DO's `_lastTurnOpts` stash. `this.history` is snapshotted because
    // the assistant's answer is appended to it before the eval runs.
    const liveTurnOpts: LiveTurnOpts = {
      model,
      modelContext: { id: this.effectiveModelSpec(), contextWindow },
      system: systemPrompt,
      history: [...this.history],
      // Model-capability attachment sanitization — runChat applies it to
      // the whole history BEFORE the transform seam and the ledger weave
      // (same ordering as the DO's beforeTurn); this.history itself is
      // never mutated.
      attachments: {
        accepts: this.sessionAcceptedMedia(), vfs: this.rt.storage.vfs, budget: this.orch.acc.context,
      },
      dynamicContext,
      turnLocal: turnLocalMsg ? [turnLocalMsg] : undefined,
      tools: turnTools,
      transformTrigger: measured.trigger,
      cache,
      budget: this.budget,
    };
    if (measured.providerReportedTokens !== undefined) {
      liveTurnOpts.providerReportedTokens = measured.providerReportedTokens;
    }
    if (providerOptions) liveTurnOpts.providerOptions = providerOptions;
    // `meter` rides the LIVE turn only, never liveTurnOpts: a shadow-eval
    // replay re-runs those opts off the priced path, and its composition would
    // otherwise overwrite the measurement the next real step reports.
    const defaultTurn = runChat({
      ...liveTurnOpts, history: this.history, signal: abort.signal, extensions,
      meter: this.orch.acc.composition,
    });

    // The mutable scaffold on the live turn seam — the local peer of the DO's
    // _transformInferenceResult. An agent still on the bootstrap v0 gets
    // `defaultTurn` back unchanged (same object, zero overhead); once shadow
    // evaluation promotes a scaffold, THAT scaffold is the turn's inference
    // loop, reaching the model and tools only through the host.* bridge.
    const turnStream = scaffoldChatTransform({
      currentVersion: getCurrentScaffoldVersion(this.rt.storage.sql) ?? 0,
      chat: defaultTurn,
      run: {
        rt: this.rt,
        task: item.text,
        llmStream: this.makeScaffoldLLMStream(model, turnTools),
        callTool: this.makeScaffoldCallTool(turnTools),
        history: this.makeScaffoldHistory(),
      },
    });

    try {
      for await (const ev of turnStream) {
        switch (ev.type) {
          case 'text-delta':
            this.orch.acc.onFirstChunk();
            fullText += ev.delta;
            this.emit({ type: 'text-delta', delta: ev.delta });
            break;
          case 'tool-call':
            pendingCalls.push({ toolName: ev.toolName, toolCallId: ev.toolCallId, args: ev.args });
            this.emit({ type: 'tool-call', toolName: ev.toolName, toolCallId: ev.toolCallId, args: ev.args });
            break;
          case 'tool-result': {
            // Pair on the provider's call id — concurrent calls to the same
            // tool make name matching ambiguous.
            const idx = findLastIndexBy(pendingCalls, (c) => c.toolCallId === ev.toolCallId);
            const call = idx >= 0 ? pendingCalls.splice(idx, 1)[0] : undefined;
            // Real success/error into the accumulator — the outcome signal
            // (hadError, turn-outcome review) reads it, matching the cf
            // backend's afterToolCall. A failed tool flags the turn.
            this.orch.acc.recordToolCall(ev.success
              ? { toolName: ev.toolName, input: call?.args ?? {}, success: true, output: ev.result }
              : { toolName: ev.toolName, input: call?.args ?? {}, success: false, error: ev.error ?? ev.result });
            this.emit({ type: 'tool-result', toolName: ev.toolName, toolCallId: ev.toolCallId, result: ev.result, success: ev.success });
            break;
          }
          case 'step-finish': {
            // The step's cumulative response array goes to the shared
            // accumulator, which takes the per-step delta and appends it to the
            // run's durable log — the moment the step finished, before the next
            // request is issued. Without this the turn's model output first
            // reaches disk at `persist()` below, so a kill at step 12 left
            // twelve steps of work nowhere.
            const step: StepLike = { response: { messages: ev.responseMessages } };
            // The chat event already carries the ONE normalized usage, present
            // only when the provider reported something — so it travels whole
            // rather than being taken apart and rebuilt field by field.
            if (ev.usage) step.usage = ev.usage;
            this.orch.acc.recordStep(step);
            break;
          }
          // Only the scaffold seam yields this: a failure the turn survived
          // (a scaffold sub-step, or a scaffold run that died after streaming).
          // Surface it and flag the turn, but let the stream finish.
          case 'error':
            this.orch.acc.hadError = true;
            this.emit({ type: 'error', message: ev.message });
            break;
          case 'done': {
            // Replay the drained steers into the durable history at the exact
            // positions the model saw them (StepInjections.replayInto).
            for (const msg of this.userSteer.replayInto(ev.responseMessages)) this.history.push(msg);
            if (!fullText.trim() && ev.text.trim()) fullText = ev.text;
            break;
          }
        }
      }
    } catch (err) {
      // The model already consumed the drained steers and the surfaces
      // rendered them as sent — a failed stream must not erase them from the
      // live context (their exact splice positions died with the stream, so
      // they append in drain order).
      for (const msg of this.userSteer.recordedMessages()) this.history.push(msg);
      const message = renderThrownChain({ cause: err });
      // `runChat` yields `done` and THEN throws this, so a cut turn arrives here
      // carrying its partial answer. It is not a failure: the accumulator's
      // error flag stays down, and `classifyRunEnd` seals the run 'aborted'.
      interrupted = err instanceof Error && err.message === INTERRUPTED_TURN;
      if (!interrupted) this.orch.acc.hadError = true;
      runError = message.slice(0, 500);
      this.emit({ type: 'error', message });
      // Overflow recovery — the shared core policy, APPLIED by the shared
      // core helper (arm force-compaction + at most one retry enqueue).
      applyOverflowRecovery({
        error: message,
        lastPromptTokens: this.orch.acc.lastPromptTokens,
        contextWindow,
        turnWasOverflowRetry: item.metadata?.kinuEvent === OVERFLOW_RETRY_EVENT,
        state: this.compactionState,
        sessionKey: cache.sessionKey,
        signals: this.orch.signals,
      });
    } finally {
      this.currentAbort = null;
    }

    // Turn over for signal delivery — the same spine the cf backend runs, and
    // for the same reason: it must happen before anything that can throw, so a
    // signal the model never saw always re-delivers — including one that
    // arrived after the final step boundary, which is why this runs after
    // `currentAbort` is cleared rather than inside the stream loop.
    this.orch.signals.settle({ completed: runError === null });

    let assistantMsgId: string | null = null;

    try {
      // The NEXT turn's measured compaction trigger (core turn-lifecycle).
      persistMeasuredPromptTokens(this.compactionState, cache.sessionKey, this.orch.acc.lastPromptTokens, historyLength);

      // Steers that never saw a step boundary (the model was already finishing)
      // run as the IMMEDIATE next turn — ahead of any programmatic injects.
      const leftover = this.userSteer.takeLeftover();
      if (leftover.length > 0) {
        this.queue.unshift({
          text: leftover.map((steer) => steer.text).join('\n\n'),
          files: leftover.flatMap((steer) => steer.files ?? []),
          kind: 'user',
          // Nobody is awaiting this one: its send() already resolved on the turn
          // it was steering into. A refusal is reported by the pump's own
          // diagnostic, and the steer text is still in the durable transcript.
          settle: () => {},
        });
      }

      // The completion gate: on the one-shot surface a turn that did work does
      // not get to be the last word on its own say-so.
      if (this.turnWorkMode !== 'plan') await this.applyCompletionGate(runError === null);

      // One durable row PER steer (not per drain): the walk-back fork pivot
      // matches individual user messages verbatim, exactly as surfaces and the
      // JSONL transcript recorded them. A turn the harness enqueued opens on a
      // `programmatic:`-prefixed row that also carries its provenance — the
      // stamped metadata below is what states authorship at rest; the prefix
      // only keys the idempotency.
      assistantMsgId = this.persist(
        item.kind === 'programmatic'
          ? `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${item.idempotencyKey ?? crypto.randomUUID()}`
          : crypto.randomUUID(),
        item.text,
        // The landed ledger, not `drainedTexts()`: same steers in the same
        // order, but each still carrying the id its queued/landed announcements
        // used and the step index it was spliced into — which is what the
        // durable row is stamped with.
        this.landedSteers,
        fullText,
        item.kind === 'programmatic' ? item.metadata : undefined,
      );

      // Alternate Takes and steer branches were both captured mid-turn, before
      // this id existed, and both are attributed to it — one decision, made by
      // core (orchestrator/turn-lifecycle.ts `creditedTurnId`) rather than once
      // here and again in the cf backend's onChatResponse.
      const credited = creditedTurnId({
        messageId: assistantMsgId,
        completed: runError === null,
        workMode: this.turnWorkMode,
      });
      if (credited !== null) {
        claimAlternateTakesForTurn(this.rt.storage.sql, {
          turnId: credited, sessionId: this.sessionId, startedAt,
        });
      } else {
        purgeUnclaimedAlternateTakes(this.rt.storage.sql);
      }

      // Steer-as-Branch redirects launched during this turn settle against its
      // answer — detached, so a slow branch never delays turn-end. An
      // uncreditable turn settles them against nothing, which is what they
      // report; leaving them pending would strand the surface's live chips.
      this.settlePendingBranches(credited, fullText);

      // The confirming turn is over: what the agent did with its free re-look
      // IS the gate's conversion number, and closeRun writes it.
      if (event === COMPLETION_GATE_EVENT) {
        this.completionGate.settle({ toolCalls: this.orch.acc.toolCalls.length });
      }

      const turn = this.snapshotTurn(item, fullText, assistantMsgId);
      const status = this.closeRun({
        completed: runError === null, interrupted, errorText: runError ?? undefined,
        // Unbounded here (runChat hands `stopWhen` straight to streamText), so
        // this reads 'stop' on a turn that finished by itself. Reported anyway:
        // a caller that does pass a real stop condition gets the same honest
        // 'truncated' seal the cloud loop gets, from the same classifier.
        lastFinishReason: this.orch.acc.lastFinishReason,
      });
      // The settle rule — which turns are recorded, whether a failure is graded
      // evidence, whether extensions see a turn that did not finish — is ONE
      // core decision taken from the run's own verdict. `runChat` already fired
      // this turn's extension end, including for a cut turn, so no `onTurnEnd`
      // is passed. Cadence (turn + session evolution) and the reactor drain
      // happen inside; either may enqueue more.
      // The verdict — completed AND build, ONE core decision read from the
      // beginTurn metadata this session already handed the orchestrator — is
      // what gates every improvement lane below. This backend used to spell
      // its own `!== 'plan'` beside each lane, which is how a turn that FAILED
      // still queued a shadow trial and requested advice while a failed cloud
      // turn fed nothing.
      const { improvementLanesOpen } = await this.orch.settleTurn({
        status, turn, continuity: this.turnContinuity,
      });
      if (improvementLanesOpen) {
        // The turn's contribution to the promotion gate: one row recording the
        // task, the answer, and the conversation it was asked in. The rollout it
        // pays for runs on the cadence lane, which is why this is not tracked —
        // a `kinu exec` process no longer waits out a candidate turn before
        // it can exit.
        this.engine.queueShadowTrial(turn, liveTurnOpts.history);
        this.reviewTurnInBackground(turn, Object.keys(liveTurnOpts.tools ?? {}));
        // Title the workspace from what it is FOR — its mission — falling back
        // to the opening request when it has no mission of its own. Same core
        // policy the cloud backend runs, and one-shot by construction: persisting
        // a title marks `name_origin`, after which the plan can no longer match.
        // Without this call a local workspace showed its raw slug forever while
        // the same workspace on cloud named itself.
        const mission = readMission(this.rt.storage.sql);
        this.autoTitleInBackground(isPlaceholderMission(mission) ? item.text : mission ?? '');
      }
      this.emit({ type: 'turn-end', turn });
    } catch (err) {
      const message = renderThrownChain({ cause: err });
      this.orch.acc.hadError = true;
      // Finalization threw, so whatever the stream reported is superseded by a
      // turn that could not be closed out — and an interrupt does not reach
      // here, since `interrupted` is sealed on the arm above.
      this.closeRun({
        completed: false,
        interrupted: false,
        errorText: runError ?? message.slice(0, 500),
      });
      diagnostics.failure(
        'turn.finalization_failed',
        toKinuError({ doing: 'finalizing the turn', cause: err, otherwise: 'io' }),
      );
      // Any response messages runChat produced remain in live history as a
      // best-effort recovery for later turns in this process. We do not retry
      // potentially partial side effects, and failed persistence cannot survive
      // a restart, so surface both the failure and a terminal turn event.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, fullText, assistantMsgId) });
    }
  }

  /**
   * Auto-title this workspace from what it is FOR — the shared core policy
   * (identity/naming.ts), which both the cloud backend and the create path
   * already run. The CLI called none of it, so a `kinu chat` workspace kept its
   * raw slug forever while the same workspace on cloud named itself.
   *
   * The plan is asked for SYNCHRONOUSLY and first. A titled workspace is the
   * steady state, so every later turn would otherwise pay for a fiber row just
   * to be told there is nothing to do. Once there IS something to do, the fiber
   * is what keeps a one-shot process from exiting through the model call.
   */
  private autoTitleInBackground(mission: string): void {
    const state: WorkspaceTitleState = {
      slug: this.agentName(),
      displayName: this.config.getDisplayName(),
      nameOrigin: this.config.getNameOrigin(),
      mission,
    };
    if (planWorkspaceTitle(state) === null) return;
    // Caught INSIDE the fiber body, not off the returned promise: trackFiber's
    // own `fiber.settle_failed` is for a fiber that could not record its own
    // outcome and states that it has no other reader, so letting this reject
    // would report one titling failure twice under two names.
    void this.trackFiber('workspace.auto_title', async () => {
      try {
        await applyWorkspaceTitle(state, {
          persist: (name) => {
            // A manual rename claimed the title while the model was thinking.
            // The owner's choice wins the race, and `false` says so to core.
            if (this.config.getNameOrigin() === 'user') return false;
            this.config.setDisplayNameOrigin(name, 'auto');
            this.broadcast({ type: 'workspace_renamed', displayName: name });
            return true;
          },
          suggest: (text) => this.suggestTitle(text),
        });
      } catch (err) {
        // The deterministic title has already landed by here, so it stands.
        diagnostics.failure('agent.auto_title_failed', toKinuError({
          doing: 'deriving a title from the mission', cause: err, otherwise: 'unavailable',
        }));
      }
    });
  }

  /**
   * The naming round-trip: the same prompt and parser the create path and the
   * cloud backend use, on the routed `fast` lane.
   *
   * Naming is mechanical work, so it is filed as `fast` and RUN as `fast` — one
   * source name feeds both the route and the spend label through
   * `localRouteLlm`, so what it cost and which model it cost it on cannot
   * disagree.
   */
  private async suggestTitle(mission: string): Promise<string | null> {
    const profile = this.turnProfile ?? await this.profiles().resolvePreTurn();
    const resolution = resolveModelRoute('fast', profile);
    if (!resolution) return null;
    // The prompt pair and the parse are core's; the only local part is which
    // model answers. Not caught here — a failed title is non-fatal, and
    // `autoTitleInBackground` is where that policy is stated.
    return suggestWorkspaceTitle(
      (system, prompt) => this.localRouteLlm(resolution, system).complete(prompt),
      mission,
    );
  }

  /**
   * The mechanical completion gate (core completion-gate.ts) applied to the
   * turn that just ended.
   *
   * A one-shot run is graded on what it leaves behind, with nobody reading the
   * answer — so the harness takes its own look before letting the process go.
   * It reads the working directory through the agent's OWN shell, after the
   * agent stopped, and hands that back as one more turn. Nothing the model says
   * reaches this decision: the trigger is that the turn made tool calls and its
   * stream completed, and the evidence is the harness's own.
   *
   * Appended rather than unshifted: it verifies FINAL state, so anything
   * already queued (a background-job wake, a leftover steer) runs first.
   *
   * The probe goes through the checkpointed shell like every other host
   * command, which is correct in both directions: a turn that already mutated
   * the host filesystem checkpointed before its first mutation and this
   * read-only call dedups against that, and a turn that mutated nothing takes
   * a snapshot of an unmutated tree.
   */
  private async applyCompletionGate(completed: boolean): Promise<void> {
    const shell = this.rt.shell;
    if (!shell) return;
    if (!this.completionGate.shouldGate({ completed, toolCalls: this.orch.acc.toolCalls.length })) return;
    const observed = await observeCompletionState({
      exec: (command) => shell.exec(command),
      vfs: this.rt.storage.vfs,
    });
    // Nothing observable means no evidence to show, and a gate with no evidence
    // is just "are you sure?" — the doctrine-shaped ask this replaces.
    if (observed === null) return;
    this.completionGate.fire();
    this.queue.push({
      text: completionGateText({ task: this.completionGate.task, observed }),
      kind: 'programmatic',
      metadata: { kinuEvent: COMPLETION_GATE_EVENT },
      // The gate fired for THIS process's one-shot turn; a driver that no longer
      // owns the conversation has nothing to confirm, and `fire()` already
      // recorded the gate so it does not re-ask.
      settle: () => {},
    });
  }

  /**
   * The advisor lane: one review of the turn that just ended.
   *
   * Detached, so a reviewer never delays the prompt, and never throws at the
   * turn — a review that failed is a turn with no advice.
   *
   * TRACKED, though. The review is a 5-30s model call that starts after
   * `turn-end`, and a one-shot `kinu exec` used to exit straight through it:
   * no note row, no signal, no event, and no statement that anything had been
   * dropped. Running it as a durable fiber gives it the two things it lacked —
   * a row saying it was in flight, and membership in the set `end()` and
   * `settleBackgroundWork()` join before the database closes.
   *
   * `gateOpen` is the one thing this backend has and the cloud one does not.
   * The completion gate is the other harness-authored message at a turn
   * boundary, and it lives on this surface only. While it is waiting for its
   * answer the advisor records its note instead of saying it, so the one-shot
   * run reads exactly one runtime voice per boundary.
   *
   * Governed off the TURN's labels for the same reason the engine's own review
   * is: this runs after the turn ended, and debiting whatever mission happens
   * to be active later would charge work it did not cause.
   */
  private reviewTurnInBackground(turn: CompletedTurn, reachable: readonly string[]): void {
    const llm = this.rt.advisorLlm;
    if (llm === undefined || !this.config.getAdvisorEnabled()) return;
    const labels = turn.missionLabels ?? [];
    void this.trackFiber('advisor.review', async () => {
      try {
        await runAdvisorLane({
          turn,
          llm: labels.length === 0 ? llm : this.budget.govern(llm, labels),
          enabled: true,
          minSeverity: this.config.getAdvisorMinSeverity(),
          recent: this.engine.recentAdvisorNotes(),
          gateOpen: this.completionGate.open,
          reachable,
          deliver: (signal) => this.orch.signals.deliver(signal),
          record: (note, turnId) => { this.engine.recordAdvisorNote(note, turnId); },
        });
      } catch (err) {
        // Reported here rather than off the returned promise, for the reason
        // autoTitleInBackground states: one failure, one name.
        diagnostics.failure('advisor.review_failed', toKinuError({
          doing: 'reviewing the completed turn', cause: err, otherwise: 'unavailable',
        }));
      }
    });
  }

  /** Settle every branch launched during the just-finished turn (detached —
   *  the shared core settle persists the takes set + broadcasts progress). */
  private settlePendingBranches(turnId: string | null, liveText: string): void {
    settlePendingBranches({
      sql: this.rt.storage.sql,
      sessionId: this.sessionId,
      broadcast: (event: BranchStatusEvent) => this.broadcast(event),
    }, this.pendingBranches, turnId, liveText);
  }

  /** Passthrough SkillsVfs shim over rt.storage.vfs (core turn-surface). */
  private getSkillsVfs(): SkillsVfs {
    if (!this.skillsVfs) this.skillsVfs = skillsVfsOver(this.rt.storage.vfs);
    return this.skillsVfs;
  }

  private agentName(): string {
    try {
      return this.rt.storage.sql<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0]?.name ?? 'local';
    } catch (error) {
      diagnostics.event('local_session.agent_name_unreadable', { error: renderThrownChain({ cause: error }) });
      return 'local';
    }
  }

  /** `agent.compactNow()` — the agent folding a finished phase itself instead
   *  of waiting for the token trigger. It rides the SAME one-shot flag
   *  overflow recovery arms, so there is one forced-rebuild path and a repeat
   *  call can never loop the ladder. The in-flight turn's context is already
   *  assembled, so the fold lands on the next one. */
  armCompactNow(): void {
    this.compactionState.armForceCompaction(this.cacheIdentity().sessionKey);
  }

  /** Prompt-cache identity for runChat: the resolved provider/model, a stable
   *  per-conversation key (the agent's affinity key + session id — same
   *  `kinu-<name>` scheme Workers AI affinity pins with), and the agent's
   *  configured retention. */
  private cacheIdentity(): PromptCacheIdentity {
    const sessionKey = `${agentAffinityKey(this.agentName())}:${this.sessionId}`;
    const retention = this.config.getCacheRetention();
    const spec = this.effectiveModelSpec();
    try {
      const { provider, modelId } = parseModelSpec(spec);
      return { providerId: provider, modelId, sessionKey, retention };
    } catch (error) {
      diagnostics.event('local_session.model_spec_unparseable', { error: renderThrownChain({ cause: error }) });
      return { sessionKey, retention };
    }
  }

  private releaseToolDeps(): ReleaseToolDeps {
    return {
      board: async () => this.releases.board(this.agentName(), 20),
      bindSource: async (input) => this.releases.upsertSourceBinding(input),
      create: async (input) => this.releases.createChange(this.agentName(), input),
      update: async (changeId, patch) => this.releases.updateChange(changeId, patch),
      transition: async (changeId, status) => this.releases.transitionChange(changeId, status),
      recordCheck: async (changeId, input) => this.releases.recordCheck(changeId, input),
      requestApproval: async (changeId, approvalType) => this.releases.requestApproval(changeId, approvalType),
      recordDeployment: async (changeId, input) => this.releases.recordDeployment(changeId, input),
    };
  }

  /** Web search + fetch provider — node fetch, key-less by default
   *  (DuckDuckGo + local HTML→markdown); a stored `tavily` credential resolved
   *  through the model resolver's auth store upgrades search. */
  private getWebSearchProvider(): WebSearchProvider {
    if (this._webSearchProvider) return this._webSearchProvider;
    const getAuth = this.modelResolver?.getAuth;
    const options: Parameters<typeof createDefaultWebSearchProvider>[0] = {
      fetch: globalThis.fetch,
    };
    if (getAuth) options.getAuth = getAuth;
    this._webSearchProvider = createDefaultWebSearchProvider(options);
    return this._webSearchProvider;
  }

  private resolveTurnSkills(
    userText: string,
    roleSkills: readonly string[] = [],
  ): Promise<TurnSkillSurface> {
    return resolveTurnSkills({
      vfs: this.getSkillsVfs(),
      config: this.config,
      userText,
      roleSkills,
    });
  }

  /** Restrict the turn's toolset to the active skills' allowed_tools union
   *  (core turn-surface; the skills tool stays reachable). */
  private filterToolsBySkills(activeSkills?: ActiveSkillSet): ToolSet {
    return filterToolSetBySkills(this.tools, activeSkills);
  }


  /**
   * This session's view for the scaffold evolution control plane: the ports a
   * candidate loop runs against, plus the models it needs. The plane itself is
   * core's (evolution/control.ts) — the same one the cloud backend drives.
   */
  private get scaffoldControl(): ScaffoldControl {
    return {
      rt: this.rt,
      sql: this.rt.storage.sql,
      config: this.config,
      surface: (task, context) => {
        const model = this.ensureModelState();
        return {
          llmStream: this.makeScaffoldLLMStream(model, this.tools),
          callTool: this.makeScaffoldCallTool(this.tools),
          history: this.makeScaffoldHistory(),
          defaultInference: () => this.scaffoldDefaultInference(task, model, context),
        };
      },
      model: () => this.ensureModelState(),
      judge: createLlmJsonJudge(this.rt.judgeModel ?? this.rt.llm),
      reportModelCall: this.modelCallSink,
      operations: this.modelOperations,
    };
  }

  /** `host.defaultInference()` for a scaffold run outside a live turn — the
   *  ordinary local loop over this session's whole tool surface, which is what
   *  the cloud backend's streamText bridge gives a candidate there. `context`
   *  is the conversation a queued trial's turn was asked in, replayed so a
   *  delegating candidate is judged on the scaffold delta rather than on a
   *  handicap; without one the task is all there is. */
  private async *scaffoldDefaultInference(
    task: string, model: LanguageModel, context?: ScaffoldReplayContext,
  ): ReturnType<NonNullable<ScaffoldRunOptions['defaultInference']>> {
    const stream = runChat({
      model,
      modelContext: { id: this.effectiveModelSpec(), contextWindow: this.sessionContextWindow() },
      system: buildSystemPromptSync(this.rt, {
        backend: 'cli-local',
        model: { id: this.effectiveModelSpec() },
        currentDate: currentDateForPrompt(),
      }),
      history: context && context.length > 0 ? [...context] : [{ role: 'user', content: task }],
      tools: this.tools,
    });
    for await (const value of stream) yield { value: projectJsonValue({ value }) };
  }

  /** The pending scaffold's rollout state — trials so far and what the
   *  promotion gate currently says. */
  getShadowStatus(): ShadowStatus {
    return getShadowStatus(this.rt.storage.sql);
  }

  /** Resolve the pending scaffold by hand. 'auto' acts only on a conclusive
   *  promotion gate; 'promote'/'rollback' force the corresponding action. */
  async applyScaffoldDecision(mode: 'auto' | 'promote' | 'rollback'): Promise<ScaffoldDecisionResult> {
    const result = await applyScaffoldDecision(this.scaffoldControl, mode);
    if (result.ok) this.invalidateModelState();
    return result;
  }

  /** Propose a new scaffold version through the existing 4-gate pipeline. An
   *  accepted proposal lands as `pending` and is resolved by the shadow eval. */
  async proposeScaffold(rationale: string, code: string, baseVersion?: number) {
    return proposeScaffold(this.scaffoldControl, rationale, code, baseVersion);
  }

  /** Read-only scaffold archive: versions with status, lineage and shadow record. */
  listScaffoldVersions(limit = 20): ScaffoldVersionView[] {
    return listScaffoldVersions(this.rt.storage.sql, limit);
  }

  /** Run the current scaffold for a one-shot task, capturing what it emits
   *  instead of injecting it into the conversation. */
  runScaffoldOnce(task: string, opts?: { useShadowOverride?: boolean }) {
    return runScaffoldOnce(this.scaffoldControl, task, opts);
  }

  /** Run an arbitrary archived scaffold version against a task — previewing a
   *  candidate live before promoting it. */
  previewScaffoldLive(version: number, task: string) {
    return previewScaffoldLive(this.scaffoldControl, version, task);
  }

  /**
   * A GEPA optimisation pass over this workspace's scaffold. Reflection-mutated
   * candidates are scored against the turn-outcome ledger's held-out failures;
   * a strictly better winner enters the ordinary shadow-eval → promote pipeline.
   * The pass is core's; only the surface it runs on is local.
   */
  runScaffoldGepaOptimization(opts?: {
    maxIterations?: number; evalSize?: number; maxMetricCalls?: number;
  }): Promise<GepaOptimizationResult> {
    return runScaffoldGepaOptimization(this.scaffoldControl, opts);
  }

  /** Recent GEPA passes, newest first. */
  getGepaRuns(limit = 20): GepaRunSummary[] {
    return listGepaRuns(this.rt.storage.sql, limit);
  }

  /** `host.llmStream` — the scaffold's inference bridge (core scaffold-host)
   *  over THIS turn's tool surface. */
  private makeScaffoldLLMStream(model: LanguageModel, turnTools: ToolSet): ScaffoldRunOptions['llmStream'] {
    return createScaffoldLLMStream({
      model,
      tools: () => turnTools,
      spend: {
        source: 'scaffold',
        report: this.modelCallSink,
        operations: this.modelOperations,
      },
    });
  }

  /** `host.callTool` — dispatch into THIS turn's tool surface by name (core
   *  scaffold-host). */
  private makeScaffoldCallTool(turnTools: ToolSet): NonNullable<ScaffoldRunOptions['callTool']> {
    return createScaffoldCallTool(() => turnTools);
  }

  /** `host.history` — a read-only, budgeted page of the conversation the
   *  scaffold is the inference loop for. Resolved per call, so a scaffold that
   *  reads twice in one turn sees the second read's state. */
  private makeScaffoldHistory(): NonNullable<ScaffoldRunOptions['history']> {
    return createScaffoldHistory(() => this.history);
  }

  /** Re-run a task for the replay-eval harness: the current system prompt
   *  (knowledge tail + soul) and model, the facts world model as the same
   *  dynamic-context block live turns get, isolated history, no tools
   *  (see the engine-construction note). */
  private async runReplayTask(task: string): Promise<string> {
    const model = this.ensureModelState();
    const memoryTail = await readMemoryTail(this.rt.memory);
    const systemPrompt = buildSystemPromptSync(this.rt, {
      backend: 'cli-local',
      model: { id: this.effectiveModelSpec() },
      currentDate: currentDateForPrompt(),
    });
    let text = '';
    for await (const ev of runChat({
      model,
      modelContext: { id: this.effectiveModelSpec(), contextWindow: this.sessionContextWindow() },
      system: systemPrompt,
      history: [{ role: 'user', content: task }],
      // A fresh ledger per replay: the same seam live turns use, isolated
      // from the session's own block positions.
      dynamicContext: {
        ledger: new DynamicContextLedger(),
        snapshot: () => ({ factsBlock: this.renderFactsForTurn(), memoryTail }),
      },
      tools: {},
      stopWhen: stepCountIs(1),
    })) {
      if (ev.type === 'text-delta') text += ev.delta;
      else if (ev.type === 'done' && !text.trim()) text = ev.text;
    }
    return text;
  }

  /**
   * The live state of this session, read fresh for ONE model step — the CLI
   * peer of the DO's dynamicContextSnapshot.
   *
   * Every field comes from its existing store, and nothing is clock-derived: a
   * wall-clock field would re-fingerprint the block on every request and append
   * a block per step. `memoryTail` is the turn's read (the one input behind an
   * await), so the caller closes over it.
   */
  private dynamicContextSnapshot(memoryTail: string | undefined): DynamicContext {
    return collectDynamicContext({
      rt: this.rt,
      stores: this.stores,
      memoryTail,
      missingCapabilities: this.mcpUnavailable,
    });
  }

  /** The recent-facts world-model block for the volatile turn context (core
   *  turn-surface — the single seam with the DO backend). */
  private renderFactsForTurn(): string | undefined {
    return renderFactsForTurn(this.factsStore);
  }

  /** Byte-stability telemetry: the system prompt should change only on real
   *  agent events (soul/skill/model). Emits only on change to stay quiet. */
  private lastSystemPromptHash: string | null = null;
  private recordSystemPromptHash(system: string): void {
    const { hash, status } = observeSystemPromptHash(this.lastSystemPromptHash, system);
    // Only the change is worth a line on an interactive stream — a per-turn
    // "still stable" is the noise the telemetry exists to make visible against.
    if (status === 'changed') {
      this.emit({ type: 'evolution', event: 'system_prompt_hash', message: `changed → ${hash}` });
    }
    this.lastSystemPromptHash = hash;
  }

  /** The `agents` tool's swarm substrate. A swarm's nodes run their loops in
   *  this process and get private homes from this workspace's uid-0 view. */
  private buildAgentsForkDeps(): AgentsForkDeps {
    return {
      rt: this.rt,
      model: this.cachedModel ?? this.defaultModel("an agents fork"),
      // Same catalog session that answers the context window and prices the
      // mission ledger — so a search's pre-run estimate and the ledger that
      // later debits it read one rate.
      costModel: () => ({
        spec: this.effectiveModelSpec(),
        pricing: this.modelCatalog.pricing(),
      }),
      // A node's model comes from the tier its profile snapshot names, and only
      // the runner knows which snapshot applies — the caller's on a first
      // attempt, the frozen one on a re-drive. So the model is not pre-resolved
      // here; the resolver is handed over and the runner picks the spec. Without
      // it a swarm carrying a profile refuses rather than silently running the
      // caller's own model under a snapshot claiming the tier's.
      resolveModel: (spec: string) => this.resolveModelForSpec(spec),
      // *Isolation*: this backend's filesystem is in this isolate, so it can hand
      // over the uid-0 view a home is chown'ed with. A runtime built elsewhere
      // (`buildCLIHeadRuntime`, a bare AgentRuntime in a harness) wires none, and
      // then its nodes report `shared-origin-plane` rather than a home they lack.
      nodeHome: this.rt.nodeHome,
    };
  }
  /** Team transport, injected by the owning LocalAgentHost. Present, the
   *  local agent gets hire/ask/send/list/dismiss exactly like a hosted one;
   *  absent keeps the historical one-per-process surface, with those actions
   *  structurally missing from the `agents` tool, the `agents.*` sandbox
   *  namespace and the prompt ladder. */
  private teamDeps: TeamToolDeps | null = null;
  /** Peer transport, injected by the owning LocalAgentHost for a ROOT agent.
   *  Present, this agent can list, ask, send and reply across the equal roots
   *  of its virtual workspace; absent, `reply` does not exist and ask/send
   *  reach subordinates only. A subordinate never gets one. */
  private peersDeps: PeersToolDeps | null = null;
  /** Report transport, injected by the owning LocalAgentHost for a SUBORDINATE.
   *  Present, this agent can tell its parent it finished or is blocked, and the
   *  parent's roster moves off `working` on that signal; absent — every root —
   *  the tool does not exist. */
  private reportDeps: ReportToolDeps | null = null;

  /** The host installs these right after construction — a subordinate roster
   *  and a peer inbox both need the session's own broadcast, which does not
   *  exist yet inside the constructor. */
  setTeam(deps: TeamToolDeps): void {
    this.teamDeps = deps;
  }

  setPeers(deps: PeersToolDeps): void {
    this.peersDeps = deps;
  }

  setReport(deps: ReportToolDeps): void {
    this.reportDeps = deps;
  }

  /**
   * Whether THIS turn may report to a parent.
   *
   * Two conditions, with different lifetimes. Having a parent at all is a
   * property of the agent; being on a turn the parent DROVE is a property of
   * the turn — an owner-driven chat with a subordinate is private to that chat,
   * so a report from it would publish the owner's conversation upward. A
   * parent's assignment arrives as an admitted event and drains as a
   * programmatic turn, which is exactly what distinguishes the two here.
   */
  private reportGateOpen(): boolean {
    return this.reportDeps !== null && this.turnIsParentAssigned;
  }

  private agentsToolDeps(mode: WorkMode): AgentsToolDeps {
    const fork = this.buildAgentsForkDeps();
    const base: AgentsToolDeps = { mode, fork, budget: this.budget };
    base.profile = () => agentsProfileContext(this.turnProfile, this.turnProfileInputs);
    if (this.teamDeps) base.team = this.teamDeps;
    if (this.peersDeps) base.peers = this.peersDeps;
    return base;
  }

  /** The recent conversation handed to each spawned head as inherited context
   *  (core heads-support; capped to bound the head's LLM context). */
  private readInheritedContext(): SerializedMessage[] {
    return inheritedContextFromHistory(this.history);
  }

  /** The shared background wrap (core background-tools) — the SAME wrapper
   *  the cf backend applies: shallow clone, 30s threshold, per-call abort. */
  private wrapToolsForBackground(raw: ToolSet): ToolSet {
    return wrapToolsForBackground(raw, {
      jobRunner: this.jobRunner,
      backgroundable: BACKGROUNDABLE_TOOLS,
      mode: () => this.turnWorkMode,
    });
  }

  /** Persist the exchange (user, any mid-turn steers, assistant) and return the
   *  assistant message id (the turn id the outcome ledger keys on).
   *
   *  `turnId` is the identity of the row that OPENS the exchange: derived from
   *  the producer's name for the fact when the harness enqueued this turn, a
   *  fresh uuid when the operator typed it. `INSERT OR IGNORE` is what makes the
   *  first form idempotent — the primary key refuses a second announcement of
   *  the same fact — and is a no-op for the second, whose id is unique by
   *  construction.
   *
   *  A programmatic row also STATES its provenance: `metadata` is stamped here,
   *  at the one seam every durable CLI turn is written through, so authorship
   *  and event kind live in the row itself. The `programmatic:` id prefix
   *  remains only as the read-side fallback for rows written before the stamp
   *  existed — never the thing a new row leans on.
   *
   *  A steer row states its provenance the same way, under the two keys core
   *  declares for both backends: that it WAS a steer, and the step it was
   *  spliced into. Without them a landed steer is indistinguishable at rest
   *  from an ordinary user turn, and only the parent chain says where it sat. */
  private persist(
    turnId: string,
    userText: string,
    steers: ReadonlyArray<{ id: string; text: string; atStep: number }>,
    assistantText: string,
    metadata?: JsonObject,
  ): string {
    const assistantId = crypto.randomUUID();
    const stamp = metadata === undefined ? null : JSON.stringify(stampTurnAuthor(metadata));
    void this.rt.storage.sql`INSERT OR IGNORE INTO messages (id, session_id, role, content, metadata)
      VALUES (${turnId}, ${this.sessionId}, ${'user'}, ${userText}, ${stamp})`;
    let parentId = turnId;
    for (const steer of steers) {
      const steerStamp = JSON.stringify({
        [STEER_METADATA_KEY]: true,
        [STEER_STEP_METADATA_KEY]: steer.atStep,
      });
      void this.rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content, metadata)
        VALUES (${steer.id}, ${this.sessionId}, ${parentId}, ${'user'}, ${steer.text}, ${steerStamp})`;
      parentId = steer.id;
    }
    void this.rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
      VALUES (${assistantId}, ${this.sessionId}, ${parentId}, ${'assistant'}, ${assistantText})`;

    return assistantId;
  }
  /** One routed non-turn lane as an {@link LLM}: the tier's model, its effort,
   *  and its spend filed under the lane's own source name.
   *
   *  `system` is for the lanes whose prompt is a core-declared pair rather than
   *  one string — workspace titling is the first — so the CLI issues the same
   *  request the cloud backend does instead of folding the system half into the
   *  user half and hoping the model reads it the same way. */
  private localRouteLlm(resolution: ModelRouteResolution, system?: string): LLM {
    const model = this.modelResolver
      ? this.modelResolver.resolveModel(resolution.model)
      : this.defaultModel(`${resolution.source} model lane`);
    return {
      async *stream() { yield ""; },
      complete: async (prompt: string): Promise<string> => {
        const providerOptions = reasoningEffortOptions(
          resolution.reasoningEffort,
          parseModelSpec(resolution.model).provider,
        );
        const request: Parameters<typeof generateText>[0] = { model, prompt };
        if (system !== undefined) request.system = system;
        if (providerOptions) request.providerOptions = providerOptions;
        const result = await generateText(request);
        const report = {
          source: resolution.source,
          spec: resolution.model,
          usage: normalizeUsage(result.usage),
        };
        const modelId = result.response?.modelId;
        this.modelCallSink(modelId
          ? { ...report, modelId }
          : report);
        return result.text.trim();
      },
    };
  }

  /**
   * Restore the session's durable transcript into live context on open.
   *
   * Bounded by what the model could ever be shown at once — the resolved
   * context window — rather than by a message count. The count was 40, was
   * never overridden by anything, and was applied on EVERY reconnect: a
   * session past 40 messages silently lost everything older each time the CLI
   * restarted, with no marker in the transcript and no way for the model to
   * ask what it had lost. Restoring to the window instead hands the whole
   * conversation to the compaction ladder, which is the thing that actually
   * knows how to shed it (summarize, archive verbatim, cite the archive).
   *
   * A session larger than the window still cannot be restored whole, so what
   * did not fit is STATED: the count, and where it is still readable from.
   */
  private restoreHistory(): void {
    const rows = this.rt.storage.sql<{ role: string; content: string }>`
      SELECT role, content
      FROM messages
      WHERE session_id = ${this.sessionId} AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, rowid DESC`;
    const budget = this.sessionContextWindow();
    const restored: ModelMessage[] = [];
    let tokens = 0;
    let omitted = 0;
    for (const row of rows) {
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      if (omitted > 0) { omitted++; continue; }
      const cost = estimateTokens(row.content.length);
      // The newest message is always restored. A single over-window message
      // belongs to the compaction ladder, not an empty-history fallback.
      if (restored.length > 0 && tokens + cost > budget) { omitted++; continue; }
      tokens += cost;
      restored.push({ role: row.role, content: row.content });
    }

    if (omitted > 0) this.history.push(olderHistoryNotice(omitted, this.sessionId));
    this.history.push(...restored.reverse());
  }

  /**
   * The runtime's turn-profile authority, which this session refined at
   * construction. Every catalog read, every provider listing and every
   * resolution goes through it — the session holding its own second copy of
   * that machinery is what let a routed lane and a turn resolve different
   * models, and what left a session-less runtime with no resolution at all.
   */
  private profiles(): LocalProfileAuthority {
    const profiles = this.rt.profiles;
    if (!profiles) {
      throw new Error(
        'this runtime carries no profile authority: build it with createCLIRuntime '
        + '(openWorkspaceCLI) so its model lanes can route',
      );
    }
    return profiles;
  }

  /**
   * Drop the cached provider listing. The caller has changed something the
   * listing depends on and this session cannot observe: a credential added or
   * revoked, a provider connected, a sign-in. The next resolution sweeps again.
   */
  refreshProviderListing(): void {
    this.profiles().refreshListing();
  }

  /**
   * One concrete model from a tier's spec. A static-model session has no
   * registry to resolve against, so it can only answer for its own model —
   * anything else is refused by name rather than silently served the wrong
   * one, which is the whole reason a node's spec travels with it.
   */
  private resolveModelForSpec(spec: string): LanguageModel {
    if (this.modelResolver) return this.modelResolver.resolveModel(spec);
    if (this.profiles().normalizeSpec(spec) === STATIC_MODEL_SPEC) {
      return this.defaultModel(`the ${spec} model`);
    }
    throw new Error(
      `this session cannot resolve ${spec}: it was built with a single static model `
      + `(${STATIC_MODEL_SPEC}) and has no provider registry.`,
    );
  }

  private effectiveModelSpec(): string {
    return this.turnProfile?.tier.model ?? this.cachedModelSpec ?? STATIC_MODEL_SPEC;
  }
  /** The session's model before any per-turn claim: the static model, or
   *  null on resolver sessions until a spec resolves. `what` names the use so
   *  the failure says what could not run rather than that a field was null. */
  private defaultModel(what: string): LanguageModel {
    if (!this.fallbackModel) {
      throw new Error(
        `No default model to run ${what}: set one with /model or kinu model.`
      );
    }
    return this.fallbackModel;
  }

  /** The shared catalog view of the resolved model (core model-catalog —
   *  the DO's exact block): one cached, non-blocking lookup per spec; the
   *  static fallbacks answer until it lands. Feeds BOTH the context-window
   *  budget and the attachment policy. */
  private readonly modelCatalog = new ModelCatalogSession({
    effectiveSpec: () => this.effectiveModelSpec(),
    lookup: (spec) => this.modelResolver ? this.modelResolver.modelInfo(spec) : Promise.resolve(null),
  });

  private sessionContextWindow(): number {
    return this.modelCatalog.contextWindow();
  }

  private sessionAcceptedMedia(): ReadonlySet<MediaModality> {
    return this.modelCatalog.acceptedMedia();
  }

  private ensureModelState(): LanguageModel {
    const spec = this.turnProfile?.tier.model ?? this.profiles().normalizeSpec(this.config.getModel());
    if (this.cachedModel && this.cachedModelSpec === spec) return this.cachedModel;
    const model = this.modelResolver ? this.modelResolver.resolveModel(spec) : this.defaultModel("this static-model session");
    this.cachedModel = model;
    this.cachedModelSpec = spec;
    // Start the catalog lookup at claim time rather than at first use. A CLI
    // process is short-lived — `kinu exec` runs ONE turn — so a lookup that
    // only starts when the first turn assembles would never land in time and
    // that turn would budget against the static table. Still non-blocking:
    // whatever has not landed falls back exactly as before.
    this.modelCatalog.info();
    this.rebuildModelBoundState(model);
    return model;
  }

  private invalidateModelState(): void {
    this.cachedModel = null;
    this.cachedModelSpec = null;
  }

  /**
   * Every codemode namespace this session wires, in one place.
   *
   * ONE list with two readers: the turn resolver asks it which codemode-only
   * capabilities exist so a role can name them, and the tool builder asks it
   * what to narrow. Two lists would let a role allow a capability whose
   * provider is absent, or narrow a set the resolver never saw.
   *
   * Conditionals stay here rather than at either reader: `release` is
   * build-mode only and `llm.query` needs a real provider registry, so a Plan
   * turn and a static-model session each genuinely offer less.
   */
  private codemodeProviders(mode: WorkMode): CodemodeProvider[] {
    const report = this.reportGateOpen() ? this.reportDeps : null;
    return [
      createAgentSelfProvider(this),
      // `agents.*` — the delegation tool projected into the sandbox, over
      // the same deps the top-level tool holds. Locally that is fork only.
      createAgentsCodemodeProvider(() => this.agentsToolDeps(mode)),
      createWebCodemodeProvider(this.getWebSearchProvider()),
      // `memory.*` / `tasks.*` — unconditional codemode projections of
      // the same-named native tools (tools/memory-tool.ts, tools/tasks-
      // tool.ts); `this.taskList` is the SAME TaskListStore instance the
      // dynamic-context snapshot reads.
      // No vectorStore: Vectorize hybrid search is CF-only, same as the
      // native `memory` tool's wiring below (search stays FTS5-only here).
      createMemoryCodemodeProvider(() => ({
        memory: this.rt.memory, facts: this.factsStore, sql: this.rt.storage.sql,
      })),
      createTasksCodemodeProvider(
        this.taskList,
        this.config,
        () => this.turnProfileInputs?.envelope ?? null,
      ),
      // `release.*` — left the native surface for codemode-only reach
      // (tools/release-codemode.ts); deps read live so a rebind lands
      // without rebuilding this toolset.
      ...(mode === 'build' ? [createReleaseCodemodeProvider(() => this.releaseToolDeps())] : []),
      // llm.query (RLM) — CLI parity with the cf backend. Needs a real
      // resolver to spawn sub-calls; static-model sessions have none.
      ...(this.modelResolver
        ? [createRLMProvider(this.modelResolver, () => this.getEffectiveModelSpec())]
        : []),
      // `report.*` — the native report surface projected into the sandbox, on
      // the same gate. Both surfaces of one capability, so a child that reaches
      // for it in code finds it exactly when it finds the tool.
      ...(report ? [createReportCodemodeProvider(() => report)] : []),
    ];
  }

  private rebuildModelBoundState(model: LanguageModel): void {
    // Captured, not re-read: this is the spec `model` was resolved from, so it is
    // what prices the merge call this runtime makes. A later model switch rebuilds
    // the whole runtime, which is what keeps the pair honest.
    const spec = this.effectiveModelSpec();
    // Branching heads — in-process runtime over an isolated ephemeral store.
    // The agent's VFS backs the shared findings scratch sibling heads write to.
    this._headRuntime = createCLIHeadRuntime({
      model: () => model,
      providerFamily: parseModelSpec(spec).provider,
      reportModelCall: (report) => this.modelCallSink({ ...report, spec }),
      operations: this.modelOperations,
      parentRuntime: this.rt,
      webSearch: this.getWebSearchProvider(),
      codemodeExtras: () => this.headCodemodeExtras(),
      grounding: this.buildHeadGrounding(),
      governor: () => this.budget,
      journal: () => this.headJournal,
    });
    for (const mode of ['build'] as const) {
      const deps: ActorToolsetDeps = {
        rt: this.rt,
      // No shellApprovalMode/requestShellApproval here — the gate lives at
      // the execution seam now (rt.shell / rt.executionRouter, wired once in
      // runtime.ts off agent_config live and the channel `setShellApprovalHandler`
      // installs below), not re-derived per toolset build. See
      // execution/approval.ts.
      // The turn's cumulative bulk budget — held on the accumulator so this
      // toolset (rebuilt only on model change) reads the live turn's state.
      contextBudget: this.orch.acc.context,
      // Same ownership for the read-before-edit state and the per-edit outcome
      // counters the `file` tool writes.
      fileLedger: this.orch.acc.files,
      escalations: this.orch.acc.escalations,
      craftedToolExecute: createNodeCraftedExecute(),
        createExecuteTool: createNodeExecuteToolFactory({
          // Narrowed by the SAME set the native surface is narrowed by, so a
          // role cannot lose a tool natively and keep it through the sandbox.
          // An unresolved profile narrows nothing, which is the resolver's own
          // rule for a role that declares no tool list.
          extraProviders: narrowToolSurface(this.turnProfile?.allowedTools)
            .narrowProviders(this.codemodeProviders(mode)),
        }),
        codemodeLoader: { __cli: true },
        agents: this.agentsToolDeps(mode),
        roleAuthority: () => this.turnProfileInputs?.envelope ?? null,
        facts: this.factsStore,
        webSearch: this.getWebSearchProvider(),
        // Structural absence is the gate, and the toolset is rebuilt per turn,
        // so a subordinate carries `report` on the turns its parent drove and
        // on no others.
      };
      // Structural absence is the gate, and the toolset is rebuilt per turn,
      // so a subordinate carries `report` on the turns its parent drove and
      // on no others.
      if (this.reportGateOpen() && this.reportDeps) deps.report = this.reportDeps;
      const raw = buildActorTools(deps);
      this.toolSets[mode] = { raw, wrapped: this.wrapToolsForBackground(raw) };
    }
    this.activateToolMode(this.turnWorkMode);
  }

  private activateToolMode(mode: WorkMode): void {
    const surface = this.toolSets[mode];
    if (!surface) throw new Error(`tool surface for ${mode} mode is unavailable`);
    this.rawTools = surface.raw;
    this.tools = surface.wrapped;
  }
}

export { serializeContentForHeads } from '@kinu.run/core';

interface PromptInputParts {
  text: string;
  files?: ReadonlyArray<PromptFile>;
}

function normalizePromptInput(
  input: string | { text: string; files: ReadonlyArray<PromptFile> },
): PromptInputParts {
  const text = v.safeParse(v.string(), input);
  if (text.success) return { text: text.output };
  return v.parse(v.object({
    text: v.string(),
    files: v.array(v.object({ filename: v.string(), mediaType: v.string(), url: v.string() })),
  }), input);
}


/** Resolve when `work` settles or `ms` elapses, whichever comes first. The timer
 *  is always cleared, so a fast settle leaves nothing holding the event loop. */
async function raceDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try { await Promise.race([work, expiry]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Last index matching the predicate (ES2023 findLastIndex without the lib dep). */
function findLastIndexBy<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}
