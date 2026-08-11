// The compaction content spec: the structured handoff template and the
// [CONTEXT CHECKPOINT] wrapper.
import { describe, test, expect } from 'bun:test';
import {
  buildCompactionSummaryPrompt,
  wrapCompactionSummary,
  stripCheckpointPreamble,
  CONTEXT_CHECKPOINT_PREFIX,
} from '../src/compaction.ts';

const SECTIONS = [
  '## Active Task',
  '## Completed',
  '## In Progress',
  '## Key Decisions & Constraints',
  '## Files & Paths Touched',
  '## Resolved Questions',
  '## Pending User Asks',
  '## Remaining Work',
];

describe('buildCompactionSummaryPrompt', () => {
  test('demands every handoff section, concreteness, recall-first budget, and secret redaction', () => {
    const prompt = buildCompactionSummaryPrompt({ transcript: 't', budgetTokens: 2_000 });
    for (const section of SECTIONS) expect(prompt).toContain(section);
    expect(prompt).toContain('copied verbatim');
    expect(prompt).toContain('never "made some changes"');
    expect(prompt).toContain('~2000 tokens');
    expect(prompt).toContain('recall');
    expect(prompt).toContain('do NOT preserve their values');
    expect(prompt).toContain('Never invent paths');
    // "Remaining Work", deliberately not "Next Steps" — a record, not orders.
    expect(prompt).not.toContain('Next Steps');
  });

  test('hands the latest user ask in directly so verbatim copying is mechanical', () => {
    const ask = 'Deploy the staging worker and tell me the preview URL';
    const prompt = buildCompactionSummaryPrompt({ transcript: 't', latestUserAsk: ask, budgetTokens: 500 });
    expect(prompt).toContain(ask);
    expect(prompt).toContain('copy this verbatim into "## Active Task"');
  });

  test('iterative update keeps the previous summary and states the move-item rules', () => {
    const prompt = buildCompactionSummaryPrompt({
      transcript: 'new turns here',
      previousSummary: '## Active Task\nOld task body',
      budgetTokens: 800,
    });
    expect(prompt).toContain('PREVIOUS SUMMARY:');
    expect(prompt).toContain('Old task body');
    expect(prompt).toContain('NEW TURNS TO INCORPORATE:');
    expect(prompt).toContain('In Progress → Completed');
    expect(prompt).toContain('PRESERVE still-relevant information');
    for (const section of SECTIONS) expect(prompt).toContain(section);
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
    expect(wrapped).toContain('build on it');
    expect(wrapped).toContain('do not re-ask questions');
    expect(stripCheckpointPreamble(wrapped)).toBe(body);
  });

  test('strip is a no-op for non-checkpoint text', () => {
    expect(stripCheckpointPreamble('plain summary')).toBe('plain summary');
  });
});
