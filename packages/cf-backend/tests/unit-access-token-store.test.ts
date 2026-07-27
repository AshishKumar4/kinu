// CI access tokens (`pta_…`) — store-level behavior: hashed at rest, scoped,
// revocable, listed with last-used. Run against real SQLite through the same
// SqlExec seam the UserDO provides.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  ACCESS_TOKEN_SCOPES,
  getActiveAccessTokenScopes,
  initAccessTokenTable,
  listAccessTokens,
  mintAccessToken,
  normalizeAccessTokenScopes,
  parseAccessTokenUserId,
  revokeAccessToken,
  verifyAccessToken,
} from '../src/cli/access-token-store.js';

const USER_ID = '0123456789abcdef0123456789abcdef';

function sqlExec(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const trimmed = query.trim().toUpperCase();
      const reads = trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA');
      if (reads) return { toArray: () => statement.all(...(bindings as never[])) as Array<Record<string, unknown>> };
      statement.run(...(bindings as never[]));
      return { toArray: () => [] as Array<Record<string, unknown>> };
    },
  };
}

function setup() {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  initAccessTokenTable(sql);
  return { db, sql };
}

describe('access token format', () => {
  test('parses the embedded userId and rejects other token classes', async () => {
    const { sql } = setup();
    const minted = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.exec']);
    if (!minted.ok) throw new Error(minted.error);
    expect(parseAccessTokenUserId(minted.token)).toBe(USER_ID);
    expect(parseAccessTokenUserId(`ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`)).toBeNull();
    expect(parseAccessTokenUserId('pta_short_x')).toBeNull();
  });
});

describe('mint', () => {
  test('stores only the hash — the raw token never lands in SQLite', async () => {
    const { db, sql } = setup();
    const minted = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.exec', 'workspace.read']);
    if (!minted.ok) throw new Error(minted.error);
    const rows = db.prepare('SELECT * FROM user_access_tokens').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(minted.token);
    expect(rows[0]!.token_hash).toBe(minted.record.tokenHash);
  });

  test('rejects unknown or empty scopes', async () => {
    const { sql } = setup();
    const unknown = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.exec', 'admin.godmode']);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('admin.godmode');
    const empty = await mintAccessToken(sql, USER_ID, 'ci', []);
    expect(empty.ok).toBe(false);
    expect(listAccessTokens(sql)).toHaveLength(0);
  });

  test('rejects bad names and duplicate active names; revoked names are reusable', async () => {
    const { sql } = setup();
    expect((await mintAccessToken(sql, USER_ID, 'no spaces', ['workspace.read'])).ok).toBe(false);
    expect((await mintAccessToken(sql, USER_ID, '', ['workspace.read'])).ok).toBe(false);

    expect((await mintAccessToken(sql, USER_ID, 'ci', ['workspace.read'])).ok).toBe(true);
    const duplicate = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.read']);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toContain('already exists');

    expect(revokeAccessToken(sql, 'ci').revoked).toBe(true);
    expect((await mintAccessToken(sql, USER_ID, 'ci', ['workspace.read'])).ok).toBe(true);
  });

  test('rejects a malformed user id', async () => {
    const { sql } = setup();
    expect((await mintAccessToken(sql, 'not-a-user', 'ci', ['workspace.read'])).ok).toBe(false);
  });
});

describe('verify', () => {
  test('round-trips a minted token with its scopes and records last use', async () => {
    const { db, sql } = setup();
    const minted = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.read', 'workspace.exec']);
    if (!minted.ok) throw new Error(minted.error);

    const verified = await verifyAccessToken(sql, minted.token);
    expect(verified).toMatchObject({
      ok: true,
      userId: USER_ID,
      tokenHash: minted.record.tokenHash,
      scopes: ['workspace.read', 'workspace.exec'],
    });
    const row = db.prepare('SELECT last_used_at FROM user_access_tokens').get() as { last_used_at: number | null };
    expect(row.last_used_at).toBeNumber();
  });

  test('rejects unknown, tampered, and revoked tokens', async () => {
    const { sql } = setup();
    const minted = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.exec']);
    if (!minted.ok) throw new Error(minted.error);

    expect((await verifyAccessToken(sql, 'garbage')).ok).toBe(false);
    expect((await verifyAccessToken(sql, `${minted.token.slice(0, -1)}X`)).ok).toBe(false);

    expect(revokeAccessToken(sql, minted.record.tokenHash).revoked).toBe(true);
    const afterRevoke = await verifyAccessToken(sql, minted.token);
    expect(afterRevoke.ok).toBe(false);
    expect(getActiveAccessTokenScopes(sql, minted.record.tokenHash)).toBeNull();
  });

  test('resolves live scopes by bearer hash for connect-ticket pinning', async () => {
    const { sql } = setup();
    const minted = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.read', 'workspace.exec']);
    if (!minted.ok) throw new Error(minted.error);
    expect(getActiveAccessTokenScopes(sql, minted.record.tokenHash)).toEqual(['workspace.read', 'workspace.exec']);
    expect(getActiveAccessTokenScopes(sql, 'f'.repeat(64))).toBeNull();
  });
});

describe('list and revoke', () => {
  test('lists active tokens newest-first with scopes and last-used; hides revoked', async () => {
    const { db, sql } = setup();
    const first = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.exec']);
    if (!first.ok) throw new Error(first.error);
    db.prepare('UPDATE user_access_tokens SET created_at = created_at - 1000').run();
    const second = await mintAccessToken(sql, USER_ID, 'deploy', ['workspace.read']);
    if (!second.ok) throw new Error(second.error);

    expect(listAccessTokens(sql).map((t) => t.name)).toEqual(['deploy', 'ci']);
    expect(revokeAccessToken(sql, 'deploy').revoked).toBe(true);
    expect(listAccessTokens(sql).map((t) => t.name)).toEqual(['ci']);
  });

  test('revoking an unknown or already-revoked ref reports revoked: false', async () => {
    const { sql } = setup();
    expect(revokeAccessToken(sql, 'missing').revoked).toBe(false);
    const minted = await mintAccessToken(sql, USER_ID, 'ci', ['workspace.exec']);
    if (!minted.ok) throw new Error(minted.error);
    expect(revokeAccessToken(sql, 'ci').revoked).toBe(true);
    expect(revokeAccessToken(sql, 'ci').revoked).toBe(false);
  });
});

describe('scope normalization', () => {
  test('dedupes, trims, and keeps a stable vocabulary order', () => {
    const result = normalizeAccessTokenScopes([' workspace.exec ', 'workspace.read', 'workspace.exec']);
    expect(result).toEqual({ ok: true, scopes: ['workspace.read', 'workspace.exec'] });
  });

  test('the vocabulary carries ai.proxy for the signed-in AI proxy', () => {
    expect(ACCESS_TOKEN_SCOPES).toEqual(['workspace.read', 'workspace.exec', 'ai.proxy']);
    expect(normalizeAccessTokenScopes(['ai.proxy'])).toEqual({ ok: true, scopes: ['ai.proxy'] });
  });
});
