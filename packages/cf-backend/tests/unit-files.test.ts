// Behavior tests for the file-manager plumbing: each executor's own file view
// and the writeExecutorFileOp seam over it.
import { describe, test, expect } from "bun:test";
import {
  deleteExecutorPathOp, getExecutorFiles, inlineFileType, readExecutorFileBytes,
  renameExecutorPathOp, sortDirEntries, writeExecutorFileOp, type VFS,
} from "@kinu.run/core";
import { fileResponseHeaders } from "../src/lib/http";

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

/** A tree-shaped file view with real directory semantics, plus recorders for
 *  the native mutations a plane may declare — what the file-manager ops probe. */
function makeTree(seed: Record<string, string>, opts: { native?: boolean } = {}) {
  const files = new Map<string, string | Uint8Array>(Object.entries(seed));
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    for (let at = path.indexOf("/", 1); at !== -1; at = path.indexOf("/", at + 1)) {
      dirs.add(path.slice(0, at));
    }
  }
  const renames: Array<[string, string]> = [];
  const removed: string[] = [];
  const vfs: VFS = {
    readFile: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return data;
    },
    writeFile: async (path, data) => { files.set(path, data); },
    readdir: async (path) => {
      const names = new Set<string>();
      const prefix = path === "/" ? "/" : `${path}/`;
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
    stat: async (path) => {
      if (files.has(path)) return { size: files.get(path)!.length, mtimeMs: 1_724_500_000_000, isDir: false };
      return dirs.has(path) ? { size: 0, mtimeMs: 0, isDir: true } : null;
    },
    unlink: async (path) => { files.delete(path); dirs.delete(path); },
    mkdir: async (path) => { dirs.add(path); },
    exists: async (path) => files.has(path) || dirs.has(path),
  };
  const native = opts.native
    ? {
      rename: async (oldPath: string, newPath: string) => {
        renames.push([oldPath, newPath]);
        files.set(newPath, files.get(oldPath) ?? "");
        files.delete(oldPath);
      },
      removeRecursive: async (path: string) => { removed.push(path); dirs.delete(path); },
    }
    : {};
  const deps = { getProvider: () => ({ files: { ...vfs, ...native }, homeDir: async () => "/home/user" }) };
  return { deps, files, dirs, renames, removed };
}

describe("renameExecutorPathOp", () => {
  test("uses the plane's native rename where it declares one", async () => {
    const { deps, renames } = makeTree({ "/home/user/a.txt": "x" }, { native: true });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/user/a.txt", "/home/user/b.txt");
    expect(out).toEqual({ ok: true });
    expect(renames).toEqual([["/home/user/a.txt", "/home/user/b.txt"]]);
  });

  test("carries a file's bytes on a plane with no native rename", async () => {
    const { deps, files } = makeTree({ "/home/user/a.txt": "carried" });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/user/a.txt", "/home/user/b.txt");
    expect(out).toEqual({ ok: true });
    expect(files.get("/home/user/b.txt")).toBe("carried");
    expect(files.has("/home/user/a.txt")).toBe(false);
  });

  test("refuses a directory where only bytes could carry it", async () => {
    const { deps, files } = makeTree({ "/home/user/src/app.ts": "export {};" });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/user/src", "/home/user/moved");
    expect("error" in out && out.error).toContain("directory");
    expect(files.has("/home/user/src/app.ts")).toBe(true);
  });

  test("never overwrites: an existing target is a stated refusal", async () => {
    const { deps, files } = makeTree({ "/home/user/a.txt": "keep me", "/home/user/b.txt": "target" }, { native: true });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/user/a.txt", "/home/user/b.txt");
    expect("error" in out && out.error).toContain("already exists");
    expect(files.get("/home/user/b.txt")).toBe("target");
  });

  test("a missing source is a typed error, not a throw", async () => {
    const { deps } = makeTree({});
    const out = await renameExecutorPathOp(deps, "workspace", "/home/user/gone.txt", "/home/user/b.txt");
    expect("error" in out).toBe(true);
  });
});

describe("deleteExecutorPathOp", () => {
  test("a file is one unlink", async () => {
    const { deps, files } = makeTree({ "/home/user/a.txt": "x" });
    const out = await deleteExecutorPathOp(deps, "workspace", "/home/user/a.txt");
    expect(out).toEqual({ ok: true });
    expect(files.has("/home/user/a.txt")).toBe(false);
  });

  test("a directory uses the native tree removal where one exists", async () => {
    const { deps, removed } = makeTree({ "/home/user/build/out.js": "x" }, { native: true });
    const out = await deleteExecutorPathOp(deps, "workspace", "/home/user/build");
    expect(out).toEqual({ ok: true });
    expect(removed).toEqual(["/home/user/build"]);
  });

  test("a directory on a plane without native removal goes entry by entry", async () => {
    const { deps, files, dirs } = makeTree({
      "/home/user/build/out.js": "x",
      "/home/user/build/deep/two.js": "y",
    });
    const out = await deleteExecutorPathOp(deps, "workspace", "/home/user/build");
    expect(out).toEqual({ ok: true });
    expect(files.size).toBe(0);
    expect(dirs.has("/home/user/build")).toBe(false);
  });

  test("a missing path and the root both refuse", async () => {
    const { deps } = makeTree({});
    expect("error" in await deleteExecutorPathOp(deps, "workspace", "/gone")).toBe(true);
    expect("error" in await deleteExecutorPathOp(deps, "workspace", "/")).toBe(true);
  });
});

describe("readExecutorFileBytes", () => {
  test("binary bytes round-trip untouched — the text viewer's refusal does not apply here", async () => {
    const { deps } = makeTree({});
    const bytes = new Uint8Array([0, 1, 2, 255, 0, 128]);
    await writeExecutorFileOp(deps, "workspace", "/home/user/blob.bin", bytes);
    const out = await readExecutorFileBytes(deps, "workspace", "/home/user/blob.bin");
    if ("error" in out) throw new Error(out.error);
    expect([...out.bytes]).toEqual([...bytes]);
  });

  test("a string-answering plane still yields bytes", async () => {
    const { deps } = makeTree({ "/home/user/notes.md": "text" });
    const out = await readExecutorFileBytes(deps, "workspace", "/home/user/notes.md");
    if ("error" in out) throw new Error(out.error);
    expect(new TextDecoder().decode(out.bytes)).toBe("text");
  });

  test("a directory refuses instead of answering garbage", async () => {
    const { deps } = makeTree({ "/home/user/src/app.ts": "x" });
    expect("error" in await readExecutorFileBytes(deps, "workspace", "/home/user/src")).toBe(true);
  });
});

describe("getExecutorFiles", () => {
  test("entries carry the stat they were typed from: kind, size and mtime", async () => {
    const { deps } = makeTree({ "/home/user/notes.md": "12345" });
    const out = await getExecutorFiles(deps, "workspace", "/home/user");
    expect(out.path).toBe("/home/user");
    expect(out.entries).toEqual([
      { name: "notes.md", type: "file", size: 5, mtimeMs: 1_724_500_000_000 },
    ]);
  });

  test("every ancestor of the canonical home names the next segment down, even where the box lists nothing", async () => {
    // A fresh workspace's physical root has no directory entries at all, so
    // '/' listed only the mounts and the whole tree was unreachable.
    const { deps } = makeTree({});
    const root = await getExecutorFiles(deps, "workspace", "/");
    expect(root.entries).toEqual([{ name: "home", type: "dir" }]);
    const mid = await getExecutorFiles(deps, "workspace", "/home");
    expect(mid.entries).toEqual([{ name: "user", type: "dir" }]);
    // …and a real entry set is left alone: no duplicate, no phantom.
    const seeded = await getExecutorFiles(deps, "workspace", "/home/user");
    expect(seeded.entries).toEqual([]);
  });
});

describe("inlineFileType", () => {
  test("the Files surface and HTTP route share image and PDF classification", () => {
    expect(inlineFileType("/home/user/shot.PNG")).toBe("image/png");
    expect(inlineFileType("/home/user/report.pdf")).toBe("application/pdf");
    expect(inlineFileType("/home/user/readme.txt")).toBeUndefined();
  });
});

describe("fileResponseHeaders — the download route's security posture", () => {
  test("an image previews inline, nosniffed, under a sandbox CSP", () => {
    const h = fileResponseHeaders("/home/user/shot.PNG", false);
    expect(h.get("content-type")).toBe("image/png");
    expect(h.get("content-disposition")).toContain("inline");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("content-security-policy")).toBe("sandbox");
  });

  test("a PDF previews inline in the platform viewer without the sandbox CSP", () => {
    const h = fileResponseHeaders("/home/user/report.pdf", false);
    expect(h.get("content-type")).toBe("application/pdf");
    expect(h.get("content-disposition")).toContain("inline");
    expect(h.get("content-security-policy")).toBeNull();
  });

  test("anything else downloads as opaque bytes — html never renders on this origin", () => {
    const h = fileResponseHeaders("/home/user/index.html", false);
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("content-disposition")).toContain("attachment");
  });

  test("download=1 forces attachment even for an image, and the filename is carried encoded", () => {
    const h = fileResponseHeaders("/home/user/résumé shot.png", true);
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("content-disposition")).toContain("attachment");
    expect(h.get("content-disposition")).toContain(encodeURIComponent("résumé shot.png"));
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
