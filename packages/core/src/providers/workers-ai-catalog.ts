import { DEFAULT_WORKERS_AI_MODEL_ID } from './workers-ai';

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
