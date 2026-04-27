/**
 * Virtual Filesystem abstraction for @cf-utils/agent-utils.
 *
 * Provides a POSIX-like async filesystem interface that can be backed by
 * Durable Object SQLite, Cloudflare R2, in-memory storage, or any custom backend.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VFSStat {
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
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface VFS {
	/** Self-reference for Node FS compat (isomorphic-git). */
	promises: VFS;

	readFile(path: string, options?: { encoding?: "utf8" }): Promise<Uint8Array | string>;
	writeFile(path: string, data: Uint8Array | string): Promise<void>;
	write(path: string, data: Uint8Array | string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<VFSStat>;
	lstat(path: string): Promise<VFSStat>;
	unlink(path: string): Promise<void>;
	mkdir(path: string, options?: unknown): Promise<void>;
	rmdir(path: string): Promise<void>;
	removeRecursive(path: string): Promise<void>;
	symlink(target: string, path: string): Promise<void>;
	readlink(path: string): Promise<string>;
	chmod(path: string, mode: number): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Errors & Helpers
// ---------------------------------------------------------------------------

export interface VFSError extends Error {
	code?: string;
	errno?: number;
	path?: string;
}

export function makeError(message: string, code: string, path: string): VFSError {
	const err: VFSError = new Error(message);
	err.code = code;
	err.errno = code === "ENOENT" ? -2 : -1;
	err.path = path;
	return err;
}

export function makeStat(type: "file" | "dir", size: number, mtimeMs: number): VFSStat {
	const isDir = type === "dir";
	return {
		type,
		mode: isDir ? 0o040755 : 0o100644,
		size,
		mtimeMs,
		dev: 0,
		ino: 0,
		uid: 0,
		gid: 0,
		ctime: new Date(mtimeMs),
		mtime: new Date(mtimeMs),
		ctimeMs: mtimeMs,
		isFile: () => !isDir,
		isDirectory: () => isDir,
		isSymbolicLink: () => false,
	};
}
