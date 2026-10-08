// Codex via ChatGPT subscription (chatgpt.com/backend-api/codex/responses).
import { APICallError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { ModelProvider, ModelInfo, ModelInputModality } from './types';
import { MODEL_INPUT_MODALITIES } from './types';
import { authenticatedSend, signedSend } from './authenticated-send';
import { authCacheKey, cloneModelInfos, positiveInteger, StaleModelList, statelessResponses } from './util';
import { asFetchFunction } from './fetch-shim';
import { withCallAccount } from './quota';
import { nonEmptyString } from '../utils/json';
import * as v from 'valibot';

import { JsonValueSchema } from '../utils/json';
import { Effect } from 'effect';
import { diagnostics, KinuError, renderThrownChain, settle } from '../obs/index';
import { knownReasoningEfforts } from './reasoning-effort';
import { heardFetch } from './middleware/attempt';
import { lazyModel } from './wire-model';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export const CODEX_CRED_KEY = 'codex.oauth';

const CODEX_DEFAULT_MODEL = 'gpt-5.5';

/** Evolution's mechanical-call tier. */
const CODEX_FAST_MODEL = 'gpt-6-luna';

/** A dead ChatGPT login's remedy. */
const CODEX_DEAD_LOGIN = 'Your ChatGPT login is no longer valid.';

/** A refused network gets a 403 HTML page before sign-in (docs/DEPLOYMENT.md); a login refusal is JSON. */
function networkRefused(res: Response): boolean {
  return res.status === 403 && (res.headers.get('content-type') ?? '').includes('text/html');
}

const NETWORK_REFUSED = 'chatgpt.com refused this server\'s network (HTTP 403 block page, before sign-in)';

const CODEX_MODELS_TTL_MS = 5 * 60_000;

/** All an egress route may carry for Codex. */
export function codexEgressAllowed(input: { readonly method: string; readonly url: string }): boolean {
  const url = URL.parse(input.url);

  if (url?.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port !== '') return false;
  const { pathname } = url;

  if (input.method === 'GET') return pathname === '/backend-api/codex/models' || pathname === '/backend-api/wham/usage';

  return input.method === 'POST' && pathname === '/backend-api/codex/responses';
}

export interface CodexProviderOptions {
  baseURL?: string;
  /** Transport for chatgpt.com when this runtime's egress is refused there (Workers). */
  egress?: typeof fetch;
}

export function createCodexProvider(opts: CodexProviderOptions = {}): ModelProvider {
  const baseURL = opts.baseURL ?? CODEX_BASE_URL;
  // Keyed by credential so switching ChatGPT account invalidates the catalog.
  let modelCache: { at: number; authKey: string; models: ModelInfo[] } | null = null;

  return {
    id: 'codex',
    credentialKey: CODEX_CRED_KEY,
    label: 'ChatGPT Codex (subscription)',
    defaultModel: CODEX_DEFAULT_MODEL,
    fastModel: CODEX_FAST_MODEL,

    async isAvailable(deps) { return deps.hasCredential(CODEX_CRED_KEY); },
    unavailableReason() {
      return 'No Codex OAuth credential: connect ChatGPT via the device-code flow.';
    },
    async listModels(deps) {
      return settle(Effect.gen(function* () {
        const auth = yield* Effect.promise(() => deps.getAuth(CODEX_CRED_KEY));

        if (!auth) {
          modelCache = null;

          return [];
        }

        const authKey = authCacheKey(auth);

        if (modelCache && modelCache.authKey === authKey && Date.now() - modelCache.at < CODEX_MODELS_TTL_MS) {
          return cloneModelInfos(modelCache.models);
        }

        const stale = (failure: { readonly reason: string; readonly cause?: unknown }): StaleModelList => {
          diagnostics.event('codex.models_fallback', {
            error: failure.cause === undefined ? failure.reason : renderThrownChain({ cause: failure.cause }),
          });

          return new StaleModelList([], { ...failure, reason: `Codex models could not be read: ${failure.reason}` });
        };

        const res = yield* Effect.tryPromise({
          try: () => (opts.egress ?? deps.fetch ?? fetch)(`${baseURL.replace(/\/+$/, '')}/models?client_version=1.0.0`, { headers: auth.headers }),
          catch: (cause) => ({ cause }),
        }).pipe(Effect.catch((failed) => Effect.fail(stale({ reason: 'chatgpt.com could not be reached', cause: failed.cause }))));

        if (networkRefused(res)) return yield* Effect.fail(stale({ reason: NETWORK_REFUSED }));

        if (!res.ok) return yield* Effect.fail(stale({ reason: `chatgpt.com answered HTTP ${String(res.status)}` }));
        const body: unknown = yield* Effect.promise(() => res.json());
        const models = parseCodexModels({ body });

        if (models.length === 0) return yield* Effect.fail(stale({ reason: 'chatgpt.com listed no models' }));
        modelCache = { at: Date.now(), authKey, models };

        return cloneModelInfos(models);
      }));
    },

    createModel(modelId, deps): LanguageModel {
      const transport = opts.egress ?? deps.fetch ?? fetch;

      const customFetch = asFetchFunction((input, init) => settle(Effect.gen(function* () {
        // A refused renewal keeps the SDK's 401 remedy.
        const refusedLoginResponse = (): Response => {
          diagnostics.failure(
            'provider.codex_dead_login',
            new KinuError('denied', 'the stored ChatGPT login was refused by chatgpt.com'),
            { model: modelId },
          );

          return new Response(JSON.stringify({ error: { message: CODEX_DEAD_LOGIN } }), {
            status: 401, headers: { 'Content-Type': 'application/json' },
          });
        };

        const answer = yield* Effect.promise(() => authenticatedSend({ key: CODEX_CRED_KEY, getAuth: deps.getAuth, send: signedSend(transport, input, init) }));

        if (answer.kind === 'refused') return refusedLoginResponse();

        if (answer.kind === 'absent') {
          diagnostics.failure(
            'credential.codex_absent',
            new KinuError('missing', 'no Codex credentials; the model call was refused before it left'),
            { model: modelId },
          );

          return new Response(JSON.stringify({ error: { message: 'ChatGPT credentials are not configured for this account.' } }), {
            status: 401, headers: { 'Content-Type': 'application/json' },
          });
        }

        const res = answer.response;

        if (networkRefused(res)) {
          const refused = new KinuError('unavailable', NETWORK_REFUSED);

          diagnostics.failure('provider.codex_network_refused', refused, { model: modelId });

          const failure = new APICallError({
            message: `Codex is unreachable from here: ${NETWORK_REFUSED}. Pick another model, or run Codex from the Kinu CLI.`,
            url: input instanceof Request ? input.url : input.toString(),
            requestBodyValues: undefined,
            statusCode: 503,
            isRetryable: false,
            cause: refused,
          });

          return yield* Effect.die(failure);
        }

        return withCallAccount(res, 'codex', answer.auth.credentialKey ?? CODEX_CRED_KEY);
      })));

      const model = lazyModel('openai.responses', modelId, async () => (await import('@ai-sdk/openai'))
        .createOpenAI({ baseURL, apiKey: 'oauth-placeholder', fetch: heardFetch(customFetch) }).responses(modelId));

      return wrapLanguageModel({ model, middleware: [statelessResponses(true), CODEX_INSTRUCTIONS] });
    },
  };
}

const CodexModelsResponseSchema = v.object({
  models: v.optional(v.array(v.object({
    slug: v.optional(v.string()),
    display_name: v.optional(v.string()),
    visibility: v.optional(v.string()),
    supported_in_api: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    context_window: v.optional(v.number()),
    max_context_window: v.optional(v.number()),
    supported_reasoning_levels: v.optional(v.array(JsonValueSchema)),
    input_modalities: v.optional(v.array(v.string())),
  }))),
});

const ModelInputModalitySchema: v.GenericSchema<ModelInputModality> = v.picklist(MODEL_INPUT_MODALITIES);

/** The object form of a `supported_reasoning_levels` row; the other form is a bare level string. */
const CodexReasoningLevelSchema = v.object({ effort: v.string() });

export interface ChatGptCatalogRow {
  readonly model: ModelInfo;
  readonly visibility: string | undefined;
  readonly priority: number;
}


export function chatgptCatalogRows(answer: { readonly body: unknown }): ChatGptCatalogRow[] {
  const parsed = v.safeParse(CodexModelsResponseSchema, answer.body);

  if (!parsed.success) return [];

  return (parsed.output.models ?? []).flatMap((row): ChatGptCatalogRow[] => {
    const id = nonEmptyString({ value: row.slug });

    if (!id) return [];
    const capabilities: NonNullable<ModelInfo['capabilities']> = ['tools', 'streaming'];

    const reasoningEfforts = knownReasoningEfforts((row.supported_reasoning_levels ?? []).map((level) => {
      const named = v.safeParse(CodexReasoningLevelSchema, level);

      return named.success ? named.output.effort : level;
    }));

    if ((row.supported_reasoning_levels?.length ?? 0) > 0) capabilities.push('reasoning');

    if (row.input_modalities?.includes('image')) capabilities.push('vision');

    const inputModalities = (row.input_modalities ?? []).flatMap((modality) => {
      const parsedModality = v.safeParse(ModelInputModalitySchema, modality);

      return parsedModality.success ? [parsedModality.output] : [];
    });

    return [{
      model: {
        id,
        label: nonEmptyString({ value: row.display_name }) ?? id,
        capabilities,
        // `context_window` is the standard-priced window, `max_context_window` the most the model takes (OMP's
        // discovery/codex.ts and compat/context-window.ts): Kinu sizes a turn to the most.
        contextWindow: largest(positiveInteger({ value: row.context_window }), positiveInteger({ value: row.max_context_window })),
        inputModalities: inputModalities.length > 0 ? inputModalities : undefined,
        reasoningEfforts,
      },
      visibility: row.visibility,
      priority: row.priority ?? 0,
    }];
  });
}

function largest(...windows: readonly (number | undefined)[]): number | undefined {
  const known = windows.filter((window) => window !== undefined);

  return known.length === 0 ? undefined : Math.max(...known);
}

/** The rows a provider's own visibility rule shows. The rest are logged once per listing, by slug and visibility, so a
 *  model the account's catalog withholds can be told from one it lacks. */
export function shownCatalogRows(provider: string, rows: readonly ChatGptCatalogRow[], shows: (visibility: string | undefined) => boolean): ChatGptCatalogRow[] {
  const hidden = rows.filter((row) => !shows(row.visibility));

  if (hidden.length > 0) {
    diagnostics.event('provider.catalog_hidden', { provider, hidden: hidden.map((row) => `${row.model.id}:${row.visibility ?? 'unset'}`).join(',') });
  }

  return rows.filter((row) => shows(row.visibility));
}

function parseCodexModels(input: { body: unknown }): ModelInfo[] {
  return shownCatalogRows('codex', chatgptCatalogRows(input), (visibility) => visibility === 'list' || visibility === undefined)
    .sort((a, b) => (b.priority - a.priority) || (a.model.label ?? a.model.id).localeCompare(b.model.label ?? b.model.id))
    .map((row) => row.model);
}

const CODEX_DEFAULT_INSTRUCTIONS = 'You are Kinu, a helpful coding agent.';

/** chatgpt.com's Codex route takes the system prompt only as `instructions`, and refuses a call without them. */
const CODEX_INSTRUCTIONS: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => {
    if (nonEmptyString({ value: params.providerOptions?.openai?.instructions })) return params;
    const system = params.prompt.flatMap((message) => (message.role === 'system' ? [message.content.trim()] : []));
    const instructions = system.filter(Boolean).join('\n\n') || CODEX_DEFAULT_INSTRUCTIONS;

    return {
      ...params,
      prompt: params.prompt.filter((message) => message.role !== 'system'),
      providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, instructions } },
    };
  },
};
