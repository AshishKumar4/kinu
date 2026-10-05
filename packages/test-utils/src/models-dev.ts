/** models.dev's Workers AI rows for Kinu's preferred models, read 2026-10-05: the platform's live model list. */
export const WORKERS_AI_MODELS_DEV = {
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai', name: 'Workers AI',
    models: {
      '@cf/zai-org/glm-5.3': { id: '@cf/zai-org/glm-5.3', name: 'Glm 5.3', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }], modalities: { input: ['text'] }, limit: { context: 1_048_576, output: 1_048_576 } },
      '@cf/deepseek-ai/deepseek-v4-pro-0813': { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], modalities: { input: ['text'] }, limit: { context: 1_048_576, output: 1_048_576 } },
      '@cf/moonshotai/kimi-k2.6': { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'high'] }], modalities: { input: ['text', 'image'] }, limit: { context: 262_144, output: 256_000 } },
      '@cf/nvidia/nemotron-3-120b-a12b': { id: '@cf/nvidia/nemotron-3-120b-a12b', name: 'Nemotron 3 Super 120B', tool_call: true, reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'high'] }], modalities: { input: ['text'] }, limit: { context: 256_000, output: 256_000 } },
      '@cf/openai/gpt-oss-120b': { id: '@cf/openai/gpt-oss-120b', name: 'GPT OSS 120B', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }], modalities: { input: ['text'] }, limit: { context: 128_000, output: 16_384 } },
      '@cf/openai/gpt-oss-20b': { id: '@cf/openai/gpt-oss-20b', name: 'GPT OSS 20B', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }], modalities: { input: ['text'] }, limit: { context: 128_000, output: 16_384 } },
      '@cf/meta/llama-4-scout-17b-16e-instruct': { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B 16E Instruct', tool_call: true, reasoning: false, modalities: { input: ['text', 'image'] }, limit: { context: 131_000, output: 16_384 } },
    },
  },
};
