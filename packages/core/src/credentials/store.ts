/** Stored in UserDO `user_credentials`; providers get headers via the AuthResolver, never these values. */

import type { JsonObject } from '../utils/json';

export type Credential =
  | BearerCredential
  | OAuthCredential
  | OpenAICompatCredential;

export interface BearerCredential {
  kind: 'bearer';
  token: string;
}

/** Refresh token is provider-dependent. */
export interface OAuthCredential {
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string;
  /** Unix-ms when the access token expires. Undefined if unknown. */
  expiresAt?: number;
  metadata?: JsonObject;
}

/** Covers Groq, Together, … */
export interface OpenAICompatCredential {
  kind: 'openai-compat';
  baseURL: string;
  apiKey: string;
  /** Extra headers to merge (some providers want `HTTP-Referer`, `X-Title`, etc.). */
  extraHeaders?: Record<string, string>;
}
