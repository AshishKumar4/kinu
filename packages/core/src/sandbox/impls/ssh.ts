/**
 * SSHSandbox — wraps the reverse-WebSocket tunnel to the user's machine.
 *
 * The user runs `packages/pc-agent/` (a small daemon) which dials back to
 * the Worker over WebSocket. Each operation is a JSON-RPC envelope
 * `{ id, method, params: [...] }` and the daemon replies `{ id, result }`
 * or `{ id, error }`. Adds setSocket/clearSocket because the WS lifetime
 * is owned by the orchestrator's pc-handler, not the sandbox.
 *
 * Capabilities: full host (`shell`, `native_binary`, `process_spawn`,
 * `fs_persistent`, `net_outbound`, `gpu`, `docker`). The user's machine
 * IS the sandbox.
 */

import type {
  SandboxApi, SandboxCapability, DirEntry, Stat, ShellResult, ExecOptions,
} from '../types.js';
import { SandboxError } from '../types.js';

/** Minimal WebSocket interface — works with platform WS, browser WS, Node ws. */
export interface TunnelSocket {
  send(data: string): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  readyState: number;
}

export interface SSHSandboxApi extends SandboxApi {
  /** Called by pc-handler.ts when a tunnel WS attaches. */
  setSocket(ws: TunnelSocket): void;
  /** Called when the tunnel disconnects. */
  clearSocket(): void;
}

const WS_OPEN = 1;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Build an SSHSandbox. The orchestrator wires the WS by calling setSocket(). */
export function createSSHSandbox(id: string): SSHSandboxApi {
  let socket: TunnelSocket | null = null;
  let rpcSeq = 0;

  function isConnected(): boolean {
    return socket != null && socket.readyState === WS_OPEN;
  }

  function rpc<T>(method: string, params: unknown[], timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!isConnected()) {
        reject(new SandboxError('SSH tunnel not connected', 'not_available'));
        return;
      }
      const id = `rpc-${++rpcSeq}`;
      const request = { id, method, params };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new SandboxError(`RPC timeout after ${timeoutMs}ms: ${method}`, 'timeout'));
      }, timeoutMs);

      function handler(event: { data: unknown }) {
        try {
          const msg = JSON.parse(String(event.data)) as { id: string; result?: T; error?: string };
          if (msg.id !== id) return;
          cleanup();
          if (msg.error) reject(new SandboxError(msg.error, 'internal'));
          else resolve(msg.result as T);
        } catch {
          // Not our message; keep listening.
        }
      }

      function cleanup() {
        clearTimeout(timeout);
        socket?.removeEventListener('message', handler);
      }

      socket!.addEventListener('message', handler);
      socket!.send(JSON.stringify(request));
    });
  }

  const capabilities = new Set<SandboxCapability>([
    'shell', 'native_binary',
    'process_spawn', 'process_signal',
    'fs_persistent',
    'net_outbound', 'gpu', 'docker',
  ]);

  const api: SSHSandboxApi = {
    id,
    kind: 'ssh',
    capabilities,

    async connect() {
      if (!isConnected()) throw new SandboxError('SSH tunnel not connected', 'not_available');
      // Probe.
      await rpc<{ stdout: string }>('exec', ['echo connected'], 5_000);
    },
    async disconnect() {
      socket = null;
    },
    isAvailable: () => isConnected(),

    async exec(command: string, options?: ExecOptions): Promise<ShellResult> {
      const t0 = Date.now();
      try {
        const r = await rpc<{ stdout: string; stderr: string; exitCode: number }>(
          'exec', [command], options?.timeout ?? DEFAULT_RPC_TIMEOUT_MS,
        );
        return {
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          exitCode: r.exitCode ?? 0,
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        return {
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
          durationMs: Date.now() - t0,
        };
      }
    },

    async readFile(path: string): Promise<string> {
      try {
        // Prefer dedicated method if daemon supports it; fall back to cat.
        return await rpc<string>('readFile', [path]);
      } catch (err) {
        if (!(err instanceof SandboxError) || err.kind !== 'internal') throw err;
        // Fall back to `cat`.
        const r = await rpc<{ stdout: string; stderr: string; exitCode: number }>(
          'exec', [`cat ${shellQuote(path)}`],
        );
        if (r.exitCode !== 0) throw new SandboxError(`File not found: ${path}`, 'not_found');
        return r.stdout;
      }
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      const body = typeof content === 'string' ? content : new TextDecoder().decode(content);
      const r = await rpc<{ success: boolean; error?: string }>('writeFile', [path, body]);
      if (!r.success) throw new SandboxError(r.error ?? 'writeFile failed', 'internal');
    },

    async readdir(path: string): Promise<DirEntry[]> {
      try {
        return await rpc<DirEntry[]>('readdir', [path]);
      } catch {
        // Daemon may not implement readdir RPC; fall back to `ls -1F` parse.
        const r = await rpc<{ stdout: string; exitCode: number }>(
          'exec', [`ls -1F ${shellQuote(path)}`],
        );
        const lines = (r.stdout ?? '').split('\n').filter(Boolean);
        return lines.map((line) => {
          const isDir = line.endsWith('/');
          const name = isDir ? line.slice(0, -1) : line.replace(/[*@|=]$/, '');
          const full = path.endsWith('/') ? path + name : path + '/' + name;
          return { name, path: full, isDirectory: isDir };
        });
      }
    },

    async stat(path: string): Promise<Stat | null> {
      const r = await rpc<{ stdout: string; stderr: string; exitCode: number }>(
        'exec',
        // BSD/GNU stat are different; this format works on Linux only. Mac users
        // will get a non-zero exit; we treat that as null.
        [`stat -c "%s %Y %F" ${shellQuote(path)}`],
        5_000,
      );
      if (r.exitCode !== 0) return null;
      const [sizeStr, mtimeStr, ...kindParts] = r.stdout.trim().split(' ');
      const kind = kindParts.join(' ');
      return {
        isFile: kind.includes('regular file'),
        isDirectory: kind === 'directory',
        isSymbolicLink: kind.includes('symbolic link'),
        size: Number(sizeStr) || 0,
        mtimeMs: (Number(mtimeStr) || 0) * 1000,
      };
    },

    async exists(path: string): Promise<boolean> {
      try {
        const r = await rpc<{ stdout: string; exitCode: number }>(
          'exec', [`test -e ${shellQuote(path)} && echo yes || echo no`], 5_000,
        );
        return r.stdout.trim() === 'yes';
      } catch {
        return false;
      }
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      const flag = options?.recursive === false ? '' : '-p ';
      const r = await rpc<{ exitCode: number; stderr: string }>(
        'exec', [`mkdir ${flag}${shellQuote(path)}`], 5_000,
      );
      if (r.exitCode !== 0) throw new SandboxError(`mkdir: ${r.stderr}`, 'internal');
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const flag = `${options?.recursive ? '-r' : ''}${options?.force ? 'f' : ''}`;
      const r = await rpc<{ exitCode: number; stderr: string }>(
        'exec',
        [`rm ${flag ? '-' + flag.replace(/^-+/, '') + ' ' : ''}${shellQuote(path)}`],
        15_000,
      );
      if (r.exitCode !== 0 && !options?.force) {
        throw new SandboxError(`rm: ${r.stderr}`, 'internal');
      }
    },

    // Tunnel wiring — called by pc-handler.ts when WS attaches/detaches.
    setSocket(ws: TunnelSocket) { socket = ws; },
    clearSocket() { socket = null; },
  };

  return api;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
