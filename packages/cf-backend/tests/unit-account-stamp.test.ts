// An account whose storage a release's tables step has not reached answers every call with why, runs no init over it,
// and is brought to this build by the step's own call, which stamps it (identity/schema-stamp.ts). One its class never
// made is made and stamped as it starts.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { opsCaller, SCHEMA_STAMPS } from '@kinu.run/core';
import { kvOf } from './helpers/platform-context';
import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner } from './helpers/user-do';

test('an account made now is stamped as this build\'s', () => {
  const harness = createTestUserDO();

  try {
    expect(kvOf(harness.db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.account);
  } finally {
    harness.close();
  }
});

test('an account behind this build refuses every call until the tables step stamps it, and then serves', async () => {
  const storage = new Database(':memory:');
  const made = createTestUserDO({ storage });
  const owner = await testOwner();

  await made.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');
  made.close();
  // As a build before this one left it: its tables, and another stamp.
  kvOf(storage).set('kinu.schema_stamp', 1);

  const behind = createTestUserDO({ storage });

  try {
    await expect(behind.userDO.getProfile(owner)).rejects.toThrow("This account's storage was made before this release changed its tables");
    // A socket or request is refused as a call is.
    expect((await behind.userDO.fetch(new Request('https://user/devices/connect'))).status).toBe(503);

    const repaired = await behind.userDO.opsTables(await opsCaller({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY }), { tables: [], drop: true });

    expect(repaired.stamp).toBe('behind');
    expect(kvOf(storage).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.account);
    expect((await behind.userDO.getProfile(owner))?.email).toBe('owner@example.com');
  } finally {
    behind.close();
  }
});
