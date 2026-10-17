import { describe, expect, test } from 'bun:test';
import type { TimelineEntry } from './timeline';
import { attemptTiming, buckets, trialTiming, type LedgerRow } from './timing';

const chunk = (type: string, at: number, until = at): TimelineEntry => ({ at, until, mark: `chunk:${type}`, count: 1 });

const span = (mark: string, at: number, until: number): TimelineEntry => ({ at, until, mark });

/** One turn of two steps: the first waits out a 429, streams, then runs a tool; the second answers. */
const TIMELINE: TimelineEntry[] = [
  span('open', 0, 1_000),
  { at: 1_000, mark: 'turn', detail: { index: 0 } },
  span('prompt', 1_000, 20_000),
  chunk('start', 1_500),
  chunk('start-step', 4_000),
  chunk('reasoning-start', 4_000),
  chunk('tool-input-delta', 5_000, 9_000),
  chunk('tool-input-available', 9_000),
  chunk('tool-output-available', 12_000),
  chunk('finish-step', 12_100),
  chunk('start-step', 13_000),
  chunk('text-delta', 13_000, 19_000),
  chunk('finish-step', 19_500),
  chunk('done', 20_000),
  span('settle', 20_000, 22_000),
  { at: 20_500, mark: 'poll', detail: { busy: true } },
  { at: 21_000, mark: 'poll', detail: { busy: false } },
  { at: 22_000, mark: 'poll', detail: { busy: false } },
  span('verify', 22_000, 25_000),
  { at: 25_000, mark: 'close' },
  span('teardown', 25_000, 26_000),
];

const LEDGER: LedgerRow[] = [
  { type: 'run_start', runId: 'r1', eventIndex: 0, userMessage: 'build it' },
  { type: 'provider_wait', runId: 'r1', eventIndex: 1, waitMs: 2_000 },
  { type: 'tool_call_end', runId: 'r1', eventIndex: 2, durationMs: 2_900 },
  { type: 'step_finish', parts: [], runId: 'r1', eventIndex: 3, usage: { output: 400, reasoning: 100 } },
  { type: 'step_finish', parts: [], runId: 'r1', eventIndex: 4, usage: { output: 600 } },
  { type: 'run_end', runId: 'r1', eventIndex: 5 },
];

describe('where a trial\'s time went', () => {
  test('every millisecond of the wall lands in one bucket, with the model, the waits and the tools apart', () => {
    const timing = trialTiming(TIMELINE, LEDGER);
    const split = buckets(timing);

    expect(timing.wallMs).toBe(26_000);
    expect(timing.unpairedSteps).toBe(0);
    expect(split).toMatchObject({
      'product: prompt to the turn\'s stream': 500,
      'provider waits': 2_000,
      'product and model: step request to first token': 500 + 900,
      'model: generation': 5_000 + 6_000,
      tools: 3_000,
      'product: step close': 100 + 500,
      'product: last step to the turn\'s end': 500,
      'product: still working after the turn\'s stream ended': 500,
      'harness: open': 1_000, 'harness: settle': 1_500, 'harness: verify': 3_000, 'harness: teardown': 1_000,
    });
    expect(timing.turns[0]?.steps.map((step) => step.outputTokens)).toEqual([400, 600]);
    expect(split.unattributed).toBe(0);
  });

  test('a turn replayed after a redial is timed up to the replay, never by its arrival all at once', () => {
    const replayed = [...TIMELINE.slice(0, 10), chunk('replay', 12_500, 12_600), ...TIMELINE.slice(10)];

    expect(trialTiming(replayed, LEDGER).turns[0]?.steps).toHaveLength(1);
  });
});

describe('the product\'s own clock on each request', () => {
  test('splits headers, first output and generation, and between answers the tools, the waits and the product', () => {
    const at = (ms: number): string => new Date(Date.UTC(2026, 9, 17) + ms).toISOString();

    const ledger: LedgerRow[] = [
      { type: 'model_attempt', runId: 'r1', eventIndex: 1, timestamp: at(6_000), sentAt: at(0), headersMs: 300, firstOutputMs: 1_200, lastOutputMs: 6_000, outcome: 'answered' },
      // Two tools side by side, 6.1-8.1 s and 7.1-8.1 s, cover 2 s of the 2.5 s before the next request.
      { type: 'tool_call_end', runId: 'r1', eventIndex: 2, timestamp: at(8_100), durationMs: 2_000 },
      { type: 'tool_call_end', runId: 'r1', eventIndex: 3, timestamp: at(8_100), durationMs: 1_000 },
      { type: 'model_attempt', runId: 'r1', eventIndex: 4, timestamp: at(8_800), sentAt: at(8_500), outcome: 'refused' },
      { type: 'provider_wait', runId: 'r1', eventIndex: 5, timestamp: at(8_800), waitMs: 1_000 },
      { type: 'model_attempt', runId: 'r1', eventIndex: 6, timestamp: at(13_000), sentAt: at(10_000), headersMs: 200, firstOutputMs: 900, lastOutputMs: 3_000, outcome: 'answered' },
      // Another run's request is between nothing of this one's.
      { type: 'model_attempt', runId: 'r2', eventIndex: 1, timestamp: at(9_000), sentAt: at(7_000), headersMs: 100, firstOutputMs: 400, lastOutputMs: 2_000, outcome: 'answered' },
    ];

    expect(attemptTiming(ledger)).toEqual({
      attempts: 4, outcomes: { answered: 3, refused: 1 }, headersMs: [300, 200, 100], firstOutputMs: [1_200, 900, 400],
      generationMs: 4_800 + 2_100 + 1_600, betweenMs: 2_500 + 1_200, toolsMs: 2_000, waitMs: 1_000, otherMs: 500 + 200,
    });
  });

  test('counts a tool that ran while the answer still streamed only for its time after the answer ended', () => {
    const at = (ms: number): string => new Date(Date.UTC(2026, 9, 17) + ms).toISOString();

    const ledger: LedgerRow[] = [
      // The tool ran 4-7 s, recorded before the request it ran under ended at 6 s.
      { type: 'tool_call_end', runId: 'r1', eventIndex: 1, timestamp: at(7_000), durationMs: 3_000 },
      { type: 'model_attempt', runId: 'r1', eventIndex: 2, timestamp: at(7_000), sentAt: at(0), firstOutputMs: 1_000, lastOutputMs: 6_000, outcome: 'answered' },
      { type: 'model_attempt', runId: 'r1', eventIndex: 3, timestamp: at(9_000), sentAt: at(8_000), firstOutputMs: 500, lastOutputMs: 1_000, outcome: 'answered' },
    ];

    expect(attemptTiming(ledger)).toMatchObject({ betweenMs: 2_000, toolsMs: 1_000, otherMs: 1_000 });
  });
});
