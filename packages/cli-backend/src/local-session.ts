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

import { realpathSync } from 'node:fs';
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
  LLM, ModelCallSink, ModelRouteResolution, HeadMergeModelBinding,
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult, PromptFile, SendLanding,
  SkillsVfs, ActiveSkillSet, TurnSkillSurface, FactsStore, KinuExtension,
  HeadRuntime, HeadGrounding, SerializedMessage, AgentConfigStore, ShellApprovalMode,
  ShellApprovalRequest, ShellApprovalOutcome, RequestShellApproval,
  DeferredApproval, DeferredApprovalAnswer,
  AgentsSwarmDeps, AgentsToolDeps, TeamToolDeps, PeersToolDeps,
  MissingCapability, DynamicApproval,
  RunEvent, RunEventInput, RunEventQuery,
  ReleaseStore, ReleaseToolDeps, BuiltinToolName,
  FileCheckpoints, FileCheckpointListing, FileRestorePlan, FileRestoreResult,
  CheckpointAvailability,
  WorkMode, JsonValue,
} from '@kinu.run/core';
import { TierIdSchema,
  ActorSession, type ActorTurnLease, type ActorExecutionInput,
  recoverActorTurns,
  type TurnSteering,
  type AgentStores, collectDynamicContext, subordinateDelegatesOf,
  type BackgroundJobStore, BackgroundJobRunner, type TaskListStore,
  backgroundJobNotice,
  DeferredApprovalQueue, DeferredApprovalStore,
  wrapToolsForBackground, BACKGROUNDABLE_TOOLS, resumeBackgroundJob, harvestBackgroundJob,
  BACKGROUND_POLICY, type BackgroundPolicy,
  type MctsSearchStore,
  EventLog,
  writeActivityLog,
  type RunEventRecorder,
  TriggerRegistry,
  // Ingress — core owns the gates; this session owns the local clock and the
  // process boundary in front of them.
  createTimerTrigger, cancelTrigger, fireDueTriggers,
  EvolutionEngine,
  readMemoryTail,
  listProposedTasks, updateProposedTaskStatus,
  agentsActionsFor,
  facetHomeProvisioner, facetHomeReleaser, headAgentName, explorationActorKey,
  type HostedNodeSeat, type NodeIdentity, type ModelPricing,
  type ShadowTrialTurn, type ShadowTrialPlan, type ShadowTrialQueueOutcome, type ShadowTrialDrain,
  type HeadInput,
  type HeadJournal, LiveHeadJournal, type AnnounceHeadActivity, type PublishHeadStream, reconcileInterruptedForks,
  jobRedriveResumeGate, resumableForkRoots,
  skillsVfsOver, resolveTurnSkills, filterToolSetBySkills, renderFactsForTurn,
  inheritedContextFromHistory,
  subordinateTurnContext, inheritedAsModelMessage,
  ModelCatalogSession, resolveEffectiveModelSpec,
  BUILTIN_TOOL_NAMES, isMcpToolKey,
  // The terminal transition — core owns the vocabulary, the roster, the state
  // machine and the replay; this backend supplies only the effect bodies and
  // the wake. The same class the Durable Object drives.
  TerminalTransitions, initTerminalEffectTable, declareTerminalRoster,
  takesTerminalEffect, branchesTerminalEffect, turnRecordTerminalEffect,
  eventDrainTerminalEffect, shadowTrialTerminalEffect,
  SUBORDINATE_REPORT_STATUSES,
  type SubordinateReportStatus, type TaskTurnEnding,
  terminalEffect, keyedScope,
  RunEndReasonSchema, WorkModeSchema,
  shadowTrialPlan, trimTrialContext,
  type TerminalTransition, type TerminalEffectTable, type TerminalEffectFault,
  type TerminalTurnParts, type OwedEffect,
  buildActorTools, buildMcpToolSet, buildSystemPromptSync, currentDateForPrompt,
  type ActorToolsetDeps,
  activePromptSectionOverrides,
  turnProvenanceForMetadata,
  runChat, type CountableRequest,
  parseModelSpec, agentAffinityKey,
  OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT,
  normalizeUsage,
  measureCompactionTrigger,
  observeCompletionState, completionGateText, COMPLETION_GATE_EVENT,
  AdvisorRecoverySnapshotSchema,
  ADVISOR_LANE_FIBER, advisorLaneStarted, markAdvisorLaneStarted, reviewRecordedTurn,
  advisorWorkspaceGuidance,
  createDefaultWebSearchProvider, createWebCodemodeProvider, type WebSearchProvider,
  createAgentsCodemodeProvider, createReleaseCodemodeProvider, createStateCodemodeProvider,
  type CodemodeProvider,
  createMemoryCodemodeProvider, createTasksCodemodeProvider,
  createReportCodemodeProvider, REPORT_TOOL, type ReportToolDeps,
  MissionGovernor,
  DynamicContextLedger, turnLocalContextMessage, unverifiedInstructionsMessage,
  observeSystemPromptHash,
  type DynamicContext,
  type MediaModality,
  createReleaseStore, initReleaseTables, releaseSqlFromExec,
  initWorkspaceBaselineTable, initWorkspaceSchema, initPendingSendTables, PendingSendStore,
  InstructionApprovalStore, listInstructionApprovals, gatherApprovableInstructions,
  admitInstructionDecision, type AdmittedInstructionDecision,
  openInstructionSource,
  type InstructionSourceRow, type InstructionSourceView,
  type InstructionTrustResolver,
  // The scaffold evolution control plane — core owns the drivers; this session
  // supplies the local surface they run against.
  applyScaffoldDecision, createLlmJsonJudge, getShadowStatus, listScaffoldVersions,
  proposeScaffold, runScaffoldGepaOptimization,
  queueTurnShadowTrial, runQueuedShadowTrials,
  type GepaOptimizationResult, type ScaffoldControl,
  type ScaffoldDecisionResult, type ScaffoldVersionView, createScaffoldCandidateSurface,
  type ShadowStatus,
  listReplayEvals, type ReplayEvalSummary,
  // Continual refinement — `/refine` and the automatic evolution-debt trigger.
  advanceRefinementLane, createRefinementStore, refinementDebt, refinementDebtRequest,
  decideRefinementRoute, refinementRequestView, requestRefinement, showRefinementRoute,
  type RefinementDecisionInput, type RefinementDecisionResult,
  type StagedSkillResult,
  type RefinementDeps, type RefinementRequestView, type RefinementScope,
  type RequestRefinementInput,
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
  changeActiveRole, agentsProfileContext, canonicalConversationId,
  resolveAgentTurnProfile, resolveModelRoute, resolveRoutingProfile, currentOperationProfile,
  buildModelCallEvent,
  applyWorkspaceTitle, persistAutoTitle, planWorkspaceTitle, suggestWorkspaceTitle,
  isPlaceholderMission, type WorkspaceTitleState,
  type PromptIdentity,
  roleChangeOutcomeText, narrowToolSurface, codemodeCapabilitiesFor,
  readSoul,
  type ResolvedTurnProfile, type TierId,
  decodeJsonValue, projectJsonValue, JsonValueSchema,
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
  stepContextLimit, admitMcpDescriptors, toolSurfaceTokens, toolsInWorkMode,
  createActorHost, defaultLoopOrigin, createDbCodemodeProvider,
  type ActorHost, type AgentRuntime, type HostedActor, type SqlExec, type ProfileAuthorityInputs,
  type AgentOrchestratorDeps, type LoopOrigin, type WriteObserver,
  // The ONE turn loop, and the transcript store the local backend keeps it over.
  ChatSession, ActorMessagesTranscript,
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
import { createCLIHeadRuntime, type CLIHeadRuntimeDeps, type HostedHeadSeat } from './head-runtime';
import { detectOrphanedFibers, type OrphanedFiber } from '@kinu.run/core';
import { connectMcpServers, type McpServerConfig } from './mcp';
import type { LocalModelResolver } from './model-resolver';
import {
  STATIC_MODEL_SPEC, resolverModelPlane, staticModelPlane,
  type LocalProfileAuthority, type ProfileAuthorityRefinement, type ProfileEnvelopeSource,
} from './profile-authority';


/**
 * This session's actor as the ROOT's host bound it.
 *
 * Absent from a session's options means this session owns its actor outright —
 * `kinu evolve`, `kinu exec`, a fixture — and builds each of these itself over
 * its own runtime. Present means a {@link LocalAgentHost} bound the actor over
 * the workspace's ONE database and this session drives it: the SAME
 * `ActorSession` the host holds, the same stores, and the same host every head,
 * node and hire beneath it is acquired from.
 */
export interface LocalHostedSession {
  readonly actor: HostedActor;
  /** The root's host — one per workspace database, for every actor in it. */
  readonly host: ActorHost;
  readonly engine: EvolutionEngine;
  readonly budget: MissionGovernor;
  readonly eventLog: EventLog;
}

/**
 * The orchestration one local actor's loop runs under, and the three objects
 * that are part of it.
 *
 * ONE construction site for both paths. The hosted path reaches it through
 * `ActorHostDeps.orchestrationFor`, which is called BEFORE the `ActorSession`
 * exists — the host builds that session FROM these deps — so every port here
 * resolves the driving session at CALL time rather than closing over it. That
 * is not a workaround: a broadcast, a replay task, a shadow trial and a budget
 * refusal all happen while a turn is running, which is long after this object
 * was built. The standalone path passes `() => this` and gets the same object.
 */
export interface LocalOrchestration {
  readonly deps: AgentOrchestratorDeps;
  readonly engine: EvolutionEngine;
  readonly budget: MissionGovernor;
  readonly eventLog: EventLog;
}

export interface LocalOrchestrationInput {
  readonly runtime: AgentRuntime;
  /** This actor's durable event rail — the queue both ingresses publish into. */
  readonly eventLog: EventLog;
  /** The session that drives this actor, read at call time. */
  readonly session: () => LocalAgentSession;
  /** This host runs ONE task turn and exits; it never starts the cadence. */
  readonly oneShot: boolean;
  /** The operator's explicit opt-out of automatic learning. */
  readonly noAutoEvolve?: boolean;
}

export function createLocalOrchestration(input: LocalOrchestrationInput): LocalOrchestration {
  // The cumulative spend governor — a scheduled run or a fork opts into a
  // label, and its refusals land in that run's durable event log. No label
  // means no cap, which is every ordinary session.
  const budget = new MissionGovernor({
    actor: input.runtime.actor,
    storage: input.runtime.storage,
    // Real USD: the catalog rates for whatever model the next turn resolves
    // to. Null until the lookup lands — the ledger then blends, and says so.
    pricing: () => input.session().modelPricing(),
    onExhausted: ({ error: _error, ...refusal }) => { input.session().reportBudgetRefusal(refusal); },
  });

  const engine = new EvolutionEngine(input.runtime, {
    enabled: input.noAutoEvolve !== true,
    // The turn review's own model calls debit the mission the reviewed turn
    // ran under — the same ledger, through the same seam, as the work it
    // reviews. Unbudgeted turns never reach it.
    governor: budget,
    // Replay-eval rollout: the current system prompt (lessons/facts/soul) +
    // model, tools disabled. Unlike the DO's sandboxed scaffold rollout, a
    // local re-run with tools would re-execute shell work on the user's
    // machine and can block on shell approvals — so CLI replay measures the
    // prompt/model config, not tool trajectories.
    replayTaskRunner: (task) => input.session().runReplayTask(task),
    shadowTrialQueue: (turn, opts) => input.session().queueShadowTrial(turn, opts),
    // The trial itself runs on the cadence lane. A resolved gate changes the
    // live scaffold under us, so the session's model-bound state is dropped
    // and the decision is surfaced like any other self-change.
    shadowTrialRunner: () => input.session().runShadowTrials(),
  });

  engine.onEvent((event) => { input.session().reportEvolutionEvent(event); });

  return {
    engine,
    budget,
    eventLog: input.eventLog,
    deps: {
      // The five loop capabilities that are platform-shaped. Resolved per call
      // for the reason this factory's own doc gives.
      host: {
        broadcast: (event) => { input.session().broadcast(event); },
        enqueueTurn: (turn) => input.session().enqueueTurn(turn),
        // 'is a turn in flight' is a FACT the seam reads, not a policy — so it
        // answers `false` rather than throwing when the actor's seat is gone:
        // `settled` and `busy` call it on a detached continuation that can
        // outlive the host's teardown (an enqueue that resolves as the session
        // ends leaves the inbox's settle handler running past byActor.clear()).
        // The cf seam (`seams.turnInFlight`) already answers `false` for an
        // unhosted actor for the same reason.
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
        get headRuntime() { return input.session().headRuntime; },
      },
      engine,
      eventLog: input.eventLog,
      budget,
      oneShot: input.oneShot,
      refinementLane: () => input.session().runRefinementLane(),
      sinks: {
        logActivity: (event, detail) => { input.session().logActivity(event, detail); },
        onToolCallEvent: (ev) => { input.session().reportToolCallEnd(ev); },
        onStepEvent: (ev) => { input.session().reportStepFinish(ev); },
      },
    },
  };
}

type PromptCacheIdentity = NonNullable<ChatOptions['cache']>;

type Writable<T> = { -readonly [Key in keyof T]: T[Key] };

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

/** The bun:sqlite handle this session needs: prepared statements for the
 *  EventsHub SqlExec adapter, and the real `transaction` — the approval
 *  migration writes its baseline and marker under one, and so does a settled
 *  turn's answer-plus-roster commit. A torn write that reports success is what
 *  an identity-function stand-in would buy. */
export type LocalSessionDb = Pick<Database, 'prepare' | 'transaction'>;

/**
 * The advisor's recorded input on THIS backend: core's whole recovery snapshot,
 * plus the one decision input the Durable Object does not have.
 *
 * The completion gate is the other harness voice at a turn boundary and it lives
 * on this surface only. Its armed state is RAM, so a replayed review always read
 * it closed and said a note the gate should have held back. Recorded here, the
 * verdict a replay reaches is the verdict the turn earned.
 */
const RecordedAdvisorSchema = v.object({
  ...AdvisorRecoverySnapshotSchema.entries,
  gateOpen: v.boolean(),
});

type RecordedAdvisor = v.InferOutput<typeof RecordedAdvisorSchema>;

/**
 * The answer a subordinate's turn owes its parent, as the terminal roster sees
 * it.
 *
 * Installed by the owning host, which is the only thing that knows the parent's
 * rail and whether this turn was the parent's to drive. It is a PORT rather than
 * an event listener because the report is an OWED EFFECT: an untracked promise
 * started off `turn-end` leaves a process that dies before the parent's ingress
 * admits it with nothing on disk saying a retry was owed.
 */
export interface LocalParentRelay {
  /**
   * WHICH report this ending owes the parent, or null when it owes none.
   *
   * Not a boolean, because the two children answer differently. A `task` child
   * owes its caller a terminal answer on EVERY ending — an `agents.ask` is
   * blocked on it, and the branch that returned without one simply went quiet.
   * A `durable` child relays only a completed turn worth relaying: no `report`
   * tool call in the turn, a turn the parent drove, and something to say. Both
   * are suppressed once a report has already settled the run.
   */
  readonly owed: (
    ending: TaskTurnEnding, assistantText: string,
  ) => { readonly status: SubordinateReportStatus; readonly content: string } | null;
  /** This report's identity on the parent's rail: what the parent's ingress
   *  deduplicates on, so a replay cannot wake it twice. */
  readonly sequenceId: (messageId: string) => string;
  /** Publish it. Idempotent at the parent's ingress, on `sequenceId`. */
  readonly send: (report: {
    readonly text: string;
    readonly status: SubordinateReportStatus;
    readonly mode: WorkMode;
    readonly sequenceId: string;
  }) => Promise<string>;
}

// The spec a session with no `modelResolver` reports for its one model lives
// with the plane that answers it (profile-authority.ts); it is re-exported
// below because callers of this module name it.

export type { SessionEvent } from '@kinu.run/core';

/** An interactive answer to a gated shell command. Resolving null declines to
 *  decide, leaving the standing approval mode's own answer in force. */
export type ShellApprovalHandler =
  (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>;

export interface LocalAgentSessionOpts {
  rt: CLIRuntime;
  /** A new conversation's authored prefix, including an explicitly empty one.
   *  Ordinary reconnects omit this and restore the actor's working revision. */
  historySeed?: readonly ModelMessage[];
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
  /** The operator's opt-out of automatic step, turn and session learning. */
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
  /** The title of the workspace this session works in, read live, when this
   *  session is a SUBAGENT of that workspace rather than the workspace's own
   *  chat. Present makes the prompt name both; absent makes it name the
   *  workspace only, from this session's own config. The host supplies it
   *  because a child's config holds its own title and not its workspace's. */
  workspaceTitle?: () => string | null;
  /** How long a tool call may run before it is moved to the background, and how
   *  long teardown waits on work that has not settled. Fixed by the surface that
   *  opened the session (BACKGROUND_POLICY). Default: the interactive policy. */
  backgroundPolicy?: BackgroundPolicy;
  /**
   * This session's actor as the root's {@link LocalAgentHost} bound it, when
   * one did.
   *
   * Absent means this session owns its actor outright and builds every runtime
   * object for it — which is what `kinu evolve`, `kinu exec` and every fixture
   * are, and why they still work with no host in sight. Present means the ONE
   * workspace database already holds this actor's row and the root's host
   * already built its session, stores, engine, governor and event rail.
   */
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

type CurriculumStatus = 'pending' | 'accepted' | 'rejected' | 'completed';

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
  /** The turn loop, from core — see {@link ChatSession} for the invariants.
   *  This session is its adapter: the driver API below delegates to it, and
   *  the ports it was built over are this session's own methods. */
  private readonly chat: ChatSession;
  private readonly deferrals: DeferredApprovalQueue;
  /**
   * The host every LOGICAL ACTOR this session creates is acquired from —
   * heads, swarm nodes, and (through the team transport) hires.
   *
   * One per workspace database. Handed in when a {@link LocalAgentHost} owns
   * the tree; built here over this session's own runtime otherwise, because a
   * session with no host above it IS the root of its tree and its forks are
   * still logical actors of the one database rather than files of their own.
   */
  private readonly actorHost: ActorHost;
  /**
   * The loop origin each actor this session creates was CREATED with, until the
   * host has seeded it.
   *
   * A search may name a version (`agents swarm` carries one per head), and the
   * pointer is seeded while the host builds the actor — before its first claim.
   * So the creation site records its choice here and `loopFor` reads it; an
   * actor nobody named an origin for gets the default for its kind, which is
   * what every ordinary hire and head is.
   */
  private readonly loopOrigins = new Map<string, LoopOrigin>();

  /**
   * The origin this session recorded for an actor it is about to seat, if any.
   *
   * Public for the same reason the write-observer slot is: the DAEMON's host
   * builds the runtime and resolves the loop, but only the SEATING SESSION
   * knows what the creation site NAMED. Without this reader the daemon's
   * `loopFor` fell to `defaultLoopOrigin(kind)`, so a head that asked for one
   * SPECIFIC version of its parent's lineage got the parent's CURRENT source
   * under the daemon and the named version under a bare session — the same
   * host/session split, one map away from the same answer.
   */
  pendingLoopOrigin(actorId: string): LoopOrigin | undefined {
    return this.loopOrigins.get(actorId);
  }
  /**
   * The write observer each actor this session seats must be built OVER, until
   * the host has built it.
   *
   * THE SAME SHAPE AS {@link loopOrigins}, and for the same structural reason:
   * the HOST builds the runtime, but only the CALLER knows something the
   * runtime needs, and `ActorHostDeps.runtimeFor(bound)` is deliberately narrow
   * — it takes the binding and nothing the caller invented. So the answer is a
   * slot the caller fills before `acquire` and `runtimeFor` reads, never a
   * widened seam. Do not add a parameter to `runtimeFor` for this.
   *
   * What fills it is a head run's own `HeadCapture.files`: file attribution is
   * per RUN, so it cannot be a property of the actor or of this session.
   * Cleared on release beside the origin, so the slot's lifetime is the seat's
   * and the next head seated under the same reference cannot inherit it.
   */
  private readonly actorWrites = new Map<string, WriteObserver>();
  /**
   * The actor ids this session seated as swarm NODES, until the host has
   * built them.
   *
   * THE SAME SHAPE AS {@link loopOrigins}: the HOST builds the runtime, but
   * only the CALLER knows which mode the seat runs in, and
   * `ActorHostDeps.runtimeFor(bound)` is deliberately narrow. A node's seat is
   * a HEAD row with its mode declared here — the row cannot carry it, because
   * the row is what the directory reads back and the mode is what this
   * session's runtime builder needs. Never cleared: an acquire may repeat for
   * one node (register and acquire are both idempotent), and a second build
   * must take the same arm as the first.
   */
  private readonly nodeSeats = new Set<string>();

  /** The per-turn mechanical-steering ledger — what fired at which step and
   *  what came of it. A read-only named view; the orchestrator owns writes. */
  get steering(): TurnSteering {
    return this.actorSession.orchestrator.steering;
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
  /**
   * Where every non-turn model call in this workspace reports what it cost.
   *
   * The turn loop's own spend reaches this same log as `step_finish`. The judge,
   * the fast tier, the reflection seam and the heads' merge synthesis are
   * invisible to that row, so each of them files here instead of dropping the
   * provider's usage on the line that received it — a workspace total read off
   * `step_finish` alone is the orchestrator's turns while looking like it is
   * everything.
   *
   * The row itself — usage always present, `usd` only when the rate belongs to
   * the model that served the call — is built by core, so there is exactly ONE
   * construction of it and nothing can disagree about that field.
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
    this.recordRunEvent(event, currentOperationProfile(this.rt.actor)?.runId ?? this.chat.currentRunId ?? WORKSPACE_RUN_ID);
  };

  /**
   * Where this session's direct model operations record their start and end —
   * the same log as `modelCallSink`, projected through core's one shared
   * mapper. A start row with no end names the operation a dead process left
   * in flight; nothing here reads a clock.
   */
  private readonly modelOperations: ModelOperationSink = recordModelOperations(
    { emit: (runId, input): void => { this.recordRunEvent(input, runId); } },
    () => currentOperationProfile(this.rt.actor)?.runId ?? this.chat.currentRunId ?? WORKSPACE_RUN_ID,
  );
  private readonly triggerRegistry: TriggerRegistry;
  private readonly releases: ReleaseStore;
  private _webSearchProvider: WebSearchProvider | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledAlarmAt: number | null = null;
  /** Branching-heads runtime — local heads run in-process over isolated
   *  ephemeral runtimes. */
  private _headRuntime: HeadRuntime;
  private shellApprovalHandler: ShellApprovalHandler | null = null;
  private pendingShellApproval: DynamicApproval | null = null;
  private shellApprovalSequence = 0;
  private readonly sessionId: string;
  /** True when this process runs one task turn and exits — see the `oneShot`
   *  option. Decides turn continuity and whether the cadence lane may start. */
  private readonly oneShot: boolean;
  /** Whether a message arriving in THIS process can be a verdict on the turn
   *  before it. A one-shot process holds no conversation: its prompt came from
   *  a caller who never saw the previous answer. */
  private get turnContinuity(): TurnContinuity {
    return this.oneShot ? 'independent_task' : 'conversation';
  }
  private readonly cwd: string;
  /** The owner's standing instruction approvals for THIS working directory —
   *  the authority that decides whether discovered AGENTS.md / skill bytes are
   *  placed as system instructions or as unverified reference material. */
  private readonly instructionApprovals: InstructionApprovalStore;
  /** Bound once rather than rebuilt per turn: both discovery and skill
   * admission take the resolver as a plain function. */
  private readonly instructionTrust: InstructionTrustResolver =
    (path, content) => this.instructionApprovals.trustOf(path, content);
  /** Whether the message driving THIS turn came from this agent's parent
   *  rather than from whoever is chatting with it. A parent assignment is
   *  admitted as an event and drains as a programmatic turn, so the turn's own
   *  kind is the fact — and it is what gates the `report` surface. */
  private turnIsParentAssigned = false;

  /** The head journal this session's controller writes to — also the live fork
   *  roster the per-step dynamic context reads. */
  private readonly headJournal: HeadJournal;
  private readonly headActivity: AnnounceHeadActivity = (headId) => {
    this.broadcast({ type: 'head_activity', headId });
  };
  private readonly publishHeadStream: PublishHeadStream = (frame) => {
    this.broadcast({ type: 'head_stream', ...frame });
  };

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

  /** Steer-as-Branch redirects launched against the in-flight turn — each runs
   *  as one budgeted head and settles into Alternate Takes at turn end. */
  private pendingBranches: PendingBranch[] = [];
  /** The raw handle, for the ONE thing the SqlExecutor port cannot express: a
   *  transaction. What the answer, the run row and the frozen roster are
   *  committed inside, and what core's terminal claim commits its roster
   *  inside. */
  private readonly db: LocalSessionDb;
  /** Reads the title of the workspace this session works in, on a SUBAGENT
   *  session. Null on a workspace's own chat, where this session's own config
   *  already holds that title. */
  private readonly workspaceTitleSource: (() => string | null) | null;

  constructor(opts: LocalAgentSessionOpts) {
    this.db = opts.db;
    this.rt = opts.rt;
    this.oneShot = opts.oneShot === true;
    this.cwd = opts.cwd ?? this.rt.cwd ?? process.cwd();
    this.workspaceTitleSource = opts.workspaceTitle ?? null;
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

    // Every table a workspace has, on any backend — one list, in core. A
    // session can be constructed against a database that no open path touched
    // (a benchmark harness, `kinu exec` on a fresh clone), so it runs before
    // any store is built rather than trusting an earlier caller.
    const hubSql = makeSqlExec(opts.db);
    initWorkspaceSchema({ execRaw: this.rt.storage.execRaw, sql: this.rt.storage.sql, exec: hubSql });

    // THE ORCHESTRATION THIS ACTOR'S LOOP RUNS UNDER — hosted or not, built by
    // one factory. Hosted, the root's `ActorHost` already built it (it needed
    // it to construct the `ActorSession` below) and hands the three objects
    // back; standalone, this session is its own actor's whole host and builds
    // them now. Either way there is exactly ONE engine, ONE governor and ONE
    // event rail per logical actor.
    const own = opts.hosted ? null : createLocalOrchestration({
      runtime: this.rt,
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
    // The core terminal ledger is committed beside each local answer.
    initTerminalEffectTable(this.rt.storage.execRaw);
    // The pending-send admission ledger — the same core declaration the cf
    // backend's actor constructor runs, beside the terminal ledger. `turn_id`
    // is NULL when the send queued while the actor was idle.
    initPendingSendTables(this.rt.storage.execRaw);
    // The store over that ledger — one instance per actor, the same object the
    // cf actor lazily builds over its own executor.
    const pendingSends = new PendingSendStore(this.rt.storage.sql, this.rt.actor.actorId);

    // Instruction approvals are keyed by the directory on THIS disk, because on
    // a local CLI that directory IS the authority — there is no owner/workspace
    // pair to name. Resolved once: the answer is a filesystem fact, and a turn
    // should not pay a realpath for it. A cwd that has been deleted out from
    // under the process still gets an honest absolute scope, so a session that
    // outlives its directory cannot silently share another tree's approvals.
    const approvalScope = tolerate(() => realpathSync(this.cwd), 'enoent') ?? resolve(this.cwd);
    // ONE SCOPE, ONE STORE PER ACTOR. The approval key is
    // `(actor_id, scope, path)`, so a root and every actor beneath it read the
    // same DIRECTORY's decisions through their own row set. The store is NOT
    // shared as an object — it is actor-bound — and the sharing that
    // matters is the scope string, which every actor in one bound directory
    // derives identically.
    this.instructionApprovals = new InstructionApprovalStore(
      this.rt.storage.sql,
      this.rt.actor,
      `local:${approvalScope}`,
    );

    // The stores every agent has, from core — one list both backends inherit.
    // Background-job lifecycle rides the durable local fiber (createSqlFiber)
    // with this session as the BackendHost (enqueueTurn wakes the agent).
    //
    // HOSTED, they are the ones the root's host bound over the ONE workspace
    // database and the ones its `/context` plane reads; a second set over one
    // actor would be a second memo of one truth.
    this.stores = opts.hosted?.actor.stores ?? this.rt.stores;
    const stores = this.stores;
    this.jobs = stores.jobs;
    this.taskList = stores.taskList;
    this.headJournal = new LiveHeadJournal(this.rt.storage.sql, this.rt.actor, this.headActivity);
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



    // The EventsHub substrate (reactor source of truth). A local workspace has
    // two ingresses, a due timer and a settled background job; both publish
    // into the log and drain via AgentOrchestrator. The release board is the
    // one local-only plane: on cf it lives in the owner's UserDO
    // (core/conformance/manifest.ts records that).
    initReleaseTables(hubSql);
    this.releases = createReleaseStore(releaseSqlFromExec(hubSql), {
      validateAgentName: (name) => {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('invalid agent name');
      },
    });
    this.actorHost = opts.hosted?.host ?? this.buildOwnActorHost(hubSql);

    const alarmScheduler: AlarmScheduler = {
      // Synchronous here: the local host's wake-up is a process timer, not a
      // storage write, so there is nothing to await. The seam returns a promise
      // because the cloud host's arm is a Durable Object write that must land
      // inside its invocation (`do.wait_until.no_op`).
      scheduleAt: async (ts) => { this.scheduleLocalAlarm(ts); },
    };

    this.triggerRegistry = new TriggerRegistry(hubSql, this.rt.actor, alarmScheduler);

    // The durable per-run event log (run_events) — the same recorder, table and
    // RunEvent union the cloud backend records, over local SQLite — is written…
    // …and forwarded to the frontends as it is written. The table alone is
    // observable only to something that outlives the database, which a
    // benchmark container or a one-shot `kinu exec` does not.
    this.eventRecorder.observe((event) => this.emit({ type: 'run-event', event }));

    // THE ONE ActorSession for this logical actor. Hosted, the root's host
    // built it from the orchestration above — the same object `HostedActor`
    // carries, so a head or a node this session spawns claims its turns on the
    // very session the host holds. Standalone, this session is that host.
    this.actorSession = 'actor' in orchestration ? orchestration.actor.session : new ActorSession({
      runtime: this.rt,
      claims: this.stores.claims,
      // The local host publishes NO installed build identity for its builtin
      // loop: there is no build stamp on a `bun`-run checkout and the package
      // version in this repo is a placeholder, so a claim for a builtin turn
      // records the build as unknown rather than naming one nobody can verify.
      installedBuild: null,
      orchestration: orchestration.deps,
    });

    this.compactionState = createCompactionStateStore(this.rt.storage.sql, this.rt.actor);
    // THE ONE TURN LOOP, from core, over this backend's seams. The pump, the
    // send rule, the durable admission and the transcript are its; what this
    // session supplies is the turn's assembly, the effect bodies and their
    // ledger, the driver lease, the process the close holds open, and the
    // in-process callback the events reach the frontend through.
    this.chat = new ChatSession({
      actorSession: this.actorSession,
      sessionId: this.sessionId,
      transcript: new ActorMessagesTranscript(this.rt.storage.sql, this.rt.actor, this.sessionId),
      pendingSends,
      eventLog: this.eventLog,
      eventRecorder: this.eventRecorder,
      compactionState: this.compactionState,
      // The raw handle's transaction: `rt.storage.sql` and this session's
      // `db` are the same connection — the runtime is built over it.
      transaction: (body) => this.db.transaction(body)(),
      transport: { deliver: opts.onEvent },
      ports: {
        prepareTurn: (item, lease) => this.prepareTurn(item, lease),
        owedTerminalEffects: (input) => this.owedTerminalEffects(input),
        terminal: () => this.terminal,
        holdTerminalClose: (transition, close) => { this.holdTerminalClose(transition, close); },
        driverGate: () => this.driverGate?.() ?? null,
        modelWindow: () => ({
          contextWindow: this.sessionContextWindow(),
          modelOutputLimit: this.modelCatalog.modelOutputLimit(),
        }),
      },
    });
    // The resolver outlives the session that consumes it — it was built before
    // this session existed — so the wait sink is installed rather than
    // configured. Every notice lands in the run-event ledger as
    // `provider_wait`; the recorder's observe() forwards it to the surface the
    // same instant, which is how a rate-limited turn reads "waiting on …"
    // instead of just falling silent. `recordRunEvent` contains its own
    // failures, so a ledger fault cannot reach the sleeping request.
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
    // The runtime's judge / fast / reflection seams were built before this
    // session existed (createCLIRuntime), so this is the moment their reports
    // find a ledger. A runtime holds ONE sink: the live session's, exactly as it
    // holds one turn file ledger and one approval channel.
    this.rt.setModelCallSink?.(this.modelCallSink);
    this.rt.setModelOperations?.(this.modelOperations);
    this.deferrals = new DeferredApprovalQueue({
      store: new DeferredApprovalStore(this.rt.storage.sql, this.rt.actor),
      inbox: this.actorSession.orchestrator.inbox,
      remember: (grants) => { this.config.grantShellApproval(grants); },
      audit: (record) => {
        this.eventRecorder.emit(this.chat.currentRunId || WORKSPACE_RUN_ID, { type: 'approval_consumed', ...record });
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
      // Process exit is the local analogue of a DO eviction: re-drive an
      // interrupted job from its durable checkpoint instead of failing it.
      resume: (kind, input, mode, signal) => this.resumeBackgroundJob(kind, { value: input }, mode, signal),
      // What a bounded-out job already produced. Same predicate as `resume`, so a
      // side-effecting kind has nothing partial to read and a SEARCH does — without
      // it a search settles empty over candidates it had really measured.
      harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
        { sql: this.rt.storage.sql, ledger: this.mctsSearchStore, actor: this.rt.actor }, kind, input,
      )),
      // The wake for an attempt this process deliberately did not start. It arms
      // the session's ONE terminal-retry timer (soonest-wins, unref'd), whose
      // body sweeps due jobs before it replays owed effects — so a job waiting
      // out its backoff needs no timer of its own, and a process that exits
      // before the instant leaves the next start to carry it.
      scheduleResume: (atMs) => this.scheduleTerminalRetry(atMs),
    });
    // Scaffold cold-start heal (the DO's onStart parity): a workspace created
    // before scaffold bootstrap landed has no scaffold/agent.js, and
    // engine.maybeEvolveScaffold returns early when it is absent — silently
    // disabling the WHOLE scaffold-evolution loop on that workspace forever.
    // bootstrapScaffold is idempotent (exists-check + INSERT OR IGNORE v0);
    // tracked so end()/settleEvolution joins it before the process exits.
    this.actorSession.orchestrator.track(bootstrapScaffold(this.rt), 'Scaffold bootstrap');

    if (opts.historySeed === undefined) this.chat.restoreHistory();
    else this.actorSession.restoreHistory(opts.historySeed);
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

  /** The host passes this exact authority to every local child sharing the
   * workspace plane. It is intentionally not a copy: revocations are live. */
  instructionApprovalAuthority(): InstructionApprovalStore {
    return this.instructionApprovals;
  }
  /** Skills pinned always-active for this agent (the `/always` command). */
  getAlwaysActiveSkills(): string[] { return getAlwaysActiveSkills(this.config).names; }
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void { setAlwaysActiveSkills(this.config, names); }

  /**
   * The owner's instruction-file surface for this working directory
   * (KINU-N028): every AGENTS.md and workspace skill this session would carry,
   * with what an approval would bind.
   *
   * Discovery runs fresh rather than reporting the last turn's values, because
   * the owner has to be shown what is on disk NOW — approving a digest that has
   * already moved on would grant nothing and say it granted something. A file
   * with no owner decision is unverified, however long it has sat on disk.
   */
  async listInstructionApprovals(request: PageRequest = {}): Promise<Page<InstructionSourceRow>> {
    const limits = {
      contextWindow: this.sessionContextWindow(),
      modelOutputLimit: this.modelCatalog.modelOutputLimit(),
    };

    return listInstructionApprovals({
      ...request,
      sources: await gatherApprovableInstructions({
        agentsMd: discoverAgentsMd(this.cwd, limits, this.instructionTrust),
        skillsVfs: skillsVfsOver(this.rt.storage.vfs),
        admissionTokens: stepContextLimit(limits),
      }),
      decisions: this.instructionApprovals.list(),
    });
  }

  /** One row, opened: the bytes of THAT file and nothing else. */
  async readInstructionApproval(path: string): Promise<InstructionSourceView | null> {
    const clean = path.trim();

    if (clean === '') return null;

    const limits = {
      contextWindow: this.sessionContextWindow(),
      modelOutputLimit: this.modelCatalog.modelOutputLimit(),
    };

    return openInstructionSource({
      path: clean,
      agentsMd: discoverAgentsMd(this.cwd, limits, this.instructionTrust),
      skillsVfs: skillsVfsOver(this.rt.storage.vfs),
      trust: this.instructionTrust,
      decisions: this.instructionApprovals.list(),
      admissionTokens: stepContextLimit(limits),
    });
  }

  /** Follow these exact bytes at this path as instructions. Same admission rule
   *  as the cloud transport, because it is core's rule, not either side's. */
  async approveInstruction(path: string, reviewedDigest: string): Promise<AdmittedInstructionDecision> {
    const admitted = admitInstructionDecision(path, reviewedDigest);

    if (!admitted.ok) return admitted;
    const current = await this.readInstructionApproval(admitted.path);

    if (!current || current.digest !== admitted.digest) {
      return { ok: false, error: 'the file changed or could not be read after review; read it again before approving' };
    }

    this.instructionApprovals.approve(admitted.path, admitted.digest);

    return admitted;
  }

  /** Stop following a path, and keep the refusal so nothing re-grants it. */
  async revokeInstruction(path: string): Promise<AdmittedInstructionDecision> {
    const admitted = admitInstructionDecision(path);

    if (!admitted.ok) return admitted;
    this.instructionApprovals.revoke(admitted.path);

    return admitted;
  }

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
   *  one, 'strict' parks gate hits in the durable owner queue.
   *  Wired straight onto `rt.setShellApprovalChannel` — the SAME channel
   *  `rt.shell` and every `rt.executionRouter` provider consult, so an
   *  approval answers `shell` and every registered codemode executor's `exec()`
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

  async listDeferredApprovals(): Promise<DeferredApproval[]> {
    return this.deferrals.list();
  }

  async decideDeferredApprovals(
    ids: string[], decision: DeferredApprovalAnswer,
  ): Promise<{ decided: string[] }> {
    const decided = await this.deferrals.decide(ids, decision);

    return { decided: decided.map((action) => action.id) };
  }

  /**
   * `allow_always` is remembered here rather than in the gate, because the
   * session owns the config store the grant lives in.
   *
   * It grants exactly the rules that were asked about, on the executor they
   * were asked about (safety/approval-gate.ts's ApprovalGrant), which is what
   * the button says it does. NEVER a whole-agent `allow_all`: one click on one
   * `sudo` prompt would then run every gated command everywhere, on the owner's
   * laptop included, unasked for the rest of the session. Revocable from the
   * same config plane that reads it.
   */
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

  /** Stored model spec, or null when unset (parity with DO getStoredModelSpec). */
  getStoredModelSpec(): { spec: string | null } {
    return getStoredModelSpec(this.config);
  }

  /** Effective normalized model spec used for new turns. */
  getEffectiveModelSpec(): string {
    return this.effectiveModelSpec();
  }

  /** The catalog role id this agent resolves under. */
  getActiveRoleId(): string {
    if (this.actorSession.profile) return this.actorSession.profile.role.id;

    return this.config.getRoleSelection();
  }

  getEffectiveTierId(): string {
    if (this.actorSession.profile) return this.actorSession.profile.tier.id;
    const roleId = this.getActiveRoleId();

    return effectiveRoleCatalog(BUILTIN_PROFILE_CATALOG)[roleId]?.tier ?? 'default';
  }

  /**
   * Change the durable active role. Takes effect on the NEXT resolved turn —
   * `runTurn` re-reads `config.getRoleSelection()` every time, so there is no
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
      throw new Error(roleChangeOutcomeText(roleId, changed, this.getActiveRoleId()));
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

  /** The stored setting, as on cf — what `setReasoningEffort` writes, never the
   *  claimed tier's own effort: a reading that changed with the turn in flight
   *  showed an owner a value their own setting could not move. */
  getReasoningEffort(): ReturnType<typeof getReasoningEffort> {
    return getReasoningEffort(this.config);
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

  /** `caller` has no default, for the same reason the cloud backend's does not:
   *  the model's `agent.cancelSchedule` passes `'self'`, and core refuses a
   *  self cancel of an owner-created ingress. The operator's own cancel runs in
   *  another process, through the registry in the CLI's local inspection. */
  cancelTrigger(trigger_id: string, caller: TrustLevel): CancelTriggerResult {
    const result = cancelTrigger(this.triggerRegistry, trigger_id, Date.now(), caller);
    this.rearmLocalAlarm();

    return result;
  }

  async createTimerTrigger(opts: TimerTriggerOpts): Promise<TimerTrigger> {
    return await createTimerTrigger(this.triggerRegistry, opts, Date.now());
  }

  /** The local clock's half of timer ingress: fire what is due, then re-arm
   *  the process timer that will call this again. */
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

  /** The persisted replay-eval loss curve, newest first (read-only). */
  async getReplayEvals(limit?: number): Promise<ReplayEvalSummary[]> {
    return listReplayEvals(this.rt.storage.sql, this.rt.actor, limit);
  }

  // ── Evolution Changelog (parity with the DO's RPCs) ───────────────

  /** The self-change digest over the durable ledgers (core buildChangelog). */
  getEvolutionChangelog(limit = 50): EvolutionChangelogView {
    return getEvolutionChangelog(this.rt.storage.sql, this.rt.actor, limit);
  }

  /** The operator viewed the changelog — zero the unseen badge. */
  markChangelogSeen(): ReturnType<typeof markChangelogSeen> {
    return markChangelogSeen(this.config);
  }

  /** Revert one changelog entry through the real machinery (scaffold
   *  rollback / craft retire / fact forget). Invalidates the model-bound
   *  state so a retired crafted tool disappears from the next turn. */
  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    const result = await revertChangelogEntryById({ rt: this.rt, facts: this.factsStore, events: this.eventRecorder }, id);

    if (result.ok) this.invalidateModelState();

    return result;
  }

  // ── Alternate Takes (parity with the DO's RPCs) ───────────────────

  /** The newest take set, picked or not — the surfaces' comparison source. */
  latestAlternateTakes(): AlternateTakeSet | null {
    return latestAlternateTakeSet(this.rt.storage.sql, this.rt.actor);
  }

  /** Record the user's pick (the explicit preference signal) and, when the
   *  pick differs from the answered take, queue a gentle programmatic turn
   *  asking the agent to continue with the chosen approach. */
  async pickAlternateTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    return pickAlternateTake(
      { sql: this.rt.storage.sql, actor: this.rt.actor, engine: this.engine, inbox: this.actorSession.orchestrator.inbox },
      takeId, nodeId);
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

  broadcast<Event extends BroadcastEvent>(event: Event): void {
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

  /** The codemode namespaces a head's eval gets beyond its runtime's
   *  own executors: `web.*`. Pointedly NOT `agents.*`/`agent.*` — a head forks
   *  its parent's resources, never its authority to delegate. */
  private headCodemodeExtras(): CodemodeProvider[] {
    return [createWebCodemodeProvider(this.getWebSearchProvider())];
  }

  /** The drain-debounce timer (BackendHost seam) — a plain one-shot timeout.
   *  Skips a window that outlives the session so consumed events are never
   *  bound to a turn a dead pump will not run. */
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

  /** Inject a programmatic turn into the same serialized loop the user drives —
   *  backs the reactor + background-job wake. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    return this.chat.enqueueTurn(input);
  }

  /** BackendHost seam — will there be a next step for a message to land on? */
  turnInFlight(): boolean {
    return this.chat.turnInFlight();
  }

  // ── Public driver API ──────────────────────────────────────────────

  /** Send the user's message — the one entry, whatever the session is doing. */
  send(
    input: string | { text: string; files: ReadonlyArray<PromptFile> },
    opts: { tier?: TierId } = {},
  ): Promise<SendLanding> {
    return this.chat.send(input, opts);
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
    if (!this.chat.pumping) return false;
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

  /** Abort the in-flight turn (Ctrl+C / Esc). The dropped steers' texts are
   *  returned so the surface can hand them back to the user. */
  interrupt(): string[] {
    return this.chat.interrupt();
  }

  /** Fold the history at this point: the next turn's context transform runs
   *  with `force`, so the ladder rebuilds now instead of waiting for the
   *  measured token trigger. One-shot — `takeForceCompaction` consumes the
   *  flag, so this can never loop. The session owns its compaction key, so a
   *  caller marking a phase boundary never has to reconstruct it. */
  armForcedCompaction(): void {
    this.compactionState.armForceCompaction(this.cacheIdentity().sessionKey);
  }

  /**
   * The session's own lifetime, aborted by {@link end}. MCP startup awaits a
   * third-party child that may never answer, so the owner ending the session is
   * what ends that wait: without this, `end()` would be reached only after a
   * connect that never returns.
   */
  private readonly lifetime = new AbortController();

  /** Connect configured stdio MCP servers + merge their tools into the surface.
   *  Call once at startup (no-op for empty config). Idempotent-safe to skip. */
  async connectMcp(servers: Record<string, McpServerConfig>): Promise<void> {
    if (!servers || Object.keys(servers).length === 0) return;

    const log = (message: string): void => {
      this.emit({ type: 'background', event: 'mcp', message });
    };

    const conn = await connectMcpServers(servers, log, this.lifetime.signal);

    // ONE admission, through the same policy the cloud backend's turn applies:
    // the session's resolved figures, less the native surface this session
    // already carries. The install is session-scoped — merged once, ridden by
    // every turn — so the native figure is the session's full surface rather
    // than one turn's filtered subset. A turn that narrows its tools keeps
    // MORE room, never less.
    const admission = admitMcpDescriptors(conn.descriptors, {
      contextWindow: this.sessionContextWindow(),
      modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      nativeToolTokens: toolSurfaceTokens(this.tools),
    });

    // ONE builder, both backends: the admitted descriptors arrive already
    // claimed — every tool without a readOnly annotation goes behind the same
    // durable claim the natives run under, keyed by the same turn deps this
    // session's toolsets claim with. KINU-019: adapters merged unwrapped let
    // an MCP effect start unclaimed and replay after a reset.
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
    this.mcpClose = conn.close;
    // A server that never came up is stated in the turn's live context, not
    // only in a diagnostic the model never sees. Its tools are simply ABSENT
    // otherwise, so the model plans as if a capability the user configured
    // does not exist and cannot explain why. A deferred server joins that
    // list: the admission's reason carries the budget arithmetic, so the
    // absence names what did not fit and out of what.
    this.mcpUnavailable = [
      ...conn.diagnostics
        .filter((d) => d.status === 'failed')
        .map((d) => ({
          source: `MCP server "${d.server}"`,
          reason: d.reason ?? 'failed to start — its tools are absent from this turn',
        })),
      ...admission.deferred.map((d) => ({
        source: `MCP server "${d.server}"`,
        reason: d.reason,
      })),
    ];

    for (const d of admission.deferred) {
      log(`mcp: ${d.server} deferred: ${d.reason}`);
    }
  }

  /** Configured MCP servers whose tools are not on this session's surface. */
  private mcpUnavailable: MissingCapability[] = [];

  /** Run any pending event drain to completion NOW, bypassing the debounce
   *  window — the scheduler daemon's batch tick calls this before end(). */
  flushPendingDrains(): Promise<void> {
    return this.chat.flushPendingDrains();
  }

  /** Re-pend the event deliveries a dead process left leased. Call once at
   *  startup, before the recovery drain. */
  reclaimStrandedEventDeliveries(): void {
    this.chat.reclaimStrandedEventDeliveries();
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
    if (this.chat.closed) return;
    await this.actorSession.orchestrator.runDueSessionEvolution();
  }

  /** End the session: let the evolution this run started finish, then let any
   *  detached background fiber settle, then disconnect MCP. Both windows are
   *  durable, so whatever does not finish carries over to the next run rather
   *  than being force-closed here. */
  async end(): Promise<void> {
    this.chat.close();
    this.lifetime.abort();
    this.clearLocalAlarm();
    // The live wake dies with the process either way; clearing it here is what
    // stops a timer firing a replay into a session that has closed its stores.
    this.clearTerminalRetry();
    const t0 = Date.now();
    await this.actorSession.orchestrator.settleEvolution();
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
  /**
   * Hold one settlement in the join set until it settles.
   *
   * The promise has to be IN the set before anything can await it and OUT of it
   * once it settles, which is a self-reference. Both call sites spelled that as
   * a `let … : Promise | null = null` the body's own `finally` then re-checked
   * for null — a state neither could ever be in, since the body reaches that
   * `finally` only past an `await` and the assignment happens before the first
   * one resolves. One mechanism, no null state, and a joiner still wakes AFTER
   * the entry is gone, which is what terminates `joinBackgroundFibers`.
   */
  private tracked(settle: () => Promise<void>): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.backgroundFibers.add(promise);

    // BOTH outcomes prune, and the entry resolves only after it is gone — which
    // is what lets `joinBackgroundFibers` re-read the size and terminate. A
    // settlement observer that rejected would otherwise leave a set entry
    // nothing ever removes, so the rejection path is named rather than voided.
    const prune = (): void => {
      this.backgroundFibers.delete(promise);
      resolve();
    };

    settle().then(prune, prune);
  }

  private trackFiber<T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> {
    const running = this.rt.schedule.fiber(name, fn);
    // Tracked as a SETTLEMENT rather than as an outcome: joinBackgroundFibers
    // awaits this set with allSettled, and the work's result belongs to the
    // caller holding `running`. What reaches here instead is a fiber that could
    // not even record its own outcome — a stash or row-delete against a
    // database closed under it at teardown — which has no other reader, so it
    // is stated rather than dropped as an unhandled rejection.
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
      type: 'background', event: 'bg_jobs_settling',
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
    const interrupted = this.jobs.listRunning().items;

    const roster = interrupted
      .map((job) => `${job.id} (${job.kind}${job.label ? `: ${job.label}` : ''})`)
      .join(', ');

    const message =
      `${this.backgroundFibers.size} background job(s) did not finish in time and were interrupted by this ` +
      'exit. They are checkpointed, so this workspace resumes them the next time it starts — including ' +
      'unattended, under the local scheduler daemon — and a resumed job runs commands and writes files on ' +
      `this machine. Cancel with: kinu jobs ${this.agentName()} cancel <id>.` +
      (roster ? ` Interrupted: ${roster}.` : '');

    this.emit({ type: 'background', event: 'bg_jobs_abandoned', message });
    diagnostics.failure('jobs.abandoned_at_exit', new KinuError('timeout', message), {
      jobs: interrupted.length,
    });
  }

  /**
   * Recover the work a previous CLI exit interrupted: the fork journal and the
   * background-job registry, in ONE pass rather than two.
   *
   * Sequential passes make the ORDER the defect. `head_journal.status =
   * 'running'` means "spawned, no report recorded", nothing carries a head across
   * a process exit, and left alone that row feeds "N of M heads running" into every
   * model step forever — so the journal has to be reconciled. But retiring a run is
   * not the same act as correcting that claim, and doing both first tells a search
   * whose durable job is still re-drivable, in the agent's own conversation, that
   * nothing is left to run it. `reconcileInterruptedForks` marks the stale rows
   * non-terminally, hands their roots to the job sweep, and retires only the runs
   * that sweep refused.
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
   * The ADVISOR lane's orphan is the one row this pass reads and does not drive.
   * Re-driving it is a model call, so it is handed to the leased sweep below and
   * its row is left alone until one process actually runs it.
   *
   * Then the turn reviews a previous one-shot process deferred. Same reason as the
   * jobs: `kinu exec` exits before the outcome review it owes, so the review is a
   * durable row and this is the next host that can afford it (core's
   * AgentOrchestrator.runDeferredTurnReviews — a one-shot session declines it
   * there, so the cost never lands back on an exec invocation). Bounded per open,
   * so a backlog is not this session's first turn's latency.
   *
   * LAST, the terminal suffix a previous turn was interrupted inside. This is
   * the whole of the CLI's terminal recovery — a laptop has no alarm, so the
   * next start IS the wake — and it runs last because replaying an owed suffix
   * can enqueue turns and drain events, and both read state the two sweeps
   * above have just corrected. It runs UNDER THE DRIVER LEASE, for the reason
   * {@link recoverTerminalTransitions} states.
   *
   * Call once at startup: no fibers are live yet, so every row is an orphan.
   *
   * Nothing here is optional. A step that absorbed its own failure would leave a
   * workspace whose fiber rows could not be read recovering NOTHING and then looking
   * exactly like one that had no interrupted work — while the notice the previous
   * exit printed promised the operator these jobs would resume.
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
      verified: recovered.verified.length, refused: recovered.refused.length,
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

    await this.recoverTerminalTransitions(advisorOrphans);
  }

  /**
   * Finish every terminal sequence this workspace still owes — under the DRIVER
   * LEASE, because the alternative is two processes running one turn's effects.
   *
   * The in-flight guard core keeps is process-local, so an interactive session
   * opening a workspace a daemon is already settling reads the same pending rows
   * and would invoke the same advisor review, completion gate and title call
   * beside it. Nothing on the row tells them apart: both see `pending` and
   * neither has yet advanced the other's `next_attempt_at`.
   *
   * So the lease is ACQUIRED, through the same gate every other converting
   * boundary asks — the drain, the pump, the host's pass. A session with no gate
   * installed is a session nobody else can be driving (a fixture, a benchmark
   * harness), and it recovers unguarded.
   *
   * First the advisor orphans the startup scan set
   * aside: a review is a model call, and two processes that both read the same
   * orphan and both see no note yet would each spend one and append their own.
   * Then the terminal ledger: the roster committed beside each answer.
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
    // A replayed sequence can enqueue a turn (the completion gate does), and on
    // this path no turn owns the pump. What it must NOT do is decide the advisor's
    // verdict by arriving early — and it cannot: the gate state the
    // review is judged against travels in the improvement-lanes row rather than
    // being re-read from a RAM gate this process never armed.
    this.chat.pump();
  }

  /**
   * The advisor review a previous exit interrupted, re-driven from the snapshot
   * that lane stashed — the same arm the Durable Object's fiber recovery runs.
   *
   * Without it this orphan was DELETED beside every other non-`bg:` fiber row,
   * so a process killed during the review lost it while its terminal row already
   * read `completed` and could never replay it.
   *
   * IDEMPOTENT ON THE NOTE rather than on the attempt. A lane is interrupted on
   * one side or the other of its one durable write: before `recordAdvisorNote`,
   * where nothing landed and the review is owed, or after it, where the review
   * finished and only the fiber row's release was lost. The note row is the only
   * evidence of which, so it is what decides.
   */
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
    // The gate verdict comes off the CHECKPOINT. Its armed state is RAM this
    // process does not have, and re-deriving it as closed said a note the turn
    // had earned the right to keep in the changelog.
    await this.runAdvisorReview(parsed.output);
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
      const surface = this.toolSets[resumeMode];

      if (!surface) throw new Error(`tool surface for ${resumeMode} mode is unavailable`);

      return surface.raw;
    }, kind, decodeJsonValue({ value: input.value }), mode, signal).then((value) =>
      value === undefined ? undefined : decodeJsonValue({ value }));
  }

  // ── Internals ──────────────────────────────────────────────────────

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
      if (this.chat.pumpPromise) { await this.chat.pumpPromise; continue; }

      if (this.backgroundFibers.size === 0) return;

      if (!await this.joinBackgroundFibers(deadline)) return;
    }
  }

  /** Append to the durable run-event log. Scoped to the in-flight run by
   *  default (`runId` omitted); a caller with its OWN run id passes it
   *  explicitly so the row lands on that run once the calling turn has moved
   *  on. Never throws: losing a history row must not fail a turn. */
  private recordRunEvent(input: RunEventInput, runId?: string | null): void {
    const id = runId !== undefined ? runId : this.chat.currentRunId;

    if (!id) return;

    try { this.eventRecorder.emit(id, input); }
    catch (err) {
      diagnostics.failure(
        'event.run_row_write_failed',
        toKinuError({ doing: 'appending a row to the durable run-event log', cause: err, otherwise: 'io' }),
      );
    }
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

  /** A hired-for-context turn opens on an empty history but names the turn
   *  whose conversation it inherits (`metadata.drainTurnId`): seed those rows
   *  before the live prompt so the child reads its parent context in place. */
  /** A delegated turn opens on the actor's working revision through the shared
   *  rule; a root turn appends its input as before. */
  private openTurnInput(item: ChatTurnInput, lease: ActorTurnLease, message: ModelMessage): void {
    const drainTurn = v.safeParse(v.string(), item.metadata?.drainTurnId);

    if (drainTurn.success) {
      this.actorSession.openDelegatedTurn(lease, {
        messages: [message],
        birthContext: subordinateTurnContext(this.eventLog, drainTurn.output).map(inheritedAsModelMessage),
      });
    } else {
      this.actorSession.appendInput(lease, message);
    }

    // A re-opened turn's prior output follows its input: the model continues
    // its own answer rather than starting one.
    if (item.priorOutput !== undefined) this.actorSession.appendPriorOutput(lease, item.priorOutput);
  }

  /**
   * Assemble one admitted turn — the ChatSession's `prepareTurn` port.
   *
   * Everything here is this backend's composition of the turn: the profile
   * from the local authority, the skills and MCP tools on this surface, the
   * AGENTS.md chain under this directory, the prompt, the cache identity and
   * the model the local resolver bound. The loop that runs it is core's.
   */
  private async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease): Promise<PreparedTurn> {
    // Checkpoints name the admitted turn whose file effects they can restore.
    this.rt.checkpoints?.beginTurn({ turnId: lease.turnId, sessionId: this.sessionId });
    // Before anything reads the tool surface: the report gate is a property of
    // THIS turn, and both the profile resolution below and the toolset rebuild
    // after it consult it.
    this.turnIsParentAssigned = item.kind === 'programmatic';
    const profileInputs = await this.profiles().inputs();
    const activeRoleId = this.getActiveRoleId();
    const roleSkills = effectiveRoleCatalog(profileInputs.envelope.catalog)[activeRoleId]?.skills ?? [];

    // A real user message grades the previous turn — dispatch the detached
    // outcome review (same core pipeline as the DO's beforeTurn hook). In a
    // one-shot process the previous turn belongs to an already-exited
    // invocation, so this prompt is a fresh task, not a verdict on it.
    if (item.kind === 'user') this.actorSession.orchestrator.observeUserTurn(item.text, this.turnContinuity);

    if (item.kind === 'user' && this.oneShot) this.chat.completionGate.arm(item.text);
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
    const candidateAgentActions = agentsActionsFor(this.agentsToolDeps(this.actorSession.workMode));

    const profile = resolveAgentTurnProfile({
      ...profileInputs,
      activeRoleId: this.getActiveRoleId(),
      workMode: this.actorSession.workMode,
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
        ...codemodeCapabilitiesFor(this.codemodeProviders(this.actorSession.workMode)),
      ],
      activeSkills: activeSkills?.active.map((skill) => skill.name) ?? [],
      // Most specific first: the tier named on THIS message, then the tier the
      // parent pinned when it hired this agent, then nothing — which lets the
      // resolver take the role's own default. An absent pin must not read as
      // "the workspace default"; the role's tier is what an unpinned hire asked
      // for.
      explicitTier: tierFromMetadata(item.metadata) ?? this.config.getAssignedTier() ?? undefined,
      // The workspace's pinned model overrides the role's tier model inside
      // the resolver. Without it a setModel pin is accepted and never run on.
      workspaceModel: this.config.getModel(),
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

    const filteredExternal = Object.fromEntries(
      Object.entries(this.extraTools).filter(([name]) => toolAllowed(name)),
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

    // Nearest-file-wins AGENTS.md chain, re-statted each turn so edits land
    // immediately (a handful of stat calls — negligible next to the LLM call).
    // Only the files that fit this model's window are read, and each one is
    // classified against the owner's approvals so an unapproved file cannot
    // reach the system prompt.
    const agentsMd = discoverAgentsMd(this.cwd, {
      contextWindow: this.sessionContextWindow(),
      modelOutputLimit: this.modelCatalog.modelOutputLimit(),
    }, this.instructionTrust);

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
      // The temporary rung rides the team transport the host installs, so a
      // session with no roster substrate never advertises it.
      temporaryAsk: this.teamDeps?.temporary !== undefined,
      externalTools,
      backend: 'cli-local',
      roleSection: profile.role,
      model: { id: this.effectiveModelSpec() },
      cwd: this.cwd,
      currentDate: currentDateForPrompt(),
      // Prompt sections the evolution loop promoted. Read here, not inside the
      // builder: the builder is the byte-stable cacheable prefix and does no
      // I/O, exactly as with the soul.
      sectionOverrides: activePromptSectionOverrides(this.rt.storage.sql, this.rt.actor),
      identity: this.promptIdentity(),
    };

    systemPromptOptions.agentsMd = agentsMd;

    if (availableSkills.lines.length > 0) systemPromptOptions.availableSkills = availableSkills;

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

    this.openTurnInput(item, lease, fileParts.length > 0
      ? { role: 'user', content: [...fileParts, { type: 'text' as const, text: item.text }] }
      : { role: 'user', content: item.text });

    // Live state (facts, memory tail, executor status, running background work,
    // the open fork roster) rides the dynamic-context ledger — the shared step
    // pipeline re-reads it at EVERY model step and appends a block only when
    // the render changed, weaving the frozen ones back at their birth index.
    // Turn-local state (activation reasons) rides one trailing message for THIS
    // turn only. Neither is ever pushed into the durable history, so the stable
    // prefix stays cacheable.

    // Provenance rides here, not in the system prompt: it flips whenever a
    // background job lands mid-session, and at system placement that flip
    // rewrote the whole cacheable prefix twice — once into the wake and once
    // back out (prompting/volatile-context.ts).
    const turnLocal: Parameters<typeof turnLocalContextMessage>[0] = {
      provenance: turnProvenanceForMetadata(item.metadata),
    };

    if (activeSkills) turnLocal.activeSkills = activeSkills;
    const turnLocalMsg = turnLocalContextMessage(turnLocal);

    // Instruction bytes no owner approved ride that same turn-local tail rather
    // than the system prompt: sealed, labelled reference material the model may
    // read but cannot be commanded by. Placed BEFORE the turn-local message so
    // activation reasons stay the last thing the model sees. Null when every
    // discovered file is approved, in which case nothing is appended.
    const unverifiedMsg = unverifiedInstructionsMessage(
      activeSkills ? { agentsMd, activeSkills } : { agentsMd },
    );

    const turnLocalMsgs = [unverifiedMsg, turnLocalMsg]
      .filter((msg): msg is ModelMessage => msg !== null);

    const cache = this.cacheIdentity();

    // The NORMALIZED spelling, as cf parses it: a tier the account catalog
    // names by a bare id has no slash, and `parseModelSpec` refuses it before
    // the request leaves — a turn failed for a spelling, not a model.
    const providerOptions = reasoningEffortOptions(
      profile.tier.reasoningEffort,
      parseModelSpec(this.effectiveModelSpec()).provider,
    );

    // The measured compaction trigger, read from the durable state by core in
    // the one correct order (orchestrator/turn-context.ts). `historyLength` is
    // the durable length the measurement is bound to, so it is also what
    // persistMeasuredPromptTokens writes against at turn end.
    const historyLength = this.actorSession.history.length;
    const measured = measureCompactionTrigger(this.compactionState, cache.sessionKey, historyLength);
    // Resolved once for the whole turn so compaction, the step-prune budget,
    // and overflow recovery all budget against the same number.
    const contextWindow = this.sessionContextWindow();

    const liveTurn: ActorExecutionInput['chat'] = {
      model,
      // The window pair, both halves of it: `contextWindow` is the whole
      // window and `modelOutputLimit` the answer's share, and the input
      // allocation every producer divides (`stepContextLimit`) is what the two
      // produce. Omitting the second read the whole window as the answer's
      // allowance, which halved the allocation this turn's admission and its
      // step pruning both budget against.
      modelContext: {
        id: this.effectiveModelSpec(),
        contextWindow,
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      },
      system: systemPrompt,
      // Model-capability attachment sanitization — runChat applies it to
      // the whole history BEFORE the transform seam and the ledger weave
      // (same ordering as the DO's beforeTurn); this.history itself is
      // never mutated.
      attachments: {
        accepts: this.sessionAcceptedMedia(), vfs: this.rt.storage.vfs, budget: this.actorSession.orchestrator.acc.context,
      },
      turnLocal: turnLocalMsgs.length > 0 ? turnLocalMsgs : undefined,
      tools: turnTools,
      transformTrigger: measured.trigger,
      cache,
      budget: this.budget,
      // The turn's own calls' lifecycle rows: a `model_operation` pair per
      // provider call, so a call that never returned names itself in the
      // durable log (the run was mid-request, not mid-step).
      operations: this.modelOperations,
    };

    if (measured.providerReportedTokens !== undefined) {
      liveTurn.providerReportedTokens = measured.providerReportedTokens;
    }

    if (providerOptions) liveTurn.providerOptions = providerOptions;
    // Exact pre-submission admission — the resolved provider's own count of the
    // assembled request (core `assembleTurnMessages` owns what is done with the
    // number). A static-model session has no
    // registry to ask, and is assembled ungated exactly as before.
    const resolver = this.modelResolver;

    if (resolver) {
      liveTurn.countInputTokens = (request: CountableRequest) =>
        resolver.countInputTokens(this.effectiveModelSpec(), request);
    }

    return {
      execution: {
        loopVersion: await this.rt.identity.scaffold.version(),
        chat: liveTurn,
        extensions: [this.compactionExtension],
        dynamic: (profile, tools) => this.dynamicContextSnapshot(memoryTail, profile, tools),
        scaffoldSpend: { source: 'scaffold', report: this.modelCallSink, operations: this.modelOperations },
      },
      sessionKey: cache.sessionKey,
      contextWindow,
      historyLength,
    };
  }

  // ── The terminal transition ───────────────────────────────────────────
  //
  // One settled response ends once, and everything it causes hangs off that
  // moment: the alternate-takes claim, the branch settlements, the completion
  // gate, the evolution recording, the reactor drain, the advisor lane, the
  // shadow trial and the auto title. Run as straight-line code with the turn
  // claims released as soon as the transcript is on disk, a laptop killed
  // anywhere inside that sequence loses the whole suffix with nothing to say
  // what had already happened.
  //
  // Core owns all of it — the vocabulary, the roster, the state machine, the
  // per-effect ledger and the replay. What follows is the only two things this
  // backend genuinely owns: the effect BODIES, and the WAKE.

  /**
   * What this turn owes, as core's own roster reads it.
   *
   * Every argument here is a VALUE this session read; not one of them is a
   * decision it makes. Which effects those values produce, in what order, on
   * which lane, keyed on what, and behind which gate is
   * `declareTerminalRoster` — so the CLI cannot answer "does a Plan turn feed
   * the improvement lanes?" differently from the Durable Object, which is
   * exactly how two backends drift when each spells its own sequence out.
   */
  private owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[] {
    const mission = localActorMission(this.rt, makeSqlExec(this.db));
    // WHICH candidate this turn is sampled against, decided ONCE, here. The
    // plan re-reads the pending version on every call, so a replay that asked
    // again would score this turn against a candidate that was not under trial
    // when it ran. A turn the plan declines owes no row.
    //
    // Asked only on a session whose evolution lanes are ON. `--no-auto-evolve`
    // records no evolution state and spends no evolution compute, so this
    // session genuinely does not have the lane — and an effect a backend does
    // not have is an absent part, not a claimed row that completes on the
    // engine's refusal a moment later.
    const sampled = this.engine.recordsTurns ? shadowTrialPlan(this.scaffoldControl, input.messageId) : null;

    // The gate's decision belongs to the LIVE turn: `shouldGate` reads RAM the
    // gate keeps (armed, already fired) that a restart does not have, so the
    // answer travels as the row's existence rather than being asked again on
    // replay. Plan turns are not gated — a plan produces no state to check.
    const gated = this.rt.shell !== undefined
      && this.actorSession.workMode !== 'plan'
      && this.chat.completionGate.shouldGate({
        completed: input.completed, toolCalls: this.actorSession.orchestrator.acc.toolCalls.length,
      });

    const scoped = this.actorSession.orchestrator.scopedTurn(input.turn);

    // Every input the review's verdict reads, taken while the turn is still in
    // memory. Recorded rather than re-read on replay: the tool surface is
    // rebuilt per turn, the dedupe window moves with every later note, and the
    // severity floor is a config the owner can change between the turn and its
    // recovery, so a replay that re-derived them would grade this turn against
    // inputs it never had.
    const advisor = this.actorSession.advisorSnapshot(scoped, input.reachableTools);

    // WHICH report this ending owes the parent, decided once, here. A task
    // child's terminal answer and a durable child's progress note are different
    // reports for different reasons, and both are the host's decision because
    // only it knows this child's lifetime and whether the parent drove the turn.
    const ending: TaskTurnEnding = input.completed
      ? 'answered'
      : input.interrupted ? 'interrupted' : 'errored';

    const relay = this.parentRelay;
    const parentReport = relay?.owed(ending, input.assistantText) ?? null;

    const facts: Parameters<typeof declareTerminalRoster>[0] = {
      messageId: input.messageId,
      status: input.status,
      workMode: this.actorSession.workMode,
      continuity: this.turnContinuity,
      completed: input.completed,
      userText: input.userText,
      assistantText: input.assistantText,
      // SCOPED once, so the mission labels the turn ran under travel with both
      // the recording and the review. A cold replay has no active governor
      // scope, and a review that lost the labels is neither attributed nor
      // debited.
      scopedTurn: projectJsonValue({ value: scoped }),
      recordedAt: Date.now(),
      // The gate as it was for THIS session, frozen beside the turn. A stable
      // constructor field, so the roster and the turn cannot disagree — and a
      // replay records what the producing run had rather than what the
      // recovering one happens to be started with.
      evolutionEnabled: this.engine.recordsTurns,
    };

    const parts: Writable<TerminalTurnParts> = {};
    parts.takes = {
      credited: input.credited,
      startedAt: input.startedAt,
      // The takes this turn competed against, read HERE. A retry that
      // re-selected "whatever is unclaimed now" would claim — or purge — a
      // later turn's captures.
      takeIds: unclaimedAlternateTakeIds(this.rt.storage.sql, this.rt.actor),
    };
    parts.branches = this.pendingBranches.map(({ id, task }) => ({ id, task }));

    if (input.overflowRetry) parts.overflowRetry = true;

    if (gated) parts.completionGate = { text: this.chat.completionGate.task };
    // EVERY input the review's verdict reads, recorded — not just the tool
    // surface. The severity floor, the dedupe window and the completion gate
    // were re-read from the live session when the row replayed, so a process
    // death could turn a note that was novel at turn end into a duplicate, or
    // deliver one that the open gate had held back (the gate's armed state is
    // RAM, and a fresh process always reads it closed). The Durable Object
    // already records the whole snapshot; this is the same one.
    parts.advisor = projectJsonValue({
      value: {
        ...advisor,
        // Whether the gate will be WAITING when the advisor speaks, not
        // whether it is waiting now: the row that fires it runs earlier in
        // this same sequence, so `gated` is the answer for this turn and the
        // live `open` is the answer for a gate some earlier turn opened.
        gateOpen: gated || this.chat.completionGate.open,
      },
    });

    if (sampled !== null) {
      parts.shadowTrial = {
        pendingVersion: sampled,
        // BOUNDED here rather than at the insert: a million-token turn
        // recorded whole exceeds a SQLite row, and failing the insert partway
        // through a claimed sequence leaves a prefix recovery reads as the
        // whole roster.
        trialContext: projectJsonValue({ value: trimTrialContext([...input.trialContext]) }),
      };
    }

    parts.autoTitle = { subject: isPlaceholderMission(mission) ? input.userText : mission ?? '' };

    // The answer this child owes its parent — ONE claimed effect, covering a
    // task child's errored and interrupted endings too. An untracked
    // fire-and-forget promise started off the `turn-end` event instead leaves a
    // process that dies before the parent's ingress admits it with nothing
    // recording that a retry was owed. The sequence id is the parent's dedupe
    // key, so a replay is recognised as the report it already holds.
    if (parentReport !== null && relay !== null) {
      parts.parentReport = {
        text: parentReport.content,
        status: parentReport.status,
        sequenceId: relay.sequenceId(input.messageId),
      };
    }

    // NO `turnEndExtensions`. This backend's `runChat` fires the extension
    // turn-end inside the turn stream, including for a cut turn, and its
    // ExtensionHost is built per turn and dies with it — so there is nothing
    // left owed, and a row would either announce the turn twice or block the
    // close forever.
    //
    // NO `eventReplies`. A local session has no transport in front of its
    // reply channels, so what a delivery owes is the durable answer and the
    // closing of its recovery lease — and this backend already recovers an
    // interrupted one at startup, through `reclaimStrandedEventDeliveries`
    // under the single-driver lease with zero grace. An owed row here would
    // be a second answer to that question, racing the first.
    //
    // NO `craftedToolsUsed`, `sleepTime` or `autoGepa`: this backend runs none
    // of those lanes. Absent parts, not empty bodies.
    return declareTerminalRoster(facts, parts);
  }

  /**
   * The bodies of this backend's terminal effects.
   *
   * EVERY ONE OF THEM IS REPLAYABLE, and that is a property each body earns at
   * its own boundary rather than one the ledger can grant: a keyed take set, a
   * branch settlement keyed on the branch id, an evolution append keyed on the
   * assistant message, a drain that selects only unbound rows, a trial queued
   * under a stable id, a title that stamps `name_origin`.
   */
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
        // The harness takes its own look before letting the run be over: it
        // reads the working directory through the agent's OWN shell, after the
        // agent stopped, and hands that back as one more turn.
        //
        // The observation is taken WHEN THE EFFECT RUNS rather than recorded at
        // declaration, because what the gate asks about is the final state and a
        // replay's question is still "is it right now". `shouldGate` is not
        // re-asked: it reads RAM a restart does not have, and the row's
        // existence IS that decision, already made.
        //
        // THE ROW STAYS OWED UNTIL THE CONFIRMING TURN IS ON DISK. Pushing a
        // QueueItem is a RAM act: reporting `completed` over it lets the ledger
        // prune the row, and a process that dies before the pump reaches that
        // item loses the confirmation permanently with nothing left saying it
        // was owed. The queue item carries a key derived from this sequence, so
        // the turn's own durable row is both the admission record and the thing
        // that stops a replay queueing a second confirmation.
        run: async ({ text }, scope) => {
          const identity = `${COMPLETION_GATE_EVENT}:${scope}`;

          // The confirming turn's OWN durable row, whose id `processTurn` derives
          // from the key this effect queues it under. Its presence is the
          // admission this row waits for.
          if (this.chat.announcementOnDisk(identity)) {
            return { status: 'completed', detail: 'the confirming turn is on disk' };
          }

          // QUEUED OR RUNNING is not "not queued yet". A retry falling due while
          // the first confirming turn is still in the model finds no message row
          // and its queue item is already shifted out, so an unchecked enqueue
          // appends a second turn under the same key and the model and tool work
          // is done twice.
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

          // Nothing observable means no evidence to show, and a gate with no
          // evidence is just "are you sure?" — the doctrine-shaped ask this
          // replaces.
          if (observed === null) {
            return { status: 'completed', detail: 'the working directory showed nothing to check' };
          }

          this.chat.completionGate.fire();
          // This sequence's own name for the confirmation. `processTurn`
          // derives the durable message id from it, so a replay that reaches
          // here before the turn ran queues the same turn rather than a second
          // randomly-identified one. Arriving early cannot change the
          // advisor's verdict — the gate state the review is judged against is
          // recorded on the improvement-lanes row.
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
      overflow_retry: terminalEffect({
        input: v.object({}),
        run: (_input, scope) => {
          const effectScope = keyedScope(scope);

          const identity = effectScope === undefined
            ? `overflow-retry:${crypto.randomUUID()}`
            : `overflow-retry:${effectScope}`;

          if (this.chat.announcementOnDisk(identity)) {
            return { status: 'completed', detail: 'the retry turn is on disk' };
          }

          if (!this.chat.announcementInFlight(identity)) {
            this.chat.appendOwedTurn({ text: OVERFLOW_RETRY_TEXT, idempotencyKey: identity, event: OVERFLOW_RETRY_EVENT });
          }

          return { status: 'owed', detail: 'the retry turn is queued and not yet on disk' };
        },
      }),


      turn_record: turnRecordTerminalEffect(this.actorSession.orchestrator),
      event_drain: eventDrainTerminalEffect(this.actorSession.orchestrator),

      improvement_lanes: terminalEffect({
        input: v.object({
          status: RunEndReasonSchema, turn: JsonValueSchema, workMode: WorkModeSchema,
          advisor: RecordedAdvisorSchema,
        }),
        // The verdict is core's one derivation, asked with the RECORDED mode so
        // a fresh session's default cannot open a lane the turn never earned.
        //
        // AWAITED TO ITS CHECKPOINT, not to its finish. Starting the lane and
        // completing this row in the same breath loses the review: before the
        // checkpoint nothing about the lane is on disk, so a process killed
        // inside the model call leaves a completed row with no snapshot for
        // `recoverAdvisorLane` to re-drive. (Startup preserves the advisor
        // orphan for recovery under the driver lease; the snapshot is what it
        // re-drives.) Resolving at the checkpoint is what makes "the lane is
        // recoverable" and "the row is done" the same fact; the review itself
        // still runs off the queue.
        run: async ({ status, workMode, advisor }) => {
          if (!this.actorSession.orchestrator.improvementLanesOpen(status, workMode)) {
            return { status: 'completed', detail: 'improvement lanes closed for this turn' };
          }

          await this.reviewTurnInBackground(advisor);

          return { status: 'completed' };
        },
      }),

      shadow_trial: shadowTrialTerminalEffect(this.engine),

      auto_title: terminalEffect({
        input: v.object({ subject: v.string() }),
        // Once-only at its own boundary: persisting an auto title stamps
        // `name_origin`, after which the plan can no longer match. AWAITED
        // rather than detached into a fiber of its own — this row is on the
        // detached lane already, and the close that joins it is what keeps a
        // one-shot process from exiting through the model call.
        run: async ({ subject }) => {
          await this.applyAutoTitle(subject);

          return { status: 'completed' };
        },
      }),
    };

    // Only a SUBORDINATE owes one, so on a root it is an absent part rather
    // than a body that returns success over a parent nobody has.
    //
    // Replayable because the parent's ingress admits by DEDUPE KEY rather than
    // by arrival: the recorded `sequenceId` names this one report, so a
    // re-drive of the same answer is recognised as the report the parent
    // already holds instead of reading as a second piece of progress. The mode
    // comes off the row for the same reason it does on the cloud facet — a
    // cold replay must not turn a Plan report into a Build one.
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

  /** The once-only lifecycle this session's settled responses run through.
   *  Lazy because the effect bodies close over stores the constructor is still
   *  assembling when the field would otherwise be initialised. */
  private get terminal(): TerminalTransitions {
    if (!this.terminalTransitions) {
      this.terminalTransitions = new TerminalTransitions({
        sql: this.rt.storage.sql,
        actor: this.rt.actor,
        effects: this.terminalEffectTable(),
        now: () => Date.now() + this.terminalClockSkewMs,
        fault: () => this.terminalEffectFault,
        // A REAL transaction. `rt.storage.sql` is this same connection, so the
        // claim and every roster row commit or roll back together — which is
        // what makes an interrupted sequence a suffix rather than a prefix
        // recovery would read as the whole roster.
        transaction: <T,>(body: () => T): T => this.db.transaction(body)(),
        // A re-announced programmatic turn keeps its durable id, so two
        // responses can share one `turnId`: the second is executing tools while
        // the first's detached close counts open terminal claims and finds none
        // for it. Without this the close deleted the live claim and the next
        // interruption replayed an external tool with no guard.
        turnIsLive: (turnId) => this.chat.pumping && this.chat.currentTurnId === turnId,
        scheduleRetry: (atMs) => this.scheduleTerminalRetry(atMs),
      });
    }

    return this.terminalTransitions;
  }

  /**
   * The wake for an owed effect: the next start, AND a timer inside this process.
   *
   * The next start is the durable half, and it is the only half a laptop can
   * promise — `recoverTerminalTransitions()` sweeps every owed sequence before
   * this workspace takes new work, and the local scheduler daemon opens the
   * workspace unattended, so an idle machine converges.
   *
   * But a failed attempt buys at least five seconds, and the common case is a
   * process that stays open: an interactive chat or a daemon. Startup had already
   * happened by then, later turns do not sweep old transitions, and the owed row
   * simply sat there for as long as the session lived. So the timer is the LIVE
   * half, and it is not a substitute for the durable one — it is unref'd on
   * purpose, because a process exiting through an owed row must exit and let the
   * next start carry it rather than be held open by its own retry.
   *
   * Collapsed onto the earliest instant asked for: core arms once per sequence
   * per pass, and one timer for the whole ledger is what `nextRetryAt` already
   * describes.
   */
  private async scheduleTerminalRetry(atMs: number): Promise<void> {
    if (this.chat.closed || this.terminalRetryAt <= atMs) return;
    this.clearTerminalRetry();
    this.terminalRetryAt = atMs;

    const timer = setTimeout(async () => {
      this.clearTerminalRetry();

      // The job sweep FIRST, and in its own try: this timer is also the wake a
      // deferred background job arms, and `recoverTerminalTransitions` does not
      // reach `recoverOrphans` — the only path that does is
      // `recoverBackgroundJobs`, which runs once at startup. Without this a job
      // waiting out its backoff inside a live session would sleep until the next
      // process start. Its own catch, because "the job sweep failed" and "an
      // owed effect failed" are different facts and one must not hide the other.
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

    // UNREF'D: an owed row must not hold a finished process open. The next start
    // is the durable carrier; this timer only shortens the wait for a process
    // that happens to still be here.
    timer.unref();
    this.terminalRetryTimer = timer;
  }

  private clearTerminalRetry(): void {
    if (this.terminalRetryTimer) clearTimeout(this.terminalRetryTimer);
    this.terminalRetryTimer = null;
    this.terminalRetryAt = Infinity;
  }

  /** The live wake, and the instant it is armed for. One timer for the whole
   *  ledger — see {@link scheduleTerminalRetry}. */
  private terminalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalRetryAt = Infinity;

  /**
   * A deterministic cut point in the terminal sequence. Null in production.
   *
   * Exactly-once across an interruption is a claim about WHERE the interruption
   * landed, and the only way to test a claim about a specific instant is to
   * create that instant. A test arms this, drives one turn, and then opens a
   * second session over the same database.
   */
  protected terminalEffectFault: TerminalEffectFault | null = null;

  /**
   * How far ahead of the wall clock the ledger reads. Zero in production.
   *
   * A failed attempt buys a wait before the next one, so a recovery driven
   * milliseconds after the interruption finds every owed row not yet due — which
   * is right in production and useless in a test, where the whole point is to
   * observe what the replay does. A test moves the ledger's clock past the
   * backoff instead of sleeping through it.
   */
  protected terminalClockSkewMs = 0;

  /**
   * Keep this PROCESS alive for a terminal close.
   *
   * Core decides when the transition may close; a backend decides what stays
   * alive until it does. The Durable Object runs the close on a durable fiber
   * that holds its isolate; the CLI's equivalent is the tracked-fiber set that
   * `end()` and `settleBackgroundWork()` join before the database is closed —
   * so a process cannot exit through a detached tail that is still reporting.
   */
  private holdTerminalClose(transition: TerminalTransition, close: () => Promise<void>): void {
    const closing = this.trackFiber('turn.terminal_close', async () => { await close(); });
    this.tracked(async () => {
      try {
        await closing;
      } catch (cause) {
        const failure = toKinuError({
          doing: "recording that a settled turn's effects had all reported",
          cause,
          otherwise: 'io',
        });

        // RELEASED. A sequence this process still holds is one every later
        // sweep skips, which is the one way this design wedges. The rows stay
        // owed either way, and the next start is what comes back for them.
        this.terminal.leave(transition);
        diagnostics.failure('turn.terminal_transition_close_failed', failure, {
          turnId: transition.turnId, messageId: transition.messageId,
        });

        // RE-ARMED, exactly as the Durable Object's close does. The close
        // carries the ledger's own final wake, so this rejection can BE that
        // wake failing — and the fiber is about to delete itself. Without this
        // the rows stay owed with nothing left to come back for them until the
        // whole session is restarted.
        try {
          await this.terminal.armRecovery(transition, { cause });
        } catch (recoveryCause) {
          diagnostics.failure(
            'turn.terminal_transition_recovery_failed',
            toKinuError({
              doing: "re-arming a settled turn's effects after their close failed",
              cause: recoveryCause,
              otherwise: 'unavailable',
            }),
            { turnId: transition.turnId, messageId: transition.messageId },
          );
        }
      }
    });
  }

  /**
   * The names this session's prompt introduces it by.
   *
   * A workspace's own chat names the workspace, from the one title store the
   * rename and the auto-title both write. A subagent names itself and the
   * workspace it works in, and the host supplies the second: a child's config
   * holds its own title.
   *
   * The slug reaches neither. It is what this agent is ADDRESSED by — its
   * directory, its `kinu chat` argument — so no name here ever tells a model
   * that a workspace is called `handwrought-walnut-4166c321`.
   */
  private promptIdentity(): PromptIdentity {
    const own = this.config.getDisplayName();

    return this.workspaceTitleSource
      ? { agent: own, workspace: this.workspaceTitleSource() }
      : { workspace: own };
  }

  /**
   * Auto-title this workspace from what it is FOR — the shared core policy
   * (identity/naming.ts), which both the cloud backend and the create path
   * already run. Without it a `kinu chat` workspace keeps its raw slug forever
   * while the same workspace on cloud names itself.
   *
   * The plan is asked for SYNCHRONOUSLY and first. A titled workspace is the
   * steady state, so every later turn would otherwise pay for a model round
   * trip just to be told there is nothing to do.
   *
   * An Error from the optional suggestion is best-effort: the deterministic
   * title already landed by then, so recording it leaves a named workspace and
   * completes the owed row. A non-Error is not that named failure class.
   */
  private async applyAutoTitle(mission: string): Promise<void> {
    const state: WorkspaceTitleState = {
      slug: this.agentName(),
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
      // Only the suggestion is absorbed. The model SDK reports a failed call as
      // an Error; anything else is outside this best-effort class and travels
      // to the owed row instead of pretending to be "no usable title".
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
    const profile = await this.routingProfile();
    const resolution = resolveModelRoute('fast', profile);

    if (!resolution) return null;

    // The prompt pair and parse are core's; only the model is local. This does
    // not catch: `applyAutoTitle` names and records the one best-effort Error
    // class after the deterministic title has landed.
    return suggestWorkspaceTitle(
      (system, prompt) => this.localRouteLlm(resolution, system).complete(prompt),
      mission,
    );
  }

  /**
   * Start the advisor review on its own tracked fiber, and resolve once that
   * fiber has CHECKPOINTED — not once the review is done.
   *
   * The caller is a terminal effect, and what it owes is a RECOVERABLE review
   * rather than a finished one. Before the checkpoint there is nothing on disk
   * about this lane, so a process killed between the effect completing and the
   * fiber's first tick lost the review under a row that could never replay it.
   * After it, `recoverAdvisorLane` re-drives the fiber from its own snapshot.
   *
   * ONE lane per turn, ever STARTED. A terminal replay arriving after the
   * checkpoint but before its row recorded `completed` would otherwise open a
   * second fiber beside the first, and two advisors would review one turn, each
   * spending a model call and appending its own note. The tombstone is written
   * adjacent to the stash, which is exactly when a second lane becomes a
   * duplicate. A turn with no durable id has no replay to guard against and is
   * not given a fabricated key.
   */
  private async reviewTurnInBackground(recorded: RecordedAdvisor): Promise<void> {
    if (this.rt.advisorLlm === undefined || !this.actorSession.advisorEnabled) return;

    if (advisorLaneStarted(this.rt.storage.sql, this.rt.actor, recorded.turn)) return;
    const checkpointed = Promise.withResolvers<void>();

    const review = this.trackFiber(ADVISOR_LANE_FIBER, async (ctx) => {
      // The checkpoint IS what the caller owes, so a lane that cannot write one
      // is a review no interruption can resume and the failure travels to the
      // owed row rather than being absorbed here.
      try {
        ctx.stash(projectJsonValue({ value: recorded }));
      } catch (cause) {
        const failure = toKinuError({
          doing: 'checkpointing the advisor review so an interruption can resume it',
          cause,
          otherwise: 'io',
        });

        diagnostics.failure('advisor.snapshot_failed', failure, {
          turnId: recorded.turn.turnId ?? '(none)',
        });
        checkpointed.reject(failure);
        throw failure;
      }

      markAdvisorLaneStarted(this.rt.storage.sql, this.rt.actor, recorded.turn);
      checkpointed.resolve();
      await this.runAdvisorReview(recorded);
    });

    let observed: Promise<void> | null = null;
    observed = (async () => {
      try {
        await review;
      } catch (cause) {
        // Not `advisor.review_failed`: the review body catches its own failures
        // (`runAdvisorReview` never throws), so what lands here is the LANE —
        // fiber tracking or checkpoint bookkeeping — dying around the review.
        const failure = toKinuError({
          doing: 'tracking the advisor review lane', cause, otherwise: 'unavailable',
        });

        diagnostics.failure('advisor.lane_failed', failure);
        checkpointed.reject(failure);
      } finally {
        if (observed !== null) this.backgroundFibers.delete(observed);
      }
    })();
    this.backgroundFibers.add(observed);
    await checkpointed.promise;
  }

  /**
   * The ONE review body the live lane and its recovery both run.
   *
   * `gateOpen` is the one input this backend has and the cloud one does not. The
   * completion gate is the other harness-authored message at a turn boundary, and
   * it lives on this surface only. While it is waiting for its answer the advisor
   * records its note instead of saying it, so a one-shot run reads exactly one
   * runtime voice per boundary.
   *
   * Governed off the TURN's labels for the same reason the engine's own review
   * is: this runs after the turn ended, and debiting whatever mission happens to
   * be active later would charge work it did not cause.
   *
   * Never throws: a reviewer that failed is a turn with no advice.
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

  /** Passthrough SkillsVfs adapter over rt.storage.vfs (core turn-surface). */
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
      trust: this.instructionTrust,
      limits: {
        contextWindow: this.sessionContextWindow(),
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      },
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
      events: this.eventRecorder,
      sql: this.rt.storage.sql,
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

  /**
   * This session's view for the continual-refinement lane.
   *
   * Four seams it already owns: the scaffold control plane (so a refinement is
   * measured by the same judge as everything else), the one `agent_facts`
   * authority, the temporary-agent port that IS the read-only refiner, and the
   * owner's instruction-trust authority a proposed skill's digest is reported
   * to.
   *
   * `refiner` is absent when this session has no roster substrate — the same
   * structural gate `temporaryAsk` reads for the prompt. A request then stays
   * durable for a host that has one, rather than being refused for a reason
   * that is about the host and not about the request.
   */
  private get refinementDeps(): RefinementDeps {
    return {
      control: this.scaffoldControl,
      facts: this.factsStore,
      approvals: this.instructionApprovals,
      refiner: this.teamDeps?.temporary ?? null,
    };
  }

  /** One step of the refinement lane plus the automatic trigger — driven by the
   *  off-turn cadence pass, exactly as on the cloud backend. */
  async runRefinementLane(): Promise<void> {
    const deps = this.refinementDeps;
    await refinementDebtRequest(deps);
    const step = await advanceRefinementLane(deps);

    if (step.step === 'idle') return;
    // A refinement can move the live prompt (through the section lane it feeds)
    // and the facts block, so the session's model-bound state is dropped and the
    // step is surfaced like any other self-change.
    this.invalidateModelState();
    this.emit({
      type: 'evolution',
      event: 'refinement',
      message: `Refinement ${step.request.id} is ${step.request.stage} — ${step.request.detail}`,
    });
  }

  /** Open one refinement over a trajectory. Returns the DURABLE request at
   *  `requested`: no model has run and no artifact has moved. */
  async requestRefinement(opts?: {
    turnIds?: readonly string[]; scope?: RefinementScope;
  }): Promise<RefinementRequestView> {
    let request: RequestRefinementInput = {
      trigger: 'explicit',
      scope: opts?.scope ?? 'workspace',
    };

    if (opts?.turnIds !== undefined) request = { ...request, turnIds: opts.turnIds };
    const view = await requestRefinement(this.refinementDeps, request);
    // Awaited, unlike the cloud nudge: a local `/refine` is a foreground
    // command at a terminal, and printing "queued" while the answer is one
    // await away would be worse than the wait.
    await this.runRefinementLane();

    return this.listRefinements(1).requests[0] ?? view;
  }

  /**
   * The OWNER decides one staged edit. Local only in the sense every owner
   * surface is: the person is at the terminal, which is the authority here.
   * Never reachable from a tool surface.
   */
  async decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult> {
    const result = await decideRefinementRoute(this.refinementDeps, input);

    // A promoted skill enters the next prompt and its allowed_tools bound the
    // next turn's surface, so the model-bound state is dropped.
    if (result.ok) this.invalidateModelState();

    return result;
  }

  /** The WHOLE staged file for one proposed edit, plus the digest a decision
   *  must quote back. Never truncated: this is the approval surface. */
  showRefinement(requestId: string, routeIndex: number): Promise<StagedSkillResult> {
    return showRefinementRoute(this.refinementDeps, { requestId, routeIndex });
  }

  /** Refinements newest first, plus the debt that would open the next one. */
  listRefinements(limit = 20) {
    return {
      requests: createRefinementStore(this.rt.storage.sql, this.rt.actor).list(limit).map(refinementRequestView),
      debt: refinementDebt(this.refinementDeps),
    };
  }

  /** The pending scaffold's rollout state — trials so far and what the
   *  promotion gate currently says. */
  getShadowStatus(): ShadowStatus {
    return getShadowStatus(this.rt.storage.sql, this.rt.actor);
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
    return listScaffoldVersions(this.rt.storage.sql, this.rt.actor, limit);
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

  /** `host.history` — a read-only, budgeted page of the conversation the
   *  scaffold is the inference loop for. Resolved per call, so a scaffold that
   *  reads twice in one turn sees the second read's state. */
  private makeScaffoldHistory(): NonNullable<ScaffoldRunOptions['history']> {
    return createScaffoldHistory(() => this.actorSession.history);
  }

  /** Re-run a task for the replay-eval harness: the current system prompt
   *  (knowledge tail + soul) and model, the facts world model as the same
   *  dynamic-context block live turns get, isolated history, no tools
   *  (see the engine-construction note). */
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
        contextWindow: this.sessionContextWindow(),
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      },
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

  // ── the ports an ActorHost's orchestration resolves at call time ──────
  //
  // Public because `createLocalOrchestration` builds this actor's engine,
  // governor and turn sinks BEFORE the session that answers them exists (the
  // `ActorSession` is constructed FROM those deps), so it holds a thunk to the
  // session rather than the objects. Each of these fires while a turn or a
  // cadence pass is running, which is long after construction.

  /** What the next turn's model costs, off the same catalog session that
   *  answers the context window — so a pre-run estimate and the ledger that
   *  debits it read one rate. */
  modelPricing(): ModelPricing | null {
    return this.modelCatalog.pricing();
  }

  /** A cap this actor's run hit, into that run's durable event log. */
  reportBudgetRefusal(refusal: Omit<Extract<RunEventInput, { type: 'budget_exhausted' }>, 'type'>): void {
    this.recordRunEvent({ type: 'budget_exhausted', ...refusal });
  }

  /** One settled tool call, into the run's durable event log. */
  reportToolCallEnd(event: Omit<Extract<RunEventInput, { type: 'tool_call_end' }>, 'type'>): void {
    this.recordRunEvent({ type: 'tool_call_end', ...event });
  }

  /** One finished model step, into the run's durable event log. */
  reportStepFinish(event: Omit<Extract<RunEventInput, { type: 'step_finish' }>, 'type'>): void {
    this.recordRunEvent({ type: 'step_finish', ...event });
  }

  /** One evolution event onto this session's client stream. */
  reportEvolutionEvent(event: { readonly type: string; readonly message: string }): void {
    this.emit({ type: 'evolution', event: event.type, message: event.message });
  }

  /** Queue a shadow trial of the pending scaffold against one settled turn. */
  queueShadowTrial(turn: ShadowTrialTurn, plan: ShadowTrialPlan): ShadowTrialQueueOutcome {
    return queueTurnShadowTrial(this.scaffoldControl, turn, plan);
  }

  /**
   * Drain the queued shadow trials on the cadence lane.
   *
   * A resolved gate changes the live scaffold under us, so the session's
   * model-bound state is dropped and the decision is surfaced like any other
   * self-change.
   */
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

  /**
   * The workspace's own ActorHost, for a session that has no host above it.
   *
   * A session reached without a {@link LocalAgentHost} — `kinu evolve`, `kinu
   * exec`, a fixture — is the ROOT of its tree, and its forks are still logical
   * actors of the one database. So it builds the same host the daemon builds,
   * over the same directory and the same storage; only the kinds differ, because
   * a hire needs the provider wiring the opening surface holds and this session
   * was handed none.
   */
  private buildOwnActorHost(hubSql: SqlExec): ActorHost {
    const { directory } = localActorDirectory(this.rt.actor);

    return createActorHost({
      storage: {
        sql: this.rt.storage.sql,
        transactionSync: this.rt.storage.transactionSync,
        exec: hubSql.exec,
      },
      directory,
      // Same reason the ActorSession above records none: nothing stamps a
      // build on a `bun`-run checkout.
      installedBuild: null,
      // The observer the seater filled in, when it filled one in: an actor
      // seated with no watcher is built unobserved, which is every kind but a
      // head run reporting the files it changed. The seat's MODE rides the
      // session's own slot for the same reason: a swarm node's seat is a head
      // row, and only `nodeSeats` tells the builder it seats a node.
      runtimeFor: (bound) => buildLocalActorRuntime(this.rt, bound, this.pendingWriteObserver(bound.reference.actorId), this.nodeSeats.has(bound.reference.actorId)),
      orchestrationFor: (bound) => createLocalOrchestration({
        runtime: bound.runtime,
        eventLog: new EventLog(hubSql, bound.handle),
        // A head and a node run in THIS process, so this session is their
        // client fan-out and their turn queue — which is what a local fork is.
        session: () => this,
        oneShot: this.oneShot,
        noAutoEvolve: !this.engine.enabled,
      }).deps,
      // The origin the creation site NAMED, or the default for its kind. A
      // head inherits the parent's promoted program, which is what
      // makes a fork a fork of THIS agent rather than of the builtin loop.
      loopFor: (bound) => ({
        origin: this.loopOrigins.get(bound.reference.actorId) ?? defaultLoopOrigin(bound.record.kind),
        parent: this.rt,
      }),
      // The actor whose context moved is the actor the evidence is about, so
      // this is asked per actor rather than defaulted.
      contextEvents: (bound) => bound.stores.eventRecorder,
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
   *  this process, as hosted logical actors of this workspace, and get private
   *  homes from this workspace's uid-0 view. */
  private buildAgentsSwarmDeps(): AgentsSwarmDeps {
    const nodeHome = this.rt.nodeHome;
    const nodeRuntime = this.rt.nodeRuntime;

    return {
      rt: this.rt,
      // ONE SEAT PER NODE. A wave's deps are built once and shallow-copied per
      // child, so this has to be a factory: a shared actor would give every
      // node of that wave one claim ledger, one loop pointer and one row set.
      hostNode: (node) => this.hostNode(node),
      announceHeadActivity: () => this.headActivity,
      reportNodeDelta: () => this.publishHeadStream,
      model: this.cachedModel ?? this.defaultModel("an agents swarm"),
      originContext: () => this.actorSession.history,
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
      // *Isolation*: this backend's filesystem is in this isolate, so it holds the
      // three host-owned members a private home needs (`CLIRuntime.nodeHome`), and
      // `facetHomeProvisioner` is the ONE implementation that turns them into one,
      // keyed on the node ACTOR's storage key rather than a raw node id — the actor
      // is a head, so the home lives in the `head-` namespace. So this site adapts
      // the host to the seam rather than owning a second provisioner. Built per
      // swarm call and awaited per node, so a turn that never searches never
      // boots the workspace. A runtime built elsewhere
      // (`buildCLIHeadRuntime`, a bare AgentRuntime in a harness) holds no host, and
      // then its nodes report `shared-origin-plane` rather than a home they lack.
      provisionNodeHome: nodeHome === undefined
        ? undefined
        : () => async (node) => {
          const actor = registerLocalNode(this.rt.actor, node);

          return facetHomeProvisioner(nodeHome(), () => requireLocalActorWorkspace(this.rt.actor, actor))(headAgentName(actor.storageKey));
        },
      // The home is only real through a runtime that USES the credential: the
      // node's shell runs as its uid and its file tools write as the same uid,
      // over this same filesystem. Wired from the same runtime that supplied the
      // host, so the two halves cannot come from different workspaces.
      runtimeForNodeWorkspace: nodeRuntime === undefined
        ? undefined
        : () => (home, node) => nodeRuntime(home, registerLocalNode(this.rt.actor, node), this.rt),
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
  /** The AUTOMATIC turn-end relay to a parent, injected for a SUBORDINATE.
   *  Separate from {@link reportDeps}: that is the model's own `report` tool,
   *  this is the answer a parent-driven turn owes whether or not the model said
   *  anything. Absent on a root. */
  private parentRelay: LocalParentRelay | null = null;

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

  setParentRelay(relay: LocalParentRelay): void {
    this.parentRelay = relay;
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
    const swarm = this.buildAgentsSwarmDeps();
    const base: AgentsToolDeps = { mode, swarm, budget: this.budget };
    base.profile = () => agentsProfileContext(this.actorSession.profile, this.actorSession.profileInputs);

    if (this.teamDeps) base.team = this.teamDeps;

    if (this.peersDeps) base.peers = this.peersDeps;

    return base;
  }

  /** The recent conversation handed to each spawned head as inherited context
   *  (core heads-support; capped to bound the head's LLM context). */
  private readInheritedContext(): SerializedMessage[] {
    return inheritedContextFromHistory(this.actorSession.history);
  }

  /** The shared background wrap (core background-tools) — the SAME wrapper
   *  the cf backend applies: shallow clone, 30s threshold, per-call abort. */
  private wrapToolsForBackground(raw: ToolSet): ToolSet {
    return wrapToolsForBackground(raw, {
      jobRunner: this.jobRunner,
      backgroundable: BACKGROUNDABLE_TOOLS,
      mode: () => this.actorSession.workMode,
    });
  }

  /** One routed non-turn lane as an {@link LLM}: the tier's model, its effort,
   *  and its spend filed under the lane's own source name.
   *
   *  `system` is for the lanes whose prompt is a core-declared pair rather than
   *  one string — workspace titling is the first — so the CLI issues the same
   *  request the cloud backend does instead of folding the system half into the
   *  user half and hoping the model reads it the same way. */
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
   * One routed lane's concrete client, and the provider options its tier's
   * effort asks for.
   *
   * The one local answer to "turn this routed decision into something callable",
   * shared by {@link localRouteLlm} and by the head merge — whose policy lives in
   * core (`headMergeLLM`) precisely so that this binding is all either backend
   * gets to decide. Before that, the merge bound the SESSION'S CHAT MODEL at a
   * hardcoded `'low'` and filed it as `judge` spend anyway.
   *
   * A session with no resolver has exactly one model, so a lane resolves to it
   * rather than failing: the effort still comes from the routed tier, which is
   * the axis a single-model session can still honour.
   */
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
  /** The profile a non-turn lane routes against. The PRECEDENCE is core's
   *  (`resolveRoutingProfile`), shared with the Cloudflare backend so the two
   *  cannot disagree about when a lane inherits the open turn; what is local is
   *  only where a fresh resolution comes from. Asked per call, never captured — a
   *  lane built at construction time must not pin the tier the account had then. */
  private async routingProfile(availableTools: readonly string[] = []): Promise<ResolvedTurnProfile> {
    return resolveRoutingProfile({
      actor: this.rt.actor,
      resolve: () => this.profiles().resolvePreTurn(availableTools),
    });
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

  /** Core's one resolution over this session's profile authority: the claimed
   *  tier, else the stored spec, spelled the way the plane spells it. Never the
   *  cached spec — that is null between a config change and the next turn, and
   *  a row priced in that window compared the rate against a fabricated spec. */
  private effectiveModelSpec(): string {
    return resolveEffectiveModelSpec({
      live: () => this.actorSession.profile?.tier.model,
      stored: () => this.config.getModel(),
      normalize: (spec) => this.profiles().normalizeSpec(spec),
    });
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
    const spec = this.actorSession.profile?.tier.model ?? this.profiles().normalizeSpec(this.config.getModel());

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
   * build-mode only, so a Plan turn genuinely offers less.
   */
  private codemodeProviders(mode: WorkMode): CodemodeProvider[] {
    const report = this.reportGateOpen() ? this.reportDeps : null;

    return [
      createAgentSelfProvider(this),
      // `agents.*` — the delegation tool projected into the sandbox, over
      // the same deps the top-level tool holds. Locally that is fork only.
      createAgentsCodemodeProvider(() => this.agentsToolDeps(mode)),
      // `state.*` — the provider the shared eval description promises.
      // Absent, a CLI program calling `state.set` answered a bare ReferenceError;
      // the hosted backend already binds this same provider over the same SQL.
      createStateCodemodeProvider(this.rt.actor.programState),
      // `db.*` — this ACTOR's own application tables, over the workspace's one
      // database. Scoped by the store rather than by a mode argument here: the
      // Plan decision follows the resolved table scope (actor-scope writes are
      // private research state, workspace-scope writes are not), which the
      // provider reads from the live invocation.
      createDbCodemodeProvider(this.stores.appData),
      createWebCodemodeProvider(this.getWebSearchProvider()),
      // `memory.*` / `tasks.*` — unconditional codemode projections of
      // the same-named native tools (tools/memory-tool.ts, tools/tasks-
      // tool.ts); `this.taskList` is the SAME TaskListStore instance the
      // dynamic-context snapshot reads.
      createMemoryCodemodeProvider(() => ({
        memory: this.rt.memory, facts: this.factsStore, sql: this.rt.storage.sql,
        actor: this.rt.actor,
        vectorStore: null,
      })),
      createTasksCodemodeProvider(
        this.taskList,
        this.config,
        () => this.actorSession.profileInputs?.envelope ?? null,
      ),
      // `release.*` — left the native surface for codemode-only reach
      // (tools/release-codemode.ts); deps read live so a rebind lands
      // without rebuilding this toolset.
      ...(mode === 'build' ? [createReleaseCodemodeProvider(() => this.releaseToolDeps())] : []),
      // `report.*` — the native report surface projected into the sandbox, on
      // the same gate. Both surfaces of one capability, so a child that reaches
      // for it in code finds it exactly when it finds the tool.
      ...(report ? [createReportCodemodeProvider(() => report)] : []),
    ];
  }

  /**
   * The head runtime's dependencies, with the head's own model as the argument.
   *
   * ONE builder for the two places that construct it — the constructor, before
   * any model is claimed, and every rebind after one. A second copy that omits
   * `resolveModel` is invisible: the constructor's own `ensureModelState()`
   * rebuilds immediately, so `agents swarm`'s per-search model becomes a no-op on
   * this backend forever — a panel asked for three vendors gets three copies of
   * one, which is exactly the defect `createCLIHeadRuntime`'s own tests pin one
   * layer down.
   */
  private headRuntimeOptions(
    model: () => LanguageModel,
  ): CLIHeadRuntimeDeps {
    // Annotated with the NAMED interface, not Parameters<...>[0], so the
    // field-supply census sees this construction site.
    const options: CLIHeadRuntimeDeps = {
      model,
      // The merge's model, effort and spend label are core's policy
      // (`headMergeLLM`) off this profile; the binding below is the only local
      // say in it. Binding the SESSION'S CHAT MODEL at a hardcoded `'low'`
      // effort and filing it as `judge` spend regardless would have one split
      // synthesised by the deep tier in the cloud and by whatever `/model` is
      // set to here, with the ledger unable to tell the two apart.
      profile: () => this.routingProfile(),
      bindMergeModel: (route) => this.bindRouteModel(route),
      // No `spec` stamp: this sink carries the MERGE only (a head's own
      // inference is aggregated from `head_journal`), and the merge runs on the
      // routed judge tier rather than on this session's chat model. Stamping the
      // chat spec here is the label that makes a deep-tier grading look like it
      // ran on whatever `/model` was set to. `modelId` from the provider's own
      // response is the honest record, exactly as on the cloud backend.
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

    // Per-fork models only mean something where a resolver exists; a static
    // model session has one model and every search inherits it.
    if (this.modelResolver) {
      const modelResolver = this.modelResolver;
      options.resolveModel = (spec) => modelResolver.resolveModel(spec);
    }

    return options;
  }

  /**
   * Seat one head as a logical actor of this workspace.
   *
   * The whole of what makes a local fork a real actor: its own row in the
   * directory, its own runtime objects from the one host, its own claimed loop
   * under the origin the `HeadInput` named, and — on release — its own
   * retirement. The physical bytes discarded here are only the ones OUTSIDE
   * the database: the head's scratch home. Its rows go with its directory row.
   */
  /**
   * PUBLIC for the same reason as {@link hostNode}: seating a head is
   * session-bound, so a caller that runs heads without one — a bench panel, an
   * eval arm — has no way to build a seat and would otherwise run every head
   * on its own actor. One host per caller, not one per seat.
   */
  async hostHead(input: HeadInput, writes: WriteObserver): Promise<HostedHeadSeat> {
    const binding = registerLocalActor(this.rt.actor, {
      name: explorationActorKey(input.id), creationId: input.id, kind: 'head', lifetime: 'task',
    });

    const agentName = headAgentName(binding.storageKey);
    // BOTH NAMED BEFORE ACQUIRE, because the host seeds the loop pointer and
    // builds the runtime while it builds the actor — a fork that named a
    // version must not be seeded with the default first and corrected after its
    // first claim, and a runtime built before its watcher was named would
    // report that this head changed nothing.
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

  /**
   * The write observer the seat for `actorId` named, or undefined when it named
   * none.
   *
   * PUBLIC for the HOST ABOVE this session. A daemon-hosted session seats its
   * heads on the tree's `ActorHost`, so the runtime is built by
   * `LocalAgentHost.runtimeFor` — which reaches the parent entry's session for
   * this exactly as it already reaches the parent entry's runtime for the loop
   * seed. A session hosting its own actors reads the same slot through the same
   * method, so there is ONE reader of {@link actorWrites} and the two hosts
   * cannot answer differently.
   */
  pendingWriteObserver(actorId: string): WriteObserver | undefined {
    return this.actorWrites.get(actorId);
  }

  /**
   * Seat one swarm node as a logical actor of this workspace.
   *
   * A FACTORY per node, for the reason core's `HostedNodeSeat` is one: a wave's
   * node deps are built once and shallow-copied per child, so one shared actor
   * would give every node of that wave one claim ledger and one row set.
   *
   * No release: a node's row is `task`-lifetime and its retirement belongs to
   * the search that owns the node, not to one seat handed to one loop.
   */
  /**
   * PUBLIC because a caller outside this class can legitimately need a node
   * seated and cannot build one: local node hosting is session-bound by
   * design. The session is the node's client fan-out and its turn queue
   * (`buildOwnActorHost`'s `session: () => this`), so a bare `AgentRuntime`
   * has nowhere for a node's events to land. An eval driving the swarm rung
   * directly therefore routes its seats through here rather than growing a
   * second host that would hand every node the caller's own claim ledger.
   */
  async hostNode(node: NodeIdentity): Promise<HostedNodeSeat> {
    const binding = registerLocalActor(this.rt.actor, {
      name: explorationActorKey(node.nodeId), creationId: node.nodeId, kind: 'head', lifetime: 'task',
    });

    // The mode this seat runs in, declared before the host builds it: the row
    // is a head row, and only this slot tells `runtimeFor` it seats a swarm
    // node rather than a branching head.
    this.nodeSeats.add(binding.reference.actorId);
    const actor = await this.actorHost.acquire(binding.reference);

    return {
      actor,
      runId: this.chat.currentRunId ?? WORKSPACE_RUN_ID,
      profile: (profileInput) => this.resolveActorTurnProfile(actor, profileInput),
      dynamic: (profile, tools) => this.actorDynamicContext(actor, profile, tools),
    };
  }

  /**
   * The profile ONE claimed turn of a hosted actor runs under.
   *
   * The SAME authority a chat turn resolves through — this session's refined
   * profile inputs and core's `resolveAgentTurnProfile` — because a head's or a
   * node's pinned program version and claim digest have to name a real tier.
   * The actor supplies only its own role selection, which is where a hired
   * role or an assigned tier is recorded.
   */
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
      // A fork carries no pinned skill set of its own: it explores under the
      // program its parent promoted, and the skills that program names.
      activeSkills: [],
    });

    return { profile, inputs };
  }

  /** The live per-step context block for ONE hosted actor — its own stores,
   *  never this session's, so a fork reads the work it is itself holding. */
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
    // Branching heads — in-process runtime over an isolated ephemeral store.
    // The agent's VFS backs the shared findings scratch sibling heads write to.
    this._headRuntime = createCLIHeadRuntime(this.headRuntimeOptions(() => model));

    for (const mode of ['build', 'plan'] as const) {
      const raw = buildActorTools(this.actorToolsetDeps(
        mode,
        // A CLOSURE, because this toolset is rebuilt only on a model change while
        // the turn changes every turn.
        () => currentOperationProfile(this.rt.actor)?.turnId ?? this.chat.currentTurnId ?? WORKSPACE_RUN_ID,
      ));

      this.toolSets[mode] = { raw, wrapped: this.wrapToolsForBackground(raw) };
    }

    this.activateToolMode(this.actorSession.workMode);
  }

  /**
   * One tool surface's deps, with the effect-claim identity as an ARGUMENT.
   *
   * Every tool whose effects leave this process claims them under that id, and
   * the id is half of the claim's key — so whose id it is decides what a replay
   * can dedupe against: the ambient turn for the chat surface, the rollout
   * itself for a rollout something will re-drive.
   */
  private actorToolsetDeps(mode: WorkMode, turnId: () => string): ActorToolsetDeps {
    const deps: ActorToolsetDeps = {
      rt: this.rt,
      workMode: mode,
      // The once-only boundary for tools whose effects leave this process.
      effectClaims: { sql: this.rt.storage.sql, actor: this.rt.actor, turnId },
      // No shellApprovalMode/requestShellApproval here — the gate lives at the
      // execution seam now (rt.shell / rt.executionRouter, wired once in
      // runtime.ts off actor_config live and the channel
      // `setShellApprovalHandler` installs below), not re-derived per toolset
      // build. See execution/approval.ts.
      //
      // The turn's cumulative bulk budget — held on the accumulator so this
      // toolset (rebuilt only on model change) reads the live turn's state.
      contextBudget: this.actorSession.orchestrator.acc.context,
      // Same ownership for the read-before-edit state and the per-edit outcome
      // counters the `file` tool writes.
      fileLedger: this.actorSession.orchestrator.acc.files,
      escalations: this.actorSession.orchestrator.acc.escalations,
      craftedToolExecute: createNodeCraftedExecute(),
      vectorStore: null,
      codemode: (surface) => {
        // Narrowed by the SAME set the native surface is narrowed by, so a role
        // cannot lose a tool natively and keep it through the sandbox — as a
        // `tools.<name>` binding or as a namespace. An unresolved profile
        // narrows nothing, which is the resolver's own rule for a role that
        // declares no tool list.
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

    // Structural absence is the gate, and the toolset is rebuilt per turn, so a
    // subordinate carries `report` on the turns its parent drove and on no
    // others.
    if (this.reportGateOpen() && this.reportDeps) deps.report = this.reportDeps;

    return deps;
  }

  /**
   * The tool surface a rollout with a DURABLE IDENTITY runs against: the active
   * mode's own tools, with the effect-claim id pinned to the rollout.
   *
   * A queued shadow trial is re-drivable, and its candidate reaches the live
   * tool surface. Under the ambient id the same call was claimed against the
   * last turn on a live run and against `WORKSPACE_RUN_ID` on a replay — two
   * claims for one call, so the external tool ran twice. Pinned, the claim is
   * the same on both.
   *
   * RAW, for the reason a job resume is: a rollout that handed a tool to the
   * background plane would detach work keyed to the ambient turn, which is not
   * part of what this rollout can replay.
   */
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

/** Resolve when `work` settles or `ms` elapses, whichever comes first. The timer
 *  is always cleared, so a fast settle leaves nothing holding the event loop. */
async function raceDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });

  try { await Promise.race([work, expiry]); }
  finally { if (timer) clearTimeout(timer); }
}

