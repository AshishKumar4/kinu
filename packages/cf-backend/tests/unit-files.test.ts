import { afterEach, describe, test, expect } from "bun:test";
import {
  deleteExecutorPathOp, getExecutorFiles, inlineFileType, readExecutorFile, readExecutorFileBytes,
  renameExecutorPathOp, sortDirEntries, writeExecutorFileOp, type VFS,
} from "@kinu.run/core";
import { asFetchFunction } from "@kinu.run/core";
import { fileResponseHeaders } from "@kinu.run/core";
import {
  entryRevision, fileTextEditable, nextTreeCache, putFileBytes, sandboxedHtml,
  textRenderOf, viewerKindOf,
} from "@kinu.run/core";
import { requestUrl } from '@kinu.run/core';

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
  /** Captures what its file view is given; optionally throws, like an offline environment. */
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

    const deps = { getProvider: () => ({ files, homeDir: async () => "/home/main" }) };

    return { deps, written };
  }

  test("workspace upload round-trips binary content through the VFS", async () => {
    const { deps, written } = makeDeps();
    const bytes = new Uint8Array([0, 1, 2, 255, 0, 128]);
    const result = await writeExecutorFileOp(deps, "workspace", "/uploads/blob.bin", { bytes: bytes });
    expect(result).toEqual({ ok: true });
    expect(written.get("/uploads/blob.bin")).toEqual(bytes);
  });

  test("executor uploads land BINARY-SAFE through the executor's own file view", async () => {
    const { deps, written } = makeDeps();
    const bin = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0xfe]);
    // Each environment gets the path in its own namespace: nothing prefixed or stripped.
    expect(await writeExecutorFileOp(deps, "sandbox", "/workspace/logo.png", { bytes: bin })).toEqual({ ok: true });
    expect(written.get("/workspace/logo.png")).toEqual(bin);

    expect(await writeExecutorFileOp(deps, "nimbus", "/home/main/a.bin", { bytes: bin })).toEqual({ ok: true });
    expect(written.get("/home/main/a.bin")).toEqual(bin);

    expect(await writeExecutorFileOp(deps, "device", "/home/me/proj/b.bin", { bytes: bin })).toEqual({ ok: true });
    expect(written.get("/home/me/proj/b.bin")).toEqual(bin);
  });

  test("an unavailable environment surfaces its own honest reason", async () => {
    const { deps } = makeDeps({
      throwOn: /^\/workspace\//,
      error: "the sandbox container is not running",
    });

    const result = await writeExecutorFileOp(deps, "sandbox", "/workspace/x", { bytes: new TextEncoder().encode("y") });
    expect(result).toMatchObject({ error: expect.stringContaining("not running") });
  });

  test("an environment with no file plane → typed error, not a throw", async () => {
    const result = await writeExecutorFileOp(
      { getProvider: () => undefined }, "ghost", "/a", { bytes: new TextEncoder().encode("x") },
    );

    expect(result).toEqual({ error: 'Executor "ghost" has no file plane' });
  });

  test("rejects a missing path and a directory path", async () => {
    const one = new Uint8Array([1]);
    const { deps, written } = makeDeps();
    expect(await writeExecutorFileOp(deps, "workspace", "", { bytes: one })).toEqual({ error: "file path required" });
    expect(await writeExecutorFileOp(deps, "workspace", "/uploads/", { bytes: one })).toEqual({ error: "file path required" });
    expect(written.size).toBe(0);
  });

  test("a file past the old 2 MB cap is written, not refused", async () => {
    // Uploads are HTTP with raw bytes and the VFS chunks storage, so no app-level size cap applies.
    const { deps, written } = makeDeps();
    const big = new Uint8Array(3 * 1024 * 1024);
    expect(await writeExecutorFileOp(deps, "workspace", "/uploads/big.bin", { bytes: big })).toEqual({ ok: true });
    const stored = written.get("/uploads/big.bin");

    if (!(stored instanceof Uint8Array)) throw new Error("binary upload was not stored as bytes");
    expect(stored.length).toBe(big.length);
  });
});

/** `unlinkFails` makes removal of matching paths fail, catching a half-done rename carry. */
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
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]);
      }

      return [...names];
    },
    stat: async (path) => {
      const stored = files.get(path);

      if (stored !== undefined) return { size: stored.length, mtimeMs: 1_724_500_000_000, isDir: false };

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

  const deps = { getProvider: () => ({ files: { ...vfs, ...native }, homeDir: async () => "/home/main" }) };

  return { deps, files, dirs, renames, removed };
}

describe("renameExecutorPathOp", () => {
  test("uses the plane's native rename where it declares one", async () => {
    const { deps, renames } = makeTree({ "/home/main/a.txt": "x" }, { native: true });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/main/a.txt", "/home/main/b.txt");
    expect(out).toEqual({ ok: true });
    expect(renames).toEqual([["/home/main/a.txt", "/home/main/b.txt"]]);
  });

  test("carries a file's bytes on a plane with no native rename", async () => {
    const { deps, files } = makeTree({ "/home/main/a.txt": "carried" });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/main/a.txt", "/home/main/b.txt");
    expect(out).toEqual({ ok: true });
    expect(files.get("/home/main/b.txt")).toBe("carried");
    expect(files.has("/home/main/a.txt")).toBe(false);
  });

  test("refuses a directory where only bytes could carry it", async () => {
    const { deps, files } = makeTree({ "/home/main/src/app.ts": "export {};" });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/main/src", "/home/main/moved");
    expect("error" in out && out.error).toContain("directory");
    expect(files.has("/home/main/src/app.ts")).toBe(true);
  });

  test("never overwrites: an existing target is a stated refusal", async () => {
    const { deps, files } = makeTree({ "/home/main/a.txt": "keep me", "/home/main/b.txt": "target" }, { native: true });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/main/a.txt", "/home/main/b.txt");
    expect("error" in out && out.error).toContain("already exists");
    expect(files.get("/home/main/b.txt")).toBe("target");
  });

  test("a missing source is a typed error, not a throw", async () => {
    const { deps } = makeTree({});
    const out = await renameExecutorPathOp(deps, "workspace", "/home/main/gone.txt", "/home/main/b.txt");
    expect("error" in out).toBe(true);
  });

  test("a carry that cannot destroy the source leaves ONE name, not two", async () => {
    // KINU-013: a rename either happened or did not; a failed unlink removes the carry's copy.
    const { deps, files } = makeTree({ "/home/main/a.txt": "carried" }, { unlinkFails: /a\.txt$/ });
    const out = await renameExecutorPathOp(deps, "workspace", "/home/main/a.txt", "/home/main/b.txt");
    expect("error" in out).toBe(true);
    expect(files.get("/home/main/a.txt")).toBe("carried");
    expect(files.has("/home/main/b.txt")).toBe(false);
  });
});

describe("deleteExecutorPathOp", () => {
  test("a file is one unlink", async () => {
    const { deps, files } = makeTree({ "/home/main/a.txt": "x" });
    const out = await deleteExecutorPathOp(deps, "workspace", "/home/main/a.txt");
    expect(out).toEqual({ ok: true });
    expect(files.has("/home/main/a.txt")).toBe(false);
  });

  test("a directory uses the native tree removal where one exists", async () => {
    const { deps, removed } = makeTree({ "/home/main/build/out.js": "x" }, { native: true });
    const out = await deleteExecutorPathOp(deps, "workspace", "/home/main/build");
    expect(out).toEqual({ ok: true });
    expect(removed).toEqual(["/home/main/build"]);
  });

  test("a directory on a plane without native removal goes entry by entry", async () => {
    const { deps, files, dirs } = makeTree({
      "/home/main/build/out.js": "x",
      "/home/main/build/deep/two.js": "y",
    });

    const out = await deleteExecutorPathOp(deps, "workspace", "/home/main/build");
    expect(out).toEqual({ ok: true });
    expect(files.size).toBe(0);
    expect(dirs.has("/home/main/build")).toBe(false);
  });

  test("a tree removal that fails mid-tree reports what was removed and what remains", async () => {
    // KINU-013: removal fails closed and the refusal carries both entry sets.
    const { deps, files, dirs } = makeTree({
      "/home/main/build/out.js": "x",
      "/home/main/build/deep/two.js": "y",
    }, { unlinkFails: /deep$/ });

    const out = await deleteExecutorPathOp(deps, "workspace", "/home/main/build");

    expect("ok" in out).toBe(false);
    expect("error" in out && out.error).toContain("/home/main/build/deep");
    expect("error" in out && out.error).toContain("still present");
    expect(out).toMatchObject({
      removed: ["/home/main/build/deep/two.js"],
      remaining: ["/home/main/build/deep", "/home/main/build/out.js", "/home/main/build"],
    });
    expect(files.has("/home/main/build/deep/two.js")).toBe(false);
    expect(dirs.has("/home/main/build/deep")).toBe(true);
    expect(files.has("/home/main/build/out.js")).toBe(true);
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
    await writeExecutorFileOp(deps, "workspace", "/home/main/blob.bin", { bytes: bytes });
    const out = await readExecutorFileBytes(deps, "workspace", "/home/main/blob.bin");

    if ("error" in out) throw new Error(out.error);
    expect([...out.bytes]).toEqual([...bytes]);
  });

  test("a string-answering plane still yields bytes", async () => {
    const { deps } = makeTree({ "/home/main/notes.md": "text" });
    const out = await readExecutorFileBytes(deps, "workspace", "/home/main/notes.md");

    if ("error" in out) throw new Error(out.error);
    expect(new TextDecoder().decode(out.bytes)).toBe("text");
  });

  test("a directory refuses instead of answering garbage", async () => {
    const { deps } = makeTree({ "/home/main/src/app.ts": "x" });
    expect("error" in await readExecutorFileBytes(deps, "workspace", "/home/main/src")).toBe(true);
  });
});

describe("getExecutorFiles", () => {
  test("entries carry the stat they were typed from: kind, size and mtime", async () => {
    const { deps } = makeTree({ "/home/main/notes.md": "12345" });
    const out = await getExecutorFiles(deps, "workspace", "/home/main");
    expect(out.path).toBe("/home/main");
    expect(out.entries).toEqual([
      { name: "notes.md", type: "file", size: 5, mtimeMs: 1_724_500_000_000 },
    ]);
  });

  test("every ancestor of the canonical home names the next segment down, even where the box lists nothing", async () => {
    // A fresh workspace's physical root has no entries, so '/' must still list the tree.
    const { deps } = makeTree({});
    const root = await getExecutorFiles(deps, "workspace", "/");
    expect(root.entries).toEqual([{ name: "home", type: "dir" }]);
    const mid = await getExecutorFiles(deps, "workspace", "/home");
    expect(mid.entries).toEqual([{ name: "main", type: "dir" }]);
    const seeded = await getExecutorFiles(deps, "workspace", "/home/main");
    expect(seeded.entries).toEqual([]);
  });
});

describe("inlineFileType", () => {
  test("the Files surface and HTTP route share image and PDF classification", () => {
    expect(inlineFileType("/home/main/shot.PNG")).toBe("image/png");
    expect(inlineFileType("/home/main/report.pdf")).toBe("application/pdf");
    expect(inlineFileType("/home/main/readme.txt")).toBeUndefined();
  });
});

describe("fileResponseHeaders — the download route's security posture", () => {
  test("an image previews inline, nosniffed, under a sandbox CSP", () => {
    const h = fileResponseHeaders("/home/main/shot.PNG", false);
    expect(h.get("content-type")).toBe("image/png");
    expect(h.get("content-disposition")).toContain("inline");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("content-security-policy")).toBe("sandbox");
  });

  test("a PDF previews inline in the platform viewer without the sandbox CSP", () => {
    const h = fileResponseHeaders("/home/main/report.pdf", false);
    expect(h.get("content-type")).toBe("application/pdf");
    expect(h.get("content-disposition")).toContain("inline");
    expect(h.get("content-security-policy")).toBeNull();
  });

  test("anything else downloads as opaque bytes — html never renders on this origin", () => {
    const h = fileResponseHeaders("/home/main/index.html", false);
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("content-disposition")).toContain("attachment");
  });

  test("download=1 forces attachment even for an image, and the filename is carried encoded", () => {
    const h = fileResponseHeaders("/home/main/résumé shot.png", true);
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("content-disposition")).toContain("attachment");
    expect(h.get("content-disposition")).toContain(encodeURIComponent("résumé shot.png"));
  });
});

describe("CLOUD_MAX_INLINE_ATTACHMENT_BYTES", () => {
  test("a max-size attachment message fits the agents SDK row guard, under the platform row cap", async () => {
    const { CLOUD_MAX_INLINE_ATTACHMENT_BYTES, PLATFORM_CATALOG } = await import("@kinu.run/core");
    const { ROW_MAX_BYTES } = await import("agents/chat");
    // A chat message is one DO SQLite row and the SDK cannot shrink file parts (base64, 4/3 × raw).
    // The limit is read from catalog `do.sqlite.row_bytes`, making that entry load-bearing.
    const platformRowBytes = PLATFORM_CATALOG["do.sqlite.row_bytes"].limit.value;
    const encoded = Math.ceil((CLOUD_MAX_INLINE_ATTACHMENT_BYTES * 4) / 3);
    const slack = 256 * 1024;
    expect(encoded + slack).toBeLessThan(ROW_MAX_BYTES);
    expect(ROW_MAX_BYTES).toBeLessThan(platformRowBytes);
  });
});

/**
 * The uploader and viewer save share one PUT; the route's refusal words are the
 * message wherever it has any (a 413 names the limit, not "upload failed (413)").
 */
describe("putFileBytes", () => {
  const { fetch: realFetch } = globalThis;
  afterEach(() => { globalThis.fetch = realFetch; });

  function answering(reply: Response) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    // `asFetchFunction` satisfies `typeof globalThis.fetch`: Bun-types' shape carries a
    // `preconnect` member a bare function literal lacks.
    globalThis.fetch = asFetchFunction((url, init) => {
      calls.push({ url: requestUrl(url), init });

      return Promise.resolve(reply);
    });

    return calls;
  }

  test("a written file is a resolved promise and nothing else", async () => {
    const calls = answering(Response.json({ ok: true }));
    await putFileBytes("/api/workspaces/ws/files?executor=workspace&path=/a.txt", "hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("PUT");
    expect(calls[0].init?.body).toBe("hello");
  });

  test("the route's own 413 words reach the reader", async () => {
    answering(Response.json({ error: "file exceeds the 25 MiB transfer limit" }, { status: 413 }));
    await expect(putFileBytes("/files", new Blob(["x"])))
      .rejects.toThrow("file exceeds the 25 MiB transfer limit");
  });

  const refusals = [
    {
      name: "a refusal with no readable body still names the status",
      body: "", status: 502, thrown: "502",
    },
    {
      name: "a non-JSON refusal body is shown as it arrived",
      body: "  gateway said no  ", status: 500, thrown: "gateway said no",
    },
  ] as const;

  for (const { name, body, status, thrown } of refusals) {
    test(name, async () => {
      answering(new Response(body, { status }));
      await expect(putFileBytes("/files", "x")).rejects.toThrow(thrown);
    });
  }
});

/**
 * The viewer's pane dispatch; its registry is `inlineFileType`, the same one the
 * download route's headers use, so "shown inline" and "sent inline" cannot drift.
 */
describe("the file viewer's dispatch", () => {
  const viewerKinds = [
    {
      name: "an image type opens in the image pane, whatever its extension case",
      kind: "image",
      paths: ["/home/main/shot.png", "/home/main/SHOT.PNG", "/home/main/diagram.svg"],
    },
    {
      name: "a PDF opens in the PDF pane",
      kind: "pdf",
      paths: ["/home/main/paper.pdf"],
    },
    {
      name: "everything else is read as text — including a file with no extension",
      kind: "text",
      paths: ["/home/main/notes.md", "/home/main/Makefile", "/home/main/archive.tar.gz"],
    },
  ] as const;

  for (const { name, kind, paths } of viewerKinds) {
    test(name, () => {
      for (const path of paths) expect(viewerKindOf(path)).toBe(kind);
    });
  }

  test("Markdown and HTML open rendered; every other text file opens as source", () => {
    expect(textRenderOf("/a/README.md")).toBe("markdown");
    expect(textRenderOf("/a/NOTES.MARKDOWN")).toBe("markdown");
    expect(textRenderOf("/a/page.html")).toBe("html");
    expect(textRenderOf("/a/page.HTM")).toBe("html");
    expect(textRenderOf("/a/main.ts")).toBe("source");
  });

  test("the render is decided by the file's own name, not by a directory above it", () => {
    expect(textRenderOf("/docs.md/notes.txt")).toBe("source");
  });

  test("a clipped read cannot be edited: saving the buffer back would truncate the file", () => {
    expect(fileTextEditable({ content: "first half", truncated: true })).toBe(false);
  });

  test("a failed read cannot be edited, and neither can a read that has not arrived", () => {
    expect(fileTextEditable({ error: "ENOENT" })).toBe(false);
    expect(fileTextEditable(null)).toBe(false);
    // Any error field, even a blank reason, is a failed read: never write this buffer back.
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
    expect(framed).toContain("style-src 'unsafe-inline'");
    expect(framed).toContain("img-src data: blob:");
    // The markup is untouched; the iframe's empty sandbox neutralises it.
    expect(framed.endsWith("<script>fetch('https://x.example')</script><p>hi</p>")).toBe(true);
  });
});

/** `readRange` is declared only when `ranged` is set; `readFile` returns a whole copy. */
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

  return { deps: { getProvider: () => ({ files, homeDir: async () => "/home/main" }) }, asked };
}

const VIEW_CAP = 512 * 1024;

describe("readExecutorFile bounds the preview before it reads", () => {
  test("a text file under the cap carries its unsupported edit reason", async () => {
    const bytes = new TextEncoder().encode("# notes\nline two\n");
    const { deps } = makeCountingPlane("/home/main/notes.md", bytes);
    const result = await readExecutorFile(deps, "workspace", "/home/main/notes.md");
    expect(result).toMatchObject({
      content: "# notes\nline two\n",
      readOnlyReason: expect.stringContaining("cannot protect an in-place edit"),
    });
  });

  test("a plane with a ranged read is asked for the cap, never the file", async () => {
    const big = new Uint8Array(VIEW_CAP * 4).fill(0x61);
    const { deps, asked } = makeCountingPlane("/home/main/huge.log", big, { ranged: true });
    const out = await readExecutorFile(deps, "workspace", "/home/main/huge.log");
    expect(out.truncated).toBe(true);
    expect(out.content?.length).toBe(VIEW_CAP);
    expect(asked).toEqual([{ op: "readRange", length: VIEW_CAP }]);
  });

  test("a plane WITHOUT one refuses an over-budget preview instead of fetching it", async () => {
    const big = new Uint8Array(VIEW_CAP * 4).fill(0x61);
    const { deps, asked } = makeCountingPlane("/home/main/huge.log", big);
    const out = await readExecutorFile(deps, "workspace", "/home/main/huge.log");
    // Negative control: a plane with no prefix read refuses before any byte moves.
    expect(out.content).toBeUndefined();
    expect(out.error).toContain("no ranged read");
    expect(out.error).toContain("download");
    expect(asked).toEqual([]);
  });

  test("a plane WITHOUT one still previews a file its stat proved fits, read-only", async () => {
    const small = new TextEncoder().encode("small enough\n");
    const { deps, asked } = makeCountingPlane("/home/main/small.txt", small);
    const result = await readExecutorFile(deps, "workspace", "/home/main/small.txt");
    expect(result).toMatchObject({
      content: "small enough\n",
      readOnlyReason: expect.stringContaining("cannot protect an in-place edit"),
    });
    expect(asked).toEqual([{ op: "readFile" }]);
  });

  test("an unstatable file on a plane with no ranged read is refused, never guessed", async () => {
    const { deps, asked } = makeCountingPlane("/home/main/opaque", new TextEncoder().encode("x"), { unstatable: true });
    expect((await readExecutorFile(deps, "workspace", "/home/main/opaque")).error)
      .toContain("unknown size");
    expect(asked).toEqual([]);
  });

  test("a binary file is refused off its BYTES, before any decode", async () => {
    const bin = new Uint8Array(VIEW_CAP * 2);
    bin.set([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d], 0);
    const { deps, asked } = makeCountingPlane("/home/main/blob.dat", bin, { ranged: true });
    expect(await readExecutorFile(deps, "workspace", "/home/main/blob.dat"))
      .toEqual({ error: "binary file — not previewable" });
    expect(asked).toEqual([{ op: "readRange", length: VIEW_CAP }]);
  });

  test("an image is refused by REPRESENTATION, with no read at all", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { deps, asked } = makeCountingPlane("/home/main/shot.PNG", png, { ranged: true });
    const out = await readExecutorFile(deps, "workspace", "/home/main/shot.PNG");
    expect(out.error).toContain("image/png");
    expect(asked).toEqual([]);
  });

  test("a PDF takes the same representation refusal", async () => {
    const { deps, asked } = makeCountingPlane("/home/main/report.pdf", new Uint8Array([0x25, 0x50]));
    expect((await readExecutorFile(deps, "workspace", "/home/main/report.pdf")).error)
      .toContain("application/pdf");
    expect(asked).toEqual([]);
  });

  test("truncation is measured in BYTES, so multi-byte text is not mis-reported", async () => {
    const text = "é".repeat(VIEW_CAP / 2);
    const bytes = new TextEncoder().encode(text);
    expect(bytes.byteLength).toBe(VIEW_CAP);
    const { deps } = makeCountingPlane("/home/main/accents.txt", bytes, { ranged: true });
    const out = await readExecutorFile(deps, "workspace", "/home/main/accents.txt");
    expect(out.truncated).toBeUndefined();
    expect(out.content).toBe(text);
  });

  test("a directory is refused, and a missing path reports the plane's own failure", async () => {
    const { deps } = makeTree({ "/home/main/src/app.ts": "x" });
    expect((await readExecutorFile(deps, "workspace", "/home/main/src")).error)
      .toBe("path is a directory");
    // No proven size: a plane with no ranged read refuses rather than reading to find out.
    expect((await readExecutorFile(deps, "workspace", "/home/main/gone.txt")).error)
      .toContain("unknown size");
  });
});

describe("getExecutorFiles isolates one child's failure", () => {
  function makePoisonedDir(poisoned: string, code = "ENOENT") {
    const names = ["alpha", "beta.txt", poisoned];

    const files: VFS = {
      readFile: async () => "",
      writeFile: async () => undefined,
      readdir: async () => names,
      stat: async (path) => {
        if (path === `/home/main/${poisoned}`) {
          throw Object.assign(new Error(`${code}: the plane said so`), { code });
        }

        if (path === "/home/main/alpha") return { size: 0, mtimeMs: 0, isDir: true };

        if (path === "/home/main") return { size: 0, mtimeMs: 0, isDir: true };

        return { size: 7, mtimeMs: 42, isDir: false };
      },
      unlink: async () => undefined,
      mkdir: async () => undefined,
      exists: async () => true,
    };

    return { getProvider: () => ({ files, homeDir: async () => "/home/main" }) };
  }

  test("a child that VANISHED is a gap in the listing, not a failure of it", async () => {
    const out = await getExecutorFiles(makePoisonedDir("ghost.txt"), "workspace", "/home/main");
    expect(out.error).toBeUndefined();
    expect(out.entries?.map((e) => e.name).sort())
      .toEqual(["alpha", "beta.txt", "ghost.txt"]);
    // The undescribable entry arrives without metadata rather than invented metadata.
    const ghost = out.entries?.find((e) => e.name === "ghost.txt");
    expect(ghost).toEqual({ name: "ghost.txt", type: "file", size: undefined, mtimeMs: undefined });
    expect(out.entries?.find((e) => e.name === "beta.txt")).toMatchObject({ size: 7, mtimeMs: 42 });
    expect(out.entries?.find((e) => e.name === "alpha")).toMatchObject({ type: "dir" });
  });

  test("a child the plane REFUSED propagates — an outage is not a sizeless file", async () => {
    // A permission or I/O fault is an outage, not an entry with no metadata.
    for (const code of ["EACCES", "EIO"]) {
      const out = await getExecutorFiles(makePoisonedDir("locked", code), "workspace", "/home/main");
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
      readdir: async () => {
        listings += 1;

        return entries;
      },
      readdirStats: async () => {
        listings += 1;

        return entries.map((name) => ({
          name, stat: { size: name === "d" ? 0 : 3, mtimeMs: 0, isDir: name === "d" },
        }));
      },
      stat: async () => {
        stats += 1;

        return { size: 0, mtimeMs: 0, isDir: true };
      },
      unlink: async () => undefined,
      mkdir: async () => undefined,
      exists: async () => true,
    };

    const deps = { getProvider: () => ({ files, homeDir: async () => "/home/main" }) };
    const out = await getExecutorFiles(deps, "workspace", "/home/main");
    expect(out.entries?.map((e) => e.name).sort()).toEqual(["a.txt", "b.txt", "c.txt", "d"]);
    expect(listings).toBe(1);
    // No per-child stat: on the container plane each one costs a full relisting of the parent.
    expect(stats).toBe(0);
  });
});

describe("the tree cache is revalidated, not just keyed by path", () => {
  const dirEntry = (name: string, mtimeMs: number) => ({ name, type: "dir" as const, size: 0, mtimeMs });

  test("a fresh listing installs itself", () => {
    const next = nextTreeCache(new Map(), "/home/main", [dirEntry("src", 1)]);
    expect(next.get("/home/main")?.entries).toEqual([dirEntry("src", 1)]);
  });

  test("a child listed at a NEW revision is dropped with its whole subtree", () => {
    const before = new Map([
      ["/home/main", { entries: [dirEntry("src", 1)], revision: "" }],
      ["/home/main/src", { entries: [dirEntry("deep", 5)], revision: entryRevision(dirEntry("src", 1)) }],
      ["/home/main/src/deep", { entries: [], revision: entryRevision(dirEntry("deep", 5)) }],
    ]);

    const next = nextTreeCache(before, "/home/main", [dirEntry("src", 2)]);
    expect(next.has("/home/main/src")).toBe(false);
    expect(next.has("/home/main/src/deep")).toBe(false);
  });

  test("NEGATIVE CONTROL: an unchanged child keeps its cached listing", () => {
    const src = dirEntry("src", 1);

    const before = new Map([
      ["/home/main", { entries: [src], revision: "" }],
      ["/home/main/src", { entries: [dirEntry("deep", 5)], revision: entryRevision(src) }],
    ]);

    const next = nextTreeCache(before, "/home/main", [src]);
    expect(next.get("/home/main/src")?.entries).toEqual([dirEntry("deep", 5)]);
  });

  test("a child the fresh listing no longer names is gone", () => {
    const before = new Map([
      ["/home/main", { entries: [dirEntry("old", 1)], revision: "" }],
      ["/home/main/old", { entries: [], revision: entryRevision(dirEntry("old", 1)) }],
    ]);

    const next = nextTreeCache(before, "/home/main", [dirEntry("new", 1)]);
    expect(next.has("/home/main/old")).toBe(false);
  });

  test("an unrelated branch is untouched", () => {
    const before = new Map([
      ["/other", { entries: [dirEntry("keep", 1)], revision: "" }],
    ]);

    const next = nextTreeCache(before, "/home/main", []);
    expect(next.get("/other")?.entries).toEqual([dirEntry("keep", 1)]);
  });

  test("a plane that reports no metadata yields one constant revision, honestly", () => {
    // The container has no mtime, so only the explicit Refresh (which drops the cache) can tell stale.
    expect(entryRevision({})).toBe(":");
    expect(entryRevision({ size: 0, mtimeMs: 0 })).toBe("0:0");
  });
});
