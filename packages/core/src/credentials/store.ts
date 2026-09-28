/** Stored in UserDO `user_credentials`; providers get headers via the AuthResolver, never these values. */

import type { JsonObject } from '../utils/json';

export type Credential =
  | BearerCredential
  | OAuthCredential
  | OpenAICompatCredential;

export interface BearerCredential {
  kind: 'bearer';
  token: string;
  /** Sent here instead of the provider's own endpoint (a proxy). */
  baseURL?: string;
}

export interface OAuthCredential {
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string;
  /** Unix-ms when the access token expires. */
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
