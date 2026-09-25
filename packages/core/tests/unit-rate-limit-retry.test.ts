import { describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { PROVIDER_SDK_RETRIES, withRateLimitRetry } from '../src/providers/rate-limit-retry';
import { ProviderPacer } from '../src/providers/pacing';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { describeProviderError, toProviderError } from '../src/providers/util';
import { classifyErrorCode } from '../src/obs/index';
import type { JsonValue } from '../src/utils/json';

/**
 * The layer under test on a clock the suite owns. The pacer must share it: it holds requests until declared
 * deadlines pass on its own clock, so two clocks would make the layer wait twice.
 */
function retryHarness(
  responses: Response[],
  overrides: Parameters<typeof withRateLimitRetry>[1] = {},
) {
  let nowMs = 1_000_000;
  let calls = 0;
  const waits: number[] = [];
  const warnings: string[] = [];
  const now = () => nowMs;

  const sleep = async (ms: number) => {
    waits.push(ms);
    nowMs += ms;
  };

  const fetchImpl = asFetchFunction(async () => responses[Math.min(calls++, responses.length - 1)]);

  const wrapped = withRateLimitRetry(fetchImpl, {
    now,
    random: () => 0.5,
    sleep,
    // Its own pacer: declaring waits into the isolate's would leave cooldowns for later tests.
    pacer: new ProviderPacer({ now, sleep: async (ms) => { nowMs += ms; } }),
    warn: (message) => warnings.push(message),
    ...overrides,
  });

  return { wrapped, waits, warnings, calls: () => calls };
}

describe('withRateLimitRetry', () => {
  test('honors Retry-After seconds', async () => {
    const harness = retryHarness([
      new Response('limited', { status: 429, headers: { 'Retry-After': '30' } }),
      new Response('ok'),
    ]);

    const response = await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(await response.text()).toBe('ok');
    expect(harness.waits).toEqual([30_000]);
  });

  test('honors Retry-After HTTP dates against the injected clock', async () => {
    const retryAt = new Date(1_005_000).toUTCString();

    const harness = retryHarness([
      new Response('limited', { status: 429, headers: { 'Retry-After': retryAt } }),
      new Response('ok'),
    ]);

    await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(harness.waits).toEqual([5_000]);
  });

  test('uses exponential full jitter bounded by the per-wait cap', async () => {
    const harness = retryHarness(
      [...Array.from({ length: 8 }, () => new Response('limited', { status: 429 })), new Response('ok')],
      {
        baseDelayMs: 2_000,
        backoffFactor: 2,
        maxDelayMs: 60_000,
        random: () => 0.999,
      },
    );

    await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(harness.waits).toEqual([1_998, 3_996, 7_992, 15_984, 31_968, 59_940, 59_940, 59_940]);
    expect(harness.waits.every((wait) => wait <= 60_000)).toBe(true);
  });

  test('continues through provider-mandated waits until success', async () => {
    const harness = retryHarness([
      new Response('first', { status: 429, headers: { 'Retry-After': '60' } }),
      new Response('second', { status: 429, headers: { 'Retry-After': '60' } }),
      new Response('ok'),
    ]);

    const response = await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(await response.text()).toBe('ok');
    expect(harness.calls()).toBe(3);
    expect(harness.waits).toEqual([60_000, 60_000]);
  });

  test('stops provider waits only when the caller cancels', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled by user');

    const wrapped = withRateLimitRetry(
      asFetchFunction(async () => new Response('limited', { status: 429 })),
      {
        sleep: async () => { controller.abort(reason); },
        pacer: new ProviderPacer({ sleep: async () => {} }),
        warn: () => {},
      },
    );

    await expect(wrapped('https://api.example.com/v1/chat', {
      body: '{}',
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  test('passes non-string request bodies through without retrying', async () => {
    const harness = retryHarness([new Response('limited', { status: 429 })]);
    const body = new FormData();
    body.set('file', 'contents');

    const response = await harness.wrapped('https://api.example.com/v1/chat', { method: 'POST', body });

    expect(response.status).toBe(429);
    expect(harness.calls()).toBe(1);
    expect(harness.waits).toEqual([]);
  });

  test('returns success after two rate-limited responses', async () => {
    const harness = retryHarness([
      new Response('limited', { status: 429 }),
      new Response('limited', { status: 429 }),
      new Response('ok', { status: 200 }),
    ]);

    const response = await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(response.status).toBe(200);
    expect(harness.calls()).toBe(3);
    expect(harness.waits).toEqual([1_000, 2_000]);
  });

  test('retries 529 and overloaded 503 responses but not generic 503 responses', async () => {
    const retrying = retryHarness([
      new Response('capacity unavailable', { status: 529 }),
      new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), { status: 503 }),
      new Response('ok'),
    ]);

    expect((await retrying.wrapped('https://api.example.com/v1/chat', { body: '{}' })).status).toBe(200);
    expect(retrying.calls()).toBe(3);

    const generic = retryHarness([new Response('maintenance', { status: 503 })]);
    expect((await generic.wrapped('https://api.example.com/v1/chat', { body: '{}' })).status).toBe(503);
    expect(generic.calls()).toBe(1);
  });

  test('logs one concise provider-host warning per wait', async () => {
    const harness = retryHarness([
      new Response('limited', { status: 429, headers: { 'Retry-After': '2' } }),
      new Response('ok'),
    ]);

    await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(harness.warnings).toEqual([
      '[kinu] api.example.com rate-limited — waiting 2s (attempt 1)',
    ]);
  });

  /** Each provider's documented "allowance exhausted" 429 body: waiting cannot clear any of them. */
  const EXHAUSTED_CASES: ReadonlyArray<readonly [string, JsonValue]> = [
    ['openai insufficient_quota type', { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }],
    ['openai spend-limit code', { error: { message: 'Your project reached its enforced spend limit.', code: 'project_spend_limit_exceeded' } }],
    ['codex plan usage limit', { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: 1_760_000_000 } }],
    ['anthropic tier spend cap', { type: 'error', error: { type: 'rate_limit_error', message: 'You have reached your API usage limits.', details: { error_code: 'enforced_spend_limit_reached' } }, request_id: 'req_1' }],
    ['gemini daily quota', { error: { code: 429, message: 'You exceeded your current quota.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '50' }] }] } }],
    ['gemini zero quota, openai-compatible array envelope', [{ error: { code: 429, message: 'You exceeded your current quota.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '0' }] }] } }]],
    ['gemini interactions quota_exceeded', { error: { code: 'quota_exceeded', message: 'You have exceeded your daily quota.' } }],
    ['workers ai daily allocation (v4 envelope)', { success: false, errors: [{ code: 3036, message: 'You have used up your daily free allocation of 10,000 neurons.' }] }],
    ['workers ai daily allocation (direct binding)', { error: { code: 3036, message: 'You have used up your daily free allocation of 10,000 neurons.' } }],
    ['openrouter upstream quota', { error: { code: 429, message: 'Upstream quota exhausted', metadata: { error_type: 'rate_limit_exceeded', provider_code: 'insufficient_quota' } } }],
  ];

  const EXHAUSTED_BODIES = EXHAUSTED_CASES.map(([provider, body]) => [provider, JSON.stringify(body)] as const);

  const OPENAI_QUOTA = EXHAUSTED_BODIES[0]?.[1] ?? '';

  /** What a call rejected with; a success is itself the failure under test. */
  async function rejectionOf<T>(action: () => Promise<T>): Promise<Error> {
    try {
      await action();
    } catch (error) {
      if (error instanceof Error) return error;
      throw new Error(`expected an Error rejection, received ${String(error)}`, { cause: error });
    }

    throw new Error('a quota 429 was retried into a success');
  }

  test('a 429 naming an exhausted quota or spend limit fails once, classified, with the provider text', async () => {
    for (const [provider, body] of EXHAUSTED_BODIES) {
      const harness = retryHarness([
        new Response(body, { status: 429, headers: { 'content-type': 'application/json' } }),
        new Response('ok'),
      ]);

      const failure = await rejectionOf(() => harness.wrapped('https://api.example.com/v1/chat', { body: '{}' }));

      expect({ provider, calls: harness.calls(), waits: harness.waits }).toEqual({ provider, calls: 1, waits: [] });
      expect({ provider, code: classifyErrorCode({ cause: failure }) }).toEqual({ provider, code: 'budget' });
      expect(describeProviderError({ cause: failure })).toContain('HTTP 429');
    }
  });

  test('a quota 429 keeps the provider message and code for the user', async () => {
    const harness = retryHarness([new Response(OPENAI_QUOTA, { status: 429 }), new Response('ok')]);
    const failure = await rejectionOf(() => harness.wrapped('https://api.example.com/v1/chat', { body: '{}' }));

    expect(describeProviderError({ cause: failure })).toBe(
      'You exceeded your current quota, please check your plan and billing details. (HTTP 429, insufficient_quota)',
    );
  });

  test('real rate limits keep waiting', async () => {
    const limits: ReadonlyArray<readonly [string, string]> = [
      ['openai requests limit', JSON.stringify({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } })],
      ['openai slow_down', JSON.stringify({ error: { message: 'Slow down', type: 'rate_limit_error', code: 'slow_down' } })],
      ['anthropic rate limit', JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your rate limit.' } })],
      ['gemini per-minute quota', JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' }] }] } })],
      ['workers ai capacity', JSON.stringify({ success: false, errors: [{ code: 3040, message: 'Capacity temporarily exceeded, please try again.' }] })],
      ['openrouter rate limit', JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-min.', metadata: { error_type: 'rate_limit_exceeded' } } })],
      ['plain text', 'Too Many Requests'],
    ];

    for (const [provider, body] of limits) {
      const harness = retryHarness([new Response(body, { status: 429 }), new Response('ok')]);
      const response = await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

      expect({ provider, status: response.status, calls: harness.calls() }).toEqual({ provider, status: 200, calls: 2 });
    }
  });

  // OpenCode Go's spent window, kinu.run 2026-09-24.
  const SPENT_WINDOW_BODY = JSON.stringify({ error: { message: 'Monthly usage limit reached.', type: 'rate_limit_error' } });

  test('a Retry-After past the longest wait ends the call as spent, naming the provider, reset time and message', async () => {
    const harness = retryHarness(
      [new Response(SPENT_WINDOW_BODY, { status: 429, headers: { 'Retry-After': '729883' } }), new Response('ok')],
      { provider: 'opencode-go' },
    );

    const failure = await rejectionOf(() => harness.wrapped('https://opencode.ai/zen/go/v1/chat/completions', { body: '{}' }));
    const described = describeProviderError({ cause: failure });

    expect({ calls: harness.calls(), waits: harness.waits }).toEqual({ calls: 1, waits: [] });
    expect(classifyErrorCode({ cause: failure })).toBe('budget');
    expect(described).toContain('opencode-go');
    expect(described).toContain(new Date(1_000_000 + 729_883_000).toISOString().slice(0, 16).replace('T', ' '));
    expect(described).toContain('Monthly usage limit reached.');
  });

  test('an HTTP-date Retry-After days out ends the call; one at the longest wait is still waited', async () => {
    const DAY_MS = 86_400_000;

    const far = retryHarness([
      new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': new Date(1_000_000 + 3 * DAY_MS).toUTCString() } }),
      new Response('ok'),
    ]);

    const failure = await rejectionOf(() => far.wrapped('https://api.example.com/v1/chat', { body: '{}' }));

    expect({ calls: far.calls(), waits: far.waits, code: classifyErrorCode({ cause: failure }) })
      .toEqual({ calls: 1, waits: [], code: 'budget' });

    const edge = retryHarness([
      new Response('limited', { status: 529, headers: { 'Retry-After': new Date(1_060_000).toUTCString() } }),
      new Response('ok'),
    ]);

    expect((await edge.wrapped('https://api.example.com/v1/chat', { body: '{}' })).status).toBe(200);
    expect(edge.waits).toEqual([60_000]);
  });

  test('a sibling on the same lane ends at once on a declared wait past the longest wait, never parking', async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const parked: number[] = [];
    const pacer = new ProviderPacer({ now, sleep: async (ms) => { parked.push(ms); nowMs += ms; } });
    let sent = 0;

    const wrapped = withRateLimitRetry(asFetchFunction(async () => {
      sent++;

      return sent === 1
        ? new Response(SPENT_WINDOW_BODY, { status: 429, headers: { 'Retry-After': '729883' } })
        : new Response('ok');
    }), { now, pacer, provider: 'opencode-go', sleep: async (ms) => { parked.push(ms); }, warn: () => {} });

    await rejectionOf(() => wrapped('https://opencode.ai/zen/go/v1/chat/completions', { body: '{}' }));
    const sibling = await rejectionOf(() => wrapped('https://opencode.ai/zen/go/v1/chat/completions', { body: '{}' }));

    expect({ sent, parked, code: classifyErrorCode({ cause: sibling }) }).toEqual({ sent: 1, parked: [], code: 'budget' });
    expect(describeProviderError({ cause: sibling })).toContain('Monthly usage limit reached.');
  });

  test('the SDK neither retries a quota 429 nor loses its class on the way to the caller', async () => {
    let requests = 0;

    const completion = {
      id: 'c', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };

    const fetchImpl = withRateLimitRetry(asFetchFunction(async () => {
      requests++;

      return requests === 1
        ? new Response(OPENAI_QUOTA, { status: 429, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } });
    }), { pacer: new ProviderPacer({ sleep: async () => {} }), sleep: async () => {}, warn: () => {} });

    const model = createOpenAICompatible({ name: 'quota-probe', baseURL: 'https://api.example.com/v1', fetch: fetchImpl }).chatModel('m');
    const failure = await rejectionOf(() => generateText({ model, prompt: 'hi', maxRetries: PROVIDER_SDK_RETRIES }));

    expect(requests).toBe(1);
    expect(toProviderError({ doing: 'calling the model', cause: failure }).code).toBe('budget');
  });
});
