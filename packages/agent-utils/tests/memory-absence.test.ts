// Only a missing path may read as absence; other failures must reach the caller.
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { createTestSql } from "@kinu.run/test-utils";
import { memoryPlane } from "./helpers";

/** A store over the seeded plane, whose reads break once `breakReads` is called. */
async function createStore(seed: Record<string, string>) {
	const { sql, transactionSync } = createTestSql()
	const plane = await memoryPlane(seed);
	let broken = false;

	const fs = { ...plane, readFile: async (path: string) => {
		if (broken) throw new Error("EIO: the store is unreachable");

		return await plane.readFile(path);
	} };

	const store = new MemoryStore(fs, sql, transactionSync);
	store.ensureSchema();

	return { breakReads: () => { broken = true; }, store };
}

describe("MemoryStore reads distinguish absence from breakage", () => {
	test("readFile answers null for a missing file and propagates anything else", async () => {
		const { breakReads, store } = await createStore({ "memory/MEMORY.md": "# notes" });
		expect(await store.readFile("memory/gone.md")).toBeNull();
		expect(await store.readFile("memory/MEMORY.md")).toBe("# notes");

		breakReads();

		await expect(store.readFile("memory/MEMORY.md")).rejects.toThrow("EIO");
	});
});
