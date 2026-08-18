// The PLATFORM's Cloudflare AI Gateway — the deploy-time provider used when no
// user credential is reachable. A user's OWN gateway is the separate
// `my-gateway` provider (providers/my-gateway.ts). Proxies to Workers AI /
// OpenAI / Anthropic upstreams under one URL; pass any modelId understood by
// the upstream configured in `env.AI_GATEWAY_URL`.
//
// Requests ride the Workers AI binding, not HTTPS (core providers/gateway-binding-fetch.ts).
// The gateway named by `AI_GATEWAY_URL` lives in this Worker's own account, so
// binding calls are pre-authenticated: no API token to mint, and the bill lands
// on the same account as before. The USER-billed providers (workers-ai,
// my-gateway) deliberately do NOT use the binding — their spend must stay on the
// logged-in user's account, and a binding call would silently move it here.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderEnv, WorkersAIBinding, GatewayTarget } from '@proteus/core';
import {
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  createGatewayBindingFetch,
  listModelsDevProviderModels,
  parseGatewayTarget,
  withRateLimitRetry,
} from '@proteus/core';
import {
  WORKERS_AI_FALLBACK_MODEL_CATALOG,
  WORKERS_AI_PREFERRED_MODEL_IDS,
} from './workers-ai-catalog';

export const AI_GATEWAY_PROVIDER_ID = 'ai-gateway';

/** Everything needed to reach the platform gateway, or why it is unreachable.
 *  The ONE predicate: `isAvailable`, the reason text, `createModel` and the
 *  registry's sync default all resolve through it, so the set of environments
 *  reported usable is exactly the set that works. */
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
        // Never fetched. The SDK builds `{baseURL}/chat/completions` and the
        // transport parses that into the binding's {gateway, provider, endpoint}.
        baseURL: String(deps.env.AI_GATEWAY_URL),
        fetch: withRateLimitRetry(createGatewayBindingFetch(resolved)),
      }).chatModel(modelId);
    },
  };
}
