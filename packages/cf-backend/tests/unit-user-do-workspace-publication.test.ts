// A fork target being streamed into is not a workspace the owner has yet.
//
// KINU-027: `reserveWorkspace` holds the NAME before the transfer starts, so a
// second reservation of it cannot race in. Before this fence the row it held was
// indistinguishable from a finished workspace, so the owner's roster, the
// ownership gate and the title reads all offered a workspace whose contents were
// still arriving. `create_pending = 1` makes that row absent from every
// owner-visible surface, and `publishWorkspaceReservation` is the only thing that
// clears it.
//
// The oracle is per-surface on purpose. A loop over the surfaces would still
// pass with one `AND create_pending = 0` missing if the others covered for it, so
// each surface is asserted on its own line, and each has a published control
// beside it — "absent" has to be a fact about the fence, not about a harness that
// never registered anything.
import { describe, expect, test } from 'bun:test';
import {
  createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO,
} from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

/** The durable row behind the surfaces, which no wire shape exposes. */
function rowOf(harness: TestUserDO, name: string): { create_pending: number; last_visited: number } | null {
  return harness.db.prepare<{ create_pending: number; last_visited: number }, [string]>(
    `SELECT create_pending, last_visited FROM user_workspaces WHERE name = ?`,
  ).get(name);
}

/**
 * The refusal as its CALLER sees it. A fork rollback branches on the error's
 * name, because that is what survives the Durable Object RPC boundary — the
 * class does not — so the name is what this suite pins.
 */
async function refusalOf(publish: Promise<void>): Promise<{ name: string; message: string }> {
  try {
    await publish;
  } catch (cause) {
    if (cause instanceof Error) return { name: cause.name, message: cause.message };
    return { name: 'a thrown non-Error', message: String(cause) };
  }
  return { name: 'no refusal at all', message: 'the publish resolved' };
}

/** A known `last_visited`, so "the touch did nothing" is a fact rather than an
 *  artefact of two writes landing in the same millisecond. */
function markVisited(harness: TestUserDO, name: string, at: number): void {
  harness.db.prepare<unknown, [number, string]>(
    `UPDATE user_workspaces SET last_visited = ? WHERE name = ?`,
  ).run(at, name);
}

/** Two published siblings, so the roster has a page to walk and a total to be
 *  wrong about. Ordered `keeper-a` then `keeper-b` by descending last_visited,
 *  with a gap between them for the row under test: a pending row sorting AHEAD
 *  of the first page's cursor would be hidden by the cursor predicate rather
 *  than by the fence, leaving the cursor branch of the listing query unread. */
async function seedPublishedPair(harness: TestUserDO): Promise<void> {
  await provisionTestWorkspace(harness, 'keeper-b');
  await provisionTestWorkspace(harness, 'keeper-a');
  markVisited(harness, 'keeper-a', 2_000);
  markVisited(harness, 'keeper-b', 1_000);
}

/** Every page of the roster, so the cursor branch of the listing query is read
 *  and not only its first-page twin. */
async function walkRoster(harness: TestUserDO): Promise<string[]> {
  const owner = await testOwner();
  const names: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await harness.userDO.listWorkspaces(owner, { limit: 1, cursor });
    names.push(...page.entries.map((entry) => entry.name));
    cursor = page.nextCursor;
  } while (cursor);
  return names;
}

describe('a reservation the fork transfer has not committed', () => {
  test('is absent from every owner-visible surface', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await seedPublishedPair(harness);
    const reserved = await harness.userDO.reserveWorkspace(owner, 'in-flight', 'In flight');
    expect(reserved.reserved).toBe(true);
    markVisited(harness, 'in-flight', 1_500);

    // The listing: the most recently visited workspaces the owner has.
    const list = await harness.userDO.listWorkspaces(owner);
    expect(list.entries.map((entry) => entry.name)).not.toContain('in-flight');

    // The total beside it, which is what a roster UI counts.
    expect(list.total).toBe(2);

    // Every page, cursor branch included — a fork target must not surface on
    // page two of a roster it was hidden from on page one.
    expect(await walkRoster(harness)).toEqual(['keeper-a', 'keeper-b']);

    // The complete server-side enumeration: credential invalidation and the
    // CLI's config reconcile fan out over this, so a pending name here would be
    // pushed secrets and config for a workspace that does not exist.
    const active = await harness.userDO.listActiveWorkspaces(owner);
    expect(active.map((entry) => entry.name)).not.toContain('in-flight');

    // The ownership gate every open goes through.
    expect(await harness.userDO.hasWorkspace(owner, 'in-flight')).toBe(false);

    // The identity bootstrap, which reads that same gate: an uncommitted target
    // must not be issued a capability by anyone but the publish.
    await expect(harness.userDO.ensureWorkspaceCapability('in-flight', null))
      .rejects.toThrow('not in your registry');
    expect(harness.installed.has('in-flight')).toBe(false);

    // The title read an actor hydrates its naming cache from.
    expect(await harness.userDO.getWorkspaceTitle(owner, 'in-flight')).toBeNull();

    // The title WRITE, which reports the not-found answer rather than committing
    // a name onto a row the owner cannot see.
    expect(await harness.userDO.setWorkspaceDisplayName(owner, 'in-flight', 'Renamed', 'user'))
      .toEqual({ applied: false });

    // Recency: a workspace the owner cannot open is not one they can visit.
    await harness.userDO.touchWorkspace(owner, 'in-flight');
    expect(rowOf(harness, 'in-flight')?.last_visited).toBe(1_500);

    harness.close();
  });

  test('a published workspace IS visible on every one of those surfaces', async () => {
    // The negative control. Without it, "absent" would pass against a harness
    // that registers nothing, and the fence would be untested.
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await seedPublishedPair(harness);
    await provisionTestWorkspace(harness, 'in-flight', 'In flight');
    markVisited(harness, 'in-flight', 1_500);

    const list = await harness.userDO.listWorkspaces(owner);
    expect(list.entries.map((entry) => entry.name)).toContain('in-flight');
    expect(list.total).toBe(3);
    expect(await walkRoster(harness)).toEqual(['keeper-a', 'in-flight', 'keeper-b']);
    const active = await harness.userDO.listActiveWorkspaces(owner);
    expect(active.map((entry) => entry.name)).toContain('in-flight');
    expect(await harness.userDO.hasWorkspace(owner, 'in-flight')).toBe(true);
    await expect(harness.userDO.ensureWorkspaceCapability('in-flight', null)).resolves.toBeUndefined();
    expect(await harness.userDO.getWorkspaceTitle(owner, 'in-flight'))
      .toEqual({ displayName: 'In flight', nameOrigin: 'user' });
    expect(await harness.userDO.setWorkspaceDisplayName(owner, 'in-flight', 'Renamed', 'user'))
      .toEqual({ applied: true });
    await harness.userDO.touchWorkspace(owner, 'in-flight');
    expect(rowOf(harness, 'in-flight')?.last_visited).toBeGreaterThan(1_500);

    harness.close();
  });

  test('still refuses a second reservation of the same name', async () => {
    // The whole point of holding the row: absence from the roster must never
    // become a reason to hand the same name to a second transfer.
    const harness = createTestUserDO();
    const owner = await testOwner();
    const first = await harness.userDO.reserveWorkspace(owner, 'contested', 'First');

    const second = await harness.userDO.reserveWorkspace(owner, 'contested', 'Second');

    expect(second.reserved).toBe(false);
    expect(second.entry.createdAt).toBe(first.entry.createdAt);
    expect(second.entry.displayName).toBe('First');
    harness.close();
  });

  test('appears on every surface once published, holding the capability the publish installed', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await seedPublishedPair(harness);
    const reserved = await harness.userDO.reserveWorkspace(owner, 'in-flight', 'In flight');

    await harness.userDO.publishWorkspaceReservation(owner, 'in-flight', reserved.entry.createdAt, null);
    markVisited(harness, 'in-flight', 1_500);

    expect(rowOf(harness, 'in-flight')?.create_pending).toBe(0);
    const list = await harness.userDO.listWorkspaces(owner);
    expect(list.entries.map((entry) => entry.name)).toContain('in-flight');
    expect(list.total).toBe(3);
    expect(await walkRoster(harness)).toEqual(['keeper-a', 'in-flight', 'keeper-b']);
    const active = await harness.userDO.listActiveWorkspaces(owner);
    expect(active.map((entry) => entry.name)).toContain('in-flight');
    expect(await harness.userDO.hasWorkspace(owner, 'in-flight')).toBe(true);
    expect(await harness.userDO.getWorkspaceTitle(owner, 'in-flight'))
      .toEqual({ displayName: 'In flight', nameOrigin: 'user' });
    expect(await harness.userDO.setWorkspaceDisplayName(owner, 'in-flight', 'Renamed', 'user'))
      .toEqual({ applied: true });
    await harness.userDO.touchWorkspace(owner, 'in-flight');
    expect(rowOf(harness, 'in-flight')?.last_visited).toBeGreaterThan(1_500);

    // Publishing is also what gives the target its identity, so the workspace
    // can take its first turn without being opened first.
    expect(harness.installed.get('in-flight')).toMatch(/^pwc_/);
    harness.close();
  });

  test('a normal create is published the moment it lands, with no publish call', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();

    const { entry } = await harness.userDO.registerWorkspace(owner, 'ordinary', 'Ordinary');

    expect(rowOf(harness, 'ordinary')?.create_pending).toBe(0);
    expect((await harness.userDO.listWorkspaces(owner)).entries.map((row) => row.name))
      .toEqual(['ordinary']);
    expect((await harness.userDO.listWorkspaces(owner)).total).toBe(1);
    expect((await harness.userDO.listActiveWorkspaces(owner)).map((row) => row.name))
      .toEqual(['ordinary']);
    expect(await harness.userDO.hasWorkspace(owner, 'ordinary')).toBe(true);
    await expect(harness.userDO.ensureWorkspaceCapability('ordinary', null)).resolves.toBeUndefined();
    expect(await harness.userDO.getWorkspaceTitle(owner, 'ordinary'))
      .toEqual({ displayName: 'Ordinary', nameOrigin: 'user' });
    markVisited(harness, 'ordinary', entry.createdAt);
    await harness.userDO.touchWorkspace(owner, 'ordinary');
    expect(rowOf(harness, 'ordinary')?.last_visited).toBeGreaterThanOrEqual(entry.createdAt);
    harness.close();
  });
});

describe('publishWorkspaceReservation refuses anything that is not an open reservation', () => {
  test('a createdAt that is not the reservation’s', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    const reserved = await harness.userDO.reserveWorkspace(owner, 'in-flight');

    const refusal = await refusalOf(
      harness.userDO.publishWorkspaceReservation(owner, 'in-flight', reserved.entry.createdAt + 1, null),
    );
    expect(refusal.name).toBe('WorkspaceReservationNotPendingError');
    expect(refusal.message).toContain('no reservation of that name is open');

    // Refused BEFORE any identity was minted, and the row is left exactly as the
    // reservation wrote it — still invisible, still the caller's to release.
    expect(harness.installed.has('in-flight')).toBe(false);
    expect(rowOf(harness, 'in-flight')?.create_pending).toBe(1);
    expect(await harness.userDO.hasWorkspace(owner, 'in-flight')).toBe(false);
    harness.close();
  });

  test('a name nothing reserved', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();

    const refusal = await refusalOf(
      harness.userDO.publishWorkspaceReservation(owner, 'never-reserved', 1, null),
    );
    expect(refusal.name).toBe('WorkspaceReservationNotPendingError');
    expect(refusal.message).toContain('no reservation of that name is open');

    expect(rowOf(harness, 'never-reserved')).toBeNull();
    harness.close();
  });

  test('a name that is already published', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    const { entry } = await harness.userDO.registerWorkspace(owner, 'ordinary');

    const refusal = await refusalOf(
      harness.userDO.publishWorkspaceReservation(owner, 'ordinary', entry.createdAt, null),
    );
    expect(refusal.name).toBe('WorkspaceReservationNotPendingError');
    expect(refusal.message).toContain('already published');

    expect(rowOf(harness, 'ordinary')?.create_pending).toBe(0);
    harness.close();
  });
});

describe('failure cleanup still finds a pending row', () => {
  test('releaseWorkspaceReservation drops it and frees the name', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    const reserved = await harness.userDO.reserveWorkspace(owner, 'in-flight');

    expect(await harness.userDO.releaseWorkspaceReservation(owner, 'in-flight', reserved.entry.createdAt))
      .toBe(true);

    expect(rowOf(harness, 'in-flight')).toBeNull();
    const again = await harness.userDO.reserveWorkspace(owner, 'in-flight');
    expect(again.reserved).toBe(true);
    harness.close();
  });

  test('removeWorkspace tears it down and frees the name', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.reserveWorkspace(owner, 'in-flight');

    await harness.userDO.removeWorkspace(owner, 'in-flight', USER_ID);

    expect(rowOf(harness, 'in-flight')).toBeNull();
    expect(harness.destroyedWorkspaces).toContain('in-flight');
    const again = await harness.userDO.reserveWorkspace(owner, 'in-flight');
    expect(again.reserved).toBe(true);
    harness.close();
  });
});
