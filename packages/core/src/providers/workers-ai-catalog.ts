import { DEFAULT_WORKERS_AI_MODEL_ID } from './workers-ai';
import type { ModelInfo } from './types';
import type { ReasoningEffort } from './reasoning-effort';

// deepseek-v4-pro-0813, kimi-k2.6, kimi-k2.7-code, and glm-5.2 bill a discounted cached-input
// rate; llama-4-scout, gpt-oss-*, and nemotron list none.

export const WORKERS_AI_PREFERRED_MODEL_IDS = [
  DEFAULT_WORKERS_AI_MODEL_ID,
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/google/gemma-4-26b-a4b-it',
];

/** Offline `reasoning_effort` per https://developers.cloudflare.com/workers-ai/models/<name>/;
 *  the live list reads models.dev. */
const LOW_MEDIUM_HIGH: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export const WORKERS_AI_FALLBACK_MODEL_CATALOG: ModelInfo[] = [
  // Per developers.cloudflare.com/workers-ai/models/glm-5.3.
  { id: DEFAULT_WORKERS_AI_MODEL_ID,                   label: 'GLM 5.3',                 capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 1_048_576, inputModalities: ['text'], reasoningEfforts: LOW_MEDIUM_HIGH },
  { id: '@cf/deepseek-ai/deepseek-v4-pro-0813',        label: 'DeepSeek V4 Pro 0813',    capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 1_048_576, inputModalities: ['text'], reasoningEfforts: LOW_MEDIUM_HIGH },
  { id: '@cf/moonshotai/kimi-k2.6',                    label: 'Kimi K2.6',               capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 262_144, reasoningEfforts: LOW_MEDIUM_HIGH },
  { id: '@cf/nvidia/nemotron-3-120b-a12b',             label: 'Nemotron 3 Super 120B',  capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 256_000, reasoningEfforts: LOW_MEDIUM_HIGH },
  { id: '@cf/openai/gpt-oss-120b',                     label: 'GPT OSS 120B',           capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 128_000, reasoningEfforts: LOW_MEDIUM_HIGH },
  { id: '@cf/openai/gpt-oss-20b',                      label: 'GPT OSS 20B',            capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 128_000, reasoningEfforts: LOW_MEDIUM_HIGH },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct',     label: 'Llama 4 Scout',          capabilities: ['tools', 'streaming', 'vision'], contextWindow: 131_000, reasoningEfforts: [] },
];
