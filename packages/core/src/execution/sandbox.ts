/**
 * SandboxExecutor — @cloudflare/sandbox-backed executor.
 *
 * Each agent gets its own Linux container via a Sandbox DO. The orchestrator
 * passes a SandboxHandle (duck-typed here so core stays dep-free) obtained
 * from `getSandbox(env.SANDBOX, agentId)`.
 *
 * Namespace inside codemode sandbox: `sandbox.*`
 *   sandbox.exec("npm test")
 *   sandbox.readFile("/workspace/app.ts")
 *   sandbox.writeFile("/workspace/util.ts", code)
 *   sandbox.listFiles("/workspace")
 *   sandbox.deleteFile("/workspace/tmp.txt")
 *   sandbox.exposePort(3000, { name: "dev" })
 *   sandbox.unexposePort(3000)
 *   sandbox.listPorts()
 */

import * as v from 'valibot';
import { isAbortError, raceAbort } from '@proteus/agent-utils';
import type { ExecutorProvider, ExecutorCapability } from './types.js';
import { readExecSignal } from './signal.js';
import { formatExecResult } from './exec-result.js';
import type { VFS } from '../types/primitives.js';
import { makeVfsError } from '../vfs/errno.js';
import { shellQuote } from '../utils/shell.js';
import { vfsDirname } from '../utils/vfs-helpers.js';
import { base64ToBytes, bytesToBase64 } from '../utils/base64.js';
import type { JsonValue } from '../utils/json.js';

interface SandboxExposeOptions {
  hostname: string;
  name?: string;
}

/**
 * Duck-typed handle — matches the subset of @cloudflare/sandbox's getSandbox()
 * return value we consume. Core accepts `unknown`-typed handles and narrows
 * here, so cf-backend can supply the real thing without core having a
 * package dependency.
 *
 * The SDK's `exposePort` enables in-container port forwarding, stores a secret
 * token in DO storage, and returns the preview URL it serves that port on:
 * `https://<port>-<sandbox>-<token>.<previewHostSuffix>`. Proteus hands that
 * URL straight through — the Worker routes it back with the SDK's own
 * `proxyToSandbox` (packages/cf-backend/src/preview-proxy.ts).
 */
export interface SandboxHandle {
  exec(command: string, opts?: { cwd?: string; timeout?: number }):
    Promise<{ output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  /** The SDK auto-detects binary files and returns their content base64-
   *  encoded with `encoding: 'base64'`; text comes back as plain utf-8. */
  readFile(path: string, opts?: { encoding?: 'utf-8' | 'base64' }):
    Promise<{ content?: string; encoding?: string; isBinary?: boolean; exitCode?: number }>;
  /** Pass `encoding: 'base64'` to write binary content byte-exactly. */
  writeFile(path: string, content: string, opts?: { encoding?: 'utf-8' | 'base64' }): Promise<JsonValue | void>;
  listFiles(path: string, opts?: { recursive?: boolean }):
    Promise<{ files: Array<{ name?: string; path?: string; type?: string; size?: number; isDirectory?: boolean }> }>;
  deleteFile(path: string): Promise<JsonValue | void>;
  /** Expose a port; `hostname` is the suffix the returned preview URL is built on. */
  exposePort(port: number, opts: { hostname: string; name?: string }):
    Promise<{ url: string; port: number; name?: string }>;
  unexposePort(port: number): Promise<JsonValue | void>;
  /** SDK method is `getExposedPorts(hostname)`; `hostname` builds each row's `url`. */
  getExposedPorts(hostname: string):
    Promise<Array<{ url: string; port: number; name?: string; status?: string }>>;
  /** Snapshot a directory to R2 (squashfs). Returns a small serializable handle
   *  to store and later pass to restoreBackup. (SDK createBackup.) */
  createBackup(opts: BackupOptions): Promise<DirectoryBackup>;
  /** Restore a previously-created backup into its directory. (SDK restoreBackup.) */
  restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult>;
}

/** Options for SandboxHandle.createBackup (subset of the SDK's BackupOptions). */
export interface BackupOptions {
  /** Absolute directory to back up (e.g. '/workspace'). */
  dir: string;
  /** Move bytes via the BACKUP_BUCKET R2 binding directly (no presigned creds). */
  localBucket?: boolean;
  /** Honor .gitignore when archiving. */
  gitignore?: boolean;
  /** Wildcard excludes passed to mksquashfs (e.g. ['node_modules','*.log']). */
  excludes?: readonly string[];
  /** Backup lifetime in seconds (enforced on restore). */
  ttl?: number;
  /** Optional label. */
  name?: string;
}

/** Serializable backup handle — store it, pass it back to restoreBackup. */
export interface DirectoryBackup {
  readonly id: string;
  readonly dir: string;
  readonly localBucket?: boolean;
}

export interface RestoreBackupResult {
  readonly success: boolean;
  readonly dir: string;
  readonly id: string;
}

// ── /workspace backup policy (pure; the orchestrator owns the I/O) ──

export const WORKSPACE_BACKUP_DIR = '/workspace';
/** Min gap between /workspace backups — debounces per-turn mksquashfs storms. */
export const BACKUP_MIN_INTERVAL_MS = 60_000;
/** Backup lifetime (R2). 30 days — pair with an R2 lifecycle GC rule. */
export const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const WORKSPACE_BACKUP_EXCLUDES = ['node_modules', '.git', '*.log', '.cache'] as const;

/** Back up only when the sandbox was used this turn AND the debounce window has
 *  elapsed since the last successful backup. Pure → unit-testable. */
export function shouldBackupWorkspace(
  usedSandbox: boolean,
  lastBackupAt: number,
  now: number,
  minIntervalMs: number = BACKUP_MIN_INTERVAL_MS,
): boolean {
  return usedSandbox && now - lastBackupAt >= minIntervalMs;
}

/** Canonical createBackup options for /workspace (localBucket + excludes). */
export function workspaceBackupOptions(): BackupOptions {
  return {
    dir: WORKSPACE_BACKUP_DIR,
    localBucket: true,
    gitignore: true,
    excludes: WORKSPACE_BACKUP_EXCLUDES,
    ttl: BACKUP_TTL_SECONDS,
  };
}

const NOT_CONFIGURED =
  'Sandbox executor not configured. Add the @cloudflare/sandbox binding ' +
  'and Container to wrangler.jsonc (see docs/EXECUTION-LAYER-SPEC.md).';

const PREVIEWS_NOT_CONFIGURED =
  'Sandbox previews are off: PREVIEW_HOST_SUFFIX is unset, so there is no zone to mint preview ' +
  'hostnames on. Turning them on takes a proxied wildcard DNS record and a matching route on a zone; ' +
  'the PREVIEW_HOST_SUFFIX note in wrangler.jsonc has both steps. Exec and files still work.';

/**
 * Substring markers (lower-cased) for transient sandbox/RPC errors that the
 * SDK either auto-retries via 503 or does NOT retry at all (mid-request 500
 * with body 'Container suddenly disconnected, try again' — see
 * @cloudflare/containers/dist/lib/container.js:947-948). Cross-DO RPC drops
 * surface as 'Network connection lost.' before the SDK ever runs. We retry
 * any of these once with exponential-ish backoff. (STABILITY-AUDIT §B2/§B3.)
 */
const TRANSIENT_MARKERS = [
  'network connection lost',
  'container suddenly disconnected',
  'container is starting',
  'no container instance',
  'internal error in durable object storage caused object to be reset',
  // 0.8.11 SDK started classifying this as transient; cover us either way:
  'http error! status: 500',
];

function errorMessage(input: { error: unknown }): string {
  return input.error instanceof Error ? input.error.message : String(input.error);
}

function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: { value: unknown },
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);
  return result.success ? result.output : undefined;
}

const StringSchema = v.string();
const OptionalStringSchema = v.optional(v.string());
const PortSchema = v.pipe(v.number(), v.minValue(1), v.maxValue(65535));

export function isSandboxTransientError(error: Error | string): boolean {
  const msg = (error instanceof Error ? error.message : error).toLowerCase();
  return TRANSIENT_MARKERS.some(m => msg.includes(m));
}

/**
 * Run `fn` with up to `attempts` total tries, retrying only on transient
 * errors. Backoff: 500ms, 1000ms (i.e. 500ms × 2^attempt). Non-transient
 * errors throw immediately. Used to swallow the brief disconnect window
 * during container/DO eviction without forcing the agent to error-handle.
 * Exported for other consumers of the same raw handle (release exec).
 */
export async function withSandboxRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isSandboxTransientError(err instanceof Error ? err : String(err)) || i === attempts - 1) {
        throw err;
      }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function normalize(res: { output?: string; stdout?: string; stderr?: string; exitCode?: number }): string {
  // @cloudflare/sandbox returns { stdout, stderr, exitCode }; older versions
  // returned { output, exitCode }. Accept both.
  return formatExecResult({ ...res, stdout: res.stdout ?? res.output ?? '' });
}

/**
 * Build an ExecutorProvider from a live SandboxHandle.
 * Pass `undefined` to get a "not configured" stub that appears in the UI's
 * Not-configured footer without breaking the router.
 *
 * @param handle             SDK `getSandbox()` result.
 * @param previewHostSuffix  `env.PREVIEW_HOST_SUFFIX` — the zone previews are
 *                           served under; the SDK builds every preview URL on
 *                           it. Optional: without it exec/files work in full
 *                           and only the port-exposure surface refuses, with
 *                           the preview-specific reason.
 */
export function createSandboxExecutor(
  handle?: SandboxHandle,
  previewHostSuffix?: string,
): ExecutorProvider {
  const connected = handle != null;
  const previews = previewHostSuffix !== undefined && previewHostSuffix.length > 0;
  let active = false;
  const touch = async <T>(fn: () => Promise<T>): Promise<T> => {
    active = true;
    return fn();
  };

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Run a shell command in the sandbox container.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) return 'exec error: command must be a string';
        const signal = readExecSignal({ context: args[1] });
        try {
          // The sandbox SDK has no kill for an in-flight exec — abort stops
          // the wait; the container-side command runs to its own timeout.
          const res = await raceAbort(
            () => withSandboxRetry(() => touch(() => handle.exec(command, { timeout: 60_000 }))),
            signal,
            'sandbox exec aborted — the command may still finish inside the container',
          );
          return normalize(res);
        } catch (err) {
          if (isAbortError(err)) throw err;
          return `exec error: ${errorMessage({ error: err })}`;
        }
      },
    },
    readFile: {
      description: 'Read a file from the sandbox.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return 'read error: path must be a string';
        try {
          const r = await withSandboxRetry(() => touch(() => handle.readFile(path)));
          if (r.exitCode && r.exitCode !== 0) return `read error: exit ${r.exitCode}`;
          return r.content ?? '';
        } catch (err) {
          return `read error: ${errorMessage({ error: err })}`;
        }
      },
    },
    writeFile: {
      description: 'Write content to a file in the sandbox. Creates parent dirs.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        const content = parseInput(StringSchema, { value: args[1] });
        if (path === undefined) return 'write error: path must be a string';
        if (content === undefined) return 'write error: content must be a string';
        try {
          await withSandboxRetry(() => touch(() => handle.writeFile(path, content)));
          return `wrote ${path}`;
        } catch (err) {
          return `write error: ${errorMessage({ error: err })}`;
        }
      },
    },
    listFiles: {
      description: 'List files in a directory. Returns newline-separated entries prefixed "d" or "-".',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        const path = parseInput(OptionalStringSchema, { value: args[0] });
        if (args[0] !== undefined && path === undefined) return 'list error: path must be a string';
        try {
          const r = await withSandboxRetry(() => touch(() => handle.listFiles(path ?? '/', { recursive: false })));
          if (!r?.files?.length) return '';
          return r.files
            .map(f => {
              const name = f.name ?? f.path ?? '';
              const isDir = f.isDirectory ?? f.type === 'directory';
              return `${isDir ? 'd' : '-'} ${name}`;
            })
            .join('\n');
        } catch (err) {
          return `list error: ${errorMessage({ error: err })}`;
        }
      },
    },
    readdir: {
      description: 'Alias for listFiles — list entries in a directory.',
      execute: async (...args: unknown[]): Promise<string> => {
        return v.parse(v.string(), await tools.listFiles.execute(args[0]));
      },
    },
    deleteFile: {
      description: 'Delete a file or directory.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return 'delete error: path must be a string';
        try {
          await withSandboxRetry(() => touch(() => Promise.resolve(handle.deleteFile(path))));
          return `deleted ${path}`;
        } catch (err) {
          return `delete error: ${errorMessage({ error: err })}`;
        }
      },
    },
    exists: {
      description: 'Check if a path exists — uses shell test.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) return 'false';
        const res = await withSandboxRetry(() => touch(() => handle.exec(`test -e ${JSON.stringify(path)} && echo true || echo false`)));
        const out = (res.stdout ?? res.output ?? '').trim();
        return out.includes('true') ? 'true' : 'false';
      },
    },
    exposePort: {
      description:
        'Expose a TCP port from the sandbox and return the public preview URL. ' +
        'PRE-REQUISITE: a server must already be listening on the port BEFORE you call this. ' +
        'The call verifies the port is responsive (HTTP HEAD against localhost) and returns a ' +
        'clear error if nothing is listening — at which point start your server first ' +
        '(e.g. `nohup python3 -m http.server <port> --directory /workspace/<app> > /tmp/srv.log 2>&1 &` ' +
        'for static sites, or `nohup node server.js > /tmp/srv.log 2>&1 &` for Node) and retry.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        if (!previewHostSuffix) return PREVIEWS_NOT_CONFIGURED;
        const p = parseInput(PortSchema, { value: args[0] });
        const name = parseInput(OptionalStringSchema, { value: args[1] });
        if (p === undefined) {
          return `expose error: invalid port ${String(args[0])}`;
        }
        // Pre-flight: verify a server is listening on the port inside the
        // container. Without this we hand back a preview URL that 502s
        // because nothing answers — the failure mode the agent (and user)
        // actually hit. We try HEAD then GET; either responding (any HTTP
        // status, even 4xx/5xx) means a server is up. Connection refused
        // means no listener.
        try {
          const probe = await withSandboxRetry(() => touch(() => handle.exec(
            `curl -sS -o /dev/null -m 3 -w '%{http_code}|%{exitcode}' --connect-timeout 2 ` +
            `--head http://127.0.0.1:${p}/ 2>&1 || true`,
          )));
          const out = (probe.stdout ?? probe.output ?? '').toString().trim();
          // Parse "<code>|<exit>" where exit=7 (CURLE_COULDNT_CONNECT) means
          // nothing is listening. Any non-zero HTTP code means a server
          // answered — even a 404 or 503 counts.
          const [codeStr, exitStr] = out.split('|');
          const httpCode = parseInt(codeStr ?? '0', 10);
          const curlExit = parseInt(exitStr ?? '0', 10);
          if (curlExit === 7 || httpCode === 0) {
            return (
              `expose error: nothing is listening on port ${p} inside the sandbox. ` +
              `Start your server FIRST, then call sandbox.exposePort. Examples:\n` +
              `  • Static site (HTML/CSS/JS): ` +
              `await sandbox.exec("cd /workspace/<app-dir> && nohup python3 -m http.server ${p} > /tmp/srv-${p}.log 2>&1 &")\n` +
              `  • Node:                       ` +
              `await sandbox.exec("cd /workspace/<app-dir> && nohup node server.js > /tmp/srv-${p}.log 2>&1 &")\n` +
              `Then wait ~1s (await new Promise(r=>setTimeout(r,1000))) and call sandbox.exposePort(${p}) again.`
            );
          }
        } catch (err) {
          // Probe failed for a non-listener reason (sandbox exec errored).
          // Continue — the SDK exposePort call below will surface its own
          // error if exposure can't be set up; we don't want to gate the
          // happy path on a probe glitch.
          console.warn(`[sandbox.exposePort] port probe failed (continuing): ${errorMessage({ error: err })}`);
        }
        try {
          const opts: SandboxExposeOptions = { hostname: previewHostSuffix };
          if (name != null) opts.name = String(name);
          const exposed = await withSandboxRetry(() => touch(() => handle.exposePort(p, opts)));
          return exposed.url;
        } catch (err) {
          return `expose error: ${errorMessage({ error: err })}`;
        }
      },
    },
    unexposePort: {
      description: 'Stop exposing a port.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        const port = parseInput(PortSchema, { value: args[0] });
        if (port === undefined) return `unexpose error: invalid port ${String(args[0])}`;
        try {
          await withSandboxRetry(() => touch(() => Promise.resolve(handle.unexposePort(port))));
          return `unexposed ${port}`;
        } catch (err) {
          return `unexpose error: ${errorMessage({ error: err })}`;
        }
      },
    },
    listPorts: {
      description: 'List currently exposed ports. Returns JSON array of {port,url,status}.',
      execute: async (): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        if (!previewHostSuffix) return PREVIEWS_NOT_CONFIGURED;
        try {
          // SDK method is getExposedPorts — the tool we expose is still
          // named listPorts for backward compat with the codemode namespace.
          const ports = await withSandboxRetry(() => touch(() => handle.getExposedPorts(previewHostSuffix)));
          return JSON.stringify((ports ?? []).map(p => ({ port: p.port, status: p.status, url: p.url })));
        } catch (err) {
          return `listPorts error: ${errorMessage({ error: err })}`;
        }
      },
    },
  };

  const types = `
/**
 * sandbox — @cloudflare/sandbox Linux container, one per agent.
 */
declare namespace sandbox {
  function exec(command: string): Promise<string>;
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  function listFiles(path: string): Promise<string>;
  function readdir(path: string): Promise<string>;
  function deleteFile(path: string): Promise<string>;
  function exists(path: string): Promise<'true'|'false'>;
  function exposePort(port: number, name?: string): Promise<string>;
  function unexposePort(port: number): Promise<string>;
  function listPorts(): Promise<string>;
}
`.trim();

  const capabilities: ExecutorCapability[] = [
    'shell', 'npm', 'git', 'docker', 'process_spawn', 'process_long',
    'net_inbound', 'net_outbound', 'fs_owned',
  ];

  return {
    name: 'sandbox',
    kind: 'sandbox',
    files: handle ? sandboxFiles(handle) : undefined,
    homeDir: async () => WORKSPACE_BACKUP_DIR,
    capabilities: new Set(capabilities),
    isAvailable: () => connected,
    getStatus: () => ({
      configured: connected,
      available: connected,
      active,
      status: connected ? (active ? 'active' : 'idle') : 'not_configured',
      // An available sandbox with previews off carries the preview reason so
      // surfaces that hand out preview URLs can say so before anyone tries.
      ...(connected ? (previews ? {} : { reason: PREVIEWS_NOT_CONFIGURED }) : { reason: NOT_CONFIGURED }),
    }),
    connect: async () => { /* sandbox starts on first RPC */ },
    disconnect: async () => { /* The sandbox DO persists, but its CONTAINER
      filesystem does NOT — the container sleeps after ~10m idle and /workspace
      is lost. Durability is provided by the orchestrator's backup/restore of
      /workspace to R2 (createBackup/restoreBackup), not by this no-op close. */ },
    tools,
    types,
    positionalArgs: true,

    // ── Generic ExecutorProvider port surface ────────────────────
    //
    // Mirrors the namespaced `sandbox.exposePort` codemode tool, but at
    // the ExecutorProvider abstraction so any caller can ask any executor
    // to expose a port without knowing it's "sandbox" specifically.
    async exposePort(port, opts) {
      if (!handle) return { supported: false, reason: NOT_CONFIGURED };
      if (!previewHostSuffix) return { supported: false, reason: PREVIEWS_NOT_CONFIGURED };
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        return { supported: false, reason: `invalid port ${port}` };
      }
      // Pre-flight: verify a server is responsive on the port. Without
      // this the caller gets a preview URL that 502s.
      let verified_listening = false;
      try {
        const probe = await withSandboxRetry(() => touch(() => handle.exec(
          `curl -sS -o /dev/null -m 3 -w '%{http_code}|%{exitcode}' --connect-timeout 2 ` +
          `--head http://127.0.0.1:${port}/ 2>&1 || true`,
        )));
        const out = (probe.stdout ?? probe.output ?? '').toString().trim();
        const [codeStr, exitStr] = out.split('|');
        const httpCode = parseInt(codeStr ?? '0', 10);
        const curlExit = parseInt(exitStr ?? '0', 10);
        if (curlExit === 7 || httpCode === 0) {
          return {
            supported: false,
            reason:
              `nothing is listening on port ${port} inside the sandbox. ` +
              `Start a server first (e.g. \`nohup python3 -m http.server ${port} --directory /workspace/<app> > /tmp/srv-${port}.log 2>&1 &\` for static sites, ` +
              `or \`nohup node server.js > /tmp/srv-${port}.log 2>&1 &\` for Node), wait ~1s for it to bind, then call exposePort again.`,
          };
        }
        verified_listening = true;
      } catch {
        // Probe glitch — proceed; SDK call will surface its own error.
      }
      try {
        const sdkOpts: SandboxExposeOptions = { hostname: previewHostSuffix };
        if (opts?.name) sdkOpts.name = opts.name;
        const exposed = await withSandboxRetry(() => touch(() => handle.exposePort(port, sdkOpts)));
        return {
          supported: true,
          url: exposed.url,
          port,
          name: opts?.name,
          verified_listening,
        };
      } catch (err) {
        return { supported: false, reason: errorMessage({ error: err }) };
      }
    },

    async unexposePort(port) {
      if (!handle) return;
      try { await withSandboxRetry(() => touch(() => Promise.resolve(handle.unexposePort(Number(port))))); }
      catch { /* idempotent */ }
    },

    async listExposedPorts() {
      if (!handle || !previewHostSuffix) return [];
      const ports = await withSandboxRetry(() => touch(() => handle.getExposedPorts(previewHostSuffix)));
      return (ports ?? []).map(p => ({
        port: p.port,
        url: p.url,
        name: p.name,
        status: 'unknown' as const,
      }));
    },
  };
}

/**
 * The container's files, in the container's own absolute paths.
 *
 * Over the raw SDK handle, which has no stat and no mkdir: stat is synthesized
 * from a listing of the parent (size + type; the SDK reports no mtime, so mtime
 * is 0, never invented), and mkdir/exists go through the container's shell.
 * Binary content rides the SDK's base64 encoding both ways — the SDK flags a
 * binary read itself — so bytes round-trip exactly.
 */
export function sandboxFiles(handle: SandboxHandle): VFS {
  const isDir = (f: { type?: string; isDirectory?: boolean }): boolean =>
    f.isDirectory ?? (f.type === 'directory' || f.type === 'dir');
  const nameOf = (f: { name?: string; path?: string }): string => {
    const p = f.name ?? f.path ?? '';
    return p.slice(p.lastIndexOf('/') + 1);
  };

  return {
    async readFile(path, opts) {
      const r = await handle.readFile(path);
      if (r.exitCode != null && r.exitCode !== 0) {
        throw makeVfsError('ENOENT', `no such file or directory, open '${path}' (exit ${r.exitCode})`, path);
      }
      if (r.encoding === 'base64') {
        const bytes = base64ToBytes(r.content ?? '');
        return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      }
      const text = r.content ?? '';
      return opts?.encoding === 'utf8' ? text : new TextEncoder().encode(text);
    },

    async writeFile(path, data) {
      if (v.is(v.string(), data)) await handle.writeFile(path, data);
      else await handle.writeFile(path, bytesToBase64(data), { encoding: 'base64' });
    },

    async readdir(path) {
      const r = await handle.listFiles(path, { recursive: false });
      return (r.files ?? []).map(nameOf).filter((n) => n.length > 0);
    },

    async stat(path) {
      if (path === '/') return { size: 0, mtimeMs: 0, isDir: true };
      const name = path.slice(path.lastIndexOf('/') + 1);
      let files: Awaited<ReturnType<SandboxHandle['listFiles']>>['files'];
      try {
        files = (await handle.listFiles(vfsDirname(path), { recursive: false })).files ?? [];
      } catch {
        return null; // parent unreadable/missing — nothing to describe
      }
      const entry = files.find((f) => nameOf(f) === name);
      if (!entry) return null;
      return { size: entry.size ?? 0, mtimeMs: 0, isDir: isDir(entry) };
    },

    async unlink(path) { await handle.deleteFile(path); },

    async mkdir(path, opts) {
      const r = await handle.exec(`mkdir ${opts?.recursive ? '-p ' : ''}-- ${shellQuote(path)}`);
      if ((r.exitCode ?? 0) !== 0) {
        throw makeVfsError('EIO', `${(r.stderr ?? r.output ?? '').trim() || 'operation failed'}, mkdir '${path}'`, path);
      }
    },

    async exists(path) {
      const r = await handle.exec(`test -e ${shellQuote(path)} && echo true || echo false`);
      return (r.stdout ?? r.output ?? '').includes('true');
    },
  };
}
