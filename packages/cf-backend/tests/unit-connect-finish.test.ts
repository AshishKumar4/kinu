// Every connect run in another tab ends on the one finish page, which tells the page that started it and closes; the
// owner's report (2026-10-20): an MCP sign-in from setup's tools step ended inside the app, on setup's first step.
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { APP_ROUTES, connectEndedOf, createCredentialCipher, type UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { createTestUserDO, sqlExec, TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner, type TestUserDO } from './helpers/user-do';
import { scriptedOAuthNetwork, scriptedOAuthServer, storedMcpServer } from './helpers/mcp-server';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';

const IDENTITY: AuthIdentity = { userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

const CALLBACK = 'https://kinu.example/api/user/mcp/callback';

afterEach(() => { setSystemTime(); });

/** Runs `body` over an account whose OAuth server, the tiers' own, waits for its sign-in. */
async function withSignInPending(body: (h: TestUserDO, id: string, owner: UserCaller, net: ReturnType<typeof scriptedOAuthNetwork>) => Promise<void>): Promise<void> {
  const net = scriptedOAuthNetwork();
  const h = createTestUserDO();
  const owner = await testOwner();

  try {
    const added = await h.userDO.userMcp_add(owner, { name: 'linear', serverUrl: scriptedOAuthServer(3600) }, 'https://kinu.example');

    expect(added.signIn).toBe(true);
    await body(h, added.id, owner, net);
  } finally {
    net.restore();
    h.close();
  }
}

describe('an MCP server\'s sign-in ends on the finish page', () => {
  test('the callback sends its tab to the finish page, naming the server and why, never into the app', async () => {
    const harness = createTestUserDO();

    const stub = userAccount({
      async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
      userMcp_handleOAuthCallback: (caller: UserCaller, url: string) => harness.userDO.userMcp_handleOAuthCallback(caller, url),
    });

    const env: UserRoutesEnv<string> = {
      UserDO: { idFromName: (name) => name, get: () => stub },
      OrchestratorAgent: { idFromName: (name) => name, get: () => workspaceObject({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    try {
      // A state this account never issued: the sign-in fails, in the account's own words.
      const answered = await serveFamily(userRoutes, { identity: IDENTITY, ctx: { waitUntil() {} } })(
        new Request('https://kinu.example.com/api/user/mcp/callback?state=forged.srv-x&code=c'), env,
      );

      const ended = new URL(answered?.headers.get('location') ?? '');

      expect({ status: answered?.status, page: ended.pathname, service: connectEndedOf(ended.searchParams).service, failed: ended.searchParams.has('error') })
        .toEqual({ status: 302, page: APP_ROUTES.connected, service: 'the MCP server', failed: true });
    } finally {
      harness.close();
    }
  });

  test('a sign-in begun from a page is begun for the server its address names, and the run the page sent', async () => {
    const begun: { id: string; run: string }[] = [];

    const stub = userAccount({
      async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
      userMcp_beginConnect: async (_caller: UserCaller, id: string, run: string) => {
        begun.push({ id, run });

        return { authUrl: 'https://mcp.example.com/authorize' };
      },
    });

    const env: UserRoutesEnv<string> = {
      UserDO: { idFromName: (name) => name, get: () => stub },
      OrchestratorAgent: { idFromName: (name) => name, get: () => workspaceObject({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const run = '5f0c3a8e-2b1d-4c7e-9a64-1d2e3f405162';

    const answered = await serveFamily(userRoutes, { identity: IDENTITY, ctx: { waitUntil() {} } })(
      new Request('https://kinu.example.com/api/user/mcp/servers/srv%2Done/connect', { method: 'POST', body: JSON.stringify({ run }), headers: { 'content-type': 'application/json' } }), env,
    );

    expect({ status: answered?.status, begun }).toEqual({ status: 200, begun: [{ id: 'srv-one', run }] });
  });

  // Review finding (2026-10-23): a run was kept by its server, and a callback was answered for the server its state named
  // whether or not that state was minted, so a second tab's begin, or a link anyone could write, ended a sign-in.
  test('each sign-in ends the run that began it, found by its exact state; a state it never minted ends none', async () => {
    await withSignInPending(async (h, id, owner) => {
      // Awake again, the server waits for its sign-in; two tabs begin one each.
      const woken = createTestUserDO({ storage: h.db });
      const runs = [crypto.randomUUID(), crypto.randomUUID()];

      try {
        const states: string[] = [];

        for (const run of runs) states.push(new URL((await woken.userDO.userMcp_beginConnect(owner, id, run)).authUrl).searchParams.get('state') ?? '');
        const ended = async (state: string) => (await woken.userDO.userMcp_handleOAuthCallback(owner, `${CALLBACK}?state=${state}&error=access_denied`)).run;

        expect({ forged: await ended(`forged.${id}`), first: await ended(states[0] ?? ''), second: await ended(states[1] ?? ''), replayed: await ended(states[0] ?? '') })
          .toEqual({ forged: null, first: runs[0], second: runs[1], replayed: null });
      } finally {
        woken.close();
      }
    });
  });

  // Sol's review (2026-10-23): a consent left open past ten minutes lost its run, so the page that began it never heard;
  // and a decline was dialled again inside the callback, though the row's own sign-in begins a fresh one.
  test('a declined sign-in is said at once, however late, sends the server nothing, and its row still offers a sign-in', async () => {
    await withSignInPending(async (h, id, owner, net) => {
      const begun = async () => {
        const run = crypto.randomUUID();
        const state = new URL((await h.userDO.userMcp_beginConnect(owner, id, run)).authUrl).searchParams.get('state') ?? '';

        return { run, state };
      };

      const early = await begun();
      const late = await begun();
      const served = net.served.length;
      const declined = await h.userDO.userMcp_handleOAuthCallback(owner, `${CALLBACK}?state=${early.state}&error=access_denied`);

      setSystemTime(new Date(Date.now() + 11 * 60_000));
      const expired = await h.userDO.userMcp_handleOAuthCallback(owner, `${CALLBACK}?state=${late.state}&error=access_denied`);

      expect({ declined: [declined.run === early.run, declined.error], expired: expired.run === late.run, sent: net.served.length - served })
        .toEqual({ declined: [true, 'access_denied'], expired: true, sent: 0 });
      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.status, s.signIn])).toEqual([['needs_sign_in', true]]);
    });
  });

  // Sol's final review (2026-10-23), the retention: a run is kept until its callback takes it or its server goes, not
  // pruned by an age of its own.
  test("a sign-in's run is named however late its callback, and goes with its server", async () => {
    await withSignInPending(async (h, id, owner) => {
      const [early, later, removed] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const stateOf = async (run: string) => new URL((await h.userDO.userMcp_beginConnect(owner, id, run)).authUrl).searchParams.get('state') ?? '';
      const ended = async (state: string) => (await h.userDO.userMcp_handleOAuthCallback(owner, `${CALLBACK}?state=${state}&error=access_denied`)).run;

      const earlyState = await stateOf(early);

      // A day and more later, another tab begins one.
      setSystemTime(new Date(Date.now() + 25 * 60 * 60_000));
      await stateOf(later);
      const lateNamed = await ended(earlyState);
      const goneState = await stateOf(removed);

      await h.userDO.userMcp_remove(owner, id);
      expect({ late: lateNamed === early, afterRemoval: await ended(goneState) }).toEqual({ late: true, afterRemoval: null });
    });
  });

  // Sol's final review (2026-10-23): a server offered its sign-in while it was connected, and any custom header was read
  // as a token.
  test('a server offers a sign-in only while it waits for one, or failed holding an OAuth client; a credential header alone rules it out', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    // Headers sealed as an add seals them, for this object and its server: none, a tenant header, a token.
    const seeded = [['srv-live', null], ['srv-tenant', { 'X-Tenant': 'acme' }], ['srv-token', { Authorization: 'Bearer ghp_test' }]] as const;
    const offered: Record<string, boolean> = {};

    try {
      for (const [id, headers] of seeded) {
        storedMcpServer(sqlExec(harness.db), { id, name: id, url: `https://${id}.example/mcp`, tools: [] });
        const sealed = headers === null ? null : await cipher.seal(`test-user-do:mcp:${id}`, JSON.stringify(headers));

        sqlExec(harness.db).exec(`UPDATE user_mcp_servers SET headers = ?, oauth_client_id = 'client-1' WHERE id = ?`, sealed, id);
      }

      for (const status of ['connected', 'needs_sign_in', 'failed'] as const) {
        sqlExec(harness.db).exec(`UPDATE user_mcp_servers SET status = ?`, status);

        for (const listed of await harness.userDO.userMcp_list(owner)) offered[`${listed.name} ${status}`] = listed.signIn;
      }

      sqlExec(harness.db).exec(`UPDATE user_mcp_servers SET status = 'connected'`);
      await expect(harness.userDO.userMcp_beginConnect(owner, 'srv-live', crypto.randomUUID())).rejects.toMatchObject({ code: 'bad_input' });

      expect(offered).toEqual({
        'srv-live connected': false, 'srv-tenant connected': false, 'srv-token connected': false,
        'srv-live needs_sign_in': true, 'srv-tenant needs_sign_in': true, 'srv-token needs_sign_in': false,
        'srv-live failed': true, 'srv-tenant failed': true, 'srv-token failed': false,
      });
    } finally {
      harness.close();
    }
  });
});
