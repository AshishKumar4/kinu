// The compaction content spec: the structured handoff template, the
// [CONTEXT CHECKPOINT] wrapper, and the transcript renderer.
import { describe, test, expect } from 'bun:test';
import {
  buildCompactionSummaryPrompt,
  renderCompactionTranscript,
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

  test('an oversize latest ask is capped, not dropped', () => {
    const prompt = buildCompactionSummaryPrompt({
      transcript: 't', latestUserAsk: 'A'.repeat(10_000), budgetTokens: 500,
    });
    expect(prompt).toContain('A'.repeat(4_000) + '…');
    expect(prompt).not.toContain('A'.repeat(4_001));
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

describe('renderCompactionTranscript', () => {
  test('renders roles, text, and tool call/result parts', () => {
    const transcript = renderCompactionTranscript([
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'fix the bug in src/a.ts' }] },
      {
        id: '2', role: 'assistant', parts: [
          { type: 'text', text: 'running tests' },
          { type: 'tool-run', toolName: 'run', input: { command: 'bun test' }, output: '1 fail: src/a.ts:42' },
        ],
      },
    ]);
    expect(transcript).toContain('[user]\nfix the bug in src/a.ts');
    expect(transcript).toContain('[Tool: run]');
    expect(transcript).toContain('bun test');
    expect(transcript).toContain('src/a.ts:42');
  });
});
