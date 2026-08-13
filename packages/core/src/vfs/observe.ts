/**
 * Watching what a file plane was told to change.
 *
 * One wrapper over any {@link VFS}, so the thing being watched does not have to
 * know it is being watched. The only consumer today is a head reporting which of
 * its parent's files IT changed (heads/file-changes.ts), and that is exactly the
 * shape the problem has: attribution has to happen where a write lands, because
 * sibling heads run concurrently over the same files and an end-of-run diff
 * smears all of their work into one pile.
 */

import type { VFS } from '../types/primitives.js';
import { isVfsError } from './errno.js';

/** A write or delete that landed, reported to an observer. */
export interface WriteEvent {
  /** The path as the caller addressed it. */
  readonly path: string;
  /** Content before this write, or null when the path did not exist. Absent
   *  when the observer declined it (see {@link WriteObserver}). */
  readonly before?: string | Uint8Array | null;
  /** Content after. null for a delete. */
  readonly after: string | Uint8Array | null;
}

/**
 * Notified of every write and delete through a wrapped plane.
 *
 * The pre-write content is fetched only when `needsBaseline` says so, which is
 * what keeps this from costing a second read on every write: an observer
 * accumulating a NET change per path wants the content only the first time a
 * path is touched. When that read fails for any reason other than the file not
 * existing, nothing is reported for that write at all — an unknown baseline is
 * not a change of unknown size, it is a change this observer cannot describe.
 */
export interface WriteObserver {
  needsBaseline(path: string): boolean;
  record(event: WriteEvent): void;
}

/**
 * `vfs`, with every write and delete reported to `observer`.
 *
 * Reports only AFTER the plane accepted the mutation, so a failed write is
 * never reported as a change.
 */
export function observeWrites(vfs: VFS, observer: WriteObserver): VFS {
  const baselineFor = async (path: string): Promise<{ before?: string | Uint8Array | null } | null> => {
    if (!observer.needsBaseline(path)) return {};
    try {
      return { before: (await vfs.readFile(path, { encoding: 'utf8' })) ?? null };
    } catch (err) {
      if (isVfsError(err) && err.code === 'ENOENT') return { before: null };
      return null;
    }
  };
  const report = (
    path: string,
    baseline: { before?: string | Uint8Array | null } | null,
    after: string | Uint8Array | null,
  ): void => {
    if (baseline) observer.record({ path, ...baseline, after });
  };

  return {
    readFile: (path, opts) => vfs.readFile(path, opts),
    readdir: (path) => vfs.readdir(path),
    stat: (path) => vfs.stat(path),
    mkdir: (path, opts) => vfs.mkdir(path, opts),
    exists: (path) => vfs.exists(path),

    async writeFile(path, data) {
      const baseline = await baselineFor(path);
      await vfs.writeFile(path, data);
      report(path, baseline, data);
    },

    async unlink(path) {
      const baseline = await baselineFor(path);
      await vfs.unlink(path);
      report(path, baseline, null);
    },
  };
}
