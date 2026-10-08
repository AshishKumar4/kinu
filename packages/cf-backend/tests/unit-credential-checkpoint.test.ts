/** A reset deletes the user objects' namespace, so the eval account returns under a new object id, which the vault's own
 *  seal binds; the checkpoint carries its credentials across, sealed for the account. */
import { afterEach, expect, test } from 'bun:test';
import * as v from 'valibot';
import { accountCredentialKey, type JsonValue, type UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { createTestUserDO, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY, type TestUserDO } from './helpers/user-do';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import type { CheckpointedCredential } from '../src/user/credentials';

const EVAL_SERVICE: AuthIdentity = {
  userId: 'fedcba9876543210fedcba9876543210', email: 'eval-service@kinu.run', sub: 'dev', provider: 'dev', authTime: 1,
};

const PERSON: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'google', authTime: 1,
};

const WORK = accountCredentialKey('openai.bearer', 'work');

const CheckpointSchema = v.array(v.object({ key: v.string(), sealed: v.string() }));

const opened: TestUserDO[] = [];

afterEach(() => {
  for (const harness of opened.splice(0)) harness.close();
});

function userObject(durableObjectId: string): TestUserDO {
  const harness = createTestUserDO({ durableObjectId });

  opened.push(harness);

  return harness;
}

/** `/api/user/credential-checkpoint` as `identity`, served by `harness`; how often the object was asked. */
async function checkpointRoute(harness: TestUserDO, identity: AuthIdentity, body?: JsonValue) {
  let asked = 0;

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async listActiveWorkspaces() { return []; },
    checkpointCredentials: (caller: UserCaller, account: string) => {
      asked += 1;

      return harness.userDO.checkpointCredentials(caller, account);
    },
    restoreCredentials: (caller: UserCaller, account: string, checkpoint: readonly CheckpointedCredential[]) => {
      asked += 1;

      return harness.userDO.restoreCredentials(caller, account, checkpoint);
    },
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    OrchestratorAgent: { idFromName: (name) => name, get: () => workspaceObject({}) },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const response = await serveFamily(userRoutes, { identity, ctx: { waitUntil() {} } })(new Request('https://kinu.example.com/api/user/credential-checkpoint', body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);

  if (response === null) throw new Error('no route answered the checkpoint');

  return { response, asked };
}

test('the eval account\'s credentials outlive a reset: saved from its object, restored into the one that replaces it', async () => {
  const owner = await testOwner();
  const before = userObject('user-object-before-reset');

  await before.userDO.setCredential(owner, 'opencode-go.bearer', { kind: 'bearer', token: 'go-key' });
  await before.userDO.setCredential(owner, WORK, { kind: 'bearer', token: 'sk-work' });
  const saved = await checkpointRoute(before, EVAL_SERVICE);
  const text = await saved.response.text();
  const checkpoint = v.parse(CheckpointSchema, JSON.parse(text));

  expect(checkpoint.map((each) => each.key)).toEqual([WORK, 'opencode-go.bearer']);
  expect(text).not.toContain('go-key');
  expect(text).not.toContain('sk-work');

  // Stored after the reset and before the restore: the account's newer key stays.
  const after = userObject('user-object-after-reset');

  await after.userDO.setCredential(owner, 'opencode-go.bearer', { kind: 'bearer', token: 'go-key-newer' });
  const restored = await checkpointRoute(after, EVAL_SERVICE, checkpoint);

  expect(v.parse(v.object({ restored: v.array(v.string()) }), await restored.response.json())).toEqual({ restored: [WORK] });
  expect(await after.userDO.getAuthHeaders(owner, WORK)).toEqual({ Authorization: 'Bearer sk-work' });
  expect(await after.userDO.getAuthHeaders(owner, 'opencode-go.bearer')).toEqual({ Authorization: 'Bearer go-key-newer' });
});

test('a checkpoint opens for its own account alone, and the vault\'s own seal for its own object alone', async () => {
  const owner = await testOwner();
  const before = userObject('user-object-before-reset');

  await before.userDO.setCredential(owner, 'opencode-go.bearer', { kind: 'bearer', token: 'go-key' });
  const checkpoint = await before.userDO.checkpointCredentials(owner, EVAL_SERVICE.userId);
  const elsewhere = userObject('another-account-object');

  await expect(elsewhere.userDO.restoreCredentials(owner, PERSON.userId, checkpoint)).rejects.toMatchObject({ code: 'bad_input' });
  expect(await elsewhere.userDO.listCredentials(owner)).toEqual([]);

  const vault = v.parse(v.array(v.object({ key: v.string(), sealed: v.string() })), before.db.query('SELECT key, value AS sealed FROM user_credentials').all());

  await expect(elsewhere.userDO.restoreCredentials(owner, EVAL_SERVICE.userId, vault)).rejects.toMatchObject({ code: 'bad_input' });
});

test('a person is answered as if there were no checkpoint, and the object is never asked', async () => {
  const harness = userObject('a-person-object');

  for (const body of [undefined, []]) {
    const { response, asked } = await checkpointRoute(harness, PERSON, body);

    expect([response.status, asked]).toEqual([404, 0]);
  }
});
