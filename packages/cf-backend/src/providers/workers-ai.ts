// Workers AI provider — uses the `env.AI` binding (Cloudflare-billed, no API key).
// CF-specific: depends on the `Ai` global from @cloudflare/workers-types, which
// is why this lives in cf-backend rather than core.
import { createWorkersAI } from 'workers-ai-provider';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@proteus/core';

const MODELS: ModelInfo[] = [
  { id: '@cf/moonshotai/kimi-k2.6',                       label: 'Kimi K2.6',            capabilities: ['tools', 'streaming'] },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct',        label: 'Llama 4 Scout',        capabilities: ['tools', 'streaming', 'vision'] },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',       label: 'Llama 3.3 70B (fast)', capabilities: ['tools', 'streaming'] },
  { id: '@cf/openai/gpt-oss-120b',                        label: 'GPT-OSS 120B',         capabilities: ['tools', 'streaming'] },
  { id: '@cf/openai/gpt-oss-20b',                         label: 'GPT-OSS 20B',          capabilities: ['tools', 'streaming'] },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct',            label: 'Qwen 2.5 Coder 32B',   capabilities: ['tools', 'streaming'] },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',   label: 'DeepSeek R1 Distill',  capabilities: ['streaming', 'reasoning'] },
];

export interface WorkersAIOptions {
  /** Prefix-cache affinity key — routes same-key requests to the same replica. */
  sessionAffinity?: string;
}

export function createWorkersAIProvider(opts: WorkersAIOptions = {}): ModelProvider {
  return {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    defaultModel: '@cf/moonshotai/kimi-k2.6',
    isAvailable: deps => !!deps.env.AI && typeof deps.env.AI !== 'string',
    unavailableReason: () => 'env.AI binding missing (`"ai": { "binding": "AI" }` in wrangler.jsonc).',
    listModels: () => MODELS,
    createModel(modelId, deps): LanguageModel {
      const binding = deps.env.AI;
      if (!binding || typeof binding === 'string') {
        throw new Error('Workers AI provider invoked without env.AI binding.');
      }
      // `binding` is the Cloudflare `Ai` runtime object — structurally what
      // workers-ai-provider's factory accepts as its `binding` parameter.
      const factory = createWorkersAI({ binding: binding as Ai });
      return factory(modelId, opts.sessionAffinity ? { sessionAffinity: opts.sessionAffinity } : {});
    },
  };
}
