import type { VFS } from "../../vfs/types";
import minimist from "minimist";
import { formatDate } from "../helpers";

export async function cmdStat(vfs: VFS, args: string[]): Promise<string> {
	if (args.length === 0) throw new Error("stat: missing operand");
	const results: string[] = [];
	for (const p of args) {
		const st = await vfs.stat(p);
		results.push(
			`  File: ${p}\n` +
			`  Size: ${st.size}\tType: ${st.type}\n` +
			`  Modified: ${formatDate(st.mtimeMs)}`,
		);
	}
	return results.join("\n");
}

export async function cmdWc(vfs: VFS, args: string[], stdin?: string): Promise<string> {
	const opts = minimist(args, { boolean: ["l", "w", "c"] });
	const files = opts._ as string[];
	const showLines = !!opts.l || (!opts.w && !opts.c);
	const showWords = !!opts.w || (!opts.l && !opts.c);
	const showBytes = !!opts.c || (!opts.l && !opts.w);

	async function count(text: string, name: string): Promise<string> {
		const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
		const words = text.split(/\s+/).filter(Boolean).length;
		const bytes = new TextEncoder().encode(text).length;
		const parts: string[] = [];
		if (showLines) parts.push(String(lines).padStart(7));
		if (showWords) parts.push(String(words).padStart(7));
		if (showBytes) parts.push(String(bytes).padStart(7));
		parts.push(` ${name}`);
		return parts.join("");
	}

	if (files.length === 0 && stdin !== undefined) {
		return count(stdin, "");
	}

	const results: string[] = [];
	for (const f of files) {
		const content = await vfs.readFile(f, { encoding: "utf8" }) as string;
		results.push(await count(content, f));
	}
	return results.join("\n");
}
