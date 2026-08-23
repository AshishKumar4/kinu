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
const DirectWorkersAIOutputSchema = v.looseObject({
  response: v.optional(v.string(), ''),
  tool_calls: v.optional(v.array(v.looseObject({
    id: v.optional(v.string()),
    name: v.string(),
    arguments: v.optional(v.union([v.string(), JsonObjectSchema]), ''),
  })), []),
  usage: v.optional(JsonObjectSchema),
});
interface DirectWorkersAIRunner {
  run(model: string, inputs: JsonObject, options?: { signal?: AbortSignal }): Promise<JsonObject>;
}

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
    return directWorkersAICompletion(request, env.AI, model, bodyValue);
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

async function directWorkersAICompletion(
  request: Request,
  binding: Ai,
  model: string,
  requestBody: JsonObject,
): Promise<Response> {
  const stream = requestBody.stream === true;
  const inputs: JsonObject = { ...requestBody, stream: false };
  delete inputs.model;
  // SAFETY: Cloudflare's `Ai` binding owns `run(model, JSON, options)`. This
  // view removes methods the proxy cannot call and gives its parsed result the
  // JSON domain that the binding promises for a non-streaming request.
  const runner = binding as DirectWorkersAIRunner;
  const raw = await runner.run(model, inputs, { signal: request.signal });
  if (Array.isArray(raw.choices)) return json(raw);

  const output = v.parse(DirectWorkersAIOutputSchema, raw);
  const toolCalls = output.tool_calls.map((call, index) => ({
    id: call.id ?? `call-${String(index + 1)}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: v.is(v.string(), call.arguments)
        ? call.arguments
        : JSON.stringify(call.arguments),
    },
  }));
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const id = `chatcmpl-${crypto.randomUUID()}`;
  if (!stream) {
    const message: JsonObject = {
      role: 'assistant',
      content: output.response,
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    const response: JsonObject = {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason,
      }],
    };
    if (output.usage) response.usage = output.usage;
    return json(response);
  }

  const delta: JsonObject = {
    role: 'assistant',
    content: output.response,
  };
  if (toolCalls.length > 0) {
    delta.tool_calls = toolCalls.map((call, index) => ({ ...call, index }));
  }
  const start: JsonObject = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: null,
    }],
  };
  const finish: JsonObject = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (output.usage) finish.usage = output.usage;
  return new Response(
    `data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Forward the client's Workers AI prefix-cache pin so same-agent local turns
 *  land on the same replica — the parity of agentAffinityKey for DO agents. */
function affinityHeader(request: Request): Record<string, string> | undefined {
  const affinity = request.headers.get('x-session-affinity');
  return affinity ? { 'x-session-affinity': affinity } : undefined;
}
