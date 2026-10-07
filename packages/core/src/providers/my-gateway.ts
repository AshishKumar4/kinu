// The user's own Cloudflare AI Gateway via their Workers AI OAuth credential (`ai-gateway` is the platform's).
// Wire: POST {account}/ai/v1/{chat/completions|responses} with `cf-aig-gateway-id`; specs are `my-gateway/{author}/{model}`.
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { type ModelProvider, type ModelInfo, type ProviderDeps } from './types';
import { authCacheKey, cloneModelInfos, settleModelList, StaleModelList } from './util';
import { listModelsDevProviderModels } from './models-dev';
import { createWireModel, gatewayWire, OPENAI_AUTHOR } from './wire-model';
import { asFetchFunction } from './fetch-shim';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, cloudflareAccountAPIRoot } from './cloudflare-oauth';
import { createCloudflareAIFetch, mapGatewayError } from './cloudflare-ai-fetch';
import { usageRepairMiddleware } from './middleware/usage-repair';
import { Effect } from 'effect';
import { settle, toKinuError } from "../obs/index";
import * as v from 'valibot';

export const MY_GATEWAY_PROVIDER_ID = 'my-gateway';

/** models.dev's gateway rows, in the ids its REST API takes (`anthropic/claude-opus-4.5`). */
const GATEWAY_CATALOG_ID = 'cloudflare-ai-gateway';

/** Own ids that are REST ids too (`openai/gpt-6.1-sol`, `google/gemini-2.5-pro`: 200, 2026-10-06); not Anthropic's or xAI's. */
const NATIVE_ID_PROVIDERS = ['openai', 'google'] as const;

/** A stored key's provider slug where it differs from the author its REST ids name. */
const AUTHOR_OF_SLUG: ReadonlyMap<string, string> = new Map([['google-ai-studio', 'google'], ['grok', 'xai']]);

/** The REST API consults only the key stored under this alias; any other falls through to credits. */
const REST_KEY_ALIAS = 'default';

const ProviderConfigsSchema = v.object({
  result: v.optional(v.array(v.object({ provider_slug: v.optional(v.string()), alias: v.optional(v.string()) }))),
});

const GatewaySettingsSchema = v.object({ result: v.optional(v.object({ byok_only: v.optional(v.boolean()) })) });

const CreditBalanceSchema = v.object({
  result: v.optional(v.object({ balance: v.optional(v.number()) })),
});

const CATALOG_TTL_MS = 60_000;

const catalogCache = new Map<string, { at: number; models: ModelInfo[] }>();

export function createMyGatewayProvider(): ModelProvider {
  return {
    id: MY_GATEWAY_PROVIDER_ID,
    label: 'Your AI Gateway',
    async isAvailable(deps) {
      const auth = await deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY);

      return Boolean(auth?.baseURL);
    },
    unavailableReason: () =>
      'Connect Cloudflare and select an AI Gateway in User settings to use your own gateway (BYOK provider keys or Unified Billing credits).',

    async listModels(deps): Promise<ModelInfo[]> {
      return settle(Effect.gen(function* () {
        const auth = yield* Effect.promise(() => deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY));

        const baseURL = auth?.baseURL;

        if (auth === null || !baseURL) return [];
        const cacheKey = authCacheKey(auth);
        const cached = catalogCache.get(cacheKey);

        if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cloneModelInfos(cached.models);

        const discovered = yield* Effect.promise(() => servableAuthors(baseURL, auth.headers, deps));

        if (!discovered.authoritative) {
          // A 429/5xx said nothing about which providers are served: keep the last catalog, else fail loudly.
          if (cached) return cloneModelInfos(cached.models);

          return yield* Effect.fail(toKinuError({
            doing: `reading your AI Gateway's servable providers (${discovered.reason})`,
            cause: new Error(discovered.reason),
            otherwise: 'unavailable',
          }));
        }

        const { billed, keyed } = discovered;
        const models = new Map<string, ModelInfo>();
        const stale: StaleModelList[] = [];

        for (const source of [GATEWAY_CATALOG_ID, ...NATIVE_ID_PROVIDERS]) {
          const listed = yield* Effect.promise(() => settleModelList(listModelsDevProviderModels(source, deps, { textOnly: true })));

          if (listed.stale !== null) stale.push(listed.stale);

          for (const model of listed.models) {
            const id = source === GATEWAY_CATALOG_ID ? model.id : `${source}/${model.id}`;

            if (!models.has(id) && (billed || keyed.has(id.slice(0, id.indexOf('/'))))) models.set(id, { ...model, id });
          }
        }

        const [first] = stale;

        if (first !== undefined) return yield* Effect.fail(new StaleModelList([...models.values()], { reason: first.reason, cause: first.cause }));
        catalogCache.set(cacheKey, { at: Date.now(), models: [...models.values()] });

        return cloneModelInfos([...models.values()]);
      }));
    },

    createModel(modelId, deps): LanguageModel {
      const placeholder = 'https://kinu-my-gateway.invalid';

      const customFetch = createCloudflareAIFetch({
        credKey: CLOUDFLARE_AI_GATEWAY_CRED_KEY,
        getAuth: deps.getAuth,
        fetch: deps.fetch,
        provider: MY_GATEWAY_PROVIDER_ID,
        placeholder,
        missingCredentialMessage: 'Connect Cloudflare and select an AI Gateway in User settings before using my-gateway models.',
        mapError: (res, resolved) => mapGatewayError(res, modelId, resolved.headers['cf-aig-gateway-id']),
      });

      return wrapLanguageModel({
        model: gatewayWireModel(MY_GATEWAY_PROVIDER_ID, modelId, { baseURL: placeholder, fetch: customFetch }),
        middleware: usageRepairMiddleware(),
      });
    },
  };
}

export interface GatewayTransport {
  readonly baseURL: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export function gatewayWireModel(name: string, modelId: string, transport: GatewayTransport): LanguageModelV4 {
  const wire = gatewayWire(modelId);
  const send = transport.fetch ?? fetch;
  const model = { name, ...transport, modelId: wire.modelId, protocol: wire.protocol, reasoning: false };

  // Each SDK names the model its own way; the gateway takes the authored id.
  if (wire.protocol === 'messages') return createWireModel({ ...model, fetch: claudeForGateway(send, modelId) });

  return createWireModel(wire.protocol === 'responses' ? { ...model, fetch: authored(send) } : model);
}

const MessagesBodySchema = v.looseObject({ system: v.optional(v.array(v.looseObject({ text: v.string() }))) });

/** The gateway's id, and `system` as the one string its `/messages` takes (2026-10-06). */
function claudeForGateway(send: typeof fetch, gatewayId: string): typeof fetch {
  return asFetchFunction(async (input, init) => {
    const text = v.safeParse(v.string(), init?.body);
    const body = text.success ? v.safeParse(MessagesBodySchema, JSON.parse(text.output)) : null;

    if (body?.success !== true) return await send(input, init);
    const { system, ...rest } = body.output;

    return await send(input, { ...init, body: JSON.stringify({
      ...rest, model: gatewayId, ...(system !== undefined && { system: system.map((block) => block.text).join('\n\n') }),
    }) });
  });
}

function authored(send: typeof fetch): typeof fetch {
  return asFetchFunction(async (input, init) => {
    const text = v.safeParse(v.string(), init?.body);
    const body = text.success ? v.safeParse(v.looseObject({ model: v.string() }), JSON.parse(text.output)) : null;

    return await send(input, body?.success === true ? { ...init, body: JSON.stringify({ ...body.output, model: `${OPENAI_AUTHOR}${body.output.model}` }) } : init);
  });
}

/** Only an `authoritative` empty menu may be published and cached. */
type GatewayDiscovery =
  | { authoritative: true; billed: boolean; keyed: ReadonlySet<string> }
  | { authoritative: false; reason: string };

type ManagementRead =
  | { kind: 'observed'; body: unknown }
  | { kind: 'denied' }
  | { kind: 'transient'; reason: string };

/** Read one management endpoint: 401/403 narrows the menu; 429 and 5xx are non-answers, not "no providers". */
async function readGatewayManagement(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<ManagementRead> {
  const response = await fetchImpl(url, { headers });

  if (response.ok) return { kind: 'observed', body: await response.json() };

  if (response.status === 401 || response.status === 403) return { kind: 'denied' };

  return { kind: 'transient', reason: `AI Gateway management answered HTTP ${String(response.status)}` };
}

/**
 * Who pays for an author's REST requests: its key stored under `default`, else credits, unless the gateway requires
 * stored keys (developers.cloudflare.com/ai-gateway/features/unified-billing, credential precedence).
 */
async function servableAuthors(
  baseURL: string,
  authHeaders: Record<string, string>,
  deps: ProviderDeps,
): Promise<GatewayDiscovery> {
  const account = cloudflareAccountAPIRoot(baseURL);
  const gatewayId = authHeaders['cf-aig-gateway-id'];

  if (!account || !gatewayId) return { authoritative: true, billed: false, keyed: new Set() };
  const fetchImpl = deps.fetch ?? fetch;
  const headers = { ...authHeaders, accept: 'application/json' };
  const keyed = new Set<string>();

  const gateway = `${account}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}`;

  // Independent reads, so together: each is a Cloudflare API round trip.
  const [configs, credit, settings] = await Promise.all([
    readGatewayManagement(fetchImpl, `${gateway}/provider_configs?per_page=100`, headers),
    readGatewayManagement(fetchImpl, `${account}/ai-gateway/billing/credit-balance`, headers),
    readGatewayManagement(fetchImpl, gateway, headers),
  ]);

  const transient = [configs, credit, settings].find((read) => read.kind === 'transient');

  if (transient?.kind === 'transient') return { authoritative: false, reason: transient.reason };

  if (configs.kind === 'observed') {
    for (const row of v.parse(ProviderConfigsSchema, configs.body).result ?? []) {
      if (row.provider_slug !== undefined && row.alias === REST_KEY_ALIAS) keyed.add(AUTHOR_OF_SLUG.get(row.provider_slug) ?? row.provider_slug);
    }
  }

  const balance = credit.kind === 'observed' ? v.parse(CreditBalanceSchema, credit.body).result?.balance : undefined;
  // A settings read refused says nothing of the policy; credits then count as they did before it was read.
  const keysOnly = settings.kind === 'observed' && v.parse(GatewaySettingsSchema, settings.body).result?.byok_only === true;

  return { authoritative: true, billed: !keysOnly && balance !== undefined && balance > 0, keyed };
}
