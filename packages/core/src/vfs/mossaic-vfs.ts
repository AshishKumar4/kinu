import type { VFS, VfsDirent, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Kinu's `VFS` over a Mossaic tenant. Core never imports the Mossaic SDK; the hosted backend injects a
 * {@link MossaicClient}. Mossaic errors and stats are re-issued in Kinu's closed `VfsErrorCode` set.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { settle } from '../obs/effect';

import { VfsError, type VfsErrorCode } from '@nimbus-sh/core/vfs/vfs-error.js';

export interface MossaicStat {
  readonly type: 'file' | 'dir' | 'symlink';
  readonly size: number;
  readonly mtimeMs: number;
}

export interface MossaicChild {
  readonly kind: 'folder' | 'file' | 'symlink';
  readonly name: string;
  readonly stat?: MossaicStat;
}

export interface MossaicChildrenPage {
  readonly entries: readonly MossaicChild[];
  readonly cursor?: string;
}

/** Structural subset of `@mossaic/sdk`'s `VFS` this adapter drives; methods throw the SDK's `VFSFsError`. */
export interface MossaicClient {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<MossaicStat>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rmdir(path: string): Promise<void>;
  removeRecursive(path: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  listChildren(path: string, opts?: { limit?: number; cursor?: string; includeStat?: boolean }): Promise<MossaicChildrenPage>;
  createReadStream(path: string, opts?: { start?: number; end?: number }): Promise<ReadableStream<Uint8Array>>;
}

export interface MossaicVfs extends VFS {
  readlink: NonNullable<VFS['readlink']>;
  symlink: NonNullable<VFS['symlink']>;
  rename: NonNullable<VFS['rename']>;
  removeRecursive: NonNullable<VFS['removeRecursive']>;
  readRange: NonNullable<VFS['readRange']>;
}

/** Mossaic error union mapped to Kinu's by meaning: unavailable tenant is `ENXIO`, unfixable input is `EIO`,
 *  encryption-mode refusals are permission errors. */
const CODE_MAP = {
  ENOENT: 'ENOENT',
  EEXIST: 'EEXIST',
  EISDIR: 'EISDIR',
  ENOTDIR: 'ENOTDIR',
  ENOTEMPTY: 'ENOTEMPTY',
  EACCES: 'EACCES',
  ENOTSUP: 'ENOTSUP',
  EBADF: 'EPERM',
  EFBIG: 'EIO',
  ELOOP: 'EIO',
  EINVAL: 'EIO',
  EBUSY: 'ENXIO',
  EAGAIN: 'ENXIO',
  EMOSSAIC_UNAVAILABLE: 'ENXIO',
} as const satisfies Record<string, VfsErrorCode>;

type MossaicCode = keyof typeof CODE_MAP;

const MOSSAIC_CODES: readonly MossaicCode[] = [
  'ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EACCES', 'ENOTSUP',
  'EBADF', 'EFBIG', 'ELOOP', 'EINVAL', 'EBUSY', 'EAGAIN', 'EMOSSAIC_UNAVAILABLE',
];

const MossaicFailure = v.object({ code: v.picklist(MOSSAIC_CODES), message: v.optional(v.string(), '') });

/** Kinu's error for a Mossaic failure at `path`; an unrecognised throw is `EIO` with the original as `cause`. */
function translate(failure: { cause: unknown }, path: string): VfsError {
  const parsed = v.safeParse(MossaicFailure, failure.cause);

  if (parsed.success) {
    const detail = parsed.output.message.replace(/^[A-Z_]+:\s*/u, '');
    const error = new VfsError(CODE_MAP[parsed.output.code], `${detail || parsed.output.code} (shared drive)`, path);

    return Object.assign(error, { cause: failure.cause });
  }

  const message = failure.cause instanceof Error ? failure.cause.message : 'the shared drive failed';

  return Object.assign(new VfsError('EIO', `${message} (shared drive)`, path), { cause: failure.cause });
}

function guarded<T>(path: string, op: () => Promise<T>): Effect.Effect<T, VfsError> {
  return Effect.tryPromise({ try: op, catch: (cause) => translate({ cause }, path) });
}

const MossaicStatRecord = v.object({
  type: v.picklist(['file', 'dir', 'symlink']),
  size: v.pipe(v.number(), v.minValue(0)),
  mtimeMs: v.number(),
});

function entryStat(raw: MossaicStat): VfsStat {
  const stat = v.parse(MossaicStatRecord, raw);

  return { size: stat.size, mtimeMs: stat.mtimeMs, type: stat.type === 'dir' ? 'directory' : stat.type };
}

const CHILDREN_PAGE = 1000;

export function mossaicVfs(client: MossaicClient): MossaicVfs {
  return {
    readFile: (path) => settle(guarded(path, () => client.readFile(path))),
    writeFile: (path, data) => settle(guarded(path, () => client.writeFile(path, data))),
    stat: (path) => settle(guarded(path, async () => entryStat(await client.stat(path))).pipe(
      Effect.catchIf((translated) => translated.code === 'ENOENT', () => Effect.succeed(null)),
    )),
    unlink: (path) => settle(guarded(path, () => client.unlink(path))),
    mkdir: (path, opts) => settle(guarded(path, () => client.mkdir(path, opts))),
    rename: (from, to) => settle(guarded(from, () => client.rename(from, to))),
    removeRecursive: (path) => settle(guarded(path, () => client.removeRecursive(path))),
    readlink: (path) => settle(guarded(path, () => client.readlink(path))),
    symlink: (target, path) => settle(guarded(path, () => client.symlink(target, path))),
    readRange: (path, offset, length) => settle(guarded(path, async () => new Uint8Array(
      await new Response(await client.createReadStream(path, { start: offset, end: offset + length })).arrayBuffer(),
    ))),
    readdir: (path) => settle(Effect.gen(function* () {
      const listed: VfsDirent[] = [];
      let cursor: string | undefined;

      do {
        const after = cursor;
        const page = yield* guarded(path, () => client.listChildren(path, { limit: CHILDREN_PAGE, cursor: after, includeStat: true }));

        for (const child of page.entries) {
          const stat = child.stat === undefined
            ? { size: 0, mtimeMs: 0, type: child.kind === 'folder' ? 'directory' as const : child.kind }
            : entryStat(child.stat);

          listed.push({ name: child.name, type: stat.type, stat });
        }

        cursor = page.cursor;
      } while (cursor !== undefined);

      return listed;
    })),
  };
}
