// Dynamic models.dev source for providers usable with a stored `<id>.bearer` key.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { DynamicProviderSource } from './registry';
import type { ModelProvider, ProviderDeps } from './types';
import { createAuthedFetch, statelessResponses } from './util';
import { KINU_USER_AGENT } from '../utils/user-agent';
import { baseCredentialKey } from '../credentials/accounts';
import {
  getModelsDevProvider,
  getModelsDevModelEndpoint,
  listModelsDevProviderModels,
  modelsDevCompatBaseURL,
} from './models-dev';

/** Must look like a models.dev id; rejects malformed specs early. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function catalogCredKey(providerId: string): string {
  return `${providerId}.bearer`;
}

const CRED_KEY_PATTERN = /^([a-z0-9][a-z0-9._-]*)\.bearer$/;

export function catalogProviderOfKey(key: string): string | null {
  return CRED_KEY_PATTERN.exec(baseCredentialKey(key))?.[1] ?? null;
}

export interface ModelsDevCatalogSourceOptions {
  /** Catalog ids never served dynamically (aliases of bespoke providers, e.g. `cloudflare-workers-ai`). */
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
        const id = catalogProviderOfKey(key);

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
    credentialKey: credKey,
    label: providerId,
    async isAvailable(deps) { return deps.hasCredential(credKey); },
    unavailableReason() { return `No API key for ${providerId} (cred key: \`${credKey}\`).`; },

    async listModels(deps) {
      if (!(await compatBaseURL(deps))) return [];

      return listModelsDevProviderModels(providerId, deps);
    },

    createModel(modelId, deps): LanguageModel {
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
          ? wrapLanguageModel({
            model: createOpenAI({ baseURL, apiKey: 'placeholder', fetch: customFetch }).responses(modelId),
            middleware: statelessResponses(endpoint.reasoning),
          })
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
