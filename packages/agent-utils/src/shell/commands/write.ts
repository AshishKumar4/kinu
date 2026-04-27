import type { VFS } from "../../vfs/types";
import minimist from "minimist";

const PROTECTED = new Set(["", "memory", "sessions", "shared", "sandbox"]);

export async function cmdEcho(_vfs: VFS, args: string[]): Promise<string> {
	let noNewline = false;
	const textArgs: string[] = [];
	for (const arg of args) {
		if (arg === "-n") { noNewline = true; continue; }
		if (arg === "-e") continue;
		textArgs.push(arg);
	}
	const text = textArgs.join(" ");
	return noNewline ? text : text + "\n";
}

export async function cmdMkdir(vfs: VFS, args: string[]): Promise<string> {
	const opts = minimist(args, { boolean: ["p"] });
	for (const p of opts._ as string[]) {
		await vfs.mkdir(p);
	}
	return "";
}

export async function cmdTouch(vfs: VFS, args: string[]): Promise<string> {
	for (const p of args) {
		const exists = await vfs.exists(p);
		if (!exists) await vfs.writeFile(p, "");
	}
	return "";
}

export async function cmdRm(vfs: VFS, args: string[]): Promise<string> {
	const opts = minimist(args, { boolean: ["r", "f"], alias: { r: "recursive" } });
	for (const p of opts._ as string[]) {
		if (PROTECTED.has(p)) throw new Error(`rm: cannot remove '${p}': Protected system path`);
		try {
			if (opts.r) {
				await vfs.removeRecursive(p);
			} else {
				await vfs.unlink(p);
			}
		} catch (err) {
			if (!opts.f) throw err;
		}
	}
	return "";
}

export async function cmdCp(vfs: VFS, args: string[]): Promise<string> {
	const opts = minimist(args, { boolean: ["r"], alias: { r: "recursive" } });
	const paths = opts._ as string[];
	if (paths.length < 2) throw new Error("cp: missing destination operand");
	if (opts.r) throw new Error("cp: recursive copy not yet supported. Use codemode for directory operations.");
	const data = await vfs.readFile(paths[0]);
	await vfs.writeFile(paths[1], data);
	return "";
}

export async function cmdMv(vfs: VFS, args: string[]): Promise<string> {
	const opts = minimist(args, { boolean: ["f", "n"] });
	const paths = opts._ as string[];
	if (paths.length < 2) throw new Error("mv: missing destination operand");
	await vfs.rename(paths[0], paths[1]);
	return "";
}
