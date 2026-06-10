// MemoryStore.appendToFile must never destroy existing content.
//
// The old implementation swallowed EVERY read error and rewrote the file
// with just the appended text — a TEXT-corrupted row (whose read throws a
// decode error, not ENOENT) silently nuked the whole memory file.
import { describe, test, expect } from "bun:test";
import { SqliteFS } from "../src/vfs/sqlite";
import { MemoryStore } from "../src/memory/store";
import { createTestDb } from "./helpers";

function createStore() {
	const { sql, db } = createTestDb();
	const fs = new SqliteFS(sql);
	fs.init();
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
		const { store, db, sql } = createStore();
		// A TEXT row written by a broken raw-SQL writer: SqliteFS read decodes
		// string rows as legacy base64 and throws on markdown.
		db.run(
			"INSERT INTO vfs_files (path, chunk_index, parent_path, data, is_dir, size, mtime) VALUES (?, 0, 'memory', ?, 0, ?, ?)",
			["memory/MEMORY.md", "# precious notes (not base64!)", 30, Date.now()],
		);

		await expect(store.appendToFile("memory/MEMORY.md", "more")).rejects.toThrow();

		// The original row is untouched — no silent data destruction.
		const row = sql<{ data: string }>`SELECT data FROM vfs_files WHERE path = 'memory/MEMORY.md'`;
		expect(row[0]?.data).toBe("# precious notes (not base64!)");
	});
});
