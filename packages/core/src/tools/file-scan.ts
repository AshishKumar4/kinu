import { exists, type Awaitable, type VFS, type VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Reads a file's text without making it resident. Every byte is still hashed: the read ledger keys on
 * the whole-content fingerprint, so an edit cannot land against lines changed outside the read window.
 */

import { Effect } from 'effect';

import { settle } from '../obs/index';
import { Fnv1a64 } from '../utils/fnv1a';


import { isVfsError, syscallError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { RESIDENT_TEXT_MAX_BYTES } from '../vfs/mounts';
import { BOM, type SliceWindow } from './file-edit';
import { FileRefusalError } from '../types/file-edits';

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
export function readFileText(vfs: VFS, path: string, revision?: VfsRevision): Promise<string> {
  return settle(fileText(vfs, path, revision));
}

function fileText(vfs: VFS, path: string, revision?: VfsRevision): Effect.Effect<string> {
  const historical = vfs.readFileAtRevision?.bind(vfs);

  if (revision !== undefined && !historical) return Effect.die(syscallError('ENOTSUP', 'open', path, { detail: 'this file plane does not retain file revisions' }));

  return Effect.map(Effect.promise(async () => (revision !== undefined && historical
    ? historical.call(vfs, path, revision)
    : vfs.readFile(path))), (bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
}

function rangedChunk(read: () => Awaitable<Uint8Array>, first: boolean): Effect.Effect<Uint8Array | null> {
  return Effect.tryPromise({ try: async () => read(), catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => (first && isVfsError(failed.cause) && failed.cause.code === 'ENOTSUP'
      ? Effect.succeed(null)
      : Effect.die(failed.cause))),
  );
}

/** A bounded prefix: text, bytes read, and the plane-reported total size (null if none). */
export interface FileHead {
  readonly text: string;
  readonly bytes: number;
  readonly total: number | null;
}

/**
 * A file's leading `maxBytes` as text. Planes without a ranged read fall back to {@link unrangedText},
 * which refuses over-budget files. `bytes` is what was read; `total` is the stat.
 */
export function readFileHead(vfs: VFS, path: string, maxBytes: number): Promise<FileHead> {
  return settle(Effect.gen(function* () {
    const stat = yield* Effect.promise(async () => vfs.stat(path));

    if (stat === null) return yield* Effect.die(syscallError('ENOENT', 'open', path));
    const total = stat.size;
    const ranged = vfs.readRange?.bind(vfs);

    const whole = (text: string): FileHead => ({ text, bytes: new TextEncoder().encode(text).byteLength, total });

    if (ranged === undefined) return whole(yield* unrangedText(vfs, path, total));

    const decode = new TextDecoder('utf-8', { ignoreBOM: true });
    let at = 0;
    let text = '';

    while (at < maxBytes) {
      const offset = at;
      const chunk = yield* rangedChunk(() => ranged.call(vfs, path, offset, Math.min(SCAN_CHUNK_BYTES, maxBytes - offset)), offset === 0);

      if (chunk === null) return whole(yield* unrangedText(vfs, path, total));

      if (chunk.length === 0) break;
      at += chunk.length;
      text += decode.decode(chunk, { stream: true });
    }

    const head: FileHead = { text: text + decode.decode(), bytes: at, total };

    return head;
  }));
}

/** Scan `path` for the window `opts` asks for plus the whole-file fingerprint. Errors propagate; nothing partial is returned. */
export async function scanFileWindow(
  vfs: VFS,
  path: string,
  opts: { offset?: number | undefined; limit?: number | undefined; maxChars: number },
): Promise<ScannedFile> {
  return settle(Effect.gen(function* () {
    const scan = beginScan(opts);
    // A chunked scan is not atomic: re-stat after when the plane has a revision. Size and mtime do not detect rewrites.
    const before = yield* Effect.promise(async () => vfs.stat(path));

    if (before === null) return yield* Effect.die(syscallError('ENOENT', 'open', path));
    const revision = before?.revision;
    const historical = vfs.readFileAtRevision?.bind(vfs);

    if (revision !== undefined && historical !== undefined) {
      const pinned = yield* feedRanges(scan, vfs, (file, offset, length) => historical.call(vfs, file, revision, { offset, length }), path);

      if (pinned) return scan.done(revision);
    }

    const ranged = vfs.readRange?.bind(vfs);

    if (!ranged || !(yield* feedRanges(scan, vfs, ranged, path))) {
      scan.feed(yield* unrangedText(vfs, path, before?.size ?? null));
    }

    const after = before?.revision === undefined ? undefined : (yield* Effect.promise(async () => vfs.stat(path)))?.revision;

    if (before?.revision !== undefined && after !== before.revision) {
      return yield* Effect.die(new FileRefusalError('stale',
        `${path} changed while it was being read, so what came back would be part of one version and `
        + `part of another. Read it again (op=read path=${path}).`));
    }

    return scan.done(before?.revision);
  }));
}

/** Feed the file through the ranged read in chunks. `false`: the first window answered ENOTSUP (vfs/mounts.ts). */
function feedRanges(
  scan: { feed(text: string): void },
  vfs: VFS,
  ranged: NonNullable<VFS['readRange']>,
  path: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    // `ignoreBOM`: the mark belongs to the fingerprint.
    const decode = new TextDecoder('utf-8', { ignoreBOM: true });

    for (let at = 0; ; ) {
      const offset = at;
      const chunk = yield* rangedChunk(() => ranged.call(vfs, path, offset, SCAN_CHUNK_BYTES), offset === 0);

      if (chunk === null) return false;

      if (chunk.length === 0) break;
      at += chunk.length;
      scan.feed(decode.decode(chunk, { stream: true }));
    }

    scan.feed(decode.decode());

    return true;
  });
}

/**
 * The whole file for a plane with no ranged read, only within the shared resident-text budget
 * (`vfs/mounts.ts`). The stat admits the read; over-budget results are still refused after it.
 */
function unrangedText(vfs: VFS, path: string, size: number | null): Effect.Effect<string> {
  const refuse = (what: string): Effect.Effect<never> => Effect.die(syscallError('EPERM', 'read', path, {
    detail: `this file plane has no ranged read, so ${what} cannot be read within `
      + `${String(RESIDENT_TEXT_MAX_BYTES)}: read or slice it with workspace.readFile inside eval`,
  }));

  return Effect.gen(function* () {
    if (size === null) {
      // An unstattable path is usually missing; do not answer it with a ranged-read error.
      if (!(yield* Effect.promise(() => exists(vfs, path)))) return yield* Effect.die(syscallError('ENOENT', 'open', path));

      return yield* refuse('a file of unknown size');
    }

    if (size > RESIDENT_TEXT_MAX_BYTES) return yield* refuse(`${String(size)} bytes`);
    const text = yield* fileText(vfs, path);

    // Budget is in bytes. UTF-8 never uses fewer bytes than characters, so the length check only bounds the exact one.
    if (text.length > RESIDENT_TEXT_MAX_BYTES) return yield* refuse(`${String(text.length)} characters`);
    const bytes = new TextEncoder().encode(text).byteLength;

    return bytes > RESIDENT_TEXT_MAX_BYTES ? yield* refuse(`${String(bytes)} bytes`) : text;
  });
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
