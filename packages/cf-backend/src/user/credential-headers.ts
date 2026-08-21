// Convert a stored Credential into the HTTP headers a provider needs to
// inject. The mapping lives here (UserDO-side) so secret material never
// leaves the UserDO — the orchestrator only sees ready-to-attach headers.
//
// Codex OAuth: WAF-bypass headers (originator, User-Agent) + ChatGPT
// account id derived from JWT + Bearer access token.
// Bearer: simple Authorization header.
// OpenAI-compat: Bearer + the user's extraHeaders (HTTP-Referer, X-Title, etc.).
import {
  CODEX_CRED_KEY,
  codexAccessTokenExpiring,
  codexCredentialToHeaders,
  type Credential,
} from '@kinu.run/core';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY } from '../lib/cloudflare-oauth';

/** The credential-key shapes that resolve to a model provider — the same set
 *  `listConnectedProviders` derives the model picker from: the two OAuth
 *  logins, the Cloudflare AI Gateway view of one of them, BYO `<provider>.bearer`
 *  keys, and user-named `openai-compat.<name>` endpoints.
 *
 *  This is an allowlist on purpose. Model inference survives workspace
 *  tainting; anything else in the credential store (`github`, future admin
 *  keys) must not, so an unrecognized key shape is treated as non-model.
 *
 *  Two constraints ride on this list, and a new entry must respect both.
 *  `cloudflare.oauth` authorizes more than inference — it is the same bearer
 *  the AI Gateway management API takes — so account administration is kept
 *  behind `ai_gateway.admin` at `full`, and these headers must only ever be
 *  attached to a provider-pinned endpoint inside trusted Durable Object code,
 *  never to a fetch target the agent chooses. And `<name>.bearer` matches by
 *  SHAPE: a future non-model credential must not be stored under that suffix,
 *  or it would silently inherit model-tier reach. */
const MODEL_CREDENTIAL_KEY_RE = /^([a-z0-9][a-z0-9._-]*\.bearer|openai-compat\..+)$/;
const MODEL_CREDENTIAL_KEYS: readonly string[] = [
  CODEX_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY, CLOUDFLARE_AI_GATEWAY_CRED_KEY,
];

export interface CredentialHeaders {
  [name: string]: string;
}

export function isModelInferenceCredentialKey(key: string): boolean {
  return MODEL_CREDENTIAL_KEYS.includes(key) || MODEL_CREDENTIAL_KEY_RE.test(key);
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

/** Whether the credential is OAuth and the access token is within `skewSec`
 *  of expiry (or undecodable / no exp). Used by UserDO to decide whether to
 *  refresh before returning headers. */
export const accessTokenExpiring = codexAccessTokenExpiring;
