// Preset adds on the real UserDO; `queueMcpAuthUrl` stands in for the authorization redirect the harness cannot perform.
import * as v from 'valibot';
import { describe, expect, test } from 'bun:test';
import { asFetchFunction, createCredentialCipher, mcpPresetById, type JsonObject, type JsonValue } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import {
  createTestUserDO, sqlExec, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY,
  type TestUserDO, type TestUserDOOptions,
} from './helpers/user-do';
import {
  lastOAuthStorage, liveMcpTransport, queueMcpAuthUrl, recordedMcpServers, resetRecordedMcp, seedSdkMcpServer,
} from './helpers/agents-sdk';
import { kvOf } from './helpers/platform-context';
import { auth } from '@modelcontextprotocol/client';

import { durableObjectStorage } from './helpers/programmatic-host';

// Imported after `mockAgentsSdk` registers: mcp.ts binds the provider class at load.
const { RegisteredAppOAuthClientProvider } = await import('../src/user/user-do');

/** A server's name, endpoint and transport, where they live: the SDK's catalog row. */
function catalogOf(id: string): { name: string; serverUrl: string; transport: string | undefined } | undefined {
  const row = recordedMcpServers().find((server) => server.id === id);

  return row === undefined ? undefined : { name: row.name, serverUrl: row.url, transport: row.transport.type };
}

function harness(options?: TestUserDOOptions): TestUserDO {
  resetRecordedMcp();

  return createTestUserDO(options);
}

describe("an MCP server's login is kept sealed in the account's storage", () => {
  test('the storage an added server\'s provider and the SDK\'s restored provider are handed seals every value', async () => {
    const h = harness();
    const token = { access_token: ['gho_', 'sealed0123456789abcdefghijklmnopq'].join(''), token_type: 'bearer' };
    queueMcpAuthUrl('https://mcp.cloudflare.com/authorize?test');

    await h.userDO.userMcp_add(await testOwner(), { presetId: 'cloudflare' }, 'https://kinu.example');
    await lastOAuthStorage().put('/kinu-user-mcp/server-1/client-1/token', token);

    const stored = kvOf(h.db).get('/kinu-user-mcp/server-1/client-1/token');
    expect(typeof stored === 'string' && stored.startsWith('pce1.')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(token.access_token);

    h.userDO.createMcpOAuthProvider('https://kinu.example/api/user/mcp/callback');
    expect(await lastOAuthStorage().get<JsonValue>('/kinu-user-mcp/server-1/client-1/token')).toEqual(token);
    h.close();
  });
});

describe('an MCP preset add', () => {
  test('an oauth preset stores preset_id and returns the authorize URL', async () => {
    const h = harness();
    queueMcpAuthUrl('https://mcp.cloudflare.com/authorize?test');

    const added = await h.userDO.userMcp_add(
      await testOwner(), { presetId: 'cloudflare' }, 'https://kinu.example',
    );

    expect(added.authUrl).toBe('https://mcp.cloudflare.com/authorize?test');

    const [row] = sqlExec(h.db).exec(`SELECT preset_id FROM user_mcp_servers WHERE id = ?`, added.id).toArray();

    expect(row?.preset_id).toBe('cloudflare');
    expect(catalogOf(added.id)).toMatchObject({ serverUrl: 'https://mcp.cloudflare.com/mcp', transport: 'streamable-http' });

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
      `SELECT preset_id, headers FROM user_mcp_servers WHERE id = ?`,
      added.id,
    ).toArray();

    expect(row?.preset_id).toBe('github');
    const sealed = v.parse(v.string(), row?.headers);
    expect(sealed).not.toContain('ghp_test');
    // Sealed for this server: it opens under its own id and under no other.
    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    expect(JSON.parse(await cipher.open(`test-user-do:mcp:${added.id}`, sealed))).toEqual({ Authorization: 'Bearer ghp_test' });
    await expect(cipher.open('test-user-do:mcp:another', sealed)).rejects.toThrow('failed to decrypt');

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

    expect(catalogOf(added.id)?.serverUrl).toBe('https://gmailmcp.googleapis.com/mcp/v1');
    h.close();
  });

  test('an oauth-app preset with no app and no token is refused before a row exists', async () => {
    const h = harness();

    await expect(
      h.userDO.userMcp_add(await testOwner(), { presetId: 'github' }, 'https://kinu.example'),
    ).rejects.toMatchObject({ code: 'bad_input' });
    await expect(
      h.userDO.userMcp_add(await testOwner(), { presetId: 'google' }, 'https://kinu.example'),
    ).rejects.toMatchObject({ code: 'bad_input' });

    const rows = sqlExec(h.db).exec(`SELECT id FROM user_mcp_servers`).toArray();
    expect(rows.length).toBe(0);
    h.close();
  });

  // Gmail's MCP answers anyone's initialize and tools/list, so it connected unsigned on staging (2026-10-19) and would
  // have refused the first call of some turn. A registered app's server is not reached unsigned: its sign-in starts.
  test("a registered app's server is answered 401 until signed in, without a request leaving, so its sign-in starts at add", async () => {
    const h = harness({ mcpAppCredentials: ['google'] });
    const added = await h.userDO.userMcp_add(await testOwner(), { presetId: 'google' }, 'https://kinu.example');
    const send = present(liveMcpTransport(added.id)?.fetch, "the server's transport fetch");
    const network = globalThis.fetch;
    const left: string[] = [];

    globalThis.fetch = asFetchFunction(async (input) => {
      left.push(new Request(input).url);

      return new Response(null, { status: 200 });
    });

    try {
      const unsigned = await send(present(mcpPresetById('google'), 'the Gmail preset').serverUrl, { method: 'POST', body: '{}' });

      expect({ status: unsigned.status, challenge: unsigned.headers.get('www-authenticate'), left }).toEqual({ status: 401, challenge: 'Bearer', left: [] });
    } finally {
      globalThis.fetch = network;
      h.close();
    }
  });

  test('an oauth-app add runs under the registered client, and the row still claims the preset', async () => {
    const h = harness({ mcpAppCredentials: ['github'] });
    queueMcpAuthUrl('https://github.com/login/oauth/authorize?test');

    const added = await h.userDO.userMcp_add(
      await testOwner(), { presetId: 'github' }, 'https://kinu.example',
    );

    expect(added.authUrl).toBe('https://github.com/login/oauth/authorize?test');

    const [row] = sqlExec(h.db).exec(
      `SELECT preset_id FROM user_mcp_servers WHERE id = ?`, added.id,
    ).toArray();

    expect(row?.preset_id).toBe('github');

    const provider = liveMcpTransport(added.id)?.authProvider;
    expect(provider instanceof RegisteredAppOAuthClientProvider).toBe(true);

    if (provider instanceof RegisteredAppOAuthClientProvider) {
      // Registered already, which makes `auth()` skip the /register call.
      expect(await provider.clientInformation()).toMatchObject({
        client_id: 'test-github-client-id',
        client_secret: 'test-github-client-secret',
      });
      expect(provider.clientMetadata.scope).toBe('repo read:org read:user');
    }

    // Names the registered app, so a restore after eviction keeps the same registration.
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
    ).rejects.toMatchObject({ code: 'bad_input' });

    const rows = sqlExec(h.db).exec(`SELECT id FROM user_mcp_servers`).toArray();
    expect(rows.length).toBe(1);
    h.close();
  });

  test('an unknown preset id is refused, a custom add stores a NULL preset_id', async () => {
    const h = harness();

    await expect(
      h.userDO.userMcp_add(await testOwner(), { presetId: 'gitlab' }, 'https://kinu.example'),
    ).rejects.toMatchObject({ code: 'bad_input' });

    const added = await h.userDO.userMcp_add(
      await testOwner(), { name: 'linear', serverUrl: 'https://mcp.linear.example/sse' },
      'https://kinu.example',
    );

    const [row] = sqlExec(h.db).exec(
      `SELECT preset_id
         FROM user_mcp_servers
        WHERE id = ?`, added.id,
    ).toArray();

    // The join's NULL is the "no preset" answer, not a stored NULL.
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
    const added = catalogOf(id);

    seedSdkMcpServer(id, {
      type: 'streamable-http',
      requestInit: { headers: { Authorization: 'Bearer stale' } },
    }, {
      callbackUrl: 'https://kinu.example/api/user/mcp/callback',
      clientId: 'stale-dcr-client',
      ...(added !== undefined && { name: added.name, url: added.serverUrl }),
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

  // Only a row with headers was rebuilt at activation; an app row signed in by OAuth alone was restored by the SDK with
  // the agent's default provider, which holds no client secret, so its next refresh or sign-in reached the vendor as an
  // unknown client, and Google's hour-long tokens expire well inside one idle account's life.
  test('an oauth-app row with no headers restores with the registered-app provider', async () => {
    const first = harness({ mcpAppCredentials: ['github'] });
    const added = await first.userDO.userMcp_add(await testOwner(), { presetId: 'github' }, 'https://kinu.example');

    const woken = createTestUserDO({ storage: first.db, mcpAppCredentials: ['github'] });
    await woken.userDO.userMcp_list(await testOwner());

    const provider = liveMcpTransport(added.id)?.authProvider;
    expect(provider instanceof RegisteredAppOAuthClientProvider).toBe(true);

    if (provider instanceof RegisteredAppOAuthClientProvider) {
      expect(await provider.clientInformation()).toMatchObject({ client_id: 'test-github-client-id', client_secret: 'test-github-client-secret' });
    }

    woken.close();
    first.close();
  });
});

describe('the registered-app provider against the real SDK auth flow', () => {
  /** Advertises a registration endpoint the flow must never reach, as GitHub's does. */
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
        // Reaching here would mean the flow tried DCR, so the reach is recorded rather than answered.
        return new Response('should not be called', { status: 500 });
      }

      if (entry.url === 'https://mcp.example/token') {
        entry.body = new URLSearchParams(await new Request(url, init).text());
        entry.authHeader = new Headers(init?.headers).get('authorization');

        return new Response(JSON.stringify({
          access_token: 'at-test', token_type: 'Bearer', refresh_token: 'rt-test',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response('not found', { status: 404 });
    };

    const provider = new RegisteredAppOAuthClientProvider({
      storage: durableObjectStorage({}),
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

    expect(seen.some((call) => call.url === 'https://mcp.example/register')).toBe(false);
  });
  // Staging, 2026-10-19: the owner's GitHub app was asked for every scope GitHub's MCP lists (write:packages, gist,
  // project...), the SDK preferring the server's protected-resource scopes_supported to the preset's own. Modelled on
  // GitHub's answers as measured that day.
  test("GitHub's sign-in asks for the scope the preset declares, not every scope the server lists", async () => {
    const github: JsonObject = {
      'https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/': {
        resource: 'https://api.githubcopilot.com/mcp/', authorization_servers: ['https://github.com/login/oauth'],
        scopes_supported: ['repo', 'read:org', 'read:user', 'user:email', 'read:packages', 'write:packages', 'read:project', 'project', 'gist', 'notifications'],
        bearer_methods_supported: ['header'], resource_name: 'GitHub MCP Server',
      },
      'https://github.com/.well-known/oauth-authorization-server/login/oauth': {
        issuer: 'https://github.com/login/oauth', authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token', response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
        code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, scopes_supported: ['offline_access'],
      },
    };

    const fetchFn = async (url: string | URL): Promise<Response> => {
      const answer = github[String(url)];

      return answer === undefined ? new Response('not found', { status: 404 }) : Response.json(answer);
    };

    const preset = present(mcpPresetById('github'), 'the GitHub preset');

    const provider = new RegisteredAppOAuthClientProvider({
      storage: durableObjectStorage({}), clientName: 'test-client', baseRedirectUrl: 'https://kinu.example/api/user/mcp/callback',
      clientId: 'test-github-client-id', clientSecret: 'test-github-client-secret', scope: preset.scope,
    });

    provider.serverId = 'srv';

    expect(await auth(provider, {
      serverUrl: preset.serverUrl, fetchFn,
      resourceMetadataUrl: new URL('https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/'),
    })).toBe('REDIRECT');
    // `offline_access` asks the server for a refresh token, which the SDK adds where the server lists it.
    const asked = new URL(provider.authUrl ?? '').searchParams.get('scope')?.split(' ').filter((scope) => scope !== 'offline_access');

    expect(asked).toEqual(preset.scope?.split(' '));
  });
});
