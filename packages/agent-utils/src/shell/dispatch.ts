import type { VFS, VFSError } from "../vfs/types";
import { vfsAddressingHint } from "../vfs/addressing";
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

/** Where the working directory comes from: the file plane this shell runs
 *  over decides it, and the shell is stateless (`cd` is refused), so `pwd` is
 *  a constant — which is exactly the truth about this shell. */
export interface ShellContext {
	cwd?: string;
}

function commandTable(ctx: ShellContext): Record<string, CommandFn> {
	return {
		cat: cmdCat, head: cmdHead, tail: cmdTail,
		ls: cmdLs, tree: cmdTree, find: cmdFind, grep: cmdGrep,
		echo: cmdEcho, mkdir: cmdMkdir, touch: cmdTouch,
		rm: cmdRm, cp: cmdCp, mv: cmdMv,
		sed: cmdSed, stat: cmdStat, wc: cmdWc,
		pwd: async () => `${ctx.cwd ?? "/"}\n`,
	};
}

const PROGRAM_COMMANDS = new Set([
	"npm", "npx", "node", "bun", "bunx", "deno", "python", "python3", "pip",
	"git", "curl", "wget", "make", "cargo", "go", "ruby", "java", "javac",
	"docker", "kubectl", "terraform", "ssh", "scp", "rsync",
	"bash", "sh", "zsh", "fish",
]);

const SHELL_BUILTINS = new Set(["cd", "export", "source", "alias", "unset", "set"]);

/**
 * What this shell IS, said at every failure that a model would otherwise read
 * as "the files are not there" or "the tool is broken".
 *
 * A head once ran `find`/`ls` against a container path here, got a bare
 * `command not found` and an `ENOENT`, concluded the repository did not exist,
 * and gave up — six heads, zero findings. It was addressing the right paths on
 * the wrong filesystem with the wrong shell, and nothing in either error said
 * so. Every error out of here now names the shell, lists what it really has,
 * and points at the executors that have real binaries.
 */
function shellIdentity(available: string[]): string {
	return (
		"this is Proteus's emulated shell — it runs inside the agent, over the agent's own file plane, " +
		"and has no real binaries, no processes and no PATH. It implements only: " +
		available.join(", ") +
		". For anything else (a real find/xargs/sort, a build, a package manager, a test run), " +
		"run the command in an environment that has one: the `run` tool with " +
		'runtime "sandbox", "nimbus" or "laptop" (or the sandbox.*/nimbus.*/laptop.* namespaces ' +
		"inside execute_tools). Check the system prompt for which of those are live this turn."
	);
}

/** POSIX-style codes the file plane raises. A shell error carrying one is a
 *  PATH error, and a path error is the one that needs the addressing hint. */
const PATH_ERROR_CODES = new Set([
	"ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "EEXIST", "ENOTEMPTY", "ENXIO", "EROFS",
]);

function isPathError(err: unknown): err is VFSError {
	return err instanceof Error && PATH_ERROR_CODES.has((err as VFSError).code ?? "");
}

/** A failure message with the correction attached when the failure was about
 *  a path — the same sentence `workspace.*` and the `file` tool append, so a
 *  model that mis-addressed the plane is told the same thing whichever surface
 *  it used. */
async function describeFailure(vfs: VFS, err: unknown): Promise<string> {
	const message = err instanceof Error ? err.message : String(err);
	if (!isPathError(err)) return message;
	return `${message} — ${await vfsAddressingHint(vfs, "this shell's paths")}`;
}

async function execPipeline(
	vfs: VFS,
	commands: Record<string, CommandFn>,
	pipeline: ParsedPipeline,
	stdin?: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	try {
		let data = stdin;

		for (const cmd of pipeline.commands) {
			if (signal?.aborted) return abortedResult();
			const name = cmd.argv[0];
			const args = cmd.argv.slice(1);

			if (PROGRAM_COMMANDS.has(name)) {
				return {
					stdout: "",
					stderr: `sh: ${name}: ${shellIdentity(Object.keys(commands))}`,
					exitCode: 127,
				};
			}
			if (SHELL_BUILTINS.has(name)) {
				return { stdout: "", stderr: `sh: ${name}: stateless shell — specify full paths`, exitCode: 1 };
			}

			const fn = commands[name];
			if (!fn) {
				return {
					stdout: "",
					stderr: `sh: command not found: ${name} — ${shellIdentity(Object.keys(commands))}`,
					exitCode: 127,
				};
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
		if (pipeline.suppressErrors) return { stdout: "", stderr: "", exitCode: 1 };
		return { stdout: "", stderr: await describeFailure(vfs, err), exitCode: 1 };
	}
}

export async function exec(
	vfs: VFS,
	input: string,
	options?: ShellExecOptions & ShellContext,
): Promise<ShellResult> {
	const { stdin, signal } = options ?? {};
	const commands = commandTable({ ...(options?.cwd ? { cwd: options.cwd } : {}) });
	try {
		const commandList = parseCommandList(input);
		let lastResult: ShellResult = { stdout: "", stderr: "", exitCode: 0 };
		const outputs: string[] = [];

		let skip = false;
		for (let i = 0; i < commandList.segments.length; i++) {
			const segment = commandList.segments[i];
			if (skip) { skip = false; continue; }
			if (signal?.aborted) return abortedResult(outputs.join(""));

			lastResult = await execPipeline(vfs, commands, segment.pipeline, stdin, signal);
			if (lastResult.stdout) outputs.push(lastResult.stdout);
			if (lastResult.exitCode === ABORT_EXIT_CODE && signal?.aborted) {
				return abortedResult(outputs.join(""));
			}

			if (segment.operator === "&&" && lastResult.exitCode !== 0) break;
			if (segment.operator === "||" && lastResult.exitCode === 0) skip = true;
		}

		return { stdout: outputs.join(""), stderr: lastResult.stderr, exitCode: lastResult.exitCode };
	} catch (err) {
		return { stdout: "", stderr: await describeFailure(vfs, err), exitCode: 1 };
	}
}
