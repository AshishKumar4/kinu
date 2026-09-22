// Defends the cached-usage SSE repair. Measured on {account}/ai/v1: the platform-appended
// duplicate usage chunk zeroes cached_tokens (2026-07-13, glm-5.2) or drops
// prompt_tokens_details (2026-08-17, deepseek-v4-pro); the SDK keeps the last chunk.
// Fixtures below are verbatim captures from the live endpoint.
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { DEFAULT_WORKERS_AI_MODEL_ID, normalizeUsage, type JsonObject } from '@kinu.run/core';
import { repairSseCachedUsage } from '@kinu.run/core';
import { createDirectWorkersAIFetch } from '@kinu.run/core';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';

const ID = 'id-1783943808747';

const head = `"id":"${ID}","created":1783943808,"model":"@cf/zai-org/glm-5.2","object":"chat.completion.chunk"`;

const tailHead = `"id":"${ID}","object":"chat.completion.chunk","created":1783943808,"model":"@cf/zai-org/glm-5.2"`;

const DELTA_CHUNK = `data: {${head},"choices":[{"delta":{"content":"ok","reasoning_content":null},"finish_reason":null,"index":0,"logprobs":null,"matched_stop":null}]}`;

const MODEL_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":3,"prompt_tokens":14571,"prompt_tokens_details":{"cached_tokens":14528},"total_tokens":14574}}`;

const ZEROED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574,"prompt_tokens_details":{"cached_tokens":0}}}`;

// deepseek-v4-pro shape: prompt_tokens_details gone rather than zeroed.
const DROPPED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574}}`;

const NULLED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574,"prompt_tokens_details":null}}`;

function sse(...lines: string[]): string {
  return lines.map((l) => `${l}\n\n`).join('');
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

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
    expect(out).toContain(`${DELTA_CHUNK}\n`);
    expect(out).toContain(`${MODEL_USAGE_CHUNK}\n`);
    expect(out).toContain('data: [DONE]\n');
    expect(out).toContain('"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574');
  });

  test('a duplicate that DROPS prompt_tokens_details is repaired to the real count', async () => {
    const input = sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, DROPPED_USAGE_CHUNK, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
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
    // Nothing reported a cache read; writing `cached_tokens: 0` would fabricate a total miss.
    const input = sse(DELTA_CHUNK, DROPPED_USAGE_CHUNK, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).toBe(input);
    expect(out).not.toContain('cached_tokens');
  });

  test('consistent duplicates (kimi shape) pass through byte-exactly', async () => {
    const consistent = MODEL_USAGE_CHUNK;
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

  // KINU-049. The AI SDK's chunk schema requires `choices`: the repair adds an empty array, nothing else.
  test('a usage-only frame without choices gains exactly an empty array', async () => {
    const bare = `data: {${tailHead},"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574}}`;
    const input = sse(DELTA_CHUNK, bare, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).toContain(`data: {${tailHead},"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574},"choices":[]}\n`);
    expect(out).toContain(`${DELTA_CHUNK}\n`);
    expect(out).toContain('data: [DONE]\n');
  });

  test('a usage frame WITH choices is left byte-identical', async () => {
    const input = sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).toBe(input);
  });

  test('an error frame is never given a choices array', async () => {
    const errFrame = `data: {"error":{"message":"upstream exploded","type":"server_error"},"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}`;
    const input = sse(DELTA_CHUNK, errFrame, 'data: [DONE]');
    const out = await repairSseCachedUsage(sseResponse(input)).text();
    expect(out).toBe(input);
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
      sessionAffinity: 'kinu-jarvis',
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
      sessionAffinity: 'kinu-stone-ash-71f2',
    });

    const result = streamText({
      model: reg.resolveModel(`workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`),
      prompt: 'ping',
    });

    await result.consumeStream();
    const usage = await result.usage;
    expect(usage.cachedInputTokens).toBe(14528);
    // normalizeUsage witnesses presence off `raw`, so the repair restores the key as well as the number.
    expect(normalizeUsage(usage).cacheRead).toBe(14528);
  });
});

// The direct binding transport applies the repair rule inside its single translation pass.
describe('cached-usage repair through the direct binding pass', () => {
  const GLM = '@cf/zai-org/glm-5.2';
  const DIRECT_ENDPOINT = 'https://kinu-direct-workers-ai.invalid/chat/completions';
  // No live choice: the transport absorbs the duplicate, so the repair must reach its synthesized frame.
  const USAGE_ONLY_ZEROED = `data: {${tailHead},"choices":[],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574,"prompt_tokens_details":{"cached_tokens":0}}}`;

  function directBindingFetch(body: string): typeof globalThis.fetch {
    const ai = {
      run(_model: string, _inputs: JsonObject, _options?: JsonObject):
      Promise<Response | ReadableStream<Uint8Array> | JsonObject> {
        return Promise.resolve(sseResponse(body));
      },
    };

    // SAFETY: `createDirectWorkersAIFetch` narrows its argument to `shell`, which the
    // fixture declares with the exact signature; no other member of `Ai` is reachable.
    return createDirectWorkersAIFetch(ai);
  }

  async function streamedText(body: string): Promise<string> {
    const response = await directBindingFetch(body)(DIRECT_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ model: GLM, messages: [{ role: 'user', content: 'ping' }], stream: true }),
    });

    return response.text();
  }

  test('a zeroed trailing duplicate is repaired, and untouched frames stay verbatim', async () => {
    const out = await streamedText(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, ZEROED_USAGE_CHUNK, 'data: [DONE]'));
    expect(lastCachedTokens(out)).toBe(14528);
    expect(out).toContain(`${DELTA_CHUNK}\n`);
    expect(out).toContain(`${MODEL_USAGE_CHUNK}\n`);
  });

  test('a duplicate that arrives as a usage-only frame is repaired too', async () => {
    const out = await streamedText(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, USAGE_ONLY_ZEROED, 'data: [DONE]'));
    expect(lastCachedTokens(out)).toBe(14528);
    expect(out).not.toContain('"cached_tokens":0');
  });

  test('a genuinely uncached stream is never inflated on this path either', async () => {
    const cold = MODEL_USAGE_CHUNK.replace('{"cached_tokens":14528}', 'null');
    const out = await streamedText(sse(DELTA_CHUNK, cold, 'data: [DONE]'));
    expect(out).toContain(`${cold}\n`);
    expect(out).not.toContain('cached_tokens');
  });

  test('streamText reads the repaired cache read off a binding stream', async () => {
    const model = createOpenAICompatible({
      name: 'workers-ai',
      baseURL: 'https://kinu-direct-workers-ai.invalid',
      fetch: directBindingFetch(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, USAGE_ONLY_ZEROED, 'data: [DONE]')),
    }).chatModel(GLM);

    const result = streamText({ model, prompt: 'ping' });
    await result.consumeStream();

    const usage = await result.usage;
    expect(usage.cachedInputTokens).toBe(14528);
    expect(normalizeUsage(usage).cacheRead).toBe(14528);
  });
});
