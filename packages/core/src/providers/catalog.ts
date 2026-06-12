// Dynamic models.dev catalog source — serves every models.dev provider whose
// auth shape Proteus can satisfy with a stored API key: an OpenAI-surface
// endpoint (`api` base URL, openai-compat/openai SDK) driven through the
// openai-compat wire path. Bespoke providers (anthropic, openai, openrouter,
// codex, workers-ai, …) are statically registered and always take precedence —
// the registry never consults this source for their ids.
//
// Credential convention: `<modelsDevProviderId>.bearer` (matches the bespoke
// trio's existing keys: openai.bearer / anthropic.bearer / openrouter.bearer).
//
// createModel stays sync: the endpoint base URL is resolved from the (cached)
// models.dev catalog inside customFetch, alongside the credential headers.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { DynamicProviderSource } from './registry.js';
import type { ModelProvider, ProviderDeps } from './types.js';
import { createAuthedFetch } from './util.js';
import {
  getModelsDevProvider,
  listModelsDevProviderModels,
  modelsDevCompatBaseURL,
} from './models-dev.js';

/** Catalog provider ids must look like models.dev ids — this also rejects
 *  malformed specs early in canResolve()/resolve(). */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function catalogCredKey(providerId: string): string {
  return `${providerId}.bearer`;
}

const CRED_KEY_PATTERN = /^([a-z0-9][a-z0-9._-]*)\.bearer$/;

export interface ModelsDevCatalogSourceOptions {
  /** Provider ids never served dynamically even though the catalog lists
   *  them (e.g. models.dev aliases of bespoke providers registered under a
   *  different id, like `cloudflare-workers-ai` → static `workers-ai`). */
  exclude?: readonly string[];
}

export function createModelsDevCatalogSource(opts: ModelsDevCatalogSourceOptions = {}): DynamicProviderSource {
  const excluded = new Set(opts.exclude ?? []);
  const providers = new Map<string, ModelProvider>();

  return {
    get(providerId) {
      if (excluded.has(providerId) || !PROVIDER_ID_PATTERN.test(providerId)) return undefined;
      let provider = providers.get(providerId);
      if (!provider) {
        provider = createCatalogProvider(providerId);
        providers.set(providerId, provider);
      }
      return provider;
    },

    async listIds(deps) {
      const keys = await deps.listCredentialKeys?.() ?? [];
      const ids: string[] = [];
      for (const key of keys) {
        const id = CRED_KEY_PATTERN.exec(key)?.[1];
        if (!id || excluded.has(id) || ids.includes(id)) continue;
        const info = await getModelsDevProvider(id, deps);
        if (info && modelsDevCompatBaseURL(info)) ids.push(id);
      }
      return ids.sort();
    },
  };
}

function createCatalogProvider(providerId: string): ModelProvider {
  const credKey = catalogCredKey(providerId);

  async function compatBaseURL(deps: Pick<ProviderDeps, 'fetch'>): Promise<string | null> {
    const info = await getModelsDevProvider(providerId, deps);
    return info ? modelsDevCompatBaseURL(info) : null;
  }

  return {
    id: providerId,
    label: providerId,
    async isAvailable(deps) { return deps.hasCredential(credKey); },
    unavailableReason() { return `No API key for ${providerId} (cred key: \`${credKey}\`).`; },

    async listModels(deps) {
      if (!(await compatBaseURL(deps))) return [];
      return listModelsDevProviderModels(providerId, deps);
    },

    createModel(modelId, deps): LanguageModel {
      // Same placeholder trick as openai-compat: the SDK needs a baseURL at
      // construction, but ours lives in the models.dev catalog. customFetch
      // resolves it per request (cached) and rewrites the prefix.
      const placeholder = `https://models-dev-${providerId}.invalid`;
      const customFetch = createAuthedFetch(deps, {
        credKey,
        missingCredentialError: `No API key for ${providerId} (cred key: ${credKey})`,
        resolveBaseURL: () => compatBaseURL(deps),
        missingBaseURLError: `Provider ${providerId} is not in the models.dev catalog (or has no API endpoint Proteus can drive with an API key).`,
        mutate: ({ url, auth }) => auth.baseURL && url.startsWith(placeholder)
          ? auth.baseURL.replace(/\/+$/, '') + url.slice(placeholder.length)
          : url,
      });
      return createOpenAICompatible({
        name: providerId,
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
