/**
 * The canonical built-in tool factory. Both CF and CLI surfaces call this —
 * the single source of truth for the LLM's capability surface.
 *
 * The agent's tool surface is deliberately SMALL (fewer tools → better LLM
 * selection). Tools emitted (in registration order):
 *   1. execute_tools  — requires a createExecuteTool factory (CF: codemode;
 *                       CLI: Node in-process sandbox from cli-backend).
 *                       Absent → returns a 'NOT CONFIGURED' error. Core
 *                       itself does NO codegen.
 *   2. run            — shell via executionRouter; `runtime` param explicitly
 *                       chooses workspace / nimbus / sandbox / laptop, with
 *                       workspace (rt.shell) as the conservative default.
 *   3. skills         — Claude-Code / Hermes SKILL.md store; one tool, six
 *                       actions. Gated on deps.skills.
 *   4. agents         — the ONE delegation tool: ephemeral forks (heads /
 *                       mcts settle), persistent subordinates, and peer
 *                       workspace messaging behind a single action surface.
 *                       Gated on deps.agents; each ACTION is further gated on
 *                       the deps group that powers it (fork / team / peers),
 *                       so a CLI session gets fork only and a subordinate
 *                       actor never sees staff. See tools/agents-tool.ts.
 *   5. memory         — long-term prose notes: save / search (auto-hybrid FTS5
 *                       + Vectorize when a VectorStore is wired).
 *   6. fact           — typed keyed world model: remember / recall / forget.
 *                       Gated on deps.facts.
 *   7. experience     — cross-workspace transfer of proven crafts / lessons /
 *                       facts through the owner's library. Gated on
 *                       deps.experience (workspace orchestrator only).
 *   8. report         — the subordinate's progress spine back to its parent
 *                       workspace orchestrator. Gated on deps.report
 *                       (subordinate-only).
 *   9. product_change — governed product/UI self-customization lane.
 *                       Gated on deps.productChanges.
 *
 * Platform specifics (codemode loader, craftedToolExecute, the prebuilt
 * execute_tools, the agents fork substrate) are injected through
 * BuiltinToolDeps so the factory stays portable.
 */

import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import type { AgentRuntime } from '../types/agent-runtime.js';
import { BUILTIN_TOOL_DESCRIPTIONS } from './registry.js';
import { clampToolResult, withClampedToolResult } from './clamp.js';
import { TurnContextBudget } from '../context-budget.js';
import { isMcpToolKey } from './mcp-naming.js';
import type { CraftedToolExecute } from './crafted-executor.js';
import { filterByEffectiveScore } from '../craft/ema.js';
import { DEFAULT_CONFIG } from '../config.js';
import { appendMemoryNote } from '../memory/note.js';
import { hybridSearch, memorySnippetRehydrator, type LexicalHit } from '../memory/hybrid-search.js';
import { SessionSearchStore } from '../memory/session-search.js';
import { reviewCommand, formatApproval } from '../safety/approval-gate.js';
import { createAgentsTool, type AgentsToolDeps } from './agents-tool.js';
import { createExperienceTool, type ExperienceToolDeps } from './experience-tool.js';
import { runSkillsAction, type SkillsToolDeps, type SkillsAction } from '../skills/index.js';
import { WebFetchError, type WebSearchProvider, type WebSearchResponse } from '../web/index.js';
import {
  isEngineOwnedTransitionTarget,
  type ProductChangeApproval,
  type ProductChangeCheck,
  type ProductChangeEngine,
  type ProductChangeStatus,
  type ProductDeploymentRecord,
  type ProductSourceBinding,
} from '../product-change/index.js';

/**
 * Narrow local shape of the CLI's codemode tool factory
 * (@proteus/cli-backend/execute-tools-factory). Duck-typed so core has no peer
 * dep on a codemode implementation.
 */
export type CreateExecuteToolFactory = (opts: {
  tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
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
  /**
   * How to handle 'gate' decisions from the approval-gate review.
   *   'strict'    — reject gate commands until an approval-channel is wired (default)
   *   'allow_all' — treat gate as warn (logged but executed). Use for trusted
   *                 dev environments only. Set per-agent via the
   *                 setShellApprovalMode RPC.
   *   'deny_all'  — reject everything that isn't 'allow' (max safety)
   */
  shellApprovalMode?: 'strict' | 'allow_all' | 'deny_all';
  /** agent_facts world model. When provided, exposes the `fact` tool
   *  (remember / recall / forget actions). */
  facts?: import('../memory/facts.js').FactsStore;
  /** The owner's cross-workspace experience library. When provided, exposes
   *  the `experience` tool (publish / search / import). */
  experience?: ExperienceToolDeps;
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
  /** Skills store wiring. When provided, exposes the single `skills` tool
   *  (list/read/invoke/create/edit/delete actions). The orchestrator owns the
   *  per-turn invocation state and passes it back via `recordInvoke` /
   *  `currentlyInvoked`. */
  skills?: SkillsToolDeps;
  /** Product self-customization lane. Backend-supplied because persistence,
   *  source bindings, approval identity, and deployments are platform-owned. */
  productChanges?: ProductChangeToolDeps;
  /** Subordinate → parent progress reporting (the `report` tool). Wired only
   *  on subordinate actors. */
  report?: ReportToolDeps;
  /** Web search + fetch provider. Backend-supplied (the `fetch` impl and the
   *  Tavily-key auth seam differ per backend). Exposes the `web_search` and
   *  `web_fetch` tools — and the codemode `web.*` namespace is wired by the
   *  same provider in each backend's execute_tools assembly. */
  webSearch?: WebSearchProvider;
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

export interface ProductChangeToolDeps {
  board(): Promise<unknown>;
  bindSource(input: {
    kind: 'local' | 'github';
    label: string;
    repoUrl?: string | null;
    defaultBranch?: string | null;
    localDeviceId?: string | null;
    localRoot?: string | null;
    deployTarget?: string | null;
  }): Promise<ProductSourceBinding>;
  create(input: { bindingId: string; userPrompt: string; plan?: string | null }): Promise<unknown>;
  update(changeId: string, patch: { plan?: string | null; summary?: string | null; patch?: string | null; previewUrl?: string | null }): Promise<unknown>;
  transition(changeId: string, status: ProductChangeStatus): Promise<unknown>;
  recordCheck(changeId: string, input: {
    name: string;
    status: ProductChangeCheck['status'];
    stdout?: string | null;
    stderr?: string | null;
    durationMs?: number | null;
  }): Promise<ProductChangeCheck>;
  requestApproval(changeId: string, approvalType: ProductChangeApproval['approvalType']): Promise<ProductChangeApproval>;
  recordDeployment(changeId: string, input: {
    environment: ProductDeploymentRecord['environment'];
    workerVersionId?: string | null;
    deploymentId?: string | null;
    rollbackTarget?: string | null;
  }): Promise<ProductDeploymentRecord>;
  /** Execution engine beneath the ledger (apply/run_checks/preview/deploy/
   *  rollback grounded in real sandbox execution). When wired, the tool
   *  refuses manual transitions into engine-owned states and refuses
   *  record_deployment — those results are EARNED via the engine actions.
   *  Absent on backends without an execution substrate. */
  engine?: Pick<ProductChangeEngine, 'apply' | 'runChecks' | 'preview' | 'deploy' | 'rollback'>;
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

  for (const t of list) preexistingNames.add(t.name);

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
      out[t.name] = { description, execute: async (arg: unknown) => execute(arg) };
    } catch (err) {
      console.warn(`[proteus] Skipping broken crafted tool "${t.name}":`, (err as Error).message);
    }
  }

  return out;
}

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolSet {
  const { rt } = deps;
  const memory = rt.memory;
  const router = rt.executionRouter;
  const shell = rt.shell;
  // A toolset built without a budget still budgets — a fresh one, scoped to
  // whatever root owns this toolset. Never absent, so there is one policy.
  const budget = deps.contextBudget ?? new TurnContextBudget();

  const tools: ToolSet = {};

  // ── 1. execute_tools ─────────────────────────────────────────────────────
  // single code path. Crafted tools always dispatch through
  // deps.craftedToolExecute (CF → LOADER Worker, CLI → Node eval).
  // Host-side codegen is gone; crafted tools dispatch through the configured
  // runtime executor instead of compiling inside this module.
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
      // Approval-gate pre-flight — same ruleset across every runtime.
      // 'gate' behavior depends on shellApprovalMode (strict / allow_all /
      // deny_all). See safety/approval-gate.ts.
      const mode = deps.shellApprovalMode ?? 'strict';
      const review = reviewCommand(args.command);
      if (review.decision === 'deny') {
        return `Denied by approval gate:\n${formatApproval(review)}`;
      }
      if (review.decision === 'gate') {
        if (mode === 'allow_all') {
          console.warn(`[proteus] approval-gate gate→allow (allow_all mode): ${formatApproval(review)}`);
        } else {
          // Actionable for the MODEL: setShellApprovalMode is a backend RPC
          // it cannot call — the user changes the mode in agent settings.
          return `Requires user approval (mode=${mode}). Ask the user to approve this command ` +
                 `or change the shell approval mode in agent settings.\n${formatApproval(review)}`;
        }
      }
      if (review.decision === 'warn') {
        if (mode === 'deny_all') {
          return `Denied by approval gate (deny_all mode):\n${formatApproval(review)}`;
        }
        console.warn(`[proteus] approval-gate warn: ${formatApproval(review)}`);
      }

      // Restorable result budget — full stdout/stderr is offloaded to the
      // workspace VFS before clamping (see clamp.ts), so big outputs never
      // rot the session and nothing is lost.
      const clamp = (text: string) => clampToolResult(text, { vfs: rt.storage.vfs, budget, producer: 'run' });
      const defaultRuntime = 'workspace';
      const runtimeKey = args.runtime ?? defaultRuntime;
      if (runtimeKey === 'workspace') {
        if (!shell) return 'Error: no workspace shell available in this runtime.';
        const result = await shell.exec(args.command, signal ? { signal } : undefined);
        if (result.exitCode !== 0) return clamp(`Error (exit ${result.exitCode}): ${result.stderr}`);
        return clamp(result.stdout || '(no output)');
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

  // ── 2b. skills ──────────────────────────────────────────────────────────
  // Single LLM-facing tool, six actions. Only registered when the
  // orchestrator wires SkillsToolDeps (VFS + per-turn invoke tracker).
  if (deps.skills) {
    const skillsDeps = deps.skills;
    tools.skills = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.skills,
      inputSchema: jsonSchema<SkillsAction>({
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'invoke', 'create', 'edit', 'delete'],
            description: 'What to do.',
          },
          name: { type: 'string', description: 'Skill name (kebab-case). Required for everything except list.' },
          description: { type: 'string', description: 'For create/edit: one-line summary surfaced in the catalogue.' },
          body: { type: 'string', description: 'For create/edit: the natural-language workflow body (markdown).' },
          allowed_tools: {
            type: 'array', items: { type: 'string' },
            description: 'Optional tool surface restriction (e.g. ["run","memory"]). Empty = no restriction.',
          },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Optional auto-activation keywords.' },
          auto_activate: { type: 'boolean', description: 'Whether keyword matches auto-activate (default false).' },
          disable_model_invocation: { type: 'boolean', description: 'For create/edit: block the LLM from auto-invoking this skill (keyword/description match). Default false.' },
          user_invocable: { type: 'boolean', description: 'For create/edit: whether the user can invoke via /skill-name. Default true.' },
        },
        required: ['action'],
      }),
      execute: async (args: SkillsAction) => runSkillsAction(skillsDeps, args),
    });
  }

  // ── 3. agents — the ONE delegation tool ──────────────────────────────────
  // Fork dispatch (heads / mcts settle), subordinate staffing and peer
  // messaging behind a single action surface. Registered when any deps group
  // is wired; per-action gating lives in createAgentsTool.
  if (deps.agents && (deps.agents.fork || deps.agents.team || deps.agents.peers)) {
    tools.agents = createAgentsTool(deps.agents);
  }

  // ── 4. memory — long-term prose notes (save / search) ─────────────────────
  // search auto-hybridises: Vectorize-backed semantic + FTS5 lexical merged via
  // RRF when a VectorStore is wired + available; pure FTS5 otherwise.
  const vs = deps.vectorStore;
  const searchMemory = async (query: string): Promise<string> => {
    if (vs && vs.available) {
      const lexicalFn = async (q: string, k: number): Promise<LexicalHit[]> => {
        const results = await memory.search(q, k);
        return results.map((r) => ({
          // Canonical chunk id (`path:start-end`) — matches the id the vector
          // store returns, so RRF fuses the lexical and semantic hits.
          id: `${r.path}:${r.startLine}-${r.endLine}`,
          path: r.path, startLine: r.startLine, endLine: r.endLine,
          score: r.score, snippet: r.snippet,
        }));
      };
      const hits = await hybridSearch(query, lexicalFn, vs, {
        finalK: 10, rehydrate: memorySnippetRehydrator(memory),
      });
      if (hits.length === 0) return 'No results found.';
      return hits.map((h) =>
        `[${h.path}:${h.startLine}-${h.endLine}] ` +
        `(rrf ${h.rrfScore.toFixed(3)}, sources: ${h.sources.join('+')})\n${h.snippet}`,
      ).join('\n\n');
    }
    const results = await memory.search(query, 10);
    if (results.length === 0) return 'No results found.';
    return results
      .map((r) => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`)
      .join('\n\n');
  };
  // `sessions` action — zero-LLM FTS5 transcript recall over the canonical
  // messages table (one store, both backends). Mode inferred Hermes-style:
  // around_message_id → scroll, query → search, neither → browse.
  const sessionSearch = new SessionSearchStore(rt.storage.sql);
  const runSessionsAction = (args: {
    query?: string; around_message_id?: string; window?: number; limit?: number;
  }): unknown => {
    try {
      if (args.around_message_id) {
        const view = sessionSearch.scroll(args.around_message_id, args.window ?? 5);
        if (!view) return { error: `no message with id ${args.around_message_id}` };
        return { mode: 'scroll', ...view };
      }
      if (args.query?.trim()) {
        const hits = sessionSearch.search(args.query, args.limit ?? 5);
        return {
          mode: 'search', query: args.query, hits,
          hint: hits.length > 0
            ? 'Pass a hit\'s messageId as around_message_id to read the surrounding window.'
            : 'No matches. Multi-word queries require all terms; try fewer or different keywords.',
        };
      }
      return { mode: 'browse', sessions: sessionSearch.browse(args.limit ?? 10) };
    } catch (err) {
      return { error: `session search unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  tools.memory = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.memory,
    inputSchema: jsonSchema<{
      action: 'save' | 'search' | 'sessions';
      content?: string;
      query?: string;
      around_message_id?: string;
      window?: number;
      limit?: number;
    }>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'search', 'sessions'],
          description: 'save a note, search memory notes, or recall past session transcripts (sessions)',
        },
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
        limit: {
          type: 'number',
          description: 'For action=sessions: max search hits (default 5, max 10) or browsed sessions (default 10, max 20).',
        },
      },
      required: ['action'],
    }),
    execute: async (args: {
      action: 'save' | 'search' | 'sessions';
      content?: string;
      query?: string;
      around_message_id?: string;
      window?: number;
      limit?: number;
    }) => {
      if (args.action === 'save') {
        if (!args.content) return 'memory.save requires `content`.';
        return appendMemoryNote(memory, args.content);
      }
      if (args.action === 'sessions') return runSessionsAction(args);
      if (!args.query) return 'memory.search requires `query`.';
      return searchMemory(args.query);
    },
  });

  // ── 5. fact — typed, idempotent, keyed world model (remember/recall/forget) ──
  const facts = deps.facts;
  if (facts) {
    tools.fact = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.fact,
      inputSchema: jsonSchema<{ action: 'remember' | 'recall' | 'forget'; key: string; value?: unknown; confidence?: number }>({
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['remember', 'recall', 'forget'], description: 'what to do with the keyed fact' },
          key: { type: 'string', description: 'Stable identifier (e.g. "user.tz", "deploy.target")' },
          value: { description: 'For action=remember: any JSON value — string, number, object, array' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'For action=remember: 0..1; default 1.0' },
        },
        required: ['action', 'key'],
      }),
      execute: async (args) => {
        if (typeof args.key !== 'string' || args.key.length === 0) {
          return { error: 'key must be a non-empty string' };
        }
        if (args.action === 'remember') {
          // Pre-flight serialize so circular refs / non-serializable values
          // surface as a clean tool error instead of crashing the turn.
          try { JSON.stringify(args.value); }
          catch (err) { return { error: `value not JSON-serializable: ${(err as Error).message}` }; }
          facts.upsert(args.key, args.value, { confidence: args.confidence });
          return { ok: true, key: args.key };
        }
        if (args.action === 'recall') {
          const f = facts.recall(args.key);
          if (!f) return { found: false, key: args.key };
          return {
            found: true, key: f.key, value: f.value, confidence: f.confidence,
            source: f.source, lastObservedAt: f.lastObservedAt,
          };
        }
        // forget
        const existed = facts.recall(args.key) !== null;
        facts.forget(args.key);
        return { ok: true, key: args.key, existed };
      },
    });
  }

  // ── 6. experience — cross-workspace transfer of proven crafts/lessons/facts ──
  if (deps.experience) {
    tools.experience = createExperienceTool(deps.experience);
  }

  // ── 7. web_search / web_fetch — live web research ─────────────────────────
  // Two tools, the universal 2026 agent shape: web_search discovers ranked
  // results, web_fetch retrieves one URL as clean markdown. Both work key-less
  // (DuckDuckGo + Markdown-for-Agents); a stored `tavily` credential upgrades
  // search quality transparently. Codemode gets the same capability as
  // `web.search()` / `web.fetch()` via createWebCodemodeProvider, wired in each
  // backend's execute_tools assembly.
  const webSearch = deps.webSearch;
  if (webSearch) {
    tools.web_search = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.web_search,
      inputSchema: jsonSchema<{ query: string; limit?: number }>({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
          limit: { type: 'number', description: 'Max results (default 5, max 20).' },
        },
        required: ['query'],
      }),
      execute: async (args: { query: string; limit?: number }) => {
        try {
          const res = await webSearch.search(args.query, args.limit !== undefined ? { limit: args.limit } : undefined);
          return formatSearchResults(res);
        } catch (err) {
          return webErrorResult(err);
        }
      },
    });

    tools.web_fetch = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.web_fetch,
      inputSchema: jsonSchema<{ url: string }>({
        type: 'object',
        properties: { url: { type: 'string', description: 'The absolute http(s) URL to fetch.' } },
        required: ['url'],
      }),
      execute: async (args: { url: string }) => {
        try {
          const res = await webSearch.fetch(args.url);
          // Restorable clamp: oversized pages are offloaded to the workspace
          // VFS and reduced to a re-readable head (see clamp.ts), so a big
          // page never rots the session.
          const header = `# ${res.title ?? res.url}\nSource: ${res.url}\nRetrieved: ${res.retrievedAt}\n\n`;
          const body = await clampToolResult(res.markdown, {
            vfs: rt.storage.vfs, budget, producer: 'web_fetch',
          });
          return header + body;
        } catch (err) {
          return webErrorResult(err);
        }
      },
    });
  }

  // ── 8. report — subordinate → parent progress spine ────────────────────────
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

  // ── 9. product_change — governed product/UI self-customization lane ───────
  if (deps.productChanges) {
    const productChanges = deps.productChanges;
    tools.product_change = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.product_change,
      inputSchema: jsonSchema<{
        action:
          | 'board'
          | 'bind_source'
          | 'create'
          | 'update'
          | 'transition'
          | 'record_check'
          | 'request_approval'
          | 'record_deployment'
          | 'apply'
          | 'run_checks'
          | 'preview'
          | 'deploy'
          | 'rollback';
        binding?: {
          kind?: 'local' | 'github';
          label?: string;
          repoUrl?: string | null;
          defaultBranch?: string | null;
          localDeviceId?: string | null;
          localRoot?: string | null;
          deployTarget?: string | null;
        };
        changeId?: string;
        bindingId?: string;
        userPrompt?: string;
        plan?: string | null;
        summary?: string | null;
        patch?: string | null;
        previewUrl?: string | null;
        status?: ProductChangeStatus;
        check?: { name?: string; status?: ProductChangeCheck['status']; stdout?: string | null; stderr?: string | null; durationMs?: number | null };
        approvalType?: ProductChangeApproval['approvalType'];
        deployment?: {
          environment?: ProductDeploymentRecord['environment'];
          workerVersionId?: string | null;
          deploymentId?: string | null;
          rollbackTarget?: string | null;
          command?: string;
        };
        checks?: Array<{ name?: string; command?: string }>;
        port?: number;
        startCommand?: string;
      }>({
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'board', 'bind_source', 'create', 'update', 'transition', 'record_check', 'request_approval', 'record_deployment',
              'apply', 'run_checks', 'preview', 'deploy', 'rollback',
            ],
            description:
              'apply/run_checks/preview/deploy/rollback DRIVE the change for real in the sandbox ' +
              '(patch applied + committed, checks = real exit codes, preview = live URL, deploy/rollback verified).',
          },
          binding: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['local', 'github'] },
              label: { type: 'string' },
              repoUrl: { type: 'string' },
              defaultBranch: { type: 'string' },
              localDeviceId: { type: 'string' },
              localRoot: { type: 'string' },
              deployTarget: { type: 'string' },
            },
          },
          changeId: { type: 'string' },
          bindingId: { type: 'string' },
          userPrompt: { type: 'string' },
          plan: { type: 'string' },
          summary: { type: 'string' },
          patch: { type: 'string', description: 'Unified diff for display. The backend redacts sensitive-looking lines before storage.' },
          previewUrl: { type: 'string' },
          status: {
            type: 'string',
            enum: ['draft', 'planning', 'patching', 'validating', 'preview_ready', 'awaiting_approval', 'applying', 'deployed', 'rejected', 'rolled_back', 'failed'],
          },
          check: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'running', 'passed', 'failed', 'skipped'] },
              stdout: { type: 'string' },
              stderr: { type: 'string' },
              durationMs: { type: 'number' },
            },
          },
          approvalType: { type: 'string', enum: ['apply', 'deploy_staging', 'deploy_production', 'rollback'] },
          deployment: {
            type: 'object',
            properties: {
              environment: { type: 'string', enum: ['local', 'staging', 'production'] },
              workerVersionId: { type: 'string' },
              deploymentId: { type: 'string' },
              rollbackTarget: { type: 'string' },
              command: { type: 'string', description: 'Deploy (or rollback-redeploy) command run in the working copy, e.g. "bunx wrangler deploy". Defaults to the binding deployTarget when that reads like a command.' },
            },
          },
          checks: {
            type: 'array',
            description: 'For action=run_checks: build/test/lint commands run in the working copy; pass/fail comes from real exit codes.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, command: { type: 'string' } },
              required: ['name', 'command'],
            },
          },
          port: { type: 'number', description: 'For action=preview: the port your server listens on inside the sandbox.' },
          startCommand: { type: 'string', description: 'For action=preview: optional server start command run in the working copy before exposing the port.' },
        },
        required: ['action'],
      }),
      execute: async (args) => {
        try {
          switch (args.action) {
            case 'board':
              return await productChanges.board();
            case 'bind_source': {
              const b = args.binding ?? {};
              if (b.kind !== 'local' && b.kind !== 'github') return { error: 'binding.kind must be local or github' };
              if (!b.label) return { error: 'binding.label is required' };
              return await productChanges.bindSource({
                kind: b.kind,
                label: b.label,
                repoUrl: b.repoUrl,
                defaultBranch: b.defaultBranch,
                localDeviceId: b.localDeviceId,
                localRoot: b.localRoot,
                deployTarget: b.deployTarget,
              });
            }
            case 'create':
              if (!args.bindingId || !args.userPrompt) return { error: 'create requires bindingId and userPrompt' };
              return await productChanges.create({ bindingId: args.bindingId, userPrompt: args.userPrompt, plan: args.plan });
            case 'update':
              if (!args.changeId) return { error: 'update requires changeId' };
              return await productChanges.update(args.changeId, {
                plan: args.plan,
                summary: args.summary,
                patch: args.patch,
                previewUrl: args.previewUrl,
              });
            case 'transition':
              if (!args.changeId || !args.status) return { error: 'transition requires changeId and status' };
              if (productChanges.engine && isEngineOwnedTransitionTarget(args.status)) {
                return {
                  error:
                    `status '${args.status}' is earned by execution, not asserted — ` +
                    `use action=apply / run_checks / deploy / rollback to get there for real`,
                };
              }
              return await productChanges.transition(args.changeId, args.status);
            case 'record_check':
              if (!args.changeId || !args.check?.name || !args.check.status) return { error: 'record_check requires changeId, check.name, and check.status' };
              return await productChanges.recordCheck(args.changeId, {
                name: args.check.name,
                status: args.check.status,
                stdout: args.check.stdout,
                stderr: args.check.stderr,
                durationMs: args.check.durationMs,
              });
            case 'request_approval':
              if (!args.changeId || !args.approvalType) return { error: 'request_approval requires changeId and approvalType' };
              return await productChanges.requestApproval(args.changeId, args.approvalType);
            case 'record_deployment':
              if (!args.changeId || !args.deployment?.environment) return { error: 'record_deployment requires changeId and deployment.environment' };
              if (productChanges.engine) {
                return {
                  error:
                    'deployments are recorded from REAL deploy results — use action=deploy; ' +
                    'the version id and rollback target come from the actual command output',
                };
              }
              return await productChanges.recordDeployment(args.changeId, {
                environment: args.deployment.environment,
                workerVersionId: args.deployment.workerVersionId,
                deploymentId: args.deployment.deploymentId,
                rollbackTarget: args.deployment.rollbackTarget,
              });
            case 'apply':
            case 'run_checks':
            case 'preview':
            case 'deploy':
            case 'rollback': {
              const engine = productChanges.engine;
              if (!engine) {
                return { error: `action=${args.action} needs the execution engine, which this backend does not provide — the ledger actions (update/transition/record_check) remain available` };
              }
              if (!args.changeId) return { error: `${args.action} requires changeId` };
              switch (args.action) {
                case 'apply':
                  return await engine.apply(args.changeId);
                case 'run_checks':
                  if (!args.checks?.length) return { error: 'run_checks requires checks: [{ name, command }]' };
                  return await engine.runChecks(
                    args.changeId,
                    args.checks.map((c) => ({ name: c.name ?? '', command: c.command ?? '' })),
                  );
                case 'preview':
                  if (args.port == null) return { error: 'preview requires port (the port your server listens on)' };
                  return await engine.preview(args.changeId, { port: args.port, ...(args.startCommand ? { startCommand: args.startCommand } : {}) });
                case 'deploy':
                  if (!args.deployment?.environment) return { error: 'deploy requires deployment.environment (local | staging | production)' };
                  return await engine.deploy(args.changeId, {
                    environment: args.deployment.environment,
                    ...(args.deployment.command ? { command: args.deployment.command } : {}),
                  });
                case 'rollback':
                  return await engine.rollback(args.changeId, args.deployment?.command ? { command: args.deployment.command } : undefined);
              }
            }
          }
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
