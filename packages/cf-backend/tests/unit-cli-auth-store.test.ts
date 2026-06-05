import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  approveCliAuth,
  inspectCliAuth,
  pollCliAuth,
  startCliAuth,
} from '../src/cli/auth-store.js';

function makeD1(db: Database): D1Database {
  const session = {
    prepare(query: string) {
      return {
        bind(...bindings: unknown[]) {
          const stmt = db.prepare(query);
          return {
            async run() {
              stmt.run(...bindings);
              return { success: true };
            },
            async first<T>() {
              return (stmt.get(...bindings) ?? null) as T | null;
            },
          };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      return out;
    },
    getBookmark() {
      return null;
    },
  };
  return {
    withSession() {
      return session;
    },
  } as unknown as D1Database;
}

function setupEnv() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(import.meta.dir, '../migrations/auth/0001_auth_tables.sql'), 'utf8'));
  const minted: string[] = [];
  const userDO = {
    async ensureProfile() {},
    async mintCliToken(userId: string, label?: string) {
      const token = `ptc_${userId}_testtoken`;
      minted.push(`${label ?? ''}:${token}`);
      return { token, tokenHash: 'hash', expiresAt: Date.now() + 60_000 };
    },
  };
  return {
    db,
    minted,
    env: {
      AUTH_DB: makeD1(db),
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      },
    } as unknown as Env,
  };
}

describe('D1-backed CLI auth store', () => {
  test('approves and consumes a CLI auth request exactly once', async () => {
    const { env, minted } = setupEnv();
    const userId = '0123456789abcdef0123456789abcdef';

    const started = await startCliAuth(env, 'https://proteus.example.com', 'https://proteus.example.com', 'Ashish terminal', '127.0.0.1');
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.verificationUrl).toContain(`/cli/auth?code=${encodeURIComponent(started.userCode)}`);

    const pending = await inspectCliAuth(env.AUTH_DB, started.userCode);
    expect(pending).toMatchObject({ status: 'pending', deviceName: 'Ashish terminal' });

    await approveCliAuth(env, started.userCode, {
      userId,
      email: 'ashish@example.com',
      sub: 'sub',
      provider: 'test',
      authTime: Date.now(),
    }, '127.0.0.1');

    const approved = await pollCliAuth(env, started.deviceToken, '127.0.0.1');
    expect(approved.status).toBe('approved');
    expect(approved.token).toBe(`ptc_${userId}_testtoken`);
    expect(minted).toHaveLength(1);

    const second = await pollCliAuth(env, started.deviceToken, '127.0.0.1');
    expect(second.status).toBe('expired');
    expect(second.message).toContain('already delivered');
    expect(minted).toHaveLength(1);
  });
});
