// OpenRouter gateway: bearer plus HTTP-Referer/X-Title attribution headers; dynamic catalog.
import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import type { ModelProvider, ModelInfo } from './types';
import { createAuthedFetch } from './util';
import { catalogBody, credentialCatalog } from './credential-catalog';
import { Effect } from 'effect';
import { knownReasoningEfforts } from './reasoning-effort';
import { heardFetch } from './middleware/attempt';
import { lazyModel, MODEL_SDKS } from './wire-model';
import { OPENAI_DEFAULT_MODEL } from './openai';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const OPENROUTER_CRED_KEY = 'openrouter.bearer';

export interface OpenRouterOptions {
  refererURL?: string;
  appTitle?: string;
}

/** `GET /models` rows; `reasoning.supported_efforts` lists accepted `reasoning.effort`
 *  values (https://openrouter.ai/docs/use-cases/reasoning-tokens). */
const OpenRouterCatalogSchema = v.object({
  data: v.optional(v.array(v.object({
    id: v.string(),
    name: v.optional(v.string()),
    context_length: v.optional(v.number()),
    architecture: v.optional(v.object({ modality: v.optional(v.string()) })),
    reasoning: v.optional(v.object({ supported_efforts: v.optional(v.array(v.string())) })),
  }))),
});

/** OpenRouter names a model by its author; its default is OpenAI's own (models.dev's OpenRouter list holds it). */
export const OPENROUTER_DEFAULT_MODEL = `openai/${OPENAI_DEFAULT_MODEL}`;

export function createOpenRouterProvider(opts: OpenRouterOptions = {}): ModelProvider {
  const catalog = credentialCatalog('OpenRouter', 5 * 60_000);

  return {
    id: 'openrouter',
    credentialKey: OPENROUTER_CRED_KEY,
    label: 'OpenRouter',
    defaultModel: OPENROUTER_DEFAULT_MODEL,
    async isAvailable(deps) { return deps.hasCredential(OPENROUTER_CRED_KEY); },
    unavailableReason() { return 'No OpenRouter API key (cred key: `openrouter.bearer`).'; },

    async listModels(deps) {
      return catalog(await deps.getAuth(OPENROUTER_CRED_KEY), (auth) => Effect.gen(function* () {
        const body = yield* catalogBody('openrouter.ai', OpenRouterCatalogSchema, () => (deps.fetch ?? fetch)(`${OPENROUTER_BASE_URL}/models`, { headers: auth.headers }));

        return (body.data ?? []).map((m): ModelInfo => ({
          id: m.id,
          label: m.name ?? m.id,
          contextWindow: m.context_length,
          capabilities: m.architecture?.modality?.includes('image')
            ? ['tools', 'streaming', 'vision']
            : ['tools', 'streaming'],
          // A row without a `reasoning` block is a non-reasoning model: no levels.
          reasoningEfforts: knownReasoningEfforts(m.reasoning?.supported_efforts ?? []),
        }));
      }));
    },

    createModel(modelId, deps): LanguageModel {
      const customFetch = createAuthedFetch(deps, {
        provider: 'openrouter',
        credKey: OPENROUTER_CRED_KEY,
        missingCredentialError: 'OpenRouter API key not configured',
        mutate: ({ headers }) => {
          if (opts.refererURL) headers.set('HTTP-Referer', opts.refererURL);

          if (opts.appTitle) headers.set('X-Title', opts.appTitle);
        },
      });

      return lazyModel('openrouter.chat', modelId, async () => (await MODEL_SDKS.openaiCompatible()).createOpenAICompatible({
        name: 'openrouter',
        baseURL: OPENROUTER_BASE_URL,
        fetch: heardFetch(customFetch),
      }).chatModel(modelId));
    },
  };
}
