/**
 * Anthropic prompt-caching for the tool surface.
 *
 * Anthropic caches a request prefix in the order tools → system → messages. One
 * `cache_control` breakpoint on the LAST tool therefore caches the ENTIRE (large,
 * stable) tool surface, which is re-billed in full on every turn otherwise. The
 * breakpoint is namespaced under `providerOptions.anthropic`, so it is inert for
 * Workers AI / OpenAI / etc. (each provider reads only its own namespace) — which
 * lets us set it unconditionally without knowing the resolved provider at
 * tool-build time (the tool set is cached by craft state, not by model).
 *
 * Reads back via response.providerMetadata.anthropic.cacheReadInputTokens.
 */
import type { ToolSet } from 'ai';

/** Mark the last tool in the set with an Anthropic ephemeral cache breakpoint.
 *  Mutates in place (the caller's tool set is rebuilt only on craft changes). */
export function markLastToolForAnthropicCache(tools: ToolSet): void {
  const keys = Object.keys(tools);
  if (keys.length === 0) return;
  const last = tools[keys[keys.length - 1]] as { providerOptions?: Record<string, unknown> };
  last.providerOptions = {
    ...last.providerOptions,
    anthropic: { cacheControl: { type: 'ephemeral' } },
  };
}
