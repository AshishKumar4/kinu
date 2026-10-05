import { expect, test } from 'bun:test';
import type { RunEvent } from '@kinu.run/core';
import { measurePromptUsage } from './results';

const events: [RunEvent, RunEvent] = [
  { type: 'step_finish', runId: 'trial-run', eventIndex: 1, stepIndex: 1, timestamp: '2026-10-02T19:00:00Z', usage: { input: 100, cacheRead: 20, output: 10 } },
  { type: 'step_finish', runId: 'trial-run', eventIndex: 2, stepIndex: 2, timestamp: '2026-10-02T19:00:01Z', usage: { input: 200, cacheRead: 180, output: 30 } },
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
    { type: 'step_finish', runId: 'partial', eventIndex: 1, stepIndex: 1, timestamp: '2026-10-02T19:00:00Z', usage: { input: 100, cacheRead: 0, output: 0 } },
    { type: 'step_finish', runId: 'partial', eventIndex: 2, stepIndex: 2, timestamp: '2026-10-02T19:00:01Z', usage: { input: 200 } },
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
