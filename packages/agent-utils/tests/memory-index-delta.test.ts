// MemoryStore.indexFile must report the semantic-index delta so a vector store
// can be kept in sync: chunks that were inserted or changed (upserted, with
// text to embed) and chunk ids that no longer exist (deletedIds). allChunksAfter
// pages the table for the one-time backfill.
import { describe, test, expect } from "bun:test";
import { SqliteFS } from "../src/vfs/sqlite";
import { MemoryStore } from "../src/memory/store";
import { createTestDb } from "./helpers";

function createStore() {
	const { sql } = createTestDb();
	const fs = new SqliteFS(sql);
	fs.init();
	const store = new MemoryStore(fs, sql);
	store.ensureSchema();
	return { store };
}

const PATH = "memory/MEMORY.md";
// Lines long enough that the content spans multiple chunks (target 1600 chars).
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
		// Every deleted id was a chunk of the larger version…
		for (const id of small.deletedIds) expect(bigIds.has(id)).toBe(true);
		// …and no surviving chunk is both upserted and deleted.
		const upsertedIds = new Set(small.upserted.map((c) => c.id));
		for (const id of small.deletedIds) expect(upsertedIds.has(id)).toBe(false);
	});
});

describe("MemoryStore.allChunksAfter (backfill pagination)", () => {
	test("returns all chunks from an empty cursor, ordered by id", async () => {
		const { store } = createStore();
		const { upserted } = await store.indexFile(PATH, doc(60));
		const all = store.allChunksAfter("", 1000);
		expect(all.length).toBe(upserted.length);
		const ids = all.map((c) => c.id);
		expect([...ids].sort()).toEqual(ids); // already ordered by id
		expect(all[0].text.length).toBeGreaterThan(0);
	});

	test("pages the table across a cursor without overlap or gaps", async () => {
		const { store } = createStore();
		await store.indexFile(PATH, doc(60));
		const all = store.allChunksAfter("", 1000);
		expect(all.length).toBeGreaterThan(1);
		const firstPage = store.allChunksAfter("", 1);
		expect(firstPage.length).toBe(1);
		expect(firstPage[0].id).toBe(all[0].id);
		const rest = store.allChunksAfter(firstPage[0].id, 1000);
		expect(rest.map((c) => c.id)).toEqual(all.slice(1).map((c) => c.id));
		// Cursor at the last id → no more rows (backfill terminates).
		expect(store.allChunksAfter(all[all.length - 1].id, 1000)).toEqual([]);
	});
});
