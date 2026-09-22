/**
 * Exact-match file editor behind the `file` tool's `edit`/`read`: an edit that cannot be placed exactly once
 * fails without touching the file. No fuzzy fallback; line endings and BOM round-trip.
 */
import { KinuError } from '../obs/error';
import { headEnd, lineCount } from '../utils/text';
import {
  FILE_REFUSAL_REASONS, type FileEditFailure,
} from '../types/file-edits';

export {
  FILE_REFUSAL_REASONS, type FileEditFailure,
} from '../types/file-edits';

/** One replacement. Every edit matches the file as read, never a sibling edit's result. */
export interface FileEdit {
  oldText: string;
  newText: string;
}

export class FileRefusalError extends KinuError {
  constructor(readonly verdict: (typeof FILE_REFUSAL_REASONS)[number], message: string) {
    super('bad_input', message);
  }
}

export interface AppliedEdit {
  /** 1-indexed line in the file as read. */
  line: number;
  removedLines: number;
  addedLines: number;
}

export type FileEditOutcome =
  | { ok: true; content: string; applied: AppliedEdit[] }
  | { ok: false; reason: FileEditFailure; message: string };

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

/** LF-normalized text plus each position's index in the original; splicing the original keeps
 *  mixed-ending files byte-identical outside replaced spans. */
function normalizeWithOrigin(original: string) {
  const chars: string[] = [];
  const origin: number[] = [];

  for (let i = 0; i < original.length; i++) {
    const ch = original[i];

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

/** Counts overlapping occurrences too: `aa` sits in `aaa` twice. */
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

/** A trailing newline ends the last line: `'a\nb\n'` covers two. */
function at(index: number, total: number): string {
  return total === 1 ? 'old_text' : `edits[${index}].old_text`;
}

/** Apply every edit to `original`, or none: a missing, ambiguous, or overlapping anchor fails before any write. */
export function applyFileEdits(original: string, edits: readonly FileEdit[], path: string): FileEditOutcome {
  const hasBom = original.startsWith(BOM);
  const ending = detectLineEnding(original);
  const body = hasBom ? original.slice(1) : original;
  const { text: base, origin } = normalizeWithOrigin(body);

  const anchors = edits.map((edit) => ({ oldText: toLF(edit.oldText), newText: toLF(edit.newText) }));

  const matches: Array<{ index: number; start: number; length: number; newText: string }> = [];

  for (let i = 0; i < anchors.length; i++) {
    const { oldText, newText } = anchors[i];

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
    const prev = ordered[i - 1];
    const cur = ordered[i];

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

  // Spliced into the original back to front so bytes outside replaced spans survive; only
  // inserted text takes the file's line ending.
  let content = body;

  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i];
    const insert = ending === '\r\n' ? m.newText.replace(/\n/g, '\r\n') : m.newText;
    content = content.slice(0, origin[m.start]) + insert + content.slice(origin[m.start + m.length]);
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
    removedLines: lineCount(base.slice(m.start, m.start + m.length)),
    addedLines: lineCount(m.newText),
  }));

  return { ok: true, content: (hasBom ? BOM : '') + content, applied };
}

export interface FileSlice {
  output: string;
  /** Characters of the requested range withheld; 0 when the whole range fit. */
  omitted: number;
  /** 1-indexed line range shown plus the file's line count; `last` is `first - 1` when nothing showed. */
  first: number;
  last: number;
  total: number;
}

/**
 * One read of a file: the retained head of the range plus the range's pre-budget counts.
 * `lines` may be shorter than `requestedLines` and its first entry a prefix; counts never come from it.
 */
export interface SliceWindow {
  readonly first: number;
  /** Lines in the whole file; 0 means no displayable text. */
  readonly total: number;
  readonly trailingNewline: boolean;
  /** Whole lines, except a first line over budget arrives alone as its prefix. */
  readonly lines: readonly string[];
  readonly requestedLines: number;
  /** Includes newline joins. */
  readonly requestedChars: number;
  /** The range's first line at full length; `lines[0]` may be a prefix. */
  readonly firstLineChars: number;
}

/**
 * Render one window capped at `maxChars`, marker included; a capped read always names the continuing offset.
 * Lines are not numbered: the model copies `old_text` from this output.
 */
export function formatFileSlice(
  range: SliceWindow,
  opts: { path: string; limit?: number | undefined; maxChars: number },
): FileSlice {
  const { first, total, requestedLines, requestedChars } = range;

  /** Marker that fits the cap: names the file when it fits, else path-free; the continue offset is never dropped. */
  const affordable = (named: string, plain: string): string =>
    named.length <= opts.maxChars ? named : plain;

  if (total === 0) {
    return { output: affordable(`[${opts.path} is empty]`, '[this file is empty]'), omitted: 0, first: 1, last: 0, total: 0 };
  }

  if (first > total) {
    const lines = `${total} line${total === 1 ? '' : 's'}`;

    return {
      output: affordable(
        `[${opts.path} has ${lines}; offset=${first} is past the end]`,
        `[this file has ${lines}; offset=${first} is past the end]`),
      omitted: 0, first, last: first - 1, total,
    };
  }

  const requestedLast = first + requestedLines - 1;
  // A whole read includes the trailing newline, so it is byte-identical to the file.
  const ending = requestedLast === total && range.trailingNewline ? '\n' : '';

  if (requestedLines === range.lines.length && requestedLast === total
    && requestedChars + ending.length <= opts.maxChars) {
    return { output: range.lines.join('\n') + ending, omitted: 0, first, last: requestedLast, total };
  }

  // Past here the output carries a marker; reserve its worst-case length before choosing lines.
  const continuation = (last: number, reason: string): string => {
    const tail = `${reason} stopped it; continue with action=read offset=${last + 1}]`;

    return affordable(
      `\n\n[showing lines ${first}-${last} of ${total} in ${opts.path} — ${tail}`,
      `\n\n[showing lines ${first}-${last} of ${total} — ${tail}`);
  };

  const capReason = `the ${opts.maxChars}-char cap`;
  // A limit under one line is one line; an empty range has no honest rendering.
  const limitReason = opts.limit == null ? capReason : `limit=${Math.max(1, Math.floor(opts.limit))}`;

  const reserve = Math.max(
    continuation(requestedLast, capReason).length,
    continuation(requestedLast, limitReason).length,
  );

  let kept = 0;
  let chars = 0;

  for (const line of range.lines) {
    // Newline joins cost a char per line after the first, keyed on line count.
    const cost = kept === 0 ? line.length : line.length + 1;

    if (chars + cost > opts.maxChars - reserve) break;
    chars += cost;
    kept++;
  }

  if (kept === 0) {
    // A single line larger than the whole budget: show its head and name the readFile-in-eval recipe.
    const line = range.lines[0] ?? '';

    const tail =
      `is ${range.firstLineChars} chars and does not fit the ${opts.maxChars}-char cap; ` +
      'read or slice it with workspace.readFile inside eval]';

    const refusal = affordable(`\n\n[line ${first} of ${opts.path} ${tail}`, `\n\n[line ${first} ${tail}`);

    const shown = line.slice(0, headEnd(line, Math.max(0, opts.maxChars - refusal.length)));

    return { output: shown + refusal, omitted: requestedChars - shown.length, first, last: first - 1, total };
  }

  const last = first + kept - 1;
  const shown = range.lines.slice(0, kept).join('\n');

  return {
    output: shown + continuation(last, kept < requestedLines ? capReason : limitReason),
    omitted: requestedChars - shown.length,
    first, last, total,
  };
}
