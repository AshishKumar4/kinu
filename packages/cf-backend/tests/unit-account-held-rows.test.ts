// What an eval trial's account holds, read before the trial opens (evals/src/slot.ts), on the real UserDO over
// bun:sqlite: a trial's own lifecycle leaves nothing the next trial in its slot would inherit, and anything else a
// trial could leave behind is named. 2026-10-01: concurrent trials on one account listed and messaged each other.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

/** A trial account as the deploy leaves it: its profile, and the eval provider key it was given. */
async function trialAccount() {
  const db = new Database(':memory:');
  const harness = createTestUserDO({ storage: db, durableObjectId: USER_ID });
  const owner = await testOwner();

  await harness.userDO.ensureProfile(owner, 'eval-service+trial-7@kinu.run');
  await harness.userDO.setCredential(owner, 'opencode-go.bearer', { kind: 'bearer', token: 'sk-probe' });

  return { db, harness, owner };
}

describe('the rows an eval trial account holds', () => {
  test('a provisioned account whose trial removed its workspace holds nothing the next trial would inherit', async () => {
    const { db, harness, owner } = await trialAccount();

    await provisionTestWorkspace(harness, 'eval-order-book-3-abc123');
    expect(await harness.userDO.heldRows(owner)).toMatchObject({ user_workspaces: 1, user_credentials: 1 });

    await harness.userDO.removeWorkspace(owner, 'eval-order-book-3-abc123', USER_ID);

    // Only the key, its revision counters, the profile and the schema's version: the full-text index's own
    // bookkeeping rows are not held.
    expect(Object.keys(await harness.userDO.heldRows(owner)).sort()).toEqual([
      'user_credential_revisions', 'user_credentials', 'user_credentials_revision', 'user_profile', 'user_schema_meta',
    ]);
    db.close();
  });

  test('a library entry, an MCP server, a share or a config row left behind is named with its count', async () => {
    const { db, harness, owner } = await trialAccount();

    db.run(`INSERT INTO user_mcp_servers (id, name, server_url, transport) VALUES ('srv-1', 'github', 'https://mcp.example/v1', 'auto')`);
    await harness.userDO.sharesReceived_add(owner, {
      ownerUserId: 'f'.repeat(32), ownerEmail: 'sam@example.test', workspace: 'their-ws', shareId: 'share-1',
    });
    await harness.userDO.setConfig(owner, 'theme', 'dark');
    await harness.userDO.searchExperience(owner);
    db.run(`INSERT INTO experience_library (id, kind, source_workspace, key, title, payload_json, evidence, search_text, published_at)
            VALUES ('exp-1', 'lesson', 'eval-order-book-3-abc123', 'k', 't', '{}', 'e', 's', 1)`);

    expect(await harness.userDO.heldRows(owner)).toMatchObject({
      experience_library: 1, user_config: 1, user_mcp_servers: 1, user_shares_received: 1,
    });
    db.close();
  });
});
