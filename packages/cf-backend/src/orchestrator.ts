import { exists as nimbusExists } from '@nimbus-sh/core/vfs/vfs.js';
import { objectNamed, ownerCaller, GitHubFactSchema, McpToolSurfaceSchema, actorPolicy, AgentDeliveries, AgentStops, DeliveryCoordinator, pendingEventsDelivery, wordsRefusal, deliveryMetadata, actorReach, type CrossedDelivery, type Delivery, type DeliveryAnswer, type AgentOrchestratorDeps, type SendLanding, readGitHubActivity, readGitHubRemotes, recordGitHubActivity, recordGitHubObservations, gitHubRefreshAsk, WORKSPACE_ROOT, effectiveRoleCatalog, narrowToolSurface, storeRevision, type GitHubFact, type WorkspaceGitHub, type WorkspaceGitHubView, type WorkspaceOverviewInputs, type Fact, AGENT_CONFIG_KEYS, turnAttemptOf, readMemoryTail } from '@kinu.run/core';
import { preapproveSlateEffect, ROOT_SLATE_CALLER, slateAnswer, slateRevision as builtRevision, type PartRunAnswer, type PartRunRequest, type PartShowRequest, type SlateCaller, type SlateCallFrom } from '@kinu.run/core/slates';
/**
 * OrchestratorAgent: the workspace-facing actor on top of ActorAgent (actor-agent.ts).
 * Tool factory, system prompt, and crafted-tool injection live in @kinu.run/core, shared with the CLI.
 */

import { Agent, callable, type AgentContext, type Connection, type ConnectionContext } from "agents";
import { ORCHESTRATOR_RPC_SURFACE, ORCHESTRATOR_STARTED_RPC } from "./rpc-surface";
import { sealRpcSurface } from '@nimbus-sh/fabric/sealed.js';
import { ActivationGate, reportSocketCallFailures, startBeforeRpc } from "./activation-gate";
import { supervisorEsbuildService } from "@nimbus-sh/worker/facet-host";
import { listPortReservations } from "@nimbus-sh/worker/port-capability";
import { KINU_TIMER_JOB } from "./wake-jobs";
import { NimbusTasks } from "./nimbus-tasks";
import {
  runExperienceAction, type ExperienceActionDeps, type ExperienceActionInput,
  ArchiveCursorSchema,
  createWorkspaceForkSink, createWorkspaceForkSource, workspaceSoul, workspaceArchiveStore, writeWorkspaceSoul,
  explorationActorKey, writesSnapshotRows,
  HeadController, REAL_CLOCK, runHeadSplit, SubagentRosterStore,
  EventLog, actorReferenceOf, stoppedBelow, stopAgentsBelow,
  artifactOverrides, currentArtifacts,
  agentsActionsFor, agentsProfileContext, betaSwarms, buildActorTools, BACKGROUNDABLE_TOOLS,
  vfsTurnSkills, listSharedSkills, type SharedSkillsListing, conversationKey, captureOperationProfile, type RunTurnSources,
  describeAgentTools, inTurnSurface, turnLedgers, type TurnLedgers, surfaceReach, turnArtifacts, withToolText,
  BUILTIN_TOOL_NAMES, codemodeCapabilitiesFor, agentRoleSwitch, currentOperationProfile,
  ownProfileChoices, pruneTurnReceipts, remoteReceipts, type SeatedActor, type SettledRun, type SurfaceReach, type ExecutionLane, type OperationProfile, type CodemodeSurface,
  type SubagentReportLedger, type ActorToolsets,
  invocationBackgroundPolicy, endedStepLoopJobs, inlineResultInbox, type ActorJobs, type BackgroundJobRunner, type JobAuthority,
  teamToolDepsFor,
  peersToolDeps,
  type ActorHost, type ActorToolsetDeps, type AgentsToolDeps, type BuiltinStoreInputs, type ServedStores,
  type BoundActor, type HeadInput,
  type HeadJournalPort, type HeadSplitRequest, type HeadSplitResult,
  type LoopOrigin, type NodeHomeHost,
  type TeamToolDeps, type WorkspaceActor, type WriteObserver,
  actorEnded, actorStanding, isSubagentOrigin,
  whenActorTakesInput, MEMORY_PATH,
  type PlanReview, actorReadHandle, ownerLaneDeclarations, type IntentResult, type OwedIntent, type OwedOwnerIntent,
  createEmailThreadDispatcher,
} from "@kinu.run/core";
import { PROJECT_OWNER_CRED, bookmarkNow, censusOf, missingBytes, requireOps, restartedForRestore, restoreArmed, type ArmedRestore, type MissingBytes, type RestoreTarget, WorkspaceLayoutSchema, type BlueprintSchedule, type OpsCaller, type TablesAnswer, type WorkspaceLayout, type WorkspaceSeed } from '@kinu.run/core';
import { createHostedWorkspace, type HostedBox, type HostedWorkspace, type WorkspaceTerminal } from "./workspace-host";
import { WorkspaceExecutors, type ExecutorFileChunkRead, type ExecutorFileChunkWrite } from "./workspace-executors";
import { HeldRead } from "./account-reads";
import type { WorkspaceEgress } from "@nimbus-sh/core/_shared/workspace-network.js";
import { agentFacet, agentStateShellId, AgentMemory, AgentWorkspaceHost, headDeltas, jsonLines, uiChunks, type AgentFacetPlacement } from "./agent-facets";
import type { AnswerMetadataReply } from "./agent-facet/agent-turn";
import { openAnalyticsWindow } from "@kinu.run/core/analytics";
import { DrawnStepSchema } from "./chat-transport";
import { AgentIsolateSlots } from "./dynamic-worker-slots";
import { providerBindingsOf, routedModelReads, userCredentials } from "./providers/agent-registry";
import { AgentTurns } from "./agent-turns";
import { AgentWakes } from "./agent-wakes";
import type { AgentTurnActivity, AgentSnapshot, ChatWindow, RunEventRecorder, StoredRow } from '@kinu.run/core';
import type { SerializedMessage, WebSearchProvider } from '@kinu.run/core';
import { serveNodeProgramCall, type NodeProgramAnswer } from './node-program';
import type { EgressPrincipal } from '@kinu.run/core';
import type { CFRuntime } from './runtime';
import { callOperation, listOperations, type OperationCaller, type OperationListing, type OperationResult } from '@kinu.run/core';
import type { AgentFacet, AgentFacetCalls } from "./agent-facet/agent-facet";
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  isWorkspaceTerminal, WORKSPACE_SHELL_SESSION, WORKSPACE_TERMINAL_PATH, WORKSPACE_TERMINAL_TAG, workspaceSessionOf, workspaceSessionTag,
  WorkspaceSessionRecordSchema, type WorkspaceSessionRecord,
} from "@kinu.run/core";
import { ShareViewerClaimSchema, type ShareViewerClaim } from '@kinu.run/core';
import {
  AgentOpenTurns, AgentReports, TurnFences, type AcceptedReport, type AgentOwes, type RunEndReport, type OpenWork, announcementOf, RECOVERY_BACKOFF_CEILING_MS, type SentWords, type AgentOpenTurn, CHAT_SESSION_ID, steerSkillsBlock, subagentTurnContext, type SessionEvent, type SessionTranscript, type TurnEndEvent,
  isBuiltinSkillFile,
} from '@kinu.run/core';
// Main actor's payload plane on both fork halves: the carried conversation references
// payload files by absolute path, and the fork is a cut of the main actor's conversation.
import {
  agentArtifactDirectory, agentHome, agentIdentity, agentNameOfUid, confineAgentTmp, isViewerProcess, MAIN_AGENT, provisionAgentHome,
  VIEWER_HOME_NAME, viewerCred, withViewerPrincipal, type ViewerPlace,
} from '@kinu.run/core';
import { contextFill, type AgentStanding, type AgentStandingReport } from '@kinu.run/core';
import type { ChatWire } from './chat-transport';
import { SLATE_SHARE_PATH, liveShareEntryPage, slateShareUrl, viewerEntryUrl } from './slate-share-route';
import { controlPlaneStub, hasControlPlane } from './control-plane/stub';
import { serialQueue } from '@kinu.run/agent-utils';
import { internalCaller } from '@kinu.run/core/control-plane';
import { isNavigation, nimbusPreviewUrl, previewEntryUrl, previewRefusalText, WORKSPACE_PREVIEW_PATH, type PreviewAccess, type PreviewVisit } from "./nimbus-route";
import { PREVIEW_SELF, shareViewerKey } from "./viewer-pass";
import type { SlateHost } from "./slates/host";
import type { UserDO } from "./user/user-do";
import type { PartViewer } from "./slates/part-runs";
import { WorkspaceSlates } from "./workspace-slates";
import type { McpToolSurface } from "./user/mcp-servers";
import { closeWorkspaceBrowserSessions, initBrowserSessionTable, ownsBrowserSession } from "@kinu.run/core";
import { browserCamera, initSlatePictureTable, picturePrefix, shareCaptureUrl, SlatePictures, type PictureCapture } from "./slates/pictures";
import { initSlateBuildTable } from "@kinu.run/core/slates";
import type { BlueprintReading, ShareUser } from "@kinu.run/core/slates";
import type { MessageBlock } from "./slates/sources";
import {
  createWorkspaceActorHost, hostedActorPlacement, HostedActorHomes, type CFSeat, type WorkspaceHostSeams,
} from "./actor-hosting";
import {
  hostedRetryTools, hostedSubagentRuntime, relayHostedReport, retireStalledTask,
  hostedOwedReport, hostedParentReport, hostedAutoTitle, reclaimSettledExplorationActors,
  ownerAnswersWait, type ActorSurface, type HostedActorSeams, type SourcesTurn, type SurfaceTurn, type ToolScope,
} from "./hosted-actors";
import { createCodemodeToolFactory } from "./codemode-tool";
import { compactionDiagnostics, hostedActorCompaction } from "@kinu.run/compaction";
import { publishSubagentReport, temporaryRunSettles, type ReportDeps } from "@kinu.run/core";
import type { ToolSet } from "ai";
import {
  webhookRoutePath, webhookRouteSecret, WEBHOOK_ROUTE_UNAVAILABLE,
} from "@kinu.run/core";
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SupervisorOpResult } from '@kinu.run/core/workspace';
import { openingList, TURN_CLAIM_FRAME, type AccountSpend, type ActivitySnapshot, type TabPresence, type TurnClaimState } from "@kinu.run/core";
import type { SubagentView } from "@kinu.run/core/protocol";
import { markStoreChanged, nextAlarmTime } from '@kinu.run/core';
import { accountDeps, armedWarms, CacheWarmingLane, CacheWarmStore } from '@kinu.run/core';
import {
  EvolutionEngine, initWorkspaceActorTable, WorkspaceActorDirectory, ChildActorOperationSchema, type ActorHandle, type ActorReference, type ChildActorOperation, type ActorDirectoryResult,
  readActivityLog, initActivationTable, listActivations, recordActivation, facetNamesGiven, type Activation,
  summarizeSteps,
  // Whole-workspace spend by producer; `summarizeSteps` covers only this agent's turns.
  workspaceSpend, headStepSources, mergeAccountSpend, type SpendLedger,
  initWorkspaceSchema,
  tableExists,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS,
  // Declared reach axis; getToolDescriptions reports it rather than guessing from ToolSet keys.
  TOOL_REACH,
  forkWorkspace, ForkTargetWriter, ForkTransferReceiver,
  type ForkTransport, type ForkFrame,
  readWorkspaceArchivePage, type ArchiveAgentSource, type ArchiveCursor, type ArchivePage,
  nanoid, type HeadRunView, BACKGROUND_FIBER_PREFIX, parseJsonValue,
  ForkNotices, forkNoticeDeliveries, initForkNoticeTable,
  appendMemoryNote,
  parseMemoryNotes,
  type SlateCallRequest, type SlateCallResult, type SlateSurfaceResult, type SlateOperation, type SlateFileChange, SharedSlateFilesSchema, type SlateReadModel, SLATES_CHANGED_EVENT, SLATES_CHANGED_METADATA_KEY, slatesToPreview,
  type LiveShareRecord, type OwnedLiveShare, type LiveShareModeBody, type LiveShareListingBody, type RoomService, type SlatePreapprovals, type SlatePreapprovalWithdraw,
  type BlueprintBundle, type BlueprintFork, type SlateAnswer, type SlateShareRecord,
  getEvolutionStatus, listScaffoldVersions,
  previewScaffoldLive,
  activateDreamSkills, activateReplayedScaffold, dreamSkillsHidden, idleDream, listRefinements, refinementPass, requestOwnerRefinement,
  type RefinementListing,
  type RefinementRequestView, type RefinementScope,
  runScaffoldOnce, scaffoldRunReport, type ScaffoldRunReport,
  type ScaffoldVersionView, type EvolutionStatus,
  scaffoldSource,
  type RunEvent, type RunEventQuery, type StoredRunEvent,

  listProposedTasks, updateProposedTaskStatus,
  searchMemoryHits, type HybridHit,
  type BackgroundJob, type ListedBackgroundJob, TriggerRegistry, ReplyChannelStore, dispatchEmailRepliesForTurn,
  type ReasoningEffort, type ShellApprovalMode,
  type AlarmScheduler,
  qualitySeries, qualityWindow, type QualityDay, type QualityWindow, listThumbs, craftPreference, craftPreferences,
  revertChangelogEntryById,
  type ChangelogEntry, type ChangelogRevertResult,
  listAlternateTakeSets, latestAlternateTakeSet,
  type AlternateTakeSet, type TakePickOutcome,
  startBranchHead, newBranchId, admitBranch, type BranchTurnResult,
  STEER_BRANCH_RUN_ID_PREFIX,
  type PendingBranch, type BranchStatusEvent,
  readWorkspaceWork, hasWorkspaceWork, WORK_TAB_JOBS, type WorkspaceWork, inspectWork, type InspectedWork, addressedBlock, type EphemeralSlateAddress,
  measuredAt, readWorkspaceAgents, recordAgentFigures, reportedAgentFigures, type AgentFigures, type AgentAnswer, type ConversationTurnPair, type PanelAgent, type AgentConfigStore, type AskingAgent,
  type PeersToolDeps, type PeerSpawnOutcome, type PeerSendOutcome,
  type EnqueueTurnResult, type ProgrammaticTurn, turnTags,
  missionOf, summarizeSoul, workspaceGenesisSignal, isPlaceholderMission, drawWorkspaceLogo,
  // Recovery has no live turn, so the owed answer is read from the transcript.
  type PromptIdentity, UNTITLED_WORKSPACE_NAME,
  checkpointAvailability, fileCheckpointListing, fileRestorePlan, fileCheckpointRestore, deviceFileCheckpoints,
  type CheckpointAvailability, type FileCheckpointListing, type FileCheckpointReads,
  type FileRestorePlan, type FileRestoreResult,
  SleepTimeLane, initSleepTimeTables,
  // Core owns the ingress gates; this actor owns the transports in front of them
  // (DO alarm, Worker webhook + email routes, cross-DO RPC).
  acceptWebhookDelivery, registerDurableWebhook, createWebhookSecretStore,
  acceptContainerEvent, type ContainerEventResult,
  initWebhookIngressTables,
  type WebhookDelivery, type WebhookDeliveryResult, type WebhookSecretStore,
  createTimerTrigger, cancelTrigger, listTriggers, fireDueTriggers, retimeDailyTrigger, type TrustLevel,
  WatchClaims, watchProviders, checkAnswerOf, type WatchOutcome, type WatchCheck,
  type TriggerView,
  type MailAdmission, type MailArrival, type HandedMail, handedMailSignal, spillEventContent, unreadMailForTurn, MailTriageLane, triageMail,
  PeerHub, type PeerMessage, type ReceiveResult,
  getAgentStatus, getToolList, readLatestSearchTree, readSearchTree, type ActorSnapshot,
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
  getRunTimeline, RUN_TIMELINE_MAX, boundedInt, type TimelineSpan,
  getRunEvents, getRunEventText, type RunListEntry, type RunSummary,
  type TurnRequestIndex, type TurnRequestPage,
  decodeRecordedTurns, type RecordedTurn,
  LiveReadsNotice, readsMovedByFiles, readsOfTables, readsWrittenBy, ROSTER_READS, sameDeviceStatus, type LiveRead,
  CHANGES_MOVED_EVENT, ChangeSetCache, getWorkspaceDiff, getExecutorDiff, resetWorkspaceBaseline, restoreWorkspaceBaseline,
  type ExecutorDiffResult, type WorkspaceBaselines, type WorkspaceDiffResult, type WorkspaceReviewResult,
  initChangeNotesTable, readChangeNotes, saveChangeNotes, sendChangeNotes, deliverOwedChangeNotes, owesChangeNotes, type ChangeNotesChat,
  initTurnBranchesTable, TurnBranchesStore, branchHeadId, TurnSurface, authoredTurnMetadata, type ActorReach, type ChatTurnInput,
  type ChangeNote, type ChangeNotesResult, type NotedChanges,
  diffLines, type DiffLine,
  listEnvironments,
  type ExecutorTextFile, type FilesPage, type FilesRequest, type ExecutorWriteResult,
  cancelBackgroundJob, clearBackgroundJobs, dismissBackgroundJob,
  listBackgroundJobs, retryBackgroundJob, reconcileInterruptedForks,
  jobRedriveResumeGate, resumableForkRoots,
  type CancelWorkOutcome, type RetryOutcome,
  getAlwaysActiveSkills, getEvolutionConfig, getProviderAccounts, getReasoningEffort,
  getShellApprovalMode, getShellApprovalGrants, revokeShellApprovalGrants,
  setAlwaysActiveSkills, setEvolutionConfig,
  setModel, setProviderAccount, setReasoningEffort, setShellApprovalMode,
  type EvolutionConfigView,
  getEvolutionChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
  JsonValueSchema, type JsonValue, type JsonObject, type KinuEvent,
  EVENT_VARIANTS,
  boundEventQuery,
  type WorkMode, WorkModeSchema,
  WORKSPACE_RUN_ID, activeOperationProfile, SLATES_ROOT,
  buildWorkspaceOverview, OverviewPush, type WorkspaceOverview,
  projectJsonValue,
} from "@kinu.run/core";
import * as v from 'valibot';
import { Hono } from 'hono';
import { beneath, rawPath, rethrow } from './api/context';
import { experienceLibraryOver } from './user/experience-library';
import { ownedByAnotherAccount } from './user/workspace-ownership';
import { workspaceOwner, type LiveShareReading, type SlateEditor, type WorkspaceOwnerRpc } from './workspace-owner-rpc';
import {
  ActorAgent,
  ALARM_PROGRAM_WAIT_MS,
  EVOLUTION_LANE_FIBER,
  readTurnContinuity,
  unownedWorkspace,
  type ActorDynamicContextExtras,
  type HostedOwnerQuestions, type HostedPlanReviews,
  type UntimedArms, type OwnToolsHeld,
} from "./actor-agent";
import {
  recordJobSettled, recordSandboxRecovery, type AgentKind,
} from "@kinu.run/core/analytics";
import {
  agentSelfHost, actorNamespaces, SURFACE_POLICY, type SurfaceActor, type AgentSelfHost, type GoogleDeps, type SlateEffectVerdict, type MailDeps, type MailThreadSummary, googleConnectionClient, type OwnerWaitsHost,
  ownerWaits, ownerWaitsHost, wakeMetOwnerWaits, type OwnerWaitReader, type ScopedOwnerWait,
  AgentWorkspaceStore, createAgentWorkspace, type AgentWorkspaceDeps,
  DeviceConsentRegistry, DeviceConsentStore,
  type DeviceConsentAnswer, type DeviceConsentVerdict, type AgentSignal, bearWorkspaceIdentity,
  type DeviceConsentRequest, type PendingDeviceConsent,
  DeferredApprovalQueue, DeferredApprovalStore, decideDeferredApprovals, performBoundWrite, ParkedWriteFiles,
  reviewParkedWrite, type ParkedWriteReview,
  type DeferredApproval, type DeferredApprovalAnswer, type DeferredApprovalChannel,
  type DeferredApprovalNotice, type ApprovalGrant,
  TURN_AUTHOR_METADATA_KEY,
  WorkspacePlanReferenceSchema,
} from "@kinu.run/core";
import type { MctsSearchRunSummary, SubagentInspectionRequest, SubagentInspectionResult, WorkspacePlanReference } from "@kinu.run/core";
import { Cause, Effect, Exit, Result } from 'effect';
import { attempt, attemptInItsWords, authoredRefusal, CODE_IS_REFUSAL, diagnostics, flight, hold, joining, KinuError, refusing, renderThrownChain, settle, settleSync, toKinuError, type ErrorCode, type Refusal, type ScopedSpan, logged, recording, settleLogged } from "@kinu.run/core/obs";
import { createCloudWorkspaceForUser } from "./user/workspace-create";
import type { NameOrigin } from "@kinu.run/core";
import { deliverCloudFork, type ForkFrameAck } from "./user/workspace-fork";
import { WorkspaceEmail } from "./workspace-email";
import { EmailOutbox } from "@kinu.run/core";
import {
  acceptSandboxLifecycleIncident, initSandboxLifecycleTable,
  type SandboxLifecycleIncidentResult,
} from "./sandbox-lifecycle";

import type { RestoreStatus, SessionRecord, StartAdmission, TerminalSession } from "@kinu.run/devbox";
import type { BoxSize } from "@kinu.run/devbox/sizes";
import { accountComputerSize, COMPUTER_SIZE_CONFIG_KEY, type ComputerSizeState } from "./computer-size";
import { readOutgoing } from "./mail/parse";
import type { ComputerSize } from "@kinu.run/core";
import { sandboxIdForWorkspace } from "@kinu.run/core";
import { forgetSandboxPreviews, sandboxPreviewExposures } from "@kinu.run/core";
import type { ExposedPortList } from "@kinu.run/core";
import {
  terminalEffect, declareTerminalRoster, isDefinitiveTerminalFailure, CompletedTurnSchema,
  branchesTerminalEffect,
  type HandedOffTurn, type CompletedTurn, type OpenedAt, type TerminalEffectTable, type TerminalTurnFacts,
  type TerminalTurnParts,
} from "@kinu.run/core";

const READS_BY_STATEMENT = new WeakMap<TemplateStringsArray, readonly LiveRead[]>();

const STALE_EVENT_DELIVERY_MS = 10 * 60 * 1000;

/**
 * Row budget per sweep activation: each item is a full inference turn. A full pass
 * answers truncated and the wake drains the rest on the next frame.
 */

const ANSWERED_TURNS_KEPT = 32;

const SANDBOX_STARTING = 'sandbox_starting';

const SANDBOX_REFUSED = 'sandbox_refused';

/** Smaller than the fiber sweep's row budget: each sealed head or re-pended lease costs a write and an event.
 *  A pass that fills a budget arms the maintenance wake. */
const ORPHAN_SEAL_MAX_ROWS = 256;

const WAKE_ARM_FAILURE = {
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

/** Chars a stored command keeps: a reload reads fifty whole, so at most 50 x 200,000 chars of up to three UTF-8 bytes,
 *  30 MB, beside the turn. It was a tenth of the 2 MB row (a 20 MB print once failed its write, SQLITE_TOOBIG) until
 *  the row rose to 8 MiB (2026-10-21), and stays: a reload's memory holds it, not the row. A stream is stored as far as
 *  a reload reads it, {@link EXECUTOR_OUTPUT_CLIP}, its printed length beside it. */
const EXECUTOR_COMMAND_CHARS = 200_000;

/** `stdout_len`/`stderr_len` are the streams' printed lengths, so a reader can tell a short command
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

/** agents 0.26's Lifecycle reads this back when `ctx.id` has no name; it outlives `destroy()`, so an alarm still owed builds the object. */
/** The terminals the person opened beside the workspace's own (`listWorkspaceSessions`): their keys and names. */
const WORKSPACE_SESSIONS_KEY = 'kinu:workspace-sessions';

const PERSISTED_NAME_KEY = '__ps_name';

/** An alarm phase's failure: marked on its span and recorded, so the tick goes on to its next phase. */
function phaseFailed(
  span: ScopedSpan,
  doing: { readonly doing: string; readonly otherwise: ErrorCode },
  record: (failure: KinuError) => void,
): (failed: Cause.Cause<unknown>) => Effect.Effect<void> {
  return recording(doing, (failure) => {
    span.fail(failure);
    record(failure);
  });
}

type SandboxBox = ReturnType<NonNullable<Env['KinuDevbox']>['getByName']>;

interface HostedTarget {
  readonly handle: ActorHandle;
  readonly entry: NonNullable<ReturnType<SubagentRosterStore['get']>>;
}

/** A turn's surface as its factory opened it, with what it reaches. */
interface OpenedSurface {
  readonly surface: TurnSurface;
  readonly reach: SurfaceReach;
}

/** What a turn's surface and a run's differ in; the rest is assembled alike. */
type AssembledSurfaceParts = Omit<ActorSurface, 'surface' | 'descriptors' | 'digest' | 'reads' | 'sources' | 'bind'> & {
  readonly sources: Omit<ActorSurface['sources'], 'wiredToolNames' | 'codemodeCapabilities'>;
  readonly codemodeCapabilities: ActorSurface['sources']['codemodeCapabilities'];
};

/** A turn's program namespaces, but `mail` where its owner holds no address to read. */
function withoutMailIf<P extends { readonly name: string }>(scope: Pick<ToolScope, 'withoutMail'>, namespaces: readonly P[]): P[] {
  return scope.withoutMail === true ? namespaces.filter((namespace) => namespace.name !== 'mail') : [...namespaces];
}

interface SourcePlanes {
  /** The owner's MCP descriptors, settled; null where no turn reaches them. */
  readonly descriptors: Promise<PromiseSettledResult<McpToolSurface>> | null;
  /** The hub's device check, which never rejects: a failure keeps the last snapshot. */
  readonly device: Promise<unknown>;
  /** The account's facts its turn reads once, which never rejects (a failed read is logged and answers none); null with
   *  no turn, whose every read asks. */
  readonly facts: Promise<readonly Fact[]> | null;
  /** Whether the owner holds a mail address, read once for its turn or run seat, which never rejects: null on a
   *  deployment with no mail, or where the read failed (logged), each of which offers mail as before. */
  readonly mail: Promise<boolean | null> | null;
  /** A turn's unread mail, read after {@link mail} says the owner holds an address; null with no turn. */
  readonly unreadMail: ReturnType<typeof unreadMailForTurn> | null;
  /** The shared Drive's skills root, listed for a turn; null with no turn. */
  readonly sharedSkills: SharedSkillsListing | null;
}

/** An assignment's delivery, as its metadata names it. */
const AssignmentMetadataSchema = v.looseObject({ kinuEvent: v.literal('subagent_task'), kinuMode: WorkModeSchema });

/** A revert's choice, as its dialog sends it: `chatOnly` keeps the computer's work and tells the agent of it. */
const RevertOptionsSchema = v.object({ chatOnly: v.optional(v.boolean()) });

type RevertOptions = v.InferOutput<typeof RevertOptionsSchema>;

/** A crossing as a producer that waits on it hears it: its value, or the agent's failure. The delivery stays owed either
 *  way the agent did not take it. */
function heard<A>(crossed: CrossedDelivery, value: (admitted: DeliveryAnswer) => A): Promise<A> {
  const answer = Promise.withResolvers<A>();

  if ('failure' in crossed) answer.reject(crossed.failure);
  else answer.resolve(value(crossed.admitted));

  return answer.promise;
}

/** A delivered run's end, as its charges are kept applied: by its turn and its run. */
function runEndKey(end: Pick<RunEndReport, 'id' | 'runId'>): string {
  return `${end.id}\u0000${end.runId}`;
}

/** At most this often an open makes a listed share's Gallery card be told its viewers again. */
const VIEWS_SYNC_MS = 60 * 60 * 1000;

/** An exact ask's verdict as an agent's call reads it: approved, or the approval it waits on. */
function exactAnswer(verdict: SlateEffectVerdict): { readonly outcome: 'approved' } | { readonly outcome: 'asked' | 'denied'; readonly approval: string } {
  return verdict.outcome === 'approved' ? verdict : { outcome: verdict.outcome, approval: verdict.action.id };
}

export class OrchestratorAgent extends ActorAgent implements WorkspaceOwnerRpc {
  private readonly addressedName: string;

  private readonly nimbusTasks = new NimbusTasks((task) => this.hostedWorkspace().onScheduled(task));

  /** Detached, so the wake's job never waits on the agent: what it owes comes back as its own answer. A wake that begins
   *  or ends moves the Agents panel, which reads an agent working while its wake stands: the rest that ends it crosses
   *  from the agent's isolate after its turn's close, and a page that read the close read the wake still standing. */
  private readonly agentWakes = new AgentWakes(async (actorId) => {
    this.detachOwned(logged('subagent.agent_wake_failed', { doing: "waking an agent's own isolate for what it owes", otherwise: 'io' },
      () => this.wakeAgent(actorId, { recover: true }), { workspace: this.name, actor: actorId }));
  }, () => { this.liveReadsMoved(['listWorkspaceAgents']); });

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.nimbusTasks);
    this.lifecycle.use(this.agentWakes);
    const name = ctx.id.name ?? this.recordedName();

    if (name === undefined) {
      throw new KinuError('unsupported', 'This workspace object was reached by id before any named start recorded its name; address it by name.');
    }

    this.addressedName = name;
    sealRpcSurface(this, ORCHESTRATOR_RPC_SURFACE);

    // Storage a release left behind is brought to this build first, by the root's whole init: the webhook secrets too,
    // which a workspace makes at its first trigger.
    const secrets = tableExists(this.boundSql, 'webhook_secrets');

    this.repairStorage(() => {
      this.initBaseTables();

      if (this.nimbusSibling) return;
      this.initTables();

      if (secrets) createWebhookSecretStore(this.ctx.storage.sql);
    });

    // Tables only, so a call after `destroyAgent` makes no workspace. Native RPC runs no `onStart`.
    if (!this.nimbusSibling && this.storageRefusal === undefined) {
      this.initTables();

      if (this.workspaceBorn()) this.registerCompactionExtension();
    }

    this.installClientMessageGate();
    const gate = new ActivationGate(() => this.storageRefusal);
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
    if (!tableExists(this.boundSql, 'workspace_identity')) return this.ctx.storage.kv.get<string>(PERSISTED_NAME_KEY);
    const name = this.sql<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0]?.name;

    if (name !== undefined && this.ctx.storage.kv.get(PERSISTED_NAME_KEY) !== name) {
      this.ctx.storage.kv.put(PERSISTED_NAME_KEY, name);
    }

    return name ?? this.ctx.storage.kv.get<string>(PERSISTED_NAME_KEY);
  }

  override get name(): string {
    return this.addressedName;
  }

  override async alarm(): Promise<void> {
    if (this.storageRefusal === undefined && !this.nimbusSibling && !this.workspaceBorn()) return;
    await super.alarm();
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
    this._liveReads ??= new LiveReadsNotice((frame) => { this.broadcastToActor(null, JSON.stringify(frame)); }, (flush) => { this.deferLiveReads(flush); });

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
    // Before it runs: a statement that throws may still have written.
    if (writesSnapshotRows(strings)) this._heldSnapshots?.clear();
    this.heldWritten(strings);
    const rows = super.sql<T>(strings, ...values);
    let reads = READS_BY_STATEMENT.get(strings);

    if (reads === undefined) {
      reads = readsWrittenBy(strings.join('?'));
      READS_BY_STATEMENT.set(strings, reads);
    }

    this.liveReads.moved(reads);

    return rows;
  }

  /**
   * The workspace's egress: its commands' and programs' requests and sockets leave through Kinu's, as the sandbox's do,
   * minted with this workspace's owner as it opens, and for a process an agent started, with that agent
   * (`actingAgent`), so what the egress records names it. Nothing is asked of the vault here: the egress asks the
   * owner's object, which reads this workspace's grants, for a request that names a placeholder. A workspace with no owner keeps the isolate's
   * own network.
   */
  private workspaceEgress(actorId?: string): WorkspaceEgress | undefined {
    // A store refused at the reset runs nothing that reaches the network (its turns, chat and requests are refused), and
    // its export reads files: it needs no egress, and its tables are not read for an owner.
    if (this.storageRefusal !== undefined) return undefined;
    const ownerUserId = this.getOwnerUserId();

    if (ownerUserId === null) return undefined;

    return this.ctx.exports.KinuEgress({ props: { workspaceName: this.name, ownerUserId, ...(actorId !== undefined && { actorId }) } });
  }

  /**
   * The egress of a process a share's viewer started (`isViewerProcess`): it names no owner, so no request of it is
   * ever given a secret, and it is minted even for a workspace with an owner, whose own egress it must never fall to.
   */
  private viewerEgress(): WorkspaceEgress {
    return this.ctx.exports.KinuEgress({ props: { principal: 'viewer', workspaceName: this.name } });
  }

  /**
   * The agent a workspace process acts for: the one whose own credential it runs under, or the workspace's own agent
   * for a session-user process an exec named (the owner's terminal names none). Null when it acts for nobody named.
   */
  private actingAgent(process: { readonly cred: VfsCred; readonly execId?: string }): string | null {
    if (process.cred.uid === CRED_SESSION_USER.uid) return process.execId === undefined ? null : this.actorHandle().actorId;
    const name = agentNameOfUid(this.ctx.storage.sql, process.cred.uid);

    return name === null ? null : this.workspaceActors().list().find((record) => hostedActorPlacement(record).homeName === name)?.actorId ?? null;
  }

  private hostedWorkspace(): HostedWorkspace {
    this._workspace ??= createHostedWorkspace({
      ctx: this.ctx,
      env: this.env,
      tasks: this.nimbusTasks,
      previewUrl: (port, capability) => nimbusPreviewUrl(this.env, this.name, port, capability),
      egress: () => this.workspaceEgress(),
      egressFor: (process) => {
        if (isViewerProcess(process, (uid) => agentNameOfUid(this.ctx.storage.sql, uid) === VIEWER_HOME_NAME)) return this.viewerEgress();
        const actorId = this.actingAgent(process);

        return actorId === null ? undefined : this.workspaceEgress(actorId);
      },
      onFilesChanged: (paths) => {
        if (this.deleting.signal.aborted) return;
        this.changes.touched(paths);
        this.liveReadsMoved(readsMovedByFiles(paths));
        // With no slate host loaded, no slate process or build runs here: the change moves only the build records.
        const ids = this.slateHosting.filesChanged(paths);

        if (ids.length === 0) return;
        markStoreChanged(this.ctx.storage.sql);

        this.noteTurnSlates('changed', ids);
        this.broadcastToActor(null, JSON.stringify({ type: SLATES_CHANGED_EVENT, ids }));
        this.overviewChanged();
      },
      onPortsChanged: () => {
        this.liveReadsMoved(['getExposedPorts', 'listSlates']);
        this.detachOwned(Effect.promise(() => this.servingMoved()));
      },
      ensureSlate: async (owner) => (await this.slates()).controller.ensureDurable(owner),
      // A process holds a port only once the host that runs it is loaded.
      slateInvocation: (port, socket) => this.slateHosting.loaded?.slateInvocation(port, socket) ?? null,
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

  /** When each listed share's Gallery card was last told its viewers, in this object's life (`openLiveShare`). */
  private readonly viewsSynced = new Map<string, number>();

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
        const listing = await (await this.slates()).controller.list(ROOT_SLATE_CALLER);

        return new Set([...listing.slates, ...listing.problems].map((slate) => slate.id));
      },
      // A listed public share's view: entered as a visitor with no account enters its host, at its publication now.
      share: async (id) => {
        const { controller } = await this.slates();
        const entry = controller.live.galleryCapture(id);

        if (entry === null) return null;
        const publication = builtRevision(controller.builds, entry.slate) ?? '';
        const host = await slateShareUrl(this.env, this.name, entry.handle);

        return host === null ? null : { url: shareCaptureUrl(host), publication, held: entry.held };
      },
      camera: () => browserCamera(browser),
    };
  }

  protected workspaceServing(): ReturnType<HostedWorkspace['serving']> {
    return this.hostedWorkspace().serving();
  }

  /** Each agent's view of the workspace's box, where a share's viewer's call runs as the viewer (`withViewerPrincipal`). */
  protected workspaceBox(shellId: string): HostedBox {
    const workspace = this.hostedWorkspace();
    const box = workspace.box(shellId);

    return { ...box, ...withViewerPrincipal({ owner: box, viewer: workspace.viewerBox(shellId) }, () => this.viewerPlace()) };
  }

  /** The viewer's own uid, home and `/tmp` on the box, provisioned as each of its calls asks (the first allocates them). */
  private async viewerPlace(): Promise<ViewerPlace> {
    const { root, confiner, sql } = await this.facetHomeHost();
    const identity = agentIdentity(sql, VIEWER_HOME_NAME);

    return {
      home: provisionAgentHome(root, VIEWER_HOME_NAME, identity),
      tmp: confineAgentTmp(confiner, VIEWER_HOME_NAME, identity),
      cred: viewerCred(identity),
    };
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

    if (!deps) return { error: unownedWorkspace().message };

    return runExperienceAction(deps, { value: input });
  }

  /**
   * Pid, writer incarnation and lease owner are stamped by the supervisor entrypoint, never the facet. Skips
   * `onStart`. Not `@callable`: a browser could otherwise run any op under any pid.
   */
  async supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult> {
    return await this.hostedWorkspace().supervisorOp(envelope);
  }

  private _actorHomes: HostedActorHomes | undefined;

  private get actorHomes(): HostedActorHomes {
    return this._actorHomes ??= new HostedActorHomes({ homeHost: () => this.facetHomeHost(), directory: this.workspaceActors() });
  }

  private liveActor(actorId: string): boolean {
    const record = this.actorDirectoryStore().retained(actorId);

    return record !== null && actorStanding(record) === 'live';
  }

  /** A non-root agent with a home, retired or not: its conversation stays readable until destroyed. */
  agentOf(actorId: string): WorkspaceActor & { readonly homeName: string; readonly shellId: string } {
    const record = this.actorHost().describe(actorId);

    // Main is the workspace's own agent: its home is the workspace root and its shell the workspace's own (D9). Its
    // storage key is the workspace's name, which a reset's new main reuses, so its facet is named by its id instead.
    if (record !== null && record.parentActorId === null) return { ...record, storageKey: record.actorId, homeName: MAIN_AGENT, shellId: this.shellId() };
    const placement = record === null ? null : hostedActorPlacement(record);

    if (record !== null && placement?.homeName != null) return { ...record, homeName: placement.homeName, shellId: placement.shellId };

    return settleSync(Effect.fail(new KinuError('denied', `No agent ${actorId} with a home of its own is registered in this workspace.`)));
  }

  /** An actor whose stores are its own isolate's: main, and every agent with a home (D9). */
  private isAgent(actorId: string): boolean {
    const record = this.actorHost().describe(actorId);

    return record !== null && (record.parentActorId === null || hostedActorPlacement(record).homeName !== null);
  }

  /** An agent that still acts: live, or retiring while its work winds down. */
  actingAgentOf(actorId: string): WorkspaceActor & { readonly homeName: string; readonly shellId: string } {
    const agent = this.agentOf(actorId);

    if (actorStanding(agent) !== 'retired') return agent;

    return settleSync(Effect.fail(actorEnded('denied', { actorId: agent.actorId, standing: 'retired' }, `Agent ${agent.name} is retired and no longer acts in this workspace.`)));
  }

  async agentCred(record: WorkspaceActor): Promise<VfsCred> {
    // The workspace's own agent acts as the session user, in its turns as in the owner's own shell, with the project's group:
    // it writes what a share's viewer made in the project.
    if (actorPolicy(record).workspaceAgent) return PROJECT_OWNER_CRED;
    const home = await this.actorHomes.get(record, actorReferenceOf(record));

    if (home?.cred !== undefined) return home.cred;

    return await settle(Effect.fail(new KinuError('denied', `Agent ${record.name} has no credential of its own.`)));
  }

  /** Named by the storage key, so its SQLite follows the agent. */
  protected async agentFacetOf<Facet extends AgentFacet = AgentFacet>(actorId: string): Promise<Fetcher<Facet>> {
    return await agentFacet<Facet>(this.ctx, this.env, this.agentPlacement(actorId));
  }

  protected agentPlacement(actorId: string): AgentFacetPlacement {
    const agent = this.agentOf(actorId);

    return {
      actorId, storageKey: agent.storageKey, workspaceName: this.workspaceName(), home: agentHome(agent.homeName),
      providers: providerBindingsOf(this.env),
    };
  }

  private readonly agentIsolateSlots = new AgentIsolateSlots(this.ctx);

  /** Each `callOperation` still running, by its call id, so `cancelOperation` can stop it. */
  private readonly operationCalls = new Map<string, AbortController>();

  /** An agent's storage key, read once an activation: `workspace_actors` rows are never deleted, and an agent's key and
   *  home never change, so what made it an agent here holds for as long as its id does. */
  private agentKey(actorId: string): string {
    const known = this.agentKeys.get(actorId);

    if (known !== undefined) return known;
    const { storageKey } = this.agentOf(actorId);

    this.agentKeys.set(actorId, storageKey);

    return storageKey;
  }

  private readonly agentKeys = new Map<string, string>();

  /** A call into an agent's isolate, held to its slot, once `first` has run. A Stop's own crossings (its run's interrupt,
   *  its chat's) wait on nothing; the chat's, answered, retires the Stop it owed. */
  private async isolateCall<A>(actorId: string, call: (isolate: AgentFacetCalls) => Promise<A>, first?: Effect.Effect<unknown, KinuError>): Promise<A> {
    this.openedIsolates.add(actorId);

    return await this.agentIsolateSlots.call(`kinu-agent:${this.agentKey(actorId)}`, () => this.agentIsolate(actorId), call, first);
  }

  /** Every other call into an agent's isolate. A Stop it has not answered crosses first: any other call joins that
   *  crossing, so nothing more of the agent's is driven before it. */
  private async stopJoined<A>(actorId: string, call: (isolate: AgentFacetCalls) => Promise<A>): Promise<A> {
    const stopFirst = attempt({ doing: "crossing the Stop the agent's isolate has not answered", otherwise: 'unavailable' }, () => this.stopReplayed(actorId));

    return await this.isolateCall(actorId, call, stopFirst);
  }

  /** A call into an agent's isolate bound to the agent's snapshot as it is now. */
  protected override async agentCall<A>(actorId: string, call: (isolate: AgentFacetCalls, snapshot: AgentSnapshot) => Promise<A>): Promise<A> {
    const snapshot = this.agentSnapshot(actorId);

    return await this.stopJoined(actorId, (isolate) => call(isolate, snapshot));
  }

  /** The agents' Stops their isolates have not answered (AgentStops over `sql`). */
  private get stops(): AgentStops {
    return new AgentStops(this.boundSql);
  }

  /** An agent's Stop its isolate has not answered, held per agent: AgentStops' owe and retire run over `sql`, which drops it. */
  private readonly stopOwed = this.held.holdEach(['agent_stops'], (actorId: string) => this.stops.owed(actorId));

  /** The crossing of an agent's unanswered Stop each caller joins: one at a time per agent, dropped once it settles. */
  private readonly stopReplays = joining<string, boolean>();

  /**
   * An agent's Stop its isolate has not answered (the workspace reset before it did), crossed now at its cutoff and
   * retired once the isolate commits it. Answers whether one was owed. Every call that drives the agent's work joins it
   * first, and so does an opening its isolate asks for: one asked while a Stop is owed was queued before that Stop.
   */
  private async stopReplayed(actorId: string): Promise<boolean> {
    if (this.stopOwed(actorId) === null) return false;

    return await this.stopReplays(actorId, async () => {
      await this.stopCrossed(actorId, null);

      return true;
    });
  }

  /** The chat's interrupt, at `cutoff` and at an owed Stop's, read before it crosses: that Stop is retired once the
   *  isolate answers, having committed the cutoff and cancelled what it queued; a Stop owed meanwhile stays owed. */
  private async stopCrossed(actorId: string, cutoff: number | null): Promise<readonly string[]> {
    const snapshot = this.agentSnapshot(actorId);
    const owed = this.stopOwed(actorId);
    const newest = owed?.cutoff ?? null;
    const at = cutoff === null || newest === null ? cutoff ?? newest : Math.max(cutoff, newest);
    const handed = await this.isolateCall(actorId, (isolate) => isolate.interruptChat(snapshot, at));

    if (owed !== null) this.stops.retire(actorId, owed.generation);

    return handed;
  }

  protected async agentIsolate(actorId: string): Promise<AgentFacetCalls> {
    return await this.agentFacetOf(actorId);
  }

  protected dropAgentFacet(storageKey: string): void {
    this.ctx.facets.delete(storageKey);
  }

  /** The agents whose isolate this activation opened: only these can hold calls open on it. */
  private readonly openedIsolates = new Set<string>();

  /** An agent's isolate has nothing open on this object: its turns' ends, reports and lanes have all been answered. */
  private async agentQuiet(actorId: string): Promise<void> {
    await this.stopJoined(actorId, (isolate) => isolate.idle());
  }

  /**
   * Each agent's snapshot rows as last read: every write to the tables they copy goes through this object's `sql`, which
   * drops them all (`writesSnapshotRows`), so rows held here are the rows.
   */
  // Lazy: this object's `sql` runs before its fields are initialised (its base's constructor).
  private _heldSnapshots: Map<string, Omit<AgentSnapshot, 'order'>> | undefined;

  agentSnapshot(actorId: string): AgentSnapshot {
    const heldSnapshots = this._heldSnapshots ?? new Map<string, Omit<AgentSnapshot, 'order'>>();
    const known = heldSnapshots.get(actorId);
    const read = known === undefined ? this.readSnapshot(actorId) : Effect.succeed(known);

    this._heldSnapshots = heldSnapshots;

    return settleSync(read.pipe(Effect.map((held) => {
      heldSnapshots.set(actorId, held);

      return { ...held, order: { activation: this.snapshotActivation, seq: ++this.snapshotSeq } };
    })));
  }

  private readSnapshot(actorId: string): Effect.Effect<Omit<AgentSnapshot, 'order'>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const agent = this.agentOf(actorId);
      const lineage: StoredRow[] = [];

      // Each row names its parent: the walk reads one row a hop.
      for (let step: string | null = actorId; step !== null;) {
        const row: StoredRow | undefined = this.ctx.storage.sql.exec<StoredRow>('SELECT * FROM workspace_actors WHERE actor_id = ?', step).toArray()[0];

        if (row === undefined) return yield* Effect.fail(new KinuError('missing', `Agent ${actorId} has an ancestor the roster does not hold.`));
        lineage.unshift(row);
        step = v.parse(v.nullable(v.string()), row.parent_actor_id);
      }

      const identity = this.ctx.storage.sql.exec<StoredRow>('SELECT * FROM workspace_identity').toArray()[0];

      if (identity === undefined) return yield* Effect.fail(new KinuError('missing', 'The workspace has no durable identity to hand an agent.'));

      return this.snapshotRows(agent, lineage, identity);
    });
  }

  private snapshotRows(agent: ReturnType<OrchestratorAgent['agentOf']>, lineage: StoredRow[], identity: StoredRow): Omit<AgentSnapshot, 'order'> {
    const { actorId } = agent;

    // Not the evolution engine's count of closed turn windows: it moves with every turn and no agent's isolate reads it, so
    // held here it would have that isolate adopt its rows again on its first call after each turn.
    const config = this.ctx.storage.sql.exec<StoredRow>(
      `SELECT * FROM actor_config WHERE actor_id IN (${lineage.map(() => '?').join(', ')}) AND key != ?`, ...lineage.map((row) => row.actor_id),
      AGENT_CONFIG_KEYS.closedTurnWindows,
    ).toArray();

    const scaffold = this.ctx.storage.sql.exec<StoredRow>("SELECT * FROM scaffold_versions WHERE actor_id = ? AND status = 'current'", actorId).toArray();

    return {
      identity, lineage, config, scaffold, workspaceName: this.workspaceName(),
      installedBuild: this.env.CF_VERSION_METADATA?.id ?? null,
      artifactDirectory: agentArtifactDirectory(agentHome(agent.homeName)),
    };
  }

  /** The order its snapshots are read in, this activation: an isolate adopts none older than one it holds. */
  private readonly snapshotActivation = crypto.randomUUID();

  private snapshotSeq = 0;


  private _agentTurns: AgentTurns | null = null;

  protected get agentTurns(): AgentTurns {
    return this._agentTurns ??= this.openAgentTurns();
  }

  /** This activation's hold on its agents' open turns: RAM, gone with the activation, while their isolates run on. */
  protected openAgentTurns(): AgentTurns {
    return new AgentTurns({
      sql: this.boundSql,
      fence: (actorId) => this.heldFence(actorId),
      seams: () => this.hostedSeams(),
      reference: (actorId) => actorReferenceOf(this.actingAgentOf(actorId)),
      // A run as its delivery (design v2 §1, D2): committed with the agent's wake, crossed, run as a typed input of its
      // chat, and its end told with its report; a crossing that does not reach it leaves it owed to that wake.
      deliver: async (reference, task) => {
        const { actorId } = reference;
        const crossed = await this.deliver(actorId, { id: task.sequenceId, input: { kind: 'run', task }, authorship: 'hirer' });

        return 'failure' in crossed && !this.deliveries.unpaid(actorId).some((owed) => owed.id === task.sequenceId) ? crossed.failure : null;
      },
      interrupt: async (reference, turnId, cutoff) => {
        for (const call of this.jobAuthorities.live(reference.actorId)?.runner.foreground ?? []) call.abort(new Error('cancelled by operator'));
        const { actorId } = reference;

        if (turnId === null) await this.stopCrossed(actorId, cutoff);
        else {
          const snapshot = this.agentSnapshot(actorId);

          await this.isolateCall(actorId, (isolate) => isolate.interrupt(snapshot, turnId));
        }
      },
      chatOwed: async (reference) => this.agentWakes.armed(reference.actorId) && await this.agentCall(reference.actorId, (isolate, snapshot) => isolate.owed(snapshot)),
      chatIdle: async (reference) => { await this.agentQuiet(reference.actorId); },
      frozen: async (reference, key) => await this.agentCall(reference.actorId, (isolate, snapshot) => isolate.frozen(snapshot, { turnId: key.turnId, runId: key.runId })),
      pricing: (spec) => this.modelCatalog.pricing(spec),
      admitModel: (spec) => this.admitModelTurn(spec),
      accounts: () => this.config.getProviderAccounts(),
      noteRequest: (actorId, lastRequestAt) => this.warmingOf(actorId).noteRequest(lastRequestAt),
      openWork: (actorId) => this.openWorkOf(actorId),
      credentialsRevision: () => this.account.openedCredentialsRevision(),
      // The workspace agent's missions are the workspace's: owner-declared here, and charged here as its turns spend.
      missions: (actorId) => (actorPolicy(this.agentOf(actorId)).workspaceAgent ? this.budget : null),
      // The activation owns it, as its other detached work: a failure is logged as the release's own.
      turnsEnded: (actorId) => {
        const box = this.rt.sandboxHandle;

        if (box !== null) this.detachOwned(logged('agent.desktop_release_failed', { doing: "letting go of the desktop an agent's turns held", otherwise: 'io' }, () => box.releaseDesktop(actorId), { actorId }));
      },
    });
  }

  /**
   * What one agent in its own isolate may ask of this workspace, bound to that agent. Not `@callable`: reached
   * through `AgentWorkspaceRPC`, whose props this object minted, so the id is the caller's own.
   */
  private agentActivity(actorId: string, lines: readonly AgentTurnActivity[]): void {
    for (const { event, detail } of lines) this.logActivity(event, detail === undefined ? actorId : `${actorId} ${detail}`);
  }

  /**
   * The platform reported an agent's isolate out of memory at `diedAt` (its tail heard it, `AgentIsolateTail`): marked on
   * the execution it killed, so recovery ends a turn whose step dies of memory each time rather than run it again. Not
   * @callable: only this script's tail reaches it.
   */
  async isolateOutOfMemory(actorId: string, diedAt: number): Promise<void> {
    if (!this.liveActor(actorId) || this.admitting.signal.aborted) return;
    diagnostics.event('agent.isolate_out_of_memory', { workspace: this.name, actor: actorId, diedAt });
    await this.agentCall(actorId, (isolate, snapshot) => isolate.outOfMemory(snapshot, diedAt));
  }

  agentWorkspace(actorId: string): AgentWorkspaceHost {
    if (this.deleting.signal.aborted) return settleSync(Effect.fail(new KinuError('missing', 'This workspace was deleted.')));
    this.agentKey(actorId);
    const credentials = async () => await this.userHub();
    const credentialReads = userCredentials(() => this.requireOwnerUserDO(), () => this.userCaller());

    return new AgentWorkspaceHost({
      session: async () => {
        const live = this.actingAgentOf(actorId);

        return await this.hostedWorkspace().session({ shellId: live.shellId, cred: await this.agentCred(live) });
      },
      // Its own named shell, never the agent's: the session user's identity must not reach the agent's commands.
      stateSession: async () => await this.hostedWorkspace().session({ shellId: agentStateShellId(this.actingAgentOf(actorId).storageKey) }),
      memory: () => new AgentMemory(async () => (await this.agentSeat(actorId)).runtime.memory),
      program: async (bound, ...args) => {
        this.admitWork();

        return await this.agentTurns.program(actorId, bound.turnId, ...args);
      },
      traceTurn: (close, event) => this.agentTurns.trace(actorId, close, event),
      traceStream: (close, lines) => this.agentTurns.traceStream(actorId, close, headDeltas(lines)),
      // Its first step binds the profile its turn assembled on, and the grant carries the live block on it (D5).
      paceStep: async (bound, profile) => {
        if (profile !== null) this.boundProfiles.set(actorId, profile);
        const dynamic = profile === null ? null : this.agentTurns.bind(actorId, bound, profile);

        // The workspace's `harness.mode` as the grant leaves: its isolate's steps read it from there.
        await this.stopJoined(actorId, (isolate) => isolate.step(bound.turnId, dynamic, this.config.getHarnessMode()));
      },
      resume: (bound) => this.agentTurns.resume(actorId, bound),
      guard: (bound, ...args) => this.agentTurns.guard(actorId, bound, ...args),
      debit: (close, ...args) => this.agentTurns.debit(actorId, close, ...args),
      prepareTurn: async (bound) => {
        this.admitWork();

        // Asked while a Stop of the agent's is owed, it was queued before that Stop, which its isolate takes first.
        if (await this.stopReplayed(actorId)) return settleSync(Effect.fail(new KinuError('cancelled', `Task ${bound.turnId} was stopped.`)));
        // A turn opens on the account's settings as they are now (`accountSettingsAtOpen`).
        const opened = await this.openingAccount(actorId, false);

        if (Exit.isFailure(opened)) return settleSync(Effect.failCause(opened.cause));

        return await this.agentTurns.prepare(actorId, bound);
      },
      prepareChat: async (request) => {
        this.admitWork();

        // What its opening moved of its standing rides the preparation, taken as a told report is.
        if (request.owes !== undefined) await this.agentOwes(actorId, request.owes);

        if (request.turnId === null) return await this.agentTurns.prepareChat(actorId, request);

        // As a run's: an opening asked while a Stop is owed was queued before it.
        if (await this.stopReplayed(actorId)) return settleSync(Effect.fail(new KinuError('cancelled', `Turn ${request.turnId} was stopped.`)));

        try {
          // A turn opens on the account's settings as they are now; a chat built with no turn reads what is held.
          const opened = await this.openingAccount(actorId, true);

          if (Exit.isFailure(opened)) return settleSync(Effect.failCause(opened.cause));

          return await this.agentTurns.prepareChat(actorId, request);
        } finally {
          this.openingPlanes.delete(actorId);
        }
      },
      // What its turns are built on, seeded as a turn's preparation seeds it; no surface is built for no turn. Not fenced
      // by a deletion: every call into an isolate that has not opened its chat asks it first, the deletion's own Stop
      // included, and work that would begin is refused where it enters.
      scaffold: async () => {
        const actor = await this.agentSeat(actorId);

        // As its turn's sources ask it first: the workspace agent's program is installed before it is read.
        if (actorReach(actorPolicy(actor.record)).kind === 'workspace') await this.ensureOwnedScaffold();

        return this.agentTurns.scaffold(actor, await actor.runtime.identity.scaffold.version());
      },
      chatEvent: (event) => this.hostedChatEvent(actorId, event),
      turnEnded: async (event, figures, activity, window) => {
        await this.hostedTurnEnded(actorId, event, figures, window);

        // What its turn logged that no tool call took rides its end, written after its room heard it.
        if (activity.length > 0) this.agentActivity(actorId, activity);
      },
      answerAmended: async (window) => { this.chatRooms.hostedRoom(actorId)?.answerAmended(window); },
      // The turn's report, owed once its answer committed: decided here, where its hirer's roster is, and relayed. What it
      // told so far is the agent's own, kept where the turn ran. An agent with no hirer owes none.
      turnReport: async (turn, ended, relay) => {
        if (actorPolicy(this.agentOf(actorId)).hirer === null) return 'none';

        const actor = this.agentBound(actorId);
        const report = await hostedOwedReport(this.hostedSeams(), actor, turn, ended);

        return report === null ? 'none' : await hostedParentReport(this.hostedSeams(), actor, {
          text: report.content, status: report.status, mode: relay.mode, sequenceId: relay.sequenceId, ...(report.quiet === true && { quiet: true as const }),
        });
      },
      parentReport: (report) => hostedParentReport(this.hostedSeams(), this.agentBound(actorId), report),
      autoTitle: async (subject, title) => await hostedAutoTitle(this.hostedSeams(), this.agentBound(actorId), subject, title),
      turnSettled: async (settled) => {
        if (!actorPolicy(this.agentOf(actorId)).workspaceAgent) {
          return settleSync(Effect.fail(new KinuError('denied', "Only the workspace's own agent hands its turns to the workspace.")));
        }

        this.runSettled(actorId, settled);
        await this.mainTurnSettled(settled);
      },
      runSettled: async (run) => { this.runSettled(actorId, run); },
      owes: async (seq, next, holds, report) => { await this.agentOwes(actorId, { seq, next, holds, report }); },
      birthContext: async (drainTurnId) => subagentTurnContext(new EventLog(this.watchedExec, this.agentBound(actorId).handle), drainTurnId),
      releaseForeground: async (executing) => this.foregroundRunnerOf(actorId)?.releaseForeground(executing) ?? false,
      steerSkills: async (text, alreadyActive) => await steerSkillsBlock({
        vfs: this.rt.storage.vfs,
        config: this.agentBound(actorId).stores.config,
        userText: text,
        trust: this.instructionTrust(),
        limits: this.modelCatalog.window(),
        alreadyActive: new Set(alreadyActive),
      }),
      // Only main's conversation is kept warm: no other agent has its wake chain.
      armCacheWarm: async (input) => this.warmingOf(actorId).armAfterTurn(input),
      // Asked only by a turn that never prepared: one that did reads what its preparation and its tools answered.
      openWork: async () => this.openWorkOf(actorId),
      enqueueTurn: (input) => this.enqueueHostedTurn(this.agentBound(actorId), input),
      executeTool: (call) => {
        this.admitWork();
        this.agentActivity(actorId, call.activity);

        // Open while the tool runs, under the RPC that relayed it: a kill keeps the cut span's name.
        return this.tracing.invocation('rpc', `tool.${call.name}`, () => this.agentTurns.execute(actorId, call));
      },
      advisorRead: (call) => this.agentTurns.advisorRead(actorId, call),
      // A repair's question, read only: its calls' effects committed here, under the receipts each kept.
      receipts: async (turnId, runId, callIds) => remoteReceipts(this.boundSql, this.agentBound(actorId).handle, { turnId, runId }, callIds),
      observe: async (lines) => { await this.chatRooms.hostedRoom(actorId)?.observe(uiChunks(lines)); },
      answerMetadata: (close, narration) => this.takeTurnSlates(actorId, close.turnId, narration),
      reportModelCall: async (report) => { this.reportModelCall(report); },
      getAuth: credentialReads.getAuth,
      listCredentials: credentialReads.listCredentials,
      relayDevice: async (provider) => {
        const { stub, caller } = await credentials();

        return await stub.relayDevice(caller, provider);
      },
      relayModelCall: async (deviceId, callId, request) => {
        const { stub, caller } = await credentials();

        return await stub.relayModelCall(caller, deviceId, callId, request);
      },
      cancelModelRelay: async (callId) => {
        const { stub, caller } = await credentials();

        await stub.cancelModelRelay(caller, callId);
      },
      logActivity: async (lines) => { this.agentActivity(actorId, lines); },
      sayToParent: async (signal) => {
        const { parentActorId } = this.actingAgentOf(actorId);

        if (parentActorId === null) return settleSync(Effect.fail(new KinuError('missing', 'A root actor has no hirer to tell.')));

        // Its hirer hears it as a delivery of its own, whichever agent hired it.
        return await this.agentDeliveries(parentActorId).signals.send(signal);
      },
    }, this.deleting.signal, (bound, call) => this.agentTurns.holds(actorId, bound, call), (turnId) => this.agentTurns.cutOff(actorId, turnId));
  }

  private agentBound(actorId: string): BoundActor {
    return this.actorHost().bindStores(actorReferenceOf(this.actingAgentOf(actorId)));
  }

  /** The seat an agent holds, which a run of its may have taken, as its turn's preparation reads it; else its own. */
  private async agentSeat(actorId: string): Promise<SeatedActor> {
    const reference = actorReferenceOf(this.actingAgentOf(actorId));

    return this.actorHost().hosted(reference) ?? await this.actorHost().acquire(reference, { kind: 'actor' });
  }

  /** The tile reads an agent's chat turn as its room hears it open and close. */
  private async hostedChatEvent(actorId: string, event: SessionEvent): Promise<void> {
    if (event.type === 'turn-start') {
      this.agentTurns.chatOpened(actorId, event.turnId);
      this.overviewChanged();
      this.liveReadsMoved(readsOfTables(['actor_turn_claims']));

      this.chatOpenedAt.set(actorId, Date.now());
      this.agentBound(actorId).stores.config.setHoldsTurns();
      this.claimPresented(actorId);
      this.warmWorkspaceNodeInBackground();

      // The owner's words close the questions held open as the turn opens; none held, the next read is fresh.
      if (this.heldOpenQuestion(actorId) === true) this.hostedQuestionsMoved();
    }

    // Each change of its plans is announced here before the change answers, its turn's submission as the owner's
    // decision: the stack asks it for plans from now on, and the reads over them move.
    if (event.type === 'broadcast' && event.event.type === 'plan_updated') {
      const { config } = this.agentBound(actorId).stores;

      if (!config.getHoldsPlans()) config.setHoldsPlans();
      this.hostedPlansMoved();
    }

    await this.chatRooms.hostedRoom(actorId)?.deliver(event);
  }

  /** When each agent's running turn opened, as its room heard it. */
  private readonly chatOpenedAt = new Map<string, number>();

  /** Presentation from the policy: the workspace's own tabs show the workspace agent's turn claim. */
  private claimPresented(actorId: string): void {
    if (actorPolicy(this.agentOf(actorId)).workspaceAgent) this.turnClaimChanged();
  }

  /** `window`: the transcript's newest messages as the turn ended, its room's closing frame. The room hears the end before
   *  this object writes it: a frame waits for the writes made before it, and the answer it tells of is already durable in
   *  the agent's own store (#103). */
  private async hostedTurnEnded(actorId: string, event: TurnEndEvent, figures: AgentFigures, window: ChatWindow): Promise<void> {
    const { runId } = event;
    const fences = new TurnFences(this.boundSql);
    const ended = fences.ending(actorId, runId);

    if (ended === null) {
      diagnostics.event('agent.stale_turn_end', { actorId, runId });

      return;
    }

    this.chatRooms.hostedRoom(actorId)?.closeTurn(event.turnId, window);
    fences.ended(actorId, { runId });
    await this.chatTurnClosed(actorId, figures, ended === 'unfenced' ? null : ended, ended === 'unfenced' ? this.agentTurns.chatTurn(actorId) : ended.turnId);
  }

  /**
   * An agent that says it rests holds no turn, whatever this object last heard: the end of a turn its isolate committed
   * and did not live to tell is closed here. Its chat is asked again first, and the run closed only if the opening this
   * object saw open before it asked is still the open one: a reply made before a later turn or the same turn's Retry
   * opened, here or after this object reset, closes nothing.
   */
  private async closeLostChatTurn(actorId: string): Promise<void> {
    const open = this.agentTurns.chatOpening(actorId);

    if (open === null) return;
    const fences = new TurnFences(this.boundSql);
    // Seen before it asks: the opening this activation admitted, or, for a turn it read again after a restart, the fence's.
    const expected = open.fenced ?? fences.current(actorId);

    if (await this.agentCall(actorId, (isolate, snapshot) => isolate.owed(snapshot))) return;

    if (expected === null ? this.agentTurns.chatOpening(actorId)?.turnId !== open.turnId : fences.ended(actorId, expected) === null) {
      diagnostics.event('agent.lost_end_superseded', { turnId: open.turnId });

      return;
    }

    diagnostics.event('agent.turn_end_lost', { turnId: open.turnId });
    await this.chatRooms.hostedRoom(actorId)?.closeLostTurn(open.turnId);
    await this.chatTurnClosed(actorId, null, expected, open.turnId);
  }

  /** What a turn's end moves in this object, told (its `figures`) or lost with its isolate. `closing` is the opening
   *  that ended, `turnId` its turn: a later one, opened while this one's end was applied, stays open. */
  private async chatTurnClosed(
    actorId: string, figures: AgentFigures | null, closing: OpenedAt | null, turnId: string | null,
  ): Promise<void> {
    this.agentTurns.chatClosed(actorId, closing);
    // Its claim closed and its sequence opened in its own isolate.
    this.liveReadsMoved(readsOfTables(['actor_turn_claims', 'terminal_effects']));

    this.claimPresented(actorId);
    this.overviewChanged();

    if (!this.liveActor(actorId)) return;

    if (figures !== null) recordAgentFigures(this.boundSql, actorId, figures);

    // A delivery's turn answered the events it carried: their lease closes with it.
    if (turnId !== null && announcementOf(turnId) !== turnId) await this.answeredBatch(actorId, announcementOf(turnId));

    // What reached it while the turn ran is due a drain now: the durable wake takes it, whichever session holds the agent.
    this.armDurableWake();
  }

  /** A promise so the workspace boots on the first provision, never at activation. */
  private facetHomeHost(): Promise<NodeHomeHost> {
    return this.hostedWorkspace().bundle.privileged()
      .then((privileged) => ({ ...privileged, sql: this.ctx.storage.sql }));
  }

  private _actorHost: ActorHost<CFSeat> | null = null;
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
  protected actorHost(): ActorHost<CFSeat> {
    this._actorHost ??= this.withAgentFacets(createWorkspaceActorHost(this.workspaceHostSeams()));

    return this._actorHost;
  }

  /** Every agent's turns run in its own isolate: the workspace's view of each is its open turns. */
  private hostedTurnInFlight(reference: ActorReference): boolean {
    return this.agentTurns.inFlight(reference.actorId);
  }

  /** Each agent parks in its own isolate's ledger, so each is told; detached, so the owner's write never waits on them. */
  protected override async modelSettingsChanged(): Promise<void> {
    await super.modelSettingsChanged();

    for (const { actorId } of this.workspaceActors().list()) {
      if (!this.isAgent(actorId)) continue;
      this.detachOwned(logged('agent.settings_release_failed', { doing: "telling an agent's isolate the model settings changed", otherwise: 'unavailable' },
        async () => { await this.agentCall(actorId, (isolate, snapshot) => isolate.modelSettingsChanged(snapshot)); }, { workspace: this.name, actor: actorId }));
    }
  }

  protected override async agentTurnSettled(actor: ActorReference): Promise<void> {
    if (this.liveActor(actor.actorId)) await this.agentTurns.settled(actor.actorId);
  }

  protected override currentTurnOf(reference: ActorReference): string | null {
    return this.agentTurns.currentTurn(reference.actorId);
  }

  private withAgentFacets(host: ActorHost<CFSeat>): ActorHost<CFSeat> {
    return {
      ...host,
      retire: async (parent, retirement) => {
        const record = this.actorDirectoryStore().retained(retirement.reference.actorId);
        const own = record !== null && hostedActorPlacement(record).homeName !== null;
        // Read before it retires: its questions leave the stack with it.
        const asked = record !== null && this.holdsQuestions(record.actorId);

        if (own) await this.agentTurns.beforeRetirement(record.actorId, retirement.destroy || retirement.interrupt);

        // Its isolate goes with it: the calls it still has open on this object are answered first, so none is left
        // to a relay whose caller is gone.
        if (own && retirement.destroy && this.openedIsolates.has(record.actorId)) await this.agentQuiet(record.actorId);
        await host.retire(parent, retirement);

        if (own) {
          // Retired: what it was owed and had not taken is cancelled with its wake.
          this.deliveries.cancel(record.actorId);
          await this.agentWakes.owes(record.actorId, null);

          if (new AgentReports(this.boundSql).release(record.actorId)) this.agentReportMoved(record.actorId);
          this.agentsWorking.delete(record.actorId);
          this.openingAccountDropped(record.actorId);
        }

        if (own && retirement.destroy) this.dropAgentFacet(record.storageKey);

        // The others' stand as held: no isolate is asked again.
        if (asked) this.askerRetired(retirement.reference.actorId);
      },
    };
  }

  protected actorDirectoryStore(): WorkspaceActorDirectory {
    return this.workspaceActors();
  }

  /** Immutable catalogs are shared by value; per-actor state (event log, governor, broadcast) is built per actor in
   *  `actor-hosting.ts` and is never this object's own. */
  private workspaceHostSeams(): WorkspaceHostSeams {
    return {
      env: this.env,
      ctx: this.ctx,
      agent: this,
      holdLane: (body) => this.holdLane(body),
      currentTurn: (reference) => this.currentTurnOf(reference),
      exec: this.watchedExec,
      sql: this.boundSql,
      directory: this.workspaceActors(),
      workspaceName: this.workspaceName(),
      installedBuild: () => this.env.CF_VERSION_METADATA?.id ?? null,
      ownerUserId: () => this.getOwnerUserId(),
      capabilityToken: () => this.workspaceCapabilityToken(),
      workspaceBox: (shellId) => this.workspaceBox(shellId),
      workspaceServing: () => this.workspaceServing(),
      commandEnvironment: (use, caller) => this.account.commandEnvironment(use, caller),
      homeHost: () => this.facetHomeHost(),
      homes: this.actorHomes,
      // The root's durable program is always readable because the root is this runtime;
      // `loopFor` explains why hosting is the wrong question.
      rootRuntime: () => this.rt,
      workspaceAgentHome: () => this.rt,
      contextTree: (actorId, editor) => this.agentStores(actorId).contextTree(editor),
      // Same profile authority an actor chat resolves through, so a role restriction narrows
      // a chat and a head identically; branches under an unresolved profile are unreproducible.
      resolveProfile: (input) => this.actorProfile(input),
      reportModelCall: (report) => { this.reportModelCall(report); },
      refusals: (actor) => this.refusalNoticesFor(actor),
      liveReadsMoved: (reads) => { this.liveReadsMoved(reads); },
      servingMoved: () => this.servingMoved(),
      boxUse: this.boxUse,
      modelOperations: this.modelOperations,
      tracing: () => this.tracing,
      slate: (actor, operation, turn) => this.slateAs(
        { path: [{ name: actor.name }], cred: ROOT_SLATE_CALLER.cred, workMode: 'build' }, operation, turn,
      ),
      deferrals: (actorId) => this.deferralChannel(actorId),
      jobs: (actor) => this.jobRunnerOf(actor),
      processEnds: () => this.processEnds,
      chosenLoopOrigin: (record: WorkspaceActor) => this._chosenLoopOrigins.get(record.actorId) ?? null,
      chosenWriteObserver: (record: WorkspaceActor) => this._actorWriteObservers.get(record.actorId) ?? null,
    };
  }

  /**
   * A programmatic turn for the agent, as its delivery: the words and metadata its producer gave it, under the key the
   * producer named or one minted for it, a turn of its own whatever runs. Committed, it is queued, owed until the agent
   * takes it; refused, it failed.
   */
  private async enqueueHostedTurn(actor: BoundActor, input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    const crossed = await this.deliver(actor.reference.actorId, {
      id: input.idempotencyKey ?? `turn-${nanoid()}`,
      input: {
        kind: 'turn', text: input.text, opensTurn: true,
        ...(input.metadata !== undefined && { metadata: { ...input.metadata } }),
        ...(input.yieldsToUserMessage === true && { yieldsToUserMessage: true }),
      },
      authorship: input.authorship ?? turnTags({ kind: 'programmatic', metadata: input.metadata }).authorship,
    });

    if ('admitted' in crossed) return { status: crossed.admitted === 'yielded' ? 'yielded' : 'queued' };

    return CODE_IS_REFUSAL[crossed.failure.code] ? { status: 'failed', reason: crossed.failure.message } : { status: 'queued' };
  }

  protected hostedSeams(): HostedActorSeams {
    return {
      host: this.actorHost(),
      exec: this.watchedExec,
      directory: this.workspaceActors(),
      turnInFlight: (reference) => this.hostedTurnInFlight(reference),
      // A run seat reads its owner's mail plane as a turn does, once as it is seated: its prompt's mail roster and its
      // programs' `mail` both follow that read (`runSeatMail`), so an owner with no address offers its runs no mail.
      sources: async (actor) => {
        const reach = actorReach(actorPolicy(actor.record));
        const planes = this.sourcePlanes(actor, reach, false);
        const sources = await this.actorSources(actor, reach, null, planes);

        this.runSeatMail.set(actor, await (planes.mail ?? Promise.resolve(null)));

        return sources;
      },
      infer: (reference, input, inference) => this.agentTurns.run(reference, input, inference),
      transaction: (body) => this.ctx.storage.transactionSync(body),
      roster: (actor) => new SubagentRosterStore(this.watchedExec, actor.handle),
      conversations: (reference) => this.agentStores(reference.actorId).conversations(),
      vfs: () => this.rt.storage.vfs,
      // The hire's own role, not the root's: a delegated turn's prompt and advertised tool
      // surface are framed from it.
      profile: (input) => this.actorProfile({ ...input, actor: input.actor.handle }),
      resolveModel: (spec) => this.ownedModelServices.resolveModel(spec),
      priceAs: (spec) => this.priceHostedModel(spec),
      surface: async (actor, turn) => await this.actorSurface(actor, turn),
      // A run's calls commit their effects in this object's store, under the receipts kept here.
      receipts: (actor) => ({ sql: this.boundSql, actor: actor.handle, transaction: (body) => this.ctx.storage.transactionSync(body) }),
      announce: () => { this.liveReadsMoved(ROSTER_READS); },
      // Its durable wake drains it, whichever isolate holds it, and outlives a reset.
      scheduleDrain: () => { this.armDurableWake(); },
      deliver: (actor, admit) => this.coordinator.owe(actor.reference.actorId, admit),
      hirerName: (actor) => this.hirerName(actor.record),
      jobSeat: (actorId) => ({ ports: this.workspaceJobPorts(actorId), attach: (authority) => this.jobAuthorities.attach(authority) }),
      retireJobs: (actorId) => this.jobAuthorities.retire(actorId),
      temporary: (actor) => this.temporaryAgentPort(actor.reference),
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
      nodeHome: (actor) => this.actorHomes.require(actor.record, actor.reference),
      // A run's programs run the store operations its native tools do (`CodemodeSurface.stores`), and report where its
      // native `report` does.
      codemode: (actor, runtime, webSearch) => (surface, reach) => {
        const reported = surface.report;

        return createCodemodeToolFactory({
          launch: this.codemodeLaunch(runtime.actor.actorId, 'owner'), workspace: this.workspaceName(),
        }).toolFor(surface, {
          reach, namespaces: (executor) => withoutMailIf(
            this.runSeatMail.get(actor) === false ? { withoutMail: true } : {},
            actorNamespaces(this.confinedActor(actor, runtime, { search: webSearch, stores: surface.stores }), SURFACE_POLICY.program, {
              executor, ...(reported !== undefined && { report: () => reported }),
            }),
          ),
        });
      },
      recordStep: async (headId, seq, step) => { await this.recordHeadStep(headId, seq, step); },
      publishDelta: (kind, delta) => { this.publishHeadStreamFrame({ headId: '', kind, delta }); },
      mission: (input) => {
        const labels = input.missionLabels ?? [];

        if (labels.length === 0) return null;

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

  /** A hire's, a head's or a swarm node's programs, as they reach its own planes and what its native tools hold. */
  /** A hire's: what waits on its owner from its own work. A head or a swarm node, whose run ends with it, holds none. */
  protected hireOwnerWaits(actor: SeatedActor): OwnerWaitsHost | null {
    return isSubagentOrigin(actor.record.origin) ? this.ownerWaitsOf(actor.handle.actorId, false) : null;
  }

  /** A hosted actor as its programs reach it, over the store operations its native tools run. */
  private confinedActor(
    actor: SeatedActor, runtime: CFRuntime,
    held: { readonly search: WebSearchProvider; readonly stores: ServedStores; readonly agents?: () => AgentsToolDeps },
  ): SurfaceActor {
    return this.hostedSurface({ ...actor, runtime }, { ...held, ownerWaits: this.hireOwnerWaits(actor), google: this.googleFor(actor.handle.actorId, actor.record.name), mail: this.mailFor(actor.handle.actorId, actor.record.name) });
  }

  /**
   * Every agent's turn surface (design v2 §2, §9), from this one factory: the workspace agent's, a hire's, a head's, a
   * swarm node's and a background run's. What the turn reaches is core's one decision (`surfaceReach`), read from the
   * agent's policy and the lane it was admitted in; each plane below is gated by it, never by asking what the agent is.
   * A fresh opening's effects run here, once per turn: a turn read again after a restart has no opening.
   */
  protected async actorSurface(actor: CFSeat, turn: SurfaceTurn): Promise<ActorSurface> {
    const { key, lane, run } = turn;
    const reach = surfaceReach(actorPolicy(actor.record), lane, true);
    const driving = lane.driving ?? {};
    const item: ChatTurnInput = { kind: turnTags({ metadata: driving }).author === 'operator' ? 'user' : 'programmatic', text: turn.text, metadata: driving };

    const surface = new TurnSurface({
      key, actor: actor.reference, item, continuity: readTurnContinuity(driving),
      // Read where the turn opens: the recorded turn carries it, so a recovering host's engine cannot re-judge a turn it
      // did not run. `engine.enabled` is a live read that a mid-turn toggle could answer differently.
      evolutionEnabled: reach.actor.kind === 'workspace' && this.turnRecordsEvolution(turnTags({ metadata: authoredTurnMetadata({ kind: item.kind, metadata: driving }) }).mode),
    });

    // Its tools are built under the turn they serve, before its chat holds it.
    return await inTurnSurface(surface, async () => {
      // A fresh turn of the workspace agent opens on the workspace's lanes, before it draws its trial arm.
      if (reach.actor.kind === 'workspace' && lane.opening !== undefined) this.workspaceTurnOpening(driving);

      return run === undefined ? await this.turnSurfaceOf(actor, turn, { surface, reach }) : await this.runSurfaceOf(actor, turn, run, { surface, reach });
    });
  }

  /** The profile a turn runs under: a recovered execution's is the one it froze, so a role or model chosen since cannot
   *  answer it differently. The workspace agent's tools offer what its turn read of the account's catalog. */
  private async surfaceProfile(actor: CFSeat, turn: SurfaceTurn, opened: OpenedSurface): Promise<ActorSurface['resolved']> {
    const resolved = turn.frozen ?? await this.actorProfile({ actor: actor.handle, availableTools: [], workMode: turn.lane.mode });

    opened.surface.resolved(resolved.profile, resolved.inputs);

    if (opened.reach.actor.kind === 'workspace') this.accountSwarmsRead(resolved.inputs.envelope.catalog);

    return resolved;
  }

  /** A head's or a swarm node's run: its seat built its tools, sources and capture, and it reaches nothing of its owner's. */
  private async runSurfaceOf(actor: CFSeat, turn: SurfaceTurn, run: NonNullable<SurfaceTurn['run']>, opened: OpenedSurface): Promise<ActorSurface> {
    const resolved = await this.surfaceProfile(actor, turn, opened);
    const ownerLane = { askOwner: false, submitPlan: false, replyToComment: false };

    return this.assembledSurface(actor, opened.surface, {
      resolved, tools: run.tools, stores: run.stores, raw: run.tools, capture: run.capture, reports: { spoke: false, settled: false },
      ownerLane, offered: { ...run.tools, ...ownerLaneDeclarations(ownerLane) }, sources: run.sources, codemodeCapabilities: () => [],
    });
  }

  /** An agent's own turn: its planes, its artifacts and its tools, built here under the turn they serve. */
  private async turnSurfaceOf(actor: CFSeat, turn: SurfaceTurn, opened: OpenedSurface): Promise<ActorSurface> {
    const { runtime } = actor;
    const { key, lane } = turn;
    const { surface, reach } = opened;

    // Its questions park in its own isolate, as every agent's do: the stack asks it once its turn was offered the tool.
    if (reach.turn.askOwner) this.offerAskOwner(actor.stores.config);

    // Its sources' crossings wait on nothing of its own, so they are in flight beside its profile's resolution, or since
    // its opening asked for the account's settings.
    const planes = this.turnPlanes(key.actorId, actor, reach.actor);
    const resolved = await this.surfaceProfile(actor, turn, opened);

    // Read once per turn, and moved only by a turn whose prompt cache is cold: the prompt prefix holds within a segment.
    const cold = lane.opening?.cacheCold ?? false;
    const overrides = artifactOverrides(turnArtifacts(runtime.storage.sql, actor.handle, cold));

    // A dream's skills land in the workspace's skills root, which every turn's index reads, so only this agent's own
    // cold turn writes them.
    if (cold && actor.handle.actorId === this.rt.actor.actorId) {
      await activateDreamSkills(this.refinementDeps);
      // Before the turn's program is chosen, so this turn runs the version it promotes.
      await activateReplayedScaffold(this.refinementDeps.control);
    }

    // After the activation above, so a cold turn takes in what it just put in the root.
    const hidesSkills = dreamSkillsHidden(this.refinementDeps.approvals?.list() ?? [], actor.stores.config, cold);

    const reports: SubagentReportLedger = { spoke: false, settled: false };
    const report = reach.turn.report ? this.hirerReport(actor, lane.mode, reports, key.turnId) : undefined;

    // Read as the turn opened, beside its settings: an owner with no mail address is offered no `mail` this turn
    // (rc29 F7: the assistant offered mail help to an account that had none). Decided before its tools are built.
    const ownerMail = await (planes.mail ?? Promise.resolve(null));

    const scope: ToolScope = {
      execution: () => surface.key, ledgers: surface.ledgers, external: () => surface.declared, profile: () => surface.operation, driving: lane.driving,
      ...(report !== undefined && { report }), ...(ownerMail === false && { withoutMail: true }),
    };

    // A role imposing another mode (a planner on a Build message) runs that mode's tools.
    const { workMode } = resolved.profile;
    const built = this.actorTools(actor, reach, workMode, scope);
    const sources = await this.actorSources(actor, reach.actor, { surface, resolved, artifacts: overrides, hidesSkills }, planes);

    const held = { taskPlan: lane.taskPlan, surface, sql: runtime.storage.sql };
    const tools = this.turnTools(withToolText(built.turn, overrides.tools), held);
    // Its plans and questions commit in its own isolate's store, which builds these tools and keeps their receipts.
    const ownerLane = { askOwner: reach.turn.askOwner, submitPlan: reach.turn.submitPlan, replyToComment: reach.turn.replyToComment };

    const assembled = await this.assembledSurface(actor, surface, {
      resolved, tools, stores: built.stores, raw: this.turnTools(built.raw, held), capture: null, reports, ownerLane, offered: { ...tools, ...ownerLaneDeclarations(ownerLane) }, sources,
      // `agent` / `llm` are reachable only inside `eval`: derived from the namespaces its programs reach.
      codemodeCapabilities: (asked) => (reach.actor.kind === 'workspace' ? codemodeCapabilitiesFor(withoutMailIf(scope, this.ownNamespaces(asked))) : []),
    });

    // Last, once its surface stands: a turn whose tools could not be described opened nothing.
    this.turnOpened(actor, { surface, reach, lane, text: turn.text });

    return assembled;
  }

  /** What both kinds of surface answer alike: its descriptors, its advisor, its reads and its bind. */
  private async assembledSurface(actor: CFSeat, surface: TurnSurface, parts: AssembledSurfaceParts): Promise<ActorSurface> {
    const { sources, codemodeCapabilities, offered, ...rest } = parts;
    const { descriptors, digest } = await describeAgentTools(parts.tools);

    return {
      ...rest, surface, offered, descriptors, digest,
      reads: this.dynamicReadsOf(actor.reference),
      sources: {
        ...sources,
        // Its MCP and extension tools are reached through eval, so its isolate's profile admits them by name.
        wiredToolNames: () => [...Object.keys(offered).filter((name) => !BUILTIN_TOOL_NAMES.has(name)), ...Object.keys(surface.external)],
        codemodeCapabilities,
      },
      bind: (profile) => { surface.bind(profile); },
    };
  }

  /** What a turn read here owes as it is read: the workspace agent's lanes see its owner's words, and the owner's own words
   *  answer the wait of an agent that waits on input. A turn read again after a restart has no words. */
  private turnOpened(actor: CFSeat, opening: { readonly surface: TurnSurface; readonly reach: SurfaceReach; readonly lane: ExecutionLane; readonly text: string }): void {
    const { surface, reach, lane } = opening;

    if (reach.actor.kind === 'workspace') this.workspaceTurnOpened(surface, lane.driving ?? {}, lane.opening !== undefined);

    if (!lane.parentDriven && opening.text !== '') ownerAnswersWait(this.hostedSeams(), actor);
    openAnalyticsWindow(this.env);
  }

  /** A hire's report to its hirer: the hirer's lane alone carries it, natively and in eval. */
  private hirerReport(actor: CFSeat, mode: WorkMode, reports: SubagentReportLedger, turnId: string): ReportDeps {
    return {
      report: async (input) => {
        const relayed = await publishSubagentReport({ mode, reports }, {
          status: input.status, content: input.content, origin: 'report_tool',
          sequenceId: `live:${actor.record.name}:${nanoid()}`, handoff: input.handoff,
        }, (published) => relayHostedReport(this.hostedSeams(), actor, {
          // A run-settling report is the answer.
          ...published, ...(temporaryRunSettles({ status: published.status, origin: published.origin }) && { answers: announcementOf(turnId) }),
        }));

        return { id: relayed.id, disposition: relayed.disposition };
      },
    };
  }

  /**
   * An agent's tools in `mode`, as core's one decision lets it reach them: the builtins over its own runtime and stores,
   * its delegation, receipted under the execution `scope` names, over the ledgers it gives. The workspace's planes (its
   * jobs, its role switch, its external tools, its program namespaces) only where its reach names them.
   */
  /** What an actor's builtins read its stores from (`builtinStores`): its native tools, and a slate's call as it. */
  private storeInputs(actor: CFSeat, reach: ActorReach, ledgers: Pick<TurnLedgers, 'files' | 'context'>, profile: () => OperationProfile | null): BuiltinStoreInputs {
    const { runtime } = actor;
    // The workspace's own agent reads the account's memory whoever owns it; a hire, only once it is owned.
    const proposer = { by: 'agent', agent: actor.record.name } as const;
    const account = reach.kind === 'workspace' ? this.account.memory(proposer) : this.account.ownedMemory(proposer);

    return {
      rt: runtime,
      conversations: this.agentStores(actor.handle.actorId).conversations(),
      // Rows are `actor_id`-scoped, so a hire's `remember` cannot overwrite what the workspace observed under the same words.
      vectorStore: runtime.vectorStore,
      facts: actor.stores.facts,
      ...(account !== undefined && { account }),
      contextBudget: ledgers.context,
      fileLedger: ledgers.files,
      slateBuild: reach.kind === 'workspace' ? (slate) => this.slateBuild(slate) : this.slateBuildFor(actor.record.name),
      knownFile: isBuiltinSkillFile,
      ...(reach.kind === 'workspace' && { roleSwitch: agentRoleSwitch(() => profile()?.inputs?.envelope ?? null) }),
    };
  }

  /** `build` over the workspace agent as its own seat: the reach its policy gives it, and the operation its tools run under. */
  private asRoot<A>(build: (seat: CFSeat, reach: ActorReach, operation: () => OperationProfile | null) => A): A {
    const root = this.rootBound();

    return build({ ...root, runtime: this.rt }, actorReach(actorPolicy(root.record)), () => this.operationProfile());
  }

  protected override ownStoreInputs(ledgers: TurnLedgers): BuiltinStoreInputs {
    return this.asRoot((seat, reach, operation) => this.storeInputs(seat, reach, ledgers, operation));
  }

  protected override hostedStoreInputs(actor: CFSeat, ledgers: Pick<TurnLedgers, 'files' | 'context'>, account: boolean): BuiltinStoreInputs {
    const { account: owned, ...inputs } = this.storeInputs(actor, actorReach(actorPolicy(actor.record)), ledgers, () => null);

    return account && owned !== undefined ? { ...inputs, account: owned } : inputs;
  }

  protected actorTools(actor: CFSeat, reach: SurfaceReach, mode: WorkMode, scope: ToolScope): ActorToolsets {
    const { runtime } = actor;
    const webSearch = this.ownedModelServices.getWebSearchProvider();
    const { report } = scope;

    const codemode = (finished: CodemodeSurface) => {
      // A hire's programs report where its native `report` does.
      const reported = finished.report;

      const operation = scope.profile();
      const factory = reach.actor.kind === 'workspace' ? this.workspaceCodemode() : createCodemodeToolFactory({ launch: this.codemodeLaunch(actor.handle.actorId, 'owner'), workspace: this.workspaceName() });

      // Its programs run the store operations its native tools run (`CodemodeSurface.stores`).
      const confined = reach.actor.kind === 'confined'
        ? this.confinedActor(actor, runtime, { search: webSearch, stores: finished.stores, agents: () => this.actorAgentsToolDeps(actor, reach.actor, mode, scope.profile) })
        : null;

      return factory.toolFor(finished, {
        // The role's own list, which no live resolution has intersected yet: the sandbox cannot bypass the role.
        reach: narrowToolSurface(operation?.inputs === null || operation === null ? undefined : effectiveRoleCatalog(operation.inputs.envelope.catalog)[operation.profile.role.id]?.allowedTools),
        namespaces: (executor) => withoutMailIf(scope, confined === null
          ? actorNamespaces(this.surfaceActor(mode, 'owner', finished.stores), SURFACE_POLICY.program, { executor })
          : actorNamespaces(confined, SURFACE_POLICY.program, { executor, ...(reported !== undefined && { report: () => reported }) })),
      });
    };

    const deps: ActorToolsetDeps = {
      ...this.storeInputs(actor, reach.actor, scope.ledgers, scope.profile),
      ...(scope.served !== undefined && { served: scope.served }),
      workMode: mode,
      // The store its effects commit to keeps each call's receipt (design v2 §4), keyed on the execution it serves.
      effectClaims: { actor: actor.handle, sql: runtime.storage.sql, execution: scope.execution, transaction: (body) => this.ctx.storage.transactionSync(body) },
      codemode,
      escalations: scope.ledgers.escalations,
      // Its `eval` runs here, over the workspace's crafted tools: scored here, and carried to its isolate's turn record.
      craft: scope.ledgers.craft,
      agents: this.actorAgentsToolDeps(actor, reach.actor, mode, scope.profile),
      webSearch,
      jobs: reach.actor.kind === 'workspace' ? { jobRunner: this.jobRunner, backgroundable: BACKGROUNDABLE_TOOLS, mode: () => this.turnWorkMode() } : this.hireJobs(actor, mode),
      ...(reach.actor.kind === 'workspace' && { external: scope.external }),
      ...(report !== undefined && { report }),
    };

    return buildActorTools(deps);
  }

  /** The workspace agent's own tools in `mode` outside any turn of its: a scaffold's rollout, a slate's call, a retry. */
  protected override ownTools(mode: WorkMode, scope: string | null, held?: OwnToolsHeld): ActorToolsets {
    const root = this.rootBound();
    const operation = () => this.operationProfile();

    return this.actorTools({ ...root, runtime: this.rt }, surfaceReach(actorPolicy(root.record), { authorship: 'owner', mode, awaitsReply: false }, true), mode, {
      // A call outside any operation (a slate's) is no turn's effect.
      execution: () => (scope === null ? currentOperationProfile(this.actorHandle()) ?? { turnId: WORKSPACE_RUN_ID, runId: WORKSPACE_RUN_ID } : { turnId: scope, runId: scope }),
      ledgers: held?.ledgers ?? this.ownLedgers(), external: () => this.mainTurn()?.declared ?? {}, profile: operation,
      driving: this.turnDrivingMetadata(),
      ...(held?.stores !== undefined && { served: held.stores }),
    });
  }

  protected override ownAgentsToolDeps(mode: WorkMode): AgentsToolDeps {
    return this.asRoot((seat, reach, operation) => this.actorAgentsToolDeps(seat, reach, mode, operation));
  }

  /**
   * An agent's delegation: swarms over its own runtime and working context, its subtree's team, and the owner's other
   * workspaces where its reach is external. Rungs are bounded by its own depth; at the cap the team and the search are
   * not offered, so hire/swarm/assign/message/list/dismiss vanish from the enum rather than refusing.
   */
  protected actorAgentsToolDeps(actor: CFSeat, reach: ActorReach, mode: WorkMode, operation: () => OperationProfile | null): AgentsToolDeps {
    const { runtime } = actor;
    // The workspace agent runs on its running or settled profile; any other on the tier its turn resolved.
    const model = reach.kind === 'workspace' ? () => this.getModel() : () => this.ownedModelServices.resolveModel(operation()?.profile.tier.model ?? '');

    // The workspace's own ladder for its agent; any other's own over its own files, as its turns compact in its isolate.
    const compactShared = reach.kind === 'workspace' ? this.compaction().compactShared : hostedActorCompaction(actor, {
      logger: compactionDiagnostics,
      models: { normalize: (spec) => spec || (operation()?.profile.tier.model ?? ''), resolve: model },
      report: (_actor, report) => this.reportModelCall(report),
      operations: this.modelOperations,
    }).extension.compactShared;

    const inputs = operation()?.inputs ?? null;

    const deps: AgentsToolDeps = {
      mode,
      swarm: this.swarmDeps(runtime, model, () => this.agentStores(actor.handle.actorId).workingContext(), compactShared),
      // The workspace agent's, as its turn read the account's catalog; any other's, as its turn resolved.
      swarms: reach.kind === 'workspace' ? this.accountSwarmsHeld : inputs !== null && betaSwarms(inputs.envelope.catalog),
      budget: this.budget,
      // This turn's own resolution: rungs narrow by the role and tier it runs under.
      profile: () => agentsProfileContext(operation()?.profile ?? null, operation()?.inputs ?? null),
    };

    deps.team = this.actorTeam(actor, reach);

    if (reach.kind === 'workspace') deps.peers = this.getPeersToolDeps();

    return deps;
  }

  /** Its subtree's team: the workspace's own roster where its programs reach the workspace's, else its own. What a
   *  capped agent is offered of it is core's (`offered`). */
  private actorTeam(actor: CFSeat, reach: ActorReach): TeamToolDeps {
    return reach.kind === 'workspace' ? this.getTeamToolDeps() : this.hostedTeamToolDeps(actor);
  }

  /** Built from this actor's own roster. */
  private hostedTeamToolDeps(actor: BoundActor): TeamToolDeps {
    const seams = this.hostedSeams();
    const roster = seams.roster(actor);
    roster.ensureSchema();

    return teamToolDepsFor({
      record: actor.record,
      directory: this.workspaceActors(),
      roster,
      runtime: hostedSubagentRuntime(seams, () => actor),
      temporary: seams.temporary(actor),
      inheritedContext: () => this.readInheritedContext(actor.handle),
      originContext: () => this.agentStores(actor.handle.actorId).workingContext(),
      // The workspace's purpose, shared by every actor in it.
      ownMission: () => this.ownMission(),
      rosterMoved: () => { this.liveReadsMoved(ROSTER_READS); },
      broadcastTask: (event) => this.broadcastSubagentEvent({
        kind: 'task',
        ...event,
      }),
      workspaceAgents: () => this.workspaceAgents(true),
      events: new EventLog(this.watchedExec, actor.handle),
    });
  }


  /**
   * The account reads a turn's opening makes, each in flight beside its settings revision read rather than after it:
   * written as its admission or its preparation starts them (`openingAccount`), for that preparation's surface alone,
   * which takes them; its preparation drops what was not taken as it ends, and so do a run's preparation, the agent's
   * rest and its retirement (`openingAccountDropped`). An agent seated nowhere yet reads them as its surface is built.
   */
  private readonly openingPlanes = new Map<string, SourcePlanes>();

  private openingReads(actorId: string): void {
    const seat = this.actorHost().hosted(actorReferenceOf(this.actingAgentOf(actorId)));

    if (seat !== null) this.openingPlanes.set(actorId, this.sourcePlanes(seat, actorReach(actorPolicy(seat.record)), true));
  }

  /**
   * The settings revision read of an idle agent's next opening, with its planes, started as the delivery that opens its
   * work crosses (`admit`): they reach the owner's object before the tile that admission moves, whose write would hold
   * their answers behind its flush. Written there; taken by the agent's next preparation (`openingAccount`); dropped
   * when the agent tells it rests or is retired (`openingAccountDropped`).
   */
  private readonly accountAtOpen = new Map<string, Promise<Exit.Exit<void, KinuError>>>();

  private openingAccountStarted(actorId: string): void {
    if (this.accountAtOpen.has(actorId)) return;
    this.accountAtOpen.set(actorId, this.settingsAtOpen());
    this.openingReads(actorId);
  }

  private settingsAtOpen(): Promise<Exit.Exit<void, KinuError>> {
    return hold(attempt({ doing: "reading the account's settings as an agent's work opens", otherwise: 'unavailable' }, () => this.account.settingsAtOpen()));
  }

  /** A preparation's account reads: those its admission started, or started now; a run's surface takes no planes. Its
   *  caller fails with the read's failure. */
  private async openingAccount(actorId: string, turn: boolean): Promise<Exit.Exit<void, KinuError>> {
    const started = this.accountAtOpen.get(actorId);

    this.accountAtOpen.delete(actorId);

    if (!turn) this.openingPlanes.delete(actorId);
    else if (started === undefined) this.openingReads(actorId);

    return await (started ?? this.settingsAtOpen());
  }

  private openingAccountDropped(actorId: string): void {
    this.accountAtOpen.delete(actorId);
    this.openingPlanes.delete(actorId);
  }

  /** A turn's source reads: its opening's, taken, or started now. */
  private turnPlanes(actorId: string, actor: CFSeat, reach: ActorReach): SourcePlanes {
    const opened = this.openingPlanes.get(actorId);

    if (opened === undefined) return this.sourcePlanes(actor, reach, true);
    this.openingPlanes.delete(actorId);

    return opened;
  }

  /** Its sources' crossings that wait on nothing of a turn's own, started at once: for a `turn`, the account's facts, its
   *  unread mail, the shared Drive's skills and the owner's MCP descriptors where it reaches them; the hub's device check
   *  for an agent on the workspace's lanes. */
  private sourcePlanes(actor: CFSeat, reach: ActorReach, turn: boolean): SourcePlanes {
    const mail = this.ownerMailRead();

    return {
      descriptors: turn && reach.kind === 'workspace' ? this.userMcpDescriptors() : null,
      device: reach.kind === 'workspace' ? actor.runtime.deviceTransport.refreshStatus() : Promise.resolve(),
      facts: turn ? this.account.factsForTurn() : null,
      mail,
      unreadMail: turn ? this.unreadMailOf(actor, mail) : null,
      sharedSkills: turn ? listSharedSkills(actor.runtime.storage.vfs) : null,
    };
  }

  /** An agent's unread mail for its turn, once `owned` says its owner holds an address. */
  private async unreadMailOf(actor: CFSeat, owned: Promise<boolean | null>): ReturnType<typeof unreadMailForTurn> {
    const mail = (await owned) === false ? null : this.mailFor(actor.handle.actorId, actor.record.name);

    return mail === null ? undefined : await unreadMailForTurn(mail, this.name);
  }

  /** Each run seat's own mail read, by the actor it seated: one seat's answer, never another's. */
  private readonly runSeatMail = new WeakMap<SeatedActor, boolean | null>();

  /** Whether the owner holds a mail address now, read off the account's boxes without making one; null where this
   *  deployment has no mail, or the read failed, which is logged. */
  private ownerMailRead(): Promise<boolean | null> {
    const owner = this.getOwnerUserId();

    if ((this.env.EMAIL_DOMAIN ?? '') === '' || owner === null) return Promise.resolve(null);
    const read = attempt({ doing: 'reading whether the owner holds a mail address', otherwise: 'unavailable' }, async () => (await objectNamed(this.env.MAILBOX, owner).boxes()).length > 0);

    return hold(read).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      diagnostics.failure('mail.boxes_read_failed', toKinuError({ doing: 'reading whether the owner holds a mail address', cause: Cause.squash(exit.cause), otherwise: 'unavailable' }), { workspace: this.name });

      return null;
    });
  }

  /**
   * Where an agent's turns are assembled from, read here (core orchestrator/turn-assembly.ts): its own config, pins and
   * lineage, its own skills over its files, the workspace's soul and instruction files, the dynamic block over its held
   * reads. The workspace's planes (its external tools, its evolved text, its missions) only where its reach names them;
   * a run's seat asks with no turn. Its `planes` are started here unless its surface started them.
   */
  protected async actorSources(
    actor: CFSeat, reach: ActorReach, turn: SourcesTurn | null, planes = this.sourcePlanes(actor, reach, turn !== null),
  ): Promise<RunTurnSources> {
    const { runtime } = actor;
    const trust = this.instructionTrust();
    const providers = this.providerRegistry();
    const driving = turn?.surface.item.metadata ?? {};
    const workspace = actorPolicy(actor.record).workspaceAgent;

    // Precondition of the workspace agent's turn, and its soul as the turn reads it.
    if (reach.kind === 'workspace') {
      await this.ensureOwnedScaffold();
      await this.refreshSoulText();
    }

    const inputs = turn?.resolved.inputs ?? await this.profileInputs();
    const choices = ownProfileChoices(actor.stores.config, inputs, this.ancestorProfiles(actor.handle), { explicitTier: turnTags({ metadata: driving }).tier });

    // A failed catalog read answers no tools and the turn runs on its own. The hub's device check refreshes the
    // workspace's executors.
    const [mcp, ownerMail] = await Promise.all([
      planes.descriptors !== null && turn !== null
        ? this.buildUserMcpTools(planes.descriptors)
        : Promise.resolve({}),
      planes.mail ?? Promise.resolve(null),
      planes.device,
    ]);

    const external: ToolSet = reach.kind === 'workspace' ? { ...this.extensions.tools(), ...mcp } : {};

    if (turn !== null) {
      // Its role's own list says which external tools its eval may reach until its profile is bound.
      const role = narrowToolSurface(effectiveRoleCatalog(inputs.envelope.catalog)[turn.resolved.profile.role.id]?.allowedTools);

      turn.surface.reached(external, role.allowsTool('eval') ? Object.fromEntries(Object.entries(external).filter(([name]) => role.allowsTool(name))) : {});
    }

    const identity = await this.promptIdentity();
    const team = this.actorTeam(actor, reach);

    return {
      rt: runtime,
      backend: 'cf',
      executors: () => runtime.executionRouter?.listExecutors() ?? [],
      config: actor.stores.config,
      harnessMode: () => this.config.getHarnessMode(),
      models: {
        catalog: this.modelCatalog,
        normalize: (spec) => providers.normalizeSpecSync(spec),
        // The workspace agent's model is the harness's one override point; any other's resolves as it is named.
        resolve: (spec) => (reach.kind === 'workspace' ? this.turnModel(spec) : this.ownedModelServices.resolveModel(spec)),
        routed: routedModelReads(providers),
      },
      skills: vfsTurnSkills(runtime.storage.vfs, actor.stores.config, trust, {
        ...(turn?.hidesSkills !== undefined && { hides: turn.hidesSkills }), ...(planes.sharedSkills !== null && { shared: planes.sharedSkills }),
      }),
      profileInputs: async () => inputs,
      choices,
      ancestors: () => this.ancestorProfiles(actor.handle) ?? [],
      agentsActions: () => agentsActionsFor({ swarm: {}, swarms: betaSwarms(inputs.envelope.catalog), team, ...(reach.kind === 'workspace' && { peers: {} }) }),
      temporaryAsk: () => team?.temporary !== undefined,
      soul: async () => (reach.kind === 'workspace' ? this.getSoulText() : await this.loadSoulText()),
      agentsMd: (window) => this.workspaceAgentsMd(window, trust),
      // Presentation from the policy: the workspace agent speaks as the workspace, any other as a named agent of it.
      identity: async () => (workspace ? identity : { ...identity, agent: actor.stores.config.getDisplayName() ?? actor.record.name }),
      memoryTail: () => readMemoryTail(runtime.memory),
      artifacts: () => turn?.artifacts ?? artifactOverrides(currentArtifacts(this.boundSql, actor.handle)),
      taskPlan: () => null,
      conversationKey: () => conversationKey(this.ownedModelServices.affinityKey, workspace ? CHAT_SESSION_ID : actor.record.actorId),
      ...(reach.kind === 'workspace' && { budget: this.budget, observeStream: (chunks) => this.chatTransport.observe(chunks) }),
      operations: this.modelOperations,
      scaffoldSpend: { source: 'scaffold', report: (report) => this.reportModelCall(report), operations: this.modelOperations },
      attachmentBudget: turn?.surface.ledgers.context ?? turnLedgers().context,
      extensions: () => (reach.kind === 'workspace' ? this.extensions.list() : []),
      accountFacts: () => planes.facts ?? this.account.factsForTurn(),
      mail: () => planes.unreadMail ?? this.unreadMailOf(actor, Promise.resolve(ownerMail)),
      dynamic: (reads) => (profile, tools) => this.actorDynamicContext(actor, reach, { profile, tools, reads, surface: turn?.surface ?? null }),
      operation: (profile, operationInputs) => captureOperationProfile({
        actor: actor.handle, profile, inputs: operationInputs, runId: turn?.surface.key.runId ?? WORKSPACE_RUN_ID, turnId: turn?.surface.key.turnId ?? null,
      }),
    };
  }

  /** The workspace journal keeps split ancestry and step reports together. */
  private async runHostedSplit(parent: HeadInput, request: HeadSplitRequest): Promise<HeadSplitResult> {
    const journal: HeadJournalPort = {
      recordSplit: async (rootId, rationale, spawnedAt) => { await this.headJournalRecordSplit(rootId, rationale, spawnedAt); },
      insertSpawn: async (childInput) => { await this.headJournalInsertSpawn(childInput); },
      recordReport: async (report) => { await this.headJournalRecordReport(report); },
      cacheMerge: async (rootId, narrative) => { await this.headJournalCacheMerge(rootId, narrative); },
    };

    const runtimeForSplit = this.getCFHeadRuntime();

    if (runtimeForSplit === undefined) throw unownedWorkspace();

    return await runHeadSplit(new HeadController(runtimeForSplit, journal, REAL_CLOCK), parent, request);
  }

  /**
   * Reached by RPC, or via `fetch` for a WebSocket upgrade, which cannot cross RPC as a 101. A preview opens only for
   * the workspace's owner, its own browsers and fetches ({@link PREVIEW_SELF}) and a slate picture's capture, so a
   * slate's calls, which run as the owner, run for no one else; this is decided before anything of the slate starts.
   */
  async routeWorkspacePreview({ port, handle, pathname, viewer }: PreviewVisit, request: Request): Promise<Response> {
    const owner = this.getOwnerUserId();
    const admitted = viewer === PREVIEW_SELF || (owner !== null && viewer === owner) || this.pictures.captures(port, handle, Date.now());

    if (admitted) return await this.hostedWorkspace().routePreview(port, handle, request, pathname);
    diagnostics.event('preview.route.refused', { port, handle, reason: viewer === null ? 'no-viewer' : 'not-owner', owner: '', detail: '' });
    const entry = viewer === null && isNavigation(request) ? previewEntryUrl(this.env, request.url) : null;
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

    // A page load is sent to the app, which signs its visitor in and sends the owner back; a script's request is refused.
    if (entry !== null) return new Response(null, { status: 303, headers: { ...headers, location: entry } });

    return new Response(previewRefusalText(await this.hostedWorkspace().servesSlate(port)), { status: 403, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  }

  /** What the app's preview entry tells `userId` (`nimbus-route.ts`): a read, which never claims the workspace. */
  async previewAccess(userId: string, port: number): Promise<PreviewAccess> {
    return { owned: this.getOwnerUserId() === userId, slate: await this.hostedWorkspace().servesSlate(port) };
  }

  /**
   * Partyserver owns `fetch` for chat, so preview upgrades are answered first; the capability
   * handle is rechecked inside `routePreview`. Share sockets likewise; `routeShare` admits by the share row.
   */
  private readonly _forwarded = new Hono({ getPath: rawPath })
    .all(`${WORKSPACE_PREVIEW_PATH}/*`, beneath(WORKSPACE_PREVIEW_PATH, async (c) => {
      // The viewer segment is the one the edge wrote: empty when the visitor carried no verified cookie.
      const [port, handle, viewer, ...rest] = c.req.path.slice(WORKSPACE_PREVIEW_PATH.length + 1).split('/');
      const parsed = Number(port);

      if (!Number.isInteger(parsed) || !handle || viewer === undefined) {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }

      const visit = { port: parsed, handle, pathname: `/${rest.join('/')}`, viewer: viewer === '' ? null : decodeURIComponent(viewer) };

      return await this.routeWorkspacePreview(visit, c.req.raw);
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

    const url = new URL(ctx.request.url);

    // The pane's session rides the query, as the computer's and a PC's do: its terminal is keyed by it.
    return url.pathname === WORKSPACE_TERMINAL_PATH ? [WORKSPACE_TERMINAL_TAG, ...workspaceSessionTag(url.searchParams.get('session')), ...tags] : tags;
  }

  /** A terminal socket carries only shell frames, not the SDK's identity, state and MCP frames. */
  override shouldSendProtocolMessages(_connection: Connection, ctx: ConnectionContext): boolean {
    return new URL(ctx.request.url).pathname !== WORKSPACE_TERMINAL_PATH;
  }

  protected override async terminalFor(connection: Pick<Connection, 'tags'>): Promise<WorkspaceTerminal | null> {
    if (!isWorkspaceTerminal(connection.tags)) return null;
    this.mountRootFiles();

    return (await this.hostedWorkspace().terminals()).terminal(workspaceSessionOf(connection.tags));
  }

  /** The root's file plane registers the mount table a shell serves, and it is made with the root's runtime. */
  private mountRootFiles(): void {
    void this.rt;
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
      : new Map(Object.entries(await this.mainCall((isolate, snapshot) => isolate.drainAnswers(snapshot, leases))));
  }

  /**
   * The owed-work probes over this object's own tables, held across a turn's wake decisions (the open, each report and
   * the rest ask all of them). Each names its table's writers; their statements pass `sql` or `watchedExec`, which drop it.
   */
  private readonly owedProbes = {
    // EventLog's lease writes (markConsumed, releaseLease, unbindStale), every one over `watchedExec`.
    openDrainLease: this.held.hold(['agent_log'], () => this.eventLog.hasOpenDrainLease()),
    // LiveHeadJournal over `sql`.
    unfinishedHeads: this.held.hold(['head_journal'], () => this.headJournal.hasUnfinishedHeads()),
    // MctsSearchStore over `sql`.
    runningSwarms: this.held.hold(['mcts_search_runs'], () => this.mctsSearchStore.hasRunningSwarms()),
    // WorkspaceActorDirectory's insert and transitionRetirement over `sql`.
    retirements: this.held.hold(['workspace_actors'], () => this.workspaceActors().hasRetirements()),
    // Every SubagentRosterStore over `watchedExec`.
    pendingBirths: this.held.hold(['actor_subagents'], () => this.subagentRoster.hasPendingBirths()),
    pendingDeletions: this.held.hold(['actor_subagents'], () => this.subagentRoster.hasPendingDeletions()),
    // sendChangeNotes and its retire over the runtime's `sql`.
    changeNotes: this.held.hold(['change_notes_outbox'], () => owesChangeNotes(this.rt)),
  };

  /**
   * One `LIMIT 1` read per store, all read so the wake can name them. Runs in the init gate;
   * interpreting a lease is left to {@link owedDeliveryWork}.
   */
  protected override owedUntimedArms(): Required<UntimedArms> {
    const probes = this.owedProbes;

    return {
      openDrainLease: probes.openDrainLease(),
      // Interrupted terminal sequence with no retry instant; one awaiting a retry is timed (`nextOwedAt`).
      terminalIncomplete: this.terminal.hasIncomplete() && this.terminal.nextRetryAt() === null,
      unfinishedHeads: probes.unfinishedHeads(),
      runningSwarms: probes.runningSwarms(),
      retirements: probes.retirements(),
      pendingBirths: probes.pendingBirths(),
      pendingDeletions: probes.pendingDeletions(),
      agentTurns: this.agentTurns.inFlightAny(),
      // Main's chat, in its own isolate: work handed to it that it has not yet said it rests from.
      chatLoop: this.agentWakes.armed(this.actorHandle().actorId),
      changeNotes: probes.changeNotes(),
    };
  }

  /** Soonest instant a timed ledger (terminal retry, deferred job resume) owes a wake, or null.
   * Untimed owed work is excluded; it is {@link owedUntimedWork}. */
  protected override nextOwedAt(): number | null {
    const at = Math.min(this.workOwedAt() ?? Infinity, this.overview.retryAt ?? Infinity, this.forkNotices.nextDueAt() ?? Infinity);

    return Number.isFinite(at) ? at : null;
  }

  /** A tile push owed would read Unfinished. */
  private workOwedAt(): number | null {
    const at = Math.min(this.terminal.nextRetryAt() ?? Infinity, this.jobRunner.nextResumeAt() ?? Infinity);

    return Number.isFinite(at) ? at : null;
  }

  /** One the owner added has its own Stop; the rest is core's `stopAgentsBelow`, its task agents retired with their hires. */
  protected override stopSubtree(actorId: string): void {
    const seams = this.hostedSeams();
    const directory = this.actorDirectoryStore();
    const below = stoppedBelow(directory.list(), actorId);

    if (below.length === 0) return;
    // Each stopped agent's commands, through the sweep its own Stop makes.
    this.detachOwned(Effect.forEach(below, (actor) => this.stopAgentDevices(actor.actorId), { concurrency: 'unbounded', discard: true }));

    this.detachOwned(Effect.promise(() => stopAgentsBelow(actorId, {
      directory,
      roster: (hirer) => seams.roster(this.actorHost().bindStores(hirer)),
      retire: (owner, retirement) => this.actorHost().retire(owner, retirement),
      // What it was owed and had not taken is cancelled, and the work it carried dismissed.
      cancelOwed: (actor) => {
        for (const cancelled of this.deliveries.cancel(actor.actorId)) {
          for (const event of this.carried(actor.actorId, cancelled)?.events ?? []) event.log.dismiss(event.id, 'stopped by the owner', 'system');
        }
      },
      stopTurn: async (actor) => {
        if (await this.agentTurns.holdsTurn(actor.actorId)) {
          await this.agentTurns.beforeRetirement(actor.actorId, true);

          return true;
        }

        // One that may hold a question to its owner is stopped though its wake does not stand: the queue a question holds
        // arms none, and an isolate that ended since keeps only the question, which the Stop dismisses.
        if (this.holdsQuestions(actor.actorId)) await this.agentTurns.interrupt(actor.actorId, null);

        return false;
      },
    })));
  }

  /** A waiting hired agent holds no transcript; its rows reopen it. A running job keeps its runtime to the settle's turn,
   *  and an agent whose isolate has not yet told this workspace it rests keeps it too: a closing effect calls it. */
  private releaseIdleHosted(reference: ActorReference): void {
    if (this.actorHost().hosted(reference) === null || this.hostedTurnInFlight(reference) || this.agentWakes.armed(reference.actorId)) return;

    if ((this.jobAuthorities.live(reference.actorId)?.runner.inFlight ?? 0) > 0) return;
    this.actorHost().release(reference);
  }

  /** The agents whose events drain to them: the workspace's own and every hire, each into a turn of its own. */
  private reactingAgents(): WorkspaceActor[] {
    // `list()` holds live actors only.
    return this.workspaceActors().list().filter((record) => actorPolicy(record).workspaceAgent || isSubagentOrigin(record.origin));
  }

  private reactionsDueAt(now: number): number | null {
    const due = this.reactingAgents()
      .map((record) => new EventLog(this.watchedExec, this.actorHost().bindStores(actorReferenceOf(record)).handle).nextPendingDrainAt(now) ?? Infinity);

    const at = Math.min(Infinity, ...due);

    return Number.isFinite(at) ? at : null;
  }

  private drainDueReactions(now: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const record of this.reactingAgents()) {
        const reference = actorReferenceOf(record);
        const log = new EventLog(this.watchedExec, this.actorHost().bindStores(reference).handle);
        const dueAt = log.nextPendingDrainAt(now);

        if (dueAt === null || dueAt > now) continue;

        yield* Effect.tryPromise({
          try: () => this.drainAgent(reference),
          catch: (cause) => authoredRefusal({ doing: 'draining an agent', cause }),
        }).pipe(Effect.catch((failure) => Effect.sync(() => {
          diagnostics.failure('event.wake_drain_failed', failure, { workspace: this.name, actor: record.name });
        })));
      }
    });
  }

  /** One agent's due reactions; failure rejects with a classified error. */
  drainAgent(reference: ActorReference): Promise<void> {
    return settle(attempt({ doing: 'draining an agent\'s reactions this wake was armed for', otherwise: 'io' }, async () => {
      // Its due events, bound to their turn in the commit that owes them to it: no session of it is opened here.
      const log = new EventLog(this.watchedExec, this.actorHost().bindStores(reference).handle);

      await this.agentDeliveries(reference.actorId).commit(() => pendingEventsDelivery(log, Date.now()));
    }));
  }

  /**
   * The turns an earlier activation handed to agents' own isolates and never heard end. Each such agent recovers
   * its own claims and its stalled turns retire; the rest re-pend by their leases.
   */
  private fencedTurnsRecovered = false;

  recoverAgentTurns(): Promise<void> {
    const open = new AgentOpenTurns(this.boundSql);
    const byAgent = new Map<string, AgentOpenTurn[]>();

    for (const turn of open.openedBefore(this.activationStartedAt)) byAgent.set(turn.actorId, [...byAgent.get(turn.actorId) ?? [], turn]);

    // Once an activation: a chat turn whose run an earlier one admitted and never heard end, whose agent's isolate may
    // have gone with it.
    if (!this.fencedTurnsRecovered) {
      this.fencedTurnsRecovered = true;

      for (const actorId of new TurnFences(this.boundSql).openActors()) {
        if (this.liveActor(actorId)) byAgent.set(actorId, byAgent.get(actorId) ?? []);
      }
    }

    return settle(Effect.forEach([...byAgent], ([actorId, turns]) => logged(
      'subagent.agent_recovery_failed',
      { doing: "recovering the turns an agent's own isolate held when the workspace reset", otherwise: 'io' },
      async () => {
        // Its chat takes up the turn it held, recovered first; the wake is held a lap ahead until it answers what it owes.
        if (isSubagentOrigin(this.actingAgentOf(actorId).origin)) {
          await this.agentWakes.arm(actorId, Date.now() + RECOVERY_BACKOFF_CEILING_MS);
          await this.wakeAgent(actorId, { recover: true });
        } else {
          await this.recoverAgent(actorId, []);
        }

        for (const turn of turns) open.close(turn);
      },
      { workspace: this.name, actor: actorId },
    ), { discard: true }));
  }

  /** `recover`: its own wake, or this activation's recovery: a turn its isolate lost is taken up, or retired. */
  private async wakeAgent(actorId: string, opts: { readonly recover: boolean } = { recover: false }): Promise<void> {
    if (!this.liveActor(actorId)) {
      // Retired: what it was owed is cancelled with its wake.
      this.deliveries.cancel(actorId);

      return await this.agentWakes.owes(actorId, null);
    }

    // A deletion's quiet stops what runs and closes it; it wakes nothing to take up more.
    if (this.admitting.signal.aborted) return;
    // What the agent is owed crosses first: a delivery whose crossing died is taken before the agent drives.
    await this.coordinator.drain(actorId);

    // A turn its isolate lost is taken up, or, cut off too often, retired and its hirer told.
    if (opts.recover) await this.recoverAgent(actorId, []);
    await this.agentCall(actorId, (isolate, snapshot) => isolate.wake(snapshot));
  }

  private async recoverAgent(actorId: string, turnIds: readonly string[]): Promise<boolean> {
    const record = this.actorDirectoryStore().retained(actorId);

    if (record === null || record.retiringAt !== null || record.deletedAt !== null) return false;
    const recovered = await this.agentCall(actorId, (isolate, snapshot) => isolate.recover(snapshot));

    if (!isSubagentOrigin(record.origin)) return false;

    for (const turn of recovered.stalled) await retireStalledTask(this.hostedSeams(), await this.actorHost().acquire(actorReferenceOf(record), { kind: 'actor' }), turn);

    return recovered.stalled.some((turn) => turnIds.includes(turn.turnId));
  }

  /**
   * Resend the reply an answered event batch never dispatched; the outbox key makes a resend idempotent.
   * Must run before the unbind sweep so an answered batch is finished rather than re-asked.
   */
  protected override async owedDeliveryWork(): Promise<void> {
    // Order: sweep with the answered set excluded, then replies, then the terminal replay
    // (which closes the same leases when it finishes a transition).
    let owed: ReadonlyMap<string, string> = new Map<string, string>();

    await settleLogged('event.stale_delivery_unbind_failed', { doing: 'unbinding event deliveries a dead activation left leased', otherwise: 'io' }, async () => {
      owed = await this.owedDrainReplies();

      const reconciledEventIds = this.eventLog.unbindStale(
        STALE_EVENT_DELIVERY_MS, Date.now(), new Set(owed.keys()),
      );

      if (reconciledEventIds.length > 0) {
        diagnostics.event('event.deliveries_repended', { workspace: this.name, events: reconciledEventIds.length });
        // Owed again now: delivered to main as any due reaction is, not left to the next alarm.
        await this.drainAgent(actorReferenceOf(this.actingAgentOf(this.actorHandle().actorId)));
      }
    }, { workspace: this.name });

    // One reply's failure leaves only its lease open (keeping the wake armed for it);
    // the other owed replies and the terminal replay below still run.
    for (const [drainTurnId, answer] of owed) {
      await settleLogged('event.owed_reply_failed', { doing: 'finishing an event reply a drained turn still owes', otherwise: 'io' }, async () => {
        const closed = await this.completeEventBatch(drainTurnId, answer);
        diagnostics.event('event.owed_reply_resumed', { drainTurnId, closed });
      }, { drainTurnId });
    }

    this.deliverForkNotices();
    await deliverOwedChangeNotes(this.rt, this.changeNotesChat, (failure) => {
      diagnostics.failure('change_notes.delivery_failed', failure);
    });
    await super.owedDeliveryWork();
  }

  private _engine: EvolutionEngine | null = null;
  private _emailOutbox: EmailOutbox | null = null;
  /** Outbound-email intent log (SPEC §7.4); creates its own table on first use. */
  private get emailOutbox(): EmailOutbox {
    this._emailOutbox ??= new EmailOutbox(this.ctx.storage.sql, (at) => this.wakes.arm(KINU_TIMER_JOB, at));

    return this._emailOutbox;
  }

  /** Parked commands, held: DeferredApprovalStore's create, decide, spend and settle run over `sql`, which drops them. */
  private readonly queuedApprovals = this.held.hold(['owner_requests'], () => this.deferrals.approvals());

  private readonly consentApprovals = this.held.hold(['owner_requests'], () => this.consents.approvals());

  /** Approvals combine device consent asks and parked commands; a parked command's effect has not happened. */
  protected override extraDynamicContext(): ActorDynamicContextExtras {
    return {
      approvals: () => {
        const items = [...this.consentApprovals(), ...this.queuedApprovals()];

        return { items, total: items.length };
      },
      extraMissingCapabilities: () => {
        const deafInbox = this.email.inbox.dropNotice(Date.now());

        return deafInbox ? [deafInbox] : [];
      },
      failingSlates: () => this.slateHosting.builds.failing(ROOT_SLATE_CALLER.cred).map(({ slate, failure }) => `${slate}: ${failure}`),
    };
  }

  // Steer-as-Branch redirects against the in-flight turn; settle into Alternate Takes on completion.
  protected _pendingBranches: PendingBranch[] = [];

  private _triggerRegistry: TriggerRegistry | null = null;
  /** Where this object's watchers check, one check per trigger at a time (watch.ts). */
  private readonly watching = {
    run: (check: WatchCheck, state: JsonValue | undefined, input: JsonValue | undefined) => this.watchCheck(check, state, input),
    claims: new WatchClaims(),
  };
  private _replyChannels: ReplyChannelStore | null = null;
  private readonly warmingLanes = new Map<string, CacheWarmingLane>();

  /** The lane keeping an agent's prompt cache warm, keyed by the agent: its own row, its own wake. */
  private warmingOf(actorId: string): CacheWarmingLane {
    const held = this.warmingLanes.get(actorId);

    if (held !== undefined) return held;

    const lane = new CacheWarmingLane({
      store: new CacheWarmStore(this.boundSql, this.agentBound(actorId).handle),
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

    this.warmingLanes.set(actorId, lane);

    return lane;
  }

  /** The soonest warm any live agent is owed. */
  private nextWarmAt(): number | null {
    const due = armedWarms(this.boundSql).filter((warm) => this.liveActor(warm.actorId)).map((warm) => warm.dueAt);

    return due.length === 0 ? null : Math.min(...due);
  }

  /** Each live agent's warm owed by now, in turn; whether any was sent. */
  private async runDueWarms(now: number): Promise<boolean> {
    let warmed = false;

    for (const warm of armedWarms(this.boundSql)) {
      if (warm.dueAt > now || !this.liveActor(warm.actorId)) continue;

      if (await this.warmingOf(warm.actorId).runDue(now) !== null) warmed = true;
    }

    return warmed;
  }

  /**
   * A watcher's check: its program over the workspace agent's own reads, observing only, offline, within the alarm's
   * wall. Its answer decides whether the agent wakes (watch.ts); a program that throws, answers off its shape or runs
   * past the wall parks the watcher until its code changes.
   */
  private async watchCheck(check: WatchCheck, state: JsonValue | undefined, input: JsonValue | undefined): Promise<WatchOutcome> {
    const began = Date.now();
    // Read as its role reads in Plan: a check reaches nothing its agent's own programs could not.
    const namespaces = this.ownNamespaces('plan');
    const authority = await this.slateAuthority('plan', namespaces);
    const providers = watchProviders(authority.reach.narrowProviders(namespaces), check.reads ?? []);
    const unread = (check.reads ?? []).filter((name) => !providers.some((provider) => provider.name === name));

    if (unread.length > 0) return { kind: 'parked', reason: 'program', detail: `its check reads ${unread.join(', ')}, which this agent cannot read in Plan` };
    const given = `const state = ${JSON.stringify(state ?? null)};\nconst input = ${JSON.stringify(input ?? null)};\n`;
    const ran = await this.rt.executor.execute(`${given}${check.code}`, providers, { deadlineMs: ALARM_PROGRAM_WAIT_MS });

    if (ran.error !== undefined) {
      return { kind: 'parked', reason: Date.now() - began >= ALARM_PROGRAM_WAIT_MS ? 'overran' : 'program', detail: ran.error.slice(0, 2_000) };
    }

    const answer = checkAnswerOf(ran.result);

    return answer === null
      ? { kind: 'parked', reason: 'program', detail: 'its check answered neither { fire: false, state? } nor { fire: true, brief, state? }' }
      : { kind: 'answered', answer };
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

  protected override mailFor(actorId: string, name: string): MailDeps | null {
    const owner = this.getOwnerUserId();

    if ((this.env.EMAIL_DOMAIN ?? '') === '' || owner === null) return null;

    return {
      caller: () => ({ workspace: this.name, title: this.safeDisplayName(), mainActorId: this.actorHandle().actorId, actorId, name }),
      mailbox: () => objectNamed(this.env.MAILBOX, owner),
      // An agent's message waits in this workspace's one queue, as every parked action does; its agent is woken by the answer.
      approvals: {
        ask: (id, send) => exactAnswer(this.deferrals.mailSend(id, send, actorId)),
        take: (id) => this.deferrals.takeMailSend(id, actorId),
        settle: async (spend, outcome) => this.deferrals.settle(spend, outcome, actorId),
      },
    };
  }

  /**
   * `google.*` through the owner's Google connection, where the deployment has its client: a read is made by the
   * account at once; a write waits in this workspace's one queue, as an agent's message does, and is made once on approval.
   */
  protected override googleFor(actorId: string, name: string): GoogleDeps | null {
    if (googleConnectionClient(this.env) === null || this.getOwnerUserId() === null) return null;

    return {
      by: () => (actorId === this.actorHandle().actorId ? this.safeDisplayName() : name),
      send: async (request) => await this.requireOwnerUserDO().googleCall(await this.userCaller(), request),
      readMail: async (raw) => await readOutgoing(raw),
      held: async () => (await this.requireOwnerUserDO().googleConnection(await this.userCaller())) !== null,
      approvals: {
        ask: (id, write) => exactAnswer(this.deferrals.googleWrite(id, write, actorId)),
        take: (id) => this.deferrals.takeGoogleWrite(id, actorId),
        settle: async (spend, outcome) => this.deferrals.settle(spend, outcome, actorId),
      },
    };
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


  protected get peerHub(): PeerHub {
    this._peerHub ??= new PeerHub({
      sql: this.ctx.storage.sql,
      log: this.eventLog,
      replyChannels: this.replyChannels,
      vfs: () => this.rt.storage.vfs,
      selfAgentName: () => this.name,
      selfUserId: () => this.requireOwner(),
      deliver: async (receiverAgentName, msg) => {
        const stub = this.env.OrchestratorAgent.get(
          this.env.OrchestratorAgent.idFromName(receiverAgentName),
        );

        return await stub.receivePeerMessage(msg);
      },
      isSameOwner: async (senderUserId) => senderUserId === this.getOwnerUserId(),
      scheduleDispatch: (at) => this.wakes.arm(KINU_TIMER_JOB, at),
      onAdmitted: () => { this.armDurableWake(); },
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
      this.reactionsDueAt(now),
      this.nextWarmAt(),
      // Sleep-time triggers (phase `alarm.sleep_time`); answers only while an unprocessed turn is recorded,
      // and the phase releases that record whenever it refuses.
      this.sleepTime.nextWakeAt(),
      this.pictureCapture() === null ? null : this.pictures.nextDueAt(),
    );
  }

  /** `reason` names the obligation that asked for the wake and how an arm failure is reported. */
  private armOwedWorkWake(reason: keyof typeof WAKE_ARM_FAILURE): void {
    const failure = WAKE_ARM_FAILURE[reason];

    this.detachOwned(logged(failure.event, { doing: failure.doing, otherwise: 'io' }, () => this.scheduleTerminalRetry(Date.now()), { workspace: this.name }));
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
    this.detachOwned(logged('schedule.durable_wake_arm_failed', { doing: 'arming the wake a pending reaction needs', otherwise: 'io' }, () => this.wakes.arm(KINU_TIMER_JOB, next), { workspace: this.name }));
  }

  /** Every pass runs (no short-circuit): each owns a different table and is budgeted and idempotent. */
  protected override maintenanceSweeps(): boolean {
    return this.reconcileOrphanedBranches();
  }

  protected get engine(): EvolutionEngine {
    if (!this._engine) {
      // Main's conversation is its own isolate's: a rating reads its turn from there.
      this._engine = new EvolutionEngine(this.rt, (messageId) => this.mainTurnPair(messageId), {
        // Verdict row, craft scores, tombstone and announcement commit as one unit via transactionSync.
        transaction: (body) => { this.ctx.storage.transactionSync(body); },
        // The turn review's model calls debit the reviewed turn's mission; unbudgeted turns never reach it.
        governor: this.budget,
        // Whether a dream's skill is in effect, for the rater's list of changes the turn ran with.
        ...(this.refinementDeps.approvals !== undefined && { approvals: this.refinementDeps.approvals }),
      });
      this._engine.onEvent((event) => {
        if (event.type !== 'changelog_digest') return;
        this.email.ownerNotification('Evolution changelog digest', event.message);
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
    // This object is its roster's one writer: the directory holds what it reads.
    this._actorDirectory = new WorkspaceActorDirectory(this.boundSql, {
      workspaceId: this.ctx.id.toString(),
      get ownerUserId() { return owner(); },
    }, { holdRows: true });

    return this._actorDirectory;
  }

  protected actorHandle(): ActorHandle {
    if (this.storageRefusal !== undefined) throw this.storageRefusal;

    return this._rootActor ??= this.workspaceActors().main();
  }

  private readonly actorRetirementsInFlight = joining<string, ActorDirectoryResult>();

  async actorDirectory(operation: ChildActorOperation): Promise<ActorDirectoryResult> {
    const { actorId, workspaceId, parentActorId } = this.actorHandle();

    return this.runActorDirectory({ actorId, workspaceId, parentActorId }, [], operation);
  }

  applyActorDirectory(caller: ActorReference, path: readonly string[], operation: ChildActorOperation): Promise<ActorDirectoryResult | Refusal> {
    return settle(Effect.gen({ self: this }, function* () {
      return yield* Effect.catchCause(Effect.gen({ self: this }, function* () {
        return yield* Effect.promise(async () => this.runActorDirectory(caller, path, operation));
      }), refusing('applying a root actor directory operation', 'io'));
    }));
  }

  private async runActorDirectory(caller: ActorReference, path: readonly string[], operation: ChildActorOperation): Promise<ActorDirectoryResult> {
    this.requireOwner();
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
    const pending = this.actorRetirementsInFlight.inFlight(input.reference.actorId);

    if (pending) {
      directory.apply(caller, path, input);

      return await pending;
    }

    const retirement = this.actorRetirementsInFlight(input.reference.actorId, async (): Promise<ActorDirectoryResult> => {
      const entry = directory.apply(caller, path, input);
      await this.scheduleTerminalRetry(Date.now());
      // The host does the whole physical retirement in one call: runtime objects, `actor_id` rows in
      // the retirement transaction, and on destroy the home and `.kinu/agents/<key>/` subtree.
      await this.actorHost().retire(caller, {
        reference: input.reference, name: input.name, destroy: true, interrupt: true,
      });

      return entry.state === 'deleted' ? entry : directory.apply(caller, path, { action: 'release', name: input.name, reference: input.reference });
    });

    try {
      return await retirement;
    } catch (cause) {
      throw toKinuError({ doing: 'retiring an actor and its physical storage', cause, otherwise: 'io' });
    }
  }

  /** The edge's one resolution of a name or `/`-joined path to the actor id everything downstream keys on. */
  resolveHostedActorRoute(target: string): Promise<{ ok: true; actorId: string } | Refusal> {
    return settle(Effect.catchCause(
      Effect.map(this.hostedChild(target), ({ child }) => ({ ok: true as const, actorId: child.handle.actorId })),
      refusing('resolving a hosted actor chat path', 'io'),
    ));
  }

  /** Each step a live subagent its parent's roster still employs: a dismissal keeps rows, not chat. */
  private hostedTarget(target: string): HostedTarget | null {
    const directory = this.workspaceActors();
    let parent = this.actorHandle();
    let found: HostedTarget | null = null;

    for (const name of target.split('/')) {
      const handle = directory.resolveChild(parent, name);
      const entry = handle === null ? null : this.rosterOf(parent).get(name);

      if (handle === null || entry === null || entry.status === 'dismissed' || entry.actorReference?.actorId !== handle.actorId) return null;

      const retained = directory.retained(handle.actorId);

      if (retained === null || !isSubagentOrigin(retained.origin)) return null;
      found = { handle, entry };
      parent = handle;
    }

    return found;
  }

  private rosterOf(parent: ActorHandle): SubagentRosterStore {
    return new SubagentRosterStore(this.watchedExec, parent);
  }

  protected override hostedWindowName(actorId: string): string | null {
    const directory = this.workspaceActors();
    const names: string[] = [];
    let row = directory.retained(actorId);

    // Its hirers' names down to it; the tree's root names no segment, its room being the workspace's.
    while (row !== null && row.parentActorId !== null) {
      names.unshift(row.name);
      row = directory.retained(row.parentActorId);
    }

    // An ancestor gone: no path addresses it.
    if (row === null) return null;

    return names.length === 0 ? null : names.join('/');
  }

  /**
   * The roster is the authority here: directory validation ran at the edge, and dismissal can change under an
   * open socket. The opening row uses the client's id so `admitted` recognises resent lists.
   */
  protected override transcriptFor(actor: ActorHandle): SessionTranscript {
    return this.actorHost().bindStores(actor).stores.history.transcript(CHAT_SESSION_ID);
  }

  /** Every agent's conversation is its own isolate's, main's included (D9). */
  protected override async readInheritedContext(actor: ActorHandle = this.actorHandle()): Promise<SerializedMessage[]> {
    return await this.agentCall(actor.actorId, (isolate, snapshot) => isolate.inheritedContext(snapshot));
  }

  /** The agent as its window addresses it: a hire by the path its roster resolves, the tree's root by its own row. */
  private hostedReference(actorId: string): ActorReference | null {
    const record = this.actorDirectoryStore().retained(actorId);

    if (record === null) return null;

    if (record.parentActorId === null) return actorReferenceOf(record);
    const path = this.hostedWindowName(actorId);
    const actor = path === null ? null : this.hostedTarget(path);

    return actor?.handle.actorId === actorId ? actor.entry.actorReference : null;
  }

  protected override async hostedAdmit(actorId: string, { id, ...words }: SentWords & { readonly id: string }): Promise<void> {
    await this.deliverWords(actorId, { id, input: { kind: 'words', ...words }, authorship: 'owner' }, false);
  }

  protected override workspaceAgentDeliveries(): AgentOrchestratorDeps['deliveries'] {
    return this.agentDeliveries(this.actorHandle().actorId);
  }

  /** An agent's deliveries as its orchestrator sends signals through them: each a delivery its room hears carded. */
  private agentDeliveries(actorId: string): AgentOrchestratorDeps['deliveries'] {
    return this.coordinator.port(actorId, (event) => { this.detachOwned(Effect.promise(() => this.hostedChatEvent(actorId, { type: 'broadcast', event }))); });
  }

  private get deliveries(): AgentDeliveries {
    return new AgentDeliveries(this.boundSql);
  }

  /** An agent's newest opening, held per agent: TurnFences' open, cancel, offer and ended run over `sql`, which drops it. */
  private readonly heldFence = this.held.holdEach(['actor_turn_fence'], (actorId: string) => new TurnFences(this.boundSql).row(actorId));

  /** Whether an agent is owed a delivery, held per agent: AgentDeliveries' add, paid and cancel run over `sql`, which drops it. */
  private readonly deliveriesOwed = this.held.holdEach(['agent_deliveries'], (actorId: string) => this.deliveries.owes(actorId));

  /**
   * Every delivery this workspace owes its agents (design v2 §1, v3 A), on core's one path: committed with its producer's
   * fact, its wake armed from the owed row, and crossed behind everything owed before it.
   */
  private readonly coordinator = new DeliveryCoordinator({
    sql: this.boundSql,
    transaction: (body) => this.ctx.storage.transactionSync(body),
    wake: (actorId, at) => this.owedWake(actorId, at ?? Date.now() + RECOVERY_BACKOFF_CEILING_MS),
    admit: async (actorId, delivery) => {
      // An agent at rest opens its work on what crosses: its opening's account reads go out ahead of its tile.
      if (!this.agentsWorking.has(actorId)) this.openingAccountStarted(actorId);
      let working = false;

      try {
        const { answer, owes } = await this.preArmed(actorId, () => this.agentCall(actorId, (isolate, snapshot) => isolate.admit(snapshot, delivery)));

        working = owes?.report.working === true;

        // What it owes once it took the input, carried by the answer.
        if (owes !== null) await this.agentOwes(actorId, owes);

        return answer;
      } finally {
        // No work opened on it: a later opening reads the account as it is then.
        if (!working) this.openingAccountDropped(actorId);
      }
    },
    eventLog: (actorId) => new EventLog(this.watchedExec, this.agentBound(actorId).handle),
    live: (actorId) => this.liveActor(actorId),
    refused: async (actorId, delivery, failure) => {
      const assigned = v.safeParse(AssignmentMetadataSchema, deliveryMetadata(delivery));

      if (!assigned.success) return false;
      await this.hireCouldNotRun(actorId, { sequenceId: delivery.id, mode: assigned.output.kinuMode }, renderThrownChain({ cause: failure }));

      return true;
    },
  });

  /**
   * An owner's intent (D6): committed with the agent's wake, crossed as any input is, and answered with what the agent did
   * with it, as a direct call was. A crossing that does not reach the agent leaves it owed, answered `owed`: the agent's
   * wake delivers it once, and the owner's views show it on its way (`listOwedIntents`) until then. One the agent applied
   * whose answer was lost is answered again with what it did. A refusal is the agent's own, told as it said it.
   */
  private async ownerIntent(actorId: string, delivery: Delivery): Promise<IntentResult | OwedIntent> {
    const crossed = await this.coordinator.deliverNew(actorId, delivery);
    const answer = Promise.withResolvers<IntentResult | OwedIntent>();

    // The same intent from another view, already on its way: that view hears its answer.
    if (crossed === null) answer.reject(new KinuError('denied', 'This is already on its way to the agent.'));
    else if ('failure' in crossed) {
      if (this.deliveries.unpaid(actorId).some((owed) => owed.id === delivery.id)) answer.resolve({ owed: delivery.id });
      else answer.reject(crossed.failure);
    } else if (typeof crossed.admitted === 'object') {
      answer.resolve(crossed.admitted.applied);
    } else {
      // An intent the agent applied is answered with what it did, its repeats too; the rest is a Stop's cutoff.
      answer.reject(new KinuError('cancelled', 'A Stop came first: the agent did not take it.'));
    }

    return await answer.promise;
  }

  /** The owner's intents on their way, each as its view shows it: the workspace's own agent's under no agent id. */
  protected override owedIntents(): readonly OwedOwnerIntent[] {
    const main = this.actorHandle().actorId;

    return this.deliveries.ownerIntents().map(({ actorId, ...intent }) => ({ ...intent, actor: actorId === main ? null : actorId }));
  }

  /** One delivery for the agent, committed with `source`, the producer's own fact, then crossed; see {@link coordinator}. */
  protected async deliver(actorId: string, delivery: Delivery, source?: () => void): Promise<CrossedDelivery> {
    return await this.coordinator.deliver(actorId, delivery, source);
  }

  /** The agent's wake, intended at `at` inside the producer's commit (its row written with the delivery's), and its
   *  projection after the commit: the agent reads working from there, as soon as it is owed. */
  private owedWake(actorId: string, at: number): () => Promise<void> {
    const projected = this.agentWakes.arm(actorId, at);

    return async () => {
      // Its turn claims are its own isolate's.
      this.liveReadsMoved(readsOfTables(['actor_turn_claims']));
      await projected;
      this.admitWork();
    };
  }

  /** The events a delivery carries, bound to it in the agent's log; null for one that carries none. */
  private carried(actorId: string, delivery: Delivery): { readonly events: readonly { readonly id: string; readonly log: EventLog }[] } | null {
    const drained = v.safeParse(v.string(), deliveryMetadata(delivery)?.drainTurnId);

    if (!drained.success) return null;
    const log = new EventLog(this.watchedExec, this.agentBound(actorId).handle);

    return { events: log.query({ turn_id: drained.output }).map((event) => ({ id: event.id, log })) };
  }

  private async hireCouldNotRun(actorId: string, task: { readonly sequenceId: string; readonly mode: WorkMode }, reason: string): Promise<void> {
    const record = this.actingAgentOf(actorId);

    diagnostics.failure('subagent.delegated_turn_failed', new KinuError('io', reason), { workspace: this.name, actor: record.name });
    await relayHostedReport(this.hostedSeams(), this.actorHost().bindStores(actorReferenceOf(record)), {
      status: 'blocked', content: `${record.name} failed to run its assigned turn: ${reason}`,
      origin: 'turn_end', mode: task.mode, sequenceId: task.sequenceId, answers: task.sequenceId,
    });
  }

  /** The lease of the events a turn answered closes, unless a reply is still owed on one: its turn's answer sends that. */
  private async answeredBatch(actorId: string, batchId: string): Promise<void> {
    const log = new EventLog(this.watchedExec, this.agentBound(actorId).handle);
    const replies = await dispatchEmailRepliesForTurn({ log, replies: this.replyChannels }, batchId, '', Date.now());

    if (!replies.pending) log.markTurnCompleted(batchId);
  }

  /**
   * A person's words, delivered and answered where they landed when `land`: in the running turn or opening one. Refused
   * at the door as the agent would refuse them, before anything is written; refused too under an id the agent holds.
   * View-only agents take none. A crossing that fails is the sender's to hear, and the words stay owed. `admitted` is
   * told in the commit that owes them to the agent: a Stop from there on cancels them, on their way or taken.
   */
  private async deliverWords(actorId: string, delivery: Delivery, land: boolean, admitted?: () => void): Promise<SendLanding | null> {
    const refused = wordsRefusal(delivery);

    const crossed: CrossedDelivery = refused === null
      ? await whenActorTakesInput(this.boundSql, actorId, () => this.deliver(actorId, delivery, admitted))
      : { failure: refused };

    // An id the agent holds already was sent before: refused, as at the door.
    if ('admitted' in crossed && crossed.admitted === 'duplicate') {
      return await heard({ failure: new KinuError('bad_input', `message ${delivery.id} was already sent`) }, () => null);
    }

    await heard(crossed, () => null);

    // Heard once a turn took them, off the crossing lane: what waits behind them crosses meanwhile.
    return land ? await this.agentCall(actorId, (isolate, snapshot) => isolate.landing(snapshot, delivery.id)) : null;
  }

  /**
   * The agents whose newest report said their chat holds a turn owed or running: from the input it took, before its turn
   * opens here, to its rest. Written by each accepted report (`agentOwes`), which replaces the agent's answer; dropped by
   * its report of rest, or by its retirement (the host's `retire` in `withAgentFacets`). A reset of this workspace drops
   * all: each such agent's wake, armed while it works, tells again.
   */
  private readonly agentsWorking = new Set<string>();

  /** An agent's open work: its tasks tool and its jobs run here, over its own rows, main's as any agent's. */
  private openWorkOf(actorId: string): OpenWork {
    const reads = this.dynamicReadsOf(actorReferenceOf(this.actingAgentOf(actorId)));

    return { tasks: reads.openTasks(), asyncWakePending: reads.runningJobs().total > 0 };
  }

  private async agentOwes(actorId: string, { seq, next, holds, report }: AgentOwes): Promise<void> {
    const { standing, runEnds } = report;
    const before = this.reportedReport(actorId);
    const live = this.liveActor(actorId);
    // Older than a report already taken from it: delayed past that one, or sent before a reset of either side. Its
    // cumulative figures are older than those taken, so they stand only for a report taken here. A retired agent holds
    // nothing here: its retirement released it.
    const reports = new AgentReports(this.boundSql);
    const accepted = reports.accept(actorId, seq, standing, holds && live);
    // A run end's charges apply once: with the first report taken that carries it.
    const charging = new Set(accepted ? reports.chargeOnce(actorId, runEnds.map(runEndKey)) : []);

    // Each delivered run's end, whichever report carries it: its caller hears it once, and a repeat finds none. Settled,
    // as a chat turn's terminal transition settles it, whatever generation it was: its receipts go (`runSettled`).
    for (const ended of runEnds) {
      if ('ended' in ended.outcome) {
        this.agentActivity(actorId, ended.outcome.ended.activity);

        if (accepted) recordAgentFigures(this.boundSql, actorId, ended.outcome.ended.figures);

        if (charging.has(runEndKey(ended))) for (const charge of ended.outcome.ended.charges ?? []) this.reportModelCall(charge);
      }

      await this.agentTurns.runEnded(actorId, ended);
      this.runSettled(actorId, { turnId: ended.id, runId: ended.runId });
    }

    if (!accepted) return;
    this.reportedReports.set(actorId, { standing, holds: holds && live });
    this.standingMoved(actorId, before?.standing, standing);

    // Who holds owed work is read by the work page (`owingAgentsWork`): a change of the agent's answer moves it.
    if ((before?.holds ?? false) !== (holds && live)) this.overviewChanged();

    if (this.agentsWorking.has(actorId) !== (live && report.working)) {
      if (live && report.working) this.agentsWorking.add(actorId);
      else this.agentsWorking.delete(actorId);
      this.overviewChanged();
    }

    // A retired agent's answer arms nothing: tearing it down ended its wake.
    if (!live) {
      this.openingAccountDropped(actorId);

      return await this.agentWakes.owes(actorId, null);
    }

    // A rest told while a delivery is owed it keeps the wake that crosses it.
    await this.agentWakes.owes(actorId, next ?? (this.deliveriesOwed(actorId) ? Date.now() + RECOVERY_BACKOFF_CEILING_MS : null));

    if (next !== null) return;
    this.openingAccountDropped(actorId);
    await this.closeLostChatTurn(actorId);
    this.releaseIdleHosted(actorReferenceOf(this.actingAgentOf(actorId)));

    // A rest may come after the workspace's own close for the agent's turn rested, while its wake still held the chain.
    await this.restWhenIdle();
  }

  private async preArmed<A>(actorId: string, cross: () => Promise<A>): Promise<A> {
    this.admitWork();
    await this.agentWakes.arm(actorId, Date.now() + RECOVERY_BACKOFF_CEILING_MS);

    return await cross();
  }

  protected override hostedChatWire(actorId: string): ChatWire | null {
    const reference = this.hostedReference(actorId);

    return reference === null ? null : this.agentChatWire(actorId, reference, actorId);
  }

  /** Main's turns run in its own isolate as any agent's do (D9); the workspace's own tabs hear them. */
  protected override mainChatWire(): ChatWire {
    return this.agentChatWire(this.actorHandle().actorId, actorReferenceOf(this.actorHandle()), null);
  }

  /** A turn this object's own session hands the workspace agent: a delivery like any other, a turn of its own. */
  protected override async enqueueMainTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    await this.deliver(this.actorHandle().actorId, {
      id: input.idempotencyKey ?? `turn:${crypto.randomUUID()}`,
      input: {
        kind: 'turn', text: input.text, opensTurn: true, ...(input.metadata !== undefined && { metadata: input.metadata }),
        ...(input.yieldsToUserMessage === true && { yieldsToUserMessage: true }),
      },
      authorship: input.authorship ?? 'hirer',
    });

    return { status: 'queued' };
  }

  protected override async mainLastUserMetadata(): Promise<JsonObject | undefined> {
    return await this.mainCall((isolate, snapshot) => isolate.lastUserMetadata(snapshot)) ?? undefined;
  }

  private async mainTurnPair(messageId: string): Promise<ConversationTurnPair | undefined> {
    return await this.mainCall((isolate, snapshot) => isolate.turnPair(snapshot, messageId)) ?? undefined;
  }

  protected override async mainAnswer(messageId: string): Promise<AgentAnswer | null> {
    return await this.mainCall((isolate, snapshot) => isolate.answer(snapshot, messageId));
  }

  protected override async clearMainConversation(): Promise<string | null> {
    return await this.mainCall((isolate, snapshot) => isolate.clearConversation(snapshot));
  }

  /**
   * One Stop for every agent (design v3 C): what it is owed and its open run are cancelled in one workspace commit, its
   * port refuses the turn from here, then its isolate's cutoff hands its unread words back to their composer and cancels
   * its queued turns, telling their callers, and the turn is aborted. Nothing queued before the Stop runs.
   */
  protected override async stopAgent(actorId: string): Promise<void> {
    const { cancelled, cutoff } = this.ctx.storage.transactionSync(() => {
      new TurnFences(this.boundSql).cancel(actorId, Date.now());
      const stopped = this.coordinator.cancel(actorId);

      // Owed until the agent's isolate commits it: a reset before then crosses it before anything else of the agent's.
      this.stops.owe(actorId, stopped.cutoff);

      return stopped;
    });

    // The work its cancelled deliveries carried is dismissed with them.
    for (const delivery of cancelled) {
      for (const event of this.carried(actorId, delivery)?.events ?? []) event.log.dismiss(event.id, 'stopped by the owner', 'system');
    }

    await this.agentTurns.interrupt(actorId, cutoff);

    // A Stop dismisses the agent's open questions in its own isolate.
    if (this.agentBound(actorId).stores.config.getHoldsQuestions()) this.hostedQuestionsMoved();
  }

  protected override mainChatTurn(): string | null {
    return this.agentTurns.currentTurn(this.actorHandle().actorId);
  }

  protected override mainChatSurface(): TurnSurface | null {
    return this.agentTurns.surface(this.actorHandle().actorId);
  }

  /** `room` names the tabs that hear the agent: its own window's, or null for the workspace's. */
  private agentChatWire(actorId: string, reference: ActorReference, room: string | null): ChatWire {
    const call = async <A>(made: (isolate: AgentFacetCalls, snapshot: AgentSnapshot) => Promise<A>) => await this.agentCall(actorId, made);

    return {
      // Only an agent that has not said it rests is asked: asking opens its chat, which a page's open must not do idly.
      turnOwed: async () => this.currentTurnOf(reference) !== null
        || (this.agentWakes.armed(actorId) && await call((isolate, snapshot) => isolate.owed(snapshot))),
      // A turn its isolate re-opened finished its first steps in an isolate that ended: its own ledger holds them.
      steps: async function* (runId, before) {
        yield* jsonLines(await call((isolate, snapshot) => isolate.runSteps(snapshot, runId, before)), DrawnStepSchema);
      },
      getConnection: (id) => this.getConnection(id),
      broadcast: (message, exclude) => { this.broadcastToActor(room, message, exclude); },
      seed: () => call((isolate, snapshot) => isolate.seed(snapshot)),
      media: (ref) => call((isolate, snapshot) => isolate.media(snapshot, ref)),
      unseen: (ids) => call((isolate, snapshot) => isolate.unseen(snapshot, ids)),
      send: async ({ id, ...words }, admitted) => await this.deliverWords(actorId, { id, input: { kind: 'words', ...words }, authorship: 'owner' }, true, admitted) ?? 'mid-turn',
      retry: (messageId) => whenActorTakesInput(this.boundSql, actorId, async () => {
        const done = await this.ownerIntent(actorId, { id: `retry:${messageId}`, input: { kind: 'retry', messageId }, authorship: 'owner' });

        // Applied, the turn it reopened tells its own end.
        return 'owed' in done || done.kind !== 'retry' ? { owed: 'owed' in done ? done.owed : messageId } : { turnId: done.turnId };
      }),
      interrupt: async () => {
        this.detachOwned(Effect.asVoid(this.stopAgentDevices(actorId)));
        this.stopSubtree(actorId);
        await this.stopAgent(actorId);
      },
      sendState: (id) => call((isolate, snapshot) => isolate.sendState(snapshot, id)),
      awaitSend: (id) => call((isolate, snapshot) => isolate.awaitSend(snapshot, id)),
      // An agent's text streams into its room, never through its events: its first token is heard there.
      firstText: () => { this.recordFirstToken(actorId, this.chatOpenedAt.get(actorId) ?? Date.now()); },
    };
  }

  protected override hostedPlanReviews(actorId: string): HostedPlanReviews | null {
    if (this.hostedReference(actorId) === null) return null;
    const call = async <A>(made: (isolate: AgentFacetCalls, snapshot: AgentSnapshot) => Promise<A>) => await this.agentCall(actorId, made);

    // Its plans are its own isolate's rows: each change it answers was announced here first (`hostedChatEvent`).
    return {
      active: () => call((isolate, snapshot) => isolate.activePlanReview(snapshot)),
      saveAnnotations: (id, revision, annotations) => call((isolate, snapshot) => isolate.savePlanReviewAnnotations(snapshot, id, revision, annotations)),
      dismiss: (id, revision) => call((isolate, snapshot) => isolate.dismissPlanReview(snapshot, id, revision)),
      decide: async (id, revision, decision, feedback) => {
        const done = await this.ownerIntent(actorId, {
          id: `decision:${id}:${String(revision)}`, input: { kind: 'decision', plan: id, revision, decision, ...(feedback !== undefined && { feedback }) }, authorship: 'owner',
        });

        return 'owed' in done || done.kind !== 'decision' ? { owed: 'owed' in done ? done.owed : id } : done.outcome;
      },
    };
  }

  /**
   * An agent's plans moved in its own isolate, where this workspace's store revision does not see them: the reads over
   * them move, and the owner's tile, whose held inputs count its waiting plans, folds them again.
   */
  private hostedPlansMoved(): void {
    this.liveReadsMoved(readsOfTables(['plan_reviews']));
    this.slowOverview = null;
    this.overviewChanged();
  }

  /** Whether the agent was ever offered `ask_owner`, read off its row as it retires too. */
  private holdsQuestions(actorId: string): boolean {
    const record = this.actorDirectoryStore().retained(actorId);

    return record !== null && actorReadHandle(this.boundSql, record).config.getHoldsQuestions();
  }

  /** Marks the agent as one the stack asks for questions; its call parks in its own isolate's store. */
  private offerAskOwner(config: AgentConfigStore): true {
    if (!config.getHoldsQuestions()) config.setHoldsQuestions();

    return true;
  }

  /**
   * A hosted agent's questions moved in its own isolate, which the workspace's store revision does not see: the held
   * overview is read again, and the tabs read the list again.
   */
  private hostedQuestionsMoved(): void {
    this.heldQuestions = null;
    this.questionsChanged();
  }

  /** A retired agent's questions leave with it. The tile is read again only if it counted one of them open, or may
   *  have: a read already asking it is not held. */
  private askerRetired(actorId: string): void {
    const open = this.heldOpenQuestion(actorId);

    this.heldQuestions = this.heldQuestions?.filter((asking) => asking.actor !== actorId) ?? null;

    if (open === false) this.liveReadsMoved(['listOwnerQuestions']);
    else this.questionsChanged();
  }

  private questionsChanged(): void {
    this.slowOverview = null;
    this.questionMoves += 1;
    this.liveReadsMoved(['listOwnerQuestions']);
    this.overviewChanged();
  }

  /** Each live agent's questions from its own isolate (D9); only an agent offered `ask_owner` is asked. An answer is handed
   *  in as words are, with a wake armed, so the turn it owes survives the isolate. */
  protected override hostedQuestions(): HostedOwnerQuestions {
    return {
      // Main's are named as the workspace's own, under no agent id.
      list: async () => {
        const askers = this.workspaceActors().list()
          .filter((row) => actorReadHandle(this.boundSql, row).config.getHoldsQuestions());

        const asked = await Promise.all(askers.map(async (row) => (await this.agentCall(row.actorId, (isolate, snapshot) => isolate.ownerQuestions(snapshot)))
          .map((questions) => (row.parentActorId === null
            ? { asked: questions, agent: this.name, actor: null }
            : { asked: questions, agent: row.name, actor: row.actorId }))));

        return asked.flat();
      },
      answer: async (actorId, id, answers) => {
        const done = await this.ownerIntent(actorId, { id: `answers:${id}`, input: { kind: 'answers', questions: id, answers: [...answers] }, authorship: 'owner' });

        this.hostedQuestionsMoved();

        return 'owed' in done ? done : null;
      },
      // A dismissal may leave a sibling's answer owed a turn, so it is handed in as an answer is.
      dismiss: async (actorId, id) => {
        const closed = await this.preArmed(actorId, () => this.agentCall(actorId, (isolate, snapshot) => isolate.dismissOwnerQuestions(snapshot, id)));

        this.hostedQuestionsMoved();

        return closed;
      },
    };
  }

  /** Each agent's plans from its own isolate (D9); only an agent that has submitted one is asked, retired ones included. */
  private async hostedPlans(): Promise<Map<string, readonly PlanReview[]>> {
    const holders = this.workspaceActors().list({ retired: true })
      .filter((row) => actorReadHandle(this.boundSql, row).config.getHoldsPlans());

    return new Map(await Promise.all(holders.map(async (row) => [row.actorId, await this.agentCall(row.actorId, (isolate, snapshot) => isolate.planReviews(snapshot))] as const)));
  }

  private hirerName(record: WorkspaceActor): string {
    const hirer = record.parentActorId === null ? null : this.workspaceActors().list().find((actor) => actor.actorId === record.parentActorId);

    return hirer === undefined || hirer === null || hirer.parentActorId === null ? MAIN_AGENT : hirer.name;
  }

  /** Owner resolution is lazy inside each action: the toolset is cached across turns (including
   *  pre-claim). */
  private getPeersToolDeps(): PeersToolDeps {
    return peersToolDeps(this.peerHub, {
      self: this.name,
      // The owner's other workspaces, self excluded.
      peers: async () => {
        this.requireOwner();
        const { stub, caller } = await this.userHub();

        return (await stub.listActiveWorkspaces(caller)).filter((peer) => peer.name !== this.name);
      },
      // Same-owner roster check so a typo'd name errors instead of materializing an unowned DO.
      known: async (agent) => {
        this.requireOwner();
        const { stub, caller } = await this.userHub();

        return await stub.hasWorkspace(caller, agent);
      },
      userId: () => this.requireOwner(),
      spawnWorkspace: async ({ name, purpose, message, mode, signal }): Promise<PeerSpawnOutcome> => {
        const userId = this.requireOwner();
        const { stub: userDO, caller } = await this.userHub();
        let agentName = name;
        let created = false;

        if (!agentName || !(await userDO.hasWorkspace(caller, agentName))) {
          const workspaceInput = { name: agentName === '' ? undefined : agentName, purpose };
          const entry = await createCloudWorkspaceForUser({ env: this.env, userId, userDO, caller, input: workspaceInput });

          this.recordAgentWorkspace({ workspace: entry.name, name: entry.displayName, brief: purpose });
          agentName = entry.name;
          created = true;
        }

        const outcome = await this.peerHub.ask({
          agent: agentName, userId, topic: 'task', message, mode, signal,
        });

        return { agent: agentName, created, ...outcome };
      },
    });
  }

  /** Reads its deps lazily so a mid-lifetime claimOwner lands without rebuilding eval. */
  protected agentSelf(): AgentSelfHost {
    return agentSelfHost({
      rt: this.rt,
      scaffoldControl: () => this.scaffoldControl,
      triggers: () => this.triggerRegistry,
      jobs: () => this.jobs,
      budget: () => this.budget,
      // Owner's revoke path; drops the webhook secret with the row.
      cancelTrigger: (id, caller) => this.cancelTrigger(id, caller),
      // Main's turns are assembled in its own isolate, which reads and clears the arm (D9).
      armCompactNow: async () => { await this.mainCall((isolate, snapshot) => isolate.armCompaction(snapshot)); },
      createWorkspace: (input) => createAgentWorkspace(this.agentWorkspaceDeps(), input),
      ownerWaits: this.ownerWaitsOf(this.actorHandle().actorId, true),
    });
  }

  /**
   * Whether an agent may hold an armed wait on its owner (read-models/owner-waits.ts): unknown (null) at start, so the
   * first change looks; false once a look found none, until one is armed.
   */
  private ownerWaitsArmed: boolean | null = null;

  /** One agent's `agent.waitingOnOwner` and its wake, over every row the attention stack holds the owner on. */
  private ownerWaitsOf(actorId: string, workspaceAgent: boolean): OwnerWaitsHost {
    return ownerWaitsHost({
      reader: this.ownerWaitReader(actorId, workspaceAgent),
      read: () => this.ownerWaitRows(),
      armed: () => { this.ownerWaitsArmed = true; },
    });
  }

  private ownerWaitReader(actorId: string, workspaceAgent: boolean): OwnerWaitReader {
    return { actorId, workspaceAgent, config: actorId === this.actorHandle().actorId ? this.config : this.agentBound(actorId).stores.config };
  }

  /** Every row that waits on the owner now, from the reads the attention stack and the roster's tile are built from. */
  private async ownerWaitRows(): Promise<ScopedOwnerWait[]> {
    const [hostedPlans, questions] = await Promise.all([this.hostedPlans(), this.questionsAsked()]);

    return ownerWaits({
      deferred: this.deferrals.list(),
      plans: this.hostedPendingPlans(hostedPlans),
      consents: this.consents.list(),
      questions,
      nameOf: (actorId) => this.actorHost().describe(actorId)?.name ?? actorId,
    });
  }

  /**
   * What waits on the owner may have moved (every such change moves the roster's tile): each armed wait it now meets
   * wakes its agent, once. Read only while one may be armed.
   */
  private ownerWaitsMoved(): void {
    if (this.ownerWaitsArmed === false) return;

    const main = this.actorHandle().actorId;

    this.detachOwned(logged('owner_waits.wake_failed', { doing: 'waking the agents whose wait on their owner is met', otherwise: 'io' }, wakeMetOwnerWaits({
      readers: this.workspaceActors().list().map((record) => this.ownerWaitReader(record.actorId, record.actorId === main)),
      rows: () => this.ownerWaitRows(),
      wake: (actorId, signal) => Effect.asVoid(attempt({ doing: 'waking an agent with its owner\'s word', otherwise: 'io' }, () => this.agentDeliveries(actorId).signals.send(signal))),
    }).pipe(Effect.map((stillArmed) => { this.ownerWaitsArmed = stillArmed; }))));
  }

  protected notifyOwner(subject: string, body: string): void {
    this.email.ownerNotification(subject, body);
  }

  /** Called by the Worker on every authenticated request before any other RPC; 403s on cross-user collision. */
  claimOwner(userId: string): Promise<{ owner: string; capabilityHash: string | null }> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!userId) return yield* new KinuError('bad_input', 'userId required');

      // A hash, not a boolean: the UserDO compares it to its registration so any mismatch gets repaired.
      const capabilityHash = yield* Effect.promise(async () => this.workspaceCapabilityHash());
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
        yield* Effect.promise(async () => this.ensureOwnedScaffold());

        // Detached, never inside the init gate: main's isolate builds its chat, which measures the start-up context.
        if (exists.length === 0) {
          const main = this.actorHandle().actorId;

          this.detachOwned(logged('subagent.agent_wake_failed', { doing: "opening main's own isolate", otherwise: 'io' },
            () => this.wakeAgent(main), { workspace: this.name, actor: main }));
        }

        return { owner: userId, capabilityHash };
      }

      if (current !== userId) {
        return yield* ownedByAnotherAccount(`Agent owned by a different user (stored=${current.slice(0, 8)}..., caller=${userId.slice(0, 8)}...)`);
      }

      // No scaffold probe here: this runs on every authenticated request. An interrupted bootstrap
      // is finished by beforeTurn, which awaits ensureOwnedScaffold before reading workspace files.
      return { owner: current, capabilityHash };
    }));
  }

  // The reactor lives on the core AgentOrchestrator. Ingress uses the debounced
  // the durable wake, which drains every agent's due events into a delivery of its own.

  private readonly turnSlates = new Map<string, { readonly changed: Set<string>; readonly shown: Set<string> }>();

  /** Each agent's last answered turns and what their take gave: a take asked again (its answer's row replayed after a
   *  death) is given the same, and a slate changed under one after it is carried to the agent's next answer. */
  private readonly answeredTurns = new Map<string, { readonly turnId: string; readonly reply: Promise<AnswerMetadataReply> }[]>();

  private noteTurnSlates(kind: 'changed' | 'shown', ids: readonly string[]): void {
    const actor = activeOperationProfile();

    if (actor === undefined || actor.turnId === WORKSPACE_RUN_ID) return;
    const actorId = actor.actor.actorId;
    const key = this.answeredTurns.get(actorId)?.some((answered) => answered.turnId === actor.turnId) === true ? `${actorId}:carried` : `${actorId}:${actor.turnId}`;
    let held = this.turnSlates.get(key);

    if (held === undefined) {
      held = { changed: new Set(), shown: new Set() };
      this.turnSlates.set(key, held);
    }

    for (const id of ids) held[kind].add(id);
  }

  /** Without the narration, takes nothing while a slate the turn changed went unshown: only its words can promote it. */
  private async takeTurnSlates(actorId: string, turnId: string, narration: readonly string[] | null): Promise<AnswerMetadataReply> {
    const answered = this.answeredTurns.get(actorId)?.find((turn) => turn.turnId === turnId);

    if (answered !== undefined) return await answered.reply;
    const keys = [`${actorId}:${turnId}`, `${actorId}:carried`];
    const holding = keys.map((key) => this.turnSlates.get(key));

    if (narration === null && (await slatesToPreview(holding.flatMap((slates) => [...slates?.changed ?? []]), new Set(holding.flatMap((slates) => [...slates?.shown ?? []])), [])).length > 0) {
      return { owesNarration: true, metadata: null };
    }

    const taken = keys.map((key) => {
      const held = this.turnSlates.get(key);

      this.turnSlates.delete(key);

      return held;
    });

    const changed = taken.flatMap((held) => [...held?.changed ?? []]);
    const shown = new Set(taken.flatMap((held) => [...held?.shown ?? []]));
    const reply = slatesToPreview(new Set(changed), shown, narration ?? []).then(async (ids) => await this.slatePreviews(ids));

    // Answered as it is taken: a slate the turn changes from here is carried, and a take asked again waits on this one.
    this.answeredTurns.set(actorId, [...(this.answeredTurns.get(actorId) ?? []).slice(-(ANSWERED_TURNS_KEPT - 1)), { turnId, reply }]);

    return await reply;
  }

  /** The previews of those that still exist. */
  private async slatePreviews(ids: readonly string[]): Promise<AnswerMetadataReply> {
    const vfs = this.hostedWorkspace().bundle.vfs;
    const kept = [];

    for (const id of ids) if (await nimbusExists(vfs, `${SLATES_ROOT}/${id}`)) kept.push(id);

    return { owesNarration: false, metadata: kept.length === 0 ? null : { [SLATES_CHANGED_METADATA_KEY]: kept } };
  }

  /** What main's turns left here, from their preparation to their handoff. */
  private get turnBranches(): TurnBranchesStore {
    return new TurnBranchesStore(this.boundSql, this.actorHandle().actorId);
  }

  /**
   * Every agent's one settle here, as its isolate's terminal transition tells it: the receipts its tools kept under the
   * settled run go. Its answer is committed, so nothing runs under that run again and its close paired every call it
   * lost; its follow-ups are later turns. A retired agent's rows went with it.
   */
  private runSettled(actorId: string, run: Pick<SettledRun, 'turnId' | 'runId'>): void {
    if (!this.liveActor(actorId)) return;
    pruneTurnReceipts(this.boundSql, this.agentBound(actorId).handle, run);
  }

  /**
   * Main's settled turn, handed from its own isolate: the lanes it owes are this object's (its evolution, event log,
   * titles, replies and branches), declared and owed here once per turn, however often the handoff is repeated.
   */
  private async mainTurnSettled(settled: HandedOffTurn): Promise<void> {
    // What the workspace decided as the turn opened, as main's isolate froze it then and handed it over.
    const held = settled.facts;
    const turn = v.parse(CompletedTurnSchema, settled.turn);
    // Its missions travel with every recording: the governor may hold another turn's by now, or none after a reset.
    const scoped: CompletedTurn = held.missionLabels.length === 0 ? turn : { ...turn, missionLabels: [...held.missionLabels] };

    const facts: TerminalTurnFacts = {
      messageId: settled.messageId, status: settled.status, workMode: settled.workMode, continuity: held.continuity,
      completed: settled.completed, userText: settled.userText, assistantText: settled.assistantText,
      scopedTurn: projectJsonValue({ value: scoped }), recordedAt: settled.recordedAt, evolutionEnabled: held.evolutionEnabled,
    };

    await this.terminal.settle({
      transition: { turnId: settled.turnId, messageId: settled.messageId },
      declare: () => [
        ...declareTerminalRoster(facts, {
          role: { kind: 'workspace', mission: missionOf(this.getSoulText()), event: settled.event },
          turn: scoped, reachableTools: settled.reachableTools,
        }, this.rosterParts(settled, scoped)),
        // Its outcome the run's own: a tool that failed inside a turn that answered is not a failed turn.
        { name: 'fleet_turn', scope: settled.messageId, lane: 'detached', input: { turn: facts.scopedTurn, completed: settled.completed } },
      ],
    });
    this.turnBranches.retire(settled.turnId);
    // For the next turn, which an alarm, an email or a wake after an eviction opens without the page's warmup.
    this.warmUserMcpInBackground();
  }

  /** Built per use: the actor handle and the fast lane are this activation's. Main's conversation is its isolate's. */
  private get sleepTime(): SleepTimeLane {
    return new SleepTimeLane({
      sql: this.boundSql, actor: this.actorHandle(), config: this.config, facts: this.facts,
      transcript: () => ({ newestFirst: async (limit) => await this.mainCall((isolate, snapshot) => isolate.newestFirst(snapshot, limit ?? Number.MAX_SAFE_INTEGER)) }),
      llm: () => this.rt.fastLlm ?? this.rt.llm,
      transactionSync: (write) => this.ctx.storage.transactionSync(write),
      armWake: () => { this.armDurableWake(); }, workspace: this.name,
      idle: () => idleDream(this.refinementDeps, this.engine.recordsTurns),
      // Reads the account and proposes to it; the owner accepts what is kept.
      account: () => this.account.ownedMemory({ by: 'background' }),
    });
  }

  /** Its chat's follow-up turns are owed in main's own isolate; everything else its settled turn owes, here. */
  private rosterParts(settled: HandedOffTurn, scoped: CompletedTurn): TerminalTurnParts {
    return {
      // Over the row main's transcript persisted, so a cut turn's announcement replays from it; owed only when an
      // extension here listens, as reading the answer back crosses into main's isolate for the whole turn.
      turnEndExtensions: this.extensions.listens('onTurnEnd'),
      credited: settled.credited,
      // Scored here as main's `eval` ran them; main's own isolate kept what each call's answer carried, in the turn it handed over.
      craftedToolsUsed: scoped.craftedToolsUsed ?? [],
      eventReplies: { answered: new Set(settled.answeredDeliveries), requestId: settled.messageId },
      // Each with the task its head was started on, as the journal recorded it at the branch's start.
      branches: this.turnBranches.of(settled.turnId).map((id) => ({ id, task: this.headJournal.readHeadView(branchHeadId(id))?.task ?? '' })),
    };
  }

  /**
   * Every body here must be replayable on its own: each boundary is idempotent at its edge
   * (stable window-append id, keyed extension emit, drain of unbound rows, durable lane queues).
   */
  protected override terminalEffectTable(): TerminalEffectTable {
    return {
      ...this.sharedTerminalEffects(),

      fleet_turn: terminalEffect({
        input: v.object({ turn: JsonValueSchema, completed: v.boolean() }),
        runSync: ({ turn, completed }) => {
          this.recordMainTurnRow(v.parse(CompletedTurnSchema, turn), completed);

          return { status: 'completed' };
        },
      }),

      event_reply: terminalEffect({
        input: v.object({
          drainTurnId: v.string(), answer: v.string(), requestId: v.string(),
        }),
        // Replayable: the outbound-email outbox sends each channel's key once.
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

      sleep_time: this.sleepTime.effect(),

      workspace_logo: terminalEffect({
        input: v.object({ subject: v.string() }),
        run: async ({ subject }) => {
          const unreachable = await this.titlingRefusal();

          if (unreachable !== null) return { status: 'owed', detail: unreachable };
          await this.drawLogo(subject);

          return { status: 'completed' };
        },
      }),
    };
  }

  protected override lastConnectionClosed(): void {
    this.sleepTime.lastClientLeft();
    this.watchDeviceStatus(false);
  }

  protected override connectionOpened(): void {
    this.sleepTime.clientArrived();
    this.overviewChanged();
    this.watchDeviceStatus(true);
    this.recheckSandboxRestore();
  }

  /** A sandbox that died mid-restore sends no settle. */
  private recheckSandboxRestore(): void {
    const box = this.computerBox();

    if (box === undefined) return;

    if (this.config.get(SANDBOX_STARTING) == null && this.config.get(SANDBOX_REFUSED) == null) return;
    this.detachOwned(logged('computer.restore_recheck_failed', { doing: "reading the computer's restore state", otherwise: 'unavailable' }, async () => {
      await this.sandboxRestore(await box.restoreStatus());
    }, { workspace: this.name }));
  }

  /** Every open re-registers, so an object that hibernated or lost its row is told again. */
  private watchDeviceStatus(watching: boolean): void {
    if (this.getOwnerUserId() === null) return;
    this.detachOwned(Effect.catchCause(Effect.gen({ self: this }, function* () {
      const { stub, caller } = yield* Effect.promise(() => this.userHub());
      yield* Effect.promise(() => stub.watchDeviceStatus(caller, watching));

      if (!watching) return;
      const opened = this.rt.deviceTransport.status();

      if (!sameDeviceStatus(yield* Effect.promise(() => this.rt.deviceTransport.refreshStatus()), opened)) {
        this.liveReadsMoved(['getExecutors', 'getToolDescriptions']);
      }
    }), (failed) => Effect.sync(() => {
      diagnostics.failure('device.watch_failed', toKinuError({
        doing: watching ? 'asking to hear device changes' : 'leaving the device-change list', cause: Cause.squash(failed), otherwise: 'unavailable',
      }), { workspace: this.name });
    })));
  }

  async sandboxStopped(): Promise<void> {
    await this.sandboxRestore({ restoring: false, refused: undefined });
    // Its running time stops counting, and its place is free for another of the owner's computers.
    const { stub, caller } = await this.userHub();
    await stub.limits_computerStopped(caller, this.name);
  }

  /**
   * Whether this workspace's computer, set to `size`, may start from stopped (KinuDevbox `admitStart`): its owner's limits
   * answer the size it starts at (a free account's at most small), or a refusal in their words. Admitted, it holds the
   * owner's place until `sandboxStopped`.
   */
  async computerStartAdmitted(size: ComputerSize): Promise<StartAdmission> {
    const { stub, caller } = await this.userHub();

    return settle(Effect.match(attemptInItsWords('unavailable', () => stub.limits_admitComputerStart(caller, this.name, size)), {
      onSuccess: (runs): StartAdmission => ({ size: runs }),
      // Only the limits' own answer refuses a start; a limits object that could not be asked does not hold the box down.
      onFailure: (refusal): StartAdmission => (refusal.code === 'budget' || refusal.code === 'denied' ? { refused: refusal.message } : { size }),
    }));
  }

  /** This workspace's computer seen running (KinuDevbox heartbeat): its running time counts to the owner's month. */
  async computerRunningTick(size: ComputerSize): Promise<void> {
    const { stub, caller } = await this.userHub();
    await stub.limits_computerTick(caller, this.name, size);
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
    this.detachOwned(Effect.asVoid(Effect.promise(() => this.rt.deviceTransport.refreshStatus())));

    return { watching: true };
  }

  /** Titling source for the root, and inherited by agents the owner adds. */
  protected async ownMission(): Promise<string> {
    return missionOf(await this.loadSoulText()) ?? '';
  }

  /** UserDO is authoritative for the shown name; the manual-rename refusal lives in its
   * `name_origin`. */
  protected async persistAutoTitle(displayName: string): Promise<boolean> {
    return await this.propagateDisplayName(displayName, 'auto');
  }

  /** The UserDO-owned title as this activation last read or wrote it; no local mirror, since other writers commit to the
   * root. Mutation paths read it again before deciding. A null row is an answer too; a failed read holds nothing. */
  private readonly heldTitle = new HeldRead<{ displayName: string; nameOrigin: NameOrigin } | null>();

  private async hydrateTitle(): Promise<void> {
    if (!this.getOwnerUserId()) return;

    await settleLogged('workspace.title_hydration_failed', { doing: 'reading the root registry title for this workspace', otherwise: 'unavailable' },
      () => this.hydrateTitleInputs(), { workspace: this.name });
  }

  private titleState(): { displayName: string; nameOrigin: NameOrigin } {
    return this.heldTitle.current ?? { displayName: this.name, nameOrigin: 'auto' as const };
  }

  /** Hydrates from the registry before the title policy decides, so a replayed auto-title does not
   * plan over the cold placeholder cache. */
  protected override async hydrateTitleInputs(): Promise<void> {
    // Fails, unlike `hydrateTitle`, so the title effect stays owed until the read works.
    await this.heldTitle.again(async () => {
      const { stub, caller } = await this.userHub();

      return await stub.getWorkspaceTitle(caller, this.name);
    });
  }

  /** Without an owner or capability the registry is unreachable; the row stays owed rather than
   * reporting a title only the activation cache holds. */
  protected override async titlingRefusal(): Promise<string | null> {
    if (!this.getOwnerUserId()) return unownedWorkspace().message;

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
    if (this.heldTitle.current === undefined) await this.hydrateTitle();

    return this.titleInputs().displayName;
  }

  protected override async promptIdentity(): Promise<PromptIdentity> {
    return { workspace: await this.workspaceTitle() };
  }

  /** The kept activations, oldest first: how often this workspace started, and on which build. */
  activations(): Activation[] {
    return this.storageRefusal === undefined ? listActivations(this.boundSql) : [];
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
    this.heldTitle.hold({ displayName, nameOrigin: origin });

    return true;
  }

  // Background jobs (#173): lifecycle lives in core BackgroundJobRunner; below is the @callable transport.

  async jobResult(jobId: string): Promise<BackgroundJob | null> {
    return (this.jobAuthorities.owning(jobId)?.store ?? this.jobs).get(jobId);
  }

  @callable()
  listBackgroundJobs(limit = 20, actor?: string): Promise<ListedBackgroundJob[]> {
    return settle(Effect.gen({ self: this }, function* () {
      const child = actor === undefined ? undefined : yield* this.hostedChild(actor);
      const store = child === undefined ? this.jobs : child.child.stores.jobs;
      const actorId = child === undefined ? this.actorHandle().actorId : child.child.reference.actorId;
      const live = this.jobAuthorities.live(actorId);

      return listBackgroundJobs(store, limit, (jobId) => live?.runner.output.tail(jobId));
    }));
  }

  /** A pane naming `actor` acts on its jobs alone. */
  private jobOperation<Outcome extends { ok: boolean }>(
    operation: string, jobId: string, actor: string | undefined, run: (authority: JobAuthority) => Promise<Outcome> | Outcome,
  ): Effect.Effect<Outcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const authority = this.jobAuthorities.owning(jobId) ?? this.jobAuthorities.root();

      if (actor !== undefined && authority.actorId !== (yield* this.hostedChild(actor)).child.reference.actorId) {
        return yield* Effect.fail(new KinuError('denied', `Job ${jobId} is not ${actor}'s.`));
      }

      return yield* Effect.promise(async () => this.countJobOperation(operation, await run(authority)));
    });
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
  async cancelBackgroundJob(jobId: string, actor?: string): Promise<{ ok: boolean }> {
    return await settle(this.jobOperation('cancel', jobId, actor, (authority) => cancelBackgroundJob(authority.runner, jobId)));
  }

  @callable()
  async retryBackgroundJob(jobId: string, actor?: string): Promise<RetryOutcome> {
    return await settle(this.jobOperation('retry', jobId, actor, (authority) => this.retryJob(authority, jobId)));
  }

  /** On its owner's raw tools and runner: a hire's job runs again as the hire, and its settle wakes the hire. */
  private async retryJob(authority: JobAuthority, jobId: string): Promise<RetryOutcome> {
    if (authority.kind === 'step-loop') return { ok: false, error: "a swarm node's job ends with its run" };

    // A process job runs again as `processRetryTool`, under the kind its job was given.
    const rawTools = authority.kind === 'root'
      ? async (mode: WorkMode) => {
        await this.currentAccountSwarms();

        return { ...this.getRawToolsForWorkMode(mode), startProcess: this.rt.processRetry };
      }
      : (mode: WorkMode) => hostedRetryTools(this.hostedSeams(), actorReferenceOf(this.actingAgentOf(authority.actorId)), mode, `retry:${jobId}`);

    return await retryBackgroundJob({
      jobs: authority.store, jobRunner: authority.runner, rawTools, logActivity: (event, detail) => this.logActivity(event, detail),
    }, jobId);
  }

  @callable()
  async dismissBackgroundJob(jobId: string, actor?: string): Promise<{ ok: boolean }> {
    return await settle(this.jobOperation('dismiss', jobId, actor, (authority) => dismissBackgroundJob(authority.store, jobId)));
  }

  /** The runner `actorId`'s tools run their foreground calls under: main's the workspace's, a hire's its own; null for a
   *  hire whose jobs no turn of it has opened. */
  private foregroundRunnerOf(actorId: string): BackgroundJobRunner | null {
    return actorReach(actorPolicy(this.agentBound(actorId).record)).kind === 'workspace' ? this.jobRunner : this.jobAuthorities.live(actorId)?.runner ?? null;
  }

  /** A hire's own jobs; a settle wakes it with a message. */
  private hireJobs(actor: BoundActor, mode: WorkMode): ActorJobs {
    return { jobRunner: this.hireRunner(actor), backgroundable: BACKGROUNDABLE_TOOLS, mode: () => mode };
  }

  private hireRunner(actor: BoundActor): BackgroundJobRunner {
    return (this.jobAuthorities.live(actor.reference.actorId) ?? this.hireJobAuthority(actor.reference)).runner;
  }

  /** The runner `actor`'s calls become jobs on, as its tools' do: a workspace agent's the workspace's, a hire's its own. */
  private jobRunnerOf(actor: BoundActor): BackgroundJobRunner {
    return actorReach(actorPolicy(actor.record)).kind === 'workspace' ? this.jobRunner : this.hireRunner(actor);
  }

  protected override reviveJobAuthority(actorId: string): JobAuthority | null {
    const record = this.actorDirectoryStore().retained(actorId);

    if (record === null || record.retiringAt !== null || record.deletedAt !== null) return null;

    if (isSubagentOrigin(record.origin)) return this.hireJobAuthority(actorReferenceOf(record));

    return record.origin === 'swarm' ? endedStepLoopJobs({
      actorId, store: this.actorHost().bindStores(actorReferenceOf(record)).stores.jobs,
      ports: this.workspaceJobPorts(actorId), fiber: (name, fn) => this.rt.schedule.fiber(name, fn),
    }) : null;
  }

  /** Over stores bound for it alone: its turn's are released once it idles. */
  private hireJobAuthority(reference: ActorReference): JobAuthority {
    const actor = this.actorHost().bindStores(reference);
    const store = actor.stores.jobs;

    const runner = this.actorJobRunner(actor.reference.actorId, {
      store,
      // Unwatched, but woken by a message.
      policy: () => invocationBackgroundPolicy('interactive', true),
      fiber: (name, fn) => this.rt.schedule.fiber(name, fn),
      // Its durable queue; a repeated wake is one message.
      inbox: inlineResultInbox(store, {
        send: async ({ text, metadata, idempotencyKey }) => {
          await this.enqueueHostedTurn(actor, { text, ...(metadata !== undefined && { metadata: { ...metadata } }), ...(idempotencyKey !== undefined && { idempotencyKey }) });

          return 'queued';
        },
      }),
    });

    const authority = { kind: 'hire', actorId: actor.reference.actorId, store, runner } as const;

    this.jobAuthorities.attach(authority);

    return authority;
  }

  @callable()
  async clearBackgroundJobs(): Promise<{ ok: boolean }> {
    return this.countJobOperation('clear', await clearBackgroundJobs(this.jobs));
  }

  @callable()
  async listWorkspaceAgents(): Promise<PanelAgent[]> {
    return await this.workspaceAgents(false);
  }

  protected async workspaceAgents(retained: boolean): Promise<PanelAgent[]> {
    return readWorkspaceAgents({
      sql: this.boundSql, exec: this.ctx.storage.sql, root: this.actorHandle(), queued: (actorId) => this.agentWakes.armed(actorId),
      actors: this.workspaceActors().list({ retired: true }), retained,
      // Each agent's own isolate reports them at its turns' ends, main's as any other's: its steps are its isolate's (D9).
      figures: (actorIds) => reportedAgentFigures(this.boundSql, actorIds),
      chat: (actorId) => {
        const reported = this.reportedReport(actorId)?.standing;

        if (reported === undefined) return null;
        const stepped = measuredAt(reported.measures);

        return {
          planPending: reported.plans.pending, lastFailed: reported.latestRun?.status === 'error',
          ...(stepped !== undefined && { activeAt: stepped }),
        };
      },
    });
  }

  /** The owner changed this workspace's secrets (`user/secrets.ts`): its commands read them again. Never `@callable`. */
  async secretsMoved(): Promise<void> {
    this.account.secretsMoved();
  }

  /** By the agent a workspace process acted for, where its egress named one; a container's names nobody. Never `@callable`. */
  async recordGitHubEgress(facts: readonly GitHubFact[], actorId: string | null): Promise<void> {
    recordGitHubActivity(this.boundSql, v.parse(v.array(GitHubFactSchema), facts), { actorId, at: Date.now() });
  }

  @callable() getWorkspaceGitHub(refresh = false): Promise<WorkspaceGitHubView> {
    return settle(Effect.gen({ self: this }, function* () {
      const remotes = yield* Effect.promise(async () => readGitHubRemotes(this.rt.localVfs, WORKSPACE_ROOT));
      const outcome = refresh ? yield* this.refreshGitHub(readGitHubActivity(this.boundSql, remotes)) : 'skipped';

      return { ...readGitHubActivity(this.boundSql, remotes), refresh: outcome };
    }));
  }

  private refreshGitHub(activity: WorkspaceGitHub): Effect.Effect<WorkspaceGitHubView['refresh']> {
    return Effect.gen({ self: this }, function* () {
      const { stub, caller } = yield* Effect.promise(async () => this.userHub());

      const answer = yield* attempt({ doing: 'asking the account to read GitHub', otherwise: 'unavailable' },
        async () => stub.userMcp_githubRefresh(caller, gitHubRefreshAsk(activity)));

      recordGitHubObservations(this.boundSql, answer.observed, Date.now());

      return answer.outcome;
    }).pipe(Effect.catch((failed) => Effect.sync(() => {
      diagnostics.failure('github.refresh_failed', failed);

      return 'unreachable' as const;
    })));
  }

  /** Roster includes retired actors: a dismissed subagent's rows still show on the board. */
  @callable()
  async listWorkspaceWork(): Promise<WorkspaceWork> {
    return readWorkspaceWork(
      this.boundSql,
      this.actorHandle(),
      this.workspaceActors().list({ retired: true }),
      await this.hostedPlans(),
    );
  }

  /**
   * Every turn the workspace's actors and agents still owe and every effect the root's settled turns still owe, by the
   * phase each store records, with what each agent whose isolate still owes a wake answers of its own. A turn no live
   * session here runs or awaits is stranded: nothing else will settle it.
   */
  @callable()
  async inspectWork(): Promise<readonly InspectedWork[]> {
    const host = this.actorHost();
    const turns = host.resumable();

    // Named by its path from the tree's root, which names the workspace's own work.
    const actorName = (actorId: string) => {
      const record = host.describe(actorId);

      return record?.parentActorId === null ? null : record?.name ?? actorId;
    };


    const { ledger } = this.terminal;
    // Every agent's turns run in its own isolate: the ones executing are those this activation holds open.
    const agentTurns = new AgentOpenTurns(this.boundSql).all();

    return inspectWork({
      claims: turns.map((turn) => ({ claim: turn.claim, actor: actorName(turn.record.actorId), attempt: turnAttemptOf(this.boundSql, turn.claim) })),
      agentTurns: agentTurns.map((turn) => ({ turnId: turn.turnId, actor: actorName(turn.actorId) ?? turn.actorId })),
      executing: new Set(agentTurns.filter((turn) => this.agentTurns.isOpen(turn.actorId, turn.turnId)).map((turn) => turn.turnId)),
      effects: ledger.pendingSequences().flatMap((sequence) => ledger.owed(sequence)).map((effect) => ({ effect, actor: null })),
      reported: await this.owingAgentsWork(),
      now: Date.now(),
    });
  }

  /**
   * What each agent holding owed work answers of its own, the agents named by their own last report of what they owe
   * (`agent_reports.holds`), not by their wakes: a parked effect is owed with no wake. One that cannot answer is left out.
   */
  private async owingAgentsWork(): Promise<InspectedWork[]> {
    const reported: InspectedWork[] = [];

    await Promise.all(new AgentReports(this.boundSql).holding().filter((actorId) => this.liveActor(actorId)).map((actorId) => settleLogged(
      'subagent.agent_work_unread',
      { doing: "reading what an agent's own isolate still owes", otherwise: 'io' },
      async () => { reported.push(...await this.agentCall(actorId, (isolate, snapshot) => isolate.owedWork(snapshot))); },
      { workspace: this.name, actor: actorId },
    )));

    return reported;
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
      wake: this.ownerAnswerWake('device consent'),
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

  /**
   * How the workspace's agent makes a workspace in its owner's account: through the account's one creation path, at
   * once, kept in the ledger the Changelog reads and in Activity. Only the workspace's own agent holds it (`agentSelf`,
   * and `peers` for the workspace reach), so what it made is that agent's.
   */
  private agentWorkspaceDeps(): AgentWorkspaceDeps {
    return {
      create: async ({ displayName, purpose, soul }) => {
        const { stub: userDO, caller } = await this.userHub();

        return createCloudWorkspaceForUser({ env: this.env, userId: this.requireOwner(), userDO, caller, input: { displayName, purpose }, soul });
      },
      made: ({ workspace, name, brief }) => { this.recordAgentWorkspace({ workspace, name, brief }); },
      link: (workspace) => `${this.env.CLI_PUBLIC_ORIGIN ?? ''}/workspace/${encodeURIComponent(workspace)}`,
    };
  }

  private recordAgentWorkspace(made: { readonly workspace: string; readonly name: string; readonly brief: string }): void {
    new AgentWorkspaceStore(this.boundSql).record({ actorId: this.actorHandle().actorId, ...made, createdAt: Date.now() });
    this.logActivity('workspace_created', `${made.workspace}: ${made.name}`);
  }

  /** Called by the UserDO over DO RPC: what a device call may do now. A call that raises or re-issues a waiting ask is
   *  NOT RUN, and the owner's answer wakes its asker. */
  async askDeviceConsent(req: DeviceConsentRequest): Promise<DeviceConsentVerdict> {
    return this.consents.ask(req);
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
    return { ok: await this.consents.resolve(consentId, decision) };
  }

  /** Lets the chat re-render cards after a reload. */
  @callable()
  async listPendingConsents(): Promise<PendingDeviceConsent[]> {
    return this.consents.list();
  }

  /** Wakes the actor an owner's answer is for. Read through `this.orch` at delivery time, never captured: the queues
   *  that wake are reachable from the runtime's own construction path. A hire is woken on its own durable queue, as its
   *  jobs wake it. */
  private ownerAnswerWake(answered: string): (actorId: string, signal: AgentSignal) => Effect.Effect<void, KinuError> {
    return (actorId, signal) => Effect.asVoid(attempt({ doing: `waking ${actorId} with the owner's ${answered}`, otherwise: 'io' }, () => this.agentDeliveries(actorId).signals.send(signal)));
  }

  // Deferred approval (core safety/deferred-approval.ts): only a parked write runs on approval.
  protected _deferrals: DeferredApprovalQueue | null = null;
  protected get deferrals(): DeferredApprovalQueue {
    this._deferrals ??= new DeferredApprovalQueue({
      store: new DeferredApprovalStore(this.boundSql, this.actorHandle()),
      wake: this.ownerAnswerWake('decision'),
      // Same actor_config as the approval mode, read live by the gate on the next command.
      remember: (grants) => { this.config.grantShellApproval(grants); },
      // "Always for this slate" on a shared slate's effect stands on that slate's owner shares, its sheet's to take back.
      preapprove: async (effect) => { preapproveSlateEffect((await this.slates()).controller.live, effect); },
      // A spent grant's row is deleted, so this event is the only durable record of consumption, naming whose it
      // was. A hire's, or the root's outside any turn, falls back to the workspace run: the root's turn is not theirs.
      audit: (record) => {
        this.eventRecorder.emit(record.actor === this.rt.actor.actorId && this._currentRunId ? this._currentRunId : WORKSPACE_RUN_ID, {
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

  /** The root's channel records its live turn's surface on an ask it parks, so an answer resumes the call there, as a
   *  device consent's does; a hosted actor's turn is not the root's, so its asks record none. */
  protected override deferralChannel(actorId?: string): DeferredApprovalChannel {
    return actorId === undefined ? this.deferrals.channelFor(this.actorHandle().actorId, () => this.turnSurface()) : this.deferrals.channelFor(actorId);
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
  async reviewParkedWrite(id: string): Promise<ParkedWriteReview> {
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

  /**
   * The deploy's walk (`scripts/reset.ts tables`): this workspace's tables and their rows and what its repair did, and,
   * once it is born, each agent whose database it keeps (a retired one's too), opened so it repairs itself, with the
   * same. A wiped or unborn workspace answers for itself alone: it has no agents. Only `/ops/tables` holds the
   * capability. A Nimbus sibling holds no workspace table.
   */
  /**
   * The operator's restore (`/ops/restore`, ARCHITECTURE-DECISIONS W7): this workspace's storage, its agents' facets
   * with it, armed to go back to `target` at its next start; `opsRestart` ends it at once. Only `/ops/*` holds the
   * capability.
   */
  async opsRestore(caller: OpsCaller, target: RestoreTarget): Promise<ArmedRestore> {
    return await restoreArmed(this.ctx, this.env, caller, target);
  }

  /** Ends this activation, so an armed restore lands. */
  async opsRestart(caller: OpsCaller): Promise<void> {
    await restartedForRestore(this.ctx, this.env, caller);
  }

  /** Where this object's history stands now. */
  async opsBookmark(caller: OpsCaller): Promise<string> {
    return await bookmarkNow(this.ctx, this.env, caller);
  }

  /** The slate pictures this workspace's rows name that R2 no longer holds: after a restore, what it could not bring
   *  back. Its devbox's disk is another object's, and no restore takes it back. */
  async opsMissing(caller: OpsCaller): Promise<MissingBytes> {
    await requireOps(this.env, caller);

    return await missingBytes(this.env.SLATE_PICTURES, picturePrefix(this.addressedName), this.pictures.namedKeys(this.addressedName));
  }

  async opsTables(caller: OpsCaller): Promise<TablesAnswer> {
    await requireOps(this.env, caller);
    const reached = !this.nimbusSibling && this.storageRefusal === undefined && this.workspaceBorn() ? this.keptAgents() : [];
    const agents = await Promise.all(reached.map(async ({ name, placement }) => ({ name, ...await (await agentFacet(this.ctx, this.env, placement)).opsTables() })));

    return {
      name: this.addressedName, census: censusOf(this.ctx.storage.sql), repair: this.schemaRepair, refused: this.storageRefusal?.reason ?? null,
      workspaces: [], accounts: [], agents,
    };
  }

  private initTables(): void {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);

    initWorkspaceSchema({
      execRaw, sql: this.boundSql, exec: this.ctx.storage.sql, transactionSync: (write) => this.ctx.storage.transactionSync(write),
    });
    initChangeNotesTable(execRaw);
    initSlatePictureTable(execRaw);
    initSlateBuildTable(execRaw);
    initBrowserSessionTable(execRaw);
    initWorkspaceActorTable(execRaw);

    // Planes only this root carries (declared in test-utils/src/conformance/manifest.ts).
    initWebhookIngressTables(this.ctx.storage.sql);

    initSleepTimeTables(execRaw);
    initTurnBranchesTable(execRaw);
    // Owned by this root: the container is the workspace's; subagents ride their parent's.
    initSandboxLifecycleTable(execRaw);
    initActivationTable(execRaw);
    initForkNoticeTable(execRaw);
  }

  /** Written by the first claim or a fork, never by a start. */
  private workspaceBorn(): boolean {
    return this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`.length > 0;
  }

  /**
   * Whether this workspace is still here, for its deletion's confirmation (`confirmedDeletion`): 1 while its identity
   * stands, which only the wipe removes; 0 once it went, or for a name never born. A new activation makes its tables
   * empty, and one reached before its destroy's end has none at all, so the table is asked for first.
   */
  storedWorkspace(): number {
    return tableExists(this.boundSql, 'workspace_identity') && this.workspaceBorn() ? 1 : 0;
  }

  /** The first claim or fork. */
  protected bearWorkspace(identityName: string, ownerUserId: string): void {
    this.ctx.storage.transactionSync(() => {
      // Through the bound handle, as the roster's own writes go: a read held on the actors sees main arrive.
      bearWorkspaceIdentity(this.boundSql, { id: this.ctx.id.toString(), name: identityName, ownerUserId, createdAt: Date.now() });
    });
    this.registerCompactionExtension();
  }

  /** Synchronous by contract: runs inside blockConcurrencyWhile, which gates every request and
   *  resets the object at 30s (`do.block_concurrency.cancel_ms`); `scripts/do-init-gate.ts` enforces. */
  async onStart(): Promise<void> {
    // A sibling's first RPC starts it too (agents 0.25); it is no workspace, so it records no startup.
    if (this.nimbusSibling) return;

    // The ordinal is the count readers use; a pre-reset store, which takes no writes, numbers nothing. `facets` reads how
    // near the object is to its lifetime facet ids (`do.facet.count`).
    if (this.storageRefusal === undefined) {
      const activation = recordActivation(this.boundSql, Date.now(), this.env.CF_VERSION_METADATA?.id ?? null);

      diagnostics.event('actor.startup', { workspace: this.name, activation, facets: facetNamesGiven(this.boundSql) });
    }

    // An unborn workspace owes nothing: its first claim writes it.
    if (this.storageRefusal !== undefined || !this.workspaceBorn()) return;
    // Row-budgeted (init gate); a truncated pass drains under the wake below.
    this.maintenanceUnfinished = this.maintenanceSweeps();
    // An activation is the only moment a workspace whose wake was lost can notice; the arm is detached.
    this.armDurableWake();
    this.reconcileAgentWakes();

    // The activation only classifies and arms a wake; all dispatch runs under that durable wake,
    // because an activation launches no external work, awaited or detached.
    if (this.owedWorkExists() || this.jobs.countRunningInWorkspace() > 0) {
      this.armOwedWorkWake('reconcile');
    }

    // Stale `running` fork heads are recovered under the terminal wake (`maintenanceWork`), not here:
    // recovery can queue a turn, and awaiting that inside the init gate can reset the object.

    // Boot awaits only this object's SQLite and session composition. A failure fails the start, so the object
    // stays unstarted and every request fails with the cause until one boots; owed work keeps its wake.
    await this.hostedWorkspace().bundle.session();
    this.activationRecovery = this.recoverDeadActivation();
  }

  /**
   * What a death left owed its agents and kept from their wakes: every agent owed a delivery, or owing its isolate a
   * Stop, has its wake intended now, and the alarm is projected again from every intent once the start is done. The
   * agent's wake then crosses what it is owed, its Stop first. Detached, as the activation's other arms are.
   */
  private reconcileAgentWakes(): void {
    // A retired agent's isolate is gone with it, and with it what a Stop would cancel.
    const stopped = this.stops.owedEach().map((stop) => stop.actorId).filter((actorId) => this.liveActor(actorId));

    this.detachOwned(logged('subagent.agent_wake_reconcile_failed', { doing: "reconciling the wakes of agents owed work a reset left", otherwise: 'io' }, async () => {
      await Promise.all([this.coordinator.reconcile(), ...stopped.map((actorId) => this.agentWakes.arm(actorId, Date.now()))]);
      await this.agentWakes.project();
    }, { workspace: this.name }));
  }

  /**
   * Recovery cutoff: heads, swarm rows and runs created at or after this belong to this activation.
   * Strict `<` on purpose: a same-millisecond tie reads as live rather than killing live work.
   */
  private readonly activationStartedAt = Date.now();

  /** {@link recoverDeadActivation}'s run, which every maintenance pass joins first. */
  private activationRecovery: Promise<void> = Promise.resolve();

  private _forkNotices: ForkNotices | null = null;

  private get forkNotices(): ForkNotices {
    this._forkNotices ??= new ForkNotices(this.boundSql, this.activationStartedAt);

    return this._forkNotices;
  }

  /** Starts every due notice; each attempt settles its own row, so none is started twice. */
  private deliverForkNotices(): void {
    const deliveries = forkNoticeDeliveries(this.forkNotices, {
      send: (signal) => this.workspaceAgentDeliveries().signals.send(signal),
      arm: (dueAt) => this.scheduleTerminalRetry(dueAt),
      workspace: this.name,
    }, Date.now());

    for (const delivery of deliveries) this.detachOwned(delivery);
  }




  /**
   * Reconcile the fork journal a dead activation left running, then reclaim the exploration actors it settled.
   * Once per activation, so started only by `onStart`, last, and not awaited: the resume gate re-drives jobs, and a
   * second gate would reclaim a job from the executor the first started.
   */
  private recoverDeadActivation(): Promise<void> {
    this.redriveOrphanedFibers();

    const forks = this.hasLiveExploration() || this.jobs.countRunningInWorkspace() > 0
      // The window the reconcile reads (its default), so this asks what the sweep would find.
      || this.eventRecorder.unterminatedRuns(undefined, this.activationStartedAt).length > 0;

    if (!forks && !this.hasExplorationActors()) return Promise.resolve();

    return settleLogged('head.journal_reconcile_failed', { doing: 'reconciling fork-journal heads a dead activation left running', otherwise: 'io' }, () => this.holdLane(async () => {
      // The seal owns pre-cutoff steer branches, which the reconcile would retire as lost fork work; each pass
      // moves its rows off `running`, so the loop ends.
      let sealing = true;

      while (sealing) sealing = this.reconcileOrphanedBranches();
      await reconcileInterruptedForks({
        now: this.activationStartedAt,
        journal: this.headJournal,
        // The row written synchronously is the acceptance boundary, and the notice's turn belongs outside this frame.
        inbox: {
          send: (signal) => {
            this.forkNotices.hold(signal.idempotencyKey ?? nanoid(), signal, Date.now());
            this.deliverForkNotices();

            return Promise.resolve('queued');
          },
        },
        search: this.mctsSearchStore,
        runEvents: this.eventRecorder,
        // Main's runs are its isolate's (D9): none in this object's recorder is live.
        liveRuns: () => [],
        resume: jobRedriveResumeGate({
          // Every actor's: some jobs have no fiber row.
          recoverOrphans: () => this.jobAuthorities.recoverOrphans(),
          inputOf: (jobId) => this.jobs.getInput(jobId),
          rootsForTask: (task) => resumableForkRoots(
            { ledger: this.mctsSearchStore, journal: this.headJournal }, task,
          ),
        }),
        logActivity: (event, detail) => this.logActivity(event, detail),
      });
      await this.reclaimSettledExplorationActors();
    }), { workspace: this.name });
  }

  /**
   * Every actor's `fibers` rows an earlier activation left, each a lane that died with it. A row is taken by re-stamping
   * it into this activation, so it stays the lane's carrier until its re-drive ends, and a reset before then leaves it
   * for the next. A job's row is the only record of a settled job whose wake never landed.
   */
  private redriveOrphanedFibers(): void {
    let taken = ORPHAN_SEAL_MAX_ROWS;

    while (taken >= ORPHAN_SEAL_MAX_ROWS) {
      const orphans = this.boundSql<{ actor_id: string; id: string; name: string; snapshot: string | null }>`
        UPDATE fibers SET created_at = ${this.activationStartedAt} WHERE rowid IN (
          SELECT rowid FROM fibers WHERE created_at < ${this.activationStartedAt} LIMIT ${ORPHAN_SEAL_MAX_ROWS})
        RETURNING actor_id, id, name, snapshot`;

      taken = orphans.length;

      for (const orphan of orphans) {
        const carried = (): void => { void this.boundSql`DELETE FROM fibers WHERE actor_id = ${orphan.actor_id} AND id = ${orphan.id}`; };

        if (orphan.name === EVOLUTION_LANE_FIBER) {
          // Its inputs are durable, so a fresh pass finishes what the dead one began; that lane's row now carries it.
          this.settleEvolutionInBackground();
          carried();
        } else if (orphan.name.startsWith(BACKGROUND_FIBER_PREFIX) && orphan.snapshot !== null) {
          const snapshot = orphan.snapshot;

          this.detachOwned(logged('jobs.lane_redrive_failed', { doing: 're-driving a background job an earlier activation was running', otherwise: 'io' }, async () => {
            await this.holdLane(() => this.jobAuthorities.recover(parseJsonValue(snapshot)));
            carried();
          }, { workspace: this.name, lane: orphan.name }));
        } else {
          diagnostics.event('fiber.orphan_dropped', { workspace: this.name, lane: orphan.name });
          carried();
        }
      }
    }
  }

  protected override async maintenanceWork(): Promise<boolean> {
    await this.activationRecovery;
    // Main's chat resumes in its own isolate before anything else the wake finishes on its behalf; detached, as its wake is.
    const main = this.actorHandle().actorId;

    if (this.agentWakes.armed(main)) {
      this.detachOwned(logged('subagent.agent_wake_failed', { doing: "waking main's own isolate for what it owes", otherwise: 'io' },
        () => this.wakeAgent(main), { workspace: this.name, actor: main }));
    }

    for (const pending of this.workspaceActors().retirements()) {
      await this.runActorDirectory(pending.caller, pending.parentPath, { action: 'retire', name: pending.name, reference: pending.reference });
    }

    // Every agent's chat turns are claimed in its own isolate, which recovers them; this workspace recovers what its own
    // isolates owe it.
    await this.recoverAgentTurns();

    return await super.maintenanceWork();
  }

  /**
   * Retire exploration actors a reset left behind, against ledgers fork reconciliation settled (S13).
   * Must run after `reconcileInterruptedForks` so an `interrupted` head reads as resumable, not terminal.
   */
  protected async reclaimSettledExplorationActors(): Promise<void> {
    await settleLogged('actor.reconciliation_failed', { doing: 'retiring exploration actors left behind by a reset', otherwise: 'unavailable' }, async () => {
      const { retired } = await reclaimSettledExplorationActors(this.hostedSeams(), {
        readHead: (id) => this.headJournal.readHead(id),
        hasLiveExploration: () => this.hasLiveExploration(),
      });

      if (retired > 0) diagnostics.event('actor.settled_retired', { retired });
    }, { workspace: this.name });
  }

  private hasLiveExploration(): boolean {
    return this.headJournal.hasUnfinishedHeads() || this.mctsSearchStore.hasRunningSwarms();
  }

  /** A search's actor outlives its run until {@link reclaimSettledExplorationActors} retires it. */
  private hasExplorationActors(): boolean {
    return this.watchedExec.exec(
      `SELECT 1 FROM workspace_actors WHERE origin = 'swarm' AND deleted_at IS NULL AND retiring_at IS NULL LIMIT 1`,
    ).toArray().length > 0;
  }

  // Kinu's timer, the `kinu-timer` Lifecycle job (wake-jobs.ts); not an `alarm()` override because
  // Lifecycle owns the DO's single alarm slot.
  // Every source `nextWakeAt` folds must have a phase here. Dedupe on
  // `(trigger_id, scheduled_fire_at)` makes a re-fire after eviction a no-op publish.
  // A wake is a separate invocation from whatever armed it; `tracing.invocation` revokes the handle
  // when this promise settles, so spans cannot cover both.
  /** A hosted hirer's answers reach its own session; a retired hirer's went with it. */
  async _kinuTimerTick(): Promise<void> {
    // A workspace being deleted runs no pump: its triggers, drains and warms are fenced with its admission.
    if (this.admitting.signal.aborted) return;
    const now = Date.now();
    await this.tracing.invocation('alarm', 'tick', async (tick) => {
      // A phase's failure is `fail`ed on its span, not rethrown: the tick continues to the next phase.
      await tick.span('alarm.due_triggers', (span) => settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
        const { fired } = yield* Effect.promise(() => fireDueTriggers({ registry: this.triggerRegistry, log: this.eventLog, watch: this.watching }, now));
        span.setAttribute('kinu.triggers_fired', fired);
      }), phaseFailed(span, { doing: 'firing the triggers due on this wake', otherwise: 'io' }, (failure) => {
        diagnostics.failure('schedule.due_triggers_failed', failure);
      }))));

      // `nextWakeAt` folds `nextPendingDrainAt`, so pending events owe a drain here (D6). The condition
      // uses the same reader and clock as the re-arm so the two cannot disagree about whether it was due.
      await tick.span('alarm.event_drain', (span) => settle(Effect.gen({ self: this }, function* () {
        const dueAt = this.reactionsDueAt(now);
        span.setAttribute('kinu.drain_due', dueAt !== null && dueAt <= now);
        // Each agent's failure is its own: the re-arm below retries it, since the fold still answers due.
        yield* this.drainDueReactions(now);
      })));

      // Durable re-drive of pending outbound peer messages (eviction recovery and backoff retries).
      await tick.span('alarm.peer_dispatch', (span) => settle(Effect.catchCause(
        Effect.promise(() => this.peerHub.dispatchOutbox(now)),
        phaseFailed(span, { doing: 're-driving the pending outbound peer messages', otherwise: 'unavailable' }, (failure) => {
          diagnostics.failure('peer.outbox_dispatch_failed', failure);
        }),
      )));

      // Re-drive `pending` outbound email (SPEC §7.4).
      await tick.span('alarm.email_reconcile', (span) => settle(Effect.catchCause(
        Effect.promise(async () => {
          if (this.env.EMAIL) await this.emailOutbox.reconcile(this.env.EMAIL, now);
        }),
        phaseFailed(span, { doing: 'reconciling indeterminate outbound email', otherwise: 'unavailable' }, (failure) => {
          diagnostics.failure('email.outbox_reconcile_failed', failure);
        }),
      )));

      // Sibling phase because `nextWakeAt` folds the warm row. The lane re-checks the request counter,
      // so a turn started after the arm suppresses the refresh.
      await tick.span('alarm.cache_warm', (span) => settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
        const warmed = yield* Effect.promise(() => this.runDueWarms(now));
        span.setAttribute('kinu.cache_warmed', warmed);
      }), phaseFailed(span, { doing: 'refreshing the prompt-cache prefix this wake was armed for', otherwise: 'unavailable' }, (failure) => {
        diagnostics.failure('cache.warm_failed', failure);
      }))));

      // A failed sleep-time run is not retried by this chain; the settled instant is released first so
      // it cannot answer due on every re-arm. The next completed turn re-arms.
      await tick.span('alarm.sleep_time', (span) => settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
        const ran = yield* Effect.promise(() => this.sleepTime.runIfDue(now));
        span.setAttribute('kinu.sleep_time_ran', ran);
      }), (failed) => Effect.suspend(() => {
        this.sleepTime.releaseWake();

        return phaseFailed(span, { doing: 'running the sleep-time compute this wake was armed for', otherwise: 'unavailable' }, (failure) => {
          if (isDefinitiveTerminalFailure(failure.code)) {
            this.logActivity('terminal_effect_abandoned', `memory compression failed: ${failure.message}, so it is not retried`);
          }

          diagnostics.failure('memory.sleep_time_wake_failed', failure);
        })(failed);
      }))));

      // Soonest-wins arm, so it never clobbers a sooner wake armed during dispatch. Awaited: this link
      // keeps the timer chain alive.
      await tick.span('alarm.timer_rearm', (span) => settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
        const next = this.nextWakeAt(now);
        span.setAttribute('kinu.rearmed', next !== null);

        if (next !== null) yield* Effect.promise(() => this.wakes.arm(KINU_TIMER_JOB, next));
      }), (failed) => {
        const failure = toKinuError({ doing: 're-arming the wake that keeps the timer chain alive', cause: Cause.squash(failed), otherwise: 'io' });

        span.fail(failure);
        diagnostics.failure('schedule.timer_rearm_failed', failure);

        // Rethrown: this failure loses the next wake. An uncaught alarm throw makes the runtime redeliver
        // it (tests/workerd/do-alarm.test.ts), and the redelivered tick re-arms from durable state.
        return Effect.fail(failure);
      })));

      await tick.span('alarm.slate_pictures', (span) => settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
        const capture = this.pictureCapture();

        if (capture === null) return;
        const changed = yield* Effect.promise(() => this.pictures.captureDue(capture, now));
        span.setAttribute('kinu.pictures_changed', changed);

        if (changed) {
          this.overviewChanged();
          // A listed share's card shows its view's picture: the Gallery is told the new one.
          (yield* Effect.promise(async () => this.slates())).controller.relist();
        }
      }), phaseFailed(span, { doing: 'photographing the slates due a picture', otherwise: 'unavailable' }, (failure) => {
        diagnostics.failure('slate.pictures_failed', failure);
      }))));
    });
  }

  async getAgentStatus() {
    return settle(Effect.gen({ self: this }, function* () {
      // A workspace not yet holding its capability cannot read the catalog; it reports only its pins.
      const profile = yield* attempt({ doing: 'resolving the profile the next turn runs on', otherwise: 'unavailable' }, () => this.currentProfile()).pipe(
        Effect.catch((failure) => Effect.sync(() => {
          diagnostics.failure('actor.status_profile_unresolved', failure);

          return null;
        })),
      );

      const status = yield* Effect.promise(async () => getAgentStatus({
        sql: this.boundSql,
        soul: () => workspaceSoul(this.hostedWorkspace().bundle),
        actor: this.rt.actor,
        model: this.effectiveModelSpec(),
        reasoningEffort: profile?.tier.reasoningEffort ?? this.config.getReasoningEffort(),
        name: this.name,
        displayName: await this.workspaceTitle() ?? '',
        layout: this.config.getLayout(),
      }));

      // Main's conversation and its measure are its own isolate's.
      const standing = yield* Effect.promise(async () => await this.mainStanding({ fresh: true }));

      return {
        ...status,
        messageCount: standing.messageCount,
        roleId: profile?.role.id ?? this.activeRoleLabel(),
        tierId: profile?.tier.id ?? 'default',
        context: standing.context,
      };
    }));
  }

  /**
   * Main's standing as its isolate last reported it with what it owes (its input taken, its rest), read against this
   * workspace's window; asked of it only before it ever reported. Before it ran a turn there is nothing there,
   * and no isolate is opened to say so. Its context's fill moves within a turn; the report brings it at the turn's rest, so
   * a page's read of the number (`fresh`) asks the isolate.
   */
  private async mainStanding(opts: { readonly fresh?: boolean } = {}): Promise<AgentStanding> {
    const main = this.actorHandle().actorId;

    if (!this.config.getHoldsTurns()) return { messageCount: 0, context: null, latestRun: null, pendingSteers: [], plans: { pending: false, revision: 0 }, questions: 0 };
    const reported = opts.fresh === true ? undefined : this.reportedReport(main)?.standing;

    if (reported !== undefined) {
      const { measures, ...standing } = reported;

      return { ...standing, context: contextFill(measures, this.modelCatalog.contextWindow()) };
    }

    return await this.agentCall(main, (isolate, snapshot) => isolate.standing(snapshot, this.modelCatalog.contextWindow()));
  }

  /** The agent's newest report as this workspace took it: held as each report arrives, read from where its report was
   *  stored after a cold start, so a background read never wakes the agent; none before its first report. */
  private reportedReport(actorId: string): AcceptedReport | undefined {
    const held = this.reportedReports.get(actorId);

    if (held !== undefined) return held;
    const stored = new AgentReports(this.boundSql).report(actorId);

    if (stored === null) return undefined;
    this.reportedReports.set(actorId, stored);

    return stored;
  }

  /** Each agent's newest report, held: written by each accepted report (`agentOwes`) and its retirement's release
   *  (`agentReportMoved`), dropped with the activation. */
  private readonly reportedReports = new Map<string, AcceptedReport>();

  /** A retired agent's report says it owes nothing: the held copy goes, and the work page moves. */
  private agentReportMoved(actorId: string): void {
    this.reportedReports.delete(actorId);
    this.overviewChanged();
  }

  /** Its plans and questions are written in its own isolate, which the workspace's reads do not watch: a report whose
   *  revisions differ from the last one moves what reads them. */
  private standingMoved(actorId: string, before: AgentStandingReport | undefined, now: AgentStandingReport): void {
    // An agent that never reported had written none.
    if ((before?.plans.revision ?? 0) !== now.plans.revision) {
      if (now.plans.pending) this.agentBound(actorId).stores.config.setHoldsPlans();
      this.hostedPlansMoved();
    }

    if ((before?.questions ?? 0) !== now.questions && this.agentBound(actorId).stores.config.getHoldsQuestions()) this.hostedQuestionsMoved();
  }

  async getToolList() {
    return getToolList(this.boundSql);
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
    return this.pendingActions(await this.hostedPlans());
  }

  private pendingActions(hostedPlans: ReadonlyMap<string, readonly PlanReview[]>): PendingAction[] {
    return buildPendingActions({
      deferredActions: this.deferrals.list(),
      // Each agent's plans are its own isolate's (main's included).
      pendingPlans: this.hostedPendingPlans(hostedPlans).sort((a, b) => b.updatedAt - a.updatedAt),
    });
  }

  private hostedPendingPlans(hostedPlans: ReadonlyMap<string, readonly PlanReview[]>): { owner: string; actor: string; id: string; revision: number; content: string; updatedAt: number }[] {
    return [...hostedPlans].flatMap(([actorId, plans]) => plans
      .filter((plan) => plan.status === 'pending')
      .map((plan) => ({ owner: this.agentOf(actorId).name, actor: actorId, id: plan.id, revision: plan.revision, content: plan.content, updatedAt: plan.updatedAt })));
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
    return getEvolutionChangelog(this.boundSql, this.actorHandle(), {
      limit: opts?.limit, changesOnly: opts?.changesOnly === true, approvals: this.instructionApprovals(),
    });
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
    return await revertChangelogEntryById({ rt: this.rt, facts: this.facts, events: this.eventRecorder, skills: this.refinementDeps }, id);
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
  branchTurn(text: string): Promise<BranchTurnResult> {
    return settle(Effect.gen({ self: this }, function* () {
      const admitted = yield* admitBranch(text, { inFlight: this._inFlight, workMode: this.turnWorkMode() });

      if ('accepted' in admitted) return admitted;
      const { task } = admitted;
      const runtime = this.getCFHeadRuntime();

      if (!runtime) {
        return { accepted: false, reason: 'Branching needs an agent owner (heads require UserDO access).' };
      }

      const id = newBranchId();
      // Read before the await: the branch charges the turn the owner redirected, not whichever runs next.
      const missionLabels = this.budget.scope;
      const redirected = this.mainTurn()?.key.turnId ?? null;
      const inheritedContext = yield* Effect.promise(async () => this.readInheritedContext());
      this._pendingBranches.push({
        id, task,
        handle: startBranchHead(runtime, this.headJournal, {
          id, task, inheritedContext, missionLabels,
        }),
      });

      // The turn the owner redirected settles it, whichever activation its handoff lands on.
      if (redirected !== null) this.turnBranches.admitted(redirected, id);
      this.broadcastBranchStatus({ type: 'branch_status', status: 'running', branchId: id, task });
      this.logActivity('branch_start', task.slice(0, 120));

      return { accepted: true, branchId: id };
    }));
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
      { sql: this.boundSql, actor: this.rt.actor, turnPair: (messageId) => this.mainTurnPair(messageId), inbox: this.workspaceAgentDeliveries().signals },
      takeId, nodeId);

    this.logActivity('take_pick', `${outcome.changedAnswer ? 'alternate' : 'delivered'} (${nodeId})`);

    return outcome;
  }

  /**
   * Server-side merge of run_events, evolution_events, and swarm search nodes into ordered TimelineSpans.
   * Defaults to the active run, else the most recent recorded run.
   */
  @callable()
  async getRunTimeline(opts?: { runId?: string; limit?: number }): Promise<TimelineSpan[]> {
    // Main's runs are its own isolate's: the run in focus and its events are read there, the rest here.
    const recent = (await this.mainCall((isolate, snapshot) => isolate.listRuns(snapshot, { limit: 1 }))).items;
    const runId = opts?.runId ?? recent[0]?.runId;
    const events = runId === undefined ? [] : await this.mainCall((isolate, snapshot) => isolate.runEvents(snapshot, runId, { limit: boundedInt(opts?.limit, RUN_TIMELINE_MAX, 1, RUN_TIMELINE_MAX) }));

    return getRunTimeline({
      sql: this.boundSql,
      actor: this.actorHandle(),
      events: { listRunsBefore: () => [...recent], read: () => events },
      jobs: this.jobs,
      currentRunId: null,
    }, opts);
  }

  /**
   * Runs the current (or pending, with `useShadowOverride`) scaffold one-shot; nothing is injected
   * into chat. Wire form only: the MCP Worker adapter decodes the JSON result at the call site.
   */
  async runScaffoldOnce(task: string, opts?: { useShadowOverride?: boolean }): Promise<ScaffoldRunReport> {
    return scaffoldRunReport(await runScaffoldOnce(this.scaffoldControl, task, opts));
  }

  async getEvolutionStatus(): Promise<EvolutionStatus> {
    return getEvolutionStatus(this.boundSql, this.rt.actor);
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
    const after = (await scaffoldSource(this.rt, version)) ?? "";

    const prevRow = this.sql<{ version: number }>`
      SELECT version FROM scaffold_versions
      WHERE actor_id = ${this.rt.actor.actorId} AND version < ${version}
      ORDER BY version DESC LIMIT 1`;

    const previousVersion = prevRow[0]?.version ?? null;
    const before = previousVersion != null ? (await scaffoldSource(this.rt, previousVersion)) ?? "" : "";
    const d = diffLines(before, after);

    return { version, previousVersion, added: d.added, removed: d.removed, lines: d.lines };
  }

  /** Runs a scaffold version (source from VFS `agent.js.vN`) so it can be previewed before promotion. */
  @callable()
  async previewScaffoldLive(
    version: number,
    task: string,
  ): Promise<ScaffoldRunReport> {
    // Its native chunks do not cross the socket; the report counts them.
    return scaffoldRunReport(await previewScaffoldLive(this.scaffoldControl, version, task));
  }

  /**
   * Stored in actor_config; effective on the next turn. strict (default) rejects gate commands;
   * allow_all treats gate as warn (trusted dev only); deny_all rejects gate and warn.
   */
  @callable()
  async setShellApprovalMode(mode: 'strict' | 'allow_all' | 'deny_all') {
    return setShellApprovalMode({ config: this.config }, mode);
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
   * A thumb is the user's own rating of the turn (`evolution/ratings.ts`); `feedback: null` clears it. A thumb given
   * before the turn's review is the rating its crafted tools are credited with (`EvolutionEngine.reviewTurn`).
   */
  @callable()
  setTurnFeedback(
    messageId: string,
    feedback: 'positive' | 'negative' | null,
  ): Promise<{ ok: true; messageId: string; feedback: 'positive' | 'negative' | null }> {
    return settle(Effect.gen({ self: this }, function* () {
      if (messageId.length === 0) {
        return yield* new KinuError('bad_input', 'messageId must be a non-empty string');
      }

      if (feedback !== null && feedback !== 'positive' && feedback !== 'negative') {
        return yield* new KinuError('bad_input', `feedback must be 'positive', 'negative', or null; got ${JSON.stringify(feedback)}`);
      }

      // The thumb wins over the model's rating of this turn.
      yield* Effect.promise(async () => settleLogged('feedback.explicit_apply_failed', { doing: 'recording a thumb in the rating ledger', otherwise: 'io' }, () => this.engine.applyExplicitFeedback(messageId, feedback), { messageId }));

      return { ok: true, messageId, feedback };
    }));
  }

  /** Scoped to this actor: message ids are unique only within an actor. */
  @callable()
  async listTurnFeedback(): Promise<Record<string, 'positive' | 'negative'>> {
    return Object.fromEntries(listThumbs(this.boundSql, this.actorHandle()));
  }

  /** Scaffold variant archive (read-only); also backs the agent.scaffoldVersions codemode helper.
   *  Keys stay snake_case: ScaffoldLineage.tsx reads the wire shape (written_at). */
  @callable()
  async listScaffoldVersions(limit = 20): Promise<ScaffoldVersionView[]> {
    return listScaffoldVersions(this.boundSql, this.rt.actor, limit);
  }

  /** Satisfaction per day, oldest first, with its interval: the Quality tab's series (evolution/ratings.ts). */
  @callable()
  async getQuality(days = 30): Promise<QualityDay[]> {
    return qualitySeries(this.boundSql, this.actorHandle(), { days });
  }

  /** The last `days` UTC days summed over every rating in them: the Agent tab's verdict. It moves with `getQuality`. */
  @callable()
  async getQualityWindow(days = 7): Promise<QualityWindow> {
    return qualityWindow(this.boundSql, this.actorHandle(), { days });
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
  async getChangeNotes(source: string): Promise<ChangeNote[]> {
    return readChangeNotes(this.rt, source);
  }

  @callable()
  async saveChangeNotes(source: string, notes: readonly ChangeNote[]): Promise<ChangeNotesResult> {
    return saveChangeNotes(this.rt, source, { value: notes });
  }

  @callable()
  async sendChangeNotes(set: NotedChanges): Promise<ChangeNotesResult> {
    return sendChangeNotes(this.rt, { value: set }, this.changeNotesChat);
  }

  /** Main's chat, which notes cross to as one card under their message's id. */
  private get changeNotesChat(): ChangeNotesChat {
    const main = this.actorHandle().actorId;
    const owed = (id: string) => this.deliveries.unpaid(main).some((delivery) => delivery.id === id);
    // Held once committed here, as the agent's own store holds it once taken: one owner of the notes' fate either way.
    const holds = async (id: string) => owed(id) || (await this.agentCall(main, (isolate, snapshot) => isolate.sendState(snapshot, id))).status !== 'none';

    return {
      // Owed once committed, under the notes' own id: a crossing that does not reach the agent leaves them queued for
      // its wake, never a draft again. Only the agent's refusal, which retires them, is the sender's to hear.
      deliver: async (message) => {
        if (await holds(message.id)) return;
        const crossed = await this.deliver(main, { id: message.id, input: { kind: 'words', text: message.text, metadata: message.metadata }, authorship: 'owner' });

        await heard(owed(message.id) ? { admitted: 'taken' } : crossed, () => undefined);
      },
      holds,
    };
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
   * One page of the portable archive (format `kinu import` reads); walk `next` until null.
   * Owner-scoped ('interactive'); workspace capability tiers do not gate it.
   */
  @callable()
  exportWorkspaceArchive(cursor: ArchiveCursor | null = null): Promise<ArchivePage> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.owner();
      const workspace = this.hostedWorkspace().bundle;

      return yield* Effect.promise(async () => readWorkspaceArchivePage(this.ctx.storage.sql, {
        workspace: this.name,
        source: 'cloud',
        cursor: parseArchiveCursor(cursor),
        store: workspaceArchiveStore(workspace),
        agents: this.agentArchiveSource(),
      }));
    }));
  }

  /** The agents whose databases this workspace keeps, by name, and where each lives. */
  private keptAgents(): Array<{ readonly name: string; readonly placement: AgentFacetPlacement }> {
    return this.agentsWithStores().map((actorId) => ({
      name: this.actorDirectoryStore().retained(actorId)?.name ?? actorId, placement: this.agentPlacement(actorId),
    }));
  }

  /** Retired ones hold their stores until destroyed; main's isolate, once it ran a turn, and not opened for none. A store
   *  this version refuses never ran one: its conversation is the workspace's own, old, table. */
  private agentsWithStores(): string[] {
    const mainHolds = (): boolean => this.storageRefusal === undefined && this.config.getHoldsTurns();

    return this.actorDirectoryStore().list({ retired: true })
      .filter((record) => (record.parentActorId === null ? mainHolds() : hostedActorPlacement(record).homeName !== null))
      .map((record) => record.actorId);
  }

  private async agentLedgers(): Promise<SpendLedger[]> {
    const steps = headStepSources(this.boundSql);

    return await Promise.all(this.agentsWithStores().map((actorId) => this.agentCall(actorId, (isolate, snapshot) => isolate.spend(snapshot, steps))));
  }

  private agentArchiveSource(): ArchiveAgentSource {
    const agents = this.agentsWithStores();

    return {
      list: () => agents,
      page: (actorId, cursor, maxBytes) => this.agentCall(actorId, (isolate, snapshot) => isolate.archivePage(snapshot, cursor, maxBytes)),
    };
  }

  /**
   * Tear down per-agent resources (Sandbox first), then wipe this DO; called by UserDO.removeWorkspace.
   * Not @callable: destruction must go through UserDO's ownership check.
   */
  destroyAgent(expectedOwnerUserId: string): Promise<{ ok: true }> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!/^[a-f0-9]{32}$/.test(expectedOwnerUserId)) return yield* new KinuError('bad_input', 'invalid expected owner user id');

      // No owner: a creation that died before its claim, or storage from before a reset. The caller
      // `removeWorkspace` already verified ownership through the user's roster.
      let ownerUserId = this.wipe?.ownerUserId ?? null;

      if (this.wipe === undefined && this.storageRefusal === undefined) ownerUserId = this.getOwnerUserId();

      if (ownerUserId !== null && ownerUserId !== expectedOwnerUserId) return yield* new KinuError('denied', 'Agent owner mismatch; refusing to destroy.');

      if (this.wipe === undefined) {
        // Quieted already when its owner's teardown asked first; a deletion resumed after a restart quiets here.
        yield* this.quietAgents();
        yield* Effect.promise(async () => this.releaseOutsideState(ownerUserId !== null));
      }

      const wipe = this.wipe ??= { ownerUserId, done: this.wipeStorage() };
      yield* Effect.promise(() => wipe.done);

      return { ok: true };
    }));
  }

  /**
   * A deleted account forgotten in this workspace's shares (account deletion): asked by the owner's account, which the
   * deleted one told this workspace shared with it. Not @callable: as `destroyAgent`, it checks the owner it names.
   */
  forgetPerson(expectedOwnerUserId: string, person: { readonly userId: string; readonly email: string }): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      // Never claimed, or storage from before a reset: no share of it admits anyone.
      if (this.storageRefusal !== undefined || this.getOwnerUserId() === null) return;

      if (this.getOwnerUserId() !== expectedOwnerUserId) return yield* new KinuError('denied', 'Agent owner mismatch; refusing to forget a person.');
      const { controller } = yield* Effect.promise(async () => this.slates());
      yield* Effect.promise(async () => controller.forgetPerson(person, (share) => shareViewerKey(this.env, share, person.userId)));
    }));
  }

  /** `claimed`: it had an owner, so it may have had agents and their memory; one that never did has neither. */
  private async releaseOutsideState(claimed: boolean): Promise<void> {
    // First: revoke all preview URLs, else answering a stale one would create a fresh container object.
    // The watermark outranks every earlier record (core preview/preview-exposures.ts).
    if (this.env.AUTH_KV) {
      await sandboxPreviewExposures(
        this.env.AUTH_KV, sandboxIdForWorkspace(this.name),
      ).revokeAll();
      // Then its records go: no port of it is published again, so none needs keeping.
      await forgetSandboxPreviews(this.env.AUTH_KV, sandboxIdForWorkspace(this.name));
    }

    // Its agents' browsers on Browser Run hold their pages until they sit idle out: closed now. Its memory's vectors live
    // in a shared index, outside its storage: deleted now, while its chunks still name them.
    await closeWorkspaceBrowserSessions(this.ctx.storage.sql, this.env.BROWSER);

    if (claimed) await this.rt.forgetMemoryVectors();

    const sb = this.computerBox();

    if (sb !== undefined) {
      // Before destroy(): the container object owns its /workspace snapshot, and
      // once its storage is gone nothing knows which R2 objects were its.
      await sb.discardState();
      await sb.destroy();
    }
  }

  private wipe: { readonly ownerUserId: string | null; readonly done: Promise<void> } | undefined;

  /**
   * The owner's teardown asks this first, while the workspace still holds its authority: its agents stop and every
   * call they still have open here is answered. A call cut by the revoke or the wipe that follow hangs its relay, and
   * one that finishes after the wipe re-arms a wake on the emptied object. Not @callable: as `destroyAgent`.
   */
  quietForDeletion(expectedOwnerUserId: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      if (this.wipe !== undefined) return;
      // Never claimed, or storage from before a reset: nothing it holds can be checked, and no agent of it runs here.
      const ownerUserId = this.storageRefusal === undefined ? this.getOwnerUserId() : null;

      if (ownerUserId !== null && ownerUserId !== expectedOwnerUserId) return yield* new KinuError('denied', 'Agent owner mismatch; refusing to quiet for deletion.');

      // Its shares end while it still holds its authority, each listed one taken off the Gallery: a deleted workspace
      // sends nothing after, and the control plane forgets it only when it learns of it.
      if (ownerUserId !== null) {
        yield* logged('workspace.shares_end_failed', { doing: "ending a deleted workspace's live shares", otherwise: 'unavailable' },
          async () => { await (await this.slates()).controller.endLiveShares(); }, { workspace: this.name });
      }

      yield* this.quietAgents();
    }));
  }

  /** Aborted once a deletion began: no agent's call reaches this object's stores after it, and each still open is
   *  refused then. */
  private readonly deleting = new AbortController();

  /** Aborted as a deletion's quiet begins, before it waits on anything: no agent takes new words, a wake, a turn or a
   *  tool call after it, while the turns it stops still close and hand off here. */
  private readonly admitting = new AbortController();

  /** Refuses new work for an agent once a deletion's quiet began, with the refusal the quiet aborted with. */
  private admitWork(): void {
    this.admitting.signal.throwIfAborted();
  }

  /**
   * A deletion's quiet (design v2 §6), alike for every agent, with no first and no last: admission and the pumps are
   * fenced, what every agent was owed is cancelled with its wake, every agent opened here stops and its closes drain while
   * its calls still reach this object (a settled turn's effects read the registry with the workspace's capability), and
   * only then is every call revoked. One quiet, joined by every caller, a deletion's and its destroy's, and kept: it
   * never fails, since an agent it could not stop is logged and the destroy goes on without it.
   */
  private readonly quietAgents = flight(() => this.quietAgentsOnce(), { keep: 'exit' });

  private quietAgentsOnce(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (!this.admitting.signal.aborted) this.admitting.abort(new KinuError('missing', 'This workspace is being deleted.'));

      this.ctx.storage.transactionSync(() => {
        for (const actorId of this.deliveries.actors()) this.deliveries.cancel(actorId);
      });
      // Its agents' wakes end as it begins, and none is armed after: a deletion whose destroy fails wakes nothing.
      yield* logged('workspace.agent_quiet_failed', { doing: "ending a deleted workspace's agents' wakes", otherwise: 'io' },
        () => this.agentWakes.end(), { workspace: this.name });

      // Each agent opened here is stopped, whether or not its wake said it held a turn, and its closes drain.
      yield* Effect.forEach([...this.openedIsolates].filter((actorId) => this.liveActor(actorId)), (actorId) => logged(
        'workspace.agent_quiet_failed', { doing: "stopping a deleted workspace's agent and draining its closes", otherwise: 'unavailable' },
        async () => {
          await this.agentTurns.interrupt(actorId, null);
          await this.agentQuiet(actorId);
        },
        { workspace: this.name, actor: actorId },
      ), { concurrency: 'unbounded', discard: true });

      yield* logged('workspace.agent_quiet_failed', { doing: "draining a deleted workspace's settled turns' closes", otherwise: 'unavailable' },
        () => this.terminalClosed(), { workspace: this.name });

      if (!this.deleting.signal.aborted) this.deleting.abort(new KinuError('missing', 'This workspace was deleted.'));
    });
  }

  private async wipeStorage(): Promise<void> {
    // Drops SDK tables, alarms and storage, every agent facet's included (measured in tests/workerd/delete-all.test.ts,
    // m1924); the isolate resets later, so a concurrent delete joins `wipe`.
    const name = this.name;
    await this.destroy();
    this.ctx.storage.kv.put(PERSISTED_NAME_KEY, name);
  }

  @callable()
  async getFacts(limit = 100): Promise<Array<Pick<Fact, 'key' | 'value' | 'confidence' | 'source' | 'lastObservedAt'>>> {
    return this.facts.recentTopK(limit).map((f) => ({
      key: f.key, value: f.value, confidence: f.confidence, source: f.source, lastObservedAt: f.lastObservedAt,
    }));
  }

  getTurnRequests(turnId: string, actor?: string): Promise<TurnRequestIndex> {
    return settle(Effect.gen({ self: this }, function* () {
      const agent = yield* this.requestHolder(actor);

      return yield* Effect.promise(() => this.agentCall(agent, (isolate, snapshot) => isolate.turnRequests(snapshot, turnId)));
    }));
  }

  getTurnRequest(
    turnId: string, at: { readonly epoch: number; readonly revision: number; readonly from?: number; readonly actor?: string },
  ): Promise<TurnRequestPage> {
    return settle(Effect.gen({ self: this }, function* () {
      const read = { turnId, epoch: at.epoch, revision: at.revision, ...(at.from !== undefined && { from: at.from }) };
      const agent = yield* this.requestHolder(at.actor);

      return yield* Effect.promise(() => this.agentCall(agent, (isolate, snapshot) => isolate.turnRequest(snapshot, read)));
    }));
  }

  /** The workspace agent's newest answered turns, from its isolate: what a scaffold is replayed against. */
  async recordedTurns(limit?: number): Promise<RecordedTurn[]> {
    return decodeRecordedTurns(await this.agentCall(this.actorHandle().actorId, (isolate, snapshot) => isolate.recordedTurns(snapshot, limit)));
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

  /** Whose isolate holds `actor`'s requests, main's by default: every agent's are its isolate's (D9), so an id that names
   *  none is the one refusal. */
  private requestHolder(actor: string | undefined): Effect.Effect<string, KinuError> {
    const agent = actor ?? this.actorHandle().actorId;

    return this.isAgent(agent) ? Effect.succeed(agent) : Effect.fail(new KinuError('missing', 'The actor is not registered in this workspace.'));
  }

  /** For resume, pass the last seen `since` index; returns events strictly after it. A turn's run is main's, in its own
   *  isolate; any other (a branch head's, the workspace's own lanes) is this object's. */
  async getRunEvents(runId: string, opts?: RunEventQuery): Promise<RunEvent[]> {
    return await this.runRead(runId, opts, (isolate, snapshot) => isolate.runEvents(snapshot, runId, opts ?? null), getRunEvents);
  }

  /** Not @callable: serves the run-event routes. */
  async getRunEventText(runId: string, opts?: RunEventQuery): Promise<StoredRunEvent[]> {
    return await this.runRead(runId, opts, (isolate, snapshot) => isolate.runEventText(snapshot, runId, opts ?? null), getRunEventText);
  }

  /** A run's events: main's isolate holds a turn's, this object any other run's. */
  private async runRead<Event>(
    runId: string, opts: RunEventQuery | undefined,
    turn: (isolate: AgentFacetCalls, snapshot: AgentSnapshot) => Promise<Event[]>,
    own: (recorder: RunEventRecorder, runId: string, opts?: RunEventQuery) => Event[],
  ): Promise<Event[]> {
    const read = await this.mainCall(turn);

    return read.length > 0 ? read : own(this.eventRecorder, runId, opts);
  }

  /** Not @callable: the web UI uses `getRunSummaries`; serves `/runs`, MCP and CLI. Every run that starts is a turn of
   *  main's, in its own isolate. */
  async listRuns(request?: PageRequest): Promise<Page<RunListEntry>> {
    return await this.mainRunPage((isolate, snapshot) => isolate.listRuns(snapshot, request ?? null));
  }

  /** A call into main's own isolate, where its conversation and runs are kept (D9). */
  private async mainCall<A>(call: (isolate: AgentFacetCalls, snapshot: AgentSnapshot) => Promise<A>): Promise<A> {
    return await this.agentCall(this.actorHandle().actorId, call);
  }

  /** A page of main's runs: none until it has held a turn, so a fresh workspace never opens its isolate to list them. */
  private async mainRunPage<Entry>(read: (isolate: AgentFacetCalls, snapshot: AgentSnapshot) => Promise<Page<Entry>>): Promise<Page<Entry>> {
    if (!this.config.getHoldsTurns()) return { status: 'end', items: [] };

    return await this.mainCall(read);
  }

  @callable()
  inspectSubagent(request: SubagentInspectionRequest): Promise<SubagentInspectionResult> {
    return settle(Effect.gen({ self: this }, function* () {
      const owner = yield* this.owner();

      return yield* Effect.promise(async () => this.inspectSubagentStorage(request, { owner, workspace: this.name }));
    }));
  }

  /** Resolved through the directory under this root's handle, so a name only reaches this root's children. */
  private hostedChild(target: string) {
    return Effect.gen({ self: this }, function* () {
      yield* this.owner();
      const actor = this.hostedTarget(target);

      if (actor === null) return yield* new KinuError('missing', `"${target}" is not an agent of this workspace.`);

      return { entry: actor.entry, child: this.actorHost().bindStores(actor.handle) };
    });
  }

  /** The pane's read of a chat, the workspace agent's or `actor`'s alike: one read for any pane. */
  @callable()
  getActorSnapshot(actor?: string): Promise<ActorSnapshot> {
    return settle(Effect.gen({ self: this }, function* () {
      if (actor === undefined) return yield* Effect.promise(async () => this.mainSnapshot());
      const { entry, child } = yield* this.hostedChild(actor);
      const actorId = child.handle.actorId;

      // The effective model: the actor's own pin, else the workspace's, else its tier's, with its source.
      const { profile } = yield* Effect.promise(async () => this.actorProfile({
        actor: child.handle, availableTools: [], workMode: 'build',
      }));

      return {
        name: entry.name,
        actorId,
        displayName: child.stores.config.getDisplayName() ?? entry.name,
        role: child.stores.config.getRoleSelection(),
        mission: entry.birth?.seed.mission ?? '',
        model: { model: profile.tier.model, source: profile.tier.source },
        reasoningEffort: profile.tier.reasoningEffort,
        // Its plans live in its own isolate (D9).
        activePlan: yield* Effect.promise(async () => await this.agentCall(actorId, (isolate, snapshot) => isolate.activePlanReview(snapshot))),
        messageCount: yield* Effect.promise(async () => this.agentCall(actorId, (isolate, snapshot) => isolate.messageCount(snapshot))),
        // Its own isolate's sends, as its conversation is.
        pendingSteers: (yield* Effect.promise(async () => await this.agentCall(actorId, (isolate, snapshot) => isolate.standing(snapshot, null)))).pendingSteers,
      };
    }));
  }

  /** The workspace agent's chat, as {@link getActorSnapshot} reads a hosted one's: its profile the one its next turn runs. */
  private async mainSnapshot(): Promise<ActorSnapshot> {
    const [profile, activePlan, standing, displayName, mission] = await Promise.all([
      this.currentProfile(), this.getActivePlanReview(), this.mainStanding({ fresh: true }), this.workspaceTitle(), this.ownMission(),
    ]);

    return {
      name: this.name,
      actorId: this.actorHandle().actorId,
      displayName: displayName ?? '',
      role: this.config.getRoleSelection(),
      mission,
      model: { model: this.effectiveModelSpec(), source: profile.tier.source },
      reasoningEffort: profile.tier.reasoningEffort,
      activePlan,
      messageCount: standing.messageCount,
      pendingSteers: standing.pendingSteers,
    };
  }

  /**
   * Broadcasts only a plan reference; not `@callable`, and deliberately not `broadcast`, which
   * facets must not reach. A hint: readers re-verify via owner-gated `inspectSubagent`; a stub
   * call carries no caller identity.
   */
  announceSubagentPlan(reference: WorkspacePlanReference): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const parsed = v.parse(WorkspacePlanReferenceSchema, reference);
      const name = parsed.path[0];

      if (!name || !this.subagentRoster.get(name)) {
        return yield* new KinuError('denied', 'This workspace has no such plan actor.');
      }

      this.broadcastToActor(null, JSON.stringify({ type: 'workspace_plan_updated', reference: parsed }));
    }));
  }

  @callable()
  async getRunSummaries(request?: PageRequest): Promise<Page<RunSummary>> {
    return await this.mainRunPage((isolate, snapshot) => isolate.runSummaries(snapshot, request ?? null));
  }

  async accountSpend(): Promise<AccountSpend[]> {
    return mergeAccountSpend([this.eventRecorder.spendByAccount(), ...(await this.agentLedgers()).map((ledger) => ledger.accounts)]);
  }

  /** The machine's name is read from the account, so it is current. */
  private async codexRoute(deviceId: string | null): Promise<NonNullable<ActivitySnapshot['latest']>['route']> {
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
    const windowLimit = boundedInt(opts?.steps, ACTIVITY_STEP_WINDOW, 1, ACTIVITY_STEP_WINDOW);
    const logLimit = boundedInt(opts?.logs, ACTIVITY_LOG_WINDOW, 1, ACTIVITY_LOG_WINDOW);
    // Main's steps are its own isolate's; warms are this object's lane.
    const { steps, newestMeasured } = await this.mainCall((isolate, snapshot) => isolate.steps(snapshot, windowLimit));

    // Warms are `model_call` rows, never steps, so they cannot skew the EMA; they are only counted.
    const warms = this.eventRecorder.readRecentByType('model_call', windowLimit)
      .flatMap((e) => (e.type === 'model_call' && e.source === 'warming' ? [e] : []));

    const newest = newestMeasured ?? undefined;
    const deviceId = newest?.egress?.startsWith('device ') === true ? newest.egress.slice('device '.length) : null;

    return {
      latest: newest === undefined
        ? null
        : {
          at: Date.parse(newest.timestamp) || Date.now(),
          runId: newest.runId,
          stepIndex: newest.stepIndex,
          usage: newest.usage ?? {},
          context: newest.context ?? null,
          modelId: newest.modelId ?? null,
          route: await this.codexRoute(deviceId),
        },
      // Null rather than a default: a share-of-window shown against a guessed
      // window would be a made-up percentage.
      contextWindow: this.modelCatalog.contextWindow(),
      fill: (await this.mainStanding({ fresh: true })).context,
      // Every step in the window, reporting or not: `summarizeSteps` counts the
      // silent ones into `stepsWithoutUsage` so the totals carry their own
      // denominator instead of quietly under-counting.
      telemetry: summarizeSteps(steps, { windowLimit, warms }),
      // Not `this.budget.snapshot()`: that answers a narrower question, and two mission figures
      // would conflict.
      spend: workspaceSpend({ events: this.eventRecorder, sql: this.boundSql, actor: this.actorHandle(), others: await this.agentLedgers() }),
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
  runTaskFromMcp(text: string): Promise<EnqueueTurnResult> {
    return settle(Effect.gen({ self: this }, function* () {
      const trimmed = text.trim();

      if (!trimmed) return yield* new KinuError('bad_input', 'run_task requires non-empty text');

      // A task, as the operator's message is: a turn of its own, never spliced into one already running.
      const outcome = yield* Effect.promise(async () => this.workspaceAgentDeliveries().signals.send({
        kind: 'mcp', text: trimmed, opensTurn: true,
        metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator' },
      }));

      return { status: outcome === 'undelivered' ? 'skipped' : 'queued' };
    }));
  }

  /** Fire-and-forget over the peer-deps transport; owner + same-owner roster gate is enforced there. */
  sendPeerFromMcp(input: { agent: string; topic?: string; message: string }): Promise<PeerSendOutcome> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!input?.agent || !input?.message) return yield* new KinuError('bad_input', 'send_peer requires agent and message');

      return yield* Effect.promise(async () => this.getPeersToolDeps().send({
        agent: input.agent,
        topic: (input.topic ?? '').trim() || 'message',
        message: input.message,
        mode: 'build',
      }));
    }));
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
    // The workspace's notes alone: a remote caller has never been shown its facts or the account's.
    return (await searchMemoryHits(this.rt.memory, this.rt.vectorStore, query, { limit })).hits;
  }

  @callable() async getMemoryContent() {
    // `read` returns null only for an absent file; other VFS failures must throw, since "" would
    // be indistinguishable from an empty MEMORY.md.
    return await this.rt.memory.read(MEMORY_PATH) ?? "";
  }

  /** The workspace root's read models, held to workspace.read by unit-slate-sources. */
  protected override async slateReadModel(source: SlateReadModel): Promise<JsonValue> {
    const reads = {
      getExecutors: () => this.getExecutors(),
      getHeadRuns: () => this.getHeadRuns(),
      getMctsTree: () => this.getMctsTree(),
      getQuality: () => this.getQuality(),
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
    return (await this.slates()).controller.operation(this.slateCaller(), operation);
  }

  /** The workspace agent's own program acting on its slates, from the turn it runs in. */
  protected override async programSlate(operation: SlateOperation, turn?: string): Promise<SlateCallResult> {
    return (await this.slates()).controller.operation(this.slateCaller(), operation, turn);
  }

  /** An actor of this workspace acting as itself, from the program `turn` runs; DO-only, like `workspaceBoxOp`. */
  async slateAs(caller: SlateCaller, operation: SlateOperation, turn?: string): Promise<SlateCallResult> {
    return (await this.slates()).controller.operation(caller, operation, turn);
  }

  override async slateBuild(slate: string): Promise<SlateCallResult> {
    return (await this.slates()).controller.build(this.slateCaller(), slate);
  }

  /** Whether a slate still builds, for an actor of this workspace acting as itself; DO-only, like `slateAs`. */
  /** Whether a slate still builds, asked as the named actor builds it. */
  private slateBuildFor(name: string): (slate: string) => Promise<SlateCallResult> {
    return (slate) => this.slateBuildAs({ path: [{ name }], cred: ROOT_SLATE_CALLER.cred, workMode: 'build' }, slate);
  }

  async slateBuildAs(caller: SlateCaller, slate: string): Promise<SlateCallResult> {
    return (await this.slates()).controller.build(caller, slate);
  }

  private _slateHosting: WorkspaceSlates | undefined;

  /** The workspace's slates, made at their first use (workspace-slates.ts). */
  private get slateHosting(): WorkspaceSlates {
    this._slateHosting ??= new WorkspaceSlates({
      ctx: this.ctx, workspace: this.name,
      session: () => this.hostedWorkspace().bundle.session(),
      facetManager: () => this.hostedWorkspace().facetManager(),
      bundler: (vfs) => supervisorEsbuildService(this.ctx, this.env, vfs),
      // A share's caller carries its viewer through, so what the call reaches inside itself is held to the grant.
      dispatch: (caller, route, context) => this.slateCallDispatch(caller.path, route, caller.workMode, { ...context, ...(caller.share !== undefined && { viewer: true }) }),
      browserActor: async (caller) => (caller.share === undefined ? this.slateCallerActorId(caller.path) : null),
      secrets: () => this.account.commandEnvironment('keep', 'owner'),
      apps: {
        ensure: (input) => this.hostedWorkspace().apps.ensure(input),
        remove: (owner) => this.hostedWorkspace().apps.remove(owner),
        url: (port, capability) => nimbusPreviewUrl(this.env, this.name, port, capability),
        owners: async () => new Map([...await listPortReservations(this.ctx)].flatMap(([port, held]) => (held.owner === null ? [] : [[port, held.owner] as const]))),
      },
      ownerMcpSurface: async () => await this.requireOwnerUserDO().userMcp_toolDescriptors(await this.userCaller()),
      // A shared slate's approvals name a call's resource only as its tool's contract does: the preset its connection is.
      toolContract: async (namespace, member) => {
        if (!namespace.startsWith('mcp.')) return null;
        const surface = v.parse(McpToolSurfaceSchema, await this.requireOwnerUserDO().userMcp_toolDescriptors(await this.userCaller()));
        const descriptor = surface.descriptors.find((each) => `mcp.${each.serverName}` === namespace && each.name === member);

        return descriptor === undefined ? null : { preset: descriptor.presetId ?? null, tool: member };
      },
      shareEntry: (share) => liveShareEntryPage(this.env, this.name, share),
      kv: this.env.AUTH_KV,
      budget: () => this.budget,
      ownerTitle: async () => this.safeDisplayName(),
      ownerUserId: () => this.getOwnerUserId(),
      viewerKey: (share, userId) => shareViewerKey(this.env, share, userId),
      // `owner` shares' effects wait on the owner in the workspace's one queue, as every parked action does.
      ownerEffects: {
        ask: (id, effect) => this.deferrals.slateEffect(id, effect),
        take: (id) => this.deferrals.takeSlateEffect(id),
        settle: (spend, outcome) => this.deferrals.settle(spend, outcome),
        retire: (slate, only) => { this.deferrals.retireSlateEffects(slate, only); },
      },
      // The Gallery's index is a copy of the shares listed here: told as the owner lists, unlists or revokes, and again in
      // the background at each start of the slates, which mends one it missed.
      listingChanged: async (share) => settleLogged('gallery.listing_sync_failed', { doing: "telling the Gallery a share's listing", otherwise: 'unavailable' },
        async () => this.syncListing(share), { workspace: this.name, share: share.id }),
      relisted: (shares) => {
        this.detachOwned(logged('gallery.listing_sync_failed', { doing: "telling the Gallery this workspace's listings again", otherwise: 'unavailable' },
          async () => { await Promise.all(shares.map(async (share) => this.syncListing(share))); }, { workspace: this.name }));
      },
      shared: (operation) => this.editShared(operation),
      // Each viewer's own account answers their parts' calls, with their consents and connections: never this workspace.
      partConnections: {
        // Prepared first, then the run's word read again with nothing awaited before the viewer's account is called.
        tool: async (viewer, call, admit) => this.viewerAccount(viewer.userId, admit, async (account, caller) => account.slatePartTool(caller, call)),
        ai: async (viewer, call, admit) => this.viewerAccount(viewer.userId, admit, async (account, caller) => account.slatePartAi(caller, call)),
        consented: async (viewer, calls) => objectNamed(this.env.UserDO, viewer.userId).slatePartConsented(await ownerCaller(this.env), calls),
      },
      forgetPicture: async (slate) => {
        await this.pictures.forget(this.name, slate, this.env.SLATE_PICTURES);
        this.armDurableWake();
      },
      previewed: (slate) => { this.noteTurnSlates('shown', [slate]); },
      messageBlock: (address) => this.answerBlock(address),
      sharesChanged: async () => {
        this.overviewChanged(true);

        return await this.overview.settled() === null ? 'current' : 'pending';
      },
    });

    return this._slateHosting;
  }

  private slates(): Promise<SlateHost> {
    return this.slateHosting.load();
  }

  /**
   * The block an answer's page is read from, every text part as the chat draws it. The workspace's own answer runs
   * with its authority in the mode its next turn runs in. A hired agent's is read from its own isolate and drawn with
   * no authority lent to it: a call run from here would not run where that agent's stores are.
   */
  private async answerBlock(address: EphemeralSlateAddress): Promise<MessageBlock> {
    if (address.actorId !== null) {
      const answer = this.liveActor(address.actorId)
        ? await this.agentCall(address.actorId, (isolate, snapshot) => isolate.answerTexts(snapshot, address.messageId))
        : null;

      return { html: addressedBlock(answer?.texts ?? [], address).html, author: null };
    }

    const answer = await this.mainCall((isolate, snapshot) => isolate.answerTexts(snapshot, address.messageId));

    return { html: addressedBlock(answer?.texts ?? [], address).html, author: { ...ROOT_SLATE_CALLER, workMode: await this.preparedWorkMode() } };
  }

  async slateCallAs(from: SlateCallFrom, request: SlateCallRequest): Promise<SlateSurfaceResult> {
    return (await this.slates()).surfaceCall(from, request);
  }

  /**
   * This workspace's owner reading or changing a slate another workspace shared with them to edit: its owner's workspace
   * decides whether they may, by who they are, which this object names and never the program that asked.
   */
  editShared(operation: Extract<SlateOperation, { op: 'sharedFiles' | 'sharedEdit' }>): Promise<SlateCallResult> {
    return settle(slateAnswer(`editing ${operation.workspace}/${operation.slate}`, Effect.gen({ self: this }, function* () {
      const userId = this.getOwnerUserId();
      const email = yield* attempt({ doing: 'reading the workspace owner', otherwise: 'unavailable' }, async () => this.email.ownerEmail());

      if (userId === null || email === null) return yield* new KinuError('denied', 'This workspace has no owner to edit as');
      const editor = { userId, email: email.trim().toLowerCase() };
      const owner = workspaceOwner(this.env, operation.workspace);

      const answered = yield* attempt({ doing: `asking ${operation.workspace}`, otherwise: 'unavailable' },
        async () => (operation.op === 'sharedFiles' ? owner.slateFilesFor(operation.slate, editor) : owner.editSlateAs(operation.slate, editor, operation.files)));

      if (!answered.ok) return yield* new KinuError(answered.reason, answered.error);

      // Its files cross from another workspace's object: held to their shape as every reader of them holds them.
      return operation.op === 'sharedFiles' ? v.parse(SharedSlateFilesSchema, answered.value) : v.parse(v.array(v.string()), answered.value);
    })));
  }

  /** DO-only: one of this workspace's slates' files, for someone one of its live shares adds to edit it now. */
  async slateFilesFor(slate: string, editor: SlateEditor): Promise<SlateCallResult> {
    return (await this.slates()).filesFor(slate, editor);
  }

  /** DO-only: a change to one of this workspace's slates by someone one of its live shares adds to edit it now. */
  async editSlateAs(slate: string, editor: SlateEditor, files: SlateFileChange): Promise<SlateCallResult> {
    return (await this.slates()).editAs(slate, editor, files);
  }

  async runSlatePart(viewer: PartViewer | null, slate: string, part: string, request: PartRunRequest): Promise<PartRunAnswer | null> {
    return (await this.slates()).parts.run(viewer, slate, part, request);
  }

  async slatePartCall(slate: string, run: string, name: string, call: { readonly path: readonly string[]; readonly args: readonly JsonValue[] }): Promise<SlateSurfaceResult> {
    return (await this.slates()).parts.call(slate, run, name, call);
  }

  /** A viewer's own account, called once its caller is prepared and `admit` holds, with nothing awaited between. */
  private async viewerAccount<T>(userId: string, admit: () => void, send: (account: DurableObjectStub<UserDO>, caller: Awaited<ReturnType<typeof ownerCaller>>) => Promise<T>): Promise<T> {
    const caller = await ownerCaller(this.env);

    admit();

    return send(objectNamed(this.env.UserDO, userId), caller);
  }

  async releaseSlatePart(viewer: PartViewer, continuation: string): Promise<boolean> {
    return (await this.slates()).parts.release(viewer, continuation);
  }

  async showSlatePart(viewer: PartViewer, slate: string, part: string, request: PartShowRequest): Promise<SlateCallResult> {
    return (await this.slates()).parts.show(viewer, slate, part, request);
  }

  async callOperation(caller: OperationCaller, id: string, input: JsonValue, call: { readonly callId: string }): Promise<OperationResult> {
    const stop = new AbortController();

    this.operationCalls.set(call.callId, stop);

    const cancelled = () => new KinuError('cancelled', `${id} was cancelled by its caller`);

    // A refusal is the call's answer, as it left the operation; a cancelled call's answer is its cancellation, however
    // the operation ended.
    return await settle(Effect.ensuring(
      Effect.promise(() => this.withReachedOperations(this.operationActor(caller.actorId), caller.mode, (providers) => callOperation(providers, id, input, { callId: call.callId, signal: stop.signal })))
        .pipe(
          Effect.catchCause((cause) => (stop.signal.aborted ? Effect.fail(cancelled()) : Effect.failCause(cause))),
          Effect.flatMap((answer) => (stop.signal.aborted ? Effect.fail(cancelled()) : Effect.succeed(answer))),
        ),
      Effect.sync(() => { this.operationCalls.delete(call.callId); }),
    ));
  }

  async listOperations(caller: OperationCaller): Promise<readonly OperationListing[]> {
    return await this.withReachedOperations(this.operationActor(caller.actorId), caller.mode, async (providers) => listOperations(providers));
  }

  async cancelOperation(callId: string): Promise<void> {
    this.operationCalls.get(callId)?.abort(new KinuError('cancelled', 'The caller cancelled the operation'));
  }

  /** Every agent is reached by its live directory entry. */
  private operationActor(actorId: string): ActorReference {
    return actorReferenceOf(this.actingAgentOf(actorId));
  }

  /** The share route has already verified the request; admission and routing live on the slate host,
   * never in this method. */
  async routeSlateShare(
    handle: string,
    claim: ShareViewerClaim,
    request: Request,
    pathname: string,
  ): Promise<Response> {
    return (await this.slates()).routeShare(handle, claim, request, pathname);
  }

  /** The URL a live share answers at, or null where this deployment cannot mint one. */
  liveShareUrl(handle: string): Promise<string | null> {
    return slateShareUrl(this.env, this.name, handle);
  }

  /** Minted by the app host because only it knows the signed-in user; binds that user to this share. */
  viewerEntryUrl(handle: string, userId: string): Promise<string | null> {
    return viewerEntryUrl(this.env, this.name, handle, userId);
  }

  /** The share row re-read through the S6 gate, plus title and description from the slate's package.json, and whether
   *  its address admits `reader`: anyone to a public share, else its owner and the people it names, as the host does.
   *  No one signed in (`null`) is admitted to a public share alone. */
  /**
   * A live share opened through its link by `reader` (null signed out): whether it admits them, and if it does, the open
   * counted under `viewer`, the per-share key of their account (`shareViewerKey`) or the signed-out bucket. The owner's
   * own opens are not counted. A listed share's Gallery card is told its viewers by its next listing sync, made from
   * here at most once an hour, so the Gallery is never written per open.
   */
  async openLiveShare(share: string, reader: string | null, viewer: string): Promise<SlateAnswer<LiveShareReading>> {
    const { controller } = await this.slates();
    const read = await controller.readLiveShareRecord(share);

    if (!read.ok) return read;
    const { record } = read.value;
    const owner = reader !== null && reader === this.getOwnerUserId();
    const admits = record.visibility === 'public' || owner || (reader !== null && controller.live.hasUser(share, reader));

    if (admits && !owner) {
      controller.live.opened(share, viewer);

      if (record.gallery !== null && Date.now() - (this.viewsSynced.get(share) ?? 0) >= VIEWS_SYNC_MS) {
        this.viewsSynced.set(share, Date.now());
        controller.relist(record.slate);
      }
    }

    return { ...read, value: { ...read.value, admits } };
  }

  /** A live share's tree, for a user forking it, held to the share's admission and grant. */
  async liveShareBundle(share: string, userId: string): Promise<SlateAnswer<BlueprintBundle>> {
    return (await this.slates()).controller.liveShareBundle(share, userId);
  }


  /** DO-only, like the blueprint twin, for the same reason. */
  async shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<OwnedLiveShare>> {
    return (await this.slates()).controller.shareLiveWith(share, users);
  }

  /** DO-only: a live share's mode, set by its owner's own share sheet, which the app host proves is theirs. No agent
   *  turns on `owner` mode, so no slate op or callable reaches this. */
  async setLiveShareMode(body: LiveShareModeBody): Promise<SlateAnswer<OwnedLiveShare>> {
    return (await this.slates()).controller.setLiveShareMode(body);
  }

  /** DO-only: what a visitor's own parts will ask them for, of a share listed in the Gallery. The Gallery's public page
   *  asks it of the share its index names, so nothing of an unlisted share is answered. */
  async galleryNeeds(share: string): Promise<SlateAnswer<RoomService[]>> {
    return (await this.slates()).controller.galleryNeeds(share);
  }

  /** DO-only, for the same reason: a slate's standing approvals, as its owner's share sheet lists them. */
  async slatePreapprovals(slate: string): Promise<SlateAnswer<SlatePreapprovals>> {
    return (await this.slates()).controller.slatePreapprovals(slate);
  }

  /** DO-only, for the same reason: one standing approval taken back by its owner's share sheet. Nothing grants one here:
   *  only the owner's answer to an effect's ask does. */
  async withdrawSlatePreapproval(body: SlatePreapprovalWithdraw): Promise<SlateAnswer<SlatePreapprovals>> {
    return (await this.slates()).controller.withdrawSlatePreapproval(body);
  }

  /** DO-only, for the same reason: a live share listed in the Gallery, or taken off it, by its owner's share sheet. */
  async setLiveShareListing(body: LiveShareListingBody): Promise<SlateAnswer<OwnedLiveShare>> {
    return (await this.slates()).controller.setLiveShareListing(body);
  }

  /** The Gallery told what one live share's listing is now: its card, read fresh, while listed; else that it is off. */
  /** The Gallery is told one share at a time, in order: a refill read before an unlist or a revoke is sent before it. */
  private readonly gallerySends = serialQueue();

  /**
   * The Gallery told what one live share's listing is now, read from its row when it is sent, not when it was asked: its
   * card, read fresh, while listed; else that it is off. A send queued before the owner's unlist or revoke cannot undo it.
   */
  private syncListing(asked: LiveShareRecord): Promise<void> {
    return this.gallerySends(async () => {
      if (!hasControlPlane(this.env)) return;
      const share = (await this.slates()).controller.live.get(asked.id) ?? asked;
      const shared = { share: share.id, workspace: this.name, slate: share.slate, handle: share.handle };
      const listing = share.gallery;
      // Its link is the app's page for the share, which hosts the parts a bare share host never could.
      const url = listing === null ? null : liveShareEntryPage(this.env, this.name, share.id);

      // A deployment that gives shares no address has nothing to list.
      if (listing === null || url === null) {
        await controlPlaneStub(this.env).gallerySync(await internalCaller(this.env), { ...shared, listed: false });
        // Off the Gallery first: its share's pictures go after, and their going never holds that back.
        await this.pictures.unlisted(this.name, share.slate, share.id, this.env.SLATE_PICTURES);

        return;
      }

      const { controller } = await this.slates();
      const read = await controller.readLiveShareRecord(share.id);
      const title = read.ok ? read.value.title : share.slate;

      // Its picture is one taken through the share itself, at this revision or until one is: never the camera's shot
      // of the owner's private preview, which draws with the owner's own reads.
      if (share.visibility === 'public' && this.pictureCapture() !== null) {
        this.pictures.listed(share.slate, share.id, builtRevision(controller.builds, share.slate) ?? '', Date.now());
        this.armDurableWake();
      }

      await controlPlaneStub(this.env).gallerySync(await internalCaller(this.env), {
        ...shared, listed: true, url,
        card: {
          title, line: listing.line, category: listing.category, ownerName: this.safeDisplayName(), picture: this.pictures.shareDigest(share.slate, share.id),
          viewers: controller.live.views(share.id).viewers,
        },
      });
      this.viewsSynced.set(share.id, Date.now());
    });
  }

  @callable() async listSlates() {
    return (await this.slates()).controller.list(ROOT_SLATE_CALLER);
  }

  // Blueprints cross workspaces, so these four are DO-only: the app host verifies viewer, address and
  // forker ownership before calling, and no browser stub reaches them.

  async readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>> {
    return (await this.slates()).controller.readBlueprint(share);
  }

  async blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>> {
    return (await this.slates()).controller.blueprintBundle(share);
  }

  async shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>> {
    return (await this.slates()).controller.shareBlueprintWith(share, users);
  }

  /** Admits into this workspace as a new slate that calls this workspace's own surface; nothing runs. */
  async admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>> {
    return (await this.slates()).controller.admitBlueprint(bundle);
  }

  @callable() async previewSlate(id: string): Promise<SlateCallResult> {
    return (await this.slates()).controller.preview(ROOT_SLATE_CALLER, id);
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

    // crafted_tools is workspace-wide with no actor_id, so preference is keyed by name alone.
    const preferences = craftPreferences(this.boundSql);

    const crafted = craftedRaw.map(t => {
      const row = preferences.get(t.name);

      return {
        name: t.name,
        description: t.description || "Crafted tool",
        isLearned: true,
        // Crafted tools are never ToolSet entries (routed via createExecuteTool's providers),
        // so codemode is their reach and they are wired whenever the store holds them.
        exposure: 'codemode' as const,
        wired: true,
        qualityScore: craftPreference(row ?? { offered: 0, chosen: 0, rated: 0, rating_sum: 0 }),
        usageCount: row?.chosen ?? 0,
      };
    });

    const executors = this.rt.executionRouter?.listExecutors() ?? [];

    return { builtIn, crafted, executors };
  }

  @callable() async regenerateWorkspaceLogo(): Promise<{ drawn: boolean; refusal: string | null }> {
    const refusal = await this.titlingRefusal();

    if (refusal !== null) return { drawn: false, refusal };
    const mission = missionOf(await this.loadSoulText());
    const subject = mission === null || isPlaceholderMission(mission) ? await this.workspaceTitle() ?? this.name : mission;

    return { drawn: await this.drawLogo(subject), refusal: null };
  }

  private async drawLogo(subject: string): Promise<boolean> {
    const svg = await drawWorkspaceLogo(await this.oneShotOn('logo'), { subject, name: this.name });

    if (svg === null) return false;
    const { stub, caller } = await this.userHub();

    return (await stub.setWorkspaceLogo(caller, this.name, svg)).drawn;
  }

  /** The owner's title for the workspace, trimmed; the owner's object refuses one `workspaceTitleProblem` names. */
  @callable() async setDisplayName(displayName: string) {
    const title = displayName.trim();

    await this.propagateDisplayName(title, 'user');

    return { displayName: title };
  }

  async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) {
    // Genesis only, after the create path registered the row in the root registry;
    // the title is held from that write, and the root remains the authority.
    this.heldTitle.hold({ displayName, nameOrigin });

    return { displayName, nameOrigin };
  }

  /**
   * Not `@callable`: clients cannot fabricate a genesis turn. Creation calls it once, last.
   * Returns once the turn is queued; the agents-SDK heartbeat holds the DO.
   */
  async beginGenesisTurn(): Promise<{ started: boolean }> {
    const signal = workspaceGenesisSignal(missionOf(await this.loadSoulText()));

    if (!signal) return { started: false };
    // The send admits the turn before its first await; only the wait is detached.
    const sent = this.workspaceAgentDeliveries().signals.send(signal);
    this.detachOwned(logged('genesis.turn_failed', { doing: "taking the workspace's first turn", otherwise: 'unavailable' }, async () => { await this.keepAliveWhile(() => sent); }, { workspace: this.name }));

    return { started: true };
  }

  @callable() async getExecutors() {
    return this.rt.executionRouter?.listExecutors() ?? [];
  }

  @callable() async listMounts() {
    return this.rt.executionRouter ? listEnvironments(this.rt.executionRouter) : [];
  }

  @callable() async getComputerSize(): Promise<ComputerSizeState | null> {
    return await this.withSizedBox(async () => {});
  }

  /** The owner's try-again for a refused start: the box's one start path, which clears the refusal. */
  @callable() async startComputer(): Promise<ComputerSizeState | null> {
    return await this.withSizedBox(async (box) => { await box.start(); });
  }

  @callable() async resizeComputer(size: string | null): Promise<ComputerSizeState | null> {
    return await this.withSizedBox(async (box) => { await box.resize(size); });
  }

  /** The owner's second stop, from the computer's own status: restarts it only where the box reads its last stop
   *  waiting on a disk that stopped answering (`stopStalled`); else the stop is still finishing and nothing changes. */
  @callable() async stopStalledComputer(): Promise<ComputerSizeState | null> {
    return await this.withSizedBox(async (box) => { await box.stopStalled(); });
  }

  /** The computer's terminal sessions (D90), read without waking it; null where the deployment has no computer. */
  @callable() async listComputerSessions(): Promise<readonly TerminalSession[] | null> {
    return await this.computerBox()?.terminalSessions() ?? null;
  }

  @callable() async openComputerSession(name?: string): Promise<SessionRecord | null> {
    return await this.computerBox()?.openTerminalSession(name) ?? null;
  }

  @callable() async renameComputerSession(id: string, name: string): Promise<SessionRecord | null> {
    return await this.computerBox()?.renameTerminalSession(id, name) ?? null;
  }

  @callable() async closeComputerSession(id: string): Promise<void> {
    await this.computerBox()?.closeTerminalSession(id);
  }

  /** The terminals the person opened beside the workspace's own shell, in the order they were opened. */
  private workspaceSessionRecords(): WorkspaceSessionRecord[] {
    const kept = v.safeParse(v.array(WorkspaceSessionRecordSchema), this.ctx.storage.kv.get(WORKSPACE_SESSIONS_KEY) ?? []);

    return kept.success ? kept.output : [];
  }

  /**
   * The workspace's terminals (1019-aa), as the computer's sessions read: its own shell, then each the person opened,
   * each its own Nimbus terminal by its key (ask 64). A terminal no record names (one an older build opened) is listed
   * under its key.
   */
  @callable() async listWorkspaceSessions(): Promise<readonly TerminalSession[]> {
    const listed = await (await this.hostedWorkspace().terminals()).list();
    const records = this.workspaceSessionRecords();

    const session = (id: string, name: string, key: string | null): TerminalSession => {
      const live = listed.find((terminal) => terminal.key === key);

      return { id, name, cwd: live?.cwd ?? WORKSPACE_ROOT, open: live?.live ?? false, running: live?.running ?? null, last: null, ports: [], branch: null, needsInput: false };
    };

    const unnamed = listed.flatMap((terminal) => (terminal.key === null || records.some((record) => record.id === terminal.key) ? [] : [terminal.key]));

    return [
      session(WORKSPACE_SHELL_SESSION, WORKSPACE_SHELL_SESSION, null),
      ...records.map((record) => session(record.id, record.name, record.id)),
      ...unnamed.map((key) => session(key, key, key)),
    ];
  }

  /** A new terminal beside the workspace's own; its shell starts when its tab attaches. */
  @callable() async openWorkspaceSession(name?: string): Promise<SessionRecord> {
    const records = this.workspaceSessionRecords();
    const record = v.parse(WorkspaceSessionRecordSchema, { id: `w-${nanoid(10).toLowerCase().replace(/[^a-z0-9]/gu, '0')}`, name: name ?? `shell ${String(records.length + 2)}` });

    this.ctx.storage.kv.put(WORKSPACE_SESSIONS_KEY, [...records, record]);

    return { ...record, cwd: WORKSPACE_ROOT };
  }

  @callable() async renameWorkspaceSession(id: string, name: string): Promise<SessionRecord> {
    return settle(Effect.gen({ self: this }, function* () {
      const records = this.workspaceSessionRecords();
      const renamed = v.parse(WorkspaceSessionRecordSchema, { id, name });

      if (!records.some((record) => record.id === id)) return yield* new KinuError('missing', `the workspace has no terminal ${id} to rename`);
      this.ctx.storage.kv.put(WORKSPACE_SESSIONS_KEY, records.map((record) => (record.id === id ? renamed : record)));

      return { ...renamed, cwd: WORKSPACE_ROOT };
    }));
  }

  /** Ends the terminal's shell and forgets it; the workspace's own shell stays. */
  @callable() async closeWorkspaceSession(id: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      if (id === WORKSPACE_SHELL_SESSION) return yield* new KinuError('bad_input', "the workspace's own shell stays; close the ones opened beside it");
      const terminals = yield* Effect.promise(() => this.hostedWorkspace().terminals());

      yield* Effect.promise(() => terminals.close(id));
      this.ctx.storage.kv.put(WORKSPACE_SESSIONS_KEY, this.workspaceSessionRecords().filter((record) => record.id !== id));
    }));
  }

  /** The workspace's named sessions on its PC `device` (1014-t), as the computer's read: the same rows, the same strip. */
  @callable() async listDeviceSessions(device: string): Promise<readonly TerminalSession[]> {
    return await this.requireOwnerUserDO().listDeviceSessions(await this.userCaller(), this.workspaceName(), device);
  }

  @callable() async openDeviceSession(device: string, name?: string): Promise<SessionRecord> {
    return await this.requireOwnerUserDO().openDeviceSession(await this.userCaller(), this.workspaceName(), device, name);
  }

  @callable() async renameDeviceSession(device: string, id: string, name: string): Promise<SessionRecord> {
    return await this.requireOwnerUserDO().renameDeviceSession(await this.userCaller(), this.workspaceName(), device, { id, name });
  }

  @callable() async closeDeviceSession(device: string, id: string): Promise<void> {
    await this.requireOwnerUserDO().closeDeviceSession(await this.userCaller(), this.workspaceName(), device, id);
  }

  /** The workspace's computer, where this deployment binds one. */
  private computerBox(): SandboxBox | undefined {
    return this.env.KinuDevbox?.getByName(sandboxIdForWorkspace(this.name));
  }

  /** The box keeps the account default its next start uses, so every read and change pushes the owner's current one. */
  private async withSizedBox(act: (box: SandboxBox) => Promise<void>): Promise<ComputerSizeState | null> {
    const box = this.computerBox();

    if (box === undefined) return null;
    const account = await this.accountComputerSize();
    await box.useDefaultSize(account);
    await act(box);
    const size = await box.boxSize();

    return { account, chosen: size.chosen ?? null, size: size.size, running: size.running ?? null, startRefused: size.startRefused ?? null, stalled: size.stalled ?? null };
  }

  private async accountComputerSize(): Promise<BoxSize | null> {
    const owner = this.getOwnerUserDO();

    return owner === null ? null : accountComputerSize(await owner.getConfig(await this.userCaller(), COMPUTER_SIZE_CONFIG_KEY));
  }

  /** Browser-only; delegates to the same orchestration policy as the model's agents tool. */
  @callable() async listSubagents(): Promise<SubagentView[]> {
    return this.subagentViews();
  }

  /**
   * Blank `displayName` is intentional: the first-interaction title policy reads it
   * (`SubagentAgent.onChatResponse`). Route by `name`, a stable slug drawn from `opening`, the words the chat is
   * opened with, which are sent to it once it exists.
   */
  @callable() async createSubagentAgent(opening?: string): Promise<{
    name: string;
    displayName: string;
    subagent: SubagentView;
  }> {
    const result = await this.getTeamToolDeps().create({ ...(opening !== undefined && { brief: opening }) });

    return {
      ...result,
      subagent: await this.subagentView(result.subagent.name),
    };
  }

  /** Writes the child and the roster row together and marks the title owner-set,
   *  which stops auto-titling. */
  @callable() async renameSubagentAgent(name: string, displayName: string): Promise<{
    ok: true;
    name: string;
    displayName: string;
    subagent: SubagentView;
  }> {
    const result = await this.getTeamToolDeps().rename({ name, displayName });

    return {
      ...result,
      subagent: await this.subagentView(result.subagent.name),
    };
  }

  @callable() async renameMainChat(title: string): Promise<{ title: string }> {
    this.actorHandle().config.setChatTitle(title);

    return { title };
  }

  /** The page's layout, as every browser shows it: `focus` draws the chat alone. */
  @callable() async setLayout(layout: WorkspaceLayout): Promise<{ layout: WorkspaceLayout }> {
    const chosen = v.parse(WorkspaceLayoutSchema, layout);

    this.actorHandle().config.setLayout(chosen);

    return { layout: chosen };
  }

  /**
   * Not @callable: a new workspace's install (user/workspace-create.ts), before its baseline and its first turn, so the
   * genesis turn already runs as the blueprint says. Its schedules are the owner's own: an agent may not cancel them. One
   * that watches a connection is kept, and armed only while the owner holds that connection (`connectionsChanged`).
   */
  async seedBlueprint(seed: WorkspaceSeed): Promise<void> {
    const { config } = this.actorHandle();

    config.setBlueprint(seed.blueprint);
    config.setLayout(seed.layout);
    config.setChatTitle(seed.agent);
    config.setBlueprintWatchers(seed.schedules.filter((schedule) => schedule.connection !== undefined));

    for (const schedule of seed.schedules.filter(({ connection }) => connection === undefined || seed.connected.includes(connection))) {
      await this.armSchedule(schedule);
    }
  }

  /**
   * Not @callable: the owner's account, when a connection of theirs is made or removed (`user/mcp-servers.ts`). Arms each
   * kept watcher of a connection the owner now holds, and cancels each of one they no longer hold, by its label.
   */
  async connectionsChanged(connected: readonly string[]): Promise<void> {
    const armed = new Map(listTriggers(this.triggerRegistry).triggers.flatMap((trigger) => {
      const labelled = v.safeParse(v.object({ label: v.string() }), trigger.spec);
      const owners = trigger.kind === 'timer_cron' && trigger.state === 'active' && trigger.creator_trust === 'owner';

      return owners && labelled.success ? [[labelled.output.label, trigger.id] as const] : [];
    }));

    for (const watcher of this.actorHandle().config.getBlueprintWatchers()) {
      const held = watcher.connection !== undefined && connected.includes(watcher.connection);
      const id = armed.get(watcher.label);

      if (held && id === undefined) await this.armSchedule(watcher);

      if (!held && id !== undefined) await this.cancelTrigger(id, 'owner');
    }
  }

  private async armSchedule(schedule: BlueprintSchedule): Promise<void> {
    await this.createTimerTrigger({
      cron: schedule.cron, ...(schedule.timeZone !== undefined && { timeZone: schedule.timeZone }), label: schedule.label, payload: { prompt: schedule.prompt }, trust: 'owner',
    });
  }

  @callable() async dismissSubagent(name: string, keepHistory = true): Promise<{
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
  async getExecutorOutput(executorId: string): Promise<ExecutorOutputRow[]> {
    return this.sql<ExecutorOutputRow>`SELECT id, executor, command,
        substr(stdout, 1, ${EXECUTOR_OUTPUT_CLIP}) AS stdout, stdout_len,
        substr(stderr, 1, ${EXECUTOR_OUTPUT_CLIP}) AS stderr, stderr_len,
        exit_code, created_at
      FROM executor_output
      WHERE actor_id = ${this.actorHandle().actorId} AND executor = ${executorId}
      ORDER BY created_at DESC, rowid DESC LIMIT ${EXECUTOR_HISTORY_ROWS}`;
  }

  private recordExecutorOutput(
    executorId: string, command: string, output: { stdout: string | null; stderr: string; exitCode: number },
  ): void {
    const actorId = this.actorHandle().actorId;

    const { stdout, stderr } = output;
    void this.sql`INSERT INTO executor_output (actor_id, executor, command, stdout, stdout_len, stderr, stderr_len, exit_code)
      VALUES (${actorId}, ${executorId}, ${command.slice(0, EXECUTOR_COMMAND_CHARS)}, ${stdout?.slice(0, EXECUTOR_OUTPUT_CLIP) ?? null},
        ${stdout?.length ?? null}, ${stderr.slice(0, EXECUTOR_OUTPUT_CLIP)}, ${stderr.length}, ${output.exitCode})`;
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

  /**
   * The rows the Work tab draws and its presence is decided from, each read once. `jobs`: presence needs one, the tab
   * draws {@link WORK_TAB_JOBS}.
   */
  private async workReads(jobs: number) {
    const [pendingActions, backgroundJobs, workspaceWork, changelog, memoryContent, inspectedWork] = await Promise.all([
      this.listPendingActions(),
      this.listBackgroundJobs(jobs),
      this.listWorkspaceWork(),
      this.getEvolutionChangelog({ limit: 1 }),
      this.getMemoryContent(),
      this.inspectWork(),
    ]);

    return {
      pendingActions, backgroundJobs, workspaceWork, memoryContent, inspectedWork,
      // A live turn is not content: streaming with nothing renderable keeps the tab hidden.
      presence: {
        work: workspaceWork, pending: pendingActions, jobs: backgroundJobs,
        changes: changelog.entries, notes: parseMemoryNotes(memoryContent ?? ''), owed: inspectedWork,
      },
    };
  }

  private async tabPresenceOf(work: Parameters<typeof hasWorkspaceWork>[0]): Promise<TabPresence> {
    return {
      work: hasWorkspaceWork(work),
      // Hidden with swarms off.
      explorations: await this.readAccountSwarms() && listForkRuns(this.boundSql, this.actorHandle(), null, 1).items.length > 0,
    };
  }

  /** Asks each lane's own read path at limit 1, since presence is a boolean. */
  @callable() async getWorkspaceTabPresence(): Promise<TabPresence> {
    return await this.tabPresenceOf((await this.workReads(1)).presence);
  }

  @callable()
  async getWorkspaceSnapshot() {
    const { memoryContent, presence } = await this.workReads(1);

    return await this.snapshotOf(memoryContent, presence);
  }

  /**
   * What a workspace tab draws first, in one read: the snapshot, and every list its first screen asked for after the
   * snapshot came back (2026-10-09 on production: a second wave of six reads, 200-500 ms after the transcript). Each
   * table is read once, and the tab presence is decided from the same rows. Browser-only: it is off the RPC access
   * table, so a token never reaches it (`AGENT_RPC_ACCESS`).
   */
  @callable()
  getWorkspaceOpening() {
    return settle(Effect.gen({ self: this }, function* () {
      const [reads, subagents, pendingConsents, workspaceAgents] = yield* Effect.all([
        attempt({ doing: 'reading what the Work tab draws', otherwise: 'io' }, () => this.workReads(WORK_TAB_JOBS)),
        openingList('listing the subagent roster', () => this.listSubagents()),
        openingList('listing the pending device consents', () => this.listPendingConsents()),
        openingList("listing the workspace's agents", () => this.listWorkspaceAgents()),
      ], { concurrency: 'unbounded' });

      const snapshot = yield* attempt({ doing: 'reading the workspace snapshot', otherwise: 'io' }, () => this.snapshotOf(reads.memoryContent, reads.presence));

      return {
        ...snapshot,
        // The work rows decide the tab's presence here; the page's one work read draws them.
        pendingActions: reads.pendingActions, backgroundJobs: reads.backgroundJobs,
        inspectedWork: reads.inspectedWork, subagents, pendingConsents, workspaceAgents,
      };
    }));
  }

  private async snapshotOf(memoryContent: string, presence: Parameters<typeof hasWorkspaceWork>[0]) {
    const [status, chat, tools, executors, tabPresence, { slates }] = await Promise.all([
      this.getAgentStatus(),
      this.mainSnapshot(),
      this.getToolDescriptions(),
      this.getExecutors(),
      this.tabPresenceOf(presence),
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
      status, chat, tools, memoryContent, executors, executorOutputs, lastActiveExecutor,
      tabPresence, slates, branchRuns, turnClaim: this.turnClaimState(),
    };
  }

  /** Main's turn as its room heard it open; its isolate recovers a turn a reset cut, so none here is stranded. */
  private turnClaimState(): TurnClaimState {
    const turnId = this.mainChatTurn();

    return turnId === null ? { kind: 'settled' } : { kind: 'admitted', turnId, claimedAt: this.chatOpenedAt.get(this.actorHandle().actorId) ?? 0 };
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
    const main = this.actorHandle().actorId;

    // Its own last answer may hold work with no wake to come back for it, as a parked effect is held.
    if (!this.agentWakes.armed(main) && this.reportedReport(main)?.holds !== true) return { recovered: 'none' };
    // Its isolate decides each claim it holds and no turn of its runs, as an agent's do after a reset; then it takes up
    // what it still owes.
    await this.agentCall(main, (isolate, snapshot) => isolate.recover(snapshot));
    await this.wakeAgent(main);

    return { recovered: 'requeued' };
  }

  /** The agents' questions as the overview counts them: asked of their isolates once, and again only once they moved
   *  (`hostedQuestionsMoved`), never on a write of the workspace's own. */
  private heldQuestions: AskingAgent[] | null = null;

  private questionMoves = 0;

  /** Whether the held list shows the agent with a question open; null when none is held. */
  private heldOpenQuestion(actorId: string): boolean | null {
    const main = this.actorHandle().actorId;

    return this.heldQuestions?.some((asking) => asking.asked.status === 'open' && (asking.actor ?? main) === actorId) ?? null;
  }

  private async questionsAsked(): Promise<AskingAgent[]> {
    const moves = this.questionMoves;
    const asked = this.heldQuestions ?? await this.listOwnerQuestions();

    // Held only if nothing moved while they were asked; a failed read is never held.
    if (moves === this.questionMoves) this.heldQuestions = asked;

    return asked;
  }

  private slowOverview: {
    readonly sqlRevision: number;
    readonly slateRevision: number;
    readonly inputs: Omit<WorkspaceOverviewInputs, 'working' | 'unfinished' | 'latestRun' | 'awaitsSettings'>;
  } | null = null;

  private async overviewInputs(): Promise<Omit<WorkspaceOverviewInputs, 'working' | 'unfinished' | 'latestRun' | 'awaitsSettings'>> {
    const sqlRevision = storeRevision(this.boundSql);
    const slateRevision = storeRevision(this.ctx.storage.sql);
    const held = this.slowOverview;

    if (held !== null && held.sqlRevision === sqlRevision && held.slateRevision === slateRevision) return held.inputs;
    const pendingConsents = this.consents.list();

    const [activePlan, listing, hostedPlans, questions] = await Promise.all([
      this.getActivePlanReview(),
      this.slates().then((slates) => slates.controller.list(ROOT_SLATE_CALLER)),
      this.hostedPlans(),
      this.questionsAsked(),
    ]);

    const pictures = this.pictures.digests();
    const shares = await (await this.slates()).controller.shareCards(new Map(listing.slates.map((slate) => [slate.id, slate.title])));

    const inputs = {
      pendingActions: this.pendingActions(hostedPlans),
      pendingConsents,
      activePlan,
      openQuestions: questions.filter((asking) => asking.asked.status === 'open').length,
      slates: listing.slates.map((slate) => ({
        id: slate.id, title: slate.title, picture: pictures.get(slate.id) ?? null,
      })),
      shares,
    };

    // A write during the awaits must be observed by this push, not only the next one.
    if (storeRevision(this.boundSql) !== sqlRevision || storeRevision(this.ctx.storage.sql) !== slateRevision) {
      return this.overviewInputs();
    }

    this.slowOverview = { sqlRevision, slateRevision, inputs };

    return inputs;
  }

  /** A local parked refusal or an agent's own owed work can depend on changed settings. One read, only while idle. */
  private awaitsSettings(): boolean {
    return this.sql<{ awaits: number }>`SELECT EXISTS (SELECT 1 FROM terminal_effects WHERE status = 'parked')
      OR EXISTS (SELECT 1 FROM agent_reports WHERE holds = 1) AS awaits`[0]?.awaits === 1;
  }

  /** Only slow source sections are held; every push folds current activity, settings wait and run. */
  async foldOverview(): Promise<WorkspaceOverview> {
    const inputs = await this.overviewInputs();

    const hostedBusy = this.actorHost().list().some((reference) => this.hostedTurnInFlight(reference));
    const main = this.actorHandle().actorId;
    // Main owns its header; its standing report is the projection, never the parent's actor stores.
    const header = (await this.mainStanding()).latestRun;
    // A settled turn's leftovers still closing are its work, not a durable leftover.
    const working = this._inFlight || this.deliveriesOwed(main) || this.agentTurns.inFlight(main) || hostedBusy || this.agentsWorking.size > 0 || this.terminal.closing;

    return buildWorkspaceOverview({
      ...inputs,
      working,
      awaitsSettings: working || this.awaitsSettings(),
      // Read only when idle: a working tile shows Working whatever is owed.
      unfinished: !working && (this.owedUntimedWork() || this.workOwedAt() !== null),
      latestRun: header === null ? null : { status: header.status, task: header.userMessage, run: header.run },
    });
  }

  /** Asked by `CodemodeEgress` before it pipes a program's socket to a browser session. Never `@callable`. */
  ownsBrowserSession(actorId: string, sessionId: string): boolean {
    return ownsBrowserSession(this.ctx.storage.sql, actorId, sessionId);
  }

  /** The workspace's tile on its owner's roster (overview-push.ts). */
  private readonly overview = new OverviewPush({
    workspace: () => this.name,
    ownerUserId: () => this.getOwnerUserId(),
    fold: () => this.foldOverview(),
    hasCapability: () => this.workspaceCapabilityToken() !== null,
    deleting: () => this.deleting.signal.aborted,
    put: async (overview) => {
      const { stub, caller } = await this.userHub();

      await stub.putWorkspaceOverview(caller, this.name, overview);
    },
    detach: (work) => { this.detachOwned(work); },
    scheduleRetry: (at) => this.scheduleTerminalRetry(at),
  });

  async requestOverviewPush(): Promise<void> {
    this.overviewChanged();
  }

  protected override overviewChanged(force = false): void {
    this.overview.changed(force);
    // The tile counts what waits on the owner, so every change to it passes here.
    this.ownerWaitsMoved();
  }

  /** The workspace's executors: a command, the file plane, the Files routes' transfers, terminals and ports. */
  private readonly executors = new WorkspaceExecutors({
    runtime: () => this.rt,
    workspaceTerminal: async () => await this.hostedWorkspace().terminals(),
    computerState: () => ({ refused: this.config.get(SANDBOX_REFUSED) ?? null, starting: this.config.get(SANDBOX_STARTING) != null }),
    heldPorts: async () => await (await this.slates()).controller.heldPorts(),
    recordOutput: (executorId, command, output) => { this.recordExecutorOutput(executorId, command, output); },
    broadcast: (frame) => { this.broadcast(frame); },
    ownerUserId: () => this.getOwnerUserId(),
    openOwnerTerminal: async (window, target) => await this.requireOwnerUserDO().openDeviceTerminal(await this.userCaller(), this.workspaceName(), window, target),
    openOwnerScreen: async (device) => await this.requireOwnerUserDO().openDeviceScreen(await this.userCaller(), this.workspaceName(), device),
  });

  @callable() executeInExecutor(executorId: string, command: string, device?: string) {
    return this.executors.execute(executorId, command, device);
  }

  /** A page of the folder from `from`, read off the executor's own raw handle; its answer names where the next starts. */
  @callable() async getExecutorFiles(executorId: string, path: string, request?: FilesRequest): Promise<FilesPage> {
    return await this.executors.files(executorId, path, request);
  }

  @callable() async readExecutorFile(executorId: string, path: string): Promise<ExecutorTextFile> {
    return await this.executors.readFile(executorId, path);
  }

  @callable() async renameExecutorFile(executorId: string, from: string, to: string): Promise<ExecutorWriteResult> {
    return await this.executors.rename(executorId, from, to);
  }

  @callable() async deleteExecutorFile(executorId: string, path: string): Promise<ExecutorWriteResult> {
    return await this.executors.remove(executorId, path);
  }

  async startExecutorFileDownload(executorId: string, path: string, transferId: string) {
    return await this.executors.startDownload(executorId, path, transferId);
  }

  async readExecutorFileChunk(read: ExecutorFileChunkRead): Promise<{ bytes: Uint8Array } | { error: string }> {
    return await this.executors.readChunk(read);
  }

  async abortExecutorFileDownload(transferId: string): Promise<void> {
    this.executors.abortDownload(transferId);
  }

  /**
   * A person's upload, a chunk at a time. Its first chunk asks the owner's limits for new bytes, with this workspace's
   * size as its database reads it now; its last tells them the size it left. Bytes already stored stay readable. A
   * refusal is the upload's answer in the limit's own words, which the page knows its dialog by: thrown, the upload
   * would answer only that streaming it failed.
   */
  writeExecutorFileChunk(write: ExecutorFileChunkWrite): Promise<ExecutorWriteResult> {
    return settle(Effect.gen({ self: this }, function* () {
      if (write.offset === 0) {
        const admitted = yield* Effect.result(this.admitNewBytes());

        if (Result.isFailure(admitted)) return { error: admitted.failure.message };
      }

      const written = yield* Effect.promise(() => this.executors.writeChunk(write));

      if (write.final) yield* Effect.promise(() => this.reportStoredBytes());

      return written;
    }));
  }

  async abortExecutorFileWrite(transferId: string): Promise<void> {
    this.executors.abortWrite(transferId);
  }

  /** Not @callable: called by the terminal HTTP route (see terminal-route.ts). */
  async prepareTerminal(executorId: string, surface: 'terminal' | 'desktop' = 'terminal'): Promise<{ ok: true } | { error: string }> {
    return this.executors.prepareTerminal(executorId, surface);
  }

  /**
   * Opens via this object because only it holds the workspace capability token the hub needs.
   * `device`: the PC the pane names, when the account has several connected; the one connected without it.
   */
  async openDeviceTerminal(window: { cols: number; rows: number }, target: { device?: string; session?: string }): Promise<{ session: string; user: string } | { error: string }> {
    return this.executors.openDeviceTerminal(window, target);
  }

  /** As {@link openDeviceTerminal}, for the screen of the PC `device` (1014-t). */
  async openDeviceScreen(device: string): Promise<{ session: string; user: string } | { error: string }> {
    return this.executors.openDeviceScreen(device);
  }

  @callable() async getExposedPorts(executorId: string): Promise<ExposedPortList> {
    return await this.executors.exposedPorts(executorId);
  }

  /** Whether the computer's published preview of `port` is a public link; null when none is published. */
  @callable() async getComputerPreviewPublic(port: number): Promise<{ readonly public: boolean | null }> {
    return { public: this.env.AUTH_KV === undefined ? null : await sandboxPreviewExposures(this.env.AUTH_KV, sandboxIdForWorkspace(this.name)).isPublic(port) };
  }

  /**
   * The owner makes the computer's published preview of `port` a public link, opened by anyone holding its URL, or
   * theirs alone again. A port exposed again opens for the owner alone, whatever its last publication was.
   */
  @callable() setComputerPreviewPublic(port: number, open: boolean): Promise<{ readonly public: boolean }> {
    return settle(Effect.gen({ self: this }, function* () {
      const kv = this.env.AUTH_KV;
      const set = kv !== undefined && (yield* Effect.promise(() => sandboxPreviewExposures(kv, sandboxIdForWorkspace(this.name)).setPublic(port, open)));

      if (!set) return yield* new KinuError('missing', `The computer has no published preview of port ${String(port)}: expose the port first.`);

      return { public: open };
    }));
  }

  /** `actor` names a child of this workspace: the read is its own config. */
  private actorConfig(actor: string | undefined) {
    return actor === undefined ? Effect.succeed(this.config) : Effect.map(this.hostedChild(actor), ({ child }) => child.stores.config);
  }

  @callable() getReasoningEffort(actor?: string): Promise<{ effort: ReasoningEffort | null }> {
    return settle(Effect.map(this.actorConfig(actor), (config) => getReasoningEffort(config)));
  }

  @callable() setReasoningEffort(effort: ReasoningEffort | null, actor?: string) {
    return settle(Effect.map(this.actorConfig(actor), (config) => setReasoningEffort(config, effort)));
  }

  @callable() getProviderAccounts(actor?: string) {
    return settle(Effect.map(this.actorConfig(actor), (config) => getProviderAccounts(config)));
  }

  @callable() setProviderAccount(provider: string, account: string | null, actor?: string) {
    return settle(Effect.gen({ self: this }, function* () {
      const set = setProviderAccount(yield* this.actorConfig(actor), provider, account);

      yield* Effect.promise(async () => this.modelSettingsChanged());

      return set;
    }));
  }

  /** The workspace agent's model pin, or `actor`'s own over the workspace's for its turns. */
  @callable() setModel(spec: string, actor?: string) {
    return settle(Effect.gen({ self: this }, function* () {
      const set = setModel(this.modelSetting(yield* this.actorConfig(actor), () => {}), spec);

      // That agent's isolate measures its next request on the new model, as every agent's does.
      yield* Effect.promise(async () => this.modelSettingsChanged());

      return set;
    }));
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

  /** The workspace's SOUL.md, wherever this actor's own home is. */
  protected override async loadSoulText(): Promise<string> {
    return (await workspaceSoul(this.hostedWorkspace().bundle)) ?? '';
  }

  @callable() setSoul(soul: string) {
    return settle(Effect.gen({ self: this }, function* () {
      const text = soul.trim();

      if (!text) return yield* new KinuError('bad_input', 'SOUL.md cannot be empty.');
      const ownerUserId = this.getOwnerUserId();

      if (!ownerUserId) return yield* new KinuError('unavailable', 'SOUL.md is unavailable until the workspace owner claim completes.');
      yield* Effect.promise(() => writeWorkspaceSoul(this.hostedWorkspace().bundle, text));

      return { soul: text, purpose: summarizeSoul(text) };
    }));
  }

  @callable() async getEvolutionConfig(): Promise<EvolutionConfigView> {
    return getEvolutionConfig(this.config);
  }

  @callable() async setEvolutionConfig(config: Partial<EvolutionConfigView>): Promise<EvolutionConfigView> {
    return setEvolutionConfig(this.config, config);
  }

  /** Continue the chat from before `entryId`; open tabs get the reverted transcript via the
   * session event this emits. A chat-only rewind tells the agent what its rewound turns left on the computer
   * (REWIND-0924), read without waking it. */
  @callable()
  async revertConversation(entryId: string, options?: RevertOptions): Promise<void> {
    // Parsed here too: a client's argument reaches this method unchecked.
    const chatOnly = v.parse(RevertOptionsSchema, options ?? {}).chatOnly === true;
    const told = chatOnly ? { computer: await this.executors.rewindComputer() } : undefined;

    await this.mainCall((isolate, snapshot) => isolate.revertTo(snapshot, entryId, told));
  }

  /**
   * Fork this agent at a message; driver is core's (identity/fork-driver.ts), this supplies
   * the transport. See docs/WORKSPACES.md for the full spec.
   */
  @callable()
  forkAgent(
    untilMessageId: string,
    opts?: { name?: string },
  ): Promise<{ id: string; name: string; url: string; forkPointMs: number }> {
    return settle(Effect.gen({ self: this }, function* () {
      // Check first: a fork of an unclaimed workspace has nobody to own the copy.
      yield* this.owner();

      const fork = yield* Effect.promise(async () => forkWorkspace({
        sql: this.boundSql,
        actor: this.rt.actor,
        // Kept in the root's own isolate (D9): the cut and the conversation's sections are read there.
        conversation: this.agentStores(this.rt.actor.actorId).forkSource(),
        // One pin of the workspace files, exported a page and a frame of chunks at a time: a fork holds one frame.
        vfs: createWorkspaceForkSource(this.hostedWorkspace().bundle),
        artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)),
        sourceName: this.name,
        busy: () => this._inFlight,
        transport: this.forkTransport,
      }, untilMessageId, opts));

      return {
        id: fork.workspaceId,
        name: fork.name,
        url: `/workspace/${fork.name}`,
        forkPointMs: fork.forkPointMs,
      };
    }));
  }

  /** Reaches a not-yet-existing workspace DO by name and carries the snapshot via raw-copy RPC. */
  private get forkTransport(): ForkTransport {
    const stubFor = (name: string) => objectNamed(this.env.OrchestratorAgent, name);

    return {
      occupied: async (name) => {
        const { stub, caller } = await this.userHub();

        return stub.hasWorkspace(caller, name);
      },
      deliver: async (name, snapshot) => {
        const ownerUserId = this.requireOwner();
        const { stub, caller } = await this.userHub();

        return deliverCloudFork({
          registry: stub,
          caller,
          target: stubFor(name),
          name,
          // Must be this object's own fenced handle (the one `forkWorkspace` checked against),
          // never a fresh handle or a name off the wire: rows are keyed per actor, so another would
          // snapshot a sibling.
          source: { ...snapshot, actor: this.actorHandle(), appData: this.stores.appData.fork },
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

    // The target's own payload plane: carried payloads are re-rooted so the fork never reads its source.
    const artifactDirectory = agentArtifactDirectory(agentHome(MAIN_AGENT));

    const writer = new ForkTargetWriter(this.boundSql, {
      workspaceId: this.ctx.id.toString(), workspaceName: forkName, ownerUserId, artifactDirectory,
      transaction: (rows) => this.ctx.storage.transactionSync(rows),
      appData: () => this.stores.appData.fork,
      // The root's conversation lands in its own isolate (D9), born with the workspace before the first frame.
      conversation: this.agentStores(this.actorHandle().actorId).forkTarget(artifactDirectory),
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
  rawCopyFromFork(
    forkName: string,
    frame: ForkFrame,
    ownerUserId: string,
  ): Promise<ForkFrameAck> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!ownerUserId) return yield* new KinuError('bad_input', 'fork owner is required');
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
      const outcome = yield* Effect.promise(async () => receiver.accept(frame));

      // Publication does this once; an already-settled transfer only answers with the fork that landed.
      if (outcome.status === 'published') {
        yield* Effect.promise(async () => this.ensureOwnedScaffold());
        yield* Effect.promise(async () => this.resetWorkspaceBaseline());
      }

      const accepted = outcome.status === 'staged' || outcome.status === 'want' ? outcome : {
        status: 'published' as const, agentId: this.ctx.id.toString(),
        capabilityHash: yield* Effect.promise(async () => this.workspaceCapabilityHash()), forkPointMs: outcome.result.forkPointMs,
      };

      return { ok: true, ...accepted };
    }));
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
    return settle(Effect.gen({ self: this }, function* () {
      // Read before the row is written: a trigger whose URL cannot be signed is unreachable.
      const routeSecret = webhookRouteSecret(this.env);

      if (routeSecret === null) return yield* new KinuError('unavailable', WEBHOOK_ROUTE_UNAVAILABLE);
      const now = Date.now();
      // Core decides and stores the secret; an hmac/bearer trigger without one refuses every delivery.
      const webhook = yield* Effect.promise(async () => registerDurableWebhook(this.triggerRegistry, this.webhookSecrets, opts, now));

      return {
        trigger_id: webhook.trigger_id,
        url: yield* Effect.promise(async () => webhookRoutePath(routeSecret, {
          workspaceName: this.name, triggerId: webhook.trigger_id,
        })),
        auth_mode: webhook.auth_mode,
        // The secret is returned once here and never again.
        secret: webhook.secret,
      };
    }));
  }

  /** The owner moves a daily schedule's time (the assistant's brief, say), in the time zone it keeps. Not a model tool. */
  @callable()
  async retimeDailySchedule(triggerId: string, at: string): Promise<{ readonly at: string; readonly nextFireAt: number }> {
    return await retimeDailyTrigger({ registry: this.triggerRegistry, trigger_id: triggerId, at, now: Date.now() });
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

   * Open one refinement; returns the durable request at `requested` — the refiner runs
   * on the off-turn cadence pass. The nudge is detached; eviction only costs an unfinished step.
   */
  @callable()
  async requestRefinement(opts?: {
    turnIds?: string[]; scope?: RefinementScope;
  }): Promise<RefinementRequestView> {
    const view = await requestOwnerRefinement(this.refinementDeps, opts);
    this.detachOwned(logged('refinement.lane_failed', { doing: 'advancing the continual-refinement lane', otherwise: 'unavailable' },
      async () => { await refinementPass(this.refinementDeps); }, { workspace: this.name }));

    return view;
  }

  /** Refinements newest first plus the debt that would open the next one (`/refine` with no args). */
  @callable()
  async listRefinements(limit = 20): Promise<RefinementListing> {
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
      onAdmitted: () => { this.armDurableWake(); },
      watch: this.watching,
    }, opts);
  }

  /**
   * Container ingress via `src/egress/outbound.ts`; runs here so publish + dedupe are atomic.
   * `launchingHeadTrust` is set here, never read off the wire: the container is least trusted.
   * `waitUntil` is a no-op in a DO, so the write is awaited in this invocation; retry is the recovery.
   */
  /** A Node program's call of one of its namespaces, as its egress handed it on: answered by the program's own provider. */
  async nodeProgramCall(principal: EgressPrincipal | undefined, token: string | null, body: JsonValue): Promise<NodeProgramAnswer> {
    return await serveNodeProgramCall(principal, token, body);
  }

  async acceptContainerEvent(body: JsonValue): Promise<ContainerEventResult> {
    return acceptContainerEvent({
      log: this.eventLog,
      vfs: this.rt.storage.vfs,
      launchingHeadTrust: 'self',
      onAdmitted: () => { this.armDurableWake(); },
    }, body, Date.now());
  }

  /**
   * Container host reports its persistence failed: a blocker, so it uses the signal seam, not the hub.
   * Plain method (not `@callable`): only another DO calls it. `waitUntil` is a no-op in a DO, so work
   * happens in this invocation; the incident id makes caller retries safe.
   */
  async acceptSandboxLifecycleIncident(body: JsonValue): Promise<SandboxLifecycleIncidentResult> {
    // A deleted workspace's box can outlive it holding an incident: nobody is left to tell, and a throw here was
    // `undelivered`, so the box re-offered it every five minutes for hours (staging beaf28a46, six boxes).
    if (this.storageRefusal !== undefined || !this.workspaceBorn()) return { status: 'rejected', reason: 'the workspace no longer exists' };

    return acceptSandboxLifecycleIncident({
      sql: this.boundSql,
      inbox: this.workspaceAgentDeliveries().signals,
      jobs: {
        ended: (jobId, end) => this.processEnds.record(jobId, end),
        // The note goes to the actor whose job it is: the workspace agent's, or a hire's own.
        restored: async (jobId, note) => {
          const row = this.jobRow(jobId);

          if (row !== null) await this.jobRunnerHolding(row.actorId)?.note(jobId, note);
        },
      },
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

  private _email: WorkspaceEmail | null = null;
  /** Held across the activation, like the in-memory inbound rate window its inbox owns. */
  private get email(): WorkspaceEmail {
    this._email ??= new WorkspaceEmail({
      log: (actorId) => new EventLog(this.watchedExec, this.agentBound(actorId).handle),
      replies: this.replyChannels,
      mainActorId: () => this.actorHandle().actorId,
      vfs: () => this.rt.storage.vfs,
      sql: this.ctx.storage.sql,
      onAdmitted: () => { this.armDurableWake(); },
      env: this.env,
      name: this.name,
      outbox: () => this.emailOutbox,
      displayName: () => this.safeDisplayName(),
      notifications: () => this.config.getEmailNotificationsEnabled(),
      setNotifications: (enabled) => { this.config.setEmailNotificationsEnabled(enabled); },
      operatorConnected: () => this.ctx.getWebSockets().length > 0,
      owned: () => this.getOwnerUserId() !== null,
      hub: () => this.userHub(),
      detach: (work) => { this.detachOwned(work); },
    });

    return this._email;
  }

  /**
   * An arrival the account's Mailbox filed and decided wakes `actorId` (the workspace's main agent when it names none),
   * on the owner's word or as input (docs/MAIL.md §3). Worker-only: the mail router holds the stub, never a browser.
   * Publish and reply thread run here atomically.
   */
  async mailArrived(arrival: MailArrival, actorId?: string): Promise<MailAdmission> {
    return await this.email.accept(arrival, actorId ?? this.actorHandle().actorId);
  }

  /**
   * This workspace, the owner's Personal assistant, reads their own box from now on (docs/MAIL.md §7). Worker-only: the
   * assistant's install and the owner's claim of an address call it, each having read that this is their assistant.
   */
  async readOwnerMail(): Promise<void> {
    const owner = this.getOwnerUserId();

    if ((this.env.EMAIL_DOMAIN ?? '') === '' || owner === null) return;
    await objectNamed(this.env.MAILBOX, owner).readBy({ workspace: this.name, actorId: this.actorHandle().actorId });
    // What reached the box before it read it is triaged now.
    await this.triageOwnerMail();
  }

  private _mailTriage: MailTriageLane | null = null;

  /**
   * New mail waits in the owner's own box for this workspace, their Personal assistant, to triage (docs/MAIL.md §8). Worker-only:
   * the mail router and the hand-over call it. Answers at once; the pass runs on the fast tier, outside any turn.
   */
  async triageOwnerMail(): Promise<void> {
    this._mailTriage ??= new MailTriageLane(async () => this.triageOwnerMailPass());
    const pass = this._mailTriage.nudge();

    this.detachOwned(logged('mail.triage_failed', { doing: 'triaging the owner\'s mail', otherwise: 'unavailable' }, async () => {
      await this.keepAliveWhile(() => pass);
    }, { workspace: this.name }));
  }

  private async triageOwnerMailPass(): Promise<void> {
    const main = this.actorHandle();
    const mail = this.mailFor(main.actorId, main.config.getChatTitle() ?? 'Kinu');
    const owner = await this.email.ownerEmail();

    if (mail === null || owner === null) return;
    const run = await triageMail({ mailbox: mail.mailbox(), caller: mail.caller(), about: this.getSoulText(), owner, complete: await this.oneShotOn('fast') });

    diagnostics.event('mail.triaged', { workspace: this.name, ...run });
  }

  /**
   * A thread the owner sent this workspace from Mail (docs/MAIL.md §8): a turn of its own for the main agent. Worker-only:
   * the route proved the owner holds both the thread and this workspace.
   */
  async mailHanded(handed: HandedMail): Promise<{ status: 'queued' | 'skipped' }> {
    const spilled = await spillEventContent(this.rt.storage.vfs, handed.text);
    const outcome = await this.workspaceAgentDeliveries().signals.send(handedMailSignal(handed, spilled));

    return { status: outcome === 'undelivered' ? 'skipped' : 'queued' };
  }

  /**
   * The Agent tab's mail (docs/MAIL.md §7): the address the shown agent reads as its own, its unread count and its
   * newest threads. `actorId` names one of this workspace's agents; absent, its main agent, whose box is the
   * workspace's. Null where the deployment has no mail or the owner has no address yet.
   */
  @callable()
  async agentMail(actorId?: string): Promise<{ address: string; unread: number; threads: MailThreadSummary[] } | null> {
    const main = this.actorHandle().actorId;
    const record = actorId === undefined || actorId === main ? null : this.actorHost().describe(actorId);

    if (actorId !== undefined && actorId !== main && record === null) return null;

    const mail = this.mailFor(actorId ?? main, record?.name ?? 'main');

    if (mail === null) return null;

    const caller = mail.caller();
    const mailbox = mail.mailbox();
    const [own] = await mailbox.readableBy(caller);

    if (own === undefined) return null;

    const listing = await mailbox.findFor(caller, { view: 'all', box: own.path, limit: 20 });

    return { address: own.address, unread: listing.unread, threads: [...listing.threads] };
  }

  async getEmailIngress(): Promise<{ notifications: boolean }> {
    return this.email.ingress();
  }

  async setEmailNotifications(enabled: boolean): Promise<{ notifications: boolean }> {
    return this.email.notify(enabled);
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

reportSocketCallFailures(OrchestratorAgent, Agent);

/** Cursor is client-supplied: anything malformed starts a fresh archive instead of reaching the query. */
function parseArchiveCursor(value: ArchiveCursor | null): ArchiveCursor | null {
  const parsed = v.safeParse(ArchiveCursorSchema, value);

  return parsed.success ? parsed.output : null;
}

