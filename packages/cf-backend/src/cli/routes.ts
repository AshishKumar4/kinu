import {
  JsonValueSchema, ORCHESTRATOR_AGENT_SLUG, RELEASE_SIGNING_PUBLIC_KEY, USER_AI_PROXY_PATH, timingSafeEqual,
} from '@kinu.run/core';
import type { AuthIdentity } from '../auth/session';
import {
  AuthError, CLI_APPROVAL_CSRF_COOKIE_NAME, authenticateRequest, isFreshAuthTime, readCookie,
  type AuthEnv,
} from '../auth/session';
import { publicHtmlHeaders } from '@kinu.run/core';
import { approvalDocument, installDocument } from '@kinu.run/core';
import {
  CLI_DIST_PATHS, CLI_RUNTIME_PATH, CLI_VERSION_PATH, fetchDeployedAsset, type AssetFetcher,
} from '@kinu.run/core';
import { RELEASE_ARTIFACT_ROUTE, RELEASE_MANIFEST_PATH } from '@kinu.run/core/deploy';
import { err, escapeHtml, json, safeJson } from '@kinu.run/core';
import { randomToken } from '@kinu.run/core';
import type { OrchestratorAgent } from '../orchestrator';
import { webhookRouteSecret, WEBHOOK_ROUTE_UNAVAILABLE, type WebhookRouteEnv } from '@kinu.run/core';
import {
  CliAuthCodeError, RateLimitError, approveCliAuth, authenticateCliToken,
  inspectCliAuth, pollCliAuth, startCliAuth, tokenAllows,
  type CliAuthAuthority, type CliTokenIdentity,
} from './auth-store';
import { ACCESS_TOKEN_SCOPES, type AccessTokenScope } from '@kinu.run/core';
import {
  isAgentRpcMethod, requiredRpcAccess, rpcAccessScope, type AgentRpcDispatch,
} from './rpc-gate';
import { buildCliInstallCommand } from '@kinu.run/core';
import { bunResolutionShell, cliPlatformShell } from '@kinu.run/core';
import { listAvailableModels } from '../user/available-models';
import type { CloudWorkspaceBirth, CloudWorkspaceRegistry } from '../user/workspace-create';
import type { CreateWorkspaceEnv, CredentialFanoutTarget } from '../user/workspace-access';
import type { SessionAuthority } from '../auth/store';
import type { ObjectNamespace } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import type { UserDO } from '../user/user-do';
import { handleCreateWorkspaceRequest, notifyWorkspacesCredentialsChanged } from '../user/workspace-access';
import { handleUserAIProxyRequest, type UserAIProxyEnv } from '../user/ai-proxy';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { USER_AI_PROXY_FORWARD_PREFIX, handleUserProviderProxyRequest } from '../user/provider-proxy';
import { OwnerCapabilityUnavailableError, ownerCaller } from '@kinu.run/core';
import * as v from 'valibot';
import { classify, renderThrownChain } from '@kinu.run/core/obs';

const DeviceRegistrationRequestSchema = v.object({ label: v.optional(v.string()), replaces: v.optional(v.string()) });

const WebhookRequestSchema = v.object({
  label: v.optional(v.string()),
  auth_mode: v.optional(v.picklist(['hmac', 'bearer', 'mtls'])),
  secret: v.optional(v.string()),
  accepted_content_type: v.optional(v.string()),
  rate_limit_per_min: v.optional(v.number()),
});

/** Content-type for a published download path, or null. Public: a fresh install and a
 *  self-updating deployment have no session here. */
function publishedDownloadType(pathname: string): string | null {
  if (CLI_DIST_PATHS.includes(pathname)) return 'application/gzip';

  if (pathname === CLI_VERSION_PATH || pathname === RELEASE_MANIFEST_PATH) return 'application/json; charset=utf-8';

  if (!pathname.endsWith('.sha256')) return null;
  const artifact = pathname.slice(0, -'.sha256'.length);

  return CLI_DIST_PATHS.includes(artifact) || RELEASE_ARTIFACT_ROUTE.test(artifact) ? 'text/plain; charset=utf-8' : null;
}

export type CliRoutesAuthority = CliAuthAuthority & SessionAuthority & CloudWorkspaceRegistry & Pick<
  UserDO,
  'revokeCliTokenHash' | 'listCliTokens' | 'revokeAllCliTokens'
  | 'listAccessTokens' | 'mintAccessToken' | 'revokeAccessToken'
  | 'issueCliAgentConnectTicket' | 'registerDevice'
  | 'hasWorkspace' | 'listDevices' | 'listActiveWorkspaces'
  | 'getProfileCatalog' | 'putProfileCatalog'
  | 'listCredentials' | 'setCredential' | 'deleteCredential'
>;

export type CliAgentTarget = CloudWorkspaceBirth & CredentialFanoutTarget
  & Pick<OrchestratorAgent, 'createDurableWebhook'> & AgentRpcDispatch;

export interface CliRoutesEnv<Id>
  extends CreateWorkspaceEnv<Id>, UserAIProxyEnv<Id>, AuthEnv<Id>, WebhookRouteEnv {
  AUTH_KV: KvStore;
  ASSETS: AssetFetcher;
  UserDO: ObjectNamespace<Id, CliRoutesAuthority>;
  OrchestratorAgent: ObjectNamespace<Id, CliAgentTarget>;
  AI?: UserAIProxyEnv<Id>['AI'];
  CLI_APPROVAL_ORIGIN?: string;
}

export async function handleCliRequest<Id>(
  request: Request, env: CliRoutesEnv<Id>, ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
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

  if (method === 'GET' || method === 'HEAD') {
    const contentType = publishedDownloadType(url.pathname);

    if (contentType !== null) {
      return cliDownloadAssetResponse({ request, env, pathname: url.pathname, contentType, head: method === 'HEAD' });
    }
  }

  if (url.pathname === '/cli/auth' && method === 'GET') {
    return renderBrowserApproval(request, env);
  }

  if (url.pathname === '/cli/auth' && method === 'POST') {
    return approveFromBrowser(request, env);
  }

  // AI proxies are CLI-bearer-authenticated, so their gate lives here despite the /api/user/… path;
  // both spend the owner's inference credentials and share the ai.proxy scope.
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
      return json({
        body: await startCliAuth(env, {
          origin: url.origin, approvalOrigin: approvalOrigin(env, url),
          deviceName: body?.deviceName, clientKey: clientKey(request),
        }),
      });
    } catch (e) {
      return cliAuthError(toError({ cause: e }));
    }
  }

  if (path === '/auth/poll' && method === 'POST') {
    const body = await safeJson(request, v.object({ deviceToken: v.optional(v.string()) }));

    if (!body?.deviceToken) return err(400, 'deviceToken required');

    try {
      return json({ body: await pollCliAuth(env, body.deviceToken, clientKey(request)) });
    } catch (e) {
      return cliAuthError(toError({ cause: e }));
    }
  }

  // Deliberately no JSON approval route: this module runs before server.ts's CSRF gate, so a
  // cookie-only JSON POST would let any same-site page mint a CLI token. Use the form flow only.

  const cli = await authenticateCli(request, env);

  if (cli instanceof Response) return cli;

  // The agent RPC endpoint has its own per-method policy (AGENT_RPC_ACCESS), so it precedes the access-token gate.
  const rpcMatch = path.match(/^\/workspaces\/([^/]+)\/rpc$/);

  if (rpcMatch && method === 'POST') {
    return handleAgentRpc(request, env, cli, decodeURIComponent(rpcMatch[1]));
  }

  const denied = accessTokenDenial(cli, method, path);

  if (denied) return denied;

  if (path === '/me' && method === 'GET') {
    return json({
      body: {
        user: { id: cli.userId, email: cli.email, displayName: cli.displayName },
        tokenHash: cli.tokenHash,
        token: { kind: cli.kind, scopes: cli.scopes === 'all' ? 'all' : cli.scopes },
      },
    });
  }

  if (path === '/logout' && method === 'POST') {
    await cli.userDO.revokeCliTokenHash(await ownerCaller(env), cli.tokenHash);

    return json({ body: { ok: true } });
  }

  // Session inventory: lets a re-authenticated owner find and end bearers only stored as hashes.
  // Interactive sessions only.
  if (path === '/sessions' && method === 'GET') {
    return json({ body: { sessions: await cli.userDO.listCliTokens(await ownerCaller(env)) } });
  }

  if (path === '/sessions' && method === 'DELETE') {
    const result = await cli.userDO.revokeAllCliTokens(await ownerCaller(env));

    return json({ body: { ok: true, revoked: result.revoked } });
  }

  const sessionRevokeMatch = path.match(/^\/sessions\/([a-f0-9]{64})$/);

  if (sessionRevokeMatch && method === 'DELETE') {
    await cli.userDO.revokeCliTokenHash(await ownerCaller(env), sessionRevokeMatch[1]);

    return json({ body: { ok: true } });
  }

  // Profile catalog: the route gate blocks scoped tokens; the UserDO separately blocks workspace callers.
  if (path === '/profile' && method === 'GET') {
    return json({ body: await cli.userDO.getProfileCatalog(await ownerCaller(env)) });
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

    if (result.ok) return json({ body: result.envelope });

    if (result.kind === 'conflict') {
      return json({
        body: {
          error: `Version conflict: the stored catalog is at version ${result.currentVersion}.`,
          currentVersion: result.currentVersion,
          currentDigest: result.currentDigest,
        },
      }, { status: 409 });
    }

    return err(400, result.reason);
  }

  if (path === '/tokens' && method === 'GET') {
    return json({ body: { tokens: await cli.userDO.listAccessTokens(await ownerCaller(env)) } });
  }

  if (path === '/tokens' && method === 'POST') {
    // Step-up gated like webhook creation: requires a fresh `kinu auth`.
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
      body: {
        token: minted.token,
        name: minted.record.name,
        scopes: minted.record.scopes,
        createdAt: minted.record.createdAt,
      },
    }, { status: 201 });
  }

  const tokenRevokeMatch = path.match(/^\/tokens\/([^/]+)$/);

  if (tokenRevokeMatch && method === 'DELETE') {
    const ref = decodeURIComponent(tokenRevokeMatch[1]);
    const result = await cli.userDO.revokeAccessToken(await ownerCaller(env), ref);

    if (!result.revoked) return err(404, `No active access token matched "${ref}".`);

    return json({ body: { ok: true } });
  }

  if (path === '/workspaces' && method === 'GET') {
    return json({ body: await cli.userDO.listActiveWorkspaces(await ownerCaller(env)) });
  }

  if (path === '/models' && method === 'GET') {
    return json({ body: await listAvailableModels(env, cli.userId, await ownerCaller(env)) });
  }

  if (path === '/workspaces' && method === 'POST') {
    return handleCreateWorkspaceRequest({ request, env, userId: cli.userId, userDO: cli.userDO });
  }

  const workspaceMatch = path.match(/^\/workspaces\/([^/]+)$/);

  if (workspaceMatch && method === 'DELETE') {
    try {
      const name = decodeURIComponent(workspaceMatch[1]);

      if (!(await cli.userDO.hasWorkspace(await ownerCaller(env), name))) return err(404, `Agent ${name} not found.`);
      await cli.userDO.removeWorkspace(await ownerCaller(env), name, cli.userId);

      return json({ body: { ok: true } });
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

    return json({ body: { ticket: issued.ticket, expiresAt: issued.expiresAt } });
  }

  const webhookTriggerMatch = path.match(/^\/workspaces\/([^/]+)\/triggers\/webhook$/);

  if (webhookTriggerMatch && method === 'POST') {
    const agent = await cliAgent(env, cli, decodeURIComponent(webhookTriggerMatch[1]));

    if (agent instanceof Response) return agent;

    // Step-up gated on every path; the CLI's interactive-auth time is its token mint time.
    if (!isFreshAuthTime(await sessionTokenMintedAt(env, cli))) {
      return err(401, 'step-up auth required: run `kinu auth` again. Webhook creation needs a sign-in within the last 5 minutes.');
    }

    // A webhook whose delivery URL cannot be signed is a row nobody can deliver to.
    if (webhookRouteSecret(env) === null) return err(503, WEBHOOK_ROUTE_UNAVAILABLE);
    const body = await safeJson(request, WebhookRequestSchema);

    if (!body?.label || !body.auth_mode) return err(400, 'label and auth_mode required');

    try {
      return json({
        body: await agent.createDurableWebhook({
          label: body.label,
          auth_mode: body.auth_mode,
          secret: body.secret,
          accepted_content_type: body.accepted_content_type,
          rate_limit_per_min: body.rate_limit_per_min,
        }),
      }, { status: 201 });
    } catch (e) {
      return err(400, renderThrownChain({ cause: e }));
    }
  }

  if (path === '/devices' && method === 'GET') {
    return json({ body: await cli.userDO.listDevices(await ownerCaller(env)) });
  }

  if (path === '/devices' && method === 'POST') {
    const registration = await safeJson(request, DeviceRegistrationRequestSchema) ?? {};
    const { deviceId, token } = await cli.userDO.registerDevice(await ownerCaller(env), registration.label, registration.replaces);

    return json({ body: { deviceId, token, userId: cli.userId, origin: url.origin } }, { status: 201 });
  }

  // Interactive sessions only: a CI token writing a provider key could swap the account's inference
  // credentials. Secrets are never readable back.
  if (path === '/credentials' && method === 'GET') {
    return json({ body: await cli.userDO.listCredentials(await ownerCaller(env)) });
  }

  const cliCredMatch = path.match(/^\/credentials\/([^/]+)$/);

  if (cliCredMatch) {
    const key = decodeURIComponent(cliCredMatch[1]);

    if (method === 'POST') {
      const body = await safeJson(request, JsonValueSchema);

      try { await cli.userDO.setCredential(await ownerCaller(env), key, body); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }

      // Invalidate live workspaces' caches, as the browser routes do, or a new provider stays invisible.
      notifyWorkspacesCredentialsChanged(env, cli.userDO, ctx);

      return json({ body: { ok: true } }, { status: 201 });
    }

    if (method === 'DELETE') {
      try { await cli.userDO.deleteCredential(await ownerCaller(env), key); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }

      notifyWorkspacesCredentialsChanged(env, cli.userDO, ctx);

      return json({ body: { ok: true } });
    }
  }

  return err(404, `No such CLI route: ${method} ${path}`);
}

async function cliAgent<Id>(
  env: CliRoutesEnv<Id>, cli: CliTokenIdentity<CliRoutesAuthority>, name: string,
): Promise<CliAgentTarget | Response> {
  const result = await claimOwnedWorkspace(env, cli.userId, name);

  if (!result.ok) return err(result.status, result.error);

  return result.agent;
}

/** The one method-shaped transport; AGENT_RPC_ACCESS table membership is the dispatch allowlist. */
async function handleAgentRpc<Id>(
  request: Request, env: CliRoutesEnv<Id>, cli: CliTokenIdentity<CliRoutesAuthority>, name: string,
): Promise<Response> {
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

  // The table check above is the trust boundary; each method validates its own args.
  try {
    const invoke = v.parse(v.function(), agent[rpcMethod]);
    const result = await invoke(...args);

    return json({ body: { result: result ?? null } });
  } catch (e) {
    // Same contract as a websocket rpc-error frame.
    return err(400, renderThrownChain({ cause: e }));
  }
}

/** The session token's mint time (minting requires a live browser approval); access tokens never qualify. */
async function sessionTokenMintedAt<Id>(
  env: CliRoutesEnv<Id>, cli: CliTokenIdentity<CliRoutesAuthority>,
): Promise<number | null> {
  if (cli.kind !== 'session') return null;
  const tokens = await cli.userDO.listCliTokens(await ownerCaller(env));

  return tokens.find((t) => t.tokenHash === cli.tokenHash)?.createdAt ?? null;
}

/** Default-deny for scoped `pta_…` tokens on route-shaped paths; unlisted routes stay interactive-only. */
function accessTokenDenial(
  cli: Pick<CliTokenIdentity, 'kind' | 'scopes'>, method: string, path: string,
): Response | null {
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

function approvalOrigin<Id>(env: CliRoutesEnv<Id>, url: URL): string {
  const configured = env.CLI_APPROVAL_ORIGIN ?? '';

  return (configured === '' ? url.origin : configured).replace(/\/+$/, '');
}

function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown';
}

async function authenticateCli<Id>(
  request: Request, env: CliRoutesEnv<Id>,
): Promise<CliTokenIdentity<CliRoutesAuthority> | Response> {
  try {
    const result = await authenticateCliToken(request, env);

    return result.ok ? result.identity : err(401, result.error);
  } catch (e) {
    // No root secret: say so rather than surfacing an unexplained 500.
    if (e instanceof OwnerCapabilityUnavailableError) return err(503, e.message);
    throw e;
  }
}

async function renderBrowserApproval<Id>(request: Request, env: CliRoutesEnv<Id>): Promise<Response> {
  let identity: AuthIdentity;

  try { identity = await authenticateRequest(request, env); }
  catch (e) { return accessError(toError({ cause: e }), request); }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) return html('Connect the Kinu CLI', '<p>This link has no sign-in code. Run <code>kinu auth</code> in your terminal and open the link it prints.</p>', 400);
  const requestInfo = await inspectCliAuth(env.AUTH_KV, code);

  if (!requestInfo) {
    return html('Connect the Kinu CLI', '<p>This sign-in code is unknown or has expired. Run <code>kinu auth</code> again.</p>', 400);
  }

  if (requestInfo.status === 'expired') {
    return html('Connect the Kinu CLI', '<p>This sign-in code has expired. Run <code>kinu auth</code> again.</p>', 400);
  }

  if (requestInfo.status === 'approved' || requestInfo.status === 'consumed') {
    return html('Connect the Kinu CLI', '<p>This terminal is already approved. You can go back to it.</p>');
  }

  const csrf = randomToken(32);
  const expiresAt = new Date(requestInfo.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  return html('Connect the Kinu CLI', `
    <p>A terminal asked to sign in to your Kinu account.</p>
    <dl>
      <div><dt>Terminal</dt><dd>${escapeHtml(requestInfo.deviceName)}</dd></div>
      <div><dt>Code</dt><dd><code>${escapeHtml(requestInfo.userCode)}</code></dd></div>
      <div><dt>Account</dt><dd>${escapeHtml(identity.email)}</dd></div>
      <div><dt>Expires</dt><dd>${escapeHtml(expiresAt)}</dd></div>
    </dl>
    <form method="post" action="/cli/auth">
      <input type="hidden" name="userCode" value="${escapeHtml(requestInfo.userCode)}" />
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
      <button type="submit">Approve this terminal</button>
    </form>
    <p class="muted">Approve only if this code matches the one in your terminal.</p>
  `, 200, {
    headers: {
      'set-cookie': csrfCookie(csrf),
      'cache-control': 'no-store',
    },
  });
}

async function approveFromBrowser<Id>(request: Request, env: CliRoutesEnv<Id>): Promise<Response> {
  let identity: AuthIdentity;

  try { identity = await authenticateRequest(request, env); }
  catch (e) { return accessError(toError({ cause: e }), request); }

  if (!isSameOriginPost(request)) {
    return html('Connect the Kinu CLI', '<p>This approval did not come from the approval page. Open the link from your terminal again.</p>', 403);
  }

  let form: FormData;

  try { form = await request.formData(); }
  catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;

    return html('Connect the Kinu CLI', '<p>The approval form was incomplete. Refresh the page and try again.</p>', 400);
  }

  const code = textField(form, 'userCode');
  const csrf = textField(form, 'csrf');
  const cookieCsrf = readCookie(request, CLI_APPROVAL_CSRF_COOKIE_NAME);

  if (!csrf || !cookieCsrf || !timingSafeEqual(csrf, cookieCsrf)) {
    return html('Connect the Kinu CLI', '<p>This approval page has expired. Refresh it and try again.</p>', 403);
  }

  if (!code) return html('Connect the Kinu CLI', '<p>This link has no sign-in code. Run <code>kinu auth</code> in your terminal and open the link it prints.</p>', 400);

  try {
    await approveCliAuth(env, code, identity, clientKey(request));

    return html('Connect the Kinu CLI', '<p>The Kinu CLI is connected. You can go back to your terminal.</p>', 200, {
      headers: {
        'set-cookie': clearCsrfCookie(),
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return html('Connect the Kinu CLI', `<p>${escapeHtml(toError({ cause: e }).message)}</p>`, 400);
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
# The calling shell's PATH. This script is that shell's child, so it can change only its own copy.
CALLER_PATH="$PATH"
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
  for link_dir in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
    if [ -L "$link_dir/kinu" ] && [ "$(readlink "$link_dir/kinu")" = "$BIN_PATH" ]; then
      rm -f "$link_dir/kinu" 2>/dev/null || true
    fi
  done
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

# The launcher is on disk by now. Running it once with the refresh set is what
# fetches the build, and installs Bun when this machine has none it can use, so
# the download has exactly one implementation. REFRESH_ONLY stops it after the
# swap: the staged build already answered --version there.
download_cli() {
  # </dev/null: under curl|bash our stdin is the unread remainder of this
  # script — a child that reads stdin would consume it mid-execution.
  KINU_HOME="$KINU_HOME" KINU_ORIGIN="$KINU_ORIGIN" KINU_REFRESH_CLI=1 KINU_REFRESH_ONLY=1 "$BIN_PATH" </dev/null \\
    || die "Kinu CLI download failed."
}

# The only way the calling shell can run kinu at once: a directory its PATH
# already lists. Only the usual user and local bin directories qualify, in the
# caller's PATH order; another tool's bin directory is not ours to write into.
link_into_caller_path() {
  link_ifs="$IFS"
  IFS=:
  set -f
  for link_dir in $CALLER_PATH; do
    case "$link_dir" in "$HOME/.local/bin"|"$HOME/bin"|/usr/local/bin) ;; *) continue ;; esac
    case "$link_dir" in "$HOME"/*) mkdir -p "$link_dir" 2>/dev/null || true ;; esac
    if [ ! -d "$link_dir" ] || [ ! -w "$link_dir" ]; then continue; fi
    # A kinu there that is not a link is not this installer's to replace.
    if [ -e "$link_dir/kinu" ] && [ ! -L "$link_dir/kinu" ]; then continue; fi
    if ln -sfn "$BIN_PATH" "$link_dir/kinu"; then break; fi
  done
  set +f
  IFS="$link_ifs"
}

# What \`kinu\` runs in the calling shell now, or nothing.
caller_kinu() {
  (PATH="$CALLER_PATH"; command -v kinu 2>/dev/null) || true
}

mkdir -p "$BIN_DIR"
chmod 700 "$KINU_HOME"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading Kinu CLI..."
curl -fsSL "$KINU_ORIGIN/downloads/kinu" -o "$tmp/kinu"
chmod 755 "$tmp/kinu"
mv "$tmp/kinu" "$BIN_PATH"
download_cli
link_into_caller_path

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
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

# The profile line above serves every LATER shell. When no directory on the
# calling shell's PATH could take the link, that shell still needs the export,
# said last, where the user is still looking.
found="$(caller_kinu)"
if [ -z "$found" ]; then
  say ""
  say "To use kinu in this shell now, run:"
  say "  export PATH=\\"$BIN_DIR:\\$PATH\\""
elif [ "$found" != "$BIN_PATH" ] && [ "$(readlink "$found" 2>/dev/null || true)" != "$BIN_PATH" ]; then
  say ""
  say "This shell finds another kinu first, at $found. To use this one, run:"
  say "  export PATH=\\"$BIN_DIR:\\$PATH\\""
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

/** 404 loudly: an SPA shell served as `application/gzip` would make install checksums fail mysteriously. */
interface CliAssetRequest {
  request: Request;
  env: { readonly ASSETS: AssetFetcher };
  pathname: string;
  contentType: string;
  head: boolean;
}

async function cliDownloadAssetResponse(download: CliAssetRequest): Promise<Response> {
  const { request, env, pathname, contentType, head } = download;

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
KINU_ORIGIN="\${KINU_ORIGIN:-${origin}}"
CLI_ROOT="$KINU_HOME/cli"
CLI_DIR="$CLI_ROOT/current"

${cliPlatformShell()}
RUNTIME_URL="\${KINU_ORIGIN}${CLI_RUNTIME_PATH}"

${bunResolutionShell()}

die() {
  echo "Kinu update error: $*" >&2
  exit 1
}

# The one runtime this CLI has. An existing compatible Bun is used as it is;
# otherwise the approved Bun is installed once, under $KINU_HOME, where
# kinu_resolve_bun finds it whatever PATH a later shell has.
provide_bun() {
  if kinu_resolve_bun; then return 0; fi
  if [ "\${KINU_INSTALL_BUN:-1}" = "0" ]; then
    die "Bun $KINU_BUN_VERSION or newer is required. Install Bun, or rerun without KINU_INSTALL_BUN=0."
  fi
  echo "Installing Bun $KINU_BUN_VERSION..." >&2
  mkdir -p "$KINU_HOME/runtime"
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$KINU_HOME/runtime" bash -s "bun-v$KINU_BUN_VERSION" >&2
  kinu_resolve_bun || die "Bun $KINU_BUN_VERSION was installed to $KINU_MANAGED_BUN but did not run."
}

# The one lock every writer of the CLI tree takes — this launcher, 'kinu
# update' and its detached child — as a directory: mkdir creates it atomically
# or refuses. The holder's pid is inside, so a lock a dead process left is
# taken over rather than waited on. Released on every exit, die included.
CLI_LOCK="$CLI_ROOT/.lock"
take_cli_lock() {
  mkdir -p "$CLI_ROOT"
  attempt=0
  while [ "$attempt" -lt 2 ]; do
    if mkdir "$CLI_LOCK" 2>/dev/null; then
      echo "$$" > "$CLI_LOCK/pid"
      trap 'rm -rf "$CLI_LOCK"' EXIT
      return 0
    fi
    holder="$(cat "$CLI_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then return 1; fi
    rm -rf "$CLI_LOCK"
    attempt=$((attempt + 1))
  done
  return 1
}

# The release manifest is SIGNED at build with a key this deployment never
# holds, and the public half is pinned into this launcher: a download is
# verified against the checksum the signature covers, never against a
# checksum the origin chooses for itself (a hostile or compromised deploy
# could otherwise hand every machine bytes to run — SECURITY-devices C1).
# The downloads start together and need no Bun; nothing downloaded is unpacked
# or run until the signature and the signed checksum for it verify, so a
# release the pinned key did not sign still lands nothing. The signed checksums
# are read from the manifest per artifact. The verification runs on the Bun
# this launcher resolved: Ed25519 over WebCrypto.
RELEASE_SIGNING_PUBLIC_KEY="\${KINU_RELEASE_SIGNING_PUBLIC_KEY:-${RELEASE_SIGNING_PUBLIC_KEY}}"
MANIFEST_URL="\${KINU_ORIGIN}${CLI_VERSION_PATH}"
DOWNLOADS=""
verify_release() {
  manifest="$1"
  wait "$2" || die "Could not download the release manifest from $MANIFEST_URL."
  "$KINU_BUN" -e '
    const [file, publicKeyHex] = process.argv.slice(1);
    const manifest = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const checksums = manifest.checksums, signature = manifest.signature, version = manifest.version;
    const fail = (why) => { console.error(why); process.exit(1); };
    if (typeof version !== "string" || typeof signature !== "string" || Object(checksums) !== checksums) fail("the release manifest carries no signature; nothing is installed");
    const lines = Object.entries(checksums).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, d]) => p + " " + String(d).toLowerCase());
    const message = new TextEncoder().encode(["kinu-release-v1", version, ...lines, ""].join("\\n"));
    const key = Uint8Array.from(publicKeyHex.match(/../g), (pair) => parseInt(pair, 16));
    const sig = Uint8Array.from(Buffer.from(signature, "base64"));
    crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"])
      .then((k) => crypto.subtle.verify("Ed25519", k, sig, message))
      .then((ok) => { if (!ok) fail("the release signature does not verify against the pinned key; nothing is installed"); });
  ' "$manifest" "$RELEASE_SIGNING_PUBLIC_KEY" || die "The release is not one this launcher trusts."
}
signed_checksum() {
  "$KINU_BUN" -e '
    const [file, artifact] = process.argv.slice(1);
    const manifest = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const digest = manifest.checksums && manifest.checksums[artifact];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) { console.error("the signed release names no " + artifact); process.exit(1); }
    console.log(digest.toLowerCase());
  ' "$1" "$2"
}
# Each download is verified against the SIGNED checksum for its path. An
# incomplete deploy answers a download path with the SPA shell, and unpacking
# an HTML page as a tarball is how an install fails without saying why.
fetch_verified() {
  url="$1"
  into="$2"
  manifest="$3"
  artifact="/downloads/\${url##*/downloads/}"
  expected="$(signed_checksum "$manifest" "$artifact")" || die "The signed release names no $artifact."
  [ -n "$expected" ] || die "The signed checksum for $url is empty."
  wait "$4" || die "Could not download $url."
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$into" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$into" | awk '{print $1}')"
  else
    die "sha256sum or shasum is required to verify the Kinu download."
  fi
  [ "$actual" = "$expected" ] || die "Checksum mismatch for $url."
}

# The published artifacts are the CLI, already built. Unpacking them IS the
# install: there is no dependency graph to resolve on this machine, so no
# package manager, no registry and no postinstall script runs here.
#
# Both unpack over one staging tree beside the installed one, that tree answers
# --version before anything moves, and then the swap (adopt_tree) puts it in
# place: an interrupted download or a build that cannot launch leaves the
# installed CLI as it was. The tree it replaced stays as prev for one launch
# (see below). The staging directories are removed on every exit, die
# included — a RETURN trap never fired on one.
refresh_cli() {
  mkdir -p "$CLI_ROOT"
  tmp="$(mktemp -d)"
  next="$CLI_ROOT/next-$$"
  trap 'kill $DOWNLOADS 2>/dev/null || true; rm -rf "$tmp" "$next" "$CLI_LOCK"' EXIT
  curl -fsSL "$MANIFEST_URL" -o "$tmp/kinu-version.json" & manifest_pid=$!
  curl -fsSL "$TARBALL_URL" -o "$tmp/cli.tar.gz" & tarball_pid=$!
  curl -fsSL "$RUNTIME_URL" -o "$tmp/runtime.tar.gz" & runtime_pid=$!
  DOWNLOADS="$manifest_pid $tarball_pid $runtime_pid"
  provide_bun
  echo "Using Bun $("$KINU_BUN" --version) at $KINU_BUN." >&2
  verify_release "$tmp/kinu-version.json" "$manifest_pid"
  fetch_verified "$TARBALL_URL" "$tmp/cli.tar.gz" "$tmp/kinu-version.json" "$tarball_pid"
  fetch_verified "$RUNTIME_URL" "$tmp/runtime.tar.gz" "$tmp/kinu-version.json" "$runtime_pid"
  DOWNLOADS=""
  mkdir -p "$tmp/extract"
  tar -xzf "$tmp/cli.tar.gz" -C "$tmp/extract"
  tar -xzf "$tmp/runtime.tar.gz" -C "$tmp/extract"
  [ -f "$tmp/extract/kinu/cli.js" ] || die "The Kinu build archive carries no cli.js."
  rm -rf "$next"
  mv "$tmp/extract/kinu" "$next"
  "$KINU_BUN" run "$next/cli.js" --version >/dev/null 2>&1 || die "The downloaded Kinu build does not launch."
  adopt_tree "$next"
  rm -rf "$tmp"
}

# The swap, written so a kill at any line leaves a runnable tree. The
# last-known-good prev is kept until the new current is in place: prev goes to
# prev.old, current to prev, the proven tree to current, and only then does
# prev.old go. Between the second and third lines there is no current — and
# recover_current below finds the proven next-* on the next launch, or prev.
adopt_tree() {
  proven="$1"
  rm -rf "$CLI_ROOT/prev.old"
  if [ -d "$CLI_DIR" ]; then
    [ -d "$CLI_ROOT/prev" ] && mv "$CLI_ROOT/prev" "$CLI_ROOT/prev.old"
    mv "$CLI_DIR" "$CLI_ROOT/prev"
  fi
  mv "$proven" "$CLI_DIR"
  rm -rf "$CLI_ROOT/prev.old"
}

# A launch that finds no current recovers one before it downloads anything: a
# staged next-* that answers --version is the build a killed swap had already
# proven, and prev is the build that last ran. Answers 1 only when neither is
# there, which is what makes the download the last resort.
recover_current() {
  [ -f "$CLI_DIR/cli.js" ] && return 0
  for candidate in "$CLI_ROOT"/next-*; do
    [ -f "$candidate/cli.js" ] || continue
    if "$KINU_BUN" run "$candidate/cli.js" --version >/dev/null 2>&1; then
      rm -rf "$CLI_DIR"
      adopt_tree "$candidate"
      return 0
    fi
    rm -rf "$candidate"
  done
  if [ -d "$CLI_ROOT/prev.old" ] && [ ! -d "$CLI_ROOT/prev" ]; then mv "$CLI_ROOT/prev.old" "$CLI_ROOT/prev"; fi
  if [ -f "$CLI_ROOT/prev/cli.js" ]; then
    rm -rf "$CLI_DIR"
    mv "$CLI_ROOT/prev" "$CLI_DIR"
    return 0
  fi
  return 1
}

# The launch check. A prev tree means the last launch, or a background refresh
# since, swapped current in without running it here. Run it once: a current
# that answers --version is kept and prev is dropped; one that does not is the
# build that just landed, and prev comes back. Nothing here downloads.
check_launch() {
  [ -d "$CLI_ROOT/prev" ] || return 0
  if "$KINU_BUN" run "$CLI_DIR/cli.js" --version >/dev/null 2>&1; then
    rm -rf "$CLI_ROOT/prev"
  else
    echo "Kinu: the installed build does not launch; restoring the previous one." >&2
    rm -rf "$CLI_DIR"
    mv "$CLI_ROOT/prev" "$CLI_DIR"
  fi
}

# A refresh starts its downloads before it provides Bun, so the two overlap;
# every other launch needs Bun now to check what is installed.
if [ "\${KINU_REFRESH_CLI:-0}" != "1" ]; then provide_bun; fi

# 'kinu update' is the CLI's own command: it stages, verifies and swaps its
# tree the same way, then rewrites this script. The launcher downloads only
# when asked (the installer) or when there is nothing to run.
# Under the tree's lock: a background refresh in flight lands the same build,
# so a launcher that cannot take the lock runs what is installed and does no
# download of its own (a missing current with the lock held is that refresh's
# own window; it is retried on the next launch).
if take_cli_lock; then
  if [ "\${KINU_REFRESH_CLI:-0}" = "1" ] || ! recover_current; then
    refresh_cli
  else
    check_launch
  fi
  rm -rf "$CLI_LOCK"
  trap - EXIT
fi
[ -n "$KINU_BUN" ] || provide_bun
# Whatever the CLI shells out to gets the same Bun this launcher verified.
PATH="\${KINU_BUN%/*}:$PATH"
export PATH

# The installer's refresh ends here: the staged build already answered --version.
if [ "\${KINU_REFRESH_ONLY:-0}" = "1" ]; then
  [ -f "$CLI_DIR/cli.js" ] || die "No Kinu build is installed."
  exit 0
fi

cd "$CLI_DIR"
exec "$KINU_BUN" run "$CLI_DIR/cli.js" "$@"
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

function html(title: string, body: string, status = 200, init: ResponseInit = {}): Response {
  const headers = new Headers(publicHtmlHeaders());

  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);

  return new Response(approvalDocument(title, body), { ...init, status, headers });
}

function toError(thrown: { cause: unknown }): Error {
  return thrown.cause instanceof Error ? thrown.cause : new Error(renderThrownChain(thrown));
}

/** A file under a text field's name reads as absent. */
function textField(form: FormData, name: string): string {
  const raw = form.get(name);

  return raw === null || raw instanceof Blob ? '' : raw;
}

function csrfCookie(value: string): string {
  return `${CLI_APPROVAL_CSRF_COOKIE_NAME}=${value}; Path=/cli/auth; Max-Age=600; HttpOnly; Secure; SameSite=Strict`;
}

function clearCsrfCookie(): string {
  return `${CLI_APPROVAL_CSRF_COOKIE_NAME}=; Path=/cli/auth; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function isSameOriginPost(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');

  if (origin) return origin === url.origin;
  const referer = request.headers.get('referer');

  return !referer || referer.startsWith(`${url.origin}/`);
}
