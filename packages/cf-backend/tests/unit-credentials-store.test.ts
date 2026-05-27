import { describe, test, expect } from 'bun:test';
import { createSqlCredentialStore, initCredentialsTable } from '../src/credentials/store.ts';
import { validateCredential } from '../src/credentials/validate.ts';
import { Database } from 'bun:sqlite';

function setup() {
  const db = new Database(':memory:');
  // The store's `sql.exec(query, ...bindings)` signature comes from DO storage.
  // bun:sqlite's `db.exec` doesn't bind — wrap with prepare/run/all.
  const sqlExec = {
    exec: (query: string, ...bindings: unknown[]) => {
      const stmt = db.prepare(query);
      const rows = bindings.length > 0
        ? stmt.all(...(bindings as never[]))
        : stmt.all();
      return {
        toArray: () => Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [],
      };
    },
  };
  return createSqlCredentialStore(sqlExec);
}

describe('SqlCredentialStore', () => {
  test('round-trip bearer credential', async () => {
    const store = setup();
    await store.set('openai', { kind: 'bearer', token: 'sk-test' });
    const got = await store.get('openai');
    expect(got).toEqual({ kind: 'bearer', token: 'sk-test' });
  });

  test('overwrite via second set', async () => {
    const store = setup();
    await store.set('k', { kind: 'bearer', token: 'first' });
    await store.set('k', { kind: 'bearer', token: 'second' });
    expect(await store.get('k')).toEqual({ kind: 'bearer', token: 'second' });
  });

  test('delete removes key', async () => {
    const store = setup();
    await store.set('k', { kind: 'bearer', token: 't' });
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
  });

  test('get returns null for missing key', async () => {
    const store = setup();
    expect(await store.get('never-set')).toBeNull();
  });

  test('update receives current + writes mutated', async () => {
    const store = setup();
    await store.set('k', { kind: 'bearer', token: 'old' });
    const next = await store.update('k', (cur) => {
      expect(cur).toEqual({ kind: 'bearer', token: 'old' });
      return { kind: 'bearer', token: 'new' };
    });
    expect(next).toEqual({ kind: 'bearer', token: 'new' });
    expect(await store.get('k')).toEqual({ kind: 'bearer', token: 'new' });
  });

  test('update returning null deletes key', async () => {
    const store = setup();
    await store.set('k', { kind: 'bearer', token: 't' });
    await store.update('k', () => null);
    expect(await store.get('k')).toBeNull();
  });

  test('oauth credential round-trips with metadata', async () => {
    const store = setup();
    await store.set('codex.oauth', {
      kind: 'oauth',
      accessToken: 'AT', refreshToken: 'RT',
      expiresAt: 99999, metadata: { accountId: 'acct-x' },
    });
    const got = await store.get('codex.oauth');
    expect(got?.kind).toBe('oauth');
    if (got?.kind !== 'oauth') return;
    expect(got.accessToken).toBe('AT');
    expect(got.metadata?.accountId).toBe('acct-x');
  });
});

describe('validateCredential', () => {
  test('accepts well-formed bearer', () => {
    const v = validateCredential({ kind: 'bearer', token: 'sk-x' });
    expect(v).toEqual({ kind: 'bearer', token: 'sk-x' });
  });

  test('accepts well-formed oauth with optional fields', () => {
    const v = validateCredential({
      kind: 'oauth', accessToken: 'AT', refreshToken: 'RT', expiresAt: 12345,
      metadata: { foo: 'bar' },
    });
    expect(v.kind).toBe('oauth');
  });

  test('accepts well-formed openai-compat with extraHeaders', () => {
    const v = validateCredential({
      kind: 'openai-compat',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      extraHeaders: { 'X-Custom': 'v' },
    });
    expect(v.kind).toBe('openai-compat');
  });

  test('rejects unknown kind', () => {
    expect(() => validateCredential({ kind: 'something-else', token: 'x' }))
      .toThrow(/unknown credential kind/);
  });

  test('rejects bearer with missing token', () => {
    expect(() => validateCredential({ kind: 'bearer', token: '' })).toThrow(/token/);
    expect(() => validateCredential({ kind: 'bearer' })).toThrow(/token/);
  });

  test('rejects oauth with missing tokens', () => {
    expect(() => validateCredential({ kind: 'oauth', accessToken: '' })).toThrow();
    expect(() => validateCredential({ kind: 'oauth', accessToken: 'AT' })).toThrow(/refreshToken/);
  });

  test('rejects openai-compat with missing baseURL or apiKey', () => {
    expect(() => validateCredential({ kind: 'openai-compat', apiKey: 'k' })).toThrow(/baseURL/);
    expect(() => validateCredential({ kind: 'openai-compat', baseURL: 'http://x' })).toThrow(/apiKey/);
  });

  test('rejects non-object input', () => {
    expect(() => validateCredential('a string')).toThrow();
    expect(() => validateCredential(null)).toThrow();
  });
});
