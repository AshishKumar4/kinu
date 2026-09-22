// A registered, connected device on a real UserDO. The default responder answers
// like the daemon; without one every call hangs and consent outcomes are indistinguishable.
import * as v from 'valibot';
import {
  DEVICE_CANCEL_METHOD, type JsonValue,
} from '@kinu.run/core';
import {
  createTestUserDO, provisionTestWorkspace, testOwner,
  type DeviceFrame, type TestUserDO,
} from './user-do';
import type { UserCaller } from '@kinu.run/core';

export const WORKSPACE = 'workspace-a';

export const OTHER_WORKSPACE = 'workspace-b';

/** Answers `exec` with exit 0 and the toolchain probe with nothing found. A
 *  cancellation answer echoes its request, tying it to that command. */
export function daemon(frame: DeviceFrame): JsonValue {
  if (frame.method === 'which') return { present: [] };

  if (frame.method === DEVICE_CANCEL_METHOD) {
    return { requestId: v.parse(v.string(), frame.params[0]), cancelled: 'terminated' };
  }

  return { stdout: 'ok', stderr: '', exitCode: 0 };
}

export interface DeviceHarness extends TestUserDO {
  deviceId: string;
  workspace: UserCaller;
  sibling: UserCaller;
  closeDeviceHarness(): Promise<void>;
}

/** Answer now, or later to hold a command's result open across its cancellation. */
export type DeviceResponder = (frame: DeviceFrame) => JsonValue | Promise<JsonValue>;

/** What a current daemon reports on connect (sandbox proof, agent-home root);
 *  without it the hub refuses to run commands. */
export const CAPABLE_HELLO = {
  type: 'HELLO',
  os: 'linux',
  hostname: 'studio',
  agentRoot: '/home/ashish/.kinu/agents',
  sandbox: { capability: 'sandboxed', reason: null, gpu: [] },
} satisfies JsonValue;

export interface DeviceHarnessOptions {
  /** What the daemon says on connect; `null` sends nothing. */
  hello?: JsonValue | null;
}

/** A connected device with two workspaces holding real capability tokens; the
 *  `registerDevice` id is attached to the live socket, so grant and hub share the row. */
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
