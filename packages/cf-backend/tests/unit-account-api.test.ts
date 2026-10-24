// The account's routes are one handler set under both ways in: a browser's session under `/api/user`, the CLI's bearer
// under `/api/cli`. The two families each kept a copy, and the copies drifted (review F-routes, 2026-10-14): the CLI
// stored a body that was not JSON as null, dropped `?revoke=1` and its outcome, and only the CLI refused to delete a
// workspace already gone. One request now gets one answer, whichever family it came through.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { JsonValue, UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { bootstrappedProfile, cliAccount, unreachableAssets, unreachableKv, unreachableNamespace, userAccount, workspaceObject } from './helpers/bindings';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import { cliRoutes, type CliRoutesEnv } from '../src/cli/routes';
import type { AuthIdentity } from '../src/auth/session';

const USER_ID = '0123456789abcdef0123456789abcdef';

const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;

const IDENTITY: AuthIdentity = { userId: USER_ID, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

/** What the account was asked, whichever family asked it. */
interface Asked {
  readonly stored: Array<readonly [string, JsonValue]>;
  readonly deleted: Array<readonly [string, boolean]>;
  readonly removed: string[];
}

/** One account behind both families: the same members, recording what each was asked. */
function account() {
  const asked: Asked = { stored: [], deleted: [], removed: [] };

  const members = {
    async listActiveWorkspaces(_caller: UserCaller) { return []; },
    async setCredential(_caller: UserCaller, key: string, credential: JsonValue) { asked.stored.push([key, credential]); },
    async deleteCredential(_caller: UserCaller, key: string, revoke: boolean) {
      asked.deleted.push([key, revoke]);

      return { unrevoked: revoke ? 'the provider refused the revoke' : null };
    },
    async requestWorkspaceRemoval(_caller: UserCaller, name: string) { asked.removed.push(name); },
  };

  const web = userAccount({
    ...members,
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
  });

  const cli = cliAccount({
    ...members,
    async verifyCliToken(_caller: UserCaller, token: string) {
      return { ok: token === SESSION_TOKEN, tokenHash: 'session-hash', user: { id: USER_ID, email: IDENTITY.email, displayName: null } };
    },
  });

  return { asked, web, cli };
}

const orchestrators = {
  idFromName: (name: string) => name,
  get: () => workspaceObject({ async onModelSettingsChanged() { return { ok: true as const }; } }),
};

/** `method path` under one family's prefix, with `body` sent as it is; the answer's status and JSON body. */
async function ask(family: 'user' | 'cli', method: string, path: string, body?: string) {
  const { asked, web, cli } = account();
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } };
  const headers = new Headers({ 'content-type': 'application/json' });

  if (family === 'cli') headers.set('authorization', `Bearer ${SESSION_TOKEN}`);
  const request = new Request(`https://kinu.example.com/api/${family}${path}`, { method, headers, ...(body !== undefined && { body }) });

  const webEnv: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => web }, OrchestratorAgent: orchestrators, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const cliEnv: CliRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => cli }, OrchestratorAgent: orchestrators, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    AUTH_KV: unreachableKv('AUTH_KV'), CliAuthDO: unreachableNamespace('CliAuthDO'), ASSETS: unreachableAssets(),
  };

  const response = family === 'user'
    ? await serveFamily(userRoutes, { identity: IDENTITY, ctx })(request, webEnv)
    : await serveFamily(cliRoutes, { ctx })(request, cliEnv);

  if (!response) throw new Error(`no route answered ${method} /api/${family}${path}`);
  await Promise.all(pending);

  return { status: response.status, body: v.parse(v.record(v.string(), v.unknown()), await response.json()), asked };
}

describe('the account routes answer alike under /api/user and /api/cli', () => {
  test('a credential body that is not JSON is refused, never stored as null', async () => {
    for (const family of ['user', 'cli'] as const) {
      const answer = await ask(family, 'POST', '/credentials/openai.bearer', 'not json');

      expect({ family, status: answer.status, stored: answer.asked.stored }).toEqual({ family, status: 400, stored: [] });
    }
  });

  test('a stored credential answers 200', async () => {
    for (const family of ['user', 'cli'] as const) {
      const answer = await ask(family, 'POST', '/credentials/openai.bearer', JSON.stringify({ kind: 'bearer', token: 'sk' }));

      expect({ family, status: answer.status, stored: answer.asked.stored }).toEqual({ family, status: 200, stored: [['openai.bearer', { kind: 'bearer', token: 'sk' }]] });
    }
  });

  test('?revoke=1 has the provider revoke the grant, and its outcome is answered', async () => {
    for (const family of ['user', 'cli'] as const) {
      const answer = await ask(family, 'DELETE', '/credentials/openai.oauth?revoke=1');

      expect({ family, body: answer.body, deleted: answer.asked.deleted })
        .toEqual({ family, body: { ok: true, unrevoked: 'the provider refused the revoke' }, deleted: [['openai.oauth', true]] });
    }
  });

  // The web's rule, which an incident set (staging df49f4cc5, F11): a delete repeated or raced by another is done.
  test('deleting a workspace answers ok, the one it names gone or not', async () => {
    for (const family of ['user', 'cli'] as const) {
      const answer = await ask(family, 'DELETE', '/workspaces/jarvis');

      expect({ family, status: answer.status, removed: answer.asked.removed }).toEqual({ family, status: 200, removed: ['jarvis'] });
    }
  });
});
