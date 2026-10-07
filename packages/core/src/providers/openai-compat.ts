// Generic OpenAI-compatible Chat Completions endpoint; one per `openai-compat.<name>`
// credential, model spec `openai-compat:<name>/<modelId>`.
import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import { baseCredentialKey } from '../credentials/accounts';
import type { DynamicProviderSource } from './registry';
import type { AuthResolution, ModelInfo, ModelProvider } from './types';
import { keyedEndpointModel } from './catalog';
import { positiveInteger } from './util';

const ModelListSchema = v.object({
  data: v.array(v.object({
    id: v.optional(v.unknown()),
    name: v.optional(v.unknown()),
    context_window: v.optional(v.unknown()),
  })),
});

const OPENAI_COMPAT_KEY_PREFIX = 'openai-compat.';

function openAICompatNameOf(key: string): string | null {
  const base = baseCredentialKey(key);

  return base.startsWith(OPENAI_COMPAT_KEY_PREFIX) ? base.slice(OPENAI_COMPAT_KEY_PREFIX.length) : null;
}

/** `openai-compat:groq` → `openai-compat.groq` */
function credKeyFor(providerId: string): string {
  if (providerId === 'openai-compat') return `${OPENAI_COMPAT_KEY_PREFIX}default`;

  if (providerId.startsWith('openai-compat:')) {
    return OPENAI_COMPAT_KEY_PREFIX + providerId.slice('openai-compat:'.length);
  }

  return providerId;
}

export function createNamedEndpointSource(): DynamicProviderSource {
  const providers = new Map<string, ModelProvider>();

  return {
    id: 'openai-compat',
    label: 'OpenAI-compatible endpoints',
    get(providerId) {
      if (!providerId.startsWith('openai-compat:')) return undefined;
      const provider = providers.get(providerId) ?? createOpenAICompatProvider(providerId);

      providers.set(providerId, provider);

      return provider;
    },
    async listIds(deps) {
      const names = (await deps.listCredentialKeys?.() ?? []).flatMap((key) => openAICompatNameOf(key) ?? []);

      return [...new Set(names)].filter((name) => name !== 'default').sort().map((name) => `openai-compat:${name}`);
    },
  };
}

export function createOpenAICompatProvider(providerId = 'openai-compat'): ModelProvider {
  const credKey = credKeyFor(providerId);

  return {
    id: providerId,
    credentialKey: credKey,
    label: providerId === 'openai-compat'
      ? 'OpenAI-compatible (BYO base URL)'
      : `OpenAI-compatible (${providerId.slice('openai-compat:'.length)})`,
    async isAvailable(deps) { return deps.hasCredential(credKey); },
    unavailableReason() { return `No openai-compat credential at key \`${credKey}\` (set baseURL + apiKey).`; },
    async listModels(deps) {
      return discoverOpenAICompatibleModels(await deps.getAuth(credKey), deps.fetch);
    },

    createModel(modelId, deps): LanguageModel {
      // The SDK needs a base URL at construction; the credential's own replaces this placeholder on every call.
      return keyedEndpointModel({
        providerId, credKey, modelId, deps, requireBaseURL: true,
        endpoint: { baseURL: 'https://openai-compat.invalid', protocol: 'chat-completions', reasoning: false },
        missingCredentialError: `openai-compat credential ${credKey} not configured (baseURL required)`,
      });
    },
  };
}

/** The endpoint's `/models` list; a refused or unreadable list reads as no models, a failed fetch throws. */
export async function discoverOpenAICompatibleModels(
  auth: AuthResolution | null,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  if (!auth?.baseURL) return [];

  const response = await fetchImpl(`${auth.baseURL.replace(/\/+$/, '')}/models`, {
    headers: { ...auth.headers, accept: 'application/json' },
    signal,
  });

  if (!response.ok) return [];
  const body = v.safeParse(ModelListSchema, await response.json());

  if (!body.success) return [];

  return body.output.data.flatMap((value): ModelInfo[] => {
    const id = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value.id);

    if (!id.success) return [];
    const contextWindow = auth.contextWindow ?? positiveInteger({ value: value.context_window });
    const name = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value.name);

    return [{
      id: id.output,
      label: name.success ? name.output : id.output,
      contextWindow,
    }];
  });
}
