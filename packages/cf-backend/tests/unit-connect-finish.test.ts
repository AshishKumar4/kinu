// Every connect run in another tab ends on the one finish page, which tells the page that started it and closes; the
// owner's report (2026-10-20): an MCP sign-in from setup's tools step ended inside the app, on setup's first step.
import { describe, expect, setSystemTime, test } from 'bun:test';
import { APP_ROUTES, connectEndedOf, type UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { createTestUserDO, sqlExec, TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner } from './helpers/user-do';
import { recordedMcpLifecycle, requireMcpSignIn, seedConfiguredMcpServer, seedSdkMcpServer } from './helpers/agents-sdk';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';

const IDENTITY: AuthIdentity = { userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

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

  // Review finding (2026-10-23): a run was kept by its server, and the SDK answers a callback with the server its state
  // names whether or not it minted that state, so a second tab's begin, or a link anyone could write, ended a sign-in.
  test('each sign-in ends the run that began it, found by its exact state; a state it never minted ends none', async () => {
    const callback = 'https://kinu.example.com/api/user/mcp/callback';
    const first = createTestUserDO();
    const owner = await testOwner();

    await first.userDO.userMcp_list(owner);
    seedConfiguredMcpServer(sqlExec(first.db), 'srv1', { name: 'linear', url: 'https://mcp.linear.example/mcp', transport: 'streamable-http' });
    seedSdkMcpServer('srv1', { type: 'streamable-http' }, { name: 'linear', url: 'https://mcp.linear.example/mcp', callbackUrl: callback, authUrl: 'https://auth.example/authorize?state=before.srv1' });

    // Awake again, the server waits for its sign-in; two tabs begin one each.
    const woken = createTestUserDO({ storage: first.db });
    const runs = [crypto.randomUUID(), crypto.randomUUID()];

    try {
      for (const [tab, run] of runs.entries()) {
        requireMcpSignIn('srv1', `https://auth.example/authorize?state=minted${String(tab)}.srv1`);
        await woken.userDO.userMcp_beginConnect(owner, 'srv1', run);
      }

      const ended = async (state: string) => (await woken.userDO.userMcp_handleOAuthCallback(owner, `${callback}?state=${state}&error=access_denied`)).run;

      expect({ forged: await ended('forged.srv1'), first: await ended('minted0.srv1'), second: await ended('minted1.srv1'), replayed: await ended('minted0.srv1') })
        .toEqual({ forged: null, first: runs[0], second: runs[1], replayed: null });
    } finally {
      woken.close();
      first.close();
    }
  });

  // Sol's review (2026-10-23): a consent left open past the SDK's ten minutes lost its run, so the page that began it
  // never heard; and a decline was dialled again inside the callback, though the row's own sign-in begins a fresh one.
  async function declined(late: boolean) {
    const callback = 'https://kinu.example.com/api/user/mcp/callback';
    const first = createTestUserDO();
    const owner = await testOwner();

    await first.userDO.userMcp_list(owner);
    seedConfiguredMcpServer(sqlExec(first.db), 'srv1', { name: 'linear', url: 'https://mcp.linear.example/mcp', transport: 'streamable-http' });
    // Its OAuth client registered, as a sign-in registers one before it sends the person to the provider.
    seedSdkMcpServer('srv1', { type: 'streamable-http' }, { name: 'linear', url: 'https://mcp.linear.example/mcp', callbackUrl: callback, clientId: 'client-1', authUrl: 'https://auth.example/authorize?state=before.srv1' });

    const woken = createTestUserDO({ storage: first.db });
    const run = crypto.randomUUID();

    try {
      requireMcpSignIn('srv1', 'https://auth.example/authorize?state=asked.srv1');
      await woken.userDO.userMcp_beginConnect(owner, 'srv1', run);
      const dialledAtBegin = recordedMcpLifecycle().dialled.length;

      if (late) setSystemTime(new Date(Date.now() + 11 * 60_000));
      const ended = await woken.userDO.userMcp_handleOAuthCallback(owner, `${callback}?state=asked.srv1&error=access_denied`);
      const [listed] = await woken.userDO.userMcp_list(owner);

      return { named: ended.run === run, dialledAfter: recordedMcpLifecycle().dialled.length - dialledAtBegin, status: listed?.status, signIn: listed?.signIn };
    } finally {
      setSystemTime();
      woken.close();
      first.close();
    }
  }

  test('a declined sign-in is said at once, not dialled again, and its row still offers a sign-in', async () => {
    expect(await declined(false)).toEqual({ named: true, dialledAfter: 0, status: 'failed', signIn: true });
  });

  test('a sign-in declined after its state expired still names its run', async () => {
    expect((await declined(true)).named).toBe(true);
  });

});
