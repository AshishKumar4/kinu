// Subscription logins (Codex, Claude, any account) stored on a hosted account renew through their issuer when due,
// and a revoked one is dropped: left in the store it keeps the provider advertised while every call 401s.
import { describe, test, expect } from 'bun:test';
import { createTestUserDO, testOwner } from './helpers/user-do';
import { asFetchFunction } from '@kinu.run/core';
import { requestUrl } from '@kinu.run/core';
import { requestBodyText } from '@kinu.run/test-utils';
import * as v from 'valibot';

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

const CLAUDE_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';

const ClaudeRefreshSchema = v.looseObject({ grant_type: v.literal('refresh_token'), refresh_token: v.string() });

describe('UserDO Codex credential revocation', () => {
  test('a revoked refresh token drops the credential and refuses the call', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async (input, init) => {
      expect(requestUrl(input)).toBe(CODEX_TOKEN_URL);
      const body = new URLSearchParams(await requestBodyText(input, init));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('rt-revoked');

      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'The provided authorization grant is invalid',
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    });

    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'codex.oauth', {
        kind: 'oauth', accessToken: 'dead-access', refreshToken: 'rt-revoked',
      });
      expect(await harness.userDO.listCredentials(owner)).toHaveLength(1);

      await expect(harness.userDO.getAuthHeaders(owner, 'codex.oauth', { forceRefresh: true }))
        .resolves.toBeNull();
      expect(await harness.userDO.listCredentials(owner)).toHaveLength(0);
      harness.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a transient refresh failure keeps the credential in place', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('upstream exploded', { status: 503 }));

    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'codex.oauth', {
        kind: 'oauth', accessToken: 'maybe-stale', refreshToken: 'rt-alive',
      });

      const headers = await harness.userDO.getAuthHeaders(owner, 'codex.oauth', { forceRefresh: true });
      expect(headers?.Authorization).toBe('Bearer maybe-stale');
      expect(await harness.userDO.listCredentials(owner)).toHaveLength(1);
      harness.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('UserDO Codex credential of a named account', () => {
  const refreshedTo = (tokens: { access: string; refresh: string }) => asFetchFunction(async (input, init) => {
    expect(requestUrl(input)).toBe(CODEX_TOKEN_URL);
    const body = new URLSearchParams(await requestBodyText(input, init));
    expect(body.get('refresh_token')).toBe('rt-work');

    return Response.json({ access_token: tokens.access, refresh_token: tokens.refresh, expires_in: 3600 });
  });

  test('an account\'s login refreshes with its own refresh token and keeps the rotated one, and main is left alone', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = refreshedTo({ access: 'fresh-work', refresh: 'rt-work-2' });

    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'codex.oauth', { kind: 'oauth', accessToken: 'main-access', refreshToken: 'rt-main' });
      await harness.userDO.setCredential(owner, 'codex.oauth@work', { kind: 'oauth', accessToken: 'stale-work', refreshToken: 'rt-work' });

      const headers = await harness.userDO.getAuthHeaders(owner, 'codex.oauth@work', { forceRefresh: true });
      expect(headers?.Authorization).toBe('Bearer fresh-work');

      // The next read finds the rotated login stored under the account; a second refresh would reuse a spent token.
      globalThis.fetch = asFetchFunction(async () => { throw new Error('no second refresh'); });
      expect((await harness.userDO.getAuthHeaders(owner, 'codex.oauth@work'))?.Authorization).toBe('Bearer fresh-work');
      expect((await harness.userDO.getAuthHeaders(owner, 'codex.oauth'))?.Authorization).toBe('Bearer main-access');
      harness.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a revoked refresh drops only that account\'s login', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));

    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'codex.oauth', { kind: 'oauth', accessToken: 'main-access', refreshToken: 'rt-main' });
      await harness.userDO.setCredential(owner, 'codex.oauth@work', { kind: 'oauth', accessToken: 'dead-work', refreshToken: 'rt-work' });

      await expect(harness.userDO.getAuthHeaders(owner, 'codex.oauth@work', { forceRefresh: true })).resolves.toBeNull();
      expect((await harness.userDO.listCredentials(owner)).map((credential) => credential.key)).toEqual(['codex.oauth']);
      harness.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a subscription login without a refresh token is refused, whatever its issuer or account', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();

    for (const key of ['codex.oauth@work', 'claude.oauth', 'claude.oauth@work']) {
      await expect(harness.userDO.setCredential(owner, key, { kind: 'oauth', accessToken: 'no-refresh' }))
        .rejects.toThrow(`${key} requires an OAuth refresh token`);
    }

    expect(await harness.userDO.listCredentials(owner)).toEqual([]);
    harness.close();
  });
});

describe('UserDO Claude subscription login', () => {
  test('a login past its expiry renews at its next use and keeps the rotated one; another account is left alone', async () => {
    const originalFetch = globalThis.fetch;
    const asked: string[] = [];

    globalThis.fetch = asFetchFunction(async (input, init) => {
      expect(requestUrl(input)).toBe(CLAUDE_TOKEN_URL);
      asked.push(v.parse(ClaudeRefreshSchema, JSON.parse(await requestBodyText(input, init))).refresh_token);

      return Response.json({ access_token: 'fresh-work', refresh_token: 'rt-work-2', expires_in: 3600 });
    });

    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'claude.oauth', { kind: 'oauth', accessToken: 'main-access', refreshToken: 'rt-main', expiresAt: Date.now() + 3_600_000 });
      await harness.userDO.setCredential(owner, 'claude.oauth@work', { kind: 'oauth', accessToken: 'stale-work', refreshToken: 'rt-work', expiresAt: Date.now() - 1_000 });

      expect((await harness.userDO.getAuthHeaders(owner, 'claude.oauth@work'))?.Authorization).toBe('Bearer fresh-work');
      // Stored under the account with its new expiry, so the next use sends nothing to Anthropic.
      expect((await harness.userDO.getAuthHeaders(owner, 'claude.oauth@work'))?.Authorization).toBe('Bearer fresh-work');
      expect((await harness.userDO.getAuthHeaders(owner, 'claude.oauth'))?.Authorization).toBe('Bearer main-access');
      expect(asked).toEqual(['rt-work']);
      harness.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a refresh Anthropic rejects drops that login, so Claude asks to be connected again', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => Response.json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, { status: 400 }));

    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'claude.oauth', { kind: 'oauth', accessToken: 'dead-access', refreshToken: 'rt-dead', expiresAt: Date.now() - 1_000 });

      await expect(harness.userDO.getAuthHeaders(owner, 'claude.oauth')).resolves.toBeNull();
      expect(await harness.userDO.listCredentials(owner)).toEqual([]);
      harness.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('UserDO subscription login renewed by two calls at once', () => {
  /** Anthropic rotates a refresh token on use: of two requests spending one, the first renews and a later one is
   *  rejected. The held requests are answered in the order a race could land them. */
  const raceRenewal = async (order: 'rejection lands first' | 'renewal lands first') => {
    const originalFetch = globalThis.fetch;
    const held: { token: string; answer: (response: Response) => void }[] = [];
    let answerNow: (() => Response) | null = null;
    let arrived: () => void = () => {};

    const firstArrival = new Promise<void>((resolve) => { arrived = resolve; });

    globalThis.fetch = asFetchFunction(async (input, init) => {
      expect(requestUrl(input)).toBe(CLAUDE_TOKEN_URL);
      const token = v.parse(ClaudeRefreshSchema, JSON.parse(await requestBodyText(input, init))).refresh_token;

      if (answerNow !== null) return answerNow();

      return new Promise<Response>((answer) => {
        held.push({ token, answer });
        arrived();
      });
    });

    // Every step a call can take without an answer from Anthropic runs before the test answers.
    const idle = async () => {
      for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => { setImmediate(resolve); });
    };

    const renewed = () => Response.json({ access_token: 'fresh', refresh_token: 'rt-2', expires_in: 3600 });
    const reused = () => Response.json({ error: 'invalid_grant', error_description: 'refresh token already used' }, { status: 400 });

    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'claude.oauth', { kind: 'oauth', accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() - 1_000 });

      const calls = [harness.userDO.getAuthHeaders(owner, 'claude.oauth'), harness.userDO.getAuthHeaders(owner, 'claude.oauth')];
      await firstArrival;
      await idle();
      const [first, ...later] = held.map((request, index) => ({ request, response: index === 0 ? renewed : reused }));
      const landing = order === 'rejection lands first' ? [...later, first] : [first, ...later];

      for (const answered of landing) {
        answered?.request.answer(answered.response());
        await idle();
      }

      // A request sent after the race spends a token Anthropic already rotated.
      answerNow = reused;
      const headers = (await Promise.all(calls)).map((sent) => sent?.Authorization ?? null);
      answerNow = () => Response.json({ access_token: 'renewed-again', refresh_token: 'rt-3', expires_in: 3600 });
      const next = (await harness.userDO.getAuthHeaders(owner, 'claude.oauth'))?.Authorization ?? null;
      harness.close();

      return { headers, spent: held.map((request) => request.token), next };
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  for (const order of ['rejection lands first', 'renewal lands first'] as const) {
    test(`both calls get the one renewal, and the renewed login stays stored, when the ${order.replace(' lands first', '')} lands first`, async () => {
      expect(await raceRenewal(order)).toEqual({ headers: ['Bearer fresh', 'Bearer fresh'], spent: ['rt-1'], next: 'Bearer fresh' });
    });
  }
});
