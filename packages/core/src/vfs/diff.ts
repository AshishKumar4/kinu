/**
 * Minimal LCS line diff — pure, unit-testable. Produces a flat sequence of
 * typed lines (add / del / ctx) a surface renders red/green, plus +/- counts.
 * Used by the scaffold version diff, the workspace change-set diff and the
 * per-executor `git diff` parse.
 *
 * The alignment is an O(n·m) table, so its cost is driven by LINE COUNT and a
 * file of short lines is the adversarial case. That bound is enforced HERE
 * rather than at each caller: a caller that forgets it cannot be made safe by
 * documentation, and the one that did forget cost 330 MiB in a real isolate
 * (see {@link MAX_LINES_PER_FILE}).
 */
import { PLATFORM_CATALOG } from '../platform-catalog';

export interface DiffLine { kind: 'add' | 'del' | 'ctx'; text: string }
export interface LineDiff {
  lines: DiffLine[]; added: number; removed: number;
  /** Set when the body is bounded rather than complete — either the alignment
   *  was refused ({@link MAX_LINES_PER_FILE}) or the rows were capped. The
   *  +/- counts still describe the whole file. */
  truncated?: boolean;
}

/** Max diff rows CARRIED per file, and the max lines per side an alignment is
 *  computed for. Both, because they are the same product judgement: a body
 *  nobody can read is not worth an O(n·m) table to produce.
 *
 *  Measured in a real workerd isolate (local://v8-sizing-probe.md): the table
 *  costs 4.6-5.2 bytes per element, so 1,000 lines is +12 MiB and 87 ms, while
 *  8,192 lines — one 256 KiB file of 32-byte lines, which the snapshot gate
 *  admitted — is +330 MiB and 4.6 s. Memory is the binding resource, not CPU:
 *  `do.isolate.reset_silent` is crossed at ~6,100 lines and its breach is a
 *  SILENT object reset, while the same file uses 15% of the CPU limit. */
export const MAX_LINES_PER_FILE = 1000;

/** Bytes one table element costs in workerd, rounded up from the measured
 *  4.6-5.2 so the derived bound errs small. */
const LCS_BYTES_PER_ELEMENT = 6;

/** An eighth of the silent-reset wall. One transient table is not entitled to
 *  the whole budget: up to 400 files are diffed per invocation and the
 *  change-set, the workspace's own state and the runtime share what is left. */
const LCS_TABLE_BUDGET_BYTES = PLATFORM_CATALOG['do.isolate.reset_silent'].limit.value / 8;

/** Lines per side the platform can afford, independent of the product bound.
 *  Taking the min of the two is what keeps the platform number load-bearing:
 *  raising MAX_LINES_PER_FILE cannot raise the memory an alignment may use. */
const MAX_ALIGNABLE_LINES = Math.min(
  MAX_LINES_PER_FILE,
  Math.floor(Math.sqrt(LCS_TABLE_BUDGET_BYTES / LCS_BYTES_PER_ELEMENT)) - 1,
);

export function diffLines(before: string, after: string): LineDiff {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  // Shrink the alignment to the region that actually DIFFERS. Finding the
  // shared head and tail costs O(a+b) time and no memory, and it is what makes
  // the adversarial case cheap rather than merely refused: a lockfile with one
  // changed line has a 1x1 middle, so the table is 2x2 rather than 8193x8193.
  // Whole-file alignment was never needed for it — identical prefixes and
  // suffixes are exactly what an LCS would have matched anyway.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;

  // Past the bound the differing region is refused, so the table is never
  // allocated. The file is still reported — as a wholesale replacement of that
  // region, which is the one statement about two texts that holds without an
  // alignment. The shared head and tail are known identical, so they contribute
  // nothing to the counts, and no body is offered because 1,000 rows of
  // unchanged context would show everything except the change.
  //
  // A region with one empty side is exempt at any size: there is no alignment
  // to compute and therefore no table, so refusing it would withhold an answer
  // already in hand. That is the newly-added-file and appended-log shape.
  if (n > 0 && m > 0 && (n > MAX_ALIGNABLE_LINES || m > MAX_ALIGNABLE_LINES)) {
    return { lines: [], added: m, removed: n, truncated: true };
  }

  const lines: DiffLine[] = [];
  let added = 0, removed = 0, dropped = false;
  // Counting happens here and is never gated on the row bound: a body that
  // stopped must not present its short count as the file's totals.
  const emit = (kind: DiffLine['kind'], text: string): void => {
    if (kind === 'add') added++; else if (kind === 'del') removed++;
    if (lines.length >= MAX_LINES_PER_FILE) { dropped = true; return; }
    lines.push({ kind, text });
  };
  const done = (): LineDiff =>
    dropped ? { lines, added, removed, truncated: true } : { lines, added, removed };

  for (let k = 0; k < head; k++) emit('ctx', a[k]!);

  // One side of the differing region is empty — a pure insertion or deletion.
  // The common subsequence is empty by definition, so the answer is exact with
  // no table at any size. This is also the workspace-birth shape, where every
  // file is diffed against an empty baseline.
  if (n === 0 || m === 0) {
    for (let k = 0; k < n; k++) emit('del', a[head + k]!);
    for (let k = 0; k < m; k++) emit('add', b[head + k]!);
  } else {
    // lcs[i][j] = length of the longest common subsequence of mid-a[i:] and
    // mid-b[j:], indexed relative to the differing region.
    const lcs: number[][] = Array.from(
      { length: n + 1 },
      () => Array.from<number>({ length: m + 1 }).fill(0),
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = a[head + i] === b[head + j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) { emit('ctx', a[head + i]!); i++; j++; }
      else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { emit('del', a[head + i]!); i++; }
      else { emit('add', b[head + j]!); j++; }
    }
    while (i < n) emit('del', a[head + i++]!);
    while (j < m) emit('add', b[head + j++]!);
  }

  for (let k = a.length - tail; k < a.length; k++) emit('ctx', a[k]!);
  return done();
}

export type FileStatus = 'added' | 'removed' | 'changed';
export interface FileDiff {
  path: string; status: FileStatus; added: number; removed: number; lines: DiffLine[];
  /** Set when the file's body outran {@link MAX_LINES_PER_FILE} and only the
   *  first that many rows are carried, or when the file was too large to align
   *  at all. `added`/`removed` still count the whole file, so the summary stays
   *  true while the body is bounded. */
  truncated?: boolean;
}

/** Carry a row into the file's body, or mark the body bounded. Counting
 *  happens at the call site and is never gated on this. */
function carry(file: FileDiff, l: DiffLine): void {
  if (file.lines.length >= MAX_LINES_PER_FILE) { file.truncated = true; return; }
  file.lines.push(l);
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
    const status: FileStatus = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
    out.push(fileDiff(path, status, diffLines(before ?? '', after ?? '')));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** One file's entry from an already-bounded {@link LineDiff}. Exported because
 *  the streaming workspace change-set builds entries one path at a time and
 *  must produce the same shape as the batch form. */
export function fileDiff(path: string, status: FileStatus, d: LineDiff): FileDiff {
  const { added, removed, lines } = d;
  return d.truncated
    ? { path, status, added, removed, lines, truncated: true }
    : { path, status, added, removed, lines };
}

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
