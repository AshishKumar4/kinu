/** The one cf-side construction of the shared web provider, so wiring cannot drift between actors. */

import { createDefaultWebSearchProvider, type BrowserCookie, type WebSearchProvider } from './provider';
import { bindingQuickActions, type BrowserRunQuickActions } from './browser-run';
import { bindingWebSearch } from './first-party-search';
import type { AuthResolver } from '../providers/types';
import type { ModelCallSink } from '../events/model-call';
import { workersAiHtmlToMarkdown, type WorkersAiMarkdown, type WorkersAiWebSearch } from '../providers/model-invocation';

/** Structural so core compiles without the Worker's ambient `Env`. */
interface WebProviderEnv {
  readonly AI?: WorkersAiMarkdown & Partial<WorkersAiWebSearch>;
  /** The platform's gateway, which the deployment's own search runs on (`first-party-search.ts`). */
  readonly AI_GATEWAY_URL?: string;
  readonly BROWSER: BrowserRunQuickActions;
}

/**
 * @param resolveAuth Resolved per call, not at construction: the provider is cached across turns and the
 *   first web call may precede owner claim.
 * @param previewPass What Browser Run carries to the workspace's own previews, which open only for their owner.
 */
export function buildCfWebSearchProvider(
  env: WebProviderEnv,
  resolveAuth: () => AuthResolver | undefined,
  reportModelCall: ModelCallSink,
  previewPass?: (url: URL) => Promise<BrowserCookie | null>,
): WebSearchProvider {
  const options: Parameters<typeof createDefaultWebSearchProvider>[0] = {
    fetch: globalThis.fetch,
    getAuth: async (key, opts) => {
      const auth = resolveAuth();

      return auth ? auth(key, opts) : null;
    },
    browser: { quickActions: bindingQuickActions(env.BROWSER) },
    ...(previewPass !== undefined && { previewPass }),
  };

  const htmlToMarkdown = workersAiHtmlToMarkdown(env, reportModelCall);

  if (htmlToMarkdown) options.htmlToMarkdown = htmlToMarkdown;
  const firstParty = bindingWebSearch(env, reportModelCall);

  if (firstParty !== null) options.firstParty = firstParty;

  return createDefaultWebSearchProvider(options);
}
