// executeInExecutor carries the machine name through to the tunnel executor. Defends the first-run
// two-machines grant: an unnamed raise was refused locally and parsed as success, so no card was raised
// (docs/EXECUTION-LAYER-SPEC.md "The user's account is a fleet").
import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '@kinu.run/core';
import {
  createTestUserDO, provisionTestWorkspace, testOwner,
  type DeviceFrame, type FakeDaemon, type TestUserDO,
} from './helpers/user-do';
import type { UserCaller } from '@kinu.run/core';
import { chatSessionTurns, orchestratorHarness } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';

const WORKSPACE = 'workspace-exec-device';

const OWNER_USER_ID = '0123456789abcdef0123456789abcdef';

/** The answer names the machine that ran it, so routing is read off the answer, not the frame log. */
function daemonOn(frame: DeviceFrame): JsonValue {
  if (frame.method === 'which') return { present: ['node'] };

  return { stdout: `ran on ${frame.device ?? 'unknown'}`, stderr: '', exitCode: 0 };
}

interface Fleet extends TestUserDO {
  readonly owner: UserCaller;
  readonly workspace: UserCaller;
  /** The workspace's capability, as the actor holds it. */
  readonly token: string;
  readonly mac: FakeDaemon;
  readonly rig: FakeDaemon;
  readonly macId: string;
  readonly rigId: string;
  end(): Promise<void>;
}

async function twoDaemons(): Promise<Fleet> {
  const harness = createTestUserDO({ deviceResponder: daemonOn, durableObjectId: OWNER_USER_ID });
  const owner = await testOwner();
  const { deviceId: macId } = await harness.userDO.registerDevice(owner, 'ashish@mac');
  const { deviceId: rigId } = await harness.userDO.registerDevice(owner, 'mrwhite@rig');
  const mac = harness.attachDaemon(macId);
  const rig = harness.attachDaemon(rigId);
  await harness.sendDeviceHello({
    type: 'HELLO', os: 'darwin', hostname: 'mac',
    agentRoot: '/Users/ashish/.kinu/agents', root: '/Users/ashish/work', home: '/Users/ashish',
    sandbox: { capability: 'sandboxed', reason: null, gpu: [] },
  }, macId);
  await harness.sendDeviceHello({
    type: 'HELLO', os: 'linux', hostname: 'rig',
    agentRoot: '/home/mrwhite/.kinu/agents', root: '/home/mrwhite/work', home: '/home/mrwhite',
    sandbox: { capability: 'sandboxed', reason: null, gpu: ['/dev/nvidia0'] },
  }, rigId);
  const token = await provisionTestWorkspace(harness, WORKSPACE, 'Exec Device');

  return Object.assign(harness, {
    owner,
    workspace: { workspaceToken: token } satisfies UserCaller,
    token,
    mac, rig, macId, rigId,
    end: async () => { await harness.joinFibers(); harness.close(); },
  });
}

/** The workspace's own actor over the fleet's hub, wired as production wires it. */
async function orchestratorOnFleet(fleet: Fleet) {
  const harness = orchestratorHarness(undefined, {
    userDO: fleet.userDO, workspace: WORKSPACE, ownerUserId: OWNER_USER_ID,
  });

  harness.agent.harnessHoldsCapability(fleet.token);
  // A turn's start reads the device hub, which makes both machines visible to the router.
  await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'run it on my machine' }] });

  // Let the activation's DDL land before the RPC writes its row.
  for (let tick = 0; tick < 8; tick++) await joinHarnessFibers();

  return harness.agent;
}

function execFrames(daemon: FakeDaemon): DeviceFrame[] {
  return daemon.frames.filter((frame) => frame.method === 'exec');
}

describe('executeInExecutor names its machine', () => {
  test('unnamed with two live is refused with the fleet ask, and raises no card', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'always';
    const agent = await orchestratorOnFleet(fleet);

    const answer = await agent.executeInExecutor('device', 'true');

    if (!('stdout' in answer)) throw new Error(`expected a tool answer, got ${JSON.stringify(answer)}`);
    expect(answer.stdout).toContain('ashish@mac');
    expect(answer.stdout).toContain('mrwhite@rig');
    expect(answer.stdout).toContain('device:');
    // Refused before the hub.
    expect(fleet.consentPrompts).toEqual([]);
    expect(execFrames(fleet.mac)).toHaveLength(0);
    expect(execFrames(fleet.rig)).toHaveLength(0);
    await fleet.end();
  });

  test('named raises that machine\'s card and runs there, leaving the other alone', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'always';
    const agent = await orchestratorOnFleet(fleet);

    const answer = await agent.executeInExecutor('device', 'true', 'mrwhite@rig');

    if (!('stdout' in answer)) throw new Error(`expected a tool answer, got ${JSON.stringify(answer)}`);
    expect(answer.stdout).toContain(`ran on ${fleet.rigId}`);
    expect(fleet.consentPrompts).toHaveLength(1);
    expect(execFrames(fleet.rig)).toHaveLength(1);
    expect(execFrames(fleet.mac)).toHaveLength(0);
    const grants = await fleet.userDO.listDeviceConsents(fleet.owner);
    expect(grants).toContainEqual(expect.objectContaining({
      agentName: WORKSPACE, deviceId: fleet.rigId, policy: 'allow',
    }));
    expect(grants.some((grant) => grant.deviceId === fleet.macId)).toBe(false);
    await fleet.end();
  });

  test('the second machine grants on its own card, exactly as the two-machines case needs', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'always';
    const agent = await orchestratorOnFleet(fleet);

    await agent.executeInExecutor('device', 'true', 'ashish@mac');
    const answer = await agent.executeInExecutor('device', 'true', 'mrwhite@rig');

    if (!('stdout' in answer)) throw new Error(`expected a tool answer, got ${JSON.stringify(answer)}`);
    expect(answer.stdout).toContain(`ran on ${fleet.rigId}`);
    expect(fleet.consentPrompts).toHaveLength(2);
    const grants = await fleet.userDO.listDeviceConsents(fleet.owner);
    expect(grants.filter((grant) => grant.policy === 'allow')).toHaveLength(2);
    await fleet.end();
  });
});
