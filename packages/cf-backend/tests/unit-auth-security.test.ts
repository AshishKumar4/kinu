import { describe, expect, test } from 'bun:test';
import { asFetchFunction } from '@kinu.run/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloudflareTokenJsonToResponse, cloudflareUserResultToProfile } from '../src/auth/routes';
import { getConfiguredOAuthProviders, listConfiguredOAuthProviders } from '../src/auth/providers';
import {
  CLOUDFLARE_WORKERS_AI_SCOPES,
  accountIdFromCloudflareCredential,
  cloudflareAIGatewayId,
  cloudflareAccountsFromCredential,
  cloudflareTokenToCredential,
  cloudflareWorkersAIBaseURL,
  isCloudflareCredentialUsable,
  withCloudflareAccount,
} from '../src/lib/cloudflare-oauth';
import { buildCliInstallCommand } from '../src/cli/install-command';
import { handleCliRequest } from '../src/cli/routes';
import { sanitizeReturnTo } from '../src/auth/store';

const root = join(import.meta.dir, '..');

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function publicRouteEnv(): Env {
  const env: Partial<Env> = {};
  // SAFETY: These public static routes return before reading any Worker binding.
  return env as Env;
}

const PUBLIC_ROUTE_ENV = publicRouteEnv();

describe('auth and desktop security invariants', () => {
  test('browser CLI auth approval is an explicit POST, not GET side effect', () => {
    const routes = source('src/cli/routes.ts');
    expect(routes).toContain("url.pathname === '/cli/auth' && method === 'GET'");
    expect(routes).toContain("url.pathname === '/cli/auth' && method === 'POST'");
    expect(routes).not.toContain("if (url.pathname === '/cli/auth' && method === 'GET') {\n    return approveFromBrowser");
  });

  test('dashboard and PC install paths do not expose KINU_TOKEN setup commands', () => {
    const userRoutes = source('src/user/routes.ts');
    const cliRoutes = source('src/cli/routes.ts');
    const pcHandler = source('src/pc-handler.ts');
    expect(userRoutes).not.toContain('KINU_TOKEN=');
    expect(cliRoutes).not.toContain('KINU_TOKEN=');
    expect(pcHandler).not.toContain('KINU_TOKEN=');
  });

  test('desktop WebSocket uses short-lived tickets instead of raw device tokens in the URL', () => {
    const pcHandler = source('src/pc-handler.ts');
    expect(pcHandler).toContain('/pc/connect-ticket');
    expect(pcHandler).toContain('ticket=');
    expect(pcHandler).not.toContain('&token=');
    expect(pcHandler).not.toContain('?user=U&token=T');
  });

  test('CLI agent websocket uses scoped tickets and has no local-turn HTTP bridge', () => {
    const server = source('src/server.ts');
    const cliRoutes = source('src/cli/routes.ts');
    const userSchema = source('src/user/schema.ts');
    const orchestrator = source('src/orchestrator.ts');
    expect(cliRoutes).toContain('/connect-ticket');
    expect(userSchema).toContain('cli_agent_connect_tickets');
    expect(server).toContain('verifyCliAgentConnectTicket');
    expect(server).toContain("url.searchParams.delete('ticket')");
    expect(server).not.toContain('looksInteractive');
    expect(server).not.toContain('registerWorkspace(agentName');
    expect(cliRoutes).not.toContain('/local-turn/prepare');
    expect(cliRoutes).not.toContain('/local-turn/tool');
    expect(cliRoutes).not.toContain('/local-turn/commit');
    expect(orchestrator).not.toContain('cliPrepareLocalTurn');
    expect(orchestrator).not.toContain('cliInvokeLocalTool');
    expect(orchestrator).not.toContain('cliCommitLocalTurn');
    expect(orchestrator).not.toContain('async cliTurn');
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

  test('Cloudflare OAuth requests user billing scopes for Workers AI', () => {
    const [provider] = getConfiguredOAuthProviders({
      CLOUDFLARE_OAUTH_CLIENT_ID: 'cid',
      CLOUDFLARE_OAUTH_CLIENT_SECRET: 'csec',
    });
    const routes = source('src/auth/routes.ts');
    const userDO = source('src/user/user-do.ts');
    expect(provider.id).toBe('cloudflare');
    expect(provider.kind).toBe('oauth');
    expect(provider.scopes).toBe(CLOUDFLARE_WORKERS_AI_SCOPES);
    expect(provider.scopes).toContain('account-settings.read');
    expect(provider.scopes).toContain('ai.write');
    expect(provider.scopes).toContain('aig.run');
    // Without offline_access dash.cloudflare.com never issues a refresh
    // token, so the credential dies at access-token expiry and the user is
    // forced to reconnect Workers AI on every visit.
    expect(provider.scopes).toContain('offline_access');
    expect(provider.scopes).not.toContain('openid');
    expect(routes).toContain('processGenericTokenEndpointResponse');
    expect(routes).toContain('attachCloudflareWorkersAI');
    expect(routes).toContain('DEFAULT_WORKERS_AI_MODEL_SPEC');
    // Identity must not depend on billing: the session is created before the
    // Workers AI credential is fetched, so a missing account or a Cloudflare
    // API outage cannot turn a valid sign-in into a 400.
    expect(routes.indexOf('const session = await createSession'))
      .toBeLessThan(routes.indexOf('await attachCloudflareWorkersAI'));
    expect(routes).not.toContain('Cloudflare credential attachment skipped');
    expect(userDO).toContain("'cf-aig-gateway-id'");
  });

  test('Cloudflare OAuth token attachment stores an account-backed Workers AI credential', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async (input) => {
      expect(String(input)).toBe('https://api.cloudflare.com/client/v4/accounts');
      return new Response(JSON.stringify({
        success: true,
        result: [{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access',
        refresh_token: 'cf-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });
      expect(credential.kind).toBe('oauth');
      expect(credential.accessToken).toBe('cf-access');
      expect(credential.metadata?.accountId).toBe('abc123abc123abc123abc123abc123ab');
      expect(credential.metadata?.scopes).toEqual(CLOUDFLARE_WORKERS_AI_SCOPES.split(' '));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Cloudflare OAuth token attachment accepts access-token-only responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async (input) => {
      expect(String(input)).toBe('https://api.cloudflare.com/client/v4/accounts');
      return new Response(JSON.stringify({
        success: true,
        result: [{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access',
        token_type: 'bearer',
        expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });
      expect(credential.kind).toBe('oauth');
      expect(credential.accessToken).toBe('cf-access');
      expect(credential.refreshToken).toBeUndefined();
      expect(credential.metadata?.accountId).toBe('abc123abc123abc123abc123abc123ab');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a token that sees no Cloudflare account still yields a credential, just an unusable one', async () => {
    // Signing in must not depend on Workers AI billing: a user with no
    // Cloudflare account gets an identity and the "connect Workers AI" notice,
    // not a 400 that locks them out of the product.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(
      JSON.stringify({ success: true, result: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access',
        token_type: 'bearer',
        expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });
      expect(credential.accessToken).toBe('cf-access');
      expect(credential.metadata?.accountId).toBeUndefined();
      expect(isCloudflareCredentialUsable(credential)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a multi-account token records every account and selects the first', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(JSON.stringify({
      success: true,
      result: [
        { id: 'aaa111aaa111aaa111aaa111aaa111aa', name: 'Personal' },
        { id: 'bbb222bbb222bbb222bbb222bbb222bb', name: 'Employer' },
        { id: 'not-an-account-id', name: 'Junk' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access', token_type: 'bearer', expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });
      expect(cloudflareAccountsFromCredential(credential)).toEqual([
        { id: 'aaa111aaa111aaa111aaa111aaa111aa', name: 'Personal' },
        { id: 'bbb222bbb222bbb222bbb222bbb222bb', name: 'Employer' },
      ]);
      expect(accountIdFromCloudflareCredential(credential)).toBe('aaa111aaa111aaa111aaa111aaa111aa');

      // Switching account only rewrites the selection — the token, refresh
      // token and the discovered list are untouched.
      const switched = withCloudflareAccount(credential, 'bbb222bbb222bbb222bbb222bbb222bb');
      expect(accountIdFromCloudflareCredential(switched)).toBe('bbb222bbb222bbb222bbb222bbb222bb');
      expect(switched.metadata?.accountName).toBe('Employer');
      expect(switched.accessToken).toBe(credential.accessToken);
      expect(cloudflareAccountsFromCredential(switched)).toEqual(cloudflareAccountsFromCredential(credential));
      expect(cloudflareWorkersAIBaseURL('bbb222bbb222bbb222bbb222bbb222bb'))
        .toBe('https://api.cloudflare.com/client/v4/accounts/bbb222bbb222bbb222bbb222bbb222bb/ai/v1');

      expect(() => withCloudflareAccount(credential, 'ccc333ccc333ccc333ccc333ccc333cc')).toThrow(/not one this login can see/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a single-account token needs no selection and lists just that account', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(JSON.stringify({
      success: true, result: [{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access', token_type: 'bearer', expires_in: 3600,
      });
      expect(cloudflareAccountsFromCredential(credential))
        .toEqual([{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }]);
      expect(isCloudflareCredentialUsable(credential)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Sign-in was once gated on this lookup and broke login for everyone. A
  // failing accounts API used to throw out of cloudflareTokenToCredential, so
  // setCredential never ran and the refresh token was lost with it.
  test('an accounts API failure still yields a storable credential', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(
      JSON.stringify({ success: false, errors: [{ message: 'Service unavailable' }] }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));
    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access', refresh_token: 'cf-refresh', token_type: 'bearer', expires_in: 3600,
      });
      expect(credential.accessToken).toBe('cf-access');
      expect(credential.refreshToken).toBe('cf-refresh');
      expect(credential.metadata?.accountId).toBeUndefined();
      expect(cloudflareAccountsFromCredential(credential)).toEqual([]);
      expect(isCloudflareCredentialUsable(credential)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // A login that predates account recording still has to render a picker.
  test('a credential stored before accounts were recorded reports its selected account', () => {
    expect(cloudflareAccountsFromCredential({
      kind: 'oauth', accessToken: 'cf-access',
      metadata: { accountId: 'abc123abc123abc123abc123abc123ab', accountName: 'User Account' },
    })).toEqual([{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }]);
  });

  test('expired access-token-only Cloudflare credentials stop advertising Workers AI', () => {
    const base = {
      kind: 'oauth' as const,
      accessToken: 'cf-access',
      metadata: { accountId: 'abc123abc123abc123abc123abc123ab' },
    };
    expect(isCloudflareCredentialUsable({ ...base, expiresAt: Date.now() + 3_600_000 })).toBe(true);
    expect(isCloudflareCredentialUsable({ ...base, expiresAt: Date.now() - 1_000 })).toBe(false);
    expect(isCloudflareCredentialUsable({ ...base, refreshToken: 'cf-refresh', expiresAt: Date.now() - 1_000 })).toBe(true);
  });

  test('Cloudflare AI Gateway defaults to the account default gateway unless configured', () => {
    expect(cloudflareAIGatewayId({})).toBe('default');
    expect(cloudflareAIGatewayId({ CLOUDFLARE_AI_GATEWAY_ID: '  custom-gateway  ' })).toBe('custom-gateway');
  });

  test('Cloudflare OAuth profile uses the Cloudflare API user shape', () => {
    expect(cloudflareUserResultToProfile({
      id: 'cf-user-1',
      email: 'ashish@example.com',
      first_name: null,
      last_name: null,
      username: 'ashish',
    })).toEqual({
      provider: 'cloudflare',
      providerSub: 'cf-user-1',
      email: 'ashish@example.com',
      emailVerified: true,
      displayName: 'ashish',
    });

    expect(cloudflareUserResultToProfile({
      id: 'cf-user-2',
      email: 'person@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
    }).displayName).toBe('Ada Lovelace');
  });

  test('Cloudflare OAuth token parser accepts Cloudflare token response variants', () => {
    expect(cloudflareTokenJsonToResponse({
      access_token: 'cf-access',
      token_type: 'bearer',
      expires_in: '900',
      scope: ['user-details.read'],
      resource: 'https://dash.cloudflare.com',
    })).toEqual({
      access_token: 'cf-access',
      token_type: 'bearer',
      expires_in: 900,
      scope: 'user-details.read',
      resource: 'https://dash.cloudflare.com',
    });

    expect(cloudflareTokenJsonToResponse({
      access_token: 'cf-access',
    })).toMatchObject({
      access_token: 'cf-access',
      token_type: 'bearer',
    });
  });

  test('browser UI uses app auth routes rather than Cloudflare Access logout/login URLs', () => {
    const sidebar = source('src/components/Sidebar.tsx');
    const supervise = source('src/pages/SupervisePage.tsx'); // webhook step-up login lives here
    const routes = source('src/auth/routes.ts');
    expect(sidebar).toContain('href="/logout"');
    expect(sidebar).not.toContain('/cdn-cgi/access/logout');
    expect(routes).toContain("url.searchParams.get('return_to') ?? '/'");
    expect(supervise).toContain('new URL("/login", window.location.origin)');
    expect(supervise).not.toContain('/cdn-cgi/access/login');
  });

  test('OAuth sessions are HttpOnly host cookies and state is server-side', () => {
    const routes = source('src/auth/routes.ts');
    const session = source('src/auth/session.ts');
    const store = source('src/auth/store.ts');
    // The cookie name has exactly one home (auth/session.ts); routes reuse it.
    expect(session).toContain("export const SESSION_COOKIE_NAME = '__Host-kinu_session'");
    expect(routes).toContain('SESSION_COOKIE_NAME');
    expect(routes).not.toContain('__Host-kinu_session');
    expect(routes).toContain('HttpOnly; Secure; SameSite=Lax');
    // The browser holds a handle, never the state: the state token is hashed
    // into the key, and the record is burned on the way out.
    expect(store).toContain('`oauth-state:${await sha256Hex(state)}`');
    expect(store).toContain('await kv.delete(key)');
  });

  test('browser and CLI auth keep expiring state in KV and durable identity in the UserDO', () => {
    const wrangler = source('wrangler.jsonc');
    const session = source('src/auth/session.ts');
    const store = source('src/auth/store.ts');
    const cliRoutes = source('src/cli/routes.ts');
    expect(wrangler).toContain('"binding": "AUTH_KV"');
    // No D1 anywhere, and no auth Durable Object either: a singleton DO in
    // front of every sign-in is the chokepoint this deployment removed.
    expect(wrangler).not.toContain('d1_databases');
    expect(wrangler).not.toContain('AUTH_DB');
    expect(wrangler).not.toContain('CLIAuthDO');
    expect(wrangler).not.toContain('AuthDO');
    expect(session).toContain('verifySession(env.AUTH_KV');
    expect(cliRoutes).toContain('startCliAuth(env');
    expect(cliRoutes).not.toContain('authDO(env)');
    // Nothing in KV is a source of truth: every write carries an expiry, and
    // the identity itself is addressed by derivation, not by a stored index.
    expect(store).toContain('userDO.ensureProfile(');
    expect(store).not.toContain('kv.put(');
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
  });

  test('browser install page is HTML while the terminal installer stays raw shell', async () => {
    const installPage = await handleCliRequest(new Request('https://kinu.example.com/install'), PUBLIC_ROUTE_ENV);
    expect(installPage?.status).toBe(200);
    expect(installPage?.headers.get('content-type')).toContain('text/html');
    expect(installPage?.headers.get('content-security-policy')).toContain('https://static.cloudflareinsights.com');
    const html = await installPage!.text();
    expect(html).toContain('Install the Kinu.run CLI');
    expect(html).toContain('curl -fsSL');
    expect(html).toContain('https://kinu.example.com/install.sh');
    expect(html).toContain('KINU_PARENT_ACTIVATES=1 bash');
    expect(html).not.toContain('OAuth sign-in required for the dashboard.');
    expect(html).not.toContain('View the raw installer');
    expect(html).not.toContain('href="/install.sh"');

    const installScript = await handleCliRequest(new Request('https://kinu.example.com/install.sh'), PUBLIC_ROUTE_ENV);
    expect(installScript?.status).toBe(200);
    expect(installScript?.headers.get('content-type')).toContain('text/x-shellscript');
    const script = await installScript!.text();
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('KINU_HOME="$KINU_HOME" KINU_REFRESH_SOURCE=1 "$BIN_PATH" --help');
    expect(script).toContain('setup --origin "$KINU_ORIGIN" --account-only');
    expect(script).toContain("grep -Eq '^[[:space:]]+setup[[:space:]]'");
    expect(script).toContain("grep -F '$HOME/.kinu/bin'");

    const installScriptHead = await handleCliRequest(
      new Request('https://kinu.example.com/install.sh', { method: 'HEAD' }),
      PUBLIC_ROUTE_ENV,
    );
    expect(installScriptHead?.status).toBe(200);
    expect(installScriptHead?.headers.get('content-type')).toContain('text/x-shellscript');
    expect(await installScriptHead!.text()).toBe('');
  });

  test('CLI shim does not hardcode GitHub archive directory names and verifies the source checksum by default', async () => {
    const shim = await handleCliRequest(new Request('https://kinu.example.com/downloads/kinu'), PUBLIC_ROUTE_ENV);
    expect(shim?.status).toBe(200);
    const script = await shim!.text();
    expect(script).toContain('SRC_DIR="$SOURCE_ROOT/current"');
    expect(script).toContain('https://kinu.example.com/downloads/kinu-source.tar.gz');
    expect(script).not.toContain('github.com');
    expect(script).not.toContain('Kinu-main');
    // Default verification fetches the published .sha256 asset; the env var
    // is only a pin override.
    expect(script).toContain('"$TARBALL_URL.sha256"');
    expect(script).toContain('KINU_SOURCE_SHA256');
    expect(script).toContain('Source checksum mismatch');
    const syntaxCheck = Bun.spawnSync(['bash', '-n'], { stdin: Buffer.from(script) });
    expect(syntaxCheck.exitCode).toBe(0);

    const shimHead = await handleCliRequest(
      new Request('https://kinu.example.com/downloads/kinu', { method: 'HEAD' }),
      PUBLIC_ROUTE_ENV,
    );
    expect(shimHead?.status).toBe(200);
    expect(shimHead?.headers.get('content-type')).toContain('text/x-shellscript');
    expect(await shimHead!.text()).toBe('');
  });

  test('supervise automation copy matches the live timer reactor', () => {
    const supervise = source('src/pages/SupervisePage.tsx');
    expect(supervise).toContain('next_fire_at');
    expect(supervise).toContain('fire_count');
    expect(supervise).not.toContain("The event reactor isn't wired into live turns yet");
    expect(supervise).not.toContain("triggers are registered but don't auto-drive runs");
  });

  test('CLI setup commands are one-command defaults without embedded auth tokens', () => {
    expect(buildCliInstallCommand({ origin: 'https://kinu.example.com/' }))
      .toBe("curl -fsSL 'https://kinu.example.com/install.sh' | KINU_PARENT_ACTIVATES=1 bash && export PATH=\"${KINU_HOME:-$HOME/.kinu}/bin:$PATH\"");
    expect(buildCliInstallCommand({
      origin: 'https://kinu.example.com',
      setup: false,
      connect: true,
      label: "Ashish's Mac",
    })).toBe("curl -fsSL 'https://kinu.example.com/install.sh' | KINU_PARENT_ACTIVATES=1 bash -s -- --no-setup --connect --label 'Ashish'\\''s Mac' && export PATH=\"${KINU_HOME:-$HOME/.kinu}/bin:$PATH\"");
  });

  test('CLI model menu uses CLI bearer auth rather than browser-only user routes', () => {
    const cliRoutes = source('src/cli/routes.ts');
    expect(cliRoutes).toContain("path === '/models' && method === 'GET'");
    expect(cliRoutes).toContain('listAvailableModels(env, cli.userId, await ownerCaller(env))');
  });

  test('web agent creation requires an available model and stores the selected initial model', () => {
    const routes = source('src/user/routes.ts');
    const createAgent = source('src/user/workspace-create.ts');
    expect(routes).toContain('listAvailableModels(env, identity.userId, await ownerCaller(env))');
    expect(createAgent).toContain('Cloudflare Workers AI is not connected');
    expect(createAgent).toContain('pickInitialModel');
    expect(createAgent).toContain('await orchestrator.setModel(model)');
  });

  test('web UI offers Cloudflare Workers AI reconnect instead of a no-provider dead end', () => {
    // The shared self-fetching picker owns the reconnect CTA; every surviving
    // creation/chat/settings surface embeds that same notice.
    const picker = source('src/components/ModelPicker.tsx');
    const workspace = source('src/pages/WorkspacePage.tsx');
    const home = source('src/pages/HomePage.tsx');
    const settings = source('src/pages/UserSettingsPage.tsx');
    expect(picker).not.toContain('(no providers connected)');
    expect(picker).toContain('Connect Workers AI');
    expect(picker).toContain('cloudflareReconnectPath');
    expect(workspace).toContain('ConnectedModelPicker');
    expect(home).toContain('CloudflareAIConnectNotice');
    expect(settings).toContain('CloudflareAIConnectNotice');
  });
});

describe('sanitizeReturnTo (single strict implementation)', () => {
  test('accepts plain relative paths', () => {
    expect(sanitizeReturnTo('/agents/jarvis')).toBe('/agents/jarvis');
    expect(sanitizeReturnTo('/user/settings?tab=mcp')).toBe('/user/settings?tab=mcp');
  });

  test('rejects absolute, protocol-relative, and backslash escapes', () => {
    expect(sanitizeReturnTo('https://evil.example')).toBe('/');
    expect(sanitizeReturnTo('//evil.example')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.example')).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');
  });

  test('rejects redirect loops back into the auth flow, on the stored state too', () => {
    expect(sanitizeReturnTo('/auth/github/start')).toBe('/');
    expect(sanitizeReturnTo('/login')).toBe('/');
    expect(sanitizeReturnTo('/logout')).toBe('/');
  });
});
