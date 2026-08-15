/**
 * Credential value shapes. The discriminated union below is what gets stored
 * in UserDO's `user_credentials` table (JSON-encoded per row).
 *
 * Providers do NOT consume these directly — they ask the AuthResolver
 * (ProviderDeps.getAuth) for ready-to-attach HTTP headers. Secret material
 * lives inside the implementation that owns the store (UserDO in production,
 * test fixtures in unit tests).
 */

import type { JsonObject } from '../utils/json.js';

/** A stored secret. Discriminated by `kind`. */
export type Credential =
  | BearerCredential
  | OAuthCredential
  | OpenAICompatCredential;

/** Plain bearer-token API key. */
export interface BearerCredential {
  kind: 'bearer';
  token: string;
}

/** OAuth access token. Some providers issue a refresh token, some do not.
 *  `expiresAt` is unix-ms; null if unknown. */
export interface OAuthCredential {
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string;
  /** Unix-ms when the access token expires. May be null/undefined. */
  expiresAt?: number;
  /** Provider-specific metadata (account id, scope, etc.). */
  metadata?: JsonObject;
}

/** OpenAI-compatible BYO config: base URL + bearer. Covers Groq, Together, … */
export interface OpenAICompatCredential {
  kind: 'openai-compat';
  baseURL: string;
  apiKey: string;
  /** Extra headers to merge (some providers want `HTTP-Referer`, `X-Title`, etc.). */
  extraHeaders?: Record<string, string>;
}
