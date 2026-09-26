/**
 * A response body carries a failure's class and a message written for the reader, never its cause chain: a
 * chain holds platform wording, file paths and, through a substituted URL or a stored header, secrets. The
 * chain goes to diagnostics. Driven through the shared `onError` and through a route whose object throws.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';
import { KinuError } from '@kinu.run/core/obs';
import type { UserCaller } from '@kinu.run/core';
import { routeError } from '../src/api/context';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import { serveFamily } from './helpers/api';
import { bootstrappedProfile, userAccount, workerContext } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { present } from '@kinu.run/test-utils';

const ErrorBodySchema = v.object({ error: v.string(), code: v.string() });

/** What must never reach a client. */
const LEAK = /\/home\/owner\/\.ssh|sk-live-[a-z0-9]+|SQLITE/u;

const INTERNAL = new Error('SQLITE_IOERR: disk I/O error reading /home/owner/.ssh/id_ed25519 with sk-live-9f8e7d');

async function thrown(error: Error): Promise<{ status: number; body: string }> {
  const app = new Hono();

  app.get('/boom', () => { throw error; });
  app.onError(routeError);
  const response = await app.fetch(new Request('https://kinu.example.com/boom'));

  return { status: response.status, body: await response.text() };
}

describe('the shared onError answers the class, never the chain', () => {
  test('an authored refusal keeps its message and code; its cause stays out', async () => {
    const answer = await thrown(new KinuError('unavailable', 'The credential vault is unreachable; try again.', { cause: INTERNAL }));

    expect(answer.status).toBe(503);
    expect(v.parse(ErrorBodySchema, JSON.parse(answer.body))).toEqual({ error: 'The credential vault is unreachable; try again.', code: 'unavailable' });
  });

  test('an authored message that repeats its cause\'s text is replaced by the class\'s own', async () => {
    const answer = await thrown(new KinuError('io', `reading the key failed: ${INTERNAL.message}`, { cause: INTERNAL }));

    expect(answer.status).toBe(500);
    expect(answer.body).not.toMatch(LEAK);
    expect(v.parse(ErrorBodySchema, JSON.parse(answer.body))).toEqual({ error: 'Internal error.', code: 'io' });
  });

  test('an unclassified throw answers its class alone', async () => {
    const answer = await thrown(INTERNAL);

    expect(answer.status).toBe(500);
    expect(answer.body).not.toMatch(LEAK);
  });
});

describe('a route whose object throws answers without the chain', () => {
  const identity: AuthIdentity = { userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

  function storeCredential(failure: Error): Promise<Response | null> {
    const stub = userAccount({
      async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
      async userMcp_warmConnections() { return { servers: 0 }; },
      async setCredential() { throw failure; },
    });

    const env: UserRoutesEnv<string> = {
      UserDO: { idFromName: (name) => name, get: () => stub },
      OrchestratorAgent: { idFromName: (name) => name, get: () => { throw new Error('unreached'); } },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    return serveFamily(userRoutes, { identity, ctx: workerContext() })(new Request('https://kinu.example.com/api/user/credentials/openai.bearer', {
      method: 'POST', body: JSON.stringify('sk-new'), headers: { 'content-type': 'application/json' },
    }), env);
  }

  test('an internal failure across RPC leaves no path or secret in the body', async () => {
    const response = present(await storeCredential(Object.assign(new Error(INTERNAL.message), { remote: true })), 'an answer');

    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(LEAK);
  });

  test('the object\'s own refusal still names what was wrong', async () => {
    const response = present(
      await storeCredential(Object.assign(new Error('KinuError[bad_input]: openai.bearer requires an OAuth refresh token.'), { remote: true })), 'an answer',
    );

    expect(response.status).toBe(400);
    expect(v.parse(ErrorBodySchema, await response.json())).toEqual({ error: 'openai.bearer requires an OAuth refresh token.', code: 'bad_input' });
  });
});
