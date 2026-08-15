/**
 * AI Gateway LLM provider for E2E tests.
 *
 * All credentials come from environment variables — NEVER hardcoded.
 * Uses the shared createVercelAILLM from core.
 *
 * Required env vars:
 *   AI_GATEWAY_BASE_URL  — Workers AI base URL
 *   AI_GATEWAY_AUTH      — Authorization header value (Bearer ...)
 *   AI_GATEWAY_MODEL     — Model ID (default: @cf/deepseek-ai/deepseek-v4-pro-0813)
 */

import { createVercelAILLM } from '../../src/llm.js';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var: ${name}. ` +
      `Set it in .env or export it. See .env.example for required variables.`,
    );
  }
  return value;
}

/** Check whether E2E test credentials are configured */
export function isE2EConfigured(): boolean {
  return !!(process.env.AI_GATEWAY_BASE_URL && process.env.AI_GATEWAY_AUTH);
}

/**
 * Create LLM providers for E2E tests.
 * Reads credentials from environment variables.
 */
export function loadAIGatewayProviders() {
  const baseURL = getRequiredEnv('AI_GATEWAY_BASE_URL');
  const auth = getRequiredEnv('AI_GATEWAY_AUTH');
  const model = process.env.AI_GATEWAY_MODEL ?? '@cf/deepseek-ai/deepseek-v4-pro-0813';

  const config = {
    name: 'workers-ai',
    baseURL,
    headers: { 'Authorization': auth },
    model,
  };

  return {
    primary: createVercelAILLM(config),
    judge: createVercelAILLM({ ...config, name: 'workers-ai-judge' }),
  };
}
