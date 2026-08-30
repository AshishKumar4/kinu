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
import {
  MOUNT_EXECUTORS, carryFileWithVfsOps, listWithVfsOps, readBoundedWithVfsOps,
  removeTreeWithVfsOps, type VfsNativeMutations,
} from '../vfs/mounts';
import { isVfsError } from '../vfs/errno';
import { inlineFileType } from './file-types';
import type { VFS } from '../types/primitives';
import { diagnostics, renderThrownChain } from '../obs/index';
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


export type ExecutorWriteResult =
  | { ok: true; revision?: number }
  | { conflict: true; revision: number }
  | { unsupported: true; error: string }
  | { error: string };

const CONDITIONAL_WRITE_UNSUPPORTED =
  'This file plane cannot protect an in-place edit from a newer write. Download it to edit safely.';

/**
 * Byte bound for the file viewer's text preview — past this the content is
 * carried truncated.
 *
 * A `response` bound in the platform catalog's terms, and now the READ bound as
 * well: `readExecutorFile` asks the plane for this many bytes and decodes only
 * those. It used to be applied after the whole file was already a resident
 * JavaScript string, so previewing a large file cost the file plus a clipped
 * copy of it, and this number protected only the wire.
 */
const MAX_VIEWABLE_BYTES = 512 * 1024;

/** One Worker↔actor RPC payload of a chunked file transfer. A quarter of the
 *  catalogued 32 MiB structured-clone ceiling (`do.facet.rpc_bytes`) — far
 *  under it, with headroom for clone metadata, and small enough that one
 *  chunk never dominates isolate memory. */
export const FILE_CHUNK_BYTES = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

/** Text preview payload. Optional fields preserve the RPC's established
 * success/error shape; `revision` is present only when native CAS exists. */
export interface ExecutorTextFile {
  content?: string;
  truncated?: boolean;
  revision?: number;
  readOnlyReason?: string;
  error?: string;
}

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
    private readonly expectedRevision?: number,
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
    return writeExecutorFileOp(this.router, this.executorId, this.path, assembled, this.expectedRevision);
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
 * Where a mount point's own tree starts.
 *
 * A mount is a faithful window on the machine's REAL absolute paths, so `/pc`
 * strips to the device's `/` (`vfs/mounts.ts` routeOf). The device's consent
 * boundary refuses that, and the first click on a connected machine's files
 * answered `EACCES: '/' is outside the consented device directory
 * '/home/kinu'`. The directory a person means by "open /pc" is the one they
 * consented to, and the mounted plane already reports it: `homeDir()` IS the
 * consented root the path guard measures against.
 *
 * Nothing widens. The same guard still decides the listing, every path under
 * the mount stays the machine's own, and the reachable set only narrows —
 * `/pc` stops naming a directory the owner never consented to.
 *
 * A plane that cannot say where it starts keeps the bare mount point, so the
 * refusal the reader sees is the plane's own — a disconnected device states its
 * absence rather than reporting whatever broke while asking it for a home.
 */
async function mountLanding(router: ExecutorFileLookup, dir: string): Promise<string> {
  const executor = MOUNT_EXECUTORS[dir];
  if (executor === undefined) return dir;
  const provider = router.getProvider(executor);
  if (!provider) return dir;
  // Deliberately ANY failure, and the reason is which error the reader ends up
  // reading. A disconnected device cannot say where it starts either, and the
  // refusal worth showing is the mount's own stated absence from the listing
  // below — "no device connected" — not whatever the asking hit on the way.
  // Recorded rather than swallowed: `dir` alone cannot tell a mount with no
  // home from a plane that failed to answer, and only one of those is a fault.
  // A caught binding rather than a rejection handler's parameter: the diagnostic
  // needs the cause and nothing else, and `catch` narrows it without declaring
  // an `unknown` parameter.
  let home: string | null;
  try {
    home = await provider.homeDir();
  } catch (cause) {
    diagnostics.event('files.mount_home_unavailable',
      { executor, mount: dir, error: renderThrownChain({ cause }) });
    home = null;
  }
  return home !== null && home.startsWith('/') && home !== '/' ? `${dir}${home}` : dir;
}

/**
 * Typed directory listing — off the executor's own raw handle, so types and
 * sizes are the environment's real ones.
 *
 * `path` is an absolute directory in that environment's own paths, or empty
 * for "wherever this environment starts". A bare MOUNT POINT means the same
 * thing for the machine behind it, so it resolves to that plane's own start
 * (`mountLanding`). Either way the answer carries the ABSOLUTE directory that
 * was listed, so the browser never has to invent one: the shape this replaced
 * returned entries for a literal `'.'` reported as every environment's working
 * directory, and "go up one level" computed from that token landed on the
 * filesystem root instead of the directory above.
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
    const dir = path === ''
      ? await provider.homeDir()
      : await mountLanding(router, normalizeDir(path));
    const listed = await listWithVfsOps(vfs, dir);
    // `stat` answers null for an entry that is gone, or that this plane could
    // not stat — one child, not the directory. The shape this replaced statted
    // every child one after another and let any single throw fail the whole
    // listing, so one file disappearing mid-read told the reader their folder
    // was unreachable.
    const entries: DirEntry[] = listed.map(({ name, stat }) => ({
      name, type: stat?.isDir ? 'dir' : 'file', size: stat?.size, mtimeMs: stat?.mtimeMs,
    }));
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

/**
 * One file's text, for the viewer — bounded before it is read, not after.
 *
 * A text read carries the backend's exact revision only when that backend also
 * offers native compare-and-write. Size/mtime never grants edit authority:
 * same-looking peer writes are still conflicts.
 */
export async function readExecutorFile(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<ExecutorTextFile> {
  if (!path) return { error: 'path required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    const stat = await vfs.stat(path);
    if (stat?.isDir) return { error: 'path is a directory' };
    const inlineType = inlineFileType(path);
    if (inlineType !== undefined) {
      return { error: `${inlineType} is not text — this file is shown and downloaded as bytes` };
    }
    const window = stat === null ? MAX_VIEWABLE_BYTES : Math.min(stat.size, MAX_VIEWABLE_BYTES);
    const bytes = await readBoundedWithVfsOps(vfs, path, window, stat?.size ?? null);
    if (bytes.includes(0)) return { error: 'binary file — not previewable' };
    const result: ExecutorTextFile = {
      content: new TextDecoder().decode(bytes),
    };
    if (bytes.byteLength < (stat?.size ?? bytes.byteLength)) result.truncated = true;
    if (!result.truncated) {
      if (stat?.revision !== undefined && vfs.writeFileIfRevision !== undefined) {
        result.revision = stat.revision;
      } else {
        result.readOnlyReason = 'This file plane cannot protect an in-place edit from a newer write. Download it to edit safely.';
      }
    }
    return result;
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
  expectedRevision?: number,
): Promise<ExecutorWriteResult> {
  if (!path || path.endsWith('/')) return { error: 'file path required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  const conditional = vfs.writeFileIfRevision;
  if (expectedRevision === undefined) {
    try {
      await vfs.writeFile(path, bytes);
      return { ok: true };
    } catch (err) {
      return { error: renderThrownChain({ cause: err }) };
    }
  }
  if (conditional === undefined) {
    return {
      unsupported: true,
      error: CONDITIONAL_WRITE_UNSUPPORTED,
    };
  }
  try {
    const result = await conditional(path, bytes, expectedRevision);
    return result.ok
      ? { ok: true, revision: result.revision }
      : { conflict: true, revision: result.revision };
  } catch (err) {
    if (isVfsError(err) && err.code === 'ENOTSUP') {
      return { unsupported: true, error: CONDITIONAL_WRITE_UNSUPPORTED };
    }
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
 * natively (the workspace does, without reading the bytes); a byte carry for a
 * file on a plane that cannot, through the one carry the mount table also uses
 * — the source is destroyed only once its copy is confirmed, and a carry that
 * cannot finish removes the copy, so a failed rename never leaves the file
 * under two names. A directory there is a stated refusal: a tree copy wearing
 * a rename's name is not a rename. Never overwrites.
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
    await carryFileWithVfsOps({ files: vfs, path: from }, { files: vfs, path: to });
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