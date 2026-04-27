/**
 * SSHTunnelExecutor — user's personal machine via WebSocket bridge.
 *
 * The user runs a small daemon on their machine that connects to the
 * agent's WebSocket endpoint. Commands are sent as JSON-RPC over the
 * WebSocket and results stream back.
 *
 * When no tunnel is connected, all operations return a clear message
 * telling the user how to connect.
 *
 * Namespace: laptop.*
 *   laptop.exec("git status")
 *   laptop.readFile("/Users/me/project/src/main.ts")
 *   laptop.writeFile("/tmp/output.json", data)
 *   laptop.readdir("/Users/me/project")
 *   laptop.exists("/Users/me/.config")
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';

const NOT_CONNECTED =
  'SSH tunnel not connected. Connect your machine via the Executors tab, ' +
  'or run: npx proteus-tunnel --agent <agent-url>';

const RPC_TIMEOUT_MS = 30_000;

/**
 * Minimal WebSocket interface — works with both platform WebSocket
 * and the standard browser/node WebSocket.
 */
interface TunnelSocket {
  send(data: string): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  readyState: number;
}

// WebSocket.OPEN = 1 across all implementations
const WS_OPEN = 1;

interface RpcRequest {
  id: string;
  method: string;
  params: unknown[];
}

interface RpcResponse {
  id: string;
  result?: unknown;
  error?: string;
}

/**
 * Create an SSHTunnelExecutor.
 *
 * Call setSocket() when a tunnel WebSocket connects from the user's machine.
 * Call clearSocket() when it disconnects.
 */
export function createSSHTunnelExecutor(): ExecutorProvider & {
  setSocket(ws: TunnelSocket): void;
  clearSocket(): void;
} {
  let socket: TunnelSocket | null = null;
  let rpcIdCounter = 0;

  function isConnected(): boolean {
    return socket != null && socket.readyState === WS_OPEN;
  }

  function rpc(method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!isConnected()) { reject(new Error(NOT_CONNECTED)); return; }

      const id = `rpc-${++rpcIdCounter}`;
      const request: RpcRequest = { id, method, params };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`RPC timeout after ${RPC_TIMEOUT_MS}ms: ${method}`));
      }, RPC_TIMEOUT_MS);

      function handler(event: { data: unknown }) {
        try {
          const msg = JSON.parse(String(event.data)) as RpcResponse;
          if (msg.id !== id) return;
          cleanup();
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        } catch { /* not our message */ }
      }

      function cleanup() {
        clearTimeout(timeout);
        socket?.removeEventListener('message', handler);
      }

      socket!.addEventListener('message', handler);
      socket!.send(JSON.stringify(request));
    });
  }

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Execute a command on the user\'s local machine via SSH tunnel.',
      execute: async (command: unknown): Promise<string> => {
        if (!isConnected()) return NOT_CONNECTED;
        try {
          const result = await rpc('exec', [String(command)]) as
            { stdout: string; stderr: string; exitCode: number };
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
      description: 'Read a file from the user\'s local filesystem via SSH tunnel.',
      execute: async (path: unknown): Promise<string> => {
        if (!isConnected()) return NOT_CONNECTED;
        try {
          // Delegate to exec cat — simple and universal
          const result = await rpc('exec', [`cat ${String(path)}`]) as
            { stdout: string; stderr: string; exitCode: number };
          if (result.exitCode !== 0) return `File not found: ${path}`;
          return result.stdout;
        } catch (err) {
          return `readFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    writeFile: {
      description: 'Write content to a file on the user\'s local filesystem via SSH tunnel.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        if (!isConnected()) return NOT_CONNECTED;
        try {
          // Use tee for writing — handles arbitrary content via stdin
          const result = await rpc('writeFile', [String(path), String(content)]) as
            { success: boolean; error?: string };
          if (!result.success) return `writeFile failed: ${result.error ?? 'unknown error'}`;
          return `Written ${String(content).length} bytes to ${path}`;
        } catch (err) {
          return `writeFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readdir: {
      description: 'List directory contents on the user\'s local machine.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!isConnected()) return NOT_CONNECTED;
        try {
          const result = await rpc('exec', [`ls -1a ${String(path || '/')}`]) as
            { stdout: string; stderr: string; exitCode: number };
          if (result.exitCode !== 0) return `readdir failed: ${result.stderr}`;
          return result.stdout.split('\n').filter(Boolean);
        } catch (err) {
          return `readdir error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    exists: {
      description: 'Check if a path exists on the user\'s local machine.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!isConnected()) return NOT_CONNECTED;
        try {
          const result = await rpc('exec', [`test -e ${String(path)} && echo true || echo false`]) as
            { stdout: string; exitCode: number };
          return result.stdout.trim() === 'true';
        } catch { return false; }
      },
    },
  };

  const provider: ExecutorProvider & {
    setSocket(ws: TunnelSocket): void;
    clearSocket(): void;
  } = {
    name: 'laptop',
    kind: 'laptop',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'python', 'native_binary',
      'shell', 'npm', 'git', 'docker',
      'fs_owned', 'net_outbound', 'net_inbound',
      'process_spawn', 'process_long', 'process_signal', 'gpu',
    ]),
    isAvailable: () => isConnected(),
    connect: async () => {
      if (!isConnected()) throw new Error(NOT_CONNECTED);
      // Verify connectivity with a simple echo
      await rpc('exec', ['echo connected']);
    },
    disconnect: async () => { socket = null; },
    tools,
    types: `declare namespace laptop {
  /** Execute a command on the user's local machine */
  function exec(command: string): Promise<string>;
  /** Read a file from the user's local filesystem */
  function readFile(path: string): Promise<string>;
  /** Write a file to the user's local filesystem */
  function writeFile(path: string, content: string): Promise<string>;
  /** List directory contents on the user's local machine */
  function readdir(path: string): Promise<string[]>;
  /** Check if a path exists on the user's local machine */
  function exists(path: string): Promise<boolean>;
}`,
    positionalArgs: true,

    setSocket(ws: TunnelSocket) { socket = ws; },
    clearSocket() { socket = null; },
  };

  return provider;
}
