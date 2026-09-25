/** Nimbus executor adapter: maps a backend-supplied workspace box onto Kinu's ExecutorProvider contract. */

import * as v from 'valibot';
import { raceAbort } from '@kinu.run/agent-utils';
import type { Shell, VFS } from '../types/primitives';
import type { MountedVfs, VfsNativeReads } from '../vfs/mounts';
import { atVfsPath, makeVfsError } from '../vfs/errno';
import { workspacePath } from '../vfs/workspace-path';
import { sessionRuntimeBins, workspaceCommandNotFound } from '../vfs/workspace-runtimes';
import { shellQuote } from '../utils/shell';
import { base64ToBytes } from '../utils/base64';
import type { ExecutorCapability, ExecutorProvider, ExecutorStatus, PortExposureResult, PreviewRouteCheck } from './types';
import { commandResult, exposedPortText, formatExecResult, type CommandResult } from './exec-result';
import { KinuError, refusalOf, renderThrownChain, toKinuError, type Refusal } from '../obs/index';
import type { JsonValue } from '../utils/json';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';

/** Shell-fallback constants: path and offsets travel as JSON in one env value, never quoted into shell text. */
const NIMBUS_RANGE_ENV = 'KINU_NIMBUS_RANGE_REQUEST';

const NIMBUS_RANGE_READER = `const fs=require('node:fs');const r=JSON.parse(process.env.${NIMBUS_RANGE_ENV});if(!Number.isSafeInteger(r.offset)||r.offset<0||!Number.isSafeInteger(r.length)||r.length<=0)throw new Error('invalid range');const fd=fs.openSync(r.path,'r');try{const b=Buffer.allocUnsafe(r.length);const n=fs.readSync(fd,b,0,r.length,r.offset);process.stdout.write(b.subarray(0,n).toString('base64'));}finally{fs.closeSync(fd);}`;

interface NimbusOriginRangeRead {
  readonly box: NimbusSandboxHandle;
  readonly files: NimbusSandboxFiles;
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly cred?: VfsCred;
}

/** One window of a file's bytes. Prefers the box's native ranged read; the `node -e` shell reader is a fallback
 *  only for handles lacking the op (Workers forbid `new Function`, so it would fail hosted). */
async function readNimbusOriginRange(read: NimbusOriginRangeRead): Promise<Uint8Array> {
  const { box, files, path, offset, length, cred } = read;

  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
    throw makeVfsError('EIO', 'range offset and length must be positive safe integers', path);
  }

  const absolute = workspacePath(path);
  const native = files.readRange;

  if (native) {
    const bytes = await native.call(files, absolute, offset, length);

    if (bytes === null) throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);

    return bytes;
  }

  const result = await box.exec(`node -e ${shellQuote(NIMBUS_RANGE_READER)}`, {
    env: { [NIMBUS_RANGE_ENV]: JSON.stringify({ path: absolute, offset, length }) },
    ...asCred(cred),
  });

  if (!result.success || result.exitCode !== 0) {
    throw makeVfsError(
      'EIO',
      `this file's bytes could not be read right now — try opening it again, or download it instead`,
      path,
    );
  }

  return base64ToBytes(result.stdout.trim());
}

export interface NimbusExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  /** Identity the command runs as; absent is the session user. Host-injected only: {@link NimbusExecOptionsSchema}
   *  omits it so an agent cannot choose uid 0. */
  cred?: VfsCred;
}

type NimbusRunCodeOptions = NimbusExecOptions & {
  language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
  install?: 'never' | 'ifMissing';
};

export interface NimbusExecResult {
  command: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration?: number;
  timestamp?: number;
}

export interface NimbusProcessInfo {
  pid: number;
  command: string;
  state: string;
  exitCode: number | null;
  longRunning: boolean;
}

export interface NimbusPortInfo {
  port: number;
  pid?: number;
  registeredAt?: number;
  capability?: string;
}

/** `startProcess` result (SDK ≥0.2.0): the process is still running, so no exit code or output; read `logs`, stop via `killProcess`. */
export interface NimbusStartResult {
  command: string;
  pid: number;
  process: NimbusProcessInfo;
  ports: NimbusPortInfo[];
  startedAt: number;
}

/** The handle's file plane. `as(cred)` binds it to one identity; when absent the credentialed plane refuses
 *  rather than acting as the session user. */
export interface NimbusSandboxFiles {
  as?(cred: VfsCred): NimbusSandboxFiles;
    read(path: string): Promise<string | null>;
    /** Raw-byte read (SDK ≥0.1.4). */
    readBytes?(path: string): Promise<Uint8Array | null>;
    /** Exactly this window of a file's bytes; absent on older SDK handles; null when the path is absent. */
    readRange?: (path: string, offset: number, length: number) => Promise<Uint8Array | null>;
    /** Whole-file write; no precondition, so no compare-and-write. */
    write(path: string, content: string | Uint8Array): Promise<void>;
    list(path?: string): Promise<Array<{ name: string; type?: string; isDir?: boolean; size?: number }>>;
    /** Native stat (SDK ≥0.2.0). `mtime` is in milliseconds; null when absent. No revision field. */
    stat?(path: string): Promise<{ type: string; size: number; mtime: number } | null>;
    lstat?(path: string): Promise<{ type: string; size: number; mtime: number; mode?: number } | null>;
    rename?(from: string, to: string): Promise<void>;
    chmod?(path: string, mode: number): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir?(path: string): Promise<void>;
    delete(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface NimbusSandboxHandle {
  ready(): Promise<void>;
  exec(command: string, options?: NimbusExecOptions): Promise<NimbusExecResult>;
  startProcess?: (command: string, options?: NimbusExecOptions) => Promise<NimbusStartResult>;
  runCode?: (code: string, options?: NimbusRunCodeOptions) => Promise<NimbusExecResult>;
  files: NimbusSandboxFiles;
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
  mountTable?(plane: MountedVfs, cred?: VfsCred): void;
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

/**
 * The workspace `node` shim compiles via `new Function` (forbidden hosted) and `vfs/workspace-runtimes.ts` loopback guard
 * refuses container-naming programs. The guard marker classifies any command; the V8 mark only a command invoking `node`.
 */
const CODEGEN_BLOCKED_MARK = 'Code generation from strings disallowed';

const WORKSPACE_NODE_UNAVAILABLE_MARK = 'cannot run JavaScript in this workspace';

const WORKSPACE_NODE_REFUSAL =
  `workspace node cannot run programs on this host: the runtime forbids code compilation from strings, so no node server starts here. `
  + `Run Node/Vite programs in an available capable executor, such as sandbox. `
  + `Worker slates compile separately: call workspace.slates.<id>.$preview(), without a node precheck.`;

function invokesWorkspaceNode(command: string): boolean {
  return /(^|[;&|(\s])node(\s|$)/m.test(command);
}


/** A thrown failure, classified the same way before it becomes `io`. */
function workspaceExecFailure(input: { doing: string; cause: unknown; command?: string }): KinuError {
  const text = renderThrownChain({ cause: input.cause });

  if (text.includes(WORKSPACE_NODE_UNAVAILABLE_MARK)) {
    return new KinuError('unsupported', WORKSPACE_NODE_REFUSAL);
  }

  if (
    (input.command === undefined || invokesWorkspaceNode(input.command))
    && text.includes(CODEGEN_BLOCKED_MARK)
  ) {
    return new KinuError('unsupported', WORKSPACE_NODE_REFUSAL);
  }

  return nimbusFailure({ doing: input.doing, cause: input.cause });
}

const NO_LISTENER_MARK = 'No process is listening';

function workspaceNoListenerReason(port: number): string {
  return `workspace port ${port} has no server listening. Start the server with startProcess, then expose the port `
    + `once it listens. For an authored Worker slate, use its declared preview operation when available.`;
}

/** Session RPC failures default to `io`; abort, timeout and memory-wall keep the classifier's precise code. */
function nimbusFailure(input: { doing: string; cause: unknown }): KinuError {
  return toKinuError({ ...input, otherwise: 'io' });
}

/** A transport failure is not evidence that a process exited with a made-up code. */
function nimbusTransportRefusal(result: NimbusExecResult): Refusal | null {
  return !result.success && result.exitCode === 0
    ? { reason: 'io', error: 'Nimbus execution did not report success: ' + formatExecResult(result) }
    : null;
}

function normalizeExec(result: NimbusExecResult): CommandResult {
  return nimbusTransportRefusal(result) ?? commandResult(result);
}

const StringSchema = v.string();

/** Agent-facing option schemas; both omit `cred` so an invented one is stripped. Adding it would let agents choose their uid. */
const NimbusExecOptionsSchema: v.GenericSchema<NimbusExecOptions> = v.object({
  cwd: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  timeoutMs: v.optional(v.number()),
  stdin: v.optional(v.string()),
});

const NimbusRunCodeOptionsSchema: v.GenericSchema<NimbusRunCodeOptions> = v.object({
  cwd: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  timeoutMs: v.optional(v.number()),
  stdin: v.optional(v.string()),
  language: v.optional(v.picklist(['javascript', 'typescript', 'python', 'ruby', 'shell'])),
  install: v.optional(v.picklist(['never', 'ifMissing'])),
});

const ProcessInputSchema = v.union([
  v.number(),
  v.object({ pid: v.number(), lines: v.optional(v.number()), bytes: v.optional(v.number()) }),
]);

const PortInputSchema = v.union([v.number(), v.object({ port: v.number() })]);

function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: { value: unknown },
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);

  return result.success ? result.output : undefined;
}


function stringifyResult(input: { value: unknown }): string {
  const text = v.safeParse(v.string(), input.value);

  if (text.success) return text.output;

  if (input.value == null) return '';

  try { return JSON.stringify(input.value, null, 2); } catch (error) { return `unserializable process result: ${renderThrownChain({ cause: error })}`; }
}

/** Render a startProcess result stating the process is still running and which calls observe or stop it. */
function formatStartResult(result: NimbusStartResult): CommandResult {
  const running = result.process.state === 'running';

  const lines = [
    running
      ? `started (long-running) pid=${result.pid}: ${result.command}`
      : `started pid=${result.pid}: ${result.command} — already ${result.process.state}` +
        (result.process.exitCode != null ? ` (exit ${result.process.exitCode})` : ''),
  ];

  if (result.ports.length > 0) {
    lines.push(`listening on port${result.ports.length > 1 ? 's' : ''} ${result.ports.map((p) => p.port).join(', ')} — workspace.exposePort(<port>) returns the preview URL and whether a request to it reaches the server`);
  }

  lines.push(`output: workspace.logs(${result.pid}) · stop: workspace.killProcess(${result.pid})`);

  return commandResult({ stdout: lines.join('\n'), exitCode: running ? 0 : result.process.exitCode ?? 0 });
}

/** The live session's members, declared inside the workspace namespace. */
const SESSION_TYPES = `
  function runCode(code: string, options?: { language?: 'javascript'|'typescript'|'python'|'ruby'|'shell'; install?: 'never'|'ifMissing' }): Promise<string | Refusal>;
  function startProcess(command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string,string> }): Promise<string | Refusal>;
  function killProcess(pid: number | { pid: number }): Promise<string | Refusal>;
  function logs(pid: number | { pid: number; lines?: number; bytes?: number }): Promise<string | Refusal>;
  function exposePort(port: number | { port: number }): Promise<string | Refusal>; // the URL, then 'verified: …' or 'not reached: …'
  function unexposePort(port: number | { port: number }): Promise<string | Refusal>;
  function listPorts(): Promise<string | Refusal>;
  function installRuntime(spec: string): Promise<string | Refusal>;
  function listRuntimes(): Promise<string | Refusal>;`;

/** The live Nimbus session's process, port and runtime members, and the lifecycle the workspace executor reports. */
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

  const tools: ExecutorProvider['tools'] = {
    runCode: {
      description: 'Run code in Nimbus using the requested language runtime.',
      execute: async (...args: unknown[]): Promise<CommandResult> => {
        const runCode = box.runCode;

        if (!runCode) return handleLacks('runCode');
        const code = parseInput(StringSchema, { value: args[0] });

        if (code === undefined) {
          return refusalOf(new KinuError('bad_input', 'nimbus runCode: code must be a string'));
        }

        const options = parseInput(NimbusRunCodeOptionsSchema, { value: args[1] });

        try {
          return normalizeExec(await touch(() => runCode(code, options)));
        } catch (err) {
          return refusalOf(workspaceExecFailure({ doing: 'nimbus runCode', cause: err }));
        }
      },
    },
    startProcess: {
      description: 'Start a background process in Nimbus; returns while it is still running.',
      execute: async (...args: unknown[]): Promise<CommandResult> => {
        const startProcess = box.startProcess;

        if (!startProcess) return handleLacks('startProcess');
        const command = parseInput(StringSchema, { value: args[0] });

        if (command === undefined) {
          return refusalOf(new KinuError('bad_input', 'nimbus startProcess: command must be a string'));
        }

        const options = parseInput(NimbusExecOptionsSchema, { value: args[1] });

        try {
          return formatStartResult(await touch(() => startProcess(command, options)));
        } catch (err) {
          return refusalOf(workspaceExecFailure({ doing: `nimbus startProcess \`${command}\``, cause: err, command }));
        }
      },
    },
    killProcess: {
      description: 'Kill a Nimbus process by pid.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        const processes = box.processes;

        if (!processes?.kill) return handleLacks('process control');
        // Bound at the guard: TypeScript drops narrowing inside closures, and binding keeps `this`.
        const kill = processes.kill.bind(processes);
        const input = parseInput(ProcessInputSchema, { value: args[0] });
        const pid = v.is(v.number(), input) ? input : input?.pid;

        if (pid === undefined || !Number.isFinite(pid)) {
          return refusalOf(new KinuError('bad_input',
            `nimbus killProcess: invalid pid ${stringifyResult({ value: args[0] })}`));
        }

        try {
          return stringifyResult({ value: await touch(() => kill(pid)) });
        } catch (err) {
          return refusalOf(nimbusFailure({ doing: `nimbus killProcess ${pid}`, cause: err }));
        }
      },
    },
    logs: {
      description: 'Read Nimbus process logs.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        const processes = box.processes;

        if (!processes?.logs) return handleLacks('process logs');
        const readLogs = processes.logs.bind(processes);
        const input = parseInput(ProcessInputSchema, { value: args[0] });
        const pid = v.is(v.number(), input) ? input : input?.pid;

        if (pid === undefined || !Number.isFinite(pid)) {
          return refusalOf(new KinuError('bad_input',
            `nimbus logs: invalid pid ${stringifyResult({ value: args[0] })}`));
        }

        const options = input !== undefined && !v.is(v.number(), input)
          ? { lines: input.lines, bytes: input.bytes }
          : undefined;

        try {
          return stringifyResult({ value: await touch(() => readLogs(pid, options)) });
        } catch (err) {
          return refusalOf(workspaceExecFailure({ doing: `nimbus logs ${pid}`, cause: err }));
        }
      },
    },
    exposePort: {
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
    },
    unexposePort: {
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
    },
    listPorts: {
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
    },
    installRuntime: {
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
    },
    listRuntimes: {
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
    },
  };

  // JS/TS, shell, coreutils, `node`, `npm`/`npx`, and `git` need no install. `python`/`native_binary` also need a facet
  // host (`runtimeCatalog`); Cloudflare says false, the CLI supplies `localFacetHost()`.
  const capabilities: ExecutorCapability[] = [
    'javascript', 'typescript', 'shell', 'npm', 'git', 'net_outbound',
    ...(box.ports?.expose && opts.inboundNetwork !== false ? (['net_inbound'] as const) : []),
    'process_spawn', 'process_long', 'process_signal',
    ...(opts.runtimeCatalog ? (['python', 'native_binary'] as const) : []),
  ];

  return {
    tools,
    types: SESSION_TYPES,
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

/** Shell over the bytes nimbusSessionFiles exposes. `cred` is fixed at construction, never per call
 *  (see {@link NimbusExecOptions.cred}); absent is the session user. */
export function nimbusSessionShell(box: NimbusSandboxHandle, cred?: VfsCred): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options = v.is(v.string(), stdinOrOptions)
        ? { stdin: stdinOrOptions }
        : stdinOrOptions;

      // Absent option must be an absent key: the substrate reads `'cred' in options` to decide whether to inherit.
      const stdin = options?.stdin;
      let execOptions: NimbusExecOptions | undefined;

      if (stdin !== undefined || cred !== undefined) {
        execOptions = {};

        if (stdin !== undefined) execOptions.stdin = stdin;

        if (cred !== undefined) execOptions.cred = cred;
      }

      const result = await raceAbort(
        () => box.exec(command, execOptions),
        options?.signal,
        'workspace exec aborted — the command may still finish in the session',
      );

      const outcome = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      const refusal = nimbusTransportRefusal(result);

      if (refusal !== null) return { ...outcome, refusal };

      // 127 means the command is not in the box's catalog; the install remedy derives from the box's runtime list.
      const runtimes = box.runtimes?.list?.bind(box.runtimes);

      return workspaceCommandNotFound(outcome, async (bin) => {
        if (runtimes === undefined) return false;

        const catalog = await sessionRuntimeBins(runtimes);

        return 'unreadable' in catalog ? catalog : catalog.has(bin);
      });
    },
  };
}

/**
 * A Nimbus session's files in its own absolute paths. With `cred`, the plane is `files.as(cred)`; a handle without
 * that view is refused as `unsupported`. Absent is the origin. Shell fallbacks run as the same credential.
 */
/** Binds a shell fallback to the plane's credential; absent must be an absent key (`'cred' in options`). */
function asCred(cred: VfsCred | undefined): { cred: VfsCred } | Record<string, never> {
  return cred === undefined ? {} : { cred };
}

export function nimbusSessionFiles(box: NimbusSandboxHandle, cred?: VfsCred): VFS & {
  removeRecursive(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
} & Pick<VfsNativeReads, 'readRange'> {
  let files = box.files;

  if (cred !== undefined) {
    if (files.as === undefined) {
      throw new KinuError('unsupported', 'this workspace handle has no credential-bound file plane, so it cannot act as the agent');
    }

    files = files.as(cred);
  }

  return {
    async readFile(path, opts) {
      const absolute = workspacePath(path);

      if (opts?.encoding !== 'utf8' && files.readBytes) {
        const bytes = await atVfsPath(absolute, 'open', () => files.readBytes?.(absolute) ?? null);

        if (bytes === null) throw makeVfsError('ENOENT', `no such file or directory, open '${absolute}'`, absolute);

        return bytes;
      }

      const content = await atVfsPath(absolute, 'open', () => files.read(absolute));

      if (content === null) throw makeVfsError('ENOENT', `no such file or directory, open '${absolute}'`, absolute);

      return opts?.encoding === 'utf8' ? content : new TextEncoder().encode(content);
    },
    /** Prefix the origin's fixed Node reader reads; the SDK file methods cannot express a range. */
    async readRange(path, offset, length) {
      return readNimbusOriginRange({ box, files, path, offset, length, cred });
    },
    async writeFile(path, data) {
      const absolute = workspacePath(path);

      await atVfsPath(absolute, 'open', () => files.write(absolute, data));
    },
    // No `writeFileIfRevision`: the SDK write takes no precondition and stat has no revision, so
    // `writeExecutorFileOp` answers `unsupported`.
    async readdir(path) {
      const absolute = workspacePath(path);

      return (await atVfsPath(absolute, 'scandir', () => files.list(absolute))).map((e) => e.name);
    },
    async stat(path) {
      if (files.stat) {
        const st = await files.stat(workspacePath(path));

        if (!st) return null;

        return {
          size: st.size,
          mtimeMs: st.mtime,
          isDir: st.type === 'directory',
        };
      }

      // Shell fallbacks run as the plane's credential; running as the session user would change identity silently.
      const r = await box.exec(`stat -c '%s %Y %F' ${shellQuote(workspacePath(path))}`, asCred(cred));

      if (!r.success || r.exitCode !== 0) return null;
      const [size, seconds, ...kind] = r.stdout.trim().split(/\s+/);

      return { size: Number(size), mtimeMs: Number(seconds) * 1_000, isDir: kind.join(' ') === 'directory' };
    },
    async unlink(path) { await files.delete(workspacePath(path)); },
    async removeRecursive(path) { await files.delete(workspacePath(path), { recursive: true }); },
    async rename(from, to) {
      if (!files.rename) throw makeVfsError('EIO', 'Nimbus SDK handle does not expose rename', from);
      await files.rename(workspacePath(from), workspacePath(to));
    },
    async mkdir(path, opts) {
      if (files.mkdir) {
        await files.mkdir(workspacePath(path));

        return;
      }

      const r = await box.exec(`mkdir ${opts?.recursive ? '-p ' : ''}-- ${shellQuote(workspacePath(path))}`, asCred(cred));

      if (!r.success || r.exitCode !== 0) {
        throw makeVfsError('EIO', `${r.stderr.trim() || 'operation failed'}, mkdir '${path}'`, path);
      }
    },
    async exists(path) { return files.exists(workspacePath(path)); },
  };
}
