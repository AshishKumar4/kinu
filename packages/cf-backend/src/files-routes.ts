import type { VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
/** Raw bytes cross in FILE_CHUNK_BYTES chunks: a whole file as one RPC argument hits `do.facet.rpc_bytes`. */

import { Hono } from 'hono';
import { serveDownload, serveUpload, VfsRevisionSchema, type ExecutorWriteResult } from "@kinu.run/core";
import * as v from 'valibot';
import type { ExecutorFileChunkRead, ExecutorFileChunkWrite } from "./workspace-executors";
import { KinuError } from "@kinu.run/core/obs";
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

export type FilesAgentResolver<Bindings> = (env: Bindings, agentName: string) => Promise<FilesRouteAgent>;

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

/** The actor's chunked write, which re-checks offsets and the total; its refusals carry no code, so each is the
 *  request's own (400). */
function upload(transfer: {
  request: Request;
  agent: FilesRouteAgent;
  executorId: string;
  path: string;
  expectedRevision: VfsRevision | undefined;
}): Promise<Response> {
  const { request, agent, executorId, path, expectedRevision } = transfer;

  return serveUpload(request, {
    surface: 'files',
    fields: { executorId, path },
    write: (transferId, offset, chunk, final): Promise<ExecutorWriteResult> => agent.writeExecutorFileChunk({
      executorId, path, transferId, offset, chunk, final, expectedRevision,
    }),
    refused: (written) => ('error' in written ? new KinuError('bad_input', written.error) : null),
    abort: (transferId) => agent.abortExecutorFileWrite(transferId),
    answer: (result) => {
      if ('conflict' in result) {
        return json({ body: { error: 'This file changed after you opened it.', revision: result.revision } }, { status: 412 });
      }

      if ('unsupported' in result) return json({ body: { error: result.error } }, { status: 409 });

      return 'error' in result ? err(400, result.error) : json({ body: result });
    },
  });
}

/** The executor's file, by the snapshot the actor takes at its start. Its read model says a file it cannot serve is
 *  past the limit or not there, never why else. */
function download(agent: FilesRouteAgent, executorId: string, path: string, url: URL): Promise<Response> {
  return serveDownload({
    start: async (transferId) => {
      const opened = await agent.startExecutorFileDownload(executorId, path, transferId);

      return 'error' in opened ? new KinuError(opened.reason === 'too_large' ? 'budget' : 'missing', opened.error) : opened;
    },
    read: async (transferId, offset, length) => {
      const chunk = await agent.readExecutorFileChunk({ executorId, path, transferId, offset, length });

      return 'error' in chunk ? new KinuError('io', chunk.error) : chunk.bytes;
    },
    abort: (transferId) => agent.abortExecutorFileDownload(transferId),
  }, () => fileResponseHeaders(path, url.searchParams.get('download') !== null));
}
