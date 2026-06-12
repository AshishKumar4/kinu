// Tiny VFS helpers shared across modules.
import type { VFS } from '../types/primitives.js';

/** Idempotent mkdir — swallows "already exists" errors so callers don't
 *  need a try/catch around every call. Other errors propagate.
 *  Only depends on `mkdir`, so it accepts any VFS-like value that has it
 *  (e.g. the SKILL.md export's MinimalVFS) without forcing a cast. */
export async function ensureDir(vfs: Pick<VFS, 'mkdir'>, dir: string): Promise<void> {
  try {
    await vfs.mkdir(dir, { recursive: true });
  } catch (err) {
    // mkdir({recursive:true}) on the SqliteFS impl is a no-op when the
    // directory exists, but external VFSes (Node fs, R2) may surface
    // EEXIST. Re-throw if it's clearly not a "exists" error.
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (!msg.includes('exist') && !msg.includes('eexist')) throw err;
  }
}
