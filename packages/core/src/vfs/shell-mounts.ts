/**
 * The workspace shell's half of the one file plane (docs/EXECUTION-LAYER-SPEC.md): each Kinu mount is a mount
 * on Nimbus's namespace, answered for each principal by that principal's own table, so a shell process and the
 * file tool reach the same trees.
 */
import type { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { Principal } from '@nimbus-sh/core/vfs/composite.js';
import type { VFS, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
import type { VfsMount } from './mounts';

export type ShellMountTable = (principal: Principal) => readonly VfsMount[] | null;

/** A name already mounted is left as it is. */
export interface ShellMounts {
  add(mounts: readonly VfsMount[]): void;
}

const MOUNT_ROOT: VfsStat = { type: 'directory', size: 0, mtimeMs: 0 };

/**
 * A mount's top folder answered here, as Nimbus's `resolvesPaths` says the namespace owns the mount point: a listing of
 * the whole namespace (a session's prewarm, at each wake) stats every mount point without a change feed, and the root
 * of a mount is another machine's or isolate's to answer: the computer configured and started its box, and `/context`
 * called main's isolate (Nimbus ask #67). Nimbus gives a mode-less root its own mode; every path below is the backend's.
 */
function rootAnsweredHere(files: VFS): VFS {
  return new Proxy(files, {
    get: (target, key) => {
      if (key === 'stat') return (...args: Parameters<VFS['stat']>) => (args[0] === '/' ? MOUNT_ROOT : target.stat(...args));

      if (!isMember(target, key)) return undefined;
      const member = target[key];

      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

function isMember(files: VFS, key: string | symbol): key is keyof VFS {
  return key in files;
}

/** Mounts every name a principal's table has at `/<name>`, answered at each call by that principal's table. */
export function shellMounts(filesystem: ProcessFiles, table: ShellMountTable): ShellMounts {
  const mounted = new Set<string>();

  const mountFor = (principal: Principal, name: string): VfsMount | undefined => table(principal)?.find((mount) => mount.name === name);

  return {
    add(mounts) {
      for (const { name, readOnly } of mounts) {
        if (mounted.has(name)) continue;
        mounted.add(name);
        // One face per backend: Nimbus tells a mount's source by its identity, and a new one relists the namespace.
        const presented = new WeakMap<VFS, VFS>();

        filesystem.vfs.mount(`/${name}`, (principal) => {
          const mount = mountFor(principal, name);
          const files = mount?.files() ?? null;

          if (mount === undefined || files === null) return null;
          const held = presented.get(files);

          if (held !== undefined) return held;
          files.describe = () => ({ source: mount.name, type: 'kinu', options: [mount.readOnly === true ? 'ro' : 'rw'] });

          if (mount.storeView === true) files.usage = () => filesystem.engine.storageUsage();
          const shown = rootAnsweredHere(files);
          presented.set(files, shown);

          return shown;
        }, {
          resolvesPaths: true,
          readOnly,
          absentReason: (principal) => mountFor(principal, name)?.absentReason() ?? `nothing is mounted at /${name} for this user`,
        });
      }
    },
  };
}
