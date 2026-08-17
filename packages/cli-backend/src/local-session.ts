/**
 * LocalAgentSession — the local backend's realization of the Proteus agent loop.
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

import type { ModelMessage, ToolSet, LanguageModel } from 'ai';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  createCompactionExtension, createVfsTranscriptStore,
  createCompactionStateStore, createModelSummarizer,
  type CompactionStateStore,
} from '@proteus/compaction';
import type {
  ChatOptions, ChatEvent,
  AgentRuntime, LLMProviderConfig, CompletedTurn, TurnContinuity, FiberCtx,
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult, PromptFile,
  SessionWriter, SkillsVfs, ActiveSkillSet, TurnSkillSurface, FactsStore, ProteusExtension,
  HeadRuntime, HeadGrounding, MergeResult, SerializedMessage, SplitPhaseEvent, AgentConfigStore, ShellApprovalMode,
  ShellApprovalRequest, ShellApprovalOutcome, RequestShellApproval,
  AgentsForkDeps, AgentsToolDeps,
  IngressDescriptor, ProteusEvent, EventVariant, MissingCapability,
  RunEvent, RunEventInput, RunEventQuery, StepLike,
  ReleaseStore, ReleaseToolDeps, BuiltinToolName,
  FileCheckpoints, FileCheckpointListing, FileRestorePlan, FileRestoreResult,
  CheckpointAvailability,
  WorkMode,
} from '@proteus/core';
import {
  AgentOrchestrator,
  BackgroundJobStore, BackgroundJobRunner, TaskListStore,
  wrapToolsForBackground, resumeForkBackgroundJob, BACKGROUND_POLICY, type BackgroundPolicy,
  MctsSearchStore, createDurableMctsSession,
  EventLog, ReplyChannelStore,
  RunEventRecorder,
  TriggerRegistry,
  // Ingress — core owns the gates; this session owns the local clock and the
  // process boundary in front of them.
  acceptWebhookDelivery, registerDurableWebhook, createWebhookSecretStore,
  initWebhookRateLimitTables,
  createTimerTrigger, cancelTrigger, listTriggers, fireDueTriggers,
  EvolutionEngine,
  createAgentConfigStore,
  createFactsStore, readMemoryTail,
  listProposedTasks, updateProposedTaskStatus,
  buildStrategyForkDeps, agentsActionsFor,
  HeadController, HeadJournal, reconcileInterruptedForks,
  skillsVfsOver, resolveTurnSkills, filterToolSetBySkills, renderFactsForTurn,
  recordGroundedHeadsTake, inheritedContextFromHistory, headPhaseRunEvent,
  ModelCatalogSession,
  BUILTIN_TOOL_NAMES, isMcpToolKey,
  buildBuiltinTools, withClampedToolResults, buildSystemPromptSync, currentDateForPrompt,
  turnProvenanceForMetadata, workModeForTurnMetadata,
  createChatModel, runChat, resolveMaxSteps, estimateTokens,
  parseModelSpec, agentAffinityKey,
  OVERFLOW_RETRY_EVENT,
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery,
  CompletionGate, observeCompletionState, completionGateText, COMPLETION_GATE_EVENT,
  ExtensionHost, StepInjections,
  createDefaultWebSearchProvider, createWebCodemodeProvider, createRLMProvider, type WebSearchProvider,
  createAgentsCodemodeProvider, createReleaseCodemodeProvider, type CodemodeProvider,
  createMemoryCodemodeProvider, createTasksCodemodeProvider,
  MissionGovernor,
  DynamicContextLedger, turnLocalContextMessage, agentDynamicContext, observeSystemPromptHash,
  listRecoveryFindings,
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
  SCAFFOLD_TURN_TIMEOUT_MS,
  type AlternateTakeSet, type TakePickOutcome,
  startBranchHead, settlePendingBranches, newBranchId,
  type PendingBranch, type BranchStatusEvent,
  type AlarmScheduler, type BackgroundJob, type SqlExec,
  type TimerTrigger, type TimerTriggerOpts, type TriggerView,
  type WebhookDelivery, type WebhookDeliveryResult, type WebhookSecretStore,
  reasoningEffortOptions, REASONING_EFFORT_FOR_STAGE,
  type ReasoningEffort, decodeJsonValue, projectJsonValue,
  createAgentSelfProvider,
  // ── Read models: the same implementations the cloud backend's RPCs call ──
  cancelBackgroundJob, jobResult, listBackgroundJobs,
  getAlwaysActiveSkills, getReasoningEffort, getShellApprovalMode, getStoredModelSpec,
  getShellApprovalGrants, revokeShellApprovalGrants, gatedGrants, type ApprovalGrant,
  setAlwaysActiveSkills, setModel, setReasoningEffort, setShellApprovalMode,
  getEvolutionChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
  type EvolutionChangelogView,
  getRunEvents, listRuns, type RunListEntry, type Page, type PageRequest,
} from '@proteus/core';
import { makeSqlExec } from './runtime.js';
import { discoverAgentsMd } from './agents-md.js';
import { createNodeCraftedExecute } from './craft-executor.js';
import { createNodeExecuteToolFactory } from './execute-tools-factory.js';
import { createCLIHeadRuntime } from './head-runtime.js';
import { detectOrphanedFibers } from './fiber.js';
import { connectMcpServers, type McpServerConfig } from './mcp.js';
import type { LocalModelResolver } from './model-resolver.js';

/** Build the ai-SDK chat model both frontends drive runChat with.
 *  Provider-style model switching uses
 *  createLocalModelResolver and agent_config.model. */
export function resolveChatModel(llm: LLMProviderConfig): LanguageModel {
  if (llm.name === 'anthropic') {
    return createChatModel({
      kind: 'anthropic', baseURL: llm.baseURL, headers: llm.headers, modelId: llm.model,
    });
  }
  return createChatModel({
    kind: 'openai-compat', name: llm.name, baseURL: llm.baseURL, headers: llm.headers, modelId: llm.model,
  });
}

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
      `[Runtime note — written by the Proteus harness, not by the user.]\n\n`
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
  rt: AgentRuntime;
  /** Raw bun:sqlite handle — backs the EventsHub SqlExec adapter. */
  db: LocalSessionDb;
  /** The ai-SDK chat model runChat drives. Build via resolveChatModel(llmConfig). */
  model: LanguageModel;
  /** Display/canonical spec for static-model sessions with no modelResolver. */
  modelSpec?: string;
  /** Optional provider-style resolver. When present, agent_config.model controls
   *  the active chat model exactly like the DO backend's setModel/getModel path. */
  modelResolver?: LocalModelResolver;
  onEvent: (event: SessionEvent) => void;
  /** Disable auto-evolution (turn + session reflection). Default: enabled. */
  noAutoEvolve?: boolean;
  /** This process runs ONE task turn and exits (`proteus exec`/`proteus run`).
   *  Two consequences, both about honesty rather than throttling:
   *    • the next invocation's prompt is NOT a conversational follow-up, so it
   *      never grades the previous turn (it would read as `accepted`);
   *    • the cadence-heavy evolution pass is not started here, because this
   *      process cannot finish it — the durable window carries the turns to
   *      the local scheduler daemon instead.
   *  Default false: the REPL, TUI and daemon are all long-lived. */
  oneShot?: boolean;
  /** Turns between session-level reflections (default 5, matching the DO). */
  sessionReflectionInterval?: number;
  /** Durable conversation key in the local messages table. Default: `default`. */
  sessionId?: string;
  /** Persist user/assistant messages to SQLite. Default: true. */
  persistMessages?: boolean;
  /** Working directory for AGENTS.md discovery + the prompt's runtime context.
   *  Default: process.cwd(). */
  cwd?: string;
  /** How long a tool call may run before it is moved to the background, and how
   *  long teardown waits on work that has not settled. Fixed by the surface that
   *  opened the session (BACKGROUND_POLICY). Default: the interactive policy. */
  backgroundPolicy?: BackgroundPolicy;
}

interface QueueItem {
  text: string;
  /** Attachments for a user turn — forwarded to the model as file parts. */
  files?: ReadonlyArray<PromptFile>;
  metadata?: ProgrammaticTurn['metadata'];
  kind: 'user' | 'programmatic';
  resolve: () => void;
}

type CurriculumStatus = 'pending' | 'accepted' | 'rejected' | 'completed';

export class LocalAgentSession implements BackendHost {
  private readonly rt: AgentRuntime;
  private readonly fallbackModel: LanguageModel;
  private readonly fallbackModelSpec: string;
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
  /** Branching-heads runtime (BackendHost seam) + its controller — local heads
   *  run in-process over isolated ephemeral runtimes. */
  private _headRuntime: HeadRuntime;
  private headController: HeadController;
  private readonly onEvent: (event: SessionEvent) => void;
  private shellApprovalHandler: ShellApprovalHandler | null = null;
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
  private readonly persistMessagesEnabled: boolean;
  private readonly history: ModelMessage[] = [];
  private turnWorkMode: WorkMode = 'build';

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
  private readonly compactionExtension: ProteusExtension;

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
  /** Mid-turn steers awaiting the next step boundary (Hermes steer-drain:
   *  everything pending merges into ONE user message per drain, injected after
   *  the latest tool results so role alternation stays provider-safe). */
  private pendingSteers: Array<{ text: string; files?: ReadonlyArray<PromptFile> }> = [];
  /** Steer-as-Branch redirects launched against the in-flight turn — each runs
   *  as one budgeted head and settles into Alternate Takes at turn end. */
  private pendingBranches: PendingBranch[] = [];

  constructor(opts: LocalAgentSessionOpts) {
    this.rt = opts.rt;
    this.onEvent = opts.onEvent;
    this.sessionId = opts.sessionId ?? 'default';
    this.oneShot = opts.oneShot === true;
    this.cwd = opts.cwd ?? process.cwd();
    this.persistMessagesEnabled = opts.persistMessages !== false;
    this.fallbackModel = opts.model;
    this.fallbackModelSpec = opts.modelSpec ?? 'local/static';
    this.modelResolver = opts.modelResolver ?? null;

    this.engine = new EvolutionEngine(this.rt, {
      enabled: !opts.noAutoEvolve,
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
    // (a benchmark harness, `proteus exec` on a fresh clone), so it runs here
    // too rather than trusting an earlier caller.
    const hubSql = makeSqlExec(opts.db);
    initWorkspaceSchema({ execRaw: this.rt.storage.execRaw, sql: this.rt.storage.sql, exec: hubSql });
    initWorkspaceBaselineTable(this.rt.storage.execRaw);

    // Background-job lifecycle over the durable local fiber (createLinuxFiber) +
    // this session as the BackendHost (enqueueTurn wakes the agent).
    this.jobs = new BackgroundJobStore(this.rt.storage.sql);
    this.taskList = new TaskListStore(this.rt.storage.sql);
    this.headJournal = new HeadJournal(this.rt.storage.sql);
    this.mctsSearchStore = new MctsSearchStore(this.rt.storage.sql);
    this.config = createAgentConfigStore(this.rt.storage.sql);
    this.factsStore = createFactsStore(this.rt.storage.sql);

    // Better-compact is THE default (and only) compaction path — the same
    // staged transformContext ladder the cloud backend registers, over the
    // same shared stores (transcripts in the canonical VFS, plan + trigger
    // state in agent.db). The summarizer rides the session's active model.
    this.compactionState = createCompactionStateStore(this.rt.storage.sql);
    this.compactionExtension = createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => this.rt.storage.vfs),
        plans: this.compactionState.plans,
        logger: {
          // All diagnostics go to stderr: under `proteus exec --json` stdout IS
          // the event stream, so an info/debug console.log would corrupt the
          // JSONL (console.info/debug write to stdout in Node). stderr keeps the
          // stream clean and is still visible on an interactive terminal.
          info: (message, data) => console.error(`[proteus:compaction] ${message}`, data ?? ''),
          debug: (message, data) => console.error(`[proteus:compaction] ${message}`, data ?? ''),
          warn: (message, data) => console.warn(`[proteus:compaction] ${message}`, data ?? ''),
          error: (message, data) => console.error(`[proteus:compaction] ${message}`, data ?? ''),
        },
      },
      archive: this.compactionState.archive,
      summarize: createModelSummarizer(() => this.ensureModelState()),
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
      model: this.fallbackModel,
      providerFamily: parseModelSpec(this.fallbackModelSpec).provider,
      parentRuntime: this.rt,
      cwd: this.cwd,
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
    this.headController = new HeadController(this._headRuntime, this.headJournal);

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
    // RunEvent union the cloud backend records, over local SQLite.
    this.eventRecorder = new RunEventRecorder(this.rt.storage.sql);
    // …and forwarded to the frontends as it is written. The table alone is
    // observable only to something that outlives the database, which a
    // benchmark container or a one-shot `proteus exec` does not.
    this.eventRecorder.observe((event) => this.emit({ type: 'run-event', event }));

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
    this.orch = new AgentOrchestrator({
      host: this,
      engine: this.engine,
      eventLog: this.eventLog,
      budget: this.budget,
      sessionReflectionInterval: opts.sessionReflectionInterval,
      oneShot: opts.oneShot === true,
      sinks: {
        onToolCallEvent: (ev) => this.recordRunEvent({ type: 'tool_call_end', ...ev }),
        onStepEvent: (ev) => this.recordRunEvent({ type: 'step_finish', ...ev }),
      },
    });
    this.rt.setTurnFileLedgerProvider?.(() => this.orch.acc.files);
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
   */
  async listFileCheckpoints(limit?: number): Promise<FileCheckpointListing> {
    const availability = await this.checkpointStatus();
    if (!availability.available || !this.rt.checkpoints) return { availability, entries: [] };
    return { availability, entries: await this.rt.checkpoints.list(limit) };
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
    return this.normalizeModelSpec(this.config.getModel());
  }

  /** Validate + store a new model spec. Effective on the next turn and for new
   *  think/head runs, matching the DO backend's setModel behavior. */
  setModel(spec: string): ReturnType<typeof setModel> {
    return setModel({
      config: this.config,
      normalize: (s) => this.normalizeModelSpec(s),
      onChanged: () => this.rebuildToolSurface(),
    }, spec);
  }

  getReasoningEffort(): { effort: ReasoningEffort | null } {
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

  pendingEvents(limit = 50): ProteusEvent[] {
    return this.eventLog.pending({ limit });
  }

  listRecentEvents(opts: { variant?: EventVariant; since?: number; limit?: number } = {}): ProteusEvent[] {
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

  /** Alternate-Takes capture of a completed heads run (core heads-support). */
  private recordHeadsTake(merge: MergeResult, task: string): void {
    recordGroundedHeadsTake(this.rt.storage.sql, merge, task);
  }

  /** The drain-debounce timer (BackendHost seam) — a plain one-shot timeout.
   *  Skips a window that outlives the session so consumed events are never
   *  bound to a turn a dead pump will not run. */
  setTimer(fn: () => Promise<void>, ms: number): void {
    setTimeout(() => {
      if (this.ended) return;
      void fn().catch((error) =>
        console.warn('[proteus] drain timer callback failed:', errorMessage({ error })));
    }, ms);
  }

  /** Inject a programmatic turn into the same serialized loop the user drives —
   *  backs the reactor + background-job wake. Self-starts the pump when idle so
   *  a job that settles mid-idle wakes the agent immediately. */
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
    return new Promise((resolve) => {
      this.queue.push({
        text: input.text,
        metadata: input.metadata,
        kind: 'programmatic',
        resolve: () => resolve({ status: 'queued' }),
      });
      void this.pump();
    });
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
   *  of `pendingSteers`, which signals do not touch: they ride the core seam's
   *  own buffer, are never persisted, and settle back into turns of their own.
   *  Two independent splices land at the same step tail as two adjacent
   *  user-role messages, which every provider adapter groups into one turn. */
  turnInFlight(): boolean {
    return this.currentAbort !== null;
  }

  // ── Public driver API ──────────────────────────────────────────────

  /** Run a user turn (and any programmatic turns it cascades). Resolves when
   *  the user's own turn has finished. Attachments (data-URL PromptFiles)
   *  become file parts on the turn's user message. */
  send(input: string | { text: string; files: ReadonlyArray<PromptFile> }): Promise<void> {
    const { text, files } = normalizePromptInput(input);
    return new Promise((resolve) => {
      this.queue.push({ text, files, kind: 'user', resolve });
      void this.pump();
    });
  }

  /**
   * Steer the in-flight turn: queue the message for injection at the next step
   * boundary (prepareStep), where everything pending drains into one merged
   * user message. Input that never sees a boundary (the model was already
   * writing its final answer) runs as the immediate next turn instead.
   * Returns false when no turn is active — callers should send() normally.
   */
  steer(input: string | { text: string; files: ReadonlyArray<PromptFile> }): boolean {
    if (!this.pumping) return false;
    const { text, files } = normalizePromptInput(input);
    this.pendingSteers.push({ text, files });
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
    const dropped = this.pendingSteers.splice(0).map((steer) => steer.text);
    this.currentAbort?.abort();
    return dropped;
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
    await this.orch.drainPendingEvents();
  }

  /**
   * Run the session/lifetime evolution pass the durable window is due for, to
   * completion. This is the CADENCE LANE (AgentOrchestrator's exit contract),
   * and this method is how a host that CAN afford it claims the work a
   * one-shot `proteus exec` process deliberately left behind: the scheduler
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
    await this.orch.settleEvolution();
    await this.joinBackgroundFibers(this.drainDeadline());
    await this.mcpClose?.();
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
        console.error(`[proteus] durable fiber '${name}' failed to settle:`, outcome.reason);
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
      `this machine. Cancel with: proteus jobs ${this.agentName()} cancel <id>.` +
      (roster ? ` Interrupted: ${roster}.` : '');
    this.emit({ type: 'evolution', event: 'bg_jobs_abandoned', message });
    console.warn(`[proteus] ${message}`);
  }

  /**
   * Recover the work a previous CLI exit interrupted: the fork journal, then
   * the background-job registry.
   *
   * Forks first, and before anything can resume one. `head_journal.status =
   * 'running'` means "spawned, no report recorded", and nothing carries a head
   * across a process exit — so at this instant every such row is stale, and
   * left alone it feeds "N of M heads running" into the dynamic-context block
   * of every model step forever. reconcileInterruptedForks settles them and
   * tells the agent through the one signal seam.
   *
   * Then two passes over the jobs, because the fiber rows and the job registry
   * each know something the other does not. An interrupted bg:* fiber row says
   * its job's executor died AFTER settling, which is the only way a lost wake
   * can be re-delivered (DO onFiberRecovered parity); the registry says which
   * jobs are still `running` at all, including the ones whose fiber row did
   * not survive. Stale fiber rows from the prior run are cleared as they are
   * read — a resume runs in a NEW fiber row, so this never deletes it.
   *
   * Call once at startup: no fibers are live yet, so every row is an orphan.
   *
   * Nothing here is optional. Each step used to absorb its own failure, so a
   * workspace whose fiber rows could not be read recovered NOTHING and then
   * looked exactly like one that had no interrupted work — while the notice the
   * previous exit printed promised the operator these jobs would resume.
   */
  async recoverBackgroundJobs(): Promise<void> {
    await reconcileInterruptedForks({
      journal: this.headJournal,
      signals: this.orch.signals,
      logActivity: (event, detail) => this.emit({ type: 'evolution', event, message: detail ?? '' }),
    });
    const orphans = detectOrphanedFibers(this.rt.storage.sql);
    for (const o of orphans) {
      if (o.name.startsWith('bg:')) await this.jobRunner.recover(o.snapshot);
      void this.rt.storage.sql`DELETE FROM fibers WHERE id = ${o.id}`;
    }
    // Fiber rows are not the source of truth for job liveness. A settlement
    // whose database was closed under it at teardown writes neither its outcome
    // nor its force-fail, and its fiber row dies with the process — leaving a
    // `running` row no orphan fiber points at, which the loop above can never
    // reach. Nothing in this process owns a job yet, so every remaining
    // `running` row is an orphan too.
    await this.jobRunner.recoverOrphans();
  }

  /** Re-drive a background job interrupted by a previous process exit — the
   *  shared fork-only resume gate (core background-tools) over the RAW
   *  surface, so a re-drive can't detach a second job. Legacy 'think' jobs
   *  translate onto the same fork path; the model-bound surface resolves
   *  inside the thunk, only for a resumable kind. */
  private resumeBackgroundJob(
    kind: string,
    input: { value: unknown },
    mode: WorkMode,
    signal: AbortSignal,
  ) {
    return resumeForkBackgroundJob((resumeMode) => {
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
      console.error(`[proteus] session event listener failed on '${event.type}':`, error);
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
        try {
          await this.processTurn(item);
        } catch (err) {
          console.error('[proteus] turn processing failed:', err instanceof Error ? err.message : String(err));
        } finally {
          item.resolve();
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
   * `proteus run`/`exec` calls this after its turn and before it stops
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
   *  default (`runId` omitted); a caller that captured its OWN run id at
   *  dispatch time (a detached fork's phase events — see emitHeadPhase) passes
   *  it explicitly so a later phase still lands correctly once the calling
   *  turn has moved on. Never throws: losing a history row must not fail a
   *  turn. */
  private recordRunEvent(input: RunEventInput, runId?: string | null): void {
    const id = runId !== undefined ? runId : this.currentRunId;
    if (!id) return;
    try { this.eventRecorder.emit(id, input); }
    catch (err) { console.warn('[proteus] run event emit failed:', err); }
  }

  /** Seal the in-flight run via the shared core turn-lifecycle bracket.
   *  Idempotent per run — clearing the id makes a second call a no-op. */
  private closeRun(error: string | null): void {
    if (!this.currentRunId) return;
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
      reason: this.orch.acc.hadError ? 'error' : 'completed',
    };
    if (error) outcome.error = error;
    closeTurnRun(this.eventRecorder, this.currentRunId, outcome);
    this.currentRunId = null;
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
    const parsedEvent = v.safeParse(v.string(), item.metadata?.proteusEvent);
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
      const message = errorMessage({ error });
      this.orch.acc.hadError = true;
      this.closeRun(message.slice(0, 500));
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });
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
    // Shadow-git checkpoints: arm the per-turn dedup so the first host-FS
    // mutation of this turn snapshots its working directory (invisible /undo
    // substrate — see core checkpoints/types.ts).
    this.rt.checkpoints?.beginTurn({ turnId: crypto.randomUUID(), sessionId: this.sessionId });
    // A real user message grades the previous turn — dispatch the detached
    // outcome review (same core pipeline as the DO's beforeTurn hook). In a
    // one-shot process the previous turn belongs to an already-exited
    // invocation, so this prompt is a fresh task, not a verdict on it.
    if (item.kind === 'user') this.orch.observeUserTurn(item.text, this.turnContinuity);
    // A one-shot task turn is graded by whatever it leaves on disk, with nobody
    // to push back — so it arms the completion gate. Nothing else does.
    if (item.kind === 'user' && this.oneShot) this.completionGate.arm(item.text);
    const model = this.ensureModelState();
    this.activateToolMode(this.turnWorkMode);

    // MEMORY.md is append-only — the TAIL holds the newest lessons/reflections.
    // It is per-turn-read live state (lessons/reflections/take-pick
    // corrections append constantly), so it rides the dynamic-context
    // ledger: in the stable prefix every append would bust the cache and
    // trip the prompt-hash telemetry with no real agent event.
    const memoryTail = await readMemoryTail(this.rt.memory);
    const executors = this.rt.executionRouter?.listExecutors() ?? [];
    const { available: availableSkills, activeSkills } = await this.resolveTurnSkills(item.text);
    // Skill-filtered built-ins + the connected MCP tools (always available).
    const filteredBuiltins = this.filterToolsBySkills(activeSkills);
    const turnTools = { ...filteredBuiltins, ...this.extraTools };
    const availableBuiltins = Object.keys(filteredBuiltins).filter((name): name is BuiltinToolName =>
      BUILTIN_TOOL_NAMES.has(name));
    const externalTools = Object.keys(this.extraTools).map((name) => ({
      name,
      source: isMcpToolKey(name) ? 'mcp' as const : 'external' as const,
    }));
    // Nearest-file-wins AGENTS.md chain, re-read each turn so edits land
    // immediately (a handful of stat calls — negligible next to the LLM call).
    const agentsMd = discoverAgentsMd(this.cwd);
    // The byte-stable cache prefix — system state (facts, executor status)
    // rides the dynamic ledger and activation reasons ride the turn-local
    // tail below, sharing the seam with the DO backend.
    const systemPromptOptions: Parameters<typeof buildSystemPromptSync>[1] = {
      executors,
      availableTools: availableBuiltins,
      agentsActions: agentsActionsFor(this.agentsToolDeps(this.turnWorkMode)),
      // Matches the execute_tools wiring: llm.query exists only with a resolver.
      rlmAvailable: this.modelResolver !== null,
      externalTools,
      backend: 'cli-local',
      workMode: this.turnWorkMode,
      provenance: turnProvenanceForMetadata(item.metadata),
      stance: this.config.getStance(),
      planSubmissionAvailable: false,
      model: { id: this.effectiveModelSpec() },
      cwd: this.cwd,
      currentDate: currentDateForPrompt(),
    };
    if (agentsMd.length > 0) systemPromptOptions.agentsMd = agentsMd;
    if (availableSkills.length > 0) systemPromptOptions.availableSkills = availableSkills;
    if (activeSkills) systemPromptOptions.activeSkills = activeSkills;
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
    const abort = new AbortController();
    this.currentAbort = abort;

    // Steer-drain bookkeeping (Hermes conversation_loop pattern): at each step
    // boundary all pending steers merge into ONE user message appended after
    // the latest tool results (Anthropic groups tool+user into a single turn,
    // so role alternation holds). The splice-at-entry-index math — base
    // coordinates from the step-0 message count, re-applied every step — is
    // the shared core StepInjections (the cf backend's background-event
    // injection rides the same class).
    const injections = new StepInjections<{ message: ModelMessage; texts: string[] }>();
    const prepareStepMessages = (ctx: { stepNumber: number; messages: ModelMessage[] }): ModelMessage[] | undefined => {
      const drained = this.pendingSteers.splice(0);
      return injections.drain(ctx, drained.length > 0
        ? [{ message: steerUserMessage(drained), texts: drained.map((steer) => steer.text) }]
        : []);
    };

    // The compaction extension + the steer-drain ride the public extension
    // seam — the same host external plugins register on. One hook path, not
    // a private callback + a plugin API.
    // The orchestrator's signal extension registers LAST: its splice must never
    // shift the indices the user-steer drain replays into durable history.
    const extensions = new ExtensionHost()
      .register(this.compactionExtension)
      .register({ name: 'proteus.steering', prepareStep: prepareStepMessages })
      .register(this.orch.turnExtension);
    const cache = this.cacheIdentity();
    const effort = this.config.getReasoningEffort() ?? REASONING_EFFORT_FOR_STAGE.chat;
    const providerOptions = reasoningEffortOptions(effort, cache.providerId ?? '');
    // The measured trigger: the previous turn's final request as the provider
    // actually priced it, persisted at turn end below — voided by the length
    // guard when the durable history shrank (restart truncation) since the
    // measurement.
    const historyLength = this.history.length;
    const lastPromptTokens = this.compactionState.loadPromptTokens(cache.sessionKey, historyLength);
    // Overflow recovery (armed below on a context_length failure): consume
    // the flag — at most one forced rebuild per arm, never a loop.
    const transformTrigger = this.compactionState.takeForceCompaction(cache.sessionKey)
      ? 'force' as const
      : 'auto' as const;
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
      transformTrigger,
      maxSteps: resolveMaxSteps(process.env.PROTEUS_MAX_STEPS),
      cache,
      budget: this.budget,
    };
    if (lastPromptTokens !== null) liveTurnOpts.providerReportedTokens = lastPromptTokens;
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
        timeoutMs: SCAFFOLD_TURN_TIMEOUT_MS,
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
            for (const msg of injections.replayInto(ev.responseMessages)) this.history.push(msg);
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
      for (const injection of injections.recorded) this.history.push(injection.message);
      this.orch.acc.hadError = true;
      const message = err instanceof Error ? err.message : String(err);
      runError = message.slice(0, 500);
      this.emit({ type: 'error', message });
      // Overflow recovery — the shared core policy, APPLIED by the shared
      // core helper (arm force-compaction + at most one retry enqueue).
      applyOverflowRecovery({
        error: message,
        lastPromptTokens: this.orch.acc.lastPromptTokens,
        contextWindow,
        turnWasOverflowRetry: item.metadata?.proteusEvent === OVERFLOW_RETRY_EVENT,
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
      if (this.pendingSteers.length > 0) {
        const leftover = this.pendingSteers.splice(0);
        this.queue.unshift({
          text: leftover.map((steer) => steer.text).join('\n\n'),
          files: leftover.flatMap((steer) => steer.files ?? []),
          kind: 'user',
          resolve: () => {},
        });
      }

      // The completion gate: on the one-shot surface a turn that did work does
      // not get to be the last word on its own say-so.
      if (this.turnWorkMode !== 'plan') await this.applyCompletionGate(runError === null);

      // One durable row PER steer (not per drain): the walk-back fork pivot
      // matches individual user messages verbatim, exactly as surfaces and the
      // JSONL transcript recorded them.
      assistantMsgId = this.persist(item.text, injections.recorded.flatMap((injection) => injection.texts), fullText);

      // Alternate Takes captured during this turn's think-mcts runs get the
      // turn id they competed for, so a pick can credit the right turn. A turn
      // that settles without an assistant message id — or that errored, whose
      // captures competed for an answer that no longer exists — cannot be
      // credited, so its captures are purged (mirroring the cf backend's
      // purge-on-error) and the next turn never claims them as its own.
      if (this.turnWorkMode !== 'plan' && assistantMsgId && !this.orch.acc.hadError) {
        claimAlternateTakesForTurn(this.rt.storage.sql, {
          turnId: assistantMsgId, sessionId: this.sessionId, startedAt,
        });
      } else {
        purgeUnclaimedAlternateTakes(this.rt.storage.sql);
      }

      // Steer-as-Branch redirects launched during this turn settle against its
      // answer — detached, so a slow branch never delays turn-end.
      if (this.turnWorkMode !== 'plan') {
        this.settlePendingBranches(this.orch.acc.hadError ? null : assistantMsgId, fullText);
      }

      // The confirming turn is over: what the agent did with its free re-look
      // IS the gate's conversion number, and closeRun writes it.
      if (event === COMPLETION_GATE_EVENT) {
        this.completionGate.settle({ toolCalls: this.orch.acc.toolCalls.length });
      }

      const turn = this.snapshotTurn(item, fullText, assistantMsgId);
      this.closeRun(runError);
      // Cadence (turn + session evolution) + the reactor drain — may enqueue more.
      await this.orch.completeTurn(turn, this.turnContinuity);
      // The turn's contribution to the promotion gate: one row recording the
      // task, the answer, and the conversation it was asked in. The rollout it
      // pays for runs on the cadence lane, which is why this is not tracked —
      // a `proteus exec` process no longer waits out a candidate turn before
      // it can exit.
      if (this.turnWorkMode !== 'plan') this.engine.queueShadowTrial(turn, liveTurnOpts.history);
      this.emit({ type: 'turn-end', turn });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.orch.acc.hadError = true;
      this.closeRun(runError ?? message.slice(0, 500));
      console.error('[proteus] turn finalization failed:', message);
      // Any response messages runChat produced remain in live history as a
      // best-effort recovery for later turns in this process. We do not retry
      // potentially partial side effects, and failed persistence cannot survive
      // a restart, so surface both the failure and a terminal turn event.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, fullText, assistantMsgId) });
    }
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
      metadata: { proteusEvent: COMPLETION_GATE_EVENT },
      resolve: () => {},
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
    } catch {
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
   *  `proteus-<name>` scheme Workers AI affinity pins with), and the agent's
   *  configured retention. */
  private cacheIdentity(): PromptCacheIdentity {
    const sessionKey = `${agentAffinityKey(this.agentName())}:${this.sessionId}`;
    const retention = this.config.getCacheRetention();
    const spec = this.effectiveModelSpec();
    try {
      const { provider, modelId } = parseModelSpec(spec);
      return { providerId: provider, modelId, sessionKey, retention };
    } catch {
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

  /** Resolve this turn's skill surface (core turn-surface — the SAME
   *  resolution the DO's beforeTurn runs). */
  private resolveTurnSkills(userText: string): Promise<TurnSkillSurface> {
    return resolveTurnSkills({
      vfs: this.getSkillsVfs(),
      config: this.config,
      userText,
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
      maxSteps: resolveMaxSteps(process.env.PROTEUS_MAX_STEPS),
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
  runScaffoldOnce(task: string, opts?: { useShadowOverride?: boolean; timeoutMs?: number }) {
    return runScaffoldOnce(this.scaffoldControl, task, opts);
  }

  /** Run an arbitrary archived scaffold version against a task — previewing a
   *  candidate live before promoting it. */
  previewScaffoldLive(version: number, task: string, opts?: { timeoutMs?: number }) {
    return previewScaffoldLive(this.scaffoldControl, version, task, opts);
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
    return createScaffoldLLMStream({ model, tools: () => turnTools, defaultMaxSteps: resolveMaxSteps(process.env.PROTEUS_MAX_STEPS) });
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
      maxSteps: 1,
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
    return agentDynamicContext({
      factsBlock: this.renderFactsForTurn(),
      memoryTail,
      recoveryFindings: listRecoveryFindings(this.rt.storage.sql),
      executors: this.rt.executionRouter?.listExecutors() ?? [],
      runningJobs: this.jobs.listRunning(),
      openTasks: this.taskList.listOpen(),
      liveHeadRuns: this.headJournal.listLive(),
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

  /** The `agents` tool's fork substrate — the SAME shared factory the DO
   *  wires (core fork-deps): single-shot + MCTS + heads, host-injected infra
   *  recomputed per fork call. MCTS explores over rt.spawnBranch; heads run
   *  in-process via the CLI HeadRuntime. The CLI wires no team or peer
   *  transport, so fork is the tool's only action here. */
  private buildAgentsForkDeps(mode: WorkMode): AgentsForkDeps {
    return buildStrategyForkDeps({
      rt: this.rt,
      model: this.cachedModel ?? this.fallbackModel,
      mcts: {
        session: () => this.createMCTSSession(),
        search: this.mctsSearchStore,
        overrides: () => this.config.getMctsOverrides(),
      },
      heads: {
        controller: () => this.headController,
        inheritedContext: () => this.readInheritedContext(),
        // Captured at dispatch, once per fork call — see emitHeadPhase.
        onPhase: () => {
          const runId = this.currentRunId;
          return (e: SplitPhaseEvent) => this.emitHeadPhase(e, runId);
        },
        onComplete: (merge: MergeResult, task: string) => {
          if (mode === 'build') this.recordHeadsTake(merge, task);
        },
      },
    });
  }

  /** This session's delegation deps. `team` / `peers` are deliberately absent:
   *  staffing and peer messaging need a cross-agent transport, and local agents
   *  are one-per-process SQLite sessions with no daemon to route between them.
   *  Absent deps → those actions are structurally missing from the `agents`
   *  tool, from the `agents.*` sandbox namespace, and from the prompt ladder.
   *  Hosted agents get the full surface. */
  private agentsToolDeps(mode: WorkMode): AgentsToolDeps {
    return { mode, fork: this.buildAgentsForkDeps(mode), budget: this.budget };
  }

  /** The recent conversation handed to each spawned head as inherited context
   *  (core heads-support; capped to bound the head's LLM context). */
  private readInheritedContext(): SerializedMessage[] {
    return inheritedContextFromHistory(this.history);
  }

  /** Record head_split / head_merge in the durable run-event log — the same
   *  rows the DO writes, so a fork's cost and productivity survive the
   *  process. Broadcast-only was why local runs (every benchmark trial) left
   *  no trace of a fork, and 4-of-5 empty forks had to be found by reading
   *  trajectories by hand. The recorder streams every row it writes as a
   *  `run-event`, so recording IS the fan-out; broadcasting a second copy put
   *  the split through `proteus exec --json` twice and reached no other
   *  reader — no CLI surface consumes a head phase as a broadcast.
   *
   *  `runId` is the run captured at fork DISPATCH (buildAgentsForkDeps'
   *  onPhase factory), not read live: a fork on the interactive surface now
   *  detaches the instant it spawns, so the calling turn can close ITS run —
   *  nulling `this.currentRunId` — before 'split' fires and always before
   *  'merge' does. Passing null explicitly (a closed run) is deliberate and
   *  distinct from omitting it (fall back to whatever is live) — see
   *  recordRunEvent. */
  private emitHeadPhase(event: SplitPhaseEvent, runId: string | null): void {
    this.recordRunEvent(headPhaseRunEvent(event), runId);
  }

  /** A fresh SessionWriter for an MCTS run — the SAME durable writer the DO
   *  uses (core mcts-session): the messages table is the source of truth, so
   *  a search resumed after a process exit reconstructs its branch ancestry
   *  from the persisted rows instead of an in-memory mirror that died with
   *  the previous process (B6 parity). */
  private createMCTSSession(): SessionWriter {
    return createDurableMctsSession(this.rt.storage.sql);
  }

  /** The shared background wrap (core background-tools) — the SAME wrapper
   *  the cf backend applies: shallow clone, 30s threshold, per-call abort. */
  private wrapToolsForBackground(raw: ToolSet): ToolSet {
    return wrapToolsForBackground(raw, { jobRunner: this.jobRunner, mode: () => this.turnWorkMode });
  }

  /** Persist the exchange (user, any mid-turn steers, assistant); returns the
   *  assistant message id (the turn id the outcome ledger keys on), or null
   *  when persistence is disabled. */
  private persist(userText: string, steeredTexts: ReadonlyArray<string>, assistantText: string): string | null {
    if (!this.persistMessagesEnabled) return null;
    const msgId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    void this.rt.storage.sql`INSERT INTO messages (id, session_id, role, content)
      VALUES (${msgId}, ${this.sessionId}, ${'user'}, ${userText})`;
    let parentId = msgId;
    for (const steered of steeredTexts) {
      const steerId = crypto.randomUUID();
      void this.rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
        VALUES (${steerId}, ${this.sessionId}, ${parentId}, ${'user'}, ${steered})`;
      parentId = steerId;
    }
    void this.rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
      VALUES (${assistantId}, ${this.sessionId}, ${parentId}, ${'assistant'}, ${assistantText})`;
    return assistantId;
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
      // The newest message is always restored: a single message larger than
      // the whole window is the compaction ladder's problem, not a reason to
      // open the session with an empty transcript.
      if (restored.length > 0 && tokens + cost > budget) { omitted++; continue; }
      tokens += cost;
      restored.push({ role: row.role, content: row.content });
    }
    if (omitted > 0) this.history.push(olderHistoryNotice(omitted, this.sessionId));
    this.history.push(...restored.reverse());
  }

  private normalizeModelSpec(spec: string | null): string {
    if (this.modelResolver) return this.modelResolver.normalizeSpecSync(spec);
    const s = (spec ?? '').trim();
    if (!s || s === this.fallbackModelSpec) return this.fallbackModelSpec;
    throw new Error('Model switching is unavailable for this local session; construct it with a modelResolver.');
  }

  /** The model spec every turn resolves against — the stored/claimed one, or
   *  the constructed fallback before a model has been claimed. */
  private effectiveModelSpec(): string {
    return this.cachedModelSpec ?? this.fallbackModelSpec;
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
    const spec = this.normalizeModelSpec(this.config.getModel());
    if (this.cachedModel && this.cachedModelSpec === spec) return this.cachedModel;
    const model = this.modelResolver ? this.modelResolver.resolveModel(spec) : this.fallbackModel;
    this.cachedModel = model;
    this.cachedModelSpec = spec;
    // Start the catalog lookup at claim time rather than at first use. A CLI
    // process is short-lived — `proteus exec` runs ONE turn — so a lookup that
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

  private rebuildModelBoundState(model: LanguageModel): void {
    // Branching heads — in-process runtime + controller (drives think strategy=heads).
    // The agent's VFS backs the shared findings scratch sibling heads write to.
    this._headRuntime = createCLIHeadRuntime({
      model,
      providerFamily: parseModelSpec(this.effectiveModelSpec()).provider,
      parentRuntime: this.rt,
      cwd: this.cwd,
      webSearch: this.getWebSearchProvider(),
      codemodeExtras: () => this.headCodemodeExtras(),
      grounding: this.buildHeadGrounding(),
      governor: () => this.budget,
      journal: () => this.headJournal,
    });
    this.headController = new HeadController(this._headRuntime, this.headJournal);

    for (const mode of ['build'] as const) {
      const raw = buildBuiltinTools({
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
          extraProviders: [
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
          createTasksCodemodeProvider(this.taskList, this.config),
          // `release.*` — left the native surface for codemode-only reach
          // (tools/release-codemode.ts); deps read live so a rebind lands
          // without rebuilding this toolset.
          ...(mode === 'build' ? [createReleaseCodemodeProvider(() => this.releaseToolDeps())] : []),
          // llm.query (RLM) — CLI parity with the cf backend. Needs a real
          // resolver to spawn sub-calls; static-model sessions have none.
          ...(this.modelResolver
            ? [createRLMProvider(this.modelResolver, () => this.getEffectiveModelSpec())]
            : []),
          ],
        }),
        codemodeLoader: { __cli: true },
        agents: this.agentsToolDeps(mode),
        facts: this.factsStore,
        webSearch: this.getWebSearchProvider(),
      });
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

/** Merge drained steers into ONE user ModelMessage — text joined in arrival
 *  order, attachments carried as file parts (the runChat user-message shape). */
function steerUserMessage(drained: ReadonlyArray<{ text: string; files?: ReadonlyArray<PromptFile> }>): ModelMessage {
  const text = drained.map((steer) => steer.text).join('\n\n');
  const files = drained.flatMap((steer) => steer.files ?? []);
  if (files.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      ...files.map((f) => ({ type: 'file' as const, data: f.url, mediaType: f.mediaType, filename: f.filename })),
      { type: 'text' as const, text },
    ],
  };
}

export { serializeContentForHeads } from '@proteus/core';

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

function errorMessage(input: { error: unknown }): string {
  const error = v.safeParse(v.instance(Error), input.error);
  return error.success ? error.output.message : String(input.error);
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
