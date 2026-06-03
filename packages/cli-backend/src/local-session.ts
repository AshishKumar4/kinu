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
  BackendHost, BroadcastEvent, ProgrammaticTurn, EnqueueTurnResult,
  SessionWriter, SessionMessage, SkillsVfs, ActiveSkillSet, FactsStore,
  HeadRuntime, SerializedMessage, SplitPhaseEvent, AgentConfigStore,
} from '@proteus/core';
import {
  AgentOrchestrator,
  BackgroundJobStore, BackgroundJobRunner, initBackgroundJobsTable, withBackgroundThreshold,
  EventLog, initEventsHubTables,
  EvolutionEngine,
  initAgentConfigTable, createAgentConfigStore,
  initFactsTable, createFactsStore, renderFactsBlock,
  createStrategyRegistry, createSingleShotStrategy, createMCTSStrategy, createHeadsStrategy, createThinkTool,
  HeadController, HeadJournal, initHeadsTables,
  discoverSkills, resolveActiveSkills, extractExplicitInvocations, BUILTIN_SKILLS,
  unionAllowedTools, toolAllowedBySkills,
  buildBuiltinTools, buildSystemPromptSync, createChatModel, runChat, resolveMaxSteps,
} from '@proteus/core';
import { createNodeCraftedExecute } from './craft-executor.js';
import { createNodeExecuteToolFactory } from './execute-tools-factory.js';
import { createCLIHeadRuntime } from './head-runtime.js';
import { detectOrphanedFibers } from './fiber.js';

/** Build the ai-SDK chat model both frontends drive runChat with — BYO-key
 *  OpenAI-compatible. Shared so model resolution lives in one place (the
 *  gateway path layers on here in P6). */
export function resolveChatModel(llm: LLMProviderConfig): LanguageModel {
  return createChatModel({
    kind: 'openai-compat', name: llm.name, baseURL: llm.baseURL, headers: llm.headers, modelId: llm.model,
  });
}

/** Tools whose calls auto-detach to the background past the 30s threshold —
 *  the same set the cf-backend wraps (think is CF-only today; harmless here). */
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

export interface LocalAgentSessionOpts {
  rt: AgentRuntime;
  /** Raw bun:sqlite handle — backs the EventsHub SqlExec adapter. */
  db: LocalSessionDb;
  /** The ai-SDK chat model runChat drives. Build via resolveChatModel(llmConfig). */
  model: LanguageModel;
  onEvent: (event: SessionEvent) => void;
  /** Disable auto-evolution (turn + session reflection). Default: enabled. */
  noAutoEvolve?: boolean;
  /** Turns between session-level reflections (default 5, matching the DO). */
  sessionReflectionInterval?: number;
}

interface QueueItem {
  text: string;
  metadata?: ProgrammaticTurn['metadata'];
  kind: 'user' | 'programmatic';
  resolve: () => void;
}

export class LocalAgentSession implements BackendHost {
  private readonly rt: AgentRuntime;
  private readonly model: LanguageModel;
  private readonly tools: ToolSet;
  private readonly engine: EvolutionEngine;
  private readonly orch: AgentOrchestrator;
  private readonly jobRunner: BackgroundJobRunner;
  private readonly factsStore: FactsStore;
  private readonly config: AgentConfigStore;
  /** Branching-heads runtime (BackendHost seam) + its controller — local heads
   *  run in-process over isolated ephemeral runtimes. */
  readonly headRuntime: HeadRuntime;
  private readonly headController: HeadController;
  private readonly onEvent: (event: SessionEvent) => void;
  private readonly sessionId = `local-${Date.now()}`;
  private readonly history: ModelMessage[] = [];

  /** Skills invoked this turn (explicit/auto-activation + the skills tool's
   *  `invoke` action). Cleared at turn start; the skills tool's closures mutate
   *  this stable Set, so the cached toolset never needs rebuilding. */
  private readonly turnInvokedSkills = new Set<string>();
  private skillsVfs: SkillsVfs | null = null;

  /** FIFO of turns to run — user inputs + programmatic injects (reactor / job
   *  wake), drained by a single serialized pump so turns never interleave. */
  private readonly queue: QueueItem[] = [];
  private pumping = false;
  /** The in-flight turn's abort handle — interrupt() aborts it. */
  private currentAbort: AbortController | null = null;

  constructor(opts: LocalAgentSessionOpts) {
    this.rt = opts.rt;
    this.onEvent = opts.onEvent;
    this.model = opts.model;

    this.engine = new EvolutionEngine(this.rt, { enabled: !opts.noAutoEvolve });
    this.engine.onEvent((e) => this.emit({ type: 'evolution', event: e.type, message: e.message }));

    // Background-job lifecycle over the durable local fiber (createLinuxFiber) +
    // this session as the BackendHost (enqueueTurn wakes the agent).
    initBackgroundJobsTable(this.rt.storage.execRaw);
    this.jobRunner = new BackgroundJobRunner({
      store: new BackgroundJobStore(this.rt.storage.sql),
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

    // Branching heads — in-process runtime + controller (drives think strategy=heads).
    // The agent's VFS backs the shared findings scratch sibling heads write to.
    this.headRuntime = createCLIHeadRuntime({ model: this.model, sharedVfs: this.rt.storage.vfs });
    initHeadsTables(this.rt.storage.execRaw);
    this.headController = new HeadController(this.headRuntime, new HeadJournal(this.rt.storage.sql));

    // The full built-in surface, now wrapped so >30s calls auto-background:
    // think (single-shot + MCTS; heads needs a subprocess HeadRuntime — P6b),
    // fact, skills, + the Node execute/craft factories.
    const rawTools = buildBuiltinTools({
      rt: this.rt,
      craftedToolExecute: createNodeCraftedExecute(),
      createExecuteTool: createNodeExecuteToolFactory({
        vfs: this.rt.storage.vfs,
        memory: this.rt.memory,
        shell: this.rt.shell,
      }) as never,
      codemodeLoader: { __cli: true } as unknown,
      thinkTool: this.buildThinkTool(),
      facts: this.factsStore,
      skills: {
        vfs: this.getSkillsVfs(),
        recordInvoke: (name: string) => { this.turnInvokedSkills.add(name); },
        currentlyInvoked: () => Array.from(this.turnInvokedSkills),
      },
    });
    this.tools = this.wrapToolsForBackground(rawTools);

    // The EventsHub substrate (reactor source of truth) — provisioned so the
    // orchestrator's drain is wired; local trigger/MCP sources land in P6.
    const hubSql = makeHubSql(opts.db);
    initEventsHubTables(hubSql);
    const eventLog = new EventLog(hubSql);

    this.orch = new AgentOrchestrator({
      host: this,
      engine: this.engine,
      eventLog,
      sessionReflectionInterval: opts.sessionReflectionInterval,
    });
  }

  /** Tool names for the banner. */
  toolNames(): string[] {
    return Object.keys(this.tools);
  }

  /** Built-in tools with descriptions for the /tools view. */
  describeTools(): Array<{ name: string; description: string }> {
    return Object.entries(this.tools).map(([name, t]) => ({
      name, description: (t as { description?: string }).description ?? '',
    }));
  }

  /** Skills pinned always-active for this agent (the `/always` command). */
  getAlwaysActiveSkills(): string[] { return this.config.getAlwaysActiveSkills(); }
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void { this.config.setAlwaysActiveSkills(names); }

  // ── BackendHost ────────────────────────────────────────────────────

  broadcast(event: BroadcastEvent): void {
    this.emit({ type: 'broadcast', event });
  }

  /** Inject a programmatic turn into the same serialized loop the user drives —
   *  backs the reactor + background-job wake. Self-starts the pump when idle so
   *  a job that settles mid-idle wakes the agent immediately. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    this.queue.push({ text: input.text, metadata: input.metadata, kind: 'programmatic', resolve: () => {} });
    void this.pump();
    return Promise.resolve({ status: 'queued' });
  }

  // ── Public driver API ──────────────────────────────────────────────

  /** Run a user turn (and any programmatic turns it cascades). Resolves when
   *  the user's own turn has finished. */
  send(text: string): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ text, kind: 'user', resolve });
      void this.pump();
    });
  }

  /** Abort the in-flight turn (Ctrl+C / Esc). */
  interrupt(): void {
    this.currentAbort?.abort();
  }

  /** End the session: flush a partial evolution window. Call on exit. */
  async end(): Promise<void> {
    await this.orch.flushSession();
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
    this.turnInvokedSkills.clear();

    const knowledge = (await this.rt.memory.read('memory/MEMORY.md'))?.slice(0, 2000) ?? '';
    const executorNames = (this.rt.executionRouter?.listExecutors() ?? []).map((e) => e.name);
    const activeSkills = await this.resolveTurnSkills(item.text);
    const systemPrompt = buildSystemPromptSync(this.rt, {
      extraKnowledge: knowledge || undefined,
      registeredExecutors: executorNames,
      ...(activeSkills ? { activeSkills } : {}),
    }) + this.factsTail();
    const turnTools = this.filterToolsBySkills(activeSkills);

    this.history.push({ role: 'user', content: item.text });

    const pendingCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    let fullText = '';
    const abort = new AbortController();
    this.currentAbort = abort;

    try {
      for await (const ev of runChat({
        model: this.model,
        system: systemPrompt,
        history: this.history,
        tools: turnTools,
        maxSteps: resolveMaxSteps(),
        signal: abort.signal,
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
          case 'done':
            for (const msg of ev.responseMessages) this.history.push(msg);
            if (!fullText.trim() && ev.text.trim()) fullText = ev.text;
            break;
        }
      }
    } catch (err) {
      this.orch.acc.hadError = true;
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.currentAbort = null;
    }

    this.persist(item.text, fullText);

    const turn: CompletedTurn = {
      userMessage: item.text,
      assistantResponse: fullText,
      toolCalls: this.orch.acc.toolCalls,
      steps: this.orch.acc.stepCount,
      durationMs: Date.now() - startedAt,
      feedback: null,
      hadError: this.orch.acc.hadError,
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

  /** Resolve the skills active for this turn — explicit @invocations + builtin
   *  auto-activation (always-active config is a CLI follow-up). Mirrors the DO's
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
      model: this.model,
      defaultOptions: () => ({
        mcts: { session: this.createMCTSSession() },
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
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
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
      async compact(): Promise<void> {},
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
          const abortSignal = turnSignal ? AbortSignal.any([turnSignal, controller.signal]) : controller.signal;
          const deps = this.jobRunner.thresholdDeps(key, input, controller);
          return withBackgroundThreshold(key, () => exec(input as never, { ...(options as object), abortSignal } as never), deps);
        },
      } as ToolSet[string];
    }
    return wrapped;
  }

  private persist(userText: string, assistantText: string): void {
    const msgId = crypto.randomUUID();
    this.rt.storage.sql`INSERT INTO messages (id, session_id, role, content)
      VALUES (${msgId}, ${this.sessionId}, ${'user'}, ${userText})`;
    this.rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
      VALUES (${crypto.randomUUID()}, ${this.sessionId}, ${msgId}, ${'assistant'}, ${assistantText})`;
  }
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

/** Last index matching the predicate (ES2023 findLastIndex without the lib dep). */
function findLastIndexBy<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}
