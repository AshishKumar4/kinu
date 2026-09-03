/**
 * Nimbus executor adapter.
 *
 * Core stays dependency-clean: the composing backend builds the workspace box
 * and passes it here — on Cloudflare that is Nimbus held as a library over the
 * owning Durable Object's own SQLite (`cf-backend/src/workspace-host.ts`), or a
 * client onto that object for one of its facets. This adapter only maps the
 * box's stable shape into Kinu's ExecutorProvider contract.
 */

import * as v from 'valibot';
import { isAbortError, raceAbort } from '@kinu.run/agent-utils';
import type { Shell, VFS } from '../types/primitives';
import type { VfsNativeReads } from '../vfs/mounts';
import { createInlineExecutor, type InlineExecutorDeps } from './inline';
import { agentSessionFiles } from './nimbus-agent-files';
import { makeVfsError } from '../vfs/errno';
import { workspacePath } from '../vfs/workspace-path';
import { shellQuote } from '../utils/shell';
import { base64ToBytes } from '../utils/base64';
import type { ExecutorCapability, ExecutorProvider, PortAnsweringExecutor } from './types';
import { readExecSignal } from './signal';
import { formatExecResult, refusalText } from './exec-result';
import { KinuError, renderThrownChain, toKinuError } from '../obs/index';
import type { JsonValue } from '../utils/json';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';

/** The fallback's own constants: one environment value carries path and
 *  offsets as JSON, so no shell text ever quotes a path. */
const NIMBUS_RANGE_ENV = 'KINU_NIMBUS_RANGE_REQUEST';
const NIMBUS_RANGE_READER = `const fs=require('node:fs');const r=JSON.parse(process.env.${NIMBUS_RANGE_ENV});if(!Number.isSafeInteger(r.offset)||r.offset<0||!Number.isSafeInteger(r.length)||r.length<=0)throw new Error('invalid range');const fd=fs.openSync(r.path,'r');try{const b=Buffer.allocUnsafe(r.length);const n=fs.readSync(fd,b,0,r.length,r.offset);process.stdout.write(b.subarray(0,n).toString('base64'));}finally{fs.closeSync(fd);}`;

/**
 * One window of one file's bytes, off the session's own filesystem.
 *
 * A file read must not require a shell: the reader below used to run
 * `node -e <one-line CJS reader>` through the box's exec, and the `node`
 * command compiles its `-e` source with `new Function` — which the Workers
 * runtime forbids outright, so the first ranged read on a hosted workspace
 * died as EIO with "Code generation from strings disallowed for this
 * context" while every Node-run test stayed green. The box's file plane now
 * carries the native ranged read; the shell reader survives only as the
 * fallback for an SDK handle that predates it, and no hosted deployment is
 * on one (the box carries the op on both sides of the RPC).
 */
async function readNimbusOriginRange(
  box: NimbusSandboxHandle, path: string, offset: number, length: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
    throw makeVfsError('EIO', 'range offset and length must be positive safe integers', path);
  }
  const absolute = workspacePath(path);
  const native = box.files.readRange;
  if (native) {
    const bytes = await native.call(box.files, absolute, offset, length);
    if (bytes === null) throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);
    return bytes;
  }
  // Path and offsets travel as JSON in one environment value, never through
  // shell text, for the handles that still need the session's own Node.
  const result = await box.exec(`node -e ${shellQuote(NIMBUS_RANGE_READER)}`, {
    env: { [NIMBUS_RANGE_ENV]: JSON.stringify({ path: absolute, offset, length }) },
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
  /**
   * Who this command runs as, or absent for the session user.
   *
   * HOST-INJECTED, NEVER AGENT-SUPPLIED, and the distinction is the whole
   * security property: a credential names a uid, so a surface that let an agent
   * choose one would let it choose uid 0. {@link NimbusExecOptionsSchema}
   * therefore omits this field deliberately — see the note there — and the only
   * way a credential reaches `exec` is a host stamping it in, as
   * {@link nimbusSessionShell} does.
   */
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

/**
 * What `startProcess` returns since SDK 0.2.0: a background process that is
 * STILL RUNNING when the call comes back — so there is no exit code and no
 * captured output here. Output and the eventual exit record are read through
 * `logs`; the process is stopped through `killProcess`.
 */
export interface NimbusStartResult {
  command: string;
  pid: number;
  process: NimbusProcessInfo;
  ports: NimbusPortInfo[];
  startedAt: number;
}

export interface NimbusSandboxHandle {
  ready(): Promise<void>;
  exec(command: string, options?: NimbusExecOptions): Promise<NimbusExecResult>;
  startProcess?(command: string, options?: NimbusExecOptions): Promise<NimbusStartResult>;
  runCode?(code: string, options?: NimbusRunCodeOptions): Promise<NimbusExecResult>;
  files: {
    read(path: string): Promise<string | null>;
    /** Raw-byte read (SDK ≥0.1.4) — the binary-safe counterpart of `read`. */
    readBytes?(path: string): Promise<Uint8Array | null>;
    /** Exactly this window of one file's bytes, without materializing the
     *  file. Absent on an SDK handle that predates it; null when the path is
     *  absent, the same answer `read` gives. */
    readRange?(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    /** Whole-file write. The SDK takes no precondition and answers nothing, so
     *  a caller that needs compare-and-write cannot get it here. */
    write(path: string, content: string | Uint8Array): Promise<void>;
    list(path?: string): Promise<Array<{ name: string; type?: string; isDir?: boolean; size?: number }>>;
    /** Native stat (SDK ≥0.2.0). `mtime` is in milliseconds; null when absent.
     *  No revision: `NimbusFileStat` carries type, size, ctime, mtime and mode. */
    stat?(path: string): Promise<{ type: string; size: number; mtime: number } | null>;
    lstat?(path: string): Promise<{ type: string; size: number; mtime: number; mode?: number } | null>;
    rename?(from: string, to: string): Promise<void>;
    chmod?(path: string, mode: number): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir?(path: string): Promise<void>;
    delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  };
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
    expose?(port: number): Promise<{ port: number; url?: string; listening?: boolean; pid?: number | null; registeredAt?: number | null; capability?: string | null }>;
    unexpose?(port: number): Promise<JsonValue | undefined>;
    list?(): Promise<Array<{ port: number; url?: string; pid?: number; registeredAt?: number; capability?: string }>>;
    url?(port: number): string | undefined;
  };
}

export interface NimbusExecutorOpts {
  box?: NimbusSandboxHandle;
  root?: string;
  namespace?: string;
  /**
   * Whether this host can publish the session's ports as reachable preview
   * URLs. A handle with a port API is assumed reachable unless the composing
   * backend disables it because its public preview origin is unconfigured.
   */
  inboundNetwork?: boolean;
  /**
   * Whether this deployment can actually install interpreter runtimes
   * (python, ruby, clang) into the session — for the Cloudflare backend, that
   * the `NIMBUS_RUNTIME_CACHE` R2 bucket is bound and published. `python` and
   * `native_binary` are declared exactly when this is true: a capability row
   * must say what runs, and a session without a runtime source answers
   * `python -c` with an install error, not a Python.
   */
  runtimeCatalog?: boolean;
}

export interface NimbusWorkspaceExecutorOpts extends NimbusExecutorOpts {
  box: NimbusSandboxHandle;
  inline: InlineExecutorDeps;
}

const NOT_CONFIGURED =
  'Nimbus executor not configured. The host must construct the workspace box and ' +
  'pass it here — `createHostedWorkspace(...).box(shellId)` on the Cloudflare ' +
  'backend, the embedded bundle on the CLI.';

/**
 * `unavailable`, for the reason spelled out in `sandbox.ts`: the binding is
 * absent, so this deployment has no session at all, and it is the same fact the
 * `run` tool already spells `unavailable` for an unregistered runtime. One fact,
 * one code, one part of the census.
 *
 * Its own bucket matters more here than anywhere else: Nimbus IS the workspace
 * (`createNimbusWorkspaceExecutor` registers it as `workspace`), so an absent box
 * used to answer every single call with prose that `isFailingResultText` reads as
 * a clean success.
 */
const NOT_CONFIGURED_REFUSAL = refusalText(new KinuError('unavailable', NOT_CONFIGURED));

/**
 * The session is live and the SDK handle this deployment holds has no such
 * surface — an older `@nimbus-sh/sdk`, or a host that composed a narrower handle.
 *
 * `unsupported`, never `unavailable`: retrying cannot grow a method onto a handle,
 * which is the exact line the two codes divide (obs/error.ts), and it is the same
 * call the `run` tool makes for `runtime_does_not_support_exec`.
 */
function handleLacks(surface: string): string {
  return refusalText(new KinuError('unsupported', `Nimbus SDK handle does not expose ${surface}`));
}

/** Every failure out of the session's RPC. `io` is the seam's own answer for an
 *  unrecognised one — this is a transport to a Durable Object — while an abort, a
 *  timeout or the memory wall keeps the more precise code the classifier pinned. */
function nimbusFailure(input: { doing: string; cause: unknown }): KinuError {
  return toKinuError({ ...input, otherwise: 'io' });
}

/** `success: false` with a zero exit code is Nimbus reporting a transport-level
 *  failure the exit code cannot express — render it as the failure it is. */
function normalizeExec(result: NimbusExecResult): string {
  return formatExecResult({
    ...result,
    exitCode: !result.success && result.exitCode === 0 ? 1 : result.exitCode,
  });
}

const StringSchema = v.string();
const OptionalPathSchema = v.optional(v.string());
/**
 * The agent-facing option schemas, and both OMIT `cred` on purpose.
 *
 * These parse tool arguments, which is to say model output. `v.object` is
 * non-strict, so a `cred` an agent invents is STRIPPED here rather than
 * refused — the escalation is dropped before it reaches the substrate, where
 * `isVfsCred` would otherwise fall through to the session user and say nothing.
 * Adding `cred` to either schema would hand every agent its own choice of uid.
 */
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

/**
 * Render a startProcess result the way the agent needs to read it: whether
 * the process is STILL RUNNING, and which calls observe or stop it. The old
 * exec-shaped rendering here was the transcript-measured failure mode — a
 * server printed its startup line, the one-shot runner reported `exited(0)`,
 * and the agent burned the rest of its calls discovering that nothing was
 * listening.
 */
function formatStartResult(result: NimbusStartResult, namespace: string): string {
  const running = result.process.state === 'running';
  const lines = [
    running
      ? `started (long-running) pid=${result.pid}: ${result.command}`
      : `started pid=${result.pid}: ${result.command} — already ${result.process.state}` +
        (result.process.exitCode != null ? ` (exit ${result.process.exitCode})` : ''),
  ];
  if (result.ports.length > 0) {
    lines.push(`listening on port${result.ports.length > 1 ? 's' : ''} ${result.ports.map((p) => p.port).join(', ')} — ${namespace}.exposePort(<port>) returns the preview URL`);
  }
  lines.push(`output: ${namespace}.logs(${result.pid}) · stop: ${namespace}.killProcess(${result.pid})`);
  return lines.join('\n');
}

/**
 * The session's process, port and runtime control surface, as a namespace
 * declares it to the model.
 *
 * ONE list with two readers: `createNimbusExecutor` renders it into its own
 * namespace, and `createNimbusWorkspaceExecutor` appends it to the inline
 * `workspace` one. It was written out twice, so a tool the session gained could
 * be declared to one namespace and hidden from the other — and the tools
 * themselves are already shared, which is what made the divergence silent.
 */
const SESSION_CONTROL_TYPES =
  `  function startProcess(command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string,string> }): Promise<string>;
  function killProcess(pid: number | { pid: number }): Promise<string>;
  function logs(pid: number | { pid: number; lines?: number; bytes?: number }): Promise<string>;
  function exposePort(port: number | { port: number }): Promise<string>;
  function unexposePort(port: number | { port: number }): Promise<string>;
  function listPorts(): Promise<string>;
  function installRuntime(spec: string): Promise<string>;
  function listRuntimes(): Promise<string>;`;

export function createNimbusExecutor(opts: NimbusExecutorOpts = {}): PortAnsweringExecutor {
  const box = opts.box;
  const configured = box != null;
  const root = opts.root ?? '/home/user';
  const namespace = opts.namespace ?? 'nimbus';
  let active = false;
  let lastError: string | undefined;

  const touch = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!box) throw new Error(NOT_CONFIGURED);
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

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Run a shell command in the Nimbus development environment.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus exec: command must be a string'));
        }
        const signal = readExecSignal({ context: args[1] });
        try {
          // Nimbus exec exposes no kill for an in-flight command — abort
          // stops the wait; the command may still finish in the sandbox.
          return normalizeExec(await raceAbort(
            () => touch(() => box.exec(command)),
            signal,
            'nimbus exec aborted — the command may still finish in the sandbox',
          ));
        } catch (err) {
          if (isAbortError(err)) throw err;
          return refusalText(nimbusFailure({ doing: `nimbus exec \`${command}\``, cause: err }));
        }
      },
    },
    runCode: {
      description: 'Run code in Nimbus using the requested language runtime.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        if (!box.runCode) return handleLacks('runCode');
        const code = parseInput(StringSchema, { value: args[0] });
        if (code === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus runCode: code must be a string'));
        }
        const options = parseInput(NimbusRunCodeOptionsSchema, { value: args[1] });
        try {
          return normalizeExec(await touch(() => box.runCode!(code, options)));
        } catch (err) {
          return refusalText(nimbusFailure({ doing: 'nimbus runCode', cause: err }));
        }
      },
    },
    readFile: {
      description: 'Read a file from the Nimbus filesystem.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus readFile: path must be a string'));
        }
        try {
          return await touch(() => box.files.read(path)) ?? '';
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus readFile ${path}`, cause: err }));
        }
      },
    },
    writeFile: {
      description: 'Write a file to the Nimbus filesystem.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus writeFile: path must be a string'));
        }
        try {
          const stringContent = v.safeParse(v.string(), args[1]);
          const body = stringContent.success ? stringContent.output : JSON.stringify(args[1]);
          if (body === undefined) {
            return refusalText(new KinuError('bad_input', 'nimbus writeFile: content is not serializable'));
          }
          await touch(() => box.files.write(path, body));
          return `Written ${body.length} bytes to ${path}`;
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus writeFile ${path}`, cause: err }));
        }
      },
    },
    listFiles: {
      description: 'List directory contents in Nimbus.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(OptionalPathSchema, { value: args[0] });
        if (args[0] !== undefined && path === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus listFiles: path must be a string'));
        }
        try {
          const entries = await touch(() => box.files.list(path || root));
          return entries.map((f) => `${(f.isDir ?? (f.type === 'directory' || f.type === 'dir')) ? 'd' : '-'} ${f.name}${f.size != null ? ` (${f.size}b)` : ''}`).join('\n');
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus listFiles ${path || root}`, cause: err }));
        }
      },
    },
    readdir: {
      description: 'Alias for listFiles.',
      execute: async (...args: unknown[]) => tools.listFiles.execute(args[0] ?? root),
    },
    exists: {
      description: 'Check whether a path exists in Nimbus.',
      execute: async (...args: unknown[]): Promise<boolean | string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        // `false` here was the same lie the catch below already refuses to tell:
        // a boolean answer claims the path is absent, and a call that was never
        // made has established nothing about the path.
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus exists: path must be a string'));
        }
        try {
          return await touch(() => box.files.exists(path));
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus exists ${path}`, cause: err }));
        }
      },
    },
    stat: {
      description: 'Get file or directory metadata from Nimbus.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus stat: path must be a string'));
        }
        try {
          const result = await touch(() => box.exec(`stat -c "%s %Y %F" ${shellQuote(path)}`));
          return normalizeExec(result);
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus stat ${path}`, cause: err }));
        }
      },
    },
    mkdir: {
      description: 'Create a directory in Nimbus.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus mkdir: path must be a string'));
        }
        const mkdir = box.files.mkdir?.bind(box.files);
        try {
          if (mkdir) await touch(() => mkdir(path));
          else await touch(() => box.exec(`mkdir -p ${shellQuote(path)}`));
          return `Created ${path}`;
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus mkdir ${path}`, cause: err }));
        }
      },
    },
    rm: {
      description: 'Delete a file or directory in Nimbus.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus rm: path must be a string'));
        }
        try {
          await touch(() => box.files.delete(path, { recursive: true }));
          return `Deleted ${path}`;
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus rm ${path}`, cause: err }));
        }
      },
    },
    startProcess: {
      description: 'Start a background process in Nimbus; returns while it is still running.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        if (!box.startProcess) return handleLacks('startProcess');
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus startProcess: command must be a string'));
        }
        const options = parseInput(NimbusExecOptionsSchema, { value: args[1] });
        try {
          return formatStartResult(await touch(() => box.startProcess!(command, options)), namespace);
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus startProcess \`${command}\``, cause: err }));
        }
      },
    },
    killProcess: {
      description: 'Kill a Nimbus process by pid.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const processes = box.processes;
        if (!processes?.kill) return handleLacks('process control');
        // Bound HERE, at the guard, for the reason every optional SDK surface
        // below repeats: the call happens inside a closure, and TypeScript drops
        // a property narrowing at that boundary — which is what the
        // `box.processes!.kill!` assertions were standing in for. Binding keeps
        // the receiver too, so the SDK method still reads its own `this`.
        const kill = processes.kill.bind(processes);
        const input = parseInput(ProcessInputSchema, { value: args[0] });
        const pid = input === undefined ? undefined : v.is(v.number(), input) ? input : input.pid;
        if (pid === undefined || !Number.isFinite(pid)) {
          return refusalText(new KinuError('bad_input',
            `nimbus killProcess: invalid pid ${stringifyResult({ value: args[0] })}`));
        }
        try {
          return stringifyResult({ value: await touch(() => kill(pid)) });
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus killProcess ${pid}`, cause: err }));
        }
      },
    },
    logs: {
      description: 'Read Nimbus process logs.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const processes = box.processes;
        if (!processes?.logs) return handleLacks('process logs');
        const readLogs = processes.logs.bind(processes);
        const input = parseInput(ProcessInputSchema, { value: args[0] });
        const pid = input === undefined ? undefined : v.is(v.number(), input) ? input : input.pid;
        if (pid === undefined || !Number.isFinite(pid)) {
          return refusalText(new KinuError('bad_input',
            `nimbus logs: invalid pid ${stringifyResult({ value: args[0] })}`));
        }
        const options = input !== undefined && !v.is(v.number(), input)
          ? { lines: input.lines, bytes: input.bytes }
          : undefined;
        try {
          return stringifyResult({ value: await touch(() => readLogs(pid, options)) });
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus logs ${pid}`, cause: err }));
        }
      },
    },
    exposePort: {
      description: 'Expose an HTTP-like port from Nimbus and return its preview URL.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const ports = box.ports;
        if (!ports?.expose) return handleLacks('ports');
        const expose = ports.expose.bind(ports);
        const input = parseInput(PortInputSchema, { value: args[0] });
        const port = input === undefined ? undefined : v.is(v.number(), input) ? input : input.port;
        if (port === undefined || !Number.isFinite(port) || port <= 0 || port > 65535) {
          return refusalText(new KinuError('bad_input',
            `nimbus exposePort: invalid port ${stringifyResult({ value: args[0] })}`));
        }
        try {
          const result = await touch(() => expose(port));
          return result.url ?? ports.url?.(port) ?? stringifyResult({ value: result });
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus exposePort ${port}`, cause: err }));
        }
      },
    },
    unexposePort: {
      description: 'Stop exposing a Nimbus port.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const ports = box.ports;
        if (!ports?.unexpose) return handleLacks('ports');
        const unexpose = ports.unexpose.bind(ports);
        const input = parseInput(PortInputSchema, { value: args[0] });
        const port = input === undefined ? undefined : v.is(v.number(), input) ? input : input.port;
        if (port === undefined || !Number.isFinite(port)) {
          return refusalText(new KinuError('bad_input',
            `nimbus unexposePort: invalid port ${stringifyResult({ value: args[0] })}`));
        }
        try {
          await touch(() => unexpose(port));
          return `unexposed ${port}`;
        } catch (err) {
          return refusalText(nimbusFailure({ doing: `nimbus unexposePort ${port}`, cause: err }));
        }
      },
    },
    listPorts: {
      description: 'List Nimbus exposed ports.',
      execute: async (): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        // `'[]'` claimed this session has no exposed ports. It has no port API at
        // all, which is a different fact — an empty read must stay
        // distinguishable from a read that could not be made (AGENTS.md).
        const ports = box.ports;
        if (!ports?.list) return handleLacks('ports');
        const list = ports.list.bind(ports);
        try {
          const exposed = await touch(() => list());
          return JSON.stringify(exposed.map((p) => ({ ...p, url: p.url ?? ports.url?.(p.port) })));
        } catch (err) {
          return refusalText(nimbusFailure({ doing: 'nimbus listPorts', cause: err }));
        }
      },
    },
    installRuntime: {
      description: 'Install or ensure a Nimbus runtime such as python, bun, or clang.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const spec = parseInput(StringSchema, { value: args[0] });
        if (spec === undefined) {
          return refusalText(new KinuError('bad_input', 'nimbus installRuntime: spec must be a string'));
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
          return refusalText(nimbusFailure({ doing: `nimbus installRuntime ${spec}`, cause: err }));
        }
      },
    },
    listRuntimes: {
      description: 'List Nimbus runtimes.',
      execute: async (): Promise<string> => {
        if (!box) return NOT_CONFIGURED_REFUSAL;
        const runtimes = box.runtimes;
        if (!runtimes?.list) return handleLacks('runtime listing');
        const list = runtimes.list.bind(runtimes);
        try {
          return stringifyResult({ value: await touch(() => list()) });
        } catch (err) {
          return refusalText(nimbusFailure({ doing: 'nimbus listRuntimes', cause: err }));
        }
      },
    },
  };

  return {
    name: 'nimbus',
    files: box ? nimbusSessionFiles(box) : undefined,
    homeDir: async () => root,
    kind: 'nimbus',
    // JavaScript/TypeScript, the shell, ~95 coreutils and `node` are the bare
    // workspace's own; `npm` and `npx` are registered by
    // `provisionWorkspaceRuntimes` (JavaScript reaching a registry over `fetch`);
    // `git` is isomorphic-git over the same SqliteVFS, registered by the host.
    // None needs an install, so all are declared unconditionally.
    //
    // Interpreter runtimes DO need one, and they need somewhere to RUN: a wasm
    // guest requires a facet host, so `python`/`native_binary` are declared
    // exactly when the composing backend says both halves are present
    // (NimbusExecutorOpts.runtimeCatalog). The Cloudflare backend says false —
    // workerd forbids the dynamic evaluation a local facet host performs — and
    // the CLI supplies `localFacetHost()`.
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'shell', 'npm', 'git',
      'fs_owned', 'net_outbound',
      ...(box?.ports?.expose && opts.inboundNetwork !== false ? (['net_inbound'] as const) : []),
      'process_spawn', 'process_long', 'process_signal',
      ...(opts.runtimeCatalog ? (['python', 'native_binary'] as const) : []),
    ]),
    isAvailable: () => configured,
    getStatus: () => ({
      configured,
      available: configured,
      active,
      status: configured ? (lastError ? 'error' : active ? 'active' : 'idle') : 'not_configured',
      ...(lastError ? { reason: lastError } : configured ? {} : { reason: NOT_CONFIGURED }),
    }),
    connect: async () => { if (!box) throw new Error(NOT_CONFIGURED); await touch(() => box.ready()); },
    disconnect: async () => { active = false; },
    tools,
    types: `/**
 * Every call below either answers, or resolves to a refusal
 * \`{"reason":"<class>","error":"<what happened>"}\`. \`reason\` is the class —
 * bad_input, unavailable, unsupported, timeout, cancelled, oom, io — so branch on
 * it rather than matching prose. \`unsupported\` means this deployment's session
 * handle has no such surface and a retry cannot change that.
 */
declare namespace ${namespace} {
  function exec(command: string): Promise<string>;
  function runCode(code: string, options?: { language?: 'javascript'|'typescript'|'python'|'ruby'|'shell'; install?: 'never'|'ifMissing' }): Promise<string>;
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  function listFiles(path?: string): Promise<string>;
  function readdir(path?: string): Promise<string>;
  /** true or false — or a refusal payload, if the session could not be asked. */
  function exists(path: string): Promise<boolean | string>;
  function stat(path: string): Promise<string>;
  function mkdir(path: string): Promise<string>;
  function rm(path: string): Promise<string>;
${SESSION_CONTROL_TYPES}
}`,
    positionalArgs: true,
    async exposePort(port: number) {
      const ports = box?.ports;
      if (!ports?.expose) return { supported: false, reason: 'Nimbus port exposure is not available' };
      const expose = ports.expose.bind(ports);
      const result = await touch(() => expose(port));
      return {
        supported: true,
        port,
        url: result.url ?? ports.url?.(port) ?? '',
        verified_listening: result.listening ?? false,
      };
    },
    async unexposePort(port: number) {
      const ports = box?.ports;
      if (!ports?.unexpose) return;
      const unexpose = ports.unexpose.bind(ports);
      await touch(() => unexpose(port));
    },
    async listExposedPorts() {
      const ports = box?.ports;
      if (!ports?.list) return [];
      const list = ports.list.bind(ports);
      return (await touch(() => list())).map((p) => ({
        port: p.port,
        url: p.url ?? ports.url?.(p.port) ?? '',
        status: 'unknown' as const,
      })).filter((p) => p.url);
    },
  };
}

/**
 * Compose Kinu's durable workspace tools with the process/runtime/port
 * surface of the same Nimbus session. Hosted runtimes register this provider
 * once as `workspace`; there is no second Nimbus namespace or filesystem.
 */
export function createNimbusWorkspaceExecutor(opts: NimbusWorkspaceExecutorOpts): PortAnsweringExecutor {
  const inline = createInlineExecutor(opts.inline);
  const session = createNimbusExecutor({ ...opts, namespace: 'workspace' });
  const {
    exec: _sessionExec,
    readFile: _sessionRead,
    writeFile: _sessionWrite,
    listFiles: _sessionList,
    readdir: _sessionReaddir,
    exists: _sessionExists,
    stat: _sessionStat,
    mkdir: _sessionMkdir,
    rm: _sessionRm,
    ...sessionTools
  } = session.tools;
  const sessionTypes = `
  function runCode(code: string, options?: { language?: 'javascript'|'typescript'|'python'|'ruby'|'shell'; install?: 'never'|'ifMissing' }): Promise<string>;
${SESSION_CONTROL_TYPES}`;

  return {
    ...inline,
    files: inline.files,
    capabilities: new Set<ExecutorCapability>([
      ...inline.capabilities,
      ...[...session.capabilities].filter((capability) => capability !== 'fs_owned'),
      'fs_shared',
    ]),
    getStatus: session.getStatus,
    connect: session.connect,
    disconnect: session.disconnect,
    tools: { ...inline.tools, ...sessionTools },
    types: (inline.types ?? '').replace(/\n}\s*$/, `${sessionTypes}\n}`),
    // Straight through, no assertion: `createNimbusExecutor` answers for its
    // ports by type, so all three are declared present. Nothing to bind either —
    // each closes over the session handle rather than reading `this`.
    exposePort: session.exposePort,
    unexposePort: session.unexposePort,
    listExposedPorts: session.listExposedPorts,
  };
}

/**
 * The shell primitive over the exact bytes exposed by nimbusSessionFiles.
 *
 * `cred` binds this shell to one identity for its whole lifetime, which is what
 * makes a node's home mean anything at runtime: the boundary is uid/gid/mode on
 * real inodes, so it only bites if the commands actually run as the node. It is
 * a construction argument rather than a per-call one BECAUSE it must not be
 * chooseable per call — see {@link NimbusExecOptions.cred}. Absent is the
 * session user, i.e. exactly the origin's own behaviour.
 */
export function nimbusSessionShell(box: NimbusSandboxHandle, cred?: VfsCred): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options = v.is(v.string(), stdinOrOptions)
        ? { stdin: stdinOrOptions }
        : stdinOrOptions;
      // Assigned rather than spread conditionally: an absent option must be an
      // ABSENT KEY, because the substrate reads `'cred' in options` to decide
      // whether to inherit — a key holding `undefined` is a different fact from a
      // key nobody set.
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
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}

/**
 * A Nimbus session's files, in the session's own absolute paths.
 *
 * The cleanest of the raw handles — read/readBytes/write/list/stat/exists/
 * mkdir/delete, with `write` taking Uint8Array natively, so binary round-trips
 * exactly.
 *
 * `cred` names WHO the operations act as, and it changes the transport because
 * the substrate leaves no choice: `box.files.*` is pid-less, and the worker
 * resolves a pid-less caller to the session user, so a credential cannot ride
 * that surface at all. Supplied, every operation goes through the one surface
 * that does accept a credential — see {@link agentSessionFiles}, which reaches
 * the SAME session and the same bytes as this. Absent is the ORIGIN, which is
 * every caller that is not one agent acting for itself.
 */
export function nimbusSessionFiles(box: NimbusSandboxHandle, cred?: VfsCred): VFS & {
  removeRecursive(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
} & Pick<VfsNativeReads, 'readRange'> {
  if (cred) return agentSessionFiles(box, cred);
  return {
    async readFile(path, opts) {
      const absolute = workspacePath(path);
      if (opts?.encoding !== 'utf8' && box.files.readBytes) {
        const bytes = await box.files.readBytes(absolute);
        if (bytes === null) throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);
        return bytes;
      }
      const content = await box.files.read(absolute);
      if (content === null) throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);
      return opts?.encoding === 'utf8' ? content : new TextEncoder().encode(content);
    },
    /** The origin session's fixed Node reader reads exactly this prefix — the
     *  SDK file methods cannot express a range and would materialize the file. */
    async readRange(path, offset, length) {
      return readNimbusOriginRange(box, path, offset, length);
    },
    async writeFile(path, data) { await box.files.write(workspacePath(path), data); },
    // NO `writeFileIfRevision`. The SDK's `files.write` takes no precondition
    // and returns nothing, and its `stat` reports no revision, so this plane
    // has neither half of a compare-and-write. Declaring the method would mean
    // emulating it with read/compare/write, which cannot close the window it
    // claims to close; `writeExecutorFileOp` answers `unsupported` instead and
    // the editor stays read-only with that reason.
    async readdir(path) { return (await box.files.list(workspacePath(path))).map((e) => e.name); },
    async stat(path) {
      if (box.files.stat) {
        const st = await box.files.stat(workspacePath(path));
        if (!st) return null;
        return {
          size: st.size,
          mtimeMs: st.mtime,
          isDir: st.type === 'directory',
        };
      }
      const r = await box.exec(`stat -c '%s %Y %F' ${shellQuote(workspacePath(path))}`);
      if (!r.success || r.exitCode !== 0) return null;
      const [size, seconds, ...kind] = r.stdout.trim().split(/\s+/);
      return { size: Number(size), mtimeMs: Number(seconds) * 1_000, isDir: kind.join(' ') === 'directory' };
    },
    async unlink(path) { await box.files.delete(workspacePath(path)); },
    async removeRecursive(path) { await box.files.delete(workspacePath(path), { recursive: true }); },
    async rename(from, to) {
      if (!box.files.rename) throw makeVfsError('EIO', 'Nimbus SDK handle does not expose rename', from);
      await box.files.rename(workspacePath(from), workspacePath(to));
    },
    async mkdir(path, opts) {
      if (box.files.mkdir) { await box.files.mkdir(workspacePath(path)); return; }
      const r = await box.exec(`mkdir ${opts?.recursive ? '-p ' : ''}-- ${shellQuote(workspacePath(path))}`);
      if (!r.success || r.exitCode !== 0) {
        throw makeVfsError('EIO', `${r.stderr.trim() || 'operation failed'}, mkdir '${path}'`, path);
      }
    },
    async exists(path) { return box.files.exists(workspacePath(path)); },
  };
}
