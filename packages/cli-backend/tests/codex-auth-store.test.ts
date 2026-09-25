import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { present, scratchDir } from '@kinu.run/test-utils';
import { CODEX_CRED_KEY, createFileCodexAuthStore } from '../src/codex-auth-store';
import { asFetchFunction, JsonObjectSchema, type JsonObject } from '@kinu.run/core';
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

describe('createFileCodexAuthStore', () => {
  test('refreshes Codex OAuth credentials atomically and preserves config', async () => {
    const dir = scratchDir('codex-auth-store');
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

    const store = createFileCodexAuthStore(configPath, {
      fetch: asFetchFunction(async (input) => {
        calls.push(input instanceof Request ? input.url : input.toString());

        return Response.json({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'refresh-new',
          expires_in: 3600,
        });
      }),
    });

    expect(store.hasCredential()).toBe(true);
    const auth = await store.getAuth();

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
    const dir = scratchDir('codex-auth-store');
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

    const store = createFileCodexAuthStore(configPath, {
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
    const first = store.getAuth();
    await midFlight.promise;
    const second = store.getAuth();
    const [firstAuth, waiter] = await Promise.all([first, second]);

    expect(submitted).toEqual(['refresh-old']);
    expect(waiter?.headers.Authorization).toBe(firstAuth?.headers.Authorization);
    const saved = v.parse(savedConfigSchema, JSON.parse(readFileSync(configPath, 'utf-8')));
    expect(saved.providers?.codex?.refreshToken).toBe('refresh-1');
    expect(lstatSync(`${configPath}.lock`, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('exports the shared Codex credential key', () => {
    expect(CODEX_CRED_KEY).toBe('codex.oauth');
  });

  // An unparseable config must not read as `{}`, or `save()` deletes every other provider's key.
  test('an unparseable config is a failure, not an empty one', async () => {
    const dir = scratchDir('codex-auth-store');
    const configPath = join(dir, 'config.json');

    const intact = JSON.stringify({
      origin: 'https://kinu.example',
      providers: { openai: { apiKey: 'sk-openai' }, codex: { refreshToken: 'refresh-old' } },
    }, null, 2);

    writeFileSync(configPath, intact.slice(0, -12));

    const store = createFileCodexAuthStore(configPath);
    expect(() => store.hasCredential()).toThrow();
    await expect(store.save({ kind: 'oauth', accessToken: 'a', refreshToken: 'r' })).rejects.toThrow();
    expect(readFileSync(configPath, 'utf-8')).toBe(intact.slice(0, -12));
  });

  test('a config that has never been written reads as empty', async () => {
    const dir = scratchDir('codex-auth-store');
    const store = createFileCodexAuthStore(join(dir, 'nested', 'config.json'));
    expect(store.hasCredential()).toBe(false);
    await store.save({ kind: 'oauth', accessToken: 'a', refreshToken: 'r' });
    expect(store.hasCredential()).toBe(true);
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
