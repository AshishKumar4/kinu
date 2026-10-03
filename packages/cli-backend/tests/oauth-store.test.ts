import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { present, scratchDir } from '@kinu.run/test-utils';
import { withConfigLock } from '../src/config-lock';
import { createFileOAuthStore, signOutChatGptLogin } from '../src/oauth-store';
import { asFetchFunction, CHATGPT_CRED_KEY, CLAUDE_CRED_KEY, JsonObjectSchema } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import * as v from 'valibot';

const savedConfigSchema = v.object({
  origin: v.optional(v.string()),
  providers: v.optional(v.object({
    openai: v.optional(v.object({ apiKey: v.optional(v.string()) })),
    chatgpt: v.optional(v.object({
      accessToken: v.optional(v.string()),
      refreshToken: v.optional(v.string()),
      expiresAt: v.optional(v.number()),
      metadata: v.optional(JsonObjectSchema),
    })),
  })),
});

describe('createFileOAuthStore', () => {
  test('a ChatGPT plan login near its expiry rotates once with its issued client and keeps the rest of the config', async () => {
    const dir = scratchDir('oauth-store');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify({
      origin: 'https://kinu.example',
      providers: {
        openai: { apiKey: 'sk-openai' },
        chatgpt: { accessToken: 'at-old', refreshToken: 'refresh-old', expiresAt: Date.now() + 60_000, metadata: REGISTRATION },
      },
    }, null, 2)}\n`);

    const calls: [string, string][] = [];

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async (input, init) => {
        calls.push([input instanceof Request ? input.url : input.toString(), await new Request(input, init).text()]);

        return Response.json({ access_token: 'at-new', refresh_token: 'refresh-new', expires_in: 3600 });
      }),
    });

    expect(store.has(CHATGPT_CRED_KEY)).toBe(true);
    const auth = await store.getAuth(CHATGPT_CRED_KEY);

    // The saved issued client, never `dynamic_agent_client`, and no `scope`: the grant keeps what it had.
    expect(calls.map(([url, body]) => [url, Object.fromEntries(new URLSearchParams(body))])).toEqual([[
      'https://auth.openai.com/api/accounts/oauth/token',
      { grant_type: 'refresh_token', client_id: 'oaiapp_issued', refresh_token: 'refresh-old', resource: 'https://api.openai.com/v1' },
    ]]);
    expect(auth).toEqual({ headers: { Authorization: 'Bearer at-new' }, credentialKey: CHATGPT_CRED_KEY });

    const saved = v.parse(savedConfigSchema, JSON.parse(readFileSync(configPath, 'utf-8')));
    expect(saved.origin).toBe('https://kinu.example');
    expect(saved.providers?.openai?.apiKey).toBe('sk-openai');
    expect(saved.providers?.chatgpt?.refreshToken).toBe('refresh-new');
    expect(saved.providers?.chatgpt?.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
    expect(saved.providers?.chatgpt?.metadata).toMatchObject({ ...REGISTRATION, scopes: REGISTRATION.scopes });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test('a spent ChatGPT refresh token answers no login, and the failure names the code OpenAI sent', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const stale = { accessToken: 'at-old', refreshToken: 'refresh-old', expiresAt: Date.now() - 1, metadata: REGISTRATION };

    writeFileSync(configPath, `${JSON.stringify({ providers: { chatgpt: stale } })}\n`);

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async () => Response.json({ error: 'refresh_token_expired' }, { status: 400 })),
    });

    const logger = createRecordingLogger();
    const restore = setDiagnosticsSink(logger);

    try {
      expect(await store.getAuth(CHATGPT_CRED_KEY)).toBeNull();
    } finally { restore(); }

    expect(JSON.stringify(logger.emitted.filter((row) => row.event === 'credential.refresh_revoked'))).toContain('refresh_token_expired');
  });

  // SIWC-05: the spent token stayed on disk, read as connected, and was resubmitted by every later call.
  test.each(['refresh_token_expired', 'refresh_token_reused'])('a login %s is retired: tokens gone, registration kept, never resubmitted', async (code) => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const stale = { accessToken: 'at-old', refreshToken: 'refresh-old', expiresAt: Date.now() - 1, metadata: { ...REGISTRATION, idToken: 'id-old' } };

    writeFileSync(configPath, `${JSON.stringify({ origin: 'https://kinu.example', providers: { chatgpt: stale } })}\n`);
    let submitted = 0;

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async () => {
        submitted += 1;

        return Response.json({ error: code }, { status: 400 });
      }),
    });

    expect(await store.getAuth(CHATGPT_CRED_KEY)).toBeNull();

    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      origin: 'https://kinu.example',
      providers: { chatgpt: { metadata: { clientId: 'oaiapp_issued', subject: 'user-sub', email: 'owner@example.com' } } },
    });
    expect(store.has(CHATGPT_CRED_KEY)).toBe(false);
    expect(store.keys()).toEqual([]);
    expect(await store.getAuth(CHATGPT_CRED_KEY)).toBeNull();
    expect(submitted).toBe(1);
  });

  // SIWC-04: a refresh waiting on the lock renewed the login it read before it waited, reviving a disconnected one.
  test('a refresh queued behind a sign-out renews nothing and brings nothing back', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const stale = { accessToken: 'at-old', refreshToken: 'refresh-old', expiresAt: Date.now() - 1, metadata: REGISTRATION };

    writeFileSync(configPath, `${JSON.stringify({ providers: { chatgpt: stale } })}\n`);
    const submitted: string[] = [];

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async (input, init) => {
        submitted.push(await new Request(input, init).text());

        return Response.json({ access_token: 'at-new', refresh_token: 'refresh-new', expires_in: 3600 });
      }),
    });

    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const signingOut = withConfigLock(configPath, async () => {
      holding.resolve();
      await release.promise;
      writeFileSync(configPath, `${JSON.stringify({ providers: { chatgpt: { metadata: { clientId: 'oaiapp_issued' } } } })}\n`);
    });

    await holding.promise;
    const renewing = store.getAuth(CHATGPT_CRED_KEY);

    release.resolve();
    await signingOut;

    expect(await renewing).toBeNull();
    expect(submitted).toEqual([]);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ providers: { chatgpt: { metadata: { clientId: 'oaiapp_issued' } } } });
  });

  // SIWC-04: the disconnect revoked the token it read outside the lock while a rotation replaced it, leaving a live grant.
  test('a sign-out waits for the rotation in flight and revokes the token it left on disk', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const stale = { accessToken: 'at-old', refreshToken: 'refresh-old', expiresAt: Date.now() - 1, metadata: REGISTRATION };

    writeFileSync(configPath, `${JSON.stringify({ providers: { chatgpt: stale } })}\n`);
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const revoked: string[] = [];

    const fetch = asFetchFunction(async (input, init) => {
      const form = new URLSearchParams(await new Request(input, init).text());

      if (form.get('grant_type') !== 'refresh_token') {
        revoked.push(form.get('token') ?? '');

        return new Response(null, { status: 200 });
      }

      reached.resolve();
      await released.promise;

      return Response.json({ access_token: 'at-new', refresh_token: 'refresh-new', expires_in: 3600 });
    });

    const renewing = createFileOAuthStore(configPath, { fetch }).getAuth(CHATGPT_CRED_KEY);

    await reached.promise;
    const signingOut = signOutChatGptLogin(configPath, 'main', { fetch });

    released.resolve();
    expect(await renewing).toMatchObject({ headers: { Authorization: 'Bearer at-new' } });
    expect(await signingOut).toEqual({ removed: true, unconfirmed: null });
    expect(revoked).toEqual(['refresh-new']);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      providers: { chatgpt: { metadata: { clientId: 'oaiapp_issued', subject: 'user-sub', email: 'owner@example.com' } } },
    });
  });

  // SIWC-10: a named account's disconnect dropped its issued client ID, so its next sign-in registered anew.
  test('signing a named ChatGPT account out keeps its registration and leaves the others alone', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const main = { accessToken: 'at-main', refreshToken: 'refresh-main', expiresAt: Date.now() + 3_600_000, metadata: REGISTRATION };
    const work = { accessToken: 'at-work', refreshToken: 'refresh-work', expiresAt: Date.now() + 3_600_000, metadata: { ...REGISTRATION, clientId: 'oaiapp_work', idToken: 'id-work' } };

    writeFileSync(configPath, `${JSON.stringify({ providers: { chatgpt: { ...main, accounts: { work } } } })}\n`);
    const revoked: string[] = [];

    const fetch = asFetchFunction(async (input, init) => {
      revoked.push(new URLSearchParams(await new Request(input, init).text()).get('client_id') ?? '');

      return new Response(null, { status: 200 });
    });

    expect(await signOutChatGptLogin(configPath, 'work', { fetch })).toEqual({ removed: true, unconfirmed: null });
    expect(revoked).toEqual(['oaiapp_work']);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      providers: { chatgpt: { ...main, accounts: { work: { metadata: { clientId: 'oaiapp_work', subject: 'user-sub', email: 'owner@example.com' } } } } },
    });
    expect(createFileOAuthStore(configPath).keys()).toEqual(['chatgpt.oauth']);
  });

  // The refresh must run inside the lock: an async callback releases the synchronous helper's lock on its first await,
  // so two callers rotate the same refresh token.
  test('two concurrent refreshes perform one rotation', async () => {
    const dir = scratchDir('oauth-store');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify({
      providers: { chatgpt: { accessToken: 'at-old', refreshToken: 'refresh-old', expiresAt: Date.now() - 60_000, metadata: REGISTRATION } },
    }, null, 2)}\n`);

    const submitted: string[] = [];
    const midFlight = Promise.withResolvers<void>();

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async (_input, init) => {
        const form = new URLSearchParams(v.parse(v.string(), init?.body));

        submitted.push(present(form.get('refresh_token'), 'the refresh token the provider submitted'));
        midFlight.resolve();
        await Promise.resolve();

        return Response.json({ access_token: `at-${String(submitted.length)}`, refresh_token: `refresh-${String(submitted.length)}`, expires_in: 3600 });
      }),
    });

    // The second caller starts outside the first's callback: nesting it in the holder's async context would deadlock.
    const first = store.getAuth(CHATGPT_CRED_KEY);
    await midFlight.promise;
    const second = store.getAuth(CHATGPT_CRED_KEY);
    const [firstAuth, waiter] = await Promise.all([first, second]);

    expect(submitted).toEqual(['refresh-old']);
    expect(waiter?.headers.Authorization).toBe(firstAuth?.headers.Authorization);
    const saved = v.parse(savedConfigSchema, JSON.parse(readFileSync(configPath, 'utf-8')));
    expect(saved.providers?.chatgpt?.refreshToken).toBe('refresh-1');
    expect(lstatSync(`${configPath}.lock`, { throwIfNoEntry: false })).toBeUndefined();
  });

  // An unparseable config must not read as `{}`, or `save()` deletes every other provider's key.
  test('an unparseable config is a failure, not an empty one', async () => {
    const dir = scratchDir('oauth-store');
    const configPath = join(dir, 'config.json');

    const intact = JSON.stringify({
      origin: 'https://kinu.example',
      providers: { openai: { apiKey: 'sk-openai' }, chatgpt: { refreshToken: 'refresh-old' } },
    }, null, 2);

    writeFileSync(configPath, intact.slice(0, -12));

    const store = createFileOAuthStore(configPath);
    expect(() => store.has(CHATGPT_CRED_KEY)).toThrow();
    await expect(store.save(CHATGPT_CRED_KEY, { kind: 'oauth', accessToken: 'a', refreshToken: 'r' })).rejects.toThrow();
    expect(readFileSync(configPath, 'utf-8')).toBe(intact.slice(0, -12));
  });

  test('refreshing one ChatGPT account keeps the other sessions', async () => {
    const dir = scratchDir('oauth-store');
    const configPath = join(dir, 'config.json');

    writeFileSync(configPath, `${JSON.stringify({
      providers: {
        chatgpt: {
          accessToken: 'at-main',
          refreshToken: 'refresh-main',
          expiresAt: Date.now() + 3_600_000,
          metadata: REGISTRATION,
          accounts: { work: { accessToken: 'at-work', refreshToken: 'refresh-work', expiresAt: Date.now() - 60_000, metadata: { ...REGISTRATION, clientId: 'oaiapp_work' } } },
        },
      },
    }, null, 2)}\n`);

    const refreshedWith: string[] = [];

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async (input, init) => {
        refreshedWith.push(await new Request(input, init).text());

        return Response.json({ access_token: 'at-work-2', refresh_token: 'refresh-work-2', expires_in: 3600 });
      }),
    });

    expect(store.keys()).toEqual(['chatgpt.oauth', 'chatgpt.oauth@work']);
    await store.getAuth('chatgpt.oauth@work');
    expect(refreshedWith.map((body) => new URLSearchParams(body).get('client_id'))).toEqual(['oaiapp_work']);

    const saved = v.parse(v.object({ providers: v.object({ chatgpt: v.object({
      accessToken: v.string(), refreshToken: v.string(),
      accounts: v.record(v.string(), v.object({ refreshToken: v.string() })),
    }) }) }), JSON.parse(readFileSync(configPath, 'utf-8')));

    expect(saved.providers.chatgpt.accessToken).toBe('at-main');
    expect(saved.providers.chatgpt.refreshToken).toBe('refresh-main');
    expect(saved.providers.chatgpt.accounts.work?.refreshToken).toBe('refresh-work-2');
  });

  test('a config that has never been written reads as empty', async () => {
    const dir = scratchDir('oauth-store');
    const store = createFileOAuthStore(join(dir, 'nested', 'config.json'));
    expect(store.has(CHATGPT_CRED_KEY)).toBe(false);
    await store.save(CHATGPT_CRED_KEY, { kind: 'oauth', accessToken: 'a', refreshToken: 'r' });
    expect(store.has(CHATGPT_CRED_KEY)).toBe(true);
  });

  test('a Claude login near its expiry refreshes as Claude Code does, keeps its sign-in org and leaves ChatGPT alone', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const chatgpt = { accessToken: 'at-chatgpt', refreshToken: 'refresh-chatgpt', expiresAt: Date.now() + 3_600_000, metadata: REGISTRATION };

    writeFileSync(configPath, `${JSON.stringify({
      providers: {
        chatgpt,
        claude: {
          accounts: { work: {
            accessToken: 'sk-ant-oat01-old', refreshToken: 'rt-old', expiresAt: Date.now() + 60_000,
            metadata: { accountUuid: 'acct-1', orgUuid: 'org-1', orgName: 'Team' },
          } },
        },
      },
    }, null, 2)}\n`);

    const sent: [string, [string, string][], string][] = [];

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async (input, init) => {
        sent.push([input instanceof Request ? input.url : input.toString(), [...new Headers(init?.headers)], await new Request(input, init).text()]);

        return Response.json({ access_token: 'sk-ant-oat01-new', refresh_token: 'rt-new', expires_in: 28_800, organization: { uuid: 'org-2' } });
      }),
    });

    expect(store.keys()).toEqual(['chatgpt.oauth', 'claude.oauth@work']);
    const auth = await store.getAuth(`${CLAUDE_CRED_KEY}@work`);

    expect(auth).toEqual({ headers: { Authorization: 'Bearer sk-ant-oat01-new' }, credentialKey: 'claude.oauth@work' });
    expect(sent).toEqual([[
      'https://api.anthropic.com/v1/oauth/token',
      [['anthropic-beta', 'oauth-2025-04-20'], ['content-type', 'application/json'], ['user-agent', 'anthropic-sdk-typescript/0.112.1 userOAuthProvider']],
      JSON.stringify({ grant_type: 'refresh_token', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', refresh_token: 'rt-old' }),
    ]]);

    const saved = v.parse(v.object({ providers: v.object({
      chatgpt: v.object({ refreshToken: v.string() }),
      claude: v.object({ accounts: v.object({ work: v.object({ refreshToken: v.string(), metadata: JsonObjectSchema }) }) }),
    }) }), JSON.parse(readFileSync(configPath, 'utf-8')));

    expect(saved.providers.chatgpt.refreshToken).toBe('refresh-chatgpt');
    expect(saved.providers.claude.accounts.work).toEqual({ refreshToken: 'rt-new', metadata: { accountUuid: 'acct-1', orgUuid: 'org-1', orgName: 'Team' } });
  });

  // As a hosted account does: the revoked login is retired, so it reads as signed out and is never retried.
  test('a refused Claude refresh token retires the login, which then reads as signed out', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const stale = { accessToken: 'sk-ant-oat01-old', refreshToken: 'rt-old', expiresAt: Date.now() - 1 };

    writeFileSync(configPath, `${JSON.stringify({ providers: { claude: stale } })}\n`);

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async () => Response.json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, { status: 400 })),
    });

    expect(await store.getAuth(CLAUDE_CRED_KEY)).toBeNull();
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ providers: {} });
    expect(store.has(CLAUDE_CRED_KEY)).toBe(false);
    expect(store.keys()).toEqual([]);
  });

  test('an unreachable issuer leaves the held login for the call, as a hosted account does', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const near = { accessToken: 'sk-ant-oat01-held', refreshToken: 'rt-held', expiresAt: Date.now() + 1_000 };

    writeFileSync(configPath, `${JSON.stringify({ providers: { claude: near } })}\n`);
    const store = createFileOAuthStore(configPath, { fetch: asFetchFunction(async () => new Response('down', { status: 503 })) });

    expect((await store.getAuth(CLAUDE_CRED_KEY))?.headers).toMatchObject({ Authorization: 'Bearer sk-ant-oat01-held' });
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ providers: { claude: near } });
  });

  test('a login with no refresh token is no login: never advertised, never used', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');

    writeFileSync(configPath, `${JSON.stringify({ providers: { claude: { accessToken: 'sk-ant-oat01-bare' } } })}\n`);
    const store = createFileOAuthStore(configPath);

    expect(store.has(CLAUDE_CRED_KEY)).toBe(false);
    expect(store.keys()).toEqual([]);
    expect(await store.getAuth(CLAUDE_CRED_KEY)).toBeNull();
  });
});

/** A ChatGPT plan login's registration as the sign-in saves it. */
const REGISTRATION = {
  issuer: 'https://auth.openai.com',
  subject: 'user-sub',
  email: 'owner@example.com',
  clientId: 'oaiapp_issued',
  scopes: ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke'],
};
