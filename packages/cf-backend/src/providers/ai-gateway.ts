// Cloudflare AI Gateway provider — proxies to Workers AI / OpenAI / Anthropic
// upstreams under one URL + bearer. Pass any modelId understood by the upstream
// configured in `env.AI_GATEWAY_URL`.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@proteus/core';

const MODELS: ModelInfo[] = [
  { id: 'workers-ai/@cf/moonshotai/kimi-k2.6',                label: 'Kimi K2.6 (gateway)',    capabilities: ['tools', 'streaming'] },
  { id: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout (gateway)', capabilities: ['tools', 'streaming'] },
];

export function createAIGatewayProvider(): ModelProvider {
  return {
    id: 'ai-gateway',
    label: 'Cloudflare AI Gateway',
    defaultModel: 'workers-ai/@cf/moonshotai/kimi-k2.6',
    isAvailable: deps => {
      const url = deps.env.AI_GATEWAY_URL;
      const auth = deps.env.AI_GATEWAY_AUTH;
      return typeof url === 'string' && !!url && typeof auth === 'string' && !!auth;
    },
    unavailableReason: () => 'AI_GATEWAY_URL var or AI_GATEWAY_AUTH secret missing.',
    listModels: () => MODELS,
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
