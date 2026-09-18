// MEMORY.md's `### Note (<date>[ · <actor>])` heading has one owner:
// `appendMemoryNote` writes it and `parseMemoryNotes` reads it. The first row is
// a ROUND TRIP over the real store rather than a parse of a typed-in string,
// because the defect this pair replaces was a second hand-written reader in the
// UI that could drift from the writer without either side failing.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, createMemoryMemory } from './helpers';
import { appendMemoryNote, parseMemoryNotes } from '../src/memory/note';

const PATH = 'memory/MEMORY.md';

function store() {
  const db = new Database(':memory:');

  return createMemoryMemory(db, createWorkspaceBundle(db).vfs);
}

describe('parseMemoryNotes', () => {
  test('reads back what appendMemoryNote wrote, with and without the actor half', async () => {
    const memory = store();
    await appendMemoryNote(memory, 'the queue is sorted by priority', { date: '2026-09-17' });
    await appendMemoryNote(memory, 'first line\nsecond line', { date: '2026-09-18', by: 'main' });

    expect(parseMemoryNotes(await memory.read(PATH) ?? '')).toEqual([
      { path: PATH, content: 'the queue is sorted by priority', updatedAt: '2026-09-17', savedBy: null },
      { path: PATH, content: 'first line\nsecond line', updatedAt: '2026-09-18', savedBy: 'main' },
    ]);
  });

  test('a heading with no body under it is not a note', () => {
    // Three headings, one note: the document title and the stamped-but-empty
    // heading are both dropped, and the unstamped one keeps its heading text as
    // the only "when" the file gave it.
    const content = [
      '# Memory', '',
      '## Lesson', 'do not guess', '',
      '### Note (2026-09-18 · main)', '',
    ].join('\n');

    expect(parseMemoryNotes(content)).toEqual([
      { path: PATH, content: 'do not guess', updatedAt: 'Lesson', savedBy: null },
    ]);
  });

  test('the stamp is the last parenthesised span, not the first', () => {
    const content = '### Note (rev 2) (2026-09-18 · ana)\nthe second pass stands\n';

    expect(parseMemoryNotes(content)).toEqual([
      { path: PATH, content: 'the second pass stands', updatedAt: '2026-09-18', savedBy: 'ana' },
    ]);
  });
});
