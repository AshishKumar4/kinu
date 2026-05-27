/**
 * The canonical 5-tool factory. Both CF and CLI surfaces call this — the
 * single source of truth for the LLM's capability surface.
 *
 * Tools emitted (in registration order):
 *   1. execute_tools  — requires a createExecuteTool factory (CF: codemode;
 *                       CLI: Node in-process sandbox from cli-backend).
 *                       Absent → returns a 'NOT CONFIGURED' error. Core
 *                       itself does NO codegen.
 *   2. run            — shell via executionRouter, workspace fallback to rt.shell
 *   3. explore        — MCTS via engine.onLifetimeEvolution
 *   4. save_note      — memory.append + memory.index
 *   5. search_memory  — memory.search
 *
 * Platform specifics (codemode loader, fiber wrap, MCTS broadcaster, MCTS
 * session factory, craftedToolExecute) are injected through BuiltinToolDeps
 * so the factory stays portable.
 */

import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { EvolutionEngine } from '../evolution/engine.js';
import type { SessionWriter } from '../mcts/record-node.js';
import { BUILTIN_TOOL_DESCRIPTIONS } from './registry.js';
import type { CraftedToolExecute } from './crafted-executor.js';
import { effectiveScore } from '../craft/ema.js';
import { DEFAULT_CONFIG } from '../config.js';
import { nanoid } from '../utils/nanoid.js';
import { appendMemoryNote } from '../memory/note.js';
import { hybridSearch, type LexicalHit } from '../memory/hybrid-search.js';
import { reviewCommand, formatApproval } from '../safety/approval-gate.js';

/**
 * Narrow local shape of @cloudflare/think/tools/execute#createExecuteTool.
 * Duck-typed so core has no peer dep on @cloudflare/think or @cloudflare/codemode.
 */
export type CreateExecuteToolFactory = (opts: {
  tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  providers: unknown[];
  loader: unknown;
}) => unknown;

export interface BuiltinToolDeps {
  rt: AgentRuntime;
  /** EvolutionEngine — required for the `explore` tool to trigger MCTS. */
  engine: EvolutionEngine;
  /**
   * Optional loader identifier forwarded into the createExecuteTool factory.
   * On CF this is env.LOADER (WorkerLoader); on CLI it's an opaque sentinel
   * to keep the factory branch active. Core does not inspect it.
   */
  codemodeLoader?: unknown;
  /**
   * Optional factory for createExecuteTool, injected by the CF adapter to
   * avoid pulling @cloudflare/think into core. Called only when
   * codemodeLoader is set.
   */
  createExecuteTool?: CreateExecuteToolFactory;
  /** Broadcast MCTS progress (CF pushes to WS; CLI is no-op). */
  onMctsProgress?: (phase: string, iteration?: number, budget?: number) => void;
  /** Factory for the SessionWriter used by `explore`. Default: in-memory. */
  createMctsSession?: () => SessionWriter;
  /**
   * Wrap the `explore` execute function — CF wraps with runFiber for durable
   * checkpointing. CLI omits (no-op wrap).
   */
  wrapExplore?: (
    fn: (args: { task: string; budget?: number }) => Promise<string>,
  ) => (args: { task: string; budget?: number }) => Promise<string>;
  /**
   * Called from inside the explore body at phase transitions so the adapter
   * can (e.g.) checkpoint via ctx.stash. Fires at 'starting' before MCTS,
   * 'running' after session setup, and 'completed' after engine returns.
   */
  onExplorePhase?: (phase: 'starting' | 'running' | 'completed', task: string) => void;
  /** Filter cutoff override (default: DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection). */
  minEffectiveScore?: number;
  /**
   * Platform-correct crafted-tool executor factory.
   *
   * - CF adapter supplies a LOADER-backed implementation that spawns a child
   *   Worker per tool via `env.LOADER.get(toolName, factory)`. Modules are
   *   compiled by workerd, sidestepping V8's codegen ban.
   * - CLI adapter supplies a Node-eval implementation (Node/Bun permits
   *   codegen).
   * - Absent: crafted tools are skipped silently (warn). Kept as an escape
   *   hatch for test runtimes / in-memory fixtures that don't wire an adapter.
   */
  craftedToolExecute?: CraftedToolExecute;
  /**
   * When supplied, used as-is for `execute_tools`. Both `codemodeLoader`
   * and `createExecuteTool` are ignored. The CF adapter uses this to
   * install a pre-constructed codemode tool wired to a `PreambleCraftedExecutor`
   * that splices a `const tools = {...}` preamble into the LLM's sandbox
   * arrow, so crafted tools are visible to subsequent `codemode.<name>(args)`
   * calls in the same turn. Core doesn't care how the tool is constructed —
   * it only needs the final ToolSet entry.
   */
  preBuiltExecuteTool?: unknown;
  /**
   * When supplied, used as-is for `split_heads`. The orchestrator builds this
   * via `createSplitHeadsTool` with a wired HeadController; core just slots it
   * into the ToolSet so the LLM can call it. Absent → no split_heads tool.
   */
  splitHeadsTool?: ToolSet[string];
  /**
   * Optional Vectorize-backed VectorStore for semantic memory recall.
   * When provided, search_memory does hybrid retrieval (FTS5 + Vectorize via
   * RRF) instead of FTS5-only. Falls back gracefully when not provided OR
   * when the underlying binding is unavailable.
   */
  vectorStore?: import('../memory/vector-store.js').VectorStore;
  /**
   * How to handle 'gate' decisions from the approval-gate review.
   *   'strict'    — reject gate commands until an approval-channel is wired (default)
   *   'allow_all' — treat gate as warn (logged but executed). Use for trusted
   *                 dev environments only. Set per-agent via the
   *                 setShellApprovalMode RPC.
   *   'deny_all'  — reject everything that isn't 'allow' (max safety)
   */
  shellApprovalMode?: 'strict' | 'allow_all' | 'deny_all';
  /** agent_facts world model. When provided, exposes remember/recall/forget_fact tools. */
  facts?: import('../memory/facts.js').FactsStore;
  /** Voyager/Tool-Search-style relevance filter for crafted tool surfacing.
   *  Default 'all'. In 'relevant' mode, only top-K matches (FTS5 by `query`
   *  ∪ frequently-used recent) are injected — saves context as the store
   *  grows large. */
  toolSurfacing?: {
    mode: 'all' | 'relevant';
    /** The user's task / current message — drives FTS5 relevance. */
    query?: string;
    /** Default 20. */
    maxRelevant?: number;
  };
  /** Unified `think(strategy, task, budget)` tool. Built by the orchestrator
   *  from the StrategyRegistry; core just slots it into the ToolSet. */
  thinkTool?: ToolSet[string];
}

/**
 * Build the crafted-tool map using a platform-correct executor factory.
 * All codegen lives behind `craftedToolExecute(tool)` — core has no
 * in-process code-generation path of its own.
 *
 * Filter semantics: effective-score >= minScore, comment-only code dropped,
 * every observed name recorded into `preexistingNames`.
 */
function buildCraftedToolSetFromExecute(
  rt: AgentRuntime,
  factory: CraftedToolExecute,
  minScore: number,
  preexistingNames: Set<string>,
  surfacing?: { mode: 'all' | 'relevant'; query?: string; maxRelevant?: number },
): Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }> {
  const out: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }> = {};
  let list;
  try {
    list = rt.craftStore.list();
  } catch {
    return out;
  }

  const now = Date.now();
  const scores = new Map<string, { score: number; lastUsedAt: number }>();
  try {
    const rows = rt.storage.sql<{ tool_name: string; score: number; last_used_at: number }>`
      SELECT tool_name, score, last_used_at FROM craft_scores`;
    for (const r of rows) scores.set(r.tool_name, { score: r.score, lastUsedAt: r.last_used_at });
  } catch {
    // craft_scores may not exist yet; treat all tools as unscored
  }

  for (const t of list) preexistingNames.add(t.name);

  // Relevance filter (Voyager / Tool-Search style): when the agent has many
  // crafted tools, stuffing them all into every turn wastes context and hurts
  // selection. In 'relevant' mode we fetch top-K via FTS5 over the current
  // user message, then union with the top-K most frequently used recent tools.
  let relevantNames: Set<string> | null = null;
  if (surfacing?.mode === 'relevant') {
    const maxRelevant = surfacing.maxRelevant ?? 20;
    const half = Math.max(5, Math.floor(maxRelevant / 2));
    relevantNames = new Set();
    if (surfacing.query && surfacing.query.length > 0) {
      try {
        for (const hit of rt.craftStore.search(surfacing.query, half)) relevantNames.add(hit.name);
      } catch { /* FTS not initialized yet */ }
    }
    // Pad with most-frequently-used recent tools (recency-weighted).
    try {
      const top = rt.storage.sql<{ tool_name: string }>`
        SELECT tool_name FROM craft_scores
        ORDER BY uses DESC, last_used_at DESC LIMIT ${maxRelevant}`;
      for (const r of top) relevantNames.add(r.tool_name);
    } catch { /* fine */ }
  }

  for (const t of list) {
    if (!t.code || t.code.startsWith('//')) continue;
    if (relevantNames && !relevantNames.has(t.name)) continue;
    const s = scores.get(t.name);
    if (s) {
      const eff = effectiveScore(s.score, s.lastUsedAt, now);
      if (eff < minScore) continue;
    }
    const description = t.description || `Crafted tool: ${t.name}`;
    try {
      const execute = factory({ name: t.name, description, code: t.code });
      out[t.name] = { description, execute: async (arg: unknown) => execute(arg) };
    } catch (err) {
      console.warn(`[proteus] Skipping broken crafted tool "${t.name}":`, (err as Error).message);
    }
  }

  return out;
}

/** Default in-memory SessionWriter when no backend-specific one is provided. */
function createInMemorySession(): SessionWriter {
  type StoredMessage = Parameters<SessionWriter['appendMessage']>[0];
  const messages: Array<{ message: StoredMessage; parentId: string | null }> = [];
  return {
    async appendMessage(message, parentId) {
      messages.push({ message, parentId: parentId ?? null });
    },
    getHistory() {
      return messages.map((m) => ({
        role: (m.message as { role?: string }).role ?? 'user',
        content: ((m.message as { parts?: ReadonlyArray<{ text?: string }> }).parts ?? [])
          .map((p) => p.text ?? '').join(''),
      }));
    },
    async compact() {
      /* no-op */
    },
  };
}

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolSet {
  const { rt, engine } = deps;
  const memory = rt.memory;
  const router = rt.executionRouter;
  const shell = rt.shell;
  const vfs = rt.storage.vfs;

  const tools: ToolSet = {};

  // ── 1. execute_tools ─────────────────────────────────────────────────────
  // single code path. Crafted tools always dispatch through
  // deps.craftedToolExecute (CF → LOADER Worker, CLI → Node eval).
  // Host-side codegen is GONE — the Proxy live-lookup that used it is
  // deleted, and the legacy in-process compile path is no longer here.
  const preexistingCraftNames = new Set<string>();
  const craftedToolSet = deps.craftedToolExecute
    ? buildCraftedToolSetFromExecute(
        rt,
        deps.craftedToolExecute,
        deps.minEffectiveScore ?? DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection,
        preexistingCraftNames,
        deps.toolSurfacing,
      )
    : {};

  if (deps.preBuiltExecuteTool) {
    tools.execute_tools = deps.preBuiltExecuteTool as ToolSet[string];
  } else if (deps.createExecuteTool) {
    try {
      const providers = router?.getProviders() ?? [];
      tools.execute_tools = deps.createExecuteTool({
        tools: craftedToolSet,
        providers,
        loader: deps.codemodeLoader,
      }) as ToolSet[string];
    } catch (err) {
      console.error('[proteus] createExecuteTool FAILED:', (err as Error).message);
    }
  }

  // no core-level fallback. Callers MUST supply createExecuteTool
  // (CF passes @cloudflare/think's real one; CLI passes a Node adapter
  // from @proteus/cli-backend/execute-tools-factory). If neither is wired,
  // execute_tools returns a sharp error — a silent in-process compile
  // would break in any V8 isolate.
  if (!tools.execute_tools) {
    tools.execute_tools = tool({
      description:
        BUILTIN_TOOL_DESCRIPTIONS.execute_tools +
        ' (NOT CONFIGURED — missing createExecuteTool factory on this runtime)',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
        required: ['code'],
      }),
      execute: async () => ({
        result: undefined,
        error:
          'execute_tools is not configured on this runtime. The backend must supply ' +
          'deps.createExecuteTool to buildBuiltinTools (CF: @cloudflare/think; CLI: ' +
          '@proteus/cli-backend/createNodeExecuteToolFactory).',
      }),
    });
  }

  // ── 2. run ───────────────────────────────────────────────────────────────
  tools.run = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.run,
    inputSchema: jsonSchema<{ command: string; executor?: string }>({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        executor: {
          type: 'string',
          description: 'Target executor: workspace (default), nimbus, sandbox, laptop',
        },
      },
      required: ['command'],
    }),
    execute: async (args: { command: string; executor?: string }) => {
      // Approval-gate pre-flight. See safety/approval-gate.ts for the
      // ruleset. Behavior at decision='gate' depends on the shellApprovalMode:
      //   strict     → reject (LLM gets a "Requires user approval" error)
      //   allow_all  → execute, log as warn (trusted dev environments only)
      //   deny_all   → reject all gate AND warn (max safety)
      const mode = deps.shellApprovalMode ?? 'strict';
      const review = reviewCommand(args.command);
      if (review.decision === 'deny') {
        return `Denied by approval gate:\n${formatApproval(review)}`;
      }
      if (review.decision === 'gate') {
        if (mode === 'allow_all') {
          console.warn(`[proteus] approval-gate gate→allow (allow_all mode): ${formatApproval(review)}`);
        } else {
          // strict + deny_all both reject gate decisions.
          return `Requires user approval (mode=${mode}). To allow, call ` +
                 `setShellApprovalMode('allow_all') on the agent.\n${formatApproval(review)}`;
        }
      }
      if (review.decision === 'warn') {
        if (mode === 'deny_all') {
          return `Denied by approval gate (deny_all mode):\n${formatApproval(review)}`;
        }
        console.warn(`[proteus] approval-gate warn: ${formatApproval(review)}`);
      }

      const key = args.executor ?? 'workspace';
      if (key !== 'workspace') {
        const provider = router?.getProvider(key);
        const execTool = provider?.tools.exec;
        if (execTool) return (await execTool.execute(args.command)) as string;
        return `Executor "${key}" not available.`;
      }
      if (!shell) return 'Error: no workspace shell available in this runtime.';
      const result = await shell.exec(args.command);
      if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
      return result.stdout || '(no output)';
    },
  });

  // ── 3. explore ───────────────────────────────────────────────────────────
  const exploreImpl = async (args: { task: string; budget?: number }): Promise<string> => {
    console.log(`[proteus] explore called: task="${args.task.slice(0, 80)}", budget=${args.budget ?? 'default'}`);
    try {
      deps.onExplorePhase?.('starting', args.task);
      deps.onMctsProgress?.('explore-starting');
      const session = deps.createMctsSession?.() ?? createInMemorySession();
      await session.appendMessage(
        { id: nanoid(), role: 'user' as const, parts: [{ type: 'text' as const, text: args.task }] },
        null,
      );
      deps.onExplorePhase?.('running', args.task);
      await engine.onLifetimeEvolution(session);
      deps.onMctsProgress?.('explore-completed');
      deps.onExplorePhase?.('completed', args.task);

      const allNodes = rt.storage.sql<{ id: string; action: string; value: number; status: string }>`
        SELECT id, action, value, status FROM search_nodes ORDER BY value DESC`;
      const best = allNodes.find((n) => n.status === 'terminal') ?? allNodes[0];
      if (best && best.action) {
        return `Exploration complete (${allNodes.length} nodes). Best approach (score ${best.value.toFixed(2)}): ${best.action}`;
      }
      return `Exploration complete. ${allNodes.length} nodes explored. Check the MCTS tree for results.`;
    } catch (err) {
      console.error('[proteus] explore FAILED:', (err as Error).message);
      return `Exploration failed: ${(err as Error).message}`;
    }
  };

  const wrappedExplore = deps.wrapExplore ? deps.wrapExplore(exploreImpl) : exploreImpl;

  tools.explore = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.explore,
    inputSchema: jsonSchema<{ task: string; budget?: number }>({
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The subproblem to explore' },
        budget: { type: 'number', description: 'MCTS iterations (default: 5)' },
      },
      required: ['task'],
    }),
    execute: wrappedExplore,
  });

  // ── 4. split_heads — parallel reasoning branches with LLM merge ──────────
  // Built by the orchestrator (which owns the HeadController + Facet runtime)
  // and slotted in here. Core doesn't reach into cf-backend internals.
  if (deps.splitHeadsTool) {
    tools.split_heads = deps.splitHeadsTool;
  }

  // Unified `think` tool — strategy dispatcher (single-shot / mcts / heads / …).
  // Built by the orchestrator (which owns the StrategyRegistry) and slotted in.
  if (deps.thinkTool) {
    tools.think = deps.thinkTool;
  }

  // ── 5. save_note ─────────────────────────────────────────────────────────
  tools.save_note = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.save_note,
    inputSchema: jsonSchema<{ content: string }>({
      type: 'object',
      properties: { content: { type: 'string', description: 'Note content' } },
      required: ['content'],
    }),
    execute: async (args: { content: string }) => appendMemoryNote(memory, args.content),
  });

  // ── agent_facts: typed, idempotent, keyed world model ──────────────────
  const facts = deps.facts;
  if (facts) {
    tools.remember_fact = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.remember_fact,
      inputSchema: jsonSchema<{ key: string; value: unknown; confidence?: number }>({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Stable identifier (e.g. "user.tz", "deploy.target")' },
          value: { description: 'Any JSON value — string, number, object, array' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: '0..1; default 1.0' },
        },
        required: ['key', 'value'],
      }),
      execute: async (args) => {
        // Pre-flight serialize so circular refs / non-serializable values
        // surface as a clean tool error instead of crashing the turn.
        try { JSON.stringify(args.value); }
        catch (err) { return { error: `value not JSON-serializable: ${(err as Error).message}` }; }
        if (typeof args.key !== 'string' || args.key.length === 0) {
          return { error: 'key must be a non-empty string' };
        }
        facts.upsert(args.key, args.value, { confidence: args.confidence });
        return { ok: true, key: args.key };
      },
    });
    tools.recall_fact = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.recall_fact,
      inputSchema: jsonSchema<{ key: string }>({
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      }),
      execute: async (args) => {
        const f = facts.recall(args.key);
        if (!f) return { found: false, key: args.key };
        return {
          found: true,
          key: f.key,
          value: f.value,
          confidence: f.confidence,
          source: f.source,
          lastObservedAt: f.lastObservedAt,
        };
      },
    });
    tools.forget_fact = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.forget_fact,
      inputSchema: jsonSchema<{ key: string }>({
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      }),
      execute: async (args) => {
        const existed = facts.recall(args.key) !== null;
        facts.forget(args.key);
        return { ok: true, key: args.key, existed };
      },
    });
  }

  // ── 6. search_memory ─────────────────────────────────────────────────────
  // Auto-hybrid: if a Vectorize-backed VectorStore is wired AND available,
  // run lexical + semantic in parallel and merge via RRF. Otherwise fall
  // back to pure FTS5. Same surface — caller doesn't need to feature-detect.
  const vs = deps.vectorStore;
  tools.search_memory = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.search_memory,
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    }),
    execute: async (args: { query: string }) => {
      if (vs && vs.available) {
        const lexicalFn = async (q: string, k: number): Promise<LexicalHit[]> => {
          const results = await memory.search(q, k);
          return results.map((r) => ({
            id: `${r.path}#${r.startLine}-${r.endLine}`,
            path: r.path, startLine: r.startLine, endLine: r.endLine,
            score: r.score, snippet: r.snippet,
          }));
        };
        const hits = await hybridSearch(args.query, lexicalFn, vs, { finalK: 10 });
        if (hits.length === 0) return 'No results found.';
        return hits.map((h) =>
          `[${h.path}:${h.startLine}-${h.endLine}] ` +
          `(rrf ${h.rrfScore.toFixed(3)}, sources: ${h.sources.join('+')})\n${h.snippet}`,
        ).join('\n\n');
      }
      const results = await memory.search(args.query, 10);
      if (results.length === 0) return 'No results found.';
      return results
        .map((r) => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`)
        .join('\n\n');
    },
  });

  return tools;
}
