// Partial matches must fill an underfull strict page, not only an empty one.
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestDb, createMemoryVfs } from "./helpers";

function createStore() {
	const { sql, transactionSync } = createTestDb()
	const store = new MemoryStore(createMemoryVfs(), sql, transactionSync);
	store.ensureSchema();

	return { store };
}

/** A note as the memory tool saves one: the file, then its index. */
async function note(store: MemoryStore, path: string, content: string): Promise<void> {
	await store.writeFile(path, content);
	await store.indexFile(path, content);
}

describe("MemoryStore.search fills an underfull strict page", () => {
	test("the strict hit leads and ranked partials fill the rest", async () => {
		const { store } = createStore();
		await note(store, "memory/both.md", "wrangler staging deploy succeeded");
		await note(store, "memory/one.md", "wrangler tail is noisy");
		await note(store, "memory/two.md", "staging database was reseeded");
		await note(store, "memory/none.md", "kubernetes ingress question");

		const hits = await store.search("wrangler staging", 5);
		expect(hits[0].path).toBe("memory/both.md");
		expect(hits.map((h) => h.path).slice(1).sort())
			.toEqual(["memory/one.md", "memory/two.md"]);
		expect(hits.some((h) => h.path === "memory/none.md")).toBe(false);
	});

	test("fills to exactly the requested capacity and never past it", async () => {
		const { store } = createStore();
		await note(store, "memory/strict.md", "alpha beta together");

		for (let i = 0; i < 8; i++) {
			await note(store, `memory/partial-${i}.md`, `alpha only number ${i}`);
		}

		const hits = await store.search("alpha beta", 3);
		expect(hits.length).toBe(3);
		expect(hits[0].path).toBe("memory/strict.md");
	});

	test("a chunk already held as a strict hit is not repeated", async () => {
		const { store } = createStore();
		await note(store, "memory/a.md", "redis eviction policy discussion");
		await note(store, "memory/b.md", "redis cluster resharding notes");
		await note(store, "memory/c.md", "eviction of stale cache entries");

		const hits = await store.search("redis eviction", 10);
		const paths = hits.map((h) => h.path);
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths.length).toBe(3);
	});

	test("a full strict page admits no partial", async () => {
		const { store } = createStore();

		for (let i = 0; i < 4; i++) {
			await note(store, `memory/pair-${i}.md`, `epsilon zeta pair ${i}`);
		}

		await note(store, "memory/partial.md", "epsilon on its own");

		const hits = await store.search("epsilon zeta", 2);
		expect(hits.length).toBe(2);
		expect(hits.some((h) => h.path === "memory/partial.md")).toBe(false);
	});

	test("the page is stable across repeated identical searches", async () => {
		const { store } = createStore();
		await note(store, "memory/pair.md", "gamma delta");

		for (let i = 0; i < 4; i++) {
			await note(store, `memory/solo-${i}.md`, "gamma alone");
		}

		const first = (await store.search("gamma delta", 4)).map((h) => h.path);
		expect((await store.search("gamma delta", 4)).map((h) => h.path)).toEqual(first);
		expect((await store.search("gamma delta", 4)).map((h) => h.path)).toEqual(first);
	});

	test("a single-term query still answers, with no second fetch to make", async () => {
		const { store } = createStore();
		await note(store, "memory/only.md", "postgres vacuum notes");
		expect((await store.search("postgres", 5)).map((h) => h.path)).toEqual(["memory/only.md"]);
	});
});

// The note is the text's only copy, and locally a shell edits it beside the memory tool.
describe("MemoryStore.search reads its hits from their notes", () => {
	test("a note changed under the index is re-chunked when searched: its old words find nothing, its new ones it", async () => {
		const { store } = createStore();
		await note(store, "memory/deploy.md", "wrangler staging deploy succeeded");
		await store.writeFile("memory/deploy.md", "kubernetes ingress now fronts staging");

		expect(await store.search("wrangler", 5)).toEqual([]);
		expect((await store.search("kubernetes", 5)).map((h) => h.snippet)).toEqual(["kubernetes ingress now fronts staging"]);
	});

	test("a note deleted under the index leaves no hit", async () => {
		const { sql, transactionSync } = createTestDb()
		const files = createMemoryVfs();
		const store = new MemoryStore(files, sql, transactionSync);
		store.ensureSchema();
		await note(store, "memory/gone.md", "postgres vacuum notes");
		files.files.delete("memory/gone.md");

		expect(await store.search("postgres", 5)).toEqual([]);
		expect(sql<{ n: number }>`SELECT count(*) AS n FROM memory_note_chunks`[0]?.n).toBe(0);
	});

});
