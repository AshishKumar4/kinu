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
  closeDeviceHarness(): Promise<void>;
}

/** How a machine answers this harness's frames — immediately, or later, which
 *  is how a test holds a command's result open across its cancellation. */
export type DeviceResponder = (frame: DeviceFrame) => JsonValue | Promise<JsonValue>;

/** What a current daemon reports the moment its socket opens: it proved it can
 *  sandbox, and it named where it keeps agent homes. A real machine always
 *  says this, so a fixture that stays silent is not a quieter machine — it is
 *  a machine the hub correctly refuses to run commands on. */
export const CAPABLE_HELLO = {
  type: 'HELLO',
  os: 'linux',
  hostname: 'studio',
  agentRoot: '/home/ashish/.kinu/agents',
  sandbox: { capability: 'sandboxed', reason: null, gpu: [] },
} satisfies JsonValue;

export interface DeviceHarnessOptions {
  /** What the daemon says on connect. `null` sends nothing, which is how a
   *  test asks for a machine that has proved nothing. */
  hello?: JsonValue | null;
}

/**
 * A registered device, connected, with two workspaces holding real capability
 * tokens. The id comes from `registerDevice` and is then attached to the live
 * socket, so the row the grant is keyed on is the row the hub sees.
 */
export async function deviceHarness(
  name = 'ashish@studio',
  responder: DeviceResponder = daemon,
  options: DeviceHarnessOptions = {},
): Promise<DeviceHarness> {
  const harness = createTestUserDO({ deviceResponder: responder });
  const { deviceId } = await harness.userDO.registerDevice(await testOwner(), name);
  harness.attachDevice(deviceId);
  const hello = options.hello === undefined ? CAPABLE_HELLO : options.hello;
  if (hello !== null) await harness.sendDeviceHello(hello);
  const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
  const sibling = await provisionTestWorkspace(harness, OTHER_WORKSPACE, 'Workspace B');
  return Object.assign(harness, {
    deviceId,
    workspace: { workspaceToken: workspace } satisfies UserCaller,
    sibling: { workspaceToken: sibling } satisfies UserCaller,
    closeDeviceHarness: async () => {
      await harness.joinFibers();
      harness.close();
    },
  });
}
