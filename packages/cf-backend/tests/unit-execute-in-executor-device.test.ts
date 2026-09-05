// executeInExecutor carries the machine: with two live devices an unnamed
// laptop call is refused with the fleet ask and raises no card, while a call
// that names its machine raises that machine's card and runs there.
//
// The first-run two-machines case grants each machine through this RPC. Its
// raise named no machine, so with two live the fleet refused it locally, the
// refusal string parsed as a success, and the grant read as "no device consent
// card was ever raised". The contract (docs/EXECUTION-LAYER-SPEC.md "The
// user's account is a fleet", AGENTS.md § Execution Layer) says every laptop
// call names its machine when several are live — so the RPC must carry the
// name through to the tool context the tunnel executor reads.
import { describe, expect, test } from 'bun:test';
import { createDeviceTunnelExecutor, type JsonValue } from '@kinu.run/core';
import {
  createTestUserDO, provisionTestWorkspace, testOwner,
  type DeviceFrame, type FakeDaemon, type TestUserDO,
} from './helpers/user-do';
import type { UserCaller } from '../src/user/workspace-capability';
import { createHubDeviceTransport } from '../src/device-transport';
import { orchestratorHarness } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';

const WORKSPACE = 'workspace-exec-device';

/** The daemon answers identification (`which`) and runs a command with an
 *  exit-0 result that SAYS which machine ran it, so a routing claim is read
 *  off the answer and not inferred from the frame log alone. */
function daemonOn(frame: DeviceFrame): JsonValue {
  if (frame.method === 'which') return { present: ['node'] };
  return { stdout: `ran on ${frame.device ?? 'unknown'}`, stderr: '', exitCode: 0 };
}

interface Fleet extends TestUserDO {
  readonly owner: UserCaller;
  readonly workspace: UserCaller;
  readonly mac: FakeDaemon;
  readonly rig: FakeDaemon;
  readonly macId: string;
  readonly rigId: string;
  end(): Promise<void>;
}

/** Two machines registered and LIVE at once, each having said HELLO with its
 *  own platform, exactly as the owner's Mac and Linux PC did. */
async function twoDaemons(): Promise<Fleet> {
  const harness = createTestUserDO({ deviceResponder: daemonOn });
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
    mac, rig, macId, rigId,
    end: async () => { await harness.joinFibers(); harness.close(); },
  });
}

/** A real orchestrator whose laptop executor rides the fleet above: the
 *  production RPC, executor, transport and hub over fake sockets. */
async function orchestratorOnFleet(fleet: Fleet) {
  const transport = createHubDeviceTransport({
    hub: () => fleet.userDO,
    caller: async () => fleet.workspace,
    agentName: WORKSPACE,
    cliCwd: () => null,
  });
  await transport.refreshStatus();
  const harness = orchestratorHarness();
  const router = harness.agent.observeRuntime().executionRouter;
  if (!router) throw new Error('the harness runtime has no execution router');
  router.register(createDeviceTunnelExecutor(transport));
  // Let the harness activation's DDL land before the RPC writes its row.
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

    const answer = await agent.executeInExecutor('laptop', 'true');
    if (!('stdout' in answer)) throw new Error(`expected a tool answer, got ${JSON.stringify(answer)}`);
    // The ask names both machines, and says a name is required.
    expect(answer.stdout).toContain('ashish@mac');
    expect(answer.stdout).toContain('mrwhite@rig');
    expect(answer.stdout).toContain('device:');
    // Refused before the hub: no card, no frame on either machine.
    expect(fleet.consentPrompts).toEqual([]);
    expect(execFrames(fleet.mac)).toHaveLength(0);
    expect(execFrames(fleet.rig)).toHaveLength(0);
    await fleet.end();
  });

  test('named raises that machine\'s card and runs there, leaving the other alone', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'always';
    const agent = await orchestratorOnFleet(fleet);

    const answer = await agent.executeInExecutor('laptop', 'true', 'mrwhite@rig');
    if (!('stdout' in answer)) throw new Error(`expected a tool answer, got ${JSON.stringify(answer)}`);
    expect(answer.stdout).toContain(`ran on ${fleet.rigId}`);
    expect(fleet.consentPrompts).toHaveLength(1);
    expect(execFrames(fleet.rig)).toHaveLength(1);
    expect(execFrames(fleet.mac)).toHaveLength(0);
    // The grant is per (workspace, device): the rig is bound, the mac is not.
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

    await agent.executeInExecutor('laptop', 'true', 'ashish@mac');
    const answer = await agent.executeInExecutor('laptop', 'true', 'mrwhite@rig');
    if (!('stdout' in answer)) throw new Error(`expected a tool answer, got ${JSON.stringify(answer)}`);
    expect(answer.stdout).toContain(`ran on ${fleet.rigId}`);
    // One card per machine, not one shared grant.
    expect(fleet.consentPrompts).toHaveLength(2);
    const grants = await fleet.userDO.listDeviceConsents(fleet.owner);
    expect(grants.filter((grant) => grant.policy === 'allow')).toHaveLength(2);
    await fleet.end();
  });
});
