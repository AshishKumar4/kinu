/**
 * The canonical built-in tool factory — the single source of truth for the
 * LLM's capability surface. An ACTOR is built from `buildActorTools`
 * (tools/actor-tools.ts), which is this factory plus the one tool this one
 * cannot hold; a head or a swarm node is built from this factory directly and
 * filtered by `keepBuiltins` (heads/types.ts).
 *
 * The agent's tool surface is deliberately SMALL: not for token cost, but
 * because every native tool is a standing choice the model weighs on EVERY
 * turn it is not the answer to, and selection accuracy degrades with choice
 * count. Tools emitted (in registration order):
 *   1. execute_tools  — the codemode sandbox. An actor builds it LAST, over
 *                       the finished surface, because the sandbox declares
 *                       every other tool as `tools.<name>` (see
 *                       `installExecuteTools` and tools/actor-tools.ts).
 *                       A confined surface hands in `preBuiltExecuteTool`.
 *                       Absent → returns a 'NOT CONFIGURED' error. Core
 *                       itself does NO codegen.
 *   2. run            — shell via executionRouter; `runtime` param explicitly
 *                       chooses workspace / sandbox / laptop, with
 *                       workspace (rt.shell) as the conservative default.
 *   3. file           — the ONE file plane: read / edit / write over the same
 *                       workspace filesystem every other surface addresses. The edit is
 *                       exact-match, atomic and unique-or-refused; the read is
 *                       capped and names the offset that continues it.
 *                       Unconditional — every runtime has rt.storage.vfs.
 *   4. agents         — the ONE delegation tool: ephemeral swarm nodes (heads /
 *                       mcts settle), persistent subordinates, and peer
 *                       workspace messaging behind a single action surface.
 *                       NOT registered here — see tools/actor-tools.ts, which
 *                       wraps this factory with it. Its implementation IS the
 *                       search engine (strategy/swarm-run → strategy/node-agent),
 *                       and a node's own surface comes back through this
 *                       factory, so holding it here was a runtime import cycle:
 *                       the module-scope reader at the far end of that ring is
 *                       what put six tests in the TDZ. No confined surface has
 *                       this tool anyway (HEAD_BUILTIN_TOOLS omits it), so the
 *                       split costs nothing it was buying.
 *   5. memory         — one durable-state tool: prose notes (save/search), the
 *                       typed keyed world model (remember/recall/forget), and
 *                       this agent's past conversation transcript
 *                       (conversations).
 *   6. tasks          — the agent's own task list: add/update/list over
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
 * Platform specifics (craftedToolExecute, the execute_tools builder) are
 * injected through BuiltinToolDeps so the factory stays portable; the agents
 * spawn substrate rides ActorToolDeps for the reason above.
 */

import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ExecutorProviderSurface } from '../execution/types';
import {
  BUILTIN_TOOL_DESCRIPTIONS, memoryToolSpec, renderToolSchemaDescription,
  memoryActionsFor, TASKS_TOOL_ACTIONS, WEB_TOOL_ACTIONS, unknownActionError, type WebToolAction,
} from './registry';
import type { ProfileCatalogEnvelope } from '../profiles/catalog';
import { TaskListStore, TASK_STATUSES } from '../tasks/store';
import { createAgentConfigStore } from '../config/store';
import { clampToolResult, withClampedToolResult } from './clamp';
import { dispatchReport, type ReportToolInput } from './report-tool';
import { SUBORDINATE_REPORT_STATUSES } from '../events/hub/types';
import { createFileToolSteer } from './run-file-steer';
import { createFileTool } from './file-tool';
import { TurnFileLedger } from './file-ledger';
import { TurnContextBudget } from '../context-budget';
import { isMcpToolKey } from './mcp-naming';
import { isReservedCraftToolName } from '../craft/in-episode';
import type { CraftedToolExecute, CraftedToolExecuteFn } from './crafted-executor';
import { filterByEffectiveScore } from '../craft/ema';
import { attributeCraftedFailure } from '../craft/attribution';
import { craftedToolDescription } from './sandbox-contract';
import { DEFAULT_CONFIG } from '../config';
import { formatExecResult, isFailingResultText, refusalText } from '../execution/exec-result';
import { TurnEscalationLedger } from '../execution/escalation';
import { createMemoryDispatcher, type MemoryToolInput } from './memory-tool';
import { createTasksDispatcher, type TasksToolInput } from './tasks-tool';
import { WebFetchError, type WebSearchProvider, type WebSearchResponse } from '../web/index';
import type { PlanEdit, SubmitPlanToolDeps } from '../plans/review';
import type { JsonValue } from '../utils/json';
import { diagnostics, KinuError, renderThrownChain, toKinuError, type Logger } from '../obs/index';

type ToolExecutionOptions = Parameters<NonNullable<ToolSet[string]['execute']>>[1];
type ExecutableToolEntry = NonNullable<ToolSet[string]>;

/** The crafted tools a sandbox may call, keyed by name. */
export type CraftedToolSet =
  Record<string, { description: string; execute: (arg: JsonValue) => Promise<JsonValue | undefined> }>;

/**
 * What a backend needs to build `execute_tools` for a FINISHED tool surface.
 * The sandbox declares every native tool as `tools.<name>(input)`, so it can
 * only be built once every other tool exists — which is why an actor's
 * builder runs in `buildActorTools`, after `agents` is registered, and not
 * inside `buildBuiltinTools`.
 */
export interface ExecuteToolsSurface {
  /** The finished surface. The sandbox never binds or declares its own entry
   *  (`renderToolsDeclaration`, `nativeToolFunctions` skip `execute_tools`). */
  readonly native: ToolSet;
  /** Resolved PER EXECUTE, not once per toolset: a tool the agent crafts
   *  mid-turn has to be callable on the very next `execute_tools` call, which
   *  is what the tool's own description promises and what the in-episode loop
   *  is for. Cheap to call — compiled bodies are memoised by name and code. */
  readonly craftedTools: () => CraftedToolSet;
  /** The live executor namespaces (`workspace`, `sandbox`, `laptop`, …). */
  readonly providers: ExecutorProviderSurface[];
}

/** Builds the `execute_tools` entry for one finished surface. The CLI's is
 *  `createNodeExecuteToolFactory` (@kinu.run/cli-backend); core has no
 *  codegen of its own. */
export type ExecuteToolsBuilder = (surface: ExecuteToolsSurface) => ToolSet[string];

export interface BuiltinToolDeps {
  rt: AgentRuntime;
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
   * A ready `execute_tools` entry for a CONFINED surface (a head, a swarm
   * node): those are built from this factory directly and finish their surface
   * themselves. A finished Tool is used as-is; heads/head-tools.ts and
   * strategy/node-agent.ts also accept a function of the finished surface,
   * resolved after their own filtering. An actor sets `executeTools` on
   * `buildActorTools` instead, which keeps the clamp and the effect claim on
   * the built entry.
   */
  preBuiltExecuteTool?: unknown;
  /**
   * Optional Vectorize-backed VectorStore for semantic memory recall.
   * When provided, memory.search does hybrid retrieval (FTS5 + Vectorize via
   * RRF) instead of FTS5-only. Falls back gracefully when not provided OR
   * when the underlying binding is unavailable.
   */
  vectorStore?: import('../memory/vector-store').VectorStore;
  /** agent_facts world model. When provided, the `memory` tool also exposes
   *  the keyed-fact actions (remember / recall / forget). */
  facts?: import('../memory/facts').FactsStore;
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
  /** Subordinate → parent progress reporting (the `report` tool). Wired only
   *  on subordinate actors. */
  report?: ReportToolDeps;
  /** Web search + fetch provider. Backend-supplied (the `fetch` impl and the
   *  Tavily-key auth seam differ per backend). Exposes the `web` tool — and the
   *  codemode `web.*` namespace is wired by the same provider in each backend's
   *  execute_tools assembly. */
  webSearch?: WebSearchProvider;
  /** Plan-mode-only review submission. Structural absence is the gate: normal
   *  Build/Chat toolsets do not contain submit_plan at all. */
  submitPlan?: SubmitPlanToolDeps;
  /** The turn's file ledger — what the model has read (so `file` can refuse a
   *  blind edit) and what its edits did (the durable `file_edit` row). Same
   *  ownership rule as contextBudget: backends pass their TurnAccumulator's, and
   *  a caller that omits it gets a fresh one, so the policy is per-root. */
  fileLedger?: TurnFileLedger;
  /** The turn's cumulative context budget — the per-result clamp tightens once
   *  a turn has admitted its budget, and every spill trip is counted for the
   *  durable `context_budget` row. Backends pass their TurnAccumulator's; a
   *  caller that omits it (a node's own toolset, tests) gets a fresh one, so
   *  the policy is per-root by construction. */
  contextBudget?: TurnContextBudget;
  /** The turn's escalation decisions — which provisioned environments `run` was
   *  sent to instead of the workspace shell, the model's stated reason, and the
   *  outcome. Same ownership rule as fileLedger/contextBudget: backends pass
   *  their TurnAccumulator's, and a caller that omits it gets a fresh one. */
  escalations?: TurnEscalationLedger;
  /**
   * Where a tool's refusals and handled failures are logged. Omitted everywhere
   * but a test: the default writes one JSON line per event to `console`, which is
   * what Workers Logs and the CLI journal both already collect.
   *
   * A test passes `createRecordingLogger()` and asserts the event name and the
   * classification — an instrument nobody asserts on is one nobody notices has
   * stopped.
   */
  logger?: Logger;
  /** THIS turn's profile catalog envelope, for tasks action=mode role
   *  switches. Absent: switching refuses with a clear reason. */
  roleAuthority?: () => ProfileCatalogEnvelope | null;
}

// ── Report (subordinate → parent) tool contract ─────────────────────────────

export interface ReportToolDeps {
  /** Publish a `subordinate_report` event into the PARENT workspace's
   *  EventLog (via the parent stub). */
  report(input: {
    status: import('../events/hub/types').SubordinateReportStatus;
    content: string;
  }): Promise<JsonValue | undefined>;
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
) {
  const out: CraftedToolSet = {};
  let list;
  try {
    list = rt.craftStore.list();
  } catch (error) {
    diagnostics.event('craft.list_unreadable', { error: renderThrownChain({ cause: error }) });
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
    // Neither read is guarded: `crafted_tools_fts` and the crafted_tools
    // quality columns are both part of the one workspace schema
    // (identity/workspace-schema.ts, asserted per root by conformance/
    // manifest.ts), and CraftStore.search quotes the
    // query as an FTS5 phrase so no user text can make it a syntax error. A
    // failure here means the workspace database is broken, and swallowing it
    // silently narrows the agent's callable set with no way to tell.
    if (surfacing.query && surfacing.query.length > 0) {
      for (const hit of rt.craftStore.search(surfacing.query, half)) relevantNames.add(hit.name);
    }
    const top = rt.storage.sql<{ name: string }>`
      SELECT name FROM crafted_tools
      ORDER BY uses DESC, last_used_at DESC LIMIT ${maxRelevant}`;
    for (const r of top) relevantNames.add(r.name);
  }

  for (const t of list) {
    if (!t.code || t.code.startsWith('//')) continue;
    if (isReservedCraftToolName(t.name)) {
      diagnostics.failure(
        CRAFT_TOOL_SKIPPED,
        toKinuError({
          doing: 'compile a crafted tool',
          cause: new KinuError('bad_input', `Crafted tool "${t.name}" is reserved — it collides with a built-in tool or the mcp_ prefix owned by MCP tools`),
          otherwise: 'bad_input',
        }),
        { tool: t.name },
      );
      continue;
    }
    if (relevantNames && !relevantNames.has(t.name)) continue;
    if (!scorePassing.has(t.name)) continue;
    const description = craftedToolDescription(t.name, t.description);
    try {
      const execute = factory({ name: t.name, description, code: t.code });
      out[t.name] = {
        description,
        // Stamped with the tool's identity so a failure is attributable to the
        // artifact rather than to the code around it (craft/attribution.ts).
        // THIS is the runtime attribution point for every crafted tool on every
        // backend — both the native and the sandbox surfaces resolve through
        // here — so a substrate must NOT wrap its own compile as well. Doing so
        // double-stamps, and since blame matches on the marker, one failure then
        // reads as several.
        execute: attributeCraftedFailure(t.name, execute),
      };
    } catch (err) {
      diagnostics.failure(
        CRAFT_TOOL_SKIPPED,
        toKinuError({ doing: 'compile a crafted tool', cause: err, otherwise: 'bad_input' }),
        { tool: t.name },
      );
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

const WebActionSchema = v.picklist(WEB_TOOL_ACTIONS);

interface WebToolInput {
  action: WebToolAction;
  query?: string;
  limit?: number;
  url?: string;
}

/**
 * This toolset's log event names. Declared as constants beside the code that
 * emits them, the way `SPAN_ATTR_*` is declared beside the tracer: what makes an
 * event findable across Workers Logs and the CLI journal is that the emitter and
 * the query spell it identically, and a constant is the only way to guarantee
 * that. Every one is a refusal or a handled failure — a THROWN error is not
 * logged here, because whoever catches it classifies it there.
 */
const RUN_SHELL_ABSENT = 'run.shell_absent';
const RUN_ESCALATION_REFUSED = 'run.escalation_refused';
const RUN_ESCALATION_FAILED = 'run.escalation_failed';
const CRAFT_TOOL_SKIPPED = 'craft.tool_skipped';

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolSet {
  const { rt } = deps;
  const memory = rt.memory;
  const router = rt.executionRouter;
  const shell = rt.shell;
  const runRuntimes = [...new Set([
    'workspace',
    ...(router?.listExecutors().map(({ name }) => name) ?? []),
  ])];
  // A toolset built without a budget still budgets — a fresh one, scoped to
  // whatever root owns this toolset. Never absent, so there is one policy.
  const budget = deps.contextBudget ?? new TurnContextBudget();
  // Same per-turn ownership as the budget: the turn's escalation decisions, so
  // `run` can record WHY it left the workspace shell at the moment it decides.
  const escalations = deps.escalations ?? new TurnEscalationLedger();
  // Same per-turn ownership as the budget: each hand-rolled-write shape gets
  // its note once, on the call that earned it (run-file-steer.ts).
  const fileToolSteer = createFileToolSteer();
  // The observability seam. A toolset built without one still logs: the console
  // logger writes one JSON line per event to the sink both backends already
  // collect. Never absent, so a refusal is never silent. `diagnostics`, not a
  // private console logger: the destination is the host's decision (obs/log.ts),
  // and a foreground CLI turn installs a file sink so this never lands between
  // the reader and their agent.
  const logger = deps.logger ?? diagnostics;

  const tools: ToolSet = {};

  // ── 1. execute_tools ─────────────────────────────────────────────────────
  // Registered FIRST so the sandbox heads the model's list, and filled here
  // only for a confined surface (`preBuiltExecuteTool`). An actor's sandbox
  // is built over the finished surface by `installExecuteTools`, which
  // reassigns this key in place, so the position holds.
  const prebuilt = { value: deps.preBuiltExecuteTool };
  // no core-level fallback. Callers MUST supply the tool one way or the other
  // (a confined surface: preBuiltExecuteTool; an actor: `executeTools` on
  // buildActorTools, built from @cloudflare/codemode in cf-backend/
  // execute-tools.ts or from @kinu.run/cli-backend/execute-tools-factory). If
  // neither is wired, execute_tools returns a sharp error — a silent
  // in-process compile would break in any V8 isolate.
  tools.execute_tools = isExecutableToolEntry(prebuilt) ? prebuilt.value : tool({
    description:
      BUILTIN_TOOL_DESCRIPTIONS.execute_tools +
      ' (NOT CONFIGURED — no execute_tools builder on this runtime)',
    inputSchema: jsonSchema<{ code: string }>({
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
      required: ['code'],
    }),
    execute: async () => ({
      result: undefined,
      error:
        'execute_tools is not configured on this runtime. The backend must supply ' +
        'deps.preBuiltExecuteTool to buildBuiltinTools or deps.executeTools to ' +
        'buildActorTools (CF: cf-backend/createExecuteToolsFactory; CLI: ' +
        '@kinu.run/cli-backend/createNodeExecuteToolFactory).',
    }),
  });

  // Restorable result budget: oversize execute_tools results are offloaded to
  // the workspace VFS and clamped to head+tail (see clamp.ts). The `run` tool
  // clamps at its own return sites below.
  tools.execute_tools = withClampedToolResult(tools.execute_tools, {
    vfs: rt.storage.vfs, budget, producer: 'execute_tools',
  });

  // ── 2. run ───────────────────────────────────────────────────────────────
  // Shell command tool. The `runtime` parameter dispatches through the
  // ExecutionRouter — workspace (default) hits the workspace's own Nimbus
  // shell, over the same bytes the `file` tool addresses; every other runtime
  // is a different machine, provisioned on demand via ExecutorProvider. No fallback
  // chain: if you ask for "sandbox" and sandbox isn't ready, you get a
  // structured error pointing at the install card, not silently routed
  // somewhere else.
  tools.run = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.run,
    inputSchema: jsonSchema<{ command: string; runtime?: string; device?: string; why?: string }>({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        runtime: {
          type: 'string',
          enum: runRuntimes,
          description:
            'Execution runtime. Use one of the environments listed in the system prompt — that list is live for this turn; check it instead of assuming availability. ' +
            'workspace is this agent\'s own shell over its own file plane, and the default only when runtime is omitted; the execution-status block says what that shell is on this backend and what it can run. ' +
            'Every other value names a registered environment; the live prompt states which files it addresses and any provisioning or consent semantics. Choose that runtime explicitly when the work lives there.',
        },
        device: {
          type: 'string',
          description:
            'For runtime "laptop": the machine this command runs on, by the name the live system state lists. Required when more than one of the user\'s machines is connected; a command that names none is refused. With one machine connected it may be omitted.',
        },
        why: {
          type: 'string',
          description:
            'Required when runtime is anything other than workspace: one short clause saying what that environment gives you that the workspace shell does not (a long-running process, an inbound port, real parallelism, resources). Recorded durably against the outcome, so it is how escalations get evaluated later — not a formality.',
        },
      },
      required: ['command'],
    }),
    execute: async (args: { command: string; runtime?: string; device?: string; why?: string }, options?: ToolExecutionOptions) => {
      const signal = options?.abortSignal;
      // No gate here — the approval ladder (reviewCommand / shellApprovalMode
      // / the interactive channel) lives at the execution seam this tool
      // dispatches to: the `shell` a workspace command runs through, and
      // every ExecutionRouter provider's `exec` for everything else (see
      // execution/approval.ts). That is also where codemode's
      // `workspace.exec()` / `sandbox.exec()` /
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
        if (!shell) {
          const refusal = new KinuError(
            'unsupported',
            'no workspace shell available in this runtime',
          );
          logger.failure(RUN_SHELL_ABSENT, refusal, { runtime: runtimeKey });
          return refusalText(refusal);
        }
        return clamp(formatExecResult(await shell.exec(args.command, signal ? { signal } : undefined)));
      }
      // Everything below this line is an ESCALATION: the work is leaving this
      // agent's own shell for an environment that must be provisioned, costs a
      // cold start, and shares a hard `max_instances` ceiling with every other
      // concurrent turn. Each exit path records the decision with the model's
      // stated reason — a REFUSED escalation is as informative as a successful
      // one, since "the runtime was never there" and "the command failed" are
      // different findings that a single failure count would merge.
      const provider = router?.getProvider(runtimeKey);
      if (!provider) {
        escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'refused' });
        // Caller asked for a runtime that hasn't been provisioned. Do NOT
        // silently fall back to workspace; that confuses the LLM into thinking
        // it has more access than it does.
        //
        // `unavailable`, never `unsupported`: a sandbox provisions on first use
        // and a laptop comes back when its daemon does, so this is a retry, and
        // a reader that filed it as a capability gap would report a cold start
        // as a missing feature. `error` keeps its literal token because the
        // install card matches on it (cf-backend WorkspacePage.tsx:76-80).
        const refusal = new KinuError('unavailable', 'runtime_not_provisioned');
        logger.failure(RUN_ESCALATION_REFUSED, refusal, { runtime: runtimeKey });
        return JSON.stringify({
          reason: refusal.code,
          error: refusal.message,
          runtime: runtimeKey,
          message:
            runtimeKey === 'laptop'
              ? 'The "laptop" runtime requires the Kinu PC daemon. Ask the user to install it from the Executors tab.'
              : runtimeKey === 'sandbox'
                ? 'The full Cloudflare Sandbox is not active yet. It will be auto-provisioned on first use — retry.'
                : `Runtime "${runtimeKey}" is not registered.`,
        });
      }
      const execTool = provider.tools.exec;
      if (!execTool) {
        escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'refused' });
        // `unsupported`, not `unavailable`: this environment is here and does
        // not have a shell. Retrying cannot change that, and the two codes exist
        // to keep those apart.
        const refusal = new KinuError('unsupported', 'runtime_does_not_support_exec');
        logger.failure(RUN_ESCALATION_REFUSED, refusal, { runtime: runtimeKey });
        return JSON.stringify({
          reason: refusal.code,
          error: refusal.message,
          runtime: runtimeKey,
          message: `Runtime "${runtimeKey}" is provisioned but does not expose shell exec.`,
        });
      }
      // The trailing context every executor's exec reads: the abort signal,
      // and — for a device runtime — which of the user's machines the command
      // is for. An executor with no fleet ignores the device.
      const context = { signal, device: args.device };
      let result: string;
      try {
        result = String(await execTool.execute(args.command, context));
      } catch (caught) {
        // A remote executor that cannot kill an in-flight command stops WAITING
        // and throws (execution/signal.ts), and the platform's own memory wall
        // throws prose. Both used to leave this tool by raising, so the durable
        // row recorded `threw` and the class was gone — the caller could not
        // tell a cancelled wait from an OOM from a dead transport. Classified
        // here and returned as a refusal the reader can branch on.
        const failure = toKinuError({
          doing: `run \`${args.command}\` on ${runtimeKey}`,
          cause: caught,
          otherwise: 'io',
        });
        escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'failed' });
        logger.failure(RUN_ESCALATION_FAILED, failure, { runtime: runtimeKey });
        return refusalText(failure);
      }
      // The ONE failure predicate (exec-result.ts). A non-zero exit comes back
      // as an ordinary successful result prefixed `Error (exit N)`, so reading
      // the transport discriminator here would score every failed command a win.
      escalations.observe({
        runtime: runtimeKey,
        reason: args.why,
        outcome: isFailingResultText(result) ? 'failed' : 'ok',
      });
      return clamp(result);
    },
  });

  // ── 3. file ─────────────────────────────────────────────────────────────
  // The file plane: read / edit / write over the same filesystem `run` and
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

  // ── 5. memory — the ONE durable-state tool ────────────────────────────────
  // Prose notes (save/search), the typed keyed world model
  // (remember/recall/forget), and the past conversation transcript are one
  // concept: state written now to be read later. They are actions here rather
  // than separate tools chosen by storage shape.
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
          enum: [...memoryActionsFor(!!facts)],
          description: facts
            ? 'remember/recall/forget a keyed fact, save/search prose notes, or read this agent’s past conversation'
            : 'save a note, search memory notes, or read this agent’s past conversation',
        },
        key: { type: 'string', description: 'For action=remember/recall/forget: a stable identifier (e.g. "user.tz", "deploy.target").' },
        value: { description: 'For action=remember: any JSON value — string, number, object, array.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'For action=remember: 0..1; default 1.0.' },
        content: { type: 'string', description: 'For action=save: the note text.' },
        query: {
          type: 'string',
          description: 'For action=search: the note query. For action=conversations: full-text query over prior messages (all terms must match; omit to browse archived roots).',
        },
        around_message_id: {
          type: 'string',
          description: 'For action=conversations: return messages around this message id instead of searching.',
        },
        window: {
          type: 'number',
          description: 'For action=conversations scroll: messages on each side of the anchor (default 5, max 20).',
        },
        max_chars: {
          type: 'number',
          description: 'For action=conversations scroll: per-message character budget (default 700). Raise it to read full messages; truncation says how much was cut.',
        },
        limit: {
          type: 'number',
          description: 'For action=conversations: max search hits (default 5, max 10) or archived roots (default 10, max 20).',
        },
      },
      required: ['action'],
    }),
    execute: async (args: MemoryToolInput) => runMemoryAction(args),
  });

  // ── 6. tasks — the agent's own task list and durable role ─────────────────
  // Unconditional, like `file` and `memory`: it needs one SQL handle and every
  // runtime has one. Both stores are constructed here rather than injected;
  // neither TaskListStore nor ConversationSearchStore holds process state.
  // Dispatch lives in tasks-tool.ts, shared verbatim with the `tasks.*`
  // codemode namespace (tasks-codemode.ts).
  const taskList = new TaskListStore(rt.storage.sql);
  const runTasksAction = createTasksDispatcher(taskList, createAgentConfigStore(rt.storage.sql), deps.roleAuthority);
  tools.tasks = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.tasks,
    inputSchema: jsonSchema<TasksToolInput>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...TASKS_TOOL_ACTIONS],
          description: 'add tasks, update one task\'s status, list the whole task list, or switch your durable active role',
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
        role: {
          type: 'string',
          description: 'For action=mode: the role id to switch to (kebab-case; the catalog defines which exist — unknown ids are refused with the known list). The switch applies from your NEXT turn. Omit to read the active role id.',
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
            enum: [...WEB_TOOL_ACTIONS],
            description: 'search the live web for ranked results, or fetch one URL as markdown',
          },
          query: { type: 'string', description: 'For action=search: the search query.' },
          limit: { type: 'number', description: 'For action=search: max results (default 5, max 20).' },
          url: { type: 'string', description: 'For action=fetch: the absolute http(s) URL to fetch.' },
        },
        required: ['action'],
      }),
      execute: async (args: WebToolInput) => {
        // The declared union is a request to the provider, not a guarantee
        // about what arrives: the AI SDK leaves `Schema.validate` undefined for
        // a jsonSchema-declared input. Refused WITH the vocabulary, so the
        // model's next call can succeed.
        const action = v.safeParse(WebActionSchema, args.action);
        if (!action.success) {
          return { error: unknownActionError('web', 'action', args.action, WEB_TOOL_ACTIONS) };
        }
        try {
          switch (action.output) {
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
          }
        } catch (err) {
          return webErrorResult(err instanceof Error ? err : String(err));
        }
      },
    });
  }

  // ── 8. report — subordinate → parent progress spine ───────────────────────
  if (deps.report) {
    const report = deps.report;
    tools.report = tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.report,
      inputSchema: jsonSchema<ReportToolInput>({
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...SUBORDINATE_REPORT_STATUSES],
            description: 'completed = the assignment is done. blocked = you need input to continue. progress = significant mid-task update.',
          },
          content: { type: 'string', maxLength: 20000, description: 'What to tell the orchestrator — findings, the result, or what you are blocked on.' },
        },
        required: ['status', 'content'],
      }),
      // The SAME dispatcher `report.*` in codemode calls, so one capability
      // validates its two arguments one way on both surfaces (this body used to
      // hand-check `content` and never check `status` at all).
      execute: async (args: ReportToolInput) => dispatchReport(report, args),
    });
  }

  // ── submit_plan — Plan mode's one completion surface ─────────────────────
  // It is intentionally outside BUILTIN_TOOLS: that registry describes the
  // stable surface every turn can build. This tool exists only on a Plan turn,
  // where ActorAgent wires this dependency and adds the name to activeTools.
  if (deps.submitPlan) {
    tools.submit_plan = tool({
      description: [
        'Submit the current Markdown implementation plan for interactive owner review.',
        'On the first call, write the full plan with one edit starting at line 1. After changes are requested, use the line numbers in the feedback turn to make targeted edits.',
        'Line numbers are one-indexed and inclusive; omit end to replace through the end of the plan. Do not implement after submission — end the turn and await the owner decision.',
      ].join('\n'),
      inputSchema: jsonSchema<{ edits: PlanEdit[] }>({
        type: 'object',
        properties: {
          edits: {
            type: 'array', minItems: 1, maxItems: 100,
            items: {
              type: 'object',
              properties: {
                start: { type: 'integer', minimum: 1, description: 'First affected line, one-indexed.' },
                end: { type: ['integer', 'null'], minimum: 1, description: 'Last affected line, inclusive. Omit to replace through end of plan.' },
                content: { type: 'string', description: 'Replacement Markdown. Empty with an explicit end deletes the range.' },
              },
              required: ['start', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['edits'],
        additionalProperties: false,
      }),
      execute: async ({ edits }: { edits: PlanEdit[] }) => {
        const result = await deps.submitPlan!.submit(edits);
        if (!result.ok) return result;
        return {
          ok: true,
          planId: result.plan.id,
          revision: result.plan.revision,
          status: result.plan.status,
          message: 'Plan submitted and awaiting review. Do not implement or produce a preview; end this turn now.',
        };
      },
    });
  }

  // No builtin may take the `mcp_` prefix (isMcpToolKey is the one predicate,
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
function webErrorResult(err: Error | string) {
  if (err instanceof WebFetchError) {
    return err.retriable ? { error: err.message, retriable: true } : { error: err.message };
  }
  return { error: err instanceof Error ? err.message : err };
}

export function isExecutableToolEntry(
  input: { value: unknown },
): input is { value: ExecutableToolEntry } {
  return v.is(v.object({
    inputSchema: v.unknown(),
    execute: v.function(),
  }), input.value);
}

/**
 * Build `execute_tools` over a FINISHED surface and put it in place.
 *
 * The sandbox declares every other tool as `tools.<name>(input)`, so the
 * builder runs after the last tool is registered. `buildActorTools` calls this
 * once `agents` is in, before the effect-claim wrap, so the built entry keeps
 * both the result clamp and the claim the registry declares for it. The
 * crafted set is resolved per execute and memoised per (name, code): a stored
 * body compiles once, and again only when the agent rewrites it.
 */
export function installExecuteTools(
  surface: ToolSet,
  build: ExecuteToolsBuilder,
  deps: BuiltinToolDeps,
): void {
  const { rt } = deps;
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
  const built = build({ native: surface, craftedTools, providers: rt.executionRouter?.getProviders() ?? [] });
  const clamp = { vfs: rt.storage.vfs, producer: 'execute_tools' as const };
  surface.execute_tools = withClampedToolResult(
    built,
    deps.contextBudget ? { ...clamp, budget: deps.contextBudget } : clamp,
  );
}
