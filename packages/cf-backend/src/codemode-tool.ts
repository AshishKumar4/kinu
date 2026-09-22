/**
 * The `eval` codemode tool, shared by every CF actor with a runtime. Crafted tools are re-read
 * from the CraftStore on every call, so a tool saved mid-turn is callable on the next program.
 */

import * as v from 'valibot';
import { createCodeTool } from "@cloudflare/codemode/ai";
import { type Tool, type ToolSet } from 'ai';
import type { ActorHandle, AgentsToolDeps, DeviceRequestChannel, SqlExecutor, CraftStore, ExecutionRouter } from "@kinu.run/core";
import {
  createAgentsCodemodeProvider, createWebCodemodeProvider, createStateCodemodeProvider,
  renderCodemodeDescription, renderToolsDeclaration, nativeToolFunctions, CRAFTED_TOOL_NAMESPACE,
  type WebSearchProvider, type CodemodeProvider, type WorkMode,
  currentWorkMode, permitInPlan, toolsInWorkMode, providersInWorkMode,
  selectInjectableCraftedTools,
  withCraftedToolDeclarations, codemodeInputSchema,
  withCodemodeProgram, craftedFailureFunctions,
  codemodeFunction, JsonValueSchema, type JsonObject, type JsonValue, type ToolSurfaceNarrowing,
} from "@kinu.run/core";
import { KinuError } from '@kinu.run/core/obs';
import {
  KinuSandboxExecutor, renderToolsPrelude,
} from "./codemode-sandbox";

export interface CodemodeFactoryOptions {
  loader: WorkerLoader;
  /** The loopback Fetcher the sandbox's `fetch` rides; null keeps it offline. */
  egress: Fetcher | null;
  rt: { actor: ActorHandle; craftStore: Pick<CraftStore, 'list'>; executionRouter?: Pick<ExecutionRouter, 'getProviders'> };
  sql: SqlExecutor;
  workspace: string;
  webSearch: WebSearchProvider;
  /** Read per call so a re-bound model lands without a rebuild; omitted (heads) keeps `agents.*` out. */
  agents?: () => AgentsToolDeps;
  extraProviders?: () => CodemodeProvider[];
  onExecutorUsed?: (name: string) => void;
  /** Read per provider call: the tool is built once per DO lifetime, but the owning job changes on each detach. */
  deviceRequests?: () => DeviceRequestChannel | undefined;
  reach?: ToolSurfaceNarrowing;
}

function withDeviceOwnership(args: unknown[], channel: DeviceRequestChannel | undefined): unknown[] {
  if (!channel) return args;
  const context = args[1];
  // An unpredicted context shape wins over ownership reporting.
  const parsedContext = v.safeParse(v.looseObject({}), context);

  if (context !== undefined && !parsedContext.success) return args;

  const ownership = {
    onDeviceRequest: (requestId: string) => { channel.report(requestId); },
    deviceRequestOwner: () => channel.owningJobId,
  };

  const merged = parsedContext.success ? { ...parsedContext.output, ...ownership } : ownership;

  return [args[0], merged, ...args.slice(2)];
}

export interface CodemodeFactory {
  toolFor(native: ToolSet): Tool;
  callTool(native: ToolSet, name: string, input: JsonObject): Promise<JsonValue | undefined>;
}

export function createCodemodeToolFactory(options: CodemodeFactoryOptions): CodemodeFactory {
  const { loader, rt, sql, webSearch } = options;

  if (!loader) throw new Error("CF runtime missing LOADER binding");
  const craftedTools = () => selectInjectableCraftedTools(rt.craftStore, sql);

  const stateProvider = createStateCodemodeProvider(rt.actor.programState);
  const agentsProvider = options.agents ? createAgentsCodemodeProvider(options.agents) : null;
  const webProvider = createWebCodemodeProvider(webSearch);

  const executorProviders = (rt.executionRouter?.getProviders() ?? []).map((p) => {
    const wrapped: typeof p.tools = {};

    for (const [name, entry] of Object.entries(p.tools)) {
      // Only `exec` mints a durable device-request identity, and it reads context from the second positional arg.
      const carriesOwnership = name === 'exec' && p.positionalArgs === true;
      wrapped[name] = {
        ...entry,
        execute: async (...args) => {
          const result = await entry.execute(
            ...(carriesOwnership ? withDeviceOwnership(args, options.deviceRequests?.()) : args),
          );

          options.onExecutorUsed?.(p.name);

          return result;
        },
      };
    }

    return { name: p.name, tools: wrapped, types: p.types, positionalArgs: p.positionalArgs };
  });

  return {
    async callTool(native, name, input) {
      const call = codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, async () => {
        const functions = nativeToolFunctions(toolsInWorkMode(currentWorkMode(), native));
        const entry = Object.hasOwn(functions, name) ? functions[name] : undefined;

        if (entry !== undefined) {
          if (options.reach !== undefined && !options.reach.allowsTool(name)) throw new KinuError('denied', `${name} is not within this actor's reach right now`);

          return entry.execute(input);
        }

        if (name === 'eval' || (options.reach !== undefined && !options.reach.allowsTool(name) && !options.reach.allowsNamespace(CRAFTED_TOOL_NAMESPACE))) {
          throw new KinuError('denied', `${name} is not within this actor's reach right now`);
        }

        if (!craftedTools().some((tool) => tool.name === name)) {
          throw new KinuError('missing', `tools has no member ${name}`);
        }

        const execute = this.toolFor(native).execute;

        if (execute === undefined) throw new KinuError('unavailable', 'The codemode executor is not callable');

        const result = v.parse(v.object({ result: v.optional(JsonValueSchema) }), await execute({
          code: `return await tools[${JSON.stringify(name)}](${JSON.stringify(input)});`,
        }, { toolCallId: `slate-${crypto.randomUUID()}`, messages: [] }));

        return result.result;
      });

      return call(input);
    },
    toolFor(native) {
      const reachable = options.reach === undefined ? native
        : Object.fromEntries(Object.entries(native).filter(([name]) => options.reach?.allowsTool(name)));

      const build = (mode: WorkMode): Tool => {
        const executor = new KinuSandboxExecutor({ loader, egress: mode === 'plan' ? null : options.egress });

        // No prelude here: createCodeTool drops it; the per-call executor below supplies it.
        const toolsProvider: CodemodeProvider = {
          name: CRAFTED_TOOL_NAMESPACE,
          tools: nativeToolFunctions(toolsInWorkMode(mode, reachable)),
          types: renderToolsDeclaration(reachable, []),
          positionalArgs: true,
        };

        const providers: CodemodeProvider[] = [toolsProvider, stateProvider];

        if (agentsProvider) providers.push(agentsProvider);

        if (options.extraProviders) providers.push(...options.extraProviders());
        providers.push(webProvider, ...executorProviders);
  
        const built = createCodeTool({
          // `{{types}}` is the token createCodeTool substitutes namespace declarations into.
          description: renderCodemodeDescription('{{types}}'),
          tools: providersInWorkMode(mode, options.reach?.narrowProviders(providers) ?? providers),
          executor: {
            // Per call: crafted set and prelude are rebuilt; native fns were frozen at build time.
            execute: (code, resolved) => {
              const crafted = craftedTools();
              const failures = Object.fromEntries(Object.entries(craftedFailureFunctions(crafted)).map(([name, entry]) => [name, entry.execute]));

              const live = Array.isArray(resolved)
                ? resolved.map((provider) => provider.name === CRAFTED_TOOL_NAMESPACE
                  ? {
                    name: provider.name,
                    fns: { ...provider.fns, ...failures },
                    prelude: renderToolsPrelude(
                      crafted,
                      { workspace: options.workspace },
                    ),
                  }
                  : provider)
                : resolved;

              return executor.execute(code, live);
            },
          },
        });

        // Core's input schema: codemode's label says "async arrow function", but the normalizer takes a script body.
        return { ...built, inputSchema: codemodeInputSchema() };
      };

      const unrestricted = build('build');
      let planning: Tool | undefined;

      return withCraftedToolDeclarations(permitInPlan({
        ...unrestricted,
        execute: (input, context) => {
          const selected = currentWorkMode() === 'plan' ? (planning ??= build('plan')) : unrestricted;
          const execute = selected.execute;

          if (execute === undefined) throw new Error('Codemode executor is not callable');

          return withCodemodeProgram(async () => v.parse(v.object({
            result: v.optional(v.unknown()), logs: v.optional(v.array(v.string())),
          }), await execute(input, context)));
        },
      }), craftedTools);
    },
  };
}
