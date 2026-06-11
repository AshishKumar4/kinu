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

import { type ModelMessage, type ToolSet, type LanguageModel } from 'ai';
import type {
  AgentRuntime, LLMProviderConfig, CompletedTurn,
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult, PromptFile,
  SessionWriter, SessionMessage, SkillsVfs, ActiveSkillSet, FactsStore,
  HeadRuntime, SerializedMessage, SplitPhaseEvent, AgentConfigStore, ShellApprovalMode,
  IngressDescriptor, ProteusEvent, RevisitCondition, EventVariant,
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
  createProductChangeStore, initProductChangeTables, productChangeSqlFromExec,
  listReplayEvals, type ReplayEvalSummary,
  buildChangelog, countUnseenChangelog, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogRevertResult,
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
    this.jobRunner = new BackgroundJobRunner({
      store: this.jobs,
      fiber: this.rt.schedule.fiber,
      host: this,
      logActivity: (event, detail) => this.emit({ type: 'evolution', event, message: detail ?? '' }),
    });

    // agent_config (typed key/value) — backs always-active skills, etc.
    initAgentConfigTable(this.rt.storage.execRaw);
    this.config = createAgentConfigStore(this.rt.storage.sql);

    // agent_facts world model — exposes the `fact` tool (parity with the DO).
    initFactsTable(this.rt.storage.execRaw);
    this.factsStore = createFactsStore(this.rt.storage.sql);

    // Voyager-style curriculum table (agent.* parity with the DO).
    initCurriculumTable(this.rt.storage.execRaw);

    initHeadsTables(this.rt.storage.execRaw);
    this._headRuntime = createCLIHeadRuntime({ model: this.fallbackModel, sharedVfs: this.rt.storage.vfs });
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
   *  append-only EventLog, then wake the same serialized turn queue. */
  async publishEvent(input: LocalPublishEventInput): Promise<LocalPublishEventResult> {
    const { id, admitted } = this.eventLog.publish({
      descriptor: input.descriptor,
      now: input.now ?? Date.now(),
      caused_by: input.caused_by,
    });
    await this.orch.drainPendingEvents();
    return { event_id: id, admitted };
  }

  pendingEvents(limit = 50): ProteusEvent[] {
    return this.eventLog.pending({ limit });
  }

  listRecentEvents(opts: { variant?: EventVariant; since?: number; limit?: number } = {}): ProteusEvent[] {
    return this.eventLog.query(opts);
  }

  deferEvent(eventId: string, revisitAt: RevisitCondition): { ok: true } {
    this.eventLog.defer(eventId, revisitAt);
    return { ok: true };
  }

  dismissEvent(eventId: string, reason: string): { ok: true } {
    this.eventLog.dismiss(eventId, reason, 'tool');
    return { ok: true };
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

    if (fired > 0) await this.orch.drainPendingEvents();
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

  /** BackendHost seam — the connected MCP tools, merged into each turn. */
  resolveExtraTools(): ToolSet {
    return this.extraTools;
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

  /** Abort the in-flight turn (Ctrl+C / Esc). Pending steers are dropped —
   *  an interrupt means "stop", not "stop and do what I typed". */
  interrupt(): void {
    this.pendingSteers = [];
    this.currentAbort?.abort();
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
        try { await this.processTurn(item); }
        finally { item.resolve(); }
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

    // MEMORY.md is append-only — the TAIL holds the newest lessons/reflections
    // (prompt.ts documents extraKnowledge as "a bounded memory/MEMORY.md tail").
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
    const systemPrompt = buildSystemPromptSync(this.rt, {
      extraKnowledge: knowledge || undefined,
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
    }) + this.factsTail();

    // Attachments ride as ModelMessage file parts (the same shape ai's
    // convertToModelMessages emits for FileUIParts on the cloud path), so
    // multimodal models receive them natively from streamText.
    const fileParts = (item.files ?? []).map((f) => ({
      type: 'file' as const, data: f.url, mediaType: f.mediaType, filename: f.filename,
    }));
    this.history.push(fileParts.length > 0
      ? { role: 'user', content: [...fileParts, { type: 'text' as const, text: item.text }] }
      : { role: 'user', content: item.text });

    const pendingCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    let fullText = '';
    const abort = new AbortController();
    this.currentAbort = abort;

    // Steer-drain bookkeeping (Hermes conversation_loop pattern): at each step
    // boundary all pending steers merge into ONE user message appended after
    // the latest tool results (Anthropic groups tool+user into a single turn,
    // so role alternation holds). streamText rebuilds each step's messages
    // from scratch, so every drained injection is re-applied at the position
    // (in base-message coordinates) where it first entered the conversation.
    const baseLength = this.history.length;
    const injections: Array<{ index: number; message: ModelMessage; text: string }> = [];
    const prepareStepMessages = ({ messages }: { stepNumber: number; messages: ModelMessage[] }): ModelMessage[] | undefined => {
      if (this.pendingSteers.length > 0) {
        const drained = this.pendingSteers.splice(0);
        injections.push({
          index: messages.length,
          message: steerUserMessage(drained),
          text: drained.map((steer) => steer.text).join('\n\n'),
        });
      }
      if (injections.length === 0) return undefined;
      const next = [...messages];
      let offset = 0;
      for (const injection of injections) {
        next.splice(injection.index + offset, 0, injection.message);
        offset += 1;
      }
      return next;
    };

    try {
      for await (const ev of runChat({
        model,
        modelContext: { id: this.cachedModelSpec ?? this.fallbackModelSpec },
        system: systemPrompt,
        history: this.history,
        tools: turnTools,
        maxSteps: resolveMaxSteps(),
        signal: abort.signal,
        prepareStepMessages,
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
            this.orch.acc.recordToolCall({
              toolName: ev.toolName, input: call?.args ?? {}, success: true, output: ev.result,
            });
            this.emit({ type: 'tool-result', toolName: ev.toolName, result: ev.result });
            break;
          }
          case 'step-finish':
            this.orch.acc.recordStep({});
            break;
          case 'done': {
            // Replay the drained steers into the durable history at the exact
            // positions the model saw them (indices are base-coordinate, so
            // relative to responseMessages they sit at index - baseLength).
            const merged = [...ev.responseMessages];
            let spliced = 0;
            for (const injection of injections) {
              const at = Math.max(0, Math.min(merged.length, injection.index - baseLength + spliced));
              merged.splice(at, 0, injection.message);
              spliced += 1;
            }
            for (const msg of merged) this.history.push(msg);
            if (!fullText.trim() && ev.text.trim()) fullText = ev.text;
            break;
          }
        }
      }
    } catch (err) {
      this.orch.acc.hadError = true;
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.currentAbort = null;
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

    const assistantMsgId = this.persist(item.text, injections.map((injection) => injection.text), fullText);

    const turn: CompletedTurn = {
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
    };
    // Cadence (turn + session evolution) + the reactor drain — may enqueue more.
    await this.orch.completeTurn(turn);
    this.emit({ type: 'turn-end', turn });
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
      return this.rt.storage.sql<{ name: string }>`SELECT name FROM agent_identity LIMIT 1`[0]?.name ?? 'local';
    } catch {
      return 'local';
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
   *  (knowledge tail + facts + soul) and model, isolated history, no tools
   *  (see the engine-construction note). */
  private async runReplayTask(task: string): Promise<string> {
    const model = this.ensureModelState();
    const knowledge = (await this.rt.memory.read('memory/MEMORY.md'))?.slice(-2000) ?? '';
    const systemPrompt = buildSystemPromptSync(this.rt, {
      extraKnowledge: knowledge || undefined,
      backend: 'cli-local',
      mode: 'chat',
      model: { id: this.cachedModelSpec ?? this.fallbackModelSpec },
      currentDate: currentDateForPrompt(),
    }) + this.factsTail();
    let text = '';
    for await (const ev of runChat({
      model,
      modelContext: { id: this.cachedModelSpec ?? this.fallbackModelSpec },
      system: systemPrompt,
      history: [{ role: 'user', content: task }],
      tools: {},
      maxSteps: 1,
    })) {
      if (ev.type === 'text-delta') text += ev.delta;
      else if (ev.type === 'done' && !text.trim()) text = ev.text;
    }
    return text;
  }

  /** The recent-facts world-model block appended to every system prompt (single
   *  source with the DO's getSystemPrompt). */
  private factsTail(): string {
    try {
      const block = renderFactsBlock(this.factsStore.recentTopK(20), { maxChars: 2000 });
      if (block) return `\n\n## World model (facts you remembered):\n${block}`;
    } catch { /* facts table not yet populated */ }
    return '';
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
    this._headRuntime = createCLIHeadRuntime({ model, sharedVfs: this.rt.storage.vfs });
    this.headController = new HeadController(this._headRuntime, new HeadJournal(this.rt.storage.sql));

    const rawTools = buildBuiltinTools({
      rt: this.rt,
      shellApprovalMode: this.config.getShellApprovalMode(),
      craftedToolExecute: createNodeCraftedExecute(),
      createExecuteTool: createNodeExecuteToolFactory({
        vfs: this.rt.storage.vfs,
        memory: this.rt.memory,
        shell: this.rt.shell,
        extraProviders: [createLocalAgentSelfProvider(this)],
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
