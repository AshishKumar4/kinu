// The workspace listing is bounded on the wire: a page of the most recently
// visited active workspaces beside the whole-roster total, so a short page is
// never mistaken for a complete roster. Server-side fans that must reach every
// active workspace enumerate through the exact read, not the capped page.
import { describe, expect, test } from 'bun:test';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';

const OVERFLOW = 205;
const USER_ID = '0123456789abcdef0123456789abcdef';

async function seedRoster(harness: TestUserDO, count: number) {
  const owner = await testOwner();
  for (let i = 0; i < count; i++) {
    await harness.userDO.registerWorkspace(owner, `ws-${String(i).padStart(3, '0')}`);
  }
  return owner;
}

describe('listWorkspaces', () => {
  test('the response states the whole roster beside its bound page', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, OVERFLOW);

    const list = await harness.userDO.listWorkspaces(owner);
    expect(list.entries.length).toBeLessThan(OVERFLOW);
    expect(list.total).toBe(OVERFLOW);
    harness.close();
  });

  test('the page keeps the most recently visited active workspaces', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, OVERFLOW);
    await harness.userDO.touchWorkspace(owner, 'ws-000');

    const list = await harness.userDO.listWorkspaces(owner);
    expect(list.entries[0]?.name).toBe('ws-000');
    const visited = list.entries.map((w) => w.lastVisited);
    expect([...visited].sort((a, b) => b - a)).toEqual(visited);
    harness.close();
  });

  test('removed workspaces count toward nothing', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, 3);
    await harness.userDO.registerWorkspace(owner, 'gone');
    await harness.userDO.removeWorkspace(owner, 'gone', USER_ID);

    const list = await harness.userDO.listWorkspaces(owner);
    expect(list.entries.map((w) => w.name)).not.toContain('gone');
    expect(list.total).toBe(3);
    harness.close();
  });
});

describe('listActiveWorkspaces', () => {
  test('enumeration stays complete when the listing truncates', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, OVERFLOW);

    const all = await harness.userDO.listActiveWorkspaces(owner);
    expect(all.map((w) => w.name).sort()).toEqual(
      Array.from({ length: OVERFLOW }, (_, i) => `ws-${String(i).padStart(3, '0')}`).sort(),
    );
    harness.close();
  });

  test('removed workspaces are not enumerated', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, 2);
    await harness.userDO.registerWorkspace(owner, 'gone');
    await harness.userDO.removeWorkspace(owner, 'gone', USER_ID);
    const all = await harness.userDO.listActiveWorkspaces(owner);
    expect(all.map((w) => w.name)).not.toContain('gone');
    expect(all.length).toBe(2);
    harness.close();
  });
});
