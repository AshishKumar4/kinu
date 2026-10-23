/** OpenAI-compatible proxy for CLI clients: `@cf/...` via Workers AI (direct under `WORKERS_AI_VIA_BINDING`), `{author}/{model}` via the user's gateway. */
import { Hono } from 'hono';
import { decisionRunOf, userCredentials, type UserCredentialClient } from '../providers/agent-registry';
import type { OwnerCapabilityEnv, ProviderEnv, WorkersAIRunBinding } from '@kinu.run/core';
import { objectNamed, CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY } from '@kinu.run/core';
import { createCloudflareAIFetch, errorResponse, mapGatewayError } from '@kinu.run/core';
import { MY_GATEWAY_PROVIDER_ID, SESSION_AFFINITY_HEADER, sessionAffinityOf, workersAiSpec, DECISION_MODELS, USER_AI_RUN_PATH, decodeJsonValue } from '@kinu.run/core';
import { listAvailableModels, type AvailableModelsEnv } from './available-models';
import { json } from '@kinu.run/core';
import { ownerCaller } from '@kinu.run/core';
import { JsonObjectSchema, USER_AI_PROXY_PATH, parseJsonObject } from '@kinu.run/core';
import { Effect } from 'effect';
import { attemptInItsWords, diagnostics, settle, settleLogged, tolerate, tolerated } from '@kinu.run/core/obs';
import { ERROR_STATUS } from '@kinu.run/core';
import type { UserDO } from './user-do';
import { beneath, type FamilyEnv } from '../api/context';
import { inferenceProxyGate, type CliBearerEnv, type CliBearerVariables } from '../api/cli-bearer';
import type { CliAuthAuthority } from '../cli/auth-store';
import * as v from 'valibot';
import { bindingCompletion } from './binding-completions';

const PROXY_PLACEHOLDER = 'https://kinu-user-ai-proxy.invalid';

const ChatCompletionRouteSchema = v.object({
  model: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

/** The deployment's direct transport calls `run` on the same binding the gateway path uses. */
export interface UserAIProxyEnv<Id> extends AvailableModelsEnv<Id>, OwnerCapabilityEnv {
  AI?: NonNullable<ProviderEnv['AI']> & WorkersAIRunBinding;
}

/** The account's limits as the platform's own models meet them here (core limits/). */
type LimitsHub = Pick<UserDO, 'limits_admitTurn' | 'limits_platformTokensSpent'>;

type ProxyAuthority = CliAuthAuthority & UserCredentialClient & LimitsHub;

/** Whose call it is: the account, its limits, and where what the platform's model spent is told. */
interface ProxyAccount {
  readonly userId: string;
  readonly limits: LimitsHub;
  readonly spent: (tokens: number) => void;
}

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
  const userId = c.get('cli').userId;
  const run = decisionRunOf({ env: c.env, userDO: userCredentials(() => objectNamed(c.env.UserDO, userId), await ownerCaller(c.env)) });

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

/** The APIs a gateway model is spoken to in (`gatewayWireModel`), each forwarded where `createCloudflareAIFetch` sends it. */
for (const endpoint of ['chat/completions', 'responses', 'messages'] as const) {
  aiProxyRoutes.post(`${USER_AI_PROXY_PATH}/${endpoint}`, (c) => {
    const { userId } = c.get('cli');
    const limits = objectNamed(c.env.UserDO, userId);

    // Counted after the answer, outliving the request: a count that fails is logged, never the caller's.
    const spent = (tokens: number) => c.executionCtx.waitUntil(settleLogged('limits.cli_tokens_undebited', { doing: "counting a CLI call on the platform's models to the owner's day", otherwise: 'unavailable' },
      async () => { await limits.limits_platformTokensSpent(await ownerCaller(c.env), tokens); }));

    return settle(proxyCompletion(endpoint, c.req.raw, c.env, { userId, limits, spent }));
  });
}

aiProxyRoutes.all(`${USER_AI_PROXY_PATH}/*`, beneath(USER_AI_PROXY_PATH, async (c) =>
  errorResponse(404, `No such AI proxy route: ${c.req.method} ${c.req.path.slice(USER_AI_PROXY_PATH.length)}`)));

/**
 * A call on one of the platform's own models, as the owner's limits admit it: their refusal (a suspended account, the
 * day's tokens spent) in their words and status; null to go on, as also when the account could not be asked (logged).
 */
function platformRefusal(limits: LimitsHub, env: OwnerCapabilityEnv): Effect.Effect<Response | null> {
  const asked = attemptInItsWords('unavailable', async () => { await limits.limits_admitTurn(await ownerCaller(env), true); });

  return Effect.match(asked, {
    onSuccess: () => null,
    onFailure: (failure) => {
      if (failure.code === 'budget' || failure.code === 'denied') return errorResponse(ERROR_STATUS[failure.code], failure.message);
      diagnostics.failure('limits.cli_turn_unasked', failure);

      return null;
    },
  });
}

function proxyCompletion<Id>(
  endpoint: 'chat/completions' | 'responses' | 'messages', request: Request, env: UserAIProxyEnv<Id>, account: ProxyAccount,
): Effect.Effect<Response> {
  const { userId } = account;

  return Effect.gen(function* () {
    const body = yield* Effect.promise(() => request.text());

    const parsed = yield* tolerated(Effect.sync(() => v.parse(JsonObjectSchema, JSON.parse(body))), 'malformed-input');
    const routed = v.safeParse(ChatCompletionRouteSchema, parsed);

    if (parsed === undefined || !routed.success) return errorResponse(400, 'Body must be JSON with a non-empty model.');
    const model = routed.output.model;

    const workersAI = model.startsWith('@cf/');

    // OpenAI's and Anthropic's own APIs carry the author's own id (`gpt-6.1-sol`); a unified chat call names its author.
    if (endpoint === 'chat/completions' && !workersAI && !model.includes('/')) {
      return errorResponse(400, `Cannot route model "${model}": use "@cf/{model}" (Workers AI) or "{provider}/{model}" (your AI Gateway).`);
    }

    // The binding transport reads chat bodies; anything else is the account endpoint's to answer.
    if (workersAI && endpoint === 'chat/completions' && env.WORKERS_AI_VIA_BINDING === 'on') {
      if (!env.AI) return errorResponse(503, 'Workers AI binding unavailable.');
      const refused = yield* platformRefusal(account.limits, env);

      if (refused !== null) return refused;

      return yield* bindingCompletion(env.AI, { model, body: parsed, request, spent: account.spent });
    }

    const aiFetch = createCloudflareAIFetch({
      credKey: workersAI ? CLOUDFLARE_OAUTH_CRED_KEY : CLOUDFLARE_AI_GATEWAY_CRED_KEY,
      provider: workersAI ? 'workers-ai' : 'my-gateway',
      getAuth: userCredentials(() => objectNamed(env.UserDO, userId), yield* Effect.promise(() => ownerCaller(env))).getAuth,
      placeholder: PROXY_PLACEHOLDER,
      missingCredentialMessage: workersAI
        ? 'Connect Cloudflare in your Kinu user settings before using Workers AI models.'
        : 'Connect Cloudflare and select an AI Gateway in your Kinu user settings before using my-gateway models.',
      requestHeaders: affinityHeader(request),
      mapError: (res, resolved) => mapGatewayError(res, model, resolved.headers['cf-aig-gateway-id']),
    });

    return yield* Effect.promise(() => aiFetch(`${PROXY_PLACEHOLDER}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: request.signal,
    }));
  });
}


/** Forwards the Workers AI prefix-cache pin so same-agent local turns hit the same replica. */
function affinityHeader(request: Request): Record<string, string> | undefined {
  const affinity = sessionAffinityOf(request.headers);

  return affinity ? { [SESSION_AFFINITY_HEADER]: affinity } : undefined;
}
