/**
 * OpenAI-compatible inference proxy for signed-in CLI clients:
 *
 *   POST /api/user/ai/v1/chat/completions
 *   GET  /api/user/ai/v1/models
 *
 * Fronts the caller's stored Cloudflare credential in production, so local
 * agents use the same account as cloud agents. A staging or local deployment
 * with `DEV_USER_EMAIL` uses the platform AI Gateway binding for Workers AI
 * models; this lets the isolated eval-service account run without borrowing a
 * person's Cloudflare login. Auth is the standard CLI bearer (interactive
 * `ptc_…` session tokens, or scoped `pta_…` access tokens carrying
 * `ai.proxy`); the gate lives in cli/routes.ts.
 *
 * The body's `model` field selects the upstream:
 *   @cf/...          → production: the user's Workers AI account
 *                      development/staging: the platform AI Gateway binding
 *   {author}/{model} → the user's AI Gateway
 *
 * Streaming responses pass through without buffering. Production failures use
 * the same actionable mapping as the cloud providers.
 */
import type { UserDO } from './user-do';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY } from '../lib/cloudflare-oauth';
import { createCloudflareAIFetch, errorResponse, mapGatewayError } from '../providers/cloudflare-ai-fetch';
import { createUserDOAuthResolver } from '../providers/agent-registry';
import { MY_GATEWAY_PROVIDER_ID } from '../providers/my-gateway';
import { createDirectWorkersAIFetch } from '../providers/direct-workers-ai-fetch';
import { listAvailableModels } from './available-models';
import { json } from '../lib/http';
import { ownerCaller } from './workspace-capability';
import { JsonObjectSchema, USER_AI_PROXY_PATH, type JsonObject } from '@kinu.run/core';
import { classify } from '@kinu.run/core/obs';
import * as v from 'valibot';

const PROXY_PLACEHOLDER = 'https://kinu-user-ai-proxy.invalid';
const ChatCompletionRouteSchema = v.object({
  model: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

export async function handleUserAIProxyRequest(
  request: Request,
  env: Env,
  cli: { userId: string; userDO: DurableObjectStub<UserDO> },
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(USER_AI_PROXY_PATH.length);

  if (path === '/models' && request.method === 'GET') {
    const menu = await listAvailableModels(env, cli.userId, await ownerCaller(env));
    return json({
      object: 'list',
      data: menu.models
        .filter((m) => m.provider === 'workers-ai' || m.provider === MY_GATEWAY_PROVIDER_ID)
        .map((m) => ({ id: m.spec.slice(m.provider.length + 1), object: 'model', owned_by: m.provider })),
    });
  }

  if (path === '/chat/completions' && request.method === 'POST') {
    return proxyChatCompletion(request, env, cli.userDO);
  }

  return errorResponse(404, `No such AI proxy route: ${request.method} ${path}`);
}

async function proxyChatCompletion(request: Request, env: Env, userDO: DurableObjectStub<UserDO>): Promise<Response> {
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


/** Forward the client's Workers AI prefix-cache pin so same-agent local turns
 *  land on the same replica — the parity of agentAffinityKey for DO agents. */
function affinityHeader(request: Request): Record<string, string> | undefined {
  const affinity = request.headers.get('x-session-affinity');
  return affinity ? { 'x-session-affinity': affinity } : undefined;
}
