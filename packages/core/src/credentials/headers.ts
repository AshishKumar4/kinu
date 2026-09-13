// Convert a stored Credential into the HTTP headers a provider needs to
// inject. The mapping lives at the credential store so secret material never
// leaves it — a caller only sees ready-to-attach headers.
//
// Codex OAuth: WAF-bypass headers (originator, User-Agent) + ChatGPT
// account id derived from JWT + Bearer access token.
// Bearer: simple Authorization header.
// OpenAI-compat: Bearer + the user's extraHeaders (HTTP-Referer, X-Title, etc.).
import { codexCredentialToHeaders } from '../providers/codex-oauth';
import type { Credential } from './store';

export interface CredentialHeaders {
  [name: string]: string;
}

/** Header bundle for a given credential. The credential key tells us which
 *  flavor of headers to emit (codex.oauth = WAF-bypass set; openai/anthropic
 *  = Bearer; openrouter = Bearer + extras; openai-compat = Bearer + extras). */
export function credentialToHeaders(key: string, cred: Credential): CredentialHeaders {
  if (key === 'codex.oauth') {
    if (cred.kind !== 'oauth') throw new Error('codex.oauth credential must be oauth kind');

    return codexCredentialToHeaders(cred);
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
    return { Authorization: `Bearer ${cred.apiKey}`, ...cred.extraHeaders };
  }

  // OAuth without a special header bundle — just Bearer the access token.
  if (cred.kind === 'oauth') {
    return { Authorization: `Bearer ${cred.accessToken}` };
  }

  throw new Error(`unhandled credential kind for key=${key}`);
}
