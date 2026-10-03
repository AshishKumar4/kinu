/** SOUL write, and the store's fork and archive transfers. */

import type { ForkFileSink } from '../identity/fork-sink';
import type { ForkFileSource } from '../identity/fork';
import type { ArchiveFileSource, ArchiveFileTarget, ArchivePinnedStore, ArchiveStoreSource, ArchiveStoreTarget } from '../identity/archive';
import { isWorkspaceSoul, storeDurableSoulDb } from '../identity/soul';
import { tolerate } from '../obs/index';
import { resealWorkspaceSoul, sealWorkspaceSoul } from './agent-home';
import { workspacePath, WORKSPACE_ROOT } from './workspace-path';
import type { WorkspaceBundle, WorkspaceSession } from './nimbus-workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, SqliteVFS, VfsExportPage, VfsStat } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

type FileSessionSource = { session(): Promise<Pick<WorkspaceSession, 'vfs' | 'sql'>> };

/** The prompt's soul; reseals the file. */
export async function settledWorkspaceSoul(bundle: WorkspaceBundle): Promise<string | null> {
  const session = await bundle.session();

  return resealWorkspaceSoul(session.vfs.as(CRED_KERNEL), session.sql);
}

/** The owner's SOUL write, then sealed. */
export async function writeWorkspaceSoul(
  bundle: FileSessionSource, content: string | Uint8Array,
): Promise<void> {
  const session = await bundle.session();
  const kernel = session.vfs.as(CRED_KERNEL);

  if (!kernel.exists(WORKSPACE_ROOT) || !kernel.isDirectory(WORKSPACE_ROOT)) {
    throw new Error(`the workspace root ${WORKSPACE_ROOT} does not exist`);
  }

  sealWorkspaceSoul(kernel, content);
  storeDurableSoulDb(session.sql, content instanceof Uint8Array ? new TextDecoder().decode(content) : content);
}

/** Source principal numbers cannot cross without their registry. Keep root ownership; other files belong to
 * the fork's main actor. Every hire is in group 1000, so a source-private group must become root-only, not shared.
 * Stable root/shared groups and all mode bits stay intact. The source page remains reusable for other receivers. */
function forkPageOwnership(page: VfsExportPage): VfsExportPage {
  let imported = page;
  let index = 0;

  for (const row of page.rows) {
    const uid = row.uid === CRED_KERNEL.uid ? CRED_KERNEL.uid : CRED_SESSION_USER.uid;
    const gid = row.gid === CRED_SESSION_USER.gid ? CRED_SESSION_USER.gid : CRED_KERNEL.gid;

    if (row.uid !== uid || row.gid !== gid) {
      if (imported === page) imported = { ...page, rows: page.rows.slice() };
      imported.rows[index] = { ...row, uid, gid };
    }

    index++;
  }

  return imported;
}

/**
 * Where a fork lands in one store: Nimbus imports, each under a parent made if missing (a payload's directory may not
 * exist on a fresh target), and SOUL.md through `publishSoul`, the owner's protected write.
 */
function forkSinkOver(
  store: () => Promise<SqliteVFS>, publishSoul: (bytes: Uint8Array) => Promise<void>,
): ForkFileSink {
  const parentOf = async (dst: string): Promise<SqliteVFS> => {
    const vfs = await store();
    const parent = dst.slice(0, dst.lastIndexOf('/'));
    const plane = vfs.as(CRED_SESSION_USER);

    if (parent !== '' && !plane.exists(parent)) plane.mkdir(parent, { recursive: true });

    return vfs;
  };

  return {
    async importChunks(dst, chunks) { (await parentOf(dst)).importChunks(dst, chunks); },
    async importPage(dst, page) {
      const { want, done } = (await parentOf(dst)).importPage(dst, forkPageOwnership(page));

      return { want, done };
    },
    async publishSoul(bytes) {
      await publishSoul(bytes);
    },
    async remove(paths) {
      const plane = (await store()).as(CRED_SESSION_USER);

      for (const path of paths) {
        const at = workspacePath(path, WORKSPACE_ROOT);
        const stat = lstatOrNull(plane, at);

        if (stat === null) continue;

        if (stat.type === 'directory') plane.removeRecursive(at);
        else plane.unlink(at);
      }
    },
  };
}

export function createWorkspaceForkSink(bundle: FileSessionSource): ForkFileSink {
  return forkSinkOver(async () => (await bundle.session()).vfs, (bytes) => writeWorkspaceSoul(bundle, bytes));
}

/** One store's files as a pinned instant, read as the kernel, so no file's mode hides it from the copy. */
function forkSourceOver(store: SqliteVFS): ForkFileSource {
  return {
    async pin(name) {
      store.snapshot(name);
      const at = store.at(name, CRED_KERNEL);

      return {
        readdir: (path) => at.readdir(path).map((entry) => entry.name),
        kind: (path) => lstatOrNull(at, path)?.type ?? null,
        readFile: (path) => at.readFile(path),
        exportPage: (root, after) => store.exportPage({ at: name, root, after }),
        exportChunks: (hashes, maxBytes) => store.exportChunks(hashes, maxBytes),
        release: async () => { await store.dropSnapshotAsync(name); },
      };
    },
  };
}

/** The workspace's files, SOUL.md resealed first so the pin holds the owner's. */
export function createWorkspaceForkSource(bundle: FileSessionSource): ForkFileSource {
  return {
    async pin(name) {
      const session = await bundle.session();
      resealWorkspaceSoul(session.vfs.as(CRED_KERNEL), session.sql);

      return forkSourceOver(session.vfs).pin(name);
    },
  };
}

function lstatOrNull(plane: CredentialedVfs, path: string): VfsStat | null {
  return tolerate(() => plane.lstat(path), 'enoent') ?? null;
}

export function workspaceArchiveStore(bundle: FileSessionSource): ArchiveStoreSource {
  const pinnedOver = (store: SqliteVFS, name: string): ArchivePinnedStore => {
    const at = store.at(name, CRED_KERNEL);

    return {
      readdir: (path) => (lstatOrNull(at, path)?.type === 'directory' ? at.readdir(path).map((entry) => entry.name) : []),
      exportPage: (root, after) => store.exportPage({ at: name, root, after }),
      exportChunks: (hashes, maxBytes) => store.exportChunks(hashes, maxBytes),
      release: async () => { await store.dropSnapshotAsync(name); },
    };
  };

  return {
    async pin(name) {
      const store = (await bundle.session()).vfs;

      store.snapshot(name);

      return pinnedOver(store, name);
    },
    async pinned(name) {
      const store = (await bundle.session()).vfs;

      return store.snapshots().some((pin) => pin.name === name) ? pinnedOver(store, name) : null;
    },
  };
}

/** Store trees import as the kernel with owners unchanged: the archive's rows bring the actors they name. */
export function workspaceArchiveTarget(bundle: WorkspaceBundle): ArchiveFileTarget & ArchiveStoreTarget {
  const store = async (): Promise<SqliteVFS> => (await bundle.session()).vfs;

  return {
    writeFile: async (path, data) => (isWorkspaceSoul(path)
      ? await writeWorkspaceSoul(bundle, data)
      : await bundle.vfs.writeFile(path, data)),
    mkdir: async (path, opts) => { await bundle.vfs.mkdir(path, opts); },
    async importPage(page) {
      const vfs = await store();
      const kernel = vfs.as(CRED_KERNEL);

      if (page.after === null) {
        const root = `/${page.root}`;
        const born = lstatOrNull(kernel, root);

        if (born?.type === 'directory') kernel.removeRecursive(root);
        else if (born !== null) kernel.unlink(root);
      }

      return { pending: vfs.importPage(page.root, page, [], { lazy: true }).pending };
    },
    hydrateChunks: async (chunks) => (await store()).hydrateChunks(chunks),
  };
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
