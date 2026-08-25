/**
 * The file manager's read/write surface — one executor at a time.
 *
 * Each executor carries its OWN file view over its OWN raw handle
 * (`ExecutorProvider.files`), in that environment's native paths: the workspace
 * is Nimbus, the sandbox is its container, `laptop` is the user's machine. The
 * browser shows them one row at a time, never merged. (The AGENT-facing merge
 * is the workspace plane's mount table, `vfs/mounts.ts` — a different surface
 * with a different reader; nothing here rewrites one environment's paths into
 * another's namespace.)
 *
 * Errors are values here, not throws: a browser asking for a path on an offline
 * environment wants the reason rendered in the pane, not a failed RPC.
 */

import { normalizePath } from '@kinu.run/agent-utils';
import { removeTreeWithVfsOps, type VfsNativeMutations } from '../vfs/mounts';
import type { VFS } from '../types/primitives';
import { renderThrownChain } from '../obs/index';
import { PLATFORM_CATALOG } from '../platform-catalog';

/** Just enough of the router to find one executor's files, and to ask that
 *  environment where its own relative paths resolve. */
export interface ExecutorFileLookup {
  getProvider(name: string): { files?: VFS; homeDir(): Promise<string> } | undefined;
}

/**
 * One environment as the file browser lists it — the executor's own row, with
 * live state and how durable its filesystem is.
 *
 * `consistency` is the property a user has to know before writing anywhere:
 * `durable` survives everything, `ephemeral` dies with the container,
 * `live-shared` IS the user's own machine.
 */
export interface EnvironmentInfo {
  name: string;
  /** How the environment is addressed in its own namespace, e.g. `sandbox.*`. */
  prefix: string;
  live: boolean;
  policy: { readOnly: boolean; consistency: 'durable' | 'ephemeral' | 'live-shared' };
  /** Why it is listed but not reachable; null when it is. */
  reason: string | null;
}

/** The name the workspace UI imports this row set by. */
export type MountInfo = EnvironmentInfo;

interface RuntimeConsistency {
  [runtime: string]: EnvironmentInfo['policy']['consistency'];
}

const CONSISTENCY: RuntimeConsistency = {
  workspace: 'durable', parent: 'durable', sandbox: 'ephemeral', nimbus: 'ephemeral', laptop: 'live-shared',
};

/** Enough of the router to list environments. Listing is a roster read and
 *  stays synchronous: where each environment's files START is answered by the
 *  listing call itself, which is the only call that has to resolve a path. */
export interface ExecutorRowLookup {
  listExecutors(): Array<{
    name: string; available: boolean; configured: boolean; reason?: string;
  }>;
  getProvider(name: string): { files?: VFS } | undefined;
}

/** One row per executor that HAS a filesystem — what the file browser lists. */
export function listEnvironments(router: ExecutorRowLookup): EnvironmentInfo[] {
  return router.listExecutors()
    .filter((exec) => router.getProvider(exec.name)?.files !== undefined || !exec.available)
    .map((exec) => ({
      name: exec.name,
      prefix: `${exec.name}.*`,
      live: exec.available && router.getProvider(exec.name)?.files !== undefined,
      policy: { readOnly: false, consistency: CONSISTENCY[exec.name] ?? 'ephemeral' },
      reason: exec.available ? null : (exec.reason ?? 'this environment is not available right now'),
    }));
}

/** One directory entry, normalized across executors (each provider's readdir
 *  has its own format). */
export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  /** Last-modified time (ms since epoch), where the plane's stat carried one. */
  mtimeMs?: number;
}

export type ExecutorWriteResult = { ok: true } | { error: string };

/** Read cap for the file viewer — past this the content is carried truncated.
 *  A `response` bound in the platform catalog's terms, applied after the whole
 *  file is already resident, so it protects the wire and not the isolate. The
 *  one constant in the tree that models peak resident bytes instead is
 *  `identity/archive.ts`'s page budget. */
const MAX_VIEWABLE_BYTES = 512 * 1024;

/** One Worker↔actor RPC payload of a chunked file transfer. A quarter of the
 *  catalogued 32 MiB structured-clone ceiling (`do.facet.rpc_bytes`) — far
 *  under it, with headroom for clone metadata, and small enough that one
 *  chunk never dominates isolate memory. */
export const FILE_CHUNK_BYTES = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

/** Total bytes one file transfer may carry. The transfer's peak transient
 *  footprint is roughly twice its total (accumulated parts plus the assembled
 *  copy at finalize), so a quarter of the measured 128 MiB
 *  `do.isolate.transient_alloc_reset` wall keeps that peak near half the wall
 *  even at the limit. */
export const FILE_TRANSFER_MAX_BYTES = PLATFORM_CATALOG['do.isolate.transient_alloc_reset'].limit.value / 4;

/**
 * Actor-side state for one chunked upload. Chunks must arrive in order —
 * `offset` is checked against what has actually been buffered, never trusted —
 * and an `offset === 0` chunk (re)starts the transfer, because the holder
 * constructs a fresh instance there. With `final` the buffered parts assemble
 * and write in one plane call.
 */
export class ExecutorFileUpload {
  private parts: Uint8Array[] = [];
  private received = 0;
  private settled = false;

  constructor(
    private readonly router: ExecutorFileLookup,
    private readonly executorId: string,
    private readonly path: string,
  ) {}

  /** True once finalized or aborted — the holder must stop feeding it. */
  get done(): boolean {
    return this.settled;
  }

  async chunk(offset: number, chunk: Uint8Array, final: boolean): Promise<ExecutorWriteResult> {
    if (this.settled) return { error: 'file transfer already settled' };
    if (offset < 0) return { error: 'chunk offset must not be negative' };
    if (offset !== this.received) {
      return { error: `file transfer out of sync: expected offset ${String(this.received)}, got ${String(offset)}` };
    }
    if (chunk.byteLength > FILE_CHUNK_BYTES) {
      return { error: `chunk exceeds ${String(FILE_CHUNK_BYTES)} bytes` };
    }
    if (this.received + chunk.byteLength > FILE_TRANSFER_MAX_BYTES) {
      this.settled = true;
      return { error: `file exceeds the ${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit` };
    }
    this.parts.push(chunk);
    this.received += chunk.byteLength;
    if (!final) return { ok: true };
    const assembled = new Uint8Array(this.received);
    let at = 0;
    for (const part of this.parts) {
      assembled.set(part, at);
      at += part.byteLength;
    }
    this.settled = true;
    return writeExecutorFileOp(this.router, this.executorId, this.path, assembled);
  }

  abort(): void {
    this.parts = [];
    this.received = 0;
    this.settled = true;
  }
}

/** Actor-side snapshot behind one chunked download. `open` reads once, enforces
 * the total, and returns that same snapshot's size; ranges can neither race a
 * later stat nor observe a different file version. */
export class ExecutorFileDownload {
  private bytes: Uint8Array | null = null;

  constructor(
    private readonly router: ExecutorFileLookup,
    private readonly executorId: string,
    private readonly path: string,
  ) {}

  /** Whether this buffer already holds exactly this file. */
  serves(executorId: string, path: string): boolean {
    return this.bytes !== null && this.executorId === executorId && this.path === path;
  }

  completeAfter(end: number): boolean {
    return this.bytes !== null && end >= this.bytes.byteLength;
  }

  /** Size before any byte moves, so the caller can refuse an over-budget
   *  transfer instead of reading it. */
  async size(): Promise<{ size: number } | { error: string }> {
    return statExecutorFile(this.router, this.executorId, this.path);
  }
  async open(): Promise<
    { size: number }
    | { error: string; reason: 'too_large' | 'unavailable' }
  > {
    const stat = await this.size();
    if ('error' in stat) return { ...stat, reason: 'unavailable' };
    if (stat.size > FILE_TRANSFER_MAX_BYTES) {
      return {
        reason: 'too_large',
        error: `file exceeds the ${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit`,
      };
    }
    const loaded = await this.load();
    return 'error' in loaded ? loaded : { size: loaded.byteLength };
  }

  private async load(): Promise<
    Uint8Array | { error: string; reason: 'too_large' | 'unavailable' }
  > {
    if (this.bytes !== null) return this.bytes;
    const read = await readExecutorFileBytes(this.router, this.executorId, this.path);
    if ('error' in read) return { ...read, reason: 'unavailable' };
    if (read.bytes.byteLength > FILE_TRANSFER_MAX_BYTES) {
      return {
        reason: 'too_large',
        error: `file exceeds the ${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit`,
      };
    }
    this.bytes = read.bytes;
    return this.bytes;
  }

  async range(offset: number, length: number): Promise<{ bytes: Uint8Array } | { error: string }> {
    if (offset < 0) return { error: 'chunk offset must not be negative' };
    if (length <= 0) return { error: 'chunk length must be positive' };
    const loaded = await this.load();
    if ('error' in loaded) return loaded;
    if (offset >= loaded.byteLength) return { error: 'chunk offset past end of file' };
    return { bytes: loaded.subarray(offset, offset + length) };
  }
}

/** The named executor's file view, or null when it has none (unknown id, or an
 *  environment with no browsable filesystem). */
export function executorFiles(router: ExecutorFileLookup, executorId: string): VFS | null {
  return router.getProvider(executorId)?.files ?? null;
}

/**
 * Absolute-path arithmetic for the file plane — the ONE implementation, shared
 * by the listing here and by the browser that navigates it. `normalizePath`
 * already resolves `.`/`..` and refuses to climb above root; these three only
 * keep the leading slash it strips, so an absolute path stays absolute.
 */
export function normalizeDir(path: string): string {
  return `/${normalizePath(path)}`;
}

/** One child of a directory, absolute. */
export function joinDir(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/** The directory above, which for the root is the root. */
export function parentDir(dir: string): string {
  return normalizeDir(`${dir}/..`);
}

/** Directories first, then files; alphabetical within each group. */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Typed directory listing — off the executor's own raw handle, so types and
 * sizes are the environment's real ones.
 *
 * `path` is an absolute directory in that environment's own paths, or empty
 * for "wherever this environment starts". Either way the answer carries the
 * ABSOLUTE directory that was listed, so the browser never has to invent one:
 * the shape this replaced returned entries for a literal `'.'` reported as
 * every environment's working directory, and "go up one level" computed from
 * that token landed on the filesystem root instead of the directory above.
 */
export async function getExecutorFiles(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ path?: string; entries?: DirEntry[]; error?: string }> {
  const provider = router.getProvider(executorId);
  const vfs = provider?.files;
  if (!provider || !vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    const dir = path === '' ? await provider.homeDir() : normalizeDir(path);
    const names = await vfs.readdir(dir);
    const entries: DirEntry[] = [];
    for (const name of names) {
      // `stat` answers null for a path that is gone; anything it throws is the
      // file plane itself failing, and a listing that reported every entry as a
      // sizeless file would hide that behind a plausible directory.
      const s = await vfs.stat(joinDir(dir, name));
      entries.push({ name, type: s?.isDir ? 'dir' : 'file', size: s?.size, mtimeMs: s?.mtimeMs });
    }
    // The canonical home is always reachable by walking down from the root.
    // The workspace box enumerates directory ENTRIES, and on a fresh
    // workspace nothing above the home has any — so `/` listed only the
    // mounts and the whole workspace tree was unreachable by browsing. Each
    // ancestor of the home names the next segment down, structurally.
    const home = await provider.homeDir();
    if (home.startsWith('/') && (dir === '/' || home.startsWith(`${dir}/`))) {
      const next = home.slice(dir === '/' ? 1 : dir.length + 1).split('/')[0];
      if (next && next !== '' && !entries.some((entry) => entry.name === next)) {
        entries.push({ name: next, type: 'dir' });
      }
    }
    return { path: dir, entries: sortDirEntries(entries) };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}

/** One file's text content for the viewer. Caps size and refuses binary. */
export async function readExecutorFile(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ content?: string; truncated?: boolean; error?: string }> {
  if (!path) return { error: 'path required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  const target = path;
  try {
    const stat = await vfs.stat(target);
    if (stat?.isDir) return { error: 'path is a directory' };
    const raw = await vfs.readFile(target, { encoding: 'utf8' });
    const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
    if (text.includes(String.fromCharCode(0))) return { error: 'binary file — not previewable' };
    if (text.length > MAX_VIEWABLE_BYTES) return { content: text.slice(0, MAX_VIEWABLE_BYTES), truncated: true };
    return { content: text };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}

/**
 * Write one uploaded file into an executor — binary-safe through the same raw
 * handle the reads use.
 *
 * Raw bytes, and no size cap. Uploads arrive over a transport with no frame
 * ceiling and need no encoding, and the workspace VFS chunks what it stores —
 * so there is nothing left for an app-level limit to protect, and the one that
 * used to be here sat ABOVE the transport's real ceiling anyway.
 */
export async function writeExecutorFileOp(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
  bytes: Uint8Array,
): Promise<ExecutorWriteResult> {
  if (!path || path.endsWith('/')) return { error: 'file path required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    await vfs.writeFile(path, bytes);
    return { ok: true };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}


/**
 * Raw bytes of one file, for the download/preview HTTP route. No text/binary
 * refusal and no view cap: the caller sends the answer as a response body,
 * and the transport's own payload ceiling is the honest bound.
 */
export async function readExecutorFileBytes(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ bytes: Uint8Array } | { error: string }> {
  if (!path) return { error: 'path required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    const stat = await vfs.stat(path);
    if (stat?.isDir) return { error: 'path is a directory' };
    const raw = await vfs.readFile(path);
    return { bytes: raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw) };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}

/**
 * Size of one file, before any byte is read — the download route's preflight.
 * The HTTP layer refuses an over-budget transfer with this number instead of
 * reading the file and discovering the size afterwards.
 */
export async function statExecutorFile(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ size: number } | { error: string }> {
  if (!path) return { error: 'path required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    const stat = await vfs.stat(path);
    if (!stat) return { error: `no such file: ${path}` };
    if (stat.isDir) return { error: 'path is a directory' };
    return { size: stat.size };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}

/** The plane's native mutations, where it declares them. A widening
 *  assignment, not a cast: the extras are optional, and the workspace plane
 *  (vfs/nimbus-workspace.ts, vfs/mounts.ts) produces exactly these members. */
function nativeMutations(vfs: VFS): Partial<VfsNativeMutations> {
  const probed: VFS & Partial<VfsNativeMutations> = vfs;
  return probed;
}

/**
 * Rename one entry inside an executor's plane. Native where the plane renames
 * natively (the workspace does, without reading the bytes); a byte carry for
 * a file on a plane that cannot; a stated refusal for a directory there — a
 * tree copy wearing a rename's name is not a rename. Never overwrites.
 */
export async function renameExecutorPathOp(
  router: ExecutorFileLookup,
  executorId: string,
  from: string,
  to: string,
): Promise<ExecutorWriteResult> {
  if (!from || !to || to.endsWith('/')) return { error: 'both source and target paths are required' };
  if (from === to) return { ok: true };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    if (await vfs.exists(to)) return { error: `${to} already exists` };
    const native = nativeMutations(vfs).rename;
    if (native) {
      await native.call(vfs, from, to);
      return { ok: true };
    }
    const stat = await vfs.stat(from);
    if (!stat) return { error: `no such file or directory: ${from}` };
    if (stat.isDir) return { error: 'this environment cannot rename a directory in place' };
    const raw = await vfs.readFile(from);
    await vfs.writeFile(to, raw);
    await vfs.unlink(from);
    return { ok: true };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}

/**
 * Delete one entry inside an executor's plane. A file is one unlink; a
 * directory uses the plane's native tree removal where it has one and goes
 * entry by entry where it does not, so a plane whose unlink refuses
 * directories fails naming its own refusal.
 */
export async function deleteExecutorPathOp(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<ExecutorWriteResult> {
  if (!path || normalizeDir(path) === '/') return { error: 'a real path is required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    const stat = await vfs.stat(path);
    if (!stat) return { error: `no such file or directory: ${path}` };
    if (!stat.isDir) {
      await vfs.unlink(path);
      return { ok: true };
    }
    const native = nativeMutations(vfs).removeRecursive;
    if (native) await native.call(vfs, path);
    else await removeTreeWithVfsOps(vfs, path);
    return { ok: true };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}