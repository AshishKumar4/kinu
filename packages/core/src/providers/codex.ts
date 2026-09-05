// Codex via ChatGPT subscription — OAuth tokens from device-code flow against
// the internal Codex backend (chatgpt.com/backend-api/codex/responses).
//
// Auth headers come back from the AuthResolver (UserDO in production):
//   Authorization: Bearer <oauth-access-token>
//   originator: codex_cli_rs   ← WAF bypass
//   User-Agent: codex_cli_rs/...
//   ChatGPT-Account-ID: <decoded from JWT 'chatgpt_account_id'>
//
// Token refresh is handled by the resolver — providers never see refresh_token.
// On 401, we retry once with forceRefresh: true to trigger an explicit refresh.
//
// CAVEAT: CF WAF may 403 from non-residential IPs even with originator set.
// Workers egress is CF data-center IPs — runtime probe needed.
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { AuthResolution, ModelProvider, ModelInfo, ModelInputModality } from './types';
import { MODEL_INPUT_MODALITIES } from './types';
import { asFetchFunction } from './fetch-shim';
import { withRateLimitRetry } from './rate-limit-retry';
import { authCacheKey, cloneModelInfos, copyHeaders, nonEmptyString, positiveInteger } from './util';
import * as v from 'valibot';
import { CodexOAuthTokenError } from './codex-oauth';
import { JsonArraySchema, JsonObjectSchema, JsonValueSchema, type JsonValue } from '../utils/json';
import { classify, diagnostics, KinuError, renderThrownChain } from '../obs/index';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_CRED_KEY = 'codex.oauth';
export const CODEX_DEFAULT_MODEL = 'gpt-5.5';
/** The small tier the evolution engine's mechanical calls run on. */
export const CODEX_FAST_MODEL = 'gpt-5.4-mini';

/** One sentence for a ChatGPT login the provider refused even after the
 *  forced-refresh retry: what died, and the two doors to its re-auth — the
 *  web settings page and the CLI's device-code flow. */
const CODEX_DEAD_LOGIN =
  'Your ChatGPT login is no longer valid. Reconnect ChatGPT in User settings, or run `kinu setup` on this machine.';

const FALLBACK_MODELS: ModelInfo[] = [
  { id: CODEX_DEFAULT_MODEL, label: 'GPT-5.5 (Codex)',    capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 272_000 },
  { id: 'gpt-5.4',       label: 'GPT-5.4 (Codex)',       capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 272_000 },
  { id: 'gpt-5.4-mini',  label: 'GPT-5.4 mini (Codex)',  capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 272_000 },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex',         capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 272_000 },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 128_000 },
];

const CODEX_MODELS_TTL_MS = 5 * 60_000;

export interface CodexProviderOptions {
  baseURL?: string;
}

export function createCodexProvider(opts: CodexProviderOptions = {}): ModelProvider {
  const baseURL = opts.baseURL ?? CODEX_BASE_URL;
  // Keyed by the resolved credential so swapping the ChatGPT account
  // invalidates the catalog instead of serving the previous account's models.
  let modelCache: { at: number; authKey: string; models: ModelInfo[] } | null = null;
  return {
    id: 'codex',
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
        const models = parseCodexModels(body);
        if (models.length === 0) return cloneModelInfos(FALLBACK_MODELS);
        modelCache = { at: Date.now(), authKey, models };
        return cloneModelInfos(models);
      } catch (error) {
        diagnostics.event('codex.models_fallback', { error: renderThrownChain({ cause: error }) });
        return cloneModelInfos(FALLBACK_MODELS);
      }
    },

    createModel(modelId, deps): LanguageModel {
      const baseFetch = withRateLimitRetry(deps.fetch ?? fetch);
      const customFetch = asFetchFunction(async (input, init) => {
        // A dead login presents two ways: the resolver refuses up front (its
        // own proactive refresh hit invalid_grant — the local store's shape),
        // or the call goes out and comes back 401 even after one forced
        // refresh (UserDO serves a credential until it is proven dead).
        // Both get the same answer: the remedy sentence, on the 401 the AI
        // SDK already knows how to carry to the chat's failed-turn card.
        const resolveAuth = async (opts?: { forceRefresh?: boolean }): Promise<AuthResolution | 'revoked' | null> => {
          try {
            return await deps.getAuth(CODEX_CRED_KEY, opts);
          } catch (cause) {
            if (cause instanceof CodexOAuthTokenError && cause.oauthError === 'invalid_grant') return 'revoked';
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
        const send = async (headers: Record<string, string>) => {
          const merged = copyHeaders(init?.headers);
          for (const [k, v] of Object.entries(headers)) merged.set(k, v);
          return baseFetch(input, { ...requestInit, headers: merged });
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
          // Upstream error body, for WAF detection. Read from a clone so `res`
          // stays intact for the SDK. No catch: a body this cannot read is a
          // body the SDK cannot read either, and an empty string here would
          // silently disable the WAF branch below.
          const body = await res.clone().text();
          // Cloudflare WAF "Attention Required!" challenge page comes back as
          // HTML, not the JSON shape the AI SDK expects. The stream crashes
          // with an opaque parse error. Replace the response body with a
          // clear, AI-SDK-friendly JSON error that surfaces to the chat UI.
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
          // Still 401 AFTER the forced refresh: the stored login is dead
          // upstream, whatever the resolver believed.
          return refusedLoginResponse();
        }
        return res;
      });
      // apiKey is unused (customFetch overrides Authorization) but the SDK
      // requires a non-empty value to construct headers internally.
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

function parseCodexModels<T>(body: T): ModelInfo[] {
  const parsed = v.safeParse(CodexModelsResponseSchema, body);
  if (!parsed.success) return [];
  const rows = parsed.output.models ?? [];
  const models: Array<ModelInfo & { priority: number }> = [];
  for (const row of rows) {
    if (row.visibility !== 'list' && row.visibility !== undefined) continue;
    const id = nonEmptyString(row.slug);
    if (!id) continue;
    const capabilities: NonNullable<ModelInfo['capabilities']> = ['tools', 'streaming'];
    if ((row.supported_reasoning_levels?.length ?? 0) > 0) capabilities.push('reasoning');
    if (row.input_modalities?.includes('image')) capabilities.push('vision');
    const inputModalities = (row.input_modalities ?? []).flatMap((modality) => {
      const parsedModality = v.safeParse(ModelInputModalitySchema, modality);
      return parsedModality.success ? [parsedModality.output] : [];
    });
    const priority = v.safeParse(v.number(), row.priority);
    models.push({
      id,
      label: nonEmptyString(row.display_name) ?? id,
      capabilities,
      contextWindow: positiveInteger(row.context_window) ?? positiveInteger(row.max_context_window),
      inputModalities: inputModalities.length > 0 ? inputModalities : undefined,
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
  if (nonEmptyString(body.instructions)) {
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

function parseInstructionInputItem<T>(value: T): v.InferOutput<typeof InstructionInputItemSchema> | null {
  const parsed = v.safeParse(InstructionInputItemSchema, value);
  return parsed.success ? parsed.output : null;
}

const InstructionContentPartsSchema = v.array(v.object({ text: v.optional(v.string()) }));

function contentToText<T>(content: T): string {
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
