/**
 * CloudflareSandbox — wraps the `@cloudflare/sandbox` SDK as a SandboxApi.
 *
 * The SDK's `getSandbox(env.Sandbox, agentId)` returns a stub with primitive
 * file/exec/port methods. This wrapper:
 *   • Implements the full SandboxApi surface (filling stat/exists/mkdir via
 *     listFiles + exec mkdir -p)
 *   • Routes exposePort through Proteus's path-style preview URL builder
 *     (https://<host>/_preview/<port>/<sandboxId>/<token>/) so we don't
 *     need wildcard DNS
 *   • Forwards listPorts/exposePort/unexposePort to the SDK
 *
 * The SDK's SandboxHandle is duck-typed to keep core dep-free; cf-backend
 * supplies the real `getSandbox()` result via runtime.ts.
 */

import type { SandboxApi, SandboxCapability, DirEntry, Stat, ShellResult, ExecOptions, PortInfo } from '../types.js';
import { SandboxError } from '../types.js';

/**
 * Subset of `@cloudflare/sandbox`'s SandboxStub we consume.
 * Mirrors the existing `SandboxHandle` in execution/sandbox.ts; kept here
 * so the new sandbox layer is self-contained.
 */
export interface CloudflareSandboxStub {
  exec(command: string, opts?: { cwd?: string; timeout?: number }):
    Promise<{ output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  readFile(path: string): Promise<{ content?: string; exitCode?: number }>;
  writeFile(path: string, content: string): Promise<unknown>;
  listFiles(path: string, opts?: { recursive?: boolean }): Promise<{
    files: Array<{ name?: string; path?: string; type?: string; size?: number; isDirectory?: boolean }>;
  }>;
  deleteFile(path: string): Promise<unknown>;
  exposePort(port: number, opts: { hostname: string; name?: string; token?: string }):
    Promise<{ url: string; port: number; name?: string }>;
  unexposePort(port: number): Promise<unknown>;
  getExposedPorts(hostname: string):
    Promise<Array<{ url: string; port: number; status?: string }>>;
}

export interface CloudflareSandboxDeps {
  /** Stable id (also the sandbox DO key). */
  id: string;
  stub: CloudflareSandboxStub;
  /** Public hostname for path-style preview URLs. If omitted, exposePort returns the SDK URL as-is. */
  previewHostname?: string;
}

function genPortToken(port: number): string {
  // Same scheme as execution/sandbox.ts to keep path-style URL semantics consistent.
  const rand = Math.random().toString(36).slice(2, 10);
  return `p${port}_${rand}`;
}

function buildProxyUrl(hostname: string, port: number, sandboxId: string, token: string): string {
  return `https://${hostname}/_preview/${port}/${sandboxId}/${token}/`;
}

function extractTokenFromSdkUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const dot = u.hostname.indexOf('.');
    if (dot === -1) return null;
    const subdomain = u.hostname.slice(0, dot);
    const lastHyphen = subdomain.lastIndexOf('-');
    if (lastHyphen === -1) return null;
    const token = subdomain.slice(lastHyphen + 1);
    return /^[a-z0-9_]+$/i.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function createCloudflareSandbox(deps: CloudflareSandboxDeps): SandboxApi {
  const { id, stub, previewHostname } = deps;

  let connected = false;

  const capabilities = new Set<SandboxCapability>([
    'shell', 'native_binary',
    'process_spawn', 'process_signal',
    'fs_persistent',
    'net_outbound', 'net_inbound',
  ]);

  // Cache mapping port → token so unexposePort and listPorts can reconstruct
  // path-style URLs without round-tripping through the SDK URL parser.
  const portTokens = new Map<number, string>();

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    // The SDK lazily starts the container on first call; a no-op exec is the
    // cheapest health check.
    try {
      await stub.exec(':', { timeout: 10_000 });
      connected = true;
    } catch (err) {
      throw new SandboxError(
        `Cloudflare sandbox unreachable: ${err instanceof Error ? err.message : String(err)}`,
        'not_available',
        err,
      );
    }
  }

  return {
    id,
    kind: 'cloudflare',
    capabilities,

    async connect() { await ensureConnected(); },
    async disconnect() {
      // SDK manages container lifecycle; explicit shutdown is rare. Drop our
      // local state so a subsequent op re-probes.
      connected = false;
    },
    isAvailable: () => true,

    async exec(command: string, options?: ExecOptions): Promise<ShellResult> {
      await ensureConnected();
      const t0 = Date.now();
      try {
        const r = await stub.exec(command, {
          cwd: options?.cwd,
          timeout: options?.timeout,
        });
        return {
          stdout: r.output ?? r.stdout ?? '',
          stderr: r.stderr ?? '',
          exitCode: r.exitCode ?? 0,
          durationMs: Date.now() - t0,
          aborted: options?.signal?.aborted ?? false,
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
      await ensureConnected();
      const r = await stub.readFile(path);
      if (r.exitCode != null && r.exitCode !== 0) {
        throw new SandboxError(`Read failed: ${path}`, 'not_found');
      }
      return r.content ?? '';
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      await ensureConnected();
      // Ensure parent dir exists.
      const dir = path.split('/').slice(0, -1).join('/');
      if (dir && dir !== '/') {
        await stub.exec(`mkdir -p ${shellQuote(dir)}`, { timeout: 5_000 }).catch(() => undefined);
      }
      const body = typeof content === 'string' ? content : new TextDecoder().decode(content);
      await stub.writeFile(path, body);
    },

    async readdir(path: string): Promise<DirEntry[]> {
      await ensureConnected();
      try {
        const r = await stub.listFiles(path, { recursive: false });
        return (r.files ?? []).map((f) => {
          const name = f.name ?? (f.path ? f.path.split('/').pop() ?? '' : '');
          const fullPath = f.path ?? (path.endsWith('/') ? path + name : path + '/' + name);
          const isDir = f.isDirectory ?? f.type === 'dir' ?? f.type === 'directory';
          return {
            name,
            path: fullPath,
            isDirectory: Boolean(isDir),
            size: isDir ? undefined : f.size,
          };
        });
      } catch (err) {
        throw new SandboxError(
          `readdir failed: ${err instanceof Error ? err.message : String(err)}`,
          'not_found',
          err,
        );
      }
    },

    async stat(path: string): Promise<Stat | null> {
      await ensureConnected();
      // No direct stat; use listFiles of the parent and find the entry.
      // For root, stat is trivial.
      if (path === '/' || path === '') {
        return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mtimeMs: 0 };
      }
      const parts = path.split('/').filter(Boolean);
      const name = parts[parts.length - 1];
      const parent = '/' + parts.slice(0, -1).join('/');
      try {
        const r = await stub.listFiles(parent, { recursive: false });
        const hit = (r.files ?? []).find((f) =>
          (f.name ?? f.path?.split('/').pop()) === name,
        );
        if (!hit) return null;
        const isDir = hit.isDirectory ?? hit.type === 'dir' ?? hit.type === 'directory';
        return {
          isFile: !isDir,
          isDirectory: Boolean(isDir),
          isSymbolicLink: false,
          size: hit.size ?? 0,
          mtimeMs: 0,
        };
      } catch {
        return null;
      }
    },

    async exists(path: string): Promise<boolean> {
      await ensureConnected();
      try {
        const r = await stub.exec(`test -e ${shellQuote(path)} && echo yes || echo no`, { timeout: 3_000 });
        return (r.output ?? r.stdout ?? '').trim() === 'yes';
      } catch {
        return false;
      }
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      await ensureConnected();
      const flag = options?.recursive === false ? '' : '-p ';
      const r = await stub.exec(`mkdir ${flag}${shellQuote(path)}`, { timeout: 5_000 });
      if ((r.exitCode ?? 0) !== 0) {
        throw new SandboxError(`mkdir failed: ${r.stderr ?? path}`, 'internal');
      }
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      await ensureConnected();
      try {
        if (options?.recursive) {
          const r = await stub.exec(`rm -rf ${shellQuote(path)}`, { timeout: 30_000 });
          if ((r.exitCode ?? 0) !== 0 && !options.force) {
            throw new SandboxError(`rm -rf failed: ${r.stderr ?? path}`, 'internal');
          }
          return;
        }
        await stub.deleteFile(path);
      } catch (err) {
        if (options?.force) return;
        throw err instanceof SandboxError
          ? err
          : new SandboxError(`rm failed: ${err instanceof Error ? err.message : String(err)}`, 'internal', err);
      }
    },

    // ── Ports ──────────────────────────────────────────────────────

    async listPorts(): Promise<PortInfo[]> {
      await ensureConnected();
      const ports = await stub.getExposedPorts(previewHostname ?? '');
      return (ports ?? []).map((p) => {
        const token = portTokens.get(p.port) ?? extractTokenFromSdkUrl(p.url) ?? '';
        const url = previewHostname && token
          ? buildProxyUrl(previewHostname, p.port, id, token)
          : p.url;
        return {
          port: p.port,
          url,
          status: (p.status as 'live' | 'starting' | 'unreachable' | undefined) ?? 'unknown',
        };
      });
    },

    async exposePort(port: number, options?: { name?: string }): Promise<PortInfo> {
      await ensureConnected();
      const token = genPortToken(port);
      portTokens.set(port, token);
      const r = await stub.exposePort(port, {
        hostname: previewHostname ?? 'sandbox.local',
        name: options?.name,
        token,
      });
      const url = previewHostname
        ? buildProxyUrl(previewHostname, port, id, token)
        : r.url;
      return { port, name: options?.name, url, status: 'starting' };
    },

    async unexposePort(port: number): Promise<void> {
      await ensureConnected();
      await stub.unexposePort(port);
      portTokens.delete(port);
    },
  };
}

/** Shell-quote a path so it's safe to interpolate into `bash -c`. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
