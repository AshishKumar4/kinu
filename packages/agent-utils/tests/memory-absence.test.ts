// MemoryStore's readers answer null/[] for "nothing there". Every failure used
// to produce that same answer, so an unreachable store and an empty one were
// one result: the caller read "no memory" and carried on. Only a missing path
// may mean absence now; anything else has to reach the caller.
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestDb, createMemoryVfs } from "./helpers";

function createStore(seed: Record<string, string>) {
	const { sql } = createTestDb();
	const fs = createMemoryVfs(seed);
	const store = new MemoryStore(fs, sql);
	store.ensureSchema();
	return { fs, store };
}

function enoent(path: string): Error {
	return Object.assign(
		new Error(`ENOENT: no such file or directory, scandir '${path}'`),
		{ code: "ENOENT" },
	);
}

describe("MemoryStore reads distinguish absence from breakage", () => {
	test("readFile answers null for a missing file and propagates anything else", async () => {
		const { fs, store } = createStore({ "memory/MEMORY.md": "# notes" });
		expect(await store.readFile("memory/gone.md")).toBeNull();
		expect(await store.readFile("memory/MEMORY.md")).toBe("# notes");

		fs.readFile = async () => { throw new Error("EIO: the store is unreachable"); };
		await expect(store.readFile("memory/MEMORY.md")).rejects.toThrow("EIO");
	});

	test("listLogFiles answers [] for an absent logs directory and propagates anything else", async () => {
		const { fs, store } = createStore({ "memory/logs/2026-08-17.md": "today" });
		expect(await store.listLogFiles()).toEqual(["memory/logs/2026-08-17.md"]);

		fs.readdir = async (path: string) => { throw enoent(path); };
		expect(await store.listLogFiles()).toEqual([]);

		fs.readdir = async () => { throw new Error("EIO: the store is unreachable"); };
		await expect(store.listLogFiles()).rejects.toThrow("EIO");
	});

	test("listFiles answers [] for an absent directory and propagates anything else", async () => {
		const { fs, store } = createStore({ "memory/MEMORY.md": "# notes" });
		expect(await store.listFiles()).toEqual(["MEMORY.md"]);

		fs.readdir = async (path: string) => { throw enoent(path); };
		expect(await store.listFiles()).toEqual([]);

		fs.readdir = async () => { throw new Error("EIO: the store is unreachable"); };
		await expect(store.listFiles()).rejects.toThrow("EIO");
	});
});
