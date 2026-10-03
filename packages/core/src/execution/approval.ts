import { exists as nimbusExists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Approval gating where a command reaches a shell (the workspace `Shell`, each provider's shell tools on register)
 *  and where the agent's tools reach a file. */

import {
  approveFileAccess, commandFilesOwner, gateExec, onUserRoots, reviewProgram, reviewShellCommand,
  STRICT_NO_CHANNEL_POLICY, type ApprovalResult, type FileAccess, type GatedExecutor, type ShellApprovalPolicy, type ShellCwd,
} from '../safety/approval-gate';
import { asBytes, currentBytes } from '../safety/bound-write';
import * as v from 'valibot';
import { answeredRefusal } from './exec-result';
import type { ExecutorProvider, ExecutorTool, ExecutorToolResult } from './types';
import type { CheckpointFiles, Shell, ShellExecOptions, ShellExecResult } from '../types/primitives';
import { busyShell, callJob, shellExecOptions } from './shell-session';
import { requireBuild } from './work-mode';
import { refusalOf, type KinuError } from '../obs/error';
import { Effect } from 'effect';
import { settle } from '../obs/effect';

export type ShellReach = Pick<GatedExecutor, 'filesOwner' | 'shellSession'>;

/** A refusal reads as a command that did not run: exit 1, message on stderr, its code in `refusal`. */
export function withApprovalGatedShell(
  shell: Shell,
  reach: ShellReach,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): Shell {
  const session = reach.shellSession;

  // 'workspace' only: gateProviderExec skips the workspace `exec` because it is gated here.
  const execute = gateExec<ShellExecResult>(
    (command, ...rest) => shell.exec(command, shellExecOptions({ value: rest[0] })),
    (error) => ({ stdout: '', stderr: error.message, exitCode: 1, refusal: refusalOf(error) }),
    { name: 'workspace', ...reach },
    {
      policy,
      refusalCode: (result) => result.refusal?.reason ?? null,
      review: async (command, rest) => {
        const { name, cwd } = shellExecOptions({ value: rest[0] });

        return reviewShellCommand({ name: 'workspace', ...reach }, command, await session?.at(name, cwd));
      },
    },
  );

  const run = async (command: string, options: ShellExecOptions): Promise<ShellExecResult> => {
    const result = await execute(command, options);

    // A named call that ran leaves its shell where it ended; one that did not run moved nothing.
    if (options.name !== undefined && result.refusal === undefined) session?.ran(options.name, result.finalCwd ?? null);

    return result;
  };

  const gated: Shell = {
    exec: (command, stdinOrOptions) => {
      requireBuild('Workspace shell execution');
      const options = shellExecOptions({ value: stdinOrOptions });

      return session === undefined ? run(command, options) : session.hold(options.name, callJob(options), () => run(command, options), busyShell);
    },
  };

  const cwd = shell.cwd?.bind(shell);

  if (cwd !== undefined) gated.cwd = cwd;

  return gated;
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
  vfs: VFS & CheckpointFiles, executor: string, reach: FileReach, policy: ShellApprovalPolicy,
): VFS & CheckpointFiles {
  const approve: Approve = (op, path, bytes) => Effect.gen(function* () {
    const onUser = onUserRoots(path, reach.userRoots());
    const at = onUser ? undefined : reach.locate?.(path);
    const hostPath = at?.hostPath ?? path;
    const replaces = onUser && op === 'write' && (yield* Effect.promise(async () => nimbusExists(vfs, path)));
    let reaches: FileAccess['reaches'] = at?.outside === true ? 'outside-directory' : 'own';

    if (onUser) reaches = 'user-mount';

    const write = bytes === undefined ? undefined : {
      subject: async () => ({ path: hostPath, current: await currentBytes(vfs, path), next: asBytes(bytes) }),
      parks: reach.parksWrites && replaces,
    };

    yield* approveFileAccess({ op, path, hostPath, reaches, replaces }, executor, policy, write);
  });

  const gated: VFS & CheckpointFiles = {
    readFile: (path) => settle(Effect.andThen(approve('read', path), Effect.promise(async () => vfs.readFile(path)))),
    writeFile: (path, data) => settle(Effect.andThen(approve('write', path, data), Effect.promise(async () => vfs.writeFile(path, data)))),
    readdir: (path) => vfs.readdir(path),
    stat: (path, options) => vfs.stat(path, options),
    unlink: (path) => settle(Effect.andThen(approve('delete', path), Effect.promise(async () => vfs.unlink(path)))),
    // An existing one changes nothing; the file tool makes each write's parent.
    mkdir: (path, opts) => settle(Effect.andThen(
      Effect.flatMap(Effect.promise(async () => nimbusExists(vfs, path)), (exists) => (exists ? Effect.void : approve('mkdir', path))),
      Effect.promise(async () => vfs.mkdir(path, opts)),
    )),
  };

  const reported = vfs.writeFileWithReport?.bind(vfs);
  const conditional = vfs.writeFileIfRevision?.bind(vfs);
  const atRevision = vfs.readFileAtRevision?.bind(vfs);
  const readRange = vfs.readRange?.bind(vfs);
  const rename = vfs.rename?.bind(vfs);
  const removeRecursive = vfs.removeRecursive?.bind(vfs);

  // A write the owner approves still carries what undo cannot restore.
  if (reported) {
    gated.writeFileWithReport = (path, data) => settle(Effect.andThen(approve('write', path, data), Effect.promise(async () => reported(path, data))));
  }

  if (conditional) {
    gated.writeFileIfRevision = (path, data, expected) => settle(Effect.andThen(approve('write', path, data), Effect.promise(async () => conditional(path, data, expected))));
  }

  if (atRevision) {
    gated.readFileAtRevision = (path, revision, range) => settle(Effect.andThen(approve('read', path), Effect.promise(async () => atRevision(path, revision, range))));
  }

  if (readRange) {
    gated.readRange = (path, offset, length) => settle(Effect.andThen(approve('read', path), Effect.promise(async () => readRange(path, offset, length))));
  }


  if (rename) {
    gated.rename = (from, to) => settle(Effect.andThen(Effect.andThen(approve('delete', from), approve('write', to)), Effect.promise(async () => rename(from, to))));
  }

  if (removeRecursive) {
    gated.removeRecursive = (path) => settle(Effect.andThen(approve('delete', path), Effect.promise(async () => removeRecursive(path))));
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
  const at: ShellCwd | undefined = await provider.shellSession?.at(undefined, options.cwd);

  return member === 'runCode' && options.language !== 'shell'
    ? reviewProgram(command, commandFilesOwner(provider, command, at))
    : reviewShellCommand(provider, command, at);
}

/** Already-wrapped executes, so a provider shared across routers is gated once (idempotent). */
const GATED_EXECUTES = new WeakSet<ExecutorTool['execute']>();

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

    const execute: ExecutorTool['execute'] = (...args) => {
      requireBuild(provider.name + '.' + name);

      return gated(...args);
    };

    GATED_EXECUTES.add(execute);
    tools[name] = { ...entry, execute };
    changed = true;
  }

  return changed ? { ...provider, tools } : provider;
}
