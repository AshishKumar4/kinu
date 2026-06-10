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

import { isAbortError, raceAbort } from '@proteus/agent-utils';
import type { ExecutorProvider, ExecutorCapability } from './types.js';
import { TUNNEL_DISCONNECTED } from './device-tunnel.js';
import { readExecSignal } from './signal.js';

const NOT_CONNECTED =
  'No device connected. Connect your machine once at the user level ' +
  '(Devices / Executors tab → "Connect a device", or run the Proteus CLI: `proteus connect`).';

/**
 * Transport the laptop executor speaks through. The actual device socket lives
 * on the user-level hub (UserDO); the agent forwards each JSON-RPC call there,
 * so one connected device serves all of a user's agents. `isConnected()` is a
 * cheap CACHED flag (the executor's isAvailable() is sync + hot) that the
 * transport refreshes from the hub out of band — tool calls do NOT gate on it,
 * they go to the hub and let it answer authoritatively, so a device that
 * connected after this runtime was built works immediately.
 */
export interface DeviceTransport {
  rpc(method: string, params: unknown[]): Promise<unknown>;
  isConnected(): boolean;
}

/** The hub rejects calls when no device socket is live; the tunnel rejects
 *  in-flight calls when the socket drops. Both mean "not connected". */
function isNotConnectedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('no device connected') || message.includes(TUNNEL_DISCONNECTED);
}

/**
 * Create the laptop (`laptop.*`) executor over a device transport. The transport
 * forwards to the user's device hub; this executor just shapes the tool surface.
 */
export function createSSHTunnelExecutor(transport: DeviceTransport): ExecutorProvider {
  const isConnected = (): boolean => transport.isConnected();
  const rpc = (method: string, params: unknown[]): Promise<unknown> => transport.rpc(method, params);

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Execute a command on the user\'s local machine via SSH tunnel.',
      execute: async (command: unknown, options?: unknown): Promise<string> => {
        const signal = readExecSignal(options);
        try {
          // The device protocol has no kill RPC — abort stops the wait; the
          // command may still finish on the user's machine.
          const result = await raceAbort(
            () => rpc('exec', [String(command)]),
            signal,
            'laptop exec aborted — the command may still finish on the device',
          ) as { stdout: string; stderr: string; exitCode: number };
          if (result.exitCode !== 0) {
            return `Exit ${result.exitCode}${result.stderr ? ': ' + result.stderr : ''}`;
          }
          return result.stdout || '(no output)';
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (isNotConnectedError(err)) return NOT_CONNECTED;
          return `exec error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readFile: {
      description: 'Read a file from the user\'s local filesystem via the desktop daemon.',
      execute: async (path: unknown): Promise<string> => {
        try {
          return String(await rpc('readFile', [String(path)]));
        } catch (err) {
          if (isNotConnectedError(err)) return NOT_CONNECTED;
          return `readFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    writeFile: {
      description: 'Write content to a file on the user\'s local filesystem via SSH tunnel.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        try {
          const result = await rpc('writeFile', [String(path), String(content)]);
          if (result !== 'ok' && !(isRecord(result) && result.success === true)) {
            const error = isRecord(result) && typeof result.error === 'string' ? result.error : 'unknown error';
            return `writeFile failed: ${error}`;
          }
          return `Written ${String(content).length} bytes to ${String(path)}`;
        } catch (err) {
          if (isNotConnectedError(err)) return NOT_CONNECTED;
          return `writeFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readdir: {
      description: 'List directory contents on the user\'s local machine.',
      execute: async (path: unknown): Promise<unknown> => {
        try {
          const result = await rpc('listFiles', [String(path || '/')]);
          if (!Array.isArray(result)) return result;
          return result.map((entry) => {
            if (isRecord(entry) && typeof entry.name === 'string') return entry.name;
            return String(entry);
          });
        } catch (err) {
          if (isNotConnectedError(err)) return NOT_CONNECTED;
          return `readdir error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    exists: {
      description: 'Check if a path exists on the user\'s local machine.',
      execute: async (path: unknown): Promise<unknown> => {
        try {
          return Boolean(await rpc('exists', [String(path)]));
        } catch (err) {
          if (isNotConnectedError(err)) return NOT_CONNECTED;
          return false;
        }
      },
    },
  };

  const provider: ExecutorProvider = {
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
      // Verify connectivity with a simple echo
      try {
        await rpc('exec', ['echo connected']);
      } catch (err) {
        if (isNotConnectedError(err)) throw new Error(NOT_CONNECTED);
        throw err;
      }
    },
    disconnect: async () => { /* the hub owns the socket lifecycle */ },
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
    // The user's PC is behind their NAT — we don't open inbound ports
    // back to them. The user can already point their local browser at
    // any URL their machine serves. Use `sandbox` for previewable URLs.
    async exposePort(port: number) {
      return {
        supported: false,
        reason:
          `laptop executor reverse-tunnels outbound from your PC; there's no inbound port to expose ` +
          `from this side. Point your local browser at the address your server uses (port ${port}), ` +
          `or use the 'sandbox' executor if you want a public URL.`,
      };
    },
    async unexposePort() { /* nothing to do */ },
    async listExposedPorts() { return []; },
  };

  return provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
