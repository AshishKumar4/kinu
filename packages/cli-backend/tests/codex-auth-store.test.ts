import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { CODEX_CRED_KEY, createFileCodexAuthStore } from '../src/codex-auth-store';
import { asFetchFunction, JsonObjectSchema, type AuthResolution, type JsonObject } from '@kinu.run/core';
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
        calls.push(String(input));
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

  // The refresh used to run OUTSIDE the lock: an async callback handed to the
  // synchronous helper released the lock the moment it returned its pending
  // Promise, so two callers submitted the same refresh token and raced their
  // replacements into the file. One of the two rotations then held a token the
  // provider had already invalidated.
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
    let second: Promise<AuthResolution | null> | undefined;
    const store = createFileCodexAuthStore(configPath, {
      fetch: asFetchFunction(async (_input, init) => {
        // Yield before answering, so the refresh is genuinely mid-flight — the
        // state in which the lock used to be gone already. The second caller
        // starts HERE rather than at a guessed moment, so its first acquisition
        // attempt lands inside this refresh: it is refused while the lock covers
        // the callback, and it succeeds the moment the lock does not.
        await Promise.resolve();
        submitted.push(String(new URLSearchParams(String(init?.body)).get('refresh_token')));
        second ??= store.getAuth();
        return Response.json({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: `refresh-${String(submitted.length)}`,
          expires_in: 3600,
        });
      }),
    });

    const first = await store.getAuth();
    if (second === undefined) throw new Error('the refresh never reached the provider');
    const waiter = await second;

    // The provider saw the stored refresh token once, both callers carry what
    // that one rotation produced, and the file agrees with both of them.
    expect(submitted).toEqual(['refresh-old']);
    expect(waiter?.headers.Authorization).toBe(first?.headers.Authorization);
    const saved = v.parse(savedConfigSchema, JSON.parse(readFileSync(configPath, 'utf-8')));
    expect(saved.providers?.codex?.refreshToken).toBe('refresh-1');
    expect(lstatSync(`${configPath}.lock`, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('exports the shared Codex credential key', () => {
    expect(CODEX_CRED_KEY).toBe('codex.oauth');
  });

  // A config that exists but does not parse used to read as `{}`, which made
  // `hasCredential()` say "no token stored" and made `save()` write a file
  // holding ONLY the codex credential — silently deleting every other
  // provider's key it was supposed to preserve.
  test('an unparseable config is a failure, not an empty one', () => {
    const dir = scratchDir('codex-auth-store');
    const configPath = join(dir, 'config.json');
    const intact = JSON.stringify({
      origin: 'https://kinu.example',
      providers: { openai: { apiKey: 'sk-openai' }, codex: { refreshToken: 'refresh-old' } },
    }, null, 2);
    writeFileSync(configPath, intact.slice(0, -12));

    const store = createFileCodexAuthStore(configPath);
    expect(() => store.hasCredential()).toThrow();
    expect(() => store.save({ kind: 'oauth', accessToken: 'a', refreshToken: 'r' })).toThrow();
    expect(readFileSync(configPath, 'utf-8')).toBe(intact.slice(0, -12));
  });

  test('a config that has never been written reads as empty', () => {
    const dir = scratchDir('codex-auth-store');
    const store = createFileCodexAuthStore(join(dir, 'nested', 'config.json'));
    expect(store.hasCredential()).toBe(false);
    store.save({ kind: 'oauth', accessToken: 'a', refreshToken: 'r' });
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
