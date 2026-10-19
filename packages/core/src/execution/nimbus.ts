import type { VFS, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
import { direntType } from '../vfs/dirent';
/** Nimbus executor adapter: maps a backend-supplied workspace box onto Kinu's ExecutorProvider contract. */

import * as v from 'valibot';
import { raceAbort } from '@kinu.run/agent-utils';
import type { OutputSink, Shell, ShellExecOptions, ShellExecResult } from '../types/primitives';
import { collectExecStream, type ExecChunk, type ExecOutput, type ExecStream } from '@nimbus-sh/core/runtime/exec-stream.js';
import type { VfsMount, WorkspacePrincipal } from '../vfs/mounts';
import type { CompositeVFS } from '@nimbus-sh/core/vfs/composite.js';
import { atVfsPath } from '../vfs/errno';
import { syscallError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { walkedPath, workspacePath } from '../vfs/workspace-path';
import { sessionRuntimeBins, workspaceCommandNotFound } from '../vfs/workspace-runtimes';
import { shellQuote } from '../utils/shell';
import { commandTool, type ExecutorCapability, type ExecutorProvider, type ExecutorStatus, type ExecutorTool, type PortExposureResult, type PreviewRouteCheck } from './types';
import { envContext } from './command-call';
import { sha256Hex } from '../safety/argument-digest';
import type { CommandCall } from '../safety/approval-gate';
import { commandResult, exposedPortText, type CommandResult } from './exec-result';
import { KinuError, refusalOf, renderThrownChain, toKinuError, type Refusal } from '../obs/index';
import { parseInput, type JsonValue } from '../utils/json';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SessionExecOptions, SessionPort, SessionRunCodeOptions, SessionStartResult } from '@nimbus-sh/core/runtime/session-protocol.js';
import type { NimbusSandboxFiles } from '@nimbus-sh/sdk/sandbox';

/**
 * A command's options: the shared session contract's, as far as Kinu sets them. `cred` is host-injected only
 * (the agent-facing option schemas omit it so an agent cannot choose uid 0); `shellId` names the transport's shell, which
 * a host keys per agent; `detach` frees that shell for its next call while the command runs on.
 */
type NimbusExecOptions = Pick<SessionExecOptions, 'cwd' | 'env' | 'timeoutMs' | 'stdin' | 'cred' | 'shellId' | 'execId' | 'detach'>;

type NimbusRunCodeOptions = NimbusExecOptions & Pick<SessionRunCodeOptions, 'language' | 'install'>;

export type NimbusExecResult = ExecOutput;

export type NimbusPortInfo = SessionPort;

/** `startProcess` result: the process is still running, so no exit code or output; read `logs`, stop via `stopProcess`. */
export type NimbusStartResult = SessionStartResult;

/** A remote session's file plane as Kinu reads it: the SDK's `NimbusSandbox.files`. `as(cred)` binds it to one identity. */
export type { NimbusSandboxFiles };

export interface NimbusSandboxHandle {
  ready(): Promise<void>;
  exec(command: string, options?: NimbusExecOptions): Promise<NimbusExecResult>;
  /** A named shell's directory as its last call left it; null before its first call. */
  shellCwd?(shellId: string): Promise<string | null>;
  execStream?: (command: string, options?: NimbusExecOptions) => Promise<ExecStream>;
  startProcess?: (command: string, options?: NimbusExecOptions) => Promise<NimbusStartResult>;
  runCode?: (code: string, options?: NimbusRunCodeOptions) => Promise<NimbusExecResult>;
  runtimes?: {
    ensure?(specs: string | string[], options?: { force?: boolean }): Promise<JsonValue | undefined>;
    install?(spec: string, options?: { force?: boolean }): Promise<JsonValue | undefined>;
    list?(): Promise<JsonValue | undefined>;
  };
  processes?: {
    list?(): Promise<JsonValue | undefined>;
    kill?(pid: number): Promise<JsonValue | undefined>;
    logs?(pid: number, options?: { lines?: number; bytes?: number }): Promise<JsonValue | undefined>;
  };
  ports?: {
    expose?(port: number): Promise<{ port: number; url?: string; route: PreviewRouteCheck; pid?: number | null; capability?: string | null }>;
    unexpose?(port: number): Promise<JsonValue | undefined>;
    /** Why an exposed port has no `url`, when known; absent when there is a URL. */
    list?(): Promise<Array<{ port: number; url?: string; unavailable?: string; pid?: number; registeredAt?: number; capability?: string }>>;
    url?(port: number): string | undefined;
  };
  /** See `WorkspaceBundle.mountTable`; absent on a remote box. */
  mountTable?(mounts: readonly VfsMount[], principal?: WorkspacePrincipal): () => void;
  namespace?(principal?: WorkspacePrincipal): Promise<CompositeVFS>;
}

export interface NimbusSessionOpts {
  box: NimbusSandboxHandle;
  /** Whether session ports can be published as preview URLs; false when the backend's preview origin is unconfigured. */
  inboundNetwork?: boolean;
  /** Whether interpreter runtimes (python, ruby, clang) can be installed; gates declaring `python`/`native_binary`. */
  runtimeCatalog?: boolean;
}

/** Live session, but the SDK handle lacks this surface: `unsupported`, since retrying cannot add a method (obs/error.ts). */
function handleLacks(surface: string): Refusal {
  return refusalOf(new KinuError('unsupported', `Nimbus SDK handle does not expose ${surface}`));
}

const NO_LISTENER_MARK = 'nothing is serving port';

function workspaceNoListenerReason(port: number): string {
  return `workspace port ${port} has no server listening. Start the server with startProcess, then expose the port `
    + `once it listens. For an authored Worker slate, use its declared preview operation when available.`;
}

/** Session RPC failures default to `io`; abort, timeout and memory-wall keep the classifier's precise code. */
function nimbusFailure(input: { doing: string; cause: unknown }): KinuError {
  return toKinuError({ ...input, otherwise: 'io' });
}

const StringSchema = v.string();

/** The agent-facing option schema omits `cred`, so an invented one is stripped. Adding it would let agents choose their uid. */
const NimbusRunCodeOptionsSchema: v.GenericSchema<NimbusRunCodeOptions> = v.object({
  cwd: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  timeoutMs: v.optional(v.number()),
  stdin: v.optional(v.string()),
  language: v.optional(v.picklist(['javascript', 'typescript', 'python', 'ruby', 'shell'])),
  install: v.optional(v.picklist(['never', 'ifMissing'])),
});

/** What a Nimbus call runs, from the options its schema kept: `runCode` runs a program unless its language is the
 *  shell. Nimbus starts one without a directory in the home, and takes no named shell from an agent. */
function nimbusCall(member: 'runCode' | 'startProcess', text: string, options: NimbusRunCodeOptions | undefined): CommandCall {
  const language = options?.language;

  return {
    text,
    ...(member === 'runCode' && language !== 'shell' && { program: language ?? 'default' }),
    ...(options?.cwd !== undefined && { cwd: options.cwd }),
    context: {
      ...envContext(options?.env),
      ...(options?.stdin !== undefined && { stdinSha256: sha256Hex(options.stdin) }),
      ...(member === 'runCode' && { language: language ?? 'default' }),
      ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      ...(options?.install !== undefined && { install: options.install }),
    },
  };
}

const PortInputSchema = v.union([v.number(), v.object({ port: v.number() })]);

const LogLimitsSchema = v.optional(v.object({ lines: v.optional(v.number()), bytes: v.optional(v.number()) }), {});

function stringifyResult(input: { value: unknown }): string {
  const text = v.safeParse(v.string(), input.value);

  if (text.success) return text.output;

  if (input.value == null) return '';

  try { return JSON.stringify(input.value, null, 2); } catch (error) { return `unserializable process result: ${renderThrownChain({ cause: error })}`; }
}

/** What every member of the live session works over: its box, the one way a call through it marks the session in use
 *  and records its failure, and the exposure every port path shares. */
interface NimbusReach {
  readonly box: NimbusSandboxHandle;
  readonly touch: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly exposeOn: (port: number) => Promise<PortExposureResult>;
}

/** `workspace.runCode`. */
function runCodeMember({ box, touch }: NimbusReach): ExecutorTool {
  return commandTool('Run code in Nimbus using the requested language runtime.', (args) => {
    const runCode = box.runCode;

    if (!runCode) return { refused: handleLacks('runCode') };
    const code = parseInput(StringSchema, { value: args[0] });

    if (code === undefined) return { refused: refusalOf(new KinuError('bad_input', 'nimbus runCode: code must be a string')) };
    const options = parseInput(NimbusRunCodeOptionsSchema, { value: args[1] });

    return {
      call: nimbusCall('runCode', code, options),
      run: async (): Promise<CommandResult> => {
        try {
          return commandResult(await touch(() => runCode(code, options)));
        } catch (err) {
          return refusalOf(nimbusFailure({ doing: 'nimbus runCode', cause: err }));
        }
      },
    };
  });
}

/** A process id as `startProcess` answers it: the Nimbus pid, as text. */
const ProcessIdSchema = v.pipe(v.string(), v.regex(/^\d+$/u, 'a process id `startProcess` answered'), v.transform(Number));

const StartOptionsSchema = v.optional(v.object({ cwd: v.optional(v.string()) }), {});

/** One row of the hosted runtime's process table, as far as a listing reads it. */
const ProcessRowSchema = v.object({ pid: v.number(), command: v.string(), state: v.string(), longRunning: v.boolean() });

const KilledSchema = v.object({ ok: v.boolean() });

const LoggedSchema = v.object({ text: v.string() });

/** `workspace.startProcess`. */
function startProcessMember({ box, touch }: NimbusReach): ExecutorTool {
  return commandTool('Start a background process in Nimbus; returns while it is still running.', (args) => {
    const startProcess = box.startProcess;

    if (!startProcess) return { refused: handleLacks('startProcess') };
    const command = parseInput(StringSchema, { value: args[0] });

    if (command === undefined) return { refused: refusalOf(new KinuError('bad_input', 'nimbus startProcess: command must be a string')) };
    const options = parseInput(StartOptionsSchema, { value: args[1] });

    if (options === undefined) return { refused: refusalOf(new KinuError('bad_input', 'nimbus startProcess: its options are `{ cwd? }`')) };

    return {
      call: nimbusCall('startProcess', command, options),
      run: async () => {
        try {
          return { processId: String((await touch(() => startProcess(command, options))).pid) };
        } catch (err) {
          return refusalOf(nimbusFailure({ doing: `nimbus startProcess \`${command}\``, cause: err }));
        }
      },
    };
  });
}

/** `workspace.stopProcess`. */
function stopProcessMember({ box, touch }: NimbusReach): ExecutorTool {
  return {
    description: 'Stop a Nimbus process by the id startProcess answered.',
    execute: async (...args: unknown[]) => {
      const processes = box.processes;

      if (!processes?.kill) return handleLacks('process control');
      // Bound at the guard: TypeScript drops narrowing inside closures, and binding keeps `this`.
      const kill = processes.kill.bind(processes);
      const pid = parseInput(ProcessIdSchema, { value: args[0] });

      if (pid === undefined) return refusalOf(new KinuError('bad_input', `nimbus stopProcess: no process id ${stringifyResult({ value: args[0] })}`));

      try {
        return { stopped: v.parse(KilledSchema, await touch(() => kill(pid))).ok };
      } catch (err) {
        return refusalOf(nimbusFailure({ doing: `nimbus stopProcess ${String(pid)}`, cause: err }));
      }
    },
  };
}

/** `workspace.listProcesses`: the long-running processes, as every machine lists its own. */
function listProcessesMember({ box, touch }: NimbusReach): ExecutorTool {
  return {
    description: 'List the long-running Nimbus processes.',
    planAllowed: true,
    execute: async () => {
      const processes = box.processes;

      if (!processes?.list) return handleLacks('process listing');
      const list = processes.list.bind(processes);

      try {
        const rows = v.parse(v.array(ProcessRowSchema), await touch(() => list()));

        return rows.filter((row) => row.longRunning).map((row) => ({ processId: String(row.pid), pid: row.pid, status: row.state, command: row.command }));
      } catch (err) {
        return refusalOf(nimbusFailure({ doing: 'nimbus listProcesses', cause: err }));
      }
    },
  };
}

/** `workspace.logs`. */
function logsMember({ box, touch }: NimbusReach): ExecutorTool {
  return {
    description: 'Read Nimbus process logs.',
    planAllowed: true,
    execute: async (...args: unknown[]) => {
      const processes = box.processes;

      if (!processes?.logs) return handleLacks('process logs');
      const readLogs = processes.logs.bind(processes);
      const pid = parseInput(ProcessIdSchema, { value: args[0] });
      const limits = parseInput(LogLimitsSchema, { value: args[1] });

      if (pid === undefined || limits === undefined) {
        return refusalOf(new KinuError('bad_input',
          `nimbus logs: takes a process id and its limits as one object, \`{ lines?, bytes? }\`; got ${stringifyResult({ value: args })}`));
      }

      try {
        return v.parse(LoggedSchema, await touch(() => readLogs(pid, limits))).text;
      } catch (err) {
        return refusalOf(nimbusFailure({ doing: `nimbus logs ${String(pid)}`, cause: err }));
      }
    },
  };
}

/** `workspace.exposePort`. */
function exposePortMember({ box, exposeOn }: NimbusReach): ExecutorTool {
  return {
    description: 'Expose a listening Nimbus port. Returns the preview URL, then one line: "verified" when a '
      + 'request to the URL reaches the server, or "not reached" naming the preview-route gate that refused. '
      + 'The check never calls your server.',
    execute: async (...args: unknown[]): Promise<string | Refusal> => {
      if (!box.ports?.expose) return handleLacks('ports');
      const input = parseInput(PortInputSchema, { value: args[0] });
      const port = v.is(v.number(), input) ? input : input?.port;

      if (port === undefined || !Number.isFinite(port) || port <= 0 || port > 65535) {
        return refusalOf(new KinuError('bad_input',
          `nimbus exposePort: invalid port ${stringifyResult({ value: args[0] })}`));
      }

      try {
        const exposed = await exposeOn(port);

        return exposed.supported
          ? exposedPortText(exposed.url, port, exposed.route)
          : refusalOf(new KinuError('unsupported', exposed.reason));
      } catch (err) {
        return refusalOf(nimbusFailure({ doing: `nimbus exposePort ${port}`, cause: err }));
      }
    },
  };
}

/** `workspace.unexposePort`. */
function unexposePortMember({ box, touch }: NimbusReach): ExecutorTool {
  return {
    description: 'Stop exposing a Nimbus port.',
    execute: async (...args: unknown[]): Promise<string | Refusal> => {
      const ports = box.ports;

      if (!ports?.unexpose) return handleLacks('ports');
      const unexpose = ports.unexpose.bind(ports);
      const input = parseInput(PortInputSchema, { value: args[0] });
      const port = v.is(v.number(), input) ? input : input?.port;

      if (port === undefined || !Number.isFinite(port)) {
        return refusalOf(new KinuError('bad_input',
          `nimbus unexposePort: invalid port ${stringifyResult({ value: args[0] })}`));
      }

      try {
        await touch(() => unexpose(port));

        return `unexposed ${port}`;
      } catch (err) {
        return refusalOf(nimbusFailure({ doing: `nimbus unexposePort ${port}`, cause: err }));
      }
    },
  };
}

/** `workspace.listPorts`. */
function listPortsMember({ box, touch }: NimbusReach): ExecutorTool {
  return {
    description: 'List Nimbus exposed ports.',
    execute: async (): Promise<string | Refusal> => {
      // No port API is not the same fact as no exposed ports (AGENTS.md).
      const ports = box.ports;

      if (!ports?.list) return handleLacks('ports');
      const list = ports.list.bind(ports);

      try {
        const exposed = await touch(() => list());

        return JSON.stringify(exposed.map((p) => ({ ...p, url: p.url ?? ports.url?.(p.port) })));
      } catch (err) {
        return refusalOf(nimbusFailure({ doing: 'nimbus listPorts', cause: err }));
      }
    },
  };
}

/** `workspace.installRuntime`. */
function installRuntimeMember({ box, touch }: NimbusReach): ExecutorTool {
  return {
    description: 'Install or ensure a Nimbus runtime such as python, bun, or clang.',
    execute: async (...args: unknown[]): Promise<string | Refusal> => {
      const spec = parseInput(StringSchema, { value: args[0] });

      if (spec === undefined) {
        return refusalOf(new KinuError('bad_input', 'nimbus installRuntime: spec must be a string'));
      }

      const runtimes = box.runtimes;
      const install = runtimes?.install?.bind(runtimes);
      const ensure = runtimes?.ensure?.bind(runtimes);

      try {
        if (install) await touch(() => install(spec));
        else if (ensure) await touch(() => ensure(spec));
        else return handleLacks('runtime installation');

        return `installed ${spec}`;
      } catch (err) {
        return refusalOf(nimbusFailure({ doing: `nimbus installRuntime ${spec}`, cause: err }));
      }
    },
  };
}

/** `workspace.listRuntimes`. */
function listRuntimesMember({ box, touch }: NimbusReach): ExecutorTool {
  return {
    description: 'List Nimbus runtimes.',
    execute: async (): Promise<string | Refusal> => {
      const runtimes = box.runtimes;

      if (!runtimes?.list) return handleLacks('runtime listing');
      const list = runtimes.list.bind(runtimes);

      try {
        return stringifyResult({ value: await touch(() => list()) });
      } catch (err) {
        return refusalOf(nimbusFailure({ doing: 'nimbus listRuntimes', cause: err }));
      }
    },
  };
}

/** The live Nimbus session's process, port and runtime members, declared inside the workspace namespace, and the
 *  lifecycle the workspace executor reports. */
export function nimbusSession(opts: NimbusSessionOpts) {
  const box = opts.box;
  let active = false;
  let lastError: string | undefined;

  const touch = async <T>(fn: () => Promise<T>): Promise<T> => {
    active = true;

    try {
      const result = await fn();
      lastError = undefined;

      return result;
    } catch (err) {
      lastError = renderThrownChain({ cause: err });
      throw err;
    }
  };

  const exposeOn = async (port: number): Promise<PortExposureResult> => {
    const ports = box.ports;

    if (!ports?.expose) return { supported: false, reason: 'Nimbus port exposure is not available' };
    const expose = ports.expose.bind(ports);

    try {
      const result = await touch(() => expose(port));
      // A blank url is the SDK declining to name one, same as omitting it.
      const url = result.url === undefined || result.url === '' ? ports.url?.(port) : result.url;

      if (!url) return { supported: false, reason: `nimbus exposePort ${port}: exposed but no preview URL is available` };

      return { supported: true, port, url, route: result.route };
    } catch (err) {
      if (renderThrownChain({ cause: err }).includes(NO_LISTENER_MARK)) {
        return { supported: false, reason: workspaceNoListenerReason(port) };
      }

      throw err;
    }
  };

  const nimbus: NimbusReach = { box, touch, exposeOn };

  const tools: ExecutorProvider['tools'] = {
    runCode: runCodeMember(nimbus),
    startProcess: startProcessMember(nimbus),
    stopProcess: stopProcessMember(nimbus),
    listProcesses: listProcessesMember(nimbus),
    logs: logsMember(nimbus),
    exposePort: exposePortMember(nimbus),
    unexposePort: unexposePortMember(nimbus),
    listPorts: listPortsMember(nimbus),
    installRuntime: installRuntimeMember(nimbus),
    listRuntimes: listRuntimesMember(nimbus),
  };

  // JS/TS, shell, coreutils, `node`, `npm`/`npx`, and `git` need no install. `python`/`native_binary` install from the
  // runtime catalog (`runtimeCatalog`).
  const capabilities: ExecutorCapability[] = [
    'javascript', 'typescript', 'shell', 'npm', 'git', 'net_outbound',
    ...(box.ports?.expose && opts.inboundNetwork !== false ? (['net_inbound'] as const) : []),
    'process_spawn', 'process_long', 'process_signal',
    ...(opts.runtimeCatalog ? (['python', 'native_binary'] as const) : []),
  ];

  return {
    tools,
    capabilities,
    // A recorded failure outranks activity.
    getStatus: (): ExecutorStatus => (lastError === undefined
      ? { configured: true, available: true, active, status: active ? 'active' : 'idle' }
      : { configured: true, available: true, active, status: 'error', reason: lastError }),
    connect: async () => { await touch(() => box.ready()); },
    disconnect: async () => { active = false; },
    exposePort: exposeOn,
    unexposePort: async (port: number) => {
      const ports = box.ports;

      if (!ports?.unexpose) return;
      const unexpose = ports.unexpose.bind(ports);
      await touch(() => unexpose(port));
    },
    // Exposed ports without a URL are kept, carrying the host's reason as a refusal.
    listExposedPorts: async () => {
      const ports = box.ports;

      if (!ports?.list) return [];
      const list = ports.list.bind(ports);
      const exposed = await touch(() => list());
      const unaddressed = exposed.find((p) => p.url === undefined && p.unavailable !== undefined);

      if (unaddressed?.unavailable !== undefined) {
        throw new KinuError('unsupported',
          `workspace port ${unaddressed.port} is listening and has no preview URL: ${unaddressed.unavailable}`);
      }

      return exposed.map((p) => ({
        port: p.port,
        url: p.url ?? ports.url?.(p.port) ?? '',
        status: 'unknown' as const,
      })).filter((p) => p.url);
    },
  };
}

/** Where a call starts: `cwd` under `base`, or `base`. */
function startIn(base: string, cwd: string | undefined): string {
  if (cwd === undefined) return base;

  return cwd.startsWith('/') ? cwd : workspacePath(cwd, base);
}

interface SessionCall {
  readonly run: string;
  readonly execOptions: NimbusExecOptions;
  readonly start: string;
}

/**
 * How one call runs on the box: an unnamed one at its start; a named one in Nimbus's named shell, behind a `cd` when
 * the call names a directory or the shell has none yet (a per-call directory would not outlast the call).
 */
async function sessionCall(
  command: string, options: ShellExecOptions, place: { readonly home: string; readonly cred?: VfsCred }, shellCwd: ((name: string) => Promise<string | null>) | undefined,
): Promise<SessionCall | KinuError> {
  const { home, cred } = place;
  const { name, stdin, job, detached } = options;
  const kept = name === undefined || shellCwd === undefined ? null : await keptDirectory(shellCwd, name);

  if (kept instanceof KinuError) return kept;
  const start = startIn(kept ?? home, options.cwd);
  // Absent option must be an absent key: the substrate reads `'cred' in options` to decide whether to inherit.
  const execOptions: NimbusExecOptions = name === undefined ? { cwd: start } : { shellId: name };
  const moves = name !== undefined && (kept === null || options.cwd !== undefined);

  if (stdin !== undefined) execOptions.stdin = stdin;

  if (cred !== undefined) execOptions.cred = cred;

  if (job !== undefined) execOptions.execId = job;

  // A job that outruns its window frees its shell for the next call; it runs on, and its later cd and exports are not kept.
  if (name !== undefined && detached !== undefined) execOptions.detach = detached;

  // Absolute, so no `--`, which Nimbus's `cd` reads as a directory.
  return { run: moves ? `cd ${shellQuote(start)} || exit\n${command}` : command, execOptions, start };
}

/** A named shell's directory, read before its call is sent; one that cannot be read is NOT RUN, since nothing was sent. */
async function keptDirectory(shellCwd: (name: string) => Promise<string | null>, name: string): Promise<string | null | KinuError> {
  const [read] = await Promise.allSettled([shellCwd(name)]);

  return read.status === 'fulfilled'
    ? read.value
    : new KinuError('unavailable', `NOT RUN: the directory of shell ${JSON.stringify(name)} could not be read, so the command was not sent.`, { cause: read.reason });
}

/**
 * A box that streams stops the command on a cancel; one that cannot only stops waiting for it. A Stop before the box is
 * ready sends nothing; one while the command starts waits for it to start, then cancels it and waits for its exit.
 */
function runOnBox(box: NimbusSandboxHandle, call: SessionCall, options: ShellExecOptions): Promise<NimbusExecResult> {
  const streamed = box.execStream;

  if (streamed === undefined) {
    return raceAbort(() => box.exec(call.run, call.execOptions), options.signal, 'workspace exec aborted: the command may still finish in the session');
  }

  const stopped = new AbortController();
  // Absent: not started. Pending: starting, which nothing cancels until the box answers. Fulfilled: running until its exit.
  let launch: Promise<ExecStream> | undefined;
  // Named before it is sent, so a Stop whose start answer is lost can still find the command by it.
  const execId = call.execOptions.execId ?? `exec-${crypto.randomUUID()}`;

  return raceAbort(async () => {
    await box.ready();
    options.signal?.throwIfAborted();
    launch = streamed(call.run, { ...call.execOptions, execId });

    return heard(await launch, options.output, stopped.signal);
  }, options.signal, 'workspace exec cancelled before it started', async () => {
    stopped.abort();

    if (launch === undefined) return null;
    const [launched] = await Promise.allSettled([launch]);

    // A start the box did not answer may still have run: it is stopped by its name, or the stop is not confirmed.
    if (launched.status === 'rejected') return await stopUnanswered(box, execId);
    await Promise.allSettled([launched.value.exit]);

    return 'workspace exec cancelled: the command was stopped';
  });
}

const RunningProcessesSchema = v.array(v.looseObject({ pid: v.number(), state: v.string(), execId: v.optional(v.string()) }));

/**
 * The processes of a command whose start the box never answered, found by the exec id it was sent with and killed;
 * how the stop ended. Without a process list the box cannot be asked, and a command no longer listed may have run.
 */
async function stopUnanswered(box: NimbusSandboxHandle, execId: string): Promise<string> {
  const list = box.processes?.list?.bind(box.processes);
  const kill = box.processes?.kill?.bind(box.processes);
  const unconfirmed = `workspace exec stop unconfirmed: the box lost its answer to the start of exec ${execId}`;

  if (list === undefined || kill === undefined) return `${unconfirmed}, and lists no processes to find it by`;
  const listed = v.safeParse(RunningProcessesSchema, await list());

  if (!listed.success) return `${unconfirmed}, and its process list was unreadable`;
  const running = listed.output.filter((process) => process.execId === execId && process.state === 'running');

  await Promise.all(running.map(async (process) => await kill(process.pid)));

  return running.length > 0 ? 'workspace exec cancelled: the command was stopped' : `${unconfirmed}, and it is not running now`;
}

/**
 * A Nimbus session's state, digested in the session: its directory as a digest, then what `set` lists, every variable
 * the session keeps, sorted by name, each value quoted, so no value or name can pass for another. An ill-formed one,
 * holding a lone UTF-16 surrogate, is listed as `$'…'` with each surrogate `\uXXXX` (Kinu's Nimbus patch, ask 52), so
 * the pipe's `TextEncoder` loses nothing. A subshell first sets the pid Nimbus gives each command (`$`) to 0, so the
 * listing holds only what the session keeps. Nimbus keeps no function, alias, option or array between a named shell's
 * calls, and answers `export -p` with nothing.
 */
const SESSION_STATE = `( pwd | sha256sum; export '$=0'; set ) | sha256sum`;

/**
 * Shell over the bytes nimbusSessionFiles exposes, its calls starting at `home`. `cred` is fixed at construction,
 * never per call (see {@link NimbusExecOptions.cred}); absent is the session user.
 */
export function nimbusSessionShell(box: NimbusSandboxHandle, place: { readonly home: string; readonly cred?: VfsCred }): Shell {
  const shellCwd = box.shellCwd?.bind(box);

  const shell: Shell = {
    async exec(command, stdinOrOptions) {
      const options: ShellExecOptions = v.is(v.string(), stdinOrOptions) ? { stdin: stdinOrOptions } : stdinOrOptions ?? {};
      const call = await sessionCall(command, options, place, shellCwd);

      if (call instanceof KinuError) return { stdout: '', stderr: call.message, exitCode: 1, refusal: refusalOf(call) };
      const result = await runOnBox(box, call, options);
      const outcome: ShellExecResult = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, cwd: call.start };
      const final = options.name === undefined ? null : await shellCwd?.(options.name) ?? null;

      if (final !== null) outcome.finalCwd = final;

      // 127 means the command is not in the box's catalog; the install remedy derives from the box's runtime list.
      const runtimes = box.runtimes?.list?.bind(box.runtimes);

      return workspaceCommandNotFound(outcome, async (bin) => {
        if (runtimes === undefined) return false;

        const catalog = await sessionRuntimeBins(runtimes);

        return 'unreadable' in catalog ? catalog : catalog.has(bin);
      });
    },
  };

  if (shellCwd !== undefined) {
    shell.cwd = shellCwd;

    // What the session restores, read inside it and digested there: its directory and variables.
    shell.state = async (name) => {
      if (await shellCwd(name) === null) return 'none';
      const state: NimbusExecOptions = { shellId: name };

      if (place.cred !== undefined) state.cred = place.cred;
      const read = await box.exec(SESSION_STATE, state);
      const digest = read.exitCode === 0 ? /^[0-9a-f]{64}/.exec(read.stdout)?.[0] : undefined;

      return digest ?? null;
    };
  }

  return shell;
}

/**
 * A command's stream read to its end; `stop` cancels the stream, which ends the command. Cancelled by its own reader: on
 * workerd a pipe's abort signal leaves a source whose read is pending uncancelled, so a silent command ran on after a
 * Stop (armada 20261011135731-48f44e7b: pipeThrough uncancelled at 5004 ms, reader.cancel at 1502 ms).
 */
async function heard(stream: ExecStream, output: OutputSink | undefined, stop: AbortSignal): Promise<NimbusExecResult> {
  const reader = stream.output.getReader();

  const stopped = new Promise<'stopped'>((resolve) => {
    if (stop.aborted) resolve('stopped');
    else stop.addEventListener('abort', () => { resolve('stopped'); }, { once: true });
  });

  const told = new ReadableStream<ExecChunk>({
    async pull(forward) {
      const next = await Promise.race([reader.read(), stopped]);

      if (next === 'stopped') {
        await reader.cancel(stop.reason);
        forward.close();

        return;
      }

      if (next.done) {
        forward.close();

        return;
      }

      output?.write(next.value.stream, next.value.data);
      forward.enqueue(next.value);
    },
  }, { highWaterMark: 0 });

  return collectExecStream({ output: told, exit: stream.exit });
}

/**
 * A remote Nimbus session's files in its own absolute paths, a relative one from `home`, each `..` the session's walk to
 * take. With `cred`, the plane is `files.as(cred)`. Absent is the origin.
 */
export function nimbusSessionFiles(
  session: NimbusSandboxFiles,
  plane: { readonly home: string; readonly cred?: VfsCred },
): VFS & Required<Pick<VFS, 'readlink' | 'removeRecursive' | 'rename' | 'readRange'>> {
  const { home, cred } = plane;
  const at = (path: string): string => walkedPath(path, home);
  const files = cred === undefined ? session : session.as(cred);

  const present = async <T>(path: string, syscall: string, read: (absolute: string) => Promise<T | null>): Promise<T> => {
    const absolute = at(path);
    const answer = await atVfsPath(absolute, syscall, () => read(absolute));

    if (answer === null) throw syscallError('ENOENT', syscall, absolute);

    return answer;
  };

  return {
    readFile: (path) => present(path, 'open', (absolute) => files.readBytes(absolute)),
    readRange: (path, offset, length) => present(path, 'read', (absolute) => files.readRange(absolute, offset, length)),
    async writeFile(path, data) {
      const absolute = at(path);

      await atVfsPath(absolute, 'open', () => files.write(absolute, data));
    },
    // Over the revision its stat gave, checked and written in one step at the session (Kinu's SDK patch, Nimbus ask 55).
    writeFileIfRevision: (path, data, expected) => {
      const absolute = at(path);

      return atVfsPath(absolute, 'open', () => files.writeIfRevision(absolute, data, Number(expected)));
    },
    async readdir(path) {
      const absolute = at(path);

      return (await atVfsPath(absolute, 'scandir', () => files.list(absolute))).map((entry) => ({ name: entry.name, type: direntType(entry.type) }));
    },
    readlink: (path) => present(path, 'readlink', (absolute) => files.readlink(absolute)),
    async stat(path, options) {
      const absolute = at(path);
      const stat = await atVfsPath(absolute, options?.follow === false ? 'lstat' : 'stat', () => (options?.follow === false ? files.lstat(absolute) : files.stat(absolute)));

      if (stat === null) return null;
      const type = stat.type === 'symlink' ? 'symlink' as const : 'file' as const;
      const answer: VfsStat = { size: stat.size, mtimeMs: stat.mtime, type: stat.type === 'directory' ? 'directory' : type };

      // The change time moves on every write and no caller sets it: what a note's stamp is told apart by, and the
      // revision, where the backend keeps one, before it.
      if (stat.ctime !== undefined) answer.ctimeMs = stat.ctime;

      if (stat.ino !== undefined) answer.ino = stat.ino;

      if (stat.revision !== undefined) answer.revision = stat.revision;

      return answer;
    },
    async unlink(path) { await files.delete(at(path)); },
    async removeRecursive(path) { await files.delete(at(path), { recursive: true }); },
    async rename(from, to) { await files.rename(at(from), at(to)); },
    async mkdir(path) { await files.mkdir(at(path)); },
  };
}
