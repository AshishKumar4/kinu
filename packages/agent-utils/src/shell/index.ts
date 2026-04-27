import type { VFS } from "../vfs/types";
import { exec } from "./dispatch";
export type { ShellResult } from "./dispatch";

export function createShell(vfs: VFS) {
	return {
		exec: (command: string, stdin?: string) => exec(vfs, command, stdin),
	};
}
