import type { VFS } from "../../vfs/types";
import minimist from "minimist";
import picomatch from "picomatch";

export async function cmdTree(vfs: VFS, args: string[]): Promise<string> {
	const opts = minimist(args, {
		default: { L: 3 },
		boolean: ["d"],
		string: ["I"],
		alias: { L: "level", I: "ignore" },
	});
	const root = (opts._ as string[])[0] ?? "";
	const maxDepth = Number(opts.L);
	const dirsOnly = opts.d as boolean;
	const ignorePattern = opts.I ? picomatch(opts.I as string) : null;

	const lines: string[] = [];
	let dirs = 0;
	let files = 0;

	async function walk(dir: string, prefix: string, depth: number): Promise<void> {
		if (depth >= maxDepth) return;
		let entries: string[];
		try { entries = await vfs.readdir(dir); } catch { return; }
		entries = entries.filter((n) => !n.startsWith("."));
		if (ignorePattern) entries = entries.filter((n) => !ignorePattern(n));
		entries.sort();

		for (let i = 0; i < entries.length; i++) {
			const name = entries[i];
			const full = dir ? `${dir}/${name}` : name;
			const isLast = i === entries.length - 1;
			const connector = isLast ? "└── " : "├── ";
			const childPrefix = prefix + (isLast ? "    " : "│   ");

			let isDir = false;
			try { const st = await vfs.stat(full); isDir = st.isDirectory(); } catch { continue; }

			if (dirsOnly && !isDir) continue;

			if (isDir) {
				dirs++;
				lines.push(`${prefix}${connector}${name}/`);
				await walk(full, childPrefix, depth + 1);
			} else {
				files++;
				lines.push(`${prefix}${connector}${name}`);
			}
		}
	}

	lines.push(root || ".");
	await walk(root, "", 0);

	const summary = dirsOnly
		? `\n${dirs} directories`
		: `\n${dirs} directories, ${files} files`;
	lines.push(summary);
	return lines.join("\n");
}
