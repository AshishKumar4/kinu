/**
 * Nimbus executor adapter.
 *
 * Core stays dependency-clean: the Cloudflare backend constructs the real
 * @nimbus-sh/sdk sandbox handle with Nimbus.fromEnv(...).sandbox(...), then
 * passes that handle here. This adapter only maps the handle's stable SDK
 * shape into Proteus's ExecutorProvider contract.
 */

import * as v from 'valibot';
import { isAbortError, raceAbort } from '@proteus/agent-utils';
import type { VFS } from '../types/primitives.js';
import type { Shell } from '../types/primitives.js';
import { createInlineExecutor, type InlineExecutorDeps } from './inline.js';
import { makeVfsError } from '../vfs/errno.js';
import { workspacePath } from '../vfs/workspace-path.js';
import { shellQuote } from '../utils/shell.js';
import type { ExecutorCapability, ExecutorProvider } from './types.js';
import { readExecSignal } from './signal.js';
import { formatExecResult } from './exec-result.js';
import type { JsonValue } from '../utils/json.js';

export interface NimbusExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
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
    write(path: string, content: string | Uint8Array): Promise<void>;
    list(path?: string): Promise<Array<{ name: string; type?: string; isDir?: boolean; size?: number }>>;
    /** Native stat (SDK ≥0.2.0). `mtime` is in milliseconds; null when absent. */
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
  'Nimbus executor not configured. Add the NIMBUS_SESSION Durable Object binding ' +
  'and construct the executor with Nimbus.fromEnv(...).sandbox(...).';

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

function errorMessage(input: { error: unknown }): string {
  return input.error instanceof Error ? input.error.message : String(input.error);
}

function stringifyResult(input: { value: unknown }): string {
  const text = v.safeParse(v.string(), input.value);
  if (text.success) return text.output;
  if (input.value == null) return '';
  try { return JSON.stringify(input.value, null, 2); } catch { return String(input.value); }
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

export function createNimbusExecutor(opts: NimbusExecutorOpts = {}): ExecutorProvider {
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
      lastError = errorMessage({ error: err });
      throw err;
    }
  };

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Run a shell command in the Nimbus development environment.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) return 'exec error: command must be a string';
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
          return `exec error: ${errorMessage({ error: err })}`;
        }
      },
    },
    runCode: {
      description: 'Run code in Nimbus using the requested language runtime.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.runCode) return 'runCode error: Nimbus SDK handle does not expose runCode';
        const code = parseInput(StringSchema, { value: args[0] });
        if (code === undefined) return 'runCode error: code must be a string';
        const options = parseInput(NimbusRunCodeOptionsSchema, { value: args[1] });
        try {
          return normalizeExec(await touch(() => box.runCode!(code, options)));
        } catch (err) {
          return `runCode error: ${errorMessage({ error: err })}`;
        }
      },
    },
    readFile: {
      description: 'Read a file from the Nimbus filesystem.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return 'readFile error: path must be a string';
        try {
          return await touch(() => box.files.read(path)) ?? '';
        } catch (err) {
          return `readFile error: ${errorMessage({ error: err })}`;
        }
      },
    },
    writeFile: {
      description: 'Write a file to the Nimbus filesystem.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return 'writeFile error: path must be a string';
        try {
          const stringContent = v.safeParse(v.string(), args[1]);
          const body = stringContent.success ? stringContent.output : JSON.stringify(args[1]);
          if (body === undefined) return 'writeFile error: content is not serializable';
          await touch(() => box.files.write(path, body));
          return `Written ${body.length} bytes to ${path}`;
        } catch (err) {
          return `writeFile error: ${errorMessage({ error: err })}`;
        }
      },
    },
    listFiles: {
      description: 'List directory contents in Nimbus.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const path = parseInput(OptionalPathSchema, { value: args[0] });
        if (args[0] !== undefined && path === undefined) return 'listFiles error: path must be a string';
        try {
          const entries = await touch(() => box.files.list(path || root));
          return entries.map((f) => `${(f.isDir ?? (f.type === 'directory' || f.type === 'dir')) ? 'd' : '-'} ${f.name}${f.size != null ? ` (${f.size}b)` : ''}`).join('\n');
        } catch (err) {
          return `listFiles error: ${errorMessage({ error: err })}`;
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
        if (!box) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return false;
        try {
          return await touch(() => box.files.exists(path));
        } catch {
          return false;
        }
      },
    },
    stat: {
      description: 'Get file or directory metadata from Nimbus.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return 'stat error: path must be a string';
        try {
          const result = await touch(() => box.exec(`stat -c "%s %Y %F" ${shellQuote(path)}`));
          return normalizeExec(result);
        } catch (err) {
          return `stat error: ${errorMessage({ error: err })}`;
        }
      },
    },
    mkdir: {
      description: 'Create a directory in Nimbus.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return 'mkdir error: path must be a string';
        try {
          if (box.files.mkdir) await touch(() => box.files.mkdir!(path));
          else await touch(() => box.exec(`mkdir -p ${shellQuote(path)}`));
          return `Created ${path}`;
        } catch (err) {
          return `mkdir error: ${errorMessage({ error: err })}`;
        }
      },
    },
    rm: {
      description: 'Delete a file or directory in Nimbus.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return 'rm error: path must be a string';
        try {
          await touch(() => box.files.delete(path, { recursive: true }));
          return `Deleted ${path}`;
        } catch (err) {
          return `rm error: ${errorMessage({ error: err })}`;
        }
      },
    },
    startProcess: {
      description: 'Start a background process in Nimbus; returns while it is still running.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.startProcess) return 'startProcess error: Nimbus SDK handle does not expose startProcess';
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) return 'startProcess error: command must be a string';
        const options = parseInput(NimbusExecOptionsSchema, { value: args[1] });
        try {
          return formatStartResult(await touch(() => box.startProcess!(command, options)), namespace);
        } catch (err) {
          return `startProcess error: ${errorMessage({ error: err })}`;
        }
      },
    },
    killProcess: {
      description: 'Kill a Nimbus process by pid.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.processes?.kill) return 'killProcess error: Nimbus SDK handle does not expose process control';
        const input = parseInput(ProcessInputSchema, { value: args[0] });
        const pid = input === undefined ? undefined : v.is(v.number(), input) ? input : input.pid;
        if (pid === undefined || !Number.isFinite(pid)) {
          return `killProcess error: invalid pid ${stringifyResult({ value: args[0] })}`;
        }
        try {
          return stringifyResult({ value: await touch(() => box.processes!.kill!(pid)) });
        } catch (err) {
          return `killProcess error: ${errorMessage({ error: err })}`;
        }
      },
    },
    logs: {
      description: 'Read Nimbus process logs.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.processes?.logs) return 'logs error: Nimbus SDK handle does not expose process logs';
        const input = parseInput(ProcessInputSchema, { value: args[0] });
        const pid = input === undefined ? undefined : v.is(v.number(), input) ? input : input.pid;
        if (pid === undefined || !Number.isFinite(pid)) {
          return `logs error: invalid pid ${stringifyResult({ value: args[0] })}`;
        }
        const options = input !== undefined && !v.is(v.number(), input)
          ? { lines: input.lines, bytes: input.bytes }
          : undefined;
        try {
          return stringifyResult({ value: await touch(() => box.processes!.logs!(pid, options)) });
        } catch (err) {
          return `logs error: ${errorMessage({ error: err })}`;
        }
      },
    },
    exposePort: {
      description: 'Expose an HTTP-like port from Nimbus and return its preview URL.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.ports?.expose) return 'exposePort error: Nimbus SDK handle does not expose ports';
        const input = parseInput(PortInputSchema, { value: args[0] });
        const port = input === undefined ? undefined : v.is(v.number(), input) ? input : input.port;
        if (port === undefined || !Number.isFinite(port) || port <= 0 || port > 65535) {
          return `exposePort error: invalid port ${stringifyResult({ value: args[0] })}`;
        }
        try {
          const result = await touch(() => box.ports!.expose!(port));
          return result.url ?? box.ports?.url?.(port) ?? stringifyResult({ value: result });
        } catch (err) {
          return `exposePort error: ${errorMessage({ error: err })}`;
        }
      },
    },
    unexposePort: {
      description: 'Stop exposing a Nimbus port.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.ports?.unexpose) return 'unexposePort error: Nimbus SDK handle does not expose ports';
        const input = parseInput(PortInputSchema, { value: args[0] });
        const port = input === undefined ? undefined : v.is(v.number(), input) ? input : input.port;
        if (port === undefined || !Number.isFinite(port)) {
          return `unexposePort error: invalid port ${stringifyResult({ value: args[0] })}`;
        }
        try {
          await touch(() => box.ports!.unexpose!(port));
          return `unexposed ${port}`;
        } catch (err) {
          return `unexposePort error: ${errorMessage({ error: err })}`;
        }
      },
    },
    listPorts: {
      description: 'List Nimbus exposed ports.',
      execute: async (): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.ports?.list) return '[]';
        try {
          const ports = await touch(() => box.ports!.list!());
          return JSON.stringify(ports.map((p) => ({ ...p, url: p.url ?? box.ports?.url?.(p.port) })));
        } catch (err) {
          return `listPorts error: ${errorMessage({ error: err })}`;
        }
      },
    },
    installRuntime: {
      description: 'Install or ensure a Nimbus runtime such as python, bun, or clang.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const spec = parseInput(StringSchema, { value: args[0] });
        if (spec === undefined) return 'installRuntime error: spec must be a string';
        try {
          if (box.runtimes?.install) await touch(() => box.runtimes!.install!(spec));
          else if (box.runtimes?.ensure) await touch(() => box.runtimes!.ensure!(spec));
          else return 'installRuntime error: Nimbus SDK handle does not expose runtime installation';
          return `installed ${spec}`;
        } catch (err) {
          return `installRuntime error: ${errorMessage({ error: err })}`;
        }
      },
    },
    listRuntimes: {
      description: 'List Nimbus runtimes.',
      execute: async (): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.runtimes?.list) return 'listRuntimes error: Nimbus SDK handle does not expose runtime listing';
        try {
          return stringifyResult({ value: await touch(() => box.runtimes!.list!()) });
        } catch (err) {
          return `listRuntimes error: ${errorMessage({ error: err })}`;
        }
      },
    },
  };

  return {
    name: 'nimbus',
    files: box ? nimbusSessionFiles(box) : undefined,
    homeDir: async () => root,
    kind: 'nimbus',
    // JavaScript/TypeScript, the shell, npm and git are built into the session
    // worker itself. Interpreter runtimes are not: they install from the
    // deployment's runtime source, so `python`/`native_binary` are declared
    // exactly when that source exists (see NimbusExecutorOpts.runtimeCatalog).
    // This is the executor that carries Python when it is provisioned — the
    // sandbox container image deliberately ships no interpreter.
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
    types: `declare namespace ${namespace} {
  function exec(command: string): Promise<string>;
  function runCode(code: string, options?: { language?: 'javascript'|'typescript'|'python'|'ruby'|'shell'; install?: 'never'|'ifMissing' }): Promise<string>;
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  function listFiles(path?: string): Promise<string>;
  function readdir(path?: string): Promise<string>;
  function exists(path: string): Promise<boolean>;
  function stat(path: string): Promise<string>;
  function mkdir(path: string): Promise<string>;
  function rm(path: string): Promise<string>;
  function startProcess(command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string,string> }): Promise<string>;
  function killProcess(pid: number | { pid: number }): Promise<string>;
  function logs(pid: number | { pid: number; lines?: number; bytes?: number }): Promise<string>;
  function exposePort(port: number | { port: number }): Promise<string>;
  function unexposePort(port: number | { port: number }): Promise<string>;
  function listPorts(): Promise<string>;
  function installRuntime(spec: string): Promise<string>;
  function listRuntimes(): Promise<string>;
}`,
    positionalArgs: true,
    async exposePort(port: number) {
      if (!box?.ports?.expose) return { supported: false, reason: 'Nimbus port exposure is not available' };
      const result = await touch(() => box.ports!.expose!(port));
      return {
        supported: true,
        port,
        url: result.url ?? box.ports?.url?.(port) ?? '',
        verified_listening: result.listening ?? false,
      };
    },
    async unexposePort(port: number) {
      if (box?.ports?.unexpose) await touch(() => box.ports!.unexpose!(port));
    },
    async listExposedPorts() {
      if (!box?.ports?.list) return [];
      const ports = await touch(() => box.ports!.list!());
      return ports.map((p) => ({
        port: p.port,
        url: p.url ?? box.ports?.url?.(p.port) ?? '',
        status: 'unknown' as const,
      })).filter((p) => p.url);
    },
  };
}

/**
 * Compose Proteus's durable workspace tools with the process/runtime/port
 * surface of the same Nimbus session. Hosted runtimes register this provider
 * once as `workspace`; there is no second Nimbus namespace or filesystem.
 */
export function createNimbusWorkspaceExecutor(opts: NimbusWorkspaceExecutorOpts): ExecutorProvider {
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
  function startProcess(command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string,string> }): Promise<string>;
  function killProcess(pid: number | { pid: number }): Promise<string>;
  function logs(pid: number | { pid: number; lines?: number; bytes?: number }): Promise<string>;
  function exposePort(port: number | { port: number }): Promise<string>;
  function unexposePort(port: number | { port: number }): Promise<string>;
  function listPorts(): Promise<string>;
  function installRuntime(spec: string): Promise<string>;
  function listRuntimes(): Promise<string>;`;

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
    exposePort: session.exposePort!.bind(session),
    unexposePort: session.unexposePort!.bind(session),
    listExposedPorts: session.listExposedPorts!.bind(session),
  };
}

/** The shell primitive over the exact bytes exposed by nimbusSessionFiles. */
export function nimbusSessionShell(box: NimbusSandboxHandle): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options = v.is(v.string(), stdinOrOptions)
        ? { stdin: stdinOrOptions }
        : stdinOrOptions;
      const result = await raceAbort(
        () => box.exec(command, options?.stdin === undefined ? undefined : { stdin: options.stdin }),
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
 */
export function nimbusSessionFiles(box: NimbusSandboxHandle): VFS & {
  removeRecursive(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
} {
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
    async writeFile(path, data) { await box.files.write(workspacePath(path), data); },
    async readdir(path) { return (await box.files.list(workspacePath(path))).map((e) => e.name); },
    async stat(path) {
      if (box.files.stat) {
        const st = await box.files.stat(workspacePath(path));
        if (!st) return null;
        return { size: st.size, mtimeMs: st.mtime, isDir: st.type === 'directory' };
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
