// A workspace's activity read from its own chat (core read-models/activity.ts; 1018-xao, Muse's activity log): each
// turn, what set it off, what it did and what it changed, newest first.
import { describe, expect, test } from 'bun:test';
import { activityOf, receiptSummary, type ChatHistoryEntry, type ProgramEffects } from '@kinu.run/core';

let position = 0;

function row(role: 'user' | 'assistant', parts: ChatHistoryEntry['parts'], extra: Partial<ChatHistoryEntry> = {}): ChatHistoryEntry {
  position += 1;

  return { id: `r${String(position)}`, position, role, turnId: null, parts, createdAt: 1_000 * position, ...extra };
}

const text = (said: string) => ({ type: 'text', text: said });

const program = (id: string, effects: Omit<ProgramEffects, 'call'>) => ({
  type: 'tool-eval', toolCallId: id, state: 'output-available', input: { code: 'run()' }, output: { result: 'ok', effects: { call: id, ...effects } },
});

describe("a workspace's activity", () => {
  test('a turn says what set it off: the person, an event that woke it, or its own work', () => {
    const entries = activityOf([
      row('assistant', [text('Checked the deploy on my own.')]),
      row('user', [text('Start the release workspace.')]),
      row('assistant', [text('Started it.')]),
      row('user', [text('- [email] from priya@cloudflare.com: Dynamic Workers demo?')], { metadata: { kinuEvent: 'event_drain' } }),
      row('assistant', [text('Drafted a reply.')]),
    ]);

    expect(entries.map((entry) => entry.cause.kind)).toEqual(['event', 'you', 'self']);
    expect(entries[0]?.cause).toMatchObject({ kind: 'event', source: 'priya@cloudflare.com' });
    expect(entries[1]?.cause).toEqual({ kind: 'you', text: 'Start the release workspace.' });
  });

  test("it leads with the turn's written title, else its reply's first line", () => {
    const [titled, plain] = activityOf([
      row('user', [text('Write it up.')]),
      row('assistant', [text('Here are the notes.\nLine two.')]),
      row('user', [text('And the brief?')]),
      row('assistant', [text('Done.')], { metadata: { kinuTurnTitle: 'Wrote the brief' } }),
    ]);

    expect([titled?.did, plain?.did]).toEqual(['Wrote the brief', 'Here are the notes.']);
  });

  test("it lists what a program changed by the host's record, and nothing for a program that only read", () => {
    const [entry] = activityOf([
      row('user', [text('Ship it.')]),
      row('assistant', [
        program('p1', { files: [{ path: 'src/db.ts', change: 'edited' }], commands: [], operations: {} }),
        program('p2', { files: [], commands: [], operations: {} }),
        program('p3', { files: [], commands: [], operations: { 'agent.createWorkspace': 1 } }),
        text('Shipped.'),
      ]),
    ]);

    expect(entry?.changed).toEqual(['Changed src/db.ts', 'agent.createWorkspace']);
  });

  test('a receipt names a few operations and counts many', () => {
    const few = receiptSummary({ call: 'c', files: [], commands: [], operations: { 'kv.put': 2, 'mail.saveDraft': 1 } });
    const many = receiptSummary({ call: 'c', files: [], commands: [], operations: { a: 1, b: 1, c: 1 } });

    expect([few, many]).toEqual(['kv.put ×2, mail.saveDraft', '3 other changes']);
  });
});
