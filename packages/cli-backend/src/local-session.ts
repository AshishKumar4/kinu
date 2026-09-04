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
  generateText, stepCountIs, tool, jsonSchema,
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
  LLM, ModelCallSink, ModelRouteResolution, HeadMergeModelBinding,
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult, PromptFile,
  SkillsVfs, ActiveSkillSet, TurnSkillSurface, FactsStore, KinuExtension,
  HeadRuntime, HeadGrounding, SerializedMessage, AgentConfigStore, ShellApprovalMode,
  ShellApprovalRequest, ShellApprovalOutcome, RequestShellApproval,
  AgentsForkDeps, AgentsToolDeps, TeamToolDeps, PeersToolDeps,
  IngressDescriptor, KinuEvent, EventVariant, MissingCapability, DynamicApproval,
  RunEvent, RunEventInput, RunEventQuery, StepLike, SettledSignals,
  ReleaseStore, ReleaseToolDeps, BuiltinToolName,
  FileCheckpoints, FileCheckpointListing, FileRestorePlan, FileRestoreResult,
  CheckpointAvailability,
  WorkMode, JsonValue,
} from '@kinu.run/core';
import {
  AgentOrchestrator,
  type TurnSteering,
  createAgentStores, type AgentStores, collectDynamicContext, subordinateDelegatesOf,
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
  initWebhookIngressTables,
  createTimerTrigger, cancelTrigger, listTriggers, fireDueTriggers,
  EvolutionEngine,
  readMemoryTail,
  listProposedTasks, updateProposedTaskStatus,
  agentsActionsFor,
  agentHomeNodeProvisioner,
  type HeadJournal, reconcileInterruptedForks,
  jobRedriveResumeGate, resumableForkRoots,
  skillsVfsOver, resolveTurnSkills, filterToolSetBySkills, renderFactsForTurn,
  inheritedContextFromHistory,
  ModelCatalogSession,
  BUILTIN_TOOL_NAMES, isMcpToolKey,
  // The terminal transition — core owns the vocabulary, the roster, the state
  // machine and the replay; this backend supplies only the effect bodies and
  // the wake. The same class the Durable Object drives.
  TerminalTransitions, initTerminalEffectTable, declareTerminalRoster,
  SUBORDINATE_REPORT_STATUSES,
  type SubordinateReportStatus, type TaskTurnEnding,
  TERMINAL_EFFECT_NAMES,
  terminalEffect, keyedScope,
  RunEndReasonSchema, TurnContinuitySchema, WorkModeSchema, CompletedTurnSchema,
  ModelMessagesSchema, shadowTrialPlan, trimTrialContext,
  type TerminalTransition, type TerminalEffectTable, type TerminalEffectFault,
  type TerminalTurnParts, type OwedEffect,
  buildActorTools, withClampedToolResults, buildSystemPromptSync, currentDateForPrompt,
  type ActorToolsetDeps,
  activePromptSectionOverrides,
  turnProvenanceForMetadata, workModeForTurnMetadata,
  runChat, estimateTokens, INTERRUPTED_TURN, type CountableRequest,
  parseModelSpec, agentAffinityKey,
  OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT,
  openTurnRun, closeTurnRun, snapshotCompletedTurn, creditedTurnId,
  classifyRunEnd, type RunEndFacts, type RunEndReason,
  normalizeUsage,
  persistMeasuredPromptTokens, applyOverflowRecovery, measureCompactionTrigger,
  CompletionGate, observeCompletionState, completionGateText, COMPLETION_GATE_EVENT,
  runAdvisorLane, AdvisorRecoverySnapshotSchema, type AdvisorRecoverySnapshot,
  effectAlreadyDone, recordEffectDone,
  PROGRAMMATIC_MESSAGE_ID_PREFIX, stampTurnAuthor,
  type JsonObject,
  ExtensionHost, UserSteerDrain,
  STEER_METADATA_KEY, STEER_STEP_METADATA_KEY, describeLandedSteers,
  type UserSteer, type SteerStatusDetail, type SteerStatusEvent,
  createDefaultWebSearchProvider, createWebCodemodeProvider, type WebSearchProvider,
  createAgentsCodemodeProvider, createReleaseCodemodeProvider, type CodemodeProvider,
  createMemoryCodemodeProvider, createTasksCodemodeProvider,
  createReportCodemodeProvider, REPORT_TOOL, type ReportToolDeps,
  MissionGovernor,
  DynamicContextLedger, turnLocalContextMessage, unverifiedInstructionsMessage,
  observeSystemPromptHash,
  type DynamicContext,
  type MediaModality,
  createReleaseStore, initReleaseTables, releaseSqlFromExec,
  initWorkspaceBaselineTable, initWorkspaceSchema,
  InstructionApprovalStore, listInstructionApprovals, gatherApprovableInstructions,
  snapshotExistingInstructions,
  admitInstructionDecision, type AdmittedInstructionDecision,
  openInstructionSource,
  type InstructionSourceRow, type InstructionSourceView,
  type InstructionTrustResolver,
  // The scaffold evolution control plane — core owns the drivers; this session
  // supplies the local surface they run against.
  applyScaffoldDecision, createLlmJsonJudge, getShadowStatus, listGepaRuns, listScaffoldVersions,
  previewScaffoldLive, proposeScaffold, runScaffoldGepaOptimization, runScaffoldOnce,
  queueTurnShadowTrial, runQueuedShadowTrials,
  type GepaOptimizationResult, type GepaRunSummary, type ScaffoldControl,
  type ScaffoldDecisionResult, type ScaffoldReplayContext, type ScaffoldVersionView,
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
  claimAlternateTakesForTurn, purgeUnclaimedAlternateTakes, unclaimedAlternateTakeIds,
  latestAlternateTakeSet,
  getCurrentScaffoldVersion,
  scaffoldChatTransform, type ScaffoldRunOptions,
  bootstrapScaffold,
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  type AlternateTakeSet, type TakePickOutcome,
  startBranchHead, settlePendingBranch, settleBranchIntoTakes, newBranchId,
  branchHeadId, branchOutcomeFromJournal,
  type PendingBranch, type BranchStatusEvent,
  type AlarmScheduler, type BackgroundJob, type SqlExec, type RawSqlExec,
  type TimerTrigger, type TimerTriggerOpts, type TriggerView,
  type CancelTriggerResult, type TrustLevel,
  type WebhookDelivery, type WebhookDeliveryResult, type WebhookSecretStore,
  reasoningEffortOptions,
  BUILTIN_PROFILE_CATALOG, TIER_IDS, effectiveRoleCatalog,
  changeActiveRole, agentsProfileContext, canonicalConversationId,
  resolveAgentTurnProfile, resolveModelRoute, resolveRoutingProfile,
  buildModelCallEvent,
  applyWorkspaceTitle, planWorkspaceTitle, suggestWorkspaceTitle,
  isPlaceholderMission, readMission, type WorkspaceTitleState,
  type PromptIdentity,
  roleChangeOutcomeText, narrowToolSurface, codemodeCapabilitiesFor,
  readSoul,
  type ProfileCatalogEnvelope, type ProviderCatalogSnapshot,
  type ResolvedTurnProfile, type TierId,
  decodeJsonValue, projectJsonValue, parseJsonValue, JsonValueSchema,
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
  stepContextLimit, admitMcpDescriptors, toolSurfaceTokens,
} from '@kinu.run/core';
import {
  diagnostics, KinuError, renderThrownChain, tolerate, toKinuError, type Refusal,
} from '@kinu.run/core/obs';
import { makeSqlExec, type CLIRuntime } from './runtime';
import { discoverAgentsMd } from './agents-md';
import { createNodeCraftedExecute } from './craft-executor';
import { createNodeExecuteToolFactory } from './execute-tools-factory';
import { createCLIHeadRuntime, type CLIHeadRuntimeDeps } from './head-runtime';
import { detectOrphanedFibers, type OrphanedFiber } from './fiber';
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

/**
 * The grace this backend allows a stranded event delivery: none.
 *
 * `EventLog.unbindStale` takes a grace because a Durable Object activation can
 * be racing its own predecessor and has no way to exclude it. This backend
 * does: {@link LocalAgentSession.reclaimStrandedEventDeliveries} runs under the
 * single-driver lease, so no other process is driving this conversation and this
 * session has not drained yet — every OPEN lease is a dead process's by
 * construction. Waiting out a clock would only delay work that is already
 * provably abandoned.
 */
const NO_STRANDED_DELIVERY_GRACE = 0;

/** The bun:sqlite handle this session needs: prepared statements for the
 *  EventsHub SqlExec adapter, and the real `transaction` — the approval
 *  migration writes its baseline and marker under one, and so does a settled
 *  turn's answer-plus-roster commit. A torn write that reports success is what
 *  an identity-function stand-in would buy. */
export type LocalSessionDb = Pick<Database, 'prepare' | 'transaction'>;

/**
 * The frozen roster of a response whose answer is on disk and whose terminal
 * transition was never claimed.
 *
 * The assistant row is committed before core can claim anything — the roster is
 * a value this session reads, and reading it is not a durable act — so a process
 * killed in between used to leave a durable answer that `resumeAll()` could not
 * see: `incomplete()` finds CLAIMS, and there was none. Every take, branch,
 * recording, drain, trial and title of that turn was then lost with nothing on
 * disk to say so.
 *
 * This row closes that window because it is written in the SAME transaction as
 * the answer. It carries the roster core's own `declareTerminalRoster` produced
 * — never a re-derivation, which would score the turn against a world it did
 * not run in — and the next start hands it straight back to `settle()`, which
 * claims and replays it exactly as a first attempt.
 *
 * Deleted as soon as the transition has a claim behind it. A row that survives
 * a claim is harmless (`settle()` reads `resumed` or `done` and replays from the
 * ledger instead), but a row that is never deleted is a turn every later start
 * re-enters.
 */
function initTerminalIntentTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS terminal_intents (
    message_id  TEXT PRIMARY KEY,
    turn_id     TEXT NOT NULL,
    roster_json TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  )`);
}

/**
 * A recorded roster, read back.
 *
 * Narrowed on the way IN, not trusted: a row written by a build that named a
 * fourth lane or an effect this one does not have would otherwise be handed to
 * core as a roster and claimed. The per-effect ledger already blocks a row whose
 * NAME it cannot run; this is the same refusal one step earlier, where the whole
 * array is still a single unreadable value.
 */
const RecordedRosterSchema: v.GenericSchema<OwedEffect[]> = v.array(v.object({
  name: v.picklist(TERMINAL_EFFECT_NAMES),
  scope: v.string(),
  input: JsonValueSchema,
  lane: v.union([v.literal('inline'), v.literal('detached')]),
}));

/** The advisor lane's durable fiber name — the same name the Durable Object's
 *  fiber recovery dispatches on, because it is the same lane. */
const ADVISOR_LANE_FIBER = 'advisor.review';

/** The tombstone scope one turn's advisor lane is recorded under. It marks the
 *  lane RECOVERABLE, not finished: from the checkpoint on, a second lane beside
 *  it would be a duplicate review. */
const ADVISOR_LANE_SCOPE = 'advisor_lane';

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
 * One response's answer and everything it owes, as one durable commit.
 *
 * `facts` travel rather than the classification, because the run row is sealed
 * AFTER this commit while the roster is frozen inside it. `classifyRunEnd` is a
 * pure function of these facts, so the reason the roster carries and the reason
 * the run row is sealed with cannot disagree: there is one value behind both.
 */
interface CommittedTurn {
  readonly messageId: string;
  readonly facts: RunEndFacts;
  readonly turn: CompletedTurn;
  readonly owed: readonly OwedEffect[];
  /** What core claims this sequence under. Null for a response whose turn has
   *  no durable identity: that sequence runs unledgered and records no intent. */
  readonly transition: TerminalTransition | null;
}

/** Whether the turn reached disk. A failure is reported rather than thrown,
 *  because the signal settle after it must run either way. */
type TurnCommit = { readonly committed: CommittedTurn } | { readonly failure: KinuError };

/**
 * The answer a subordinate's turn owes its parent, as the terminal roster sees
 * it.
 *
 * Installed by the owning host, which is the only thing that knows the parent's
 * rail and whether this turn was the parent's to drive. It is a PORT rather than
 * an event listener because the report is now an owed effect: the host used to
 * start it as an untracked promise off `turn-end`, so a process that died before
 * the parent's ingress admitted it had nothing on disk saying a retry was owed.
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

/** What the frontends render. A superset of runChat's ChatEvent with the
 *  lifecycle + side-channel (evolution, broadcast, background) events. */
export type SessionEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string; workMode: WorkMode }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: ToolCallArguments }
  | { type: 'tool-result'; toolName: string; toolCallId: string; result: string; success: boolean }
  | { type: 'turn-end'; turn: CompletedTurn }
  | { type: 'error'; message: string }
  | { type: 'evolution'; event: string; message: string }
  // Job, event-delivery and connection lifecycle — the machinery AROUND a
  // turn, kept apart from `evolution` so "the agent changed itself" and
  // "a background job settled" never share a channel: `kinu exec
  // --no-auto-evolve` pins evolution silent while jobs may still settle.
  | { type: 'background'; event: string; message: string }
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
  /** Root workspace authority shared with local child sessions that share this
   * VFS. A child never gets an independent migration marker or approval table. */
  instructionApprovals?: InstructionApprovalStore;
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
  /** The id the in-flight turn's opening row carries — minted at turn start,
   *  written by `persist`, and the scope every effect claim this turn makes is
   *  keyed to. Null between turns. */
  private currentTurnId: string | null = null;
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
  private pendingShellApproval: DynamicApproval | null = null;
  private shellApprovalSequence = 0;
  private turnProfile: ResolvedTurnProfile | null = null;
  private turnProfileInputs: {
    envelope: ProfileCatalogEnvelope;
    provider: ProviderCatalogSnapshot;
  } | null = null;
  private readonly sessionId: string;
  /** True when this process runs one task turn and exits — see the `oneShot`
   *  option. Decides turn continuity and whether the cadence lane may start. */
  private readonly oneShot: boolean;
  /** Whether this session runs the evolution lanes at all (`--no-auto-evolve`
   *  turns them off). Held rather than only handed to the engine: a lane this
   *  session will refuse must not be DECLARED as owed, or the refusal becomes a
   *  row nothing can ever complete. */
  private readonly autoEvolve: boolean;
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
  /** The owner's standing instruction approvals for THIS working directory —
   *  the authority that decides whether discovered AGENTS.md / skill bytes are
   *  placed as system instructions or as unverified reference material. */
  private readonly instructionApprovals: InstructionApprovalStore;
  /** The migration is awaited before the first turn can resolve a trust verdict.
   * It snapshots existing paths once; later paths never receive a first-seen
   * fallback. */
  private instructionMigration: Promise<void> | null = null;
  /** Bound once rather than rebuilt per turn: both discovery and skill
   * admission take the resolver as a plain function. */
  private readonly instructionTrust: InstructionTrustResolver =
    (path, content) => this.instructionApprovals.trustOf(path, content);
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
  /** The idempotency key of the turn the pump is running RIGHT NOW, or null.
   *  An item is shifted out of the queue before it runs and its durable row
   *  lands at the end, so this is the only thing that says "already being said"
   *  for the whole length of a turn. */
  private runningAnnouncement: string | null = null;
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
    this.onEvent = opts.onEvent;
    this.oneShot = opts.oneShot === true;
    this.autoEvolve = opts.noAutoEvolve !== true;
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
      enabled: this.autoEvolve,
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
      shadowTrialQueue: (turn, opts) => queueTurnShadowTrial(this.scaffoldControl, turn, opts),
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
    // The per-effect ledger a settled turn's suffix is claimed in, and the
    // intent row that carries a roster whose claim never landed. Idempotent
    // DDL, and here beside the rest of the schema for the same reason: a session
    // may be the first thing to touch this database.
    initTerminalEffectTable(this.rt.storage.sql, this.rt.storage.execRaw);
    initTerminalIntentTable(this.rt.storage.execRaw);

    // Instruction approvals are keyed by the directory on THIS disk, because on
    // a local CLI that directory IS the authority — there is no owner/workspace
    // pair to name. Resolved once: the answer is a filesystem fact, and a turn
    // should not pay a realpath for it. A cwd that has been deleted out from
    // under the process still gets an honest absolute scope, so a session that
    // outlives its directory cannot silently share another tree's approvals.
    const approvalScope = tolerate(() => realpathSync(this.cwd), 'enoent') ?? resolve(this.cwd);
    this.instructionApprovals = opts.instructionApprovals ?? new InstructionApprovalStore(
      this.rt.storage.sql,
      `local:${approvalScope}`,
      (body) => opts.db.transaction(body)(),
    );

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

    this._headRuntime = createCLIHeadRuntime(this.headRuntimeOptions(
      () => this.cachedModel ?? this.defaultModel("a head with no model of its own"),
    ));

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
    };
    this.triggerRegistry = new TriggerRegistry(hubSql, alarmScheduler);
    this.replyChannels = new ReplyChannelStore(hubSql);
    this.hubSql = hubSql;
    this.webhookSecrets = createWebhookSecretStore(hubSql);
    // Webhook + inbound-email deliveries count against a per-minute window, and
    // a verified signature is claimed once against replay (core
    // events/ingress), which needs both tables at boot.
    initWebhookIngressTables(hubSql);

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
      // The refinement lane runs on the ONE off-turn cadence pass, beside the
      // promotion gate's trials — the same drive site the cloud backend uses,
      // so the two cannot disagree about when a refinement happens.
      refinementLane: () => this.runRefinementLane(),
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
      logActivity: (event, detail) => this.emit({ type: 'background', event, message: detail ?? '' }),
      // Process exit is the local analogue of a DO eviction: re-drive an
      // interrupted job from its durable checkpoint instead of failing it.
      resume: (kind, input, mode, signal) => this.resumeBackgroundJob(kind, { value: input }, mode, signal),
      // What a bounded-out job already produced. Same predicate as `resume`, so a
      // side-effecting kind has nothing partial to read and a SEARCH does — the case
      // that used to settle empty over candidates it had really measured.
      harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
        { sql: this.rt.storage.sql, ledger: this.mctsSearchStore }, kind, input,
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

  /** The host passes this exact authority to every local child sharing the
   * workspace plane. It is intentionally not a copy: revocations are live. */
  instructionApprovalAuthority(): InstructionApprovalStore {
    return this.instructionApprovals;
  }
  /** Skills pinned always-active for this agent (the `/always` command). */
  getAlwaysActiveSkills(): string[] { return getAlwaysActiveSkills(this.config).names; }
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void { setAlwaysActiveSkills(this.config, names); }

  private async ensureInstructionApprovalMigration(): Promise<void> {
    const existing = this.instructionMigration;
    if (existing !== null) {
      await existing;
      return;
    }
    const migration = (async () => {
      const limits = {
        contextWindow: this.sessionContextWindow(),
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      };
      const agentsMd = discoverAgentsMd(this.cwd, limits, () => 'unverified');
      const entries = await snapshotExistingInstructions({
        agentsMd,
        skillsVfs: skillsVfsOver(this.rt.storage.vfs),
        admissionTokens: stepContextLimit(limits),
      });
      this.instructionApprovals.grandfatherExisting(entries);
    })();
    this.instructionMigration = migration;
    try {
      await migration;
    } catch (cause) {
      if (this.instructionMigration === migration) this.instructionMigration = null;
      throw cause;
    }
  }

  /**
   * The owner's instruction-file surface for this working directory
   * (KINU-N028): every AGENTS.md and workspace skill this session would carry,
   * with what an approval would bind.
   *
   * Discovery runs fresh rather than reporting the last turn's values, because
   * the owner has to be shown what is on disk NOW — approving a digest that has
   * already moved on would grant nothing and say it granted something.
   */
  async listInstructionApprovals(request: PageRequest = {}): Promise<Page<InstructionSourceRow>> {
    await this.ensureInstructionApprovalMigration();
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
    await this.ensureInstructionApprovalMigration();
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
    });
  }

  /** Follow these exact bytes at this path as instructions. Same admission rule
   *  as the cloud transport, because it is core's rule, not either side's. */
  async approveInstruction(path: string, reviewedDigest: string): Promise<AdmittedInstructionDecision> {
    await this.ensureInstructionApprovalMigration();
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
    await this.ensureInstructionApprovalMigration();
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
    return this.turnProfile?.tier.model ?? this.profiles().normalizeSpec(this.config.getModel());
  }

  /** The catalog role id this agent resolves under. A legacy freeform
   *  selection has no id; the honest structural answer is `general`. */
  getActiveRoleId(): string {
    if (this.turnProfile) return this.turnProfile.role.id;
    const selection = this.config.getRoleSelection();
    return selection.kind === 'catalog' ? selection.roleId : 'general';
  }

  getEffectiveTierId(): string {
    if (this.turnProfile) return this.turnProfile.tier.id;
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

  /** `caller` has no default, for the same reason the cloud backend's does not:
   *  this one method is the CLI operator's cancel AND the model's
   *  `agent.cancelSchedule`, and only the first may close an owner-created
   *  ingress. */
  cancelTrigger(trigger_id: string, caller: TrustLevel): CancelTriggerResult {
    const result = cancelTrigger(this.triggerRegistry, trigger_id, Date.now(), caller, this.webhookSecrets);
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
    const webhook = await registerDurableWebhook(
      this.triggerRegistry, this.webhookSecrets, opts, Date.now(),
    );
    return {
      trigger_id: webhook.trigger_id,
      auth_mode: webhook.auth_mode,
      secret: webhook.secret,
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
      if (this.ended) return;
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

  /** Is this fact already recorded in the durable transcript, already queued to
   *  be, or being said right now? All three matter: a cold activation asks the
   *  table, a second delivery inside one activation (recover + recoverOrphans
   *  naming the same job) asks the queue, and a producer whose retry falls due
   *  mid-turn asks the running key — neither of the others shows a turn that has
   *  started and not yet persisted. */
  private hasAnnounced(identity: string): boolean {
    return this.announcementInFlight(identity) || this.announcementOnDisk(identity);
  }

  /** Queued, or running right now. */
  private announcementInFlight(identity: string): boolean {
    return this.runningAnnouncement === identity
      || this.queue.some((item) => item.idempotencyKey === identity);
  }

  /** Recorded in the durable transcript — the half a later process can read. */
  private announcementOnDisk(identity: string): boolean {
    const id = `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${identity}`;
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
    const log = (message: string): void => {
      this.emit({ type: 'background', event: 'mcp', message });
    };
    const conn = await connectMcpServers(servers, log);
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
    const tools: ToolSet = {};
    for (const d of admission.admitted) {
      tools[d.toolKey] = tool({
        description: d.description ?? `${d.serverName}/${d.name}`,
        inputSchema: jsonSchema<JsonObject>(d.inputSchema ?? { type: 'object' }),
        execute: async (args) => conn.call(d.serverName, d.name, args),
      });
    }
    // MCP servers are bulk producers like any other tool — same clamp, same
    // spill path, same turn budget as the builtins.
    this.extraTools = withClampedToolResults(tools, {
      vfs: this.rt.storage.vfs, budget: this.orch.acc.context, producer: 'external_tool',
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
   * Re-pend the event deliveries a dead process left leased.
   *
   * A drain BINDS its selected events to a synthetic `evt-…` turn and opens a
   * recovery lease on them (`consumed_at`), then hands them to the signal seam,
   * which either splices them into the live turn or queues one. Everything from
   * that point until the turn's answer is on disk lives in ONE process's memory:
   * kill it there and the rows stay bound to a turn nobody will ever run —
   * invisible to `pending()`, so no later drain, wake or restart can see them.
   * A webhook that was answered with `admitted: true` then simply never happens.
   *
   * There is no clock here and there does not need to be one — see
   * {@link NO_STRANDED_DELIVERY_GRACE} for why the lease this runs under is the
   * whole argument. An answered delivery is never open, because a turn that
   * reached disk closes its own lease ({@link closeEventDeliveryLeases}), which
   * is what makes reclaiming the rest a recovery rather than a re-delivery.
   *
   * Call once at startup, before the recovery drain, so the rows it hands back
   * are in that same drain's selection.
   */
  reclaimStrandedEventDeliveries(): void {
    const reclaimed = this.eventLog.unbindStale(NO_STRANDED_DELIVERY_GRACE);
    if (reclaimed.length === 0) return;
    diagnostics.event('event.deliveries_reclaimed', { count: reclaimed.length });
    this.emit({
      type: 'background',
      event: 'events_reclaimed',
      message: `${reclaimed.length} event delivery/ies were bound to a turn a previous process did not finish — re-queued`,
    });
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
    // The live wake dies with the process either way; clearing it here is what
    // stops a timer firing a replay into a session that has closed its stores.
    this.clearTerminalRetry();
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
   * Nothing here is optional. Each step used to absorb its own failure, so a
   * workspace whose fiber rows could not be read recovered NOTHING and then looked
   * exactly like one that had no interrupted work — while the notice the previous
   * exit printed promised the operator these jobs would resume.
   */
  async recoverBackgroundJobs(): Promise<void> {
    const advisorOrphans: OrphanedFiber[] = [];
    for (const orphan of detectOrphanedFibers(this.rt.storage.sql)) {
      if (orphan.name === ADVISOR_LANE_FIBER) {
        advisorOrphans.push(orphan);
        continue;
      }
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
      logActivity: (event, detail) => this.emit({ type: 'background', event, message: detail ?? '' }),
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
    await this.recoverTerminalTransitions(advisorOrphans);
  }

  /**
   * Finish every terminal sequence this workspace still owes — under the DRIVER
   * LEASE, because the alternative is two processes running one turn's effects.
   *
   * The in-flight guard core keeps is process-local, so an interactive session
   * opening a workspace a daemon is already settling used to read the same
   * pending rows and invoke the same advisor review, completion gate and title
   * call beside it. Nothing on the row could tell them apart: both saw `pending`
   * and neither had yet advanced the other's `next_attempt_at`.
   *
   * So the lease is ACQUIRED, through the same gate every other converting
   * boundary asks — the drain, the pump, the host's pass. A session with no gate
   * installed is a session nobody else can be driving (a fixture, a benchmark
   * harness), and it recovers as before.
   *
   * Three sources, in order. First the advisor orphans the startup scan set
   * aside: a review is a model call, and two processes that both read the same
   * orphan and both see no note yet would each spend one and append their own.
   * Then the intents: a response whose answer reached disk and whose transition
   * was never claimed, replayed from the roster frozen beside the answer. Then
   * the claims: a transition that was claimed and whose suffix is still owed.
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
      void this.rt.storage.sql`DELETE FROM fibers WHERE id = ${orphan.id}`;
    }
    await this.settleRecordedIntents();
    await this.terminal.resumeAll();
    // A replayed sequence can enqueue a turn (the completion gate does), and on
    // this path no turn owns the pump. What it must NOT do is decide the advisor's
    // verdict by arriving early — and it cannot any more: the gate state the
    // review is judged against travels in the improvement-lanes row rather than
    // being re-read from a RAM gate this process never armed.
    this.pump();
  }

  /**
   * Claim and replay every response whose answer is on disk under a roster
   * nothing ever claimed.
   *
   * The recorded roster is handed straight back to `settle()`, which needs no
   * other input: an unclaimed intent takes the first-attempt path and claims
   * exactly these rows, and one whose claim did land reads `resumed` or `done`
   * and replays from the ledger instead. All three dispositions are correct, so
   * this asks no question about which one applies.
   *
   * The intent is dropped once `settle()` has returned, because from that
   * instant the ledger's rows carry the sequence. It is KEPT when `settle()`
   * throws: the claim may never have landed, and this row is the only thing that
   * could bring the roster back.
   */
  private async settleRecordedIntents(): Promise<void> {
    const rows = this.rt.storage.sql<{ message_id: string; turn_id: string; roster_json: string }>`
      SELECT message_id, turn_id, roster_json FROM terminal_intents ORDER BY recorded_at, message_id`;
    for (const row of rows) {
      const transition: TerminalTransition = { turnId: row.turn_id, messageId: row.message_id };
      const parsed = v.safeParse(
        RecordedRosterSchema,
        tolerate(() => parseJsonValue(row.roster_json), 'malformed-input'),
      );
      if (!parsed.success) {
        // A roster this build cannot read is not a roster it may guess at, and
        // keeping the row would re-offer the same unreadable bytes on every
        // start. The failure is named with the sequence it belonged to.
        diagnostics.failure('turn.terminal_intent_unreadable', toKinuError({
          doing: 'reading the roster a settled turn recorded beside its answer',
          cause: new Error(parsed.issues.map((issue) => issue.message).join('; ')),
          otherwise: 'unsupported',
        }), { turnId: row.turn_id, messageId: row.message_id });
        this.clearTerminalIntent(row.message_id);
        continue;
      }
      const owed = parsed.output;
      try {
        await this.terminal.settle({
          transition,
          declare: () => owed,
          hold: (claimed, close) => { this.holdTerminalClose(claimed, close); },
        });
      } catch (err) {
        diagnostics.failure('turn.terminal_intent_replay_failed', toKinuError({
          doing: 'claiming the roster a settled turn recorded beside its answer',
          cause: err,
          otherwise: 'unavailable',
        }), { turnId: row.turn_id, messageId: row.message_id });
        continue;
      }
      this.clearTerminalIntent(row.message_id);
    }
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
    const running = this.runPump();
    // Assigned only if the pump is STILL running. `runPump` on an empty queue
    // reaches no await, so it runs to completion inside this call and clears both
    // fields on its way out — and an unconditional assignment then reinstated a
    // resolved promise as the live one, which every later `settleBackgroundWork`
    // spun on forever. An empty kick is legitimate (a startup replay makes one),
    // so the fix belongs here rather than at each caller.
    if (this.pumping) this.pumpPromise = running;
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
        // The key of the turn about to run, so a producer asking whether this
        // fact is already being said gets a truthful answer while it is.
        this.runningAnnouncement = item.idempotencyKey ?? null;
        try {
          await this.processTurn(item);
        } catch (err) {
          diagnostics.failure(
            'turn.processing_failed',
            toKinuError({ doing: 'processing a queued turn', cause: err, otherwise: 'io' }),
          );
        } finally {
          this.runningAnnouncement = null;
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
      completionGate: this.completionGate.take(),
      craft: this.orch.craft.snapshot(),
      recoveries: this.orch.recoverySnapshot(),
      reason: end.reason,
    };
    if (end.error) outcome.error = end.error;
    closeTurnRun(this.eventRecorder, this.currentRunId, { ...outcome, workMode: this.turnWorkMode });
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
    this.emit({ type: 'turn-start', kind: item.kind, text: item.text, event, workMode: this.turnWorkMode });

    const startedAt = Date.now();
    // Per-turn accounting reset + the turn's mission scope, together: what the
    // turn is allowed to spend is part of what the turn is.
    this.orch.beginTurn(startedAt, item.metadata);
    // Open this turn's run in the durable event log (core turn-lifecycle).
    // Provenance mirrors the DO's: a real chat turn is 'chat', a programmatic
    // one names its trigger.
    this.currentRunId = `run-${crypto.randomUUID()}`;
    // The id the turn's opening row will carry, decided HERE rather than at
    // persist time: the effect claims a tool makes mid-turn are keyed to it, and
    // a re-announced programmatic turn must key to the same one its first
    // announcement did — which is exactly what its idempotency key gives it.
    this.currentTurnId = item.kind === 'programmatic'
      ? `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${item.idempotencyKey ?? crypto.randomUUID()}`
      : crypto.randomUUID();
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

  /**
   * Close the recovery lease on every event delivery THIS turn answered.
   *
   * A drain stamps the synthetic turn its rows are bound to onto whatever
   * absorbed them: `drainTurnId` on the turn it queued, `replyTurnId` on the
   * signal a live turn spliced. Both are read here, because both are ways an
   * event gets answered and only one of them starts a turn of its own.
   *
   * The BINDING stays — it is what stops a second drain re-delivering the same
   * event, and reply-channel and audit reads find the rows by it. The LEASE is
   * the separable claim "a running turn still owes this delivery an answer",
   * and closing it is the whole difference between an answered delivery and one
   * {@link reclaimStrandedEventDeliveries} must hand back. The cloud backend
   * closes it in `completeEventBatch`, after the outbound replies its turn owed;
   * a local session has no transport in front of its reply channels, so the
   * durable answer is all of what it owes.
   */
  private closeEventDeliveryLeases(item: QueueItem, absorbed: SettledSignals['absorbed']): void {
    const drainTurns = new Set<string>();
    const queued = v.safeParse(v.string(), item.metadata?.drainTurnId);
    if (queued.success) drainTurns.add(queued.output);
    for (const signal of absorbed) {
      if (signal.replyTurnId) drainTurns.add(signal.replyTurnId);
    }
    for (const turnId of drainTurns) this.eventLog.markTurnCompleted(turnId);
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
    await this.ensureInstructionApprovalMigration();
    const profileInputs = await this.profiles().inputs();
    const activeRoleId = this.getActiveRoleId();
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
      activeRoleId: this.getActiveRoleId(),
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

    const pendingCalls: Array<{ toolName: string; toolCallId: string; args: ToolCallArguments }> = [];
    let fullText = '';
    /** The turn's terminal failure text, persisted on run_end so a post-hoc
     *  read of the log carries the same evidence the cf run_end does. */
    let runError: string | null = null;
    /** Whether the turn was CUT rather than failed. Kept apart from `runError`
     *  because an interrupt throws too, and folding the two together is what
     *  made a user's Stop read as an agent failure in the local run ledger. */
    let interrupted = false;
    let overflowRetry = false;
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
      history: [...this.history],
      // Model-capability attachment sanitization — runChat applies it to
      // the whole history BEFORE the transform seam and the ledger weave
      // (same ordering as the DO's beforeTurn); this.history itself is
      // never mutated.
      attachments: {
        accepts: this.sessionAcceptedMedia(), vfs: this.rt.storage.vfs, budget: this.orch.acc.context,
      },
      dynamicContext,
      turnLocal: turnLocalMsgs.length > 0 ? turnLocalMsgs : undefined,
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
    // Exact pre-submission admission — the resolved provider's own count of the
    // assembled request (core `assembleTurnMessages` owns what is done with the
    // number). On the LIVE turn only, for the same reason `meter` is: a
    // shadow-eval replay re-runs these opts off the priced path, and the request
    // it replays was already admitted here. A static-model session has no
    // registry to ask, and is assembled ungated exactly as before.
    const resolver = this.modelResolver;
    const liveTurn: Parameters<typeof runChat>[0] = {
      ...liveTurnOpts, history: this.history, signal: abort.signal, extensions,
      meter: this.orch.acc.composition,
    };
    if (resolver) {
      liveTurn.countInputTokens = (request: CountableRequest) =>
        resolver.countInputTokens(this.effectiveModelSpec(), request);
    }
    const defaultTurn = runChat(liveTurn);

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
      // Planning and compaction arming are synchronous. The retry itself is
      // recorded in the terminal roster below, beside the answer it follows.
      overflowRetry = applyOverflowRecovery({
        error: message,
        lastPromptTokens: this.orch.acc.lastPromptTokens,
        contextWindow,
        turnWasOverflowRetry: item.metadata?.kinuEvent === OVERFLOW_RETRY_EVENT,
        state: this.compactionState,
        sessionKey: cache.sessionKey,
      }).enqueueRetry;
    } finally {
      this.currentAbort = null;
    }

    // The turn's whole durable record, in ONE commit — see {@link commitTurn}.
    const commit = this.commitTurn({
      item,
      event,
      startedAt,
      assistantText: fullText,
      runError,
      interrupted,
      trialContext: liveTurnOpts.history,
      reachableTools: Object.keys(liveTurnOpts.tools ?? {}),
      overflowRetry,
    });

    // Turn over for signal delivery — the same spine the cf backend runs, and
    // for the same reason: exactly once per turn, after `currentAbort` is
    // cleared (so a signal that arrived after the final step boundary always
    // re-delivers instead of landing on a step that no longer exists), and
    // outside every failure path, so nothing that throws can skip it.
    //
    // The verdict includes DURABILITY. A turn whose answer never reached disk
    // did not answer the events its signals carried, so `completed: false` is
    // the honest report: the seam re-queues them, and a re-delivery that cannot
    // be queued hands their bound event rows back to pending. Settling them as
    // answered leaves those rows bound forever to a turn nothing can read back.
    const durable = runError === null && 'committed' in commit;
    const settled = this.orch.signals.settle({ completed: durable });
    if (durable) this.closeEventDeliveryLeases(item, settled.absorbed);

    if (!('committed' in commit)) {
      const message = renderThrownChain({ cause: commit.failure });
      this.orch.acc.hadError = true;
      this.closeRun({
        completed: false,
        interrupted: false,
        errorText: runError ?? message.slice(0, 500),
      });
      diagnostics.failure('turn.persist_failed', commit.failure);
      // The answer is not durable, so it is not published as one. The stream's
      // deltas already went out — they are what the operator watched happen —
      // but the terminal event carries no final answer, because a restart reads
      // this turn back as a turn that produced nothing.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });
      return;
    }
    const { messageId, facts, turn, owed, transition } = commit.committed;

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

      this.closeRun(facts);
      // Core drives everything the settled turn causes from here: the in-process
      // guard, the durable claim, the roster, the run and the close are ONE
      // state machine, and this backend supplies only what it owns — the effect
      // bodies below and the fiber that keeps the process alive for the
      // detached tail. Until this existed the CLI released its claims the
      // moment the transcript was persisted and had no recovery at all, so a
      // laptop killed here lost the whole suffix.
      //
      // The roster is HANDED BACK, not rebuilt. It was frozen inside the commit
      // above and is the same array the intent row carries, so the rows core
      // claims are the rows a recovery would have replayed — a second
      // declaration would read live state that has moved on.
      await this.terminal.settle({
        transition,
        declare: () => owed,
        hold: (claimed, close) => { this.holdTerminalClose(claimed, close); },
      });
      // The claim is behind the roster now, so the intent has nothing left to
      // carry: from here the ledger's own rows are what a recovery reads.
      this.clearTerminalIntent(messageId);
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
      // The answer IS durable here — the commit ran above, before the signal
      // settle, so what failed is the bookkeeping around a turn a restart can
      // still read back. That is why this path still reports the answer it
      // reports: the failure is stated, and the turn is terminal either way.
      // The intent row STAYS: the transition may never have been claimed.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn });
    }
  }

  /**
   * Make this turn durable — the answer, the verdict its run row is sealed with
   * and the frozen roster of everything the answer owes — as ONE commit.
   *
   * The roster is the only thing a later start can recover the suffix FROM, and
   * it used to be written a whole finalization after the answer: the assistant
   * row landed here, and core's claim landed after the signal settle, the
   * compaction bookkeeping and the run seal. A process killed anywhere in
   * between left a durable answer with no claim — and `resumeAll()` finds
   * CLAIMS, so it found nothing, and that turn's takes, branches, recording,
   * drain, trial and title were lost with nothing on disk saying they were owed.
   * The intent row written inside this transaction is what closes that window.
   *
   * The transaction is the raw handle's, because `rt.storage.sql` and this
   * session's `db` are the same connection — the runtime is built over it — so
   * the messages, the intent and nothing else commit or roll back together.
   *
   * Never throws. A failure here is a turn whose answer did not reach disk, and
   * the caller reports that as a turn that produced nothing.
   */
  private commitTurn(input: {
    readonly item: QueueItem;
    readonly event: string | undefined;
    readonly startedAt: number;
    readonly assistantText: string;
    readonly runError: string | null;
    readonly interrupted: boolean;
    /** The turn's inference history, for the shadow trial's recorded replay. */
    readonly trialContext: readonly ModelMessage[];
    /** The tool surface the turn could reach, for the advisor's snapshot. */
    readonly reachableTools: readonly string[];
    readonly overflowRetry: boolean;
  }): TurnCommit {
    const { item, runError } = input;
    try {
      // One durable row PER steer (not per drain): the walk-back fork pivot
      // matches individual user messages verbatim, exactly as surfaces and the
      // JSONL transcript recorded them. A turn the harness enqueued opens on a
      // `programmatic:`-prefixed row that also carries its provenance — the
      // stamped metadata is what states authorship at rest; the prefix only keys
      // the idempotency.
      const turnId = this.currentTurnId ?? crypto.randomUUID();
      // Minted HERE rather than inside `persist`, because the roster keys on it
      // and the roster is frozen before the write.
      const messageId = crypto.randomUUID();
      // The confirming turn is over: what the agent did with its free re-look
      // IS the gate's conversion number, and the run row carries it. Before the
      // roster, so the turn that ANSWERED a gate cannot be gated again.
      if (input.event === COMPLETION_GATE_EVENT) {
        this.completionGate.settle({ toolCalls: this.orch.acc.toolCalls.length });
      }
      const facts: RunEndFacts = {
        completed: runError === null,
        interrupted: input.interrupted,
        errorText: runError ?? undefined,
        // Unbounded here (runChat hands `stopWhen` straight to streamText), so
        // this reads 'stop' on a turn that finished by itself. Reported anyway:
        // a caller that does pass a real stop condition gets the same honest
        // 'truncated' seal the cloud loop gets, from the same classifier.
        lastFinishReason: this.orch.acc.lastFinishReason,
      };
      const status = classifyRunEnd(facts).reason;
      const turn = this.snapshotTurn(item, input.assistantText, messageId);
      const owed = this.owedTerminalEffects({
        turn,
        status,
        // Alternate Takes and steer branches were both captured mid-turn, before
        // this id existed, and both are attributed to it — one decision, made by
        // core (orchestrator/turn-lifecycle.ts `creditedTurnId`) rather than once
        // here and again in the cf backend's onChatResponse.
        credited: creditedTurnId({
          messageId, completed: runError === null, workMode: this.turnWorkMode,
        }),
        messageId,
        userText: item.text,
        assistantText: input.assistantText,
        completed: runError === null,
        interrupted: facts.interrupted,
        startedAt: input.startedAt,
        trialContext: input.trialContext,
        reachableTools: input.reachableTools,
        overflowRetry: input.overflowRetry,
      });
      // A response whose turn has no durable identity has nothing to claim
      // against, so it also has nothing to record an intent under: it runs
      // unledgered, and an intent keyed on an id no claim can use would be a
      // recovery that re-ran the sequence on every later start.
      const transition: TerminalTransition | null = this.currentTurnId === null
        ? null
        : { turnId, messageId };
      this.db.transaction(() => {
        this.persist(
          turnId,
          messageId,
          item.text,
          // The landed ledger, not `drainedTexts()`: same steers in the same
          // order, but each still carrying the id its queued/landed
          // announcements used and the step index it was spliced into — which is
          // what the durable row is stamped with.
          this.landedSteers,
          input.assistantText,
          item.kind === 'programmatic' ? item.metadata : undefined,
        );
        if (transition !== null) this.recordTerminalIntent(transition, owed);
      })();
      return { committed: { messageId, facts, turn, owed, transition } };
    } catch (cause) {
      // Classified AT the boundary that caught it rather than stored raw and
      // interpreted later: this is the only place that knows what it was doing.
      return {
        failure: toKinuError({
          doing: 'committing the finished turn and the roster its answer owes',
          cause,
          otherwise: 'io',
        }),
      };
    }
  }

  /** Freeze what this response owes beside the answer itself. */
  private recordTerminalIntent(
    transition: TerminalTransition, owed: readonly OwedEffect[],
  ): void {
    void this.rt.storage.sql`INSERT OR REPLACE INTO terminal_intents
      (message_id, turn_id, roster_json, recorded_at)
      VALUES (${transition.messageId}, ${transition.turnId},
              ${JSON.stringify(owed)}, ${Date.now()})`;
  }

  private clearTerminalIntent(messageId: string): void {
    void this.rt.storage.sql`DELETE FROM terminal_intents WHERE message_id = ${messageId}`;
  }

  // ── The terminal transition ───────────────────────────────────────────
  //
  // One settled response ends once, and everything it causes hangs off that
  // moment: the alternate-takes claim, the branch settlements, the completion
  // gate, the evolution recording, the reactor drain, the advisor lane, the
  // shadow trial and the auto title. The CLI used to run that sequence as
  // straight-line code and release its turn claims as soon as the transcript
  // was on disk, so a laptop killed anywhere inside it lost the whole suffix
  // with nothing to say what had already happened.
  //
  // Core owns all of that now — the vocabulary, the roster, the state machine,
  // the per-effect ledger and the replay. What follows is the only two things
  // this backend genuinely owns: the effect BODIES, and the WAKE.

  /**
   * What this turn owes, as core's own roster reads it.
   *
   * Every argument here is a VALUE this session read; not one of them is a
   * decision it makes. Which effects those values produce, in what order, on
   * which lane, keyed on what, and behind which gate is
   * `declareTerminalRoster` — so the CLI cannot answer "does a Plan turn feed
   * the improvement lanes?" differently from the Durable Object, which is
   * exactly how the two drifted while each spelled its own sequence out.
   */
  private owedTerminalEffects(input: {
    readonly turn: CompletedTurn;
    readonly status: RunEndReason;
    readonly credited: string | null;
    readonly messageId: string;
    readonly userText: string;
    readonly assistantText: string;
    readonly completed: boolean;
    /** Whether the turn was CUT rather than failing. A task child's caller is
     *  told which, because "interrupted" and "errored" are different answers to
     *  the question it is blocked on. */
    readonly interrupted: boolean;
    readonly startedAt: number;
    /** The turn's inference history, for the shadow trial's recorded replay. */
    readonly trialContext: readonly ModelMessage[];
    /** The tool surface the turn could reach, for the advisor's reachability
     *  check. A cold replay has no live toolset to ask. */
    readonly reachableTools: readonly string[];
    readonly overflowRetry: boolean;
  }): OwedEffect[] {
    const mission = readMission(this.rt.storage.sql);
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
    const sampled = this.autoEvolve ? shadowTrialPlan(this.scaffoldControl, input.messageId) : null;
    // The gate's decision belongs to the LIVE turn: `shouldGate` reads RAM the
    // gate keeps (armed, already fired) that a restart does not have, so the
    // answer travels as the row's existence rather than being asked again on
    // replay. Plan turns are not gated — a plan produces no state to check.
    const gated = this.rt.shell !== undefined
      && this.turnWorkMode !== 'plan'
      && this.completionGate.shouldGate({
        completed: input.completed, toolCalls: this.orch.acc.toolCalls.length,
      });
    const scoped = this.orch.scopedTurn(input.turn);
    // Every input the review's verdict reads, taken while the turn is still in
    // memory. Recorded rather than re-read on replay: the tool surface is
    // rebuilt per turn, the dedupe window moves with every later note, and the
    // severity floor is a config the owner can change between the turn and its
    // recovery, so a replay that re-derived them would grade this turn against
    // inputs it never had.
    const advisor: AdvisorRecoverySnapshot = {
      turn: scoped,
      // The turn's OWN ToolSet keys: what it demonstrably had, not what this
      // session can have. A capability the turn never carried must never be
      // named at it.
      reachable: [...input.reachableTools],
      minSeverity: this.config.getAdvisorMinSeverity(),
      recent: [...this.engine.recentAdvisorNotes()],
    };
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
      workMode: this.turnWorkMode,
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
      evolutionEnabled: this.autoEvolve,
    };
    const parts: Writable<TerminalTurnParts> = {};
    parts.takes = {
      credited: input.credited,
      startedAt: input.startedAt,
      // The takes this turn competed against, read HERE. A retry that
      // re-selected "whatever is unclaimed now" would claim — or purge — a
      // later turn's captures.
      takeIds: unclaimedAlternateTakeIds(this.rt.storage.sql),
    };
    parts.branches = this.pendingBranches.map(({ id, task }) => ({ id, task }));
    if (input.overflowRetry) parts.overflowRetry = true;
    if (gated) parts.completionGate = { text: this.completionGate.task };
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
        gateOpen: gated || this.completionGate.open,
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
    // The answer this child owes its parent. It used to be an untracked
    // fire-and-forget promise the HOST started off the `turn-end` event: a
    // process that died before the parent's ingress admitted it had nothing
    // recording that a retry was owed, and a task child's errored or
    // interrupted ending went out through a second, separate detached path.
    // Both are one claimed effect now. The sequence id is the parent's dedupe
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
      takes: terminalEffect({
        input: v.object({
          credited: v.nullable(v.string()), startedAt: v.number(),
          takeIds: v.array(v.string()),
        }),
        run: ({ credited, startedAt, takeIds }) => {
          if (credited === null) {
            // A turn the captures cannot be attributed to: they competed for an
            // answer that is not there, so the next turn must not claim them.
            purgeUnclaimedAlternateTakes(this.rt.storage.sql, takeIds);
          } else {
            claimAlternateTakesForTurn(this.rt.storage.sql, {
              turnId: credited, sessionId: this.sessionId, startedAt, takeIds,
            });
          }
          return { status: 'completed' };
        },
      }),

      branches: terminalEffect({
        input: v.object({
          id: v.string(), task: v.string(),
          turnId: v.nullable(v.string()), liveText: v.string(),
        }),
        // ONE branch, AWAITED. With no live handle — the branch head is a child
        // process that died with the previous one — the HEAD JOURNAL is the only
        // record of it, and the check is not "is the head still running": a head
        // reaches `completed` when its report lands, which is before any take set
        // exists. The row's own disposition is the settlement marker instead.
        //
        // ASKED FOR BY THE HEAD'S ID, which is `branchHeadId(id)` and not `id`:
        // the row this effect carries is the branch RUN, and a branch run's one
        // head is journalled under a DERIVED id (steer-branch.ts). Read by the run
        // id it found no row at all and reported that as `completed`, so every
        // restart between the report and the settle dropped the comparison.
        run: async ({ id, task, turnId, liveText }) => {
          const live = this.pendingBranches.findIndex((entry) => entry.id === id);
          if (live >= 0) {
            const [entry] = this.pendingBranches.splice(live, 1);
            if (entry !== undefined) {
              await settlePendingBranch(
                {
                  sql: this.rt.storage.sql,
                  sessionId: this.sessionId,
                  broadcast: (event: BranchStatusEvent) => this.broadcast(event),
                },
                // The branch id, on the LIVE path too. Keyed only on replay, the
                // live write and the recovery write would be two take sets.
                entry, turnId, liveText, id,
              );
              return { status: 'completed' };
            }
          }
          const head = this.headJournal.readHeadView(branchHeadId(id));
          if (head === null) {
            return { status: 'completed', detail: 'the journal holds no such branch head' };
          }
          const report = branchOutcomeFromJournal(head);
          if (report === null) {
            return { status: 'owed', detail: `branch head is ${head.status}` };
          }
          const outcome = settleBranchIntoTakes(this.rt.storage.sql, {
            task,
            report,
            turnId, sessionId: this.sessionId, liveText,
            settlementKey: id,
          });
          this.broadcast(outcome.ok
            ? {
              type: 'branch_status', status: 'settled', branchId: id, task,
              takeSetId: outcome.set.id, turnId: turnId ?? '',
            }
            : { type: 'branch_status', status: 'error', branchId: id, task, message: outcome.reason });
          return { status: 'completed', detail: outcome.ok ? undefined : outcome.reason };
        },
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
        // QueueItem is a RAM act: this effect used to report `completed` over it,
        // the ledger pruned the row, and a process that died before the pump
        // reached that item lost the confirmation permanently with nothing left
        // saying it was owed. The queue item carries a key derived from this
        // sequence, so the turn's own durable row is both the admission record
        // and the thing that stops a replay queueing a second confirmation.
        run: async ({ text }, scope) => {
          const identity = `${COMPLETION_GATE_EVENT}:${scope}`;
          // The confirming turn's OWN durable row, whose id `processTurn` derives
          // from the key this effect queues it under. Its presence is the
          // admission this row waits for.
          if (this.announcementOnDisk(identity)) {
            return { status: 'completed', detail: 'the confirming turn is on disk' };
          }
          // QUEUED OR RUNNING is not "not queued yet". A retry falling due while
          // the first confirming turn is still in the model finds no message row
          // and its queue item is already shifted out, so an unchecked enqueue
          // appends a second turn under the same key and the model and tool work
          // is done twice.
          if (this.announcementInFlight(identity)) {
            return { status: 'owed', detail: 'the confirming turn is queued and not yet on disk' };
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
          this.completionGate.fire();
          this.queue.push({
            text: completionGateText({ task: text, observed }),
            kind: 'programmatic',
            // This sequence's own name for the confirmation. `processTurn`
            // derives the durable message id from it, so a replay that reaches
            // here before the turn ran queues the same turn rather than a second
            // randomly-identified one.
            idempotencyKey: identity,
            metadata: { kinuEvent: COMPLETION_GATE_EVENT },
            // The gate fired for THIS process's one-shot turn; a driver that no
            // longer owns the conversation has nothing to confirm, and `fire()`
            // already recorded the gate so it does not re-ask.
            settle: () => {},
          });
          // Appended rather than unshifted, so anything already queued runs
          // first — it verifies FINAL state. The pump is a no-op while one is
          // running, which is the live case; on a startup replay there is no
          // pump yet, and without this kick the confirming turn would sit in the
          // queue until some unrelated message arrived. Arriving early cannot
          // change the advisor's verdict any more — the gate state the review is
          // judged against is recorded on the improvement-lanes row.
          this.pump();
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
          if (this.announcementOnDisk(identity)) {
            return { status: 'completed', detail: 'the retry turn is on disk' };
          }
          if (!this.announcementInFlight(identity)) {
            this.queue.push({
              text: OVERFLOW_RETRY_TEXT,
              kind: 'programmatic',
              idempotencyKey: identity,
              metadata: { kinuEvent: OVERFLOW_RETRY_EVENT },
              settle: () => {},
            });
            this.pump();
          }
          return { status: 'owed', detail: 'the retry turn is queued and not yet on disk' };
        },
      }),


      turn_record: terminalEffect({
        input: v.object({
          messageId: v.string(), status: RunEndReasonSchema, turn: JsonValueSchema,
          continuity: TurnContinuitySchema, workMode: WorkModeSchema, recordedAt: v.number(),
          autoEvolve: v.boolean(),
        }),
        // The window append is idempotent on the id this passes, which is the
        // assistant message's own durable identity. A replay therefore leaves ONE
        // window row and counts the session cadence once. The continuity comes
        // off the ROW, never off session state a fresh process would default.
        //
        // So does the EVOLUTION GATE. `recordTurn` otherwise reads the recovering
        // session's own gate, so a turn produced with auto-evolution on and
        // recovered under `--no-auto-evolve` (or after a Plan turn moved the
        // ambient gate) was marked completed with no window row, and a turn
        // produced under the flag was recorded by whichever later host had
        // evolution on.
        run: ({ messageId, status, turn, continuity, workMode, recordedAt, autoEvolve }) => {
          if (workMode === 'plan') {
            return { status: 'completed', detail: 'a plan turn records no evolution state' };
          }
          const recordedId = keyedScope(messageId);
          const recordOptions = recordedId === undefined
            ? { recordedAt, enabled: autoEvolve }
            : { recordedAt, enabled: autoEvolve, id: `turn-${recordedId}` };
          this.orch.recordTurn(
            this.orch.recordedTurn(status, v.parse(CompletedTurnSchema, turn)),
            continuity,
            recordOptions,
          );
          return autoEvolve
            ? { status: 'completed' }
            : { status: 'completed', detail: 'the turn was produced with auto-evolution off' };
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
          advisor: RecordedAdvisorSchema,
        }),
        // The verdict is core's one derivation, asked with the RECORDED mode so
        // a fresh session's default cannot open a lane the turn never earned.
        //
        // AWAITED TO ITS CHECKPOINT, not to its finish. The lane used to be
        // started and this row completed in the same breath, and the CLI's
        // startup recovery re-drove only `bg:*` fibers and DELETED every other
        // orphan — so a process killed inside the model call lost the review
        // while the completed row made a retry impossible. Resolving at the
        // checkpoint is what makes "the lane is recoverable" and "the row is
        // done" the same fact; the review itself still runs off the queue.
        run: async ({ status, workMode, advisor }) => {
          if (!this.orch.improvementLanesOpen(status, workMode)) {
            return { status: 'completed', detail: 'improvement lanes closed for this turn' };
          }
          await this.reviewTurnInBackground(advisor);
          return { status: 'completed' };
        },
      }),

      shadow_trial: terminalEffect({
        input: v.object({
          turn: JsonValueSchema, trialContext: JsonValueSchema, pendingVersion: v.number(),
        }),
        // Its OWN row, because its disposition is genuinely different from the
        // lanes it used to sit beside: a full queue is a refusal a later drain
        // clears, so the trial stays owed while nothing else waits on it.
        run: ({ turn, trialContext, pendingVersion }, scope) => {
          const trialScope = keyedScope(scope);
          const trialOptions = trialScope === undefined
            ? { pendingVersion }
            : { pendingVersion, id: `trial-${trialScope}` };
          const queued = this.engine.queueShadowTrial(
            v.parse(CompletedTurnSchema, turn), v.parse(ModelMessagesSchema, trialContext),
            trialOptions,
          );
          // A REFUSAL is not a deferral. `not_sampled` and `no_pending` mean
          // there is nothing to queue and never will be for this turn, so the
          // obligation is discharged; only a full queue or a failed insert is
          // worth coming back for, and both clear on their own. The same
          // mapping the Durable Object makes, because it is the same question.
          if (queued === 'queue_full' || queued === 'failed') {
            return { status: 'owed', detail: `the shadow trial for this turn is ${queued}` };
          }
          return queued === 'queued'
            ? { status: 'completed' }
            : { status: 'completed', detail: `no trial to queue: ${queued}` };
        },
      }),

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
        turnIsLive: (turnId) => this.pumping && this.currentTurnId === turnId,
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
    if (this.ended || this.terminalRetryAt <= atMs) return;
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
   * directory, its `kinu chat` argument — and telling a model that a workspace
   * is called `handwrought-walnut-4166c321` is what this replaces.
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
   * already run. The CLI called none of it, so a `kinu chat` workspace kept its
   * raw slug forever while the same workspace on cloud named itself.
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
        // A manual rename claimed the title while the model was thinking.
        // The owner's choice wins the race, and `false` says so to core.
        if (this.config.getNameOrigin() === 'user') return false;
        this.config.setDisplayNameOrigin(name, 'auto');
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
    if (this.rt.advisorLlm === undefined || !this.config.getAdvisorEnabled()) return;
    const laneKey = recorded.turn.turnId === undefined || recorded.turn.turnId === ''
      ? null
      : recorded.turn.turnId;
    if (laneKey !== null && effectAlreadyDone(this.rt.storage.sql, ADVISOR_LANE_SCOPE, laneKey)) return;
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
      if (laneKey !== null) recordEffectDone(this.rt.storage.sql, ADVISOR_LANE_SCOPE, laneKey);
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
    const llm = this.rt.advisorLlm;
    if (llm === undefined) return;
    const labels = recorded.turn.missionLabels ?? [];
    try {
      await runAdvisorLane({
        turn: recorded.turn,
        llm: labels.length === 0 ? llm : this.budget.govern(llm, labels),
        enabled: true,
        minSeverity: recorded.minSeverity,
        recent: recorded.recent,
        gateOpen: recorded.gateOpen,
        reachable: recorded.reachable,
        deliver: (signal) => this.orch.signals.deliver(signal),
        record: (note, turnId) => { this.engine.recordAdvisorNote(note, turnId); },
      });
    } catch (cause) {
      diagnostics.failure('advisor.review_failed', toKinuError({
        doing: 'reviewing the completed turn', cause, otherwise: 'unavailable',
      }));
    }
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
      sql: this.rt.storage.sql,
      config: this.config,
      surface: (task, context, callScope) => {
        const model = this.ensureModelState();
        return {
          llmStream: this.makeScaffoldLLMStream(model, this.tools),
          callTool: this.makeScaffoldCallTool(this.tools, callScope),
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
    const temporary = this.teamDeps?.temporary;
    let deps: RefinementDeps = {
      control: this.scaffoldControl,
      facts: this.factsStore,
      approvals: this.instructionApprovals,
    };
    if (temporary !== undefined) deps = { ...deps, refiner: temporary };
    return deps;
  }

  /** One step of the refinement lane plus the automatic trigger — driven by the
   *  off-turn cadence pass, exactly as on the cloud backend. */
  private async runRefinementLane(): Promise<void> {
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
      requests: createRefinementStore(this.rt.storage.sql).list(limit).map(refinementRequestView),
      debt: refinementDebt(this.refinementDeps),
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
      modelContext: {
        id: this.effectiveModelSpec(),
        contextWindow: this.sessionContextWindow(),
        modelOutputLimit: this.modelCatalog.modelOutputLimit(),
      },
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
   *  scaffold-host).
   *
   *  `callScope` is the rollout's durable identity, and it fixes BOTH halves of
   *  a tool-effect claim's key: the call ids become `<scope>#n` in dispatch
   *  order, and the surface those calls run on claims under the scope instead of
   *  under whatever turn is ambient. Either half alone leaves a replay claiming
   *  different work than the run it is repeating, which is how an interrupted
   *  queued trial sent the same mail twice. A rollout nothing re-drives (a live
   *  preview, a GEPA candidate) passes none and keeps the turn's own surface.
   *
   *  Built ONCE per rollout and closed over: the identity has to be stable
   *  across the whole rollout, not per call. */
  private makeScaffoldCallTool(
    turnTools: ToolSet, callScope?: string,
  ): NonNullable<ScaffoldRunOptions['callTool']> {
    if (callScope === undefined) return createScaffoldCallTool(() => turnTools);
    const scoped = this.rolloutTools(callScope);
    return createScaffoldCallTool(() => scoped, callScope);
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
  private dynamicContextSnapshot(memoryTail: string | undefined): DynamicContext {
    return collectDynamicContext({
      rt: this.rt,
      stores: this.stores,
      memoryTail,
      missingCapabilities: this.mcpUnavailable,
      subordinateDelegates: () => subordinateDelegatesOf(this.teamDeps?.snapshot() ?? []),
      approvals: () => {
        const items = this.pendingShellApproval === null ? [] : [this.pendingShellApproval];
        return { items, total: items.length };
      },
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
    const nodeHome = this.rt.nodeHome;
    const nodeRuntime = this.rt.nodeRuntime;
    return {
      rt: this.rt,
      model: this.cachedModel ?? this.defaultModel("an agents fork"),
      originContext: () => Object.freeze(structuredClone([...this.history])),
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
      // `agentHomeNodeProvisioner` is the ONE implementation that turns them into
      // one. So this site adapts the host to the seam rather than owning a second
      // provisioner. Built per swarm call and awaited per node, so a turn that never
      // searches never boots the workspace. A runtime built elsewhere
      // (`buildCLIHeadRuntime`, a bare AgentRuntime in a harness) holds no host, and
      // then its nodes report `shared-origin-plane` rather than a home they lack.
      provisionNodeHome: nodeHome === undefined
        ? undefined
        : () => agentHomeNodeProvisioner(nodeHome()),
      // The home is only real through a runtime that USES the credential: the
      // node's shell runs as its uid and its file tools write as the same uid,
      // over this same filesystem. Wired from the same runtime that supplied the
      // host, so the two halves cannot come from different workspaces.
      runtimeForNodeWorkspace: nodeRuntime === undefined
        ? undefined
        : () => nodeRuntime,
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

  /** Persist the exchange: the user row, any mid-turn steers, the assistant row.
   *
   *  `assistantId` is MINTED BY THE CALLER, because the roster the same
   *  transaction freezes keys on it — a turn cannot record what it owes under an
   *  id this method has not handed back yet.
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
    assistantId: string,
    userText: string,
    steers: ReadonlyArray<{ id: string; text: string; atStep: number }>,
    assistantText: string,
    metadata?: JsonObject,
  ): void {
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
      parseModelSpec(resolution.model).provider,
    );
    return providerOptions ? { model, providerOptions } : { model };
  }

  /** The profile a non-turn lane routes against. The PRECEDENCE is core's
   *  (`resolveRoutingProfile`), shared with the Cloudflare backend so the two
   *  cannot disagree about when a lane inherits the open turn; what is local is
   *  only where a fresh resolution comes from. Asked per call, never captured — a
   *  lane built at construction time must not pin the tier the account had then. */
  private async routingProfile(): Promise<ResolvedTurnProfile> {
    return resolveRoutingProfile({
      live: () => this.turnProfile,
      resolve: () => this.profiles().resolvePreTurn(),
    });
  }

  /**
   * Restore the session's durable transcript into live context on open.
   *
   * Bounded by what the model could ever be shown at once — the resolved
   * context window, LESS what is held back for the answer, since a restore that
   * fills the window leaves nothing to reply with and hands the compaction
   * ladder a request that is already over — rather than by a message count.
   * The count was 40, was
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
    const budget = stepContextLimit({
      contextWindow: this.sessionContextWindow(),
      modelOutputLimit: this.modelCatalog.modelOutputLimit(),
    });
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
   * build-mode only, so a Plan turn genuinely offers less.
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
   * any model is claimed, and every rebind after one. Two copies stood here,
   * and the second silently omitted `resolveModel`: the constructor's own
   * `ensureModelState()` rebuilds immediately, so `agents fork`'s per-fork
   * model was a no-op on this backend forever — a panel asked for three
   * vendors got three copies of one, which is exactly the defect
   * `createCLIHeadRuntime`'s own tests pin one layer down.
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
      // say in it. It used to be the SESSION'S CHAT MODEL at a hardcoded `'low'`
      // effort, filed as `judge` spend regardless — so the same split was
      // synthesised by the deep tier in the cloud and by whatever `/model` was
      // set to here, and the ledger could not tell the two apart.
      profile: () => this.routingProfile(),
      bindMergeModel: (route) => this.bindRouteModel(route),
      // No `spec` stamp: this sink carries the MERGE only (a head's own
      // inference is aggregated from `head_journal`), and the merge runs on the
      // routed judge tier rather than on this session's chat model. Stamping the
      // chat spec here was the label that made a deep-tier grading look like it
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
    };
    // Per-fork models only mean something where a resolver exists; a static
    // model session has one model and every fork inherits it.
    if (this.modelResolver) {
      const modelResolver = this.modelResolver;
      options.resolveModel = (spec) => modelResolver.resolveModel(spec);
    }
    return options;
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
        () => this.currentTurnId ?? WORKSPACE_RUN_ID,
      ));
      this.toolSets[mode] = { raw, wrapped: this.wrapToolsForBackground(raw) };
    }
    this.activateToolMode(this.turnWorkMode);
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
      // The once-only boundary for tools whose effects leave this process.
      effectClaims: { sql: this.rt.storage.sql, turnId },
      // No shellApprovalMode/requestShellApproval here — the gate lives at the
      // execution seam now (rt.shell / rt.executionRouter, wired once in
      // runtime.ts off agent_config live and the channel
      // `setShellApprovalHandler` installs below), not re-derived per toolset
      // build. See execution/approval.ts.
      //
      // The turn's cumulative bulk budget — held on the accumulator so this
      // toolset (rebuilt only on model change) reads the live turn's state.
      contextBudget: this.orch.acc.context,
      // Same ownership for the read-before-edit state and the per-edit outcome
      // counters the `file` tool writes.
      fileLedger: this.orch.acc.files,
      escalations: this.orch.acc.escalations,
      craftedToolExecute: createNodeCraftedExecute(),
      createExecuteTool: createNodeExecuteToolFactory({
        // Narrowed by the SAME set the native surface is narrowed by, so a role
        // cannot lose a tool natively and keep it through the sandbox. An
        // unresolved profile narrows nothing, which is the resolver's own rule
        // for a role that declares no tool list.
        extraProviders: narrowToolSurface(this.turnProfile?.allowedTools)
          .narrowProviders(this.codemodeProviders(mode)),
      }),
      codemodeLoader: { __cli: true },
      agents: this.agentsToolDeps(mode),
      roleAuthority: () => this.turnProfileInputs?.envelope ?? null,
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
    return buildActorTools(this.actorToolsetDeps(this.turnWorkMode, () => callScope));
  }

  private activateToolMode(mode: WorkMode): void {
    const surface = this.toolSets[mode];
    if (!surface) throw new Error(`tool surface for ${mode} mode is unavailable`);
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
