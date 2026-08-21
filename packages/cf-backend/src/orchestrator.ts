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

import { callable, type AgentContext, type SubAgentClass } from "agents";
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from "./rpc-surface";
import { writeNimbusWorkspaceSoul } from "./nimbus-route";
import { getSandbox } from "@cloudflare/sandbox";
import { generateText, convertToModelMessages } from "ai";
import type {
  ActivitySnapshot,
  WorkspaceAgent,
} from "./lib/protocol";
import { buildWorkspaceAgents, teamPeers } from "./lib/workspace-roster";
import { nextAlarmTime } from "./lib/cron";
import type { ChatResponseResult } from "@cloudflare/think";
import {
  EvolutionEngine,
  readActivityLog,
  summarizeSteps,
  usageReported,
  // The whole workspace's spend, grouped by producer, with its own coverage
  // fraction — `summarizeSteps` above is this agent's own turns only.
  workspaceSpend,
  normalizeUsage,
  initWorkspaceSchema,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS,
  // The declared reach axis — getToolDescriptions reports it rather than
  // guessing native-vs-codemode from the assembled ToolSet's keys.
  TOOL_REACH,
  updateCraftScores,
  feedbackToQuality,
  // Fork feature
  forkWorkspace, writeForkSnapshot,
  type ForkTransport, type ForkSnapshot,
  // Workspace archive — the owner's portable copy of this workspace's storage
  readWorkspaceArchivePage, type ArchiveCursor, type ArchivePage,
  nanoid, type HeadRunView,
  // Canonical memory-note write primitive
  appendMemoryNote,
  // Agent-authored views — core owns the spec, the ledger and the validation.
  listViews, readView, type AgentViewSummary, type ReadViewResult,
  // Scaffold loop closure (scaffold-driven inference + shadow rollout)
  type ScaffoldRunResult,
  // The scaffold evolution control plane (core owns the drivers; this actor
  // supplies the surface they run against).
  applyScaffoldDecision, getShadowStatus, listScaffoldVersions,
  previewScaffoldLive, proposeScaffold, runScaffoldCaptureText, runScaffoldGepaOptimization,
  advancePromptSectionLane,
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
  type CompletedTurn, type ToolCallRecord,
  // Adaptive reasoning_effort per stage
  effortFor,
  type BackgroundJob, type AgentTaskTree, TriggerRegistry, ReplyChannelStore,
  type ReasoningEffort, type ShellApprovalMode,
  type AlarmScheduler, type ReplyDispatcher, type ReplyChannelRow,
  // GEPA run lineage (the pass itself is core's evolution control plane)
  listGepaRuns, loadGepaCandidates, type GepaRunSummary,
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
  claimAlternateTakesForTurn, purgeUnclaimedAlternateTakes, listAlternateTakeSets, latestAlternateTakeSet,
  type AlternateTakeSet, type TakePickOutcome,
  // Steer-as-Branch — a mid-turn redirect run as a parallel head
  startBranchHead, settlePendingBranches, newBranchId,
  type PendingBranch, type BranchStatusEvent,
  type ReleaseStatus, type ReleaseToolDeps,
  runExperienceAction,
  type ExperienceActionDeps,
  type ExperienceActionInput,
  // Release execution engine — the driver beneath the governance ledger
  ReleaseEngine, createSandboxReleaseExec,
  type SubordinateRosterEntry,
  // Peer-agent teams (the agents tool's team deps contract)
  type PeersToolDeps, type PeerSpawnOutcome, type PeerSendOutcome,
  type EnqueueTurnResult,
  ROOT_DELEGATION_BUDGET, type DelegationBudget,
  readSoul, readMission, summarizeSoul, writeSoul, workspaceGenesisSignal,
  // Automatic workspace titling (first turn + legacy slug heal)
  applyWorkspaceTitle, isPlaceholderMission, isPlaceholderWorkspaceTitle, parseWorkspaceTitle,
  WORKSPACE_TITLE_SYSTEM_PROMPT, workspaceTitlePrompt,
  // Device shadow-git checkpoints (forwarded to the pc-agent daemon)
  isDeviceNotConnectedError,
  // The one definition of "this executor output is a failure", shared with the
  // renderer that produces both shapes it recognises.
  isFailingResultText,
  type CheckpointAvailability, type FileCheckpointListing,
  type FileRestorePlan, type FileRestoreResult,
  // Shared turn lifecycle
  snapshotCompletedTurn, creditedTurnId,
  // The session tree — `messages` as a projection of the SDK's message DAG
  reconcileSessionTree,
  type DynamicContext,
  // Ingress — core owns the gates; this actor owns the transports in front
  // of them (the DO alarm, the Worker's webhook + email routes, cross-DO RPC).
  acceptWebhookDelivery, registerDurableWebhook, createWebhookSecretStore,
  acceptContainerEvent, type ContainerEventResult,
  initWebhookRateLimitTables,
  type WebhookDelivery, type WebhookDeliveryResult, type WebhookSecretStore,
  createTimerTrigger, cancelTrigger, listTriggers, fireDueTriggers,
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
  getExecutorFiles, readExecutorFile, writeExecutorFileOp, listEnvironments,
  type DirEntry, type ExecutorWriteResult,
  cancelBackgroundJob, clearBackgroundJobs, dismissBackgroundJob,
  jobResult, listBackgroundJobs, retryBackgroundJob, reconcileInterruptedForks,
  jobRedriveResumeGate, resumableForkRoots,
  type CancelWorkOutcome, type RetryOutcome,
  getAlwaysActiveSkills, getEvolutionConfig, getMctsConfig, getReasoningEffort,
  getShellApprovalMode, getShellApprovalGrants, revokeShellApprovalGrants,
  setAlwaysActiveSkills, setEvolutionConfig,
  getModelRoles, setModelRoles,
  setMctsConfig, setReasoningEffort, setShellApprovalMode,
  type EvolutionConfigView, type MctsConfigView, type ModelRolesView, type RoutedSpendSource,
  getEvolutionChangelog, getUnseenChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
  PlanReviewStore, formatPlanWithLineNumbers,
  planReviewAwaitingDecision,
  JsonValueSchema, type JsonValue, type KinuEvent,
  admitPlanReviewAnnotations,
  type PlanEdit, type PlanReview, type PlanReviewAnnotation, type PlanReviewDecision,
  type PlanReviewResult, type WorkMode,
} from "@kinu.run/core";
import * as v from 'valibot';
import { ActorAgent, type ActorToolDeps } from "./actor-agent";
import { resolveEnsembleJudgeSelection } from "./providers/judge-model";
import { SubordinateAgent } from "./subordinate-agent";
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
} from "@kinu.run/core";
import type { CodemodeProvider, MctsSearchRunSummary } from "@kinu.run/core";
import { diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import { createCloudWorkspaceForUser } from "./user/workspace-create";
import { deliverCloudFork } from "./user/workspace-fork";
import { createNimbusWorkspaceSandbox, nimbusWorkspaceArchiveFiles } from './nimbus-route';
import { agentEmailAddress } from "./email/inbound";
import {
  createEmailThreadDispatcher, dispatchEmailRepliesForTurn, sendOwnerEmail,
} from "./email/outbound";
import { EmailOutbox } from "./email/outbox";

const STALE_EVENT_DELIVERY_MS = 10 * 60 * 1000;

/** The one agents-SDK schedule row that carries every Kinu-owned wake
 *  (triggers, peer outbox, email outbox). Public because `Agent.schedule()`
 *  types the callback as `keyof this`, which excludes private members. */
const KINU_TIMER_CALLBACK = '_kinuTimerTick';

/** How overdue a one-shot schedule row must be before it is unrunnable rather
 *  than late. Mirrors the SDK's `fiberRecoveryMaxAgeMs` default: past it the
 *  framework stops recovering the fiber a continuation callback would resume,
 *  so dispatching the row can only replay dead work. */
const STALE_SCHEDULE_HORIZON_MS = 24 * 60 * 60 * 1000;

// The Activity surface's retained sample. Bounded because `run_events` and
// `activity_log` are append-only: 400 steps is deep enough for a p95 that
// means something and shallow enough to stay one cheap indexed read.
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
const EventVariantSchema = v.picklist([
  'chat', 'webhook', 'process_done', 'timer', 'peer_agent', 'subordinate_task',
  'subordinate_report', 'file_changed', 'email', 'internal', 'reply_request',
  'mcp_chat', 'mcp_third_party',
]);
/** One row of the events read: the log's row minus its own plumbing
 *  (`schema_version`, `dedupe_key`, `reply_channel`), which no operator surface
 *  shows. Derived from core's event so a field renamed there fails here rather
 *  than silently dropping out of the projection. */
type RecentEventRow = Pick<
  KinuEvent,
  'id' | 'trace_id' | 'caused_by' | 'ingress' | 'variant' | 'trust' | 'priority'
  | 'payload_visibility' | 'payload' | 'received_at'
>;
const ArchiveCursorSchema = v.variant('phase', [
  v.object({
    phase: v.literal('sql'), table: v.pipe(v.string(), v.nonEmpty()),
    after: v.nullable(v.pipe(v.number(), v.safeInteger())),
    rows: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.object({
    phase: v.literal('files'), after: v.pipe(v.string(), v.nonEmpty()),
    rows: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    files: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
]);

/** A caller-supplied row limit, clamped to [1, max]. */
function clampLimit(requested: number | undefined, max: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return max;
  return Math.min(Math.max(Math.floor(requested), 1), max);
}

export class OrchestratorAgent extends ActorAgent {
  private _planReviews: PlanReviewStore | null = null;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, ORCHESTRATOR_RPC_SURFACE);
  }

  /** One SQL-backed review stream. Constructed lazily because ActorAgent's
   * constructor seals the RPC surface before onStart initializes the schema. */
  private get planReviews(): PlanReviewStore {
    if (!this._planReviews) this._planReviews = new PlanReviewStore(this.boundSql);
    return this._planReviews;
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

  private submitPlanEdits(edits: readonly PlanEdit[]): PlanReviewResult {
    const result = this.planReviews.submit('default', edits);
    if (result.ok) this.broadcastPlanUpdate(result.plan);
    return result;
  }

  private broadcastPlanUpdate(plan: PlanReview): void {
    this.host.broadcast({ type: 'plan_updated', plan });
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

  /** The orchestrator's half of the per-step dynamic context: the delegates it
   *  alone can have (spawned subordinates, listed before the forked head runs
   *  the base class contributes) and the decisions parked on the user. */
  protected override dynamicContextSnapshot(): DynamicContext {
    const base = super.dynamicContextSnapshot();
    const subordinates = this.subordinateDelegates();
    const deafInbox = this.emailInbox.dropNotice(Date.now());
    const context: DynamicContext = {
      ...base,
      delegates: [...subordinates, ...(base.delegates ?? [])],
      // Both kinds of decision parked on the human, in one roster: a consent
      // prompt someone may still answer in the next minutes, and a command
      // parked for hours. The second is also the structural reminder that its
      // effect has NOT happened — restated on every step until it is decided.
      approvals: [...this._consents.approvals(), ...this.deferrals.approvals()],
    };
    if (deafInbox) context.missingCapabilities = [...(base.missingCapabilities ?? []), deafInbox];
    return context;
  }


  /** Turns of new execution traces since the last auto-GEPA pass (in-memory
   *  cadence; resets on eviction, which just delays the next pass — measured
   *  below at `advancePromptSections`, and it is a real delay on a workspace
   *  whose turns are further apart than the eviction window). */
  private _turnsSinceGepa = 0;
  // The rotation cursor that stood here is gone. It was in-memory, and a probe
  // over the real actor measured what that cost: `agent_config` held one key
  // (the cadence) and no table named the cursor, so every activation restarted
  // the rotation at the first section. `nextPromptSectionTarget` derives the
  // answer from the `gepa_runs` rows each pass already writes.
  // Session-reflection cadence (_sessionTurnCount/Turns/StartedAt) now lives on
  // the core AgentOrchestrator; read the turn index via this.orch.sessionTurnIndex.

  // Steer-as-Branch redirects launched against the in-flight turn — each runs
  // as one budgeted head (ExplorationAgent Facet) and settles into Alternate
  // Takes when the turn completes (onChatResponse).
  private _pendingBranches: PendingBranch[] = [];

  private _triggerRegistry: import('@kinu.run/core').TriggerRegistry | null = null;
  private _replyChannels: import('@kinu.run/core').ReplyChannelStore | null = null;
  /** Per-activation guard so the full table-init DDL runs once, not on every
   *  onStart + claimOwner. Resets on DO eviction, so a cold start always
   *  re-creates any newly-added tables (no schema-version bookkeeping). */
  private _schemaReady = false;

  protected get triggerRegistry(): TriggerRegistry {
    if (!this._triggerRegistry) {
      const alarmScheduler: AlarmScheduler = {
        // Idempotent: pick the soonest of (existing alarm, new ts).
        scheduleAt: (ts: number) => this.armTimer(ts),
        currentAlarm: (): number | null => null,
      };
      this._triggerRegistry = new TriggerRegistry(this.ctx.storage.sql, alarmScheduler);
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
      this._replyChannels = new ReplyChannelStore(this.ctx.storage.sql, {
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

  /** Display name for outbound email From headers — never throws pre-schema. */
  private safeDisplayName(): string {
    try { return this.config.getDisplayName() ?? this.name; }
    catch { return this.name; }
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
   *  Every consumer awaits this directly. There is no void-returning wrapper:
   *  one existed, handed the promise to `ctx.waitUntil`, and claimed the write
   *  "lands even if the caller's invocation ends first" — false in a Durable
   *  Object, where `waitUntil` is a no-op (`do.wait_until.no_op`) and an
   *  in-flight promise is cancelled with no signal on reset or eviction
   *  (`do.background_task.cancelled_on_reset`). Awaiting inside the invocation
   *  is the only retention this object has: the output gate then holds the
   *  response until the schedule row commits, and a failure reaches the caller
   *  instead of a console line.
   *
   *  Reconcile the timer row to fire at or before `atMs`, collapsing onto
   *  exactly one pending row. Rows already due are excluded: they belong to
   *  the tick that is running (or about to), which re-arms from
   *  `nextAlarmTime` when it finishes — counting them as "armed" would make
   *  that final re-arm a no-op and stop the chain. */
  private async armTimer(atMs: number): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    // Round UP: the SDK stores schedule times in whole seconds, and waking
    // before `next_fire_at` leaves the trigger not-yet-due, which would re-arm
    // for the same second and busy-spin the alarm until the millisecond passed.
    const targetSec = Math.max(Math.ceil(atMs / 1000), nowSec);
    const armed = (await this.listSchedules())
      .filter((row) => row.callback === KINU_TIMER_CALLBACK && row.time > nowSec);
    const desired = Math.min(targetSec, ...armed.map((row) => row.time));
    if (armed.length === 1 && armed[0].time === desired) return;
    for (const row of armed) await this.cancelSchedule(row.id);
    await this.schedule(new Date(desired * 1000), KINU_TIMER_CALLBACK);
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
   *  from stampeding one alarm cycle. */
  private sweepUnrunnableSchedules(): void {
    const cutoffSec = Math.floor((Date.now() - STALE_SCHEDULE_HORIZON_MS) / 1000);
    const dropped = this.ctx.storage.sql.exec(
      `DELETE FROM cf_agents_schedules
        WHERE type IN ('delayed', 'scheduled') AND time <= ?
        RETURNING id`,
      cutoffSec,
    ).toArray().length;
    if (dropped > 0) {
      diagnostics.event('schedule.stale_rows_dropped', {
        dropped,
        horizonMs: STALE_SCHEDULE_HORIZON_MS,
      });
    }
  }

  protected get engine(): EvolutionEngine {
    if (!this._engine) {
      this._engine = new EvolutionEngine(this.rt, {
        enabled: true,
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


  /** Read the owner userId from workspace_identity; '' (empty) means unclaimed. */
  protected getOwnerUserId(): string | null {
    const rows = this.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM workspace_identity LIMIT 1`;
    const owner = rows[0]?.owner_user_id;
    return owner && owner !== '' ? owner : null;
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
        return teamPeers(this.name, await stub.listWorkspaces(caller));
      },
      ask: async ({ agent, topic, message, timeoutMs, mode }) => {
        await requirePeer(agent);
        return this.peerHub.ask({ agent, userId: requireOwner(), topic, message, timeoutMs, mode });
      },
      send: async ({ agent, topic, message, mode }) => {
        await requirePeer(agent);
        return this.peerHub.send({ agent, userId: requireOwner(), topic, message, mode });
      },
      reply: async ({ eventId, message }) => this.peerHub.reply({ eventId, message }),
      spawnWorkspace: async ({ name, purpose, message, timeoutMs, mode }): Promise<PeerSpawnOutcome> => {
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
          agent: agentName, userId, topic: 'task', message, timeoutMs, mode,
        });
        return { agent: agentName, created, ...outcome };
      },
    };
  }

  /** This workspace's own stores plus a client for the owner's library, every
   *  call of which crosses the UserDO capability gate. Absent until the
   *  workspace is claimed — there is no owner library to reach before that. */
  private getExperienceDeps(): ExperienceActionDeps | undefined {
    if (!this.getOwnerUserDO()) return undefined;
    const hub = () => this.userHub();
    return {
      rt: this.rt,
      facts: this.facts,
      library: {
        publish: async (candidate) => { const { stub, caller } = await hub(); return stub.publishExperience(caller, candidate); },
        search: async (options) => { const { stub, caller } = await hub(); return stub.searchExperience(caller, options); },
        get: async (id) => { const { stub, caller } = await hub(); return stub.getExperienceEntry(caller, id); },
      },
    };
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

  protected subordinateFacet(): SubAgentClass<SubordinateAgent> {
    return SubordinateAgent;
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
      } else {
        void this.sql`UPDATE workspace_identity SET owner_user_id = ${userId}`;
      }
      this.invalidateModelCaches();
      await this.ensureOwnedScaffold();
      return { owner: userId, capabilityHash };
    }
    if (current !== userId) {
      throw new Error(`Agent owned by a different user (stored=${current.slice(0, 8)}…, caller=${userId.slice(0, 8)}…)`);
    }
    // Ownership is persisted before the external filesystem bootstrap. If a
    // transient Nimbus failure interrupted that first claim, the next
    // authenticated touch must finish the invariant instead of treating the
    // owner row as proof that initialization completed.
    await this.ensureOwnedScaffold();
    return { owner: current, capabilityHash };
  }

  // The reactor (drain-then-stop) now lives on the core AgentOrchestrator
  // (it binds selected pending events via markConsumed, then injects one
  // signal through the core delivery seam). Ingress paths use
  // the debounced `this.orch.scheduleDrain()`; the post-turn hook drains
  // immediately via `this.orch.drainPendingEvents()`.

  async onChatResponse(result: ChatResponseResult) {
    const turnMode = this.turnWorkMode();
    // The actor-generic settle spine lives on ActorAgent; everything after it
    // here is orchestrator sequencing (takes, branches, evolution, naming).
    const { drainTurnId, programmaticUserMessage, errorText, completed, injectedSignals } =
      this.settleTurnEvents(result);
    this.recordTurnTelemetry(result, { errorText, completed, programmaticUserMessage });
    // The session tree is the transcript; `messages` is its projection, and it
    // is refreshed here rather than at the end of a happy path. The block this
    // replaced wrote two rows per turn — the last user message and the final
    // assistant message — and only for turns that reached "completed", so an
    // interrupted turn and every steer spliced into a running one were visible
    // in the chat pane and absent from the table that fork, memory search, the
    // status read model and the evolution outcome window all read. Projecting
    // before the early return is the point: an interrupted turn is exactly the
    // one whose messages were being lost.
    reconcileSessionTree(this.boundSql);
    if (result.status !== "completed") {
      // An aborted/errored live turn leaves nothing to compare a branch
      // against — and any takes its think-mcts runs captured competed for an
      // answer that no longer exists, so the next turn must not claim them.
      purgeUnclaimedAlternateTakes(this.boundSql);
      this.settlePendingBranches(null, '');
      return;
    }

    const userMessages = this.messages.filter(m => m.role === "user");
    const lastUserMsg = programmaticUserMessage ?? userMessages[userMessages.length - 1];
    const userText = lastUserMsg?.parts
      ?.filter(p => p.type === "text")
      .map(p => p.text)
      .join("") ?? "";

    const assistantText = result.message.parts
      ?.filter(p => p.type === "text")
      .map(p => p.text)
      .join("") ?? "";

    // Extension seam: the turn settled and was durably persisted — the same
    // onTurnEnd contract runChat fires on the CLI (final text + the turn's
    // response messages in ModelMessage shape).
    await this.extensions.emitTurnEnd({
      text: assistantText,
      responseMessages: await convertToModelMessages([result.message], { ignoreIncompleteToolCalls: true }),
    });

    const msgId = result.message.id;
    // Alternate Takes and steer branches were both captured mid-turn, before
    // this id existed, and both are attributed to it — one decision, made by
    // core (orchestrator/turn-lifecycle.ts `creditedTurnId`) rather than once
    // here and again in the CLI's runTurn. Reached only on the completed path
    // (the early return above owns the rest), so what it still decides here is
    // an unattributable turn and a PLAN turn: a plan is not an answer the
    // captures competed against.
    const credited = creditedTurnId({
      messageId: msgId ?? null,
      completed: true,
      workMode: turnMode,
    });
    if (credited !== null) {
      claimAlternateTakesForTurn(this.boundSql, {
        turnId: credited, sessionId: 'default', startedAt: this.acc.startedAt,
      });
    } else {
      purgeUnclaimedAlternateTakes(this.boundSql);
    }

    // Record which crafted tools this turn used, keyed by the assistant
    // message id, so async thumbs feedback (setTurnFeedback) can re-score
    // exactly those tools. Feedback is inherently asynchronous — it arrives
    // after the turn completes — so turn.feedback is null here; the outcome
    // review (engine.reviewTurn, dispatched when the NEXT user message
    // arrives) populates it from explicit thumbs or the follow-up classifier.
    if (msgId) {
      // The crafted tools this turn called, as the in-episode craft clock saw
      // them. Not "every tool name that is not built in": a crafted tool is
      // codemode-only and never appears as a tool-call name, so that filter
      // only ever matched MCP and extension tools — and the thumbs re-score
      // below reads this row to write craft_scores.
      const craftNames = this.acc.craftedToolsUsed();
      if (craftNames.length > 0) {
        void this.sql`INSERT INTO turn_craft_usage (message_id, tool_names, created_at)
                 VALUES (${msgId}, ${JSON.stringify(craftNames)}, ${Date.now()})
                 ON CONFLICT(message_id) DO UPDATE SET
                   tool_names = excluded.tool_names, created_at = excluded.created_at`;
      }
    }

    // Steer-as-Branch redirects launched during this turn settle against its
    // answer — detached, so a slow branch never blocks the TurnQueue.
    this.settlePendingBranches(credited, assistantText);

    // Mission Inbox: a turn injected by the event drain carries the synthetic
    // turn id its events were bound to — reply their open email_thread
    // channels with this turn's answer (threaded outbound email). Detached.
    if (drainTurnId) {
      this._pendingDrainReplyTurns.set(result.requestId, drainTurnId);
      void this.completeEventBatch(drainTurnId, assistantText).then((completed) => {
        if (completed && this._pendingDrainReplyTurns.get(result.requestId) === drainTurnId) {
          this._pendingDrainReplyTurns.delete(result.requestId);
        }
      });
    }
    // Signals absorbed at a step boundary feed the SAME dispatch, keyed by the
    // reply turn id each one carries.
    for (const injected of injectedSignals.absorbed) {
      if (injected.replyTurnId) void this.completeEventBatch(injected.replyTurnId, assistantText);
    }

    // status is "completed" here (the !== "completed" early-return above), so
    // turn errors are tracked via the accumulator's per-step hadError flag.
    const turn: CompletedTurn = snapshotCompletedTurn(this.acc, {
      userMessage: userText,
      assistantResponse: assistantText,
      turnId: msgId,
      sessionId: 'default',
      origin: programmaticUserMessage || this.lastUserTurnIsProgrammatic() ? 'programmatic' : 'user',
    });

    // The shared evolution spine (ActorAgent.settleCompletedTurn): the core
    // AgentOrchestrator's cadence — session-reflection counter (firing
    // engine.onSessionComplete every N turns) + this turn buffered for its
    // outcome review, which the NEXT user message grades — plus the keepAlive
    // that outlives Think's turn wrapper, plus the sampled shadow trial that
    // gives the promotion gate its evidence about whatever that cadence
    // proposed.
    if (turnMode !== 'plan') {
      this.settleCompletedTurn(turn);

      // Sleep-time compute — between-turn background memory compression.
      // Reads recent turn, asks a judge to upsert/decay the agent_facts world
      // model. Letta-style; ~50% test-time token reduction reported. Gated by
      // agent_config.sleep_time_compute (default ON; fact upserts land in the
      // Evolution Changelog and are revertable).
      void this.runSleepTimeCompute(userText, assistantText, this.acc.toolCalls);

      // Title the workspace from what it is FOR — its mission — not from
      // whatever it was asked to do first. A workspace with no mission of its
      // own has only the opening request to go on. Fire-and-forget; once-only
      // (persisting an auto title marks name_origin).
      const mission = readMission(this.boundSql);
      void this.maybeAutoTitleWorkspace(isPlaceholderMission(mission) ? userText : mission!);

      // Trace-driven continuous self-optimization (when enabled): run GEPA once
      // enough new turns have accrued. Fire-and-forget; no-op when disabled.
      this.maybeRunAutoGepa();
    }

    // Reactor drain-then-stop: handle any external events still pending (arrived
    // during this turn, or queued before a chat turn). No-op when none — so this
    // self-terminates once the external event backlog is empty. Deliberately
    // IMMEDIATE (not scheduleDrain): the just-finished turn already coalesced
    // everything that arrived during it, so there is no burst left to debounce.
    void this.orch.drainPendingEvents();
  }

  /** Background memory compression. Reads recent turn, updates agent_facts.
   *  Fire-and-forget; does not block TurnQueue. */
  private async runSleepTimeCompute(
    task: string, output: string, toolCalls: ToolCallRecord[],
  ): Promise<void> {
    try {
      if (!this.config.getSleepTimeComputeEnabled()) return;
      const { runSleepTimeCompute, applySleepTimeUpdate } = await import('@kinu.run/core');
      const currentFacts = this.facts.all()
        .sort((a, b) => b.lastObservedAt - a.lastObservedAt)
        .map(f => ({ key: f.key, value: f.value, confidence: f.confidence }));
      // Mechanical work — schema-constrained fact upsert/decay over a turn
      // summary. Runs on the chat vendor's small tier when it has one.
      const update = await runSleepTimeCompute(this.rt.fastLlm ?? this.rt.llm, {
        task,
        output,
        toolCalls: toolCalls.map(tc => tc.name),
        currentFacts,
      });
      if (!update) return;
      const summary = applySleepTimeUpdate(this.facts, update);
      diagnostics.event('memory.facts_compressed', {
        upserted: summary.upserted,
        decayed: summary.decayed,
        skipped: summary.skipped,
      });
    } catch (err) {
      diagnostics.failure('memory.fact_compression_failed', toKinuError({
        doing: 'compressing the turn into agent facts',
        cause: err,
        otherwise: 'unavailable',
      }));
    }
  }

  /** Automatic titling — one path, two triggers: the first turn of a workspace
   *  that was never titled, and the wake of a legacy workspace still showing
   *  its raw slug (created before mission-derived titling existed). The shared
   *  policy decides; a title the operator chose is never touched, and persisting
   *  an auto title marks name_origin='auto', so this runs at most once.
   *  The slug is NOT part of this: it is fixed at creation and permanent. */
  private async maybeAutoTitleWorkspace(mission: string): Promise<void> {
    try {
      const title = await applyWorkspaceTitle({
        slug: this.name,
        displayName: this.config.getDisplayName(),
        nameOrigin: this.config.getNameOrigin(),
        mission,
      }, {
        persist: async (name) => { await this.setAutoDisplayName(name); },
        suggest: (text) => this.suggestWorkspaceTitle(text),
      });
      if (title) diagnostics.event('workspace.auto_titled', { workspace: this.name, title });
    } catch (err) {
      diagnostics.failure('workspace.auto_title_failed', toKinuError({
        doing: 'deriving a workspace title from the mission',
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: this.name });
    }
  }

  /** The shared workspace-naming round-trip (same prompt and parser the create
   *  path uses), against this workspace's review model.
   *
   *  Reported as `fast` rather than `judge`: the review model is who serves it,
   *  but naming a workspace is mechanical work, and grouping it with the judges
   *  would make "what did grading cost" answer a question it did not ask. */
  private async suggestWorkspaceTitle(mission: string): Promise<string | null> {
    const result = await generateText({
      model: await this.getModelForReview(),
      system: WORKSPACE_TITLE_SYSTEM_PROMPT,
      prompt: workspaceTitlePrompt(mission),
      // No output cap: reasoning models spend their budget thinking before the
      // JSON, and a cap starves them into empty text.
      ...effortFor('judge'),
    });
    // No `spec`: `getModelForReview` resolves the review model behind its own
    // cache and hands back a `LanguageModel`, so this call site genuinely does
    // not know which spec served it, and re-running the selection to find out
    // would be a second resolution that could disagree with the first. The
    // provider's own `modelId` identifies the model; `usd` therefore stays
    // absent, which already means unpriced rather than free.
    const modelId = result.response?.modelId;
    const usage = normalizeUsage(result.usage);
    this.reportModelCall(modelId ? { source: 'fast', usage, modelId } : { source: 'fast', usage });
    return parseWorkspaceTitle(result.text);
  }

  /** Push a display name to all three homes: agent_config (source of truth),
   *  the owner's roster row (the Sidebar), and a live broadcast to open clients.
   *  Does NOT set name_origin — the caller decides whether this locks
   *  auto-titling (a provisional title leaves it open; user/auto titles set it). */
  private async propagateDisplayName(displayName: string): Promise<void> {
    this.config.setDisplayName(displayName);
    if (this.getOwnerUserId()) {
      try {
        const { stub, caller } = await this.userHub();
        await stub.setWorkspaceDisplayName(caller, this.name, displayName);
      } catch (err) {
        diagnostics.failure('roster.display_name_sync_failed', toKinuError({
          doing: 'syncing the workspace display name to the owner roster',
          cause: err,
          otherwise: 'unavailable',
        }), { workspace: this.name });
      }
    }
    this.broadcast(JSON.stringify({ type: 'workspace_renamed', displayName }));
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

  @callable()
  async cancelBackgroundJob(jobId: string): Promise<{ ok: boolean }> {
    return cancelBackgroundJob(this.jobRunner, jobId);
  }

  @callable()
  async retryBackgroundJob(jobId: string): Promise<RetryOutcome> {
    return retryBackgroundJob({
      jobs: this.jobs,
      jobRunner: this.jobRunner,
      rawTools: (mode) => this.getRawToolsForWorkMode(mode),
      logActivity: (event, detail) => this.logActivity(event, detail),
    }, jobId);
  }

  @callable()
  async dismissBackgroundJob(jobId: string): Promise<{ ok: boolean }> {
    return dismissBackgroundJob(this.jobs, jobId);
  }

  @callable()
  async clearBackgroundJobs(): Promise<{ ok: boolean }> {
    return clearBackgroundJobs(this.jobs);
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
  protected override onWorkCancelled({ cancelledJobs, abortedTools }: Omit<CancelWorkOutcome, 'ok'>): void {
    this._inFlight = false;
    this.logActivity('work_cancelled', `${abortedTools} foreground, ${cancelledJobs.length} background`);
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
          scope: consent.scope,
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
  private _deferrals: DeferredApprovalQueue | null = null;
  private get deferrals(): DeferredApprovalQueue {
    if (!this._deferrals) {
      this._deferrals = new DeferredApprovalQueue({
        store: new DeferredApprovalStore(this.boundSql),
        // Read through `this.orch` at DELIVERY time, never captured: this
        // getter is reachable from the runtime's own construction path.
        signals: { deliver: (signal) => this.orch.signals.deliver(signal) },
        // Where an 'always' answer lands: the same agent_config the approval
        // MODE lives in, read live by the gate on the very next command.
        remember: (grants) => { this.config.grantShellApproval(grants); },
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

  // ── Plan review — durable revisions + serialized mode handoff ────────

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
    if (!admitted.ok) return { ok: false, error: admitted.error, plan: this.planReviews.get(id, revision) };
    const result = this.planReviews.saveAnnotations(id, revision, admitted.annotations);
    if (result.ok) this.broadcastPlanUpdate(result.plan);
    return result;
  }

  /** Persist the owner's verdict before starting the next turn. This is a
   * mode boundary, so it deliberately enqueues behind the planning turn
   * instead of splicing into that turn's next step: implementation must never
   * begin under the Plan prompt/tool surface. */
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

  // ── DO initialization ──────────────────────────────────────────

  // Device connection moved to the user level (UserDO owns the tunnel socket +
  // tokens); the laptop executor forwards to it. The old per-agent
  // verifyPcToken / attachPcSocket / issuePcToken / listPcTokens are gone.

  /**
   * Create/migrate every agent table. Idempotent and gated by an in-memory
   * flag so the full DDL set runs once per DO activation (both onStart and a
   * pre-onStart claimOwner route through here). No persistent schema-version is
   * tracked: a cold activation always re-runs, so newly-added tables in code
   * are created without migration bookkeeping.
   */
  protected ensureSchema(): void {
    if (this._schemaReady) return;
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);

    // Every table a workspace has, on any backend — one list, in core.
    initWorkspaceSchema({ execRaw, sql: this.boundSql, exec: this.ctx.storage.sql });
    initWorkspaceBaselineTable(execRaw);

    // ── planes this root alone carries (declared per-root in
    //    core/conformance/manifest.ts, observed against sqlite_master) ──
    initWebhookRateLimitTables(this.ctx.storage.sql);
    this.subordinateRoster.ensureSchema();

    // Workspace-diff baseline (path → content snapshot) for the Output surface's

    // Per-turn user feedback (thumbs up/down). The chat UI's thumbs button
    // writes here via setTurnFeedback, which re-scores the crafted tools used
    // in that turn — feedback is inherently asynchronous (it arrives after the
    // turn completes), so it can't be read at turn time.
    execRaw(`CREATE TABLE IF NOT EXISTS turn_feedback (
      message_id TEXT PRIMARY KEY,
      feedback   TEXT NOT NULL CHECK (feedback IN ('positive','negative')),
      created_at INTEGER NOT NULL
    )`);
    // Records which crafted tools each assistant turn used, keyed by the
    // assistant message id, so async thumbs feedback can re-score exactly
    // those tools' EMA. Only crafted tools are stored (built-ins aren't scored).
    execRaw(`CREATE TABLE IF NOT EXISTS turn_craft_usage (
      message_id TEXT PRIMARY KEY,
      tool_names TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);

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
  onStart(): void {
    this.ensureSchema();
    // Runs inside `Agent.alarm()`'s initialization, i.e. before the SDK reads
    // the due rows — so a backlog is pruned rather than dispatched in one go.
    try {
      this.sweepUnrunnableSchedules();
    } catch (err) {
      diagnostics.failure('schedule.stale_sweep_failed', toKinuError({
        doing: 'sweeping unrunnable schedule rows on activation',
        cause: err,
        otherwise: 'io',
      }));
    }
    let reconciledEventIds: string[] = [];
    try {
      reconciledEventIds = this.eventLog.unbindStale(STALE_EVENT_DELIVERY_MS);
    } catch (err) {
      diagnostics.failure('event.stale_delivery_unbind_failed', toKinuError({
        doing: 'unbinding event deliveries a dead activation left leased',
        cause: err,
        otherwise: 'io',
      }));
    }

    try {
      const identity = this.sql<{ id: string }>`SELECT id FROM workspace_identity LIMIT 1`;
      if (identity.length === 0) {
        void this.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${this.ctx.id.toString()}, ${this.name}, ${Date.now()})`;
      }
    } catch (err) {
      diagnostics.failure('workspace.identity_init_failed', toKinuError({
        doing: 'writing the workspace identity row on activation',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    }
    // A cold activation is the moment the fork journal's `running` heads become
    // provably stale: nothing in this isolate is executing one, and
    // `head_journal.status` had no writer for that — so `listLive()` kept
    // feeding "N of M heads running" into every model step's dynamic-context
    // block for the life of the workspace.
    //
    // BUT CORRECTING THAT CLAIM IS NOT RETIRING THE WORK, and this used to do
    // both in one write, unconditionally, as the first thing an activation did.
    // Meanwhile the only thing that could re-enter an interrupted search —
    // `recoverOrphans()` — was reachable ONLY from `onFiberRecovered` for a
    // surviving `bg:*` fiber, and a fiber row can die with the activation that
    // owned it (that is the case `jobs/runner.ts` documents its registry sweep
    // for). So the retirement was guaranteed and the re-entry was conditional,
    // and the retirement won every eviction: five heads of a live search were
    // recorded `aborted` with "nothing left that could run it" while the durable
    // job that could run it was still re-drivable, and the agent, told its work
    // was gone, re-forked by hand.
    //
    // The reconciliation now owns the order. It marks the stale rows
    // `interrupted` — non-terminal, so the roster stops lying without discarding
    // the run — then offers their roots to the job sweep, and retires only what
    // the sweep refused. The sweep runs HERE rather than only on a fiber
    // callback, which is what the CLI has always done (`local-session.ts`); it
    // is idempotent, because every recovery reclaims under a fresh lease and a
    // job this isolate is already driving is skipped.
    //
    // Detached, not awaited: the journal writes are synchronous and land in this
    // method's own frame, but TELLING the agent goes through the signal seam,
    // which queues a turn via `Think.saveMessages` and resolves only when that
    // turn ENDS. Awaiting a whole agent turn inside the init gate is the 30s
    // object reset.
    void reconcileInterruptedForks({
      journal: this.headJournal,
      signals: this.orch.signals,
      runEvents: this.eventRecorder,
      resume: jobRedriveResumeGate({
        recoverOrphans: () => this.jobRunner.recoverOrphans(),
        inputOf: (jobId) => this.jobs.getInput(jobId),
        rootsForTask: (task) => resumableForkRoots(
          { ledger: this.mctsSearchStore, journal: this.headJournal }, task,
        ),
      }),
      logActivity: (event, detail) => this.logActivity(event, detail),
    }).catch((err) => {
      diagnostics.failure('head.journal_reconcile_failed', toKinuError({
        doing: 'reconciling fork-journal heads a dead activation left running',
        cause: err,
        otherwise: 'io',
      }), { workspace: this.name });
    });
    if (reconciledEventIds.length > 0) {
      diagnostics.event('event.deliveries_repended', { events: reconciledEventIds.length });
      this.orch.scheduleDrain();
    }

    // Workspaces created before mission-derived titling still show their raw
    // slug. Title them from SOUL.md's mission the first time one is opened —
    // every other workspace is already titled, so it costs a config read.
    // Fire-and-forget: boot never waits on a model call.
    if (this.getOwnerUserId() && isPlaceholderWorkspaceTitle(this.config.getDisplayName(), this.name)) {
      void readSoul(this.rt.storage.vfs)
        .then((soul) => this.maybeAutoTitleWorkspace(summarizeSoul(soul ?? '')))
        .catch((error) => {
          diagnostics.failure('workspace.auto_title_soul_read_failed', toKinuError({
            doing: 'reading SOUL.md to title a legacy workspace',
            cause: error,
            otherwise: 'io',
          }), { workspace: this.name });
        });
    }
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
          const next = nextAlarmTime(
            now,
            this.triggerRegistry.list({ state: 'active' }).map((t) => t.next_fire_at),
            this.peerHub.nextRetryAt(),
            this.emailOutbox.nextRetryAt(),
          );
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
    return this.config.getDisplayName() ?? this.name;
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
    return getAgentStatus({
      sql: this.boundSql,
      vfs: this.rt.storage.vfs,
      config: this.config,
      name: this.name,
      displayName: this.getDisplayName(),
      // Before the first turn has been mirrored into `messages`, the in-memory
      // AIChatAgent array is the only count there is.
      fallbackMessageCount: this.messages.length,
    });
  }

  async getToolList() {
    return getToolList(this.boundSql, this.rt.craftStore);
  }

  /** The LATEST search's tree only — settled earlier searches stay in
   *  search_nodes and must never shadow the run the operator is watching. */
  @callable() async getMctsTree() {
    return readLatestSearchTree(this.boundSql);
  }

  /** One named search's tree. The unified fork list can select a competed run
   *  that is not the latest, and `getMctsTree` would then answer with another
   *  search's branches under it. */
  @callable() async getSearchTree(rootId: string) {
    return readSearchTree(this.boundSql, rootId);
  }

  /**
   * A page of every exploration run this workspace has, newest first — the one entry
   * point the Exploration surface lists.
   *
   * Cursored because a bare `LIMIT 20` said "that is every run" about the newest
   * twenty, and the twenty-first was then reachable only by permalink.
   */
  @callable() async listForkRuns(request?: PageRequest): Promise<Page<ForkRunSummary>> {
    return listForkRuns(this.boundSql, request?.cursor ?? null, request?.limit);
  }

  /**
   * One named run for a permalink, independent of the recent-list window — the SAME
   * composed row {@link getExplorationCanvas} pages.
   *
   * The composed row rather than the bare summary, because the parameters used to
   * travel only on the canvas page: the full-screen drill-down that opens one run by
   * id had no way to read that run's own knobs, so the judge clamp was visible in the
   * list column and invisible in the view with room to show it. Fetching a page of
   * thirty runs and their trees to render one is not the answer.
   */
  @callable() async getForkRun(rootId: string): Promise<ExplorationCanvasRun | null> {
    return readExplorationRun(this.boundSql, rootId);
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
    return readExplorationCanvas(this.boundSql, request?.cursor ?? null, request?.limit);
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
    return listRecordObjectives(this.boundSql, request?.cursor ?? null, request?.limit);
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
    return listRecordCells(this.boundSql, request, request.cursor ?? null, request.limit);
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
    return readRecordCell(this.boundSql, request, request.cursor ?? null, request.limit);
  }

  /**
   * Everything asynchronous that is waiting on the owner, in one queue.
   *
   * Host-owned by design: this is NOT in `VIEW_DATA_SOURCES` and must not be
   * added. An agent-authored view that could draw the needs-you queue could
   * draw a plausible fake of it — the same argument that keeps
   * `listPendingConsents` off that list, on the surface an owner reads right
   * before authorising something.
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
    const unseen = getUnseenChangelog(this.config, this.boundSql);
    return buildPendingActions({
      approvals: board?.approvals ?? [],
      changes: board?.changes ?? [],
      scaffoldVersions: listScaffoldVersions(this.boundSql, 20),
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
    return readSearchNodeDetail(this.boundSql, nodeId);
  }

  // ── Evolution Changelog — the self-change digest + revert (core builder) ──

  /** The "what I changed about myself" digest, assembled on demand from the
   *  durable ledgers (core buildChangelog — no second event system). */
  @callable()
  async getEvolutionChangelog(opts?: { limit?: number }): Promise<{
    entries: ChangelogEntry[]; unseenCount: number; seenAt: number;
  }> {
    return getEvolutionChangelog(this.config, this.boundSql, opts?.limit);
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
      void this.sql`INSERT INTO evolution_events (type, message, created_at)
        VALUES ('reflection', ${`Operator reverted changelog entry ${id}: ${result.detail ?? 'done'}`}, ${Date.now()})`;
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
    for (const set of listAlternateTakeSets(this.boundSql, { limit: 100 })) {
      if (set.turnId && !byTurn[set.turnId]) byTurn[set.turnId] = set;
    }
    return byTurn;
  }

  /** The newest take set, picked or not — the TUI's /takes comparison source. */
  @callable()
  async latestAlternateTakes(): Promise<AlternateTakeSet | null> {
    return latestAlternateTakeSet(this.boundSql);
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

  /** Settle every branch launched during the just-finished turn (detached —
   *  the shared core settle persists the takes set + broadcasts progress). */
  private settlePendingBranches(turnId: string | null, liveText: string): void {
    settlePendingBranches({
      sql: this.boundSql,
      sessionId: 'default',
      broadcast: (event: BranchStatusEvent) => this.broadcastBranchStatus(event),
    }, this._pendingBranches, turnId, liveText);
  }

  /** Record the user's pick between the explored takes — the explicit
   *  preference signal (turn_outcomes source 'take_pick' + convergence
   *  repoint via core recordTakePick). A pick that differs from the answered
   *  take queues a gentle programmatic continuation through the BackendHost
   *  seam (same machinery as the reactor / background-job wake). */
  @callable()
  async pickAlternateTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    const outcome = await pickAlternateTake(
      { sql: this.boundSql, engine: this.engine, signals: this.orch.signals }, takeId, nodeId);
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
   */
  async runScaffoldOnce(
    task: string,
    opts?: { useShadowOverride?: boolean; timeoutMs?: number },
  ): Promise<ScaffoldRunResult> {
    return runScaffoldOnce(this.scaffoldControl, task, opts);
  }

  /** Cross-DO wire form for the MCP Worker adapter. */
  async runScaffoldOnceWire(
    task: string,
    opts?: { useShadowOverride?: boolean; timeoutMs?: number },
  ): Promise<string> {
    return JSON.stringify(await this.runScaffoldOnce(task, opts));
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
    return getShadowStatus(this.boundSql);
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
    const pendingVersion = version ?? getPendingScaffold(this.boundSql)?.version ?? null;
    return readShadowVerdict(this.boundSql, pendingVersion);
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
      SELECT version FROM scaffold_versions WHERE version < ${version} ORDER BY version DESC LIMIT 1`;
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
    opts?: { timeoutMs?: number },
  ): Promise<ScaffoldRunResult> {
    return previewScaffoldLive(this.scaffoldControl, version, task, opts);
  }

  /**
   * Change how the `run` builtin handles 'gate' decisions from the
   * approval-gate review. Stored in agent_config; effective on the NEXT
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
      if (isDeviceNotConnectedError(err)) {
        return { available: false, reason: 'no device connected — connect one with `kinu connect`' };
      }
      throw err;
    }
  }

  /**
   * The checkpoint store's reachability and what it holds, in one round trip.
   *
   * Reachability is not optional here. This used to return a bare array and
   * answer `[]` for "no owner", "no device connected" and "the store is empty"
   * alike, and the web client turned that into
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
      void this.sql`DELETE FROM turn_feedback WHERE message_id = ${messageId}`;
      return { ok: true, messageId, feedback: null, rescored: 0 };
    }
    if (feedback !== 'positive' && feedback !== 'negative') {
      throw new Error(`feedback must be 'positive', 'negative', or null; got ${JSON.stringify(feedback)}`);
    }
    void this.sql`INSERT INTO turn_feedback (message_id, feedback, created_at)
             VALUES (${messageId}, ${feedback}, ${Date.now()})
             ON CONFLICT(message_id) DO UPDATE SET
               feedback   = excluded.feedback,
               created_at = excluded.created_at`;

    // Re-score the crafted tools this turn used with the feedback-derived
    // quality. No-op when the turn used no crafted tools.
    let rescored = 0;
    const usageRows = this.sql<{ tool_names: string }>`
      SELECT tool_names FROM turn_craft_usage WHERE message_id = ${messageId} LIMIT 1`;
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
   *  hydrates its thumbs marks on load instead of forgetting them. */
  @callable()
  async listTurnFeedback(): Promise<Record<string, 'positive' | 'negative'>> {
    const rows = this.sql<{ message_id: string; feedback: 'positive' | 'negative' }>`
      SELECT message_id, feedback FROM turn_feedback`;
    return Object.fromEntries(rows.map((r) => [r.message_id, r.feedback]));
  }

  /** The scaffold variant archive: recent versions with status, DGM lineage
   *  (parent_version) and aggregated shadow-eval record. Read-only — also the
   *  backing for the agent.scaffoldVersions codemode helper. Computed by
   *  core's listScaffoldArchive; keys stay snake_case here because this RPC's
   *  wire shape predates the archive (ScaffoldLineage.tsx reads written_at). */
  @callable()
  async listScaffoldVersions(limit: number = 20): Promise<ScaffoldVersionView[]> {
    return listScaffoldVersions(this.boundSql, limit);
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
    return listGepaRuns(this.boundSql, limit);
  }

  // ── Replay-eval loss curve ──────────────────────────────────────

  /** The persisted loss curve (replay_evals), newest first. Read-only — the
   *  data a loss chart would render. */
  @callable()
  async getReplayEvals(limit: number = 50): Promise<ReplayEvalSummary[]> {
    return listReplayEvals(this.boundSql, limit);
  }

  /** K_align: the correction rate per 100 graded turns, per scaffold version,
   *  with 95% Wilson intervals — the self-improvement question answered from
   *  telemetry alone, no benchmark and no judge. */
  @callable()
  async getAlignmentConvergence(): Promise<AlignmentConvergence> {
    return alignmentConvergence(this.boundSql);
  }

  /** What hand labels establish about the turn-outcome classifier, and the
   *  bias-corrected rates they buy. Reads "uncalibrated" until labels exist —
   *  K_align above is the classifier's opinion until this one has numbers. */
  @callable()
  async getOutcomeCalibration(): Promise<CalibrationReport> {
    return calibrationReport(this.boundSql);
  }

  /** Draw the next calibration set: turns for a human to judge blind. */
  @callable()
  async sampleOutcomeLabeling(size: number = DEFAULT_LABEL_BUDGET): Promise<LabelingItem[]> {
    return sampleForLabeling(this.boundSql, { size });
  }

  /** Store a labeling pass. Append-only; ids the ledger no longer knows are
   *  reported back rather than losing the pass. */
  @callable()
  async recordOutcomeLabeling(
    labeler: string,
    labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>,
  ): Promise<LabelIngestResult> {
    return ingestOutcomeLabels(this.boundSql, { labeler, labels });
  }

  /** How the LLM panel scored against the owner's own labels, and whether it
   *  cleared the pre-registered bar to stand in for them. */
  @callable()
  async getOutcomeEnsemble(): Promise<EnsembleReport> {
    return ensembleReport(this.boundSql);
  }

  /**
   * Put the hand-labeled turns to the panel — one blind pass per judge, stored
   * append-only. Judges come from `specs` when the owner names them, else one
   * model per connected vendor family other than the chat model's.
   *
   * Fewer than two families available is reported as the gap it is (by
   * `runEnsemble`, after the prerequisites the owner would fix first); nothing
   * is padded with a second model from the same vendor, which would agree with
   * the first for reasons that have nothing to do with the turn.
   */
  @callable()
  async runOutcomeEnsemble(specs?: string[]): Promise<EnsembleRunResult> {
    const registry = this.providerRegistry();
    return runEnsemble(this.boundSql, {
      specs: async () => (await resolveEnsembleJudgeSelection({
        registry,
        specs: specs ?? null,
        chatSpec: this.getStoredModelId(),
      })).specs,
      judge: (spec) => ({
        spec,
        llm: createCompletionLLM({
          model: registry.resolveModel(spec), spec, stage: 'judge',
          // One call per judge per hand-labelled turn, on a model deliberately
          // chosen from a different vendor family than the chat model — so this
          // is spend the actor's own catalog rate cannot price and the step
          // telemetry never saw.
          spend: { source: 'judge', report: (report) => this.reportModelCall(report) },
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
      const run = listGepaRuns(this.boundSql, 200).find((r) => r.runId === runId) ?? null;
      const candidates = loadGepaCandidates(this.boundSql, runId).map((c) => ({
        id: c.id, parentId: c.parentId, source: c.source,
        scores: Object.fromEntries(c.scores), feedback: Object.fromEntries(c.feedback),
        aggregateScore: c.aggregateScore, createdAt: c.createdAt,
      }));
      const pareto = this.sql<{ candidate_id: string; instance_id: string; score: number }>`
        SELECT candidate_id, instance_id, score FROM gepa_pareto_membership WHERE run_id = ${runId}`
        .map((r) => ({ candidateId: r.candidate_id, instanceId: r.instance_id, score: r.score }));
      return { run, candidates, pareto };
    } catch { return { run: null, candidates: [], pareto: [] }; }
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
  async getNodeTranscript(runId: string, nodeId: string): Promise<NodeTranscriptView | null> {
    return readNodeTranscript(this.boundSql, runId, nodeId);
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
    const workspace = createNimbusWorkspaceSandbox(this.env, ownerUserId, this.name);
    return readWorkspaceArchivePage(this.ctx.storage.sql, {
      workspace: this.name,
      source: 'cloud',
      cursor: parseArchiveCursor(cursor),
      files: nimbusWorkspaceArchiveFiles(workspace),
    });
  }

  /** Tear down every per-agent resource, then wipe this Durable Object. Called
   *  by UserDO.removeWorkspace on delete so a same-name recreate starts clean and no
   *  orphaned alarm / process / port lingers. Every external plane is
   *  fail-closed: the optional Sandbox goes first because its teardown can
   *  fail without deleting the authoritative Nimbus workspace; Nimbus then
   *  goes before actor storage so a retry never reconnects to stale bytes.
   *  Deliberately NOT @callable:
   *  destruction goes through UserDO's ownership check, never the raw websocket. */
  async destroyAgent(expectedOwnerUserId: string): Promise<{ ok: true }> {
    if (!/^[a-f0-9]{32}$/.test(expectedOwnerUserId)) throw new Error('invalid expected owner user id');
    const ownerUserId = this.getOwnerUserId();
    if (ownerUserId !== expectedOwnerUserId) throw new Error('Agent owner mismatch; refusing to destroy.');
    if (this.env.Sandbox) {
      // Same `transport` as every other getSandbox for this id — the SDK drops
      // in-flight requests if it changes between calls on one sandbox. The
      // reasoning for `rpc` lives at the other call site (runtime.ts); this one
      // exists to match it, and the pair must move together.
      const sb = getSandbox(this.env.Sandbox, `kinu-${this.name}`, {
        normalizeId: true, transport: "rpc",
      });
      // Before destroy(): the container object owns its /workspace snapshot, and
      // once its storage is gone nothing knows which R2 objects were its.
      await sb.discardWorkspaceSnapshot();
      await sb.destroy();
    }
    await createNimbusWorkspaceSandbox(this.env, ownerUserId, this.name).destroy({
      reason: 'Kinu workspace deleted',
    });
    await this.destroy(); // agents base: drops SDK tables + deleteAlarm + deleteAll + aborts the isolate
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

  /**
   * A page of recent runs enriched with PROVENANCE (what kicked each off) and
   * COST (tokens spent) — the cross-run history + budget view for the Supervise
   * altitude. Folds the per-run run_start (caused_by/userMessage) and the
   * accumulated turn_end usage out of the durable event log.
   *
   * The cap here was load-bearing in the wrong direction: Supervise sums the
   * usage of exactly the rows it received and prints the total as the
   * workspace's spend, so a truncated window was a truncated denominator
   * presented as a figure the owner decides on.
   */
  @callable()
  async getRunSummaries(request?: PageRequest): Promise<Page<RunSummary>> {
    return getRunSummaries(this.eventRecorder, request?.cursor ?? null, request?.limit);
  }

  /**
   * The Activity surface: what the newest request cost, what it was made of,
   * how the recent ones have behaved — and what the WHOLE workspace spent.
   *
   * The retained sample is the run-event log itself — `step_finish` rows are
   * durable and indexed by type, so the percentile has a real window without a
   * second store. `steps` bounds it, and the bound is reported back on the
   * result so the reader can see what the numbers are over.
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
      // panel is how a reader learns to distrust both.
      spend: workspaceSpend({ events: this.eventRecorder, sql: this.boundSql }, { windowLimit }),
      log: readActivityLog(this.boundSql, logLimit),
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

  // ── Agent-authored views ───────────────────────────────────────
  // Two reads and nothing else. Publishing is `workspace.createView` inside
  // execute_tools; reverting is the Evolution Changelog, which is host chrome.
  // Neither of those belongs on a surface the rendered view can reach.

  /** The tabs to draw. Titles are agent-authored, so the UI marks them. */
  @callable() async listAgentViews(): Promise<AgentViewSummary[]> {
    return listViews(this.boundSql);
  }

  /** The spec for one tab. Re-validated in core against the live file, so a
   *  spec edited on disk after it was published fails here rather than in the
   *  browser. */
  @callable() async getAgentView(slug: string): Promise<ReadViewResult> {
    return readView({ vfs: this.rt.storage.vfs, sql: this.boundSql }, String(slug));
  }

  @callable() async getToolDescriptions() {
    // Descriptions AND reach sourced from @kinu.run/core/tools/registry — one
    // truth for both. Reach used to be guessed here as
    // `nativeNames.has(name) ? 'native' : 'codemode'`, a binary that cannot
    // express "this actor has it on neither surface": `report` is the one
    // deps-gated builtin, so on an orchestrator it fell out of the else-branch
    // and the Tools panel read "code mode" — false twice over, because `report`
    // is native wherever it exists and its `report.*` namespace is wired only
    // on a subordinate. The two facts are now reported separately, because they
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
      const scoreRow = this.sql<{ score: number; uses: number }>`
        SELECT score, uses FROM craft_scores WHERE tool_name = ${t.name} LIMIT 1`;
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
    await this.propagateDisplayName(displayName);
    this.config.setNameOrigin('user'); // locks auto-titling — the operator named it
    return { displayName };
  }

  async setAutoDisplayName(displayName: string) {
    await this.propagateDisplayName(displayName);
    this.config.setNameOrigin('auto');
    return { displayName };
  }

  async setProvisionalDisplayName(displayName: string) {
    this.config.setDisplayName(displayName);
    return { displayName };
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
    void this.keepAliveWhile(() => this.orch.signals.deliver(signal)).catch((err) => {
      diagnostics.failure('genesis.turn_failed', toKinuError({
        doing: "taking the workspace's first turn",
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: this.name });
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

  /** The agent roster as seen from this workspace: this DO's orchestrator is
   *  the default agent (always present); durable subordinate facets follow. */
  @callable() async getWorkspaceAgents(): Promise<WorkspaceAgent[]> {
    const self = { name: this.name, displayName: this.getDisplayName() };
    try {
      return buildWorkspaceAgents(self, this.subordinateRoster.list());
    } catch {
      return buildWorkspaceAgents(self, []);
    }
  }

  /** Browser-only subordinate controls. These delegate to the exact same
   * orchestration policy as the model's agents tool, including rollback and the
   * authoritative roster broadcast. */
  @callable() async listSubordinates(): Promise<SubordinateRosterEntry[]> {
    return this.getTeamToolDeps().list();
  }

  @callable() async spawnSubordinate(role: string, mission: string): Promise<{
    name: string;
    displayName: string;
    subordinate: SubordinateRosterEntry;
  }> {
    return this.getTeamToolDeps().create({ role, mission });
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
   */
  async getExecutorOutput(executorId: string, limit: number = 50) {
    return this.sql<ExecutorOutputRow>`SELECT id, executor, command,
        substr(stdout, 1, ${EXECUTOR_OUTPUT_CLIP}) AS stdout, length(stdout) AS stdout_len,
        substr(stderr, 1, ${EXECUTOR_OUTPUT_CLIP}) AS stderr, length(stderr) AS stderr_len,
        exit_code, created_at
      FROM executor_output WHERE executor = ${executorId}
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
   * TWO FIELDS WERE REMOVED HERE AND NEITHER IS COMING BACK AS A SEED. This
   * payload used to carry `getExplorationCanvas()` and `getRunTimeline({limit:
   * 250})`. Measured against production on 2026-08-20, the canvas page was 499
   * KiB on one workspace and 824 KiB on another — a page composes thirty runs
   * and every one of their heads — and it seeded exactly one thing: the tree map
   * the Exploration surface then rebuilds from its OWN `getExplorationCanvas`
   * read the moment it mounts. The timeline was 250 merged spans that no
   * component reads at all; `kinu timeline` calls `getRunTimeline` itself.
   * The chat pane paid both on every workspace open while showing neither. A
   * surface that is not open does not get to be on the critical path of the one
   * that is.
   */
  @callable()
  async getWorkspaceSnapshot() {
    const [status, tools, memoryContent, executors, activePlan] = await Promise.all([
      this.getAgentStatus(),
      this.getToolDescriptions(),
      this.getMemoryContent(),
      this.getExecutors(),
      this.getActivePlanReview(),
    ]);
    const executorOutputs = await Promise.all(
      executors.map(async (e) => ({
        name: e.name,
        outputs: await this.getExecutorOutput(e.name, 50),
      })),
    );
    const lastActiveExecutor = this.config.getLastActiveExecutor();
    return { status, tools, memoryContent, executors, executorOutputs, lastActiveExecutor, activePlan };
  }

  @callable() async executeInExecutor(executorId: string, command: string) {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { error: `Executor "${executorId}" not found` };
    if (!provider.isAvailable()) return { error: `Executor "${executorId}" is not available` };

    const execTool = provider.tools.exec;
    if (!execTool) return { error: `Executor "${executorId}" has no exec tool` };

    try {
      const result = await execTool.execute(command);
      const stdout = v.is(v.string(), result) ? result : JSON.stringify(result);
      // The ONE failure predicate (core execution/exec-result.ts). What stood here
      // was a third prose matcher listing `exec error:`, `read error:` and friends
      // — prefixes no executor writes any more, and one that never matched the
      // shapes that mattered: an unconfigured sandbox and an unattached laptop
      // both drew as exit 0 in this terminal. The refusal payload those now return
      // is one of the two shapes `isFailingResultText` is defined over.
      const isError = isFailingResultText(stdout);

      void this.sql`INSERT INTO executor_output (executor, command, stdout, stderr, exit_code)
        VALUES (${executorId}, ${command}, ${stdout}, ${isError ? stdout : ''}, ${isError ? 1 : 0})`;

      this.broadcast(JSON.stringify({
        type: 'executor-output', executor: executorId, command, stdout,
        stderr: isError ? stdout : '', exitCode: isError ? 1 : 0, timestamp: Date.now(),
      }));

      return { stdout, stderr: isError ? stdout : '', exitCode: isError ? 1 : 0 };
    } catch (err) {
      const errMsg = renderThrownChain({ cause: err });
      void this.sql`INSERT INTO executor_output (executor, command, stderr, exit_code)
        VALUES (${executorId}, ${command}, ${errMsg}, ${1})`;
      // Broadcast on error too — symmetric with the success branch above.
      // Without this, the UI terminal silently swallows failures because
      // it renders only from broadcasts. (STABILITY-AUDIT §B4.)
      this.broadcast(JSON.stringify({
        type: 'executor-output', executor: executorId, command, stdout: '',
        stderr: errMsg, exitCode: 1, timestamp: Date.now(),
      }));
      return { error: errMsg, exitCode: 1 };
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

  /** Upload one file into an executor (file-manager drop/Upload).
   *
   *  Reached over HTTP (files-routes.ts), not over the chat WebSocket: an RPC
   *  upload has to base64 its payload into a frame with a 1 MiB ceiling, so
   *  ordinary files died at the socket as an opaque connection failure. */
  async writeExecutorFile(executorId: string, path: string, bytes: Uint8Array): Promise<ExecutorWriteResult> {
    if (!this.rt.executionRouter) return { error: 'no execution router' };
    return writeExecutorFileOp(this.rt.executionRouter, executorId, path, bytes);
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
      (_path, content) => writeNimbusWorkspaceSoul(this.env, ownerUserId, this.name, content),
    );
    // Invalidate the cached SOUL.md + system prompt so the next turn
    // picks up the new identity.
    this._cachedSoulText = null;
    this._cachedSystemPrompt = null;
    this._cachedSystemPromptKey = '';
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

  /** Which model each routed producer runs on — the same producer names the
   *  Spend panel shows. */
  @callable() async getModelRoles(): Promise<ModelRolesView> {
    return getModelRoles(this.config);
  }

  @callable() async setModelRoles(roles: Partial<Record<RoutedSpendSource, string | null>>): Promise<ModelRolesView> {
    return setModelRoles(this.config, roles);
  }

  // ── Fork RPCs ──────────────────────────────────────────────────

  /**
   * Fork this agent at a specific message, producing a new agent DO with:
   *   - SOUL.md copied, messages 0..N copied, crafted tools snapshotted,
   *     memory copied, agent_config copied (display_name overwritten)
   *   - search tree, evolution events, scaffold, craft_scores RESET
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
    const fork = await forkWorkspace({
      sql: this.boundSql,
      vfs: this.rt.storage.vfs,
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
          snapshot,
          ownerUserId,
        });
      },
    };
  }

  /**
   * Receive a fork snapshot from a source agent. INTERNAL — called only by the
   * source DO's fork transport via cross-DO stub. NOT @callable: cross-DO stub
   * RPC never needed the decorator, and this is a raw storage write that must
   * never be reachable over the public agents WS/HTTP transport.
   */
  async rawCopyFromFork(
    forkName: string,
    snapshot: ForkSnapshot,
    ownerUserId: string,
  ): Promise<
    | { ok: true; agentId: string; capabilityHash: string | null }
    | { ok: false; reason: 'owned_by_another_user' }
  > {
    if (!ownerUserId) throw new Error('fork owner is required');
    // Apply the FULL schema before copying rows. onStart runs on first access,
    // but this RPC can be invoked before it completes — ensureSchema creates
    // every table so the copy's events-hub/heads/shadow/etc. rows never hit a
    // missing table.
    this.ensureSchema();

    // The Nimbus namespace is derived from this row, so ownership must exist
    // before the first file write. Refuse any pre-existing cross-owner target
    // instead of copying bytes into a namespace the source does not own.
    const currentOwner = this.getOwnerUserId();
    if (currentOwner && currentOwner !== ownerUserId) {
      return { ok: false, reason: 'owned_by_another_user' };
    }
    const identity = this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`;
    if (identity.length === 0) {
      void this.sql`
        INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
        VALUES (${this.ctx.id.toString()}, ${forkName}, ${ownerUserId}, ${Date.now()})
      `;
    } else {
      void this.sql`UPDATE workspace_identity SET owner_user_id = ${ownerUserId}`;
    }
    this.invalidateModelCaches();

    // The row copy is atomic; the file copy cannot be inside that transaction
    // (a host transaction is synchronous, the filesystem is not) and does not
    // need to be — it is a set of idempotent overwrites. `this.boundSql` is a
    // stable closure over `this.sql` that preserves the `this`-binding the
    // Agent base class needs.
    await writeForkSnapshot(this.boundSql, this.rt.storage.vfs, snapshot, {
      workspaceId: this.ctx.id.toString(),
      workspaceName: forkName,
      ownerUserId,
      writeSoulFile: (content) => writeNimbusWorkspaceSoul(this.env, ownerUserId, forkName, content),
      transaction: (rows) => this.ctx.storage.transactionSync(rows),
    });
    await this.ensureOwnedScaffold();
    // Inherited files are the fork's starting state, not changes it produced.
    await resetWorkspaceBaseline(this.rt);

    return {
      ok: true,
      agentId: this.ctx.id.toString(),
      capabilityHash: await this.workspaceCapabilityHash(),
    };
  }

  // ── EventsHub RPCs — triggers + events for UI ──────────────────

  /** List triggers (webhooks, timers, watches, mcp routes). UI uses this
   *  for the Supervise Automations block. */
  @callable()
  async listTriggers() {
    return listTriggers(this.triggerRegistry);
  }

  /** Cross-DO wire form for the Worker HTTP adapter. */
  async listTriggersWire(): Promise<string> {
    return JSON.stringify(await this.listTriggers());
  }

  /** Create a durable webhook trigger. Returns the public URL.
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
    const now = Date.now();
    const webhook = await registerDurableWebhook(this.triggerRegistry, opts, now);
    if (opts.secret) this.webhookSecrets.put(webhook.secret_id, webhook.trigger_id, opts.secret, now);
    return {
      trigger_id: webhook.trigger_id,
      url: `/api/workspaces/${encodeURIComponent(this.name)}/webhook/${encodeURIComponent(webhook.trigger_id)}`,
      auth_mode: webhook.auth_mode,
      // For HMAC/bearer modes, the operator needs the secret once to give
      // to the external system; we return it inline now and never again.
      secret: opts.secret ?? null,
    };
  }

  /** Cancel a trigger (revoke). Idempotent. */
  async cancelTrigger(trigger_id: string) {
    return cancelTrigger(this.triggerRegistry, trigger_id, Date.now());
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
   * new turns have accrued since the last pass AND no pending scaffold is
   * mid-shadow, kick GEPA in the background. The counter keeps growing while a
   * pending is in flight, so a pass fires as soon as the shadow slot frees.
   */
  protected maybeRunAutoGepa(): void {
    const everyN = this.config.getAutoGepaEveryNTurns();
    if (everyN <= 0) return;
    // One-time honesty note: before autonomy defaults flipped ON, a disable
    // DELETED this key — an absent row is indistinguishable from
    // never-configured, so the autonomous default supersedes both. Pin the
    // default explicitly and record the activation in the evolution stream
    // so the override is documented, never silent.
    if (this.config.get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns) == null) {
      this.config.setAutoGepaEveryNTurns(everyN);
      void this.sql`INSERT INTO evolution_events (type, message, created_at)
        VALUES ('reflection', ${
          `Auto-GEPA enabled by the autonomous default (every ${everyN} turns of new traces). ` +
          `A disable set before autonomy defaults flipped on was stored as "unset" and is ` +
          `superseded by this default — run setAutoGepa(0) to disable again.`
        }, ${Date.now()})`;
    }
    this._turnsSinceGepa += 1;
    if (this._turnsSinceGepa < everyN) return;
    if (getPendingScaffold(this.boundSql)) return;  // wait for the slot; keep the counter
    this._turnsSinceGepa = 0;
    // The prompt-section lane rides the same cadence and the same switch. It is
    // judge-only where a scaffold pass is a rollout PLUS a judge call, so the
    // two share a tick rather than competing for one, and neither needs a
    // second config key nobody would find.
    this.advancePromptSections();
    void this.runScaffoldGepaOptimization()
      .catch((err) => diagnostics.failure('gepa.auto_run_failed', toKinuError({
        doing: 'running the cadence GEPA scaffold optimisation',
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: this.name }));
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
  protected advancePromptSections(): void {
    void advancePromptSectionLane(this.scaffoldControl)
      .catch((err) => diagnostics.failure('prompt_section.lane_failed', toKinuError({
        doing: 'advancing the prompt-section evolution lane',
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: this.name }));
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

  /** Run an inbound email through the hub from within the agent DO — the
   *  email counterpart of acceptWebhookDelivery. The Worker `email()` handler
   *  parses MIME + resolves the agent; the trust gate (owner email /
   *  email_route allowlist), publish, and thread reply channel run here
   *  atomically. Unauthorized senders never produce an event row. */
  async acceptEmailDelivery(opts: IncomingEmail): Promise<EmailAdmission> {
    return this.emailInbox.accept(opts);
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
    })().catch((err) => diagnostics.failure('email.owner_notification_failed', toKinuError({
      doing: 'sending the owner an away-channel notification',
      cause: err,
      otherwise: 'unavailable',
    }), { subject }));
  }

  /** Recent events, newest first — `events_v` ordering (received_at desc).
   *  Reached two ways: `kinu events` over the CLI RPC transport, and
   *  `GET /api/workspaces/<name>/events` through the wire form below. The CLI
   *  formats it through the one row formatter its four sibling list reads go
   *  through, so this answers a bare list of rows and never an envelope. The
   *  operator UI does not read it — the events it shows are the ones drained
   *  into a turn, carried on that turn's message. */
  async listRecentEvents(opts?: {
    variant?: string;
    since?: number;
    limit?: number;
  }): Promise<RecentEventRow[]> {
    const parsedVariant = v.safeParse(EventVariantSchema, opts?.variant);
    const events = this.eventLog.query({
      variant: parsedVariant.success ? parsedVariant.output : undefined,
      since: opts?.since,
      limit: opts?.limit ?? 100,
    });
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
