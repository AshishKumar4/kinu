/**
 * Kinu's `VFS` over a Mossaic tenant.
 *
 * Mossaic is a Durable-Object filesystem whose SDK exposes an fs/promises
 * shape (`readFile`, `stat`, `listChildren`, ...). Core never imports that SDK:
 * the hosted backend constructs the client and hands it in as
 * {@link MossaicClient}, the structural subset this adapter reaches. What the
 * adapter owns is the BOUNDARY — Mossaic's error taxonomy and stat shape are
 * parsed at the wire and re-issued in Kinu's closed `VfsErrorCode` set, so a
 * caller switching on `err.code` above a `/shared` mount sees the same codes it
 * sees above the workspace tree.
 */
import * as v from 'valibot';
import type { VFS, VfsEntryStat } from '../types/primitives';
import { makeVfsError, type VfsErrorCode } from './errno';
import type { VfsListedEntry, VfsNativeMutations, VfsNativeReads } from './mounts';

/** What Mossaic's `stat`/`lstat` answer, as this adapter reads it. */
export interface MossaicStat {
  readonly type: 'file' | 'dir' | 'symlink';
  readonly size: number;
  readonly mtimeMs: number;
}

/** One `listChildren` entry: the leaf name, its kind, and its stat when asked for. */
export interface MossaicChild {
  readonly kind: 'folder' | 'file' | 'symlink';
  readonly name: string;
  readonly stat?: MossaicStat;
}

export interface MossaicChildrenPage {
  readonly entries: readonly MossaicChild[];
  readonly cursor?: string;
}

/**
 * The subset of `@mossaic/sdk`'s `VFS` class this adapter drives. Structural,
 * so the hosted backend's real client satisfies it without a cast and a test
 * can stand in a fake. Every method throws the SDK's `VFSFsError` (a `code`
 * from Mossaic's own union) on failure; {@link mossaicVfs} translates.
 */
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
}

/** Kinu's plane over a tenant, with the native operations the mount table forwards. */
export interface MossaicVfs extends VFS, VfsNativeMutations, Pick<VfsNativeReads, 'readdirStats'> {
  /** A symlink's target, unresolved. */
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
}

/**
 * Mossaic's error union, translated into Kinu's. The shared names pass
 * through. The rest fold by MEANING, not by number: a throttled or
 * unreachable tenant is the mount being unavailable (`ENXIO`, the code the
 * mount table itself uses for an absent mount), a malformed path or a
 * too-large write is an I/O condition the caller cannot fix by retrying
 * (`EIO`), and encryption-mode refusals are permission conditions.
 */
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
function translate(failure: { cause: unknown }, path: string): Error {
  const parsed = v.safeParse(MossaicFailure, failure.cause);

  if (parsed.success) {
    const detail = parsed.output.message.replace(/^[A-Z_]+:\s*/u, '');
    const error = makeVfsError(CODE_MAP[parsed.output.code], `${detail || parsed.output.code} (shared drive)`, path);

    return Object.assign(error, { cause: failure.cause });
  }

  const message = failure.cause instanceof Error ? failure.cause.message : 'the shared drive failed';

  return Object.assign(makeVfsError('EIO', `${message} (shared drive)`, path), { cause: failure.cause });
}

async function guarded<T>(path: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (cause) {
    throw translate({ cause }, path);
  }
}

const MossaicStatRecord = v.object({
  type: v.picklist(['file', 'dir', 'symlink']),
  size: v.pipe(v.number(), v.minValue(0)),
  mtimeMs: v.number(),
});

function entryStat(raw: MossaicStat): VfsEntryStat {
  const stat = v.parse(MossaicStatRecord, raw);

  return { size: stat.size, mtimeMs: stat.mtimeMs, isDir: stat.type === 'dir' };
}

/** The largest page Mossaic serves in one `listChildren` call. */
const CHILDREN_PAGE = 1000;

/** Kinu's file plane over one Mossaic tenant. */
export function mossaicVfs(client: MossaicClient): MossaicVfs {
  return {
    async readFile(path, opts) {
      const bytes = await guarded(path, () => client.readFile(path));

      // The workspace plane decodes exactly one encoding, and so does this one.
      return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
    },
    writeFile: (path, data) => guarded(path, () => client.writeFile(path, data)),
    readdir: (path) => guarded(path, () => client.readdir(path)),
    async stat(path) {
      try {
        return entryStat(await client.stat(path));
      } catch (cause) {
        const translated = translate({ cause }, path);

        if (translated instanceof Error && 'code' in translated && translated.code === 'ENOENT') return null;
        throw translated;
      }
    },
    exists: (path) => guarded(path, () => client.exists(path)),
    unlink: (path) => guarded(path, () => client.unlink(path)),
    mkdir: (path, opts) => guarded(path, () => client.mkdir(path, opts)),
    rename: (from, to) => guarded(from, () => client.rename(from, to)),
    removeRecursive: (path) => guarded(path, () => client.removeRecursive(path)),
    readlink: (path) => guarded(path, () => client.readlink(path)),
    symlink: (target, path) => guarded(path, () => client.symlink(target, path)),
    async readdirStats(path) {
      const listed: VfsListedEntry[] = [];
      let cursor: string | undefined;

      do {
        const page = await guarded(path, () => client.listChildren(path, { limit: CHILDREN_PAGE, cursor, includeStat: true }));

        for (const child of page.entries) {
          listed.push({
            name: child.name,
            stat: child.stat === undefined
              ? { size: 0, mtimeMs: 0, isDir: child.kind === 'folder' }
              : entryStat(child.stat),
          });
        }

        cursor = page.cursor;
      } while (cursor !== undefined);

      return listed;
    },
  };
}
