// KINU-027: a reserved fork target (`create_pending = 1`) must be absent from every
// owner-visible surface until `publishWorkspaceReservation`; each surface is asserted
// on its own line beside a published control, so one missing filter cannot hide.
import { describe, expect, test } from 'bun:test';
import {
  createTestUserDO, createdWorkspace, provisionTestWorkspace, testOwner, type TestUserDO,
} from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

function rowOf(harness: TestUserDO, name: string): { create_pending: number; last_visited: number } | null {
  return harness.db.prepare<{ create_pending: number; last_visited: number }, [string]>(
    `SELECT create_pending, last_visited FROM user_workspaces WHERE name = ?`,
  ).get(name);
}

/** A fork rollback branches on the error's name: it survives DO RPC, the class does not. */
async function refusalOf(publish: Promise<void>): Promise<{ name: string; message: string }> {
  try {
    await publish;
  } catch (cause) {
    if (cause instanceof Error) return { name: cause.name, message: cause.message };

    return { name: 'a thrown non-Error', message: String(cause) };
  }

  return { name: 'no refusal at all', message: 'the publish resolved' };
}

/** A known `last_visited`, so a no-op touch is not masked by two writes in the same millisecond. */
function markVisited(harness: TestUserDO, name: string, at: number): void {
  harness.db.prepare<unknown, [number, string]>(
    `UPDATE user_workspaces SET last_visited = ? WHERE name = ?`,
  ).run(at, name);
}

/** Ordered `keeper-a`, `keeper-b` by last_visited with a gap for the row under test,
 *  so the fence (not the cursor predicate) hides it and the cursor branch is read. */
async function seedPublishedPair(harness: TestUserDO): Promise<void> {
  await provisionTestWorkspace(harness, 'keeper-b');
  await provisionTestWorkspace(harness, 'keeper-a');
  markVisited(harness, 'keeper-a', 2_000);
  markVisited(harness, 'keeper-b', 1_000);
}

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

    const list = await harness.userDO.listWorkspaces(owner);
    expect(list.entries.map((entry) => entry.name)).not.toContain('in-flight');

    expect(list.total).toBe(2);

    expect(await walkRoster(harness)).toEqual(['keeper-a', 'keeper-b']);

    // Credential invalidation and config reconcile fan out over this enumeration.
    const active = await harness.userDO.listActiveWorkspaces(owner);
    expect(active.map((entry) => entry.name)).not.toContain('in-flight');

    expect(await harness.userDO.hasWorkspace(owner, 'in-flight')).toBe(false);

    // The identity bootstrap reads that same gate: only the publish may issue a capability.
    await expect(harness.userDO.ensureWorkspaceCapability('in-flight', null))
      .rejects.toThrow('not in your registry');
    expect(harness.installed.has('in-flight')).toBe(false);

    expect(await harness.userDO.getWorkspaceTitle(owner, 'in-flight')).toBeNull();

    expect(await harness.userDO.setWorkspaceDisplayName(owner, 'in-flight', 'Renamed', 'user'))
      .toEqual({ applied: false });

    await harness.userDO.touchWorkspace(owner, 'in-flight');
    expect(rowOf(harness, 'in-flight')?.last_visited).toBe(1_500);

    harness.close();
  });

  test('a published workspace IS visible on every one of those surfaces', async () => {
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

    // Publishing also mints the target's identity, so it can take a first turn unopened.
    expect(harness.installed.get('in-flight')).toMatch(/^pwc_/);
    harness.close();
  });

  test('a normal create is published the moment it lands, with no publish call', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();

    const entry = createdWorkspace(await harness.userDO.registerWorkspace(owner, 'ordinary', 'Ordinary'));

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
    const entry = createdWorkspace(await harness.userDO.registerWorkspace(owner, 'ordinary'));

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

describe('a reservation whose transfer stopped renewing it is reclaimed', () => {
  /** Nothing renews the lease after a source-side eviction; age it to that state. */
  function expireLease(harness: TestUserDO, name: string): void {
    harness.db.prepare<unknown, [number, string]>(
      `UPDATE user_workspaces SET fork_lease_expires_at = ? WHERE name = ?`,
    ).run(Date.now() - 1_000, name);
  }

  test('a retry of the same name adopts it instead of being refused forever', async () => {
    // Defends: a source DO dying mid-transfer left `create_pending = 1` wedged and invisible.
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.reserveWorkspace(owner, 'in-flight');
    expireLease(harness, 'in-flight');

    const retry = await harness.userDO.reserveWorkspace(owner, 'in-flight');

    expect(retry.reserved).toBe(true);
    expect(harness.destroyedWorkspaces).toContain('in-flight');
    expect(rowOf(harness, 'in-flight')?.create_pending).toBe(1);
    expect(retry.entry.createdAt).toBeGreaterThanOrEqual(0);
    harness.close();
  });

  test('a LIVE reservation is still refused — a renewing transfer keeps its name', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const held = await harness.userDO.reserveWorkspace(owner, 'in-flight');

    expect((await harness.userDO.reserveWorkspace(owner, 'in-flight')).reserved).toBe(false);
    expect(harness.destroyedWorkspaces).not.toContain('in-flight');

    expect(await harness.userDO.renewWorkspaceReservation(owner, 'in-flight', held.entry.createdAt)).toBe(true);
    harness.close();
  });

  test('the owner’s own roster read frees a wedged name with no retry at all', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.reserveWorkspace(owner, 'in-flight');
    expireLease(harness, 'in-flight');

    await harness.userDO.listWorkspaces(owner);

    expect(rowOf(harness, 'in-flight')).toBeNull();
    expect(harness.destroyedWorkspaces).toContain('in-flight');
    harness.close();
  });

  test('a published workspace holds no lease, so no sweep can take it', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const reserved = await harness.userDO.reserveWorkspace(owner, 'landed');
    await harness.userDO.publishWorkspaceReservation(owner, 'landed', reserved.entry.createdAt, null);

    await harness.userDO.listWorkspaces(owner);

    expect(rowOf(harness, 'landed')?.create_pending).toBe(0);
    expect(harness.destroyedWorkspaces).not.toContain('landed');
    expect(await harness.userDO.renewWorkspaceReservation(owner, 'landed', reserved.entry.createdAt)).toBe(false);
    harness.close();
  });
});
