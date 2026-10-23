import { compareTexts, diffText } from '@nimbus-sh/core/substrate/lifo/commands/text/diff-analysis.js';

/** `hunk`: a git hunk header (`@@ -40,6 +40,8 @@ context`), never a line of the file. */
export interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string }

export interface LineDiff {
  lines: DiffLine[]; added: number; removed: number;
  /** Body rows capped; +/- counts still cover the whole file. */
  truncated?: boolean;
}

/** Max rows carried per file; alignment and +/- counts cover both full texts. */
export const MAX_LINES_PER_FILE = 1000;

/** The minimal alignment of two row lists: each change, where its rows start in `a` and in `b` and how many it deletes
 *  and inserts. Rows are compared whole; JSON keeps lone surrogates distinct through UTF-8. */
function align(a: readonly string[], b: readonly string[]) {
  const encoder = new TextEncoder();

  const asText = (rows: readonly string[]) => diffText(encoder.encode(
    rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  ));

  return compareTexts(asText(a), asText(b), { ignoreCase: false, whiteSpace: 'none', minimal: true, horizon: 0 });
}

/** The rows of `a` a minimal diff deletes and the rows of `b` it inserts, by the alignment {@link diffLines} shows. */
export function changedRows(a: readonly string[], b: readonly string[]) {
  const removed: string[] = [];
  const added: string[] = [];

  for (const change of align(a, b)) {
    removed.push(...a.slice(change.line0, change.line0 + change.deleted));
    added.push(...b.slice(change.line1, change.line1 + change.inserted));
  }

  return { removed, added };
}

export function diffLines(before: string, after: string): LineDiff {
  // Each split item, including a final empty one, is a line.
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const changes = align(a, b);

  const lines: DiffLine[] = [];
  let added = 0, removed = 0, dropped = false;

  // Counting is never gated on the row bound.
  const emit = (kind: DiffLine['kind'], text: string): void => {
    if (kind === 'add') added++; else if (kind === 'del') removed++;

    if (lines.length >= MAX_LINES_PER_FILE) {
      dropped = true;

      return;
    }

    lines.push({ kind, text });
  };

  let at = 0;

  for (const change of changes) {
    while (at < change.line0) emit('ctx', a[at++]);

    for (let k = 0; k < change.deleted; k++) emit('del', a[at++]);

    for (let k = 0; k < change.inserted; k++) emit('add', b[change.line1 + k]);
  }

  while (at < a.length) emit('ctx', a[at++]);

  return dropped ? { lines, added, removed, truncated: true } : { lines, added, removed };
}

export type FileStatus = 'added' | 'removed' | 'changed';

/** Why a file has no lines: `binary` (a NUL byte, or git says so) or `large` (past one stored row). */
export type Omitted = 'binary' | 'large';

export interface FileDiff {
  path: string; status: FileStatus; added: number; removed: number; lines: DiffLine[];
  /** Body bounded; `added`/`removed` still count the whole file. */
  truncated?: boolean;
  /** Not compared, so it has no lines and no counts. */
  omitted?: Omitted;
}

function carry(file: FileDiff, l: DiffLine): void {
  if (file.lines.length >= MAX_LINES_PER_FILE) {
    file.truncated = true;

    return;
  }

  file.lines.push(l);
}

function statusOf(absentBefore: boolean, absentAfter: boolean): FileStatus {
  if (absentBefore) return 'added';

  if (absentAfter) return 'removed';

  return 'changed';
}

export function fileDiff(path: string, status: FileStatus, d: LineDiff): FileDiff {
  const { added, removed, lines } = d;

  return d.truncated
    ? { path, status, added, removed, lines, truncated: true }
    : { path, status, added, removed, lines };
}

function bodyKind(line: string): DiffLine['kind'] | null {
  if (line.startsWith('+')) return 'add';

  if (line.startsWith('-')) return 'del';

  if (line.startsWith(' ')) return 'ctx';

  return null;
}

/** The C escapes git writes in a quoted path (`core.quotePath`), and what each stands for. */
const C_ESCAPES = new Map([['a', 7], ['b', 8], ['t', 9], ['n', 10], ['v', 11], ['f', 12], ['r', 13], ['"', 34], ['\\', 92]]);

/** A path as git writes it in a header: as is, or quoted with C escapes and octal UTF-8 bytes (`"a/\303\251.txt"`). */
function gitPath(written: string): string {
  if (!(written.length >= 2 && written.startsWith('"') && written.endsWith('"'))) return written;
  const bytes: number[] = [];
  const inner = written.slice(1, -1);

  for (let at = 0; at < inner.length; at++) {
    const char = inner[at] ?? '';

    if (char !== '\\') {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }

    const octal = /^[0-7]{3}/u.exec(inner.slice(at + 1))?.[0];

    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
      at += 3;
      continue;
    }

    const escaped = inner[at + 1] ?? '';

    bytes.push(C_ESCAPES.get(escaped) ?? escaped.charCodeAt(0));
    at += 1;
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The two paths a `diff --git` line names, each quoted or not; where unquoted paths hold ` b/`, the `---` and `+++`
 *  lines that follow name them again. */
function gitPaths(rest: string): readonly [string, string] | null {
  if (rest.startsWith('"')) {
    const close = /^"(?:[^"\\]|\\.)*"/u.exec(rest)?.[0];

    if (close === undefined) return null;
    const second = rest.slice(close.length + 1);

    return [gitPath(close).replace(/^a\//u, ''), gitPath(second).replace(/^b\//u, '')];
  }

  const unquoted = /^a\/(.+?) (?:b\/(.+)|("(?:[^"\\]|\\.)*"))$/u.exec(rest);

  return unquoted === null ? null : [unquoted[1] ?? '', unquoted[2] ?? gitPath(unquoted[3] ?? '').replace(/^b\//u, '')];
}

/** A hunk header's line counts, old side then new (`@@ -l,s +l,s @@`; a count left out is 1). */
function hunkCounts(header: string): { old: number; new: number } | null {
  const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(header);

  return counts === null ? null : { old: Number(counts[1] ?? 1), new: Number(counts[2] ?? 1) };
}

/** A file's facts as the header lines before its first hunk state them. */
interface FileHeader {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
}

/** What a header line before a file's first hunk says: its paths, whether it is new or gone, binary. */
function readHeader(line: string, file: FileHeader, diff: FileDiff): void {
  if (line.startsWith('new file mode')) file.isNew = true;
  else if (line.startsWith('deleted file mode')) file.isDeleted = true;
  else if (line.startsWith('rename to ')) file.newPath = gitPath(line.slice('rename to '.length).trim());
  else if (line.startsWith('rename from ')) file.oldPath = gitPath(line.slice('rename from '.length).trim());
  else if (line.startsWith('--- ')) {
    const named = gitPath(line.slice(4).trim());

    if (named !== '/dev/null') file.oldPath = named.replace(/^a\//u, '');
  } else if (line.startsWith('+++ ')) {
    const named = gitPath(line.slice(4).trim());

    if (named !== '/dev/null') file.newPath = named.replace(/^b\//u, '');
  } else if (line.startsWith('Binary files')) diff.omitted = 'binary';
}

/**
 * Parse `git diff` unified output into FileDiff[]; hunk `@@` headers are kept as `hunk` rows. A hunk's header says how
 * many lines of each side follow, and those lines are the file's whatever they begin with: a removed `-- comment` is a
 * removed line, never a `---` header.
 */
export function parseGitDiff(unified: string): FileDiff[] {
  const out: FileDiff[] = [];
  let file: (FileHeader & { diff: FileDiff }) | null = null;
  let left = { old: 0, new: 0 };

  const flush = () => {
    if (!file) return;
    file.diff.path = file.newPath ?? file.oldPath ?? file.diff.path;
    file.diff.status = statusOf(file.isNew, file.isDeleted);
    out.push(file.diff);
  };

  for (const line of unified.split('\n')) {
    if (left.old > 0 || left.new > 0) {
      if (line.startsWith('\\')) continue;
      const kind = bodyKind(line);

      if (file !== null && kind !== null) {
        if (kind !== 'add') left.old -= 1;

        if (kind !== 'del') left.new -= 1;

        // Count first, then carry: the row bound must never gate the counts.
        if (kind === 'add') file.diff.added++;
        else if (kind === 'del') file.diff.removed++;
        carry(file.diff, { kind, text: line.slice(1) });
        continue;
      }

      left = { old: 0, new: 0 };
    }

    if (line.startsWith('diff --git ')) {
      flush();
      const paths = gitPaths(line.slice('diff --git '.length));

      file = { oldPath: paths?.[0] ?? null, newPath: paths?.[1] ?? null, isNew: false, isDeleted: false, diff: { path: '', status: 'changed', added: 0, removed: 0, lines: [] } };
      continue;
    }

    if (!file) continue;
    const counts = line.startsWith('@@') ? hunkCounts(line) : null;

    if (counts !== null) {
      carry(file.diff, { kind: 'hunk', text: line });
      left = counts;
    } else readHeader(line, file, file.diff);
  }

  flush();

  return out;
}
