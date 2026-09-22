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

import type { VFS, VfsRevision } from '../types/primitives';
import { diagnostics, toKinuError } from '../obs/index';

/** A write or delete that landed, reported to an observer. */
export interface WriteEvent {
  /** The path as the caller addressed it. */
  readonly path: string;
  /** Content before this write, or null when the path did not exist. Absent
   *  when the observer declined it (see {@link WriteObserver}), or when
   *  `unread` says why it is unknown. */
  readonly before?: string | Uint8Array | null;
  /** Why an asked-for `before` is unknown: the path was a directory, which has
   *  no content and is never read, or reading it failed. The change landed. */
  readonly unread?: 'directory' | 'unreadable';
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

  if (!(value instanceof Uint8Array)) return { kind: 'text', text: value };
  const text = decodedText(value);

  return text === null ? { kind: 'binary' } : { kind: 'text', text };
}

const utf8 = new TextDecoder();

const encoder = new TextEncoder();

/** The bytes as text, or null when they are not text. A plane answers bytes
 *  for every raw read, so the representation says nothing about the file;
 *  the content does: git's rule, a NUL byte means binary, and bytes that do
 *  not survive a UTF-8 decode and re-encode unchanged are not text either. */
function decodedText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const text = utf8.decode(bytes);
  const again = encoder.encode(text);

  if (again.byteLength !== bytes.byteLength) return null;

  for (let i = 0; i < bytes.byteLength; i += 1) if (again[i] !== bytes[i]) return null;

  return text;
}

/**
 * Notified of every write and delete through a wrapped plane.
 *
 * The pre-write content is fetched only when `needsBaseline` says so, which is
 * what keeps this from costing a second read on every write: an observer
 * accumulating a NET change per path wants the content only the first time a
 * path is touched. A directory is never read, and a baseline that cannot be
 * taken is reported as `unread` rather than dropped: the write landed, so the
 * change is real even when its size is unknown.
 */
export interface WriteObserver {
  needsBaseline(path: string): boolean;
  record(event: WriteEvent): void;
}

type Baseline = Pick<WriteEvent, 'before' | 'unread'>;

/**
 * `vfs`, with every write and delete reported to `observer`.
 *
 * Reports only AFTER the plane accepted the mutation, so a failed write is
 * never reported as a change, and never blocks one: taking the baseline cannot
 * fail the write it observes.
 */
export function observeWrites<T extends VFS>(vfs: T, observer: WriteObserver): T {
  const baselineFor = async (path: string): Promise<Baseline> => {
    if (!observer.needsBaseline(path)) return {};

    try {
      // Asked, not caught: a directory is a state of the path, not a failed read.
      const stat = await vfs.stat(path);

      if (stat === null) return { before: null };

      if (stat.isDir) return { unread: 'directory' };

      return { before: (await vfs.readFile(path)) ?? null };
    } catch (err) {
      diagnostics.failure('vfs.write_baseline_unreadable', toKinuError({
        doing: 'reading what a watched write replaces', cause: err, otherwise: 'io',
      }), { path });

      return { unread: 'unreadable' };
    }
  };

  const report = (path: string, baseline: Baseline, after: string | Uint8Array | null): void => {
    observer.record({ path, ...baseline, after });
  };

  const conditional = vfs.writeFileIfRevision?.bind(vfs);

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
      writeFileIfRevision: async (path: string, data: Uint8Array, expectedRevision: VfsRevision) => {
        const baseline = await baselineFor(path);
        const result = await conditional(path, data, expectedRevision);

        if (result.ok) report(path, baseline, data);

        return result;
      },
    });
  }

  return wrapped;
}
