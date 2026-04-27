import type { VFS } from "../../vfs/types";

export async function cmdSed(vfs: VFS, args: string[]): Promise<string> {
	if (args.length === 0) throw new Error("sed: missing expression");

	const inPlace = args[0] === "-i";
	const expr = inPlace ? args[1] : args[0];
	const file = inPlace ? args[2] : args[1];

	if (!expr) throw new Error("sed: missing expression");

	const match = expr.match(/^s(.)(.+?)\1(.*?)\1(g?)$/);
	if (!match) throw new Error("sed: only s/pattern/replacement/[g] is supported");

	const [, , pattern, replacement, global] = match;
	const re = new RegExp(pattern, global ? "g" : "");

	if (file) {
		const content = await vfs.readFile(file, { encoding: "utf8" }) as string;
		const result = content.replace(re, replacement);
		if (inPlace) {
			await vfs.writeFile(file, result);
			return "";
		}
		return result;
	}

	throw new Error("sed: missing file operand");
}
