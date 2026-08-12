/**
 * The executor file plane — one read/write surface over every executor.
 *
 * ONE plane for both directions: every executor's files are reached through
 * the CompositeVFS. Workspace paths are composite-addressed already; other
 * executors' env-native paths map onto their mount prefix
 * (EXECUTOR_MOUNT_PREFIX), landing on the same raw handle the executor's tools
 * use — structured bytes and entries, never the executors' lossy LLM tool
 * strings. Unavailable mounts surface the composite's honest reservation
 * error.
 *
 * Errors are values here, not throws: a file browser asking for a path on an
 * offline mount wants the reason rendered in the pane, not a failed RPC.
 */

import { EXECUTOR_MOUNT_PREFIX } from '../vfs/composite.js';
import type { VFS } from '../types/primitives.js';

/** One directory entry, normalized across executors (each provider's readdir
 *  has its own format). */
export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
}

/** What a write needs — the composite VFS, binary-safe on every mount. */
export interface ExecutorWriteDeps {
  vfs: { writeFile(path: string, data: Uint8Array | string): Promise<void> };
}

export type ExecutorWriteResult = { ok: true } | { error: string };

/** Read cap for the file viewer — past this the content is carried truncated. */
const MAX_VIEWABLE_BYTES = 512 * 1024;

/**
 * Map an (executorId, environment-native path) to its CompositeVFS address.
 * The workspace executor IS the composite, so its paths pass through; every
 * other executor maps through its mount prefix. Returns null for an executor
 * with no file plane (unknown id).
 */
export function toCompositePath(executorId: string, path: string): string | null {
  if (executorId === 'workspace') return path;
  const prefix = EXECUTOR_MOUNT_PREFIX[executorId];
  if (!prefix) return null;
  return `${prefix}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Directories first, then files; alphabetical within each group. */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Typed directory listing for a file manager — straight off the CompositeVFS
 *  for every executor (accurate types + sizes). */
export async function getExecutorFiles(
  vfs: VFS,
  executorId: string,
  path: string,
): Promise<{ entries?: DirEntry[]; error?: string }> {
  const dir = toCompositePath(executorId, path || '/');
  if (dir === null) return { error: `Executor "${executorId}" not found` };
  try {
    const names = await vfs.readdir(dir);
    const entries: DirEntry[] = [];
    for (const name of names) {
      const full = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
      // Entries of the composite root are mounts — directories by
      // construction, even when the environment behind one can't answer a
      // stat right now.
      let type: DirEntry['type'] = dir === '/' ? 'dir' : 'file';
      let size: number | undefined;
      try { const s = await vfs.stat(full); if (s) { type = s.isDir ? 'dir' : 'file'; size = s.size; } }
      catch { /* unstattable — keep the default */ }
      entries.push({ name, type, size });
    }
    return { entries: sortDirEntries(entries) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** One file's text content for the viewer. Caps size and refuses binary. */
export async function readExecutorFile(
  vfs: VFS,
  executorId: string,
  path: string,
): Promise<{ content?: string; truncated?: boolean; error?: string }> {
  if (!path) return { error: 'path required' };
  const target = toCompositePath(executorId, path);
  if (target === null) return { error: `Executor "${executorId}" not found` };
  try {
    const stat = await vfs.stat(target);
    if (stat?.isDir) return { error: 'path is a directory' };
    const raw = await vfs.readFile(target, { encoding: 'utf8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    if (text.includes(String.fromCharCode(0))) return { error: 'binary file — not previewable' };
    if (text.length > MAX_VIEWABLE_BYTES) return { content: text.slice(0, MAX_VIEWABLE_BYTES), truncated: true };
    return { content: text };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write one uploaded file into an executor — binary-safe through the same
 * composite plane the reads use.
 *
 * Raw bytes, and no size cap. Uploads arrive over a transport with no frame
 * ceiling and need no encoding, and the workspace VFS chunks what it stores —
 * so there is nothing left for an app-level limit to protect, and the one that
 * used to be here sat ABOVE the transport's real ceiling anyway.
 */
export async function writeExecutorFileOp(
  deps: ExecutorWriteDeps,
  executorId: string,
  path: string,
  bytes: Uint8Array,
): Promise<ExecutorWriteResult> {
  if (!path || path.endsWith('/')) return { error: 'file path required' };
  const target = toCompositePath(executorId, path);
  if (target === null) return { error: `Executor "${executorId}" not found` };
  try {
    await deps.vfs.writeFile(target, bytes);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
