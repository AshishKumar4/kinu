// Regression tests for the cached-usage SSE repair (stream-usage-repair.ts).
//
// Production-proven bug (2026-07-13): the {account}/ai/v1 chat-completions
// stream ends with a platform-appended duplicate usage chunk that, for some
// models (glm-5.2), zeroes prompt_tokens_details.cached_tokens. The AI SDK
// keeps the LAST usage chunk, so every streamed run reported `cacheRead: 0`
// while billing showed ~73% of input tokens served from the prefix cache.
//
// Second shape, production-proven (2026-08-17, deepseek-v4-pro): the duplicate
// DROPS prompt_tokens_details entirely rather than zeroing it. The repair's
// stated rule covered that case in prose and not in code — the schema required
// the detail object, so a chunk without it failed the parse and passed through
// unrepaired. Measured cost on one workspace: of 350 retained steps, 38 carried
// no cache read at all, which the step telemetry rendered as 38 total cache
// misses and dragged a real ~93.5% mean hit rate down to the 83.5% the owner
// was reading off the panel.
//
// Fixtures below are verbatim captures from the live endpoint.
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { streamText } from 'ai';
import { DEFAULT_WORKERS_AI_MODEL_ID, normalizeUsage } from '@proteus/core';
import { repairSseCachedUsage } from '../src/providers/stream-usage-repair';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';

const ID = 'id-1783943808747';
const head = `"id":"${ID}","created":1783943808,"model":"@cf/zai-org/glm-5.2","object":"chat.completion.chunk"`;
const tailHead = `"id":"${ID}","object":"chat.completion.chunk","created":1783943808,"model":"@cf/zai-org/glm-5.2"`;

const DELTA_CHUNK = `data: {${head},"choices":[{"delta":{"content":"ok","reasoning_content":null},"finish_reason":null,"index":0,"logprobs":null,"matched_stop":null}]}`;
// The model runtime's own usage chunk — carries the real cached count.
const MODEL_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":3,"prompt_tokens":14571,"prompt_tokens_details":{"cached_tokens":14528},"total_tokens":14574}}`;
// The platform-appended duplicate — cached_tokens zeroed (the bug).
const ZEROED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574,"prompt_tokens_details":{"cached_tokens":0}}}`;
// The same duplicate as it arrives from deepseek-v4-pro: prompt_tokens_details
// gone rather than zeroed. The SDK's `cached_tokens ?? 0` then reports 0 AND
// leaves `raw` without the key, so neither the value nor its absence survives.
const DROPPED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574}}`;
// The null variant of the same loss.
const NULLED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574,"prompt_tokens_details":null}}`;

function sse(...lines: string[]): string {
  return lines.map((l) => `${l}\n\n`).join('');
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** Deliver `body` in fixed-size byte slices to exercise line reassembly. */
function chunkedSseResponse(body: string, size: number): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

function lastCachedTokens(text: string): number | undefined {
  const usages = [...text.matchAll(/"cached_tokens":(\d+)/g)];
  return usages.length > 0 ? Number(usages[usages.length - 1][1]) : undefined;
}

describe('repairSseCachedUsage', () => {
  test('zeroed trailing duplicate is repaired to the real cached count', async () => {
    const input = sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, ZEROED_USAGE_CHUNK, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(lastCachedTokens(out)).toBe(14528);
    // Untouched lines survive byte-exactly.
    expect(out).toContain(`${DELTA_CHUNK}\n`);
    expect(out).toContain(`${MODEL_USAGE_CHUNK}\n`);
    expect(out).toContain('data: [DONE]\n');
    // The repaired duplicate keeps its other usage fields.
    expect(out).toContain('"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574');
  });

  test('a duplicate that DROPS prompt_tokens_details is repaired to the real count', async () => {
    const input = sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, DROPPED_USAGE_CHUNK, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    // The trailing chunk — the only one the SDK keeps — now carries the count.
    expect(out).not.toContain(DROPPED_USAGE_CHUNK);
    expect(out.slice(out.indexOf(MODEL_USAGE_CHUNK) + MODEL_USAGE_CHUNK.length))
      .toContain('"prompt_tokens_details":{"cached_tokens":14528}');
    expect(out).toContain(`${MODEL_USAGE_CHUNK}\n`);
    expect(out).toContain('data: [DONE]\n');
  });

  test('a duplicate whose prompt_tokens_details is null is repaired too', async () => {
    const input = sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, NULLED_USAGE_CHUNK, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).not.toContain('"prompt_tokens_details":null');
    expect(lastCachedTokens(out)).toBe(14528);
  });

  test('a dropped field with no prior cache read is left alone, never given a zero', async () => {
    // Nothing reported a cache read, so there is no maximum to restore.
    // Writing `cached_tokens: 0` here would fabricate a total-miss measurement.
    const input = sse(DELTA_CHUNK, DROPPED_USAGE_CHUNK, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).toBe(input);
    expect(out).not.toContain('cached_tokens');
  });

  test('consistent duplicates (kimi shape) pass through byte-exactly', async () => {
    const consistent = MODEL_USAGE_CHUNK; // same cached count in both chunks
    const input = sse(DELTA_CHUNK, consistent, consistent, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).toBe(input);
  });

  test('a genuinely uncached stream is never inflated', async () => {
    const coldModelChunk = MODEL_USAGE_CHUNK.replace('{"cached_tokens":14528}', 'null');
    const input = sse(DELTA_CHUNK, coldModelChunk, ZEROED_USAGE_CHUNK, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).toBe(input);
  });

  test('repair works across arbitrary byte-boundary splits', async () => {
    const input = sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, ZEROED_USAGE_CHUNK, 'data: [DONE]');
    for (const size of [1, 7, 64]) {
      const out = await repairSseCachedUsage(chunkedSseResponse(input, size)).text();
      expect(lastCachedTokens(out)).toBe(14528);
    }
  });

  test('CRLF line endings are preserved through a repair', async () => {
    const input = `${MODEL_USAGE_CHUNK}\r\n\r\n${ZEROED_USAGE_CHUNK}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(lastCachedTokens(out)).toBe(14528);
    expect(out).toContain(`${MODEL_USAGE_CHUNK}\r\n`);
    expect(out.endsWith('data: [DONE]\r\n\r\n')).toBe(true);
  });

  test('non-SSE responses are returned unchanged (same instance)', () => {
    const res = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    expect(repairSseCachedUsage(res)).toBe(res);
  });

  test('malformed data lines pass through untouched', async () => {
    const input = sse('data: {not json', MODEL_USAGE_CHUNK, ZEROED_USAGE_CHUNK);
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).toContain('data: {not json\n');
    expect(lastCachedTokens(out)).toBe(14528);
  });

  test('status and headers survive the wrap', async () => {
    const res = new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-probe': 'yes' },
    });
    const out = repairSseCachedUsage(res);
    expect(out.status).toBe(200);
    expect(out.headers.get('x-probe')).toBe('yes');
    await out.text();
  });
});

describe('cached-usage accounting end to end (workers-ai provider)', () => {
  function fakeUserDOStub() {
    return userCredentialSource({
      getAuthHeaders: async (key: string) =>
        key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-user-token' } : null,
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async (key: string) =>
        key === 'cloudflare.oauth' ? 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1' : null,
    });
  }

  test('streamed glm-5.2 usage reports the real cached tokens, not the zeroed duplicate', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub(),
      fetch: Object.assign(
        async () => sseResponse(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, ZEROED_USAGE_CHUNK, 'data: [DONE]')),
        { preconnect: globalThis.fetch.preconnect },
      ),
      workersAI: { sessionAffinity: 'proteus-jarvis' },
    });
    const result = streamText({
      model: reg.resolveModel('workers-ai/@cf/zai-org/glm-5.2'),
      prompt: 'ping',
    });
    await result.consumeStream();
    const usage = await result.usage;
    expect(usage.cachedInputTokens).toBe(14528);
    expect(usage.inputTokens).toBe(14571);
    expect(usage.outputTokens).toBe(3);
  });

  test('streamed deepseek-v4-pro usage survives a duplicate that dropped the detail', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub(),
      fetch: Object.assign(
        async () => sseResponse(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, DROPPED_USAGE_CHUNK, 'data: [DONE]')),
        { preconnect: globalThis.fetch.preconnect },
      ),
      workersAI: { sessionAffinity: 'proteus-stone-ash-71f2' },
    });
    const result = streamText({
      model: reg.resolveModel(`workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`),
      prompt: 'ping',
    });
    await result.consumeStream();
    const usage = await result.usage;
    expect(usage.cachedInputTokens).toBe(14528);
    // `raw` is what normalizeUsage witnesses presence off, so the repair has to
    // restore the KEY as well as the number — otherwise the step reports no
    // cache read at all and the hit-rate sample is silently dropped.
    expect(normalizeUsage(usage).cacheRead).toBe(14528);
  });
});
