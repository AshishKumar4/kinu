/**
 * LocalAgentSession: the local Bun peer of the cf Agents Durable Object, running the same core
 * orchestration through the BackendHost seam. Both CLI frontends drive one via send()/end().
 */

import { realpathSync } from 'node:fs';
import { sameActorReference } from '@kinu.run/core';
import type { ActorHandle } from '@kinu.run/core';
import { resolve } from 'node:path';
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
  ChatOptions,
  TurnContinuity, FiberCtx,
  LLM, ModelCallReport, ModelCallSink, ModelRouteResolution, HeadMergeModelBinding,
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult, PromptFile, SendLanding, SendOptions,
  ActiveSkillSet, TurnSkillSurface, FactsStore, KinuExtension,
  HeadRuntime, HeadGrounding, SerializedMessage, AgentConfigStore, ShellApprovalMode,
  ShellApprovalRequest, ShellApprovalOutcome, RequestShellApproval,
  DeferredApproval, DeferredApprovalAnswer,
  AgentsSwarmDeps, AgentsToolDeps, TeamToolDeps, PeersToolDeps,
  MissingCapability, DynamicApproval,
  RunEvent, RunEventInput, RunEventQuery,
  ReleaseStore, ReleaseToolDeps, BuiltinToolName,
  FileCheckpoints, FileCheckpointListing, FileRestorePlan, FileRestoreResult,
  CheckpointAvailability,
  WorkMode, JsonValue, SessionHistory,
} from '@kinu.run/core';
import { TierIdSchema,
  ActorSession, type ActorTurnLease, type ActorExecutionInput,
  recoverActorTurns,
  type TurnSteering,
  type AgentStores, collectDynamicContext, subordinateDelegatesOf,
  type BackgroundJobStore, BackgroundJobRunner, type TaskListStore,
  backgroundJobNotice,
  DeferredApprovalQueue, DeferredApprovalStore, decideDeferredApprovals,
  wrapToolsForBackground, BACKGROUNDABLE_TOOLS, resumeBackgroundJob, harvestBackgroundJob,
  BACKGROUND_POLICY, type BackgroundPolicy,
  type MctsSearchStore,
  EventLog,
  writeActivityLog,
  type RunEventRecorder,
  TriggerRegistry,
  createTimerTrigger, cancelTrigger, fireDueTriggers,
  EvolutionEngine,
  readMemoryTail,
  agentsActionsFor,
  facetHomeProvisioner, facetHomeReleaser, headAgentName, explorationActorKey,
  type HostedNodeSeat, type NodeIdentity, type ModelPricing,
  type ShadowTrialTurn, type ShadowTrialPlan, type ShadowTrialQueueOutcome, type ShadowTrialDrain,
  type HeadInput,
  type HeadJournal, LiveHeadJournal, type AnnounceHeadActivity, type PublishHeadStream, reconcileInterruptedForks,
  jobRedriveResumeGate, resumableForkRoots,
  resolveTurnSkills, steerSkillsBlock, filterToolSetBySkills, renderFactsForTurn,
  inheritedContextFromTranscript,
  ModelCatalogSession, resolveEffectiveModelSpec,
  BUILTIN_TOOL_NAMES, isMcpToolKey,
  TerminalTransitions, initTerminalEffectTable, declareTerminalRoster, owesShadowTrial,
  takesTerminalEffect, branchesTerminalEffect, turnRecordTerminalEffect,
  eventDrainTerminalEffect, shadowTrialTerminalEffect, overflowRetryTerminalEffect, taskReminderTerminalEffect,
  SUBORDINATE_REPORT_STATUSES,
  type SubordinateReportStatus, type TaskTurnEnding,
  terminalEffect,
  RunEndReasonSchema, WorkModeSchema,
  shadowTrialPlan, trimTrialContext,
  type TerminalTransition, type TerminalEffectTable, type TerminalEffectFault,
  type TerminalTurnFacts, type TerminalTurnParts, type OwedEffect,
  buildActorTools, buildMcpToolSet, buildSystemPromptSync, currentDateForPrompt,
  type ActorToolsetDeps,
  activePromptSectionOverrides,
  turnProvenanceForMetadata,
  runChat, type CountableRequest,
  parseModelSpec, agentAffinityKey,
  normalizeUsage,
  measureCompactionTrigger,
  observeCompletionState, completionGateText, COMPLETION_GATE_EVENT,
  AdvisorRecoverySnapshotSchema,
  ADVISOR_LANE_FIBER, reviewRecordedTurn,
  advisorWorkspaceGuidance,
  createDefaultWebSearchProvider, createWebCodemodeProvider, REAL_CLOCK, type Clock, type WebSearchProvider,
  createAgentsCodemodeProvider, createReleaseCodemodeProvider, createStateCodemodeProvider,
  type CodemodeProvider,
  createMemoryCodemodeProvider, createTasksCodemodeProvider,
  createReportCodemodeProvider, REPORT_TOOL, type ReportToolDeps,
  MissionGovernor,
  DynamicContextLedger, turnLocalContextMessage, unverifiedInstructionsMessage,
  observeSystemPromptHash,
  type DynamicContext,
  createReleaseStore, initReleaseTables, releaseSqlFromExec,
  initWorkspaceBaselineTable, initWorkspaceSchema, initPendingSendTables, PendingSendStore,
  InstructionApprovalStore, InstructionApprovalDesk, type AdmittedInstructionDecision,
  type InstructionSourceRow, type InstructionSourceView,
  type InstructionTrustResolver,
  applyScaffoldDecision, createLlmJsonJudge, getShadowStatus, runScaffoldGepaOptimization,
  queueTurnShadowTrial, runQueuedShadowTrials,
  type GepaOptimizationResult, type ScaffoldControl,
  type ScaffoldDecisionResult, createScaffoldCandidateSurface,
  type ShadowStatus,
  decideRefinementRoute, listRefinements, refinementPass, requestOwnerRefinement, showRefinementRoute,
  type RefinementDecisionInput, type RefinementDecisionResult,
  type StagedSkillResult,
  type RefinementDeps, type RefinementRequestView, type RefinementScope,
  revertChangelogEntryById, type ChangelogRevertResult,
  unclaimedAlternateTakeIds,
  latestAlternateTakeSet,
  type ScaffoldRunOptions,
  bootstrapScaffold,
  createScaffoldHistory,
  type AlternateTakeSet, type TakePickOutcome,
  startBranchHead, newBranchId,
  type PendingBranch, type BranchStatusEvent,
  type AlarmScheduler, type BackgroundJob,
  type TimerTrigger, type TimerTriggerOpts,
  type CancelTriggerResult, type TrustLevel,
  reasoningEffortOptions,
  BUILTIN_PROFILE_CATALOG, effectiveRoleCatalog,
  changeRoleAsOwner, agentsProfileContext, canonicalConversationId,
  resolveAgentTurnProfile, resolveModelRoute, resolveRoutingProfile, currentOperationProfile,
  buildModelCallEvent,
  applyWorkspaceTitle, persistAutoTitle, planWorkspaceTitle, suggestWorkspaceTitle,
  type WorkspaceTitleState,
  type PromptIdentity,
  narrowToolSurface, codemodeCapabilitiesFor,
  readSoul,
  type ResolvedTurnProfile, type TierId,
  decodeJsonValue, projectJsonValue, JsonValueSchema,
  agentSelfHost, createAgentSelfProvider,
  cancelBackgroundJob, jobResult, listBackgroundJobs,
  getAlwaysActiveSkills, getProviderAccounts, workspaceSpend, type WorkspaceSpend, callAccountOf, getReasoningEffort, getShellApprovalMode, getStoredModelSpec,
  getShellApprovalGrants, revokeShellApprovalGrants, gatedGrants, type ApprovalGrant,
  setAlwaysActiveSkills, setModel, setProviderAccount, setReasoningEffort, setShellApprovalMode,
  getEvolutionChangelog, markChangelogSeen, pickAlternateTake,
  type EvolutionChangelogView,
  getRunEvents, listRuns, type RunListEntry, type Page, type PageRequest,
  WORKSPACE_RUN_ID,
  recordModelOperations, type ModelOperationSink,
  admitMcpDescriptors, toolSurfaceTokens, toolsInWorkMode, toolSchemaDialect, withToolSchemaDialect,
  createActorHost, defaultLoopOrigin, createDbCodemodeProvider,
  type ActorHost, type AgentRuntime, type HostedActor, type SqlExec, type ProfileAuthorityInputs,
  type AgentOrchestratorDeps, type LoopOrigin, type WriteObserver,
  PlanReviewActions, SUBMIT_PLAN_TOOL, workModeUnderReview,
  type PlanDecisionOutcome, type PlanEdit, type PlanReview, type PlanReviewAnnotation, type PlanReviewDecision,
  type PlanReviewResult,
  ChatSession, CHAT_SESSION_ID, CHECKPOINTS_UNCONFIGURED, checkpointAvailability, fileCheckpointListing,
  type ChatTurnInput, type PreparedTurn, type OwedTerminalEffectsInput, type SessionEvent,
} from '@kinu.run/core';
import {
  diagnostics, KinuError, renderThrownChain, tolerate, toKinuError, type Refusal,
} from '@kinu.run/core/obs';
import { buildLocalActorRuntime, cleanupFacetCwdScratch, makeSqlExec, type CLIRuntime } from './runtime';
import { localActorDirectory, registerLocalActor, retireLocalActor, registerLocalNode, requireLocalActorWorkspace, localActorMission } from './actor-identity';
import { discoverAgentsMd } from './agents-md';
import { createNodeCraftedExecute } from './craft-executor';
import { createNodeCodemodeToolFactory } from './codemode-tool-factory';
import { createCLIHeadRuntime, hostedCodemodeTool, type CLIHeadRuntimeDeps, type HostedHeadSeat } from './head-runtime';
import { detectOrphanedFibers, type OrphanedFiber } from '@kinu.run/core';
import { connectMcpServers, type McpServerConfig } from './mcp';
import type { LocalModelResolver } from './model-resolver';
import {
  STATIC_MODEL_SPEC, resolverModelPlane, staticModelPlane,
  type LocalProfileAuthority, type ProfileAuthorityRefinement, type ProfileEnvelopeSource,
} from './profile-authority';

/**
 * This session's actor as the root's host bound it. Absent: the session owns its actor outright
 * (`kinu evolve`, `kinu exec`, fixtures). Present: a {@link LocalAgentHost} bound it over the one database.
 */
export interface LocalHostedSession {
  readonly actor: HostedActor;
  readonly host: ActorHost;
  readonly engine: EvolutionEngine;
  readonly budget: MissionGovernor;
  readonly eventLog: EventLog;
}

/**
 * One construction site for hosted and standalone orchestration. `orchestrationFor` runs before the
 * `ActorSession` exists, so every port resolves the driving session at call time.
 */
export interface LocalOrchestration {
  readonly deps: AgentOrchestratorDeps;
  readonly engine: EvolutionEngine;
  readonly budget: MissionGovernor;
  readonly eventLog: EventLog;
}

export interface LocalOrchestrationInput {
  readonly runtime: AgentRuntime;
  readonly history: SessionHistory;
  readonly eventLog: EventLog;
  readonly session: () => LocalAgentSession;
  /** This host runs one task turn and exits; it never starts the cadence. */
  readonly oneShot: boolean;
  readonly noAutoEvolve?: boolean;
}

export function createLocalOrchestration(input: LocalOrchestrationInput): LocalOrchestration {
  // Opt-in spend governor: no label means no cap.
  const budget = new MissionGovernor({
    actor: input.runtime.actor,
    storage: input.runtime.storage,
    // Null until the pricing lookup lands; the ledger then blends and says so.
    pricing: (spec) => input.session().modelPricing(spec),
    onExhausted: ({ error: _error, ...refusal }) => { input.session().reportBudgetRefusal(refusal); },
  });

  const engine = new EvolutionEngine(input.runtime, input.history, {
    enabled: input.noAutoEvolve !== true,
    // Review calls debit the reviewed turn's mission.
    governor: budget,
    reportModelCall: (report) => { input.session().reportModelCall(report); },
    // Local replay runs with tools disabled: re-running tools would re-execute shell work on the
    // user's machine, so CLI replay measures prompt/model config only.
    replayTaskRunner: (task) => input.session().runReplayTask(task),
    shadowTrialQueue: (turn, opts) => input.session().queueShadowTrial(turn, opts),
    // A resolved gate swaps the live scaffold, so model-bound state is dropped.
    shadowTrialRunner: () => input.session().runShadowTrials(),
  });

  engine.onEvent((event) => { input.session().reportEvolutionEvent(event); });

  const reportRunEvent = (event: Extract<RunEventInput, { type: 'tool_call_end' | 'step_finish' }>): void => {
    input.session().reportActorRunEvent(input.runtime.actor, event);
  };

  return {
    engine,
    budget,
    eventLog: input.eventLog,
    deps: {
      host: {
        broadcast: (event) => { input.session().broadcast(event); },
        enqueueTurn: (turn) => input.session().enqueueTurn(turn),
        // Answers false rather than throwing when the seat is gone: `settled`/`busy` can call it after
        // host teardown. The cf seam (`seams.turnInFlight`) does the same.
        turnInFlight: () => {
          try {
            return input.session().turnInFlight();
          } catch (cause) {
            if (cause instanceof KinuError && cause.code === 'missing') return false;
            throw cause;
          }
        },
        setTimer: (fn, ms) => { input.session().setTimer(fn, ms); },
        reconcileDurableWake: null,
      },
      engine,
      eventLog: input.eventLog,
      budget,
      oneShot: input.oneShot,
      refinementLane: () => input.session().runRefinementLane(),
      sinks: {
        logActivity: (event, detail) => { input.session().logActivity(event, detail); },
        onToolCallEvent: (ev) => { reportRunEvent({ type: 'tool_call_end', ...ev }); },
        onStepEvent: (ev) => { reportRunEvent({ type: 'step_finish', ...ev }); },
      },
    },
  };
}

type PromptCacheIdentity = NonNullable<ChatOptions['cache']>;

type Writable<T> = { -readonly [Key in keyof T]: T[Key] };

/**
 * Per-message aggregate cap on raw attachment bytes inlined as data URLs. The cloud cap
 * (CLOUD_MAX_INLINE_ATTACHMENT_BYTES, 1 MiB) comes from `do.sqlite.row_bytes`; locally the bound is
 * the provider request: base64 of 8 MiB raw ≈ 11 MB, re-sent every later turn. Larger stays a path.
 */
export const LOCAL_MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** bun:sqlite with a real `transaction`: approval migration and settled-turn commits need atomicity. */
export type LocalSessionDb = Pick<Database, 'prepare' | 'transaction'>;

/** Core's advisor recovery snapshot plus the completion gate's armed state, which is RAM-only
 *  here; recording it lets a replayed review reach the verdict the turn earned. */
const RecordedAdvisorSchema = v.object({
  ...AdvisorRecoverySnapshotSchema.entries,
  gateOpen: v.boolean(),
});

type RecordedAdvisor = v.InferOutput<typeof RecordedAdvisorSchema>;

/**
 * The answer a subordinate's turn owes its parent, installed by the owning host. A port, not a
 * listener: the report is an owed effect that must survive a process death.
 */
export interface LocalParentRelay {
  /**
   * Which report this ending owes, or null. A `task` child owes one on every ending; a `durable`
   * child only for a completed, parent-driven turn with something to say and no `report` call.
   */
  readonly owed: (
    ending: TaskTurnEnding, assistantText: string,
  ) => { readonly status: SubordinateReportStatus; readonly content: string } | null;
  /** Dedupe key on the parent's rail, so a replay cannot wake it twice. */
  readonly sequenceId: (messageId: string) => string;
  readonly send: (report: {
    readonly text: string;
    readonly status: SubordinateReportStatus;
    readonly mode: WorkMode;
    readonly sequenceId: string;
  }) => Promise<string>;
}

export type { SessionEvent } from '@kinu.run/core';

/** Resolving null leaves the standing approval mode's answer in force. */
export type ShellApprovalHandler =
  (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>;

/** A turn that neither completed nor was interrupted failed; the parent is owed that. */
function taskTurnEnding(completed: boolean, interrupted: boolean): TaskTurnEnding {
  if (completed) return 'answered';

  if (interrupted) return 'interrupted';

  return 'errored';
}

export interface LocalAgentSessionOpts {
  rt: CLIRuntime;
  db: LocalSessionDb;
  /** Required on a static session (no modelResolver); otherwise only the pre-claim fallback. */
  model?: LanguageModel;
  modelResolver?: LocalModelResolver;
  profileAuthority?: ProfileEnvelopeSource;
  /**
   * Provider-config revision, read live. The listing is invalidated by signal only, and
   * `kinu provider connect` runs in another process; comparing this number is that signal.
   */
  providerRevision?: () => number;
  onEvent: (event: SessionEvent) => void;
  noAutoEvolve?: boolean;
  /** One task turn then exit (`kinu exec`/`kinu run`): the next prompt never grades the previous
   *  turn, and the evolution pass is left to the scheduler daemon. */
  oneShot?: boolean;
  /** Directory for AGENTS.md and runtime context; defaults to the runtime's bound plane. */
  cwd?: string;
  /** The workspace title, on a subagent session; a child's config holds only its own title. */
  workspaceTitle?: () => string | null;
  /** Background cutoff and teardown wait (BACKGROUND_POLICY). Default: interactive. */
  backgroundPolicy?: BackgroundPolicy;
  /** Times the teardown grace. Default: the wall clock. */
  clock?: Clock;
  /** The actor as the root's {@link LocalAgentHost} bound it; absent when this session owns it. */
  hosted?: LocalHostedSession;
}

const TurnTierMetadataSchema = v.object({
  profile_tier: v.optional(TierIdSchema),
});

function tierFromMetadata(metadata: ProgrammaticTurn['metadata']): TierId | undefined {
  if (metadata === undefined) return undefined;
  const parsed = v.safeParse(TurnTierMetadataSchema, metadata);

  return parsed.success ? parsed.output.profile_tier : undefined;
}

export class LocalAgentSession implements BackendHost {
  private readonly rt: CLIRuntime;
  private readonly fallbackModel: LanguageModel | null;
  private readonly modelResolver: LocalModelResolver | null;
  private cachedModel: LanguageModel | null = null;
  private cachedModelSpec: string | null = null;
  private tools: ToolSet = {};
  private readonly toolSets: Partial<Record<WorkMode, { raw: ToolSet; wrapped: ToolSet }>> = {};
  private readonly engine: EvolutionEngine;
  private readonly actorSession: ActorSession;
  /** The core turn loop; this session is its adapter. */
  private readonly chat: ChatSession;
  private readonly deferrals: DeferredApprovalQueue;
  /** Host for every logical actor this session creates; built here when no {@link LocalAgentHost} owns the tree. */
  private readonly actorHost: ActorHost;
  /** Loop origin each created actor was named with, read by `loopFor` before the first claim. */
  private readonly loopOrigins = new Map<string, LoopOrigin>();

  /** The origin recorded for an actor about to be seated. Public: the daemon's host resolves the loop,
   *  but only the seating session knows what was named. */
  pendingLoopOrigin(actorId: string): LoopOrigin | undefined {
    return this.loopOrigins.get(actorId);
  }
  /**
   * Write observer for each seat, filled before `acquire` and read by `runtimeFor`. Do not add a
   * parameter to `runtimeFor` for this. Cleared on release so the next seat cannot inherit it.
   */
  private readonly actorWrites = new Map<string, WriteObserver>();
  /** Actor ids seated as swarm nodes (head rows with node mode). Never cleared: a repeat acquire
   *  must take the same arm. */
  private readonly nodeSeats = new Set<string>();

  get steering(): TurnSteering {
    return this.actorSession.orchestrator.steering;
  }

  private readonly stores: AgentStores;
  private readonly jobs: BackgroundJobStore;
  private readonly taskList: TaskListStore;
  private readonly jobRunner: BackgroundJobRunner;
  private readonly clock: Clock;
  /** Durable MCTS checkpoint, so an interrupted think(mcts) resumes instead of losing its budget. */
  private readonly mctsSearchStore: MctsSearchStore;
  private readonly factsStore: FactsStore;
  private readonly config: AgentConfigStore;
  private readonly eventLog: EventLog;
  private readonly eventRecorder: RunEventRecorder;
  /** Label-scoped spend governor; public for the `agent.*` namespace. */
  readonly budget: MissionGovernor;
  /** Cost sink for every non-turn model call (judge, fast tier, reflection, merge synthesis),
   *  which `step_finish` never sees. */
  private readonly modelCallSink: ModelCallSink = (report) => {
    const event = buildModelCallEvent(report, {
      effectiveSpec: this.effectiveModelSpec(),
      pricing: this.modelCatalog.pricing(),
    });

    // Calls between runs are filed under the reserved workspace run rather than dropped.
    this.recordRunEvent(event, currentOperationProfile(this.rt.actor)?.runId ?? this.chat.currentRunId ?? WORKSPACE_RUN_ID);
  };

  /** Start/end records for direct model operations; a start with no end names a dead process's call. */
  private readonly modelOperations: ModelOperationSink = recordModelOperations(
    { emit: (runId, input): void => { this.recordRunEvent(input, runId); } },
    () => currentOperationProfile(this.rt.actor)?.runId ?? this.chat.currentRunId ?? WORKSPACE_RUN_ID,
  );
  private readonly triggerRegistry: TriggerRegistry;
  private readonly releases: ReleaseStore;
  private _webSearchProvider: WebSearchProvider | null = null;
  private _planActions: PlanReviewActions | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledAlarmAt: number | null = null;
  private _headRuntime: HeadRuntime;
  private shellApprovalHandler: ShellApprovalHandler | null = null;
  private pendingShellApproval: DynamicApproval | null = null;
  private shellApprovalSequence = 0;
  private readonly sessionId: string;
  private readonly oneShot: boolean;
  /** A one-shot process holds no conversation, so its prompt is never a verdict on the prior turn. */
  private get turnContinuity(): TurnContinuity {
    return this.oneShot ? 'independent_task' : 'conversation';
  }
  private readonly cwd: string;
  /** Owner approvals deciding whether AGENTS.md / skill bytes are system instructions or reference. */
  private readonly instructionApprovals: InstructionApprovalStore;
  private readonly instructionDesk: InstructionApprovalDesk;
  private readonly instructionTrust: InstructionTrustResolver =
    (path, content) => this.instructionApprovals.trustOf(path, content);
  /** Whether this turn came from the parent; gates the `report` surface. */
  private turnIsParentAssigned = false;

  private readonly headJournal: HeadJournal;
  private readonly headActivity: AnnounceHeadActivity = (headId) => {
    this.broadcast({ type: 'head_activity', headId });
  };
  private readonly publishHeadStream: PublishHeadStream = (frame) => {
    this.broadcast({ type: 'head_stream', ...frame });
  };

  private readonly compactionState: CompactionStateStore;
  private readonly compactionExtension: KinuExtension;

  private extraTools: ToolSet = {};
  private mcpClose: (() => Promise<void>) | null = null;

  /** Steer-as-Branch redirects; each runs as a budgeted head and settles into Alternate Takes. */
  private readonly pendingBranches: PendingBranch[] = [];
  /** The raw handle, for the transactions the SqlExecutor port cannot express. */
  private readonly db: LocalSessionDb;
  private readonly workspaceTitleSource: (() => string | null) | null;

  constructor(opts: LocalAgentSessionOpts) {
    this.db = opts.db;
    this.rt = opts.rt;
    this.clock = opts.clock ?? REAL_CLOCK;
    this.oneShot = opts.oneShot === true;
    this.cwd = opts.cwd ?? this.rt.cwd ?? process.cwd();
    this.workspaceTitleSource = opts.workspaceTitle ?? null;
    this.fallbackModel = opts.model ?? null;
    this.modelResolver = opts.modelResolver?.withAccountChoice?.((provider) => this.accountChoice(provider))
      ?? opts.modelResolver ?? null;
    this.rt.setModelForRoute?.((resolution) => this.localRouteLlm(resolution));

    if (!opts.model && !this.modelResolver) {
      throw new Error(
        'No model for this session: construct it with a modelResolver or a static model.'
      );
    }

    // Ensure every workspace table exists: the database may be untouched (benchmark harness, fresh clone).
    const hubSql = makeSqlExec(opts.db);
    initWorkspaceSchema({
      execRaw: this.rt.storage.execRaw, sql: this.rt.storage.sql, exec: hubSql, transactionSync: (write) => this.rt.storage.transactionSync(write),
    });

    // One engine, governor and event rail per logical actor: hosted, the root's host built them.
    const own = opts.hosted ? null : createLocalOrchestration({
      runtime: this.rt,
      history: this.rt.stores.history,
      eventLog: new EventLog(hubSql, this.rt.actor),
      session: () => this,
      oneShot: this.oneShot,
      noAutoEvolve: opts.noAutoEvolve === true,
    });

    const orchestration = opts.hosted ?? own;

    if (!orchestration) throw new KinuError('missing', 'This session has no orchestration to run its loop under.');
    this.budget = orchestration.budget;
    this.engine = orchestration.engine;
    this.eventLog = orchestration.eventLog;

    initWorkspaceBaselineTable(this.rt.storage.execRaw);
    initTerminalEffectTable(this.rt.storage.execRaw);
    // `turn_id` is NULL when the send queued while the actor was idle.
    initPendingSendTables(this.rt.storage.execRaw);
    const pendingSends = new PendingSendStore(this.rt.storage.sql, this.rt.actor.actorId);

    // Approvals are keyed by the realpath of this directory; a deleted cwd still gets an absolute
    // scope so it cannot share another tree's approvals.
    const approvalScope = tolerate(() => realpathSync(this.cwd), 'enoent') ?? resolve(this.cwd);
    // Keyed `(actor_id, scope, path)`: actors share decisions via the scope string, not the store object.
    this.instructionApprovals = new InstructionApprovalStore(
      this.rt.storage.sql,
      this.rt.actor,
      `local:${approvalScope}`,
    );
    this.instructionDesk = new InstructionApprovalDesk({
      agentsMd: async (window, trust) => discoverAgentsMd(this.cwd, window, trust),
      skillsVfs: this.rt.storage.vfs,
      approvals: this.instructionApprovals,
      window: () => this.modelCatalog.window(),
    });

    // Hosted, these are the stores the root's host bound; a second set would be a second memo.
    this.stores = opts.hosted?.actor.stores ?? this.rt.stores;
    const stores = this.stores;
    this.jobs = stores.jobs;
    this.taskList = stores.taskList;
    this.headJournal = new LiveHeadJournal(this.rt.storage.sql, this.rt.actor, this.headActivity);
    this.mctsSearchStore = stores.mctsSearchStore;
    this.config = stores.config;
    this.sessionId = canonicalConversationId(this.config);

    // Refine the runtime's profile authority rather than install a second resolver, so lanes and turns agree.
    const refinement: ProfileAuthorityRefinement = {
      plane: this.modelResolver
        ? resolverModelPlane(this.modelResolver, opts.providerRevision)
        : staticModelPlane(),
      record: (event) => { this.recordRunEvent(event); },
    };

    if (opts.profileAuthority) refinement.envelope = opts.profileAuthority;
    // Not optional-chained: a runtime without an authority should fail here, not at the first lane.
    this.profiles().refine(refinement);
    this.factsStore = stores.facts;
    this.eventRecorder = stores.eventRecorder;

    // The release board is local-only; on cf it lives in UserDO (core/conformance/manifest.ts).
    initReleaseTables(hubSql);
    this.releases = createReleaseStore(releaseSqlFromExec(hubSql), {
      validateAgentName: (name) => {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('invalid agent name');
      },
    });
    this.actorHost = opts.hosted?.host ?? this.buildOwnActorHost(hubSql);

    const alarmScheduler: AlarmScheduler = {
      // Synchronous locally (a process timer); the seam is async because the cloud arm is a Durable
      // Object write that must land inside its invocation (`do.wait_until.no_op`).
      scheduleAt: async (ts) => { this.scheduleLocalAlarm(ts); },
    };

    this.triggerRegistry = new TriggerRegistry(hubSql, this.rt.actor, alarmScheduler);

    // Forwarded to frontends too: a benchmark container or one-shot exec never outlives the database.
    this.eventRecorder.observe((event) => this.emit({ type: 'run-event', event }));

    // Hosted, this is the same ActorSession the host holds, so spawned heads claim turns on it.
    this.actorSession = 'actor' in orchestration ? orchestration.actor.session : new ActorSession({
      runtime: this.rt,
      claims: this.stores.claims,
      history: this.stores.history,
      // No build identity for the builtin loop: a `bun`-run checkout has no build stamp.
      installedBuild: null,
      events: this.eventRecorder,
      orchestration: orchestration.deps,
    });

    this.compactionState = createCompactionStateStore(this.rt.storage.sql, this.rt.actor);
    this.chat = new ChatSession({
      actorSession: this.actorSession,
      sessionId: this.sessionId,
      transcript: this.stores.history.transcript(CHAT_SESSION_ID),
      mintAnswerId: () => crypto.randomUUID(),
      pendingSends,
      eventLog: this.eventLog,
      eventRecorder: this.eventRecorder,
      compactionState: this.compactionState,
      // `rt.storage.sql` and `db` are the same connection.
      transaction: (body) => this.db.transaction(body)(),
      transport: { deliver: (event) => { opts.onEvent(event); } },
      ports: {
        prepareTurn: (item, lease) => this.prepareTurn(item, lease),
        // Only a root chat can approve a plan; a subordinate's plan is refused at admission.
        planTurnRefusal: () => this.planReviewSurface()
          ? null
          : 'Plan review belongs to the owner of this workspace; a delegated task reports its result instead.',
        owedTerminalEffects: (input) => this.owedTerminalEffects(input),
        taskList: () => this.taskList,
        // A running job's settle wakes the session; a reminder would race it.
        hasPendingAsyncWake: () => this.jobs.listRunning(1).total > 0,
        terminal: () => this.terminal,
        holdTerminalClose: (transition, close) => { this.holdTerminalClose(transition, close); },
        driverGate: () => this.driverGate?.() ?? null,
        // No durable wake: this process is the wake, and a crashed turn re-arms from the ledger on restart.
        armTurnWake: async () => {},
        steerSkills: (text) => steerSkillsBlock({
          vfs: this.rt.storage.vfs,
          config: this.config,
          userText: text,
          trust: this.instructionTrust,
          limits: this.modelCatalog.window(),
          alreadyActive: new Set(this.turnActiveSkillNames),
        }),
      },
    });
    // The resolver predates this session, so the wait sink is installed. Notices land as
    // `provider_wait` run events; `recordRunEvent` contains its own failures.
    this.modelResolver?.setProviderWaitSink?.((info) => {
      this.recordRunEvent(
        {
          type: 'provider_wait',
          provider: info.provider,
          waitMs: info.waitMs,
          attempt: info.attempt,
          source: info.source,
          ...(info.modelId !== undefined && { modelId: info.modelId }),
          ...(info.status !== undefined && { status: info.status }),
        },
        currentOperationProfile(this.rt.actor)?.runId ?? this.chat.currentRunId ?? WORKSPACE_RUN_ID,
      );
    });
    this.compactionExtension = createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => this.rt.storage.vfs),
        plans: this.compactionState.plans,
        logger: {
          info: (message) => { diagnostics.event('compaction.info', { message }); },
          debug: (message) => { diagnostics.event('compaction.debug', { message }); },
          warn: (message) => { diagnostics.failure('compaction.degraded', new KinuError('unavailable', message)); },
          error: (message) => { diagnostics.failure('compaction.failed', new KinuError('io', message)); },
        },
      },
      archive: this.compactionState.archive,
      summarize: createModelSummarizer(() => this.ensureModelState(), {
        source: 'compaction', report: (report) => this.modelCallSink(report),
      }),
      ephemeral: this.actorSession.dynamic,
      onOutcome: ({ outcome }) => {
        if (outcome !== 'replayed') this.actorSession.dynamic.reset();
      },
    });
    this._headRuntime = createCLIHeadRuntime(this.headRuntimeOptions(
      () => this.cachedModel ?? this.defaultModel("a head with no model of its own"),
    ));
    this.rt.setTurnFileLedgerProvider?.(() => this.actorSession.orchestrator.acc.files);
    // The runtime's judge/fast/reflection seams predate this session; a runtime holds one sink.
    this.rt.setModelCallSink?.(this.modelCallSink);
    this.rt.setModelOperations?.(this.modelOperations);
    this.deferrals = new DeferredApprovalQueue({
      store: new DeferredApprovalStore(this.rt.storage.sql, this.rt.actor),
      inbox: this.actorSession.orchestrator.inbox,
      remember: (grants) => { this.config.grantShellApproval(grants); },
      audit: (record) => {
        this.eventRecorder.emit(this.chat.currentRunId ?? WORKSPACE_RUN_ID, { type: 'approval_consumed', ...record });
      },
      announce: () => { this.broadcast({ type: 'pending_actions_changed' }); },
    });

    this.rt.setApprovalDeferrals?.(this.deferrals.channel);
    this.jobRunner = new BackgroundJobRunner({
      store: this.jobs,
      policy: () => opts.backgroundPolicy ?? BACKGROUND_POLICY.interactive,
      fiber: (name, fn) => this.trackFiber(name, fn),
      inbox: this.actorSession.orchestrator.inbox,
      eventLog: this.eventLog,
      scheduleDrain: () => this.actorSession.orchestrator.scheduleDrain(),
      logActivity: (event, detail) => this.emit({ type: 'background', event, message: detail ?? '' }),
      onDetached: null,
      onCancelled: null,
      onSettled: (job) => {
        const notice = backgroundJobNotice(job);
        this.emit({ type: 'background', event: 'background_job_notice', message: notice.body });
      },
      // Process exit is the local analogue of a DO eviction: resume from the durable checkpoint.
      resume: (kind, input, mode, signal) => this.resumeBackgroundJob(kind, { value: input }, mode, signal),
      // Same predicate as `resume`: a search keeps what it measured; side-effecting kinds have nothing partial.
      harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
        { sql: this.rt.storage.sql, ledger: this.mctsSearchStore, actor: this.rt.actor }, kind, input,
      )),
      // Arms the session's one terminal-retry timer, which sweeps due jobs before replaying owed effects.
      scheduleResume: (atMs) => this.scheduleTerminalRetry(atMs),
    });
    // Scaffold cold-start heal (DO onStart parity): without scaffold/agent.js,
    // engine.maybeEvolveScaffold silently disables scaffold evolution. Idempotent; tracked for end().
    this.actorSession.orchestrator.track(bootstrapScaffold(this.rt), 'Scaffold bootstrap');

    // The next turn awaits this before admitting input.
    this.actorSession.orchestrator.track(this.chat.restoreHistory().then(() => {}), 'restoring working history');
    this.ensureModelState();
    this.rearmLocalAlarm();
  }

  toolNames(): string[] {
    this.ensureModelState();

    return [...Object.keys(this.tools), ...Object.keys(this.extraTools)];
  }

  describeTools(): Array<{ name: string; description: string }> {
    this.ensureModelState();

    return Object.entries({ ...this.tools, ...this.extraTools }).map(([name, t]) => ({
      name, description: t.description ?? '',
    }));
  }

  /** Shared, not copied, with every local child on this plane: revocations are live. */
  instructionApprovalAuthority(): InstructionApprovalStore {
    return this.instructionApprovals;
  }
  getAlwaysActiveSkills(): string[] { return getAlwaysActiveSkills(this.config).names; }
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void { setAlwaysActiveSkills(this.config, names); }

  /** The owner's instruction-file surface for this directory (KINU-N028), discovered per call. */
  async listInstructionApprovals(request: PageRequest = {}): Promise<Page<InstructionSourceRow>> {
    return this.instructionDesk.list(request);
  }

  async readInstructionApproval(path: string): Promise<InstructionSourceView | null> {
    return this.instructionDesk.read(path);
  }

  async approveInstruction(path: string, reviewedDigest: string): Promise<AdmittedInstructionDecision> {
    return this.instructionDesk.approve(path, reviewedDigest);
  }

  /** Stop following a path; the refusal is kept so nothing re-grants it. */
  async revokeInstruction(path: string): Promise<AdmittedInstructionDecision> {
    return this.instructionDesk.revoke(path);
  }

  /** File checkpoints with store reachability. Pass `turnId` rather than filtering: the limit is
   *  global, so a self-filtered window drops turns (see FileCheckpoints.list). */
  async listFileCheckpoints(limit?: number, turnId?: string): Promise<FileCheckpointListing> {
    return fileCheckpointListing(this.rt.checkpoints ?? null, { limit, turnId });
  }

  async planFileRestore(dir: string, id: string): Promise<FileRestorePlan> {
    return this.requireCheckpoints().plan(dir, id);
  }

  async restoreFileCheckpoint(dir: string, id: string): Promise<FileRestoreResult> {
    return this.requireCheckpoints().restore(dir, id);
  }

  checkpointStatus(): Promise<CheckpointAvailability> {
    return checkpointAvailability(this.rt.checkpoints ?? null);
  }

  private requireCheckpoints(): FileCheckpoints {
    if (!this.rt.checkpoints) throw new Error(CHECKPOINTS_UNCONFIGURED);

    return this.rt.checkpoints;
  }

  getShellApprovalMode(): { mode: ShellApprovalMode } {
    return getShellApprovalMode(this.config);
  }

  setShellApprovalMode(mode: ShellApprovalMode): ReturnType<typeof setShellApprovalMode> {
    return setShellApprovalMode({ config: this.config, onChanged: () => this.rebuildToolSurface() }, mode);
  }

  getShellApprovalGrants(): { grants: ApprovalGrant[] } {
    return getShellApprovalGrants(this.config);
  }

  /** Read live by the gate, so the next command of that kind asks again. */
  revokeShellApprovalGrants(grants: ApprovalGrant[]): { ok: boolean; grants: ApprovalGrant[] } {
    return revokeShellApprovalGrants(this.config, grants);
  }

  /** Install (or null to remove) the interactive shell approval channel, shared by `rt.shell` and
   *  every `rt.executionRouter` provider. Without one, 'strict' parks hits in the owner queue. */
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

  async listDeferredApprovals(): Promise<DeferredApproval[]> {
    return this.deferrals.list();
  }

  async decideDeferredApprovals(
    ids: string[], decision: DeferredApprovalAnswer,
  ): Promise<{ decided: string[] }> {
    return decideDeferredApprovals(this.deferrals, ids, decision);
  }

  /** `allow_always` grants exactly the rules asked about on that executor, never a whole-agent
   *  `allow_all`: one `sudo` click must not unlock every gated command everywhere. */
  private wrapShellApprovalHandler(handler: ShellApprovalHandler): RequestShellApproval {
    return async (req) => {
      const pending: DynamicApproval = {
        id: `shell-${String(this.shellApprovalSequence += 1)}`,
        kind: 'shell approval',
        detail: `${req.executor}: ${req.command}`,
      };

      this.pendingShellApproval = pending;

      try {
        const outcome = await handler(req) ?? null;

        if (outcome === 'allow_always') {
          this.config.grantShellApproval(gatedGrants(req.review, req.executor));
        }

        return outcome;
      } finally {
        if (this.pendingShellApproval === pending) this.pendingShellApproval = null;
      }
    };
  }

  getStoredModelSpec(): { spec: string | null } {
    return getStoredModelSpec(this.config);
  }

  getEffectiveModelSpec(): string {
    return this.effectiveModelSpec();
  }

  getActiveRoleId(): string {
    if (this.actorSession.profile) return this.actorSession.profile.role.id;

    return this.config.getRoleSelection();
  }

  getEffectiveTierId(): string {
    if (this.actorSession.profile) return this.actorSession.profile.tier.id;
    const roleId = this.getActiveRoleId();

    return effectiveRoleCatalog(BUILTIN_PROFILE_CATALOG)[roleId]?.tier ?? 'default';
  }

  /** Takes effect on the next resolved turn (`runTurn` re-reads the selection); the running turn
   *  keeps its profile (core profiles/role-change.ts:1-5). */
  async setRole(roleId: string): Promise<{ role: string }> {
    const envelope = await this.profiles().envelope();

    return changeRoleAsOwner({ config: this.config, envelope, to: roleId, active: this.getActiveRoleId() });
  }

  setModel(spec: string): ReturnType<typeof setModel> {
    return setModel({
      config: this.config,
      normalize: (s) => this.profiles().normalizeSpec(s),
      onChanged: () => this.rebuildToolSurface(),
    }, spec);
  }

  getProviderAccounts(): ReturnType<typeof getProviderAccounts> {
    return getProviderAccounts(this.config);
  }

  workspaceSpend(): WorkspaceSpend {
    return workspaceSpend({ events: this.eventRecorder, sql: this.rt.storage.sql, actor: this.rt.actor });
  }

  setProviderAccount(provider: string, account: string | null): ReturnType<typeof setProviderAccount> {
    return setProviderAccount(this.config, provider, account);
  }

  /** The stored setting, never the claimed tier's own effort. */
  getReasoningEffort(): ReturnType<typeof getReasoningEffort> {
    return getReasoningEffort(this.config);
  }

  setReasoningEffort(
    effort: Parameters<typeof setReasoningEffort>[1],
  ): ReturnType<typeof setReasoningEffort> {
    return setReasoningEffort(this.config, effort);
  }

  private rebuildToolSurface(): void {
    this.invalidateModelState();
    this.ensureModelState();
  }

  listModelProviders() {
    return this.modelResolver?.listProviders() ?? Promise.resolve([]);
  }

  private accountChoice(provider: string): string | undefined {
    return this.config.getProviderAccounts()[provider] ?? this.actorSession.profileInputs?.envelope.catalog.accounts?.[provider];
  }

  listAvailableModels() {
    return this.modelResolver?.listModels() ?? Promise.resolve({ models: [], failures: [] });
  }

  /** `caller` has no default: the model passes `'self'`, and core refuses a self cancel of an
   *  owner-created ingress. */
  cancelTrigger(trigger_id: string, caller: TrustLevel): CancelTriggerResult {
    const result = cancelTrigger({ registry: this.triggerRegistry, trigger_id, now: Date.now(), caller });
    this.rearmLocalAlarm();

    return result;
  }

  async createTimerTrigger(opts: TimerTriggerOpts): Promise<TimerTrigger> {
    return await createTimerTrigger(this.triggerRegistry, opts, Date.now());
  }

  async fireDueTriggers(now = Date.now()): Promise<{ fired: number; nextAlarmAt: number | null }> {
    if (this.chat.closed) return { fired: 0, nextAlarmAt: null };

    if (this.scheduledAlarmAt !== null && this.scheduledAlarmAt <= now) this.clearLocalAlarm();
    const { fired } = await fireDueTriggers({ registry: this.triggerRegistry, log: this.eventLog }, now);

    if (fired > 0) this.actorSession.orchestrator.scheduleDrain();
    this.rearmLocalAlarm();

    return { fired, nextAlarmAt: this.scheduledAlarmAt };
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

  getEvolutionChangelog(limit = 50): EvolutionChangelogView {
    return getEvolutionChangelog(this.rt.storage.sql, this.rt.actor, limit);
  }

  markChangelogSeen(): ReturnType<typeof markChangelogSeen> {
    return markChangelogSeen(this.config);
  }

  /** Revert one changelog entry; invalidates model-bound state so a retired tool disappears. */
  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    const result = await revertChangelogEntryById({ rt: this.rt, facts: this.factsStore, events: this.eventRecorder }, id);

    if (result.ok) this.invalidateModelState();

    return result;
  }

  latestAlternateTakes(): AlternateTakeSet | null {
    return latestAlternateTakeSet(this.rt.storage.sql, this.rt.actor);
  }

  /** Record the pick; a pick differing from the answered take queues a continuation turn. */
  async pickAlternateTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    return pickAlternateTake(
      { sql: this.rt.storage.sql, actor: this.rt.actor, history: this.stores.history, engine: this.engine, inbox: this.actorSession.orchestrator.inbox },
      takeId, nodeId);
  }

  private get planActions(): PlanReviewActions {
    this._planActions ??= new PlanReviewActions(this.stores.planReviews, (plan) => this.broadcast({ type: 'plan_updated', plan }));

    return this._planActions;
  }

  /** Only a root chat holds the plan review surface; a subordinate answers via `report`. */
  private planReviewSurface(): boolean {
    return this.parentRelay === null;
  }

  private submitPlanEdits(edits: readonly PlanEdit[]): PlanReviewResult {
    return this.planActions.submit(edits);
  }

  async getActivePlanReview(): Promise<PlanReview | null> {
    return this.planActions.active();
  }

  async savePlanReviewAnnotations(
    id: string,
    revision: number,
    annotations: PlanReviewAnnotation[],
  ): Promise<PlanReviewResult> {
    return this.planActions.saveAnnotations(id, revision, { value: annotations });
  }

  /** Record the verdict and hand off the owed turn. The driver lease is checked first so a verdict
   *  is never made durable with a handoff this process cannot run. */
  async decidePlanReview(
    id: string,
    revision: number,
    decision: PlanReviewDecision,
    feedback?: string,
  ): Promise<PlanDecisionOutcome> {
    const refusal = this.driverGate?.() ?? null;

    if (refusal) {
      return {
        ok: false,
        error: `${refusal.error}. Decide this plan from the session driving the conversation.`,
        plan: this.stores.planReviews.get(id, revision),
      };
    }

    return this.planActions.decideAndHandOff({ id, revision, decision, feedback }, (turn) => this.enqueueTurn(turn));
  }

  broadcast(event: BroadcastEvent): void {
    this.emit({ type: 'broadcast', event });
  }

  logActivity(event: string, detail?: string): void {
    const now = Date.now();
    const startedAt = this.actorSession.orchestrator.acc.startedAt;

    writeActivityLog(() => ({ sql: this.rt.storage.sql, actor: this.rt.actor }), {
      event, detail: detail ?? null, createdAt: now,
      elapsedMs: this.chat.currentRunId !== null && startedAt > 0 ? now - startedAt : 0,
    });
  }

  get headRuntime(): HeadRuntime {
    this.ensureModelState();

    return this._headRuntime;
  }

  /** Heads are grounded with the same executor and judge MCTS scores branches with. */
  private buildHeadGrounding(): HeadGrounding {
    if (this.rt.judgeModel) return {
      executor: this.rt.executor,
      explorer: this.rt.llm,
      judge: this.rt.judgeModel,
    };

    return { executor: this.rt.executor, explorer: this.rt.llm };
  }

  /** Only `web.*`: a head forks its parent's resources, never its authority to delegate. */
  private headCodemodeExtras(): CodemodeProvider[] {
    return [createWebCodemodeProvider(this.getWebSearchProvider())];
  }

  /** Skips a window outliving the session so consumed events never bind to a dead pump's turn. */
  setTimer(fn: () => Promise<void>, ms: number): void {
    setTimeout(async () => {
      if (this.chat.closed) return;

      try {
        await fn();
      } catch (cause) {
        diagnostics.failure(
          'drain.timer_callback_failed',
          toKinuError({ doing: 'running the drain-debounce timer callback', cause, otherwise: 'io' }),
        );
      }
    }, ms);
  }

  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    return this.chat.enqueueTurn(input);
  }

  turnInFlight(): boolean {
    return this.chat.turnInFlight();
  }

  /** Send the user's message. `mode` is the composer's; a Plan message runs a Plan turn. */
  send(
    input: string | { text: string; files: ReadonlyArray<PromptFile> },
    opts: Pick<SendOptions, 'tier' | 'id' | 'mode'>,
  ): Promise<SendLanding> {
    return this.chat.send(input, opts);
  }

  /** Run a mid-turn redirect as a budgeted head beside the live turn, settling into Alternate Takes
   *  (core steer-branch.ts). False when no turn is in flight. */
  branch(text: string): boolean {
    if (!this.chat.pumping) return false;
    const task = text.trim();

    if (!task) return false;
    this.ensureModelState();
    const id = newBranchId();
    // Read now: the branch charges the turn the owner redirected, not whichever runs next.
    const missionLabels = this.budget.scope;

    const handle = this.readInheritedContext().then((inheritedContext) => startBranchHead(this._headRuntime, this.headJournal, {
      id, task, inheritedContext, missionLabels,
    }));

    this.pendingBranches.push({ id, task, handle });
    this.broadcast({ type: 'branch_status', status: 'running', branchId: id, task } satisfies BranchStatusEvent);

    return true;
  }

  /** Abort the in-flight turn; returns dropped steer texts. */
  interrupt(): string[] {
    return this.chat.interrupt();
  }

  /** Continue from before `entryId`; refused while a turn is held. */
  revertConversation(entryId: string): Promise<void> {
    return this.chat.revertTo(entryId);
  }

  /** Force compaction on the next turn; one-shot (`takeForceCompaction` consumes it). */
  armForcedCompaction(): void {
    this.compactionState.armForceCompaction(this.cacheIdentity().sessionKey);
  }

  /** Aborted by {@link end}, so an MCP connect that never answers cannot block ending. */
  private readonly lifetime = new AbortController();

  async connectMcp(servers: Record<string, McpServerConfig>): Promise<void> {
    if (!servers || Object.keys(servers).length === 0) return;

    const log = (message: string): void => {
      this.emit({ type: 'background', event: 'mcp', message });
    };

    const conn = await connectMcpServers(servers, log, this.lifetime.signal);

    // Admission is session-scoped, so the native figure is the full surface; a narrower turn keeps more room.
    const admission = admitMcpDescriptors(conn.descriptors, {
      ...this.modelCatalog.window(),
      nativeToolTokens: toolSurfaceTokens(this.tools),
    });

    // Admitted tools without a readOnly annotation run under the same durable claim as natives
    // (KINU-019: unwrapped MCP effects started unclaimed and replayed after reset).
    this.extraTools = buildMcpToolSet(admission.admitted, {
      call: (d, args, options) => conn.call(d.serverName, d.name, args, options.abortSignal),
      effectClaims: {
        sql: this.rt.storage.sql,
        actor: this.rt.actor,
        turnId: () => currentOperationProfile(this.rt.actor)?.turnId ?? this.chat.currentTurnId ?? WORKSPACE_RUN_ID,
      },
      clamp: {
        vfs: this.rt.storage.vfs,
        budget: this.actorSession.orchestrator.acc.context,
        producer: 'external_tool',
      },
    });
    this.mcpClose = () => conn.close();
    // Unavailable or deferred servers are named in the live context so the model can explain their absence.
    this.mcpUnavailable = [
      ...conn.diagnostics
        .filter((d) => d.status === 'failed')
        .map((d) => ({
          source: `MCP server "${d.server}"`,
          reason: d.reason ?? 'failed to start, so its tools are missing from this turn',
        })),
      ...[...conn.refused, ...admission.deferred].map((d) => ({
        source: `MCP server "${d.server}"`,
        reason: d.reason,
      })),
    ];

    for (const d of admission.deferred) {
      log(`mcp: ${d.server} deferred: ${d.reason}`);
    }
  }

  private mcpUnavailable: MissingCapability[] = [];

  /** Run pending drains now, bypassing debounce; the daemon's tick calls this before end(). */
  flushPendingDrains(): Promise<void> {
    return this.chat.flushPendingDrains();
  }

  /** Call once at startup, before the recovery drain. */
  reclaimStrandedEventDeliveries(): void {
    this.chat.reclaimStrandedEventDeliveries();
  }

  /** Run the due evolution pass to completion; the daemon claims work a one-shot exec left behind.
   *  Never rejects. */
  async runDueEvolution(): Promise<void> {
    if (this.chat.closed) return;
    await this.actorSession.orchestrator.runDueSessionEvolution();
  }

  /** End: finish started evolution, settle detached fibers, disconnect MCP. Unfinished work carries over. */
  async end(): Promise<void> {
    this.chat.close();
    this.lifetime.abort();
    this.clearLocalAlarm();
    // Stops a retry timer firing into a session whose stores are closed.
    this.clearTerminalRetry();
    const t0 = Date.now();
    await this.actorSession.orchestrator.settleEvolution();
    const t1 = Date.now();
    await this.joinBackgroundFibers(this.drainDeadline());
    const t2 = Date.now();
    await this.mcpClose?.();
    await this.chat.flushEvents();
    const t3 = Date.now();

    // Quiet under 1s: the --json contract promises an empty stderr on a fast exit.
    if (t3 - t0 > 1_000) {
      diagnostics.event('session.settle_timings', {
        evolutionMs: t1 - t0, fibersMs: t2 - t1, mcpMs: t3 - t2,
      });
    }
  }

  /** Fibers detached from a turn; closing the database under one would abort its settle write. */
  private readonly backgroundFibers = new Set<Promise<unknown>>();

  /** One shared grace deadline, so a one-shot run calling settleBackgroundWork() then end() pays it once. */
  private settleDeadline: number | null = null;
  private drainDeadline(): number {
    return this.settleDeadline ??= this.clock.now() + this.jobRunner.policy.settleGraceMs;
  }
  /** Hold one settlement in the join set; it resolves only after removal so joiners terminate. */
  private tracked(settle: () => Promise<void>): void {
    const { promise, resolve: markPruned } = Promise.withResolvers<void>();
    this.backgroundFibers.add(promise);

    // Both outcomes prune; a rejected observer would otherwise leave an entry nothing removes.
    const prune = (): void => {
      this.backgroundFibers.delete(promise);
      markPruned();
    };

    settle().then(prune, prune);
  }

  private trackFiber<T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> {
    const running = this.rt.schedule.fiber(name, fn);
    // Only a fiber that could not record its own outcome (database closed at teardown) reaches here.
    this.tracked(async () => {
      try {
        for (const outcome of await Promise.allSettled([running])) {
          if (outcome.status !== 'rejected') continue;
          diagnostics.failure(
            'fiber.settle_failed',
            toKinuError({ doing: 'settling a durable background fiber', cause: outcome.reason, otherwise: 'io' }),
            { fiber: name },
          );
        }
      } catch (cause) {
        diagnostics.failure(
          'fiber.settle_observer_failed',
          toKinuError({ doing: 'recording a durable background fiber settlement', cause, otherwise: 'io' }),
          { fiber: name },
        );
      }
    });

    return running;
  }

  /**
   * Await detached fibers until settled or `deadline`. Bounded because they may be servers that
   * never finish; anything still running is left running and recovered on the next start.
   * Returns true when everything settled.
   */
  private async joinBackgroundFibers(deadline: number): Promise<boolean> {
    if (this.backgroundFibers.size === 0) return true;
    this.emit({
      type: 'background', event: 'bg_jobs_settling',
      message: `${this.backgroundFibers.size} background job(s) still running. Waiting for their results.`,
    });

    while (this.backgroundFibers.size > 0) {
      const remaining = deadline - this.clock.now();

      if (remaining <= 0) {
        this.announceAbandonedJobs();

        return false;
      }

      await raceDeadline(this.clock, Promise.allSettled(this.backgroundFibers), remaining);
    }

    return true;
  }

  /** Warn on stderr that running jobs will be re-driven on the next start, possibly by the
   *  unattended scheduler daemon. */
  private announceAbandonedJobs(): void {
    const interrupted = this.jobs.listRunning().items;

    const roster = interrupted
      .map((job) => `${job.id} (${job.kind}${job.label ? `: ${job.label}` : ''})`)
      .join(', ');

    const message =
      `${this.backgroundFibers.size} background job(s) did not finish in time and were interrupted by this ` +
      'exit. They are checkpointed, so this workspace resumes them the next time it starts, including ' +
      'unattended under the local scheduler daemon. A resumed job runs commands and writes files on ' +
      `this machine. Cancel with: kinu jobs ${this.agentName()} cancel <id>.` +
      (roster ? ` Interrupted: ${roster}.` : '');

    this.emit({ type: 'background', event: 'bg_jobs_abandoned', message });
    diagnostics.failure('jobs.abandoned_at_exit', new KinuError('timeout', message), {
      jobs: interrupted.length,
    });
  }

  /**
   * Recover interrupted work in one pass, order-sensitive: fiber rows first (a `bg:*` row is the only
   * way to re-deliver a lost wake), then the job sweep and fork journal (stale heads handed to the
   * sweep before any run is retired), then deferred turn reviews (bounded), then the owed terminal
   * suffix last, under the driver lease. The advisor orphan goes to the leased sweep. No step
   * absorbs its own failure. Call once at startup.
   */
  async recoverBackgroundJobs(): Promise<void> {
    const refusal = this.driverGate?.();

    if (refusal) {
      diagnostics.event('driver.startup_recovery_deferred', { reason: refusal.reason });

      return;
    }

    const recovered = await recoverActorTurns({
      resumable: (limit) => this.actorHost.resumable(limit),
      acquire: async (reference) => reference.actorId === this.rt.actor.actorId
        ? { runtime: this.rt, stores: this.stores, session: this.actorSession }
        : await this.actorHost.acquire(reference),
    });

    diagnostics.event('actor.turns_recovered', {
      verified: recovered.verified.length, refused: recovered.refused.length, failed: recovered.failed.length,
      unreadable: recovered.unreadable.length, active: recovered.active.length,
    });
    const advisorOrphans: OrphanedFiber[] = [];

    for (const orphan of detectOrphanedFibers(this.rt.storage.sql, this.rt.actor)) {
      if (orphan.name === ADVISOR_LANE_FIBER) {
        advisorOrphans.push(orphan);
        continue;
      }

      if (orphan.name.startsWith('bg:')) await this.jobRunner.recover(orphan.snapshot);
      void this.rt.storage.sql`DELETE FROM fibers
        WHERE actor_id = ${this.rt.actor.actorId} AND id = ${orphan.id}`;
    }

    await reconcileInterruptedForks({
      journal: this.headJournal,
      inbox: this.actorSession.orchestrator.inbox,
      search: this.mctsSearchStore,
      runEvents: this.eventRecorder,
      liveRuns: () => this.chat.drivenRuns(),
      resume: jobRedriveResumeGate({
        recoverOrphans: () => this.jobRunner.recoverOrphans(),
        inputOf: (jobId) => this.jobs.getInput(jobId),
        rootsForTask: (task) => resumableForkRoots(
          { ledger: this.mctsSearchStore, journal: this.headJournal }, task,
        ),
      }),
      logActivity: (event, detail) => this.emit({ type: 'background', event, message: detail ?? '' }),
    });
    const reviews = await this.actorSession.orchestrator.runDeferredTurnReviews();

    if (reviews.reviewed > 0 || reviews.refused.length > 0) {
      // Counted apart: an unreadable row is gone, a budget-refused one is still owed.
      const unreadable = reviews.refused.filter((r) => r.reason === 'unreadable').length;
      const overBudget = reviews.refused.length - unreadable;
      this.emit({
        type: 'evolution', event: 'deferred_reviews_drained',
        message: `${reviews.reviewed} deferred turn review(s) run`
          + (unreadable > 0 ? `, ${unreadable} unreadable row(s) dropped` : '')
          + (overBudget > 0 ? `, ${overBudget} left queued: the mission is over its budget` : ''),
      });
    }

    await this.recoverTerminalTransitions(advisorOrphans);
  }

  /**
   * Finish owed terminal sequences under the driver lease: core's in-flight guard is process-local,
   * so two processes would run the same effects. No gate installed means no other driver.
   * Advisor orphans first (each is a model call), then the terminal ledger.
   */
  async recoverTerminalTransitions(
    advisorOrphans: readonly OrphanedFiber[] = [],
  ): Promise<void> {
    const refusal = this.driverGate?.();

    if (refusal) {
      diagnostics.event('driver.terminal_recovery_deferred', { reason: refusal.reason });

      return;
    }

    for (const orphan of advisorOrphans) {
      await this.recoverAdvisorLane(orphan.snapshot);
      void this.rt.storage.sql`DELETE FROM fibers
        WHERE actor_id = ${this.rt.actor.actorId} AND id = ${orphan.id}`;
    }

    await this.terminal.resumeAll();
    // A replayed sequence can enqueue a turn; the advisor gate state travels in the row, not RAM.
    this.chat.pump();
  }

  /** Re-drive an interrupted advisor review from its snapshot (DO fiber recovery parity).
   *  Idempotent on the note: its presence says whether the review already finished. */
  private async recoverAdvisorLane(snapshot: JsonValue | null): Promise<void> {
    const parsed = v.safeParse(RecordedAdvisorSchema, snapshot);

    if (!parsed.success) {
      diagnostics.failure('advisor.snapshot_unreadable', toKinuError({
        doing: 'reading the turn an interrupted advisor review was about',
        cause: new Error(parsed.issues.map((issue) => issue.message).join('; ')),
        otherwise: 'unsupported',
      }));

      return;
    }

    const turnId = parsed.output.turn.turnId;

    if (turnId !== undefined && this.engine.hasAdvisorNoteForTurn(turnId)) return;
    // The gate verdict comes off the checkpoint; this process never armed the RAM gate.
    await this.runAdvisorReview(parsed.output);
  }

  /** Re-drive an interrupted background job through core's shared resume gate over the raw surface,
   *  so it cannot detach a second job. Legacy `fork`/'think' rows map onto search. */
  private resumeBackgroundJob(
    kind: string,
    input: { value: unknown },
    mode: WorkMode,
    signal: AbortSignal,
  ) {
    return resumeBackgroundJob({
      rawTools: (resumeMode) => {
        this.ensureModelState();
        const surface = this.toolSets[resumeMode];

        if (!surface) throw new Error(`tool surface for ${resumeMode} mode is unavailable`);

        return surface.raw;
      },
      kind, input: decodeJsonValue({ value: input.value }), mode, signal,
    }).then((value) => value === undefined ? undefined : decodeJsonValue({ value }));
  }

  private emit(event: SessionEvent): void {
    this.chat.emit(event);
  }

  private scheduleLocalAlarm(ts: number): void {
    if (this.chat.closed) return;

    if (this.scheduledAlarmAt !== null && this.scheduledAlarmAt <= ts) return;
    this.clearLocalAlarm();
    this.scheduledAlarmAt = ts;
    const delay = Math.max(0, ts - Date.now());
    this.alarmTimer = setTimeout(async () => {
      this.alarmTimer = null;
      this.scheduledAlarmAt = null;

      try {
        await this.fireDueTriggers();
      } catch (cause) {
        const failure = toKinuError({
          doing: 'firing the triggers due on this wake',
          cause,
          otherwise: 'io',
        });

        diagnostics.failure('schedule.due_triggers_failed', failure);
      }
    }, Math.min(delay, 2_147_483_647));
  }

  private clearLocalAlarm(): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    this.scheduledAlarmAt = null;
  }

  private rearmLocalAlarm(): void {
    if (this.chat.closed) return;
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

  /** The owning host's driver-lease check. Absent means nothing else can drive this database. */
  private driverGate: (() => Refusal | null) | null = null;

  setDriverGate(gate: () => Refusal | null): void {
    this.driverGate = gate;
  }

  /**
   * Drain background work until nothing is detached, queued or pumping, without ending the session.
   * In-flight turns always run to completion; unsettled work is bounded by the surface's grace.
   */
  flushEvents(): Promise<void> {
    return this.chat.flushEvents();
  }

  async settleBackgroundWork(): Promise<void> {
    const deadline = this.drainDeadline();

    for (;;) {
      // A queued turn always has a live pump, so awaiting it drains the queue.
      if (this.chat.pumpPromise) { await this.chat.pumpPromise; continue; }

      if (this.backgroundFibers.size === 0) return;

      if (!await this.joinBackgroundFibers(deadline)) return;
    }
  }

  /** Append to the run-event log, scoped to the in-flight run unless `runId` is given. Never throws. */
  private recordRunEvent(input: RunEventInput, runId?: string | null, recorder: RunEventRecorder = this.eventRecorder): void {
    const id = runId !== undefined ? runId : this.chat.currentRunId;

    if (!id) return;

    try { recorder.emit(id, input); }
    catch (err) {
      diagnostics.failure(
        'event.run_row_write_failed',
        toKinuError({ doing: 'appending a row to the durable run-event log', cause: err, otherwise: 'io' }),
      );
    }
  }

  /** One run's durable events (DO getRunEvents peer); `since` is the SSE resume index. */
  getRunEvents(runId: string, opts: RunEventQuery = {}): RunEvent[] {
    return getRunEvents(this.eventRecorder, runId, opts);
  }

  listRuns(request?: PageRequest): Page<RunListEntry> {
    return listRuns(this.eventRecorder, request?.cursor ?? null, request?.limit);
  }

  /** Assemble one admitted turn (ChatSession's `prepareTurn` port); the loop itself is core's. */
  private async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease): Promise<PreparedTurn> {
    this.rt.checkpoints?.beginTurn({ turnId: lease.turnId, sessionId: this.sessionId });
    // Set before anything reads the tool surface: the report gate is a property of this turn.
    this.turnIsParentAssigned = item.kind === 'programmatic';
    const profileInputs = await this.profiles().inputs();
    const activeRoleId = this.getActiveRoleId();
    const roleSkills = effectiveRoleCatalog(profileInputs.envelope.catalog)[activeRoleId]?.skills ?? [];

    // A user message grades the previous turn, unless this is a one-shot process.
    if (item.kind === 'user') this.actorSession.orchestrator.observeUserTurn(item.text, this.turnContinuity);

    if (item.kind === 'user' && this.oneShot) this.chat.completionGate.arm(item.text);
    const executors = this.rt.executionRouter?.listExecutors() ?? [];

    const { available: availableSkills, activeSkills } = await this.resolveTurnSkills(
      item.text,
      roleSkills,
    );

    this.turnActiveSkillNames = activeSkills?.active.map((skill) => skill.name) ?? [];

    const candidateBuiltins = this.filterToolsBySkills(activeSkills);

    const candidateBuiltinNames = Object.keys(candidateBuiltins).filter(
      (name): name is BuiltinToolName => BUILTIN_TOOL_NAMES.has(name),
    );

    const candidateExternalNames = Object.keys(this.extraTools);
    // Read once so the tool list, codemode providers and profile agree.
    const workMode = this.turnWorkMode(item.metadata);
    const candidateAgentActions = agentsActionsFor(this.agentsToolDeps(workMode));

    const profile = resolveAgentTurnProfile({
      ...profileInputs,
      activeRoleId: this.getActiveRoleId(),
      workMode,
      availableTools: [
        ...candidateBuiltinNames,
        ...candidateExternalNames,
        // `report` is added to the toolset after this resolution; name it or a role's tool list drops it.
        ...(this.reportGateOpen() ? [REPORT_TOOL] : []),
        // `submit_plan` lives outside BUILTIN_TOOLS; same reason as `report`.
        ...(this.planSubmissionOpen(workMode) ? [SUBMIT_PLAN_TOOL] : []),
        // Sandbox-only namespaces have no native tool id; derive them from the wired providers.
        ...codemodeCapabilitiesFor(this.codemodeProviders(workMode)),
      ],
      activeSkills: activeSkills?.active.map((skill) => skill.name) ?? [],
      // This message's tier, then the hire's pinned tier, else the role's own default (not the workspace's).
      explicitTier: tierFromMetadata(item.metadata) ?? this.config.getAssignedTier() ?? undefined,
      // Without this a setModel pin is accepted but never used.
      workspaceModel: this.config.getModel(),
      explicitEffort: this.config.getReasoningEffort(),
    });

    this.actorSession.bindProfile(lease, profile, profileInputs);
    this.invalidateModelState();
    const model = this.ensureModelState();
    this.activateToolMode(this.actorSession.workMode);
    const allowedTools = new Set(profile.allowedTools);
    const toolAllowed = (name: string): boolean => allowedTools.has(name);

    const filteredBuiltins = Object.fromEntries(
      Object.entries(this.filterToolsBySkills(activeSkills)).filter(([name]) => toolAllowed(name)),
    );

    const filteredExternal = withToolSchemaDialect(
      Object.fromEntries(Object.entries(this.extraTools).filter(([name]) => toolAllowed(name))),
      toolSchemaDialect(this.effectiveModelSpec()),
    );

    const turnTools = toolsInWorkMode(this.actorSession.workMode, { ...filteredBuiltins, ...filteredExternal });

    const availableBuiltins = Object.keys(filteredBuiltins).filter(
      (name): name is BuiltinToolName => BUILTIN_TOOL_NAMES.has(name),
    );

    const externalTools = Object.keys(filteredExternal).map((name) => ({
      name,
      source: isMcpToolKey(name) ? 'mcp' as const : 'external' as const,
    }));

    const resolvedAgentActions = toolAllowed('agents') ? candidateAgentActions : [];
    const memoryTail = await readMemoryTail(this.rt.memory);

    // Re-statted each turn; only files fitting the model window are read, each classified by owner approval.
    const agentsMd = discoverAgentsMd(this.cwd, this.modelCatalog.window(), this.instructionTrust);

    // agentStateVfs is the identity tree when it differs; a missing SOUL.md renders the default.
    const soul = await readSoul(this.rt.agentStateVfs ?? this.rt.storage.vfs);

    const systemPromptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {
      executors,
      availableTools: availableBuiltins,
      agentsActions: resolvedAgentActions,
      // A session with no roster substrate never advertises the temporary rung.
      temporaryAsk: this.teamDeps?.temporary !== undefined,
      externalTools,
      backend: 'cli-local',
      roleSection: profile.role,
      model: { id: this.effectiveModelSpec() },
      cwd: this.cwd,
      currentDate: currentDateForPrompt(),
      // Read here: the builder is the byte-stable cacheable prefix and does no I/O.
      sectionOverrides: activePromptSectionOverrides(this.rt.storage.sql, this.rt.actor),
      identity: this.promptIdentity(),
    };

    systemPromptOptions.agentsMd = agentsMd;

    if (availableSkills.lines.length > 0) systemPromptOptions.availableSkills = availableSkills;

    if (activeSkills) systemPromptOptions.activeSkills = activeSkills;

    if (soul) systemPromptOptions.soulOverride = soul;
    const systemPrompt = buildSystemPromptSync(this.rt, systemPromptOptions);
    this.recordSystemPromptHash(systemPrompt);

    // Live state rides the dynamic-context ledger, re-read every step; turn-local state rides one trailing
    // message. Neither enters durable history, so the prefix stays cacheable.

    // Provenance flips when a background job lands; in the system prompt it would rewrite the cached
    // prefix (prompting/volatile-context.ts).
    const turnLocal: Parameters<typeof turnLocalContextMessage>[0] = {
      provenance: turnProvenanceForMetadata(item.metadata),
    };

    if (activeSkills) turnLocal.activeSkills = activeSkills;
    const turnLocalMsg = turnLocalContextMessage(turnLocal);

    // Unapproved instruction bytes go in the turn-local tail as sealed reference material, before the
    // turn-local message so activation reasons stay last.
    const unverifiedMsg = unverifiedInstructionsMessage(
      activeSkills ? { agentsMd, activeSkills } : { agentsMd },
    );

    const turnLocalMsgs = [unverifiedMsg, turnLocalMsg]
      .filter((msg): msg is ModelMessage => msg !== null);

    const cache = this.cacheIdentity();

    // Normalized spelling: `parseModelSpec` refuses a bare tier id without a slash.
    const providerOptions = reasoningEffortOptions(
      profile.tier.reasoningEffort,
      parseModelSpec(this.effectiveModelSpec()).provider,
    );

    // `historyLength` is the durable length the measurement is bound to (orchestrator/turn-context.ts).
    const historyLength = this.actorSession.history.length;
    const measured = measureCompactionTrigger(this.compactionState, cache.sessionKey, historyLength);
    // Awaited once per turn: the sync catalog reads answer from a static stand-in while the lookup is
    // in flight, which measured a 1M-window model against 128k (#20). The fallbacks' rates price their steps.
    const [window] = await Promise.all([this.modelCatalog.resolved(), this.modelCatalog.warm(profile.tier.fallbacks)]);
    const contextWindow = window.contextWindow;

    const liveTurn: ActorExecutionInput['chat'] = {
      model,
      // Both halves: omitting `modelOutputLimit` treats the whole window as the answer's allowance.
      modelContext: {
        id: this.effectiveModelSpec(),
        contextWindow,
        windowMeasured: window.windowMeasured,
        modelOutputLimit: window.modelOutputLimit,
      },
      system: systemPrompt,
      // Applied to the whole history before the transform seam; this.history is never mutated.
      attachments: {
        accepts: this.modelCatalog.acceptedMedia(), vfs: this.rt.storage.vfs, budget: this.actorSession.orchestrator.acc.context,
      },
      turnLocal: turnLocalMsgs.length > 0 ? turnLocalMsgs : undefined,
      tools: turnTools,
      transformTrigger: measured.trigger,
      cache,
      budget: this.budget,
      operations: this.modelOperations,
    };

    if (measured.providerReportedTokens !== undefined) {
      liveTurn.providerReportedTokens = measured.providerReportedTokens;
    }

    if (providerOptions) liveTurn.providerOptions = providerOptions;
    // A static-model session has no registry to count with, so it is assembled ungated.
    const resolver = this.modelResolver;

    if (resolver) {
      liveTurn.countInputTokens = (request: CountableRequest) =>
        resolver.countInputTokens(this.effectiveModelSpec(), request);

      liveTurn.fallbacks = profile.tier.fallbacks.map((spec) => ({
        spec,
        bind: () => {
          const { provider } = parseModelSpec(this.profiles().normalizeSpec(spec));

          return {
            model: resolver.resolveModel(spec),
            provider,
            providerOptions: reasoningEffortOptions(profile.tier.reasoningEffort, provider),
          };
        },
      }));
    }

    return {
      execution: {
        loopVersion: await this.rt.identity.scaffold.version(),
        chat: liveTurn,
        extensions: [this.compactionExtension],
        dynamic: (requestProfile, tools) => this.dynamicContextSnapshot(memoryTail, requestProfile, tools),
        scaffoldSpend: { source: 'scaffold', report: this.modelCallSink, operations: this.modelOperations },
      },
      sessionKey: cache.sessionKey,
      contextWindow,
      historyLength,
    };
  }

  // Terminal transition: core owns vocabulary, roster, state machine, ledger and replay; this backend
  // owns only the effect bodies and the wake.

  /** What this turn owes, via core's `declareTerminalRoster`; this session supplies values, never
   *  decisions, so the CLI cannot drift from the Durable Object. */
  private owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[] {
    const mission = localActorMission(this.rt, makeSqlExec(this.db));

    // Decided on the live turn: `shouldGate` reads RAM a restart lacks, so the row's existence carries it.
    const gated = this.rt.shell !== undefined
      && this.actorSession.workMode !== 'plan'
      && this.chat.completionGate.shouldGate({
        completed: input.completed, toolCalls: this.actorSession.orchestrator.acc.toolCalls.length,
      });

    const scoped = this.actorSession.orchestrator.scopedTurn(input.turn);

    // Recorded, not re-read on replay: the tool surface, dedupe window and severity floor can change.
    const advisor = this.actorSession.advisorSnapshot(scoped, input.reachableTools);

    // Only the host knows the child's lifetime and whether the parent drove the turn.
    const ending = taskTurnEnding(input.completed, input.interrupted);

    const relay = this.parentRelay;
    const parentReport = relay?.owed(ending, input.assistantText) ?? null;

    const facts: TerminalTurnFacts = {
      messageId: input.messageId,
      status: input.status,
      workMode: this.actorSession.workMode,
      continuity: this.turnContinuity,
      completed: input.completed,
      userText: input.userText,
      assistantText: input.assistantText,
      // A cold replay has no governor scope; without the labels the review is neither attributed nor debited.
      scopedTurn: projectJsonValue({ value: scoped }),
      recordedAt: Date.now(),
      // Frozen beside the turn so a replay records what the producing run had.
      evolutionEnabled: this.engine.recordsTurns,
    };

    const parts: Writable<TerminalTurnParts> = {};
    parts.takes = {
      credited: input.credited,
      startedAt: input.startedAt,
      // Read here: a retry selecting "unclaimed now" would claim a later turn's captures.
      takeIds: unclaimedAlternateTakeIds(this.rt.storage.sql, this.rt.actor),
    };
    parts.branches = this.pendingBranches.map(({ id, task }) => ({ id, task }));

    if (input.taskReminder !== null) parts.taskReminder = { text: input.taskReminder.text };

    if (input.overflowRetry) parts.overflowRetry = true;

    if (gated) parts.completionGate = { text: this.chat.completionGate.task };
    // Every review input is recorded, matching the Durable Object's snapshot; the gate's armed state
    // is RAM and a fresh process reads it closed.
    parts.advisor = projectJsonValue({
      value: {
        ...advisor,
        // Whether the gate will be waiting when the advisor speaks: `gated` for this turn, `open` for an earlier one.
        gateOpen: gated || this.chat.completionGate.open,
      },
    });

    // Decided once: the plan re-reads the pending version, so a replay would score against the wrong candidate.
    const sampled = owesShadowTrial(facts) ? shadowTrialPlan(this.scaffoldControl, input.messageId) : null;

    if (sampled !== null) {
      parts.shadowTrial = {
        pendingVersion: sampled,
        // Bounded here: a million-token turn exceeds a SQLite row, and a failed insert mid-sequence leaves
        // a prefix recovery reads as the whole roster.
        trialContext: projectJsonValue({ value: trimTrialContext([...input.trialContext]) }),
      };
    }

    parts.autoTitle = { mission };

    // One claimed effect; the sequence id is the parent's dedupe key, so a replay is recognised.
    if (parentReport !== null && relay !== null) {
      parts.parentReport = {
        text: parentReport.content,
        status: parentReport.status,
        sequenceId: relay.sequenceId(input.messageId),
      };
    }

    // No `turnEndExtensions` (runChat fires them in-stream), no `eventReplies` (startup's
    // `reclaimStrandedEventDeliveries` covers them), no `craftedToolsUsed`/`sleepTime`/`autoGepa` lanes here.
    return declareTerminalRoster(facts, parts);
  }

  /** This backend's terminal effect bodies; each is replayable at its own boundary (keyed ids, unbound-row selection). */
  private terminalEffectTable(): TerminalEffectTable {
    const relay = this.parentRelay;

    const base = {
      takes: takesTerminalEffect({ sql: this.rt.storage.sql, actor: this.rt.actor, sessionId: this.sessionId }),
      branches: branchesTerminalEffect({
        sql: this.rt.storage.sql,
        actor: this.rt.actor,
        sessionId: this.sessionId,
        broadcast: (event) => this.broadcast(event),
        pending: this.pendingBranches,
        journal: this.headJournal,
      }),

      completion_gate: terminalEffect({
        input: v.object({ text: v.string() }),
        // Observe the working directory through the agent's own shell when the effect runs (a replay asks
        // "is it right now"). The row stays owed until the confirming turn is on disk: its key-derived
        // durable row is both the admission record and the replay guard.
        run: async ({ text }, scope) => {
          const identity = `${COMPLETION_GATE_EVENT}:${scope}`;

          if (this.chat.announcementOnDisk(identity)) {
            return { status: 'completed', detail: 'the confirming turn is on disk' };
          }

          // Queued or running is not "not queued yet"; enqueueing again would do the work twice.
          if (this.chat.announcementInFlight(identity)) {
            return { status: 'owed', held: true, detail: 'the confirming turn is queued and not yet on disk' };
          }

          const shell = this.rt.shell;

          if (shell === undefined) {
            return { status: 'completed', detail: 'this session has no shell to observe with' };
          }

          const observed = await observeCompletionState({
            exec: (command) => shell.exec(command),
            vfs: this.rt.storage.vfs,
          });

          // No evidence means no gate: a bare "are you sure?" is not worth a turn.
          if (observed === null) {
            return { status: 'completed', detail: 'the working directory showed nothing to check' };
          }

          this.chat.completionGate.fire();
          // The sequence's own key, so a replay queues the same turn rather than a second one.
          this.chat.appendOwedTurn({
            text: completionGateText({ task: text, observed }),
            idempotencyKey: identity,
            event: COMPLETION_GATE_EVENT,
          });

          return {
            status: 'owed',
            detail: 'the confirming turn is queued and not yet on disk',
          };
        },
      }),
      overflow_retry: overflowRetryTerminalEffect(() => this.chat),
      task_reminder: taskReminderTerminalEffect(() => this.chat),

      turn_record: turnRecordTerminalEffect(this.actorSession.orchestrator),
      event_drain: eventDrainTerminalEffect(this.actorSession.orchestrator),

      improvement_lanes: terminalEffect({
        input: v.object({
          status: RunEndReasonSchema, turn: JsonValueSchema, workMode: WorkModeSchema,
          advisor: RecordedAdvisorSchema,
        }),
        // Verdict uses the recorded mode. Awaited to its checkpoint: before it nothing is on disk for
        // `recoverAdvisorLane`, so "recoverable" and "row done" must coincide.
        run: async ({ status, workMode, advisor }) => {
          if (!this.actorSession.orchestrator.improvementLanesOpen(status, workMode)) {

            return { status: 'completed', detail: 'improvement lanes closed for this turn' };
          }

          await this.actorSession.startAdvisorLane({
            turn: advisor.turn,
            snapshot: projectJsonValue({ value: advisor }),
            carry: (name, body) => this.trackFiber(name, body),
            review: () => this.runAdvisorReview(advisor),
          });

          return { status: 'completed' };
        },
      }),

      shadow_trial: shadowTrialTerminalEffect(this.engine),

      auto_title: terminalEffect({
        input: v.object({ subject: v.string() }),
        // Once-only: a persisted title no longer matches the plan. Awaited so a one-shot close joins it.
        run: async ({ subject }) => {
          await this.applyAutoTitle(subject);

          return { status: 'completed' };
        },
      }),
    };

    // Subordinates only. Replayable via the parent's dedupe key; the mode comes off the row so a cold
    // replay cannot turn a Plan report into a Build one.
    if (relay === null) return base;

    return {
      ...base,
      parent_report: terminalEffect({
        input: v.object({
          text: v.string(), status: v.picklist(SUBORDINATE_REPORT_STATUSES),
          sequenceId: v.string(), mode: WorkModeSchema,
        }),
        run: async ({ text, status, sequenceId, mode }) => ({
          status: 'completed',
          detail: await relay.send({ text, status, mode, sequenceId }),
        }),
      }),
    };
  }

  private terminalTransitions: TerminalTransitions | null = null;

  /** Lazy: the effect bodies close over stores the constructor is still assembling. */
  private get terminal(): TerminalTransitions {
    this.terminalTransitions ??= new TerminalTransitions({
        sql: this.rt.storage.sql,
        actor: this.rt.actor,
        effects: this.terminalEffectTable(),
        now: () => Date.now() + this.terminalClockSkewMs,
        fault: () => this.terminalEffectFault,
        // A real transaction on the same connection, so an interruption leaves a suffix, never a prefix.
        transaction: <T,>(body: () => T): T => this.db.transaction(body)(),
        // A re-announced turn keeps its id, so two responses can share a `turnId`; without this a close
        // deleted the live claim.
        turnIsLive: (turnId) => this.chat.pumping && this.chat.currentTurnId === turnId,
      scheduleRetry: (atMs) => this.scheduleTerminalRetry(atMs),
    });

    return this.terminalTransitions;
  }

  /**
   * Wake for an owed effect: the next start (durable) plus an unref'd timer in this process (live),
   * collapsed onto the earliest requested instant. The timer must not hold a finished process open.
   */
  private async scheduleTerminalRetry(atMs: number): Promise<void> {
    if (this.chat.closed || this.terminalRetryAt <= atMs) return;
    this.clearTerminalRetry();
    this.terminalRetryAt = atMs;

    const timer = setTimeout(async () => {
      this.clearTerminalRetry();

      // Job sweep first, in its own try: this timer is also a deferred job's wake, and only
      // `recoverBackgroundJobs` reaches `recoverOrphans` otherwise.
      try {
        await this.jobRunner.recoverDueResumes();
      } catch (cause) {
        diagnostics.failure('jobs.due_resume_failed', toKinuError({
          doing: 'resuming a background job whose next attempt came due', cause, otherwise: 'unavailable',
        }));
      }

      try {
        await this.recoverTerminalTransitions();
      } catch (cause) {
        const failure = toKinuError({
          doing: 'retrying the effects a settled turn still owed', cause, otherwise: 'unavailable',
        });

        diagnostics.failure('turn.terminal_retry_failed', failure);
      }
    }, Math.max(0, atMs - Date.now()));

    timer.unref();
    this.terminalRetryTimer = timer;
  }

  private clearTerminalRetry(): void {
    if (this.terminalRetryTimer) clearTimeout(this.terminalRetryTimer);
    this.terminalRetryTimer = null;
    this.terminalRetryAt = Infinity;
  }

  private terminalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalRetryAt = Infinity;

  /** Test-only deterministic cut point in the terminal sequence; null in production. */
  protected terminalEffectFault: TerminalEffectFault | null = null;

  /** Test-only clock skew past the retry backoff; zero in production. */
  protected terminalClockSkewMs = 0;

  /** Keep the process alive for a terminal close; `end()`/`settleBackgroundWork()` join it before the
   *  database closes (the DO's durable fiber equivalent). */
  private holdTerminalClose(transition: TerminalTransition, close: () => Promise<void>): void {
    const closing = this.trackFiber('turn.terminal_close', async () => { await close(); });
    this.tracked(async () => {
      try {
        await closing;
      } catch (cause) {
        await this.terminal.closeFailed(transition, { cause });
      }
    });
  }

  /** Prompt names: the workspace, plus the subagent's own name. Never the slug, which is an address. */
  private promptIdentity(): PromptIdentity {
    const own = this.config.getDisplayName();

    return this.workspaceTitleSource
      ? { agent: own, workspace: this.workspaceTitleSource() }
      : { workspace: own };
  }

  /**
   * Auto-title via core's naming policy (identity/naming.ts). The plan is checked synchronously first
   * so titled workspaces skip the model call. Only an Error from the suggestion is best-effort.
   */
  private async applyAutoTitle(mission: string): Promise<void> {
    const state: WorkspaceTitleState = {
      // `agentName()` reads the root's slug; a child's codename comes from its roster name.
      slug: this.rt.actor.parentActorId === null ? this.agentName() : this.rt.actor.name,
      displayName: this.config.getDisplayName(),
      nameOrigin: this.config.getNameOrigin(),
      mission,
    };

    if (planWorkspaceTitle(state) === null) return;
    await applyWorkspaceTitle(state, {
      persist: (name) => {
        if (!persistAutoTitle(this.config, name)) return false;
        this.broadcast({ type: 'workspace_renamed', displayName: name });

        return true;
      },
      // Only an Error is absorbed; anything else reaches the owed row.
      suggest: async (text) => {
        try {
          return await this.suggestTitle(text);
        } catch (cause) {
          if (!(cause instanceof Error)) throw cause;
          diagnostics.failure('agent.auto_title_suggestion_failed', toKinuError({
            doing: 'deriving a title from the mission', cause, otherwise: 'unavailable',
          }));

          return null;
        }
      },
    });
  }

  /** Naming round-trip on the routed `fast` lane; `localRouteLlm` ties route and spend label. */
  private async suggestTitle(mission: string): Promise<string | null> {
    const profile = await this.routingProfile();
    const resolution = resolveModelRoute('fast', profile);

    if (!resolution) return null;

    return suggestWorkspaceTitle(
      (system, prompt) => this.localRouteLlm(resolution, system).complete(prompt),
      mission,
    );
  }

  /**
   * The one review body the live lane and recovery run. `gateOpen` is local-only: while the completion
   * gate waits, the advisor records its note silently. Governed off the turn's labels. Never throws.
   */
  private async runAdvisorReview(recorded: RecordedAdvisor): Promise<void> {
    if (this.rt.actor.parentActorId !== null) {
      await this.actorSession.reviewTurn(recorded, recorded.gateOpen);

      return;
    }

    await reviewRecordedTurn({
      snapshot: recorded,
      llm: this.rt.advisorLlm,
      guidance: await advisorWorkspaceGuidance({
        vfs: this.rt.agentStateVfs ?? this.rt.storage.vfs,
        limits: async () => this.modelCatalog.contextFor(resolveModelRoute('advisor', await this.routingProfile()).model),
      }),
      govern: (llm, labels) => this.budget.govern(llm, labels),
      gateOpen: recorded.gateOpen,
      send: (signal) => this.actorSession.orchestrator.inbox.send(signal),
      record: (note, turnId) => { this.engine.recordAdvisorNote(note, turnId); },
    });
  }

  private agentName(): string {
    try {
      return this.rt.storage.sql<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0]?.name ?? 'local';
    } catch (error) {
      diagnostics.event('local_session.agent_name_unreadable', { error: renderThrownChain({ cause: error }) });

      return 'local';
    }
  }

  /** Prompt-cache identity: provider/model, a per-conversation key (the `kinu-<name>` scheme Workers AI
   *  affinity pins with), and configured retention. */
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

  /** Key-less by default (DuckDuckGo + local HTML→markdown); a stored `tavily` credential upgrades search. */
  private getWebSearchProvider(): WebSearchProvider {
    if (this._webSearchProvider) return this._webSearchProvider;
    const getAuth = this.modelResolver?.getAuth;

    const options: Parameters<typeof createDefaultWebSearchProvider>[0] = {
      fetch: globalThis.fetch,
      clock: REAL_CLOCK,
    };

    if (getAuth) options.getAuth = getAuth;
    this._webSearchProvider = createDefaultWebSearchProvider(options);

    return this._webSearchProvider;
  }

  /** Skill bodies already in the turn's prompt, so a mid-turn steer adds only new ones. */
  private turnActiveSkillNames: readonly string[] = [];

  private resolveTurnSkills(
    userText: string,
    roleSkills: readonly string[] = [],
  ): Promise<TurnSkillSurface> {
    return resolveTurnSkills({
      vfs: this.rt.storage.vfs,
      config: this.config,
      userText,
      roleSkills,
      trust: this.instructionTrust,
      limits: this.modelCatalog.window(),
    });
  }

  private filterToolsBySkills(activeSkills?: ActiveSkillSet): ToolSet {
    return filterToolSetBySkills(this.tools, activeSkills);
  }

  /** Ports for core's scaffold evolution control plane (evolution/control.ts). */
  private get scaffoldControl(): ScaffoldControl {
    return {
      rt: this.rt,
      events: this.eventRecorder,
      sql: this.rt.storage.sql,
      history: this.stores.history,
      config: this.config,
      surface: (task, context, callScope) => createScaffoldCandidateSurface({
        rt: this.rt,
        profile: () => this.routingProfile([...Object.keys(this.tools), ...codemodeCapabilitiesFor(this.codemodeProviders('build'))]),
        bindModel: spec => this.modelResolver?.resolveModel(spec) ?? this.defaultModel('scaffold model lane'),
        modelContext: spec => this.modelCatalog.contextFor(spec),
        tools: () => this.rolloutTools(callScope ?? currentOperationProfile(this.rt.actor)?.turnId ?? WORKSPACE_RUN_ID),
        callScope,
        history: this.makeScaffoldHistory(),
        spend: { source: 'scaffold', report: this.modelCallSink, operations: this.modelOperations },
      }, task, context),
      model: async () => {
        const route = resolveModelRoute('scaffold', await this.routingProfile());

        return this.bindRouteModel(route).model;
      },
      judge: createLlmJsonJudge(this.rt.judgeModel ?? this.rt.llm),
      reportModelCall: this.modelCallSink,
      operations: this.modelOperations,
    };
  }

  /** Continual-refinement seams. `refiner` is absent without a roster substrate; the request then
   *  stays durable for a host that has one. */
  private get refinementDeps(): RefinementDeps {
    return {
      control: this.scaffoldControl,
      facts: this.factsStore,
      approvals: this.instructionApprovals,
      refiner: this.teamDeps?.temporary ?? null,
    };
  }

  async runRefinementLane(): Promise<void> {
    const step = await refinementPass(this.refinementDeps);

    if (step.step === 'idle') return;
    // A refinement can move the live prompt and facts block.
    this.invalidateModelState();
    this.emit({
      type: 'evolution',
      event: 'refinement',
      message: `Refinement ${step.request.id} is ${step.request.stage}: ${step.request.detail}`,
    });
  }

  /** Returns the durable request at `requested`: no model has run yet. */
  async requestRefinement(opts?: {
    turnIds?: readonly string[]; scope?: RefinementScope;
  }): Promise<RefinementRequestView> {
    const view = await requestOwnerRefinement(this.refinementDeps, opts);
    // Awaited, unlike the cloud nudge: a local `/refine` is a foreground terminal command.
    await this.runRefinementLane();

    return this.listRefinements(1).requests[0] ?? view;
  }

  /** The owner decides one staged edit. Never reachable from a tool surface. */
  async decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult> {
    const result = await decideRefinementRoute(this.refinementDeps, input);

    // A promoted skill changes the next prompt and tool surface.
    if (result.ok) this.invalidateModelState();

    return result;
  }

  /** The whole staged file plus the digest a decision must quote back. Never truncated: it is the approval surface. */
  showRefinement(requestId: string, routeIndex: number): Promise<StagedSkillResult> {
    return showRefinementRoute(this.refinementDeps, { requestId, routeIndex });
  }

  listRefinements(limit = 20) {
    return listRefinements(this.refinementDeps, limit);
  }

  getShadowStatus(): ShadowStatus {
    return getShadowStatus(this.rt.storage.sql, this.rt.actor);
  }

  /** 'auto' acts only on a conclusive promotion gate; 'promote'/'rollback' force it. */
  async applyScaffoldDecision(mode: 'auto' | 'promote' | 'rollback'): Promise<ScaffoldDecisionResult> {
    const result = await applyScaffoldDecision(this.scaffoldControl, mode);

    if (result.ok) this.invalidateModelState();

    return result;
  }

  /** GEPA pass over this workspace's scaffold; a strictly better winner enters shadow-eval → promote. */
  runScaffoldGepaOptimization(opts?: {
    maxIterations?: number; evalSize?: number; maxMetricCalls?: number;
  }): Promise<GepaOptimizationResult> {
    return runScaffoldGepaOptimization(this.scaffoldControl, opts);
  }

  /** `host.history`: a read-only, budgeted page, resolved per call. */
  private makeScaffoldHistory(): NonNullable<ScaffoldRunOptions['history']> {
    return createScaffoldHistory(async () => this.actorSession.history);
  }

  /** Replay-eval re-run: current prompt and model, facts block, isolated history, no tools. */
  async runReplayTask(task: string): Promise<string> {
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
      modelContext: {
        id: this.effectiveModelSpec(),
        ...this.modelCatalog.window(),
      },
      system: systemPrompt,
      history: [{ role: 'user', content: task }],
      dynamicContext: {
        ledger: new DynamicContextLedger(),
        snapshot: () => ({ factsBlock: this.renderFactsForTurn(), memoryTail }),
      },
      tools: {},
      stopWhen: stepCountIs(1),
    })) {
      if (ev.type === 'text-delta') text += ev.delta;
      else if (ev.type === 'done' && ev.text.trim()) text = ev.text;
    }

    return text;
  }

  /** Live state for one model step (DO dynamicContextSnapshot peer). Nothing clock-derived: a
   *  wall-clock field would re-fingerprint the block every request. */
  private dynamicContextSnapshot(memoryTail: string | undefined, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext {
    return collectDynamicContext({
      rt: this.rt,
      stores: this.stores,
      profile,
      tools,
      memoryTail,
      missingCapabilities: this.mcpUnavailable,
      subordinateDelegates: () => subordinateDelegatesOf(this.teamDeps?.snapshot() ?? []),
      approvals: () => {
        const items = [...this.deferrals.approvals()];

        if (this.pendingShellApproval !== null) items.push(this.pendingShellApproval);

        return { items, total: items.length };
      },
    });
  }

  // Ports resolved at call time by `createLocalOrchestration`, which runs before this session exists.

  /** Same catalog session as the context window, so estimate and ledger read one rate. */
  modelPricing(spec?: string): ModelPricing | null {
    return this.modelCatalog.pricing(spec);
  }

  reportModelCall(report: ModelCallReport): void {
    this.modelCallSink(report);
  }

  reportBudgetRefusal(refusal: Omit<Extract<RunEventInput, { type: 'budget_exhausted' }>, 'type'>): void {
    this.recordRunEvent({ type: 'budget_exhausted', ...refusal });
  }

  reportActorRunEvent(actor: ActorHandle, event: Extract<RunEventInput, { type: 'tool_call_end' | 'step_finish' }>): void {
    if (sameActorReference(actor, this.rt.actor)) {
      this.recordRunEvent(event);

      return;
    }

    const hosted = this.actorHost.hosted(actor);
    const claim = hosted?.session.turnClaim;

    if (hosted === null || claim === undefined || claim === null) {
      throw new KinuError('missing', 'A reporting actor has no active turn for its event.');
    }

    this.recordRunEvent(event, claim.runId, hosted.stores.eventRecorder);
  }

  reportEvolutionEvent(event: { readonly type: string; readonly message: string }): void {
    this.emit({ type: 'evolution', event: event.type, message: event.message });
  }

  queueShadowTrial(turn: ShadowTrialTurn, plan: ShadowTrialPlan): ShadowTrialQueueOutcome {
    return queueTurnShadowTrial(this.scaffoldControl, turn, plan);
  }

  /** A resolved gate swaps the live scaffold, so model-bound state is dropped. */
  async runShadowTrials(): Promise<ShadowTrialDrain> {
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
  }

  /** The ActorHost for a session with no {@link LocalAgentHost} above it; it is the root of its tree. */
  private buildOwnActorHost(hubSql: SqlExec): ActorHost {
    const { directory } = localActorDirectory(this.rt.actor);

    return createActorHost({
      storage: {
        sql: this.rt.storage.sql,
        transactionSync: (write) => this.rt.storage.transactionSync(write),
        exec: (query, ...bindings) => hubSql.exec(query, ...bindings),
      },
      directory,
      installedBuild: null,
      // The seater's observer if any; `nodeSeats` tells the builder a head row seats a node.
      runtimeFor: (bound) => buildLocalActorRuntime(this.rt, bound, this.pendingWriteObserver(bound.reference.actorId), this.nodeSeats.has(bound.reference.actorId)),
      filesFor: async (bound) => {
        if (!this.rt.filesForActor) throw new KinuError('missing', 'workspace has no actor file-plane resolver');

        return this.rt.filesForActor(bound.handle);
      },
      orchestrationFor: (bound) => createLocalOrchestration({
        runtime: bound.runtime,
        history: bound.stores.history,
        eventLog: new EventLog(hubSql, bound.handle),
        // Heads and nodes run in this process, so this session is their fan-out and queue.
        session: () => this,
        oneShot: this.oneShot,
        noAutoEvolve: !this.engine.enabled,
      }).deps,
      // A head inherits the parent's promoted program, making it a fork of this agent.
      loopFor: (bound) => ({
        origin: this.loopOrigins.get(bound.reference.actorId) ?? defaultLoopOrigin(bound.record.kind),
        parent: this.rt,
      }),
      contextEvents: (bound) => bound.stores.eventRecorder,
    });
  }

  private renderFactsForTurn(): string | undefined {
    return renderFactsForTurn(this.factsStore);
  }

  /** Byte-stability telemetry: the system prompt should change only on soul/skill/model events. */
  private lastSystemPromptHash: string | null = null;
  private recordSystemPromptHash(system: string): void {
    const { hash, status } = observeSystemPromptHash(this.lastSystemPromptHash, system);

    if (status === 'changed') {
      this.emit({ type: 'evolution', event: 'system_prompt_hash', message: `changed → ${hash}` });
    }

    this.lastSystemPromptHash = hash;
  }

  /** Swarm nodes run in this process as hosted actors, with homes from the uid-0 view. */
  private buildAgentsSwarmDeps(): AgentsSwarmDeps {
    const nodeHome = this.rt.nodeHome;
    const nodeRuntime = this.rt.nodeRuntime;

    return {
      rt: this.rt,
      // A factory: wave deps are shallow-copied per child, so a shared actor would share one claim ledger.
      hostNode: (node) => this.hostNode(node),
      announceHeadActivity: () => this.headActivity,
      reportNodeDelta: () => this.publishHeadStream,
      model: this.cachedModel ?? this.defaultModel("an agents swarm"),
      reportModelCall: this.modelCallSink,
      nodeCodemode: (actor) => hostedCodemodeTool(actor, this.headCodemodeExtras()),
      webSearch: this.getWebSearchProvider(),
      originContext: () => this.actorSession.history,
      costModel: () => ({
        spec: this.effectiveModelSpec(),
        pricing: this.modelCatalog.pricing(),
      }),
      // Only the runner knows which profile snapshot applies (caller's, or frozen on re-drive), so it
      // picks the spec; a swarm with a profile refuses rather than run the caller's model.
      resolveModel: (spec: string) => this.resolveModelForSpec(spec),
      // `facetHomeProvisioner` keyed on the node actor's storage key (`head-` namespace). Built per
      // swarm call; a runtime without a host reports `shared-origin-plane`.
      provisionNodeHome: nodeHome === undefined
        ? undefined
        : () => async (node) => {
          const actor = registerLocalNode(this.rt.actor, node);

          return facetHomeProvisioner(nodeHome(), () => requireLocalActorWorkspace(this.rt.actor, actor))(headAgentName(actor.storageKey));
        },
      // Wired from the same runtime as the host, so the uid and filesystem cannot come from different workspaces.
      runtimeForNodeWorkspace: nodeRuntime === undefined
        ? undefined
        : () => (home, node) => nodeRuntime(home, registerLocalNode(this.rt.actor, node), this.rt),
    };
  }
  /** Team transport from the owning LocalAgentHost; absent, team actions are structurally missing. */
  private teamDeps: TeamToolDeps | null = null;
  /** Peer transport, roots only; absent, `reply` does not exist and ask/send reach subordinates only. */
  private peersDeps: PeersToolDeps | null = null;
  /** Report transport, subordinates only. */
  private reportDeps: ReportToolDeps | null = null;
  /** Automatic turn-end relay for a subordinate, distinct from the model's own {@link reportDeps}. */
  private parentRelay: LocalParentRelay | null = null;

  /** Installed after construction: roster and peer inbox need the session's broadcast. */
  setTeam(deps: TeamToolDeps): void {
    this.teamDeps = deps;
  }

  setPeers(deps: PeersToolDeps): void {
    this.peersDeps = deps;
  }

  setReport(deps: ReportToolDeps): void {
    this.reportDeps = deps;
  }

  setParentRelay(relay: LocalParentRelay): void {
    this.parentRelay = relay;
  }

  /** A parent exists and the parent drove this turn; an owner-driven chat stays private. */
  private reportGateOpen(): boolean {
    return this.reportDeps !== null && this.turnIsParentAssigned;
  }

  /** A root (only its plan has an owner) on a Plan turn. Cloud: `OrchestratorAgent.actorToolDeps`. */
  private planSubmissionOpen(mode: WorkMode): boolean {
    return mode === 'plan' && this.planReviewSurface();
  }

  /** The typed mode, except a build turn is held in Plan while a submitted plan awaits the owner;
   *  `plan_approved` metadata passes. Mirrors the cloud orchestrator's `workModeForMetadata`. */
  private turnWorkMode(metadata: ProgrammaticTurn['metadata']): WorkMode {
    const requested = this.actorSession.workMode;

    if (!this.planReviewSurface()) return requested;

    return workModeUnderReview(requested, metadata, this.stores.planReviews.getActive(CHAT_SESSION_ID));
  }

  private agentsToolDeps(mode: WorkMode): AgentsToolDeps {
    const swarm = this.buildAgentsSwarmDeps();
    const base: AgentsToolDeps = { mode, swarm, budget: this.budget };
    base.profile = () => agentsProfileContext(this.actorSession.profile, this.actorSession.profileInputs);

    if (this.teamDeps) base.team = this.teamDeps;

    if (this.peersDeps) base.peers = this.peersDeps;

    return base;
  }

  private readInheritedContext(): Promise<SerializedMessage[]> {
    return inheritedContextFromTranscript(this.stores.history.transcript(CHAT_SESSION_ID));
  }

  /** The shared background wrap (core background-tools), the same the cf backend applies: shallow
   *  clone, 30s threshold, per-call abort. */
  private wrapToolsForBackground(raw: ToolSet): ToolSet {
    return wrapToolsForBackground(raw, {
      jobRunner: this.jobRunner,
      backgroundable: BACKGROUNDABLE_TOOLS,
      mode: () => this.actorSession.workMode,
    });
  }

  /** One routed non-turn lane as an {@link LLM}. `system` carries core-declared prompt pairs so the
   *  CLI issues the same request as the cloud backend. */
  private localRouteLlm(resolution: ModelRouteResolution, system?: string): LLM {
    const { model, providerOptions } = this.bindRouteModel(resolution);

    return {
      async *stream() { yield ""; },
      complete: async (prompt: string): Promise<string> => {
        const request: Parameters<typeof generateText>[0] = { model, prompt };

        if (system !== undefined) request.system = system;

        if (providerOptions) request.providerOptions = providerOptions;
        const result = await generateText(request);

        const report = {
          source: resolution.source,
          spec: resolution.model,
          usage: normalizeUsage(result.usage),
          account: callAccountOf(result.response ?? {}),
        };

        const modelId = result.response?.modelId;
        this.modelCallSink(modelId
          ? { ...report, modelId }
          : report);

        return result.text.trim();
      },
    };
  }

  /** A routed lane's client and effort options, shared with the head merge (policy in core's
   *  `headMergeLLM`). A resolver-less session resolves every lane to its one model. */
  private bindRouteModel(resolution: ModelRouteResolution): HeadMergeModelBinding {
    const model = this.modelResolver
      ? this.modelResolver.resolveModel(resolution.model)
      : this.defaultModel(`${resolution.source} model lane`);

    const providerOptions = reasoningEffortOptions(
      resolution.reasoningEffort,
      parseModelSpec(this.profiles().normalizeSpec(resolution.model)).provider,
    );

    return providerOptions ? { model, providerOptions } : { model };
  }
  /** Precedence is core's `resolveRoutingProfile`, shared with the Cloudflare backend. Asked per call:
   *  a lane built at construction must not pin the account's tier from then. */
  private async routingProfile(availableTools: readonly string[] = []): Promise<ResolvedTurnProfile> {
    return resolveRoutingProfile({
      actor: this.rt.actor,
      resolve: () => this.profiles().resolvePreTurn(availableTools),
    });
  }

  /** The runtime's profile authority, refined at construction; the single source for resolution. */
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

  /** Drop the cached provider listing after an unobservable change (credential, connection, sign-in). */
  refreshProviderListing(): void {
    this.profiles().refreshListing();
  }

  /** A static-model session answers only for its own model; other specs are refused by name. */
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

  /** Claimed tier, else stored spec. Never the cached spec, which is null between a config change
   *  and the next turn. */
  private effectiveModelSpec(): string {
    return resolveEffectiveModelSpec({
      live: () => this.actorSession.profile?.tier.model,
      stored: () => this.config.getModel(),
      normalize: (spec) => this.profiles().normalizeSpec(spec),
    });
  }
  /** The static model, or a failure naming `what` could not run. */
  private defaultModel(what: string): LanguageModel {
    if (!this.fallbackModel) {
      throw new Error(
        `No default model to run ${what}: set one with /model or kinu model.`
      );
    }

    return this.fallbackModel;
  }

  /** Shared catalog view (core model-catalog); static fallbacks answer until the lookup lands. */
  private readonly modelCatalog = new ModelCatalogSession({
    effectiveSpec: () => this.effectiveModelSpec(),
    lookup: (spec) => this.modelResolver ? this.modelResolver.modelInfo(spec) : Promise.resolve(null),
  });

  private ensureModelState(): LanguageModel {
    const spec = this.actorSession.profile?.tier.model ?? this.profiles().normalizeSpec(this.config.getModel());

    if (this.cachedModel && this.cachedModelSpec === spec) return this.cachedModel;
    const model = this.modelResolver ? this.modelResolver.resolveModel(spec) : this.defaultModel("this static-model session");
    this.cachedModel = model;
    this.cachedModelSpec = spec;
    // Start the lookup at claim time: `kinu exec` runs one turn, and a lazy lookup would never land in time.
    this.modelCatalog.info();
    this.rebuildModelBoundState(model);

    return model;
  }

  private invalidateModelState(): void {
    this.cachedModel = null;
    this.cachedModelSpec = null;
  }

  /** One list for both the turn resolver and the tool builder, so they cannot disagree.
   *  `release` is build-mode only. */
  private codemodeProviders(mode: WorkMode): CodemodeProvider[] {
    const report = this.reportGateOpen() ? this.reportDeps : null;

    return [
      createAgentSelfProvider(agentSelfHost({
        rt: this.rt,
        scaffoldControl: () => this.scaffoldControl,
        triggers: () => this.triggerRegistry,
        jobs: () => this.jobs,
        budget: () => this.budget,
        cancelTrigger: (id, caller) => this.cancelTrigger(id, caller),
        armCompactNow: () => { this.compactionState.armForceCompaction(this.cacheIdentity().sessionKey); },
      })),
      createAgentsCodemodeProvider(() => this.agentsToolDeps(mode)),
      createStateCodemodeProvider(this.rt.actor.programState),
      // Plan scoping follows the resolved table scope, read from the live invocation.
      createDbCodemodeProvider(this.stores.appData),
      createWebCodemodeProvider(this.getWebSearchProvider()),
      // `this.taskList` is the same TaskListStore the dynamic-context snapshot reads.
      createMemoryCodemodeProvider(() => ({
        memory: this.rt.memory, facts: this.factsStore, sql: this.rt.storage.sql,
        actor: this.rt.actor,
        transcriptFor: (sessionId) => this.stores.history.transcript(sessionId),
        vectorStore: null,
      })),
      createTasksCodemodeProvider(
        this.taskList,
        this.config,
        () => this.actorSession.profileInputs?.envelope ?? null,
      ),
      ...(mode === 'build' ? [createReleaseCodemodeProvider(() => this.releaseToolDeps())] : []),
      // Same gate as the native `report` tool.
      ...(report ? [createReportCodemodeProvider(() => report)] : []),
    ];
  }

  /** One builder for constructor and rebind; a copy omitting `resolveModel` makes per-search
   *  models a silent no-op (see `createCLIHeadRuntime`'s tests). */
  private headRuntimeOptions(
    model: () => LanguageModel,
  ): CLIHeadRuntimeDeps {
    // Named interface, not Parameters<...>[0], so the field-supply census sees this site.
    const options: CLIHeadRuntimeDeps = {
      model,
      // Merge model, effort and spend label are core's policy (`headMergeLLM`).
      profile: () => this.routingProfile(),
      bindMergeModel: (route) => this.bindRouteModel(route),
      // No `spec` stamp: the merge runs on the routed judge tier; the provider's `modelId` is the record.
      reportModelCall: (report) => this.modelCallSink(report),
      operations: this.modelOperations,
      parentRuntime: this.rt,
      webSearch: this.getWebSearchProvider(),
      codemodeExtras: () => this.headCodemodeExtras(),
      grounding: this.buildHeadGrounding(),
      governor: () => this.budget,
      journal: () => this.headJournal,
      publishHeadStream: this.publishHeadStream,
      hostHead: (input, writes) => this.hostHead(input, writes),
    };

    if (this.modelResolver) {
      const modelResolver = this.modelResolver;
      options.resolveModel = (spec) => modelResolver.resolveModel(spec);
    }

    return options;
  }

  /**
   * Seat one head as a logical actor: its own directory row, runtime objects, claimed loop and, on
   * release, retirement. Public so callers without a session (bench panel, eval arm) can seat heads.
   */
  async hostHead(input: HeadInput, writes: WriteObserver): Promise<HostedHeadSeat> {
    const binding = registerLocalActor(this.rt.actor, {
      name: explorationActorKey(input.id), creationId: input.id, kind: 'head', lifetime: 'task',
    });

    const agentName = headAgentName(binding.storageKey);
    // Both named before acquire: the host seeds the loop and builds the runtime while building the actor.
    this.loopOrigins.set(binding.reference.actorId, input.loop);
    this.actorWrites.set(binding.reference.actorId, writes);
    const actor = await this.actorHost.acquire(binding.reference);

    return {
      actor,
      runId: this.chat.currentRunId ?? WORKSPACE_RUN_ID,
      profile: (profileInput) => this.resolveActorTurnProfile(actor, profileInput),
      dynamic: (profile, tools) => this.actorDynamicContext(actor, profile, tools),
      release: async () => {
        this.actorHost.release(binding.reference);
        this.loopOrigins.delete(binding.reference.actorId);
        this.actorWrites.delete(binding.reference.actorId);
        await retireLocalActor(this.rt.actor, binding.name, binding.reference, async () => {
          if (this.rt.cwd) cleanupFacetCwdScratch(this.rt.cwd, agentName);
          else if (this.rt.nodeHome) await facetHomeReleaser(this.rt.nodeHome())(agentName);
        });
      },
    };
  }

  /** The write observer named for `actorId`. Public so `LocalAgentHost.runtimeFor` reads the same
   *  slot, keeping one reader of {@link actorWrites}. */
  pendingWriteObserver(actorId: string): WriteObserver | undefined {
    return this.actorWrites.get(actorId);
  }

  /**
   * Seat one swarm node as a logical actor; a factory per node (see core's `HostedNodeSeat`). No release:
   * retirement belongs to the owning search. Public so an eval can seat nodes through this session.
   */
  async hostNode(node: NodeIdentity): Promise<HostedNodeSeat> {
    const binding = registerLocalActor(this.rt.actor, {
      name: explorationActorKey(node.nodeId), creationId: node.nodeId, kind: 'head', lifetime: 'task',
    });

    // Declared before the host builds it: only this slot marks a head row as a node.
    this.nodeSeats.add(binding.reference.actorId);
    const actor = await this.actorHost.acquire(binding.reference);

    return {
      actor,
      runId: this.chat.currentRunId ?? WORKSPACE_RUN_ID,
      profile: (profileInput) => this.resolveActorTurnProfile(actor, profileInput),
      dynamic: (profile, tools) => this.actorDynamicContext(actor, profile, tools),
    };
  }

  /** Profile for one claimed hosted-actor turn, via the same authority as chat turns. */
  private async resolveActorTurnProfile(
    actor: HostedActor,
    input: { readonly availableTools: readonly string[]; readonly workMode: WorkMode },
  ): Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }> {
    const inputs = await this.profiles().inputs();

    const profile = resolveAgentTurnProfile({
      ...inputs,
      activeRoleId: actor.handle.config.getRoleSelection() ?? this.getActiveRoleId(),
      workMode: input.workMode,
      availableTools: [...input.availableTools],
      // A fork explores under its parent's promoted program and that program's skills.
      activeSkills: [],
      // The workspace pin applies to hosted-actor turns too.
      workspaceModel: this.config.getModel(),
    });

    return { profile, inputs };
  }

  /** Per-step context from the hosted actor's own stores, never this session's. */
  private actorDynamicContext(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext {
    return collectDynamicContext({
      rt: actor.runtime,
      stores: actor.stores,
      profile,
      tools,
      memoryTail: undefined,
      missingCapabilities: this.mcpUnavailable,
      subordinateDelegates: () => [],
      approvals: () => ({ items: [], total: 0 }),
    });
  }

  private rebuildModelBoundState(model: LanguageModel): void {
    this._headRuntime = createCLIHeadRuntime(this.headRuntimeOptions(() => model));

    for (const mode of ['build', 'plan'] as const) {
      const raw = buildActorTools(this.actorToolsetDeps(
        mode,
        // A closure: this toolset is rebuilt only on model change, but the turn changes every turn.
        () => currentOperationProfile(this.rt.actor)?.turnId ?? this.chat.currentTurnId ?? WORKSPACE_RUN_ID,
      ));

      this.toolSets[mode] = { raw, wrapped: this.wrapToolsForBackground(raw) };
    }

    this.activateToolMode(this.actorSession.workMode);
  }

  /** Tool deps with the effect-claim id as an argument; the id decides what a replay dedupes against. */
  private actorToolsetDeps(mode: WorkMode, turnId: () => string): ActorToolsetDeps {
    const deps: ActorToolsetDeps = {
      rt: this.rt,
      workMode: mode,
      history: this.stores.history,
      effectClaims: { sql: this.rt.storage.sql, actor: this.rt.actor, turnId },
      // Shell approval lives at the execution seam (execution/approval.ts), not per toolset.
      // Budget state lives on the accumulator so this model-lifetime toolset reads the live turn.
      contextBudget: this.actorSession.orchestrator.acc.context,
      fileLedger: this.actorSession.orchestrator.acc.files,
      escalations: this.actorSession.orchestrator.acc.escalations,
      craftedToolExecute: createNodeCraftedExecute(),
      vectorStore: null,
      codemode: (surface) => {
        // Narrowed by the same set as the native surface, so the sandbox cannot restore a dropped tool.
        const narrowing = narrowToolSurface(this.actorSession.profile?.allowedTools);
        const native: ToolSet = {};

        for (const [name, entry] of Object.entries(surface.native)) {
          if (narrowing.allowsTool(name)) native[name] = entry;
        }

        return createNodeCodemodeToolFactory({
          extraProviders: narrowing.narrowProviders(this.codemodeProviders(mode)),
        })({ ...surface, native });
      },
      agents: this.agentsToolDeps(mode),
      roleAuthority: () => this.actorSession.profileInputs?.envelope ?? null,
      facts: this.factsStore,
      webSearch: this.getWebSearchProvider(),
    };

    // The toolset is rebuilt per turn, so `report` exists only on parent-driven turns.
    if (this.reportGateOpen() && this.reportDeps) deps.report = this.reportDeps;

    if (this.planSubmissionOpen(mode)) {
      deps.submitPlan = { submit: (edits) => this.submitPlanEdits(edits) };
    }

    return deps;
  }

  /** Raw tools with the effect-claim id pinned to the rollout, so a live run and a replay claim the
   *  same call once. Raw because backgrounding would key work to the ambient turn. */
  private rolloutTools(callScope: string): ToolSet {
    return buildActorTools(this.actorToolsetDeps(currentOperationProfile(this.rt.actor)?.profile.workMode ?? 'build', () => callScope));
  }

  private activateToolMode(mode: WorkMode): void {
    const surface = this.toolSets[mode];

    if (!surface) throw new Error(`tool surface for ${mode} mode is unavailable`);
    this.tools = surface.wrapped;
  }
}

export { serializeContentForHeads } from '@kinu.run/core';

/** Resolve when `work` settles or `ms` elapses on `clock`; the timer is always disarmed. */
async function raceDeadline(clock: Clock, work: Promise<unknown>, ms: number): Promise<void> {
  let disarm = (): void => {};

  const expiry = new Promise<void>((expire) => { disarm = clock.after(ms, expire); });

  try { await Promise.race([work, expiry]); }
  finally { disarm(); }
}

