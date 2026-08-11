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

	const walk = await walkRecursive(vfs, path, maxDepth, 2000);
	const results: string[] = [];

	for (const e of walk.entries) {
		if (typeFilter === "f" && e.stat.isDirectory()) continue;
		if (typeFilter === "d" && !e.stat.isDirectory()) continue;
		const basename = e.path.split("/").pop() ?? "";
		if (namePattern && !namePattern(basename)) continue;
		results.push(e.path);
	}

	// The entry bound is a runaway guard, never intent — always disclosed. The
	// default depth is a guard too, but -maxdepth is the user's own filter.
	if (walk.truncated) results.push("... (walk stopped at 2000 entries; narrow the path or add -maxdepth)");
	else if (walk.depthPruned && !args.some((a) => a === "-maxdepth" || a.startsWith("--maxdepth"))) {
		results.push(`... (directories deeper than ${maxDepth} levels not listed)`);
	}

	return results.join("\n");
}
