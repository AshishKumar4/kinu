import type { VFSStat } from "./types";

/** What a walk actually asks of a filesystem: listing and stat, over either
 *  stat dialect — this package's VFSStat with predicates, or core's
 *  VfsEntryStat with a bare `isDir` (the workspace plane and its mount
 *  table). One walk primitive serves both. */
export type WalkStat = VFSStat | { size: number; mtimeMs: number; isDir: boolean };

export type WalkableVFS = {
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<WalkStat | null>;
};

export interface FileEntry {
	path: string;
	stat: WalkStat;
}

export interface WalkResult {
	entries: FileEntry[];
	/** True when the walk stopped at maxEntries — the caller MUST surface
	 *  this, or a bounded listing is indistinguishable from a complete one. */
	truncated: boolean;
	/** True when a subtree was skipped because it lay below maxDepth. Callers
	 *  surface it when the depth was a default guard, not when the user asked
	 *  for that depth (find -maxdepth). */
	depthPruned: boolean;
}

/**
 * Recursively walk a VFS directory tree, collecting file and directory
 * entries. The bounds are runaway guards for degenerate trees, and hitting
 * either is REPORTED so the consumer can say so — a silently bounded walk
 * turns "grep found nothing" into a falsehood on any tree larger than the
 * bound.
 */
export async function walkRecursive(
	vfs: WalkableVFS,
	base: string,
	maxDepth: number,
	maxEntries: number,
): Promise<WalkResult> {
	const entries: FileEntry[] = [];
	let truncated = false;
	let depthPruned = false;

	async function walk(dir: string, depth: number): Promise<void> {
		if (entries.length >= maxEntries) { truncated = true; return; }
		const names = await vfs.readdir(dir);

		for (const name of names) {
			const full = dir ? `${dir}/${name}` : name;
			let caught: WalkStat | null;
			try { caught = await vfs.stat(full); } catch (error) {
				// VFSError is Node-errno shaped: ENOENT is an entry that vanished
				// between readdir and stat; anything else is a real walk failure.
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
				continue;
			}
			// The core dialect stats a vanished entry as null rather than throwing
			// ENOENT — the same skip, for the same reason.
			if (caught === null) continue;
			const st: WalkStat = caught;
			entries.push({ path: full, stat: st });
			// Two stat dialects share this seam: this package's VFSStat carries
			// predicates, core's VfsEntryStat a bare `isDir`. The workspace plane
			// (and its mount table) speaks the second, so the walk reads either.
			const isDir = 'isDir' in st ? st.isDir === true : st.isDirectory();
			if (isDir) {
				if (depth + 1 > maxDepth) { depthPruned = true; continue; }
				await walk(full, depth + 1);
			}
		}
	}

	await walk(base, 0);
	return { entries, truncated, depthPruned };
}
