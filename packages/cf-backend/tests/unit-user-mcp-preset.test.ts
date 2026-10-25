// Preset adds on the real UserDO, each preset's endpoint served by a test MCP server in this process.
import * as v from 'valibot';
import { afterEach, describe, expect, test } from 'bun:test';
import { createCredentialCipher, GOOGLE_OAUTH_CRED_KEY, mcpPresetById, type JsonObject, type JsonValue, type OAuthCredential } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { createTestUserDO, provisionTestWorkspace, sqlExec, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY, type TestUserDO, type TestUserDOOptions } from './helpers/user-do';
import { mcpTestServer, type McpTestServer } from './helpers/mcp-server';

const GITHUB_URL = present(mcpPresetById('github'), 'the GitHub preset').serverUrl;

const CLOUDFLARE_URL = present(mcpPresetById('cloudflare'), 'the Cloudflare preset').serverUrl;

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** The network as the account reaches it: each preset endpoint `served` names answered by its test server, every other
 *  address by `elsewhere`, and every address asked for recorded. */
function network(served: Readonly<Record<string, McpTestServer>>, elsewhere: (url: string, init?: RequestInit) => Promise<Response> = realFetch) {
  const asked: string[] = [];

  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const server = served[url];

    asked.push(url);

    return server === undefined ? elsewhere(url, init) : realFetch(server.url, init);
  }, { preconnect: realFetch.preconnect });

  return asked;
}

async function add(h: TestUserDO, input: JsonObject): Promise<{ id: string; signIn: boolean }> {
  return h.userDO.userMcp_add(await testOwner(), input, 'https://kinu.example');
}

/** Runs `body` with a fresh account and a server answering the GitHub preset's endpoint, and lets both go. */
async function withGitHub(body: (h: TestUserDO, server: McpTestServer) => Promise<void>, options: TestUserDOOptions = {}): Promise<void> {
  const server = mcpTestServer({ tools: [{ name: 'get_file_contents', inputSchema: { type: 'object' } }] });
  const h = createTestUserDO(options);

  network({ [GITHUB_URL]: server });

  try {
    await body(h, server);
  } finally {
    await server.stop();
    h.close();
  }
}

describe('an MCP preset add', () => {
  test('an oauth preset asks for its sign-in at add; the catalog names its endpoint, and its row claims the preset', async () => {
    const server = mcpTestServer();
    const h = createTestUserDO();
    const owner = await testOwner();

    server.bearer = 'a login the account does not have';
    network({ [CLOUDFLARE_URL]: server });

    try {
      const added = await add(h, { presetId: 'cloudflare', name: 'x', serverUrl: 'https://attacker.example/mcp' });

      expect({ added: added.signIn, listed: (await h.userDO.userMcp_list(owner)).map((s) => [s.presetId, s.name, s.serverUrl, s.transport, s.status, s.signIn]) })
        .toEqual({ added: true, listed: [['cloudflare', 'Cloudflare', CLOUDFLARE_URL, 'streamable-http', 'needs_sign_in', true]] });
    } finally {
      await server.stop();
      h.close();
    }
  });

  // Gmail's MCP answered anyone's initialize and tools/list, so it connected unsigned on staging (2026-10-19) and would
  // have refused the first call of some turn. A registered app's server is not reached unsigned: its sign-in starts.
  test("a registered app's server waits for its sign-in from its add, which sends it no request", async () => {
    const h = createTestUserDO({ mcpAppCredentials: ['github'] });
    const asked = network({});

    try {
      const added = await add(h, { presetId: 'github' });

      expect({ signIn: added.signIn, asked, listed: (await h.userDO.userMcp_list(await testOwner())).map((s) => [s.status, s.signIn]) })
        .toEqual({ signIn: true, asked: [], listed: [['needs_sign_in', true]] });
    } finally {
      h.close();
    }
  });

  test('a token preset carries its credential sealed for its own server, tagged with the preset, and connects by it', async () => {
    await withGitHub(async (h, server) => {
      server.bearer = 'ghp_test';
      const added = await add(h, { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } });
      const [row] = sqlExec(h.db).exec(`SELECT preset_id, headers FROM user_mcp_servers WHERE id = ?`, added.id).toArray();
      const { preset_id: preset, headers: sealed } = v.parse(v.object({ preset_id: v.string(), headers: v.string() }), row);
      const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

      expect({ signIn: added.signIn, preset, inTheClear: sealed.includes('ghp_test') }).toEqual({ signIn: false, preset: 'github', inTheClear: false });
      expect(JSON.parse(await cipher.open(`test-user-do:mcp:${added.id}`, sealed))).toEqual({ Authorization: 'Bearer ghp_test' });
      await expect(cipher.open('test-user-do:mcp:another', sealed)).rejects.toThrow('failed to decrypt');
      expect((await h.userDO.userMcp_list(await testOwner())).map((s) => [s.presetId, s.status, s.toolsCount])).toEqual([['github', 'connected', 1]]);
    });
  });

  // Sol-round review (2026-10-23): a token preset holds the deployment's app client id too, and a failed connection then
  // offered Authorize, which its token never needs.
  test('a token preset whose token is refused reads failed and offers no sign-in, though the deployment holds its app', async () => {
    await withGitHub(async (h, server) => {
      server.bearer = 'ghp_test';
      const added = await add(h, { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } });

      server.bearer = 'a token the account does not hold';
      const reconnected = await h.userDO.userMcp_reconnect(await testOwner(), added.id);
      const listed = (await h.userDO.userMcp_list(await testOwner())).find((s) => s.id === added.id);

      expect({ reconnected: reconnected.status, status: listed?.status, signIn: listed?.signIn }).toEqual({ reconnected: 'failed', status: 'failed', signIn: false });
    }, { mcpAppCredentials: ['github'] });
  });

  test('an oauth-app preset with no app and no token is refused before a row exists; so are an unknown preset and a second one', async () => {
    await withGitHub(async (h) => {
      await expect(add(h, { presetId: 'github' })).rejects.toMatchObject({ code: 'bad_input' });
      await expect(add(h, { presetId: 'gitlab' })).rejects.toMatchObject({ code: 'bad_input' });
      expect(sqlExec(h.db).exec(`SELECT id FROM user_mcp_servers`).toArray()).toEqual([]);

      await add(h, { presetId: 'github', headers: { Authorization: 'Bearer a' } });
      await expect(add(h, { presetId: 'github', headers: { Authorization: 'Bearer b' } })).rejects.toMatchObject({ code: 'bad_input' });
      expect(sqlExec(h.db).exec(`SELECT id FROM user_mcp_servers`).toArray()).toHaveLength(1);
    });
  });

  test('userMcp_presets reports which oauth-app presets the deployment carries', async () => {
    const h = createTestUserDO({ mcpAppCredentials: ['github'] });

    expect(await h.userDO.userMcp_presets(await testOwner())).toEqual([{ id: 'github', appConfigured: true }, { id: 'cloudflare', appConfigured: true }]);
    h.close();
  });
});

describe("the owner's assistant learns the connections the account holds", () => {
  // The rc27 review: the assistant's GitHub and Gmail checks ran every 15 minutes whether or not either was connected.
  test('connecting and removing a connection tells the assistant which it now holds, and no other workspace', async () => {
    await withGitHub(async (h) => {
      const owner = await testOwner();
      const added = await add(h, { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } });

      // No assistant yet: nothing to tell.
      expect(h.connectionsChanged).toEqual([]);
      expect(await h.userDO.userMcp_connectedPresets(owner)).toEqual(['github']);
      await h.userDO.userMcp_remove(owner, added.id);
      await h.userDO.claimConfig(owner, 'assistant', 'kinu-home');

      const again = await add(h, { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } });

      await h.userDO.userMcp_remove(owner, again.id);
      expect(h.connectionsChanged).toEqual(['kinu-home:github', 'kinu-home:']);
    });
  });

  // Review, 2026-10-23: a wake dials no server, and a server it had not dialled read as not connected, so removing one
  // connection after a wake told the assistant it held none and cancelled the other's watchers.
  test('after a wake, which dials nothing, the presets held are named, and removing one keeps the watchers of another', async () => {
    const tracker = mcpTestServer();

    await withGitHub(async (h) => {
      const owner = await testOwner();

      await h.userDO.claimConfig(owner, 'assistant', 'kinu-home');
      await add(h, { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } });
      const other = await add(h, { name: 'tracker', serverUrl: tracker.url });
      const woken = createTestUserDO({ storage: h.db });

      try {
        expect(await woken.userDO.userMcp_connectedPresets(owner)).toEqual(['github']);
        await woken.userDO.userMcp_remove(owner, other.id);
        expect({ presets: await woken.userDO.userMcp_connectedPresets(owner), told: woken.connectionsChanged.at(-1) }).toEqual({ presets: ['github'], told: 'kinu-home:github' });
      } finally {
        woken.close();
        await tracker.stop();
      }
    });
  });

  // The Google connection replaced the Gmail preview preset (ledger 1023-n): the assistant's Gmail check keys on it.
  test('the Google connection is a connection the assistant is told of as it comes and goes', async () => {
    const h = createTestUserDO();
    const owner = await testOwner();
    const credential: OAuthCredential = { kind: 'oauth', accessToken: 'ya29.held', refreshToken: '1//refresh', expiresAt: Date.now() + 3_600_000, metadata: { account: 'owner@gmail.com', scopes: [] } };

    await provisionTestWorkspace(h, 'shop');
    await h.userDO.claimConfig(owner, 'assistant', 'kinu-home');
    await h.userDO.setCredential(owner, GOOGLE_OAUTH_CRED_KEY, credential);

    expect(await h.userDO.userMcp_connectedPresets(owner)).toEqual(['google']);
    await h.userDO.deleteCredential(owner, GOOGLE_OAUTH_CRED_KEY, false);
    expect(h.connectionsChanged).toEqual(['kinu-home:google', 'kinu-home:']);
    // The Google connection bears no workspace's secret: no workspace is told its secrets moved.
    expect(h.secretsMoved).toEqual([]);
    h.close();
  });
});

describe("a GitHub answer that a repository was not reached", () => {
  /** A GitHub tool's error as its MCP server words it (github/github-mcp-server pkg/errors, `message: err`). */
  async function answered(text: string): Promise<string> {
    let answer = '';

    await withGitHub(async (h, server) => {
      const added = await add(h, { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } });

      server.answer = () => ({ isError: true, content: [{ type: 'text', text }] });
      answer = await h.userDO.userMcp_callTool(await testOwner(), { serverId: added.id, name: 'get_file_contents', args: {}, id: crypto.randomUUID() });
    }, { mcpAppCredentials: ['github'] });

    return answer;
  }

  // A 404 or 403 from GitHub does not say which account, app or policy kept the repository out of reach, so the agent is
  // told GitHub's words, what can cause them, and where each is changed, never a single verdict.
  test("keeps GitHub's words and lists what can cause them, with where each is changed", async () => {
    const words = 'failed to get file contents: GET https://api.github.com/repos/kinu-run/billing-worker/contents/wrangler.toml: 404 Not Found []';
    const answer = await answered(words);

    expect(answer).toContain(JSON.stringify(words).slice(1, -1));
    expect(answer).toContain('https://github.com/settings/connections/applications/test-github-client-id');
    expect(answer).toContain('https://github.com/settings/installations');
  });

  test('an error that is not a repository out of reach is passed on as GitHub worded it, and nothing more', async () => {
    const words = 'failed to create issue: POST https://api.github.com/repos/kinu-run/billing-worker/issues: GitHub API rate limit exceeded. Wait before retrying.';

    expect(JSON.parse(await answered(words))).toMatchObject({ isError: true, content: [{ type: 'text', text: words }] });
  });
});

/** GitHub's discovery documents as measured on 2026-10-19, and its token endpoint, which records what each exchange
 *  sent. Its authorization server lists no registration endpoint; one asked for is recorded, never answered. */
function github() {
  const exchanges: URLSearchParams[] = [];

  const resource: JsonValue = {
    resource: 'https://api.githubcopilot.com/mcp/', authorization_servers: ['https://github.com/login/oauth'],
    scopes_supported: ['repo', 'read:org', 'read:user', 'user:email', 'read:packages', 'write:packages', 'read:project', 'project', 'gist', 'notifications'],
    bearer_methods_supported: ['header'], resource_name: 'GitHub MCP Server',
  };

  const documents = new Map<string, JsonValue>([
    ['https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/', resource],
    ['https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp', resource],
    ['https://github.com/.well-known/oauth-authorization-server/login/oauth', {
      issuer: 'https://github.com/login/oauth', authorization_endpoint: 'https://github.com/login/oauth/authorize',
      token_endpoint: 'https://github.com/login/oauth/access_token', response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, scopes_supported: ['offline_access'],
    }],
  ]);

  const elsewhere = async (url: string, init?: RequestInit): Promise<Response> => {
    const document = documents.get(url);

    if (document !== undefined) return Response.json(document);

    if (url !== 'https://github.com/login/oauth/access_token') return new Response('not found', { status: 404 });
    exchanges.push(new URLSearchParams(await new Request(url, init).text()));

    return Response.json({ access_token: 'gho_signed', token_type: 'bearer', scope: 'repo,read:org,read:user' });
  };

  return { elsewhere, exchanges };
}

describe("a registered app's sign-in, through the account's own begin and callback", () => {
  // Staging, 2026-10-19: the owner's GitHub app was asked for every scope GitHub's MCP lists (write:packages, gist,
  // project...), the SDK preferring the server's protected-resource scopes_supported to the preset's own.
  test("asks for the preset's scope as the registered app, registers nothing, and the code's exchange authenticates the app", async () => {
    const server = mcpTestServer({ tools: [{ name: 'get_me', inputSchema: { type: 'object' } }] });
    const h = createTestUserDO({ mcpAppCredentials: ['github'] });
    const owner = await testOwner();
    const issuer = github();
    const asked = network({ [GITHUB_URL]: server }, issuer.elsewhere);
    const preset = present(mcpPresetById('github'), 'the GitHub preset');

    server.bearer = 'gho_signed';

    try {
      const added = await add(h, { presetId: 'github' });
      const run = crypto.randomUUID();
      const authUrl = new URL((await h.userDO.userMcp_beginConnect(owner, added.id, run)).authUrl);
      // `offline_access` asks the server for a refresh token, which the SDK adds where the server lists it.
      const scope = authUrl.searchParams.get('scope')?.split(' ').filter((each) => each !== 'offline_access');

      expect({ client: authUrl.searchParams.get('client_id'), scope, redirect: authUrl.searchParams.get('redirect_uri') })
        .toEqual({ client: 'test-github-client-id', scope: preset.scope?.split(' '), redirect: 'https://kinu.example/api/user/mcp/callback' });

      const callback = new URL('https://kinu.example/api/user/mcp/callback');

      callback.searchParams.set('code', 'code-test');
      callback.searchParams.set('state', authUrl.searchParams.get('state') ?? '');
      callback.searchParams.set('iss', 'https://github.com/login/oauth');
      expect(await h.userDO.userMcp_handleOAuthCallback(owner, callback.toString())).toEqual({ run, service: 'GitHub', error: null });

      expect(issuer.exchanges.map((form) => [form.get('grant_type'), form.get('client_id'), form.get('client_secret')]))
        .toEqual([['authorization_code', 'test-github-client-id', 'test-github-client-secret']]);
      expect(asked.some((url) => url.includes('register'))).toBe(false);
      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.status, s.toolsCount])).toEqual([['connected', 1]]);
      expect(server.calls).toEqual([]);
    } finally {
      await server.stop();
      h.close();
    }
  });
});
