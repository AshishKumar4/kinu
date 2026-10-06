/** OpenAI-compatible proxy for CLI clients: `@cf/...` via Workers AI (direct under `WORKERS_AI_VIA_BINDING`), `{author}/{model}` via the user's gateway. */
import { Hono } from 'hono';
import { createUserDOAuthResolver, decisionRunOf, type UserCredentialClient } from '../providers/agent-registry';
import type { OwnerCapabilityEnv, ProviderEnv } from '@kinu.run/core';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY } from '@kinu.run/core';
import { createCloudflareAIFetch, errorResponse, mapGatewayError } from '@kinu.run/core';
import { MY_GATEWAY_PROVIDER_ID, SESSION_AFFINITY_HEADER, sessionAffinityOf, workersAiSpec, DECISION_MODELS, USER_AI_RUN_PATH, decodeJsonValue } from '@kinu.run/core';
import { createDirectWorkersAIFetch, transportControls } from '@kinu.run/core';
import { listAvailableModels, type AvailableModelsEnv } from './available-models';
import { json } from '@kinu.run/core';
import { ownerCaller } from '@kinu.run/core';
import { JsonObjectSchema, USER_AI_PROXY_PATH, parseJsonObject } from '@kinu.run/core';
import { Effect } from 'effect';
import { settle, tolerate, tolerated } from '@kinu.run/core/obs';
import { beneath, type FamilyEnv } from '../api/context';
import { inferenceProxyGate, type CliBearerEnv, type CliBearerVariables } from '../api/cli-bearer';
import type { CliAuthAuthority } from '../cli/auth-store';
import * as v from 'valibot';

const PROXY_PLACEHOLDER = 'https://kinu-user-ai-proxy.invalid';

const ChatCompletionRouteSchema = v.object({
  model: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

/** The deployment's direct transport calls `run` on the same binding the gateway path uses. */
export interface UserAIProxyEnv<Id> extends AvailableModelsEnv<Id>, OwnerCapabilityEnv {
  AI?: NonNullable<ProviderEnv['AI']> & NonNullable<Parameters<typeof createDirectWorkersAIFetch>[0]>;
}

type ProxyAuthority = CliAuthAuthority & UserCredentialClient;

export const aiProxyRoutes = new Hono<FamilyEnv<UserAIProxyEnv<unknown> & CliBearerEnv<ProxyAuthority>, CliBearerVariables<ProxyAuthority>>>();

aiProxyRoutes.use(`${USER_AI_PROXY_PATH}/*`, beneath(USER_AI_PROXY_PATH, inferenceProxyGate()));

aiProxyRoutes.use(`${USER_AI_RUN_PATH}/*`, beneath(USER_AI_RUN_PATH, inferenceProxyGate()));

/** A decision model's rating for a CLI with no Cloudflare token of its own; only the decision models are run. */
aiProxyRoutes.post(`${USER_AI_RUN_PATH}/*`, async (c) => {
  const spec = workersAiSpec(c.req.path.slice(USER_AI_RUN_PATH.length + 1));

  if (!DECISION_MODELS.some((model) => model === spec)) {
    return errorResponse(404, `This proxy runs only the decision models (${DECISION_MODELS.join(', ')}), not ${spec}.`);
  }

  const text = await c.req.text();
  const body = tolerate(() => parseJsonObject(text), 'malformed-input') ?? null;

  if (body === null) return errorResponse(400, 'Body must be a JSON object.');
  const run = decisionRunOf({ env: c.env, userDO: { stub: c.get('cli').userDO, caller: await ownerCaller(c.env) } });

  return json({ body: decodeJsonValue({ value: await run(spec.slice('workers-ai/'.length), body) }) });
});

aiProxyRoutes.get(`${USER_AI_PROXY_PATH}/models`, async (c) => {
  const menu = await listAvailableModels(c.env, c.get('cli').userId, await ownerCaller(c.env));

  return json({
    body: {
      object: 'list',
      data: menu.models
        .filter((m) => m.provider === 'workers-ai' || m.provider === MY_GATEWAY_PROVIDER_ID)
        .map((m) => ({ id: m.spec.slice(m.provider.length + 1), object: 'model', owned_by: m.provider })),
    },
  });
});

aiProxyRoutes.post(`${USER_AI_PROXY_PATH}/chat/completions`, (c) => settle(proxyChatCompletion(c.req.raw, c.env, c.get('cli').userDO)));

aiProxyRoutes.all(`${USER_AI_PROXY_PATH}/*`, beneath(USER_AI_PROXY_PATH, async (c) =>
  errorResponse(404, `No such AI proxy route: ${c.req.method} ${c.req.path.slice(USER_AI_PROXY_PATH.length)}`)));

function proxyChatCompletion<Id>(
  request: Request, env: UserAIProxyEnv<Id>, userDO: UserCredentialClient,
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const body = yield* Effect.promise(() => request.text());

    const routed = yield* tolerated(Effect.sync(() => v.parse(ChatCompletionRouteSchema, v.parse(JsonObjectSchema, JSON.parse(body))).model), 'malformed-input');

    if (routed === undefined) return errorResponse(400, 'Body must be JSON with a non-empty model.');
    const model = routed;

    const workersAI = model.startsWith('@cf/');

    if (!workersAI && !model.includes('/')) {
      return errorResponse(400, `Cannot route model "${model}": use "@cf/{model}" (Workers AI) or "{provider}/{model}" (your AI Gateway).`);
    }

    if (workersAI && env.WORKERS_AI_VIA_BINDING === 'on') {
      if (!env.AI) return errorResponse(503, 'Workers AI binding unavailable.');

      const ai = env.AI;

      return yield* Effect.promise(() => createDirectWorkersAIFetch(ai)(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      }));
    }

    const aiFetch = createCloudflareAIFetch({
      credKey: workersAI ? CLOUDFLARE_OAUTH_CRED_KEY : CLOUDFLARE_AI_GATEWAY_CRED_KEY,
      provider: workersAI ? 'workers-ai' : 'my-gateway',
      modelId: model,
      getAuth: createUserDOAuthResolver({ stub: userDO, caller: yield* Effect.promise(() => ownerCaller(env)) }),
      placeholder: PROXY_PLACEHOLDER,
      missingCredentialMessage: workersAI
        ? 'Connect Cloudflare in your Kinu user settings before using Workers AI models.'
        : 'Connect Cloudflare and select an AI Gateway in your Kinu user settings before using my-gateway models.',
      requestHeaders: affinityHeader(request),
      mapError: (res, resolved) => mapGatewayError(res, model, resolved.headers['cf-aig-gateway-id']),
    });

    const controls = transportControls(request);

    return yield* Effect.promise(() => aiFetch(`${PROXY_PLACEHOLDER}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...controls.headers },
      body,
      signal: controls.signal,
    }));
  });
}


/** Forwards the Workers AI prefix-cache pin so same-agent local turns hit the same replica. */
function affinityHeader(request: Request): Record<string, string> | undefined {
  const affinity = sessionAffinityOf(request.headers);

  return affinity ? { [SESSION_AFFINITY_HEADER]: affinity } : undefined;
}
