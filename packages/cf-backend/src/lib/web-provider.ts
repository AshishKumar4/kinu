/**
 * The one cf-side construction of the shared web-search/fetch provider
 * (core web/provider.ts): Worker global fetch + optional owner-scoped auth
 * (Tavily upgrade) + env.AI.toMarkdown as the HTML→markdown override.
 * OrchestratorAgent and ExplorationAgent both build through here so the
 * wiring cannot drift between them.
 */

import {
  createDefaultWebSearchProvider,
  type AuthResolver, type ModelCallSink, type WebSearchProvider,
} from "@kinu/core";

interface WebProviderEnv {
  readonly AI?: Env['AI'];
}

/**
 * @param resolveAuth Thunk resolving the owner-scoped auth resolver, or
 *   undefined when the agent has no owner yet. Resolved PER CALL, not baked at
 *   construction: this provider (and the toolset holding it) is cached across
 *   turns, and the first web call may precede owner claim — a baked-undefined
 *   resolver would then never see the Tavily credential even after the claim.
 */
export function buildCfWebSearchProvider(
  env: WebProviderEnv,
  resolveAuth: () => AuthResolver | undefined,
  reportModelCall?: ModelCallSink,
): WebSearchProvider {
  const ai = env.AI;
  const options: Parameters<typeof createDefaultWebSearchProvider>[0] = {
    fetch: globalThis.fetch,
    getAuth: async (key, opts) => {
      const auth = resolveAuth();
      return auth ? auth(key, opts) : null;
    },
  };
  if (ai) {
    options.htmlToMarkdown = async (html: string, opts?: { url?: string }) => {
      const name = (opts?.url ?? "page") + ".html";
      const blob = new Blob([html], { type: "text/html" });
      const out = await ai.toMarkdown([{ name, blob }]);
      // A model ran and the account was billed neurons for it, but the binding
      // returns only the markdown — so the CALL is reportable and its cost is
      // not. Counted here rather than omitted, because a workspace total that
      // silently drops a whole producer is the thing that cannot be trusted.
      reportModelCall?.({ source: "platform", usage: {}, modelId: "toMarkdown" });
      const converted = out[0];
      return converted?.format === "markdown" ? converted.data : "";
    };
  }
  return createDefaultWebSearchProvider(options);
}
