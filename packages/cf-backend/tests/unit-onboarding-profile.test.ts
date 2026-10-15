// Production, 2026-10-13: onboarding failed with 'Invalid key: Expected "controlPlane" but received undefined'.
// The name step's PATCH answered the bare profile while the browser parses every profile answer with one schema.
// The browser's own calls run against both account route families, mounted in the app's order, so a route whose
// answer drifts from that schema fails.
import { afterEach, expect, test } from 'bun:test';
import * as v from 'valibot';
import { asFetchFunction } from '@kinu.run/core';
import { Hono } from 'hono';
import type { FamilyEnv } from '../src/api/context';
import type { AuthIdentity } from '../src/auth/session';
import { getProfile, setDisplayName } from '../src/lib/user-api';
import { accountRoutes, type AccountRoutesEnv } from '../src/user/account-routes';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import { serveFamily } from './helpers/api';
import { unreachableNamespace } from './helpers/bindings';
import { workspaceObject } from './helpers/bindings';
import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const OWNER = 'fedcba9876543210fedcba9876543210';

const IDENTITY: AuthIdentity = { userId: OWNER, email: 'new@example.com', sub: 'onboarding', provider: 'test' };

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

test('a new account names itself in onboarding and reads its profile back', async () => {
  const user = createTestUserDO({ durableObjectId: OWNER });

  const env: UserRoutesEnv<string> & AccountRoutesEnv<string> = {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: { idFromName: (name) => name, get: () => user.userDO },
    OrchestratorAgent: { idFromName: (name) => name, get: () => workspaceObject({}) },
    GALLERY: unreachableNamespace('GALLERY'),
  };

  // The app mounts the owner-only account family ahead of the user family (api/app.ts).
  const families = new Hono<FamilyEnv<UserRoutesEnv<unknown> & AccountRoutesEnv<unknown>>>().route('/', accountRoutes).route('/', userRoutes);

  const serve = serveFamily(families, { identity: IDENTITY, ctx: { waitUntil: () => {} } });

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const answered = await serve(new Request(new URL(v.parse(v.string(), input), 'https://kinu.example.com'), init), env);

    return answered ?? new Response(null, { status: 404 });
  });

  expect(await getProfile()).toMatchObject({ displayName: null, onboardedAt: null, controlPlane: false });

  const named = await setDisplayName('Ada');

  expect(named).toMatchObject({ displayName: 'Ada', controlPlane: false });
  expect(await getProfile()).toMatchObject({ displayName: 'Ada', controlPlane: false });
});
