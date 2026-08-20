/**
 * The exact-match file editor — the text surgery behind the `file` tool's
 * `edit` and `read` actions, with no I/O of its own so it is testable as pure
 * string math and reusable over any VFS.
 *
 * The one property this exists for: an edit that cannot be placed EXACTLY once
 * fails, naming the problem, without touching the file. `sed -i`, an inline
 * `python3 -c` and a heredoc — the three shapes the model actually reaches for
 * today — will all happily write the wrong thing and report success.
 *
 * Deliberately NOT ported from pi's edit-diff.ts: its fuzzy fallback. When pi's
 * exact match misses it re-matches in a normalized space (NFKC, smart quotes,
 * dashes, per-line trimEnd) and then writes the whole file back FROM that
 * normalized space — so one tolerated smart quote in the anchor silently
 * rewrites every unrelated line of the file. That is the corruption class this
 * primitive exists to remove. A non-destructive variant would need an index map
 * back through non-length-preserving normalizations, which is real machinery for
 * a benefit nothing here has measured. A miss instead fails loudly and the model
 * re-reads: one round trip, honest.
 *
 * Line endings and a BOM ARE round-tripped, because that is faithfulness rather
 * than tolerance — matching happens on LF text without the BOM (the model never
 * types an invisible BOM into old_text), and the file is written back in its own
 * ending with its BOM restored.
 */

/** One replacement. Every edit in a call matches the file as it was READ, never
 *  the result of a sibling edit. */
export interface FileEdit {
  oldText: string;
  newText: string;
}

/** Why an edit did not land. Durable counter keys in the `file_edit` run event,
 *  so a benchmark can report exact-match failures by kind. */
export type FileEditFailure =
  /** old_text was empty — an empty anchor matches everywhere. */
  | 'empty_anchor'
  /** old_text is not in the file. */
  | 'not_found'
  /** old_text appears more than once, so the target is a guess. */
  | 'ambiguous'
  /** Two edits in the call cover overlapping text. */
  | 'overlap'
  /** Every replacement produced the text it replaced. */
  | 'no_change';

/** Where one applied edit landed, so the caller can report the change without
 *  echoing a diff back into the context. */
export interface AppliedEdit {
  /** 1-indexed line the match started on, in the file as it was read. */
  line: number;
  removedLines: number;
  addedLines: number;
}

export type FileEditOutcome =
  | { ok: true; content: string; applied: AppliedEdit[] }
  | { ok: false; reason: FileEditFailure; message: string };

/** The byte-order mark. Invisible, so the model never types it into an anchor
 *  and never should be shown one. */
export const BOM = '﻿';

function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlf = content.indexOf('\r\n');
  const lf = content.indexOf('\n');
  // crlf === lf - 1 exactly when the first newline is a CRLF pair.
  return crlf !== -1 && lf !== -1 && crlf < lf ? '\r\n' : '\n';
}

function toLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * LF-normalized text, plus the index in the ORIGINAL of every position in it.
 *
 * Matching happens on LF text — the model never types a `\r` into old_text —
 * but the splice happens on the original, at these indices. That is what keeps
 * a file with mixed endings byte-identical outside the replaced spans; the
 * normalize-edit-and-rewrite shape would quietly convert every unrelated line.
 * `\r\n` is the only place the two diverge: it costs two characters and yields
 * one, so a lone `\r` (same length) needs no special case.
 */
function normalizeWithOrigin(original: string) {
  const chars: string[] = [];
  const origin: number[] = [];
  for (let i = 0; i < original.length; i++) {
    const ch = original[i]!;
    if (ch === '\r') {
      origin.push(i);
      chars.push('\n');
      if (original[i + 1] === '\n') i++;
      continue;
    }
    origin.push(i);
    chars.push(ch);
  }
  // One past the end, so a match's exclusive end index always maps.
  origin.push(original.length);
  return { text: chars.join(''), origin };
}

/** Occurrences counted at EVERY position, overlapping ones included: `aa` sits
 *  in `aaa` twice, and which one the caller meant is exactly the ambiguity this
 *  count exists to refuse. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** Lines a span of text covers. A trailing newline ENDS the last line rather
 *  than starting a phantom one, so `'a\nb\n'` covers two. */
function lineSpan(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Where an edit index is named in a message: silent for a single edit, indexed
 *  when the call carried several, so the model knows WHICH one to fix. */
function at(index: number, total: number): string {
  return total === 1 ? 'old_text' : `edits[${index}].old_text`;
}

/**
 * Apply every edit to `original`, or none of them.
 *
 * All anchors are matched against the file as read; replacements are then
 * applied back-to-front so earlier offsets stay valid. Any anchor that is
 * missing, ambiguous, or overlapping a sibling fails the whole call before a
 * single byte is written.
 */
export function applyFileEdits(original: string, edits: readonly FileEdit[], path: string): FileEditOutcome {
  const hasBom = original.startsWith(BOM);
  const ending = detectLineEnding(original);
  const body = hasBom ? original.slice(1) : original;
  const { text: base, origin } = normalizeWithOrigin(body);

  const anchors = edits.map((edit) => ({ oldText: toLF(edit.oldText), newText: toLF(edit.newText) }));

  const matches: Array<{ index: number; start: number; length: number; newText: string }> = [];
  for (let i = 0; i < anchors.length; i++) {
    const { oldText, newText } = anchors[i]!;
    if (oldText.length === 0) {
      return {
        ok: false,
        reason: 'empty_anchor',
        message: `${at(i, anchors.length)} is empty in ${path}. Give the exact text to replace; use action=write to create or replace the whole file.`,
      };
    }
    const occurrences = countOccurrences(base, oldText);
    if (occurrences === 0) {
      return {
        ok: false,
        reason: 'not_found',
        message:
          `${at(i, anchors.length)} does not appear in ${path}. It must match the file byte for byte, ` +
          'including indentation and blank lines. Read the file again and copy the text from what it returned.',
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        message:
          `${at(i, anchors.length)} appears ${occurrences} times in ${path}, so the target is ambiguous and nothing was changed. ` +
          'Extend it with the surrounding lines until it is unique, or make one edit per occurrence with distinct context.',
      };
    }
    const start = base.indexOf(oldText);
    matches.push({ index: i, start, length: oldText.length, newText });
  }

  const ordered = [...matches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (prev.start + prev.length > cur.start) {
      return {
        ok: false,
        reason: 'overlap',
        message:
          `edits[${prev.index}] and edits[${cur.index}] cover overlapping text in ${path}. ` +
          'Merge them into one edit, or target disjoint regions.',
      };
    }
  }

  // Spliced into the ORIGINAL, back to front, so every byte outside a replaced
  // span survives exactly as it was. Only the inserted text takes the file's
  // line ending.
  let content = body;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i]!;
    const insert = ending === '\r\n' ? m.newText.replace(/\n/g, '\r\n') : m.newText;
    content = content.slice(0, origin[m.start]!) + insert + content.slice(origin[m.start + m.length]!);
  }
  if (content === body) {
    return {
      ok: false,
      reason: 'no_change',
      message: `Every edit to ${path} replaced text with itself, so the file is unchanged. Check that new_text differs from old_text.`,
    };
  }

  const applied = matches.map((m) => ({
    line: lineOf(base, m.start),
    removedLines: lineSpan(base.slice(m.start, m.start + m.length)),
    addedLines: lineSpan(m.newText),
  }));

  return { ok: true, content: (hasBom ? BOM : '') + content, applied };
}

// ── read ────────────────────────────────────────────────────────────────────

export interface FileSlice {
  /** The text to hand the model, truncation marker included. */
  output: string;
  /** Characters of the requested range withheld — 0 when the whole range fit. */
  omitted: number;
  /** The 1-indexed line range this output actually showed, and the file's line
   *  count, so the caller can record how much of the file the model has seen.
   *  `last` is `first - 1` when the range showed nothing. */
  first: number;
  last: number;
  total: number;
}

/**
 * The requested line range of `content`, capped at `maxChars` and honest about
 * it: a capped read always names the offset that continues it, and a single
 * line too large to show at all names the way to slice it. Nothing is ever
 * clipped silently, and no output is ever a bare empty string.
 *
 * Lines are NOT numbered. The model builds `old_text` by copying from what this
 * returns, and a line-number gutter is the most reliable way to make it copy
 * something that is not in the file.
 */
export function readFileSlice(
  content: string,
  opts: { path: string; offset?: number | undefined; limit?: number | undefined; maxChars: number },
): FileSlice {
  const first = Math.max(1, Math.floor(opts.offset ?? 1));
  // A limit is a count of lines, so anything under one line is one line. Left
  // as given it would ask for an empty range, which has no honest rendering.
  const limit = opts.limit != null ? Math.max(1, Math.floor(opts.limit)) : undefined;

  if (content.length === 0) {
    return { output: `[${opts.path} is empty]`, omitted: 0, first: 1, last: 0, total: 0 };
  }
  // A trailing newline ENDS the last line; splitting alone would report a
  // phantom empty line after it, and hand back an offset that reads as "".
  const split = content.split('\n');
  const trailingNewline = split.length > 1 && split[split.length - 1] === '';
  const lines = trailingNewline ? split.slice(0, -1) : split;
  const total = lines.length;

  if (first > total) {
    return {
      output: `[${opts.path} has ${total} line${total === 1 ? '' : 's'}; offset=${first} is past the end]`,
      omitted: 0, first, last: first - 1, total,
    };
  }
  const requestedLast = limit != null ? Math.min(total, first + limit - 1) : total;
  const requested = lines.slice(first - 1, requestedLast);

  let kept = 0;
  let chars = 0;
  for (const line of requested) {
    // The joining newline costs a character for every line after the first —
    // keyed on the line COUNT, not on the running total, so a leading blank
    // line does not make the next one look free.
    const cost = kept === 0 ? line.length : line.length + 1;
    if (chars + cost > opts.maxChars) break;
    chars += cost;
    kept++;
  }

  const requestedChars = requested.join('\n').length;
  if (kept === 0) {
    // One line, on its own, larger than the whole budget. Show its head and
    // name the way to get the rest: the same workspace.readFile-inside-
    // execute_tools recipe every other oversize payload in Kinu uses.
    const line = requested[0] ?? '';
    return {
      output:
        `${line.slice(0, opts.maxChars)}\n\n` +
        `[line ${first} of ${opts.path} is ${line.length} chars and does not fit the ${opts.maxChars}-char cap; ` +
        'read or slice it with workspace.readFile inside execute_tools]',
      omitted: Math.max(0, requestedChars - opts.maxChars),
      first, last: first - 1, total,
    };
  }

  const last = first + kept - 1;
  const shown = requested.slice(0, kept).join('\n');
  if (last === total) {
    // Reached the end: reproduce the file's own trailing newline so a whole
    // read is byte-identical to the file.
    return { output: shown + (trailingNewline ? '\n' : ''), omitted: 0, first, last, total };
  }

  const reason = kept < requested.length ? `the ${opts.maxChars}-char cap` : `limit=${limit}`;
  return {
    output:
      `${shown}\n\n[showing lines ${first}-${last} of ${total} in ${opts.path} — ` +
      `${reason} stopped it; continue with action=read offset=${last + 1}]`,
    omitted: Math.max(0, requestedChars - shown.length),
    first, last, total,
  };
}
