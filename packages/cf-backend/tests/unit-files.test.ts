// Behavior tests for the file-manager plumbing: the readdir normalizer
// (each executor's readdir has a different shape; parseReaddirEntries unifies
// them into typed DirEntry[]) and the writeExecutorFileOp upload seam.
import { describe, test, expect } from "bun:test";
import {
  MAX_UPLOAD_BYTES,
  decodeBase64,
  encodeBase64,
  parseReaddirEntries,
  sortDirEntries,
  writeExecutorFileOp,
  type ExecutorWriteDeps,
} from "../src/lib/files";

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

describe("writeExecutorFileOp", () => {
  /** In-memory deps: a capturing workspace VFS + optional provider tool map. */
  function makeDeps(providers: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {}) {
    const written = new Map<string, Uint8Array | string>();
    const deps: ExecutorWriteDeps = {
      vfs: { writeFile: async (path, data) => { written.set(path, data); } },
      getProvider: (id) => {
        const tools = providers[id];
        if (!tools) return null;
        return {
          tools: Object.fromEntries(Object.entries(tools).map(([name, execute]) => [name, { execute }])),
        };
      },
    };
    return { deps, written };
  }

  test("workspace upload round-trips binary content through the VFS", async () => {
    const { deps, written } = makeDeps();
    const bytes = new Uint8Array([0, 1, 2, 255, 0, 128]); // includes NULs — binary-safe path
    const result = await writeExecutorFileOp(deps, "workspace", "/uploads/blob.bin", encodeBase64(bytes));
    expect(result).toEqual({ ok: true });
    expect(written.get("/uploads/blob.bin")).toEqual(bytes);
  });

  test("provider executors route text through their writeFile tool", async () => {
    const calls: unknown[][] = [];
    const { deps, written } = makeDeps({
      nimbus: { writeFile: async (...args) => { calls.push(args); return "ok"; } },
    });
    const result = await writeExecutorFileOp(deps, "nimbus", "/srv/notes.md", encodeBase64(new TextEncoder().encode("# hello")));
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([["/srv/notes.md", "# hello"]]);
    expect(written.size).toBe(0); // never falls through to the workspace VFS
  });

  test("a provider writeFile failure string surfaces as a typed error", async () => {
    const { deps } = makeDeps({
      laptop: { writeFile: async () => "writeFile failed: permission denied" },
    });
    const result = await writeExecutorFileOp(deps, "laptop", "/etc/x", encodeBase64(new TextEncoder().encode("y")));
    expect(result).toEqual({ error: "writeFile failed: permission denied" });
  });

  test("executors without a writeFile tool are read-only", async () => {
    const { deps } = makeDeps({ laptop: { readFile: async () => "" } });
    const result = await writeExecutorFileOp(deps, "laptop", "/tmp/a.txt", encodeBase64(new TextEncoder().encode("x")));
    expect(result).toEqual({ error: 'Executor "laptop" is read-only — it has no writeFile tool' });
  });

  test("binary content is refused on string-typed provider transports", async () => {
    const { deps } = makeDeps({ nimbus: { writeFile: async () => "ok" } });
    const result = await writeExecutorFileOp(deps, "nimbus", "/srv/blob.bin", encodeBase64(new Uint8Array([1, 0, 2])));
    expect(result).toEqual({ error: 'binary upload is not supported on "nimbus" — use the workspace executor' });
  });

  test("unknown executor → typed error", async () => {
    const { deps } = makeDeps();
    const result = await writeExecutorFileOp(deps, "ghost", "/a", encodeBase64(new TextEncoder().encode("x")));
    expect(result).toEqual({ error: 'Executor "ghost" not found' });
  });

  test("rejects a missing path, a directory path, oversize and malformed content", async () => {
    const { deps, written } = makeDeps();
    expect(await writeExecutorFileOp(deps, "workspace", "", "QQ==")).toEqual({ error: "file path required" });
    expect(await writeExecutorFileOp(deps, "workspace", "/uploads/", "QQ==")).toEqual({ error: "file path required" });
    expect(await writeExecutorFileOp(deps, "workspace", "/a", "not base64!!")).toEqual({ error: "invalid base64 content" });
    const over = await writeExecutorFileOp(deps, "workspace", "/a", encodeBase64(new Uint8Array(MAX_UPLOAD_BYTES + 1)));
    expect(over).toEqual({ error: `file too large (${MAX_UPLOAD_BYTES + 1} bytes; max ${MAX_UPLOAD_BYTES})` });
    expect(written.size).toBe(0);
  });

  test("encodeBase64/decodeBase64 round-trip large binary payloads", () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});
