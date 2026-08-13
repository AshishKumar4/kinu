// MemoryStore.appendToFile must never destroy existing content.
//
// The old implementation swallowed EVERY read error and rewrote the file
// with just the appended text — a TEXT-corrupted row (whose read throws a
// decode error, not ENOENT) silently nuked the whole memory file.
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestDb, createMemoryVfs } from "./helpers";

function createStore() {
	const { sql, db } = createTestDb();
	const fs = createMemoryVfs();
	const store = new MemoryStore(fs, sql);
	store.ensureSchema();
	return { sql, db, fs, store };
}

describe("MemoryStore.appendToFile", () => {
	test("appends to an existing file", async () => {
		const { store, fs } = createStore();
		await store.writeFile("memory/MEMORY.md", "# notes\n");
		await store.appendToFile("memory/MEMORY.md", "- new fact\n");
		expect(await fs.readFile("memory/MEMORY.md", { encoding: "utf8" })).toBe("# notes\n- new fact\n");
	});

	test("starts fresh when the file does not exist (ENOENT)", async () => {
		const { store, fs } = createStore();
		await store.appendToFile("memory/MEMORY.md", "first line\n");
		expect(await fs.readFile("memory/MEMORY.md", { encoding: "utf8" })).toBe("first line\n");
	});

	test("a non-ENOENT read failure propagates instead of overwriting the file", async () => {
		// The bug this guards: treating ANY read failure as "no file yet" and
		// writing over it. Only ENOENT may mean that; anything else must
		// propagate with the file untouched.
		const { sql } = createTestDb();
		const fs = createMemoryVfs({ "memory/MEMORY.md": "# precious notes" });
		fs.readFile = async () => { throw new Error("EIO: the store is unreachable"); };
		const store = new MemoryStore(fs, sql);
		store.ensureSchema();

		await expect(store.appendToFile("memory/MEMORY.md", "more")).rejects.toThrow();
		expect(fs.files.get("memory/MEMORY.md")).toBe("# precious notes");
	});
});
