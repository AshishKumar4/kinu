import { exists, type VFS, type VfsRevision, type VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
import { FileChangedSchema, writeConditionally, type FileNow, type ObservedFile } from '../vfs/conditional-write';
import { sha256Hex } from '../safety/argument-digest';
import type { CheckpointFiles } from '../types/primitives';
import { normalizePath } from '@nimbus-sh/core/vfs/composite.js';
/**
 * The file manager's read/write surface, one executor at a time, each in its own native paths
 * (the agent-facing merge is `vfs/mounts.ts`). Errors are values so the pane can render them.
 */

import {
  EXECUTOR_MOUNTS, MOUNT_EXECUTORS, RESIDENT_TEXT_MAX_BYTES, listWithVfsOps,
  readBoundedWithVfsOps, partialTreeRemovalMessage, removeTree,
} from '../vfs/mounts';
import { move } from '@nimbus-sh/core/vfs/move.js';
import { inlineFileType } from './file-types';
import type { DirectoryPages } from '../vfs/dirent';
import { isHiddenEntry, isSystemManaged } from '../vfs/workspace-path';

import { Effect } from 'effect';
import * as v from 'valibot';
import { classifyErrorCode, diagnostics, KinuError, refusalOf, renderThrownChain, settle, type Refusal } from '../obs/index';
import { PLATFORM_CATALOG } from '../platform-catalog';

export interface ExecutorFileLookup {
  getProvider(name: string): { files?: VFS & Partial<DirectoryPages>; homeDir(segment?: string): Promise<string> } | undefined;
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


interface RuntimeConsistency {
  [runtime: string]: EnvironmentInfo['policy']['consistency'];
}

const CONSISTENCY: RuntimeConsistency = {
  workspace: 'durable', parent: 'durable', sandbox: 'ephemeral', device: 'live-shared',
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
  /** Listed because the reader asked for hidden items ({@link isHiddenEntry}). */
  hidden?: true;
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
function fileTransferMaxBytes(): number {
  return PLATFORM_CATALOG['do.isolate.transient_alloc_reset'].limit.value / 4;
}

/** Read through a call marked pure: the browser reaches this module, and a bundle that never reads the bound then
 *  leaves the catalog out of it. */
export const FILE_TRANSFER_MAX_BYTES = /* @__PURE__ */ fileTransferMaxBytes();

/** One chunked upload; the holder constructs a fresh instance on an `offset === 0` chunk. */
export class ExecutorFileUpload {
  private readonly chunks = new ChunkedUpload();

  constructor(
    private readonly router: ExecutorFileLookup,
    private readonly executorId: string,
    private readonly path: string,
    private readonly write: {
      readonly expectedRevision?: VfsRevision | undefined;
    } = {},
  ) {}

  get done(): boolean {
    return this.chunks.done;
  }

  async chunk(offset: number, chunk: Uint8Array, final: boolean): Promise<ExecutorWriteResult> {
    const assembly = this.chunks.chunk(offset, chunk, final);

    if (!('assembled' in assembly)) return assembly;

    const { expectedRevision } = this.write;

    return settle(orError(step(async (): Promise<ExecutorWriteResult> => {
      return writeExecutorFileOp(this.router, this.executorId, this.path, { bytes: assembly.assembled, expectedRevision });
    })));
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

function executorFiles(router: ExecutorFileLookup, executorId: string): (VFS & CheckpointFiles) | null {
  return router.getProvider(executorId)?.files ?? null;
}

export function joinDir(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentDir(dir: string): string {
  return normalizePath(`${dir}/..`);
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
function mountLanding(router: ExecutorFileLookup, dir: string): Effect.Effect<string, Failed> {
  const machine = /^\/pc\/([^/]+)\/?$/.exec(dir)?.[1];
  const executor = MOUNT_EXECUTORS[machine === undefined ? dir : '/pc'];

  if (executor === undefined) return Effect.succeed(dir);
  const provider = router.getProvider(executor);

  if (!provider) return Effect.succeed(dir);
  const landing = dir.replace(/\/+$/, '');

  // Any failure keeps the bare mount, so the listing shows the mount's own refusal
  // (e.g. "no device connected").
  return step(() => provider.homeDir(machine)).pipe(
    Effect.catch((failed) => Effect.sync((): string | null => {
      diagnostics.event('files.mount_home_unavailable', { executor, mount: dir, error: renderThrownChain(failed) });

      return null;
    })),
    Effect.map((home) => (home !== null && home.startsWith('/') && home !== '/' ? `${landing}${home}` : landing)),
  );
}

interface Failed {
  readonly cause: unknown;
}

const step = <A>(run: () => Promise<A>): Effect.Effect<A, Failed> => Effect.tryPromise({ try: run, catch: (cause) => ({ cause }) });

function orError<R>(body: Effect.Effect<R, Failed>): Effect.Effect<R | { error: string }> {
  return Effect.catch(body, (failed) => Effect.succeed({ error: renderThrownChain(failed) }));
}

/** The longest name a POSIX filesystem holds, in bytes (NAME_MAX: Linux, macOS). */
const NAME_MAX_BYTES = 255;

/** The longest entry a listing can answer: a name whose every byte JSON escapes to six characters, at its longest numbers. */
const LONGEST_ENTRY: DirEntry = { name: '\u0001'.repeat(NAME_MAX_BYTES), type: 'file', size: Number.MAX_SAFE_INTEGER, mtimeMs: Number.MAX_SAFE_INTEGER };

/** The most entries one listing answers, so a page's text never passes `files.page_bytes` whatever its names: a folder of
 *  any size is read and sent a page at a time. */
export const FILES_PAGE_ENTRIES = Math.floor(PLATFORM_CATALOG['files.page_bytes'].limit.value / (JSON.stringify(LONGEST_ENTRY).length + 1));

/** A page of a folder from `from`, its hidden items ({@link isHiddenEntry}) among the rest when `hidden`. */
export interface FilesRequest {
  readonly from?: number;
  readonly hidden?: boolean;
}

/** `next`: where the folder's following page starts; absent after its last. */
export interface FilesPage {
  path?: string;
  entries?: DirEntry[];
  next?: number;
  error?: string;
}

/** Is `path` a machine's, or under one: a stat there is a call to that machine. */
function onMachine(path: string): boolean {
  return Object.keys(MOUNT_EXECUTORS).some((point) => path === point || path.startsWith(`${point}/`));
}

/** A machine's folder whose own plane reads it a window at a time, at the path that plane names it by. */
function machineWindows(router: ExecutorFileLookup, dir: string): { readonly files: DirectoryPages; readonly at: string } | null {
  const point = Object.keys(MOUNT_EXECUTORS).find((mount) => dir.startsWith(`${mount}/`));
  const executor = point === undefined ? undefined : MOUNT_EXECUTORS[point];
  const files = executor === undefined ? undefined : router.getProvider(executor)?.files;

  if (point === undefined || files?.readdirPage === undefined) return null;
  const { readdirPage } = files;

  return { files: { readdirPage: (path, window) => readdirPage.call(files, path, window) }, at: dir.slice(point.length) };
}

/** A machine's own `/`: the workspace's namespace, the computer's, a PC's. */
function atMachineRoot(dir: string): boolean {
  return dir === '/' || dir === EXECUTOR_MOUNTS.computer || new RegExp(`^${EXECUTOR_MOUNTS.device}/[^/]+$`, 'u').test(dir);
}

/** The entries a reader is shown: the platform's never, the hidden ones only when asked, and then marked. */
export function shownEntries(entries: readonly DirEntry[], dir: string, hidden: boolean): DirEntry[] {
  const root = atMachineRoot(dir);

  return entries.flatMap((entry): DirEntry[] => {
    if (isSystemManaged(entry.name)) return [];

    if (!isHiddenEntry(entry.name, root)) return [entry];
    const marked: DirEntry = { ...entry, hidden: true };

    return hidden ? [marked] : [];
  });
}

/** A null `stat` is one unreadable child, or a mount point, not a failed listing. */
function dirEntryOf({ name, type, stat }: { readonly name: string; readonly type: string; readonly stat?: VfsStat | null }): DirEntry {
  return { name, type: (stat?.type ?? type) === 'directory' ? 'dir' : 'file', size: stat?.size, mtimeMs: stat?.mtimeMs };
}

/** The whole folder, sorted: each ancestor of home also lists the next segment down, since on a fresh workspace nothing
 *  above home has directory entries and home would be unreachable by browsing. */
async function wholeFolder(vfs: VFS, dir: string, home: string): Promise<DirEntry[]> {
  // A machine is asked nothing per child: its listing carries what it read, and a computer asked starts.
  const entries = (await listWithVfsOps(vfs, dir, (child) => !onMachine(child))).map(dirEntryOf);

  if (home.startsWith('/') && (dir === '/' || home.startsWith(`${dir}/`))) {
    const next = home.slice(dir === '/' ? 1 : dir.length + 1).split('/')[0];

    if (next && next !== '' && !entries.some((entry) => entry.name === next)) entries.push({ name: next, type: 'dir' });
  }

  return sortDirEntries(entries);
}

/** Typed directory listing, a page as `request` asks. Empty `path` means the environment's start; the answer always
 *  carries the absolute directory listed. */
export function getExecutorFiles(router: ExecutorFileLookup, executorId: string, path: string, request: FilesRequest = {}): Promise<FilesPage> {
  const { from = 0, hidden = false } = request;
  const provider = router.getProvider(executorId);
  const vfs = provider?.files;

  if (!provider || !vfs) return Promise.resolve({ error: `Executor "${executorId}" has no file plane` });

  return settle(orError(Effect.gen(function* () {
    const dir = path === ''
      ? yield* step(() => provider.homeDir())
      : yield* mountLanding(router, normalizePath(path));

    const windows = machineWindows(router, dir);

    return yield* step(async (): Promise<FilesPage> => {
      // A machine's folder is read from the machine a window at a time: its size never sits whole in this object.
      if (windows !== null) {
        const window = await windows.files.readdirPage(windows.at, { offset: from, limit: FILES_PAGE_ENTRIES });
        const entries = sortDirEntries(shownEntries(window.entries.map(dirEntryOf), dir, hidden));

        return { path: dir, entries, ...(window.next !== null && { next: window.next }) };
      }

      const folder = shownEntries(await wholeFolder(vfs, dir, await provider.homeDir()), dir, hidden);
      const end = from + FILES_PAGE_ENTRIES;

      return { path: dir, entries: folder.slice(from, end), ...(end < folder.length && { next: end }) };
    });
  })));
}

/** One file's text, bounded before it is read. Its `revision` is what an edit is conditioned on (`writeConditionally`):
 *  the plane's own revision where it versions files, else the digest of these bytes; size/mtime never grant it. */
export function readExecutorFile(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<ExecutorTextFile> {
  if (!path) return Promise.resolve({ error: 'path required' });
  const vfs = executorFiles(router, executorId);

  if (!vfs) return Promise.resolve({ error: `Executor "${executorId}" has no file plane` });

  return settle(orError(step(async (): Promise<ExecutorTextFile> => {
    const stat = await vfs.stat(path);

    if (stat === null) return { error: `no such file or directory: ${path}` };

    if (stat?.type === 'directory') return { error: 'path is a directory' };
    const inlineType = inlineFileType(path);

    if (inlineType !== undefined) {
      return { error: `${inlineType} is not text: this file is shown and downloaded as bytes` };
    }

    const window = Math.min(stat.size, RESIDENT_TEXT_MAX_BYTES);
    const bytes = await readBoundedWithVfsOps(vfs, path, window, stat.size);

    if (bytes.includes(0)) return { error: 'binary file, not previewable' };

    const result: ExecutorTextFile = {
      content: new TextDecoder().decode(bytes),
    };

    if (bytes.byteLength < (stat?.size ?? bytes.byteLength)) result.truncated = true;

    if (!result.truncated) {
      if (stat?.revision !== undefined && vfs.writeFileIfRevision !== undefined) {
        result.revision = stat.revision;
      } else if (vfs.writeFileIfDigest !== undefined) {
        result.revision = `${DIGEST_REVISION}${sha256Hex(bytes)}`;
      } else {
        result.readOnlyReason = CONDITIONAL_WRITE_UNSUPPORTED;
      }
    }

    return result;
  })));
}

/** No expected revision creates the file, and refuses where one is already there. */
export interface ExecutorFileWrite {
  readonly bytes: Uint8Array;
  readonly expectedRevision?: VfsRevision;
}

/** No size cap here: `ExecutorFileUpload` bounds what reaches this write. */
export function writeExecutorFileOp(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
  upload: ExecutorFileWrite,
): Promise<ExecutorWriteResult> {
  if (!path || path.endsWith('/')) return Promise.resolve({ error: 'file path required' });
  const vfs = executorFiles(router, executorId);

  if (!vfs) return Promise.resolve({ error: `Executor "${executorId}" has no file plane` });
  const { bytes, expectedRevision } = upload;

  return settle(step(() => writeConditionally(vfs, path, bytes, observedBy(expectedRevision))).pipe(Effect.match({
    onSuccess: (written): ExecutorWriteResult => ({ ok: true, revision: revisionOf(written.now) }),
    onFailure: (failed): ExecutorWriteResult => {
      const refused = failed.cause instanceof KinuError ? failed.cause : null;
      const changed = v.safeParse(FileChangedSchema, refused?.cause);

      if (changed.success) return { conflict: true, revision: revisionOf(changed.output.now) };

      return refused?.code === 'unsupported' ? { unsupported: true, error: CONDITIONAL_WRITE_UNSUPPORTED } : { error: renderThrownChain(failed) };
    },
  })));
}

/** A digest stands in for a revision on a plane that keeps none: the owner's editor echoes it back as one. */
const DIGEST_REVISION = 'sha256:';

function observedBy(revision: VfsRevision | undefined): ObservedFile {
  // No token, or the one a conflict over a missing file names: the replace creates it, on any plane.
  if (revision === undefined || String(revision) === String(ABSENT_TOKEN)) return { kind: 'absent' };

  return typeof revision === 'string' && revision.startsWith(DIGEST_REVISION)
    ? { kind: 'digest', sha256: revision.slice(DIGEST_REVISION.length) }
    : { kind: 'revision', revision };
}

/** A missing file's token: revision 0, as Nimbus counts one, whichever check the plane makes. */
const ABSENT_TOKEN = 0;

/** What the file holds now, as the editor names it. */
function revisionOf(now: FileNow): VfsRevision {
  if ('revision' in now) return now.revision;

  return now.sha256 === null ? ABSENT_TOKEN : `${DIGEST_REVISION}${now.sha256}`;
}

export function readExecutorFileBytes(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ bytes: Uint8Array } | { error: string }> {
  if (!path) return Promise.resolve({ error: 'path required' });
  const vfs = executorFiles(router, executorId);

  if (!vfs) return Promise.resolve({ error: `Executor "${executorId}" has no file plane` });

  return settle(orError(step(async (): Promise<{ bytes: Uint8Array } | { error: string }> => {
    const stat = await vfs.stat(path);

    if (stat?.type === 'directory') return { error: 'path is a directory' };

    return { bytes: await vfs.readFile(path) };
  })));
}

export function statExecutorFile(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ size: number } | { error: string }> {
  if (!path) return Promise.resolve({ error: 'path required' });
  const vfs = executorFiles(router, executorId);

  if (!vfs) return Promise.resolve({ error: `Executor "${executorId}" has no file plane` });

  return settle(orError(step(async (): Promise<{ size: number } | { error: string }> => {
    const stat = await vfs.stat(path);

    if (!stat) return { error: `no such file: ${path}` };

    if ((stat.type === 'directory')) return { error: 'path is a directory' };

    return { size: stat.size };
  })));
}

/** Native rename where available, else a confirmed byte carry for files (directories refused).
 *  Never overwrites. */
export function renameExecutorPathOp(
  router: ExecutorFileLookup,
  executorId: string,
  from: string,
  to: string,
): Promise<ExecutorWriteResult> {
  if (!from || !to || to.endsWith('/')) return Promise.resolve({ error: 'both source and target paths are required' });

  if (from === to) return Promise.resolve({ ok: true });

  return settle(orError(step(async (): Promise<ExecutorWriteResult> => {
    const vfs = executorFiles(router, executorId);

    if (!vfs) return { error: `Executor "${executorId}" has no file plane` };

    if (await exists(vfs, to)) return { error: `${to} already exists` };
    await move(vfs, from, to);

    return { ok: true };
  })));
}

/** Non-native tree removal stops at the first failure and refuses with what was removed and what
 *  remains. */
export function deleteExecutorPathOp(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<ExecutorWriteResult> {
  if (!path || normalizePath(path) === '/') return Promise.resolve({ error: 'a real path is required' });

  return settle(orError(step(async (): Promise<ExecutorWriteResult> => {
    const vfs = executorFiles(router, executorId);

    if (!vfs) return { error: `Executor "${executorId}" has no file plane` };

    // The entry itself: a link is removed as a link, dangling or not, never what it leads to.
    const stat = await vfs.stat(path, { follow: false });

    if (!stat) return { error: `no such file or directory: ${path}` };

    if (!(stat.type === 'directory')) {
      await vfs.unlink(path);

      return { ok: true };
    }

    const kept = await removeTree(vfs, path);

    if (kept !== null) {
      // No cause attached: the message already inlines it.
      const reason = classifyErrorCode({ cause: kept.failed.cause }) ?? 'io';

      return {
        ...refusalOf(new KinuError(reason, partialTreeRemovalMessage(path, kept))),
        removed: kept.removed,
        remaining: kept.remaining,
      };
    }

    return { ok: true };
  })));
}