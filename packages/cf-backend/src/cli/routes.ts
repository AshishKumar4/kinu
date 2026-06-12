import { ORCHESTRATOR_AGENT_SLUG } from '@proteus/core';
import type { AuthIdentity } from '../auth/session.js';
import { AuthError, authenticateRequest, isFreshAuthTime } from '../auth/session.js';
import { publicHtmlHeaders } from '../lib/security-headers.js';
import { err, escapeHtml, json, safeJson } from '../lib/http.js';
import { randomToken, timingSafeEqual } from '../lib/crypto.js';
import type { OrchestratorAgent } from '../orchestrator.js';
import {
  CliAuthCodeError, RateLimitError, approveCliAuth, authenticateCliToken,
  inspectCliAuth, pollCliAuth, startCliAuth, tokenAllows, type CliTokenIdentity,
} from './auth-store.js';
import { ACCESS_TOKEN_SCOPES, type AccessTokenScope } from './access-token-store.js';
import { buildCliInstallCommand } from './install-command.js';
import { listAvailableModels } from '../user/available-models.js';
import { claimOwnedAgent, handleCreateAgentRequest } from '../user/agent-access.js';
import { USER_AI_PROXY_PREFIX, handleUserAIProxyRequest } from '../user/ai-proxy.js';

const CLI_SOURCE_TARBALL_PATH = '/downloads/proteus-source.tar.gz';
const CLI_SOURCE_TARBALL_SHA256_PATH = `${CLI_SOURCE_TARBALL_PATH}.sha256`;

export async function handleCliRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === '/install' && (method === 'GET' || method === 'HEAD')) {
    return method === 'HEAD' ? new Response(null, installPageInit()) : installPageResponse(url.origin);
  }
  if (url.pathname === '/install.sh' && (method === 'GET' || method === 'HEAD')) {
    return installScriptResponse(url.origin, method === 'HEAD');
  }
  if (url.pathname === '/downloads/proteus' && (method === 'GET' || method === 'HEAD')) {
    return cliShimResponse(url.origin, method === 'HEAD');
  }
  if (url.pathname === CLI_SOURCE_TARBALL_PATH && (method === 'GET' || method === 'HEAD')) {
    return cliDownloadAssetResponse(request, env, CLI_SOURCE_TARBALL_PATH, 'application/gzip', method === 'HEAD');
  }
  if (url.pathname === CLI_SOURCE_TARBALL_SHA256_PATH && (method === 'GET' || method === 'HEAD')) {
    return cliDownloadAssetResponse(request, env, CLI_SOURCE_TARBALL_SHA256_PATH, 'text/plain; charset=utf-8', method === 'HEAD');
  }

  if (url.pathname === '/cli/auth' && method === 'GET') {
    return renderBrowserApproval(request, env);
  }
  if (url.pathname === '/cli/auth' && method === 'POST') {
    return approveFromBrowser(request, env);
  }

  // The signed-in AI proxy is CLI-bearer-authenticated (never browser
  // cookies), so its gate lives here even though the path is /api/user/…:
  // session tokens pass, scoped access tokens need ai.proxy.
  if (url.pathname.startsWith(`${USER_AI_PROXY_PREFIX}/`)) {
    const cli = await authenticateCli(request, env);
    if (cli instanceof Response) return cli;
    if (cli.kind === 'access' && !tokenAllows(cli, 'ai.proxy')) {
      return err(403, 'This access token does not have the ai.proxy scope.');
    }
    return handleUserAIProxyRequest(request, env, cli);
  }

  if (!url.pathname.startsWith('/api/cli')) return null;
  const path = url.pathname.slice('/api/cli'.length) || '/';

  if (path === '/auth/start' && method === 'POST') {
    const body = await safeJson<{ deviceName?: string }>(request);
    try {
      return json(await startCliAuth(env, url.origin, approvalOrigin(env, url), body?.deviceName, clientKey(request)));
    } catch (e) {
      return cliAuthError(e);
    }
  }

  if (path === '/auth/poll' && method === 'POST') {
    const body = await safeJson<{ deviceToken?: string }>(request);
    if (!body?.deviceToken) return err(400, 'deviceToken required');
    try {
      return json(await pollCliAuth(env, body.deviceToken, clientKey(request)));
    } catch (e) {
      return cliAuthError(e);
    }
  }

  if (path === '/auth/approve' && method === 'POST') {
    let identity: AuthIdentity;
    try { identity = await authenticateRequest(request, env); }
    catch (e) { return accessError(e, request); }
    const body = await safeJson<{ userCode?: string }>(request);
    if (!body?.userCode) return err(400, 'userCode required');
    try { return json(await approveCliAuth(env, body.userCode, identity, clientKey(request))); }
    catch (e) { return cliAuthError(e); }
  }

  const cli = await authenticateCli(request, env);
  if (cli instanceof Response) return cli;

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
    await cli.userDO.revokeCliTokenHash(cli.tokenHash);
    return json({ ok: true });
  }

  // ── CI access tokens — interactive-session-only management surface ──
  if (path === '/tokens' && method === 'GET') {
    return json({ tokens: await cli.userDO.listAccessTokens() });
  }

  if (path === '/tokens' && method === 'POST') {
    // Minting a long-lived credential is step-up gated exactly like webhook
    // creation: the session token itself must come from a fresh `proteus auth`.
    if (!isFreshAuthTime(await sessionTokenMintedAt(cli))) {
      return err(401, 'step-up auth required: run `proteus auth` again — minting access tokens needs a sign-in within the last 5 minutes');
    }
    const body = await safeJson<{ name?: string; scopes?: string[] }>(request);
    if (!body?.name?.trim() || !Array.isArray(body.scopes)) {
      return err(400, `name and scopes required (valid scopes: ${ACCESS_TOKEN_SCOPES.join(', ')})`);
    }
    const minted = await cli.userDO.mintAccessToken(cli.userId, body.name, body.scopes);
    if (!minted.ok) return err(400, minted.error);
    return json({
      token: minted.token,
      name: minted.record.name,
      scopes: minted.record.scopes,
      createdAt: minted.record.createdAt,
    }, { status: 201, headers: { 'cache-control': 'no-store' } });
  }

  const tokenRevokeMatch = path.match(/^\/tokens\/([^/]+)$/);
  if (tokenRevokeMatch && method === 'DELETE') {
    const ref = decodeURIComponent(tokenRevokeMatch[1]);
    const result = await cli.userDO.revokeAccessToken(ref);
    if (!result.revoked) return err(404, `No active access token matched "${ref}".`);
    return json({ ok: true });
  }

  if (path === '/agents' && method === 'GET') {
    return json(await cli.userDO.listAgents());
  }

  if (path === '/models' && method === 'GET') {
    return json(await listAvailableModels(env, cli.userId));
  }

  if (path === '/agents' && method === 'POST') {
    return handleCreateAgentRequest(request, env, cli.userId, cli.userDO, ctx);
  }

  const connectTicketMatch = path.match(/^\/agents\/([^/]+)\/connect-ticket$/);
  if (connectTicketMatch && method === 'POST') {
    const name = decodeURIComponent(connectTicketMatch[1]);
    if (!(await cli.userDO.hasAgent(name))) return err(404, `Agent ${name} not found.`);
    const issued = await cli.userDO.issueCliAgentConnectTicket({
      userId: cli.userId,
      agentClass: ORCHESTRATOR_AGENT_SLUG,
      agentName: name,
      cliTokenHash: cli.tokenHash,
      capabilities: ['agent.websocket'],
    });
    if (!issued.ok || !issued.ticket || !issued.expiresAt) return err(403, issued.error ?? 'Could not issue connect ticket.');
    return json({ ticket: issued.ticket, expiresAt: issued.expiresAt }, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  const statusMatch = path.match(/^\/agents\/([^/]+)\/status$/);
  if (statusMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(statusMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getAgentStatus());
  }

  const toolsMatch = path.match(/^\/agents\/([^/]+)\/tools$/);
  if (toolsMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(toolsMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getToolDescriptions());
  }

  const messagesMatch = path.match(/^\/agents\/([^/]+)\/messages$/);
  if (messagesMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(messagesMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getChatHistory(boundedLimit(url, 100)));
  }

  const consentsMatch = path.match(/^\/agents\/([^/]+)\/consents$/);
  if (consentsMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(consentsMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.listPendingConsents());
  }

  const consentResolveMatch = path.match(/^\/agents\/([^/]+)\/consents\/([^/]+)$/);
  if (consentResolveMatch && method === 'POST') {
    const agent = await cliAgent(env, cli, decodeURIComponent(consentResolveMatch[1]));
    if (agent instanceof Response) return agent;
    const body = await safeJson<{ decision?: 'once' | 'always' | 'deny' }>(request);
    if (body?.decision !== 'once' && body?.decision !== 'always' && body?.decision !== 'deny') {
      return err(400, 'decision must be once, always, or deny');
    }
    return json(await agent.resolveDeviceConsent(decodeURIComponent(consentResolveMatch[2]), body.decision));
  }

  const modelMatch = path.match(/^\/agents\/([^/]+)\/model$/);
  if (modelMatch && (method === 'GET' || method === 'PUT')) {
    const agent = await cliAgent(env, cli, decodeURIComponent(modelMatch[1]));
    if (agent instanceof Response) return agent;
    if (method === 'GET') return json(await agent.getStoredModelSpec());
    const body = await safeJson<{ spec?: string }>(request);
    if (!body?.spec?.trim()) return err(400, 'spec required');
    return json(await agent.setModel(body.spec));
  }

  const triggersMatch = path.match(/^\/agents\/([^/]+)\/triggers$/);
  if (triggersMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(triggersMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.listTriggers());
  }

  const timerTriggerMatch = path.match(/^\/agents\/([^/]+)\/triggers\/timer$/);
  if (timerTriggerMatch && method === 'POST') {
    const agent = await cliAgent(env, cli, decodeURIComponent(timerTriggerMatch[1]));
    if (agent instanceof Response) return agent;
    const body = await safeJson<{ cron?: string; atMs?: number; label?: string; payload?: Record<string, unknown> }>(request);
    try {
      return json(await agent.createTimerTrigger({
        cron: body?.cron,
        atMs: body?.atMs,
        label: body?.label,
        payload: body?.payload,
        trust: 'owner',
      }), { status: 201 });
    } catch (e) {
      return err(400, (e as Error).message);
    }
  }

  const webhookTriggerMatch = path.match(/^\/agents\/([^/]+)\/triggers\/webhook$/);
  if (webhookTriggerMatch && method === 'POST') {
    const agent = await cliAgent(env, cli, decodeURIComponent(webhookTriggerMatch[1]));
    if (agent instanceof Response) return agent;
    // Webhook creation is step-up gated on every path. The CLI's
    // interactive-auth timestamp is its token mint time (minting requires
    // a live browser approval), so a fresh `proteus auth` satisfies it.
    if (!isFreshAuthTime(await sessionTokenMintedAt(cli))) {
      return err(401, 'step-up auth required: run `proteus auth` again — webhook creation needs a sign-in within the last 5 minutes');
    }
    const body = await safeJson<{
      label?: string;
      auth_mode?: 'hmac' | 'bearer' | 'mtls';
      secret?: string;
      accepted_content_type?: string;
      rate_limit_per_min?: number;
    }>(request);
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
      return err(400, (e as Error).message);
    }
  }

  const triggerDeleteMatch = path.match(/^\/agents\/([^/]+)\/triggers\/([^/]+)$/);
  if (triggerDeleteMatch && method === 'DELETE') {
    const agent = await cliAgent(env, cli, decodeURIComponent(triggerDeleteMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.cancelTrigger(decodeURIComponent(triggerDeleteMatch[2])));
  }

  const jobsMatch = path.match(/^\/agents\/([^/]+)\/jobs$/);
  if (jobsMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(jobsMatch[1]));
    if (agent instanceof Response) return agent;
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20));
    return json(await agent.listBackgroundJobs(limit));
  }

  const jobDeleteMatch = path.match(/^\/agents\/([^/]+)\/jobs\/([^/]+)$/);
  if (jobDeleteMatch && method === 'DELETE') {
    const agent = await cliAgent(env, cli, decodeURIComponent(jobDeleteMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.cancelBackgroundJob(decodeURIComponent(jobDeleteMatch[2])));
  }

  const stateMatch = path.match(/^\/agents\/([^/]+)\/state$/);
  if (stateMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(stateMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getWorkspaceSnapshot());
  }

  const stopMatch = path.match(/^\/agents\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    const agent = await cliAgent(env, cli, decodeURIComponent(stopMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.cancelCurrentWork());
  }

  const memoryMatch = path.match(/^\/agents\/([^/]+)\/memory$/);
  if (memoryMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(memoryMatch[1]));
    if (agent instanceof Response) return agent;
    const query = url.searchParams.get('q')?.trim();
    if (query) return json(await agent.searchMemoryHybrid(query, boundedLimit(url, 10)));
    return json({ content: await agent.getMemoryContent() });
  }

  const eventsMatch = path.match(/^\/agents\/([^/]+)\/events$/);
  if (eventsMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(eventsMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.listRecentEvents({
      variant: url.searchParams.get('variant') ?? undefined,
      since: readIntParam(url, 'since'),
      limit: boundedLimit(url, 50),
    }));
  }

  const timelineMatch = path.match(/^\/agents\/([^/]+)\/timeline$/);
  if (timelineMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(timelineMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getRunTimeline({ runId: url.searchParams.get('runId') ?? undefined, limit: boundedLimit(url, 250) }));
  }

  const mctsDetailMatch = path.match(/^\/agents\/([^/]+)\/mcts\/([^/]+)$/);
  if (mctsDetailMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(mctsDetailMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getMctsNodeDetail(decodeURIComponent(mctsDetailMatch[2])));
  }

  const mctsMatch = path.match(/^\/agents\/([^/]+)\/mcts$/);
  if (mctsMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(mctsMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getMctsTree());
  }

  const headsMatch = path.match(/^\/agents\/([^/]+)\/heads$/);
  if (headsMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(headsMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getHeadRuns(boundedLimit(url, 20)));
  }

  const gepaDetailMatch = path.match(/^\/agents\/([^/]+)\/gepa\/([^/]+)$/);
  if (gepaDetailMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(gepaDetailMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getGepaRun(decodeURIComponent(gepaDetailMatch[2])));
  }

  const gepaMatch = path.match(/^\/agents\/([^/]+)\/gepa$/);
  if (gepaMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(gepaMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getGepaRuns(boundedLimit(url, 20)));
  }

  const executorExecMatch = path.match(/^\/agents\/([^/]+)\/executors\/([^/]+)\/exec$/);
  if (executorExecMatch && method === 'POST') {
    const agent = await cliAgent(env, cli, decodeURIComponent(executorExecMatch[1]));
    if (agent instanceof Response) return agent;
    const body = await safeJson<{ command?: string }>(request);
    if (!body?.command?.trim()) return err(400, 'command required');
    return json(await agent.executeInExecutor(decodeURIComponent(executorExecMatch[2]), body.command));
  }

  const executorsMatch = path.match(/^\/agents\/([^/]+)\/executors$/);
  if (executorsMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(executorsMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getExecutors());
  }

  const productMatch = path.match(/^\/agents\/([^/]+)\/product$/);
  if (productMatch && method === 'GET') {
    const agent = await cliAgent(env, cli, decodeURIComponent(productMatch[1]));
    if (agent instanceof Response) return agent;
    return json(await agent.getProductChangeBoard(boundedLimit(url, 20)));
  }

  if (path === '/devices' && method === 'GET') {
    return json(await cli.userDO.listDevices());
  }
  if (path === '/devices' && method === 'POST') {
    const body = await safeJson<{ label?: string }>(request);
    const { deviceId, token } = await cli.userDO.registerDevice(body?.label);
    return json({ deviceId, token, userId: cli.userId, origin: url.origin }, { status: 201 });
  }

  return err(404, `No such CLI route: ${method} ${path}`);
}

async function cliAgent(env: Env, cli: CliTokenIdentity, name: string): Promise<DurableObjectStub<OrchestratorAgent> | Response> {
  const result = await claimOwnedAgent(env, cli.userId, name);
  if (!result.ok) return err(result.status, result.error);
  return result.agent;
}

/** The CLI's interactive-auth timestamp: the session token's mint time
 *  (minting requires a live browser approval). Step-up gated routes compare
 *  it against the fresh-auth window; access tokens never qualify. */
async function sessionTokenMintedAt(cli: CliTokenIdentity): Promise<number | null> {
  if (cli.kind !== 'session') return null;
  const tokens = await cli.userDO.listCliTokens();
  return tokens.find((t) => t.tokenHash === cli.tokenHash)?.createdAt ?? null;
}

/** Default-deny gate for scoped `pta_…` access tokens: reads need agent.read,
 *  run-a-task surfaces need agent.exec, and everything else — webhook/timer
 *  creation, device registration, agent creation, consent decisions, model
 *  changes, token management — stays interactive-session-only. Routes added
 *  in the future are interactive-only until listed here. */
function accessTokenDenial(cli: CliTokenIdentity, method: string, path: string): Response | null {
  if (cli.kind !== 'access') return null;
  if (path === '/me' && method === 'GET') return null; // identity introspection works for any valid bearer
  const required = requiredAccessScope(method, path);
  if (!required) {
    return err(403, 'This operation requires an interactive CLI session token. Sign in with: proteus auth');
  }
  if (!tokenAllows(cli, required)) {
    return err(403, `This access token does not have the ${required} scope.`);
  }
  return null;
}

function requiredAccessScope(method: string, path: string): AccessTokenScope | null {
  if (method === 'GET') {
    if (path === '/agents' || path === '/models') return 'agent.read';
    if (/^\/agents\/[^/]+\/[^/]+/.test(path)) return 'agent.read';
    return null;
  }
  if (method === 'POST') {
    if (/^\/agents\/[^/]+\/(connect-ticket|stop)$/.test(path)) return 'agent.exec';
    if (/^\/agents\/[^/]+\/executors\/[^/]+\/exec$/.test(path)) return 'agent.exec';
  }
  return null;
}

function readIntParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function boundedLimit(url: URL, fallback: number, max = 250): number {
  const value = readIntParam(url, 'limit') ?? fallback;
  return Math.max(1, Math.min(max, value));
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
  const result = await authenticateCliToken(request, env);
  return result.ok ? result.identity : err(401, result.error);
}

async function renderBrowserApproval(request: Request, env: Env): Promise<Response> {
  let identity: AuthIdentity;
  try { identity = await authenticateRequest(request, env); }
  catch (e) { return accessError(e, request); }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return html('Proteus CLI Auth', '<p>Missing CLI auth code.</p>', 400);
  const requestInfo = await inspectCliAuth(env.AUTH_DB, code);
  if (!requestInfo) {
    return html('Proteus CLI Auth', '<p>Unknown or expired CLI auth code.</p>', 400);
  }
  if (requestInfo.status === 'expired') {
    return html('Proteus CLI Auth', '<p>This CLI auth code expired. Run <code>proteus auth</code> again.</p>', 400);
  }
  if (requestInfo.status === 'approved' || requestInfo.status === 'consumed') {
    return html('Proteus CLI Auth', '<p>This CLI auth request has already been approved. You can return to your terminal.</p>');
  }

  const csrf = randomToken(32);
  const expiresAt = new Date(requestInfo.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return html('Approve Proteus CLI', `
    <p>Sign in this terminal to your Proteus account.</p>
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
  catch (e) { return accessError(e, request); }
  if (!isSameOriginPost(request)) {
    return html('Proteus CLI Auth', '<p>Invalid approval origin.</p>', 403);
  }
  let form: FormData;
  try { form = await request.formData(); }
  catch { return html('Proteus CLI Auth', '<p>Invalid approval form.</p>', 400); }
  const code = String(form.get('userCode') ?? '');
  const csrf = String(form.get('csrf') ?? '');
  const cookieCsrf = readCookie(request, 'proteus_cli_auth_csrf');
  if (!csrf || !cookieCsrf || !timingSafeEqual(csrf, cookieCsrf)) {
    return html('Proteus CLI Auth', '<p>Invalid or expired approval session. Refresh the approval page and try again.</p>', 403);
  }
  if (!code) return html('Proteus CLI Auth', '<p>Missing CLI auth code.</p>', 400);
  try {
    await approveCliAuth(env, code, identity, clientKey(request));
    return html('Proteus CLI Auth', '<p>CLI connected. You can return to your terminal.</p>', 200, {
      headers: {
        'set-cookie': clearCsrfCookie(),
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return html('Proteus CLI Auth', `<p>${escapeHtml((e as Error).message)}</p>`, 400);
  }
}

function installPageResponse(origin: string): Response {
  const command = buildCliInstallCommand({ origin });
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Install Proteus CLI</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --panel: rgba(255, 255, 255, 0.04);
      --panel-strong: rgba(139, 92, 246, 0.12);
      --ink: #fafafa;
      --muted: #a1a1aa;
      --line: rgba(255, 255, 255, 0.08);
      --accent: #a78bfa;
      --accent-strong: #8b5cf6;
      --warning: #d29922;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(135deg, rgba(139, 92, 246, 0.12), transparent 36%),
        linear-gradient(315deg, rgba(20, 184, 166, 0.08), transparent 34%),
        var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; text-decoration: none; }
    .shell {
      width: min(1040px, calc(100vw - 28px));
      min-height: 100vh;
      margin: 0 auto;
      border-inline: 1px solid var(--line);
      display: grid;
      grid-template-rows: auto 1fr;
      background: rgba(9, 9, 11, 0.72);
    }
    header {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(16px);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 720;
    }
    .mark {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(167, 139, 250, 0.55);
      color: var(--accent);
      font-weight: 780;
    }
    .nav {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--muted);
      font-size: 14px;
    }
    .button {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(167, 139, 250, 0.62);
      padding: 0 14px;
      background: var(--panel-strong);
      color: var(--ink);
      font-weight: 660;
      white-space: nowrap;
    }
    main {
      padding: 72px 24px 48px;
      display: grid;
      gap: 44px;
      align-content: start;
    }
    .hero {
      width: min(780px, 100%);
    }
    .eyebrow {
      margin: 0 0 14px;
      color: var(--accent);
      text-transform: uppercase;
      font-size: 13px;
      font-weight: 720;
    }
    h1 {
      margin: 0;
      font-size: 72px;
      line-height: 0.94;
      font-weight: 780;
      letter-spacing: 0;
    }
    .lede {
      width: min(650px, 100%);
      margin: 22px 0 0;
      color: var(--muted);
      font-size: 19px;
      line-height: 1.55;
    }
    .command {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 10px;
      width: min(900px, 100%);
      border: 1px solid var(--line);
      background: #0f0f11;
      padding: 12px;
    }
    code {
      overflow-x: auto;
      white-space: nowrap;
      color: var(--warning);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.6;
    }
    .copy {
      min-height: 36px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: var(--panel-strong);
      color: var(--ink);
      padding: 0 12px;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      border: 1px solid var(--line);
      background: var(--line);
    }
    .cell {
      min-height: 132px;
      padding: 18px;
      background: rgba(9, 9, 11, 0.9);
    }
    .cell strong {
      display: block;
      font-size: 14px;
      margin-bottom: 8px;
    }
    .cell span {
      display: block;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.48;
    }
    .notes {
      display: flex;
      flex-wrap: wrap;
      gap: 12px 18px;
      color: var(--muted);
      font-size: 13px;
    }
    .notes a { color: var(--accent); }
    @media (max-width: 740px) {
      .shell { width: 100%; border-inline: 0; }
      header { padding: 0 16px; }
      main { padding: 56px 16px 36px; }
      h1 { font-size: 42px; }
      .nav a:first-child { display: none; }
      .command { grid-template-columns: 1fr; }
      code { white-space: normal; overflow-wrap: anywhere; }
      .copy { width: 100%; }
      .grid { grid-template-columns: 1fr; }
    }
    @media (min-width: 741px) and (max-width: 980px) {
      h1 { font-size: 58px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <a class="brand" href="/" aria-label="Proteus home"><span class="mark">P</span><span>Proteus</span></a>
      <nav class="nav">
        <a href="/login">Dashboard</a>
        <a class="button" href="/login">Sign in</a>
      </nav>
    </header>
    <main>
      <section class="hero" aria-labelledby="install-title">
        <p class="eyebrow">Terminal setup</p>
        <h1 id="install-title">Install Proteus CLI</h1>
        <p class="lede">Run one command on macOS or Linux. Proteus installs into <code>~/.proteus</code>, adds the command to your PATH, then starts browser sign-in and local setup when a terminal is available.</p>
      </section>

      <section aria-label="Install command">
        <div class="command">
          <code id="install-command">${escapeHtml(command)}</code>
          <button class="copy" type="button" data-copy>Copy command</button>
        </div>
      </section>

      <section class="grid" aria-label="What the installer sets up">
        <div class="cell"><strong>Account connection</strong><span>The setup flow opens browser approval and stores the CLI session under your local Proteus home directory.</span></div>
        <div class="cell"><strong>Cloud or local agents</strong><span>Create persistent cloud agents or fully local agents from the same command line, then add aliases for the agents you use often.</span></div>
        <div class="cell"><strong>Your computer as execution</strong><span>Connect this machine as the desktop execution engine so agents can operate on local files and processes with your approval model.</span></div>
      </section>

      <div class="notes">
        <span>Need script-only install? Use <code>--no-setup</code>.</span>
      </div>
    </main>
  </div>
  <script>
    const button = document.querySelector('[data-copy]');
    const code = document.getElementById('install-command');
    if (button && code) {
      button.addEventListener('click', async () => {
        await navigator.clipboard.writeText(code.textContent || '');
        const previous = button.textContent;
        button.textContent = 'Copied';
        window.setTimeout(() => { button.textContent = previous; }, 1200);
      });
    }
  </script>
</body>
</html>`, installPageInit());
}

function installPageInit(): ResponseInit {
  return {
    headers: publicHtmlHeaders(),
  };
}

function installScriptResponse(origin: string, head = false): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail

PROTEUS_ORIGIN="\${PROTEUS_ORIGIN:-${origin}}"
PROTEUS_HOME="\${PROTEUS_HOME:-$HOME/.proteus}"
BIN_DIR="$PROTEUS_HOME/bin"
BIN_PATH="$BIN_DIR/proteus"
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
      PROTEUS_ORIGIN="\${1%/}"
      ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --update) ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
PROTEUS_ORIGIN="\${PROTEUS_ORIGIN%/}"

say() { printf '%s\\n' "$*"; }
die() { printf 'Proteus install error: %s\\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "macOS and Linux are supported by this installer." ;;
esac

if [ "$UNINSTALL" = "1" ]; then
  if [ -L /usr/local/bin/proteus ] && [ "$(readlink /usr/local/bin/proteus)" = "$BIN_PATH" ]; then
    rm -f /usr/local/bin/proteus 2>/dev/null || true
  fi
  rm -f "$BIN_PATH"
  if [ "$PURGE" = "1" ]; then rm -rf "$PROTEUS_HOME"; fi
  say "Proteus CLI removed."
  exit 0
fi

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found."
}

need curl
need tar
need mktemp

install_bun_if_missing() {
  if command -v bun >/dev/null 2>&1; then return 0; fi
  if [ "\${PROTEUS_INSTALL_BUN:-1}" = "0" ]; then
    die "Bun is required. Install Bun or rerun without PROTEUS_INSTALL_BUN=0."
  fi
  say "Installing Bun runtime..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun installation completed but bun is still not on PATH."
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
  env PROTEUS_HOME="$PROTEUS_HOME" "$@" < /dev/tty || rc=$?
  if [ "$rc" -ne 0 ]; then
    stty sane < /dev/tty 2>/dev/null || true
  fi
  return "$rc"
}

run_setup_if_requested() {
  if [ "$NO_SETUP" = "1" ]; then return 0; fi
  if ! has_tty; then
    say "Setup was not started because no interactive terminal is attached."
    say "Run: $BIN_PATH setup --origin $PROTEUS_ORIGIN"
    return 0
  fi
  say "Starting Proteus setup..."
  if [ "$YES" = "1" ]; then
    run_on_tty "$BIN_PATH" setup --origin "$PROTEUS_ORIGIN" --account-only --yes
  else
    run_on_tty "$BIN_PATH" setup --origin "$PROTEUS_ORIGIN" --account-only
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
      PROTEUS_HOME="$PROTEUS_HOME" "$BIN_PATH" connect --label "$CONNECT_LABEL"
    else
      PROTEUS_HOME="$PROTEUS_HOME" "$BIN_PATH" connect
    fi
  fi
}

prepare_cli_source() {
  say "Preparing Proteus CLI..."
  # </dev/null: under curl|bash our stdin is the unread remainder of this
  # script — a child that reads stdin would consume it mid-execution.
  help="$(PROTEUS_HOME="$PROTEUS_HOME" PROTEUS_REFRESH_SOURCE=1 "$BIN_PATH" --help </dev/null)" || die "Proteus CLI source setup failed."
  printf '%s\\n' "$help" | grep -Eq '^[[:space:]]+setup[[:space:]]' \
    || die "Downloaded Proteus CLI is missing setup. Retry after the deployment has finished."
}

mkdir -p "$BIN_DIR"
chmod 700 "$PROTEUS_HOME"
install_bun_if_missing

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Installing Proteus CLI..."
curl -fsSL "$PROTEUS_ORIGIN/downloads/proteus" -o "$tmp/proteus"
chmod 755 "$tmp/proteus"
mv "$tmp/proteus" "$BIN_PATH"
prepare_cli_source

if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  ln -sfn "$BIN_PATH" /usr/local/bin/proteus
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    profile=""
    shell_name="$(basename "\${SHELL:-}")"
    if [ "$shell_name" = "zsh" ]; then profile="$HOME/.zshrc";
    elif [ "$shell_name" = "bash" ]; then profile="$HOME/.bashrc";
    else profile="$HOME/.profile"; fi
    profile_line="export PATH=\\"$BIN_DIR:\\$PATH\\""
    if [ "$BIN_DIR" = "$HOME/.proteus/bin" ]; then
      profile_line='export PATH="$HOME/.proteus/bin:$PATH"'
    fi
    if touch "$profile" 2>/dev/null; then
      if grep -F "$BIN_DIR" "$profile" >/dev/null 2>&1; then
        :
      elif [ "$BIN_DIR" = "$HOME/.proteus/bin" ] && grep -F '$HOME/.proteus/bin' "$profile" >/dev/null 2>&1; then
        :
      else
        {
          printf '\\n# Proteus CLI\\n'
          printf '%s\\n' "$profile_line"
        } >> "$profile"
        say "Added $BIN_DIR to $profile."
      fi
    elif [ ! -w "$profile" ]; then
      say "Add $BIN_DIR to PATH to use proteus and agent aliases from any directory."
    fi
    export PATH="$BIN_DIR:$PATH"
    ;;
esac

say "Proteus installed."
run_setup_if_requested
run_connect_if_requested

if [ "$NO_SETUP" = "1" ] && [ "$CONNECT" != "1" ]; then
  say "Next:"
  say "  proteus setup --origin $PROTEUS_ORIGIN"
  say "  proteus create"
else
  say "Proteus CLI is ready."
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

async function cliDownloadAssetResponse(
  request: Request,
  env: Env,
  pathname: string,
  contentType: string,
  head = false,
): Promise<Response> {
  const assetUrl = new URL(pathname, request.url);
  const assetRes = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
  const headers = new Headers(assetRes.headers);
  headers.set('content-type', contentType);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cache-control', 'no-store');
  return new Response(head ? null : assetRes.body, { status: assetRes.status, headers });
}

function cliShimResponse(origin: string, head = false): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail

PROTEUS_HOME="\${PROTEUS_HOME:-$HOME/.proteus}"
SOURCE_ROOT="$PROTEUS_HOME/source"
SRC_DIR="$SOURCE_ROOT/current"
TARBALL_URL="\${PROTEUS_SOURCE_TARBALL:-${origin}${CLI_SOURCE_TARBALL_PATH}}"
# Pinned checksum override; when unset, the published <tarball>.sha256 asset
# is fetched and verification is mandatory.
TARBALL_SHA256="\${PROTEUS_SOURCE_SHA256:-}"

need_bun() {
  if command -v bun >/dev/null 2>&1; then return 0; fi
  echo "Bun is required for this Proteus CLI build."
  echo "Run the installer again so it can install Bun, or install Bun from https://bun.sh."
  exit 1
}

die() {
  echo "Proteus update error: $*" >&2
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
    die "sha256sum or shasum is required to verify the Proteus source download."
  fi
  [ "$actual" = "$expected" ] || die "Source checksum mismatch."
}

refresh_source() {
  mkdir -p "$SOURCE_ROOT"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL "$TARBALL_URL" -o "$tmp/proteus.tar.gz"
  verify_tarball "$tmp/proteus.tar.gz"
  mkdir -p "$tmp/extract"
  tar -xzf "$tmp/proteus.tar.gz" -C "$tmp/extract"
  extracted="$(find "$tmp/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$extracted" ] || die "Source archive did not contain a project directory."
  rm -rf "$SRC_DIR"
  mv "$extracted" "$SRC_DIR"
}

need_bun

case "\${1:-}" in
  update|upgrade) PROTEUS_REFRESH_SOURCE=1 ;;
esac

if [ "\${PROTEUS_REFRESH_SOURCE:-0}" = "1" ] || [ ! -f "$SRC_DIR/packages/cli/bin/cli.ts" ]; then
  refresh_source
fi

cd "$SRC_DIR"
if [ ! -d node_modules ]; then
  bun install --frozen-lockfile
fi
exec bun run packages/cli/bin/cli.ts "$@"
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
 *  everything else (D1 outage, UserDO failure, …) is a real 500. */
function cliAuthError(e: unknown): Response {
  if (e instanceof RateLimitError) return err(429, e.message);
  if (e instanceof CliAuthCodeError) return err(400, e.message);
  return err(500, e instanceof Error ? e.message : String(e));
}

function accessError(e: unknown, request?: Request): Response {
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
  return err(500, e instanceof Error ? e.message : String(e));
}

function html(title: string, body: string, status = 200, init: ResponseInit = {}): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --surface: #18181b;
      --ink: #fafafa;
      --muted: #a1a1aa;
      --line: rgba(255, 255, 255, 0.08);
      --accent: #a78bfa;
      --accent-soft: rgba(139, 92, 246, 0.12);
      --warning: #d29922;
    }
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: var(--bg); color: var(--ink); display: grid; min-height: 100vh; place-items: center; letter-spacing: 0; }
    main { width: min(440px, calc(100vw - 32px)); padding: 32px; border: 1px solid var(--line); background: var(--surface); }
    h1 { font-size: 22px; font-weight: 650; margin: 0 0 12px; }
    p { line-height: 1.5; color: var(--muted); }
    dl { display: grid; gap: 10px; margin: 22px 0; }
    dl > div { display: flex; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
    dt { color: var(--muted); }
    dd { margin: 0; text-align: right; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--warning); }
    button { appearance: none; min-height: 38px; border: 1px solid rgba(167, 139, 250, 0.62); padding: 0 14px; background: var(--accent-soft); color: var(--ink); font-weight: 650; cursor: pointer; }
    .muted { font-size: 13px; color: var(--muted); }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`, {
    ...init,
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function csrfCookie(value: string): string {
  return `proteus_cli_auth_csrf=${value}; Path=/cli/auth; Max-Age=600; HttpOnly; Secure; SameSite=Strict`;
}

function clearCsrfCookie(): string {
  return 'proteus_cli_auth_csrf=; Path=/cli/auth; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
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

