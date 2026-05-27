// Codex via ChatGPT subscription — OAuth tokens from device-code flow against
// the internal Codex backend (chatgpt.com/backend-api/codex/responses).
//
//   Auth header:  Authorization: Bearer <oauth-access-token>
//   WAF bypass:   originator: codex_cli_rs
//                 User-Agent: codex_cli_rs/... (Proteus)
//                 ChatGPT-Account-ID: <decoded from JWT "chatgpt_account_id">
//
// All token resolution + refresh happens inside `customFetch` — `createModel`
// is sync. customFetch reads the OAuthCredential at request time, refreshes
// if expiring, retries once on 401.
//
// CAVEAT: CF WAF may 403 from non-residential IPs even with originator set.
// Workers egress is CF data-center IPs — runtime probe needed.
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types.js';
import type { CredentialStore, OAuthCredential } from '../credentials/store.js';
import { asFetchFunction } from './fetch-shim.js';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_CRED_KEY = 'codex.oauth';
export const CODEX_USER_AGENT = 'codex_cli_rs/0.0.0 (Proteus Agent)';
export const CODEX_ORIGINATOR = 'codex_cli_rs';

const MODELS: ModelInfo[] = [
  { id: 'gpt-5.5',      label: 'GPT-5.5 (Codex)',      capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'gpt-5',        label: 'GPT-5 (Codex)',        capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'gpt-5-codex',  label: 'GPT-5 Codex',          capabilities: ['tools', 'streaming', 'reasoning'] },
  { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini (Codex)', capabilities: ['tools', 'streaming'] },
];

/** Decode the `chatgpt_account_id` claim from the OAuth JWT, or null. */
export function decodeChatGPTAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const json = JSON.parse(typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf-8'));
    const id = json?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id ? id : null;
  } catch { return null; }
}

/** True if token is within `skewSec` of expiry (or undecodable / no exp). */
export function accessTokenExpiring(accessToken: string, skewSec: number = 60): boolean {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return true;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const json = JSON.parse(typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf-8'));
    const exp = typeof json?.exp === 'number' ? json.exp : null;
    if (exp == null) return false;
    return Date.now() / 1000 + skewSec >= exp;
  } catch { return true; }
}

export type OAuthRefresher = (refreshToken: string) => Promise<{
  accessToken: string; refreshToken: string; expiresAt?: number;
}>;

export interface CodexProviderOptions {
  refresh: OAuthRefresher;
  baseURL?: string;
}

async function ensureFreshToken(
  store: CredentialStore,
  refresh: OAuthRefresher,
  forceRefresh: boolean = false,
): Promise<OAuthCredential | null> {
  const current = await store.get(CODEX_CRED_KEY);
  if (!current || current.kind !== 'oauth') return null;
  if (!forceRefresh && !accessTokenExpiring(current.accessToken)) return current;
  // CRITICAL: if refresh() throws (transient 500, network blip), do NOT
  // wipe the credential. Callers depend on the original refresh_token
  // surviving so a retry can succeed. Return the existing (possibly
  // expiring) credential — the upstream call will 401 and the request-time
  // 401-retry path will attempt one more refresh.
  const updated = await store.update(CODEX_CRED_KEY, async (latest) => {
    const c = latest?.kind === 'oauth' ? latest : current;
    if (!forceRefresh && !accessTokenExpiring(c.accessToken)) return c;
    try {
      const fresh = await refresh(c.refreshToken);
      return {
        kind: 'oauth',
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        metadata: c.metadata,
      };
    } catch (err) {
      console.warn('[codex] refresh failed; keeping current credential:', (err as Error).message);
      return c;
    }
  });
  return updated?.kind === 'oauth' ? updated : null;
}

export function createCodexProvider(opts: CodexProviderOptions): ModelProvider {
  const baseURL = opts.baseURL ?? CODEX_BASE_URL;
  return {
    id: 'codex',
    label: 'ChatGPT Codex (subscription)',
    defaultModel: 'gpt-5.5',

    async isAvailable(deps) {
      const c = await deps.credentials.get(CODEX_CRED_KEY);
      return c?.kind === 'oauth';
    },
    async unavailableReason() {
      return 'No Codex OAuth credential — connect ChatGPT via the device-code flow.';
    },
    listModels: () => MODELS,

    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const customFetch = asFetchFunction(async (input, init) => {
        const send = async (cred: OAuthCredential) => {
          const acct = decodeChatGPTAccountId(cred.accessToken);
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${cred.accessToken}`);
          headers.set('User-Agent', CODEX_USER_AGENT);
          headers.set('originator', CODEX_ORIGINATOR);
          if (acct) headers.set('ChatGPT-Account-ID', acct);
          return baseFetch(input, { ...init, headers });
        };
        let cred = await ensureFreshToken(deps.credentials, opts.refresh);
        if (!cred) {
          return new Response(
            JSON.stringify({ error: 'Codex credentials not configured' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        let res = await send(cred);
        if (res.status === 401) {
          const refreshed = await ensureFreshToken(deps.credentials, opts.refresh, true);
          if (refreshed) { cred = refreshed; res = await send(cred); }
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
