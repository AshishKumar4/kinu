import type { VFS } from "../vfs/types";
import { parseCommandList, type ParsedPipeline } from "./parse";
import { cmdCat, cmdHead, cmdTail } from "./commands/cat";
import { cmdLs } from "./commands/ls";
import { cmdTree } from "./commands/tree";
import { cmdFind } from "./commands/find";
import { cmdGrep } from "./commands/grep";
import { cmdEcho, cmdMkdir, cmdTouch, cmdRm, cmdCp, cmdMv } from "./commands/write";
import { cmdSed } from "./commands/edit";
import { cmdStat, cmdWc } from "./commands/stat";

export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ShellExecOptions {
	stdin?: string;
	/** Cancels between commands: the current built-in finishes, the rest of
	 *  the pipeline/command list is skipped and exec returns exit code 130. */
	signal?: AbortSignal;
}

const ABORT_EXIT_CODE = 130;

function abortedResult(stdout = ""): ShellResult {
	return { stdout, stderr: "aborted", exitCode: ABORT_EXIT_CODE };
}

type CommandFn = (vfs: VFS, args: string[], stdin?: string) => Promise<string>;

const COMMANDS: Record<string, CommandFn> = {
	cat: cmdCat, head: cmdHead, tail: cmdTail,
	ls: cmdLs, tree: cmdTree, find: cmdFind, grep: cmdGrep,
	echo: cmdEcho, mkdir: cmdMkdir, touch: cmdTouch,
	rm: cmdRm, cp: cmdCp, mv: cmdMv,
	sed: cmdSed, stat: cmdStat, wc: cmdWc,
};

const PROGRAM_COMMANDS = new Set([
	"npm", "npx", "node", "bun", "bunx", "deno", "python", "python3", "pip",
	"git", "curl", "wget", "make", "cargo", "go", "ruby", "java", "javac",
	"docker", "kubectl", "terraform", "ssh", "scp", "rsync",
	"bash", "sh", "zsh", "fish",
]);

const SHELL_BUILTINS = new Set(["cd", "export", "source", "alias", "unset", "set"]);

async function execPipeline(vfs: VFS, pipeline: ParsedPipeline, stdin?: string, signal?: AbortSignal): Promise<ShellResult> {
	try {
		let data = stdin;

		for (const cmd of pipeline.commands) {
			if (signal?.aborted) return abortedResult();
			const name = cmd.argv[0];
			const args = cmd.argv.slice(1);

			if (PROGRAM_COMMANDS.has(name)) {
				return { stdout: "", stderr: `sh: ${name}: cannot execute programs — this is Proteus's own internal scratch filesystem, not a real machine. Use the run tool against a real runtime (this turn's Execution environments list which ones are available) to run ${name}.`, exitCode: 127 };
			}
			if (SHELL_BUILTINS.has(name)) {
				return { stdout: "", stderr: `sh: ${name}: stateless shell — specify full paths`, exitCode: 1 };
			}

			const fn = COMMANDS[name];
			if (!fn) {
				const supported = Object.keys(COMMANDS).join(", ");
				return { stdout: "", stderr: `sh: ${name}: command not found. This is Proteus's own internal virtual filesystem — an emulated scratch shell with a small fixed command set, never a repository checkout or a real machine, and it runs no real binaries. Commands available here: ${supported}. For a real shell, use the run tool against one of this turn's other available runtimes.`, exitCode: 127 };
			}

			data = await fn(vfs, args, data);
		}

		if (signal?.aborted) return abortedResult();

		if (pipeline.redirect && data) {
			const content = typeof data === "string" ? data : "";
			if (pipeline.redirect.type === ">>") {
				let existing = "";
				try { existing = (await vfs.readFile(pipeline.redirect.path, { encoding: "utf8" })) as string; } catch { /* file may not exist */ }
				await vfs.writeFile(pipeline.redirect.path, existing + content);
			} else {
				await vfs.writeFile(pipeline.redirect.path, content);
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		}

		return { stdout: data ?? "", stderr: "", exitCode: 0 };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (pipeline.suppressErrors) return { stdout: "", stderr: "", exitCode: 1 };
		return { stdout: "", stderr: msg, exitCode: 1 };
	}
}

export async function exec(vfs: VFS, input: string, options?: ShellExecOptions): Promise<ShellResult> {
	const { stdin, signal } = options ?? {};
	try {
		const commandList = parseCommandList(input);
		let lastResult: ShellResult = { stdout: "", stderr: "", exitCode: 0 };
		const outputs: string[] = [];

		let skip = false;
		for (let i = 0; i < commandList.segments.length; i++) {
			const segment = commandList.segments[i];
			if (skip) { skip = false; continue; }
			if (signal?.aborted) return abortedResult(outputs.join(""));

			lastResult = await execPipeline(vfs, segment.pipeline, stdin, signal);
			if (lastResult.stdout) outputs.push(lastResult.stdout);
			if (lastResult.exitCode === ABORT_EXIT_CODE && signal?.aborted) {
				return abortedResult(outputs.join(""));
			}

			if (segment.operator === "&&" && lastResult.exitCode !== 0) break;
			if (segment.operator === "||" && lastResult.exitCode === 0) skip = true;
		}

		return { stdout: outputs.join(""), stderr: lastResult.stderr, exitCode: lastResult.exitCode };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { stdout: "", stderr: msg, exitCode: 1 };
	}
}
