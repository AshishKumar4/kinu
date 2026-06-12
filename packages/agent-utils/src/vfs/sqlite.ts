/**
 * SQLite-backed virtual filesystem for Durable Objects.
 *
 * Storage model:
 *   Every file is a sequence of one or more chunks stored as adjacent rows.
 *   Metadata (parent_path, is_dir, size, mtime) lives on chunk_index 0.
 *   All paths share a single `vfs_files` table — git files under `.git/`,
 *   memory files under `memory/`, etc.
 */

import { concatBuffers, rowDataToBytes, toBuffer } from "./encoding";
import { normalizePath } from "../core/utils";
import type { VFS } from "./types";
import type { SqlExecutor } from "../types";
import type { VFSError } from "./types";

// 1.8 MB per chunk
const CHUNK_SIZE = 1800 * 1024;

/**
 * Canonical vfs_files schema — the single source of truth, owned by SqliteFS.
 * Embedders that bootstrap all tables up front (core's initAllTables) run
 * these same statements; SqliteFS.init() also runs them unconditionally so
 * databases created before the indexes existed self-heal.
 */
export const VFS_SCHEMA_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS vfs_files (
		path        TEXT    NOT NULL,
		chunk_index INTEGER NOT NULL DEFAULT 0,
		parent_path TEXT    NOT NULL DEFAULT '',
		data        BLOB,
		is_dir      INTEGER NOT NULL DEFAULT 0,
		size        INTEGER NOT NULL DEFAULT 0,
		mtime       INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (path, chunk_index)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_vfs_files_parent ON vfs_files(parent_path, path)`,
	`CREATE INDEX IF NOT EXISTS idx_vfs_files_is_dir ON vfs_files(is_dir, path)`,
	// Root directory row — readdir('') and stat('') depend on it.
	`INSERT OR IGNORE INTO vfs_files (path, chunk_index, parent_path, data, is_dir, size, mtime)
		VALUES ('', 0, '', NULL, 1, 0, (unixepoch() * 1000))`,
];

/** Idempotently create the vfs_files table, its indexes, and the root row. */
export function ensureVfsSchema(sql: SqlExecutor): void {
	for (const statement of VFS_SCHEMA_DDL) {
		// SqlExecutor only speaks tagged templates; wrap each constant DDL
		// statement (no bindings) as a single-part template.
		const strings = Object.assign([statement], { raw: [statement] });
		void sql(strings);
	}
}

/**
 * Write a file synchronously through the canonical encoding (BLOB chunks,
 * chunk-0 metadata, parent directory rows). SqliteFS.writeFile delegates
 * here; raw-SQL writers (core's identity seeds) MUST use this instead of
 * hand-rolled INSERTs so every vfs_files row stays SqliteFS-readable.
 */
export function writeVfsFileSync(sql: SqlExecutor, path: string, data: Uint8Array | string): void {
	const normalized = normalizePath(path);
	if (!normalized) throw new Error("Cannot write to root");

	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;

	const existing = sql<{ is_dir: number }>`
		SELECT is_dir FROM vfs_files WHERE path = ${normalized} AND chunk_index = 0
	`;
	if (existing[0]?.is_dir === 1) {
		throw makeErrno(
			`EISDIR: illegal operation on a directory, open '${path}'`,
			"EISDIR", -21, path,
		);
	}

	const parts = normalized.split("/");
	const parentPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";

	if (parts.length > 1) {
		const now = Date.now();
		for (let i = 0; i < parts.length - 1; i++) {
			const dirPath = parts.slice(0, i + 1).join("/");
			const dirParent = i === 0 ? "" : parts.slice(0, i).join("/");
			void sql`INSERT OR IGNORE INTO vfs_files
				(path, chunk_index, parent_path, data, is_dir, mtime)
				VALUES (${dirPath}, 0, ${dirParent}, NULL, 1, ${now})`;
		}
	}

	void sql`DELETE FROM vfs_files WHERE path = ${normalized}`;

	const totalSize = bytes.length;
	const chunkCount = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
	const now = Date.now();

	for (let i = 0; i < chunkCount; i++) {
		const start = i * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE, totalSize);
		const chunkBuf = toBuffer(bytes.slice(start, end));

		// Chunk 0 carries metadata; subsequent chunks carry only data
		void sql`INSERT INTO vfs_files
			(path, chunk_index, parent_path, data, is_dir, size, mtime)
			VALUES (${normalized}, ${i}, ${i === 0 ? parentPath : ""}, ${chunkBuf}, 0, ${i === 0 ? totalSize : 0}, ${now})`;
	}
}

function makeErrno(message: string, code: string, errno: number, path: string): VFSError {
	const err: VFSError = new Error(message);
	err.code = code;
	err.errno = errno;
	err.path = path;
	return err;
}

export class SqliteFS implements VFS {
	private sql!: SqlExecutor;
	public promises!: this;

	constructor(sql: SqlExecutor) {
		this.sql = sql;
	}

	init() {
		ensureVfsSchema(this.sql);

		Object.defineProperty(this, "promises", {
			value: this,
			enumerable: true,
			writable: false,
			configurable: false,
		});
	}

	async readFile(
		path: string,
		options?: { encoding?: "utf8" },
	): Promise<Uint8Array | string> {
		const normalized = normalizePath(path);

		const meta = this.sql<{ is_dir: number }>`
			SELECT is_dir FROM vfs_files WHERE path = ${normalized} AND chunk_index = 0
		`;
		if (!meta[0]) {
			throw makeErrno(
				`ENOENT: no such file or directory, open '${path}'`,
				"ENOENT", -2, path,
			);
		}
		if (meta[0].is_dir) {
			throw makeErrno(
				`EISDIR: illegal operation on a directory, read '${path}'`,
				"EISDIR", -21, path,
			);
		}

		const rows = this.sql<{ data: ArrayBuffer | string | null }>`
			SELECT data FROM vfs_files WHERE path = ${normalized} ORDER BY chunk_index
		`;

		const chunks = rows.map((r) => rowDataToBytes(r.data));
		const result = concatBuffers(chunks);

		return options?.encoding === "utf8"
			? new TextDecoder().decode(result)
			: result;
	}

	async writeFile(path: string, data: Uint8Array | string): Promise<void> {
		writeVfsFileSync(this.sql, path, data);
	}

	async unlink(path: string): Promise<void> {
		const normalized = normalizePath(path);

		const existing = this.sql<{ is_dir: number }>`
			SELECT is_dir FROM vfs_files WHERE path = ${normalized} AND chunk_index = 0
		`;
		if (!existing[0]) {
			throw makeErrno(
				`ENOENT: no such file or directory, unlink '${path}'`,
				"ENOENT", -2, path,
			);
		}
		if (existing[0].is_dir === 1) {
			throw makeErrno(
				`EPERM: operation not permitted, unlink '${path}'`,
				"EPERM", -1, path,
			);
		}

		void this.sql`DELETE FROM vfs_files WHERE path = ${normalized}`;
	}

	async readdir(path: string): Promise<string[]> {
		const normalized = normalizePath(path).replace(/\/+$/g, "");

		const dirCheck = this.sql<{ is_dir: number }>`
			SELECT is_dir FROM vfs_files WHERE path = ${normalized} AND chunk_index = 0
		`;
		if (!dirCheck[0]) {
			throw makeErrno(
				`ENOENT: no such file or directory, scandir '${path}'`,
				"ENOENT", -2, path,
			);
		}
		if (!dirCheck[0].is_dir) {
			throw makeErrno(
				`ENOTDIR: not a directory, scandir '${path}'`,
				"ENOTDIR", -20, path,
			);
		}

		const rows = this.sql<{ path: string }>`
			SELECT path FROM vfs_files WHERE parent_path = ${normalized} AND path != ${normalized} AND chunk_index = 0
		`;

		if (!rows || rows.length === 0) return [];

		return rows.map((row) => {
			const segments = row.path.split("/");
			return segments[segments.length - 1];
		});
	}

	async mkdir(path: string, options?: { recursive?: boolean } | unknown): Promise<void> {
		const normalized = normalizePath(path).replace(/\/+$/g, "");
		if (!normalized) return;

		const recursive = typeof options === "object" && options !== null && "recursive" in options
			? (options as { recursive?: boolean }).recursive
			: false;

		const parts = normalized.split("/");

		if (recursive) {
			// Create all intermediate directories
			for (let i = 1; i <= parts.length; i++) {
				const seg = parts.slice(0, i).join("/");
				const parentSeg = i > 1 ? parts.slice(0, i - 1).join("/") : "";
				void this.sql`INSERT OR IGNORE INTO vfs_files
					(path, chunk_index, parent_path, data, is_dir, mtime)
					VALUES (${seg}, 0, ${parentSeg}, NULL, 1, ${Date.now()})`;
			}
			return;
		}

		if (parts.length > 1) {
			const parentPath = parts.slice(0, -1).join("/");
			const parent = this.sql<{ is_dir: number }>`
				SELECT is_dir FROM vfs_files WHERE path = ${parentPath} AND chunk_index = 0
			`;
			if (!parent[0] || parent[0].is_dir !== 1) {
				throw makeErrno(
					`ENOENT: no such file or directory, mkdir '${path}'`,
					"ENOENT", -2, path,
				);
			}
		}

		const existing = this.sql<{ is_dir: number }>`
			SELECT is_dir FROM vfs_files WHERE path = ${normalized} AND chunk_index = 0
		`;
		if (existing[0]) {
			if (existing[0].is_dir === 1) return;
			throw makeErrno(
				`EEXIST: file already exists, mkdir '${path}'`,
				"EEXIST", -17, path,
			);
		}

		const parentPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
		void this.sql`INSERT OR IGNORE INTO vfs_files
			(path, chunk_index, parent_path, data, is_dir, mtime)
			VALUES (${normalized}, 0, ${parentPath}, NULL, 1, ${Date.now()})`;
	}

	async rmdir(path: string): Promise<void> {
		const normalized = normalizePath(path).replace(/\/+$/g, "");
		if (!normalized) throw new Error("Cannot remove root directory");

		const existing = this.sql<{ is_dir: number }>`
			SELECT is_dir FROM vfs_files WHERE path = ${normalized} AND chunk_index = 0
		`;
		if (!existing[0]) {
			throw makeErrno(
				`ENOENT: no such file or directory, rmdir '${path}'`,
				"ENOENT", -2, path,
			);
		}
		if (existing[0].is_dir !== 1) {
			throw makeErrno(
				`ENOTDIR: not a directory, rmdir '${path}'`,
				"ENOTDIR", -20, path,
			);
		}

		const children = this.sql<{ path: string }>`
			SELECT path FROM vfs_files WHERE parent_path = ${normalized} AND chunk_index = 0 LIMIT 1
		`;
		if (children.length > 0) {
			throw makeErrno(
				`ENOTEMPTY: directory not empty, rmdir '${path}'`,
				"ENOTEMPTY", -39, path,
			);
		}

		void this.sql`DELETE FROM vfs_files WHERE path = ${normalized}`;
	}

	async removeRecursive(path: string): Promise<void> {
		const normalized = normalizePath(path).replace(/\/+$/g, "");
		if (!normalized) throw new Error("Cannot remove root directory");
		void this.sql`DELETE FROM vfs_files WHERE path = ${normalized} OR path LIKE ${normalized + "/%"}`;
	}

	async stat(path: string): Promise<{
		type: "file" | "dir";
		mode: number;
		size: number;
		mtimeMs: number;
		dev: number;
		ino: number;
		uid: number;
		gid: number;
		ctime: Date;
		mtime: Date;
		ctimeMs: number;
		isFile: () => boolean;
		isDirectory: () => boolean;
		isSymbolicLink: () => boolean;
	}> {
		const normalized = normalizePath(path);
		const result = this.sql<{
			data: ArrayBuffer | string | null;
			mtime: number;
			is_dir: number;
			size: number;
		}>`SELECT data, mtime, is_dir, size FROM vfs_files WHERE path = ${normalized} AND chunk_index = 0`;

		if (!result[0]) {
			throw makeErrno(
				`ENOENT: no such file or directory, stat '${path}'`,
				"ENOENT", -2, path,
			);
		}

		const row = result[0];
		const isDir = row.is_dir === 1;

		let size = row.size;
		// Resolve size: stored size for new writes, computed for legacy data
		if (!isDir && size === 0 && row.data != null) {
			if (row.data instanceof ArrayBuffer) {
				size = row.data.byteLength;
			} else if (typeof row.data === "string") {
				// Account for base64 padding when computing original size
				const padding = (row.data.match(/=+$/) || [""])[0].length;
				size = Math.floor((row.data.length * 3) / 4) - padding;
			}
		}

		return {
			type: isDir ? "dir" : "file",
			mode: isDir ? 0o040755 : 0o100644,
			size,
			mtimeMs: row.mtime,
			dev: 0,
			ino: 0,
			uid: 0,
			gid: 0,
			ctime: new Date(row.mtime),
			mtime: new Date(row.mtime),
			ctimeMs: row.mtime,
			isFile: () => !isDir,
			isDirectory: () => isDir,
			isSymbolicLink: () => false,
		};
	}

	async lstat(path: string) {
		return await this.stat(path);
	}

	// Symlinks stored as plain file content (used by git for refs)

	async symlink(target: string, path: string): Promise<void> {
		await this.writeFile(path, target);
	}

	async readlink(path: string): Promise<string> {
		return (await this.readFile(path, { encoding: "utf8" })) as string;
	}

	async chmod(_path: string, _mode: number): Promise<void> {
		// No-op: SQLite FS doesn't track file modes
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const oldNorm = normalizePath(oldPath);
		const newNorm = normalizePath(newPath);

		const newParts = newNorm.split("/");
		const newParent = newParts.length > 1 ? newParts.slice(0, -1).join("/") : "";

		const rows = this.sql<{ data: ArrayBuffer | null; chunk_index: number; parent_path: string; is_dir: number; size: number; mtime: number }>`
			SELECT data, chunk_index, parent_path, is_dir, size, mtime FROM vfs_files WHERE path = ${oldNorm} ORDER BY chunk_index ASC
		`;

		if (rows.length === 0) {
			throw makeErrno(
				`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`,
				"ENOENT", -2, oldPath,
			);
		}

		for (const row of rows) {
			const parentPath = row.chunk_index === 0 ? newParent : row.parent_path;
			void this.sql`INSERT OR REPLACE INTO vfs_files
				(path, chunk_index, parent_path, data, is_dir, size, mtime)
				VALUES (${newNorm}, ${row.chunk_index}, ${parentPath}, ${row.data}, ${row.is_dir}, ${row.size}, ${row.mtime})`;
		}

		void this.sql`DELETE FROM vfs_files WHERE path = ${oldNorm}`;
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.stat(path);
			return true;
		} catch (err) {
			if ((err as VFSError).code === "ENOENT") return false;
			throw err;
		}
	}

	async write(path: string, data: Uint8Array | string): Promise<void> {
		return await this.writeFile(path, data);
	}

	exportGitObjects(): Array<{ path: string; data: Uint8Array }> {
		const rows = this.sql<{
			path: string;
			data: ArrayBuffer | string | null;
			chunk_index: number;
		}>`
			SELECT path, data, chunk_index FROM vfs_files
			WHERE path LIKE '.git/%' AND is_dir = 0
			ORDER BY path, chunk_index
		`;

		const exported: Array<{ path: string; data: Uint8Array }> = [];
		let currentPath = "";
		let currentChunks: Uint8Array[] = [];

		for (const row of rows) {
			if (row.path !== currentPath) {
				if (currentPath && currentChunks.length > 0) {
					exported.push({
						path: currentPath,
						data: concatBuffers(currentChunks),
					});
				}
				currentPath = row.path;
				currentChunks = [];
			}
			currentChunks.push(rowDataToBytes(row.data));
		}

		// Flush last file
		if (currentPath && currentChunks.length > 0) {
			exported.push({
				path: currentPath,
				data: concatBuffers(currentChunks),
			});
		}

		return exported;
	}

	getStorageStats(): {
		totalObjects: number;
		totalBytes: number;
		largestObject: { path: string; size: number } | null;
	} {
		const stats = this.sql<{ total_files: number; total_bytes: number }>`
			SELECT
				COUNT(DISTINCT path) as total_files,
				COALESCE(SUM(LENGTH(data)), 0) as total_bytes
			FROM vfs_files
			WHERE is_dir = 0
		`;

		const largest = this.sql<{ path: string; total_size: number }>`
			SELECT path, SUM(LENGTH(data)) as total_size
			FROM vfs_files
			WHERE is_dir = 0
			GROUP BY path
			ORDER BY total_size DESC
			LIMIT 1
		`;

		return {
			totalObjects: stats[0]?.total_files ?? 0,
			totalBytes: stats[0]?.total_bytes ?? 0,
			largestObject: largest[0]
				? { path: largest[0].path, size: largest[0].total_size }
				: null,
		};
	}
}
