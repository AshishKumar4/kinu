// Convert a stored Credential into the HTTP headers a provider needs to
// inject. The mapping lives here (UserDO-side) so secret material never
// leaves the UserDO — the orchestrator only sees ready-to-attach headers.
//
// Codex OAuth: WAF-bypass headers (originator, User-Agent) + ChatGPT
// account id derived from JWT + Bearer access token.
// Bearer: simple Authorization header.
// OpenAI-compat: Bearer + the user's extraHeaders (HTTP-Referer, X-Title, etc.).
import type { Credential } from '@proteus/core';

const CODEX_USER_AGENT = 'codex_cli_rs/0.0.0 (Proteus Agent)';
const CODEX_ORIGINATOR = 'codex_cli_rs';

function decodeChatGPTAccountId(accessToken: string): string | null {
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

/** Header bundle for a given credential. The credential key tells us which
 *  flavor of headers to emit (codex.oauth = WAF-bypass set; openai/anthropic
 *  = Bearer; openrouter = Bearer + extras; openai-compat = Bearer + extras). */
export function credentialToHeaders(key: string, cred: Credential): Record<string, string> {
  if (key === 'codex.oauth') {
    if (cred.kind !== 'oauth') throw new Error('codex.oauth credential must be oauth kind');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.accessToken}`,
      'User-Agent': CODEX_USER_AGENT,
      originator: CODEX_ORIGINATOR,
    };
    const acct = decodeChatGPTAccountId(cred.accessToken);
    if (acct) headers['ChatGPT-Account-ID'] = acct;
    return headers;
  }
  if (key === 'anthropic.bearer') {
    if (cred.kind !== 'bearer') throw new Error('anthropic.bearer credential must be bearer kind');
    return {
      'x-api-key': cred.token,
      'anthropic-version': '2023-06-01',
    };
  }
  // openai.bearer, openrouter.bearer, generic bearer → Authorization header.
  if (cred.kind === 'bearer') {
    return { Authorization: `Bearer ${cred.token}` };
  }
  // openai-compat: Bearer + extraHeaders, baseURL is handled at provider construction.
  if (cred.kind === 'openai-compat') {
    return { Authorization: `Bearer ${cred.apiKey}`, ...(cred.extraHeaders ?? {}) };
  }
  // OAuth without a special header bundle — just Bearer the access token.
  if (cred.kind === 'oauth') {
    return { Authorization: `Bearer ${cred.accessToken}` };
  }
  throw new Error(`unhandled credential kind for key=${key}`);
}

/** Whether the credential is OAuth and the access token is within `skewSec`
 *  of expiry (or undecodable / no exp). Used by UserDO to decide whether to
 *  refresh before returning headers. */
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
