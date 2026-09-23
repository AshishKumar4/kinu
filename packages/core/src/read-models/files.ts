/**
 * The file manager's read/write surface, one executor at a time, each in its own native paths
 * (the agent-facing merge is `vfs/mounts.ts`). Errors are values so the pane can render them.
 */

import { normalizePath } from '@kinu.run/agent-utils';
import {
  MOUNT_EXECUTORS, RESIDENT_TEXT_MAX_BYTES, carryFileWithVfsOps, listWithVfsOps,
  readBoundedWithVfsOps, partialTreeRemovalMessage, removeTreeWithVfsOps,
  type VfsNativeMutations,
} from '../vfs/mounts';
import { isVfsError } from '../vfs/errno';
import { inlineFileType } from './file-types';
import { isSystemManaged } from './files-plane';
import type { VFS, VfsRevision } from '../types/primitives';
import { classifyErrorCode, diagnostics, KinuError, refusalOf, renderThrownChain, type Refusal } from '../obs/index';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { readBoundedStream } from '../http/http';

export interface ExecutorFileLookup {
  getProvider(name: string): { files?: VFS; homeDir(segment?: string): Promise<string> } | undefined;
}

/** `consistency`: `durable` survives everything, `ephemeral` dies with the container,
 *  `live-shared` is the user's own machine. */
export interface EnvironmentInfo {
  name: string;
  prefix: string;
  live: boolean;
  policy: { readOnly: boolean; consistency: 'durable' | 'ephemeral' | 'live-shared' };
  reason: string | null;
}

export type MountInfo = EnvironmentInfo;

interface RuntimeConsistency {
  [runtime: string]: EnvironmentInfo['policy']['consistency'];
}

const CONSISTENCY: RuntimeConsistency = {
  workspace: 'durable', parent: 'durable', sandbox: 'ephemeral', nimbus: 'ephemeral', device: 'live-shared',
};

export interface ExecutorRowLookup {
  listExecutors(): Array<{
    name: string; available: boolean; configured: boolean; reason?: string;
  }>;
  getProvider(name: string): { files?: VFS } | undefined;
}

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

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  mtimeMs?: number;
}

export type ExecutorWriteResult =
  | { ok: true; revision?: VfsRevision }
  | { conflict: true; revision: VfsRevision }
  | { unsupported: true; error: string }
  | { error: string }
  /** Partial tree removal: the boundary the removal itself recorded. */
  | (Refusal & { removed: readonly string[]; remaining: readonly string[] });

const CONDITIONAL_WRITE_UNSUPPORTED =
  'This file plane cannot protect an in-place edit from a newer write. Download it to edit safely.';

import { FILE_CHUNK_BYTES } from '../types/read-models';

export { FILE_CHUNK_BYTES } from '../types/read-models';

/** `revision` is present only when native CAS exists. */
export interface ExecutorTextFile {
  content?: string;
  truncated?: boolean;
  revision?: VfsRevision;
  readOnlyReason?: string;
  error?: string;
}

/** Peak transient footprint is ~2x the total (parts plus assembled copy), so a quarter of the
 *  `do.isolate.transient_alloc_reset` wall keeps the peak near half of it. */
export const FILE_TRANSFER_MAX_BYTES = PLATFORM_CATALOG['do.isolate.transient_alloc_reset'].limit.value / 4;

/** One chunked upload; the holder constructs a fresh instance on an `offset === 0` chunk. */
export class ExecutorFileUpload {
  private readonly chunks = new ChunkedUpload();

  constructor(
    private readonly router: ExecutorFileLookup,
    private readonly executorId: string,
    private readonly path: string,
    private readonly expectedRevision?: VfsRevision,
  ) {}

  get done(): boolean {
    return this.chunks.done;
  }

  async chunk(offset: number, chunk: Uint8Array, final: boolean): Promise<ExecutorWriteResult> {
    const step = this.chunks.chunk(offset, chunk, final);

    if (!('assembled' in step)) return step;

    return writeExecutorFileOp(this.router, this.executorId, this.path,
      { bytes: step.assembled, expectedRevision: this.expectedRevision });
  }

  abort(): void {
    this.chunks.abort();
  }
}

/** In-order chunk assembly; `assembled` is answered exactly once, on the final chunk. */
export class ChunkedUpload {
  private parts: Uint8Array[] = [];
  private received = 0;
  private settled = false;

  /** True once finalized or aborted; the holder must stop feeding it. */
  get done(): boolean {
    return this.settled;
  }

  chunk(offset: number, chunk: Uint8Array, final: boolean): { ok: true } | { error: string } | { assembled: Uint8Array } {
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

    return { assembled };
  }

  abort(): void {
    this.parts = [];
    this.received = 0;
    this.settled = true;
  }
}

/** Streams the body as whole FILE_CHUNK_BYTES chunks then one final (possibly empty) tail. A
 *  throwing `send` propagates; only the caller can abort the transfer it opened. */
export async function pumpUploadChunks<Result>(
  request: Request,
  send: (offset: number, chunk: Uint8Array, final: boolean) => Promise<Result>,
): Promise<'too_large' | KinuError | { result: Result }> {
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let offset = 0;

  const take = (want: number): Uint8Array => {
    const out = new Uint8Array(want);
    let at = 0;

    while (at < want) {
      const part = pending[0];
      const count = Math.min(part.byteLength, want - at);
      out.set(part.subarray(0, count), at);

      if (count === part.byteLength) pending.shift();
      else pending[0] = part.subarray(count);
      at += count;
    }

    pendingBytes -= want;

    return out;
  };

  const outcome = await readBoundedStream(request, FILE_TRANSFER_MAX_BYTES, async (value) => {
    pending.push(value);
    pendingBytes += value.byteLength;

    while (pendingBytes >= FILE_CHUNK_BYTES) {
      await send(offset, take(FILE_CHUNK_BYTES), false);
      offset += FILE_CHUNK_BYTES;
    }
  });

  if (outcome !== 'ok') return outcome;

  return { result: await send(offset, pendingBytes > 0 ? take(pendingBytes) : new Uint8Array(0), true) };
}

/** One snapshot behind a chunked download, so ranges never observe a different file version. */
export class ExecutorFileDownload {
  private bytes: Uint8Array | null = null;

  constructor(
    private readonly router: ExecutorFileLookup,
    private readonly executorId: string,
    private readonly path: string,
  ) {}

  serves(executorId: string, path: string): boolean {
    return this.bytes !== null && this.executorId === executorId && this.path === path;
  }

  completeAfter(end: number): boolean {
    return this.bytes !== null && end >= this.bytes.byteLength;
  }

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

function executorFiles(router: ExecutorFileLookup, executorId: string): VFS | null {
  return router.getProvider(executorId)?.files ?? null;
}

/** Absolute-path arithmetic shared with the browser; restores the slash `normalizePath` strips. */
function normalizeDir(path: string): string {
  return `/${normalizePath(path)}`;
}

export function joinDir(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentDir(dir: string): string {
  return normalizeDir(`${dir}/..`);
}

export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;

    return a.name.localeCompare(b.name);
  });
}

/**
 * Where a mount point's tree starts: `/pc/<name>` lands on that machine's consented root
 * (`homeDir(segment)`), since the device guard refuses its `/`. Bare `/pc` is the roster.
 */
async function mountLanding(router: ExecutorFileLookup, dir: string): Promise<string> {
  const machine = /^\/pc\/([^/]+)\/?$/.exec(dir)?.[1];
  const executor = MOUNT_EXECUTORS[machine === undefined ? dir : '/pc'];

  if (executor === undefined) return dir;
  const provider = router.getProvider(executor);

  if (!provider) return dir;
  // Any failure keeps the bare mount, so the listing shows the mount's own refusal
  // (e.g. "no device connected").
  let home: string | null;

  try {
    home = await provider.homeDir(machine);
  } catch (cause) {
    diagnostics.event('files.mount_home_unavailable',
      { executor, mount: dir, error: renderThrownChain({ cause }) });
    home = null;
  }

  const landing = dir.replace(/\/+$/, '');

  return home !== null && home.startsWith('/') && home !== '/' ? `${landing}${home}` : landing;
}

/** Typed directory listing. Empty `path` means the environment's start; the answer always carries
 *  the absolute directory listed. */
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

    // A null `stat` is one unreadable child, not a failed listing.
    const entries: DirEntry[] = listed.filter(({ name }) => !isSystemManaged(name)).map(({ name, stat }) => ({
      name, type: stat?.isDir ? 'dir' : 'file', size: stat?.size, mtimeMs: stat?.mtimeMs,
    }));

    // Each ancestor of home lists the next segment down: on a fresh workspace nothing above home
    // has directory entries, so home would be unreachable by browsing.
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

/** One file's text, bounded before it is read. A revision is returned only with native
 *  compare-and-write; size/mtime never grants edit authority. */
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

    const window = stat === null ? RESIDENT_TEXT_MAX_BYTES : Math.min(stat.size, RESIDENT_TEXT_MAX_BYTES);
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

/** No expected revision writes unconditionally. */
export interface ExecutorFileWrite {
  readonly bytes: Uint8Array;
  readonly expectedRevision?: VfsRevision;
}

/** No size cap here: `ExecutorFileUpload` bounds what reaches this write. */
export async function writeExecutorFileOp(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
  upload: ExecutorFileWrite,
): Promise<ExecutorWriteResult> {
  if (!path || path.endsWith('/')) return { error: 'file path required' };
  const vfs = executorFiles(router, executorId);

  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  const { bytes, expectedRevision } = upload;
  const conditional = vfs.writeFileIfRevision?.bind(vfs);

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

function nativeMutations(vfs: VFS): Partial<VfsNativeMutations> {
  const probed: VFS & Partial<VfsNativeMutations> = vfs;

  return probed;
}

/** Native rename where available, else a confirmed byte carry for files (directories refused).
 *  Never overwrites. */
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

/** Non-native tree removal stops at the first failure and refuses with what was removed and what
 *  remains. */
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

    if (native) {
      await native.call(vfs, path);

      return { ok: true };
    }

    const removal = await removeTreeWithVfsOps(vfs, path);

    if (!removal.ok) {
      // No cause attached: the message already inlines it.
      const reason = classifyErrorCode({ cause: removal.failed.cause }) ?? 'io';

      return {
        ...refusalOf(new KinuError(reason, partialTreeRemovalMessage(path, removal))),
        removed: removal.removed,
        remaining: removal.remaining,
      };
    }

    return { ok: true };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}