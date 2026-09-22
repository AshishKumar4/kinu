/**
 * Reads a file's text without making it resident. Every byte is still hashed: the read ledger keys on
 * the whole-content fingerprint, so an edit cannot land against lines changed outside the read window.
 */

import * as v from 'valibot';
import { Fnv1a64 } from '../utils/fnv1a';
import type { VFS, VfsRevision } from '../types/primitives';
import type { VfsNativeReads } from '../vfs/mounts';
import { isVfsError, makeVfsError } from '../vfs/errno';
import { RESIDENT_TEXT_MAX_BYTES } from '../vfs/mounts';
import { BOM, FileRefusalError, type SliceWindow } from './file-edit';

/** Bytes per ranged read (the scan's resident ceiling); intentionally smaller than `FILE_CHUNK_BYTES`. */
const SCAN_CHUNK_BYTES = 64 * 1024;

/** One scanned file: the rendered window and the ledger fingerprint. */
export interface ScannedFile {
  readonly window: SliceWindow;
  readonly revision: VfsRevision | undefined;
  /** `fnv1a64` of the entire text, BOM included; equals hashing a whole-file read. */
  readonly fingerprint: string;
}

/** A file's whole text. `ignoreBOM` keeps the BOM so the fingerprint matches string-returning planes. */
export async function readFileText(vfs: VFS, path: string, revision?: VfsRevision): Promise<string> {
  if (revision !== undefined && !vfs.readFileAtRevision) throw makeVfsError('ENOTSUP', 'this file plane does not retain file revisions', path);

  const raw = revision !== undefined && vfs.readFileAtRevision
    ? await vfs.readFileAtRevision(path, revision)
    : await vfs.readFile(path, { encoding: 'utf8' });

  const text = v.safeParse(v.string(), raw);

  return text.success
    ? text.output
    : new TextDecoder('utf-8', { ignoreBOM: true }).decode(v.parse(v.instance(Uint8Array), raw));
}

/** A bounded prefix: text, bytes read, and the plane-reported total size (null if none). */
export interface FileHead {
  readonly text: string;
  readonly bytes: number;
  readonly total: number | null;
}

/**
 * A file's leading `maxBytes` as text. Planes without a ranged read fall back to {@link readUnranged},
 * which refuses over-budget files. `bytes` is what was read; `total` is the stat.
 */
export async function readFileHead(vfs: VFS, path: string, maxBytes: number): Promise<FileHead> {
  const stat = await vfs.stat(path);
  const probed: VFS & Partial<VfsNativeReads> = vfs;
  const ranged = probed.readRange;

  if (ranged === undefined) {
    const text = await readUnranged(vfs, path, stat?.size ?? null);

    return { text, bytes: new TextEncoder().encode(text).byteLength, total: stat?.size ?? null };
  }

  const decode = new TextDecoder('utf-8', { ignoreBOM: true });
  let at = 0;
  let text = '';

  while (at < maxBytes) {
    let chunk: Uint8Array;

    try {
      chunk = await ranged.call(vfs, path, at, Math.min(SCAN_CHUNK_BYTES, maxBytes - at));
    } catch (cause) {
      if (at === 0 && isVfsError(cause) && cause.code === 'ENOTSUP') {
        const whole = await readUnranged(vfs, path, stat?.size ?? null);

        return { text: whole, bytes: new TextEncoder().encode(whole).byteLength, total: stat?.size ?? null };
      }

      throw cause;
    }

    if (chunk.length === 0) break;
    at += chunk.length;
    text += decode.decode(chunk, { stream: true });
  }

  return { text: text + decode.decode(), bytes: at, total: stat?.size ?? null };
}

/** Scan `path` for the window `opts` asks for plus the whole-file fingerprint. Errors propagate; nothing partial is returned. */
export async function scanFileWindow(
  vfs: VFS,
  path: string,
  opts: { offset?: number | undefined; limit?: number | undefined; maxChars: number },
): Promise<ScannedFile> {
  const scan = beginScan(opts);
  // A chunked scan is not atomic: re-stat after when the plane has a revision. Size and mtime do not detect rewrites.
  const before = await vfs.stat(path);
  const revision = before?.revision;
  const historical = vfs.readFileAtRevision;

  if (revision !== undefined && historical !== undefined) {
    const pinned = await feedRanges(scan, vfs, async (file, offset, length) => {
      const result = await historical.call(vfs, file, revision, { offset, length });

      return v.is(v.string(), result) ? new TextEncoder().encode(result) : result;
    }, path);

    if (pinned) return scan.done(revision);
  }

  // Widening assignment, not a cast: the optional member has exactly this signature where present.
  const probed: VFS & Partial<VfsNativeReads> = vfs;
  const ranged = probed.readRange;

  if (!ranged || !await feedRanges(scan, vfs, ranged, path)) {
    scan.feed(await readUnranged(vfs, path, before?.size ?? null));
  }

  if (before?.revision !== undefined && (await vfs.stat(path))?.revision !== before.revision) {
    throw new FileRefusalError('stale',
      `${path} changed while it was being read, so what came back would be part of one version and `
      + `part of another. Read it again (action=read path=${path}).`);
  }

  return scan.done(before?.revision);
}

/** Feed the file through the ranged read in chunks. `false`: the first window answered ENOTSUP (vfs/mounts.ts). */
async function feedRanges(
  scan: { feed(text: string): void },
  vfs: VFS,
  ranged: VfsNativeReads['readRange'],
  path: string,
): Promise<boolean> {
  // `ignoreBOM`: the mark belongs to the fingerprint.
  const decode = new TextDecoder('utf-8', { ignoreBOM: true });

  for (let at = 0; ; ) {
    let chunk: Uint8Array;

    try {
      chunk = await ranged.call(vfs, path, at, SCAN_CHUNK_BYTES);
    } catch (cause) {
      if (at === 0 && isVfsError(cause) && cause.code === 'ENOTSUP') return false;
      throw cause;
    }

    if (chunk.length === 0) break;
    at += chunk.length;
    scan.feed(decode.decode(chunk, { stream: true }));
  }

  scan.feed(decode.decode());

  return true;
}

/**
 * The whole file for a plane with no ranged read, only within the shared resident-text budget
 * (`vfs/mounts.ts`). The stat admits the read; over-budget results are still refused after it.
 */
async function readUnranged(vfs: VFS, path: string, size: number | null): Promise<string> {
  const refuse = (what: string): never => {
    throw makeVfsError('EPERM',
      `this file plane has no ranged read, so ${what} cannot be read within `
      + `${String(RESIDENT_TEXT_MAX_BYTES)} — read or slice it with workspace.readFile inside eval`,
      path);
  };

  if (size === null) {
    // An unstattable path is usually missing; do not answer it with a ranged-read error.
    if (!await vfs.exists(path)) throw makeVfsError('ENOENT', `no such file, open '${path}'`, path);

    return refuse('a file of unknown size');
  }

  if (size > RESIDENT_TEXT_MAX_BYTES) return refuse(`${String(size)} bytes`);
  const text = await readFileText(vfs, path);

  // Budget is in bytes. UTF-8 never uses fewer bytes than characters, so the length check only bounds the exact one.
  if (text.length > RESIDENT_TEXT_MAX_BYTES) return refuse(`${String(text.length)} characters`);
  const bytes = new TextEncoder().encode(text).byteLength;

  return bytes > RESIDENT_TEXT_MAX_BYTES ? refuse(`${String(bytes)} bytes`) : text;
}

/**
 * The line scanner. Chunks do not align with lines, so `requestedLines`, `requestedChars` and
 * `firstLineChars` are accumulated to describe the original file, not the kept `lines`.
 */
function beginScan(opts: { offset?: number | undefined; limit?: number | undefined; maxChars: number }) {
  const first = Math.max(1, Math.floor(opts.offset ?? 1));
  // A limit under one line means one line.
  const limit = opts.limit != null ? Math.max(1, Math.floor(opts.limit)) : undefined;
  const lastWanted = limit === undefined ? Number.POSITIVE_INFINITY : first + limit - 1;
  const { maxChars } = opts;
  const hash = new Fnv1a64();

  /** The display stream drops one leading BOM so a copied first line matches `old_text`; the hash keeps it. */
  let bomPending = true;
  let line = 1;
  let total = 0;
  let unterminated = false;
  let pendingChars = 0;
  let pendingHead = '';

  const lines: string[] = [];
  let keptChars = 0;
  let requestedLines = 0;
  let requestedChars = 0;
  let firstLineChars = 0;
  /** False once a requested line did not fit; later lines are counted and discarded. */
  let accepting = true;
  let retaining = first === 1;

  const record = (): void => {
    if (line < first || line > lastWanted) return;
    requestedLines++;
    requestedChars += requestedLines === 1 ? pendingChars : pendingChars + 1;

    if (requestedLines === 1) firstLineChars = pendingChars;

    if (!accepting) return;
    // The joining newline is keyed on line count, so a leading blank line still costs one.
    const cost = lines.length === 0 ? pendingChars : pendingChars + 1;

    if (keptChars + cost <= maxChars) {
      lines.push(pendingHead);
      keptChars += cost;

      return;
    }

    // A single line larger than the budget keeps its head for the formatter.
    if (lines.length === 0) lines.push(pendingHead);
    accepting = false;
  };

  const absorb = (text: string, from: number, to: number): void => {
    if (retaining && pendingHead.length < maxChars) {
      pendingHead += text.slice(from, Math.min(to, from + maxChars - pendingHead.length));
    }

    pendingChars += to - from;
  };

  const endLine = (): void => {
    record();
    total++;
    line++;
    pendingChars = 0;
    pendingHead = '';
    retaining = line >= first && line <= lastWanted && accepting;
  };

  return {
    feed(raw: string): void {
      if (raw.length === 0) return;
      hash.update(raw);

      let text = raw;

      if (bomPending) {
        bomPending = false;

        if (text.startsWith(BOM)) text = text.slice(1);

        if (text.length === 0) return;
      }

      for (let pos = 0; ; ) {
        const nl = text.indexOf('\n', pos);

        if (nl === -1) {
          absorb(text, pos, text.length);

          return;
        }

        absorb(text, pos, nl);
        endLine();
        pos = nl + 1;
      }
    },

    done(revision: VfsRevision | undefined): ScannedFile {
      // A trailing newline ends the last line; only a non-empty remainder is another line.
      if (pendingChars > 0) {
        record();
        total++;
        unterminated = true;
      }

      return {
        fingerprint: hash.digest(),
        revision,
        window: {
          first,
          total,
          trailingNewline: total > 0 && !unterminated,
          lines,
          requestedLines,
          requestedChars,
          firstLineChars,
        },
      };
    },
  };
}
