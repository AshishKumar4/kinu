// The workspace listing is bounded per page: the most recently visited active
// workspaces beside the whole-roster total, with a cursor that walks to the
// next page — so no roster row is unreachable, and a short page is never
// mistaken for a complete roster. Server-side fans that must reach every
// active workspace enumerate through the exact read, not the paged listing.
import * as v from 'valibot';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  TEST_CREDENTIAL_ENCRYPTION_KEY,
  createTestUserDO, createdWorkspace, testOwner, type TestUserDO, type TestUserDOOptions,
} from './helpers/user-do';
import { handleUserRequest } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';

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

describe('a deletion that could not finish', () => {
  /** The registry row as SQL sees it, marker included — the durable state the
   *  retry reads, which no wire shape exposes. */
  function pendingRows(harness: TestUserDO): Array<{ name: string; delete_pending: number }> {
    return harness.db.prepare<{ name: string; delete_pending: number }, []>(
      `SELECT name, delete_pending FROM user_workspaces ORDER BY name`,
    ).all();
  }

  test('a failed teardown leaves a marked row that no ordinary read shows', async () => {
    // KINU-024: the teardown failed closed but recorded no intent, so a
    // workspace could sit with its container destroyed and its registry row
    // intact, still listed and still openable, with nothing responsible for
    // finishing the job.
    const harness = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceError: 'the container refused to go',
    });
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'half-gone');

    await expect(harness.userDO.removeWorkspace(owner, 'half-gone', USER_ID))
      .rejects.toThrow('the container refused to go');

    expect(pendingRows(harness)).toEqual([{ name: 'half-gone', delete_pending: 1 }]);
    // Hidden from the list, from the total, and from the ownership gate every
    // open goes through.
    const list = await harness.userDO.listWorkspaces(owner);
    expect(list.entries.map((w) => w.name)).toEqual([]);
    expect(list.total).toBe(0);
    expect(await harness.userDO.listActiveWorkspaces(owner)).toEqual([]);
    harness.close();
  });

  test('the next read finishes the cleanup and drops the row', async () => {
    // The retry has an owner and it is the owner's own next read. No second
    // timer: this object has no wake of its own, and the marker is what carries
    // the work across the reset.
    // Typed rather than inferred: the object is MUTATED below to clear the
    // failure, and an inferred `destroyWorkspaceError: string` makes that
    // assignment illegal. The options type already spells the field optional.
    const options: TestUserDOOptions = {
      durableObjectId: USER_ID, destroyWorkspaceError: 'the container refused to go',
    };
    const harness = createTestUserDO(options);
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'half-gone');
    await expect(harness.userDO.removeWorkspace(owner, 'half-gone', USER_ID)).rejects.toThrow();

    // The condition that failed is gone — a container that came back, a plane
    // that answered this time.
    options.destroyWorkspaceError = undefined;
    const list = await harness.userDO.listWorkspaces(owner);

    expect(harness.destroyedWorkspaces).toEqual(['half-gone']);
    expect(pendingRows(harness)).toEqual([]);
    expect(list.entries).toEqual([]);
    harness.close();
  });

  test('a cleanup that fails again keeps its marker and the reader still answers', async () => {
    const harness = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceError: 'the container refused to go',
    });
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'half-gone');
    await harness.userDO.registerWorkspace(owner, 'healthy');
    await expect(harness.userDO.removeWorkspace(owner, 'half-gone', USER_ID)).rejects.toThrow();

    // A listing must not fail because an unrelated workspace cannot finish
    // dying: the row IS the retry, so nothing is lost by answering.
    const list = await harness.userDO.listWorkspaces(owner);

    expect(list.entries.map((w) => w.name)).toEqual(['healthy']);
    expect(pendingRows(harness)).toEqual([
      { name: 'half-gone', delete_pending: 1 },
      { name: 'healthy', delete_pending: 0 },
    ]);
    harness.close();
  });

  test('a successful delete never leaves a marker behind', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'gone');

    await harness.userDO.removeWorkspace(owner, 'gone', USER_ID);

    expect(harness.destroyedWorkspaces).toEqual(['gone']);
    expect(pendingRows(harness)).toEqual([]);
    harness.close();
  });

  test('a marked name cannot be recreated, or rolled back out from under the cleanup', async () => {
    const harness = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceError: 'the container refused to go',
    });
    const owner = await testOwner();
    const entry = createdWorkspace(await harness.userDO.registerWorkspace(owner, 'half-gone'));
    await expect(harness.userDO.removeWorkspace(owner, 'half-gone', USER_ID)).rejects.toThrow();

    // Recreating over a marked row would hand the owner a workspace wired to
    // the Durable Object and the planes this teardown still owes a destroy.
    await expect(harness.userDO.registerWorkspace(owner, 'half-gone'))
      .rejects.toThrow('still being deleted');
    await expect(harness.userDO.reserveWorkspace(owner, 'half-gone'))
      .rejects.toThrow('still being deleted');
    // A fork rollback is not entitled to this row: dropping it would erase the
    // only record that a destroy is still owed.
    expect(await harness.userDO.releaseWorkspaceReservation(owner, 'half-gone', entry.createdAt))
      .toBe(false);

    expect(pendingRows(harness)).toEqual([{ name: 'half-gone', delete_pending: 1 }]);
    expect(await harness.userDO.hasWorkspace(owner, 'half-gone')).toBe(false);
    expect(await harness.userDO.getWorkspaceTitle(owner, 'half-gone')).toBeNull();
    // A workspace being torn down has no title to read and none to commit.
    expect(await harness.userDO.setWorkspaceDisplayName(owner, 'half-gone', 'Renamed', 'user'))
      .toEqual({ applied: false });
    harness.close();
  });

  test('a visit does not stir a marked row', async () => {
    const harness = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceError: 'the container refused to go',
    });
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'half-gone');
    await expect(harness.userDO.removeWorkspace(owner, 'half-gone', USER_ID)).rejects.toThrow();
    harness.db.prepare(`UPDATE user_workspaces SET last_visited = 1 WHERE name = 'half-gone'`).run();

    // A workspace being torn down is not one the owner can visit, so the visit
    // finds nothing to stir — the same answer every ordinary read gives.
    await harness.userDO.touchWorkspace(owner, 'half-gone');

    expect(harness.db.prepare<{ last_visited: number }, []>(
      `SELECT last_visited FROM user_workspaces WHERE name = 'half-gone'`,
    ).all()).toEqual([{ last_visited: 1 }]);
    harness.close();
  });

  test('the name is free again once the teardown finishes, and the create drives it', async () => {
    const options: TestUserDOOptions = {
      durableObjectId: USER_ID, destroyWorkspaceError: 'the container refused to go',
    };
    const harness = createTestUserDO(options);
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'reused');
    await expect(harness.userDO.removeWorkspace(owner, 'reused', USER_ID)).rejects.toThrow();

    // The owner deletes, the teardown trips on something transient, and the
    // owner types the same name again. The create is a read of this registry
    // too, so it drives the retry: they get their name back, not a dead end.
    options.destroyWorkspaceError = undefined;
    const registered = await harness.userDO.registerWorkspace(owner, 'reused');

    expect(harness.destroyedWorkspaces).toEqual(['reused']);
    // A new workspace, not the old one resurrected — the marked row was dropped
    // by the teardown that owned it before this insert ran.
    expect(registered.status).toBe('created');
    expect(pendingRows(harness)).toEqual([{ name: 'reused', delete_pending: 0 }]);
    expect((await harness.userDO.listWorkspaces(owner)).entries.map((w) => w.name))
      .toEqual(['reused']);
    harness.close();
  });

  test('a reset carries the intent, and the next activation finishes the job', async () => {
    // The marker is durable state, not a field on a live object, so an eviction
    // between the failed teardown and the retry loses nothing.
    const storage = new Database(':memory:');
    const first = createTestUserDO({
      durableObjectId: USER_ID, storage, destroyWorkspaceError: 'the container refused to go',
    });
    const owner = await testOwner();
    await first.userDO.registerWorkspace(owner, 'half-gone');
    await expect(first.userDO.removeWorkspace(owner, 'half-gone', USER_ID)).rejects.toThrow();
    first.close();

    const next = createTestUserDO({ durableObjectId: USER_ID, storage });
    const list = await next.userDO.listWorkspaces(owner);

    expect(next.destroyedWorkspaces).toEqual(['half-gone']);
    expect(pendingRows(next)).toEqual([]);
    expect(list.entries).toEqual([]);
    next.close();
    storage.close();
  });

  test('a workspace whose plane is already gone still converges', async () => {
    // Two shapes of absence, both of which a retry meets. The agents-SDK
    // destroy aborts its own isolate after the durable wipe, so that throw IS
    // completion; and a delete of a name this registry no longer holds has
    // nothing left to do. Neither may leave a marker nobody will clear.
    const harness = createTestUserDO({ durableObjectId: USER_ID, destroyWorkspaceError: 'destroyed' });
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'already-gone');

    await harness.userDO.removeWorkspace(owner, 'already-gone', USER_ID);
    await harness.userDO.removeWorkspace(owner, 'already-gone', USER_ID);

    expect(harness.destroyedWorkspaces).toEqual([]);
    expect(pendingRows(harness)).toEqual([]);
    expect((await harness.userDO.listWorkspaces(owner)).total).toBe(0);
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

const ErrorBodySchema = v.object({ error: v.string() });
const RosterPageSchema = v.object({
  entries: v.array(v.object({ name: v.string() })),
  total: v.number(),
  nextCursor: v.nullable(v.string()),
});

describe('malformed paging over HTTP', () => {
  const IDENTITY: AuthIdentity = {
    userId: USER_ID,
    email: 'ashish@example.com',
    sub: 'roster-paging',
    provider: 'test',
  };

  /** The roster route over the real registry, recording what reached it. */
  function routeHarness() {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const listed: unknown[] = [];
    const inner = harness.userDO;
    const stub = {
      async ensureProfile(...args: Parameters<TestUserDO['userDO']['ensureProfile']>) {
        return inner.ensureProfile(...args);
      },
      async listWorkspaces(...args: Parameters<TestUserDO['userDO']['listWorkspaces']>) {
        listed.push(args[1]);
        return inner.listWorkspaces(...args);
      },
    };
    const partialEnv: Partial<Env> = {};
    Object.assign(partialEnv, {
      UserDO: { idFromName: (name: string) => name, get: () => stub },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });
    // SAFETY: The roster route reads exactly the constructed UserDO namespace
    // plus credential key. Every typed binding reachable in this test is
    // present.
    const env = partialEnv as Env;
    const call = async (query: string): Promise<Response> => {
      const response = await handleUserRequest(
        new Request(`https://kinu.example.com/api/user/workspaces${query}`), env, IDENTITY,
      );
      if (!response) throw new Error('roster route did not handle the request');
      return response;
    };
    return { harness, call, listed };
  }

  test('a non-numeric limit is a 400 and never reaches the registry', async () => {
    const { harness, call, listed } = routeHarness();
    try {
      const response = await call('?limit=abc');
      expect(response.status).toBe(400);
      expect(v.parse(ErrorBodySchema, await response.json())).toEqual({ error: 'Workspace roster limit must be a positive integer.' });
      expect(listed).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('a non-positive limit is a 400', async () => {
    const { harness, call } = routeHarness();
    try {
      for (const query of ['?limit=-5', '?limit=12.5']) {
        const response = await call(query);
        expect(response.status).toBe(400);
      }
    } finally {
      harness.close();
    }
  });

  test('a garbage cursor is a 400, not an outage', async () => {
    const { harness, call } = routeHarness();
    try {
      const response = await call('?cursor=%7Bnope');
      expect(response.status).toBe(400);
      const body = v.parse(ErrorBodySchema, await response.json());
      // The rendered cause chain trails the contract sentence; the sentence
      // itself is what user-do holds verbatim.
      expect(body.error.startsWith('Invalid workspace roster cursor; start from page one.')).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('a usable page still walks through the route', async () => {
    const { harness, call } = routeHarness();
    try {
      const owner = await testOwner();
      for (const name of ['ws-a', 'ws-b', 'ws-c']) await harness.userDO.registerWorkspace(owner, name);

      const first = v.parse(RosterPageSchema, await (await call('?limit=2')).json());
      expect(first.entries).toHaveLength(2);
      expect(first.total).toBe(3);

      const second = v.parse(RosterPageSchema, await (await call(`?cursor=${first.nextCursor}`)).json());
      expect(second.entries).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    } finally {
      harness.close();
    }
  });
});
