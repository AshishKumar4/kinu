/**
 * Minimal LCS line diff — pure, dependency-free, unit-testable. Produces a flat
 * sequence of typed lines (add / del / ctx) the UI renders red/green, plus
 * +/- counts. Used by the scaffold version diff (Brain) and the workspace
 * change-set diff (Output). Sized for source files (hundreds of lines); the
 * O(n·m) table is fine at that scale.
 */
export interface DiffLine { kind: "add" | "del" | "ctx"; text: string }
export interface LineDiff { lines: DiffLine[]; added: number; removed: number }

export function diffLines(before: string, after: string): LineDiff {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length, m = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ kind: "ctx", text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { lines.push({ kind: "del", text: a[i]! }); i++; }
    else { lines.push({ kind: "add", text: b[j]! }); j++; }
  }
  while (i < n) lines.push({ kind: "del", text: a[i++]! });
  while (j < m) lines.push({ kind: "add", text: b[j++]! });

  let added = 0, removed = 0;
  for (const l of lines) { if (l.kind === "add") added++; else if (l.kind === "del") removed++; }
  return { lines, added, removed };
}

export type FileStatus = "added" | "removed" | "changed";
export interface FileDiff { path: string; status: FileStatus; added: number; removed: number; lines: DiffLine[] }

/** Diff a workspace baseline against its current state — the cumulative
 *  change-set the Output surface reviews. Pure: the orchestrator supplies the
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
      const d = diffLines("", after!);
      out.push({ path, status: "added", added: d.added, removed: 0, lines: d.lines });
    } else if (after === undefined) {
      const d = diffLines(before, "");
      out.push({ path, status: "removed", added: 0, removed: d.removed, lines: d.lines });
    } else {
      const d = diffLines(before, after);
      out.push({ path, status: "changed", added: d.added, removed: d.removed, lines: d.lines });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
