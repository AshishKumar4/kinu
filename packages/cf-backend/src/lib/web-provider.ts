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

export function buildCfWebSearchProvider(env: unknown, getAuth: AuthResolver | undefined): WebSearchProvider {
  const ai = (env as { AI?: AiToMarkdown }).AI;
  return createDefaultWebSearchProvider({
    fetch: globalThis.fetch,
    ...(getAuth ? { getAuth } : {}),
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
