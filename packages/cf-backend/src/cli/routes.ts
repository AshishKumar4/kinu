import type { AuthIdentity } from '../auth/session.js';
import { AuthError, authenticateRequest } from '../auth/session.js';
import type { OrchestratorAgent } from '../orchestrator.js';
import type { UserDO } from '../user/user-do.js';
import { approveCliAuth, inspectCliAuth, pollCliAuth, startCliAuth } from './auth-store.js';
import { buildCliInstallCommand } from './install-command.js';

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

  if (url.pathname === '/install' && (method === 'GET' || method === 'HEAD')) {
    return method === 'HEAD' ? new Response(null, installPageInit()) : installPageResponse(url.origin);
  }
  if (url.pathname === '/install.sh' && method === 'GET') {
    return installScriptResponse(url.origin);
  }
  if (url.pathname === '/downloads/proteus' && method === 'GET') {
    return cliShimResponse();
  }

  if (url.pathname === '/cli/auth' && method === 'GET') {
    return renderBrowserApproval(request, env);
  }
  if (url.pathname === '/cli/auth' && method === 'POST') {
    return approveFromBrowser(request, env);
  }

  if (!url.pathname.startsWith('/api/cli')) return null;
  const path = url.pathname.slice('/api/cli'.length) || '/';

  if (path === '/auth/start' && method === 'POST') {
    const body = await safeJson<{ deviceName?: string }>(request);
    try {
      return json(await startCliAuth(env, url.origin, approvalOrigin(env, url), body?.deviceName, clientKey(request)));
    } catch (e) {
      return err(429, (e as Error).message);
    }
  }

  if (path === '/auth/poll' && method === 'POST') {
    const body = await safeJson<{ deviceToken?: string }>(request);
    if (!body?.deviceToken) return err(400, 'deviceToken required');
    try {
      return json(await pollCliAuth(env, body.deviceToken, clientKey(request)));
    } catch (e) {
      return err(429, (e as Error).message);
    }
  }

  if (path === '/auth/approve' && method === 'POST') {
    let identity: AuthIdentity;
    try { identity = await authenticateRequest(request, env); }
    catch (e) { return accessError(e, request); }
    const body = await safeJson<{ userCode?: string }>(request);
    if (!body?.userCode) return err(400, 'userCode required');
    try { return json(await approveCliAuth(env, body.userCode, identity, clientKey(request))); }
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
    return json({ deviceId, token, userId: cli.userId, origin: url.origin }, { status: 201 });
  }

  return err(404, `No such CLI route: ${method} ${path}`);
}

function approvalOrigin(env: Env, url: URL): string {
  return (env.CLI_APPROVAL_ORIGIN || url.origin).replace(/\/+$/, '');
}

function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown';
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
  if (!csrf || !cookieCsrf || !constantTimeEqual(csrf, cookieCsrf)) {
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
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    },
  };
}

function installScriptResponse(origin: string): Response {
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

has_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
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
    PROTEUS_HOME="$PROTEUS_HOME" "$BIN_PATH" setup --origin "$PROTEUS_ORIGIN" --yes < /dev/tty
  else
    PROTEUS_HOME="$PROTEUS_HOME" "$BIN_PATH" setup --origin "$PROTEUS_ORIGIN" < /dev/tty
  fi
}

run_connect_if_requested() {
  if [ "$CONNECT" != "1" ]; then return 0; fi
  if has_tty; then
    if [ -n "$CONNECT_LABEL" ]; then
      PROTEUS_HOME="$PROTEUS_HOME" "$BIN_PATH" connect --label "$CONNECT_LABEL" < /dev/tty
    else
      PROTEUS_HOME="$PROTEUS_HOME" "$BIN_PATH" connect < /dev/tty
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
  help="$(PROTEUS_HOME="$PROTEUS_HOME" PROTEUS_REFRESH_SOURCE=1 "$BIN_PATH" --help)" || die "Proteus CLI source setup failed."
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
  return new Response(script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

function cliShimResponse(): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail

PROTEUS_HOME="\${PROTEUS_HOME:-$HOME/.proteus}"
SOURCE_ROOT="$PROTEUS_HOME/source"
SRC_DIR="$SOURCE_ROOT/current"
TARBALL_URL="\${PROTEUS_SOURCE_TARBALL:-${GITHUB_REPO_TARBALL}}"
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
  [ -n "$TARBALL_SHA256" ] || return 0
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    die "PROTEUS_SOURCE_SHA256 is set but no sha256sum or shasum command was found."
  fi
  [ "$actual" = "$TARBALL_SHA256" ] || die "Source checksum mismatch."
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
