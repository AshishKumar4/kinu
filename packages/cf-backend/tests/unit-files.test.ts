// Behavior tests for the file-manager plumbing: the executor→composite path
// mapping (one plane for read and write) and the writeExecutorFileOp seam.
import { describe, test, expect } from "bun:test";
import {
  sortDirEntries,
  toCompositePath,
  writeExecutorFileOp,
  type ExecutorWriteDeps,
} from "@proteus/core";

describe("toCompositePath", () => {
  test("workspace paths pass through unchanged", () => {
    expect(toCompositePath("workspace", "/src/main.ts")).toBe("/src/main.ts");
    expect(toCompositePath("workspace", "/")).toBe("/");
  });

  test("remote executors map onto their mount prefix (leading slash normalized)", () => {
    expect(toCompositePath("sandbox", "/workspace/a.ts")).toBe("/sandbox/workspace/a.ts");
    expect(toCompositePath("nimbus", "home/user/b")).toBe("/nimbus/home/user/b");
    expect(toCompositePath("laptop", "/home/me/c")).toBe("/pc/home/me/c");
  });

  test("an executor with no file plane → null", () => {
    expect(toCompositePath("ghost", "/a")).toBeNull();
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
    const result = await writeExecutorFileOp(deps, "workspace", "/uploads/blob.bin", bytes);
    expect(result).toEqual({ ok: true });
    expect(written.get("/uploads/blob.bin")).toEqual(bytes);
  });

  test("executor uploads land BINARY-SAFE through the executor's composite mount", async () => {
    const { deps, written } = makeDeps();
    const bin = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0xfe]);
    expect(await writeExecutorFileOp(deps, "sandbox", "/workspace/logo.png", bin)).toEqual({ ok: true });
    expect(written.get("/sandbox/workspace/logo.png")).toEqual(bin);

    expect(await writeExecutorFileOp(deps, "nimbus", "/home/user/a.bin", bin)).toEqual({ ok: true });
    expect(written.get("/nimbus/home/user/a.bin")).toEqual(bin);

    expect(await writeExecutorFileOp(deps, "laptop", "/home/me/proj/b.bin", bin)).toEqual({ ok: true });
    expect(written.get("/pc/home/me/proj/b.bin")).toEqual(bin);
  });

  test("an unavailable mount surfaces the composite's honest reservation error", async () => {
    const { deps } = makeDeps({
      throwOn: /^\/sandbox\//,
      error: "ENXIO: /sandbox is not available (sandbox executor not configured), open '/sandbox/workspace/x'",
    });
    const result = await writeExecutorFileOp(deps, "sandbox", "/workspace/x", new TextEncoder().encode("y"));
    expect(result).toMatchObject({ error: expect.stringContaining("/sandbox is not available") });
  });

  test("unknown executor → typed error", async () => {
    const { deps } = makeDeps();
    const result = await writeExecutorFileOp(deps, "ghost", "/a", new TextEncoder().encode("x"));
    expect(result).toEqual({ error: 'Executor "ghost" not found' });
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
    expect((written.get("/uploads/big.bin") as Uint8Array).length).toBe(big.length);
  });
});

describe("CLOUD_MAX_INLINE_ATTACHMENT_BYTES", () => {
  test("a max-size attachment message fits the agents SDK row guard", async () => {
    const { CLOUD_MAX_INLINE_ATTACHMENT_BYTES } = await import("@proteus/core");
    const { ROW_MAX_BYTES } = await import("agents/chat");
    // Chat messages persist as ONE DO SQLite row (2 MB platform limit); the
    // SDK truncates to ROW_MAX_BYTES but can shrink only TEXT parts — file
    // parts ride through verbatim as base64 data URLs (4/3 × raw). Keep slack
    // for the message text + JSON envelope so a max-size attachment message
    // never hits the guard.
    const encoded = Math.ceil((CLOUD_MAX_INLINE_ATTACHMENT_BYTES * 4) / 3);
    const slack = 256 * 1024;
    expect(encoded + slack).toBeLessThan(ROW_MAX_BYTES);
    expect(ROW_MAX_BYTES).toBeLessThan(2 * 1024 * 1024);
  });
});
