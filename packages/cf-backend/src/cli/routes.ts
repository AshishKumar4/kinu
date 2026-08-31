import { JsonValueSchema, ORCHESTRATOR_AGENT_SLUG, USER_AI_PROXY_PATH, timingSafeEqual, type JsonValue } from '@kinu.run/core';
import type { AuthIdentity } from '../auth/session';
import { AuthError, authenticateRequest, isFreshAuthTime } from '../auth/session';
import { publicHtmlHeaders } from '../lib/security-headers';
import { approvalDocument, installDocument } from '../lib/public-pages';
import {
  CLI_SOURCE_TARBALL_PATH, CLI_SOURCE_TARBALL_SHA256_PATH, CLI_VERSION_PATH, fetchDeployedAsset,
} from '../lib/deployed-assets';
import { err, escapeHtml, json, safeJson } from '../lib/http';
import { randomToken } from '../lib/crypto';
import type { OrchestratorAgent } from '../orchestrator';
import { webhookRouteSecret, WEBHOOK_ROUTE_UNAVAILABLE } from '../events/webhook-route';
import {
  CliAuthCodeError, RateLimitError, approveCliAuth, authenticateCliToken,
  inspectCliAuth, pollCliAuth, startCliAuth, tokenAllows, type CliTokenIdentity,
} from './auth-store';
import { ACCESS_TOKEN_SCOPES, type AccessTokenScope } from './access-token-store';
import { isAgentRpcMethod, requiredRpcAccess, rpcAccessScope } from './rpc-gate';
import { buildCliInstallCommand } from './install-command';
import { bunResolutionShell } from './bun-runtime';
import { listAvailableModels } from '../user/available-models';
import { handleCreateWorkspaceRequest, notifyWorkspacesCredentialsChanged } from '../user/workspace-access';
import { handleUserAIProxyRequest } from '../user/ai-proxy';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { USER_AI_PROXY_FORWARD_PREFIX, handleUserProviderProxyRequest } from '../user/provider-proxy';
import { OwnerCapabilityUnavailableError, ownerCaller } from '../user/workspace-capability';
import * as v from 'valibot';
import { classify, renderThrownChain } from '@kinu.run/core/obs';

const OptionalLabelSchema = v.object({ label: v.optional(v.string()) });
const WebhookRequestSchema = v.object({
  label: v.optional(v.string()),
  auth_mode: v.optional(v.picklist(['hmac', 'bearer', 'mtls'])),
  secret: v.optional(v.string()),
  accepted_content_type: v.optional(v.string()),
  rate_limit_per_min: v.optional(v.number()),
});

export async function handleCliRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === '/install' && (method === 'GET' || method === 'HEAD')) {
    return method === 'HEAD' ? new Response(null, installPageInit()) : installPageResponse(url.origin);
  }
  if (url.pathname === '/install.sh' && (method === 'GET' || method === 'HEAD')) {
    return installScriptResponse(url.origin, method === 'HEAD');
  }
  if (url.pathname === '/downloads/kinu' && (method === 'GET' || method === 'HEAD')) {
    return cliShimResponse(url.origin, method === 'HEAD');
  }
  if (url.pathname === CLI_SOURCE_TARBALL_PATH && (method === 'GET' || method === 'HEAD')) {
    return cliDownloadAssetResponse(request, env, CLI_SOURCE_TARBALL_PATH, 'application/gzip', method === 'HEAD');
  }
  if (url.pathname === CLI_SOURCE_TARBALL_SHA256_PATH && (method === 'GET' || method === 'HEAD')) {
    return cliDownloadAssetResponse(request, env, CLI_SOURCE_TARBALL_SHA256_PATH, 'text/plain; charset=utf-8', method === 'HEAD');
  }
  if (url.pathname === CLI_VERSION_PATH && (method === 'GET' || method === 'HEAD')) {
    return cliDownloadAssetResponse(request, env, CLI_VERSION_PATH, 'application/json; charset=utf-8', method === 'HEAD');
  }

  if (url.pathname === '/cli/auth' && method === 'GET') {
    return renderBrowserApproval(request, env);
  }
  if (url.pathname === '/cli/auth' && method === 'POST') {
    return approveFromBrowser(request, env);
  }

  // The signed-in AI proxies are CLI-bearer-authenticated (never browser
  // cookies), so their gate lives here even though the path is /api/user/…:
  // session tokens pass, scoped access tokens need ai.proxy. Both the
  // Cloudflare-pinned proxy and the general provider proxy spend the owner's
  // inference credentials, so they share one scope.
  const aiProxy = url.pathname.startsWith(`${USER_AI_PROXY_PATH}/`);
  const providerProxy = url.pathname.startsWith(`${USER_AI_PROXY_FORWARD_PREFIX}/`);
  if (aiProxy || providerProxy) {
    const cli = await authenticateCli(request, env);
    if (cli instanceof Response) return cli;
    if (cli.kind === 'access' && !tokenAllows(cli, 'ai.proxy')) {
      return err(403, 'This access token does not have the ai.proxy scope.');
    }
    return aiProxy
      ? handleUserAIProxyRequest(request, env, cli)
      : handleUserProviderProxyRequest(request, env, cli);
  }

  if (!url.pathname.startsWith('/api/cli')) return null;
  const path = url.pathname.slice('/api/cli'.length) || '/';

  if (path === '/auth/start' && method === 'POST') {
    const body = await safeJson(request, v.object({ deviceName: v.optional(v.string()) }));
    try {
      return json(await startCliAuth(env, url.origin, approvalOrigin(env, url), body?.deviceName, clientKey(request)));
    } catch (e) {
      return cliAuthError(toError(e));
    }
  }

  if (path === '/auth/poll' && method === 'POST') {
    const body = await safeJson(request, v.object({ deviceToken: v.optional(v.string()) }));
    if (!body?.deviceToken) return err(400, 'deviceToken required');
    try {
      return json(await pollCliAuth(env, body.deviceToken, clientKey(request)));
    } catch (e) {
      return cliAuthError(toError(e));
    }
  }

  // There is deliberately NO JSON approval route beside the browser form above.
  // Approval is the one step of the device flow that spends the AMBIENT session
  // cookie, and this whole module is dispatched before server.ts's CSRF gate so
  // that bearer-token clients are never asked for an `Origin`. A cookie-only
  // JSON POST here was therefore reachable from any same-site page with a known
  // user code, and what it minted was an unrestricted CLI token for that user.
  // The form flow is the approval path: same-origin, double-submit, and the
  // only URL `startCliAuth` ever publishes.

  const cli = await authenticateCli(request, env);
  if (cli instanceof Response) return cli;

  // The generic agent RPC endpoint carries its own per-method policy (the
  // AGENT_RPC_ACCESS table), so it is matched ahead of the route-shaped
  // access-token gate.
  const rpcMatch = path.match(/^\/workspaces\/([^/]+)\/rpc$/);
  if (rpcMatch && method === 'POST') {
    return handleAgentRpc(request, env, cli, decodeURIComponent(rpcMatch[1]));
  }

  const denied = accessTokenDenial(cli, method, path);
  if (denied) return denied;

  if (path === '/me' && method === 'GET') {
    return json({
      user: { id: cli.userId, email: cli.email, displayName: cli.displayName },
      tokenHash: cli.tokenHash,
      token: { kind: cli.kind, scopes: cli.scopes === 'all' ? 'all' : cli.scopes },
    });
  }

  if (path === '/logout' && method === 'POST') {
    await cli.userDO.revokeCliTokenHash(await ownerCaller(env), cli.tokenHash);
    return json({ ok: true });
  }

  // ── Session inventory — the recovery surface for an orphaned bearer ──
  // A logout whose remote revocation never landed (or a token copied off a
  // lost machine) left a live 180-day bearer with nothing able to name it,
  // because the server stores only its hash and the raw token was gone. These
  // routes let a re-authenticated owner enumerate what is still live and end
  // any of it — by the hash the inventory prints, or all of it at once.
  // Interactive sessions only, like every other account-management surface.
  if (path === '/sessions' && method === 'GET') {
    return json({ sessions: await cli.userDO.listCliTokens(await ownerCaller(env)) });
  }
  if (path === '/sessions' && method === 'DELETE') {
    const result = await cli.userDO.revokeAllCliTokens(await ownerCaller(env));
    return json({ ok: true, revoked: result.revoked });
  }
  const sessionRevokeMatch = path.match(/^\/sessions\/([a-f0-9]{64})$/);
  if (sessionRevokeMatch && method === 'DELETE') {
    await cli.userDO.revokeCliTokenHash(await ownerCaller(env), sessionRevokeMatch[1]);
    return json({ ok: true });
  }

  // ── Profile catalog — interactive owner session only. The route gate
  // blocks scoped tokens; the UserDO separately blocks workspace callers. ──
  if (path === '/profile' && method === 'GET') {
    return json(await cli.userDO.getProfileCatalog(await ownerCaller(env)));
  }
  if (path === '/profile' && method === 'PUT') {
    const body = await safeJson(request, v.object({
      catalog: JsonValueSchema,
      expectedVersion: v.number(),
    }));
    if (!body) return err(400, 'Body must be { catalog, expectedVersion }.');
    const result = await cli.userDO.putProfileCatalog(
      await ownerCaller(env), body.catalog, body.expectedVersion,
    );
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

  // ── CI access tokens — interactive-session-only management surface ──
  if (path === '/tokens' && method === 'GET') {
    return json({ tokens: await cli.userDO.listAccessTokens(await ownerCaller(env)) });
  }

  if (path === '/tokens' && method === 'POST') {
    // Minting a long-lived credential is step-up gated exactly like webhook
    // creation: the session token itself must come from a fresh `kinu auth`.
    if (!isFreshAuthTime(await sessionTokenMintedAt(env, cli))) {
      return err(401, 'step-up auth required: run `kinu auth` again. Minting access tokens needs a sign-in within the last 5 minutes.');
    }
    const body = await safeJson(request, v.object({
      name: v.optional(v.string()),
      scopes: v.optional(v.array(v.string())),
    }));
    if (!body?.name?.trim() || !Array.isArray(body.scopes)) {
      return err(400, `name and scopes required (valid scopes: ${ACCESS_TOKEN_SCOPES.join(', ')})`);
    }
    const minted = await cli.userDO.mintAccessToken(await ownerCaller(env), cli.userId, body.name, body.scopes);
    if (!minted.ok) return err(400, minted.error);
    return json({
      token: minted.token,
      name: minted.record.name,
      scopes: minted.record.scopes,
      createdAt: minted.record.createdAt,
    }, { status: 201 });
  }

  const tokenRevokeMatch = path.match(/^\/tokens\/([^/]+)$/);
  if (tokenRevokeMatch && method === 'DELETE') {
    const ref = decodeURIComponent(tokenRevokeMatch[1]);
    const result = await cli.userDO.revokeAccessToken(await ownerCaller(env), ref);
    if (!result.revoked) return err(404, `No active access token matched "${ref}".`);
    return json({ ok: true });
  }

  if (path === '/workspaces' && method === 'GET') {
    return json(await cli.userDO.listActiveWorkspaces(await ownerCaller(env)));
  }

  if (path === '/models' && method === 'GET') {
    return json(await listAvailableModels(env, cli.userId, await ownerCaller(env)));
  }

  if (path === '/workspaces' && method === 'POST') {
    return handleCreateWorkspaceRequest(request, env, cli.userId, cli.userDO, ctx);
  }

  const workspaceMatch = path.match(/^\/workspaces\/([^/]+)$/);
  if (workspaceMatch && method === 'DELETE') {
    try {
      const name = decodeURIComponent(workspaceMatch[1]);
      if (!(await cli.userDO.hasWorkspace(await ownerCaller(env), name))) return err(404, `Agent ${name} not found.`);
      await cli.userDO.removeWorkspace(await ownerCaller(env), name, cli.userId);
      return json({ ok: true });
    } catch (e) {
      return err(400, renderThrownChain({ cause: e }));
    }
  }

  const connectTicketMatch = path.match(/^\/workspaces\/([^/]+)\/connect-ticket$/);
  if (connectTicketMatch && method === 'POST') {
    const name = decodeURIComponent(connectTicketMatch[1]);
    if (!(await cli.userDO.hasWorkspace(await ownerCaller(env), name))) return err(404, `Agent ${name} not found.`);
    const issued = await cli.userDO.issueCliAgentConnectTicket(await ownerCaller(env), {
      userId: cli.userId,
      agentClass: ORCHESTRATOR_AGENT_SLUG,
      agentName: name,
      cliTokenHash: cli.tokenHash,
      capabilities: ['agent.websocket'],
    });
    if (!issued.ok || !issued.ticket || !issued.expiresAt) return err(403, issued.error ?? 'Could not issue connect ticket.');
    return json({ ticket: issued.ticket, expiresAt: issued.expiresAt });
  }

  const webhookTriggerMatch = path.match(/^\/workspaces\/([^/]+)\/triggers\/webhook$/);
  if (webhookTriggerMatch && method === 'POST') {
    const agent = await cliAgent(env, cli, decodeURIComponent(webhookTriggerMatch[1]));
    if (agent instanceof Response) return agent;
    // Webhook creation is step-up gated on every path. The CLI's
    // interactive-auth timestamp is its token mint time (minting requires
    // a live browser approval), so a fresh `kinu auth` satisfies it.
    if (!isFreshAuthTime(await sessionTokenMintedAt(env, cli))) {
      return err(401, 'step-up auth required: run `kinu auth` again. Webhook creation needs a sign-in within the last 5 minutes.');
    }
    // Same rule the web route states: a webhook whose delivery URL cannot be
    // signed is a row nobody can deliver to.
    if (webhookRouteSecret(env) === null) return err(503, WEBHOOK_ROUTE_UNAVAILABLE);
    const body = await safeJson(request, WebhookRequestSchema);
    if (!body?.label || !body.auth_mode) return err(400, 'label and auth_mode required');
    try {
      return json(await agent.createDurableWebhook({
        label: body.label,
        auth_mode: body.auth_mode,
        secret: body.secret,
        accepted_content_type: body.accepted_content_type,
        rate_limit_per_min: body.rate_limit_per_min,
      }), { status: 201 });
    } catch (e) {
      return err(400, renderThrownChain({ cause: e }));
    }
  }

  if (path === '/devices' && method === 'GET') {
    return json(await cli.userDO.listDevices(await ownerCaller(env)));
  }
  if (path === '/devices' && method === 'POST') {
    const body = await safeJson(request, OptionalLabelSchema);
    const { deviceId, token } = await cli.userDO.registerDevice(await ownerCaller(env), body?.label);
    return json({ deviceId, token, userId: cli.userId, origin: url.origin }, { status: 201 });
  }

  // Provider credentials. Interactive sessions only (the default-deny gate
  // above stops `pta_` tokens): a CI token that could write a provider key
  // could also swap the account's inference credentials. Reading back a
  // secret is not offered here for the same reason it is not offered in the
  // browser — once submitted, a secret is not viewable again.
  if (path === '/credentials' && method === 'GET') {
    return json(await cli.userDO.listCredentials(await ownerCaller(env)));
  }
  const cliCredMatch = path.match(/^\/credentials\/([^/]+)$/);
  if (cliCredMatch) {
    const key = decodeURIComponent(cliCredMatch[1]);
    if (method === 'POST') {
      const body = await safeJson(request, JsonValueSchema);
      try { await cli.userDO.setCredential(await ownerCaller(env), key, body); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }
      // The same mutation path the browser routes run: the authoritative write
      // is done, so the workspaces holding caches of the OLD state are told to
      // drop them. The CLI-only gap left a newly connected provider invisible
      // to every live workspace until some unrelated invalidation landed.
      notifyWorkspacesCredentialsChanged(env, cli.userDO, ctx);
      return json({ ok: true }, { status: 201 });
    }
    if (method === 'DELETE') {
      try { await cli.userDO.deleteCredential(await ownerCaller(env), key); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }
      notifyWorkspacesCredentialsChanged(env, cli.userDO, ctx);
      return json({ ok: true });
    }
  }

  return err(404, `No such CLI route: ${method} ${path}`);
}

async function cliAgent(env: Env, cli: CliTokenIdentity, name: string): Promise<DurableObjectStub<OrchestratorAgent> | Response> {
  const result = await claimOwnedWorkspace(env, cli.userId, name);
  if (!result.ok) return err(result.status, result.error);
  return result.agent;
}

/**
 * POST /api/cli/workspaces/:name/rpc — the one method-shaped transport:
 * `{ method: string, args: unknown[] }` dispatched to the named DO method,
 * gated by the AGENT_RPC_ACCESS table (shared verbatim with the websocket
 * frame gate). Table membership is the dispatch allowlist — an off-table
 * method name is never invoked.
 */
async function handleAgentRpc(request: Request, env: Env, cli: CliTokenIdentity, name: string): Promise<Response> {
  const body = await safeJson(request, v.object({
    method: v.string(),
    args: v.optional(v.array(JsonValueSchema)),
  }));
  const rpcMethod = body?.method ?? '';
  if (!rpcMethod) return err(400, 'method required');
  const args = body?.args ?? [];

  if (!isAgentRpcMethod(rpcMethod)) {
    return err(404, `No such agent RPC method: ${rpcMethod}`);
  }
  const access = requiredRpcAccess(rpcMethod);
  if (access === null || access === 'never') {
    return err(404, `No such agent RPC method: ${rpcMethod}`);
  }
  if (cli.kind === 'access') {
    const scope = rpcAccessScope(access);
    if (!scope) return err(403, `${rpcMethod} requires an interactive CLI session token. Sign in with: kinu auth`);
    if (!tokenAllows(cli, scope)) return err(403, `This access token does not have the ${scope} scope.`);
  }

  const agent = await cliAgent(env, cli, name);
  if (agent instanceof Response) return agent;
  // The table check above is the trust boundary: only methods the policy
  // names are ever reached, so the string-indexed dispatch cannot touch
  // anything else on the DO. Args are the method's own responsibility to
  // validate — the same contract as the websocket rpc dispatcher.
  try {
    // SAFETY: The allowlist proves the method exists, and the request schema established JSON arguments.
    const invoke = agent[rpcMethod] as (...values: JsonValue[]) => Promise<JsonValue | undefined>;
    const result = await invoke(...args);
    return json({ result: result === undefined ? null : result });
  } catch (e) {
    // Same contract as a websocket rpc-error frame: the thrown message goes
    // back to the caller as a request-level failure.
    return err(400, renderThrownChain({ cause: e }));
  }
}

/** The CLI's interactive-auth timestamp: the session token's mint time
 *  (minting requires a live browser approval). Step-up gated routes compare
 *  it against the fresh-auth window; access tokens never qualify. */
async function sessionTokenMintedAt(env: Env, cli: CliTokenIdentity): Promise<number | null> {
  if (cli.kind !== 'session') return null;
  const tokens = await cli.userDO.listCliTokens(await ownerCaller(env));
  return tokens.find((t) => t.tokenHash === cli.tokenHash)?.createdAt ?? null;
}

/** Default-deny gate for scoped `pta_…` access tokens on the route-shaped
 *  surface (agent-method calls carry their own per-method policy — the
 *  AGENT_RPC_ACCESS table behind /workspaces/:name/rpc): workspace/model
 *  listing needs workspace.read, connect tickets need workspace.exec, and
 *  everything else — webhook creation, device registration, agent creation,
 *  token management — stays interactive-session-only. Routes added in the
 *  future are interactive-only until listed here. */
function accessTokenDenial(cli: CliTokenIdentity, method: string, path: string): Response | null {
  if (cli.kind !== 'access') return null;
  if (path === '/me' && method === 'GET') return null; // identity introspection works for any valid bearer
  const required = requiredAccessScope(method, path);
  if (!required) {
    return err(403, 'This operation requires an interactive CLI session token. Sign in with: kinu auth');
  }
  if (!tokenAllows(cli, required)) {
    return err(403, `This access token does not have the ${required} scope.`);
  }
  return null;
}

function requiredAccessScope(method: string, path: string): AccessTokenScope | null {
  if (method === 'GET' && (path === '/workspaces' || path === '/models')) return 'workspace.read';
  if (method === 'POST' && /^\/workspaces\/[^/]+\/connect-ticket$/.test(path)) return 'workspace.exec';
  return null;
}

function approvalOrigin(env: Env, url: URL): string {
  return (env.CLI_APPROVAL_ORIGIN || url.origin).replace(/\/+$/, '');
}

function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown';
}

async function authenticateCli(request: Request, env: Env): Promise<CliTokenIdentity | Response> {
  try {
    const result = await authenticateCliToken(request, env);
    return result.ok ? result.identity : err(401, result.error);
  } catch (e) {
    // A deployment with no root secret cannot authorize anything for the
    // owner. Say that, rather than surfacing it as an unexplained 500.
    if (e instanceof OwnerCapabilityUnavailableError) return err(503, e.message);
    throw e;
  }
}

async function renderBrowserApproval(request: Request, env: Env): Promise<Response> {
  let identity: AuthIdentity;
  try { identity = await authenticateRequest(request, env); }
  catch (e) { return accessError(toError(e), request); }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return html('Kinu CLI Auth', '<p>Missing CLI auth code.</p>', 400);
  const requestInfo = await inspectCliAuth(env.AUTH_KV, code);
  if (!requestInfo) {
    return html('Kinu CLI Auth', '<p>Unknown or expired CLI auth code.</p>', 400);
  }
  if (requestInfo.status === 'expired') {
    return html('Kinu CLI Auth', '<p>This CLI auth code expired. Run <code>kinu auth</code> again.</p>', 400);
  }
  if (requestInfo.status === 'approved' || requestInfo.status === 'consumed') {
    return html('Kinu CLI Auth', '<p>This CLI auth request has already been approved. You can return to your terminal.</p>');
  }

  const csrf = randomToken(32);
  const expiresAt = new Date(requestInfo.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return html('Approve Kinu CLI', `
    <p>Sign in this terminal to your Kinu account.</p>
    <dl>
      <div><dt>Terminal</dt><dd>${escapeHtml(requestInfo.deviceName)}</dd></div>
      <div><dt>Code</dt><dd><code>${escapeHtml(requestInfo.userCode)}</code></dd></div>
      <div><dt>Account</dt><dd>${escapeHtml(identity.email)}</dd></div>
      <div><dt>Expires</dt><dd>${escapeHtml(expiresAt)}</dd></div>
    </dl>
    <form method="post" action="/cli/auth">
      <input type="hidden" name="userCode" value="${escapeHtml(requestInfo.userCode)}" />
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
      <button type="submit">Approve CLI</button>
    </form>
    <p class="muted">Only approve this if the code matches the terminal you started.</p>
  `, 200, {
    headers: {
      'set-cookie': csrfCookie(csrf),
      'cache-control': 'no-store',
    },
  });
}

async function approveFromBrowser(request: Request, env: Env): Promise<Response> {
  let identity: AuthIdentity;
  try { identity = await authenticateRequest(request, env); }
  catch (e) { return accessError(toError(e), request); }
  if (!isSameOriginPost(request)) {
    return html('Kinu CLI Auth', '<p>Invalid approval origin.</p>', 403);
  }
  let form: FormData;
  try { form = await request.formData(); }
  catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;
    return html('Kinu CLI Auth', '<p>Invalid approval form.</p>', 400);
  }
  const code = String(form.get('userCode') ?? '');
  const csrf = String(form.get('csrf') ?? '');
  const cookieCsrf = readCookie(request, 'kinu_cli_auth_csrf');
  if (!csrf || !cookieCsrf || !timingSafeEqual(csrf, cookieCsrf)) {
    return html('Kinu CLI Auth', '<p>Invalid or expired approval session. Refresh the approval page and try again.</p>', 403);
  }
  if (!code) return html('Kinu CLI Auth', '<p>Missing CLI auth code.</p>', 400);
  try {
    await approveCliAuth(env, code, identity, clientKey(request));
    return html('Kinu CLI Auth', '<p>CLI connected. You can return to your terminal.</p>', 200, {
      headers: {
        'set-cookie': clearCsrfCookie(),
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return html('Kinu CLI Auth', `<p>${escapeHtml(toError(e).message)}</p>`, 400);
  }
}

function installPageResponse(origin: string): Response {
  return new Response(installDocument(buildCliInstallCommand({ origin })), installPageInit());
}

function installPageInit(): ResponseInit {
  return {
    headers: publicHtmlHeaders(),
  };
}

function installScriptResponse(origin: string, head = false): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail

KINU_ORIGIN="\${KINU_ORIGIN:-${origin}}"
KINU_HOME="\${KINU_HOME:-$HOME/.kinu}"
BIN_DIR="$KINU_HOME/bin"
BIN_PATH="$BIN_DIR/kinu"
PARENT_ACTIVATES="\${KINU_PARENT_ACTIVATES:-0}"
NEEDS_PARENT_ACTIVATION=0
YES=0
NO_SETUP=0
CONNECT=0
CONNECT_LABEL=""
UNINSTALL=0
PURGE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --no-setup) NO_SETUP=1 ;;
    --setup) NO_SETUP=0 ;;
    --connect) CONNECT=1 ;;
    --label)
      shift
      [ "$#" -gt 0 ] || { echo "--label requires a value" >&2; exit 2; }
      CONNECT=1
      CONNECT_LABEL="$1"
      ;;
    --origin)
      shift
      [ "$#" -gt 0 ] || { echo "--origin requires a value" >&2; exit 2; }
      KINU_ORIGIN="\${1%/}"
      ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --update) ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
KINU_ORIGIN="\${KINU_ORIGIN%/}"

say() { printf '%s\\n' "$*"; }
die() { printf 'Kinu install error: %s\\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "macOS and Linux are supported by this installer." ;;
esac

if [ "$UNINSTALL" = "1" ]; then
  if [ -L /usr/local/bin/kinu ] && [ "$(readlink /usr/local/bin/kinu)" = "$BIN_PATH" ]; then
    rm -f /usr/local/bin/kinu 2>/dev/null || true
  fi
  rm -f "$BIN_PATH"
  if [ "$PURGE" = "1" ]; then rm -rf "$KINU_HOME"; fi
  say "Kinu CLI removed."
  exit 0
fi

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found."
}

need curl
need tar
need mktemp

${bunResolutionShell()}
# The one runtime this CLI has. An existing compatible Bun is used as it is;
# otherwise the approved Bun is installed once, under $KINU_HOME, where the
# launcher's own resolution reaches it without depending on any shell profile.
provide_bun() {
  if ! kinu_resolve_bun; then
    if [ "\${KINU_INSTALL_BUN:-1}" = "0" ]; then
      die "Bun $KINU_BUN_VERSION or newer is required. Install Bun, or rerun without KINU_INSTALL_BUN=0."
    fi
    say "Installing Bun $KINU_BUN_VERSION..."
    mkdir -p "$KINU_HOME/runtime"
    curl -fsSL https://bun.sh/install | BUN_INSTALL="$KINU_HOME/runtime" bash -s "bun-v$KINU_BUN_VERSION"
    kinu_resolve_bun || die "Bun $KINU_BUN_VERSION was installed to $KINU_MANAGED_BUN but did not run."
  fi
  say "Using Bun $("$KINU_BUN" --version) at $KINU_BUN."
}

# Permission probes (test -r/-w) pass even without a controlling terminal,
# so actually open /dev/tty — the redirect itself must work or the
# interactive steps would die with "/dev/tty: No such device or address".
has_tty() {
  ( exec </dev/tty >/dev/tty ) 2>/dev/null
}

# Interactive children get the terminal on stdin and must leave it sane; if
# one dies mid-prompt anyway, restore the terminal before surfacing failure.
run_on_tty() {
  rc=0
  env KINU_HOME="$KINU_HOME" "$@" < /dev/tty || rc=$?
  if [ "$rc" -ne 0 ]; then
    stty sane < /dev/tty 2>/dev/null || true
  fi
  return "$rc"
}

run_setup_if_requested() {
  if [ "$NO_SETUP" = "1" ]; then return 0; fi
  if ! has_tty; then
    say "Setup was not started because no interactive terminal is attached."
    say "Run: $BIN_PATH setup --origin $KINU_ORIGIN"
    return 0
  fi
  say "Starting Kinu setup..."
  if [ "$YES" = "1" ]; then
    run_on_tty "$BIN_PATH" setup --origin "$KINU_ORIGIN" --account-only --yes
  else
    run_on_tty "$BIN_PATH" setup --origin "$KINU_ORIGIN" --account-only
  fi
}

run_connect_if_requested() {
  if [ "$CONNECT" != "1" ]; then return 0; fi
  if has_tty; then
    if [ -n "$CONNECT_LABEL" ]; then
      run_on_tty "$BIN_PATH" connect --label "$CONNECT_LABEL"
    else
      run_on_tty "$BIN_PATH" connect
    fi
  else
    if [ -n "$CONNECT_LABEL" ]; then
      KINU_HOME="$KINU_HOME" "$BIN_PATH" connect --label "$CONNECT_LABEL"
    else
      KINU_HOME="$KINU_HOME" "$BIN_PATH" connect
    fi
  fi
}

prepare_cli_source() {
  say "Preparing Kinu CLI..."
  # </dev/null: under curl|bash our stdin is the unread remainder of this
  # script — a child that reads stdin would consume it mid-execution.
  help="$(KINU_HOME="$KINU_HOME" KINU_REFRESH_SOURCE=1 "$BIN_PATH" --help </dev/null)" || die "Kinu CLI source setup failed."
  printf '%s\\n' "$help" | grep -Eq '^[[:space:]]+setup[[:space:]]' \
    || die "Downloaded Kinu CLI is missing setup. Retry after the deployment has finished."
}

mkdir -p "$BIN_DIR"
chmod 700 "$KINU_HOME"
provide_bun

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Installing Kinu CLI..."
curl -fsSL "$KINU_ORIGIN/downloads/kinu" -o "$tmp/kinu"
chmod 755 "$tmp/kinu"
mv "$tmp/kinu" "$BIN_PATH"
prepare_cli_source

if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  ln -sfn "$BIN_PATH" /usr/local/bin/kinu
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    NEEDS_PARENT_ACTIVATION=1
    profile=""
    shell_name="$(basename "\${SHELL:-}")"
    if [ "$shell_name" = "zsh" ]; then profile="$HOME/.zshrc";
    elif [ "$shell_name" = "bash" ]; then profile="$HOME/.bashrc";
    else profile="$HOME/.profile"; fi
    profile_line="export PATH=\\"$BIN_DIR:\\$PATH\\""
    if [ "$BIN_DIR" = "$HOME/.kinu/bin" ]; then
      profile_line='export PATH="$HOME/.kinu/bin:$PATH"'
    fi
    if touch "$profile" 2>/dev/null; then
      if grep -F "$BIN_DIR" "$profile" >/dev/null 2>&1; then
        :
      elif [ "$BIN_DIR" = "$HOME/.kinu/bin" ] && grep -F '$HOME/.kinu/bin' "$profile" >/dev/null 2>&1; then
        :
      else
        {
          printf '\\n# Kinu CLI\\n'
          printf '%s\\n' "$profile_line"
        } >> "$profile"
        say "Added $BIN_DIR to $profile."
      fi
    elif [ ! -w "$profile" ]; then
      say "Add $BIN_DIR to PATH to use kinu and agent aliases from any directory."
    fi
    export PATH="$BIN_DIR:$PATH"
    ;;
esac
if [ "$NEEDS_PARENT_ACTIVATION" = "1" ] && [ "$PARENT_ACTIVATES" != "1" ]; then
  say "To use kinu in this shell now, run:"
  say "  export PATH=\\"$BIN_DIR:\\$PATH\\""
fi

say "Kinu installed."
run_setup_if_requested
run_connect_if_requested

if [ "$NO_SETUP" = "1" ] && [ "$CONNECT" != "1" ]; then
  say "Next:"
  say "  kinu setup --origin $KINU_ORIGIN"
  say "  kinu create"
else
  say "Kinu CLI is ready."
fi
`;
  return new Response(head ? null : script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

/** Serve one published download, or 404 loudly. An incomplete deploy must
 *  never answer these paths with the SPA shell wearing an `application/gzip`
 *  content-type: the shim would then "verify" a checksum of an HTML page and
 *  every install would fail with an unexplained mismatch. */
async function cliDownloadAssetResponse(
  request: Request,
  env: Env,
  pathname: string,
  contentType: string,
  head = false,
): Promise<Response> {
  const asset = await fetchDeployedAsset(env, request.url, pathname);
  if (!asset) {
    const body = `Deployment incomplete: ${pathname} was not published by this deployment.\n`
      + 'Redeploy through scripts/deploy.sh, or retry shortly if a deploy is in flight.\n';
    return new Response(head ? null : body, {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  }
  const headers = new Headers(asset.headers);
  headers.set('content-type', contentType);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cache-control', 'no-store');
  return new Response(head ? null : asset.body, { status: 200, headers });
}

function cliShimResponse(origin: string, head = false): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail

KINU_HOME="\${KINU_HOME:-$HOME/.kinu}"
SOURCE_ROOT="$KINU_HOME/source"
SRC_DIR="$SOURCE_ROOT/current"
TARBALL_URL="\${KINU_SOURCE_TARBALL:-${origin}${CLI_SOURCE_TARBALL_PATH}}"
# Pinned checksum override; when unset, the published <tarball>.sha256 asset
# is fetched and verification is mandatory.
TARBALL_SHA256="\${KINU_SOURCE_SHA256:-}"

${bunResolutionShell()}

die() {
  echo "Kinu update error: $*" >&2
  exit 1
}

verify_tarball() {
  file="$1"
  expected="$TARBALL_SHA256"
  if [ -z "$expected" ]; then
    expected="$(curl -fsSL "$TARBALL_URL.sha256" | awk '{print $1}')" \
      || die "Could not download the source checksum from $TARBALL_URL.sha256."
  fi
  [ -n "$expected" ] || die "Source checksum is empty."
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    die "sha256sum or shasum is required to verify the Kinu source download."
  fi
  [ "$actual" = "$expected" ] || die "Source checksum mismatch."
}

refresh_source() {
  mkdir -p "$SOURCE_ROOT"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL "$TARBALL_URL" -o "$tmp/kinu.tar.gz"
  verify_tarball "$tmp/kinu.tar.gz"
  mkdir -p "$tmp/extract"
  tar -xzf "$tmp/kinu.tar.gz" -C "$tmp/extract"
  extracted="$(find "$tmp/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$extracted" ] || die "Source archive did not contain a project directory."
  rm -rf "$SRC_DIR"
  mv "$extracted" "$SRC_DIR"
}

kinu_resolve_bun || {
  echo "Bun $KINU_BUN_VERSION or newer is required for this Kinu CLI build." >&2
  echo "Reinstall Kinu so it can provide one:" >&2
  echo "  curl -fsSL ${origin}/install.sh | bash" >&2
  exit 1
}
# Whatever the CLI shells out to gets the same Bun this launcher verified.
PATH="\${KINU_BUN%/*}:$PATH"
export PATH

case "\${1:-}" in
  update|upgrade) KINU_REFRESH_SOURCE=1 ;;
esac

if [ "\${KINU_REFRESH_SOURCE:-0}" = "1" ] || [ ! -f "$SRC_DIR/packages/cli/bin/cli.ts" ]; then
  refresh_source
fi

cd "$SRC_DIR"
if [ ! -d node_modules ]; then
  "$KINU_BUN" install --frozen-lockfile
fi
exec "$KINU_BUN" run packages/cli/bin/cli.ts "$@"
`;
  return new Response(head ? null : script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

/** Rate limits are 429, caller-correctable code failures are 400, and
 *  everything else (KV outage, UserDO failure, …) is a real 500. */
function cliAuthError(e: Error): Response {
  if (e instanceof RateLimitError) return err(429, e.message);
  if (e instanceof CliAuthCodeError) return err(400, e.message);
  return err(500, renderThrownChain({ cause: e }));
}

function accessError(e: Error, request?: Request): Response {
  if (e instanceof AuthError) {
    if (e.status === 401 && request?.method === 'GET') {
      const url = new URL(request.url);
      const login = new URL('/login', url.origin);
      login.searchParams.set('return_to', url.pathname + url.search + url.hash);
      return new Response(null, {
        status: 302,
        headers: { location: login.toString(), 'cache-control': 'no-store' },
      });
    }
    return err(e.status, e.message);
  }
  return err(500, renderThrownChain({ cause: e }));
}

/** The device-approval pages: the consent screen, its result, and its failures. */
function html(title: string, body: string, status = 200, init: ResponseInit = {}): Response {
  const headers = new Headers(publicHtmlHeaders());
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Response(approvalDocument(title, body), { ...init, status, headers });
}

function toError<Thrown>(thrown: Thrown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

function csrfCookie(value: string): string {
  return `kinu_cli_auth_csrf=${value}; Path=/cli/auth; Max-Age=600; HttpOnly; Secure; SameSite=Strict`;
}

function clearCsrfCookie(): string {
  return 'kinu_cli_auth_csrf=; Path=/cli/auth; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

function isSameOriginPost(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin) return origin === url.origin;
  const referer = request.headers.get('referer');
  return !referer || referer.startsWith(`${url.origin}/`);
}
