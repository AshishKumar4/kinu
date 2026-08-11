import type { VFS } from "../../vfs/types";
import minimist from "minimist";
import { humanSize, formatDate, walkRecursive } from "../helpers";

export async function cmdLs(vfs: VFS, args: string[]): Promise<string> {
	const opts = minimist(args, {
		boolean: ["l", "a", "R", "h", "t", "1"],
		alias: { R: "recursive" },
	});
	const path = (opts._ as string[])[0] ?? "";

	if (opts.R) {
		const walk = await walkRecursive(vfs, path, 50, 2000);
		const lines = opts.l
			? walk.entries.map((e) => formatLong(e.path, e.stat, !!opts.h))
			: walk.entries.map((e) => e.path);
		if (walk.truncated) lines.push("... (listing stopped at 2000 entries; list a subdirectory instead)");
		return lines.join("\n");
	}

	let entries = await vfs.readdir(path);
	if (!opts.a) entries = entries.filter((n) => !n.startsWith("."));

	if (opts.t || opts.l) {
		const withStats = await Promise.all(entries.map(async (name) => {
			const full = path ? `${path}/${name}` : name;
			try { return { name, stat: await vfs.stat(full) }; } catch { return { name, stat: null }; }
		}));
		if (opts.t) withStats.sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0));
		if (opts.l) {
			const lines = withStats.map((e) => formatLong(e.name, e.stat, !!opts.h));
			return lines.join("\n");
		}
		entries = withStats.map((e) => e.name);
	}

	if (opts["1"] || opts.l) return entries.join("\n");
	return entries.join("  ");
}

function formatLong(name: string, stat: { type: string; size: number; mtimeMs: number; mode: number } | null, human: boolean): string {
	if (!stat) return `??????????  ? ?    ?         ? ? ${name}`;
	const type = stat.type === "dir" ? "d" : "-";
	const perms = modeString(stat.mode);
	const size = human ? humanSize(stat.size).padStart(5) : String(stat.size).padStart(8);
	const date = formatDate(stat.mtimeMs);
	return `${type}${perms}  1 user user ${size} ${date} ${name}`;
}

function modeString(mode: number): string {
	const m = mode & 0o777;
	let s = "";
	for (const shift of [6, 3, 0]) {
		const bits = (m >> shift) & 7;
		s += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-");
	}
	return s;
}
