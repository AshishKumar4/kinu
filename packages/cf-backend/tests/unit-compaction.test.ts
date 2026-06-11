// createProteusCompactFunction — the Session-seam compaction policy:
// head + recent-tail protection, prune-before-summarize, the structured
// handoff prompt, the [CONTEXT CHECKPOINT] wrapper, iterative updates.
import { describe, test, expect } from 'bun:test';
import type { SessionMessage } from 'agents/experimental/memory/session';
import { CONTEXT_CHECKPOINT_PREFIX } from '@proteus/core';
import { createProteusCompactFunction } from '../src/lib/compaction';

let nextId = 0;
function userMsg(text: string): SessionMessage {
  return { id: `m${nextId++}`, role: 'user', parts: [{ type: 'text', text }] };
}
function assistantMsg(text: string): SessionMessage {
  return { id: `m${nextId++}`, role: 'assistant', parts: [{ type: 'text', text }] };
}
function toolMsg(toolName: string, output: string): SessionMessage {
  return {
    id: `m${nextId++}`,
    role: 'assistant',
    parts: [{ type: `tool-${toolName}`, toolCallId: `c${nextId}`, toolName, input: { command: 'x' }, output, state: 'output-available' }],
  };
}

/** A seeded session big enough to clear the 40k-token protected tail: head
 *  ask, a huge early tool output (with a secret), a long worked middle, and
 *  a recent tail. */
function seedSession(): { messages: SessionMessage[]; tail: SessionMessage[] } {
  nextId = 0;
  const messages: SessionMessage[] = [
    userMsg('Investigate why deploys fail'),                  // protected head
    assistantMsg('Starting the investigation.'),
    userMsg('Check the wrangler logs first'),
    toolMsg('run', 'HUGE-LOG ' + 'y'.repeat(60_000) + ' SECRET_TOKEN=sk-live-12345'),
  ];
  for (let i = 0; i < 20; i++) {
    messages.push(assistantMsg(`worked on step ${i}, edited src/deploy-${i}.ts`));
    messages.push(toolMsg('run', `step ${i} output\n` + 'x'.repeat(16_000)));
  }
  const tail = [
    userMsg('Now deploy to staging and give me the URL'),     // the live ask
    assistantMsg('TAIL-RECENT-WORK deploying now'),
  ];
  messages.push(...tail);
  return { messages, tail };
}

describe('createProteusCompactFunction', () => {
  test('prunes old tool outputs before summarization while the recent tail stays out entirely', async () => {
    const { messages, tail } = seedSession();
    let prompt = '';
    const compact = createProteusCompactFunction({
      summarize: async (p) => { prompt = p; return '## Active Task\nNow deploy to staging and give me the URL'; },
    });

    const result = await compact(messages);
    expect(result).not.toBeNull();

    // Prune-before-summarize: the 60k tool output reaches the summarizer
    // truncated to the SDK's 500-char one-liner form, never raw.
    expect(prompt).toContain('HUGE-LOG');
    expect(prompt).not.toContain('y'.repeat(1_000));
    expect(prompt).toContain('[truncated');
    // The secret rode in the truncated-away region — and the prompt rules
    // forbid preserving values regardless.
    expect(prompt).toContain('do NOT preserve their values');

    // The verbatim live ask (which sits in the protected tail) is handed in.
    expect(prompt).toContain('Now deploy to staging and give me the URL');
    // Touched-path raw material reaches the summarizer.
    expect(prompt).toContain('src/deploy-3.ts');

    // Protected tail: not in the compacted range and not in the transcript.
    for (const t of tail) {
      expect(prompt).not.toContain('TAIL-RECENT-WORK');
      expect(result!.fromMessageId).not.toBe(t.id);
      expect(result!.toMessageId).not.toBe(t.id);
    }
    // Protected head: the first messages stay outside the range.
    expect(result!.fromMessageId).not.toBe(messages[0].id);
  });

  test('the stored summary is wrapped in the CONTEXT CHECKPOINT preamble', async () => {
    const { messages } = seedSession();
    const compact = createProteusCompactFunction({
      summarize: async () => '## Active Task\nthe task',
    });
    const result = await compact(messages);
    expect(result!.summary).toStartWith(CONTEXT_CHECKPOINT_PREFIX);
    expect(result!.summary).toContain('build on it');
    expect(result!.summary).toContain('## Active Task');
  });

  test('a later compaction updates the previous summary iteratively, preamble stripped', async () => {
    const { messages } = seedSession();
    // Simulate the overlay the provider injects after a first compaction.
    const overlay: SessionMessage = {
      id: 'compaction_1',
      role: 'assistant',
      parts: [{ type: 'text', text: `${CONTEXT_CHECKPOINT_PREFIX}\nEarlier conversation was compacted.\n\n## Active Task\nPREVIOUS-SUMMARY-BODY` }],
    };
    const withOverlay = [messages[0], overlay, ...messages.slice(15)];
    let prompt = '';
    const compact = createProteusCompactFunction({
      summarize: async (p) => { prompt = p; return 'updated'; },
    });
    const result = await compact(withOverlay);
    expect(result).not.toBeNull();
    expect(prompt).toContain('PREVIOUS SUMMARY:');
    expect(prompt).toContain('PREVIOUS-SUMMARY-BODY');
    expect(prompt).not.toContain(`PREVIOUS SUMMARY:\n${CONTEXT_CHECKPOINT_PREFIX}`);
    // The overlay's virtual id must never become a range endpoint.
    expect(result!.fromMessageId).not.toBe('compaction_1');
    expect(result!.toMessageId).not.toBe('compaction_1');
  });

  test('short sessions and empty summaries do not compact', async () => {
    const compact = createProteusCompactFunction({ summarize: async () => '   ' });
    nextId = 0;
    expect(await compact([userMsg('hi'), assistantMsg('hello')])).toBeNull();
    const { messages } = seedSession();
    expect(await compact(messages)).toBeNull(); // blank summary → no overlay
  });
});
