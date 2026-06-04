import type { AccessIdentity } from '../auth/access.js';
import { AccessAuthError, authenticateRequest } from '../auth/access.js';
import type { CLIAuthDO } from './auth-do.js';
import type { OrchestratorAgent } from '../orchestrator.js';
import type { UserDO } from '../user/user-do.js';

interface CliIdentity {
  userId: string;
  email: string;
  displayName: string | null;
  token: string;
  tokenHash: string;
  userDO: DurableObjectStub<UserDO>;
}

const GITHUB_REPO_TARBALL = 'https://github.com/AshishKumar4/Proteus/archive/refs/heads/main.tar.gz';

export async function handleCliRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === '/install.sh' && method === 'GET') {
    return installScriptResponse(url.origin);
  }
  if (url.pathname === '/downloads/proteus' && method === 'GET') {
    return cliShimResponse();
  }

  if (url.pathname === '/cli/auth' && method === 'GET') {
    return approveFromBrowser(request, env);
  }

  if (!url.pathname.startsWith('/api/cli')) return null;
  const path = url.pathname.slice('/api/cli'.length) || '/';

  if (path === '/auth/start' && method === 'POST') {
    const body = await safeJson<{ deviceName?: string }>(request);
    const stub = authDO(env);
    return json(await stub.start(url.origin, body?.deviceName));
  }

  if (path === '/auth/poll' && method === 'POST') {
    const body = await safeJson<{ deviceToken?: string }>(request);
    if (!body?.deviceToken) return err(400, 'deviceToken required');
    return json(await authDO(env).poll(body.deviceToken));
  }

  if (path === '/auth/approve' && method === 'POST') {
    let identity: AccessIdentity;
    try { identity = await authenticateRequest(request, env); }
    catch (e) { return accessError(e); }
    const body = await safeJson<{ userCode?: string }>(request);
    if (!body?.userCode) return err(400, 'userCode required');
    try { return json(await authDO(env).approve(body.userCode, identity)); }
    catch (e) { return err(400, (e as Error).message); }
  }

  const cli = await authenticateCli(request, env);
  if (cli instanceof Response) return cli;

  if (path === '/me' && method === 'GET') {
    return json({
      user: { id: cli.userId, email: cli.email, displayName: cli.displayName },
      tokenHash: cli.tokenHash,
    });
  }

  if (path === '/logout' && method === 'POST') {
    await cli.userDO.revokeCliTokenHash(cli.tokenHash);
    return json({ ok: true });
  }

  if (path === '/agents' && method === 'GET') {
    return json(await cli.userDO.listAgents());
  }

  if (path === '/agents' && method === 'POST') {
    const body = await safeJson<{ name?: string; displayName?: string; purpose?: string }>(request);
    if (!body?.name) return err(400, 'name required');
    try {
      const entry = await cli.userDO.registerAgent(body.name, body.displayName, body.purpose);
      const orchestrator = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(body.name)) as DurableObjectStub<OrchestratorAgent>;
      await orchestrator.claimOwner(cli.userId);
      return json(entry, { status: 201 });
    } catch (e) {
      return err(400, (e as Error).message);
    }
  }

  const turnMatch = path.match(/^\/agents\/([^/]+)\/turn$/);
  if (turnMatch && method === 'POST') {
    const name = decodeURIComponent(turnMatch[1]);
    if (!(await cli.userDO.hasAgent(name))) return err(404, `Agent ${name} not found.`);
    const body = await safeJson<{ prompt?: string; cwd?: string }>(request);
    if (!body?.prompt) return err(400, 'prompt required');
    const orchestrator = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(name)) as unknown as {
      claimOwner(userId: string): Promise<unknown>;
      cliTurn(input: { prompt: string; cwd?: string; userId: string }): Promise<unknown>;
    };
    try {
      await orchestrator.claimOwner(cli.userId);
      return json(await orchestrator.cliTurn({ prompt: body.prompt, cwd: body.cwd, userId: cli.userId }));
    } catch (e) {
      return err(500, (e as Error).message);
    }
  }

  if (path === '/devices' && method === 'GET') {
    return json(await cli.userDO.listDevices());
  }
  if (path === '/devices' && method === 'POST') {
    const body = await safeJson<{ label?: string }>(request);
    const { deviceId, token } = await cli.userDO.registerDevice(body?.label);
    const installCommand = `PROTEUS_USER=${cli.userId} PROTEUS_TOKEN=${token} curl -fsSL ${url.origin}/pc/install | bash`;
    return json({ deviceId, token, userId: cli.userId, origin: url.origin, installCommand }, { status: 201 });
  }

  return err(404, `No such CLI route: ${method} ${path}`);
}

function authDO(env: Env): DurableObjectStub<CLIAuthDO> {
  return env.CLIAuthDO.get(env.CLIAuthDO.idFromName('primary')) as DurableObjectStub<CLIAuthDO>;
}

async function authenticateCli(request: Request, env: Env): Promise<CliIdentity | Response> {
  const token = readBearer(request);
  if (!token) return err(401, 'Missing Authorization: Bearer <token>');
  const userId = parseCliTokenUserId(token);
  if (!userId) return err(401, 'Malformed CLI token');
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
  const verified = await userDO.verifyCliToken(token);
  if (!verified.ok || !verified.user || !verified.tokenHash) {
    return err(401, verified.error ?? 'Invalid CLI token');
  }
  return {
    userId: verified.user.id,
    email: verified.user.email,
    displayName: verified.user.displayName,
    token,
    tokenHash: verified.tokenHash,
    userDO,
  };
}

function readBearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

function parseCliTokenUserId(token: string): string | null {
  const match = /^ptc_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(token);
  return match?.[1] ?? null;
}

async function approveFromBrowser(request: Request, env: Env): Promise<Response> {
  let identity: AccessIdentity;
  try { identity = await authenticateRequest(request, env); }
  catch (e) { return accessError(e); }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return html('Proteus CLI Auth', '<p>Missing CLI auth code.</p>', 400);
  try {
    await authDO(env).approve(code, identity);
    return html('Proteus CLI Auth', '<p>CLI connected. You can return to your terminal.</p>');
  } catch (e) {
    return html('Proteus CLI Auth', `<p>${escapeHtml((e as Error).message)}</p>`, 400);
  }
}

function installScriptResponse(origin: string): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail

PROTEUS_ORIGIN="\${PROTEUS_ORIGIN:-${origin}}"
PROTEUS_HOME="\${PROTEUS_HOME:-$HOME/.proteus}"
BIN_DIR="$PROTEUS_HOME/bin"
mkdir -p "$BIN_DIR"
chmod 700 "$PROTEUS_HOME"

echo "Installing Proteus CLI..."
curl -fsSL "$PROTEUS_ORIGIN/downloads/proteus" -o "$BIN_DIR/proteus"
chmod +x "$BIN_DIR/proteus"

if [ -w /usr/local/bin ] && [ ! -e /usr/local/bin/proteus ]; then
  ln -s "$BIN_DIR/proteus" /usr/local/bin/proteus
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to PATH to use proteus and agent aliases from any directory." ;;
esac

echo "Proteus installed."
echo "Next:"
echo "  proteus auth --origin $PROTEUS_ORIGIN"
echo "  proteus create"
`;
  return new Response(script, {
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8' },
  });
}

function cliShimResponse(): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail

PROTEUS_HOME="\${PROTEUS_HOME:-$HOME/.proteus}"
SRC_DIR="$PROTEUS_HOME/source/Proteus-main"

need_bun() {
  if command -v bun >/dev/null 2>&1; then return 0; fi
  echo "Bun is required for this Proteus CLI build."
  echo "Install Bun from https://bun.sh, then run this command again."
  exit 1
}

need_bun

if [ ! -f "$SRC_DIR/packages/cli/bin/cli.ts" ]; then
  mkdir -p "$PROTEUS_HOME/source"
  tmp="$(mktemp -d)"
  curl -fsSL "${GITHUB_REPO_TARBALL}" -o "$tmp/proteus.tar.gz"
  tar -xzf "$tmp/proteus.tar.gz" -C "$PROTEUS_HOME/source"
  rm -rf "$tmp"
fi

cd "$SRC_DIR"
if [ ! -d node_modules ]; then
  bun install --frozen-lockfile
fi
exec bun run packages/cli/bin/cli.ts "$@"
`;
  return new Response(script, {
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8' },
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

function accessError(e: unknown): Response {
  if (e instanceof AccessAuthError) return err(e.status, e.message);
  return err(500, e instanceof Error ? e.message : String(e));
}

function html(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f1214; color: #f4f1ea; display: grid; min-height: 100vh; place-items: center; }
    main { max-width: 440px; padding: 32px; }
    h1 { font-size: 22px; font-weight: 650; margin: 0 0 12px; }
    p { line-height: 1.5; color: #c9c1b5; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function safeJson<T = unknown>(request: Request): Promise<T | null> {
  try { return (await request.json()) as T; } catch { return null; }
}
