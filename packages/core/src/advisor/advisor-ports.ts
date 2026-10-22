/**
 * What a backend hands the in-session advisor: its model on the advisor's route, and read-only file and memory tools.
 * The tools are the agent's own operations, served again over a ledger of the advisor's own: an advisor read must not
 * count as the agent's, which is what lets the agent edit a file.
 */
import type { Tool, ToolSet } from 'ai';
import * as v from 'valibot';
import { TurnContextBudget } from '../context-budget';
import type { ModelCallSpend } from '../events/model-call';
import { onRoute, routeRetryOptions, type RouteModelBinder, type RouteWalk } from '../profiles/model-lane';
import type { ModelRouteResolution } from '../profiles/model-route';
import { generateReported, type GenerateRequest } from '../providers/model-invocation';
import { serveFile, type FileDeps } from '../tools/file-operations';
import { serveMemory, type MemoryDeps } from '../tools/memory-operations';
import { nativeTool } from '../tools/operation-surfaces';
import { BUILTIN_TOOL_DESCRIPTIONS } from '../tools/registry';
import { TurnFileLedger } from '../vfs/file-ledger';
import { JsonValueSchema } from '../utils/json';
import type { Served } from '../operations/operation';
import type { AdvisorModel } from './session-advisor';

/** The file operations that change nothing. */
export const ADVISOR_FILE_OPERATIONS: ReadonlySet<string> = new Set(['read', 'list', 'stat', 'search']);

/** The memory operations that change nothing. */
export const ADVISOR_MEMORY_OPERATIONS: ReadonlySet<string> = new Set(['recall', 'search', 'searchConversations', 'readConversation', 'listConversations']);

const READ_ONLY = 'Read-only: the operations that change nothing.';

function readOnly(served: readonly Served[], allowed: ReadonlySet<string>): Served[] {
  return served.filter((member) => allowed.has(member.op.name));
}

/** The advisor's read-only tools: `file` and `memory`, each absent where the agent has none. */
export interface AdvisorReadTools {
  readonly file?: Tool;
  readonly memory?: Tool;
}

/** The advisor's read-only tools over the agent's file plane and memory, each absent where the agent has none. */
export function advisorReadTools(planes: {
  readonly files?: () => Omit<FileDeps, 'ledger' | 'budget' | 'memory'>;
  readonly memory?: () => MemoryDeps;
}): AdvisorReadTools {
  const ledger = new TurnFileLedger();
  const budget = new TurnContextBudget();
  const { files, memory } = planes;

  return {
    ...(files !== undefined && {
      file: nativeTool(`${BUILTIN_TOOL_DESCRIPTIONS.file} ${READ_ONLY}`, readOnly(Object.values(serveFile(() => ({ ...files(), ledger, budget }))), ADVISOR_FILE_OPERATIONS)),
    }),
    ...(memory !== undefined && {
      memory: nativeTool(`${BUILTIN_TOOL_DESCRIPTIONS.memory} ${READ_ONLY}`, readOnly(serveMemory(memory), ADVISOR_MEMORY_OPERATIONS)),
    }),
  };
}

const ToolCallSchema = v.object({ toolCallId: v.string(), toolName: v.string(), input: JsonValueSchema });

/** What a backend binds the advisor's model calls with: its registry's binder, its route walk and its spend sink. */
export type AdvisorLane = RouteWalk & {
  readonly bind: RouteModelBinder;
  readonly spend: Omit<ModelCallSpend, 'source'>;
};

/** The advisor's model on its route: the route's fallbacks walked, each call billed as the advisor's. */
export function routedAdvisorModel(route: ModelRouteResolution, lane: AdvisorLane): AdvisorModel {
  return async ({ system, messages, tools }) => await onRoute(route, lane, async (serving) => {
    const { model, providerOptions } = lane.bind(serving);
    const request: GenerateRequest = { model, system, messages: [...messages], tools: tools satisfies ToolSet, ...routeRetryOptions(serving) };

    if (providerOptions !== undefined) request.providerOptions = { ...request.providerOptions, ...providerOptions };
    const result = await generateReported(request, { spend: { ...lane.spend, source: route.source }, spec: serving.model });

    return {
      toolCalls: result.toolCalls.map((call) => v.parse(ToolCallSchema, { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input })),
      responseMessages: result.response.messages,
    };
  });
}
