// Workers AI provider — uses the logged-in user's Cloudflare OAuth credential.
// The model is constructed synchronously; the account-scoped base URL and
// bearer token are resolved from UserDO inside customFetch on each request.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@proteus/core';
import { asFetchFunction, listModelsDevProviderModels } from '@proteus/core';
import { CLOUDFLARE_OAUTH_CRED_KEY } from '../lib/cloudflare-oauth.js';
import {
  DEFAULT_WORKERS_AI_MODEL_ID,
  WORKERS_AI_FALLBACK_MODEL_CATALOG,
  WORKERS_AI_PREFERRED_MODEL_IDS,
} from './workers-ai-catalog.js';

export interface WorkersAIOptions {
  /** Prefix-cache affinity key — routes same-key requests to the same replica. */
  sessionAffinity?: string;
}

/** Stable per-agent Workers AI session-affinity key — pins an agent's turns to
 *  the same replica so the (default-on) prefix cache actually hits across turns.
 *  Same `proteus-<name>` scheme as the sandbox id; one source so the 5 registry
 *  call sites don't drift. */
export function agentAffinityKey(name: string): string {
  return `proteus-${name}`;
}

export function createWorkersAIProvider(opts: WorkersAIOptions = {}): ModelProvider {
  return {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    defaultModel: DEFAULT_WORKERS_AI_MODEL_ID,
    async isAvailable(deps) {
      const auth = await deps.getAuth(CLOUDFLARE_OAUTH_CRED_KEY);
      return !!auth?.baseURL;
    },
    unavailableReason: () => 'Cloudflare OAuth login is required for Workers AI billing.',
    listModels: (deps): Promise<ModelInfo[]> => listModelsDevProviderModels('cloudflare-workers-ai', deps, {
      fallback: WORKERS_AI_FALLBACK_MODEL_CATALOG,
      preferredIds: WORKERS_AI_PREFERRED_MODEL_IDS,
    }),
    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const placeholder = 'https://proteus-workers-ai.invalid';
      const customFetch = asFetchFunction(async (input, init) => {
        const auth = await deps.getAuth(CLOUDFLARE_OAUTH_CRED_KEY);
        if (!auth?.baseURL) {
          return new Response(
            JSON.stringify({ error: 'Cloudflare login is required before using Workers AI models.' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }

        const headers = new Headers(init?.headers);
        for (const [key, value] of Object.entries(auth.headers)) headers.set(key, value);
        // Replica pinning for the server-side prefix cache — without this
        // header same-agent turns route randomly and the cache never hits.
        if (opts.sessionAffinity) headers.set('x-session-affinity', opts.sessionAffinity);
        const originalUrl = typeof input === 'string' ? input
          : input instanceof URL ? input.toString()
            : input.url;
        const url = originalUrl.startsWith(placeholder)
          ? auth.baseURL.replace(/\/+$/, '') + originalUrl.slice(placeholder.length)
          : originalUrl;
        return baseFetch(url, { ...init, headers });
      });

      return createOpenAICompatible({
        name: 'workers-ai',
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
