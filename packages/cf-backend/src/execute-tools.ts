/**
 * The `execute_tools` codemode tool — one construction, shared by every CF
 * actor that has a runtime.
 *
 * The LLM's code runs in a codemode sandbox where each provider is a namespace:
 * `codemode.*` (crafted tools, spliced in as a `const tools = {…}` preamble by
 * PreambleCraftedExecutor so mid-turn saves are callable on the next step),
 * `agents.*` (delegation), `web.*`, plus one namespace per registered
 * ExecutionRouter provider (`workspace`, `sandbox`, `laptop`).
 *
 * Actors differ only in the fields of `ExecuteToolsOptions`: an orchestrator
 * adds its MCP providers, its delegation deps, and records the last-active
 * executor for the UI; a head (an ExplorationAgent fork) supplies none of them,
 * so `split_subheads` stays its only way to start anything.
 */

import * as v from 'valibot';
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { AgentsToolDeps, DeviceRequestChannel, SqlExecutor } from "@kinu.run/core";
import {
  createAgentsCodemodeProvider, createWebCodemodeProvider,
  renderExecuteToolsDescription,
  CRAFTED_TOOL_ALIAS_NAMESPACE, craftedDispatcherEntry,
  type CraftedDispatcherEntry,
  type WebSearchProvider, type CodemodeProvider,
} from "@kinu.run/core";
import { PreambleCraftedExecutor, selectInjectableCraftedTools } from "./crafted-tool-registry";
import type { CFRuntime } from "./runtime";

export interface ExecuteToolsOptions {
  /** env.LOADER — the WorkerLoader every sandboxed execute runs inside. */
  loader: WorkerLoader;
  /** The actor's runtime: craftStore (preamble source) and executionRouter
   *  (the `workspace` / `sandbox` / `laptop` namespaces). */
  rt: Pick<CFRuntime, 'craftStore' | 'executionRouter'>;
  /** The actor's bound SQL — craft-score lookups for injectable-tool selection. */
  sql: SqlExecutor;
  webSearch: WebSearchProvider;
  /** The actor's delegation deps, read per call so a re-bound model or a fresh
   *  MCTS session lands without rebuilding the tool. Omitted by actors that
   *  cannot delegate (heads), which is what keeps `agents.*` out of their
   *  sandbox — absent deps, the same containment as the top-level tool. */
  agents?: () => AgentsToolDeps;
  /** Providers beyond the shared set (the orchestrator's MCP namespaces).
   *  Spliced between `agents` and `web` so provider order — and therefore the
   *  LLM-visible type description — is stable across actor kinds. */
  extraProviders?: () => CodemodeProvider[];
  /** Notified with the provider name whenever one of its tools ran. The
   *  orchestrator uses it to remember where work happened (file-manager /
   *  diff default); callers that don't care omit it. */
  onExecutorUsed?: (name: string) => void;
  /**
   * THIS `execute_tools` invocation's device-request ownership channel, or
   * undefined when the call cannot detach (nothing armed a holder).
   *
   * Read per provider call, not once: the tool is constructed once per DO
   * lifetime while the channel belongs to ONE invocation, and the owning job id
   * inside it changes the moment that invocation detaches. A script's laptop
   * execs then report their request identities exactly as top-level `run` does,
   * so a detached `execute_tools` owns the device work it started.
   */
  deviceRequests?: () => DeviceRequestChannel | undefined;
}

/**
 * The sandbox's own `exec` arguments, with this invocation's device-request
 * ownership merged into the context slot.
 *
 * The sandbox marshals a script's call as JSON and the host dispatches it as
 * `fn(...args)` (codemode's ToolDispatcher), so a function cannot cross that
 * boundary and the context has to be added HERE, on the host side of the
 * wrapper. MERGED rather than assigned: a script may have passed exec options
 * of its own in that slot, and replacing them would change the call it made.
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

/**
 * What `codemode.<name>` resolves to for a crafted tool.
 *
 * Both the entry and the sentence it raises are core's
 * (tools/sandbox-contract.ts): the callable form is `tools.<name>`, spliced in
 * by the preamble, and `codemode.<name>` merely DECLARES the name in the types
 * the model reads. This backend used to spell that correction itself, and the
 * CLI sandbox bound the crafted set under both names — so code the model wrote
 * against the alias ran locally and threw in the cloud. One declaration now
 * answers for both substrates; all that is left here is the compile substrate
 * (worker-loader preamble vs `new Function`).
 */
export function createExecuteToolsTool(options: ExecuteToolsOptions) {
  const { loader, rt, sql, webSearch } = options;
  if (!loader) throw new Error("CF runtime missing LOADER binding");

  const executor = new PreambleCraftedExecutor(loader, rt.craftStore, sql);

  // Seed the `codemode` provider with the INJECTABLE crafted tools at
  // construction time so the LLM's initial description string lists them —
  // the same selection the preamble makes, so the advertised set can't
  // disagree with the callable set.
  const seededCraftedTools: Record<string, CraftedDispatcherEntry> = {};
  for (const t of selectInjectableCraftedTools(rt.craftStore, sql)) {
    seededCraftedTools[t.name] = craftedDispatcherEntry(t.name, t.description);
  }

  const craftedProvider = { name: CRAFTED_TOOL_ALIAS_NAMESPACE, tools: seededCraftedTools };
  // `agents.*` — the delegation tool projected into the sandbox, so a workflow
  // is a crafted tool scripting agents/workspace rather than a new engine.
  // Ahead of extraProviders: this namespace's shape is fixed by the actor's
  // wired transports, while the MCP set behind it varies per user connection.
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

  const providers: Parameters<typeof createCodeTool>[0]["tools"] = [craftedProvider];
  if (agentsProvider) providers.push(agentsProvider);
  if (options.extraProviders) providers.push(...options.extraProviders());
  providers.push(webProvider, ...executorProviders);
  // The docstring is core's (registry.renderExecuteToolsDescription), not
  // codemode's DEFAULT_DESCRIPTION: `{{types}}` is the token createCodeTool
  // substitutes the assembled namespace declarations into, and letting it do
  // that substitution keeps its ability to generate a declaration for a
  // provider that ships none of its own.
  return createCodeTool({
    description: renderExecuteToolsDescription('{{types}}'),
    tools: providers,
    executor,
  });
}
