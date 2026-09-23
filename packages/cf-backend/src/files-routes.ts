/** Raw bytes cross in FILE_CHUNK_BYTES chunks: a whole file as one RPC argument hits `do.facet.rpc_bytes`. */

import { Hono } from 'hono';
import { getAgentByName } from "agents";
import { FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, pumpUploadChunks, VfsRevisionSchema, type ExecutorWriteResult, type VfsRevision } from "@kinu.run/core";
import * as v from 'valibot';
import type { ExecutorFileChunkRead, ExecutorFileChunkWrite, OrchestratorAgent } from "./orchestrator";
import { diagnostics, KinuError, toKinuError } from "@kinu.run/core/obs";
import { err, fileResponseHeaders, json } from "@kinu.run/core";
import type { FamilyEnv } from './api/context';
import { LITERAL_WORKSPACE, type WorkspaceVariables } from './api/workspace';

export interface FilesRouteAgent {
  startExecutorFileDownload(
    executorId: string, path: string, transferId: string,
  ): Promise<{ size: number } | { error: string; reason: 'too_large' | 'unavailable' }>;
  readExecutorFileChunk(read: ExecutorFileChunkRead): Promise<{ bytes: Uint8Array } | { error: string }>;
  abortExecutorFileDownload(transferId: string): Promise<void>;
  writeExecutorFileChunk(write: ExecutorFileChunkWrite): Promise<ExecutorWriteResult>;
  abortExecutorFileWrite(transferId: string): Promise<void>;
}

/** Null reads as "no object to talk to" and answers 503. */
export type FilesAgentResolver<Bindings> = (env: Bindings, agentName: string) => Promise<FilesRouteAgent | null>;

export const filesAgentResolver: FilesAgentResolver<Env> = (env, agentName) =>
  getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);

/** Method, then query, then object, as before. */
export function filesRoutes<Bindings extends object>(
  resolveAgent: FilesAgentResolver<Bindings>,
): Hono<FamilyEnv<Bindings, WorkspaceVariables>> {
  const routes = new Hono<FamilyEnv<Bindings, WorkspaceVariables>>();

  routes.all(`${LITERAL_WORKSPACE}/files`, async (c) => {
    const { name, request } = c.get('workspace');

    if (request.method !== 'PUT' && request.method !== 'GET') return err(405, 'use PUT or GET');
    const url = new URL(request.url);
    const executorId = url.searchParams.get('executor');
    const path = url.searchParams.get('path');

    if (!executorId) return err(400, 'executor query parameter required');

    if (!path) return err(400, 'path query parameter required');

    const agent = await resolveAgent(c.env, name);

    if (!agent) return err(503, 'workspace agent unavailable');

    if (request.method === 'PUT') {
      const expectedRevision = expectedRevisionFrom(request);

      return expectedRevision === null
        ? err(400, 'If-Match must encode a numeric or string revision')
        : upload({ request, agent, executorId, path, expectedRevision });
    }

    return download(agent, executorId, path, url);
  });

  return routes;
}

function expectedRevisionFrom(request: Request): VfsRevision | undefined | null {
  const value = request.headers.get('if-match');

  if (value === null) return undefined;
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), VfsRevisionSchema), value);

  return parsed.success ? parsed.output : null;
}

/** Streams chunks to the actor; the bound counts bytes pulled, not the declared length, and the actor re-checks offsets and total. */
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
