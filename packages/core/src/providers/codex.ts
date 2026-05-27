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
        const auth = await deps.getAuth(CODEX_CRED_KEY);
        if (!auth) {
          return new Response(
            JSON.stringify({ error: 'Codex credentials not configured' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const send = async (headers: Record<string, string>) => {
          const merged = new Headers(init?.headers);
          for (const [k, v] of Object.entries(headers)) merged.set(k, v);
          return baseFetch(input, { ...init, headers: merged });
        };
        let res = await send(auth.headers);
        if (res.status === 401) {
          const refreshed = await deps.getAuth(CODEX_CRED_KEY, { forceRefresh: true });
          if (refreshed) res = await send(refreshed.headers);
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
