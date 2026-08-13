/**
 * DeviceTunnelExecutor — user's personal machine via WebSocket bridge.
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
import type { VFS } from '../types/primitives.js';
import { makeVfsError } from '../vfs/errno.js';
import { shellQuote } from '../utils/shell.js';
import { base64ToBytes, bytesToBase64 } from '../utils/base64.js';
import { parseStatLine } from './exec-result.js';
import type { ExecutorProvider, ExecutorCapability, ExecutorStatus } from './types.js';
import type { DeviceStatus } from './device-status.js';
import { isDeviceNotConnectedError } from './device-tunnel.js';
import { readExecSignal } from './signal.js';
import { formatExecResult } from './exec-result.js';

const NOT_CONNECTED =
  'No device connected. Connect your machine once at the user level ' +
  '(Devices / Executors tab → "Connect a device", or run the Proteus CLI: `proteus connect`).';

/**
 * Transport the laptop executor speaks through. The actual device socket lives
 * on the user-level hub (UserDO); the agent forwards each JSON-RPC call there,
 * so one connected device serves all of a user's agents. `status()` is a cheap
 * CACHED snapshot (the executor's isAvailable()/getStatus() are sync + hot)
 * that the transport refreshes from the hub out of band; `refreshStatus()` is
 * the authoritative awaited check backends run at turn start so the turn's
 * context reflects the CURRENT device state. Tool calls do NOT gate on either —
 * they go to the hub and let it answer authoritatively, so a device that
 * connected after this runtime was built works immediately.
 */
export interface DeviceTransport {
  /** `timeoutMs: 0` means the call carries no work deadline — it ends when the
   *  device answers, the caller aborts, or the device goes away. */
  rpc(method: string, params: unknown[], opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Cached snapshot — sync and cheap; may lag the hub by the cache TTL. */
  status(): DeviceStatus;
  /** Authoritative hub check; resolves with the fresh snapshot. */
  refreshStatus(): Promise<DeviceStatus>;
}

/**
 * Create the laptop (`laptop.*`) executor over a device transport. The transport
 * forwards to the user's device hub; this executor just shapes the tool surface.
 */
export function createDeviceTunnelExecutor(
  transport: DeviceTransport,
  /** Path-scope for the file view. Omitted leaves the view unscoped, which is
   *  correct only where the caller has already scoped the transport. */
  consent: DeviceFileConsent = ALWAYS_CONSENTED,
): ExecutorProvider {
  const rpc = (method: string, params: unknown[], opts?: { timeoutMs?: number }): Promise<unknown> =>
    transport.rpc(method, params, opts);

  // Three-state lifecycle from the hub snapshot: connected, registered-but-
  // offline (the user can reconnect), or no registered device at all.
  const getStatus = (): ExecutorStatus => {
    const s = transport.status();
    if (s.connected) return { configured: true, available: true, active: true, status: 'active' };
    if (s.registered) {
      return {
        configured: true, available: false, active: false, status: 'disconnected',
        reason: 'Device registered but offline — the user can reconnect it with `proteus connect`.',
      };
    }
    return { configured: false, available: false, active: false, status: 'not_configured' };
  };

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Execute a command on the user\'s local machine via the device tunnel.',
      execute: async (command: unknown, options?: unknown): Promise<string> => {
        const signal = readExecSignal(options);
        try {
          // The device protocol has no kill RPC — abort stops the wait; the
          // command may still finish on the user's machine.
          const result = await raceAbort(
            // No transport deadline: this is arbitrary user work — a build, a
            // test suite, an install — and the transport is not the thing that
            // knows how long it should take. The bounds that DO apply stay:
            // the caller's abort signal below, the turn's own cancellation,
            // and the tunnel's liveness probe if the device disappears.
            () => rpc('exec', [String(command)], { timeoutMs: 0 }),
            signal,
            'laptop exec aborted — the command may still finish on the device',
          ) as { stdout: string; stderr: string; exitCode: number };
          return formatExecResult(result);
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED;
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
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED;
          return `readFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    writeFile: {
      description: 'Write content to a file on the user\'s local filesystem via the device tunnel.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        try {
          const result = await rpc('writeFile', [String(path), String(content)]);
          if (result !== 'ok' && !(isRecord(result) && result.success === true)) {
            const error = isRecord(result) && typeof result.error === 'string' ? result.error : 'unknown error';
            return `writeFile failed: ${error}`;
          }
          return `Written ${String(content).length} bytes to ${String(path)}`;
        } catch (err) {
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED;
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
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED;
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
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED;
          return false;
        }
      },
    },
  };

  const provider: ExecutorProvider = {
    name: 'laptop',
    files: deviceFiles(transport, consent),
    kind: 'laptop',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'python', 'native_binary',
      'shell', 'npm', 'git', 'docker',
      'fs_owned', 'net_outbound', 'net_inbound',
      'process_spawn', 'process_long', 'process_signal', 'gpu',
    ]),
    isAvailable: () => transport.status().connected,
    getStatus,
    connect: async () => {
      // Verify connectivity with a simple echo
      try {
        await rpc('exec', ['echo connected']);
      } catch (err) {
        if (isDeviceNotConnectedError(err)) throw new Error(NOT_CONNECTED);
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

/**
 * Consent boundary of the device file view. The view exposes the device's REAL
 * root — a faithful window, not a lossy rewrite — but by default only the
 * consented subtree (the device connect dir, falling back to the device home)
 * is reachable. Anything outside it needs the stronger 'full_filesystem' tier.
 */
export interface DeviceFileConsent {
  /** The consented subtree, or null to fall back to the device's home. */
  consentedRoot(): string | null;
  /** Whether this agent holds the full-filesystem consent tier. */
  hasFullFilesystem(): Promise<boolean>;
}

const ALWAYS_CONSENTED: DeviceFileConsent = {
  consentedRoot: () => '/',
  hasFullFilesystem: async () => true,
};

/**
 * The user's machine, in the machine's own absolute paths.
 *
 * The daemon speaks readFile/writeFile/listFiles/exists natively; stat, mkdir
 * and unlink are synthesized through `exec` (GNU stat, falling back to BSD).
 * Every call still crosses the hub's per-(agent, device) action-consent
 * chokepoint; this view adds the path-scope layer on top.
 */
export function deviceFiles(transport: DeviceTransport, consent: DeviceFileConsent): VFS {
  const exec = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    await transport.rpc('exec', [command]) as { stdout: string; stderr: string; exitCode: number };

  let cachedHome: string | null = null;
  const effectiveRoot = async (): Promise<string> => {
    const explicit = consent.consentedRoot();
    if (explicit) return explicit.length > 1 ? explicit.replace(/\/+$/, '') : explicit;
    if (cachedHome === null) {
      const r = await exec('printf %s "$HOME"');
      const home = r.exitCode === 0 ? r.stdout.trim() : '';
      if (!home.startsWith('/')) {
        throw makeVfsError('EACCES', 'cannot determine the consented device directory', '/');
      }
      cachedHome = home.length > 1 ? home.replace(/\/+$/, '') : home;
    }
    return cachedHome;
  };

  const guard = async (path: string, op: string): Promise<void> => {
    if (await consent.hasFullFilesystem()) return;
    const root = await effectiveRoot();
    if (path === root || root === '/' || path.startsWith(`${root}/`)) return;
    throw makeVfsError(
      'EACCES',
      `'${path}' is outside the consented device directory '${root}' — `
      + `grant this agent the full-filesystem consent tier to reach it, ${op} '${path}'`,
      path,
    );
  };

  /** Bytes that survive a utf-8 decode→encode round-trip byte-exactly may ride
   *  the text protocol; anything else must go base64 or it corrupts. */
  const asLosslessText = (bytes: Uint8Array): string | null => {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return null; }
  };

  return {
    async readFile(path, opts) {
      await guard(path, 'open');
      const raw = await transport.rpc('readFile', [path, { encoding: 'base64' }]);
      if (typeof raw === 'object' && raw !== null && (raw as { encoding?: unknown }).encoding === 'base64') {
        const bytes = base64ToBytes(String((raw as { content?: unknown }).content ?? ''));
        return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      }
      const text = String(raw);
      return opts?.encoding === 'utf8' ? text : new TextEncoder().encode(text);
    },

    async writeFile(path, data) {
      await guard(path, 'open');
      const text = typeof data === 'string' ? data : asLosslessText(data);
      const result = text !== null
        ? await transport.rpc('writeFile', [path, text])
        : await transport.rpc('writeFile', [path, bytesToBase64(data as Uint8Array), { encoding: 'base64' }]);
      const ok = result === 'ok'
        || (typeof result === 'object' && result !== null && (result as { success?: unknown }).success === true);
      if (!ok) throw new Error(`writeFile failed on the device: ${JSON.stringify(result)}`);
    },

    async readdir(path) {
      await guard(path, 'scandir');
      const entries = await transport.rpc('listFiles', [path]);
      if (!Array.isArray(entries)) throw new Error(`unexpected device listFiles result: ${JSON.stringify(entries)}`);
      return entries.map((e) =>
        typeof e === 'object' && e !== null && typeof (e as { name?: unknown }).name === 'string'
          ? (e as { name: string }).name
          : String(e));
    },

    async stat(path) {
      await guard(path, 'stat');
      const q = shellQuote(path);
      const r = await exec(`stat -c '%s %Y %F' ${q} 2>/dev/null || stat -f '%z %m %HT' ${q}`);
      if (r.exitCode !== 0) return null;
      return parseStatLine(r.stdout);
    },

    async unlink(path) {
      await guard(path, 'unlink');
      const r = await exec(`rm -- ${shellQuote(path)}`);
      if (r.exitCode !== 0) throw makeVfsError('EIO', `${r.stderr.trim() || 'operation failed'}, unlink '${path}'`, path);
    },

    async mkdir(path, opts) {
      await guard(path, 'mkdir');
      const r = await exec(`mkdir ${opts?.recursive ? '-p ' : ''}-- ${shellQuote(path)}`);
      if (r.exitCode !== 0) throw makeVfsError('EIO', `${r.stderr.trim() || 'operation failed'}, mkdir '${path}'`, path);
    },

    async exists(path) {
      await guard(path, 'stat');
      return Boolean(await transport.rpc('exists', [path]));
    },
  };
}
