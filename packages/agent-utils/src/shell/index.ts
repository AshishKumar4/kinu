import type { VFS } from "../vfs/types";
import { exec, type ShellContext, type ShellExecOptions } from "./dispatch";
export type { ShellContext, ShellExecOptions, ShellResult } from "./dispatch";

/**
 * The emulated POSIX shell over a file plane.
 *
 * `context.cwd` is what `pwd` reports and how the plane resolves a relative
 * path — the shell itself is stateless (`cd` is refused), so it is the plane's
 * working directory, not the shell's.
 */
export function createShell(vfs: VFS, context: ShellContext = {}) {
	return {
		exec: (command: string, stdinOrOptions?: string | ShellExecOptions) => {
			const options = typeof stdinOrOptions === "string" ? { stdin: stdinOrOptions } : stdinOrOptions;
			return exec(vfs, command, { ...context, ...options });
		},
	};
}
