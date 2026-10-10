import { expect, test } from 'bun:test';
import type { RunEvent } from '@kinu.run/core';
import { measurePlanUsage, measurePromptUsage, steadyCacheP5, steadyCacheShare, type StepUsage } from './results';

const events: [RunEvent, RunEvent] = [
  { type: 'step_finish', parts: [], runId: 'trial-run', eventIndex: 1, stepIndex: 1, timestamp: '2026-10-02T19:00:00Z', usage: { input: 100, cacheRead: 20, output: 10 } },
  { type: 'step_finish', parts: [], runId: 'trial-run', eventIndex: 2, stepIndex: 2, timestamp: '2026-10-02T19:00:01Z', usage: { input: 200, cacheRead: 180, output: 30 } },
];

test('a trial records exact provider usage per request and Activity’s cache statistics', () => {
  const usage = measurePromptUsage([{ actor: 'main', events }]);

  expect(usage.metadata.steps).toMatchObject([
    { runId: 'trial-run', stepIndex: 1, inputTokens: 100, cacheReadTokens: 20, outputTokens: 10 },
    { runId: 'trial-run', stepIndex: 2, inputTokens: 200, cacheReadTokens: 180, outputTokens: 30 },
  ]);
  expect(usage).toMatchObject({ inputTokens: 300, outputTokens: 40, metadata: { cacheReadTokens: 200,
    cache: { hitShare: 2 / 3, p95: 0.9, p99: 0.9, samples: 2 } } });
  expect(usage.metadata.cache?.ema).toBeCloseTo(0.34, 14);
});

test('a partial provider report keeps totals unknown, while reported cache zeros remain real samples', () => {
  const usage = measurePromptUsage([{ actor: 'main', events: [
    { type: 'step_finish', parts: [], runId: 'partial', eventIndex: 1, stepIndex: 1, timestamp: '2026-10-02T19:00:00Z', usage: { input: 100, cacheRead: 0, output: 0 } },
    { type: 'step_finish', parts: [], runId: 'partial', eventIndex: 2, stepIndex: 2, timestamp: '2026-10-02T19:00:01Z', usage: { input: 200 } },
  ] }]);

  expect(usage.inputTokens).toBe(300);
  expect(usage.outputTokens).toBeUndefined();
  expect(usage.metadata.cacheReadTokens).toBeUndefined();
  expect(usage.metadata.steps[1]).toMatchObject({ cacheReadTokens: null, outputTokens: null });
  expect(usage.metadata.cache).toEqual({ hitShare: null, ema: 0, p95: 0, p99: 0, samples: 1 });
});

test('requests from separate actors retain their identities and use chronological Activity statistics', () => {
  const usage = measurePromptUsage([
    { actor: 'helper', events: [events[1]] },
    { actor: 'main', events: [events[0]] },
  ]);

  expect(usage.metadata.steps.map(({ actor, runId, stepIndex }) => ({ actor, runId, stepIndex }))).toEqual([
    { actor: 'main', runId: 'trial-run', stepIndex: 1 }, { actor: 'helper', runId: 'trial-run', stepIndex: 2 },
  ]);
  expect(usage.inputTokens).toBe(300);
  expect(usage.outputTokens).toBe(40);
  expect(usage.metadata.cache?.ema).toBeCloseTo(0.34, 14);
});

// A whole request read from nothing is what the token-weighted share hides and the fifth percentile shows.
test('the steady cache leaves each actor\u2019s first request out, and its p5 names a whole request that missed', () => {
  const step = (actor: string, index: number, inputTokens: number, cacheReadTokens: number): StepUsage => ({
    actor, timestamp: `2026-10-08T00:00:${String(index).padStart(2, '0')}Z`, runId: 'run', stepIndex: index,
    inputTokens, outputTokens: 10, cacheReadTokens, cacheWriteTokens: 0,
  });

  const warm = Array.from({ length: 19 }, (_, index) => step('main', index + 1, 1000, 990));
  const runs = [[step('main', 0, 1000, 0), ...warm, step('main', 20, 1000, 0)], [step('helper', 0, 1000, 0)]];

  expect(steadyCacheShare(runs)).toBeCloseTo((19 * 990) / 20_000, 12);
  expect(steadyCacheP5(runs)).toBe(0);
  expect(steadyCacheP5([[step('main', 0, 1000, 0), ...warm]])).toBe(0.99);
  expect(steadyCacheP5([[step('main', 0, 1000, 0)]])).toBeNull();
});

test('a plan window is read from the first call\u2019s quota to the last call\u2019s, per account and window', () => {
  const finish = (index: number, at: number, usedPercent: number): RunEvent => ({ type: 'step_finish', parts: [], runId: 'run', eventIndex: index, stepIndex: index, timestamp: '2026-10-08T00:00:00Z',
  account: { provider: 'chatgpt', name: 'owner', quota: { at, windows: [{ measure: 'primary', usedPercent }, { measure: 'tokens' }] } }, });

  expect(measurePlanUsage([{ actor: 'main', events: [finish(2, 2000, 14), finish(1, 1000, 12)] }, { actor: 'helper', events: [finish(3, 3000, 15)] }]))
    .toEqual([{ account: 'chatgpt@owner', measure: 'primary', from: 12, to: 15 }]);
});
