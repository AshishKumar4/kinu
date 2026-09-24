// Codex via ChatGPT subscription (chatgpt.com/backend-api/codex/responses); auth headers from the AuthResolver.
// `originator: codex_cli_rs` is the WAF bypass; Cloudflare may still 403 Workers' data-center IPs.
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { AuthResolution, ModelProvider, ModelInfo, ModelInputModality } from './types';
import { MODEL_INPUT_MODALITIES } from './types';
import { withRateLimitRetry } from './rate-limit-retry';
import { authCacheKey, cloneModelInfos, positiveInteger } from './util';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import { withCallAccount } from './quota';
import { nonEmptyString } from '../utils/json';
import * as v from 'valibot';
import { OAuthTokenError } from './oauth-token-error';
import { JsonArraySchema, JsonObjectSchema, JsonValueSchema, type JsonValue } from '../utils/json';
import { classify, diagnostics, KinuError, renderThrownChain } from '../obs/index';
import { GPT54_EFFORTS } from './openai';
import { knownReasoningEfforts } from './reasoning-effort';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export const CODEX_CRED_KEY = 'codex.oauth';

export const CODEX_DEFAULT_MODEL = 'gpt-5.5';

export const CODEX_FAST_MODEL = 'gpt-5.4-mini';

/** The remedy for a ChatGPT login refused after the forced-refresh retry: web settings or CLI device-code. */
const CODEX_DEAD_LOGIN =
  'Your ChatGPT login is no longer valid. Reconnect ChatGPT in User settings, or run `kinu setup` on this machine.';

/** Offline list (levels from `GPT54_EFFORTS`); the live `/models` listing carries each model's own levels. */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: CODEX_DEFAULT_MODEL, label: 'GPT-5.5 (Codex)',    capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 272_000, reasoningEfforts: GPT54_EFFORTS },
  { id: 'gpt-5.4',       label: 'GPT-5.4 (Codex)',       capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 272_000, reasoningEfforts: GPT54_EFFORTS },
  { id: 'gpt-5.4-mini',  label: 'GPT-5.4 mini (Codex)',  capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 272_000, reasoningEfforts: GPT54_EFFORTS },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex',         capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 272_000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 128_000 },
];

const CODEX_MODELS_TTL_MS = 5 * 60_000;

export interface CodexProviderOptions {
  baseURL?: string;
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
      return 'No Codex OAuth credential — connect ChatGPT via the device-code flow.';
    },
    async listModels(deps) {
      const auth = await deps.getAuth(CODEX_CRED_KEY);

      if (!auth) {
        modelCache = null;

        return cloneModelInfos(FALLBACK_MODELS);
      }

      const authKey = authCacheKey(auth);

      if (modelCache && modelCache.authKey === authKey && Date.now() - modelCache.at < CODEX_MODELS_TTL_MS) {
        return cloneModelInfos(modelCache.models);
      }

      try {
        const fetchFn = deps.fetch ?? fetch;

        const res = await fetchFn(`${baseURL.replace(/\/+$/, '')}/models?client_version=1.0.0`, {
          headers: auth.headers,
        });

        if (!res.ok) return cloneModelInfos(FALLBACK_MODELS);
        const body: unknown = await res.json();
        const models = parseCodexModels({ body });

        if (models.length === 0) return cloneModelInfos(FALLBACK_MODELS);
        modelCache = { at: Date.now(), authKey, models };

        return cloneModelInfos(models);
      } catch (error) {
        diagnostics.event('codex.models_fallback', { error: renderThrownChain({ cause: error }) });

        return cloneModelInfos(FALLBACK_MODELS);
      }
    },

    createModel(modelId, deps): LanguageModel {
      const retrying = (lane: string): typeof fetch => withRateLimitRetry(deps.fetch ?? fetch, {
        provider: 'codex',
        modelId,
        lane,
        ...(deps.onProviderWait !== undefined && { onWait: deps.onProviderWait }),
      });

      const customFetch = asFetchFunction(async (input, init) => {
        // A dead login (resolver refusal, or 401 after forced refresh) gets the remedy on a 401 the SDK carries.
        const resolveAuth = async (refresh?: { forceRefresh?: boolean }): Promise<AuthResolution | 'revoked' | null> => {
          try {
            return await deps.getAuth(CODEX_CRED_KEY, refresh);
          } catch (cause) {
            if (cause instanceof OAuthTokenError && cause.revoked) return 'revoked';
            throw cause;
          }
        };

        const refusedLoginResponse = (): Response => {
          diagnostics.failure(
            'provider.codex_dead_login',
            new KinuError('denied', 'the stored ChatGPT login was refused by chatgpt.com'),
            { model: modelId },
          );

          return new Response(
            JSON.stringify({ error: { message: CODEX_DEAD_LOGIN } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        };

        const auth = await resolveAuth();

        if (auth === 'revoked') return refusedLoginResponse();

        if (!auth) {
          diagnostics.failure(
            'credential.codex_absent',
            new KinuError('missing', 'no Codex credentials; the model call was refused before it left'),
            { model: modelId },
          );

          return new Response(
            JSON.stringify({ error: { message: 'Codex credentials not configured. Connect ChatGPT in User settings, or run `kinu setup` on this machine.' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const requestInit = normalizeCodexResponsesRequest(init);

        const paid = auth.credentialKey ?? CODEX_CRED_KEY;

        const send = async (headers: Record<string, string>) => {
          const merged = copyHeaders(init?.headers);

          for (const [name, value] of Object.entries(headers)) merged.set(name, value);

          return retrying(paid)(input, { ...requestInit, headers: merged });
        };

        let res = await send(auth.headers);

        if (res.status === 401) {
          const refreshed = await resolveAuth({ forceRefresh: true });

          if (refreshed === 'revoked') return refusedLoginResponse();

          if (refreshed) {
            res = await send(refreshed.headers);
          }
        }

        if (!res.ok) {
          // Read from a clone so `res` stays intact for the SDK; no catch, or the WAF branch silently disables.
          const body = await res.clone().text();

          // Cloudflare WAF challenge HTML would crash the SDK stream with a parse error; replace it with a JSON error.
          if (res.status === 403 && /Cloudflare|Attention Required/i.test(body)) {
            const userMsg =
              'Codex is blocked by Cloudflare\'s WAF when called from Cloudflare Workers\' ' +
              'egress (the request from this Worker hits chatgpt.com/backend-api/codex and is ' +
              'refused as bot traffic). Until we add a non-CF egress route (AI Gateway with custom ' +
              'egress IP), Codex chat won\'t work from this deployment. ' +
              'Workaround: in /user/settings → API keys, paste an OpenAI API key, then pick an ' +
              '`openai/*` model — that path goes to api.openai.com directly and isn\'t affected by ' +
              'the WAF.';

            diagnostics.failure(
              'provider.codex_waf_blocked',
              new KinuError('unavailable', 'Codex refused this Worker\'s egress as bot traffic'),
              { model: modelId },
            );

            return new Response(
              JSON.stringify({ error: { message: userMsg, type: 'cf_waf_blocked', code: 'codex_unavailable' } }),
              { status: 503, headers: { 'Content-Type': 'application/json' } },
            );
          }
        }

        if (res.status === 401) {
          return refusedLoginResponse();
        }

        return withCallAccount(res, 'codex', paid);
      });

      const provider = createOpenAI({ baseURL, apiKey: 'oauth-placeholder', fetch: customFetch });

      return provider.responses(modelId);
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

function parseCodexModels(input: { body: unknown }): ModelInfo[] {
  const parsed = v.safeParse(CodexModelsResponseSchema, input.body);

  if (!parsed.success) return [];
  const rows = parsed.output.models ?? [];
  const models: Array<ModelInfo & { priority: number }> = [];

  for (const row of rows) {
    if (row.visibility !== 'list' && row.visibility !== undefined) continue;
    const id = nonEmptyString({ value: row.slug });

    if (!id) continue;
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

    const priority = v.safeParse(v.number(), row.priority);
    models.push({
      id,
      label: nonEmptyString({ value: row.display_name }) ?? id,
      capabilities,
      contextWindow: positiveInteger({ value: row.context_window }) ?? positiveInteger({ value: row.max_context_window }),
      inputModalities: inputModalities.length > 0 ? inputModalities : undefined,
      reasoningEfforts,
      priority: priority.success ? priority.output : 0,
    });
  }

  return models
    .sort((a, b) => (b.priority - a.priority) || (a.label ?? a.id).localeCompare(b.label ?? b.id))
    .map(({ priority: _priority, ...model }) => model);
}

const CODEX_DEFAULT_INSTRUCTIONS = 'You are Kinu, a helpful coding agent.';

export function normalizeCodexResponsesRequest(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) return init;
  const serializedBody = v.safeParse(v.string(), init.body);

  if (!serializedBody.success) return init;

  let decoded: JsonValue;

  try {
    decoded = v.parse(JsonValueSchema, JSON.parse(serializedBody.output));
  } catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;

    return init;
  }

  const parsedBody = v.safeParse(JsonObjectSchema, decoded);

  if (!parsedBody.success) return init;
  const body = parsedBody.output;

  if (nonEmptyString({ value: body.instructions })) {
    return {
      ...init,
      body: JSON.stringify({ ...body, store: false }),
    };
  }

  const parsedInput = v.safeParse(JsonArraySchema, body.input);

  if (!parsedInput.success) {
    return {
      ...init,
      body: JSON.stringify({ ...body, instructions: CODEX_DEFAULT_INSTRUCTIONS, store: false }),
    };
  }

  const input = parsedInput.output;
  const instructionParts: string[] = [];
  const remainingInput: JsonValue[] = [];

  for (const item of input) {
    const instruction = parseInstructionInputItem(item);

    if (instruction) {
      const text = contentToText(instruction.content);

      if (text) instructionParts.push(text);
    } else {
      remainingInput.push(item);
    }
  }

  const instructions = instructionParts.join('\n\n').trim() || CODEX_DEFAULT_INSTRUCTIONS;

  return {
    ...init,
    body: JSON.stringify({
      ...body,
      instructions,
      store: false,
      input: remainingInput,
    }),
  };
}

const InstructionInputItemSchema = v.object({
  role: v.picklist(['developer', 'system']),
  content: JsonValueSchema,
});

function parseInstructionInputItem(value: JsonValue): v.InferOutput<typeof InstructionInputItemSchema> | null {
  const parsed = v.safeParse(InstructionInputItemSchema, value);

  return parsed.success ? parsed.output : null;
}

const InstructionContentPartsSchema = v.array(v.object({ text: v.optional(v.string()) }));

function contentToText(content: JsonValue): string {
  const text = v.safeParse(v.string(), content);

  if (text.success) return text.output.trim();
  const parts = v.safeParse(InstructionContentPartsSchema, content);

  if (!parts.success) return '';

  return parts.output
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}
