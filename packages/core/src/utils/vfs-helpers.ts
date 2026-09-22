import type { VFS } from '../types/primitives';

/** POSIX dirname: '' for a bare name, '/' for a top-level one (a naive `lastIndexOf` slice gets both wrong). */
export function vfsDirname(path: string): string {
  const i = path.lastIndexOf('/');

  if (i < 0) return '';

  return i === 0 ? '/' : path.slice(0, i);
}

/** Idempotent mkdir: swallows "already exists" errors; others propagate. */
export async function ensureDir(vfs: Pick<VFS, 'mkdir'>, dir: string): Promise<void> {
  try {
    await vfs.mkdir(dir, { recursive: true });
  } catch (err) {
    // A remote environment may surface EEXIST even with `recursive: true`.
    const msg = err instanceof Error ? err.message.toLowerCase() : '';

    if (!msg.includes('exist') && !msg.includes('eexist')) throw err;
  }
}
