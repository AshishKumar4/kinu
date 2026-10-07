import { describe, expect, test } from 'bun:test';
import { generateText, wrapLanguageModel, type LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { callRetries, retryMiddleware, type RetryPolicy } from '../src/providers/middleware/retry';
import { DEFAULT_PROVIDER_RETRIES } from '../src/types/profile';
import { ProviderPacer } from '../src/providers/pacing';
import { statedRetryAfterMs } from '../src/providers/fallback-cooldown';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { createWorkersAIProvider } from '../src/providers/workers-ai-provider';
import { withModelStack } from '../src/providers/wire-model';
import { describeProviderError, toProviderError } from '../src/providers/util';
import { classifyErrorCode } from '../src/obs/index';
import type { JsonValue } from '../src/utils/json';

const LANE = 'example@main';

/** A chat completion that answers `text`: what a provider sends once it stops refusing. */
function answer(text = 'ok'): Response {
  return new Response(JSON.stringify({
    id: 'c', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } });
}

/** The SDK's own provider over `fetchImpl`, called through the one retry layer every model gets. */
function stacked(fetchImpl: typeof globalThis.fetch, policy: Partial<RetryPolicy> = {}) {
  const model = createOpenAICompatible({ name: 'example', baseURL: 'https://api.example.com/v1', fetch: fetchImpl }).chatModel('m');

  return wrapLanguageModel({ model, middleware: retryMiddleware({ provider: 'example', lane: LANE, warn: () => {}, ...policy }) });
}

/** One call, its retries the caller's; the SDK's own retries are left at their default to show the layer owns them. */
async function called(model: LanguageModel, retries?: number, signal?: AbortSignal): Promise<string> {
  const result = await generateText({
    model, prompt: 'hi', maxRetries: DEFAULT_PROVIDER_RETRIES,
    ...(retries !== undefined && { providerOptions: callRetries(retries) }),
    ...(signal !== undefined && { abortSignal: signal }),
  });

  return result.text;
}

/**
 * The layer under test on a clock the suite owns. The pacer must share it: it holds requests until declared
 * deadlines pass on its own clock, so two clocks would make the layer wait twice.
 */
function retryHarness(responses: Response[], overrides: Partial<RetryPolicy> = {}) {
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

  const model = stacked(fetchImpl, {
    now,
    random: () => 0.5,
    sleep,
    // Its own pacer: declaring waits into the isolate's would leave cooldowns for later tests.
    pacer: new ProviderPacer({ now, sleep: async (ms) => { nowMs += ms; } }),
    warn: (message) => warnings.push(message),
    ...overrides,
  });

  return { call: (retries?: number) => called(model, retries), waits, warnings, calls: () => calls };
}

describe('the model stack retries every call once, in one place', () => {
  test('honors Retry-After seconds', async () => {
    const harness = retryHarness([
      new Response('limited', { status: 429, headers: { 'Retry-After': '30' } }),
      answer(),
    ]);

    expect(await harness.call()).toBe('ok');
    expect(harness.waits).toEqual([30_000]);
  });

  test('honors retry-after-ms, as the fallback cooldown reads the same answer', async () => {
    const limited = new Response('limited', { status: 429, headers: { 'retry-after-ms': '1500' } });
    const harness = retryHarness([limited, answer()]);

    await harness.call();

    expect(harness.waits).toEqual([1_500]);
    expect(statedRetryAfterMs({ cause: { responseHeaders: Object.fromEntries(limited.headers) } })).toBe(1_500);
  });

  /** A lane a sibling already cooled, then `limited` 429s of this call's own. */
  async function behindSibling(limited: number, retries: number) {
    let nowMs = 1_000_000;
    let sent = 0;
    const sleep = async (ms: number) => { nowMs += ms; };

    const pacer = new ProviderPacer({ now: () => nowMs, sleep });

    pacer.declareWait(LANE, 1_000);

    const model = stacked(asFetchFunction(async () => {
      sent += 1;

      return sent <= limited ? new Response('limited', { status: 429 }) : answer();
    }), { now: () => nowMs, sleep, pacer, random: () => 0 });

    const [answered] = await Promise.allSettled([called(model, retries)]);

    return { sent, answered };
  }

  test('a sibling\'s cooldown is waited out without spending this call\'s retries', async () => {
    // Staging 85a438698: jury calls joined each other's waits and stopped at attempt 2 of 3.
    const { sent, answered } = await behindSibling(DEFAULT_PROVIDER_RETRIES, DEFAULT_PROVIDER_RETRIES);

    expect({ sent, answered: answered.status === 'fulfilled' ? answered.value : null }).toEqual({ sent: DEFAULT_PROVIDER_RETRIES + 1, answered: 'ok' });
  });

  test('a call with no retries, a chain entry behind it, hands over at a sibling\'s cooldown without asking', async () => {
    const { sent, answered } = await behindSibling(0, 0);

    expect(sent).toBe(0);
    expect(answered.status === 'rejected' ? String(answered.reason) : '').toContain('rate-limiting this account');
  });

  test('its own declared wait is never counted as a sibling\'s, whichever clock read it', async () => {
    let clock = 1_000_000;
    let calls = 0;
    const limited = () => new Response('limited', { status: 429, headers: { 'retry-after': '1' } });
    const answers = [limited(), limited(), answer()];

    // The pacer reads its clock a millisecond after the layer read its own, and waiting passes no time here.
    const model = stacked(asFetchFunction(async () => answers[calls++]), {
      now: () => clock - 1,
      sleep: async () => {},
      pacer: new ProviderPacer({ now: () => clock, sleep: async (ms) => { clock += ms; } }),
    });

    expect(await called(model)).toBe('ok');
    expect(calls).toBe(3);
  });

  test('honors Retry-After HTTP dates against the injected clock', async () => {
    const retryAt = new Date(1_005_000).toUTCString();

    const harness = retryHarness([new Response('limited', { status: 429, headers: { 'Retry-After': retryAt } }), answer()]);

    await harness.call();

    expect(harness.waits).toEqual([5_000]);
  });

  test('a negative Retry-After is no stated wait, so the backoff applies', async () => {
    const harness = retryHarness([new Response('limited', { status: 429, headers: { 'Retry-After': '-1' } }), answer()], { random: () => 0.999 });

    await harness.call();

    expect(harness.waits).toEqual([1_998]);
  });

  test('uses exponential full jitter bounded by the per-wait cap', async () => {
    const harness = retryHarness(
      [...Array.from({ length: 8 }, () => new Response('limited', { status: 429 })), answer()],
      { random: () => 0.999 },
    );

    await harness.call(8);

    expect(harness.waits).toEqual([1_998, 3_996, 7_992, 15_984, 31_968, 59_940, 59_940, 59_940]);
    expect(harness.waits.every((wait) => wait <= 60_000)).toBe(true);
  });

  test('waits out at most the owner\u2019s retries, then fails with the limit instead of sleeping on', async () => {
    const harness = retryHarness(Array.from({ length: 6 }, () => new Response('limited', { status: 429, headers: { 'Retry-After': '1' } })));

    await expect(harness.call()).rejects.toThrow('rate-limiting this account (HTTP 429)');
    expect(harness.calls()).toBe(4);
    expect(harness.waits).toEqual([1_000, 1_000, 1_000]);
  });

  test('continues through provider-mandated waits until success', async () => {
    const harness = retryHarness([
      new Response('first', { status: 429, headers: { 'Retry-After': '60' } }),
      new Response('second', { status: 429, headers: { 'Retry-After': '60' } }),
      answer(),
    ]);

    expect(await harness.call()).toBe('ok');
    expect(harness.calls()).toBe(3);
    expect(harness.waits).toEqual([60_000, 60_000]);
  });

  test.each([
    ['default', undefined, 3], ['none', 0, 0], ['one', 1, 1],
  ] as const)('the call\'s %s retry budget is spent once, the SDK retrying nothing on top', async (_label, requested, retries) => {
    const harness = retryHarness([new Response('limited', { status: 429, headers: { 'Retry-After': '1' } })]);

    await expect(harness.call(requested)).rejects.toThrow('rate-limiting this account');

    expect(harness.calls()).toBe(retries + 1);
    expect(harness.waits).toHaveLength(retries);
  });

  test('the call\'s own options are spent here and never handed to the provider', async () => {
    const seen: unknown[] = [];
    const inner = createOpenAICompatible({ name: 'example', baseURL: 'https://api.example.com/v1', fetch: asFetchFunction(async () => answer()) }).chatModel('m');

    const model = wrapLanguageModel({ model: inner, middleware: [
      retryMiddleware({ provider: 'example', lane: LANE, warn: () => {} }),
      {
        specificationVersion: 'v4',
        transformParams: async ({ params }) => {
          seen.push(params.providerOptions);

          return params;
        },
      },
    ] });

    await generateText({ model, prompt: 'hi', maxRetries: 0, providerOptions: { ...callRetries(1), example: { user: 'u' } } });

    expect(seen).toEqual([{ example: { user: 'u' } }]);
  });

  test('stops provider waits only when the caller cancels', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled by user');

    const model = stacked(asFetchFunction(async () => new Response('limited', { status: 429 })), {
      sleep: async () => { controller.abort(reason); },
      pacer: new ProviderPacer({ sleep: async () => {} }),
    });

    await expect(called(model, undefined, controller.signal)).rejects.toBe(reason);
  });

  test('returns success after two rate-limited responses', async () => {
    const harness = retryHarness([new Response('limited', { status: 429 }), new Response('limited', { status: 429 }), answer()]);

    expect(await harness.call()).toBe('ok');
    expect(harness.calls()).toBe(3);
    expect(harness.waits).toEqual([1_000, 2_000]);
  });

  test('529 and an overloaded 503 are waited as limits; any other retryable failure backs off without cooling the lane', async () => {
    const retrying = retryHarness([
      new Response('capacity unavailable', { status: 529 }),
      new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), { status: 503 }),
      answer(),
    ]);

    expect(await retrying.call()).toBe('ok');
    expect(retrying.calls()).toBe(3);

    let nowMs = 1_000_000;
    const pacer = new ProviderPacer({ now: () => nowMs, sleep: async (ms) => { nowMs += ms; } });
    const answers = [new Response('maintenance', { status: 503 }), answer()];
    let calls = 0;
    const model = stacked(asFetchFunction(async () => answers[calls++]), { now: () => nowMs, sleep: async () => {}, pacer, random: () => 0.5 });

    expect(await called(model)).toBe('ok');
    expect({ calls, declared: pacer.declareWait(LANE, 1) !== null }).toEqual({ calls: 2, declared: true });
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
      const harness = retryHarness([new Response(body, { status: 429, headers: { 'content-type': 'application/json' } }), answer()]);

      const failure = await rejectionOf(() => harness.call());

      expect({ provider, calls: harness.calls(), waits: harness.waits }).toEqual({ provider, calls: 1, waits: [] });
      expect({ provider, code: classifyErrorCode({ cause: failure }) }).toEqual({ provider, code: 'budget' });
      expect(describeProviderError({ cause: failure })).toContain('HTTP 429');
    }
  });

  test('a spent Workers AI allocation is read through Kinu\'s own Cloudflare error mapping too', async () => {
    let sent = 0;

    // The OAuth route maps Cloudflare's envelope into the OpenAI shape the SDK reads, its code as text.
    const fetch = asFetchFunction(async () => {
      sent += 1;

      return Response.json({ success: false, errors: [{ code: 3036, message: 'You have used up your daily free allocation of 10,000 neurons.' }] }, { status: 429 });
    });

    const model = withModelStack(createWorkersAIProvider().createModel('@cf/moonshotai/kimi-k2.6', {
      env: {}, sessionAffinity: 'kinu-test', fetch, hasCredential: async () => true,
      getAuth: async () => ({ headers: { authorization: 'Bearer cf' }, baseURL: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1' }),
    }), { provider: 'workers-ai', lane: LANE, sleep: async () => {}, pacer: new ProviderPacer({ sleep: async () => {} }) });

    const failure = await rejectionOf(() => called(model));

    expect({ sent, code: classifyErrorCode({ cause: failure }) }).toEqual({ sent: 1, code: 'budget' });
  });

  test('a quota 429 keeps the provider message and code for the user', async () => {
    const harness = retryHarness([new Response(OPENAI_QUOTA, { status: 429 }), answer()]);
    const failure = await rejectionOf(() => harness.call());

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
      const harness = retryHarness([new Response(body, { status: 429 }), answer()]);

      expect({ provider, text: await harness.call(), calls: harness.calls() }).toEqual({ provider, text: 'ok', calls: 2 });
    }
  });

  // OpenCode Go's spent window, kinu.run 2026-09-24.
  const SPENT_WINDOW_BODY = JSON.stringify({ error: { message: 'Monthly usage limit reached.', type: 'rate_limit_error' } });

  test('a Retry-After past the longest wait ends the call as spent, naming the provider, reset time and message', async () => {
    const harness = retryHarness(
      [new Response(SPENT_WINDOW_BODY, { status: 429, headers: { 'Retry-After': '729883' } }), answer()],
      { provider: 'opencode-go' },
    );

    const failure = await rejectionOf(() => harness.call());
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
      answer(),
    ]);

    const failure = await rejectionOf(() => far.call());

    expect({ calls: far.calls(), waits: far.waits, code: classifyErrorCode({ cause: failure }) }).toEqual({ calls: 1, waits: [], code: 'budget' });

    const edge = retryHarness([new Response('limited', { status: 529, headers: { 'Retry-After': new Date(1_060_000).toUTCString() } }), answer()]);

    expect(await edge.call()).toBe('ok');
    expect(edge.waits).toEqual([60_000]);
  });

  test('a sibling on the same lane ends at once on a declared wait past the longest wait, never parking', async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const parked: number[] = [];
    const pacer = new ProviderPacer({ now, sleep: async (ms) => { parked.push(ms); nowMs += ms; } });
    let sent = 0;

    const model = stacked(asFetchFunction(async () => {
      sent++;

      return sent === 1 ? new Response(SPENT_WINDOW_BODY, { status: 429, headers: { 'Retry-After': '729883' } }) : answer();
    }), { now, pacer, provider: 'opencode-go', sleep: async (ms) => { parked.push(ms); } });

    await rejectionOf(() => called(model));
    const sibling = await rejectionOf(() => called(model));

    expect({ sent, parked, code: classifyErrorCode({ cause: sibling }) }).toEqual({ sent: 1, parked: [], code: 'budget' });
    expect(describeProviderError({ cause: sibling })).toContain('Monthly usage limit reached.');
  });

  test('the SDK neither retries a quota 429 nor loses its class on the way to the caller', async () => {
    let requests = 0;

    const model = stacked(asFetchFunction(async () => {
      requests++;

      return requests === 1 ? new Response(OPENAI_QUOTA, { status: 429, headers: { 'content-type': 'application/json' } }) : answer();
    }), { pacer: new ProviderPacer({ sleep: async () => {} }), sleep: async () => {} });

    const failure = await rejectionOf(() => called(model));

    expect(requests).toBe(1);
    expect(toProviderError({ doing: 'calling the model', cause: failure }).code).toBe('budget');
  });
});
