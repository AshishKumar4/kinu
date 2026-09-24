/**
 * Accumulation, draining, and the absence rules of live-model spend reporting.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import type { LanguageModelUsage } from 'ai';
import { cloudProxyBaseURL } from '@kinu.run/core';
import {
  liveModelSpend, recordLiveModelSpend, reportLiveModelSpend, resetLiveModelSpend, workerSession,
} from '../src/live-model';

// Module-level counters: each case starts from a stated zero.
beforeEach(() => { resetLiveModelSpend(); });

/** Provider usage in the AI SDK shape; `undefined` means the provider omitted the count. */
function sdkUsage(input: number | undefined, output: number | undefined): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined,
    },
    outputTokens: output,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: input === undefined || output === undefined ? undefined : input + output,
  };
}

describe('recordLiveModelSpend — one call at a time', () => {
  test('a reported call adds its tokens and counts once', () => {
    recordLiveModelSpend(sdkUsage(100, 10));
    const spend = liveModelSpend();
    expect(spend.calls).toBe(1);
    expect(spend.callsWithoutUsage).toBe(0);
    expect(spend.usage.input).toBe(100);
    expect(spend.usage.output).toBe(10);
  });

  test('a call the provider reported nothing for is counted, never priced at zero', () => {
    recordLiveModelSpend(undefined);
    const spend = liveModelSpend();
    // The call happened; its cost is unknown.
    expect(spend.calls).toBe(1);
    expect(spend.callsWithoutUsage).toBe(1);
    // Absent, not 0: `input: 0` would read as a measured zero.
    expect(spend.usage.input).toBeUndefined();
    expect(spend.usage.output).toBeUndefined();
  });

  test('a partial report contributes only the field the provider sent', () => {
    recordLiveModelSpend(sdkUsage(undefined, 7));
    const spend = liveModelSpend();
    // Something was reported, so this is not an unmeasured call...
    expect(spend.callsWithoutUsage).toBe(0);
    expect(spend.usage.output).toBe(7);
    // ...but the omitted side stays omitted; `+= input ?? 0` would fabricate a measurement.
    expect(spend.usage.input).toBeUndefined();
  });
});

describe('reportLiveModelSpend — a line is the suite\'s own spend, not a running total', () => {
  test('reporting drains, so two suites in one process do not double-count', () => {
    // `bun test ./tests/` runs every root suite in one process against this module-level meter.
    recordLiveModelSpend(sdkUsage(100, 10));
    const first = reportLiveModelSpend('Suite A');
    expect(first.calls).toBe(1);
    expect(first.usage.input).toBe(100);

    const second = reportLiveModelSpend('Suite B');
    // An undrained meter would repeat suite A's spend here, and `totalSpend` sums the lines.
    expect(second.calls).toBe(0);
    expect(second.usage.input).toBeUndefined();
  });

  test('spend recorded after a report belongs to the next report', () => {
    recordLiveModelSpend(sdkUsage(100, 10));
    reportLiveModelSpend('Suite A');
    recordLiveModelSpend(sdkUsage(5, 1));

    const second = reportLiveModelSpend('Suite B');
    // The two lines partition the process's calls.
    expect(second.calls).toBe(1);
    expect(second.usage.input).toBe(5);
  });

  test('the returned line is the shape the aggregate parses', () => {
    recordLiveModelSpend(undefined);
    const total = reportLiveModelSpend('Suite A');
    // `scripts/eval-spend.ts` parses exactly these four fields.
    expect(Object.keys(total).sort())
      .toEqual(['calls', 'callsWithoutUsage', 'episodesUnmeasured', 'episodesWithoutModel', 'usage']);
  });
});

describe('resetLiveModelSpend — a scripted suite clears instead of publishing', () => {
  test('reset returns every counter to its stated zero', () => {
    recordLiveModelSpend(sdkUsage(100, 10));
    recordLiveModelSpend(undefined);
    resetLiveModelSpend();

    const spend = liveModelSpend();
    expect(spend.calls).toBe(0);
    expect(spend.callsWithoutUsage).toBe(0);
    expect(spend.episodesUnmeasured).toBe(0);
    // Cleared to absent, so a later report cannot inherit a zero that reads as measured.
    expect(spend.usage.input).toBeUndefined();
  });

  test('a fresh meter reports the one honest zero: nothing ran and nothing is missing', () => {
    const spend = liveModelSpend();
    expect(spend.calls).toBe(0);
    // The only state in which a clean zero is true.
    expect(spend.episodesUnmeasured).toBe(0);
  });
});

describe('workerSession — the deployment behind a worker-proxy target', () => {
  test('a base URL built by cloudProxyBaseURL recovers its origin and bearer', () => {
    // workerSession inverts cloudProxyBaseURL; both use one route constant.
    const origin = 'https://staging.example';

    const session = workerSession({
      name: 'workers-ai',
      baseURL: cloudProxyBaseURL(origin),
      headers: { Authorization: 'Bearer token-1' },
      model: 'model-1',
    });

    expect(session.origin).toBe(origin);
    expect(session.token).toBe('token-1');
  });

  test('a target fronting a model and no deployment is refused, not misrouted', () => {
    expect(() => workerSession({
      name: 'openai',
      baseURL: 'https://api.example/v1',
      headers: { Authorization: 'Bearer token-1' },
      model: 'model-1',
    })).toThrow('is not a worker AI-proxy base URL');
  });
});
