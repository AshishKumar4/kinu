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
import {
  createCompactionExtension, createVfsTranscriptStore,
  createCompactionStateStore, initCompactionStateTable, createModelSummarizer,
  type CompactionStateStore,
} from '@proteus/compaction';
import type {
  AgentRuntime, LLMProviderConfig, CompletedTurn, TurnContinuity, FiberCtx,
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult, PromptFile,
  SessionWriter, SkillsVfs, ActiveSkillSet, FactsStore, ProteusExtension,
  HeadRuntime, HeadGrounding, MergeResult, SerializedMessage, SplitPhaseEvent, AgentConfigStore, ShellApprovalMode,
  ShellApprovalRequest, ShellApprovalOutcome,
  AgentsForkDeps, AgentsToolDeps,
  IngressDescriptor, ProteusEvent, EventVariant,
  RunEvent, RunEventInput, RunEventQuery,
  ProductChangeStore, ProductChangeToolDeps, BuiltinToolName,
  FileCheckpoints, FileCheckpointEntry, FileRestorePlan, FileRestoreResult, CheckpointAvailability,
} from '@proteus/core';
import {
  AgentOrchestrator,
  BackgroundJobStore, BackgroundJobRunner, JobNotResumable, initBackgroundJobsTable,
  wrapToolsForBackground, resumeForkBackgroundJob, BACKGROUND_POLICY, type BackgroundPolicy,
  MctsSearchStore, createDurableMctsSession,
  EventLog, initEventsHubTables,
  RunEventRecorder, initRunEventTables,
  TriggerRegistry, nextCronFire,
  EvolutionEngine,
  initAgentConfigTable, createAgentConfigStore,
  initFactsTable, createFactsStore, initImportedExperienceTable, readMemoryTail,
  initCurriculumTable, proposeNextTasks, listProposedTasks, updateProposedTaskStatus,
  buildStrategyForkDeps, agentsActionsFor,
  HeadController, HeadJournal, initHeadsTables,
  skillsVfsOver, resolveTurnSkills, filterToolSetBySkills, renderFactsForTurn,
  recordGroundedHeadsTake, inheritedContextFromHistory,
  ModelCatalogSession,
  BUILTIN_TOOL_NAMES, isMcpToolKey,
  buildBuiltinTools, withClampedToolResults, buildSystemPromptSync, currentDateForPrompt, promptModeForTurnEvent,
  createChatModel, runChat, resolveMaxSteps,
  parseModelSpec, agentAffinityKey,
  OVERFLOW_RETRY_EVENT,
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery,
  CompletionGate, observeCompletionState, completionGateText, COMPLETION_GATE_EVENT,
  ExtensionHost, StepInjections,
  createDefaultWebSearchProvider, createWebCodemodeProvider, createRLMProvider, type WebSearchProvider,
  createAgentsCodemodeProvider, type CodemodeProvider,
  MissionGovernor,
  DynamicContextLedger, turnLocalContextMessage, fnv1a64, forkDelegates, type DynamicContext,
  type MediaModality,
  createProductChangeStore, initProductChangeTables, productChangeSqlFromExec,
  listReplayEvals, type ReplayEvalSummary,
  buildChangelog, countUnseenChangelog, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogRevertResult,
  claimAlternateTakesForTurn, purgeUnclaimedAlternateTakes, latestAlternateTakeSet, recordTakePick,
  buildTakeContinuationPrompt, getCurrentScaffoldVersion,
  scaffoldChatTransform, type ScaffoldRunOptions,
  bootstrapScaffold,
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory, runSampledShadowEval,
  createStructuredJudge, modifyScaffold, listScaffoldArchive,
  getPendingScaffold, decidePromotion, applyPromotionDecision, DEFAULT_SHADOW_CONFIG,
  initShadowTables,
  type AlternateTakeSet, type TakePickOutcome,
  initAlternateTakesTable, startBranchHead, settlePendingBranch, newBranchId,
  type PendingBranch, type BranchStatusEvent,
  type AlarmScheduler, type TriggerRow, type TrustLevel, type BackgroundJob,
  isReasoningEffort, reasoningEffortOptions, REASONING_EFFORT_FOR_STAGE,
  type ReasoningEffort, type CacheRetention, type SqlExec,
} from '@proteus/core';
import { discoverAgentsMd } from './agents-md.js';
import { createNodeCraftedExecute } from './craft-executor.js';
import { createNodeExecuteToolFactory } from './execute-tools-factory.js';
import { createLocalAgentSelfProvider } from './agent-self.js';
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

function providerFamilyForSpec(spec: string): string | undefined {
  try { return parseModelSpec(spec).provider; }
  catch { return undefined; }
}

/** A scaffold turn is a whole agentic loop, not a tool call — it gets the
 *  same wall-clock budget the DO gives it. */
const SCAFFOLD_TURN_TIMEOUT_MS = 5 * 60 * 1000;

/** The minimal bun:sqlite handle the EventsHub SqlExec adapter needs. */
export interface LocalSessionDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void };
}

/** What the frontends render. A superset of runChat's ChatEvent with the
 *  lifecycle + side-channel (evolution, broadcast, background) events. */
export type SessionEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: Record<string, unknown> }
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

export interface LocalTimerTriggerOpts {
  cron?: string;
  atMs?: number;
  label?: string;
  payload?: Record<string, unknown>;
  trust?: 'authenticated' | 'owner';
  /** The mission budget every turn this schedule wakes spends against. */
  missionLabel?: string;
}

export interface LocalTriggerView {
  id: string;
  kind: string;
  spec: Record<string, unknown>;
  creator_trust: TrustLevel;
  state: TriggerRow['state'];
  created_at: number;
  paused_at: number | null;
  revoked_at: number | null;
  rate_limit_per_min: number;
  next_fire_at: number | null;
  last_fire_at: number | null;
  fire_count: number;
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
  /** Number of recent messages to restore into LLM context. Default: 40. */
  historyLimit?: number;
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
  private readonly engine: EvolutionEngine;
  private readonly orch: AgentOrchestrator;
  private readonly jobs: BackgroundJobStore;
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
  private readonly productChanges: ProductChangeStore;
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

  /** Skills invoked this turn (explicit/auto-activation + the skills tool's
   *  `invoke` action). Cleared at turn start; the skills tool's closures mutate
   *  this stable Set, so the cached toolset never needs rebuilding. */
  private readonly turnInvokedSkills = new Set<string>();
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
    });
    this.engine.onEvent((e) => this.emit({ type: 'evolution', event: e.type, message: e.message }));

    // Background-job lifecycle over the durable local fiber (createLinuxFiber) +
    // this session as the BackendHost (enqueueTurn wakes the agent).
    initBackgroundJobsTable(this.rt.storage.execRaw);
    this.jobs = new BackgroundJobStore(this.rt.storage.sql);
    this.headJournal = new HeadJournal(this.rt.storage.sql);
    this.mctsSearchStore = new MctsSearchStore(this.rt.storage.sql);
    // agent_config (typed key/value) — backs always-active skills, etc.
    initAgentConfigTable(this.rt.storage.execRaw);
    this.config = createAgentConfigStore(this.rt.storage.sql);

    // Shadow-rollout ledger (scaffold_evaluations). Provisioned at session
    // init, exactly as the DO does — creation-time-only would leave every
    // workspace made before this silently unable to record a trial.
    initShadowTables(this.rt.storage.execRaw);

    // agent_facts world model — backs `memory`'s keyed-fact actions
    // (remember/recall/forget), parity with the DO.
    initFactsTable(this.rt.storage.execRaw);
    this.factsStore = createFactsStore(this.rt.storage.sql);

    // Imported-experience staging ledger. A local session has no owner library
    // to import FROM (no `experience` tool without a UserDO), but a workspace
    // that imported in the cloud and is later driven from here must still be
    // able to settle what is staged, so the ledger exists on both backends.
    initImportedExperienceTable(this.rt.storage.execRaw);

    // Better-compact is THE default (and only) compaction path — the same
    // staged transformContext ladder the cloud backend registers, over the
    // same shared stores (transcripts in the composite VFS, plan + trigger
    // state in agent.db). The summarizer rides the session's active model.
    initCompactionStateTable(this.rt.storage.execRaw);
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

    // Voyager-style curriculum table (agent.* parity with the DO).
    initCurriculumTable(this.rt.storage.execRaw);

    initHeadsTables(this.rt.storage.execRaw);
    this._headRuntime = createCLIHeadRuntime({
      model: this.fallbackModel,
      providerFamily: providerFamilyForSpec(this.fallbackModelSpec),
      parentRuntime: this.rt,
      cwd: this.cwd,
      webSearch: this.getWebSearchProvider(),
      codemodeExtras: () => this.headCodemodeExtras(),
      grounding: this.buildHeadGrounding(),
    });
    this.headController = new HeadController(this._headRuntime, this.headJournal);

    // The EventsHub substrate (reactor source of truth). Local external
    // ingresses enter through publishEvent(), then drain via AgentOrchestrator.
    const hubSql = makeHubSql(opts.db);
    initEventsHubTables(hubSql);
    initProductChangeTables(hubSql);
    this.productChanges = createProductChangeStore(productChangeSqlFromExec(hubSql), {
      validateAgentName: (name) => {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('invalid agent name');
      },
    });
    this.eventLog = new EventLog(hubSql);
    const alarmScheduler: AlarmScheduler = {
      scheduleAt: (ts) => this.scheduleLocalAlarm(ts),
      currentAlarm: () => this.scheduledAlarmAt,
    };
    this.triggerRegistry = new TriggerRegistry(hubSql, alarmScheduler);

    // The durable per-run event log (run_events) — the same recorder, table and
    // RunEvent union the cloud backend records, over local SQLite. Without it a
    // local workspace had no replayable run history at all.
    initRunEventTables(this.rt.storage.execRaw);
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
        onStepEvent: (ev) => this.recordRunEvent({
          type: 'step_finish', stepIndex: ev.stepIndex, reason: ev.reason,
        }),
      },
    });
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
      resume: (kind, input, signal) => this.resumeBackgroundJob(kind, input, signal),
    });
    // Scaffold cold-start heal (the DO's onStart parity): a workspace created
    // before scaffold bootstrap landed has no scaffold/agent.js, and
    // engine.maybeEvolveScaffold returns early when it is absent — silently
    // disabling the WHOLE scaffold-evolution loop on that workspace forever.
    // bootstrapScaffold is idempotent (exists-check + INSERT OR IGNORE v0);
    // tracked so end()/settleEvolution joins it before the process exits.
    this.orch.track(bootstrapScaffold(this.rt), 'Scaffold bootstrap');
    this.restoreHistory(opts.historyLimit ?? 40);
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
      name, description: (t as { description?: string }).description ?? '',
    }));
  }

  /** Skills pinned always-active for this agent (the `/always` command). */
  getAlwaysActiveSkills(): string[] { return this.config.getAlwaysActiveSkills(); }
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void { this.config.setAlwaysActiveSkills(names); }

  /** Shadow-git file checkpoints (newest first) for /undo. Empty when git is
   *  unavailable — checkpointStatus() carries the honest reason. */
  listFileCheckpoints(limit?: number): Promise<FileCheckpointEntry[]> {
    return this.rt.checkpoints?.list(limit) ?? Promise.resolve([]);
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
    return { mode: this.config.getShellApprovalMode() };
  }

  setShellApprovalMode(mode: ShellApprovalMode): { ok: true; mode: ShellApprovalMode } {
    this.config.setShellApprovalMode(mode);
    this.invalidateModelState();
    this.ensureModelState();
    return { ok: true, mode };
  }

  /** Install the interactive approval channel for gated shell commands, or
   *  null to remove it. Surfaces that own a live user (ACP) set this; without
   *  one, 'strict' keeps rejecting gate hits with its explanatory message.
   *  Returns a disposer so a surface can detach on disconnect. */
  setShellApprovalHandler(handler: ShellApprovalHandler | null): () => void {
    this.shellApprovalHandler = handler;
    return () => { if (this.shellApprovalHandler === handler) this.shellApprovalHandler = null; };
  }

  /** Stored model spec, or null when unset (parity with DO getStoredModelSpec). */
  getStoredModelSpec(): { spec: string | null } {
    return { spec: this.config.getModel() };
  }

  /** Effective normalized model spec used for new turns. */
  getEffectiveModelSpec(): string {
    return this.normalizeModelSpec(this.config.getModel());
  }

  /** Validate + store a new model spec. Effective on the next turn and for new
   *  think/head runs, matching the DO backend's setModel behavior. */
  setModel(spec: string): { ok: true; spec: string } {
    const normalized = this.normalizeModelSpec(spec);
    this.config.setModel(normalized);
    this.invalidateModelState();
    this.ensureModelState();
    return { ok: true, spec: normalized };
  }

  getReasoningEffort(): { effort: ReasoningEffort | null } {
    return { effort: this.config.getReasoningEffort() };
  }

  setReasoningEffort(effort: unknown): { ok: true; effort: ReasoningEffort } {
    if (!isReasoningEffort(effort)) throw new Error(`Invalid reasoning effort: ${String(effort)}`);
    this.config.setReasoningEffort(effort);
    return { ok: true, effort };
  }

  listModelProviders() {
    return this.modelResolver?.listProviders() ?? Promise.resolve([]);
  }

  listAvailableModels() {
    return this.modelResolver?.listModels() ?? Promise.resolve([]);
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

  listTriggers(): { triggers: LocalTriggerView[] } {
    return { triggers: this.triggerRegistry.list().map(triggerToView) };
  }

  cancelTrigger(trigger_id: string): { ok: true; changed: boolean } {
    const changed = this.triggerRegistry.revoke(trigger_id, Date.now());
    this.rearmLocalAlarm();
    return { ok: true, changed };
  }

  createTimerTrigger(opts: LocalTimerTriggerOpts): { id: string; kind: 'timer_cron' | 'timer_oneshot'; nextFireAt: number | null } {
    const now = Date.now();
    const kind: 'timer_cron' | 'timer_oneshot' = opts.cron ? 'timer_cron' : 'timer_oneshot';
    const nextFireAt = opts.cron ? nextCronFire(opts.cron, now) : (opts.atMs ?? null);
    if (opts.cron && nextFireAt === null) throw new Error(`Unsupported cron expression: ${opts.cron}`);
    if (!opts.cron && nextFireAt === null) throw new Error('Timer trigger requires cron or atMs');
    const id = this.triggerRegistry.register({
      kind,
      spec: { cron: opts.cron, label: opts.label, payload: opts.payload, mission_label: opts.missionLabel },
      creator_trust: opts.trust ?? 'authenticated',
      next_fire_at: nextFireAt ?? undefined,
    }, now);
    return { id, kind, nextFireAt };
  }

  async fireDueTriggers(now = Date.now()): Promise<{ fired: number; nextAlarmAt: number | null }> {
    if (this.ended) return { fired: 0, nextAlarmAt: null };
    if (this.scheduledAlarmAt !== null && this.scheduledAlarmAt <= now) this.clearLocalAlarm();
    const due = this.triggerRegistry.due(now);
    let fired = 0;
    for (const trigger of due) {
      if (trigger.kind !== 'timer_cron' && trigger.kind !== 'timer_oneshot') continue;
      fired += 1;
      const spec = trigger.spec as { label?: string; payload?: unknown; cron?: string; mission_label?: string };
      const scheduled_fire_at = trigger.next_fire_at ?? now;

      this.eventLog.publish({
        descriptor: {
          ingress: 'timer_alarm',
          variant: 'timer',
          payload: {
            trigger_id: trigger.id,
            scheduled_fire_at,
            label: spec.label,
            user_payload: spec.payload,
            mission_label: spec.mission_label,
          },
          trigger_creator_trust: trigger.creator_trust,
        },
        now,
      });

      if (trigger.kind === 'timer_cron') {
        const next = spec.cron ? nextCronFire(spec.cron, now) : null;
        this.triggerRegistry.markFired(trigger.id, now, next);
      } else {
        this.triggerRegistry.markFired(trigger.id, now, null);
        this.triggerRegistry.revoke(trigger.id, now);
      }
    }

    if (fired > 0) this.orch.scheduleDrain();
    this.rearmLocalAlarm();
    return { fired, nextAlarmAt: this.scheduledAlarmAt };
  }

  async jobResult(jobId: string): Promise<BackgroundJob | null> {
    try { return this.jobs.get(jobId); } catch { return null; }
  }

  async listBackgroundJobs(limit = 20): Promise<BackgroundJob[]> {
    try { return this.jobs.list(limit); } catch { return []; }
  }

  cancelBackgroundJob(jobId: string): { ok: boolean } {
    return { ok: this.jobRunner.cancel(jobId) };
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
  getEvolutionChangelog(limit = 50): { entries: ChangelogEntry[]; unseenCount: number; seenAt: number } {
    const seenAt = this.config.getChangelogSeenAt();
    return {
      entries: buildChangelog(this.rt.storage.sql, { limit }),
      unseenCount: countUnseenChangelog(this.rt.storage.sql, seenAt),
      seenAt,
    };
  }

  /** The operator viewed the changelog — zero the unseen badge. */
  markChangelogSeen(): { ok: true; seenAt: number } {
    const seenAt = Date.now();
    this.config.setChangelogSeenAt(seenAt);
    return { ok: true, seenAt };
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
    const record = recordTakePick(this.rt.storage.sql, {
      takeId, nodeId,
      scaffoldVersion: getCurrentScaffoldVersion(this.rt.storage.sql),
    });
    await this.engine.applyTakePick(record.set.turnId, record.outcome);
    let continuationQueued = false;
    if (record.changedAnswer) {
      void this.orch.signals.deliver({
        kind: 'take_pick',
        text: buildTakeContinuationPrompt(record.set, record.chosen),
      });
      continuationQueued = true;
    }
    return { ...record, continuationQueued };
  }

  async proposeCurriculumTasks(count?: number) {
    return proposeNextTasks({
      rt: this.rt,
      judge: this.rt.judgeModel ?? this.rt.llm,
      count,
    });
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
    return {
      executor: this.rt.executor,
      explorer: this.rt.llm,
      ...(this.rt.judgeModel ? { judge: this.rt.judgeModel } : {}),
    };
  }

  /** The codemode namespaces a head's execute_tools gets beyond its runtime's
   *  own executors: `web.*` and (when a resolver exists) `llm.query`. Pointedly
   *  NOT `agents.*`/`agent.*` — a head forks its parent's resources, never its
   *  authority to delegate. */
  private headCodemodeExtras(): CodemodeProvider[] {
    return [
      createWebCodemodeProvider(this.getWebSearchProvider()),
      ...(this.modelResolver
        ? [createRLMProvider(this.modelResolver, () => this.getEffectiveModelSpec())]
        : []),
    ];
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
      void fn().catch((err: unknown) =>
        console.warn('[proteus] drain timer callback failed:', (err as Error).message));
    }, ms);
  }

  /** Inject a programmatic turn into the same serialized loop the user drives —
   *  backs the reactor + background-job wake. Self-starts the pump when idle so
   *  a job that settles mid-idle wakes the agent immediately. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
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
    const { text, files } = typeof input === 'string' ? { text: input, files: undefined } : input;
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
    const { text, files } = typeof input === 'string' ? { text: input, files: undefined } : input;
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
    initAlternateTakesTable(this.rt.storage.execRaw);
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
  }

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
    try { await this.mcpClose?.(); } catch { /* best effort */ }
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
    this.backgroundFibers.add(running);
    void running.catch(() => { /* the runner owns the outcome */ })
      .finally(() => this.backgroundFibers.delete(running));
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
        this.emit({
          type: 'evolution', event: 'bg_jobs_abandoned',
          message:
            `${this.backgroundFibers.size} background job(s) did not finish in time and were left running; ` +
            'their results are not part of this run.',
        });
        return false;
      }
      await raceDeadline(Promise.allSettled([...this.backgroundFibers]), remaining);
    }
    return true;
  }

  /**
   * Recover background jobs orphaned by a previous CLI exit (durable detach). An
   * interrupted bg:* fiber leaves a row stashed phase 'running': a checkpoint-
   * backed kind is re-driven under a fresh lease epoch, anything else fails +
   * wakes (DO onFiberRecovered parity). Then clear all stale fiber rows from the
   * prior run — a resume runs in a NEW fiber row, so this never deletes it.
   * Call once at startup (no fibers are live yet, so every row is an orphan).
   */
  async recoverBackgroundJobs(): Promise<void> {
    let orphans: ReturnType<typeof detectOrphanedFibers>;
    try { orphans = detectOrphanedFibers(this.rt.storage.sql); } catch { return; }
    for (const o of orphans) {
      if (o.name.startsWith('bg:')) {
        try { await this.jobRunner.recover(o.snapshot); } catch { /* best effort */ }
      }
      try { this.rt.storage.sql`DELETE FROM fibers WHERE id = ${o.id}`; } catch { /* nop */ }
    }
  }

  /** Re-drive a background job interrupted by a previous process exit — the
   *  shared fork-only resume gate (core background-tools) over the RAW
   *  surface, so a re-drive can't detach a second job. Legacy 'think' jobs
   *  translate onto the same fork path; the model-bound surface resolves
   *  inside the thunk, only for a resumable kind. */
  private resumeBackgroundJob(kind: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    return resumeForkBackgroundJob(() => {
      this.ensureModelState();
      return this.rawTools;
    }, kind, input, signal);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private emit(event: SessionEvent): void {
    try { this.onEvent(event); } catch { /* a frontend render error must not kill the loop */ }
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
      .filter((t): t is number => typeof t === 'number')
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

  /** Append to the durable run-event log, scoped to the in-flight run. Never
   *  throws: losing a history row must not fail a turn. */
  private recordRunEvent(input: RunEventInput): void {
    if (!this.currentRunId) return;
    try { this.eventRecorder.emit(this.currentRunId, input); }
    catch (err) { console.warn('[proteus] run event emit failed:', err); }
  }

  /** Seal the in-flight run via the shared core turn-lifecycle bracket.
   *  Idempotent per run — clearing the id makes a second call a no-op. */
  private closeRun(error: string | null): void {
    if (!this.currentRunId) return;
    closeTurnRun(this.eventRecorder, this.currentRunId, {
      turnIndex: this.orch.sessionTurnIndex,
      usage: this.orch.acc.usage,
      context: this.orch.acc.context,
      steering: this.orch.steering.snapshot(),
      completionGate: this.completionGate.take(),
      craft: this.orch.craft.snapshot(),
      reason: this.orch.acc.hadError ? 'error' : 'completed',
      ...(error ? { error } : {}),
    });
    this.currentRunId = null;
  }

  /** A single run's durable events — the local peer of the DO's getRunEvents,
   *  and what an SSE resume replays from (`since` = last seen index). */
  getRunEvents(runId: string, opts: RunEventQuery = {}): RunEvent[] {
    try { return this.eventRecorder.read(runId, opts); }
    catch { return []; }
  }

  /** Recent runs, newest first — the local peer of the DO's listRuns. */
  listRuns(limit = 50): Array<{ runId: string; lastTs: string; eventCount: number }> {
    try { return this.eventRecorder.listRuns(limit); }
    catch { return []; }
  }

  private async processTurn(item: QueueItem): Promise<void> {
    const event = typeof item.metadata?.proteusEvent === 'string' ? item.metadata.proteusEvent : undefined;
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
    this.turnInvokedSkills.clear();
    const model = this.ensureModelState();

    // MEMORY.md is append-only — the TAIL holds the newest lessons/reflections.
    // It is per-turn-read live state (lessons/reflections/take-pick
    // corrections append constantly), so it rides the dynamic-context
    // ledger: in the stable prefix every append would bust the cache and
    // trip the prompt-hash telemetry with no real agent event.
    const memoryTail = await readMemoryTail(this.rt.memory);
    const executors = this.rt.executionRouter?.listExecutors() ?? [];
    const activeSkills = await this.resolveTurnSkills(item.text);
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
    const systemPrompt = buildSystemPromptSync(this.rt, {
      executors,
      availableTools: availableBuiltins,
      agentsActions: agentsActionsFor({ fork: true }),
      // Matches the execute_tools wiring: llm.query exists only with a resolver.
      rlmAvailable: this.modelResolver !== null,
      externalTools,
      backend: 'cli-local',
      mode: promptModeForTurnEvent(event),
      model: { id: this.effectiveModelSpec() },
      cwd: this.cwd,
      currentDate: currentDateForPrompt(),
      ...(agentsMd.length > 0 ? { agentsMd } : {}),
      ...(activeSkills ? { activeSkills } : {}),
    });
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

    const pendingCalls: Array<{ toolName: string; toolCallId: string; args: Record<string, unknown> }> = [];
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

    const defaultTurn = runChat({
      model,
      modelContext: { id: this.effectiveModelSpec(), contextWindow },
      system: systemPrompt,
      history: this.history,
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
      ...(lastPromptTokens !== null ? { providerReportedTokens: lastPromptTokens } : {}),
      transformTrigger,
      maxSteps: resolveMaxSteps(process.env.PROTEUS_MAX_STEPS),
      signal: abort.signal,
      extensions,
      cache,
      budget: this.budget,
      ...(providerOptions ? { providerOptions } : {}),
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
          case 'step-finish':
            this.orch.acc.recordStep(
              ev.inputTokens !== undefined || ev.outputTokens !== undefined || ev.cachedInputTokens !== undefined
                ? { usage: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedInputTokens: ev.cachedInputTokens } }
                : {},
            );
            break;
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
    const snapshotTurn = (): CompletedTurn => snapshotCompletedTurn(this.orch.acc, {
      userMessage: item.text,
      assistantResponse: fullText,
      ...(assistantMsgId ? { turnId: assistantMsgId } : {}),
      sessionId: this.sessionId,
      origin: item.kind,
    });

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
      await this.applyCompletionGate(runError === null);

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
      try {
        if (assistantMsgId && !this.orch.acc.hadError) {
          claimAlternateTakesForTurn(this.rt.storage.sql, {
            turnId: assistantMsgId, sessionId: this.sessionId, startedAt,
          });
        } else {
          purgeUnclaimedAlternateTakes(this.rt.storage.sql);
        }
      } catch { /* no takes table yet — the first MCTS run creates it */ }

      // Steer-as-Branch redirects launched during this turn settle against its
      // answer — detached, so a slow branch never delays turn-end.
      this.settlePendingBranches(this.orch.acc.hadError ? null : assistantMsgId, fullText);

      // The confirming turn is over: what the agent did with its free re-look
      // IS the gate's conversion number, and closeRun writes it.
      if (event === COMPLETION_GATE_EVENT) {
        this.completionGate.settle({ toolCalls: this.orch.acc.toolCalls.length });
      }

      const turn = snapshotTurn();
      this.closeRun(runError);
      // Cadence (turn + session evolution) + the reactor drain — may enqueue more.
      await this.orch.completeTurn(turn, this.turnContinuity);
      // Sampled auto-judge shadow rollout. Tracked rather than fire-and-forget:
      // a `proteus exec` process exits the moment the turn ends, and the
      // evaluation that resolves a pending scaffold must not die with it.
      this.orch.track(
        this.runShadowEvalSampled({
          task: item.text, currentOutput: fullText, model, tools: turnTools, system: systemPrompt,
        }),
        'Scaffold shadow eval',
      );
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
      this.emit({ type: 'turn-end', turn: snapshotTurn() });
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
    }).catch(() => null);
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
    if (this.pendingBranches.length === 0) return;
    const deps = {
      sql: this.rt.storage.sql,
      sessionId: this.sessionId,
      broadcast: (event: BranchStatusEvent) => this.broadcast(event),
    };
    for (const entry of this.pendingBranches.splice(0)) {
      void settlePendingBranch(deps, entry, turnId, liveText);
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
  private cacheIdentity(): { providerId?: string; modelId?: string; sessionKey: string; retention: CacheRetention } {
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

  private productChangeToolDeps(): ProductChangeToolDeps {
    return {
      board: async () => this.productChanges.board(this.agentName(), 20),
      bindSource: async (input) => this.productChanges.upsertSourceBinding(input),
      create: async (input) => this.productChanges.createChange(this.agentName(), input),
      update: async (changeId, patch) => this.productChanges.updateChange(changeId, patch),
      transition: async (changeId, status) => this.productChanges.transitionChange(changeId, status),
      recordCheck: async (changeId, input) => this.productChanges.recordCheck(changeId, input),
      requestApproval: async (changeId, approvalType) => this.productChanges.requestApproval(changeId, approvalType),
      recordDeployment: async (changeId, input) => this.productChanges.recordDeployment(changeId, input),
    };
  }

  /** Web search + fetch provider — node fetch, key-less by default
   *  (DuckDuckGo + local HTML→markdown); a stored `tavily` credential resolved
   *  through the model resolver's auth store upgrades search. */
  private getWebSearchProvider(): WebSearchProvider {
    if (this._webSearchProvider) return this._webSearchProvider;
    const getAuth = this.modelResolver?.getAuth;
    this._webSearchProvider = createDefaultWebSearchProvider({
      fetch: globalThis.fetch,
      ...(getAuth ? { getAuth } : {}),
    });
    return this._webSearchProvider;
  }

  /** Resolve the skills active for this turn (core turn-surface — the SAME
   *  resolution the DO's beforeTurn runs). */
  private resolveTurnSkills(userText: string): Promise<ActiveSkillSet | undefined> {
    return resolveTurnSkills({
      vfs: this.getSkillsVfs(),
      config: this.config,
      userText,
      invoked: this.turnInvokedSkills,
    });
  }

  /** Restrict the turn's toolset to the active skills' allowed_tools union
   *  (core turn-surface; the skills tool stays reachable). */
  private filterToolsBySkills(activeSkills?: ActiveSkillSet): ToolSet {
    return filterToolSetBySkills(this.tools, activeSkills);
  }

  /**
   * Sampled per-turn auto-judge shadow rollout — the local peer of the DO's
   * runShadowEvalSampled, and the ONLY thing that can resolve a pending
   * scaffold. Without it the evolution engine proposes exactly one scaffold
   * ever (engine.maybeEvolveScaffold refuses to propose while one is pending)
   * and that proposal is never evaluated, promoted, or rolled back.
   *
   * Runs the pending against the same task the user just sent, with the same
   * tool surface the live turn had, and judges the two outputs. `autoApply`
   * follows agent_config.auto_promote_scaffold (default ON — every applied
   * decision is visible and revertable in the Evolution Changelog).
   */
  private async runShadowEvalSampled(opts: {
    task: string; currentOutput: string; model: LanguageModel; tools: ToolSet; system: string;
  }): Promise<void> {
    const result = await runSampledShadowEval({
      rt: this.rt,
      config: this.config,
      task: opts.task,
      currentOutput: opts.currentOutput,
      judge: createStructuredJudge(this.rt.judgeModel ?? this.rt.llm),
      llmStream: this.makeScaffoldLLMStream(opts.model, opts.tools),
      callTool: this.makeScaffoldCallTool(opts.tools),
      history: this.makeScaffoldHistory(),
      // A pending that delegates is judged on the scaffold delta alone, so
      // it gets a real default turn for the shadow task — same system prompt
      // and tool surface, isolated history.
      defaultInference: () => runChat({
        model: opts.model,
        modelContext: { id: this.cachedModelSpec ?? this.fallbackModelSpec },
        system: opts.system,
        history: [{ role: 'user', content: opts.task.slice(0, 2000) }],
        tools: opts.tools,
        maxSteps: resolveMaxSteps(process.env.PROTEUS_MAX_STEPS),
      }),
    });
    if (result?.applied) {
      this.emit({
        type: 'evolution',
        event: result.applied === 'promote' ? 'scaffold_promotion' : 'scaffold_rollback',
        message: `Shadow eval ${result.applied}d the pending scaffold`,
      });
      this.invalidateModelState();
    }
  }

  /** The pending scaffold's rollout state — trials so far and what the
   *  promotion gate currently says. */
  getShadowStatus() {
    const pending = getPendingScaffold(this.rt.storage.sql);
    if (!pending) return { hasPending: false as const, versions: this.listScaffoldVersions(10) };
    return {
      hasPending: true as const,
      pending,
      decision: decidePromotion(pending, DEFAULT_SHADOW_CONFIG),
      config: DEFAULT_SHADOW_CONFIG,
    };
  }

  /** Resolve the pending scaffold by hand. 'auto' acts only on a conclusive
   *  promotion gate; 'promote'/'rollback' force the corresponding action. */
  async applyScaffoldDecision(mode: 'auto' | 'promote' | 'rollback') {
    const pending = getPendingScaffold(this.rt.storage.sql);
    if (!pending) return { ok: false as const, error: 'no pending scaffold' };
    let decision: 'promote' | 'rollback';
    if (mode === 'auto') {
      const auto = decidePromotion(pending, DEFAULT_SHADOW_CONFIG).decision;
      if (auto === 'continue') return { ok: false as const, error: 'inconclusive; need more trials' };
      decision = auto;
    } else {
      decision = mode;
    }
    const result = await applyPromotionDecision(this.rt, pending, decision);
    this.invalidateModelState();
    return { ok: true as const, ...result };
  }

  /** Propose a new scaffold version through the existing 4-gate pipeline. An
   *  accepted proposal lands as `pending` and is resolved by the shadow eval. */
  async proposeScaffold(rationale: string, code: string, baseVersion?: number) {
    return modifyScaffold(
      this.rt, rationale, code,
      baseVersion !== undefined ? { baseVersion } : undefined,
    );
  }

  /** Read-only scaffold archive: versions with status, lineage and shadow record. */
  listScaffoldVersions(limit = 20) {
    return listScaffoldArchive(this.rt.storage.sql, limit).map((e) => ({
      version: e.version,
      written_at: e.writtenAt,
      rationale: e.rationale,
      status: e.status,
      parent_version: e.parentVersion,
      trials: e.trials,
      wins: e.wins,
      losses: e.losses,
      ties: e.ties,
      win_rate: e.winRate,
    }));
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
      mode: 'chat',
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
    const factsBlock = this.renderFactsForTurn();
    return {
      ...(factsBlock ? { factsBlock } : {}),
      ...(memoryTail ? { memoryTail } : {}),
      // Re-listed per step: a sandbox provisioned mid-turn flips availability.
      executors: this.rt.executionRouter?.listExecutors() ?? [],
      tasks: this.jobs.listRunning().map((job) => ({ id: job.id, kind: job.kind, label: job.label })),
      delegates: forkDelegates(this.headJournal.listLive()),
    };
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
    const hash = fnv1a64(system);
    if (this.lastSystemPromptHash !== null && this.lastSystemPromptHash !== hash) {
      this.emit({ type: 'evolution', event: 'system_prompt_hash', message: `changed → ${hash}` });
    }
    this.lastSystemPromptHash = hash;
  }

  /** The `agents` tool's fork substrate — the SAME shared factory the DO
   *  wires (core fork-deps): single-shot + MCTS + heads, host-injected infra
   *  recomputed per fork call. MCTS explores over rt.spawnBranch; heads run
   *  in-process via the CLI HeadRuntime. The CLI wires no team or peer
   *  transport, so fork is the tool's only action here. */
  private buildAgentsForkDeps(): AgentsForkDeps {
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
        onPhase: (e: SplitPhaseEvent) => this.emitHeadPhase(e),
        onComplete: (merge: MergeResult, task: string) => this.recordHeadsTake(merge, task),
      },
    });
  }

  /** This session's delegation deps. `team` / `peers` are deliberately absent:
   *  staffing and peer messaging need a cross-agent transport, and local agents
   *  are one-per-process SQLite sessions with no daemon to route between them.
   *  Absent deps → those actions are structurally missing from the `agents`
   *  tool, from the `agents.*` sandbox namespace, and from the prompt ladder.
   *  Hosted agents get the full surface. */
  private agentsToolDeps(): AgentsToolDeps {
    return { fork: this.buildAgentsForkDeps(), budget: this.budget };
  }

  /** The recent conversation handed to each spawned head as inherited context
   *  (core heads-support; capped to bound the head's LLM context). */
  private readInheritedContext(): SerializedMessage[] {
    return inheritedContextFromHistory(this.history);
  }

  /** Fan head_split / head_merge lifecycle out as broadcasts so the frontends
   *  can render the branch timeline, AND into the durable run-event log so the
   *  split's cost and productivity survive the process — the same rows the DO
   *  writes. Broadcast-only was why local runs (every benchmark trial) left no
   *  trace of a fork, and 4-of-5 empty forks had to be found by reading
   *  trajectories by hand. */
  private emitHeadPhase(event: SplitPhaseEvent): void {
    const payload: RunEventInput = event.kind === 'split'
      ? { type: 'head_split', rootId: event.rootId, headIds: [...event.headIds], rationale: event.rationale }
      : {
        type: 'head_merge',
        rootId: event.rootId,
        headCount: event.cost.headCount,
        headsWithFindings: event.cost.headsWithFindings,
        totalTokens: event.cost.totalTokens,
        mergedNarrative: event.mergedNarrative,
      };
    this.broadcast(payload);
    this.recordRunEvent(payload);
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
    return wrapToolsForBackground(raw, { jobRunner: this.jobRunner });
  }

  /** Persist the exchange (user, any mid-turn steers, assistant); returns the
   *  assistant message id (the turn id the outcome ledger keys on), or null
   *  when persistence is disabled. */
  private persist(userText: string, steeredTexts: ReadonlyArray<string>, assistantText: string): string | null {
    if (!this.persistMessagesEnabled) return null;
    const msgId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    this.rt.storage.sql`INSERT INTO messages (id, session_id, role, content)
      VALUES (${msgId}, ${this.sessionId}, ${'user'}, ${userText})`;
    let parentId = msgId;
    for (const steered of steeredTexts) {
      const steerId = crypto.randomUUID();
      this.rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
        VALUES (${steerId}, ${this.sessionId}, ${parentId}, ${'user'}, ${steered})`;
      parentId = steerId;
    }
    this.rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
      VALUES (${assistantId}, ${this.sessionId}, ${parentId}, ${'assistant'}, ${assistantText})`;
    return assistantId;
  }

  private restoreHistory(limit: number): void {
    if (limit <= 0) return;
    try {
      const rows = this.rt.storage.sql<{ role: string; content: string; created_at: number; rowid: number }>`
        SELECT role, content, created_at
        FROM messages
        WHERE session_id = ${this.sessionId} AND role IN ('user', 'assistant')
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${limit}`;
      for (const row of rows.reverse()) {
        if (row.role === 'user' || row.role === 'assistant') {
          this.history.push({ role: row.role, content: row.content });
        }
      }
    } catch {
      // Old or partial databases should still open; they just start with no restored transcript.
    }
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
      providerFamily: providerFamilyForSpec(this.effectiveModelSpec()),
      parentRuntime: this.rt,
      cwd: this.cwd,
      webSearch: this.getWebSearchProvider(),
      codemodeExtras: () => this.headCodemodeExtras(),
      grounding: this.buildHeadGrounding(),
    });
    this.headController = new HeadController(this._headRuntime, this.headJournal);

    const rawTools = buildBuiltinTools({
      rt: this.rt,
      shellApprovalMode: this.config.getShellApprovalMode(),
      // Stable indirection: the toolset is rebuilt only on model change, so it
      // must read the handler live rather than capture whichever was installed
      // when the model was resolved.
      requestShellApproval: async (req) => {
        const outcome = await this.shellApprovalHandler?.(req) ?? null;
        if (outcome === 'allow_always') this.setShellApprovalMode('allow_all');
        else if (outcome === 'deny_always') this.setShellApprovalMode('deny_all');
        return outcome;
      },
      // The turn's cumulative bulk budget — held on the accumulator so this
      // toolset (rebuilt only on model change) reads the live turn's state.
      contextBudget: this.orch.acc.context,
      craftedToolExecute: createNodeCraftedExecute(),
      createExecuteTool: createNodeExecuteToolFactory({
        extraProviders: [
          createLocalAgentSelfProvider(this),
          // `agents.*` — the delegation tool projected into the sandbox, over
          // the same deps the top-level tool holds. Locally that is fork only.
          createAgentsCodemodeProvider(() => this.agentsToolDeps()),
          createWebCodemodeProvider(this.getWebSearchProvider()),
          // llm.query (RLM) — CLI parity with the cf backend. Needs a real
          // resolver to spawn sub-calls; static-model sessions have none.
          ...(this.modelResolver
            ? [createRLMProvider(this.modelResolver, () => this.getEffectiveModelSpec())]
            : []),
        ],
      }),
      codemodeLoader: { __cli: true },
      agents: this.agentsToolDeps(),
      facts: this.factsStore,
      skills: {
        vfs: this.getSkillsVfs(),
        recordInvoke: (name: string) => { this.turnInvokedSkills.add(name); },
        currentlyInvoked: () => Array.from(this.turnInvokedSkills),
      },
      productChanges: this.productChangeToolDeps(),
      webSearch: this.getWebSearchProvider(),
    });
    this.rawTools = rawTools;
    this.tools = this.wrapToolsForBackground(rawTools);
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

/** Adapt a bun:sqlite handle to core's SqlExec primitive (DO storage.sql). */
function makeHubSql(db: LocalSessionDb): SqlExec {
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        const rows = stmt.all(...bindings) as Array<Record<string, unknown>>;
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

function triggerToView(t: TriggerRow): LocalTriggerView {
  return {
    id: t.id,
    kind: t.kind,
    spec: t.spec,
    creator_trust: t.creator_trust,
    state: t.state,
    created_at: t.created_at,
    paused_at: t.paused_at,
    revoked_at: t.revoked_at,
    rate_limit_per_min: t.rate_limit_per_min,
    next_fire_at: t.next_fire_at,
    last_fire_at: t.last_fire_at,
    fire_count: t.fire_count,
  };
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
