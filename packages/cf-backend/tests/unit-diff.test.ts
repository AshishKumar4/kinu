import { describe, test, expect } from "bun:test";
import { diffLines } from "../src/lib/diff.ts";

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
