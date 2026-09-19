// Dynamic models.dev catalog source — serves every models.dev provider whose
// auth shape Kinu can satisfy with a stored API key: Chat Completions or
// Responses, selected by the model's declared SDK. Bespoke providers (anthropic, openai, openrouter,
// codex, workers-ai, …) are statically registered and always take precedence —
// the registry never consults this source for their ids.
//
// Credential convention: `<modelsDevProviderId>.bearer` (matches the bespoke
// trio's existing keys: openai.bearer / anthropic.bearer / openrouter.bearer).
//
// createModel stays synchronous. SDK operations resolve the cached catalog;
// each HTTP request reads fresh credentials.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import type { DynamicProviderSource } from './registry';
import type { ModelProvider, ProviderDeps } from './types';
import { createAuthedFetch } from './util';
import { KINU_USER_AGENT } from '../utils/user-agent';
import {
  getModelsDevProvider,
  getModelsDevModelEndpoint,
  listModelsDevProviderModels,
  modelsDevCompatBaseURL,
} from './models-dev';

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
      // Keep registry resolution synchronous; select the SDK before it encodes
      // the request, using the same cached catalog as the model menu.
      async function resolveModel(): Promise<LanguageModelV3> {
        const endpoint = await getModelsDevModelEndpoint(providerId, modelId, deps);

        if (endpoint === null) {
          throw new Error(`Model ${providerId}/${modelId} has no supported models.dev API endpoint.`);
        }

        const baseURL = endpoint.baseURL.replace(/\/+$/, '');

        const customFetch = createAuthedFetch(deps, {
          provider: providerId,
          modelId,
          credKey,
          missingCredentialError: `No API key for ${providerId} (cred key: ${credKey})`,
          mutate: ({ url, auth, headers }) => {
            // OpenCode Go's documented client contract requires these routing headers.
            if (providerId === 'opencode' || providerId === 'opencode-go') {
              headers.set('user-agent', KINU_USER_AGENT);

              if (deps.sessionAffinity) headers.set('x-opencode-session', deps.sessionAffinity);
            }

            return auth.baseURL && url.startsWith(baseURL)
              ? auth.baseURL.replace(/\/+$/, '') + url.slice(baseURL.length)
              : url;
          },
        });

        return endpoint.protocol === 'responses'
          ? createOpenAI({ baseURL, apiKey: 'placeholder', fetch: customFetch }).responses(modelId)
          : createOpenAICompatible({ name: providerId, baseURL, fetch: customFetch }).chatModel(modelId);
      }

      const model: LanguageModelV3 = {
        specificationVersion: 'v3', provider: providerId, modelId,
        get supportedUrls() { return resolveModel().then((resolved) => resolved.supportedUrls); },
        async doGenerate(options) { return (await resolveModel()).doGenerate(options); },
        async doStream(options) { return (await resolveModel()).doStream(options); },
      };

      return model;
    },
  };
}
