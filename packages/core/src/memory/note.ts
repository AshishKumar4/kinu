/** The one note-save primitive: appends a dated `### Note` heading to `memory/MEMORY.md`, then indexes it. */

import type { VFS, Memory } from '../types/primitives';

const MEMORY_PATH = 'memory/MEMORY.md';

/** Only files under this directory are FTS5 indexed. */
const MEMORY_DIR = 'memory/';

/** Accepts `memory/a.md` and `/memory/a.md` alike; null outside the memory directory. */
export function memoryIndexPath(vfsPath: string): string | null {
  const relative = vfsPath.replace(/^\/+/, '').replace(/^local\//, '');

  return relative.startsWith(MEMORY_DIR) ? relative : null;
}

export const MEMORY_TAIL_MAX_CHARS = 2000;

/**
 * Newest `maxChars` of MEMORY.md, woven into dynamic context (never the cached prefix). The tail window
 * covers 3 bytes per UTF-16 unit plus 3 shed continuation bytes, so it decodes to at least `maxChars` units.
 */
export async function readMemoryTail(memory: Memory, maxChars = MEMORY_TAIL_MAX_CHARS): Promise<string | undefined> {
  const tail = (await memory.tail(MEMORY_PATH, maxChars * 3 + 3))?.slice(-maxChars);

  return tail && tail.length > 0 ? tail : undefined;
}

export async function appendMemoryNote(
  memory: Memory,
  content: string,
  options?: { heading?: string; date?: string; by?: string },
): Promise<string> {
  const date = options?.date ?? new Date().toISOString().split('T')[0];
  const heading = options?.heading ?? 'Note';
  const stamp = options?.by === undefined ? date : `${date} · ${options.by}`;
  await memory.append(MEMORY_PATH, `\n### ${heading} (${stamp})\n${content}\n`);
  await memory.index(MEMORY_PATH);

  return 'Note saved to memory.';
}

/** Lookahead keeps the `##`/`###` heading with its body. */
const NOTE_BOUNDARY = /\n(?=###|##)/;

const HEADING_HASHES = /^#+\s*/;

/** The last parenthesised span is the stamp, so titles may contain parentheses. */
const HEADING_STAMP = /\(([^()]*)\)\s*$/;

export interface MemoryNote {
  path: string;
  content: string;
  /** Falls back to the whole heading when unstamped. */
  updatedAt: string;
  /** Null when the stamp names no actor. */
  savedBy: string | null;
}

/** Inverse of {@link appendMemoryNote}, oldest first, and the only reader of its heading. Empty sections are dropped. */
export function parseMemoryNotes(content: string): MemoryNote[] {
  const notes: MemoryNote[] = [];

  for (const section of content.split(NOTE_BOUNDARY)) {
    const lines = section.trim().split('\n');
    const heading = (lines[0] ?? '').replace(HEADING_HASHES, '');
    const body = lines.slice(1).join('\n').trim();

    if (heading === '' || body === '') continue;
    const [when, savedBy] = HEADING_STAMP.exec(heading)?.[1].split('·').map((part) => part.trim()) ?? [];

    notes.push({ path: MEMORY_PATH, content: body, updatedAt: when ?? heading, savedBy: savedBy ?? null });
  }

  return notes;
}

/** Walks the filesystem so the size matches the files the user can open, not the storage encoding. */
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
