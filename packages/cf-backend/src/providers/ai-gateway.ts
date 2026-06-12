// The PLATFORM's Cloudflare AI Gateway — env-bound (AI_GATEWAY_URL +
// AI_GATEWAY_AUTH worker secret), used as the deploy-time fallback when no
// user credential is reachable. A user's OWN gateway is the separate
// `my-gateway` provider (providers/my-gateway.ts). Proxies to Workers AI /
// OpenAI / Anthropic upstreams under one URL + bearer; pass any modelId
// understood by the upstream configured in `env.AI_GATEWAY_URL`.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@proteus/core';
import { DEFAULT_WORKERS_AI_MODEL_SPEC, listModelsDevProviderModels } from '@proteus/core';
import {
  WORKERS_AI_FALLBACK_MODEL_CATALOG,
  WORKERS_AI_PREFERRED_MODEL_IDS,
} from './workers-ai-catalog.js';

export function createAIGatewayProvider(): ModelProvider {
  return {
    id: 'ai-gateway',
    label: 'Cloudflare AI Gateway (platform)',
    defaultModel: DEFAULT_WORKERS_AI_MODEL_SPEC,
    isAvailable: deps => {
      const url = deps.env.AI_GATEWAY_URL;
      const auth = deps.env.AI_GATEWAY_AUTH;
      return typeof url === 'string' && !!url && typeof auth === 'string' && !!auth;
    },
    unavailableReason: () => 'AI_GATEWAY_URL var or AI_GATEWAY_AUTH secret missing.',
    async listModels(deps): Promise<ModelInfo[]> {
      const models = await listModelsDevProviderModels('cloudflare-workers-ai', deps, {
        fallback: WORKERS_AI_FALLBACK_MODEL_CATALOG,
        preferredIds: WORKERS_AI_PREFERRED_MODEL_IDS,
      });
      return models.map((model) => ({
        ...model,
        id: `workers-ai/${model.id}`,
        label: `${model.label ?? model.id} (gateway)`,
        capabilities: model.capabilities ? [...model.capabilities] : undefined,
      }));
    },
    createModel(modelId, deps): LanguageModel {
      const auth = String(deps.env.AI_GATEWAY_AUTH);
      return createOpenAICompatible({
        name: 'ai-gateway',
        baseURL: String(deps.env.AI_GATEWAY_URL),
        headers: { Authorization: auth.startsWith('Bearer ') ? auth : `Bearer ${auth}` },
      }).chatModel(modelId);
    },
  };
}
