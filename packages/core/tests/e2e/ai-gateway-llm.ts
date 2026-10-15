/** E2E provider; credentials from AI_GATEWAY_BASE_URL, AI_GATEWAY_AUTH and optional AI_GATEWAY_MODEL, never hardcoded. */

import { unobservedSpend } from '@kinu.run/test-utils';
import { createChatModel } from '../../src/llm';
import { generateReported, streamTextReported } from '../../src/providers/model-invocation';
import { withModelStack } from '../../src/providers/wire-model';
import type { ModelCallSpend } from '../../src/events/model-call';
import type { LLM } from '../../src/types/primitives';

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

  const gateway = { baseURL, headers: { 'Authorization': auth }, modelId: model };

  return {
    primary: gatewayLLM({ ...gateway, name: 'workers-ai' }, { source: 'reflection', report: unobservedSpend }),
    judge: gatewayLLM({ ...gateway, name: 'workers-ai-judge' }, { source: 'judge', report: unobservedSpend }),
  };
}

/** The gateway's model through the one stack, as an `LLM`. */
function gatewayLLM(
  gateway: { name: string; baseURL: string; headers: Record<string, string>; modelId: string },
  spend: ModelCallSpend,
): LLM {
  const model = withModelStack(createChatModel({ kind: 'openai-compat', ...gateway }),
    { provider: gateway.name, modelId: gateway.modelId, lane: gateway.name });

  return {
    stream: (opts) => streamTextReported({ model, instructions: opts.system, messages: opts.messages }, { spend }),
    complete: async (prompt) => (await generateReported({ model, prompt }, { spend })).text.trim(),
  };
}
