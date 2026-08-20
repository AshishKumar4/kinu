// Workers AI provider — uses the logged-in user's Cloudflare OAuth credential.
// Chat inference always uses the account-scoped REST endpoint below, not
// env.AI.run. The installed workers-ai-provider binding path directly awaits
// binding.run and exposes no typed/status-bearing capacity error to intercept;
// env.AI remains limited to non-chat features such as embeddings/HTML repair.
// The model is constructed synchronously; the account-scoped base URL and
// bearer token are resolved from UserDO inside customFetch on each request.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@kinu/core';
import { DEFAULT_WORKERS_AI_MODEL_ID, listModelsDevProviderModels } from '@kinu/core';
import { CLOUDFLARE_OAUTH_CRED_KEY } from '../lib/cloudflare-oauth';
import { createCloudflareAIFetch } from './cloudflare-ai-fetch';
import {
  WORKERS_AI_FALLBACK_MODEL_CATALOG,
  WORKERS_AI_PREFERRED_MODEL_IDS,
} from './workers-ai-catalog';

export interface WorkersAIOptions {
  /** Prefix-cache affinity key — routes same-key requests to the same replica. */
  sessionAffinity?: string;
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
      const placeholder = 'https://proteus-workers-ai.invalid';
      const customFetch = createCloudflareAIFetch({
        credKey: CLOUDFLARE_OAUTH_CRED_KEY,
        getAuth: deps.getAuth,
        fetch: deps.fetch,
        placeholder,
        missingCredentialMessage: 'Cloudflare login is required before using Workers AI models.',
        // Replica pinning for the server-side prefix cache — without this
        // header same-agent turns route randomly and the cache never hits.
        requestHeaders: opts.sessionAffinity ? { 'x-session-affinity': opts.sessionAffinity } : undefined,
      });

      return createOpenAICompatible({
        name: 'workers-ai',
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
