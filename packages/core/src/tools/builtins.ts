/**
 * Canonical built-in tool factory. Actors use `buildActorTools` (adds `agents`, which cannot live
 * here without an import cycle); heads and swarm nodes use this directly, filtered by `keepBuiltins`.
 * Skills are plain files, not native tools.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ConversationRecall } from '../memory/conversation-search';
import {
  ASK_OWNER_DESCRIPTION, ASK_OWNER_TOOL, BUILTIN_TOOL_DESCRIPTIONS, memoryToolSpec, renderToolSchemaDescription, keepBuiltins, narrowAdmittedSurface, narrowToolSurface,
  type ToolSurfaceNarrowing,
} from './registry';
import { TaskListStore } from './task-store';
import { withClampedToolResult } from './clamp';
import { withCheckedInput, withCheckedInputs } from './tool-schema';
import { withEffectReceipt, type EffectClaimDeps } from './effect-claim';
import { codemodeInputSchema } from './sandbox-contract';
import { serveReport, type ReportDeps } from './report-operations';
import { createFileTool, type FileDeps } from './file-operations';
import { serveStores, type ServedStores, type StoreDeps } from './actor-stores';
import { serveShell } from './shell-operations';
import { TurnFileLedger } from '../vfs/file-ledger';
import { TurnContextBudget } from '../context-budget';
import { isMcpToolKey } from './mcp-naming';
import { selectInjectableCraftedTools, type CraftedToolSource } from './crafted-executor';
import { TurnEscalationLedger } from '../execution/escalation';
import type { MemoryDeps } from './memory-operations';
import { declaredOperationTool, nativeTool, operationInputSchema, operationTool } from './operation-surfaces';
import type { RoleSwitch } from './tasks-operations';
import type { WebSearchProvider } from '../web/index';
import { serveWeb } from './web-operations';
import type { ReplyToCommentToolDeps, SubmitPlanToolDeps } from '../types/plans';
import { PLAN } from '../operations/plan';
import { defineOperation } from '../operations/operation';
import { servePlan, servePlanReply } from './plan-operations';
import { AskOwnerInputSchema } from '../types/owner-questions';
import type { JsonValue } from '../utils/json';
import { Effect } from 'effect';
import { diagnostics, KinuError, settle, settleSync, type Logger } from '../obs/index';
// heads/types.ts holds no runtime import, so this edge cannot close a ring.
import { permitInPlan, toolsInWorkMode } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';

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
  /** Where the native `report` reaches, on a turn its hirer drives: a program's `report.send` reaches the same. */
  readonly report?: ReportDeps;
  /** The file, memory and task operations its native tools run: a program's named members are these same ones. */
  readonly stores: ServedStores;
}

/** Core has no codegen; each backend supplies its factory. `reach` is the namespaces the allowed tools reach, for a
 *  confined surface (head, swarm node); an actor's surface reaches them all. */
export type CodemodeBuilder = (surface: CodemodeSurface, reach: ToolSurfaceNarrowing) => ToolSet[string];

/** `ask_owner`'s input as an operation's, so a malformed call is refused by field before it can park; nothing serves it. */
const ASK_OWNER = defineOperation({
  ns: ASK_OWNER_TOOL, name: 'ask', impact: 'externalSend', plan: true, slate: false,
  help: ASK_OWNER_DESCRIPTION, input: AskOwnerInputSchema, output: v.unknown(),
});

/**
 * `ask_owner`, with no executor: its call stays unpaired, so the loop stops on its step and the owner's answer reaches
 * the model through the repair that pairs interrupted calls (`plans/owner-questions.ts`).
 */
function askOwnerTool() {
  return permitInPlan(tool({ description: ASK_OWNER_DESCRIPTION, inputSchema: operationInputSchema(ASK_OWNER) }));
}

/** The one reader of a runtime's crafted tools, for every `eval` built over its surface. */
export function codemodeSurface(
  rt: Pick<AgentRuntime, 'craftStore' | 'storage' | 'planes' | 'actor'>, native: ToolSet, external: () => ToolSet,
  held: { readonly report?: ReportDeps; readonly stores: ServedStores },
): CodemodeSurface {
  const surface: CodemodeSurface = {
    native,
    // Read per call: with crafting off no crafted tool is declared or bound.
    craftedTools: () => (rt.actor.config.getCrafting() ? selectInjectableCraftedTools(rt.craftStore, rt.storage.sql) : []),
    external: () => withCheckedInputs(external()),
    cwd: rt.planes.cwd,
    stores: held.stores,
  };

  return held.report === undefined ? surface : { ...surface, report: held.report };
}

/** What an actor's builtins read its stores from. */
export type BuiltinStoreInputs = Pick<BuiltinToolDeps, 'rt' | 'conversations' | 'vectorStore' | 'facts' | 'account' | 'fileLedger' | 'contextBudget' | 'slateBuild' | 'roleSwitch' | 'knownFile'>;

/**
 * The stores an actor's builtins run over, from its tool deps: its file plane on the turn's ledger and budget, its
 * memory (the account's only beside its facts), and its task list. The one reading of them for its native tools and,
 * through those tools' served set, its programs.
 */
export function builtinStores(deps: BuiltinStoreInputs): ServedStores {
  return serveStores(builtinStoreDeps(deps));
}

function builtinStoreDeps(deps: BuiltinStoreInputs): StoreDeps {
  const { rt, facts } = deps;
  const account = facts === undefined ? undefined : deps.account;

  const files: FileDeps = {
    vfs: rt.toolFiles, home: rt.storage.home, ledger: deps.fileLedger ?? new TurnFileLedger(), budget: deps.contextBudget ?? new TurnContextBudget(),
    memory: rt.memory, planes: rt.planes, ...(deps.slateBuild !== undefined && { slateBuild: deps.slateBuild }),
    ...(deps.knownFile !== undefined && { knownFile: deps.knownFile }),
  };

  const memory: MemoryDeps = {
    memory: rt.memory, vectorStore: deps.vectorStore, ...(facts !== undefined && { facts }), ...(account !== undefined && { account }), actor: rt.actor,
    conversations: deps.conversations,
  };

  const list = new TaskListStore(rt.storage.sql, rt.actor, rt.storage.transactionSync);

  return { files: () => files, memory: () => memory, tasks: () => ({ list, config: rt.actor.config, roleSwitch: deps.roleSwitch ?? null }) };
}

import type { SlateCallResult } from '../slates/rpc';

export interface BuiltinToolDeps {
  workMode?: WorkMode;
  rt: AgentRuntime;
  /** The turn's MCP and extension tools, which `eval` reaches (`CodemodeSurface.external`). */
  external?: () => ToolSet;
  /** Hybrid memory search when present; null declares no semantic index (results report lexical-only). */
  vectorStore?: import('../memory/vector-store').VectorStore | null;
  /** Enables remember/recall/forget and joins facts into the search RRF merge. */
  facts?: import('../memory/facts').FactsStore;
  /** The account's memory: reads join it and a write may ask for it (`MEMORY_WITH_ACCOUNT`). Absent, no call names a scope. */
  account?: import('../memory/account').AccountMemory;
  conversations: ConversationRecall;
  /** Wired only on subagent actors. */
  report?: ReportDeps;
  webSearch?: WebSearchProvider;
  /** Owner-driven root turns; its absence is the gate. */
  submitPlan?: SubmitPlanToolDeps;
  /** Only while a review the owner sent back holds comments the agent may answer; its absence is the gate. */
  replyToComment?: ReplyToCommentToolDeps;
  /** Where a person is the conversation partner: the workspace's own agent, and a hire on its owner's turns. */
  askOwner?: true;
  /** Per-turn ledger: lets `file` refuse blind edits. Omitted → fresh one, so the policy is per-root. */
  fileLedger?: TurnFileLedger;
  /** Per-turn context budget; omitted → fresh one, so the policy is per-root. */
  contextBudget?: TurnContextBudget;
  /** Whether a slate still builds, so `file` answers it for a slate it wrote into; a check, never a preview. */
  slateBuild?: (slate: string) => Promise<SlateCallResult>;
  /** Whether a file plane's path is a file known there without a look (`FileDeps.knownFile`): a built-in skill's. */
  knownFile?: (path: string) => boolean;
  /** Per-turn escalation ledger; omitted → fresh one. */
  escalations?: TurnEscalationLedger;
  /** Test seam; defaults to one JSON line per event on `console`. */
  logger?: Logger;
  /** Absent: role switches (tasks op=switchRole) refuse. */
  roleSwitch?: RoleSwitch;
}


/** `served`: the store operations a caller serves its programs too, so its native tools are those same ones; absent,
 *  served from `deps` here. */
export function buildBuiltinTools(deps: BuiltinToolDeps, served?: ServedStores): ToolSet {
  const { rt } = deps;

  const budget = deps.contextBudget ?? new TurnContextBudget();
  const stores = served ?? builtinStores({ ...deps, contextBudget: budget });
  const escalations = deps.escalations ?? new TurnEscalationLedger();
  // `diagnostics`, not console: the host decides the sink (obs/log.ts).
  const logger = deps.logger ?? diagnostics;

  const tools: ToolSet = {};

  // Registered first so eval heads the list; the surface's builder replaces this key in place via `installCodemode`.
  // No core fallback: an in-process compile would break in any V8 isolate.
  tools.eval = tool({
    description:
      BUILTIN_TOOL_DESCRIPTIONS.eval +
      ' (NOT CONFIGURED: no eval builder on this runtime)',
    inputSchema: codemodeInputSchema(),
    execute: (): Promise<JsonValue> => settle(Effect.fail(new KinuError('unsupported', 'eval is not configured on this runtime. The backend must supply '
      + 'deps.codemode to buildToolSurface (CF: cf-backend/createCodemodeToolFactory; CLI: '
      + '@kinu.run/cli-backend/createNodeCodemodeToolFactory).'))),
  });

  tools.eval = withClampedToolResult(tools.eval, {
    files: rt.storage, budget, producer: 'eval', images: true,
  });

  tools.shell = operationTool(BUILTIN_TOOL_DESCRIPTIONS.shell, serveShell({
    shell: rt.shell, router: rt.executionRouter, files: rt.storage, budget, escalations, logger, owner: rt.toolFiles.owner?.bind(rt.toolFiles),
  }));

  // The same operations as `file.*`, `memory.*` and `tasks.*` in a program.
  tools.file = createFileTool(stores.file, stores.deps.files());

  const { facts, account } = stores.deps.memory();

  tools.memory = nativeTool(renderToolSchemaDescription(memoryToolSpec(facts !== undefined, account !== undefined)), stores.memory.account);
  tools.tasks = nativeTool(BUILTIN_TOOL_DESCRIPTIONS.tasks, stores.tasks);

  if (deps.webSearch) {
    tools.web = withClampedToolResult(nativeTool(BUILTIN_TOOL_DESCRIPTIONS.web, serveWeb({ provider: deps.webSearch, files: rt.storage })),
      { files: rt.storage, budget, producer: 'web_fetch', images: true });
  }

  if (deps.report) {
    const report = deps.report;

    tools.report = operationTool(BUILTIN_TOOL_DESCRIPTIONS.report, serveReport(() => report));
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

  return toolsInWorkMode(deps.workMode ?? 'build', { ...withCheckedInputs(tools), ...ownerLaneTools(deps) });
}

/**
 * The owner's lane, outside BUILTIN_TOOLS: the plan review's tools and the question to the owner, each only where its
 * deps are wired. Their effects commit in the agent's own store, so an agent in its own isolate builds them there.
 */
export function ownerLaneTools(deps: Pick<BuiltinToolDeps, 'submitPlan' | 'replyToComment' | 'askOwner'>): ToolSet {
  const tools: ToolSet = {};
  const { submitPlan, replyToComment } = deps;

  if (submitPlan) tools.submit_plan = operationTool(PLAN.submit.help, servePlan(submitPlan));

  if (replyToComment) tools.reply_to_comment = operationTool(PLAN.reply.help, servePlanReply(replyToComment));

  if (deps.askOwner) tools[ASK_OWNER_TOOL] = askOwnerTool();

  return withCheckedInputs(tools);
}

/**
 * The owner's lane as a turn offers it, with no executor: what a workspace reads of a turn whose agent's own isolate
 * builds and runs these tools ({@link ownerLaneTools}), for the facts and lessons its dynamic block states of them.
 */
export function ownerLaneDeclarations(lane: { readonly submitPlan: boolean; readonly replyToComment: boolean; readonly askOwner: boolean }): ToolSet {
  const declared: ToolSet = {};

  if (lane.submitPlan) declared.submit_plan = declaredOperationTool(PLAN.submit.help, PLAN.submit);

  if (lane.replyToComment) declared.reply_to_comment = declaredOperationTool(PLAN.reply.help, PLAN.reply);

  if (lane.askOwner) declared[ASK_OWNER_TOOL] = askOwnerTool();

  return withCheckedInputs(declared);
}

/** Build `eval` over a finished surface; `buildActorTools` calls it before the effect-claim wrap. */
function installCodemode(
  surface: ToolSet,
  build: CodemodeBuilder,
  deps: BuiltinToolDeps & { readonly allowed?: readonly string[]; readonly admitted?: readonly string[] },
  stores: ServedStores,
): void {
  const { rt } = deps;
  // `eval` reaches only the namespaces the surface's own tools reach: its admitted builtins, then its allowed list.
  const reach = deps.admitted === undefined ? narrowToolSurface(deps.allowed) : narrowAdmittedSurface(deps.admitted, deps.allowed);

  surface.eval = withCheckedInput('eval', build(
    codemodeSurface(rt, toolsInWorkMode(deps.workMode ?? 'build', surface), deps.external ?? (() => ({})), { ...deps.report !== undefined && { report: deps.report }, stores }), reach,
  ));
}

/** The one tool assembly: builtins, admitted narrow, kind tools, allowed narrow, then `eval`. */
export interface ToolSurfaceDeps extends BuiltinToolDeps {
  admitted?: readonly string[];
  extra?: ToolSet;
  /** Wraps the admitted builtins and `extra` outside their input check, so it sees a refused call too. */
  wrapCalls?: (tools: ToolSet) => ToolSet;
  allowed?: readonly string[];
  /** Builds `eval` over the finished surface; absent, `eval` answers that it is not configured. */
  codemode?: CodemodeBuilder;
  /** Merged after the finish, never declared to the sandbox. */
  post?: ToolSet;
  /** Claimed inside the Plan check, so a refused call claims nothing. */
  effectClaims?: EffectClaimDeps;
  wrapFinished?: (finished: ToolSet) => ToolSet;
  /** The store operations this surface projects, served by its caller so its other projections (a slate's call, a
   *  scaffold's machines) run the same ones; absent, served here from these deps. */
  served?: ServedStores;
}

/** A surface's tools and the store operations they run, served once for both. */
export interface ServedTools {
  readonly tools: ToolSet;
  readonly stores: ServedStores;
}

/** The store operations a surface's deps serve: `served` when its caller holds them, else served once from the deps. */
export function surfaceStores(deps: BuiltinStoreInputs & { readonly served?: ServedStores }): ServedStores {
  return deps.served ?? builtinStores(deps);
}

export function buildToolSurface(surfaceDeps: ToolSurfaceDeps): ToolSet {
  // Served once: the native tools and a program's named members are projections of this one set, and every native
  // tool accounts into the read ledger and budget it does.
  const stores = surfaceStores(surfaceDeps);
  const { ledger, budget } = stores.deps.files();
  const deps: ToolSurfaceDeps = { ...surfaceDeps, fileLedger: ledger, contextBudget: budget };
  const built = buildBuiltinTools(deps.workMode === 'plan' ? { ...deps, workMode: 'build' } : deps, stores);
  const narrowed = deps.admitted === undefined ? built : keepBuiltins(built, deps.admitted);
  const merged = deps.extra === undefined ? narrowed : { ...narrowed, ...withCheckedInputs(deps.extra) };
  const wrapped = deps.wrapCalls === undefined ? merged : deps.wrapCalls(merged);
  const allow = deps.allowed === undefined ? undefined : new Set(deps.allowed);

  const surface = allow === undefined
    ? wrapped
    : Object.fromEntries(Object.entries(wrapped).filter(([name]) => allow.has(name)));

  if (deps.codemode !== undefined && 'eval' in surface) installCodemode(surface, deps.codemode, deps, stores);

  const finished = deps.post === undefined ? surface : { ...surface, ...withCheckedInputs(deps.post) };
  const modeBound = toolsInWorkMode(deps.workMode ?? 'build', deps.effectClaims === undefined ? finished : withEffectReceipt(finished, deps.effectClaims));

  return deps.wrapFinished === undefined ? modeBound : deps.wrapFinished(modeBound);
}
