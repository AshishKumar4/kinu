// Preset adds on the real UserDO: `presetId` resolves the catalog entry, the
// row carries it, and the OAuth variant answers the authorize URL the card
// opens. The manager and the OAuth provider are the same fakes the lifecycle
// suite runs against — `queueMcpAuthUrl` is the only new seam, standing in for
// the authorization redirect the harness cannot perform.
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { describe, expect, test } from 'bun:test';
import {
  createTestUserDO, sqlExec, testOwner,
  type TestUserDO, type TestUserDOOptions,
} from './helpers/user-do';
import {
  liveMcpTransport, queueMcpAuthUrl, recordedMcpServers, resetRecordedMcp, seedSdkMcpServer,
} from './helpers/agents-sdk';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { requestBodyText } from './helpers/fetch-input';

// Imported AFTER the helper's mock registration (see `mockAgentsSdk`): mcp.ts
// binds the provider class at load, so a static import here would hold the
// real one and every DO it reaches would register DCR-shaped providers.
const { RegisteredAppOAuthClientProvider } = await import('../src/user/user-do');

function harness(options?: TestUserDOOptions): TestUserDO {
  resetRecordedMcp();

  return createTestUserDO(options);
}

describe('an MCP preset add', () => {
  test('an oauth preset stores preset_id and returns the authorize URL', async () => {
    const h = harness();
    queueMcpAuthUrl('https://mcp.cloudflare.com/authorize?test');

    const added = await h.userDO.userMcp_add(
      await testOwner(), { presetId: 'cloudflare' }, 'https://kinu.example',
    );

    expect(added.authUrl).toBe('https://mcp.cloudflare.com/authorize?test');

    const [row] = sqlExec(h.db).exec(
      `SELECT s.name, s.server_url, s.transport, p.preset_id
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id
        WHERE s.id = ?`,
      added.id,
    ).toArray();

    expect(row?.preset_id).toBe('cloudflare');
    expect(row?.name).toBe('Cloudflare');
    expect(row?.server_url).toBe('https://mcp.cloudflare.com/mcp');
    expect(row?.transport).toBe('streamable-http');

    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.presetId).toBe('cloudflare');
    expect(listed?.status).toBe('authenticating');
    expect(listed?.authUrl).toBe('https://mcp.cloudflare.com/authorize?test');
    h.close();
  });

  test('a token preset carries its credential sealed, tagged with the preset', async () => {
    const h = harness();

    const added = await h.userDO.userMcp_add(
      await testOwner(),
      { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } },
      'https://kinu.example',
    );

    expect(added.authUrl).toBeNull();

    const [row] = sqlExec(h.db).exec(
      `SELECT s.name, s.server_url, p.preset_id, s.headers
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id
        WHERE s.id = ?`,
      added.id,
    ).toArray();

    expect(row?.preset_id).toBe('github');
    expect(row?.name).toBe('GitHub');
    // Sealed at rest: the column holds ciphertext, not the token.
    expect(v.parse(v.string(), row?.headers)).not.toContain('ghp_test');

    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.presetId).toBe('github');
    expect(listed?.status).not.toBe('authenticating');
    h.close();
  });

  test('the catalog is the authority: a presetId add cannot smuggle its own endpoint', async () => {
    const h = harness({ mcpAppCredentials: ['google'] });

    const added = await h.userDO.userMcp_add(
      await testOwner(),
      { presetId: 'google', name: 'x', serverUrl: 'https://attacker.example/mcp' },
      'https://kinu.example',
    );

    const [row] = sqlExec(h.db).exec(
      `SELECT name, server_url FROM user_mcp_servers WHERE id = ?`,
      added.id,
    ).toArray();

    expect(row?.server_url).toBe('https://gmailmcp.googleapis.com/mcp/v1');
    expect(row?.name).toBe('Gmail');
    h.close();
  });

  test('an oauth-app preset with no app and no token is refused before a row exists', async () => {
    const h = harness();

    await expect(
      h.userDO.userMcp_add(await testOwner(), { presetId: 'github' }, 'https://kinu.example'),
    ).rejects.toThrow(/needs either the deployment's .*OAuth app or a token/);
    await expect(
      h.userDO.userMcp_add(await testOwner(), { presetId: 'google' }, 'https://kinu.example'),
    ).rejects.toThrow(/needs either the deployment's .*OAuth app or a token/);

    const rows = sqlExec(h.db).exec(`SELECT id FROM user_mcp_servers`).toArray();
    expect(rows.length).toBe(0);
    h.close();
  });

  test('an oauth-app add runs under the registered client, and the row still claims the preset', async () => {
    const h = harness({ mcpAppCredentials: ['github'] });
    queueMcpAuthUrl('https://github.com/login/oauth/authorize?test');

    const added = await h.userDO.userMcp_add(
      await testOwner(), { presetId: 'github' }, 'https://kinu.example',
    );

    expect(added.authUrl).toBe('https://github.com/login/oauth/authorize?test');

    const [row] = sqlExec(h.db).exec(
      `SELECT s.name, p.preset_id
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id
        WHERE s.id = ?`, added.id,
    ).toArray();

    expect(row?.preset_id).toBe('github');
    expect(row?.name).toBe('GitHub');

    const provider = liveMcpTransport(added.id)?.authProvider;
    expect(provider instanceof RegisteredAppOAuthClientProvider).toBe(true);

    if (provider instanceof RegisteredAppOAuthClientProvider) {
      // The registration the SDK reads: the env's app answered as already
      // registered — which is what makes `auth()` skip the /register call.
      expect(await provider.clientInformation()).toMatchObject({
        client_id: 'test-github-client-id',
        client_secret: 'test-github-client-secret',
      });
      expect(provider.clientMetadata.scope).toBe('repo read:user');
    }

    // The SDK row names the registered app, not a client it minted — so a
    // restore after eviction keeps pointing at the same registration.
    expect(recordedMcpServers().find((s) => s.id === added.id)?.clientId)
      .toBe('test-github-client-id');

    h.close();
  });

  test('adding the same preset twice is refused by the name claim', async () => {
    const h = harness();

    await h.userDO.userMcp_add(
      await testOwner(), { presetId: 'github', headers: { Authorization: 'Bearer a' } },
      'https://kinu.example',
    );
    await expect(
      h.userDO.userMcp_add(
        await testOwner(), { presetId: 'github', headers: { Authorization: 'Bearer b' } },
        'https://kinu.example',
      ),
    ).rejects.toThrow("An MCP server named 'GitHub' already exists.");

    const rows = sqlExec(h.db).exec(`SELECT id FROM user_mcp_servers`).toArray();
    expect(rows.length).toBe(1);
    h.close();
  });

  test('an unknown preset id is refused, a custom add stores a NULL preset_id', async () => {
    const h = harness();

    await expect(
      h.userDO.userMcp_add(await testOwner(), { presetId: 'gitlab' }, 'https://kinu.example'),
    ).rejects.toThrow("Unknown MCP preset 'gitlab'.");

    const added = await h.userDO.userMcp_add(
      await testOwner(), { name: 'linear', serverUrl: 'https://mcp.linear.example/sse' },
      'https://kinu.example',
    );

    const [row] = sqlExec(h.db).exec(
      `SELECT p.preset_id
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id
        WHERE s.id = ?`, added.id,
    ).toArray();

    // A custom add leaves NO row in the presets table — the join's NULL is
    // the "no preset" answer, not a stored NULL.
    expect(row?.preset_id).toBeNull();
    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.presetId).toBeNull();
    h.close();
  });

  test('userMcp_presets reports which oauth-app presets the deployment carries', async () => {
    const h = harness({ mcpAppCredentials: ['github'] });

    const rows = await h.userDO.userMcp_presets(await testOwner());

    expect(rows).toEqual([
      { id: 'github', appConfigured: true },
      { id: 'cloudflare', appConfigured: true },
      { id: 'google', appConfigured: false },
    ]);
    h.close();
  });
});

describe('a UserDO opened over storage from before the MCP presets lane', () => {
  // The shipped user_mcp_servers DDL — every column the table carried before
  // the lane, and none it does now. `CREATE TABLE IF NOT EXISTS` inside
  // `initUserTables` is a no-op on this storage, so the object under test runs
  // against exactly the shape a pre-lane account holds in production.
  const SHIPPED_USER_MCP_SERVERS = `
    CREATE TABLE IF NOT EXISTS user_mcp_servers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      server_url    TEXT NOT NULL,
      transport     TEXT NOT NULL,
      headers       TEXT,
      allowed_tools TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `;

  test('list, a custom add and a preset add all run on the old user_mcp_servers shape', async () => {
    const db = new Database(':memory:');
    db.run(SHIPPED_USER_MCP_SERVERS);

    const h = createTestUserDO({ storage: db });

    // The production failure was `no such column: preset_id` on this read.
    expect(await h.userDO.userMcp_list(await testOwner())).toEqual([]);

    await h.userDO.userMcp_add(
      await testOwner(), { name: 'linear', serverUrl: 'https://mcp.linear.example/sse' },
      'https://kinu.example',
    );
    await h.userDO.userMcp_add(
      await testOwner(),
      { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } },
      'https://kinu.example',
    );

    const rows = sqlExec(db).exec(
      `SELECT s.name, p.preset_id
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id
        ORDER BY s.name`,
    ).toArray();

    expect(rows.map((r) => [r.name, r.preset_id])).toEqual([
      ['GitHub', 'github'],
      ['linear', null],
    ]);

    const listed = await h.userDO.userMcp_list(await testOwner());
    expect(listed.map((r) => r.presetId)).toEqual(['github', null]);

    db.close();
  });
});

describe('a cold activation over a preset row', () => {
  test('a rewritten oauth-app row restores with the registered-app provider', async () => {
    const first = harness({ mcpAppCredentials: ['github'] });
    await first.userDO.userMcp_add(
      await testOwner(),
      { presetId: 'github', headers: { Authorization: 'Bearer pat' } },
      'https://kinu.example',
    );

    const [row] = sqlExec(first.db).exec(`SELECT id FROM user_mcp_servers`).toArray();
    const id = v.parse(v.string(), row?.id);

    // The SDK's own row as a pre-provider build wrote it: plaintext headers,
    // a stale dynamically-registered client id, and the callback URL a row in
    // flight carries. The rewrite the woken object runs is what installs the
    // provider — the seam the test is here to observe.
    seedSdkMcpServer(id, {
      type: 'streamable-http',
      requestInit: { headers: { Authorization: 'Bearer stale' } },
    }, {
      callbackUrl: 'https://kinu.example/api/user/mcp/callback',
      clientId: 'stale-dcr-client',
    });

    const woken = createTestUserDO({ storage: first.db, mcpAppCredentials: ['github'] });
    await woken.userDO.userMcp_list(await testOwner());

    const provider = liveMcpTransport(id)?.authProvider;
    expect(provider instanceof RegisteredAppOAuthClientProvider).toBe(true);

    if (provider instanceof RegisteredAppOAuthClientProvider) {
      expect(await provider.clientInformation()).toMatchObject({
        client_id: 'test-github-client-id',
        client_secret: 'test-github-client-secret',
      });
    }

    woken.close();
    first.close();
  });
});

describe('the registered-app provider against the real SDK auth flow', () => {
  /** An authorization server the way GitHub's runs: it advertises a
   *  registration endpoint the flow must NEVER reach, answers the authorize
   *  step by URL, and exchanges the code for a token. Every call lands in
   *  `seen` so the assertions read what the SDK actually did. */
  test('the flow skips registration and the token call authenticates the app', async () => {
    interface SeenCall {
      url: string;
      body?: URLSearchParams;
      authHeader?: string | null;
    }

    const seen: SeenCall[] = [];

    const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const entry: SeenCall = { url: String(url) };

      seen.push(entry);

      if (entry.url === 'https://mcp.example/.well-known/oauth-authorization-server') {
        return new Response(JSON.stringify({
          issuer: 'https://mcp.example',
          authorization_endpoint: 'https://mcp.example/authorize',
          token_endpoint: 'https://mcp.example/token',
          registration_endpoint: 'https://mcp.example/register',
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      if (entry.url === 'https://mcp.example/register') {
        // Answering here would mean the flow tried DCR — which is exactly the
        // failure the registered-app provider exists to prevent, so a reach
        // is recorded rather than answered.
        return new Response('should not be called', { status: 500 });
      }

      if (entry.url === 'https://mcp.example/token') {
        entry.body = new URLSearchParams(await requestBodyText(url, init));
        entry.authHeader = new Headers(init?.headers).get('authorization');

        return new Response(JSON.stringify({
          access_token: 'at-test', token_type: 'Bearer', refresh_token: 'rt-test',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response('not found', { status: 404 });
    };

    // SAFETY: the registered provider is constructed against the provider
    // stub above, which ignores its storage argument entirely — the value is
    // only the type the constructor names, and the flow under test reads
    // nothing off it.
    const provider = new RegisteredAppOAuthClientProvider({
      storage: {} as DurableObjectStorage,
      clientName: 'test-client',
      baseRedirectUrl: 'https://kinu.example/api/user/mcp/callback',
      clientId: 'test-github-client-id',
      clientSecret: 'test-github-client-secret',
      scope: 'repo read:user',
    });

    provider.serverId = 'srv';

    const redirect = await auth(provider, {
      serverUrl: 'https://mcp.example/mcp', fetchFn,
    });

    // The authorize URL carries the registered app and the preset's scope —
    // the two things a token-fallback flow could never put on the URL.
    expect(redirect).toBe('REDIRECT');
    const authUrl = new URL(provider.authUrl ?? '');
    expect(authUrl.searchParams.get('client_id')).toBe('test-github-client-id');
    expect(authUrl.searchParams.get('scope')).toBe('repo read:user');
    expect(authUrl.searchParams.get('redirect_uri'))
      .toBe('https://kinu.example/api/user/mcp/callback');

    const exchanged = await auth(provider, {
      serverUrl: 'https://mcp.example/mcp', authorizationCode: 'code-test', fetchFn,
    });

    expect(exchanged).toBe('AUTHORIZED');

    const token = seen.find((call) => call.url === 'https://mcp.example/token');
    expect(token?.body?.get('client_id')).toBe('test-github-client-id');
    expect(token?.body?.get('client_secret')).toBe('test-github-client-secret');

    // The claim the whole shape rests on: the SDK's registration step exists
    // and the AS would have honored it, and the flow never reached it.
    expect(seen.some((call) => call.url === 'https://mcp.example/register')).toBe(false);
  });
});
