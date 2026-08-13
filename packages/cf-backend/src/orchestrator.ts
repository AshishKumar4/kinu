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
 * @proteus/core so the CLI surface shares them verbatim.
 */

import { callable, type AgentContext } from "agents";
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from "./rpc-surface.js";
import { getSandbox } from "@cloudflare/sandbox";
import { generateText, convertToModelMessages } from "ai";
import type {
  ActivitySnapshot,
  WorkspaceAgent,
  SubordinateActivityEvent,
} from "./lib/protocol.js";
import { buildWorkspaceAgents, teamPeers } from "./lib/workspace-roster.js";
import { nextAlarmTime } from "./lib/cron.js";
import type { ChatResponseResult } from "@cloudflare/think";
import {
  EvolutionEngine,
  readActivityLog,
  summarizeSteps,
  bootstrapScaffold,
  initWorkspaceSchema,
  shouldBackupWorkspace, workspaceBackupOptions,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS,
  argumentDigest,
  updateCraftScores,
  feedbackToQuality,
  migrateCraftedToolDuplicates,
  // Fork feature
  forkWorkspace, writeForkSnapshot, readForkLineage,
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
  runScaffoldOnce,
  type GepaOptimizationResult, type ScaffoldDecisionResult,
  type ScaffoldVersionView, type ShadowStatus,
  getPendingScaffold,
  readScaffoldVersion, readShadowVerdict, type ShadowVerdict,
  type RunEvent, type RunEventQuery,
  // agent_facts world model
  DEFAULT_CONFIG, AGENT_CONFIG_KEYS,
  // Voyager curriculum + Absolute Zero learnability proposer
  listProposedTasks, updateProposedTaskStatus,
  // Hybrid search (FTS5 + Vectorize via RRF)
  hybridSearch, memorySnippetRehydrator, type HybridHit,
  type CompletedTurn, type ToolCallRecord, type SqlExecutor,
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
  initAlternateTakesTable, startBranchHead, settlePendingBranches, newBranchId,
  type PendingBranch, type BranchStatusEvent,
  type ReleaseStatus, type ReleaseToolDeps,
  runExperienceAction,
  type ExperienceActionDeps,
  type ExperienceActionInput,
  // Release execution engine — the driver beneath the governance ledger
  ReleaseEngine, createSandboxReleaseExec,
  type TeamToolDeps, type SubordinateReportStatus, type SubordinateRosterEntry,
  // Peer-agent teams (the agents tool's team deps contract)
  type PeersToolDeps, type PeerSpawnOutcome, type PeerSendOutcome,
  type EnqueueTurnResult,
  slugifyName,
  readSoul, readMission, summarizeSoul, writeSoul,
  // Automatic workspace titling (first turn + legacy slug heal)
  applyWorkspaceTitle, isPlaceholderMission, isPlaceholderWorkspaceTitle, parseWorkspaceTitle,
  WORKSPACE_TITLE_SYSTEM_PROMPT, workspaceTitlePrompt,
  // Device shadow-git checkpoints (forwarded to the pc-agent daemon)
  isDeviceNotConnectedError,
  type CheckpointAvailability, type FileCheckpointEntry, type FileRestorePlan, type FileRestoreResult,
  // Shared turn lifecycle
  snapshotCompletedTurn,
  spillEventContent,
  type DynamicApproval,
  type MissingCapability,
  type DynamicContext,
  type DynamicDelegate,
  // Ingress — core owns the gates; this actor owns the transports in front
  // of them (the DO alarm, the Worker's webhook + email routes, cross-DO RPC).
  acceptWebhookDelivery, registerDurableWebhook, createWebhookSecretStore,
  initWebhookRateLimitTables,
  type WebhookDelivery, type WebhookDeliveryResult, type WebhookSecretStore,
  createTimerTrigger, cancelTrigger, listTriggers, fireDueTriggers,
  EmailInbox, planOwnerNotification, readEmailAllowlist, setEmailAllowlist,
  type EmailAdmission, type IncomingEmail, type OwnerNotification,
  receiveSubordinateEvent,
  PeerHub, type PeerMessage, type ReceiveResult,
  // ── Read models: the folds a surface asks for, one implementation each ──
  getAgentStatus, getChatHistory, getToolList, readLatestSearchTree, readSearchTree,
  listForkRuns, type ForkRunSummary,
  buildPendingActions, type PendingAction,
  type ChatHistoryEntry,
  getRunTimeline, type TimelineSpan,
  getRunEvents, getRunSummaries, listRuns, type RunListEntry, type RunSummary,
  getWorkspaceDiff, getExecutorDiff, resetWorkspaceBaseline,
  type ExecutorDiffResult, type WorkspaceDiffResult,
  diffLines, type DiffLine,
  getExecutorFiles, readExecutorFile, writeExecutorFileOp, listEnvironments,
  type DirEntry, type ExecutorWriteResult,
  cancelBackgroundJob, cancelCurrentWork, clearBackgroundJobs, dismissBackgroundJob,
  jobResult, listBackgroundJobs, retryBackgroundJob,
  type CancelWorkOutcome, type RetryOutcome,
  getAlwaysActiveSkills, getEvolutionConfig, getMctsConfig, getReasoningEffort,
  getShellApprovalMode, getStoredModelSpec, setAlwaysActiveSkills, setEvolutionConfig,
  setMctsConfig, setModel, setReasoningEffort, setShellApprovalMode,
  type EvolutionConfigView, type MctsConfigView,
  getEvolutionChangelog, getUnseenChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
} from "@proteus/core";
import { ActorAgent, type ActorToolDeps } from "./actor-agent.js";
import { resolveEnsembleJudgeSelection } from "./providers/judge-model.js";
import { SubordinateAgent } from "./subordinate-agent.js";
import {
  SubordinateRosterStore,
  admitSubordinateReport,
  createTeamToolDeps,
  normalizeReportContent,
  parentAdmitsSubordinateReport,
  type SubordinateReportOrigin,
  type SubordinatesChangedEvent,
  createAgentSelfProvider,
  createReleaseCodemodeProvider,
  DeviceConsentRegistry,
  type DeviceConsentAnswer, type DeviceConsentDecision,
  type DeviceConsentRequest, type PendingDeviceConsent,
  DeferredApprovalQueue, DeferredApprovalStore,
  type DeferredApproval, type DeferredApprovalAnswer, type DeferredApprovalChannel,
  type DeferredApprovalNotice,
} from "@proteus/core";
import type { CodemodeProvider, MctsSearchRunSummary } from "@proteus/core";
import { createCloudWorkspaceForUser } from "./user/workspace-create.js";
import { agentEmailAddress } from "./email/inbound.js";
import {
  createEmailThreadDispatcher, dispatchEmailRepliesForTurn, sendOwnerEmail,
} from "./email/outbound.js";
import { EmailOutbox } from "./email/outbox.js";

const STALE_EVENT_DELIVERY_MS = 10 * 60 * 1000;

/** The one agents-SDK schedule row that carries every Proteus-owned wake
 *  (triggers, peer outbox, email outbox). Public because `Agent.schedule()`
 *  types the callback as `keyof this`, which excludes private members. */
const PROTEUS_TIMER_CALLBACK = '_proteusTimerTick';

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

/** A caller-supplied row limit, clamped to [1, max]. */
function clampLimit(requested: number | undefined, max: number): number {
  if (!Number.isFinite(requested)) return max;
  return Math.min(Math.max(Math.floor(requested as number), 1), max);
}

function executorOutputIsError(output: string): boolean {
  const text = output.trim();
  if (!text) return false;
  return /^(error\b|exit\b|exec error:|read error:|write error:|list error:|delete error:|expose error:|unexpose error:|listports error:|runtime error:)/i.test(text);
}

export class OrchestratorAgent extends ActorAgent {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, ORCHESTRATOR_RPC_SURFACE);
  }

  override async onBeforeSubAgent(
    request: Request,
    child: { className: string; name: string },
  ): Promise<Request | Response | void> {
    if (child.className !== SubordinateAgent.name) {
      return new Response('Not found', { status: 404 });
    }
    const rosterEntry = this.subordinateRoster.get(child.name);
    if (!rosterEntry || rosterEntry.status === 'dismissed'
      || !this.hasSubAgent(child.className, child.name)) {
      return new Response('Not found', { status: 404 });
    }
    return request;
  }

  private async completeEventBatch(turnId: string, assistantText: string): Promise<boolean> {
    try {
      const replies = await dispatchEmailRepliesForTurn(
        { log: this.eventLog, replies: this.replyChannels },
        turnId, assistantText, Date.now(),
      );
      if (replies.pending) {
        console.warn(`[proteus] event reply remains pending for ${turnId}; keeping delivery lease open`);
        return false;
      }
      this.eventLog.markTurnCompleted(turnId);
      return true;
    } catch (err) {
      console.warn('[proteus] event reply dispatch failed:', err);
      return false;
    }
  }

  private _engine: EvolutionEngine | null = null;
  private _subordinateRoster: SubordinateRosterStore | null = null;
  private _emailOutbox: EmailOutbox | null = null;

  private get subordinateRoster(): SubordinateRosterStore {
    if (!this._subordinateRoster) {
      this._subordinateRoster = new SubordinateRosterStore(this.ctx.storage.sql);
      this._subordinateRoster.ensureSchema();
    }
    return this._subordinateRoster;
  }

  /** Outbound-email intent log: write-ahead + idempotency for mission-inbox
   *  replies and owner notifications (SPEC §7.4). */
  private get emailOutbox(): EmailOutbox {
    if (!this._emailOutbox) {
      this._emailOutbox = new EmailOutbox(this.ctx.storage.sql, (at) => this.scheduleTimerAt(at));
      this._emailOutbox.ensureSchema();
    }
    return this._emailOutbox;
  }

  /** The orchestrator's half of the per-step dynamic context: the delegates it
   *  alone can have (spawned subordinates, listed before the forked head runs
   *  the base class contributes) and the decisions parked on the user. */
  protected override dynamicContextSnapshot(): DynamicContext {
    const base = super.dynamicContextSnapshot();
    const subordinates: DynamicDelegate[] = this.subordinateRoster.list().map((entry) => ({
      kind: 'subordinate' as const,
      name: entry.name,
      phase: entry.status,
      task: entry.currentTask,
    }));
    const deafInbox = this.emailInbox.dropNotice(Date.now());
    return {
      ...base,
      delegates: [...subordinates, ...(base.delegates ?? [])],
      // Both kinds of decision parked on the human, in one roster: a consent
      // prompt someone may still answer in the next minutes, and a command
      // parked for hours. The second is also the structural reminder that its
      // effect has NOT happened — restated on every step until it is decided.
      approvals: [...this._consents.approvals(), ...this.deferrals.approvals()],
      ...(deafInbox ? { missingCapabilities: [...(base.missingCapabilities ?? []), deafInbox] } : {}),
    };
  }


  private broadcastSubordinatesChanged(event?: SubordinatesChangedEvent): void {
    try {
      this.broadcast(JSON.stringify(event ?? {
        type: 'subordinates_changed',
        subordinates: this.subordinateRoster.list(),
      }));
    } catch { /* no connected clients */ }
  }

  private broadcastSubordinateEvent(
    event: Omit<SubordinateActivityEvent, 'type' | 'id'> & { id?: string },
  ): void {
    try {
      this.broadcast(JSON.stringify({
        type: 'subordinate_event',
        id: event.id ?? nanoid(),
        kind: event.kind,
        subordinate: event.subordinate,
        ...(event.status ? { status: event.status } : {}),
        content: event.content,
        ...(event.task ? { task: event.task } : {}),
        timestamp: event.timestamp,
      } satisfies SubordinateActivityEvent));
    } catch { /* no connected clients */ }
  }
  /** /workspace backups are debounced via the persisted last-backup time +
   *  this optimistic gate. Restore happens lazily in the sandbox handle on
   *  first actual sandbox use, not at turn startup. */
  private _lastWorkspaceBackupAt = 0;
  /** Turns of new execution traces since the last auto-GEPA pass (in-memory
   *  cadence; resets on eviction, which just delays the next pass slightly). */
  private _turnsSinceGepa = 0;
  // Session-reflection cadence (_sessionTurnCount/Turns/StartedAt) now lives on
  // the core AgentOrchestrator; read the turn index via this.orch.sessionTurnIndex.

  // Steer-as-Branch redirects launched against the in-flight turn — each runs
  // as one budgeted head (ExplorationAgent Facet) and settles into Alternate
  // Takes when the turn completes (onChatResponse).
  private _pendingBranches: PendingBranch[] = [];

  private _triggerRegistry: import('@proteus/core').TriggerRegistry | null = null;
  private _replyChannels: import('@proteus/core').ReplyChannelStore | null = null;
  /** Per-activation guard so the full table-init DDL runs once, not on every
   *  onStart + claimOwner. Resets on DO eviction, so a cold start always
   *  re-creates any newly-added tables (no schema-version bookkeeping). */
  private _schemaReady = false;

  protected get triggerRegistry(): TriggerRegistry {
    if (!this._triggerRegistry) {
      const orchestrator = this;
      const alarmScheduler: AlarmScheduler = {
        // Idempotent: pick the soonest of (existing alarm, new ts).
        scheduleAt(ts: number) { orchestrator.scheduleTimerAt(ts); },
        currentAlarm(): number | null { return null; },
      };
      this._triggerRegistry = new TriggerRegistry(this.ctx.storage.sql, alarmScheduler);
    }
    return this._triggerRegistry;
  }
  protected get replyChannels(): ReplyChannelStore {
    if (!this._replyChannels) {
      const orchestrator = this;
      // ws_session dispatcher: push the reply back through Think's chat
      // broadcast. The reply() tool's content becomes a synthetic assistant
      // message visible to connected WS clients.
      const wsDispatcher: ReplyDispatcher = {
        async dispatch(_channel: ReplyChannelRow, payload: unknown) {
          try {
            const text = typeof payload === 'string'
              ? payload
              : JSON.stringify((payload as { content?: unknown })?.content ?? payload);
            const broadcast = (orchestrator as unknown as {
              broadcastChatMessage?: (msg: {
                role: 'assistant';
                parts: Array<{ type: 'text'; text: string }>;
              }) => Promise<void> | void;
            }).broadcastChatMessage;
            if (broadcast) {
              await broadcast({
                role: 'assistant',
                parts: [{ type: 'text', text }],
              });
              return { delivered: true };
            }
            return { delivered: false, detail: 'no broadcast channel' };
          } catch (err) {
            return { delivered: false, detail: (err as Error).message };
          }
        },
      };
      // email_thread dispatcher: a drained email turn's answer goes back onto
      // the inbound mail's thread via the send_email binding. Context resolves
      // per dispatch so binding/display-name changes never go stale.
      const emailDispatcher = createEmailThreadDispatcher(() => ({
        email: orchestrator.env.EMAIL,
        agentDisplayName: orchestrator.safeDisplayName(),
        outbox: orchestrator.emailOutbox,
      }));
      this._replyChannels = new ReplyChannelStore(this.ctx.storage.sql, {
        ws_session: wsDispatcher,
        // peer_back: route the answer to a peer ask back over the outbox
        // transport. Lazily bound — PeerHub needs this store to construct.
        peer_back: {
          dispatch: (channel, payload) => orchestrator.peerHub.dispatchPeerBack(channel, payload),
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
  // Sender: peer_outbox rows dispatched via DO RPC (inline + alarm retry).
  // Receiver: the receivePeerMessage cross-DO RPC below. The agents tool's
  // ask/send/reply actions ride this hub; spawn adds the create-agent path.
  private _peerHub: PeerHub | null = null;
  protected get peerHub(): PeerHub {
    if (!this._peerHub) {
      const orchestrator = this;
      this._peerHub = new PeerHub({
        sql: this.ctx.storage.sql,
        log: this.eventLog,
        replyChannels: this.replyChannels,
        vfs: () => orchestrator.rt.storage.vfs,
        selfAgentName: () => orchestrator.name,
        selfUserId: () => {
          const userId = orchestrator.getOwnerUserId();
          if (!userId) throw new Error('Agent has no owner yet — peer messaging needs an owned agent.');
          return userId;
        },
        deliver: async (receiverAgentName, msg) => {
          const stub = orchestrator.env.OrchestratorAgent.get(
            orchestrator.env.OrchestratorAgent.idFromName(receiverAgentName),
          ) as DurableObjectStub<OrchestratorAgent>;
          return await stub.receivePeerMessage(msg);
        },
        isSameOwner: async (senderUserId) => senderUserId === orchestrator.getOwnerUserId(),
        hasGrant: async (senderAgentName, senderUserId) => {
          try {
            const { stub, caller } = await orchestrator.userHub();
            return await stub.hasPeerGrant(caller, senderAgentName, senderUserId);
          } catch (err) {
            console.warn('[proteus] hasPeerGrant lookup failed:', (err as Error).message);
            return false;   // default deny on lookup failure
          }
        },
        scheduleDispatch: (at) => orchestrator.scheduleTimerAt(at),
        onAdmitted: () => { orchestrator.orch.scheduleDrain(); },
      });
    }
    return this._peerHub;
  }

  /** Idempotent soonest-wins arm of Proteus's own wake-up, expressed as the
   *  agents-SDK schedule row `PROTEUS_TIMER_CALLBACK`. A Durable Object has a
   *  single alarm slot and the SDK owns it (`_scheduleNextAlarm` deletes any
   *  alarm it does not recognise), so this must never call `setAlarm` itself.
   *  Fire-and-forget by interface (`AlarmScheduler.scheduleAt`); the storage
   *  write is held open with `waitUntil` so it lands even if the caller's
   *  invocation ends first. */
  private scheduleTimerAt(ts: number): void {
    this.ctx.waitUntil(this.armTimer(ts).catch((err: unknown) => {
      console.error('[proteus] timer arm failed:', (err as Error).message);
    }));
  }

  /** Reconcile the timer row to fire at or before `atMs`, collapsing onto
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
      .filter((row) => row.callback === PROTEUS_TIMER_CALLBACK && row.time > nowSec);
    const desired = Math.min(targetSec, ...armed.map((row) => row.time));
    if (armed.length === 1 && armed[0].time === desired) return;
    for (const row of armed) await this.cancelSchedule(row.id);
    await this.schedule(new Date(desired * 1000), PROTEUS_TIMER_CALLBACK);
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
      console.warn(`[proteus] dropped ${dropped} unrunnable schedule row(s) overdue by more than ${STALE_SCHEDULE_HORIZON_MS}ms`);
    }
  }

  protected get engine(): EvolutionEngine {
    if (!this._engine) {
      this._engine = new EvolutionEngine(this.rt, {
        enabled: true,
        // The same sink an agent-initiated fork(settle=mcts) uses — one
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

  /** Install the capability token the UserDO minted for this workspace, then
   *  push it to every live subordinate. Facets present the PARENT workspace's
   *  identity, so the token is pushed to them rather than read back out of this
   *  DO — nothing name-addressable ever hands the secret to a caller. */
  override async installWorkspaceCapability(token: string): Promise<{ ok: true }> {
    this.ensureSchema();
    const result = await super.installWorkspaceCapability(token);
    for (const entry of this.subordinateRoster.list()) {
      try {
        const stub = await this.subAgent(SubordinateAgent, entry.name);
        await stub.installWorkspaceCapability(token);
      } catch (err) {
        console.warn(`[proteus] capability push to subordinate ${entry.name} failed:`, (err as Error).message);
      }
    }
    return result;
  }

  /** Read the owner userId from workspace_identity; '' (empty) means unclaimed. */
  protected getOwnerUserId(): string | null {
    try {
      const rows = this.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM workspace_identity LIMIT 1`;
      const v = rows[0]?.owner_user_id;
      return v && v !== '' ? v : null;
    } catch { return null; }
  }

  /** The agents tool's peer deps over the cross-workspace transport. Owner
   *  resolution is lazy inside each action (the toolset is cached across
   *  turns — including a pre-claim build — so deps must not capture owner
   *  state at construction). */
  private getPeersToolDeps(): PeersToolDeps {
    const orchestrator = this;
    const requireOwner = () => {
      const userId = orchestrator.getOwnerUserId();
      if (!userId) throw new Error('Agent has no owner yet — peer messaging needs an owned agent.');
      return userId;
    };
    /** Same-owner roster check so a typo'd name errors clearly instead of
     *  materializing a fresh unowned DO that rejects the message. */
    const requirePeer = async (agent: string): Promise<void> => {
      requireOwner();
      if (agent === orchestrator.name) throw new Error('that is this agent — pick another peer (action:"list")');
      const { stub, caller } = await orchestrator.userHub();
      const known = await stub.hasWorkspace(caller, agent);
      if (!known) throw new Error(`unknown peer "${agent}" — list your team with action:"list"`);
    };
    return {
      listPeers: async () => {
        requireOwner();
        const { stub, caller } = await orchestrator.userHub();
        return teamPeers(orchestrator.name, await stub.listWorkspaces(caller));
      },
      ask: async ({ agent, topic, message, timeoutMs }) => {
        await requirePeer(agent);
        return orchestrator.peerHub.ask({ agent, userId: requireOwner(), topic, message, timeoutMs });
      },
      send: async ({ agent, topic, message }) => {
        await requirePeer(agent);
        return orchestrator.peerHub.send({ agent, userId: requireOwner(), topic, message });
      },
      reply: async ({ eventId, message }) => orchestrator.peerHub.reply({ eventId, message }),
      spawnWorkspace: async ({ name, purpose, message, timeoutMs }): Promise<PeerSpawnOutcome> => {
        const userId = requireOwner();
        const { stub: userDO, caller } = await orchestrator.userHub();
        let agentName = name;
        let created = false;
        if (!agentName || !(await userDO.hasWorkspace(caller, agentName))) {
          const entry = await createCloudWorkspaceForUser(orchestrator.env, userId, userDO, caller, {
            ...(agentName ? { name: agentName } : {}),
            purpose,
          });
          agentName = entry.name;
          created = true;
        }
        const outcome = await orchestrator.peerHub.ask({
          agent: agentName, userId, topic: 'task', message, timeoutMs,
        });
        return { agent: agentName, created, ...outcome };
      },
    };
  }

  private getTeamToolDeps(): TeamToolDeps {
    const orchestrator = this;
    return createTeamToolDeps({
      roster: this.subordinateRoster,
      now: () => Date.now(),
      inheritedContext: () => orchestrator.readInheritedContext(),
      createName: (role) => {
        const base = slugifyName(role).slice(0, 48) || 'subordinate';
        return `${base}-${nanoid(6)}`;
      },
      broadcast: (event) => orchestrator.broadcastSubordinatesChanged(event),
      broadcastTask: (event) => orchestrator.broadcastSubordinateEvent({
        kind: 'task',
        ...event,
      }),
      runtime: {
        async spawn(input) {
          const ownerUserId = orchestrator.getOwnerUserId();
          if (!ownerUserId) throw new Error('Agent has no owner yet — subordinate creation needs an owned workspace.');
          const stub = await orchestrator.subAgent(SubordinateAgent, input.name);
          const capabilityToken = await orchestrator.workspaceCapabilityToken();
          try {
            await stub.setSubordinateIdentity({
              name: input.name,
              displayName: input.displayName,
              role: input.role,
              mission: input.mission,
              ...(input.model ? { model: input.model } : {}),
              ...(capabilityToken ? { capabilityToken } : {}),
            });
          } catch (error) {
            await orchestrator.deleteSubAgent(SubordinateAgent, input.name).catch(() => {});
            throw error;
          }
        },
        async assign(name, input) {
          const stub = await orchestrator.subAgent(SubordinateAgent, name);
          return stub.enqueueSubordinateTask({
            kind: 'task',
            body: input.body,
            ...(input.deliverable ? { deliverable: input.deliverable } : {}),
            ...(input.deadlineHint ? { deadlineHint: input.deadlineHint } : {}),
            ...(input.inheritedContext ? { inheritedContext: input.inheritedContext } : {}),
          });
        },
        async status(name) {
          return (await orchestrator.subAgent(SubordinateAgent, name)).getSubordinateStatus();
        },
        async message(name, content) {
          return (await orchestrator.subAgent(SubordinateAgent, name))
            .enqueueSubordinateTask({ kind: 'message', body: content });
        },
        async dismiss(name, keepHistory) {
          if (!keepHistory) await orchestrator.deleteSubAgent(SubordinateAgent, name);
        },
      },
    });
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
  async experienceAction(input: ExperienceActionInput): Promise<Record<string, unknown>> {
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
      team: this.getTeamToolDeps(),
      releases: this.getReleaseToolDeps(),
      peers: this.getPeersToolDeps(),
    };
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
      console.error('[orchestrator] claimOwner ensureSchema failed:', (err as Error).message);
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
        this.sql`
          INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
          VALUES (${this.ctx.id.toString()}, ${this.name}, ${userId}, ${Date.now()})
        `;
      } else {
        this.sql`UPDATE workspace_identity SET owner_user_id = ${userId}`;
      }
      this.invalidateModelCaches();
      return { owner: userId, capabilityHash };
    }
    if (current !== userId) {
      throw new Error(`Agent owned by a different user (stored=${current.slice(0, 8)}…, caller=${userId.slice(0, 8)}…)`);
    }
    return { owner: current, capabilityHash };
  }

  /** Snapshot /workspace to R2 if the agent used the sandbox this turn and the
   *  debounce window elapsed. Fire-and-forget (never blocks the turn loop); the
   *  handle is persisted only on success, so a failed backup keeps the last good
   *  snapshot. */
  private backupWorkspaceIfDue(): void {
    const handle = this.rt.sandboxHandle;
    if (!handle) return;
    const now = Date.now();
    const lastAt = Math.max(this._lastWorkspaceBackupAt, this.config.getWorkspaceBackupAt());
    if (!shouldBackupWorkspace(this._executorsUsedThisTurn.has('sandbox'), lastAt, now)) return;
    this._lastWorkspaceBackupAt = now;          // optimistic gate (concurrency within activation)
    void handle.createBackup(workspaceBackupOptions())
      .then((b) => this.config.setWorkspaceBackup(b))
      .catch((err) => console.warn('[proteus] workspace backup failed:', (err as Error).message));
  }

  // The reactor (drain-then-stop) now lives on the core AgentOrchestrator
  // (it binds selected pending events via markConsumed, then injects one
  // signal through the core delivery seam). Ingress paths use
  // the debounced `this.orch.scheduleDrain()`; the post-turn hook drains
  // immediately via `this.orch.drainPendingEvents()`.

  async onChatResponse(result: ChatResponseResult) {
    // The actor-generic settle spine lives on ActorAgent; everything after it
    // here is orchestrator sequencing (takes, branches, evolution, naming).
    const { drainTurnId, programmaticUserMessage, errorText, completed, injectedSignals } =
      this.settleTurnEvents(result);
    this.recordTurnTelemetry(result, { errorText, completed, programmaticUserMessage });
    if (result.status !== "completed") {
      // An aborted/errored live turn leaves nothing to compare a branch
      // against — and any takes its think-mcts runs captured competed for an
      // answer that no longer exists, so the next turn must not claim them.
      try { purgeUnclaimedAlternateTakes(this.boundSql); } catch { /* no takes table yet */ }
      this.settlePendingBranches(null, '');
      return;
    }

    const userMessages = this.messages.filter(m => m.role === "user");
    const lastUserMsg = programmaticUserMessage ?? userMessages[userMessages.length - 1];
    const userText = lastUserMsg?.parts
      ?.filter(p => p.type === "text")
      .map(p => (p as { type: "text"; text: string }).text)
      .join("") ?? "";

    const assistantText = result.message.parts
      ?.filter(p => p.type === "text")
      .map(p => (p as { type: "text"; text: string }).text)
      .join("") ?? "";

    // Extension seam: the turn settled and was durably persisted — the same
    // onTurnEnd contract runChat fires on the CLI (final text + the turn's
    // response messages in ModelMessage shape).
    await this.extensions.emitTurnEnd({
      text: assistantText,
      responseMessages: await convertToModelMessages([result.message], { ignoreIncompleteToolCalls: true }),
    });

    // Persist the completed turn into the `messages` table (session_id='default')
    // so the fork feature has a durable row to cut against. AIChatAgent's
    // in-memory this.messages is the chat UI's source of truth, but only
    // session_id='default' rows are copied on fork. This mirror is cheap
    // (two rows per turn) and idempotent (INSERT OR IGNORE on id).
    try {
      if (lastUserMsg?.id) {
        const userCreatedAt = (() => {
          const ts = (lastUserMsg as { createdAt?: string | number | Date }).createdAt;
          if (typeof ts === "number") return ts;
          if (typeof ts === "string") { const p = Date.parse(ts); if (!Number.isNaN(p)) return p; }
          if (ts instanceof Date) return ts.getTime();
          return this.acc.startedAt || Date.now();
        })();
        this.sql`INSERT OR IGNORE INTO messages (id, session_id, parent_id, role, content, created_at)
                 VALUES (${lastUserMsg.id}, ${'default'}, ${null}, ${'user'}, ${userText}, ${userCreatedAt})`;
      }
      if (result.message.id) {
        this.sql`INSERT OR IGNORE INTO messages (id, session_id, parent_id, role, content, created_at)
                 VALUES (${result.message.id}, ${'default'}, ${lastUserMsg?.id ?? null}, ${'assistant'}, ${assistantText}, ${Date.now()})`;
      }
    } catch (err) {
      console.warn("[proteus] mirror-to-messages failed:", err);
    }

    // Record which crafted tools this turn used, keyed by the assistant
    // message id, so async thumbs feedback (setTurnFeedback) can re-score
    // exactly those tools. Feedback is inherently asynchronous — it arrives
    // after the turn completes — so turn.feedback is null here; the outcome
    // review (engine.reviewTurn, dispatched when the NEXT user message
    // arrives) populates it from explicit thumbs or the follow-up classifier.
    const msgId = (result.message as { id?: string } | null | undefined)?.id;
    if (!msgId) {
      // Completed but unattributable — without a message id the takes cannot
      // credit this turn, and they must not leak into the next one's claim.
      try { purgeUnclaimedAlternateTakes(this.boundSql); } catch { /* no takes table yet */ }
    }
    if (msgId) {
      // Alternate Takes captured during this turn's think-mcts runs get the
      // turn id they competed for, so a pick can credit the right turn.
      try {
        claimAlternateTakesForTurn(this.boundSql, {
          turnId: msgId, sessionId: 'default', startedAt: this.acc.startedAt,
        });
      } catch { /* no takes table yet — the first MCTS run creates it */ }
      // The crafted tools this turn called, as the in-episode craft clock saw
      // them. Not "every tool name that is not built in": a crafted tool is
      // codemode-only and never appears as a tool-call name, so that filter
      // only ever matched MCP and extension tools — and the thumbs re-score
      // below reads this row to write craft_scores.
      const craftNames = this.acc.craftedToolsUsed();
      if (craftNames.length > 0) {
        this.sql`INSERT INTO turn_craft_usage (message_id, tool_names, created_at)
                 VALUES (${msgId}, ${JSON.stringify(craftNames)}, ${Date.now()})
                 ON CONFLICT(message_id) DO UPDATE SET
                   tool_names = excluded.tool_names, created_at = excluded.created_at`;
      }
    }

    // Steer-as-Branch redirects launched during this turn settle against its
    // answer — detached, so a slow branch never blocks the TurnQueue.
    this.settlePendingBranches(msgId ?? null, assistantText);

    // Mission Inbox: a turn injected by the event drain carries the synthetic
    // turn id its events were bound to — reply their open email_thread
    // channels with this turn's answer (threaded outbound email). Detached.
    if (typeof drainTurnId === 'string') {
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

    // Persist /workspace to R2 if the agent used the sandbox this turn — so the
    // work survives the container sleeping. Debounced + fire-and-forget.
    this.backupWorkspaceIfDue();

    // Trace-driven continuous self-optimization (when enabled): run GEPA once
    // enough new turns have accrued. Fire-and-forget; no-op when disabled.
    this.maybeRunAutoGepa();

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
      const { runSleepTimeCompute, applySleepTimeUpdate } = await import('@proteus/core');
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
      console.log(
        `[proteus] sleep-time-compute: upserted=${summary.upserted} decayed=${summary.decayed} skipped=${summary.skipped}`,
      );
    } catch (err) {
      console.warn('[proteus] sleep-time-compute failed:', err instanceof Error ? err.message : err);
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
      if (title) console.log(`[proteus] auto-titled workspace → "${title}"`);
    } catch (err) {
      console.warn('[proteus] workspace titling failed:', err instanceof Error ? err.message : err);
    }
  }

  /** The shared workspace-naming round-trip (same prompt and parser the create
   *  path uses), against this workspace's review model. */
  private async suggestWorkspaceTitle(mission: string): Promise<string | null> {
    const { text } = await generateText({
      model: await this.getModelForReview(),
      system: WORKSPACE_TITLE_SYSTEM_PROMPT,
      prompt: workspaceTitlePrompt(mission),
      // No output cap: reasoning models spend their budget thinking before the
      // JSON, and a cap starves them into empty text.
      ...effortFor('judge'),
    });
    return parseWorkspaceTitle(text);
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
        console.warn('[proteus] propagateDisplayName roster sync failed:', err instanceof Error ? err.message : err);
      }
    }
    try { this.broadcast(JSON.stringify({ type: 'workspace_renamed', displayName })); } catch { /* nop */ }
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
      rawTools: () => this.getRawTools(),
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

  @callable()
  async cancelCurrentWork(): Promise<CancelWorkOutcome> {
    return cancelCurrentWork({
      jobRunner: this.jobRunner,
      activeToolControllers: this._activeToolControllers,
      broadcast: (payload) => this.broadcast(payload),
      onCancelled: ({ cancelledJobs, abortedTools }) => {
        this._inFlight = false;
        this.logActivity('work_cancelled', `${abortedTools} foreground, ${cancelledJobs.length} background`);
      },
    });
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
        try {
          this.broadcast(JSON.stringify({
            type: 'device_consent',
            consentId: consent.consentId,
            deviceId: consent.deviceId,
            deviceLabel: consent.deviceLabel,
            method: consent.method,
            command: consent.command,
            scope: consent.scope,
          }));
        } catch { /* no connected clients */ }
        return;
      }
      try {
        this.broadcast(JSON.stringify({ type: 'device_consent_resolved', consentId: notice.consentId }));
      } catch { /* no connected clients */ }
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
    try { this.broadcast(JSON.stringify({ type: 'pending_actions_changed' })); }
    catch { /* no connected clients */ }
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
  private ensureSchema(): void {
    if (this._schemaReady) return;
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);

    // Every table a workspace has, on any backend — one list, in core.
    initWorkspaceSchema({ execRaw, sql: this.boundSql, exec: this.ctx.storage.sql });

    // ── planes this root alone carries (declared per-root in
    //    core/conformance/manifest.ts, observed against sqlite_master) ──
    initWebhookRateLimitTables(this.ctx.storage.sql);
    this.subordinateRoster.ensureSchema();

    // Workspace-diff baseline (path → content snapshot) for the Output surface's
    // cumulative change-set. Captured lazily / re-markable via resetWorkspaceBaseline.
    execRaw(`CREATE TABLE IF NOT EXISTS vfs_baseline (path TEXT PRIMARY KEY, content TEXT)`);

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

  async onStart() {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    this.ensureSchema();
    // Runs inside `Agent.alarm()`'s initialization, i.e. before the SDK reads
    // the due rows — so a backlog is pruned rather than dispatched in one go.
    try {
      this.sweepUnrunnableSchedules();
    } catch (err) {
      console.warn('[proteus] stale schedule sweep failed:', (err as Error).message);
    }
    let reconciledEventIds: string[] = [];
    try {
      reconciledEventIds = this.eventLog.unbindStale(STALE_EVENT_DELIVERY_MS);
    } catch (err) {
      console.warn('[proteus] startup event reconciliation failed:', err);
    }

    // one-time per-agent migration that merges case-collision
    // duplicates in crafted_tools + craft_scores left over from older
    // code that lowercased names. Gated by _v2_codegen_migration_done.
    try {
      // Wrap `this.sql` in a closure that preserves the `this` binding.
      // `.bind()` produces a function whose `this` is the agent, but the
      // agents SDK sql method dereferences `this.ctx` which loses the
      // Think-class this somehow when routed through the bound function;
      // a direct closure side-steps that.
      const agent = this;
      const sqlForMigration = ((strings: TemplateStringsArray, ...values: unknown[]) =>
        agent.sql(strings, ...values as Parameters<typeof agent.sql>[1][])
      ) as unknown as Parameters<typeof migrateCraftedToolDuplicates>[0];
      const report = migrateCraftedToolDuplicates(sqlForMigration, execRaw);
      if (report.ranMigration && report.mergedGroups > 0) {
        console.log(
          `[proteus] duplicate migration: merged ${report.mergedGroups} group(s), ` +
          `deleted ${report.rowsDeletedCraftedTools} crafted_tools rows, ` +
          `${report.rowsDeletedCraftScores} craft_scores rows`,
        );
        for (const d of report.details) {
          console.log(`  - ${d.lowerName}: kept "${d.kept}", dropped [${d.dropped.join(', ')}]`);
        }
      }
    } catch (err) {
      console.error("[proteus] duplicate migration failed:", err);
    }

    try {
      const identity = this.sql<{ id: string }>`SELECT id FROM workspace_identity LIMIT 1`;
      if (identity.length === 0) {
        this.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${this.ctx.id.toString()}, ${this.name}, ${Date.now()})`;
      }
      // Bootstrap scaffold if it doesn't exist — needed for scaffold mutation to work
      const scaffoldExists = await this.rt.identity.scaffold.exists();
      if (!scaffoldExists) {
        await bootstrapScaffold(this.rt);
        console.log("[proteus] Bootstrapped initial scaffold");
      }
    } catch (err) {
      console.error("[proteus] onStart init failed:", err);
    }
    if (reconciledEventIds.length > 0) {
      console.warn(`[proteus] startup event reconciliation re-pended ${reconciledEventIds.length} event(s)`);
      this.orch.scheduleDrain();
    }

    // Workspaces created before mission-derived titling still show their raw
    // slug. Title them from SOUL.md's mission the first time one is opened —
    // every other workspace is already titled, so it costs a config read.
    // Fire-and-forget: boot never waits on a model call.
    if (isPlaceholderWorkspaceTitle(this.config.getDisplayName(), this.name)) {
      void readSoul(this.rt.storage.vfs).then((soul) => this.maybeAutoTitleWorkspace(summarizeSoul(soul ?? '')));
    }
  }

  // ── Timer ingress ──────────────────────────────────────────────
  //
  // Proteus's own wake-up, dispatched by `Agent.alarm()` from the SDK's
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
  async _proteusTimerTick(): Promise<void> {
    const now = Date.now();
    try {
      // Wake the agent to act on the freshly-published timer events (and any
      // other pending events) — an autonomous turn, debounced so events
      // arriving alongside the alarm coalesce into it.
      const { fired } = fireDueTriggers({ registry: this.triggerRegistry, log: this.eventLog }, now);
      if (fired > 0) this.orch.scheduleDrain();
    } catch (err) {
      console.error('[proteus] alarm handler failed:', (err as Error).message);
    }

    // Re-drive pending outbound peer messages (crash/eviction recovery + the
    // exponential-backoff retry path — inline tool dispatch handles the happy
    // path, this alarm is the durable one).
    try {
      await this.peerHub.dispatchOutbox(now);
    } catch (err) {
      console.warn('[proteus] peer outbox dispatch failed:', (err as Error).message);
    }

    // Reconcile indeterminate outbound email: an intent left `pending` (crash
    // between the send and its status write) is safely re-driven here — the
    // stored Message-ID makes the re-send idempotent downstream (SPEC §7.4).
    try {
      if (this.env.EMAIL) await this.emailOutbox.reconcile(this.env.EMAIL, now);
    } catch (err) {
      console.warn('[proteus] email outbox reconcile failed:', (err as Error).message);
    }

    // Re-arm for the next-soonest wake (triggers ∪ peer-outbox ∪ email-outbox
    // retries). A due/past-due retry is clamped to `now` (see nextAlarmTime),
    // and the arm is soonest-wins so this never clobbers a sooner wake armed
    // during dispatch. Awaited, not fire-and-forget: this is the link that
    // keeps the timer chain alive.
    try {
      const next = nextAlarmTime(
        now,
        this.triggerRegistry.list({ state: 'active' }).map((t) => t.next_fire_at),
        this.peerHub.nextRetryAt(),
        this.emailOutbox.nextRetryAt(),
      );
      if (next !== null) await this.armTimer(next);
    } catch (err) {
      console.warn('[proteus] timer re-arm failed:', (err as Error).message);
    }
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
    if (decision === 'rejected') {
      try { await stub.transitionReleaseChange(caller, decided.changeId, 'rejected'); } catch { /* already terminal or stale */ }
    }
    return decided;
  }

  async getAgentStatus() {
    return getAgentStatus({
      sql: this.boundSql,
      vfs: this.rt.storage.vfs,
      config: this.config,
      fallbackId: this.ctx.id.toString(),
      name: this.name,
      displayName: this.getDisplayName(),
      // Before the first turn has been mirrored into `messages`, the in-memory
      // AIChatAgent array is the only count there is.
      fallbackMessageCount: this.messages.length,
    });
  }

  async getChatHistory(limit = 100): Promise<ChatHistoryEntry[]> {
    return getChatHistory(this.boundSql, limit);
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

  /** Every fork this workspace has run, newest first, whichever settle policy
   *  it chose — the one entry point the Exploration surface lists. Detail
   *  stays per-mechanism (`getSearchTree` for a competition, `getHeadRuns`
   *  for a merge); this is the list they are both reached from. */
  @callable() async listForkRuns(limit: number = 20): Promise<ForkRunSummary[]> {
    return listForkRuns(this.boundSql, limit);
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
   * A read that fails degrades to "nothing pending of that kind" rather than
   * failing the whole queue: a broken release hub must not hide a failed job.
   */
  @callable() async listPendingActions(): Promise<PendingAction[]> {
    const board = await this.getReleaseBoard(20).catch(() => null);
    // The unseen window itself, not the whole digest: the queue row needs the
    // count, the newest entry's time, and how many of those entries actually
    // offer keep/revert rather than being measurements to read.
    let unseen: ChangelogEntry[] = [];
    try { unseen = getUnseenChangelog(this.config, this.boundSql); }
    catch { /* a digest that will not assemble must not hide a failed job */ }
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

  @callable() async getMctsNodeDetail(nodeId: string) {
    type Row = {
      id: string; parent_id: string | null; depth: number; visits: number; value: number; status: string;
      action: string; task: string; observation: string; code_used: string | null;
      branch_agent_key: string | null; msg_id: string | null; created_at: number;
    };
    const readNode = (id: string): Row | null => this.sql<Row>`
      SELECT id, parent_id, depth, visits, value, status, action, task, observation,
             code_used, branch_agent_key, msg_id, created_at
      FROM search_nodes WHERE id = ${id} LIMIT 1`[0] ?? null;
    const row = readNode(nodeId);
    if (!row) return null;

    const summarize = (r: Row) => ({
      id: r.id,
      parentId: r.parent_id,
      depth: r.depth,
      visits: r.visits,
      value: r.value,
      status: r.status,
      action: r.action,
      createdAt: r.created_at,
    });

    const path = [];
    const seen = new Set<string>();
    let cursor: Row | null = row;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      path.unshift(summarize(cursor));
      cursor = cursor.parent_id ? readNode(cursor.parent_id) : null;
    }

    const children = this.sql<Row>`
      SELECT id, parent_id, depth, visits, value, status, action, task, observation,
             code_used, branch_agent_key, msg_id, created_at
      FROM search_nodes WHERE parent_id = ${nodeId}
      ORDER BY value DESC, visits DESC, created_at`;

    return {
      id: row.id,
      parentId: row.parent_id,
      depth: row.depth,
      visits: row.visits,
      value: row.value,
      status: row.status,
      action: row.action,
      task: row.task,
      observation: row.observation,
      codeUsed: row.code_used,
      branchAgentKey: row.branch_agent_key,
      msgId: row.msg_id,
      createdAt: row.created_at,
      path,
      children: children.map(summarize),
    };
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
  async markChangelogSeen(): Promise<{ ok: true; seenAt: number }> {
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
      try {
        this.sql`INSERT INTO evolution_events (type, message, created_at)
          VALUES ('reflection', ${`Operator reverted changelog entry ${id}: ${result.detail ?? 'done'}`}, ${Date.now()})`;
      } catch { /* event log is best-effort */ }
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
    const task = typeof text === 'string' ? text.trim() : '';
    if (!task) throw new Error('branchTurn requires the redirect text');
    if (!this._inFlight) {
      return { accepted: false, reason: 'No turn is running — send it as a normal message instead.' };
    }
    const runtime = this.getCFHeadRuntime();
    if (!runtime) {
      return { accepted: false, reason: 'Branching needs an agent owner (heads require UserDO access).' };
    }
    initAlternateTakesTable(this.rt.storage.execRaw);
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
    try { this.broadcast(JSON.stringify(event)); } catch { /* nop */ }
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
      console.warn('[proteus] event emit failed at applyScaffoldDecision:', err);
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
  async setShellApprovalMode(mode: 'strict' | 'allow_all' | 'deny_all'): Promise<{ ok: true; mode: ShellApprovalMode }> {
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

  /**
   * Pin a set of skills as always-active for this agent. Empty array clears
   * the pin. Operators use this from the Settings page; without an RPC the
   * only way to set `always_active_skills` is direct SQL, which the spec
   * explicitly wants to avoid.
   */
  @callable()
  async setAlwaysActiveSkills(names: string[]): Promise<{ ok: true; names: string[] }> {
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
      return await stub.deviceRpc(caller, 'checkpointStatus', []) as CheckpointAvailability;
    } catch (err) {
      if (isDeviceNotConnectedError(err)) {
        return { available: false, reason: 'no device connected — connect one with `proteus connect`' };
      }
      throw err;
    }
  }

  @callable()
  async listFileCheckpoints(limit = 50): Promise<FileCheckpointEntry[]> {
    if (!this.getOwnerUserDO()) return [];
    try {
      const { stub, caller } = await this.userHub();
      return await stub.deviceRpc(caller, 'checkpointList', [this.name, Math.max(1, Math.min(500, limit))]) as FileCheckpointEntry[];
    } catch (err) {
      if (isDeviceNotConnectedError(err)) return [];
      throw err;
    }
  }

  @callable()
  async planFileRestore(dir: string, id: string): Promise<FileRestorePlan> {
    const { stub, caller } = await this.userHub();
    return await stub.deviceRpc(caller, 'checkpointPlan', [this.name, dir, id]) as FileRestorePlan;
  }

  @callable()
  async restoreFileCheckpoint(dir: string, id: string): Promise<FileRestoreResult> {
    const { stub, caller } = await this.userHub();
    return await stub.deviceRpc(caller, 'checkpointRestore', [this.name, dir, id]) as FileRestoreResult;
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
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new Error('messageId must be a non-empty string');
    }
    if (feedback === null) {
      this.sql`DELETE FROM turn_feedback WHERE message_id = ${messageId}`;
      return { ok: true, messageId, feedback: null, rescored: 0 };
    }
    if (feedback !== 'positive' && feedback !== 'negative') {
      throw new Error(`feedback must be 'positive', 'negative', or null; got ${JSON.stringify(feedback)}`);
    }
    this.sql`INSERT INTO turn_feedback (message_id, feedback, created_at)
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
      const names = JSON.parse(usageRows[0].tool_names) as string[];
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
      console.warn('[proteus] applyExplicitFeedback failed:', err instanceof Error ? err.message : err);
    }
    return { ok: true, messageId, feedback, rescored };
  }

  /** All recorded feedback keyed by message id — one round-trip so the chat
   *  hydrates its thumbs marks on load instead of forgetting them. */
  @callable()
  async listTurnFeedback(): Promise<Record<string, 'positive' | 'negative'>> {
    try {
      const rows = this.sql<{ message_id: string; feedback: 'positive' | 'negative' }>`
        SELECT message_id, feedback FROM turn_feedback`;
      return Object.fromEntries(rows.map((r) => [r.message_id, r.feedback]));
    } catch {
      return {};
    }
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
    try { return listGepaRuns(this.boundSql, limit); }
    catch { return []; }
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
    const selection = await resolveEnsembleJudgeSelection({
      registry,
      specs: specs ?? null,
      chatSpec: this.getStoredModelId(),
    });
    return runEnsemble(this.boundSql, selection.specs.map((spec) => ({
      spec,
      llm: createCompletionLLM({ model: registry.resolveModel(spec), spec, stage: 'judge' }),
    })));
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
   * captured lazily on first call (returns empty + baselineJustCaptured) and
   * re-markable via resetWorkspaceBaseline ("mark reviewed").
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
    try { return this.headJournal.listRuns(limit); } catch { return []; }
  }

  /**
   * One page of this workspace's portable archive — the owner's own copy of
   * everything the workspace durably holds, in the same format the local
   * backend writes and `proteus import` reads.
   *
   * Paged because a workspace's SQLite (transcripts, run events, VFS blobs) has
   * no bounded size, and neither a DO response nor an isolate's memory should
   * have to hold all of it: the caller walks `next` until it is null and
   * appends each page's lines to a file. Owner-scoped by the RPC access table
   * ('interactive' — a scoped CI token is denied on every transport) on top of
   * the ownership check every workspace route already makes. Workspace
   * capability tiers do not gate it: this reads the workspace's own storage
   * for the owner who asked, and reaches nothing in the wider account.
   */
  @callable()
  async exportWorkspaceArchive(cursor?: unknown): Promise<ArchivePage> {
    return readWorkspaceArchivePage(this.ctx.storage.sql, {
      workspace: this.name,
      source: 'cloud',
      cursor: parseArchiveCursor(cursor),
    });
  }

  /** Tear down every per-agent resource, then wipe this Durable Object. Called
   *  by UserDO.removeWorkspace on delete so a same-name recreate starts clean and no
   *  orphaned alarm / container / triggers linger. Best-effort on the sandbox;
   *  the DO wipe (storage + alarm) always runs. Deliberately NOT @callable:
   *  destruction goes through UserDO's ownership check, never the raw websocket. */
  async destroyAgent(expectedOwnerUserId: string): Promise<{ ok: true }> {
    if (!/^[a-f0-9]{32}$/.test(expectedOwnerUserId)) throw new Error('invalid expected owner user id');
    const ownerUserId = this.getOwnerUserId();
    if (ownerUserId !== expectedOwnerUserId) throw new Error('Agent owner mismatch; refusing to destroy.');
    try {
      const sb = getSandbox(
        this.env.Sandbox as Parameters<typeof getSandbox>[0],
        `proteus-${this.name}`,
        { normalizeId: true },
      ) as unknown as { destroy(): Promise<unknown> };
      await sb.destroy();
    } catch (err) {
      console.warn('[proteus] destroyAgent: sandbox teardown failed:', err instanceof Error ? err.message : err);
    }
    // The R2 /workspace snapshot self-expires via the BACKUP_TTL lifecycle rule
    // on the bucket (there is no SDK deleteBackup and the key scheme is internal).
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
    try {
      return this.facts.recentTopK(limit).map((f) => ({
        key: f.key, value: f.value, confidence: f.confidence, source: f.source, lastObservedAt: f.lastObservedAt,
      }));
    } catch { return []; }
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

  /** List the agent's recent runs with their latest timestamp + event count. */
  async listRuns(limit: number = 50): Promise<RunListEntry[]> {
    return listRuns(this.eventRecorder, limit);
  }

  /**
   * Recent runs enriched with PROVENANCE (what kicked each off) + COST (tokens
   * spent) — the cross-run history + budget view for the Supervise altitude.
   * Folds the per-run run_start (caused_by/userMessage) and summed turn_end
   * tokenUsage out of the durable event log.
   */
  @callable()
  async getRunSummaries(limit: number = 30): Promise<RunSummary[]> {
    return getRunSummaries(this.eventRecorder, limit);
  }

  /**
   * The Activity surface: what the newest request cost, what it was made of,
   * and how the recent ones have behaved.
   *
   * The retained sample is the run-event log itself — `step_finish` rows are
   * durable and indexed by type, so the percentile has a real window without a
   * second store. `steps` bounds it, and the bound is reported back on the
   * result so the reader can see what the numbers are over.
   */
  @callable()
  async getActivitySnapshot(opts?: { steps?: number; logs?: number }): Promise<ActivitySnapshot> {
    const windowLimit = clampLimit(opts?.steps, ACTIVITY_STEP_WINDOW);
    const logLimit = clampLimit(opts?.logs, ACTIVITY_LOG_WINDOW);
    const events = this.eventRecorder.readRecentByType('step_finish', windowLimit);
    const steps = events.flatMap((e) => (e.type === 'step_finish' && e.usage ? [e] : []));
    const newest = steps[steps.length - 1];
    return {
      latest: newest?.usage
        ? {
          at: Date.parse(newest.timestamp) || Date.now(),
          runId: newest.runId,
          stepIndex: newest.stepIndex,
          usage: newest.usage,
          context: newest.context ?? null,
        }
        : null,
      // Null rather than a default: a share-of-window shown against a guessed
      // window would be a made-up percentage.
      contextWindow: this.sessionContextWindow() || null,
      telemetry: summarizeSteps(steps.map((e) => e.usage!), { windowLimit }),
      budgets: this.budget.snapshot(),
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
   *  reactor and background-job wake use. Not a new execution path. */
  async runTaskFromMcp(text: string): Promise<EnqueueTurnResult> {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) throw new Error('run_task requires non-empty text');
    const outcome = await this.orch.signals.deliver({
      kind: 'mcp', text: trimmed,
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
    try { return await this.rt.memory.read("memory/MEMORY.md") ?? ""; }
    catch { return ""; }
  }

  // ── Agent-authored views ───────────────────────────────────────
  // Two reads and nothing else. Publishing is `workspace.createView` inside
  // execute_tools; reverting is the Evolution Changelog, which is host chrome.
  // Neither of those belongs on a surface the rendered view can reach.

  /** The tabs to draw. Titles are agent-authored, so the UI marks them. */
  @callable() async listAgentViews(): Promise<AgentViewSummary[]> {
    try { return listViews(this.boundSql); }
    catch { return []; }
  }

  /** The spec for one tab. Re-validated in core against the live file, so a
   *  spec edited on disk after it was published fails here rather than in the
   *  browser. */
  @callable() async getAgentView(slug: string): Promise<ReadViewResult> {
    return readView({ vfs: this.rt.storage.vfs, sql: this.boundSql }, String(slug));
  }

  @callable() async getToolDescriptions() {
    // Descriptions sourced from @proteus/core/tools/registry — single truth.
    // Fixes F1 (tools.* → codemode.*) by virtue of the canonical source.

    // How a capability is REACHED, derived rather than declared: a tool is
    // native exactly when it is a key of the ToolSet the turn hands the model.
    // Anything else is reachable only from inside an execute_tools program.
    // Crafted tools are never ToolSet entries — buildCraftedToolSetFromExecute
    // routes them through createExecuteTool's providers — so they come out
    // codemode without a literal saying so, and a builtin that moves behind
    // codemode flips here on its own.
    const nativeNames = new Set(Object.keys(this.getRawTools()));
    const builtIn = BUILTIN_TOOLS.map(name => ({
      name,
      // Both registers, from the one spec: the headline a list row shows and
      // the docstring the model is given. The UI must never recover one from
      // the other by splitting text.
      summary: BUILTIN_TOOL_SPECS[name].summary,
      description: BUILTIN_TOOL_DESCRIPTIONS[name],
      exposure: (nativeNames.has(name) ? "native" : "codemode") as "native" | "codemode",
    }));
    const craftedRaw = this.rt.craftStore.list();
    const crafted = craftedRaw.map(t => {
      const scoreRow = this.sql<{ score: number; uses: number }>`
        SELECT score, uses FROM craft_scores WHERE tool_name = ${t.name} LIMIT 1`;
      return {
        name: t.name,
        description: t.description || "Crafted tool",
        isLearned: true,
        exposure: (nativeNames.has(t.name) ? "native" : "codemode") as "native" | "codemode",
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
  }> {
    return this.getTeamToolDeps().spawn({ role, mission, createdBy: 'user' });
  }

  @callable() async dismissSubordinate(name: string): Promise<{
    ok: true;
    name: string;
    historyKept: boolean;
  }> {
    return this.getTeamToolDeps().dismiss({ name });
  }

  async getExecutorOutput(executorId: string, limit: number = 50) {
    return this.sql`SELECT id, executor, command, stdout, stderr, exit_code, created_at
      FROM executor_output WHERE executor = ${executorId}
      ORDER BY created_at DESC LIMIT ${limit}`;
  }

  /**
   * One-round-trip initial load. Composes the per-surface read RPCs (status,
   * tools, memory, MCTS, timeline, executors + their recent output) into a
   * single payload, so the workspace first-paint is one WS call instead of
   * 6 + N. Each field is independently guarded so one failing read can't blank
   * the rest. Live updates still arrive via the granular refresh + events.
   */
  @callable()
  async getWorkspaceSnapshot() {
    const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
      try { return await p; } catch { return fallback; }
    };
    const [status, tools, memoryContent, mcts, timeline, executors] = await Promise.all([
      this.getAgentStatus(),
      safe(this.getToolDescriptions(), { builtIn: [], crafted: [], executors: [] }),
      this.getMemoryContent(),
      safe(this.getMctsTree(), [] as unknown[]),
      safe(this.getRunTimeline({ limit: 250 }), [] as TimelineSpan[]),
      safe(this.getExecutors(), []),
    ]);
    const executorOutputs = await Promise.all(
      executors.map(async (e) => ({
        name: e.name,
        outputs: await safe(this.getExecutorOutput(e.name, 50), [] as unknown[]),
      })),
    );
    const lastActiveExecutor = this.config.getLastActiveExecutor();
    return { status, tools, memoryContent, mcts, timeline, executors, executorOutputs, lastActiveExecutor };
  }

  @callable() async executeInExecutor(executorId: string, command: string) {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { error: `Executor "${executorId}" not found` };
    if (!provider.isAvailable()) return { error: `Executor "${executorId}" is not available` };

    const execTool = provider.tools.exec;
    if (!execTool) return { error: `Executor "${executorId}" has no exec tool` };

    try {
      const result = await execTool.execute(command);
      const stdout = typeof result === 'string' ? result : JSON.stringify(result);
      const isError = executorOutputIsError(stdout);

      this.sql`INSERT INTO executor_output (executor, command, stdout, stderr, exit_code)
        VALUES (${executorId}, ${command}, ${stdout}, ${isError ? stdout : ''}, ${isError ? 1 : 0})`;

      this.broadcast(JSON.stringify({
        type: 'executor-output', executor: executorId, command, stdout,
        stderr: isError ? stdout : '', exitCode: isError ? 1 : 0, timestamp: Date.now(),
      }));

      return { stdout, stderr: isError ? stdout : '', exitCode: isError ? 1 : 0 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.sql`INSERT INTO executor_output (executor, command, stderr, exit_code)
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
  @callable() async getExecutorFiles(executorId: string, path: string): Promise<{ entries?: DirEntry[]; error?: string }> {
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

  /**
   * Return the current list of exposed ports for a given executor. Powers
   * the auto-refreshing preview grid in the Executors tab. Sandbox returns
   * its active `exposePort(...)` registrations; other executors return [].
   */
  @callable() async getExposedPorts(executorId: string) {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { ports: [] as Array<{ port: number; name?: string; url?: string }> };
    const status = provider.getStatus?.();
    if (status && !status.active) return { ports: [] as Array<{ port: number; name?: string; url?: string }> };
    const listPorts = provider.tools.listPorts;
    if (!listPorts) return { ports: [] };
    try {
      const raw = await listPorts.execute();
      // sandbox.ts returns JSON-encoded text; parse defensively
      if (typeof raw === 'string') {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            return { ports: arr.map(p => ({
              port: Number(p.port),
              name: p.name,
              url: p.exposedUrl ?? p.url,
            })) };
          }
        } catch { /* fall through */ }
      }
      return { ports: Array.isArray(raw) ? raw : [] };
    } catch {
      return { ports: [] };
    }
  }

  /** The agent's current stored model spec. UI tells which menu entry to
   *  preselect; the full available-models list comes from /api/user/models
   *  (UserDO) so connections are user-scoped. */
  @callable() async getStoredModelSpec(): Promise<{ spec: string | null }> {
    return getStoredModelSpec(this.config);
  }

  @callable() async setModel(spec: string) {
    return setModel({
      config: this.config,
      normalize: (s) => this.providerRegistry().normalizeSpecSync(s),
      onChanged: () => this.invalidateModelCaches(),
    }, spec);
  }

  @callable() async getReasoningEffort(): Promise<{ effort: ReasoningEffort | null }> {
    return getReasoningEffort(this.config);
  }

  @callable() async setReasoningEffort(effort: unknown): Promise<{ ok: true; effort: ReasoningEffort }> {
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
    await writeSoul(this.rt.storage.vfs, this.boundSql, text);
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
    const ns = (this.env as unknown as {
      OrchestratorAgent: {
        idFromName(name: string): DurableObjectId;
        get(id: DurableObjectId): DurableObjectStub<OrchestratorAgent>;
      };
    }).OrchestratorAgent;
    const stubFor = (name: string) => ns.get(ns.idFromName(name));
    return {
      async occupied(name) {
        try {
          // A bare getAgentStatus on a fresh DO may create workspace_identity,
          // but it does not seed SOUL.md. An agent that exists has either chat
          // history or a SOUL.md written by the creation path.
          const status = await (stubFor(name) as unknown as {
            getAgentStatus(): Promise<{ messageCount: number; soul: string }>;
          }).getAgentStatus();
          return status.messageCount > 0 || status.soul.length > 0;
        } catch {
          // A transient RPC failure must not block a fork — the copy below
          // surfaces anything real.
          return false;
        }
      },
      async deliver(name, snapshot) {
        // The name rides along: a DO reached by cross-DO stub has not been
        // routed through the agent router, so it cannot read its own name.
        const result = await (stubFor(name) as unknown as {
          rawCopyFromFork(n: string, s: ForkSnapshot): Promise<{ ok: true; agentId: string }>;
        }).rawCopyFromFork(name, snapshot);
        return { workspaceId: result.agentId };
      },
    };
  }

  /**
   * Receive a fork snapshot from a source agent. INTERNAL — called only by the
   * source DO's fork transport via cross-DO stub. NOT @callable: cross-DO stub
   * RPC never needed the decorator, and this is a raw storage write that must
   * never be reachable over the public agents WS/HTTP transport.
   */
  async rawCopyFromFork(forkName: string, snapshot: ForkSnapshot): Promise<{ ok: true; agentId: string }> {
    // Apply the FULL schema before copying rows. onStart runs on first access,
    // but this RPC can be invoked before it completes — ensureSchema creates
    // every table so the copy's events-hub/heads/shadow/etc. rows never hit a
    // missing table.
    this.ensureSchema();

    // The row copy is atomic; the file copy cannot be inside that transaction
    // (a host transaction is synchronous, the filesystem is not) and does not
    // need to be — it is a set of idempotent overwrites. `this.boundSql` is a
    // stable closure over `this.sql` that preserves the `this`-binding the
    // Agent base class needs.
    await writeForkSnapshot(this.boundSql, this.rt.storage.vfs, snapshot, {
      workspaceId: this.ctx.id.toString(),
      workspaceName: forkName,
      transaction: (rows) => this.ctx.storage.transactionSync(rows),
    });

    return { ok: true, agentId: this.ctx.id.toString() };
  }

  // ── EventsHub RPCs — triggers + events for UI ──────────────────

  /** List triggers (webhooks, timers, watches, mcp routes). UI uses this
   *  for the Supervise Automations block. */
  @callable()
  async listTriggers() {
    return listTriggers(this.triggerRegistry);
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
    const webhook = registerDurableWebhook(this.triggerRegistry, opts, now);
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
  createTimerTrigger(opts: {
    cron?: string;
    atMs?: number;
    label?: string;
    payload?: Record<string, unknown>;
    trust?: 'authenticated' | 'owner';
    /** The mission budget every turn this schedule wakes spends against. */
    missionLabel?: string;
  }): { id: string; kind: 'timer_cron' | 'timer_oneshot'; nextFireAt: number | null } {
    return createTimerTrigger(this.triggerRegistry, opts, Date.now());
  }

  /**
   * Trace-driven auto-GEPA tick — called once per completed turn. When enough
   * new turns have accrued since the last pass AND no pending scaffold is
   * mid-shadow, kick GEPA in the background. The counter keeps growing while a
   * pending is in flight, so a pass fires as soon as the shadow slot frees.
   */
  private maybeRunAutoGepa(): void {
    const everyN = this.config.getAutoGepaEveryNTurns();
    if (everyN <= 0) return;
    // One-time honesty note: before autonomy defaults flipped ON, a disable
    // DELETED this key — an absent row is indistinguishable from
    // never-configured, so the autonomous default supersedes both. Pin the
    // default explicitly and record the activation in the evolution stream
    // so the override is documented, never silent.
    if (this.config.get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns) == null) {
      this.config.setAutoGepaEveryNTurns(everyN);
      try {
        this.sql`INSERT INTO evolution_events (type, message, created_at)
          VALUES ('reflection', ${
            `Auto-GEPA enabled by the autonomous default (every ${everyN} turns of new traces). ` +
            `A disable set before autonomy defaults flipped on was stored as "unset" and is ` +
            `superseded by this default — run setAutoGepa(0) to disable again.`
          }, ${Date.now()})`;
      } catch { /* event log is best-effort */ }
    }
    this._turnsSinceGepa += 1;
    if (this._turnsSinceGepa < everyN) return;
    if (getPendingScaffold(this.boundSql)) return;  // wait for the slot; keep the counter
    this._turnsSinceGepa = 0;
    void this.runScaffoldGepaOptimization()
      .catch((err) => console.warn('[proteus] auto-GEPA failed:', (err as Error).message));
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

  /** Facet bootstrap authority. Worker-side DO RPC only. The child verifies
   *  its supplied owner/workspace against this source before persisting its
   *  immutable identity row. */
  async getSubordinateBootstrapIdentity(): Promise<{
    parentWorkspace: string;
    ownerUserId: string;
    model: string | null;
  }> {
    // Deliberately carries no capability token: this method is reachable by any
    // holder of a stub to this workspace, so it must never hand out a secret.
    // The token reaches subordinates by push (setSubordinateIdentity +
    // installWorkspaceCapability), never by read-back.
    this.ensureSchema();
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) throw new Error('Workspace must be owned before creating subordinates.');
    return {
      parentWorkspace: this.name,
      ownerUserId,
      model: this.config.getModel(),
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
  }): Promise<{ id: string; admitted: boolean }> {
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
    }, input, Date.now());
  }

  // ── Mission Inbox: email ingress + owner notifications ─────────

  /** Owner's verified login email (UserDO profile), or null when unknown. */
  private async getOwnerEmail(): Promise<string | null> {
    try {
      const { stub, caller } = await this.userHub();
      return (await stub.getProfile(caller))?.email ?? null;
    } catch { return null; }
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
    let notification: OwnerNotification | null;
    try {
      notification = planOwnerNotification({
        enabled: this.config.getEmailNotificationsEnabled(),
        operatorConnected: this.ctx.getWebSockets().length > 0,
        subject,
        text,
      });
    } catch { return; }
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
    })().catch((err) => console.warn('[proteus-email] notification failed:', err));
  }

  /** Recent events for the operator UI's events sidebar. Mirrors
   *  events_v ordering (received_at desc). */
  async listRecentEvents(opts?: { variant?: string; since?: number; limit?: number }) {
    const events = this.eventLog.query({
      variant: opts?.variant as never,
      since: opts?.since,
      limit: opts?.limit ?? 100,
    });
    return {
      events: events.map((e) => ({
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
      })),
    };
  }

  // ── Internal: timing-safe string compare for webhook auth ──────

  // (Defined at module scope at the bottom of the file.)

}

// ── Module-scope helpers (referenced by OrchestratorAgent) ────────

/** An export cursor arrives from a client, so it is claimed, not trusted:
 *  anything that is not the shape the previous page returned starts a fresh
 *  archive rather than binding junk into the row query. */
function parseArchiveCursor(value: unknown): ArchiveCursor | null {
  if (value === null || typeof value !== 'object') return null;
  const { table, after, rows } = value as Record<string, unknown>;
  if (typeof table !== 'string' || !table) return null;
  if (after !== null && !Number.isSafeInteger(after)) return null;
  if (!Number.isSafeInteger(rows) || (rows as number) < 0) return null;
  return { table, after: after as number | null, rows: rows as number };
}
