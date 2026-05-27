/**
 * OrchestratorAgent — self-evolving chat agent extending Think.
 *
 * 5-tool architecture (all tool construction lives in @proteus/core/tools):
 *   execute_tools  — codemode sandbox with workspace.* + codemode.* (crafted) APIs
 *   run            — POSIX shell command with optional executor routing
 *   explore        — MCTS tree search via durable fiber
 *   save_note      — append to MEMORY.md (FTS-indexed)
 *   search_memory  — FTS5 search over long-term memory
 *
 * All filesystem operations (read, write, edit, grep, find, etc.) are available
 * as workspace.* APIs inside the execute_tools codemode sandbox. Crafted tools
 * from the CraftStore are injected as codemode.* inside the sandbox.
 *
 * This file is a THIN ADAPTER: tool factory, system prompt, and crafted-tool
 * injection all live in @proteus/core so the CLI surface shares them verbatim.
 * See docs/V2-MIGRATION.md for the drift-elimination rationale.
 */

import { callable } from "agents";
import { Think, Session } from "@cloudflare/think";
// v2.1-liveness — preamble-injection pattern: we construct the codemode tool
// directly via createCodeTool + PreambleCraftedExecutor. The executor reads
// craftStore.list() on every call and splices a `const tools = {...}`
// preamble into the LLM's sandbox arrow, so mid-turn additions are visible
// on the next execute_tools call and tool bodies share lexical scope with
// workspace.*/codemode.* (see docs/CRAFT-ARCHITECTURE.md).
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, ToolSet } from "ai";
import type {
  TurnContext, TurnConfig, ChatResponseResult,
  ToolCallResultContext, StepContext, ChunkContext,
} from "@cloudflare/think";
import {
  EvolutionEngine,
  bootstrapScaffold,
  initAllTables, initSearchTables, initScaffoldTables, initCraftScoreTables,
  resolveMaxSteps,
  // v2.0 canonical tool + prompt surface — single source of truth
  buildBuiltinTools,
  buildSystemPromptSync,
  createChatModel,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  ACTIVE_TOOLS,
  migrateCraftedToolDuplicates,
  // Fork feature
  forkAgentStorage, readForkLineage,
  nanoid,
  // v2: branching heads
  HeadController, HeadJournal, initHeadsTables, createSplitHeadsTool,
  type SerializedMessage,
  // v2: single canonical memory-note write primitive
  appendMemoryNote,
  // v2: scaffold-loop closure (scaffold-driven inference + shadow rollout)
  runScaffold, type ScaffoldRunResult,
  initShadowTables, getPendingScaffold, decidePromotion, applyPromotionDecision,
  readScaffoldVersion, DEFAULT_SHADOW_CONFIG,
  // v2: durable run-event log
  initRunEventTables, RunEventRecorder,
  type RunEvent, type RunEventQuery,
  // v2: hybrid search (FTS5 + Vectorize via RRF)
  hybridSearch, type HybridHit,
  // v2: SKILL.md export/import (git-friendly crafted-tool format)
  exportAllSkillsToVfs, importSkillsFromVfs,
  type ExportSkillsResult, type ImportSkillsResult,
  type CompletedTurn, type ToolCallRecord, type AgentRuntime,
  type SessionWriter, type SessionMessage, type SqlExecutor,
} from "@proteus/core";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createCFRuntime, type CFRuntime } from "./runtime.js";
import { PreambleCraftedExecutor } from "./crafted-tool-registry.js";
import { createCFHeadRuntime } from "./heads/head-runtime.js";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
const SESSION_REFLECTION_INTERVAL = 5; // turns between session reflections

const AVAILABLE_MODELS = [
  { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6", description: "Advanced reasoning model with extended thinking" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B", description: "General-purpose instruction model" },
] as const;

// ── Fork payload types ────────────────────────────────────────────
// The source DO assembles this and sends it to the fork DO's rawCopyFromFork.
// Everything is JSON-serializable (strings, numbers, null, base64 if ever
// needed for binary VFS content — currently all VFS memory is text).

interface ForkPayload {
  forkName: string;
  lineage: {
    forkOriginAgentId: string;
    forkOriginAgentName: string;
    forkOriginMessageId: string;
    forkOriginCreatedAt: number;
    forkedAt: number;
  };
  soul: { purpose: string; created_at: number };
  messages: Array<{
    id: string; session_id: string; parent_id: string | null;
    role: string; content: string; created_at: number;
  }>;
  conversationHistory: Array<{
    session_id: string; role: string; message: string; created_at: number;
  }>;
  vfsFiles: Array<{
    path: string; chunk_index: number; parent_path: string;
    data: unknown; is_dir: number; size: number; mtime: number;
  }>;
  memoryChunks: Array<{
    id: string; path: string; start_line: number; end_line: number;
    hash: string; text: string; updated_at: number;
  }>;
  craftedTools: Array<{
    name: string; description: string; params: string | null; code: string;
    scope: string; created_at: number; updated_at: number;
  }>;
  agentConfig: Array<{ key: string; value: string }>;
  // Think/Session-owned message rows — the table the chat UI actually reads
  // from. Carried as raw strings (datetime). Includes the time-cutoff at
  // snapshot time; the shim answers the same query with a no-op filter so
  // the helper's time-based SELECT still works across DO boundaries.
  assistantMessages: Array<{
    id: string; session_id: string; parent_id: string | null;
    role: string; content: string; created_at: string;
  }>;
}

/**
 * Build an ephemeral SqlExecutor that answers the queries forkAgentStorage
 * makes against the source DB, using the serialized payload as the source
 * of truth. Only the exact SELECT shapes that forkAgentStorage issues are
 * supported — this is a minimal shim, not a general SQL engine.
 */
function buildSqlFromPayload(payload: ForkPayload) {
  const rawSql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown[] =
    (strings, ...values) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      // Route the small known set of read queries the helper issues.
      if (query.startsWith("SELECT created_at FROM messages WHERE id =")) {
        const wantedId = values[0] as string;
        const hit = payload.messages.find(m => m.id === wantedId);
        return hit ? [{ created_at: hit.created_at }] : [];
      }
      if (query.startsWith("SELECT purpose, created_at FROM agent_soul")) {
        return [payload.soul];
      }
      if (query.startsWith("SELECT id, session_id, parent_id, role, content, created_at FROM messages")) {
        const cutoff = values[0] as number;
        return payload.messages
          .filter(m => m.created_at <= cutoff && m.session_id === "default")
          .sort((a, b) => a.created_at - b.created_at);
      }
      if (query.startsWith("SELECT session_id, role, message, created_at FROM conversation_history")) {
        const cutoff = values[0] as number;
        return payload.conversationHistory
          .filter(c => c.created_at <= cutoff && c.session_id === "default");
      }
      if (query.startsWith("SELECT path, chunk_index, parent_path, data, is_dir, size, mtime FROM vfs_files")) {
        return payload.vfsFiles;
      }
      if (query.startsWith("SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks")) {
        return payload.memoryChunks;
      }
      if (query.startsWith("SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools")) {
        return payload.craftedTools;
      }
      if (query.startsWith("SELECT key, value FROM agent_config")) {
        return payload.agentConfig;
      }
      if (query.startsWith("SELECT id, name FROM agent_identity")) {
        return [{ id: payload.lineage.forkOriginAgentId, name: payload.lineage.forkOriginAgentName }];
      }
      // Think-Session messages: the source DO already time-filtered the
      // snapshot, so the payload contains exactly the rows to copy. We
      // accept any SELECT against assistant_messages that mentions the
      // same columns and return all rows (the time-filter was already
      // applied during snapshot).
      if (query.startsWith("SELECT id, session_id, parent_id, role, content, created_at FROM assistant_messages")) {
        return payload.assistantMessages;
      }
      return [];
    };
  return rawSql as never;
}

export class OrchestratorAgent extends Think<Env> {
  override maxSteps = resolveMaxSteps();

  private _rt: CFRuntime | null = null;
  private _engine: EvolutionEngine | null = null;
  private _turnToolCalls: ToolCallRecord[] = [];
  private _turnStepCount = 0;
  private _turnStartedAt = 0;
  private _turnHadError = false;
  private _sessionTurnCount = 0;
  private _sessionTurns: CompletedTurn[] = [];
  private _sessionStartedAt = Date.now();

  // ── Tool cache: avoid rebuilding 5-tool ToolSet + codemode types every turn ──
  private _cachedTools: ToolSet | null = null;
  private _cachedToolsKey: string = "";

  // Preamble-injection: the codemode tool is built once per DO lifetime.
  // Its executor (PreambleCraftedExecutor) reads craftStore.list() on every
  // execute call, so newly-saved tools appear on the next execute_tools
  // invocation without any registry or cache coherence work.
  private _craftExecTool: unknown = null;

  // v2: branching-heads controller and tool — lazily built once per DO lifetime.
  // The controller wraps a HeadJournal + HeadRuntime (Facet spawner + merge LLM).
  // The split_heads tool reads inheritedContext lazily via assistant_messages.
  private _headController: HeadController | null = null;
  private _splitHeadsTool: ReturnType<typeof createSplitHeadsTool> | null = null;

  // v2: durable run-event recorder (Flue-style discriminated union, SSE-resumable).
  // Initialized lazily on first event so onStart can wire the table before use.
  private _eventRecorder: RunEventRecorder | null = null;
  private get eventRecorder(): RunEventRecorder {
    if (!this._eventRecorder) {
      this._eventRecorder = new RunEventRecorder(this.boundSql);
    }
    return this._eventRecorder;
  }

  /** Convenience: current runId for event emission. One run per turn. */
  private _currentRunId = '';

  // ── Activity logging: persisted + broadcast to Logs pane ──
  private _turnT0 = 0;
  private _firstChunkReceived = false;

  // Per-turn in-flight flag — forkAgent rejects with "agent busy" while set.
  // Set in beforeTurn, cleared in onChatResponse (after durable persist;
  // evolution is fire-and-forget and does not extend the busy window).
  private _inFlight = false;

  // ── Bound SQL executor ────────────────────────────────────────────────
  // `this.sql` is a plain method on the Agent base class — it needs `this`
  // bound to reach `this.ctx.storage.sql`. Passing `this.sql` as a bare
  // function reference to any helper (readForkLineage, forkAgentStorage)
  // loses the binding and fails with `Cannot read properties of undefined
  // (reading 'ctx')`. This closure captures `this` once and can be safely
  // passed by reference.
  private _boundSql: SqlExecutor | null = null;
  private get boundSql(): SqlExecutor {
    if (!this._boundSql) {
      this._boundSql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
        (this.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown[])(strings, ...values)
      ) as SqlExecutor;
    }
    return this._boundSql;
  }

  private logActivity(event: string, detail?: string) {
    const elapsed = this._turnT0 > 0 ? Math.round(performance.now() - this._turnT0) : 0;
    const now = Date.now();
    console.log(`[proteus:${String(elapsed).padStart(6)}ms] ${event}${detail ? ` — ${detail}` : ""}`);
    try {
      this.sql`INSERT INTO activity_log (event, detail, elapsed_ms, created_at)
        VALUES (${event}, ${detail ?? null}, ${elapsed}, ${now})`;
    } catch { /* table may not exist on very first start */ }
  }

  private get rt(): AgentRuntime {
    if (!this._rt) {
      // No onToolRegistered hook: PreambleCraftedExecutor reads craftStore.list()
      // fresh on every execute_tools call, so mid-turn saves propagate
      // without any registry plumbing (see docs/CRAFT-ARCHITECTURE.md §3).
      this._rt = createCFRuntime(this);
    }
    return this._rt;
  }

  private get engine(): EvolutionEngine {
    if (!this._engine) {
      this._engine = new EvolutionEngine(this.rt, {
        enabled: true,
        onMctsProgress: (iteration, remaining) => {
          this.broadcastMctsProgress("iteration", iteration, remaining);
        },
      });
    }
    return this._engine;
  }

  /**
   * Build (or return cached) the execute_tools AI tool for this DO.
   *
   * Construction (once per DO lifetime):
   *   - Build the list of codemode providers: a `codemode` provider seeded
   *     with the pre-existing crafted tools at CONSTRUCTION time (for
   *     type-generation in the description string), plus every registered
   *     executor provider (workspace / nimbus / sandbox / laptop).
   *   - Wire a `PreambleCraftedExecutor` as the executor. It wraps
   *     upstream `DynamicWorkerExecutor` and injects a `const tools = {...}`
   *     preamble per execute, reading craftStore.list() fresh — so tools
   *     saved mid-turn are callable on the next execute_tools step and
   *     crafted-tool bodies inherit lexical scope with `workspace.*` and
   *     `codemode.*` (Phase A + C of CRAFT-ARCHITECTURE.md).
   *
   * Newly-named crafted tools (saved after this tool is constructed) are
   * NOT reflected in the LLM-visible description string, but codemode's
   * sandbox Proxy forwards any property access to the dispatcher — so
   * `codemode.<new_name>(args)` still dispatches into the preamble's
   * `tools.<new_name>` via regular lexical lookup.
   */
  private getExecuteToolsTool(): unknown {
    if (!this._craftExecTool) {
      const env = this.env as Env & Record<string, unknown>;
      if (!env.LOADER) throw new Error("CF runtime missing LOADER binding");

      const executor = new PreambleCraftedExecutor(env.LOADER, this.rt.craftStore);

      // Seed the `codemode` provider with whatever crafted tools exist at
      // construction time so the LLM's initial description string lists them.
      // No-op bodies suffice — the actual execution goes through the preamble.
      const seededCraftedTools: Record<string, { description: string; execute: (arg: unknown) => Promise<unknown> }> = {};
      try {
        for (const t of this.rt.craftStore.list()) {
          if (!t.code || t.code.startsWith('//')) continue;
          seededCraftedTools[t.name] = {
            description: t.description ?? `Crafted tool: ${t.name}`,
            // This execute is never invoked — the preamble injects the real
            // body as a `tools.<name>` literal in-sandbox. The dispatcher
            // miss that would otherwise occur is irrelevant because the
            // sandbox's `codemode.<name>(args)` goes to the local `tools`
            // object, not through the dispatcher. We provide an execute
            // stub only because createCodeTool's ToolProvider shape requires it.
            execute: async () => ({ error: 'crafted tools run through the preamble, not the dispatcher' }),
          };
        }
      } catch { /* craftStore may not be initialized on first onStart */ }

      const executionRouter = this.rt.executionRouter;
      const executorProviders = executionRouter?.getProviders() ?? [];
      const craftedProvider = { name: 'codemode', tools: seededCraftedTools };
      const allProviders = [craftedProvider, ...executorProviders.map(p => ({
        name: p.name,
        tools: p.tools as Record<string, { description?: string; execute: (...args: unknown[]) => Promise<unknown> }>,
        types: p.types,
        positionalArgs: p.positionalArgs,
      }))];

      this._craftExecTool = createCodeTool({
        tools: allProviders as Parameters<typeof createCodeTool>[0]["tools"],
        executor: executor as unknown as Parameters<typeof createCodeTool>[0]["executor"],
      });
    }
    return this._craftExecTool;
  }

  // ── Model resolution ───────────────────────────────────────────

  private getStoredModelId(): string {
    try {
      const rows = this.sql<{ model: string }>`
        SELECT value as model FROM agent_config WHERE key = 'model' LIMIT 1`;
      return rows[0]?.model ?? DEFAULT_MODEL;
    } catch { return DEFAULT_MODEL; }
  }

  private createModel(modelId: string): LanguageModel {
    const env = this.env as Env & Record<string, string>;
    if (env.AI && typeof env.AI !== "string") {
      const binding = env.AI as unknown as Parameters<typeof createWorkersAI>[0]["binding"];
      const factory = createWorkersAI({ binding });
      return createChatModel({
        kind: "workers-ai",
        modelId,
        sessionAffinity: this.sessionAffinity,
        factory: (id, opts) => factory(id, opts) as LanguageModel,
      });
    }
    const gatewayUrl = env.AI_GATEWAY_URL;
    const gatewayAuth = env.AI_GATEWAY_AUTH;
    if (gatewayUrl && gatewayAuth) {
      return createChatModel({
        kind: "ai-gateway",
        baseURL: gatewayUrl,
        auth: gatewayAuth,
        modelId,
      });
    }
    throw new Error("No AI model configured.");
  }

  // ── Think lifecycle overrides ──────────────────────────────────

  getModel(): LanguageModel {
    this.logActivity("getmodel");
    const model = this.createModel(this.getStoredModelId());
    return model;
  }

  /**
   * Delegates to @proteus/core's canonical prompt builder (F1 fix: documents
   * `codemode.*` — the real namespace crafted tools land in — instead of the
   * former `tools.*` lie). Cached across turns; invalidated when the soul
   * text or the registered executor set changes.
   */
  private _cachedSystemPrompt: string | null = null;
  private _cachedSystemPromptKey: string = "";

  getSystemPrompt(): string {
    this.logActivity("getsystemprompt_start");
    const execs = (this.rt.executionRouter?.listExecutors() ?? []).map(e => e.name);
    const key = `${this.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`[0]?.purpose ?? ""}\u0000${execs.join(",")}`;
    if (this._cachedSystemPrompt && this._cachedSystemPromptKey === key) {
      this.logActivity("getsystemprompt_end", "cache hit");
      return this._cachedSystemPrompt;
    }
    const prompt = buildSystemPromptSync(this.rt, { registeredExecutors: execs });
    this._cachedSystemPrompt = prompt;
    this._cachedSystemPromptKey = key;
    this.logActivity("getsystemprompt_end", `${prompt.length} chars`);
    return prompt;
  }

  /**
   * Compute a lightweight cache key from CraftStore + score state.
   * Includes craft_scores.MAX(last_used_at) because effective-score filtering
   * depends on recency — without it, the cached ToolSet would keep re-using a
   * stale score-filtered view across turns even as usage shifts.
   */
  private _craftCacheKey(): string {
    try {
      const craft = this.sql<{ cnt: number; latest: number }>`
        SELECT COUNT(*) as cnt, COALESCE(MAX(updated_at), 0) as latest FROM crafted_tools`;
      const scores = (() => {
        try {
          return this.sql<{ lastUsed: number }>`
            SELECT COALESCE(MAX(last_used_at), 0) as lastUsed FROM craft_scores`;
        } catch { return [{ lastUsed: 0 }]; }
      })();
      const { cnt, latest } = craft[0] ?? { cnt: 0, latest: 0 };
      const lastUsed = scores[0]?.lastUsed ?? 0;
      return `${cnt}:${latest}:${lastUsed}`;
    } catch { return ""; }
  }

  getTools(): ToolSet {
    // getTools() is the first subclass hook called by _runInferenceLoop.
    // Start the per-turn timer here to capture the full pre-inference path.
    this._turnT0 = performance.now();
    this.logActivity("gettools_start");

    // Cache key includes CraftStore updated_at AND craft_scores last_used_at
    // because effective-score filtering depends on recency (v2: F5 fix).
    const cacheKey = this._craftCacheKey();
    if (this._cachedTools && cacheKey === this._cachedToolsKey) {
      this.logActivity("gettools_end", "cache hit");
      return this._cachedTools;
    }
    this.logActivity("gettools_rebuilding", `${this._cachedToolsKey} → ${cacheKey}`);

    try {
      const orchestrator = this;

      // No registry sync: PreambleCraftedExecutor reads craftStore.list()
      // fresh at every execute. See docs/CRAFT-ARCHITECTURE.md §5.6.

      type FiberCtx = { stash(data: unknown): void };
      const activeFiberCtx: { current: FiberCtx | null } = { current: null };
      const tools = buildBuiltinTools({
        rt: this.rt,
        engine: this.engine,
        preBuiltExecuteTool: this.getExecuteToolsTool(),
        // v2: branching-heads tool — lazy-built once, then reused across turns.
        splitHeadsTool: this.getSplitHeadsTool(),
        // v2: Vectorize-backed semantic memory. search_memory auto-uses
        // hybrid retrieval when this is provided + available; FTS5-only fallback.
        vectorStore: this.rt.vectorStore,
        onMctsProgress: (phase, iteration, budget) => this.broadcastMctsProgress(phase, iteration, budget),
        createMctsSession: () => this.createMCTSSession(),
        onExplorePhase: (phase, task) => {
          activeFiberCtx.current?.stash({ task, phase });
        },
        wrapExplore: (fn) => async (args) => {
          return orchestrator.runFiber(`explore-${Date.now()}`, async (ctx) => {
            activeFiberCtx.current = ctx;
            try {
              return await fn(args);
            } finally {
              activeFiberCtx.current = null;
            }
          });
        },
      });

      this._cachedTools = tools;
      this._cachedToolsKey = cacheKey;
      this.logActivity("gettools_end", `rebuilt — ${Object.keys(tools).length} tools`);
      return tools;
    } catch (err) {
      console.error("[proteus] getTools() FAILED:", err);
      throw err;
    }
  }

  /**
   * Lazily build the split_heads tool wired to a HeadController that spawns
   * ExplorationAgent Facets in head mode (initHead / runAsHead / abortHead).
   * Inherited context is read fresh from assistant_messages at every tool
   * invocation so each head sees the full conversation.
   */
  private getSplitHeadsTool() {
    if (this._splitHeadsTool) return this._splitHeadsTool;
    const sqlForJournal = this.sql.bind(this) as unknown as SqlExecutor;
    const journal = new HeadJournal(sqlForJournal);
    const runtime = createCFHeadRuntime(this);
    this._headController = new HeadController(runtime, journal);
    const orchestrator = this;
    this._splitHeadsTool = createSplitHeadsTool({
      controller: this._headController,
      // v2: stream head_split / head_merge into the durable event log so
      // SSE subscribers + MCP `list_run_events` see the split lifecycle.
      onPhase: (event) => {
        try {
          if (!this._currentRunId) return;
          if (event.kind === 'split') {
            this.eventRecorder.emit(this._currentRunId, {
              type: 'head_split',
              rootId: event.rootId,
              headIds: [...event.headIds],
              rationale: event.rationale,
            });
          } else {
            this.eventRecorder.emit(this._currentRunId, {
              type: 'head_merge',
              rootId: event.rootId,
              headCount: event.headCount,
              mergedNarrative: event.mergedNarrative,
            });
          }
        } catch (err) {
          console.warn('[proteus] event emit failed at split-heads onPhase:', err);
        }
      },
      getInheritedContext(): SerializedMessage[] {
        try {
          type Row = { id: string; role: string; content: string; created_at: string };
          const rows = orchestrator.sql<Row>`
            SELECT id, role, content, created_at
            FROM assistant_messages
            ORDER BY created_at ASC`;
          return rows.map((r) => ({
            id: r.id,
            role: (r.role === 'system' || r.role === 'user' || r.role === 'assistant' || r.role === 'tool')
              ? r.role
              : 'assistant',
            content: r.content,
            createdAt: Date.parse(r.created_at) || 0,
          }));
        } catch {
          // assistant_messages table may not yet exist on a fresh agent.
          return [];
        }
      },
      defaultModel: undefined, // heads inherit DEFAULT_MODEL
    });
    return this._splitHeadsTool;
  }

  configureSession(session: Session): Session {
    // Built-in Think compaction — auto-fires when accumulated message
    // tokens cross the threshold. Kimi K2.6's window is large; we compact
    // at ~96k input tokens to leave headroom for the response + tools.
    // Think.Session owns the summarization LLM call internally.
    return session
      .withContext("memory", {
        description:
          "Long-term knowledge: learned facts, user preferences, project context, " +
          "discovered patterns, and crafted tool descriptions.",
        maxTokens: 32000,
      })
      .withCachedPrompt()
      .compactAfter(96_000);
  }

  // ── Think lifecycle hooks ──────────────────────────────────────

  // Tools the model is allowed to call. Think merges workspace tools (read, write,
  // edit, list, find, grep, delete) with ours, bloating the request by ~2800 tokens.
  // activeTools restricts the model to only our 5 tools + session context tools,
  // preventing Think's workspace tools from being sent in the request payload.
  // ACTIVE_TOOLS is sourced from @proteus/core/tools/registry (single truth).
  beforeTurn(_ctx: TurnContext): TurnConfig | void {
    this._turnToolCalls = [];
    this._turnStepCount = 0;
    this._turnStartedAt = Date.now();
    this._turnHadError = false;
    this._firstChunkReceived = false;
    this._inFlight = true;
    this.logActivity("beforeturn", "streamText() called next");
    // v2: start a new run for the event log.
    this._currentRunId = `run-${nanoid()}`;
    try {
      this.eventRecorder.emit(this._currentRunId, {
        type: 'run_start',
        agentId: this.name,
      });
      this.eventRecorder.emit(this._currentRunId, {
        type: 'turn_start',
        turnIndex: this._sessionTurnCount,
      });
    } catch (err) {
      console.warn('[proteus] event emit failed at beforeTurn:', err);
    }
    return { activeTools: [...ACTIVE_TOOLS] };
  }

  onChunk(_ctx: ChunkContext): void {
    if (!this._firstChunkReceived) {
      this._firstChunkReceived = true;
      this.logActivity("first_chunk");
    }
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    // Think 0.4 renamed: args → input, result → output, and added a success
    // discriminator + durationMs. See docs/THINK-UPGRADE-AND-FORKING.md §4 U2.
    // The core ToolCallRecord shape (name/args/result) is stable — we adapt here.
    const c = ctx as unknown as {
      toolName: string;
      input?: Record<string, unknown>;
      durationMs?: number;
      success: boolean;
      output?: unknown;
      error?: unknown;
    };
    const recorded =
      c.success === false
        ? { error: c.error instanceof Error ? c.error.message : String(c.error) }
        : c.output;
    if (c.success === false) this._turnHadError = true;
    const dur = c.durationMs != null ? ` (${c.durationMs}ms)` : "";
    this.logActivity("tool_call_end", `${c.toolName}${dur}`);
    this._turnToolCalls.push({
      name: c.toolName,
      args: (c.input ?? {}) as Record<string, unknown>,
      result: recorded,
    });
    // v2: persist tool_call_end into the durable run-event log.
    try {
      if (this._currentRunId) {
        this.eventRecorder.emit(this._currentRunId, {
          type: 'tool_call_end',
          name: c.toolName,
          toolCallId: `tc-${this._turnToolCalls.length}`,
          result: recorded,
          error: c.success === false ? String(c.error ?? '') : undefined,
          durationMs: c.durationMs,
        });
      }
    } catch (err) {
      console.warn('[proteus] event emit failed at afterToolCall:', err);
    }
  }

  onStepFinish(ctx: StepContext): void {
    // Think 0.4: ctx is AI SDK's full StepResult — stepType is gone from the
    // top level, but toolCalls.length > 0 is a reliable proxy for the old
    // "tool-result" vs "initial" distinction we logged before.
    //
    // StepResult extras surfaced in activity_log (U3):
    //   usage.cachedInputTokens — AI Gateway / prompt-caching savings
    //   usage.reasoningTokens   — Kimi K2.6 reasoning budget consumed
    //   response.modelId        — authoritative model id per step (useful
    //                             when cascading Workers AI → AI Gateway)
    this._turnStepCount++;
    const toolCalls = Array.isArray(ctx.toolCalls) ? ctx.toolCalls : [];
    const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
    const toolCallNames = (toolCalls as Array<{ toolName?: string; name?: string }>)
      .map(tc => tc?.toolName ?? tc?.name ?? "?")
      .join(",");
    const derivedStepType = toolCalls.length > 0 ? "tool-call" : "text";
    const textLen = (ctx.text ?? "").length;
    const u = ctx.usage as {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
    } | undefined;
    const inTok = u?.inputTokens ?? 0;
    const outTok = u?.outputTokens ?? 0;
    const cached = u?.cachedInputTokens ?? 0;
    const reasoning = u?.reasoningTokens ?? 0;
    const modelId = (ctx as unknown as { response?: { modelId?: string } }).response?.modelId;
    const extras: string[] = [];
    if (cached > 0) extras.push(`cached=${cached}`);
    if (reasoning > 0) extras.push(`reasoning=${reasoning}`);
    if (modelId) extras.push(`model=${modelId}`);
    const extrasStr = extras.length > 0 ? ` ${extras.join(" ")}` : "";
    this.logActivity(
      "step_finish",
      `step ${this._turnStepCount} kind=${derivedStepType} reason=${ctx.finishReason} ` +
      `textLen=${textLen} tools=${toolCalls.length}[${toolCallNames}] results=${toolResults.length} ` +
      `in=${inTok} out=${outTok}${extrasStr}`,
    );
    // v2: mirror into the durable run-event log so external SSE subscribers
    // see per-step progress (UI Last-Event-ID resume + MCP/HTTP consumers).
    try {
      if (this._currentRunId) {
        this.eventRecorder.emit(this._currentRunId, {
          type: 'step_finish',
          stepIndex: this._turnStepCount,
          reason: typeof ctx.finishReason === 'string' ? ctx.finishReason : undefined,
        });
      }
    } catch (err) {
      console.warn('[proteus] event emit failed at onStepFinish:', err);
    }
  }

  async onChatResponse(result: ChatResponseResult) {
    this.logActivity("response_complete", result.status);
    // Clear the in-flight flag once the turn is durably completed — forkAgent
    // is allowed again from here forward. Evolution (engine.onTurnCompleteAsync)
    // runs fire-and-forget below and does NOT extend the busy window.
    this._inFlight = false;
    // v2: emit turn_end + run_end into the durable event log.
    try {
      if (this._currentRunId) {
        this.eventRecorder.emit(this._currentRunId, {
          type: 'turn_end',
          turnIndex: this._sessionTurnCount,
        });
        this.eventRecorder.emit(this._currentRunId, {
          type: 'run_end',
          reason: result.status,
        });
      }
    } catch (err) {
      console.warn('[proteus] event emit failed at onChatResponse:', err);
    }
    if (result.status !== "completed") return;

    const userMessages = this.messages.filter(m => m.role === "user");
    const lastUserMsg = userMessages[userMessages.length - 1];
    const userText = lastUserMsg?.parts
      ?.filter(p => p.type === "text")
      .map(p => (p as { type: "text"; text: string }).text)
      .join("") ?? "";

    const assistantText = result.message.parts
      ?.filter(p => p.type === "text")
      .map(p => (p as { type: "text"; text: string }).text)
      .join("") ?? "";

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
          return this._turnStartedAt || Date.now();
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

    const turn: CompletedTurn = {
      userMessage: userText,
      assistantResponse: assistantText,
      toolCalls: this._turnToolCalls,
      steps: this._turnStepCount,
      durationMs: this._turnStartedAt > 0 ? Date.now() - this._turnStartedAt : 0,
      feedback: null,
      hadError: this._turnHadError || result.status === "error",
    };

    // CRITICAL: Evolution hooks make LLM calls (reflection, extraction, session
    // reflection) that take 5-30 seconds each. onChatResponse runs INSIDE
    // Think's TurnQueue — if we await here, the queue is blocked and the next
    // message can't start processing until evolution finishes. The user sees
    // "nothing happens" for the second message.
    //
    // Fix: fire evolution asynchronously. The DO stays alive via keepAliveWhile
    // in the outer scope. Errors are caught and logged, never propagated.
    this._sessionTurnCount++;
    this._sessionTurns.push(turn);

    const sessionTrigger = this._sessionTurnCount >= SESSION_REFLECTION_INTERVAL;
    if (sessionTrigger) {
      const sessionData = {
        sessionId: `${this.ctx.id.toString()}-${Date.now()}`,
        turns: [...this._sessionTurns],
        startedAt: this._sessionStartedAt,
        endedAt: Date.now(),
      };
      this._sessionTurnCount = 0;
      this._sessionTurns = [];
      this._sessionStartedAt = Date.now();

      // Fire session evolution in background
      void this.engine.onSessionComplete(sessionData).catch(err =>
        console.error("[proteus] Session evolution failed:", err)
      );
    }

    // Fire turn-level evolution in background (does NOT block the TurnQueue).
    // EvolutionEngine.onTurnCompleteAsync already does Hermes-style reflection:
    //   • quality assessment + threshold check
    //   • generateTurnReflection → append `### Lesson` to MEMORY.md
    //   • pattern extraction → upsertCraftedTool with Jaccard conflict guard
    //   • session-level reflection every N turns → maybeEvolveScaffold
    // No separate ReviewAgent Facet — this single hook handles all of it.
    this.engine.onTurnCompleteAsync(turn);
  }

  // ── DO initialization ──────────────────────────────────────────

  /**
   * @callable PC-agent WebSocket attach. The top-level Worker's /pc/connect
   * handler upgrades the WebSocket, then calls this RPC with the server-side
   * socket and the presented token. Returns {ok} after verification; the
   * caller is responsible for closing the socket if !ok.
   *
   * Not exposed to the browser UI (too low-level) — but @callable is the
   * simplest reliable way to reach the DO from the Worker.
   */
  @callable() async verifyPcToken(token: string): Promise<{ ok: boolean; tokenId?: string }> {
    try {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS pc_agent_tokens (
          id TEXT PRIMARY KEY, token TEXT NOT NULL, label TEXT,
          created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
        )`,
      );
    } catch { /* exists */ }
    const rows = this.sql<{ id: string }>`
      SELECT id FROM pc_agent_tokens
      WHERE token = ${token} AND revoked_at IS NULL LIMIT 1`;
    if (rows.length === 0) return { ok: false };
    const tokenId = rows[0]!.id;
    this.sql`UPDATE pc_agent_tokens SET last_seen_at = ${Date.now()} WHERE id = ${tokenId}`;
    return { ok: true, tokenId };
  }

  /** Attach a WebSocket to the laptop executor. Called by pc-handler after verifyPcToken. */
  async attachPcSocket(server: WebSocket): Promise<void> {
    try {
      const rt = this.rt as CFRuntime;
      rt.sshExecutor?.setSocket?.(server as unknown as Parameters<NonNullable<typeof rt.sshExecutor.setSocket>>[0]);
      server.addEventListener("close", () => { try { rt.sshExecutor?.clearSocket?.(); } catch { /* ignore */ } });
    } catch (err) {
      console.warn("[proteus] PC attach failed:", (err as Error).message);
    }
  }

  async onStart() {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);

    // Migrate old schemas that conflict with agent-utils implementations.
    try {
      // vfs_files: old schema lacked chunk_index. SqliteFS needs it.
      const vfsCols = this.sql<{ name: string }>`PRAGMA table_info(vfs_files)`;
      if (vfsCols.length > 0 && !vfsCols.some(c => c.name === "chunk_index")) {
        execRaw("DROP TABLE vfs_files");
        console.log("[proteus] Migrated vfs_files to chunked schema");
      }
      // memory_chunks: old schema had 3 columns (id INTEGER, path, content).
      // MemoryStore needs 7 columns (id TEXT, path, start_line, end_line, hash, text, updated_at).
      const mcCols = this.sql<{ name: string }>`PRAGMA table_info(memory_chunks)`;
      if (mcCols.length > 0 && !mcCols.some(c => c.name === "start_line")) {
        execRaw("DROP TABLE IF EXISTS memory_chunks");
        execRaw("DROP TABLE IF EXISTS memory_chunks_fts");
        console.log("[proteus] Migrated memory_chunks to FTS5 schema");
      }
      // search_nodes: add code_used column if missing (new in this version)
      const snCols = this.sql<{ name: string }>`PRAGMA table_info(search_nodes)`;
      if (snCols.length > 0 && !snCols.some(c => c.name === "code_used")) {
        execRaw("ALTER TABLE search_nodes ADD COLUMN code_used TEXT");
        console.log("[proteus] Added code_used column to search_nodes");
      }
    } catch { /* tables don't exist yet — fine */ }

    initAllTables(execRaw);
    initSearchTables(execRaw);
    initScaffoldTables(execRaw);
    initCraftScoreTables(execRaw);
    // v2: branching-heads journal (head_journal, head_evidence, head_merge_results)
    initHeadsTables(execRaw);
    // v2: scaffold shadow-mode tables (scaffold_evaluations + status col)
    initShadowTables(execRaw);
    // v2: durable run-event log (run_events table)
    initRunEventTables(execRaw);

    execRaw(`CREATE TABLE IF NOT EXISTS agent_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`);

    // v2.1(F): one-time per-agent migration that merges case-collision
    // duplicates in crafted_tools + craft_scores left over from pre-v2
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
          `[proteus] v2.1 duplicate migration: merged ${report.mergedGroups} group(s), ` +
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
      const soul = this.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
      if (soul.length === 0) {
        this.sql`INSERT INTO agent_soul (purpose) VALUES (${"A self-evolving coding assistant with MCTS exploration and durable skill evolution."})`;
      }
      const identity = this.sql<{ id: string }>`SELECT id FROM agent_identity LIMIT 1`;
      if (identity.length === 0) {
        this.sql`INSERT INTO agent_identity (id, name, created_at) VALUES (${this.ctx.id.toString()}, ${this.name}, ${Date.now()})`;
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
  }

  // ── Callable RPC methods ───────────────────────────────────────

  private getDisplayName(): string {
    try {
      const rows = this.sql<{ value: string }>`SELECT value FROM agent_config WHERE key = 'display_name' LIMIT 1`;
      return rows[0]?.value ?? this.name;
    } catch { return this.name; }
  }

  @callable()
  async getAgentStatus() {
    try {
      const rows = this.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
      const purpose = rows[0]?.purpose ?? "";
      const identity = this.sql<{ id: string; name: string; created_at: number }>`
        SELECT id, name, created_at FROM agent_identity LIMIT 1`;
      const scaffoldVersion = this.sql<{ v: number }>`
        SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`;
      const searchNodes = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`;
      const craftedTools = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`;
      // Message count reflects the persisted `messages` table, which is the
      // authoritative turn history used for fork cut-points. For non-fork
      // agents this table is populated by onChatResponse's mirror; for forks
      // it's populated by forkAgentStorage's copy. Falling back to the
      // in-memory AIChatAgent array keeps behavior sane before the first
      // turn has been mirrored.
      const tableCount = this.sql<{ c: number }>`
        SELECT COUNT(*) as c FROM messages WHERE session_id = 'default'
      `;
      const messageCount = tableCount[0]?.c ?? this.messages.length;
      // Fork lineage — null for non-forked agents.
      const forkLineage = readForkLineage(this.boundSql);
      return {
        id: identity[0]?.id ?? this.ctx.id.toString(),
        name: identity[0]?.name ?? this.name,
        displayName: this.getDisplayName(),
        purpose,
        createdAt: identity[0]?.created_at ?? 0,
        scaffoldVersion: scaffoldVersion[0]?.v ?? 0,
        searchNodeCount: searchNodes[0]?.c ?? 0,
        craftedToolCount: craftedTools[0]?.c ?? 0,
        messageCount,
        model: this.getStoredModelId(),
        forkLineage,
      };
    } catch {
      return { id: this.ctx.id.toString(), name: this.name, displayName: this.name, purpose: "", createdAt: 0,
        scaffoldVersion: 0, searchNodeCount: 0, craftedToolCount: 0, messageCount: 0, model: DEFAULT_MODEL,
        forkLineage: null };
    }
  }

  @callable() async getToolList() {
    const crafted = this.rt.craftStore.list().map(t => {
      const scoreRow = this.sql<{ score: number; uses: number }>`
        SELECT score, uses FROM craft_scores WHERE tool_name = ${t.name} LIMIT 1`;
      return {
        name: t.name, description: t.description, scope: t.scope,
        qualityScore: scoreRow[0]?.score ?? 0.5,
        usageCount: scoreRow[0]?.uses ?? 0,
      };
    });
    return {
      builtIn: [...BUILTIN_TOOLS],
      crafted,
    };
  }

  @callable() async doSearchMemory(query: string) { return this.rt.memory.search(query, 10); }

  @callable() async getMctsTree() {
    return this.sql`SELECT id, parent_id, depth, visits, value, status, action, task, observation, created_at
      FROM search_nodes ORDER BY depth, created_at`;
  }

  @callable() async getEvolutionEvents(limit: number = 50) {
    return this.sql`SELECT id, type, message, data, created_at
      FROM evolution_events ORDER BY created_at DESC LIMIT ${limit}`;
  }

  // ── v2: Fiber recovery — durable execution surviving DO eviction ──
  //
  // The MCTS engine (mcts/engine.ts) calls rt.schedule.fiber('mcts', fn) which
  // delegates to agent.runFiber(). Per-iteration ctx.stash(phase) checkpoints
  // progress to cf_agents_runs. If the DO is evicted mid-MCTS, the Agent SDK
  // re-invokes onFiberRecovered with the last snapshot on cold-start.
  //
  // The default base implementation just warns; we override to:
  //   • log the recovery into evolution_events for the UI
  //   • broadcast a "recovered" event so the chat panel can show the resume
  //   • write a memory note so future turns know about the interruption
  override async onFiberRecovered(ctx: {
    id: string;
    name: string;
    snapshot: unknown;
    createdAt: number;
  }): Promise<void> {
    try {
      const summary = ctx.snapshot && typeof ctx.snapshot === 'object'
        ? JSON.stringify(ctx.snapshot).slice(0, 400)
        : String(ctx.snapshot ?? 'null');
      console.log(`[proteus] fiber recovered: name=${ctx.name} id=${ctx.id}; snapshot=${summary}`);
      // Persist for the UI's evolution-events stream.
      this.sql`INSERT INTO evolution_events (id, type, message, data, created_at)
        VALUES (${nanoid()}, 'fiber_recovered',
                ${`Fiber "${ctx.name}" recovered after interruption`},
                ${JSON.stringify({ name: ctx.name, fiberId: ctx.id, snapshot: ctx.snapshot, createdAt: ctx.createdAt })},
                ${Date.now()})`;
      try {
        await this.rt.memory.append(
          'memory/MEMORY.md',
          `\n### Fiber recovery (${new Date().toISOString().split('T')[0]})\n` +
          `Fiber "${ctx.name}" was interrupted (likely DO eviction) and recovered. ` +
          `Snapshot at interruption: ${summary}\n`,
        );
      } catch { /* memory may not be initialized yet */ }
    } catch (err) {
      console.error('[proteus] onFiberRecovered handler failed:', err);
    }
  }

  // ── v2: Scaffold loop closure — RPCs for manual exercise + shadow rollout ──

  /**
   * Execute the agent's current scaffold for a one-shot task. Captures all
   * events the scaffold emits and returns them — does NOT inject anything
   * back into the chat conversation. Use this to test scaffold mutations
   * without affecting the main turn loop.
   *
   * When `useShadowOverride` is true, runs the pending scaffold instead of
   * the current one (if a pending exists).
   */
  @callable()
  async runScaffoldOnce(
    task: string,
    opts?: { useShadowOverride?: boolean; timeoutMs?: number },
  ): Promise<ScaffoldRunResult> {
    const pending = opts?.useShadowOverride ? getPendingScaffold(this.boundSql) : null;
    const codeOverride = pending
      ? (await readScaffoldVersion(this.rt, pending.version)) ?? undefined
      : undefined;
    return runScaffold({
      rt: this.rt, task,
      emit: () => undefined, // RPC mode — events captured in result.events
      llmStream: this.makeScaffoldLLMStream(),
      callTool: this.makeScaffoldCallTool(),
      scaffoldCodeOverride: codeOverride,
      timeoutMs: opts?.timeoutMs,
    });
  }

  /** Return the current shadow-rollout status: pending version, win counts, decision. */
  @callable()
  async getShadowStatus() {
    const pending = getPendingScaffold(this.boundSql);
    if (!pending) {
      const versions = this.sql<{ version: number; status: string; rationale: string; written_at: number }>`
        SELECT version, status, rationale, written_at FROM scaffold_versions ORDER BY version DESC LIMIT 10`;
      return { hasPending: false as const, versions };
    }
    const decision = decidePromotion(pending, DEFAULT_SHADOW_CONFIG);
    return { hasPending: true as const, pending, decision, config: DEFAULT_SHADOW_CONFIG };
  }

  /**
   * Apply the pending scaffold rollout decision manually.
   *
   * `mode='auto'` consults decidePromotion and acts on its verdict (only
   * acts if decision != 'continue').
   * `mode='promote'` / `mode='rollback'` forces the corresponding action.
   */
  @callable()
  async applyScaffoldDecision(mode: 'auto' | 'promote' | 'rollback') {
    const pending = getPendingScaffold(this.boundSql);
    if (!pending) return { ok: false, error: 'no pending scaffold' };
    let decision: 'promote' | 'rollback' | 'continue';
    if (mode === 'auto') {
      decision = decidePromotion(pending, DEFAULT_SHADOW_CONFIG).decision;
      if (decision === 'continue') return { ok: false, error: 'inconclusive; need more trials' };
    } else {
      decision = mode;
    }
    const fromVersion = pending.version - (decision === 'promote' ? 1 : 0);
    const result = await applyPromotionDecision(this.rt, pending, decision);
    // v2: emit the promotion/rollback into the durable event log so SSE
    // subscribers + MCP `list_run_events` see the decision in-band.
    try {
      const runId = this._currentRunId || `scaffold-${nanoid()}`;
      this.eventRecorder.emit(runId, {
        type: decision === 'promote' ? 'scaffold_promotion' : 'scaffold_rollback',
        fromVersion,
        toVersion: result.newCurrentVersion,
      });
    } catch (err) {
      console.warn('[proteus] event emit failed at applyScaffoldDecision:', err);
    }
    return { ok: true, ...result };
  }

  /** List recent scaffold versions with their status. */
  @callable()
  async listScaffoldVersions(limit: number = 20) {
    return this.sql<{ version: number; written_at: number; rationale: string; status: string }>`
      SELECT version, written_at, rationale, status FROM scaffold_versions
      ORDER BY version DESC LIMIT ${limit}`;
  }

  // ── v2: Durable run-event log — read endpoints + run listing ──

  /**
   * Paginated read of a single run's events. For SSE-style resume, pass
   * the last seen `since` index and the recorder returns events strictly
   * after it.
   */
  @callable()
  async getRunEvents(runId: string, opts?: RunEventQuery): Promise<RunEvent[]> {
    return this.eventRecorder.read(runId, opts ?? {});
  }

  /** List the agent's recent runs with their latest timestamp + event count. */
  @callable()
  async listRuns(limit: number = 50): Promise<Array<{ runId: string; lastTs: string; eventCount: number }>> {
    return this.eventRecorder.listRuns(limit);
  }

  /** Count events for a single run — for UI badges. */
  @callable()
  async countRunEvents(runId: string): Promise<number> {
    return this.eventRecorder.count(runId);
  }

  // ── v2: MCP server bridge — small RPCs the MCP handler needs ──
  /** Used by /mcp/v1/<name> save_note tool. Routes through the same
   *  appendMemoryNote primitive as workspace.saveNote + save_note builtin. */
  @callable()
  async saveNoteFromMcp(content: string): Promise<{ ok: true }> {
    await appendMemoryNote(this.rt.memory, content);
    return { ok: true };
  }

  // ── v2: Hybrid memory search — FTS5 + Vectorize via RRF ──
  /**
   * Semantic + lexical search merged via Reciprocal Rank Fusion.
   * Falls back to pure FTS5 when the Vectorize binding isn't configured.
   *
   * Returns enriched HybridHit[] with sources, RRF score, and individual
   * lexical/semantic scores when available.
   */
  @callable()
  async searchMemoryHybrid(query: string, limit: number = 10): Promise<HybridHit[]> {
    const lexicalSearchFn = async (q: string, k: number) => {
      const results = await this.rt.memory.search(q, k);
      return results.map((r) => ({
        // Construct a stable id from path + line range — matches how the
        // VectorStore stores chunks (caller upserts with this same id).
        id: `${r.path}#${r.startLine}-${r.endLine}`,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: r.snippet,
      }));
    };
    return hybridSearch(query, lexicalSearchFn, this.rt.vectorStore, { finalK: limit });
  }

  /** Returns whether semantic memory is enabled on this deployment. */
  @callable()
  async vectorStoreStatus(): Promise<{ available: boolean }> {
    return { available: this.rt.vectorStore.available };
  }

  // ── v2: SKILL.md export/import — make crafted tools git-friendly ──

  /**
   * Export every crafted tool to a SKILL.md file under `skills/` in the VFS.
   * Returns counts + per-tool error list. Skips tools whose code is empty
   * or comment-only.
   */
  @callable()
  async exportSkillsToVfs(dir?: string): Promise<ExportSkillsResult> {
    return exportAllSkillsToVfs(this.rt.storage.vfs as never, this.rt.craftStore as never, { dir });
  }

  /**
   * Import every SKILL.md file under `skills/` in the VFS back into the
   * CraftStore. For existing tools: update in place. For new ones: create.
   * Parse errors are reported per-file but don't halt the import.
   */
  @callable()
  async importSkillsFromVfs(dir?: string): Promise<ImportSkillsResult> {
    return importSkillsFromVfs(this.rt.storage.vfs as never, this.rt.craftStore as never, { dir });
  }

  /**
   * Internal: build an llmStream() callback for the scaffold executor. The
   * scaffold's `host.llmStream(opts)` calls this and chunks come back as
   * 'text_delta' events.
   */
  private makeScaffoldLLMStream() {
    const env = this.env as Env & Record<string, string>;
    const model = env.AI && typeof env.AI !== "string"
      ? createWorkersAI({ binding: env.AI })(DEFAULT_MODEL)
      : null;
    return async function* (opts: { system?: string; messages: Array<{ role: string; content: string }> }) {
      // Use generateText non-streaming for simplicity; chunked via splitting.
      // A future v2.1 upgrade can wire Vercel's streamText for true streaming.
      const { generateText } = await import('ai');
      const m = model ?? createOpenAICompatible({
        name: "workers-ai",
        baseURL: env.AI_GATEWAY_URL ?? "",
        headers: { Authorization: env.AI_GATEWAY_AUTH ?? "" },
      }).chatModel(`workers-ai/${DEFAULT_MODEL}`);
      const result = await generateText({
        model: m,
        system: opts.system,
        messages: opts.messages.map((mm) => ({ role: mm.role as 'user' | 'assistant' | 'system', content: mm.content })),
        maxOutputTokens: 2048,
      });
      // Emit as a single chunk for now; future: real streaming via streamText().
      yield result.text;
    };
  }

  /**
   * Internal: build a callTool callback that dispatches to the parent's
   * ToolSet. Used by the scaffold to invoke any tool the orchestrator has
   * (e.g. save_note, search_memory).
   */
  private makeScaffoldCallTool() {
    const orchestrator = this;
    return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const tools = orchestrator.getTools();
      const t = tools[name];
      if (!t || typeof t.execute !== 'function') {
        return { error: `tool not found: ${name}` };
      }
      try {
        return await t.execute(args as never, {
          messages: [], toolCallId: `scaffold-${Date.now()}`,
        } as never);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };
  }

  @callable() async getMemoryContent() {
    try { return await this.rt.memory.read("memory/MEMORY.md") ?? ""; }
    catch { return ""; }
  }

  /**
   * Phase D evidence RPC: returns the LIVE execute_tools.description string —
   * the exact text the LLM sees in its tool list. Used by the evidence script
   * to assert that crafted tools appear under `codemode.<name>` in the
   * generated TypeScript-like interface codemode emits.
   *
   * This is introspection-only: it calls the same getTools() the chat loop
   * does, then extracts the description. No side effects.
   */
  @callable() async getExecuteToolsDescription() {
    const tools = this.getTools();
    const et = tools.execute_tools as { description?: string } | undefined;
    return { description: et?.description ?? '' };
  }

  @callable() async getToolDescriptions() {
    // Descriptions sourced from @proteus/core/tools/registry — single truth.
    // Fixes F1 (tools.* → codemode.*) by virtue of the canonical source.
    const builtIn = BUILTIN_TOOLS.map(name => ({
      name,
      description: BUILTIN_TOOL_DESCRIPTIONS[name],
    }));
    const craftedRaw = this.rt.craftStore.list();
    const crafted = craftedRaw.map(t => {
      const scoreRow = this.sql<{ score: number; uses: number }>`
        SELECT score, uses FROM craft_scores WHERE tool_name = ${t.name} LIMIT 1`;
      return {
        name: t.name,
        description: t.description || "Crafted tool",
        isLearned: true,
        qualityScore: scoreRow[0]?.score ?? 0.5,
        usageCount: scoreRow[0]?.uses ?? 0,
      };
    });
    const executors = this.rt.executionRouter?.listExecutors() ?? [];
    return { builtIn, crafted, executors };
  }

  @callable() async setModel(modelId: string) {
    this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('model', ${modelId})`;
    return { model: modelId };
  }

  @callable() async setDisplayName(displayName: string) {
    this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('display_name', ${displayName})`;
    return { displayName };
  }

  @callable() async getExecutors() {
    return this.rt.executionRouter?.listExecutors() ?? [];
  }

  @callable() async getExecutorOutput(executorId: string, limit: number = 50) {
    return this.sql`SELECT id, executor, command, stdout, stderr, exit_code, created_at
      FROM executor_output WHERE executor = ${executorId}
      ORDER BY created_at DESC LIMIT ${limit}`;
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
      const isError = stdout.startsWith('Error') || stdout.startsWith('exit');

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

  @callable() async getExecutorFiles(executorId: string, path: string) {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { error: `Executor "${executorId}" not found` };
    const readdirTool = provider.tools.readdir;
    if (!readdirTool) return { error: `Executor "${executorId}" has no readdir tool` };
    try {
      const result = await readdirTool.execute(path || '/');
      return { entries: result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Direct RPC to the sandbox executor's exposePort tool. Used by the UI
   * and by integration tests to pin a port to the preview iframe grid.
   * Returns the public URL on success.
   */
  @callable() async exposeSandboxPort(port: number, name?: string): Promise<{ url?: string; error?: string }> {
    const provider = this.rt.executionRouter?.getProvider('sandbox');
    if (!provider) return { error: 'sandbox executor not available' };
    const tool = provider.tools.exposePort;
    if (!tool) return { error: 'sandbox executor has no exposePort' };
    try {
      const raw = name ? await tool.execute(port, name) : await tool.execute(port);
      const url = typeof raw === 'string' ? raw : undefined;
      return { url };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Return the current list of exposed ports for a given executor. Powers
   * the auto-refreshing preview grid in the Executors tab. Sandbox returns
   * its active `exposePort(...)` registrations; other executors return [].
   */
  @callable() async getExposedPorts(executorId: string) {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { ports: [] as Array<{ port: number; name?: string; url?: string }> };
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

  /**
   * Issue a one-shot PC-agent install token. The React UI calls this from
   * the "Your PC" tab → Generate install command. The token is stored
   * server-side (unhashed for simplicity in v1; hashing is a follow-up),
   * and the returned `curl | bash` snippet inlines it for copy-paste.
   *
   * Tokens are bound to this agent's DO. The /pc/connect handler checks
   * the presented token against pc_agent_tokens and calls
   * rt.sshExecutor.setSocket(...) on match.
   */
  @callable() async issuePcToken(label?: string) {
    // Lazy schema init — runs once per DO.
    try {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS pc_agent_tokens (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          label TEXT,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER,
          revoked_at INTEGER
        )`,
      );
    } catch { /* already exists */ }

    // Revoke any existing non-revoked tokens for this agent (one-at-a-time).
    const now = Date.now();
    this.sql`UPDATE pc_agent_tokens SET revoked_at = ${now} WHERE revoked_at IS NULL`;

    const id = nanoid();
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    this.sql`INSERT INTO pc_agent_tokens (id, token, label, created_at)
      VALUES (${id}, ${token}, ${label ?? null}, ${now})`;

    // Construct the install command. Agent name is this.name (the DO name).
    const origin = 'https://proteus.ashishkumarsingh.com';
    const installCmd =
      `PROTEUS_AGENT=${this.name} PROTEUS_TOKEN=${token} ` +
      `curl -fsSL ${origin}/pc/install | bash`;
    return { id, token, installCommand: installCmd, origin };
  }

  /** List non-revoked PC tokens for this agent (UI status card). */
  @callable() async listPcTokens() {
    try {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS pc_agent_tokens (
          id TEXT PRIMARY KEY, token TEXT NOT NULL, label TEXT,
          created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
        )`,
      );
    } catch { /* already exists */ }
    const rows = this.sql<{ id: string; label: string | null; created_at: number; last_seen_at: number | null }>`
      SELECT id, label, created_at, last_seen_at
      FROM pc_agent_tokens WHERE revoked_at IS NULL
      ORDER BY created_at DESC`;
    return { tokens: rows };
  }

  @callable() async getAvailableModels() {
    return { current: this.getStoredModelId(), models: AVAILABLE_MODELS };
  }

  @callable() async setSoul(purpose: string) {
    this.sql`UPDATE agent_soul SET purpose = ${purpose}`;
    return { purpose };
  }

  @callable() async clearMemory() {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    execRaw("DELETE FROM vfs_files WHERE path LIKE 'memory/%'");
    execRaw("DELETE FROM memory_chunks");
    try { execRaw("DELETE FROM memory_chunks_fts"); } catch { /* FTS table may not exist */ }
    return { cleared: true };
  }

  @callable() async resetMctsTree() {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    execRaw("DELETE FROM search_nodes");
    return { cleared: true };
  }

  @callable() async getLogs(limit = 100) {
    type LogType = "connection" | "tool" | "evolution" | "error" | "info";
    const evoRows = this.sql<{ id: string; type: string; message: string; created_at: number }>`
      SELECT id, type, message, created_at FROM evolution_events ORDER BY created_at DESC LIMIT ${limit}`;
    const evoLogs = evoRows.map(e => ({
      id: e.id,
      time: e.created_at,
      type: (e.type.includes("error") ? "error" : "evolution") as LogType,
      message: `[${e.type}] ${e.message}`,
    }));
    let actLogs: Array<{ id: string; time: number; type: LogType; message: string; detail?: string }> = [];
    try {
      const actRows = this.sql<{ id: string; event: string; detail: string | null; elapsed_ms: number; created_at: number }>`
        SELECT id, event, detail, elapsed_ms, created_at FROM activity_log ORDER BY created_at DESC LIMIT ${limit}`;
      actLogs = actRows.map(a => {
        // Color-code by latency: info (green) <1s, tool (amber) 1-5s, error (red) >5s
        const type: LogType = a.elapsed_ms > 5000 ? "error" : a.elapsed_ms > 1000 ? "tool" : "info";
        return {
          id: a.id,
          time: a.created_at,
          type,
          message: `[${a.elapsed_ms}ms] ${a.event}`,
          detail: a.detail ?? undefined,
        };
      });
    } catch { /* table may not exist yet */ }
    const merged = [...evoLogs, ...actLogs];
    merged.sort((a, b) => b.time - a.time);
    return merged.slice(0, limit);
  }

  @callable() async getMctsConfig() {
    const rows = this.sql<{ key: string; value: string }>`
      SELECT key, value FROM agent_config WHERE key IN ('mcts_c', 'mcts_iterations', 'mcts_depth', 'mcts_branches')`;
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key] = r.value;
    return {
      explorationConstant: parseFloat(cfg.mcts_c ?? "1.414"),
      maxIterations: parseInt(cfg.mcts_iterations ?? "50"),
      maxDepth: parseInt(cfg.mcts_depth ?? "5"),
      branchBudget: parseInt(cfg.mcts_branches ?? "3"),
    };
  }

  @callable() async setMctsConfig(config: { explorationConstant?: number; maxIterations?: number; maxDepth?: number; branchBudget?: number }) {
    if (config.explorationConstant !== undefined) this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('mcts_c', ${String(config.explorationConstant)})`;
    if (config.maxIterations !== undefined) this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('mcts_iterations', ${String(config.maxIterations)})`;
    if (config.maxDepth !== undefined) this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('mcts_depth', ${String(config.maxDepth)})`;
    if (config.branchBudget !== undefined) this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('mcts_branches', ${String(config.branchBudget)})`;
    return config;
  }

  /**
   * Broadcast the current MCTS tree to all connected WebSocket clients.
   * Called after each MCTS iteration so the UI updates in real-time.
   */
  broadcastMctsProgress(phase: string, iteration?: number, budget?: number) {
    try {
      const nodes = this.sql`SELECT id, parent_id, depth, visits, value, status, action, task, observation, created_at
        FROM search_nodes ORDER BY depth, created_at`;
      this.broadcast(JSON.stringify({
        type: "mcts-progress",
        phase,
        iteration,
        budget,
        nodeCount: nodes.length,
        nodes,
      }));
    } catch (err) {
      console.warn("[proteus] broadcastMctsProgress failed:", err);
    }
  }

  @callable()
  async getActivityLog(limit = 100) {
    try {
      return this.sql<{ id: string; event: string; detail: string | null; elapsed_ms: number; created_at: number }>`
        SELECT id, event, detail, elapsed_ms, created_at FROM activity_log
        ORDER BY created_at DESC LIMIT ${limit}`;
    } catch { return []; }
  }

  // ── Fork RPCs ──────────────────────────────────────────────────

  /**
   * Fork this agent at a specific message, producing a new agent DO with:
   *   - soul copied, messages 0..N copied, crafted tools snapshotted,
   *     memory copied, agent_config copied (display_name overwritten)
   *   - search tree, evolution events, scaffold, craft_scores RESET
   *
   * See docs/THINK-UPGRADE-AND-FORKING.md §6 for the full spec.
   */
  @callable()
  async forkAgent(
    untilMessageId: string,
    opts?: { name?: string },
  ): Promise<{ id: string; name: string; url: string; forkPointMs: number }> {
    // 1. Busy check — reject during an in-flight turn.
    if (this._inFlight) {
      throw new Error("agent busy, retry when current turn finishes");
    }

    // 2. Resolve the fork point here (early) so we can reject with a useful
    //    error before paying the cost of spinning up a new DO.
    const hit = this.sql<{ created_at: number }>`
      SELECT created_at FROM messages WHERE id = ${untilMessageId} AND session_id = 'default'
    `;
    if (hit.length === 0) {
      throw new Error(`fork point not found: message id "${untilMessageId}"`);
    }

    // 3. Generate / validate the fork's name.
    const requestedName = opts?.name?.trim();
    const forkName = requestedName && requestedName.length > 0
      ? requestedName
      : `${this.name}-fork-${nanoid(6)}`;
    if (!/^[A-Za-z0-9_-]+$/.test(forkName)) {
      throw new Error(`invalid agent name: "${forkName}" — allowed: A-Z, a-z, 0-9, _ and -`);
    }

    // 4. Validate name uniqueness by checking if a DO at that name already
    //    has identity data. Fresh DOs return an empty agent_identity query.
    const env = this.env as unknown as {
      OrchestratorAgent: {
        idFromName(name: string): DurableObjectId;
        get(id: DurableObjectId): DurableObjectStub<OrchestratorAgent>;
      };
    };
    const forkStubForPrecheck = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(forkName));
    let existingIdentity: { id: string; name: string } | null = null;
    try {
      // A bare getAgentStatus call on a fresh DO returns an empty agent_soul
      // (purpose: "") and an agent_identity row with the default-bootstrap
      // name matching the DO's runtime name. We detect "already used" by
      // asking for messageCount — a fresh DO has 0 messages AND a fresh
      // agent_soul (purpose == ""). Any agent with prior state has either.
      const status = await (forkStubForPrecheck as unknown as { getAgentStatus(): Promise<{ messageCount: number; purpose: string; name: string }> }).getAgentStatus();
      if (status.messageCount > 0 || status.purpose.length > 0) {
        existingIdentity = { id: "", name: status.name };
      }
    } catch {
      // If the pre-check RPC fails for transient reasons, let the copy path
      // surface the error. Don't block on a brittle signal.
    }
    if (existingIdentity && requestedName) {
      throw new Error(`agent name already exists: "${forkName}"`);
    }

    // 5. Build the snapshot payload.
    const payload = this.buildForkPayload(untilMessageId, forkName);

    // 6. Send it to the fork DO via the rawCopyFromFork RPC.
    const forkStub = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(forkName));
    const copyResult = await (forkStub as unknown as {
      rawCopyFromFork(p: ForkPayload): Promise<{ ok: true; agentId: string }>;
    }).rawCopyFromFork(payload);

    return {
      id: copyResult.agentId,
      name: forkName,
      url: `/agent/${forkName}`,
      forkPointMs: hit[0]!.created_at,
    };
  }

  /**
   * Receive a fork payload from a source agent. INTERNAL — called only by
   * the source DO's forkAgent RPC via cross-DO stub. Exposed as @callable
   * because that's how cross-DO RPC reaches us; there's no hostile client
   * risk here because the fork DO is freshly-provisioned at call time.
   */
  @callable()
  async rawCopyFromFork(payload: ForkPayload): Promise<{ ok: true; agentId: string }> {
    // Ensure the full schema is applied. onStart runs on first access, but if
    // this RPC is somehow invoked before onStart completes, we want it to be
    // idempotent w.r.t. DDL.
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    initAllTables(execRaw);
    // agent_config is a runtime-created table on the orchestrator side; make
    // sure the fork has it before forkAgentStorage tries to copy rows.
    execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    // Build an ephemeral SqlExecutor over the source's row payload. We don't
    // have cross-DO SQL queries — the payload IS the materialized source view.
    const srcSql = buildSqlFromPayload(payload);

    // Copy atomically. `this.boundSql` is a stable closure over `this.sql`
    // that preserves the `this`-binding the Agent base class needs.
    this.ctx.storage.transactionSync(() => {
      forkAgentStorage(srcSql, this.boundSql, {
        untilMessageId: payload.lineage.forkOriginMessageId,
        targetAgentId: this.ctx.id.toString(),
        targetAgentName: payload.forkName,
        now: payload.lineage.forkedAt,
      });
    });

    return { ok: true, agentId: this.ctx.id.toString() };
  }

  /** Expose the single-row fork_lineage for the UI lineage chip. */
  @callable()
  async getForkLineage() {
    return readForkLineage(this.boundSql);
  }

  /**
   * Snapshot every row the fork helper will need into a JSON-serializable
   * payload. Runs inside the source DO where `this.sql` has direct SQL access.
   */
  private buildForkPayload(untilMessageId: string, forkName: string): ForkPayload {
    const identity = this.sql<{ id: string; name: string }>`SELECT id, name FROM agent_identity LIMIT 1`;
    const soul = this.sql<{ purpose: string; created_at: number }>`SELECT purpose, created_at FROM agent_soul LIMIT 1`;
    const hit = this.sql<{ created_at: number }>`
      SELECT created_at FROM messages WHERE id = ${untilMessageId} AND session_id = 'default'
    `;
    const forkPointMs = hit[0]!.created_at;
    const messages = this.sql<ForkPayload["messages"][number]>`
      SELECT id, session_id, parent_id, role, content, created_at
      FROM messages
      WHERE created_at <= ${forkPointMs} AND session_id = 'default'
      ORDER BY created_at ASC
    `;
    const conv = this.sql<ForkPayload["conversationHistory"][number]>`
      SELECT session_id, role, message, created_at
      FROM conversation_history
      WHERE created_at <= ${forkPointMs} AND session_id = 'default'
      ORDER BY id ASC
    `;
    const vfs = this.sql<ForkPayload["vfsFiles"][number]>`
      SELECT path, chunk_index, parent_path, data, is_dir, size, mtime
      FROM vfs_files WHERE path LIKE 'memory/%' OR (path = 'memory' AND is_dir = 1)
    `;
    let memChunks: ForkPayload["memoryChunks"] = [];
    try {
      memChunks = this.sql<ForkPayload["memoryChunks"][number]>`
        SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks
      `;
    } catch { /* table may not exist yet */ }
    const tools = this.sql<ForkPayload["craftedTools"][number]>`
      SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools
    `;
    let agentConfig: ForkPayload["agentConfig"] = [];
    try {
      agentConfig = this.sql<ForkPayload["agentConfig"][number]>`SELECT key, value FROM agent_config`;
    } catch { /* agent_config may not exist yet */ }

    // Snapshot Think's Session-owned messages up to the cut point. The chat
    // UI hydrates from assistant_messages (via session.getHistory()'s
    // recursive CTE), so we must carry these or the fork's chat pane shows
    // the empty state. Time comparison uses strftime to turn the datetime
    // column into a unix-ms for comparison with our forkPointMs.
    let amsgs: ForkPayload["assistantMessages"] = [];
    try {
      amsgs = this.sql<ForkPayload["assistantMessages"][number]>`
        SELECT id, session_id, parent_id, role, content, created_at
        FROM assistant_messages
        WHERE strftime('%s', created_at) * 1000 <= ${forkPointMs}
        ORDER BY created_at ASC
      `;
    } catch { /* assistant_messages created lazily by Session — may not exist */ }

    return {
      forkName,
      lineage: {
        forkOriginAgentId: identity[0]?.id ?? this.ctx.id.toString(),
        forkOriginAgentName: identity[0]?.name ?? this.name,
        forkOriginMessageId: untilMessageId,
        forkOriginCreatedAt: forkPointMs,
        forkedAt: Date.now(),
      },
      soul: soul[0] ?? { purpose: "", created_at: Date.now() },
      messages,
      conversationHistory: conv,
      vfsFiles: vfs,
      memoryChunks: memChunks,
      craftedTools: tools,
      agentConfig,
      assistantMessages: amsgs,
    };
  }

  @callable()
  async triggerEvolution(budget = 5) {
    // Outer fiber for durability + checkpointing. Nested fibers are supported
    // in the Agent SDK (each gets its own ID, cf_agents_runs row, ALS context).
    return this.runFiber("lifetime-evolution", async (ctx) => {
      ctx.stash({ phase: "starting", budget });
      this.broadcastMctsProgress("starting", 0, budget);
      const session = this.createMCTSSession();
      ctx.stash({ phase: "mcts", budget });
      await this.engine.onLifetimeEvolution(session);
      this.broadcastMctsProgress("completed");
      ctx.stash({ phase: "completed" });
      return { status: "completed", budget };
    });
  }

  // ── Internal: MCTS session writer ──────────────────────────────

  private createMCTSSession(): SessionWriter {
    const messages: Array<{ id: string; parentId: string | null; role: "user" | "assistant"; content: string }> = [];
    const agentSql = (strings: TemplateStringsArray, ...values: unknown[]) =>
      (this.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown[])(strings, ...values);

    return {
      async appendMessage(msg: SessionMessage, parentId?: string | null): Promise<void> {
        const content = msg.parts.map(p => p.text).join("");
        messages.push({ id: msg.id, parentId: parentId ?? null, role: msg.role, content });
        agentSql`INSERT INTO messages (id, session_id, parent_id, role, content)
          VALUES (${msg.id}, ${"mcts"}, ${parentId ?? null}, ${msg.role}, ${content})`;
      },
      getHistory(leafId?: string | null): Array<{ role: string; content: string }> {
        if (!leafId) return messages.map(m => ({ role: m.role, content: m.content }));
        const result: Array<{ role: string; content: string }> = [];
        let current = messages.find(m => m.id === leafId);
        while (current) {
          result.unshift({ role: current.role, content: current.content });
          current = current.parentId ? messages.find(m => m.id === current!.parentId) : undefined;
        }
        return result;
      },
      async compact(): Promise<void> {},
    };
  }
}
