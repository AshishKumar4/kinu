// Only a missing path may read as absence; other failures must reach the caller.
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestDb, createMemoryVfs } from "./helpers";

function createStore(seed: Record<string, string>) {
	const { sql, transactionSync } = createTestDb()
	const fs = createMemoryVfs(seed);
	const store = new MemoryStore(fs, sql, transactionSync);
	store.ensureSchema();

	return { fs, store };
}

describe("MemoryStore reads distinguish absence from breakage", () => {
	test("readFile answers null for a missing file and propagates anything else", async () => {
		const { fs, store } = createStore({ "memory/MEMORY.md": "# notes" });
		expect(await store.readFile("memory/gone.md")).toBeNull();
		expect(await store.readFile("memory/MEMORY.md")).toBe("# notes");

		fs.readFile = async () => { throw new Error("EIO: the store is unreachable"); };

		await expect(store.readFile("memory/MEMORY.md")).rejects.toThrow("EIO");
	});
});
