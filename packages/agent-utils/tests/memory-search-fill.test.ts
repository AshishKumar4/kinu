// Partial matches must fill an underfull strict page, not only an empty one.
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestDb, createMemoryVfs } from "./helpers";

function createStore() {
	const { sql } = createTestDb();
	const store = new MemoryStore(createMemoryVfs(), sql);
	store.ensureSchema();

	return { store };
}

describe("MemoryStore.search fills an underfull strict page", () => {
	test("the strict hit leads and ranked partials fill the rest", async () => {
		const { store } = createStore();
		await store.indexFile("memory/both.md", "wrangler staging deploy succeeded");
		await store.indexFile("memory/one.md", "wrangler tail is noisy");
		await store.indexFile("memory/two.md", "staging database was reseeded");
		await store.indexFile("memory/none.md", "kubernetes ingress question");

		const hits = store.search("wrangler staging", 5);
		expect(hits[0].path).toBe("memory/both.md");
		expect(hits.map((h) => h.path).slice(1).sort())
			.toEqual(["memory/one.md", "memory/two.md"]);
		expect(hits.some((h) => h.path === "memory/none.md")).toBe(false);
	});

	test("fills to exactly the requested capacity and never past it", async () => {
		const { store } = createStore();
		await store.indexFile("memory/strict.md", "alpha beta together");

		for (let i = 0; i < 8; i++) {
			await store.indexFile(`memory/partial-${i}.md`, `alpha only number ${i}`);
		}

		const hits = store.search("alpha beta", 3);
		expect(hits.length).toBe(3);
		expect(hits[0].path).toBe("memory/strict.md");
	});

	test("a chunk already held as a strict hit is not repeated", async () => {
		const { store } = createStore();
		await store.indexFile("memory/a.md", "redis eviction policy discussion");
		await store.indexFile("memory/b.md", "redis cluster resharding notes");
		await store.indexFile("memory/c.md", "eviction of stale cache entries");

		const hits = store.search("redis eviction", 10);
		const paths = hits.map((h) => h.path);
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths.length).toBe(3);
	});

	test("a full strict page admits no partial", async () => {
		const { store } = createStore();

		for (let i = 0; i < 4; i++) {
			await store.indexFile(`memory/pair-${i}.md`, `epsilon zeta pair ${i}`);
		}

		await store.indexFile("memory/partial.md", "epsilon on its own");

		const hits = store.search("epsilon zeta", 2);
		expect(hits.length).toBe(2);
		expect(hits.some((h) => h.path === "memory/partial.md")).toBe(false);
	});

	test("the page is stable across repeated identical searches", async () => {
		const { store } = createStore();
		await store.indexFile("memory/pair.md", "gamma delta");

		for (let i = 0; i < 4; i++) {
			await store.indexFile(`memory/solo-${i}.md`, "gamma alone");
		}

		const first = store.search("gamma delta", 4).map((h) => h.path);
		expect(store.search("gamma delta", 4).map((h) => h.path)).toEqual(first);
		expect(store.search("gamma delta", 4).map((h) => h.path)).toEqual(first);
	});

	test("a single-term query still answers, with no second fetch to make", async () => {
		const { store } = createStore();
		await store.indexFile("memory/only.md", "postgres vacuum notes");
		expect(store.search("postgres", 5).map((h) => h.path)).toEqual(["memory/only.md"]);
	});
});
