/**
 * Provider-agnostic prompt-cache breakpoints.
 *
 * The system prompt + conversation history dominate per-turn input cost, and
 * every provider that can cache them addresses its cache differently:
 * Anthropic wants explicit `cache_control` breakpoints inside the request,
 * OpenAI-family endpoints route by a stable `prompt_cache_key`, and Workers AI
 * pins its default-on prefix cache with the `x-session-affinity` header
 * (wired where the model is constructed — see providers/workers-ai.ts
 * `agentAffinityKey`). This module is the single source for the first two:
 * a closed provider-id → strategy map plus pure marker-placement functions
 * both backends apply at their message-assembly seam (CF: beforeTurn +
 * beforeStep; CLI: runChat).
 *
 * Anthropic placement (hermes prompt_caching.py's `system_and_3` layout,
 * budgeted to the API's 4-breakpoint maximum): 1 on the last tool (caches the
 * whole stable tool surface — tools precede system+messages in Anthropic's
 * prefix order), 1 at the end of the system prompt, and 2 rolled onto the
 * message tail on EVERY step, so each request of an agentic loop reads the
 * previous request's prefix instead of re-prefilling it.
 *
 * Reads back as `Usage.cacheRead` — normalized at the provider seam and summed
 * per turn by orchestrator/turn-accumulator.ts (the `cacheRead=` figure in the
 * step_finish activity line).
 *
 * How LONG a written prefix is kept is the caller's call ({@link CacheRetention}),
 * not a constant: an agent that works in bursts minutes apart re-prefills every
 * turn under the providers' default 5-minute TTL, while an agent that never
 * idles pays the extended-TTL write premium for nothing.
 */
import type { ModelMessage, SystemModelMessage, ToolSet } from 'ai';

/** The AI SDK's provider-options bag (not re-exported by `ai` itself). */
type ProviderOptions = NonNullable<ModelMessage['providerOptions']>;

/**
 * How long a provider should keep the prefix this turn writes.
 *
 *   none   don't address the provider's cache at all — no breakpoints, no
 *          cache key. The escape hatch for a turn that must not write a cache
 *          entry (and not pay a cache-write premium for one read).
 *   short  the provider's default TTL (Anthropic/OpenRouter 5m, OpenAI
 *          in-memory). Sends nothing extra, so the request bytes are exactly
 *          what a caller with no opinion produced.
 *   long   the extended TTL — Anthropic `ttl: '1h'`, OpenAI
 *          `prompt_cache_retention: '24h'`. Costs more per cache WRITE and
 *          pays for itself only when turns are minutes-to-hours apart.
 */
export type CacheRetention = 'none' | 'short' | 'long';

/** The default every caller gets: cache normally, at the provider's own TTL. */
export const DEFAULT_CACHE_RETENTION: CacheRetention = 'short';

export function isCacheRetention(value: string | null): value is CacheRetention {
  return value === 'none' || value === 'short' || value === 'long';
}

/** How a provider's prompt cache is addressed. Closed union — every provider
 *  id the registries can resolve maps to exactly one entry; unknown ids are
 *  `none` (providers with no request-level cache concept are a no-op).
 *
 *  `ttl` carries the provider's OWN extended-retention wire value and is
 *  present only for `long` — the short default omits it, so its requests stay
 *  byte-identical to a caller that never asked. */
export type PromptCacheStrategy =
  /** No request-level cache concept (workers-ai rides x-session-affinity
   *  headers; claude-cli's binary owns its own context; unknown providers). */
  | { kind: 'none' }
  /** @ai-sdk/anthropic native breakpoints via providerOptions.anthropic. */
  | { kind: 'anthropic'; ttl?: '1h' }
  /** @ai-sdk/openai (openai + codex): providerOptions.openai.promptCacheKey —
   *  the SDK's typed param, serialized as `prompt_cache_key`. */
  | { kind: 'openai-cache-key'; ttl?: '24h' }
  /** @ai-sdk/openai-compatible endpoint: `prompt_cache_key` spread into the
   *  request body through the provider's own options namespace. `markers`
   *  additionally places Anthropic-style `cache_control` breakpoints through
   *  the SDK's fixed `openaiCompatible` message metadata — set when the
   *  underlying model is a Claude one (OpenRouter passes them through). */
  | { kind: 'openai-compat'; bodyNamespace: string; markers: boolean; ttl?: '1h' };

/** Anthropic rejects requests with more than 4 `cache_control` blocks. One is
 *  spent on the tool surface (markLastToolForAnthropicCache), one on the
 *  system prompt, and the remaining two roll on the message tail. */
export const ANTHROPIC_MAX_BREAKPOINTS = 4;
const TAIL_BREAKPOINTS = ANTHROPIC_MAX_BREAKPOINTS - 2;

/** One `cache_control` block. The TTL is omitted for the short default so the
 *  wire bytes match a request that never asked about retention. */
function ephemeral(ttl?: '1h'): { type: 'ephemeral'; ttl?: '1h' } {
  return ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
}

/** Where message-level markers ride for a strategy, or null when the strategy
 *  has no marker concept. `anthropic` is parsed by @ai-sdk/anthropic into
 *  cache_control; `openaiCompatible` is spread verbatim into the wire message
 *  by @ai-sdk/openai-compatible. */
function markerNamespace(strategy: PromptCacheStrategy): 'anthropic' | 'openaiCompatible' | null {
  if (strategy.kind === 'anthropic') return 'anthropic';
  if (strategy.kind === 'openai-compat' && strategy.markers) return 'openaiCompatible';
  return null;
}

/** The extended TTL a marker strategy asks for, or undefined at the default. */
function markerTtl(strategy: PromptCacheStrategy): '1h' | undefined {
  return strategy.kind === 'anthropic' || strategy.kind === 'openai-compat' ? strategy.ttl : undefined;
}

/** Whether the strategy places per-message cache markers (and therefore needs
 *  the tail re-rolled each step). */
export function hasCacheMarkers(strategy: PromptCacheStrategy): boolean {
  return markerNamespace(strategy) !== null;
}

/** Model ids that speak Anthropic's cache_control dialect behind an
 *  OpenAI-compatible endpoint (OpenRouter model ids look like
 *  `anthropic/claude-sonnet-4`). */
const ANTHROPIC_MODEL_ID = /claude|anthropic/i;

/**
 * The closed provider-id → cache-strategy map. Provider ids are the registry
 * ids both backends resolve model specs with (core/providers + cf-backend
 * workers-ai/my-gateway/ai-gateway + cli-backend claude-cli).
 *
 * `retention: 'none'` resolves to the no-op strategy for EVERY provider — a
 * turn that opts out writes no breakpoints and routes no cache key, which is
 * the only way to genuinely not touch the provider's cache.
 */
export function resolvePromptCacheStrategy(
  providerId?: string,
  modelId?: string,
  retention: CacheRetention = DEFAULT_CACHE_RETENTION,
): PromptCacheStrategy {
  if (retention === 'none') return { kind: 'none' };
  const long = retention === 'long';
  switch (providerId) {
    case 'anthropic': {
      const strategy: Extract<PromptCacheStrategy, { kind: 'anthropic' }> = { kind: 'anthropic' };
      if (long) strategy.ttl = '1h';
      return strategy;
    }
    case 'openai':
    case 'codex': {
      const strategy: Extract<PromptCacheStrategy, { kind: 'openai-cache-key' }> = { kind: 'openai-cache-key' };
      if (long) strategy.ttl = '24h';
      return strategy;
    }
    case 'openrouter': {
      const markers = ANTHROPIC_MODEL_ID.test(modelId ?? '');
      const strategy: Extract<PromptCacheStrategy, { kind: 'openai-compat' }> = {
        kind: 'openai-compat', bodyNamespace: 'openrouter', markers,
      };
      if (long && markers) strategy.ttl = '1h';
      return strategy;
    }
    case 'my-gateway':
    case 'ai-gateway':
      return { kind: 'openai-compat', bodyNamespace: providerId, markers: false };
    default:
      if (providerId === 'openai-compat' || providerId?.startsWith('openai-compat:')) {
        return { kind: 'openai-compat', bodyNamespace: providerId, markers: false };
      }
      return { kind: 'none' };
  }
}

function markerOptions(ns: 'anthropic' | 'openaiCompatible', ttl?: '1h'): ProviderOptions {
  return ns === 'anthropic'
    ? { anthropic: { cacheControl: ephemeral(ttl) } }
    : { openaiCompatible: { cache_control: ephemeral(ttl) } };
}

/**
 * The system prompt in a cache-eligible position: a SystemModelMessage whose
 * providerOptions carry the end-of-system breakpoint. `streamText`'s `system`
 * accepts this directly; on CF it rides the per-step PrepareStepResult.system
 * override (Think's TurnConfig.system is string-typed). Strategies without
 * markers keep the plain string.
 */
export function cacheableSystem(system: string, strategy: PromptCacheStrategy): string | SystemModelMessage {
  const ns = markerNamespace(strategy);
  if (!ns || system.length === 0) return system;
  return { role: 'system', content: system, providerOptions: markerOptions(ns, markerTtl(strategy)) };
}

/** Replace a message's providerOptions immutably, preserving its role type. */
function withProviderOptions(message: ModelMessage, providerOptions: ProviderOptions | undefined): ModelMessage {
  const next = { ...message };
  if (providerOptions && Object.keys(providerOptions).length > 0) {
    next.providerOptions = providerOptions;
  } else {
    delete next.providerOptions;
  }
  return next;
}

/** Strip this module's cache markers from a providerOptions bag, preserving
 *  every unrelated field. Returns the input when nothing had to change. */
function stripMarkerOptions(po: ProviderOptions | undefined): ProviderOptions | undefined {
  if (!po) return po;
  const anthropic = po.anthropic;
  const compat = po.openaiCompatible;
  const hasAnthropicMarker = anthropic !== undefined && 'cacheControl' in anthropic;
  const hasCompatMarker = compat !== undefined && 'cache_control' in compat;
  if (!hasAnthropicMarker && !hasCompatMarker) return po;

  const next: ProviderOptions = { ...po };
  if (hasAnthropicMarker) {
    const { cacheControl: _drop, ...rest } = anthropic;
    if (Object.keys(rest).length > 0) next.anthropic = rest; else delete next.anthropic;
  }
  if (hasCompatMarker) {
    const { cache_control: _drop, ...rest } = compat;
    if (Object.keys(rest).length > 0) next.openaiCompatible = rest; else delete next.openaiCompatible;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Strip stale cache markers at message level AND content-part level (the
 *  openaiCompatible namespace marks parts — see withCacheMarker). */
function withoutCacheMarker(message: ModelMessage): ModelMessage {
  const strippedPo = stripMarkerOptions(message.providerOptions);
  const poChanged = strippedPo !== message.providerOptions;

  if (message.role === 'user' && Array.isArray(message.content)) {
    let partsChanged = false;
    const parts = message.content.map((part) => {
      const stripped = stripMarkerOptions(part.providerOptions);
      if (stripped === part.providerOptions) return part;
      partsChanged = true;
      return { ...part, providerOptions: stripped };
    });
    if (partsChanged) return { ...message, content: parts, providerOptions: strippedPo };
  }
  if (message.role === 'tool') {
    let partsChanged = false;
    const parts = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const stripped = stripMarkerOptions(part.providerOptions);
      if (stripped === part.providerOptions) return part;
      partsChanged = true;
      return { ...part, providerOptions: stripped };
    });
    if (partsChanged) return { ...message, content: parts, providerOptions: strippedPo };
  }
  if (!poChanged) return message;
  return withProviderOptions(message, strippedPo);
}

function mergeMarker(po: ProviderOptions | undefined, ns: 'anthropic' | 'openaiCompatible', ttl?: '1h'): ProviderOptions {
  const merged: ProviderOptions = { ...po };
  merged[ns] = { ...merged[ns], ...markerOptions(ns, ttl)[ns] };
  return merged;
}

/**
 * Place one cache marker on a message, per namespace convention:
 * - `anthropic`: message level — @ai-sdk/anthropic applies it to the last
 *   content block for every role (user / assistant / tool result / system).
 * - `openaiCompatible`: where the SDK actually reads metadata for the role —
 *   the LAST content part for user and tool messages (single-text user
 *   messages collapse back to string content on the wire with the part's
 *   metadata spread, and tool results only read part metadata), message level
 *   for system/assistant (spread verbatim into the wire message).
 */
function withCacheMarker(message: ModelMessage, ns: 'anthropic' | 'openaiCompatible', ttl?: '1h'): ModelMessage {
  if (ns === 'openaiCompatible' && message.role === 'user') {
    const parts = Array.isArray(message.content)
      ? [...message.content]
      : [{ type: 'text' as const, text: message.content }];
    const last = parts[parts.length - 1];
    if (last !== undefined) {
      parts[parts.length - 1] = { ...last, providerOptions: mergeMarker(last.providerOptions, ns, ttl) };
      return { ...message, content: parts };
    }
  }
  if (ns === 'openaiCompatible' && message.role === 'tool') {
    const parts = [...message.content];
    const last = parts[parts.length - 1];
    if (last !== undefined && last.type === 'tool-result') {
      parts[parts.length - 1] = { ...last, providerOptions: mergeMarker(last.providerOptions, ns, ttl) };
      return { ...message, content: parts };
    }
  }
  return withProviderOptions(message, mergeMarker(message.providerOptions, ns, ttl));
}

/**
 * Roll the cache breakpoints onto the message tail: strip every stale marker
 * (a moved breakpoint must not keep counting against Anthropic's 4-block
 * budget), then mark the last TAIL_BREAKPOINTS non-system messages. Pure —
 * returns a new array with copied messages; inputs (durable history) are
 * never mutated, so markers can never leak into persisted transcripts.
 *
 * Applied per STEP (CF beforeStep / runChat prepareStep): each request of the
 * agentic loop then reads the prefix the previous step wrote instead of
 * re-prefilling the growing tool-call tail.
 */
export function markCacheTail(messages: ReadonlyArray<ModelMessage>, strategy: PromptCacheStrategy): ModelMessage[] {
  const ns = markerNamespace(strategy);
  if (!ns) return [...messages];
  const ttl = markerTtl(strategy);
  const next = messages.map(withoutCacheMarker);
  let remaining = TAIL_BREAKPOINTS;
  for (let i = next.length - 1; i >= 0 && remaining > 0; i--) {
    if (next[i].role === 'system') continue;
    next[i] = withCacheMarker(next[i], ns, ttl);
    remaining--;
  }
  return next;
}

/**
 * Request-level providerOptions that route the provider's cache by a stable
 * per-conversation key (CF: the agent's affinity key; CLI: agent + session).
 * OpenAI parses promptCacheKey into `prompt_cache_key`; openai-compatible
 * providers spread their own namespace verbatim into the request body.
 */
export function promptCacheOptions(strategy: PromptCacheStrategy, sessionKey: string): ProviderOptions | undefined {
  if (!sessionKey) return undefined;
  switch (strategy.kind) {
    case 'openai-cache-key':
      {
        const openai: NonNullable<ProviderOptions['openai']> = { promptCacheKey: sessionKey };
        if (strategy.ttl !== undefined) openai.promptCacheRetention = strategy.ttl;
        return { openai };
      }
    case 'openai-compat':
      return { [strategy.bodyNamespace]: { prompt_cache_key: sessionKey } };
    case 'anthropic':
    case 'none':
      return undefined;
  }
}

export interface PromptCachePlanInput {
  /** Registry provider id the model spec resolved through. */
  providerId?: string;
  modelId?: string;
  system: string;
  /** Stable per-conversation cache key. */
  sessionKey: string;
  /** How long the provider should keep this turn's prefix. Default `short`. */
  retention?: CacheRetention;
}

export interface PromptCachePlan {
  strategy: PromptCacheStrategy;
  system: string | SystemModelMessage;
  providerOptions?: ProviderOptions;
}

export interface CacheBreakpointInput extends PromptCachePlanInput {
  messages: ReadonlyArray<ModelMessage>;
}

export interface CacheBreakpointPlan extends PromptCachePlan {
  messages: ModelMessage[];
}

/**
 * The turn-level half of prompt caching: which strategy this model gets, the
 * system prompt in a cache-eligible position, and the request-level routing
 * key. Every loop needs all three regardless of its shape, so this is the one
 * place they are derived — the message tail is the part that differs, because
 * where a loop can put its messages depends on the loop.
 */
export function promptCachePlan(input: PromptCachePlanInput): PromptCachePlan {
  const strategy = resolvePromptCacheStrategy(input.providerId, input.modelId, input.retention);
  const plan: PromptCachePlan = {
    strategy,
    system: cacheableSystem(input.system, strategy),
  };
  const providerOptions = promptCacheOptions(strategy, input.sessionKey);
  if (providerOptions !== undefined) plan.providerOptions = providerOptions;
  return plan;
}

/** {@link promptCachePlan} plus the marked message tail, for a loop that hands
 *  its messages to the SDK at turn assembly (`runChat`). A driver whose turn
 *  channel cannot carry them — Think's string-typed `TurnConfig.system`, whose
 *  messages get their markers per step in `composePrepareStep` — calls
 *  `promptCachePlan` directly rather than pay for a marking pass it discards.
 *  `none` strategies pass everything through untouched. */
export function applyCacheBreakpoints(input: CacheBreakpointInput): CacheBreakpointPlan {
  const plan = promptCachePlan(input);
  return { ...plan, messages: markCacheTail(input.messages, plan.strategy) };
}

/**
 * Mark the last tool in the set with an Anthropic ephemeral cache breakpoint.
 * Tools precede system+messages in Anthropic's prefix order, so one breakpoint
 * on the LAST tool caches the entire (large, stable) tool surface. Namespaced
 * under providerOptions.anthropic → inert for every other provider, so callers
 * set it unconditionally at tool-build time (the tool set is cached by craft
 * state, not by model). Mutates in place — the caller's tool set is rebuilt
 * only on craft changes.
 *
 * `retention` is the agent's, not the model's: the tool set is assembled before
 * a spec is resolved. `none` leaves the tools unmarked.
 */
export function markLastToolForAnthropicCache(
  tools: ToolSet,
  retention: CacheRetention = DEFAULT_CACHE_RETENTION,
): void {
  if (retention === 'none') return;
  const keys = Object.keys(tools);
  const key = keys.at(-1);
  if (key === undefined) return;
  const last = tools[key];
  if (last === undefined) return;
  last.providerOptions = {
    ...last.providerOptions,
    anthropic: { cacheControl: ephemeral(retention === 'long' ? '1h' : undefined) },
  };
}
