import { Effect } from 'effect';
import { settle } from '../obs/effect';
import type { VFS } from '../types/primitives';

/** POSIX dirname: '' for a bare name, '/' for a top-level one (a naive `lastIndexOf` slice gets both wrong). */
export function vfsDirname(path: string): string {
  const i = path.lastIndexOf('/');

  if (i < 0) return '';

  return i === 0 ? '/' : path.slice(0, i);
}

export function vfsBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Idempotent mkdir: swallows "already exists" errors; others propagate. */
export async function ensureDir(vfs: Pick<VFS, 'mkdir'>, dir: string): Promise<void> {
  return settle(Effect.tryPromise({ try: async () => { await vfs.mkdir(dir, { recursive: true }); }, catch: (cause) => ({ cause }) }).pipe(
    // A remote environment may surface EEXIST even with `recursive: true`.
    Effect.catchIf(({ cause }) => {
      const msg = cause instanceof Error ? cause.message.toLowerCase() : '';

      return msg.includes('exist') || msg.includes('eexist');
    }, () => Effect.void),
    Effect.catch((failed) => Effect.die(failed.cause)),
  ));
}
