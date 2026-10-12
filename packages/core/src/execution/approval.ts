import { exists as nimbusExists, type Awaitable, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Approval gating where a command reaches a shell (the workspace `Shell`, each provider's shell tools on register)
 *  and where the agent's tools reach a file. */

import { literalWords, onUserRoots, type FileAccess, type GatedExecutor } from '../safety/command-review';
import { approveFileAccess, gateExec, namedShellState, pinnedShellMoved, STRICT_NO_CHANNEL_POLICY, type ShellApprovalPolicy } from '../safety/approval-gate';
import { shellCall } from './command-call';
import { asBytes, currentBytes } from '../safety/bound-write';
import { answeredRefusal } from './exec-result';
import { COMMAND_MEMBERS, type CommandTool, type ExecutorProvider, type ExecutorToolResult } from './types';
import type { CheckpointFiles, Shell, ShellExecOptions, ShellExecResult } from '../types/primitives';
import { busyShell, callJob, shellExecOptions } from './shell-session';
import { requireBuild } from './work-mode';
import { resolvedPath, shellReference, type PathPlanes } from '../vfs/resolve';
import { KinuError, refusalOf } from '../obs/error';
import { Effect } from 'effect';
import { settle } from '../obs/effect';

export type ShellReach = Pick<GatedExecutor, 'filesOwner' | 'shellSession'> & {
  /** This workspace's planes: a `root://` word is refused with its real path. Absent, none is. */
  readonly planes?: PathPlanes;
};

/** A refusal reads as a command that did not run: exit 1, message on stderr, its code in `refusal`. */
export function withApprovalGatedShell(
  shell: Shell,
  reach: ShellReach,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): Shell {
  const session = reach.shellSession;

  // 'workspace' only: gateProviderExec skips the workspace `exec` because it is gated here. The options were read once,
  // by `exec` below; the gate keys and runs those.
  const notRun = (error: KinuError): ShellExecResult => ({ stdout: '', stderr: error.message, exitCode: 1, refusal: refusalOf(error) });

  // A gated call in a named shell is asked with that shell's state, and runs only while the shell still restores it;
  // the whole call is inside the shell's hold, so nothing of this agent moves it in between.
  const execute = (command: string, options: ShellExecOptions) => gateExec<ShellExecResult>(
    () => {
      const { name } = options;
      const read = shell.state?.bind(shell);
      const state = name === undefined || read === undefined ? undefined : () => namedShellState(() => read(name), name);

      return {
        call: { ...shellCall(command, options, { stdin: true }), ...(state !== undefined && { shellState: state }) },
        run: async (pinned) => {
          const moved = pinned === undefined ? null : await pinnedShellMoved(pinned, name ?? '', state);

          return moved === null ? shell.exec(command, options) : notRun(moved);
        },
      };
    },
    notRun,
    { name: 'workspace', ...reach },
    { policy, refusalCode: (result) => result.refusal?.reason ?? null, member: 'exec' },
  )();

  const run = async (command: string, options: ShellExecOptions): Promise<ShellExecResult> => {
    const planes = reach.planes;
    const misnamed = planes === undefined ? null : literalWords(command).map((word) => shellReference(word, planes)).find((why) => why !== null);

    if (misnamed !== undefined && misnamed !== null) {
      const refused = new KinuError('bad_input', `NOT RUN: ${misnamed}`);

      return { stdout: '', stderr: refused.message, exitCode: 1, refusal: refusalOf(refused) };
    }

    let result: ShellExecResult | undefined;

    try {
      result = await execute(command, options);
    } finally {
      if (options.name !== undefined && result === undefined) session?.lost(options.name);
    }

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
  /** Every path is resolved here first, so the gate and the plane see the one the agent named. */
  readonly planes: PathPlanes;
  /**
   * Then through the plane's own lookup, its links followed (the last one unless `follow` is false): the gate decides on
   * the path the operation reaches, and the operation runs there, so a link cannot turn the user's file into the agent's.
   */
  readonly resolve: ((path: string, follow: boolean) => Promise<string>) | null;
  readonly userRoots: () => readonly string[];
  /** Where `op` on `path` lands on the machine, and whether that is past the agent's own files. */
  readonly locate: ((path: string, op: FileAccess['op']) => { readonly hostPath: string; readonly outside: boolean }) | null;
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
    const at = onUser ? undefined : reach.locate?.(path, op);
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

  // A removal acts on the entry itself, so its own name is not followed; every other op reaches what a link names.
  const at = (path: string, follow = true) => Effect.flatMap(resolvedPath(path, reach.planes), ({ absolute }) => (reach.resolve === null
    ? Effect.succeed(absolute)
    : Effect.tryPromise({ try: async () => reach.resolve?.(absolute, follow) ?? absolute, catch: (cause) => cause }).pipe(Effect.orDie)));

  /** The path the agent named, asked for as `op`, then run there. */
  const asked = <T>(op: FileAccess['op'], written: string, run: (path: string) => Awaitable<T>, bytes?: string | Uint8Array) =>
    Effect.flatMap(at(written, op !== 'delete'), (path) => Effect.andThen(approve(op, path, bytes), Effect.promise(async () => run(path))));

  const unasked = <T>(written: string, run: (path: string) => Awaitable<T>, follow = true) =>
    Effect.flatMap(at(written, follow), (path) => Effect.promise(async () => run(path)));

  const gated: VFS & CheckpointFiles = {
    readFile: (path) => settle(asked('read', path, (absolute) => vfs.readFile(absolute))),
    writeFile: (path, data) => settle(asked('write', path, (absolute) => vfs.writeFile(absolute, data), data)),
    readdir: (path) => settle(unasked(path, (absolute) => vfs.readdir(absolute))),
    stat: (path, options) => settle(unasked(path, (absolute) => vfs.stat(absolute, options), options?.follow !== false)),
    unlink: (path) => settle(asked('delete', path, (absolute) => vfs.unlink(absolute))),
    // An existing one changes nothing; the file tool makes each write's parent.
    mkdir: (written, opts) => settle(Effect.flatMap(at(written), (path) => Effect.andThen(
      Effect.flatMap(Effect.promise(async () => nimbusExists(vfs, path)), (exists) => (exists ? Effect.void : approve('mkdir', path))),
      Effect.promise(async () => vfs.mkdir(path, opts)),
    ))),
  };

  const reported = vfs.writeFileWithReport?.bind(vfs);
  const conditional = vfs.writeFileIfRevision?.bind(vfs);
  const atRevision = vfs.readFileAtRevision?.bind(vfs);
  const readRange = vfs.readRange?.bind(vfs);
  const rename = vfs.rename?.bind(vfs);
  const removeRecursive = vfs.removeRecursive?.bind(vfs);

  // A write the owner approves still carries what undo cannot restore.
  if (reported) gated.writeFileWithReport = (path, data) => settle(asked('write', path, (absolute) => reported(absolute, data), data));

  if (conditional) {
    gated.writeFileIfRevision = (path, data, expected) => settle(asked('write', path, (absolute) => conditional(absolute, data, expected), data));
  }

  if (atRevision) gated.readFileAtRevision = (path, revision, range) => settle(asked('read', path, (absolute) => atRevision(absolute, revision, range)));

  if (readRange) gated.readRange = (path, offset, length) => settle(asked('read', path, (absolute) => readRange(absolute, offset, length)));

  if (rename) {
    gated.rename = (writtenFrom, writtenTo) => settle(Effect.flatMap(Effect.all([at(writtenFrom, false), at(writtenTo, false)]), ([from, to]) => Effect.andThen(
      Effect.andThen(approve('delete', from), approve('write', to)),
      Effect.promise(async () => rename(from, to)),
    )));
  }

  if (removeRecursive) gated.removeRecursive = (path) => settle(asked('delete', path, (absolute) => removeRecursive(absolute)));

  return gated;
}

/** Already-wrapped executes, so a provider shared across routers is gated once (idempotent). */
const GATED_EXECUTES = new WeakSet<CommandTool['execute']>();

export function gateProviderExec(provider: ExecutorProvider, policy: ShellApprovalPolicy): ExecutorProvider {
  let changed = false;
  const tools = { ...provider.tools };

  for (const name of COMMAND_MEMBERS) {
    if (provider.kind === 'workspace' && name === 'exec') continue;
    const entry = provider.tools[name];

    if (!entry || GATED_EXECUTES.has(entry.execute)) continue;
    const read = entry.prepare;
    changed = true;

    // A member that cannot say what a call runs cannot be approved, so nothing it is asked runs.
    if (read === undefined) {
      const unread = new KinuError('unsupported', `${provider.name}.${name} does not say what a call runs, so it cannot be approved: nothing ran`);
      tools[name] = { ...entry, execute: async () => refusalOf(unread) };
      continue;
    }

    // Grants name the executor; the member's own reading of the call picks the rules and is what runs.
    const gated = gateExec<ExecutorToolResult>(
      (args) => read(args),
      (error) => refusalOf(error),
      provider,
      { policy, refusalCode: (result) => result === undefined ? null : answeredRefusal(result)?.reason ?? null, member: name },
    );

    const execute: CommandTool['execute'] = (...args) => {
      requireBuild(provider.name + '.' + name);

      return gated(...args);
    };

    GATED_EXECUTES.add(execute);

    // Its reading stays the member's, but what it runs goes through the gate: no ungated `run` leaves here.
    const prepare: CommandTool['prepare'] = (args) => {
      const prepared = read(args);

      return 'refused' in prepared ? prepared : { call: prepared.call, run: () => execute(...args) };
    };

    tools[name] = { ...entry, prepare, execute };
  }

  return changed ? { ...provider, tools } : provider;
}
