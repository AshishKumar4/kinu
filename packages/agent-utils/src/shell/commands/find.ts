import type { VFS } from "../../vfs/types";
import minimist from "minimist";
import picomatch from "picomatch";
import { walkRecursive } from "../helpers";

export async function cmdFind(vfs: VFS, args: string[]): Promise<string> {
	const opts = minimist(args, {
		string: ["name", "type", "maxdepth"],
		default: { maxdepth: "10" },
	});
	const root = (opts._ as string[])[0] ?? ".";
	const path = root === "." ? "" : root;
	const maxDepth = Number(opts.maxdepth);
	const namePattern = opts.name ? picomatch(opts.name as string) : null;
	const typeFilter = opts.type as string | undefined;

	const entries = await walkRecursive(vfs, path, maxDepth, 200);
	const results: string[] = [];

	for (const e of entries) {
		if (typeFilter === "f" && e.stat.isDirectory()) continue;
		if (typeFilter === "d" && !e.stat.isDirectory()) continue;
		const basename = e.path.split("/").pop() ?? "";
		if (namePattern && !namePattern(basename)) continue;
		results.push(e.path);
	}

	return results.join("\n");
}
