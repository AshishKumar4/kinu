// Account deletion against the REAL UserDO over bun:sqlite: every workspace
// object torn down through the same path a single delete takes, every device
// and MCP row swept through its own revoke, then the object's storage gone and
// its context aborted with the SDK's sentinel — and, over the same database, a
// fresh object that reads as a brand-new account.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const OTHER_OWNER = 'f'.repeat(32);

/** Every table the account writes, by the prefixes the user schema uses. */
function accountTables(db: Database): string[] {
  return db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND (name LIKE 'user_%' OR name LIKE 'device_%' OR name LIKE 'cli_%' OR name LIKE 'codex_%')
     ORDER BY name`,
  ).all().map((row) => row.name);
}

function macrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);

  return promise;
}

function count(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0;
}

async function seededAccount() {
  const db = new Database(':memory:');
  const harness = createTestUserDO({ storage: db, durableObjectId: USER_ID });
  const owner = await testOwner();

  await harness.userDO.ensureProfile(owner, 'owner@example.test', 'Owner');
  await provisionTestWorkspace(harness, 'ws-alpha', 'Alpha');
  await provisionTestWorkspace(harness, 'ws-beta', 'Beta');
  await harness.userDO.sharesReceived_add(owner, {
    ownerUserId: OTHER_OWNER, ownerEmail: 'sam@example.test', workspace: 'their-ws', shareId: 'share-1', title: 'Issue triage',
  });
  await harness.userDO.setCredential(owner, 'anthropic.bearer', { kind: 'bearer', token: 'sk-probe' });
  db.run(
    `INSERT INTO user_mcp_servers (id, name, server_url, transport) VALUES ('srv-1', 'github', 'https://mcp.example/v1', 'auto')`,
  );
  db.run(`INSERT INTO device_consent (agent_name, device_id, policy) VALUES ('ws-alpha', 'dev-1', 'allow')`);

  return { db, harness, owner };
}

describe('deleting the account', () => {
  test('tears down every workspace, sweeps every row, and ends the object', async () => {
    const { db, harness, owner } = await seededAccount();

    expect(count(db, 'user_workspaces')).toBe(2);
    expect(count(db, 'user_shares_received')).toBe(1);
    expect(count(db, 'user_credentials')).toBe(1);
    expect(count(db, 'user_mcp_servers')).toBe(1);
    expect(count(db, 'device_consent')).toBe(1);

    const result = await harness.userDO.deleteAccount(owner, USER_ID);

    expect(result).toEqual({ ok: true, workspaces: 2 });
    expect([...harness.destroyedWorkspaces].sort()).toEqual(['ws-alpha', 'ws-beta']);
    // The abort is deferred past the returning call, as the SDK defers it —
    // onto the timer queue, with no signal to await, so one macrotask turn is
    // the only way to observe it.
    expect(harness.aborted).toEqual([]);
    await macrotask();
    expect(harness.aborted).toEqual(['destroyed']);
    expect(accountTables(db)).toEqual([]);

    // The next activation over this storage is a new account: no profile, no
    // onboarding stamp, no workspaces.
    const revived = createTestUserDO({ storage: db, durableObjectId: USER_ID });
    const profile = await revived.userDO.ensureProfile(owner, 'owner@example.test');

    expect(profile.onboardedAt).toBeNull();
    expect(profile.displayName).toBeNull();
    expect((await revived.userDO.listWorkspaces(owner)).entries).toEqual([]);
    expect(await revived.userDO.sharesReceived_list(owner)).toEqual([]);
    expect(await revived.userDO.listCredentials(owner)).toEqual([]);
    db.close();
  });

  test('a completed onboarding does not survive the delete', async () => {
    const { db, harness, owner } = await seededAccount();
    await harness.userDO.completeOnboarding(owner);

    expect((await harness.userDO.getProfile(owner))?.onboardedAt).not.toBeNull();
    await harness.userDO.deleteAccount(owner, USER_ID);

    const revived = createTestUserDO({ storage: db, durableObjectId: USER_ID });

    expect((await revived.userDO.ensureProfile(owner, 'owner@example.test')).onboardedAt).toBeNull();
    db.close();
  });

  test('refuses an owner id that is not one', async () => {
    const { db, harness, owner } = await seededAccount();

    await expect(harness.userDO.deleteAccount(owner, 'not-an-id')).rejects.toThrow('invalid owner user id');
    expect(count(db, 'user_workspaces')).toBe(2);
    expect(harness.aborted).toEqual([]);
    db.close();
  });

  test('a workspace that cannot be destroyed stops the delete with its row marked', async () => {
    const db = new Database(':memory:');
    const harness = createTestUserDO({ storage: db, durableObjectId: USER_ID, destroyWorkspaceError: 'container refused to stop' });
    const owner = await testOwner();
    await provisionTestWorkspace(harness, 'ws-alpha', 'Alpha');

    await expect(harness.userDO.deleteAccount(owner, USER_ID)).rejects.toThrow('container refused to stop');
    // Fail-closed, exactly as one delete: the row stays, marked, and the
    // object is still here for the retry.
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM user_workspaces WHERE delete_pending = 1`).get()?.n).toBe(1);
    expect(harness.aborted).toEqual([]);
    db.close();
  });
});

describe('forgetting the shares an owner gave', () => {
  test('removes only the rows that name that owner', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    const receipt = { ownerEmail: 'sam@example.test', workspace: 'their-ws', title: 'Issue triage' };
    await harness.userDO.sharesReceived_add(owner, { ...receipt, ownerUserId: OTHER_OWNER, shareId: 'share-1' });
    await harness.userDO.sharesReceived_add(owner, { ...receipt, ownerUserId: OTHER_OWNER, shareId: 'share-2' });
    await harness.userDO.sharesReceived_add(owner, { ...receipt, ownerUserId: 'e'.repeat(32), shareId: 'share-3' });

    await harness.userDO.sharesReceived_forget(owner, OTHER_OWNER);

    expect((await harness.userDO.sharesReceived_list(owner)).map((row) => row.shareId)).toEqual(['share-3']);
    harness.close();
  });
});
