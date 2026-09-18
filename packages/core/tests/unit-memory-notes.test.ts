// MEMORY.md's `### Note (<date>[ · <actor>])` heading has one owner:
// `appendMemoryNote` writes it and `parseMemoryNotes` reads it. So does the
// FILE they agree on, which is why no row here spells that path: the rows read
// the note back through `readMemoryTail`, the module's own reader, and then
// check the path each note carries against the workspace that holds it. A file
// restating either fact agrees with the writer by construction and cannot catch
// it being wrong.
//
// Every row that has a heading to assert about goes through the writer to get
// one. What is typed in below is the one thing the writer never produces: a
// hand-edited document whose headings have no body under them.
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

/** Each note names a file the workspace really holds, and that file is indexed
 *  memory rather than some other document — the two facts the path on a note
 *  claims, asked of the writer's own filesystem instead of restated. */
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
    // Three headings, one note: the document title and the stamped-but-empty
    // heading are both dropped, and the unstamped one keeps its heading text as
    // the only "when" the file gave it. Hand-written, because a document nobody
    // appended through is exactly what this row is about.
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
    // Through the writer, because a heading with parentheses in its TITLE is a
    // heading `appendMemoryNote` really produces: the row hands it one and the
    // reader must still take the stamp from the end.
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

/** The file the writer writes, learnt from the writer: one append, then the one
 *  path the note it wrote carries. A row that wants to hand-write that document
 *  asks for it here instead of spelling it. */
async function memoryWritablePath(memory: Memory, vfs: VFS): Promise<string> {
  await appendMemoryNote(memory, 'seed', { date: '2026-09-18' });
  const [seeded] = parseMemoryNotes(await readMemoryTail(memory) ?? '');

  if (seeded === undefined || !await vfs.exists(seeded.path)) {
    throw new Error('appendMemoryNote wrote no readable note');
  }

  return seeded.path;
}
