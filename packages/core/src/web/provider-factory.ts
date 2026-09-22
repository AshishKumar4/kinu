/** The one cf-side construction of the shared web provider, so wiring cannot drift between actors. */

import { createDefaultWebSearchProvider, type WebSearchProvider } from './provider';
import { REAL_CLOCK } from '../types/clock';
import type { AuthResolver } from '../providers/types';
import type { ModelCallSink } from '../events/model-call';

/** Structural so core compiles without the Worker's ambient `Env`. */
interface WorkersAiToMarkdown {
  toMarkdown(files: { name: string; blob: Blob }[]): Promise<
    ({ format: 'markdown'; data: string } | { format: 'error' })[]
  >;
}

interface WebProviderEnv {
  readonly AI?: WorkersAiToMarkdown;
}

/**
 * @param resolveAuth Resolved per call, not at construction: the provider is cached across turns and the
 *   first web call may precede owner claim.
 */
export function buildCfWebSearchProvider(
  env: WebProviderEnv,
  resolveAuth: () => AuthResolver | undefined,
  reportModelCall?: ModelCallSink,
): WebSearchProvider {
  const ai = env.AI;

  const options: Parameters<typeof createDefaultWebSearchProvider>[0] = {
    fetch: globalThis.fetch,
    clock: REAL_CLOCK,
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
      // The binding returns no cost, so the call is counted without one rather than omitted.
      reportModelCall?.({ source: "platform", usage: {}, modelId: "toMarkdown" });
      const converted = out[0];

      return converted?.format === "markdown" ? converted.data : "";
    };
  }

  return createDefaultWebSearchProvider(options);
}
