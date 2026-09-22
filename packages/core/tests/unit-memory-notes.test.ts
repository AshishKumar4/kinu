// MEMORY.md note headings: `appendMemoryNote` writes them, `parseMemoryNotes` reads
// them. Rows go through the writer; only headingless hand-edited documents are typed in.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, createMemoryMemory } from './helpers';
import { appendMemoryNote, memoryIndexPath, parseMemoryNotes, readMemoryTail } from '../src/memory/note';
import type { Memory, VFS } from '../src/types/primitives';


function store() {
  const db = new Database(':memory:');
  const { vfs } = createWorkspaceBundle(db);

  return { memory: createMemoryMemory(db, vfs), vfs };
}

/** The note's path is a real, indexed memory file, asked of the writer's filesystem. */
async function namesTheWrittenFile(vfs: VFS, path: string): Promise<boolean> {
  return await vfs.exists(path) && memoryIndexPath(path) !== null;
}

describe('parseMemoryNotes', () => {
  test('reads back what appendMemoryNote wrote, with and without the actor half', async () => {
    const { memory, vfs } = store();
    await appendMemoryNote(memory, 'the queue is sorted by priority', { date: '2026-09-17' });
    await appendMemoryNote(memory, 'first line\nsecond line', { date: '2026-09-18', by: 'main' });

    const notes = parseMemoryNotes(await readMemoryTail(memory) ?? '');

    expect(notes.map(({ content, updatedAt, savedBy }) => ({ content, updatedAt, savedBy }))).toEqual([
      { content: 'the queue is sorted by priority', updatedAt: '2026-09-17', savedBy: null },
      { content: 'first line\nsecond line', updatedAt: '2026-09-18', savedBy: 'main' },
    ]);

    for (const note of notes) expect(await namesTheWrittenFile(vfs, note.path)).toBe(true);
  });

  test('a heading with no body under it is not a note', async () => {
    // The title and the stamped-but-empty heading are dropped; the unstamped one keeps its text.
    const { memory, vfs } = store();
    await memory.write((await memoryWritablePath(memory, vfs)), [
      '# Memory', '',
      '## Lesson', 'do not guess', '',
      '### Note (2026-09-18 · main)', '',
    ].join('\n'));

    const notes = parseMemoryNotes(await readMemoryTail(memory) ?? '');

    expect(notes.map(({ content, updatedAt, savedBy }) => ({ content, updatedAt, savedBy }))).toEqual([
      { content: 'do not guess', updatedAt: 'Lesson', savedBy: null },
    ]);

    for (const note of notes) expect(await namesTheWrittenFile(vfs, note.path)).toBe(true);
  });

  test('the stamp is the last parenthesised span, not the first', async () => {
    // Parentheses in the title: the stamp is still taken from the end.
    const { memory, vfs } = store();
    await appendMemoryNote(memory, 'the second pass stands', {
      heading: 'Note (rev 2)', date: '2026-09-18', by: 'ana',
    });

    const notes = parseMemoryNotes(await readMemoryTail(memory) ?? '');

    expect(notes.map(({ content, updatedAt, savedBy }) => ({ content, updatedAt, savedBy }))).toEqual([
      { content: 'the second pass stands', updatedAt: '2026-09-18', savedBy: 'ana' },
    ]);

    for (const note of notes) expect(await namesTheWrittenFile(vfs, note.path)).toBe(true);
  });
});

/** The file path learnt from one writer append, not spelled. */
async function memoryWritablePath(memory: Memory, vfs: VFS): Promise<string> {
  await appendMemoryNote(memory, 'seed', { date: '2026-09-18' });
  const [seeded] = parseMemoryNotes(await readMemoryTail(memory) ?? '');

  if (seeded === undefined || !await vfs.exists(seeded.path)) {
    throw new Error('appendMemoryNote wrote no readable note');
  }

  return seeded.path;
}
