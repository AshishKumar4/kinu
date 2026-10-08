// Files route transfer contract, through a real workspace object and its own file plane: byte-exact chunking, the 413
// before any large allocation, counted (not announced) request bytes, a streamed response, and the plane's own revisions.
import { describe, expect, test } from "bun:test";
import { serveFamily } from './helpers/api';
import * as v from "valibot";
import type { FilesRouteAgent } from "../src/files-routes";
import type { VFS, VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
import { present } from "@kinu.run/test-utils";
import { orchestratorHarness, workspaceFiles, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { filesRoutes } from "../src/files-routes";
import { FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, VfsRevisionSchema } from "@kinu.run/core";

const PATH = "/home/main/blob.bin";

const URL_ = `https://kinu.test/api/workspaces/ws/files?executor=workspace&path=${PATH}`;

const ErrorReplySchema = v.object({ error: v.string() });

const OkReplySchema = v.object({ ok: v.literal(true) });

const ConditionalOkReplySchema = v.object({ ok: v.literal(true), revision: VfsRevisionSchema });

const ConflictReplySchema = v.object({ error: v.string(), revision: VfsRevisionSchema });

/** A file opened for an edit carries the revision its save must name. */
const OpenedSchema = v.looseObject({ revision: VfsRevisionSchema });

interface Workspace {
  agent: HarnessOrchestratorAgent;
  files: VFS;
  /** The file's bytes as the workspace now holds them, or null when it holds none. */
  held(): Promise<Uint8Array | null>;
  /** The revision the Files pane opens the file at now, as the workspace's own plane gives it. */
  revision(): Promise<VfsRevision>;
}

function workspace(): Workspace {
  const { agent } = orchestratorHarness();
  const files = workspaceFiles(agent);

  return {
    agent,
    files,
    held: async () => ((await files.stat(PATH)) === null ? null : files.readFile(PATH)),
    revision: async () => v.parse(OpenedSchema, await agent.readExecutorFile('workspace', PATH)).revision,
  };
}

async function route(request: Request, agent: FilesRouteAgent): Promise<Response> {
  const response = await serveFamily(filesRoutes(async () => agent), { workspace: { name: "ws" } })(request, {});

  if (response === null) throw new Error("route did not claim the request");

  return response;
}

/** The object's own five transfer calls, for a case to replace one of. */
function delegating(agent: HarnessOrchestratorAgent): FilesRouteAgent {
  return {
    startExecutorFileDownload: (...args) => agent.startExecutorFileDownload(...args),
    readExecutorFileChunk: (read) => agent.readExecutorFileChunk(read),
    abortExecutorFileDownload: (transferId) => agent.abortExecutorFileDownload(transferId),
    writeExecutorFileChunk: (write) => agent.writeExecutorFileChunk(write),
    abortExecutorFileWrite: (transferId) => agent.abortExecutorFileWrite(transferId),
  };
}

const text = (bytes: Uint8Array | null): string | null => (bytes === null ? null : new TextDecoder().decode(bytes));

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
    const ws = workspace();
    const whole = patternBytes(2 * FILE_CHUNK_BYTES + 5);
    const response = await route(put(whole), ws.agent);
    expect(response.status).toBe(200);
    expect(v.parse(OkReplySchema, await response.json())).toEqual({ ok: true });
    expect([...present(await ws.held(), "the uploaded blob.bin")]).toEqual([...whole]);
  });

  test("an exact multiple of the chunk size is the boundary case and works", async () => {
    const ws = workspace();
    const whole = patternBytes(3 * FILE_CHUNK_BYTES);
    expect((await route(put(whole), ws.agent)).status).toBe(200);
    expect([...present(await ws.held(), "the uploaded blob.bin")]).toEqual([...whole]);
  });

  test("one byte past the total limit is a 413 that writes nothing", async () => {
    const ws = workspace();
    // No content-length: the stream count is the only bound.
    const response = await route(put(patternBytes(FILE_TRANSFER_MAX_BYTES + 1)), ws.agent);
    expect(response.status).toBe(413);
    expect(await ws.held()).toBeNull();
  });

  test("a declared length over the limit is a 413 refused before the body is pulled", async () => {
    const ws = workspace();
    let pulls = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16));
      },
    }, { highWaterMark: 0 });

    // Zero watermark: every pull is a real read, so an honest oversized sender costs one header parse.
    const response = await route(put(body, { "content-length": String(FILE_TRANSFER_MAX_BYTES + 1024) }), ws.agent);
    expect(response.status).toBe(413);
    expect(pulls).toBe(0);
    expect(await ws.held()).toBeNull();
  });

  test("an undeclared body over the limit is CANCELLED at the first byte past it, not drained", async () => {
    const ws = workspace();
    // A sender that keeps writing must not be read to EOF before the refusal.
    const available = Math.ceil((2 * FILE_TRANSFER_MAX_BYTES) / FILE_CHUNK_BYTES);
    let pulls = 0;
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= available) {
          controller.close();

          return;
        }

        pulls += 1;
        controller.enqueue(patternBytes(FILE_CHUNK_BYTES));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });

    const response = await route(put(body), ws.agent);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    // Well short of the sender's end: the rest stays unread.
    expect(pulls).toBeLessThan(available);
    expect(await ws.held()).toBeNull();
  });

  test("a body at exactly the limit is allowed — the refusal starts one byte later", async () => {
    const ws = workspace();
    expect((await route(put(patternBytes(FILE_TRANSFER_MAX_BYTES)), ws.agent)).status).toBe(200);
    expect(present(await ws.held(), "the uploaded blob.bin").byteLength).toBe(FILE_TRANSFER_MAX_BYTES);
  });

  test("the whole body is never buffered at the edge: arrayBuffer would be a defect", async () => {
    const ws = workspace();
    const request = put(patternBytes(FILE_CHUNK_BYTES + 9));
    Object.defineProperty(request, "arrayBuffer", {
      value: () => { throw new Error("route buffered the whole body"); },
    });
    expect((await route(request, ws.agent)).status).toBe(200);
    expect(present(await ws.held(), "the uploaded blob.bin").byteLength).toBe(FILE_CHUNK_BYTES + 9);
  });

  test("an expected revision writes when it still matches, and answers the file's new revision", async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, new TextEncoder().encode("first"));
    const opened = await ws.revision();

    const response = await route(put("current", { "If-Match": JSON.stringify(opened) }), ws.agent);

    expect(response.status).toBe(200);
    const answered = v.parse(ConditionalOkReplySchema, await response.json()).revision;
    expect(answered).not.toEqual(opened);
    expect(answered).toEqual(await ws.revision());
    expect(text(await ws.held())).toBe("current");
  });

  test("a stale expected revision cannot overwrite a newer interleaved write", async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, new TextEncoder().encode("first"));
    const opened = await ws.revision();
    await ws.files.writeFile(PATH, new TextEncoder().encode("newer"));

    const response = await route(put("stale", { "If-Match": JSON.stringify(opened) }), ws.agent);

    expect(response.status).toBe(412);
    // The refusal carries the revision the editor must reopen at.
    expect(v.parse(ConflictReplySchema, await response.json()).revision).toEqual(await ws.revision());
    expect(text(await ws.held())).toBe("newer");
  });

  test("an upload without If-Match remains unconditional", async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, new TextEncoder().encode("newer"));

    const response = await route(put("unconditional"), ws.agent);

    expect(response.status).toBe(200);
    expect(v.parse(OkReplySchema, await response.json())).toEqual({ ok: true });
    expect(text(await ws.held())).toBe("unconditional");
  });

  // The plane's half is core's (writeExecutorFileOp answers `unsupported` where no compare-and-write exists).
  test("an object whose plane cannot compare-and-write is a 409, and the file stays as it was", async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, new TextEncoder().encode("current"));

    const agent: FilesRouteAgent = {
      ...delegating(ws.agent),
      writeExecutorFileChunk: async () => ({ unsupported: true, error: 'This file plane cannot protect an in-place edit from a newer write.' }),
    };

    const response = await route(put("new", { "If-Match": JSON.stringify(await ws.revision()) }), agent);

    expect(response.status).toBe(409);
    expect(text(await ws.held())).toBe("current");
  });

  test('malformed and non-scalar revisions refuse before writing', async () => {
    for (const revision of ['not-json', '{"revision":1}']) {
      const ws = workspace();
      const response = await route(put('new bytes', { 'If-Match': revision }), ws.agent);
      expect(response.status).toBe(400);
      expect(await ws.held()).toBeNull();
    }
  });

  test('a revision quoted as a string is not the same revision as the number', async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, new TextEncoder().encode('original'));
    const opened = await ws.revision();
    const quoted = typeof opened === 'number' ? JSON.stringify(String(opened)) : String(opened);

    const stale = await route(put('wrong revision', { 'If-Match': quoted }), ws.agent);
    expect(stale.status).toBe(412);
    expect(text(await ws.held())).toBe('original');

    const written = await route(put('matching revision', { 'If-Match': JSON.stringify(opened) }), ws.agent);
    expect(written.status).toBe(200);
    expect(text(await ws.held())).toBe('matching revision');
  });

  test("concurrent same-path uploads never share buffered chunks", async () => {
    const ws = workspace();
    const a = new TextEncoder().encode("AA");
    const b = new TextEncoder().encode("BB");

    const chunk = (transferId: string, offset: number, bytes: Uint8Array, final: boolean) =>
      ws.agent.writeExecutorFileChunk({ executorId: "workspace", path: PATH, transferId, offset, chunk: bytes, final });

    expect(await chunk("upload-a", 0, a.subarray(0, 1), false)).toEqual({ ok: true });
    expect(await chunk("upload-b", 0, b.subarray(0, 1), false)).toEqual({ ok: true });
    expect(await chunk("upload-a", 1, a.subarray(1), true)).toEqual({ ok: true });
    expect(await chunk("upload-b", 1, b.subarray(1), true)).toEqual({ ok: true });
    expect(text(await ws.held())).toBe("BB");
  });

  test("every chunk carries the expected revision fixed by offset zero", async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, new TextEncoder().encode("old"));
    const opened = await ws.revision();
    const other = typeof opened === 'number' ? opened + 1 : `${opened}:other`;

    const chunk = (offset: number, bytes: string, final: boolean, expectedRevision: typeof opened) =>
      ws.agent.writeExecutorFileChunk({
        executorId: "workspace", path: PATH, transferId: "conditional-upload", offset, chunk: new TextEncoder().encode(bytes), final, expectedRevision,
      });

    expect(await chunk(0, "fi", false, opened)).toEqual({ ok: true });
    expect(await chunk(2, "le", true, other)).toMatchObject({ error: expect.any(String) });
    expect(text(await ws.held())).toBe("old");
  });
});


describe("files route — GET", () => {
  test("a multi-chunk download streams byte-exact bytes", async () => {
    const ws = workspace();
    const whole = patternBytes(2 * FILE_CHUNK_BYTES + 11);
    await ws.files.writeFile(PATH, whole);

    const response = await route(new Request(URL_), ws.agent);
    expect(response.status).toBe(200);
    expect([...await collect(response)]).toEqual([...whole]);
  });

  test("a second GET of the same path reads the modified file", async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, new TextEncoder().encode("first"));
    expect(text(await collect(await route(new Request(URL_), ws.agent)))).toBe("first");
    await ws.files.writeFile(PATH, new TextEncoder().encode("second"));
    expect(text(await collect(await route(new Request(URL_), ws.agent)))).toBe("second");
  });

  test("a premature zero-byte chunk fails instead of spinning forever", async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, new Uint8Array([1]));

    // The object answers an empty chunk where a byte is owed.
    const agent: FilesRouteAgent = { ...delegating(ws.agent), readExecutorFileChunk: async () => ({ bytes: new Uint8Array(0) }) };

    await expect(collect(await route(new Request(URL_), agent))).rejects.toThrow();
  });

  test("a file over the total limit is a 413 before one chunk is read", async () => {
    const ws = workspace();
    await ws.files.writeFile(PATH, patternBytes(FILE_TRANSFER_MAX_BYTES + 1));
    let reads = 0;

    const agent: FilesRouteAgent = {
      ...delegating(ws.agent),
      readExecutorFileChunk: async (read) => {
        reads += 1;

        return ws.agent.readExecutorFileChunk(read);
      },
    };

    expect((await route(new Request(URL_), agent)).status).toBe(413);
    expect(reads).toBe(0);
  });

  test("a missing file is a 404 naming the path", async () => {
    const ws = workspace();
    const response = await route(new Request(URL_), ws.agent);
    expect(response.status).toBe(404);
    expect(v.parse(ErrorReplySchema, await response.json()).error).toContain(PATH);
  });
});
