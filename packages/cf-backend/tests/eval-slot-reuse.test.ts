/**
 * One eval slot reused trial after trial, on the real account a deployment gives it (the UserDO over bun:sqlite),
 * judged by the slot's own rule (core's `inheritedRows`, which the eval runner opens each trial with). Defends:
 * concurrent trials on one account listing and messaging each other (2026-10-01), and a trial inheriting what the one
 * before it left.
 */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { inheritedRows } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const db = new Database(':memory:');

const harness = createTestUserDO({ storage: db, durableObjectId: USER_ID });

const owner = await testOwner();

await harness.userDO.ensureProfile(owner, 'eval-service+trial-7@kinu.run');

await harness.userDO.setCredential(owner, 'opencode-go.bearer', { kind: 'bearer', token: 'sk-probe' });

afterAll(() => { db.close(); });

/** What the next trial on this slot would inherit, as its opener reads the account. */
const inherited = async () => inheritedRows(await harness.userDO.heldRows(owner));

describe('one eval slot, reused by trial after trial', () => {
  test('a trial that removes its workspace leaves nothing the next trial inherits', async () => {
    expect(await inherited()).toEqual({});

    await provisionTestWorkspace(harness, 'eval-order-book-3-aaa111');
    // While it runs, its workspace is the account's, and the rule sees it: a slot is not open beside a live trial.
    expect(Object.keys(await inherited()).length).toBeGreaterThan(0);

    await harness.userDO.removeWorkspace(owner, 'eval-order-book-3-aaa111', USER_ID);
    expect(await inherited()).toEqual({});
  });

  test('a trial that leaves an account row behind is named with its count, and its workspace is not', async () => {
    await provisionTestWorkspace(harness, 'eval-order-book-3-bbb222');
    await harness.userDO.setConfig(owner, 'theme', 'dark');
    await harness.userDO.sharesReceived_add(owner, {
      ownerUserId: 'f'.repeat(32), ownerEmail: 'sam@example.test', workspace: 'their-ws', shareId: 'share-1',
    });
    await harness.userDO.removeWorkspace(owner, 'eval-order-book-3-bbb222', USER_ID);

    expect(await inherited()).toEqual({ user_config: 1, user_shares_received: 1 });

    // Gone once the account forgets them: the slot opens again.
    await harness.userDO.sharesReceived_forget(owner, 'f'.repeat(32));
    expect(await inherited()).toEqual({ user_config: 1 });
  });
});
