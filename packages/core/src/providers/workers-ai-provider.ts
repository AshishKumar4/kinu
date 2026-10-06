// Workers AI provider, billed to the user's Cloudflare OAuth account, or to the deployment's through its binding.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { type ModelProvider, type ModelInfo } from './types';

import { DEFAULT_WORKERS_AI_MODEL_ID, SESSION_AFFINITY_HEADER } from './workers-ai';
import { listModelsDevProviderModels } from './models-dev';
import { createCloudflareAIFetch } from './cloudflare-ai-fetch';
import { createDirectWorkersAIFetch } from './direct-workers-ai-fetch';
import { WORKERS_AI_PREFERRED_MODEL_IDS } from './workers-ai-catalog';
import { CLOUDFLARE_OAUTH_CRED_KEY } from './cloudflare-oauth';

export function createWorkersAIProvider(deploymentBinding?: Parameters<typeof createDirectWorkersAIFetch>[0]): ModelProvider {
  return {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    defaultModel: DEFAULT_WORKERS_AI_MODEL_ID,
    async isAvailable(deps) {
      if (deploymentBinding) return true;
      const auth = await deps.getAuth(CLOUDFLARE_OAUTH_CRED_KEY);

      return Boolean(auth?.baseURL);
    },
    unavailableReason: () => 'Cloudflare OAuth login is required for Workers AI billing.',
    listModels: (deps): Promise<ModelInfo[]> => listModelsDevProviderModels('cloudflare-workers-ai', deps, {
      required: true,
      preferredIds: WORKERS_AI_PREFERRED_MODEL_IDS,
    }),
    createModel(modelId, deps): LanguageModel {
      const requestHeaders = { [SESSION_AFFINITY_HEADER]: deps.sessionAffinity };

      if (deploymentBinding) {
        return createOpenAICompatible({
          name: 'workers-ai',
          baseURL: 'https://kinu-direct-workers-ai.invalid',
          headers: requestHeaders,
          fetch: createDirectWorkersAIFetch(deploymentBinding, {
            provider: 'workers-ai',
            modelId,
            ...(deps.onProviderWait !== undefined && { onWait: deps.onProviderWait }),
          }),
        }).chatModel(modelId);
      }

      const placeholder = 'https://kinu-workers-ai.invalid';

      const customFetch = createCloudflareAIFetch({
        credKey: CLOUDFLARE_OAUTH_CRED_KEY,
        getAuth: deps.getAuth,
        fetch: deps.fetch,
        provider: 'workers-ai',
        modelId,
        onProviderWait: deps.onProviderWait,
        placeholder,
        missingCredentialMessage: 'Cloudflare login is required before using Workers AI models.',
        // Without replica pinning the prefix cache never hits.
        requestHeaders,
      });

      return createOpenAICompatible({
        name: 'workers-ai',
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
