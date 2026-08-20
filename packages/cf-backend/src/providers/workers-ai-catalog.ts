import { DEFAULT_WORKERS_AI_MODEL_ID, type ModelInfo } from '@kinu/core';

// Prefix-cache pricing (verified 2026-08-15 against the account model catalog;
// affinity behavior was separately confirmed with live two-shot probes):
// deepseek-v4-pro-0813, kimi-k2.6, kimi-k2.7-code, and glm-5.2 bill a discounted
// cached-input rate. llama-4-scout, gpt-oss-*, and nemotron list no cached rate.

export const WORKERS_AI_PREFERRED_MODEL_IDS = [
  DEFAULT_WORKERS_AI_MODEL_ID,
  '@cf/moonshotai/kimi-k2.6',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/google/gemma-4-26b-a4b-it',
];

export const WORKERS_AI_FALLBACK_MODEL_CATALOG: ModelInfo[] = [
  { id: DEFAULT_WORKERS_AI_MODEL_ID,                   label: 'DeepSeek V4 Pro 0813',    capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 1_048_576, inputModalities: ['text'] },
  { id: '@cf/moonshotai/kimi-k2.6',                    label: 'Kimi K2.6',               capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 262_144 },
  { id: '@cf/nvidia/nemotron-3-120b-a12b',             label: 'Nemotron 3 Super 120B',  capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 256_000 },
  { id: '@cf/openai/gpt-oss-120b',                     label: 'GPT OSS 120B',           capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 128_000 },
  { id: '@cf/openai/gpt-oss-20b',                      label: 'GPT OSS 20B',            capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 128_000 },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct',     label: 'Llama 4 Scout',          capabilities: ['tools', 'streaming', 'vision'], contextWindow: 131_000 },
];
