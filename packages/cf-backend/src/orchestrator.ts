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

import { callable, type AgentContext, type Connection, type ConnectionContext } from "agents";
import { CLI_SCOPES_HEADER, cliScopesConnectionTag, rejectOutOfScopeRpc } from "./cli/ws-rpc-gate.js";
import {
  createCompactionExtension, createVfsTranscriptStore,
  createCompactionStateStore, initCompactionStateTable,
  type CompactionStateStore, type Logger as CompactionLogger,
} from "@proteus/compaction";
import { getSandbox } from "@cloudflare/sandbox";
import { Think, Session } from "@cloudflare/think";
// preamble-injection pattern: we construct the codemode tool
// directly via createCodeTool + PreambleCraftedExecutor. The executor reads
// craftStore.list() on every call and splices a `const tools = {...}`
// preamble into the LLM's sandbox arrow, so mid-turn additions are visible
// on the next execute_tools call and tool bodies share lexical scope with
// workspace.*/codemode.* (see docs/CRAFT-ARCHITECTURE.md).
import { streamText, generateText, tool, jsonSchema, stepCountIs, convertToModelMessages } from "ai";
import type { LanguageModel, ModelMessage, SystemModelMessage, ToolSet } from "ai";
import * as v from "valibot";
import type { SerializableToolDescriptor } from "./user/mcp.js";
import type { TimelineSpan, DirEntry, WorkspaceAgent } from "./lib/protocol.js";
import { buildWorkspaceAgents, teamPeers } from "./lib/workspace-roster.js";
import { runEventToSpan, classifyEvolutionType, safeJsonParse } from "./lib/timeline.js";
import { nextAlarmTime, nextCronFire } from "./lib/cron.js";
import { contextWindowForModel, catalogContextWindow } from "./lib/context-window.js";
import { generateJson } from "./lib/generate-json.js";
import { diffLines, computeWorkspaceDiff, parseGitDiff, type DiffLine, type FileDiff } from "./lib/diff.js";
import { toCompositePath, sortDirEntries, writeExecutorFileOp, type ExecutorWriteResult } from "./lib/files.js";
import { deriveWorkspaceTitle } from "./lib/agent-naming.js";
import type {
  TurnContext, TurnConfig, ChatResponseResult,
  ToolCallResultContext, StepContext, ChunkContext, StreamableResult,
  PrepareStepContext, StepConfig,
  ToolCallContext as ThinkToolCallContext,
} from "@cloudflare/think";
import {
  EvolutionEngine,
  bootstrapScaffold,
  initAllTables, initSearchTables, initScaffoldTables, initCraftScoreTables,
  resolveMaxSteps,
  // canonical tool + prompt surface — single source of truth
  buildBuiltinTools,
  createDefaultWebSearchProvider, createWebCodemodeProvider, type WebSearchProvider,
  buildSystemPromptSync,
  currentDateForPrompt,
  EphemeralContextLedger, turnLocalContextMessage, fnv1a64,
  // Public extension seam — the SAME host contract runChat drives on the CLI
  ExtensionHost, composePrepareStep,
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
  forkWorkspaceStorage, readForkLineage,
  nanoid,
  // Branching heads
  HeadController, HeadJournal, initHeadsTables,
  type SerializedMessage, type SplitPhaseEvent, type HeadRunView, type HeadRuntime, type MergeResult,
  // Canonical memory-note write primitive
  appendMemoryNote,
  // Scaffold loop closure (scaffold-driven inference + shadow rollout)
  runScaffold, scaffoldInferenceTransform, scaffoldEventText, modifyScaffold, type ScaffoldRunResult,
  initShadowTables, getPendingScaffold, decidePromotion, applyPromotionDecision,
  listScaffoldArchive,
  readScaffoldVersion, readShadowVerdict, type ShadowVerdict, DEFAULT_SHADOW_CONFIG,
  // Auto-judge shadow eval — sampled per-turn shadow rollout closure
  runAutoShadowEval, JudgeOutputSchema, DEFAULT_AUTO_JUDGE_CONFIG,
  type StructuredJudgeFn, type JudgeOutput,
  // Durable run-event log
  initRunEventTables, RunEventRecorder,
  // R3 outcome ledger (schema + take_pick CHECK rebuild) — eager in ensureSchema
  initTurnOutcomeTables,
  type RunEvent, type RunEventQuery,
  // agent_facts world model
  initFactsTable, createFactsStore, renderFactsBlock, type FactsStore,
  // Per-turn device awareness (laptop runtime presence + change notice)
  observeDevicePresence,
  // Typed agent_config store
  createAgentConfigStore, DEFAULT_CONFIG, AGENT_CONFIG_KEYS,
  // Voyager curriculum + Absolute Zero learnability proposer
  initCurriculumTable, proposeNextTasks, listProposedTasks, updateProposedTaskStatus,
  // Hybrid search (FTS5 + Vectorize via RRF)
  hybridSearch, type HybridHit,
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
  // Turn-outcome signal + replay-eval loss curve (audit R3)
  buildOutcomeEvalSplit, listReplayEvals,
  type OutcomeEvalExpectation, type ReplayEvalSummary,
  // Evolution Changelog — the self-change digest + revert dispatch
  buildChangelog, countUnseenChangelog, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogRevertResult,
  // Alternate Takes — near-tied convergence candidates + the pick signal
  claimAlternateTakesForTurn, purgeUnclaimedAlternateTakes, listAlternateTakeSets, latestAlternateTakeSet,
  recordTakePick, recordHeadsTakeSet, buildTakeContinuationPrompt, getCurrentScaffoldVersion,
  type AlternateTakeSet, type TakePickOutcome,
  // Steer-as-Branch — a mid-turn redirect run as a parallel head
  initAlternateTakesTable, startBranchHead, settlePendingBranch, newBranchId,
  type PendingBranch, type BranchStatusEvent,
  type ProductChangeApproval, type ProductChangeCheck, type ProductChangeStatus,
  type ProductDeploymentRecord, type ProductChangeToolDeps, type ProductSourceBindingInput,
  // Product-change execution engine — the driver beneath the governance ledger
  ProductChangeEngine, createSandboxProductChangeExec,
  // Peer-agent teams (the `team` tool contract)
  type TeamToolDeps, type PeerSpawnOutcome, type PeerSendOutcome,
  type EnqueueTurnResult,
  readSoul, SOUL_PATH, summarizeSoul, writeSoul,
  parseModelSpec,
  // AGENTS.md (agents.md standard) — cloud workspace discovery
  collectWorkspaceAgentsMd,
  // Device shadow-git checkpoints (forwarded to the pc-agent daemon)
  isDeviceNotConnectedError,
  type CheckpointAvailability, type FileCheckpointEntry, type FileRestorePlan, type FileRestoreResult,
} from "@proteus/core";
import { combineAbortSignals } from "@proteus/agent-utils";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createCFRuntime, type CFRuntime } from "./runtime.js";
import { PreambleCraftedExecutor, selectInjectableCraftedTools } from "./crafted-tool-registry.js";
import { createCFHeadRuntime } from "./heads/head-runtime.js";
import { createAgentProviderRegistry, type AgentProviderRegistry } from "./providers/agent-registry.js";
import {
  agentAffinityKey,
  // Prompt-cache breakpoints — single source in core prompting/cache-breakpoints.ts
  resolvePromptCacheStrategy, cacheableSystem, promptCacheOptions,
  hasCacheMarkers, markLastToolForAnthropicCache, type PromptCacheStrategy,
} from "@proteus/core";
import { timingSafeEqual } from "./lib/crypto.js";
import { createRLMProvider } from "./rlm.js";
import { createAgentSelfProvider } from "./agent-self.js";
import type { UserDO } from "./user/user-do.js";
import { createCloudWorkspaceForUser } from "./user/workspace-create.js";
import { PeerHub, type PeerMessage, type ReceiveResult } from "./events/ingress/peer.js";
import {
  initWebhookRateLimitTables,
  normalizeWebhookRateLimitPerMin,
  tryConsumeWebhookRateLimit,
} from "./events/webhook-rate-limit.js";
import { acceptInboundEmail } from "./events/ingress/email.js";
import { agentEmailAddress, normalizeEmailAddress } from "./email/inbound.js";
import {
  createEmailThreadDispatcher, dispatchEmailRepliesForTurn, sendOwnerEmail,
} from "./email/outbound.js";

const SESSION_REFLECTION_INTERVAL = 5; // turns between session reflections

// Inbound-email budget per agent (all senders combined). Email is a wake
// channel, not a data plane — mail beyond this is dropped at the gate.
const EMAIL_INBOUND_RATE_PER_MIN = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Extract plain text from the last user message in a ModelMessage[]. Used
 *  by skills resolution to look for `/skill-name` invocations and keyword
 *  matches without needing to know the AI SDK content-part union shape.
 *  Deliberately text-only: file/image attachment parts are dropped here, but
 *  they still reach the model — the evolved-scaffold path hands this flattened
 *  text to the scaffold as `task` while `host.defaultInference()` streams the
 *  prepared turn with all parts intact (see _transformInferenceResult). */
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

/** One activity-log line per compaction engine event: message + compact JSON. */
function compactionLogDetail(message: string, data?: unknown): string {
  if (data === undefined) return message;
  try {
    return `${message} ${JSON.stringify(data)}`;
  } catch {
    return message;
  }
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
 * Build an ephemeral SqlExecutor that answers the queries forkWorkspaceStorage
 * makes against the source DB, using the serialized payload as the source
 * of truth. Only the exact SELECT shapes that forkWorkspaceStorage issues are
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
      if (query.startsWith("SELECT id, name FROM workspace_identity")) {
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

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Scoped `pta_…` access tokens reach this DO over ticket-authenticated
    // websockets, and the REST scope gate never sees websocket frames — so
    // out-of-scope @callable requests are rejected here, ahead of the
    // agents-SDK rpc dispatcher (installed as an own-property onMessage
    // wrapper by the Agent constructor, hence the re-wrap instead of an
    // onMessage override). Chat frames pass through untouched.
    const dispatchMessage = this.onMessage;
    this.onMessage = async (connection, message) => {
      const rejection = rejectOutOfScopeRpc(connection.tags, message);
      if (rejection) {
        connection.send(rejection);
        return;
      }
      return dispatchMessage.call(this, connection, message);
    };
    // Constructor body (not a field initializer): boundSql's memo field must
    // be initialized before the getter caches its closure.
    this.compactionState = createCompactionStateStore(this.boundSql);
    this.registerCompactionExtension();
  }

  /** Durable per-session compaction state (plan snapshot + the measured
   *  prompt-token trigger signal) in DO SQLite. Table created in ensureSchema. */
  private readonly compactionState: CompactionStateStore;

  /** Durable-history length (ModelMessage count) at the in-flight turn's
   *  assembly — the length the turn's prompt-token measurement is bound to. */
  private _turnDurableLength = 0;

  /** Better-compact is THE default (and only) compaction path: the staged
   *  pruning ladder runs as a transformContext extension once per turn
   *  assembly, replaying its persisted plan byte-stably until the context
   *  regrows. Registered unconditionally at construction; every port
   *  dereferences `this` lazily, so nothing heavy (the CF runtime, the model)
   *  is built before it is first needed. */
  private registerCompactionExtension(): void {
    const logger: CompactionLogger = {
      info: (message, data) => this.logActivity('compaction', compactionLogDetail(message, data)),
      debug: (message, data) => console.log(`[proteus:compaction] ${message}`, data ?? ''),
      warn: (message, data) => {
        console.warn(`[proteus:compaction] ${message}`, data ?? '');
        this.logActivity('compaction_warn', compactionLogDetail(message, data));
      },
      error: (message, data) => {
        console.error(`[proteus:compaction] ${message}`, data ?? '');
        this.logActivity('compaction_error', compactionLogDetail(message, data));
      },
    };
    this.extensions.register(createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => this.rt.storage.vfs),
        plans: this.compactionState.plans,
        logger,
      },
      summarize: (prompt) => generateText({ model: this.getModel(), prompt }).then((r) => r.text),
      onOutcome: ({ outcome }) => {
        // A NEW plan rewrote the durable stream — the ephemeral ledger's
        // frozen block positions are meaningless against it. This fires
        // inside runTransformContext, BEFORE beforeTurn's weave, so the next
        // weave starts over with one fresh block at the compacted tail. A
        // byte-stable replay keeps the frozen positions valid — no reset.
        if (outcome === 'planned') this.ephemeralLedger.reset();
      },
    }));
  }

  /** Persist the verified connect-ticket scopes (edge-set header, see
   *  appendIdentityHeaders) as a connection tag — tags ride the WebSocket
   *  attachment, so the rpc gate survives DO hibernation. */
  override async getConnectionTags(connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const tags = await super.getConnectionTags(connection, ctx);
    const scopeTag = cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER));
    return scopeTag ? [...tags, scopeTag] : tags;
  }

  /** Scoped access-token connections may chat but never write agent state. */
  override shouldConnectionBeReadonly(connection: Connection, ctx: ConnectionContext): boolean {
    return super.shouldConnectionBeReadonly(connection, ctx)
      || !!ctx.request.headers.get(CLI_SCOPES_HEADER);
  }

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
        // The drain-debounce timer. keepAliveWhile (the agents-SDK heartbeat
        // the evolution hooks already rely on) holds the DO through the window
        // + the drain so the debounced drain completes within the live
        // activation instead of racing eviction. If the DO dies anyway, the
        // events are still durable in the EventLog — the next ingress / cron
        // alarm / post-turn drain picks them up (delayed, never dropped).
        setTimer: (fn, ms) => {
          void agent.keepAliveWhile(() => new Promise<void>((resolve) => {
            setTimeout(() => {
              fn().catch((err: unknown) =>
                console.warn('[proteus] drain timer callback failed:', (err as Error).message),
              ).finally(resolve);
            }, ms);
          })).catch((err: unknown) =>
            console.warn('[proteus] drain timer keepAlive failed:', (err as Error).message));
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

  // Steer-as-Branch redirects launched against the in-flight turn — each runs
  // as one budgeted head (ExplorationAgent Facet) and settles into Alternate
  // Takes when the turn completes (onChatResponse).
  private _pendingBranches: PendingBranch[] = [];

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
        // Idempotent: pick the soonest of (existing alarm, new ts).
        scheduleAt(ts: number) { orchestrator.scheduleAlarmAt(ts); },
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
      // email_thread dispatcher: a drained email turn's answer goes back onto
      // the inbound mail's thread via the send_email binding. Context resolves
      // per dispatch so binding/display-name changes never go stale.
      const emailDispatcher = createEmailThreadDispatcher(() => ({
        email: orchestrator.env.EMAIL,
        agentDisplayName: orchestrator.safeDisplayName(),
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
  // Receiver: the receivePeerMessage @callable below. The `team` tool's
  // ask/send/reply actions ride this hub; spawn adds the create-agent path.
  private _peerHub: PeerHub | null = null;
  protected get peerHub(): PeerHub {
    if (!this._peerHub) {
      const orchestrator = this;
      this._peerHub = new PeerHub({
        sql: this.ctx.storage.sql,
        log: this.eventLog,
        replyChannels: this.replyChannels,
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
          const userDO = orchestrator.getOwnerUserDO();
          if (!userDO) return false;
          try {
            return await userDO.hasPeerGrant(senderAgentName, senderUserId);
          } catch (err) {
            console.warn('[proteus] hasPeerGrant lookup failed:', (err as Error).message);
            return false;   // default deny on lookup failure
          }
        },
        scheduleDispatch: (at) => orchestrator.scheduleAlarmAt(at),
        onAdmitted: () => { orchestrator.orch.scheduleDrain(); },
      });
    }
    return this._peerHub;
  }

  /** Idempotent soonest-wins alarm arm (shared shape with the TriggerRegistry
   *  scheduler above). */
  private scheduleAlarmAt(ts: number): void {
    void Promise.resolve(this.ctx.storage.getAlarm()).then((current) => {
      if (current === null || ts < current) {
        this.ctx.storage.setAlarm(ts);
      }
    }).catch(() => this.ctx.storage.setAlarm(ts));
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
        // Mission Inbox: a settled background job also notifies the owner by
        // email (skips silently when the platform email pieces are absent).
        onSettled: (job) => this.emailOwnerNotification(
          `Background ${job.kind} job ${job.status}`,
          job.status === 'completed'
            ? `Background ${job.kind} job ${job.id} completed.\n\nResult:\n${job.result ?? '(empty)'}`
            : `Background ${job.kind} job ${job.id} ${job.status}${job.error ? `:\n\n${job.error}` : '.'}`,
        ),
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
      // think() call: MCTS gets a fresh SessionWriter + the operator's stored
      // overrides (mcts_c/iterations/depth/branches — an explicit LLM budget
      // still wins); heads get the shared controller, the live conversation as
      // inheritedContext, and an onPhase sink that streams head_split /
      // head_merge into the durable event log.
      defaultOptions: () => ({
        mcts: { session: this.createMCTSSession(), ...this.config.getMctsOverrides() },
        heads: {
          controller: this.getHeadController(),
          inheritedContext: this.readInheritedContext(),
          onPhase: (event: SplitPhaseEvent) => this.emitHeadPhase(event),
          onComplete: (merge: MergeResult, task: string) => this.recordHeadsTake(merge, task),
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

  /** The public extension seam on the cloud backend — the SAME ExtensionHost
   *  contract `runChat` drives on the CLI, bridged onto Think's subclass
   *  hooks: beforeTurn → onTurnStart + transformContext, beforeStep → the
   *  shared step pipeline (composePrepareStep), beforeToolCall/afterToolCall
   *  → onToolCall/onToolResult, onChatResponse → onTurnEnd. Persistent for
   *  the DO activation. The default compaction extension registers here at
   *  construction (registerCompactionExtension). */
  private readonly extensions = new ExtensionHost();

  /** Ephemeral system-state blocks for this DO activation (core
   *  volatile-context.ts). In-memory only — hibernation/reset empties it, so
   *  a cold start attaches exactly one fresh block; the compaction
   *  extension's onOutcome resets it on a fresh plan ('planned') because the
   *  frozen block positions are meaningless against the rewritten stream. */
  private readonly ephemeralLedger = new EphemeralContextLedger();
  private _cliCwd: string | null = null;
  // Current turn identity for the device daemon's pre-mutation shadow-git
  // snapshot (set in beforeTurn; the daemon dedupes per turnId). Survives the
  // turn so background tool continuations keep tagging their originating turn.
  private _turnCheckpoint: { turnId: string; sessionId: string } | null = null;

  // The prepared streamText opts of the LAST live chat inference, stashed at
  // the end of beforeTurn — Think 0.8's one turn-assembly hook on the live
  // inference path (the effective TurnConfig: final system/messages/tools/
  // model; Think then only wraps tool execute and re-applies the same values,
  // so a replay of these opts is the same request modulo per-step cache
  // markers, which are inert decoration). The shadow eval replays these for
  // the pending scaffold's host.defaultInference so the A/B measures the
  // scaffold delta, not a context handicap: the live answer saw the whole
  // conversation while the shadow's reconstruction used to see only the task
  // text — structurally tie-prone. Also the task source for the evolved-
  // scaffold inference transform. In-memory only: turns are serialized on
  // the TurnQueue and the shadow eval captures the reference synchronously
  // in the same onChatResponse, so it cannot be overwritten by a later turn;
  // after a DO restart the shadow falls back to the task-only reconstruction.
  private _lastTurnOpts: Parameters<typeof streamText>[0] | null = null;

  getCliCwdForDevice(): string | null {
    return this._cliCwd;
  }

  getCheckpointMetaForDevice(): { turnId: string; sessionId: string } | null {
    return this._turnCheckpoint;
  }

  // ── Bound SQL executor ────────────────────────────────────────────────
  // `this.sql` is a plain method on the Agent base class — it needs `this`
  // bound to reach `this.ctx.storage.sql`. Passing `this.sql` as a bare
  // function reference to any helper (readForkLineage, forkWorkspaceStorage)
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
        // Replay-eval rollout: the LIVE scaffold with the real LLM + tool
        // bridges — the closest re-run of "what would the agent do today".
        replayTaskRunner: (task) => this.runScaffoldCaptureText(task),
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

      const executor = new PreambleCraftedExecutor(env.LOADER, this.rt.craftStore, this.boundSql);

      // Seed the `codemode` provider with the INJECTABLE crafted tools at
      // construction time so the LLM's initial description string lists them
      // — the same selection the preamble makes, so the advertised set can't
      // disagree with the callable set. No-op bodies suffice.
      const seededCraftedTools: Record<string, { description: string; execute: (arg: unknown) => Promise<unknown> }> = {};
      for (const t of selectInjectableCraftedTools(this.rt.craftStore, this.boundSql)) {
        seededCraftedTools[t.name] = {
          description: t.description || `Crafted tool: ${t.name}`,
          // This execute is never invoked — the preamble injects the real
          // body as a `tools.<name>` literal in-sandbox. The dispatcher
          // miss that would otherwise occur is irrelevant because the
          // sandbox's `codemode.<name>(args)` goes to the local `tools`
          // object, not through the dispatcher. We provide an execute
          // stub only because createCodeTool's ToolProvider shape requires it.
          execute: async () => ({ error: 'crafted tools run through the preamble, not the dispatcher' }),
        };
      }

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
      // `web.*` — same web search/fetch provider that backs the web_* tools.
      const webProvider = createWebCodemodeProvider(this.getWebSearchProvider());
      // Record which executor the agent actually works in, so the UI (diff /
      // file manager) defaults to where work happened. One upsert per executor
      // per turn (debounced via _executorsUsedThisTurn, reset in beforeTurn).
      const recordExecutor = (name: string) => {
        if (this._executorsUsedThisTurn.has(name)) return;
        this._executorsUsedThisTurn.add(name);
        try { this.config.setLastActiveExecutor(name); } catch { /* best-effort capture */ }
      };
      const allProviders = [craftedProvider, rlmProvider, agentSelfProvider, webProvider, ...executorProviders.map(p => {
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

  /** Read the owner userId from workspace_identity; '' (empty) means unclaimed. */
  protected getOwnerUserId(): string | null {
    try {
      const rows = this.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM workspace_identity LIMIT 1`;
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

  private _webSearchProvider: WebSearchProvider | null = null;
  /** The web search + fetch provider — built once per DO lifetime. Key-less by
   *  default (DuckDuckGo + Markdown-for-Agents); a stored `tavily` credential,
   *  resolved through the registry's getAuth seam, upgrades search. HTML→markdown
   *  routes through env.AI.toMarkdown when the AI binding is present. */
  private getWebSearchProvider(): WebSearchProvider {
    if (this._webSearchProvider) return this._webSearchProvider;
    const getAuth = this.getOwnerUserId() ? this.providerRegistry().deps.getAuth : undefined;
    const ai = (this.env as { AI?: { toMarkdown?: (docs: Array<{ name: string; blob: Blob }>) => Promise<Array<{ data: string }>> } }).AI;
    this._webSearchProvider = createDefaultWebSearchProvider({
      fetch: globalThis.fetch,
      ...(getAuth ? { getAuth } : {}),
      ...(ai?.toMarkdown
        ? {
            htmlToMarkdown: async (html: string, opts?: { url?: string }) => {
              const name = (opts?.url ?? 'page') + '.html';
              const blob = new Blob([html], { type: 'text/html' });
              const out = await ai.toMarkdown!([{ name, blob }]);
              return out[0]?.data ?? '';
            },
          }
        : {}),
    });
    return this._webSearchProvider;
  }

  /** The `team` tool over the peer transport. Owner resolution is lazy inside
   *  each action (the toolset is cached across turns — including a pre-claim
   *  build — so deps must not capture owner state at construction). */
  private getTeamToolDeps(): TeamToolDeps {
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
      const known = await orchestrator.requireOwnerUserDO().hasWorkspace(agent);
      if (!known) throw new Error(`unknown peer "${agent}" — list your team with action:"list"`);
    };
    return {
      listPeers: async () => {
        requireOwner();
        return teamPeers(orchestrator.name, await orchestrator.requireOwnerUserDO().listWorkspaces());
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
      spawn: async ({ name, purpose, message, timeoutMs }): Promise<PeerSpawnOutcome> => {
        const userId = requireOwner();
        const userDO = orchestrator.requireOwnerUserDO();
        let agentName = name;
        let created = false;
        if (!agentName || !(await userDO.hasWorkspace(agentName))) {
          const entry = await createCloudWorkspaceForUser(orchestrator.env, userId, userDO, {
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
      engine: this.getProductChangeEngine(),
    };
  }

  private _productChangeEngine: ProductChangeEngine | null = null;
  /** The execution engine beneath the product-change ledger: apply/checks in
   *  the agent's sandbox container (raw exit codes), preview through the
   *  path-style preview proxy, deploy/rollback verified against real command
   *  output. Ledger writes go through the owner's UserDO so the engine's
   *  results land on the same governed board the UI reads. */
  private getProductChangeEngine(): ProductChangeEngine {
    if (this._productChangeEngine) return this._productChangeEngine;
    const handle = this.rt.sandboxHandle;
    const provider = this.rt.executionRouter?.getProvider('sandbox');
    const userDO = () => this.requireOwnerUserDO();
    this._productChangeEngine = new ProductChangeEngine({
      exec: handle && provider ? createSandboxProductChangeExec(handle, provider) : null,
      ledger: {
        detail: (changeId) => userDO().getProductChangeDetail(changeId),
        update: (changeId, patch) => userDO().updateProductChange(changeId, patch),
        transition: (changeId, to) => userDO().transitionProductChange(changeId, to),
        recordCheck: (changeId, input) => userDO().recordProductChangeCheck(changeId, input),
        recordDeployment: (changeId, input) => userDO().recordProductDeployment(changeId, input),
      },
      // A stored `github` credential (POST /api/user/credentials/github with a
      // bearer PAT) authorizes clone/push for github source bindings; absent →
      // the engine's honest add-a-credential error.
      gitHubAuth: async () => {
        const headers = await this.getOwnerUserDO()?.getAuthHeaders('github');
        return headers?.Authorization ?? null;
      },
    });
    return this._productChangeEngine;
  }

  /** Worker calls this on every authenticated request before any other RPC.
   *  Claims the agent for `userId` if unclaimed; 403s on cross-user collision.
   *
   *  Defensive: claimOwner can fire BEFORE onStart() completes on a fresh DO
   *  activation (the agents SDK doesn't strictly guarantee onStart→RPC order).
   *  ensureSchema() creates all required tables so the SELECT/UPDATE never hits
   *  a missing table or column, and is flag-gated so onStart won't repeat it.
   */
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
    const model = this.promptModelContext();
    const key = `${this.getSoulText()}\u0000${execKey}\u0000${model.provider ?? ''}/${model.id ?? ''}`;
    let base: string;
    if (this._cachedSystemPrompt && this._cachedSystemPromptKey === key) {
      base = this._cachedSystemPrompt;
      this.logActivity("getsystemprompt_end", "cache hit");
    } else {
      // Always build the BASE prompt here — no turn-scoped state. The
      // authoritative per-turn prompt (skills, MCP tools, fresh device
      // status, change notice) is assembled in `beforeTurn` and ALWAYS
      // returned via TurnConfig.system, which overrides this one for chat
      // turns (Think calls getSystemPrompt() BEFORE beforeTurn()). Mixing
      // turn state in here would poison the cache across turns.
      base = buildSystemPromptSync(this.rt, {
        executors: execs,
        availableTools: ACTIVE_TOOLS,
        backend: 'cf',
        model,
      });
      this._cachedSystemPrompt = base;
      this._cachedSystemPromptKey = key;
      this.logActivity("getsystemprompt_end", `${base.length} chars`);
    }
    // BYTE-STABLE: no per-turn state rides here. The volatile half (facts,
    // executor status, device notice, skill activations) is appended to the
    // turn's MESSAGES in beforeTurn — see prompting/volatile-context.ts.
    return base;
  }

  /** The recent-facts block for the volatile turn-context message — rendered
   *  fresh each turn (facts change), so it stays out of the cacheable system
   *  prefix. Undefined when there are no facts yet. */
  private renderFactsForTurn(): string | undefined {
    try {
      return renderFactsBlock(this.facts.recentTopK(20), { maxChars: 2000 }) || undefined;
    } catch { return undefined; /* facts table not yet initialized */ }
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
        // Peer-agent teams over the EventsHub transport (owner resolved lazily
        // per action, so the cached toolset stays valid across claimOwner).
        team: this.getTeamToolDeps(),
        // Web research — key-less default, codemode web.* wired below.
        webSearch: this.getWebSearchProvider(),
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

  /** Record the comparable heads of a completed think({strategy:'heads'}) run as
   *  an unclaimed Alternate-Takes set — claimed against this turn at turn end by
   *  claimAlternateTakesForTurn, exactly like an MCTS capture. Only grounded
   *  scores are a real preference signal, so emit nothing when ungrounded. */
  private recordHeadsTake(merge: MergeResult, task: string): void {
    if (!merge.grounded) return;
    const heads = merge.headScores
      .filter((s) => s.status === 'completed')
      .map((s) => ({ id: s.id, text: s.text, score: s.score }));
    try {
      recordHeadsTakeSet(this.boundSql, { task, heads });
    } catch { /* no takes table yet — the first MCTS/heads run creates it */ }
  }

  /** Build the CF HeadRuntime (Facet spawner + merge LLM) once per DO lifetime,
   *  lazily — heads need the agent's owner for UserDO auth. undefined when the
   *  agent has no owner; surfaced via host.headRuntime. */
  private _cfHeadRuntime: HeadRuntime | null = null;
  private getCFHeadRuntime(): HeadRuntime | undefined {
    if (this._cfHeadRuntime) return this._cfHeadRuntime;
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) return undefined;
    this._cfHeadRuntime = createCFHeadRuntime(this as unknown as Parameters<typeof createCFHeadRuntime>[0], ownerUserId, {
      executor: this.rt.executor,
      explorer: this.rt.llm,
      ...(this.rt.judgeModel ? { judge: this.rt.judgeModel } : {}),
    });
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
    // The agent's durable context is `getSystemPrompt()` (soul + tools) plus
    // the persisted conversation and the ephemeral/turn-local context split —
    // a single source of truth, not Think's freezable context blocks. No
    // Session policy attaches here: compaction is the transformContext
    // extension (registerCompactionExtension), which rewrites the turn's
    // model-visible history without ever touching the stored messages.
    return session;
  }

  /** Resolved `<provider>/<modelId>` the next turn will actually use — the
   *  same resolution getModel() applies. Computing the threshold from the RAW
   *  stored spec was the 41%-of-Kimi bug: an unset model gave "" → the 128k
   *  default window instead of the resolved default model's real 262k. Falls
   *  back to the raw spec only pre-claim (no provider registry yet). */
  private effectiveModelSpec(): string {
    const stored = this.getStoredModelId();
    try {
      return this.providerRegistry().normalizeSpecSync(stored);
    } catch {
      return stored ?? '';
    }
  }

  /** Prompt model context from the RESOLVED spec. The raw stored id is null
   *  on default-configured agents, which left family gating (the Kimi bare
   *  tool-name index + operating guidance) inert on the primary hosted path —
   *  the same raw-spec class of bug effectiveModelSpec() fixed for the
   *  compaction threshold. */
  private promptModelContext(): { id?: string; provider?: string } {
    const spec = this.effectiveModelSpec();
    if (!spec) return {};
    try {
      const { provider, modelId } = parseModelSpec(spec);
      return { id: modelId, provider };
    } catch {
      return { id: spec };
    }
  }

  /** Catalog-reported context window for the resolved spec, cached per spec.
   *  Arms an async catalog lookup on first sight of a spec; until (and unless)
   *  it lands, the static fallback table answers. */
  private _catalogWindow: { spec: string; window: number | null } | null = null;
  /** The resolved model's context window: catalog-reported when the async
   *  lookup has landed, else the static fallback table. Feeds the compaction
   *  extension through the transformContext seam. */
  private sessionContextWindow(): number {
    const spec = this.effectiveModelSpec();
    if (this._catalogWindow?.spec !== spec) {
      this._catalogWindow = { spec, window: null };
      void this.lookupCatalogWindow(spec);
    }
    return this._catalogWindow.window ?? contextWindowForModel(spec);
  }

  private async lookupCatalogWindow(spec: string): Promise<void> {
    if (!spec) return;
    try {
      const { provider, modelId } = parseModelSpec(spec);
      const reg = this.providerRegistry();
      const window = await catalogContextWindow(reg.registry.get(provider), reg.deps, modelId);
      if (window && this._catalogWindow?.spec === spec) this._catalogWindow.window = window;
    } catch { /* catalog unavailable — the static fallback table stays authoritative */ }
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
  // programmatic turn via host.enqueueTurn → saveMessages). Ingress paths use
  // the debounced `this.orch.scheduleDrain()`; the post-turn hook drains
  // immediately via `this.orch.drainPendingEvents()`.

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    this.acc.reset(Date.now());
    this._executorsUsedThisTurn.clear();
    this._cliCwd = readCliCwd(ctx.body);
    this._inFlight = true;
    this.logActivity("beforeturn", "streamText() called next");
    // A real user message is the verdict on the previous turn — dispatch the
    // detached outcome review (Hermes-style forked background review). Runs
    // concurrently with this turn; never blocks it. Programmatic turns
    // (reactor / job wake) are not user verdicts.
    if (!this.lastUserTurnIsProgrammatic()) {
      this.orch.observeUserTurn(extractLastUserText(ctx.messages));
    }
    // Start a new run for the event log, with provenance so cross-run history
    // (Supervise altitude) can show what kicked each run off. This is the chat
    // path → caused_by:'chat'; event-triggered runs set ingress_kind/trigger_id.
    this._currentRunId = `run-${nanoid()}`;
    // Tag this turn for device-side file checkpoints: the user message id is
    // what the web turn card holds, so restore-by-turn resolves directly.
    {
      const userMessages = this.messages.filter((m) => m.role === 'user');
      const lastUserId = userMessages[userMessages.length - 1]?.id;
      this._turnCheckpoint = { turnId: lastUserId ?? this._currentRunId, sessionId: 'default' };
    }
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

    // ── Per-turn device awareness ────────────────────────────────
    // One authoritative hub check (a cheap DO-to-DO RPC) so the executor list
    // below reflects the CURRENT device state — the transport's TTL-cached
    // snapshot can lag a mid-session `proteus connect` by a turn. The persisted
    // watermark is only a diff anchor for the one-turn change notice; the hub
    // stays the single source of truth.
    let deviceNotice: string | null = null;
    try {
      const status = await this.rt.deviceTransport.refreshStatus();
      deviceNotice = observeDevicePresence(this.config, status).notice;
    } catch (err) {
      console.warn('[proteus] device status refresh failed:', (err as Error).message);
    }

    // AGENTS.md (agents.md standard) — agent VFS root + the sandbox workspace
    // when one is already active. Like skills/MCP, this is turn-scoped state,
    // so it rides the beforeTurn system override, not the cached base prompt.
    const agentsMd = await collectWorkspaceAgentsMd(
      this.rt.storage.vfs,
      this.rt.executionRouter?.getProvider('sandbox') ?? undefined,
    );

    // The per-turn system prompt is ALWAYS assembled here (TurnConfig.system
    // overrides) — Think calls getSystemPrompt() BEFORE beforeTurn, so only
    // this path can reflect the turn's active skills and MCP tools. It is the
    // byte-stable cache prefix: it changes only on real agent events (soul,
    // model, skill set, tool surface, AGENTS.md). System state — facts, the
    // live executor status — rides the ephemeral ledger's frozen blocks, and
    // turn-local state — the device notice, activation reasons — rides one
    // trailing message (prompting/volatile-context.ts), so neither ever
    // re-prefills the prefix.
    const execs = this.rt.executionRouter?.listExecutors() ?? [];
    const model = this.promptModelContext();
    const systemOverride = buildSystemPromptSync(this.rt, {
      executors: execs,
      availableTools: activeTools,
      ...(activeSetForPrompt ? { activeSkills: activeSetForPrompt } : {}),
      ...(agentsMd.length > 0 ? { agentsMd } : {}),
      externalTools: mcpToolNames.map((name) => ({ name, source: 'mcp' as const })),
      backend: 'cf',
      model,
      currentDate: currentDateForPrompt(),
    });
    this.recordSystemPromptHash(systemOverride);

    const cfg: TurnConfig = { system: systemOverride };
    const baseMessages = this._cliCwd ? withCliCwdContext(ctx.messages, this._cliCwd) : ctx.messages;

    // ── Extension seam: turn start + the awaited context transform ─────
    // The same ExtensionHost contract runChat fires on the CLI. The
    // transform sees ONLY the durable history — the ephemeral ledger blocks
    // and the turn-local tail are woven/spliced after it, so a compaction
    // plugin can never see (or persist) either.
    await this.extensions.emitTurnStart({ system: systemOverride, history: baseMessages });
    // The measured trigger: the previous turn's final request as the provider
    // actually priced it, persisted at turn end (onChatResponse). Null until
    // the session's first turn completes — the engine's char estimate gates
    // alone until then — and voided by the length guard when the durable
    // history shrank (undo/restore) since the measurement.
    this._turnDurableLength = baseMessages.length;
    const lastPromptTokens = this.compactionState.loadPromptTokens(this.name, baseMessages.length);
    const transformed = await this.extensions.runTransformContext({
      sessionKey: this.name,
      messages: baseMessages,
      system: systemOverride,
      contextWindow: this.sessionContextWindow(),
      ...(lastPromptTokens !== null ? { providerReportedTokens: lastPromptTokens } : {}),
      trigger: 'auto',
    });
    const woven = this.ephemeralLedger.weave(transformed ?? baseMessages, {
      factsBlock: this.renderFactsForTurn(),
      executors: execs,
    });
    const turnLocal = turnLocalContextMessage({
      deviceNotice,
      ...(this._turnActiveSkills ? { activeSkills: this._turnActiveSkills } : {}),
    });
    cfg.messages = turnLocal ? [...woven, turnLocal] : woven;

    // Extension-contributed tools join the turn's ToolSet without ever
    // shadowing a built-in or MCP tool (runChat's merge order, mirrored:
    // caller tools win, only extension-vs-extension collisions throw).
    const extensionTools = Object.fromEntries(
      Object.entries(this.extensions.tools())
        .filter(([name]) => !(name in ctx.tools) && !(name in mcpTools)),
    );
    const extensionToolNames = Object.keys(extensionTools);
    const extraTools: ToolSet = { ...extensionTools, ...(effectiveTools ?? {}) };
    if (Object.keys(extraTools).length > 0) cfg.tools = extraTools;
    cfg.activeTools = extensionToolNames.length > 0
      ? [...effectiveActiveTools, ...extensionToolNames]
      : effectiveActiveTools;

    // Prompt-cache plan for this turn (core prompting/cache-breakpoints.ts).
    // Request-level cache routing (prompt_cache_key / promptCacheKey) rides
    // TurnConfig.providerOptions; the cache-eligible system message + rolling
    // tail breakpoints for marker providers (Anthropic) ride beforeStep —
    // PrepareStepResult carries typed system/messages overrides for every
    // step's request, whereas TurnConfig.system is string-typed.
    const cacheStrategy = resolvePromptCacheStrategy(model.provider, model.id);
    this._turnCachePlan = hasCacheMarkers(cacheStrategy)
      ? { strategy: cacheStrategy, system: cacheableSystem(systemOverride, cacheStrategy) }
      : null;
    const cacheOptions = promptCacheOptions(cacheStrategy, agentAffinityKey(this.name));
    if (cacheOptions) cfg.providerOptions = cacheOptions;

    // Shadow-eval context parity + the evolved-scaffold task source (see the
    // _lastTurnOpts field doc): the effective opts the streamText Think runs
    // next will see — final system/messages/merged tools/model. Think only
    // adds its tool-decision wrapping and the per-step cache markers on top,
    // both inert for a replay.
    this._lastTurnOpts = {
      model: ctx.model,
      system: systemOverride,
      messages: cfg.messages,
      tools: { ...ctx.tools, ...(cfg.tools ?? {}) },
      activeTools: cfg.activeTools,
      stopWhen: stepCountIs(this.maxSteps),
      ...(cacheOptions ? { providerOptions: cacheOptions } : {}),
    };
    return cfg;
  }

  /** The in-flight turn's prompt-cache plan — set in beforeTurn, non-null only
   *  for marker strategies (Anthropic / OpenRouter-Claude), whose breakpoints
   *  beforeStep re-rolls onto the newest tail each step. */
  private _turnCachePlan: { strategy: PromptCacheStrategy; system: string | SystemModelMessage } | null = null;

  beforeStep(ctx: PrepareStepContext): StepConfig | void {
    // The shared step pipeline (core prompting/prepare-step.ts, identical on
    // the CLI): extension prepareStep rewrites first, then the cache plan
    // rolls the tail breakpoints onto the FINAL message array so each request
    // of the agentic loop reads the prefix the previous step wrote.
    return composePrepareStep(
      this.extensions,
      { stepNumber: ctx.stepNumber, messages: ctx.messages },
      this._turnCachePlan,
    );
  }

  /** The byte-stability invariant as telemetry: the system prompt hash should
   *  change only on real agent events (soul/skill/craft/device/model), never
   *  between two vanilla consecutive turns. A "(changed)" entry in the
   *  activity log without a nearby skills_active / device / craft event is a
   *  cache-prefix regression. */
  private _lastSystemPromptHash: string | null = null;
  private recordSystemPromptHash(system: string): void {
    const hash = fnv1a64(system);
    const prev = this._lastSystemPromptHash;
    this._lastSystemPromptHash = hash;
    this.logActivity('system_prompt_hash', `${hash}${prev === null ? '' : prev === hash ? ' (stable)' : ' (changed)'}`);
  }

  onChunk(_ctx: ChunkContext): void {
    this.acc.onFirstChunk();
  }

  /** Whether the in-flight turn was injected programmatically (reactor drain,
   *  background-job wake, consent resume) — enqueueTurn stamps proteusEvent
   *  metadata on the saved user message; real chat messages carry none. */
  private lastUserTurnIsProgrammatic(): boolean {
    const userMessages = this.messages.filter(m => m.role === "user");
    const last = userMessages[userMessages.length - 1] as { metadata?: unknown } | undefined;
    return isRecord(last?.metadata) && typeof last.metadata.proteusEvent === 'string';
  }

  async beforeToolCall(ctx: ThinkToolCallContext): Promise<void> {
    // Extension observation before the tool's execute runs (returning void =
    // allow with the original input — the seam observes, it does not gate).
    await this.extensions.emitToolCall({
      toolName: ctx.toolName,
      args: (ctx.input ?? {}) as Record<string, unknown>,
    });
  }

  async afterToolCall(ctx: ToolCallResultContext): Promise<void> {
    // Think 0.4 shape (toolName/input/output/success/durationMs) → the core
    // accumulator records it + fires the activity log + run-event sinks.
    this.acc.recordToolCall(ctx as unknown as Parameters<TurnAccumulator['recordToolCall']>[0]);
    await this.extensions.emitToolResult({
      toolName: ctx.toolName,
      // Same shape the CLI seam emits: stringified, capped at 1000 chars.
      result: String(ctx.success ? ctx.output ?? '' : ctx.error ?? '').slice(0, 1000),
    });
  }

  onStepFinish(ctx: StepContext): void {
    this.acc.recordStep(ctx as unknown as StepLike);
  }

  async onChatResponse(result: ChatResponseResult) {
    this.logActivity("response_complete", result.status);
    // Clear the in-flight flag once the turn is durably completed — forkAgent
    // is allowed again from here forward. Evolution (engine.reviewTurnDetached)
    // runs fire-and-forget and does NOT extend the busy window.
    this._inFlight = false;
    this._cliCwd = null;
    // Persist the turn's final provider-priced prompt size — the NEXT turn's
    // measured compaction trigger. Recorded even on aborted/errored turns:
    // any step that reported was a real priced request. Bound to the turn's
    // durable-history length so a later shrink voids it.
    if (this.acc.lastPromptTokens > 0) {
      this.compactionState.savePromptTokens(this.name, this.acc.lastPromptTokens, this._turnDurableLength);
    }
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
    if (result.status !== "completed") {
      // An aborted/errored live turn leaves nothing to compare a branch
      // against — and any takes its think-mcts runs captured competed for an
      // answer that no longer exists, so the next turn must not claim them.
      try { purgeUnclaimedAlternateTakes(this.boundSql); } catch { /* no takes table yet */ }
      this.settlePendingBranches(null, '');
      return;
    }

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

    // Steer-as-Branch redirects launched during this turn settle against its
    // answer — detached, so a slow branch never blocks the TurnQueue.
    this.settlePendingBranches(msgId ?? null, assistantText);

    // Mission Inbox: a turn injected by the event drain carries the synthetic
    // turn id its events were bound to — reply their open email_thread
    // channels with this turn's answer (threaded outbound email). Detached.
    const drainTurnId = isRecord((lastUserMsg as { metadata?: unknown } | undefined)?.metadata)
      ? (lastUserMsg as { metadata: Record<string, unknown> }).metadata.drainTurnId
      : undefined;
    if (typeof drainTurnId === 'string') {
      void dispatchEmailRepliesForTurn(
        { log: this.eventLog, replies: this.replyChannels },
        drainTurnId, assistantText, Date.now(),
      ).catch((err) => console.warn('[proteus] email reply dispatch failed:', err));
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
      turnId: msgId,
      sessionId: 'default',
      origin: this.lastUserTurnIsProgrammatic() ? 'programmatic' : 'user',
    };

    // CRITICAL: Evolution hooks make LLM calls (outcome classification,
    // reflection, extraction, session reflection) that take 5-30 seconds
    // each. onChatResponse runs INSIDE Think's TurnQueue — if we await here,
    // the queue is blocked and the next message can't start processing until
    // evolution finishes. The user sees "nothing happens" for the second message.
    //
    // Fix: fire evolution asynchronously. The DO stays alive via keepAliveWhile
    // in the outer scope. Errors are caught and logged, never propagated.
    //
    // The core AgentOrchestrator owns the shared cadence: advance the
    // session-reflection counter (firing engine.onSessionComplete every N
    // turns) + buffer this turn for its outcome review — the NEXT user
    // message grades it (beforeTurn → observeUserTurn → engine.reviewTurn:
    // outcome classification, turn.feedback, craft EMA, reflection/lesson,
    // pattern extraction). Programmatic turns review immediately. All
    // fire-and-forget; never blocks the TurnQueue.
    this.orch.recordTurn(turn);

    // Auto-judge shadow evaluation. When a pending scaffold exists,
    // sample-and-run (default 25%) the pending against this turn's task,
    // ask a judge LLM to compare, record. When minTrials is reached AND
    // agent_config.auto_promote_scaffold allows it (default ON; the
    // changelog makes the decision visible and revertable), auto-apply.
    void this.runShadowEvalSampled(userText, assistantText);

    // Sleep-time compute — between-turn background memory compression.
    // Reads recent turn, asks a judge to upsert/decay the agent_facts world
    // model. Letta-style; ~50% test-time token reduction reported. Gated by
    // agent_config.sleep_time_compute (default ON; fact upserts land in the
    // Evolution Changelog and are revertable).
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
    // Captured synchronously (before any await) so a later turn's stash can
    // never bleed into this turn's shadow run.
    const liveOpts = this._lastTurnOpts;
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
        // host.defaultInference for the pending: replay the EXACT streamText
        // opts the live answer ran with (full conversational context, system
        // prompt, tool surface) so a pending that delegates to the default
        // loop is judged on the scaffold delta alone. Costs one extra
        // full-context inference — that IS the shadow run, already sampled.
        // Fallback (DO restarted between the live turn and this eval): the
        // old task-only reconstruction.
        defaultInference: () => streamText(liveOpts ?? {
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
        const provisional = deriveWorkspaceTitle(userText);
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
        await stub.setWorkspaceDisplayName(this.name, displayName);
      } catch (err) {
        console.warn('[proteus] propagateDisplayName roster sync failed:', err instanceof Error ? err.message : err);
      }
    }
    try { this.broadcast(JSON.stringify({ type: 'workspace_renamed', displayName })); } catch { /* nop */ }
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
    // R3 outcome ledger (+ its take_pick CHECK-widening rebuild). MUST run
    // here, not only in the lazy EvolutionEngine constructor: a freshly-woken
    // DO can serve pickAlternateTake → recordTurnOutcome before any turn
    // constructs the engine, and the legacy CHECK would reject the insert.
    initTurnOutcomeTables(execRaw, this.boundSql);
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

    // Compaction: the replayable plan snapshot + the measured prompt-token
    // trigger signal, one row per session (@proteus/compaction stores).
    initCompactionStateTable(execRaw);

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
      // other pending events) — an autonomous turn, debounced so events
      // arriving alongside the alarm coalesce into it.
      if (due.length > 0) this.orch.scheduleDrain();
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

    // Reschedule the next-soonest alarm (triggers ∪ peer-outbox retries).
    // A due/past-due peer retry is clamped to `now` (see nextAlarmTime), and
    // the arm is soonest-wins so this reschedule never clobbers a sooner
    // retry alarm armed during dispatch.
    try {
      const next = nextAlarmTime(
        now,
        this.triggerRegistry.list({ state: 'active' }).map((t) => t.next_fire_at),
        this.peerHub.nextRetryAt(),
      );
      if (next !== null) this.scheduleAlarmAt(next);
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
        SELECT id, name, created_at FROM workspace_identity LIMIT 1`;
      const scaffoldVersion = this.sql<{ v: number }>`
        SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`;
      const searchNodes = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`;
      const craftedTools = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`;
      // Message count reflects the persisted `messages` table, which is the
      // authoritative turn history used for fork cut-points. For non-fork
      // agents this table is populated by onChatResponse's mirror; for forks
      // it's populated by forkWorkspaceStorage's copy. Falling back to the
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

  // ── Evolution Changelog — the self-change digest + revert (core builder) ──

  /** The "what I changed about myself" digest, assembled on demand from the
   *  durable ledgers (core buildChangelog — no second event system). */
  @callable()
  async getEvolutionChangelog(opts?: { limit?: number }): Promise<{
    entries: ChangelogEntry[]; unseenCount: number; seenAt: number;
  }> {
    const seenAt = this.config.getChangelogSeenAt();
    return {
      entries: buildChangelog(this.boundSql, { limit: opts?.limit ?? 50 }),
      unseenCount: countUnseenChangelog(this.boundSql, seenAt),
      seenAt,
    };
  }

  /** The operator viewed the changelog — zero the unseen badge. */
  @callable()
  async markChangelogSeen(): Promise<{ ok: true; seenAt: number }> {
    const seenAt = Date.now();
    this.config.setChangelogSeenAt(seenAt);
    return { ok: true, seenAt };
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
    if (this._pendingBranches.length === 0) return;
    const deps = {
      sql: this.boundSql,
      sessionId: 'default',
      broadcast: (event: BranchStatusEvent) => this.broadcastBranchStatus(event),
    };
    for (const entry of this._pendingBranches.splice(0)) {
      void settlePendingBranch(deps, entry, turnId, liveText);
    }
  }

  /** Record the user's pick between the explored takes — the explicit
   *  preference signal (turn_outcomes source 'take_pick' + convergence
   *  repoint via core recordTakePick). A pick that differs from the answered
   *  take queues a gentle programmatic continuation through the BackendHost
   *  seam (same machinery as the reactor / background-job wake). */
  @callable()
  async pickAlternateTake(takeId: string, nodeId: string): Promise<TakePickOutcome> {
    if (typeof takeId !== 'string' || !takeId || typeof nodeId !== 'string' || !nodeId) {
      throw new Error('pickAlternateTake requires takeId and nodeId');
    }
    const record = recordTakePick(this.boundSql, {
      takeId, nodeId,
      scaffoldVersion: getCurrentScaffoldVersion(this.boundSql),
    });
    try {
      await this.engine.applyTakePick(record.set.turnId, record.outcome);
    } catch (err) {
      console.warn('[proteus] applyTakePick lesson corroboration failed:', err instanceof Error ? err.message : err);
    }
    let continuationQueued = false;
    if (record.changedAnswer) {
      void this.host.enqueueTurn({
        text: buildTakeContinuationPrompt(record.set, record.chosen),
        metadata: { proteusEvent: 'take_pick' },
      }).catch((err) => console.warn('[proteus] take_pick continuation enqueue failed:', err));
      continuationQueued = true;
    }
    this.logActivity('take_pick', `${record.outcome} (${nodeId})`);
    return { ...record, continuationQueued };
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

  /**
   * `agent.proposeScaffold` host method — the agent proposes a new version of
   * its own agentic loop from inside execute_tools. Routes through the
   * EXISTING modifyScaffold 4-gate pipeline; an accepted proposal lands as
   * status='pending' and is scored by the sampled shadow eval + promotion
   * gate (runShadowEvalSampled) like any other proposal — no new safety
   * surface.
   */
  @callable()
  async proposeScaffold(rationale: string, code: string, baseVersion?: number) {
    const result = await modifyScaffold(
      this.rt, rationale, code,
      baseVersion !== undefined ? { baseVersion } : undefined,
    );
    if (result.ok) {
      try {
        this.sql`INSERT INTO evolution_events (id, type, message, data, created_at)
          VALUES (${nanoid()}, 'scaffold_proposed',
                  ${`Agent proposed scaffold v${result.version}: ${rationale.slice(0, 80)}`},
                  ${null}, ${Date.now()})`;
      } catch { /* evolution_events may not exist yet */ }
    }
    return result;
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
    // subscribers + MCP `list_run_events` see the decision in-band. Uses the
    // action ACTUALLY applied — the misevolution recheck can convert a
    // requested promote into a rollback (result.vetoReason says why).
    try {
      const runId = this._currentRunId || `scaffold-${nanoid()}`;
      this.eventRecorder.emit(runId, {
        type: result.action === 'promote' ? 'scaffold_promotion' : 'scaffold_rollback',
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

  // ── File checkpoints (device shadow-git) ─────────────────────────────
  // The store lives on the user's machine; these forward to the daemon via
  // the user hub. Restore is owner-invoked (web turn card / CLI /undo), so
  // it bypasses the per-agent consent gate — pure added reversibility.

  @callable()
  async checkpointStatus(): Promise<CheckpointAvailability> {
    const hub = this.getOwnerUserDO();
    if (!hub) return { available: false, reason: 'agent has no owner user yet' };
    try {
      return await hub.deviceRpc('checkpointStatus', []) as CheckpointAvailability;
    } catch (err) {
      if (isDeviceNotConnectedError(err)) {
        return { available: false, reason: 'no device connected — connect one with `proteus connect`' };
      }
      throw err;
    }
  }

  @callable()
  async listFileCheckpoints(limit = 50): Promise<FileCheckpointEntry[]> {
    const hub = this.getOwnerUserDO();
    if (!hub) return [];
    try {
      return await hub.deviceRpc('checkpointList', [this.name, Math.max(1, Math.min(500, limit))]) as FileCheckpointEntry[];
    } catch (err) {
      if (isDeviceNotConnectedError(err)) return [];
      throw err;
    }
  }

  @callable()
  async planFileRestore(dir: string, id: string): Promise<FileRestorePlan> {
    return await this.requireOwnerUserDO().deviceRpc('checkpointPlan', [this.name, dir, id]) as FileRestorePlan;
  }

  @callable()
  async restoreFileCheckpoint(dir: string, id: string): Promise<FileRestoreResult> {
    return await this.requireOwnerUserDO().deviceRpc('checkpointRestore', [this.name, dir, id]) as FileRestoreResult;
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
      'scaffold_explore_share',
      'sleep_time_compute',
      'tool_surfacing_mode',
      'review_model',
      'gepa_eval_budget',
      // shell_approval_mode has its own typed setter; not allowed via this.
    ]);
    if (!allowedKeys.has(key)) {
      throw new Error(`agent_config key not allowed via generic setter: ${key}`);
    }
    this.config.set(key, value);
    return { ok: true, key, value };
  }

  /** The scaffold variant archive: recent versions with status, DGM lineage
   *  (parent_version) and aggregated shadow-eval record. Read-only — also the
   *  backing for the agent.scaffoldVersions codemode helper. Computed by
   *  core's listScaffoldArchive; keys stay snake_case here because this RPC's
   *  wire shape predates the archive (ScaffoldLineage.tsx reads written_at). */
  @callable()
  async listScaffoldVersions(limit: number = 20) {
    return listScaffoldArchive(this.boundSql, limit).map((e) => ({
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

  // ── GEPA offline scaffold optimisation ─────────────────────────

  /**
   * Run a GEPA (Genetic-Pareto) optimisation pass over the agent's scaffold.
   * Offline + batch: draws a budgeted train/val split from the turn-outcome
   * ledger (corrected/frustrated turns = the negative train set reflection
   * must fix; accepted turns = the val regression guards), runs the current
   * scaffold + reflection-mutated candidates against them, scores each with
   * an outcome-aware judge, and — if a strictly-better candidate is found —
   * hands the winner to modifyScaffold so it enters the normal shadow-eval →
   * promote pipeline. Persisted to gepa_runs/gepa_candidates so the UI can
   * show lineage.
   *
   * Cost-bounded: the instance budget comes from agent_config
   * gepa_eval_budget (default 8) unless opts.evalSize overrides it; each
   * metric call runs a full scaffold + a judge call.
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
    const evalSize = Math.max(2, Math.min(opts?.evalSize ?? this.config.getGepaEvalBudget(), 20));
    const budget = {
      maxIterations: Math.max(1, Math.min(opts?.maxIterations ?? 4, 20)),
      maxMetricCalls: Math.max(10, Math.min(opts?.maxMetricCalls ?? 40, 200)),
      minibatchSize: 1,
    };

    // 1. Train/val split from outcome-labeled turns (turn_outcomes ledger).
    const { train: trainSet, val: evalSet } = buildOutcomeEvalSplit(this.boundSql, evalSize);
    if (evalSet.length === 0) {
      return { ok: false, error: 'no outcome-labeled turns yet — chat with the agent first' };
    }

    const model = this.getModel();

    // 2. Metric: run the candidate scaffold against the task, then judge
    // against the recorded outcome — accepted turns are regression checks
    // against the response the user approved; corrected/frustrated turns are
    // scored on whether the candidate already addresses the user's correction.
    const metric = async (
      candidate: string, instance: EvalInstance<string, OutcomeEvalExpectation>,
    ): Promise<MetricOutcome> => {
      let output: string;
      try {
        output = await this.runScaffoldCaptureText(instance.input, candidate);
      } catch (err) {
        return { score: 0, feedback: `scaffold execution failed: ${(err as Error).message}` };
      }
      const exp = instance.expected;
      const criterion = exp && exp.outcome === 'accepted'
        ? `The reference response below was ACCEPTED by the user. Score 1.0 when the new response ` +
          `is at least as good, 0.0 when it regresses.\n\nReference response:\n${exp.recordedResponse.slice(0, 2500)}`
        : `The agent's previous response to this task FAILED — the user had to correct it. Score 1.0 when ` +
          `the new response already addresses the correction, 0.0 when it repeats the failure.\n\n` +
          `Previous (failed) response:\n${(exp?.recordedResponse ?? '').slice(0, 1500)}\n\n` +
          `User's correction:\n${(exp?.followup ?? '(not recorded)').slice(0, 1000)}`;
      try {
        const obj = await generateJson({
          model,
          schema: v.object({
            score: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
            feedback: v.pipe(v.string(), v.minLength(1)),
          }),
          prompt:
            `Score this agent response on a 0..1 scale and give one sentence of specific, ` +
            `actionable feedback on how the agent's behaviour could improve.\n\n` +
            `Task:\n${instance.input}\n\nNew response:\n${output.slice(0, 4000)}\n\n` +
            `${criterion}\n\n` +
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
        trainSet,
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

  // ── Replay-eval loss curve ──────────────────────────────────────

  /** Run one replay-eval pass now: sample outcome-labeled turns, re-run them
   *  through the LIVE scaffold, score against the recorded outcomes, persist
   *  the loss entry. Also runs periodically inside lifetime evolution. */
  @callable()
  async runReplayEval(opts?: { sampleSize?: number }): Promise<ReplayEvalSummary | null> {
    return this.engine.runReplayEval(opts?.sampleSize);
  }

  /** The persisted loss curve (replay_evals), newest first. Read-only — the
   *  data a loss chart would render. */
  @callable()
  async getReplayEvals(limit: number = 50): Promise<ReplayEvalSummary[]> {
    return listReplayEvals(this.boundSql, limit);
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
   *  by UserDO.removeWorkspace on delete so a same-name recreate starts clean and no
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

  /** Run a scaffold against a task and return the concatenated text it
   *  produced. With candidateCode it is the GEPA metric's rollout; without,
   *  it rolls the LIVE scaffold — the replay-eval harness's current-config
   *  runner. */
  private async runScaffoldCaptureText(task: string, candidateCode?: string): Promise<string> {
    let text = '';
    const result = await runScaffold({
      rt: this.rt,
      task,
      scaffoldCodeOverride: candidateCode,
      emit: (ev) => { text += scaffoldEventText(ev) ?? ''; },
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

  // ── MCP server bridge — small RPCs the MCP handler needs ──
  /** Used by the /mcp/v1/<name> save_note tool. Routes through the same
   *  appendMemoryNote primitive as workspace.saveNote + the `memory` builtin. */
  async saveNoteFromMcp(content: string): Promise<{ ok: true }> {
    await appendMemoryNote(this.rt.memory, content);
    return { ok: true };
  }

  /** MCP `run_task`: inject a turn into the SAME serialized loop the event→turn
   *  reactor and background-job wake use (host.enqueueTurn → Think.saveMessages).
   *  Not a new execution path — the identical programmatic-turn seam. */
  async runTaskFromMcp(text: string): Promise<EnqueueTurnResult> {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) throw new Error('run_task requires non-empty text');
    return this.host.enqueueTurn({ text: trimmed, metadata: { proteusEvent: 'mcp' } });
  }

  /** MCP `send_peer`: fire-and-forget a message to one of the owner's other
   *  agents over the exact `team` tool transport (owner + same-owner roster
   *  gate enforced inside getTeamToolDeps). */
  async sendPeerFromMcp(input: { agent: string; topic?: string; message: string }): Promise<PeerSendOutcome> {
    if (!input?.agent || !input?.message) throw new Error('send_peer requires agent and message');
    return this.getTeamToolDeps().send({
      agent: input.agent,
      topic: (input.topic ?? '').trim() || 'message',
      message: input.message,
    });
  }

  /** MCP `send_peer` roster helper — the owner's other agents (self excluded). */
  async listPeersFromMcp(): Promise<Array<{ name: string; displayName?: string }>> {
    return this.getTeamToolDeps().listPeers();
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

  // ── SKILL.md export/import — make crafted tools git-friendly ──


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

  /** The workspace mount table — the CompositeVFS data surface behind the
   *  unified file browser. One row per environment (/local always; /sandbox,
   *  /nimbus, /pc as configured), with live state + declared policy. */
  @callable() async listMounts() {
    return this.rt.compositeVfs.listMounts();
  }

  /** The workspace's agent roster: this DO's orchestrator is the default
   *  agent (always present); the rest are the owner's team peers, reachable
   *  and spawnable via the `team` tool. Unowned workspaces have only their
   *  default agent. */
  @callable() async getWorkspaceAgents(): Promise<WorkspaceAgent[]> {
    const self = { name: this.name, displayName: this.getDisplayName() };
    if (!this.getOwnerUserId()) return buildWorkspaceAgents(self, []);
    try {
      return buildWorkspaceAgents(self, await this.requireOwnerUserDO().listWorkspaces());
    } catch {
      return buildWorkspaceAgents(self, []);
    }
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

  /** Typed directory listing for the file manager — read straight off the
   *  CompositeVFS for every executor (accurate types + sizes), workspace paths
   *  as-is and remote executors through their mount prefix. */
  @callable() async getExecutorFiles(executorId: string, path: string): Promise<{ entries?: DirEntry[]; error?: string }> {
    const dir = toCompositePath(executorId, path || '/');
    if (dir === null) return { error: `Executor "${executorId}" not found` };
    try {
      const names = await this.rt.storage.vfs.readdir(dir);
      const entries: DirEntry[] = [];
      for (const name of names) {
        const full = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
        // Entries of the composite root are mounts — directories by
        // construction, even when the environment behind one can't answer
        // a stat right now.
        let type: DirEntry['type'] = dir === '/' ? 'dir' : 'file';
        let size: number | undefined;
        try { const s = await this.rt.storage.vfs.stat(full); if (s) { type = s.isDir ? 'dir' : 'file'; size = s.size; } } catch { /* unstattable — keep the default */ }
        entries.push({ name, type, size });
      }
      return { entries: sortDirEntries(entries) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read a single file's text content for the file-manager viewer — off the
   *  CompositeVFS for every executor (structured bytes, not tool strings). Caps
   *  size and refuses binary (NUL byte). */
  @callable() async readExecutorFile(executorId: string, path: string): Promise<{ content?: string; truncated?: boolean; error?: string }> {
    if (!path) return { error: 'path required' };
    const target = toCompositePath(executorId, path);
    if (target === null) return { error: `Executor "${executorId}" not found` };
    const MAX = 512 * 1024;
    try {
      const stat = await this.rt.storage.vfs.stat(target);
      if (stat?.isDir) return { error: 'path is a directory' };
      const raw = await this.rt.storage.vfs.readFile(target, { encoding: 'utf8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (text.includes(String.fromCharCode(0))) return { error: 'binary file — not previewable' };
      if (text.length > MAX) return { content: text.slice(0, MAX), truncated: true };
      return { content: text };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Upload one file into an executor (file-manager drop/Upload) — binary-
   *  safe through the CompositeVFS for every executor (env-native paths map
   *  through the executor's mount prefix). */
  @callable() async writeExecutorFile(executorId: string, path: string, contentBase64: string): Promise<ExecutorWriteResult> {
    try {
      return await writeExecutorFileOp({ vfs: this.rt.storage.vfs }, executorId, path, contentBase64);
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

  /** Worker fan-out target (user/workspace-access notifyWorkspacesCredentialsChanged):
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

  @callable() async getMctsConfig() {
    // Effective values: stored overrides over the engine defaults — exactly
    // what the think-tool path and lifetime evolution will run with.
    const o = this.config.getMctsOverrides();
    const d = DEFAULT_CONFIG.mcts;
    return {
      explorationConstant: o.explorationWeight ?? d.explorationWeight,
      maxIterations: o.budget ?? d.budget,
      maxDepth: o.maxDepth ?? d.maxDepth,
      branchBudget: o.branches ?? d.branches,
    };
  }

  @callable() async setMctsConfig(config: {
    explorationConstant?: number; maxIterations?: number;
    maxDepth?: number; branchBudget?: number;
  }) {
    this.config.setMctsOverrides({
      explorationWeight: config.explorationConstant,
      budget: config.maxIterations,
      maxDepth: config.maxDepth,
      branches: config.branchBudget,
    });
    return config;
  }

  /**
   * Broadcast the current MCTS tree to all connected WebSocket clients.
   * Called after each MCTS iteration so the UI updates in real-time.
   */
  /**
   * Inference seam override — THE single production chat path on Think 0.8.
   *
   * Think's `_runInferenceLoop` is private and calls the AI SDK `streamText`
   * itself; this protected transform is the one seam a subclass gets that can
   * replace the stream every turn entry path consumes (the old
   * `runStreamText` override had zero callers on 0.8.2 — the scaffold was
   * silently dead until this re-wire). We route through the agent's mutable
   * scaffold IFF it has evolved one (current version > 0). An un-evolved
   * agent (still on the bootstrap v0) returns Think's result untouched —
   * same behaviour as before, zero overhead — until the evolution loop
   * proves + promotes a better scaffold via shadow eval. Once promoted, that
   * scaffold becomes the agent's live inference loop. One method, one
   * decision, no parallel paths (core scaffold/inference-transform.ts owns
   * the routing + orphan-stream semantics).
   *
   * The scaffold runs in the codemode sandbox and reaches the model/tools/
   * memory only through the `host.*` bridge (the live result object can't
   * cross the boundary). `host.defaultInference()` streams exactly THIS
   * prepared result back, so a delegating scaffold is byte-faithful to the
   * default; a custom scaffold can wrap or replace it.
   */
  protected _transformInferenceResult(result: StreamableResult): StreamableResult {
    let version = 0;
    try {
      version = this.sql<{ v: number }>`
        SELECT COALESCE(MAX(version), 0) AS v FROM scaffold_versions WHERE status = 'current'`[0]?.v ?? 0;
    } catch { /* table not initialized yet → treat as un-evolved */ }

    return scaffoldInferenceTransform({
      currentVersion: version,
      result,
      run: {
        rt: this.rt,
        // beforeTurn stashed this turn's prepared opts just before streamText
        // fired (turns are serialized on the TurnQueue, so it is THIS turn's).
        task: extractLastUserText((this._lastTurnOpts?.messages ?? []) as ModelMessage[]),
        llmStream: this.makeScaffoldLLMStream(),
        callTool: this.makeScaffoldCallTool(),
        timeoutMs: 5 * 60 * 1000,
      },
    });
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
    //    has identity data. Fresh DOs return an empty workspace_identity query.
    const env = this.env as unknown as {
      OrchestratorAgent: {
        idFromName(name: string): DurableObjectId;
        get(id: DurableObjectId): DurableObjectStub<OrchestratorAgent>;
      };
    };
    const forkStubForPrecheck = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(forkName));
    let existingIdentity: { id: string; name: string } | null = null;
    try {
      // A bare getAgentStatus call on a fresh DO may create workspace_identity,
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
      url: `/workspace/${forkName}`,
      forkPointMs: hit[0]!.created_at,
    };
  }

  /**
   * Receive a fork payload from a source agent. INTERNAL — called only by
   * the source DO's forkAgent RPC via cross-DO stub. NOT @callable: cross-DO
   * stub RPC never needed the decorator, and this is a raw storage write that
   * must never be reachable over the public agents WS/HTTP transport.
   */
  async rawCopyFromFork(payload: ForkPayload): Promise<{ ok: true; agentId: string }> {
    // Apply the FULL schema before copying rows. onStart runs on first access,
    // but this RPC can be invoked before it completes — ensureSchema creates
    // every table (not just initAllTables') so forkWorkspaceStorage's copy of
    // events-hub/heads/shadow/etc. rows never hits a missing table.
    this.ensureSchema();

    // Build an ephemeral SqlExecutor over the source's row payload. We don't
    // have cross-DO SQL queries — the payload IS the materialized source view.
    const srcSql = buildSqlFromPayload(payload);

    // Copy atomically. `this.boundSql` is a stable closure over `this.sql`
    // that preserves the `this`-binding the Agent base class needs.
    this.ctx.storage.transactionSync(() => {
      forkWorkspaceStorage(srcSql, this.boundSql, {
        untilMessageId: payload.lineage.forkOriginMessageId,
        targetWorkspaceId: this.ctx.id.toString(),
        targetWorkspaceName: payload.forkName,
        now: payload.lineage.forkedAt,
      });
    });

    return { ok: true, agentId: this.ctx.id.toString() };
  }

  /**
   * Snapshot every row the fork helper will need into a JSON-serializable
   * payload. Runs inside the source DO where `this.sql` has direct SQL access.
   */
  private buildForkPayload(untilMessageId: string, forkName: string): ForkPayload {
    const identity = this.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity LIMIT 1`;
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
      url: `/api/workspaces/${encodeURIComponent(this.name)}/webhook/${encodeURIComponent(id)}`,
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

    // Wake the agent to act on the new webhook event — an autonomous turn,
    // debounced so a delivery burst drains as ONE turn. Only when newly
    // admitted (a duplicate is already bound or in flight).
    if (admitted) this.orch.scheduleDrain();

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

  /** Peer-agent ingress: a sender agent's DO delivers one outbox message via
   *  cross-DO RPC. Ownership/grant checks run receiver-side (never trusted
   *  from the sender's claim beyond intra-Worker honesty); an admitted event
   *  either resolves the local ask waiter inline (a reply envelope) or wakes
   *  the agent through the standard drain → programmatic turn path. */
  async receivePeerMessage(msg: PeerMessage): Promise<ReceiveResult> {
    this.ensureSchema();
    return this.peerHub.receive(msg);
  }

  // ── Mission Inbox: email ingress + owner notifications ─────────

  /** Owner's verified login email (UserDO profile), or null when unknown. */
  private async getOwnerEmail(): Promise<string | null> {
    try {
      const userDO = this.getOwnerUserDO();
      if (!userDO) return null;
      return (await userDO.getProfile())?.email ?? null;
    } catch { return null; }
  }

  /** Union of active email_route allowlists (normally zero or one trigger). */
  private emailAllowlist(): string[] {
    try {
      return this.triggerRegistry.list({ kind: 'email_route', state: 'active' })
        .flatMap((t) => {
          const allow = (t.spec as { allow?: unknown }).allow;
          return Array.isArray(allow) ? allow.filter((a): a is string => typeof a === 'string') : [];
        });
    } catch { return []; }
  }

  /** Run an inbound email through the hub from within the agent DO — the
   *  email counterpart of acceptWebhookDelivery. The Worker `email()` handler
   *  parses MIME + resolves the agent; the trust gate (owner email /
   *  email_route allowlist), publish, and thread reply channel run here
   *  atomically. Unauthorized senders never produce an event row. */
  async acceptEmailDelivery(opts: {
    from: string;
    to: string;
    subject: string;
    body_text: string;
    message_id: string | null;
    in_reply_to: string | null;
    references: string | null;
    attachments: Array<{ filename: string; content_type: string; size: number }>;
    now: number;
  }): Promise<{ admitted: boolean; duplicate?: boolean; event_id?: string; reason?: string }> {
    const ownerEmail = await this.getOwnerEmail();
    if (!ownerEmail) return { admitted: false, reason: 'agent owner email unknown' };
    const result = acceptInboundEmail({
      log: this.eventLog,
      replies: this.replyChannels,
      owner_email: ownerEmail,
      allowlist: this.emailAllowlist(),
      tryConsumeRateLimit: (now) =>
        tryConsumeWebhookRateLimit(this.ctx.storage.sql, 'email:inbound', EMAIL_INBOUND_RATE_PER_MIN, now).allowed,
    }, opts);
    if (!result.admitted) return { admitted: false, reason: result.reason };
    // Wake the agent for a turn, debounced — only on fresh admission (a
    // duplicate delivery is already bound or in flight).
    if (!result.duplicate) this.orch.scheduleDrain();
    return { admitted: true, duplicate: result.duplicate, event_id: result.event_id };
  }

  /** The agent's email surface for the operator UI / routes. */
  @callable()
  async getEmailIngress(): Promise<{ address: string | null; allowlist: string[]; notifications: boolean }> {
    const domain = this.env.EMAIL_DOMAIN;
    return {
      address: domain ? agentEmailAddress(this.name, domain) : null,
      allowlist: this.emailAllowlist(),
      notifications: this.config.getEmailNotificationsEnabled(),
    };
  }

  /** Replace the inbound-email allowlist. The owner's own verified address is
   *  always allowed and never needs listing; one active email_route trigger
   *  (creator_trust recorded like every ingress) holds the extra senders, and
   *  an empty list just revokes it. Reached only through the owner-
   *  authenticated + step-up route. */
  @callable()
  async setEmailAllowlist(allow: string[]): Promise<{ allowlist: string[] }> {
    const cleaned = [...new Set(
      allow.map(normalizeEmailAddress).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)),
    )];
    const now = Date.now();
    for (const t of this.triggerRegistry.list({ kind: 'email_route' })) {
      if (t.state !== 'revoked') this.triggerRegistry.revoke(t.id, now);
    }
    if (cleaned.length > 0) {
      this.triggerRegistry.register({
        kind: 'email_route', spec: { allow: cleaned }, creator_trust: 'owner',
      }, now);
    }
    return { allowlist: cleaned };
  }

  /** Toggle owner-email notifications (changelog digests, job completions). */
  @callable()
  async setEmailNotifications(enabled: boolean): Promise<{ notifications: boolean }> {
    this.config.setEmailNotificationsEnabled(enabled);
    return { notifications: this.config.getEmailNotificationsEnabled() };
  }

  /** Fire-and-forget owner email. `email_notifications='false'` silences it;
   *  missing platform pieces (binding / domain / owner email) skip quietly.
   *  Also skipped while an operator socket is live — the owner sees the
   *  card in-app; email is the away channel, not a duplicate feed. */
  private emailOwnerNotification(subject: string, text: string): void {
    try {
      if (!this.config.getEmailNotificationsEnabled()) return;
      if (this.ctx.getWebSockets().length > 0) return;
    } catch { return; }
    void (async () => {
      await sendOwnerEmail({
        email: this.env.EMAIL,
        emailDomain: this.env.EMAIL_DOMAIN,
        agentName: this.name,
        agentDisplayName: this.safeDisplayName(),
        ownerEmail: await this.getOwnerEmail(),
      }, { subject, text });
    })().catch((err) => console.warn('[proteus-email] notification failed:', err));
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

