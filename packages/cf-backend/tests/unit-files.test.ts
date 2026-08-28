// Behavior tests for the file-manager plumbing: each executor's own file view
// and the writeExecutorFileOp seam over it.
import { afterEach, describe, test, expect } from "bun:test";
import {
  deleteExecutorPathOp, getExecutorFiles, inlineFileType, readExecutorFile, readExecutorFileBytes,
  renameExecutorPathOp, sortDirEntries, withMountTable, writeExecutorFileOp, type VFS,
} from "@kinu.run/core";
import { setDiagnosticsSink } from "@kinu.run/core/obs";
import { asFetchFunction } from "@kinu.run/core";
import { fileResponseHeaders } from "../src/lib/http";
import {
  entryRevision, fileTextEditable, nextTreeCache, putFileBytes, sandboxedHtml,
  textRenderOf, viewerKindOf,
} from "../src/components/surfaces/files-plane";

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
 *  the native mutations a plane may declare — what the file-manager ops probe.
 *  `unlinkFails` makes removal of matching paths fail, which is how a rename's
 *  carry gets caught half-done. */
function makeTree(seed: Record<string, string>, opts: { native?: boolean; unlinkFails?: RegExp } = {}) {
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
    unlink: async (path) => {
      if (opts.unlinkFails?.test(path)) throw new Error(`EBUSY: ${path} is held open`);
      files.delete(path); dirs.delete(path);
    },
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

  test("a carry that cannot destroy the source leaves ONE name, not two", async () => {
    // KINU-013: the fallback wrote the destination and then unlinked the
    // source. A failed unlink reported an error and left the file under BOTH
    // names, so nothing said which name to trust. A rename either happened or
    // it did not: the carry's copy is removed and the plane is as it was.
    const { deps, files } = makeTree({ "/home/user/a.txt": "carried" }, { unlinkFails: /a\.txt$/ });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/user/a.txt", "/home/user/b.txt");
    expect("error" in out).toBe(true);
    expect(files.get("/home/user/a.txt")).toBe("carried");
    expect(files.has("/home/user/b.txt")).toBe(false);
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

/**
 * Opening `/pc` on a connected machine answered
 * `EACCES: '/' is outside the consented device directory '/home/kinu'`.
 *
 * A mount is a faithful window on the machine's REAL absolute paths, so `/pc`
 * strips to the device's `/` — a directory nobody consented to. The fix is the
 * landing directory, not the translation: a bare mount point lists that plane's
 * own start, which IS the consented root. The fixture below carries the device's
 * path guard, so it can fail in the direction the report came from.
 */
describe("a bare mount point lands inside consent", () => {
  const CONSENTED = "/home/kinu";

  function treeVfs(seed: Record<string, string>): VFS {
    const files = new Map(Object.entries(seed));
    const dirs = new Set<string>();
    for (const path of files.keys()) {
      for (let at = path.indexOf("/", 1); at !== -1; at = path.indexOf("/", at + 1)) {
        dirs.add(path.slice(0, at));
      }
    }
    return {
      readFile: async (path) => {
        const data = files.get(path);
        if (data === undefined) throw new Error(`ENOENT: ${path}`);
        return data;
      },
      writeFile: async (path, data) => { files.set(path, String(data)); },
      readdir: async (path) => {
        const names = new Set<string>();
        const prefix = path === "/" ? "/" : `${path}/`;
        for (const key of [...files.keys(), ...dirs]) {
          if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
        }
        return [...names];
      },
      stat: async (path) => {
        if (files.has(path)) return { size: files.get(path)!.length, mtimeMs: 0, isDir: false };
        return dirs.has(path) || path === "/" ? { size: 0, mtimeMs: 0, isDir: true } : null;
      },
      unlink: async (path) => { files.delete(path); },
      mkdir: async (path) => { dirs.add(path); },
      exists: async (path) => files.has(path) || dirs.has(path),
    };
  }

  /** The device plane's own path guard, in the words `deviceFiles` uses — a
   *  consented root of `/` consents to everything, which is how the
   *  full-filesystem tier reads. */
  function guarded(device: VFS, root: string): VFS {
    const refuse = (path: string, op: string) => {
      if (path === root || root === "/" || path.startsWith(`${root}/`)) return;
      throw new Error(
        `EACCES: '${path}' is outside the consented device directory '${root}' — `
        + `grant this agent the full-filesystem consent tier to reach it, ${op} '${path}'`,
      );
    };
    return {
      ...device,
      readdir: async (path) => { refuse(path, "list"); return device.readdir(path); },
      stat: async (path) => { refuse(path, "stat"); return device.stat(path); },
      readFile: async (path) => { refuse(path, "open"); return device.readFile(path); },
    };
  }

  function router(opts: { deviceHome?: string | null; consented?: string } = {}) {
    const root = opts.consented ?? CONSENTED;
    const under = (name: string) => root === "/" ? `/${name}` : `${root}/${name}`;
    const device = guarded(treeVfs({
      [under("report.txt")]: "Q3",
      [under("src/app.ts")]: "x",
      "/etc/shadow": "secret",
    }), root);
    const workspace = withMountTable(treeVfs({ "/home/user/notes.md": "hi" }), [
      { name: "pc", files: () => device, absentReason: () => "no device connected" },
    ]);
    const home = opts.deviceHome === undefined ? root : opts.deviceHome;
    return {
      getProvider: (name: string) => name === "laptop"
        ? {
          files: device,
          homeDir: async () => {
            if (home === null) throw new Error("device went away mid-question");
            return home;
          },
        }
        : { files: workspace, homeDir: async () => "/home/user" },
    };
  }

  test("/pc lists the consented device directory, not the device root", async () => {
    const out = await getExecutorFiles(router(), "workspace", "/pc");
    expect(out.error).toBeUndefined();
    expect(out.path).toBe("/pc/home/kinu");
    expect(out.entries?.map((e) => e.name).sort()).toEqual(["report.txt", "src"]);
  });

  test("the consent boundary still refuses what it refused before", async () => {
    // Nothing widened: the landing directory moved, the boundary did not.
    const out = await getExecutorFiles(router(), "workspace", "/pc/etc");
    expect(out.entries).toBeUndefined();
    expect(out.error).toContain("outside the consented device directory '/home/kinu'");
  });

  test("a path already inside the mount is passed through untouched", async () => {
    const out = await getExecutorFiles(router(), "workspace", "/pc/home/kinu/src");
    expect(out.path).toBe("/pc/home/kinu/src");
    expect(out.entries?.map((e) => e.name)).toEqual(["app.ts"]);
  });

  test("a device consenting to its whole filesystem keeps the bare mount point", async () => {
    const out = await getExecutorFiles(router({ consented: "/" }), "workspace", "/pc");
    expect(out.path).toBe("/pc");
    expect(out.entries?.map((e) => e.name).sort()).toEqual(["etc", "report.txt", "src"]);
  });

  test("a plane that cannot say where it starts surfaces ITS failure, not the asking's", async () => {
    // The mount point stays bare, so the refusal a reader sees is the device
    // plane's own — never whatever broke while asking it for a home.
    //
    // The two assertions below cannot tell "the fallback was taken" from "the
    // resolution never ran at all": both read as the plane's own refusal, which
    // is the fallback's whole design goal. So the diagnostic is the
    // discriminator. It fires ONLY on the caught path, which is what proves the
    // homeDir failure was absorbed rather than never provoked. Without it this
    // test would stay green over a `MOUNT_EXECUTORS` lookup that stopped
    // matching, measuring its own fixture.
    const events: string[] = [];
    const restore = setDiagnosticsSink({
      event: (name) => { events.push(name); },
      failure: (name) => { events.push(name); },
    });
    try {
      const out = await getExecutorFiles(router({ deviceHome: null }), "workspace", "/pc");
      expect(out.error).toContain("outside the consented device directory");
      expect(out.error).not.toContain("went away mid-question");
      expect(events).toContain("files.mount_home_unavailable");
    } finally {
      restore();
    }
  });

  test("a plane that CAN say where it starts absorbs nothing, and says nothing", async () => {
    // The other side of the discriminator above: on the ordinary path the
    // diagnostic must be absent, or its presence in the test above would prove
    // nothing about which path ran.
    const events: string[] = [];
    const restore = setDiagnosticsSink({
      event: (name) => { events.push(name); },
      failure: (name) => { events.push(name); },
    });
    try {
      const out = await getExecutorFiles(router(), "workspace", "/pc");
      expect(out.path).toBe("/pc/home/kinu");
      expect(events).not.toContain("files.mount_home_unavailable");
    } finally {
      restore();
    }
  });

  test("nothing outside a mount point changes", async () => {
    const out = await getExecutorFiles(router(), "workspace", "/home/user");
    expect(out.path).toBe("/home/user");
    expect(out.entries?.map((e) => e.name)).toEqual(["notes.md"]);
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

/**
 * The drive's ONE way in, and what the user is told when it is refused.
 *
 * The uploader and the viewer's save are the same PUT; each had its own copy of
 * this failure reading, so a refusal one of them could name the other showed as
 * a bare status. The route's words are the message wherever it has any — a body
 * over the transfer limit is a 413 that names the limit, and a reader who
 * dropped a 40 MiB file has to be told that, not "upload failed (413)".
 */
describe("putFileBytes", () => {
  const { fetch: realFetch } = globalThis;
  afterEach(() => { globalThis.fetch = realFetch; });

  /** Every PUT this module makes, plus the answer it gets back. */
  function answering(reply: Response) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    // `asFetchFunction` is the canonical way to satisfy `typeof globalThis.fetch`
    // here: Bun-types' shape carries a `preconnect` member that a bare function
    // literal lacks, and the shim attaches the no-op the SDK never calls.
    globalThis.fetch = asFetchFunction((url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(reply);
    });
    return calls;
  }

  test("a written file is a resolved promise and nothing else", async () => {
    const calls = answering(Response.json({ ok: true }));
    await putFileBytes("/api/workspaces/ws/files?executor=workspace&path=/a.txt", "hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(calls[0]!.init?.body).toBe("hello");
  });

  test("the route's own 413 words reach the reader", async () => {
    answering(Response.json({ error: "file exceeds the 25 MiB transfer limit" }, { status: 413 }));
    await expect(putFileBytes("/files", new Blob(["x"])))
      .rejects.toThrow("file exceeds the 25 MiB transfer limit");
  });

  test("a refusal with no readable body still names the status", async () => {
    answering(new Response("", { status: 502 }));
    await expect(putFileBytes("/files", "x")).rejects.toThrow("502");
  });

  test("a non-JSON refusal body is shown as it arrived", async () => {
    answering(new Response("  gateway said no  ", { status: 500 }));
    await expect(putFileBytes("/files", "x")).rejects.toThrow("gateway said no");
  });
});

/**
 * Which pane a path opens in, and the two answers that are more than layout.
 *
 * The viewer is its own state machine over ONE file — reading, an edit buffer, a
 * save in flight, and the form the text is shown in — and this is its dispatch
 * table, held outside the component so it is assertable. The registry is
 * `inlineFileType`, the same one the download route's headers are built from, so
 * "shown inline here" and "sent inline by the route" cannot drift apart.
 */
describe("the file viewer's dispatch", () => {
  test("an image type opens in the image pane, whatever its extension case", () => {
    expect(viewerKindOf("/home/user/shot.png")).toBe("image");
    expect(viewerKindOf("/home/user/SHOT.PNG")).toBe("image");
    expect(viewerKindOf("/home/user/diagram.svg")).toBe("image");
  });

  test("a PDF opens in the PDF pane", () => {
    expect(viewerKindOf("/home/user/paper.pdf")).toBe("pdf");
  });

  test("everything else is read as text — including a file with no extension", () => {
    expect(viewerKindOf("/home/user/notes.md")).toBe("text");
    expect(viewerKindOf("/home/user/Makefile")).toBe("text");
    expect(viewerKindOf("/home/user/archive.tar.gz")).toBe("text");
  });

  test("Markdown and HTML open rendered; every other text file opens as source", () => {
    expect(textRenderOf("/a/README.md")).toBe("markdown");
    expect(textRenderOf("/a/NOTES.MARKDOWN")).toBe("markdown");
    expect(textRenderOf("/a/page.html")).toBe("html");
    expect(textRenderOf("/a/page.HTM")).toBe("html");
    expect(textRenderOf("/a/main.ts")).toBe("source");
  });

  test("the render is decided by the file's own name, not by a directory above it", () => {
    // `/docs.md/notes.txt` is a text file inside an oddly named directory.
    expect(textRenderOf("/docs.md/notes.txt")).toBe("source");
  });

  test("a clipped read cannot be edited: saving the buffer back would truncate the file", () => {
    expect(fileTextEditable({ content: "first half", truncated: true })).toBe(false);
  });

  test("a failed read cannot be edited, and neither can a read that has not arrived", () => {
    expect(fileTextEditable({ error: "ENOENT" })).toBe(false);
    expect(fileTextEditable(null)).toBe(false);
    // An error field at all is a failed read. A blank reason is a defect in
    // whatever answered, and the safe reading of it is still "do not write
    // this buffer back over the file".
    expect(fileTextEditable({ error: "" })).toBe(false);
  });

  test("a whole read is editable only with the authoritative revision it opened", () => {
    expect(fileTextEditable({ content: "whole" })).toBe(false);
    expect(fileTextEditable({ content: "", revision: 0 })).toBe(true);
    expect(fileTextEditable({ content: "whole", revision: 41 })).toBe(true);
  });

  test("the HTML preview carries a CSP that reaches nothing, ahead of the document", () => {
    const framed = sandboxedHtml("<script>fetch('https://x.example')</script><p>hi</p>");
    expect(framed.startsWith("<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(framed).toContain("default-src 'none'");
    // Styles and embedded/blob images are all the document may use.
    expect(framed).toContain("style-src 'unsafe-inline'");
    expect(framed).toContain("img-src data: blob:");
    // The markup itself is untouched — the iframe's empty sandbox is what
    // neutralises it, and rewriting a user's file to preview it would be a lie.
    expect(framed.endsWith("<script>fetch('https://x.example')</script><p>hi</p>")).toBe(true);
  });
});

/**
 * A plane that records exactly what the read model asked it for.
 *
 * `bytes` is the whole file; `readFile` hands back a copy of all of it, the way
 * every plane with no ranged read must. `readRange` is declared only when
 * `ranged` is set, which is how the seam's two halves are told apart.
 */
function makeCountingPlane(
  path: string, bytes: Uint8Array, opts: { ranged?: boolean; statSize?: number; unstatable?: boolean } = {},
) {
  const asked: Array<{ op: "readFile" | "readRange"; length?: number }> = [];
  const base: VFS = {
    readFile: async (target) => {
      if (target !== path) throw new Error(`ENOENT: ${target}`);
      asked.push({ op: "readFile" });
      return bytes;
    },
    writeFile: async () => undefined,
    readdir: async () => [path.slice(path.lastIndexOf("/") + 1)],
    stat: async (target) => (target === path && opts.unstatable !== true
      ? { size: opts.statSize ?? bytes.byteLength, mtimeMs: 0, isDir: false }
      : null),
    unlink: async () => undefined,
    mkdir: async () => undefined,
    exists: async (target) => target === path,
  };
  const files = opts.ranged
    ? {
      ...base,
      readRange: async (target: string, offset: number, length: number) => {
        if (target !== path) throw new Error(`ENOENT: ${target}`);
        asked.push({ op: "readRange", length });
        return bytes.subarray(offset, offset + length);
      },
    }
    : base;
  return { deps: { getProvider: () => ({ files, homeDir: async () => "/home/user" }) }, asked };
}

const VIEW_CAP = 512 * 1024;

describe("readExecutorFile bounds the preview before it reads", () => {
  test("a text file under the cap carries its unsupported edit reason", async () => {
    const bytes = new TextEncoder().encode("# notes\nline two\n");
    const { deps } = makeCountingPlane("/home/user/notes.md", bytes);
    const result = await readExecutorFile(deps, "workspace", "/home/user/notes.md");
    expect(result).toMatchObject({
      content: "# notes\nline two\n",
      readOnlyReason: expect.stringContaining("cannot protect an in-place edit"),
    });
  });

  test("a plane with a ranged read is asked for the cap, never the file", async () => {
    const big = new Uint8Array(VIEW_CAP * 4).fill(0x61);
    const { deps, asked } = makeCountingPlane("/home/user/huge.log", big, { ranged: true });
    const out = await readExecutorFile(deps, "workspace", "/home/user/huge.log");
    expect(out.truncated).toBe(true);
    expect(out.content?.length).toBe(VIEW_CAP);
    // The whole point: one bounded request, and `readFile` never runs.
    expect(asked).toEqual([{ op: "readRange", length: VIEW_CAP }]);
  });

  test("a plane WITHOUT one refuses an over-budget preview instead of fetching it", async () => {
    const big = new Uint8Array(VIEW_CAP * 4).fill(0x61);
    const { deps, asked } = makeCountingPlane("/home/user/huge.log", big);
    const out = await readExecutorFile(deps, "workspace", "/home/user/huge.log");
    // NEGATIVE CONTROL for the ranged case above: this plane cannot serve a
    // prefix, so the read is refused BEFORE any byte moves. A whole-file read
    // here would be exactly the allocation the bound exists to prevent, wearing
    // the bound's name.
    expect(out.content).toBeUndefined();
    expect(out.error).toContain("no ranged read");
    expect(out.error).toContain("download");
    expect(asked).toEqual([]);
  });

  test("a plane WITHOUT one still previews a file its stat proved fits, read-only", async () => {
    const small = new TextEncoder().encode("small enough\n");
    const { deps, asked } = makeCountingPlane("/home/user/small.txt", small);
    const result = await readExecutorFile(deps, "workspace", "/home/user/small.txt");
    expect(result).toMatchObject({
      content: "small enough\n",
      readOnlyReason: expect.stringContaining("cannot protect an in-place edit"),
    });
    expect(asked).toEqual([{ op: "readFile" }]);
  });

  test("an unstatable file on a plane with no ranged read is refused, never guessed", async () => {
    const { deps, asked } = makeCountingPlane("/home/user/opaque", new TextEncoder().encode("x"), { unstatable: true });
    expect((await readExecutorFile(deps, "workspace", "/home/user/opaque")).error)
      .toContain("unknown size");
    expect(asked).toEqual([]);
  });

  test("a binary file is refused off its BYTES, before any decode", async () => {
    const bin = new Uint8Array(VIEW_CAP * 2);
    bin.set([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d], 0);
    const { deps, asked } = makeCountingPlane("/home/user/blob.dat", bin, { ranged: true });
    expect(await readExecutorFile(deps, "workspace", "/home/user/blob.dat"))
      .toEqual({ error: "binary file — not previewable" });
    expect(asked).toEqual([{ op: "readRange", length: VIEW_CAP }]);
  });

  test("an image is refused by REPRESENTATION, with no read at all", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { deps, asked } = makeCountingPlane("/home/user/shot.PNG", png, { ranged: true });
    const out = await readExecutorFile(deps, "workspace", "/home/user/shot.PNG");
    expect(out.error).toContain("image/png");
    // The registry answered; the plane was never touched for bytes.
    expect(asked).toEqual([]);
  });

  test("a PDF takes the same representation refusal", async () => {
    const { deps, asked } = makeCountingPlane("/home/user/report.pdf", new Uint8Array([0x25, 0x50]));
    expect((await readExecutorFile(deps, "workspace", "/home/user/report.pdf")).error)
      .toContain("application/pdf");
    expect(asked).toEqual([]);
  });

  test("truncation is measured in BYTES, so multi-byte text is not mis-reported", async () => {
    // Exactly the cap in bytes, well under it in characters.
    const text = "é".repeat(VIEW_CAP / 2);
    const bytes = new TextEncoder().encode(text);
    expect(bytes.byteLength).toBe(VIEW_CAP);
    const { deps } = makeCountingPlane("/home/user/accents.txt", bytes, { ranged: true });
    const out = await readExecutorFile(deps, "workspace", "/home/user/accents.txt");
    expect(out.truncated).toBeUndefined();
    expect(out.content).toBe(text);
  });

  test("a directory is refused, and a missing path reports the plane's own failure", async () => {
    const { deps } = makeTree({ "/home/user/src/app.ts": "x" });
    expect((await readExecutorFile(deps, "workspace", "/home/user/src")).error)
      .toBe("path is a directory");
    // A path the plane cannot stat has no proven size, so a plane with no
    // ranged read refuses it rather than reading it to find out.
    expect((await readExecutorFile(deps, "workspace", "/home/user/gone.txt")).error)
      .toContain("unknown size");
  });
});

describe("getExecutorFiles isolates one child's failure", () => {
  /** A plane whose stat refuses exactly one entry — a file that vanished, or one
   *  the plane may not describe. */
  function makePoisonedDir(poisoned: string, code = "ENOENT") {
    const names = ["alpha", "beta.txt", poisoned];
    const files: VFS = {
      readFile: async () => "",
      writeFile: async () => undefined,
      readdir: async () => names,
      stat: async (path) => {
        if (path === `/home/user/${poisoned}`) {
          throw Object.assign(new Error(`${code}: the plane said so`), { code });
        }
        if (path === "/home/user/alpha") return { size: 0, mtimeMs: 0, isDir: true };
        if (path === "/home/user") return { size: 0, mtimeMs: 0, isDir: true };
        return { size: 7, mtimeMs: 42, isDir: false };
      },
      unlink: async () => undefined,
      mkdir: async () => undefined,
      exists: async () => true,
    };
    return { getProvider: () => ({ files, homeDir: async () => "/home/user" }) };
  }

  test("a child that VANISHED is a gap in the listing, not a failure of it", async () => {
    const out = await getExecutorFiles(makePoisonedDir("ghost.txt"), "workspace", "/home/user");
    expect(out.error).toBeUndefined();
    expect(out.entries?.map((e) => e.name).sort())
      .toEqual(["alpha", "beta.txt", "ghost.txt"]);
    // The one that could not be described arrives without metadata rather than
    // wearing invented metadata.
    const ghost = out.entries?.find((e) => e.name === "ghost.txt");
    expect(ghost).toEqual({ name: "ghost.txt", type: "file", size: undefined, mtimeMs: undefined });
    // …and the ones that could keep theirs.
    expect(out.entries?.find((e) => e.name === "beta.txt")).toMatchObject({ size: 7, mtimeMs: 42 });
    expect(out.entries?.find((e) => e.name === "alpha")).toMatchObject({ type: "dir" });
  });

  test("a child the plane REFUSED propagates — an outage is not a sizeless file", async () => {
    // The control for the case above. Absence is an answer; a permission or I/O
    // fault is the plane failing, and reporting it as an entry with no metadata
    // would hide an outage behind a plausible directory.
    for (const code of ["EACCES", "EIO"]) {
      const out = await getExecutorFiles(makePoisonedDir("locked", code), "workspace", "/home/user");
      expect(out.entries).toBeUndefined();
      expect(out.error).toContain(code);
    }
  });

  test("a plane with a stat-inclusive listing is asked once, not once per child", async () => {
    let listings = 0;
    let stats = 0;
    const entries = ["a.txt", "b.txt", "c.txt", "d"];
    const files: VFS & { readdirStats(path: string): Promise<Array<{ name: string; stat: { size: number; mtimeMs: number; isDir: boolean } | null }>> } = {
      readFile: async () => "",
      writeFile: async () => undefined,
      readdir: async () => { listings += 1; return entries; },
      readdirStats: async () => {
        listings += 1;
        return entries.map((name) => ({
          name, stat: { size: name === "d" ? 0 : 3, mtimeMs: 0, isDir: name === "d" },
        }));
      },
      stat: async () => { stats += 1; return { size: 0, mtimeMs: 0, isDir: true }; },
      unlink: async () => undefined,
      mkdir: async () => undefined,
      exists: async () => true,
    };
    const deps = { getProvider: () => ({ files, homeDir: async () => "/home/user" }) };
    const out = await getExecutorFiles(deps, "workspace", "/home/user");
    expect(out.entries?.map((e) => e.name).sort()).toEqual(["a.txt", "b.txt", "c.txt", "d"]);
    expect(listings).toBe(1);
    // No per-child stat at all. The old shape ran one per entry, and on the
    // container plane each of those was itself a full relisting of the parent.
    expect(stats).toBe(0);
  });
});

describe("the tree cache is revalidated, not just keyed by path", () => {
  const dirEntry = (name: string, mtimeMs: number) => ({ name, type: "dir" as const, size: 0, mtimeMs });

  test("a fresh listing installs itself", () => {
    const next = nextTreeCache(new Map(), "/home/user", [dirEntry("src", 1)]);
    expect(next.get("/home/user")?.entries).toEqual([dirEntry("src", 1)]);
  });

  test("a child listed at a NEW revision is dropped with its whole subtree", () => {
    const before = new Map([
      ["/home/user", { entries: [dirEntry("src", 1)], revision: "" }],
      ["/home/user/src", { entries: [dirEntry("deep", 5)], revision: entryRevision(dirEntry("src", 1)) }],
      ["/home/user/src/deep", { entries: [], revision: entryRevision(dirEntry("deep", 5)) }],
    ]);
    // The shell wrote into src, so its mtime moved.
    const next = nextTreeCache(before, "/home/user", [dirEntry("src", 2)]);
    expect(next.has("/home/user/src")).toBe(false);
    expect(next.has("/home/user/src/deep")).toBe(false);
  });

  test("NEGATIVE CONTROL: an unchanged child keeps its cached listing", () => {
    // Without this the invalidation would be indistinguishable from clearing
    // the cache on every listing, which is not a cache.
    const src = dirEntry("src", 1);
    const before = new Map([
      ["/home/user", { entries: [src], revision: "" }],
      ["/home/user/src", { entries: [dirEntry("deep", 5)], revision: entryRevision(src) }],
    ]);
    const next = nextTreeCache(before, "/home/user", [src]);
    expect(next.get("/home/user/src")?.entries).toEqual([dirEntry("deep", 5)]);
  });

  test("a child the fresh listing no longer names is gone", () => {
    const before = new Map([
      ["/home/user", { entries: [dirEntry("old", 1)], revision: "" }],
      ["/home/user/old", { entries: [], revision: entryRevision(dirEntry("old", 1)) }],
    ]);
    const next = nextTreeCache(before, "/home/user", [dirEntry("new", 1)]);
    expect(next.has("/home/user/old")).toBe(false);
  });

  test("an unrelated branch is untouched", () => {
    const before = new Map([
      ["/other", { entries: [dirEntry("keep", 1)], revision: "" }],
    ]);
    const next = nextTreeCache(before, "/home/user", []);
    expect(next.get("/other")?.entries).toEqual([dirEntry("keep", 1)]);
  });

  test("a plane that reports no metadata yields one constant revision, honestly", () => {
    // The container synthesizes stat from a listing and has no mtime, so
    // nothing here can tell fresh from stale — only the explicit Refresh can,
    // and it drops the cache outright.
    expect(entryRevision({})).toBe(":");
    expect(entryRevision({ size: 0, mtimeMs: 0 })).toBe("0:0");
  });
});
