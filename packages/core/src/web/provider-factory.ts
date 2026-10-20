/** The one cf-side construction of the shared web provider, so wiring cannot drift between actors. */

import { createDefaultWebSearchProvider, type BrowserCookie, type WebSearchProvider } from './provider';
import { bindingQuickActions, type BrowserRunQuickActions } from './browser-run';
import { bindingWebSearch, chainWebSearch, type WebSearchChain } from './search-chain';
import type { AuthResolver } from '../providers/types';
import type { ModelCallSink } from '../events/model-call';
import { workersAiHtmlToMarkdown, type WorkersAiMarkdown, type WorkersAiWebSearch } from '../providers/model-invocation';

/** Structural so core compiles without the Worker's ambient `Env`. */
interface WebProviderEnv {
  readonly AI?: WorkersAiMarkdown & Partial<WorkersAiWebSearch>;
  /** The platform's gateway, which the deployment's own search runs on (`search-chain.ts`). */
  readonly AI_GATEWAY_URL?: string;
  readonly BROWSER: BrowserRunQuickActions;
}

/** What a search reads of the owner's account, per search: the provider is cached across turns, the first web call may
 *  precede owner claim, and a change in Settings applies from the next search. */
interface SearchingOwner {
  readonly auth: () => AuthResolver | undefined;
  readonly chain: () => Promise<WebSearchChain>;
}

/** @param previewPass What Browser Run carries to the workspace's own previews, which open only for their owner. */
export function buildCfWebSearchProvider(
  env: WebProviderEnv,
  owner: SearchingOwner,
  reportModelCall: ModelCallSink,
  previewPass?: (url: URL) => Promise<BrowserCookie | null>,
): WebSearchProvider {
  const deployment = bindingWebSearch(env);

  const search = chainWebSearch({
    fetch: globalThis.fetch,
    getAuth: async (key, opts) => {
      const auth = owner.auth();

      return auth ? auth(key, opts) : null;
    },
    ...(deployment !== null && { deployment }),
    report: reportModelCall,
    chain: owner.chain,
  });

  const options: Parameters<typeof createDefaultWebSearchProvider>[0] = {
    fetch: globalThis.fetch,
    search,
    browser: { quickActions: bindingQuickActions(env.BROWSER) },
    ...(previewPass !== undefined && { previewPass }),
  };

  const htmlToMarkdown = workersAiHtmlToMarkdown(env, reportModelCall);

  if (htmlToMarkdown) options.htmlToMarkdown = htmlToMarkdown;

  return createDefaultWebSearchProvider(options);
}
