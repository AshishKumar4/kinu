import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestSql } from "@kinu.run/test-utils";
import { memoryPlane } from "./helpers";

async function createStore() {
	const { sql, transactionSync } = createTestSql();
	const fs = await memoryPlane();
	const store = new MemoryStore(fs, sql, transactionSync);
	store.ensureSchema();

	return { store, fs, sql, transactionSync };
}

const PATH = "memory/MEMORY.md";

// Long enough lines that the content spans multiple chunks.
const line = (tag: string, n: number, fill = "x") => `${tag} line ${n} ${fill.repeat(40)}`;

const doc = (count: number, fill = "x") =>
	Array.from({ length: count }, (_, i) => line("note", i + 1, fill)).join("\n");

/** A unit vector along `axis`, as the embedder's normalized output would be. */
const axis = (at: number, width = 4) => Float32Array.from({ length: width }, (_, i) => (i === at ? 1 : 0));

async function write(store: MemoryStore, content: string): Promise<void> {
	await store.writeFile(PATH, content);
	await store.indexFile(PATH, content);
}

/** Every owed chunk given a vector, as a fill does. */
async function embedAll(store: MemoryStore, vector = axis(0)): Promise<string[]> {
	const owed = await store.chunksOwedVectors(1_000);
	store.putVectors(owed.map((chunk) => ({ id: chunk.id, hash: chunk.hash, embedding: vector })));

	return owed.map((chunk) => chunk.id);
}

describe("what the vectors owe follows the chunks", () => {
	test("every indexed chunk owes a vector of its text until one is put, and identical content owes nothing again", async () => {
		const { store } = await createStore();
		await write(store, doc(60));
		const owed = await store.chunksOwedVectors(1_000);

		expect(owed.length).toBeGreaterThan(1);
		expect(owed.every((chunk) => chunk.text.includes("x".repeat(40)))).toBe(true);

		await embedAll(store);
		expect(await store.chunksOwedVectors(1_000)).toEqual([]);

		await store.indexFile(PATH, doc(60));
		expect(await store.chunksOwedVectors(1_000)).toEqual([]);
	});

	test("an edited chunk owes a vector of its new text, and one embedded from the old text is refused", async () => {
		const { store } = await createStore();
		await write(store, doc(60));
		const before = await store.chunksOwedVectors(1_000);
		await embedAll(store);

		await write(store, doc(60, "y"));
		const owed = await store.chunksOwedVectors(1_000);

		expect(owed.map((chunk) => chunk.id).sort()).toEqual(before.map((chunk) => chunk.id).sort());
		expect(owed.every((chunk) => chunk.text.includes("y".repeat(40)))).toBe(true);

		// A fill that read the old text before the edit landed puts its vectors late: none is kept.
		store.putVectors(before.map((chunk) => ({ id: chunk.id, hash: chunk.hash, embedding: axis(1) })));
		expect((await store.chunksOwedVectors(1_000)).map((chunk) => chunk.id).sort()).toEqual(owed.map((chunk) => chunk.id).sort());
	});

	test("a page owes at most its limit, and pages drain every chunk once", async () => {
		const { store } = await createStore();
		await write(store, doc(60));
		const all = (await store.chunksOwedVectors(1_000)).map((chunk) => chunk.id);
		const embedded: string[] = [];

		for (let page = await store.chunksOwedVectors(2); page.length > 0; page = await store.chunksOwedVectors(2)) {
			expect(page.length).toBeLessThanOrEqual(2);
			store.putVectors(page.map((chunk) => ({ id: chunk.id, hash: chunk.hash, embedding: axis(0) })));
			embedded.push(...page.map((chunk) => chunk.id));
		}

		expect(embedded.sort()).toEqual(all.sort());
	});

	test("a note that shrinks or goes takes its chunks' vectors with it", async () => {
		const { store } = await createStore();
		await write(store, doc(60));
		await embedAll(store);
		await write(store, doc(3));
		await embedAll(store);

		expect((await store.nearestChunks(async () => axis(0), 100)).every((chunk) => chunk.startLine <= 3)).toBe(true);

		await store.forgetFile(PATH);
		expect(await store.nearestChunks(async () => axis(0), 10)).toEqual([]);
	});
});

describe("the nearest chunks", () => {
	test("rank by meaning, carry their text, and never name a chunk whose text moved since its vector", async () => {
		const { store } = await createStore();
		const notes = { "memory/deploys.md": "Ship the worker with wrangler.", "memory/people.md": "Dana rotates the webhook secret." };

		for (const [path, text] of Object.entries(notes)) {
			await store.writeFile(path, text);
			await store.indexFile(path, text);
		}

		const owed = await store.chunksOwedVectors(1_000);
		const toward = (text: string) => (text.includes("Dana") ? axis(1) : axis(0));
		store.putVectors(owed.map((chunk) => ({ id: chunk.id, hash: chunk.hash, embedding: toward(chunk.text) })));

		const nearest = async (query: Float32Array) => (await store.nearestChunks(async () => query, 1)).map((chunk) => chunk.text);
		expect({ people: await nearest(axis(1)), deploys: await nearest(axis(0)) }).toEqual({ people: [notes["memory/people.md"]], deploys: [notes["memory/deploys.md"]] });

		await store.writeFile("memory/people.md", "Sam holds the release keys now.");
		await store.indexFile("memory/people.md", "Sam holds the release keys now.");
		expect((await store.nearestChunks(async () => axis(1), 10)).some((chunk) => chunk.text.includes("Dana"))).toBe(false);
	});
});

describe("canonical index publication", () => {
	test.each(["replace", "delete"])("a failed %s publication rolls back lexical rows, stamp and vectors together", async (operation) => {
		const { fs, sql, transactionSync } = await createStore();
		const initial = new MemoryStore(fs, sql, transactionSync);
		await initial.writeFile(PATH, "retained words");
		await initial.indexFile(PATH, "retained words", "before");
		await embedAll(initial);

		const failing = new MemoryStore(fs, sql, (publish) => transactionSync(() => {
			publish();
			throw new Error("publication failed before commit");
		}));

		await expect(operation === "delete" ? failing.forgetFile(PATH) : failing.indexFile(PATH, "replacement words", "after"))
			.rejects.toThrow("publication failed before commit");
		const reopened = new MemoryStore(fs, sql, transactionSync);
		expect(reopened.stampOf(PATH)).toBe("before");
		expect((await reopened.search("retained")).map((hit) => hit.snippet)).toEqual(["retained words"]);
		expect((await reopened.nearestChunks(async () => axis(0), 10)).map((chunk) => chunk.text)).toEqual(["retained words"]);
		expect(await reopened.chunksOwedVectors(10)).toEqual([]);
	});
});
