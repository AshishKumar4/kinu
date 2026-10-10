import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
// MEMORY.md note headings: `appendMemoryNote` writes them, `parseMemoryNotes` reads
// them. Rows go through the writer; only headingless hand-edited documents are typed in.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, createMemoryMemory, createTestRuntime } from './helpers';
import { MemoryStore, type IndexedChunk } from '@kinu.run/agent-utils/memory';
import { adaptMemory, backfillMemoryVectors } from '../src/memory/vector-sync';
import { hybridSearch, memorySnippetRehydrator } from '../src/memory/hybrid-search';
import type { VectorStore } from '../src/memory/vector-store';
import { appendMemoryNote, memoryIndexPath, parseMemoryNotes, readMemoryTail } from '../src/memory/note';
import type { Memory } from '../src/types/primitives';


function store() {
  const db = new Database(':memory:');
  const { vfs } = createWorkspaceBundle(db);

  return { memory: createMemoryMemory(db, vfs), vfs };
}

describe('the semantic mirror survives an unavailable or failed backend', () => {
  test.each(['unavailable', 'delete-failure'])('a $0 update retains its tombstone until recovery', async (failure) => {
    const { rt, db, workspace } = createTestRuntime();
    const chunks = new Map<string, IndexedChunk>();
    let available = true;
    let rejectDeletes = false;

    const vectors: VectorStore = {
      get available() { return available; },
      upsertChunk: async (chunk) => { chunks.set(chunk.id, chunk); },
      upsertChunks: async (fresh) => { for (const chunk of fresh) chunks.set(chunk.id, chunk); },
      deleteChunks: async (ids) => {
        if (rejectDeletes) throw new Error('the semantic backend rejected deletion');

        for (const id of ids) chunks.delete(id);
      },
      search: async () => [...chunks.values()].map((chunk) => ({ ...chunk, score: 1 })),
    };

    const indexed = new MemoryStore(workspace.vfs, rt.storage.sql, rt.storage.transactionSync);
    indexed.ensureSchema();

    const memory = adaptMemory(indexed, workspace.vfs, { store: vectors });

    try {
      await memory.write('memory/mirror.md', 'old remote-only words');
      await memory.index('memory/mirror.md');
      expect(chunks.size).toBe(1);
      expect((await hybridSearch('old remote-only', async () => [], vectors, { rehydrate: memorySnippetRehydrator(memory) }))[0]?.snippet).toBe('old remote-only words');
      available = failure !== 'unavailable';
      rejectDeletes = failure === 'delete-failure';
      await memory.write('memory/mirror.md', failure === 'unavailable' ? 'replacement canonical words' : '');
      await memory.index('memory/mirror.md');

      expect(await memory.search('old remote-only')).toEqual([]);
      expect(await hybridSearch('old remote-only', async () => [], vectors, { rehydrate: memorySnippetRehydrator(memory) })).toEqual([]);
      available = true;
      rejectDeletes = false;
      // A later boot is not holding the index call's in-memory delta.
      const reopened = new MemoryStore(workspace.vfs, rt.storage.sql, rt.storage.transactionSync);

      await backfillMemoryVectors(reopened, vectors);
      expect([...chunks.values()].map((chunk) => chunk.text)).toEqual(failure === 'unavailable' ? ['replacement canonical words'] : []);
      const current = await hybridSearch('replacement canonical', async () => [], vectors, { rehydrate: memorySnippetRehydrator(memory) });

      expect(current.map((hit) => hit.snippet)).toEqual(failure === 'unavailable' ? ['replacement canonical words'] : []);
    } finally { db.close(); }
  });
});

/** The note's path is a real, indexed memory file, asked of the writer's filesystem. */
async function namesTheWrittenFile(vfs: VFS, path: string): Promise<boolean> {
  return await exists(vfs, path) && memoryIndexPath(path) !== null;
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

  if (seeded === undefined || !await exists(vfs, seeded.path)) {
    throw new Error('appendMemoryNote wrote no readable note');
  }

  return seeded.path;
}
