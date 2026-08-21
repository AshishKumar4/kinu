import type { VFS, VFSStat } from "./types";

export interface FileEntry {
	path: string;
	stat: VFSStat;
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
	vfs: VFS,
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
			if (entries.length >= maxEntries) { truncated = true; return; }
			const full = dir ? `${dir}/${name}` : name;
			let st: VFSStat;
			try { st = await vfs.stat(full); } catch (error) {
				// VFSError is Node-errno shaped: ENOENT is an entry that vanished
				// between readdir and stat; anything else is a real walk failure.
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
				continue;
			}
			entries.push({ path: full, stat: st });
			if (st.isDirectory()) {
				if (depth + 1 > maxDepth) { depthPruned = true; continue; }
				await walk(full, depth + 1);
			}
		}
	}

	await walk(base, 0);
	return { entries, truncated, depthPruned };
}
