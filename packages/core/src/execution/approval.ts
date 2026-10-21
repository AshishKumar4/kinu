import { exists as nimbusExists, type Awaitable, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
/** Approval gating where a command reaches a shell (the workspace `Shell`, each provider's shell tools on register)
 *  and where the agent's tools reach a file. */

import { wasNotDispatched } from '@kinu.run/agent-utils';
import { literalWords, onUserRoots, type FileAccess, type GatedExecutor } from '../safety/command-review';
import { approveFileAccess, gateExec, namedShellCall, STRICT_NO_CHANNEL_POLICY, type ShellApprovalPolicy } from '../safety/approval-gate';
import { shellCall } from './command-call';
import { asBytes, currentBytes } from '../safety/bound-write';
import { answeredRefusal } from './exec-result';
import { COMMAND_MEMBERS, type CommandTool, type ExecutorProvider, type ExecutorToolResult } from './types';
import type { CheckpointFiles, Shell, ShellExecOptions, ShellExecResult } from '../types/primitives';
import { busyShell, callJob, shellExecOptions } from './shell-session';
import { requireBuild } from './work-mode';
import { resolvedPath, shellReference, type PathPlanes } from '../vfs/resolve';
import type { PathOwner, VfsMountRouting } from '../vfs/mounts';
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
      const named = namedShellCall(shellCall(command, options, { stdin: true }), options.name, shell.state?.bind(shell));

      return {
        call: named.call,
        run: (pinned) => named.run(pinned, () => shell.exec(command, options), notRun),
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

    const running = execute(command, options);
    const [ran] = await Promise.allSettled([running]);

    // A named call that ran leaves its shell where it ended; one that did not run moved nothing; one that failed on
    // its way may have moved it, unless it was cancelled before it was sent.
    if (options.name !== undefined && ran.status === 'fulfilled' && ran.value.refusal === undefined) session?.ran(options.name, ran.value.finalCwd ?? null);

    if (options.name !== undefined && ran.status === 'rejected' && !wasNotDispatched(ran.reason)) session?.lost(options.name);

    return running;
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
  readonly resolve: ((path: string, follow: boolean, creating: boolean) => Promise<string>) | null;
  /** The machine a path is on, by the plane's own lookup (`VfsMountRouting.owner`); null where every path is its own. */
  readonly owner: ((path: string) => Promise<PathOwner>) | null;
  readonly userRoots: () => readonly string[];
  /** Where `op` on `path` lands on the machine, and whether that is past the agent's own files. */
  readonly locate: ((path: string, op: FileAccess['op']) => { readonly hostPath: string; readonly outside: boolean }) | null;
  /** An unanswered overwrite of the user's file parks on its bytes; false refuses it. */
  readonly parksWrites: boolean;
}

type Approve = (op: FileAccess['op'], path: string, bytes?: string | Uint8Array) => Effect.Effect<void, KinuError>;

/**
 * The hosted workspace's tool files: its mounted plane behind the approval gate, every lookup the plane's own. The
 * runtime's, and its tests': a seam assembled apart from the runtime is how a lookup went missing (staging rc29).
 */
export function hostedToolFiles(
  plane: VFS & CheckpointFiles & Pick<VfsMountRouting, 'resolve' | 'owner' | 'userRoots'>, planes: PathPlanes, policy: ShellApprovalPolicy,
): VFS & CheckpointFiles & Pick<VfsMountRouting, 'resolve' | 'owner'> {
  return withApprovalGatedFiles(plane, 'workspace', {
    planes,
    resolve: (path, follow, creating) => plane.resolve(path, { follow, creating }),
    owner: (path) => plane.owner(path),
    userRoots: () => plane.userRoots(),
    locate: null,
    parksWrites: true,
  }, policy);
}

/** A change past the agent's own files is asked; a secret-looking read follows `cat`'s rule. */
export function withApprovalGatedFiles(
  vfs: VFS & CheckpointFiles, executor: string, reach: FileReach, policy: ShellApprovalPolicy,
): VFS & CheckpointFiles & Pick<VfsMountRouting, 'resolve' | 'owner'> {
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

  // A removal acts on the entry itself, so its own name is not followed; every other op reaches what a link names. Only an
  // op that makes its parents (`creating`) passes a missing directory on the way; any other is handed the path as named,
  // and its own walk answers it as the plane does (a read ENOENT, a stat null), never a path the missing one collapsed to.
  const at = (path: string, follow = true, creating = false) => Effect.flatMap(resolvedPath(path, reach.planes), ({ absolute }) => (reach.resolve === null
    ? Effect.succeed(absolute)
    : Effect.tryPromise({ try: async () => reach.resolve?.(absolute, follow, creating) ?? absolute, catch: (cause) => cause }).pipe(
      Effect.catchIf((cause) => !creating && isVfsError(cause, 'ENOENT'), () => Effect.succeed(absolute)),
      Effect.orDie,
    )));

  /** The path the agent named, asked for as `op`, then run there. */
  const asked = <T>(op: FileAccess['op'], written: string, run: (path: string) => Awaitable<T>, bytes?: string | Uint8Array) =>
    Effect.flatMap(at(written, op !== 'delete', op === 'write'), (path) => Effect.andThen(approve(op, path, bytes), Effect.promise(async () => run(path))));

  const unasked = <T>(written: string, run: (path: string) => Awaitable<T>, follow = true) =>
    Effect.flatMap(at(written, follow), (path) => Effect.promise(async () => run(path)));

  const gated: VFS & CheckpointFiles & Pick<VfsMountRouting, 'resolve' | 'owner'> = {
    // Where a path lands, as every op here resolves it: what a result names a file by.
    resolve: (path, options) => settle(at(path, options?.follow ?? true, options?.creating === true)),
    // The machine it is on, by the same path the ops take: a command whose cwd it is runs there (staging rc29: without
    // this, a program's cwd under /computer ran in the workspace).
    owner: async (path) => {
      const { absolute } = await settle(resolvedPath(path, reach.planes));

      return reach.owner === null ? { executor: 'workspace', path: absolute } : await reach.owner(absolute);
    },
    readFile: (path) => settle(asked('read', path, (absolute) => vfs.readFile(absolute))),
    writeFile: (path, data) => settle(asked('write', path, (absolute) => vfs.writeFile(absolute, data), data)),
    readdir: (path) => settle(unasked(path, (absolute) => vfs.readdir(absolute))),
    stat: (path, options) => settle(unasked(path, (absolute) => vfs.stat(absolute, options), options?.follow !== false)),
    unlink: (path) => settle(asked('delete', path, (absolute) => vfs.unlink(absolute))),
    // An existing one changes nothing; the file tool makes each write's parent.
    mkdir: (written, opts) => settle(Effect.flatMap(at(written, true, opts?.recursive === true), (path) => Effect.andThen(
      Effect.flatMap(Effect.promise(async () => nimbusExists(vfs, path)), (exists) => (exists ? Effect.void : approve('mkdir', path))),
      Effect.promise(async () => vfs.mkdir(path, opts)),
    ))),
  };

  const reported = vfs.writeFileWithReport?.bind(vfs);
  const conditional = vfs.writeFileIfRevision?.bind(vfs);
  const digestChecked = vfs.writeFileIfDigest?.bind(vfs);
  const atRevision = vfs.readFileAtRevision?.bind(vfs);
  const readRange = vfs.readRange?.bind(vfs);
  const rename = vfs.rename?.bind(vfs);
  const removeRecursive = vfs.removeRecursive?.bind(vfs);
  const rmdir = vfs.rmdir?.bind(vfs);

  // A write the owner approves still carries what undo cannot restore.
  if (reported) gated.writeFileWithReport = (path, data) => settle(asked('write', path, (absolute) => reported(absolute, data), data));

  if (conditional) {
    gated.writeFileIfRevision = (path, data, expected) => settle(asked('write', path, (absolute) => conditional(absolute, data, expected), data));
  }

  if (digestChecked) {
    gated.writeFileIfDigest = (path, data, expected) => settle(asked('write', path, (absolute) => digestChecked(absolute, data, expected), data));
  }

  if (atRevision) gated.readFileAtRevision = (path, revision, range) => settle(asked('read', path, (absolute) => atRevision(absolute, revision, range)));

  if (readRange) gated.readRange = (path, offset, length) => settle(asked('read', path, (absolute) => readRange(absolute, offset, length)));

  if (rename) {
    gated.rename = (writtenFrom, writtenTo) => settle(Effect.flatMap(Effect.all([at(writtenFrom, false), at(writtenTo, false, true)]), ([from, to]) => Effect.andThen(
      Effect.andThen(approve('delete', from), approve('write', to)),
      Effect.promise(async () => rename(from, to)),
    )));
  }

  if (removeRecursive) gated.removeRecursive = (path) => settle(asked('delete', path, (absolute) => removeRecursive(absolute)));

  if (rmdir) gated.rmdir = (path) => settle(asked('delete', path, (absolute) => rmdir(absolute)));

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
