import { storeRevision, type WorkspaceOverviewInputs } from '@kinu.run/core';
/**
 * OrchestratorAgent: the workspace-facing actor on top of ActorAgent (actor-agent.ts).
 * Tool factory, system prompt, and crafted-tool injection live in @kinu.run/core, shared with the CLI.
 */

import { callable, type AgentContext, type Connection, type ConnectionContext } from "agents";
import { ORCHESTRATOR_RPC_SURFACE, ORCHESTRATOR_STARTED_RPC, sealRpcSurface } from "./rpc-surface";
import { ActivationGate, startBeforeRpc } from "./activation-gate";
import { KINU_TIMER_JOB } from "./wake-jobs";
import {
  runExperienceAction, type ExperienceActionDeps, type ExperienceActionInput,
  ArchiveCursorSchema,
  createWorkspaceForkSink, createWorkspaceForkSource, settledWorkspaceSoul, workspaceArchiveFiles, writeWorkspaceSoul,
  explorationActorKey, collectDynamicContext, subordinateDelegatesOf,
  createReportCodemodeProvider, HeadController, REAL_CLOCK, runHeadSplit, SubordinateRosterStore,
  recoverActorTurns, EventLog, dismissOrphanedAssignments, actorReferenceOf, subordinateDescendants, TEMPORARY_LIFETIME,
  activePromptSectionOverrides,
  agentsActionsFor, agentsProfileContext, assignedTurnFraming, buildActorTools,
  BUILTIN_TOOL_NAMES, createTeamToolDeps, currentDateForPrompt, delegationExhausted,
  mintSubordinateName, withHeadCaptureRecording, DelegatedTurnRunners,
  type ActorHost, type ActorToolsetDeps, type AgentsSwarmDeps, type AgentsToolDeps, type ResumableActorTurn,
  type AssignedTurnFraming, type BuiltinToolName,
  type BoundActor, type DynamicContext, type HeadInput,
  type HeadJournalPort, type HeadSplitRequest, type HeadSplitResult, type HostedActor,
  type LoopOrigin, type NimbusSandboxHandle, type NodeHomeHost,
  type SqlExec, type SqlValue, type TeamToolDeps, type WorkspaceActor, type WriteObserver,
  isSubordinateOrigin,
  whenActorTakesInput,
} from "@kinu.run/core";
import { createHostedWorkspace, type HostedWorkspace, type WorkspaceTerminal } from "./workspace-host";
import { isWorkspaceTerminal, WORKSPACE_TERMINAL_PATH, WORKSPACE_TERMINAL_TAG } from "@kinu.run/core";
import { McpToolSurfaceSchema, ShareViewerClaimSchema, tierIdsOf, type ShareViewerClaim } from '@kinu.run/core';
import { CHAT_SESSION_ID, readSessionTranscript, turnInputMessage, type HeadReport, type SessionTranscript, type VfsRevision } from '@kinu.run/core';
// Main actor's payload plane on both fork halves: the carried conversation references
// payload files by absolute path, and the fork is a cut of the main actor's conversation.
import { agentArtifactDirectory, agentHome, MAIN_AGENT } from '@kinu.run/core';
import { contextFill, type ContextFill } from '@kinu.run/core';
import type { ChatWire } from './chat-transport';
import { DELEGATION_LANE_FIBER } from './fiber-recovery';
import { SLATE_SHARE_PATH, slateShareUrl, viewerEntryUrl } from './slate-share-route';
import { nimbusPreviewUrl, WORKSPACE_PREVIEW_PATH } from "./nimbus-route";
import { SlateHost } from "./slates/host";
import { initBrowserSessionTable, ownsBrowserSession } from "@kinu.run/core";
import { browserCamera, initSlatePictureTable, SlatePictures, type PictureCapture } from "./slates/pictures";
import type { BlueprintReading, ShareUser } from "@kinu.run/core/slates";
import { ROOT_SLATE_CALLER, type SlateCaller } from "./slates/bindings";
import {
  actorRetirementFor, createWorkspaceActorHost, provisionHostedActorHome, type WorkspaceHostSeams,
} from "./actor-hosting";
import {
  admitHostedTask, hostedDelegationBudget, hostedSubordinateRuntime, relayHostedReport, retireStalledTask,
  reportSettlesRun, runHostedTask, hostNodeSeat, nodeCodemodeTool, reclaimSettledExplorationActors,
  type HostedActorSeams, type HostedTaskProfile, type HostedTaskTurn,
} from "./hosted-actors";
import { createCodemodeToolFactory } from "./codemode-tool";
import { codemodeEgress } from "./codemode-egress";
import type { ReportToolDeps } from "@kinu.run/core";
import type { ToolSet } from "ai";
import {
  webhookRoutePath, webhookRouteSecret, WEBHOOK_ROUTE_UNAVAILABLE,
} from "@kinu.run/core";
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SupervisorOpResult } from '@kinu.run/core/workspace';
import { TURN_CLAIM_FRAME, type AccountSpend, type ActivitySnapshot, type TabPresence, type TurnClaimState } from "@kinu.run/core";
import type { SubordinateRosterEntry } from "@kinu.run/core/protocol";
import { teamPeers } from "./lib/workspace-roster";
import { nextAlarmTime } from '@kinu.run/core';
import { accountDeps, CacheWarmingLane, CacheWarmStore } from '@kinu.run/core';
import {
  EvolutionEngine, initWorkspaceActorTable, WorkspaceActorDirectory, ChildActorOperationSchema, type ActorHandle, type ActorReference, type ChildActorOperation, type ActorDirectoryResult,
  readActivityLog,
  summarizeSteps,
  usageReported,
  // Whole-workspace spend by producer; `summarizeSteps` covers only this agent's turns.
  workspaceSpend,
  initWorkspaceSchema,
  tableExists,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS,
  // Declared reach axis; getToolDescriptions reports it rather than guessing from ToolSet keys.
  TOOL_REACH,
  updateCraftScores,
  feedbackToQuality,
  forkWorkspace, ForkTargetWriter, ForkTransferReceiver,
  type ForkTransport, type ForkFrame,
  readWorkspaceArchivePage, type ArchiveCursor, type ArchivePage,
  nanoid, type HeadRunView,
  // Delegation runner shared with the local host: an assignment is a whole turn input
  // and no reactor may digest it.
  drainAssignments, delegatedTaskMetadata, type AdmittedAssignment,
  appendMemoryNote,
  parseMemoryNotes,
  type SlateBindingRequest, type SlateCallResult, type SlateOperation, type SlateReadModel, SLATES_CHANGED_EVENT, SLATES_CHANGED_METADATA_KEY, slatesToPreview, answerParts,
  type SlateBindingCatalog, type LiveShareRecord,
  type BlueprintBundle, type BlueprintFork, type SlateAnswer, type SlateShareRecord,
  type ScaffoldRunResult,
  applyScaffoldDecision, getShadowStatus, listScaffoldVersions, shadowTrialPlan, trimTrialContext,
  previewScaffoldLive, runScaffoldCaptureText, runScaffoldGepaOptimization,
  advancePromptSectionLane,
  decideRefinementRoute, evolutionAnswerWake, listRefinements, nextEvolutionAnswerAt, refinementPass, requestOwnerRefinement, showRefinementRoute,
  type EvolutionDebt, type RefinementDecisionInput, type RefinementDecisionResult,
  type StagedSkillResult,
  type RefinementRequestView, type RefinementScope,
  runScaffoldOnce, scaffoldRunReport, type ScaffoldRunReport,
  type GepaOptimizationResult, type ScaffoldDecisionResult,
  type ScaffoldVersionView, type ShadowStatus,
  getPendingScaffold,
  readScaffoldVersion, readShadowVerdict, type ShadowVerdict,
  type RunEvent, type RunEventQuery, type StoredRunEvent,
  AGENT_CONFIG_KEYS,
  listProposedTasks, updateProposedTaskStatus,
  hybridSearch, memorySnippetRehydrator, type HybridHit,
  type BackgroundJob, TriggerRegistry, ReplyChannelStore,
  type ReasoningEffort, type ShellApprovalMode, type ResolvedTurnProfile,
  type AlarmScheduler,
  listGepaRuns, loadGepaCandidates, loadGepaParetoFront, type GepaRunSummary,
  listReplayEvals, type ReplayEvalSummary,
  alignmentConvergence, type AlignmentConvergence,
  calibrationReport, sampleForLabeling, ingestOutcomeLabels, DEFAULT_LABEL_BUDGET,
  type CalibrationReport, type LabelingItem, type LabelIngestResult, type OutcomeLabel,
  ensembleReport, runEnsemble, createCompletionLLM,
  type EnsembleReport, type EnsembleRunResult,
  revertChangelogEntryById,
  type ChangelogEntry, type ChangelogRevertResult,
  listAlternateTakeSets, latestAlternateTakeSet,
  type AlternateTakeSet, type TakePickOutcome,
  startBranchHead, newBranchId, PendingSendStore,
  headStatusUnsettled, storedHeadReportStatus,
  STEER_BRANCH_RUN_ID_PREFIX,
  type PendingBranch, type BranchStatusEvent,
  readWorkspaceWork, hasWorkspaceWork, type WorkspaceWork,
  readWorkspaceAgents, type PanelAgent,
  type PeersToolDeps, type PeerSpawnOutcome, type PeerSendOutcome,
  type EnqueueTurnResult, type ProgrammaticTurn, workModeForTurnMetadata,
  ROOT_DELEGATION_BUDGET, type DelegationBudget,
  readMission, summarizeSoul, writeSoul, workspaceGenesisSignal, WORKSPACE_CREATED_EVENT,
  // Recovery has no live turn, so the owed answer is read from the transcript.
  answersForDrainTurns,
  type PromptIdentity, UNTITLED_WORKSPACE_NAME,
  checkpointAvailability, fileCheckpointListing, fileRestorePlan, fileCheckpointRestore, deviceFileCheckpoints,
  CommandResultSchema,
  type CheckpointAvailability, type FileCheckpointListing, type FileCheckpointReads,
  type FileRestorePlan, type FileRestoreResult,
  runSleepTimeCompute, applySleepTimeUpdate,
  SleepTimeUpdateSchema, SLEEP_TIME_CADENCE, sleepTimeDue, sleepTimeWakeAt, sleepTimeWindow,
  type SleepTimeUpdate, type SleepTimeWindow,
  effectAlreadyDone, recordEffectDone, oncePerTick,
  // Core owns the ingress gates; this actor owns the transports in front of them
  // (DO alarm, Worker webhook + email routes, cross-DO RPC).
  acceptWebhookDelivery, registerDurableWebhook, createWebhookSecretStore,
  acceptContainerEvent, type ContainerEventResult,
  initWebhookIngressTables, initSubordinateRosterTable,
  type WebhookDelivery, type WebhookDeliveryResult, type WebhookSecretStore,
  createTimerTrigger, cancelTrigger, listTriggers, fireDueTriggers, type TrustLevel,
  type TriggerView,
  EmailInbox, planOwnerNotification, readEmailAllowlist, setEmailAllowlist,
  type EmailAdmission, type IncomingEmail,
  PeerHub, type PeerMessage, type ReceiveResult,
  getAgentStatus, getToolList, readLatestSearchTree, readSearchTree,
  readSearchNodeDetail, type SearchNodeDetail,
  listForkRuns, type ForkRunSummary,
  readNodeTranscript, type NodeTranscriptView,
  readExplorationCanvas, readExplorationRun, type ExplorationCanvasRun,
  listRecordObjectives, listRecordCells, readRecordCell,
  type RecordObjectiveSummary, type RecordCellSummary,
  type RecordObjectiveHandle, type RecordCellHandle, type ExplorationRecord,
  type HeadStep,
  buildPendingActions, listPendingPlanReviews, type PendingAction,
  type Page, type PageRequest,
  getRunTimeline, type TimelineSpan,
  getRunEvents, getRunEventText, getRunSummaries, listRuns, type RunListEntry, type RunSummary,
  turnRequestIndex, turnRequestPage, type TurnRequestIndex, type TurnRequestPage, type AgentStores,
  LiveReadsNotice, readsMovedByFiles, readsWrittenBy, sameDeviceStatus, type LiveRead,
  CHANGES_MOVED_EVENT, ChangeSetCache, getWorkspaceDiff, getExecutorDiff, resetWorkspaceBaseline, restoreWorkspaceBaseline,
  type ExecutorDiffResult, type WorkspaceBaselines, type WorkspaceDiffResult, type WorkspaceReviewResult,
  initChangeNotesTable, readChangeNotes, saveChangeNotes, sendChangeNotes,
  type ChangeNotesResult, type NotedChanges, type ReviewAnnotation,
  diffLines, type DiffLine,
  getExecutorFiles, readExecutorFile, listEnvironments,
  renameExecutorPathOp, deleteExecutorPathOp,
  ExecutorFileUpload, ExecutorFileDownload,
  type DirEntry, type ExecutorWriteResult,
  cancelBackgroundJob, clearBackgroundJobs, dismissBackgroundJob,
  jobResult, listBackgroundJobs, retryBackgroundJob, reconcileInterruptedForks,
  jobRedriveResumeGate, resumableForkRoots,
  type CancelWorkOutcome, type RetryOutcome,
  getAlwaysActiveSkills, getEvolutionConfig, getProviderAccounts, getReasoningEffort,
  getShellApprovalMode, getShellApprovalGrants, revokeShellApprovalGrants,
  setAlwaysActiveSkills, setEvolutionConfig,
  setModel, setProviderAccount, setReasoningEffort, setShellApprovalMode,
  type EvolutionConfigView,
  getEvolutionChangelog, getUnseenChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
  workModeUnderReview,
  JsonValueSchema, type JsonValue, type JsonObject, type KinuEvent,
  EVENT_VARIANTS,
  boundEventQuery,
  type WorkMode,
  resolveModelRoute,
  WORKSPACE_RUN_ID, activeOperationProfile, SLATES_ROOT,
  buildWorkspaceOverview, recoveryBackoffMs, type WorkspaceOverview,
  projectJsonValue,
  type AgentSignal,
} from "@kinu.run/core";
import * as v from 'valibot';
import { Hono } from 'hono';
import { beneath, rawPath, rethrow } from './api/context';
import { experienceLibraryOver } from './user/experience-library';
import type { WorkspaceOwnerRpc } from './workspace-owner-rpc';
import {
  ActorAgent,
  type ActorDynamicContextExtras,
  type ActorToolDeps,
  type UntimedArms,
} from "./actor-agent";
import {
  recordJobSettled, recordSandboxRecovery, type AgentKind,
} from "@kinu.run/core/analytics";
import { resolveEnsembleJudgeSelection } from "./providers/judge-model";
import {
  agentSelfHost, createAgentSelfProvider,
  DeviceConsentRegistry, DeviceConsentStore,
  type DeviceConsentAnswer, type DeviceConsentDecision,
  type DeviceConsentRequest, type PendingDeviceConsent,
  DeferredApprovalQueue, DeferredApprovalStore, decideDeferredApprovals, performBoundWrite, ParkedWriteFiles,
  reviewParkedWrite, type ParkedWriteReview,
  type DeferredApproval, type DeferredApprovalAnswer, type DeferredApprovalChannel,
  type DeferredApprovalNotice, type ApprovalGrant,
  TURN_AUTHOR_METADATA_KEY,
  WorkspacePlanReferenceSchema,
} from "@kinu.run/core";
import type { CodemodeProvider, MctsSearchRunSummary, SubordinateInspectionRequest, SubordinateInspectionResult, WorkspacePlanReference } from "@kinu.run/core";
import { Effect } from 'effect';
import { attempt, authoredRefusal, classify, diagnostics, KinuError, refusalOf, renderThrownChain, settle, toKinuError, type Refusal } from "@kinu.run/core/obs";
import { createCloudWorkspaceForUser } from "./user/workspace-create";
import type { NameOrigin } from "@kinu.run/core";
import { deliverCloudFork, type ForkFrameAck } from "./user/workspace-fork";
import { agentEmailAddress } from "./email/inbound";
import {
  createEmailThreadDispatcher, dispatchEmailRepliesForTurn,
  sendInboundEmailReceipt, sendOwnerEmail,
} from "./email/outbound";
import { EmailOutbox } from "@kinu.run/core";
import { dispatchRecoveredNotice, type RecoveredNotice } from "./fiber-recovery";
import {
  acceptSandboxLifecycleFailure, initSandboxLifecycleTable,
  type SandboxLifecycleFailureResult,
} from "./sandbox-lifecycle";
import { openSandbox } from "./sandbox-exec-lane";
import type { RestoreStatus } from "@kinu.run/devbox";
import { sandboxIdForWorkspace } from "@kinu.run/core";
import { sandboxPreviewExposures } from "@kinu.run/core";
import type { ExposedPortList } from "@kinu.run/core";
import {
  terminalEffect, keyedScope, declareTerminalRoster, owesShadowTrial,
  branchesTerminalEffect,
  type OwedEffect, type OwedTerminalEffectsInput, type TerminalEffectTable, type TerminalTurnFacts,
  type TerminalTurnParts,
} from "@kinu.run/core";

const READS_BY_STATEMENT = new WeakMap<TemplateStringsArray, readonly LiveRead[]>();

const STALE_EVENT_DELIVERY_MS = 10 * 60 * 1000;

const LeasedRowSchema = v.object({ id: v.string() });

/**
 * Row budget per sweep activation: each item is a full inference turn. A full pass
 * answers truncated and the wake drains the rest on the next frame.
 */
const HOSTED_DELEGATION_DRAIN_BUDGET = 8;

/** Tombstone scope marking a turn's sleep-time update applied; survives pruning of
 *  its `sleep_time_updates` row. */
const SLEEP_TIME_APPLIED = 'sleep_time';

/** Tombstone scope for the prompt-section lane: separate from the GEPA pass so
 *  replaying the tick does not rotate the section twice. */
const PROMPT_SECTION_LANE = 'prompt_section_lane';

/** Millisecond instants in `actor_config`. `settledAt` present means an unprocessed
 *  completed turn awaits a run; `closedAt` is when the last client connection closed. */
const SLEEP_TIME_SETTLED_AT = 'sleep_time_settled_at';

const SLEEP_TIME_CLOSED_AT = 'sleep_time_closed_at';

const ANSWERED_TURNS_KEPT = 32;

const SANDBOX_STARTING = 'sandbox_starting';

const SANDBOX_REFUSED = 'sandbox_refused';

/** Covers one more answer than `SLEEP_TIME_CADENCE.everyTurns` plus steers, so the
 *  window decides every trigger as the whole transcript would. */
const SLEEP_TIME_READ_ROWS = (SLEEP_TIME_CADENCE.everyTurns + 1) * 8;

/** Smaller than the fiber sweep's row budget: each sealed head costs a durable report write
 *  and a broadcast. A pass that fills either budget arms the maintenance wake. */
const ORPHAN_SEAL_MAX_ROWS = 256;

/** Transfer id is fresh per transfer, so two readers of one path cannot replace
 *  each other's snapshot. */
export interface ExecutorFileChunkRead {
  executorId: string;
  path: string;
  transferId: string;
  offset: number;
  length: number;
}

export interface ExecutorFileChunkWrite {
  executorId: string;
  path: string;
  transferId: string;
  offset: number;
  chunk: Uint8Array;
  final: boolean;
  expectedRevision?: VfsRevision;
}

const WAKE_ARM_FAILURE = {
  delegation: {
    event: 'subordinate.delegation_wake_arm_failed',
    doing: 'arming the wake that runs an admitted delegation',
  },
  reconcile: {
    event: 'event.delivery_reconcile_failed',
    doing: 'arming the wake that finishes what a dead activation owed',
  },
  recovery: {
    event: 'turn.recovery_wake_arm_failed',
    doing: 'arming the wake that resumes work a stranded turn fenced',
  },
} as const;

// These windows bound the Activity response. Stored history remains append-only.
const ACTIVITY_STEP_WINDOW = 400;

const ACTIVITY_LOG_WINDOW = 200;

/** Widest single stream one terminal row carries out of `executor_output` (~200 lines at 80 cols).
 * The clip is always declared, never silent; see {@link OrchestratorAgent.getExecutorOutput}. */
const EXECUTOR_OUTPUT_CLIP = 16 * 1024;

/** The terminal rows a reload shows per executor, and all `executor_output` keeps: an older row reaches no reader. */
const EXECUTOR_HISTORY_ROWS = 50;

/** `stdout_len`/`stderr_len` are the stored lengths, so a reader can tell a short command
 *  from a clipped one. */
interface ExecutorOutputRow {
  id: string; executor: string; command: string;
  stdout: string; stdout_len: number;
  stderr: string; stderr_len: number;
  exit_code: number; created_at: number;
}

/** Built from core's `EVENT_VARIANTS` so a new variant cannot compile in core yet fail
 *  validation on this route. */
const EventVariantSchema = v.picklist(EVENT_VARIANTS);

/** The log's row minus its plumbing; derived from core's event so a renamed field fails
 *  here rather than silently dropping out. */
export type RecentEventRow = Pick<
  KinuEvent,
  'id' | 'trace_id' | 'caused_by' | 'ingress' | 'variant' | 'trust' | 'priority'
  | 'payload_visibility' | 'payload' | 'received_at'
>;

function clampLimit(requested: number | undefined, max: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return max;

  return Math.min(Math.max(Math.floor(requested), 1), max);
}

/** agents 0.24's Lifecycle reads this key back at start when `ctx.id` has no name (a migration read; it never writes it). */
const PERSISTED_NAME_KEY = '__ps_name';

/** A terminal that cannot open: the owner's pane reads the whole chain. */
function terminalRefusal(failure: { doing: string; cause: unknown }): string {
  const error = authoredRefusal({ ...failure });
  diagnostics.failure('terminal.prepare_failed', error);

  return renderThrownChain({ cause: error });
}

interface HostedTarget {
  readonly handle: ActorHandle;
  readonly entry: NonNullable<ReturnType<SubordinateRosterStore['get']>>;
}

export class OrchestratorAgent extends ActorAgent implements WorkspaceOwnerRpc {
  private readonly addressedName: string;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    const name = ctx.id.name ?? this.recordedName();

    if (name === undefined) {
      throw new KinuError('unsupported', 'This workspace object was reached by id before any named start recorded its name; address it by name.');
    }

    this.addressedName = name;
    sealRpcSurface(this, ORCHESTRATOR_RPC_SURFACE);

    // Tables only, so a call after `destroyAgent` makes no workspace. Native RPC runs no `onStart`.
    if (!this.nimbusSibling && this.storageRefusal === undefined) {
      this.initTables();

      if (this.workspaceBorn()) this.registerCompactionExtension();
    }

    this.installClientMessageGate();
    const gate = new ActivationGate();
    this.lifecycle.use(gate);
    startBeforeRpc(this, ORCHESTRATOR_STARTED_RPC, () => (this.nimbusSibling ? Promise.resolve() : gate.ready()));
  }

  /** A Nimbus sibling (docs/NIMBUS-INTEGRATION.md); no workspace name holds `:`. */
  private get nimbusSibling(): boolean {
    return this.addressedName.startsWith('nbf:');
  }

  protected override hostsActor(): boolean {
    return !this.nimbusSibling;
  }

  /** Nimbus enters by `idFromString`, and the platform fixes `ctx.id` for the activation, so it has no name. */
  private recordedName(): string | undefined {
    if (!tableExists(this.boundSql, 'workspace_identity')) return undefined;
    const name = this.sql<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0]?.name;

    if (name !== undefined && this.ctx.storage.kv.get(PERSISTED_NAME_KEY) !== name) {
      this.ctx.storage.kv.put(PERSISTED_NAME_KEY, name);
    }

    return name;
  }

  override get name(): string {
    return this.addressedName;
  }

  protected actorKind(): AgentKind {
    return 'orchestrator';
  }

  /** Shared across boot retries. */
  private _workspace: HostedWorkspace | undefined;

  /** A move tells every page, so an unseen Changes tab reads a hire's write too. */
  private readonly changes = new ChangeSetCache(() => {
    this.broadcastToActor(null, JSON.stringify({ type: CHANGES_MOVED_EVENT }));
  });

  private _liveReads: LiveReadsNotice | undefined;

  /** Lazy: the base constructor writes through `sql` before any field of this class exists. */
  private get liveReads(): LiveReadsNotice {
    this._liveReads ??= new LiveReadsNotice((frame) => { this.broadcastToActor(null, frame); }, (flush) => { this.deferLiveReads(flush); });

    return this._liveReads;
  }

  protected deferLiveReads(flush: () => void): void {
    setTimeout(flush, 0);
  }

  protected override liveReadsMoved(reads: readonly LiveRead[]): void {
    this.liveReads.moved(reads);
  }

  /** Every actor of this object writes through here. */
  override sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const rows = super.sql<T>(strings, ...values);
    let reads = READS_BY_STATEMENT.get(strings);

    if (reads === undefined) {
      reads = readsWrittenBy(strings.join('?'));
      READS_BY_STATEMENT.set(strings, reads);
    }

    this.liveReads.moved(reads);

    return rows;
  }

  private hostedWorkspace(): HostedWorkspace {
    this._workspace ??= createHostedWorkspace({
      ctx: this.ctx,
      env: this.env,
      previewUrl: (port, capability) => nimbusPreviewUrl(this.env, this.name, port, capability),
      onFilesChanged: (paths) => {
        this.changes.touched(paths);
        this.liveReadsMoved(readsMovedByFiles(paths));
        const ids = this.slates.filesChanged(paths);

        if (ids.length === 0) return;

        this.noteTurnSlates('changed', ids);
        this.broadcastToActor(null, JSON.stringify({ type: SLATES_CHANGED_EVENT, ids }));
        this.overviewChanged();
      },
      onPortsChanged: () => { this.liveReadsMoved(['getExposedPorts', 'listSlates']); },
      ensureSlate: (owner) => this.slates.ensureDurable(owner),
      slateInvocation: (port, socket) => this.slates.slateInvocation(port, socket),
      ...(this.pictureCapture() !== null && {
        pictures: {
          captures: (port, handle) => this.pictures.captures(port, handle, Date.now()),
          rendered: (slate, port) => {
            this.pictures.rendered(slate, port, Date.now());
            this.armDurableWake();
          },
        },
      }),
    });

    return this._workspace;
  }

  private _pictures: SlatePictures | undefined;

  private get pictures(): SlatePictures {
    this._pictures ??= new SlatePictures(this.ctx.storage.sql);

    return this._pictures;
  }

  private pictureCapture(): PictureCapture | null {
    const { BROWSER: browser, SLATE_PICTURES: bucket } = this.env;

    if (bucket === undefined) return null;

    return {
      workspace: this.name, bucket,
      url: async (port, token) => (await nimbusPreviewUrl(this.env, this.name, port, token)).url ?? null,
      slates: async () => {
        const listing = await this.slates.list(ROOT_SLATE_CALLER);

        return new Set([...listing.slates, ...listing.problems].map((slate) => slate.id));
      },
      camera: () => browserCamera(browser),
    };
  }

  protected workspaceBox(shellId: string): NimbusSandboxHandle {
    return this.hostedWorkspace().box(shellId);
  }

  /** Every owner-library call crosses the UserDO capability gate. Absent until the workspace
   *  is claimed. */
  private getExperienceDeps(): ExperienceActionDeps | undefined {
    if (!this.getOwnerUserDO()) return undefined;

    return {
      rt: this.rt,
      facts: this.facts,
      library: experienceLibraryOver(() => this.userHub()),
    };
  }

  /**
   * Owner-driven publish / search / import. Runs on the workspace DO because publishing happens
   * under the workspace's own name and import stages into this workspace's ledger.
   */
  @callable()
  async experienceAction(input: ExperienceActionInput) {
    const deps = this.getExperienceDeps();

    if (!deps) {
      return { error: 'This workspace has no owner yet, so there is no experience library to reach.' };
    }

    return runExperienceAction(deps, { value: input });
  }

  /**
   * Pid, writer incarnation and lease owner are stamped by the supervisor entrypoint, never the facet. Skips
   * `onStart`. Not `@callable`: a browser could otherwise run any op under any pid.
   */
  async supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult> {
    return await this.hostedWorkspace().supervisorOp(envelope);
  }

  /**
   * Hosted actors use `WorkspaceHostSeams.workspaceBox` in the root's isolate; the uid-bearing
   * exec handle is not exposed through a file-forwarding RPC surface.
   */

  /** A promise so the workspace boots on the first provision, never at activation. */
  private facetHomeHost(): Promise<NodeHomeHost> {
    return this.hostedWorkspace().bundle.privileged()
      .then((privileged) => ({ ...privileged, sql: this.ctx.storage.sql }));
  }


  private _actorHost: ActorHost | null = null;
  /** Read by the host at first acquire; in memory because a creation and its first acquire
   *  share one activation, and later acquires find the pointer already durable. */
  private readonly _chosenLoopOrigins = new Map<string, LoopOrigin>();
  /**
   * In memory only; an entry lives exactly as long as its run (`hostHead` drops it in
   * `finally`), so a re-registered head cannot inherit a previous run's changes.
   */
  private readonly _actorWriteObservers = new Map<string, WriteObserver>();

  /** The workspace's single actor host over this object's own storage (open-38); every logical
   * actor comes from here. */
  protected actorHost(): ActorHost {
    this._actorHost ??= createWorkspaceActorHost(this.workspaceHostSeams());

    return this._actorHost;
  }

  protected actorDirectoryStore(): WorkspaceActorDirectory {
    return this.workspaceActors();
  }

  /**
   * Immutable catalogs are shared by value; per-actor state (event log, governor, broadcast)
   * is built per actor in `actor-hosting.ts` and is never this object's own.
   */
  /** The single adapter from the DO's `SqlStorage` to core's positional `SqlExec`. */
  protected boundExec(): SqlExec {
    return { exec: (query: string, ...bindings: SqlValue[]) => this.ctx.storage.sql.exec(query, ...bindings) };
  }

  private workspaceHostSeams(): WorkspaceHostSeams {
    return {
      env: this.env,
      ctx: this.ctx,
      agent: this,
      currentTurn: (reference) => this.currentTurnOf(reference),
      exec: this.boundExec(),
      sql: this.boundSql,
      directory: this.workspaceActors(),
      workspaceName: this.workspaceName(),
      installedBuild: () => this.env.CF_VERSION_METADATA?.id ?? null,
      ownerUserId: () => this.getOwnerUserId(),
      capabilityToken: () => this.workspaceCapabilityToken(),
      workspaceBox: (shellId) => this.workspaceBox(shellId),
      homeHost: () => this.facetHomeHost(),
      // The root's durable program is always readable because the root is this runtime;
      // `loopFor` explains why hosting is the wrong question.
      rootRuntime: () => this.rt,
      // Same profile authority an actor chat resolves through, so a role restriction narrows
      // a chat and a head identically; branches under an unresolved profile are unreproducible.
      resolveProfile: (input) => this.hostedActorProfile(input),
      reportModelCall: (report) => { this.reportModelCall(report); },
      liveReadsMoved: (reads) => { this.liveReadsMoved(reads); },
      modelOperations: this.modelOperations,
      pricing: (spec) => this.modelCatalog.pricing(spec),
      hostedModel: (actor) => this.hostedModelOf(actor),
      broadcast: (actorId, event) => { this.broadcastToActor(actorId, JSON.stringify({ ...event, actorId })); },
      turnClaimChanged: () => { this.overviewChanged(); },
      enqueueTurn: (actor, input) => this.enqueueHostedTurn(actor, input),
      // Use the reference the host issued, never one rebuilt from an id: the root's parent is
      // null, and a synthesized reference makes `hosted()` refuse the root's liveness read.
      turnInFlight: (actor) => {
        const live = this.actorHost().hosted(actor.reference);

        return live !== null && live.session.inFlight;
      },
      setTimer: (fn, ms) => { this.host.setTimer(fn, ms); },
      reconcileDurableWake: () => { this.durableWakeOwner()(); },
      logActivity: (actorId, event, detail) => { this.logActivity(event, detail === undefined ? actorId : `${actorId} ${detail}`); },
      tracing: () => this.tracing,
      slate: (actor, operation) => this.slateAs(
        { path: [{ name: actor.name }], cred: ROOT_SLATE_CALLER.cred, workMode: 'build' }, operation,
      ),
      deferrals: () => this.deferralChannel(),
      refinementLane: () => async () => { await refinementPass(this.refinementDeps); },
      advisorPort: (reference) => this.temporaryAgentPort(reference),
      chosenLoopOrigin: (record: WorkspaceActor) => this._chosenLoopOrigins.get(record.actorId) ?? null,
      chosenWriteObserver: (record: WorkspaceActor) => this._actorWriteObservers.get(record.actorId) ?? null,
    };
  }

  /**
   * The actor's own event log is the durable queue: admission is a write plus a drain.
   * Mode comes from turn metadata via core's reader, which defaults to `build`.
   */
  private async enqueueHostedTurn(
    actor: BoundActor, input: ProgrammaticTurn,
  ): Promise<EnqueueTurnResult> {
    const admitted = await admitHostedTask(this.hostedSeams(), actor.reference, {
      kind: 'message', body: input.text, mode: workModeForTurnMetadata(input.metadata),
    });

    return { status: admitted.admitted ? 'queued' : 'skipped' };
  }

  protected hostedSeams(): HostedActorSeams {
    return {
      host: this.actorHost(),
      exec: this.boundExec(),
      directory: this.workspaceActors(),
      transaction: (body) => this.ctx.storage.transactionSync(body),
      roster: (actor) => new SubordinateRosterStore(this.watchedExec, actor.handle),
      vfs: () => this.rt.storage.vfs,
      // The hire's own role, not the root's: a delegated turn's prompt and advertised tool
      // surface are framed from it.
      profile: (input) => this.hostedActorProfile({ ...input, actor: input.actor.handle }),
      resolveModel: (spec) => this.ownedModelServices.resolveModel(spec),
      priceAs: (actor, spec) => this.priceHostedModel(actor.handle, spec),
      suggestTitle: (mission) => this.suggestTitle(mission),
      taskProfile: (turn) => this.hostedTaskProfile(turn),
      dynamic: (actor, profile, tools) => this.hostedActorDynamicContext(actor, profile, tools),
      announce: () => { this.broadcastSubordinatesChanged(); },
      // The root's turns run on this object's own chat loop, not its hosted slot.
      scheduleDrain: (actor) => {
        if (actor.record.parentActorId === null) {
          this.orch.scheduleDrain();

          return;
        }

        // One not hosted is opened by the durable wake, which also outlives a reset.
        this.actorHost().hosted(actor.reference)?.session.orchestrator.scheduleDrain();
        this.armDurableWake();
      },
      armWake: () => { this.armDelegationWake(); },
      temporary: (actor) => this.temporaryAgentPort(actor.reference),
      rederiveWake: () => { this.armDurableWake(); },
      oweAdvice: (actor) => this.advice.owe(actor.reference.actorId),
      register: async ({ creationId, loop }) => {
        const entry = await this.actorDirectory({
          action: 'register', creationId, name: explorationActorKey(creationId), origin: 'swarm', lifetime: 'task',
        });

        if (loop) this._chosenLoopOrigins.set(entry.reference.actorId, loop);

        return entry.reference;
      },
      watchWrites: (reference, writes) => {
        this._actorWriteObservers.set(reference.actorId, writes);

        return () => { this._actorWriteObservers.delete(reference.actorId); };
      },
      webSearch: () => this.ownedModelServices.getWebSearchProvider(),
      // The host's own provisioner, the one every hosted runtime is built over, so the node's
      // disclosed boundary and its real credential are the same fact.
      nodeHome: (actor) => provisionHostedActorHome(
        { homeHost: () => this.facetHomeHost(), directory: this.workspaceActors() },
        actor.record, actor.reference,
      ),
      codemodeTool: (runtime, webSearch) => {
        const factory = createCodemodeToolFactory({
          loader: this.env.LOADER, egress: codemodeEgress({ workspace: this.workspaceName(), actor: runtime.actor.actorId }), rt: runtime,
          sql: this.boundSql, workspace: this.workspaceName(), webSearch, browserSessions: this.browserSessionsFor(runtime.actor.actorId),
        });

        return (finished) => factory.toolFor(finished);
      },
      recordStep: async (headId, seq, step) => { await this.recordHeadStep(headId, seq, step); },
      publishDelta: (kind, delta) => { this.publishHeadStreamFrame({ headId: '', kind, delta }); },
      mission: (input) => {
        const labels = input.missionLabels ?? [];

        if (labels.length === 0) return null;

        // In-process: the ledger is this object's and a hosted head runs in this isolate.
        return {
          labels,
          port: {
            guard: (seam, scope) => this.missionGuard(seam, scope),
            debit: (tokens, opts) => this.missionDebit(tokens, opts),
          },
        };
      },
      // Journal and merge model belong to the workspace, keeping every subtree's journal and
      // step rows joinable in one database (C2).
      split: (_actor, _runtime, input) => (request) => this.runHostedSplit(input, request),
    };
  }


  /**
   * Full `buildActorTools` surface over the actor's own runtime, minus `peers` (it would
   * escape the subtree); codemode built last; all calls wrapped into the run's capture.
   */
  private async hostedTaskProfile(turn: HostedTaskTurn): Promise<HostedTaskProfile> {
    const webSearch = this.ownedModelServices.getWebSearchProvider();

    const factory = createCodemodeToolFactory({
      loader: this.env.LOADER, egress: codemodeEgress({ workspace: this.workspaceName(), actor: turn.runtime.actor.actorId }), rt: turn.runtime,
      sql: this.boundSql, workspace: this.workspaceName(), webSearch, browserSessions: this.browserSessionsFor(turn.runtime.actor.actorId),
      // A thunk, so it reads the `report` deps declared below rather than a construction-time copy.
      extraProviders: () => [createReportCodemodeProvider(() => report)],
    });

    const report: ReportToolDeps = {
      report: async (input) => {
        // A run-settling report is the answer.
        const settles = reportSettlesRun(input.status, 'report_tool');

        const relayed = await relayHostedReport(this.hostedSeams(), turn.actor, {
          status: input.status, content: input.content, origin: 'report_tool',
          mode: 'build', sequenceId: `live:${turn.actor.record.name}:${nanoid()}`,
          handoff: input.handoff,
          ...(settles && { answers: turn.turnId }),
        });

        turn.reports.spoke = true;
        turn.reports.settled ||= settles;

        return { id: relayed.id, disposition: relayed.disposition };
      },
    };

    // Named: both the tool surface and the framing read these deps.
    const agents = this.hostedAgentsToolDeps(turn);

    const deps: ActorToolsetDeps = {
      rt: turn.runtime,
      workMode: turn.input.mode,
      // This actor's own conversation, never the workspace's.
      history: turn.actor.stores.history,
      // Keyed on the turn id a recovery re-admits; a fresh id would replay the effect.
      effectClaims: {
        actor: turn.actor.handle,
        sql: turn.runtime.storage.sql,
        turnId: () => turn.turnId,
        durable: (callId, signal) => turn.actor.session.durableCall(callId, signal),
      },
      codemode: ({ native }) => factory.toolFor(native),
      craftedToolExecute: null,
      agents,
      // Rows are `actor_id`-scoped, so a hire's `remember` cannot overwrite what the workspace
      // observed under the same words.
      vectorStore: turn.runtime.vectorStore,
      facts: turn.actor.stores.facts,
      webSearch,
    };

    // `report` belongs only to a parent-driven turn; an owner chat with this actor must not carry it.
    // `runHostedTask` is the only caller, so the gate is satisfied here.
    deps.report = report;
    const tools = withHeadCaptureRecording(buildActorTools(deps), turn.capture);

    // Framing is rendered from these exact tool names; `report` among them makes core's
    // `state/delegation` section name this actor as a hire.
    return { tools, framing: await this.hostedTaskFraming(turn, tools, agents) };
  }

  /**
   * Core's assigned-turn framing over this actor's own prompt surface. AGENTS.md and skills are
   * not read: this path runs no preamble, and unclassified bytes must not become a section.
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
        roleSection: turn.profile.profile.role,
        model: { id: turn.profile.profile.tier.model },
        currentDate: currentDateForPrompt(),
        sectionOverrides: activePromptSectionOverrides(this.boundSql, turn.actor.handle),
        // Makes the prompt address it as a named agent of this workspace, not the workspace's own chat.
        identity: {
          ...(await this.promptIdentity()),
          agent: turn.actor.stores.config.getDisplayName() ?? turn.actor.record.name,
        },
      },
    });
  }

  /**
   * Rungs are bounded by this actor's own depth; at the cap team deps are absent, so
   * hire/ask/send/list/dismiss vanish from the enum rather than refusing.
   */
  private hostedAgentsToolDeps(turn: HostedTaskTurn): AgentsToolDeps {
    const seams = this.hostedSeams();

    const swarm: AgentsSwarmDeps = {
      rt: turn.runtime,
      model: turn.model,
      reportModelCall: (report) => { this.reportModelCall(report); },
      nodeCodemode: (actor) => nodeCodemodeTool(seams, actor),
      webSearch: seams.webSearch(),
      resolveModel: (spec: string) => this.ownedModelServices.resolveModel(spec),
      // Workspace-level seams: a node is an actor of the workspace whoever spawned it.
      hostNode: (node) => hostNodeSeat(seams, node),
      provisionNodeHome: () => async (node) => seams.nodeHome((await hostNodeSeat(seams, node)).actor),
      runtimeForNodeWorkspace: null,
      workers: this.liveWorkers,
      reportNodeDelta: () => (frame) => { this.publishHeadStreamFrame(frame); },
      announceHeadActivity: () => (headId) => { this.announceHeadActivity(headId); },
    };

    const deps: AgentsToolDeps = {
      mode: turn.input.mode,
      swarm,
      budget: this.budget,
    };

    // This turn's own resolution: rungs narrow by the role and tier the claim recorded.
    deps.profile = () => agentsProfileContext(turn.profile.profile, turn.profile.inputs);
    const team = this.hostedTeamToolDeps(turn.actor);

    if (team !== null) deps.team = team;

    return deps;
  }

  /** Built from this actor's own roster. Null at the cap. */
  private hostedTeamToolDeps(actor: HostedActor): TeamToolDeps | null {
    const seams = this.hostedSeams();
    const delegation = hostedDelegationBudget(seams, actor);

    if (delegationExhausted(delegation)) return null;
    const roster = seams.roster(actor);
    roster.ensureSchema();

    return createTeamToolDeps({
      delegation,
      roster,
      runtime: hostedSubordinateRuntime(seams, () => actor),
      temporary: seams.temporary(actor),
      now: () => Date.now(),
      inheritedContext: () => this.readInheritedContext(actor.handle),
      originContext: async () => actor.session.history,
      // The workspace's purpose, shared by every actor in it.
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
   * Uses the actor's own stores. No `memoryTail` (framing is the brief, not `MEMORY.md`) and no
   * `missingCapabilities` (hosted actors connect no MCP servers).
   */
  private hostedActorDynamicContext(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext {
    return collectDynamicContext({
      rt: actor.runtime,
      stores: actor.stores,
      profile,
      tools,
      memoryTail: undefined,
      missingCapabilities: [],
      subordinateDelegates: () => subordinateDelegatesOf(
        new SubordinateRosterStore(this.watchedExec, actor.handle).list(),
      ),
    });
  }

  /**
   * The journal is the workspace's: `head_journal` → `head_steps` joins need spawn/report rows and
   * step rows in one database, so a depth-2 head stays readable.
   */
  private async runHostedSplit(parent: HeadInput, request: HeadSplitRequest): Promise<HeadSplitResult> {
    const journal: HeadJournalPort = {
      recordSplit: async (rootId, rationale, spawnedAt) => { await this.headJournalRecordSplit(rootId, rationale, spawnedAt); },
      insertSpawn: async (childInput) => { await this.headJournalInsertSpawn(childInput); },
      recordReport: async (report) => { await this.headJournalRecordReport(report); },
      cacheMerge: async (rootId, narrative) => { await this.headJournalCacheMerge(rootId, narrative); },
    };

    const runtimeForSplit = this.getCFHeadRuntime();

    if (runtimeForSplit === undefined) {
      throw new KinuError('missing', 'This workspace has no owner, so a head cannot split further.');
    }

    return await runHeadSplit(new HeadController(runtimeForSplit, journal, REAL_CLOCK), parent, request);
  }

  /**
   * Home provisioning stays in this isolate: `confinePrincipal` has no RPC, so the host provisions
   * each actor's home via `facetHomeHost()` before building its runtime (`actor-hosting.ts`).
   */

  /** Reached by RPC, or via `fetch` for a WebSocket upgrade, which cannot cross RPC as a 101. */
  async routeWorkspacePreview(
    port: number, handle: string, request: Request, pathname: string,
  ): Promise<Response> {
    return await this.hostedWorkspace().routePreview(port, handle, request, pathname);
  }

  /**
   * Partyserver owns `fetch` for chat, so preview upgrades are answered first; the capability
   * handle is rechecked inside `routePreview`. Share sockets likewise; `routeShare` admits by the share row.
   */
  private readonly _forwarded = new Hono({ getPath: rawPath })
    .all(`${WORKSPACE_PREVIEW_PATH}/*`, beneath(WORKSPACE_PREVIEW_PATH, async (c) => {
      const [port, handle, ...rest] = c.req.path.slice(WORKSPACE_PREVIEW_PATH.length + 1).split('/');
      const parsed = Number(port);

      if (!Number.isInteger(parsed) || !handle) {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }

      return await this.routeWorkspacePreview(parsed, handle, c.req.raw, `/${rest.join('/')}`);
    }))
    .all(`${SLATE_SHARE_PATH}/*`, beneath(SLATE_SHARE_PATH, async (c) => {
      const [handle, claimText, ...rest] = c.req.path.slice(SLATE_SHARE_PATH.length + 1).split('/');

      // The claim segment is JSON the edge wrote; a parse failure yields the same 404 as a bad shape.
      const claim = v.safeParse(
        v.pipe(v.string(), v.parseJson(), ShareViewerClaimSchema),
        claimText ? decodeURIComponent(claimText) : '',
      );

      if (!handle || !claim.success) {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }

      return await this.routeSlateShare(handle, claim.output, c.req.raw, `/${rest.join('/')}`);
    }))
    .notFound(async (c) => super.fetch(c.req.raw))
    .onError(rethrow);

  override async fetch(request: Request): Promise<Response> {
    return await this._forwarded.fetch(request);
  }

  /** A socket forwarded by the terminal route is tagged as the workspace shell, ahead of identity tags. */
  override async getConnectionTags(connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const tags = await super.getConnectionTags(connection, ctx);

    return new URL(ctx.request.url).pathname === WORKSPACE_TERMINAL_PATH ? [WORKSPACE_TERMINAL_TAG, ...tags] : tags;
  }

  /** A terminal socket carries only shell frames, not the SDK's identity, state and MCP frames. */
  override shouldSendProtocolMessages(_connection: Connection, ctx: ConnectionContext): boolean {
    return new URL(ctx.request.url).pathname !== WORKSPACE_TERMINAL_PATH;
  }

  protected override async terminalFor(connection: Pick<Connection, 'tags'>): Promise<WorkspaceTerminal | null> {
    if (!isWorkspaceTerminal(connection.tags)) return null;
    // Building the root runtime registers the mount table this shell serves.
    void this.rt;

    return await this.hostedWorkspace().terminal();
  }

  protected override workModeForMetadata(metadata: JsonObject | undefined): WorkMode {
    return workModeUnderReview(super.workModeForMetadata(metadata), metadata, () => this.stores.planReviews.getActive(CHAT_SESSION_ID));
  }


  /** Send the replies a drained turn owes, then close its delivery leases.
   * False while a reply channel is still open; a failed dispatch or close rejects. */
  private async completeEventBatch(turnId: string, assistantText: string): Promise<boolean> {
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
  }

  /**
   * Open drain leases paired with the answers their turns gave, read from the persisted transcript.
   * Not `this.messages`: recovery may run on an activation that has hydrated nothing.
   */
  private async owedDrainReplies(): Promise<ReadonlyMap<string, string>> {
    const leases = this.eventLog.openDrainLeases();

    return leases.length === 0
      ? new Map<string, string>()
      : answersForDrainTurns(this.chatTranscript, leases);
  }

  /**
   * One `LIMIT 1` read per store, all read so the wake can name them. Runs in the init gate;
   * interpreting a lease is left to {@link owedDeliveryWork}.
   */
  protected override owedUntimedArms(): Required<UntimedArms> {
    return {
      openDrainLease: this.eventLog.hasOpenDrainLease(),
      // Interrupted terminal sequence with no retry instant; one awaiting a retry is timed (`nextOwedAt`).
      terminalIncomplete: this.terminal.hasIncomplete() && this.terminal.nextRetryAt() === null,
      unfinishedHeads: this.headJournal.hasUnfinishedHeads(),
      runningSwarms: this.mctsSearchStore.hasRunningSwarms(),
      // A running job with no resume instant (live or orphaned); jobs waiting on an instant are timed
      // and read by `nextOwedAt`, so a lone deferred job costs one wake at its instant.
      untimedJobs: this.jobs.hasUntimedLiveJobsInWorkspace(),
      retirements: this.workspaceActors().hasRetirements(),
      pendingBirths: this.subordinateRoster.hasPendingBirths(),
      pendingDeletions: this.subordinateRoster.hasPendingDeletions(),
      // An unsettled hosted claim; without this, a workspace whose only owed work is an interrupted
      // hosted turn arms no wake and the recovery arm of `maintenanceWork` never runs.
      unsettledClaims: this.actorHost().resumable(1).length > 0,
      // Admitted but unstarted delegations hold no claim, so `resumable` does not cover them.
      admittedDelegations: this.hasAdmittedDelegations(),
      // The root's loop: a turn a dead process was inside, or an acknowledged send never drained.
      chatLoop: this.chatLoopOwesWork(),
    };
  }

  /** Soonest instant a timed ledger (terminal retry, deferred job resume) owes a wake, or null.
   * Untimed owed work is excluded; it is {@link owedUntimedWork}. */
  protected override nextOwedAt(): number | null {
    const at = Math.min(this.workOwedAt() ?? Infinity, this.overviewRetry?.at ?? Infinity);

    return Number.isFinite(at) ? at : null;
  }

  /** A tile push owed would read Unfinished. */
  private workOwedAt(): number | null {
    const at = Math.min(this.terminal.nextRetryAt() ?? Infinity, this.jobRunner.nextResumeAt() ?? Infinity);

    return Number.isFinite(at) ? at : null;
  }
  /**
   * Workspace-wide on purpose: the alarm serves every actor, so root-only scoping would sleep through
   * a child's admitted task. Matches `EventLog.pending`'s predicate; bounded at one row.
   */
  private hasAdmittedDelegations(): boolean {
    return this.boundExec().exec(
      `SELECT 1 FROM agent_log
       WHERE kind = 'event' AND variant = 'subordinate_task'
         AND turn_id IS NULL AND (step_idx IS NULL OR step_idx >= 0)
       LIMIT 1`,
    ).toArray().length > 0;
  }

  /** A lease from before this activation lost its runner; effects dedupe on rerun. */
  private rependDeadActivationLeases(): void {
    const rows = this.boundExec().exec(
      `UPDATE agent_log SET turn_id = NULL, step_idx = NULL, consumed_at = NULL
       WHERE kind = 'event' AND variant = 'subordinate_task' AND turn_id LIKE 'evt-%'
         AND consumed_at IS NOT NULL AND consumed_at < ?
       RETURNING id`,
      this.activationStartedAt,
    ).toArray();

    for (const row of rows) {
      diagnostics.event('subordinate.assignment_repended', { workspace: this.name, assignment: v.parse(LeasedRowSchema, row).id, cause: 'dead_activation' });
    }
  }

  protected readonly delegatedTurns = new DelegatedTurnRunners({
    pass: (record) => this.drainActorAssignments(record),
    holdLane: async (body) => {
      await this.runFiber(DELEGATION_LANE_FIBER, async (ctx) => {
        ctx.stash({ lane: DELEGATION_LANE_FIBER });
        await body();
      });
    },
    failed: (record, error) => {
      diagnostics.failure('subordinate.delegation_drain_failed', error, { workspace: this.name, ...(record !== null && { actor: record.name }) });
    },
  });

  /**
   * Admitted delegated turns run on a fiber, off the wake: inside it a turn held the alarm to its
   * 15-minute wall, whose reset closed every socket (warm-forge-4d6acc02, 2026-09-25).
   */
  /** One the owner added has its own Stop. */
  protected override stopSubtree(actorId: string): void {
    const seams = this.hostedSeams();
    const directory = this.actorDirectoryStore();

    const rosterOf = (actor: WorkspaceActor) => {
      const hirer = directory.retained(actor.parentActorId ?? '');

      return hirer === null ? null : { hirer, roster: seams.roster(this.actorHost().bindStores(actorReferenceOf(hirer))) };
    };

    const ownerMade = (actor: WorkspaceActor): boolean => {
      for (let step: WorkspaceActor | null = actor; step !== null && step.actorId !== actorId; step = directory.retained(step.parentActorId ?? '')) {
        if (step.origin === 'user') return true;
      }

      return false;
    };

    const below = subordinateDescendants(this.workspaceActors().list(), actorId).filter((actor) => !ownerMade(actor));

    if (below.length === 0) return;

    this.detachOwned(async () => {
      for (const actor of below) {
        const reference = actorReferenceOf(actor);
        const log = new EventLog(this.boundExec(), this.actorHost().bindStores(reference).handle);

        for (const pending of log.pending({ variant: 'subordinate_task' })) log.dismiss(pending.id, 'stopped by the owner', 'system');
        const live = this.actorHost().hosted(reference);

        if (live?.session.inFlight === true) {
          live.session.interrupt();
          continue;
        }

        const held = rosterOf(actor);

        if (held === null) continue;
        const { hirer, roster } = held;

        if (roster.get(actor.name)?.status !== 'working') continue;
        roster.applyReport(actor.name, 'blocked', 'turn_end', Date.now());

        if (actor.lifetime === TEMPORARY_LIFETIME) {
          await this.actorHost().retire(actorReferenceOf(hirer), actorRetirementFor({ reference, name: actor.name, keepHistory: true, interrupt: true }));
        }
      }
    });
  }

  /** A waiting hired agent holds no transcript; its rows reopen it. */
  private releaseIdleHosted(reference: ActorReference): void {
    const live = this.actorHost().hosted(reference);

    if (live !== null && !live.session.inFlight) this.actorHost().release(reference);
  }

  private hostedReactionsDueAt(now: number): number | null {
    const due = this.workspaceActors().list()
      .filter((record) => isSubordinateOrigin(record.origin) && record.retiringAt === null)
      .map((record) => new EventLog(this.boundExec(), this.actorHost().bindStores(actorReferenceOf(record)).handle).nextPendingDrainAt(now) ?? Infinity);

    const at = Math.min(Infinity, ...due);

    return Number.isFinite(at) ? at : null;
  }

  private drainHostedReactions(now: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const record of this.workspaceActors().list()) {
        if (!isSubordinateOrigin(record.origin) || record.retiringAt !== null) continue;
        const reference = actorReferenceOf(record);
        const log = new EventLog(this.boundExec(), this.actorHost().bindStores(reference).handle);
        const dueAt = log.nextPendingDrainAt(now);

        if (dueAt === null || dueAt > now) continue;

        yield* Effect.tryPromise({
          try: () => this.drainHostedActor(reference),
          catch: (cause) => authoredRefusal({ doing: 'draining a hired agent', cause }),
        }).pipe(Effect.catch((failure) => Effect.sync(() => {
          diagnostics.failure('event.hosted_wake_drain_failed', failure, { workspace: this.name, actor: record.name });
        })));
      }
    });
  }

  /** One hired agent's due reactions; failure rejects with a classified error. */
  drainHostedActor(reference: ActorReference): Promise<void> {
    return settle(attempt({ doing: 'draining a hired agent\'s reactions this wake was armed for', otherwise: 'io' }, async () => {
      await (await this.actorHost().acquire(reference)).session.orchestrator.drainPendingEvents({ rethrow: true });
      this.releaseIdleHosted(reference);
    }));
  }

  private settledTaskAgent(record: WorkspaceActor): boolean {
    const directory = this.actorDirectoryStore();

    if (directory.retained(record.actorId)?.retiringAt !== null) return true;

    if (record.lifetime !== TEMPORARY_LIFETIME) return false;
    const hirer = directory.retained(record.parentActorId ?? '');

    return hirer !== null && this.hostedSeams().roster(this.actorHost().bindStores(actorReferenceOf(hirer))).get(record.name)?.status === 'dismissed';
  }

  private startDelegationDrain(): void {
    const hires = this.workspaceActors().list().filter((record) => isSubordinateOrigin(record.origin));

    for (const orphan of dismissOrphanedAssignments(this.boundExec(), new Set(hires.map((record) => record.actorId)))) {
      diagnostics.event('subordinate.assignment_orphaned', { workspace: this.name, actor: orphan.actorId, assignment: orphan.id });
    }

    this.delegatedTurns.start(hires);
  }

  private async drainActorAssignments(record: WorkspaceActor): Promise<boolean> {
    const seams = this.hostedSeams();

    const reference: ActorReference = {
      actorId: record.actorId, workspaceId: record.workspaceId, parentActorId: record.parentActorId,
    };

    // `bindStores` still refuses a retired or re-parented actor.
    const log = new EventLog(this.boundExec(), this.actorHost().bindStores(reference).handle);

    const swept = await drainAssignments(log, {
      now: Date.now(), budget: HOSTED_DELEGATION_DRAIN_BUDGET, staleMs: STALE_EVENT_DELIVERY_MS,
      run: async (task) => {
        const room = this.chatRooms.hostedRoom(record.actorId);
        const answerId = crypto.randomUUID();

        // A hirer's delivery opens the chat as an event naming the hirer; a chat send wrote its own row.
        if (task.messageId === undefined) await this.recordDelegatedTask(reference, record, task);

        // Every delivery has its opening row now, so open panes are sent the transcript holding it.
        await room?.openTurn({ turnId: task.messageId ?? task.sequenceId, messageId: answerId, userTurn: true, carried: [] });

        try {
          await runHostedTask(seams, reference, task, {
            ...(room !== null && { observeStream: (chunks, call) => room.observe(chunks, call) }),
            answered: async ({ completion, error }) => {
              await this.recordHostedChatAnswer(reference, answerId, completion);

              if (error !== null) await room?.deliver({ type: 'error', message: error });
              await room?.closeTurn();
            },
          });
        } catch (cause) {
          await room?.deliver({ type: 'error', message: renderThrownChain({ cause }) });
          throw cause;
        } finally {
          await room?.closeTurn();

          // Released first: a drain armed on this session would fire against the release and keep its transcript
          // until then. Mid-turn reports, a reset's re-run too, go to the durable wake, which reopens the agent.
          this.releaseIdleHosted(reference);

          if (!this.settledTaskAgent(record)) this.hostedSeams().scheduleDrain(this.actorHost().bindStores(reference));
        }
      },
      onFailure: ({ cause }) => {
        diagnostics.failure('subordinate.delegated_turn_failed', toKinuError({
          doing: 'running a delegated turn this workspace admitted', cause, otherwise: 'io',
        }), { workspace: this.name, actor: record.name });
      },
    });

    return swept.truncated;
  }

  /**
   * Re-pend assignment rows whose recovered turn claims are still owed, so the sweep below re-runs them.
   * Safe: a delegated turn's id is its row id, so the re-run keeps its `sequenceId` and reports dedupe.
   */
  private rependRecoveredAssignments(owedClaims: readonly string[]): void {
    if (owedClaims.length === 0) return;
    const owed = new Set(owedClaims);
    const exec = this.boundExec();

    for (const turn of this.actorHost().resumable()) {
      if (!isSubordinateOrigin(turn.record.origin) || !owed.has(turn.claim.turnId)) continue;

      try {
        const bound = this.actorHost().bindStores({
          actorId: turn.record.actorId,
          workspaceId: turn.record.workspaceId,
          parentActorId: turn.record.parentActorId,
        });

        const log = new EventLog(exec, bound.handle);

        if (log.isAnswered(turn.claim.turnId)) {
          bound.stores.claims.settleRecovered(turn.claim.turnId, turn.claim.epoch, 'completed');
          continue;
        }

        log.unbind(turn.claim.turnId);
        diagnostics.event('subordinate.assignment_repended', {
          workspace: this.name, actor: turn.record.name, assignment: turn.claim.turnId,
        });
      } catch (cause) {
        diagnostics.failure('subordinate.assignment_repend_failed', toKinuError({
          doing: 'returning an interrupted delegated turn to the admitted queue', cause, otherwise: 'io',
        }), { workspace: this.name, actor: turn.record.name });
      }
    }
  }

  private async retireStalledAssignments(stalled: readonly ResumableActorTurn[]): Promise<void> {
    for (const turn of stalled) {
      if (!isSubordinateOrigin(turn.record.origin)) continue;

      try {
        const child = await this.actorHost().acquire(actorReferenceOf(turn.record));
        await retireStalledTask(this.hostedSeams(), child, {
          turnId: turn.claim.turnId, runs: turn.claim.epoch, workMode: turn.claim.workMode,
        });
      } catch (cause) {
        diagnostics.failure('subordinate.stalled_retire_failed', toKinuError({
          doing: 'retiring a delegated turn whose runs stalled', cause, otherwise: 'io',
        }), { workspace: this.name, actor: turn.record.name });
      }
    }
  }

  /**
   * Resend the reply an answered event batch never dispatched; the outbox key makes a resend idempotent.
   * Must run before the unbind sweep so an answered batch is finished rather than re-asked.
   */
  protected override async owedDeliveryWork(): Promise<void> {
    // Order: sweep with the answered set excluded, then replies, then the terminal replay
    // (which closes the same leases when it finishes a transition).
    let owed: ReadonlyMap<string, string> = new Map<string, string>();

    try {
      owed = await this.owedDrainReplies();

      const reconciledEventIds = this.eventLog.unbindStale(
        STALE_EVENT_DELIVERY_MS, Date.now(), new Set(owed.keys()),
      );

      if (reconciledEventIds.length > 0) {
        diagnostics.event('event.deliveries_repended', { workspace: this.name, events: reconciledEventIds.length });
        this.orch.scheduleDrain();
      }
    } catch (err) {
      diagnostics.failure('event.stale_delivery_unbind_failed', toKinuError({
        doing: 'unbinding event deliveries a dead activation left leased',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    }

    // One reply's failure leaves only its lease open (keeping the wake armed for it);
    // the other owed replies and the terminal replay below still run.
    for (const [drainTurnId, answer] of owed) {
      try {
        const closed = await this.completeEventBatch(drainTurnId, answer);
        diagnostics.event('event.owed_reply_resumed', { drainTurnId, closed });
      } catch (err) {
        diagnostics.failure('event.owed_reply_failed', toKinuError({
          doing: 'finishing an event reply a drained turn still owes',
          cause: err,
          otherwise: 'io',
        }), { drainTurnId });
      }
    }

    await super.owedDeliveryWork();
  }

  private _engine: EvolutionEngine | null = null;
  private _emailOutbox: EmailOutbox | null = null;
  /** Outbound-email intent log (SPEC §7.4); creates its own table on first use. */
  private get emailOutbox(): EmailOutbox {
    this._emailOutbox ??= new EmailOutbox(this.ctx.storage.sql, (at) => this.wakes.arm(KINU_TIMER_JOB, at));

    return this._emailOutbox;
  }

  /** Approvals combine consent prompts and parked commands; a parked command's effect has not happened. */
  protected override extraDynamicContext(): ActorDynamicContextExtras {
    return {
      approvals: () => {
        const items = [...this.consents.approvals(), ...this.deferrals.approvals()];

        return { items, total: items.length };
      },
      extraMissingCapabilities: () => {
        const deafInbox = this.emailInbox.dropNotice(Date.now());

        return deafInbox ? [deafInbox] : [];
      },
    };
  }



  // Steer-as-Branch redirects against the in-flight turn; settle into Alternate Takes on completion.
  protected _pendingBranches: PendingBranch[] = [];

  private _triggerRegistry: TriggerRegistry | null = null;
  private _replyChannels: ReplyChannelStore | null = null;
  private _cacheWarming: CacheWarmingLane | null = null;

  /** Wakes go through the Kinu timer job, never `setTimeout`: nothing in the isolate survives hibernation. */
  protected get cacheWarming(): CacheWarmingLane {
    this._cacheWarming ??= new CacheWarmingLane({
      store: new CacheWarmStore(this.boundSql, this.actorHandle()),
      // `armDurableWake` re-derives the soonest wake over every source, so the instant is not passed.
      wake: () => { this.armDurableWake(); },
      send: async ({ modelSpec, body }) => {
        const providers = this.providerRegistry();
        const provider = providers.registry.get(modelSpec.provider);

        if (provider?.warmCache === undefined) return null;

        const deps = accountDeps(providers.deps, modelSpec.provider, modelSpec.account);

        return provider.warmCache(modelSpec.modelId, deps, body);
      },
      spend: (report) => { this.reportModelCall(report); },
      now: () => Date.now(),
    });

    return this._cacheWarming;
  }

  protected override cacheWarmingLane(): CacheWarmingLane {
    return this.cacheWarming;
  }

  protected get triggerRegistry(): TriggerRegistry {
    if (!this._triggerRegistry) {
      const alarmScheduler: AlarmScheduler = {
        scheduleAt: (ts: number) => this.wakes.arm(KINU_TIMER_JOB, ts),
      };

      this._triggerRegistry = new TriggerRegistry(this.ctx.storage.sql, this.actorHandle(), alarmScheduler);
    }

    return this._triggerRegistry;
  }
  protected get replyChannels(): ReplyChannelStore {
    if (!this._replyChannels) {
      // Context resolves per dispatch so binding/display-name changes never go stale.
      const emailDispatcher = createEmailThreadDispatcher(() => ({
        email: this.env.EMAIL,
        agentDisplayName: this.safeDisplayName(),
        outbox: this.emailOutbox,
      }));

      this._replyChannels = new ReplyChannelStore(this.ctx.storage.sql, this.actorHandle(), {
        // Lazily bound: PeerHub needs this store to construct.
        peer_back: {
          dispatch: (channel, payload) => this.peerHub.dispatchPeerBack(channel, payload),
        },
        email_thread: emailDispatcher,
      });
    }

    return this._replyChannels;
  }

  /** Never throws pre-schema; an untitled workspace sends as the product, not its slug. */
  private safeDisplayName(): string {
    try { return this.titleState().displayName || UNTITLED_WORKSPACE_NAME; }
    catch (error) {
      diagnostics.event('orchestrator.display_name_unreadable', { error: renderThrownChain({ cause: error }) });

      return UNTITLED_WORKSPACE_NAME;
    }
  }

  // Peer transport (agent teams): `outbox_peer` rows go out via DO RPC (inline + alarm retry);
  // receivePeerMessage below is the receiver.
  private _peerHub: PeerHub | null = null;

  /** Resolved at call time: a toolset built before the claim must still see the owner after it. */
  private requireOwnerUserId(): string {
    const userId = this.getOwnerUserId();

    if (!userId) throw new KinuError('unavailable', 'Agent has no owner yet: peer messaging needs an owned agent.');

    return userId;
  }

  protected get peerHub(): PeerHub {
    this._peerHub ??= new PeerHub({
      sql: this.ctx.storage.sql,
      log: this.eventLog,
      replyChannels: this.replyChannels,
      vfs: () => this.rt.storage.vfs,
      selfAgentName: () => this.name,
      selfUserId: () => this.requireOwnerUserId(),
      deliver: async (receiverAgentName, msg) => {
        const stub = this.env.OrchestratorAgent.get(
          this.env.OrchestratorAgent.idFromName(receiverAgentName),
        );

        return await stub.receivePeerMessage(msg);
      },
      isSameOwner: async (senderUserId) => senderUserId === this.getOwnerUserId(),
      // A failed lookup is not a refusal: it rejects the delivery, and the sender's outbox retries it.
      hasGrant: async (senderAgentName, senderUserId) => {
        const { stub, caller } = await this.userHub();

        return await stub.hasPeerGrant(caller, senderAgentName, senderUserId);
      },
      scheduleDispatch: (at) => this.wakes.arm(KINU_TIMER_JOB, at),
      onAdmitted: () => { this.orch.scheduleDrain(); },
    });

    return this._peerHub;
  }

  /** The next wake owed across triggers, peer outbox, email outbox and pending reactions.
   * Every source folded here must have a phase in {@link _kinuTimerTick} (D6); delegation is not. */
  protected nextWakeAt(now: number): number | null {
    return nextAlarmTime(
      now,
      this.triggerRegistry.list({ state: 'active' }).map((t) => t.next_fire_at),
      this.peerHub.nextRetryAt(),
      this.emailOutbox.nextRetryAt(),
      this.eventLog.nextPendingDrainAt(now),
      this.hostedReactionsDueAt(now),
      nextEvolutionAnswerAt(this.boundSql, this.actorHandle().actorId),
      this.cacheWarming.nextWarmAt(),
      // Sleep-time triggers (phase `alarm.sleep_time`); answers only while an unprocessed turn is recorded,
      // and the phase releases that record whenever it refuses.
      this.nextSleepTimeWakeAt(),
      this.pictureCapture() === null ? null : this.pictures.nextDueAt(),
    );
  }

  /**
   * Arms the terminal-retry chain, the only one that drains admitted delegations (reverses the arm
   * half of D3, docs/ARCHITECTURE-DECISIONS.md); the timer's tick never touches assignment queues.
   */
  private armDelegationWake(): void {
    this.armOwedWorkWake('delegation');
  }

  /** `reason` names the obligation that asked for the wake and how an arm failure is reported. */
  private armOwedWorkWake(reason: keyof typeof WAKE_ARM_FAILURE): void {
    const failure = WAKE_ARM_FAILURE[reason];

    this.detachOwned(async () => {
      try {
        await this.scheduleTerminalRetry(Date.now());
      } catch (cause) {
        diagnostics.failure(failure.event, toKinuError({
          doing: failure.doing, cause, otherwise: 'io',
        }), { workspace: this.name });
      }
    });
  }

  /**
   * Re-derive and arm the wake when durable work changed; safe on every ingress since the arm
   * is soonest-wins.
   */
  protected override durableWakeOwner(): () => void {
    return () => this.armDurableWake();
  }

  private armDurableWake(): void {
    const next = this.nextWakeAt(Date.now());

    if (next === null) return;
    this.detachOwned(async () => {
      try {
        await this.wakes.arm(KINU_TIMER_JOB, next);
      } catch (cause) {
        diagnostics.failure('schedule.durable_wake_arm_failed', toKinuError({
          doing: 'arming the wake a pending reaction needs', cause, otherwise: 'io',
        }), { workspace: this.name });
      }
    });
  }

  /** Every pass runs (no short-circuit): each owns a different table and is budgeted and idempotent. */
  protected override maintenanceSweeps(activation = false): boolean {
    const branches = this.reconcileOrphanedBranches();
    const fibers = super.maintenanceSweeps(activation);

    return branches || fibers;
  }

  protected get engine(): EvolutionEngine {
    if (!this._engine) {
      this._engine = new EvolutionEngine(this.rt, this.stores.history, {
        // Verdict row, craft scores, tombstone and announcement commit as one unit via transactionSync.
        transaction: (body) => { this.ctx.storage.transactionSync(body); },
        // The turn review's model calls debit the reviewed turn's mission; unbudgeted turns never reach it.
        governor: this.budget,
        // Replay-eval rollout runs the live scaffold with the real LLM and tool bridges.
        replayTaskRunner: (task) => this.runScaffoldCaptureText(task),
        // Promotion-gate evidence runs on the cadence lane so rollouts don't block the chat queue.
        ...this.shadowTrialPorts,
      });
      this._engine.onEvent((event) => {
        if (event.type !== 'changelog_digest') return;
        this.emailOwnerNotification('Evolution changelog digest', event.message);
      });
    }

    return this._engine;
  }

  /** Non-invertible token hash, safe for the owner's UserDO to read; worker-side DO RPC only. */
  async getWorkspaceCapabilityHash(): Promise<string | null> {
    return this.workspaceCapabilityHash();
  }


  /**
   * Cached owner; a claim never changes mid-activation. Null (unclaimed) is never cached.
   * Protected so a harness cold activation drops it with the other latches.
   */
  protected _ownerUserId: string | undefined;

  /** '' in workspace_identity means unclaimed. */
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
    if (this.storageRefusal !== undefined) throw this.storageRefusal;

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
      // The host does the whole physical retirement in one call: runtime objects, `actor_id` rows in
      // the retirement transaction, and on destroy the home and `.kinu/agents/<key>/` subtree.
      await this.actorHost().retire(caller, {
        reference: input.reference, name: input.name, destroy: true, interrupt: true,
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


  /** The edge's one resolution of a name or `/`-joined path to the actor id everything downstream keys on. */
  async resolveHostedActorRoute(target: string): Promise<{ ok: true; actorId: string } | Refusal> {
    try {
      if (!this.getOwnerUserId()) throw new KinuError('denied', 'The workspace has no owner.');
      const actor = this.hostedTarget(target);

      if (actor === null) throw new KinuError('missing', 'The actor is not available for client execution.');

      return { ok: true, actorId: actor.handle.actorId };
    } catch (cause) {
      return refusalOf(toKinuError({ doing: 'resolving a hosted actor chat path', cause, otherwise: 'io' }));
    }
  }

  /** Each step a live subordinate its parent's roster still employs: a dismissal keeps rows, not chat. */
  private hostedTarget(target: string): HostedTarget | null {
    const directory = this.workspaceActors();
    let parent = this.actorHandle();
    let found: HostedTarget | null = null;

    for (const name of target.split('/')) {
      const handle = directory.resolveChild(parent, name);
      const entry = handle === null ? null : this.rosterOf(parent).get(name);

      if (handle === null || entry === null || entry.status === 'dismissed' || entry.actorReference?.actorId !== handle.actorId) return null;

      const retained = directory.retained(handle.actorId);

      if (retained === null || !isSubordinateOrigin(retained.origin)) return null;
      found = { handle, entry };
      parent = handle;
    }

    return found;
  }

  private rosterOf(parent: ActorHandle): SubordinateRosterStore {
    return parent.actorId === this.actorHandle().actorId ? this.subordinateRoster : new SubordinateRosterStore(this.watchedExec, parent);
  }

  protected override hostedWindowName(actorId: string): string | null {
    const directory = this.workspaceActors();
    const rootId = this.actorHandle().actorId;
    const names: string[] = [];

    for (let row = directory.retained(actorId); row?.actorId !== rootId; row = directory.retained(row.parentActorId ?? '')) {
      if (row === null) return null;
      names.unshift(row.name);
    }

    return names.length === 0 ? null : names.join('/');
  }

  /**
   * The roster is the authority here: directory validation ran at the edge, and dismissal can change under an
   * open socket. The opening row uses the client's id so `admitted` recognises resent lists.
   */
  protected override transcriptFor(actor: ActorHandle): SessionTranscript {
    return this.actorHost().bindStores(actor).stores.history.transcript(CHAT_SESSION_ID);
  }

  private hostedReference(actorId: string): ActorReference | null {
    const path = this.hostedWindowName(actorId);
    const actor = path === null ? null : this.hostedTarget(path);

    return actor?.handle.actorId === actorId ? actor.entry.actorReference : null;
  }

  protected override hostedChatWire(actorId: string): ChatWire | null {
    const reference = this.hostedReference(actorId);

    if (reference === null) return null;
    const bound = this.actorHost().bindStores(reference);
    const history = bound.stores.history;
    const rows = history.transcript(CHAT_SESSION_ID);

    // Opening row first, under the client's id: the hook resends its whole list, and `admitted`
    // stops the same words becoming a second turn.
    const sendNow = async (input: Parameters<ChatWire['send']>[0]): ReturnType<ChatWire['send']> => {
      const message = await history.admitInput({
        id: input.id, turnId: input.id, message: turnInputMessage(input),
        assertOwner: () => bound.handle.assertCurrent(),
      });

      const prepared = await rows.prepareUser({
        id: input.id, turnId: input.id, message, metadata: { kinuMode: input.mode },
      });

      this.ctx.storage.transactionSync(() => rows.appendUser(prepared));

      const handoff = await admitHostedTask(this.hostedSeams(), reference, {
        kind: 'message', body: input.text, mode: input.mode, messageId: input.id,
      });

      // Nothing is armed here: `admitHostedTask` arms the wake (`seams.armWake`), and only that seam knows
      // the right chain; a second arm would duplicate the row or name the wrong chain.

      return handoff.delivery === 'starts_now' ? 'turn' : 'mid-turn';
    };

    return {
      resumes: false,
      getConnection: (id) => this.getConnection(id),
      broadcast: (message, exclude) => { this.broadcastToActor(actorId, message, exclude); },
      history: (limit) => rows.history(limit),
      admitted: (id) => rows.has(id),
      send: (input) => whenActorTakesInput(this.boundSql, actorId, () => sendNow(input)),
      interrupt: () => {
        this.actorHost().hosted(reference)?.session.interrupt();
        this.stopSubtree(actorId);
      },
      clear: () => {
        history.clearConversation(CHAT_SESSION_ID, () => {
          if (this.actorHost().hosted(reference)?.session.inFlight === true) {
            throw new KinuError('denied', 'Stop the active turn before clearing its conversation');
          }
        });

        return Promise.resolve();
      },
    };
  }

  /** Records a hosted turn's answer into that actor's own chat; `runHeadInference` writes only the
   *  run ledger. */
  /** The task row cli-backend's host writes too (`delegatedTaskMetadata`), under the delivery's own id. */
  private async recordDelegatedTask(reference: ActorReference, record: WorkspaceActor, task: AdmittedAssignment): Promise<void> {
    const bound = this.actorHost().bindStores(reference);
    const history = bound.stores.history;
    const rows = history.transcript(CHAT_SESSION_ID);

    if (rows.has(task.sequenceId)) return;
    const hirer = record.parentActorId === null ? null : this.workspaceActors().list().find((actor) => actor.actorId === record.parentActorId);
    const from = hirer === undefined || hirer === null || hirer.parentActorId === null ? MAIN_AGENT : hirer.name;

    const message = await history.admitInput({
      id: task.sequenceId, turnId: task.sequenceId, message: turnInputMessage({ text: task.body }),
      assertOwner: () => bound.handle.assertCurrent(),
    });

    const prepared = await rows.prepareUser({
      id: task.sequenceId, turnId: task.sequenceId, message, metadata: delegatedTaskMetadata(from, task.mode),
    });

    this.ctx.storage.transactionSync(() => rows.appendUser(prepared));
  }

  private async recordHostedChatAnswer(reference: ActorReference, id: string, completion: HeadReport['canonicalCompletion']): Promise<void> {
    if (completion === undefined) return;
    const history = this.actorHost().bindStores(reference).stores.history;
    const transcript = history.transcript(CHAT_SESSION_ID);

    if (transcript.newestId() === null) return;

    const metadata = await this.takeTurnSlates(reference.actorId, completion.turnId, () => transcript.narration(answerParts(completion.outputPartReferences, completion.finalTextReference)));

    const entry = await transcript.prepareAssistant({
      id, turnId: completion.turnId, runId: completion.runId, parts: completion.outputPartReferences,
      finalText: completion.finalTextReference, ...(metadata !== null && { metadata }),
    });

    this.ctx.storage.transactionSync(() => transcript.appendAssistant(entry));
  }
  /** Owner resolution is lazy inside each action: the toolset is cached across turns (including
   *  pre-claim). */
  private getPeersToolDeps(): PeersToolDeps {
    /** Same-owner roster check so a typo'd name errors instead of materializing an unowned DO. */
    const requirePeer = async (agent: string): Promise<void> => {
      this.requireOwnerUserId();

      if (agent === this.name) throw new KinuError('bad_input', 'that is this agent: pick another peer (action:"list")');
      const { stub, caller } = await this.userHub();
      const known = await stub.hasWorkspace(caller, agent);

      if (!known) throw new KinuError('missing', `unknown peer "${agent}": list your team with action:"list"`);
    };

    return {
      listPeers: async () => {
        this.requireOwnerUserId();
        const { stub, caller } = await this.userHub();

        return teamPeers(this.name, await stub.listActiveWorkspaces(caller));
      },
      ask: async ({ agent, topic, message, mode, signal }) => {
        await requirePeer(agent);

        return this.peerHub.ask({ agent, userId: this.requireOwnerUserId(), topic, message, mode, signal });
      },
      send: async ({ agent, topic, message, mode }) => {
        await requirePeer(agent);

        return this.peerHub.send({ agent, userId: this.requireOwnerUserId(), topic, message, mode });
      },
      reply: async ({ eventId, message }) => this.peerHub.reply({ eventId, message }),
      spawnWorkspace: async ({ name, purpose, message, mode, signal }): Promise<PeerSpawnOutcome> => {
        const userId = this.requireOwnerUserId();
        const { stub: userDO, caller } = await this.userHub();
        let agentName = name;
        let created = false;

        if (!agentName || !(await userDO.hasWorkspace(caller, agentName))) {
          const workspaceInput = { name: agentName === '' ? undefined : agentName, purpose };
          const entry = await createCloudWorkspaceForUser({ env: this.env, userId, userDO, caller, input: workspaceInput });
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

  protected actorToolDeps(): ActorToolDeps {
    return {
      ...this.teamProfile(),
      peers: this.getPeersToolDeps(),
      submitPlan: { submit: (edits) => this.submitPlanEdits(edits) },
    };
  }

  /** A constant, not stored: the orchestrator is the root (depth 0), so eviction cannot lose it. */
  protected delegationBudget(): DelegationBudget {
    return ROOT_DELEGATION_BUDGET;
  }


  /** Both providers read deps lazily so a mid-lifetime claimOwner lands without rebuilding eval. */
  protected extraCodemodeProviders(): CodemodeProvider[] {
    return [
      createAgentSelfProvider(agentSelfHost({
        rt: this.rt,
        scaffoldControl: () => this.scaffoldControl,
        triggers: () => this.triggerRegistry,
        jobs: () => this.jobs,
        budget: () => this.budget,
        // Owner's revoke path; drops the webhook secret with the row.
        cancelTrigger: (id, caller) => this.cancelTrigger(id, caller),
        armCompactNow: () => { this.compactionState.armCompaction(this.name, 'force'); },
      })),
    ];
  }

  protected notifyOwner(subject: string, body: string): void {
    this.emailOwnerNotification(subject, body);
  }

  /** Called by the Worker on every authenticated request before any other RPC; 403s on cross-user collision. */
  async claimOwner(userId: string): Promise<{ owner: string; capabilityHash: string | null }> {
    if (!userId) throw new KinuError('bad_input', 'userId required');

    // A hash, not a boolean: the UserDO compares it to its registration so any mismatch gets repaired.
    const capabilityHash = await this.workspaceCapabilityHash();
    const current = this.getOwnerUserId();

    if (current === null) {
      const exists = this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`;

      if (exists.length === 0) {
        this.bearWorkspace(this.name, userId);
      } else {
        this.actorHandle();
        void this.sql`UPDATE workspace_identity SET owner_user_id = ${userId}`;
      }

      this._ownerUserId = userId;
      this.invalidateModelCaches();
      await this.ensureOwnedScaffold();

      // Detached: the loop is never built inside the init gate.
      if (exists.length === 0) this.detachOwned(async () => { this.chatLoop.measureSessionStart(); });

      return { owner: userId, capabilityHash };
    }

    if (current !== userId) {
      throw new KinuError('denied', `Agent owned by a different user (stored=${current.slice(0, 8)}..., caller=${userId.slice(0, 8)}...)`);
    }

    // No scaffold probe here: this runs on every authenticated request. An interrupted bootstrap
    // is finished by beforeTurn, which awaits ensureOwnedScaffold before reading workspace files.
    return { owner: current, capabilityHash };
  }

  // The reactor lives on the core AgentOrchestrator. Ingress uses the debounced
  // `this.orch.scheduleDrain()`; the post-turn hook drains via `this.orch.drainPendingEvents()`.

  private readonly turnSlates = new Map<string, { readonly changed: Set<string>; readonly shown: Set<string> }>();

  private readonly answeredTurns = new Map<string, string[]>();

  private noteTurnSlates(kind: 'changed' | 'shown', ids: readonly string[]): void {
    const actor = activeOperationProfile();

    if (actor === undefined || actor.turnId === WORKSPACE_RUN_ID) return;
    const actorId = actor.actor.actorId;
    const key = this.answeredTurns.get(actorId)?.includes(actor.turnId) === true ? `${actorId}:carried` : `${actorId}:${actor.turnId}`;
    let held = this.turnSlates.get(key);

    if (held === undefined) {
      held = { changed: new Set(), shown: new Set() };
      this.turnSlates.set(key, held);
    }

    for (const id of ids) held[kind].add(id);
  }

  private async takeTurnSlates(actorId: string, turnId: string, texts: () => Promise<readonly string[]>): Promise<JsonObject | null> {
    const taken = [`${actorId}:${turnId}`, `${actorId}:carried`].map((key) => {
      const held = this.turnSlates.get(key);

      this.turnSlates.delete(key);

      return held;
    });

    this.answeredTurns.set(actorId, [...(this.answeredTurns.get(actorId) ?? []).slice(-(ANSWERED_TURNS_KEPT - 1)), turnId]);
    const changed = taken.flatMap((held) => [...held?.changed ?? []]);
    const shown = new Set(taken.flatMap((held) => [...held?.shown ?? []]));
    const vfs = this.hostedWorkspace().bundle.vfs;
    const kept = [];

    for (const id of slatesToPreview(new Set(changed), shown, await texts())) if (await vfs.exists(`${SLATES_ROOT}/${id}`)) kept.push(id);

    return kept.length === 0 ? null : { [SLATES_CHANGED_METADATA_KEY]: kept };
  }

  protected override answerMetadata(turnId: string, texts: () => Promise<readonly string[]>): Promise<JsonObject | null> {
    return this.takeTurnSlates(this.actorHandle().actorId, turnId, texts);
  }

  /**
   * Readings this root's settled response owes; all taken now, before any effect runs, since the
   * list is claimed up front. Row order, lanes and gates belong to {@link declareTerminalRoster}.
   */
  protected owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[] {
    const facts: TerminalTurnFacts = {
      messageId: input.messageId,
      status: input.status,
      workMode: this.turnWorkMode(),
      continuity: this._turnContinuity,
      completed: input.completed,
      userText: input.userText,
      assistantText: input.assistantText,
      // Scoped here: mission labels must travel with every recording, and a cold replay
      // has no active governor scope.
      scopedTurn: projectJsonValue({ value: this.orch.scopedTurn(input.turn) }),
      recordedAt: Date.now(),
      evolutionEnabled: this._turnEvolutionEnabled,
    };

    // Keyed on the turn, not rolled: `queueTurnShadowTrial` re-reads the pending version,
    // so a replay would otherwise score this turn against a candidate not under trial then.
    const sampledVersion = owesShadowTrial(facts) ? shadowTrialPlan(this.scaffoldControl, input.messageId) : null;

    return declareTerminalRoster(facts, this.rosterParts(input, sampledVersion, readMission(this.boundSql)));
  }

  private rosterParts(
    input: OwedTerminalEffectsInput, sampledVersion: number | null, mission: string | null,
  ): TerminalTurnParts {
    const parts: TerminalTurnParts = {
      // Over the row the transcript is about to persist, so a cut turn's announcement replays from it.
      turnEndExtensions: true,
      credited: input.credited,
      craftedToolsUsed: this.acc.craftedToolsUsed(),
      eventReplies: { answered: input.answeredDeliveries, requestId: input.messageId },
      branches: this._pendingBranches.map((branch) => ({ id: branch.id, task: branch.task })),
      overflowRetry: input.overflowRetry,
      outputContinuation: input.outputContinuation,
      taskReminder: input.taskReminder ?? undefined,
      // Owed only when the actor reviews turns, as the lane it replaced was started only then.
      advisor: this.actorSession.reviewsTurns
        ? projectJsonValue({ value: this.advisorSnapshotFor(this.orch.scopedTurn(input.turn), input.reachableTools) })
        : undefined,
      sleepTime: true,
      // The genesis turn owes the naming: the create stored a stand-in title, and no
      // other turn replaces one.
      autoTitle: { mission, standIn: input.event === WORKSPACE_CREATED_EVENT },
      autoGepa: true,
      shadowTrial: sampledVersion === null ? undefined : {
        pendingVersion: sampledVersion,
        // Bounded at declaration: an oversized recorded input fails its SQLite insert partway through
        // a claimed sequence, leaving a prefix recovery reads as the whole roster.
        trialContext: projectJsonValue({
          value: trimTrialContext([...input.trialContext]),
        }),
      },
    };

    return parts;
  }


  /**
   * Every body here must be replayable on its own: each boundary is idempotent at its edge
   * (stable window-append id, keyed extension emit, drain of unbound rows, durable lane queues).
   */
  protected override terminalEffectTable(): TerminalEffectTable {
    return {
      ...this.sharedTerminalEffects(),

      craft_usage: terminalEffect({
        input: v.object({ messageId: v.string(), toolNames: v.array(v.string()) }),
        runSync: ({ messageId, toolNames }) => {
          void this.sql`INSERT INTO turn_craft_usage (actor_id, message_id, tool_names)
                   VALUES (${this.actorHandle().actorId}, ${messageId}, ${JSON.stringify(toolNames)})
                   ON CONFLICT(actor_id, message_id) DO UPDATE SET tool_names = excluded.tool_names`;

          return { status: 'completed' };
        },
      }),

      event_reply: terminalEffect({
        input: v.object({
          drainTurnId: v.string(), answer: v.string(), requestId: v.string(),
        }),
        // Replayable: the outbound-email intent log stamps a deterministic Message-ID per channel.
        // A batch with an open channel reports `owed`, keeping its lease and row for recovery.
        run: async ({ drainTurnId, answer }) => {
          const closed = await this.completeEventBatch(drainTurnId, answer);

          if (!closed) return { status: 'owed', detail: 'a reply channel is still open' };

          return { status: 'completed' };
        },
      }),

      branches: branchesTerminalEffect({
        sql: this.boundSql,
        actor: this.actorHandle(),
        sessionId: 'default',
        broadcast: (event) => this.broadcastBranchStatus(event),
        pending: this._pendingBranches,
        journal: this.headJournal,
      }),

      sleep_time: terminalEffect({
        // No recorded input: evidence is the transcript, read at run time.
        input: v.object({}),
        // Failures must throw, not be swallowed, so the ledger keeps the row owed until the compute
        // actually finishes.
        run: async () => {
          if (!this.config.getSleepTimeComputeEnabled()) return { status: 'completed', detail: 'the lane is off' };
          const window = await this.sleepTimeWindow();

          // Turn-count trigger: a turn below the cadence is left for a later turn or the idle and
          // closed-tab wakes. The logged event is joined by workerd probes beside `memory.facts_compressed`.
          if (!sleepTimeDue(window)) {
            this.armSleepTimeWake(window);
            diagnostics.event('memory.facts_deferred', {
              completedTurns: window.completedTurns, unprocessed: window.turns.length,
            });

            return { status: 'completed', detail: 'the cadence is not due' };
          }

          await this.runSleepTimeCompute(window);

          return { status: 'completed' };
        },
      }),

      auto_title: terminalEffect({
        input: v.object({ subject: v.string(), standIn: v.optional(v.boolean()) }),
        // Replayable. A row without `standIn` over a titled workspace changes nothing; the
        // genesis row keeps `standIn` through retries, so titling is retried until a name lands.
        run: async ({ subject, standIn }) => {
          const unreachable = await this.titlingRefusal();

          if (unreachable !== null) return { status: 'owed', detail: unreachable };
          await this.applyAutoTitle(subject, standIn === true);

          return { status: 'completed' };
        },
      }),

      auto_gepa: terminalEffect({
        input: v.object({}),
        // Awaited so eviction cannot cancel the model work without a pending row. The cadence is a
        // durable turn count, so a replay either runs the owed run or does nothing.
        run: async (_input, scope) => {
          await this.maybeRunAutoGepa(keyedScope(scope));

          return { status: 'completed' };
        },
      }),
    };
  }


  /**
   * `lastRunTurn` is derived from the newest answer tombstoned as read, so a wake and a
   * turn-count trigger cannot both run over one set of turns.
   */
  private async sleepTimeWindow(): Promise<SleepTimeWindow> {
    return sleepTimeWindow(
      await this.chatTranscript.newestFirst(SLEEP_TIME_READ_ROWS),
      (answerId) => effectAlreadyDone(this.boundSql, this.actorHandle(), SLEEP_TIME_APPLIED, answerId),
    );
  }

  /**
   * Armed only when a wake could run; otherwise the row is cleared, avoiding the one-second
   * loop documented on `nextWakeAt`.
   */
  private armSleepTimeWake(window: SleepTimeWindow): void {
    if (window.completedTurns < 2 || window.turns.length === 0) {
      this.config.delete(SLEEP_TIME_SETTLED_AT);

      return;
    }

    this.config.set(SLEEP_TIME_SETTLED_AT, String(Date.now()));
    this.armDurableWake();
  }

  private sleepTimeInstant(key: string): number | null {
    const raw = this.config.get(key);
    const at = raw === null ? Number.NaN : Number(raw);

    return Number.isFinite(at) ? at : null;
  }

  private nextSleepTimeWakeAt(): number | null {
    return sleepTimeWakeAt({
      settledAt: this.sleepTimeInstant(SLEEP_TIME_SETTLED_AT),
      closedAt: this.sleepTimeInstant(SLEEP_TIME_CLOSED_AT),
    });
  }

  /**
   * Runs the idle and closed-tab triggers; returns whether a run landed. The window is re-read, not
   * carried from the arm. A window nothing can run over releases the settled instant.
   */
  private async runSleepTimeIfDue(now: number): Promise<boolean> {
    const settledAt = this.sleepTimeInstant(SLEEP_TIME_SETTLED_AT);

    if (settledAt === null) return false;
    // A lane switched off after the arm also releases the instant.
    const window = this.config.getSleepTimeComputeEnabled() ? await this.sleepTimeWindow() : null;

    if (window === null || window.completedTurns < 2 || window.turns.length === 0 || window.inputPending) {
      this.config.delete(SLEEP_TIME_SETTLED_AT);

      return false;
    }

    const closedAt = this.sleepTimeInstant(SLEEP_TIME_CLOSED_AT);

    const due = sleepTimeDue({
      completedTurns: window.completedTurns,
      lastRunTurn: window.lastRunTurn,
      idleMs: now - settledAt,
      ...(closedAt !== null && { lastConnectionClosedMs: now - closedAt }),
    });

    if (!due) return false;
    await this.runSleepTimeCompute(window);

    return true;
  }

  /** The grace is not armed here; the fold reads this instant beside the settled one, so a
   * reconnect inside the grace clears it. */
  protected override lastConnectionClosed(): void {
    this.config.set(SLEEP_TIME_CLOSED_AT, String(Date.now()));
    this.armDurableWake();
    this.watchDeviceStatus(false);
  }

  protected override connectionOpened(): void {
    this.config.delete(SLEEP_TIME_CLOSED_AT);
    this.overviewChanged();
    this.watchDeviceStatus(true);
    this.recheckSandboxRestore();
  }

  /** A sandbox that died mid-restore sends no settle. */
  private recheckSandboxRestore(): void {
    const namespace = this.env.Sandbox;

    if (namespace === undefined) return;

    if (this.config.get(SANDBOX_STARTING) == null && this.config.get(SANDBOX_REFUSED) == null) return;
    this.detachOwned(async () => {
      try {
        await this.sandboxRestore(await openSandbox(namespace, sandboxIdForWorkspace(this.name), { normalizeId: true }).restoreStatus());
      } catch (cause) {
        diagnostics.failure('sandbox.restore_recheck_failed', toKinuError({
          doing: "reading the sandbox's restore state", cause, otherwise: 'unavailable',
        }), { workspace: this.name });
      }
    });
  }

  /** Every open re-registers, so an object that hibernated or lost its row is told again. */
  private watchDeviceStatus(watching: boolean): void {
    if (this.getOwnerUserId() === null) return;
    this.detachOwned(async () => {
      try {
        const { stub, caller } = await this.userHub();
        await stub.watchDeviceStatus(caller, watching);

        if (!watching) return;
        const opened = this.rt.deviceTransport.status();

        if (!sameDeviceStatus(await this.rt.deviceTransport.refreshStatus(), opened)) {
          this.liveReadsMoved(['getExecutors', 'getToolDescriptions']);
        }
      } catch (cause) {
        diagnostics.failure('device.watch_failed', toKinuError({
          doing: watching ? 'asking to hear device changes' : 'leaving the device-change list', cause, otherwise: 'unavailable',
        }), { workspace: this.name });
      }
    });
  }

  async sandboxStopped(): Promise<void> {
    await this.sandboxRestore({ restoring: false, refused: undefined });
  }

  async sandboxRestore(status: RestoreStatus): Promise<void> {
    if (status.restoring) this.config.set(SANDBOX_STARTING, String(Date.now()));
    else this.config.delete(SANDBOX_STARTING);

    if (status.refused !== undefined) this.config.set(SANDBOX_REFUSED, status.refused);
    else this.config.delete(SANDBOX_REFUSED);

    this.liveReadsMoved(['getExposedPorts']);
  }

  /** Detached: the re-read calls back into a UserDO that may be mid socket handler. */
  async devicesMoved(): Promise<{ watching: boolean }> {
    if ([...this.getConnections()].length === 0) return { watching: false };
    this.detachOwned(async () => { await this.rt.deviceTransport.refreshStatus(); });

    return { watching: true };
  }

  private async runSleepTimeCompute(window: SleepTimeWindow): Promise<void> {
    try {
      // Key on the newest answer the window read, not the effect's scope: a later turn committed
      // before replay would otherwise sit unprocessed behind the tombstone.
      const key = window.newestId;

      if (key === null) return;
      // The update is persisted before applying so a replay after eviction reuses the same answer
      // instead of paying for another model call.
      const stored = this.recordedSleepTimeUpdate(key);

      const currentFacts = this.facts.all()
        .sort((a, b) => b.lastObservedAt - a.lastObservedAt)
        .map(f => ({ key: f.key, value: f.value, confidence: f.confidence }));

      const update = stored ?? await runSleepTimeCompute(this.rt.fastLlm ?? this.rt.llm, {
        turns: window.turns,
        currentFacts,
      });

      // Null means extraction/validation failed; a no-change answer is empty arrays, not null.
      if (update === null) {
        throw new KinuError('unavailable', 'the sleep-time compute returned no usable update');
      }

      if (stored === undefined) this.persistSleepTimeUpdate(key, update);

      // One transaction over the non-idempotent fact writes and their tombstone, so a replay never
      // repeats a prefix. The body must not await: `transactionSync` commits when it returns.
      const summary = this.ctx.storage.transactionSync(() => {
        const applied = applySleepTimeUpdate(this.facts, update);

        recordEffectDone(this.boundSql, this.actorHandle(), { scope: SLEEP_TIME_APPLIED, key: key });
        void this.sql`DELETE FROM sleep_time_updates WHERE effect_key = ${key}`;
        // Nothing is unprocessed, so no timed trigger is owed; a tab close earns one run only.
        this.config.delete(SLEEP_TIME_SETTLED_AT);
        this.config.delete(SLEEP_TIME_CLOSED_AT);

        return applied;
      });

      diagnostics.event('memory.facts_compressed', {
        upserted: summary.upserted,
        decayed: summary.decayed,
        skipped: summary.skipped,
      });
    } catch (err) {
      const failure = toKinuError({
        doing: 'compressing the recent turns into agent facts',
        cause: err,
        otherwise: 'unavailable',
      });

      diagnostics.failure('memory.fact_compression_failed', failure);
      // Rethrown so the terminal effect stays owed instead of recording `completed`.
      throw failure;
    }
  }

  /** The update a previous attempt already paid for, so a replay applies it without a new call. */
  private recordedSleepTimeUpdate(key: string): SleepTimeUpdate | undefined {
    const row = this.sql<{ update_json: string }>`
      SELECT update_json FROM sleep_time_updates WHERE effect_key = ${key}`[0];

    return row === undefined
      ? undefined
      : v.parse(SleepTimeUpdateSchema, JSON.parse(row.update_json));
  }

  private persistSleepTimeUpdate(key: string, update: SleepTimeUpdate): void {
    void this.sql`INSERT INTO sleep_time_updates (effect_key, update_json)
      VALUES (${key}, ${JSON.stringify(update)})
      ON CONFLICT(effect_key) DO NOTHING`;
  }

  /** Titling source for the root, and inherited by agents the owner adds. */
  protected ownMission(): string {
    return readMission(this.boundSql) ?? '';
  }

  /** UserDO is authoritative for the shown name; the manual-rename refusal lives in its
   * `name_origin`. */
  protected async persistAutoTitle(displayName: string): Promise<boolean> {
    return await this.propagateDisplayName(displayName, 'auto');
  }

  /** Per-activation cache of the UserDO-owned title; no local mirror, since other writers commit
   * to the root. Mutation paths hydrate before deciding. */
  protected _titleCache: { displayName: string; nameOrigin: NameOrigin } | null = null;
  /** A null row is an answer too; failures leave this false so the next read retries. */
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

  private titleState(): { displayName: string; nameOrigin: NameOrigin } {
    return this._titleCache ?? { displayName: this.name, nameOrigin: 'auto' as const };
  }

  /** Hydrates from the registry before the title policy decides, so a replayed auto-title does not
   * plan over the cold placeholder cache. */
  protected override async hydrateTitleInputs(): Promise<void> {
    // Throws, unlike `hydrateTitle`, so the title effect stays owed until the read works.
    const { stub, caller } = await this.userHub();
    this._titleCache = await stub.getWorkspaceTitle(caller, this.name);
    this._titleHydrated = true;
  }

  /** Without an owner or capability the registry is unreachable; the row stays owed rather than
   * reporting a title only the activation cache holds. */
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
   * Public because subagents, which hold only the slug, name the workspace in their prompts.
   * Hydrated only when cold: `propagateDisplayName` refreshes the cache on every registry write.
   */
  async workspaceTitle(): Promise<string | null> {
    if (!this._titleHydrated) await this.hydrateTitle();

    return this.titleInputs().displayName;
  }

  protected override async promptIdentity(): Promise<PromptIdentity> {
    return { workspace: await this.workspaceTitle() };
  }

  /**
   * Eval-only: aborts this activation as the platform would; schedule rows stand. Sealed in
   * `rpc-surface.ts`, eval-service identity only (`eval/abort-route.ts`). ARCHITECTURE-DECISIONS
   * C3.
   */
  evalAbortActivation(): void {
    this.ctx.abort('eval-service: the activation was aborted on request');
  }

  /** Commits to the root registry, then refreshes cache and clients. An auto-title is refused
   *  if the owner has claimed the naming, decided at the root in the same write. */
  private async propagateDisplayName(
    displayName: string,
    origin: NameOrigin,
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

  // Background jobs (#173): lifecycle lives in core BackgroundJobRunner; below is the @callable transport.

  async jobResult(jobId: string): Promise<BackgroundJob | null> {
    return jobResult(this.jobs, jobId);
  }

  @callable()
  async listBackgroundJobs(limit = 20, actor?: string): Promise<BackgroundJob[]> {
    return listBackgroundJobs(actor === undefined ? this.jobs : this.hostedChild(actor).child.stores.jobs, limit);
  }

  /** Wrapped at one boundary so the retry ratio is visible across all four sites.
   *  Job id omitted: high-cardinality. */
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

  /** Stops one swarm worker or branch head; its siblings and the search run on. Nothing when it is not running. */
  @callable()
  async stopSwarmWorker(headId: string): Promise<void> {
    await this.liveWorkers.stop(headId);
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

  @callable()
  async listWorkspaceAgents(): Promise<PanelAgent[]> {
    return readWorkspaceAgents({
      sql: this.boundSql, exec: this.ctx.storage.sql, root: this.actorHandle(), rootLabel: 'Main',
      actors: this.workspaceActors().list({ retired: true }),
    });
  }

  /** Roster includes retired actors: a dismissed subordinate's rows still show on the board. */
  @callable()
  async listWorkspaceWork(): Promise<WorkspaceWork> {
    return readWorkspaceWork(
      this.boundSql,
      this.actorHandle(),
      this.workspaceActors().list({ retired: true }),
    );
  }

  protected override onWorkCancelled({ abortedTools }: Omit<CancelWorkOutcome, 'ok'>): void {
    this.logActivity('work_cancelled', `${abortedTools} foreground aborted`);
  }

  // Lazy like `deferrals`: field initializers run before the constructor makes the schema.
  // "Always" is persisted on the UserDO hub, not here.
  private _consents: DeviceConsentRegistry | null = null;
  private get consents(): DeviceConsentRegistry {
    return this._consents ??= new DeviceConsentRegistry({
      store: new DeviceConsentStore(this.boundSql),
      newId: () => `cons-${nanoid(10)}`,
      // Wire shapes stay inline: the broadcast-wiring gate reads `broadcast({ type: … })` off source.
      announce: (notice) => {
        this.overviewChanged();

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
  }

  /** Called by the UserDO over DO RPC. Resolves on decision or `timeout`; `timeout` is not
   *  `deny`, since an unanswered prompt means the owner was away. */
  async awaitDeviceConsent(req: DeviceConsentRequest): Promise<DeviceConsentDecision> {
    return this.consents.request(req);
  }

  async announceDeviceUnavailable(
    devices: Array<{ id: string; label: string; lastSeenAt: number | null }>,
  ): Promise<{ ok: boolean }> {
    this.broadcast(JSON.stringify({ type: 'device_unavailable', devices }));

    return { ok: true };
  }

  async announceDeviceAvailable(device: { id: string; label: string }): Promise<{ ok: boolean }> {
    this.broadcast(JSON.stringify({ type: 'device_available', deviceId: device.id, label: device.label }));

    return { ok: true };
  }

  @callable()
  async resolveDeviceConsent(consentId: string, decision: DeviceConsentAnswer): Promise<{ ok: boolean }> {
    return { ok: this.consents.resolve(consentId, decision) };
  }

  /** Lets the chat re-render cards after a reload. */
  @callable()
  async listPendingConsents(): Promise<PendingDeviceConsent[]> {
    return this.consents.list();
  }

  // Deferred approval (core safety/deferred-approval.ts): only a parked write runs on approval.
  protected _deferrals: DeferredApprovalQueue | null = null;
  protected get deferrals(): DeferredApprovalQueue {
    this._deferrals ??= new DeferredApprovalQueue({
      store: new DeferredApprovalStore(this.boundSql, this.actorHandle()),
      // Read through `this.orch` at delivery time, never captured: this getter is reachable
      // from the runtime's own construction path.
      inbox: { send: (signal) => this.orch.inbox.send(signal) },
      // Same actor_config as the approval mode, read live by the gate on the next command.
      remember: (grants) => { this.config.grantShellApproval(grants); },
      // A spent grant's row is deleted, so this event is the only durable record of consumption.
      // Outside any turn it falls back to the workspace run.
      audit: (record) => {
        this.eventRecorder.emit(this._currentRunId || WORKSPACE_RUN_ID, {
          type: 'approval_consumed', ...record,
        });
      },
      announce: (notice) => this.announceDeferral(notice),
      writes: {
        content: new ParkedWriteFiles(async () => (await this.hostedWorkspace().bundle.session()).vfs.as(CRED_KERNEL)),
        perform: (write, bytes) => performBoundWrite(this.rt.storage.vfs, write, bytes),
      },
    });

    return this._deferrals;
  }

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

    this.overviewChanged();
  }

  /** Read by the needs-you queue; also callable alone so a surface can render just this. */
  @callable()
  async listDeferredApprovals(): Promise<DeferredApproval[]> {
    return this.deferrals.list();
  }

  /** A parked write's bytes against the file now, so the owner sees what an approval writes. */
  @callable()
  async reviewParkedWrite(id: string): Promise<ParkedWriteReview | null> {
    return reviewParkedWrite(this.deferrals, this.rt.storage.vfs, id);
  }

  /** Decides one or many parked actions: one durable write per row, one wake for the batch. */
  @callable()
  async decideDeferredApprovals(
    ids: string[], decision: DeferredApprovalAnswer,
  ): Promise<{ decided: string[] }> {
    return decideDeferredApprovals(this.deferrals, ids, decision);
  }


  // Device connection is user-level: UserDO owns the tunnel socket and tokens; nothing
  // per-agent verifies, attaches, issues or lists a device token.

  /** DDL only; no persisted schema version. */
  private initTables(): void {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);

    initWorkspaceSchema({
      execRaw, sql: this.boundSql, exec: this.ctx.storage.sql, transactionSync: (write) => this.ctx.storage.transactionSync(write),
    });
    initChangeNotesTable(execRaw);
    initSlatePictureTable(execRaw);
    initBrowserSessionTable(execRaw);
    initWorkspaceActorTable(execRaw);

    // Planes only this root carries (declared in core/conformance/manifest.ts).
    initWebhookIngressTables(this.ctx.storage.sql);
    initSubordinateRosterTable(this.ctx.storage.sql);

    // Keyed (actor_id, message_id): message ids are minted per actor, so a bare message_id
    // key would let two actors' thumbs silently overwrite each other.
    execRaw(`CREATE TABLE IF NOT EXISTS turn_feedback (
      actor_id   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      feedback   TEXT NOT NULL CHECK (feedback IN ('positive','negative')),
      PRIMARY KEY (actor_id, message_id)
    )`);
    // Persisting the paid-for answer between model call and fact mutation makes a replay
    // apply the same update instead of buying another.
    execRaw(`CREATE TABLE IF NOT EXISTS sleep_time_updates (
      effect_key  TEXT PRIMARY KEY,
      update_json TEXT NOT NULL
    )`);
    // Same per-actor key as turn_feedback: the thumbs re-score reads this table.
    execRaw(`CREATE TABLE IF NOT EXISTS turn_craft_usage (
      actor_id   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      tool_names TEXT NOT NULL,
      PRIMARY KEY (actor_id, message_id)
    )`);
    // Owned by this root: the container is the workspace's; subordinates ride their parent's.
    initSandboxLifecycleTable(execRaw);
  }

  /** Written by the first claim or a fork, never by a start. */
  private workspaceBorn(): boolean {
    return this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`.length > 0;
  }

  /** The first claim or fork. */
  protected bearWorkspace(identityName: string, ownerUserId: string): void {
    this.ctx.storage.transactionSync(() => {
      void this.sql`INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
        VALUES (${this.ctx.id.toString()}, ${identityName}, ${ownerUserId}, ${Date.now()})`;
      this.workspaceActors().createMain({ name: this.name });
    });
    this.registerCompactionExtension();
  }

  /** Synchronous by contract: runs inside blockConcurrencyWhile, which gates every request and
   *  resets the object at 30s (`do.block_concurrency.cancel_ms`); `scripts/do-init-gate.ts` enforces. */
  async onStart(): Promise<void> {
    diagnostics.event('actor.startup', { workspace: this.name });

    // An unborn workspace owes nothing: its first claim writes it.
    if (this.storageRefusal !== undefined || this.nimbusSibling || !this.workspaceBorn()) return;
    this.rependDeadActivationLeases();
    // Row-budgeted (init gate); a truncated pass drains under the wake below.
    this.maintenanceUnfinished = this.maintenanceSweeps(true);
    // An activation is the only moment a workspace whose wake was lost can notice; the arm is detached.
    this.armDurableWake();

    // The activation only classifies and arms a wake; all dispatch runs under that durable wake,
    // because an activation launches no external work, awaited or detached.
    if (this.owedWorkExists()) {
      this.armOwedWorkWake('reconcile');
    }

    // Stale `running` fork heads are recovered under the terminal wake (`maintenanceWork`), not here:
    // recovery can queue a turn, and awaiting that inside the init gate can reset the object.

    // Boot awaits only this object's SQLite and session composition. A failure fails the start, so the object
    // stays unstarted and every request fails with the cause until one boots; owed work keeps its wake.
    await this.hostedWorkspace().bundle.session();
  }

  /**
   * Recovery cutoff: heads, swarm rows and runs created at or after this belong to this activation.
   * Strict `<` on purpose: a same-millisecond tie reads as live rather than killing live work.
   */
  private readonly activationStartedAt = Date.now();

  /**
   * Whether the workspace container is in use, asked by its box before it may rest: a live turn of
   * any actor here, or a job this activation's runner drives, re-drives included. Work the root owes
   * itself (sends, claims, fibers to re-drive) is its own wake's business; a process an earlier
   * activation left running is the box's own check.
   */
  override async sandboxInUse(): Promise<boolean> {
    if (this._inFlight || this.jobRunner.inFlight > 0) return true;
    const host = this.actorHost();

    return host.list().some((reference) => host.hosted(reference)?.session.inFlight === true);
  }

  /**
   * In-memory on purpose: fork-journal recovery runs once per isolate; a second pass could retire
   * a root the resume gate already claimed and re-drove in this activation.
   */
  private activationRecoveryPending = true;

  /** Carry a fork-recovery notice durably until delivered; the idempotency key collides duplicates. */
  private dispatchForkNotice(signal: AgentSignal): void {
    const notice: RecoveredNotice = {
      kind: signal.kind, text: signal.text,
    };

    if (signal.idempotencyKey !== undefined) notice.idempotencyKey = signal.idempotencyKey;

    if (signal.metadata !== undefined) notice.metadata = signal.metadata;
    dispatchRecoveredNotice(
      {
        redrive: (lane, checkpoint, body) => { this.redriveRecoveredLane(lane, checkpoint, body); },
        deliverSignal: (recovered) => this.orch.inbox.send(recovered),
      },
      notice,
    );
  }

  /** Reconcile the fork journal a dead activation left running, then reclaim settled facets.
   *  Runs once per activation by the guard below. */

  protected override async maintenanceWork(): Promise<boolean> {
    // Resume the root's own loop before anything else the wake finishes on its behalf.
    this.resumeChatLoop();

    for (const pending of this.workspaceActors().retirements()) {
      await this.runActorDirectory(pending.caller, pending.parentPath, { action: 'retire', name: pending.name, reference: pending.reference });
    }

    // The alarm owns recovery authority. Core retains verified claims as owed,
    // settles unverified ones indeterminate, and leaves live actors untouched.
    let owedClaims: readonly string[] = [];
    let stalled: readonly ResumableActorTurn[] = [];

    try {
      const host = this.actorHost();
      const rootActorId = this.actorHandle().actorId;
      const rootIsLive = () => this._inFlight || this.actorSession.turnOpen;

      const recovered = await recoverActorTurns({
        installedBuild: host.installedBuild,
        workspace: this.workspaceName(),
        resumable: (limit) => host.resumable(limit),
        acquire: async (reference) => {
          const actor = await host.acquire(reference);
          const root = reference.actorId === rootActorId;

          return {
            runtime: actor.runtime,
            // The root recovers through the stores its session, resumed above, admits and settles through:
            // its tabs are told about every claim written there.
            stores: root ? this.stores : actor.stores,
            session: {
              get turnOpen() {
                return root ? rootIsLive() : actor.session.turnOpen;
              },
            },
          };
        },
      });

      owedClaims = recovered.verified;
      stalled = recovered.stalled;
    } catch (cause) {
      diagnostics.failure('actor.turn_recovery_failed', toKinuError({
        doing: 'rebuilding the hosted turns an eviction interrupted', cause, otherwise: 'io',
      }), { workspace: this.name });
    }

    this.rependRecoveredAssignments(owedClaims);
    await this.retireStalledAssignments(stalled);
    // Retained claims still fence new work; verification alone is not execution.
    this.startDelegationDrain();

    if (!this.activationRecoveryPending) return await super.maintenanceWork();

    // Wait for the branch seal to drain: the fork reconcile would retire a pre-cutoff running
    // steer branch head as lost fork work.
    if (this.headJournal.listRunningBranchHeads(
      STEER_BRANCH_RUN_ID_PREFIX, 1, this.activationStartedAt,
    ).length > 0) return true;
    this.activationRecoveryPending = false;

    try {
      await reconcileInterruptedForks({
        now: this.activationStartedAt,
        journal: this.headJournal,
        // The notice's queueing promise belongs outside this alarm frame.
        inbox: {
          // The fiber row written synchronously is the acceptance boundary; replays after eviction
          // collide on the signal's idempotency key.
          send: (signal) => {
            this.dispatchForkNotice(signal);

            return Promise.resolve('queued');
          },
        },
        search: this.mctsSearchStore,
        runEvents: this.eventRecorder,
        // Runs the resumed loop re-opened are live and must not be sealed as wreckage.
        liveRuns: () => this.chatLoop.drivenRuns(),
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

    return await super.maintenanceWork();
  }
  /**
   * Retire exploration actors a reset left behind, against ledgers fork reconciliation settled (S13).
   * Must run after `reconcileInterruptedForks` so an `interrupted` head reads as resumable, not terminal.
   */
  protected async reclaimSettledExplorationActors(): Promise<void> {
    try {
      const { retired } = await reclaimSettledExplorationActors(this.hostedSeams(), {
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
   * The lifecycle ledgers are the only status authority. `completed`, `aborted`, `errored`,
   * `budget_exceeded` are terminal; `running`, `interrupted` resumable; anything else is unknown.
   */
  protected explorationFacetLedgerStatus(id: string): 'resumable' | 'terminal' | 'unknown' {
    const head = this.headJournal.readHead(id);

    if (!head) return 'unknown';

    if (headStatusUnsettled(head.status)) return 'resumable';

    return storedHeadReportStatus(head.status) === null ? 'unknown' : 'terminal';
  }

  private hasLiveExploration(): boolean {
    return this.headJournal.hasUnfinishedHeads() || this.mctsSearchStore.hasRunningSwarms();
  }

  // Kinu's timer, the `kinu-timer` Lifecycle job (wake-jobs.ts); not an `alarm()` override because
  // Lifecycle owns the DO's single alarm slot.
  // Every source `nextWakeAt` folds must have a phase here. Dedupe on
  // `(trigger_id, scheduled_fire_at)` makes a re-fire after eviction a no-op publish.
  // A wake is a separate invocation from whatever armed it; `tracing.invocation` revokes the handle
  // when this promise settles, so spans cannot cover both.
  /** A hosted hirer's answers reach its own session; a retired hirer's went with it. */
  protected override async deliverAdviceFor(actorId: string): Promise<boolean> {
    if (actorId === this.actorHandle().actorId) return super.deliverAdviceFor(actorId);
    const record = this.actorHost().describe(actorId);

    if (record === null || record.retiringAt !== null || record.deletedAt !== null) return true;

    return (await this.actorHost().acquire(actorReferenceOf(record))).session.deliverAdvisorAnswers();
  }

  async _kinuTimerTick(): Promise<void> {
    const now = Date.now();
    await this.tracing.invocation('alarm', 'tick', async (tick) => {
      await tick.span('alarm.due_triggers', async (span) => {
        try {
          const { fired } = await fireDueTriggers({ registry: this.triggerRegistry, log: this.eventLog }, now);
          span.setAttribute('kinu.triggers_fired', fired);
        } catch (err) {
          const failure = toKinuError({
            doing: 'firing the triggers due on this wake',
            cause: err,
            otherwise: 'io',
          });

          // `fail`, not rethrow: the tick continues to the next phase, so the span must be marked failed.
          span.fail(failure);
          diagnostics.failure('schedule.due_triggers_failed', failure);
        }
      });

      // `nextWakeAt` folds `nextPendingDrainAt`, so pending events owe a drain here (D6). The condition
      // uses the same reader and clock as the re-arm so the two cannot disagree about whether it was due.
      await tick.span('alarm.event_drain', (span) => settle(Effect.gen({ self: this }, function* () {
        const dueAt = this.eventLog.nextPendingDrainAt(now);
        span.setAttribute('kinu.drain_due', dueAt !== null && dueAt <= now);
        yield* this.drainHostedReactions(now);

        if (dueAt === null || dueAt > now) return;

        // Rethrow so a selection failure fails this span; the re-arm below retries, since the fold still
        // answers due.
        yield* attempt({ doing: 'draining the reactions this wake was armed for', otherwise: 'io' },
          () => this.orch.drainPendingEvents({ rethrow: true })).pipe(Effect.catch((failure) => Effect.sync(() => {
          span.fail(failure);
          diagnostics.failure('event.wake_drain_failed', failure);
        })));
      })));

      await tick.span('alarm.evolution_answer', async (span) => {
        let failed = false;

        const step = await evolutionAnswerWake(this.refinementDeps, now, (failure) => {
          failed = true;
          span.fail(failure);
          diagnostics.failure('refinement.answer_wake_failed', failure);
        });

        if (!failed) span.setAttribute('kinu.evolution_answer_due', step !== null);
      });

      // Durable re-drive of pending outbound peer messages (eviction recovery and backoff retries).
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

      // Re-drive `pending` outbound email; the stored Message-ID makes re-send idempotent (SPEC §7.4).
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

      // Sibling phase because `nextWakeAt` folds the warm row. The lane re-checks the request counter,
      // so a turn started after the arm suppresses the refresh.
      await tick.span('alarm.cache_warm', async (span) => {
        try {
          const warmed = await this.cacheWarming.runDue(now);
          span.setAttribute('kinu.cache_warmed', warmed !== null);
        } catch (err) {
          const failure = toKinuError({
            doing: 'refreshing the prompt-cache prefix this wake was armed for',
            cause: err,
            otherwise: 'unavailable',
          });

          span.fail(failure);
          diagnostics.failure('cache.warm_failed', failure);
        }
      });

      // A failed sleep-time run is not retried by this chain; the settled instant is released first so
      // it cannot answer due on every re-arm. The next completed turn re-arms.
      await tick.span('alarm.sleep_time', async (span) => {
        try {
          const ran = await this.runSleepTimeIfDue(now);
          span.setAttribute('kinu.sleep_time_ran', ran);
        } catch (err) {
          this.config.delete(SLEEP_TIME_SETTLED_AT);

          const failure = toKinuError({
            doing: 'running the sleep-time compute this wake was armed for',
            cause: err,
            otherwise: 'unavailable',
          });

          span.fail(failure);
          diagnostics.failure('memory.sleep_time_wake_failed', failure);
        }
      });

      // Soonest-wins arm, so it never clobbers a sooner wake armed during dispatch. Awaited: this link
      // keeps the timer chain alive.
      await tick.span('alarm.timer_rearm', async (span) => {
        try {
          const next = this.nextWakeAt(now);
          span.setAttribute('kinu.rearmed', next !== null);

          if (next !== null) await this.wakes.arm(KINU_TIMER_JOB, next);
        } catch (err) {
          const failure = toKinuError({
            doing: 're-arming the wake that keeps the timer chain alive',
            cause: err,
            otherwise: 'io',
          });

          span.fail(failure);
          diagnostics.failure('schedule.timer_rearm_failed', failure);
          // Rethrown: this failure loses the next wake. An uncaught alarm throw makes the runtime redeliver
          // it (tests/workerd/do-alarm.test.ts), and the redelivered tick re-arms from durable state.
          throw failure;
        }
      });

      await tick.span('alarm.slate_pictures', async (span) => {
        const capture = this.pictureCapture();

        if (capture === null) return;

        try {
          const changed = await this.pictures.captureDue(capture, now);
          span.setAttribute('kinu.pictures_changed', changed);

          if (changed) this.overviewChanged();
        } catch (err) {
          const failure = toKinuError({ doing: 'photographing the slates due a picture', cause: err, otherwise: 'unavailable' });

          span.fail(failure);
          diagnostics.failure('slate.pictures_failed', failure);
        }
      });
    });
  }

  async getAgentStatus() {
    const profile = this.resolvedTurnProfile();

    const status = await getAgentStatus({
      sql: this.boundSql,
      actor: this.rt.actor,
      model: this.effectiveModelSpec(),
      reasoningEffort: profile?.tier.reasoningEffort ?? this.config.getReasoningEffort(),
      name: this.name,
      displayName: await this.workspaceTitle() ?? '',
    });

    return {
      ...status,
      roleId: profile?.role.id ?? this.activeRoleLabel(),
      tierId: profile?.tier.id ?? 'default',
      context: this.contextFill(),
    };
  }

  private contextFill(): ContextFill | null {
    return contextFill(this.eventRecorder.readContextMeasures(), this.modelCatalog.contextWindow() || null);
  }

  async getToolList() {
    return getToolList(this.boundSql, this.rt.craftStore);
  }

  /** Latest search's tree only; settled earlier searches in search_nodes must not shadow it. */
  @callable() async getMctsTree() {
    return readLatestSearchTree(this.boundSql, this.actorHandle());
  }

  /** One named search's tree; `getMctsTree` would answer with the latest search's branches instead. */
  @callable() async getSearchTree(rootId: string) {
    return readSearchTree(this.boundSql, this.actorHandle(), rootId);
  }

  /** A page of every exploration run in this workspace, newest first. */
  @callable() async listForkRuns(request?: PageRequest): Promise<Page<ForkRunSummary>> {
    return listForkRuns(this.boundSql, this.actorHandle(), request?.cursor ?? null, request?.limit);
  }

  /**
   * One named run for a permalink, independent of the recent-list window.
   * Returns the composed canvas row so the drill-down can read the run's own parameters.
   */
  @callable() async getForkRun(rootId: string): Promise<ExplorationCanvasRun | null> {
    return readExplorationRun(this.boundSql, this.actorHandle(), rootId);
  }

  /** A page of the Exploration canvas: each fork with its dispatch parameters and tree, newest first. */
  @callable() async getExplorationCanvas(request?: PageRequest): Promise<Page<ExplorationCanvasRun>> {
    return readExplorationCanvas(this.boundSql, this.actorHandle(), request?.cursor ?? null, request?.limit);
  }

  /**
   * A page of every comparable set in the records store, most recently written first.
   * Supplies the `ObjectiveIdentity` handle the cell reads take back opaquely.
   */
  @callable() async listRecordObjectives(request?: PageRequest): Promise<Page<RecordObjectiveSummary>> {
    return listRecordObjectives(this.boundSql, this.actorHandle(), request?.cursor ?? null, request?.limit);
  }

  /** `floorDigest` is required and nullable: null means the objective declared no floor. */
  @callable() async listRecordCells(
    request: RecordObjectiveHandle & PageRequest,
  ): Promise<Page<RecordCellSummary>> {
    return listRecordCells(this.boundSql, this.actorHandle(), request, { cursor: request.cursor ?? null, limit: request.limit });
  }

  /** One cell's population, best first, paged because it is unbounded
   *  (`ArchiveAdmission.lean — separated_cells_are_unboundedly_large`); `descriptor: null` is the
   *  no-partition cell. */
  @callable() async readRecordCell(
    request: RecordCellHandle & PageRequest,
  ): Promise<Page<ExplorationRecord>> {
    return readRecordCell(this.boundSql, this.actorHandle(), request, { cursor: request.cursor ?? null, limit: request.limit });
  }

  /** Host-owned: SLATE_READ_MODELS excludes this queue so a preview cannot counterfeit approvals. */
  @callable() async listPendingActions(): Promise<PendingAction[]> {
    return this.pendingActions();
  }

  private pendingActions(): PendingAction[] {
    // The queue row needs the unseen count, newest time, and how many entries offer keep/revert.
    const unseen = getUnseenChangelog(this.boundSql, this.rt.actor);

    return buildPendingActions({
      scaffoldVersions: listScaffoldVersions(this.boundSql, this.rt.actor, 20),
      deferredActions: this.deferrals.list(),
      unseenChanges: {
        count: unseen.length,
        revertable: unseen.filter((entry) => entry.revert !== undefined).length,
        latestAt: unseen[0]?.at ?? Date.now(),
      },
      curriculum: listProposedTasks(this.rt, 'pending'),
      pendingPlans: listPendingPlanReviews(this.boundSql),
    });
  }

  /** Run-level swarm search ledger, newest-updated first; identifies the latest search without node ordering. */
  @callable() async getMctsSearchRuns(limit = 20): Promise<MctsSearchRunSummary[]> {
    return this.mctsSearchStore.list(limit);
  }

  /** The CLI serves the same projection over bun:sqlite (core read-models/search-tree.ts). */
  @callable() async getMctsNodeDetail(nodeId: string): Promise<SearchNodeDetail | null> {
    return readSearchNodeDetail(this.boundSql, this.actorHandle(), nodeId);
  }

  /** Assembled on demand from the durable ledgers; no second event system. */
  @callable()
  async getEvolutionChangelog(opts?: { limit?: number; changesOnly?: boolean }): Promise<{
    entries: ChangelogEntry[]; unseenCount: number; seenAt: number;
  }> {
    return getEvolutionChangelog(this.boundSql, this.actorHandle(), opts?.limit, opts?.changesOnly === true);
  }

  @callable()
  async markChangelogSeen() {
    const seen = markChangelogSeen(this.config);
    this.liveReadsMoved(['getEvolutionChangelog', 'listPendingActions', 'getWorkspaceTabPresence']);

    return seen;
  }

  /** Id-addressed against a fresh digest so a shifted list cannot revert the wrong row. */
  @callable()
  async revertChangelogEntry(id: string): Promise<ChangelogRevertResult> {
    const result = await revertChangelogEntryById({ rt: this.rt, facts: this.facts, events: this.eventRecorder }, id);

    if (result.ok) {
      // Crafted-tool retirement must drop the cached tool surface.
      this._cachedTools = null;
      this._cachedToolsKey = '';
    }

    return result;
  }

  /** Claimed take sets keyed by their turn's assistant message id. */
  @callable()
  async listAlternateTakes(): Promise<Record<string, AlternateTakeSet>> {
    const byTurn: Record<string, AlternateTakeSet> = {};

    // Newest-first listing: keep the first (latest) set seen per turn.
    for (const set of listAlternateTakeSets(this.boundSql, this.actorHandle(), { limit: 100 })) {
      if (set.turnId && !byTurn[set.turnId]) byTurn[set.turnId] = set;
    }

    return byTurn;
  }

  @callable()
  async latestAlternateTakes(): Promise<AlternateTakeSet | null> {
    return latestAlternateTakeSet(this.boundSql, this.actorHandle());
  }

  /**
   * Runs a mid-turn redirect as one budgeted head in parallel; the live turn is never interrupted.
   * The pair settles into Alternate Takes on this turn; progress streams as 'branch_status'.
   */
  @callable()
  async branchTurn(text: string): Promise<{ accepted: boolean; branchId?: string; reason?: string }> {
    const task = text.trim();

    if (!task) throw new KinuError('bad_input', 'branchTurn requires the redirect text');

    if (!this._inFlight) {
      return { accepted: false, reason: 'No turn is running: send it as a normal message instead.' };
    }

    if (this.turnWorkMode() === 'plan') {
      return { accepted: false, reason: 'Plan turns cannot start mutating branches. Review or finish the plan first.' };
    }

    const runtime = this.getCFHeadRuntime();

    if (!runtime) {
      return { accepted: false, reason: 'Branching needs an agent owner (heads require UserDO access).' };
    }

    const id = newBranchId();
    // Read before the await: the branch charges the turn the owner redirected, not whichever runs next.
    const missionLabels = this.budget.scope;
    const inheritedContext = await this.readInheritedContext();
    this._pendingBranches.push({
      id, task,
      handle: startBranchHead(runtime, this.headJournal, {
        id, task, inheritedContext, missionLabels,
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


  /** A pick differing from the answered take queues a programmatic continuation via BackendHost. */
  @callable()
  async pickAlternateTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    const outcome = await pickAlternateTake(
      { sql: this.boundSql, actor: this.rt.actor, history: this.stores.history, engine: this.engine, inbox: this.orch.inbox },
      takeId, nodeId);

    this.logActivity('take_pick', `${outcome.outcome} (${nodeId})`);

    return outcome;
  }

  /**
   * Server-side merge of run_events, evolution_events, and swarm search nodes into ordered TimelineSpans.
   * Defaults to the active run, else the most recent recorded run.
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

  /**
   * Runs the current (or pending, with `useShadowOverride`) scaffold one-shot; nothing is injected
   * into chat. Wire form only: the MCP Worker adapter decodes the JSON result at the call site.
   */
  async runScaffoldOnce(task: string, opts?: { useShadowOverride?: boolean }): Promise<ScaffoldRunReport> {
    return scaffoldRunReport(await runScaffoldOnce(this.scaffoldControl, task, opts));
  }

  async getShadowStatus(): Promise<ShadowStatus> {
    return getShadowStatus(this.boundSql, this.rt.actor);
  }

  /** `auto` acts on decidePromotion only when its decision != 'continue'; others force the action. */
  @callable()
  async applyScaffoldDecision(mode: 'auto' | 'promote' | 'rollback'): Promise<ScaffoldDecisionResult> {
    return applyScaffoldDecision(this.scaffoldControl, mode);
  }

  /** Reads `scaffold_evaluations`, regressions first. */
  @callable()
  async getShadowVerdict(version?: number): Promise<ShadowVerdict> {
    const pendingVersion = version ?? getPendingScaffold(this.boundSql, this.rt.actor)?.version ?? null;

    return readShadowVerdict(this.boundSql, this.rt.actor, pendingVersion);
  }

  /**
   * `previousVersion` is the highest existing version below `version` (numbering may have gaps
   * after rollbacks). No-predecessor diffs render as all-additions.
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

  /** Runs a scaffold version (source from VFS `agent.js.vN`) so it can be previewed before promotion. */
  @callable()
  async previewScaffoldLive(
    version: number,
    task: string,
  ): Promise<ScaffoldRunResult> {
    return previewScaffoldLive(this.scaffoldControl, version, task);
  }

  /**
   * Stored in actor_config; effective on the next turn. strict (default) rejects gate commands;
   * allow_all treats gate as warn (trusted dev only); deny_all rejects gate and warn.
   */
  @callable()
  async setShellApprovalMode(mode: 'strict' | 'allow_all' | 'deny_all') {
    return setShellApprovalMode({
      config: this.config,
      onChanged: () => { this._cachedTools = null; this._cachedToolsKey = ''; },
    }, mode);
  }

  @callable()
  async getShellApprovalMode(): Promise<{ mode: ShellApprovalMode }> {
    return getShellApprovalMode(this.config);
  }

  @callable()
  async getShellApprovalGrants(): Promise<{ grants: ApprovalGrant[] }> {
    return getShellApprovalGrants(this.config);
  }

  /** The gate reads grants live, so revocation needs no toolset rebuild or restart. */
  @callable()
  async revokeShellApprovalGrants(grants: ApprovalGrant[]): Promise<{ grants: ApprovalGrant[] }> {
    return revokeShellApprovalGrants(this.config, grants);
  }

  /** Empty array clears the pin. */
  @callable()
  async setAlwaysActiveSkills(names: string[]) {
    return setAlwaysActiveSkills(this.config, names);
  }

  @callable()
  async getAlwaysActiveSkills(): Promise<{ names: string[] }> {
    return getAlwaysActiveSkills(this.config);
  }

  // Checkpoints live on the user's machine; restore crosses its consent gate.

  private get deviceCheckpoints(): FileCheckpointReads {
    return this._deviceCheckpoints ??= deviceFileCheckpoints({
      hub: () => this.userHub(), hasOwner: () => this.getOwnerUserDO() !== null, workspace: this.name,
    });
  }

  private _deviceCheckpoints: FileCheckpointReads | null = null;

  async checkpointStatus(): Promise<CheckpointAvailability> {
    return checkpointAvailability(this.deviceCheckpoints);
  }

  @callable()
  async listFileCheckpoints(limit?: number, turnId?: string): Promise<FileCheckpointListing> {
    return fileCheckpointListing(this.deviceCheckpoints, { limit, turnId });
  }

  @callable()
  async planFileRestore(dir: string, id: string): Promise<FileRestorePlan> {
    return fileRestorePlan(this.deviceCheckpoints, dir, id);
  }

  @callable()
  async restoreFileCheckpoint(dir: string, id: string): Promise<FileRestoreResult> {
    return fileCheckpointRestore(this.deviceCheckpoints, dir, id);
  }

  /**
   * `feedback: null` clears. Applies an EMA observation (feedbackToQuality) to the crafted tools
   * recorded for this message in turn_craft_usage.
   */
  @callable()
  async setTurnFeedback(
    messageId: string,
    feedback: 'positive' | 'negative' | null,
  ): Promise<{ ok: true; messageId: string; feedback: 'positive' | 'negative' | null; rescored: number }> {
    if (messageId.length === 0) {
      throw new KinuError('bad_input', 'messageId must be a non-empty string');
    }

    if (feedback === null) {
      void this.sql`DELETE FROM turn_feedback
        WHERE actor_id = ${this.actorHandle().actorId} AND message_id = ${messageId}`;

      return { ok: true, messageId, feedback: null, rescored: 0 };
    }

    if (feedback !== 'positive' && feedback !== 'negative') {
      throw new KinuError('bad_input', `feedback must be 'positive', 'negative', or null; got ${JSON.stringify(feedback)}`);
    }

    void this.sql`INSERT INTO turn_feedback (actor_id, message_id, feedback)
             VALUES (${this.actorHandle().actorId}, ${messageId}, ${feedback})
             ON CONFLICT(actor_id, message_id) DO UPDATE SET feedback = excluded.feedback`;

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
        this._cachedTools = null;
        this._cachedToolsKey = '';
      }
    }

    // The explicit verdict overrides any classifier row for this turn and, when negative,
    // corroborates provisional lessons.
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

  /** Scoped to this actor: message ids are unique only within an actor. */
  @callable()
  async listTurnFeedback(): Promise<Record<string, 'positive' | 'negative'>> {
    const rows = this.sql<{ message_id: string; feedback: 'positive' | 'negative' }>`
      SELECT message_id, feedback FROM turn_feedback
      WHERE actor_id = ${this.actorHandle().actorId}`;

    return Object.fromEntries(rows.map((r) => [r.message_id, r.feedback]));
  }

  /** Scaffold variant archive (read-only); also backs the agent.scaffoldVersions codemode helper.
   *  Keys stay snake_case: ScaffoldLineage.tsx reads the wire shape (written_at). */
  @callable()
  async listScaffoldVersions(limit = 20): Promise<ScaffoldVersionView[]> {
    return listScaffoldVersions(this.boundSql, this.rt.actor, limit);
  }

  /** GEPA optimisation pass; see `runScaffoldGepaOptimization` in evolution/control.ts for cost. */
  @callable()
  async runScaffoldGepaOptimization(opts?: {
    maxIterations?: number;
    evalSize?: number;
    maxMetricCalls?: number;
  }): Promise<GepaOptimizationResult> {
    return runScaffoldGepaOptimization(this.scaffoldControl, opts);
  }

  @callable()
  async getGepaRuns(limit = 20): Promise<GepaRunSummary[]> {
    return listGepaRuns(this.boundSql, this.actorHandle(), limit);
  }

  /** The persisted loss curve (replay_evals), newest first. */
  @callable()
  async getReplayEvals(limit = 50): Promise<ReplayEvalSummary[]> {
    return listReplayEvals(this.boundSql, this.actorHandle(), limit);
  }

  /** K_align: correction rate per 100 graded turns, per scaffold version, with 95% Wilson
   *  intervals, from telemetry alone. */
  @callable()
  async getAlignmentConvergence(): Promise<AlignmentConvergence> {
    return alignmentConvergence(this.boundSql, this.actorHandle());
  }

  /** Classifier calibration from hand labels; reads "uncalibrated" until labels exist. */
  @callable()
  async getOutcomeCalibration(): Promise<CalibrationReport> {
    return calibrationReport(this.boundSql, this.actorHandle());
  }

  /** Draw the next calibration set: turns for a human to judge blind. */
  @callable()
  async sampleOutcomeLabeling(size: number = DEFAULT_LABEL_BUDGET): Promise<LabelingItem[]> {
    return sampleForLabeling(this.boundSql, this.actorHandle(), { size });
  }

  /** Append-only; ids the ledger no longer knows are reported back rather than dropping the pass. */
  @callable()
  async recordOutcomeLabeling(
    labeler: string,
    labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>,
  ): Promise<LabelIngestResult> {
    return ingestOutcomeLabels(this.boundSql, this.actorHandle(), { labeler, labels });
  }

  /** How the LLM panel scored against the owner's labels, and whether it cleared the
   *  pre-registered bar to stand in for them. */
  @callable()
  async getOutcomeEnsemble(): Promise<EnsembleReport> {
    return ensembleReport(this.boundSql, this.actorHandle());
  }

  /**
   * Judges must come from vendor families other than the routed turn model (not the stored spec);
   * the one declared exception to `MODEL_ROUTE_POLICY`, see core/src/profiles/model-route.ts.
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
          // Cross-vendor judge spend: the actor's catalog rate cannot price it and step telemetry
          // never saw it.
          spend: {
            source: 'judge', report: (report) => this.reportModelCall(report),
            operations: this.modelOperations,
          },
        }),
      }),
    });
  }

  /** One GEPA run with candidates and Pareto-front membership; Maps flattened to objects for RPC. */
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

      // The membership table is core's; no raw SELECT across the package boundary.
      const pareto = loadGepaParetoFront(this.boundSql, this.actorHandle(), runId);

      return { run, candidates, pareto };
    } catch (error) {
      if (classify({ cause: error }) !== 'sqlite-missing-table') throw error;

      return { run: null, candidates: [], pareto: [] };
    }
  }

  /** The store the change-set reads, as the session user whose plane the root actor's is. */
  private async baselines(): Promise<WorkspaceBaselines> {
    return { store: (await this.hostedWorkspace().bundle.session()).vfs, cred: CRED_SESSION_USER };
  }

  /** Cumulative workspace change-set since the baseline (reset via resetWorkspaceBaseline).
   *  A read never changes the review boundary. */
  async getWorkspaceDiff(): Promise<WorkspaceDiffResult> {
    return this.changes.read(async () => getWorkspaceDiff(this.rt, await this.baselines()));
  }

  /** The workspace's snapshot baseline; a real `git diff` of /workspace for shell executors. */
  @callable()
  async getExecutorDiff(executorId: string): Promise<ExecutorDiffResult> {
    return getExecutorDiff(this.rt, executorId, () => this.getWorkspaceDiff());
  }

  @callable()
  async resetWorkspaceBaseline(): Promise<WorkspaceReviewResult> {
    try {
      return await resetWorkspaceBaseline(this.rt, await this.baselines());
    } finally {
      this.changes.moved();
    }
  }

  @callable()
  async restoreWorkspaceBaseline(): Promise<{ ok: true; capturedAt: number } | { ok: false; error: string }> {
    try {
      return await restoreWorkspaceBaseline(this.rt, await this.baselines());
    } finally {
      this.changes.moved();
    }
  }

  @callable()
  async getChangeNotes(source: string): Promise<ReviewAnnotation[]> {
    return readChangeNotes(this.rt, source);
  }

  @callable()
  async saveChangeNotes(source: string, notes: ReviewAnnotation[]): Promise<ChangeNotesResult> {
    return saveChangeNotes(this.rt, source, { value: notes });
  }

  @callable()
  async sendChangeNotes(set: NotedChanges): Promise<ChangeNotesResult> {
    return sendChangeNotes(this.rt, { value: set }, (message, consume) => this.chatLoop.admit(message.text, { id: message.id, metadata: message.metadata, consume }));
  }

  /** Recent branching-head runs, grouped by root_id with heads, step traces and merged synthesis. */
  @callable()
  async getHeadRuns(limit = 20): Promise<HeadRunView[]> {
    return this.headJournal.listRuns(limit);
  }

  @callable()
  async getHeadRun(rootId: string): Promise<HeadRunView | null> {
    return this.headJournal.readRun(rootId);
  }

  /** One branch's transcript across both fork mechanisms; core picks the store, not the client.
   *  See read-models/node-transcript.ts for what each store can report. */
  @callable()
  /** `owner`: the path of the agent whose swarm it is. */
  async getNodeTranscript(runId: string, nodeId: string, request?: PageRequest, owner?: string): Promise<NodeTranscriptView | null> {
    const actor = owner === undefined ? this.actorHandle() : this.hostedTarget(owner)?.handle;

    return actor === undefined ? null : readNodeTranscript(this.boundSql, actor, { runId, nodeId }, request ?? {});
  }

  /**
   * Journal write for one finished head step; facets have their own storage, so it comes back over RPC.
   * The step is not on the wire: clients re-read the ledger. Traced because every step blocks on it.
   */
  @callable()
  async recordHeadStep(headId: string, seq: number, step: HeadStep): Promise<{ ok: true }> {
    return await this.tracing.invocation('rpc', 'head.record_step', async (_invocation, span) => {
      span.setAttribute('kinu.head_id', headId);
      span.setAttribute('kinu.step_seq', seq);
      // Announcement rides the journal write (LiveHeadJournal), so it fires once for facet and
      // in-isolate steps.
      this.headJournal.appendStep(headId, seq, step);

      return { ok: true };
    });
  }

  /**
   * `publishHeadStreamFrame` is reached in-process via `reportNodeDelta` and
   * `HostedActorSeams.publishDelta`; the RPC allowlist exposes only required remote capabilities.
   */

  /**
   * The parent's turn profile for a facet; facets must not resolve their own (they lack the role/turn,
   * and a later resolution can land a different digest). Resolves one if no turn is open.
   */

  /**
   * One page of the portable archive (format `kinu import` reads); walk `next` until null.
   * Owner-scoped ('interactive'); workspace capability tiers do not gate it.
   */
  @callable()
  async exportWorkspaceArchive(cursor?: ArchiveCursor): Promise<ArchivePage> {
    const ownerUserId = this.getOwnerUserId();

    if (!ownerUserId) throw new KinuError('unavailable', 'Cannot export an unclaimed workspace.');
    const workspace = this.hostedWorkspace().bundle;

    return readWorkspaceArchivePage(this.ctx.storage.sql, {
      workspace: this.name,
      source: 'cloud',
      cursor: parseArchiveCursor(cursor),
      files: workspaceArchiveFiles(workspace),
    });
  }

  /**
   * Tear down per-agent resources (Sandbox first), then wipe this DO; called by UserDO.removeWorkspace.
   * Not @callable: destruction must go through UserDO's ownership check.
   */
  async destroyAgent(expectedOwnerUserId: string): Promise<{ ok: true }> {
    if (!/^[a-f0-9]{32}$/.test(expectedOwnerUserId)) throw new KinuError('bad_input', 'invalid expected owner user id');

    // No owner: a creation that died before its claim, or storage from before a reset. The caller
    // `removeWorkspace` already verified ownership through the user's roster.
    const ownerUserId = this.storageRefusal === undefined ? this.getOwnerUserId() : null;

    if (ownerUserId !== null && ownerUserId !== expectedOwnerUserId) throw new KinuError('denied', 'Agent owner mismatch; refusing to destroy.');

    // First: revoke all preview URLs, else answering a stale one would create a fresh container object.
    // The watermark outranks every earlier record (core preview/preview-exposures.ts).
    if (this.env.AUTH_KV) {
      await sandboxPreviewExposures(
        this.env.AUTH_KV, sandboxIdForWorkspace(this.name),
      ).revokeAll();
    }

    if (this.env.Sandbox) {
      const sb = openSandbox(this.env.Sandbox, sandboxIdForWorkspace(this.name), { normalizeId: true });

      // Before destroy(): the container object owns its /workspace snapshot, and
      // once its storage is gone nothing knows which R2 objects were its.
      await sb.discardState();
      await sb.destroy();
    }

    // agents base: drops SDK tables, deleteAlarm, deleteAll (takes the filesystem), aborts the isolate.
    await this.destroy();

    return { ok: true };
  }

  @callable()
  async getFacts(limit = 100): Promise<Array<{
    key: string; value: unknown; confidence: number; source: string; lastObservedAt: number;
  }>> {
    return this.facts.recentTopK(limit).map((f) => ({
      key: f.key, value: f.value, confidence: f.confidence, source: f.source, lastObservedAt: f.lastObservedAt,
    }));
  }

  /** With candidateCode: the GEPA metric's rollout; without: runs the live scaffold. */
  private runScaffoldCaptureText(task: string, candidateCode?: string): Promise<string> {
    return runScaffoldCaptureText(this.scaffoldControl, task, candidateCode);
  }

  async getTurnRequests(turnId: string, actor?: string): Promise<TurnRequestIndex> {
    return turnRequestIndex(this.turnRequestSources(actor), turnId);
  }

  async getTurnRequest(
    turnId: string, at: { readonly epoch: number; readonly revision: number; readonly from?: number; readonly actor?: string },
  ): Promise<TurnRequestPage> {
    return await turnRequestPage(this.turnRequestSources(at.actor), { turnId, epoch: at.epoch, revision: at.revision, from: at.from });
  }

  /** Not @callable: the audited `workspace.turn_read`. */
  async supportReadTurn(read: {
    readonly turnId: string;
    readonly reason: string;
    readonly actor?: string;
    readonly at?: { readonly epoch: number; readonly revision: number; readonly from?: number };
  }): Promise<TurnRequestIndex | TurnRequestPage> {
    this.logActivity('support.read', `support read turn ${read.turnId} (${read.reason})`);

    return read.at === undefined
      ? await this.getTurnRequests(read.turnId, read.actor)
      : await this.getTurnRequest(read.turnId, { ...read.at, ...(read.actor !== undefined && { actor: read.actor }) });
  }

  private turnRequestSources(actorId: string | undefined): AgentStores {

    if (actorId === undefined) return this.stores;
    const host = this.actorHost();
    const record = host.describe(actorId);

    if (record === null) throw new KinuError('missing', 'The actor is not registered in this workspace.');

    return host.bindStores({ actorId: record.actorId, workspaceId: record.workspaceId, parentActorId: record.parentActorId }).stores;
  }

  /** For resume, pass the last seen `since` index; returns events strictly after it. */
  async getRunEvents(runId: string, opts?: RunEventQuery): Promise<RunEvent[]> {
    return getRunEvents(this.eventRecorder, runId, opts);
  }

  /** Not @callable: serves the run-event routes. */
  async getRunEventText(runId: string, opts?: RunEventQuery): Promise<StoredRunEvent[]> {
    return getRunEventText(this.eventRecorder, runId, opts);
  }

  /** Not @callable: the web UI uses `getRunSummaries`; serves `/runs`, MCP and CLI. */
  async listRuns(request?: PageRequest): Promise<Page<RunListEntry>> {
    return listRuns(this.eventRecorder, request?.cursor ?? null, request?.limit);
  }

  @callable()
  async inspectSubordinate(request: SubordinateInspectionRequest): Promise<SubordinateInspectionResult> {
    const owner = this.getOwnerUserId();

    if (!owner) throw new KinuError('denied', 'The workspace has no owner.');

    return this.inspectSubordinateStorage(request, { owner, workspace: this.name });
  }

  /**
   * One hosted actor's identity, program and open work. Read-only: `bindStores`, never `acquire`,
   * so inspecting a retained actor starts nothing. Owner-gated and resolved through the directory.
   */
  /** Resolved through the directory under this root's handle, so a name only reaches this root's children. */
  private hostedChild(target: string) {
    if (!this.getOwnerUserId()) throw new KinuError('denied', 'The workspace has no owner.');
    const actor = this.hostedTarget(target);

    if (actor === null) throw new KinuError('missing', `"${target}" is not an agent of this workspace.`);

    return { entry: actor.entry, child: this.actorHost().bindStores(actor.handle) };
  }

  @callable()
  async getActorSnapshot(name: string) {
    const { entry, child } = this.hostedChild(name);

    // The effective model: the actor's own pin, else the workspace's, else its tier's, with its source.
    const { profile } = await this.hostedActorProfile({
      actor: child.handle, availableTools: [], workMode: 'build',
    });

    return {
      name: entry.name,
      // The id every frame broadcast for this actor is stamped with; the pane uses it to filter frames.
      actorId: child.handle.actorId,
      displayName: child.stores.config.getDisplayName() ?? entry.name,
      role: child.stores.config.getRoleSelection(),
      mission: entry.birth?.seed.mission ?? '',
      model: { model: profile.tier.model, source: profile.tier.source },
      reasoningEffort: profile.tier.reasoningEffort,
      activePlan: child.stores.planReviews.getActive(CHAT_SESSION_ID),
      // Counted in the store: the pane holds only a window.
      messageCount: readSessionTranscript(this.boundSql, child.handle, CHAT_SESSION_ID, null).count(),
      // Read with the child's actor id; same rule as `pendingSteerRuns()`: a steer is a row bound to a turn.
      pendingSteers: new PendingSendStore(this.boundSql, child.handle.actorId).restore()
        .filter((row) => row.turnId !== null)
        .map((row) => ({ id: row.id, text: row.text, state: 'queued' as const, atStep: null })),
    };
  }

  /**
   * Broadcasts only a plan reference; not `@callable`, and deliberately not `broadcast`, which
   * facets must not reach. A hint: readers re-verify via owner-gated `inspectSubordinate`; a stub
   * call carries no caller identity.
   */
  async announceSubordinatePlan(reference: WorkspacePlanReference): Promise<void> {
    const parsed = v.parse(WorkspacePlanReferenceSchema, reference);
    const name = parsed.path[0];

    if (!name || !this.subordinateRoster.get(name)) {
      throw new KinuError('denied', 'This workspace has no such plan actor.');
    }

    this.broadcastToActor(null, JSON.stringify({ type: 'workspace_plan_updated', reference: parsed }));
  }

  @callable()
  async getRunSummaries(request?: PageRequest): Promise<Page<RunSummary>> {
    return getRunSummaries(this.eventRecorder, request?.cursor ?? null, request?.limit);
  }

  async accountSpend(): Promise<AccountSpend[]> {
    return this.eventRecorder.spendByAccount();
  }

  /** The machine's name is read from the account, so it is current. */
  private async codexRoute(egress: string | undefined, deviceId: string | null): Promise<NonNullable<ActivitySnapshot['latest']>['route']> {
    if (egress === 'relay') return { kind: 'container' };

    if (deviceId === null) return null;
    const { stub, caller } = await this.userHub();

    return { kind: 'device', id: deviceId, name: await stub.deviceName(caller, deviceId) };
  }

  /**
   * `steps` bounds only the telemetry sample; `spend` is summed in SQL over the whole log, never windowed.
   * `telemetry` is this agent's own turns; `spend` covers every producer in the workspace.
   */

  @callable()
  async getActivitySnapshot(opts?: { steps?: number; logs?: number }): Promise<ActivitySnapshot> {
    const windowLimit = clampLimit(opts?.steps, ACTIVITY_STEP_WINDOW);
    const logLimit = clampLimit(opts?.logs, ACTIVITY_LOG_WINDOW);
    const events = this.eventRecorder.readRecentByType('step_finish', windowLimit);
    const steps = events.flatMap((e) => (e.type === 'step_finish' ? [e] : []));

    // Warms are `model_call` rows, never steps, so they cannot skew the EMA; they are only counted.
    const warms = this.eventRecorder.readRecentByType('model_call', windowLimit)
      .flatMap((e) => (e.type === 'model_call' && e.source === 'warming' ? [e] : []));

    // An all-absent Usage is still a truthy object, so "the provider said
    // something" is `usageReported` — never a presence check on the field.
    const measured = steps.filter((e) => usageReported(e.usage ?? {}));
    const newest = measured[measured.length - 1];
    const deviceId = newest?.egress?.startsWith('device ') === true ? newest.egress.slice('device '.length) : null;

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
          modelId: newest.modelId ?? null,
          route: await this.codexRoute(newest.egress, deviceId),
        },
      // Null rather than a default: a share-of-window shown against a guessed
      // window would be a made-up percentage.
      contextWindow: this.modelCatalog.contextWindow() || null,
      fill: this.contextFill(),
      // Every step in the window, reporting or not: `summarizeSteps` counts the
      // silent ones into `stepsWithoutUsage` so the totals carry their own
      // denominator instead of quietly under-counting.
      telemetry: summarizeSteps(steps, { windowLimit, warms }),
      // Not `this.budget.snapshot()`: that answers a narrower question, and two mission figures
      // would conflict.
      spend: workspaceSpend({ events: this.eventRecorder, sql: this.boundSql, actor: this.actorHandle() }),
      log: readActivityLog(this.boundSql, this.actorHandle(), logLimit),
    };
  }

  /** Routes through the same appendMemoryNote primitive as workspace.saveNote and the `memory` builtin. */
  async saveNoteFromMcp(content: string): Promise<{ ok: true }> {
    await appendMemoryNote(this.rt.memory, content);

    return { ok: true };
  }

  /** Delivers a task signal through the same seam as the event→turn reactor and background-job wake.
   * The words come from the MCP client's operator, so the signal names its author. */
  async runTaskFromMcp(text: string): Promise<EnqueueTurnResult> {
    const trimmed = text.trim();

    if (!trimmed) throw new KinuError('bad_input', 'run_task requires non-empty text');

    const outcome = await this.orch.inbox.send({
      kind: 'mcp', text: trimmed,
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator' },
    });

    return { status: outcome === 'undelivered' ? 'skipped' : 'queued' };
  }

  /** Fire-and-forget over the peer-deps transport; owner + same-owner roster gate is enforced there. */
  async sendPeerFromMcp(input: { agent: string; topic?: string; message: string }): Promise<PeerSendOutcome> {
    if (!input?.agent || !input?.message) throw new KinuError('bad_input', 'send_peer requires agent and message');

    return this.getPeersToolDeps().send({
      agent: input.agent,
      topic: (input.topic ?? '').trim() || 'message',
      message: input.message,
      mode: 'build',
    });
  }

  /** The owner's other agents, self excluded. */
  async listPeersFromMcp(): Promise<Array<{ name: string; displayName?: string }>> {
    return this.getPeersToolDeps().listPeers();
  }

  /**
   * FTS5 + Vectorize merged via Reciprocal Rank Fusion; pure FTS5 when Vectorize isn't bound.
   * The single memory-search surface for all remote callers (browser rpc, CLI /rpc, MCP).
   */
  @callable() async searchMemoryHybrid(query: string, limit = 10): Promise<HybridHit[]> {
    const lexicalSearchFn = async (q: string, k: number) => {
      const results = await this.rt.memory.search(q, k);

      return results.map((r) => ({
        // Must match the vector store's chunk id (`path:start-end`) so RRF fuses lexical and semantic hits.
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
    // `read` returns null only for an absent file; other VFS failures must throw, since "" would
    // be indistinguishable from an empty MEMORY.md.
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
      getRunTimeline: () => this.getRunTimeline(),
      getToolDescriptions: () => this.getToolDescriptions(),
      getWorkspaceSnapshot: () => this.getWorkspaceSnapshot(),
      listBackgroundJobs: () => this.listBackgroundJobs(),
      listTriggers: () => this.listTriggers(),
    };

    return v.parse(JsonValueSchema, await reads[source]());
  }

  /** The owner's browser acting on its own workspace, as the root caller. */
  @callable() async slate(operation: SlateOperation): Promise<SlateCallResult> {
    return this.slates.operation(this.slateCaller(), operation);
  }

  /** An actor of this workspace acting as itself; DO-only, like `workspaceBoxOp`. */
  async slateAs(caller: SlateCaller, operation: SlateOperation): Promise<SlateCallResult> {
    return this.slates.operation(caller, operation);
  }

  /**
   * Names only, never surfaces: the graph shows what a binding could reach;
   * dispatch still decides per call what it does reach.
   */
  protected async slateBindingCatalog(): Promise<SlateBindingCatalog> {
    const [profile, descriptors] = await Promise.all([
      this.profileInputs(),
      this.requireOwnerUserDO().userMcp_toolDescriptors(await this.userCaller()),
    ]);

    const mcp = v.parse(McpToolSurfaceSchema, JSON.parse(descriptors));

    const mcpServers = new Map<string, { title: string; tools: { name: string; readOnly: boolean }[] }>();

    for (const descriptor of mcp.descriptors) {
      const group = mcpServers.get(descriptor.serverId) ?? { title: descriptor.serverName, tools: [] };
      group.tools.push({ name: descriptor.name, readOnly: descriptor.readOnly === true });
      mcpServers.set(descriptor.serverId, group);
    }

    return {
      executors: this.slateNamespaces()
        .map((provider) => ({ namespace: provider.name, members: Object.keys(provider.tools) })),
      mcp: [...mcpServers.entries()].map(([server, group]) => ({ server, title: group.title, tools: group.tools })),
      tools: this.rt.craftStore.list().map((tool) => tool.name),
      tiers: tierIdsOf(profile.envelope.catalog),
      slates: await this.slates.projects(ROOT_SLATE_CALLER),
    };
  }

  private _slates: SlateHost | undefined;

  protected get slates(): SlateHost {
    this._slates ??= new SlateHost({
      ctx: this.ctx, workspace: this.name,
      session: () => this.hostedWorkspace().bundle.session(),
      facetManager: () => this.hostedWorkspace().facetManager(),
      dispatch: (caller, route) => this.slateBindingDispatch(caller.path, route, caller.workMode),
      apps: {
        ensure: (input) => this.hostedWorkspace().apps.ensure(input),
        remove: (owner) => this.hostedWorkspace().apps.remove(owner),
        url: (port, capability) => nimbusPreviewUrl(this.env, this.name, port, capability),
      },
      catalog: () => this.slateBindingCatalog(),
      shareUrl: (handle) => slateShareUrl(this.env, this.name, handle),
      kv: this.env.AUTH_KV,
      budget: () => this.budget,
      ownerTitle: async () => this.safeDisplayName(),
      ownerUserId: () => this.getOwnerUserId(),
      forgetPicture: async (slate) => {
        await this.pictures.forget(this.name, slate, this.env.SLATE_PICTURES);
        this.armDurableWake();
      },
      previewed: (slate) => { this.noteTurnSlates('shown', [slate]); },
      sharesChanged: async () => {
        this.overviewChanged(true);

        return await this.overviewSettled() === null ? 'current' : 'pending';
      },
    });

    return this._slates;
  }

  async slateBindingCallAs(caller: SlateCaller, id: string, name: string, request: SlateBindingRequest): Promise<SlateCallResult> {
    return this.slates.bindingCall(caller, id, name, request);
  }

  /** The share route has already verified the request; admission and routing live on the slate host,
   * never in this method. */
  async routeSlateShare(
    handle: string,
    claim: ShareViewerClaim,
    request: Request,
    pathname: string,
  ): Promise<Response> {
    return this.slates.routeShare(handle, claim, request, pathname);
  }

  /** The URL a live share answers at, or null where this deployment cannot mint one. */
  liveShareUrl(handle: string): Promise<string | null> {
    return slateShareUrl(this.env, this.name, handle);
  }

  /** Minted by the app host because only it knows the signed-in user; binds that user to this share. */
  viewerEntryUrl(handle: string, userId: string): Promise<string | null> {
    return viewerEntryUrl(this.env, this.name, handle, userId);
  }

  /** The share row re-read through the S6 gate, plus title and description from the slate's package.json. */
  async readLiveShare(share: string): Promise<SlateAnswer<{ record: LiveShareRecord; title: string; description: string }>> {
    return this.slates.readLiveShareRecord(share);
  }

  /**
   * Share row re-read through the S6 gate (revoked answers 'missing'); a `users` share forks for whom it admits,
   * `public` for anyone signed in. Skeleton is the running slate's tree.
   */
  async liveShareBundle(share: string, userId: string): Promise<SlateAnswer<BlueprintBundle>> {
    const record = await this.slates.readLiveShareRecord(share);

    if (!record.ok) return { ok: false, reason: record.reason, error: record.error };
    const { record: row } = record.value;

    if (row.visibility === 'users' && !this.slates.liveShareAdmitsUser(row.id, userId)) {
      return { ok: false, reason: 'missing', error: 'No such share' };
    }

    if (row.grant.fork === false) {
      return { ok: false, reason: 'denied', error: 'This share does not allow forking' };
    }

    return this.slates.liveShareBundle(row);
  }

  /** DO-only, like the blueprint twin, for the same reason. */
  async shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<LiveShareRecord>> {
    return this.slates.shareLiveWith(share, users);
  }

  @callable() async listSlates() {
    return this.slates.list(ROOT_SLATE_CALLER);
  }

  // Blueprints cross workspaces, so these four are DO-only: the app host verifies viewer, address and
  // forker ownership before calling, and no browser stub reaches them.

  async readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>> {
    return this.slates.readBlueprint(share);
  }

  async blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>> {
    return this.slates.blueprintBundle(share);
  }

  async shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>> {
    return this.slates.shareBlueprintWith(share, users);
  }

  /** Admits into this workspace as a new slate with every binding unmapped. */
  async admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>> {
    return this.slates.admitBlueprint(bundle);
  }

  @callable() async previewSlate(id: string): Promise<SlateCallResult> {
    return this.slates.preview(ROOT_SLATE_CALLER, id);
  }

  @callable() async getToolDescriptions() {
    // Descriptions and reach come from @kinu.run/core/tools/registry. Declared capability and what
    // this actor wires (from the built ToolSet) are reported separately; a native/codemode binary
    // can't say "neither".
    const mode = await this.preparedWorkMode();
    const wiredNames = new Set(Object.keys(this.getRawToolsForWorkMode(mode)));

    const builtIn = BUILTIN_TOOLS.map(name => ({
      name,
      // Both registers come from one spec (list headline and model docstring);
      // the UI must never recover one from the other by splitting text.
      summary: BUILTIN_TOOL_SPECS[name].summary,
      description: BUILTIN_TOOL_DESCRIPTIONS[name],
      // Every BUILTIN_TOOLS name is native by type, so owning a codemode namespace makes it both.
      exposure: TOOL_REACH[name].codemode ? 'both' as const : 'native' as const,
      wired: wiredNames.has(name),
    }));

    const craftedRaw = this.rt.craftStore.list();

    const crafted = craftedRaw.map(t => {
      // crafted_tools is workspace-wide with no actor_id, so quality is keyed by name alone.
      const scoreRow = this.sql<{ score: number; uses: number }>`
        SELECT score, uses FROM crafted_tools WHERE name = ${t.name} LIMIT 1`;

      return {
        name: t.name,
        description: t.description || "Crafted tool",
        isLearned: true,
        // Crafted tools are never ToolSet entries (routed via createExecuteTool's providers),
        // so codemode is their reach and they are wired whenever the store holds them.
        exposure: 'codemode' as const,
        wired: true,
        qualityScore: scoreRow[0]?.score ?? 0.5,
        usageCount: scoreRow[0]?.uses ?? 0,
      };
    });

    const executors = this.rt.executionRouter?.listExecutors() ?? [];

    return { builtIn, crafted, executors };
  }

  @callable() async setDisplayName(displayName: string) {
    await this.propagateDisplayName(displayName, 'user');

    return { displayName };
  }

  async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) {
    // Genesis only, after the create path registered the row in the root registry;
    // the cache is seeded from that write, and the root remains the authority.
    this._titleCache = { displayName, nameOrigin };
    this._titleHydrated = true;

    return { displayName, nameOrigin };
  }

  /**
   * Not `@callable`: clients cannot fabricate a genesis turn. Creation calls it once, last.
   * Returns once the turn is queued; the agents-SDK heartbeat holds the DO.
   */
  async beginGenesisTurn(): Promise<{ started: boolean }> {
    const signal = workspaceGenesisSignal(readMission(this.boundSql));

    if (!signal) return { started: false };
    // The send admits the turn before its first await; only the wait is detached.
    const sent = this.orch.inbox.send(signal);
    this.detachOwned(async () => {
      try {
        await this.keepAliveWhile(() => sent);
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

  @callable() async listMounts() {
    return this.rt.executionRouter ? listEnvironments(this.rt.executionRouter) : [];
  }

  /** Browser-only; delegates to the same orchestration policy as the model's agents tool. */
  @callable() async listSubordinates(): Promise<SubordinateRosterEntry[]> {
    return this.subordinateViews();
  }

  /**
   * Blank `displayName` is intentional: the first-interaction title policy reads it
   * (`SubordinateAgent.onChatResponse`). Route by `name`, a stable slug.
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

  /** Writes the child and the roster row together and marks the title owner-set,
   *  which stops auto-titling. */
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

  @callable() async dismissSubordinate(name: string, keepHistory = true): Promise<{
    ok: true;
    name: string;
    historyKept: boolean;
  }> {
    return this.getTeamToolDeps().dismiss({ name, requestedBy: 'user', keepHistory });
  }

  /**
   * Streams are clipped to {@link EXECUTOR_OUTPUT_CLIP} chars with true length beside them.
   * Must filter by actor: executor ids are shared across actors in the workspace box.
   */
  async getExecutorOutput(executorId: string) {
    return this.sql<ExecutorOutputRow>`SELECT id, executor, command,
        substr(stdout, 1, ${EXECUTOR_OUTPUT_CLIP}) AS stdout, length(stdout) AS stdout_len,
        substr(stderr, 1, ${EXECUTOR_OUTPUT_CLIP}) AS stderr, length(stderr) AS stderr_len,
        exit_code, created_at
      FROM executor_output
      WHERE actor_id = ${this.actorHandle().actorId} AND executor = ${executorId}
      ORDER BY created_at DESC, rowid DESC LIMIT ${EXECUTOR_HISTORY_ROWS}`;
  }

  private recordExecutorOutput(
    executorId: string, command: string, output: { stdout: string | null; stderr: string; exitCode: number },
  ): void {
    const actorId = this.actorHandle().actorId;

    void this.sql`INSERT INTO executor_output (actor_id, executor, command, stdout, stderr, exit_code)
      VALUES (${actorId}, ${executorId}, ${command}, ${output.stdout}, ${output.stderr}, ${output.exitCode})`;
    void this.sql`DELETE FROM executor_output WHERE actor_id = ${actorId} AND executor = ${executorId}
      AND rowid NOT IN (SELECT rowid FROM executor_output WHERE actor_id = ${actorId} AND executor = ${executorId}
        ORDER BY created_at DESC, rowid DESC LIMIT ${EXECUTOR_HISTORY_ROWS})`;
  }

  /** Seals reportless branch heads with an error report; the status change is the cursor.
   * LIMIT-bounded for the init gate; returns truncated so the caller arms the maintenance wake. */
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

  /** Asks each lane's own read path at limit 1, since presence is a boolean. */
  @callable() async getWorkspaceTabPresence(): Promise<TabPresence> {
    // Same reads the Work tab mounts. A live turn is not content: streaming with
    // nothing renderable keeps the tab hidden.
    const [pendingActions, jobs, workspaceWork, changelog, memoryContent] = await Promise.all([
      this.listPendingActions(),
      this.listBackgroundJobs(20),
      this.listWorkspaceWork(),
      this.getEvolutionChangelog({ limit: 1 }),
      this.getMemoryContent(),
    ]);

    return {
      work: hasWorkspaceWork({
        work: workspaceWork, pending: pendingActions, jobs,
        changes: changelog.entries, notes: parseMemoryNotes(memoryContent ?? ''),
      }),
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
        outputs: await this.getExecutorOutput(e.name),
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
      turnClaim: this.turnClaimState(),
    };
  }

  /**
   * Durable "is a turn running" answer. `unsettled()` is the only record that outlives the isolate;
   * a claim this isolate is not executing is stranded and nothing else will settle it.
   */
  private turnClaimState(): TurnClaimState {
    const open = this.claims.unsettled(1)[0];

    if (open === undefined) return { kind: 'settled' };

    return {
      kind: this._inFlight || this.actorSession.inFlight ? 'admitted' : 'stranded',
      turnId: open.turnId, claimedAt: open.claimedAt,
    };
  }

  /** The root's tabs hear the claim when they connect ({@link ActorAgent}'s connect), and every change to it here. */
  protected override turnClaimChanged(): void {
    this.broadcastToActor(null, this.turnClaimFrame());
    this.overviewChanged();
  }

  protected override turnClaimFrame(): string {
    return JSON.stringify({ type: TURN_CLAIM_FRAME, claim: this.turnClaimState() });
  }

  /**
   * Settle a claim nobody is executing, sealed `indeterminate` since its outcome is unknown,
   * and give any actor that still owes a wake one so the turn resumes.
   */
  @callable() async recoverStrandedTurn(): Promise<{ readonly recovered: 'sealed' | 'requeued' | 'none' }> {
    const state = this.turnClaimState();

    if (state.kind !== 'stranded') return { recovered: 'none' };
    const claim = this.claims.read(state.turnId);

    if (claim === null) return { recovered: 'none' };
    this.claims.settleRecovered(claim.turnId, claim.epoch, 'indeterminate');
    diagnostics.event('turn.claim_recovered', { turnId: claim.turnId, epoch: claim.epoch });

    if (!this.owedWorkExists()) return { recovered: 'sealed' };
    this.armOwedWorkWake('recovery');

    return { recovered: 'requeued' };
  }

  private slowOverview: {
    readonly sqlRevision: number;
    readonly slateRevision: number;
    readonly expiresAt: number;
    readonly inputs: Omit<WorkspaceOverviewInputs, 'working' | 'unfinished' | 'latestRun'>;
  } | null = null;

  private async overviewInputs(): Promise<Omit<WorkspaceOverviewInputs, 'working' | 'unfinished' | 'latestRun'>> {
    const sqlRevision = storeRevision(this.boundSql);
    const slateRevision = storeRevision(this.ctx.storage.sql);
    const held = this.slowOverview;

    if (held !== null && held.sqlRevision === sqlRevision && held.slateRevision === slateRevision && Date.now() < held.expiresAt) {
      return held.inputs;
    }

    const pendingConsents = new DeviceConsentStore(this.boundSql).live(Date.now());

    const [activePlan, listing] = await Promise.all([
      this.getActivePlanReview(),
      this.slates.list(ROOT_SLATE_CALLER),
    ]);

    const pictures = this.pictures.digests();
    const shares = await this.slates.shareCards(new Map(listing.slates.map((slate) => [slate.id, slate.title])));

    const inputs = {
      pendingActions: this.pendingActions(),
      pendingConsents,
      activePlan,
      scaffoldAutoApply: this.config.getAutoPromoteScaffold(),
      slates: listing.slates.map((slate) => ({
        id: slate.id, title: slate.title, picture: pictures.get(slate.id) ?? null, bindings: slate.bindings.length,
      })),
      shares,
    };

    // A write during the awaits must be observed by this push, not only the next one.
    if (storeRevision(this.boundSql) !== sqlRevision || storeRevision(this.ctx.storage.sql) !== slateRevision) {
      return this.overviewInputs();
    }

    this.slowOverview = {
      sqlRevision, slateRevision, inputs,
      expiresAt: pendingConsents.reduce((at, consent) => Math.min(at, consent.expiresAt), Infinity),
    };

    return inputs;
  }

  /** Only slow source sections are held; every push folds the turn's current activity and run. */
  async foldOverview(): Promise<WorkspaceOverview> {
    const inputs = await this.overviewInputs();

    const hostedBusy = this.actorHost().list()
      .some((reference) => this.actorHost().hosted(reference)?.session.inFlight === true);

    const header = this.eventRecorder.latestRunHeader();
    // A settled turn's leftovers still closing are its work, not a durable leftover.
    const working = this._inFlight || hostedBusy || this.terminalClosing;

    return buildWorkspaceOverview({
      ...inputs,
      working,
      // Read only when idle: a working tile shows Working whatever is owed.
      unfinished: !working && (this.owedUntimedWork() || this.workOwedAt() !== null),
      latestRun: header === null ? null : { status: header.status, task: header.userMessage },
    });
  }

  /** Asked by `CodemodeEgress` before it pipes a program's socket to a browser session. Never `@callable`. */
  ownsBrowserSession(actorId: string, sessionId: string): boolean {
    return ownsBrowserSession(this.ctx.storage.sql, actorId, sessionId);
  }

  /** The owner's object ignores a repeat. */
  private pushedOverview: string | null = null;
  private overviewDirty = false;
  private overviewPushing = false;
  private readonly overviewSettlers: Array<(failure: KinuError | null) => void> = [];
  /** Changes meanwhile ride its push. */
  private overviewRetry: { readonly at: number; readonly attempts: number } | null = null;

  async requestOverviewPush(): Promise<void> {
    this.overviewChanged();
  }

  protected override overviewChanged(force = false): void {
    this.overviewDirty = true;

    if (this.overviewPushing || this.getOwnerUserId() === null) return;

    const retry = this.overviewRetry;

    if (!force && retry !== null && Date.now() < retry.at) return;
    this.overviewPushing = true;

    // In flight, it owes the wake a failure would arm.
    if (retry !== null) this.overviewRetry = { at: Date.now() + recoveryBackoffMs(retry.attempts + 1), attempts: retry.attempts };
    this.detachOwned(async () => {
      let failed: KinuError | null = null;

      try {
        while (this.overviewDirty) {
          this.overviewDirty = false;
          const overview = await this.foldOverview();
          const pushed = JSON.stringify(overview);

          if (pushed === this.pushedOverview) continue;

          // Installing a token pushes.
          if (this.workspaceCapabilityToken() === null) {
            this.overviewDirty = true;
            break;
          }

          const { stub, caller } = await this.userHub();
          await stub.putWorkspaceOverview(caller, this.name, overview);
          this.pushedOverview = pushed;
        }

        this.overviewRetry = null;
      } catch (cause) {
        this.overviewDirty = true;
        const failure = toKinuError({ doing: "pushing this workspace's tile to its owner's roster", cause, otherwise: 'unavailable' });
        const attempts = (this.overviewRetry?.attempts ?? 0) + 1;
        // A refusal meets the next push.
        const retrying = failure.code === 'unavailable' || failure.code === 'timeout';
        failed = failure;
        this.overviewRetry = retrying ? { at: Date.now() + recoveryBackoffMs(attempts), attempts } : null;
        diagnostics.failure('workspace.overview_push_failed', failure, { workspace: this.name, attempts, retrying });

        if (this.overviewRetry !== null) await this.scheduleTerminalRetry(this.overviewRetry.at);
      } finally {
        this.overviewPushing = false;

        for (const settleWaiter of this.overviewSettlers.splice(0)) settleWaiter(failed);
      }
    });
  }

  /** Once its card moved, or the failure that left the list behind. */
  private async overviewSettled(): Promise<KinuError | null> {
    if (!this.overviewPushing) return null;

    return await new Promise<KinuError | null>((resolve) => { this.overviewSettlers.push(resolve); });
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

    // Device rides as tool context read by readDeviceSelection (docs/EXECUTION-LAYER-SPEC.md
    // "The user's account is a fleet"); with none, the call keeps the unnamed default.
    try {
      const result = v.parse(CommandResultSchema, device === undefined ? await execTool.execute(command) : await execTool.execute(command, { device }));

      const output = v.is(v.string(), result)
        ? { stdout: result, stderr: '', exitCode: 0 }
        : { stdout: result.error, stderr: result.error, exitCode: 1, refusal: result };

      this.recordExecutorOutput(executorId, command, output);

      this.broadcast(JSON.stringify({
        type: 'executor-output', executor: executorId, command, ...output, timestamp: Date.now(),
      }));

      return output;
    } catch (err) {
      const refusal = refusalOf(toKinuError({ doing: 'execute on ' + executorId, cause: err, otherwise: 'io' }));
      const errMsg = refusal.error;
      this.recordExecutorOutput(executorId, command, { stdout: null, stderr: errMsg, exitCode: 1 });
      // Broadcast errors too: the UI terminal renders only from broadcasts. (STABILITY-AUDIT §B4.)
      this.broadcast(JSON.stringify({
        type: 'executor-output', executor: executorId, command, stdout: '',
        stderr: errMsg, exitCode: 1, refusal, timestamp: Date.now(),
      }));

      return { error: errMsg, exitCode: 1, refusal };
    }
  }

  /** Directory listing read off each executor's own raw handle, in that environment's paths. */
  @callable() async getExecutorFiles(executorId: string, path: string): Promise<{ path?: string; entries?: DirEntry[]; error?: string }> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };

    return getExecutorFiles(this.rt.executionRouter, executorId, path);
  }

  @callable() async readExecutorFile(executorId: string, path: string): Promise<{ content?: string; truncated?: boolean; error?: string }> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };

    return readExecutorFile(this.rt.executionRouter, executorId, path);
  }


  /** Native rename where the plane supports it, byte carry for files elsewhere, refusal for
   * directories that only bytes could carry. Never overwrites. */
  @callable() async renameExecutorFile(executorId: string, from: string, to: string): Promise<ExecutorWriteResult> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };

    return renameExecutorPathOp(this.rt.executionRouter, executorId, from, to);
  }

  /** Directories use the plane's native tree removal where it exists, entry by entry elsewhere. */
  @callable() async deleteExecutorFile(executorId: string, path: string): Promise<ExecutorWriteResult> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };

    return deleteExecutorPathOp(this.rt.executionRouter, executorId, path);
  }


  // Chunked transfer for files-routes.ts keeps each payload under `do.facet.rpc_bytes`.
  // The actor is single-threaded, so these maps need no lock.
  private readonly executorFileUploads = new Map<string, {
    readonly executorId: string;
    readonly path: string;
    readonly expectedRevision: VfsRevision | undefined;
    readonly upload: ExecutorFileUpload;
  }>();
  private readonly executorFileDownloads = new Map<string, ExecutorFileDownload>();

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

  /** The route supplies a fresh transfer id per GET, so readers never share or reuse stale bytes. */
  async readExecutorFileChunk(read: ExecutorFileChunkRead): Promise<{ bytes: Uint8Array } | { error: string }> {
    const { executorId, path, transferId, offset, length } = read;
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

  /** An `offset === 0` chunk (re)starts the transfer so retries self-heal; ordering and
   * continuity are enforced inside the transfer, not trusted from the caller. */
  async writeExecutorFileChunk(write: ExecutorFileChunkWrite): Promise<ExecutorWriteResult> {
    const { executorId, path, transferId, offset, chunk, final, expectedRevision } = write;
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
        upload: new ExecutorFileUpload(router, executorId, path, {
          expectedRevision,
          writeSoul: async (bytes) => { await this.setSoul(new TextDecoder().decode(bytes)); },
        }),
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

  /** Terminal preflight via the sandbox lane's own `ensureReady` (egress grants, /workspace).
   * Not @callable: called by the terminal HTTP route (see terminal-route.ts). */
  async prepareTerminal(executorId: string): Promise<{ ok: true } | { error: string }> {
    // The owner's machine has no container to warm; it only needs to be attached.
    if (executorId === 'device') {
      const device = this.rt.deviceTransport.status();

      if (device.connected) return { ok: true };

      if (device.registered) return { error: 'That machine is offline. Run `kinu connect` on it.' };

      return { error: 'No machine is linked to this account yet. Run `kinu connect` on the one you want.' };
    }

    if (executorId === 'workspace') {
      try {
        await this.hostedWorkspace().terminal();

        return { ok: true };
      } catch (cause) {
        return { error: terminalRefusal({ doing: 'composing the workspace runtime for a terminal', cause }) };
      }
    }

    if (executorId !== 'sandbox') return { error: `${executorId} has no terminal` };
    const handle = this.rt.sandboxHandle;

    if (!handle) return { error: 'the sandbox container is not configured for this workspace' };

    try {
      await handle.ensureReady();

      return { ok: true };
    } catch (cause) {
      return { error: terminalRefusal({ doing: 'preparing the sandbox container for a terminal', cause }) };
    }
  }

  /**
   * Opens via this object because only it holds the workspace capability token the hub needs.
   * `user` is the object holding both sockets; the route sends the pane's upgrade there.
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
      // Each refusal the user object authors (no device, an older daemon, consent) reaches the pane as written.
      return { error: terminalRefusal({ doing: 'opening a terminal on this machine', cause }) };
    }
  }

  /** Workspace port registrations live in Nimbus, so they stay authoritative after a restart. */
  @callable() async getExposedPorts(executorId: string): Promise<ExposedPortList> {
    const refused = executorId === 'sandbox' ? this.config.get(SANDBOX_REFUSED) : null;

    if (refused != null) return { ports: [], error: refused };

    if (executorId === 'sandbox' && this.config.get(SANDBOX_STARTING) != null) {
      return { ports: [], pending: "the sandbox's container is still restoring" };
    }

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

  /** `actor` names a child of this workspace: the read is its own config. */
  @callable() async getReasoningEffort(actor?: string): Promise<{ effort: ReasoningEffort | null }> {
    return getReasoningEffort(actor === undefined ? this.config : this.hostedChild(actor).child.stores.config);
  }

  @callable() async setReasoningEffort(effort: ReasoningEffort | null, actor?: string) {
    return setReasoningEffort(actor === undefined ? this.config : this.hostedChild(actor).child.stores.config, effort);
  }

  @callable() async getProviderAccounts(actor?: string) {
    return getProviderAccounts(actor === undefined ? this.config : this.hostedChild(actor).child.stores.config);
  }

  @callable() async setProviderAccount(provider: string, account: string | null, actor?: string) {
    return setProviderAccount(actor === undefined ? this.config : this.hostedChild(actor).child.stores.config, provider, account);
  }

  /** A hosted actor's own model pin, over the workspace's for its turns. */
  @callable() async setActorModel(actor: string, spec: string) {
    return setModel(this.modelSetting(this.hostedChild(actor).child.stores.config, () => {}), spec);
  }

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

  /** From the owner's row, the file resealed first. */
  protected override async loadSoulText(): Promise<string> {
    return (await settledWorkspaceSoul(this.hostedWorkspace().bundle)) ?? '';
  }

  @callable() async setSoul(soul: string) {
    const text = soul.trim();

    if (!text) throw new KinuError('bad_input', 'SOUL.md cannot be empty.');
    const ownerUserId = this.getOwnerUserId();

    if (!ownerUserId) throw new KinuError('unavailable', 'SOUL.md is unavailable until the workspace owner claim completes.');
    await writeSoul(this.boundSql, text, (content) => writeWorkspaceSoul(this.hostedWorkspace().bundle, content));
    // The next turn re-reads the soul from its row.
    this._cachedSoulText = null;

    return { soul: text, purpose: summarizeSoul(text) };
  }

  @callable() async getEvolutionConfig(): Promise<EvolutionConfigView> {
    return getEvolutionConfig(this.config);
  }

  @callable() async setEvolutionConfig(config: Partial<EvolutionConfigView>): Promise<EvolutionConfigView> {
    return setEvolutionConfig(this.config, config);
  }


  /** Continue the chat from before `entryId`; open tabs get the reverted transcript via the
   * session event this emits. */
  @callable()
  async revertConversation(entryId: string): Promise<void> {
    await this.chatLoop.revertTo(entryId);
  }

  /**
   * Fork this agent at a message; driver is core's (identity/fork-driver.ts), this supplies
   * the transport. See docs/WORKSPACES.md for the full spec.
   */
  @callable()
  async forkAgent(
    untilMessageId: string,
    opts?: { name?: string },
  ): Promise<{ id: string; name: string; url: string; forkPointMs: number }> {
    // Check first: a fork of an unclaimed workspace has nobody to own the copy.
    this.requireOwnerForFork();

    const fork = await forkWorkspace({
      sql: this.boundSql,
      actor: this.rt.actor,
      // One pin of the workspace files, exported a page and a frame of chunks at a time: a fork holds one frame.
      vfs: createWorkspaceForkSource(this.hostedWorkspace().bundle),
      artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)),
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

  /** A hosted fork needs the owner for both source session and target file plane; refuse
   * unclaimed workspaces before a roster name is reserved. */
  private requireOwnerForFork(): string {
    const ownerUserId = this.getOwnerUserId();

    if (!ownerUserId) throw new KinuError('unavailable', 'cannot fork an unclaimed workspace');

    return ownerUserId;
  }

  /** Reaches a not-yet-existing workspace DO by name and carries the snapshot via raw-copy RPC. */
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

        if (!ownerUserId) throw new KinuError('unavailable', 'cannot fork an unclaimed workspace');
        const { stub, caller } = await this.userHub();

        return deliverCloudFork({
          registry: stub,
          caller,
          target: stubFor(name),
          name,
          // Must be this object's own fenced handle (the one `forkWorkspace` checked against),
          // never a fresh handle or a name off the wire: rows are keyed per actor, so another would
          // snapshot a sibling.
          source: { ...snapshot, actor: this.actorHandle() },
          ownerUserId,
        });
      },
    };
  }

  /**
   * Per-activation receiver cache; transfer state lives in SQLite.
   * Keyed by transfer id, which is per delivery, so a retry under a new id must rebuild it.
   */
  private forkReceiver: { transferId: string; receiver: ForkTransferReceiver } | null = null;

  #forkReceiverFor(forkName: string, transferId: string, ownerUserId: string): ForkTransferReceiver {
    if (this.forkReceiver?.transferId === transferId) return this.forkReceiver.receiver;

    const writer = new ForkTargetWriter(this.boundSql, {
      workspaceId: this.ctx.id.toString(), workspaceName: forkName, ownerUserId,
      // The target's own payload plane: carried payloads are re-rooted so the fork never reads its source.
      artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)),
      transaction: (rows) => this.ctx.storage.transactionSync(rows),
    });

    const receiver = new ForkTransferReceiver(
      writer,
      createWorkspaceForkSink(this.hostedWorkspace().bundle),
    );

    this.forkReceiver = { transferId, receiver };

    return receiver;
  }

  /** Receive one bounded frame from the source DO. Not callable from public WS/HTTP; only the
   * source cross-DO stub reaches this. */
  async rawCopyFromFork(
    forkName: string,
    frame: ForkFrame,
    ownerUserId: string,
  ): Promise<ForkFrameAck> {
    if (!ownerUserId) throw new KinuError('bad_input', 'fork owner is required');
    const currentOwner = this.getOwnerUserId();

    if (currentOwner && currentOwner !== ownerUserId) return { ok: false, reason: 'owned_by_another_user' };

    // Owner is the only identity datum written before commit (Nimbus file-plane precondition);
    // the rest publishes together in the writer transaction.
    const identity = this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`;

    if (identity.length === 0) {
      this.bearWorkspace(forkName, ownerUserId);
    } else {
      void this.sql`UPDATE workspace_identity SET owner_user_id = ${ownerUserId}`;
    }

    this._ownerUserId = ownerUserId;
    this.invalidateModelCaches();

    const receiver = this.#forkReceiverFor(forkName, frame.transferId, ownerUserId);
    const outcome = await receiver.accept(frame);

    // Publication does this once; an already-settled transfer only answers with the fork that landed.
    if (outcome.status === 'published') {
      await this.ensureOwnedScaffold();
      await this.resetWorkspaceBaseline();
    }

    const accepted = outcome.status === 'staged' || outcome.status === 'want' ? outcome : {
      status: 'published' as const, agentId: this.ctx.id.toString(),
      capabilityHash: await this.workspaceCapabilityHash(), forkPointMs: outcome.result.forkPointMs,
    };

    return { ok: true, ...accepted };
  }


  /** Webhook rows carry a signed delivery path minted here, never by a client; `url` is absent
   * when this deployment holds no route secret. */
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

  /** Not @callable: creation is step-up gated in the web and CLI trigger routes only. */
  async createDurableWebhook(opts: {
    label: string;
    auth_mode: 'hmac' | 'bearer' | 'mtls';
    secret?: string;
    accepted_content_type?: string;
    rate_limit_per_min?: number;
  }) {
    // Read before the row is written: a trigger whose URL cannot be signed is unreachable.
    const routeSecret = webhookRouteSecret(this.env);

    if (routeSecret === null) throw new KinuError('unavailable', WEBHOOK_ROUTE_UNAVAILABLE);
    const now = Date.now();
    // Core decides and stores the secret; an hmac/bearer trigger without one refuses every delivery.
    const webhook = await registerDurableWebhook(this.triggerRegistry, this.webhookSecrets, opts, now);

    return {
      trigger_id: webhook.trigger_id,
      url: await webhookRoutePath(routeSecret, {
        workspaceName: this.name, triggerId: webhook.trigger_id,
      }),
      auth_mode: webhook.auth_mode,
      // The secret is returned once here and never again.
      secret: webhook.secret,
    };
  }

  /** Revoke a trigger and delete its plaintext secret in the same host call.
   * `caller` has no default: operator route and model's `agent.cancelSchedule` differ in authority. */
  async cancelTrigger(trigger_id: string, caller: TrustLevel) {
    return cancelTrigger({ registry: this.triggerRegistry, trigger_id, now: Date.now(), caller, secrets: this.webhookSecrets });
  }

  async createTimerTrigger(opts: Parameters<typeof createTimerTrigger>[1]): Promise<{
    id: string; kind: 'timer_cron' | 'timer_oneshot'; nextFireAt: number | null;
  }> {
    return await createTimerTrigger(this.triggerRegistry, opts, Date.now());
  }

  /**
   * Auto-GEPA tick, once per completed turn. Counts completed non-plan turns from durable
   * `turn_end` rows (survives eviction); runs when the cadence is due and no pending is mid-shadow.
   */
  protected async maybeRunAutoGepa(
    /** Stable tick identity keying the prompt-section lane so a replay finds it advanced.
     * Absent when no durable obligation backs the call; then nothing is keyed. */
    tick?: string,
  ): Promise<void> {
    const everyN = this.config.getAutoGepaEveryNTurns();

    if (everyN <= 0) return;

    // An absent key is indistinguishable from an old disable; pin the default and record it.
    if (this.config.get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns) == null) {
      this.config.setAutoGepaEveryNTurns(everyN);
      void this.sql`INSERT INTO evolution_events (actor_id, type, message, created_at)
        VALUES (${this.actorHandle().actorId}, 'reflection', ${
          `Auto-GEPA enabled by the autonomous default (every ${everyN} turns of new traces). ` +
          `A disable set before autonomy defaults flipped on was stored as "unset" and is ` +
          `superseded by this default: run setAutoGepa(0) to disable again.`
        }, ${Date.now()})`;
    }

    // One cadence pass at a time per activation; concurrent passes would race proposals.
    // Per-tick tombstones cannot separate an interrupted run from this activation's live one.
    if (this._gepaTickRunning) return;
    const recent = listGepaRuns(this.boundSql, this.actorHandle(), 1)[0];

    // A `running` row is an interrupted pass that is owed, not a cadence watermark.
    if (recent?.status !== 'running') {
      const sinceTs = recent ? new Date(recent.startedAt).toISOString() : null;

      if (this.eventRecorder.completedWorkTurns(sinceTs) < everyN) return;
    }

    // Prompt sections are the only automatic lane: the chat turn does not run `scaffold/agent.js`.
    // Scaffold GEPA runs only via the manual `runScaffoldGepaOptimization` RPC.
    const lane = tick === undefined ? undefined : `${this.name}:${tick}`;
    this._gepaTickRunning = true;

    try {
      await oncePerTick(this.boundSql, this.actorHandle(), { scope: PROMPT_SECTION_LANE, tick: lane, workspace: this.name },
        () => this.advancePromptSections());
    } finally {
      this._gepaTickRunning = false;
    }
  }

  /** Cadence pass live in this activation; eviction clears it and the durable `running` row remains. */
  private _gepaTickRunning = false;

  /** Advance the evolved-prompt-section loop one step; policy lives in core's `advancePromptSectionLane`. */
  protected async advancePromptSections(): Promise<void> {
    // Awaited so the cadence effect holds its row open; a detached lane could be cancelled by eviction.
    // Failure is absorbed: the lane is opportunistic and the next cadence tick retries it.
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
   * Open one refinement; returns the durable request at `requested` — the refiner runs
   * on the off-turn cadence pass. The nudge is detached; eviction only costs an unfinished step.
   */
  @callable()
  async requestRefinement(opts?: {
    turnIds?: string[]; scope?: RefinementScope;
  }): Promise<RefinementRequestView> {
    const view = await requestOwnerRefinement(this.refinementDeps, opts);
    void refinementPass(this.refinementDeps)
      .catch((...rejection: [unknown]) => diagnostics.failure('refinement.lane_failed', toKinuError({
        doing: 'advancing the continual-refinement lane',
        cause: rejection[0],
        otherwise: 'unavailable',
      }), { workspace: this.name }));

    return view;
  }

  /**
   * Owner decision on one staged edit; the only path by which a proposed skill becomes trusted.
   * `interactive` in the RPC gate and absent from model-facing tools, so agent bytes cannot self-authorise.
   */
  @callable()
  async decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult> {
    const result = await decideRefinementRoute(this.refinementDeps, input);

    // An approval changes the next prompt and its `allowed_tools`, so the cached tool surface is dropped.
    if (result.ok) {
      this._cachedTools = null;
      this._cachedToolsKey = '';
    }

    return result;
  }

  /**
   * The whole staged file for one edit plus the digest a decision must quote back.
   * `interactive`: carries proposed instruction bytes. Never truncated; the modal renders it.
   */
  @callable()
  async showRefinement(requestId: string, routeIndex: number): Promise<StagedSkillResult> {
    return showRefinementRoute(this.refinementDeps, { requestId, routeIndex });
  }

  /** Refinements newest first plus the debt that would open the next one (`/refine` with no args). */
  @callable()
  async listRefinements(limit = 20): Promise<{
    requests: RefinementRequestView[]; debt: EvolutionDebt;
  }> {
    return listRefinements(this.refinementDeps, limit);
  }

  /** Called by `webhookDeliveryRoutes` so publish + dedupe run atomically in this DO. */
  async acceptWebhookDelivery(opts: WebhookDelivery): Promise<WebhookDeliveryResult> {
    return acceptWebhookDelivery({
      triggers: this.triggerRegistry,
      log: this.eventLog,
      vfs: this.rt.storage.vfs,
      secrets: this.webhookSecrets,
      sql: this.ctx.storage.sql,
      onAdmitted: () => { this.orch.scheduleDrain(); },
    }, opts);
  }

  /**
   * Container ingress via `src/egress/outbound.ts`; runs here so publish + dedupe are atomic.
   * `launchingHeadTrust` is set here, never read off the wire: the container is least trusted.
   * `waitUntil` is a no-op in a DO, so the write is awaited in this invocation; retry is the recovery.
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
   * Container host reports its persistence failed: a blocker, so it uses the signal seam, not the hub.
   * Plain method (not `@callable`): only another DO calls it. `waitUntil` is a no-op in a DO, so work
   * happens in this invocation; the incident id makes caller retries safe.
   */
  async acceptSandboxLifecycleFailure(body: JsonValue): Promise<SandboxLifecycleFailureResult> {

    return acceptSandboxLifecycleFailure({
      sql: this.boundSql,
      inbox: this.orch.inbox,
      // The workspace name is the only dimension the lifecycle module cannot know.
      recordRecovery: (row) => { recordSandboxRecovery(this.env, { workspace: this.name, ...row }); },
      logActivity: (event, detail) => this.logActivity(event, detail),
    }, body, Date.now());
  }

  private _webhookSecrets: WebhookSecretStore | null = null;
  /** Deliberately not reachable over RPC: secret material must never be readable over the websocket. */
  private get webhookSecrets(): WebhookSecretStore {
    this._webhookSecrets ??= createWebhookSecretStore(this.ctx.storage.sql);

    return this._webhookSecrets;
  }

  /** Peer-agent ingress via cross-DO RPC; ownership/grant checks run receiver-side. */
  async receivePeerMessage(msg: PeerMessage): Promise<ReceiveResult> {

    return this.peerHub.receive(msg);
  }

  /** Null means unclaimed or no profile email. A failed lookup must throw, not read as null
   * and silently refuse the owner's own mail. */
  private async getOwnerEmail(): Promise<string | null> {
    if (!this.getOwnerUserId()) return null;
    const { stub, caller } = await this.userHub();

    return (await stub.getProfile(caller))?.email ?? null;
  }

  private _emailInbox: EmailInbox | null = null;
  /** Held across the activation, like the in-memory inbound rate window it owns. */
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

  /** Pre-parse sender check so unauthorized senders cannot force a MIME parse; admits nothing,
   * the delivery re-checks. */
  async authorizeEmailSender(from: string): Promise<{ authorized: boolean; reason?: string }> {
    return this.emailInbox.authorizes(from);
  }

  /** Email counterpart of acceptWebhookDelivery: trust gate, publish, and reply thread run here
   * atomically. Receipt is awaited (floating promises die on eviction) and sent only on fresh admission. */
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

  async getEmailIngress(): Promise<{ address: string | null; allowlist: string[]; notifications: boolean }> {
    const domain = this.env.EMAIL_DOMAIN;

    return {
      address: domain ? agentEmailAddress(this.name, domain) : null,
      allowlist: readEmailAllowlist(this.triggerRegistry),
      notifications: this.config.getEmailNotificationsEnabled(),
    };
  }

  /** Owner's verified address is always allowed; an empty list revokes the email_route trigger.
   * Reached only through the owner-authenticated + step-up route. */
  async setEmailAllowlist(allow: string[]): Promise<{ allowlist: string[] }> {
    return setEmailAllowlist(this.triggerRegistry, allow, Date.now());
  }

  async setEmailNotifications(enabled: boolean): Promise<{ notifications: boolean }> {
    this.config.setEmailNotificationsEnabled(enabled);

    return { notifications: this.config.getEmailNotificationsEnabled() };
  }

  /** Skipped when notifications are off, platform pieces are missing, or an operator socket is live
   * (email is the away channel, not a duplicate feed). */
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

  /** Newest first; returns bare rows, not an envelope. Reachable via CLI RPC with no route in the
   * path, so `boundEventQuery` enforces the limit ceiling here. */
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

}

/** Cursor is client-supplied: anything malformed starts a fresh archive instead of reaching the query. */
function parseArchiveCursor(value: ArchiveCursor | undefined): ArchiveCursor | null {
  const parsed = v.safeParse(ArchiveCursorSchema, value);

  return parsed.success ? parsed.output : null;
}
