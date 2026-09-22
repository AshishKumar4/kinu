/**
 * Provider-agnostic prompt-cache breakpoints: a closed provider-id → strategy
 * map plus pure marker placement, applied by both backends at message assembly.
 * Workers AI affinity is wired at model construction instead
 * (providers/workers-ai.ts `agentAffinityKey`).
 *
 * Anthropic layout (hermes `system_and_3`, within the 4-breakpoint cap): last
 * tool, end of system prompt, and two rolled onto the message tail every step
 * so each request reads the previous request's prefix.
 */
import type { ModelMessage, SystemModelMessage, ToolSet } from 'ai';
import { DEFAULT_CACHE_RETENTION, type CacheRetention } from '../providers/types';

/** The AI SDK's provider-options bag (not re-exported by `ai` itself). */
type ProviderOptions = NonNullable<ModelMessage['providerOptions']>;

/** Unknown provider ids are `none`. `ttl` is the provider's extended-retention wire value,
 *  present only for `long` so default requests stay byte-identical. */
export type PromptCacheStrategy =
  /** workers-ai uses affinity headers; claude-cli owns its context; unknown providers. */
  | { kind: 'none' }
  | { kind: 'anthropic'; ttl?: '1h' }
  /** Typed `promptCacheKey`, serialized as `prompt_cache_key`. */
  | { kind: 'openai-cache-key'; ttl?: '24h' }
  /** `prompt_cache_key` via the provider's options namespace. `markers` adds `cache_control`
     *  breakpoints through `openaiCompatible` metadata for Claude models (OpenRouter passes them through). */
  | { kind: 'openai-compat'; bodyNamespace: string; markers: boolean; ttl?: '1h' };

/** Anthropic rejects more than 4 `cache_control` blocks: tools, system, and two on the tail. */
export const ANTHROPIC_MAX_BREAKPOINTS = 4;

const TAIL_BREAKPOINTS = ANTHROPIC_MAX_BREAKPOINTS - 2;

/** TTL omitted for the default so wire bytes match a request that never asked. */
function ephemeral(ttl?: '1h'): { type: 'ephemeral'; ttl?: '1h' } {
  return ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
}

/** `anthropic` is parsed into cache_control; `openaiCompatible` is spread verbatim into the wire message. */
function markerNamespace(strategy: PromptCacheStrategy): 'anthropic' | 'openaiCompatible' | null {
  if (strategy.kind === 'anthropic') return 'anthropic';

  if (strategy.kind === 'openai-compat' && strategy.markers) return 'openaiCompatible';

  return null;
}

function markerTtl(strategy: PromptCacheStrategy): '1h' | undefined {
  return strategy.kind === 'anthropic' || strategy.kind === 'openai-compat' ? strategy.ttl : undefined;
}

export function hasCacheMarkers(strategy: PromptCacheStrategy): boolean {
  return markerNamespace(strategy) !== null;
}

const ANTHROPIC_MODEL_ID = /claude|anthropic/i;

/** Closed provider-id → strategy map. `retention: 'none'` is a no-op for every provider:
 * no breakpoints and no cache key. */
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

    case undefined:
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

/** System prompt carrying the end-of-system breakpoint. On CF it rides the per-step
 * `PrepareStepResult.system` override (Think's TurnConfig.system is string-typed). */
export function cacheableSystem(system: string, strategy: PromptCacheStrategy): string | SystemModelMessage {
  const ns = markerNamespace(strategy);

  if (!ns || system.length === 0) return system;

  return { role: 'system', content: system, providerOptions: markerOptions(ns, markerTtl(strategy)) };
}

function withProviderOptions(message: ModelMessage, providerOptions: ProviderOptions | undefined): ModelMessage {
  const next = { ...message };

  if (providerOptions && Object.keys(providerOptions).length > 0) {
    next.providerOptions = providerOptions;
  } else {
    delete next.providerOptions;
  }

  return next;
}

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

/** Strips markers at message and part level (openaiCompatible marks parts). */
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
 * `anthropic`: message level (the SDK applies it to the last content block).
 * `openaiCompatible`: last content part for user/tool messages (the only place the
 * SDK reads metadata for them), message level for system/assistant.
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
 * Strip stale markers (they count against the 4-block cap), then mark the last
 * TAIL_BREAKPOINTS non-system messages. Pure: durable history is never mutated,
 * so markers never leak into persisted transcripts. Applied per step.
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

/** Request-level options routing the cache by a stable per-conversation key. */
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
  providerId?: string;
  modelId?: string;
  system: string;
  sessionKey: string;
  /** Default `short`. */
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

/** {@link promptCachePlan} plus the marked tail, for `runChat`. Think marks per step in
 *  `composePrepareStep` and calls `promptCachePlan` directly. */
export function applyCacheBreakpoints(input: CacheBreakpointInput): CacheBreakpointPlan {
  const plan = promptCachePlan(input);

  return { ...plan, messages: markCacheTail(input.messages, plan.strategy) };
}

/**
 * Mark the last tool with an Anthropic ephemeral breakpoint; tools precede
 * system+messages in Anthropic's prefix order. Inert for other providers, so set
 * unconditionally at tool-build time. Mutates in place. `none` leaves tools unmarked.
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
