// Credential keys that carry model-inference authority.
import { CODEX_CRED_KEY } from './codex';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY } from './cloudflare-oauth';

/**
 * Credential-key shapes that resolve to a model provider; an allowlist, so other keys do not survive tainting.
 * `cloudflare.oauth` also administers accounts: attach only to provider-pinned endpoints in trusted DO code.
 * `<name>.bearer` matches by shape, so no non-model credential may use that suffix.
 */
const MODEL_CREDENTIAL_KEY_RE = /^([a-z0-9][a-z0-9._-]*\.bearer|openai-compat\..+)$/;

const MODEL_CREDENTIAL_KEYS: readonly string[] = [
  CODEX_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY, CLOUDFLARE_AI_GATEWAY_CRED_KEY,
];

export function isModelInferenceCredentialKey(key: string): boolean {
  return MODEL_CREDENTIAL_KEYS.includes(key) || MODEL_CREDENTIAL_KEY_RE.test(key);
}
