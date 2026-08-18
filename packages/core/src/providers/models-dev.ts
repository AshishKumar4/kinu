import type {
  ModelCapability, ModelInfo, ModelInputModality, ModelPricing, ProviderDeps,
} from './types';
import * as v from 'valibot';
import { MODEL_INPUT_MODALITIES } from './types';
import { cloneModelInfos, nonEmptyString, positiveInteger } from './util';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 5 * 60_000;

/** Provider-level models.dev metadata (everything except the model map). */
export interface ModelsDevProviderInfo {
  id: string;
  name: string;
  /** Documentation URL. */
  doc?: string;
  /** Conventional API-key env var names (first is primary). */
  env: string[];
  /** AI-SDK package the provider officially ships with. */
  npm?: string;
  /** Base URL for providers reachable without a bespoke SDK. */
  api?: string;
}

interface ModelsDevProvider {
  id?: string;
  name?: string;
  doc?: string;
  env?: string[];
  npm?: string;
  api?: string;
  models?: Record<string, ModelsDevModel>;
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  status?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  /** USD per 1M tokens. */
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

interface ModelsDevCache {
  at: number;
  fetchFn: typeof fetch;
  data: Record<string, ModelsDevProvider>;
}

const ModelsDevModelSchema = v.object({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  tool_call: v.optional(v.boolean()),
  reasoning: v.optional(v.boolean()),
  status: v.optional(v.string()),
  limit: v.optional(v.object({
    context: v.optional(v.number()),
    output: v.optional(v.number()),
  })),
  modalities: v.optional(v.object({
    input: v.optional(v.array(v.string())),
    output: v.optional(v.array(v.string())),
  })),
  cost: v.optional(v.object({
    input: v.optional(v.number()),
    output: v.optional(v.number()),
    cache_read: v.optional(v.number()),
    cache_write: v.optional(v.number()),
  })),
});

const ModelsDevProviderSchema = v.object({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  doc: v.optional(v.string()),
  env: v.optional(v.array(v.string())),
  npm: v.optional(v.string()),
  api: v.optional(v.string()),
  models: v.optional(v.record(v.string(), ModelsDevModelSchema)),
});

const ModelsDevCatalogSchema = v.record(v.string(), ModelsDevProviderSchema);

let cache: ModelsDevCache | null = null;

export interface ModelsDevListOptions {
  fallback?: readonly ModelInfo[];
  preferredIds?: readonly string[];
  ttlMs?: number;
  toolCallOnly?: boolean;
}

export async function listModelsDevProviderModels(
  providerId: string,
  deps: Pick<ProviderDeps, 'fetch'>,
  opts: ModelsDevListOptions = {},
): Promise<ModelInfo[]> {
  try {
    const data = await getModelsDevCatalog(deps.fetch, opts.ttlMs ?? DEFAULT_TTL_MS);
    const provider = data[providerId];
    const models = provider?.models;
    if (!models) return cloneModelInfos(opts.fallback);

    const out: ModelInfo[] = [];
    for (const [key, model] of Object.entries(models)) {
      const info = modelInfoFromModelsDev(key, model, opts.toolCallOnly ?? true);
      if (info) out.push(info);
    }
    if (out.length === 0) return cloneModelInfos(opts.fallback);
    return orderModels(out, opts.preferredIds);
  } catch {
    return cloneModelInfos(opts.fallback);
  }
}

/** Provider-level metadata for one models.dev provider, or null when the id is
 *  not in the catalog. A catalog that cannot be READ throws: "this provider
 *  does not exist" and "models.dev is unreachable" are the same null otherwise,
 *  and the second one silently empties the caller's provider list. */
export async function getModelsDevProvider(
  providerId: string,
  deps: Pick<ProviderDeps, 'fetch'>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<ModelsDevProviderInfo | null> {
  const data = await getModelsDevCatalog(deps.fetch, ttlMs);
  const provider = data[providerId];
  return provider ? providerInfoFromModelsDev(providerId, provider) : null;
}

/** Provider-level metadata for every models.dev provider. Throws when the
 *  catalog cannot be read — an empty list is what "you have no providers to
 *  connect" looks like, which is not what a fetch failure means. */
export async function listModelsDevProviders(
  deps: Pick<ProviderDeps, 'fetch'>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<ModelsDevProviderInfo[]> {
  const data = await getModelsDevCatalog(deps.fetch, ttlMs);
  return Object.entries(data).map(([id, provider]) => providerInfoFromModelsDev(id, provider));
}

/**
 * models.dev omits `api` for providers whose npm SDK embeds the endpoint
 * (`@ai-sdk/groq`, `@ai-sdk/mistral`, …) — SDKs a Worker cannot load. These
 * providers all publish a stable, documented OpenAI-compatible endpoint, so
 * the major ones are pinned here. Only consulted when the catalog itself
 * offers no usable `api`; keys must exist in models.dev to take effect.
 */
interface CompatEndpointIndex {
  [provider: string]: string;
}

const COMPAT_ENDPOINT_SUPPLEMENT: CompatEndpointIndex = {
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  togetherai: 'https://api.together.xyz/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  cerebras: 'https://api.cerebras.ai/v1',
  perplexity: 'https://api.perplexity.ai',
  cohere: 'https://api.cohere.ai/compatibility/v1',
};

/**
 * The base URL Proteus can drive with a plain API key through the
 * openai-compat path, or null when the provider needs a bespoke SDK
 * (`npm` is not an OpenAI-surface package) or an endpoint Proteus cannot
 * construct (no `api`, or an `api` with `${…}` account placeholders).
 */
export function modelsDevCompatBaseURL(provider: ModelsDevProviderInfo): string | null {
  const catalogEligible = provider.api && !provider.api.includes('${')
    && (provider.npm === '@ai-sdk/openai-compatible' || provider.npm === '@ai-sdk/openai');
  if (catalogEligible) return provider.api ?? null;
  return COMPAT_ENDPOINT_SUPPLEMENT[provider.id] ?? null;
}

async function getModelsDevCatalog(fetchFn: typeof fetch | undefined, ttlMs: number): Promise<Record<string, ModelsDevProvider>> {
  const fetchImpl = fetchFn ?? fetch;
  if (cache && cache.fetchFn === fetchImpl && Date.now() - cache.at < ttlMs) return cache.data;
  const response = await fetchImpl(MODELS_DEV_URL, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const body = v.safeParse(ModelsDevCatalogSchema, await response.json());
  if (!body.success) throw new Error('models.dev response was not a valid catalog');
  const data: Record<string, ModelsDevProvider> = body.output;
  cache = { at: Date.now(), fetchFn: fetchImpl, data };
  return data;
}

function providerInfoFromModelsDev(id: string, provider: ModelsDevProvider): ModelsDevProviderInfo {
  return {
    id,
    name: nonEmptyString(provider.name) ?? id,
    doc: nonEmptyString(provider.doc),
    env: provider.env?.filter((name) => name.length > 0) ?? [],
    npm: nonEmptyString(provider.npm),
    api: nonEmptyString(provider.api),
  };
}

function modelInfoFromModelsDev(key: string, model: ModelsDevModel, toolCallOnly: boolean): ModelInfo | null {
  if (model.status === 'deprecated') return null;
  if (toolCallOnly && model.tool_call !== true) return null;

  const id = nonEmptyString(model.id) ?? key;
  const capabilities: ModelCapability[] = ['streaming'];
  if (model.tool_call === true) capabilities.push('tools');
  if (model.reasoning === true) capabilities.push('reasoning');
  if (model.modalities?.input?.includes('image')) capabilities.push('vision');
  const inputModalities: ModelInputModality[] = MODEL_INPUT_MODALITIES
    .filter((modality) => model.modalities?.input?.includes(modality) ?? false);

  const cost = pricingFromModelsDev(model.cost);
  return {
    id,
    label: nonEmptyString(model.name) ?? id,
    capabilities,
    contextWindow: positiveInteger(model.limit?.context),
    cost,
    inputModalities: inputModalities.length > 0 ? inputModalities : undefined,
  };
}

/** models.dev `cost`, kept only when BOTH sides of a token are priced —
 *  half a rate prices nothing, and a partial answer would read as authority. */
function pricingFromModelsDev(cost: ModelsDevModel['cost']): ModelPricing | undefined {
  const input = usdRate(cost?.input);
  const output = usdRate(cost?.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = usdRate(cost?.cache_read);
  const cacheWrite = usdRate(cost?.cache_write);
  return {
    input, output,
    cacheRead,
    cacheWrite,
  };
}

/** A USD-per-1M rate. Zero is a real price (free tiers); negative is not. */
function usdRate<Value>(value: Value): number | undefined {
  const rate = v.safeParse(v.pipe(v.number(), v.finite(), v.minValue(0)), value);
  return rate.success ? rate.output : undefined;
}

function orderModels(models: ModelInfo[], preferredIds: readonly string[] | undefined): ModelInfo[] {
  const rank = new Map((preferredIds ?? []).map((id, index) => [id, index]));
  return [...models].sort((a, b) => {
    const ar = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const br = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    return (a.label ?? a.id).localeCompare(b.label ?? b.id);
  });
}
