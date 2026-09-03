/**
 * The `execute_tools` codemode tool — one construction, shared by every CF
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
 *   workspace.* / sandbox.* / laptop.* / parent.*   one per live executor
 *
 * plus `require()` and `fetch` from the prelude. Actors differ only in the
 * fields of `ExecuteToolsFactoryOptions`: an orchestrator adds its delegation deps
 * and records the last-active executor for the UI; a head supplies neither.
 */

import * as v from 'valibot';
import { createCodeTool } from "@cloudflare/codemode/ai";
import { jsonSchema, tool, type Tool, type ToolSet } from 'ai';
import type { AgentsToolDeps, DeviceRequestChannel, SqlExecutor } from "@kinu.run/core";
import {
  createAgentsCodemodeProvider, createWebCodemodeProvider, createStateCodemodeProvider,
  renderExecuteToolsDescription, renderToolsDeclaration, CRAFTED_TOOL_NAMESPACE,
  type WebSearchProvider, type CodemodeProvider,
} from "@kinu.run/core";
import {
  KinuSandboxExecutor, nativeToolFunctions, renderToolsPrelude, selectInjectableCraftedTools,
} from "./codemode-sandbox";
import type { CFRuntime } from "./runtime";

export interface ExecuteToolsFactoryOptions {
  /** env.LOADER — the WorkerLoader every sandboxed execute runs inside. */
  loader: WorkerLoader;
  /** The loopback Fetcher the sandbox's `fetch` rides; null keeps it offline. */
  egress: Fetcher | null;
  /** The actor's runtime: craftStore (crafted source) and executionRouter
   *  (the `workspace` / `sandbox` / `laptop` namespaces). */
  rt: Pick<CFRuntime, 'craftStore' | 'executionRouter'>;
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
   * THIS `execute_tools` invocation's device-request ownership channel, or
   * undefined when nothing owns it yet. Read per provider call, not at
   * construction: the tool is built once per DO lifetime, and which job owns
   * a device request changes every time a call detaches.
   */
  deviceRequests?: () => DeviceRequestChannel | undefined;
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

/** The native surface the sandbox exposes: everything but the sandbox itself. */
function sandboxNativeTools(all: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(all)) {
    if (name === 'execute_tools') continue;
    out[name] = tool;
  }
  return out;
}

/**
 * The entry `buildActorTools` is handed for `execute_tools` while the native
 * set is still being built. It is replaced by {@link ExecuteToolsFactory.toolFor}
 * the moment that set exists; nothing calls it.
 */
export const SANDBOX_TOOL_PLACEHOLDER: Tool = tool({
  description: 'execute_tools (not yet built for this turn)',
  inputSchema: jsonSchema<{ code: string }>({
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
  }),
  execute: async (): Promise<string> => {
    throw new Error('execute_tools was handed out before the turn tool surface finished building');
  },
});

/** What `createExecuteToolsFactory` hands back: one `execute_tools` tool per
 *  finished native tool set. */
export interface ExecuteToolsFactory {
  /** The tool for a native surface that is FINISHED (built, narrowed). Its
   *  declaration lists every tool in `native` except `execute_tools` itself,
   *  and every crafted tool the store holds at this moment. */
  toolFor(native: ToolSet): Tool;
}

export function createExecuteToolsFactory(options: ExecuteToolsFactoryOptions): ExecuteToolsFactory {
  const { loader, rt, sql, webSearch } = options;
  if (!loader) throw new Error("CF runtime missing LOADER binding");

  const executor = new KinuSandboxExecutor({ loader, egress: options.egress });
  const stateProvider = createStateCodemodeProvider(sql);
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
    toolFor(finished) {
      const native = sandboxNativeTools(finished);
      const crafted = selectInjectableCraftedTools(rt.craftStore, sql);
      // The `tools` namespace: native tools dispatched to the host, crafted
      // tools defined in the prelude. The declaration is rendered from the set
      // as it is NOW; the callable half is re-read on every call below.
      const toolsProvider: CodemodeProvider = {
        name: CRAFTED_TOOL_NAMESPACE,
        tools: nativeToolFunctions(native),
        types: renderToolsDeclaration(native, crafted),
        positionalArgs: true,
        prelude: renderToolsPrelude(crafted, { workspace: options.workspace }),
      };
      const providers: Parameters<typeof createCodeTool>[0]["tools"] = [toolsProvider, stateProvider];
      if (agentsProvider) providers.push(agentsProvider);
      if (options.extraProviders) providers.push(...options.extraProviders());
      providers.push(webProvider, ...executorProviders);

      return createCodeTool({
        // The docstring is core's (registry.renderExecuteToolsDescription):
        // `{{types}}` is the token createCodeTool substitutes the assembled
        // namespace declarations into.
        description: renderExecuteToolsDescription('{{types}}'),
        tools: providers,
        executor: {
          // Per call: the crafted set is re-read so a tool saved a program ago
          // is callable now, and the `tools` prelude is rebuilt from the same
          // rows. createCodeTool froze the native fns when the tool was built;
          // they are the finished set's, which is what this tool exists for.
          execute: (code, resolved) => {
            const live = Array.isArray(resolved)
              ? resolved.map((provider) => provider.name === CRAFTED_TOOL_NAMESPACE
                ? {
                  name: provider.name,
                  fns: provider.fns,
                  prelude: renderToolsPrelude(
                    selectInjectableCraftedTools(rt.craftStore, sql),
                    { workspace: options.workspace },
                  ),
                }
                : provider)
              : resolved;
            return executor.execute(code, live);
          },
        },
      });
    },
  };
}
