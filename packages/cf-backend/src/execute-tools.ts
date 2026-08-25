/**
 * The `execute_tools` codemode tool — one construction, shared by every CF
 * actor that has a runtime.
 *
 * The LLM's code runs in a codemode sandbox where each provider is a namespace:
 * `codemode.*` (crafted tools, spliced in as a `const tools = {…}` preamble by
 * PreambleCraftedExecutor so mid-turn saves are callable on the next step),
 * `llm.*` (recursive LM calls), `agents.*` (delegation), `web.*`, plus one
 * namespace per registered ExecutionRouter provider (`workspace`, `sandbox`,
 * `laptop`).
 *
 * Actors differ only in the fields of `ExecuteToolsOptions`: an orchestrator
 * adds its MCP providers, its delegation deps, and records the last-active
 * executor for the UI; a head (an ExplorationAgent fork) supplies none of them,
 * so `split_subheads` stays its only way to start anything.
 */

import { createCodeTool } from "@cloudflare/codemode/ai";
import type { AgentsToolDeps, SqlExecutor } from "@kinu.run/core";
import {
  createAgentsCodemodeProvider, createWebCodemodeProvider, createRLMProvider,
  renderExecuteToolsDescription,
  CRAFTED_TOOL_ALIAS_NAMESPACE, craftedDispatcherEntry,
  type CraftedDispatcherEntry,
  type WebSearchProvider, type CodemodeProvider,
} from "@kinu.run/core";
import { PreambleCraftedExecutor, selectInjectableCraftedTools } from "./crafted-tool-registry";
import type { AgentProviderRegistry } from "./providers/agent-registry";
import type { CFRuntime } from "./runtime";

export interface ExecuteToolsOptions {
  /** env.LOADER — the WorkerLoader every sandboxed execute runs inside. */
  loader: WorkerLoader;
  /** The actor's runtime: craftStore (preamble source) + executionRouter
   *  (the `workspace` / `sandbox` / `laptop` namespaces). */
  rt: Pick<CFRuntime, 'craftStore' | 'executionRouter'>;
  /** The actor's bound SQL — craft-score lookups for injectable-tool selection. */
  sql: SqlExecutor;
  registry: AgentProviderRegistry;
  /** The actor's configured model spec, read per call (llm.query default). */
  modelSpec: () => string | null;
  webSearch: WebSearchProvider;
  /** The actor's delegation deps, read per call so a re-bound model or a fresh
   *  MCTS session lands without rebuilding the tool. Omitted by actors that
   *  cannot delegate (heads), which is what keeps `agents.*` out of their
   *  sandbox — absent deps, the same containment as the top-level tool. */
  agents?: () => AgentsToolDeps;
  /** Providers beyond the shared set (the orchestrator's MCP namespaces).
   *  Spliced between `llm` and `web` so provider order — and therefore the
   *  LLM-visible type description — is stable across actor kinds. */
  extraProviders?: () => CodemodeProvider[];
  /** Notified with the provider name whenever one of its tools ran. The
   *  orchestrator uses it to remember where work happened (file-manager /
   *  diff default); callers that don't care omit it. */
  onExecutorUsed?: (name: string) => void;
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
  const { loader, rt, sql, registry, modelSpec, webSearch } = options;
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
  // Recursive Language Models — `llm.query(text, opts?)` in the sandbox.
  // Sub-call has no llm.query in scope, so depth is bounded at 1.
  const rlmProvider = createRLMProvider(registry, () => registry.normalizeSpecSync(modelSpec()));
  // `agents.*` — the delegation tool projected into the sandbox, so a workflow
  // is a crafted tool scripting agents/llm/workspace rather than a new engine.
  // Ahead of extraProviders: this namespace's shape is fixed by the actor's
  // wired transports, while the MCP set behind it varies per user connection.
  const agentsProvider = options.agents ? createAgentsCodemodeProvider(options.agents) : null;
  // `web.*` — same web search/fetch provider that backs the web_* tools.
  const webProvider = createWebCodemodeProvider(webSearch);
  const executorProviders = (rt.executionRouter?.getProviders() ?? []).map((p) => {
    const wrapped: typeof p.tools = {};
    for (const [name, entry] of Object.entries(p.tools)) {
      wrapped[name] = {
        ...entry,
        execute: async (...args) => {
          const result = await entry.execute(...args);
          options.onExecutorUsed?.(p.name);
          return result;
        },
      };
    }
    return { name: p.name, tools: wrapped, types: p.types, positionalArgs: p.positionalArgs };
  });

  const providers: Parameters<typeof createCodeTool>[0]["tools"] = [craftedProvider, rlmProvider];
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
