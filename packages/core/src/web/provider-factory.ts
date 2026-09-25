/** The one cf-side construction of the shared web provider, so wiring cannot drift between actors. */

import { createDefaultWebSearchProvider, type WebSearchProvider } from './provider';
import { REAL_CLOCK } from '../types/clock';
import type { AuthResolver } from '../providers/types';
import type { ModelCallSink } from '../events/model-call';
import { workersAiHtmlToMarkdown, type WorkersAiMarkdown } from '../providers/model-invocation';

/** Structural so core compiles without the Worker's ambient `Env`. */
interface WebProviderEnv {
  readonly AI?: WorkersAiMarkdown;
}

/**
 * @param resolveAuth Resolved per call, not at construction: the provider is cached across turns and the
 *   first web call may precede owner claim.
 */
export function buildCfWebSearchProvider(
  env: WebProviderEnv,
  resolveAuth: () => AuthResolver | undefined,
  reportModelCall: ModelCallSink,
): WebSearchProvider {
  const options: Parameters<typeof createDefaultWebSearchProvider>[0] = {
    fetch: globalThis.fetch,
    clock: REAL_CLOCK,
    getAuth: async (key, opts) => {
      const auth = resolveAuth();

      return auth ? auth(key, opts) : null;
    },
  };

  const htmlToMarkdown = workersAiHtmlToMarkdown(env, reportModelCall);

  if (htmlToMarkdown) options.htmlToMarkdown = htmlToMarkdown;

  return createDefaultWebSearchProvider(options);
}
