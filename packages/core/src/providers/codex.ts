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
import type { ModelProvider, ModelInfo } from './types.js';
import { asFetchFunction } from './fetch-shim.js';
import { authCacheKey, cloneModelInfos, isRecord, nonEmptyString, positiveInteger } from './util.js';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_CRED_KEY = 'codex.oauth';

const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gpt-5.5',       label: 'GPT-5.5 (Codex)',       capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 272_000 },
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
    defaultModel: 'gpt-5.5',

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
      } catch {
        return cloneModelInfos(FALLBACK_MODELS);
      }
    },

    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const customFetch = asFetchFunction(async (input, init) => {
        const urlStr = typeof input === 'string' ? input
                      : input instanceof URL ? input.toString()
                      : (input as Request).url;
        const t0 = Date.now();
        const auth = await deps.getAuth(CODEX_CRED_KEY);
        if (!auth) {
          debugCodex(`no credentials for ${modelId} — refusing to call ${urlStr}`);
          return new Response(
            JSON.stringify({ error: 'Codex credentials not configured. Connect ChatGPT in /user/settings.' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const requestInit = normalizeCodexResponsesRequest(init);
        const send = async (headers: Record<string, string>) => {
          const merged = new Headers(init?.headers);
          for (const [k, v] of Object.entries(headers)) merged.set(k, v);
          return baseFetch(input, { ...requestInit, headers: merged });
        };
        let res = await send(auth.headers);
        const dt = Date.now() - t0;
        debugCodex(`${init?.method ?? 'POST'} ${urlStr.replace(/^https?:\/\//, '')} -> ${res.status} (${dt}ms)`);
        if (res.status === 401) {
          debugCodex('401 from upstream; attempting forceRefresh');
          const refreshed = await deps.getAuth(CODEX_CRED_KEY, { forceRefresh: true });
          if (refreshed) {
            res = await send(refreshed.headers);
            debugCodex(`retry-after-refresh -> ${res.status}`);
          }
        }
        if (!res.ok) {
          // Capture upstream error body for diagnostics + WAF detection.
          let body = '';
          try {
            const cloned = res.clone();
            body = await cloned.text();
            debugCodex(`upstream ${res.status} body (first 500 chars): ${body.slice(0, 500)}`);
          } catch { /* nop */ }
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
            debugCodex('WAF detected — returning structured error to AI SDK');
            return new Response(
              JSON.stringify({ error: { message: userMsg, type: 'cf_waf_blocked', code: 'codex_unavailable' } }),
              { status: 503, headers: { 'Content-Type': 'application/json' } },
            );
          }
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

interface CodexModelsResponse {
  models?: CodexModelInfo[];
}

interface CodexModelInfo {
  slug?: string;
  display_name?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  context_window?: number;
  max_context_window?: number;
  supported_reasoning_levels?: unknown[];
  input_modalities?: string[];
}

function parseCodexModels(body: unknown): ModelInfo[] {
  if (!isRecord(body) || !Array.isArray((body as CodexModelsResponse).models)) return [];
  const rows = (body as CodexModelsResponse).models ?? [];
  const models: Array<ModelInfo & { priority: number }> = [];
  for (const row of rows) {
    if (row.visibility !== 'list' && row.visibility !== undefined) continue;
    const id = nonEmptyString(row.slug);
    if (!id) continue;
    const capabilities: NonNullable<ModelInfo['capabilities']> = ['tools', 'streaming'];
    if ((row.supported_reasoning_levels?.length ?? 0) > 0) capabilities.push('reasoning');
    if (row.input_modalities?.includes('image')) capabilities.push('vision');
    models.push({
      id,
      label: nonEmptyString(row.display_name) ?? id,
      capabilities,
      contextWindow: positiveInteger(row.context_window) ?? positiveInteger(row.max_context_window),
      priority: typeof row.priority === 'number' ? row.priority : 0,
    });
  }
  return models
    .sort((a, b) => (b.priority - a.priority) || (a.label ?? a.id).localeCompare(b.label ?? b.id))
    .map(({ priority: _priority, ...model }) => model);
}

function normalizeCodexResponsesRequest(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || typeof init.body !== 'string') return init;

  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!isRecord(body)) return init;
  if (typeof body.instructions === 'string' && body.instructions.trim().length > 0) return init;
  const input = Array.isArray(body.input) ? body.input : [];
  const instructionParts: string[] = [];
  const remainingInput: unknown[] = [];

  for (const item of input) {
    if (isInstructionInputItem(item)) {
      const text = contentToText(item.content);
      if (text) instructionParts.push(text);
    } else {
      remainingInput.push(item);
    }
  }

  const instructions = instructionParts.join('\n\n').trim() || 'You are Proteus, a helpful coding agent.';
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

function isInstructionInputItem(value: unknown): value is { role: 'developer' | 'system'; content: unknown } {
  return isRecord(value) && (value.role === 'developer' || value.role === 'system');
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      const text = part.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function debugCodex(message: string): void {
  const globalWithProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  if (globalWithProcess.process?.env?.PROTEUS_PROVIDER_DEBUG === '1') {
    console.error(`[codex] ${message}`);
  }
}
