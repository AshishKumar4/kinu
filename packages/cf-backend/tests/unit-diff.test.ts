import { describe, test, expect } from "bun:test";
import { diffLines, computeWorkspaceDiff } from "../src/lib/diff.ts";

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
