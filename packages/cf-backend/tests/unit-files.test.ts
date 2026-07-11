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
  /** In-memory deps: a capturing composite VFS, optionally throwing like a
   *  reserved/offline mount. */
  function makeDeps(opts: { throwOn?: RegExp; error?: string } = {}) {
    const written = new Map<string, Uint8Array | string>();
    const deps: ExecutorWriteDeps = {
      vfs: {
        writeFile: async (path, data) => {
          if (opts.throwOn?.test(path)) throw new Error(opts.error ?? "mount unavailable");
          written.set(path, data);
        },
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

  test("executor uploads land BINARY-SAFE through the executor's composite mount", async () => {
    const { deps, written } = makeDeps();
    const bin = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0xfe]);
    expect(await writeExecutorFileOp(deps, "sandbox", "/workspace/logo.png", encodeBase64(bin))).toEqual({ ok: true });
    expect(written.get("/sandbox/workspace/logo.png")).toEqual(bin);

    expect(await writeExecutorFileOp(deps, "nimbus", "/home/user/a.bin", encodeBase64(bin))).toEqual({ ok: true });
    expect(written.get("/nimbus/home/user/a.bin")).toEqual(bin);

    expect(await writeExecutorFileOp(deps, "laptop", "/home/me/proj/b.bin", encodeBase64(bin))).toEqual({ ok: true });
    expect(written.get("/pc/home/me/proj/b.bin")).toEqual(bin);
  });

  test("an unavailable mount surfaces the composite's honest reservation error", async () => {
    const { deps } = makeDeps({
      throwOn: /^\/sandbox\//,
      error: "ENXIO: /sandbox is not available (sandbox executor not configured), open '/sandbox/workspace/x'",
    });
    const result = await writeExecutorFileOp(deps, "sandbox", "/workspace/x", encodeBase64(new TextEncoder().encode("y")));
    expect(result).toMatchObject({ error: expect.stringContaining("/sandbox is not available") });
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

describe("MAX_INLINE_ATTACHMENT_BYTES", () => {
  test("a max-size attachment message fits the agents SDK row guard", async () => {
    const { MAX_INLINE_ATTACHMENT_BYTES } = await import("@proteus/core");
    const { ROW_MAX_BYTES } = await import("agents/chat");
    // Chat messages persist as ONE DO SQLite row (2 MB platform limit); the
    // SDK truncates to ROW_MAX_BYTES but can shrink only TEXT parts — file
    // parts ride through verbatim as base64 data URLs (4/3 × raw). Keep slack
    // for the message text + JSON envelope so a max-size attachment message
    // never hits the guard.
    const encoded = Math.ceil((MAX_INLINE_ATTACHMENT_BYTES * 4) / 3);
    const slack = 256 * 1024;
    expect(encoded + slack).toBeLessThan(ROW_MAX_BYTES);
    expect(ROW_MAX_BYTES).toBeLessThan(2 * 1024 * 1024);
  });
});
