// The workspace listing is bounded per page: the most recently visited active
// workspaces beside the whole-roster total, with a cursor that walks to the
// next page — so no roster row is unreachable, and a short page is never
// mistaken for a complete roster. Server-side fans that must reach every
// active workspace enumerate through the exact read, not the paged listing.
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

describe('root-cloud title authority', () => {
  test('registration records whose title it is and reads it back', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'named-by-owner', 'Chosen Title');
    expect(await harness.userDO.getWorkspaceTitle(owner, 'named-by-owner')).toEqual({
      displayName: 'Chosen Title', nameOrigin: 'user',
    });
    await harness.userDO.registerWorkspace(owner, 'derived', undefined, 'a mission');
    expect(await harness.userDO.getWorkspaceTitle(owner, 'derived'))
      .toMatchObject({ nameOrigin: 'auto' });
    harness.close();
  });

  test("an owner rename is final: a later auto title is refused at the root", async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'ws');
    await harness.userDO.setWorkspaceDisplayName(owner, 'ws', 'Owner Chose', 'user');
    expect((await harness.userDO.setWorkspaceDisplayName(owner, 'ws', 'Model Suggests', 'auto')).applied).toBe(false);
    expect(await harness.userDO.getWorkspaceTitle(owner, 'ws')).toEqual({
      displayName: 'Owner Chose', nameOrigin: 'user',
    });
    // An explicit owner write still applies.
    await harness.userDO.setWorkspaceDisplayName(owner, 'ws', 'Renamed Again', 'user');
    expect(await harness.userDO.getWorkspaceTitle(owner, 'ws')).toMatchObject({ displayName: 'Renamed Again' });
    harness.close();
  });

  test('the reconciliation column exists on tables created before it did', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'legacy-row');
    // Reads the column by NAME — the same way every writer does. On a
    // pre-column table this throws unless reconcileColumns added it.
    expect(await harness.userDO.getWorkspaceTitle(owner, 'legacy-row'))
      .toMatchObject({ nameOrigin: 'auto' });
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

describe('listWorkspaces pages', () => {
  test('the roster past the wire bound is reachable page by page, exactly once', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, OVERFLOW);
    const expected = Array.from({ length: OVERFLOW }, (_, i) => `ws-${String(i).padStart(3, '0')}`);

    const names: string[] = [];
    let cursor: string | null = null;
    let total = -1;
    do {
      const page = await harness.userDO.listWorkspaces(owner, { cursor, limit: 50 });
      expect(page.entries.length).toBeLessThanOrEqual(50);
      names.push(...page.entries.map((w) => w.name));
      total = page.total;
      cursor = page.nextCursor;
    } while (cursor);

    expect(names.slice().sort()).toEqual(expected.slice().sort());
    expect(new Set(names).size).toBe(OVERFLOW);
    expect(total).toBe(OVERFLOW);
    harness.close();
  });

  test('a truncated default page reports the cursor that continues it', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, OVERFLOW);

    const page = await harness.userDO.listWorkspaces(owner);
    expect(page.entries.length).toBe(200);
    expect(page.total).toBe(OVERFLOW);
    expect(page.nextCursor).not.toBeNull();
    harness.close();
  });

  test('a request over the wire bound clamps instead of widening', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, OVERFLOW);

    const page = await harness.userDO.listWorkspaces(owner, { limit: 1000 });
    expect(page.entries.length).toBe(200);
    harness.close();
  });

  test('an invalid cursor is an error, never a silent restart from page one', async () => {
    const harness = createTestUserDO();
    const owner = await seedRoster(harness, 2);

    await expect(harness.userDO.listWorkspaces(owner, { cursor: 'garbage' }))
      .rejects.toThrow('Invalid workspace roster cursor');
    harness.close();
  });
});
