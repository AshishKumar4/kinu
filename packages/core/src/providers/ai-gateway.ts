// The platform's AI Gateway: the deploy-time provider when no user credential is reachable.
// Rides the Workers AI binding (pre-authenticated, same account). User-billed providers must not:
// a binding call would move their spend onto this account.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderEnv, WorkersAIBinding } from './types';
import { createGatewayBindingFetch, parseGatewayTarget, type GatewayTarget } from './gateway-binding-fetch';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from './workers-ai';
import { listModelsDevProviderModels } from './models-dev';
import { withRateLimitRetry } from './rate-limit-retry';
import {
  WORKERS_AI_FALLBACK_MODEL_CATALOG,
  WORKERS_AI_PREFERRED_MODEL_IDS,
} from './workers-ai-catalog';

export const AI_GATEWAY_PROVIDER_ID = 'ai-gateway';

/** How to reach the platform gateway, or why not: the one predicate every availability check uses. */
export type PlatformGateway =
  | { target: GatewayTarget; binding: WorkersAIBinding }
  | { reason: string };

export function resolvePlatformGateway(env: ProviderEnv): PlatformGateway {
  const target = parseGatewayTarget(env.AI_GATEWAY_URL);

  if ('reason' in target) return target;
  const binding = env.AI;

  if (!binding) {
    return { reason: 'Workers AI binding (env.AI) missing — add "ai": { "binding": "AI" } to wrangler.jsonc.' };
  }

  return { target, binding };
}

export function createAIGatewayProvider(): ModelProvider {
  return {
    id: AI_GATEWAY_PROVIDER_ID,
    label: 'Cloudflare AI Gateway (platform)',
    defaultModel: DEFAULT_WORKERS_AI_MODEL_SPEC,
    isAvailable: deps => !('reason' in resolvePlatformGateway(deps.env)),
    unavailableReason: (deps) => {
      const resolved = resolvePlatformGateway(deps.env);

      return 'reason' in resolved ? resolved.reason : undefined;
    },
    async listModels(deps): Promise<ModelInfo[]> {
      const models = await listModelsDevProviderModels('cloudflare-workers-ai', deps, {
        fallback: WORKERS_AI_FALLBACK_MODEL_CATALOG,
        preferredIds: WORKERS_AI_PREFERRED_MODEL_IDS,
      });

      return models.map((model) => ({
        ...model,
        id: `workers-ai/${model.id}`,
        label: `${model.label ?? model.id} (gateway)`,
        capabilities: model.capabilities ? [...model.capabilities] : undefined,
      }));
    },
    createModel(modelId, deps): LanguageModel {
      const resolved = resolvePlatformGateway(deps.env);

      if ('reason' in resolved) throw new Error(`ai-gateway unavailable: ${resolved.reason}`);

      return createOpenAICompatible({
        name: AI_GATEWAY_PROVIDER_ID,
        // Never fetched: the transport parses the SDK's URL into the binding's {gateway, provider, endpoint}.
        baseURL: String(deps.env.AI_GATEWAY_URL),
        fetch: withRateLimitRetry(createGatewayBindingFetch(resolved), {
          provider: AI_GATEWAY_PROVIDER_ID,
          modelId,
          ...(deps.onProviderWait !== undefined && { onWait: deps.onProviderWait }),
        }),
      }).chatModel(modelId);
    },
  };
}
