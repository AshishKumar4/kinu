/**
 * The canonical built-in tool factory. Both CF and CLI surfaces call this —
 * the single source of truth for the LLM's capability surface.
 *
 * The agent's tool surface is deliberately SMALL: not for token cost, but
 * because every native tool is a standing choice the model weighs on EVERY
 * turn it is not the answer to, and selection accuracy degrades with choice
 * count. Tools emitted (in registration order):
 *   1. execute_tools  — requires a createExecuteTool factory (CF: codemode;
 *                       CLI: Node in-process sandbox from cli-backend).
 *                       Absent → returns a 'NOT CONFIGURED' error. Core
 *                       itself does NO codegen.
 *   2. run            — shell via executionRouter; `runtime` param explicitly
 *                       chooses workspace / nimbus / sandbox / laptop, with
 *                       workspace (rt.shell) as the conservative default.
 *   3. file           — the ONE file plane: read / edit / write over the same
 *                       CompositeVFS every other surface addresses. The edit is
 *                       exact-match, atomic and unique-or-refused; the read is
 *                       capped and names the offset that continues it.
 *                       Unconditional — every runtime has rt.storage.vfs.
 *   4. agents         — the ONE delegation tool: ephemeral forks (heads /
 *                       mcts settle), persistent subordinates, and peer
 *                       workspace messaging behind a single action surface.
 *                       Gated on deps.agents; each ACTION is further gated on
 *                       the deps group that powers it (fork / team / peers),
 *                       so a CLI session gets fork only and a subordinate
 *                       actor never sees staff. See tools/agents-tool.ts.
 *   5. memory         — the ONE durable-state tool: prose notes (save / search,
 *                       auto-hybrid FTS5 + Vectorize when a VectorStore is
 *                       wired), the typed keyed world model (remember / recall
 *                       / forget, gated on deps.facts) and past session
 *                       transcripts (sessions).
 *   6. tasks          — the agent's own task list: add / update / list over
 *                       one workspace table. Unconditional; every runtime has
 *                       rt.storage.sql.
 *   7. web            — live web access: search / fetch. Gated on
 *                       deps.webSearch.
 *   8. report         — the subordinate's progress spine back to its parent
 *                       workspace orchestrator. Gated on deps.report
 *                       (subordinate-only).
 *
 * `skills` (list/read/create/edit/delete SKILL.md files) and `release`
 * (the governed product/UI self-customization lane) are NOT native tools:
 * skills are ordinary files under /workspace/skills/, already reachable via
 * `workspace.readFile`/`writeFile`/`readdir` in execute_tools — a dedicated
 * tool would have been a third path to the same bytes. `release`'s machinery
 * (ledger + engine) is untouched and reachable as the `release.*` codemode
 * namespace (tools/release-codemode.ts) — occasional and high-blast-radius
 * enough that it does not earn a standing top-level choice.
 *
 * Platform specifics (codemode loader, craftedToolExecute, the prebuilt
 * execute_tools, the agents fork substrate) are injected through
 * BuiltinToolDeps so the factory stays portable.
 */

import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import type { AgentRuntime } from '../types/agent-runtime.js';
import {
  BUILTIN_TOOL_DESCRIPTIONS, memoryToolSpec, renderToolSchemaDescription,
  MEMORY_NOTE_ACTIONS, MEMORY_FACT_ACTIONS, TASKS_TOOL_ACTIONS,
  type MemoryToolAction, type TasksToolAction,
} from './registry.js';
import { TaskListStore, TASK_STATUSES } from '../tasks/store.js';
import { clampToolResult, withClampedToolResult } from './clamp.js';
import { createFileToolSteer } from './run-file-steer.js';
import { createFileTool } from './file-tool.js';
import { TurnFileLedger } from './file-ledger.js';
import { TurnContextBudget } from '../context-budget.js';
import { isMcpToolKey } from './mcp-naming.js';
import type { CraftedToolExecute, CraftedToolExecuteFn } from './crafted-executor.js';
import { filterByEffectiveScore } from '../craft/ema.js';
import { craftInvocationError } from '../craft/in-episode.js';
import { DEFAULT_CONFIG } from '../config.js';
import { formatExecResult } from '../execution/exec-result.js';
import { createAgentsTool, type AgentsToolDeps } from './agents-tool.js';
import { createMemoryDispatcher, type MemoryToolInput } from './memory-tool.js';
import { createTasksDispatcher, type TasksToolInput } from './tasks-tool.js';
import { WebFetchError, type WebSearchProvider, type WebSearchResponse } from '../web/index.js';

/** The crafted tools a sandbox may call, keyed by name. */
export type CraftedToolSet =
  Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;

/**
 * Narrow local shape of the CLI's codemode tool factory
 * (@proteus/cli-backend/execute-tools-factory). Duck-typed so core has no peer
 * dep on a codemode implementation.
 */
export type CreateExecuteToolFactory = (opts: {
  /** Resolved PER EXECUTE, not once per toolset: a tool the agent crafts
   *  mid-turn has to be callable on the very next `execute_tools` call, which
   *  is what the tool's own description promises and what the in-episode loop
   *  is for. Cheap to call — compiled bodies are memoised by name and code. */
  craftedTools: () => CraftedToolSet;
  providers: unknown[];
  loader: unknown;
}) => unknown;

export interface BuiltinToolDeps {
  rt: AgentRuntime;
  /**
   * Optional loader identifier forwarded into the createExecuteTool factory —
   * an opaque sentinel that keeps the factory branch active. Core does not
   * inspect it. Unused on CF, which supplies `preBuiltExecuteTool` instead.
   */
  codemodeLoader?: unknown;
  /**
   * Optional factory that BUILDS the execute_tools tool from the crafted-tool
   * set and the runtime's execution providers. The CLI wires it; CF hands a
   * ready-made tool through `preBuiltExecuteTool` instead, because its codemode
   * tool needs a construction shape this factory does not express. Called only
   * when codemodeLoader is set.
   */
  createExecuteTool?: CreateExecuteToolFactory;
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
   * Optional Vectorize-backed VectorStore for semantic memory recall.
   * When provided, memory.search does hybrid retrieval (FTS5 + Vectorize via
   * RRF) instead of FTS5-only. Falls back gracefully when not provided OR
   * when the underlying binding is unavailable.
   */
  vectorStore?: import('../memory/vector-store.js').VectorStore;
  /** agent_facts world model. When provided, the `memory` tool also exposes
   *  the keyed-fact actions (remember / recall / forget). */
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
  /** The `agents` delegation tool's deps: fork substrate (StrategyRegistry +
   *  model + host-injected infra) and/or subordinate + peer transports. The
   *  tool is registered when ANY group is wired; actions gate per group. */
  agents?: AgentsToolDeps;
  /** Subordinate → parent progress reporting (the `report` tool). Wired only
   *  on subordinate actors. */
  report?: ReportToolDeps;
  /** Web search + fetch provider. Backend-supplied (the `fetch` impl and the
   *  Tavily-key auth seam differ per backend). Exposes the `web` tool — and the
   *  codemode `web.*` namespace is wired by the same provider in each backend's
   *  execute_tools assembly. */
  webSearch?: WebSearchProvider;
  /** The turn's file ledger — what the model has read (so `file` can refuse a
   *  blind edit) and what its edits did (the durable `file_edit` row). Same
   *  ownership rule as contextBudget: backends pass their TurnAccumulator's, and
   *  a caller that omits it gets a fresh one, so the policy is per-root. */
  fileLedger?: TurnFileLedger;
  /** The turn's cumulative context budget — the per-result clamp tightens once
   *  a turn has admitted its budget, and every spill trip is counted for the
   *  durable `context_budget` row. Backends pass their TurnAccumulator's; a
   *  caller that omits it (a fork's own toolset, tests) gets a fresh one, so
   *  the policy is per-root by construction. */
  contextBudget?: TurnContextBudget;
}

// The Team/Peers deps contracts (and the reserved peer-reply topic) live with
// the tool that consumes them — tools/agents-tool.ts — and are re-exported
// here for the backends that implement them.
export {
  PEER_REPLY_TOPIC,
  type AgentsToolDeps, type AgentsForkDeps,
  type TeamToolDeps, type SubordinateRosterEntry, type SubordinateStatus,
  type SubordinateDelivery, type SubordinatePhase, type SubordinateHandoff,
  type PeersToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './agents-tool.js';

// ── Report (subordinate → parent) tool contract ─────────────────────────────

export interface ReportToolDeps {
  /** Publish a `subordinate_report` event into the PARENT workspace's
   *  EventLog (via the parent stub). */
  report(input: {
    status: import('../events/hub/types.js').SubordinateReportStatus;
    content: string;
  }): Promise<unknown>;
}

// ReleaseToolDeps lives in tools/release-tool.ts now — the release lane's
// only caller is the release.* codemode namespace, not this file.

/**
 * Build the crafted-tool map using a platform-correct executor factory.
 * All codegen lives behind `craftedToolExecute(tool)` — core has no
 * in-process code-generation path of its own.
 *
 * Filter semantics: effective-score >= minScore, comment-only code dropped.
 * Read fresh on every call, so a tool crafted mid-turn is here on the next one.
 */
function buildCraftedToolSetFromExecute(
  rt: AgentRuntime,
  factory: CraftedToolExecute,
  minScore: number,
  surfacing?: { mode: 'all' | 'relevant'; query?: string; maxRelevant?: number },
): CraftedToolSet {
  const out: CraftedToolSet = {};
  let list;
  try {
    list = rt.craftStore.list();
  } catch {
    return out;
  }

  // Single injection policy — shared with the CF preamble path.
  const scorePassing = new Set(
    filterByEffectiveScore(rt.storage.sql, list, minScore).map((t) => t.name),
  );

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
    if (!scorePassing.has(t.name)) continue;
    const description = t.description || `Crafted tool: ${t.name}`;
    try {
      const execute = factory({ name: t.name, description, code: t.code });
      out[t.name] = {
        description,
        // Stamped with the tool's identity so a failure is attributable to the
        // artifact rather than to the code around it (craft/in-episode.ts).
        execute: async (arg: unknown) => {
          try {
            return await execute(arg);
          } catch (err) {
            throw craftInvocationError(t.name, err);
          }
        },
      };
    } catch (err) {
      console.warn(`[proteus] Skipping broken crafted tool "${t.name}":`, (err as Error).message);
    }
  }

  return out;
}

/** One compiled body per (name, code). The platform factories are documented
 *  as idempotent, so re-deriving the same tool is safe — it is just wasteful,
 *  and it now happens once per `execute_tools` call rather than once per turn. */
function memoizeCraftedExecute(factory: CraftedToolExecute): CraftedToolExecute {
  const compiled = new Map<string, { code: string; execute: CraftedToolExecuteFn }>();
  return (tool) => {
    const hit = compiled.get(tool.name);
    if (hit && hit.code === tool.code) return hit.execute;
    const execute = factory(tool);
    compiled.set(tool.name, { code: tool.code, execute });
    return execute;
  };
}

interface WebToolInput {
  action: 'search' | 'fetch';
  query?: string;
  limit?: number;
  url?: string;
}

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolSet {
  const { rt } = deps;
  const memory = rt.memory;
  const router = rt.executionRouter;
  const shell = rt.shell;
  // A toolset built without a budget still budgets — a fresh one, scoped to
  // whatever root owns this toolset. Never absent, so there is one policy.
  const budget = deps.contextBudget ?? new TurnContextBudget();
  // Same per-turn ownership as the budget: each hand-rolled-write shape gets
  // its note once, on the call that earned it (run-file-steer.ts).
  const fileToolSteer = createFileToolSteer();

  const tools: ToolSet = {};

  // ── 1. execute_tools ─────────────────────────────────────────────────────
  // single code path. Crafted tools always dispatch through
  // deps.craftedToolExecute (CF → LOADER Worker, CLI → Node eval).
  // Host-side codegen is gone; crafted tools dispatch through the configured
  // runtime executor instead of compiling inside this module.
  // Memoised per toolset: the crafted set is re-read on every execute, and
  // compiling a stored body is a real cost on both adapters (a child Worker on
  // cf, `new Function` on the CLI). Keyed by code as well as name, so a tool
  // the agent rewrites mid-turn recompiles rather than running its old body.
  const craftedToolExecute = deps.craftedToolExecute
    ? memoizeCraftedExecute(deps.craftedToolExecute)
    : undefined;
  const craftedTools = (): CraftedToolSet => craftedToolExecute
    ? buildCraftedToolSetFromExecute(
        rt,
        craftedToolExecute,
        deps.minEffectiveScore ?? DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection,
        deps.toolSurfacing,
      )
    : {};

  if (deps.preBuiltExecuteTool) {
    tools.execute_tools = deps.preBuiltExecuteTool as ToolSet[string];
  } else if (deps.createExecuteTool) {
    try {
      const providers = router?.getProviders() ?? [];
      tools.execute_tools = deps.createExecuteTool({
        craftedTools,
        providers,
        loader: deps.codemodeLoader,
      }) as ToolSet[string];
    } catch (err) {
      console.error('[proteus] createExecuteTool FAILED:', (err as Error).message);
    }
  }

  // no core-level fallback. Callers MUST supply the tool one way or the other
  // (CF: preBuiltExecuteTool, built from @cloudflare/codemode in
  // cf-backend/execute-tools.ts; CLI: a Node adapter from
  // @proteus/cli-backend/execute-tools-factory). If neither is wired,
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
          'deps.preBuiltExecuteTool or deps.createExecuteTool to buildBuiltinTools ' +
          '(CF: cf-backend/createExecuteToolsTool; CLI: ' +
          '@proteus/cli-backend/createNodeExecuteToolFactory).',
      }),
    });
  }

  // Restorable result budget: oversize execute_tools results are offloaded to
  // the workspace VFS and clamped to head+tail (see clamp.ts). The `run` tool
  // clamps at its own return sites below.
  tools.execute_tools = withClampedToolResult(tools.execute_tools, {
    vfs: rt.storage.vfs, budget, producer: 'execute_tools',
  });

  // ── 2. run ───────────────────────────────────────────────────────────────
  // Shell command tool. The `runtime` parameter dispatches through the
  // ExecutionRouter — workspace (default) hits the in-VFS virtual shell;
  // anything else is provisioned-on-demand via ExecutorProvider. No fallback
  // chain: if you ask for "sandbox" and sandbox isn't ready, you get a
  // structured error pointing at the install card, not silently routed
  // somewhere else.
  tools.run = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.run,
    inputSchema: jsonSchema<{ command: string; runtime?: string }>({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        runtime: {
          type: 'string',
          enum: ['workspace', 'nimbus', 'sandbox', 'laptop'],
          description:
            'Execution runtime. Use one of the environments listed in the system prompt — that list is live for this turn; check it instead of assuming availability. ' +
            'workspace is the internal Proteus VFS shell and the default only when runtime is omitted. ' +
            "laptop is the user's own PC, available when their device is connected; its first use may pause for a user consent prompt (expected, not an error). " +
            'Choose nimbus, sandbox, or laptop explicitly when that environment is the right execution target.',
        },
      },
      required: ['command'],
    }),
    execute: async (args: { command: string; runtime?: string }, options?: unknown) => {
      const signal = readAbortSignal(options);
      // No gate here — the approval ladder (reviewCommand / shellApprovalMode
      // / the interactive channel) lives at the execution seam this tool
      // dispatches to: the `shell` a workspace command runs through, and
      // every ExecutionRouter provider's `exec` for everything else (see
      // execution/approval.ts). That is also where codemode's
      // `workspace.exec()` / `nimbus.exec()` / `sandbox.exec()` /
      // `laptop.exec()` land, so the same command answers to the identical
      // decision whichever path reached it — not a check re-derived here.

      // Restorable result budget — full stdout/stderr is offloaded to the
      // workspace VFS before clamping (see clamp.ts), so big outputs never
      // rot the session and nothing is lost. A command that hand-rolls a file
      // edit carries the `file` steer back with it, the first time this turn
      // uses that shape (run-file-steer.ts) — outside the clamp, so the note is
      // never the part that gets truncated.
      const steer = fileToolSteer(args.command);
      const clamp = async (text: string) => {
        const clamped = await clampToolResult(text, { vfs: rt.storage.vfs, budget, producer: 'run' });
        return steer ? `${steer}\n\n${clamped}` : clamped;
      };
      const defaultRuntime = 'workspace';
      const runtimeKey = args.runtime ?? defaultRuntime;
      if (runtimeKey === 'workspace') {
        if (!shell) return 'Error: no workspace shell available in this runtime.';
        return clamp(formatExecResult(await shell.exec(args.command, signal ? { signal } : undefined)));
      }
      const provider = router?.getProvider(runtimeKey);
      if (!provider) {
        // Caller asked for a runtime that hasn't been provisioned. Return a
        // structured-but-readable error — the UI watches for this and surfaces
        // the install card. Do NOT silently fall back to workspace; that
        // confuses the LLM into thinking it has more access than it does.
        return JSON.stringify({
          error: 'runtime_not_provisioned',
          runtime: runtimeKey,
          message:
            runtimeKey === 'laptop'
              ? 'The "laptop" runtime requires the Proteus PC daemon. Ask the user to install it from the Executors tab.'
              : runtimeKey === 'sandbox'
                ? 'The full Cloudflare Sandbox is not active yet. It will be auto-provisioned on first use — retry.'
                : runtimeKey === 'nimbus'
                  ? 'Nimbus sandbox is not reachable. Check the NIMBUS_SESSION Durable Object binding.'
                  : `Runtime "${runtimeKey}" is not registered.`,
        });
      }
      const execTool = provider.tools.exec;
      if (!execTool) {
        return JSON.stringify({
          error: 'runtime_does_not_support_exec',
          runtime: runtimeKey,
          message: `Runtime "${runtimeKey}" is provisioned but does not expose shell exec.`,
        });
      }
      return clamp(String(await execTool.execute(args.command, signal ? { signal } : undefined)));
    },
  });

  // ── 3. file ─────────────────────────────────────────────────────────────
  // The file plane: read / edit / write over the same CompositeVFS `run` and
  // execute_tools address, so one tool serves every mount on both backends.
  // Unconditional — every runtime has rt.storage.vfs, and a model without an
  // exact-match editor falls back to sed -i and heredocs, which is what this
  // replaces.
  tools.file = createFileTool({
    vfs: rt.storage.vfs,
    ledger: deps.fileLedger ?? new TurnFileLedger(),
    budget,
    memory,
  });

  // ── agents — the ONE delegation tool ──────────────────────────────────
  // Fork dispatch (heads / mcts settle), subordinate staffing and peer
  // messaging behind a single action surface. Registered when any deps group
  // is wired; per-action gating lives in createAgentsTool.
  if (deps.agents && (deps.agents.fork || deps.agents.team || deps.agents.peers)) {
    tools.agents = createAgentsTool(deps.agents);
  }

  // ── 5. memory — the ONE durable-state tool ────────────────────────────────
  // Prose notes (save / search), the typed keyed world model (remember /
  // recall / forget) and past session transcripts (sessions) are one concept —
  // state written down now to be read back later — so they are actions here
  // rather than separate tools the model must choose between by storage shape.
  // search auto-hybridises: Vectorize-backed semantic + FTS5 lexical merged via
  // RRF when a VectorStore is wired + available; pure FTS5 otherwise.
  // Dispatch lives in memory-tool.ts, shared verbatim with the `memory.*`
  // codemode namespace (memory-codemode.ts) — one implementation, two callers.
  const facts = deps.facts;
  const runMemoryAction = createMemoryDispatcher({
    memory, vectorStore: deps.vectorStore, facts, sql: rt.storage.sql,
  });
  tools.memory = tool({
    description: renderToolSchemaDescription(memoryToolSpec(!!facts)),
    inputSchema: jsonSchema<MemoryToolInput>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...MEMORY_NOTE_ACTIONS, ...(facts ? MEMORY_FACT_ACTIONS : [])],
          description: facts
            ? 'remember/recall/forget a keyed fact, save/search prose notes, or read past session transcripts (sessions)'
            : 'save a note, search memory notes, or recall past session transcripts (sessions)',
        },
        key: { type: 'string', description: 'For action=remember/recall/forget: a stable identifier (e.g. "user.tz", "deploy.target").' },
        value: { description: 'For action=remember: any JSON value — string, number, object, array.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'For action=remember: 0..1; default 1.0.' },
        content: { type: 'string', description: 'For action=save: the note text.' },
        query: {
          type: 'string',
          description: 'For action=search: the search query. For action=sessions: full-text query over past session messages (all terms must match; omit to browse recent sessions).',
        },
        around_message_id: {
          type: 'string',
          description: 'For action=sessions: scroll — return the messages around this message id (from a prior search hit or scroll window) instead of searching.',
        },
        window: {
          type: 'number',
          description: 'For action=sessions scroll: messages on each side of the anchor (default 5, max 20).',
        },
        max_chars: {
          type: 'number',
          description: 'For action=sessions scroll: per-message character budget (default 700). Raise it to read full messages — truncated messages say how much was cut.',
        },
        limit: {
          type: 'number',
          description: 'For action=sessions: max search hits (default 5, max 10) or browsed sessions (default 10, max 20).',
        },
      },
      required: ['action'],
    }),
    execute: async (args: MemoryToolInput) => runMemoryAction(args),
  });

  // ── 6. tasks — the agent's own task list ──────────────────────────────────
  // Unconditional, like `file` and `memory`: it needs one SQL handle and every
  // runtime has one. The store is constructed here rather than injected for
  // the same reason SessionSearchStore is — it holds no state of its own.
  // Dispatch lives in tasks-tool.ts, shared verbatim with the `tasks.*`
  // codemode namespace (tasks-codemode.ts).
  const taskList = new TaskListStore(rt.storage.sql);
  const runTasksAction = createTasksDispatcher(taskList);
  tools.tasks = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.tasks,
    inputSchema: jsonSchema<TasksToolInput>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...TASKS_TOOL_ACTIONS],
          description: 'add tasks, update one task\'s status, or list the whole task list',
        },
        titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'For action=add: one title per task, in the order you plan to do them. Write the whole plan in one call.',
        },
        parent: {
          type: 'string',
          description: 'For action=add: the id of the task these are subtasks of (e.g. "t2"). Omit for top-level tasks. Subtasks nest one level only.',
        },
        id: { type: 'string', description: 'For action=update: the task id, as `add` or `list` returned it (e.g. "t3").' },
        status: {
          type: 'string',
          enum: [...TASK_STATUSES],
          description: 'For action=update: active when you start the item, done when it is finished, dropped when it is no longer needed, open to reopen it.',
        },
      },
      required: ['action'],
    }),
    execute: async (args: TasksToolInput) => runTasksAction(args),
  });

  // ── 7. web — live web research (search / fetch) ───────────────────────────
  // One capability used as a pair: search discovers ranked results, fetch
  // retrieves one URL as clean markdown, and the doctrine is to loop them.
  // Both work key-less (DuckDuckGo + Markdown-for-Agents); a stored `tavily`
  // credential upgrades search quality transparently. Codemode gets the same
  // capability as `web.search()` / `web.fetch()` via createWebCodemodeProvider,
  // wired in each backend's execute_tools assembly.
  const webSearch = deps.webSearch;
  if (webSearch) {
    tools.web = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.web,
      inputSchema: jsonSchema<WebToolInput>({
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'fetch'],
            description: 'search the live web for ranked results, or fetch one URL as markdown',
          },
          query: { type: 'string', description: 'For action=search: the search query.' },
          limit: { type: 'number', description: 'For action=search: max results (default 5, max 20).' },
          url: { type: 'string', description: 'For action=fetch: the absolute http(s) URL to fetch.' },
        },
        required: ['action'],
      }),
      execute: async (args: WebToolInput) => {
        try {
          switch (args.action) {
            case 'search': {
              if (!args.query) return { error: 'web.search requires `query`' };
              const res = await webSearch.search(args.query, args.limit !== undefined ? { limit: args.limit } : undefined);
              return formatSearchResults(res);
            }
            case 'fetch': {
              if (!args.url) return { error: 'web.fetch requires `url`' };
              const res = await webSearch.fetch(args.url);
              // Restorable clamp: oversized pages are offloaded to the
              // workspace VFS and reduced to a re-readable head (see
              // clamp.ts), so a big page never rots the session.
              const header = `# ${res.title ?? res.url}\nSource: ${res.url}\nRetrieved: ${res.retrievedAt}\n\n`;
              const body = await clampToolResult(res.markdown, {
                vfs: rt.storage.vfs, budget, producer: 'web_fetch',
              });
              return header + body;
            }
            default:
              return { error: `unknown web action '${String(args.action)}'` };
          }
        } catch (err) {
          return webErrorResult(err);
        }
      },
    });
  }

  // ── 8. report — subordinate → parent progress spine ───────────────────────
  if (deps.report) {
    const report = deps.report;
    tools.report = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.report,
      inputSchema: jsonSchema<{ status: 'progress' | 'completed' | 'blocked'; content: string }>({
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['progress', 'completed', 'blocked'],
            description: 'completed = the assignment is done. blocked = you need input to continue. progress = significant mid-task update.',
          },
          content: { type: 'string', maxLength: 20000, description: 'What to tell the orchestrator — findings, the result, or what you are blocked on.' },
        },
        required: ['status', 'content'],
      }),
      execute: async (args: { status: 'progress' | 'completed' | 'blocked'; content: string }) => {
        if (!args.content?.trim()) return { error: 'report requires non-empty content' };
        try {
          return await report.report({ status: args.status, content: args.content });
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  // MCP tools land under the `mcp_<server>_<name>` prefix (core mcpToolKey,
  // shared by both backends). Reserve that prefix exclusively for MCP so a
  // future builtin can't silently collide with a user's MCP server.
  for (const name of Object.keys(tools)) {
    if (isMcpToolKey(name)) {
      throw new Error(
        `Builtin tool name '${name}' starts with the reserved 'mcp_' prefix. ` +
        `That prefix is owned by per-user MCP tools — pick a different name.`,
      );
    }
  }

  return tools;
}

/** Render search results model-ready: a ranked list of title + url + snippet
 *  (+ date when present), with the synthesized answer first when available. */
function formatSearchResults(res: WebSearchResponse): string {
  if (res.results.length === 0) {
    return `No web results for "${res.query}".`;
  }
  const lines: string[] = [];
  if (res.answer) lines.push(`Answer: ${res.answer}`, '');
  for (const r of res.results) {
    const date = r.date ? ` (${r.date})` : '';
    lines.push(`${r.position}. ${r.title}${date}\n   ${r.url}\n   ${r.snippet}`);
  }
  lines.push('', `[${res.results.length} results via ${res.source}]`);
  return lines.join('\n');
}

/** Map a web tool failure to an honest, model-actionable error object. */
function webErrorResult(err: unknown): { error: string; retriable?: boolean } {
  if (err instanceof WebFetchError) {
    return err.retriable ? { error: err.message, retriable: true } : { error: err.message };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

function readAbortSignal(options: unknown): AbortSignal | undefined {
  if (!options || typeof options !== 'object' || !('abortSignal' in options)) return undefined;
  const signal = (options as { abortSignal?: unknown }).abortSignal;
  return isAbortSignal(signal) ? signal : undefined;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object' && value !== null && 'aborted' in value && 'addEventListener' in value;
}
