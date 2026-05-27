/**
 * NimbusExecutor — Durable Object-based development environment.
 *
 * When a NimbusSession DO stub is provided, delegates file operations
 * via its public _rpc* methods and shell execution via _rpcExec.
 *
 * NimbusSession DO exposes:
 *   _rpcReadFile(path: string): Promise<string | null>
 *   _rpcWriteFile(path: string, content: string): Promise<void>
 *   _rpcStat(path: string): Promise<{type, size, mtime, mode} | null>
 *   _rpcReaddir(path: string): Promise<{name, type}[]>
 *   _rpcExists(path: string): Promise<boolean>
 *   _rpcMkdir(path: string): Promise<void>
 *   _rpcUnlink(path: string): Promise<void>
 *   _rpcExec(command: string): Promise<{stdout, stderr, exitCode}>  [required addition]
 *
 * When no stub is provided, returns stub-mode error messages.
 *
 * Namespace: nimbus.*
 *   nimbus.exec("npm install express")
 *   nimbus.readFile("/src/main.ts")
 *   nimbus.writeFile("/src/util.ts", code)
 *   nimbus.node("const fs = require('fs'); ...")
 *   nimbus.git("clone https://github.com/user/repo")
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';

/**
 * The subset of NimbusSession DO methods used by this executor.
 * Matches the public _rpc* methods on NimbusSession.
 */
export interface NimbusStub {
  _rpcReadFile(path: string): Promise<string | null>;
  _rpcWriteFile(path: string, content: string): Promise<void>;
  _rpcStat(path: string): Promise<{ type: string; size: number; mtime: number; mode?: number } | null>;
  _rpcReaddir(path: string): Promise<Array<{ name: string; type: string }>>;
  _rpcExists(path: string): Promise<boolean>;
  _rpcMkdir(path: string): Promise<void>;
  _rpcUnlink(path: string): Promise<void>;
  /** Programmatic shell execution — Nimbus needs to expose this for agent use */
  _rpcExec?(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const NOT_CONNECTED = 'Nimbus environment is not connected. Add a NimbusSession DO binding and call createNimbusExecutor(stub).';
const EXEC_NOT_AVAILABLE = 'Nimbus _rpcExec not available. The NimbusSession DO needs a programmatic exec method.';

/**
 * Create a NimbusExecutor. Pass a NimbusSession DO stub to enable real
 * operations; pass nothing to get stub-mode error messages.
 */
export function createNimbusExecutor(stub?: NimbusStub): ExecutorProvider {
  const connected = stub != null;

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Run a shell command in the Nimbus development environment. ' +
        'Supports 60+ POSIX commands, npm, node, git, esbuild, vite.',
      execute: async (command: unknown): Promise<string> => {
        if (!stub) return NOT_CONNECTED;
        if (!stub._rpcExec) return EXEC_NOT_AVAILABLE;
        try {
          const result = await stub._rpcExec(String(command));
          if (result.exitCode !== 0) {
            return `Exit ${result.exitCode}${result.stderr ? ': ' + result.stderr : ''}`;
          }
          return result.stdout || '(no output)';
        } catch (err) {
          return `exec error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readFile: {
      description: 'Read a file from the Nimbus development filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!stub) return NOT_CONNECTED;
        try {
          const content = await stub._rpcReadFile(String(path));
          return content ?? `File not found: ${path}`;
        } catch (err) {
          return `readFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    writeFile: {
      description: 'Write a file to the Nimbus development filesystem.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        if (!stub) return NOT_CONNECTED;
        try {
          await stub._rpcWriteFile(String(path), String(content));
          return `Written ${String(content).length} bytes to ${path}`;
        } catch (err) {
          return `writeFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readdir: {
      description: 'List directory contents in the Nimbus filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!stub) return NOT_CONNECTED;
        try {
          const entries = await stub._rpcReaddir(String(path || '/'));
          return entries.map(e => `${e.type === 'dir' ? 'd' : '-'} ${e.name}`).join('\n');
        } catch (err) {
          return `readdir error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    exists: {
      description: 'Check if a path exists in the Nimbus filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!stub) return NOT_CONNECTED;
        try { return await stub._rpcExists(String(path)); }
        catch { return false; }
      },
    },

    stat: {
      description: 'Get file/directory metadata from the Nimbus filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!stub) return NOT_CONNECTED;
        try {
          const s = await stub._rpcStat(String(path));
          return s ? `${s.type} size=${s.size} mtime=${s.mtime}` : `Not found: ${path}`;
        } catch (err) {
          return `stat error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    mkdir: {
      description: 'Create a directory in the Nimbus filesystem (recursive).',
      execute: async (path: unknown): Promise<string> => {
        if (!stub) return NOT_CONNECTED;
        try { await stub._rpcMkdir(String(path)); return `Created ${path}`; }
        catch (err) { return `mkdir error: ${err instanceof Error ? err.message : String(err)}`; }
      },
    },

    rm: {
      description: 'Delete a file from the Nimbus filesystem.',
      execute: async (path: unknown): Promise<string> => {
        if (!stub) return NOT_CONNECTED;
        try { await stub._rpcUnlink(String(path)); return `Deleted ${path}`; }
        catch (err) { return `rm error: ${err instanceof Error ? err.message : String(err)}`; }
      },
    },
  };

  return {
    name: 'nimbus',
    kind: 'nimbus',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'shell', 'npm', 'git',
      'fs_owned', 'net_outbound', 'net_inbound', 'process_spawn', 'process_long',
    ]),
    isAvailable: () => connected,
    connect: async () => {
      if (!stub) throw new Error(NOT_CONNECTED);
      // Verify connectivity by checking if the DO responds
      try { await stub._rpcExists('/'); }
      catch (err) { throw new Error(`Nimbus connection failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
    disconnect: async () => {},
    tools,
    types: `declare namespace nimbus {
  /** Run a shell command (60+ POSIX commands, npm, node, git, esbuild, vite) */
  function exec(command: string): Promise<string>;
  /** Read a file from the Nimbus development filesystem */
  function readFile(path: string): Promise<string>;
  /** Write a file to the Nimbus development filesystem */
  function writeFile(path: string, content: string): Promise<string>;
  /** List directory contents */
  function readdir(path: string): Promise<string>;
  /** Check if a path exists */
  function exists(path: string): Promise<boolean>;
  /** Get file/directory metadata */
  function stat(path: string): Promise<string>;
  /** Create a directory (recursive) */
  function mkdir(path: string): Promise<string>;
  /** Delete a file */
  function rm(path: string): Promise<string>;
}`,
    positionalArgs: true,
  };
}
