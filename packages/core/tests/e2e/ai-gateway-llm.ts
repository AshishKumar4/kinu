/** E2E provider; credentials from AI_GATEWAY_BASE_URL, AI_GATEWAY_AUTH and optional AI_GATEWAY_MODEL, never hardcoded. */

import { createVercelAILLM } from '../../src/llm';

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

export function isE2EConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_BASE_URL && process.env.AI_GATEWAY_AUTH);
}

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
