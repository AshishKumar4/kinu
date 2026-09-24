/**
 * Minimal LCS line diff (add/del/ctx rows plus +/- counts).
 * The O(n·m) table's size bound is enforced here, not by callers (see {@link MAX_LINES_PER_FILE}).
 */
import { PLATFORM_CATALOG } from '../platform-catalog';

export interface DiffLine { kind: 'add' | 'del' | 'ctx'; text: string }

export interface LineDiff {
  lines: DiffLine[]; added: number; removed: number;
  /** Body bounded (alignment refused or rows capped); +/- counts still cover the whole file. */
  truncated?: boolean;
}

/** Max rows carried per file and max lines per side aligned: an unreadable body is not worth the table.
 *  Memory binds, not CPU: breaching `do.isolate.reset_silent` is a silent object reset. */
export const MAX_LINES_PER_FILE = 1000;

/** Bytes per table element, rounded up from measurement so the derived bound errs small. */
const LCS_BYTES_PER_ELEMENT = 6;

/** An eighth of the silent-reset wall; the rest is shared with the change-set, workspace state and runtime. */
const LCS_TABLE_BUDGET_BYTES = PLATFORM_CATALOG['do.isolate.reset_silent'].limit.value / 8;

/** The min keeps the platform bound load-bearing: raising MAX_LINES_PER_FILE cannot raise alignment memory. */
const MAX_ALIGNABLE_LINES = Math.min(
  MAX_LINES_PER_FILE,
  Math.floor(Math.sqrt(LCS_TABLE_BUDGET_BYTES / LCS_BYTES_PER_ELEMENT)) - 1,
);

export function diffLines(before: string, after: string): LineDiff {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  // Align only the differing middle; trimming the shared head and tail is O(a+b) with no memory.
  let head = 0;

  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;

  while (
    tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;

  // Past the bound, report the middle as a wholesale replacement with no body and no table.
  // A middle with one empty side needs no table, so it is exempt at any size.
  if (n > 0 && m > 0 && (n > MAX_ALIGNABLE_LINES || m > MAX_ALIGNABLE_LINES)) {
    return { lines: [], added: m, removed: n, truncated: true };
  }

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

  const done = (): LineDiff =>
    dropped ? { lines, added, removed, truncated: true } : { lines, added, removed };

  for (let k = 0; k < head; k++) emit('ctx', a[k]);

  // Pure insertion or deletion: exact with no table.
  if (n === 0 || m === 0) {
    for (let k = 0; k < n; k++) emit('del', a[head + k]);

    for (let k = 0; k < m; k++) emit('add', b[head + k]);
  } else {
    // lcs[i][j] = LCS length of mid-a[i:] and mid-b[j:].
    const lcs: number[][] = Array.from(
      { length: n + 1 },
      () => Array.from<number>({ length: m + 1 }).fill(0),
    );

    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[head + i] === b[head + j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    let i = 0, j = 0;

    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) { emit('ctx', a[head + i]); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { emit('del', a[head + i]); i++; }
      else { emit('add', b[head + j]); j++; }
    }

    while (i < n) emit('del', a[head + i++]);

    while (j < m) emit('add', b[head + j++]);
  }

  for (let k = a.length - tail; k < a.length; k++) emit('ctx', a[k]);

  return done();
}

export type FileStatus = 'added' | 'removed' | 'changed';

export interface FileDiff {
  path: string; status: FileStatus; added: number; removed: number; lines: DiffLine[];
  /** Body bounded; `added`/`removed` still count the whole file. */
  truncated?: boolean;
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

/** Parse `git diff` unified output into FileDiff[]; hunk `@@` headers are kept as context rows. */
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

    if (line.startsWith('Binary files')) { carry(cur, { kind: 'ctx', text: '(binary file differs)' }); continue; }

    if (line.startsWith('@@')) { carry(cur, { kind: 'ctx', text: line }); continue; }

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
