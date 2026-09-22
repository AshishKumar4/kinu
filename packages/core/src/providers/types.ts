// Provider abstraction: providers get ready-to-attach headers from a resolver, never raw
// secrets; createModel is sync, with auth resolved inside customFetch.
import type { LanguageModel } from 'ai';
import type { CountableRequest, InputTokenCount } from './input-tokens';
import type { ReasoningEffort } from './reasoning-effort';
import type { JsonObject } from '../utils/json';
import type { Usage } from '../usage';

/** Parsed `<provider>/<modelId>`. */
export interface ModelSpec { provider: string; modelId: string; }

/** USD per 1M tokens, the models.dev `cost` block verbatim. It publishes one cache-write
 *  rate per model, so a 1h-retention write prices at that rate and `priceCall` is a floor. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * How long a provider should keep the prefix a request writes.
 *   none   no breakpoints or cache key at all.
 *   short  the provider's default TTL; sends nothing extra.
 *   long   the extended TTL; costlier writes.
 */
export type CacheRetention = 'none' | 'short' | 'long';

/** The default every caller gets: cache normally, at the provider's own TTL. */
export const DEFAULT_CACHE_RETENTION: CacheRetention = 'short';

export function isCacheRetention(value: string | null): value is CacheRetention {
  return value === 'none' || value === 'short' || value === 'long';
}

export interface ModelInfo {
  id: string;
  label?: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
  /** models.dev `limit.output`: a per-request maximum inside `contextWindow`, not beside it. */
  modelOutputLimit?: number;
  /** Absent means unknown, never zero (a free model is `input: 0`). */
  cost?: ModelPricing;
  /** Absent when the catalog doesn't know; consumers fall back to a provider-class default. */
  inputModalities?: ModelInputModality[];
  /** Levels this model accepts, low to high. Empty: takes none; absent: unknown. */
  reasoningEfforts?: readonly ReasoningEffort[];
}

/** models.dev `modalities.input` vocabulary, as a runtime const for narrowing. */
export const MODEL_INPUT_MODALITIES = ['text', 'image', 'pdf', 'audio', 'video'] as const;

export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

/** The capability vocabulary, as a runtime const so trust boundaries can narrow. */
export const MODEL_CAPABILITIES = [
  'tools',
  'vision',
  'reasoning',
  'json-mode',
  'streaming',
  'structured-outputs',
  'computer-use',
  'prompt-caching',
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export interface ProviderInfo {
  id: string;
  label?: string;
  available: boolean;
  unavailableReason?: string;
}

/** baseURL is set when the endpoint is part of the credential (openai-compat). */
export interface AuthResolution {
  headers: Record<string, string>;
  baseURL?: string;
}

/** Returns null when no credential is configured for `key`. */
export type AuthResolver = (
  key: string,
  opts?: { forceRefresh?: boolean },
) => Promise<AuthResolution | null>;

/** One AI Gateway universal request, as the Workers AI binding accepts it. */
export interface GatewayRunRequest {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
}

/** Structural `env.AI`: the one call a platform-billed transport makes. */
export interface WorkersAIBinding {
  gateway(id: string): {
    run(data: GatewayRunRequest, options?: { signal?: AbortSignal }): Promise<Response>;
  };
}

/** Structurally compatible with wrangler-generated `Env` types. */
export interface ProviderEnv {
  AI?: WorkersAIBinding;
  AI_GATEWAY_URL?: string;
  DEV_USER_EMAIL?: string;
}

/** A provider-imposed wait, emitted as a request is told to sleep. `source`: `header`
 *  (Retry-After), `backoff`, or `cooldown` (a sibling's; no `status`). */
export interface ProviderWaitInfo {
  readonly provider: string;
  readonly modelId?: string;
  /** How long the request will sleep, in ms. */
  readonly waitMs: number;
  /** 1-based refused attempt; 0 for a `cooldown` join. */
  readonly attempt: number;
  readonly status?: number;
  readonly source: 'header' | 'backoff' | 'cooldown';
}

export interface ProviderDeps {
  env: ProviderEnv;
  /** Stable conversation identity for provider routing and prompt caching. */
  sessionAffinity?: string;
  /** Returns auth headers + baseURL for `key`, or null if not configured. */
  getAuth: AuthResolver;
  /** Credential presence check used by isAvailable(). */
  hasCredential: (key: string) => Promise<boolean>;
  /** Stored credential keys; without it the dynamic source lists nothing. */
  listCredentialKeys?: () => Promise<string[]>;
  fetch?: typeof fetch;
  /** Called before each rate-limit sleep, including joined sibling cooldowns. */
  onProviderWait?: (info: ProviderWaitInfo) => void;
}

export interface ModelProvider {
  readonly id: string;
  readonly label?: string;
  readonly defaultModel?: string;
  /** The vendor's cheap tier for mechanical work, same credential; omitted where no
   *  meaningful smaller tier exists. */
  readonly fastModel?: string;

  isAvailable(deps: ProviderDeps): Promise<boolean> | boolean;
  unavailableReason?(deps: ProviderDeps): Promise<string | undefined> | string | undefined;
  listModels(deps: ProviderDeps): Promise<ModelInfo[]> | ModelInfo[];

  /** Synchronous; auth/refresh happens in customFetch. */
  createModel(modelId: string, deps: ProviderDeps): LanguageModel;

  /** Pre-request token count via the provider's documented endpoint; absent means none.
   *  Report `unsupported` rather than drop an unrepresentable part. */
  countInputTokens?(
    modelId: string,
    deps: ProviderDeps,
    request: CountableRequest,
  ): Promise<InputTokenCount>;

  /** Re-send a frozen body with no completion to keep its cache entry alive; only direct
   *  Anthropic implements it. Failure throws. */
  warmCache?(modelId: string, deps: ProviderDeps, body: JsonObject): Promise<Usage>;
}

/** Split on the FIRST slash so slashful ids such as `@cf/deepseek-ai/deepseek-v4-pro-0813` survive intact. */
export function parseModelSpec(spec: string): ModelSpec {
  const s = (spec ?? '').trim();

  if (!s) throw new Error('Empty model spec');
  const i = s.indexOf('/');

  if (i < 1) throw new Error(`Invalid model spec ${JSON.stringify(spec)} — expected "<provider>/<modelId>".`);

  return { provider: s.slice(0, i), modelId: s.slice(i + 1) };
}
