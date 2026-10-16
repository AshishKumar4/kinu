/**
 * Staging abe54b776 (2026-10-16 02:59:07Z): account-settings renamed the account and read it straight back, and the
 * read answered the name it had before. The browser tier's cookie session on the same account had been signed in while
 * the account was named "Kinu first-run"; a session keeps the name it was signed in under, and every account route
 * upserts the profile with it, so that session's next request (02:59:07.144, between the rename and the read) wrote the
 * old name back. The owner's own browser does the same to a rename on its next request.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import type { AuthIdentity } from '../src/auth/session';
import { accountIdFor, createSession, verifySession } from '../src/auth/store';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthStoreEnv } from '../src/auth/store';
import { serveFamily } from './helpers/api';
import { unreachableNamespace, workerContext } from './helpers/bindings';
import { makeKv } from './helpers/kv';
import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const EMAIL = 'owner@example.com';

const NameSchema = v.object({ displayName: v.nullable(v.string()) });

test("a session signed in under the account's old name leaves a rename standing: the account's name is the owner's", async () => {
  const user = createTestUserDO();
  const namespace = { idFromName: (name: string) => name, get: () => user.userDO };
  const auth: AuthStoreEnv<string> = { AUTH_KV: makeKv(), UserDO: namespace, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY };

  const routes: UserRoutesEnv<string> = {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: namespace,
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };

  /** One account route, as `identity` asks it: what the profile it answered names the account. */
  const named = async (identity: AuthIdentity, method: 'GET' | 'PATCH', displayName?: string) => {
    const answered = await serveFamily(userRoutes, { identity, ctx: workerContext() })(new Request('https://kinu.example.com/api/user/profile', {
      method,
      ...(displayName !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }) }),
    }), routes);

    return v.parse(NameSchema, await answered?.json()).displayName;
  };

  // The dev identity's header names the account; then a browser signs in while it is so named, by the header's exchange.
  const header: AuthIdentity = { userId: await accountIdFor(auth, EMAIL), email: EMAIL, sub: 'dev', provider: 'dev' };

  expect(await named(header, 'PATCH', 'Kinu first-run')).toBe('Kinu first-run');
  const browser = await createSession(auth, { provider: 'dev', providerSub: 'dev', email: EMAIL, emailVerified: true });
  const cookie = await verifySession(auth, browser.token);

  if (cookie === null) throw new Error('the session the browser signed in with did not verify');

  expect(await named(header, 'PATCH', 'Renamed')).toBe('Renamed');
  expect(await named(cookie, 'GET')).toBe('Renamed');
  expect(await named(header, 'GET')).toBe('Renamed');
  user.close();
});
