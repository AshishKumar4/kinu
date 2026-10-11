import { describe, test, expect } from "bun:test";
import { diffLines, parseGitDiff, MAX_LINES_PER_FILE } from "@kinu.run/core";

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

  test("ambiguous changes use GNU placement with the same minimal totals", () => {
    expect(diffLines("a\na", "b\na\nb")).toEqual({
      lines: [
        { kind: "add", text: "b" }, { kind: "ctx", text: "a" },
        { kind: "del", text: "a" }, { kind: "add", text: "b" },
      ],
      added: 2, removed: 1,
    });
  });

  test("every short binary-line edit has minimal totals and reconstructs both files", () => {
    const cases = [""];

    for (let length = 1; length <= 5; length++) {
      for (let bits = 0; bits < 2 ** length; bits++) {
        cases.push(Array.from({ length }, (_, i) => (bits & (1 << i)) === 0 ? "a" : "b").join("\n"));
      }
    }

    const sequences = cases.map((text) => {
      const lines = text === "" ? [] : text.split("\n");
      const words = new Set([""]);

      for (const line of lines) {
        const extended = Array.from(words, (word) => word + line);

        for (const word of extended) words.add(word);
      }

      return { text, lines, words };
    });

    for (const before of sequences) {
      for (const after of sequences) {
        const kept = Math.max(...[...before.words]
          .filter((word) => after.words.has(word))
          .map((word) => word.length));

        const diff = diffLines(before.text, after.text);

        expect({ added: diff.added, removed: diff.removed }).toEqual({ added: after.lines.length - kept, removed: before.lines.length - kept });
        expect(diff.lines.filter((line) => line.kind !== "add").map((line) => line.text)).toEqual(before.lines);
        expect(diff.lines.filter((line) => line.kind !== "del").map((line) => line.text)).toEqual(after.lines);
      }
    }
  });

  test.each([
    { before: "alpha", after: "alpha\n", rows: ["ctx:alpha", "add:"], added: 1, removed: 0 },
    { before: "alpha\n", after: "alpha", rows: ["ctx:alpha", "del:"], added: 0, removed: 1 },
    { before: "alpha\n", after: "alpha\n", rows: ["ctx:alpha", "ctx:"], added: 0, removed: 0 },
    { before: "alpha\n", after: "beta\n", rows: ["del:alpha", "add:beta", "ctx:"], added: 1, removed: 1 },
    { before: "", after: "\n", rows: ["add:", "add:"], added: 2, removed: 0 },
    { before: "\n", after: "", rows: ["del:", "del:"], added: 0, removed: 2 },
    { before: "alpha\n\n", after: "alpha\n", rows: ["ctx:alpha", "ctx:", "del:"], added: 0, removed: 1 },
    { before: "alpha\r\n", after: "alpha\n", rows: ["del:alpha\r", "add:alpha", "ctx:"], added: 1, removed: 1 },
  ])("final empty items remain rows: $before to $after", ({ before, after, rows, added, removed }) => {
    const diff = diffLines(before, after);

    expect(diff.lines.map((line) => `${line.kind}:${line.text}`)).toEqual([...rows]);
    expect({ added: diff.added, removed: diff.removed }).toEqual({ added, removed });
    expect(diff.truncated).toBeUndefined();
  });

  test("line equality distinguishes lone surrogates as well as Unicode text", () => {
    const diff = diffLines("\ud800\né\n\udc80", "\ud801\né\n\udc81");

    expect(diff).toEqual({
      lines: [
        { kind: "del", text: "\ud800" }, { kind: "add", text: "\ud801" },
        { kind: "ctx", text: "é" },
        { kind: "del", text: "\udc80" }, { kind: "add", text: "\udc81" },
      ],
      added: 2, removed: 2,
    });
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
    expect(out[0].lines[0]).toEqual({ kind: "hunk", text: "@@ -1,3 +1,3 @@" });
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

  test("binary file → marked binary, with no rows and no counts", () => {
    const raw = [
      "diff --git a/img.png b/img.png",
      "index 5555555..6666666 100644",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");

    expect(parseGitDiff(raw)).toEqual([{ path: "img.png", status: "changed", added: 0, removed: 0, lines: [], omitted: "binary" }]);
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
    // Counters run over every line; the bound stops only the body, so totals are never an undercount.
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
    // Hunk headers pass through the same bound, so a truncated body cannot exceed it.
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

describe("diffLines presentation bound", () => {
  /**
   * 256 KiB of 32-byte lines: the snapshot gate counts bytes, alignment cost is driven by lines.
   * Measured in workerd (local://v8-sizing-probe.md): a whole-file table peaks at +330 MiB, past
   * `do.isolate.reset_silent` (~200 MiB), resetting the DO silently on every Output poll.
   */
  const LINES = 8192;
  const body = (i: number) => `${i % 10}`.repeat(31);
  const before = Array.from({ length: LINES }, (_, i) => body(i)).join("\n");

  const after = (() => {
    const rows = Array.from({ length: LINES }, (_, i) => body(i));
    rows[LINES >> 1] = "X".repeat(31);

    return rows.join("\n");
  })();

  test("a one-line change in a huge file is aligned exactly", () => {
    expect(before.length + 1).toBe(256 * 1024);   // denominator: the gate admits this

    const d = diffLines(before, after);

    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(d.truncated).toBe(true);
  });

  test("a huge rewritten file is aligned while its carried rows stay bounded", () => {
    const rewritten = Array.from({ length: LINES }, (_, i) => `rewritten ${i}`).join("\n");

    const d = diffLines(before, rewritten);

    expect(d.lines).toHaveLength(MAX_LINES_PER_FILE);
    expect(d.lines[0]).toEqual({ kind: "del", text: body(0) });
    expect(d.truncated).toBe(true);
    expect(d.removed).toBe(LINES);
    expect(d.added).toBe(LINES);
  });

  test("a body clipped at the row bound still reports the file's real totals", () => {
    // Past the row bound: the body clips while the counters keep counting.
    const n = MAX_LINES_PER_FILE;
    const a = Array.from({ length: n }, (_, i) => `old ${i}`).join("\n");
    const b = Array.from({ length: n }, (_, i) => `new ${i}`).join("\n");

    const d = diffLines(a, b);

    expect(d.added).toBe(n);
    expect(d.removed).toBe(n);
    expect(d.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(d.truncated).toBe(true);
  });

  test("a large newly added file is still readable", () => {
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
