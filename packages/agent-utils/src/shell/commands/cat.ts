import type { VFS } from "../../vfs/types";
import minimist from "minimist";

export async function cmdCat(vfs: VFS, args: string[], stdin?: string): Promise<string> {
	const opts = minimist(args, { boolean: ["n", "b"], alias: { n: "number", b: "number-nonblank" } });
	const files = opts._ as string[];

	if (files.length === 0 && stdin !== undefined) {
		return addLineNumbers(stdin, !!opts.n, !!opts.b);
	}
	if (files.length === 0) throw new Error("cat: missing operand");

	const parts: string[] = [];
	for (const f of files) {
		const content = await vfs.readFile(f, { encoding: "utf8" }) as string;
		parts.push(content);
	}
	const combined = parts.join("");
	return addLineNumbers(combined, !!opts.n, !!opts.b);
}

export async function cmdHead(vfs: VFS, args: string[], stdin?: string): Promise<string> {
	const opts = minimist(args, { default: { n: 10 } });
	const n = Number(opts.n);
	const files = opts._ as string[];

	const text = files.length > 0
		? await vfs.readFile(files[0], { encoding: "utf8" }) as string
		: stdin ?? "";

	return text.split("\n").slice(0, n).join("\n");
}

export async function cmdTail(vfs: VFS, args: string[], stdin?: string): Promise<string> {
	const opts = minimist(args, { default: { n: 10 } });
	const n = Number(opts.n);
	const files = opts._ as string[];

	const text = files.length > 0
		? await vfs.readFile(files[0], { encoding: "utf8" }) as string
		: stdin ?? "";

	const lines = text.split("\n");
	return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function addLineNumbers(text: string, number: boolean, numberNonblank: boolean): string {
	if (!number && !numberNonblank) return text;
	const lines = text.split("\n");
	let counter = 0;
	return lines.map((line) => {
		if (numberNonblank && line.trim() === "") return line;
		counter++;
		return `${String(counter).padStart(6, " ")}\t${line}`;
	}).join("\n");
}
