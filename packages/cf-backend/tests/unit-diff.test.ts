import { describe, test, expect } from "bun:test";
import { diffLines, computeWorkspaceDiff, parseGitDiff, MAX_LINES_PER_FILE } from "@kinu/core";

describe("diffLines", () => {
  test("identical input is all context, zero changes", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines.every((l) => l.kind === "ctx")).toBe(true);
  });

  test("a changed middle line shows as del + add, context preserved", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    const kinds = d.lines.map((l) => `${l.kind}:${l.text}`);
    expect(kinds).toEqual(["ctx:a", "del:b", "add:B", "ctx:c"]);
  });

  test("pure additions at the end", () => {
    const d = diffLines("a\nb", "a\nb\nc\nd");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
    expect(d.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["c", "d"]);
  });

  test("pure deletions", () => {
    const d = diffLines("a\nb\nc\nd", "a\nd");
    expect(d.removed).toBe(2);
    expect(d.added).toBe(0);
    expect(d.lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["b", "c"]);
  });

  test("empty before = all additions; empty after = all deletions", () => {
    expect(diffLines("", "x\ny")).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines("x\ny", "")).toMatchObject({ added: 0, removed: 2 });
    expect(diffLines("", "")).toMatchObject({ added: 0, removed: 0, lines: [] });
  });
});

describe("computeWorkspaceDiff", () => {
  test("classifies added / removed / changed and omits unchanged, sorted by path", () => {
    const baseline = { "a.ts": "x", "b.ts": "old", "c.ts": "same" };
    const current = { "a.ts": "x\ny", "c.ts": "same", "d.ts": "new" };
    const diff = computeWorkspaceDiff(baseline, current);
    expect(diff.map((f) => [f.path, f.status])).toEqual([
      ["a.ts", "changed"],   // x → x\ny
      ["b.ts", "removed"],   // gone from current
      ["d.ts", "added"],     // new in current
    ]);
    // c.ts unchanged → omitted.
    expect(diff.find((f) => f.path === "c.ts")).toBeUndefined();
    expect(diff.find((f) => f.path === "a.ts")!.added).toBe(1);
    expect(diff.find((f) => f.path === "d.ts")!.added).toBe(1);
    expect(diff.find((f) => f.path === "b.ts")!.removed).toBe(1);
  });

  test("identical baseline/current = no changes", () => {
    expect(computeWorkspaceDiff({ "a": "1" }, { "a": "1" })).toEqual([]);
  });
});

describe("parseGitDiff", () => {
  test("modified file: counts +/- and keeps @@ context", () => {
    const raw = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 3;",
      " export { x, y };",
    ].join("\n");
    const out = parseGitDiff(raw);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ path: "src/app.ts", status: "changed", added: 1, removed: 1 });
    expect(out[0].lines[0]).toEqual({ kind: "ctx", text: "@@ -1,3 +1,3 @@" });
    expect(out[0].lines.some((l) => l.kind === "add" && l.text === "const y = 3;")).toBe(true);
    expect(out[0].lines.some((l) => l.kind === "del" && l.text === "const y = 2;")).toBe(true);
  });

  test("new file → status added", () => {
    const raw = [
      "diff --git a/NEW.md b/NEW.md",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/NEW.md",
      "@@ -0,0 +1,2 @@",
      "+# Title",
      "+body",
    ].join("\n");
    const out = parseGitDiff(raw);
    expect(out[0]).toMatchObject({ path: "NEW.md", status: "added", added: 2, removed: 0 });
  });

  test("deleted file → status removed", () => {
    const raw = [
      "diff --git a/OLD.txt b/OLD.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/OLD.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
    ].join("\n");
    const out = parseGitDiff(raw);
    expect(out[0]).toMatchObject({ path: "OLD.txt", status: "removed", added: 0, removed: 1 });
  });

  test("rename uses the new path", () => {
    const raw = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 100%",
      "rename from old/name.ts",
      "rename to new/name.ts",
    ].join("\n");
    const out = parseGitDiff(raw);
    expect(out[0].path).toBe("new/name.ts");
  });

  test("binary file → single context note, zero counts", () => {
    const raw = [
      "diff --git a/img.png b/img.png",
      "index 5555555..6666666 100644",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    const out = parseGitDiff(raw);
    expect(out[0]).toMatchObject({ path: "img.png", status: "changed", added: 0, removed: 0 });
    expect(out[0].lines).toEqual([{ kind: "ctx", text: "(binary file differs)" }]);
  });

  test("multiple files parsed independently", () => {
    const raw = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+new",
    ].join("\n");
    const out = parseGitDiff(raw);
    expect(out.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(out[1].status).toBe("added");
  });

  test("empty input → empty list", () => {
    expect(parseGitDiff("")).toEqual([]);
  });

  test("a file past the row bound still counts every line, and says it was bounded", () => {
    // The bound used to sit ABOVE the counters, so a large file stopped
    // counting as well as stopped showing — and then presented the undercount
    // as the file's +/- totals, with nothing marking it as partial.
    const adds = 1_400, dels = 300;
    const raw = [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,300 +1,1400 @@",
      ...Array.from({ length: dels }, (_, i) => `-old ${i}`),
      ...Array.from({ length: adds }, (_, i) => `+new ${i}`),
    ].join("\n");
    const [file] = parseGitDiff(raw);
    expect(file.added).toBe(adds);
    expect(file.removed).toBe(dels);
    expect(file.truncated).toBe(true);
    // The body is bounded exactly — hunk headers are carried through the same
    // bound, so a truncated file cannot grow past it either.
    expect(file.lines.length).toBe(MAX_LINES_PER_FILE);
  });

  test("a file within the bound carries no truncation marker", () => {
    const raw = [
      "diff --git a/small.txt b/small.txt",
      "--- a/small.txt",
      "+++ b/small.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const [file] = parseGitDiff(raw);
    expect(file.truncated).toBeUndefined();
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
  });
});

describe("diffLines cost bound", () => {
  /**
   * 256 KiB of 32-byte lines: the adversarial file the snapshot gate admits,
   * because that gate counts BYTES while the alignment's cost is driven by
   * LINES. A lockfile, a CSV, a log, a minified bundle.
   *
   * Measured in a real workerd isolate (local://v8-sizing-probe.md): a whole-file
   * (n+1)x(m+1) table over this input peaks the isolate at +330 MiB and 4.6 s.
   * The wall it crosses is `do.isolate.reset_silent` (~200 MiB), whose breach
   * resets the object with nothing thrown and nothing logged — and Output polls
   * this path every 2 seconds, so one such file reset the DO in a loop the owner
   * could only escape by closing the tab.
   */
  const LINES = 8192;
  const body = (i: number) => `${i % 10}`.repeat(31);
  const before = Array.from({ length: LINES }, (_, i) => body(i)).join("\n");
  const after = (() => {
    const rows = Array.from({ length: LINES }, (_, i) => body(i));
    rows[LINES >> 1] = "X".repeat(31);
    return rows.join("\n");
  })();

  test("a one-line change in a huge file is aligned exactly, and cheaply", () => {
    expect(before.length + 1).toBe(256 * 1024);   // denominator: the gate admits this

    const started = performance.now();
    const d = diffLines(before, after);
    const elapsed = performance.now() - started;

    // Only the differing REGION is aligned, so this is a 1x1 table rather than
    // 8193x8193 — and the answer is therefore exact, not a coarse fallback.
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    // Cost guard against a whole-file table: this input took 1.15 s building one
    // in this runtime and 4.6 s in workerd, while the region-scoped path needs
    // single-digit ms. 250 ms is far under the former and far over the latter,
    // so it is not sensitive to machine speed.
    expect(elapsed).toBeLessThan(250);
    // The body is still held to the row bound, and says so.
    expect(d.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(d.truncated).toBe(true);
  });

  test("a huge file whose every line differs is refused rather than aligned", () => {
    // No shared head or tail to strip, so the differing region IS the file and
    // the bound is what stands between this input and a 330 MiB table.
    const rewritten = Array.from({ length: LINES }, (_, i) => `${(i % 10) + 1}`.repeat(31)).join("\n");

    const started = performance.now();
    const d = diffLines(before, rewritten);
    const elapsed = performance.now() - started;

    // No alignment was computed, so no body is offered — and it says so rather
    // than presenting an empty diff as "no changes".
    expect(d.lines).toEqual([]);
    expect(d.truncated).toBe(true);
    // Coarse but true: every line of the differing region out, every line in.
    expect(d.removed).toBe(LINES);
    expect(d.added).toBe(LINES);
    expect(elapsed).toBeLessThan(250);
  });

  test("a body clipped at the row bound still reports the file's real totals", () => {
    // Inside the alignment bound, past the row bound: every line differs, so
    // the alignment yields 2x MAX_LINES_PER_FILE rows and the body clips while
    // the counters keep counting.
    const n = MAX_LINES_PER_FILE;
    const a = Array.from({ length: n }, (_, i) => `old ${i}`).join("\n");
    const b = Array.from({ length: n }, (_, i) => `new ${i}`).join("\n");

    const d = diffLines(a, b);

    expect(d.added).toBe(n);
    expect(d.removed).toBe(n);
    expect(d.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(d.truncated).toBe(true);
  });

  test("a large newly added file is still readable — one empty side needs no table", () => {
    // The workspace-birth shape: every file diffed against an empty baseline.
    // The common subsequence is empty by definition there, so the bound must
    // not refuse a file it can answer exactly and cheaply.
    const d = diffLines("", after);

    expect(d.added).toBe(LINES);
    expect(d.removed).toBe(0);
    expect(d.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(d.truncated).toBe(true);
    expect(d.lines[0]).toEqual({ kind: "add", text: body(0) });
  });

  test("a file within both bounds is untouched by either", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc");
    expect(d.truncated).toBeUndefined();
    expect(d.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c"]);
  });
});
