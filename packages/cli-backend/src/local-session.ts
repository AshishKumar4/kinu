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
} from '@proteus/core';
import {
  AgentOrchestrator,
  BackgroundJobStore, BackgroundJobRunner, initBackgroundJobsTable, withBackgroundThreshold,
  EventLog, initEventsHubTables,
  EvolutionEngine,
  buildBuiltinTools, buildSystemPromptSync, createChatModel, runChat, resolveMaxSteps,
} from '@proteus/core';
import { createNodeCraftedExecute } from './craft-executor.js';
import { createNodeExecuteToolFactory } from './execute-tools-factory.js';

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
  private readonly onEvent: (event: SessionEvent) => void;
  private readonly sessionId = `local-${Date.now()}`;
  private readonly history: ModelMessage[] = [];

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

    // Same built-in surface the TUI/REPL assembled inline, now wrapped so >30s
    // calls auto-background. think / fact / skills remain CF-only for now.
    const rawTools = buildBuiltinTools({
      rt: this.rt,
      craftedToolExecute: createNodeCraftedExecute(),
      createExecuteTool: createNodeExecuteToolFactory({
        vfs: this.rt.storage.vfs,
        memory: this.rt.memory,
        shell: this.rt.shell,
      }) as never,
      codemodeLoader: { __cli: true } as unknown,
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

  /** Tool names for the banner + /tools view. */
  toolNames(): string[] {
    return Object.keys(this.tools);
  }

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

    const knowledge = (await this.rt.memory.read('memory/MEMORY.md'))?.slice(0, 2000) ?? '';
    const executorNames = (this.rt.executionRouter?.listExecutors() ?? []).map((e) => e.name);
    const systemPrompt = buildSystemPromptSync(this.rt, {
      extraKnowledge: knowledge || undefined,
      registeredExecutors: executorNames,
    });

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
        tools: this.tools,
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
