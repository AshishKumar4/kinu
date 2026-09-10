/**
 * OrchestratorAgent — the self-evolving top-level workspace DO.
 *
 * The actor-agnostic substrate (runtime assembly, BackendHost, the shared
 * AgentOrchestrator, turn pipeline, tool/model/prompt caches) lives in
 * ActorAgent (actor-agent.ts); this class is the workspace-facing actor on
 * top of it: owner claim + schema, the @callable RPC surface, evolution /
 * scaffold / GEPA / alternate-takes flows, onChatResponse sequencing, peer
 * teams, email + webhook ingress, release changes, and fork.
 *
 * Tool factory, system prompt, and crafted-tool injection all live in
 * @kinu.run/core so the CLI surface shares them verbatim.
 */

import { callable, type AgentContext } from "agents";
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from "./rpc-surface";
import {
  runExperienceAction, type ExperienceActionDeps, type ExperienceActionInput,
  type ExperienceEntry, type ExperienceKind, type PublishableCandidate,
  ArchiveCursorSchema,
  createWorkspaceForkSink, createWorkspaceForkSource, workspaceArchiveFiles, writeWorkspaceSoul,
  explorationActorKey, collectDynamicContext, subordinateDelegatesOf,
  createReportCodemodeProvider, HeadController, SubordinateRosterStore,
  recoverActorTurns, EventLog, actorReferenceOf,
  activePromptSectionOverrides,
  agentsActionsFor, agentsProfileContext, assignedTurnFraming, buildActorTools,
  BUILTIN_TOOL_NAMES, createTeamToolDeps, currentDateForPrompt, delegationExhausted,
  mintSubordinateName, withHeadCaptureRecording,
  type ActorHost, type ActorToolsetDeps, type AgentsSwarmDeps, type AgentsToolDeps,
  type AssignedTurnFraming, type BuiltinToolName,
  type BoundActor, type DynamicContext, type HeadInput,
  type HeadJournalPort, type HeadSplitRequest, type HeadSplitResult, type HostedActor,
  type LoopOrigin, type MergeResult, type NimbusSandboxHandle, type NodeHomeHost,
  type SqlExec, type SqlValue, type TeamToolDeps, type WorkspaceActor, type WriteObserver,
} from "@kinu.run/core";
import { createHostedWorkspace, type HostedWorkspace } from "./workspace-host";
import { nimbusPreviewUrl, WORKSPACE_PREVIEW_PATH } from "./nimbus-route";
import { SlateHost } from "./slates/host";
import { ROOT_SLATE_CALLER, type SlateCaller } from "./slates/bindings";
import {
  createWorkspaceActorHost, provisionHostedActorHome, type WorkspaceHostSeams,
} from "./actor-hosting";
import {
  hostNodeSeat, reclaimSettledExplorationActors,
  type ExplorationHostSeams,
} from "./exploration-hosting";
import {
  admitHostedTask, hostedDelegationBudget, hostedSubordinateRuntime, relayHostedReport,
  reportSettlesRun, runHostedTask,
  type HostedTaskProfile, type HostedTaskTurn, type SubordinateHostSeams,
} from "./subordinate-hosting";
import { createExecuteToolsFactory } from "./execute-tools";
import { codemodeEgress } from "./codemode-egress";
import type { ReportToolDeps } from "@kinu.run/core";
import type { ToolSet } from "ai";
import {
  webhookRoutePath, webhookRouteSecret, WEBHOOK_ROUTE_UNAVAILABLE,
} from "./events/webhook-route";
import { getSandbox } from "@cloudflare/sandbox";
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { SupervisorOpResult } from '@kinu.run/core/workspace';
import type {
  ActivitySnapshot,
  SubordinateRosterEntry,
  TabPresence,
} from "./lib/protocol";
import { teamPeers } from "./lib/workspace-roster";
import { nextAlarmTime } from "./lib/cron";
import type { ChatResponseResult } from "@cloudflare/think";
import {
  EvolutionEngine, initWorkspaceActorTable, WorkspaceActorDirectory, ChildActorOperationSchema, type ActorHandle, type ActorReference, type ChildActorOperation, type ActorDirectoryResult,
  readActivityLog,
  summarizeSteps,
  usageReported,
  // The whole workspace's spend, grouped by producer, with its own coverage
  // fraction — `summarizeSteps` above is this agent's own turns only.
  workspaceSpend,
  initWorkspaceSchema,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS,
  // The declared reach axis — getToolDescriptions reports it rather than
  // guessing native-vs-codemode from the assembled ToolSet's keys.
  TOOL_REACH,
  updateCraftScores,
  feedbackToQuality,
  // Fork feature
  forkWorkspace, ForkTargetWriter, ForkTransferReceiver,
  type ForkTransport, type ForkFrame,
  readWorkspaceArchivePage, type ArchiveCursor, type ArchivePage,
  nanoid, type HeadRunView,
  // Canonical memory-note write primitive
  appendMemoryNote,
  type SlateBindingRequest, type SlateCallResult, type SlateOperation, type SlateReadModel, SLATES_CHANGED_EVENT,
  // Scaffold loop closure (scaffold-driven inference + shadow rollout)
  type ScaffoldRunResult,
  // The scaffold evolution control plane (core owns the drivers; this actor
  // supplies the surface they run against).
  applyScaffoldDecision, getShadowStatus, listScaffoldVersions, shadowTrialPlan, trimTrialContext,
  previewScaffoldLive, proposeScaffold, runScaffoldCaptureText, runScaffoldGepaOptimization,
  advancePromptSectionLane,
  // Continual refinement — `/refine` opens a request; the lane that runs it
  // lives on the actor beside the other cadence passes.
  createRefinementStore, decideRefinementRoute, refinementDebt, refinementRequestView,
  requestRefinement, showRefinementRoute,
  type EvolutionDebt, type RefinementDecisionInput, type RefinementDecisionResult,
  type StagedSkillResult,
  type RefinementRequestView, type RefinementScope, type RequestRefinementInput,
  runScaffoldOnce,
  type GepaOptimizationResult, type ScaffoldDecisionResult,
  type ScaffoldVersionView, type ShadowStatus,
  getPendingScaffold,
  readScaffoldVersion, readShadowVerdict, type ShadowVerdict,
  type RunEvent, type RunEventQuery,
  // agent_facts world model
  AGENT_CONFIG_KEYS,
  // Voyager curriculum + Absolute Zero learnability proposer
  listProposedTasks, updateProposedTaskStatus,
  // Hybrid search (FTS5 + Vectorize via RRF)
  hybridSearch, memorySnippetRehydrator, type HybridHit,
  type CompletedTurn, type ToolCallRecord, type SettledSignals,
  type BackgroundJob, type AgentTaskTree, TriggerRegistry, ReplyChannelStore,
  type ReasoningEffort, type ShellApprovalMode,
  type AlarmScheduler, type ReplyDispatcher, type ReplyChannelRow,
  // GEPA run lineage (the pass itself is core's evolution control plane)
  listGepaRuns, loadGepaCandidates, loadGepaParetoFront, type GepaRunSummary,
  // Replay-eval loss curve (audit R3)
  listReplayEvals, type ReplayEvalSummary,
  // K_align — the correction-rate trend over the same outcome ledger
  alignmentConvergence, type AlignmentConvergence,
  calibrationReport, sampleForLabeling, ingestOutcomeLabels, DEFAULT_LABEL_BUDGET,
  type CalibrationReport, type LabelingItem, type LabelIngestResult, type OutcomeLabel,
  // The LLM panel that re-judges the same turns, and the bar it must clear
  ensembleReport, runEnsemble, createCompletionLLM,
  type EnsembleReport, type EnsembleRunResult,
  // Evolution Changelog — the self-change digest + revert dispatch
  revertChangelogEntryById,
  type ChangelogEntry, type ChangelogRevertResult,
  // Alternate Takes — near-tied convergence candidates + the pick signal
  claimAlternateTakesForTurn, purgeUnclaimedAlternateTakes, unclaimedAlternateTakeIds,
  listAlternateTakeSets, latestAlternateTakeSet,
  type AlternateTakeSet, type TakePickOutcome,
  // Steer-as-Branch — a mid-turn redirect run as a parallel head
  startBranchHead, settlePendingBranch, settleBranchIntoTakes, newBranchId,
  branchHeadId, branchOutcomeFromJournal, headStatusUnsettled, storedHeadReportStatus,
  STEER_BRANCH_RUN_ID_PREFIX,
  type PendingBranch, type BranchStatusEvent,
  type ReleaseStatus, type ReleaseToolDeps,
  // Release execution engine — the driver beneath the governance ledger
  ReleaseEngine, createSandboxReleaseExec,
  // Peer-agent teams (the agents tool's team deps contract)
  type PeersToolDeps, type PeerSpawnOutcome, type PeerSendOutcome,
  type EnqueueTurnResult,
  ROOT_DELEGATION_BUDGET, type DelegationBudget,
  readMission, summarizeSoul, writeSoul, workspaceGenesisSignal,
  // The durable answer an interrupted terminal transition still owes a reply
  // for — read from the transcript, because a recovery has no live turn.
  answersForDrainTurns,
  // Which titling SOURCE this root offers the shared policy. The policy itself
  // lives on ActorAgent.
  isPlaceholderMission,
  // The names its own prompt introduces this workspace by, and what it is
  // called before anything names it.
  type PromptIdentity, UNTITLED_WORKSPACE_NAME,
  // Device shadow-git checkpoints (forwarded to the pc-agent daemon)
  isDeviceNotConnectedError,
  isWorkspaceUnattachedError, WORKSPACE_HAS_NO_OWNER, isDeviceAmbiguityError,
  CommandResultSchema, ToolOutcomeSchema,
  type CheckpointAvailability, type FileCheckpointListing,
  type FileRestorePlan, type FileRestoreResult,
  // Shared turn lifecycle
  snapshotCompletedTurn, creditedTurnId, 
  runSleepTimeCompute, applySleepTimeUpdate,
  SleepTimeUpdateSchema, type SleepTimeUpdate,
  effectAlreadyDone, recordEffectDone,
  // Ingress — core owns the gates; this actor owns the transports in front
  // of them (the DO alarm, the Worker's webhook + email routes, cross-DO RPC).
  acceptWebhookDelivery, registerDurableWebhook, createWebhookSecretStore,
  acceptContainerEvent, type ContainerEventResult,
  initWebhookIngressTables,
  type WebhookDelivery, type WebhookDeliveryResult, type WebhookSecretStore,
  createTimerTrigger, cancelTrigger, listTriggers, fireDueTriggers, type TrustLevel,
  type TriggerView,
  EmailInbox, planOwnerNotification, readEmailAllowlist, setEmailAllowlist,
  type EmailAdmission, type IncomingEmail,
  PeerHub, type PeerMessage, type ReceiveResult,
  // ── Read models: the folds a surface asks for, one implementation each ──
  getAgentStatus, getToolList, readLatestSearchTree, readSearchTree,
  readSearchNodeDetail, type SearchNodeDetail,
  listForkRuns, type ForkRunSummary,
  readNodeTranscript, type NodeTranscriptView,
  readExplorationCanvas, readExplorationRun, type ExplorationCanvasRun,
  listRecordObjectives, listRecordCells, readRecordCell,
  type RecordObjectiveSummary, type RecordCellSummary,
  type RecordObjectiveHandle, type RecordCellHandle, type ExplorationRecord,
  type HeadStep,
  buildPendingActions, type PendingAction,
  type Page, type PageRequest,
  getRunTimeline, type TimelineSpan,
  getRunEvents, getRunSummaries, listRuns, type RunListEntry, type RunSummary,
  getWorkspaceDiff, getExecutorDiff, initWorkspaceBaselineTable, resetWorkspaceBaseline,
  type ExecutorDiffResult, type WorkspaceDiffResult,
  diffLines, type DiffLine,
  getExecutorFiles, readExecutorFile, listEnvironments,
  renameExecutorPathOp, deleteExecutorPathOp,
  ExecutorFileUpload, ExecutorFileDownload,
  type DirEntry, type ExecutorWriteResult,
  cancelBackgroundJob, clearBackgroundJobs, dismissBackgroundJob,
  jobResult, listBackgroundJobs, retryBackgroundJob, reconcileInterruptedForks,
  jobRedriveResumeGate, resumableForkRoots,
  type CancelWorkOutcome, type RetryOutcome,
  getAlwaysActiveSkills, getEvolutionConfig, getMctsConfig, getReasoningEffort,
  getShellApprovalMode, getShellApprovalGrants, revokeShellApprovalGrants,
  setAlwaysActiveSkills, setEvolutionConfig,
  setMctsConfig, setReasoningEffort, setShellApprovalMode,
  type EvolutionConfigView, type MctsConfigView,
  getEvolutionChangelog, getUnseenChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
  planReviewAwaitingDecision,
  JsonValueSchema, type JsonValue, type KinuEvent,
  // The one declaration of the event-variant set, and the one classifier that
  // names how a run ended. Both were hand-mirrored here.
  EVENT_VARIANTS, type RunEndReason,
  // The one bound an untrusted caller's event-log page passes through.
  boundEventQuery,
  type WorkMode,
  resolveModelRoute,
  WORKSPACE_RUN_ID,
  projectJsonValue,
  type AgentSignal,
} from "@kinu.run/core";
import * as v from 'valibot';
import {
  ActorAgent,
  TERMINAL_RETRY_CALLBACK,
  type ActorDynamicContextExtras,
  type ActorToolDeps,
} from "./actor-agent";
import { recordJobSettled, recordSandboxRecovery, type AgentKind } from "./analytics/record";
import { resolveEnsembleJudgeSelection } from "./providers/judge-model";
import {
  createAgentSelfProvider,
  createReleaseCodemodeProvider,
  DeviceConsentRegistry,
  type DeviceConsentAnswer, type DeviceConsentDecision,
  type DeviceConsentRequest, type PendingDeviceConsent,
  DeferredApprovalQueue, DeferredApprovalStore,
  type DeferredApproval, type DeferredApprovalAnswer, type DeferredApprovalChannel,
  type DeferredApprovalNotice, type ApprovalGrant,
  TURN_AUTHOR_METADATA_KEY,
  WorkspacePlanReferenceSchema,
} from "@kinu.run/core";
import type { CodemodeProvider, MctsSearchRunSummary, SubordinateInspectionRequest, SubordinateInspectionResult, WorkspacePlanReference } from "@kinu.run/core";
import { classify, diagnostics, KinuError, refusalOf, renderCauseChain, renderThrownChain, toKinuError, type Refusal } from "@kinu.run/core/obs";
import { createCloudWorkspaceForUser } from "./user/workspace-create";
import { deliverCloudFork } from "./user/workspace-fork";
import { agentEmailAddress } from "./email/inbound";
import {
  createEmailThreadDispatcher, dispatchEmailRepliesForTurn,
  sendInboundEmailReceipt, sendOwnerEmail,
} from "./email/outbound";
import { EmailOutbox } from "./email/outbox";
import {
  FIBER_RECOVERY_MAX_AGE_MS, SWEEP_MAX_ROWS, dispatchRecoveredNotice, type RecoveredNotice,
} from "./fiber-recovery";
import {
  acceptSandboxLifecycleFailure, initSandboxLifecycleTable,
  type SandboxLifecycleFailureResult,
} from "./sandbox-lifecycle";
import { SANDBOX_TRANSPORT } from "./sandbox-exec-lane";
import { sandboxIdForWorkspace, sandboxPreviewExposures } from "./lib/preview-exposures";
import {
  terminalEffect, keyedScope, declareTerminalRoster,
  type OwedEffect, type TerminalEffectTable, type TerminalTurnParts,
} from "@kinu.run/core";

const STALE_EVENT_DELIVERY_MS = 10 * 60 * 1000;

/**
 * Admitted delegations one sweep pass drives, per activation.
 *
 * A ROW BUDGET rather than the whole queue, for the reason every other pass in
 * this gate carries one: each item is a full inference turn, and a workspace
 * that accumulated a backlog while nothing was connected must not try to pay
 * for all of it in one alarm frame. A pass that fills its budget answers
 * truncated and the wake drains the remainder on the next frame.
 */
const HOSTED_DELEGATION_DRAIN_BUDGET = 8;

/** The tombstone scope recording that one turn's sleep-time fact update has been
 *  applied. The answer itself is kept in `sleep_time_updates`; this is the fact
 *  that it landed, and it survives that row being pruned. */
const SLEEP_TIME_APPLIED = 'sleep_time';

/** The tombstone scope recording that one cadence tick has advanced the
 *  prompt-section lane. It rides the same tick as the scaffold GEPA pass but is
 *  a separate obligation: replaying the tick for the pass must not rotate the
 *  section a second time. */
const PROMPT_SECTION_LANE = 'prompt_section_lane';

/** A turn's tool calls as the sleep-time lane replays them. Parsed rather than
 *  cast: the row was written by an earlier activation, and a shape that no
 *  longer matches must fail by name here rather than reach the judge. */
const ToolCallRecordsSchema = v.array(v.object({
  name: v.string(),
  args: v.record(v.string(), JsonValueSchema),
  result: v.optional(JsonValueSchema),
  outcome: v.optional(ToolOutcomeSchema),
}));

/** The one agents-SDK schedule row that carries every Kinu-owned wake
 *  (triggers, peer outbox, email outbox). Public because `Agent.schedule()`
 *  types the callback as `keyof this`, which excludes private members. */
const KINU_TIMER_CALLBACK = '_kinuTimerTick';

/** How overdue a one-shot schedule row must be before it is unrunnable rather
 *  than late: THE recovery budget, not a copy of it. Past it the framework
 *  stops recovering the fiber a continuation callback would resume, so
 *  dispatching the row can only replay dead work. The number is the value
 *  `ActorAgent.options` hands the framework (fiber-recovery.ts) rather than one
 *  hand-written here beside the words "mirrors the SDK's default", so the sweep
 *  and the framework cannot disagree about when a row is dead. */
/** The seal's own row budget, SMALLER than {@link SWEEP_MAX_ROWS} because its
 *  per-row cost is different in kind: every sealed head takes a durable report
 *  write and a broadcast, where the other sweeps take one DELETE. A pass that
 *  fills either budget arms the maintenance wake for the rest. */
const STALE_SCHEDULE_HORIZON_MS = FIBER_RECOVERY_MAX_AGE_MS;
const ORPHAN_SEAL_MAX_ROWS = 256;

// These windows bound the Activity response. Stored history remains append-only.
const ACTIVITY_STEP_WINDOW = 400;
const ACTIVITY_LOG_WINDOW = 200;

/**
 * Widest single stream one terminal row carries out of `executor_output`.
 *
 * 16 KiB is roughly 200 lines at 80 columns — deeper than any command output a
 * person reads in the pane, and three orders of magnitude below what the read
 * was actually answering with: 12.89 MiB across 36 rows on one production
 * workspace, measured 2026-08-20, five rows over 1.7 MiB each. The clip is
 * always declared, never silent — see {@link OrchestratorAgent.getExecutorOutput}.
 */
const EXECUTOR_OUTPUT_CLIP = 16 * 1024;

/** One clipped `executor_output` row. `stdout_len`/`stderr_len` are the STORED
 *  lengths, so a reader can tell a short command from a clipped one. */
interface ExecutorOutputRow {
  id: string; executor: string; command: string;
  stdout: string; stdout_len: number;
  stderr: string; stderr_len: number;
  exit_code: number; created_at: number;
}

const FileRestoreChangeSchema = v.object({
  path: v.string(),
  kind: v.picklist(['modify', 'create', 'delete']),
});
const FileCheckpointEntrySchema = v.object({
  id: v.string(), dir: v.string(), at: v.number(), turnId: v.nullable(v.string()),
  sessionId: v.nullable(v.string()), reason: v.string(),
});
const FileRestorePlanSchema = v.object({
  dir: v.string(), id: v.string(), files: v.array(FileRestoreChangeSchema),
});
const FileRestoreResultSchema = v.object({
  dir: v.string(), id: v.string(), files: v.array(FileRestoreChangeSchema),
  preRestoreId: v.nullable(v.string()),
});
const CheckpointAvailabilitySchema = v.object({
  available: v.boolean(), reason: v.optional(v.string()),
});
/** The route validator for `?variant=`, built FROM core's array rather than
 *  beside it. Hand-list the literals here and a new variant compiles in core and
 *  then silently fails validation on this route, because a picklist of strings
 *  cannot be checked against a union of strings. `EVENT_VARIANTS` is the one
 *  declaration and `EventVariant` derives from it, so the two cannot
 *  disagree. */
const EventVariantSchema = v.picklist(EVENT_VARIANTS);
/** One row of the events read: the log's row minus its own plumbing
 *  (`schema_version`, `dedupe_key`, `reply_channel`), which no operator surface
 *  shows. Derived from core's event so a field renamed there fails here rather
 *  than silently dropping out of the projection. */
export type RecentEventRow = Pick<
  KinuEvent,
  'id' | 'trace_id' | 'caused_by' | 'ingress' | 'variant' | 'trust' | 'priority'
  | 'payload_visibility' | 'payload' | 'received_at'
>;

/**
 * Every synthetic drain turn one settled turn answered, deduped.
 *
 * A drain reaches a turn two ways and the ids come back from two places: the
 * queued turn carries `drainTurnId` on its own metadata, a mid-turn splice
 * reports `replyTurnId` on the absorbed signal. A turn can hold both (a queued
 * drain that absorbed a second batch at a step boundary), and a re-delivered
 * signal can name an id the queued turn already carries — so the set, not two
 * loops, is what makes the settle exactly-once per delivery.
 */
function drainTurnsAnswered(
  drainTurnId: string | undefined,
  injected: SettledSignals,
): ReadonlySet<string> {
  const answered = new Set<string>();
  if (drainTurnId) answered.add(drainTurnId);
  for (const signal of injected.absorbed) {
    if (signal.replyTurnId) answered.add(signal.replyTurnId);
  }
  return answered;
}

/** A caller-supplied row limit, clamped to [1, max]. */
function clampLimit(requested: number | undefined, max: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return max;
  return Math.min(Math.max(Math.floor(requested), 1), max);
}

export class OrchestratorAgent extends ActorAgent {

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, ORCHESTRATOR_RPC_SURFACE);
  }

  /** The workspace's own top-level actor — the one a person talks to. */
  protected actorKind(): AgentKind {
    return 'orchestrator';
  }

  /** One workspace over this object's SQLite, shared across boot retries. */
  private _workspace: HostedWorkspace | undefined;

  private hostedWorkspace(): HostedWorkspace {
    this._workspace ??= createHostedWorkspace({
      ctx: this.ctx,
      env: this.env,
      previewUrl: (port, capability) => nimbusPreviewUrl(this.env, this.name, port, capability),
      onFilesChanged: (paths) => {
        const ids = this.slates.filesChanged(paths);
        if (ids.length !== 0) this.broadcast(JSON.stringify({ type: SLATES_CHANGED_EVENT, ids }));
      },
      refreshPreview: (port) => this.slates.refreshPreview(port),
      slateInvocation: (port) => this.slates.previewInvocation(port),
    });
    return this._workspace;
  }

  protected workspaceBox(shellId: string): NimbusSandboxHandle {
    return this.hostedWorkspace().box(shellId);
  }

  /** This workspace's own stores plus a client for the owner's library, every
   *  call of which crosses the UserDO capability gate. Absent until the
   *  workspace is claimed — there is no owner library to reach before that. */
  private getExperienceDeps(): ExperienceActionDeps | undefined {
    if (!this.getOwnerUserDO()) return undefined;
    return {
      rt: this.rt,
      facts: this.facts,
      library: {
        publish: (candidate: PublishableCandidate): Promise<ExperienceEntry> =>
          this.publishExperienceEntry(candidate),
        search: (options: { query?: string; kind?: ExperienceKind; limit?: number }): Promise<ExperienceEntry[]> =>
          this.searchExperienceLibrary(options),
        get: (id: string): Promise<ExperienceEntry | null> =>
          this.getExperienceEntry(id),
      },
    };
  }

  /** One owner-library publish through this activation's hub. A method rather
   *  than a closure so the stub call checks at method depth. */
  private async publishExperienceEntry(candidate: PublishableCandidate): Promise<ExperienceEntry> {
    const { stub, caller } = await this.userHub();
    return stub.publishExperience(caller, candidate);
  }

  /** One owner-library search through this activation's hub. */
  private async searchExperienceLibrary(
    options: { query?: string; kind?: ExperienceKind; limit?: number },
  ): Promise<ExperienceEntry[]> {
    const { stub, caller } = await this.userHub();
    return stub.searchExperience(caller, options);
  }

  /** One owner-library read through this activation's hub. */
  private async getExperienceEntry(id: string): Promise<ExperienceEntry | null> {
    const { stub, caller } = await this.userHub();
    return stub.getExperienceEntry(caller, id);
  }

  /**
   * The owner's experience library — publish / search / import, driven by the
   * owner rather than by the agent.
   *
   * It was a tool once. Sharing proven work between workspaces is a rare and
   * deliberate decision, and a tool costs the model attention on every turn it
   * is not the answer to, so the same dispatcher now sits behind this RPC for
   * the webUI to call. It runs on the workspace DO, not the UserDO, for a
   * reason the UserDO enforces: publishing happens under a workspace's own
   * name, and import stages into this workspace's ledger.
   */
  @callable()
  async experienceAction(input: ExperienceActionInput) {
    this.ensureSchema();
    const deps = this.getExperienceDeps();
    if (!deps) {
      return { error: 'This workspace has no owner yet, so there is no experience library to reach.' };
    }
    return runExperienceAction(deps, input);
  }

  /**
   * The one method a workspace host mounts for its facets.
   *
   * A facet runs in its own isolate and reaches the object that owns the
   * filesystem through the supervisor entrypoint, which resolves this object
   * out of the composed `OrchestratorAgent` namespace and calls this. The
   * envelope carries only an op name and arguments — the pid, the
   * append-writer incarnation and the mutation-lease owner are stamped by the
   * entrypoint from its own trusted props, never by the facet — so a process
   * can neither choose nor drop the credential its writes land under.
   *
   * Deliberately NOT `@callable`: like `workspaceBoxOp` below, this is how a
   * Durable Object in this Worker reaches the object that owns the
   * filesystem, and a browser socket that could reach it could ask for any
   * operation under any pid. `sealRpcSurface` keeps it on the stub transport
   * and off the public one.
   */
  async supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult> {
    return await this.hostedWorkspace().supervisorOp(envelope);
  }

  /**
   * One op against this workspace's box, for a facet of it.
   *
   * Deliberately NOT `@callable`: `NimbusExecOptions.cred` names a uid, so a
   * browser socket that could reach this could run a command as uid 0. The
   * caller is another Durable Object in this Worker — a subordinate, an
   * exploration head, a swarm node — and `sealRpcSurface` keeps it off the
   * public transport.
   */
  /**
   * Hosted actors receive the workspace's composed
   * `WorkspaceHostSeams.workspaceBox` handle and perform file, exec and port
   * operations in the root's isolate. The uid-bearing execution handle is not
   * exposed through an additional file-forwarding RPC surface.
   */

  /**
   * The three things a facet home is made of — the uid-0 view, the principal
   * registry and the uid table — all this object's own, so a home is applied
   * here exactly as the local backend applies one. A promise rather than a
   * value, so the workspace boots on the first provision and never at
   * activation.
   */
  private facetHomeHost(): Promise<NodeHomeHost> {
    return this.hostedWorkspace().bundle.privileged()
      .then((privileged) => ({ ...privileged, sql: this.ctx.storage.sql }));
  }


  private _actorHost: ActorHost | null = null;
  /** Loop origins a creation site NAMED, read back by the host at first
   *  acquire. In memory because a creation and its first acquire are one
   *  activation; a later acquire finds the pointer already durable and the
   *  host's seed short-circuits before it reads an origin at all. */
  private readonly _chosenLoopOrigins = new Map<string, LoopOrigin>();
  /**
   * Write observers a live RUN named, read back by the host when it builds that
   * actor's runtime.
   *
   * In memory and only in memory, and unlike the loop pointer beside it there
   * is nothing durable underneath: a `HeadFileChanges` is one run's own
   * accumulator, so an activation that lost it lost the run it belonged to as
   * well. An entry lives exactly as long as the run that registered it —
   * `hostHead` drops it in its `finally` — so a re-registered head cannot
   * inherit a previous run's changes.
   */
  private readonly _actorWriteObservers = new Map<string, WriteObserver>();

  /**
   * THE workspace's one actor host.
   *
   * One `createActorHost` over this object's own `sql`, `transactionSync` and
   * `exec` — there is no second `Storage` to pass, which is the property
   * open-38 exists to make structural rather than agreed. Every logical actor
   * comes from here: a hired subordinate, an ask-by-role temporary, a branching
   * head, a swarm node, an MCTS rollout branch.
   */
  protected actorHost(): ActorHost {
    this._actorHost ??= createWorkspaceActorHost(this.workspaceHostSeams());
    return this._actorHost;
  }

  protected actorDirectoryStore(): WorkspaceActorDirectory {
    return this.workspaceActors();
  }

  /**
   * Everything this workspace lends the actors it hosts.
   *
   * Read the two halves as different in kind, because they are: the immutable
   * catalogs (env, box, profile authority, provider registry, pricing) are
   * shared BY VALUE, while everything that accumulates per actor — event log,
   * evolution engine, mission governor, broadcast — is built per actor inside
   * `actor-hosting.ts` and is never this object's own. That split is what makes
   * "a delegated task admitted for a subordinate does not drain on the
   * workspace" true by construction rather than by convention.
   */
  /**
   * The ONE adapter between the platform's `SqlStorage` and core's positional
   * `SqlExec`.
   *
   * `SqlExec` is a two-line protocol — `exec(query, ...bindings)` returning
   * something with `toArray()` — and the DO's `SqlStorage` is the platform
   * object that happens to satisfy the call but not the type. Adapted at the
   * seam rather than by widening core's port, and in ONE place rather than at
   * each call site, so the two ports meet exactly once.
   */
  protected boundExec(): SqlExec {
    return { exec: (query: string, ...bindings: SqlValue[]) => this.ctx.storage.sql.exec(query, ...bindings) };
  }

  private workspaceHostSeams(): WorkspaceHostSeams {
    return {
      env: this.env,
      ctx: this.ctx,
      agent: this,
      exec: this.boundExec(),
      sql: this.boundSql,
      directory: this.workspaceActors(),
      workspaceName: this.workspaceName(),
      installedBuild: () => this.env.CF_VERSION_METADATA?.id ?? null,
      ownerUserId: () => this.getOwnerUserId(),
      capabilityToken: () => this.workspaceCapabilityToken(),
      workspaceBox: (shellId) => this.workspaceBox(shellId),
      homeHost: () => this.facetHomeHost(),
      // This object's own runtime, for an inheriting child registered under
      // main. The root's durable program is always readable because the root IS
      // this runtime; `loopFor` explains why hosting is the wrong question.
      rootRuntime: () => this.rt,
      // ONE authority for every hosted turn, and deliberately the same one an
      // actor chat resolves through: a role restriction that narrows a chat
      // narrows a head identically, and a search whose branches ran under a
      // profile this workspace never resolved is unreproducible, which is the
      // reason the digest exists at all.
      resolveProfile: (input) => this.hostedActorProfile(input),
      reportModelCall: (report) => { this.reportModelCall(report); },
      modelOperations: this.modelOperations,
      pricing: () => this.modelCatalog.pricing(),
      broadcast: (actorId, event) => {
        // Stamped with the actor, so a subordinate's pane and the workspace's
        // pane are never one stream on a shared socket.
        this.broadcast(JSON.stringify({ ...event, actorId }));
      },
      enqueueTurn: (actor, input) => this.enqueueHostedTurn(actor, input),
      turnInFlight: (actorId) => {
        const live = this.actorHost().hosted({
          actorId,
          workspaceId: this.actorHandle().workspaceId,
          parentActorId: this.actorHandle().actorId,
        });
        return live !== null && live.session.inFlight;
      },
      setTimer: (fn, ms) => { this.host.setTimer(fn, ms); },
      reconcileDurableWake: () => { this.durableWakeOwner()(); },
      headRuntimeFor: () => this.getCFHeadRuntime(),
      logActivity: (actorId, event, detail) => { this.logActivity(event, detail === undefined ? actorId : `${actorId} ${detail}`); },
      slate: (actor, operation) => this.slateAs(
        { path: [{ name: actor.name }], cred: ROOT_SLATE_CALLER.cred, workMode: 'build' }, operation,
      ),
      deferrals: () => this.deferralChannel(),
      refinementLane: () => () => this.runRefinementLane(),
      chosenLoopOrigin: (record: WorkspaceActor) => this._chosenLoopOrigins.get(record.actorId) ?? null,
      chosenWriteObserver: (record: WorkspaceActor) => this._actorWriteObservers.get(record.actorId) ?? null,
    };
  }

  /**
   * A programmatic turn for one hosted actor.
   *
   * The actor's OWN event log is the durable queue, so admission is a write
   * plus a drain on that actor's orchestration rather than a message pushed
   * into this object's transcript. That is the whole difference from the root's
   * own `enqueueTurn`, which goes through Think's message store because the
   * root's turns ARE that transcript.
   */
  private async enqueueHostedTurn(
    actor: BoundActor, input: Parameters<WorkspaceHostSeams['enqueueTurn']>[1],
  ): ReturnType<WorkspaceHostSeams['enqueueTurn']> {
    const admitted = await admitHostedTask(this.subordinateSeams(), actor.reference, {
      kind: 'message', body: input.text, mode: 'build',
    });
    return { status: admitted.admitted ? 'queued' : 'skipped' };
  }

  /** What an exploration runner needs of this workspace. */
  protected explorationSeams(): ExplorationHostSeams {
    return {
      host: this.actorHost(),
      register: async ({ creationId, kind, loop }) => {
        const entry = await this.actorDirectory({
          action: 'register', creationId, name: explorationActorKey(creationId), kind, lifetime: 'task',
        });
        if (loop) this._chosenLoopOrigins.set(entry.reference.actorId, loop);
        return entry.reference;
      },
      watchWrites: (reference, writes) => {
        this._actorWriteObservers.set(reference.actorId, writes);
        return () => { this._actorWriteObservers.delete(reference.actorId); };
      },
      // THIS actor's own role and tier, not the root's. The seam takes an
      // `actor` to say whose profile it wants; resolving the root's here is what
      // let a narrowed head run unrestricted.
      profile: (input) => this.hostedActorProfile({ ...input, actor: input.actor.handle }),
      resolveModel: (spec) => this.ownedModelServices.resolveModel(spec),
      webSearch: () => this.ownedModelServices.getWebSearchProvider(),
      // The host's OWN provisioner, not a second one: `provisionHostedActorHome`
      // is the single implementation `createWorkspaceActorHost` builds every
      // hosted runtime over, keyed on the actor's storage key. Reporting through
      // it is what makes the node's disclosed boundary and its real credential
      // the same fact.
      nodeHome: (actor) => provisionHostedActorHome(
        { homeHost: () => this.facetHomeHost(), directory: this.workspaceActors() },
        actor.record, actor.reference, 'head',
      ),
      executeTool: (runtime, webSearch) => {
        const factory = createExecuteToolsFactory({
          loader: this.env.LOADER, egress: codemodeEgress(), rt: runtime,
          sql: this.boundSql, workspace: this.workspaceName(), webSearch,
        });
        return (finished) => factory.toolFor(finished);
      },
      recordStep: async (headId, seq, step) => { await this.recordHeadStep(headId, seq, step); },
      publishDelta: (kind, delta) => { this.publishHeadStreamFrame({ headId: '', kind, delta }); },
      mission: (input) => {
        const labels = input.missionLabels ?? [];
        if (labels.length === 0) return null;
        // In-process now: the ledger is this object's, and a hosted head runs
        // in this isolate, so the guard/debit port is a pair of calls rather
        // than the cross-Durable-Object RPC a facet had to make.
        return {
          labels,
          port: {
            guard: (seam, scope) => this.missionGuard(seam, scope),
            debit: (tokens, opts) => this.missionDebit(tokens, opts),
          },
        };
      },
      // The splitting head's own actor and runtime are NOT needed here: the
      // journal and merge model belong to the workspace, and every child is
      // acquired by id from the same host. This keeps every subtree's journal
      // and step rows joinable in one database (C2).
      split: (_actor, _runtime, input) => (request) => this.runHostedSplit(input, request),
    };
  }

  /** What the subordinate rung needs of this workspace. */
  protected subordinateSeams(): SubordinateHostSeams {
    return {
      host: this.actorHost(),
      sql: this.boundSql,
      exec: this.boundExec(),
      directory: this.workspaceActors(),
      transaction: (body) => this.ctx.storage.transactionSync(body),
      roster: (actor) => new SubordinateRosterStore(this.ctx.storage.sql, actor.handle),
      vfs: () => this.rt.storage.vfs,
      // The HIRE's own role, not the root's. A delegated turn's prompt and
      // advertised tool surface are framed from this, so resolving the root's
      // told a `scribe` child it had the workspace's whole surface.
      profile: (input) => this.hostedActorProfile({ ...input, actor: input.actor.handle }),
      resolveModel: (spec) => this.ownedModelServices.resolveModel(spec),
      taskProfile: (turn) => this.hostedTaskProfile(turn),
      dynamic: (actor) => this.hostedActorDynamicContext(actor),
      mission: () => null,
      announce: () => { this.broadcastSubordinatesChanged(); },
      scheduleDrain: (actor) => { actor.session.orchestrator.scheduleDrain(); },
      temporary: () => this.temporaryAgentPort(),
    };
  }

  /**
   * The tool surface a hosted actor's DELEGATED turn admits.
   *
   * THE FULL-AGENT SURFACE, built by the SAME `buildActorTools` the workspace
   * root's own turns are built by, over THAT actor's runtime — so every file
   * and command it reaches acts as its own uid on both planes, its memory and
   * task rows are its own `actor_id`-scoped rows, and its delegation rungs
   * carry its own depth. A hire is a colleague with a role: docs/TOOLS.md and
   * AGENTS.md promise it the eight builtins gated by the deps this workspace
   * wires for it, and the confined head set gave it four — no `agents`, no
   * `memory`, no `tasks`, and not even the `report` lane the manifest declares
   * for exactly this root.
   *
   * What it does NOT get is `peers`: `hire scope=workspace` mints the root of a
   * fresh tree, so a subordinate holding the peer transport could leave its own
   * subtree in one call and the depth cap below would be decorative.
   *
   * `executeTools` rather than a pre-built entry: the sandbox declares every
   * other tool as `tools.<name>`, so it is built last over the finished surface
   * and keeps the clamp and the effect claim the registry declares for it.
   *
   * The whole surface is then wrapped so every call this turn makes lands in
   * the run's own capture, which is what puts a tool tally in the report when
   * the turn ends without closing prose. Core's rule for that wrapper is not to
   * apply it to a self-recording builder, and the two that record themselves —
   * the head accumulators — are not on this surface: a delegated turn reports
   * upward through `report`, it does not bank findings for a merge.
   */
  private async hostedTaskProfile(turn: HostedTaskTurn): Promise<HostedTaskProfile> {
    const webSearch = this.ownedModelServices.getWebSearchProvider();
    const factory = createExecuteToolsFactory({
      loader: this.env.LOADER, egress: codemodeEgress(), rt: turn.runtime,
      sql: this.boundSql, workspace: this.workspaceName(), webSearch,
      // `report.*` in the sandbox as well as at the top level, on the factory's
      // own provider seam — the same wiring the CLI gives the same capability.
      // A thunk, so it reads the ledger-writing closure declared below rather
      // than a copy of it taken at construction.
      extraProviders: () => [createReportCodemodeProvider(() => report)],
    });
    const report: ReportToolDeps = {
      report: async (input) => {
        const relayed = await relayHostedReport(this.subordinateSeams(), turn.actor, {
          status: input.status, content: input.content, origin: 'report_tool',
          mode: 'build', sequenceId: `live:${turn.actor.record.name}:${nanoid()}`,
          handoff: input.handoff,
        });
        turn.reports.spoke = true;
        // Only a run-SETTLING report counts as the answer. The same predicate
        // the ingress settles a waiter on, so the child cannot come to believe
        // it has answered while its caller is still waiting.
        turn.reports.settled ||= reportSettlesRun(input.status, 'report_tool');
        return { id: relayed.id, disposition: relayed.disposition };
      },
    };
    // NAMED, because both halves of the profile read it: the surface registers
    // the tool from these deps and the framing renders the rungs they gate.
    const agents = this.hostedAgentsToolDeps(turn);
    const deps: ActorToolsetDeps = {
      rt: turn.runtime,
      workMode: turn.input.mode,
      // Keyed on the TURN this surface was built for, because that is the id a
      // recovery re-admits: an effect claimed under a fresh id would replay on
      // the turn that is already holding it.
      effectClaims: {
        actor: turn.actor.handle,
        sql: turn.runtime.storage.sql,
        turnId: () => turn.input.id,
      },
      executeTools: ({ native }) => factory.toolFor(native),
      agents,
      // This actor's own semantic index and its own keyed world model — the
      // rows are `actor_id`-scoped, so a hire's `remember` cannot overwrite
      // what the workspace observed under the same words.
      vectorStore: turn.runtime.vectorStore,
      facts: turn.actor.stores.facts,
      webSearch,
    };
    // THE ASSIGNED TURN'S LANE, added after the surface's own fields for the
    // same reason the cli adds it after its own (`local-session.ts`'s
    // `reportGateOpen`): `report` belongs to a turn the PARENT drove, and an
    // owner chat with this actor must not carry it. The gate is satisfied at
    // the call site here — `runHostedTask` is the only caller and a delegated
    // task is by definition parent-driven — where the cli, whose surface is
    // cached across turns, has to re-ask per turn.
    deps.report = report;
    const tools = withHeadCaptureRecording(buildActorTools(deps), turn.capture);
    // FRAMED FROM THE SURFACE THAT WAS BUILT, not from a second idea of it: the
    // prompt's tool index and delegation rungs are rendered from these exact
    // names, and `report` among them is what makes core's `state/delegation`
    // section name this actor as a hire whose progress goes back to whoever
    // assigned the work.
    return { tools, framing: await this.hostedTaskFraming(turn, tools, agents) };
  }

  /**
   * WHAT A DELEGATED TURN IS TOLD IT IS: core's assigned-turn framing, over
   * this actor's own prompt surface.
   *
   * Every option is that actor's own fact, and each is the same value the
   * workspace's own turns pass for themselves: the workspace soul (its world
   * is this workspace), the executors ITS runtime routes to, the builtins
   * actually on the surface above, the rungs its deps gate, the role its
   * profile resolved, the sections its own evolution promoted, and its shown
   * name beside the workspace's. The turn-time reads a chat turn adds — the
   * AGENTS.md chain and the skill set, both of which are I/O and trust
   * classification — are deliberately not taken here: this path runs no turn
   * preamble, and a section rendered from bytes nobody classified is the one
   * thing the instruction-trust boundary exists to prevent.
   */
  private async hostedTaskFraming(
    turn: HostedTaskTurn, tools: ToolSet, agents: AgentsToolDeps,
  ): Promise<AssignedTurnFraming> {
    return assignedTurnFraming(turn.runtime, {
      brief: turn.input.task,
      surface: {
        soulOverride: this.getSoulText(),
        executors: turn.runtime.executionRouter?.listExecutors() ?? [],
        availableTools: Object.keys(tools).filter(
          (name): name is BuiltinToolName => BUILTIN_TOOL_NAMES.has(name),
        ),
        agentsActions: agentsActionsFor(agents),
        temporaryAsk: agents.team?.temporary !== undefined,
        backend: 'cf',
        workMode: turn.input.mode,
        roleSection: turn.profile.profile.role,
        model: { id: turn.profile.profile.tier.model },
        currentDate: currentDateForPrompt(),
        sectionOverrides: activePromptSectionOverrides(this.boundSql, turn.actor.handle),
        // Its own shown name beside the workspace's, which is what makes the
        // prompt address it as a named agent OF this workspace rather than as
        // the workspace's own chat.
        identity: {
          ...(await this.promptIdentity()),
          agent: turn.actor.stores.config.getDisplayName() ?? turn.actor.record.name,
        },
      },
    });
  }

  /**
   * The delegation deps ONE hosted actor's turn holds.
   *
   * Both rungs are that actor's own: the search substrate runs over its
   * runtime and its model, and the roster rung is bounded by ITS depth off the
   * directory row — at the cap the team deps are absent and hire/ask/send/list
   * /dismiss vanish from the enum, which is the recursion bound stated as
   * structure rather than as a refusal.
   */
  private hostedAgentsToolDeps(turn: HostedTaskTurn): AgentsToolDeps {
    const seams = this.explorationSeams();
    const swarm: AgentsSwarmDeps = {
      rt: turn.runtime,
      model: turn.model,
      resolveModel: (spec: string) => this.ownedModelServices.resolveModel(spec),
      // The same catalog session that answers the context window and prices the
      // mission ledger, so a search's estimate and the ledger that debits it
      // read one rate.
      costModel: () => ({
        spec: this.effectiveModelSpec(),
        pricing: this.modelCatalog.pricing(),
      }),
      // Each node's own actor, asked when the wave reaches it. Workspace-level
      // seams, because a node is an actor of the WORKSPACE whoever spawned it.
      hostNode: (node) => hostNodeSeat(seams, node),
      provisionNodeHome: () => async (node) => seams.nodeHome((await hostNodeSeat(seams, node)).actor),
      reportNodeDelta: () => (frame) => { this.publishHeadStreamFrame(frame); },
      announceHeadActivity: () => (headId) => { this.announceHeadActivity(headId); },
    };
    const deps: AgentsToolDeps = {
      mode: turn.input.mode,
      swarm,
      budget: this.budget,
    };
    // THIS turn's own resolution, not a second one: the rungs narrow by the
    // role and tier the claim recorded.
    deps.profile = () => agentsProfileContext(turn.profile.profile, turn.profile.inputs);
    const team = this.hostedTeamToolDeps(turn.actor);
    if (team !== null) deps.team = team;
    return deps;
  }

  /**
   * The roster rung one hosted actor holds over its OWN subtree, or null at the
   * delegation cap.
   *
   * Every part is that actor's: the rows it hires into, the child substrate
   * that registers them under it, and the depth the directory says it is at. A
   * rung built from the workspace root's roster would let a hire of a hire land
   * as a sibling of its own parent.
   *
   * No `temporary` port, and that absence is a boundary rather than an
   * oversight: the port holds live `run` promises and must outlive the turn
   * that parked them, and the one the report ingress resolves waiters through
   * is the HIRING actor's. So a hosted actor gets the two durable rungs — hire,
   * ask by name, send, list, dismiss — and no role-targeted temporary of its
   * own.
   */
  private hostedTeamToolDeps(actor: HostedActor): TeamToolDeps | null {
    const seams = this.subordinateSeams();
    const delegation = hostedDelegationBudget(seams, actor);
    if (delegationExhausted(delegation)) return null;
    const roster = seams.roster(actor);
    roster.ensureSchema();
    return createTeamToolDeps({
      delegation,
      roster,
      runtime: hostedSubordinateRuntime(seams, () => actor),
      now: () => Date.now(),
      // This actor's own transcript, capped — what a child it hires inherits.
      inheritedContext: () => this.readInheritedContext(actor.handle),
      // The WORKSPACE's purpose, which is the same fact for every actor in it:
      // an agent added here is here for what this workspace is for.
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
   * The live plane a hosted actor's delegated turn reports per step.
   *
   * Its OWN hires and its OWN search roster, from its own stores — not this
   * workspace's. `memoryTail` is absent and `missingCapabilities` empty, and
   * both are facts: a delegated turn's framing is its brief rather than
   * `MEMORY.md`, and a hosted actor connects no MCP servers of its own, so
   * there is no unreachable server to name.
   */
  private hostedActorDynamicContext(actor: HostedActor): DynamicContext {
    return collectDynamicContext({
      rt: actor.runtime,
      stores: actor.stores,
      memoryTail: undefined,
      missingCapabilities: [],
      subordinateDelegates: () => subordinateDelegatesOf(
        new SubordinateRosterStore(this.ctx.storage.sql, actor.handle).list(),
      ),
    });
  }

  /**
   * A head splitting further, run in this isolate.
   *
   * The journal is the WORKSPACE's, and that closes the C2 defect structurally
   * rather than by discipline: a depth-1 head writing its children's spawn and
   * report rows into its OWN SQLite while their step rows land on the root
   * leaves the surface's `head_journal` → `head_steps` join unable to match and
   * a depth-2 head unreadable from anywhere. One database means one journal, and
   * the port below is a set of local calls rather than four
   * cross-Durable-Object RPCs.
   */
  private async runHostedSplit(parent: HeadInput, request: HeadSplitRequest): Promise<HeadSplitResult> {
    const journal: HeadJournalPort = {
      recordSplit: async (rootId, rationale, spawnedAt) => { await this.headJournalRecordSplit(rootId, rationale, spawnedAt); },
      insertSpawn: async (childInput) => { await this.headJournalInsertSpawn(childInput); },
      recordReport: async (report) => { await this.headJournalRecordReport(report); },
      cacheMerge: async (rootId, result, strategy) => { await this.headJournalCacheMerge(rootId, result, strategy); },
    };
    const runtimeForSplit = this.getCFHeadRuntime();
    if (runtimeForSplit === undefined) {
      throw new KinuError('missing', 'This workspace has no owner, so a head cannot split further.');
    }
    const controller = new HeadController(runtimeForSplit, journal);
    const controllerInput: Parameters<HeadController['run']>[0] = {
      parentHeadId: parent.id,
      parentDepth: parent.depth,
      rootId: parent.rootId,
      inheritedContext: parent.inheritedContext,
      request: { rationale: request.rationale, heads: [...request.heads], mergeStrategy: request.mergeStrategy },
      parentBudget: parent.budget,
      mode: parent.mode,
      model: parent.model,
    };
    // A subtree charges the same mission its root does — otherwise a head
    // escapes its budget simply by splitting again.
    if (parent.missionLabels?.length) controllerInput.missionLabels = parent.missionLabels;
    const result: MergeResult = await controller.run(controllerInput);
    return {
      narrative: result.mergedNarrative,
      decisions: result.selectedDecisions,
      unresolvedQuestions: result.unresolvedQuestions,
      blindSpots: result.blindSpots,
      childHeadIds: result.headIds,
      headCount: result.costSummary.headCount,
    };
  }

  /**
   * A HOSTED ACTOR'S HOME IS NOT AN RPC.
   *
   * The uid table, the uid-0 view and the principal registry all live on THIS
   * object, and `confinePrincipal` has no RPC — so both halves of provisioning
   * are in this isolate: the host provisions each actor's home from those same
   * three members, keyed on the actor's immutable storage key, before it builds
   * that actor's runtime (`actor-hosting.ts` → `hostedActorAgentName`).
   * `facetHomeHost()` above is what it reaches them through.
   */

  /**
   * A preview request the edge authenticated, routed into this workspace's port
   * registry. Reached by RPC for ordinary requests and through `fetch` for a
   * WebSocket upgrade, which cannot cross an RPC boundary as a 101.
   */
  async routeWorkspacePreview(
    port: number, handle: string, request: Request, pathname: string,
  ): Promise<Response> {
    return await this.hostedWorkspace().routePreview(port, handle, request, pathname);
  }

  /**
   * A preview WebSocket upgrade. Partyserver owns `fetch` for the chat
   * transport, so this one path is answered before the base sees it — the label
   * that produced it was signature-checked at the edge and the capability handle
   * is checked again inside `routePreview`.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(`${WORKSPACE_PREVIEW_PATH}/`)) {
      const [port, handle, ...rest] = url.pathname.slice(WORKSPACE_PREVIEW_PATH.length + 1).split('/');
      const parsed = Number(port);
      if (!Number.isInteger(parsed) || !handle) {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      return await this.routeWorkspacePreview(parsed, handle, request, `/${rest.join('/')}`);
    }
    return await super.fetch(request);
  }

  protected override turnWorkMode(): WorkMode {
    const requested = super.turnWorkMode();
    const approvedHandoff = this._activeProgrammaticUserMessage !== null
      && this.turnUserMessageEvent(this._activeProgrammaticUserMessage) === 'plan_approved';
    return requested === 'build'
      && !approvedHandoff
      && planReviewAwaitingDecision(this.planReviews.getActive('default'))
      ? 'plan'
      : requested;
  }


  private async completeEventBatch(turnId: string, assistantText: string): Promise<boolean> {
    try {
      const replies = await dispatchEmailRepliesForTurn(
        { log: this.eventLog, replies: this.replyChannels },
        turnId, assistantText, Date.now(),
      );
      if (replies.pending) {
        diagnostics.event('event.reply_pending', { turnId });
        return false;
      }
      this.eventLog.markTurnCompleted(turnId);
      return true;
    } catch (err) {
      diagnostics.failure('event.reply_dispatch_failed', toKinuError({
        doing: 'dispatching the event replies a completed turn owes',
        cause: err,
        otherwise: 'unavailable',
      }), { turnId });
      return false;
    }
  }

  /**
   * Every open drain lease paired with the answer its turn already gave.
   *
   * Two durable reads and no new state: the leases come from the event log, the
   * answers from the persisted transcript (core's `answersForDrainTurns`, over
   * the pane store's own parent edge). Deliberately NOT `this.messages` — a
   * recovery may run on an activation that has hydrated nothing, and the
   * transcript is the authority either way.
   */
  private owedDrainReplies(): ReadonlyMap<string, string> {
    const leases = this.eventLog.openDrainLeases();
    return leases.length === 0
      ? new Map<string, string>()
      : answersForDrainTurns(this.boundSql, this.actorHandle(), leases);
  }

  /**
   * Does this workspace owe anything a wake has to finish?
   *
   * FIVE existence reads, one per store, because each predicate is its OWNER's
   * policy and not this method's: an open drain lease is a consumed `evt-%` row
   * in the event log, an owed transition is an unsettled claim in the terminal
   * ledger, an unfinished head includes the `interrupted` ones the resume gate
   * still owes, a headless swarm is a `running` row of the `swarm` engine, a
   * live job is a `running` registry row. One query over five tables would put
   * five schemas in this class and drift from all of them. Every read is
   * `LIMIT 1` and the `||` chain short-circuits, so the common case costs one
   * read and no case materializes a roster — this runs in the init gate.
   *
   * A PREDICATE, and that is the boundary the init ruling draws. What an open
   * lease MEANS — a question nobody answered, or an answer nobody delivered —
   * takes the transcript join in {@link owedDeliveryWork}, under the wake,
   * because every dispatch is external mail and an activation launches none.
   */
  protected owedWorkExists(): boolean {
    return this.eventLog.hasOpenDrainLease()
      || this.terminal.nextRetryAt() !== null || this.terminal.hasIncomplete()
      || this.headJournal.hasUnfinishedHeads() || this.mctsSearchStore.hasRunningSwarms()
      || this.jobs.hasLiveJobsInWorkspace() || this.workspaceActors().hasRetirements()
      || this.subordinateRoster.hasPendingBirths() || this.subordinateRoster.hasPendingDeletions()
      // An unsettled hosted claim, asked at limit 1 because presence is the
      // whole question. Without this the recovery arm of `maintenanceWork` is
      // unreachable on the one activation that needs it: a workspace whose ONLY
      // owed work is an interrupted hosted turn armed no wake, so nothing
      // dispatched the sweep that would have rebuilt it.
      || this.actorHost().resumable(1).length > 0
      // The same question for work ADMITTED but never started. `resumable`
      // covers claims; a delegated task that no turn has taken yet holds none.
      || this.hasAdmittedDelegations();
  }
  /**
   * Whether ANY actor in this workspace holds an admitted delegation nothing
   * has run yet — the arming half of the delegation drain.
   *
   * WORKSPACE-WIDE BY DESIGN, not by omission. This answers "does this OBJECT
   * need to wake", not "what does this actor own". The alarm belongs to the
   * workspace object and serves every actor in it, so scoping it to the root
   * would make the object sleep through a hired child's admitted task — the
   * same failure as the local daemon sleeping through a subordinate's due
   * trigger, which is why `nextTriggerAt` takes a bare database and
   * `hasLiveJobsInWorkspace`/`countRunningInWorkspace` are workspace-wide by
   * contract. Bounded at one row, exactly as `resumable(1)` beside it is:
   * presence is the whole question, and materializing the queue to answer it
   * would read every child's backlog on every activation.
   *
   * The predicate matches `EventLog.pending`'s own: unbound (`turn_id IS
   * NULL`) and neither deferred nor dismissed (`step_idx` -1 and -2), so the
   * wake arms exactly when the drain has something to take.
   */
  private hasAdmittedDelegations(): boolean {
    return this.boundExec().exec(
      `SELECT 1 FROM agent_log
       WHERE kind = 'event' AND variant = 'subordinate_task'
         AND turn_id IS NULL AND (step_idx IS NULL OR step_idx >= 0)
       LIMIT 1`,
    ).toArray().length > 0;
  }

  /**
   * ARM 2 OF THE ACTOR SWEEP: run the delegated turns this workspace admitted.
   *
   * A hired subordinate is a full actor whose work arrives as a row in its OWN
   * event log — `admitHostedTask` writes it and arms the wake, and that is all
   * admission may do: a turn run inside the admitting request would live
   * exactly as long as the caller's activation, which is a `waitUntil` shape
   * nothing here may take. So the runner is here, on the durable wake, where
   * nothing holds a request open.
   *
   * THE DOUBLE-EXECUTION GUARD IS `markConsumed` BEFORE THE `await`. It is
   * synchronous, so it is atomic with respect to the event loop: the row leaves
   * the pending set before this frame yields, and a concurrent or re-woken
   * sweep reading `pending()` cannot see it. Every other ordering runs the turn
   * twice — which for a delegated task means two answers to one `agents.ask`.
   *
   * A FAILED TURN LEAVES ITS LEASE OPEN, deliberately. `unbindStale` above
   * re-pends it once the grace has passed, so the work is retried on a later
   * frame rather than stranded; closing the lease on failure would drop the
   * task silently, and re-pending it immediately would spin. The grace is
   * non-zero because a Durable Object activation may be racing its own
   * predecessor, which is the case `unbindStale` requires callers to state.
   */
  private async drainAdmittedDelegations(): Promise<boolean> {
    const seams = this.subordinateSeams();
    const exec = this.boundExec();
    const now = Date.now();
    let budget = HOSTED_DELEGATION_DRAIN_BUDGET;
    let truncated = false;
    for (const record of this.workspaceActors().list()) {
      if (record.kind !== 'subordinate') continue;
      if (budget <= 0) { truncated = true; break; }
      const reference: ActorReference = {
        actorId: record.actorId, workspaceId: record.workspaceId, parentActorId: record.parentActorId,
      };
      try {
        // `bindStores` and not `acquire`: the enumeration needs this child's
        // handle over the one database and nothing else — no runtime, no
        // session, no model — and it still refuses a retired or re-parented
        // actor, so reading a child's queue is not a way around membership.
        const log = new EventLog(exec, this.actorHost().bindStores(reference).handle);
        log.unbindStale(STALE_EVENT_DELIVERY_MS, now);
        for (const event of log.pending({ variant: 'subordinate_task', limit: budget })) {
          if (budget <= 0) { truncated = true; break; }
          if (event.variant !== 'subordinate_task') continue;
          if (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact') continue;
          const turnId = `evt-${nanoid()}`;
          log.markConsumed(event.id, turnId, 0);
          budget -= 1;
          try {
            // The EVENT ID is the relay's dedupe key, and it is the right one:
            // it is stable across a re-delivery, so a report a recovered
            // sequence replays is recognised as the one the parent already
            // holds rather than counted as a second answer.
            await runHostedTask(seams, reference, {
              body: event.payload.body,
              mode: event.payload.kinu_mode,
              sequenceId: event.id,
            });
            log.markTurnCompleted(turnId);
          } catch (cause) {
            diagnostics.failure('subordinate.delegated_turn_failed', toKinuError({
              doing: 'running a delegated turn this workspace admitted', cause, otherwise: 'io',
            }), { workspace: this.name, actor: record.name });
          }
        }
      } catch (cause) {
        // One unreadable child must not end the sweep — the same per-actor
        // isolation core's recovery arm applies for the same reason.
        diagnostics.failure('subordinate.delegation_drain_failed', toKinuError({
          doing: 'reading a hired actor\'s admitted delegations', cause, otherwise: 'io',
        }), { workspace: this.name, actor: record.name });
      }
    }
    return truncated;
  }

  /**
   * Finish what one interrupted terminal transition still owes: the reply an
   * answered event batch never dispatched.
   *
   * This is the ONE effect of a settled turn that a later activation can
   * re-derive, and every input it needs is already durable — which is why no
   * new state was added to make the resume possible:
   *
   *   • WHICH batches are owed — the open recovery lease. `markConsumed` bound
   *     the rows to a synthetic `evt-*` turn and stamped `consumed_at`; the
   *     completion clears it. A lease still open is a delivery a turn was
   *     handed and never closed.
   *   • WHAT to reply with — the persisted assistant message of the turn that
   *     absorbed the batch, found through the `drainTurnId` its own user row
   *     carries.
   *   • WHETHER a resend is safe — the reply channel's outbox key. Each reply
   *     is keyed on its channel, so a re-drive puts the SAME Message-ID on the
   *     wire and the receiver (and Kinu's own inbound dedupe) treats it as the
   *     message it already has.
   *
   * A lease whose turn has no durable answer is left alone: nothing was
   * answered, so there is nothing to send, and `unbindStale` re-pends it to be
   * asked again. That ordering is why this runs BEFORE the unbind sweep — a
   * batch that WAS answered must have its reply finished rather than the
   * question asked a second time.
   *
   * Replies run before the base terminal replay so both ride the ONE durable
   * wake: an owed reply is an answer somebody is actively waiting on, and the
   * terminal replay's own resume closes the same leases when it finishes a
   * transition.
   */
  protected override async owedDeliveryWork(): Promise<void> {
    // The lease JOIN lives here, in the alarm frame — the activation only
    // proved existence. Sweep first with the answered set excluded, so a
    // question whose answer exists is finished below rather than re-asked;
    // then the replies; then the terminal replay, which closes the same
    // leases when it finishes a transition.
    let owed: ReadonlyMap<string, string> = new Map<string, string>();
    try {
      owed = this.owedDrainReplies();
      const reconciledEventIds = this.eventLog.unbindStale(
        STALE_EVENT_DELIVERY_MS, Date.now(), new Set(owed.keys()),
      );
      if (reconciledEventIds.length > 0) {
        diagnostics.event('event.deliveries_repended', { events: reconciledEventIds.length });
        this.orch.scheduleDrain();
      }
    } catch (err) {
      diagnostics.failure('event.stale_delivery_unbind_failed', toKinuError({
        doing: 'unbinding event deliveries a dead activation left leased',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    }
    // No catch: `completeEventBatch` answers false instead of throwing (its
    // own catch covers the dispatch and the completion write), so a catch
    // here could only fire for the announce line beside it.
    for (const [drainTurnId, answer] of owed) {
      const closed = await this.completeEventBatch(drainTurnId, answer);
      diagnostics.event('event.owed_reply_resumed', { drainTurnId, closed });
    }
    await super.owedDeliveryWork();
  }

  private _engine: EvolutionEngine | null = null;
  private _emailOutbox: EmailOutbox | null = null;
  /** Outbound-email intent log: write-ahead + idempotency for mission-inbox
   *  replies and owner notifications (SPEC §7.4). The shared outbox creates
   *  its own table on first use, so there is nothing to initialize here. */
  private get emailOutbox(): EmailOutbox {
    if (!this._emailOutbox) {
      this._emailOutbox = new EmailOutbox(this.ctx.storage.sql, (at) => this.armTimer(at));
    }
    return this._emailOutbox;
  }

  /** The orchestrator's own planes, as source callbacks the shared assembler
   *  reads per step — no second assembly to drift from the base class's.
   *
   * APPROVALS are both kinds of decision parked on the human in one roster: a
   * consent prompt someone may still answer in the next minutes, and a command
   * parked for hours. The second is also the structural reminder that its
   * effect has NOT happened — restated on every step until it is decided. */
  protected override extraDynamicContext(): ActorDynamicContextExtras {
    return {
      approvals: () => {
        const items = [...this._consents.approvals(), ...this.deferrals.approvals()];
        return { items, total: items.length };
      },
      extraMissingCapabilities: () => {
        const deafInbox = this.emailInbox.dropNotice(Date.now());
        return deafInbox ? [deafInbox] : [];
      },
    };
  }



  // Steer-as-Branch redirects launched against the in-flight turn — each runs
  // as one budgeted head (a facet in head mode) and settles into Alternate
  // Takes when the turn completes (onChatResponse).
  protected _pendingBranches: PendingBranch[] = [];

  private _triggerRegistry: TriggerRegistry | null = null;
  private _replyChannels: ReplyChannelStore | null = null;
  /** Per-activation guard so the full table-init DDL runs once, not on every
   *  onStart + claimOwner. Resets on DO eviction, so a cold start always
   *  re-creates any newly-added tables (no schema-version bookkeeping). */
  private _schemaReady = false;

  protected get triggerRegistry(): TriggerRegistry {
    if (!this._triggerRegistry) {
      const alarmScheduler: AlarmScheduler = {
        // Idempotent: pick the soonest of (existing alarm, new ts).
        scheduleAt: (ts: number) => this.armTimer(ts),
      };
      this._triggerRegistry = new TriggerRegistry(this.ctx.storage.sql, this.actorHandle(), alarmScheduler);
    }
    return this._triggerRegistry;
  }
  protected get replyChannels(): ReplyChannelStore {
    if (!this._replyChannels) {
      // ws_session dispatcher: push the reply back through Think's chat
      // broadcast. The reply() tool's content becomes a synthetic assistant
      // message visible to connected WS clients.
      const wsDispatcher: ReplyDispatcher = {
        dispatch: async (_channel: ReplyChannelRow, payload: JsonValue) => {
          try {
            const parsedText = v.safeParse(v.string(), payload);
            const parsedContent = v.safeParse(v.looseObject({ content: v.optional(JsonValueSchema) }), payload);
            const content = parsedContent.success ? parsedContent.output.content ?? payload : payload;
            const text = parsedText.success ? parsedText.output : JSON.stringify(content);
            const message = {
              id: nanoid(),
              role: 'assistant',
              parts: [{ type: 'text', text }],
            } as const;
            this.broadcast(JSON.stringify({
              type: 'cf_agent_chat_messages',
              messages: [...this.messages, message],
            }));
            return { delivered: true };
          } catch (err) {
            return { delivered: false, detail: renderThrownChain({ cause: err }) };
          }
        },
      };
      // email_thread dispatcher: a drained email turn's answer goes back onto
      // the inbound mail's thread via the send_email binding. Context resolves
      // per dispatch so binding/display-name changes never go stale.
      const emailDispatcher = createEmailThreadDispatcher(() => ({
        email: this.env.EMAIL,
        agentDisplayName: this.safeDisplayName(),
        outbox: this.emailOutbox,
      }));
      this._replyChannels = new ReplyChannelStore(this.ctx.storage.sql, this.actorHandle(), {
        ws_session: wsDispatcher,
        // peer_back: route the answer to a peer ask back over the outbox
        // transport. Lazily bound — PeerHub needs this store to construct.
        peer_back: {
          dispatch: (channel, payload) => this.peerHub.dispatchPeerBack(channel, payload),
        },
        email_thread: emailDispatcher,
      });
    }
    return this._replyChannels;
  }

  /** The From name on this workspace's outbound mail — never throws pre-schema.
   *
   *  An untitled workspace sends as the product, not as its slug. A person
   *  reading their inbox is the last place a Durable Object name belongs, and
   *  `handwrought-walnut-4166c321` in a From header is the same defect as it in
   *  the workspace bar. */
  private safeDisplayName(): string {
    try { return this.titleState().displayName || UNTITLED_WORKSPACE_NAME; }
    catch (error) {
      diagnostics.event('orchestrator.display_name_unreadable', { error: renderThrownChain({ cause: error }) });
      return UNTITLED_WORKSPACE_NAME;
    }
  }

  // ── Peer transport endpoint (agent teams) ────────────────────────────────
  // Sender: `outbox_peer` rows dispatched via DO RPC (inline + alarm retry).
  // Receiver: the receivePeerMessage cross-DO RPC below. The agents tool's
  // ask/send/reply actions ride this hub; spawn adds the create-agent path.
  private _peerHub: PeerHub | null = null;
  protected get peerHub(): PeerHub {
    if (!this._peerHub) {
      this._peerHub = new PeerHub({
        sql: this.ctx.storage.sql,
        log: this.eventLog,
        replyChannels: this.replyChannels,
        vfs: () => this.rt.storage.vfs,
        selfAgentName: () => this.name,
        selfUserId: () => {
          const userId = this.getOwnerUserId();
          if (!userId) throw new Error('Agent has no owner yet — peer messaging needs an owned agent.');
          return userId;
        },
        deliver: async (receiverAgentName, msg) => {
          const stub = this.env.OrchestratorAgent.get(
            this.env.OrchestratorAgent.idFromName(receiverAgentName),
          );
          return await stub.receivePeerMessage(msg);
        },
        isSameOwner: async (senderUserId) => senderUserId === this.getOwnerUserId(),
        hasGrant: async (senderAgentName, senderUserId) => {
          try {
            const { stub, caller } = await this.userHub();
            return await stub.hasPeerGrant(caller, senderAgentName, senderUserId);
          } catch (err) {
            diagnostics.failure('peer.grant_lookup_failed', toKinuError({
              doing: 'asking the owner UserDO whether a peer grant exists',
              cause: err,
              otherwise: 'unavailable',
            }), { sender: senderAgentName });
            return false;   // default deny on lookup failure
          }
        },
        scheduleDispatch: (at) => this.armTimer(at),
        onAdmitted: () => { this.orch.scheduleDrain(); },
      });
    }
    return this._peerHub;
  }

  /** Idempotent soonest-wins arm of Kinu's own wake-up, expressed as the
   *  agents-SDK schedule row `KINU_TIMER_CALLBACK`. A Durable Object has a
   *  single alarm slot and the SDK owns it (`_scheduleNextAlarm` deletes any
   *  alarm it does not recognise), so this must never call `setAlarm` itself.
   *
   *  The write-first collapse, the post-write read and the keeper rule are
   *  {@link ActorAgent.armWakeRow}'s — this chain and the terminal-retry chain
   *  ask the same question of the same registry, and the two answers must not
   *  be able to drift. What is this chain's own is the CALLBACK and the
   *  consumers: every one of them awaits this directly. There is no
   *  void-returning wrapper — one existed, handed the promise to
   *  `ctx.waitUntil`, and claimed the write "lands even if the caller's
   *  invocation ends first", which is false in a Durable Object, where
   *  `waitUntil` is a no-op (`do.wait_until.no_op`) and an in-flight promise is
   *  cancelled with no signal on reset or eviction
   *  (`do.background_task.cancelled_on_reset`). Awaiting inside the invocation
   *  is the only retention this object has: the output gate then holds the
   *  response until the schedule row commits, and a failure reaches the caller
   *  instead of a console line. */
  private armTimer(atMs: number): Promise<void> {
    return this.armWakeRow(KINU_TIMER_CALLBACK, atMs);
  }

  /**
   * Restore the wake row when durable work is waiting and no Kinu timer row
   * exists.
   *
   * Every Kinu wake rides ONE schedule row, so losing it strands triggers, peer
   * retries and email reconciliation together — and the only thing that re-arms
   * it is a new scheduling write, which a stranded workspace has no reason to
   * make. Platform redelivery does not cover this either: it is bounded, and a
   * row that was never written is not a delivery that can be retried.
   *
   * No new state records the loss, because none is needed: the row is DERIVED
   * from the same durable ledgers the tick re-arms from, through the same
   * reader, so this is that computation run at activation instead of at the end
   * of a tick. ANY Kinu timer row — due or future — counts as armed: a due row
   * is a wake the platform still owes, and `armTimer` is what decides whether
   * it is soon enough.
   */
  protected async reconcileTimerRow(): Promise<void> {
    const next = this.nextWakeAt(Date.now());
    if (next === null) return;
    const armed = (await this.listSchedules())
      .filter((row) => row.callback === KINU_TIMER_CALLBACK)
      .map((row) => row.time);
    if (armed.length === 0) {
      await this.armTimer(next);
      diagnostics.event('schedule.timer_reconciled', { at: next });
      return;
    }
    // A row already DUE is a wake the platform still owes: it runs at or before
    // now, so it covers anything due now and re-arming over it would add a
    // second row on every touch. What is new is the other direction — a row
    // still in the FUTURE, later than the wake this workspace actually owes. A
    // cron six hours out counting as armed leaves a reaction pending right now
    // waiting six hours for it. `armTimer` is soonest-wins and collapses, so
    // pulling it earlier still leaves exactly one row.
    if (Math.min(...armed) * 1000 <= next) return;
    await this.armTimer(next);
    diagnostics.event('schedule.timer_pulled_earlier', { at: next });
  }

  /** The next wake this workspace owes, over every durable source that can ask
   *  for one: timer triggers, the peer outbox, the email outbox, and the
   *  reactions already pending in the event log. ONE reader, because two of them
   *  existed and a fourth source wired into only one would be a workspace that
   *  wakes for it on the tick and never at activation.
   *
   *  The event log was exactly that missing fourth source. A pending reaction
   *  had only the in-memory drain debounce behind it, so an event admitted just
   *  before an eviction — or re-pended by a compensating signal — was durable,
   *  unreachable, and invisible to the activation reconcile that exists to
   *  notice a lost wake. `nextPendingDrainAt` is derived from the same rows the
   *  drain selects, so the two cannot disagree about what counts as work. */
  private nextWakeAt(now: number): number | null {
    return nextAlarmTime(
      now,
      this.triggerRegistry.list({ state: 'active' }).map((t) => t.next_fire_at),
      this.peerHub.nextRetryAt(),
      this.emailOutbox.nextRetryAt(),
      this.eventLog.nextPendingDrainAt(now),
    );
  }

  /**
   * Re-derive and arm the wake, because the durable work that needs one changed.
   *
   * The BackendHost seam core's `scheduleDrain` reaches (`reconcileDurableWake`),
   * and the one this actor offers it. `armTimer` is soonest-wins and collapses
   * onto a single row, so calling this on every ingress and every compensation
   * costs at most one early tick and never a second wake row.
   *
   * Distinct from {@link reconcileTimerRow}, which only heals a MISSING row at
   * activation: this one moves an existing wake earlier when new work is due
   * before it.
   */
  protected override durableWakeOwner(): () => void {
    return () => this.armDurableWake();
  }

  private armDurableWake(): void {
    const next = this.nextWakeAt(Date.now());
    if (next === null) return;
    this.detachOwned(async () => {
      try {
        await this.armTimer(next);
      } catch (cause) {
        diagnostics.failure('schedule.durable_wake_arm_failed', toKinuError({
          doing: 'arming the wake a pending reaction needs', cause, otherwise: 'io',
        }), { workspace: this.name });
      }
    });
  }

  /**
   * The orchestrator's own budgeted sweeps folded onto the base seam.
   *
   * EVERY pass RUNS — no short-circuit — because each owns a different table,
   * and all three are the same shape: synchronous, row-budgeted, fenced by the
   * construction cutoff, and idempotent. That is what makes this ONE seam the
   * init gate and the alarm frame can both run, rather than a list the gate
   * re-folds by hand and drifts from.
   */
  protected override maintenanceSweeps(): boolean {
    const branches = this.reconcileOrphanedBranches();
    const fibers = super.maintenanceSweeps();
    // A schedule sweep that THREW has not finished its work, so it answers
    // unfinished rather than failing the caller: the gate must complete, and
    // the wake's own capped backoff is what keeps a pass that cannot succeed
    // from becoming a one-second loop.
    let schedules = true;
    try {
      schedules = this.sweepUnrunnableSchedules();
    } catch (err) {
      diagnostics.failure('schedule.stale_sweep_failed', toKinuError({
        doing: 'sweeping unrunnable schedule rows',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    }
    return branches || fibers || schedules;
  }

  /**
   * A callback name this class still carries a member for.
   *
   * The framework dispatches `this[row.callback]`, so a row naming nothing on
   * this object is unrunnable by construction — no age makes it runnable and no
   * deploy brings the method back, because the code in one isolate is one
   * version. Membership rather than callability, because every arming call site
   * names a METHOD (`Agent.schedule` types its callback as `keyof this`), so a
   * same-named non-function property is not a row this class can produce.
   */
  private canDispatch(callback: string): boolean {
    return callback in this;
  }

  /** Drop schedule rows that came due so long ago that nothing downstream can
   *  still act on them — a chat-recovery continuation is only meaningful while
   *  its fiber is recoverable, and the SDK stops recovering fibers past
   *  `fiberRecoveryMaxAgeMs`. Dropping is safe rather than lossy because the
   *  continuation is DERIVED state: `_checkRunFibers`/`_checkFacetRunFibers`
   *  re-register it from the fiber snapshot on the same wake, after this runs.
   *  Recurring rows are left alone — `cron`/`interval` re-date themselves to
   *  the next fire after one catch-up run, so they cannot pile up. Running on
   *  every wake (rather than as a one-shot migration) keeps this a standing
   *  invariant: normally it matches nothing, and it stops any future backlog
   *  from stampeding one alarm cycle.
   *
   *  The Kinu wake is EXEMPT, however overdue. It is not a continuation whose
   *  moment passed: it is the chain itself, its work is state-driven (whatever
   *  is due when it finally runs), and it is the workspace's only wake — so
   *  dropping it stops triggers, peer retries and email reconciliation
   *  permanently, while running it late costs one immediate tick. This sweep
   *  runs BEFORE the SDK reads the due rows, which is exactly why the omission
   *  mattered: the row was deleted on the activation that would have run it. */
  private sweepUnrunnableSchedules(): boolean {
    const cutoffSec = Math.floor((Date.now() - STALE_SCHEDULE_HORIZON_MS) / 1000);
    // The terminal retry is exempt for the same reason the Kinu timer is: it is a
    // STATE-driven wake, not a dated one. Its obligation is whatever the ledger
    // still holds, and that does not expire — deleting an overdue row left owed
    // effects with no carrier, and for a facet's row the root cannot even read
    // the ledger it stranded.
    // LIMIT-bounded for the init gate: deletion is the cursor, and a pass that
    // filled its budget reports truncated so the caller arms the maintenance
    // wake — the remainder must not wait for the next eviction. Selected THEN
    // deleted (one synchronous frame, so nothing interleaves) because the
    // count decides truncation and must not depend on a driver's RETURNING
    // support.
    const rowidOf = (row: Record<string, SqlStorageValue>): number =>
      v.parse(v.object({ rowid: v.number() }), row).rowid;
    const doomed = new Set(this.ctx.storage.sql.exec(
      `SELECT rowid FROM cf_agents_schedules
        WHERE type IN ('delayed', 'scheduled') AND time <= ?
          AND callback NOT IN (?, ?)
        LIMIT ${SWEEP_MAX_ROWS}`,
      cutoffSec,
      KINU_TIMER_CALLBACK,
      TERMINAL_RETRY_CALLBACK,
    ).toArray().map(rowidOf));

    // THE SECOND CLASS, and it is not a matter of age or type. A row whose
    // callback is NOT a method of this class cannot run at any date: the
    // alarm loop logs `Callback <name> not found or is not a function` and moves
    // on WITHOUT deleting the row, so it re-reports on every wake for as long as
    // the object exists. Production carries exactly that shape — a snapshot
    // callback armed by a class whose method moved to another package — and no
    // horizon reaches it, because a `cron` or `interval` row re-dates itself
    // past the cutoff on every pass.
    //
    // Asked as DISTINCT callbacks first, which is a handful of identifiers
    // however many rows exist, so the dispatch check runs once per name rather
    // than once per row.
    const dead = this.ctx.storage.sql.exec(`SELECT DISTINCT callback FROM cf_agents_schedules`)
      .toArray()
      .map((row) => v.parse(v.object({ callback: v.string() }), row).callback)
      .filter((callback) => !this.canDispatch(callback));
    if (dead.length > 0 && doomed.size < SWEEP_MAX_ROWS) {
      const placeholders = dead.map(() => '?').join(', ');
      for (const rowid of this.ctx.storage.sql.exec(
        `SELECT rowid FROM cf_agents_schedules
          WHERE callback IN (${placeholders})
          LIMIT ${SWEEP_MAX_ROWS - doomed.size}`,
        ...dead,
      ).toArray().map(rowidOf)) doomed.add(rowid);
    }

    const rowids = [...doomed];
    if (rowids.length > 0) {
      this.ctx.storage.sql.exec(
        `DELETE FROM cf_agents_schedules WHERE rowid IN (${rowids.map(() => '?').join(', ')})`,
        ...rowids,
      );
    }
    const dropped = rowids.length;
    if (dropped > 0) {
      diagnostics.event('schedule.stale_rows_dropped', {
        dropped,
        horizonMs: STALE_SCHEDULE_HORIZON_MS,
        // Identifiers from this repository's own code, and the whole diagnosis
        // when a row outlives its method.
        unrunnableCallbacks: dead.join(','),
      });
    }
    return dropped >= SWEEP_MAX_ROWS;
  }

  protected get engine(): EvolutionEngine {
    if (!this._engine) {
      this._engine = new EvolutionEngine(this.rt, {
        enabled: true,
        // The grading pass's verdict row, craft scores, tombstone and
        // announcement as ONE unit. A synchronous run inside a Durable Object is
        // already atomic, so this is the honest identity — but answering through
        // the platform's own primitive keeps the group one unit whatever core
        // comes to put between its statements, exactly as the terminal claim
        // does.
        transaction: (body) => { this.ctx.storage.transactionSync(body); },
        // The turn review's own model calls debit the mission the reviewed turn
        // ran under — the same ledger, through the same seam, as the work it
        // reviews. Unbudgeted turns never reach it.
        governor: this.budget,
        // The same sink an agent-initiated agents(action:'swarm') uses — one
        // broadcast for every search this workspace runs (ActorAgent).
        onMctsProgress: (event) => this.onMctsProgress(event),
        // Replay-eval rollout: the LIVE scaffold with the real LLM + tool
        // bridges — the closest re-run of "what would the agent do today".
        replayTaskRunner: (task) => this.runScaffoldCaptureText(task),
        // The promotion gate's evidence is gathered on the cadence lane rather
        // than on the turn: a DO under keepAlive can afford a candidate
        // rollout, Think's TurnQueue cannot.
        ...this.shadowTrialPorts,
      });
      // Mission Inbox: the session-end changelog digest also goes to the
      // owner's inbox — the "what I changed about myself" email.
      this._engine.onEvent((event) => {
        if (event.type !== 'changelog_digest') return;
        this.emailOwnerNotification('Evolution changelog digest', event.message);
      });
    }
    return this._engine;
  }

  /** The hash of the token this workspace holds — not the secret, and not
   *  invertible, so it is safe for the owner's UserDO to ask for. It is what
   *  lets the one-shot backfill skip workspaces that already agree instead of
   *  rotating every token it touches. Worker-side DO RPC only. */
  async getWorkspaceCapabilityHash(): Promise<string | null> {
    return this.workspaceCapabilityHash();
  }


  /** The claimed owner, once read. A claim never changes hands mid-activation:
   *  a second user claiming throws, so a cached non-null answer cannot go
   *  stale. Null (unclaimed) is never cached — the next read must see a claim
   *  that lands later. Protected so a harness cold activation drops it with
   *  the other latches. */
  protected _ownerUserId: string | undefined;

  /** Read the owner userId from workspace_identity; '' (empty) means unclaimed. */
  protected getOwnerUserId(): string | null {
    if (this._ownerUserId !== undefined) return this._ownerUserId;
    const rows = this.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM workspace_identity LIMIT 1`;
    const owner = rows[0]?.owner_user_id;
    if (owner && owner !== '') this._ownerUserId = owner;
    return owner && owner !== '' ? owner : null;
  }

  private _actorDirectory: WorkspaceActorDirectory | null = null;
  private _rootActor: ActorHandle | null = null;

  private workspaceActors(): WorkspaceActorDirectory {
    if (this._actorDirectory) return this._actorDirectory;
    const owner = () => this.getOwnerUserId() ?? '';
    this._actorDirectory = new WorkspaceActorDirectory(this.boundSql, {
      workspaceId: this.ctx.id.toString(),
      get ownerUserId() { return owner(); },
    });
    return this._actorDirectory;
  }

  protected actorHandle(): ActorHandle {
    return this._rootActor ??= this.workspaceActors().main();
  }

  private readonly actorRetirementsInFlight = new Map<string, Promise<ActorDirectoryResult>>();

  async actorDirectory(operation: ChildActorOperation): Promise<ActorDirectoryResult> {
    const { actorId, workspaceId, parentActorId } = this.actorHandle();
    return this.runActorDirectory({ actorId, workspaceId, parentActorId }, [], operation);
  }

  async applyActorDirectory(caller: ActorReference, path: readonly string[], operation: ChildActorOperation): Promise<ActorDirectoryResult | Refusal> {
    try {
      return await this.runActorDirectory(caller, path, operation);
    } catch (cause) {
      return refusalOf(toKinuError({ doing: 'applying a root actor directory operation', cause, otherwise: 'io' }));
    }
  }

  private async runActorDirectory(caller: ActorReference, path: readonly string[], operation: ChildActorOperation): Promise<ActorDirectoryResult> {
    if (!this.getOwnerUserId()) throw new KinuError('missing', 'The workspace has no owner.');
    const parsed = v.safeParse(ChildActorOperationSchema, operation);
    if (!parsed.success) throw new KinuError('bad_input', 'Invalid child actor operation.');
    const input = parsed.output;
    const directory = this.workspaceActors();
    directory.validate(caller, path);
    if (input.action === 'release') throw new KinuError('denied', 'Only completed physical retirement can release an actor name.');
    if (input.action === 'cancelCreation') {
      const entry = directory.apply(caller, path, input);
      return this.runActorDirectory(caller, path, { action: 'retire', name: entry.name, reference: entry.reference });
    }
    if (input.action !== 'retire') return directory.apply(caller, path, input);
    const pending = this.actorRetirementsInFlight.get(input.reference.actorId);
    if (pending) {
      directory.apply(caller, path, input);
      return await pending;
    }
    const retirement = (async (): Promise<ActorDirectoryResult> => {
      const entry = directory.apply(caller, path, input);
      await this.scheduleTerminalRetry(Date.now());
      // The PHYSICAL half of a retirement is the host's, in one call: it drops
      // the actor's runtime objects, cuts its `actor_id`-scoped rows inside the
      // retirement transaction, and — only for a destroy — releases the bytes
      // outside SQL (its home on the session, its `.kinu/agents/<key>/`
      // subtree). ONE call, not a teardown apiece for the two things a facet
      // owned: there is no descendant facet database to destroy over the SDK's
      // facet tree, and no `facetHomeReleaser` standing apart from the host that
      // provisioned the home.
      await this.actorHost().retire(caller, {
        reference: input.reference, name: input.name, destroy: true,
      });
      return entry.state === 'deleted' ? entry : directory.apply(caller, path, { action: 'release', name: input.name, reference: input.reference });
    })();
    this.actorRetirementsInFlight.set(input.reference.actorId, retirement);
    try {
      return await retirement;
    } catch (cause) {
      throw toKinuError({ doing: 'retiring an actor and its physical storage', cause, otherwise: 'io' });
    } finally {
      if (this.actorRetirementsInFlight.get(input.reference.actorId) === retirement) this.actorRetirementsInFlight.delete(input.reference.actorId);
    }
  }

  private bootstrapWorkspaceActor(): void {
    this.ctx.storage.transactionSync(() => {
      const identity = this.sql<{ id: string }>`SELECT id FROM workspace_identity LIMIT 1`;
      if (identity.length === 0) {
        void this.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${this.ctx.id.toString()}, ${this.name}, ${Date.now()})`;
      }
      this.workspaceActors().createMain({ name: this.name });
      this.actorHandle();
    });
  }

  /**
   * Does this workspace host a chat-reachable actor under this LOGICAL name.
   *
   * The edge asks before it hands the request over, so a name this workspace
   * does not host is a 404/403 at the boundary rather than a refusal inside an
   * actor. It answers a REFUSAL or nothing — never a storage key, which is the
   * change: the old `resolveSubordinateClientKey` handed one back so
   * `server.ts` could substitute it into the SDK's `/sub/<class>/<key>` hop,
   * which put a physical key in a client-visible URL. There is no hop and no
   * rewrite; the root serves the actor itself.
   *
   * Still checks BOTH authorities, because they answer different questions: the
   * directory says the actor exists and belongs to this workspace, and the
   * roster says it is not dismissed. A dismissed subordinate keeps its rows
   * (an archive is readable) and must not keep its chat.
   */
  async resolveHostedActorRoute(name: string): Promise<{ ok: true } | Refusal> {
    try {
      if (!this.getOwnerUserId()) throw new KinuError('denied', 'The workspace has no owner.');
      const row = this.subordinateRoster.get(name);
      if (!row || row.status === 'dismissed' || !row.actorReference) throw new KinuError('missing', 'The actor is not available for client execution.');
      const actor = this.workspaceActors().apply(this.actorHandle(), [], { action: 'validate', name, reference: row.actorReference });
      if (actor.kind !== 'subordinate') throw new KinuError('denied', 'The roster name does not identify a chat-reachable actor.');
      return { ok: true };
    } catch (cause) {
      return refusalOf(toKinuError({ doing: 'resolving a hosted actor chat path', cause, otherwise: 'io' }));
    }
  }
  /** The agents tool's peer deps over the cross-workspace transport. Owner
   *  resolution is lazy inside each action (the toolset is cached across
   *  turns — including a pre-claim build — so deps must not capture owner
   *  state at construction). */
  private getPeersToolDeps(): PeersToolDeps {
    const requireOwner = () => {
      const userId = this.getOwnerUserId();
      if (!userId) throw new Error('Agent has no owner yet — peer messaging needs an owned agent.');
      return userId;
    };
    /** Same-owner roster check so a typo'd name errors clearly instead of
     *  materializing a fresh unowned DO that rejects the message. */
    const requirePeer = async (agent: string): Promise<void> => {
      requireOwner();
      if (agent === this.name) throw new Error('that is this agent — pick another peer (action:"list")');
      const { stub, caller } = await this.userHub();
      const known = await stub.hasWorkspace(caller, agent);
      if (!known) throw new Error(`unknown peer "${agent}" — list your team with action:"list"`);
    };
    return {
      listPeers: async () => {
        requireOwner();
        const { stub, caller } = await this.userHub();
        return teamPeers(this.name, await stub.listActiveWorkspaces(caller));
      },
      ask: async ({ agent, topic, message, mode, signal }) => {
        await requirePeer(agent);
        return this.peerHub.ask({ agent, userId: requireOwner(), topic, message, mode, signal });
      },
      send: async ({ agent, topic, message, mode }) => {
        await requirePeer(agent);
        return this.peerHub.send({ agent, userId: requireOwner(), topic, message, mode });
      },
      reply: async ({ eventId, message }) => this.peerHub.reply({ eventId, message }),
      spawnWorkspace: async ({ name, purpose, message, mode, signal }): Promise<PeerSpawnOutcome> => {
        const userId = requireOwner();
        const { stub: userDO, caller } = await this.userHub();
        let agentName = name;
        let created = false;
        if (!agentName || !(await userDO.hasWorkspace(caller, agentName))) {
          const workspaceInput = { name: agentName || undefined, purpose };
          const entry = await createCloudWorkspaceForUser(this.env, userId, userDO, caller, workspaceInput);
          agentName = entry.name;
          created = true;
        }
        const outcome = await this.peerHub.ask({
          agent: agentName, userId, topic: 'task', message, mode, signal,
        });
        return { agent: agentName, created, ...outcome };
      },
    };
  }

  /** release.* (tools/release-codemode.ts) is constructed once per DO
   *  lifetime along with execute_tools, so it cannot re-check ownership on
   *  every call the way a callable RPC does. An unclaimed workspace gets a
   *  deps object whose every method rejects with the same honest reason,
   *  rather than a namespace that silently vanished or crashed on first use. */
  private unclaimedReleaseDeps(): ReleaseToolDeps {
    const reject = async (): Promise<never> => {
      throw new Error('This agent has no owner yet, so there is no release lane to reach. Open it through the authenticated app or CLI first.');
    };
    return {
      board: reject, bindSource: reject, create: reject, update: reject,
      transition: reject, recordCheck: reject, requestApproval: reject, recordDeployment: reject,
    };
  }

  private getReleaseToolDeps(): ReleaseToolDeps | undefined {
    if (!this.getOwnerUserDO()) return undefined;
    const hub = () => this.userHub();
    return {
      board: async () => { const { stub, caller } = await hub(); return stub.getReleaseBoard(caller, this.name, 20); },
      bindSource: async (input) => { const { stub, caller } = await hub(); return stub.upsertReleaseSource(caller, input); },
      create: async (input) => { const { stub, caller } = await hub(); return stub.createReleaseChange(caller, this.name, input); },
      update: async (changeId, patch) => { const { stub, caller } = await hub(); return stub.updateReleaseChange(caller, changeId, patch); },
      transition: async (changeId, status) => { const { stub, caller } = await hub(); return stub.transitionReleaseChange(caller, changeId, status); },
      recordCheck: async (changeId, input) => { const { stub, caller } = await hub(); return stub.recordReleaseCheck(caller, changeId, input); },
      requestApproval: async (changeId, approvalType) => { const { stub, caller } = await hub(); return stub.requestReleaseApproval(caller, changeId, approvalType); },
      recordDeployment: async (changeId, input) => { const { stub, caller } = await hub(); return stub.recordReleaseDeployment(caller, changeId, input); },
      engine: this.getReleaseEngine(),
    };
  }

  private _releaseEngine: ReleaseEngine | null = null;
  /** The execution engine beneath the release ledger: apply/checks in
   *  the agent's sandbox container (raw exit codes), preview through the
   *  path-style preview proxy, deploy/rollback verified against real command
   *  output. Ledger writes go through the owner's UserDO so the engine's
   *  results land on the same governed board the UI reads. */
  private getReleaseEngine(): ReleaseEngine {
    if (this._releaseEngine) return this._releaseEngine;
    const handle = this.rt.sandboxHandle;
    const provider = this.rt.executionRouter?.getProvider('sandbox');
    const hub = () => this.userHub();
    this._releaseEngine = new ReleaseEngine({
      exec: handle && provider ? createSandboxReleaseExec(handle, provider) : null,
      signal: () => this.currentTurnSignal(),
      ledger: {
        detail: async (changeId) => { const { stub, caller } = await hub(); return stub.getReleaseDetail(caller, changeId); },
        update: async (changeId, patch) => { const { stub, caller } = await hub(); return stub.updateReleaseChange(caller, changeId, patch); },
        transition: async (changeId, to) => { const { stub, caller } = await hub(); return stub.transitionReleaseChange(caller, changeId, to); },
        recordCheck: async (changeId, input) => { const { stub, caller } = await hub(); return stub.recordReleaseCheck(caller, changeId, input); },
        recordDeployment: async (changeId, input) => { const { stub, caller } = await hub(); return stub.recordReleaseDeployment(caller, changeId, input); },
      },
      // A stored `github` credential (POST /api/user/credentials/github with a
      // bearer PAT) authorizes clone/push for github source bindings; absent →
      // the engine's honest add-a-credential error.
      gitHubAuth: async () => {
        const { stub, caller } = await this.userHub();
        const headers = await stub.getAuthHeaders(caller, 'github');
        return headers?.Authorization ?? null;
      },
    });
    return this._releaseEngine;
  }

  /** The actor profile (ActorAgent): the orchestrator wires the full
   *  user-facing tool surface — cross-workspace peers, cross-workspace
   *  experience transfer, and the release lane. */
  protected actorToolDeps(): ActorToolDeps {
    return {
      ...this.teamProfile(),
      releases: this.getReleaseToolDeps(),
      peers: this.getPeersToolDeps(),
      submitPlan: { submit: (edits) => this.submitPlanEdits(edits) },
    };
  }

  /** The root of the workspace's subordinate tree: depth 0, the whole cap below
   *  it. A constant and not a stored value — the orchestrator IS the root, so
   *  there is nothing an eviction could lose. */
  protected delegationBudget(): DelegationBudget {
    return ROOT_DELEGATION_BUDGET;
  }


  /** `agent.*` (self-steering) and `release.*` (the governed release lane —
   *  left the native surface; see tools/release-codemode.ts). Both read
   *  their deps lazily so a claimOwner mid-DO-lifetime lands without
   *  rebuilding execute_tools. */
  protected extraCodemodeProviders(): CodemodeProvider[] {
    return [
      createAgentSelfProvider(this),
      createReleaseCodemodeProvider(() => this.getReleaseToolDeps() ?? this.unclaimedReleaseDeps()),
    ];
  }

  /** Mission Inbox: owner notifications go out as email. */
  protected notifyOwner(subject: string, body: string): void {
    this.emailOwnerNotification(subject, body);
  }

  /** Worker calls this on every authenticated request before any other RPC.
   *  Claims the agent for `userId` if unclaimed; 403s on cross-user collision.
   *
   *  Defensive: claimOwner can fire BEFORE onStart() completes on a fresh DO
   *  activation (the agents SDK doesn't strictly guarantee onStart→RPC order).
   *  ensureSchema() creates all required tables so the SELECT/UPDATE never hits
   *  a missing table or column, and is flag-gated so onStart won't repeat it.
   */
  async claimOwner(userId: string): Promise<{ owner: string; capabilityHash: string | null }> {
    if (!userId) throw new Error('userId required');
    try {
      this.ensureSchema();
    } catch (err) {
      diagnostics.failure('workspace.schema_ensure_failed', toKinuError({
        doing: 'creating the workspace tables before an owner claim',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    }
    // The HASH, not a boolean: the owner's UserDO compares it against what it
    // has registered, so any disagreement — a workspace holding nothing, or one
    // holding a token the UserDO no longer knows — is repaired rather than
    // mistaken for "already provisioned".
    const capabilityHash = await this.workspaceCapabilityHash();
    const current = this.getOwnerUserId();
    if (current === null) {
      // Unclaimed — first touch. Ensure identity has the owner marker.
      const exists = this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`;
      if (exists.length === 0) {
        void this.sql`
          INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
          VALUES (${this.ctx.id.toString()}, ${this.name}, ${userId}, ${Date.now()})
        `;
        this.workspaceActors().createMain({ name: this.name });
      } else {
        this.actorHandle();
        void this.sql`UPDATE workspace_identity SET owner_user_id = ${userId}`;
      }
      this._ownerUserId = userId;
      this.invalidateModelCaches();
      await this.ensureOwnedScaffold();
      return { owner: userId, capabilityHash };
    }
    if (current !== userId) {
      throw new Error(`Agent owned by a different user (stored=${current.slice(0, 8)}…, caller=${userId.slice(0, 8)}…)`);
    }
    // No scaffold probe on this branch: it runs on EVERY authenticated
    // request, and a cold activation paid a Nimbus network round trip inside
    // it (claimOwner p90 1170ms / max 2456ms across 48h of production). The
    // first claim bootstraps; if that bootstrap was interrupted, the first
    // turn finishes it — beforeTurn awaits ensureOwnedScaffold before
    // anything reads the workspace files.
    return { owner: current, capabilityHash };
  }

  // The reactor (drain-then-stop) lives on the core AgentOrchestrator
  // (it binds selected pending events via markConsumed, then injects one
  // signal through the core delivery seam). Ingress paths use
  // the debounced `this.orch.scheduleDrain()`; the post-turn hook drains
  // immediately via `this.orch.drainPendingEvents()`.

  /**
   * The facts and parts THIS root's settled response owes, handed to core's one
   * declaration.
   *
   * Everything here is a READING — the accumulator's takes, this activation's
   * pending branches, the scaffold candidate, the mission — and every one of them
   * is taken NOW, before any effect runs, because the whole list is claimed up
   * front: an input only the previous effect could produce could not be recorded,
   * and would not survive an interruption between the two.
   *
   * Which readings become rows, in what order, on which lane and behind which
   * gate is core's {@link declareTerminalRoster}, because the workspace root, the
   * subordinate facet and the CLI must not answer those questions three ways.
   */
  private owedTerminalEffects(input: {
    readonly result: ChatResponseResult;
    readonly turnMode: WorkMode;
    readonly credited: string | null;
    readonly userText: string;
    readonly assistantText: string;
    readonly turn: CompletedTurn;
    readonly status: RunEndReason;
    readonly answeredDrains: ReadonlySet<string>;
    readonly overflowRetry: boolean;
    readonly outputContinuation: boolean;
  }): OwedEffect[] {
    const messageId = input.result.message.id;
    const completed = input.result.status === 'completed';
    // SCOPED once, here: the mission labels the turn ran under have to travel
    // with every recording, and a cold replay has no active governor scope.
    const scopedTurn = projectJsonValue({ value: this.orch.scopedTurn(input.turn) });
    const mission = readMission(this.boundSql);
    // Sampled only for a turn the promotion gate can learn from, and keyed on the
    // turn rather than rolled — `queueTurnShadowTrial` re-reads the pending
    // version on every call, so a replay would otherwise score this turn against
    // a candidate that was not under trial when it ran.
    const sampledVersion = completed && input.turnMode !== 'plan'
      ? shadowTrialPlan(this.scaffoldControl, messageId)
      : null;
    return declareTerminalRoster({
      messageId,
      status: input.status,
      workMode: input.turnMode,
      continuity: this._turnContinuity,
      completed,
      userText: input.userText,
      assistantText: input.assistantText,
      scopedTurn,
      recordedAt: Date.now(),
      evolutionEnabled: this._turnEvolutionEnabled,
    }, this.rosterParts(input, sampledVersion, mission));
  }

  /** The optional halves of this root's terminal roster, each present only when
   *  this turn earned it — the caller-side decision the roster's own type leaves
   *  to the backend that knows its lifetime. */
  private rosterParts(
    input: {
      readonly result: ChatResponseResult;
      readonly credited: string | null;
      readonly userText: string;
      readonly assistantText: string;
      readonly turn: CompletedTurn;
      readonly answeredDrains: ReadonlySet<string>;
      readonly overflowRetry: boolean;
      readonly outputContinuation: boolean;
    }, sampledVersion: number | null, mission: string | null,
  ): TerminalTurnParts {
    const parts: TerminalTurnParts = {
      turnEndExtensions: { message: projectJsonValue({ value: input.result.message }) },
      takes: {
        credited: input.credited,
        startedAt: this.acc.startedAt,
        takeIds: unclaimedAlternateTakeIds(this.boundSql, this.actorHandle()),
      },
      craftedToolsUsed: this.acc.craftedToolsUsed(),
      eventReplies: { answered: input.answeredDrains, requestId: input.result.requestId },
      branches: this._pendingBranches.map((branch) => ({ id: branch.id, task: branch.task })),
      overflowRetry: input.overflowRetry,
      outputContinuation: input.outputContinuation,
      advisor: projectJsonValue({ value: this.advisorSnapshotFor(this.orch.scopedTurn(input.turn)) }),
      sleepTime: { toolCalls: projectJsonValue({ value: this.acc.toolCalls }) },
      autoTitle: isPlaceholderMission(mission) || mission === null
        ? { subject: input.userText }
        : { subject: mission },
      autoGepa: true,
      shadowTrial: sampledVersion === null ? undefined : {
        pendingVersion: sampledVersion,
        // BOUNDED at declaration, not at the queue insert three effects later:
        // a recorded input is a SQLite row too, and one built from a
        // million-token turn fails its insert partway through a claimed
        // sequence, leaving a prefix recovery reads as the whole roster.
        trialContext: projectJsonValue({
          value: trimTrialContext(this._lastTurnOpts?.messages ?? []),
        }),
      },
    };
    return parts;
  }


  /**
   * The bodies of this root's terminal effects.
   *
   * EVERY ONE OF THEM IS REPLAYABLE, and that is a property each body has to
   * earn rather than a policy the ledger can grant. The earlier shape declared
   * two of them "indeterminate" and had the ledger refuse a pending row, which
   * meant an interruption BEFORE the effect ran permanently dropped the
   * extension turn-end, the completed-turn append, the session cadence and the
   * pending-event drain. So the compound spine is split into four separately
   * keyed boundaries, each idempotent at its own edge: a stable id on the window
   * append, a keyed extension emit, a drain that selects only unbound rows, and
   * a lane scheduler whose queues are durable.
   */
  protected override terminalEffectTable(): TerminalEffectTable {
    return {
      ...this.sharedTerminalEffects(),
      takes: terminalEffect({
        input: v.object({
          credited: v.nullable(v.string()), startedAt: v.number(),
          takeIds: v.array(v.string()),
        }),
        run: ({ credited, startedAt, takeIds }) => {
          if (credited === null) {
            // A turn the captures cannot be attributed to: they competed for an
            // answer that is not there, so the next turn must not claim them.
            purgeUnclaimedAlternateTakes(this.boundSql, this.actorHandle(), takeIds);
          } else {
            claimAlternateTakesForTurn(this.boundSql, this.actorHandle(), {
              turnId: credited, sessionId: 'default', startedAt, takeIds,
            });
          }
          return { status: 'completed' };
        },
      }),

      craft_usage: terminalEffect({
        input: v.object({ messageId: v.string(), toolNames: v.array(v.string()) }),
        run: ({ messageId, toolNames }) => {
          void this.sql`INSERT INTO turn_craft_usage (actor_id, message_id, tool_names, created_at)
                   VALUES (${this.actorHandle().actorId}, ${messageId}, ${JSON.stringify(toolNames)}, ${Date.now()})
                   ON CONFLICT(actor_id, message_id) DO UPDATE SET
                     tool_names = excluded.tool_names, created_at = excluded.created_at`;
          return { status: 'completed' };
        },
      }),

      event_reply: terminalEffect({
        input: v.object({
          drainTurnId: v.string(), answer: v.string(), requestId: v.string(),
        }),
        // Replayable because every send is keyed: the outbound-email intent log
        // stamps a deterministic Message-ID per reply channel, so a re-drive puts
        // the SAME message on the wire and the receiver treats it as the one it
        // already has. A batch whose channel is still open reports `owed` and
        // keeps both its lease and its row, which is what leaves it recoverable.
        run: async ({ drainTurnId, answer, requestId }) => {
          this._pendingDrainReplyTurns.set(requestId, drainTurnId);
          const closed = await this.completeEventBatch(drainTurnId, answer);
          if (!closed) return { status: 'owed', detail: 'a reply channel is still open' };
          if (this._pendingDrainReplyTurns.get(requestId) === drainTurnId) {
            this._pendingDrainReplyTurns.delete(requestId);
          }
          return { status: 'completed' };
        },
      }),

      branches: terminalEffect({
        input: v.object({
          id: v.string(), task: v.string(),
          turnId: v.nullable(v.string()), liveText: v.string(),
        }),
        // ONE branch, AWAITED. The earlier body called core's fire-and-forget
        // settle for the whole list and returned immediately, so the row could be
        // pruned while heads were still running.
        //
        // With no live handle the HEAD JOURNAL is the only record of the branch,
        // and what it holds is what the comparison needs. Crucially the check is
        // not "is the head still running": a head reaches `completed` when its
        // REPORT lands, which is before any take set exists, so treating
        // non-running as settled skipped precisely the report this effect still
        // owed. The row's own disposition is the settlement marker instead.
        //
        // ASKED FOR BY THE HEAD'S ID, which is `branchHeadId(id)` and not `id`:
        // the row this effect carries is the branch RUN, and a branch run's one
        // head is journalled under a DERIVED id (steer-branch.ts). Read by the
        // run id it found no row at all, reported that as `completed`, and every
        // eviction between the report and the settle silently dropped the
        // comparison — the exact case this effect exists for.
        run: async ({ id, task, turnId, liveText }) => {
          const live = this._pendingBranches.findIndex((entry) => entry.id === id);
          if (live >= 0) {
            const [entry] = this._pendingBranches.splice(live, 1);
            if (entry !== undefined) {
              await settlePendingBranch(
                {
                  sql: this.boundSql,
                  actor: this.actorHandle(),
                  sessionId: 'default',
                  broadcast: (event: BranchStatusEvent) => this.broadcastBranchStatus(event),
                },
                entry, turnId, liveText,
                // The branch id, on the LIVE path too. Keyed only on replay, the
                // live write and the recovery write would be two sets.
                id,
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
            // Still executing, or waiting for the activation sweep to write its
            // terminal status. Owed, so the row stays and the wake comes back.
            return { status: 'owed', detail: `branch head is ${head.status}` };
          }
          const outcome = settleBranchIntoTakes(this.boundSql, this.actorHandle(), {
            task,
            report,
            turnId, sessionId: 'default', liveText,
            // The branch id IS the settlement key. The row keeps a replay from
            // re-running the comparison; this keeps a crash BETWEEN the take-set
            // write and the row's disposition from writing a second set.
            settlementKey: id,
          });
          this.broadcastBranchStatus(outcome.ok
            ? {
              type: 'branch_status', status: 'settled', branchId: id, task,
              takeSetId: outcome.set.id, turnId: turnId ?? '',
            }
            : { type: 'branch_status', status: 'error', branchId: id, task, message: outcome.reason });
          return { status: 'completed', detail: outcome.ok ? undefined : outcome.reason };
        },
      }),

      // ── the settle spine, as four keyed boundaries ──────────────────────

      sleep_time: terminalEffect({
        input: v.object({
          task: v.string(), output: v.string(), toolCalls: JsonValueSchema,
        }),
        // NOT swallowed. Catching every import, model and write failure in
        // `runSleepTimeCompute` and resolving normally lets the row record
        // `completed` and be pruned even when no fact update ran. The throw
        // reaches the ledger, which keeps the row owed until the compute
        // actually finishes.
        run: async ({ task, output, toolCalls }, scope) => {
          // KEYED on the assistant message, and TOMBSTONED: the compute is a
          // model call whose result mutates the fact store, so the answer is
          // persisted before it is applied and the tombstone records that it was.
          const factKey = keyedScope(scope);
          if (factKey !== undefined && effectAlreadyDone(this.boundSql, this.actorHandle(), SLEEP_TIME_APPLIED, factKey)) {
            return { status: 'completed', detail: 'the fact update for this turn already landed' };
          }
          await this.runSleepTimeCompute(
            task, output, v.parse(ToolCallRecordsSchema, toolCalls), factKey,
          );
          return { status: 'completed' };
        },
      }),

      auto_title: terminalEffect({
        input: v.object({ subject: v.string() }),
        // Once-only at its own boundary: persisting an auto title stamps
        // `name_origin`, so a replay of a titled workspace changes nothing.
        run: async ({ subject }) => {
          const unreachable = await this.titlingRefusal();
          if (unreachable !== null) return { status: 'owed', detail: unreachable };
          await this.applyAutoTitle(subject);
          return { status: 'completed' };
        },
      }),

      auto_gepa: terminalEffect({
        input: v.object({}),
        // AWAITED. The earlier body returned before `advancePromptSections` and
        // `runScaffoldGepaOptimization` finished, so an eviction after that return
        // cancelled the model work with no pending row left to replay. The cadence
        // is a durable turn count, so a replay either finds the interval reached —
        // and is the run that was owed — or does nothing.
        run: async (_input, scope) => {
          await this.maybeRunAutoGepa(keyedScope(scope));
          return { status: 'completed' };
        },
      }),
    };
  }


  async onChatResponse(result: ChatResponseResult) {
    const turnMode = this.turnWorkMode();
    // The actor-generic settle spine lives on ActorAgent; everything after it
    // here is orchestrator sequencing (takes, branches, evolution, naming).
    const {
      drainTurnId, programmaticUserMessage, errorText, completed, injectedSignals,
      outputContinuation,
    } = this.settleTurnEvents(result);
    // The run is sealed here, and the name it was sealed with comes back rather
    // than being classified again below for the roster: one turn, one reading of
    // how it ended.
    const { overflowRecovery, end } =
      this.recordTurnTelemetry(result, { errorText, completed, programmaticUserMessage, workMode: turnMode });
    // The identity of THIS terminal sequence comes from the shared helper, so
    // the root and its facets key one response the same way.
    //
    // NOTHING FROM HERE TO `settle` MAY AWAIT. Think has already persisted the
    // assistant message, so an await before the claim exists is a window where a
    // durable answer has no incomplete transition and `resumeAll()` finds nothing
    // to replay — the whole suffix is simply lost. The response-to-model-message
    // conversion therefore sits inside the `turn_end_extensions` body, where the
    // claim already exists, and not here: here it is exactly that window.
    const transition = this.transitionFor(result);
    const { userText, assistantText } = this.turnTextParts(result, programmaticUserMessage);
    // Read for every status: an aborted turn carries a message too, and its
    // text and its user turn are what make it evidence.

    // The turn record, for every status. `hadError` comes off the accumulator's
    // per-step flag, and core's settle corrects it on the `'error'` arm — a turn
    // can throw outside the accumulator's view, and the driver's own verdict is
    // the better witness there.
    const turn: CompletedTurn = snapshotCompletedTurn(this.acc, {
      userMessage: userText,
      assistantResponse: assistantText,
      turnId: result.message.id,
      sessionId: 'default',
      origin: programmaticUserMessage || this.lastUserTurnIsProgrammatic() ? 'programmatic' : 'user',
    });
    // The same name the durable run carries — the classifier ran once, over the
    // facts the seal used (including the model's last word, which is the only
    // thing that separates a finished turn from one Think's stop condition cut).
    const status = end.reason;
    // Alternate Takes and steer branches were both captured mid-turn, before
    // this id existed, and both are attributed to it — one decision, made by
    // core (orchestrator/turn-lifecycle.ts `creditedTurnId`) rather than once
    // here and again in the CLI's runTurn.
    const credited = result.status === 'completed'
      ? creditedTurnId({ messageId: result.message.id, completed: true, workMode: turnMode })
      : null;
    // Core drives it from here: the in-process guard, the durable claim, the
    // roster, the run and the close are ONE state machine, and this backend
    // supplies only what it owns — the effect bodies above, and the fiber that
    // keeps the isolate alive for the detached tail.
    //
    // The roster is a THUNK because core calls it only on a first attempt. A
    // resumed response replays the rows it already claimed: re-declaring reads
    // live state that has moved on — a scaffold candidate that did not exist
    // when the turn ran, a config flag since flipped — and would append rows to
    // a sequence already under way.
    await this.terminal.settle({
      transition,
      declare: () => this.owedTerminalEffects({
        result, turnMode, credited, userText, assistantText, turn, status,
        // Mission Inbox: a drain reaches a turn two ways and the ids come back
        // from two places, so the SET is what makes the settle exactly-once per
        // delivery.
        overflowRetry: overflowRecovery?.enqueueRetry === true,
        outputContinuation,
        answeredDrains: drainTurnsAnswered(drainTurnId, injectedSignals),
      }),
      hold: (claimed, close) => { this.holdTerminalClose(claimed, close, result.requestId); },
    });
  }


  /** Background memory compression. Reads recent turn, updates agent_facts.
   *  Fire-and-forget; does not block TurnQueue. */
  private async runSleepTimeCompute(
    task: string, output: string, toolCalls: ToolCallRecord[], key?: string,
  ): Promise<void> {
    try {
      if (!this.config.getSleepTimeComputeEnabled()) return;
      // The RECORDED update, when this call is one a terminal effect owes. The
      // model call and the fact mutation are two steps, and an eviction between
      // them would otherwise mean a replay paid for another call and applied
      // each decay twice. Persisting the update first makes the replay apply the
      // SAME answer, and the tombstone below makes it apply it once.
      const stored = key === undefined ? undefined : this.recordedSleepTimeUpdate(key);
      const currentFacts = this.facts.all()
        .sort((a, b) => b.lastObservedAt - a.lastObservedAt)
        .map(f => ({ key: f.key, value: f.value, confidence: f.confidence }));
      const update = stored ?? await runSleepTimeCompute(this.rt.fastLlm ?? this.rt.llm, {
        task,
        output,
        toolCalls: toolCalls.map((call) => call.name),
        currentFacts,
      });
      // A null answer is a MALFORMED one — extraction or validation failed. A
      // model that genuinely wants no change returns empty arrays, so this is a
      // failure, and tombstoning it would report a fact update that never landed.
      if (update === null) {
        throw new KinuError('unavailable', 'the sleep-time compute returned no usable update');
      }
      if (key !== undefined && stored === undefined) this.persistSleepTimeUpdate(key, update);
      // ONE TRANSACTION over the fact writes and their tombstone. The update is
      // several upserts and several CUMULATIVE confidence decays, and none of them
      // is idempotent: an isolate termination after a prefix left the whole update
      // retryable, so a replay decayed a fact it had already decayed and took 0.4
      // of confidence off it instead of 0.2. Committed together, a replay either
      // reads the tombstone and applies nothing or finds no prefix to repeat.
      //
      // The body MUST NOT await — `transactionSync` commits when its synchronous
      // body returns, so an async one would commit at its first await and take the
      // atomicity with it. `applySleepTimeUpdate` is synchronous, which is what
      // makes this possible at all.
      const summary = this.ctx.storage.transactionSync(() => {
        const applied = applySleepTimeUpdate(this.facts, update);
        if (key !== undefined) {
          recordEffectDone(this.boundSql, this.actorHandle(), SLEEP_TIME_APPLIED, key);
          void this.sql`DELETE FROM sleep_time_updates WHERE effect_key = ${key}`;
        }
        return applied;
      });
      diagnostics.event('memory.facts_compressed', {
        upserted: summary.upserted,
        decayed: summary.decayed,
        skipped: summary.skipped,
      });
    } catch (err) {
      const failure = toKinuError({
        doing: 'compressing the turn into agent facts',
        cause: err,
        otherwise: 'unavailable',
      });
      diagnostics.failure('memory.fact_compression_failed', failure);
      // RETHROWN. Resolve normally and the terminal effect that drives this
      // records `completed` and is pruned even when no fact update landed, so
      // the advertised replay never sees a transient failure. The named event is
      // the evidence; the throw is what keeps the row owed.
      throw failure;
    }
  }

  /** The sleep-time answer a previous attempt already paid for, if it got that
   *  far. Stored under the effect key so a replay applies the same update rather
   *  than asking the model again. */
  private recordedSleepTimeUpdate(key: string): SleepTimeUpdate | undefined {
    const row = this.sql<{ update_json: string }>`
      SELECT update_json FROM sleep_time_updates WHERE effect_key = ${key}`[0];
    return row === undefined
      ? undefined
      : v.parse(SleepTimeUpdateSchema, JSON.parse(row.update_json));
  }

  private persistSleepTimeUpdate(key: string, update: SleepTimeUpdate): void {
    void this.sql`INSERT INTO sleep_time_updates (effect_key, update_json, created_at)
      VALUES (${key}, ${JSON.stringify(update)}, ${Date.now()})
      ON CONFLICT(effect_key) DO NOTHING`;
  }

  /** What this workspace is FOR. The titling source for the root itself, and
   *  what an additional agent the owner adds to it inherits. */
  protected ownMission(): string {
    return readMission(this.boundSql) ?? '';
  }

  /** UserDO is authoritative for a workspace's shown name, so an auto title
   *  commits through the same propagation an owner rename does — which is
   *  also where the "a manual rename claimed it first" refusal lives (in
   *  UserDO's `name_origin`, not a local copy of it). */
  protected async persistAutoTitle(displayName: string): Promise<boolean> {
    return (await this.setAutoDisplayName(displayName)).applied;
  }

  /**
   * The workspace title, cached PER ACTIVATION from the root registry. UserDO
   * owns the row; this actor holds no `actor_config` mirror — a mirror would
   * drift the moment another writer (the owner rename route, the generated-title
   * scheduler) commits to the root. Sync readers use whatever is hydrated;
   * every mutation path hydrates BEFORE deciding.
   */
  protected _titleCache: { displayName: string; nameOrigin: 'user' | 'auto' } | null = null;
  /** Whether the registry was read this activation. A null row (untitled) is
   *  an answer too — without this, every turn re-reads UserDO for a workspace
   *  nobody named. Failures leave it false so the next read retries. Protected
   *  so a harness cold activation drops it with the other latches. */
  protected _titleHydrated = false;
  private async hydrateTitle(): Promise<void> {
    if (!this.getOwnerUserId()) return;
    try {
      const { stub, caller } = await this.userHub();
      this._titleCache = await stub.getWorkspaceTitle(caller, this.name);
      this._titleHydrated = true;
    } catch (err) {
      diagnostics.failure('workspace.title_hydration_failed', toKinuError({
        doing: 'reading the root registry title for this workspace',
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: this.name });
    }
  }

  private titleState(): { displayName: string; nameOrigin: 'user' | 'auto' } {
    return this._titleCache ?? { displayName: this.name, nameOrigin: 'auto' as const };
  }

  /**
   * Hydrate the naming state BEFORE the title policy decides anything.
   *
   * `titleInputs` is synchronous by contract, so a cold activation answers it
   * from the placeholder cache — and a durable auto-title replayed on that
   * activation would plan over a title its first attempt had already persisted,
   * pay for another suggestion, and overwrite it. The root overrides the hook so
   * the decision is made against the registry that owns the answer.
   */
  protected override async hydrateTitleInputs(): Promise<void> {
    // THROWING, unlike the opportunistic `hydrateTitle`. A durable title effect
    // that planned from the cold placeholder cache would pay for another
    // suggestion and overwrite a title its own first attempt had persisted; the
    // failure keeps the row owed until the authoritative read works. Reached only
    // once `titlingRefusal` has established the read can be made at all.
    const { stub, caller } = await this.userHub();
    this._titleCache = await stub.getWorkspaceTitle(caller, this.name);
    this._titleHydrated = true;
  }

  /**
   * UserDO owns this root's title, so a root that cannot reach UserDO cannot
   * title itself yet.
   *
   * Without an owner or a capability there is no registry row to read or write.
   * A `completed` here would report a title that only the activation cache holds
   * — lost on the next cold start — so the row stays OWED with the reason on it,
   * and the activation that finds the workspace claimed is the one that titles it.
   */
  protected override async titlingRefusal(): Promise<string | null> {
    if (!this.getOwnerUserId()) return 'this workspace has no owner to hold its title';
    if (!this.workspaceCapabilityToken()) {
      return 'this workspace holds no capability token, so its title registry is unreachable';
    }
    return null;
  }

  /** The root decides against UserDO's naming state, not its own config. */
  protected override titleInputs() {
    const state = this.titleState();
    return { displayName: state.displayName === this.name ? null : state.displayName, nameOrigin: state.nameOrigin };
  }

  /**
   * What a person calls this workspace, or null while nobody has named it.
   *
   * Public because this workspace's own subagents read it: their prompts name
   * the workspace they work in, and a subagent holds only the slug.
   *
   * Hydrated only from a COLD cache. Every write to the registry row goes
   * through `propagateDisplayName`, which refreshes the cache in the same call,
   * so a warm activation already holds the current title and a per-turn read
   * would buy nothing for its Durable Object hop.
   */
  async workspaceTitle(): Promise<string | null> {
    if (!this._titleHydrated) await this.hydrateTitle();
    return this.titleInputs().displayName;
  }

  protected override async promptIdentity(): Promise<PromptIdentity> {
    return { workspace: await this.workspaceTitle() };
  }

  /** Commit one display name to the ROOT registry, then refresh the activation
   *  cache and live clients. An auto-title is refused if the owner has claimed
   *  the naming — decided at the root, in the same write. */
  private async propagateDisplayName(
    displayName: string,
    origin: 'user' | 'auto',
  ): Promise<boolean> {
    await this.hydrateTitle();
    let applied = true;
    if (this.getOwnerUserId()) {
      const { stub, caller } = await this.userHub();
      applied = (await stub.setWorkspaceDisplayName(caller, this.name, displayName, origin)).applied;
    }
    if (!applied) return false;
    this._titleCache = { displayName, nameOrigin: origin };
    this._titleHydrated = true;
    this.broadcast(JSON.stringify({ type: 'workspace_renamed', displayName }));
    return true;
  }

  // ── Background jobs (#173) — auto-detach >30s tool calls, wake on completion ──
  // Lifecycle (detach → settle → wake + cancel + recover) lives in the core
  // BackgroundJobRunner (this.jobRunner) and the control plane above it in core
  // read-models; what follows is the @callable transport for that plane.

  /** Read a background job's result (the synthesis turn calls this). */
  async jobResult(jobId: string): Promise<BackgroundJob | null> {
    return jobResult(this.jobs, jobId);
  }

  @callable()
  async listBackgroundJobs(limit: number = 20): Promise<BackgroundJob[]> {
    return listBackgroundJobs(this.jobs, limit);
  }

  /**
   * One background-job lifecycle operation and whether it took effect.
   *
   * Wrapped rather than emitted at each of the four sites, because the four are
   * one boundary and the interesting number is the RATIO — a retry rate that
   * climbs is the visible half of jobs that keep dying, and no single call site
   * can see that. The job id is not a field: it is high-cardinality and answers
   * no fleet question.
   */
  private countJobOperation<Outcome extends { ok: boolean }>(
    operation: string,
    outcome: Outcome,
  ): Outcome {
    recordJobSettled(this.env, {
      workspace: this.name,
      agentKind: this.actorKind(),
      operation,
      outcome: outcome.ok ? 'ok' : 'refused',
    });
    return outcome;
  }

  @callable()
  async cancelBackgroundJob(jobId: string): Promise<{ ok: boolean }> {
    return this.countJobOperation('cancel', await cancelBackgroundJob(this.jobRunner, jobId));
  }

  @callable()
  async retryBackgroundJob(jobId: string): Promise<RetryOutcome> {
    return this.countJobOperation('retry', await retryBackgroundJob({
      jobs: this.jobs,
      jobRunner: this.jobRunner,
      rawTools: (mode) => this.getRawToolsForWorkMode(mode),
      logActivity: (event, detail) => this.logActivity(event, detail),
    }, jobId));
  }

  @callable()
  async dismissBackgroundJob(jobId: string): Promise<{ ok: boolean }> {
    return this.countJobOperation('dismiss', await dismissBackgroundJob(this.jobs, jobId));
  }

  @callable()
  async clearBackgroundJobs(): Promise<{ ok: boolean }> {
    return this.countJobOperation('clear', await clearBackgroundJobs(this.jobs));
  }

  /** The agent's own task list, for the Tasks surface. Read-only on purpose:
   *  the agent maintains this list from the `tasks` tool and re-reads it in
   *  its live context, so a second writer would swap its plan underneath it
   *  with nothing to say so. Changing what it is doing goes through chat. */
  @callable()
  async listAgentTasks(): Promise<AgentTaskTree[]> {
    return this.taskList.list();
  }

  /** The orchestrator's half of the shared Stop: settle the turn that was
   *  cancelled. The call itself is ActorAgent's. */
  protected override onWorkCancelled({ abortedTools }: Omit<CancelWorkOutcome, 'ok'>): void {
    this._inFlight = false;
    this.logActivity('work_cancelled', `${abortedTools} foreground aborted`);
  }

  // ── Device consent — ask-once-then-remember ──────────────────────────
  // The UserDO (device hub) calls awaitDeviceConsent when this agent touches a
  // device with no remembered policy. The registry is core's; what a Durable
  // Object contributes is fanning the prompt out to connected sockets and the
  // activity line. "Always" is persisted on the hub, not here.
  private readonly _consents = new DeviceConsentRegistry({
    newId: () => `cons-${nanoid(10)}`,
    // The wire shapes stay written out here rather than behind a helper: the
    // broadcast-wiring gate reads `broadcast({ type: … })` off the source, and
    // a channel it cannot see is a channel it cannot prove has a consumer.
    announce: (notice) => {
      if (notice.kind === 'raised') {
        const { consent } = notice;
        this.logActivity('device_consent_requested', `${consent.deviceLabel}: ${consent.command.slice(0, 80)}`);
        this.broadcast(JSON.stringify({
          type: 'device_consent',
          consentId: consent.consentId,
          deviceId: consent.deviceId,
          deviceLabel: consent.deviceLabel,
          method: consent.method,
          command: consent.command,
          workspaceName: consent.workspaceName ?? null,
        }));
        return;
      }
      this.broadcast(JSON.stringify({ type: 'device_consent_resolved', consentId: notice.consentId }));
    },
  });

  /** Called by the UserDO over a DO-to-DO RPC. Resolves when the user decides,
   *  or as `timeout` after the registry's window so a device call never hangs
   *  forever. `timeout` is deliberately NOT `deny`: an unanswered prompt means
   *  the owner was away, and telling the agent it was refused turns that into a
   *  permanent, self-imposed capability loss. */
  async awaitDeviceConsent(req: DeviceConsentRequest): Promise<DeviceConsentDecision> {
    return this._consents.request(req);
  }

  /** The chat UI calls this when the user clicks a consent card button. */
  @callable()
  async resolveDeviceConsent(consentId: string, decision: DeviceConsentAnswer): Promise<{ ok: boolean }> {
    return { ok: this._consents.resolve(consentId, decision) };
  }

  /** Pending consent requests — so the chat re-renders cards after a reload. */
  @callable()
  async listPendingConsents(): Promise<PendingDeviceConsent[]> {
    return this._consents.list();
  }

  // ── Deferred approval — the owner is asleep, the run carries on ──────
  // Device consent parks the CALLER on a promise for five minutes, which is
  // right when the answer is minutes away. This one is for the answer that is
  // hours away: the action is parked on the owner in SQL, the agent is told so
  // and keeps working (or ends its turn), and the owner's decision wakes it
  // through the same signal seam a settled background job uses. Nothing is
  // ever reported as having run — see core's safety/deferred-approval.ts.
  protected _deferrals: DeferredApprovalQueue | null = null;
  protected get deferrals(): DeferredApprovalQueue {
    if (!this._deferrals) {
      this._deferrals = new DeferredApprovalQueue({
        store: new DeferredApprovalStore(this.boundSql, this.actorHandle()),
        // Read through `this.orch` at DELIVERY time, never captured: this
        // getter is reachable from the runtime's own construction path.
        signals: { deliver: (signal) => this.orch.signals.deliver(signal) },
        // Where an 'always' answer lands: the same actor_config the approval
        // MODE lives in, read live by the gate on the very next command.
        remember: (grants) => { this.config.grantShellApproval(grants); },
        // A spent grant's row is DELETED, so this run event is the only
        // durable record that the owner's approval was consumed. Written into
        // the spending turn's own run log; outside any turn it falls back to
        // the workspace run so the audit still lands.
        audit: (record) => {
          try {
            this.eventRecorder.emit(this._currentRunId || WORKSPACE_RUN_ID, {
              type: 'approval_consumed', ...record,
            });
          } catch (err) {
            diagnostics.failure('approval.audit_emit_failed', toKinuError({
              doing: 'recording an approval_consumed run event',
              cause: err,
              otherwise: 'io',
            }));
          }
        },
        announce: (notice) => this.announceDeferral(notice),
      });
    }
    return this._deferrals;
  }

  /** The gate's channel. Overrides the base actor's "no queue here". */
  protected override deferralChannel(): DeferredApprovalChannel {
    return this.deferrals.channel;
  }

  private announceDeferral(notice: DeferredApprovalNotice): void {
    if (notice.kind === 'queued') {
      this.logActivity('approval_deferred', `${notice.action.id}: ${notice.action.command.slice(0, 80)}`);
    } else {
      const [first] = notice.actions;
      this.logActivity('approval_decided', `${notice.actions.length} ${first?.status ?? 'decided'}`);
    }
    // The needs-you queue is polled, not pushed; one frame tells a connected
    // client to re-read it rather than duplicating the rows onto the wire.
    this.broadcast(JSON.stringify({ type: 'pending_actions_changed' }));
  }

  /** Everything the agent has parked on the owner. Read by the needs-you
   *  queue; also callable on its own so a surface can render just this. */
  @callable()
  async listDeferredApprovals(): Promise<DeferredApproval[]> {
    return this.deferrals.list();
  }

  /**
   * The owner decides — one parked action, or a night's worth in one click.
   *
   * Bulk is the point: an unattended run can park a dozen commands, and
   * deciding them one prompt at a time is the friction this whole mechanism
   * exists to remove. One call, one durable write per row, ONE wake.
   */
  @callable()
  async decideDeferredApprovals(
    ids: string[], decision: DeferredApprovalAnswer,
  ): Promise<{ decided: string[] }> {
    const decided = await this.deferrals.decide(ids, decision);
    return { decided: decided.map((a) => a.id) };
  }


  // ── DO initialization ──────────────────────────────────────────

  // Device connection is user-level: UserDO owns the tunnel socket and the
  // tokens, and the laptop executor forwards to it. Nothing per-agent verifies,
  // attaches, issues or lists a device token.

  /**
   * Create/migrate every agent table. Idempotent and gated by an in-memory
   * flag so the full DDL set runs once per DO activation (both onStart and a
   * pre-onStart claimOwner route through here). No persistent schema-version is
   * tracked: a cold activation always re-runs, so newly-added tables in code
   * are created without migration bookkeeping.
   *
   * THREE PHASES, and the order is the contract. Plain DDL first; then the
   * workspace's own identity and main-actor ROWS; only then anything that
   * resolves this actor's handle. The directory refuses to issue a handle over
   * a database with no identity row, so an actor-bound step hoisted above the
   * bootstrap throws on every fresh workspace — and `claimOwner` swallows that
   * throw as a diagnostic, which is how the same mistake stayed invisible: the
   * flag stayed false, the claim wrote the rows itself, and the actor-bound
   * half silently did not run until some later activation.
   */
  protected ensureSchema(): void {
    if (this._schemaReady) return;
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);

    // Every table a workspace has, on any backend — one list, in core.
    initWorkspaceSchema({ execRaw, sql: this.boundSql, exec: this.ctx.storage.sql });
    initWorkspaceBaselineTable(execRaw);
    initWorkspaceActorTable(execRaw);

    // ── planes this root alone carries (declared per-root in
    //    core/conformance/manifest.ts, observed against sqlite_master) ──
    initWebhookIngressTables(this.ctx.storage.sql);
    // The workspace's OWN rows, before anything that needs a handle over them.
    // `createMain` is idempotent, so a warm activation re-reads rather than
    // re-writing, and the transaction is the one this bootstrap always had.
    this.bootstrapWorkspaceActor();
    this.subordinateRoster.ensureSchema();

    // Workspace-diff baseline (path → content snapshot) for the Output surface's

    // Per-turn user feedback (thumbs up/down). The chat UI's thumbs button
    // writes here via setTurnFeedback, which re-scores the crafted tools used
    // in that turn — feedback is inherently asynchronous (it arrives after the
    // turn completes), so it can't be read at turn time.
    //
    // KEYED (actor_id, message_id), never message_id alone. A message id is
    // minted PER ACTOR — `messages` is `PRIMARY KEY (actor_id, id)` for exactly
    // this reason — so ids are not unique across the actors sharing this one
    // database. Under a bare `message_id` primary key two actors' turns that
    // collide do not error, they silently OVERWRITE each other's thumbs, and
    // the graded-outcome read behind them grades one actor's turn with a
    // sibling's verdict.
    execRaw(`CREATE TABLE IF NOT EXISTS turn_feedback (
      actor_id   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      feedback   TEXT NOT NULL CHECK (feedback IN ('positive','negative')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (actor_id, message_id)
    )`);
    // Records which crafted tools each assistant turn used, keyed by the
    // assistant message id, so async thumbs feedback can re-score exactly
    // those tools' EMA. Only crafted tools are stored (built-ins aren't scored).
    // The sleep-time answer a terminal effect already paid for. The model call
    // and the fact mutation are two steps; persisting the answer between them is
    // what makes the replay apply the SAME update instead of buying another.
    execRaw(`CREATE TABLE IF NOT EXISTS sleep_time_updates (
      effect_key  TEXT PRIMARY KEY,
      update_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    )`);
    // Same per-actor key as turn_feedback above, for the same reason: this is
    // the table the thumbs re-score reads, so a bare message_id key would let
    // one actor's feedback re-score a sibling's crafted tools.
    execRaw(`CREATE TABLE IF NOT EXISTS turn_craft_usage (
      actor_id   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      tool_names TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (actor_id, message_id)
    )`);
    // The container's own lifecycle failures, so an incident is announced once
    // and stays readable afterwards. Owned by this root because the container
    // is the WORKSPACE's — a subordinate rides its parent's and has none of
    // its own to report.
    initSandboxLifecycleTable(execRaw);

    // Moved out of the ActorAgent constructor: the extension's ports read the
    // compaction store, which resolves this actor's handle, which needs the
    // rows above to exist. `ensureSchema` is flag-gated, so this still runs
    // exactly once.
    this.registerCompactionExtension();

    this._schemaReady = true;
  }

  /** Activation init, synchronous by contract: partyserver runs `onStart()`

   *  inside `ctx.blockConcurrencyWhile()` (its `#ensureInitialized`), and
   *  `fetch`, `webSocketMessage`, `webSocketClose` and `alarm` all await that
   *  same gate. So anything awaited here stalls EVERY request on this object,
   *  pure `@callable` reads included, and at 30s the Workers runtime cancels the
   *  block and RESETS the object — `do.block_concurrency.cancel_ms` in the
   *  platform catalog, which owns these measurements: a bare `SELECT` behind an
   *  `onStart` awaiting a second Durable Object took 2303ms / 10215ms / 25212ms
   *  for a 2s / 10s / 25s answer, and reset the object at 31s. Preconditions
   *  that need I/O belong on the turn path (`ActorAgent.beforeTurn`); recovery
   *  work that must reach the model is detached, as below.
   *
   *  The explicit `: void` is load-bearing but is NOT self-enforcing: the base
   *  declares `onStart(props?): void | Promise<void>` (partyserver's .d.ts), so
   *  `async onStart(): Promise<void>` still typechecks. What the annotation buys
   *  is that an `await` added here is a compile error (TS1308) and that widening
   *  it is visible in the diff; `scripts/do-init-gate.ts` is what refuses the
   *  widening. */
  async onStart(): Promise<void> {
    this.installClientMessageGate();
    this.ensureSchema();
    this.assertSessionStore();
    // EVERY budgeted sweep this actor owns, through the seam the alarm frame
    // runs — one list, not a hand-folded copy of it, so a sweep added to the
    // seam cannot be missing from the gate. They run inside `Agent.alarm()`'s
    // initialization, before the SDK reads its own tables, so a backlog is
    // pruned rather than paid for in one go; every pass carries a ROW BUDGET
    // because this is the init gate, and every cutoff is this construction
    // instant, so under `blockConcurrencyWhile` no request can have spawned the
    // work a pass is about to retire. A pass that filled its budget answers
    // truncated and the wake below drains the remainder in alarm frames, never
    // against the gate and never waiting for the next eviction.
    const sweepsTruncated = this.maintenanceSweeps();
    // The wake chain, reconciled: an activation is the one moment a workspace
    // whose only wake row was lost can notice. Detached because arming a
    // schedule row is I/O and this method runs inside the init gate.
    this.detachOwned(async () => {
      try {
        await this.reconcileTimerRow();
      } catch (cause) {
        diagnostics.failure('schedule.timer_reconcile_failed', toKinuError({
          doing: 'restoring the wake row an activation found missing', cause, otherwise: 'io',
        }), { workspace: this.name });
      }
    });
    // The activation CLASSIFIES and ARMS: bounded existence reads plus the
    // sweep verdicts above, one schedule row when anything is owed. Every
    // DISPATCH — owed replies, interrupted terminal transitions, fork and job
    // recovery, the remainder of a truncated sweep — runs under that durable
    // wake, because a reply is external mail and an activation launches no
    // external work, awaited or detached.
    if (sweepsTruncated || this.owedWorkExists()) {
      this.detachOwned(async () => {
        try {
          await this.scheduleTerminalRetry(Date.now());
        } catch (cause) {
          diagnostics.failure('event.delivery_reconcile_failed', toKinuError({
            doing: 'arming the wake that finishes what a dead activation owed',
            cause,
            otherwise: 'io',
          }), { workspace: this.name });
        }
      });
    }

    // A cold activation is the moment the fork journal's `running` heads become
    // provably stale: nothing in this isolate is executing one, and
    // `head_journal.status` has no other writer for that — so a stale `running`
    // keeps feeding "N of M heads running" into every model step's
    // dynamic-context block for the life of the workspace.
    //
    // BUT CORRECTING THAT CLAIM IS NOT RETIRING THE WORK. Fork recovery runs
    // under the terminal wake (`maintenanceWork` below): it first marks stale
    // heads interrupted, then offers their roots to the orphan-job recovery
    // gate, and retires only roots that gate refuses. A fiber row can
    // disappear with the activation that owned it (that is the case
    // `jobs/runner.ts` documents its registry sweep for), so recovery cannot
    // depend solely on a surviving `bg:*` fiber callback or retire work
    // before offering it for re-entry.
    //
    // So the reconciliation owns the order. It marks the stale rows
    // `interrupted` — non-terminal, so the roster stops lying without discarding
    // the run — then offers their roots to the job sweep, and retires only what
    // the sweep refused. The CLI runs the same sweep at startup
    // (`local-session.ts`); the sweep is idempotent, because every recovery
    // reclaims under a fresh lease and a job this isolate is already driving
    // is skipped.
    //
    // Detached, not awaited: the journal writes are synchronous and land in this
    // method's own frame, but TELLING the agent goes through the signal seam,
    // which queues a turn via `Think.saveMessages` and resolves only when that
    // turn ENDS. Awaiting a whole agent turn inside the init gate is the 30s
    // object reset.
    // Fork-journal recovery is turn-capable — the signal seam queues a turn —
    // so it runs under the terminal wake's alarm frame (`maintenanceWork`),
    // and the delivery reconcile above is what arms that wake: its existence
    // reads cover owed deliveries, interrupted transitions, running heads AND
    // live job rows, so recovery is owed exactly when one of them answers.

    // Boot awaits only this object's SQLite and session composition. A failure
    // clears the memo so the next workspace request can retry after activation.
    try {
      await this.hostedWorkspace().bundle.session();
    } catch (err) {
      diagnostics.failure('workspace.activation_boot_failed', toKinuError({
        doing: 'booting the workspace at activation',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    }
  }

  /**
   * When this activation began — the isolate's own construction instant.
   *
   * THE RECOVERY CUTOFF, threaded through every predicate a recovery pass
   * reads: the branch-head seal, the fork journal's marks and retirements, the
   * swarm ledger's offered and unclaimed sets, the run-event closer. A head,
   * swarm row or run created AFTER this moment belongs to a live request of
   * THIS activation — requests land between construction and the wake's first
   * tick — and no recovery pass may settle one. Strict `<` on purpose: a
   * same-millisecond tie reads as live and waits one activation, where the
   * inclusive bound would kill live work.
   */
  private readonly activationStartedAt = Date.now();

  /**
   * Whether this activation still owes its ONE fork-journal recovery pass.
   *
   * In-memory ON PURPOSE: "once per activation" is a property of the isolate,
   * and an eviction resets the flag and the cutoff together. It is what keeps
   * the reconcile off the ordinary terminal retries that arm the same wake
   * mid-activation, and the constraint is sharper than "the pass is
   * idempotent": a root the resume gate CLAIMED stays `interrupted`, so a
   * second pass in this activation would offer it to a gate that can no longer
   * claim it — the job is no longer an orphan, this isolate is already driving
   * it — and retire the live re-driven run underneath its own executor.
   */
  private activationRecoveryPending = true;

  /** Carry one fork-recovery notice durably until the delivery seam accepts
   *  it — each attempt its own fiber row, `undelivered` retried forever at the
   *  capped pace `dispatchRecoveredNotice` owns, the idempotency key colliding
   *  any landed duplicate. */
  private dispatchForkNotice(signal: AgentSignal): void {
    const notice: RecoveredNotice = {
      kind: signal.kind, text: signal.text,
    };
    if (signal.idempotencyKey !== undefined) notice.idempotencyKey = signal.idempotencyKey;
    if (signal.metadata !== undefined) notice.metadata = signal.metadata;
    dispatchRecoveredNotice(
      {
        redrive: (lane, checkpoint, body) => { this.redriveRecoveredLane(lane, checkpoint, body); },
        deliverSignal: (recovered) => this.orch.signals.deliver(recovered),
      },
      notice,
    );
  }

  /** The orchestrator's asynchronous maintenance: reconcile the fork journal a
   *  dead activation left running (marks, job re-drives, the notice that may
   *  queue a turn), then reclaim settled exploration facets against the
   *  ledgers it just settled. Idempotent per activation by the guard below —
   *  every recovery reclaims under a fresh lease, and a job this isolate
   *  already drives is skipped. */

  protected override async maintenanceWork(): Promise<boolean> {
    for (const pending of this.workspaceActors().retirements()) {
      await this.runActorDirectory(pending.caller, pending.parentPath, { action: 'retire', name: pending.name, reference: pending.reference });
    }
    // ARM 1 OF THE ACTOR SWEEP, and it runs BEFORE anything admits new work
    // for these actors. A claim admitted and never settled is the only record
    // that a hosted turn is owed, and reconciling it first is load-bearing:
    // issue a second turn for an actor whose first still holds a claim and the
    // per-actor serialization refuses it — an honest refusal, of the wrong
    // turn. Core's ONE implementation, shared with the CLI, because a second
    // copy is a second chance for one of them to be the unreached one, which
    // is what had happened on both backends at once.
    //
    // HERE rather than in `maintenanceSweeps()`: this resumes TURNS, and
    // `maintenanceSweeps` is synchronous and runs inside `onStart`'s
    // `blockConcurrencyWhile`, where awaiting a whole agent turn trips
    // `do.block_concurrency.cancel_ms` — the gate is cancelled and the Durable
    // Object is RESET. The number is the catalog's, not retyped here.
    // Turn-capable recovery belongs on the durable wake's alarm frame, which
    // `owedWorkExists()` arms.
    try {
      await recoverActorTurns(this.actorHost());
    } catch (cause) {
      diagnostics.failure('actor.turn_recovery_failed', toKinuError({
        doing: 'rebuilding the hosted turns an eviction interrupted', cause, otherwise: 'io',
      }), { workspace: this.name });
    }
    // ARM 2, STRICTLY AFTER ARM 1. A claim reconciled above is an actor free to
    // take new work; drained first, this would issue a second turn for an actor
    // whose previous one still holds a claim, and the per-actor serialization
    // would refuse — honestly, but the wrong turn. Truncation is owed work, so
    // it is reported to the caller the way every other budgeted pass reports it.
    const delegationsTruncated = await this.drainAdmittedDelegations();
    if (!this.activationRecoveryPending) return delegationsTruncated || await super.maintenanceWork();
    // AFTER the branch seal has drained, and the seal's own remainder is what
    // says so: a branch head still `running` from before the cutoff is a row
    // the LIMIT-256 seal has not reached, and the fork reconcile — which reads
    // every pre-cutoff running head as a stale FORK — would retire it as lost
    // fork work and announce a steer branch as a fork run. Asked at limit 1,
    // because presence is the whole question, and asked of the journal rather
    // than threaded from the sweep so the precondition is a fact about the
    // world instead of a boolean from another method.
    if (this.headJournal.listRunningBranchHeads(
      STEER_BRANCH_RUN_ID_PREFIX, 1, this.activationStartedAt,
    ).length > 0) return true;
    this.activationRecoveryPending = false;
    try {
      await reconcileInterruptedForks({
        now: this.activationStartedAt,
        journal: this.headJournal,
        // NON-AWAITING: the notice's enqueue is durable the moment it lands
        // (`Think.saveMessages`), and the delivered promise resolves only when
        // the QUEUED TURN ends — freight this alarm frame must not carry. The
        // wait is owned, so a failure still classifies and the harness join
        // still sees it.
        signals: {
          // DURABLE before 'queued' is claimed: the fiber row the redrive
          // writes synchronously is the acceptance boundary, and an eviction
          // between the journal's terminal writes and the turn landing replays
          // the DELIVERY through the fork-notice lane — where the signal's
          // idempotency key makes an already-landed replay collide instead of
          // stacking cards.
          deliver: (signal) => {
            this.dispatchForkNotice(signal);
            return Promise.resolve('queued');
          },
        },
        search: this.mctsSearchStore,
        runEvents: this.eventRecorder,
        resume: jobRedriveResumeGate({
          recoverOrphans: () => this.jobRunner.recoverOrphans(),
          inputOf: (jobId) => this.jobs.getInput(jobId),
          rootsForTask: (task) => resumableForkRoots(
            { ledger: this.mctsSearchStore, journal: this.headJournal }, task,
          ),
        }),
        logActivity: (event, detail) => this.logActivity(event, detail),
      });
      await this.reclaimSettledExplorationActors();
    } catch (cause) {
      diagnostics.failure('head.journal_reconcile_failed', toKinuError({
        doing: 'reconciling fork-journal heads a dead activation left running',
        cause,
        otherwise: 'io',
      }), { workspace: this.name });
    }
    return delegationsTruncated || await super.maintenanceWork();
  }
  /**
   * Retire exploration ACTORS a reset left behind, against the ledgers the
   * fork reconciliation just settled (S13). Runs AFTER
   * `reconcileInterruptedForks` so a head it marked `interrupted` reads as
   * resumable here, never terminal.
   *
   * A much smaller claim than the facet sweep made. That one had to destroy
   * DATABASES — an unreclaimed facet was a permanent SQLite inside this object,
   * charged against a quota whose overflow is a reset rather than a catchable
   * error — so it read the SDK's sub-agent registry and deleted storage on the
   * strength of a ledger match. What is left behind now is a roster row and an
   * `actor_id`-scoped set of rows in the one database, so being late costs
   * nothing and the sweep is bookkeeping.
   */
  protected async reclaimSettledExplorationActors(): Promise<void> {
    try {
      const { retired } = await reclaimSettledExplorationActors(this.explorationSeams(), {
        readHead: (id) => this.headJournal.readHead(id),
        hasLiveExploration: () => this.hasLiveExploration(),
      });
      if (retired > 0) diagnostics.event('actor.settled_retired', { retired });
    } catch (err) {
      diagnostics.failure('actor.reconciliation_failed', toKinuError({
        doing: 'retiring exploration actors left behind by a reset',
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: this.name });
    }
  }

  /**
   * The lifecycle ledgers are the ONLY status authority — no per-actor copy.
   *
   * `completed`, `aborted`, `errored` and `budget_exceeded` are terminal
   * report outcomes; `running` and `interrupted` remain resumable. Name two
   * of the four by hand and treat the rest as resumable, and a head that
   * threw or blew its budget keeps its actor rows live past the point their
   * journal says they settled. Unknown or absent journal statuses remain
   * unknown, so reclamation does not guess about unledgered actors while
   * exploration is live.
   */
  /** Kept as the one place the head journal's four statuses are read as a
   *  lifecycle verdict; `reclaimSettledExplorationActors` asks the journal the
   *  same question through its own `readHead` port. */
  protected explorationFacetLedgerStatus(id: string): 'resumable' | 'terminal' | 'unknown' {
    const head = this.headJournal.readHead(id);
    if (!head) return 'unknown';
    if (headStatusUnsettled(head.status)) return 'resumable';
    return storedHeadReportStatus(head.status) === null ? 'unknown' : 'terminal';
  }

  private hasLiveExploration(): boolean {
    return this.headJournal.hasUnfinishedHeads() || this.mctsSearchStore.hasRunningSearches();
  }

  // ── Timer ingress ──────────────────────────────────────────────
  //
  // Kinu's own wake-up, dispatched by `Agent.alarm()` from the SDK's
  // `cf_agents_schedules` table (see `armTimer`). NOT an `alarm()` override:
  // the DO's single alarm slot belongs to the SDK, which also drives fiber
  // recovery, facet schedules and the keepAlive heartbeat off the same wake.
  //
  // The TriggerRegistry arms this timer; the tick fires every due trigger
  // (cron + one-shot), publishes Timer events via the hub, re-arms cron,
  // revokes one-shot, and re-arms itself for the next-soonest wake.
  //
  // Crash-safe: dedupe via `(trigger_id, scheduled_fire_at)` means a
  // re-fire after DO eviction is a no-op publish.
  //
  // TRACED, and this is the path the tracing seam was wired on first because it is
  // the one the contract is about: a wake is a SEPARATE invocation from whatever
  // armed it. The turn that scheduled this trigger finished minutes or days ago, in
  // an isolate that may since have been reset, so a span covering both would be
  // measuring an interval nothing observed. `tracing.invocation` makes that
  // unreachable rather than discouraged — it revokes the handle when this method's
  // promise settles, so a span opened from anything that escaped this tick throws.
  // The four phases are four sibling spans under one root, which is what turns
  // "the alarm was slow" into "the email reconcile was slow".
  async _kinuTimerTick(): Promise<void> {
    const now = Date.now();
    await this.tracing.invocation('alarm', 'tick', async (tick) => {
      await tick.span('alarm.due_triggers', async (span) => {
        try {
          // Wake the agent to act on the freshly-published timer events (and any
          // other pending events) — an autonomous turn, debounced so events
          // arriving alongside the alarm coalesce into it.
          const { fired } = await fireDueTriggers({ registry: this.triggerRegistry, log: this.eventLog }, now);
          span.setAttribute('kinu.triggers_fired', fired);
          if (fired > 0) this.orch.scheduleDrain();
        } catch (err) {
          const failure = toKinuError({
            doing: 'firing the triggers due on this wake',
            cause: err,
            otherwise: 'io',
          });
          // `fail` and not a rethrow: the tick tolerates this and continues to the
          // next phase, so the span closes SUCCESSFULLY unless it says otherwise.
          span.fail(failure);
          diagnostics.failure('schedule.due_triggers_failed', failure);
        }
      });

      // Re-drive pending outbound peer messages (crash/eviction recovery + the
      // exponential-backoff retry path — inline tool dispatch handles the happy
      // path, this alarm is the durable one).
      await tick.span('alarm.peer_dispatch', async (span) => {
        try {
          await this.peerHub.dispatchOutbox(now);
        } catch (err) {
          const failure = toKinuError({
            doing: 're-driving the pending outbound peer messages',
            cause: err,
            otherwise: 'unavailable',
          });
          span.fail(failure);
          diagnostics.failure('peer.outbox_dispatch_failed', failure);
        }
      });

      // Reconcile indeterminate outbound email: an intent left `pending` (crash
      // between the send and its status write) is safely re-driven here — the
      // stored Message-ID makes the re-send idempotent downstream (SPEC §7.4).
      await tick.span('alarm.email_reconcile', async (span) => {
        try {
          if (this.env.EMAIL) await this.emailOutbox.reconcile(this.env.EMAIL, now);
        } catch (err) {
          const failure = toKinuError({
            doing: 'reconciling indeterminate outbound email',
            cause: err,
            otherwise: 'unavailable',
          });
          span.fail(failure);
          diagnostics.failure('email.outbox_reconcile_failed', failure);
        }
      });

      // Re-arm for the next-soonest wake (triggers ∪ peer-outbox ∪ email-outbox
      // retries). A due/past-due retry is clamped to `now` (see nextAlarmTime),
      // and the arm is soonest-wins so this never clobbers a sooner wake armed
      // during dispatch. Awaited, not fire-and-forget: this is the link that
      // keeps the timer chain alive.
      await tick.span('alarm.timer_rearm', async (span) => {
        try {
          const next = this.nextWakeAt(now);
          span.setAttribute('kinu.rearmed', next !== null);
          if (next !== null) await this.armTimer(next);
        } catch (err) {
          const failure = toKinuError({
            doing: 're-arming the wake that keeps the timer chain alive',
            cause: err,
            otherwise: 'io',
          });
          span.fail(failure);
          diagnostics.failure('schedule.timer_rearm_failed', failure);
          // RETHROWN, unlike the three phases above it. Their work is state
          // driven and the NEXT wake retries it; this failure IS the loss of
          // the next wake, so nothing is left to retry anything. An uncaught
          // throw out of the alarm is what makes the runtime redeliver it
          // (proven under workerd in tests/workerd/do-alarm.test.ts), and a
          // redelivered tick re-arms from the same durable state. Swallowing it
          // reported a successful alarm over a chain that had just ended.
          throw failure;
        }
      });
    });
  }

  /** Compute the next firing time for a cron expression after `from`.
   *  Simple implementation: supports `*\/n * * * *` (every n minutes) and
   *  `m h * * *` (daily at hh:mm UTC); enough for v1 schedules. Full cron
   *  parsing arrives with the Triggers UI. */

  // ── Callable RPC methods ───────────────────────────────────────

  private getDisplayName(): string {
    return this.titleState().displayName || this.name;
  }

  @callable()
  async getReleaseBoard(limit: number = 20) {
    const { stub, caller } = await this.userHub();
    return stub.getReleaseBoard(caller, this.name, limit);
  }

  @callable()
  async createReleaseChange(input: { bindingId: string; userPrompt: string; plan?: string | null }) {
    const { stub, caller } = await this.userHub();
    return stub.createReleaseChange(caller, this.name, input);
  }

  async transitionReleaseChange(changeId: string, status: ReleaseStatus) {
    const { stub, caller } = await this.userHub();
    return stub.transitionReleaseChange(caller, changeId, status);
  }

  @callable()
  async decideReleaseApproval(approvalId: string, decision: 'approved' | 'rejected', note?: string | null) {
    const { stub, caller } = await this.userHub();
    const decided = await stub.decideReleaseApproval(caller, approvalId, decision, this.getOwnerUserId() ?? this.name, note);
    // Refusing a ROLLBACK leaves the deployed change deployed, which is also
    // why `deployed -> rejected` is not a legal transition. Every other
    // approval is the gate on shipping the change, so refusing it rejects it.
    if (decision === 'rejected' && decided.approvalType !== 'rollback') {
      await stub.transitionReleaseChange(caller, decided.changeId, 'rejected');
    }
    return decided;
  }

  async getAgentStatus() {
    const status = await getAgentStatus({
      sql: this.boundSql,
      actor: this.rt.actor,
      vfs: this.rt.storage.vfs,
      config: this.config,
      name: this.name,
      displayName: await this.workspaceTitle() ?? '',
    });
    const profile = this.resolvedTurnProfile();
    return {
      ...status,
      roleId: profile?.role.id ?? this.activeRoleLabel(),
      tierId: profile?.tier.id ?? 'default',
    };
  }

  async getToolList() {
    return getToolList(this.boundSql, this.rt.craftStore);
  }

  /** The LATEST search's tree only — settled earlier searches stay in
   *  search_nodes and must never shadow the run the operator is watching. */
  @callable() async getMctsTree() {
    return readLatestSearchTree(this.boundSql, this.actorHandle());
  }

  /** One named search's tree. The unified fork list can select a competed run
   *  that is not the latest, and `getMctsTree` would then answer with another
   *  search's branches under it. */
  @callable() async getSearchTree(rootId: string) {
    return readSearchTree(this.boundSql, this.actorHandle(), rootId);
  }

  /**
   * A page of every exploration run this workspace has, newest first — the one entry
   * point the Exploration surface lists.
   *
   * Cursored because a bare `LIMIT 20` said "that is every run" about the newest
   * twenty, and the twenty-first was then reachable only by permalink.
   */
  @callable() async listForkRuns(request?: PageRequest): Promise<Page<ForkRunSummary>> {
    return listForkRuns(this.boundSql, this.actorHandle(), request?.cursor ?? null, request?.limit);
  }

  /**
   * One named run for a permalink, independent of the recent-list window — the SAME
   * composed row {@link getExplorationCanvas} pages.
   *
   * The composed row rather than the bare summary, because parameters that travel
   * only on the canvas page leave the full-screen drill-down — which opens one run
   * by id — with no way to read that run's own knobs, so the judge clamp shows in
   * the list column and vanishes in the view with room to show it. Fetching a page
   * of thirty runs and their trees to render one is not the answer.
   */
  @callable() async getForkRun(rootId: string): Promise<ExplorationCanvasRun | null> {
    return readExplorationRun(this.boundSql, this.actorHandle(), rootId);
  }

  /**
   * A page of the Exploration canvas: each fork with its dispatch parameters and
   * its tree, newest first.
   *
   * ONE call rather than one per tree — see the read model for why that is what
   * made a multi-tree canvas possible at all, and for why it is one row per fork
   * rather than three collections a client re-associates by id.
   */
  @callable() async getExplorationCanvas(request?: PageRequest): Promise<Page<ExplorationCanvasRun>> {
    return readExplorationCanvas(this.boundSql, this.actorHandle(), request?.cursor ?? null, request?.limit);
  }

  /**
   * A page of every comparable set the records store holds, most recently written
   * first — the discovery read the leaderboard had none of.
   *
   * The store's own reads are scoped by an `ObjectiveIdentity`, which includes the
   * digest of the verifier's source, so no surface could name a set it had not already
   * been told about. This is where a surface gets the handle; the two reads below take
   * it back opaquely rather than rebuilding it from parts.
   *
   * Each row carries the metric, the unit, the direction and the scale, because a
   * leaderboard drawn on a bare value shows a number that cannot be read.
   */
  @callable() async listRecordObjectives(request?: PageRequest): Promise<Page<RecordObjectiveSummary>> {
    return listRecordObjectives(this.boundSql, this.actorHandle(), request?.cursor ?? null, request?.limit);
  }

  /**
   * One set's cells and each cell's elite.
   *
   * `floorDigest` is REQUIRED and nullable: null is "the objective declared no floor",
   * and a floor-blind handle would collapse a corrected floor and a wrong one.
   */
  @callable() async listRecordCells(
    request: RecordObjectiveHandle & PageRequest,
  ): Promise<Page<RecordCellSummary>> {
    return listRecordCells(this.boundSql, this.actorHandle(), request, request.cursor ?? null, request.limit);
  }

  /**
   * One cell's population, best first, a page at a time.
   *
   * Paged rather than whole because a cell's population is provably unbounded
   * (`ArchiveAdmission.lean — separated_cells_are_unboundedly_large`), and
   * `descriptor: null` is the NO-PARTITION cell rather than an unnamed one.
   */
  @callable() async readRecordCell(
    request: RecordCellHandle & PageRequest,
  ): Promise<Page<ExplorationRecord>> {
    return readRecordCell(this.boundSql, this.actorHandle(), request, request.cursor ?? null, request.limit);
  }

  /**
   * Everything asynchronous that is waiting on the owner, in one queue.
   *
   * Host-owned: SLATE_READ_MODELS excludes the needs-you queue and consent
   * decisions, so an authored preview cannot counterfeit the approval surface.
   *
   * An unclaimed workspace has no release hub to ask, so it contributes no
   * approvals and no changes. Anything else that fails is a real failure and
   * reaches the caller: "nothing is pending" is the one answer an owner acts
   * on by doing nothing, so it must never be what a broken read looks like.
   */
  @callable() async listPendingActions(): Promise<PendingAction[]> {
    const board = this.getOwnerUserId() ? await this.getReleaseBoard(20) : null;
    // The unseen window itself, not the whole digest: the queue row needs the
    // count, the newest entry's time, and how many of those entries actually
    // offer keep/revert rather than being measurements to read.
    const unseen = getUnseenChangelog(this.boundSql, this.rt.actor);
    return buildPendingActions({
      approvals: board?.approvals ?? [],
      changes: board?.changes ?? [],
      scaffoldVersions: listScaffoldVersions(this.boundSql, this.rt.actor, 20),
      jobs: listBackgroundJobs(this.jobs, 50),
      deferredActions: this.deferrals.list(),
      unseenChanges: {
        count: unseen.length,
        revertable: unseen.filter((entry) => entry.revert !== undefined).length,
        latestAt: unseen[0]?.at ?? Date.now(),
      },
      curriculum: listProposedTasks(this.rt, 'pending'),
    });
  }

  /** The run-level MCTS ledger (mcts_search_runs): every search this workspace
   *  has run, newest-updated first, with its status/iteration/budget. Distinct
   *  from getMctsTree's node rows — this is how a caller tells which search is
   *  the latest without inferring it from node ordering. */
  @callable() async getMctsSearchRuns(limit: number = 20): Promise<MctsSearchRunSummary[]> {
    return this.mctsSearchStore.list(limit);
  }

  /** One node, its ancestry and its children (core read-models/search-tree.ts).
   *  The CLI serves the same projection over bun:sqlite, so `kinu inspect
   *  mcts <id>` formats one shape however it reached it. */
  @callable() async getMctsNodeDetail(nodeId: string): Promise<SearchNodeDetail | null> {
    return readSearchNodeDetail(this.boundSql, this.actorHandle(), nodeId);
  }

  // ── Evolution Changelog — the self-change digest + revert (core builder) ──

  /** The "what I changed about myself" digest, assembled on demand from the
   *  durable ledgers (core buildChangelog — no second event system). */
  @callable()
  async getEvolutionChangelog(opts?: { limit?: number }): Promise<{
    entries: ChangelogEntry[]; unseenCount: number; seenAt: number;
  }> {
    return getEvolutionChangelog(this.boundSql, this.actorHandle(), opts?.limit);
  }

  /** The operator viewed the changelog — zero the unseen badge. */
  @callable()
  async markChangelogSeen() {
    return markChangelogSeen(this.config);
  }

  /** Revert one changelog entry through the REAL machinery (scaffold
   *  rollback / craft retire / fact forget). Id-addressed against a fresh
   *  digest so a shifted list can never revert the wrong row. */
  @callable()
  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    const result = await revertChangelogEntryById({ rt: this.rt, facts: this.facts }, id);
    if (result.ok) {
      // Crafted-tool retirement must drop the cached tool surface, exactly
      // like the consolidation path.
      this._cachedTools = null;
      this._cachedToolsKey = '';
      void this.sql`INSERT INTO evolution_events (actor_id, type, message, created_at)
        VALUES (${this.actorHandle().actorId}, 'reflection',
                ${`Operator reverted changelog entry ${id}: ${result.detail ?? 'done'}`}, ${Date.now()})`;
    }
    return result;
  }

  // ── Alternate Takes — near-tied convergence candidates + the pick ──

  /** Claimed take sets keyed by their turn's assistant message id — one
   *  round-trip so the chat hydrates its "Take 1 of N" chips on load. */
  @callable()
  async listAlternateTakes(): Promise<Record<string, AlternateTakeSet>> {
    const byTurn: Record<string, AlternateTakeSet> = {};
    // Newest-first listing: keep the first (latest) set seen per turn.
    for (const set of listAlternateTakeSets(this.boundSql, this.actorHandle(), { limit: 100 })) {
      if (set.turnId && !byTurn[set.turnId]) byTurn[set.turnId] = set;
    }
    return byTurn;
  }

  /** The newest take set, picked or not — the TUI's /takes comparison source. */
  @callable()
  async latestAlternateTakes(): Promise<AlternateTakeSet | null> {
    return latestAlternateTakeSet(this.boundSql, this.actorHandle());
  }

  /**
   * Steer-as-Branch: run a mid-turn redirect as ONE budgeted head against the
   * live turn's input conversation (the same snapshot heads inherit), in
   * parallel — the live turn is never interrupted. When both finish the pair
   * settles into Alternate Takes claimed on this turn (onChatResponse);
   * progress streams as 'branch_status' broadcasts.
   */
  @callable()
  async branchTurn(text: string): Promise<{ accepted: boolean; branchId?: string; reason?: string }> {
    const task = text.trim();
    if (!task) throw new Error('branchTurn requires the redirect text');
    if (!this._inFlight) {
      return { accepted: false, reason: 'No turn is running — send it as a normal message instead.' };
    }
    if (this.turnWorkMode() === 'plan') {
      return { accepted: false, reason: 'Plan turns cannot start mutating branches. Review or finish the plan first.' };
    }
    const runtime = this.getCFHeadRuntime();
    if (!runtime) {
      return { accepted: false, reason: 'Branching needs an agent owner (heads require UserDO access).' };
    }
    const id = newBranchId();
    this._pendingBranches.push({
      id, task,
      handle: startBranchHead(runtime, this.headJournal, {
        id, task, inheritedContext: this.readInheritedContext(),
      }),
    });
    this.broadcastBranchStatus({ type: 'branch_status', status: 'running', branchId: id, task });
    this.logActivity('branch_start', task.slice(0, 120));
    return { accepted: true, branchId: id };
  }

  private broadcastBranchStatus(event: BranchStatusEvent): void {
    this.broadcast(JSON.stringify(event));
    if (event.status !== 'running') {
      this.logActivity('branch_settle', event.status === 'settled'
        ? `takes ${event.takeSetId}`
        : `error: ${event.message}`);
    }
  }


  /** Record the user's pick between the explored takes — the explicit
   *  preference signal (turn_outcomes source 'take_pick' + convergence
   *  repoint via core recordTakePick). A pick that differs from the answered
   *  take queues a gentle programmatic continuation through the BackendHost
   *  seam (same machinery as the reactor / background-job wake). */
  @callable()
  async pickAlternateTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    const outcome = await pickAlternateTake(
      { sql: this.boundSql, actor: this.rt.actor, engine: this.engine, signals: this.orch.signals },
      takeId, nodeId);
    this.logActivity('take_pick', `${outcome.outcome} (${nodeId})`);
    return outcome;
  }

  /**
   * The unified Run Timeline spine. ONE server-side merge of the durable
   * per-run event log (run_events: tool/step/head/scaffold/turn) + the
   * agent-level evolution stream (evolution_events, `data` preserved) + the
   * MCTS search nodes — normalized into ordered TimelineSpans. The client
   * renders this single source, so there is no fragile client-side merge of
   * three RPCs. Defaults to the active run, else the most recent recorded run.
   */
  @callable()
  async getRunTimeline(opts?: { runId?: string; limit?: number }): Promise<TimelineSpan[]> {
    return getRunTimeline({
      sql: this.boundSql,
      actor: this.actorHandle(),
      events: this.eventRecorder,
      jobs: this.jobs,
      currentRunId: this._currentRunId,
    }, opts);
  }

  // ── Scaffold loop closure — RPCs for manual exercise + shadow rollout ──

  /**
   * Execute the agent's current scaffold for a one-shot task. Captures all
   * events the scaffold emits and returns them — does NOT inject anything
   * back into the chat conversation. Use this to test scaffold mutations
   * without affecting the main turn loop.
   *
   * When `useShadowOverride` is true, runs the pending scaffold instead of
   * the current one (if a pending exists).
   *
   * Wire form only: the MCP Worker adapter is this method's one consumer, and
   * no remote transport dispatches the plain name, so the structured result
   * crosses as its JSON twin and is decoded at the call site.
   */
  async runScaffoldOnceWire(
    task: string,
    opts?: { useShadowOverride?: boolean },
  ): Promise<string> {
    return JSON.stringify(await runScaffoldOnce(this.scaffoldControl, task, opts));
  }

  /**
   * `agent.proposeScaffold` host method — the agent proposes a new version of
   * its own agentic loop from inside execute_tools. Routes through the
   * EXISTING modifyScaffold 4-gate pipeline; an accepted proposal lands as
   * status='pending' and is scored by the sampled shadow eval + promotion
   * gate (core queueTurnShadowTrial → runQueuedShadowTrials) like any other
   * proposal — no new safety
   * surface.
   */
  async proposeScaffold(rationale: string, code: string, baseVersion?: number) {
    return proposeScaffold(this.scaffoldControl, rationale, code, baseVersion);
  }

  /** Return the current shadow-rollout status: pending version, win counts, decision. */
  async getShadowStatus(): Promise<ShadowStatus> {
    return getShadowStatus(this.boundSql, this.rt.actor);
  }

  /**
   * Apply the pending scaffold rollout decision manually.
   *
   * `mode='auto'` consults decidePromotion and acts on its verdict (only
   * acts if decision != 'continue').
   * `mode='promote'` / `mode='rollback'` forces the corresponding action.
   */
  @callable()
  async applyScaffoldDecision(mode: 'auto' | 'promote' | 'rollback'): Promise<ScaffoldDecisionResult> {
    const result = await applyScaffoldDecision(this.scaffoldControl, mode);
    if (!result.ok) return result;
    // Emit the decision into the durable event log so SSE subscribers + MCP
    // `list_run_events` see it in-band. Uses the action ACTUALLY applied — the
    // misevolution recheck can convert a requested promote into a rollback
    // (result.vetoReason says why).
    try {
      const runId = this._currentRunId || `scaffold-${nanoid()}`;
      this.eventRecorder.emit(runId, {
        type: result.action === 'promote' ? 'scaffold_promotion' : 'scaffold_rollback',
        fromVersion: result.fromVersion,
        toVersion: result.newCurrentVersion,
      });
    } catch (err) {
      diagnostics.failure('event.scaffold_decision_emit_failed', toKinuError({
        doing: 'recording a scaffold promotion/rollback run event',
        cause: err,
        otherwise: 'io',
      }), { action: result.action });
    }
    return result;
  }

  /**
   * The per-trial shadow-eval verdict grid that drives the promote/rollback
   * decision — the moat surface's data source. Thin wrapper over core's
   * `readShadowVerdict` (reads `scaffold_evaluations`, regressions-first;
   * NOT `task_history`, which is the MCTS converge outcome ledger).
   */
  @callable()
  async getShadowVerdict(version?: number): Promise<ShadowVerdict> {
    const pendingVersion = version ?? getPendingScaffold(this.boundSql, this.rt.actor)?.version ?? null;
    return readShadowVerdict(this.boundSql, this.rt.actor, pendingVersion);
  }

  /**
   * Line diff of a scaffold version against its predecessor — what the agent
   * actually rewrote in its own inference loop. Reads the versioned VFS backups
   * (`scaffold/agent.js.vN`); `previousVersion` is the highest existing version
   * below `version` (robust to non-contiguous numbering after rollbacks). v0 /
   * no-predecessor diffs render as all-additions.
   */
  @callable()
  async getScaffoldDiff(version: number): Promise<{
    version: number; previousVersion: number | null;
    added: number; removed: number; lines: DiffLine[];
  }> {
    const after = (await readScaffoldVersion(this.rt, version)) ?? "";
    const prevRow = this.sql<{ version: number }>`
      SELECT version FROM scaffold_versions
      WHERE actor_id = ${this.rt.actor.actorId} AND version < ${version}
      ORDER BY version DESC LIMIT 1`;
    const previousVersion = prevRow[0]?.version ?? null;
    const before = previousVersion != null ? (await readScaffoldVersion(this.rt, previousVersion)) ?? "" : "";
    const d = diffLines(before, after);
    return { version, previousVersion, added: d.added, removed: d.removed, lines: d.lines };
  }

  /**
   * Run an arbitrary scaffold version against a task and return its captured
   * result — so the user can PREVIEW a candidate scaffold live before
   * promoting it. Reuses the existing runScaffold path with an explicit code
   * override (same mechanism runScaffoldOnce uses for the pending), reading
   * the version's source from the VFS `agent.js.vN` backup.
   */
  @callable()
  async previewScaffoldLive(
    version: number,
    task: string,
  ): Promise<ScaffoldRunResult> {
    return previewScaffoldLive(this.scaffoldControl, version, task);
  }

  /**
   * Change how the `run` builtin handles 'gate' decisions from the
   * approval-gate review. Stored in actor_config; effective on the NEXT
   * turn (the tool cache rebuilds when CraftStore changes — and on cold-
   * start any value here is read).
   *
   *   strict     — default; reject gate commands (sudo, rm-recursive, etc.)
   *   allow_all  — treat gate decisions as warn (logged + executed). Use
   *                ONLY for trusted dev environments.
   *   deny_all   — reject gate AND warn (env-dump, secret-file-read).
   */
  @callable()
  async setShellApprovalMode(mode: 'strict' | 'allow_all' | 'deny_all') {
    return setShellApprovalMode({
      config: this.config,
      // Force a tool cache rebuild on the next getTools().
      onChanged: () => { this._cachedTools = null; this._cachedToolsKey = ''; },
    }, mode);
  }

  /** Current shell-approval mode (strict | allow_all | deny_all). */
  @callable()
  async getShellApprovalMode(): Promise<{ mode: ShellApprovalMode }> {
    return getShellApprovalMode(this.config);
  }

  /** Every rule the owner has said "always" to, and where. The revoke list. */
  @callable()
  async getShellApprovalGrants(): Promise<{ grants: ApprovalGrant[] }> {
    return getShellApprovalGrants(this.config);
  }

  /** Take a standing grant back. The gate reads grants live, so the next
   *  command of that kind asks again — no toolset rebuild, no restart. */
  @callable()
  async revokeShellApprovalGrants(grants: ApprovalGrant[]): Promise<{ grants: ApprovalGrant[] }> {
    return revokeShellApprovalGrants(this.config, grants);
  }

  /**
   * Pin a set of skills as always-active for this agent. Empty array clears
   * the pin. Operators use this from the Settings page; without an RPC the
   * only way to set `always_active_skills` is direct SQL, which the spec
   * explicitly wants to avoid.
   */
  @callable()
  async setAlwaysActiveSkills(names: string[]) {
    return setAlwaysActiveSkills(this.config, names);
  }

  /** Current pinned always-active skill names. Empty array means none. */
  @callable()
  async getAlwaysActiveSkills(): Promise<{ names: string[] }> {
    return getAlwaysActiveSkills(this.config);
  }

  // ── File checkpoints (device shadow-git) ─────────────────────────────
  // The store lives on the user's machine; these forward to the daemon via
  // the user hub. Restore is owner-invoked (web turn card / CLI /undo), so
  // it bypasses the per-agent consent gate — pure added reversibility.

  @callable()
  async checkpointStatus(): Promise<CheckpointAvailability> {
    if (!this.getOwnerUserDO()) return { available: false, reason: 'agent has no owner user yet' };
    try {
      const { stub, caller } = await this.userHub();
      const result = await stub.deviceRpc(caller, 'checkpointStatus', []);
      return v.parse(CheckpointAvailabilitySchema, result === undefined ? undefined : JSON.parse(result));
    } catch (err) {
      // The unattached case FIRST, because its remedy is not the owner's: a
      // workspace with no owner account reached no hub, and advising `kinu
      // connect` there sends a person to re-link a machine that was never the
      // problem.
      if (isWorkspaceUnattachedError(err)) {
        return { available: false, reason: WORKSPACE_HAS_NO_OWNER };
      }
      if (isDeviceNotConnectedError(err)) {
        return { available: false, reason: 'no device connected — connect one with `kinu connect`' };
      }
      // Several machines are live and the checkpoint plane does not yet name
      // one: an availability answer, in the hub's own words (it names the
      // machines), never a silent pick of whichever came first.
      if (isDeviceAmbiguityError(err)) {
        return { available: false, reason: renderThrownChain({ cause: err }) };
      }
      throw err;
    }
  }

  /**
   * The checkpoint store's reachability and what it holds, in one round trip.
   *
   * Reachability is not optional here. A bare array answers `[]` for "no owner",
   * "no device connected" and "the store is empty" alike, and the web client
   * turns that into
   * `No file checkpoint for this turn. It changed no device files.` — a claim
   * about the operator's turn built from the absence of a device. Checkpoints
   * cover the device plane only, so a turn that ran on the workspace plane or on
   * `@sandbox` legitimately has none; the client has to be able to say which of
   * those it is looking at.
   */
  @callable()
  async listFileCheckpoints(limit = 50, turnId?: string): Promise<FileCheckpointListing> {
    const availability = await this.checkpointStatus();
    if (!availability.available) return { availability, entries: [] };
    const { stub, caller } = await this.userHub();
    // `turnId` reaches the DEVICE, so the store filters before it truncates. A
    // caller that filtered a window here instead would lose any turn buried
    // under `limit` other directories' checkpoints — retention is per directory,
    // this limit is global. See FileCheckpoints.list.
    const result = await stub.deviceRpc(
      caller, 'checkpointList', [this.name, Math.max(1, Math.min(500, limit)), turnId ?? null],
    );
    return {
      availability,
      entries: v.parse(
        v.array(FileCheckpointEntrySchema),
        result === undefined ? undefined : JSON.parse(result),
      ),
    };
  }

  @callable()
  async planFileRestore(dir: string, id: string): Promise<FileRestorePlan> {
    const { stub, caller } = await this.userHub();
    const result = await stub.deviceRpc(caller, 'checkpointPlan', [this.name, dir, id]);
    return v.parse(FileRestorePlanSchema, result === undefined ? undefined : JSON.parse(result));
  }

  @callable()
  async restoreFileCheckpoint(dir: string, id: string): Promise<FileRestoreResult> {
    const { stub, caller } = await this.userHub();
    const result = await stub.deviceRpc(caller, 'checkpointRestore', [this.name, dir, id]);
    return v.parse(FileRestoreResultSchema, result === undefined ? undefined : JSON.parse(result));
  }

  /**
   * Record thumbs-up/down feedback for a completed assistant message and
   * re-score the crafted tools that turn used. Pass `feedback: null` to clear.
   *
   * Feedback is inherently asynchronous (the user clicks after the turn ends),
   * so it can't flow through the turn-time heuristic. Instead, this applies a
   * fresh EMA observation — derived from the feedback via the same mapping the
   * turn-time path uses (feedbackToQuality) — to exactly the crafted tools
   * recorded for this message in turn_craft_usage. That makes the thumbs a
   * real, load-bearing learning signal rather than a stored-but-ignored value.
   */
  @callable()
  async setTurnFeedback(
    messageId: string,
    feedback: 'positive' | 'negative' | null,
  ): Promise<{ ok: true; messageId: string; feedback: 'positive' | 'negative' | null; rescored: number }> {
    if (messageId.length === 0) {
      throw new Error('messageId must be a non-empty string');
    }
    if (feedback === null) {
      void this.sql`DELETE FROM turn_feedback
        WHERE actor_id = ${this.actorHandle().actorId} AND message_id = ${messageId}`;
      return { ok: true, messageId, feedback: null, rescored: 0 };
    }
    if (feedback !== 'positive' && feedback !== 'negative') {
      throw new Error(`feedback must be 'positive', 'negative', or null; got ${JSON.stringify(feedback)}`);
    }
    void this.sql`INSERT INTO turn_feedback (actor_id, message_id, feedback, created_at)
             VALUES (${this.actorHandle().actorId}, ${messageId}, ${feedback}, ${Date.now()})
             ON CONFLICT(actor_id, message_id) DO UPDATE SET
               feedback   = excluded.feedback,
               created_at = excluded.created_at`;

    // Re-score the crafted tools this turn used with the feedback-derived
    // quality. No-op when the turn used no crafted tools.
    let rescored = 0;
    const usageRows = this.sql<{ tool_names: string }>`
      SELECT tool_names FROM turn_craft_usage
      WHERE actor_id = ${this.actorHandle().actorId} AND message_id = ${messageId} LIMIT 1`;
    if (usageRows[0]?.tool_names) {
      const parsedNames = v.safeParse(v.array(v.string()), JSON.parse(usageRows[0].tool_names));
      const names = parsedNames.success ? parsedNames.output : [];
      if (names.length > 0) {
        updateCraftScores(this.boundSql, names, feedbackToQuality(feedback));
        rescored = names.length;
        // The next getTools() should reflect the new scores.
        this._cachedTools = null;
        this._cachedToolsKey = '';
      }
    }
    // One outcome ledger: the explicit verdict overrides any classifier row
    // for this turn and, when negative, corroborates provisional lessons.
    try {
      await this.engine.applyExplicitFeedback(messageId, feedback);
    } catch (err) {
      diagnostics.failure('feedback.explicit_apply_failed', toKinuError({
        doing: 'recording an explicit turn verdict in the outcome ledger',
        cause: err,
        otherwise: 'io',
      }), { messageId });
    }
    return { ok: true, messageId, feedback, rescored };
  }

  /** All recorded feedback keyed by message id — one round-trip so the chat
   *  hydrates its thumbs marks on load instead of forgetting them.
   *
   *  THIS actor's marks. The ids are unique only within an actor, so an
   *  unscoped read would hand this chat a sibling's thumbs under ids that
   *  happen to collide. */
  @callable()
  async listTurnFeedback(): Promise<Record<string, 'positive' | 'negative'>> {
    const rows = this.sql<{ message_id: string; feedback: 'positive' | 'negative' }>`
      SELECT message_id, feedback FROM turn_feedback
      WHERE actor_id = ${this.actorHandle().actorId}`;
    return Object.fromEntries(rows.map((r) => [r.message_id, r.feedback]));
  }

  /** The scaffold variant archive: recent versions with status, DGM lineage
   *  (parent_version) and aggregated shadow-eval record. Read-only — also the
   *  backing for the agent.scaffoldVersions codemode helper. Computed by
   *  core's listScaffoldArchive; keys stay snake_case here because this RPC's
   *  wire shape predates the archive (ScaffoldLineage.tsx reads written_at). */
  @callable()
  async listScaffoldVersions(limit: number = 20): Promise<ScaffoldVersionView[]> {
    return listScaffoldVersions(this.boundSql, this.rt.actor, limit);
  }

  // ── GEPA offline scaffold optimisation ─────────────────────────

  /**
   * Run a GEPA (Genetic-Pareto) optimisation pass over this agent's scaffold.
   * The pass itself is core's — see `runScaffoldGepaOptimization` in
   * evolution/control.ts for what it does and what it costs.
   */
  @callable()
  async runScaffoldGepaOptimization(opts?: {
    maxIterations?: number;
    evalSize?: number;
    maxMetricCalls?: number;
  }): Promise<GepaOptimizationResult> {
    return runScaffoldGepaOptimization(this.scaffoldControl, opts);
  }

  /** List recent GEPA optimisation runs for the UI. */
  @callable()
  async getGepaRuns(limit: number = 20): Promise<GepaRunSummary[]> {
    return listGepaRuns(this.boundSql, this.actorHandle(), limit);
  }

  // ── Replay-eval loss curve ──────────────────────────────────────

  /** The persisted loss curve (replay_evals), newest first. Read-only — the
   *  data a loss chart would render. */
  @callable()
  async getReplayEvals(limit: number = 50): Promise<ReplayEvalSummary[]> {
    return listReplayEvals(this.boundSql, this.actorHandle(), limit);
  }

  /** K_align: the correction rate per 100 graded turns, per scaffold version,
   *  with 95% Wilson intervals — the self-improvement question answered from
   *  telemetry alone, no benchmark and no judge. */
  @callable()
  async getAlignmentConvergence(): Promise<AlignmentConvergence> {
    return alignmentConvergence(this.boundSql, this.actorHandle());
  }

  /** What hand labels establish about the turn-outcome classifier, and the
   *  bias-corrected rates they buy. Reads "uncalibrated" until labels exist —
   *  K_align above is the classifier's opinion until this one has numbers. */
  @callable()
  async getOutcomeCalibration(): Promise<CalibrationReport> {
    return calibrationReport(this.boundSql, this.actorHandle());
  }

  /** Draw the next calibration set: turns for a human to judge blind. */
  @callable()
  async sampleOutcomeLabeling(size: number = DEFAULT_LABEL_BUDGET): Promise<LabelingItem[]> {
    return sampleForLabeling(this.boundSql, this.actorHandle(), { size });
  }

  /** Store a labeling pass. Append-only; ids the ledger no longer knows are
   *  reported back rather than losing the pass. */
  @callable()
  async recordOutcomeLabeling(
    labeler: string,
    labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>,
  ): Promise<LabelIngestResult> {
    return ingestOutcomeLabels(this.boundSql, this.actorHandle(), { labeler, labels });
  }

  /** How the LLM panel scored against the owner's own labels, and whether it
   *  cleared the pre-registered bar to stand in for them. */
  @callable()
  async getOutcomeEnsemble(): Promise<EnsembleReport> {
    return ensembleReport(this.boundSql, this.actorHandle());
  }

  /**
   * Put the hand-labeled turns to the panel — one blind pass per judge, stored
   * append-only. Judges come from `specs` when the owner names them, else one
   * model per connected vendor family other than the one the graded turns ran
   * on.
   *
   * Fewer than two families available is reported as the gap it is (by
   * `runEnsemble`, after the prerequisites the owner would fix first); nothing
   * is padded with a second model from the same vendor, which would agree with
   * the first for reasons that have nothing to do with the turn.
   *
   * The baseline is the ROUTED turn model, not the stored spec. What this panel
   * has to differ from is whatever actually graded-work ran on, and
   * `MODEL_ROUTE_POLICY.agent` is `invocation` — the tier the active role
   * selected. Reading `getStoredModelId()` instead named the account's chat
   * default, so a role running on any other tier could have its own model
   * selected as an "independent" judge: a panel agreeing with the turn because
   * it IS the turn.
   *
   * This panel is the ONE declared exception to `MODEL_ROUTE_POLICY`'s
   * exhaustiveness, and the rationale lives in that table's own header rather
   * than here — a claim of exhaustiveness has to carry its own counter-example,
   * and a comment in this package is invisible from the file making the claim.
   * Read `core/src/profiles/model-route.ts` before changing this: the short
   * version is that its members must disagree for reasons other than the turn,
   * so `resolveModelRoute('judge', …)` would read as tidier and silently make
   * every judge the same model. The spend label stays `judge` because that is
   * what the work IS, and the EFFORT stays on the stage table for the reason
   * the header gives.
   */
  @callable()
  async runOutcomeEnsemble(specs?: string[]): Promise<EnsembleRunResult> {
    const registry = this.providerRegistry();
    const turnRoute = resolveModelRoute('agent', await this.routingProfile());
    return runEnsemble(this.boundSql, this.actorHandle(), {
      specs: async () => (await resolveEnsembleJudgeSelection({
        registry,
        specs: specs ?? null,
        chatSpec: turnRoute?.model ?? this.getStoredModelId(),
      })).specs,
      judge: (spec) => ({
        spec,
        llm: createCompletionLLM({
          model: registry.resolveModel(spec), spec, stage: 'judge',
          // One call per judge per hand-labelled turn, on a model deliberately
          // chosen from a different vendor family than the graded turns' — so
          // this is spend the actor's own catalog rate cannot price and the step
          // telemetry never saw.
          spend: {
            source: 'judge', report: (report) => this.reportModelCall(report),
            operations: this.modelOperations,
          },
        }),
      }),
    });
  }

  /** One GEPA run in full: its candidates (scores/feedback per instance) +
   *  the Pareto-front membership — drives the Exploration surface's Pareto
   *  scatter + ancestry tree. Maps are flattened to plain objects for RPC. */
  @callable()
  async getGepaRun(runId: string): Promise<{
    run: GepaRunSummary | null;
    candidates: Array<{
      id: string; parentId: string | null; source: string;
      scores: Record<string, number>; feedback: Record<string, string>;
      aggregateScore: number; createdAt: number;
    }>;
    pareto: Array<{ candidateId: string; instanceId: string; score: number }>;
  }> {
    try {
      const run = listGepaRuns(this.boundSql, this.actorHandle(), 200).find((r) => r.runId === runId) ?? null;
      const candidates = loadGepaCandidates(this.boundSql, this.actorHandle(), runId).map((c) => ({
        id: c.id, parentId: c.parentId, source: c.source,
        scores: Object.fromEntries(c.scores), feedback: Object.fromEntries(c.feedback),
        aggregateScore: c.aggregateScore, createdAt: c.createdAt,
      }));
      // The membership table is core's; its loader derives the front from the
      // rows that persist. No raw SELECT across the package boundary.
      const pareto = loadGepaParetoFront(this.boundSql, this.actorHandle(), runId);
      return { run, candidates, pareto };
    } catch (error) {
      if (classify({ cause: error }) !== 'sqlite-missing-table') throw error;
      return { run: null, candidates: [], pareto: [] };
    }
  }

  /**
   * The cumulative workspace change-set since the baseline — what the agent has
   * created/changed/deleted, for review on the Output surface. The baseline is
   * captured at workspace birth and re-markable via resetWorkspaceBaseline
   * ("mark reviewed"). A read never changes the review boundary.
   */
  async getWorkspaceDiff(): Promise<WorkspaceDiffResult> {
    return getWorkspaceDiff(this.rt);
  }

  /** General per-executor change-set: the VFS snapshot baseline for the agent
   *  workspace, a real `git diff` of /workspace for shell executors. */
  @callable()
  async getExecutorDiff(executorId: string): Promise<ExecutorDiffResult> {
    return getExecutorDiff(this.rt, executorId);
  }

  /** Mark the current workspace as the new baseline ("reviewed" — the diff
   *  resets to empty and accrues from here). */
  @callable()
  async resetWorkspaceBaseline(): Promise<{ ok: true; files: number }> {
    return resetWorkspaceBaseline(this.rt);
  }

  /** Recent branching-head runs (think strategy=heads): each split grouped by
   *  root_id with its heads (incl. the ordered per-head step trace) + the merged
   *  synthesis — drives the Exploration surface's Branches strip. */
  @callable()
  async getHeadRuns(limit: number = 20): Promise<HeadRunView[]> {
    return this.headJournal.listRuns(limit);
  }

  /** One merged fork's journal, independent of unrelated recent head runs. */
  @callable()
  async getHeadRun(rootId: string): Promise<HeadRunView | null> {
    return this.headJournal.readRun(rootId);
  }

  /**
   * One branch's whole behaviour — the transcript the Exploration surfaces open
   * when a node is clicked.
   *
   * One entry point across both fork mechanisms, unlike `getHeadRun` /
   * `getSearchTree`: a reader who clicked a node wants the task, the steps and
   * the answer whatever strategy produced it, and making the CLIENT choose the
   * store is how the explorer ended up showing a one-line footer chip for a
   * search node and nothing at all for a head. Core decides; see
   * read-models/node-transcript.ts for what each store can honestly report.
   */
  @callable()
  async getNodeTranscript(runId: string, nodeId: string, request?: PageRequest): Promise<NodeTranscriptView | null> {
    return readNodeTranscript(this.boundSql, this.actorHandle(), runId, nodeId, request ?? {});
  }

  /**
   * One finished step of a head, written into the journal as it lands.
   *
   * A head runs in a FACET with its own storage, and the journal lives here — so
   * the write has to come back over RPC, exactly as the mission ledger's
   * per-step guard/debit does (`missionGuard`/`missionDebit`). Without this the
   * whole trace path was declared and connected nowhere: `head_steps` existed,
   * `HeadJournal.appendStep` existed with no callers, and
   * `HeadInferenceDeps.reportStep` was an optional seam with no provider, so
   * `await deps.reportStep?.(…)` silently no-opped on every step of every head.
   * The visible consequence was every branch reading `STEPS 0 · TOOLS 0` with
   * "no step trace" for its whole life, running or finished.
   *
   * Announced as well as written, so an open transcript grows as the branch
   * works instead of on a poll clock. The step itself is NOT on the wire: the
   * same reasoning as `pending_actions_changed` — the client re-reads the ledger
   * it already renders from, so one channel cannot start disagreeing with the
   * other, and a subscriber that missed a frame is corrected by the next one.
   *
   * TRACED, and it is the cheapest span with the highest leverage here: every
   * step of every head and every node blocks on this RPC, so its duration is on
   * the critical path of the whole search. A journal write that has gone slow
   * looks exactly like a facet that has gone quiet.
   */
  @callable()
  async recordHeadStep(headId: string, seq: number, step: HeadStep): Promise<{ ok: true }> {
    return await this.tracing.invocation('rpc', 'head.record_step', async (_invocation, span) => {
      span.setAttribute('kinu.head_id', headId);
      span.setAttribute('kinu.step_seq', seq);
      // The announcement rides the journal write itself (LiveHeadJournal), so
      // it happens once whether a step arrives through this RPC from a hosted
      // facet or straight from an in-isolate node that has no facet at all.
      this.headJournal.appendStep(headId, seq, step);
      return { ok: true };
    });
  }

  /**
   * `publishHeadStreamFrame` is the in-process head-stream publisher, reached
   * through `reportNodeDelta` and `ExplorationHostSeams.publishDelta`; an
   * inbound forwarding RPC would duplicate that implementation (reachability
   * reference: 0b6d36886). The RPC allowlist exposes only required remote
   * capabilities, so local publication does not create another transport entry.
   */

  /**
   * The immutable turn profile a facet of this workspace runs under.
   *
   * A facet resolves its own model, its own provider registry and its own
   * runtime, but it must NOT resolve its own profile. Two reasons, and the
   * second is the one that bit:
   *
   *   • `MODEL_ROUTE_POLICY.mcts`, `.head` and `.swarm` are `invocation` —
   *     the tier the ACTIVE ROLE selected for this turn. A facet knows neither
   *     the role nor the turn, so a locally resolved profile would answer a
   *     different question and quietly run the account default while the turn
   *     it belongs to ran somewhere else.
   *   • A second resolution can disagree with the first. The provider snapshot
   *     moves whenever a credential does, so a facet resolving moments later
   *     can land a different `providerRevision` and a different digest — and a
   *     search whose branches ran under a profile the parent never resolved is
   *     unreproducible for exactly the reason the digest exists.
   *
   * So the parent's profile is the answer, and this is the one wire it crosses.
   * `routingProfile()` returns the live turn's profile when a turn is open and
   * resolves one otherwise, which is what a durable head that outlived its
   * turn needs.
   */

  /**
   * One page of this workspace's portable archive — the owner's own copy of
   * everything the workspace durably holds, in the same format the local
   * backend writes and `kinu import` reads.
   *
   * Paged because a workspace's SQL rows and Nimbus files have no bounded
   * size, and neither a DO response nor an isolate's memory should have to hold
   * all of it: the caller walks `next` until it is null and appends each page's
   * lines to a file. Owner-scoped by the RPC access table
   * ('interactive' — a scoped CI token is denied on every transport) on top of
   * the ownership check every workspace route already makes. Workspace
   * capability tiers do not gate it: this reads the workspace's own storage
   * for the owner who asked, and reaches nothing in the wider account.
   */
  @callable()
  async exportWorkspaceArchive(cursor?: ArchiveCursor): Promise<ArchivePage> {
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) throw new Error('Cannot export an unclaimed workspace.');
    const workspace = this.hostedWorkspace().bundle;
    return readWorkspaceArchivePage(this.ctx.storage.sql, {
      workspace: this.name,
      source: 'cloud',
      cursor: parseArchiveCursor(cursor),
      files: workspaceArchiveFiles(workspace),
    });
  }

  /** Tear down every per-agent resource, then wipe this Durable Object. Called
   *  by UserDO.removeWorkspace on delete so a same-name recreate starts clean and
   *  no orphaned alarm / process / port lingers.
   *
   *  The optional Sandbox container goes first because it is the one plane that
   *  is somewhere else: its teardown can fail without touching the workspace,
   *  and once its storage is gone nothing knows which R2 objects were its. The
   *  WORKSPACE needs no step of its own — its tables are rows in THIS object, so
   *  `this.destroy()` drops the filesystem, the conversation and the ledgers in
   *  one teardown. That is why a same-name recreate cannot find half a
   *  workspace: there is no second object to be out of step with.
   *
   *  Deliberately NOT @callable: destruction goes through UserDO's ownership
   *  check, never the raw websocket. */
  async destroyAgent(expectedOwnerUserId: string): Promise<{ ok: true }> {
    if (!/^[a-f0-9]{32}$/.test(expectedOwnerUserId)) throw new Error('invalid expected owner user id');
    const ownerUserId = this.getOwnerUserId();
    if (ownerUserId !== expectedOwnerUserId) throw new Error('Agent owner mismatch; refusing to destroy.');
    // FIRST, and before the container object's own token store is deleted with
    // it: every preview URL this workspace published stops resolving at the
    // edge. Without this, a URL somebody still holds — chat history, a
    // screenshot, a bookmark — would prove an exposure whose object no longer
    // exists, and answering it would CREATE a fresh empty container object.
    // One write, no enumeration: the watermark outranks every record published
    // before now (lib/preview-exposures.ts).
    if (this.env.AUTH_KV) {
      await sandboxPreviewExposures(
        this.env.AUTH_KV, sandboxIdForWorkspace(this.name),
      ).revokeAll();
    }
    if (this.env.Sandbox) {
      // {@link SANDBOX_TRANSPORT} — the SDK drops in-flight requests if the
      // transport changes between calls on one sandbox, so the constant is the
      // agreement. The measured reasoning for `rpc` lives on the constant.
      const sb = getSandbox(this.env.Sandbox, sandboxIdForWorkspace(this.name), {
        normalizeId: true, transport: SANDBOX_TRANSPORT,
      });
      // Before destroy(): the container object owns its /workspace snapshot, and
      // once its storage is gone nothing knows which R2 objects were its.
      await sb.discardState();
      await sb.destroy();
    }
    // agents base: drops SDK tables + deleteAlarm + deleteAll + aborts the
    // isolate. `deleteAll` is what takes the workspace filesystem with it.
    await this.destroy();
    return { ok: true };
  }

  /** The agent's world model — keyed agent_facts, most-recent first — for the
   *  Self surface. Wraps FactsStore (otherwise consumed only internally for
   *  prompt injection). */
  @callable()
  async getFacts(limit: number = 100): Promise<Array<{
    key: string; value: unknown; confidence: number; source: string; lastObservedAt: number;
  }>> {
    return this.facts.recentTopK(limit).map((f) => ({
      key: f.key, value: f.value, confidence: f.confidence, source: f.source, lastObservedAt: f.lastObservedAt,
    }));
  }

  /** Run a scaffold against a task and return the concatenated text it
   *  produced. With candidateCode it is the GEPA metric's rollout; without,
   *  it rolls the LIVE scaffold — the replay-eval harness's current-config
   *  runner. */
  private runScaffoldCaptureText(task: string, candidateCode?: string): Promise<string> {
    return runScaffoldCaptureText(this.scaffoldControl, task, candidateCode);
  }

  // ── Durable run-event log — read endpoints + run listing ──

  /**
   * Paginated read of a single run's events. For SSE-style resume, pass
   * the last seen `since` index and the recorder returns events strictly
   * after it.
   */
  async getRunEvents(runId: string, opts?: RunEventQuery): Promise<RunEvent[]> {
    return getRunEvents(this.eventRecorder, runId, opts);
  }

  /** Cross-DO wire form for Worker HTTP and MCP adapters. */
  async getRunEventsWire(runId: string, opts?: RunEventQuery): Promise<string> {
    return JSON.stringify(await this.getRunEvents(runId, opts));
  }

  /**
   * A page of the agent's recent runs with each one's latest timestamp and event
   * count, newest first.
   *
   * Not `@callable()` — the web UI reads runs through `getRunSummaries`. This
   * serves the `/runs` HTTP route, the MCP tool and the CLI, and it is cursored
   * for the same reason they are: those callers pass a limit and had no way to
   * learn whether it had cut anything off.
   */
  async listRuns(request?: PageRequest): Promise<Page<RunListEntry>> {
    return listRuns(this.eventRecorder, request?.cursor ?? null, request?.limit);
  }

  /** Owner-only inspection of retained subordinate paths. */
  @callable()
  async inspectSubordinate(request: SubordinateInspectionRequest): Promise<SubordinateInspectionResult> {
    const owner = this.getOwnerUserId();
    if (!owner) throw new KinuError('denied', 'The workspace has no owner.');
    return this.inspectSubordinateStorage(request, { owner, workspace: this.name });
  }

  /**
   * ONE hosted actor's own identity, program and open work, for the tab that is
   * looking at it.
   *
   * ONE allowlist row for this capability, and nothing beside it. The display
   * name, the role, the plan and the steers are `actor_id`-scoped rows in the one
   * workspace database, so the question is six local reads answered in process —
   * a private per-facet database is the only thing that would force an RPC into a
   * second isolate over a stub for them.
   *
   * NAMED FOR THE ACTOR, not the kind. Every kind is an actor, so a snapshot
   * keyed to `subordinate` would be stale vocabulary on the day it landed. The SHAPE is honestly subordinate-shaped today and the name does not
   * pretend otherwise: `mission` comes off the hire's birth seed, which a head
   * or a node does not have — they carry a task and a rootId instead. So this
   * serves any actor whose row the directory resolves, and a head asking it
   * would get `mission: ''` rather than a lie; widening the shape for the
   * exploration kinds is a change to the payload, not to this seam.
   *
   * READ-ONLY AND IT STARTS NOTHING: `bindStores`, never `acquire`. Reading a
   * retained actor must not start work — an inspection RPC that acquired would
   * break that invariant from outside the object, where core's own host suite
   * cannot see it.
   *
   * AUTHORISED TWICE OVER. The workspace must have an owner, as every other
   * owner-gated read here requires; and the name is resolved THROUGH THE
   * DIRECTORY under this root's own handle, so it can only name a child of this
   * root. A browser-reachable read that answered for any actor id handed to it
   * would be the first cross-actor read reachable from outside this object.
   */
  @callable()
  async getActorSnapshot(name: string) {
    if (!this.getOwnerUserId()) throw new KinuError('denied', 'The workspace has no owner.');
    const entry = this.subordinateRoster.requireExisting(name);
    const reference = this.actorDirectoryStore().apply(
      actorReferenceOf(this.actorHandle()), [], { action: 'resolve', name },
    ).reference;
    const child = this.actorHost().bindStores(reference);
    return {
      name: entry.name,
      displayName: child.stores.config.getDisplayName() ?? entry.name,
      role: child.stores.config.getRoleSelection(),
      mission: entry.birth?.seed.mission ?? '',
      model: child.stores.config.getModel(),
      activePlan: child.stores.planReviews.getActive('default'),
      // The child's OWN acknowledged-but-not-landed steers, read with the
      // child's actor id rather than this root's — the same rows and the same
      // ordering `pendingSteerRuns()` reads for the workspace actor.
      pendingSteers: this.boundSql<{ id: string; text: string }>`
        SELECT id, text FROM pending_steers
        WHERE actor_id = ${child.handle.actorId} ORDER BY seq ASC`
        .map((row) => ({ ...row, state: 'queued' as const, atStep: null })),
    };
  }

  /**
   * A facet of this workspace has a new plan revision, and this workspace's own
   * clients are told a REFERENCE to it — nothing else.
   *
   * NATIVE ONLY, and deliberately its own name rather than the inherited
   * `broadcast`. `sealRpcSurface` shadows every unlisted member as an own
   * property, which leaves it callable in process and unresolvable over a stub,
   * so `broadcast` is not something a facet can reach and must not become
   * something a facet can reach: a generic string channel to every connected
   * client is the one hole this file's allowlist exists to keep shut. This
   * takes a parsed reference, spells the event name here, and can carry nothing
   * else. Not `@callable`, exactly like `workspaceBoxOp` and `supervisorOp`:
   * reachable by a Durable Object stub in this Worker, unreachable from the
   * browser or the CLI.
   *
   * BROADCAST ONLY: no SQL write, no state, nothing read back, and no plan body
   * — the same shape as {@link publishHeadStream}, for the same reason. It is a
   * HINT. The recipient re-reads the exact reference through the owner-gated
   * `inspectSubordinate`, which verifies every stored ownership hop, before it
   * displays or focuses anything; that read, not this call, is the authority.
   *
   * The one check worth making here is the one this object can answer from its
   * OWN records without trusting its caller: the actor named at the head of the
   * path has to be on this workspace's roster. A stub call carries no caller
   * identity, so this cannot prove WHICH facet is speaking — which is exactly
   * why the reader's authoritative read is where authority lives, and why a
   * hint that survives this check still buys nothing it was not already owed.
   */
  async announceSubordinatePlan(reference: WorkspacePlanReference): Promise<void> {
    const parsed = v.parse(WorkspacePlanReferenceSchema, reference);
    const name = parsed.path[0];
    if (!name || !this.subordinateRoster.get(name)) {
      throw new KinuError('denied', 'This workspace has no such plan actor.');
    }
    this.broadcast(JSON.stringify({ type: 'workspace_plan_updated', reference: parsed }));
  }

  @callable()
  async getRunSummaries(request?: PageRequest): Promise<Page<RunSummary>> {
    return getRunSummaries(this.eventRecorder, request?.cursor ?? null, request?.limit);
  }

  /**
   * The Activity surface: what the newest request cost, what it was made of,
   * how the recent ones have behaved — and what the WHOLE workspace spent.
   *
   * `steps` bounds the SAMPLE and nothing else. `telemetry` is a distribution
   * over recent steps — a cache-hit EMA and a p95 — so it needs a window, and
   * the bound comes back on the result so a reader can see what the rates are
   * over. `spend` is a SUM and takes no window at all: it is summed in SQL over
   * every row the log holds, so no `steps` a caller passes can turn the
   * workspace total into a floor. Were that possible it would be invisible: a
   * caller asking for 2000 gets 400, and the panel says "newest 400 rows" in
   * small text beside a figure the owner decides on.
   *
   * `telemetry` and `spend` answer two different questions and are deliberately
   * not merged. `telemetry` is THIS AGENT'S OWN TURNS: its prefix-cache EMA only
   * means something over one prompt lineage, and a judge's cold prompt in that
   * window would read as a cache regression the agent never had. `spend` is every
   * producer in the workspace, grouped, with its own coverage fraction — the
   * answer to "is this all of the usage, including the async models".
   */
  @callable()
  async getActivitySnapshot(opts?: { steps?: number; logs?: number }): Promise<ActivitySnapshot> {
    const windowLimit = clampLimit(opts?.steps, ACTIVITY_STEP_WINDOW);
    const logLimit = clampLimit(opts?.logs, ACTIVITY_LOG_WINDOW);
    const events = this.eventRecorder.readRecentByType('step_finish', windowLimit);
    const steps = events.flatMap((e) => (e.type === 'step_finish' ? [e] : []));
    // An all-absent Usage is still a truthy object, so "the provider said
    // something" is `usageReported` — never a presence check on the field.
    const measured = steps.filter((e) => usageReported(e.usage ?? {}));
    const newest = measured[measured.length - 1];
    return {
      latest: newest === undefined
        ? null
        : {
          at: Date.parse(newest.timestamp) || Date.now(),
          runId: newest.runId,
          stepIndex: newest.stepIndex,
          // Non-empty by construction: `measured` kept only reporting steps.
          usage: newest.usage ?? {},
          context: newest.context ?? null,
        },
      // Null rather than a default: a share-of-window shown against a guessed
      // window would be a made-up percentage.
      contextWindow: this.sessionContextWindow() || null,
      // Every step in the window, reporting or not: `summarizeSteps` counts the
      // silent ones into `stepsWithoutUsage` so the totals carry their own
      // denominator instead of quietly under-counting.
      telemetry: summarizeSteps(steps, { windowLimit }),
      // Both axes of the same money, from one read: the producer rows and the
      // per-mission rows. `this.budget.snapshot()` is deliberately NOT read
      // beside it — it answers a narrower question (the labels the turn in
      // flight is under) out of the same ledger, and two mission figures on one
      // panel is how a reader learns to distrust both. No window: the producer
      // rows are summed over the whole log, so this is the total rather than the
      // newest slice of it.
      spend: workspaceSpend({ events: this.eventRecorder, sql: this.boundSql, actor: this.actorHandle() }),
      log: readActivityLog(this.boundSql, this.actorHandle(), logLimit),
    };
  }

  // ── MCP server bridge — small RPCs the MCP handler needs ──
  /** Used by the /mcp/v1/<name> save_note tool. Routes through the same
   *  appendMemoryNote primitive as workspace.saveNote + the `memory` builtin. */
  async saveNoteFromMcp(content: string): Promise<{ ok: true }> {
    await appendMemoryNote(this.rt.memory, content);
    return { ok: true };
  }

  /** MCP `run_task`: deliver a task signal through the SAME seam the event→turn
   *  reactor and background-job wake use. Not a new execution path.
   *
   *  The words are whoever is driving the MCP client — the operator, not the
   *  harness — so the signal names its author and the chat keeps its bubble. */
  async runTaskFromMcp(text: string): Promise<EnqueueTurnResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('run_task requires non-empty text');
    const outcome = await this.orch.signals.deliver({
      kind: 'mcp', text: trimmed,
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator' },
    });
    return { status: outcome === 'undelivered' ? 'skipped' : 'queued' };
  }

  /** MCP `send_peer`: fire-and-forget a message to one of the owner's other
   *  agents over the exact peer-deps transport (owner + same-owner roster
   *  gate enforced inside getPeersToolDeps). */
  async sendPeerFromMcp(input: { agent: string; topic?: string; message: string }): Promise<PeerSendOutcome> {
    if (!input?.agent || !input?.message) throw new Error('send_peer requires agent and message');
    return this.getPeersToolDeps().send({
      agent: input.agent,
      topic: (input.topic ?? '').trim() || 'message',
      message: input.message,
      mode: 'build',
    });
  }

  /** MCP `send_peer` roster helper — the owner's other agents (self excluded). */
  async listPeersFromMcp(): Promise<Array<{ name: string; displayName?: string }>> {
    return this.getPeersToolDeps().listPeers();
  }

  // ── Hybrid memory search — FTS5 + Vectorize via RRF ──
  /**
   * Semantic + lexical search merged via Reciprocal Rank Fusion.
   * Falls back to pure FTS5 when the Vectorize binding isn't configured.
   *
   * Returns enriched HybridHit[] with sources, RRF score, and individual
   * lexical/semantic scores when available. THE one memory-search surface for
   * every remote caller — browser rpc, the CLI /rpc transport, MCP
   * search_memory — one behavior everywhere.
   */
  @callable() async searchMemoryHybrid(query: string, limit: number = 10): Promise<HybridHit[]> {
    const lexicalSearchFn = async (q: string, k: number) => {
      const results = await this.rt.memory.search(q, k);
      return results.map((r) => ({
        // Canonical chunk id (`path:start-end`) — matches the id the vector
        // store returns, so RRF fuses the lexical and semantic hits.
        id: `${r.path}:${r.startLine}-${r.endLine}`,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: r.snippet,
      }));
    };
    return hybridSearch(query, lexicalSearchFn, this.rt.vectorStore, {
      finalK: limit, rehydrate: memorySnippetRehydrator(this.rt.memory),
    });
  }

  @callable() async getMemoryContent() {
    // `read` returns null only for an absent file; every other VFS failure
    // throws, and must — "" is indistinguishable from an empty MEMORY.md.
    return await this.rt.memory.read("memory/MEMORY.md") ?? "";
  }

  /** The workspace root's read models, held to workspace.read by unit-slate-sources. */
  protected override async slateReadModel(source: SlateReadModel): Promise<JsonValue> {
    const reads = {
      getAlignmentConvergence: () => this.getAlignmentConvergence(),
      getExecutors: () => this.getExecutors(),
      getGepaRuns: () => this.getGepaRuns(),
      getHeadRuns: () => this.getHeadRuns(),
      getMctsTree: () => this.getMctsTree(),
      getOutcomeCalibration: () => this.getOutcomeCalibration(),
      getReleaseBoard: () => this.getReleaseBoard(),
      getRunTimeline: () => this.getRunTimeline(),
      getToolDescriptions: () => this.getToolDescriptions(),
      getWorkspaceSnapshot: () => this.getWorkspaceSnapshot(),
      listBackgroundJobs: () => this.listBackgroundJobs(),
      listTriggers: () => this.listTriggers(),
    };
    return v.parse(JsonValueSchema, await reads[source]());
  }

  /** The owner's browser acting on its own workspace: the root caller, minted here. */
  @callable() async slate(operation: SlateOperation): Promise<SlateCallResult> {
    return this.slates.operation(this.slateCaller(), operation);
  }

  /** An actor of this workspace acting as itself; DO-only, like `workspaceBoxOp`. */
  async slateAs(caller: SlateCaller, operation: SlateOperation): Promise<SlateCallResult> {
    return this.slates.operation(caller, operation);
  }

  private _slates: SlateHost | undefined;

  private get slates(): SlateHost {
    this._slates ??= new SlateHost({
      ctx: this.ctx, env: this.env, workspace: this.name,
      session: () => this.hostedWorkspace().bundle.session(),
      registerPort: (pid, port, target, owner) => this.hostedWorkspace().registerPort(pid, port, target, owner),
      unregisterPorts: (pid) => this.hostedWorkspace().unregisterPorts(pid),
      dispatch: (caller, route) => this.slateBindingDispatch(caller.path, route, caller.workMode),
      expose: async (port) => {
        const ports = this.hostedWorkspace().box('agent:main').ports;
        if (!ports?.expose) throw new KinuError('unsupported', 'Workspace port exposure is not available');
        return ports.expose(port);
      },
    });
    return this._slates;
  }

  async slateBindingCallAs(caller: SlateCaller, id: string, name: string, request: SlateBindingRequest): Promise<SlateCallResult> {
    return this.slates.bindingCall(caller, id, name, request);
  }

  @callable() async listSlates() {
    return this.slates.list(ROOT_SLATE_CALLER);
  }

  @callable() async previewSlate(id: string): Promise<SlateCallResult> {
    return this.slates.preview(ROOT_SLATE_CALLER, id);
  }

  @callable() async getToolDescriptions() {
    // Descriptions AND reach sourced from @kinu.run/core/tools/registry — one
    // truth for both. Guessing reach here as
    // `nativeNames.has(name) ? 'native' : 'codemode'` is a binary that cannot
    // express "this actor has it on neither surface": `report` is the one
    // deps-gated builtin, so on an orchestrator it falls out of the else-branch
    // and the Tools panel reads "code mode" — false twice over, because `report`
    // is native wherever it exists and its `report.*` namespace is wired only
    // on a subordinate. The two facts are reported separately, because they
    // are two facts: what the capability IS (declared) and what this actor
    // WIRES (observed from the ToolSet the turn actually built).
    const wiredNames = new Set(Object.keys(this.getRawTools()));
    const builtIn = BUILTIN_TOOLS.map(name => ({
      name,
      // Both registers, from the one spec: the headline a list row shows and
      // the docstring the model is given. The UI must never recover one from
      // the other by splitting text.
      summary: BUILTIN_TOOL_SPECS[name].summary,
      description: BUILTIN_TOOL_DESCRIPTIONS[name],
      // Every name in BUILTIN_TOOLS is native by type (BuiltinToolName is
      // derived from the declaration), so owning a codemode namespace is what
      // makes it both.
      exposure: TOOL_REACH[name].codemode ? 'both' as const : 'native' as const,
      wired: wiredNames.has(name),
    }));
    const craftedRaw = this.rt.craftStore.list();
    const crafted = craftedRaw.map(t => {
      // Quality lives on the crafted_tools row, so there is no craft_scores table to join.
      const scoreRow = this.sql<{ score: number; uses: number }>`
        SELECT score, uses FROM crafted_tools
      WHERE actor_id = ${this.actorHandle().actorId} AND name = ${t.name} LIMIT 1`;
      return {
        name: t.name,
        description: t.description || "Crafted tool",
        isLearned: true,
        // A crafted tool is never a ToolSet entry — buildCraftedToolSetFromExecute
        // routes it through createExecuteTool's providers — so codemode is its
        // reach by construction, and it is wired exactly when the store holds it.
        exposure: 'codemode' as const,
        wired: true,
        qualityScore: scoreRow[0]?.score ?? 0.5,
        usageCount: scoreRow[0]?.uses ?? 0,
      };
    });
    const executors = this.rt.executionRouter?.listExecutors() ?? [];
    return { builtIn, crafted, executors };
  }

  // setModel moved below — validates spec via the provider registry before storing.

  @callable() async setDisplayName(displayName: string) {
    await this.propagateDisplayName(displayName, 'user');
    return { displayName };
  }

  async setAutoDisplayName(displayName: string) {
    const applied = await this.propagateDisplayName(displayName, 'auto');
    return { displayName: applied ? displayName : this.getDisplayName(), applied };
  }

  async setInitialDisplayName(displayName: string, nameOrigin: 'user' | 'auto') {
    // Genesis only, right after the create path registered the row in the
    // root registry. The activation cache is seeded from what was just
    // written; the root remains the authority.
    this._titleCache = { displayName, nameOrigin };
    this._titleHydrated = true;
    return { displayName, nameOrigin };
  }

  /**
   * The workspace's first turn, taken by the agent instead of waited for.
   *
   * Deliberately NOT `@callable`: a client cannot fabricate a genesis turn.
   * Creation calls it once, last, so the mission, model and reasoning effort the
   * turn runs under are already durable.
   *
   * Returns as soon as the turn is queued. Think's `saveMessages` — which
   * `BackendHost.enqueueTurn` awaits — resolves only when the turn ENDS, so
   * awaiting it here would hold the create request open for the whole turn and
   * the New workspace dialog would sit there. The agents-SDK heartbeat holds
   * the DO instead, exactly as the drain timer does.
   */
  async beginGenesisTurn(): Promise<{ started: boolean }> {
    const signal = workspaceGenesisSignal(readMission(this.boundSql));
    if (!signal) return { started: false };
    this.detachOwned(async () => {
      try {
        await this.keepAliveWhile(() => this.orch.signals.deliver(signal));
      } catch (cause) {
        diagnostics.failure('genesis.turn_failed', toKinuError({
          doing: "taking the workspace's first turn", cause, otherwise: 'unavailable',
        }), { workspace: this.name });
      }
    });
    return { started: true };
  }

  @callable() async getExecutors() {
    return this.rt.executionRouter?.listExecutors() ?? [];
  }

  /** The environments behind the unified file browser — one row per executor
   *  that has a filesystem, with live state and how durable it is. */
  @callable() async listMounts() {
    return this.rt.executionRouter ? listEnvironments(this.rt.executionRouter) : [];
  }

  /** Browser-only subordinate controls. These delegate to the exact same
   *  orchestration policy as the model's agents tool, including rollback and the
   *  authoritative roster broadcast. */
  @callable() async listSubordinates(): Promise<SubordinateRosterEntry[]> {
    return this.subordinateViews();
  }

  /**
   * Add an agent to this workspace with nothing said about it.
   *
   * The whole point is that the owner supplies NOTHING: no name, no mission,
   * no role. It inherits this workspace's mission, runs as the catalog's
   * `general`, and comes back with a blank `displayName` — which is not a gap
   * to fill in with a placeholder string but the state the first-interaction
   * title policy reads (`SubordinateAgent.onChatResponse`). Its `name` is a
   * stable slug and is the thing to route to.
   */
  @callable() async createSubordinateAgent(): Promise<{
    name: string;
    displayName: string;
    subordinate: SubordinateRosterEntry;
  }> {
    const result = await this.getTeamToolDeps().create({});
    return {
      ...result,
      subordinate: await this.subordinateView(result.subordinate.name),
    };
  }

  /** Retitle one of this workspace's agents. Writes the child and this
   *  authoritative roster row together and marks the title the OWNER'S, which
   *  is what stops it being auto-titled afterwards. */
  @callable() async renameSubordinateAgent(name: string, displayName: string): Promise<{
    ok: true;
    name: string;
    displayName: string;
    subordinate: SubordinateRosterEntry;
  }> {
    const result = await this.getTeamToolDeps().rename({ name, displayName });
    return {
      ...result,
      subordinate: await this.subordinateView(result.subordinate.name),
    };
  }

  @callable() async dismissSubordinate(name: string): Promise<{
    ok: true;
    name: string;
    historyKept: boolean;
  }> {
    return this.getTeamToolDeps().dismiss({ name, requestedBy: 'user' });
  }

  /**
   * Recent commands on one executor, with each stream CLIPPED to
   * {@link EXECUTOR_OUTPUT_CLIP} characters and its true length beside it.
   *
   * The clip is the fix for a measured unbounded read, not a nicety. `stdout`
   * holds whatever a command printed, an agent's command may print a file, and
   * this read is on the workspace's initial load: one production workspace
   * answered 12.89 MiB across 36 rows on 2026-08-20, five of them over 1.7 MiB
   * each, against a median row of 0.3 KiB. A terminal cannot render that and
   * the reader never asked for it.
   *
   * `stdout_len` is the whole row's length, so the pane states what it is not
   * showing instead of presenting a prefix as the output. SQLite counts TEXT in
   * characters for both `length` and `substr`, so the two agree.
   *
   * SCOPED TO THIS ACTOR, and the predicate is not optional: `executor_output`
   * is `PRIMARY KEY (actor_id, id)` and every write stamps the actor, so an
   * `executor` name alone matches a SIBLING's rows too — the workspace box is
   * shared, so two actors really do run commands on the same executor id. The
   * `(actor_id, created_at DESC, id DESC)` index is exactly this read's.
   */
  async getExecutorOutput(executorId: string, limit: number = 50) {
    return this.sql<ExecutorOutputRow>`SELECT id, executor, command,
        substr(stdout, 1, ${EXECUTOR_OUTPUT_CLIP}) AS stdout, length(stdout) AS stdout_len,
        substr(stderr, 1, ${EXECUTOR_OUTPUT_CLIP}) AS stderr, length(stderr) AS stderr_len,
        exit_code, created_at
      FROM executor_output
      WHERE actor_id = ${this.actorHandle().actorId} AND executor = ${executorId}
      ORDER BY created_at DESC LIMIT ${limit}`;
  }

  /**
   * One-round-trip initial load: what the workspace IS (status, tools, memory),
   * what it can run (executors and their recent output), and whether a plan is
   * waiting on the owner. A read that fails fails the snapshot — an empty tool
   * list is a claim about the workspace, and a per-field fallback makes a broken
   * read indistinguishable from a quiet one. Live updates arrive via the
   * granular refresh + events.
   *
   * The initial snapshot carries neither canvas nor timeline data: the canvas
   * measures 499 KiB and 824 KiB on the two production workspaces sampled on
   * 2026-08-20, and its thirty-run page would seed a tree map that Exploration
   * fetches for itself. A 250-span timeline seed has no component consumer,
   * while `kinu timeline` fetches it directly, so neither payload belongs on
   * the chat pane's opening critical path.
   */
  /** A reset owns no live branch fibers. Before a snapshot can say a branch is
   * running, seal every reportless branch head with one durable error report;
   * `recordReport` changes its status, so both the next PAGE and the next
   * activation exclude it — the mutation is the cursor. LIMIT-bounded because
   * this runs in the init gate; a pass that filled its budget answers
   * truncated and the caller arms the maintenance wake for the rest.
   */
  private reconcileOrphanedBranches(): boolean {
    const heads = this.headJournal.listRunningBranchHeads(
      STEER_BRANCH_RUN_ID_PREFIX, ORPHAN_SEAL_MAX_ROWS, this.activationStartedAt,
    );
    for (const head of heads) {
      this.headJournal.recordReport({
        id: head.id, status: 'errored',
        summary: 'Workspace restarted before the branch settled.',
        errorMessage: 'workspace restarted before the branch settled',
        evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [], toolCalls: [],
        stepCount: 0, usage: {}, wallClockMs: 0,
      });
      this.broadcastBranchStatus({ type: 'branch_status', status: 'error', branchId: head.rootId, task: head.task,
        message: 'workspace restarted before the branch settled' });
    }
    return heads.length >= ORPHAN_SEAL_MAX_ROWS;
  }

  /**
   * Whether the gated right-pane tabs have anything to show.
   *
   * Both facts come from the lane's OWN read path — the release board the
   * Releases surface reads and the fork-run list the Exploration surface reads —
   * asked at limit 1, because presence is a boolean and a full page here would
   * be a second copy of a list this method never renders.
   *
   * The client called this and read `tabPresence` off the snapshot from the day
   * the tabs were gated; neither existed on the server, so `tabPresence` arrived
   * `undefined`, `surfaceHasContent` fell back to its "unknown is not empty"
   * default, and BOTH gated tabs showed on a fresh workspace until the first
   * live tick failed. A gate whose server half is missing is not a gate.
   */
  @callable() async getWorkspaceTabPresence(): Promise<TabPresence> {
    // Same owner guard `listPendingActions` uses for the same cross-DO board
    // read: without an owner there is no release lane to have content in.
    const board = this.getOwnerUserId() ? await this.getReleaseBoard(1) : null;
    return {
      releases: (board?.changes.length ?? 0) > 0,
      explorations: listForkRuns(this.boundSql, this.actorHandle(), null, 1).items.length > 0,
    };
  }

  @callable()
  async getWorkspaceSnapshot() {
    const [status, tools, memoryContent, executors, activePlan, tabPresence, { slates }] = await Promise.all([
      this.getAgentStatus(),
      this.getToolDescriptions(),
      this.getMemoryContent(),
      this.getExecutors(),
      this.getActivePlanReview(),
      this.getWorkspaceTabPresence(),
      this.listSlates(),
    ]);
    const executorOutputs = await Promise.all(
      executors.map(async (e) => ({
        name: e.name,
        outputs: await this.getExecutorOutput(e.name, 50),
      })),
    );
    const lastActiveExecutor = this.config.getLastActiveExecutor();
    // Durable journal, never `_pendingBranches`: RAM is empty after reset while
    // the journal is the branch lifecycle authority.
    const branchRuns = this.headJournal.listRunningRuns()
      .filter((run) => run.rootId.startsWith('branch-') && run.status === 'running')
      .map((run) => ({ type: 'branch_status' as const, status: 'running' as const, branchId: run.rootId, task: run.task }));
    return {
      status, tools, memoryContent, executors, executorOutputs, lastActiveExecutor, activePlan,
      tabPresence, slates, pendingSteers: this.pendingSteerRuns(), branchRuns,
    };
  }

  @callable() async executeInExecutor(executorId: string, command: string, device?: string) {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { error: `Executor "${executorId}" not found`,
      refusal: refusalOf(new KinuError('missing', `Executor "${executorId}" not found`)) };
    if (!provider.isAvailable()) return { error: `Executor "${executorId}" is not available`,
      refusal: refusalOf(new KinuError('unavailable', `Executor "${executorId}" is not available`)) };

    const execTool = provider.tools.exec;
    if (!execTool) return { error: `Executor "${executorId}" has no exec tool`,
      refusal: refusalOf(new KinuError('unsupported', `Executor "${executorId}" has no exec tool`)) };
    // The fleet names its machine per call (docs/EXECUTION-LAYER-SPEC.md
    // "The user's account is a fleet"): device rides as the tool context
    // the laptop executor reads (readDeviceSelection), and a call that
    // carries none keeps today's unnamed answer. Tools that read no context
    // never see one.
    try {
      const result = v.parse(CommandResultSchema, device === undefined ? await execTool.execute(command) : await execTool.execute(command, { device }));
      const output = v.is(v.string(), result)
        ? { stdout: result, stderr: '', exitCode: 0 }
        : { stdout: result.error, stderr: result.error, exitCode: 1, refusal: result };

      void this.sql`INSERT INTO executor_output (actor_id, executor, command, stdout, stderr, exit_code)
        VALUES (${this.actorHandle().actorId}, ${executorId}, ${command}, ${output.stdout}, ${output.stderr}, ${output.exitCode})`;

      this.broadcast(JSON.stringify({
        type: 'executor-output', executor: executorId, command, ...output, timestamp: Date.now(),
      }));

      return output;
    } catch (err) {
      const refusal = refusalOf(toKinuError({ doing: 'execute on ' + executorId, cause: err, otherwise: 'io' }));
      const errMsg = refusal.error;
      void this.sql`INSERT INTO executor_output (actor_id, executor, command, stderr, exit_code)
        VALUES (${this.actorHandle().actorId}, ${executorId}, ${command}, ${errMsg}, ${1})`;
      // Broadcast on error too — symmetric with the success branch above.
      // Without this, the UI terminal silently swallows failures because
      // it renders only from broadcasts. (STABILITY-AUDIT §B4.)
      this.broadcast(JSON.stringify({
        type: 'executor-output', executor: executorId, command, stdout: '',
        stderr: errMsg, exitCode: 1, refusal, timestamp: Date.now(),
      }));
      return { error: errMsg, exitCode: 1, refusal };
    }
  }

  /** Typed directory listing for the file manager — read off each executor's
   *  own raw handle, in that environment's own paths. */
  @callable() async getExecutorFiles(executorId: string, path: string): Promise<{ path?: string; entries?: DirEntry[]; error?: string }> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };
    return getExecutorFiles(this.rt.executionRouter, executorId, path);
  }

  /** Read a single file's text content for the file-manager viewer. */
  @callable() async readExecutorFile(executorId: string, path: string): Promise<{ content?: string; truncated?: boolean; error?: string }> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };
    return readExecutorFile(this.rt.executionRouter, executorId, path);
  }


  /** Rename one entry for the file manager — native where the plane renames
   *  natively, a byte carry for a file elsewhere, a stated refusal for a
   *  directory that only bytes could carry. Never overwrites. */
  @callable() async renameExecutorFile(executorId: string, from: string, to: string): Promise<ExecutorWriteResult> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };
    return renameExecutorPathOp(this.rt.executionRouter, executorId, from, to);
  }

  /** Delete one entry for the file manager. A directory rides the plane's
   *  native tree removal where one exists and goes entry by entry elsewhere. */
  @callable() async deleteExecutorFile(executorId: string, path: string): Promise<ExecutorWriteResult> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };
    return deleteExecutorPathOp(this.rt.executionRouter, executorId, path);
  }


  // ── Chunked file transfer for the files HTTP route (files-routes.ts).
  //
  // No single Worker↔actor payload of that route approaches the catalogued
  // `do.facet.rpc_bytes` ceiling: uploads arrive as bounded chunks the actor
  // assembles, downloads leave as bounded chunks cut from one read. The actor
  // is single-threaded, so the maps below need no lock. HTTP routes close each
  // transfer on final chunk, error, or stream cancellation.
  private executorFileUploads = new Map<string, {
    readonly executorId: string;
    readonly path: string;
    readonly expectedRevision: number | undefined;
    readonly upload: ExecutorFileUpload;
  }>();
  private executorFileDownloads = new Map<string, ExecutorFileDownload>();

  async startExecutorFileDownload(
    executorId: string,
    path: string,
    transferId: string,
  ): Promise<
    { size: number }
    | { error: string; reason: 'too_large' | 'unavailable' }
  > {
    const router = this.rt.executionRouter;
    if (!router) return { error: 'no execution router', reason: 'unavailable' };
    if (!transferId) return { error: 'download transfer id required', reason: 'unavailable' };
    const download = new ExecutorFileDownload(router, executorId, path);
    this.executorFileDownloads.set(transferId, download);
    const opened = await download.open();
    if ('error' in opened) this.executorFileDownloads.delete(transferId);
    return opened;
  }

  /** One chunk of one HTTP download. The route supplies a fresh transfer id,
   * so a second GET of the same path cannot reuse stale bytes and concurrent
   * readers cannot replace each other's snapshot. */
  async readExecutorFileChunk(
    executorId: string,
    path: string,
    transferId: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Uint8Array } | { error: string }> {
    const router = this.rt.executionRouter;
    if (!router) return { error: 'no execution router' };
    if (!transferId) return { error: 'download transfer id required' };
    const download = this.executorFileDownloads.get(transferId);
    if (!download || !download.serves(executorId, path)) {
      return { error: 'file transfer out of sync: no matching open download' };
    }
    const result = await download.range(offset, length);
    if ('error' in result || download.completeAfter(offset + result.bytes.byteLength)) {
      this.executorFileDownloads.delete(transferId);
    }
    return result;
  }

  async abortExecutorFileDownload(transferId: string): Promise<void> {
    this.executorFileDownloads.delete(transferId);
  }

  /** One chunk of a chunked upload. An `offset === 0` chunk (re)starts the
   *  transfer for its path, so a retry after any failure self-heals instead
   *  of appending to stale bytes; ordering and continuity are enforced inside
   *  the transfer itself, never trusted from the caller. */
  async writeExecutorFileChunk(
    executorId: string,
    path: string,
    transferId: string,
    offset: number,
    chunk: Uint8Array,
    final: boolean,
    expectedRevision?: number,
  ): Promise<ExecutorWriteResult> {
    const router = this.rt.executionRouter;
    if (!router) return { error: 'no execution router' };
    if (!path) return { error: 'file path required' };
    if (!transferId) return { error: 'upload transfer id required' };
    let row = this.executorFileUploads.get(transferId);
    if (offset === 0) {
      row = {
        executorId,
        path,
        expectedRevision,
        upload: new ExecutorFileUpload(router, executorId, path, expectedRevision),
      };
      this.executorFileUploads.set(transferId, row);
    } else if (!row || row.executorId !== executorId || row.path !== path) {
      return { error: 'file transfer out of sync: no matching open upload' };
    } else if (row.expectedRevision !== expectedRevision) {
      return { error: 'file transfer out of sync: expected revision does not match the first chunk' };
    }
    const result = await row.upload.chunk(offset, chunk, final);
    if (row.upload.done) this.executorFileUploads.delete(transferId);
    return result;
  }

  async abortExecutorFileWrite(transferId: string): Promise<void> {
    this.executorFileUploads.get(transferId)?.upload.abort();
    this.executorFileUploads.delete(transferId);
  }

  /** The preflight an interactive terminal needs before a shell is opened onto
   *  this workspace's container: egress interception installed with THIS
   *  workspace's grants, and /workspace attached. Both are the sandbox lane's
   *  own `ensureReady`, so a terminal waits on exactly what an exec waits on
   *  rather than starting the container down a second path. Not a @callable:
   *  the caller is the terminal's HTTP route, which then upgrades the socket
   *  the chat rail cannot carry (see terminal-route.ts). */
  async prepareTerminal(executorId: string): Promise<{ ok: true } | { error: string }> {
    // The owner's own machine has no container to warm. What a terminal needs
    // there is a machine that is actually attached, and each answer below is
    // one a person can act on: a machine that was linked and is now offline
    // needs one command, and an account with none linked needs a different
    // one. "laptop has no terminal" was true until its agent grew one.
    if (executorId === 'laptop') {
      const device = this.rt.deviceTransport.status();
      if (device.connected) return { ok: true };
      if (device.registered) return { error: 'That machine is offline. Run `kinu connect` on it.' };
      return { error: 'No machine is linked to this account yet. Run `kinu connect` on the one you want.' };
    }
    if (executorId !== 'sandbox') return { error: `${executorId} has no terminal` };
    const handle = this.rt.sandboxHandle;
    if (!handle) return { error: 'the sandbox container is not configured for this workspace' };
    try {
      await handle.ensureReady();
      return { ok: true };
    } catch (cause) {
      // The chain, so the pane can show WHY: an attach that overran its budget
      // and a container the platform could not start are different problems
      // with different answers, and the outermost message tells them apart from
      // neither.
      return {
        error: renderCauseChain(toKinuError({
          doing: 'preparing the sandbox container for a terminal',
          cause,
          otherwise: 'unavailable',
        })),
      };
    }
  }

  /**
   * Open a terminal on the owner's machine for THIS workspace, and answer the
   * session its pane attaches to.
   *
   * The workspace asks, so the workspace's own confinement applies: the hub
   * composes the tier the owner set, the agent home under this workspace's
   * name, and the folders they consented to — the same block it composes for a
   * command. That is why this hop exists rather than the route calling the hub
   * itself: only this object holds the workspace's capability token, and a
   * terminal opened under any weaker identity would get no agent home and be
   * refused.
   *
   * `user` is the object that holds both sockets. The route needs it to send
   * the pane's upgrade to the same place the machine's own socket lives.
   */
  async openDeviceTerminal(
    window: { cols: number; rows: number },
  ): Promise<{ session: string; user: string } | { error: string }> {
    const user = this.getOwnerUserId();
    if (!user) return { error: 'this workspace has no owner yet' };
    try {
      const opened = await this.requireOwnerUserDO().openDeviceTerminal(
        await this.userCaller(), this.workspaceName(), window,
      );
      return { session: opened.session, user };
    } catch (cause) {
      // The chain, so the pane can show WHY. A declined grant, a machine that
      // cannot sandbox, an install too old to hold terminals and a machine
      // that went offline are four different problems with four different
      // answers, and each already carries its own words.
      return {
        error: renderCauseChain(toKinuError({
          doing: 'opening a terminal on this machine',
          cause,
          otherwise: 'unavailable',
        })),
      };
    }
  }

  /** Return exposed ports for one executor. Workspace registrations live in
   * Nimbus, so they remain authoritative after this actor restarts. */
  @callable() async getExposedPorts(executorId: string): Promise<{
    ports: Array<{ port: number; name?: string; url: string }>;
    error?: string;
  }> {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) {
      return executorId === 'sandbox'
        ? { ports: [] }
        : { ports: [], error: `${executorId} preview provider is unavailable` };
    }
    const status = provider.getStatus?.();
    if (status && !status.active && provider.kind !== 'workspace') {
      return { ports: [] };
    }
    if (!provider.listExposedPorts) {
      return { ports: [], error: `${executorId} cannot list exposed ports` };
    }
    try {
      const ports = await provider.listExposedPorts();
      return { ports: ports.map(({ port, name, url }) => ({ port, url, name })) };
    } catch (error) {
      return {
        ports: [],
        error: error instanceof Error && error.message
          ? error.message
          : `Couldn't list ${executorId} preview ports`,
      };
    }
  }

  @callable() async getReasoningEffort(): Promise<{ effort: ReasoningEffort | null }> {
    return getReasoningEffort(this.config);
  }

  @callable() async setReasoningEffort<Effort>(effort: Effort) {
    return setReasoningEffort(this.config, effort);
  }

  // ── Voyager curriculum: propose / list / accept next tasks ─────────

  @callable() async proposeCurriculumTasks(count?: number) {
    return { proposals: await proposeCurriculumTasks(this.rt, count) };
  }

  @callable() async listCurriculumTasks(status?: 'pending' | 'accepted' | 'rejected' | 'completed') {
    return { tasks: listProposedTasks(this.rt, status) };
  }

  @callable() async setCurriculumTaskStatus(
    id: string, status: 'pending' | 'accepted' | 'rejected' | 'completed',
  ) {
    updateProposedTaskStatus(this.rt, id, status);
    return { ok: true };
  }

  @callable() async setSoul(soul: string) {
    const text = soul.trim();
    if (!text) throw new Error('SOUL.md cannot be empty.');
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) throw new Error('SOUL.md is unavailable until the workspace owner claim completes.');
    await writeSoul(
      this.rt.storage.vfs,
      this.boundSql,
      text,
      (_path, content) => writeWorkspaceSoul(this.hostedWorkspace().bundle, content),
    );
    // The next turn re-reads the soul from the workspace filesystem.
    this._cachedSoulText = null;
    return { soul: text, purpose: summarizeSoul(text) };
  }

  @callable() async getMctsConfig(): Promise<MctsConfigView> {
    return getMctsConfig(this.config);
  }

  @callable() async setMctsConfig(config: Partial<MctsConfigView>) {
    return setMctsConfig(this.config, config);
  }

  @callable() async getEvolutionConfig(): Promise<EvolutionConfigView> {
    return getEvolutionConfig(this.config);
  }

  @callable() async setEvolutionConfig(config: Partial<EvolutionConfigView>): Promise<EvolutionConfigView> {
    return setEvolutionConfig(this.config, config);
  }


  // ── Fork RPCs ──────────────────────────────────────────────────

  /**
   * Fork this agent at a specific message, producing a new agent DO with:
   *   - SOUL.md copied, messages 0..N copied, crafted tools snapshotted,
   *     memory copied, actor_config copied (display_name overwritten)
   *   - search tree, evolution events, scaffold, crafted-tool quality RESET
   *
   * The driver is core's (identity/fork-driver.ts); what a Durable Object
   * contributes is the transport below — addressing a workspace that does not
   * exist yet — plus the web route the UI navigates to.
   *
   * See docs/WORKSPACES.md for the full spec.
   */
  @callable()
  async forkAgent(
    untilMessageId: string,
    opts?: { name?: string },
  ): Promise<{ id: string; name: string; url: string; forkPointMs: number }> {
    // Before anything is read: a fork of an unclaimed workspace has nobody to
    // own the copy, and the transport's own reservation would refuse it later
    // with a message about a name.
    this.requireOwnerForFork();
    const fork = await forkWorkspace({
      sql: this.boundSql,
      actor: this.rt.actor,
      // The workspace plane's own walk, with each inherited file streamed
      // through a native ranged read: a fork holds one frame of one file, never
      // the file.
      vfs: createWorkspaceForkSource(this.hostedWorkspace().bundle, this.rt.localVfs),
      sourceName: this.name,
      busy: () => this._inFlight,
      transport: this.forkTransport,
    }, untilMessageId, opts);
    return {
      id: fork.workspaceId,
      name: fork.name,
      url: `/workspace/${fork.name}`,
      forkPointMs: fork.forkPointMs,
    };
  }

  /** The owner a hosted fork needs on BOTH halves: the source session is named
   *  from it, and so is the target's file plane. The transport refuses an
   *  unclaimed workspace for the same reason; this refuses it before a roster
   *  name is reserved. */
  private requireOwnerForFork(): string {
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) throw new Error('cannot fork an unclaimed workspace');
    return ownerUserId;
  }

  /** Reaching a workspace that does not exist yet: a Durable Object addressed
   *  by name, and the raw-copy RPC that carries the snapshot to it. */
  private get forkTransport(): ForkTransport {
    const ns = this.env.OrchestratorAgent;
    const stubFor = (name: string) => ns.get(ns.idFromName(name));
    return {
      occupied: async (name) => {
        const { stub, caller } = await this.userHub();
        return stub.hasWorkspace(caller, name);
      },
      deliver: async (name, snapshot) => {
        const ownerUserId = this.getOwnerUserId();
        if (!ownerUserId) throw new Error('cannot fork an unclaimed workspace');
        const { stub, caller } = await this.userHub();
        return deliverCloudFork({
          registry: stub,
          caller,
          target: stubFor(name),
          name,
          // The transport contract carries the two planes and the cut point;
          // WHOSE rows those are is a question only this object can answer, and
          // the answer is its own fenced handle — the same one `forkWorkspace`
          // checked `untilMessageId` against a moment ago. Never a fresh handle
          // and never a name off the wire: the frames read pane and message rows
          // keyed per actor, so any other one snapshots a sibling.
          source: { ...snapshot, actor: this.actorHandle() },
          ownerUserId,
        });
      },
    };
  }

  /**
   * The receiver for this ACTIVATION and THIS transfer.
   *
   * Not the transfer's state: which frame is next, what has been staged and
   * whether the fork published are rows in this object's own SQLite
   * (`ForkStagingState`), so a reset between two frames resumes rather than
   * refuses. What is cached here is the one thing an activation genuinely owns —
   * the running hash and the sibling temp of the file whose ranges are still
   * arriving.
   *
   * The sink is keyed by the transfer id, and that id is per DELIVERY, not per
   * workspace: a failed fork whose roster row was destroyed retries the same
   * target name under a fresh id while this isolate stays warm. So the cached
   * receiver is keyed by the id it was built for and rebuilt when a begin names
   * a different one — otherwise a replacement transfer stages into
   * `.fork-<predecessor>.tmp` temps that the next activation, built from the
   * CURRENT id, can never adopt, and a resumable transfer turns permanently
   * unresumable after one mid-file eviction.
   */
  private forkReceiver: { transferId: string; receiver: ForkTransferReceiver } | null = null;

  /** The receiver for the transfer a frame belongs to, rebuilt when this
   * activation's receiver was keyed to a predecessor's transfer. */
  #forkReceiverFor(forkName: string, transferId: string, ownerUserId: string): ForkTransferReceiver {
    if (this.forkReceiver?.transferId === transferId) return this.forkReceiver.receiver;
    const writer = new ForkTargetWriter(this.boundSql, this.rt.storage.vfs, {
      workspaceId: this.ctx.id.toString(), workspaceName: forkName, ownerUserId,
      targetAuthority: 'pane',
      writeSoulFile: (content) => writeWorkspaceSoul(this.hostedWorkspace().bundle, content),
      transaction: (rows) => this.ctx.storage.transactionSync(rows),
    });
    const receiver = new ForkTransferReceiver(
      writer,
      createWorkspaceForkSink(this.hostedWorkspace().bundle, transferId),
    );
    this.forkReceiver = { transferId, receiver };
    return receiver;
  }

  /** Receive one bounded semantic frame from the source DO. Not callable from
   * public WS/HTTP; only the source cross-DO stub reaches this method. */
  async rawCopyFromFork(
    forkName: string,
    frame: ForkFrame,
    ownerUserId: string,
  ): Promise<
    | { ok: true; status: 'staged' }
    | { ok: true; status: 'published'; agentId: string; capabilityHash: string | null; forkPointMs: number }
    | { ok: false; reason: 'owned_by_another_user' }
  > {
    if (!ownerUserId) throw new Error('fork owner is required');
    this.ensureSchema();
    const currentOwner = this.getOwnerUserId();
    if (currentOwner && currentOwner !== ownerUserId) return { ok: false, reason: 'owned_by_another_user' };

    // The owner is the Nimbus file-plane precondition. It is intentionally the
    // only identity datum before commit; lineage, name, mission, marker and
    // display name publish together in the writer transaction.
    const identity = this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`;
    if (identity.length === 0) {
      void this.sql`INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
        VALUES (${this.ctx.id.toString()}, ${forkName}, ${ownerUserId}, ${Date.now()})`;
    } else {
      void this.sql`UPDATE workspace_identity SET owner_user_id = ${ownerUserId}`;
    }
    this._ownerUserId = ownerUserId;
    this.invalidateModelCaches();

    const receiver = this.#forkReceiverFor(forkName, frame.transferId, ownerUserId);
    const outcome = await receiver.accept(frame);
    if (outcome.status === 'staged') return { ok: true, status: 'staged' };
    // Copied approval rows key the source scope, so the target's copied
    // instruction files start unverified with no marker to write.
    if (outcome.status === 'settled') {
      return {
        ok: true, status: 'published', agentId: this.ctx.id.toString(),
        capabilityHash: await this.workspaceCapabilityHash(), forkPointMs: outcome.result.forkPointMs,
      };
    }
    await this.ensureOwnedScaffold();
    await resetWorkspaceBaseline(this.rt);
    return {
      ok: true, status: 'published', agentId: this.ctx.id.toString(),
      capabilityHash: await this.workspaceCapabilityHash(), forkPointMs: outcome.result.forkPointMs,
    };
  }


  // ── EventsHub RPCs — triggers + events for UI ──────────────────

  /** List triggers (webhooks, timers, watches, mcp routes). UI uses this
   *  for the Supervise Automations block.
   *
   *  Webhook rows carry their signed delivery path, minted here rather than
   *  assembled by a client: a URL without the route capability is a URL that
   *  404s, so the only way to hold one is to have been handed it by a surface
   *  that passed the owner check. `url` is absent when this deployment holds no
   *  route secret — the same reason a delivery would be refused. */
  @callable()
  async listTriggers(): Promise<{ triggers: (TriggerView & { url?: string })[] }> {
    const listed = listTriggers(this.triggerRegistry);
    const secret = webhookRouteSecret(this.env);
    if (secret === null) return listed;
    return {
      triggers: await Promise.all(listed.triggers.map(async (trigger) => (
        trigger.kind === 'webhook_durable' || trigger.kind === 'webhook_ephemeral'
          ? {
            ...trigger,
            url: await webhookRoutePath(secret, {
              workspaceName: this.name, triggerId: trigger.id,
            }),
          }
          : trigger
      ))),
    };
  }

  /** Cross-DO wire form for the Worker HTTP adapter. */
  async listTriggersWire(): Promise<string> {
    return JSON.stringify(await this.listTriggers());
  }

  /** Create a durable webhook trigger. Returns the signed public URL.
   *
   *  Deliberately NOT @callable: webhook creation is step-up gated, and the
   *  gate (auth/session isFreshAuthTime) lives in the only two entry points —
   *  the web route POST /api/workspaces/<name>/triggers and the CLI route
   *  POST /api/cli/workspaces/<name>/triggers/webhook. Exposing this over the
   *  WebSocket RPC surface would bypass that gate. */
  async createDurableWebhook(opts: {
    label: string;
    auth_mode: 'hmac' | 'bearer' | 'mtls';
    secret?: string;
    accepted_content_type?: string;
    rate_limit_per_min?: number;
  }) {
    // Read before the row is written: a trigger whose delivery URL cannot be
    // signed is a row no delivery could ever reach.
    const routeSecret = webhookRouteSecret(this.env);
    if (routeSecret === null) throw new Error(WEBHOOK_ROUTE_UNAVAILABLE);
    const now = Date.now();
    // The secret is core's to decide and to store: an hmac/bearer trigger
    // created without one refuses every delivery for the rest of its life, and
    // this route hands core the secret store rather than minting a row without
    // one when the caller sends none.
    const webhook = await registerDurableWebhook(this.triggerRegistry, this.webhookSecrets, opts, now);
    return {
      trigger_id: webhook.trigger_id,
      url: await webhookRoutePath(routeSecret, {
        workspaceName: this.name, triggerId: webhook.trigger_id,
      }),
      auth_mode: webhook.auth_mode,
      // For HMAC/bearer modes, the operator needs the secret once to give
      // to the external system; we return it inline now and never again.
      secret: webhook.secret,
    };
  }

  /** Cancel a trigger (revoke), deleting its plaintext secret in the same
   *  host call — the revoked webhook leaves no live credential behind.
   *
   *  `caller` is the authority the request carries, and it has no default: this
   *  one method is reached BOTH by the operator's triggers route and by the
   *  model's `agent.cancelSchedule`, and only the first of those may close an
   *  owner-created ingress. A default here would decide that for whichever
   *  caller forgot to say. */
  async cancelTrigger(trigger_id: string, caller: TrustLevel) {
    return cancelTrigger(this.triggerRegistry, trigger_id, Date.now(), caller, this.webhookSecrets);
  }

  /** Register a timer trigger — the `agent.schedule` tool's and the auto-GEPA
   *  scheduler's one way to create one. */
  async createTimerTrigger(opts: Parameters<typeof createTimerTrigger>[1]): Promise<{
    id: string; kind: 'timer_cron' | 'timer_oneshot'; nextFireAt: number | null;
  }> {
    return await createTimerTrigger(this.triggerRegistry, opts, Date.now());
  }

  /**
   * Trace-driven auto-GEPA tick — called once per completed turn. When enough
   * COMPLETED NON-PLAN TURNS have accrued since the last pass AND no pending
   * scaffold is mid-shadow, kick GEPA in the background. The count is a SOURCE
   * QUERY over the durable `turn_end` rows (`workMode` is what makes a turn
   * count), not an activation-local counter: it survives every eviction, so a
   * workspace whose turns are further apart than the eviction window still
   * reaches its cadence. While a pending is in flight the count keeps growing,
   * so a pass fires as soon as the shadow slot frees.
   */
  protected async maybeRunAutoGepa(
    /** THIS tick's stable identity — the terminal scope that owes it. The
     *  prompt-section lane keys its disposition on it, so a replay after a cut
     *  inside the scaffold pass finds the lane already advanced. Absent for a
     *  caller with no durable obligation behind it, which then keys nothing. */
    tick?: string,
  ): Promise<void> {
    const everyN = this.config.getAutoGepaEveryNTurns();
    if (everyN <= 0) return;
    // One-time honesty note: before autonomy defaults flipped ON, a disable
    // DELETED this key — an absent row is indistinguishable from
    // never-configured, so the autonomous default supersedes both. Pin the
    // default explicitly and record the activation in the evolution stream
    // so the override is documented, never silent.
    if (this.config.get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns) == null) {
      this.config.setAutoGepaEveryNTurns(everyN);
      void this.sql`INSERT INTO evolution_events (actor_id, type, message, created_at)
        VALUES (${this.actorHandle().actorId}, 'reflection', ${
          `Auto-GEPA enabled by the autonomous default (every ${everyN} turns of new traces). ` +
          `A disable set before autonomy defaults flipped on was stored as "unset" and is ` +
          `superseded by this default — run setAutoGepa(0) to disable again.`
        }, ${Date.now()})`;
    }
    // ONE cadence pass at a time in this activation. A `running` row means either
    // an interrupted activation (owed, and this tick owes it) or THIS activation's
    // previous turn still inside its detached pass — and the per-tick tombstones
    // cannot separate them, because the second turn carries a different tick. Two
    // live passes would drive candidate scaffolds through the raw tool surface
    // concurrently and race each other's proposals.
    if (this._gepaTickRunning) return;
    const recent = listGepaRuns(this.boundSql, this.actorHandle(), 1)[0];
    // A run left `running` is an INTERRUPTED pass, not a completed one. Taking it
    // as the cadence watermark counted its own turns against the next interval
    // and abandoned it until a whole cadence had accrued again — so it is owed
    // and this tick is the one that owes it.
    if (recent?.status !== 'running') {
      const sinceTs = recent ? new Date(recent.startedAt).toISOString() : null;
      if (this.eventRecorder.completedWorkTurns(sinceTs) < everyN) return;
    }
    // The prompt-section lane is the ONE automatic lane. A scaffold GEPA pass
    // sharing this tick would optimise `scaffold/agent.js`, which the chat turn
    // does not run: the turn is Think's loop over `getSystemPrompt` / `getTools`
    // / `beforeTurn`, and `runScaffold` is reached only by the MCP one-shot, the
    // shadow trials and GEPA's own rollouts. Every 25 turns it would spend
    // rollouts and judge calls improving an artifact no user ever saw answer them
    // (measured 2026-09-03 by grepping `runScaffold(` callers). The manual
    // `runScaffoldGepaOptimization` RPC is where the scaffold tooling asks for
    // one.
    const lane = tick === undefined ? undefined : `${this.name}:${tick}`;
    this._gepaTickRunning = true;
    try {
      await this.oncePerTick(PROMPT_SECTION_LANE, lane, () => this.advancePromptSections());
    } finally {
      this._gepaTickRunning = false;
    }
  }

  /** Whether a cadence optimisation pass is live in THIS activation. An eviction
   *  takes it with the isolate, which is correct: the durable `running` row is
   *  then what says the pass was interrupted. */
  private _gepaTickRunning = false;

  /**
   * Run one NON-REPLAYABLE optimisation pass, at most once per cadence tick.
   *
   * Both lanes drive candidate scaffolds and prompt sections through the LIVE
   * tool surface, and both append evaluation rows between model awaits. A pass
   * the platform interrupted may therefore already have written files, driven a
   * device or spent a judge call, and re-running it from the top repeats every
   * one of those — which is the loss this ledger exists to prevent, arriving from
   * the other side.
   *
   * So ENTRY is recorded, and the completion after it. A replay that finds the
   * entry without the completion knows the pass was cut and abandons it, with the
   * reason on the record. The cadence carries the work to the next tick, which is
   * a delay rather than a loss — unlike a duplicated release.
   *
   * The marker says ENTERED, never "about to try", and the difference is the
   * whole of the trade being honest. Written before `pass()` was called, a cut in
   * between abandoned a tick whose pass had not run a single statement, and an
   * idle workspace simply never did the work — no carrier, no record. It is
   * written in the SAME SYNCHRONOUS SLICE as the call instead: an async function
   * runs to its first await before returning its promise and a Durable Object
   * cannot be evicted mid-slice, so the pass's own opening writes and this marker
   * commit together. Either both are there and abandoning is right, or neither is
   * and the replay runs the whole pass.
   */
  protected async oncePerTick(scope: string, tick: string | undefined, pass: () => Promise<void>): Promise<void> {
    // No tick means no durable obligation behind this call — a live cadence pass
    // with nothing to replay it. It runs, and it keys nothing.
    if (tick === undefined) {
      await pass();
      return;
    }
    if (effectAlreadyDone(this.boundSql, this.actorHandle(), scope, `${tick}:done`)) return;
    if (effectAlreadyDone(this.boundSql, this.actorHandle(), scope, `${tick}:entered`)) {
      diagnostics.event('evolution.interrupted_pass_abandoned', {
        workspace: this.name, lane: scope, tick,
      });
      recordEffectDone(this.boundSql, this.actorHandle(), scope, `${tick}:done`);
      return;
    }
    const running = pass();
    recordEffectDone(this.boundSql, this.actorHandle(), scope, `${tick}:entered`);
    await running;
    recordEffectDone(this.boundSql, this.actorHandle(), scope, `${tick}:done`);
  }

  /**
   * Advance the evolved-prompt-section loop by one step.
   *
   * The order and the selection are `advancePromptSectionLane` in core: policy
   * over a `ScaffoldControl` with nothing Cloudflare-shaped in it, and exactly
   * what a second backend would otherwise have to copy. What stays here is what
   * only this backend knows — that the work rides off a completed turn and must
   * not lengthen the next one, and where a fault is reported.
   *
   * Detached rather than awaited, as the scaffold pass beside it is. A floating
   * promise in a Durable Object is cancelled on eviction with its rejection
   * swallowed, so the cost of an eviction here is a pass that did not finish —
   * which is the same cost as the pass never starting, and the durable ledger is
   * what the next tick reads either way.
   */
  protected async advancePromptSections(): Promise<void> {
    // Awaited by its caller and diagnosed here. Detaching it left the model lane
    // cancellable by the next eviction with nothing owed to replay it, which is
    // the loss the terminal ledger exists to prevent — so the promise travels
    // and the cadence effect holds its row open for it. The failure is still
    // absorbed: the lane is opportunistic and the NEXT cadence tick retries it,
    // while a throw here would keep the whole terminal sequence owed over work
    // nobody is waiting on.
    try {
      await advancePromptSectionLane(this.scaffoldControl);
    } catch (err) {
      diagnostics.failure('prompt_section.lane_failed', toKinuError({
        doing: 'advancing the prompt-section evolution lane',
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: this.name });
    }
  }

  /**
   * Open one refinement over a trajectory — the `/refine` callable.
   *
   * Returns the DURABLE request immediately, at `requested`: no model has run
   * and no artifact has moved. The refiner runs on the off-turn cadence pass
   * (`ActorAgent.runRefinementLane`, driven by AgentOrchestrator), where it can
   * be re-driven for free.
   *
   * The nudge below is DETACHED for the reason the section and GEPA passes
   * beside it are: an owner asking explicitly should not wait for the next
   * completed turn, and should not wait for a child agent either. A floating
   * promise in a Durable Object is cancelled on eviction with its rejection
   * swallowed, which costs a step that did not finish — the same cost as the
   * step never starting, and the durable row is what the next cadence reads.
   */
  @callable()
  async requestRefinement(opts?: {
    turnIds?: string[]; scope?: RefinementScope;
  }): Promise<RefinementRequestView> {
    let request: RequestRefinementInput = {
      trigger: 'explicit',
      scope: opts?.scope ?? 'workspace',
    };
    if (opts?.turnIds !== undefined) request = { ...request, turnIds: opts.turnIds };
    const view = await requestRefinement(this.refinementDeps, request);
    void this.runRefinementLane()
      .catch((...rejection: [unknown]) => diagnostics.failure('refinement.lane_failed', toKinuError({
        doing: 'advancing the continual-refinement lane',
        cause: rejection[0],
        otherwise: 'unavailable',
      }), { workspace: this.name }));
    return view;
  }

  /**
   * The OWNER decides one staged edit — the only path by which a proposed skill
   * becomes trusted instructions.
   *
   * `interactive` in the RPC gate, like `approveInstruction` and for the same
   * reason: this is the act that grants bytes system placement, so a scoped
   * token that could call it would be a way for agent-written bytes to
   * authorise themselves. It is absent from every model-facing tool surface.
   */
  @callable()
  async decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult> {
    const result = await decideRefinementRoute(this.refinementDeps, input);
    // An approval puts a new trusted skill in the next prompt and its
    // `allowed_tools` in the next tool surface, so the cached surface is dropped
    // exactly as a craft retirement drops it.
    if (result.ok) {
      this._cachedTools = null;
      this._cachedToolsKey = '';
    }
    return result;
  }

  /**
   * The WHOLE staged file for one proposed edit, and the digest a decision must
   * quote back.
   *
   * `interactive` like the decision itself: it carries proposed instruction
   * bytes, the same sensitivity class as `readInstructionApproval`. Never
   * truncated — this is what the modal renders, and a truncated approval surface
   * asks for a decision about bytes the decider could not see.
   */
  @callable()
  async showRefinement(requestId: string, routeIndex: number): Promise<StagedSkillResult> {
    return showRefinementRoute(this.refinementDeps, { requestId, routeIndex });
  }

  /** Refinements newest first, plus the debt that would open the next one —
   *  what `/refine` with no argument prints. */
  @callable()
  async listRefinements(limit: number = 20): Promise<{
    requests: RefinementRequestView[]; debt: EvolutionDebt;
  }> {
    return {
      requests: createRefinementStore(this.boundSql, this.actorHandle()).list(limit).map(refinementRequestView),
      debt: refinementDebt(this.refinementDeps),
    };
  }

  /** Run a webhook delivery through the hub from within the agent DO. This
   *  RPC is invoked by the top-level webhook route (`handleHubRequest`) so
   *  the publish + dedupe + reply channel open run atomically in the agent's
   *  storage context. */
  async acceptWebhookDelivery(opts: WebhookDelivery): Promise<WebhookDeliveryResult> {
    return acceptWebhookDelivery({
      triggers: this.triggerRegistry,
      log: this.eventLog,
      replies: this.replyChannels,
      vfs: this.rt.storage.vfs,
      secrets: this.webhookSecrets,
      sql: this.ctx.storage.sql,
      onAdmitted: () => { this.orch.scheduleDrain(); },
    }, opts);
  }

  /**
   * Container ingress: a process inside this workspace's container reports that
   * something happened. Invoked by the egress layer's intercepted event host
   * (`src/egress/outbound.ts`), whose handler runs in the Workers runtime and
   * addresses this workspace from configuration the container cannot influence.
   *
   * Here rather than in the handler for the same reason as
   * `acceptWebhookDelivery`: publish + dedupe run atomically in this agent's
   * storage context. The FIRST producer of the `sandbox_cb` ingress arm, which
   * the hub has modelled end to end — trust, priority, dedupe, rendering — with
   * nothing ever emitting one.
   *
   * `launchingHeadTrust` is supplied HERE, never read off the wire: the
   * container is the least trusted component in the system, and the hub's
   * priority table admits these variants only at `owner` or `self`, so a
   * forgeable trust field would be a privilege escalation into the plane that
   * wakes the agent. `self` is this workspace's own rail — the container is its
   * own machine — and the adapter refuses rather than throwing when a lower
   * tier cannot publish.
   *
   * Nothing is deferred past the response: `waitUntil` is a no-op in a Durable
   * Object and a floating promise there is cancelled on eviction with the
   * cancellation swallowed, so the write is awaited inside the invocation that
   * answers the container and a retry is the recovery.
   */
  async acceptContainerEvent(body: JsonValue): Promise<ContainerEventResult> {
    return acceptContainerEvent({
      log: this.eventLog,
      vfs: this.rt.storage.vfs,
      launchingHeadTrust: 'self',
      onAdmitted: () => { this.orch.scheduleDrain(); },
    }, body, Date.now());
  }

  /**
   * The container's Durable Object reports that its own persistence failed.
   *
   * Beside `acceptContainerEvent` and deliberately NOT the same path. That one
   * is the container's own processes reporting what they did, admitted into the
   * event hub and debounced into one turn with everything else that happened.
   * This one is the container's HOST saying its filesystem cannot be trusted,
   * which is a blocker: it must not be batched behind a build notification, and
   * the agent has to hear it before it writes anything else into that
   * filesystem. So it goes through the signal seam, whose own policy gives a
   * blocker its own turn.
   *
   * Reachable on the root stub and nowhere else — a plain method rather than a
   * `@callable`, exactly as `acceptContainerEvent` is: the caller is another
   * Durable Object in this Worker, and a browser socket has no business
   * announcing container incidents.
   *
   * Not awaited past the response, and not deferred either: the ledger write
   * and the delivery both happen inside this invocation, because `waitUntil` is
   * a no-op in a Durable Object. The caller's retry is the recovery, and the
   * incident id is what makes that retry safe.
   */
  async acceptSandboxLifecycleFailure(body: JsonValue): Promise<SandboxLifecycleFailureResult> {
    this.ensureSchema();
    return acceptSandboxLifecycleFailure({
      sql: this.boundSql,
      signals: this.orch.signals,
      // The workspace is this object's own name, and it is the only dimension
      // the lifecycle module cannot know. Everything else on the row is decided
      // where the incident is understood.
      recordRecovery: (row) => { recordSandboxRecovery(this.env, { workspace: this.name, ...row }); },
      logActivity: (event, detail) => this.logActivity(event, detail),
    }, body, Date.now());
  }

  private _webhookSecrets: WebhookSecretStore | null = null;
  /** This workspace's webhook secrets. Deliberately not reachable over RPC:
   *  secret material must never be readable over the browser websocket. */
  private get webhookSecrets(): WebhookSecretStore {
    this._webhookSecrets ??= createWebhookSecretStore(this.ctx.storage.sql);
    return this._webhookSecrets;
  }

  /** Peer-agent ingress: a sender agent's DO delivers one outbox message via
   *  cross-DO RPC. Ownership/grant checks run receiver-side (never trusted
   *  from the sender's claim beyond intra-Worker honesty); an admitted event
   *  either resolves the local ask waiter inline (a reply envelope) or wakes
   *  the agent through the standard drain → programmatic turn path. */
  async receivePeerMessage(msg: PeerMessage): Promise<ReceiveResult> {
    this.ensureSchema();
    return this.peerHub.receive(msg);
  }

  // ── Mission Inbox: email ingress + owner notifications ─────────

  /** Owner's verified login email (UserDO profile). Null covers the two things
   *  the email gate treats alike: the workspace is unclaimed, or the owner's
   *  profile carries no email. Failing to ASK is not one of them — it must not
   *  read as "owner email unknown" and silently refuse the owner's own mail. */
  private async getOwnerEmail(): Promise<string | null> {
    if (!this.getOwnerUserId()) return null;
    const { stub, caller } = await this.userHub();
    return (await stub.getProfile(caller))?.email ?? null;
  }

  private _emailInbox: EmailInbox | null = null;
  /** This workspace's inbox: the trust gate, the shared inbound rate window,
   *  and the deafness notice the agent reads while that window is refusing
   *  mail. Held across the activation, like the in-memory window it owns. */
  private get emailInbox(): EmailInbox {
    this._emailInbox ??= new EmailInbox({
      log: this.eventLog,
      replies: this.replyChannels,
      triggers: this.triggerRegistry,
      vfs: () => this.rt.storage.vfs,
      sql: this.ctx.storage.sql,
      ownerEmail: () => this.getOwnerEmail(),
      onAdmitted: () => { this.orch.scheduleDrain(); },
    });
    return this._emailInbox;
  }

  /** The pre-parse half of the inbox gate, for the Worker's `email()` seam:
   *  the same owner/allowlist comparison `acceptEmailDelivery` runs, asked
   *  before the message is buffered and MIME-parsed so an unauthorized sender
   *  cannot spend this workspace's parse on a platform-maximum message. It
   *  admits nothing; the delivery below re-asks. */
  async authorizeEmailSender(from: string): Promise<{ authorized: boolean; reason?: string }> {
    return this.emailInbox.authorizes(from);
  }

  /** Run an inbound email through the hub from within the agent DO — the
   *  email counterpart of acceptWebhookDelivery. The Worker `email()` handler
   *  parses MIME + resolves the agent; the trust gate (owner email /
   *  email_route allowlist), publish, and thread reply channel run here
   *  atomically. Unauthorized senders never produce an event row.
   *
   *  The receipt is AWAITED, and only on a fresh admission. Awaited because
   *  this runs inside the Durable Object that owns the outbox, where a
   *  floating promise is cancelled on eviction with the cancellation
   *  swallowed; fresh-only because a redelivery of a message already admitted
   *  is the mail edge retrying, not a second message, and the sender has the
   *  receipt for it already. The outbox's dedupe key holds the same line
   *  durably, so an eviction between the two never sends twice. */
  async acceptEmailDelivery(opts: IncomingEmail): Promise<EmailAdmission> {
    const admission = await this.emailInbox.accept(opts);
    if (admission.admitted && !admission.duplicate && admission.thread && admission.event_id) {
      await sendInboundEmailReceipt({
        email: this.env.EMAIL,
        agentDisplayName: this.safeDisplayName(),
        outbox: this.emailOutbox,
      }, admission.thread, admission.event_id);
    }
    return admission;
  }

  /** The agent's email surface for the operator UI / routes. */
  async getEmailIngress(): Promise<{ address: string | null; allowlist: string[]; notifications: boolean }> {
    const domain = this.env.EMAIL_DOMAIN;
    return {
      address: domain ? agentEmailAddress(this.name, domain) : null,
      allowlist: readEmailAllowlist(this.triggerRegistry),
      notifications: this.config.getEmailNotificationsEnabled(),
    };
  }

  /** Replace the inbound-email allowlist. The owner's own verified address is
   *  always allowed and never needs listing; one active email_route trigger
   *  (creator_trust recorded like every ingress) holds the extra senders, and
   *  an empty list just revokes it. Reached only through the owner-
   *  authenticated + step-up route. */
  async setEmailAllowlist(allow: string[]): Promise<{ allowlist: string[] }> {
    return setEmailAllowlist(this.triggerRegistry, allow, Date.now());
  }

  /** Toggle owner-email notifications (changelog digests, job completions). */
  async setEmailNotifications(enabled: boolean): Promise<{ notifications: boolean }> {
    this.config.setEmailNotificationsEnabled(enabled);
    return { notifications: this.config.getEmailNotificationsEnabled() };
  }

  /** Fire-and-forget owner email. `email_notifications='false'` silences it;
   *  missing platform pieces (binding / domain / owner email) skip quietly.
   *  Also skipped while an operator socket is live — the owner sees the
   *  card in-app; email is the away channel, not a duplicate feed. */
  private emailOwnerNotification(subject: string, text: string): void {
    const notification = planOwnerNotification({
      enabled: this.config.getEmailNotificationsEnabled(),
      operatorConnected: this.ctx.getWebSockets().length > 0,
      subject,
      text,
    });
    if (!notification) return;
    void (async () => {
      await sendOwnerEmail({
        email: this.env.EMAIL,
        emailDomain: this.env.EMAIL_DOMAIN,
        agentName: this.name,
        agentDisplayName: this.safeDisplayName(),
        ownerEmail: await this.getOwnerEmail(),
        outbox: this.emailOutbox,
      }, notification);
    })().catch((...rejection: [unknown]) => diagnostics.failure('email.owner_notification_failed', toKinuError({
      doing: 'sending the owner an away-channel notification',
      cause: rejection[0],
      otherwise: 'unavailable',
    }), { subject }));
  }

  /** Recent events, newest first — `events_v` ordering (received_at desc).
   *  Reached two ways: `kinu events` over the CLI RPC transport, and
   *  `GET /api/workspaces/<name>/events` through the wire form below. The CLI
   *  formats it through the one row formatter its four sibling list reads go
   *  through, so this answers a bare list of rows and never an envelope. The
   *  operator UI does not read it — the events it shows are the ones drained
   *  into a turn, carried on that turn's message.
   *
   *  This is the boundary an UNTRUSTED caller crosses, so `boundEventQuery`
   *  states the ceiling HERE and not only at the route: the method is on the
   *  CLI RPC surface gated at `workspace.read`, which reaches the object with
   *  no route in the path. The old `?? 100` caught null and undefined and
   *  nothing else, so a caller's `-1` reached SQLite as `LIMIT -1` — no limit
   *  at all. `EventLog.query` enforces its own invariant underneath. */
  async listRecentEvents(opts?: {
    variant?: string;
    since?: number;
    limit?: number;
  }): Promise<RecentEventRow[]> {
    const parsedVariant = v.safeParse(EventVariantSchema, opts?.variant);
    const events = this.eventLog.query(boundEventQuery({
      variant: parsedVariant.success ? parsedVariant.output : undefined,
      since: opts?.since,
      limit: opts?.limit,
    }));
    return events.map((e) => ({
      id: e.id,
      trace_id: e.trace_id,
      caused_by: e.caused_by,
      ingress: e.ingress,
      variant: e.variant,
      trust: e.trust,
      priority: e.priority,
      payload_visibility: e.payload_visibility,
      payload: e.payload,
      received_at: e.received_at,
    }));
  }

  /** Cross-DO wire form for the Worker HTTP adapter. */
  async listRecentEventsWire(opts?: {
    variant?: string;
    since?: number;
    limit?: number;
  }): Promise<string> {
    return JSON.stringify(await this.listRecentEvents(opts));
  }

  // ── Internal: timing-safe string compare for webhook auth ──────

  // (Defined at module scope at the bottom of the file.)

}

// ── Module-scope helpers (referenced by OrchestratorAgent) ────────

/** An export cursor arrives from a client, so it is claimed, not trusted:
 *  anything that is not the shape the previous page returned starts a fresh
 *  archive rather than binding junk into the row query. */
function parseArchiveCursor<Value>(value: Value): ArchiveCursor | null {
  const parsed = v.safeParse(ArchiveCursorSchema, value);
  return parsed.success ? parsed.output : null;
}
