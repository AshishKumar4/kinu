// The compaction prompt's inputs and the [CONTEXT CHECKPOINT] wrapper.
import { describe, test, expect } from 'bun:test';
import {
  buildCompactionSummaryPrompt,
  wrapCompactionSummary,
  stripCheckpointPreamble,
  CONTEXT_CHECKPOINT_PREFIX,
} from '../src/compaction';

describe('buildCompactionSummaryPrompt', () => {
  test('hands the latest user ask in directly so verbatim copying is mechanical', () => {
    const ask = 'Deploy the staging worker and tell me the preview URL';
    expect(buildCompactionSummaryPrompt({ transcript: 't', latestUserAsk: ask, budgetTokens: 500 })).toContain(ask);
  });

  test('an iterative update carries the previous summary and the new turns', () => {
    const prompt = buildCompactionSummaryPrompt({
      transcript: 'new turns here',
      previousSummary: '## Active Task\nOld task body',
      budgetTokens: 800,
    });

    expect(prompt).toContain('Old task body');
    expect(prompt).toContain('new turns here');
  });

  test('an oversize latest ask keeps both supplied ends without a full echo', () => {
    const head = 'DEPLOY-STAGING-FIRST';
    const tail = 'REPORT-THE-PREVIEW-URL-LAST';
    const ask = `${head}${'A'.repeat(10_000)}${tail}`;

    const prompt = buildCompactionSummaryPrompt({
      transcript: 't', latestUserAsk: ask, budgetTokens: 500,
    });

    expect(prompt).toContain(head);
    expect(prompt).toContain(tail);
    expect(prompt).not.toContain(ask);
  });
});

describe('checkpoint preamble', () => {
  test('wrap → strip round-trips the summary body', () => {
    const body = '## Active Task\nDo the thing\n\n## Completed\n- step 1';
    const wrapped = wrapCompactionSummary(body);
    expect(wrapped).toStartWith(CONTEXT_CHECKPOINT_PREFIX);
    expect(stripCheckpointPreamble(wrapped)).toBe(body);
  });

  test('strip is a no-op for non-checkpoint text', () => {
    expect(stripCheckpointPreamble('plain summary')).toBe('plain summary');
  });
});
