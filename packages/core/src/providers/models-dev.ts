import type { ModelCapability, ModelInfo, ProviderDeps } from './types.js';
import { cloneModelInfos, isRecord, nonEmptyString, positiveInteger } from './util.js';

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
}

interface ModelsDevCache {
  at: number;
  fetchFn: typeof fetch;
  data: Record<string, ModelsDevProvider>;
}

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

/** Provider-level metadata for one models.dev provider, or null when the id
 *  is unknown or the catalog is unreachable. */
export async function getModelsDevProvider(
  providerId: string,
  deps: Pick<ProviderDeps, 'fetch'>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<ModelsDevProviderInfo | null> {
  try {
    const data = await getModelsDevCatalog(deps.fetch, ttlMs);
    const provider = data[providerId];
    return provider ? providerInfoFromModelsDev(providerId, provider) : null;
  } catch {
    return null;
  }
}

/** Provider-level metadata for every models.dev provider (empty on fetch failure). */
export async function listModelsDevProviders(
  deps: Pick<ProviderDeps, 'fetch'>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<ModelsDevProviderInfo[]> {
  try {
    const data = await getModelsDevCatalog(deps.fetch, ttlMs);
    return Object.entries(data).map(([id, provider]) => providerInfoFromModelsDev(id, provider));
  } catch {
    return [];
  }
}

/**
 * models.dev omits `api` for providers whose npm SDK embeds the endpoint
 * (`@ai-sdk/groq`, `@ai-sdk/mistral`, …) — SDKs a Worker cannot load. These
 * providers all publish a stable, documented OpenAI-compatible endpoint, so
 * the major ones are pinned here. Only consulted when the catalog itself
 * offers no usable `api`; keys must exist in models.dev to take effect.
 */
const COMPAT_ENDPOINT_SUPPLEMENT: Record<string, string> = {
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
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('models.dev response was not an object');
  const data = body as Record<string, ModelsDevProvider>;
  cache = { at: Date.now(), fetchFn: fetchImpl, data };
  return data;
}

function providerInfoFromModelsDev(id: string, provider: ModelsDevProvider): ModelsDevProviderInfo {
  return {
    id,
    name: nonEmptyString(provider.name) ?? id,
    doc: nonEmptyString(provider.doc),
    env: Array.isArray(provider.env) ? provider.env.filter((v): v is string => typeof v === 'string' && v.length > 0) : [],
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

  return {
    id,
    label: nonEmptyString(model.name) ?? id,
    capabilities,
    contextWindow: positiveInteger(model.limit?.context),
  };
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
