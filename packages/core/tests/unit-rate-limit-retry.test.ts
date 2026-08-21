import { describe, expect, test } from 'bun:test';
import { withRateLimitRetry } from '../src/providers/rate-limit-retry';
import { ProviderPacer } from '../src/providers/pacing';
import { asFetchFunction } from '../src/providers/fetch-shim';

/**
 * The layer under test, on a clock the suite owns.
 *
 * THE PACER SHARES THAT CLOCK, and it has to. The layer now declares each wait
 * into the isolate's provider pacer so siblings honour it, and the pacer holds
 * the next request until the declared deadline passes — measured on the pacer's
 * own clock. Left on the real one, every wait this suite fakes would be taken for
 * real on the way back in, which is a genuine seam rather than a test detail: a
 * caller controlling time must control all of it, or the two clocks disagree and
 * the layer waits twice.
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
  const fetchImpl = asFetchFunction(async () => responses[Math.min(calls++, responses.length - 1)]!);
  const wrapped = withRateLimitRetry(fetchImpl, {
    now,
    random: () => 0.5,
    sleep,
    // Its own pacer, not the isolate's: a suite that declared waits into the
    // shared one would leave cooldowns behind for whatever ran next.
    pacer: new ProviderPacer({ now, sleep: async (ms) => { nowMs += ms; } }),
    warn: (message) => warnings.push(message),
    ...overrides,
  });
  return { wrapped, waits, warnings, calls: () => calls };
}

describe('withRateLimitRetry', () => {
  test('honors Retry-After seconds', async () => {
    const harness = retryHarness([
      new Response('limited', { status: 429, headers: { 'Retry-After': '3' } }),
      new Response('ok'),
    ]);

    const response = await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(await response.text()).toBe('ok');
    expect(harness.waits).toEqual([3_000]);
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
      Array.from({ length: 8 }, () => new Response('limited', { status: 429 })),
      {
        baseDelayMs: 2_000,
        backoffFactor: 2,
        maxDelayMs: 60_000,
        maxAttempts: 8,
        maxElapsedMs: 300_000,
        random: () => 0.999,
      },
    );

    await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(harness.waits).toEqual([1_998, 3_996, 7_992, 15_984, 31_968, 59_940, 59_940]);
    expect(harness.waits.every((wait) => wait <= 60_000)).toBe(true);
  });

  test('gives up at the wall-clock budget and returns the last response', async () => {
    const first = new Response('first', { status: 429, headers: { 'Retry-After': '60' } });
    const last = new Response('last', { status: 429, headers: { 'Retry-After': '60' } });
    const harness = retryHarness([first, last], { maxElapsedMs: 90_000 });

    const response = await harness.wrapped('https://api.example.com/v1/chat', { body: '{}' });

    expect(response).toBe(last);
    expect(harness.calls()).toBe(2);
    expect(harness.waits).toEqual([60_000]);
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
      '[kinu] api.example.com rate-limited — waiting 2s (attempt 1/6)',
    ]);
  });
});
