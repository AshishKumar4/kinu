// Every connect run in another tab ends on the one finish page, which tells the page that started it and closes; the
// owner's report (2026-10-20): an MCP sign-in from setup's tools step ended inside the app, on setup's first step.
import { describe, expect, test } from 'bun:test';
import { APP_ROUTES, connectEndedOf, type UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
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
});
