/**
 * Virtual Filesystem abstraction for @proteus/agent-utils.
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

/**
 * What a store here actually reads and writes.
 *
 * Narrow on purpose: MemoryStore indexes markdown out of the workspace
 * filesystem, and those three methods are all it has ever called. Asking for a
 * whole Node-shaped fs forced every caller to build an adapter over the real
 * filesystem just to satisfy methods nothing invoked.
 */
export interface ReadWriteVFS {
	readFile(path: string, options?: { encoding?: "utf8" }): Promise<Uint8Array | string>;
	writeFile(path: string, data: Uint8Array | string): Promise<void>;
	readdir(path: string): Promise<string[]>;
}

export interface VFS extends ReadWriteVFS {
	/** Self-reference for Node FS compat (isomorphic-git). */
	promises: VFS;

	write(path: string, data: Uint8Array | string): Promise<void>;
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
