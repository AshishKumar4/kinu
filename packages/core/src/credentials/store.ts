/**
 * CredentialStore — per-agent secret KV.
 *
 * Used by providers to fetch credentials that can't live in environment
 * bindings: OAuth tokens (Codex/ChatGPT), user-configured API keys (OpenRouter,
 * Anthropic, OpenAI), custom base URLs.
 *
 * The store is intentionally narrow: get/set/delete of a small record per key.
 * No querying, no listing of values — just key-addressed lookup.
 *
 * cf-backend implements this over Durable Object SQL (one row per agent + key).
 */

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

/** OAuth tokens with refresh. `expiresAt` is unix-ms; null if unknown. */
export interface OAuthCredential {
  kind: 'oauth';
  accessToken: string;
  refreshToken: string;
  /** Unix-ms when the access token expires. May be null/undefined. */
  expiresAt?: number;
  /** Provider-specific metadata (account id, scope, etc.). */
  metadata?: Record<string, unknown>;
}

/** OpenAI-compatible BYO config: base URL + bearer. Covers OpenRouter, Together, Groq, … */
export interface OpenAICompatCredential {
  kind: 'openai-compat';
  baseURL: string;
  apiKey: string;
  /** Extra headers to merge (some providers want `HTTP-Referer`, `X-Title`, etc.). */
  extraHeaders?: Record<string, string>;
}

export interface CredentialStore {
  get(key: string): Promise<Credential | null>;
  set(key: string, value: Credential): Promise<void>;
  delete(key: string): Promise<void>;
  /** Read-modify-write under the store's serialization. Used by OAuth refresh
   *  to avoid TOCTOU between read and write. Mutator returning null deletes. */
  update(
    key: string,
    mutate: (current: Credential | null) => Promise<Credential | null> | Credential | null,
  ): Promise<Credential | null>;
}

/**
 * In-memory CredentialStore. Useful for tests and as a fallback when no
 * persistent store is wired (e.g. exploration facets that don't own DO state).
 */
export function createInMemoryCredentialStore(): CredentialStore {
  const map = new Map<string, Credential>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async update(key, mutate) {
      const next = await mutate(map.get(key) ?? null);
      if (next === null || next === undefined) map.delete(key);
      else map.set(key, next);
      return next ?? null;
    },
  };
}
