/** The listing/stat shape a walk needs. */
export type WalkStat = { size: number; mtimeMs: number; isDir: boolean };

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
	/** Hit maxEntries; callers must surface it, or a bounded listing reads as complete. */
	truncated: boolean;
	/** A subtree lay below maxDepth; surface it when the depth was a default guard, not user-chosen. */
	depthPruned: boolean;
}

/** Recursively walk a VFS tree. Hitting either bound is reported so an empty result is not a false negative. */
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
		if (entries.length >= maxEntries) {
			truncated = true;

			return;
		}

		const names = await vfs.readdir(dir);

		for (const name of names) {
			const full = dir ? `${dir}/${name}` : name;
			let caught: WalkStat | null;

			try { caught = await vfs.stat(full); } catch (error) {
				// ENOENT: entry vanished between readdir and stat; anything else is a real failure.
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
				continue;
			}

			// The workspace plane stats a vanished entry as null instead of throwing ENOENT.
			if (caught === null) continue;
			entries.push({ path: full, stat: caught });

			if (caught.isDir) {
				if (depth + 1 > maxDepth) { depthPruned = true; continue; }

				await walk(full, depth + 1);
			}
		}
	}

	await walk(base, 0);

	return { entries, truncated, depthPruned };
}
