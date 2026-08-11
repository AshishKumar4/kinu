import type { VFS } from "../../vfs/types";
import minimist from "minimist";
import picomatch from "picomatch";
import { walkRecursive } from "../helpers";

export async function cmdGrep(vfs: VFS, args: string[], stdin?: string): Promise<string> {
	const opts = minimist(args, {
		boolean: ["r", "n", "i", "l", "c", "v", "E"],
		string: ["include", "e"],
		alias: { r: "recursive", n: "line-number", i: "ignore-case", l: "files-with-matches", c: "count", v: "invert-match", E: "extended-regexp" },
	});

	const pattern = (opts.e as string) ?? (opts._ as string[])[0];
	if (!pattern) throw new Error("grep: missing pattern");

	const paths = opts.e ? (opts._ as string[]) : (opts._ as string[]).slice(1);
	const flags = opts.i ? "gi" : "g";
	const re = new RegExp(pattern, flags);
	const includeMatch = opts.include ? picomatch(opts.include as string) : null;
	const multiFile = !!(opts.r) || paths.length > 1;
	const maxMatches = 100;

	const results: string[] = [];
	let matchCount = 0;

	async function grepContent(filePath: string, content: string): Promise<void> {
		const lines = content.split("\n");
		let fileCount = 0;

		for (let i = 0; i < lines.length; i++) {
			if (matchCount >= maxMatches) return;
			const matched = re.test(lines[i]);
			re.lastIndex = 0;
			const include = opts.v ? !matched : matched;
			if (!include) continue;

			matchCount++;
			fileCount++;

			if (opts.l) { results.push(filePath); return; }
			if (opts.c) continue;

			const prefix = multiFile ? `${filePath}:` : "";
			const lineNum = opts.n ? `${i + 1}:` : "";
			results.push(`${prefix}${lineNum}${lines[i]}`);
		}

		if (opts.c) {
			results.push(multiFile ? `${filePath}:${fileCount}` : `${fileCount}`);
		}
	}

	if (stdin !== undefined && paths.length === 0) {
		await grepContent("(stdin)", stdin);
		return results.join("\n");
	}

	if (opts.r) {
		const root = paths[0] ?? ".";
		const base = root === "." ? "" : root;
		const walk = await walkRecursive(vfs, base, 20, 2000);

		for (const e of walk.entries) {
			if (e.stat.isDirectory()) continue;
			const basename = e.path.split("/").pop() ?? "";
			if (includeMatch && !includeMatch(basename)) continue;
			try {
				const content = await vfs.readFile(e.path, { encoding: "utf8" }) as string;
				await grepContent(e.path, content);
			} catch { continue; }
			if (matchCount >= maxMatches) break;
		}
		// A silently bounded walk turns "no matches" into a falsehood — say so.
		if (walk.truncated) results.push("... (file walk stopped at 2000 entries; narrow the path or use --include)");
		else if (walk.depthPruned) results.push("... (directories deeper than 20 levels not searched)");
	} else {
		for (const p of paths) {
			try {
				const content = await vfs.readFile(p, { encoding: "utf8" }) as string;
				await grepContent(p, content);
			} catch {
				results.push(`grep: ${p}: No such file or directory`);
			}
			if (matchCount >= maxMatches) break;
		}
	}

	if (matchCount >= maxMatches) results.push(`... (truncated at ${maxMatches} matches, use -l for file list)`);
	return results.join("\n");
}
