import type { VFS, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
/** Native container executor, one durable workspace per agent, exposed as computer.*. */

import * as v from 'valibot';
import { abortedBeforeStart } from '@kinu.run/agent-utils';
import { Cause, Effect, Exit } from 'effect';
import type { ExecutorProvider, ExecutorCapability, ExecutorStatus, PortExposureResult, PreviewRouteCheck, SandboxSize, SandboxSizes } from './types';
import { commandTool, ExecutorPortSchema, type ExecutorTool, type ExecutorToolResult } from './types';
import { shellCall } from './command-call';
import { callJob, createShellSession, machineShellCall, machineShellCwd, reportsCwd, shellExecOptions, type MachineShells, type ShellSession } from './shell-session';
import { namedShellCall, type CommandCall } from '../safety/approval-gate';
import type { CheckpointFiles, OutputSink, VfsDigestWrite } from '../types/primitives';
import { JOB_STAMP_ENV, newJobId, type AdoptsJobs } from '../types/jobs';
import { currentWorkMode } from './work-mode';
import { commandAnswer, ExecPartsSchema, type ExecOutcome } from './exec-result';
import { classifyErrorCode, KinuError, refusalOf, settle, tolerated, toKinuError, type Refusal } from '../obs/index';
import { isVfsError, isVfsErrorCode, syscallError, type VfsError, type VfsErrorCode } from '@nimbus-sh/core/vfs/vfs-error.js';
import { shellQuote } from '../utils/shell';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { parseInput, projectJsonValue, type JsonValue } from '../utils/json';
import { direntType } from '../vfs/dirent';
import { EXECUTOR_MOUNTS } from '../vfs/mounts';
import { DEVBOX_WORKDIR, type DigestWriteRequest } from '@kinu.run/devbox/wire';
import { desktopTools, type DesktopAnswer, type DesktopRequest, type DesktopScreen } from './desktop';
import type { CommandEnvironment } from './command-environment';
import { COMPUTER_OWNER_ONLY, ownerComputerCall, secretsCaller } from './secrets-caller';

interface SandboxExposeOptions {
  name?: string;
  /** Supplied, never left to the SDK: see {@link SandboxHandle.portToken}. */
  token?: string;
}

/** Shared by core and every adapter; field semantics on `SandboxHandle.exec`. */
interface SandboxExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  output?: OutputSink;
}

interface SandboxPortListener {
  readonly port: number;
  readonly pid: number;
  readonly stamp: string | null;
  readonly command: string;
}

interface SandboxFileMetadata {
  readonly type: string;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly atimeMs?: number;
  readonly ctimeMs?: number;
}

export interface SandboxHandle {
  /** Every operation awaits this first so an agent never observes a half-restored workspace. */
  ensureReady(): Promise<void>;
  /**
   * The workspace's settings put on the computer (egress, /workspace) without waiting for it to be ready: a terminal
   * attach waits inside the box, telling its pane why (devbox D109). A handle with no terminal has none.
   */
  configure?(): Promise<void>;
  /**
   * `timeout` absent means no work deadline: native container exec adds none.
   * `signal` cancels the remote work: settle only once the process is gone; a transport with no kill must not accept one.
   */
  exec(command: string, opts?: SandboxExecOptions): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** `base64` is the only exact read; without it the content is UTF-8 text. */
  readFile(path: string, opts?: { encoding?: 'utf-8' | 'base64' }):
    Promise<{ content?: string; encoding?: string; isBinary?: boolean; exitCode?: number }>;
  writeFile(path: string, content: string, opts?: { encoding?: 'utf-8' | 'base64' }): Promise<JsonValue | void>;
  /** Lands `contentBase64` only over the bytes whose sha256 is `expected` (null: no file there), in one guest step.
   *  `operation` names this write across every send of it; `settled` names this caller's earlier writes it has answers
   *  for, whose answers the guest no longer keeps. */
  writeFileIfDigest(write: DigestWriteRequest): Promise<VfsDigestWrite>;
  listFiles(path: string, opts?: { recursive?: boolean }):
    Promise<{ files: Array<SandboxFileMetadata & { name: string }> }>;
  /** Native stat; `follow: false` reads the entry itself, never its siblings. */
  statFile(path: string, opts?: { follow?: boolean }): Promise<SandboxFileMetadata>;
  deleteFile(path: string): Promise<JsonValue | void>;
  /** The box serves its own preview zone; `token` comes from {@link SandboxHandle.portToken}. */
  exposePort(port: number, opts: { name?: string; token?: string }):
    Promise<{ url: string; port: number; name?: string; route: PreviewRouteCheck }>;
  unexposePort(port: number): Promise<JsonValue | void>;
  getExposedPorts():
    Promise<Array<{ url: string; port: number; name?: string; status?: string }>>;
  /**
   * The only kind of background process that survives container sleep; `env` is kept with it and set again on each
   * restart. `reveal`: the owner started it, so at each start and restart the box asks the account for the values this
   * workspace's agents may read, and the process holds them in memory only.
   */
  /** Answers `job` where the process runs as one: an earlier start's, when the same command still runs. */
  startSupervisedProcess(command: string, opts?: { cwd?: string; env?: Readonly<Record<string, string>>; reveal?: boolean; job?: string }):
    Promise<{ processId: string; job?: string }>;
  stopSupervisedProcess(processId: string): Promise<{ stopped: boolean }>;
  /** What a supervised job wrote most recently, both streams as its terminal showed them. */
  supervisedProcessLogs(processId: string, limits: { readonly lines?: number | undefined; readonly bytes?: number | undefined }): Promise<string>;
  listSupervisedProcesses(): Promise<Array<{
    processId: string; pid?: number; status: string; command: string; restartable: boolean;
    /** The last line a job wrote, while it waits at a prompt (D95). */
    waiting?: string | undefined;
    /** The terminal session it runs in (D95). */
    session?: string | undefined;
  }>>;
  /** Asked before the first exposure: restarts re-expose with the stored token, so the first URL must use it too. */
  portToken(port: number, name?: string): Promise<{ urlToken: string }>;
  /** Required native HTTP listener proof. A transport failure throws rather than answering false. */
  probePort(port: number): Promise<boolean>;
  /** `stamp` read up holders' ancestry; null while down (never starts it). */
  portListeners(stamp: string, ports?: readonly number[]): Promise<readonly SandboxPortListener[] | null>;
  /** The pids running under `stamp=value`; null while down (never starts it). */
  stampedProcesses(stamp: string, value: string): Promise<readonly number[] | null>;
  /** Records the size; a container running at another size restarts at it, and one not running stays so. */
  resize(size: string): Promise<SandboxResize>;
  answerRest(answer: 'now' | 'keep'): Promise<SandboxRestAnswer>;
  /** One action on the desktop the owner watches, starting it when it is not running; the box refuses what only it can
   *  check (a point off the screen, another agent driving) before any input reaches the screen. `signal` stops it as it
   *  stops an exec: settle only once its process is gone and what it held is let go (D89). */
  desktop(request: DesktopRequest, opts?: { readonly signal?: AbortSignal }): Promise<DesktopAnswer>;
  /** `driver`'s turns ended, or it was stopped: the desktop is free for another agent to take by looking (D89). */
  releaseDesktop(driver: string): Promise<void>;
}

export type SandboxRestAnswer =
  | { readonly kind: 'resting' }
  | { readonly kind: 'kept'; readonly askAgainAfterMs: number }
  | { readonly kind: 'refused' | 'failed'; readonly reason: string };

function restText(answered: SandboxRestAnswer): string | Refusal {
  switch (answered.kind) {
    case 'resting':
      return 'The computer saved its workspace and stopped. The next computer call starts it again.';
    case 'kept':
      return `The computer keeps running. It asks again after about ${String(Math.round(answered.askAgainAfterMs / 60_000))} minutes without use.`;
    case 'refused':
      return refusalOf(new KinuError('bad_input', `computer.rest: ${answered.reason}`));
    case 'failed':
      return refusalOf(new KinuError('io', `computer.rest: the computer could not save its workspace, so it keeps running: ${answered.reason}`));
  }
}

/** `failed`: the final checkpoint failed, so the container runs on at `previous` until its next start. */
export type SandboxResize =
  | { readonly kind: 'recorded' | 'unchanged'; readonly size: string }
  | { readonly kind: 'restarted'; readonly size: string; readonly previous: string | undefined; readonly endedCommands: number }
  | { readonly kind: 'failed'; readonly size: string; readonly previous: string | undefined; readonly reason: string };

/** Everything but the lifecycle word, which each branch of `getStatus` names. */
type ExecutorStatusBase = Omit<ExecutorStatus, 'status'>;

/** `Medium (2 vCPU, 8 GiB)`: what the prompt, the types and a resize's answer call a size. */
export function sandboxSizeLabel(row: SandboxSize): string {
  return `${row.label} (${String(row.vcpu)} vCPU, ${String(Math.round(row.memoryMib / 102.4) / 10)} GiB)`;
}

function labelOf(sizes: SandboxSizes, size: string | undefined): string {
  const row = sizes.sizes.find((candidate) => candidate.size === size);

  return row === undefined ? String(size) : sandboxSizeLabel(row);
}

/** The answer to `computer.resize`, in the terms its declaration uses. */
function resizedText(resized: SandboxResize, sizes: SandboxSizes): string | Refusal {
  const size = labelOf(sizes, resized.size);

  switch (resized.kind) {
    case 'recorded':
      return `The computer is not running; it starts at ${size}.`;
    case 'unchanged':
      return `The computer already runs at ${size}.`;
    case 'restarted': {
      const ended = resized.endedCommands === 0 ? '' : `; ${String(resized.endedCommands)} running command${resized.endedCommands === 1 ? '' : 's'} ended`;

      return `The computer restarted at ${size}${resized.previous === undefined ? '' : `, from ${labelOf(sizes, resized.previous)}`}. `
        + `Files are kept, and supervised servers and exposed ports came back${ended}.`;
    }

    case 'failed':
      return refusalOf(new KinuError('io', `The computer still runs at ${labelOf(sizes, resized.previous)}: its final checkpoint failed `
        + `(${resized.reason}). It starts at ${size} next time.`));
  }
}

const NOT_CONFIGURED =
  'Sandbox executor not configured. Add the KinuDevbox binding ' +
  'and its container to wrangler.jsonc (see docs/EXECUTION-LAYER-SPEC.md).';

const PREVIEWS_NOT_CONFIGURED =
  'Sandbox previews are off: PREVIEW_HOST_SUFFIX is unset, so there is no zone to mint preview ' +
  'hostnames on. Turning them on takes a proxied wildcard DNS record and a matching route on a zone; ' +
  'the PREVIEW_HOST_SUFFIX note in wrangler.jsonc has both steps. Exec and files still work.';

/** Lower-cased markers for transient sandbox/RPC errors, retried with backoff. Each is a failure the platform was seen
 *  to raise; an unmeasured marker is not retried. */
const TRANSIENT_MARKERS = [
  // First call after a stop/eviction can land while the RPC session tears down (measured 2026-09-05, DECISIVE-2026-09-05.md).
  'while the runtime connection was closing',
  // The container runtime's dropped connection, from a call to a container that went away: Workers telemetry
  // 2026-10-07..14 records it on Cloudflare Containers under this runtime (armada's ArmadaVessel, a devbox ContractBox).
  'network connection lost',
  // A Durable Object storage reset, from the same telemetry (armada-dew2's ArmadaVessel, 2026-10-10 20:31:58Z).
  'internal error in durable object storage caused object to be reset',
];

const StringSchema = v.string();

const OptionalStringSchema = v.optional(v.string());


export function isSandboxTransientError(error: Error | string): boolean {
  const msg = (error instanceof Error ? error.message : error).toLowerCase();

  return TRANSIENT_MARKERS.some(m => msg.includes(m));
}

/** No container binding. `unavailable` (not `unsupported`) matches the shell tool's code for an unprovisioned runtime.
 *  Built per call, as every refusal is: an object shared between calls would carry one caller's edits to the next. */
const notConfigured = (): Refusal => refusalOf(new KinuError('unavailable', NOT_CONFIGURED));

/** `unsupported`: the container works; no `PREVIEW_HOST_SUFFIX` means no retry can succeed. */

/** A transport failure left after its retries is the box out of reach, so `unavailable`, not `io`.
 *  A recognised cause keeps its own, more precise code. */
function sandboxFailure(input: { doing: string; cause: unknown }): KinuError {
  const transient = isSandboxTransientError(
    input.cause instanceof Error ? input.cause : String(input.cause),
  );

  return toKinuError({ ...input, otherwise: transient ? 'unavailable' : 'io' });
}

export class SandboxPending extends KinuError {
  constructor(reason: string) {
    super('unavailable', reason);
  }
}

/** `fn`, asked again after a transient transport failure, three times in all, 0.5 s then 1 s apart; any other failure
 *  is what it was. */
function retried<T>(fn: () => Promise<T>, attempt = 0): Effect.Effect<T> {
  return Effect.catchCause(Effect.promise(fn), (cause) => {
    const err = Cause.squash(cause);

    // A classified `unavailable` is a verdict: marker text in its reason must not re-enter the retry loop.
    if ((err instanceof KinuError && err.code === 'unavailable') || !isSandboxTransientError(err instanceof Error ? err : String(err)) || attempt === 2) {
      return Effect.failCause(cause);
    }

    return Effect.flatMap(Effect.promise(async () => new Promise((resolve) => { setTimeout(resolve, 500 * Math.pow(2, attempt)); })), () => retried(fn, attempt + 1));
  });
}

/** `effect`'s failure, of whatever kind, as the refusal `doing` answers with; its success as `answer` says it. */
function refusedAs<A, R extends ExecutorToolResult>(effect: Effect.Effect<A>, doing: string, answer: (value: A) => R): Effect.Effect<R | Refusal> {
  return Effect.catchCause(Effect.map(effect, answer), (cause) => Effect.succeed(refusalOf(sandboxFailure({ doing, cause: Cause.squash(cause) }))));
}

/** Worded distinctly from the adapter's own cancellation, which names the process it killed. */
function cancelledWhileRunning(command: string): Error {
  return new DOMException(`computer.exec \`${command}\` cancelled while it ran`, 'AbortError');
}

function notDispatched(): Error {
  return abortedBeforeStart('computer.exec cancelled before dispatch: no container process was started');
}

export interface SandboxExecutorOptions {
  /** Without it only port exposure refuses. */
  readonly previewHostSuffix?: string | undefined;
  readonly activated?: () => void;
  /** Without them there is no `resize`. */
  readonly sizes?: SandboxSizes;
  /** Where this agent's named shells keep their state; without it a name is refused. */
  readonly shells?: MachineShells;
  /** The desktop: this agent, as the box tells its drivers apart, and the screen as the box's own constants set it;
   *  without it the computer offers no desktop. */
  readonly desktop?: { readonly driver: string; readonly screen: DesktopScreen };
  /** The owner's secrets granted to this workspace, as each command's variables; without it a command gets none. */
  readonly environment?: CommandEnvironment;
  /**
   * The actor's jobs, a process `startProcess` starts among them, and each one's end as the box tells it
   * (`process-ended`); without them a process is no job.
   */
  readonly processJobs?: ComputerProcessJobs;
}

/** What every member of the computer's surface works over: its handle (none: not configured), its named shells, and
 *  the one way a call through it marks the computer in use. */
/** A computer's process as its job's: its end, as the box tells it. */
export interface ComputerProcessEnd {
  /** Absent where the box kept none (the process was lost). */
  readonly exitCode?: number;
  /** The last of what it wrote, which says why it ended. */
  readonly tail: string;
}

const ComputerProcessJobInput = v.object({ processId: v.string(), machine: v.literal('computer'), job: v.string() });

/** A job that is a computer's process (`adoptedProcess` writes its input): its process and its own id; else null. */
export function computerProcessJob(kind: string, input: JsonValue): { readonly processId: string; readonly job: string } | null {
  if (kind !== 'startProcess') return null;
  const parsed = v.safeParse(ComputerProcessJobInput, input);

  return parsed.success ? { processId: parsed.output.processId, job: parsed.output.job } : null;
}

/** The actor's jobs, and the box's word on when a job's process ends. */
export interface ComputerProcessJobs extends AdoptsJobs {
  ended(jobId: string): Promise<ComputerProcessEnd>;
  /** Whether a job's row exists, and still runs: one a lost reply left unmade is `missing`. */
  state(jobId: string): 'missing' | 'running' | 'settled';
}

interface Computer {
  readonly handle: SandboxHandle | undefined;
  readonly processJobs: ComputerProcessJobs | undefined;
  readonly names: ShellSession;
  readonly shells: MachineShells | undefined;
  readonly touch: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Absent where no account grants secrets: a command then waits on nothing before it is dispatched. */
  readonly environment: CommandEnvironment | undefined;
}

const EXEC_DESCRIPTION = 'Run a shell command on your computer. '
  + 'BUN IS THE DEFAULT toolchain here (bun 1.3.12 ships in the image): use `bun install`, '
  + '`bun run`, `bun x` and `bun test` rather than npm, npx, yarn or pnpm unless a project '
  + 'genuinely requires one of those. '
  + 'A workspace restored after the container slept keeps its source and its LOCKFILES but '
  + 'not its regenerable trees (node_modules, .venv, build output): if an import fails after '
  + 'a restore, run one `bun install` before concluding anything is missing.';

/** `computer.exec`. */
function execMember({ handle, names, shells, touch, environment }: Computer): (args: readonly unknown[]) => EffectPrepared {
  return (args) => {
    if (!handle) return { refused: notConfigured() };
    const command = parseInput(StringSchema, { value: args[0] });

    if (command === undefined) return { refused: refusalOf(new KinuError('bad_input', 'computer.exec: command must be a string')) };
    const exec = shellExecOptions({ value: args[1] });
    const { signal, job, output } = exec;

    if (exec.name !== undefined && shells === undefined) {
      return { refused: refusalOf(new KinuError('unsupported', 'computer.exec: this runtime keeps no named shells')) };
    }

    const place = { home: DEVBOX_WORKDIR, scope: shells?.scope ?? '', stateDirectory: shells?.stateDirectory ?? '' };
    const reportCwd = reportsCwd({ context: args[1] });
    const { name } = exec;

    // What the named shell restores, read in the container; an approval binds it, and the run checks it again. The
    // container takes no stdin from a call.
    const named = namedShellCall(shellCall(command, exec, { stdin: false }), name, shells === undefined ? undefined : async (shell) => (await machineShellCwd({
      exec: async (read) => {
        const r = await touch(() => handle.exec(read, { cwd: DEVBOX_WORKDIR }));

        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
      },
    }, shell, shells))?.state ?? null);

    // No work deadline: see SandboxHandle.exec. The signal goes to the container; locally it only refuses to
    // dispatch. One call: the handle owns any re-call after a lost reply, under the call's one launch id.
    return { call: named.call, run: (pinned) => Effect.catchCause(Effect.promise(async () => names.hold(name, callJob(exec), () => named.run(pinned, async () => {
      const env: Record<string, string> = environment === undefined ? {} : { ...await environment('run', secretsCaller()) };

      if (job !== undefined) env[JOB_STAMP_ENV] = job;
      const call = machineShellCall(command, exec, place, Object.keys(env));

      const res = await touch(() => {
        if (signal?.aborted) throw notDispatched();
        // The signal is added only when given, so an adapter can tell "none" from "already fired".
        const opts: SandboxExecOptions = { cwd: DEVBOX_WORKDIR, ...(Object.keys(env).length > 0 && { env }) };

        if (signal !== undefined) opts.signal = signal;

        if (output !== undefined) opts.output = call.output(output);

        return handle.exec(call.command, opts);
      });

      // The container's answer, as every transport settles a command.
      const outcome: ExecOutcome = { ...call.settle(res) };

      return commandAnswer(outcome, v.is(ExecPartsSchema, args[1]), reportCwd, { machine: 'computer', command });
    }, refusalOf), (message) => refusalOf(new KinuError('unavailable', message)))), (cause) => {
      const err = Cause.squash(cause);
      const own = classifyErrorCode({ cause: err }) === 'cancelled';

      // The caller's cancel wins over what the call it cut short answered.
      if (own) return Effect.failCause(cause);

      if (signal?.aborted === true) return Effect.die(cancelledWhileRunning(command));

      return Effect.succeed(refusalOf(sandboxFailure({ doing: `computer.exec \`${command}\``, cause: err })));
    }) };
  };
}

const START_PROCESS_DESCRIPTION = 'Start a SUPERVISED background process in the computer. Supervision records a restart '
  + 'spec, so the process COMES BACK when the container restarts; a bare `nohup ... &` does '
  + 'not and is lost. Answers {processId}. Prefer this over `exec "cmd &"` for any '
  + 'long-running server.';

/** A command member's reading, its run an Effect the exported factory runs once (its bridge). */
type EffectPrepared = { readonly call: CommandCall; readonly run: (shellState?: string) => Effect.Effect<ExecutorToolResult> } | { readonly refused: ExecutorToolResult };

/**
 * `computer.startProcess`. With the actor's jobs, the process is one of them from its start (as the workspace's is):
 * its end, which the box tells, completes the job and wakes the agent; one no job took is stopped.
 */
function startProcessMember({ handle, touch, environment, processJobs }: Computer): (args: readonly unknown[]) => EffectPrepared {
  return (args) => {
    if (!handle) return { refused: notConfigured() };
    const command = parseInput(StringSchema, { value: args[0] });

    if (command === undefined) return { refused: refusalOf(new KinuError('bad_input', 'computer.startProcess: command must be a string')) };

    const rawOpts = parseInput(
      v.union([v.string(), v.object({ cwd: v.optional(v.string()) })]),
      { value: args[1] },
    );

    const cwd = parseInput(
      OptionalStringSchema,
      { value: v.is(v.string(), rawOpts) ? rawOpts : rawOpts?.cwd },
    ) ?? DEVBOX_WORKDIR;

    return { call: { text: command, cwd, context: {} }, run: () => refusedAs(Effect.gen(function* () {
      // Readiness is retried; the start is not: a retry after a partial start would spawn a second process.
      const caller = secretsCaller();
      const env = environment === undefined ? undefined : yield* Effect.promise(async () => environment('keep', caller));

      // Its job's id before it starts: its spec names it, and its variables carry it, as a job's commands do.
      const jobId = processJobs === undefined ? undefined : newJobId();
      const stamped = jobId === undefined ? env : { ...env, [JOB_STAMP_ENV]: jobId };

      yield* retried(() => touch(() => handle.ensureReady()));

      const started = yield* Effect.promise(async () => touch(() => handle.startSupervisedProcess(command, {
        cwd, ...(stamped !== undefined && { env: stamped }), ...(env !== undefined && { reveal: caller === 'owner' }), ...(jobId !== undefined && { job: jobId }),
      })));

      if (processJobs === undefined || jobId === undefined) return { processId: started.processId };

      // The process is its job's, made once, by whichever start's reply comes first: a later one answers it. One whose
      // start lost its reply before its job was made is made now, under the id its process carries. Nothing awaits
      // between the look and the making.
      const job = started.job ?? jobId;

      if (processJobs.state(job) !== 'missing') return { processId: started.processId, jobId: job };

      return yield* Effect.promise(async () => adoptedProcess({ handle, touch, jobs: processJobs, jobId: job, command, cwd, processId: started.processId }));
    }), `computer.startProcess \`${command}\``, (answer: JsonValue) => answer) };
  };
}

/**
 * A started process made its job's: taken, it answers its job; refused, it is stopped, and the call says it ran and was
 * stopped (`cancelled` spends an approval, as the workspace's does). Its job's cancel reaches it through the actor's
 * own cancel path, which a stop that fails leaves running.
 */
async function adoptedProcess(input: {
  readonly handle: SandboxHandle; readonly touch: Computer['touch']; readonly jobs: ComputerProcessJobs;
  readonly jobId: string; readonly command: string; readonly cwd: string; readonly processId: string;
}): Promise<JsonValue> {
  const { handle, touch, jobs, jobId, command, cwd, processId } = input;
  const doing = `computer.startProcess \`${command}\``;

  const adopted = await jobs.adopt({
    jobId, kind: 'startProcess', mode: currentWorkMode(), controller: new AbortController(),
    promise: jobs.ended(jobId).then((end) => ({ processId, ...end })),
    input: { command, cwd, processId, machine: 'computer', job: jobId },
  });

  if (adopted.detached) return { processId, jobId: adopted.jobId };
  await touch(() => handle.stopSupervisedProcess(processId));

  return refusalOf(new KinuError('cancelled', `${doing}: ${adopted.reason}, so the process was stopped`));
}

/** A member whose call is an Effect, run once by the exported factory that serves it (its bridge). */
interface EffectMember {
  readonly description: string;
  readonly planAllowed?: boolean;
  readonly execute: (...args: unknown[]) => Effect.Effect<ExecutorToolResult>;
}

/** `computer.stopProcess`. */
function stopProcessMember({ handle, touch }: Computer): EffectMember {
  return {
    description: 'Stop a supervised process by id and clear its restart spec.',
    execute: (...args: unknown[]) => {
      if (!handle) return Effect.succeed(notConfigured());
      const processId = parseInput(StringSchema, { value: args[0] });

      if (processId === undefined) {
        return Effect.succeed(refusalOf(new KinuError('bad_input', 'computer.stopProcess: processId must be a string')));
      }

      return refusedAs(retried(() => touch(() => handle.stopSupervisedProcess(processId))), `computer.stopProcess ${processId}`, (result) => ({ stopped: result.stopped }));
    },
  };
}

const LogLimitsSchema = v.optional(v.object({ lines: v.optional(v.number()), bytes: v.optional(v.number()) }), {});

/** `computer.logs`: a supervised job's one log (D95). */
function logsMember({ handle, touch }: Computer): EffectMember {
  return {
    description: 'What a supervised process wrote most recently.',
    planAllowed: true,
    execute: (...args: unknown[]) => {
      if (!handle) return Effect.succeed(notConfigured());
      const processId = parseInput(StringSchema, { value: args[0] });
      const limits = parseInput(LogLimitsSchema, { value: args[1] });

      if (processId === undefined || limits === undefined) {
        return Effect.succeed(refusalOf(new KinuError('bad_input', 'computer.logs: takes a process id and its limits as one object, `{ lines?, bytes? }`')));
      }

      return refusedAs(retried(() => touch(() => handle.supervisedProcessLogs(processId, limits))), `computer.logs ${processId}`, (logs) => logs);
    },
  };
}

/** `computer.listProcesses`. */
function listProcessesMember({ handle, touch }: Computer): EffectMember {
  return {
    description:
      'List sandbox processes as JSON rows {processId,pid,status,restartable,command,session?,waiting?}. ' +
      '`restartable:true` rows come back after a container restart. Each one runs in a terminal `session` the person ' +
      'can open and type into. Status "waiting for input" means it stopped at a prompt; `waiting` is its last line. ' +
      'Ask the person, or answer it yourself when the answer is yours to give, with exec: ' +
      '`tmux send-keys -t \'=<session>:\' \'<answer>\' Enter`.',
    execute: () => {
      if (!handle) return Effect.succeed(notConfigured());

      return refusedAs(retried(() => touch(async () => {
        await handle.ensureReady();

        return handle.listSupervisedProcesses();
      })), 'computer.listProcesses', (rows) => rows.map((row) => projectJsonValue({ value: row })));
    },
  };
}

/** A saved command's run keeps its caller through approval, as an immediate member's execute does. */
function ownerComputerTool(member: ExecutorTool): ExecutorTool {
  const forOwner = async (run: () => Promise<ExecutorToolResult>): Promise<ExecutorToolResult> => (secretsCaller() === 'viewer'
    ? refusalOf(new KinuError('denied', COMPUTER_OWNER_ONLY))
    : run());

  const prepare = member.prepare;

  const guarded = prepare === undefined ? member : commandTool(member.description, (args) => {
    if (secretsCaller() === 'viewer') return { refused: refusalOf(new KinuError('denied', COMPUTER_OWNER_ONLY)) };
    const prepared = prepare(args);

    return 'refused' in prepared ? prepared : { call: prepared.call, run: (state) => forOwner(() => prepared.run(state)) };
  }, member);

  return { ...guarded, execute: (...args) => forOwner(() => guarded.execute(...args)) };
}

/** Pass no handle for a "not configured" stub. */
export function createSandboxExecutor(handle?: SandboxHandle, options: SandboxExecutorOptions = {}): ExecutorProvider {
  const { previewHostSuffix, activated, sizes, shells, desktop } = options;
  // One call at a time per name, and a name a detached job holds answers at once.
  const names = createShellSession({ home: DEVBOX_WORKDIR, userRoots: () => [] });
  const connected = handle != null;
  const previews = previewHostSuffix !== undefined && previewHostSuffix.length > 0;
  // In use once a call through it answered: a box that never came up (a server that runs no containers, a start that
  // failed), or whose first call is still out, is not one an agent works in, so nothing reads it as one (AGENTS.md
  // discovery reads an active box's file at each turn's open).
  let active = false;

  const touch = async <T>(fn: () => Promise<T>): Promise<T> => {
    const answer = await ownerComputerCall(fn);

    if (!active) {
      active = true;
      activated?.();
    }

    return answer;
  };

  /** One exposure path: Devbox owns listener proof; a failed probe is a real failure, never evidence of absence. */
  const exposeOn = (box: SandboxHandle, port: number, name?: string): Effect.Effect<PortExposureResult> => Effect.gen(function* () {
    const listening = yield* retried(() => touch(() => box.probePort(port)));

    if (!listening) {
      return {
        supported: false,
        reason: `nothing is listening on port ${port} inside the computer. `
          + `Start your server FIRST with a SUPERVISED process, then call computer.exposePort again. Examples:\n`
          + `  - Static site: await computer.startProcess("python3 -m http.server ${port} --directory /workspace/<app-dir>")\n`
          + `  - Node:        await computer.startProcess("node server.js", {cwd:"/workspace/<app-dir>"})\n`
          + `Supervision is what makes the process survive a container restart; a bare \`nohup ... &\` does not and will be lost.`,
      };
    }

    const { urlToken } = yield* Effect.promise(async () => box.portToken(port, name));
    const opts: SandboxExposeOptions = { token: urlToken };

    if (name !== undefined) opts.name = name;
    const exposed = yield* retried(() => touch(() => box.exposePort(port, opts)));

    return { supported: true, url: exposed.url, port, name, route: exposed.route };
  });

  const computer: Computer = { handle, names, shells, touch, environment: options.environment, processJobs: options.processJobs };

  const exec = execMember(computer);
  const startProcess = startProcessMember(computer);
  const stopProcess = stopProcessMember(computer);
  const listProcesses = listProcessesMember(computer);
  const logs = logsMember(computer);

  const tools: ExecutorProvider['tools'] = {
    exec: commandTool(EXEC_DESCRIPTION, (args) => {
      const prepared = exec(args);

      return 'refused' in prepared ? prepared : { call: prepared.call, run: (pinned) => settle(prepared.run(pinned)) };
    }),
    startProcess: commandTool(START_PROCESS_DESCRIPTION, (args) => {
      const prepared = startProcess(args);

      return 'refused' in prepared ? prepared : { call: prepared.call, run: () => settle(prepared.run()) };
    }),
    stopProcess: { ...stopProcess, execute: (...args) => settle(stopProcess.execute(...args)) },
    // Inline, as resize is: the effect its answer runs is run at this exported factory, its bridge.
    rest: {
      description:
        'Answer the computer\'s rest ask. When it has gone unused while processes still run in it, it asks you: ' +
        '"now" saves it and stops it, ending what runs (supervised servers restart cold on their next use); ' +
        '"keep" leaves it running until it asks again.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const answer = parseInput(v.picklist(['now', 'keep']), { value: args[0] });

        if (answer === undefined) return refusalOf(new KinuError('bad_input', 'computer.rest: the answer must be "now" or "keep"'));

        return settle(Effect.match(Effect.tryPromise({
          try: () => handle.answerRest(answer),
          catch: (cause) => sandboxFailure({ doing: `computer.rest ${answer}`, cause }),
        }), { onSuccess: restText, onFailure: refusalOf }));
      },
    },
    listProcesses: { ...listProcesses, execute: (...args) => settle(listProcesses.execute(...args)) },
    logs: { ...logs, execute: (...args) => settle(logs.execute(...args)) },
  };

  if (desktop !== undefined) {
    Object.assign(tools, desktopTools({
      // The signal is added only when given, as exec's is.
      box: handle && ((request, signal) => touch(() => handle.desktop(request, signal === undefined ? undefined : { signal }))),
      driver: desktop.driver, frames: desktop.screen.sheet.columns.length, notConfigured,
    }));
  }

  if (sizes !== undefined) {
    tools.resize = {
      description: 'Change the computer\'s size. A running computer at another size restarts: files stay, '
        + 'supervised servers and exposed ports come back, and a running command ends.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const size = parseInput(v.picklist(sizes.sizes.map((row) => row.size)), { value: args[0] });

        if (size === undefined) {
          return refusalOf(new KinuError('bad_input', `computer.resize: size must be one of ${sizes.sizes.map((row) => row.size).join(', ')}`));
        }

        // Retried: a resize repeated after a lost answer finds its size already applied.
        return settle(refusedAs(retried(() => touch(() => handle.resize(size))), `computer.resize ${size}`, (resized) => resizedText(resized, sizes)));
      },
    };
  }


  // Probed in the deployed image (docs/EXECUTION-LAYER-SPEC.md); these are routing instructions for the model,
  // so only list what runs. python and docker are absent (exit 127).
  const capabilities: ExecutorCapability[] = [
    'javascript', 'typescript', 'native_binary',
    'shell', 'npm', 'git', 'fs_owned',
    'net_outbound', ...(previews ? (['net_inbound'] as const) : []), 'process_spawn', 'process_long',
  ];

  return {
    name: 'computer',
    kind: 'computer',
    files: handle ? sandboxFiles(handle, (call) => settle(retried(() => touch(call)))) : undefined,
    homeDir: async () => DEVBOX_WORKDIR,
    fileRoot: () => ownerComputerCall(async () => ({ root: EXECUTOR_MOUNTS.computer, home: DEVBOX_WORKDIR })),
    capabilities: new Set(capabilities),
    filesOwner: 'agent',
    isAvailable: () => connected,
    getStatus: () => {
      const seen: ExecutorStatusBase = { configured: connected, available: connected, active };

      if (!connected) return { ...seen, status: 'not_configured', reason: NOT_CONFIGURED };

      if (sizes !== undefined) seen.sizes = sizes;

      if (desktop !== undefined) seen.screen = desktop.screen;

      if (!previews) return { ...seen, status: active ? 'active' : 'idle', reason: PREVIEWS_NOT_CONFIGURED };

      return { ...seen, status: active ? 'active' : 'idle' };
    },
    connect: async () => { /* sandbox starts on first RPC */ },
    disconnect: async () => { /* The sandbox DO persists, but its CONTAINER
      filesystem does NOT — the container sleeps after ~10m idle and /workspace
      is lost. Durability is the container DO's own affair: it snapshots
      /workspace to R2 periodically and restores in its container-start hook,
      before any executor can observe the container. Not this no-op close. */ },
    tools: Object.fromEntries(Object.entries(tools).map(([name, member]) => [name, ownerComputerTool(member)])),
    positionalArgs: true,

    async exposePort(port, opts) {
      return ownerComputerCall(async () => {
        if (!handle) return { supported: false, reason: NOT_CONFIGURED };

        if (!previewHostSuffix) return { supported: false, reason: PREVIEWS_NOT_CONFIGURED };

        if (!v.is(ExecutorPortSchema, port)) {
          return { supported: false, reason: `invalid port ${String(port)}` };
        }

        // A failure keeps its class: the caller is told what failed, never that the computer cannot serve ports.
        return settle(exposeOn(handle, port, opts?.name));
      });
    },

    async unexposePort(port) {
      return ownerComputerCall(async () => {
        if (!handle) return;

        if (!v.is(ExecutorPortSchema, port)) return settle(Effect.fail(new KinuError('bad_input', `invalid port ${String(port)}`)));

        // No catch: unexposing an unexposed port already succeeds; other errors must surface.
        return settle(Effect.asVoid(retried(() => touch(() => Promise.resolve(handle.unexposePort(Number(port)))))));
      });
    },

    async listExposedPorts() {
      return ownerComputerCall(async () => {
        if (!handle || !previewHostSuffix) return [];

        // A read of the box's record, which never starts it: no use of the box.
        return settle(Effect.map(retried(() => handle.getExposedPorts()), (ports) => (ports ?? []).map(p => ({
          port: p.port,
          url: p.url,
          name: p.name,
          status: 'unknown' as const,
        }))));
      });
    },
  };
}

/**
 * The computer's files over its handle, at absolute paths: the one path the agent's file tools reach them by, under
 * `/computer`. A directory is one batched read; a stat is one direct stat or lstat. `through` carries each call, so the
 * executor's retry of a dropped connection and its activity mark cover file calls as they cover commands.
 */
export function sandboxFiles(
  handle: SandboxHandle, through: <T>(call: () => Promise<T>) => Promise<T> = (call) => call(),
): VFS & Required<Pick<VFS, 'readRange'>> & Required<Pick<CheckpointFiles, 'writeFileIfDigest'>> {
  const statOf = (stat: SandboxFileMetadata): VfsStat => {
    let type: VfsStat['type'] = 'file';

    if (stat.type === 'directory') {
      type = 'directory';
    } else if (stat.type === 'symlink') {
      type = 'symlink';
    }

    return {
      type,
      size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, uid: stat.uid, gid: stat.gid,
      atimeMs: stat.atimeMs, ctimeMs: stat.ctimeMs,
    };
  };

  const errnoOf = (cause: Error): VfsErrorCode | null => {
    if (isVfsError(cause)) return null;

    if (cause instanceof KinuError && cause.code === 'denied') return 'EPERM';
    const visited = new Set<Error>();

    for (let current: unknown = cause; current instanceof Error && !visited.has(current); current = current.cause) {
      visited.add(current);
      const detail = v.safeParse(v.object({ kind: v.literal('devbox.file'), code: v.string() }), current.cause);

      if (!detail.success) continue;
      const { code } = detail.output;

      return isVfsErrorCode(code) ? code : 'EIO';
    }

    return null;
  };

  /** The digest writes this plane holds answers for: the guest keeps each answer until a later write names it here. */
  const settled: string[] = [];

  /** The call through the owner's computer access; a failure the guest names by its errno is that errno, any other
   *  failure is what it was. */
  const serving = <T>(path: string, syscall: string, op: () => Promise<T>): Effect.Effect<T, VfsError> => Effect.catchCause(
    Effect.promise(async () => ownerComputerCall(() => through(op))),
    (cause) => {
      const thrown = Cause.squash(cause);
      const code = thrown instanceof Error ? errnoOf(thrown) : null;

      return code === null ? Effect.failCause(cause) : Effect.fail(syscallError(code, syscall, path, { cause: thrown, ...(thrown instanceof KinuError && { detail: thrown.message }) }));
    },
  );

  const exited = (path: string, syscall: string, r: { readonly exitCode?: number | null; readonly stderr: string }): Effect.Effect<void, VfsError> => ((r.exitCode ?? 0) === 0
    ? Effect.void
    : Effect.fail(syscallError('EIO', syscall, path, { detail: r.stderr.trim() || undefined })));

  return {
    readFile(path) {
      return settle(Effect.flatMap(serving(path, 'open', () => handle.readFile(path, { encoding: 'base64' })), (result) => {
        if (result.exitCode != null && result.exitCode !== 0) {
          return Effect.fail(syscallError('ENOENT', 'open', path, { detail: `no such file or directory (exit ${result.exitCode})` }));
        }

        return Effect.succeed(result.encoding === 'base64' ? base64ToBytes(result.content ?? '') : new TextEncoder().encode(result.content ?? ''));
      }));
    },

    /** Bounded window via `dd` + base64; the SDK's `readFile` has no offset/length. Bounds validated before use. */
    readRange(path, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        return settle(Effect.fail(syscallError('EIO', 'read', path, { detail: 'range offset and length must be positive safe integers' })));
      }

      return settle(Effect.flatMap(serving(path, 'read', () => handle.exec(
        `set -o pipefail; dd if=${shellQuote(path)} bs=1 skip=${String(offset)} count=${String(length)} status=none | base64 -w 0`,
      )), (r) => Effect.as(exited(path, 'read', r), base64ToBytes(r.stdout))));
    },

    writeFileIfDigest(path, data, expected) {
      // One name for every send: a retry after a lost reply is answered what the guest did the first time.
      const operation = crypto.randomUUID();
      // Each earlier write this plane has an answer for, or gave up on: its answer goes with this send.
      const retiring = settled.splice(0);

      return settle(serving(path, 'open', () => handle.writeFileIfDigest({ path, contentBase64: bytesToBase64(data), expected, operation, settled: retiring })).pipe(
        Effect.onExit((exit) => Effect.sync(() => {
          // A send with no answer may not have reached the guest: the next one names those again.
          if (Exit.isFailure(exit)) settled.push(...retiring);
          settled.push(operation);
        })),
      ));
    },

    writeFile(path, data) {
      return settle(Effect.asVoid(serving(path, 'open', () => handle.writeFile(path, bytesToBase64(data), { encoding: 'base64' }))));
    },

    readdir(path) {
      return settle(Effect.map(serving(path, 'scandir', () => handle.listFiles(path, { recursive: false })), (result) => result.files.map(entry => ({
        name: entry.name, type: direntType(entry.type), stat: statOf(entry),
      }))));
    },

    stat(path, options) {
      return settle(Effect.map(
        tolerated(serving(path, options?.follow === false ? 'lstat' : 'stat', () => handle.statFile(path, options)), 'enoent'),
        (stat) => (stat === undefined ? null : statOf(stat)),
      ));
    },

    unlink(path) { return settle(Effect.asVoid(serving(path, 'unlink', () => handle.deleteFile(path)))); },

    mkdir(path, opts) {
      return settle(Effect.flatMap(serving(path, 'mkdir', () => handle.exec(`mkdir ${opts?.recursive ? '-p ' : ''}-- ${shellQuote(path)}`)), (r) => exited(path, 'mkdir', r)));
    },
  };
}
