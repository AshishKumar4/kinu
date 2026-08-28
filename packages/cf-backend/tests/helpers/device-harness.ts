// A registered, connected device on a real UserDO — the fixture every device
// chokepoint suite drives.
//
// The device plane only tells the truth when the far end ANSWERS: without a
// responder every call hangs on a socket nobody listens to, and the difference
// between "consent let it through" and "consent did nothing" disappears. So the
// default responder answers the way the daemon does, and a suite that needs a
// misbehaving machine passes its own.
import {
  DEVICE_CANCEL_METHOD, type JsonValue,
} from '@kinu.run/core';
import {
  createTestUserDO, provisionTestWorkspace, testOwner,
  type DeviceFrame, type TestUserDO,
} from './user-do';
import type { UserCaller } from '../../src/user/workspace-capability';

export const WORKSPACE = 'workspace-a';
export const OTHER_WORKSPACE = 'workspace-b';

/** A daemon that answers `exec` with an exit-0 result and the toolchain probe
 *  with "nothing found", so a status read costs no wall clock. A cancellation
 *  answer ECHOES the request it acted on, because that echo is what makes it an
 *  answer about that command rather than about some other one. */
export function daemon(frame: DeviceFrame): JsonValue {
  if (frame.method === 'which') return { present: [] };
  if (frame.method === DEVICE_CANCEL_METHOD) {
    return { requestId: String(frame.params[0]), cancelled: 'terminated' };
  }
  return { stdout: 'ok', stderr: '', exitCode: 0 };
}

export interface DeviceHarness extends TestUserDO {
  deviceId: string;
  workspace: UserCaller;
  sibling: UserCaller;
}

/** How a machine answers this harness's frames — immediately, or later, which
 *  is how a test holds a command's result open across its cancellation. */
export type DeviceResponder = (frame: DeviceFrame) => JsonValue | Promise<JsonValue>;

/**
 * A registered device, connected, with two workspaces holding real capability
 * tokens. The id comes from `registerDevice` and is then attached to the live
 * socket, so the row the grant is keyed on is the row the hub sees.
 */
export async function deviceHarness(
  name = 'ashish@studio',
  responder: DeviceResponder = daemon,
): Promise<DeviceHarness> {
  const harness = createTestUserDO({ deviceResponder: responder });
  const { deviceId } = await harness.userDO.registerDevice(await testOwner(), name);
  harness.attachDevice(deviceId);
  const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
  const sibling = await provisionTestWorkspace(harness, OTHER_WORKSPACE, 'Workspace B');
  return Object.assign(harness, {
    deviceId,
    workspace: { workspaceToken: workspace } satisfies UserCaller,
    sibling: { workspaceToken: sibling } satisfies UserCaller,
  });
}
