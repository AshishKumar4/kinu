// The size heuristic is fed the per-request measured prompt (lastPromptTokens), never the turn's cumulative
// input: a cumulative-sized 429 is a real rate limit that must not force-compact.
import { describe, test, expect } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import { toProviderError } from '../src/providers/util';
import {
  classifyTurnFailure,
  statedContextLimit,
  planOverflowRecovery,
  OVERFLOW_RETRY_EVENT,
  OVERFLOW_RETRY_TEXT,
} from '../src/index';

describe('classifyTurnFailure', () => {
  test('context_length: the provider phrasings for an oversized request', () => {
    for (const error of [
      'context_length_exceeded',
      "This model's maximum context length is 128000 tokens",
      'Request contains too many tokens',
      'string too long. Expected a string with maximum length 1048576',
      'prompt is too long: 210000 tokens > 200000 maximum',
      'input is too long for requested model',
      'The request exceeds the maximum context window of this model',
      'Bad Request: context window overflow',
      'Request too large for gpt-5',
    ]) {
      expect(classifyTurnFailure(error)).toBe('context_length');
    }
  });

  test('rate_limit: 429s and throughput phrasings', () => {
    for (const error of [
      'Failed after 3 attempts. Last error: Too Many Requests',
      'HTTP 429',
      'Rate limit reached for requests',
      'rate_limit_error',
      'quota exceeded for this billing period',
    ]) {
      expect(classifyTurnFailure(error)).toBe('rate_limit');
    }
  });

  test('auth: a dead or revoked credential is its own class, not noise', () => {
    for (const error of [
      // The bare upstream word Cloudflare answers a rejected credential with (audit 2.15).
      'Unauthorized',
      'Your Cloudflare login is no longer valid. Reconnect Cloudflare in User settings.',
      'Your ChatGPT login is no longer valid.',
      'Codex token refresh failed: 400 {"error":"invalid_grant","error_description":"The provided authorization grant is invalid"}',
      'Invalid API key provided',
      'ChatGPT credentials are not configured for this account.',
    ]) {
      expect(classifyTurnFailure(error)).toBe('auth');
    }
  });

  test('transient: anything else stays unclassified noise', () => {
    for (const error of ['ECONNRESET', 'stream error', 'Internal Server Error', '']) {
      expect(classifyTurnFailure(error)).toBe('transient');
    }
  });

  test('size heuristic: a rate limit at >50% window on the PER-REQUEST prompt is context-class', () => {
    const rateLimited = 'Failed after 3 attempts. Last error: Too Many Requests';
    expect(classifyTurnFailure(rateLimited, { lastPromptTokens: 70_000, contextWindow: 128_000 }))
      .toBe('context_length');
    expect(classifyTurnFailure(rateLimited, { lastPromptTokens: 60_000, contextWindow: 128_000 }))
      .toBe('rate_limit');
    expect(classifyTurnFailure(rateLimited, { lastPromptTokens: 0, contextWindow: 128_000 }))
      .toBe('rate_limit');
    expect(classifyTurnFailure(rateLimited, { lastPromptTokens: 70_000 })).toBe('rate_limit');
  });
});

function apiError(statusCode: number, message: string): APICallError {
  return new APICallError({ message, url: 'https://api.example.test/v1/messages', requestBodyValues: {}, statusCode });
}

/** A provider's HTTP refusal as a turn throws it: `toProviderError` over the SDK's error. */
function refused(statusCode: number, message: string): Error {
  return toProviderError({ doing: 'calling the model', cause: apiError(statusCode, message) });
}

const OVERSIZED = { lastPromptTokens: 70_000, contextWindow: 128_000 };

describe('classifyTurnFailure on a provider refusal reads its status', () => {
  // 429 is a rate limit, unless no wait cures it; 413 is too long; 400 only by its text; 401/403 auth; 5xx transient.
  test.each([
    [429, 'Tokens per minute limit exceeded - too many tokens processed.', {}, 'rate_limit'],
    [429, 'Rate limit of 40,000 input tokens per minute; the context window is 200,000.', {}, 'rate_limit'],
    [429, 'Request too large for gpt-5 in organization org-1 on tokens per min (TPM): Limit 30000, Requested 36000.', {}, 'context_length'],
    [413, 'Request Entity Too Large', {}, 'context_length'],
    [400, 'prompt is too long: 213432 tokens > 200000 maximum', {}, 'context_length'],
    [400, 'messages: text content blocks must be non-empty', {}, 'transient'],
    [403, 'Your API key does not have permission to use the specified resource.', {}, 'auth'],
    [503, 'upstream rate limit reached', OVERSIZED, 'transient'],
  ] as const)('%i %s', (status, message, signals, expected) => {
    expect(classifyTurnFailure(refused(status, message), signals)).toBe(expected);
  });

  test('a 429 after the SDK retries is read through its last attempt', () => {
    const throttled = 'Tokens per minute limit exceeded - too many tokens processed.';
    const attempts = [apiError(429, throttled), apiError(429, throttled)];
    const retried = new RetryError({ message: `Failed after 2 attempts. Last error: ${throttled}`, reason: 'maxRetriesExceeded', errors: attempts });
    const exhausted = toProviderError({ doing: 'calling the model', cause: retried });

    expect([classifyTurnFailure(exhausted), classifyTurnFailure(exhausted, OVERSIZED)]).toEqual(['rate_limit', 'context_length']);
  });

  test('planOverflowRecovery takes the thrown failure', () => {
    expect([refused(429, 'too many tokens'), refused(400, "This model's maximum context length is 128000 tokens")]
      .map((error) => planOverflowRecovery({ error, turnWasOverflowRetry: false })))
      .toEqual([
        { failureClass: 'rate_limit', forceCompaction: false, enqueueRetry: false },
        { failureClass: 'context_length', forceCompaction: true, enqueueRetry: true },
      ]);
  });
});

// The window a too-long refusal measures for the session, in each provider's own wording.
describe('statedContextLimit', () => {
  test.each([
    ["This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.", 128_000],
    ['prompt is too long: 213432 tokens > 200000 maximum', 200_000],
    ['The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', 1_048_576],
    ['Request exceeds the context window of 131,072 tokens', 131_072],
    ['context_length_exceeded: prompt is too long', null],
  ])('%s', (error, limit) => {
    expect(statedContextLimit(error)).toBe(limit);
  });
});

describe('planOverflowRecovery', () => {
  // An overflow always re-arms compaction; only the first one buys a retry.
  const overflowCases = [
    { name: 'context_length failure → force compaction + ONE retry', wasRetry: false, enqueueRetry: true },
    { name: 'a failed retry turn re-arms compaction but NEVER enqueues another retry', wasRetry: true, enqueueRetry: false },
  ];

  for (const c of overflowCases) {
    test(c.name, () => {
      expect(planOverflowRecovery({
        error: 'context_length_exceeded',
        lastPromptTokens: 120_000,
        contextWindow: 128_000,
        turnWasOverflowRetry: c.wasRetry,
      })).toEqual({ failureClass: 'context_length', forceCompaction: true, enqueueRetry: c.enqueueRetry });
    });
  }

  test('rate limits and transient failures never force-compact', () => {
    expect(planOverflowRecovery({
      error: 'Too Many Requests', lastPromptTokens: 60_000, contextWindow: 128_000, turnWasOverflowRetry: false,
    })).toEqual({ failureClass: 'rate_limit', forceCompaction: false, enqueueRetry: false });
    expect(planOverflowRecovery({
      error: 'ECONNRESET', turnWasOverflowRetry: false,
    })).toEqual({ failureClass: 'transient', forceCompaction: false, enqueueRetry: false });
  });

  test('an auth failure never force-compacts and never enqueues a retry', () => {
    expect(planOverflowRecovery({
      error: 'Your Cloudflare login is no longer valid. Reconnect Cloudflare in User settings.',
      turnWasOverflowRetry: false,
    })).toEqual({ failureClass: 'auth', forceCompaction: false, enqueueRetry: false });
  });

  test('no error text → no decision', () => {
    expect(planOverflowRecovery({ error: undefined, turnWasOverflowRetry: false }))
      .toEqual({ failureClass: null, forceCompaction: false, enqueueRetry: false });
  });

  test('retry-turn constants are stable wire values', () => {
    expect(OVERFLOW_RETRY_EVENT).toBe('overflow_retry');
    expect(OVERFLOW_RETRY_TEXT).toContain('compacted');
  });
});
