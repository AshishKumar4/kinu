// Dynamic models.dev source for providers usable with a stored `<id>.bearer` key, and the one model a keyed endpoint
// is spoken to through.
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import type { DynamicProviderSource } from './registry';
import type { ModelCallDeps, ModelProvider, ProviderDeps } from './types';
import { createAuthedFetch } from './util';
import { createWireModel, deferredModel, type WireProtocol } from './wire-model';
import { KINU_USER_AGENT } from '../utils/user-agent';
import { baseCredentialKey } from '../credentials/accounts';
import {
  getModelsDevProvider,
  getModelsDevModelEndpoint,
  listModelsDevProviderModels,
  modelsDevCompatBaseURL,
} from './models-dev';

export interface KeyedEndpoint {
  readonly providerId: string;
  readonly credKey: string;
  readonly modelId: string;
  readonly deps: ModelCallDeps;
  /** Where the model is spoken to; a credential's own base URL replaces this one per request. */
  readonly endpoint: { readonly baseURL: string; readonly protocol: WireProtocol; readonly reasoning: boolean };
  readonly missingCredentialError: string;
  /** A credential without a base URL is refused (a bring-your-own endpoint has no other). */
  readonly requireBaseURL?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A keyed endpoint's model: the catalog's providers and a bring-your-own OpenAI-compatible endpoint alike. */
export function keyedEndpointModel(spec: KeyedEndpoint): LanguageModelV4 {
  const baseURL = spec.endpoint.baseURL.replace(/\/+$/, '');

  const customFetch = createAuthedFetch(spec.deps, {
    provider: spec.providerId,
    credKey: spec.credKey,
    missingCredentialError: spec.missingCredentialError,
    ...(spec.requireBaseURL === true && { requireBaseURL: true }),
    mutate: ({ url, auth, headers }) => {
      for (const [name, value] of Object.entries(spec.headers ?? {})) headers.set(name, value);

      return auth.baseURL && url.startsWith(baseURL) ? auth.baseURL.replace(/\/+$/, '') + url.slice(baseURL.length) : url;
    },
  });

  return createWireModel({
    name: spec.providerId, modelId: spec.modelId, baseURL, fetch: customFetch, protocol: spec.endpoint.protocol, reasoning: spec.endpoint.reasoning,
  });
}

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
    id: 'catalog',
    label: 'models.dev catalog',
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
      return deferredModel(providerId, modelId, async () => {
        const endpoint = await getModelsDevModelEndpoint(providerId, modelId, deps);

        if (endpoint === null) {
          throw new Error(`Model ${providerId}/${modelId} has no supported models.dev API endpoint.`);
        }

        return keyedEndpointModel({
          providerId, credKey, modelId, deps, endpoint,
          missingCredentialError: `No API key for ${providerId} (cred key: ${credKey})`,
          // OpenCode Go's documented client contract requires these routing headers.
          ...((providerId === 'opencode' || providerId === 'opencode-go') && {
            headers: { 'user-agent': KINU_USER_AGENT, 'x-opencode-session': deps.sessionAffinity },
          }),
        });
      });
    },
  };
}
