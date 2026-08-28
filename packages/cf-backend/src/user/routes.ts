/**
 * `/api/user/*` HTTP routes. All operations are user-scoped — the auth
 * middleware resolves the caller's Kinu `userId` before any of these
 * handlers run.
 *
 * Routes:
 *   GET    /api/user/profile                       — user info
 *   GET    /api/user/profile-catalog               — the account's role/tier catalog envelope
 *   PUT    /api/user/profile-catalog               — compare-and-swap update ({ catalog, expectedVersion })
 *   GET    /api/user/cli                           — CLI setup commands
 *   GET    /api/user/workspaces                    — agent roster page (?cursor=&limit=, nextCursor walks)
 *   POST   /api/user/workspaces                    — register new agent
 *   POST   /api/user/workspaces/:name/touch        — update last_visited
 *   DELETE /api/user/workspaces/:name              — remove from registry
 *   GET    /api/user/credentials                   — key/kind/timestamps only; no secret is readable back
 *   POST   /api/user/credentials/:key              — set
 *   DELETE /api/user/credentials/:key              — delete
 *   PATCH  /api/user/devices/:id                   — rename a device (the name every surface shows)
 *   GET    /api/user/devices/consents              — per-(workspace, device) grants
 *   PUT    /api/user/devices/:id/consent           — set a workspace's consent tier on a device
 *   DELETE /api/user/devices/:id/consent           — revoke a workspace's grant on a device
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
 *   GET    /api/user/cloudflare/accounts           — accounts this login can see + selection
 *   PUT    /api/user/cloudflare/account            — pick which account serves Workers AI
 *   GET    /api/user/cloudflare/gateways           — the user's AI Gateways + selection
 *   PUT    /api/user/cloudflare/gateway            — select an AI Gateway (or null)
 *   GET    /api/user/mcp/servers                   — list configured MCP servers
 *   POST   /api/user/mcp/servers                   — add a new MCP server
 *   DELETE /api/user/mcp/servers/:id               — remove an MCP server
 *   PATCH  /api/user/mcp/servers/:id               — edit name / headers / allowed_tools
 *   GET    /api/user/mcp/callback                  — OAuth 2.1 redirect handler
 */
import type { AuthIdentity } from '../auth/session';
import type { UserDO } from './user-do';
import { PROFILE_CATALOG_CONFIG_KEY } from './schema';
import { DEVICE_CONSENT_SCOPE, DEVICE_CONSENT_SCOPE_FULL_FS, JsonValueSchema } from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { buildCliAuthCommand, buildCliInstallCommand, buildCliSetupCommand, normalizeCliOrigin } from '../cli/install-command';
import { listAvailableModels, listProviderCatalog } from './available-models';
import { handleCreateWorkspaceRequest, notifyWorkspacesCredentialsChanged } from './workspace-access';
import { err, json, safeJson } from '../lib/http';
import { retryTransientDO } from '../lib/do-rpc';
import { OwnerCapabilityUnavailableError, ownerCaller, type UserCaller } from './workspace-capability';
import { authorizeAdmin } from '../control-plane/admin-caller';
import * as v from 'valibot';

const OptionalLabelSchema = v.object({ label: v.optional(v.string()) });

function getUserDOStub(env: Env, userId: string): DurableObjectStub<UserDO> {
  return env.UserDO.get(env.UserDO.idFromName(userId));
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

  let owner: UserCaller;
  try { owner = await ownerCaller(env); }
  catch (e) {
    // Same answer the CLI plane gives: a deployment with no root secret cannot
    // authorize anything for the owner, and should say which secret.
    if (e instanceof OwnerCapabilityUnavailableError) return err(503, e.message);
    throw e;
  }

  const stub = getUserDOStub(env, identity.userId);
  // Bootstrap profile on every request — cheap UPDATE if exists, INSERT once.
  // It is also the gate every /api/user route passes through, so a dropped
  // connection here fails a request that had nothing wrong with it; the upsert
  // converges to the same row however many times it runs.
  await retryTransientDO('ensureProfile',
    () => stub.ensureProfile(owner, identity.email, identity.displayName ?? undefined));

  // First hit for this user in this isolate: warm MCP, and repair workspaces that
  // predate the capability boundary. Both are one-shot per user inside the UserDO
  // — a workspace runs on an alarm, an inbound email or a peer's task without
  // anyone opening it, so waiting for a human to visit each one would fail those
  // turns.
  //
  // `ctx` here is the WORKER's ExecutionContext, so waitUntil is the right call:
  // it is a no-op only inside a Durable Object (`do.wait_until.no_op`). What was
  // wrong is what these two did with their failures. Both settlements were
  // discarded by `.then(() => {}, () => {})`, so a capability repair that threw
  // on every request left no trace anywhere — and the user was marked warmed
  // regardless, which recorded a repair that had not happened.
  if (ctx && !warmedMcpUsers.has(identity.userId)) {
    warmedMcpUsers.add(identity.userId);
    const caller = await ownerCaller(env);
    const reportBootstrapFailure = (step: string) => <Thrown,>(thrown: Thrown): void => {
      warmedMcpUsers.delete(identity.userId);
      diagnostics.failure('user.bootstrap_failed', toKinuError({
        doing: 'bootstrapping the user on first hit in this isolate',
        cause: thrown,
        otherwise: 'unavailable',
      }), { step, userId: identity.userId });
    };
    ctx.waitUntil(stub.userMcp_warmConnections(caller).catch(reportBootstrapFailure('mcp_warm')));
  }

  // ── Profile ────────────────────────────────────────────────────────
  if (path === '/profile' && method === 'GET') {
    const profile = await stub.getProfile(await ownerCaller(env));
    // Whether this session may reach the admin control plane, decided by the
    // SAME function that guards `/api/control/*` rather than by a second reading
    // of the allowlist — so the nav entry and the gate cannot disagree, and the
    // link is absent for everyone the gate would 404. It is not authorization:
    // the gate answers for itself on every request.
    const controlPlane = authorizeAdmin(env, identity, { mutating: false }).ok;
    return json(profile === null ? null : { ...profile, controlPlane });
  }

  // ── Profile catalog (account authority over roles + tiers) ──────────
  if (path === '/profile-catalog' && method === 'GET') {
    return json(await stub.getProfileCatalog(owner));
  }
  if (path === '/profile-catalog' && method === 'PUT') {
    const body = await safeJson(request, v.object({
      catalog: JsonValueSchema,
      expectedVersion: v.number(),
    }));
    if (!body) return err(400, 'Body must be { catalog, expectedVersion }.');
    const result = await stub.putProfileCatalog(owner, body.catalog, body.expectedVersion);
    if (result.ok) return json(result.envelope);
    if (result.kind === 'conflict') {
      return json({
        error: `Version conflict: the stored catalog is at version ${result.currentVersion}.`,
        currentVersion: result.currentVersion,
        currentDigest: result.currentDigest,
      }, { status: 409 });
    }
    return err(400, result.reason);
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
    const cursor = url.searchParams.get('cursor');
    const limitRaw = url.searchParams.get('limit');
    return json(await stub.listWorkspaces(owner, {
      cursor,
      limit: limitRaw === null ? undefined : Number(limitRaw),
    }));
  }
  if (path === '/workspaces' && method === 'POST') {
    return handleCreateWorkspaceRequest(request, env, identity.userId, stub, ctx);
  }
  const agentTouchMatch = path.match(/^\/workspaces\/([^/]+)\/touch$/);
  if (agentTouchMatch && method === 'POST') {
    try { await stub.touchWorkspace(await ownerCaller(env), decodeURIComponent(agentTouchMatch[1])); return json({ ok: true }); }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }
  }
  const agentMatch = path.match(/^\/workspaces\/([^/]+)$/);
  if (agentMatch && method === 'DELETE') {
    try { await stub.removeWorkspace(await ownerCaller(env), decodeURIComponent(agentMatch[1]), identity.userId); return json({ ok: true }); }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }
  }

  // ── Devices (user-level laptop/PC tunnel) ──────────────────────────
  if (path === '/devices' && method === 'GET') {
    return json(await stub.listDevices(await ownerCaller(env)));
  }
  if (path === '/devices' && method === 'POST') {
    const body = await safeJson(request, OptionalLabelSchema);
    const cliOrigin = normalizeCliOrigin(env.CLI_PUBLIC_ORIGIN || url.origin);
    const installCommand = buildCliInstallCommand({
      origin: cliOrigin,
      setup: false,
      connect: true,
      label: body?.label,
    });
    return json({ origin: cliOrigin, installCommand }, { status: 201 });
  }
  const deviceAcknowledgeMatch = path.match(/^\/devices\/([^/]+)\/unstopped$/);
  if (deviceAcknowledgeMatch && method === 'DELETE') {
    try {
      const result = await stub.acknowledgeUnstoppedDevice(await ownerCaller(env), decodeURIComponent(deviceAcknowledgeMatch[1]));
      if (!result.ok) return err(404, 'No unconfirmed command incident matched this revoked device');
      return json({ ok: true });
    } catch (e) {
      return err(400, renderThrownChain({ cause: e }));
    }
  }
  const deviceMatch = path.match(/^\/devices\/([^/]+)$/);
  if (deviceMatch && method === 'DELETE') {
    try {
      const result = await stub.revokeDevice(await ownerCaller(env), decodeURIComponent(deviceMatch[1]));
      return json(result);
    } catch (e) {
      return err(400, renderThrownChain({ cause: e }));
    }
  }
  if (deviceMatch && method === 'PATCH') {
    const body = await safeJson(request, v.object({ name: v.optional(v.string()) }));
    const name = body?.name?.trim();
    if (!name) return err(400, 'Body must be { name }');
    const result = await stub.renameDevice(await ownerCaller(env), decodeURIComponent(deviceMatch[1]), name);
    if (!result.ok) return err(404, 'device not found');
    return json({ ok: true });
  }

  // ── Device grants (per-(workspace, device): may this workspace act, and how
  //    far into the filesystem) ─────────────────────────────────────────────
  if (path === '/devices/consents' && method === 'GET') {
    return json(await stub.listDeviceConsents(await ownerCaller(env)));
  }
  const consentMatch = path.match(/^\/devices\/([^/]+)\/consent$/);
  if (consentMatch && method === 'PUT') {
    const body = await safeJson(request, v.object({
      agentName: v.optional(v.string()),
      scope: v.optional(v.string()),
    }));
    const agentName = body?.agentName;
    const scope = body?.scope;
    if (!agentName || (scope !== DEVICE_CONSENT_SCOPE && scope !== DEVICE_CONSENT_SCOPE_FULL_FS)) {
      return err(400, `Body must be { agentName, scope: '${DEVICE_CONSENT_SCOPE}' | '${DEVICE_CONSENT_SCOPE_FULL_FS}' }`);
    }
    const result = await stub.setDeviceConsentScope(await ownerCaller(env), agentName, decodeURIComponent(consentMatch[1]), scope);
    if (!result.ok) return err(400, 'consent scope not updated');
    return json({ ok: true });
  }
  if (consentMatch && method === 'DELETE') {
    const agentName = url.searchParams.get('agentName')?.trim();
    if (!agentName) return err(400, 'Query must carry ?agentName=');
    const result = await stub.revokeDeviceConsent(
      await ownerCaller(env), agentName, decodeURIComponent(consentMatch[1]),
    );
    if (!result.ok) return err(400, 'grant not revoked');
    return json({ ok: true });
  }

  // ── Credentials ────────────────────────────────────────────────────
  if (path === '/credentials' && method === 'GET') {
    return json(await stub.listCredentials(await ownerCaller(env)));
  }
  const credMatch = path.match(/^\/credentials\/([^/]+)$/);
  if (credMatch) {
    const key = decodeURIComponent(credMatch[1]);
    if (method === 'POST') {
      const body = await safeJson(request, JsonValueSchema);
      if (body === null) return err(400, 'Body must be JSON');
      try { await stub.setCredential(await ownerCaller(env), key, body); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }
      notifyWorkspacesCredentialsChanged(env, stub, ctx);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      try { await stub.deleteCredential(await ownerCaller(env), key); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }
      notifyWorkspacesCredentialsChanged(env, stub, ctx);
      return json({ ok: true });
    }
  }

  // ── Codex device flow ──────────────────────────────────────────────
  if (path === '/codex' && method === 'GET') {
    return json(await stub.getCodexStatus(await ownerCaller(env)));
  }
  if (path === '/codex' && method === 'DELETE') {
    await stub.disconnectCodex(await ownerCaller(env));
    notifyWorkspacesCredentialsChanged(env, stub, ctx);
    return json({ ok: true });
  }
  if (path === '/codex/start' && method === 'POST') {
    try { return json(await stub.startCodexDeviceFlow(await ownerCaller(env))); }
    catch (e) { return err(502, renderThrownChain({ cause: e })); }
  }
  if (path === '/codex/poll' && method === 'POST') {
    try {
      const status = await stub.pollCodexDeviceFlow(await ownerCaller(env));
      if (status.connected) notifyWorkspacesCredentialsChanged(env, stub, ctx);
      return json(status);
    } catch (e) { return err(502, renderThrownChain({ cause: e })); }
  }

  // ── Config (defaults) ──────────────────────────────────────────────
  if (path === '/config' && method === 'GET') {
    return json(await stub.listConfig(await ownerCaller(env)));
  }
  const cfgMatch = path.match(/^\/config\/([^/]+)$/);
  if (cfgMatch) {
    const key = decodeURIComponent(cfgMatch[1]);
    if (key === PROFILE_CATALOG_CONFIG_KEY) {
      return err(400, 'Profile catalogs use /api/user/profile-catalog.');
    }
    if (method === 'GET') {
      return json({ key, value: await stub.getConfig(await ownerCaller(env), key) });
    }
    if (method === 'PUT') {
      const body = await safeJson(request, v.object({ value: v.string() }));
      if (!body) return err(400, 'value (string) required');
      await stub.setConfig(await ownerCaller(env), key, body.value);
      return json({ ok: true });
    }
  }

  // ── Models + providers ─────────────────────────────────────────────
  if (path === '/providers' && method === 'GET') {
    return json(await stub.listConnectedProviders(await ownerCaller(env)));
  }
  if (path === '/providers/catalog' && method === 'GET') {
    return json(await listProviderCatalog(env, identity.userId, await ownerCaller(env)));
  }
  if (path === '/models' && method === 'GET') {
    return json(await listAvailableModels(env, identity.userId, await ownerCaller(env)));
  }

  // ── Cloudflare account (which account serves Workers AI) ────────────
  if (path === '/cloudflare/accounts' && method === 'GET') {
    return json(await stub.listCloudflareAccounts(await ownerCaller(env)));
  }
  if (path === '/cloudflare/account' && method === 'PUT') {
    const body = await safeJson(request, v.object({ id: v.string() }));
    if (!body) return err(400, 'id (string) required');
    try { await stub.selectCloudflareAccount(await ownerCaller(env), body.id); }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }
    notifyWorkspacesCredentialsChanged(env, stub, ctx);
    return json({ ok: true });
  }

  // ── Cloudflare AI Gateway (the user's own gateway) ──────────────────
  if (path === '/cloudflare/gateways' && method === 'GET') {
    return json(await stub.listAIGateways(await ownerCaller(env)));
  }
  if (path === '/cloudflare/gateway' && method === 'PUT') {
    const body = await safeJson(request, v.object({ id: v.nullable(v.string()) }));
    if (!body) {
      return err(400, 'id (string | null) required');
    }
    try { await stub.selectAIGateway(await ownerCaller(env), body.id); }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }
    notifyWorkspacesCredentialsChanged(env, stub, ctx);
    return json({ ok: true });
  }

  // ── MCP servers ────────────────────────────────────────────────────
  if (path === '/mcp/servers' && method === 'GET') {
    try { return json(await stub.userMcp_list(await ownerCaller(env))); }
    catch (e) { return err(500, renderThrownChain({ cause: e })); }
  }
  if (path === '/mcp/servers' && method === 'POST') {
    const body = await safeJson(request, JsonValueSchema);
    if (body === null) return err(400, 'Body must be JSON');
    const origin = publicOrigin(request);
    try { return json(await stub.userMcp_add(await ownerCaller(env), body, origin), { status: 201 }); }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }
  }
  const mcpIdMatch = path.match(/^\/mcp\/servers\/([^/]+)$/);
  if (mcpIdMatch) {
    const id = decodeURIComponent(mcpIdMatch[1]);
    if (method === 'DELETE') {
      try { await stub.userMcp_remove(await ownerCaller(env), id); return json({ ok: true }); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }
    }
    if (method === 'PATCH') {
      const body = await safeJson(request, JsonValueSchema);
      if (body === null) return err(400, 'Body must be JSON');
      try { await stub.userMcp_update(await ownerCaller(env), id, body); return json({ ok: true }); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }
    }
  }
  if (path === '/mcp/callback' && method === 'GET') {
    // The OAuth provider stamps `<nonce>.<serverId>` in `state`; we don't
    // need to extract it here — `userMcp_handleOAuthCallback` does the validation
    // inside UserDO. The Worker's browser auth middleware (above) already
    // resolved the caller's identity, so we know which UserDO to dispatch to.
    const result = await stub.userMcp_handleOAuthCallback(await ownerCaller(env), request.url);
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
