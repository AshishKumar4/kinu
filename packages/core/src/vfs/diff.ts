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

/** Parse `git diff` unified output into FileDiff[]; hunk `@@` headers are kept as `hunk` rows. */
export function parseGitDiff(unified: string): FileDiff[] {
  const out: FileDiff[] = [];
  const lines = unified.split('\n');
  let cur: FileDiff | null = null;
  let newPath: string | null = null;
  let oldPath: string | null = null;
  let isNew = false, isDeleted = false;

  const flush = () => {
    if (!cur) return;
    cur.path = newPath ?? oldPath ?? cur.path;
    cur.status = statusOf(isNew, isDeleted);
    out.push(cur);
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      cur = { path: '', status: 'changed', added: 0, removed: 0, lines: [] };
      newPath = oldPath = null;
      isNew = isDeleted = false;
      // diff --git a/<old> b/<new>
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);

      if (m) { oldPath = m[1]; newPath = m[2]; }

      continue;
    }

    if (!cur) continue;

    if (line.startsWith('new file mode')) { isNew = true; continue; }

    if (line.startsWith('deleted file mode')) { isDeleted = true; continue; }

    if (line.startsWith('rename to ')) { newPath = line.slice('rename to '.length).trim(); continue; }

    if (line.startsWith('rename from ')) { oldPath = line.slice('rename from '.length).trim(); continue; }

    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();

      if (p !== '/dev/null') oldPath = p.replace(/^a\//, '');
      continue;
    }

    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();

      if (p !== '/dev/null') newPath = p.replace(/^b\//, '');
      continue;
    }

    if (line.startsWith('index ') || line.startsWith('old mode') || line.startsWith('new mode')
      || line.startsWith('similarity index') || line.startsWith('\\ No newline')) continue;

    if (line.startsWith('Binary files')) { cur.omitted = 'binary'; continue; }

    if (line.startsWith('@@')) { carry(cur, { kind: 'hunk', text: line }); continue; }

    // Count first, then carry: the row bound must never gate the counts.
    const kind = bodyKind(line);

    if (kind === null) continue;

    if (kind === 'add') cur.added++;
    else if (kind === 'del') cur.removed++;
    carry(cur, { kind, text: line.slice(1) });
  }

  flush();

  return out;
}
