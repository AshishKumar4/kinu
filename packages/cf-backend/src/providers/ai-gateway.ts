// Cloudflare AI Gateway provider — the unified `/compat` OpenAI endpoint, which
// serves EVERY upstream under one URL + bearer: partner models by `<provider>/
// <model>` (e.g. `minimax/m3`) and Workers AI by `workers-ai/@cf/<model>`.
// `env.AI_GATEWAY_URL` must point at the gateway's `/compat` base.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@proteus/core';

const MODELS: ModelInfo[] = [
  // MiniMax M3 — 1M-context frontier model with tools. The default. Paid partner
  // model: the gateway needs balance or BYOK (else "add money to your gateway").
  { id: 'minimax/m3',                                         label: 'MiniMax M3 (1M ctx)',    capabilities: ['tools', 'streaming', 'reasoning'] },
  { id: 'workers-ai/@cf/moonshotai/kimi-k2.6',                label: 'Kimi K2.6 (gateway)',    capabilities: ['tools', 'streaming'] },
  { id: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout (gateway)', capabilities: ['tools', 'streaming'] },
];

export function createAIGatewayProvider(): ModelProvider {
  return {
    id: 'ai-gateway',
    label: 'Cloudflare AI Gateway',
    defaultModel: 'minimax/m3',
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
