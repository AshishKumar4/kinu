/**
 * `/api/user/*` HTTP routes. All operations are user-scoped — the auth
 * middleware resolves the caller's Proteus `userId` before any of these
 * handlers run.
 *
 * Routes:
 *   GET    /api/user/profile                       — user info
 *   GET    /api/user/cli                           — CLI setup commands
 *   GET    /api/user/agents                        — agent registry
 *   POST   /api/user/agents                        — register new agent
 *   POST   /api/user/agents/:name/touch            — update last_visited
 *   DELETE /api/user/agents/:name                  — remove from registry
 *   GET    /api/user/credentials                   — masked listing
 *   POST   /api/user/credentials/:key              — set
 *   DELETE /api/user/credentials/:key              — delete
 *   GET    /api/user/codex                         — Codex status
 *   POST   /api/user/codex/start                   — start device flow
 *   POST   /api/user/codex/poll                    — poll device flow
 *   DELETE /api/user/codex                         — disconnect Codex
 *   GET    /api/user/config                        — list all defaults
 *   GET    /api/user/config/:key                   — single default
 *   PUT    /api/user/config/:key                   — set default
 *   GET    /api/user/models                        — union of available models
 *   GET    /api/user/providers                     — connected provider summary
 *   GET    /api/user/mcp/servers                   — list configured MCP servers
 *   POST   /api/user/mcp/servers                   — add a new MCP server
 *   DELETE /api/user/mcp/servers/:id               — remove an MCP server
 *   PATCH  /api/user/mcp/servers/:id               — edit name / headers / allowed_tools
 *   GET    /api/user/mcp/callback                  — OAuth 2.1 redirect handler
 */
import type { AuthIdentity } from '../auth/session.js';
import type { UserDO } from './user-do.js';
import { buildCliAuthCommand, buildCliInstallCommand, buildCliSetupCommand, normalizeCliOrigin } from '../cli/install-command.js';
import { listAvailableModels } from './available-models.js';
import { handleCreateAgentRequest, notifyAgentsCredentialsChanged } from './agent-access.js';
import { err, json, safeJson } from '../lib/http.js';

function getUserDOStub(env: Env, userId: string): DurableObjectStub<UserDO> {
  return env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
}

export async function handleUserRequest(
  request: Request,
  env: Env,
  identity: AuthIdentity,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/user')) return null;
  const path = url.pathname.slice('/api/user'.length);
  const method = request.method;

  const stub = getUserDOStub(env, identity.userId);
  // Bootstrap profile on every request — cheap UPDATE if exists, INSERT once.
  await stub.ensureProfile(identity.email, identity.displayName ?? undefined);

  // ── Profile ────────────────────────────────────────────────────────
  if (path === '/profile' && method === 'GET') {
    return json(await stub.getProfile());
  }
  if (path === '/cli' && method === 'GET') {
    const cliOrigin = normalizeCliOrigin(env.CLI_PUBLIC_ORIGIN || url.origin);
    return json({
      publicOrigin: cliOrigin,
      installCommand: buildCliInstallCommand({ origin: cliOrigin }),
      setupCommand: buildCliSetupCommand(cliOrigin),
      authCommand: buildCliAuthCommand(cliOrigin),
    });
  }

  // ── Agents ─────────────────────────────────────────────────────────
  if (path === '/agents' && method === 'GET') {
    return json(await stub.listAgents());
  }
  if (path === '/agents' && method === 'POST') {
    return handleCreateAgentRequest(request, env, identity.userId, stub, ctx);
  }
  const agentTouchMatch = path.match(/^\/agents\/([^/]+)\/touch$/);
  if (agentTouchMatch && method === 'POST') {
    try { await stub.touchAgent(decodeURIComponent(agentTouchMatch[1])); return json({ ok: true }); }
    catch (e) { return err(400, (e as Error).message); }
  }
  const agentMatch = path.match(/^\/agents\/([^/]+)$/);
  if (agentMatch && method === 'DELETE') {
    try { await stub.removeAgent(decodeURIComponent(agentMatch[1]), identity.userId); return json({ ok: true }); }
    catch (e) { return err(400, (e as Error).message); }
  }

  // ── Devices (user-level laptop/PC tunnel) ──────────────────────────
  if (path === '/devices' && method === 'GET') {
    return json(await stub.listDevices());
  }
  if (path === '/devices' && method === 'POST') {
    const body = await safeJson<{ label?: string }>(request);
    const cliOrigin = normalizeCliOrigin(env.CLI_PUBLIC_ORIGIN || url.origin);
    const installCommand = buildCliInstallCommand({
      origin: cliOrigin,
      setup: false,
      connect: true,
      label: body?.label,
    });
    return json({ origin: cliOrigin, installCommand }, { status: 201 });
  }
  const deviceMatch = path.match(/^\/devices\/([^/]+)$/);
  if (deviceMatch && method === 'DELETE') {
    try { await stub.revokeDevice(decodeURIComponent(deviceMatch[1])); return json({ ok: true }); }
    catch (e) { return err(400, (e as Error).message); }
  }

  // ── Credentials ────────────────────────────────────────────────────
  if (path === '/credentials' && method === 'GET') {
    return json(await stub.listCredentials());
  }
  const credMatch = path.match(/^\/credentials\/([^/]+)$/);
  if (credMatch) {
    const key = decodeURIComponent(credMatch[1]);
    if (method === 'POST') {
      const body = await safeJson(request);
      if (body === null) return err(400, 'Body must be JSON');
      try { await stub.setCredential(key, body); }
      catch (e) { return err(400, (e as Error).message); }
      notifyAgentsCredentialsChanged(env, stub, ctx);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      try { await stub.deleteCredential(key); }
      catch (e) { return err(400, (e as Error).message); }
      notifyAgentsCredentialsChanged(env, stub, ctx);
      return json({ ok: true });
    }
  }

  // ── Codex device flow ──────────────────────────────────────────────
  if (path === '/codex' && method === 'GET') {
    return json(await stub.getCodexStatus());
  }
  if (path === '/codex' && method === 'DELETE') {
    await stub.disconnectCodex();
    notifyAgentsCredentialsChanged(env, stub, ctx);
    return json({ ok: true });
  }
  if (path === '/codex/start' && method === 'POST') {
    try { return json(await stub.startCodexDeviceFlow()); }
    catch (e) { return err(502, (e as Error).message); }
  }
  if (path === '/codex/poll' && method === 'POST') {
    try {
      const status = await stub.pollCodexDeviceFlow();
      if (status.connected) notifyAgentsCredentialsChanged(env, stub, ctx);
      return json(status);
    } catch (e) { return err(502, (e as Error).message); }
  }

  // ── Config (defaults) ──────────────────────────────────────────────
  if (path === '/config' && method === 'GET') {
    return json(await stub.listConfig());
  }
  const cfgMatch = path.match(/^\/config\/([^/]+)$/);
  if (cfgMatch) {
    const key = decodeURIComponent(cfgMatch[1]);
    if (method === 'GET') {
      return json({ key, value: await stub.getConfig(key) });
    }
    if (method === 'PUT') {
      const body = await safeJson<{ value?: string }>(request);
      if (!body || typeof body.value !== 'string') return err(400, 'value (string) required');
      await stub.setConfig(key, body.value);
      return json({ ok: true });
    }
  }

  // ── Models + providers ─────────────────────────────────────────────
  if (path === '/providers' && method === 'GET') {
    return json(await stub.listConnectedProviders());
  }
  if (path === '/models' && method === 'GET') {
    return json(await listAvailableModels(env, identity.userId));
  }

  // ── MCP servers ────────────────────────────────────────────────────
  if (path === '/mcp/servers' && method === 'GET') {
    try { return json(await stub.userMcp_list()); }
    catch (e) { return err(500, (e as Error).message); }
  }
  if (path === '/mcp/servers' && method === 'POST') {
    const body = await safeJson(request);
    if (body === null) return err(400, 'Body must be JSON');
    const origin = publicOrigin(request);
    try { return json(await stub.userMcp_add(body, origin), { status: 201 }); }
    catch (e) { return err(400, (e as Error).message); }
  }
  const mcpIdMatch = path.match(/^\/mcp\/servers\/([^/]+)$/);
  if (mcpIdMatch) {
    const id = decodeURIComponent(mcpIdMatch[1]);
    if (method === 'DELETE') {
      try { await stub.userMcp_remove(id); return json({ ok: true }); }
      catch (e) { return err(400, (e as Error).message); }
    }
    if (method === 'PATCH') {
      const body = await safeJson(request);
      if (body === null) return err(400, 'Body must be JSON');
      try { await stub.userMcp_update(id, body); return json({ ok: true }); }
      catch (e) { return err(400, (e as Error).message); }
    }
  }
  if (path === '/mcp/callback' && method === 'GET') {
    // The OAuth provider stamps `<nonce>.<serverId>` in `state`; we don't
    // need to extract it here — `userMcp_handleOAuthCallback` does the validation
    // inside UserDO. The Worker's browser auth middleware (above) already
    // resolved the caller's identity, so we know which UserDO to dispatch to.
    const result = await stub.userMcp_handleOAuthCallback(request.url);
    // Redirect the browser back to the settings page regardless of outcome.
    // The page polls userMcp_list and the per-server status surfaces the
    // result. We include `?mcp_auth=ok|failed&error=...` for UX clarity.
    const settingsUrl = new URL('/user/settings/mcp', publicOrigin(request));
    settingsUrl.searchParams.set('mcp_auth', result.ok ? 'ok' : 'failed');
    if (result.error) settingsUrl.searchParams.set('error', result.error.slice(0, 200));
    if (result.serverId) settingsUrl.searchParams.set('server_id', result.serverId);
    return new Response(null, { status: 302, headers: { Location: settingsUrl.toString() } });
  }

  return err(404, `No such user route: ${method} ${path}`);
}

/** Derive the public origin the client sees. CF puts the canonical host
 *  in the Host header for direct-zone routes; the Worker's own URL is
 *  also a fine fallback (it matches the publicly-exposed origin). */
function publicOrigin(request: Request): string {
  // CF-Connecting-IP and similar headers don't help; the safest source is
  // the request URL itself because Workers preserves the visitor's scheme
  // and host in `request.url` for proxied requests.
  return new URL(request.url).origin;
}
