/**
 * Canonical built-in tool factory. Actors use `buildActorTools` (adds `agents`, which cannot live
 * here without an import cycle); heads and swarm nodes use this directly, filtered by `keepBuiltins`.
 * Skills are plain files and `release` is a codemode namespace, not native tools.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ConversationRecall } from '../memory/conversation-search';
import type { ExecutorProviderSurface } from '../execution/types';
import {
  BUILTIN_TOOL_DESCRIPTIONS, memoryToolSpec, renderToolSchemaDescription, keepBuiltins, narrowToolSurface,
} from './registry';
import { TaskListStore } from './task-store';
import { withClampedToolResult } from './clamp';
import { withCheckedInput, withCheckedInputs } from './tool-schema';
import { withEffectClaims, type EffectClaimDeps } from './effect-claim';
import { codemodeInputSchema } from './sandbox-contract';
import { dispatchReport, ReportBodySchema, ReportToolInputSchema } from './report-tool';
import type { SubordinateReportHandoff, SubordinateReportStatus } from '../events/hub/types';
import { createFileTool } from './file-tool';
import { createShellTool } from './shell-tool';
import { TurnFileLedger } from '../vfs/file-ledger';
import { TurnContextBudget } from '../context-budget';
import { isMcpToolKey } from './mcp-naming';
import { selectInjectableCraftedTools, type CraftedToolSource } from './crafted-executor';
import { TurnEscalationLedger } from '../execution/escalation';
import { createMemoryDispatcher, memoryToolInputSchema } from './memory-tool';
import { createTasksDispatcher, TasksToolInputSchema, type RoleSwitch } from './tasks-tool';
import type { WebSearchProvider } from '../web/index';
import { createWebTool } from './web-tool';
import { PlanEditSchema, type SubmitPlanToolDeps } from '../types/plans';
import type { JsonValue } from '../utils/json';
import { Effect } from 'effect';
import { diagnostics, KinuError, settle, settleSync, type Logger } from '../obs/index';
// heads/types.ts holds no runtime import, so this edge cannot close a ring.
import { toolsInWorkMode, permitInPlan } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';

type ExecutableToolEntry = NonNullable<ToolSet[string]>;

/** Builds `eval` over a finished surface: the sandbox declares every other tool, so it runs last. */
export interface CodemodeSurface {
  readonly native: ToolSet;
  /** Read per execute so a tool crafted mid-turn is callable on the next `eval`; compiled in the program. */
  readonly craftedTools: () => readonly CraftedToolSource[];
  /**
   * The turn's MCP and extension tools, read per execute: callable as `tools.<name>` only through `eval`, never a
   * native definition, so the tools prefix stays the same in every workspace. The dynamic block declares them.
   */
  readonly external: () => ToolSet;
  readonly providers: ExecutorProviderSurface[];
  /** Where a program's relative paths start, its `process.cwd()`: the runtime's own (`PathPlanes.cwd`). */
  readonly cwd: string;
}

/** Core has no codegen; the CLI supplies `createNodeCodemodeToolFactory`. */
export type CodemodeBuilder = (surface: CodemodeSurface) => ToolSet[string];

/** The one reader of a runtime's crafted tools, for every `eval` built over its surface. */
export function codemodeSurface(
  rt: Pick<AgentRuntime, 'craftStore' | 'storage' | 'executionRouter' | 'planes'>, native: ToolSet, external: () => ToolSet = () => ({}),
): CodemodeSurface {
  return {
    native,
    craftedTools: () => selectInjectableCraftedTools(rt.craftStore, rt.storage.sql),
    external: () => withCheckedInputs(external()),
    providers: rt.executionRouter?.getProviders() ?? [],
    cwd: rt.planes.cwd,
  };
}

export interface BuiltinToolDeps {
  workMode?: WorkMode;
  rt: AgentRuntime;
  /** The turn's MCP and extension tools, which `eval` reaches (`CodemodeSurface.external`). */
  external?: () => ToolSet;
  /** Ready `eval` for a confined surface (head, swarm node); actors set `codemode` on `buildActorTools` instead. */
  prebuiltCodemodeTool?: unknown;
  /** Hybrid memory search when present; null declares no semantic index (results report lexical-only). */
  vectorStore?: import('../memory/vector-store').VectorStore | null;
  /** Enables remember/recall/forget and joins facts into the search RRF merge. */
  facts?: import('../memory/facts').FactsStore;
  conversations: ConversationRecall;
  /** Wired only on subordinate actors. */
  report?: ReportToolDeps;
  webSearch?: WebSearchProvider;
  /** Plan mode only; its absence is the gate. */
  submitPlan?: SubmitPlanToolDeps;
  /** Per-turn ledger: lets `file` refuse blind edits. Omitted → fresh one, so the policy is per-root. */
  fileLedger?: TurnFileLedger;
  /** Per-turn context budget; omitted → fresh one, so the policy is per-root. */
  contextBudget?: TurnContextBudget;
  /** Per-turn escalation ledger; omitted → fresh one. */
  escalations?: TurnEscalationLedger;
  /** Test seam; defaults to one JSON line per event on `console`. */
  logger?: Logger;
  /** Absent: role switches (tasks action=mode) refuse. */
  roleSwitch?: RoleSwitch;
}

export interface ReportToolDeps {
  report(input: {
    status: SubordinateReportStatus;
    content: string;
    /** Absent when the model sent none; never present on a `bodyOnly` destination. */
    handoff?: SubordinateReportHandoff;
  }): Promise<JsonValue | undefined>;
  /** Destination consumes only the prose body (search node reports), so handoff fields are not declared. */
  readonly bodyOnly?: boolean;
}

const PlanEditsInputSchema = z.object({ edits: z.array(PlanEditSchema).min(1) });

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolSet {
  const { rt } = deps;
  const memory = rt.memory;

  const budget = deps.contextBudget ?? new TurnContextBudget();
  const escalations = deps.escalations ?? new TurnEscalationLedger();
  // `diagnostics`, not console: the host decides the sink (obs/log.ts).
  const logger = deps.logger ?? diagnostics;

  const tools: ToolSet = {};

  // Registered first so eval heads the list; actors replace this key in place via `installCodemode`.
  const prebuilt = { value: deps.prebuiltCodemodeTool };
  // No core fallback: an in-process compile would break in any V8 isolate.
  tools.eval = isExecutableToolEntry(prebuilt) ? prebuilt.value : tool({
    description:
      BUILTIN_TOOL_DESCRIPTIONS.eval +
      ' (NOT CONFIGURED: no eval builder on this runtime)',
    inputSchema: codemodeInputSchema(),
    execute: (): Promise<JsonValue> => settle(Effect.fail(new KinuError('unsupported', 'eval is not configured on this runtime. The backend must supply '
      + 'deps.prebuiltCodemodeTool to buildBuiltinTools or deps.codemode to '
      + 'buildActorTools (CF: cf-backend/createCodemodeToolFactory; CLI: '
      + '@kinu.run/cli-backend/createNodeCodemodeToolFactory).'))),
  });

  tools.eval = withClampedToolResult(tools.eval, {
    files: rt.storage, budget, producer: 'eval', images: true,
  });

  tools.shell = createShellTool({
    shell: rt.shell, router: rt.executionRouter, files: rt.storage, budget, escalations, logger,
  });

  tools.file = createFileTool({
    vfs: rt.toolFiles,
    home: rt.storage.home,
    ledger: deps.fileLedger ?? new TurnFileLedger(),
    budget,
    memory,
    planes: rt.planes,
  });

  // Dispatch shared with the `memory.*` codemode namespace (memory-tool.ts).
  const facts = deps.facts;

  const runMemoryAction = createMemoryDispatcher({
    memory, vectorStore: deps.vectorStore, facts, actor: rt.actor, conversations: deps.conversations,
  });

  tools.memory = permitInPlan(tool({
    description: renderToolSchemaDescription(memoryToolSpec(facts !== undefined)),
    inputSchema: memoryToolInputSchema(facts !== undefined),
    execute: async (args) => runMemoryAction(args),
  }));

  const taskList = new TaskListStore(rt.storage.sql, rt.actor, rt.storage.transactionSync);
  const runTasksAction = createTasksDispatcher(taskList, rt.actor.config, deps.roleSwitch);
  tools.tasks = permitInPlan(tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.tasks,
    inputSchema: TasksToolInputSchema,
    execute: async (args) => runTasksAction(args),
  }));

  if (deps.webSearch) tools.web = createWebTool({ provider: deps.webSearch, files: rt.storage, budget });

  if (deps.report) {
    const report = deps.report;
    const description = BUILTIN_TOOL_DESCRIPTIONS.report;

    // A `bodyOnly` destination is offered no handoff.
    tools.report = permitInPlan(report.bodyOnly
      ? tool({ description, inputSchema: ReportBodySchema, execute: async (args) => dispatchReport(report, args) })
      : tool({ description, inputSchema: ReportToolInputSchema, execute: async (args) => dispatchReport(report, args) }));
  }

  // Outside BUILTIN_TOOLS: exists only on Plan turns.
  const submitPlan = deps.submitPlan;

  if (submitPlan) {
    tools.submit_plan = permitInPlan(tool({
      description: [
        'Submit the current Markdown implementation plan for interactive owner review.',
        'On the first call, write the full plan with one edit starting at line 1. After changes are requested, use the line numbers in the feedback turn to make targeted edits.',
        'Line numbers are one-indexed and inclusive; omit end to replace through the end of the plan. Do not implement after submission: end the turn and await the owner decision.',
      ].join('\n'),
      inputSchema: PlanEditsInputSchema,
      execute: async ({ edits }) => {
        const result = await submitPlan.submit(edits);

        if (!result.ok) return result;

        return {
          ok: true,
          planId: result.plan.id,
          revision: result.plan.revision,
          status: result.plan.status,
          message: 'Plan submitted and awaiting review. Do not implement or produce a preview; end this turn now.',
        };
      },
    }));
  }

  // `mcp_` is reserved for MCP (isMcpToolKey).
  for (const name of Object.keys(tools)) {
    if (isMcpToolKey(name)) {
      return settleSync(Effect.die(new Error(
        `Builtin tool name '${name}' starts with the reserved 'mcp_' prefix. ` +
        `That prefix is owned by per-user MCP tools: pick a different name.`,
      )));
    }
  }

  return toolsInWorkMode(deps.workMode ?? 'build', withCheckedInputs(tools));
}

function isExecutableToolEntry(
  input: { value: unknown },
): input is { value: ExecutableToolEntry } {
  return v.is(v.object({
    inputSchema: v.unknown(),
    execute: v.function(),
  }), input.value);
}

/** Build `eval` over a finished surface; `buildActorTools` calls it before the effect-claim wrap. */
function installCodemode(
  surface: ToolSet,
  build: CodemodeBuilder,
  deps: BuiltinToolDeps,
): void {
  const { rt } = deps;
  const built = build(codemodeSurface(rt, toolsInWorkMode(deps.workMode ?? 'build', surface), deps.external));
  const clamp = { files: rt.storage, producer: 'eval' as const, images: true as const };
  surface.eval = withCheckedInput('eval', withClampedToolResult(
    built,
    deps.contextBudget ? { ...clamp, budget: deps.contextBudget } : clamp,
  ));
}

/** The one tool assembly: builtins, admitted narrow, kind tools, allowed narrow, then `eval`. */
export interface ToolSurfaceDeps extends BuiltinToolDeps {
  admitted?: readonly string[];
  extra?: ToolSet;
  /** Wraps the admitted builtins and `extra` outside their input check, so it sees a refused call too. */
  wrapCalls?: (tools: ToolSet) => ToolSet;
  allowed?: readonly string[];
  /** Wins over `codemodeTool`. */
  codemode?: CodemodeBuilder;
  /** A finished entry installs with the builtins; a function builds over the finished surface. */
  codemodeTool?: unknown;
  /** Merged after the finish, never declared to the sandbox. */
  post?: ToolSet;
  /** Claimed inside the Plan check, so a refused call claims nothing. */
  effectClaims?: EffectClaimDeps;
  wrapFinished?: (finished: ToolSet) => ToolSet;
}

export function buildToolSurface(deps: ToolSurfaceDeps): ToolSet {
  let builtin: BuiltinToolDeps = deps;

  if (builtin.prebuiltCodemodeTool === undefined && deps.codemodeTool !== undefined) {
    const direct = { value: deps.codemodeTool };

    if (isExecutableToolEntry(direct)) builtin = { ...deps, prebuiltCodemodeTool: deps.codemodeTool };
  }

  const built = buildBuiltinTools(builtin.workMode === 'plan' ? { ...builtin, workMode: 'build' } : builtin);
  const narrowed = deps.admitted === undefined ? built : keepBuiltins(built, deps.admitted);
  const merged = deps.extra === undefined ? narrowed : { ...narrowed, ...withCheckedInputs(deps.extra) };
  const wrapped = deps.wrapCalls === undefined ? merged : deps.wrapCalls(merged);
  const allow = deps.allowed === undefined ? undefined : new Set(deps.allowed);

  const surface = allow === undefined
    ? wrapped
    : Object.fromEntries(Object.entries(wrapped).filter(([name]) => allow.has(name)));

  if (deps.codemode !== undefined) {
    installCodemode(surface, deps.codemode, deps);
  } else {
    const buildFromSurface = v.safeParse(v.function(), deps.codemodeTool);

    if (buildFromSurface.success && 'eval' in surface) {
      // `eval` reaches only the namespaces the allowed tools reach.
      const entry = { value: buildFromSurface.output(toolsInWorkMode(deps.workMode ?? 'build', surface), narrowToolSurface(deps.allowed)) };

      if (isExecutableToolEntry(entry)) surface.eval = withCheckedInput('eval', entry.value);
    }
  }

  const finished = deps.post === undefined ? surface : { ...surface, ...withCheckedInputs(deps.post) };
  const modeBound = toolsInWorkMode(deps.workMode ?? 'build', deps.effectClaims === undefined ? finished : withEffectClaims(finished, deps.effectClaims));

  return deps.wrapFinished === undefined ? modeBound : deps.wrapFinished(modeBound);
}
