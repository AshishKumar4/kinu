/**
 * The `eval` codemode tool — one construction, shared by every CF
 * actor that has a runtime.
 *
 * The model's program runs in a codemode sandbox (codemode-sandbox.ts) where
 * each provider is a namespace:
 *
 *   tools.*     every native tool this actor has on the turn, plus every
 *               crafted tool it saved — the crafted set is re-read from the
 *               CraftStore on EVERY call, so a tool saved mid-turn is callable
 *               on the next program
 *   state.*     the key/value store that survives between programs
 *   agents.*    delegation (orchestrators only; heads get none)
 *   web.*, memory.*, tasks.*, agent.*, release.*, report.*   the projections
 *   workspace.* / sandbox.* / device.* / parent.*   one per live executor
 *
 * plus `require()` and `fetch` from the prelude. Actors differ only in the
 * fields of `CodemodeFactoryOptions`: an orchestrator adds its delegation deps
 * and records the last-active executor for the UI; a head supplies neither.
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
  /** env.LOADER — the WorkerLoader every sandboxed execute runs inside. */
  loader: WorkerLoader;
  /** The loopback Fetcher the sandbox's `fetch` rides; null keeps it offline. */
  egress: Fetcher | null;
  /** The actor's runtime: craftStore (crafted source) and executionRouter
   *  (the `workspace` / `sandbox` / `device` namespaces). */
  rt: { actor: ActorHandle; craftStore: Pick<CraftStore, 'list'>; executionRouter?: Pick<ExecutionRouter, 'getProviders'> };
  /** The actor's bound SQL — craft-score lookups and the `state` store. */
  sql: SqlExecutor;
  /** The registered workspace name the prelude reports as `env.workspace`. */
  workspace: string;
  webSearch: WebSearchProvider;
  /** The actor's delegation deps, read per call so a re-bound model or a fresh
   *  MCTS session lands without rebuilding the tool. Omitted by actors that
   *  cannot delegate (heads), which is what keeps `agents.*` out of their
   *  sandbox — absent deps, the same containment as the top-level tool. */
  agents?: () => AgentsToolDeps;
  /** Providers beyond the shared set (memory, tasks, agent, release, report). */
  extraProviders?: () => CodemodeProvider[];
  /** Notified with the provider name whenever one of its tools ran. The
   *  orchestrator uses it to remember where work happened (file-manager /
   *  diff default); callers that don't care omit it. */
  onExecutorUsed?: (name: string) => void;
  /**
   * THIS `eval` invocation's device-request ownership channel, or
   * undefined when nothing owns it yet. Read per provider call, not at
   * construction: the tool is built once per DO lifetime, and which job owns
   * a device request changes every time a call detaches.
   */
  deviceRequests?: () => DeviceRequestChannel | undefined;
  /** The caller's current reach, applied to every namespace and native binding. */
  reach?: ToolSurfaceNarrowing;
}

/**
 * The sandbox's own `exec` arguments, with this invocation's device-request
 * ownership merged into the context slot.
 */
function withDeviceOwnership(args: unknown[], channel: DeviceRequestChannel | undefined): unknown[] {
  if (!channel) return args;
  const context = args[1];
  // Anything else in the context slot is a call shape we did not predict, and
  // the script's own argument outranks ownership reporting. `looseObject`
  // admits exactly a plain object and keeps every member it carries.
  const parsedContext = v.safeParse(v.looseObject({}), context);

  if (context !== undefined && !parsedContext.success) return args;

  const ownership = {
    onDeviceRequest: (requestId: string) => { channel.report(requestId); },
    deviceRequestOwner: () => channel.owningJobId,
  };

  const merged = parsedContext.success ? { ...parsedContext.output, ...ownership } : ownership;

  return [args[0], merged, ...args.slice(2)];
}

/** What `createCodemodeToolFactory` hands back: one `eval` tool per
 *  finished native tool set. */
export interface CodemodeFactory {
  /** The tool for a FINISHED native surface. Native declarations are static;
   *  its attached live reader describes the same crafted resolver it calls. */
  toolFor(native: ToolSet): Tool;
  /** A slate calls the same native function or crafted source as tools.<name>. */
  callTool(native: ToolSet, name: string, input: JsonObject): Promise<JsonValue | undefined>;
}

export function createCodemodeToolFactory(options: CodemodeFactoryOptions): CodemodeFactory {
  const { loader, rt, sql, webSearch } = options;

  if (!loader) throw new Error("CF runtime missing LOADER binding");
  const craftedTools = () => selectInjectableCraftedTools(rt.craftStore, sql);

  const stateProvider = createStateCodemodeProvider(rt.actor.programState);
  // `agents.*` — the delegation tool projected into the sandbox, so a workflow
  // is a crafted tool scripting agents/workspace rather than a new engine.
  const agentsProvider = options.agents ? createAgentsCodemodeProvider(options.agents) : null;
  // `web.*` — same web search/fetch provider that backs the web_* tools.
  const webProvider = createWebCodemodeProvider(webSearch);

  const executorProviders = (rt.executionRouter?.getProviders() ?? []).map((p) => {
    const wrapped: typeof p.tools = {};

    for (const [name, entry] of Object.entries(p.tools)) {
      // Ownership rides only `exec`, because `exec` is the only entry that mints
      // a durable device-request identity (core execution/
      // device-tunnel-executor.ts) — and it reads its context out of the SECOND
      // positional argument, which is why the merge needs both facts.
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

        // The `tools` namespace: native tools dispatched to the host, crafted
        // tools defined in the prelude. Native declarations are fixed; crafted
        // callables and the ledger reader resolve the same live source below.
        // Core's two contract functions skip the sandbox's own entry.
        // This build passes no prelude: createCodeTool resolves providers to name
        // plus fns and drops it, so building one here would parse and stringify
        // every crafted tool and discard the result each build.
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
          // The docstring is core's (registry.renderCodemodeDescription):
          // `{{types}}` is the token createCodeTool substitutes the assembled
          // namespace declarations into.
          description: renderCodemodeDescription('{{types}}'),
          tools: providersInWorkMode(mode, options.reach?.narrowProviders(providers) ?? providers),
          executor: {
            // Per call: the crafted set is re-read so a tool saved a program ago
            // is callable now, and the `tools` prelude is rebuilt from the same
            // rows. createCodeTool froze the native fns when the tool was built;
            // they are the finished set's, which is what this tool exists for.
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

        // The field label is core's, not codemode's: createCodeTool ships
        // `code` as "JavaScript async arrow function to execute", while the
        // docstring and the normalizer both take a plain script body. Every
        // other property the tool carries passes through untouched.
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
