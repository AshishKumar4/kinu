/**
 * HTTP route for file uploads into an executor's file plane.
 *
 *   PUT /api/workspaces/:agentName/files?executor=<id>&path=<absolute path>
 *   body: the file's raw bytes
 *
 * This is HTTP and not an agent RPC for one reason: the agents SDK dispatches
 * RPC over the chat WebSocket, whose message ceiling is 1 MiB, and an RPC
 * upload has to base64 its payload (≈1.37×). Files between roughly 750 KB and
 * the app's own limit therefore passed every check and then died at the socket
 * as an opaque connection failure. A request body has no such ceiling and needs
 * no encoding, so the upload path stops needing an app-level cap at all: the
 * workspace VFS chunks large files, and every other executor writes through its
 * own mount.
 *
 * Auth and ownership are already enforced upstream — server.ts authenticates
 * the identity and verifies the caller owns `:agentName` before any
 * `/api/workspaces/<name>/...` handler runs.
 */

import { getAgentByName } from "agents";
import type { OrchestratorAgent } from "./orchestrator.js";
import { err, json } from "./lib/http.js";

export async function handleFilesRequest(
  request: Request,
  env: Env,
  agentName: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== `/api/workspaces/${agentName}/files`) return null;
  if (request.method !== 'PUT') return err(405, 'use PUT');

  const executorId = url.searchParams.get('executor');
  const path = url.searchParams.get('path');
  if (!executorId) return err(400, 'executor query parameter required');
  if (!path) return err(400, 'path query parameter required');

  const bytes = new Uint8Array(await request.arrayBuffer());
  const agent = await getAgentByName<Env, OrchestratorAgent>(
    (env as Env & { OrchestratorAgent: DurableObjectNamespace }).OrchestratorAgent,
    agentName,
  );
  const result = await agent.writeExecutorFile(executorId, path, bytes);
  return 'error' in result ? err(400, result.error) : json(result);
}
