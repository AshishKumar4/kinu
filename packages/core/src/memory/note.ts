import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** The one note-save primitive: appends a dated `### Note` heading to `memory/MEMORY.md`, then indexes it. */

import type { Memory } from '../types/primitives';

export const MEMORY_PATH = 'memory/MEMORY.md';

/** Only files under this directory are FTS5 indexed. */
export const MEMORY_DIR = 'memory/';

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
  // To the millisecond: the sleep-time pass folds the notes written after the last one it folded.
  const date = options?.date ?? new Date().toISOString();
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
  /** The stamp as an instant: a day-only stamp is its day's start; null where the stamp names no date. */
  writtenAt: number | null;
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

    const writtenAt = when === undefined ? Number.NaN : Date.parse(when);

    notes.push({ path: MEMORY_PATH, content: body, updatedAt: when ?? heading, writtenAt: Number.isFinite(writtenAt) ? writtenAt : null, savedBy: savedBy ?? null });
  }

  return notes;
}

/**
 * When the lines of a note file through `endLine` were written, as the file itself says: the date stamped on the last
 * note heading at or above it (`appendMemoryNote`), at day precision. Null where no heading above is stamped.
 */
export function noteDateAt(content: string, endLine: number): number | null {
  const lines = content.split('\n').slice(0, endLine);

  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at] ?? '';

    if (!/^#{2,3}\s/u.test(line)) continue;
    const [when] = HEADING_STAMP.exec(line)?.[1].split('·').map((part) => part.trim()) ?? [];
    const time = when === undefined ? Number.NaN : Date.parse(when);

    if (Number.isFinite(time)) return time;
  }

  return null;
}

/** The notes the agent kept, oldest first, as the sleep-time pass folds them into facts. */
export async function memoryNotes(memory: Pick<Memory, 'read'>): Promise<MemoryNote[]> {
  return parseMemoryNotes(await memory.read(MEMORY_PATH) ?? '');
}

/** Walks the filesystem so the size matches the files the user can open, not the storage encoding. */
export async function memoryBytes(vfs: VFS, dir = 'memory'): Promise<number> {
  if (!await exists(vfs, dir)) return 0;
  let total = 0;

  for (const entry of await vfs.readdir(dir)) {
    const full = `${dir}/${entry.name}`;
    const st = await vfs.stat(full);

    if (!st) continue;
    total += (st.type === 'directory') ? await memoryBytes(vfs, full) : st.size;
  }

  return total;
}
