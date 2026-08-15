/**
 * Minimal LCS line diff — pure, dependency-free, unit-testable. Produces a flat
 * sequence of typed lines (add / del / ctx) a surface renders red/green, plus
 * +/- counts. Used by the scaffold version diff, the workspace change-set diff
 * and the per-executor `git diff` parse. Sized for source files (hundreds of
 * lines); the O(n·m) table is fine at that scale.
 */
export interface DiffLine { kind: 'add' | 'del' | 'ctx'; text: string }
export interface LineDiff { lines: DiffLine[]; added: number; removed: number }

export function diffLines(before: string, after: string): LineDiff {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const n = a.length, m = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from(
    { length: n + 1 },
    () => Array.from<number>({ length: m + 1 }).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ kind: 'ctx', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { lines.push({ kind: 'del', text: a[i]! }); i++; }
    else { lines.push({ kind: 'add', text: b[j]! }); j++; }
  }
  while (i < n) lines.push({ kind: 'del', text: a[i++]! });
  while (j < m) lines.push({ kind: 'add', text: b[j++]! });

  let added = 0, removed = 0;
  for (const l of lines) { if (l.kind === 'add') added++; else if (l.kind === 'del') removed++; }
  return { lines, added, removed };
}

export type FileStatus = 'added' | 'removed' | 'changed';
export interface FileDiff {
  path: string; status: FileStatus; added: number; removed: number; lines: DiffLine[];
  /** Set when the file's hunks outran {@link MAX_LINES_PER_FILE} and only the
   *  first that many rows are carried. `added`/`removed` still count the whole
   *  file, so the summary stays true while the body is bounded. */
  truncated?: boolean;
}

/** Diff a workspace baseline against its current state — the cumulative
 *  change-set a review surface shows. Pure: the caller supplies the
 *  before/after path→content maps. Unchanged files are omitted; result sorted
 *  by path. */
export function computeWorkspaceDiff(baseline: Record<string, string>, current: Record<string, string>): FileDiff[] {
  const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const out: FileDiff[] = [];
  for (const path of paths) {
    const before = baseline[path];
    const after = current[path];
    if (before === after) continue;
    if (before === undefined) {
      const d = diffLines('', after!);
      out.push({ path, status: 'added', added: d.added, removed: 0, lines: d.lines });
    } else if (after === undefined) {
      const d = diffLines(before, '');
      out.push({ path, status: 'removed', added: 0, removed: d.removed, lines: d.lines });
    } else {
      const d = diffLines(before, after);
      out.push({ path, status: 'changed', added: d.added, removed: d.removed, lines: d.lines });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Max diff rows CARRIED per file — a rendering bound, not a counting one.
 *  The +/- totals are accumulated for every hunk line regardless, and a file
 *  that hit this says so via {@link FileDiff.truncated}. */
export const MAX_LINES_PER_FILE = 1000;

/**
 * Parse `git diff` unified output into FileDiff[] — the general per-executor
 * change-set for executors with a real git repo (sandbox, laptop, or standalone
 * Nimbus integrations). Pure: the caller runs `git diff` via the executor's
 * shell and passes the text here. Handles new/deleted/modified/renamed files
 * and binary markers; hunk `@@` headers are kept as context rows.
 */
export function parseGitDiff(unified: string): FileDiff[] {
  const out: FileDiff[] = [];
  const lines = unified.split('\n');
  let cur: FileDiff | null = null;
  let newPath: string | null = null;
  let oldPath: string | null = null;
  let isNew = false, isDeleted = false;

  /** Carry a row into the file's body, or mark the body bounded. Counting
   *  happens at the call site and is never gated on this. */
  const carry = (file: FileDiff, l: DiffLine) => {
    if (file.lines.length >= MAX_LINES_PER_FILE) { file.truncated = true; return; }
    file.lines.push(l);
  };

  const flush = () => {
    if (!cur) return;
    cur.path = newPath ?? oldPath ?? cur.path;
    cur.status = isNew ? 'added' : isDeleted ? 'removed' : 'changed';
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
    if (line.startsWith('--- ')) { const p = line.slice(4).trim(); if (p !== '/dev/null') oldPath = p.replace(/^a\//, ''); continue; }
    if (line.startsWith('+++ ')) { const p = line.slice(4).trim(); if (p !== '/dev/null') newPath = p.replace(/^b\//, ''); continue; }
    if (line.startsWith('index ') || line.startsWith('old mode') || line.startsWith('new mode')
      || line.startsWith('similarity index') || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('Binary files')) { carry(cur, { kind: 'ctx', text: '(binary file differs)' }); continue; }
    if (line.startsWith('@@')) { carry(cur, { kind: 'ctx', text: line }); continue; }
    // Count FIRST, carry second. The bound used to sit above the counters, so
    // a file past the limit stopped counting as well as stopped showing — and
    // then presented the undercount as the file's +/- totals.
    const kind: DiffLine['kind'] | null =
      line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith(' ') ? 'ctx' : null;
    if (kind === null) continue;
    if (kind === 'add') cur.added++;
    else if (kind === 'del') cur.removed++;
    carry(cur, { kind, text: line.slice(1) });
  }
  flush();
  return out;
}
