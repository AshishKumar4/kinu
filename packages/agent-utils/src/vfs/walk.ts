import type { VFS, VFSStat } from "./types";

export interface FileEntry {
	path: string;
	stat: VFSStat;
}

/**
 * Recursively walk a VFS directory tree, collecting file and directory entries.
 *
 * Stops early when `maxDepth` or `maxEntries` is reached.
 */
export async function walkRecursive(
	vfs: VFS,
	base: string,
	maxDepth: number,
	maxEntries: number,
): Promise<FileEntry[]> {
	const results: FileEntry[] = [];

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > maxDepth || results.length >= maxEntries) return;
		let entries: string[];
		try { entries = await vfs.readdir(dir); } catch { return; }

		for (const name of entries) {
			if (results.length >= maxEntries) return;
			const full = dir ? `${dir}/${name}` : name;
			let st: VFSStat;
			try { st = await vfs.stat(full); } catch { continue; }
			results.push({ path: full, stat: st });
			if (st.isDirectory()) await walk(full, depth + 1);
		}
	}

	await walk(base, 0);
	return results;
}
