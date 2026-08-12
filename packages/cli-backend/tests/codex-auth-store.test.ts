import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CODEX_CRED_KEY, createFileCodexAuthStore } from '../src/codex-auth-store.js';
import { asFetchFunction } from '@proteus/core';

describe('createFileCodexAuthStore', () => {
  test('refreshes Codex OAuth credentials atomically and preserves config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proteus-codex-auth-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify({
      origin: 'https://proteus.example',
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

    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      origin?: string;
      providers?: { openai?: { apiKey?: string }; codex?: { refreshToken?: string; metadata?: Record<string, unknown> } };
    };
    expect(saved.origin).toBe('https://proteus.example');
    expect(saved.providers?.openai?.apiKey).toBe('sk-openai');
    expect(saved.providers?.codex?.refreshToken).toBe('refresh-new');
    expect(saved.providers?.codex?.metadata?.accountId).toBe('acct_123');
  });

  test('exports the shared Codex credential key', () => {
    expect(CODEX_CRED_KEY).toBe('codex.oauth');
  });
});

function jwt(payload: Record<string, unknown>): string {
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
