// The cf memory keeps its notes' vectors beside their chunks: embedded on write, dropped with their chunks, and filled at
// the next start for any chunk that holds none.
import { describe, test, expect } from 'bun:test';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, makeSql } from '../../core/tests/helpers';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { adaptMemory, createMemoryVectors, searchMemoryHits, type Embedder } from '@kinu.run/core';

const PATH = 'memory/MEMORY.md';

const doc = (count: number, fill = 'x') =>
  Array.from({ length: count }, (_, i) => `note line ${i + 1} ${fill.repeat(40)}`).join('\n');

/** Every text it embeds, in order; refuses while `down`. */
function recordingEmbedder() {
  const embedded: string[] = [];
  let down = false;

  const embedder: Embedder = {
    async embed(text) {
      if (down) throw new Error('Workers AI refused the embedding');
      embedded.push(text);

      return [1, text.length % 7, 1];
    },
  };

  return { embedder, embedded, setDown: (value: boolean) => { down = value; } };
}

function createWorkspace() {
  const database = new Database(':memory:');
  const sql = makeSql(database);
  const files = createWorkspaceBundle(database).vfs;

  const open = () => {
    const store = new MemoryStore(files, sql, write => database.transaction(write)());
    store.ensureSchema();

    return store;
  };

  const store = open();
  const ai = recordingEmbedder();
  const vectors = createMemoryVectors({ store, embedder: ai.embedder, files });
  const memory = adaptMemory(store, files, vectors);

  return { store, files, open, ai, vectors, memory };
}

/** The text of every chunk that holds a vector of its current text. */
async function embeddedTexts(store: MemoryStore): Promise<string[]> {
  return (await store.nearestChunks(async () => Float32Array.of(1, 0, 0), 10_000)).map((chunk) => chunk.text).sort();
}

// #103: a warm turn in a workspace with no memory spent about 180 ms embedding a query nothing could match (staging,
// 2026-11-09: 33 of 33 searches, zero matches).
test('a memory search embeds its query only once the workspace holds a vector', async () => {
  const { memory, vectors, ai } = createWorkspace();

  await searchMemoryHits(memory, vectors, 'dinner plans', { limit: 5 });
  const empty = ai.embedded.splice(0);

  await memory.write(PATH, doc(3));
  await memory.index(PATH);
  ai.embedded.splice(0);
  await searchMemoryHits(memory, vectors, 'dinner plans', { limit: 5 });

  expect({ empty, held: ai.embedded }).toEqual({ empty: [], held: ['dinner plans'] });
});

// A note a shell wrote is taken in by the first search's refresh, which runs beside the semantic arm: that search finds it
// by its words, and the next by its meaning.
test('a note a shell wrote is found by its words at once and by its meaning once indexed', async () => {
  const { files, memory, vectors } = createWorkspace();
  const sources = async (query: string) => (await searchMemoryHits(memory, vectors, query, { limit: 5 })).hits.flatMap((hit) => hit.sources);

  await writeText(files, PATH, 'kubernetes ingress now fronts staging');

  expect({ first: await sources('kubernetes'), meaning: await sources('cluster routing') }).toEqual({ first: ['lexical'], meaning: ['semantic'] });
});

describe('a write embeds what it indexed', () => {
  test('every chunk of a written note holds a vector of its own text, each embedded once', async () => {
    const { store, memory, ai } = createWorkspace();

    await memory.write(PATH, doc(60));
    await memory.index(PATH);
    await memory.index(PATH);

    const texts = await embeddedTexts(store);
    expect(texts.length).toBeGreaterThan(1);
    expect(ai.embedded.sort()).toEqual(texts);
  });

  test('a refused embedding does not fail the write; its chunks are found by their words and embedded at the next start', async () => {
    const { store, open, files, memory, ai } = createWorkspace();
    ai.setDown(true);

    await memory.write(PATH, doc(60));
    await expect(memory.index(PATH)).resolves.toBeUndefined();
    expect((await memory.search('note', 5)).length).toBeGreaterThan(0);
    expect(await embeddedTexts(store)).toEqual([]);

    ai.setDown(false);
    const reopened = open();
    await createMemoryVectors({ store: reopened, embedder: ai.embedder, files }).fill();

    expect(await reopened.chunksOwedVectors(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect((await embeddedTexts(reopened)).length).toBeGreaterThan(1);
  });

  test('emptying or shrinking a note takes the vectors of the chunks it lost', async () => {
    const { store, memory } = createWorkspace();

    await memory.write(PATH, doc(60));
    await memory.index(PATH);
    await memory.write(PATH, doc(3));
    await memory.index(PATH);
    expect(await embeddedTexts(store)).toEqual([doc(3)]);

    await memory.write(PATH, '');
    await memory.index(PATH);
    expect(await memory.search('note', 5)).toEqual([]);
    expect(await embeddedTexts(store)).toEqual([]);
  });
});

// A note is the text's only copy, and a shell may change it beside the memory tool.
describe('a note changed under its index', () => {
  test('is re-chunked when it is read, and its vectors follow', async () => {
    const { store, files, memory } = createWorkspace();
    await memory.write(PATH, 'wrangler staging deploy succeeded');
    await memory.index(PATH);
    await writeText(files, PATH, 'kubernetes ingress now fronts staging');

    expect(await memory.read(PATH)).toBe('kubernetes ingress now fronts staging');
    expect(await embeddedTexts(store)).toEqual(['kubernetes ingress now fronts staging']);
  });

  test('is re-chunked when a search finds it, and the stale hit is never served', async () => {
    const { store, files, memory } = createWorkspace();
    await memory.write(PATH, 'wrangler staging deploy succeeded');
    await memory.index(PATH);
    await writeText(files, PATH, 'kubernetes ingress now fronts staging');

    expect(await memory.search('wrangler', 5)).toEqual([]);
    expect(await embeddedTexts(store)).toEqual(['kubernetes ingress now fronts staging']);
  });

  test('a note a shell removed or renamed leaves no hit and no vector under its old name', async () => {
    const { store, files, memory } = createWorkspace();
    await memory.write(PATH, 'wrangler staging deploy succeeded');
    await memory.write('memory/gone.md', 'postgres replica lag alert');
    await memory.index(PATH);
    await memory.index('memory/gone.md');

    await files.rename(PATH, 'memory/deploys.md');
    await files.unlink('memory/gone.md');

    expect(await memory.search('postgres', 5)).toEqual([]);
    expect((await memory.search('wrangler', 5)).map((hit) => hit.path)).toEqual(['memory/deploys.md']);
    expect((await store.nearestChunks(async () => Float32Array.of(1, 0, 0), 10)).map((chunk) => chunk.path)).toEqual(['memory/deploys.md']);
  });
});
