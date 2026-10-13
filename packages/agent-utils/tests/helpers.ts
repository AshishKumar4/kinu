import type { VfsDirent } from '@nimbus-sh/core/vfs/vfs.js';

/** A map-backed byte filesystem; the production filesystem lives in Nimbus. */
export function createMemoryVfs(seed: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(seed));

	return {
		files,
		async readFile(path: string): Promise<Uint8Array> {
			const content = files.get(path);

			if (content === undefined) {
				throw Object.assign(
					new Error(`ENOENT: no such file or directory, open '${path}'`),
					{ code: "ENOENT" },
				);
			}

			return new TextEncoder().encode(content);
		},
		async writeFile(path: string, data: Uint8Array): Promise<void> {
			files.set(path, new TextDecoder().decode(data));
		},
		async readdir(path: string): Promise<VfsDirent[]> {
			const prefix = path === "" || path === "." ? "" : `${path}/`;
			const names = new Set<string>();

			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const name = key.slice(prefix.length).split("/").at(0);

				if (name) names.add(name);
			}

			return [...names].map((name) => ({ name, type: files.has(`${prefix}${name}`) ? 'file' : 'directory' }));
		},
	};
}
