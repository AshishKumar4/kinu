// DELETE /api/user/account at the HTTP boundary: the typed phrase gates the
// call, the recipients of the account's shares are forgotten BEFORE the
// object is destroyed, and the SDK's own abort sentinel reads as success while
// any other failure still reaches the caller.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { handleAccountRequest } from '../src/user/account-routes';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import type { AuthIdentity } from '../src/auth/session';
import type { UserCaller } from '@kinu.run/core';

const USER_ID = '0123456789abcdef0123456789abcdef';

const IDENTITY: AuthIdentity = { userId: USER_ID, email: 'Owner@Example.test', sub: 'sub-1' };

const DeletedSchema = v.object({ deleted: v.literal(true) });

const ErrorSchema = v.object({ error: v.string() });

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(id: string): Stub;
}

/** The two UserDO calls the delete route makes, recorded in order, plus the
 *  roster read `forgetSharesGiven` walks — empty here, because the recipients
 *  half is a walk over workspace objects this test does not build. */
function setup(deleteOutcome: 'ok' | 'destroyed' | 'io') {
  const calls: string[] = [];

  const userDO = {
    async listActiveWorkspaces(_caller: UserCaller) {
      calls.push('workspaces:list');

      return [];
    },
    async searchExperience(_caller: UserCaller, options: { kind?: string; limit?: number }) {
      calls.push(`experience:${options.kind ?? '-'}:${String(options.limit)}`);

      return [];
    },
    async deleteAccount(_caller: UserCaller, ownerUserId: string) {
      calls.push(`account:delete:${ownerUserId}`);

      if (deleteOutcome === 'destroyed') throw new Error('destroyed');

      if (deleteOutcome === 'io') throw new Error('storage unavailable');

      return { ok: true as const, workspaces: 2 };
    },
  };

  const namespace: TestNamespace<typeof userDO> = { idFromName: (name) => name, get: () => userDO };

  const env: Partial<Env> = {};
  Object.assign(env, { UserDO: namespace, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

  // SAFETY: The account routes reach only the two constructed bindings, the
  // UserDO namespace and the credential key; every typed binding reachable in
  // these tests is present.
  return { env: env as Env, calls };
}

function request(body: string): Request {
  return new Request('https://kinu.test/api/user/account', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body,
  });
}

describe('DELETE /api/user/account', () => {
  test('a phrase that is not the account email is refused before anything runs', async () => {
    const { env, calls } = setup('ok');
    const response = await handleAccountRequest(request(JSON.stringify({ confirm: 'someone@else.test' })), env, IDENTITY);

    expect(response?.status).toBe(400);
    expect(v.parse(ErrorSchema, await response?.json()).error).toContain('Type the account email');
    expect(calls).toEqual([]);
  });

  test('a body without the phrase is refused the same way', async () => {
    const { env, calls } = setup('ok');
    const response = await handleAccountRequest(request('{}'), env, IDENTITY);

    expect(response?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('the email in another case forgets the shares, then deletes', async () => {
    const { env, calls } = setup('ok');
    const response = await handleAccountRequest(request(JSON.stringify({ confirm: '  owner@example.TEST ' })), env, IDENTITY);

    expect(response?.status).toBe(200);
    expect(v.parse(DeletedSchema, await response?.json())).toEqual({ deleted: true });
    expect(calls).toEqual(['workspaces:list', `account:delete:${USER_ID}`]);
  });

  test("the SDK's own abort sentinel is a completed delete", async () => {
    const { env, calls } = setup('destroyed');
    const response = await handleAccountRequest(request(JSON.stringify({ confirm: 'owner@example.test' })), env, IDENTITY);

    expect(response?.status).toBe(200);
    expect(calls).toEqual(['workspaces:list', `account:delete:${USER_ID}`]);
  });

  test('any other failure reaches the caller', async () => {
    const { env } = setup('io');

    await expect(handleAccountRequest(request(JSON.stringify({ confirm: 'owner@example.test' })), env, IDENTITY))
      .rejects.toThrow('storage unavailable');
  });

  test('the experience read names its kind and bounds its limit', async () => {
    const { env, calls } = setup('ok');

    const listed = await handleAccountRequest(
      new Request('https://kinu.test/api/user/experience?kind=craft', { method: 'GET' }), env, IDENTITY,
    );

    expect(listed?.status).toBe(200);
    expect(v.parse(v.array(v.unknown()), await listed?.json())).toEqual([]);
    expect(calls).toEqual(['experience:craft:50']);

    for (const query of ['kind=poem', 'kind=craft&limit=500', 'kind=craft&limit=0', 'limit=5']) {
      const refused = await handleAccountRequest(
        new Request(`https://kinu.test/api/user/experience?${query}`, { method: 'GET' }), env, IDENTITY,
      );

      expect(refused?.status).toBe(400);
    }

    expect(calls).toEqual(['experience:craft:50']);
  });

  test('a path the module does not own is left to the next handler', async () => {
    const { env, calls } = setup('ok');

    const response = await handleAccountRequest(
      new Request('https://kinu.test/api/user/account', { method: 'GET' }), env, IDENTITY,
    );

    expect(response).toBeNull();
    expect(calls).toEqual([]);
  });
});
