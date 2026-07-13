/**
 * The one cf-side construction of the shared web-search/fetch provider
 * (core web/provider.ts): Worker global fetch + optional owner-scoped auth
 * (Tavily upgrade) + env.AI.toMarkdown as the HTML→markdown override.
 * OrchestratorAgent and ExplorationAgent both build through here so the
 * wiring cannot drift between them.
 */

import { createDefaultWebSearchProvider, type AuthResolver, type WebSearchProvider } from "@proteus/core";

interface AiToMarkdown {
  toMarkdown?: (docs: Array<{ name: string; blob: Blob }>) => Promise<Array<{ data: string }>>;
}

/**
 * @param resolveAuth Thunk resolving the owner-scoped auth resolver, or
 *   undefined when the agent has no owner yet. Resolved PER CALL, not baked at
 *   construction: this provider (and the toolset holding it) is cached across
 *   turns, and the first web call may precede owner claim — a baked-undefined
 *   resolver would then never see the Tavily credential even after the claim.
 */
export function buildCfWebSearchProvider(
  env: unknown,
  resolveAuth: () => AuthResolver | undefined,
): WebSearchProvider {
  const ai = (env as { AI?: AiToMarkdown }).AI;
  return createDefaultWebSearchProvider({
    fetch: globalThis.fetch,
    getAuth: async (key, opts) => {
      const auth = resolveAuth();
      return auth ? auth(key, opts) : null;
    },
    ...(ai?.toMarkdown
      ? {
          htmlToMarkdown: async (html: string, opts?: { url?: string }) => {
            const name = (opts?.url ?? "page") + ".html";
            const blob = new Blob([html], { type: "text/html" });
            const out = await ai.toMarkdown!([{ name, blob }]);
            return out[0]?.data ?? "";
          },
        }
      : {}),
  });
}
