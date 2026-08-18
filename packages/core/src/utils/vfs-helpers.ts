// Tiny VFS helpers shared across modules.
import type { VFS } from '../types/primitives';

/** The directory part of a VFS path, POSIX-style: '' for a bare name, '/' for a
 *  top-level one. Shared because `path.slice(0, path.lastIndexOf('/'))` is
 *  wrong for both of those cases — on a bare name lastIndexOf returns -1 and
 *  the slice silently drops the last character. */
export function vfsDirname(path: string): string {
  const i = path.lastIndexOf('/');
  if (i < 0) return '';
  return i === 0 ? '/' : path.slice(0, i);
}

/** Idempotent mkdir — swallows "already exists" errors so callers don't
 *  need a try/catch around every call. Other errors propagate.
 *  Only depends on `mkdir`, so it accepts any VFS-like value that has it
 *  (e.g. the SKILL.md export's MinimalVFS) without forcing a cast. */
export async function ensureDir(vfs: Pick<VFS, 'mkdir'>, dir: string): Promise<void> {
  try {
    await vfs.mkdir(dir, { recursive: true });
  } catch (err) {
    // mkdir({recursive:true}) is a no-op when the directory exists on the
    // workspace filesystem, but a remote environment's may surface EEXIST.
    // Re-throw if it's clearly not an "exists" error.
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (!msg.includes('exist') && !msg.includes('eexist')) throw err;
  }
}
