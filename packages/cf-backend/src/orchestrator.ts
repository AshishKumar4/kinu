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
import { createCompactFunction } from "agents/experimental/memory/utils";
import { getSandbox } from "@cloudflare/sandbox";
import { Think, Session } from "@cloudflare/think";
// preamble-injection pattern: we construct the codemode tool
// directly via createCodeTool + PreambleCraftedExecutor. The executor reads
// craftStore.list() on every call and splices a `const tools = {...}`
// preamble into the LLM's sandbox arrow, so mid-turn additions are visible
// on the next execute_tools call and tool bodies share lexical scope with
// workspace.*/codemode.* (see docs/CRAFT-ARCHITECTURE.md).
import { streamText, generateText, tool, jsonSchema, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import * as v from "valibot";
import type { SerializableToolDescriptor } from "./user/mcp.js";
import type { TimelineSpan, DirEntry } from "./lib/protocol.js";
import { runEventToSpan, classifyEvolutionType, safeJsonParse } from "./lib/timeline.js";
import { nextCronFire } from "./lib/cron.js";
import { compactionThreshold } from "./lib/context-window.js";
import { generateJson } from "./lib/generate-json.js";
import { diffLines, computeWorkspaceDiff, parseGitDiff, type DiffLine, type FileDiff } from "./lib/diff.js";
import { parseReaddirEntries, sortDirEntries } from "./lib/files.js";
import { deriveAgentTitle } from "./lib/agent-naming.js";
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
  // backend-agnostic per-turn accounting + orchestration (shared by cf + cli)
  TurnAccumulator, type StepLike, AgentOrchestrator, type BackendHost,
  shouldBackupWorkspace, workspaceBackupOptions,
  BUILTIN_TOOLS,
  type BuiltinToolName,
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
  type SerializedMessage, type SplitPhaseEvent, type HeadRunView, type HeadRuntime,
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
  // Background-job system (#173 — auto-background >30s tool calls)
  BackgroundJobStore, BackgroundJobRunner, initBackgroundJobsTable, withBackgroundThreshold, type BackgroundJob,
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
  type ProductChangeApproval, type ProductChangeCheck, type ProductChangeStatus,
  type ProductDeploymentRecord, type ProductChangeToolDeps, type ProductSourceBindingInput,
  readSoul, SOUL_PATH, summarizeSoul, writeSoul,
} from "@proteus/core";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createCFRuntime, type CFRuntime } from "./runtime.js";
import { PreambleCraftedExecutor } from "./crafted-tool-registry.js";
import { createCFHeadRuntime } from "./heads/head-runtime.js";
import { createAgentProviderRegistry, type AgentProviderRegistry } from "./providers/agent-registry.js";
import { agentAffinityKey } from "./providers/workers-ai.js";
import { timingSafeEqual } from "./lib/crypto.js";
import { markLastToolForAnthropicCache } from "./providers/anthropic-cache.js";
import { createRLMProvider } from "./rlm.js";
import { createAgentSelfProvider } from "./agent-self.js";
import type { UserDO } from "./user/user-do.js";
import {
  initWebhookRateLimitTables,
  normalizeWebhookRateLimitPerMin,
  tryConsumeWebhookRateLimit,
} from "./events/webhook-rate-limit.js";

const SESSION_REFLECTION_INTERVAL = 5; // turns between session reflections

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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

function readCliCwd(body?: Record<string, unknown>): string | null {
  const cwd = body?.cwd;
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
}

function withCliCwdContext(messages: ReadonlyArray<ModelMessage>, cwd: string): ModelMessage[] {
  const prefix = `Current terminal working directory: ${cwd}\n\n`;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const next = [...messages];
    next[i] = {
      ...message,
      content: prefixCliCwdContent(message.content, prefix) as ModelMessage['content'],
    } as ModelMessage;
    return next;
  }
  return [...messages];
}

function prefixCliCwdContent(content: unknown, prefix: string): unknown {
  if (typeof content === 'string') return `${prefix}${content}`;
  if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
  return prefix;
}

function executorOutputIsError(output: string): boolean {
  const text = output.trim();
  if (!text) return false;
  return /^(error\b|exit\b|exec error:|read error:|write error:|list error:|delete error:|expose error:|unexpose error:|listports error:|runtime error:)/i.test(text);
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
  /** Backend-agnostic per-turn accounting (tool calls, steps, usage, errors).
   *  Lazily built with cf sinks → activity_log + the durable run-event recorder.
   *  Shared with the CLI backend (core/orchestrator/turn-accumulator). */
  // The backend-agnostic agent logic (per-turn accounting + session-evolution
  // cadence + the event→turn reactor). The DO provides the BackendHost
  // (broadcast + programmatic-turn via saveMessages) + the cf sinks. The CLI
  // backend builds the same AgentOrchestrator with its own host.
  private _orch: AgentOrchestrator | null = null;
  private get orch(): AgentOrchestrator {
    if (!this._orch) {
      this._orch = new AgentOrchestrator({
        host: this.host,
        engine: this.engine,
        eventLog: this.eventLog,
        sessionReflectionInterval: SESSION_REFLECTION_INTERVAL,
        sinks: {
          logActivity: (e, d) => this.logActivity(e, d),
          onToolCallEvent: (ev) => {
            try {
              if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, { type: 'tool_call_end', ...ev });
            } catch (err) { console.warn('[proteus] event emit failed at afterToolCall:', err); }
          },
          onStepEvent: (ev) => {
            try {
              if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, { type: 'step_finish', stepIndex: ev.stepIndex, reason: ev.reason });
            } catch (err) { console.warn('[proteus] event emit failed at onStepFinish:', err); }
          },
        },
      });
    }
    return this._orch;
  }
  private get acc(): TurnAccumulator { return this.orch.acc; }

  // The BackendHost the core orchestrator runs against. broadcast → DO fan-out;
  // enqueueTurn → Think.saveMessages (TurnQueue-serialized programmatic turn) —
  // the resume path for the reactor + background-job wake + consent.
  private _host: BackendHost | null = null;
  private get host(): BackendHost {
    if (!this._host) {
      const agent = this;
      this._host = {
        broadcast: (event) => { try { this.broadcast(JSON.stringify(event)); } catch { /* nop */ } },
        enqueueTurn: async ({ text, metadata }) => {
          const result = await this.saveMessages([{
            id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }],
            ...(metadata ? { metadata } : {}),
          }]);
          return { status: result.status === 'skipped' ? 'skipped' : 'queued' };
        },
        // Branching-heads runtime (Facet spawner + merge LLM), resolved lazily —
        // heads need the owner for UserDO auth, set by first-turn time. undefined
        // before then ⇒ heads degrade (getHeadController throws the no-owner error).
        get headRuntime() { return agent.getCFHeadRuntime(); },
      };
    }
    return this._host;
  }
  /** Executors whose tools ran this turn — debounces the last-active-executor
   *  write to one SQL upsert per executor per turn. Reset in beforeTurn. */
  private _executorsUsedThisTurn = new Set<string>();
  /** /workspace backups are debounced via the persisted last-backup time +
   *  this optimistic gate. Restore happens lazily in the sandbox handle on
   *  first actual sandbox use, not at turn startup. */
  private _lastWorkspaceBackupAt = 0;
  /** Turns of new execution traces since the last auto-GEPA pass (in-memory
   *  cadence; resets on eviction, which just delays the next pass slightly). */
  private _turnsSinceGepa = 0;
  // Session-reflection cadence (_sessionTurnCount/Turns/StartedAt) now lives on
  // the core AgentOrchestrator; read the turn index via this.orch.sessionTurnIndex.

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

  // The orchestrator's view of head activity (journal + runs + steps). Shared by
  // getHeadController (write path) and getHeadRuns (read path).
  private _headJournal: HeadJournal | null = null;
  private get headJournal(): HeadJournal {
    if (!this._headJournal) this._headJournal = new HeadJournal(this.boundSql);
    return this._headJournal;
  }

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
  /** Per-activation guard so the full table-init DDL runs once, not on every
   *  onStart + claimOwner. Resets on DO eviction, so a cold start always
   *  re-creates any newly-added tables (no schema-version bookkeeping). */
  private _schemaReady = false;

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

  // Background-job registry — work auto-detached past the 30s threshold (#173).
  private _jobs: BackgroundJobStore | null = null;
  private get jobs(): BackgroundJobStore {
    if (!this._jobs) this._jobs = new BackgroundJobStore(this.boundSql);
    return this._jobs;
  }
  // The backend-agnostic background-job lifecycle (detach → settle → wake +
  // cancel + evict-recovery), running over the durable fiber (rt.schedule.fiber)
  // and the BackendHost programmatic-turn wake. Owns the cancel-controller map.
  private _jobRunner: BackgroundJobRunner | null = null;
  private get jobRunner(): BackgroundJobRunner {
    if (!this._jobRunner) {
      this._jobRunner = new BackgroundJobRunner({
        store: this.jobs,
        fiber: this.rt.schedule.fiber,
        host: this.host,
        logActivity: (event, detail) => this.logActivity(event, detail),
      });
    }
    return this._jobRunner;
  }
  /** Foreground long-tool controllers before they cross the background
   *  threshold. Once detached, BackgroundJobRunner owns cancellation. */
  private readonly _activeToolControllers = new Set<AbortController>();

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

  // Per-turn in-flight flag — forkAgent rejects with "agent busy" while set.
  // Set in beforeTurn, cleared in onChatResponse (after durable persist;
  // evolution is fire-and-forget and does not extend the busy window).
  private _inFlight = false;
  private _cliCwd: string | null = null;

  getCliCwdForDevice(): string | null {
    return this._cliCwd;
  }

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
      // `agent.*` — the agent steers itself (curriculum + self-scheduling).
      const agentSelfProvider = createAgentSelfProvider(this);
      // Record which executor the agent actually works in, so the UI (diff /
      // file manager) defaults to where work happened. One upsert per executor
      // per turn (debounced via _executorsUsedThisTurn, reset in beforeTurn).
      const recordExecutor = (name: string) => {
        if (this._executorsUsedThisTurn.has(name)) return;
        this._executorsUsedThisTurn.add(name);
        try { this.config.setLastActiveExecutor(name); } catch { /* best-effort capture */ }
      };
      const allProviders = [craftedProvider, rlmProvider, agentSelfProvider, ...executorProviders.map(p => {
        const tools = p.tools as Record<string, { description?: string; execute: (...args: unknown[]) => Promise<unknown> }>;
        const wrapped: typeof tools = {};
        for (const [k, tool] of Object.entries(tools)) {
          wrapped[k] = { ...tool, execute: async (...args) => { const r = await tool.execute(...args); recordExecutor(p.name); return r; } };
        }
        return { name: p.name, tools: wrapped, types: p.types, positionalArgs: p.positionalArgs };
      })];

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
      workersAI: { sessionAffinity: agentAffinityKey(this.name) },
    });
    return this._providerRegistry;
  }

  /** Read the owner userId from agent_identity; '' (empty) means unclaimed. */
  protected getOwnerUserId(): string | null {
    try {
      const rows = this.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM agent_identity LIMIT 1`;
      const v = rows[0]?.owner_user_id;
      return v && v !== '' ? v : null;
    } catch { return null; }
  }

  private getOwnerUserDO(): DurableObjectStub<UserDO> | null {
    const userId = this.getOwnerUserId();
    if (!userId) return null;
    return this.env.UserDO.get(this.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
  }

  private requireOwnerUserDO(): DurableObjectStub<UserDO> {
    const stub = this.getOwnerUserDO();
    if (!stub) throw new Error('Agent has no owner yet. Open it through the authenticated app or CLI first.');
    return stub;
  }

  private getProductChangeToolDeps(): ProductChangeToolDeps | undefined {
    const userDO = this.getOwnerUserDO();
    if (!userDO) return undefined;
    return {
      board: () => userDO.getProductChangeBoard(this.name, 20),
      bindSource: (input) => userDO.upsertProductSourceBinding(input),
      create: (input) => userDO.createProductChange(this.name, input),
      update: (changeId, patch) => userDO.updateProductChange(changeId, patch),
      transition: (changeId, status) => userDO.transitionProductChange(changeId, status),
      recordCheck: (changeId, input) => userDO.recordProductChangeCheck(changeId, input),
      requestApproval: (changeId, approvalType) => userDO.requestProductChangeApproval(changeId, approvalType),
      recordDeployment: (changeId, input) => userDO.recordProductDeployment(changeId, input),
    };
  }

  /** Worker calls this on every authenticated request before any other RPC.
   *  Claims the agent for `userId` if unclaimed; 403s on cross-user collision.
   *
   *  Defensive: claimOwner can fire BEFORE onStart() completes on a fresh DO
   *  activation (the agents SDK doesn't strictly guarantee onStart→RPC order).
   *  ensureSchema() creates all required tables so the SELECT/UPDATE never hits
   *  a missing table or column, and is flag-gated so onStart won't repeat it.
   */
  @callable()
  async claimOwner(userId: string): Promise<{ owner: string }> {
    if (!userId) throw new Error('userId required');
    try {
      this.ensureSchema();
    } catch (err) {
      console.error('[orchestrator] claimOwner ensureSchema failed:', (err as Error).message);
    }
    const current = this.getOwnerUserId();
    if (current === null) {
      // Unclaimed — first touch. Ensure identity has the owner marker.
      const exists = this.sql<{ x: number }>`SELECT 1 AS x FROM agent_identity LIMIT 1`;
      if (exists.length === 0) {
        this.sql`
          INSERT INTO agent_identity (id, name, owner_user_id, created_at)
          VALUES (${this.ctx.id.toString()}, ${this.name}, ${userId}, ${Date.now()})
        `;
      } else {
        this.sql`UPDATE agent_identity SET owner_user_id = ${userId}`;
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
  /** Cached SOUL.md text. Loaded lazily on first read, invalidated by
   *  setSoul(). Avoids a SQL round-trip on every getSystemPrompt() call. */
  private _cachedSoulText: string | null = null;
  private getSoulText(): string {
    if (this._cachedSoulText === null) {
      this._cachedSoulText = readSoul(this.boundSql) ?? '';
    }
    return this._cachedSoulText;
  }

  getSystemPrompt(): string {
    this.logActivity("getsystemprompt_start");
    const execs = this.rt.executionRouter?.listExecutors() ?? [];
    const execKey = execs.map(e =>
      `${e.name}:${e.available ? 1 : 0}:${e.configured ? 1 : 0}:${e.active ? 1 : 0}:${e.status}`,
    ).join(",");
    const modelId = this.getStoredModelId();
    const key = `${this.getSoulText()}\u0000${execKey}\u0000${modelId}`;
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
      base = buildSystemPromptSync(this.rt, {
        executors: execs,
        availableTools: ACTIVE_TOOLS,
        backend: 'cf',
        model: { id: modelId ?? undefined },
      });
      this._cachedSystemPrompt = base;
      this._cachedSystemPromptKey = key;
      this.logActivity("getsystemprompt_end", `${base.length} chars`);
    }
    // Append the recent-facts tail (changes per turn, so it sits AFTER the
    // cacheable instruction+tools prefix). Single source — see factsTail().
    return base + this.factsTail();
  }

  /** The recent-facts block appended to the system prompt — rendered fresh each
   *  turn (facts change), so it's intentionally outside the cached prefix.
   *  Returns '' when there are no facts. One source for both the base-prompt
   *  and the skills-override paths (was copy-pasted). */
  private factsTail(): string {
    try {
      const block = renderFactsBlock(this.facts.recentTopK(20), { maxChars: 2000 });
      if (block) return `\n\n## World model (facts you remembered):\n${block}`;
    } catch { /* facts table not yet initialized */ }
    return '';
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
    // The Think chat loop's tool source (first hook called by _runInferenceLoop).
    // Returns the CHAT view = the raw surface + the auto-background wrap (#173).
    // Internal eval side-streams use getRawTools() instead, so a >30s tool run
    // inside a shadow-eval / scaffold / GEPA evaluation never detaches a job or
    // injects an unsolicited "job completed" turn into the user's chat.
    this._turnT0 = performance.now();
    this.logActivity("gettools_start");
    return this.wrapToolsForBackground(this.getRawTools());
  }

  /** The UNWRAPPED tool surface — built + cached. Shared by the chat path (via
   *  getTools, which adds the background wrap) and by internal eval side-streams
   *  that must run tools to completion inline (never auto-background). */
  private getRawTools(): ToolSet {
    // Cache key includes CraftStore updated_at AND craft_scores last_used_at
    // because effective-score filtering depends on recency.
    const cacheKey = this._craftCacheKey();
    if (this._cachedTools && cacheKey === this._cachedToolsKey) {
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
        productChanges: this.getProductChangeToolDeps(),
      });

      // Anthropic prompt-caching: one breakpoint on the last tool caches the
      // whole stable tool surface (tools precede system+messages in Anthropic's
      // cache hierarchy). Namespaced → inert for non-Anthropic providers.
      markLastToolForAnthropicCache(tools);

      this._cachedTools = tools;
      this._cachedToolsKey = cacheKey;
      this.logActivity("gettools_end", `rebuilt — ${Object.keys(tools).length} tools`);
      return tools;
    } catch (err) {
      console.error("[proteus] getRawTools() FAILED:", err);
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
    // The HeadRuntime flows through the BackendHost seam (CLI supplies a
    // subprocess-backed one or undefined → single-shot degrade).
    const runtime = this.host.headRuntime;
    if (!runtime) throw new Error('Agent has no owner — branching heads need UserDO access for auth.');
    this._headController = new HeadController(runtime, this.headJournal);
    return this._headController;
  }

  /** Build the CF HeadRuntime (Facet spawner + merge LLM) once per DO lifetime,
   *  lazily — heads need the agent's owner for UserDO auth. undefined when the
   *  agent has no owner; surfaced via host.headRuntime. */
  private _cfHeadRuntime: HeadRuntime | null = null;
  private getCFHeadRuntime(): HeadRuntime | undefined {
    if (this._cfHeadRuntime) return this._cfHeadRuntime;
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) return undefined;
    this._cfHeadRuntime = createCFHeadRuntime(this as unknown as Parameters<typeof createCFHeadRuntime>[0], ownerUserId);
    return this._cfHeadRuntime;
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
        content: uiMessageText(r.content),
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
    // The agent's durable context is `getSystemPrompt()` (soul + tools + the
    // agent_facts world model) plus the persisted conversation — a single
    // source of truth, not Think's freezable context blocks. The only Session
    // policy we attach is compaction: the chat window compacts at ~85% of the
    // active model's context window (≈15% headroom for the streaming response),
    // and a registered summarizer turns the middle of the transcript into a
    // summary overlay instead of dropping messages (hermes head/tail protection).
    const threshold = compactionThreshold(this.getStoredModelId() ?? "");
    return session
      .compactAfter(threshold)
      .onCompaction(this.summarizeForCompaction());
  }

  /** Hermes-style compaction fn: summarizes the middle of an over-long
   *  transcript via the agent's own model, protecting head + recent tail. */
  private summarizeForCompaction() {
    return createCompactFunction({
      summarize: (prompt) =>
        generateText({ model: this.getModel(), prompt }).then((r) => r.text),
    });
  }

  // ── Think lifecycle hooks ──────────────────────────────────────

  // Tools the model is allowed to call. Think merges workspace tools (read, write,
  // edit, list, find, grep, delete) with ours, bloating the request by ~2800 tokens.
  // activeTools restricts the model to the built-in tools + session context tools,
  // preventing Think's workspace tools from being sent in the request payload.
  // ACTIVE_TOOLS is sourced from @proteus/core/tools/registry (single truth).
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
  // programmatic turn via host.enqueueTurn → saveMessages). Callers below use
  // `this.orch.drainPendingEvents()`.

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    this.acc.reset(Date.now());
    this._executorsUsedThisTurn.clear();
    this._cliCwd = readCliCwd(ctx.body);
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
        turnIndex: this.orch.sessionTurnIndex,
      });
    } catch (err) {
      console.warn('[proteus] event emit failed at beforeTurn:', err);
    }

    // ── Skills resolution for this turn ──────────────────────────
    // Reset per-turn invocation set (don't reassign — closures from the
    // skills tool hold a stable reference).
    this._turnInvokedSkills.clear();
    this._turnActiveSkills = null;
    const activeTools: BuiltinToolName[] = [...ACTIVE_TOOLS];
    let activeSetForPrompt: ActiveSkillSet | undefined;
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
          activeSetForPrompt = activeSet;
          // Mirror the resolved explicit set onto the turn-invoked tracker so
          // skills.list reflects what's active right now.
          for (const r of activeSet.reasons) this._turnInvokedSkills.add(r.name);

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
            activeTools.push(...(filtered as BuiltinToolName[]));
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
    if (activeSetForPrompt || mcpToolNames.length > 0) {
      const execs = this.rt.executionRouter?.listExecutors() ?? [];
      const modelId = this.getStoredModelId();
      systemOverride = buildSystemPromptSync(this.rt, {
        executors: execs,
        availableTools: activeTools,
        ...(activeSetForPrompt ? { activeSkills: activeSetForPrompt } : {}),
        externalTools: mcpToolNames.map((name) => ({ name, source: 'mcp' as const })),
        backend: 'cf',
        model: { id: modelId ?? undefined },
      });
      // Same recent-facts tail getSystemPrompt appends (single source).
      systemOverride = systemOverride + this.factsTail();
    }

    const cfg: TurnConfig = { activeTools: effectiveActiveTools };
    if (systemOverride) cfg.system = systemOverride;
    if (this._cliCwd) cfg.messages = withCliCwdContext(ctx.messages, this._cliCwd);
    if (effectiveTools) cfg.tools = effectiveTools;
    return cfg;
  }

  onChunk(_ctx: ChunkContext): void {
    this.acc.onFirstChunk();
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    // Think 0.4 shape (toolName/input/output/success/durationMs) → the core
    // accumulator records it + fires the activity log + run-event sinks.
    this.acc.recordToolCall(ctx as unknown as Parameters<TurnAccumulator['recordToolCall']>[0]);
  }

  onStepFinish(ctx: StepContext): void {
    this.acc.recordStep(ctx as unknown as StepLike);
  }

  async onChatResponse(result: ChatResponseResult) {
    this.logActivity("response_complete", result.status);
    // Clear the in-flight flag once the turn is durably completed — forkAgent
    // is allowed again from here forward. Evolution (engine.onTurnCompleteAsync)
    // runs fire-and-forget below and does NOT extend the busy window.
    this._inFlight = false;
    this._cliCwd = null;
    // Emit turn_end + run_end into the durable event log.
    try {
      if (this._currentRunId) {
        this.eventRecorder.emit(this._currentRunId, {
          type: 'turn_end',
          turnIndex: this.orch.sessionTurnIndex,
          tokenUsage: { input: this.acc.usage.input, output: this.acc.usage.output, cached: this.acc.usage.cached },
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
    // after the turn completes — so turn.feedback stays null here and the
    // heuristic in assessTurnQuality scores the turn at completion time.
    const msgId = (result.message as { id?: string } | null | undefined)?.id;
    if (msgId) {
      const craftNames = this.acc.toolCalls
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
      toolCalls: this.acc.toolCalls,
      steps: this.acc.stepCount,
      durationMs: this.acc.startedAt > 0 ? Date.now() - this.acc.startedAt : 0,
      feedback: null,
      // status is "completed" here (the !== "completed" early-return above),
      // so turn errors are tracked via the accumulator's per-step hadError flag.
      hadError: this.acc.hadError,
    };

    // CRITICAL: Evolution hooks make LLM calls (reflection, extraction, session
    // reflection) that take 5-30 seconds each. onChatResponse runs INSIDE
    // Think's TurnQueue — if we await here, the queue is blocked and the next
    // message can't start processing until evolution finishes. The user sees
    // "nothing happens" for the second message.
    //
    // Fix: fire evolution asynchronously. The DO stays alive via keepAliveWhile
    // in the outer scope. Errors are caught and logged, never propagated.
    //
    // The core AgentOrchestrator owns the shared cadence: advance the
    // session-reflection counter (firing engine.onSessionComplete every N turns)
    // + fire turn-level evolution (engine.onTurnCompleteAsync — Hermes-style
    // reflection: quality/threshold, generateTurnReflection → MEMORY.md lesson,
    // pattern extraction → crafted tools, periodic scaffold evolution). All
    // fire-and-forget; never blocks the TurnQueue.
    this.orch.recordTurn(turn);

    // Auto-judge shadow evaluation. When a pending scaffold exists,
    // sample-and-run (default 25%) the pending against this turn's task,
    // ask a judge LLM to compare, record. When minTrials is reached AND
    // agent_config.auto_promote_scaffold='true', auto-apply the decision.
    void this.runShadowEvalSampled(userText, assistantText);

    // Sleep-time compute — between-turn background memory compression.
    // Reads recent turn, asks a judge to upsert/decay the agent_facts world
    // model. Letta-style; ~50% test-time token reduction reported. Gated by
    // agent_config.sleep_time_compute='true' (default off).
    void this.runSleepTimeCompute(userText, assistantText, this.acc.toolCalls);

    // On the first turn, replace the creation-time slug with a concise
    // AI-generated session title. Fire-and-forget; once-only (name_origin gate).
    void this.maybeGenerateTitle(userText);

    // Persist /workspace to R2 if the agent used the sandbox this turn — so the
    // work survives the container sleeping. Debounced + fire-and-forget.
    this.backupWorkspaceIfDue();

    // Trace-driven continuous self-optimization (when enabled): run GEPA once
    // enough new turns have accrued. Fire-and-forget; no-op when disabled.
    this.maybeRunAutoGepa();

    // Reactor drain-then-stop: handle any external events still pending (arrived
    // during this turn, or queued before a chat turn). No-op when none — so this
    // self-terminates once the external event backlog is empty.
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
        `[proteus] sleep-time-compute: upserted=${summary.upserted} decayed=${summary.decayed} skipped=${summary.skipped}`,
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

      const judge: StructuredJudgeFn = async (prompt) =>
        generateJson({
          model: this.getModelForReview(),
          schema: JudgeOutputSchema,
          prompt,
          maxOutputTokens: 512,
          providerOptions: effortFor('judge').providerOptions,
        });

      const judgeTask = task.slice(0, 2000);
      const result = await runAutoShadowEval({
        rt: this.rt,
        task: judgeTask,
        currentOutput: currentOutput.slice(0, 4000),
        judge,
        llmStream: this.makeScaffoldLLMStream(),
        // Pass the same tool dispatcher the production chat path uses, so the
        // pending scaffold runs with the real tool surface, not the disabled
        // tool-call fallback that would penalize any tool-using pending.
        callTool: this.makeScaffoldCallTool(),
        // host.defaultInference for the pending: run the standard inference for
        // the shadow task so a pending that delegates to the default loop is
        // judged fairly (its output ≈ current's, → tie, → not promoted).
        defaultInference: () => streamText({
          model: this.getModel(),
          messages: [{ role: 'user', content: judgeTask }],
          tools: this.getRawTools(),
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

  /** Once, on the first turn, replace the creation-time slug with a concise
   *  AI-generated title derived from the opening request. Skipped if the user
   *  named the agent (name_origin='user') or it's already auto-titled. */
  private async maybeGenerateTitle(userText: string): Promise<void> {
    try {
      if (this.config.getNameOrigin() !== null) return; // already user- or auto-named
      // Show a deterministic provisional title instantly (header parity with the
      // roster), then replace it with the AI title below. name_origin stays
      // unset so this retries the AI step on the next turn if generation fails.
      if (!this.config.getDisplayName()) {
        const provisional = deriveAgentTitle(userText);
        if (provisional) await this.propagateDisplayName(provisional);
      }
      const prompt =
        `Generate a concise 3–6 word title (Title Case, no quotes, no trailing ` +
        `punctuation) for a session that opens with this request:\n\n` +
        `"${userText.slice(0, 600)}"\n\nReply with ONLY the title.`;
      const { text } = await generateText({
        model: this.getModelForReview(), prompt, maxOutputTokens: 24,
        ...effortFor('judge'),
      });
      const title = text.trim().replace(/^["'#\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 60);
      if (title.length >= 2) {
        await this.propagateDisplayName(title);
        this.config.setNameOrigin('auto');
        console.log(`[proteus] auto-titled agent → "${title}"`);
      }
    } catch (err) {
      console.warn('[proteus] title generation failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Push a display name to all three homes: agent_config (source of truth),
   *  the owner's roster row (the Sidebar), and a live broadcast to open clients.
   *  Does NOT set name_origin — the caller decides whether this locks
   *  auto-titling (a provisional title leaves it open; user/auto titles set it). */
  private async propagateDisplayName(displayName: string): Promise<void> {
    this.config.setDisplayName(displayName);
    const userId = this.getOwnerUserId();
    if (userId) {
      try {
        const stub = this.env.UserDO.get(this.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
        await stub.setAgentDisplayName(this.name, displayName);
      } catch (err) {
        console.warn('[proteus] propagateDisplayName roster sync failed:', err instanceof Error ? err.message : err);
      }
    }
    try { this.broadcast(JSON.stringify({ type: 'agent_renamed', displayName })); } catch { /* nop */ }
  }

  // ── Background jobs (#173) — auto-detach >30s tool calls, wake on completion ──
  // Lifecycle (detach → settle → wake + cancel + recover) lives in the core
  // BackgroundJobRunner (this.jobRunner); the @callable control plane below is
  // the cf adapter over it + the BackgroundJobStore.

  /** Read a background job's result (the synthesis turn calls this). */
  @callable()
  async jobResult(jobId: string): Promise<BackgroundJob | null> {
    try { return this.jobs.get(jobId); } catch { return null; }
  }

  /** List recent background jobs (newest first). */
  @callable()
  async listBackgroundJobs(limit: number = 20): Promise<BackgroundJob[]> {
    try { return this.jobs.list(limit); } catch { return []; }
  }

  /** Hard-cancel a running background job: abort the underlying work (its merged
   *  AbortSignal) and mark it cancelled. The detach fiber sees 'cancelled' and
   *  won't relabel the abort rejection or wake the agent. */
  @callable()
  async cancelBackgroundJob(jobId: string): Promise<{ ok: boolean }> {
    return { ok: this.jobRunner.cancel(jobId) };
  }

  /** Re-run a settled job's tool with its original input as a fresh background
   *  job. Detaches immediately (the work already proved slow). */
  @callable()
  async retryBackgroundJob(jobId: string): Promise<{ ok: boolean; jobId?: string; error?: string }> {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: 'job not found' };
    if (job.status === 'running') return { ok: false, error: 'job still running' };
    const inputJson = this.jobs.getInput(jobId);
    if (inputJson == null) return { ok: false, error: 'no stored input to retry' };
    const tool = this.getRawTools()[job.kind];
    if (!tool || typeof tool.execute !== 'function') return { ok: false, error: `tool "${job.kind}" unavailable` };
    let input: unknown;
    try { input = JSON.parse(inputJson); } catch { return { ok: false, error: 'stored input is unreadable' }; }
    const controller = new AbortController();
    const newId = this.jobRunner.create(job.kind, input, controller);
    this.logActivity('bg_job_retry', `${jobId} → ${newId}`);
    const promise = Promise.resolve(
      (tool.execute as (i: unknown, o: unknown) => unknown)(input, { abortSignal: controller.signal, toolCallId: newId, messages: [] }),
    );
    this.jobRunner.detach(newId, job.kind, promise);
    return { ok: true, jobId: newId };
  }

  /** Remove a settled job from the registry (UI dismiss). */
  @callable()
  async dismissBackgroundJob(jobId: string): Promise<{ ok: boolean }> {
    try { this.jobs.dismiss(jobId); return { ok: true }; } catch { return { ok: false }; }
  }

  /** Clear all settled jobs (keep running ones). */
  @callable()
  async clearBackgroundJobs(): Promise<{ ok: boolean }> {
    try { this.jobs.clearSettled(); return { ok: true }; } catch { return { ok: false }; }
  }

  /** Stop visible work: abort foreground tool calls and cancel detached jobs. */
  @callable()
  async cancelCurrentWork(): Promise<{ ok: boolean; cancelledJobs: string[]; abortedTools: number }> {
    const cancelledJobs = this.jobRunner.cancelRunning();
    let abortedTools = 0;
    for (const controller of [...this._activeToolControllers]) {
      if (!controller.signal.aborted) {
        try { controller.abort(new Error('cancelled by operator')); } catch { /* nop */ }
        abortedTools++;
      }
      this._activeToolControllers.delete(controller);
    }
    this._inFlight = false;
    this.logActivity('work_cancelled', `${abortedTools} foreground, ${cancelledJobs.length} background`);
    try {
      this.broadcast(JSON.stringify({
        type: 'work_cancelled',
        cancelledJobs,
        abortedTools,
        timestamp: Date.now(),
      }));
    } catch { /* nop */ }
    return { ok: true, cancelledJobs, abortedTools };
  }

  // ── Device consent (P2) — ask-once-then-remember ─────────────────────
  // The UserDO (device hub) calls awaitDeviceConsent when this agent touches a
  // device with no remembered policy. We raise a card in the chat (broadcast +
  // listPendingConsents for reload) and await the user's decision via the
  // resolveDeviceConsent RPC. "Always" is persisted on the hub, not here.
  private readonly _pendingConsents = new Map<string, {
    resolve: (d: 'once' | 'always' | 'deny') => void;
    deviceLabel: string; method: string; command: string; scope: string; createdAt: number;
  }>();

  /** Called by the UserDO over a DO-to-DO RPC. Resolves when the user decides
   *  (or denies after 5 min so a device call never hangs forever). */
  async awaitDeviceConsent(req: {
    deviceId: string;
    deviceLabel: string;
    method: string;
    command: string;
    scope: string;
  }): Promise<'once' | 'always' | 'deny'> {
    const consentId = `cons-${nanoid(10)}`;
    this.logActivity('device_consent_requested', `${req.deviceLabel}: ${req.command.slice(0, 80)}`);
    try {
      this.broadcast(JSON.stringify({
        type: 'device_consent', consentId, deviceId: req.deviceId,
        deviceLabel: req.deviceLabel, method: req.method, command: req.command, scope: req.scope,
      }));
    } catch { /* nop */ }
    return new Promise<'once' | 'always' | 'deny'>((resolve) => {
      const timer = setTimeout(() => {
        if (this._pendingConsents.delete(consentId)) {
          try { this.broadcast(JSON.stringify({ type: 'device_consent_resolved', consentId })); } catch { /* nop */ }
          resolve('deny');
        }
      }, 5 * 60_000);
      this._pendingConsents.set(consentId, {
        resolve: (d) => { clearTimeout(timer); resolve(d); },
        deviceLabel: req.deviceLabel,
        method: req.method,
        command: req.command,
        scope: req.scope,
        createdAt: Date.now(),
      });
    });
  }

  /** The chat UI calls this when the user clicks a consent card button. */
  @callable()
  async resolveDeviceConsent(consentId: string, decision: 'once' | 'always' | 'deny'): Promise<{ ok: boolean }> {
    const p = this._pendingConsents.get(consentId);
    if (!p) return { ok: false };
    this._pendingConsents.delete(consentId);
    try { this.broadcast(JSON.stringify({ type: 'device_consent_resolved', consentId })); } catch { /* nop */ }
    p.resolve(decision === 'always' || decision === 'deny' ? decision : 'once');
    return { ok: true };
  }

  /** Pending consent requests — so the chat re-renders cards after a reload. */
  @callable()
  async listPendingConsents(): Promise<Array<{
    consentId: string;
    deviceLabel: string;
    method: string;
    command: string;
    scope: string;
    createdAt: number;
  }>> {
    return [...this._pendingConsents.entries()].map(([consentId, p]) => ({
      consentId,
      deviceLabel: p.deviceLabel,
      method: p.method,
      command: p.command,
      scope: p.scope,
      createdAt: p.createdAt,
    }));
  }

  /** Tools whose work can be long enough to auto-detach to the background. */
  private static readonly BACKGROUNDABLE_TOOLS: ReadonlySet<string> = new Set(['think', 'execute_tools', 'run']);

  /** Return a SHALLOW CLONE of the raw toolset with the long-running tools'
   *  execute wrapped in the 30s background threshold. Never mutates the cached
   *  raw toolset — so getRawTools() stays unwrapped for the eval side-streams. */
  private wrapToolsForBackground(raw: ToolSet): ToolSet {
    const wrapped: ToolSet = { ...raw };
    for (const key of OrchestratorAgent.BACKGROUNDABLE_TOOLS) {
      const orig = wrapped[key];
      const exec = orig?.execute;
      if (!orig || typeof exec !== 'function') continue;
      wrapped[key] = {
        ...orig,
        execute: (input, options) => {
          // Per-call AbortController so a hard-cancel aborts the underlying work.
          // Merge it with the turn's own signal so a turn abort still propagates.
          const controller = new AbortController();
          const turnSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const abortSignal = turnSignal ? combineAbortSignals([turnSignal, controller.signal]) : controller.signal;
          const deps = this.jobRunner.thresholdDeps(key, input, controller);
          this._activeToolControllers.add(controller);
          return withBackgroundThreshold(key, () => exec(input, { ...options, abortSignal }), deps)
            .finally(() => this._activeToolControllers.delete(controller));
        },
      };
    }
    return wrapped;
  }

  /** Model for review/judge tasks. Same resolution as chat — review LLM tracks
   *  the user's chosen model so quality assessments stay consistent. */
  private getModelForReview(): import('ai').LanguageModel {
    const reg = this.providerRegistry();
    return reg.resolveModel(reg.normalizeSpecSync(this.getStoredModelId()));
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
    initWebhookRateLimitTables(this.ctx.storage.sql);
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

    // Background-job registry — work auto-detached past the 30s threshold.
    initBackgroundJobsTable(execRaw);

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

    this._schemaReady = true;
  }

  async onStart() {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    this.ensureSchema();

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

      // Wake the agent to act on the freshly-published timer events (and any
      // other pending events) — an autonomous turn. Fire-and-forget.
      if (due.length > 0) void this.orch.drainPendingEvents();
    } catch (err) {
      console.error('[proteus] alarm handler failed:', (err as Error).message);
    }

    // Reschedule the next-soonest alarm.
    try {
      const all = this.triggerRegistry.list({ state: 'active' });
      const upcoming = all
        .map(t => t.next_fire_at)
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

  // ── Callable RPC methods ───────────────────────────────────────

  private getDisplayName(): string {
    return this.config.getDisplayName() ?? this.name;
  }

  @callable()
  async getProductChangeBoard(limit: number = 20) {
    return this.requireOwnerUserDO().getProductChangeBoard(this.name, limit);
  }

  @callable()
  async listProductSourceBindings() {
    return this.requireOwnerUserDO().listProductSourceBindings();
  }

  @callable()
  async upsertProductSourceBinding(input: ProductSourceBindingInput & { id?: string }) {
    return this.requireOwnerUserDO().upsertProductSourceBinding(input);
  }

  @callable()
  async createProductChange(input: { bindingId: string; userPrompt: string; plan?: string | null }) {
    return this.requireOwnerUserDO().createProductChange(this.name, input);
  }

  @callable()
  async updateProductChange(
    changeId: string,
    patch: { plan?: string | null; summary?: string | null; patch?: string | null; previewUrl?: string | null },
  ) {
    return this.requireOwnerUserDO().updateProductChange(changeId, patch);
  }

  @callable()
  async transitionProductChange(changeId: string, status: ProductChangeStatus) {
    return this.requireOwnerUserDO().transitionProductChange(changeId, status);
  }

  @callable()
  async recordProductChangeCheck(
    changeId: string,
    input: { name: string; status: ProductChangeCheck['status']; stdout?: string | null; stderr?: string | null; durationMs?: number | null },
  ) {
    return this.requireOwnerUserDO().recordProductChangeCheck(changeId, input);
  }

  @callable()
  async requestProductChangeApproval(changeId: string, approvalType: ProductChangeApproval['approvalType']) {
    return this.requireOwnerUserDO().requestProductChangeApproval(changeId, approvalType);
  }

  @callable()
  async decideProductChangeApproval(approvalId: string, decision: 'approved' | 'rejected', note?: string | null) {
    const userDO = this.requireOwnerUserDO();
    const decided = await userDO.decideProductChangeApproval(approvalId, decision, this.getOwnerUserId() ?? this.name, note);
    if (decision === 'rejected') {
      try { await userDO.transitionProductChange(decided.changeId, 'rejected'); } catch { /* already terminal or stale */ }
    }
    return decided;
  }

  @callable()
  async recordProductDeployment(
    changeId: string,
    input: { environment: ProductDeploymentRecord['environment']; workerVersionId?: string | null; deploymentId?: string | null; rollbackTarget?: string | null },
  ) {
    return this.requireOwnerUserDO().recordProductDeployment(changeId, input);
  }

  @callable()
  async getAgentStatus() {
    try {
      const soul = readSoul(this.boundSql) ?? "";
      const purpose = summarizeSoul(soul);
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
        soul,
        createdAt: identity[0]?.created_at ?? 0,
        scaffoldVersion: scaffoldVersion[0]?.v ?? 0,
        searchNodeCount: searchNodes[0]?.c ?? 0,
        craftedToolCount: craftedTools[0]?.c ?? 0,
        messageCount,
        model: this.getStoredModelId(),
        forkLineage,
      };
    } catch {
      return { id: this.ctx.id.toString(), name: this.name, displayName: this.name, purpose: "", soul: "", createdAt: 0,
        scaffoldVersion: 0, searchNodeCount: 0, craftedToolCount: 0, messageCount: 0,
        model: this.getStoredModelId(),
        forkLineage: null };
    }
  }

  @callable()
  async getChatHistory(limit = 100): Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string | number }>> {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    try {
      const rows = this.sql<{ id: string; role: string; content: string; created_at: string }>`
        SELECT id, role, content, created_at
        FROM (
          SELECT id, role, content, created_at
          FROM assistant_messages
          WHERE role IN ('user', 'assistant', 'system')
          ORDER BY created_at DESC
          LIMIT ${bounded}
        ) sub
        ORDER BY created_at ASC
      `;
      return rows.flatMap((row) => {
        const role = normalizeUiRole(row.role);
        if (!role) return [];
        return [{ id: row.id, role, content: uiMessageText(row.content), createdAt: row.created_at }];
      });
    } catch {
      const rows = this.sql<{ id: string; role: string; content: string; created_at: number }>`
        SELECT id, role, content, created_at
        FROM messages
        WHERE session_id = ${'default'} AND role IN ('user', 'assistant', 'system')
        ORDER BY created_at ASC
        LIMIT ${bounded}
      `;
      return rows.flatMap((row) => {
        const role = normalizeUiRole(row.role);
        if (!role) return [];
        return [{ id: row.id, role, content: row.content, createdAt: row.created_at }];
      });
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
    return this.sql`SELECT id, parent_id, depth, visits, value, status, action, task, observation, code_used, branch_agent_key, msg_id, created_at
      FROM search_nodes ORDER BY depth, created_at`;
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
    // 4) Background jobs — auto-detached >30s tool calls, as first-class spans
    // (the run that "ended" because work moved to the background must say so).
    try {
      for (const j of this.jobs.list(limit)) {
        const detail = j.status === 'running' ? 'running in background'
          : j.error ? `${j.status}: ${j.error}` : j.status;
        spans.push({
          ts: j.createdAt, kind: 'background',
          label: `Background ${j.kind}`, detail,
          source: 'background', refId: j.id, rawType: j.status,
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
      // Background-job fiber (bg:*) is operational plumbing, not an evolution
      // event: the runner re-fails + wakes an orphaned 'running' job (a 'settled'
      // one already recorded its outcome + woke), skipping the MEMORY.md note +
      // evolution_events INSERT that the user-facing recovery path emits.
      if (ctx.name.startsWith('bg:')) {
        await this.jobRunner.recover(ctx.snapshot);
        return;
      }
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
        const obj = await generateJson({
          model,
          schema: v.object({
            score: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
            feedback: v.pipe(v.string(), v.minLength(1)),
          }),
          prompt:
            `Rate this agent response to the task on a 0..1 scale (correctness, ` +
            `helpfulness, clarity) and give one sentence of specific, actionable ` +
            `feedback on how the agent's behaviour could improve.\n\n` +
            `Task:\n${instance.input}\n\nResponse:\n${output.slice(0, 4000)}\n\n` +
            `JSON shape: {"score": <number 0..1>, "feedback": "<one sentence>"}.`,
          providerOptions: effortFor('judge').providerOptions,
        });
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

  /**
   * General per-executor change-set. The agent VFS ("workspace") has no shell,
   * so it uses the snapshot baseline (computeWorkspaceDiff). Shell executors
   * (sandbox/laptop/nimbus) use a real `git diff` of /workspace — the only way
   * to capture changes the agent made inside a container (feedback: the diff
   * didn't reflect sandbox repo changes). `git add -A -N` first so newly-created
   * (untracked) files show as additions; it stages intent-to-add only (no
   * content), respects .gitignore, and is cleared by the agent's next commit.
   */
  @callable()
  async getExecutorDiff(executorId: string): Promise<{
    files: FileDiff[]; mode: 'git' | 'vfs-baseline';
    baselineJustCaptured?: boolean; notGitRepo?: boolean; error?: string;
  }> {
    if (executorId === 'workspace') {
      const r = await this.getWorkspaceDiff();
      return { files: r.files, mode: 'vfs-baseline', baselineJustCaptured: r.baselineJustCaptured };
    }
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { files: [], mode: 'git', error: `Executor "${executorId}" not found` };
    const execTool = provider.tools.exec;
    if (!execTool) return { files: [], mode: 'git', error: `Executor "${executorId}" has no exec tool` };
    const root = '/workspace';
    try {
      const isRepo = String(await execTool.execute(`git -C ${root} rev-parse --is-inside-work-tree 2>/dev/null || echo no`));
      if (!isRepo.includes('true')) return { files: [], mode: 'git', notGitRepo: true };
      const raw = String(await execTool.execute(`git -C ${root} add -A -N >/dev/null 2>&1; git -C ${root} --no-pager diff`));
      return { files: parseGitDiff(raw), mode: 'git' };
    } catch (err) {
      return { files: [], mode: 'git', error: err instanceof Error ? err.message : String(err) };
    }
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

  /** Recent branching-head runs (think strategy=heads): each split grouped by
   *  root_id with its heads (incl. the ordered per-head step trace) + the merged
   *  synthesis — drives the Reasoning surface's Branches strip. */
  @callable()
  async getHeadRuns(limit: number = 20): Promise<HeadRunView[]> {
    try { return this.headJournal.listRuns(limit); } catch { return []; }
  }

  // ── Head shared scratch — the common findings space for a split ──────
  // Heads keep a PRIVATE per-facet sandbox VFS, but write shared findings here:
  // the orchestrator's own workspace VFS under shared/findings/, namespaced by
  // head so siblings can't clobber each other. The main agent reads them through
  // plain `workspace.readFile('shared/findings/...')`. Reached via RPC because
  // each head is a separate Durable Object.
  private static readonly SHARED_FINDINGS_ROOT = 'shared/findings';

  /** Strip leading slashes + path-traversal segments from a head-supplied path. */
  private sanitizeSharedPath(rel: string): string {
    return rel.replace(/^\/+/, '').split('/').filter((s) => s && s !== '..' && s !== '.').join('/');
  }

  /** A head writes a finding; namespaced under its headId so writes never collide. */
  @callable()
  async sharedScratchWrite(headId: string, relPath: string, content: string): Promise<{ ok: boolean; path: string }> {
    const ns = (headId || 'head').replace(/[^a-zA-Z0-9_-]/g, '_');
    const rel = this.sanitizeSharedPath(relPath) || 'note.md';
    const path = `${OrchestratorAgent.SHARED_FINDINGS_ROOT}/${ns}/${rel}`;
    const vfs = this.rt.storage.vfs;
    const dir = path.split('/').slice(0, -1).join('/');
    try { await vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
    await vfs.writeFile(path, content);
    return { ok: true, path };
  }

  /** Read any head's finding by path relative to shared/findings/. */
  @callable()
  async sharedScratchRead(relPath: string): Promise<string | null> {
    const rel = this.sanitizeSharedPath(relPath);
    if (!rel) return null;
    const root = OrchestratorAgent.SHARED_FINDINGS_ROOT;
    const path = rel.startsWith(`${root}/`) ? rel : `${root}/${rel}`;
    try {
      const c = await this.rt.storage.vfs.readFile(path, { encoding: 'utf8' });
      return typeof c === 'string' ? c : new TextDecoder().decode(c);
    } catch { return null; }
  }

  /** List every finding in the shared scratch (paths relative to its root). */
  @callable()
  async sharedScratchList(): Promise<string[]> {
    const vfs = this.rt.storage.vfs;
    const root = OrchestratorAgent.SHARED_FINDINGS_ROOT;
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      let names: string[];
      try { names = await vfs.readdir(dir); } catch { return; }
      for (const name of names) {
        const full = `${dir}/${name}`;
        let isDir = false;
        try { isDir = !!(await vfs.stat(full))?.isDir; } catch { /* treat as file */ }
        if (isDir) await walk(full, depth + 1);
        else out.push(full.slice(root.length + 1));
      }
    };
    await walk(root, 0);
    return out;
  }

  /** Tear down every per-agent resource, then wipe this Durable Object. Called
   *  by UserDO.removeAgent on delete so a same-name recreate starts clean and no
   *  orphaned alarm / container / triggers linger. Best-effort on the sandbox;
   *  the DO wipe (storage + alarm) always runs. */
  @callable()
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
        tools: this.getRawTools(),
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
    status: string | null; tokensIn: number; tokensOut: number; tokensCached: number; eventCount: number;
  }>> {
    return this.eventRecorder.listRuns(limit).map((run) => {
      let tokensIn = 0, tokensOut = 0, tokensCached = 0;
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
            tokensCached += e.tokenUsage.cached ?? 0;
          } else if (e.type === 'run_end') {
            status = e.reason ?? null;
          }
        }
      } catch { /* run events unreadable — return the bare summary */ }
      return { runId: run.runId, startedAt, causedBy, userMessage, status, tokensIn, tokensOut, tokensCached, eventCount: run.eventCount };
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
      const all = orchestrator.getRawTools();
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
      const tools = orchestrator.getRawTools();
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
    const tools = this.getRawTools();
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
    await this.propagateDisplayName(displayName);
    this.config.setNameOrigin('user'); // locks auto-titling — the operator named it
    return { displayName };
  }

  @callable() async setAutoDisplayName(displayName: string) {
    await this.propagateDisplayName(displayName);
    this.config.setNameOrigin('auto');
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

  /** Typed directory listing for the file manager. Workspace is read straight
   *  off the VFS (accurate types + sizes); other executors' heterogeneous
   *  `readdir` output is normalized via parseReaddirEntries. */
  @callable() async getExecutorFiles(executorId: string, path: string): Promise<{ entries?: DirEntry[]; error?: string }> {
    const dir = path || '/';
    if (executorId === 'workspace') {
      try {
        const names = await this.rt.storage.vfs.readdir(dir);
        const entries: DirEntry[] = [];
        for (const name of names) {
          const full = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
          let type: DirEntry['type'] = 'file';
          let size: number | undefined;
          try { const s = await this.rt.storage.vfs.stat(full); if (s) { type = s.isDir ? 'dir' : 'file'; size = s.size; } } catch { /* unstattable — leave as file */ }
          entries.push({ name, type, size });
        }
        return { entries: sortDirEntries(entries) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { error: `Executor "${executorId}" not found` };
    const readdirTool = provider.tools.readdir;
    if (!readdirTool) return { error: `Executor "${executorId}" has no readdir tool` };
    try {
      const result = await readdirTool.execute(dir);
      return { entries: parseReaddirEntries(result) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read a single file's text content for the file-manager viewer. Workspace
   *  reads off the VFS; other executors via their readFile tool. Caps size and
   *  refuses binary (NUL byte). */
  @callable() async readExecutorFile(executorId: string, path: string): Promise<{ content?: string; truncated?: boolean; error?: string }> {
    if (!path) return { error: 'path required' };
    const MAX = 512 * 1024;
    try {
      let text: string;
      if (executorId === 'workspace') {
        const stat = await this.rt.storage.vfs.stat(path);
        if (stat?.isDir) return { error: 'path is a directory' };
        const raw = await this.rt.storage.vfs.readFile(path, { encoding: 'utf8' });
        text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      } else {
        const provider = this.rt.executionRouter?.getProvider(executorId);
        if (!provider) return { error: `Executor "${executorId}" not found` };
        const readFileTool = provider.tools.readFile;
        if (!readFileTool) return { error: `Executor "${executorId}" has no readFile tool` };
        const raw = await readFileTool.execute(path);
        text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      }
      if (text.includes(String.fromCharCode(0))) return { error: 'binary file — not previewable' };
      if (text.length > MAX) return { content: text.slice(0, MAX), truncated: true };
      return { content: text };
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

  /** Worker fan-out target (user/agent-access notifyAgentsCredentialsChanged):
   *  invoked after credential mutations in UserDO so cached provider/model
   *  state in this agent is dropped. Cheap; no-op if nothing is cached. */
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

  @callable() async setSoul(soul: string) {
    const text = soul.trim();
    if (!text) throw new Error('SOUL.md cannot be empty.');
    writeSoul(this.boundSql, text);
    // Invalidate the cached SOUL.md + system prompt so the next turn
    // picks up the new identity.
    this._cachedSoulText = null;
    this._cachedSystemPrompt = null;
    this._cachedSystemPromptKey = '';
    return { soul: text, purpose: summarizeSoul(text) };
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
      const nodes = this.sql`SELECT id, parent_id, depth, visits, value, status, action, task, observation, code_used, branch_agent_key, msg_id, created_at
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
   *   - SOUL.md copied, messages 0..N copied, crafted tools snapshotted,
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
      // A bare getAgentStatus call on a fresh DO may create agent_identity,
      // but it does not seed SOUL.md. Existing agents have either chat history
      // or a SOUL.md file written by the creation path.
      const status = await (forkStubForPrecheck as unknown as { getAgentStatus(): Promise<{ messageCount: number; soul: string; name: string }> }).getAgentStatus();
      if (status.messageCount > 0 || status.soul.length > 0) {
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
    // Apply the FULL schema before copying rows. onStart runs on first access,
    // but this RPC can be invoked before it completes — ensureSchema creates
    // every table (not just initAllTables') so forkAgentStorage's copy of
    // events-hub/heads/shadow/etc. rows never hits a missing table.
    this.ensureSchema();

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
      FROM vfs_files WHERE path = ${SOUL_PATH} OR path LIKE 'memory/%' OR (path = 'memory' AND is_dir = 1)
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
        next_fire_at: t.next_fire_at,
        last_fire_at: t.last_fire_at,
        fire_count: t.fire_count,
      })),
    };
  }

  /** Create a durable webhook trigger. Returns the public URL.
   *
   *  Deliberately NOT @callable: webhook creation is step-up gated, and the
   *  gate (auth/session isFreshAuthTime) lives in the only two entry points —
   *  the web route POST /api/agents/<name>/triggers and the CLI route
   *  POST /api/cli/agents/<name>/triggers/webhook. Exposing this over the
   *  WebSocket RPC surface would bypass that gate. */
  async createDurableWebhook(opts: {
    label: string;
    auth_mode: 'hmac' | 'bearer' | 'mtls';
    secret?: string;
    accepted_content_type?: string;
    rate_limit_per_min?: number;
  }) {
    const rateLimit = normalizeWebhookRateLimitPerMin(opts.rate_limit_per_min);
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
      rate_limit_per_min: rateLimit,
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

  /**
   * Register a timer trigger — `timer_cron` (recurring, from a cron expr) or
   * `timer_oneshot` (a single future fire at `atMs`). Shared by the agent's
   * `agent.schedule` tool and the auto-GEPA scheduler, so trigger creation has
   * one home (not inlined SQL). When it fires, alarm() publishes a timer event
   * and the reactor wakes the agent. `trust` defaults to 'authenticated' so
   * agent-created schedules are distinguishable from operator ones.
   */
  createTimerTrigger(opts: {
    cron?: string;
    atMs?: number;
    label?: string;
    payload?: Record<string, unknown>;
    trust?: 'authenticated' | 'owner';
	  }): { id: string; kind: 'timer_cron' | 'timer_oneshot'; nextFireAt: number | null } {
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

  /**
   * Enable/disable continuous self-optimization. Auto-GEPA is TRACE-driven, not
   * clock-driven: it runs after `everyNTurns` turns of new execution history
   * accrue (gated on no pending scaffold), so it fires when there's genuinely
   * new material to learn from and pauses automatically when the agent is idle —
   * a wall-clock cron would waste passes on identical eval sets. 0/null disables.
   * Operator-gated; pairs with `auto_promote_scaffold` for a fully-autonomous
   * improve→shadow-eval→promote/rollback cycle.
   */
  @callable()
  async setAutoGepa(everyNTurns: number | null): Promise<{ ok: true; everyNTurns: number }> {
    // Clean up any trigger from the prior cron-based design.
    const prev = this.config.get('auto_gepa_trigger_id');
    if (prev) { this.triggerRegistry.revoke(prev, Date.now()); this.config.delete('auto_gepa_trigger_id'); }
    this.config.delete('auto_gepa_cron');
    this.config.setAutoGepaEveryNTurns(everyNTurns ?? 0);
    this._turnsSinceGepa = 0;
    return { ok: true, everyNTurns: this.config.getAutoGepaEveryNTurns() };
  }

  /** Current auto-GEPA cadence (turns of new traces between passes; 0 = off). */
  @callable()
  async getAutoGepa(): Promise<{ everyNTurns: number }> {
    return { everyNTurns: this.config.getAutoGepaEveryNTurns() };
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

    const rate = tryConsumeWebhookRateLimit(this.ctx.storage.sql, opts.trigger_id, trigger.rate_limit_per_min, opts.now);
    if (!rate.allowed) {
      return {
        status: 'rejected',
        http_status: 429,
        reason: `rate limit exceeded (${rate.limit}/min)`,
      };
    }

    // Parse body.
    let parsedBody: unknown;
    try {
      parsedBody = receivedCT.includes('json') ? JSON.parse(opts.body_text) : opts.body_text;
    } catch { parsedBody = opts.body_text; }

    const delivery_id = opts.delivery_id ?? `${opts.now}-${Math.random().toString(36).slice(2, 10)}`;

	    // Open a reply channel for the event system. HTTP delivery itself returns
	    // 202 immediately; a future held-response path can wait on this channel
	    // without changing the durable event shape.
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

    // Wake the agent to act on the new webhook event — an autonomous turn.
    // Only when newly admitted (a duplicate is already bound or in flight).
    if (admitted) void this.orch.drainPendingEvents();

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

function uiMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { parts?: unknown };
    if (Array.isArray(parsed.parts)) {
      return parsed.parts
        .flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
        .join('');
    }
  } catch { /* plain text fallback */ }
  return content;
}

function normalizeUiRole(role: string): 'user' | 'assistant' | 'system' | null {
  return role === 'user' || role === 'assistant' || role === 'system' ? role : null;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (live.length === 1) return live[0];
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of live) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

