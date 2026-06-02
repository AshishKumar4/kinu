// Behavior tests for the readdir normalizer that backs the file manager.
// Each executor's readdir has a different shape; parseReaddirEntries unifies
// them into typed DirEntry[] (dirs first, alphabetical, no . / ..).
import { describe, test, expect } from "bun:test";
import { parseReaddirEntries, sortDirEntries } from "../src/lib/files";

describe("parseReaddirEntries", () => {
  test("parses the sandbox 'd/- name' format (dirs first, alphabetical)", () => {
    const out = parseReaddirEntries("d src\n- a.md\n- b.json\nd lib");
    expect(out).toEqual([
      { name: "lib", type: "dir", size: undefined },
      { name: "src", type: "dir", size: undefined },
      { name: "a.md", type: "file", size: undefined },
      { name: "b.json", type: "file", size: undefined },
    ]);
  });

  test("parses the nimbus 'd name (123b)' size suffix", () => {
    const out = parseReaddirEntries("d logs (4096b)\n- app.ts (812b)");
    expect(out).toEqual([
      { name: "logs", type: "dir", size: 4096 },
      { name: "app.ts", type: "file", size: 812 },
    ]);
  });

  test("parses a plain string[] (laptop ls -1a), trailing slash = dir", () => {
    const out = parseReaddirEntries(["bin/", "main.rs", "Cargo.toml"]);
    expect(out).toEqual([
      { name: "bin", type: "dir" },
      { name: "Cargo.toml", type: "file" },
      { name: "main.rs", type: "file" },
    ]);
  });

  test("drops '.' and '..' and blank lines", () => {
    const out = parseReaddirEntries(".\n..\n- real.txt\n\n");
    expect(out).toEqual([{ name: "real.txt", type: "file", size: undefined }]);
  });

  test("falls back to file for unrecognized plain lines", () => {
    const out = parseReaddirEntries("justaname.txt");
    expect(out).toEqual([{ name: "justaname.txt", type: "file" }]);
  });

  test("empty / nullish input → empty list", () => {
    expect(parseReaddirEntries("")).toEqual([]);
    expect(parseReaddirEntries(null)).toEqual([]);
    expect(parseReaddirEntries(undefined)).toEqual([]);
  });
});

describe("sortDirEntries", () => {
  test("dirs before files, alphabetical within each group", () => {
    const out = sortDirEntries([
      { name: "z.txt", type: "file" },
      { name: "beta", type: "dir" },
      { name: "a.txt", type: "file" },
      { name: "alpha", type: "dir" },
    ]);
    expect(out.map((e) => e.name)).toEqual(["alpha", "beta", "a.txt", "z.txt"]);
  });
});
