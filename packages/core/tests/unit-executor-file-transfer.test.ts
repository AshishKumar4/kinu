// The chunked file-transfer seam behind the files HTTP route: an actor-side
// upload that assembles ordered chunks and a download buffer that serves
// ranges from one plane read. No single chunk ever approaches the catalogued
// RPC payload ceiling, and nothing here trusts a caller-supplied offset or
// length.
import { describe, expect, test } from "bun:test";
import {
  ExecutorFileDownload, ExecutorFileUpload, FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES,
  statExecutorFile, writeExecutorFileOp, type VFS,
} from "@kinu.run/core";

const MiB = 1024 * 1024;

/** One workspace executor whose file view records what it is given, plus how
 *  many times its bytes were actually read — the number a multi-range
 *  download must hold at one. */
function makePlane(seed: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const reads = { count: 0 };
  const vfs: VFS = {
    readFile: async (path) => {
      reads.count += 1;
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return data;
    },
    writeFile: async (path, data) => {
      files.set(path, data instanceof Uint8Array ? data : new TextEncoder().encode(data));
    },
    readdir: async () => [],
    stat: async (path) => {
      const data = files.get(path);
      return data ? { size: data.byteLength, mtimeMs: 0, isDir: false } : null;
    },
    unlink: async (path) => { files.delete(path); },
    mkdir: async () => undefined,
    exists: async (path) => files.has(path),
  };
  const router = {
    getProvider: (id: string) =>
      id === "workspace" ? { files: vfs, homeDir: async () => "/home/user" } : undefined,
  };
  return { router, files, reads };
}

function patternBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at++) out[at] = at % 251;
  return out;
}

describe("ExecutorFileUpload", () => {
  test("ordered chunks assemble byte-exactly, including a partial tail", async () => {
    const plane = makePlane();
    const upload = new ExecutorFileUpload(plane.router, "workspace", "/home/user/big.bin");
    const whole = patternBytes(2 * FILE_CHUNK_BYTES + 7);
    for (let at = 0; at < whole.byteLength; at += FILE_CHUNK_BYTES) {
      const slice = whole.subarray(at, Math.min(at + FILE_CHUNK_BYTES, whole.byteLength));
      const last = at + slice.byteLength >= whole.byteLength;
      expect(await upload.chunk(at, slice, last)).toEqual({ ok: true });
    }
    expect(upload.done).toBe(true);
    expect([...plane.files.get("/home/user/big.bin")!]).toEqual([...whole]);
  });

  test("an out-of-order chunk is refused with the expected offset, and the stream recovers", async () => {
    const plane = makePlane();
    const upload = new ExecutorFileUpload(plane.router, "workspace", "/f.bin");
    await upload.chunk(0, patternBytes(FILE_CHUNK_BYTES), false);
    const skipped = await upload.chunk(FILE_CHUNK_BYTES + 1, patternBytes(4), false);
    expect(skipped).toMatchObject({ error: expect.stringContaining("expected offset") });
    // The honest continuation still lands: the refusal did not poison state.
    expect(await upload.chunk(FILE_CHUNK_BYTES, patternBytes(4), true)).toEqual({ ok: true });
  });

  test("a chunk larger than FILE_CHUNK_BYTES is refused", async () => {
    const upload = new ExecutorFileUpload(makePlane().router, "workspace", "/f.bin");
    expect(await upload.chunk(0, patternBytes(FILE_CHUNK_BYTES + 1), false))
      .toMatchObject({ error: expect.stringContaining("chunk exceeds") });
  });

  test("a transfer past the total limit refuses, settles, and writes nothing", async () => {
    const plane = makePlane();
    const upload = new ExecutorFileUpload(plane.router, "workspace", "/f.bin");
    const chunk = patternBytes(FILE_CHUNK_BYTES);
    for (let at = 0; at < FILE_TRANSFER_MAX_BYTES; at += FILE_CHUNK_BYTES) {
      expect(await upload.chunk(at, chunk, false)).toEqual({ ok: true });
    }
    // The limit is already reached; one more byte is one byte too many.
    const refused = await upload.chunk(FILE_TRANSFER_MAX_BYTES, patternBytes(1), false);
    expect(refused).toMatchObject({ error: expect.stringContaining("transfer limit") });
    expect(upload.done).toBe(true);
    expect(plane.files.has("/f.bin")).toBe(false);
  });

  test("abort discards buffered parts; feeding a settled transfer fails loudly", async () => {
    const plane = makePlane();
    const upload = new ExecutorFileUpload(plane.router, "workspace", "/f.bin");
    await upload.chunk(0, patternBytes(1024), false);
    upload.abort();
    expect(upload.done).toBe(true);
    expect(await upload.chunk(1024, patternBytes(4), true))
      .toMatchObject({ error: expect.stringContaining("settled") });
    expect(plane.files.has("/f.bin")).toBe(false);
  });

  test("writeExecutorFileOp round-trips what finalize assembled (the plane contract)", async () => {
    const plane = makePlane();
    const bytes = patternBytes(2 * MiB);
    expect(await writeExecutorFileOp(plane.router, "workspace", "/g.bin", bytes)).toEqual({ ok: true });
    expect(await statExecutorFile(plane.router, "workspace", "/g.bin")).toEqual({ size: bytes.byteLength });
  });
});

describe("ExecutorFileDownload", () => {
  test("size answers before any read; ranges cut from ONE plane read", async () => {
    const whole = patternBytes(2 * FILE_CHUNK_BYTES + 13);
    const plane = makePlane({ "/big.bin": whole });
    const download = new ExecutorFileDownload(plane.router, "workspace", "/big.bin");

    expect(await download.size()).toEqual({ size: whole.byteLength });
    expect(plane.reads.count).toBe(0);

    let received = 0;
    while (received < whole.byteLength) {
      const length = Math.min(FILE_CHUNK_BYTES, whole.byteLength - received);
      const out = await download.range(received, length);
      if (!("bytes" in out)) throw new Error(out.error);
      expect(out.bytes.byteLength).toBe(length);
      expect(out.bytes.slice(0, 16)).toEqual(whole.slice(received, received + 16));
      received += out.bytes.byteLength;
    }
    expect(received).toBe(whole.byteLength);
    // Three-plus ranges, one read: the cache is doing the work.
    expect(plane.reads.count).toBe(1);
  });

  test("a file that grows after stat is refused before it is cached", async () => {
    const plane = makePlane({ "/growing.bin": new Uint8Array([1]) });
    const download = new ExecutorFileDownload(plane.router, "workspace", "/growing.bin");
    expect(await download.size()).toEqual({ size: 1 });
    plane.files.set("/growing.bin", new Uint8Array(FILE_TRANSFER_MAX_BYTES + 1));

    expect(await download.range(0, 1))
      .toMatchObject({ reason: 'too_large', error: expect.stringContaining("transfer limit") });
    expect(download.serves("workspace", "/growing.bin")).toBe(false);
    expect(plane.reads.count).toBe(1);
  });

  test("a different file re-reads rather than serving stale bytes", async () => {
    const plane = makePlane({
      "/a.bin": patternBytes(64),
      "/b.bin": patternBytes(32),
    });
    const download = new ExecutorFileDownload(plane.router, "workspace", "/a.bin");
    await download.range(0, 16);
    expect(download.serves("workspace", "/a.bin")).toBe(true);
    expect(download.serves("workspace", "/b.bin")).toBe(false);
    const fresh = new ExecutorFileDownload(plane.router, "workspace", "/b.bin");
    const out = await fresh.range(0, 32);
    if (!("bytes" in out)) throw new Error(out.error);
    expect(out.bytes.byteLength).toBe(32);
  });

  test("bad ranges are named errors, not throws", async () => {
    const plane = makePlane({ "/f.bin": patternBytes(100) });
    const download = new ExecutorFileDownload(plane.router, "workspace", "/f.bin");
    expect(await download.range(-1, 10)).toMatchObject({ error: expect.stringContaining("negative") });
    expect(await download.range(0, 0)).toMatchObject({ error: expect.stringContaining("positive") });
    expect(await download.range(100, 10)).toMatchObject({ error: expect.stringContaining("past end") });
    expect(await download.range(50, 1000)).toMatchObject({ bytes: expect.any(Uint8Array) }); // clamped to EOF
  });

  test("an unreadable file and a plane-less executor come back as errors", async () => {
    const plane = makePlane();
    expect(await new ExecutorFileDownload(plane.router, "workspace", "/missing.bin").range(0, 10))
      .toMatchObject({ error: expect.stringContaining("ENOENT") });
    expect(await new ExecutorFileDownload(plane.router, "ghost", "/f.bin").size())
      .toMatchObject({ error: expect.stringContaining("no file plane") });
  });
});

describe("ExecutorFileDownload snapshot binding", () => {
  test("open returns the size of the same bytes served by every range", async () => {
    const plane = makePlane({ "/snapshot.bin": new TextEncoder().encode("first") });
    const download = new ExecutorFileDownload(plane.router, "workspace", "/snapshot.bin");
    expect(await download.open()).toEqual({ size: 5 });
    plane.files.set("/snapshot.bin", new TextEncoder().encode("second"));

    expect(await download.range(0, FILE_CHUNK_BYTES))
      .toEqual({ bytes: new TextEncoder().encode("first") });
    expect(plane.reads.count).toBe(1);
  });
});
