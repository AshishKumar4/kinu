/**
 * Nimbus executor adapter.
 *
 * Core stays dependency-clean: the Cloudflare backend constructs the real
 * @nimbus-sh/sdk sandbox handle with Nimbus.fromEnv(...).sandbox(...), then
 * passes that handle here. This adapter only maps the handle's stable SDK
 * shape into Proteus's ExecutorProvider contract.
 */

import { isAbortError, raceAbort } from '@proteus/agent-utils';
import type { ExecutorCapability, ExecutorProvider } from './types.js';
import { readExecSignal } from './signal.js';
import { shellQuote } from '../utils/shell.js';

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

export interface NimbusStartResult extends NimbusExecResult {
  pid?: number | null;
  process?: unknown;
  ports?: Array<{ port: number; pid?: number; registeredAt?: number }>;
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
    exists(path: string): Promise<boolean>;
    mkdir?(path: string): Promise<void>;
    delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  };
  runtimes?: {
    ensure?(specs: string | string[], options?: { force?: boolean }): Promise<unknown>;
    install?(spec: string, options?: { force?: boolean }): Promise<unknown>;
    list?(): Promise<unknown>;
  };
  processes?: {
    list?(): Promise<unknown>;
    kill?(pid: number): Promise<unknown>;
    logs?(pid: number, options?: { lines?: number; bytes?: number }): Promise<unknown>;
  };
  ports?: {
    expose?(port: number): Promise<{ port: number; url?: string; listening?: boolean; pid?: number | null; registeredAt?: number | null }>;
    unexpose?(port: number): Promise<unknown>;
    list?(): Promise<Array<{ port: number; url?: string; pid?: number; registeredAt?: number }>>;
    url?(port: number): string | undefined;
  };
}

export interface NimbusExecutorOpts {
  box?: NimbusSandboxHandle;
  root?: string;
}

const NOT_CONFIGURED =
  'Nimbus executor not configured. Add the NIMBUS_SESSION Durable Object binding ' +
  'and construct the executor with Nimbus.fromEnv(...).sandbox(...).';

function normalizeExec(result: NimbusExecResult): string {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (!result.success || result.exitCode !== 0) {
    return `Exit ${result.exitCode}${stderr ? `\n${stderr}` : ''}${stdout ? `\n${stdout}` : ''}`.trim();
  }
  return stdout || stderr || '(no output)';
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function createNimbusExecutor(opts: NimbusExecutorOpts = {}): ExecutorProvider {
  const box = opts.box;
  const configured = box != null;
  const root = opts.root ?? '/home/user';
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
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Run a shell command in the Nimbus development environment.',
      execute: async (command: unknown, options?: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        const signal = readExecSignal(options);
        try {
          // Nimbus exec exposes no kill for an in-flight command — abort
          // stops the wait; the command may still finish in the sandbox.
          return normalizeExec(await raceAbort(
            () => touch(() => box.exec(String(command))),
            signal,
            'nimbus exec aborted — the command may still finish in the sandbox',
          ));
        } catch (err) {
          if (isAbortError(err)) throw err;
          return `exec error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    runCode: {
      description: 'Run code in Nimbus using the requested language runtime.',
      execute: async (code: unknown, options?: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.runCode) return 'runCode error: Nimbus SDK handle does not expose runCode';
        try {
          return normalizeExec(await touch(() => box.runCode!(String(code), options as NimbusRunCodeOptions)));
        } catch (err) {
          return `runCode error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    readFile: {
      description: 'Read a file from the Nimbus filesystem.',
      execute: async (path: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        try {
          return await touch(() => box.files.read(String(path))) ?? '';
        } catch (err) {
          return `readFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    writeFile: {
      description: 'Write a file to the Nimbus filesystem.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        try {
          const body = typeof content === 'string' ? content : JSON.stringify(content);
          await touch(() => box.files.write(String(path), body));
          return `Written ${body.length} bytes to ${path}`;
        } catch (err) {
          return `writeFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    listFiles: {
      description: 'List directory contents in Nimbus.',
      execute: async (path: unknown = root): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        try {
          const entries = await touch(() => box.files.list(String(path || root)));
          return entries.map((f) => `${(f.isDir ?? (f.type === 'directory' || f.type === 'dir')) ? 'd' : '-'} ${f.name}${f.size != null ? ` (${f.size}b)` : ''}`).join('\n');
        } catch (err) {
          return `listFiles error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    readdir: {
      description: 'Alias for listFiles.',
      execute: async (path: unknown = root): Promise<string> => tools.listFiles.execute(path) as Promise<string>,
    },
    exists: {
      description: 'Check whether a path exists in Nimbus.',
      execute: async (path: unknown): Promise<boolean | string> => {
        if (!box) return NOT_CONFIGURED;
        try {
          return await touch(() => box.files.exists(String(path)));
        } catch {
          return false;
        }
      },
    },
    stat: {
      description: 'Get file or directory metadata from Nimbus.',
      execute: async (path: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        try {
          const result = await touch(() => box.exec(`stat -c "%s %Y %F" ${shellQuote(String(path))}`));
          return normalizeExec(result);
        } catch (err) {
          return `stat error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    mkdir: {
      description: 'Create a directory in Nimbus.',
      execute: async (path: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        try {
          if (box.files.mkdir) await touch(() => box.files.mkdir!(String(path)));
          else await touch(() => box.exec(`mkdir -p ${shellQuote(String(path))}`));
          return `Created ${path}`;
        } catch (err) {
          return `mkdir error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    rm: {
      description: 'Delete a file or directory in Nimbus.',
      execute: async (path: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        try {
          await touch(() => box.files.delete(String(path), { recursive: true }));
          return `Deleted ${path}`;
        } catch (err) {
          return `rm error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    startProcess: {
      description: 'Start a long-running process in Nimbus.',
      execute: async (command: unknown, options?: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.startProcess) return 'startProcess error: Nimbus SDK handle does not expose startProcess';
        try {
          return stringifyResult(await touch(() => box.startProcess!(String(command), options as NimbusExecOptions)));
        } catch (err) {
          return `startProcess error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    killProcess: {
      description: 'Kill a Nimbus process by pid.',
      execute: async (input: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.processes?.kill) return 'killProcess error: Nimbus SDK handle does not expose process control';
        const pid = typeof input === 'number' ? input : Number((input as { pid?: unknown })?.pid);
        if (!Number.isFinite(pid)) return `killProcess error: invalid pid ${stringifyResult(input)}`;
        try {
          return stringifyResult(await touch(() => box.processes!.kill!(pid)));
        } catch (err) {
          return `killProcess error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    logs: {
      description: 'Read Nimbus process logs.',
      execute: async (input: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.processes?.logs) return 'logs error: Nimbus SDK handle does not expose process logs';
        const pid = typeof input === 'number' ? input : Number((input as { pid?: unknown })?.pid);
        if (!Number.isFinite(pid)) return `logs error: invalid pid ${stringifyResult(input)}`;
        try {
          return stringifyResult(await touch(() => box.processes!.logs!(pid, typeof input === 'number' ? {} : input as { lines?: number; bytes?: number })));
        } catch (err) {
          return `logs error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    exposePort: {
      description: 'Expose an HTTP-like port from Nimbus and return its preview URL.',
      execute: async (input: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.ports?.expose) return 'exposePort error: Nimbus SDK handle does not expose ports';
        const port = typeof input === 'number' ? input : Number((input as { port?: unknown })?.port ?? input);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) return `exposePort error: invalid port ${stringifyResult(input)}`;
        try {
          const result = await touch(() => box.ports!.expose!(port));
          return result.url ?? box.ports?.url?.(port) ?? stringifyResult(result);
        } catch (err) {
          return `exposePort error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    unexposePort: {
      description: 'Stop exposing a Nimbus port.',
      execute: async (input: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.ports?.unexpose) return 'unexposePort error: Nimbus SDK handle does not expose ports';
        const port = typeof input === 'number' ? input : Number((input as { port?: unknown })?.port ?? input);
        if (!Number.isFinite(port)) return `unexposePort error: invalid port ${stringifyResult(input)}`;
        try {
          await touch(() => box.ports!.unexpose!(port));
          return `unexposed ${port}`;
        } catch (err) {
          return `unexposePort error: ${err instanceof Error ? err.message : String(err)}`;
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
          return `listPorts error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    installRuntime: {
      description: 'Install or ensure a Nimbus runtime such as python, bun, or clang.',
      execute: async (spec: unknown): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        try {
          if (box.runtimes?.install) await touch(() => box.runtimes!.install!(String(spec)));
          else if (box.runtimes?.ensure) await touch(() => box.runtimes!.ensure!(String(spec)));
          else return 'installRuntime error: Nimbus SDK handle does not expose runtime installation';
          return `installed ${spec}`;
        } catch (err) {
          return `installRuntime error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    listRuntimes: {
      description: 'List Nimbus runtimes.',
      execute: async (): Promise<string> => {
        if (!box) return NOT_CONFIGURED;
        if (!box.runtimes?.list) return 'listRuntimes error: Nimbus SDK handle does not expose runtime listing';
        try {
          return stringifyResult(await touch(() => box.runtimes!.list!()));
        } catch (err) {
          return `listRuntimes error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  };

  return {
    name: 'nimbus',
    kind: 'nimbus',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'python', 'native_binary', 'shell', 'npm', 'git',
      'fs_owned', 'net_outbound', 'net_inbound', 'process_spawn', 'process_long', 'process_signal',
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
    types: `declare namespace nimbus {
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
