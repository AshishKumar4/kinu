/**
 * The `execute_tools` codemode tool — one construction, shared by every CF
 * actor that has a runtime.
 *
 * The LLM's code runs in a codemode sandbox where each provider is a namespace:
 * `codemode.*` (crafted tools, spliced in as a `const tools = {…}` preamble by
 * PreambleCraftedExecutor so mid-turn saves are callable on the next step),
 * `llm.*` (recursive LM calls), `web.*`, plus one namespace per registered
 * ExecutionRouter provider (`workspace`, `sandbox`, `nimbus`, `laptop`).
 *
 * Actors differ only in the fields of `ExecuteToolsOptions`: an orchestrator
 * adds its MCP providers and records the last-active executor for the UI; a
 * head (an ExplorationAgent fork) supplies neither.
 */

import { createCodeTool } from "@cloudflare/codemode/ai";
import type { SqlExecutor } from "@proteus/core";
import { createWebCodemodeProvider, type WebSearchProvider } from "@proteus/core";
import { PreambleCraftedExecutor, selectInjectableCraftedTools } from "./crafted-tool-registry.js";
import { createRLMProvider, type CodemodeProvider } from "./rlm.js";
import type { AgentProviderRegistry } from "./providers/agent-registry.js";
import type { CFRuntime } from "./runtime.js";

export interface ExecuteToolsOptions {
  /** env.LOADER — the WorkerLoader every sandboxed execute runs inside. */
  loader: unknown;
  /** The actor's runtime: craftStore (preamble source) + executionRouter
   *  (the `workspace` / `sandbox` / `nimbus` / `laptop` namespaces). */
  rt: CFRuntime;
  /** The actor's bound SQL — craft-score lookups for injectable-tool selection. */
  sql: SqlExecutor;
  registry: AgentProviderRegistry;
  /** The actor's configured model spec, read per call (llm.query default). */
  modelSpec: () => string | null;
  webSearch: WebSearchProvider;
  /** Providers beyond the shared set (the orchestrator's MCP namespaces).
   *  Spliced between `llm` and `web` so provider order — and therefore the
   *  LLM-visible type description — is stable across actor kinds. */
  extraProviders?: () => CodemodeProvider[];
  /** Notified with the provider name whenever one of its tools ran. The
   *  orchestrator uses it to remember where work happened (file-manager /
   *  diff default); callers that don't care omit it. */
  onExecutorUsed?: (name: string) => void;
}

export function createExecuteToolsTool(options: ExecuteToolsOptions): unknown {
  const { loader, rt, sql, registry, modelSpec, webSearch } = options;
  if (!loader) throw new Error("CF runtime missing LOADER binding");

  const executor = new PreambleCraftedExecutor(loader, rt.craftStore, sql);

  // Seed the `codemode` provider with the INJECTABLE crafted tools at
  // construction time so the LLM's initial description string lists them —
  // the same selection the preamble makes, so the advertised set can't
  // disagree with the callable set.
  const seededCraftedTools: Record<string, { description: string; execute: (arg: unknown) => Promise<unknown> }> = {};
  for (const t of selectInjectableCraftedTools(rt.craftStore, sql)) {
    seededCraftedTools[t.name] = {
      description: t.description || `Crafted tool: ${t.name}`,
      // Never invoked — the preamble injects the real body as a
      // `tools.<name>` literal in-sandbox, so `codemode.<name>(args)` resolves
      // lexically rather than through this dispatcher. createCodeTool's
      // ToolProvider shape requires an execute, hence the stub.
      execute: async () => ({ error: 'crafted tools run through the preamble, not the dispatcher' }),
    };
  }

  const craftedProvider = { name: 'codemode', tools: seededCraftedTools };
  // Recursive Language Models — `llm.query(text, opts?)` in the sandbox.
  // Sub-call has no llm.query in scope, so depth is bounded at 1.
  const rlmProvider = createRLMProvider(registry, () => registry.normalizeSpecSync(modelSpec()));
  // `web.*` — same web search/fetch provider that backs the web_* tools.
  const webProvider = createWebCodemodeProvider(webSearch);
  const executorProviders = (rt.executionRouter?.getProviders() ?? []).map((p) => {
    const tools = p.tools as Record<string, { description?: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    const wrapped: typeof tools = {};
    for (const [name, entry] of Object.entries(tools)) {
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

  return createCodeTool({
    tools: [
      craftedProvider,
      rlmProvider,
      ...(options.extraProviders?.() ?? []),
      webProvider,
      ...executorProviders,
    ] as Parameters<typeof createCodeTool>[0]["tools"],
    executor: executor as unknown as Parameters<typeof createCodeTool>[0]["executor"],
  });
}
