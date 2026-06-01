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
import type { ModelProvider, ModelInfo, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_CRED_KEY = 'codex.oauth';

const MODELS: ModelInfo[] = [
  { id: 'gpt-5.5',      label: 'GPT-5.5 (Codex)',      capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'gpt-5',        label: 'GPT-5 (Codex)',        capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'gpt-5-codex',  label: 'GPT-5 Codex',          capabilities: ['tools', 'streaming', 'reasoning'] },
  { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini (Codex)', capabilities: ['tools', 'streaming'] },
];

export interface CodexProviderOptions {
  baseURL?: string;
}

export function createCodexProvider(opts: CodexProviderOptions = {}): ModelProvider {
  const baseURL = opts.baseURL ?? CODEX_BASE_URL;
  return {
    id: 'codex',
    label: 'ChatGPT Codex (subscription)',
    defaultModel: 'gpt-5.5',

    async isAvailable(deps) { return deps.hasCredential(CODEX_CRED_KEY); },
    unavailableReason() {
      return 'No Codex OAuth credential — connect ChatGPT via the device-code flow.';
    },
    listModels: () => MODELS,

    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const customFetch = asFetchFunction(async (input, init) => {
        const urlStr = typeof input === 'string' ? input
                      : input instanceof URL ? input.toString()
                      : (input as Request).url;
        const t0 = Date.now();
        const auth = await deps.getAuth(CODEX_CRED_KEY);
        if (!auth) {
          console.error(`[codex] no credentials for ${modelId} — refusing to call ${urlStr}`);
          return new Response(
            JSON.stringify({ error: 'Codex credentials not configured. Connect ChatGPT in /user/settings.' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const send = async (headers: Record<string, string>) => {
          const merged = new Headers(init?.headers);
          for (const [k, v] of Object.entries(headers)) merged.set(k, v);
          return baseFetch(input, { ...init, headers: merged });
        };
        let res = await send(auth.headers);
        const dt = Date.now() - t0;
        console.log(`[codex] ${(init?.method ?? 'POST')} ${urlStr.replace(/^https?:\/\//, '')} → ${res.status} (${dt}ms)`);
        if (res.status === 401) {
          console.warn(`[codex] 401 from upstream; attempting forceRefresh`);
          const refreshed = await deps.getAuth(CODEX_CRED_KEY, { forceRefresh: true });
          if (refreshed) {
            res = await send(refreshed.headers);
            console.log(`[codex] retry-after-refresh → ${res.status}`);
          }
        }
        if (!res.ok) {
          // Capture upstream error body for diagnostics + WAF detection.
          let body = '';
          try {
            const cloned = res.clone();
            body = await cloned.text();
            console.error(`[codex] upstream ${res.status} body (first 500 chars): ${body.slice(0, 500)}`);
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
            console.error(`[codex] WAF detected — returning structured error to AI SDK`);
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
