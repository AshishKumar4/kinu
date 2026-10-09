/**
 * Exact-match file editor behind the `file` tool's `edit`, and the numbered window its `read` shows: an edit that cannot
 * be placed exactly once fails without touching the file. No fuzzy fallback; line endings and BOM round-trip.
 */
import { headEnd, lineCount } from '../utils/text';
import { FILE_READ_LINE_CHARS, FILE_READ_LINES, type FileEditFailure } from '../types/file-edits';

export {
  FILE_READ_LINE_CHARS, FILE_READ_LINES, FILE_READ_MAX_CHARS, FILE_REFUSAL_REASONS, type FileEditFailure,
} from '../types/file-edits';

/** One replacement. Every edit matches the file as read, never a sibling edit's result. */
export interface FileEdit {
  oldText: string;
  newText: string;
}

interface AppliedEdit {
  /** 1-indexed line in the file as read. */
  line: number;
  removedLines: number;
  addedLines: number;
}

export type FileEditOutcome =
  | { ok: true; content: string; applied: AppliedEdit[] }
  | { ok: false; reason: FileEditFailure; message: string };

export const BOM = '\uFEFF';

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
        message: `${at(i, anchors.length)} is empty in ${path}. Give the exact text to replace; use op=write to create or replace the whole file.`,
      };
    }

    const occurrences = countOccurrences(base, oldText);

    if (occurrences === 0) {
      // Copied with the numbers a read puts before each line, which are not in the file.
      const numbered = oldText.split('\n').every((line) => /^\d+\t/.test(line));

      return {
        ok: false,
        reason: 'not_found',
        message:
          `${at(i, anchors.length)} does not appear in ${path}. It must match the file byte for byte, ` +
          'including indentation and blank lines. ' + (numbered
            ? 'It starts each line with a number and a tab, as a read shows lines; copy only the text after the tab.'
            : 'Read the file again and copy the text from what it returned.'),
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
  /** Characters of the requested range withheld; 0 when the whole range showed. */
  omitted: number;
  /** 1-indexed line range shown plus the file's line count; `last` is `first - 1` when nothing showed. */
  first: number;
  last: number;
  total: number;
  /**
   * The last line of `first..last` before the first one the read cut. Lines past a cut line showed, but a cut line's
   * tail did not, so a reader has seen `first..uncutTo` and no more; `first - 1` when nothing showed uncut.
   */
  uncutTo: number;
}

/** One line of a read: its retained head (at most `FILE_READ_LINE_CHARS`) and its full length. */
export interface SliceLine {
  readonly text: string;
  readonly chars: number;
}

/**
 * One read of a file: the retained lines of the range plus the range's pre-budget counts.
 * `lines` may be shorter than `requestedLines`; counts never come from it.
 */
export interface SliceWindow {
  readonly first: number;
  /** Lines in the whole file; 0 means no displayable text. */
  readonly total: number;
  readonly lines: readonly SliceLine[];
  readonly requestedLines: number;
  /** Includes newline joins. */
  readonly requestedChars: number;
}

/** A line as a read shows it: its number, a tab, then its text, cut at `FILE_READ_LINE_CHARS` with what follows counted. */
export function numberedLine(number: number, line: SliceLine): string {
  const rest = line.chars - FILE_READ_LINE_CHARS;

  return `${String(number)}\t${rest > 0 ? `${line.text.slice(0, FILE_READ_LINE_CHARS)} [... ${String(rest)} more characters on this line]` : line.text}`;
}

/**
 * Render one window capped at `maxChars`, footer included. Each line carries its number; the footer says which lines
 * showed, of how many, and the offset that continues a read that stopped early.
 */
export function formatFileSlice(
  range: SliceWindow,
  opts: { path: string; limit?: number | undefined; maxChars: number },
): FileSlice {
  const { first, total, requestedLines, requestedChars } = range;

  /** The footer naming the file when it fits the cap, else without it; the continuing offset is never dropped. */
  const affordable = (named: string, plain: string): string =>
    named.length <= opts.maxChars ? named : plain;

  if (total === 0) {
    return { output: affordable(`[${opts.path} is empty]`, '[this file is empty]'), omitted: 0, first: 1, last: 0, total: 0, uncutTo: 0 };
  }

  const count = `${String(total)} line${total === 1 ? '' : 's'}`;

  if (first > total) {
    return {
      output: affordable(
        `[${opts.path} has ${count}; offset=${String(first)} is past the end]`,
        `[this file has ${count}; offset=${String(first)} is past the end]`),
      omitted: 0, first, last: first - 1, total, uncutTo: first - 1,
    };
  }

  const requestedLast = first + requestedLines - 1;
  const capStop = `one read shows at most ${String(opts.maxChars)} characters`;
  const windowStop = opts.limit == null ? `one read shows at most ${String(FILE_READ_LINES)} lines` : `limit=${String(Math.max(1, Math.floor(opts.limit)))}`;

  const footer = (last: number, stop: string | null): string => {
    const lines = `lines ${String(first)}-${String(last)} of ${String(total)}`;

    if (stop !== null) {
      const tail = `${stop}; continue with offset=${String(last + 1)}]`;

      return affordable(`\n\n[${lines} in ${opts.path}: ${tail}`, `\n\n[${lines}: ${tail}`);
    }

    return first === 1 && last === total
      ? affordable(`\n\n[${opts.path}: all ${count}]`, `\n\n[all ${count}]`)
      : affordable(`\n\n[${lines} in ${opts.path}: through the end]`, `\n\n[${lines}: through the end]`);
  };

  // Reserve the footer's worst case before choosing lines.
  const reserve = Math.max(footer(requestedLast, capStop).length, footer(requestedLast, windowStop).length, footer(requestedLast, null).length);
  const shown: string[] = [];
  let chars = 0;
  let raw = 0;
  let cutAt: number | null = null;

  for (const [index, line] of range.lines.entries()) {
    const rendered = numberedLine(first + index, line);
    // Newline joins cost a char per line after the first.
    const cost = shown.length === 0 ? rendered.length : rendered.length + 1;

    if (chars + cost > opts.maxChars - reserve) break;
    chars += cost;
    raw += Math.min(line.chars, FILE_READ_LINE_CHARS) + (shown.length === 0 ? 0 : 1);
    shown.push(rendered);

    if (cutAt === null && line.chars > FILE_READ_LINE_CHARS) cutAt = first + index;
  }

  if (shown.length === 0) {
    // A cap smaller than one line: show its head and name the readFile-in-eval recipe.
    const line = range.lines[0] ?? { text: '', chars: 0 };
    const tail = `is ${String(line.chars)} chars and does not fit the ${String(opts.maxChars)}-char cap; read or slice it with workspace.readFile inside eval]`;
    const refusal = affordable(`\n\n[line ${String(first)} of ${opts.path} ${tail}`, `\n\n[line ${String(first)} ${tail}`);
    const head = line.text.slice(0, headEnd(line.text, Math.max(0, opts.maxChars - refusal.length)));

    return { output: head + refusal, omitted: requestedChars - head.length, first, last: first - 1, total, uncutTo: first - 1 };
  }

  const last = first + shown.length - 1;
  let stop: string | null = null;

  if (last < requestedLast) stop = capStop;
  else if (last < total) stop = windowStop;

  return { output: shown.join('\n') + footer(last, stop), omitted: requestedChars - raw, first, last, total, uncutTo: cutAt === null ? last : cutAt - 1 };
}
