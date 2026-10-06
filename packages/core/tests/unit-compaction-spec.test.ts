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

  test('an oversize latest ask is windowed head+tail with a named omission, not dropped', () => {
    const prompt = buildCompactionSummaryPrompt({
      transcript: 't', latestUserAsk: 'A'.repeat(10_000), budgetTokens: 500,
    });

    // Both ends survive (the tail of a long spec-dump ask carries its point)
    // and the cut names itself, so the summarizer knows the ask was longer.
    expect(prompt).toContain('A'.repeat(4_000));
    expect(prompt).not.toContain('A'.repeat(8_001));
    expect(prompt).toContain('chars omitted from the middle');
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
