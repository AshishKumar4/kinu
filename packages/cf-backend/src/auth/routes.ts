// HTTP routes for the credential store + Codex OAuth device-code flow.
//
//   POST   /api/agents/:agentName/auth/codex/start  → start device flow
//          Body: {}
//          → { userCode, deviceAuthId, portalURL, pollIntervalSec }
//
//   POST   /api/agents/:agentName/auth/codex/poll   → exchange when authorized
//          Body: { deviceAuthId, userCode }
//          → { connected: true, accountId? }  on success
//          → { connected: false }              while pending
//
//   GET    /api/agents/:agentName/auth/codex       → status (connected? account?)
//   DELETE /api/agents/:agentName/auth/codex       → revoke stored tokens
//
//   POST   /api/agents/:agentName/auth/credentials/:key
//          Body: Credential JSON (bearer | openai-compat shape)
//   DELETE /api/agents/:agentName/auth/credentials/:key
//   GET    /api/agents/:agentName/auth/credentials  → masked listing (presence + kind)
//
// Each agent has its own credential store backed by DO SQL, so credentials are
// per-agent — different agents on the same Worker can use different providers.

import { getAgentByName } from "agents";
import type { OrchestratorAgent } from "../orchestrator.js";
import { parseAuthPath } from "./path.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function resolveAgent(env: Env, agentName: string) {
  return await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
}

export async function handleAuthRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const parsed = parseAuthPath(url.pathname);
  if (!parsed) return null;
  const { agentName, rest } = parsed;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }

  const agent = await resolveAgent(env, agentName);

  // --- Codex OAuth -----------------------------------------------------------

  if (rest === '/codex/start' && request.method === 'POST') {
    const result = await agent.startCodexDeviceFlow();
    return jsonResponse(result);
  }

  if (rest === '/codex/poll' && request.method === 'POST') {
    let body: { deviceAuthId?: string; userCode?: string };
    try { body = await request.json() as { deviceAuthId?: string; userCode?: string }; }
    catch (err) {
      return jsonResponse({ error: `Invalid JSON: ${(err as Error).message}` }, { status: 400 });
    }
    if (!body.deviceAuthId || !body.userCode) {
      return jsonResponse({ error: 'deviceAuthId and userCode required' }, { status: 400 });
    }
    const result = await agent.pollCodexDeviceFlow(body.deviceAuthId, body.userCode);
    return jsonResponse(result);
  }

  if (rest === '/codex' && request.method === 'GET') {
    return jsonResponse(await agent.getCodexStatus());
  }

  if (rest === '/codex' && request.method === 'DELETE') {
    await agent.disconnectCodex();
    return jsonResponse({ ok: true });
  }

  // --- Generic credential store ---------------------------------------------

  if (rest === '/credentials' && request.method === 'GET') {
    return jsonResponse(await agent.listCredentials());
  }

  const credMatch = rest.match(/^\/credentials\/([^/]+)$/);
  if (credMatch) {
    const key = decodeURIComponent(credMatch[1]);
    // Defense-in-depth: the SQL store is keys-by-string (no FS), but a
    // malformed URL with traversal characters or punctuation could surprise
    // future readers. Restrict to a safe ascii subset.
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(key)) {
      return jsonResponse(
        { error: 'Invalid credential key — alphanumerics, dot, underscore, dash only (max 128 chars).' },
        { status: 400 },
      );
    }
    if (request.method === 'POST') {
      let body: unknown;
      try { body = await request.json(); }
      catch (err) {
        return jsonResponse({ error: `Invalid JSON: ${(err as Error).message}` }, { status: 400 });
      }
      try {
        await agent.setCredential(key, body);
        return jsonResponse({ ok: true });
      } catch (err) {
        // validateCredential throws on malformed shape; surface as 400 not 500.
        return jsonResponse({ error: (err as Error).message }, { status: 400 });
      }
    }
    if (request.method === 'DELETE') {
      await agent.deleteCredential(key);
      return jsonResponse({ ok: true });
    }
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 });
}
