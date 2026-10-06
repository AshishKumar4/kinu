// The user's own Cloudflare AI Gateway via their Workers AI OAuth credential (`ai-gateway` is the platform's).
// Wire: POST {account}/ai/v1/{chat/completions|responses} with `cf-aig-gateway-id`; specs are `my-gateway/{author}/{model}`.
import type { LanguageModel } from 'ai';
import { type ModelProvider, type ModelInfo, type ProviderDeps } from './types';
import { authCacheKey, cloneModelInfos, settleModelList, StaleModelList } from './util';
import { getModelsDevWire, listModelsDevProviderModels } from './models-dev';
import { createWireModel, deferredModel } from './wire-model';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, cloudflareAccountAPIRoot } from './cloudflare-oauth';
import { createCloudflareAIFetch, mapGatewayError } from './cloudflare-ai-fetch';
import { Effect } from 'effect';
import { settle, toKinuError } from "../obs/index";
import * as v from 'valibot';

export const MY_GATEWAY_PROVIDER_ID = 'my-gateway';

/** models.dev's rows for the gateway: the `{author}/{model}` ids its REST API takes (`anthropic/claude-opus-4.5`). */
const GATEWAY_CATALOG_ID = 'cloudflare-ai-gateway';

const ProviderConfigsSchema = v.object({
  result: v.optional(v.array(v.object({ provider_slug: v.optional(v.string()) }))),
});

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

        const listed = yield* Effect.promise(() => settleModelList(listModelsDevProviderModels(GATEWAY_CATALOG_ID, deps)));
        const { billed, keyed } = discovered;
        const models = listed.models.filter((model) => billed || keyed.has(model.id.slice(0, model.id.indexOf('/'))));

        if (listed.stale !== null) return yield* Effect.fail(new StaleModelList(models, { reason: listed.stale.reason, cause: listed.stale.cause }));
        catalogCache.set(cacheKey, { at: Date.now(), models });

        return cloneModelInfos(models);
      }));
    },

    createModel(modelId, deps): LanguageModel {
      const placeholder = 'https://kinu-my-gateway.invalid';

      const customFetch = createCloudflareAIFetch({
        credKey: CLOUDFLARE_AI_GATEWAY_CRED_KEY,
        getAuth: deps.getAuth,
        fetch: deps.fetch,
        provider: MY_GATEWAY_PROVIDER_ID,
        modelId,
        onProviderWait: deps.onProviderWait,
        placeholder,
        missingCredentialMessage: 'Connect Cloudflare and select an AI Gateway in User settings before using my-gateway models.',
        mapError: (res, resolved) => mapGatewayError(res, modelId, resolved.headers['cf-aig-gateway-id']),
      });

      return gatewayWireModel(MY_GATEWAY_PROVIDER_ID, modelId, { baseURL: placeholder, fetch: customFetch }, deps);
    },
  };
}

/** The account endpoint on the worker, the signed-in proxy on the CLI. */
export interface GatewayTransport {
  readonly baseURL: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

/** A gateway `{author}/{model}` speaks its author's own API where models.dev names one, else the unified chat API. */
export function gatewayWireModel(name: string, modelId: string, transport: GatewayTransport, deps: Pick<ProviderDeps, 'fetch'>): LanguageModel {
  const slash = modelId.indexOf('/');

  return deferredModel(name, modelId, async () => {
    const wire = slash < 0 ? null : await getModelsDevWire(modelId.slice(0, slash), modelId.slice(slash + 1), deps);

    return createWireModel({ name, modelId, ...transport, protocol: wire?.protocol ?? 'chat-completions', reasoning: wire?.reasoning ?? false });
  });
}

/** What one discovery pass learned; only an `authoritative` empty menu may be published and cached. */
type GatewayDiscovery =
  | { authoritative: true; billed: boolean; keyed: ReadonlySet<string> }
  | { authoritative: false; reason: string };

/** One management observation: what it contributed, or why it said nothing. */
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

/** Credits pay for every catalog row, a stored key (BYOK) for its author's. An unanswered read keeps the last menu. */
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

  // Independent reads, so together: each is a Cloudflare API round trip.
  const [configs, credit] = await Promise.all([
    readGatewayManagement(fetchImpl, `${account}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs?per_page=100`, headers),
    readGatewayManagement(fetchImpl, `${account}/ai-gateway/billing/credit-balance`, headers),
  ]);

  if (configs.kind === 'transient') return { authoritative: false, reason: configs.reason };

  if (configs.kind === 'observed') {
    const body = v.parse(ProviderConfigsSchema, configs.body);

    for (const row of body.result ?? []) {
      if (row.provider_slug !== undefined) keyed.add(row.provider_slug);
    }
  }

  if (credit.kind === 'transient') return { authoritative: false, reason: credit.reason };

  const balance = credit.kind === 'observed' ? v.parse(CreditBalanceSchema, credit.body).result?.balance : undefined;

  return { authoritative: true, billed: balance !== undefined && balance > 0, keyed };
}
