/**
 * OpenAI-compatible inference proxy for signed-in CLI clients:
 *
 *   POST /api/user/ai/v1/chat/completions
 *   GET  /api/user/ai/v1/models
 *
 * Fronts the caller's stored Cloudflare credential so LOCAL agents run on the
 * same Workers AI / AI Gateway billing as cloud agents — refresh stays
 * server-side and no Cloudflare token ever lands on the user's disk. Auth is
 * the standard CLI bearer (interactive `ptc_…` session tokens, or scoped
 * `pta_…` access tokens carrying `ai.proxy`); the gate lives in cli/routes.ts.
 *
 * The body's `model` field selects the upstream:
 *   @cf/...          → Workers AI                (cloudflare.oauth)
 *   {author}/{model} → the user's AI Gateway     (cloudflare.ai-gateway)
 *
 * Both upstreams share {account}/ai/v1/chat/completions; only the credential
 * view (and its cf-aig-gateway-id header) differs. Streaming (SSE) responses
 * pass through the shared fetch's cached-usage repair (stream-usage-repair.ts)
 * but are otherwise untouched; failures get the same actionable mapping as
 * the my-gateway provider.
 */
import type { UserDO } from './user-do';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY } from '../lib/cloudflare-oauth';
import { createCloudflareAIFetch, errorResponse, mapGatewayError } from '../providers/cloudflare-ai-fetch';
import { createUserDOAuthResolver } from '../providers/agent-registry';
import { MY_GATEWAY_PROVIDER_ID } from '../providers/my-gateway';
import { listAvailableModels } from './available-models';
import { json } from '../lib/http';
import { ownerCaller } from './workspace-capability';
import { USER_AI_PROXY_PATH } from '@kinu.run/core';
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
  let model: string;
  try {
    model = v.parse(ChatCompletionRouteSchema, JSON.parse(body)).model;
  } catch {
    return errorResponse(400, 'Body must be JSON with a non-empty model.');
  }
  const workersAI = model.startsWith('@cf/');
  if (!workersAI && !model.includes('/')) {
    return errorResponse(400, `Cannot route model "${model}" — use "@cf/{model}" (Workers AI) or "{provider}/{model}" (your AI Gateway).`);
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
