/**
 * appendMemoryNote — the single canonical "save a note to long-term memory"
 * primitive. Three callers converge here:
 *
 *   1. workspace.saveNote(content)        — codemode inline executor
 *   2. memory({action:'save'}) builtin    — Vercel AI SDK ToolSet
 *   3. saveNoteFromMcp(content) RPC       — MCP server bridge
 *
 * All three do the same two things — append a dated `### Note` heading to
 * `memory/MEMORY.md`, then index that file — so both live here once and cannot
 * drift between callers.
 */

import type { VFS, Memory } from '../types/primitives';

const MEMORY_PATH = 'memory/MEMORY.md';

/** The memory store's own directory, VFS-relative. Files under it are FTS5
 *  indexed; files anywhere else are not. */
const MEMORY_DIR = 'memory/';

/**
 * The indexable memory path a VFS write landed on, or null when it landed
 * outside the memory directory.
 *
 * The same file answers to three spellings — `memory/a.md`, `/memory/a.md` and
 * `memory/a.md` — relative to the workspace root,
 * whose mount root is ''. A writer that recognised only one of them left the
 * index stale for the other two, which is the one directory where that is
 * never harmless.
 */
export function memoryIndexPath(vfsPath: string): string | null {
  const relative = vfsPath.replace(/^\/+/, '').replace(/^local\//, '');
  return relative.startsWith(MEMORY_DIR) ? relative : null;
}

/** Default bound on the MEMORY.md tail woven into a turn — enough for the
 *  newest lessons/reflections without unbounding the prompt as the append-only
 *  file grows. */
export const MEMORY_TAIL_MAX_CHARS = 2000;

/**
 * The newest characters of the append-only MEMORY.md — the live
 * lessons/reflections tail both backends weave into the dynamic-context block
 * (never the byte-stable prefix, where every append would bust the cache).
 * Bounded to the file's END because that is where the newest entries land.
 * Undefined when memory is empty. Single source of truth for the path + bound
 * so the cf and CLI weaves cannot drift.
 *
 * Read through the port's tail, so the store hands over a window and not the
 * file: `maxChars` UTF-16 units span at most 3 bytes each, plus the up-to-3
 * continuation bytes a window opening inside a 4-byte sequence sheds. That
 * window always decodes to at least `maxChars` units when the file has them,
 * so the final slice is the same text a whole-file read would have given.
 */
export async function readMemoryTail(memory: Memory, maxChars = MEMORY_TAIL_MAX_CHARS): Promise<string | undefined> {
  const tail = (await memory.tail(MEMORY_PATH, maxChars * 3 + 3))?.slice(-maxChars);
  return tail && tail.length > 0 ? tail : undefined;
}

export async function appendMemoryNote(
  memory: Memory,
  content: string,
  options?: { heading?: string; date?: string },
): Promise<string> {
  const date = options?.date ?? new Date().toISOString().split('T')[0];
  const heading = options?.heading ?? 'Note';
  await memory.append(MEMORY_PATH, `\n### ${heading} (${date})\n${content}\n`);
  await memory.index(MEMORY_PATH);
  return 'Note saved to memory.';
}

/**
 * Bytes the agent's memory occupies, walked through the workspace filesystem.
 *
 * A walk rather than a SUM over a storage table: the number a user is shown
 * should be the size of the files they can open, not of whatever encoding the
 * store happens to use for them.
 */
export async function memoryBytes(vfs: VFS, dir = 'memory'): Promise<number> {
  if (!await vfs.exists(dir)) return 0;
  let total = 0;
  for (const name of await vfs.readdir(dir)) {
    const full = `${dir}/${name}`;
    const st = await vfs.stat(full);
    if (!st) continue;
    total += st.isDir ? await memoryBytes(vfs, full) : st.size;
  }
  return total;
}
