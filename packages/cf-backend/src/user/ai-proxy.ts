/**
 * OpenAI-compatible inference proxy for signed-in CLI clients (chat/completions, models).
 * `@cf/...` models use the user's Workers AI account, or the platform AI Gateway binding when
 * `DEV_USER_EMAIL` is set; `{author}/{model}` uses the user's AI Gateway. Auth gate: cli/routes.ts.
 */
import { createUserDOAuthResolver, type UserCredentialClient } from '../providers/agent-registry';
import type { OwnerCapabilityEnv, ProviderEnv } from '@kinu.run/core';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY } from '@kinu.run/core';
import { createCloudflareAIFetch, errorResponse, mapGatewayError } from '@kinu.run/core';
import { MY_GATEWAY_PROVIDER_ID } from '@kinu.run/core';
import { createDirectWorkersAIFetch } from '@kinu.run/core';
import { listAvailableModels, type AvailableModelsEnv } from './available-models';
import { json } from '@kinu.run/core';
import { ownerCaller } from '@kinu.run/core';
import { JsonObjectSchema, USER_AI_PROXY_PATH, type JsonObject } from '@kinu.run/core';
import { classify } from '@kinu.run/core/obs';
import * as v from 'valibot';

const PROXY_PLACEHOLDER = 'https://kinu-user-ai-proxy.invalid';

const ChatCompletionRouteSchema = v.object({
  model: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

/** The eval identity's direct transport calls `run` on the same binding the gateway path uses. */
export interface UserAIProxyEnv<Id> extends AvailableModelsEnv<Id>, OwnerCapabilityEnv {
  AI?: NonNullable<ProviderEnv['AI']> & NonNullable<Parameters<typeof createDirectWorkersAIFetch>[0]>;
}

export async function handleUserAIProxyRequest<Id>(
  request: Request,
  env: UserAIProxyEnv<Id>,
  cli: { userId: string; userDO: UserCredentialClient },
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(USER_AI_PROXY_PATH.length);

  if (path === '/models' && request.method === 'GET') {
    const menu = await listAvailableModels(env, cli.userId, await ownerCaller(env));

    return json({
      body: {
        object: 'list',
        data: menu.models
          .filter((m) => m.provider === 'workers-ai' || m.provider === MY_GATEWAY_PROVIDER_ID)
          .map((m) => ({ id: m.spec.slice(m.provider.length + 1), object: 'model', owned_by: m.provider })),
      },
    });
  }

  if (path === '/chat/completions' && request.method === 'POST') {
    return proxyChatCompletion(request, env, cli.userDO);
  }

  return errorResponse(404, `No such AI proxy route: ${request.method} ${path}`);
}

async function proxyChatCompletion<Id>(
  request: Request, env: UserAIProxyEnv<Id>, userDO: UserCredentialClient,
): Promise<Response> {
  const body = await request.text();
  let bodyValue: JsonObject;
  let model: string;

  try {
    bodyValue = v.parse(JsonObjectSchema, JSON.parse(body));
    model = v.parse(ChatCompletionRouteSchema, bodyValue).model;
  } catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;

    return errorResponse(400, 'Body must be JSON with a non-empty model.');
  }

  const workersAI = model.startsWith('@cf/');

  if (!workersAI && !model.includes('/')) {
    return errorResponse(400, `Cannot route model "${model}" — use "@cf/{model}" (Workers AI) or "{provider}/{model}" (your AI Gateway).`);
  }

  if (workersAI && env.DEV_USER_EMAIL) {
    if (!env.AI) return errorResponse(503, 'Workers AI binding unavailable.');

    return createDirectWorkersAIFetch(env.AI)(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
    });
  }

  const aiFetch = createCloudflareAIFetch({
    credKey: workersAI ? CLOUDFLARE_OAUTH_CRED_KEY : CLOUDFLARE_AI_GATEWAY_CRED_KEY,
    provider: workersAI ? 'workers-ai' : 'my-gateway',
    modelId: model,
    getAuth: createUserDOAuthResolver({ stub: userDO, caller: await ownerCaller(env) }),
    placeholder: PROXY_PLACEHOLDER,
    missingCredentialMessage: workersAI
      ? 'Connect Cloudflare in your Kinu user settings before using Workers AI models.'
      : 'Connect Cloudflare and select an AI Gateway in your Kinu user settings before using my-gateway models.',
    requestHeaders: affinityHeader(request),
    mapError: (res, resolved) => mapGatewayError(res, model, resolved.headers['cf-aig-gateway-id']),
  });

  return aiFetch(`${PROXY_PLACEHOLDER}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}


/** Forwards the Workers AI prefix-cache pin so same-agent local turns hit the same replica. */
function affinityHeader(request: Request): Record<string, string> | undefined {
  const affinity = request.headers.get('x-session-affinity');

  return affinity ? { 'x-session-affinity': affinity } : undefined;
}
