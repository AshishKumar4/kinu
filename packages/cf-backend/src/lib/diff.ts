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
