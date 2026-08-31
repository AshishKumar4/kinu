/**
 * The hosted workspace's other byte planes: the protected SOUL write, the two
 * halves of a fork transfer, and the archive walk.
 *
 * Each was previously a Durable Object RPC into the workspace's own session
 * object; each is now an ordinary operation on the filesystem this actor holds.
 * That is the whole change, and it is what makes the fork's staging atomic: the
 * rename that publishes a staged file now happens in the same SQLite as the
 * row that records the transfer, so `transactionSync` covers both.
 *
 * They are here rather than on {@link HostedWorkspace} because they are not part
 * of what a turn reaches. The workspace's file plane, shell and executor are
 * used on every step; these four are used by three flows the orchestrator owns
 * (setSoul, fork, export) and nothing else builds them.
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
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

/** The plane the fork transfer and the archive walk read and write: the same
 *  rows the agent's own file tools see, as the same identity the session's
 *  pid-less file operations resolve to. */
async function sessionPlane(bundle: WorkspaceBundle): Promise<CredentialedVfs> {
  return (await bundle.session()).vfs.as(CRED_SESSION_USER);
}

/**
 * The owner-protected SOUL write.
 *
 * Ordinary Unix permissions, and nothing else: the workspace root becomes a
 * sticky 1777 directory owned by the kernel and SOUL.md itself is kernel-owned
 * and mode 444, so the agent keeps normal use of its own home and cannot
 * replace, rename or remove its identity document. Exactly the mechanism
 * Nimbus's own protected-root write uses (`_rpcWriteProtectedRootFile`), which
 * this replaces now that the filesystem is in this isolate.
 *
 * Bytes as well as text, so a fork publishes the exact frame it received without
 * decoding it first.
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

/**
 * The fork receiver's filesystem authority.
 *
 * Kept outside the general file handle because range writes are staging-only: an
 * ordinary caller must not receive raw range-write authority over the workspace.
 */
export function createWorkspaceForkSink(bundle: WorkspaceBundle, transferId: string): ForkFileSink {
  const native: ForkNativeFilePort = {
    async truncate(path, size) { (await sessionPlane(bundle)).truncate(workspacePath(path), size); },
    async writeRange(path, offset, bytes) {
      (await sessionPlane(bundle)).writeRange(workspacePath(path), offset, bytes);
    },
    // The staged temp read back for the whole-file digest. Ranged, and through
    // the same read the source half streams with: the activation that finishes a
    // file need not be the one that wrote its first range, so the check has to
    // come off the staging rather than out of memory.
    async readRange(path, offset, length) {
      return (await sessionPlane(bundle)).readRange(workspacePath(path), offset, length);
    },
    async rename(from, to) {
      (await sessionPlane(bundle)).rename(workspacePath(from), workspacePath(to));
    },
    async unlink(path) { (await sessionPlane(bundle)).unlink(workspacePath(path)); },
  };
  return new NativeSinkPlan(native, transferId, {
    // Ordinary files publish by rename. SOUL cannot: the protected write chowns
    // the file to the kernel and takes whole content, and renaming a
    // session-user temp over SOUL would publish the identity document without
    // that ownership.
    owns: (targetPath) => targetPath === SOUL_PATH,
    // Published from the ONE frame SOUL arrived in — the same bytes the sink was
    // handed, sent straight into the protected write. Nothing is staged on disk
    // for it, and the mission is read from the head of those bytes rather than
    // by decoding the document into a second whole copy.
    async publish(_targetPath, bytes) {
      await writeWorkspaceSoul(bundle, bytes);
      return { mission: summarizeSoulBytes(bytes) };
    },
  });
}

/** The source half of a fork: the workspace plane's own walk, with each
 *  inherited file read one range at a time rather than materialized whole. */
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

/**
 * The workspace root as the archive stream reads it.
 *
 * Only metadata is accumulated; file bodies remain one-at-a-time reads in the
 * archive pager. Unsupported node kinds fail the backup instead of silently
 * producing an incomplete one.
 */
export function workspaceArchiveFiles(bundle: WorkspaceBundle): ArchiveFileSource {
  return {
    async listEntries() {
      const vfs = await sessionPlane(bundle);
      const entries: Array<{ path: string; type: 'file' | 'directory' }> = [];
      const walk = (absolute: string, relative: string): void => {
        const children = [...vfs.readdir(absolute)].sort((a, b) => a.name.localeCompare(b.name));
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
          if (child.type === 'directory') walk(`${absolute}/${child.name}`, path);
        }
      };
      walk(WORKSPACE_ROOT, '');
      return entries;
    },
    async readFile(path) {
      return (await sessionPlane(bundle)).readFile(workspacePath(path));
    },
  };
}
