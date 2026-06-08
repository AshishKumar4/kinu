import type { ModelInfo } from '@proteus/core';

export const DEFAULT_WORKERS_AI_MODEL_ID = '@cf/moonshotai/kimi-k2.6';
export const DEFAULT_WORKERS_AI_MODEL_SPEC = `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`;

export const WORKERS_AI_MODEL_CATALOG: ModelInfo[] = [
  { id: DEFAULT_WORKERS_AI_MODEL_ID,                       label: 'Kimi K2.6',            capabilities: ['tools', 'streaming'] },
  { id: 'minimax/m3',                                      label: 'MiniMax M3 (1M ctx)',  capabilities: ['tools', 'streaming', 'reasoning'] },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct',         label: 'Llama 4 Scout',        capabilities: ['tools', 'streaming', 'vision'] },
  { id: '@cf/meta/llama-4-maverick-17b-128e-instruct',     label: 'Llama 4 Maverick',     capabilities: ['tools', 'streaming', 'vision'] },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',        label: 'Llama 3.3 70B (fast)', capabilities: ['tools', 'streaming'] },
  { id: '@cf/openai/gpt-oss-120b',                         label: 'GPT-OSS 120B',         capabilities: ['tools', 'streaming'] },
  { id: '@cf/openai/gpt-oss-20b',                           label: 'GPT-OSS 20B',         capabilities: ['tools', 'streaming'] },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct',             label: 'Qwen 2.5 Coder 32B',   capabilities: ['tools', 'streaming'] },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',    label: 'DeepSeek R1 Distill',  capabilities: ['streaming', 'reasoning'] },
];
