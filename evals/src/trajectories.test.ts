import { expect, test } from 'bun:test';
import type { StepUsage } from './results';
import { renderTrajectories } from './trajectories';

/** One turn's checks as a transcript renders them. */
type Turned = { id: string; pass: boolean; graded?: false; unjudged?: true; evidence?: string };

function trajectory(step: Pick<StepUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>, checks: readonly Turned[] = []): string {
  return renderTrajectories(JSON.stringify({ testResults: [{
    name: 'task.eval.ts',
    assertionResults: [{
      status: 'passed', duration: 60_000,
      meta: { harness: { run: {
        session: { metadata: { taskId: 'task', taskVersion: 'v', evalCommit: 'e', productSha: 'p', arm: 'product', trial: 1 } },
        usage: { model: 'test/model', metadata: { steps: [{ actor: 'main', timestamp: '2026-10-02T19:00:00Z', runId: 'run-1', stepIndex: 0, outputTokens: 10, ...step }] } },
        output: {
          metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 },
          turns: checks.length === 0 ? [] : [{ part: 'build', turn: 1, outcome: { status: 'completed' }, checks }],
        },
        errors: [],
      } } },
    }],
  }] }));
}

test.each([
  { name: 'complete counts', inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 20, uncached: '20' },
  { name: 'reported cache zeros', inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, uncached: '100' },
  { name: 'unreported prompt', inputTokens: null, cacheReadTokens: 60, cacheWriteTokens: 20, uncached: '\u2014' },
  { name: 'unreported cache read', inputTokens: 100, cacheReadTokens: null, cacheWriteTokens: 20, uncached: '\u2014' },
  { name: 'unreported cache write', inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: null, uncached: '\u2014' },
])('uncached tokens: $name', ({ inputTokens, cacheReadTokens, cacheWriteTokens, uncached }) => {
  const text = trajectory({ inputTokens, cacheReadTokens, cacheWriteTokens });

  expect(text).toContain(`${uncached} uncached`);
});

// 2026-10-21: the vision judge's ten failed calls were recorded, and read in every transcript, as ten noes.
test('a recorded judgement that could not be had reads unjudged, beside a recorded yes and no', () => {
  const step = { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 20 };

  const text = trajectory(step, [
    { id: 'tower-in-frame', pass: false, graded: false, unjudged: true, evidence: '429 usage limit' },
    { id: 'standing-on-top', pass: false, graded: false },
    { id: 'refused-at-the-box', pass: true, graded: false },
  ]);

  expect(text.split('\n').filter((line) => line.startsWith('- recorded'))).toEqual([
    '- recorded `tower-in-frame` (unjudged): `429 usage limit`',
    '- recorded `standing-on-top` (no)',
    '- recorded `refused-at-the-box` (yes)',
  ]);
});
