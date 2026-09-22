/**
 * HTTP route for file bytes crossing the executor file plane.
 *
 *   PUT /api/workspaces/:agentName/files?executor=<id>&path=<absolute path>
 *   body: the file's raw bytes
 *   GET /api/workspaces/:agentName/files?executor=<id>&path=<absolute path>[&download=1]
 *   → the file's raw bytes
 *
 * This is HTTP and not an agent RPC for two reasons. The agents SDK dispatches
 * RPC over the chat WebSocket, whose message ceiling is 1 MiB, and an RPC
 * payload has to base64 its bytes (≈1.37×) — ordinary files died at the socket
 * as an opaque connection failure. And even on the direct stub rail, a whole
 * file as one RPC argument walks into the catalogued `do.facet.rpc_bytes`
 * structured-clone ceiling. So every byte crosses the Worker↔actor boundary as
 * one bounded chunk of FILE_CHUNK_BYTES, in either direction, with the total
 * per transfer held under FILE_TRANSFER_MAX_BYTES.
 *
 * The request side trusts no announced length: `content-length` is checked
 * only as a cheap pre-filter, and the real bound is the count of bytes pulled
 * from the stream — a chunked or HTTP/2 upload that lies about its length is
 * still refused at the first byte past the limit, before the rest is read.
 * The response side streams chunks as they arrive from the actor; nothing
 * buffers the whole file at the edge.
 *
 * GET is the file manager's download AND its image/PDF preview src; the
 * response's security posture lives in `fileResponseHeaders` (lib/http.ts),
 * where it is a tested contract.
 *
 * Auth and ownership are already enforced upstream — server.ts authenticates
 * the identity and verifies the caller owns `:agentName` before any
 * `/api/workspaces/<name>/...` handler runs.
 */

import { getAgentByName } from "agents";
import { FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, pumpUploadChunks, VfsRevisionSchema, type ExecutorWriteResult, type VfsRevision } from "@kinu.run/core";
import * as v from 'valibot';
import type { ExecutorFileChunkRead, ExecutorFileChunkWrite, OrchestratorAgent } from "./orchestrator";
import { diagnostics, KinuError, toKinuError } from "@kinu.run/core/obs";
import { err, fileResponseHeaders, json } from "@kinu.run/core";

/** The stub surface this route drives — narrowed so tests can stand in for
 *  the agent without impersonating the whole actor. */
export interface FilesRouteAgent {
  startExecutorFileDownload(
    executorId: string, path: string, transferId: string,
  ): Promise<{ size: number } | { error: string; reason: 'too_large' | 'unavailable' }>;
  readExecutorFileChunk(read: ExecutorFileChunkRead): Promise<{ bytes: Uint8Array } | { error: string }>;
  abortExecutorFileDownload(transferId: string): Promise<void>;
  writeExecutorFileChunk(write: ExecutorFileChunkWrite): Promise<ExecutorWriteResult>;
  abortExecutorFileWrite(transferId: string): Promise<void>;
}

async function defaultResolveAgent(env: Env | null, agentName: string): Promise<FilesRouteAgent | null> {
  return env === null
    ? null
    : getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
}


export async function handleFilesRequest(
  request: Request,
  env: Env | null,
  agentName: string,
  resolveAgent: (env: Env | null, agentName: string) => Promise<FilesRouteAgent | null> = defaultResolveAgent,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== `/api/workspaces/${agentName}/files`) return null;

  if (request.method !== 'PUT' && request.method !== 'GET') return err(405, 'use PUT or GET');

  const executorId = url.searchParams.get('executor');
  const path = url.searchParams.get('path');

  if (!executorId) return err(400, 'executor query parameter required');

  if (!path) return err(400, 'path query parameter required');

  const agent = await resolveAgent(env, agentName);

  if (!agent) return err(503, 'workspace agent unavailable');

  if (request.method === 'PUT') {
    const expectedRevision = expectedRevisionFrom(request);

    return expectedRevision === null
      ? err(400, 'If-Match must encode a numeric or string revision')
      : upload({ request, agent, executorId, path, expectedRevision });
  }

  return download(agent, executorId, path, url);
}

function expectedRevisionFrom(request: Request): VfsRevision | undefined | null {
  const value = request.headers.get('if-match');

  if (value === null) return undefined;
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), VfsRevisionSchema), value);

  return parsed.success ? parsed.output : null;
}

/**
 * The uploaded bytes, streamed to the actor one bounded chunk at a time.
 *
 * The bound is the shared one (`readBoundedStream`): a declared-length
 * pre-filter, then a count of bytes actually pulled, refused at the first byte
 * past the limit with the stream cancelled rather than drained. Nothing
 * materialises the whole file at the edge. The actor independently re-checks
 * both offset continuity and the total, so neither a lying client nor a lying
 * length header reaches the file plane.
 */
async function upload(transfer: {
  request: Request;
  agent: FilesRouteAgent;
  executorId: string;
  path: string;
  expectedRevision: VfsRevision | undefined;
}): Promise<Response> {
  const { request, agent, executorId, path, expectedRevision } = transfer;

  if (request.body === null) return err(400, 'request body required');

  const overLimit = () => err(
    413,
    `file exceeds the ${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit`,
  );

  const transferId = crypto.randomUUID();

  /** Abort the half-written transfer, naming an abort that itself failed. */
  const abandon = async (): Promise<void> => {
    try {
      await agent.abortExecutorFileWrite(transferId);
    } catch (abortCause) {
      diagnostics.failure('files.upload_abort_failed', toKinuError({
        doing: 'aborting a failed chunked file upload',
        cause: abortCause,
        otherwise: 'unavailable',
      }), { executorId, path });
    }
  };

  let sent = 0;

  try {
    const outcome = await pumpUploadChunks(request, async (offset, chunk, final) => {
      const written = await agent.writeExecutorFileChunk({
        executorId, path, transferId, offset, chunk, final, expectedRevision,
      });

      if (!final && 'error' in written) throw new Error(written.error);
      sent = offset + chunk.byteLength;

      return written;
    });

    if (outcome === 'too_large') {
      await abandon();

      return overLimit();
    }

    if (outcome instanceof KinuError) {
      await abandon();
      diagnostics.failure('files.upload_body_unreadable', outcome, { executorId, path });

      return err(400, 'the upload stopped before the whole file arrived');
    }

    const result = outcome.result;

    if ('conflict' in result) {
      return json(
        { body: { error: 'This file changed after you opened it.', revision: result.revision } },
        { status: 412 },
      );
    }

    if ('unsupported' in result) return json({ body: { error: result.error } }, { status: 409 });

    return 'error' in result ? err(400, result.error) : json({ body: result });
  } catch (cause) {
    await abandon();
    diagnostics.failure('files.upload_failed', toKinuError({
      doing: 'streaming an uploaded file to the workspace actor',
      cause,
      otherwise: 'unavailable',
    }), { executorId, path, bytes: sent });

    return err(400, cause instanceof Error ? cause.message : 'upload failed');
  }
}

async function download(
  agent: FilesRouteAgent,
  executorId: string,
  path: string,
  url: URL,
): Promise<Response> {
  const transferId = crypto.randomUUID();
  const opened = await agent.startExecutorFileDownload(executorId, path, transferId);

  if ('error' in opened) return err(opened.reason === 'too_large' ? 413 : 404, opened.error);

  let offset = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= opened.size) {
        await agent.abortExecutorFileDownload(transferId);
        controller.close();

        return;
      }

      const chunk = await agent.readExecutorFileChunk({
        executorId, path, transferId, offset, length: Math.min(FILE_CHUNK_BYTES, opened.size - offset),
      });

      if ('error' in chunk) {
        await agent.abortExecutorFileDownload(transferId);
        controller.error(new Error(chunk.error));

        return;
      }

      if (chunk.bytes.byteLength === 0) {
        await agent.abortExecutorFileDownload(transferId);
        controller.error(new Error(`file ended at ${String(offset)} of ${String(opened.size)} bytes`));

        return;
      }

      offset += chunk.bytes.byteLength;
      controller.enqueue(chunk.bytes);
    },
    async cancel() {
      await agent.abortExecutorFileDownload(transferId);
    },
  });

  return new Response(stream, {
    headers: fileResponseHeaders(path, url.searchParams.get('download') !== null),
  });
}
