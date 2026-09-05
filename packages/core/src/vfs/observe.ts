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

import * as v from 'valibot';
import type { VFS } from '../types/primitives';
import { isVfsError } from './errno';

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
 * A write payload AS TEXT, or the fact that it is not text.
 *
 * Parsed once, here, because {@link WriteEvent} is what owns the
 * `string | Uint8Array | null` union and every consumer of it needs the same question
 * answered before it can do anything else. What each does with a non-text payload
 * differs and belongs to the consumer: a review renders "(binary)" and a merge-back
 * refuses the member rather than decoding an image into a patch side. Both of those are
 * a mapping over this, not a second parse of it.
 */
export type TextPayload =
  | { readonly kind: 'absent' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary' };

export function textPayload(value: string | Uint8Array | null | undefined): TextPayload {
  if (value === null || value === undefined) return { kind: 'absent' };
  const parsed = v.safeParse(v.string(), value);
  return parsed.success ? { kind: 'text', text: parsed.output } : { kind: 'binary' };
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
export function observeWrites<T extends VFS>(vfs: T, observer: WriteObserver): T {
  const baselineFor = async (path: string): Promise<{ before?: string | Uint8Array | null } | null> => {
    if (!observer.needsBaseline(path)) return {};
    try {
      return { before: (await vfs.readFile(path)) ?? null };
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
  const conditional = vfs.writeFileIfRevision;
  const wrapped: T = {
    ...vfs,
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
  if (conditional) {
    Object.assign(wrapped, {
      writeFileIfRevision: async (path: string, data: Uint8Array, expectedRevision: number) => {
        const baseline = await baselineFor(path);
        const result = await conditional(path, data, expectedRevision);
        if (result.ok) report(path, baseline, data);
        return result;
      },
    });
  }
  return wrapped;
}
