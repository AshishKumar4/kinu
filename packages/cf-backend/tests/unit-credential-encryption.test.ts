// Credential store encryption at rest: sealed envelopes bound to their credential, legacy plaintext re-sealed on
// access, rotation keeps the retired key readable, and no key is a refusal, never a plaintext fallback.
import { testOwner } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, sqlExec,
} from './helpers/user-do';
import { createCredentialCipher } from '@kinu.run/core';
import { ownerCaller } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { present } from '@kinu.run/test-utils';
import { handleUserProviderProxyRequest } from '../src/user/provider-proxy';

const rotatedOwner = () => ownerCaller({ CREDENTIAL_ENCRYPTION_KEY: NEXT_KEY });

const NEXT_KEY = 'a-different-credential-encryption-key-9876';

function storedValue(harness: ReturnType<typeof createTestUserDO>, key: string): string | undefined {
  const rows = sqlExec(harness.db).exec('SELECT value FROM user_credentials WHERE key = ?', key).toArray();
  const parsed = v.safeParse(v.string(), rows[0]?.value);

  return parsed.success ? parsed.output : undefined;
}

const ProxyListingSchema = v.object({
  credentials: v.array(v.object({ key: v.string(), baseURL: v.optional(v.string()), failure: v.optional(v.string()) })),
});

describe('the credential store is sealed at rest', () => {
  test('the secret never lands in SQLite, and still round-trips', async () => {
    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'openrouter.bearer', { kind: 'bearer', token: 'sk-or-secret' });

    const stored = storedValue(harness, 'openrouter.bearer');
    expect(stored).toBeDefined();
    expect(stored).not.toContain('sk-or-secret');

    expect(await harness.userDO.getAuthHeaders(await testOwner(), 'openrouter.bearer'))
      .toEqual({ Authorization: 'Bearer sk-or-secret' });
    harness.close();
  });

  test('the summary listing is unchanged — kind and timestamps, never a value', async () => {
    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'anthropic.bearer', { kind: 'bearer', token: 'sk-ant-secret' });
    const summaries = await harness.userDO.listCredentials(await testOwner());
    expect(summaries).toMatchObject([{ key: 'anthropic.bearer', kind: 'bearer' }]);
    expect(JSON.stringify(summaries)).not.toContain('sk-ant-secret');
    harness.close();
  });

  test('an openai-compat credential keeps answering with its baseURL', async () => {
    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'openai-compat.groq', {
      kind: 'openai-compat', baseURL: 'https://api.groq.com/openai/v1', apiKey: 'gsk-secret',
    });
    expect(await harness.userDO.getCredentialBaseURL(await testOwner(), 'openai-compat.groq'))
      .toBe('https://api.groq.com/openai/v1');
    expect(storedValue(harness, 'openai-compat.groq')).not.toContain('gsk-secret');
    harness.close();
  });

  test('a sealed value replayed under another credential key does not open', async () => {
    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-openai' });
    const sealed = present(storedValue(harness, 'openai.bearer'), 'the sealed openai.bearer row');
    sqlExec(harness.db).exec(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      'openrouter.bearer', 'bearer', sealed, Date.now(), Date.now(),
    );
    await expect(harness.userDO.getAuthHeaders(await testOwner(), 'openrouter.bearer'))
      .rejects.toThrow('opening the stored credential openrouter.bearer');
    harness.close();
  });

  test('a row that opens and does not decode rejects without quoting what it holds', async () => {
    const harness = createTestUserDO();
    await harness.userDO.listCredentials(await testOwner());
    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

    for (const [key, plaintext] of [
      ['openai.bearer', JSON.stringify('sk-bare-secret')],
      ['anthropic.bearer', 'sk-not-json-secret'],
    ]) {
      sqlExec(harness.db).exec(
        `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        key, 'bearer', await cipher.seal(`test-user-do:${key}`, plaintext), 0, 0,
      );
    }

    const owner = await testOwner();

    const [bare, garbled] = (await Promise.allSettled([
      harness.userDO.getAuthHeaders(owner, 'openai.bearer'),
      harness.userDO.getAuthHeaders(owner, 'anthropic.bearer'),
    ])).map((read) => read.status === 'rejected' ? renderThrownChain({ cause: read.reason }) : 'resolved');

    expect(bare).toContain('not a credential');
    expect(bare).not.toContain('sk-bare-secret');
    expect(garbled).toContain('did not decode as JSON');
    expect(garbled).not.toContain('sk-not-json-secret');
    harness.close();
  });

  test('the proxy listing shows the one unreadable credential as failed and lists the rest', async () => {
    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'anthropic.bearer', { kind: 'bearer', token: 'sk-ok' });
    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: 'a-retired-credential-encryption-key-5555' });
    sqlExec(harness.db).exec(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      'openai.bearer', 'bearer', await cipher.seal('test-user-do:openai.bearer', JSON.stringify({ kind: 'bearer', token: 'sk-lost' })), 0, 0,
    );

    const response = await handleUserProviderProxyRequest(
      new Request('https://kinu.example/api/user/ai/proxy/credentials'),
      { CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY },
      { userDO: harness.userDO },
    );

    const listed = v.parse(ProxyListingSchema, await response.json());

    expect(listed).toEqual({ credentials: [
      { key: 'anthropic.bearer' },
      { key: 'openai.bearer', failure: expect.stringContaining('opening the stored credential openai.bearer') },
    ] });
    harness.close();
  });
});

describe('migration and rotation', () => {
  test('a plaintext row written before encryption keeps working and stops being plaintext', async () => {
    const harness = createTestUserDO();
    sqlExec(harness.db).exec(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    sqlExec(harness.db).exec(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      'openai.bearer', 'bearer', JSON.stringify({ kind: 'bearer', token: 'sk-legacy' }), 0, 0,
    );

    expect(await harness.userDO.getAuthHeaders(await testOwner(), 'openai.bearer'))
      .toEqual({ Authorization: 'Bearer sk-legacy' });
    const stored = storedValue(harness, 'openai.bearer');
    expect(stored).not.toContain('sk-legacy');
    harness.close();
  });

  test('a value that is not a sealed envelope does not open, and says why', async () => {
    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    const plaintext = JSON.stringify({ kind: 'bearer', token: 'sk-planted' });

    await expect(cipher.open('test-user-do:openai.bearer', plaintext))
      .rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('not a sealed envelope') });
  });

  test('a plaintext row in a store already sealed is refused, and no rotation launders it', async () => {
    const plaintext = JSON.stringify({ kind: 'bearer', token: 'sk-planted' });
    const plainHeaders = JSON.stringify({ Authorization: 'Bearer mcp-planted' });
    const first = createTestUserDO();
    await first.userDO.setCredential(await testOwner(), 'anthropic.bearer', { kind: 'bearer', token: 'sk-ok' });
    await first.userDO.userMcp_list(await testOwner());
    sqlExec(first.db).exec(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      'openai.bearer', 'bearer', plaintext, 0, 0,
    );
    sqlExec(first.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      'planted', 'planted', 'https://mcp.example/sse', 'auto', plainHeaders, 0, 0,
    );

    await expect(first.userDO.getAuthHeaders(await testOwner(), 'openai.bearer'))
      .rejects.toThrow('opening the stored credential openai.bearer');

    // The rotation re-seals every row that opens; one that never was sealed stays exactly as planted.
    const rotated = createTestUserDO({
      storage: first.db, credentialEncryptionKey: NEXT_KEY, credentialEncryptionKeyPrevious: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    expect(await rotated.userDO.getAuthHeaders(await rotatedOwner(), 'anthropic.bearer')).toMatchObject({ 'x-api-key': 'sk-ok' });
    await expect(rotated.userDO.getAuthHeaders(await rotatedOwner(), 'openai.bearer'))
      .rejects.toThrow('opening the stored credential openai.bearer');
    expect(storedValue(rotated, 'openai.bearer')).toBe(plaintext);
    expect(sqlExec(rotated.db).exec('SELECT headers FROM user_mcp_servers WHERE id = ?', 'planted').toArray())
      .toEqual([{ headers: plainHeaders }]);
    rotated.close();
  });

  test('a rotation re-seals the store and the retired key stays readable', async () => {
    const first = createTestUserDO();
    await first.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-rotate' });
    const sealedUnderOldKey = present(storedValue(first, 'openai.bearer'), 'the sealed openai.bearer row');
    first.close();

    const rotated = createTestUserDO({
      credentialEncryptionKey: NEXT_KEY,
      credentialEncryptionKeyPrevious: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    sqlExec(rotated.db).exec(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    sqlExec(rotated.db).exec(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      'openai.bearer', 'bearer', sealedUnderOldKey, 0, 0,
    );

    expect(await rotated.userDO.getAuthHeaders(await rotatedOwner(), 'openai.bearer'))
      .toEqual({ Authorization: 'Bearer sk-rotate' });
    const resealed = present(storedValue(rotated, 'openai.bearer'), 'the re-sealed openai.bearer row');
    expect(resealed).not.toBe(sealedUnderOldKey);
    const nextKeyId = (await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: NEXT_KEY })).keyId;
    expect(resealed.startsWith(`pce1.${nextKeyId}.`)).toBe(true);
    rotated.close();
  });

  test('a row sealed under a key this deployment no longer has fails only that credential', async () => {
    const orphaned = createTestUserDO({ credentialEncryptionKey: NEXT_KEY });
    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    sqlExec(orphaned.db).exec(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    sqlExec(orphaned.db).exec(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      'openai.bearer', 'bearer',
      await cipher.seal('test-user-do:openai.bearer', JSON.stringify({ kind: 'bearer', token: 'sk-lost' })), 0, 0,
    );
    await orphaned.userDO.setCredential(await rotatedOwner(), 'anthropic.bearer', { kind: 'bearer', token: 'sk-ok' });

    await expect(orphaned.userDO.getAuthHeaders(await rotatedOwner(), 'openai.bearer'))
      .rejects.toThrow('opening the stored credential openai.bearer');
    expect(await orphaned.userDO.getAuthHeaders(await rotatedOwner(), 'anthropic.bearer'))
      .toMatchObject({ 'x-api-key': 'sk-ok' });
    orphaned.close();
  });
});

describe('the key is not optional', () => {
  test('no key configured refuses the call instead of storing plaintext', async () => {
    // The missing secret also denies the owner capability, so the refusal lands at the gate.
    const harness = createTestUserDO({ credentialEncryptionKey: '' });
    await expect(harness.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-x' }))
      .rejects.toThrow('CREDENTIAL_ENCRYPTION_KEY');
    harness.close();
  });

  test('a key too short to be a key is refused, not silently accepted', async () => {
    await expect(createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: 'hunter2' }))
      .rejects.toThrow('too short');
  });
});

describe('MCP server headers are sealed too', () => {
  /** Written like userMcp_add, which would roll back here: this harness has no MCP SDK. */
  async function seedServer(harness: ReturnType<typeof createTestUserDO>, id: string): Promise<void> {
    await harness.userDO.userMcp_list(await testOwner());
    sqlExec(harness.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
      id, id, 'https://mcp.example/sse', 'auto', 0, 0,
    );
  }

  function storedHeaders(harness: ReturnType<typeof createTestUserDO>, id: string): string | null {
    const row = sqlExec(harness.db).exec('SELECT headers FROM user_mcp_servers WHERE id = ?', id).toArray()[0];
    const parsed = v.safeParse(v.string(), row?.headers);

    return parsed.success ? parsed.output : null;
  }

  test('a bearer for a private MCP server never lands in SQLite in the clear', async () => {
    const harness = createTestUserDO();
    await seedServer(harness, 'srv1');
    await harness.userDO.userMcp_update(await testOwner(), 'srv1', {
      headers: { Authorization: 'Bearer mcp-secret' },
    });

    const stored = storedHeaders(harness, 'srv1');
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('mcp-secret');
    harness.close();
  });

  test('it opens again under the server it was sealed for, and not under another', async () => {
    const harness = createTestUserDO();
    await seedServer(harness, 'srv1');
    await seedServer(harness, 'srv2');
    await harness.userDO.userMcp_update(await testOwner(), 'srv1', {
      headers: { Authorization: 'Bearer mcp-secret' },
    });

    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    const stored = present(storedHeaders(harness, 'srv1'), "the sealed headers of MCP server 'srv1'");
    expect(JSON.parse(await cipher.open('test-user-do:mcp:srv1', stored)))
      .toEqual({ Authorization: 'Bearer mcp-secret' });
    await expect(cipher.open('test-user-do:mcp:srv2', stored)).rejects.toThrow('failed to decrypt');
    harness.close();
  });

  test('clearing headers stores null, not an envelope of nothing', async () => {
    const harness = createTestUserDO();
    await seedServer(harness, 'srv1');
    await harness.userDO.userMcp_update(await testOwner(), 'srv1', { headers: { Authorization: 'Bearer x' } });
    await harness.userDO.userMcp_update(await testOwner(), 'srv1', { headers: null });
    expect(storedHeaders(harness, 'srv1')).toBeNull();
    harness.close();
  });
});

describe('a sealed value is bound to the store it was written in', () => {
  test("one user's credential does not open inside another user's Durable Object", async () => {
    const mine = createTestUserDO({ durableObjectId: 'user-a' });
    await mine.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-mine' });
    const sealed = present(storedValue(mine, 'openai.bearer'), 'the sealed openai.bearer row');
    mine.close();

    const theirs = createTestUserDO({ durableObjectId: 'user-b' });
    sqlExec(theirs.db).exec(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    sqlExec(theirs.db).exec(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      'openai.bearer', 'bearer', sealed, 0, 0,
    );

    await expect(theirs.userDO.getAuthHeaders(await testOwner(), 'openai.bearer'))
      .rejects.toThrow('opening the stored credential openai.bearer');
    theirs.close();
  });
});
