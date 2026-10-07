// Defends the cached-usage repair (`middleware/usage-repair.ts`). Measured on {account}/ai/v1: the platform-appended
// duplicate usage chunk zeroes cached_tokens (2026-07-13, glm-5.2) or drops prompt_tokens_details (2026-08-17,
// deepseek-v4-pro); a provider keeps the last chunk. Fixtures below are verbatim captures from the live endpoint.
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { streamText, type LanguageModel, type LanguageModelUsage } from 'ai';
import { DEFAULT_WORKERS_AI_MODEL_ID, normalizeUsage, withModelStack } from '@kinu.run/core';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { bindingModel, eventStreamOf } from './helpers/workers-ai-model';

const ID = 'id-1783943808747';

const head = `"id":"${ID}","created":1783943808,"model":"@cf/zai-org/glm-5.2","object":"chat.completion.chunk"`;

const tailHead = `"id":"${ID}","object":"chat.completion.chunk","created":1783943808,"model":"@cf/zai-org/glm-5.2"`;

const DELTA_CHUNK = `data: {${head},"choices":[{"delta":{"content":"ok","reasoning_content":null},"finish_reason":null,"index":0,"logprobs":null,"matched_stop":null}]}`;

const MODEL_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":3,"prompt_tokens":14571,"prompt_tokens_details":{"cached_tokens":14528},"total_tokens":14574}}`;

const ZEROED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574,"prompt_tokens_details":{"cached_tokens":0}}}`;

// deepseek-v4-pro shape: prompt_tokens_details gone rather than zeroed.
const DROPPED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574}}`;

const NULLED_USAGE_CHUNK = `data: {${tailHead},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574,"prompt_tokens_details":null}}`;

// No live choice: the duplicate as a usage-only frame.
const USAGE_ONLY_ZEROED = `data: {${tailHead},"choices":[],"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574,"prompt_tokens_details":{"cached_tokens":0}}}`;

// KINU-049: a usage-only frame with no `choices` at all.
const BARE_USAGE = `data: {${tailHead},"usage":{"prompt_tokens":14571,"completion_tokens":3,"total_tokens":14574}}`;

const COLD_MODEL_USAGE_CHUNK = MODEL_USAGE_CHUNK.replace('{"cached_tokens":14528}', 'null');

function sse(...lines: string[]): string {
  return lines.map((l) => `${l}\n\n`).join('');
}

function accountModel(body: string, modelId = '@cf/zai-org/glm-5.2'): LanguageModel {
  const reg = createAgentProviderRegistry({
    env: {},
    userDO: userCredentialSource({
      getAuthHeaders: async (key: string) => (key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-user-token' } : null),
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async (key: string) =>
        key === 'cloudflare.oauth' ? 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1' : null,
    }),
    fetch: Object.assign(async () => eventStreamOf(body), { preconnect: globalThis.fetch.preconnect }),
  });

  return reg.resolveModel(`workers-ai/${modelId}`, 'kinu-jarvis');
}

async function usageOf(model: LanguageModel): Promise<LanguageModelUsage> {
  const result = streamText({ model, prompt: 'ping', maxRetries: 0 });
  await result.consumeStream();
  expect(await result.finishReason).toBe('stop');

  return result.usage;
}

/** Both payers' Workers AI paths: the user's account endpoint and the deployment's binding. */
const PATHS = [
  ['the account endpoint', (body: string) => accountModel(body)],
  // As the registry resolves it: repair is the model stack's, around every provider alike.
  ['the binding', (body: string) => withModelStack(bindingModel(() => eventStreamOf(body)).model, { provider: 'workers-ai', lane: 'workers-ai|' })],
] as const;

describe.each(PATHS)('cached-usage repair through %s', (_path, modelOf) => {
  test('a zeroed trailing duplicate is repaired to the real cached count', async () => {
    const usage = await usageOf(modelOf(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, ZEROED_USAGE_CHUNK, 'data: [DONE]')));

    expect(usage.inputTokenDetails.cacheReadTokens).toBe(14528);
    expect(usage.inputTokenDetails.noCacheTokens).toBe(43);
    expect(usage.inputTokens).toBe(14571);
    expect(usage.outputTokens).toBe(3);
    expect(normalizeUsage(usage).cacheRead).toBe(14528);
  });

  test('a duplicate that drops prompt_tokens_details is repaired, and accounting sees the field', async () => {
    const usage = await usageOf(modelOf(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, DROPPED_USAGE_CHUNK, 'data: [DONE]')));

    expect(usage.inputTokenDetails.cacheReadTokens).toBe(14528);
    // normalizeUsage witnesses presence off `raw`, so the repair restores the key as well as the number.
    expect(normalizeUsage(usage).cacheRead).toBe(14528);
  });

  test('a duplicate whose prompt_tokens_details is null is repaired too', async () => {
    const usage = await usageOf(modelOf(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, NULLED_USAGE_CHUNK, 'data: [DONE]')));

    expect(normalizeUsage(usage).cacheRead).toBe(14528);
  });

  test('a duplicate that arrives as a usage-only frame is repaired too', async () => {
    const usage = await usageOf(modelOf(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, USAGE_ONLY_ZEROED, 'data: [DONE]')));

    expect(normalizeUsage(usage).cacheRead).toBe(14528);
  });

  test('a dropped field with no prior cache read is left alone', async () => {
    // Nothing reported a cache read, so the repair has nothing to restore.
    const usage = await usageOf(modelOf(sse(DELTA_CHUNK, DROPPED_USAGE_CHUNK, 'data: [DONE]')));

    expect(normalizeUsage(usage)).toMatchObject({ input: 14571, output: 3 });
    expect(usage.inputTokenDetails.cacheReadTokens ?? 0).toBe(0);
  });

  test('a genuinely uncached stream is never inflated', async () => {
    const usage = await usageOf(modelOf(sse(DELTA_CHUNK, COLD_MODEL_USAGE_CHUNK, ZEROED_USAGE_CHUNK, 'data: [DONE]')));

    expect(normalizeUsage(usage).cacheRead).toBe(0);
  });

  test('consistent duplicates (kimi shape) report the count once', async () => {
    const usage = await usageOf(modelOf(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, MODEL_USAGE_CHUNK, 'data: [DONE]')));

    expect(normalizeUsage(usage)).toMatchObject({ input: 14571, output: 3, cacheRead: 14528 });
  });

  test('a usage-only frame without choices is read, not refused (KINU-049)', async () => {
    const usage = await usageOf(modelOf(sse(DELTA_CHUNK.replace('"finish_reason":null', '"finish_reason":"stop"'), BARE_USAGE, 'data: [DONE]')));

    expect(normalizeUsage(usage)).toMatchObject({ input: 14571, output: 3 });
  });
});

test('the default model on the account endpoint survives a duplicate that dropped the detail', async () => {
  const usage = await usageOf(accountModel(sse(DELTA_CHUNK, MODEL_USAGE_CHUNK, DROPPED_USAGE_CHUNK, 'data: [DONE]'), DEFAULT_WORKERS_AI_MODEL_ID));

  expect(normalizeUsage(usage).cacheRead).toBe(14528);
});
