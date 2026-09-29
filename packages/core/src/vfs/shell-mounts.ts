/**
 * The workspace shell's half of the one file plane (docs/EXECUTION-LAYER-SPEC.md): each Kinu mount is a mount
 * on Nimbus's namespace, answered for each principal by that principal's own table, so a shell process and the
 * file tool reach the same trees.
 */
import type { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { Principal } from '@nimbus-sh/core/vfs/composite.js';
import { isVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import type { VFS as NimbusVfs, VfsCred, VfsDirent, VfsFileType, VfsRemoval, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
import type { VFS, VfsEntryStat, VfsLinkStat } from '../types/primitives';
import {
  listWithVfsOps, removeTreeWithVfsOps, type MountedVfs, type VfsMount, type VfsNativeMutations, type VfsNativeReads,
} from './mounts';

export type ShellMountTable = (cred: Readonly<VfsCred>) => MountedVfs | null;

/** Mounts a plane's names on the workspace namespace; a name already mounted is left as it is. */
export interface ShellMounts {
  add(plane: MountedVfs): void;
}


function typeOf(stat: VfsEntryStat | VfsLinkStat): VfsFileType {
  if ('isSymlink' in stat && stat.isSymlink) return 'symlink';

  return stat.isDir ? 'directory' : 'file';
}

function statOf(stat: VfsEntryStat | VfsLinkStat): VfsStat {
  return { type: typeOf(stat), size: stat.size, mtimeMs: stat.mtimeMs };
}

function bytesOf(raw: Uint8Array | string): Uint8Array {
  return raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
}

async function removeTree(files: VFS, path: string): Promise<VfsRemoval | undefined> {
  const removal = await removeTreeWithVfsOps(files, path);

  if (removal.ok) return undefined;
  const { path: at, cause } = removal.failed;

  const error = isVfsError(cause) ? cause : new VfsError('EIO', String(cause), at, { cause });

  return { removed: [...removal.removed], kept: [...removal.remaining], failures: [{ path: at, error }] };
}

/** A Kinu plane as a Nimbus backend, with each optional operation only where the plane has it natively. */
function nimbusBackend(mount: VfsMount, files: VFS, store: ProcessFiles['engine']): NimbusVfs {
  const native: VFS & Partial<VfsNativeMutations & VfsNativeReads> = files;
  const { rename, removeRecursive, readRange } = native;
  const lstat = files.lstat?.bind(files);
  const readlink = files.readlink?.bind(files);
  const writeFileIfRevision = files.writeFileIfRevision?.bind(files);
  const readFileAtRevision = files.readFileAtRevision?.bind(files);

  const writable = async <T>(path: string, call: () => T | Promise<T>): Promise<T> => {
    if (mount.readOnly === true) throw new VfsError('EROFS', `/${mount.name} is read-only`, path);

    return call();
  };

  const backend: NimbusVfs = {
    stat: async (path, options) => {
      const stat = options?.follow === false && lstat ? await lstat.call(files, path) : await files.stat(path);

      return stat === null ? null : statOf(stat);
    },
    readFile: async (path) => bytesOf(await files.readFile(path)),
    writeFile: (path, data) => writable(path, () => files.writeFile(path, data)),
    readdir: async (path) => (await listWithVfsOps(files, path)).flatMap(({ name, stat }): VfsDirent[] => {
      if (stat === null) return [];
      const mapped = statOf(stat);

      return [{ name, type: mapped.type, stat: mapped }];
    }),
    mkdir: (path, options) => writable(path, () => files.mkdir(path, options?.recursive === true ? { recursive: true } : undefined)),
    unlink: (path) => writable(path, () => files.unlink(path)),
    removeRecursive: (path) => writable(path, async () => {
      if (removeRecursive === undefined) return removeTree(files, path);
      await removeRecursive.call(files, path);

      return undefined;
    }),
    describe: () => ({ source: mount.name, type: 'kinu', options: [mount.readOnly === true ? 'ro' : 'rw'] }),
  };

  if (mount.storeView === true) backend.usage = async () => store.storageUsage();

  if (rename) backend.rename = (from, to) => writable(from, () => rename.call(files, from, to));

  if (readRange) backend.readRange = (path, offset, length) => readRange.call(files, path, offset, length);

  if (readlink) backend.readlink = (path) => readlink.call(files, path);

  if (writeFileIfRevision) {
    backend.writeFileIfRevision = (path, data, expected) => writable(path, () => writeFileIfRevision.call(files, path, data, expected));
  }

  if (readFileAtRevision) {
    backend.readFileAtRevision = async (path, revision, range) => bytesOf(await readFileAtRevision.call(files, path, revision, range));
  }

  return backend;
}

/** Mounts every name a principal's table has at `/<name>`, answered at each call by that principal's table. */
export function shellMounts(filesystem: ProcessFiles, table: ShellMountTable): ShellMounts {
  const mounted = new Set<string>();

  const mountFor = (principal: Principal, name: string): VfsMount | undefined => (
    principal.cred === null ? undefined : table(principal.cred)?.mounts().find((mount) => mount.name === name)
  );

  return {
    add(plane) {
      for (const { name } of plane.mounts()) {
        if (mounted.has(name)) continue;
        mounted.add(name);
        const backends = new WeakMap<VFS, NimbusVfs>();

        filesystem.vfs.mount(`/${name}`, (principal) => {
          const mount = mountFor(principal, name);
          const files = mount?.files() ?? null;

          if (mount === undefined || files === null) return null;
          const known = backends.get(files);

          if (known !== undefined) return known;
          const backend = nimbusBackend(mount, files, filesystem.engine);
          backends.set(files, backend);

          return backend;
        }, { absentReason: (principal) => mountFor(principal, name)?.absentReason() ?? `nothing is mounted at /${name} for this user` });
      }
    },
  };
}
