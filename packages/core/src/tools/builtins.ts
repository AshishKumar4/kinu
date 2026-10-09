/**
 * Canonical built-in tool factory. Actors use `buildActorTools` (adds `agents`, which cannot live
 * here without an import cycle); heads and swarm nodes use this directly, filtered by `keepBuiltins`.
 * Skills are plain files and `release` is a codemode namespace, not native tools.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ConversationRecall } from '../memory/conversation-search';
import {
  BUILTIN_TOOL_DESCRIPTIONS, memoryToolSpec, renderToolSchemaDescription, keepBuiltins, narrowToolSurface,
} from './registry';
import { TaskListStore } from './task-store';
import { withClampedToolResult } from './clamp';
import { withCheckedInput, withCheckedInputs } from './tool-schema';
import { withEffectClaims, type EffectClaimDeps } from './effect-claim';
import { codemodeInputSchema } from './sandbox-contract';
import { serveReport, type ReportDeps } from './report-operations';
import { createFileTool } from './file-operations';
import { serveShell } from './shell-operations';
import { TurnFileLedger } from '../vfs/file-ledger';
import { TurnContextBudget } from '../context-budget';
import { isMcpToolKey } from './mcp-naming';
import { selectInjectableCraftedTools, type CraftedToolSource } from './crafted-executor';
import { TurnEscalationLedger } from '../execution/escalation';
import { serveMemory } from './memory-operations';
import { nativeTool, operationTool } from './operation-surfaces';
import { serveTasks, type RoleSwitch } from './tasks-operations';
import type { WebSearchProvider } from '../web/index';
import { serveWeb } from './web-operations';
import type { ReplyToCommentToolDeps, SubmitPlanToolDeps } from '../types/plans';
import { PLAN } from '../operations/plan';
import { servePlan, servePlanReply } from './plan-operations';
import type { JsonValue } from '../utils/json';
import { Effect } from 'effect';
import { diagnostics, KinuError, settle, settleSync, type Logger } from '../obs/index';
// heads/types.ts holds no runtime import, so this edge cannot close a ring.
import { toolsInWorkMode } from '../execution/work-mode';
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
  /** Where a program's relative paths start, its `process.cwd()`: the runtime's own (`PathPlanes.cwd`). */
  readonly cwd: string;
}

/** Core has no codegen; the CLI supplies `createNodeCodemodeToolFactory`. */
export type CodemodeBuilder = (surface: CodemodeSurface) => ToolSet[string];

/** The one reader of a runtime's crafted tools, for every `eval` built over its surface. */
export function codemodeSurface(
  rt: Pick<AgentRuntime, 'craftStore' | 'storage' | 'planes'>, native: ToolSet, external: () => ToolSet = () => ({}),
): CodemodeSurface {
  return {
    native,
    craftedTools: () => selectInjectableCraftedTools(rt.craftStore, rt.storage.sql),
    external: () => withCheckedInputs(external()),
    cwd: rt.planes.cwd,
  };
}

import type { SlateCallResult, SlateOperation } from '../slates/rpc';

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
  /** The account's memory: reads join it and a write may ask for it (`MEMORY_WITH_ACCOUNT`). Absent, no call names a scope. */
  account?: import('../memory/account').AccountMemory;
  conversations: ConversationRecall;
  /** Wired only on subordinate actors. */
  report?: ReportDeps;
  webSearch?: WebSearchProvider;
  /** Owner-driven root turns; its absence is the gate. */
  submitPlan?: SubmitPlanToolDeps;
  /** Only while a review the owner sent back holds comments the agent may answer; its absence is the gate. */
  replyToComment?: ReplyToCommentToolDeps;
  /** Per-turn ledger: lets `file` refuse blind edits. Omitted → fresh one, so the policy is per-root. */
  fileLedger?: TurnFileLedger;
  /** Per-turn context budget; omitted → fresh one, so the policy is per-root. */
  contextBudget?: TurnContextBudget;
  /** The workspace's slates, so `file` answers whether a slate it wrote into still builds. */
  slate?: (operation: SlateOperation) => Promise<SlateCallResult>;
  /** Per-turn escalation ledger; omitted → fresh one. */
  escalations?: TurnEscalationLedger;
  /** Test seam; defaults to one JSON line per event on `console`. */
  logger?: Logger;
  /** Absent: role switches (tasks op=switchRole) refuse. */
  roleSwitch?: RoleSwitch;
}


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

  tools.shell = operationTool(BUILTIN_TOOL_DESCRIPTIONS.shell, serveShell({
    shell: rt.shell, router: rt.executionRouter, files: rt.storage, budget, escalations, logger,
  }));

  const files = {
    vfs: rt.toolFiles, home: rt.storage.home, ledger: deps.fileLedger ?? new TurnFileLedger(), budget, memory, planes: rt.planes,
    ...(deps.slate !== undefined && { slate: deps.slate }),
  };

  tools.file = createFileTool(files);

  // The same operations as `memory.*` in a program.
  const facts = deps.facts;

  const account = facts === undefined ? undefined : deps.account;

  tools.memory = nativeTool(renderToolSchemaDescription(memoryToolSpec(facts !== undefined, account !== undefined)), serveMemory(() => ({
    memory, vectorStore: deps.vectorStore, ...(facts !== undefined && { facts }), ...(account !== undefined && { account }), actor: rt.actor, conversations: deps.conversations,
  })));

  const taskList = new TaskListStore(rt.storage.sql, rt.actor, rt.storage.transactionSync);
  tools.tasks = nativeTool(BUILTIN_TOOL_DESCRIPTIONS.tasks, serveTasks(taskList, rt.actor.config, deps.roleSwitch));

  if (deps.webSearch) {
    tools.web = withClampedToolResult(nativeTool(BUILTIN_TOOL_DESCRIPTIONS.web, serveWeb({ provider: deps.webSearch, files: rt.storage })),
      { files: rt.storage, budget, producer: 'web_fetch', images: true });
  }

  if (deps.report) {
    const report = deps.report;

    tools.report = operationTool(BUILTIN_TOOL_DESCRIPTIONS.report, serveReport(() => report));
  }

  // Outside BUILTIN_TOOLS: the plan review's tools exist only where their deps are wired.
  const { submitPlan, replyToComment } = deps;

  if (submitPlan) tools.submit_plan = operationTool(PLAN.submit.help, servePlan(submitPlan));

  if (replyToComment) tools.reply_to_comment = operationTool(PLAN.reply.help, servePlanReply(replyToComment));

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
