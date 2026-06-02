/**
 * OrchestratorAgent — self-evolving chat agent extending Think.
 *
 * Tool surface (constructed in @proteus/core/tools/builtins) — kept small so
 * the LLM selects well:
 *   execute_tools — codemode sandbox: workspace.* + sandbox.* + codemode.*
 *                   (crafted) + llm.query (Recursive Language Models)
 *   run           — shell command, runtime-dispatched (workspace / nimbus / sandbox / laptop)
 *   skills        — Claude-Code/Hermes-compatible SKILL.md store, one tool / multiple actions
 *   think         — unified exploration dispatcher (single-shot / mcts / heads);
 *                   subsumes the old bare `explore` (MCTS) + `split_heads` (heads) tools
 *   memory        — long-term prose notes: save / search (hybrid FTS5 + Vectorize)
 *   fact          — typed keyed world model: remember / recall / forget (agent_facts)
 *
 * This file is a THIN ADAPTER: tool factory, system prompt, and crafted-tool
 * injection all live in @proteus/core so the CLI surface shares them verbatim.
 */

import { callable } from "agents";
import { Think, Session } from "@cloudflare/think";
// preamble-injection pattern: we construct the codemode tool
// directly via createCodeTool + PreambleCraftedExecutor. The executor reads
// craftStore.list() on every call and splices a `const tools = {...}`
// preamble into the LLM's sandbox arrow, so mid-turn additions are visible
// on the next execute_tools call and tool bodies share lexical scope with
// workspace.*/codemode.* (see docs/CRAFT-ARCHITECTURE.md).
import { streamText, generateObject, generateText, tool, jsonSchema, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import * as v from "valibot";
import type { SerializableToolDescriptor } from "./user/mcp.js";
import type { TimelineSpan } from "./lib/protocol.js";
import { runEventToSpan, classifyEvolutionType, safeJsonParse } from "./lib/timeline.js";
import { diffLines, computeWorkspaceDiff, type DiffLine, type FileDiff } from "./lib/diff.js";
import { aiSchema } from "./ai-schema.js";
import type {
  TurnContext, TurnConfig, ChatResponseResult,
  ToolCallResultContext, StepContext, ChunkContext, StreamableResult,
} from "@cloudflare/think";
import {
  EvolutionEngine,
  bootstrapScaffold,
  initAllTables, initSearchTables, initScaffoldTables, initCraftScoreTables,
  resolveMaxSteps,
  // canonical tool + prompt surface — single source of truth
  buildBuiltinTools,
  buildSystemPromptSync,
  FALLBACK_PURPOSE,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_DESCRIPTIONS,
  ACTIVE_TOOLS,
  updateCraftScores,
  feedbackToQuality,
  migrateCraftedToolDuplicates,
  // Fork feature
  forkAgentStorage, readForkLineage,
  nanoid,
  // Branching heads
  HeadController, HeadJournal, initHeadsTables,
  type SerializedMessage, type SplitPhaseEvent,
  // Canonical memory-note write primitive
  appendMemoryNote,
  // Scaffold loop closure (scaffold-driven inference + shadow rollout)
  runScaffold, scaffoldEventsToUIStream, type ScaffoldRunResult,
  initShadowTables, getPendingScaffold, decidePromotion, applyPromotionDecision,
  readScaffoldVersion, readShadowVerdict, type ShadowVerdict, DEFAULT_SHADOW_CONFIG,
  // Auto-judge shadow eval — sampled per-turn shadow rollout closure
  runAutoShadowEval, JudgeOutputSchema, DEFAULT_AUTO_JUDGE_CONFIG,
  type StructuredJudgeFn, type JudgeOutput,
  // Durable run-event log
  initRunEventTables, RunEventRecorder,
  type RunEvent, type RunEventQuery,
  // agent_facts world model
  initFactsTable, createFactsStore, renderFactsBlock, type FactsStore,
  // Typed agent_config store
  createAgentConfigStore,
  // Voyager curriculum + Absolute Zero learnability proposer
  initCurriculumTable, proposeNextTasks, listProposedTasks, updateProposedTaskStatus,
  // Hybrid search (FTS5 + Vectorize via RRF)
  hybridSearch, type HybridHit,
  // SKILL.md export/import (git-friendly crafted-tool format)
  exportAllSkillsToVfs, importSkillsFromVfs,
  type ExportSkillsResult, type ImportSkillsResult,
  type CompletedTurn, type ToolCallRecord, type AgentRuntime,
  type SessionWriter, type SessionMessage, type SqlExecutor,
  // Adaptive reasoning_effort per stage
  effortFor,
  // Unified strategy dispatch
  createStrategyRegistry, createSingleShotStrategy, createMCTSStrategy,
  createHeadsStrategy, createThinkTool,
  // EventsHub primitives (spec §1)
  EventLog, TriggerRegistry, ReactorBudget, ReplyChannelStore,
  initEventsHubTables,
  type AlarmScheduler, type ReplyDispatcher, type ReplyChannelRow,
  type RevisitCondition,
  // Skills (Claude-Code / Hermes SKILL.md spec, VFS-backed)
  discoverSkills, resolveActiveSkills, extractExplicitInvocations,
  unionAllowedTools, toolAllowedBySkills, BUILTIN_SKILLS,
  type ActiveSkillSet, type SkillsVfs,
  // GEPA offline optimisation (scaffold + crafted-tool)
  runScaffoldGepa, runCraftedToolGepa,
  initGepaTables, startGepaRun, finishGepaRun, makePersistingHook, listGepaRuns,
  loadGepaCandidates,
  type EvalInstance, type MetricOutcome, type GepaRunSummary,
} from "@proteus/core";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createCFRuntime, type CFRuntime } from "./runtime.js";
import { PreambleCraftedExecutor } from "./crafted-tool-registry.js";
import { createCFHeadRuntime } from "./heads/head-runtime.js";
import { createAgentProviderRegistry, type AgentProviderRegistry } from "./providers/agent-registry.js";
import { createRLMProvider } from "./rlm.js";
import type { UserDO } from "./user/user-do.js";

const SESSION_REFLECTION_INTERVAL = 5; // turns between session reflections

/** Extract plain text from the last user message in a ModelMessage[]. Used
 *  by skills resolution to look for `/skill-name` invocations and keyword
 *  matches without needing to know the AI SDK content-part union shape. */
function extractLastUserText(messages: ReadonlyArray<ModelMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text ?? '') : ''))
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }
  return '';
}

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
function buildSqlFromPayload(payload: ForkPayload): SqlExecutor {
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
  // SqlExecutor uses a generic-bound tagged-template signature; the shim
  // is single-return-type. Cast to SqlExecutor (not `never`) so callers
  // get proper template-tag typing without unsafe widening.
  return rawSql as unknown as SqlExecutor;
}

export class OrchestratorAgent extends Think<Env> {
  override maxSteps = resolveMaxSteps();

  private _rt: CFRuntime | null = null;
  private _engine: EvolutionEngine | null = null;
  private _turnToolCalls: ToolCallRecord[] = [];
  private _turnStepCount = 0;
  private _turnStartedAt = 0;
  // Per-turn token accumulator (summed across steps in onStepFinish), emitted
  // on turn_end so the Supervise budget view can show real spend per run.
  private _turnUsage = { input: 0, output: 0 };
  private _turnHadError = false;
  private _sessionTurnCount = 0;
  private _sessionTurns: CompletedTurn[] = [];
  private _sessionStartedAt = Date.now();

  // ── Tool cache: avoid rebuilding the built-in ToolSet + codemode types every turn ──
  private _cachedTools: ToolSet | null = null;
  private _cachedToolsKey: string = "";

  // ── User MCP tools cache ─────────────────────────────────────────────
  // Per-user MCP tools live in UserDO. Per turn we ask UserDO for the
  // current tool descriptors (cheap RPC) and cache them against UserDO's
  // monotonic mcp_updated_at watermark so we only rebuild closures when
  // the user has actually added/removed/edited a server.
  private _cachedMcpTools: ToolSet = {};
  private _cachedMcpToolsKey: number = -1;

  // Preamble-injection: the codemode tool is built once per DO lifetime.
  // Its executor (PreambleCraftedExecutor) reads craftStore.list() on every
  // execute call, so newly-saved tools appear on the next execute_tools
  // invocation without any registry or cache coherence work.
  private _craftExecTool: unknown = null;

  // Branching-heads controller — lazily built once per DO lifetime. Wraps a
  // HeadJournal + HeadRuntime (Facet spawner + merge LLM). The `think` tool's
  // heads strategy drives it, injecting inheritedContext + an onPhase event
  // sink via defaultOptions().
  private _headController: HeadController | null = null;

  // Durable run-event recorder (Flue-style discriminated union, SSE-resumable).
  // Backed by `agent_log` rows of kind in {step, tool_call, tool_result,
  // reactor_decision}. The RunEventRecorder shim adapts the existing emit()
  // API to the unified log so the SSE stream and the events sidebar share
  // one source of truth.
  private _eventRecorder: RunEventRecorder | null = null;
  private get eventRecorder(): RunEventRecorder {
    if (!this._eventRecorder) {
      this._eventRecorder = new RunEventRecorder(this.boundSql);
    }
    return this._eventRecorder;
  }

  // ── EventsHub: per-agent ingress + persistence + dispatch. ──────────────
  // Six load-bearing primitives (spec §1):
  //   - `agent_log`     unified append-only ledger (initEventsHubTables)
  //   - EventLog        publish/pending/defer/dismiss/query
  //   - TriggerRegistry durable subscriptions (webhooks, timers, watches)
  //   - ReactorBudget   per-turn/-trace/-hour caps on reactor invocations
  //   - ReplyChannelStore  durable reply-channel rows + dispatchers
  //   - TurnRunner      phase machine; built but currently unused (chat
  //                     flows through Think; webhook/timer/etc. publish
  //                     events that wake the agent via Think's chat
  //                     injection mechanism)
  // Spec: docs/EVENTS-HUB-SPEC.md
  private _eventLog: import('@proteus/core').EventLog | null = null;
  private _triggerRegistry: import('@proteus/core').TriggerRegistry | null = null;
  private _reactorBudget: import('@proteus/core').ReactorBudget | null = null;
  private _replyChannels: import('@proteus/core').ReplyChannelStore | null = null;

  protected get eventLog(): EventLog {
    if (!this._eventLog) {
      this._eventLog = new EventLog(this.ctx.storage.sql);
    }
    return this._eventLog;
  }
  protected get triggerRegistry(): TriggerRegistry {
    if (!this._triggerRegistry) {
      const orchestrator = this;
      const alarmScheduler: AlarmScheduler = {
        scheduleAt(ts: number) {
          // Idempotent: pick the soonest of (existing alarm, new ts).
          void Promise.resolve(orchestrator.ctx.storage.getAlarm()).then((c) => {
            if (c === null || ts < c) {
              orchestrator.ctx.storage.setAlarm(ts);
            }
          }).catch(() => orchestrator.ctx.storage.setAlarm(ts));
        },
        currentAlarm(): number | null { return null; },
      };
      this._triggerRegistry = new TriggerRegistry(this.ctx.storage.sql, alarmScheduler);
    }
    return this._triggerRegistry;
  }
  protected get reactorBudget(): ReactorBudget {
    if (!this._reactorBudget) {
      this._reactorBudget = new ReactorBudget(this.ctx.storage.sql);
    }
    return this._reactorBudget;
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
      this._replyChannels = new ReplyChannelStore(this.ctx.storage.sql, {
        ws_session: wsDispatcher,
      });
    }
    return this._replyChannels;
  }

  // agent_facts world model — typed, idempotent, keyed.
  private _factsStore: FactsStore | null = null;
  private get facts(): FactsStore {
    if (!this._factsStore) this._factsStore = createFactsStore(this.boundSql);
    return this._factsStore;
  }

  // Typed accessors over the `agent_config` key/value table — replaces
  // scattered raw SQL with a single deep module.
  private _config: import('@proteus/core').AgentConfigStore | null = null;
  private get config(): import('@proteus/core').AgentConfigStore {
    if (!this._config) this._config = createAgentConfigStore(this.boundSql);
    return this._config;
  }

  // StrategyRegistry — single-shot + MCTS + Heads adapters. Powers the
  // unified `think(strategy, task, budget)` tool.
  private _strategyRegistry: import('@proteus/core').StrategyRegistry | null = null;
  private get strategyRegistry(): import('@proteus/core').StrategyRegistry {
    if (this._strategyRegistry) return this._strategyRegistry;
    const reg = createStrategyRegistry();
    reg.register(createSingleShotStrategy());
    reg.register(createMCTSStrategy());
    reg.register(createHeadsStrategy());
    this._strategyRegistry = reg;
    return reg;
  }

  private _thinkTool: ToolSet[string] | null = null;
  private getThinkTool(): ToolSet[string] {
    if (this._thinkTool) return this._thinkTool;
    this._thinkTool = createThinkTool({
      registry: this.strategyRegistry,
      rt: this.rt,
      model: this.getModel(),
      // Host-injected infrastructure the LLM must not set. Recomputed per
      // think() call: MCTS gets a fresh SessionWriter; heads get the shared
      // controller, the live conversation as inheritedContext, and an onPhase
      // sink that streams head_split / head_merge into the durable event log.
      defaultOptions: () => ({
        mcts: { session: this.createMCTSSession() },
        heads: {
          controller: this.getHeadController(),
          inheritedContext: this.readInheritedContext(),
          onPhase: (event: SplitPhaseEvent) => this.emitHeadPhase(event),
        },
      }),
    });
    return this._thinkTool;
  }

  /** Convenience: current runId for event emission. One run per turn. */
  private _currentRunId = '';

  // ── Skills (turn-scoped) ───────────────────────────────────────
  /** Skill names invoked this turn (via /name or skills({action:'invoke'})).
   *  Cleared at beforeTurn; closures from the skills tool mutate via .add(). */
  private readonly _turnInvokedSkills = new Set<string>();
  /** Resolved active set for the current turn. Built in beforeTurn, read by
   *  the system-prompt assembly via TurnConfig.system override. */
  private _turnActiveSkills: ActiveSkillSet | null = null;
  /** Lazy SkillsVfs shim around rt.storage.vfs — built once, reused. */
  private _skillsVfs: SkillsVfs | null = null;
  private getSkillsVfs(): SkillsVfs {
    if (this._skillsVfs) return this._skillsVfs;
    const vfs = this.rt.storage.vfs;
    this._skillsVfs = {
      exists: (p) => vfs.exists(p),
      readFile: (p, opts) => vfs.readFile(p, opts),
      writeFile: (p, data) => vfs.writeFile(p, data),
      readdir: (p) => vfs.readdir(p),
      unlink: (p) => vfs.unlink(p),
      mkdir: (p, opts) => vfs.mkdir(p, opts),
    };
    return this._skillsVfs;
  }

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

  private get rt(): CFRuntime {
    if (!this._rt) {
      // No onToolRegistered hook: PreambleCraftedExecutor reads craftStore.list()
      // fresh on every execute_tools call, so mid-turn saves propagate
      // without any registry plumbing (see docs/CRAFT-ARCHITECTURE.md §3).
      // `this` (a subclass) DOES have access to its protected env/ctx; cast to
      // the AgentHost view createCFRuntime needs.
      this._rt = createCFRuntime(this as unknown as Parameters<typeof createCFRuntime>[0]);
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
      // Recursive Language Models — `llm.query(text, opts?)` in the sandbox.
      // Sub-call has no llm.query in scope, so depth is bounded at 1.
      const rlmProvider = createRLMProvider(
        this.providerRegistry(),
        () => this.providerRegistry().normalizeSpecSync(this.getStoredModelId()),
      );
      const allProviders = [craftedProvider, rlmProvider, ...executorProviders.map(p => ({
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

  private _providerRegistry: AgentProviderRegistry | null = null;
  protected providerRegistry(): AgentProviderRegistry {
    if (this._providerRegistry) return this._providerRegistry;
    const userId = this.getOwnerUserId();
    if (!userId) {
      throw new Error('Agent has no owner_user_id yet — Worker must call claimOwner before any model use.');
    }
    const userDOStub = this.env.UserDO.get(this.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
    this._providerRegistry = createAgentProviderRegistry({
      env: this.env,
      userDOStub,
      appTitle: 'Proteus',
    });
    return this._providerRegistry;
  }

  /** Read the owner userId from agent_soul; '' (empty) means unclaimed. */
  protected getOwnerUserId(): string | null {
    try {
      const rows = this.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM agent_soul LIMIT 1`;
      const v = rows[0]?.owner_user_id;
      return v && v !== '' ? v : null;
    } catch { return null; }
  }

  /** Worker calls this on every authenticated request before any other RPC.
   *  Claims the agent for `userId` if unclaimed; 403s on cross-user collision.
   *
   *  Defensive: claimOwner can fire BEFORE onStart() completes on a fresh DO
   *  activation (the agents SDK doesn't strictly guarantee onStart→RPC order).
   *  We initialize all required tables here so the SELECT/UPDATE never hits
   *  a missing table or missing column. initAllTables is idempotent and the
   *  agent_soul ALTER inside it is the migration that adds owner_user_id to
   *  pre-v3 DOs.
   */
  @callable()
  async claimOwner(userId: string): Promise<{ owner: string }> {
    if (!userId) throw new Error('userId required');
    try {
      const execRaw = (q: string) => { this.ctx.storage.sql.exec(q); };
      initAllTables(execRaw);
    } catch (err) {
      console.error('[orchestrator] claimOwner initAllTables failed:', (err as Error).message);
    }
    const current = this.getOwnerUserId();
    if (current === null) {
      // Unclaimed — first touch. Ensure agent_soul has at least one row.
      const exists = this.sql<{ x: number }>`SELECT 1 AS x FROM agent_soul LIMIT 1`;
      if (exists.length === 0) {
        this.sql`INSERT INTO agent_soul (purpose, owner_user_id) VALUES (${FALLBACK_PURPOSE}, ${userId})`;
      } else {
        this.sql`UPDATE agent_soul SET owner_user_id = ${userId}`;
      }
      this.invalidateModelCaches();
      return { owner: userId };
    }
    if (current !== userId) {
      throw new Error(`Agent owned by a different user (stored=${current.slice(0, 8)}…, caller=${userId.slice(0, 8)}…)`);
    }
    return { owner: current };
  }

  /** Stored model spec, or null when unset (registry will pick the default). */
  private getStoredModelId(): string | null {
    return this.config.getModel();
  }

  // ── Think lifecycle overrides ──────────────────────────────────

  /** Think calls `getModel()` synchronously per turn — cache to avoid
   *  reconstructing on every turn when the stored spec hasn't changed. */
  private _cachedModel: LanguageModel | null = null;
  private _cachedModelSpec: string | null = null;
  getModel(): LanguageModel {
    this.logActivity("getmodel");
    const stored = this.getStoredModelId();
    if (this._cachedModel && this._cachedModelSpec === stored) return this._cachedModel;
    const reg = this.providerRegistry();
    const model = reg.resolveModel(reg.normalizeSpecSync(stored));
    this._cachedModel = model; this._cachedModelSpec = stored;
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
  /** Cached soul.purpose. Loaded lazily on first read, invalidated by
   *  setSoul(). Avoids a SQL round-trip on every getSystemPrompt() call. */
  private _cachedSoulPurpose: string | null = null;
  private getSoulPurpose(): string {
    if (this._cachedSoulPurpose === null) {
      try {
        const rows = this.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
        this._cachedSoulPurpose = rows[0]?.purpose ?? '';
      } catch { this._cachedSoulPurpose = ''; }
    }
    return this._cachedSoulPurpose;
  }

  getSystemPrompt(): string {
    this.logActivity("getsystemprompt_start");
    const execs = (this.rt.executionRouter?.listExecutors() ?? []).map(e => e.name);
    const key = `${this.getSoulPurpose()}\u0000${execs.join(",")}`;
    let base: string;
    if (this._cachedSystemPrompt && this._cachedSystemPromptKey === key) {
      base = this._cachedSystemPrompt;
      this.logActivity("getsystemprompt_end", "cache hit");
    } else {
      // Always build the BASE prompt here — no turn-scoped skills section.
      // Active skills are layered on by `beforeTurn` via TurnConfig.system,
      // which is the authoritative path. Mixing them in here would poison
      // the cache (Think calls getSystemPrompt() BEFORE beforeTurn(); a
      // stale `_turnActiveSkills` from the prior turn would otherwise leak
      // into _cachedSystemPrompt and be re-served on every later turn).
      base = buildSystemPromptSync(this.rt, { registeredExecutors: execs });
      this._cachedSystemPrompt = base;
      this._cachedSystemPromptKey = key;
      this.logActivity("getsystemprompt_end", `${base.length} chars`);
    }
    // Render top-K recent facts on every turn (cheap; bypasses cache because
    // facts change between turns). Empty → return unmodified base prompt.
    try {
      const factsBlock = renderFactsBlock(this.facts.recentTopK(20), { maxChars: 2000 });
      if (factsBlock) return `${base}\n\n## World model (facts you remembered):\n${factsBlock}`;
    } catch { /* facts table not yet initialized */ }
    return base;
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
    // because effective-score filtering depends on recency.
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

      const shellApprovalMode = this.config.getShellApprovalMode();

      const tools = buildBuiltinTools({
        rt: this.rt,
        preBuiltExecuteTool: this.getExecuteToolsTool(),
        // Unified strategy dispatcher (single-shot / mcts / heads). Internally
        // owns the HeadController + MCTS session — the bare `explore` /
        // `split_heads` tools were folded into this single entry point.
        thinkTool: this.getThinkTool(),
        // Vectorize-backed semantic memory. memory.search auto-uses
        // hybrid retrieval when this is provided + available; FTS5-only fallback.
        vectorStore: this.rt.vectorStore,
        // Per-agent approval policy for shell exec.
        shellApprovalMode,
        // Typed, keyed world-model store — exposes the `fact` tool.
        facts: this.facts,
        // Single `skills` tool — list/read/invoke/create/edit/delete actions.
        // Per-turn invocation state lives on the orchestrator; closures here
        // mutate / read it without ever recreating the Set, so the binding
        // stays stable across the cached toolset.
        skills: {
          vfs: orchestrator.getSkillsVfs(),
          recordInvoke: (name: string) => { orchestrator._turnInvokedSkills.add(name); },
          currentlyInvoked: () => Array.from(orchestrator._turnInvokedSkills),
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
   * Lazily build the HeadController that spawns ExplorationAgent Facets in
   * head mode (initHead / runAsHead / abortHead). Driven by the `think` tool's
   * heads strategy; inheritedContext + the onPhase event sink are injected
   * per call via readInheritedContext() / emitHeadPhase().
   */
  private getHeadController(): HeadController {
    if (this._headController) return this._headController;
    const sqlForJournal = this.sql.bind(this) as unknown as SqlExecutor;
    const journal = new HeadJournal(sqlForJournal);
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) throw new Error('Agent has no owner — branching heads need UserDO access for auth.');
    const runtime = createCFHeadRuntime(this as unknown as Parameters<typeof createCFHeadRuntime>[0], ownerUserId);
    this._headController = new HeadController(runtime, journal);
    return this._headController;
  }

  /**
   * The parent's recent conversation, handed to each spawned head so it sees
   * the full context. Capped to the last N messages to bound head LLM context
   * over long sessions (Think Session already compacts the table at the
   * orchestrator level; this is a second safety net for head spawns).
   */
  private readInheritedContext(): SerializedMessage[] {
    const INHERITED_CONTEXT_CAP = 50;
    try {
      type Row = { id: string; role: string; content: string; created_at: string };
      const rows = this.sql<Row>`
        SELECT id, role, content, created_at
        FROM (
          SELECT id, role, content, created_at
          FROM assistant_messages
          ORDER BY created_at DESC
          LIMIT ${INHERITED_CONTEXT_CAP}
        ) sub
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
  }

  /** Stream head_split / head_merge into the durable event log so SSE
   *  subscribers + MCP `list_run_events` see the split lifecycle. */
  private emitHeadPhase(event: SplitPhaseEvent): void {
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
      console.warn('[proteus] event emit failed at head onPhase:', err);
    }
  }

  /**
   * Fetch the user's MCP tool descriptors and reconstruct AI-SDK Tool
   * adapters whose `execute` closures dispatch back to UserDO via RPC.
   *
   * Cache invalidation:
   *   - UserDO holds a monotonic `mcp_updated_at` watermark, bumped on
   *     add/remove/edit + on OAuth-callback completion.
   *   - We cache descriptors + closures by that integer; rebuild only when
   *     it changes. Result is stable across turns until the user actually
   *     reconfigures something.
   *
   * Closure boundary: the descriptor that crosses RPC carries only the JSON
   * Schema + name + serverId; we re-construct the AI-SDK `Tool` here so the
   * `execute` arrow can capture `userDOStub`, `serverId`, and `name` lexically.
   */
  private async buildUserMcpTools(): Promise<ToolSet> {
    const userId = this.getOwnerUserId();
    if (!userId) return {};
    const userDOStub = this.env.UserDO.get(this.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;

    let watermark: number;
    try { watermark = await userDOStub.userMcp_updatedAt(); }
    catch (err) {
      console.warn('[proteus] mcp watermark fetch failed:', (err as Error).message);
      return this._cachedMcpTools;
    }
    if (watermark === this._cachedMcpToolsKey && Object.keys(this._cachedMcpTools).length > 0) {
      return this._cachedMcpTools;
    }
    // Watermark = 0 means UserDO has never seen an MCP mutation. Skip the
    // descriptor fetch entirely so cold UserDOs don't pay for MCP plumbing.
    if (watermark === 0) {
      this._cachedMcpTools = {};
      this._cachedMcpToolsKey = 0;
      return this._cachedMcpTools;
    }

    let descriptors: SerializableToolDescriptor[];
    try { descriptors = await userDOStub.userMcp_toolDescriptors(); }
    catch (err) {
      console.warn('[proteus] mcp descriptor fetch failed:', (err as Error).message);
      return this._cachedMcpTools;
    }

    const tools: ToolSet = {};
    for (const d of descriptors) {
      const serverId = d.serverId;
      const mcpName = d.name;
      tools[d.toolKey] = tool({
        description: d.description ?? `${d.serverName}/${mcpName}`,
        inputSchema: jsonSchema<Record<string, unknown>>(
          (d.inputSchema ?? { type: 'object' }) as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args: unknown) => {
          try { return await userDOStub.userMcp_callTool(serverId, mcpName, args); }
          catch (err) { return { isError: true, error: (err as Error).message }; }
        },
      });
    }

    this._cachedMcpTools = tools;
    this._cachedMcpToolsKey = watermark;
    this.logActivity('mcp_tools_rebuilt', `${Object.keys(tools).length} tools @ wm=${watermark}`);
    return tools;
  }

  configureSession(session: Session): Session {
    // Context blocks the LLM can read AND write via the Think Session tools
    // (`set_context`, `load_context`, `search_context` — see tools/registry.ts
    // ACTIVE_TOOLS whitelist). Block sizes total ~60k tokens; the chat window
    // compacts at 96k to leave headroom for the streaming response.
    return session
      .withContext("memory", {
        description:
          "Long-term knowledge: learned facts, project context, discovered " +
          "patterns, crafted tool descriptions. Loaded from MEMORY.md.",
        maxTokens: 32000,
      })
      .withContext("scratch", {
        description:
          "Ephemeral scratchpad for the current turn — write intermediate " +
          "reasoning, partial results, hypothesis lists. Cleared between turns. " +
          "Use `set_context('scratch', text)` to write.",
        maxTokens: 8000,
      })
      .withContext("working_set", {
        description:
          "Last-N items the agent is actively working on (files, tasks, URLs). " +
          "Persists across turns until manually replaced. " +
          "Use `set_context('working_set', text)` to update.",
        maxTokens: 4000,
      })
      .withCachedPrompt()
      .compactAfter(96_000);
  }

  // ── Think lifecycle hooks ──────────────────────────────────────

  // Tools the model is allowed to call. Think merges workspace tools (read, write,
  // edit, list, find, grep, delete) with ours, bloating the request by ~2800 tokens.
  // activeTools restricts the model to the built-in tools + session context tools,
  // preventing Think's workspace tools from being sent in the request payload.
  // ACTIVE_TOOLS is sourced from @proteus/core/tools/registry (single truth).
  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    this._turnToolCalls = [];
    this._turnStepCount = 0;
    this._turnStartedAt = Date.now();
    this._turnUsage = { input: 0, output: 0 };
    this._turnHadError = false;
    this._firstChunkReceived = false;
    this._inFlight = true;
    this.logActivity("beforeturn", "streamText() called next");
    // Start a new run for the event log, with provenance so cross-run history
    // (Supervise altitude) can show what kicked each run off. This is the chat
    // path → caused_by:'chat'; event-triggered runs set ingress_kind/trigger_id.
    this._currentRunId = `run-${nanoid()}`;
    try {
      this.eventRecorder.emit(this._currentRunId, {
        type: 'run_start',
        agentId: this.name,
        caused_by: 'chat',
        userMessage: extractLastUserText(ctx.messages)?.slice(0, 500),
      });
      this.eventRecorder.emit(this._currentRunId, {
        type: 'turn_start',
        turnIndex: this._sessionTurnCount,
      });
    } catch (err) {
      console.warn('[proteus] event emit failed at beforeTurn:', err);
    }

    // ── Skills resolution for this turn ──────────────────────────
    // Reset per-turn invocation set (don't reassign — closures from the
    // skills tool hold a stable reference).
    this._turnInvokedSkills.clear();
    this._turnActiveSkills = null;
    const activeTools: string[] = [...ACTIVE_TOOLS];
    let systemOverride: string | undefined;
    try {
      const lastUserText = extractLastUserText(ctx.messages);
      const explicit = extractExplicitInvocations(lastUserText);
      const alwaysActive = this.config.getAlwaysActiveSkills();

      // Only do the (async) VFS scan when there's a real chance a skill
      // activates — explicit invocation, always_active config, OR any
      // built-in that auto_activates on keywords. Avoids a per-turn
      // filesystem walk for vanilla turns.
      const anyAutoActivate = BUILTIN_SKILLS.some(s => s.auto_activate);
      const mightActivate = explicit.length > 0 || alwaysActive.length > 0 || anyAutoActivate;

      if (mightActivate) {
        const available = await discoverSkills(this.getSkillsVfs());
        const activeSet = resolveActiveSkills({
          available, explicit, userMessage: lastUserText, alwaysActive,
        });
        if (activeSet.active.length > 0) {
          this._turnActiveSkills = activeSet;
          // Mirror the resolved explicit set onto the turn-invoked tracker so
          // skills.list reflects what's active right now.
          for (const r of activeSet.reasons) this._turnInvokedSkills.add(r.name);

          // Override the assembled system prompt with one that includes the
          // active-skills section. Reuse the SAME execs list Think already
          // assembled into ctx.system isn't safe (it's the assembled string,
          // not raw inputs), so we re-render the prompt with the same
          // registered-executors source we use in getSystemPrompt.
          const execs = (this.rt.executionRouter?.listExecutors() ?? []).map(e => e.name);
          systemOverride = buildSystemPromptSync(this.rt, {
            registeredExecutors: execs,
            activeSkills: activeSet,
          });
          // Append the same recent-facts block getSystemPrompt does.
          try {
            const factsBlock = renderFactsBlock(this.facts.recentTopK(20), { maxChars: 2000 });
            if (factsBlock) {
              systemOverride = `${systemOverride}\n\n## World model (facts you remembered):\n${factsBlock}`;
            }
          } catch { /* facts table not yet initialized */ }

          // Intersect activeTools with the union of allowed_tools across the
          // active skills. Empty union (skills don't restrict) = leave the
          // base set untouched. Glob-suffix matching is owned by
          // `toolAllowedBySkills` — orchestrator + render share the same impl.
          const allowedUnion = unionAllowedTools(activeSet.active);
          if (allowedUnion.length > 0) {
            const filtered = activeTools.filter(t => toolAllowedBySkills(t, allowedUnion));
            // Always keep the skills tool itself reachable so the LLM can
            // list / read / invoke more skills mid-turn. Filtering it out
            // would lock the agent into the first activation.
            if (!filtered.includes('skills')) filtered.push('skills');
            activeTools.length = 0;
            activeTools.push(...filtered);
          }
          this.logActivity('skills_active',
            activeSet.active.map(s => s.name).join(',') || '(none)');
        }
      }
    } catch (err) {
      console.warn('[proteus] skills resolution failed:', (err as Error).message);
      // Don't fail the turn — vanilla path is fine.
    }

    // Per-user MCP tools — fetched from UserDO, dispatched back via RPC.
    // Failure is non-fatal; the turn proceeds with builtins only and the UI
    // surfaces the broken-server status via /api/user/mcp/servers polling.
    let mcpTools: ToolSet = {};
    try { mcpTools = await this.buildUserMcpTools(); }
    catch (err) { console.warn('[proteus] buildUserMcpTools failed:', (err as Error).message); }

    // Expose MCP tool keys to the active-tools allowlist so Think doesn't
    // strip them out. Builtin names + MCP `tool_<id>_<name>` keys are
    // disjoint by construction (assertion above).
    const mcpToolNames = Object.keys(mcpTools);
    const effectiveActiveTools = mcpToolNames.length > 0
      ? [...activeTools, ...mcpToolNames]
      : activeTools;
    const effectiveTools = mcpToolNames.length > 0 ? mcpTools : undefined;

    const cfg: TurnConfig = { activeTools: effectiveActiveTools };
    if (systemOverride) cfg.system = systemOverride;
    if (effectiveTools) cfg.tools = effectiveTools;
    return cfg;
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
    // Persist tool_call_end into the durable run-event log.
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
    this._turnUsage.input += inTok;
    this._turnUsage.output += outTok;
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
    // Mirror into the durable run-event log so external SSE subscribers
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
    // Emit turn_end + run_end into the durable event log.
    try {
      if (this._currentRunId) {
        this.eventRecorder.emit(this._currentRunId, {
          type: 'turn_end',
          turnIndex: this._sessionTurnCount,
          tokenUsage: { input: this._turnUsage.input, output: this._turnUsage.output },
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

    // Record which crafted tools this turn used, keyed by the assistant
    // message id, so async thumbs feedback (setTurnFeedback) can re-score
    // exactly those tools. Feedback is inherently asynchronous — it arrives
    // after the turn completes — so turn.feedback stays null here and the
    // heuristic in assessTurnQuality scores the turn at completion time.
    const msgId = (result.message as { id?: string } | null | undefined)?.id;
    if (msgId) {
      const craftNames = this._turnToolCalls
        .map(tc => tc.name)
        .filter(name => !BUILTIN_TOOL_NAMES.has(name));
      if (craftNames.length > 0) {
        this.sql`INSERT INTO turn_craft_usage (message_id, tool_names, created_at)
                 VALUES (${msgId}, ${JSON.stringify(craftNames)}, ${Date.now()})
                 ON CONFLICT(message_id) DO UPDATE SET
                   tool_names = excluded.tool_names, created_at = excluded.created_at`;
      }
    }

    const turn: CompletedTurn = {
      userMessage: userText,
      assistantResponse: assistantText,
      toolCalls: this._turnToolCalls,
      steps: this._turnStepCount,
      durationMs: this._turnStartedAt > 0 ? Date.now() - this._turnStartedAt : 0,
      feedback: null,
      // status is "completed" here (the !== "completed" early-return above),
      // so turn errors are tracked via the per-step _turnHadError flag.
      hadError: this._turnHadError,
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

    // Auto-judge shadow evaluation. When a pending scaffold exists,
    // sample-and-run (default 25%) the pending against this turn's task,
    // ask a judge LLM to compare, record. When minTrials is reached AND
    // agent_config.auto_promote_scaffold='true', auto-apply the decision.
    void this.runShadowEvalSampled(userText, assistantText);

    // Sleep-time compute — between-turn background memory compression.
    // Reads recent turn, asks judge to upsert/decay facts + compress scratch
    // block. Letta-style; ~50% test-time token reduction reported. Gated
    // by agent_config.sleep_time_compute='true' (default off).
    void this.runSleepTimeCompute(userText, assistantText, this._turnToolCalls);
  }

  /** Background memory compression. Reads recent turn, updates agent_facts +
   *  scratch block. Fire-and-forget; does not block TurnQueue. */
  private async runSleepTimeCompute(
    task: string, output: string, toolCalls: ToolCallRecord[],
  ): Promise<void> {
    try {
      if (!this.config.getSleepTimeComputeEnabled()) return;
      const { runSleepTimeCompute, applySleepTimeUpdate } = await import('@proteus/core');
      const currentFacts = this.facts.recentTopK(30).map(f => ({
        key: f.key, value: f.value, confidence: f.confidence,
      }));
      const update = await runSleepTimeCompute(this.rt.llm, {
        task: task.slice(0, 2000),
        output: output.slice(0, 4000),
        toolCalls: toolCalls.map(tc => tc.name),
        currentFacts,
      });
      if (!update) return;
      const summary = applySleepTimeUpdate(this.facts, update);
      console.log(
        `[proteus] sleep-time-compute: upserted=${summary.upserted} decayed=${summary.decayed} blocks=${summary.blocksWritten}`,
      );
    } catch (err) {
      console.warn('[proteus] sleep-time-compute failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Sampled per-turn auto-judge shadow rollout. Fire-and-forget — never
   * extends the TurnQueue. Reads sampling/auto-promote from agent_config
   * so the user can toggle without redeploys.
   */
  private async runShadowEvalSampled(task: string, currentOutput: string): Promise<void> {
    try {
      const sampleRate = this.config.getShadowSampleRate();
      const autoApply = this.config.getAutoPromoteScaffold();
      if (sampleRate <= 0) return;

      const judge: StructuredJudgeFn = async (prompt) => {
        const { object } = await generateObject({
          model: this.getModelForReview(),
          schema: aiSchema<JudgeOutput>(JudgeOutputSchema),
          prompt,
          maxOutputTokens: 512,
          ...effortFor('judge'),
        });
        return object;
      };

      const judgeTask = task.slice(0, 2000);
      const result = await runAutoShadowEval({
        rt: this.rt,
        task: judgeTask,
        currentOutput: currentOutput.slice(0, 4000),
        judge,
        llmStream: this.makeScaffoldLLMStream(),
        // Pass the same tool dispatcher the production chat path uses, so the
        // pending scaffold runs with the real tool surface — not the stubbed
        // disabled-tools path that used to penalise any tool-using pending.
        callTool: this.makeScaffoldCallTool(),
        // host.defaultInference for the pending: run the standard inference for
        // the shadow task so a pending that delegates to the default loop is
        // judged fairly (its output ≈ current's, → tie, → not promoted).
        defaultInference: () => streamText({
          model: this.getModel(),
          messages: [{ role: 'user', content: judgeTask }],
          tools: this.getTools(),
          stopWhen: stepCountIs(50),
          ...effortFor('scaffold_mutation'),
        }).toUIMessageStream(),
        config: {
          ...DEFAULT_AUTO_JUDGE_CONFIG,
          sampleRate,
          autoApply,
        },
      });

      if (!result.skipped && result.evaluation) {
        // Emit a structured note to the event log for visibility.
        try {
          if (this._currentRunId) {
            this.eventRecorder.emit(this._currentRunId, {
              type: 'memory_write',
              path: 'shadow-eval',
              bytes: result.evaluation.rationale.length,
            });
          }
        } catch { /* nop */ }
      }
      if (result.applied) {
        console.log(`[proteus] auto-judge applied: ${result.applied}`);
      }
    } catch (err) {
      console.warn('[proteus] runShadowEvalSampled failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Model for review/judge tasks. Same resolution as chat — review LLM tracks
   *  the user's chosen model so quality assessments stay consistent. */
  private getModelForReview(): import('ai').LanguageModel {
    const reg = this.providerRegistry();
    return reg.resolveModel(reg.normalizeSpecSync(this.getStoredModelId()));
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
    // EventsHub tables: agent_log + reply_channels + triggers + peer_outbox
    // + reactor_budget_log + partial indexes + views. Spec: docs/EVENTS-HUB-SPEC.md.
    initEventsHubTables(this.ctx.storage.sql);
    // Branching-heads journal (head_journal, head_evidence, head_merge_results)
    initHeadsTables(execRaw);
    // Scaffold shadow-mode tables (scaffold_evaluations + status col)
    initShadowTables(execRaw);
    // Durable run-event log (run_events table)
    initRunEventTables(execRaw);
    // agent_facts world model (keyed JSON facts w/ confidence + recency)
    initFactsTable(execRaw);
    // Voyager curriculum proposed-tasks queue (UI + autonomous loop consume).
    initCurriculumTable(execRaw);
    // GEPA offline-optimisation run + candidate history (gepa_runs, gepa_candidates,
    // gepa_pareto_membership). Populated by runScaffoldGepaOptimization.
    initGepaTables(execRaw);
    // Workspace-diff baseline (path → content snapshot) for the Output surface's
    // cumulative change-set. Captured lazily / re-markable via resetWorkspaceBaseline.
    execRaw(`CREATE TABLE IF NOT EXISTS vfs_baseline (path TEXT PRIMARY KEY, content TEXT)`);

    execRaw(`CREATE TABLE IF NOT EXISTS agent_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`);

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

  // ── DO alarm → Timer ingress ───────────────────────────────────
  //
  // The TriggerRegistry schedules alarms; this handler fires for every
  // due trigger (cron + one-shot), publishes Timer events via the hub,
  // re-arms cron, revokes one-shot, and schedules the next alarm.
  //
  // Crash-safe: dedupe via `(trigger_id, scheduled_fire_at)` means a
  // re-fire after DO eviction is a no-op publish.
  async alarm() {
    const now = Date.now();
    try {
      const due = this.triggerRegistry.due(now);
      for (const trigger of due) {
        const spec = trigger.spec as {
          label?: string; payload?: unknown; cron?: string;
        };
        const scheduled_fire_at = (trigger as typeof trigger & { next_fire_at?: number }).next_fire_at ?? now;

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
          const next = spec.cron ? this.nextCronFire(spec.cron, now) : null;
          this.triggerRegistry.markFired(trigger.id, now, next);
        } else {
          this.triggerRegistry.markFired(trigger.id, now, null);
          this.triggerRegistry.revoke(trigger.id, now);
        }
      }

      // Wake any operator-visible WS clients so they re-fetch the events
      // sidebar (non-blocking; tolerates absent broadcast surface).
      if (due.length > 0) {
        const broadcast = (this as unknown as {
          broadcastChatMessage?: (msg: unknown) => Promise<void> | void;
        }).broadcastChatMessage;
        try {
          await broadcast?.({
            role: 'system',
            parts: [{ type: 'text', text: `[hub] ${due.length} timer event(s) fired` }],
          });
        } catch { /* best-effort */ }
      }
    } catch (err) {
      console.error('[proteus] alarm handler failed:', (err as Error).message);
    }

    // Reschedule the next-soonest alarm.
    try {
      const all = this.triggerRegistry.list({ state: 'active' });
      const upcoming = all
        .map(t => (t as typeof t & { next_fire_at?: number }).next_fire_at)
        .filter((t): t is number => typeof t === 'number' && t > now)
        .sort((a, b) => a - b)[0];
      if (upcoming) this.ctx.storage.setAlarm(upcoming);
    } catch (err) {
      console.warn('[proteus] alarm reschedule failed:', (err as Error).message);
    }
  }

  /** Compute the next firing time for a cron expression after `from`.
   *  Simple implementation: supports `*\/n * * * *` (every n minutes) and
   *  `m h * * *` (daily at hh:mm UTC); enough for v1 schedules. Full cron
   *  parsing arrives with the Triggers UI. */
  private nextCronFire(cron: string, from: number): number | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [min, hour] = parts;
    const d = new Date(from);
    // every-n-minutes: `*\/n * * * *`
    if (min.startsWith('*/')) {
      const n = parseInt(min.slice(2), 10);
      if (Number.isFinite(n) && n > 0) {
        const cur = d.getUTCMinutes();
        const next = (Math.floor(cur / n) + 1) * n;
        const nd = new Date(d);
        nd.setUTCMinutes(next, 0, 0);
        if (next >= 60) { nd.setUTCMinutes(next - 60, 0, 0); nd.setUTCHours(nd.getUTCHours() + 1); }
        return nd.getTime();
      }
    }
    // daily at hh:mm
    const m = parseInt(min, 10);
    const h = parseInt(hour, 10);
    if (Number.isFinite(m) && Number.isFinite(h)) {
      const nd = new Date(d);
      nd.setUTCHours(h, m, 0, 0);
      if (nd.getTime() <= from) nd.setUTCDate(nd.getUTCDate() + 1);
      return nd.getTime();
    }
    return null;
  }

  // ── Callable RPC methods ───────────────────────────────────────

  private getDisplayName(): string {
    return this.config.getDisplayName() ?? this.name;
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
        scaffoldVersion: 0, searchNodeCount: 0, craftedToolCount: 0, messageCount: 0,
        model: this.providerRegistry().normalizeSpecSync(this.getStoredModelId()),
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
    return this.sql`SELECT id, parent_id, depth, visits, value, status, action, task, observation, code_used, created_at
      FROM search_nodes ORDER BY depth, created_at`;
  }

  @callable() async getEvolutionEvents(limit: number = 50) {
    return this.sql`SELECT id, type, message, data, created_at
      FROM evolution_events ORDER BY created_at DESC LIMIT ${limit}`;
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
    const limit = opts?.limit ?? 200;
    const recent = (() => {
      try { return this.sql<{ run_id: string }>`SELECT run_id FROM run_events ORDER BY ts DESC LIMIT 1`[0]?.run_id; }
      catch { return undefined; }
    })();
    const runId = opts?.runId || this._currentRunId || recent;
    const spans: TimelineSpan[] = [];

    // 1) Durable per-run events for the focused run (skip noisy text_delta).
    if (runId) {
      try {
        for (const e of this.eventRecorder.read(runId, { limit })) {
          if (e.type === 'text_delta') continue;
          spans.push(runEventToSpan(e));
        }
      } catch { /* run_events may not exist yet */ }
    }
    // 2) Agent-level evolution events — PRESERVE the `data` payload.
    try {
      const rows = this.sql<{ id: string; type: string; message: string; data: string | null; created_at: number }>`
        SELECT id, type, message, data, created_at FROM evolution_events ORDER BY created_at DESC LIMIT ${limit}`;
      for (const r of rows) {
        spans.push({
          ts: r.created_at, kind: classifyEvolutionType(r.type), label: r.message || r.type,
          data: r.data ? safeJsonParse(r.data) : undefined,
          source: 'evolution', refId: r.id, rawType: r.type,
        });
      }
    } catch { /* table may not exist */ }
    // 3) MCTS search nodes.
    try {
      const nodes = this.sql<{ id: string; action: string; value: number; status: string; created_at: number }>`
        SELECT id, action, value, status, created_at FROM search_nodes ORDER BY created_at DESC LIMIT ${limit}`;
      for (const n of nodes) {
        spans.push({
          ts: n.created_at, kind: 'mcts', label: n.action || `node ${n.id.slice(0, 8)}`,
          detail: `value ${Number(n.value).toFixed(2)} · ${n.status}`,
          source: 'mcts', refId: n.id,
        });
      }
    } catch { /* table may not exist */ }

    spans.sort((a, b) => a.ts - b.ts);
    return spans.slice(-limit);
  }

  // ── Fiber recovery — durable execution surviving DO eviction ──
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
    // Emit the promotion/rollback into the durable event log so SSE
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

  /**
   * The per-trial shadow-eval verdict grid that drives the promote/rollback
   * decision — the moat surface's data source. Thin wrapper over core's
   * `readShadowVerdict` (reads `scaffold_evaluations`, regressions-first;
   * NOT `task_history`/`canary_score`, which are never written).
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
    const codeOverride = (await readScaffoldVersion(this.rt, version)) ?? undefined;
    if (codeOverride === undefined) {
      throw new Error(`previewScaffoldLive: no scaffold code found for v${version}`);
    }
    return runScaffold({
      rt: this.rt, task,
      emit: () => undefined,
      llmStream: this.makeScaffoldLLMStream(),
      callTool: this.makeScaffoldCallTool(),
      scaffoldCodeOverride: codeOverride,
      timeoutMs: opts?.timeoutMs,
    });
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
  async setShellApprovalMode(mode: 'strict' | 'allow_all' | 'deny_all'): Promise<{ ok: true; mode: string }> {
    if (mode !== 'strict' && mode !== 'allow_all' && mode !== 'deny_all') {
      throw new Error(`invalid mode: ${mode}`);
    }
    this.config.setShellApprovalMode(mode);
    // Force a tool cache rebuild on next getTools().
    this._cachedTools = null;
    this._cachedToolsKey = '';
    return { ok: true, mode };
  }

  /** Current shell-approval mode (strict | allow_all | deny_all). */
  @callable()
  async getShellApprovalMode(): Promise<{ mode: 'strict' | 'allow_all' | 'deny_all' }> {
    return { mode: this.config.getShellApprovalMode() };
  }

  /**
   * Pin a set of skills as always-active for this agent. Empty array clears
   * the pin. Operators use this from the Settings page; without an RPC the
   * only way to set `always_active_skills` is direct SQL, which the spec
   * explicitly wants to avoid.
   */
  @callable()
  async setAlwaysActiveSkills(names: string[]): Promise<{ ok: true; names: string[] }> {
    if (!Array.isArray(names)) throw new Error('names must be a string array');
    for (const n of names) {
      if (typeof n !== 'string') throw new Error('names must contain only strings');
    }
    this.config.setAlwaysActiveSkills(names);
    return { ok: true, names: this.config.getAlwaysActiveSkills() };
  }

  /** Current pinned always-active skill names. Empty array means none. */
  @callable()
  async getAlwaysActiveSkills(): Promise<{ names: string[] }> {
    return { names: this.config.getAlwaysActiveSkills() };
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
    return { ok: true, messageId, feedback, rescored };
  }

  /** Read recorded feedback for a message. Returns null if none. */
  @callable()
  async getTurnFeedback(messageId: string): Promise<{ feedback: 'positive' | 'negative' | null }> {
    try {
      const rows = this.sql<{ feedback: 'positive' | 'negative' }>`
        SELECT feedback FROM turn_feedback WHERE message_id = ${messageId} LIMIT 1`;
      return { feedback: rows[0]?.feedback ?? null };
    } catch {
      return { feedback: null };
    }
  }

  /**
   * Generic agent_config setter. Used by the Settings page for tunables
   * like shadow_sample_rate, auto_promote_scaffold. Allow-listed keys only —
   * anything else throws so callers can't write arbitrary settings.
   */
  @callable()
  async setAgentConfig(key: string, value: string): Promise<{ ok: true; key: string; value: string }> {
    const allowedKeys = new Set([
      'shadow_sample_rate',
      'auto_promote_scaffold',
      'sleep_time_compute',
      'tool_surfacing_mode',
      'review_model',
      // shell_approval_mode has its own typed setter; not allowed via this.
    ]);
    if (!allowedKeys.has(key)) {
      throw new Error(`agent_config key not allowed via generic setter: ${key}`);
    }
    this.config.set(key, value);
    return { ok: true, key, value };
  }

  /** Read an agent_config value by key. Returns null if unset. */
  @callable()
  async getAgentConfig(key: string): Promise<{ key: string; value: string | null }> {
    return { key, value: this.config.get(key) };
  }

  /** List recent scaffold versions with their status. */
  @callable()
  async listScaffoldVersions(limit: number = 20) {
    return this.sql<{ version: number; written_at: number; rationale: string; status: string }>`
      SELECT version, written_at, rationale, status FROM scaffold_versions
      ORDER BY version DESC LIMIT ${limit}`;
  }

  // ── GEPA offline scaffold optimisation ─────────────────────────

  /**
   * Run a GEPA (Genetic-Pareto) optimisation pass over the agent's scaffold.
   * Offline + batch: builds an eval set from the agent's own recent tasks,
   * runs the current scaffold + reflection-mutated candidates against them,
   * scores each with a judge LLM, and — if a strictly-better candidate is
   * found — hands the winner to modifyScaffold so it enters the normal shadow-
   * eval → promote pipeline. Persisted to gepa_runs/gepa_candidates so the
   * UI can show lineage.
   *
   * Cost-bounded: small default budget (each metric call runs a full scaffold
   * + a judge call). Tune via opts.
   */
  @callable()
  async runScaffoldGepaOptimization(opts?: {
    maxIterations?: number;
    evalSize?: number;
    maxMetricCalls?: number;
  }): Promise<{
    ok: boolean;
    error?: string;
    runId?: string;
    proposed?: boolean;
    pendingVersion?: number | null;
    skipReason?: string;
    bestScore?: number;
    seedScore?: number;
    iterations?: number;
  }> {
    const evalSize = Math.max(1, Math.min(opts?.evalSize ?? 5, 20));
    const budget = {
      maxIterations: Math.max(1, Math.min(opts?.maxIterations ?? 4, 20)),
      maxMetricCalls: Math.max(10, Math.min(opts?.maxMetricCalls ?? 40, 200)),
      minibatchSize: 1,
    };

    // 1. Eval set from the agent's recent distinct user tasks.
    const taskRows = this.sql<{ content: string }>`
      SELECT DISTINCT content FROM messages
      WHERE role = 'user' AND length(content) > 0
      ORDER BY created_at DESC LIMIT ${evalSize}`;
    const evalSet: EvalInstance<string>[] = taskRows
      .map((r, i) => ({ id: `task-${i}`, input: r.content.slice(0, 2000) }))
      .filter(e => e.input.trim().length > 0);
    if (evalSet.length === 0) {
      return { ok: false, error: 'no eval tasks yet — chat with the agent first' };
    }

    const model = this.getModel();

    // 2. Metric: run the candidate scaffold against a task, judge the output.
    const metric = async (candidate: string, instance: EvalInstance<string>): Promise<MetricOutcome> => {
      let output: string;
      try {
        output = await this.runScaffoldCaptureText(candidate, instance.input);
      } catch (err) {
        return { score: 0, feedback: `scaffold execution failed: ${(err as Error).message}` };
      }
      try {
        const judged = await generateObject({
          model,
          schema: aiSchema<{ score: number; feedback: string }>(v.object({
            score: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
            feedback: v.pipe(v.string(), v.minLength(1)),
          })),
          prompt:
            `Rate this agent response to the task on a 0..1 scale (correctness, ` +
            `helpfulness, clarity) and give one sentence of specific, actionable ` +
            `feedback on how the agent's behaviour could improve.\n\n` +
            `Task:\n${instance.input}\n\nResponse:\n${output.slice(0, 4000)}\n\n` +
            `Respond as {score, feedback}.`,
          ...effortFor('judge'),
        });
        const obj = judged.object;
        return { score: obj.score, feedback: obj.feedback };
      } catch (err) {
        return { score: 0.5, feedback: `judge unavailable: ${(err as Error).message}` };
      }
    };

    // 3. Reflection LM — rewrites the scaffold from the failure feedback.
    const reflectionLm = async (prompt: string): Promise<string> => {
      const { text } = await generateText({ model, prompt, ...effortFor('scaffold_mutation') });
      return text;
    };

    // 4. Run GEPA, persisting every candidate + Pareto snapshot.
    const runId = startGepaRun(this.boundSql, { target: 'scaffold', budget });
    const persisted = new Set<string>();
    let result;
    try {
      result = await runScaffoldGepa({
        rt: this.rt,
        evalSet,
        metric,
        reflectionLm,
        budget,
        onIteration: makePersistingHook({ sql: this.boundSql, runId, evalSet, persisted }),
      });
    } catch (err) {
      finishGepaRun(this.boundSql, {
        runId, status: 'aborted', stopReason: 'aborted', winnerId: null, metricCalls: 0, iterations: 0,
      });
      return { ok: false, error: (err as Error).message, runId };
    }

    finishGepaRun(this.boundSql, {
      runId,
      status: 'completed',
      stopReason: result.gepa.stopReason,
      winnerId: result.gepa.winner.id,
      metricCalls: result.gepa.metricCallsUsed,
      iterations: result.gepa.iterationsRun,
    });

    return {
      ok: true,
      runId,
      proposed: result.proposed,
      pendingVersion: result.pendingVersion,
      skipReason: result.skipReason,
      bestScore: result.gepa.winner.aggregateScore,
      seedScore: result.gepa.history[0]?.aggregateScore,
      iterations: result.gepa.iterationsRun,
    };
  }

  /** List recent GEPA optimisation runs for the UI. */
  @callable()
  async getGepaRuns(limit: number = 20): Promise<GepaRunSummary[]> {
    try { return listGepaRuns(this.boundSql, limit); }
    catch { return []; }
  }

  /** One GEPA run in full: its candidates (scores/feedback per instance) +
   *  the Pareto-front membership — drives the Reasoning surface's Pareto
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
   * Read the current workspace text files (path → content) for diffing. Skips
   * directories, binary files (NUL byte), and anything over 256 KB; caps at 400
   * files. Backs the Output cumulative change-set.
   */
  private async readWorkspaceFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let paths: string[];
    try {
      paths = this.sql<{ path: string }>`
        SELECT DISTINCT path FROM vfs_files WHERE is_dir = 0 AND path != '' LIMIT 400`.map((r) => r.path);
    } catch { return out; }
    for (const path of paths) {
      try {
        const stat = await this.rt.storage.vfs.stat(path);
        if (stat && stat.size > 256 * 1024) continue;
        const content = await this.rt.storage.vfs.readFile(path, { encoding: 'utf8' });
        const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
        if (text.includes(String.fromCharCode(0))) continue; // binary (NUL byte = binary)
        out[path] = text;
      } catch { /* unreadable — skip */ }
    }
    return out;
  }

  /**
   * The cumulative workspace change-set since the baseline — what the agent has
   * created/changed/deleted, for review on the Output surface. The baseline is
   * captured lazily on first call (returns empty + baselineJustCaptured) and
   * re-markable via resetWorkspaceBaseline ("mark reviewed").
   */
  @callable()
  async getWorkspaceDiff(): Promise<{ files: FileDiff[]; baselineJustCaptured: boolean }> {
    const current = await this.readWorkspaceFiles();
    let baselineRows: Array<{ path: string; content: string }> = [];
    try {
      baselineRows = this.sql<{ path: string; content: string }>`SELECT path, content FROM vfs_baseline`;
    } catch { baselineRows = []; }
    if (baselineRows.length === 0) {
      // No baseline yet → capture the current state as the baseline.
      this.captureWorkspaceBaseline(current);
      return { files: [], baselineJustCaptured: true };
    }
    const baseline: Record<string, string> = {};
    for (const r of baselineRows) baseline[r.path] = r.content;
    return { files: computeWorkspaceDiff(baseline, current), baselineJustCaptured: false };
  }

  /** Mark the current workspace as the new baseline ("reviewed" — the diff
   *  resets to empty and accrues from here). */
  @callable()
  async resetWorkspaceBaseline(): Promise<{ ok: true; files: number }> {
    const current = await this.readWorkspaceFiles();
    this.captureWorkspaceBaseline(current);
    return { ok: true, files: Object.keys(current).length };
  }

  private captureWorkspaceBaseline(files: Record<string, string>): void {
    try {
      this.sql`DELETE FROM vfs_baseline`;
      for (const [path, content] of Object.entries(files)) {
        this.sql`INSERT OR REPLACE INTO vfs_baseline (path, content) VALUES (${path}, ${content})`;
      }
    } catch { /* table may not exist on very first start */ }
  }

  /** Recent branching-head runs (think strategy=heads): each root spawn with
   *  its child heads + the merged synthesis — drives the Reasoning surface's
   *  Branches strip. Reads head_journal + head_merge_results directly. */
  @callable()
  async getHeadRuns(limit: number = 20): Promise<Array<{
    rootId: string; task: string; rationale: string; status: string; spawnedAt: number;
    heads: Array<{ id: string; task: string; rationale: string; status: string; summary: string | null; tokenInput: number; tokenOutput: number; wallClockMs: number }>;
    merge: { narrative: string; headCount: number; totalTokens: number } | null;
  }>> {
    try {
      const roots = this.sql<{ id: string; task: string; rationale: string; status: string; spawned_at: number }>`
        SELECT id, task, rationale, status, spawned_at FROM head_journal
        WHERE parent_id IS NULL OR parent_id = ''
        ORDER BY spawned_at DESC LIMIT ${limit}`;
      return roots.map((root) => {
        const heads = this.sql<{ id: string; task: string; rationale: string; status: string; summary: string | null; token_input: number; token_output: number; wall_clock_ms: number }>`
          SELECT id, task, rationale, status, summary, token_input, token_output, wall_clock_ms
          FROM head_journal WHERE root_id = ${root.id} ORDER BY depth, spawned_at`
          .map((h) => ({
            id: h.id, task: h.task, rationale: h.rationale, status: h.status,
            summary: h.summary, tokenInput: h.token_input, tokenOutput: h.token_output, wallClockMs: h.wall_clock_ms,
          }));
        const mergeRow = this.sql<{ merged_narrative: string; cost_head_count: number; cost_total_tokens: number }>`
          SELECT merged_narrative, cost_head_count, cost_total_tokens
          FROM head_merge_results WHERE root_id = ${root.id}`[0];
        return {
          rootId: root.id, task: root.task, rationale: root.rationale, status: root.status, spawnedAt: root.spawned_at,
          heads,
          merge: mergeRow ? { narrative: mergeRow.merged_narrative, headCount: mergeRow.cost_head_count, totalTokens: mergeRow.cost_total_tokens } : null,
        };
      });
    } catch { return []; }
  }

  /** The agent's world model — keyed agent_facts, most-recent first — for the
   *  Brain surface. Wraps FactsStore (otherwise consumed only internally for
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

  /** Run a candidate scaffold against a task and return the concatenated
   *  text it produced. Used as the GEPA metric's rollout. */
  private async runScaffoldCaptureText(candidateCode: string, task: string): Promise<string> {
    let text = '';
    const result = await runScaffold({
      rt: this.rt,
      task,
      scaffoldCodeOverride: candidateCode,
      emit: (ev) => {
        if (ev.type === 'text_delta') text += ev.text;
        else if (ev.type === 'ui_chunk') {
          const c = ev.chunk as { type?: string; delta?: string } | undefined;
          if (c?.type === 'text-delta' && typeof c.delta === 'string') text += c.delta;
        }
      },
      llmStream: this.makeScaffoldLLMStream(),
      callTool: this.makeScaffoldCallTool(),
      defaultInference: () => streamText({
        model: this.getModel(),
        messages: [{ role: 'user', content: task }],
        tools: this.getTools(),
        stopWhen: stepCountIs(50),
        ...effortFor('scaffold_mutation'),
      }).toUIMessageStream(),
      timeoutMs: 2 * 60 * 1000,
    });
    if (!result.ok && result.error) throw new Error(result.error);
    return text;
  }

  // ── Durable run-event log — read endpoints + run listing ──

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

  /**
   * Recent runs enriched with PROVENANCE (what kicked each off) + COST (tokens
   * spent) — the cross-run history + budget view for the Supervise altitude.
   * Folds the per-run run_start (caused_by/userMessage) and summed turn_end
   * tokenUsage out of the durable event log.
   */
  @callable()
  async getRunSummaries(limit: number = 30): Promise<Array<{
    runId: string; startedAt: number; causedBy: string | null; userMessage: string | null;
    status: string | null; tokensIn: number; tokensOut: number; eventCount: number;
  }>> {
    return this.eventRecorder.listRuns(limit).map((run) => {
      let tokensIn = 0, tokensOut = 0;
      let causedBy: string | null = null, userMessage: string | null = null, status: string | null = null;
      let startedAt = Date.parse(run.lastTs) || Date.now();
      try {
        for (const e of this.eventRecorder.read(run.runId, { limit: 1000 })) {
          if (e.type === 'run_start') {
            causedBy = e.caused_by ?? 'chat';
            userMessage = e.userMessage ?? null;
            startedAt = Date.parse(e.timestamp) || startedAt;
          } else if (e.type === 'turn_end' && e.tokenUsage) {
            tokensIn += e.tokenUsage.input;
            tokensOut += e.tokenUsage.output;
          } else if (e.type === 'run_end') {
            status = e.reason ?? null;
          }
        }
      } catch { /* run events unreadable — return the bare summary */ }
      return { runId: run.runId, startedAt, causedBy, userMessage, status, tokensIn, tokensOut, eventCount: run.eventCount };
    });
  }

  /** Count events for a single run — for UI badges. */
  @callable()
  async countRunEvents(runId: string): Promise<number> {
    return this.eventRecorder.count(runId);
  }

  // ── MCP server bridge — small RPCs the MCP handler needs ──
  /** Used by the /mcp/v1/<name> save_note tool. Routes through the same
   *  appendMemoryNote primitive as workspace.saveNote + the `memory` builtin. */
  @callable()
  async saveNoteFromMcp(content: string): Promise<{ ok: true }> {
    await appendMemoryNote(this.rt.memory, content);
    return { ok: true };
  }

  // ── Hybrid memory search — FTS5 + Vectorize via RRF ──
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

  // ── SKILL.md export/import — make crafted tools git-friendly ──

  /**
   * Export every crafted tool to a SKILL.md file under `skills/` in the VFS.
   * Returns counts + per-tool error list. Skips tools whose code is empty
   * or comment-only.
   */
  @callable()
  async exportSkillsToVfs(dir?: string): Promise<ExportSkillsResult> {
    return exportAllSkillsToVfs(this.rt.storage.vfs, this.rt.craftStore, { dir });
  }

  /**
   * Import every SKILL.md file under `skills/` in the VFS back into the
   * CraftStore. For existing tools: update in place. For new ones: create.
   * Parse errors are reported per-file but don't halt the import.
   */
  @callable()
  async importSkillsFromVfs(dir?: string): Promise<ImportSkillsResult> {
    return importSkillsFromVfs(this.rt.storage.vfs, this.rt.craftStore, { dir });
  }

  /** Build a streaming LLM callback the scaffold executor calls via
   *  `host.llmStream(opts)` — text chunks come back as 'text_delta' events.
   *  `tools` is a list of tool names from the agent's surface; we resolve them
   *  to the real executables and run a multi-step loop bounded by `maxSteps`,
   *  so a scaffold's model call has genuine tool access (not a one-shot). */
  private makeScaffoldLLMStream(): import('@proteus/core').ScaffoldRunOptions['llmStream'] {
    const orchestrator = this;
    const model = this.getModel();
    return async function* (opts) {
      const all = orchestrator.getTools();
      const toolSet: ToolSet = (opts.tools && opts.tools.length > 0)
        ? Object.fromEntries(opts.tools.filter(n => all[n]).map(n => [n, all[n]]))
        : all;
      const result = streamText({
        model,
        system: opts.system,
        messages: opts.messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
        tools: toolSet,
        stopWhen: stepCountIs(opts.maxSteps ?? 50),
        ...effortFor('scaffold_mutation'),
      });
      for await (const chunk of result.textStream) yield chunk;
    };
  }

  /**
   * Internal: build a callTool callback that dispatches to the parent's
   * ToolSet. Used by the scaffold to invoke any tool the orchestrator has
   * (e.g. memory, fact, run).
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
        // `args as never` is the legitimate dynamic-dispatch escape: the tool
        // is selected by string name at runtime, so its input type is unknown
        // here. The options object IS statically known — type it precisely so
        // a future required ToolCallOptions field can't silently slip through.
        const options: Parameters<NonNullable<ToolSet[string]['execute']>>[1] = {
          messages: [], toolCallId: `scaffold-${Date.now()}`,
        };
        return await t.execute(args as never, options);
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

  // setModel moved below — validates spec via the provider registry before storing.

  @callable() async setDisplayName(displayName: string) {
    this.config.setDisplayName(displayName);
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
    return { status, tools, memoryContent, mcts, timeline, executors, executorOutputs };
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

  /** The agent's current stored model spec. UI tells which menu entry to
   *  preselect; the full available-models list comes from /api/user/models
   *  (UserDO) so connections are user-scoped. */
  @callable() async getStoredModelSpec(): Promise<{ spec: string | null }> {
    return { spec: this.getStoredModelId() };
  }

  @callable() async setModel(spec: string) {
    try {
      const reg = this.providerRegistry();
      // Validate before storing — surfaces unknown-provider / invalid-spec
      // errors at config time, not on the next chat turn.
      const normalized = reg.normalizeSpecSync(spec);
      this.config.setModel(normalized);
      this.invalidateModelCaches();
      console.log(`[orchestrator] setModel: ${spec} → ${normalized}`);
      return { ok: true, spec: normalized };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error(`[orchestrator] setModel(${spec}) failed:`, msg);
      throw new Error(`setModel(${spec}) failed: ${msg}`);
    }
  }

  /** Invalidate every cache that depends on the resolved model so the next
   *  getModel() / getThinkTool() / providerRegistry() call rebuilds. */
  private invalidateModelCaches(): void {
    this._cachedModel = null;
    this._cachedModelSpec = null;
    this._thinkTool = null;
    // Provider registry caches per-agent OAuth refreshers; rebuild so a
    // disconnected provider stops being marked available.
    this._providerRegistry = null;
  }

  // ── Credentials & Codex OAuth ─────────────────────────────────────
  //
  // All credentials live in UserDO (single source of truth across the user's
  // agents). The orchestrator no longer stores, refreshes, or even reads
  // raw credentials — providers resolve auth headers through the UserDO
  // stub at fetch time. Use the `/api/user/codex/*` routes (or the user
  // settings UI) to connect ChatGPT / save BYO API keys.

  /** Worker calls this when a credential mutation in UserDO should drop
   *  cached provider/model state in this agent. Cheap; no-op if nothing
   *  is cached. */
  @callable()
  async onCredentialsChanged(): Promise<{ ok: true }> {
    this.invalidateModelCaches();
    return { ok: true };
  }

  // ── Voyager curriculum: propose / list / accept next tasks ─────────

  @callable() async proposeCurriculumTasks(count?: number) {
    const proposals = await proposeNextTasks({
      rt: this.rt,
      judge: this.rt.llm,
      count: count ?? 5,
    });
    return { proposals };
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

  @callable() async setSoul(purpose: string) {
    this.sql`UPDATE agent_soul SET purpose = ${purpose}`;
    // Invalidate the cached purpose + system prompt so the next turn
    // picks up the new identity.
    this._cachedSoulPurpose = null;
    this._cachedSystemPrompt = null;
    this._cachedSystemPromptKey = '';
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
    return {
      explorationConstant: parseFloat(this.config.get('mcts_c') ?? '1.414'),
      maxIterations: parseInt(this.config.get('mcts_iterations') ?? '50'),
      maxDepth: parseInt(this.config.get('mcts_depth') ?? '5'),
      branchBudget: parseInt(this.config.get('mcts_branches') ?? '3'),
    };
  }

  @callable() async setMctsConfig(config: {
    explorationConstant?: number; maxIterations?: number;
    maxDepth?: number; branchBudget?: number;
  }) {
    if (config.explorationConstant !== undefined) this.config.set('mcts_c', String(config.explorationConstant));
    if (config.maxIterations !== undefined) this.config.set('mcts_iterations', String(config.maxIterations));
    if (config.maxDepth !== undefined) this.config.set('mcts_depth', String(config.maxDepth));
    if (config.branchBudget !== undefined) this.config.set('mcts_branches', String(config.branchBudget));
    return config;
  }

  /**
   * Broadcast the current MCTS tree to all connected WebSocket clients.
   * Called after each MCTS iteration so the UI updates in real-time.
   */
  /**
   * Inference seam override — THE single production chat path.
   *
   * Think calls this from `_runInferenceLoop` with the fully-prepared
   * streamText options. We route through the agent's mutable scaffold IFF it
   * has evolved one (current version > 0). An un-evolved agent (still on the
   * bootstrap v0) uses the standard `streamText` directly — same behaviour as
   * before, zero overhead — until the evolution loop proves + promotes a
   * better scaffold via shadow eval. Once promoted, that scaffold becomes the
   * agent's live inference loop. One method, one decision, no parallel paths.
   *
   * The scaffold runs in the codemode sandbox and reaches the model/tools/
   * memory only through the `host.*` bridge (the live opts/model object can't
   * cross the boundary). `host.defaultInference()` runs exactly THIS streamText
   * and streams its chunks back, so a delegating scaffold is faithful to the
   * default; a custom scaffold can wrap or replace it.
   */
  protected runStreamText(
    opts: Parameters<typeof streamText>[0],
  ): StreamableResult {
    let version = 0;
    try {
      version = this.sql<{ v: number }>`
        SELECT COALESCE(MAX(version), 0) AS v FROM scaffold_versions WHERE status = 'current'`[0]?.v ?? 0;
    } catch { /* table not initialized yet → treat as un-evolved */ }

    if (version <= 0) return streamText(opts);

    // Evolved scaffold is live — run it as the inference loop.
    const orchestrator = this;
    const task = extractLastUserText((opts.messages ?? []) as ModelMessage[]);
    return {
      toUIMessageStream: () => scaffoldEventsToUIStream(
        (emit) => runScaffold({
          rt: orchestrator.rt,
          task,
          emit,
          llmStream: orchestrator.makeScaffoldLLMStream(),
          callTool: orchestrator.makeScaffoldCallTool(),
          defaultInference: () => streamText(opts).toUIMessageStream(),
          timeoutMs: 5 * 60 * 1000,
        }),
      ),
    };
  }

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

  // ── EventsHub RPCs — triggers + events for UI ──────────────────

  /** List triggers (webhooks, timers, watches, mcp routes). UI uses this
   *  for the per-agent Triggers tab. */
  @callable()
  async listTriggers() {
    return {
      triggers: this.triggerRegistry.list().map((t) => ({
        id: t.id,
        kind: t.kind,
        spec: t.spec,
        creator_trust: t.creator_trust,
        state: t.state,
        created_at: t.created_at,
        paused_at: t.paused_at,
        revoked_at: t.revoked_at,
        rate_limit_per_min: t.rate_limit_per_min,
      })),
    };
  }

  /** Create a durable webhook trigger. Returns the public URL. Operator
   *  UI calls this through `/api/agents/<name>/triggers` (step-up auth +
   *  CSRF enforced at the HTTP layer). */
  @callable()
  async createDurableWebhook(opts: {
    label: string;
    auth_mode: 'hmac' | 'bearer' | 'mtls';
    secret?: string;
    accepted_content_type?: string;
    rate_limit_per_min?: number;
  }) {
    // Secret stored opaquely; lookup later by trigger id.
    const secret_id = `webhook_secret_${Math.random().toString(36).slice(2, 12)}`;
    const id = this.triggerRegistry.register({
      kind: 'webhook_durable',
      spec: {
        label: opts.label,
        auth_mode: opts.auth_mode,
        secret_id,
        accepted_content_type: opts.accepted_content_type ?? 'application/json',
      },
      creator_trust: 'owner',
      rate_limit_per_min: opts.rate_limit_per_min ?? 60,
    }, Date.now());

    // Store the secret in the per-agent webhook_secrets table (kept
    // separate from the trigger row so it's never returned by listTriggers).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS webhook_secrets (
        secret_id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
    if (opts.secret) {
      this.ctx.storage.sql.exec(
        `INSERT INTO webhook_secrets (secret_id, trigger_id, secret, created_at) VALUES (?, ?, ?, ?)`,
        secret_id, id, opts.secret, Date.now(),
      );
    }

    return {
      trigger_id: id,
      url: `/api/agents/${encodeURIComponent(this.name)}/webhook/${encodeURIComponent(id)}`,
      auth_mode: opts.auth_mode,
      // For HMAC/bearer modes, the operator needs the secret once to give
      // to the external system; we return it inline now and never again.
      secret: opts.secret ?? null,
    };
  }

  /** Cancel a trigger (revoke). Idempotent. */
  @callable()
  async cancelTrigger(trigger_id: string) {
    const changed = this.triggerRegistry.revoke(trigger_id, Date.now());
    return { ok: true, changed };
  }

  /** Run a webhook delivery through the hub from within the agent DO. This
   *  RPC is invoked by the top-level webhook route (`handleHubRequest`) so
   *  the publish + dedupe + reply channel open run atomically in the agent's
   *  storage context. */
  @callable()
  async acceptWebhookDelivery(opts: {
    trigger_id: string;
    method: string;
    headers: Record<string, string>;
    body_text: string;
    cf_mtls_verified: boolean;
    delivery_id: string | null;
    hmac_signature: string | null;
    hmac_timestamp: string | null;
    bearer_header: string | null;
    content_type: string | null;
    now: number;
  }): Promise<{
    status: 'admitted' | 'rejected';
    http_status?: number;
    reason?: string;
    event_id?: string;
    admitted?: boolean;
  }> {
    // Validate trigger.
    const trigger = this.triggerRegistry.get(opts.trigger_id);
    if (!trigger) return { status: 'rejected', http_status: 404, reason: 'trigger not found' };
    if (trigger.state !== 'active') {
      return { status: 'rejected', http_status: 503, reason: `trigger ${trigger.state}` };
    }
    if (trigger.kind !== 'webhook_durable' && trigger.kind !== 'webhook_ephemeral') {
      return { status: 'rejected', http_status: 400, reason: 'not a webhook trigger' };
    }

    const spec = trigger.spec as {
      accepted_content_type?: string;
      auth_mode: 'hmac' | 'bearer' | 'mtls';
      secret_id?: string;
    };

    // Content-type pin.
    const receivedCT = opts.content_type?.split(';')[0].trim() ?? '';
    if (spec.accepted_content_type && spec.accepted_content_type !== receivedCT) {
      return { status: 'rejected', http_status: 415, reason: `expected ${spec.accepted_content_type}` };
    }

    // Auth.
    let ingress: 'webhook_hmac' | 'webhook_bearer' | 'webhook_mtls';
    if (spec.auth_mode === 'hmac') {
      if (!spec.secret_id) return { status: 'rejected', http_status: 401, reason: 'no hmac secret configured' };
      const secret = (await this.getWebhookSecret(opts.trigger_id)).secret;
      if (!secret) return { status: 'rejected', http_status: 401, reason: 'secret revoked' };
      if (!opts.hmac_signature || !opts.hmac_timestamp) {
        return { status: 'rejected', http_status: 401, reason: 'missing hmac headers' };
      }
      const ts = parseInt(opts.hmac_timestamp, 10);
      if (!Number.isFinite(ts) || Math.abs(opts.now - ts) > 5 * 60 * 1000) {
        return { status: 'rejected', http_status: 401, reason: 'timestamp out of window' };
      }
      const expected = await this.computeHmacSha256(secret, `${ts}.${opts.body_text}`);
      if (!timingSafeEqual(expected, opts.hmac_signature)) {
        return { status: 'rejected', http_status: 401, reason: 'signature mismatch' };
      }
      ingress = 'webhook_hmac';
    } else if (spec.auth_mode === 'bearer') {
      if (!spec.secret_id) return { status: 'rejected', http_status: 401, reason: 'no bearer secret' };
      const stored = (await this.getWebhookSecret(opts.trigger_id)).secret;
      if (!stored) return { status: 'rejected', http_status: 401, reason: 'secret revoked' };
      if (!opts.bearer_header || !opts.bearer_header.startsWith('Bearer ')) {
        return { status: 'rejected', http_status: 401, reason: 'missing bearer' };
      }
      const presented = opts.bearer_header.slice('Bearer '.length).trim();
      if (!timingSafeEqual(stored, presented)) {
        return { status: 'rejected', http_status: 401, reason: 'bearer mismatch' };
      }
      ingress = 'webhook_bearer';
    } else {
      if (!opts.cf_mtls_verified) {
        return { status: 'rejected', http_status: 401, reason: 'client cert not verified' };
      }
      ingress = 'webhook_mtls';
    }

    // Parse body.
    let parsedBody: unknown;
    try {
      parsedBody = receivedCT.includes('json') ? JSON.parse(opts.body_text) : opts.body_text;
    } catch { parsedBody = opts.body_text; }

    const delivery_id = opts.delivery_id ?? `${opts.now}-${Math.random().toString(36).slice(2, 10)}`;

    // Open reply channel (http_pending). v1: we always return 202 immediately
    // so the channel is opened-then-immediately-aborted; v2 will hold the
    // HTTP request open against this channel.
    const reply_channel_id = this.replyChannels.open({
      event_id: 'pending',
      kind: 'http_pending',
      holder_addr: `delivery:${delivery_id}`,
      payload_policy: 'redact',
      ttl_ms_override: 30_000,
    }, opts.now);

    // Publish.
    const { id, admitted } = this.eventLog.publish({
      descriptor: {
        ingress,
        variant: 'webhook',
        payload: {
          webhook_id: opts.trigger_id,
          http_method: opts.method,
          http_headers: opts.headers,
          body: parsedBody,
          delivery_id,
        },
        auth_outcome: 'verified',
        webhook_id: opts.trigger_id,
      },
      now: opts.now,
      reply_channel: reply_channel_id ? { id: reply_channel_id, kind: 'http_pending' } : undefined,
    });

    // Wake the agent so the next chat turn drains the new event. The
    // operator's WS client (if any) sees a system note.
    try {
      const broadcast = (this as unknown as {
        broadcastChatMessage?: (msg: unknown) => Promise<void> | void;
      }).broadcastChatMessage;
      await broadcast?.({
        role: 'system',
        parts: [{
          type: 'text',
          text: `[hub] webhook event admitted: ${opts.trigger_id} → ${id} (${admitted ? 'new' : 'duplicate'})`,
        }],
      });
    } catch { /* best-effort */ }

    return { status: 'admitted', event_id: id, admitted };
  }

  private async computeHmacSha256(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /** Look up a webhook secret by trigger id. Used by the webhook ingress at
   *  request time. Returns null if the trigger has no secret or doesn't exist. */
  @callable()
  async getWebhookSecret(trigger_id: string): Promise<{ secret: string | null }> {
    try {
      const rows = this.ctx.storage.sql.exec(
        `SELECT secret FROM webhook_secrets WHERE trigger_id = ? ORDER BY created_at DESC LIMIT 1`,
        trigger_id,
      ).toArray() as Array<{ secret: string }>;
      return { secret: rows[0]?.secret ?? null };
    } catch {
      return { secret: null };
    }
  }

  /** Recent events for the operator UI's events sidebar. Mirrors
   *  events_v ordering (received_at desc). */
  @callable()
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

  /** Currently-pending (unbound) events. The agent's LLM calls this via
   *  the `list_pending_events` tool. */
  @callable()
  async listPendingEvents() {
    const events = this.eventLog.pending({ limit: 50 });
    return {
      events: events.map((e) => ({
        id: e.id,
        variant: e.variant,
        trust: e.trust,
        priority: e.priority,
        triggered_by: e.ingress,
        received_at: e.received_at,
      })),
    };
  }

  /** Defer an event with an enumerated revisit condition (LLM-facing). */
  @callable()
  async deferEvent(event_id: string, revisit_at: RevisitCondition) {
    this.eventLog.defer(event_id, revisit_at);
    return { ok: true };
  }

  /** Explicit drop (LLM-facing). */
  @callable()
  async dismissEvent(event_id: string, reason: string = 'agent dismissed') {
    this.eventLog.dismiss(event_id, reason, 'tool');
    return { ok: true };
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

  // ── Internal: timing-safe string compare for webhook auth ──────

  // (Defined at module scope at the bottom of the file.)

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

// ── Module-scope helpers (referenced by OrchestratorAgent) ────────

/** Constant-time string compare. Same as core utilities; inlined here to
 *  keep the orchestrator self-contained for the webhook-auth path. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

