// The files HTTP route's transfer contract: byte-exact chunked upload and
// download across the Worker↔actor boundary, the total-size 413 answered
// before any large allocation, counted (not announced) request bytes, and a
// streamed response body.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import type { FilesRouteAgent } from "../src/files-routes"; // type-only: erased, never loaded
import type {
  ExecutorFileDownload as ExecutorFileDownloadInstance,
  ExecutorFileUpload as ExecutorFileUploadInstance,
} from "@kinu.run/core";
// The route module statically imports the agents SDK, whose dist imports
// workerd-only `cloudflare:*` modules that crash bun's loader on evaluation.
// The shared harness stubs them, so — per its own contract ("call it before
// importing the module under test") — the import below is deliberately
// dynamic. Same shape as unit-actor-facet-substrate.test.ts.
import { mockAgentsSdk } from "./helpers/agents-sdk";

mockAgentsSdk();
const { handleFilesRequest } = await import("../src/files-routes");
const {
  ExecutorFileDownload, ExecutorFileUpload, FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES,
} = await import("@kinu.run/core");

const URL_ = "https://kinu.test/api/workspaces/ws/files?executor=workspace&path=/home/user/blob.bin";
const ErrorReplySchema = v.object({ error: v.string() });
const OkReplySchema = v.object({ ok: v.literal(true) });

/** What a route test drives: the fake actor plus the recorders its assertions
 *  read. */
interface Harness {
  agent: FilesRouteAgent;
  seed(path: string, bytes: Uint8Array): Promise<void>;
  files: Map<string, Uint8Array>;
  reads: { count: number };
  aborted: string[];
}

/** A fake actor wired exactly like OrchestratorAgent's own chunk methods —
 *  the same core seam classes over a recording VFS — so the route is driven
 *  end to end without instantiating the DO. */
function makeAgent(): Harness {
  const files = new Map<string, Uint8Array>();
  const reads = { count: 0 };
  const aborted: string[] = [];
  const uploads = new Map<string, {
    readonly path: string;
    readonly upload: ExecutorFileUploadInstance;
  }>();
  const downloads = new Map<string, ExecutorFileDownloadInstance>();
  const vfs = {
    readFile: async (path: string) => {
      reads.count += 1;
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return data;
    },
    writeFile: async (path: string, data: Uint8Array | string) => {
      files.set(path, data instanceof Uint8Array ? data : new TextEncoder().encode(data));
    },
    readdir: async (): Promise<string[]> => [],
    stat: async (path: string) => {
      const data = files.get(path);
      return data ? { size: data.byteLength, mtimeMs: 0, isDir: false } : null;
    },
    unlink: async (path: string) => { files.delete(path); },
    mkdir: async () => undefined,
    exists: async (path: string) => files.has(path),
  };
  const router = {
    getProvider: (id: string) =>
      id === "workspace" ? { files: vfs, homeDir: async () => "/home/user" } : undefined,
  };
  return {
    agent: {
      startExecutorFileDownload: async (executorId, path, transferId) => {
        const download = new ExecutorFileDownload(router, executorId, path);
        downloads.set(transferId, download);
        const opened = await download.open();
        if ('error' in opened) downloads.delete(transferId);
        return opened;
      },
      readExecutorFileChunk: async (executorId, path, transferId, offset, length) => {
        const download = downloads.get(transferId);
        if (!download || !download.serves(executorId, path)) {
          return { error: 'file transfer out of sync: no matching open download' };
        }
        const result = await download.range(offset, length);
        if ('error' in result || download.completeAfter(offset + result.bytes.byteLength)) {
          downloads.delete(transferId);
        }
        return result;
      },
      abortExecutorFileDownload: (transferId) => {
        downloads.delete(transferId);
        return Promise.resolve();
      },
      writeExecutorFileChunk: async (
        executorId, path, transferId, offset, chunk, final,
      ) => {
        let row = uploads.get(transferId);
        if (!row || offset === 0) {
          row = {
            path,
            upload: new ExecutorFileUpload(router, executorId, path),
          };
          uploads.set(transferId, row);
        }
        const result = await row.upload.chunk(offset, chunk, final);
        if (row.upload.done) uploads.delete(transferId);
        return result;
      },
      abortExecutorFileWrite: (transferId) => {
        const row = uploads.get(transferId);
        row?.upload.abort();
        uploads.delete(transferId);
        if (row) aborted.push(row.path);
        return Promise.resolve();
      },
    },
    seed: async (path, bytes) => {
      await vfs.writeFile(path, bytes);
    },
    files,
    reads,
    aborted,
  };
}

/** The route with the agent seam injected — no namespace, no DO. */
async function route(request: Request, harness: Harness): Promise<Response> {
  const response = await handleFilesRequest(request, null, "ws", async () => harness.agent);
  if (response === null) throw new Error("route did not claim the request");
  return response;
}

function patternBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at++) out[at] = at % 251;
  return out;
}

function put(body: BodyInit | Uint8Array, headers: Record<string, string> = {}): Request {
  const payload = body instanceof Uint8Array ? new Blob([Uint8Array.from(body)]) : body;
  return new Request(URL_, { method: "PUT", body: payload, headers });
}

async function collect(response: Response): Promise<Uint8Array> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

describe("files route — PUT", () => {
  test("a multi-chunk upload lands byte-exact", async () => {
    const harness = makeAgent();
    const whole = patternBytes(2 * FILE_CHUNK_BYTES + 5);
    const response = await route(put(whole), harness);
    expect(response.status).toBe(200);
    expect(v.parse(OkReplySchema, await response.json())).toEqual({ ok: true });
    expect([...harness.files.get("/home/user/blob.bin")!]).toEqual([...whole]);
  });

  test("an exact multiple of the chunk size is the boundary case and works", async () => {
    const harness = makeAgent();
    const whole = patternBytes(3 * FILE_CHUNK_BYTES);
    expect((await route(put(whole), harness)).status).toBe(200);
    expect(harness.files.get("/home/user/blob.bin")!.byteLength).toBe(whole.byteLength);
  });

  test("one byte past the total limit is a 413 that writes nothing and aborts", async () => {
    const harness = makeAgent();
    // Streamed without a content-length, so the count off the stream is the
    // only bound in play.
    const whole = patternBytes(FILE_TRANSFER_MAX_BYTES + 1);
    const response = await route(put(whole), harness);
    expect(response.status).toBe(413);
    expect(v.parse(ErrorReplySchema, await response.json()).error).toContain("transfer limit");
    expect(harness.files.has("/home/user/blob.bin")).toBe(false);
    expect(harness.aborted).toEqual(["/home/user/blob.bin"]);
  });

  test("a lying content-length header is refused before the body is pulled", async () => {
    const harness = makeAgent();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16));
      },
    }, { highWaterMark: 0 });
    const request = put(body, { "content-length": String(FILE_TRANSFER_MAX_BYTES + 1024) });
    // A zero watermark makes every pull a real consumer read. The assertion
    // below is that the refusal consumed nothing: the body was never read.
    await route(request, harness);
    expect(pulls).toBe(0);
    expect(harness.files.has("/home/user/blob.bin")).toBe(false);
  });

  test("the whole body is never buffered at the edge: arrayBuffer would be a defect", async () => {
    const harness = makeAgent();
    const request = put(patternBytes(FILE_CHUNK_BYTES + 9));
    Object.defineProperty(request, "arrayBuffer", {
      value: () => { throw new Error("route buffered the whole body"); },
    });
    expect((await route(request, harness)).status).toBe(200);
    expect(harness.files.get("/home/user/blob.bin")!.byteLength).toBe(FILE_CHUNK_BYTES + 9);
  });

  test("concurrent same-path uploads never share buffered chunks", async () => {
    const harness = makeAgent();
    const a = new TextEncoder().encode("AA");
    const b = new TextEncoder().encode("BB");
    expect(await harness.agent.writeExecutorFileChunk(
      "workspace", "/home/user/blob.bin", "upload-a", 0, a.subarray(0, 1), false,
    )).toEqual({ ok: true });
    expect(await harness.agent.writeExecutorFileChunk(
      "workspace", "/home/user/blob.bin", "upload-b", 0, b.subarray(0, 1), false,
    )).toEqual({ ok: true });
    expect(await harness.agent.writeExecutorFileChunk(
      "workspace", "/home/user/blob.bin", "upload-a", 1, a.subarray(1), true,
    )).toEqual({ ok: true });
    expect(await harness.agent.writeExecutorFileChunk(
      "workspace", "/home/user/blob.bin", "upload-b", 1, b.subarray(1), true,
    )).toEqual({ ok: true });
    expect(new TextDecoder().decode(harness.files.get("/home/user/blob.bin")))
      .toBe("BB");
  });
});

describe("files route — GET", () => {
  test("a multi-chunk download streams byte-exact bytes", async () => {
    const harness = makeAgent();
    const whole = patternBytes(2 * FILE_CHUNK_BYTES + 11);
    await harness.seed("/home/user/blob.bin", whole);

    const response = await route(new Request(URL_), harness);
    expect(response.status).toBe(200);
    expect([...await collect(response)]).toEqual([...whole]);
  });

  test("a second GET of the same path reads the modified file", async () => {
    const harness = makeAgent();
    await harness.seed("/home/user/blob.bin", new TextEncoder().encode("first"));
    expect(new TextDecoder().decode(await collect(await route(new Request(URL_), harness))))
      .toBe("first");
    await harness.seed("/home/user/blob.bin", new TextEncoder().encode("second"));
    expect(new TextDecoder().decode(await collect(await route(new Request(URL_), harness))))
      .toBe("second");
    expect(harness.reads.count).toBe(2);
  });

  test("a premature zero-byte chunk fails instead of spinning forever", async () => {
    const harness = makeAgent();
    await harness.seed("/home/user/blob.bin", new Uint8Array([1]));
    harness.agent.readExecutorFileChunk = async () => ({ bytes: new Uint8Array(0) });

    const response = await route(new Request(URL_), harness);
    await expect(collect(response)).rejects.toThrow("file ended at 0 of 1 bytes");
  });

  test("a file over the total limit is a 413 before one byte is read", async () => {
    const harness = makeAgent();
    await harness.seed("/home/user/blob.bin", patternBytes(FILE_TRANSFER_MAX_BYTES + 1));
    const response = await route(new Request(URL_), harness);
    expect(response.status).toBe(413);
    // The stat preflight refused it; the plane was never asked for bytes.
    expect(harness.reads.count).toBe(0);
  });

  test("a missing file is a 404 naming the path", async () => {
    const harness = makeAgent();
    const response = await route(new Request(URL_), harness);
    expect(response.status).toBe(404);
    expect(v.parse(ErrorReplySchema, await response.json()).error).toContain("/home/user/blob.bin");
  });
});
