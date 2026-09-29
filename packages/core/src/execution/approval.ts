/** Approval gating where a command reaches a shell (the workspace `Shell`, each provider's shell tools on register)
 *  and where the agent's tools reach a file. */

import {
  approveFileAccess, commandFilesOwner, gateExec, onUserRoots, reviewProgram, reviewShellCommand, sessionAt,
  STRICT_NO_CHANNEL_POLICY, type ApprovalResult, type FileAccess, type GatedExecutor, type ShellApprovalPolicy, type ShellCwd,
} from '../safety/approval-gate';
import { asBytes, currentBytes } from '../safety/bound-write';
import * as v from 'valibot';
import { answeredRefusal, CommandResultSchema } from './exec-result';
import type { ExecutorProvider, ExecutorTool, ExecutorToolResult } from './types';
import type { Shell, ShellExecOptions, ShellExecResult, VFS } from '../types/primitives';
import type { VfsNativeMutations, VfsNativeReads } from '../vfs/mounts';
import { requireBuild } from './work-mode';
import { refusalOf, type KinuError } from '../obs/error';
import { Effect } from 'effect';
import { settle } from '../obs/effect';

const ShellExecOptionsSchema: v.GenericSchema<ShellExecOptions | undefined> = v.optional(v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
}));

function parseShellExecOptions(input: { value: unknown }): string | ShellExecOptions | undefined {
  const text = v.safeParse(v.string(), input.value);

  if (text.success) return text.output;
  const options = v.safeParse(ShellExecOptionsSchema, input.value);

  return options.success ? options.output : undefined;
}

export type ShellReach = Pick<GatedExecutor, 'filesOwner' | 'shellSession'>;

/** A shell's cwd, read ungated; a durable one outlives its process. Null: unreadable. */
export async function shellCwd(shell: Shell): Promise<string | null> {
  const result = await shell.exec('pwd');
  const cwd = result.stdout.trim();

  return result.refusal === undefined && result.exitCode === 0 && cwd.startsWith('/') ? cwd : null;
}

/** A refusal reads as a command that did not run: exit 1, message on stderr, its code in `refusal`. */
export function withApprovalGatedShell(
  shell: Shell,
  reach: ShellReach,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): Shell {
  const session = reach.shellSession;

  // 'workspace' only: gateProviderExec skips the workspace `exec` because it is gated here.
  const execute = gateExec<ShellExecResult>(
    (command, ...rest) => shell.exec(command, parseShellExecOptions({ value: rest[0] })),
    (error) => ({ stdout: '', stderr: error.message, exitCode: 1, refusal: refusalOf(error) }),
    { name: 'workspace', ...reach },
    { policy, refusalCode: (result) => result.refusal?.reason ?? null },
  );

  const run = async (command: string, stdinOrOptions?: string | ShellExecOptions): Promise<ShellExecResult> => {
    const result = await execute(command, stdinOrOptions);

    if (result.refusal === undefined) session?.ran(command, result.exitCode);

    return result;
  };

  return {
    exec: (command, stdinOrOptions) => {
      requireBuild('Workspace shell execution');

      return session === undefined ? run(command, stdinOrOptions) : session.serial(() => run(command, stdinOrOptions));
    },
  };
}

export interface FileReach {
  readonly userRoots: () => readonly string[];
  readonly locate: ((path: string) => { readonly hostPath: string; readonly outside: boolean }) | null;
  /** An unanswered overwrite of the user's file parks on its bytes; false refuses it. */
  readonly parksWrites: boolean;
}

type Approve = (op: FileAccess['op'], path: string, bytes?: string | Uint8Array) => Effect.Effect<void, KinuError>;

/** A change past the agent's own files is asked; a secret-looking read follows `cat`'s rule. */
export function withApprovalGatedFiles(
  vfs: VFS & Partial<VfsNativeMutations & VfsNativeReads>, executor: string, reach: FileReach, policy: ShellApprovalPolicy,
): VFS {
  const approve: Approve = (op, path, bytes) => Effect.gen(function* () {
    const onUser = onUserRoots(path, reach.userRoots());
    const at = onUser ? undefined : reach.locate?.(path);
    const hostPath = at?.hostPath ?? path;
    const replaces = onUser && op === 'write' && (yield* Effect.promise(() => vfs.exists(path)));
    let reaches: FileAccess['reaches'] = at?.outside === true ? 'outside-directory' : 'own';

    if (onUser) reaches = 'user-mount';

    const write = bytes === undefined ? undefined : {
      subject: async () => ({ path: hostPath, current: await currentBytes(vfs, path), next: asBytes(bytes) }),
      parks: reach.parksWrites && replaces,
    };

    yield* approveFileAccess({ op, path, hostPath, reaches, replaces }, executor, policy, write);
  });

  const gated: VFS & Partial<VfsNativeMutations & VfsNativeReads> = {
    readFile: (path, opts) => settle(Effect.andThen(approve('read', path), Effect.promise(() => vfs.readFile(path, opts)))),
    writeFile: (path, data) => settle(Effect.andThen(approve('write', path, data), Effect.promise(() => vfs.writeFile(path, data)))),
    readdir: (path) => vfs.readdir(path),
    stat: (path) => vfs.stat(path),
    unlink: (path) => settle(Effect.andThen(approve('delete', path), Effect.promise(() => vfs.unlink(path)))),
    // An existing one changes nothing; the file tool makes each write's parent.
    mkdir: (path, opts) => settle(Effect.andThen(
      Effect.flatMap(Effect.promise(() => vfs.exists(path)), (exists) => (exists ? Effect.void : approve('mkdir', path))),
      Effect.promise(() => vfs.mkdir(path, opts)),
    )),
    exists: (path) => vfs.exists(path),
  };

  const conditional = vfs.writeFileIfRevision?.bind(vfs);
  const atRevision = vfs.readFileAtRevision;
  const readRange = vfs.readRange?.bind(vfs);
  const readdirStats = vfs.readdirStats?.bind(vfs);
  const rename = vfs.rename?.bind(vfs);
  const removeRecursive = vfs.removeRecursive?.bind(vfs);

  if (conditional) {
    gated.writeFileIfRevision = (path, data, expected) => settle(Effect.andThen(approve('write', path, data), Effect.promise(() => conditional(path, data, expected))));
  }

  if (atRevision) {
    gated.readFileAtRevision = (path, revision, range) => settle(Effect.andThen(approve('read', path), Effect.promise(() => atRevision(path, revision, range))));
  }

  if (readRange) {
    gated.readRange = (path, offset, length) => settle(Effect.andThen(approve('read', path), Effect.promise(() => readRange(path, offset, length))));
  }

  if (readdirStats) gated.readdirStats = readdirStats;

  if (rename) {
    gated.rename = (from, to) => settle(Effect.andThen(Effect.andThen(approve('delete', from), approve('write', to)), Effect.promise(() => rename(from, to))));
  }

  if (removeRecursive) {
    gated.removeRecursive = (path) => settle(Effect.andThen(approve('delete', path), Effect.promise(() => removeRecursive(path))));
  }

  return gated;
}

/** Tools taking a shell command or a program first; VFS-shaped tools are out of scope. */
const SHELL_COMMAND_MEMBERS = ['exec', 'startProcess', 'runCode'] as const;

const CallOptionsSchema = v.object({ cwd: v.optional(v.string()), language: v.optional(v.string()) });

function parseCallOptions(input: { value: unknown }): v.InferOutput<typeof CallOptionsSchema> {
  const parsed = v.safeParse(CallOptionsSchema, input.value);

  return parsed.success ? parsed.output : {};
}

/** `runCode` is a shell command only in the shell language. */
async function reviewCall(provider: ExecutorProvider, member: string, command: string, rest: readonly unknown[]): Promise<ApprovalResult> {
  const options = parseCallOptions({ value: rest[0] });
  const session = provider.shellSession;
  let at: ShellCwd | undefined;

  if (session !== undefined) at = options.cwd === undefined ? await session.at() : sessionAt(session.home, options.cwd);

  return member === 'runCode' && options.language !== 'shell'
    ? reviewProgram(command, commandFilesOwner(provider, command, at))
    : reviewShellCommand(provider, command, at);
}

function ranExitCode(result: ExecutorToolResult): number | null {
  const parsed = v.safeParse(CommandResultSchema, result);

  if (!parsed.success) return null;

  return v.is(v.string(), parsed.output) ? 0 : parsed.output.execution?.exitCode ?? null;
}

/** Already-wrapped executes, so a provider shared across routers is gated once (idempotent). */
const GATED_EXECUTES = new WeakSet<ExecutorTool['execute']>();

/** Gate an ExecutorProvider's shell-reaching tools; no-op on re-registration. */
export function gateProviderExec(provider: ExecutorProvider, policy: ShellApprovalPolicy): ExecutorProvider {
  let changed = false;
  const tools = { ...provider.tools };

  for (const name of SHELL_COMMAND_MEMBERS) {
    if (provider.kind === 'workspace' && name === 'exec') continue;
    const entry = provider.tools[name];

    if (!entry || GATED_EXECUTES.has(entry.execute)) continue;

    // Grants name the executor; the call picks the rules.
    const gated = gateExec<ExecutorToolResult>(
      (command, ...rest) => entry.execute(command, ...rest),
      (error) => refusalOf(error),
      provider,
      {
        policy,
        refusalCode: (result) => result === undefined ? null : answeredRefusal(result)?.reason ?? null,
        review: (command, rest) => reviewCall(provider, name, command, rest),
      },
    );

    const session = provider.shellSession;

    // Nimbus keeps a shell program's `cd`s (withShellState).
    const run = async (...args: unknown[]): Promise<ExecutorToolResult> => {
      const result = await gated(...args);
      const options = parseCallOptions({ value: args[1] });
      const exitCode = name === 'runCode' && options.language === 'shell' && options.cwd === undefined ? ranExitCode(result) : null;

      if (exitCode !== null) session?.ran(String(args[0]), exitCode);

      return result;
    };

    const execute: ExecutorTool['execute'] = (...args) => {
      requireBuild(provider.name + '.' + name);

      return session === undefined ? run(...args) : session.serial(() => run(...args));
    };

    GATED_EXECUTES.add(execute);
    tools[name] = { ...entry, execute };
    changed = true;
  }

  return changed ? { ...provider, tools } : provider;
}
