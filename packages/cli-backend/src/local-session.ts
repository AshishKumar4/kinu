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
  AgentRuntime, LLMProviderConfig, CompletedTurn,
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult, PromptFile,
  SessionWriter, SessionMessage, SkillsVfs, ActiveSkillSet, FactsStore, ProteusExtension,
  HeadRuntime, HeadGrounding, MergeResult, SerializedMessage, SplitPhaseEvent, AgentConfigStore, ShellApprovalMode,
  IngressDescriptor, ProteusEvent, EventVariant,
  ProductChangeStore, ProductChangeToolDeps, BuiltinToolName, PromptMode,
  FileCheckpoints, FileCheckpointEntry, FileRestorePlan, FileRestoreResult, CheckpointAvailability,
} from '@proteus/core';
import {
  AgentOrchestrator,
  BackgroundJobStore, BackgroundJobRunner, initBackgroundJobsTable, withBackgroundThreshold,
  EventLog, initEventsHubTables,
  TriggerRegistry, nextCronFire,
  EvolutionEngine,
  initAgentConfigTable, createAgentConfigStore,
  initFactsTable, createFactsStore, renderFactsBlock,
  initCurriculumTable, proposeNextTasks, listProposedTasks, updateProposedTaskStatus,
  createStrategyRegistry, createSingleShotStrategy, createMCTSStrategy, createHeadsStrategy, createThinkTool,
  HeadController, HeadJournal, initHeadsTables,
  discoverSkills, resolveActiveSkills, extractExplicitInvocations, BUILTIN_SKILLS,
  unionAllowedTools, toolAllowedBySkills,
  BUILTIN_TOOL_NAMES,
  buildBuiltinTools, buildSystemPromptSync, currentDateForPrompt, createChatModel, runChat, resolveMaxSteps,
  parseModelSpec, agentAffinityKey,
  ExtensionHost, StepInjections,
  createDefaultWebSearchProvider, createWebCodemodeProvider, type WebSearchProvider,
  EphemeralContextLedger, turnLocalContextMessage, fnv1a64,
  acceptedMediaForModel, type MediaModality, type ModelInputModality,
  createProductChangeStore, initProductChangeTables, productChangeSqlFromExec,
  listReplayEvals, type ReplayEvalSummary,
  buildChangelog, countUnseenChangelog, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogRevertResult,
  claimAlternateTakesForTurn, purgeUnclaimedAlternateTakes, latestAlternateTakeSet, recordTakePick,
  recordHeadsTakeSet,
  buildTakeContinuationPrompt, getCurrentScaffoldVersion,
  type AlternateTakeSet, type TakePickOutcome,
  initAlternateTakesTable, startBranchHead, settlePendingBranch, newBranchId,
  type PendingBranch, type BranchStatusEvent,
  type AlarmScheduler, type TriggerRow, type TrustLevel, type BackgroundJob,
} from '@proteus/core';
import { combineAbortSignals } from '@proteus/agent-utils';
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

/** Tools whose calls auto-detach to the background past the 30s threshold —
 *  the same set the cf-backend wraps. */
const BACKGROUNDABLE_TOOLS: ReadonlySet<string> = new Set(['think', 'execute_tools', 'run']);

/** The minimal bun:sqlite handle the EventsHub SqlExec adapter needs. */
export interface LocalSessionDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void };
}

/** What the frontends render. A superset of runChat's ChatEvent with the
 *  lifecycle + side-channel (evolution, broadcast, background) events. */
export type SessionEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolName: string; result: string }
  | { type: 'turn-end'; turn: CompletedTurn }
  | { type: 'error'; message: string }
  | { type: 'evolution'; event: string; message: string }
  | { type: 'broadcast'; event: BroadcastEvent };

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
}

interface QueueItem {
  text: string;
  /** Attachments for a user turn — forwarded to the model as file parts. */
  files?: ReadonlyArray<PromptFile>;
  metadata?: ProgrammaticTurn['metadata'];
  kind: 'user' | 'programmatic';
  resolve: () => void;
}

function promptModeForTurn(item: QueueItem): PromptMode {
  const event = typeof item.metadata?.proteusEvent === 'string' ? item.metadata.proteusEvent : '';
  if (event === 'background_job') return 'background_resume';
  if (event.includes('timer') || event.includes('cron')) return 'cron';
  return 'chat';
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
  private readonly engine: EvolutionEngine;
  private readonly orch: AgentOrchestrator;
  private readonly jobs: BackgroundJobStore;
  private readonly jobRunner: BackgroundJobRunner;
  private readonly factsStore: FactsStore;
  private readonly config: AgentConfigStore;
  private readonly eventLog: EventLog;
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
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly persistMessagesEnabled: boolean;
  private readonly history: ModelMessage[] = [];

  /** Ephemeral system-state blocks for this CLI session (core
   *  volatile-context.ts). In-memory only — a new session starts empty, so
   *  the first turn attaches exactly one fresh block. The compaction
   *  extension's onOutcome resets it whenever the model-visible stream
   *  changed shape ('planned'/'invalidated') because the frozen block
   *  positions are meaningless against a rewritten stream; byte-stable
   *  replays keep them valid. */
  private readonly ephemeralLedger = new EphemeralContextLedger();

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

  /** Tools from connected MCP servers (resolveExtraTools seam), merged into the
   *  turn surface. Connected lazily via connectMcp; closed on end. */
  private extraTools: ToolSet = {};
  private mcpClose: (() => Promise<void>) | null = null;

  /** FIFO of turns to run — user inputs + programmatic injects (reactor / job
   *  wake), drained by a single serialized pump so turns never interleave. */
  private readonly queue: QueueItem[] = [];
  private pumping = false;
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
    // agent_config (typed key/value) — backs always-active skills, etc.
    initAgentConfigTable(this.rt.storage.execRaw);
    this.config = createAgentConfigStore(this.rt.storage.sql);

    // agent_facts world model — exposes the `fact` tool (parity with the DO).
    initFactsTable(this.rt.storage.execRaw);
    this.factsStore = createFactsStore(this.rt.storage.sql);

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
          info: (message, data) => console.log(`[proteus:compaction] ${message}`, data ?? ''),
          debug: (message, data) => console.debug(`[proteus:compaction] ${message}`, data ?? ''),
          warn: (message, data) => console.warn(`[proteus:compaction] ${message}`, data ?? ''),
          error: (message, data) => console.error(`[proteus:compaction] ${message}`, data ?? ''),
        },
      },
      summarize: createModelSummarizer(() => this.ensureModelState()),
      onOutcome: ({ outcome }) => {
        // Fires inside runTransformContext, BEFORE runChat's ledger weave —
        // a fresh plan ('planned') or a discarded one ('invalidated')
        // invalidates the frozen block positions; a byte-stable replay
        // keeps them.
        if (outcome !== 'replayed') this.ephemeralLedger.reset();
      },
    });

    // Voyager-style curriculum table (agent.* parity with the DO).
    initCurriculumTable(this.rt.storage.execRaw);

    initHeadsTables(this.rt.storage.execRaw);
    this._headRuntime = createCLIHeadRuntime({ model: this.fallbackModel, sharedVfs: this.rt.storage.vfs, webSearch: this.getWebSearchProvider(), grounding: this.buildHeadGrounding() });
    this.headController = new HeadController(this._headRuntime, new HeadJournal(this.rt.storage.sql));

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

    this.orch = new AgentOrchestrator({
      host: this,
      engine: this.engine,
      eventLog: this.eventLog,
      sessionReflectionInterval: opts.sessionReflectionInterval,
    });
    this.jobRunner = new BackgroundJobRunner({
      store: this.jobs,
      fiber: this.rt.schedule.fiber,
      host: this,
      eventLog: this.eventLog,
      scheduleDrain: () => this.orch.scheduleDrain(),
      logActivity: (event, detail) => this.emit({ type: 'evolution', event, message: detail ?? '' }),
    });
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
      spec: { cron: opts.cron, label: opts.label, payload: opts.payload },
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
      const spec = trigger.spec as { label?: string; payload?: unknown; cron?: string };
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
      void this.enqueueTurn({
        text: buildTakeContinuationPrompt(record.set, record.chosen),
        metadata: { proteusEvent: 'take_pick' },
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

  /** Record the comparable heads of a completed think({strategy:'heads'}) run as
   *  an unclaimed Alternate-Takes set — claimed against this turn at turn end by
   *  claimAlternateTakesForTurn, exactly like an MCTS capture. Only the grounded
   *  scores are a real preference signal, so emit nothing when ungrounded. */
  private recordHeadsTake(merge: MergeResult, task: string): void {
    if (!merge.grounded) return;
    const heads = merge.headScores
      .filter((s) => s.status === 'completed')
      .map((s) => ({ id: s.id, text: s.text, score: s.score }));
    try {
      recordHeadsTakeSet(this.rt.storage.sql, { task, heads });
    } catch { /* no takes table yet — the first MCTS/heads run creates it */ }
  }

  /** BackendHost seam — the connected MCP tools, merged into each turn. */
  resolveExtraTools(): ToolSet {
    return this.extraTools;
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

  /** BackendHost seam — the CLI declines mid-turn event injection: the local
   *  steer-drain owns the live turn's injection channel with USER semantics a
   *  platform event must not assume (each steer persists as a verbatim user
   *  row for the walk-back fork, interrupt() hands pending steers back to the
   *  composer, and leftover steers rerun as a user-origin turn — which would
   *  misgrade the outcome review). Events drain as the immediate next
   *  programmatic turn instead (the enqueueTurn fallback). */
  injectIntoActiveTurn(): boolean {
    return false;
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
    const handle = startBranchHead(this._headRuntime, new HeadJournal(this.rt.storage.sql), {
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

  /** Connect configured stdio MCP servers + merge their tools into the surface.
   *  Call once at startup (no-op for empty config). Idempotent-safe to skip. */
  async connectMcp(servers: Record<string, McpServerConfig>): Promise<void> {
    if (!servers || Object.keys(servers).length === 0) return;
    const conn = await connectMcpServers(servers, (msg) => this.emit({ type: 'evolution', event: 'mcp', message: msg }));
    this.extraTools = conn.tools;
    this.mcpClose = conn.close;
  }

  /** End the session: flush a partial evolution window + disconnect MCP. */
  async end(): Promise<void> {
    this.ended = true;
    this.clearLocalAlarm();
    await this.orch.flushSession();
    try { await this.mcpClose?.(); } catch { /* best effort */ }
  }

  /**
   * Recover background jobs orphaned by a previous CLI exit (durable detach). An
   * interrupted bg:* fiber leaves a row stashed phase 'running'; fail + wake it
   * (DO onFiberRecovered parity), then clear all stale fiber rows from the prior
   * run. Call once at startup (no fibers are live yet, so every row is an orphan).
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

  /** Single serialized drain of the turn queue — idempotent, so a concurrent
   *  enqueueTurn just appends and the running pump picks it up. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
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
      this.pumping = false;
    }
  }

  private async processTurn(item: QueueItem): Promise<void> {
    const event = typeof item.metadata?.proteusEvent === 'string' ? item.metadata.proteusEvent : undefined;
    this.emit({ type: 'turn-start', kind: item.kind, text: item.text, event });

    const startedAt = Date.now();
    this.orch.beginTurn(startedAt);
    // Shadow-git checkpoints: arm the per-turn dedup so the first host-FS
    // mutation of this turn snapshots its working directory (invisible /undo
    // substrate — see core checkpoints/types.ts).
    this.rt.checkpoints?.beginTurn({ turnId: crypto.randomUUID(), sessionId: this.sessionId });
    // A real user message grades the previous turn — dispatch the detached
    // outcome review (same core pipeline as the DO's beforeTurn hook).
    if (item.kind === 'user') this.orch.observeUserTurn(item.text);
    this.turnInvokedSkills.clear();
    const model = this.ensureModelState();

    // MEMORY.md is append-only — the TAIL holds the newest lessons/reflections.
    // It is per-turn-read live state (lessons/reflections/take-pick
    // corrections append constantly), so it rides the ephemeral system-state
    // ledger: in the stable prefix every append would bust the cache and
    // trip the prompt-hash telemetry with no real agent event.
    const knowledge = (await this.rt.memory.read('memory/MEMORY.md'))?.slice(-2000) ?? '';
    const executors = this.rt.executionRouter?.listExecutors() ?? [];
    const activeSkills = await this.resolveTurnSkills(item.text);
    // Skill-filtered built-ins + the connected MCP tools (always available).
    const filteredBuiltins = this.filterToolsBySkills(activeSkills);
    const turnTools = { ...filteredBuiltins, ...this.extraTools };
    const availableBuiltins = Object.keys(filteredBuiltins).filter((name): name is BuiltinToolName =>
      BUILTIN_TOOL_NAMES.has(name));
    const externalTools = Object.keys(this.extraTools).map((name) => ({
      name,
      source: name.startsWith('tool_') ? 'mcp' as const : 'external' as const,
    }));
    // Nearest-file-wins AGENTS.md chain, re-read each turn so edits land
    // immediately (a handful of stat calls — negligible next to the LLM call).
    const agentsMd = discoverAgentsMd(this.cwd);
    // The byte-stable cache prefix — system state (facts, executor status)
    // rides the ephemeral ledger and activation reasons ride the turn-local
    // tail below, sharing the seam with the DO backend.
    const systemPrompt = buildSystemPromptSync(this.rt, {
      executors,
      availableTools: availableBuiltins,
      externalTools,
      backend: 'cli-local',
      mode: promptModeForTurn(item),
      model: { id: this.cachedModelSpec ?? this.fallbackModelSpec },
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

    // System state (facts, memory tail, executor status) rides the ephemeral
    // ledger — runChat weaves the frozen blocks into the durable history
    // AFTER the transformContext seam, appending a fresh block only when the
    // state fingerprint changed. Turn-local state (activation reasons) rides
    // one trailing message for THIS turn only. Neither is ever pushed into
    // the durable history, so the stable prefix stays cacheable.
    const systemState = {
      ledger: this.ephemeralLedger,
      context: {
        factsBlock: this.renderFactsForTurn(),
        memoryTail: knowledge || undefined,
        executors,
      },
    };
    const turnLocalMsg = turnLocalContextMessage(activeSkills ? { activeSkills } : {});

    const pendingCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    let fullText = '';
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
    const extensions = new ExtensionHost()
      .register(this.compactionExtension)
      .register({ name: 'proteus.steering', prepareStep: prepareStepMessages });
    const cache = this.cacheIdentity();
    // The measured trigger: the previous turn's final request as the provider
    // actually priced it, persisted at turn end below — voided by the length
    // guard when the durable history shrank (restart truncation) since the
    // measurement.
    const historyLength = this.history.length;
    const lastPromptTokens = this.compactionState.loadPromptTokens(cache.sessionKey, historyLength);

    try {
      for await (const ev of runChat({
        model,
        modelContext: { id: this.cachedModelSpec ?? this.fallbackModelSpec },
        system: systemPrompt,
        history: this.history,
        // Model-capability attachment sanitization — runChat applies it to
        // the whole history BEFORE the transform seam and the ledger weave
        // (same ordering as the DO's beforeTurn); this.history itself is
        // never mutated.
        attachments: { accepts: this.sessionAcceptedMedia(), vfs: this.rt.storage.vfs },
        systemState,
        turnLocal: turnLocalMsg ? [turnLocalMsg] : undefined,
        tools: turnTools,
        ...(lastPromptTokens !== null ? { providerReportedTokens: lastPromptTokens } : {}),
        maxSteps: resolveMaxSteps(),
        signal: abort.signal,
        extensions,
        cache,
      })) {
        switch (ev.type) {
          case 'text-delta':
            this.orch.acc.onFirstChunk();
            fullText += ev.delta;
            this.emit({ type: 'text-delta', delta: ev.delta });
            break;
          case 'tool-call':
            pendingCalls.push({ toolName: ev.toolName, args: ev.args });
            this.emit({ type: 'tool-call', toolName: ev.toolName, args: ev.args });
            break;
          case 'tool-result': {
            const idx = findLastIndexBy(pendingCalls, (c) => c.toolName === ev.toolName);
            const call = idx >= 0 ? pendingCalls.splice(idx, 1)[0] : undefined;
            // Real success/error into the accumulator — the outcome signal
            // (hadError, turn-outcome review) reads it, matching the cf
            // backend's afterToolCall. A failed tool flags the turn.
            this.orch.acc.recordToolCall(ev.success
              ? { toolName: ev.toolName, input: call?.args ?? {}, success: true, output: ev.result }
              : { toolName: ev.toolName, input: call?.args ?? {}, success: false, error: ev.error ?? ev.result });
            this.emit({ type: 'tool-result', toolName: ev.toolName, result: ev.result });
            break;
          }
          case 'step-finish':
            this.orch.acc.recordStep(
              ev.inputTokens !== undefined || ev.outputTokens !== undefined || ev.cachedInputTokens !== undefined
                ? { usage: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedInputTokens: ev.cachedInputTokens } }
                : {},
            );
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
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.currentAbort = null;
    }

    let assistantMsgId: string | null = null;
    const snapshotTurn = (): CompletedTurn => ({
      userMessage: item.text,
      assistantResponse: fullText,
      toolCalls: this.orch.acc.toolCalls,
      steps: this.orch.acc.stepCount,
      durationMs: Date.now() - startedAt,
      feedback: null,
      hadError: this.orch.acc.hadError,
      ...(assistantMsgId ? { turnId: assistantMsgId } : {}),
      sessionId: this.sessionId,
      origin: item.kind,
    });

    try {
      // Persist the turn's final provider-priced prompt size — the NEXT turn's
      // measured compaction trigger. Any step that reported was a real priced
      // request, so errored turns record too. Bound to the turn's durable
      // history length so a later shrink voids it.
      if (this.orch.acc.lastPromptTokens > 0) {
        this.compactionState.savePromptTokens(cache.sessionKey, this.orch.acc.lastPromptTokens, historyLength);
      }

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

      // One durable row PER steer (not per drain): the walk-back fork pivot
      // matches individual user messages verbatim, exactly as surfaces and the
      // JSONL transcript recorded them.
      assistantMsgId = this.persist(item.text, injections.recorded.flatMap((injection) => injection.texts), fullText);

      // Alternate Takes captured during this turn's think-mcts runs get the
      // turn id they competed for, so a pick can credit the right turn. A turn
      // that settles without an assistant message id cannot be credited — its
      // captures are purged so the next turn never claims them as its own.
      try {
        if (assistantMsgId) {
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

      const turn = snapshotTurn();
      // Cadence (turn + session evolution) + the reactor drain — may enqueue more.
      await this.orch.completeTurn(turn);
      this.emit({ type: 'turn-end', turn });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.orch.acc.hadError = true;
      console.error('[proteus] turn finalization failed:', message);
      // Any response messages runChat produced remain in live history as a
      // best-effort recovery for later turns in this process. We do not retry
      // potentially partial side effects, and failed persistence cannot survive
      // a restart, so surface both the failure and a terminal turn event.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: snapshotTurn() });
    }
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

  /** Passthrough SkillsVfs shim over rt.storage.vfs (mirrors the DO). */
  private getSkillsVfs(): SkillsVfs {
    if (this.skillsVfs) return this.skillsVfs;
    const vfs = this.rt.storage.vfs;
    this.skillsVfs = {
      exists: (p) => vfs.exists(p),
      readFile: (p, opts) => vfs.readFile(p, opts),
      writeFile: (p, data) => vfs.writeFile(p, data),
      readdir: (p) => vfs.readdir(p),
      unlink: (p) => vfs.unlink(p),
      mkdir: (p, opts) => vfs.mkdir(p, opts),
    };
    return this.skillsVfs;
  }

  private agentName(): string {
    try {
      return this.rt.storage.sql<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0]?.name ?? 'local';
    } catch {
      return 'local';
    }
  }

  /** Prompt-cache identity for runChat: the resolved provider/model plus a
   *  stable per-conversation key (the agent's affinity key + session id —
   *  same `proteus-<name>` scheme Workers AI affinity pins with). */
  private cacheIdentity(): { providerId?: string; modelId?: string; sessionKey: string } {
    const sessionKey = `${agentAffinityKey(this.agentName())}:${this.sessionId}`;
    const spec = this.cachedModelSpec ?? this.fallbackModelSpec;
    try {
      const { provider, modelId } = parseModelSpec(spec);
      return { providerId: provider, modelId, sessionKey };
    } catch {
      return { sessionKey };
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

  /** Resolve the skills active for this turn — explicit @invocations,
   *  always-active config, and builtin auto-activation. Mirrors the DO's
   *  beforeTurn: only scans the VFS when activation is plausible, and records the
   *  activated names onto the per-turn invoke tracker for skills.list. */
  private async resolveTurnSkills(userText: string): Promise<ActiveSkillSet | undefined> {
    try {
      const explicit = extractExplicitInvocations(userText);
      const alwaysActive = this.config.getAlwaysActiveSkills();
      const anyAutoActivate = BUILTIN_SKILLS.some((s) => s.auto_activate);
      if (explicit.length === 0 && alwaysActive.length === 0 && !anyAutoActivate) return undefined;
      const available = await discoverSkills(this.getSkillsVfs());
      const activeSet = resolveActiveSkills({ available, explicit, userMessage: userText, alwaysActive });
      if (activeSet.active.length === 0) return undefined;
      for (const r of activeSet.reasons) this.turnInvokedSkills.add(r.name);
      return activeSet;
    } catch {
      return undefined;
    }
  }

  /** Restrict the turn's toolset to the active skills' allowed_tools union (the
   *  skills tool stays reachable so the agent can list/invoke more mid-turn).
   *  Empty union / no skills = full surface. */
  private filterToolsBySkills(activeSkills?: ActiveSkillSet): ToolSet {
    if (!activeSkills) return this.tools;
    const allowed = unionAllowedTools(activeSkills.active);
    if (allowed.length === 0) return this.tools;
    const filtered: ToolSet = {};
    for (const [name, t] of Object.entries(this.tools)) {
      if (name === 'skills' || toolAllowedBySkills(name, allowed)) filtered[name] = t;
    }
    return filtered;
  }

  /** Re-run a task for the replay-eval harness: the current system prompt
   *  (knowledge tail + soul) and model, the facts world model as the same
   *  ephemeral system-state block live turns get, isolated history, no tools
   *  (see the engine-construction note). */
  private async runReplayTask(task: string): Promise<string> {
    const model = this.ensureModelState();
    const knowledge = (await this.rt.memory.read('memory/MEMORY.md'))?.slice(-2000) ?? '';
    const systemPrompt = buildSystemPromptSync(this.rt, {
      backend: 'cli-local',
      mode: 'chat',
      model: { id: this.cachedModelSpec ?? this.fallbackModelSpec },
      currentDate: currentDateForPrompt(),
    });
    let text = '';
    for await (const ev of runChat({
      model,
      modelContext: { id: this.cachedModelSpec ?? this.fallbackModelSpec },
      system: systemPrompt,
      history: [{ role: 'user', content: task }],
      // A fresh ledger per replay: the same seam live turns use, isolated
      // from the session's own block positions.
      systemState: {
        ledger: new EphemeralContextLedger(),
        context: { factsBlock: this.renderFactsForTurn(), memoryTail: knowledge || undefined },
      },
      tools: {},
      maxSteps: 1,
    })) {
      if (ev.type === 'text-delta') text += ev.delta;
      else if (ev.type === 'done' && !text.trim()) text = ev.text;
    }
    return text;
  }

  /** The recent-facts world-model block for the volatile turn context (single
   *  seam with the DO backend — see core prompting/volatile-context.ts). */
  private renderFactsForTurn(): string | undefined {
    try {
      return renderFactsBlock(this.factsStore.recentTopK(20), { maxChars: 2000 }) || undefined;
    } catch { return undefined; /* facts table not yet populated */ }
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

  /** The unified `think` tool — single-shot + MCTS + heads. MCTS explores over
   *  rt.spawnBranch; heads run in-process via the CLI HeadRuntime. Mirrors the
   *  DO's getThinkTool defaultOptions (mcts session + heads controller/context/
   *  onPhase). */
  private buildThinkTool(): ToolSet[string] {
    const registry = createStrategyRegistry();
    registry.register(createSingleShotStrategy());
    registry.register(createMCTSStrategy());
    registry.register(createHeadsStrategy());
    return createThinkTool({
      registry,
      rt: this.rt,
      model: this.cachedModel ?? this.fallbackModel,
      defaultOptions: () => ({
        // Stored operator overrides ride along; an explicit LLM budget wins.
        mcts: { session: this.createMCTSSession(), ...this.config.getMctsOverrides() },
        heads: {
          controller: this.headController,
          inheritedContext: this.readInheritedContext(),
          onPhase: (e: SplitPhaseEvent) => this.emitHeadPhase(e),
          onComplete: (merge: MergeResult, task: string) => this.recordHeadsTake(merge, task),
        },
      }),
    });
  }

  /** The recent conversation handed to each spawned head as inherited context
   *  (capped to bound the head's LLM context). */
  private readInheritedContext(): SerializedMessage[] {
    const CAP = 50;
    return this.history.slice(-CAP).map((m, i) => ({
      id: `ctx-${i}`,
      role: (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool') ? m.role : 'assistant',
      content: serializeContentForHeads(m.content),
      createdAt: i,
    }));
  }

  /** Fan head_split / head_merge lifecycle out as broadcasts so the frontends
   *  can render the branch timeline. */
  private emitHeadPhase(event: SplitPhaseEvent): void {
    this.broadcast(event.kind === 'split'
      ? { type: 'head_split', rootId: event.rootId, headIds: [...event.headIds], rationale: event.rationale }
      : { type: 'head_merge', rootId: event.rootId, headCount: event.headCount, mergedNarrative: event.mergedNarrative });
  }

  /** A fresh SessionWriter for an MCTS run — an in-memory message tree that also
   *  persists nodes to the messages table (session_id='mcts'), mirroring the DO. */
  private createMCTSSession(): SessionWriter {
    const messages: Array<{ id: string; parentId: string | null; role: 'user' | 'assistant'; content: string }> = [];
    const sql = this.rt.storage.sql;
    return {
      async appendMessage(msg: SessionMessage, parentId?: string | null): Promise<void> {
        const content = msg.parts.map((p) => p.text).join('');
        messages.push({ id: msg.id, parentId: parentId ?? null, role: msg.role, content });
        sql`INSERT INTO messages (id, session_id, parent_id, role, content)
          VALUES (${msg.id}, ${'mcts'}, ${parentId ?? null}, ${msg.role}, ${content})`;
      },
      getHistory(leafId?: string): Array<{ role: string; content: string }> {
        const result: Array<{ role: string; content: string }> = [];
        let current = leafId ? messages.find((m) => m.id === leafId) : undefined;
        while (current) {
          result.unshift({ role: current.role, content: current.content });
          current = current.parentId ? messages.find((m) => m.id === current!.parentId) : undefined;
        }
        return result;
      },
    };
  }

  /** Mirror the cf-backend wrapToolsForBackground: shallow-clone the toolset and
   *  wrap the long-running tools' execute in the 30s threshold. */
  private wrapToolsForBackground(raw: ToolSet): ToolSet {
    const wrapped: ToolSet = { ...raw };
    for (const key of BACKGROUNDABLE_TOOLS) {
      const orig = wrapped[key];
      const exec = orig?.execute;
      if (!orig || typeof exec !== 'function') continue;
      wrapped[key] = {
        ...orig,
        execute: (input: unknown, options: unknown) => {
          const controller = new AbortController();
          const turnSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const abortSignal = turnSignal ? combineAbortSignals([turnSignal, controller.signal]) : controller.signal;
          const deps = this.jobRunner.thresholdDeps(key, input, controller);
          return withBackgroundThreshold(key, () => exec(input as never, { ...(options as object), abortSignal } as never), deps);
        },
      } as ToolSet[string];
    }
    return wrapped;
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

  /** Media the active model request can carry — the attachment sanitizer's
   *  policy input, mirroring the DO's cached non-blocking catalog lookup:
   *  the provider-class ceiling answers immediately (conservative — errs
   *  toward sanitizing, never toward a rejected request) and the catalog's
   *  per-model input modalities narrow it once the async lookup lands. */
  private _mediaAcceptance: { spec: string; catalogModalities: ModelInputModality[] | null } | null = null;
  private sessionAcceptedMedia(): ReadonlySet<MediaModality> {
    const spec = this.cachedModelSpec ?? this.fallbackModelSpec;
    if (this._mediaAcceptance?.spec !== spec) {
      this._mediaAcceptance = { spec, catalogModalities: null };
      void this.lookupInputModalities(spec);
    }
    let provider: string | undefined;
    try { provider = parseModelSpec(spec).provider; } catch { /* bare fallback spec */ }
    const catalog = this._mediaAcceptance.catalogModalities;
    return acceptedMediaForModel({
      ...(provider !== undefined ? { provider } : {}),
      ...(catalog ? { catalogInputModalities: catalog } : {}),
    });
  }

  private async lookupInputModalities(spec: string): Promise<void> {
    if (!this.modelResolver) return;
    try {
      const info = await this.modelResolver.modelInfo(spec);
      if (info?.inputModalities && this._mediaAcceptance?.spec === spec) {
        this._mediaAcceptance.catalogModalities = info.inputModalities;
      }
    } catch { /* catalog unavailable — the conservative default stays */ }
  }

  private ensureModelState(): LanguageModel {
    const spec = this.normalizeModelSpec(this.config.getModel());
    if (this.cachedModel && this.cachedModelSpec === spec) return this.cachedModel;
    const model = this.modelResolver ? this.modelResolver.resolveModel(spec) : this.fallbackModel;
    this.cachedModel = model;
    this.cachedModelSpec = spec;
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
    this._headRuntime = createCLIHeadRuntime({ model, sharedVfs: this.rt.storage.vfs, webSearch: this.getWebSearchProvider(), grounding: this.buildHeadGrounding() });
    this.headController = new HeadController(this._headRuntime, new HeadJournal(this.rt.storage.sql));

    const rawTools = buildBuiltinTools({
      rt: this.rt,
      shellApprovalMode: this.config.getShellApprovalMode(),
      craftedToolExecute: createNodeCraftedExecute(),
      createExecuteTool: createNodeExecuteToolFactory({
        vfs: this.rt.storage.vfs,
        memory: this.rt.memory,
        shell: this.rt.shell,
        extraProviders: [createLocalAgentSelfProvider(this), createWebCodemodeProvider(this.getWebSearchProvider())],
      }) as never,
      codemodeLoader: { __cli: true } as unknown,
      thinkTool: this.buildThinkTool(),
      facts: this.factsStore,
      skills: {
        vfs: this.getSkillsVfs(),
        recordInvoke: (name: string) => { this.turnInvokedSkills.add(name); },
        currentlyInvoked: () => Array.from(this.turnInvokedSkills),
      },
      productChanges: this.productChangeToolDeps(),
      // deps.team is deliberately NOT wired: the `team` peer-messaging tool
      // needs a cross-agent transport, and local agents are one-per-process
      // SQLite sessions with no daemon to route between them. Absent deps →
      // the tool is not registered and the prompt (derived from the built
      // toolset) never advertises it. Hosted agents get the full team surface.
      webSearch: this.getWebSearchProvider(),
    });
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

/** Serialize message content for head inheritance. File-part payloads (data
 *  URLs from attachments) are reduced to their filename/mediaType reference so
 *  spawned heads never inherit megabytes of base64. */
export function serializeContentForHeads(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return JSON.stringify(content.map((part) =>
      part && typeof part === 'object' && 'type' in part && part.type === 'file'
        ? { type: 'file', mediaType: part.mediaType, filename: part.filename }
        : part));
  }
  return JSON.stringify(content);
}

/** Adapt a bun:sqlite handle to the EventsHub SqlExec shape (DO storage.sql). */
function makeHubSql(db: LocalSessionDb): {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
} {
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

/** Last index matching the predicate (ES2023 findLastIndex without the lib dep). */
function findLastIndexBy<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}
