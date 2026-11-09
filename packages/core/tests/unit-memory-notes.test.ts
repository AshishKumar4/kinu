import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
// MEMORY.md note headings: `appendMemoryNote` writes them, `parseMemoryNotes` reads
// them. Rows go through the writer; only headingless hand-edited documents are typed in.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, createMemoryMemory, createTestRuntime } from './helpers';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { adaptMemory } from '../src/memory/vector-sync';
import { createMemoryVectors, type Embedder } from '../src/memory/vector-store';
import { searchMemoryHits } from '../src/memory/memory-search';
import { isoDate } from '../src/utils/date';
import { appendMemoryNote, memoryIndexPath, parseMemoryNotes, readMemoryTail } from '../src/memory/note';
import type { Memory } from '../src/types/primitives';


function store() {
  const db = new Database(':memory:');
  const { vfs } = createWorkspaceBundle(db);

  return { memory: createMemoryMemory(db, vfs), vfs };
}

/** A stand-in for the embedding model: each axis a meaning, counted by the words that carry it. */
const MEANINGS = [['deploy', 'ship', 'release', 'production'], ['secret', 'credential', 'rotate'], ['renew', 'registrar', 'domain']];

/** `hold()` stops the next embedding once it has started, until `release()`. */
function meaningEmbedder(): Embedder & { hold(): { readonly entered: Promise<void>; release(): void } } {
  type Signal = ReturnType<typeof Promise.withResolvers<void>>;

  let held: { readonly entered: Signal; readonly gate: Signal } | null = null;

  return {
    hold() {
      const hold = { entered: Promise.withResolvers<void>(), gate: Promise.withResolvers<void>() };
      held = hold;

      return { entered: hold.entered.promise, release: () => hold.gate.resolve() };
    },
    async embed(text: string) {
      const hold = held;
      held = null;
      hold?.entered.resolve();
      await hold?.gate.promise;

      return MEANINGS.map((words) => words.filter((word) => text.toLowerCase().includes(word)).length);
    },
  };
}

function recallingWorkspace() {
  const { rt, db, workspace } = createTestRuntime();
  const indexed = new MemoryStore(workspace.vfs, rt.storage.sql, rt.storage.transactionSync);
  indexed.ensureSchema();
  const embedder = meaningEmbedder();
  const vectors = createMemoryVectors({ store: indexed, embedder, files: workspace.vfs });
  const memory = adaptMemory(indexed, workspace.vfs, vectors);
  const recall = async (query: string, limit = 5) => (await searchMemoryHits(memory, vectors, query, { limit })).hits;

  return { db, workspace, indexed, embedder, vectors, memory, recall };
}

describe('recall by meaning, from the vectors the workspace keeps beside its notes', () => {
  test('a note written is recalled by meaning on the very next search, with no word in common', async () => {
    const { db, memory, recall } = recallingWorkspace();

    try {
      for (const [path, text] of [['memory/deploys.md', 'We deploy the worker on Fridays.'], ['memory/keys.md', 'Dana rotates the webhook secret.']]) {
        await memory.write(path, text);
        await memory.index(path);
      }

      const top = async (query: string) => (await recall(query, 1)).map((hit) => ({ snippet: hit.snippet, sources: hit.sources }));

      expect({ shipping: await top('how to ship to production'), credentials: await top('who handles credential rotation') }).toEqual({
        shipping: [{ snippet: 'We deploy the worker on Fridays.', sources: ['semantic'] }],
        credentials: [{ snippet: 'Dana rotates the webhook secret.', sources: ['semantic'] }],
      });
    } finally { db.close(); }
  });

  test("a replaced note's old vector never surfaces, even when its embedding lands after the replacement", async () => {
    const { db, indexed, memory, embedder, vectors, recall } = recallingWorkspace();
    const replacement = 'The registrar renews kinu.run in March.';

    try {
      await memory.write('memory/keys.md', 'Dana rotates the webhook secret on Fridays.');
      // The embedding of this text is slow: the note is replaced, and its chunk re-indexed, while it is under way.
      const slow = embedder.hold();
      const indexing = memory.index('memory/keys.md');
      await slow.entered;
      await memory.write('memory/keys.md', replacement);
      await indexed.indexFile('memory/keys.md', replacement);
      slow.release();
      await indexing;

      // No chunk is ranked by a meaning its text no longer holds.
      expect((await vectors.search('who handles credential rotation')).filter((hit) => hit.score > 0)).toEqual([]);
      const rotation = await recall('who handles credential rotation');
      expect(rotation.some((hit) => hit.snippet.includes('Dana'))).toBe(false);
      expect((await recall('when is the domain due')).map((hit) => hit.snippet)).toEqual([replacement]);
    } finally { db.close(); }
  });

  test('a workspace whose chunks hold no vector embeds them all at its next start', async () => {
    const { rt, db, workspace } = createTestRuntime();
    const indexed = new MemoryStore(workspace.vfs, rt.storage.sql, rt.storage.transactionSync);
    indexed.ensureSchema();

    try {
      // Indexed with no embedder bound (workspace birth, a reset memory table): every chunk owes a vector.
      const unbound = adaptMemory(indexed, workspace.vfs);
      const notes = Array.from({ length: 40 }, (_, at) => `## Note ${String(at)}\nRelease ${String(at)} ships from main.`).join('\n\n');
      await unbound.write('memory/releases.md', notes);
      await unbound.index('memory/releases.md');
      await unbound.write('memory/keys.md', 'Dana rotates the webhook secret on Fridays.');
      await unbound.index('memory/keys.md');
      const owed = await indexed.chunksOwedVectors(Number.MAX_SAFE_INTEGER);
      expect(owed.length).toBeGreaterThan(1);

      // The next start's runtime fills what is owed.
      const reopened = new MemoryStore(workspace.vfs, rt.storage.sql, rt.storage.transactionSync);
      await createMemoryVectors({ store: reopened, embedder: meaningEmbedder(), files: workspace.vfs }).fill();

      expect(await reopened.chunksOwedVectors(Number.MAX_SAFE_INTEGER)).toEqual([]);
      expect((await reopened.nearestChunks(async () => Float32Array.of(0, 1, 0), owed.length)).length).toBe(owed.length);
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

describe('recall ranks by age and by difference', () => {
  /** A workspace's memory, each note written in its own file under a heading stamped `ageDays` ago, as the memory tool
   *  stamps one, then searched as a turn's recall searches. */
  async function notes(entries: ReadonlyArray<{ readonly path: string; readonly text: string; readonly ageDays: number }>) {
    const { rt, workspace } = createTestRuntime();
    const indexed = new MemoryStore(workspace.vfs, rt.storage.sql, rt.storage.transactionSync);

    indexed.ensureSchema();
    const memory = adaptMemory(indexed, workspace.vfs);

    for (const entry of entries) {
      await memory.write(entry.path, `### Note (${isoDate(Date.now() - entry.ageDays * 86_400_000)})\n${entry.text}\n`);
    }

    return { search: async (query: string, limit: number) => (await searchMemoryHits(memory, null, query, { limit })).hits };
  }

  test('of two notes that match alike, the one written this week outranks one from months ago', async () => {
    const { search } = await notes([
      { path: 'memory/old.md', text: 'The deploy target is staging.', ageDays: 120 },
      { path: 'memory/new.md', text: 'As of this week the deploy target is production, not staging.', ageDays: 2 },
    ]);

    expect((await search('deploy target', 2)).map((hit) => hit.path)).toEqual(['memory/new.md', 'memory/old.md']);
  });

  test('copies of one note do not crowd out a different note that also answers', async () => {
    const { search } = await notes([
      { path: 'memory/a.md', text: 'Rotate the API key monthly.', ageDays: 1 },
      { path: 'memory/b.md', text: 'Rotate the API key monthly!', ageDays: 1 },
      { path: 'memory/c.md', text: 'Rotate the API key monthly, always.', ageDays: 1 },
      { path: 'memory/d.md', text: 'The vault holds the API key; the owner rotates it by hand.', ageDays: 1 },
    ]);

    const recalled = (await search('rotate API key', 2)).map((hit) => hit.path);

    expect(recalled).toHaveLength(2);
    expect(recalled).toContain('memory/d.md');
  });
});
