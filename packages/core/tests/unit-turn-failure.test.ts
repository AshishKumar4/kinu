// The closed turn-failure classifier + the shared overflow-recovery decision
// (turn-failure.ts). The size heuristic is deliberately fed the PER-REQUEST
// measured prompt (lastPromptTokens), never a turn's cumulative input —
// production-proven on workspace-1a4e20, where a 429 after 1.5M CUMULATIVE
// tokens (per-request ~60k against a 128k window) is a real rate limit that
// must NOT force-compact.
import { describe, test, expect } from 'bun:test';
import {
  classifyTurnFailure,
  planOverflowRecovery,
  OVERFLOW_RETRY_EVENT,
  OVERFLOW_RETRY_TEXT,
} from '../src/index.ts';

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

  test('transient: anything else stays unclassified noise', () => {
    for (const error of ['ECONNRESET', 'stream error', 'Internal Server Error', '']) {
      expect(classifyTurnFailure(error)).toBe('transient');
    }
  });

  test('size heuristic: a rate limit at >50% window on the PER-REQUEST prompt is context-class', () => {
    const rateLimited = 'Failed after 3 attempts. Last error: Too Many Requests';
    expect(classifyTurnFailure(rateLimited, { lastPromptTokens: 70_000, contextWindow: 128_000 }))
      .toBe('context_length');
    // The production case: per-request ~60k of a 128k window (the turn's
    // CUMULATIVE 1.5M is never passed here) — a genuine throughput limit.
    expect(classifyTurnFailure(rateLimited, { lastPromptTokens: 60_000, contextWindow: 128_000 }))
      .toBe('rate_limit');
    // Missing signals leave the heuristic off.
    expect(classifyTurnFailure(rateLimited, { lastPromptTokens: 0, contextWindow: 128_000 }))
      .toBe('rate_limit');
    expect(classifyTurnFailure(rateLimited, { lastPromptTokens: 70_000 })).toBe('rate_limit');
  });
});

describe('planOverflowRecovery', () => {
  test('context_length failure → force compaction + ONE retry', () => {
    expect(planOverflowRecovery({
      error: 'context_length_exceeded',
      lastPromptTokens: 120_000,
      contextWindow: 128_000,
      turnWasOverflowRetry: false,
    })).toEqual({ failureClass: 'context_length', forceCompaction: true, enqueueRetry: true });
  });

  test('a failed retry turn re-arms compaction but NEVER enqueues another retry', () => {
    expect(planOverflowRecovery({
      error: 'context_length_exceeded',
      lastPromptTokens: 120_000,
      contextWindow: 128_000,
      turnWasOverflowRetry: true,
    })).toEqual({ failureClass: 'context_length', forceCompaction: true, enqueueRetry: false });
  });

  test('rate limits and transient failures never force-compact', () => {
    expect(planOverflowRecovery({
      error: 'Too Many Requests', lastPromptTokens: 60_000, contextWindow: 128_000, turnWasOverflowRetry: false,
    })).toEqual({ failureClass: 'rate_limit', forceCompaction: false, enqueueRetry: false });
    expect(planOverflowRecovery({
      error: 'ECONNRESET', turnWasOverflowRetry: false,
    })).toEqual({ failureClass: 'transient', forceCompaction: false, enqueueRetry: false });
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
