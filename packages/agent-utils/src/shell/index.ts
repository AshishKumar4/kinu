import type { VFS } from "../vfs/types";
import { exec, type ShellExecOptions } from "./dispatch";
export type { ShellExecOptions, ShellResult } from "./dispatch";

export function createShell(vfs: VFS) {
	return {
		exec: (command: string, stdinOrOptions?: string | ShellExecOptions) => {
			const options = typeof stdinOrOptions === "string" ? { stdin: stdinOrOptions } : stdinOrOptions;
			return exec(vfs, command, options);
		},
	};
}
