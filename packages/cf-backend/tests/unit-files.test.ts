// Behavior tests for the file-manager plumbing: each executor's own file view
// and the writeExecutorFileOp seam over it.
import { describe, test, expect } from "bun:test";
import { sortDirEntries, writeExecutorFileOp, type VFS } from "@kinu.run/core";

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
  /** A router of one executor whose file view captures what it is given —
   *  optionally throwing, like an environment that went offline. */
  function makeDeps(opts: { throwOn?: RegExp; error?: string } = {}) {
    const written = new Map<string, Uint8Array | string>();
    const files: VFS = {
      readFile: async (path) => {
        const data = written.get(path);
        if (data === undefined) throw new Error(`ENOENT: ${path}`);
        return data;
      },
      writeFile: async (path: string, data: Uint8Array | string) => {
        if (opts.throwOn?.test(path)) throw new Error(opts.error ?? "environment unavailable");
        written.set(path, data);
      },
      readdir: async () => [],
      stat: async (path) => {
        const data = written.get(path);
        if (data === undefined) return null;
        const size = data instanceof Uint8Array ? data.length : new TextEncoder().encode(data).length;
        return { size, mtimeMs: 0, isDir: false };
      },
      unlink: async (path) => { written.delete(path); },
      mkdir: async () => undefined,
      exists: async (path) => written.has(path),
    };
    const deps = { getProvider: () => ({ files, homeDir: async () => "/home/user" }) };
    return { deps, written };
  }

  test("workspace upload round-trips binary content through the VFS", async () => {
    const { deps, written } = makeDeps();
    const bytes = new Uint8Array([0, 1, 2, 255, 0, 128]); // includes NULs — binary-safe path
    const result = await writeExecutorFileOp(deps, "workspace", "/uploads/blob.bin", bytes);
    expect(result).toEqual({ ok: true });
    expect(written.get("/uploads/blob.bin")).toEqual(bytes);
  });

  test("executor uploads land BINARY-SAFE through the executor's own file view", async () => {
    const { deps, written } = makeDeps();
    const bin = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0xfe]);
    // Each environment gets the path in ITS OWN namespace — no prefix is added
    // and none is stripped, because there is no namespace above them to map.
    expect(await writeExecutorFileOp(deps, "sandbox", "/workspace/logo.png", bin)).toEqual({ ok: true });
    expect(written.get("/workspace/logo.png")).toEqual(bin);

    expect(await writeExecutorFileOp(deps, "nimbus", "/home/user/a.bin", bin)).toEqual({ ok: true });
    expect(written.get("/home/user/a.bin")).toEqual(bin);

    expect(await writeExecutorFileOp(deps, "laptop", "/home/me/proj/b.bin", bin)).toEqual({ ok: true });
    expect(written.get("/home/me/proj/b.bin")).toEqual(bin);
  });

  test("an unavailable environment surfaces its own honest reason", async () => {
    const { deps } = makeDeps({
      throwOn: /^\/workspace\//,
      error: "the sandbox container is not running",
    });
    const result = await writeExecutorFileOp(deps, "sandbox", "/workspace/x", new TextEncoder().encode("y"));
    expect(result).toMatchObject({ error: expect.stringContaining("not running") });
  });

  test("an environment with no file plane → typed error, not a throw", async () => {
    const result = await writeExecutorFileOp(
      { getProvider: () => undefined }, "ghost", "/a", new TextEncoder().encode("x"),
    );
    expect(result).toEqual({ error: 'Executor "ghost" has no file plane' });
  });

  test("rejects a missing path and a directory path", async () => {
    const one = new Uint8Array([1]);
    const { deps, written } = makeDeps();
    expect(await writeExecutorFileOp(deps, "workspace", "", one)).toEqual({ error: "file path required" });
    expect(await writeExecutorFileOp(deps, "workspace", "/uploads/", one)).toEqual({ error: "file path required" });
    expect(written.size).toBe(0);
  });

  test("a file past the old 2 MB cap is written, not refused", async () => {
    // The cap sat ABOVE the transport it claimed to respect: 2 MB raw is
    // ~2.7 MB of base64 over a WebSocket whose message ceiling is 1 MiB, so
    // files between ~750 KB and 2 MB passed the app check and died at the
    // socket as an opaque connection failure. Uploads are HTTP now, the bytes
    // are raw, and the VFS chunks what it stores — so there is nothing left
    // for an app-level cap to protect.
    const { deps, written } = makeDeps();
    const big = new Uint8Array(3 * 1024 * 1024);
    expect(await writeExecutorFileOp(deps, "workspace", "/uploads/big.bin", big)).toEqual({ ok: true });
    const stored = written.get("/uploads/big.bin");
    if (!(stored instanceof Uint8Array)) throw new Error("binary upload was not stored as bytes");
    expect(stored.length).toBe(big.length);
  });
});

describe("CLOUD_MAX_INLINE_ATTACHMENT_BYTES", () => {
  test("a max-size attachment message fits the agents SDK row guard, under the platform row cap", async () => {
    const { CLOUD_MAX_INLINE_ATTACHMENT_BYTES, PLATFORM_CATALOG } = await import("@kinu.run/core");
    const { ROW_MAX_BYTES } = await import("agents/chat");
    // Chat messages persist as ONE DO SQLite row; the SDK truncates to
    // ROW_MAX_BYTES but can shrink only TEXT parts — file parts ride through
    // verbatim as base64 data URLs (4/3 × raw). Keep slack for the message text
    // + JSON envelope so a max-size attachment message never hits the guard.
    //
    // The platform end of the chain is read from `do.sqlite.row_bytes` rather
    // than retyped here. That is the whole point of the catalog: this assertion
    // is what makes the entry load-bearing, and it fails if either the entry or
    // the SDK moves.
    const platformRowBytes = PLATFORM_CATALOG["do.sqlite.row_bytes"].limit.value;
    const encoded = Math.ceil((CLOUD_MAX_INLINE_ATTACHMENT_BYTES * 4) / 3);
    const slack = 256 * 1024;
    expect(encoded + slack).toBeLessThan(ROW_MAX_BYTES);
    expect(ROW_MAX_BYTES).toBeLessThan(platformRowBytes);
  });
});
