// Files route transfer contract: byte-exact chunking, the 413 before any large allocation,
// counted (not announced) request bytes, and a streamed response.
import { describe, expect, test } from "bun:test";
import { serveFamily } from './helpers/api';
import * as v from "valibot";
import type { FilesRouteAgent } from "../src/files-routes";
import type {
  ExecutorFileDownload as ExecutorFileDownloadInstance,
  ExecutorFileUpload as ExecutorFileUploadInstance,
  VFS, VfsRevision,
} from "@kinu.run/core";
// The route imports the agents SDK, whose `cloudflare:*` imports crash bun's loader: mock, then
// import dynamically.
import { mockAgentsSdk } from "./helpers/agents-sdk";
import { present } from "@kinu.run/test-utils";

mockAgentsSdk();

const { filesRoutes } = await import("../src/files-routes");

const {
  ExecutorFileDownload, ExecutorFileUpload, FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, VfsRevisionSchema,
} = await import("@kinu.run/core");

const URL_ = "https://kinu.test/api/workspaces/ws/files?executor=workspace&path=/home/main/blob.bin";

const ErrorReplySchema = v.object({ error: v.string() });

const OkReplySchema = v.object({ ok: v.literal(true) });

const ConditionalOkReplySchema = v.object({ ok: v.literal(true), revision: VfsRevisionSchema });

const ConflictReplySchema = v.object({ error: v.string(), revision: VfsRevisionSchema });

interface Harness {
  agent: FilesRouteAgent;
  seed(path: string, bytes: Uint8Array, revision?: VfsRevision): Promise<void>;
  files: Map<string, Uint8Array>;
  reads: { count: number };
  aborted: string[];
}

/** Wired like OrchestratorAgent's own chunk methods, over a recording VFS. */
function makeAgent({ supportsConditionalWrites = true }: { supportsConditionalWrites?: boolean } = {}): Harness {
  const files = new Map<string, Uint8Array>();
  const revisions = new Map<string, VfsRevision>();
  const reads = { count: 0 };
  const aborted: string[] = [];

  const uploads = new Map<string, {
    readonly path: string;
    readonly expectedRevision: VfsRevision | undefined;
    readonly upload: ExecutorFileUploadInstance;
  }>();

  const downloads = new Map<string, ExecutorFileDownloadInstance>();

  const vfs: VFS = {
    readFile: async (path: string) => {
      reads.count += 1;
      const data = files.get(path);

      if (data === undefined) throw new Error(`ENOENT: ${path}`);

      return data;
    },
    writeFile: async (path: string, data: Uint8Array | string) => {
      files.set(path, data instanceof Uint8Array ? data : new TextEncoder().encode(data));
      const previous = revisions.get(path) ?? 0;
      revisions.set(path, v.is(v.number(), previous) ? previous + 1 : previous + ':next');
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

  if (supportsConditionalWrites) {
    vfs.writeFileIfRevision = async (path, data, expectedRevision) => {
      const revision = revisions.get(path) ?? 0;

      if (expectedRevision !== revision) return { ok: false, revision };
      files.set(path, data);
      const nextRevision = v.is(v.number(), revision) ? revision + 1 : revision + ':next';
      revisions.set(path, nextRevision);

      return { ok: true, revision: nextRevision };
    };
  }

  const router = {
    getProvider: (id: string) =>
      id === "workspace" ? { files: vfs, homeDir: async () => "/home/main" } : undefined,
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
      readExecutorFileChunk: async ({ executorId, path, transferId, offset, length }) => {
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
      writeExecutorFileChunk: async ({
        executorId, path, transferId, offset, chunk, final, expectedRevision,
      }) => {
        let row = uploads.get(transferId);

        if (!row || offset === 0) {
          row = {
            path,
            expectedRevision,
            upload: new ExecutorFileUpload(router, executorId, path, expectedRevision),
          };
          uploads.set(transferId, row);
        } else if (row.expectedRevision !== expectedRevision) {
          return { error: 'file transfer out of sync: expected revision does not match the first chunk' };
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
    seed: async (path, bytes, revision) => {
      await vfs.writeFile(path, bytes);

      if (revision !== undefined) revisions.set(path, revision);
    },
    files,
    reads,
    aborted,
  };
}

async function route(request: Request, harness: Harness): Promise<Response> {
  const response = await serveFamily(filesRoutes(async () => harness.agent), { workspace: { name: "ws" } })(request, {});

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
  const reader = present(response.body, 'the response body stream').getReader();
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
    expect([...present(harness.files.get("/home/main/blob.bin"), "the uploaded blob.bin")]).toEqual([...whole]);
  });

  test("an exact multiple of the chunk size is the boundary case and works", async () => {
    const harness = makeAgent();
    const whole = patternBytes(3 * FILE_CHUNK_BYTES);
    expect((await route(put(whole), harness)).status).toBe(200);
    expect(present(harness.files.get("/home/main/blob.bin"), "the uploaded blob.bin").byteLength).toBe(whole.byteLength);
  });

  test("one byte past the total limit is a 413 that writes nothing and aborts", async () => {
    const harness = makeAgent();
    // No content-length: the stream count is the only bound.
    const whole = patternBytes(FILE_TRANSFER_MAX_BYTES + 1);
    const response = await route(put(whole), harness);
    expect(response.status).toBe(413);
    expect(v.parse(ErrorReplySchema, await response.json()).error)
      .toBe(`file exceeds the ${Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024))} MiB transfer limit`);
    expect(harness.files.has("/home/main/blob.bin")).toBe(false);
    expect(harness.aborted).toEqual(["/home/main/blob.bin"]);
  });

  test("a declared length over the limit is a 413 refused before the body is pulled", async () => {
    const harness = makeAgent();
    let pulls = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16));
      },
    }, { highWaterMark: 0 });

    const request = put(body, { "content-length": String(FILE_TRANSFER_MAX_BYTES + 1024) });
    // Zero watermark: every pull is a real read, so an honest oversized sender costs one header parse.
    const response = await route(request, harness);
    expect(response.status).toBe(413);
    expect(v.parse(ErrorReplySchema, await response.json()).error)
      .toBe(`file exceeds the ${Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024))} MiB transfer limit`);
    expect(pulls).toBe(0);
    expect(harness.files.has("/home/main/blob.bin")).toBe(false);
  });

  test("an undeclared body over the limit is CANCELLED at the first byte past it, not drained", async () => {
    const harness = makeAgent();
    // A sender that keeps writing must not be read to EOF before the refusal.
    const CHUNK = FILE_CHUNK_BYTES;
    const available = Math.ceil((2 * FILE_TRANSFER_MAX_BYTES) / CHUNK);
    let pulls = 0;
    let cancelled: string | undefined;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= available) {
          controller.close();

          return;
        }

        pulls += 1;
        controller.enqueue(patternBytes(CHUNK));
      },
      cancel(reason: string) { cancelled = reason; },
    }, { highWaterMark: 0 });

    const response = await route(put(body), harness);
    expect(response.status).toBe(413);
    expect(cancelled).toBe("the request body is over its limit");
    // One chunk past the limit is all the count needs; the rest stays unread.
    expect(pulls).toBe(Math.floor(FILE_TRANSFER_MAX_BYTES / CHUNK) + 1);
    expect(harness.files.has("/home/main/blob.bin")).toBe(false);
    expect(harness.aborted).toEqual(["/home/main/blob.bin"]);
  });

  test("a body at exactly the limit is allowed — the refusal starts one byte later", async () => {
    const harness = makeAgent();
    const whole = patternBytes(FILE_TRANSFER_MAX_BYTES);
    expect((await route(put(whole), harness)).status).toBe(200);
    expect(present(harness.files.get("/home/main/blob.bin"), "the uploaded blob.bin").byteLength).toBe(FILE_TRANSFER_MAX_BYTES);
  });

  test("the whole body is never buffered at the edge: arrayBuffer would be a defect", async () => {
    const harness = makeAgent();
    const request = put(patternBytes(FILE_CHUNK_BYTES + 9));
    Object.defineProperty(request, "arrayBuffer", {
      value: () => { throw new Error("route buffered the whole body"); },
    });
    expect((await route(request, harness)).status).toBe(200);
    expect(present(harness.files.get("/home/main/blob.bin"), "the uploaded blob.bin").byteLength).toBe(FILE_CHUNK_BYTES + 9);
  });

  test("an expected revision writes atomically when it still matches", async () => {
    const harness = makeAgent();
    await harness.seed("/home/main/blob.bin", new TextEncoder().encode("first"));

    const response = await route(put("current", { "If-Match": "1" }), harness);

    expect(response.status).toBe(200);
    expect(v.parse(ConditionalOkReplySchema, await response.json())).toEqual({ ok: true, revision: 2 });
    expect(new TextDecoder().decode(harness.files.get("/home/main/blob.bin"))).toBe("current");
  });

  test("a stale expected revision cannot overwrite a newer interleaved write", async () => {
    const harness = makeAgent();
    await harness.seed("/home/main/blob.bin", new TextEncoder().encode("first"));
    await harness.seed("/home/main/blob.bin", new TextEncoder().encode("newer"));

    const response = await route(put("stale", { "If-Match": "1" }), harness);

    expect(response.status).toBe(412);
    expect(v.parse(ConflictReplySchema, await response.json())).toEqual({
      error: 'This file changed after you opened it.',
      revision: 2,
    });
    expect(new TextDecoder().decode(harness.files.get("/home/main/blob.bin"))).toBe("newer");
  });

  test("an upload without If-Match remains unconditional", async () => {
    const harness = makeAgent();
    await harness.seed("/home/main/blob.bin", new TextEncoder().encode("newer"));

    const response = await route(put("unconditional"), harness);

    expect(response.status).toBe(200);
    expect(v.parse(OkReplySchema, await response.json())).toEqual({ ok: true });
    expect(new TextDecoder().decode(harness.files.get("/home/main/blob.bin"))).toBe("unconditional");
  });

  test("a conditional upload is refused when its file plane lacks native compare-and-write", async () => {
    const harness = makeAgent({ supportsConditionalWrites: false });
    await harness.seed("/home/main/blob.bin", new TextEncoder().encode("current"));

    const response = await route(put("new", { "If-Match": "1" }), harness);

    expect(response.status).toBe(409);
    expect(v.parse(ErrorReplySchema, await response.json())).toEqual({
      error: 'This file plane cannot protect an in-place edit from a newer write. Download it to edit safely.',
    });
    expect(new TextDecoder().decode(harness.files.get("/home/main/blob.bin"))).toBe("current");
  });

  test('malformed and non-scalar revisions refuse before writing', async () => {
    for (const revision of ['not-json', '{"revision":1}']) {
      const harness = makeAgent();
      const response = await route(put('new bytes', { 'If-Match': revision }), harness);
      expect(response.status).toBe(400);
      expect(harness.files.has('/home/main/blob.bin')).toBe(false);
    }
  });

  test('a quoted numeric-looking revision remains distinct from a numeric revision', async () => {
    const harness = makeAgent();
    await harness.seed('/home/main/blob.bin', new TextEncoder().encode('original'), '7');
    const stale = await route(put('wrong revision', { 'If-Match': '7' }), harness);
    expect(stale.status).toBe(412);
    expect(v.parse(ConflictReplySchema, await stale.json()).revision).toBe('7');
    expect(new TextDecoder().decode(harness.files.get('/home/main/blob.bin'))).toBe('original');

    const written = await route(put('matching revision', { 'If-Match': JSON.stringify('7') }), harness);
    expect(written.status).toBe(200);
    expect(new TextDecoder().decode(harness.files.get('/home/main/blob.bin'))).toBe('matching revision');
  });

  test("concurrent same-path uploads never share buffered chunks", async () => {
    const harness = makeAgent();
    const a = new TextEncoder().encode("AA");
    const b = new TextEncoder().encode("BB");
    expect(await harness.agent.writeExecutorFileChunk({
      executorId: "workspace", path: "/home/main/blob.bin", transferId: "upload-a", offset: 0, chunk: a.subarray(0, 1), final: false,
    })).toEqual({ ok: true });
    expect(await harness.agent.writeExecutorFileChunk({
      executorId: "workspace", path: "/home/main/blob.bin", transferId: "upload-b", offset: 0, chunk: b.subarray(0, 1), final: false,
    })).toEqual({ ok: true });
    expect(await harness.agent.writeExecutorFileChunk({
      executorId: "workspace", path: "/home/main/blob.bin", transferId: "upload-a", offset: 1, chunk: a.subarray(1), final: true,
    })).toEqual({ ok: true });
    expect(await harness.agent.writeExecutorFileChunk({
      executorId: "workspace", path: "/home/main/blob.bin", transferId: "upload-b", offset: 1, chunk: b.subarray(1), final: true,
    })).toEqual({ ok: true });
    expect(new TextDecoder().decode(harness.files.get("/home/main/blob.bin")))
      .toBe("BB");
  });
  test("every chunk carries the expected revision fixed by offset zero", async () => {
    const harness = makeAgent();
    const first = new TextEncoder().encode("fi");
    const second = new TextEncoder().encode("le");
    expect(await harness.agent.writeExecutorFileChunk({
      executorId: "workspace", path: "/home/main/blob.bin", transferId: "conditional-upload", offset: 0, chunk: first, final: false,
      expectedRevision: 1,
    })).toEqual({ ok: true });
    expect(await harness.agent.writeExecutorFileChunk({
      executorId: "workspace", path: "/home/main/blob.bin", transferId: "conditional-upload", offset: 2, chunk: second, final: true,
      expectedRevision: 2,
    })).toEqual({
      error: 'file transfer out of sync: expected revision does not match the first chunk',
    });
    expect(harness.files.has("/home/main/blob.bin")).toBe(false);
  });
});


describe("files route — GET", () => {
  test("a multi-chunk download streams byte-exact bytes", async () => {
    const harness = makeAgent();
    const whole = patternBytes(2 * FILE_CHUNK_BYTES + 11);
    await harness.seed("/home/main/blob.bin", whole);

    const response = await route(new Request(URL_), harness);
    expect(response.status).toBe(200);
    expect([...await collect(response)]).toEqual([...whole]);
  });

  test("a second GET of the same path reads the modified file", async () => {
    const harness = makeAgent();
    await harness.seed("/home/main/blob.bin", new TextEncoder().encode("first"));
    expect(new TextDecoder().decode(await collect(await route(new Request(URL_), harness))))
      .toBe("first");
    await harness.seed("/home/main/blob.bin", new TextEncoder().encode("second"));
    expect(new TextDecoder().decode(await collect(await route(new Request(URL_), harness))))
      .toBe("second");
    expect(harness.reads.count).toBe(2);
  });

  test("a premature zero-byte chunk fails instead of spinning forever", async () => {
    const harness = makeAgent();
    await harness.seed("/home/main/blob.bin", new Uint8Array([1]));
    harness.agent.readExecutorFileChunk = async () => ({ bytes: new Uint8Array(0) });

    const response = await route(new Request(URL_), harness);
    await expect(collect(response)).rejects.toThrow("file ended at 0 of 1 bytes");
  });

  test("a file over the total limit is a 413 before one byte is read", async () => {
    const harness = makeAgent();
    await harness.seed("/home/main/blob.bin", patternBytes(FILE_TRANSFER_MAX_BYTES + 1));
    const response = await route(new Request(URL_), harness);
    expect(response.status).toBe(413);
    expect(harness.reads.count).toBe(0);
  });

  test("a missing file is a 404 naming the path", async () => {
    const harness = makeAgent();
    const response = await route(new Request(URL_), harness);
    expect(response.status).toBe(404);
    expect(v.parse(ErrorReplySchema, await response.json()).error).toContain("/home/main/blob.bin");
  });
});
