// The credential-key allowlist for model inference. This half of the module
// stays adapter-side because the key list names `lib/cloudflare-oauth.ts`'s
// constants; the header mapping itself lives in core
// (`credentials/headers.ts`).
import { CODEX_CRED_KEY } from '@kinu.run/core';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY } from '@kinu.run/core';

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

export function isModelInferenceCredentialKey(key: string): boolean {
  return MODEL_CREDENTIAL_KEYS.includes(key) || MODEL_CREDENTIAL_KEY_RE.test(key);
}
