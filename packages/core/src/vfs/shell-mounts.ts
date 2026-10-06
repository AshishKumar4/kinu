/**
 * The workspace shell's half of the one file plane (docs/EXECUTION-LAYER-SPEC.md): each Kinu mount is a mount
 * on Nimbus's namespace, answered for each principal by that principal's own table, so a shell process and the
 * file tool reach the same trees.
 */
import type { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { Principal } from '@nimbus-sh/core/vfs/composite.js';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import type { VfsMount } from './mounts';

export type ShellMountTable = (principal: Principal) => readonly VfsMount[] | null;

/** A name already mounted is left as it is. */
export interface ShellMounts {
  add(mounts: readonly VfsMount[]): void;
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
        const described = new WeakSet<VFS>();

        filesystem.vfs.mount(`/${name}`, (principal) => {
          const mount = mountFor(principal, name);
          const files = mount?.files() ?? null;

          if (mount === undefined || files === null) return null;

          if (!described.has(files)) {
            files.describe = () => ({ source: mount.name, type: 'kinu', options: [mount.readOnly === true ? 'ro' : 'rw'] });

            if (mount.storeView === true) files.usage = () => filesystem.engine.storageUsage();
            described.add(files);
          }

          return files;
        }, {
          resolvesPaths: true,
          readOnly,
          absentReason: (principal) => mountFor(principal, name)?.absentReason() ?? `nothing is mounted at /${name} for this user`,
        });
      }
    },
  };
}
