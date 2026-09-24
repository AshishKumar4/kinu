/**
 * Canonical built-in tool factory. Actors use `buildActorTools` (adds `agents`, which cannot live
 * here without an import cycle); heads and swarm nodes use this directly, filtered by `keepBuiltins`.
 * Skills are plain files and `release` is a codemode namespace, not native tools.
 */

import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SessionHistory } from '../session/history';
import type { ExecutorProviderSurface } from '../execution/types';
import {
  BUILTIN_TOOL_DESCRIPTIONS, memoryToolSpec, renderToolSchemaDescription,
  memoryActionsFor, TASKS_TOOL_ACTIONS, WEB_TOOL_ACTIONS, unknownActionError, type WebToolAction,
} from './registry';
import type { ProfileCatalogEnvelope } from '../types/profile';
import { TaskListStore, TASK_STATUSES } from '../tasks/store';
import { clampToolResult, withClampedToolResult, type ClampToolResultOptions } from './clamp';
import { withCheckedInput, withCheckedInputs } from './tool-schema';
import { codemodeInputSchema } from './sandbox-contract';
import { connectedDevices } from '../execution/device-status';
import { deviceMountSegment } from '../execution/device-tunnel-executor';
import { referenceRoots } from '../vfs/references';
import { dispatchReport, reportHandoffProperties, type ReportToolInput } from '../delegation/report-tool';
import {
  SUBORDINATE_REPORT_STATUSES,
  type SubordinateReportHandoff, type SubordinateReportStatus,
} from '../events/hub/types';
import { createFileToolSteer } from './shell-file-steer';
import { createFileTool } from './file-tool';
import { TurnFileLedger } from './file-ledger';
import { TurnContextBudget } from '../context-budget';
import { isMcpToolKey } from './mcp-naming';
import { selectInjectableCraftedTools, type CraftedToolExecute, type CraftedToolExecuteFn } from './crafted-executor';
import { attributeCraftedFailure } from '../craft/attribution';
import { DEFAULT_CONFIG } from '../config';
import { commandResult, CommandResultSchema, type CommandResult } from '../execution/exec-result';
import { TurnEscalationLedger } from '../execution/escalation';
import { createMemoryDispatcher, type MemoryToolInput } from './memory-tool';
import { createTasksDispatcher, type TasksToolInput } from './tasks-tool';
import { type WebSearchProvider, type WebSearchResponse } from '../web/index';
import type { PlanEdit, SubmitPlanToolDeps } from '../types/plans';
import type { JsonValue } from '../utils/json';
import { diagnostics, KinuError, toKinuError, type Logger } from '../obs/index';
// heads/types.ts holds no runtime import, so this edge cannot close a ring.
import { keepBuiltins } from '../heads/types';
import { toolsInWorkMode, permitInPlan, requireBuild } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';

type ToolExecutionOptions = Parameters<NonNullable<ToolSet[string]['execute']>>[1];

type ExecutableToolEntry = NonNullable<ToolSet[string]>;

export type CraftedToolSet =
  Record<string, { description: string; execute: (arg: JsonValue) => Promise<JsonValue | undefined> }>;

/** Builds `eval` over a finished surface: the sandbox declares every other tool, so it runs last. */
export interface CodemodeSurface {
  readonly native: ToolSet;
  /** Resolved per execute so a tool crafted mid-turn is callable on the next `eval`. */
  readonly craftedTools: () => CraftedToolSet;
  readonly providers: ExecutorProviderSurface[];
}

/** Core has no codegen; the CLI supplies `createNodeCodemodeToolFactory`. */
export type CodemodeBuilder = (surface: CodemodeSurface) => ToolSet[string];

export interface BuiltinToolDeps {
  workMode?: WorkMode;
  rt: AgentRuntime;
  /** Filter cutoff override (default: DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection). */
  minEffectiveScore?: number;
  /**
   * null: sandbox-side compilation (CF Worker Loader prelude). Omitted: no crafted executor.
   */
  craftedToolExecute?: CraftedToolExecute | null;
  /** Ready `eval` for a confined surface (head, swarm node); actors set `codemode` on `buildActorTools` instead. */
  prebuiltCodemodeTool?: unknown;
  /** Hybrid memory search when present; null declares no semantic index (results report lexical-only). */
  vectorStore?: import('../memory/vector-store').VectorStore | null;
  /** Enables remember/recall/forget and joins facts into the search RRF merge. */
  facts?: import('../memory/facts').FactsStore;
  history: SessionHistory;
  /** Crafted-tool surfacing; 'relevant' injects FTS5 top-K plus frequently used recent tools. */
  toolSurfacing?: {
    mode: 'all' | 'relevant';
    query?: string;
    maxRelevant?: number;
  };
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
  roleAuthority?: () => ProfileCatalogEnvelope | null;
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

/** Crafted-tool map, read fresh each call; codegen only via `craftedToolExecute`. */
function buildCraftedToolSetFromExecute(
  rt: AgentRuntime,
  factory: CraftedToolExecute,
  minScore: number,
  surfacing?: { mode: 'all' | 'relevant'; query?: string; maxRelevant?: number },
) {
  const out: CraftedToolSet = {};

  const list = selectInjectableCraftedTools(rt.craftStore, rt.storage.sql, minScore);

  let relevantNames: Set<string> | null = null;

  if (surfacing?.mode === 'relevant') {
    const maxRelevant = surfacing.maxRelevant ?? 20;
    const half = Math.max(5, Math.floor(maxRelevant / 2));
    relevantNames = new Set();

    // Unguarded on purpose: the schema guarantees these, and swallowing a failure would silently narrow the callable set.
    if (surfacing.query && surfacing.query.length > 0) {
      for (const hit of rt.craftStore.search(surfacing.query, half)) relevantNames.add(hit.name);
    }

    const top = rt.storage.sql<{ name: string }>`
      SELECT name FROM crafted_tools
      ORDER BY uses DESC, last_used_at DESC LIMIT ${maxRelevant}`;

    for (const r of top) relevantNames.add(r.name);
  }

  for (const t of list) {
    if (relevantNames && !relevantNames.has(t.name)) continue;
    const description = t.description;

    try {
      const execute = factory({ name: t.name, description, code: t.code });
      out[t.name] = {
        description,
        // The single runtime attribution point for crafted tools; substrates must not also stamp,
        // or one failure reads as several.
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

/** One compiled body per (name, code). */
function memoizeCraftedExecute(factory: CraftedToolExecute): CraftedToolExecute {
  const compiled = new Map<string, { code: string; execute: CraftedToolExecuteFn }>();

  return (crafted) => {
    const hit = compiled.get(crafted.name);

    if (hit && hit.code === crafted.code) return hit.execute;
    const execute = factory(crafted);
    compiled.set(crafted.name, { code: crafted.code, execute });

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

/** Log event names; constants so emitter and query spell them identically. Only refusals and handled failures. */
const RUN_SHELL_ABSENT = 'shell.shell_absent';

const RUN_ESCALATION_REFUSED = 'shell.escalation_refused';

const RUN_RUNTIME_NO_EXEC = 'shell.runtime_no_exec';

const RUN_ESCALATION_FAILED = 'shell.escalation_failed';

const CRAFT_TOOL_SKIPPED = 'craft.tool_skipped';

function unprovisionedAdvice(runtimeKey: string): string {
  if (runtimeKey === 'device') {
    return 'A machine runtime requires the Kinu PC daemon. Ask the user to install it from the Executors tab.';
  }

  if (runtimeKey === 'sandbox') {
    return 'The full Cloudflare Sandbox is not active yet. It will be auto-provisioned on first use — retry.';
  }

  return `Runtime "${runtimeKey}" is not registered.`;
}

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolSet {
  const { rt } = deps;
  const memory = rt.memory;
  const router = rt.executionRouter;
  const shell = rt.shell;

  // Device nicknames are not in the enum; any unknown value routes to the device executor.
  const shellRuntimes = [...new Set(['workspace', ...(router?.listExecutors().map(({ name }) => name) ?? [])])];

  const budget = deps.contextBudget ?? new TurnContextBudget();
  const escalations = deps.escalations ?? new TurnEscalationLedger();
  const fileToolSteer = createFileToolSteer();
  // `diagnostics`, not console: the host decides the sink (obs/log.ts).
  const logger = deps.logger ?? diagnostics;

  const tools: ToolSet = {};

  // Registered first so eval heads the list; actors replace this key in place via `installCodemode`.
  const prebuilt = { value: deps.prebuiltCodemodeTool };
  // No core fallback: an in-process compile would break in any V8 isolate.
  tools.eval = isExecutableToolEntry(prebuilt) ? prebuilt.value : tool({
    description:
      BUILTIN_TOOL_DESCRIPTIONS.eval +
      ' (NOT CONFIGURED — no eval builder on this runtime)',
    inputSchema: codemodeInputSchema(),
    execute: async (): Promise<JsonValue> => {
      throw new KinuError('unsupported', 'eval is not configured on this runtime. The backend must supply '
        + 'deps.prebuiltCodemodeTool to buildBuiltinTools or deps.codemode to '
        + 'buildActorTools (CF: cf-backend/createCodemodeToolFactory; CLI: '
        + '@kinu.run/cli-backend/createNodeCodemodeToolFactory).');
    },
  });

  tools.eval = withClampedToolResult(tools.eval, {
    vfs: rt.storage.vfs, budget, producer: 'eval',
  });

  // No fallback chain: an unready runtime returns a structured error, never silently routes elsewhere.
  tools.shell = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.shell,
    inputSchema: jsonSchema<{ command: string; runtime?: string; why?: string }>({
      type: 'object',
      properties: {
        command: { type: 'string' },
        runtime: {
          type: 'string',
          enum: shellRuntimes,
          description: 'Default: workspace. A user\'s machine goes by its nickname from the execution status, which is required when several are connected.',
        },
        why: {
          type: 'string',
          description: 'Required for any runtime but workspace: what it gives that the workspace shell lacks (a long-running process, an inbound port, parallelism, resources). Recorded with the outcome.',
        },
      },
      required: ['command'],
    }),
    execute: async (args: { command: string; runtime?: string; why?: string }, options?: ToolExecutionOptions) => {
      requireBuild('Native shell execution');
      const signal = options?.abortSignal;
      // Approval lives at the execution seam (execution/approval.ts), not here.

      // The file steer is composed into the clamped text so one cap covers it (shell-file-steer.ts).
      const steer = fileToolSteer(args.command);
      const clampOpts: ClampToolResultOptions = { vfs: rt.storage.vfs, budget, producer: 'shell' };

      const clamp = async (result: CommandResult): Promise<string> => {
        if (!v.is(v.string(), result)) {
          const failure = await clampToolResult(result.error, clampOpts);

          throw new KinuError(result.reason, failure, { execution: result.execution });
        }

        return clampToolResult(steer ? `${steer}\n\n${result}` : result, clampOpts);
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
          throw refusal;
        }

        return clamp(commandResult(await shell.exec(args.command, signal ? { signal } : undefined)));
      }

      // Past here is an escalation; every exit records it, including refusals.
      // Unknown runtime values are device nicknames resolved by the device executor.
      const registered = router?.getProvider(runtimeKey);
      const nickname = registered === undefined && runtimeKey !== 'sandbox' ? runtimeKey : undefined;
      const provider = nickname === undefined ? registered : router?.getProvider('device');

      if (!provider) {
        escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'refused' });
        // Never fall back to workspace. `unavailable` (retryable), not `unsupported`; the `error`
        // token is matched by the install card (cf-backend WorkspacePage.tsx).
        const refusal = new KinuError('unavailable', 'runtime_not_provisioned');
        logger.failure(RUN_ESCALATION_REFUSED, refusal, { runtime: runtimeKey });
        throw new KinuError(refusal.code, refusal.message + ': '
          + unprovisionedAdvice(nickname !== undefined ? 'device' : runtimeKey), { cause: refusal });
      }

      const execTool = provider.tools.exec;

      if (!execTool) {
        escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'refused' });
        // `unsupported`: this environment has no shell; retrying cannot help.
        const refusal = new KinuError('unsupported', 'runtime_does_not_support_exec');
        logger.failure(RUN_RUNTIME_NO_EXEC, refusal, { runtime: runtimeKey });
        throw new KinuError(refusal.code, refusal.message + ': Runtime "' + runtimeKey + '" is provisioned but does not expose shell exec.', { cause: refusal });
      }

      const context = { signal, device: nickname };
      let result: CommandResult;

      try {
        result = v.parse(CommandResultSchema, await execTool.execute(args.command, context));
      } catch (caught) {
        // Classify cancellations and OOM prose here, or the durable row only records `threw`.
        const failure = toKinuError({
          doing: `run \`${args.command}\` on ${runtimeKey}`,
          cause: caught,
          otherwise: 'io',
        });

        escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'failed' });
        logger.failure(RUN_ESCALATION_FAILED, failure, { runtime: runtimeKey });
        throw failure;
      }

      escalations.observe({
        runtime: runtimeKey,
        reason: args.why,
        outcome: v.is(v.string(), result) ? 'ok' : 'failed',
      });

      return clamp(result);
    },
  });

  tools.file = createFileTool({
    vfs: rt.storage.vfs,
    ledger: deps.fileLedger ?? new TurnFileLedger(),
    budget,
    memory,
    // Live table at render time: a machine connected mid-turn uses its own segment.
    roots: () => {
      const fleet = rt.deviceTransport?.status().devices;

      return referenceRoots({
        devices: connectedDevices(fleet).map((device) => deviceMountSegment(device, fleet)),
        sandbox: router?.getProvider('sandbox') !== undefined,
        local: rt.workspaceIsMachine,
      });
    },
  });

  // Dispatch shared with the `memory.*` codemode namespace (memory-tool.ts).
  const facts = deps.facts;

  const runMemoryAction = createMemoryDispatcher({
    memory, vectorStore: deps.vectorStore, facts, sql: rt.storage.sql, actor: rt.actor,
    transcriptFor: (sessionId) => deps.history.transcript(sessionId),
  });

  tools.memory = permitInPlan(tool({
    description: renderToolSchemaDescription(memoryToolSpec(facts !== undefined)),
    inputSchema: jsonSchema<MemoryToolInput>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...memoryActionsFor(facts !== undefined)],
          description: facts
            ? 'remember, recall, forget: a keyed fact. save: a note. search: notes and facts. conversations: your past conversations.'
            : 'save: a note. search: notes. conversations: your past conversations.',
        },
        key: { type: 'string', description: 'For remember, recall, forget: a stable name such as "deploy.target".' },
        value: { description: 'For remember: any JSON value.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'For remember; default 1.' },
        content: { type: 'string', description: 'For save.' },
        query: {
          type: 'string',
          description: 'For search. For conversations: every term must match; omit it to browse archived conversations.',
        },
        around_message_id: { type: 'string', description: 'For conversations: read around this message instead of searching.' },
        window: { type: 'number', description: 'For conversations around a message: messages each side (default 5, max 20).' },
        max_chars: { type: 'number', description: 'For conversations around a message: characters per message (default 700).' },
        limit: { type: 'number', description: 'For conversations: max hits (default 5, max 10), or archived conversations (default 10, max 20).' },
      },
      required: ['action'],
    }),
    execute: async (args: MemoryToolInput) => runMemoryAction(args),
  }));

  const taskList = new TaskListStore(rt.storage.sql, rt.actor, rt.storage.transactionSync);
  const runTasksAction = createTasksDispatcher(taskList, rt.actor.config, deps.roleAuthority);
  tools.tasks = permitInPlan(tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.tasks,
    inputSchema: jsonSchema<TasksToolInput>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...TASKS_TOOL_ACTIONS],
          description: 'add, update or list tasks; mode reads or switches your role.',
        },
        titles: { type: 'array', items: { type: 'string' }, description: 'For add: one title per task, in order.' },
        parent: { type: 'string', description: 'For add: the task id these are subtasks of; one level only.' },
        id: { type: 'string', description: 'For update: the task id, such as "t3".' },
        status: { type: 'string', enum: [...TASK_STATUSES], description: 'For update.' },
        note: { type: ['string', 'null'], description: 'For update: a one-line note beside the item; null clears it. Update needs `status` or `note`.' },
        role: { type: 'string', description: 'For mode: the role id to switch to from your next turn; omit it to read the active role.' },
      },
      required: ['action'],
    }),
    execute: async (args: TasksToolInput) => runTasksAction(args),
  }));

  const webSearch = deps.webSearch;

  if (webSearch) {
    tools.web = permitInPlan(tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.web,
      inputSchema: jsonSchema<WebToolInput>({
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...WEB_TOOL_ACTIONS],
          },
          query: { type: 'string', description: 'For search.' },
          limit: { type: 'number', description: 'For search: max results (default 5, max 20).' },
          url: { type: 'string', description: 'For fetch: an absolute http(s) URL.' },
        },
        required: ['action'],
      }),
      execute: async (args: WebToolInput) => {
        // The AI SDK does not validate jsonSchema-declared inputs; refuse with the vocabulary.
        const action = v.safeParse(WebActionSchema, args.action);

        if (!action.success) {
          throw new KinuError('bad_input', unknownActionError('web', 'action', args.action, WEB_TOOL_ACTIONS));
        }

        switch (action.output) {
          case 'search': {
            if (!args.query) throw new KinuError('bad_input', 'web.search requires `query`');
            const res = await webSearch.search(args.query, args.limit !== undefined ? { limit: args.limit } : undefined);

            return formatSearchResults(res);
          }

          case 'fetch': {
            if (!args.url) throw new KinuError('bad_input', 'web.fetch requires `url`');
            const res = await webSearch.fetch(args.url);
            // The provenance header is inside the clamped text so a hostile title cannot buy room outside the cap.
            const header = `# ${res.title ?? res.url}\nSource: ${res.url}\nRetrieved: ${res.retrievedAt}\n\n`;

            return clampToolResult(header + res.markdown, {
              vfs: rt.storage.vfs, budget, producer: 'web_fetch',
            });
          }
        }
      },
    }));
  }

  if (deps.report) {
    const report = deps.report;
    tools.report = permitInPlan(tool({
      description: BUILTIN_TOOL_DESCRIPTIONS.report,
      inputSchema: jsonSchema<ReportToolInput>({
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...SUBORDINATE_REPORT_STATUSES],
            description: 'completed: the assignment is done. blocked: you need input. progress: a mid-task update.',
          },
          content: { type: 'string', maxLength: 20000, description: 'The result, or what blocks you.' },
          ...reportHandoffProperties(report),
        },
        required: ['status', 'content'],
      }),
      // Same dispatcher as `report.*` in codemode, so validation matches.
      execute: async (args: ReportToolInput) => dispatchReport(report, args),
    }));
  }

  // Outside BUILTIN_TOOLS: exists only on Plan turns.
  const submitPlan = deps.submitPlan;

  if (submitPlan) {
    tools.submit_plan = permitInPlan(tool({
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
      throw new Error(
        `Builtin tool name '${name}' starts with the reserved 'mcp_' prefix. ` +
        `That prefix is owned by per-user MCP tools — pick a different name.`,
      );
    }
  }

  return toolsInWorkMode(deps.workMode ?? 'build', withCheckedInputs(tools));
}

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

function isExecutableToolEntry(
  input: { value: unknown },
): input is { value: ExecutableToolEntry } {
  return v.is(v.object({
    inputSchema: v.unknown(),
    execute: v.function(),
  }), input.value);
}

/** Build `eval` over a finished surface; `buildActorTools` calls it before the effect-claim wrap. */
export function installCodemode(
  surface: ToolSet,
  build: CodemodeBuilder,
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

  const built = build({ native: toolsInWorkMode(deps.workMode ?? 'build', surface), craftedTools, providers: rt.executionRouter?.getProviders() ?? [] });
  const clamp = { vfs: rt.storage.vfs, producer: 'eval' as const };
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
      const entry = { value: buildFromSurface.output(surface) };

      if (isExecutableToolEntry(entry)) surface.eval = withCheckedInput('eval', entry.value);
    }
  }

  const finished = deps.post === undefined ? surface : { ...surface, ...withCheckedInputs(deps.post) };
  const modeBound = toolsInWorkMode(deps.workMode ?? 'build', finished);

  return deps.wrapFinished === undefined ? modeBound : deps.wrapFinished(modeBound);
}
