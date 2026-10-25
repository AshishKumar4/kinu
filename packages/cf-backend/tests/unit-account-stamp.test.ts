// An account a release left behind is reset as its object starts, before any call reads it: each changed table is
// dropped and made anew empty, its retired tables dropped, every other table kept, and it is stamped and serves (core
// state/schema-repair.ts). One whose reset refuses answers every call with SQLite's reason, and its tables stay as they
// were. One its class never made is made and stamped as it starts.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { opsCaller, SCHEMA_STAMPS } from '@kinu.run/core';
import { kvOf } from './helpers/platform-context';
import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner } from './helpers/user-do';

const ops = () => opsCaller({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

test('an account made now is stamped as this build\'s', () => {
  const harness = createTestUserDO();

  try {
    expect(kvOf(harness.db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.account);
  } finally {
    harness.close();
  }
});

/** An account with its profile, left as production's build (f9c17ac7b) made it: a received share card with no
 *  `received_at`, a pending device join, which this build keeps as a connection ticket, a table that build declared,
 *  and another stamp. */
async function leftBehind() {
  const storage = new Database(':memory:');
  const made = createTestUserDO({ storage });
  const owner = await testOwner();

  await made.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');
  made.close();
  storage.exec(`DROP TABLE user_share_cards; CREATE TABLE user_share_cards (owner_user_id TEXT NOT NULL, workspace TEXT NOT NULL, share_id TEXT NOT NULL,
    card TEXT NOT NULL, PRIMARY KEY (owner_user_id, workspace, share_id)); INSERT INTO user_share_cards VALUES ('sender', 'jarvis', 's-1', '{}')`);
  storage.exec("CREATE TABLE device_joins (device_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); INSERT INTO device_joins VALUES ('d-1', 1)");
  storage.exec("CREATE TABLE user_peer_grants (agent TEXT PRIMARY KEY); INSERT INTO user_peer_grants VALUES ('peer')");
  kvOf(storage).set('kinu.schema_stamp', 1);

  return { storage, owner };
}

test('an account behind this build is reset as it starts: its changed tables made anew empty, the rest kept, and serves', async () => {
  const { storage, owner } = await leftBehind();
  const behind = createTestUserDO({ storage });

  try {
    expect(kvOf(storage).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.account);
    expect((await behind.userDO.getProfile(owner))?.email).toBe('owner@example.com');

    const answer = await behind.userDO.opsTables(await ops());

    expect({ dropped: answer.repair?.dropped, retired: answer.repair?.retired, refused: answer.refused })
      .toEqual({ dropped: ['user_share_cards'], retired: ['device_joins', 'user_peer_grants'], refused: null });
    expect(storage.query('SELECT COUNT(*) AS n FROM user_share_cards').all()).toEqual([{ n: 0 }]);
    expect(storage.query("SELECT name FROM sqlite_master WHERE name = 'device_joins'").all()).toEqual([]);
    expect(answer.census.find(({ table }) => table === 'user_profile')?.rows).toBe(1);
  } finally {
    behind.close();
  }
});

test('an account whose init cannot run over what it holds answers every call with why, and keeps its tables', async () => {
  const { storage, owner } = await leftBehind();

  // A table holding the name of an index the init makes: no reset can run the init, so it refuses.
  storage.exec('DROP INDEX idx_user_cli_tokens_active; CREATE TABLE idx_user_cli_tokens_active (id TEXT)');
  const refused = createTestUserDO({ storage });

  try {
    await expect(refused.userDO.getProfile(owner)).rejects.toThrow('idx_user_cli_tokens_active');
    // A socket or request is refused as a call is.
    expect((await refused.userDO.fetch(new Request('https://user/devices/connect'))).status).toBe(503);
    expect(kvOf(storage).get('kinu.schema_stamp')).toBe(1);
    // Neither its changed table nor its retired one was dropped.
    expect(storage.query('SELECT share_id FROM user_share_cards UNION ALL SELECT device_id FROM device_joins').all())
      .toEqual([{ share_id: 's-1' }, { share_id: 'd-1' }]);
    expect((await refused.userDO.opsTables(await ops())).refused).toContain('idx_user_cli_tokens_active');
  } finally {
    refused.close();
  }
});

test('the builtin sign-in directory drops its changed passkeys table as production made it, and the account stays', async () => {
  const storage = new Database(':memory:');

  createTestUserDO({ storage }).close();
  storage.exec(`CREATE TABLE builtin_accounts (user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    password_hash TEXT, password_salt TEXT, password_iterations INTEGER, generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  storage.exec(`CREATE TABLE builtin_passkeys (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
    transports TEXT NOT NULL); INSERT INTO builtin_passkeys VALUES ('cred', 'u-1', 'key', 3, '["usb"]')`);
  kvOf(storage).set('kinu.schema_stamp', 1);
  const directory = createTestUserDO({ storage });

  try {
    expect((await directory.userDO.opsTables(await ops())).repair?.dropped).toContain('builtin_passkeys');
    expect(storage.query('SELECT COUNT(*) AS n FROM builtin_passkeys').all()).toEqual([{ n: 0 }]);
    storage.exec("INSERT INTO builtin_passkeys (credential_id, user_id, public_key, counter) VALUES ('cred-2', 'u-1', 'key', 0)");
  } finally {
    directory.close();
  }
});

// The MCP redesign (ledger 1025-mcp): an earlier build kept a copy of each server in the Agents SDK's own catalog
// (`cf_agents_mcp_servers`), which the SDK dials at every start. The reset that drops the servers drops those copies.
test('an account an earlier build left with MCP servers is reset with them, the Agents SDK\'s copies included', async () => {
  const storage = new Database(':memory:');
  const owner = await testOwner();

  createTestUserDO({ storage }).close();
  storage.exec(`DROP TABLE user_mcp_servers; CREATE TABLE user_mcp_servers (id TEXT PRIMARY KEY, headers TEXT, allowed_tools TEXT, preset_id TEXT);
    INSERT INTO user_mcp_servers VALUES ('srv-1', NULL, NULL, 'github')`);
  storage.exec(`CREATE TABLE cf_agents_mcp_servers (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, server_url TEXT NOT NULL, callback_url TEXT NOT NULL,
    client_id TEXT, auth_url TEXT, server_options TEXT); INSERT INTO cf_agents_mcp_servers VALUES ('srv-1', 'GitHub', 'https://api.githubcopilot.com/mcp/',
    'https://kinu.example/api/user/mcp/callback', NULL, NULL, '{"transport":{"type":"streamable-http"}}')`);
  kvOf(storage).set('kinu.schema_stamp', 1);
  const woken = createTestUserDO({ storage });

  try {
    expect((await woken.userDO.opsTables(await ops())).repair?.dropped).toContain('user_mcp_servers');
    expect({ servers: await woken.userDO.userMcp_list(owner), copies: storage.query('SELECT id FROM cf_agents_mcp_servers').all() }).toEqual({ servers: [], copies: [] });
  } finally {
    woken.close();
  }
});
