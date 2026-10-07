// Workers AI provider, billed to the user's Cloudflare OAuth account, or to the deployment's through its binding.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { createWorkersAI, type WorkersAISettings } from 'workers-ai-provider';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ModelCallDeps, ModelInfo, ModelProvider } from './types';

import { DEFAULT_WORKERS_AI_MODEL_ID, SESSION_AFFINITY_HEADER } from './workers-ai';
import { listModelsDevProviderModels } from './models-dev';
import { createCloudflareAIFetch } from './cloudflare-ai-fetch';
import { WORKERS_AI_PREFERRED_MODEL_IDS } from './workers-ai-catalog';
import { CLOUDFLARE_OAUTH_CRED_KEY } from './cloudflare-oauth';
import { toolCallIdMiddleware } from './middleware/tool-call-id';
import { heardBinding, heardFetch } from './middleware/attempt';

/** `env.AI` as the provider takes it: `Ai` where workers-types are loaded. */
type WorkersAIChatBinding = NonNullable<WorkersAISettings['binding']>;

export function createWorkersAIProvider(deploymentBinding?: WorkersAIChatBinding): ModelProvider {
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
      // Without replica pinning the prefix cache never hits.
      const model = deploymentBinding
        ? createWorkersAI({ binding: heardBinding(deploymentBinding) }).chat(modelId, { sessionAffinity: deps.sessionAffinity })
        : userAccountModel(modelId, deps);

      return wrapLanguageModel({ model, middleware: toolCallIdMiddleware() });
    },
  };
}

function userAccountModel(modelId: string, deps: ModelCallDeps): LanguageModelV4 {
  const placeholder = 'https://kinu-workers-ai.invalid';

  const customFetch = createCloudflareAIFetch({
    credKey: CLOUDFLARE_OAUTH_CRED_KEY,
    getAuth: deps.getAuth,
    fetch: deps.fetch,
    provider: 'workers-ai',
    placeholder,
    missingCredentialMessage: 'Cloudflare login is required before using Workers AI models.',
    requestHeaders: { [SESSION_AFFINITY_HEADER]: deps.sessionAffinity },
  });

  return createOpenAICompatible({
    name: 'workers-ai',
    baseURL: placeholder,
    fetch: heardFetch(customFetch),
  }).chatModel(modelId);
}
