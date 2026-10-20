// The control plane's index of an account's workspaces is fed by the registry itself. Only the operator's own removal
// tombstoned its row, so an ordinary DELETE left it live and inflated the operator's overview until a reconcile, and a
// rename never reached the indexed title.
import { expect, test } from 'bun:test';
import type { IndexFeedSink } from '../src/control-plane/index-feed';
import { createTestUserDO, testOwner } from './helpers/user-do';

const OWNER = 'abcdef0123456789abcdef0123456789';

/** A control plane that says, in order, what the account's registry told its index. */
interface RecordingControlPlane {
  readonly told: string[];
  readonly sink: IndexFeedSink;
}

function recordingControlPlane(): RecordingControlPlane {
  const told: string[] = [];

  return {
    told,
    sink: {
      async observeUser() {},
      async touchWorkspace() {},
      async observeWorkspace(_caller, row) { told.push(`observe ${row.userId}/${row.name} "${row.displayName}"`); },
      async forgetWorkspace(_caller, row) { told.push(`forget ${row.userId}/${row.name}`); },
    },
  };
}

test('a workspace the registry removes leaves the index, whichever entrance asked for the removal', async () => {
  const plane = recordingControlPlane();
  const harness = createTestUserDO({ durableObjectId: OWNER, controlPlane: plane.sink });
  const owner = await testOwner();

  await harness.userDO.registerWorkspace(owner, 'bakery');
  await harness.userDO.removeWorkspace(owner, 'bakery', OWNER);

  expect(plane.told).toEqual([`forget ${OWNER}/bakery`]);
  harness.close();
});

test('a released reservation leaves the index too', async () => {
  const plane = recordingControlPlane();
  const harness = createTestUserDO({ durableObjectId: OWNER, controlPlane: plane.sink });
  const owner = await testOwner();

  await harness.userDO.registerWorkspace(owner, 'bakery');
  const [entry] = (await harness.userDO.listWorkspaces(owner)).entries;

  expect(await harness.userDO.releaseWorkspaceReservation(owner, 'bakery', entry?.createdAt ?? -1)).toBe(true);
  expect(plane.told).toEqual([`forget ${OWNER}/bakery`]);
  harness.close();
});

test("a rename gives the index the registry's new title", async () => {
  const plane = recordingControlPlane();
  const harness = createTestUserDO({ durableObjectId: OWNER, controlPlane: plane.sink });
  const owner = await testOwner();

  await harness.userDO.registerWorkspace(owner, 'bakery');

  expect(await harness.userDO.setWorkspaceDisplayName(owner, 'bakery', 'Flour & Hearth', 'user')).toEqual({ applied: true });
  expect(plane.told).toEqual([`observe ${OWNER}/bakery "Flour & Hearth"`]);
  harness.close();
});
