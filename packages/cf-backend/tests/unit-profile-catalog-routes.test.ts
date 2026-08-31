// The account profile catalog over both authenticated transports: browser
// session routes and the CLI's bearer-authenticated route. Both delegate to the
// same UserDO CAS row; neither serializes credentials or a second authority.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  BUILTIN_PROFILE_CATALOG,
  JsonValueSchema,
  decodeJsonValue,
  profileCatalogDigest,
  validateProfileCatalog,
  validateProfileCatalogEnvelope,
  type JsonValue,
  type ProfileCatalog,
} from '@kinu.run/core';
import type { AuthIdentity } from '../src/auth/session';
import { handleCliRequest } from '../src/cli/routes';
import { handleUserRequest } from '../src/user/routes';
import {
  TEST_CREDENTIAL_ENCRYPTION_KEY,
  createTestUserDO,
  testOwner,
  type TestUserDO,
} from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';
const IDENTITY: AuthIdentity = {
  userId: USER_ID,
  email: 'ashish@example.com',
  sub: 'route-test',
  provider: 'test',
  displayName: 'Ashish',
};

const CUSTOM_CATALOG: ProfileCatalog = validateProfileCatalog({
  roles: {
    ...BUILTIN_PROFILE_CATALOG.roles,
    reviewer: {
      description: 'Review work before it ships.',
      instructions: 'Find defects and name evidence.',
      tier: 'slow',
      preset: 'audit',
    },
  },
  tiers: {
    ...BUILTIN_PROFILE_CATALOG.tiers,
    slow: { model: 'workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813', reasoningEffort: 'high' },
  },
});

const ProfileCatalogWriteRequestSchema = v.object({
  catalog: JsonValueSchema,
  expectedVersion: v.number(),
});

interface ProfileCatalogWriteRequest {
  catalog: ProfileCatalog | JsonValue;
  expectedVersion: number;
}

interface ProfileCatalogRouteBindings {
  CREDENTIAL_ENCRYPTION_KEY: string;
  UserDO: {
    idFromName(name: string): string;
    get(): TestUserDO['userDO'];
  };
}

function routeEnv(userDO: TestUserDO['userDO']): Env {
  const bindings: ProfileCatalogRouteBindings = {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: { idFromName: (name: string) => name, get: () => userDO },
  };
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: Profile catalog handlers read exactly the constructed UserDO
  // namespace and credential key; every reachable binding is present.
  return env as Env;
}

async function setup() {
  const harness = createTestUserDO({ durableObjectId: USER_ID });
  const owner = await testOwner();
  await harness.userDO.ensureProfile(owner, IDENTITY.email, IDENTITY.displayName ?? undefined);
  const session = await harness.userDO.mintCliToken(owner, USER_ID, "a".repeat(64), "profile route test");
  return { harness, owner, token: session.token, env: routeEnv(harness.userDO) };
}

function handled(response: Response | null): Response {
  if (!response) throw new Error('profile route did not handle the request');
  return response;
}

function userRequest(method = 'GET', body?: ProfileCatalogWriteRequest): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(v.parse(ProfileCatalogWriteRequestSchema, {
    catalog: decodeJsonValue({ value: body.catalog }),
    expectedVersion: body.expectedVersion,
  }));
  return new Request('https://kinu.example.com/api/user/profile-catalog', init);
}

function cliRequest(token: string, method = 'GET', body?: ProfileCatalogWriteRequest): Request {
  const init: RequestInit = {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(v.parse(ProfileCatalogWriteRequestSchema, {
    catalog: decodeJsonValue({ value: body.catalog }),
    expectedVersion: body.expectedVersion,
  }));
  return new Request('https://kinu.example.com/api/cli/profile', init);
}

describe('browser profile catalog route', () => {
  test('GET exposes the pristine account envelope and PUT advances it', async () => {
    const { harness, env } = await setup();

    const initialResponse = handled(await handleUserRequest(userRequest(), env, IDENTITY));
    const initial = validateProfileCatalogEnvelope(await initialResponse.json());
    expect(initialResponse.status).toBe(200);
    expect(initial).toEqual({
      authority: { kind: 'account', accountId: USER_ID },
      version: 0,
      digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
      catalog: BUILTIN_PROFILE_CATALOG,
    });

    const putResponse = handled(await handleUserRequest(userRequest('PUT', {
      catalog: CUSTOM_CATALOG,
      expectedVersion: 0,
    }), env, IDENTITY));
    const written = validateProfileCatalogEnvelope(await putResponse.json());
    expect(putResponse.status).toBe(200);
    expect(written.version).toBe(1);
    expect(written.catalog).toEqual(CUSTOM_CATALOG);
    harness.close();
  });

  test('a stale writer receives the current version and digest', async () => {
    const { harness, env } = await setup();
    await handleUserRequest(userRequest('PUT', { catalog: CUSTOM_CATALOG, expectedVersion: 0 }), env, IDENTITY);

    const response = handled(await handleUserRequest(userRequest('PUT', {
      catalog: BUILTIN_PROFILE_CATALOG,
      expectedVersion: 0,
    }), env, IDENTITY));
    const body = v.parse(v.object({
      error: v.string(), currentVersion: v.number(), currentDigest: v.string(),
    }), await response.json());

    expect(response.status).toBe(409);
    expect(body.currentVersion).toBe(1);
    expect(body.currentDigest).toBe(profileCatalogDigest(CUSTOM_CATALOG));
    harness.close();
  });

  test('malformed input is 400 and never advances storage', async () => {
    const { harness, env } = await setup();

    const response = handled(await handleUserRequest(userRequest('PUT', {
      catalog: { roles: {}, tiers: { default: {} } },
      expectedVersion: 0,
    }), env, IDENTITY));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('invalid profile catalog');
    expect((await harness.userDO.getProfileCatalog(await testOwner())).version).toBe(0);
    harness.close();
  });

  test('the generic config route cannot become a second catalog path', async () => {
    const { harness, env } = await setup();
    const response = handled(await handleUserRequest(
      new Request('https://kinu.example.com/api/user/config/profile_catalog'),
      env,
      IDENTITY,
    ));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('/api/user/profile-catalog');
    harness.close();
  });
});

describe('CLI profile catalog route', () => {
  test('the session route reads and CAS-writes the same account authority', async () => {
    const { harness, env, token } = await setup();

    const initial = handled(await handleCliRequest(cliRequest(token), env));
    const read = validateProfileCatalogEnvelope(await initial.json());
    expect(read.version).toBe(0);
    expect(read.authority).toEqual({ kind: 'account', accountId: USER_ID });

    const put = handled(await handleCliRequest(cliRequest(token, 'PUT', {
      catalog: CUSTOM_CATALOG,
      expectedVersion: read.version,
    }), env));
    const written = validateProfileCatalogEnvelope(await put.json());
    expect(put.status).toBe(200);
    expect(written.version).toBe(1);
    expect(await harness.userDO.getProfileCatalog(await testOwner())).toEqual(written);
    harness.close();
  });

  test('a scoped access token cannot reach the owner-only profile route', async () => {
    const { harness, env, owner } = await setup();
    const minted = await harness.userDO.mintAccessToken(owner, USER_ID, 'CI', ['workspace.read']);
    if (!minted.ok) throw new Error(minted.error);

    const response = handled(await handleCliRequest(cliRequest(minted.token), env));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('interactive CLI session token');
    harness.close();
  });
});
