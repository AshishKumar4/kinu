import { readText } from '@nimbus-sh/core/vfs/vfs.js';
// appendToFile must not overwrite existing content when a read fails with anything but ENOENT.
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestSql } from "@kinu.run/test-utils";
import { memoryPlane } from "./helpers";

async function createStore() {
	const { sql, db, transactionSync } = createTestSql();
	const fs = await memoryPlane();
	const store = new MemoryStore(fs, sql, transactionSync);
	store.ensureSchema();

	return { sql, db, fs, store };
}

describe("MemoryStore.appendToFile", () => {
	test("appends to an existing file", async () => {
		const { store, fs } = await createStore();
		await store.writeFile("memory/MEMORY.md", "# notes\n");
		await store.appendToFile("memory/MEMORY.md", "- new fact\n");
		expect(await readText(fs, 'memory/MEMORY.md')).toBe('# notes\n- new fact\n');
	});

	test("starts fresh when the file does not exist (ENOENT)", async () => {
		const { store, fs } = await createStore();
		await store.appendToFile("memory/MEMORY.md", "first line\n");
		expect(await readText(fs, 'memory/MEMORY.md')).toBe('first line\n');
	});

	test("a non-ENOENT read failure propagates instead of overwriting the file", async () => {
		const { sql, transactionSync } = createTestSql()
		const fs = await memoryPlane({ "memory/MEMORY.md": "# precious notes" });
		const unreadable = { ...fs, readFile: async () => { throw new Error("EIO: the store is unreachable"); } };

		const store = new MemoryStore(unreadable, sql, transactionSync);
		store.ensureSchema();

		await expect(store.appendToFile("memory/MEMORY.md", "more")).rejects.toThrow("EIO: the store is unreachable");
		expect(await readText(fs, "memory/MEMORY.md")).toBe("# precious notes");
	});
});
