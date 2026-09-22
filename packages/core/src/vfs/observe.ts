/** Write attribution happens where a write lands: sibling heads run concurrently over the same files. */

import type { VFS, VfsRevision } from '../types/primitives';
import { diagnostics, toKinuError } from '../obs/index';

export interface WriteEvent {
  readonly path: string;
  /** null when the path did not exist; absent when not asked for or `unread` is set. */
  readonly before?: string | Uint8Array | null;
  /** Why an asked-for `before` is unknown. The change still landed. */
  readonly unread?: 'directory' | 'unreadable';
  readonly after: string | Uint8Array | null;
}

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

/** git's rule: a NUL byte means binary; bytes must also round-trip UTF-8 unchanged. */
function decodedText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const text = utf8.decode(bytes);
  const again = encoder.encode(text);

  if (again.byteLength !== bytes.byteLength) return null;

  for (let i = 0; i < bytes.byteLength; i += 1) if (again[i] !== bytes[i]) return null;

  return text;
}

/** `before` is read only when `needsBaseline` says so, to avoid a second read per write. */
export interface WriteObserver {
  needsBaseline(path: string): boolean;
  record(event: WriteEvent): void;
}

type Baseline = Pick<WriteEvent, 'before' | 'unread'>;

/** Reports only after the plane accepted the mutation; the baseline read never fails the write. */
export function observeWrites<T extends VFS>(vfs: T, observer: WriteObserver): T {
  const baselineFor = async (path: string): Promise<Baseline> => {
    if (!observer.needsBaseline(path)) return {};

    try {
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
