// Generic OpenAI-compatible — BYO base URL + API key. Covers Groq, Together,
// Fireworks, DeepInfra, xAI, etc. (all Chat Completions API). For OpenRouter,
// use the openrouter provider (adds attribution headers + dynamic catalog).
// For Anthropic direct, a separate Messages-API adapter is required.
//
// One openai-compat endpoint per credential key — the user can register
// multiple keyed `openai-compat.<name>` credentials (e.g. `openai-compat.groq`,
// `openai-compat.together`) and pick the model spec as
// `openai-compat:<name>/<modelId>`.
//
// createModel is sync; customFetch resolves the apiKey + baseURL at request
// time via the AuthResolver.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import type { AuthResolution, ModelInfo, ModelProvider } from './types';
import { createAuthedFetch, positiveInteger } from './util';

const ModelListSchema = v.object({
  data: v.array(v.object({
    id: v.optional(v.unknown()),
    name: v.optional(v.unknown()),
    context_window: v.optional(v.unknown()),
  })),
});

export const OPENAI_COMPAT_KEY_PREFIX = 'openai-compat.';

/** Extract the credential key for an openai-compat provider id.
 *  `openai-compat:groq` → `openai-compat.groq` */
function credKeyFor(providerId: string): string {
  if (providerId === 'openai-compat') return `${OPENAI_COMPAT_KEY_PREFIX}default`;
  if (providerId.startsWith('openai-compat:')) {
    return OPENAI_COMPAT_KEY_PREFIX + providerId.slice('openai-compat:'.length);
  }
  return providerId;
}

export function createOpenAICompatProvider(providerId: string = 'openai-compat'): ModelProvider {
  const credKey = credKeyFor(providerId);
  return {
    id: providerId,
    label: providerId === 'openai-compat'
      ? 'OpenAI-compatible (BYO base URL)'
      : `OpenAI-compatible (${providerId.slice('openai-compat:'.length)})`,
    async isAvailable(deps) { return deps.hasCredential(credKey); },
    unavailableReason() { return `No openai-compat credential at key \`${credKey}\` (set baseURL + apiKey).`; },
    async listModels(deps) {
      return discoverOpenAICompatibleModels(await deps.getAuth(credKey), deps.fetch);
    },

    createModel(modelId, deps): LanguageModel {
      // baseURL is sourced from the credential, but @ai-sdk needs it at
      // construction. We pass a placeholder and rewrite the prefix inside
      // customFetch (which re-reads the credential each call, so a UI-side
      // change to baseURL takes effect without rebuilding the model).
      const placeholder = 'https://openai-compat.invalid';
      const customFetch = createAuthedFetch(deps, {
        credKey,
        missingCredentialError: `openai-compat credential ${credKey} not configured (baseURL required)`,
        requireBaseURL: true,
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

/** The endpoint's own `/models` list. An empty array means the endpoint
 *  answered and offers nothing usable; a fetch or parse failure throws, so a
 *  wrong base URL is not reported as a provider with no models. */
export async function discoverOpenAICompatibleModels(
  auth: AuthResolution | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  if (!auth?.baseURL) return [];
  const response = await fetchImpl(`${auth.baseURL.replace(/\/+$/, '')}/models`, {
    headers: { ...auth.headers, accept: 'application/json' },
  });
  if (!response.ok) return [];
  const body = v.safeParse(ModelListSchema, await response.json());
  if (!body.success) return [];
  return body.output.data.flatMap((value): ModelInfo[] => {
    const id = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value.id);
    if (!id.success) return [];
    const contextWindow = positiveInteger(value.context_window);
    const name = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value.name);
    return [{
      id: id.output,
      label: name.success ? name.output : id.output,
      contextWindow: contextWindow || undefined,
    }];
  });
}
