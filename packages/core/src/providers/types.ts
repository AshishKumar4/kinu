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

/**
 * What one model charges, in USD per 1M tokens — the models.dev `cost` block
 * verbatim (its own units, so nothing is rescaled on the way in and a reader
 * can check a number against the catalog page).
 *
 * `cacheRead`/`cacheWrite` are absent for providers with no prompt cache.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelInfo {
  id: string;
  label?: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
  /** Per-1M-token USD rates, when the catalog publishes them. Absent means
   *  unknown — never zero (a free model is `input: 0`). */
  cost?: ModelPricing;
  /** Input modalities the model itself accepts (models.dev vocabulary).
   *  Absent when the catalog doesn't know — consumers fall back to a
   *  conservative provider-class default (attachment-sanitizer.ts). */
  inputModalities?: ModelInputModality[];
}

/** The input-modality vocabulary (models.dev `modalities.input`). Feeds the
 *  attachment sanitizer's capability policy; a runtime const so catalog
 *  responses can be narrowed without casts. */
export const MODEL_INPUT_MODALITIES = ['text', 'image', 'pdf', 'audio', 'video'] as const;
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

/** The one capability vocabulary — provider catalogs populate it, prompt
 *  shaping (prompting/model-profile.ts) consumes it. A runtime const so
 *  trust boundaries (HTTP model menus) can narrow without casts. */
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
  /** Enumerate stored credential keys (no secret material). Lets the dynamic
   *  catalog source discover connected providers in one call instead of
   *  probing hasCredential per catalog entry. Optional — without it the
   *  dynamic source lists nothing (resolution still works). */
  listCredentialKeys?: () => Promise<string[]>;
  fetch?: typeof fetch;
}

export interface ModelProvider {
  readonly id: string;
  readonly label?: string;
  readonly defaultModel?: string;
  /** This vendor's small, cheap tier — what the MECHANICAL work runs on
   *  (outcome classification, pathology labels, short reflections, pattern
   *  extraction, sleep-time compression: schema-constrained jobs where the
   *  flagship buys nothing). Same vendor and same credential as the chat
   *  model, so it introduces no new provider path — only a cheaper tier of the
   *  one already connected. Omitted where the vendor has no meaningfully
   *  smaller tier, or where the id set is user-supplied (openai-compat) or an
   *  entire catalog (openrouter) and naming one would be arbitrary; the chat
   *  model is then used, exactly as before. */
  readonly fastModel?: string;

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
