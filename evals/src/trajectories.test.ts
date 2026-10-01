import { expect, test } from 'bun:test';
import type { StepUsage } from './results';
import { renderTrajectories } from './trajectories';

function trajectory(step: Pick<StepUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): string {
  return renderTrajectories(JSON.stringify({ testResults: [{
    name: 'task.eval.ts',
    assertionResults: [{
      status: 'passed', duration: 60_000,
      meta: { harness: { run: {
        session: { metadata: { taskId: 'task', taskVersion: 'v', evalCommit: 'e', productSha: 'p', arm: 'product', trial: 1 } },
        usage: { model: 'test/model', metadata: { steps: [{ runId: 'run-1', stepIndex: 0, ...step }] } },
        output: { metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, providerWaits: 0, providerWaitMs: 0 }, turns: [] },
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
