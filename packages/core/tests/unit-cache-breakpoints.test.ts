// Prompt-cache breakpoints — the pure provider-agnostic layer both backends
// apply at their message-assembly seam (prompting/cache-breakpoints.ts).
import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import * as v from 'valibot';
import {
  applyCacheBreakpoints,
  cacheableSystem,
  hasCacheMarkers,
  markCacheTail,
  markLastToolForAnthropicCache,
  promptCacheOptions,
  promptCachePlan,
  resolvePromptCacheStrategy,
  type PromptCacheStrategy,
  ANTHROPIC_MAX_BREAKPOINTS,
  JsonObjectSchema,
  type JsonObject,
} from '../src/index';

const EPHEMERAL = { type: 'ephemeral' };
const ProviderOptionsCarrierSchema = v.object({
  providerOptions: v.optional(JsonObjectSchema),
});
const MessagePartsSchema = v.array(v.object({
  providerOptions: v.optional(JsonObjectSchema),
}));

function providerOptions(input: { value: unknown }): JsonObject | undefined {
  return v.parse(ProviderOptionsCarrierSchema, input.value).providerOptions;
}

function messageParts(message: ModelMessage): Array<{ providerOptions?: JsonObject }> {
  return v.parse(MessagePartsSchema, message.content);
}

function cacheTool(description: string) {
  return tool({
    description,
    inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: async () => ({}),
  });
}

function history(n: number): ModelMessage[] {
  return Array.from({ length: n }, (_, i): ModelMessage =>
    i % 2 === 0 ? { role: 'user', content: `u${i}` } : { role: 'assistant', content: `a${i}` });
}

function anthropicMarkerCount(messages: ReadonlyArray<ModelMessage>): number {
  return messages.filter((m) => {
    const ns = m.providerOptions?.anthropic;
    return ns !== undefined && 'cacheControl' in ns;
  }).length;
}

describe('resolvePromptCacheStrategy', () => {
  test('closed provider map', () => {
    expect(resolvePromptCacheStrategy('anthropic')).toEqual({ kind: 'anthropic' });
    expect(resolvePromptCacheStrategy('openai', 'gpt-5.5')).toEqual({ kind: 'openai-cache-key' });
    expect(resolvePromptCacheStrategy('codex', 'gpt-5.5')).toEqual({ kind: 'openai-cache-key' });
    expect(resolvePromptCacheStrategy('openai-compat')).toEqual({ kind: 'openai-compat', bodyNamespace: 'openai-compat', markers: false });
    expect(resolvePromptCacheStrategy('openai-compat:groq', 'llama-4')).toEqual({ kind: 'openai-compat', bodyNamespace: 'openai-compat:groq', markers: false });
    expect(resolvePromptCacheStrategy('my-gateway', 'openai/gpt-5.5')).toEqual({ kind: 'openai-compat', bodyNamespace: 'my-gateway', markers: false });
    expect(resolvePromptCacheStrategy('ai-gateway', 'workers-ai/@cf/x')).toEqual({ kind: 'openai-compat', bodyNamespace: 'ai-gateway', markers: false });
  });

  test('openrouter gets cache_control markers only for Anthropic models', () => {
    expect(resolvePromptCacheStrategy('openrouter', 'anthropic/claude-sonnet-4.6'))
      .toEqual({ kind: 'openai-compat', bodyNamespace: 'openrouter', markers: true });
    expect(resolvePromptCacheStrategy('openrouter', 'meta-llama/llama-4-maverick'))
      .toEqual({ kind: 'openai-compat', bodyNamespace: 'openrouter', markers: false });
  });

  test('no-cache-concept providers resolve to none', () => {
    // workers-ai rides x-session-affinity headers; claude-cli owns its own context.
    expect(resolvePromptCacheStrategy('workers-ai', '@cf/moonshotai/kimi-k2.6')).toEqual({ kind: 'none' });
    expect(resolvePromptCacheStrategy('claude-cli', 'claude-opus-4-7')).toEqual({ kind: 'none' });
    expect(resolvePromptCacheStrategy('something-new')).toEqual({ kind: 'none' });
    expect(resolvePromptCacheStrategy(undefined)).toEqual({ kind: 'none' });
  });

  test("retention 'long' carries each provider's own extended-TTL wire value", () => {
    expect(resolvePromptCacheStrategy('anthropic', 'claude-opus-4-7', 'long'))
      .toEqual({ kind: 'anthropic', ttl: '1h' });
    expect(resolvePromptCacheStrategy('openai', 'gpt-5.5', 'long'))
      .toEqual({ kind: 'openai-cache-key', ttl: '24h' });
    expect(resolvePromptCacheStrategy('openrouter', 'anthropic/claude-sonnet-4.6', 'long'))
      .toEqual({ kind: 'openai-compat', bodyNamespace: 'openrouter', markers: true, ttl: '1h' });
    // No marker dialect ⇒ no TTL to send; the key-only strategies stay bare.
    expect(resolvePromptCacheStrategy('openrouter', 'meta-llama/llama-4-maverick', 'long'))
      .toEqual({ kind: 'openai-compat', bodyNamespace: 'openrouter', markers: false });
    expect(resolvePromptCacheStrategy('my-gateway', 'openai/gpt-5.5', 'long'))
      .toEqual({ kind: 'openai-compat', bodyNamespace: 'my-gateway', markers: false });
  });

  test("retention 'short' is the default and is byte-identical to no opinion", () => {
    const rows: readonly { provider: string; model: string; expected: PromptCacheStrategy }[] = [
      { provider: 'anthropic', model: 'claude-opus-4-7', expected: { kind: 'anthropic' } },
      { provider: 'openai', model: 'gpt-5.5', expected: { kind: 'openai-cache-key' } },
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', expected: { kind: 'openai-compat', bodyNamespace: 'openrouter', markers: true } },
      { provider: 'my-gateway', model: 'openai/gpt-5.5', expected: { kind: 'openai-compat', bodyNamespace: 'my-gateway', markers: false } },
      { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6', expected: { kind: 'none' } },
    ];
    for (const { provider, model, expected } of rows) {
      // 'short' states the default explicitly, so it reads the same literal.
      expect(resolvePromptCacheStrategy(provider, model, 'short')).toEqual(expected);
      expect(resolvePromptCacheStrategy(provider, model)).toEqual(expected);
    }
  });

  test("retention 'none' opts every provider out of the cache entirely", () => {
    for (const provider of ['anthropic', 'openai', 'codex', 'openrouter', 'my-gateway', 'openai-compat:groq']) {
      expect(resolvePromptCacheStrategy(provider, 'anthropic/claude-sonnet-4.6', 'none'))
        .toEqual({ kind: 'none' });
    }
    // …which means no markers AND no cache key — not just a shorter TTL.
    const off = resolvePromptCacheStrategy('anthropic', 'claude-opus-4-7', 'none');
    expect(hasCacheMarkers(off)).toBe(false);
    expect(promptCacheOptions(off, 'agent-1')).toBeUndefined();
  });
});

describe('cacheableSystem', () => {
  test('anthropic: system becomes a SystemModelMessage carrying the breakpoint', () => {
    const s = cacheableSystem('You are Kinu.', { kind: 'anthropic' });
    expect(s).toEqual({
      role: 'system',
      content: 'You are Kinu.',
      providerOptions: { anthropic: { cacheControl: EPHEMERAL } },
    });
  });

  test('openrouter claude: marker rides the openaiCompatible namespace', () => {
    const s = cacheableSystem('sys', { kind: 'openai-compat', bodyNamespace: 'openrouter', markers: true });
    expect(s).toEqual({
      role: 'system', content: 'sys',
      providerOptions: { openaiCompatible: { cache_control: EPHEMERAL } },
    });
  });

  test('no-marker strategies keep the plain string', () => {
    expect(cacheableSystem('sys', { kind: 'none' })).toBe('sys');
    expect(cacheableSystem('sys', { kind: 'openai-cache-key' })).toBe('sys');
    expect(cacheableSystem('sys', { kind: 'openai-compat', bodyNamespace: 'openai-compat', markers: false })).toBe('sys');
    expect(cacheableSystem('', { kind: 'anthropic' })).toBe('');
  });
});

describe('markCacheTail', () => {
  const anthropic = { kind: 'anthropic' } as const;

  test('marks exactly the last 2 non-system messages', () => {
    const marked = markCacheTail(history(5), anthropic);
    expect(anthropicMarkerCount(marked)).toBe(2);
    expect(marked[3].providerOptions).toEqual({ anthropic: { cacheControl: EPHEMERAL } });
    expect(marked[4].providerOptions).toEqual({ anthropic: { cacheControl: EPHEMERAL } });
    expect(marked[0].providerOptions).toBeUndefined();
  });

  test('pure: the input messages are never mutated (markers cannot leak into durable history)', () => {
    const input = history(4);
    markCacheTail(input, anthropic);
    expect(input.every((m) => m.providerOptions === undefined)).toBe(true);
  });

  test('rolls forward: stale markers deeper in the conversation are stripped', () => {
    // Simulates the per-step re-roll — step N's markers must not accumulate
    // with step N+1's, or the 4-breakpoint budget blows.
    const step1 = markCacheTail(history(4), anthropic);
    const step2 = markCacheTail([...step1, { role: 'assistant', content: 'tool step' }, { role: 'user', content: 'result' }], anthropic);
    expect(anthropicMarkerCount(step2)).toBe(2);
    expect(step2[step2.length - 1].providerOptions).toEqual({ anthropic: { cacheControl: EPHEMERAL } });
    expect(step2[step2.length - 2].providerOptions).toEqual({ anthropic: { cacheControl: EPHEMERAL } });
    expect(step2[2].providerOptions).toBeUndefined();
    expect(step2[3].providerOptions).toBeUndefined();
  });

  test('total anthropic breakpoints (tool + system + tail) stay within the API limit', () => {
    const tools: ToolSet = { a: cacheTool('a'), b: cacheTool('b') };
    markLastToolForAnthropicCache(tools);
    const toolMarkers = Object.values(tools)
      .filter((entry) => providerOptions({ value: entry })?.anthropic).length;
    const system = cacheableSystem('sys', anthropic);
    v.parse(v.object({ role: v.literal('system') }), system);
    const systemMarkers = 1;
    const marked = markCacheTail(history(30), anthropic);
    expect(toolMarkers + systemMarkers + anthropicMarkerCount(marked)).toBe(ANTHROPIC_MAX_BREAKPOINTS);
  });

  test('preserves unrelated providerOptions while stripping/re-marking', () => {
    const input: ModelMessage[] = [
      { role: 'user', content: 'old', providerOptions: { anthropic: { cacheControl: EPHEMERAL, other: 'keep' }, google: { thought: true } } },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'new' },
    ];
    const marked = markCacheTail(input, anthropic);
    expect(marked[0].providerOptions).toEqual({ anthropic: { other: 'keep' }, google: { thought: true } });
    expect(marked[2].providerOptions).toEqual({ anthropic: { cacheControl: EPHEMERAL } });
  });

  test('skips system messages and handles short histories', () => {
    const input: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const marked = markCacheTail(input, anthropic);
    expect(marked[0].providerOptions).toBeUndefined();
    expect(marked[1].providerOptions).toEqual({ anthropic: { cacheControl: EPHEMERAL } });
  });

  test('openaiCompatible namespace: user/tool markers ride the last content part', () => {
    const openrouterClaude = { kind: 'openai-compat', bodyNamespace: 'openrouter', markers: true } as const;
    const input: ModelMessage[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: { type: 'text', value: 'r' } }],
      },
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ];
    const marked = markCacheTail(input, openrouterClaude);
    // The @ai-sdk/openai-compatible converter only reads part metadata for
    // tool results and single-text user messages — markers must sit there.
    const toolParts = messageParts(marked[1]);
    expect(toolParts[0]?.providerOptions)
      .toEqual({ openaiCompatible: { cache_control: EPHEMERAL } });
    const userParts = messageParts(marked[2]);
    expect(userParts[1]?.providerOptions)
      .toEqual({ openaiCompatible: { cache_control: EPHEMERAL } });
    expect(marked[0].providerOptions).toBeUndefined();

    // Rolling strips part-level markers too — re-marking stays at 2 total.
    const rolled = markCacheTail([...marked, { role: 'user', content: 'next' }], openrouterClaude);
    const markerCount = JSON.stringify(rolled).match(/"cache_control"/g)?.length ?? 0;
    expect(markerCount).toBe(2);
    const rolledToolParts = messageParts(rolled[1]);
    expect(rolledToolParts[0]?.providerOptions).toBeUndefined();
  });

  test('no-marker strategies return an untouched copy', () => {
    const input = history(3);
    const out = markCacheTail(input, { kind: 'openai-cache-key' });
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(anthropicMarkerCount(out)).toBe(0);
  });
});

describe('promptCacheOptions', () => {
  test('openai/codex: typed promptCacheKey', () => {
    expect(promptCacheOptions({ kind: 'openai-cache-key' }, 'kinu-a1'))
      .toEqual({ openai: { promptCacheKey: 'kinu-a1' } });
  });

  test('openai-compat family: prompt_cache_key under the provider namespace', () => {
    expect(promptCacheOptions({ kind: 'openai-compat', bodyNamespace: 'openrouter', markers: true }, 'k'))
      .toEqual({ openrouter: { prompt_cache_key: 'k' } });
    expect(promptCacheOptions({ kind: 'openai-compat', bodyNamespace: 'openai-compat:groq', markers: false }, 'k'))
      .toEqual({ 'openai-compat:groq': { prompt_cache_key: 'k' } });
  });

  test('anthropic + none: undefined (breakpoints/affinity do the routing)', () => {
    expect(promptCacheOptions({ kind: 'anthropic' }, 'k')).toBeUndefined();
    expect(promptCacheOptions({ kind: 'none' }, 'k')).toBeUndefined();
    expect(promptCacheOptions({ kind: 'openai-cache-key' }, '')).toBeUndefined();
  });
});

describe('applyCacheBreakpoints', () => {
  test('anthropic plan: system message + tail markers, no request options', () => {
    const plan = applyCacheBreakpoints({
      providerId: 'anthropic', modelId: 'claude-opus-4-7',
      system: 'sys', messages: history(4), sessionKey: 'kinu-x',
    });
    expect(plan.strategy).toEqual({ kind: 'anthropic' });
    expect(hasCacheMarkers(plan.strategy)).toBe(true);
    expect(providerOptions({ value: plan.system })).toEqual({ anthropic: { cacheControl: EPHEMERAL } });
    expect(anthropicMarkerCount(plan.messages)).toBe(2);
    expect(plan.providerOptions).toBeUndefined();
  });

  test('none plan is a byte-preserving pass-through', () => {
    const messages = history(3);
    const plan = applyCacheBreakpoints({
      providerId: 'workers-ai', modelId: '@cf/moonshotai/kimi-k2.6',
      system: 'sys', messages, sessionKey: 'kinu-x',
    });
    expect(plan.system).toBe('sys');
    expect(plan.messages).toEqual(messages);
    expect(plan.providerOptions).toBeUndefined();
    expect(hasCacheMarkers(plan.strategy)).toBe(false);
  });

  test('agrees with promptCachePlan on everything but the tail', () => {
    // The two turn drivers reach caching through different entry points —
    // runChat through applyCacheBreakpoints, Think's through promptCachePlan,
    // which cannot carry messages. Only the tail may differ between them; a
    // strategy, system or routing difference means the paths have drifted.
    for (const [providerId, modelId] of [
      ['anthropic', 'claude-opus-4-7'],
      ['openai', 'gpt-5.5'],
      ['openrouter', 'anthropic/claude-sonnet-4.6'],
      ['workers-ai', '@cf/moonshotai/kimi-k2.6'],
    ] as const) {
      const input = { providerId, modelId, system: 'sys', sessionKey: 'kinu-x' };
      const { messages: _tail, ...shared } = applyCacheBreakpoints({ ...input, messages: history(4) });
      expect({ providerId, ...shared }).toEqual({ providerId, ...promptCachePlan(input) });
    }
  });
});

// Moved from cf-backend (providers/anthropic-cache.ts was folded into this module).
describe('markLastToolForAnthropicCache', () => {
  test('sets an ephemeral anthropic cache breakpoint on the LAST tool only', () => {
    const tools: ToolSet = { a: cacheTool('a'), b: cacheTool('b'), c: cacheTool('c') };
    markLastToolForAnthropicCache(tools);
    expect(providerOptions({ value: tools.c })).toEqual({ anthropic: { cacheControl: EPHEMERAL } });
    expect(providerOptions({ value: tools.a })).toBeUndefined();
  });

  test('preserves any existing providerOptions on the last tool', () => {
    const last = { ...cacheTool('z'), providerOptions: { openai: { x: 1 } } };
    const tools: ToolSet = { z: last };
    markLastToolForAnthropicCache(tools);
    expect(providerOptions({ value: tools.z })).toEqual({
      openai: { x: 1 },
      anthropic: { cacheControl: EPHEMERAL },
    });
  });

  test('empty tool set is a no-op', () => {
    const tools: ToolSet = {};
    markLastToolForAnthropicCache(tools);
    // No tool means no breakpoint to write: the set stays empty.
    expect(Object.keys(tools)).toEqual([]);
  });

  test('retention drives the tool-surface breakpoint: long extends it, none omits it', () => {
    const long: ToolSet = { a: cacheTool('a'), b: cacheTool('b') };
    markLastToolForAnthropicCache(long, 'long');
    expect(providerOptions({ value: long.b }))
      .toEqual({ anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } });

    const off: ToolSet = { a: cacheTool('a'), b: cacheTool('b') };
    markLastToolForAnthropicCache(off, 'none');
    expect(providerOptions({ value: off.b })).toBeUndefined();
  });
});
