// Provider abstraction — a plugin that knows how to build a LanguageModel for
// a given model id, given env bindings + an auth resolver. Credentials never
// pass through this layer in raw form: providers ask the resolver for
// ready-to-attach HTTP headers (and a baseURL where relevant). All secret
// material stays inside the implementation that owns it (UserDO in production,
// stub callbacks in tests).
//
// createModel is SYNCHRONOUS — async work (auth resolution, token refresh)
// happens inside the customFetch wrappers each provider passes to the
// underlying SDK, so model construction never blocks the chat loop.
import type { LanguageModel } from 'ai';

/** Parsed `<provider>/<modelId>`. */
export interface ModelSpec { provider: string; modelId: string; }

export interface ModelInfo {
  id: string;
  label?: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
}

/** The one capability vocabulary — provider catalogs populate it, prompt
 *  shaping (prompting/model-profile.ts) consumes it. */
export type ModelCapability =
  | 'tools'
  | 'vision'
  | 'reasoning'
  | 'json-mode'
  | 'streaming'
  | 'structured-outputs'
  | 'computer-use'
  | 'prompt-caching';

export interface ProviderInfo {
  id: string;
  label?: string;
  available: boolean;
  unavailableReason?: string;
}

/** Resolved auth for one credential key. Headers are ready to inject into
 *  a fetch; baseURL is set for providers whose endpoint is part of the
 *  credential (openai-compat). */
export interface AuthResolution {
  headers: Record<string, string>;
  baseURL?: string;
}

/** Auth resolver. Implementations: UserDO stub in production, test fixtures
 *  in unit tests. Returns null when no credential is configured for `key`. */
export type AuthResolver = (
  key: string,
  opts?: { forceRefresh?: boolean },
) => Promise<AuthResolution | null>;

/** The fields any provider may read from the Worker env. All optional —
 *  providers narrow at the read site. Structurally compatible with
 *  wrangler-generated `Env` types. */
export interface ProviderEnv {
  AI?: unknown;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_AUTH?: string;
}

export interface ProviderDeps {
  env: ProviderEnv;
  /** Returns auth headers + baseURL for `key`, or null if not configured. */
  getAuth: AuthResolver;
  /** Synchronous-friendly "is there a credential for this key" check used by
   *  isAvailable(). Implementations can be cached for cheap repeated reads. */
  hasCredential: (key: string) => Promise<boolean>;
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
