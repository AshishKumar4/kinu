// Regression tests for the vfs_files writer/reader contract.
//
// Every writer of vfs_files MUST go through the canonical encoding
// (writeVfsFileSync / SqliteFS.writeFile): BLOB chunks, chunk-0 metadata,
// parent directory rows. The b7fefa1 regression stored TEXT rows that made
// SqliteFS reads throw (atob on markdown) — these tests pin the contract.
import { describe, test, expect } from "bun:test";
import { SqliteFS, VFS_SCHEMA_DDL, ensureVfsSchema, writeVfsFileSync } from "../src/vfs/sqlite";
import { createTestDb } from "./helpers";

function createFs() {
	const { sql } = createTestDb();
	const fs = new SqliteFS(sql);
	fs.init();
	return { sql, fs };
}

describe("canonical vfs_files schema (single source of truth)", () => {
	test("SqliteFS.init creates table, both indexes, and the root row", () => {
		const { sql } = createFs();
		const indexes = sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_vfs_files%' ORDER BY name
		`.map((r) => r.name);
		expect(indexes).toEqual(["idx_vfs_files_is_dir", "idx_vfs_files_parent"]);
		const root = sql<{ is_dir: number }>`SELECT is_dir FROM vfs_files WHERE path = ''`;
		expect(root[0]?.is_dir).toBe(1);
	});

	test("boot order: external bootstrap (initAllTables-style) first, SqliteFS.init still ends with indexes", () => {
		// Both backends run core's initAllTables BEFORE SqliteFS.init. The old
		// duplicate DDL won the race and the indexes were never created.
		const { sql, execRaw } = createTestDb();
		for (const ddl of VFS_SCHEMA_DDL) execRaw(ddl);

		const fs = new SqliteFS(sql);
		fs.init();

		const indexes = sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_vfs_files%'
		`;
		expect(indexes.length).toBe(2);
	});

	test("legacy DB created without indexes self-heals on init", () => {
		const { sql, execRaw } = createTestDb();
		execRaw(`CREATE TABLE vfs_files (
			path        TEXT    NOT NULL,
			chunk_index INTEGER NOT NULL DEFAULT 0,
			parent_path TEXT    NOT NULL DEFAULT '',
			data        BLOB,
			is_dir      INTEGER NOT NULL DEFAULT 0,
			size        INTEGER NOT NULL DEFAULT 0,
			mtime       INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (path, chunk_index)
		)`);

		const fs = new SqliteFS(sql);
		fs.init();

		const indexes = sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_vfs_files%'
		`;
		expect(indexes.length).toBe(2);
	});

	test("ensureVfsSchema is idempotent", () => {
		const { sql } = createTestDb();
		ensureVfsSchema(sql);
		ensureVfsSchema(sql);
		const roots = sql<{ n: number }>`SELECT COUNT(*) AS n FROM vfs_files WHERE path = ''`;
		expect(roots[0]?.n).toBe(1);
	});
});

describe("writeVfsFileSync ↔ SqliteFS interop", () => {
	test("sync raw-SQL write is readable through SqliteFS.readFile", async () => {
		const { sql, fs } = createFs();
		const markdown = "# Jarvis\n\n## Mission\n\nBuild things.";
		writeVfsFileSync(sql, "SOUL.md", markdown);

		expect(await fs.readFile("SOUL.md", { encoding: "utf8" })).toBe(markdown);
		// Stored as a real BLOB, never TEXT.
		const row = sql<{ t: string }>`SELECT typeof(data) AS t FROM vfs_files WHERE path = 'SOUL.md'`;
		expect(row[0]?.t).toBe("blob");
	});

	test("nested path creates parent directory rows (readdir works)", async () => {
		const { sql, fs } = createFs();
		writeVfsFileSync(sql, "memory/MEMORY.md", "# notes");

		expect(await fs.readdir("")).toContain("memory");
		expect(await fs.readdir("memory")).toEqual(["MEMORY.md"]);
		expect((await fs.stat("memory/MEMORY.md")).size).toBe(7);
	});

	test("binary content round-trips byte-for-byte", async () => {
		const { sql, fs } = createFs();
		const bytes = new Uint8Array(512).map((_, i) => i % 251);
		writeVfsFileSync(sql, "bin/blob.dat", bytes);

		const back = (await fs.readFile("bin/blob.dat")) as Uint8Array;
		expect(Array.from(back)).toEqual(Array.from(bytes));
	});

	test("SqliteFS.writeFile and writeVfsFileSync produce identical row shapes", async () => {
		const { sql, fs } = createFs();
		writeVfsFileSync(sql, "a.txt", "same-content");
		await fs.writeFile("b.txt", "same-content");

		const rows = sql<{ path: string; chunk_index: number; parent_path: string; is_dir: number; size: number; t: string }>`
			SELECT path, chunk_index, parent_path, is_dir, size, typeof(data) AS t
			FROM vfs_files WHERE path IN ('a.txt', 'b.txt') ORDER BY path
		`;
		expect(rows.length).toBe(2);
		const [a, b] = rows;
		expect({ ...a, path: "" }).toEqual({ ...b, path: "" });
	});

	test("overwrite replaces all chunks", async () => {
		const { sql, fs } = createFs();
		writeVfsFileSync(sql, "f.txt", "first version with some length");
		writeVfsFileSync(sql, "f.txt", "v2");
		expect(await fs.readFile("f.txt", { encoding: "utf8" })).toBe("v2");
		const chunks = sql<{ n: number }>`SELECT COUNT(*) AS n FROM vfs_files WHERE path = 'f.txt'`;
		expect(chunks[0]?.n).toBe(1);
	});
});
