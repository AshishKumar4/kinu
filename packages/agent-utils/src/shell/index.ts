import type { VFS } from "../vfs/types";
import { exec } from "./dispatch";
export type { ShellResult } from "./dispatch";

export function createShell(vfs: VFS) {
	return {
		exec: (command: string, stdinOrOptions?: string | { stdin?: string; signal?: AbortSignal }) => {
			const stdin = typeof stdinOrOptions === "string" ? stdinOrOptions : stdinOrOptions?.stdin;
			return exec(vfs, command, stdin);
		},
	};
}
