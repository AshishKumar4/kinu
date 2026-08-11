import { describe, test, expect } from "bun:test";
import { diffLines, computeWorkspaceDiff, parseGitDiff, MAX_LINES_PER_FILE } from "../src/lib/diff.ts";

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
