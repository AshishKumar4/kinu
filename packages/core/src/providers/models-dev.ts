import type { ModelCapability, ModelInfo, ProviderDeps } from './types.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 5 * 60_000;

export type ModelsDevProviderId =
  | 'anthropic'
  | 'cloudflare-ai-gateway'
  | 'cloudflare-workers-ai'
  | 'openai';

interface ModelsDevProvider {
  id?: string;
  name?: string;
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
  providerId: ModelsDevProviderId,
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

function cloneModelInfos(models: readonly ModelInfo[] | undefined): ModelInfo[] {
  return (models ?? []).map((model) => ({
    ...model,
    capabilities: model.capabilities ? [...model.capabilities] : undefined,
  }));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
