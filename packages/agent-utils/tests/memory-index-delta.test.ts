import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestDb, createMemoryVfs } from "./helpers";

function createStore() {
	const { sql, transactionSync } = createTestDb()
	const fs = createMemoryVfs();
	const store = new MemoryStore(fs, sql, transactionSync);
	store.ensureSchema();

	return { store };
}

const PATH = "memory/MEMORY.md";

// Long enough lines that the content spans multiple chunks.
const line = (tag: string, n: number, fill = "x") => `${tag} line ${n} ${fill.repeat(40)}`;

const doc = (count: number, fill = "x") =>
	Array.from({ length: count }, (_, i) => line("note", i + 1, fill)).join("\n");

describe("MemoryStore.indexFile delta", () => {
	test("first index reports every chunk as upserted, nothing deleted", async () => {
		const { store } = createStore();
		const delta = await store.indexFile(PATH, doc(60));
		expect(delta.deletedIds).toEqual([]);
		expect(delta.upserted.length).toBeGreaterThan(1);

		for (const c of delta.upserted) {
			expect(c.id).toBe(`${PATH}:${c.startLine}-${c.endLine}`);
			expect(c.path).toBe(PATH);
			expect(c.text.length).toBeGreaterThan(0);
		}
	});

	test("re-indexing identical content produces an empty delta", async () => {
		const { store } = createStore();
		const content = doc(60);
		await store.indexFile(PATH, content);
		const delta = await store.indexFile(PATH, content);
		expect(delta.upserted).toEqual([]);
		expect(delta.deletedIds).toEqual([]);
	});

	test("a changed chunk (same line ranges) re-upserts that id, deletes nothing", async () => {
		const { store } = createStore();
		await store.indexFile(PATH, doc(60, "x"));
		// Same line count and per-line length → identical chunk ids, changed text.
		const delta = await store.indexFile(PATH, doc(60, "y"));
		expect(delta.upserted.length).toBeGreaterThan(0);
		expect(delta.deletedIds).toEqual([]);
		expect(delta.upserted.every((c) => c.text.includes("y".repeat(40)))).toBe(true);
	});

	test("shrinking the file deletes the vanished chunk ids", async () => {
		const { store } = createStore();
		const big = await store.indexFile(PATH, doc(60));
		const bigIds = new Set(big.upserted.map((c) => c.id));
		const small = await store.indexFile(PATH, doc(3));
		expect(small.deletedIds.length).toBeGreaterThan(0);

		for (const id of small.deletedIds) expect(bigIds.has(id)).toBe(true);
		const upsertedIds = new Set(small.upserted.map((c) => c.id));

		for (const id of small.deletedIds) expect(upsertedIds.has(id)).toBe(false);
	});
});

describe("canonical index publication", () => {
  test.each(['replace', 'delete'])('a failed %s publication rolls back lexical rows, stamp and projection obligations together', async (operation) => {
    const { sql, transactionSync } = createTestDb();
    const fs = createMemoryVfs();
    const initial = new MemoryStore(fs, sql, transactionSync);
    initial.ensureSchema();
    await initial.writeFile(PATH, 'retained words');
    await initial.indexFile(PATH, 'retained words', 'before');
    initial.ackProjection(initial.pendingProjection());

    const failing = new MemoryStore(fs, sql, (write) => transactionSync(() => {
      write();
      throw new Error('publication failed before commit');
    }));

    await expect(operation === 'delete' ? failing.forgetFile(PATH) : failing.indexFile(PATH, 'replacement words', 'after'))
      .rejects.toThrow('publication failed before commit');
    const reopened = new MemoryStore(fs, sql, transactionSync);
    expect(reopened.stampOf(PATH)).toBe('before');
    expect((await reopened.search('retained')).map((hit) => hit.snippet)).toEqual(['retained words']);
    expect(reopened.pendingProjection()).toEqual([]);
  });

  test('acknowledging an old delivery cannot erase a newer change to the same chunk', async () => {
    const { store } = createStore();
    await store.indexFile(PATH, 'first content');
    const delivered = store.pendingProjection();
    await store.indexFile(PATH, 'changed content');
    store.ackProjection(delivered);
    expect(store.pendingProjection()).toHaveLength(1);
    expect(store.pendingProjection()[0].revision).toBeGreaterThan(delivered[0].revision);
  });
});
