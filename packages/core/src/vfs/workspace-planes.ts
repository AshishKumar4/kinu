/**
 * SOUL write, fork transfer halves, and archive walk. Fork staging is atomic because the
 * publishing rename and the transfer row share one SQLite `transactionSync`.
 */

import {
  NativeSinkPlan, type ForkFileSink, type ForkNativeFilePort,
} from '../identity/fork-sink';
import type { ForkFileSource } from '../identity/fork-transfer';
import type { ArchiveFileSource } from '../identity/archive';
import { SOUL_PATH, summarizeSoulBytes } from '../identity/soul';
import { workspacePath, WORKSPACE_ROOT } from './workspace-path';
import type { WorkspaceBundle } from './nimbus-workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

async function sessionPlane(bundle: WorkspaceBundle): Promise<CredentialedVfs> {
  return (await bundle.session()).vfs.as(CRED_SESSION_USER);
}

/**
 * Owner-protected SOUL write: sticky 1777 root owned by the kernel, SOUL.md kernel-owned
 * mode 444, so the agent cannot replace, rename or remove it.
 */
export async function writeWorkspaceSoul(
  bundle: WorkspaceBundle, content: string | Uint8Array,
): Promise<void> {
  const kernel = (await bundle.session()).vfs.as(CRED_KERNEL);
  const soul = workspacePath(SOUL_PATH);

  if (!kernel.exists(WORKSPACE_ROOT) || !kernel.isDirectory(WORKSPACE_ROOT)) {
    throw new Error(`the workspace root ${WORKSPACE_ROOT} does not exist`);
  }

  kernel.chown(WORKSPACE_ROOT, CRED_KERNEL.uid, CRED_KERNEL.gid);
  kernel.chmod(WORKSPACE_ROOT, 0o1777);
  kernel.writeFile(soul, content);
  kernel.chown(soul, CRED_KERNEL.uid, CRED_KERNEL.gid);
  kernel.chmod(soul, 0o444);
}

/** Range writes are staging-only; ordinary callers must not get raw range-write authority. */
export function createWorkspaceForkSink(bundle: WorkspaceBundle, transferId: string): ForkFileSink {
  // A fork lands on an empty tree, so staging creates parents first.
  const ensureParent = async (path: string): Promise<void> => {
    const resolved = workspacePath(path);
    const cut = resolved.lastIndexOf('/');

    if (cut <= 0) return;
    const parent = resolved.slice(0, cut);
    const plane = await sessionPlane(bundle);

    if (!plane.exists(parent)) plane.mkdir(parent, { recursive: true });
  };

  const native: ForkNativeFilePort = {
    async truncate(path, size) {
      await ensureParent(path);
      (await sessionPlane(bundle)).truncate(workspacePath(path), size);
    },
    async writeRange(path, offset, bytes) {
      await ensureParent(path);
      (await sessionPlane(bundle)).writeRange(workspacePath(path), offset, bytes);
    },
    // Read back from staging: the activation that finishes a file may not have written its first range.
    async readRange(path, offset, length) {
      return (await sessionPlane(bundle)).readRange(workspacePath(path), offset, length);
    },
    async rename(from, to) {
      // `SqliteVFS.rename` does not normalize paths itself, unlike sibling ops.
      (await sessionPlane(bundle)).rename(
        normalizeVfsPath(workspacePath(from)), normalizeVfsPath(workspacePath(to)),
      );
    },
    async unlink(path) { (await sessionPlane(bundle)).unlink(workspacePath(path)); },
  };

  return new NativeSinkPlan(native, transferId, {
    // SOUL cannot publish by rename: that would skip the protected write's kernel ownership.
    owns: (targetPath) => targetPath === SOUL_PATH,
    async publish(_targetPath, bytes) {
      await writeWorkspaceSoul(bundle, bytes);

      return { mission: summarizeSoulBytes(bytes) };
    },
  });
}

export function createWorkspaceForkSource(
  bundle: WorkspaceBundle, plane: ForkFileSource,
): ForkFileSource {
  return {
    ...plane,
    async readRange(path, offset, length) {
      return (await sessionPlane(bundle)).readRange(workspacePath(path), offset, length);
    },
  };
}

/** Unsupported node kinds fail the backup rather than producing an incomplete one. */
export function workspaceArchiveFiles(bundle: WorkspaceBundle): ArchiveFileSource {
  return archiveFileTree({
    readdir: async (path) => [...(await sessionPlane(bundle)).readdir(workspacePath(path))],
    readFile: async (path) => (await sessionPlane(bundle)).readFile(workspacePath(path)),
  });
}

export function archiveFileTree(source: {
  readdir(path: string): Promise<readonly { name: string; type: string }[]>;
  readFile(path: string): Promise<Uint8Array>;
}): ArchiveFileSource {
  return {
    async listEntries() {
      const entries: Array<{ path: string; type: 'file' | 'directory' }> = [];

      const walk = async (relative: string): Promise<void> => {
        const children = [...await source.readdir(relative)].sort((a, b) => a.name.localeCompare(b.name));

        for (const child of children) {
          if (!child.name || child.name === '.' || child.name === '..' || child.name.includes('/')) {
            throw new Error(
              `Workspace archive encountered an invalid entry name: ${JSON.stringify(child.name)}.`,
            );
          }

          const path = relative ? `${relative}/${child.name}` : child.name;

          if (child.type !== 'file' && child.type !== 'directory') {
            throw new Error(`Workspace archive cannot preserve ${child.type} entry ${JSON.stringify(path)}.`);
          }

          entries.push({ path, type: child.type });

          if (child.type === 'directory') await walk(path);
        }
      };

      await walk('');

      return entries;
    },
    readFile: (path) => source.readFile(path),
  };
}
