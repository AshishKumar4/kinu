/**
 * Mount adapters — thin VFS views over the executors' RAW handles.
 *
 * The load-bearing rule from the workspaces design: a mount's file view wraps
 * the raw handle (SandboxHandle, NimbusSandboxHandle, DeviceTransport), never
 * the executor's LLM tools — those return error STRINGS ("read error: …",
 * "d name" listings) and cannot satisfy a correct VFS. The codemode
 * sandbox.* / nimbus.* / laptop.* tool namespaces stay untouched: two
 * consumers of one raw handle.
 *
 * Paths arriving here are environment-NATIVE (CompositeVFS already mapped
 * the /sandbox|/nimbus|/pc prefix onto the environment root). Methods the
 * handles lack are synthesized honestly — stat from directory listings or
 * `stat(1)`, mkdir/unlink via exec — and unknowable fields (e.g. sandbox
 * mtime) are reported as 0, never invented.
 */

import type { VFS } from '../types/primitives.js';
import type { SandboxHandle } from '../execution/sandbox.js';
import type { NimbusSandboxHandle } from '../execution/nimbus.js';
import type { DeviceTransport } from '../execution/device-tunnel-executor.js';
import { makeVfsError, type VfsErrorCode } from './errno.js';
import { shellQuote } from '../utils/shell.js';
import { vfsDirname as dirname } from '../utils/vfs-helpers.js';
import { base64ToBytes, bytesToBase64 } from '../utils/base64.js';

type Stat = { size: number; mtimeMs: number; isDir: boolean } | null;

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function encodeUnlessUtf8(content: string, opts?: { encoding?: string }): Uint8Array | string {
  return opts?.encoding === 'utf8' ? content : new TextEncoder().encode(content);
}

/** Bytes that survive a utf-8 decode→encode round-trip byte-exactly may ride
 *  a text transport; anything else must go base64 or it corrupts. ignoreBOM
 *  keeps a leading BOM in the decoded text (the default decoder strips it —
 *  a silent 3-byte loss). */
function asLosslessText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ── /workspace — subordinate → parent workspace RPC ──────────────────────

/** Worker-side file handle implemented by the parent workspace agent. The
 * subordinate receives it through `parentAgent()`; the adapter keeps Durable
 * Object RPC details out of CompositeVFS and the rest of core. */
export interface ParentRpcError {
  code: VfsErrorCode;
  /** Original Error.message. It may already carry the conventional
   * `<code>: ` prefix; the adapter canonicalizes it when rehydrating. */
  message: string;
  path: string;
}

export type ParentRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ParentRpcError };

/** `write` is a closed command union so the worker RPC surface can implement
 * VFS.mkdir without a second mutation method. */
export type ParentRpcWrite =
  | { kind: 'file'; path: string; data: string | Uint8Array }
  | { kind: 'directory'; path: string; recursive: boolean };

export interface ParentRpcFileHandle {
  read(path: string): Promise<ParentRpcResult<Uint8Array>>;
  write(input: ParentRpcWrite): Promise<ParentRpcResult<null>>;
  list(path: string): Promise<ParentRpcResult<string[]>>;
  stat(path: string): Promise<ParentRpcResult<Stat>>;
  delete(path: string): Promise<ParentRpcResult<null>>;
}

function parentRpcErrorDetail(error: ParentRpcError): string {
  const prefix = `${error.code}:`;
  return error.message.startsWith(prefix)
    ? error.message.slice(prefix.length).trimStart()
    : error.message;
}

/** Durable VFS view over the parent workspace's `/local` SqliteFS. Paths are
 * already mount-relative when they reach this adapter. Mount it with
 * `rootPath: ''` so the mount root maps to SqliteFS's empty-string root. */
export function createParentRpcMountVFS(handle: ParentRpcFileHandle): VFS {
  const value = <T>(result: ParentRpcResult<T>): T => {
    if (result.ok) return result.value;
    throw makeVfsError(result.error.code, parentRpcErrorDetail(result.error), result.error.path);
  };
  return {
    async readFile(path, opts) {
      const content = value(await handle.read(path));
      return opts?.encoding === 'utf8' ? new TextDecoder().decode(content) : content;
    },
    async writeFile(path, data) {
      value(await handle.write({ kind: 'file', path, data }));
    },
    async readdir(path) {
      return value(await handle.list(path));
    },
    async stat(path) {
      return value(await handle.stat(path));
    },
    async unlink(path) {
      value(await handle.delete(path));
    },
    async mkdir(path, opts) {
      value(await handle.write({ kind: 'directory', path, recursive: opts?.recursive ?? false }));
    },
    async exists(path) {
      return value(await handle.stat(path)) !== null;
    },
  };
}

/** Map a shell failure to the errno its stderr describes. */
function classifyShellError(op: string, path: string, stderr: string): ReturnType<typeof makeVfsError> {
  const code = /no such file/i.test(stderr) ? 'ENOENT'
    : /file exists/i.test(stderr) ? 'EEXIST'
    : /is a directory/i.test(stderr) ? 'EISDIR'
    : /not a directory/i.test(stderr) ? 'ENOTDIR'
    : /permission denied/i.test(stderr) ? 'EACCES'
    : 'EIO';
  return makeVfsError(code, `${stderr.trim() || 'operation failed'}, ${op} '${path}'`, path);
}

// ── /sandbox — @cloudflare/sandbox container ───────────────────────────────

/**
 * VFS over the raw SandboxHandle. The handle has no stat/mkdir: stat is
 * synthesized from listFiles on the parent (size + type; the SDK reports no
 * mtime, so mtime is 0), mkdir/exists via exec. Binary content rides the
 * SDK's base64 encoding both ways (the SDK flags binary reads itself), so
 * bytes round-trip exactly.
 */
export function createSandboxMountVFS(handle: SandboxHandle): VFS {
  const entryIsDir = (f: { type?: string; isDirectory?: boolean }): boolean =>
    f.isDirectory ?? (f.type === 'directory' || f.type === 'dir');
  const entryName = (f: { name?: string; path?: string }): string =>
    f.name ?? basename(f.path ?? '');

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
      return encodeUnlessUtf8(r.content ?? '', opts);
    },

    async writeFile(path, data) {
      if (typeof data === 'string') {
        await handle.writeFile(path, data);
      } else {
        await handle.writeFile(path, bytesToBase64(data), { encoding: 'base64' });
      }
    },

    async readdir(path) {
      const r = await handle.listFiles(path, { recursive: false });
      return (r.files ?? []).map(entryName).filter((n) => n.length > 0);
    },

    async stat(path): Promise<Stat> {
      if (path === '/') return { size: 0, mtimeMs: 0, isDir: true };
      const name = basename(path);
      let files: Awaited<ReturnType<SandboxHandle['listFiles']>>['files'];
      try {
        files = (await handle.listFiles(dirname(path), { recursive: false })).files ?? [];
      } catch {
        return null; // parent unreadable/missing — nothing to describe
      }
      const entry = files.find((f) => entryName(f) === name);
      if (!entry) return null;
      return { size: entry.size ?? 0, mtimeMs: 0, isDir: entryIsDir(entry) };
    },

    async unlink(path) {
      await handle.deleteFile(path);
    },

    async mkdir(path, opts) {
      const flag = opts?.recursive ? '-p ' : '';
      const r = await handle.exec(`mkdir ${flag}-- ${shellQuote(path)}`);
      if ((r.exitCode ?? 0) !== 0) throw classifyShellError('mkdir', path, r.stderr ?? r.output ?? '');
    },

    async exists(path) {
      const r = await handle.exec(`test -e ${shellQuote(path)} && echo true || echo false`);
      return (r.stdout ?? r.output ?? '').includes('true');
    },
  };
}

// ── /nimbus — Nimbus sandbox ───────────────────────────────────────────────

/**
 * VFS over the raw NimbusSandboxHandle — the cleanest handle
 * (read/readBytes/write/list/exists/mkdir/delete; write takes Uint8Array
 * natively, so binary round-trips exactly). stat is synthesized via
 * `stat(1)` (Linux environment), which yields real size + mtime.
 */
export function createNimbusMountVFS(box: NimbusSandboxHandle): VFS {
  return {
    async readFile(path, opts) {
      if (opts?.encoding !== 'utf8' && box.files.readBytes) {
        const bytes = await box.files.readBytes(path);
        if (bytes === null) throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);
        return bytes;
      }
      const content = await box.files.read(path);
      if (content === null) throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);
      return encodeUnlessUtf8(content, opts);
    },

    async writeFile(path, data) {
      await box.files.write(path, data);
    },

    async readdir(path) {
      const entries = await box.files.list(path);
      return entries.map((e) => e.name);
    },

    async stat(path): Promise<Stat> {
      const r = await box.exec(`stat -c '%s %Y %F' ${shellQuote(path)}`);
      if (!r.success || r.exitCode !== 0) return null;
      return parseStatLine(r.stdout);
    },

    async unlink(path) {
      // No `recursive` — unlink is file-scoped, exactly like POSIX.
      await box.files.delete(path);
    },

    async mkdir(path, opts) {
      if (box.files.mkdir) {
        await box.files.mkdir(path);
        return;
      }
      const flag = opts?.recursive ? '-p ' : '';
      const r = await box.exec(`mkdir ${flag}-- ${shellQuote(path)}`);
      if (!r.success || r.exitCode !== 0) throw classifyShellError('mkdir', path, r.stderr);
    },

    async exists(path) {
      return box.files.exists(path);
    },
  };
}

// ── /pc — the user's device over the daemon transport ─────────────────────

/**
 * Consent boundary of the /pc mount. The mount exposes the device's REAL root
 * (faithful window), but by default only the consented subtree — the device
 * connect dir, falling back to the device home — is reachable. Anything
 * outside it needs the stronger 'full_filesystem' consent tier.
 */
export interface DeviceMountConsent {
  /** The consented subtree (the device connect dir), or null to fall back to
   *  the device's home directory. */
  consentedRoot(): string | null;
  /** Whether this agent holds the full-filesystem consent tier. */
  hasFullFilesystem(): Promise<boolean>;
}

interface DeviceExecResult { stdout: string; stderr: string; exitCode: number }

/**
 * VFS over the raw DeviceTransport (JSON-RPC to the user's daemon). The
 * daemon speaks readFile/writeFile/listFiles/exists natively; stat, mkdir and
 * unlink are synthesized via exec (portable GNU-then-BSD `stat`). Every call
 * still crosses the hub's per-(agent, device) action-consent chokepoint; this
 * adapter adds the path-scope layer on top.
 */
export function createDeviceMountVFS(transport: DeviceTransport, consent: DeviceMountConsent): VFS {
  const exec = async (command: string): Promise<DeviceExecResult> =>
    await transport.rpc('exec', [command]) as DeviceExecResult;

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
      `'${path}' is outside the consented device directory '${root}' — ` +
      `grant this agent the full-filesystem consent tier to reach it, ${op} '${path}'`,
      path,
    );
  };

  return {
    async readFile(path, opts) {
      await guard(path, 'open');
      // A daemon that speaks base64 answers { content, encoding: 'base64' };
      // an older daemon ignores the option and answers plain utf-8 text —
      // the response shape says which happened.
      const raw = await transport.rpc('readFile', [path, { encoding: 'base64' }]);
      if (typeof raw === 'object' && raw !== null && (raw as { encoding?: unknown }).encoding === 'base64') {
        const bytes = base64ToBytes(String((raw as { content?: unknown }).content ?? ''));
        return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      }
      return encodeUnlessUtf8(String(raw), opts);
    },

    async writeFile(path, data) {
      await guard(path, 'open');
      // Text (or utf-8-lossless bytes) rides the plain string protocol every
      // daemon speaks; genuinely binary bytes go base64 — never a lossy
      // TextDecoder pass.
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

    async stat(path): Promise<Stat> {
      await guard(path, 'stat');
      const q = shellQuote(path);
      // GNU stat (Linux), falling back to BSD stat (macOS).
      const r = await exec(`stat -c '%s %Y %F' ${q} 2>/dev/null || stat -f '%z %m %HT' ${q}`);
      if (r.exitCode !== 0) return null;
      return parseStatLine(r.stdout);
    },

    async unlink(path) {
      await guard(path, 'unlink');
      const r = await exec(`rm -- ${shellQuote(path)}`);
      if (r.exitCode !== 0) throw classifyShellError('unlink', path, r.stderr);
    },

    async mkdir(path, opts) {
      await guard(path, 'mkdir');
      const flag = opts?.recursive ? '-p ' : '';
      const r = await exec(`mkdir ${flag}-- ${shellQuote(path)}`);
      if (r.exitCode !== 0) throw classifyShellError('mkdir', path, r.stderr);
    },

    async exists(path) {
      await guard(path, 'stat');
      return Boolean(await transport.rpc('exists', [path]));
    },
  };
}

/** Parse `<size> <mtime-seconds> <type words>` from stat(1) output. */
function parseStatLine(stdout: string): Stat {
  const m = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!m) return null;
  return { size: Number(m[1]), mtimeMs: Number(m[2]) * 1000, isDir: /directory/i.test(m[3]) };
}
