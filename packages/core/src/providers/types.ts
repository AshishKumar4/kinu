// Provider abstraction — a plugin that knows how to build a LanguageModel for
// a given model id, given env bindings + per-agent credentials. Credentials
// that can't live in `env` (OAuth tokens, BYO API keys) come through the
// CredentialStore. createModel is SYNCHRONOUS — async work (cred lookup,
// token refresh) happens inside the customFetch wrappers each provider passes
// to the underlying SDK, so model construction never blocks the chat loop.
import type { LanguageModel } from 'ai';
import type { CredentialStore } from '../credentials/store.js';

/** Parsed `<provider>/<modelId>`. */
export interface ModelSpec { provider: string; modelId: string; }

export interface ModelInfo {
  id: string;
  label?: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
}

export type ModelCapability = 'tools' | 'vision' | 'reasoning' | 'json-mode' | 'streaming';

export interface ProviderInfo {
  id: string;
  label?: string;
  available: boolean;
  unavailableReason?: string;
}

/** The fields any provider may read from the Worker env. All optional —
 *  providers narrow at the read site (e.g. `typeof env.AI_GATEWAY_URL === 'string'`).
 *  Structurally compatible with wrangler-generated `Env` types: each field is
 *  typed loosely so the consumer's narrower `Env` (e.g. `AI: Ai`) is assignable. */
export interface ProviderEnv {
  AI?: unknown;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_AUTH?: string;
  OPENAI_API_KEY?: string;
}

export interface ProviderDeps {
  env: ProviderEnv;
  credentials: CredentialStore;
  fetch?: typeof fetch;
}

export interface ModelProvider {
  readonly id: string;
  readonly label?: string;
  readonly defaultModel?: string;

  isAvailable(deps: ProviderDeps): Promise<boolean> | boolean;
  unavailableReason?(deps: ProviderDeps): Promise<string | undefined> | string | undefined;
  listModels(deps: ProviderDeps): Promise<ModelInfo[]> | ModelInfo[];

  /** Build a LanguageModel SYNCHRONOUSLY. Auth/refresh happens in customFetch. */
  createModel(modelId: string, deps: ProviderDeps): LanguageModel;
}

/** Split on the FIRST slash so `@cf/moonshotai/kimi-k2.6` survives intact. */
export function parseModelSpec(spec: string): ModelSpec {
  const s = (spec ?? '').trim();
  if (!s) throw new Error('Empty model spec');
  const i = s.indexOf('/');
  if (i < 1) throw new Error(`Invalid model spec ${JSON.stringify(spec)} — expected "<provider>/<modelId>".`);
  return { provider: s.slice(0, i), modelId: s.slice(i + 1) };
}

export function formatModelSpec(spec: ModelSpec): string {
  return `${spec.provider}/${spec.modelId}`;
}
