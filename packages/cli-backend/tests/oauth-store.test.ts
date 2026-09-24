import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { present, requestBodyText, scratchDir } from '@kinu.run/test-utils';
import { createFileOAuthStore } from '../src/oauth-store';
import { asFetchFunction, CLAUDE_CRED_KEY, CODEX_CRED_KEY, JsonObjectSchema, OAuthTokenError, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';

const savedConfigSchema = v.object({
  origin: v.optional(v.string()),
  providers: v.optional(v.object({
    openai: v.optional(v.object({ apiKey: v.optional(v.string()) })),
    codex: v.optional(v.object({
      refreshToken: v.optional(v.string()),
      metadata: v.optional(JsonObjectSchema),
    })),
  })),
});

describe('createFileOAuthStore', () => {
  test('refreshes Codex OAuth credentials atomically and preserves config', async () => {
    const dir = scratchDir('oauth-store');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify({
      origin: 'https://kinu.example',
      providers: {
        openai: { apiKey: 'sk-openai' },
        codex: {
          accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
          refreshToken: 'refresh-old',
          metadata: { accountId: 'acct_123' },
        },
      },
    }, null, 2)}\n`);

    const calls: string[] = [];

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async (input) => {
        calls.push(input instanceof Request ? input.url : input.toString());

        return Response.json({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'refresh-new',
          expires_in: 3600,
        });
      }),
    });

    expect(store.has(CODEX_CRED_KEY)).toBe(true);
    const auth = await store.getAuth(CODEX_CRED_KEY);

    expect(calls).toHaveLength(1);
    expect(auth?.headers.Authorization).toStartWith('Bearer ');
    expect(auth?.headers.originator).toBe('codex_cli_rs');
    expect(auth?.headers['ChatGPT-Account-ID']).toBe('acct_123');

    const saved = v.parse(savedConfigSchema, JSON.parse(readFileSync(configPath, 'utf-8')));
    expect(saved.origin).toBe('https://kinu.example');
    expect(saved.providers?.openai?.apiKey).toBe('sk-openai');
    expect(saved.providers?.codex?.refreshToken).toBe('refresh-new');
    expect(saved.providers?.codex?.metadata?.accountId).toBe('acct_123');
  });

  // The refresh must run inside the lock: an async callback releases the synchronous helper's lock on its first await,
  // so two callers rotate the same refresh token.
  test('two concurrent refreshes perform one rotation', async () => {
    const dir = scratchDir('oauth-store');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify({
      providers: {
        codex: {
          accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
          refreshToken: 'refresh-old',
          metadata: { accountId: 'acct_123' },
        },
      },
    }, null, 2)}\n`);

    const submitted: string[] = [];
    const midFlight = Promise.withResolvers<void>();

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async (_input, init) => {
        const form = new URLSearchParams(v.parse(v.string(), init?.body));

        submitted.push(present(form.get('refresh_token'), 'the refresh token the provider submitted'));
        midFlight.resolve();
        await Promise.resolve();

        return Response.json({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: `refresh-${String(submitted.length)}`,
          expires_in: 3600,
        });
      }),
    });

    // The second caller starts outside the first's callback: nesting it in the holder's async context would deadlock.
    const first = store.getAuth(CODEX_CRED_KEY);
    await midFlight.promise;
    const second = store.getAuth(CODEX_CRED_KEY);
    const [firstAuth, waiter] = await Promise.all([first, second]);

    expect(submitted).toEqual(['refresh-old']);
    expect(waiter?.headers.Authorization).toBe(firstAuth?.headers.Authorization);
    const saved = v.parse(savedConfigSchema, JSON.parse(readFileSync(configPath, 'utf-8')));
    expect(saved.providers?.codex?.refreshToken).toBe('refresh-1');
    expect(lstatSync(`${configPath}.lock`, { throwIfNoEntry: false })).toBeUndefined();
  });

  // An unparseable config must not read as `{}`, or `save()` deletes every other provider's key.
  test('an unparseable config is a failure, not an empty one', () => {
    const dir = scratchDir('oauth-store');
    const configPath = join(dir, 'config.json');

    const intact = JSON.stringify({
      origin: 'https://kinu.example',
      providers: { openai: { apiKey: 'sk-openai' }, codex: { refreshToken: 'refresh-old' } },
    }, null, 2);

    writeFileSync(configPath, intact.slice(0, -12));

    const store = createFileOAuthStore(configPath);
    expect(() => store.has(CODEX_CRED_KEY)).toThrow();
    expect(() => store.save(CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'a', refreshToken: 'r' })).toThrow();
    expect(readFileSync(configPath, 'utf-8')).toBe(intact.slice(0, -12));
  });

  test('refreshing one Codex account keeps the other sessions', async () => {
    const dir = scratchDir('oauth-store');
    const configPath = join(dir, 'config.json');
    const mainToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

    writeFileSync(configPath, `${JSON.stringify({
      providers: {
        codex: {
          accessToken: mainToken,
          refreshToken: 'refresh-main',
          accounts: { work: { accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }), refreshToken: 'refresh-work' } },
        },
      },
    }, null, 2)}\n`);

    const refreshedWith: string[] = [];

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async (input, init) => {
        refreshedWith.push(await requestBodyText(input, init));

        return Response.json({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'refresh-work-2',
          expires_in: 3600,
        });
      }),
    });

    expect(store.keys()).toEqual(['codex.oauth', 'codex.oauth@work']);
    await store.getAuth('codex.oauth@work');
    expect(refreshedWith.join(' ')).toContain('refresh-work');

    const saved = v.parse(v.object({ providers: v.object({ codex: v.object({
      accessToken: v.string(), refreshToken: v.string(),
      accounts: v.record(v.string(), v.object({ refreshToken: v.string() })),
    }) }) }), JSON.parse(readFileSync(configPath, 'utf-8')));

    expect(saved.providers.codex.accessToken).toBe(mainToken);
    expect(saved.providers.codex.refreshToken).toBe('refresh-main');
    expect(saved.providers.codex.accounts.work?.refreshToken).toBe('refresh-work-2');
  });

  test('a config that has never been written reads as empty', () => {
    const dir = scratchDir('oauth-store');
    const store = createFileOAuthStore(join(dir, 'nested', 'config.json'));
    expect(store.has(CODEX_CRED_KEY)).toBe(false);
    store.save(CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'a', refreshToken: 'r' });
    expect(store.has(CODEX_CRED_KEY)).toBe(true);
  });

  test('a Claude login near its expiry refreshes as Claude Code does, keeps its sign-in org and leaves Codex alone', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const codex = { accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refreshToken: 'refresh-codex' };

    writeFileSync(configPath, `${JSON.stringify({
      providers: {
        codex,
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
        sent.push([input instanceof Request ? input.url : input.toString(), [...new Headers(init?.headers)], await requestBodyText(input, init)]);

        return Response.json({ access_token: 'sk-ant-oat01-new', refresh_token: 'rt-new', expires_in: 28_800, organization: { uuid: 'org-2' } });
      }),
    });

    expect(store.keys()).toEqual(['codex.oauth', 'claude.oauth@work']);
    const auth = await store.getAuth(`${CLAUDE_CRED_KEY}@work`);

    expect(auth).toEqual({ headers: { Authorization: 'Bearer sk-ant-oat01-new' }, credentialKey: 'claude.oauth@work' });
    expect(sent).toEqual([[
      'https://api.anthropic.com/v1/oauth/token',
      [['anthropic-beta', 'oauth-2025-04-20'], ['content-type', 'application/json'], ['user-agent', 'anthropic-sdk-typescript/0.112.1 userOAuthProvider']],
      JSON.stringify({ grant_type: 'refresh_token', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', refresh_token: 'rt-old' }),
    ]]);

    const saved = v.parse(v.object({ providers: v.object({
      codex: v.object({ refreshToken: v.string() }),
      claude: v.object({ accounts: v.object({ work: v.object({ refreshToken: v.string(), metadata: JsonObjectSchema }) }) }),
    }) }), JSON.parse(readFileSync(configPath, 'utf-8')));

    expect(saved.providers.codex.refreshToken).toBe('refresh-codex');
    expect(saved.providers.claude.accounts.work).toEqual({ refreshToken: 'rt-new', metadata: { accountUuid: 'acct-1', orgUuid: 'org-1', orgName: 'Team' } });
  });

  test('a refused Claude refresh token surfaces as revoked, and the stored login is left for a new sign-in', async () => {
    const configPath = join(scratchDir('oauth-store'), 'config.json');
    const stale = { accessToken: 'sk-ant-oat01-old', refreshToken: 'rt-old', expiresAt: Date.now() - 1 };

    writeFileSync(configPath, `${JSON.stringify({ providers: { claude: stale } })}\n`);

    const store = createFileOAuthStore(configPath, {
      fetch: asFetchFunction(async () => Response.json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, { status: 400 })),
    });

    const refused = store.getAuth(CLAUDE_CRED_KEY);

    await expect(refused).rejects.toBeInstanceOf(OAuthTokenError);
    await expect(refused).rejects.toHaveProperty('revoked', true);
    await expect(refused).rejects.toThrow('Claude\'s token endpoint refused the sign-in: Refresh token expired');
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ providers: { claude: stale } });
  });
});

function jwt(payload: JsonObject): string {
  return [
    b64url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    b64url(JSON.stringify(payload)),
    'sig',
  ].join('.');
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
