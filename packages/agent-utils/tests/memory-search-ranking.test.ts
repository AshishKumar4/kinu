// Search must return its strongest matches: no relevance floor, score monotone with relevance.
import { describe, test, expect } from "bun:test";
import { present } from "../../test-utils/src/present";
import { MemoryStore } from "../src/memory/store";
import { createTestDb, createMemoryVfs } from "./helpers";

function createStore() {
	const { sql } = createTestDb();
	const fs = createMemoryVfs();
	const store = new MemoryStore(fs, sql);
	store.ensureSchema();

	return { store };
}

const PATH = "memory/MEMORY.md";

describe("MemoryStore.search ranking", () => {
	test("a document saturated with the query terms is still returned", async () => {
		const { store } = createStore();

		// Dense repetition drives |bm25| high; an inverted score with a floor would drop this hit.
		const dense = Array.from({ length: 120 }, () =>
			"kinu workspace sandbox provisioning failure diagnosis",
		).join("\n");

		const filler = Array.from({ length: 40 }, (_, i) => `unrelated filler line ${i}`).join("\n");
		await store.indexFile(PATH, `${dense}\n${filler}`);
		const hits = store.search("kinu workspace sandbox provisioning failure diagnosis");
		expect(hits.length).toBeGreaterThan(0);
	});

	test("the score is monotone with relevance: best match first, highest score", async () => {
		const { store } = createStore();
		const strong = Array.from({ length: 30 }, () => "quantum entanglement research").join("\n");
		const weak = `one mention of quantum here\n${Array.from({ length: 30 }, (_, i) => `noise ${i}`).join("\n")}`;
		await store.indexFile("memory/strong.md", strong);
		await store.indexFile("memory/weak.md", weak);
		const hits = store.search("quantum");
		const strongHit = present(hits.find((h) => h.path === "memory/strong.md"), "the strong file's hit");
		const weakHit = present(hits.find((h) => h.path === "memory/weak.md"), "the weak file's hit");
		expect(hits[0].path).toBe("memory/strong.md");
		expect(strongHit.score).toBeGreaterThan(weakHit.score);
	});
});
