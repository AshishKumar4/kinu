/**
 * sandboxToExecutorProvider — bridge SandboxApi to the existing codemode
 * ExecutorProvider surface.
 *
 * The orchestrator already passes ExecutorProvider[] to @cloudflare/codemode's
 * createCodeTool({ providers }). Each provider gets a namespace in the LLM's
 * sandbox arrow (workspace.*, sandbox.*, nimbus.*, laptop.*). This adapter
 * means each SandboxApi automatically becomes a codemode provider — adding a
 * new sandbox is one file under impls/ + one register() call, with no
 * changes to ExecutorProvider/codemode plumbing.
 *
 * Capability mapping (SandboxCapability → ExecutorCapability) is conservative:
 * we promote 'shell' to both 'shell' and 'javascript'/'typescript' (since
 * shells can spawn node/tsx), and add 'fs_shared' if the sandbox flags it.
 */

import type {
  ExecutorProvider,
  ExecutorCapability,
  ExecutorKind,
} from '../execution/types.js';
import type {
  SandboxApi,
  SandboxCapability,
  SandboxKind,
  PortInfo,
} from './types.js';

const SANDBOX_KIND_TO_EXECUTOR: Record<SandboxKind, ExecutorKind> = {
  virtual: 'workspace',
  cloudflare: 'sandbox',
  nimbus: 'nimbus',
  ssh: 'laptop',
  local: 'workspace',
};

/**
 * Translate sandbox capability flags into the executor's coarser set.
 * We always include 'javascript' and 'typescript' because the LLM's
 * scaffold/codemode body is JS — if the sandbox can exec a shell, it can
 * exec node.
 */
function translateCapabilities(caps: ReadonlySet<SandboxCapability>): Set<ExecutorCapability> {
  const out = new Set<ExecutorCapability>(['javascript', 'typescript']);
  if (caps.has('shell')) out.add('shell');
  if (caps.has('native_binary')) out.add('native_binary');
  if (caps.has('process_spawn')) {
    out.add('process_spawn');
    out.add('process_long');
  }
  if (caps.has('process_signal')) out.add('process_signal');
  if (caps.has('fs_shared')) out.add('fs_shared');
  else if (caps.has('fs_persistent')) out.add('fs_owned');
  if (caps.has('net_outbound')) out.add('net_outbound');
  if (caps.has('net_inbound')) out.add('net_inbound');
  if (caps.has('gpu')) out.add('gpu');
  if (caps.has('docker')) out.add('docker');
  return out;
}

/**
 * Default TS declarations for an LLM that doesn't know which sandbox it's
 * driving. Auto-extended with ports/spawn/pty if the underlying API supports
 * them.
 */
function buildTypes(namespace: string, api: SandboxApi): string {
  const hasPorts = typeof api.listPorts === 'function';
  const hasSpawn = typeof api.spawn === 'function';
  const portsBlock = hasPorts
    ? `
  /** List currently-exposed ports. */
  function listPorts(): Promise<Array<{ port: number; name?: string; url?: string; status?: string }>>;
  /** Expose a port for public access; returns the preview URL. */
  function exposePort(port: number, opts?: { name?: string }): Promise<{ port: number; name?: string; url?: string }>;
  /** Unexpose a port. */
  function unexposePort(port: number): Promise<string>;`
    : '';
  const spawnBlock = hasSpawn
    ? `
  /** Spawn a long-running process. Returns { id, write, signal, wait }. */
  function spawn(command: string, opts?: { cwd?: string; env?: Record<string,string> }): Promise<{ id: string }>;`
    : '';

  return `declare namespace ${namespace} {
  /** Execute a shell command. Returns combined stdout, or an error string with exit code. */
  function exec(command: string): Promise<string>;
  /** Read a UTF-8 file. */
  function readFile(path: string): Promise<string>;
  /** Write content to a file (UTF-8). Creates parent directories. */
  function writeFile(path: string, content: string): Promise<string>;
  /** List directory entries — array of { name, path, isDirectory, size? }. */
  function readdir(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean; size?: number }>>;
  /** Check if a path exists. */
  function exists(path: string): Promise<boolean>;
  /** Get file metadata (or null if missing). */
  function stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number } | null>;
  /** Create a directory (recursive by default). */
  function mkdir(path: string, opts?: { recursive?: boolean }): Promise<string>;
  /** Delete a file or directory. */
  function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<string>;${portsBlock}${spawnBlock}
}`;
}

/**
 * Wrap a SandboxApi as a codemode ExecutorProvider.
 *
 * The resulting provider:
 *   • Forwards exec/readFile/writeFile/readdir/exists/stat/mkdir/rm directly.
 *   • Returns error STRINGS (not throws) on operational failures so LLM code
 *     can recover (matches the existing inline/sandbox/nimbus convention).
 *   • Exposes listPorts/exposePort/unexposePort/spawn when supported.
 *   • Generates types describing the actual surface.
 */
export function sandboxToExecutorProvider(
  api: SandboxApi,
  namespace: string,
): ExecutorProvider {
  const errMsg = (op: string, err: unknown): string =>
    `${op} error: ${err instanceof Error ? err.message : String(err)}`;

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Execute a shell command in this sandbox. Returns combined stdout, or an error string with exit code/details.',
      execute: async (command: unknown): Promise<string> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          const r = await api.exec(String(command));
          if (r.exitCode !== 0) return `Exit ${r.exitCode}${r.stderr ? ': ' + r.stderr.trim() : ''}`;
          return r.stdout || '(no output)';
        } catch (err) {
          return errMsg('exec', err);
        }
      },
    },
    readFile: {
      description: 'Read a UTF-8 file from this sandbox.',
      execute: async (path: unknown): Promise<string> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          return await api.readFile(String(path));
        } catch (err) {
          return errMsg('readFile', err);
        }
      },
    },
    writeFile: {
      description: 'Write content to a file in this sandbox. Creates parent dirs.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          const c = String(content);
          await api.writeFile(String(path), c);
          return `Written ${c.length} bytes to ${path}`;
        } catch (err) {
          return errMsg('writeFile', err);
        }
      },
    },
    readdir: {
      description: 'List directory entries.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          return await api.readdir(String(path || '/'));
        } catch (err) {
          return errMsg('readdir', err);
        }
      },
    },
    exists: {
      description: 'Check if a path exists.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!api.isAvailable()) return false;
        try {
          return await api.exists(String(path));
        } catch {
          return false;
        }
      },
    },
    stat: {
      description: 'Get file metadata.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          return await api.stat(String(path));
        } catch (err) {
          return errMsg('stat', err);
        }
      },
    },
    mkdir: {
      description: 'Create a directory (recursive).',
      execute: async (path: unknown, opts: unknown): Promise<string> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          const options = (opts as { recursive?: boolean }) ?? { recursive: true };
          await api.mkdir(String(path), options);
          return `Created ${path}`;
        } catch (err) {
          return errMsg('mkdir', err);
        }
      },
    },
    rm: {
      description: 'Delete a file or directory.',
      execute: async (path: unknown, opts: unknown): Promise<string> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          const options = (opts as { recursive?: boolean; force?: boolean }) ?? {};
          await api.rm(String(path), options);
          return `Deleted ${path}`;
        } catch (err) {
          return errMsg('rm', err);
        }
      },
    },
  };

  if (typeof api.listPorts === 'function') {
    const listPorts = api.listPorts.bind(api);
    tools.listPorts = {
      description: 'List currently-exposed ports.',
      execute: async (): Promise<unknown> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          return await listPorts();
        } catch (err) {
          return errMsg('listPorts', err);
        }
      },
    };
  }

  if (typeof api.exposePort === 'function') {
    const exposePort = api.exposePort.bind(api);
    tools.exposePort = {
      description: 'Expose a port for public access. Returns the preview URL.',
      execute: async (port: unknown, opts: unknown): Promise<unknown> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          const p = typeof port === 'number' ? port : Number(port);
          if (!Number.isFinite(p) || p <= 0) return 'exposePort requires a positive integer port.';
          const options = (opts as { name?: string }) ?? {};
          const res: PortInfo = await exposePort(p, options);
          return res;
        } catch (err) {
          return errMsg('exposePort', err);
        }
      },
    };
  }

  if (typeof api.unexposePort === 'function') {
    const unexposePort = api.unexposePort.bind(api);
    tools.unexposePort = {
      description: 'Unexpose a previously-exposed port.',
      execute: async (port: unknown): Promise<string> => {
        if (!api.isAvailable()) return `${namespace} not available.`;
        try {
          const p = typeof port === 'number' ? port : Number(port);
          if (!Number.isFinite(p) || p <= 0) return 'unexposePort requires a positive integer port.';
          await unexposePort(p);
          return `Unexposed ${p}`;
        } catch (err) {
          return errMsg('unexposePort', err);
        }
      },
    };
  }

  return {
    name: namespace,
    kind: SANDBOX_KIND_TO_EXECUTOR[api.kind],
    capabilities: translateCapabilities(api.capabilities),
    isAvailable: () => api.isAvailable(),
    connect: async () => { await api.connect(); },
    disconnect: async () => { await api.disconnect(); },
    tools,
    types: buildTypes(namespace, api),
    positionalArgs: true,
  };
}
