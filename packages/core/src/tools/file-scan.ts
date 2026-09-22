/**
 * Reading a file's text without making the file resident.
 *
 * The saving is MEMORY, not I/O. Every byte is still fetched and hashed,
 * because the read ledger keys on the fingerprint of the WHOLE content;
 * what changes is that peak residency is one chunk plus the requested
 * window, whatever the file's size, instead of the file plus a copy of the
 * window.
 *
 * Fingerprinting only the window, or keying the ledger on size and mtime,
 * was rejected: either would let an edit land against a file that changed
 * outside the lines the model read, which is the failure read-before-write
 * exists to stop.
 */

import * as v from 'valibot';
import { Fnv1a64 } from '../utils/fnv1a';
import type { VFS, VfsRevision } from '../types/primitives';
import type { VfsNativeReads } from '../vfs/mounts';
import { isVfsError, makeVfsError } from '../vfs/errno';
import { RESIDENT_TEXT_MAX_BYTES } from '../vfs/mounts';
import { BOM, FileRefusalError, type SliceWindow } from './file-edit';

/**
 * Bytes fetched per ranged read, and therefore the scan's resident ceiling
 * over and above the window it keeps. Deliberately NOT the transfer plane's
 * `FILE_CHUNK_BYTES` (8 MiB), which sizes one RPC payload moving a whole
 * file: adopting it would reintroduce megabytes of residency to save round
 * trips this path does not care about.
 */
const SCAN_CHUNK_BYTES = 64 * 1024;

/** One scanned file: the window the formatter renders, and the fingerprint the
 *  read ledger keys on. */
export interface ScannedFile {
  readonly window: SliceWindow;
  /** The plane's revision of the scanned bytes, when it names one. */
  readonly revision: VfsRevision | undefined;
  /** `fnv1a64` of the file's ENTIRE text, byte-order mark included, identical
   *  to hashing the string a whole-file read would have produced — which is
   *  what lets a scanned read and a later edit agree on what was seen. */
  readonly fingerprint: string;
}

/**
 * A file's text, whole.
 *
 * A VFS is free to answer `{encoding:'utf8'}` with bytes; decoding beats an
 * unchecked cast that would throw out of `execute`. `ignoreBOM` keeps the
 * byte-order mark, because the planes that answer with a STRING keep it: a
 * decoder that dropped it would give an edit a different fingerprint from the
 * read that authorized it, and would write the file back with its BOM gone.
 */
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

/** A bounded prefix of a file: the text, how many bytes it came from, and the
 *  size the plane reported for the whole file (null where it reported none). */
export interface FileHead {
  readonly text: string;
  readonly bytes: number;
  readonly total: number | null;
}

/**
 * A file's leading `maxBytes` as text.
 *
 * For the callers that scan CONTENT rather than render a window: they need the
 * text, they do not need the whole file, and the file's size is chosen by
 * whoever put it in the workspace. The plane's own ranged read fetches at most
 * the budget, one chunk at a time, so a gigabyte log costs the budget.
 *
 * A plane WITHOUT a ranged read falls back to {@link readUnranged}, which
 * refuses a file over the resident budget instead of fetching it to slice —
 * the same refusal a windowed read gets, for the same reason.
 *
 * `bytes` is what was actually read rather than what was asked for, because a
 * ranged read is free to answer short; `total` is the stat, so a caller can
 * tell a file that ENDED from one that was cut.
 */
export async function readFileHead(vfs: VFS, path: string, maxBytes: number): Promise<FileHead> {
  const stat = await vfs.stat(path);
  // The plane's own ranged read, where it declares one — a widening
  // assignment for the reason `scanFileWindow` gives above.
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

/**
 * Scan `path` and return the line window `opts` asks for plus the fingerprint
 * of everything.
 *
 * Errors propagate: a missing file, a denied read, a plane that fell over
 * mid-scan. Nothing partial is returned and nothing is recorded anywhere, so
 * a caller cannot end up with a ledger entry for a read that did not complete.
 */
export async function scanFileWindow(
  vfs: VFS,
  path: string,
  opts: { offset?: number | undefined; limit?: number | undefined; maxChars: number },
): Promise<ScannedFile> {
  const scan = beginScan(opts);
  // One stat before and, when the plane has an authoritative revision, one
  // after: a chunked scan is not the atomic snapshot a whole-file read was, so
  // a file rewritten underneath it would otherwise be reported as a coherent
  // version that never existed. Size and mtime are NOT consulted for this —
  // a same-size, same-mtime write is still a different file.
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

  // The plane's own ranged read, where it declares one. A widening assignment,
  // not a cast: the member is optional, and the planes that have it
  // (execution/{nimbus,sandbox}.ts, vfs/nimbus-workspace.ts, the routed tree in
  // vfs/mounts.ts) carry exactly this signature.
  const probed: VFS & Partial<VfsNativeReads> = vfs;
  const ranged = probed.readRange;

  // Without immutable reads, the scanned bytes must still name one revision.
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

/**
 * Feed the whole file through the plane's ranged read, one chunk at a time.
 *
 * `false` means this path has no ranged read after all: the routed tree
 * (vfs/mounts.ts) declares ONE `readRange` for every plane under it and
 * answers ENOTSUP where there is none, so only the first window can answer
 * the capability question — and answering it costs a refused call, not a
 * read of the file.
 */
async function feedRanges(
  scan: { feed(text: string): void },
  vfs: VFS,
  ranged: VfsNativeReads['readRange'],
  path: string,
): Promise<boolean> {
  // `ignoreBOM` for the same reason `readFileText` uses it: the mark belongs
  // to the file and therefore to its fingerprint.
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
 * The whole file, for a plane that serves no ranged read, and only within the
 * resident-text budget every bounded view in the tree shares
 * (`vfs/mounts.ts`). Over budget there is deliberately no fallback: fetching
 * the file to slice it is the allocation this path exists to prevent.
 *
 * The stat ADMITS the read; it does not promise what comes back. A file can
 * grow between the two, and a plane with no ranged read offers no way to ask
 * for less — by the time the length is knowable the provider has already
 * allocated it, and nothing here can prevent that. What the checks after the
 * read refuse is carrying an over-budget result any further, with no retry
 * and no invented revision. Planes that DO serve ranges never reach this.
 */
async function readUnranged(vfs: VFS, path: string, size: number | null): Promise<string> {
  const refuse = (what: string): never => {
    throw makeVfsError('EPERM',
      `this file plane has no ranged read, so ${what} cannot be read within `
      + `${String(RESIDENT_TEXT_MAX_BYTES)} — read or slice it with workspace.readFile inside eval`,
      path);
  };

  if (size === null) {
    // A path the plane could not stat is usually a path that is not there,
    // and answering a typo with a lecture about ranged reads would send the
    // model looking for the wrong problem.
    if (!await vfs.exists(path)) throw makeVfsError('ENOENT', `no such file, open '${path}'`, path);

    return refuse('a file of unknown size');
  }

  if (size > RESIDENT_TEXT_MAX_BYTES) return refuse(`${String(size)} bytes`);
  const text = await readFileText(vfs, path);

  // The budget is in BYTES, and characters are not bytes: 300k CJK characters
  // are 900k bytes and would sail past a character count. The cheap test runs
  // first only to BOUND the exact one — UTF-8 never spends fewer bytes than
  // characters, so a string already over the budget needs no measuring, and
  // one that is not costs at most three bytes per character to measure.
  if (text.length > RESIDENT_TEXT_MAX_BYTES) return refuse(`${String(text.length)} characters`);
  const bytes = new TextEncoder().encode(text).byteLength;

  return bytes > RESIDENT_TEXT_MAX_BYTES ? refuse(`${String(bytes)} bytes`) : text;
}

/**
 * The line scanner: text in, one `SliceWindow` out.
 *
 * Chunk boundaries fall wherever the plane's reads and the decoder's
 * multi-byte buffering put them, never on line boundaries, so every count is
 * accumulated as characters go past rather than derived afterwards from what
 * was kept. That is the correctness argument: `requestedLines`,
 * `requestedChars` and `firstLineChars` describe the ORIGINAL file while
 * `lines` holds only what fits, and a formatter inferring the former from the
 * latter would report a truncated read as a complete one.
 */
function beginScan(opts: { offset?: number | undefined; limit?: number | undefined; maxChars: number }) {
  const first = Math.max(1, Math.floor(opts.offset ?? 1));
  // A limit is a count of lines, so anything under one line is one line; left
  // as given it would ask for an empty range, which has no honest rendering.
  const limit = opts.limit != null ? Math.max(1, Math.floor(opts.limit)) : undefined;
  const lastWanted = limit === undefined ? Number.POSITIVE_INFINITY : first + limit - 1;
  const { maxChars } = opts;
  const hash = new Fnv1a64();

  /** The display stream drops ONE leading byte-order mark — it is invisible,
   *  so a model copying the first line back as `old_text` would carry it and
   *  never match. The hash above sees it, because the file contains it. */
  let bomPending = true;
  /** 1-indexed line currently being accumulated. */
  let line = 1;
  let total = 0;
  let unterminated = false;
  /** Length of the line being accumulated, and its leading `maxChars`
   *  characters where the window still wants them. */
  let pendingChars = 0;
  let pendingHead = '';

  const lines: string[] = [];
  let keptChars = 0;
  let requestedLines = 0;
  let requestedChars = 0;
  let firstLineChars = 0;
  /** False once a requested line did not fit: everything after it is counted
   *  and discarded, exactly as a whole-string slice would have dropped it. */
  let accepting = true;
  let retaining = first === 1;

  /** One completed line, offered to the window. */
  const record = (): void => {
    if (line < first || line > lastWanted) return;
    requestedLines++;
    requestedChars += requestedLines === 1 ? pendingChars : pendingChars + 1;

    if (requestedLines === 1) firstLineChars = pendingChars;

    if (!accepting) return;
    // The joining newline costs a character for every line after the first —
    // keyed on the line COUNT, not on the running total, so a leading blank
    // line does not make the next one look free.
    const cost = lines.length === 0 ? pendingChars : pendingChars + 1;

    if (keptChars + cost <= maxChars) {
      lines.push(pendingHead);
      keptChars += cost;

      return;
    }

    // One line, on its own, larger than the whole budget: its head is kept so
    // the formatter can show it and say how much it did not show.
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
      // A trailing newline ENDS the last line rather than starting a phantom
      // one, so only a non-empty remainder is a further line.
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
