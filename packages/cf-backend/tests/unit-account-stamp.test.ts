// An account a release left behind is repaired as its object starts, before any call reads it: its stale tables
// rebuilt keeping their rows, a pending join (a regenerable ticket) made anew, its retired tables dropped, and it is
// stamped and serves (core state/schema-repair.ts). One
// whose repair refuses answers every call with SQLite's reason, and its tables stay as they were. One its class never
// made is made and stamped as it starts.
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
 *  `received_at`, a pending device join with no ticket, a table that build declared, and another stamp. */
async function leftBehind() {
  const storage = new Database(':memory:');
  const made = createTestUserDO({ storage });
  const owner = await testOwner();

  await made.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');
  made.close();
  storage.exec(`DROP TABLE user_share_cards; CREATE TABLE user_share_cards (owner_user_id TEXT NOT NULL, workspace TEXT NOT NULL, share_id TEXT NOT NULL,
    card TEXT NOT NULL, PRIMARY KEY (owner_user_id, workspace, share_id)); INSERT INTO user_share_cards VALUES ('sender', 'jarvis', 's-1', '{}')`);
  storage.exec("DROP TABLE device_joins; CREATE TABLE device_joins (device_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); INSERT INTO device_joins VALUES ('d-1', 1)");
  storage.exec("CREATE TABLE user_peer_grants (agent TEXT PRIMARY KEY); INSERT INTO user_peer_grants VALUES ('peer')");
  kvOf(storage).set('kinu.schema_stamp', 1);

  return { storage, owner };
}

test('an account behind this build is repaired as it starts, keeping its rows, and serves', async () => {
  const { storage, owner } = await leftBehind();
  const behind = createTestUserDO({ storage });

  try {
    expect(kvOf(storage).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.account);
    expect((await behind.userDO.getProfile(owner))?.email).toBe('owner@example.com');

    const answer = await behind.userDO.opsTables(await ops());

    expect({ rebuilt: answer.repair?.rebuilt, refilled: answer.repair?.refilled, retired: answer.repair?.retired, refused: answer.refused })
      .toEqual({ rebuilt: ['user_share_cards'], refilled: ['device_joins'], retired: ['user_peer_grants'], refused: null });
    // The card is kept, received before the column was, so it reads as seen.
    expect(storage.query('SELECT share_id, received_at FROM user_share_cards').all()).toEqual([{ share_id: 's-1', received_at: 0 }]);
    expect(answer.census.find(({ table }) => table === 'user_profile')?.rows).toBe(1);
  } finally {
    behind.close();
  }
});

test('an account whose repair refuses answers every call with why, and keeps its tables as they were', async () => {
  const { storage, owner } = await leftBehind();

  // A table whose rows the build's shape cannot take: a NOT NULL column with no default and no source.
  storage.exec('DROP TABLE cli_agent_connect_tickets');
  storage.exec("CREATE TABLE cli_agent_connect_tickets (ticket_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); INSERT INTO cli_agent_connect_tickets VALUES ('t', 1)");
  const refused = createTestUserDO({ storage });

  try {
    await expect(refused.userDO.getProfile(owner)).rejects.toThrow('NOT NULL constraint failed: cli_agent_connect_tickets.user_id');
    // A socket or request is refused as a call is.
    expect((await refused.userDO.fetch(new Request('https://user/devices/connect'))).status).toBe(503);
    expect(kvOf(storage).get('kinu.schema_stamp')).toBe(1);
    expect(storage.query('SELECT ticket_hash FROM cli_agent_connect_tickets').all()).toEqual([{ ticket_hash: 't' }]);
    expect((await refused.userDO.opsTables(await ops())).refused).toContain('cli_agent_connect_tickets');
  } finally {
    refused.close();
  }
});

test('the builtin sign-in directory repairs its own tables as production made them, keeping every passkey', async () => {
  const storage = new Database(':memory:');

  createTestUserDO({ storage }).close();
  storage.exec(`CREATE TABLE builtin_accounts (user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    password_hash TEXT, password_salt TEXT, password_iterations INTEGER, generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  storage.exec(`CREATE TABLE builtin_passkeys (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
    transports TEXT NOT NULL); INSERT INTO builtin_passkeys VALUES ('cred', 'u-1', 'key', 3, '["usb"]')`);
  kvOf(storage).set('kinu.schema_stamp', 1);
  const directory = createTestUserDO({ storage });

  try {
    expect((await directory.userDO.opsTables(await ops())).repair?.rebuilt).toContain('builtin_passkeys');
    expect(storage.query('SELECT credential_id, counter FROM builtin_passkeys').all()).toEqual([{ credential_id: 'cred', counter: 3 }]);
    storage.exec("INSERT INTO builtin_passkeys (credential_id, user_id, public_key, counter) VALUES ('cred-2', 'u-1', 'key', 0)");
  } finally {
    directory.close();
  }
});
