/**
 * `/api/user/*` HTTP routes. All operations are user-scoped — the auth
 * middleware resolves the caller's Proteus `userId` before any of these
 * handlers run.
 *
 * Routes:
 *   GET    /api/user/profile                       — user info
 *   GET    /api/user/cli                           — CLI setup commands
 *   GET    /api/user/workspaces                        — agent registry
 *   POST   /api/user/workspaces                        — register new agent
 *   POST   /api/user/workspaces/:name/touch            — update last_visited
 *   DELETE /api/user/workspaces/:name                  — remove from registry
 *   GET    /api/user/credentials                   — masked listing
 *   POST   /api/user/credentials/:key              — set
 *   DELETE /api/user/credentials/:key              — delete
 *   GET    /api/user/devices/consents              — per-(agent, device) consent tiers
 *   PUT    /api/user/devices/:id/consent           — set an agent's consent tier on a device
 *   GET    /api/user/codex                         — Codex status
 *   POST   /api/user/codex/start                   — start device flow
 *   POST   /api/user/codex/poll                    — poll device flow
 *   DELETE /api/user/codex                         — disconnect Codex
 *   GET    /api/user/config                        — list all defaults
 *   GET    /api/user/config/:key                   — single default
 *   PUT    /api/user/config/:key                   — set default
 *   GET    /api/user/models                        — union of available models
 *   GET    /api/user/providers                     — connected provider summary
 *   GET    /api/user/providers/catalog             — connectable providers (BYO key)
 *   GET    /api/user/cloudflare/gateways           — the user's AI Gateways + selection
 *   PUT    /api/user/cloudflare/gateway            — select an AI Gateway (or null)
 *   GET    /api/user/mcp/servers                   — list configured MCP servers
 *   POST   /api/user/mcp/servers                   — add a new MCP server
 *   DELETE /api/user/mcp/servers/:id               — remove an MCP server
 *   PATCH  /api/user/mcp/servers/:id               — edit name / headers / allowed_tools
 *   GET    /api/user/mcp/callback                  — OAuth 2.1 redirect handler
 */
import type { AuthIdentity } from '../auth/session.js';
import type { UserDO } from './user-do.js';
import { DEVICE_CONSENT_SCOPE, DEVICE_CONSENT_SCOPE_FULL_FS } from './device-consent.js';
import { buildCliAuthCommand, buildCliInstallCommand, buildCliSetupCommand, normalizeCliOrigin } from '../cli/install-command.js';
import { listAvailableModels, listProviderCatalog } from './available-models.js';
import { handleCreateWorkspaceRequest, notifyWorkspacesCredentialsChanged } from './workspace-access.js';
import { err, json, safeJson } from '../lib/http.js';
import { OWNER_SESSION } from './workspace-capability.js';

function getUserDOStub(env: Env, userId: string): DurableObjectStub<UserDO> {
  return env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
}

/** Users whose MCP connections we've already kicked off warming for this
 *  isolate. Warm-once-per-process so a cold UserDO re-establishes connections
 *  in parallel with the first orchestrator turn, not on its 5s critical path. */
const warmedMcpUsers = new Set<string>();

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
  await stub.ensureProfile(OWNER_SESSION, identity.email, identity.displayName ?? undefined);

  // Fire-and-forget on the first hit for this user this isolate: warm MCP, and
  // repair workspaces that predate the capability boundary. The backfill is
  // one-shot per user inside the UserDO — a workspace runs on an alarm, an
  // inbound email or a peer's task without anyone opening it, so waiting for a
  // human to visit each one would fail those turns.
  if (ctx && !warmedMcpUsers.has(identity.userId)) {
    warmedMcpUsers.add(identity.userId);
    ctx.waitUntil(stub.userMcp_warmConnections(OWNER_SESSION).then(() => {}, () => {}));
    ctx.waitUntil(stub.backfillWorkspaceCapabilities(OWNER_SESSION).then(() => {}, () => {}));
  }

  // ── Profile ────────────────────────────────────────────────────────
  if (path === '/profile' && method === 'GET') {
    return json(await stub.getProfile(OWNER_SESSION));
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
  if (path === '/workspaces' && method === 'GET') {
    return json(await stub.listWorkspaces(OWNER_SESSION));
  }
  if (path === '/workspaces' && method === 'POST') {
    return handleCreateWorkspaceRequest(request, env, identity.userId, stub, ctx);
  }
  const agentTouchMatch = path.match(/^\/workspaces\/([^/]+)\/touch$/);
  if (agentTouchMatch && method === 'POST') {
    try { await stub.touchWorkspace(OWNER_SESSION, decodeURIComponent(agentTouchMatch[1])); return json({ ok: true }); }
    catch (e) { return err(400, (e as Error).message); }
  }
  const agentMatch = path.match(/^\/workspaces\/([^/]+)$/);
  if (agentMatch && method === 'DELETE') {
    try { await stub.removeWorkspace(OWNER_SESSION, decodeURIComponent(agentMatch[1]), identity.userId); return json({ ok: true }); }
    catch (e) { return err(400, (e as Error).message); }
  }

  // ── Devices (user-level laptop/PC tunnel) ──────────────────────────
  if (path === '/devices' && method === 'GET') {
    return json(await stub.listDevices(OWNER_SESSION));
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
    try { await stub.revokeDevice(OWNER_SESSION, decodeURIComponent(deviceMatch[1])); return json({ ok: true }); }
    catch (e) { return err(400, (e as Error).message); }
  }

  // ── Device consents (per-(agent, device) tier: base vs full filesystem) ──
  if (path === '/devices/consents' && method === 'GET') {
    return json(await stub.listDeviceConsents(OWNER_SESSION));
  }
  const consentMatch = path.match(/^\/devices\/([^/]+)\/consent$/);
  if (consentMatch && method === 'PUT') {
    const body = await safeJson<{ agentName?: string; scope?: string }>(request);
    const agentName = body?.agentName;
    const scope = body?.scope;
    if (!agentName || (scope !== DEVICE_CONSENT_SCOPE && scope !== DEVICE_CONSENT_SCOPE_FULL_FS)) {
      return err(400, `Body must be { agentName, scope: '${DEVICE_CONSENT_SCOPE}' | '${DEVICE_CONSENT_SCOPE_FULL_FS}' }`);
    }
    const result = await stub.setDeviceConsentScope(OWNER_SESSION, agentName, decodeURIComponent(consentMatch[1]), scope);
    if (!result.ok) return err(400, 'consent scope not updated');
    return json({ ok: true });
  }

  // ── Credentials ────────────────────────────────────────────────────
  if (path === '/credentials' && method === 'GET') {
    return json(await stub.listCredentials(OWNER_SESSION));
  }
  const credMatch = path.match(/^\/credentials\/([^/]+)$/);
  if (credMatch) {
    const key = decodeURIComponent(credMatch[1]);
    if (method === 'POST') {
      const body = await safeJson(request);
      if (body === null) return err(400, 'Body must be JSON');
      try { await stub.setCredential(OWNER_SESSION, key, body); }
      catch (e) { return err(400, (e as Error).message); }
      notifyWorkspacesCredentialsChanged(env, stub, ctx);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      try { await stub.deleteCredential(OWNER_SESSION, key); }
      catch (e) { return err(400, (e as Error).message); }
      notifyWorkspacesCredentialsChanged(env, stub, ctx);
      return json({ ok: true });
    }
  }

  // ── Codex device flow ──────────────────────────────────────────────
  if (path === '/codex' && method === 'GET') {
    return json(await stub.getCodexStatus(OWNER_SESSION));
  }
  if (path === '/codex' && method === 'DELETE') {
    await stub.disconnectCodex(OWNER_SESSION);
    notifyWorkspacesCredentialsChanged(env, stub, ctx);
    return json({ ok: true });
  }
  if (path === '/codex/start' && method === 'POST') {
    try { return json(await stub.startCodexDeviceFlow(OWNER_SESSION)); }
    catch (e) { return err(502, (e as Error).message); }
  }
  if (path === '/codex/poll' && method === 'POST') {
    try {
      const status = await stub.pollCodexDeviceFlow(OWNER_SESSION);
      if (status.connected) notifyWorkspacesCredentialsChanged(env, stub, ctx);
      return json(status);
    } catch (e) { return err(502, (e as Error).message); }
  }

  // ── Config (defaults) ──────────────────────────────────────────────
  if (path === '/config' && method === 'GET') {
    return json(await stub.listConfig(OWNER_SESSION));
  }
  const cfgMatch = path.match(/^\/config\/([^/]+)$/);
  if (cfgMatch) {
    const key = decodeURIComponent(cfgMatch[1]);
    if (method === 'GET') {
      return json({ key, value: await stub.getConfig(OWNER_SESSION, key) });
    }
    if (method === 'PUT') {
      const body = await safeJson<{ value?: string }>(request);
      if (!body || typeof body.value !== 'string') return err(400, 'value (string) required');
      await stub.setConfig(OWNER_SESSION, key, body.value);
      return json({ ok: true });
    }
  }

  // ── Models + providers ─────────────────────────────────────────────
  if (path === '/providers' && method === 'GET') {
    return json(await stub.listConnectedProviders(OWNER_SESSION));
  }
  if (path === '/providers/catalog' && method === 'GET') {
    return json(await listProviderCatalog(env, identity.userId, OWNER_SESSION));
  }
  if (path === '/models' && method === 'GET') {
    return json(await listAvailableModels(env, identity.userId, OWNER_SESSION));
  }

  // ── Cloudflare AI Gateway (the user's own gateway) ──────────────────
  if (path === '/cloudflare/gateways' && method === 'GET') {
    return json(await stub.listAIGateways(OWNER_SESSION));
  }
  if (path === '/cloudflare/gateway' && method === 'PUT') {
    const body = await safeJson<{ id?: string | null }>(request);
    if (!body || (body.id !== null && typeof body.id !== 'string')) {
      return err(400, 'id (string | null) required');
    }
    try { await stub.selectAIGateway(OWNER_SESSION, body.id); }
    catch (e) { return err(400, (e as Error).message); }
    notifyWorkspacesCredentialsChanged(env, stub, ctx);
    return json({ ok: true });
  }

  // ── MCP servers ────────────────────────────────────────────────────
  if (path === '/mcp/servers' && method === 'GET') {
    try { return json(await stub.userMcp_list(OWNER_SESSION)); }
    catch (e) { return err(500, (e as Error).message); }
  }
  if (path === '/mcp/servers' && method === 'POST') {
    const body = await safeJson(request);
    if (body === null) return err(400, 'Body must be JSON');
    const origin = publicOrigin(request);
    try { return json(await stub.userMcp_add(OWNER_SESSION, body, origin), { status: 201 }); }
    catch (e) { return err(400, (e as Error).message); }
  }
  const mcpIdMatch = path.match(/^\/mcp\/servers\/([^/]+)$/);
  if (mcpIdMatch) {
    const id = decodeURIComponent(mcpIdMatch[1]);
    if (method === 'DELETE') {
      try { await stub.userMcp_remove(OWNER_SESSION, id); return json({ ok: true }); }
      catch (e) { return err(400, (e as Error).message); }
    }
    if (method === 'PATCH') {
      const body = await safeJson(request);
      if (body === null) return err(400, 'Body must be JSON');
      try { await stub.userMcp_update(OWNER_SESSION, id, body); return json({ ok: true }); }
      catch (e) { return err(400, (e as Error).message); }
    }
  }
  if (path === '/mcp/callback' && method === 'GET') {
    // The OAuth provider stamps `<nonce>.<serverId>` in `state`; we don't
    // need to extract it here — `userMcp_handleOAuthCallback` does the validation
    // inside UserDO. The Worker's browser auth middleware (above) already
    // resolved the caller's identity, so we know which UserDO to dispatch to.
    const result = await stub.userMcp_handleOAuthCallback(OWNER_SESSION, request.url);
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
