import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfiguredOAuthProviders, listConfiguredOAuthProviders } from '../src/auth/providers.js';
import { buildCliInstallCommand } from '../src/cli/install-command.js';
import { handleCliRequest } from '../src/cli/routes.js';

const root = join(import.meta.dir, '..');

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('auth and desktop security invariants', () => {
  test('browser CLI auth approval is an explicit POST, not GET side effect', () => {
    const routes = source('src/cli/routes.ts');
    expect(routes).toContain("url.pathname === '/cli/auth' && method === 'GET'");
    expect(routes).toContain("url.pathname === '/cli/auth' && method === 'POST'");
    expect(routes).not.toContain("if (url.pathname === '/cli/auth' && method === 'GET') {\n    return approveFromBrowser");
  });

  test('dashboard and PC install paths do not expose PROTEUS_TOKEN setup commands', () => {
    const userRoutes = source('src/user/routes.ts');
    const cliRoutes = source('src/cli/routes.ts');
    const pcHandler = source('src/pc-handler.ts');
    expect(userRoutes).not.toContain('PROTEUS_TOKEN=');
    expect(cliRoutes).not.toContain('PROTEUS_TOKEN=');
    expect(pcHandler).not.toContain('PROTEUS_TOKEN=');
  });

  test('desktop WebSocket uses short-lived tickets instead of raw device tokens in the URL', () => {
    const pcHandler = source('src/pc-handler.ts');
    expect(pcHandler).toContain('/pc/connect-ticket');
    expect(pcHandler).toContain('ticket=');
    expect(pcHandler).not.toContain('&token=');
    expect(pcHandler).not.toContain('?user=U&token=T');
  });

  test('OAuth provider visibility requires both client id and secret', () => {
    expect(listConfiguredOAuthProviders({})).toEqual([]);
    expect(listConfiguredOAuthProviders({ GOOGLE_OAUTH_CLIENT_ID: 'gid' })).toEqual([]);
    expect(listConfiguredOAuthProviders({ GOOGLE_OAUTH_CLIENT_SECRET: 'gsec' })).toEqual([]);
    expect(listConfiguredOAuthProviders({
      GOOGLE_OAUTH_CLIENT_ID: 'gid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'gsec',
      GITHUB_OAUTH_CLIENT_ID: 'hid',
      GITHUB_OAUTH_CLIENT_SECRET: 'hsec',
      CLOUDFLARE_OAUTH_CLIENT_ID: 'cid',
      CLOUDFLARE_OAUTH_CLIENT_SECRET: 'csec',
    }).map((p) => p.id)).toEqual(['google', 'github', 'cloudflare']);
  });

  test('Cloudflare OAuth uses only the allowed user details scope', () => {
    const [provider] = getConfiguredOAuthProviders({
      CLOUDFLARE_OAUTH_CLIENT_ID: 'cid',
      CLOUDFLARE_OAUTH_CLIENT_SECRET: 'csec',
    });
    expect(provider.id).toBe('cloudflare');
    expect(provider.kind).toBe('oauth');
    expect(provider.scopes).toBe('user-details.read');
    expect(provider.scopes).not.toContain('openid');
  });

  test('browser UI uses app auth routes rather than Cloudflare Access logout/login URLs', () => {
    const sidebar = source('src/components/Sidebar.tsx');
    const triggers = source('src/pages/TriggersTab.tsx');
    const routes = source('src/auth/routes.ts');
    expect(sidebar).toContain('href="/logout"');
    expect(sidebar).not.toContain('/cdn-cgi/access/logout');
    expect(routes).toContain("url.searchParams.get('return_to') ?? '/'");
    expect(triggers).toContain("new URL('/login', window.location.origin)");
    expect(triggers).not.toContain('/cdn-cgi/access/login');
  });

  test('OAuth sessions are HttpOnly host cookies and state is server-side', () => {
    const routes = source('src/auth/routes.ts');
    const d1Store = source('src/auth/d1-store.ts');
    expect(routes).toContain('__Host-proteus_session');
    expect(routes).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(d1Store).toContain('DELETE FROM auth_oauth_states');
    expect(d1Store).toContain('RETURNING provider, code_verifier');
  });

  test('browser and CLI auth use D1 Sessions for replica-aware state, not auth Durable Objects', () => {
    const wrangler = source('wrangler.jsonc');
    const access = source('src/auth/session.ts');
    const d1Store = source('src/auth/d1-store.ts');
    const cliRoutes = source('src/cli/routes.ts');
    expect(wrangler).toContain('"binding": "AUTH_DB"');
    expect(wrangler).not.toContain('CLIAuthDO');
    expect(wrangler).not.toContain('AuthDO');
    expect(wrangler).not.toContain('"name": "AuthDO"');
    expect(access).toContain('verifySession(env.AUTH_DB');
    expect(cliRoutes).toContain('startCliAuth(env');
    expect(cliRoutes).not.toContain('authDO(env)');
    expect(d1Store).toContain("db.withSession(bookmark || 'first-unconstrained')");
    expect(d1Store).toContain("db.withSession('first-primary')");
    expect(d1Store).not.toContain('last_seen_at');
  });

  test('browser auth no longer accepts Cloudflare Access as a session', () => {
    const access = source('src/auth/session.ts');
    const wrangler = source('wrangler.jsonc');
    const health = source('src/health-route.ts');
    expect(access).not.toContain('readAccessToken');
    expect(access).not.toContain('verifyAccessJwt');
    expect(access).not.toContain('CF_Authorization');
    expect(wrangler).not.toContain('CF_ACCESS_TEAM_DOMAIN');
    expect(wrangler).not.toContain('CF_ACCESS_AUD');
    expect(health).not.toContain('cf-access-rollout-fallback');
  });

  test('root has a public landing route before the authenticated SPA fallback', () => {
    const server = source('src/server.ts');
    const landing = source('src/landing-route.ts');
    expect(server).toContain('handleLandingRequest(request, env)');
    expect(server.indexOf('handleLandingRequest(request, env)')).toBeLessThan(server.indexOf('authenticateRequest(request, env)'));
    expect(landing).toContain("url.pathname !== '/'");
    expect(landing).toContain('Sign in');
    expect(landing).toContain('href="#install"');
    expect(landing).toContain('data-install-toggle');
    expect(landing).toContain('landing-install-command');
    expect(landing).not.toContain('href="/install.sh"');
    expect(landing).not.toContain('href="/install"');
    expect(landing).not.toContain('/api/health">Status');
    expect(landing).not.toContain('OAuth sign-in required for the dashboard.');
  });

  test('browser install page is HTML while the terminal installer stays raw shell', async () => {
    const installPage = await handleCliRequest(new Request('https://proteus.example.com/install'), {} as Env);
    expect(installPage?.status).toBe(200);
    expect(installPage?.headers.get('content-type')).toContain('text/html');
    const html = await installPage!.text();
    expect(html).toContain('Install Proteus CLI');
    expect(html).toContain('curl -fsSL');
    expect(html).toContain('https://proteus.example.com/install.sh');
    expect(html).toContain('| bash');
    expect(html).not.toContain('OAuth sign-in required for the dashboard.');
    expect(html).not.toContain('View the raw installer');
    expect(html).not.toContain('href="/install.sh"');

    const installScript = await handleCliRequest(new Request('https://proteus.example.com/install.sh'), {} as Env);
    expect(installScript?.status).toBe(200);
    expect(installScript?.headers.get('content-type')).toContain('text/x-shellscript');
    const script = await installScript!.text();
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('PROTEUS_REFRESH_SOURCE=1 "$BIN_PATH" --help');
    expect(script).toContain('grep -F "setup"');
  });

  test('CLI shim does not hardcode GitHub archive directory names and supports checksum verification', async () => {
    const shim = await handleCliRequest(new Request('https://proteus.example.com/downloads/proteus'), {} as Env);
    expect(shim?.status).toBe(200);
    const script = await shim!.text();
    expect(script).toContain('SRC_DIR="$SOURCE_ROOT/current"');
    expect(script).not.toContain('Proteus-main');
    expect(script).toContain('PROTEUS_SOURCE_SHA256');
    expect(script).toContain('Source checksum mismatch');
  });

  test('supervise automation copy matches the live timer reactor', () => {
    const supervise = source('src/pages/SupervisePage.tsx');
    expect(supervise).toContain('next_fire_at');
    expect(supervise).toContain('fire_count');
    expect(supervise).not.toContain("The event reactor isn't wired into live turns yet");
    expect(supervise).not.toContain("triggers are registered but don't auto-drive runs");
  });

  test('CLI setup commands are one-command defaults without embedded auth tokens', () => {
    expect(buildCliInstallCommand({ origin: 'https://proteus.example.com/' }))
      .toBe("curl -fsSL 'https://proteus.example.com/install.sh' | bash");
    expect(buildCliInstallCommand({
      origin: 'https://proteus.example.com',
      setup: false,
      connect: true,
      label: "Ashish's Mac",
    })).toBe("curl -fsSL 'https://proteus.example.com/install.sh' | bash -s -- --no-setup --connect --label 'Ashish'\\''s Mac'");
  });
});
