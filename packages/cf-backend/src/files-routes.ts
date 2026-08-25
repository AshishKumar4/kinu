/**
 * HTTP route for file bytes crossing the executor file plane.
 *
 *   PUT /api/workspaces/:agentName/files?executor=<id>&path=<absolute path>
 *   body: the file's raw bytes
 *   GET /api/workspaces/:agentName/files?executor=<id>&path=<absolute path>[&download=1]
 *   → the file's raw bytes
 *
 * This is HTTP and not an agent RPC for one reason: the agents SDK dispatches
 * RPC over the chat WebSocket, whose message ceiling is 1 MiB, and an RPC
 * payload has to base64 its bytes (≈1.37×). Files between roughly 750 KB and
 * the app's own limit therefore passed every check and then died at the socket
 * as an opaque connection failure. A request/response body has no such ceiling
 * and needs no encoding, so neither direction needs an app-level cap: the
 * workspace VFS chunks large files, and every other executor reads and writes
 * through its own mount.
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
import type { OrchestratorAgent } from "./orchestrator";
import { err, fileResponseHeaders, json } from "./lib/http";

export async function handleFilesRequest(
  request: Request,
  env: Env,
  agentName: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== `/api/workspaces/${agentName}/files`) return null;
  if (request.method !== 'PUT' && request.method !== 'GET') return err(405, 'use PUT or GET');

  const executorId = url.searchParams.get('executor');
  const path = url.searchParams.get('path');
  if (!executorId) return err(400, 'executor query parameter required');
  if (!path) return err(400, 'path query parameter required');

  const agent = await getAgentByName<Env, OrchestratorAgent>(
    env.OrchestratorAgent,
    agentName,
  );

  if (request.method === 'PUT') {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const result = await agent.writeExecutorFile(executorId, path, bytes);
    return 'error' in result ? err(400, result.error) : json(result);
  }

  const read = await agent.readExecutorFileBytes(executorId, path);
  if ('error' in read) return err(400, read.error);
  // SAFETY: structured-clone RPC guarantees a view over a plain ArrayBuffer,
  // never a SharedArrayBuffer — verified against `readExecutorFileBytes`'s RPC
  // transport; retype for undici's BodyInit without copying.
  const body: Uint8Array<ArrayBuffer> = read.bytes as Uint8Array<ArrayBuffer>;
  return new Response(body, {
    headers: fileResponseHeaders(path, url.searchParams.get('download') !== null),
  });
}
