// The device fleet at the hub: TWO fake daemons connected at once, both
// answering identification, and every claim the fleet model makes checked
// against what the hub actually does — which machine a frame reached, what
// the snapshot says, which grant answered, and what the model is told.
//
// The bug this pins: with two machines live, the hub used to route every call
// that named no device to the FIRST live socket in `ctx.getWebSockets()`
// order — an order the platform, not the hub, decides — so two calls in one
// turn could land on different machines, and the "connected device" the
// snapshot described took turns being either one.
import { describe, expect, test } from 'bun:test';
import {
  DEVICE_CONSENT_DENIED, SEVERAL_DEVICES_CONNECTED, NO_DEVICE_CONNECTED,
  DynamicContextLedger, connectedDevices, deviceFleetAsk, renderDynamicContextBlock,
  isDeviceAmbiguityError, isDeviceNotConnectedError,
  type DeviceFleetEntry, type DeviceStatus, type DynamicContext, type JsonValue,
} from '@kinu.run/core';
import {
  createTestUserDO, provisionTestWorkspace, testOwner,
  type DeviceFrame, type FakeDaemon, type TestUserDO,
} from './helpers/user-do';
import type { UserCaller } from '../src/user/workspace-capability';
import { createHubDeviceTransport } from '../src/device-transport';

const WORKSPACE = 'workspace-a';

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
  const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
  return Object.assign(harness, {
    owner,
    workspace: { workspaceToken: token } satisfies UserCaller,
    mac, rig, macId, rigId,
    end: async () => { await harness.joinFibers(); harness.close(); },
  });
}

const byName = (devices: readonly DeviceFleetEntry[] | undefined, name: string): DeviceFleetEntry | undefined =>
  devices?.find((device) => device.name === name);

describe('two daemons connected at once', () => {
  test('both machines are visible by name, platform and liveness, and each answers for itself', async () => {
    const fleet = await twoDaemons();
    const status = await fleet.userDO.deviceRuntimeStatus(fleet.workspace);

    expect(status.connected).toBe(true);
    expect(connectedDevices(status.devices).map((d) => d.name).sort()).toEqual(['ashish@mac', 'mrwhite@rig']);
    const mac = byName(status.devices, 'ashish@mac');
    const rig = byName(status.devices, 'mrwhite@rig');
    expect(mac).toMatchObject({ id: fleet.macId, os: 'darwin', hostname: 'mac', connected: true, granted: false });
    expect(rig).toMatchObject({ id: fleet.rigId, os: 'linux', hostname: 'rig', connected: true, granted: false });
    // Reach is PER MACHINE: each entry carries its own sandbox and home, and
    // the GPU one machine has is not claimed for the other.
    expect(mac?.sandbox?.gpu).toEqual([]);
    expect(rig?.sandbox?.gpu).toEqual(['/dev/nvidia0']);
    expect(mac?.sandbox?.agentHome).toBe(`/Users/ashish/.kinu/agents/${WORKSPACE}/home`);
    expect(rig?.sandbox?.agentHome).toBe(`/home/mrwhite/.kinu/agents/${WORKSPACE}/home`);
    expect(mac?.consentedRoot).toBe('/Users/ashish/work');
    expect(rig?.consentedRoot).toBe('/home/mrwhite/work');
    // Both answered identification — the toolchain probe reached each socket.
    expect(fleet.mac.frames.map((f) => f.method)).toEqual(['which']);
    expect(fleet.rig.frames.map((f) => f.method)).toEqual(['which']);
    // No single "the connected device" exists for two: the one-machine fields
    // are absent rather than describing whichever came first.
    expect(status.workspaceGranted).toBeUndefined();
    expect(status.sandbox).toBeUndefined();
    expect(status.consentedRoot).toBeUndefined();
    await fleet.end();
  });

  test('a command addressed to one machine lands on it, and the other is untouched', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'once';

    const answer = await fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['uname -a'], {
      agentName: WORKSPACE, deviceId: fleet.rigId,
    });

    expect(JSON.parse(answer ?? 'null')).toMatchObject({ stdout: `ran on ${fleet.rigId}` });
    expect(fleet.rig.frames.filter((f) => f.method === 'exec')).toHaveLength(1);
    expect(fleet.mac.frames.filter((f) => f.method === 'exec')).toHaveLength(0);
    // The frame that reached the rig SAYS which machine it is for: the id
    // travels with every tunnel frame the hub sends, the identification probe
    // included, so the wire is self-describing to anything that reads it.
    const exec = fleet.rig.frames.find((f) => f.method === 'exec');
    expect(exec?.deviceId).toBe(fleet.rigId);
    expect(fleet.rig.frames.every((f) => f.deviceId === fleet.rigId)).toBe(true);
    expect(fleet.mac.frames.every((f) => f.deviceId === fleet.macId)).toBe(true);
    // The sandbox frame is the RIG's, never the mac's: the machine's own home.
    expect(exec?.sandbox).toMatchObject({ agentHome: `/home/mrwhite/.kinu/agents/${WORKSPACE}/home` });
    await fleet.end();
  });

  test('a command that names no machine is refused with the classified ask, and reaches neither', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'once';

    let refused: unknown;
    try {
      await fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['make'], { agentName: WORKSPACE });
    } catch (caught) { refused = caught; }

    expect(refused).toBeInstanceOf(Error);
    const message = refused instanceof Error ? refused.message : '';
    expect(message).toStartWith(SEVERAL_DEVICES_CONNECTED);
    expect(message).toContain('ashish@mac');
    expect(message).toContain('mrwhite@rig');
    // Not a "no device" condition — machines ARE connected — and no id leaks.
    expect(message).not.toContain(NO_DEVICE_CONNECTED);
    expect(message).not.toContain('dev-');
    expect(fleet.mac.frames.filter((f) => f.method === 'exec')).toHaveLength(0);
    expect(fleet.rig.frames.filter((f) => f.method === 'exec')).toHaveLength(0);
    // No consent card was raised for a call that never chose a machine.
    expect(fleet.consentPrompts).toEqual([]);

    // The checkpoint plane's device-less read gets the same answer, and the
    // matcher the orchestrator's availability arm branches on recognises it.
    let statusRefused: unknown;
    try {
      await fleet.userDO.deviceRpc(fleet.workspace, 'checkpointStatus', []);
    } catch (caught) { statusRefused = caught; }
    expect(isDeviceAmbiguityError(statusRefused)).toBe(true);
    expect(isDeviceNotConnectedError(statusRefused)).toBe(false);
    expect(fleet.consentPrompts).toEqual([]);
    await fleet.end();
  });

  test('through the transport, the ask reaches the executor as the caller\'s bad_input', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'once';
    const transport = createHubDeviceTransport({
      hub: () => fleet.userDO,
      caller: async () => fleet.workspace,
      agentName: WORKSPACE,
      cliCwd: () => null,
    });

    await expect(transport.rpc('exec', ['make'])).rejects.toMatchObject({ code: 'bad_input' });
    // And named, it goes through — with the id on the hub-side options.
    expect(await transport.rpc('exec', ['make'], { deviceId: fleet.macId }))
      .toMatchObject({ stdout: `ran on ${fleet.macId}` });
    await fleet.end();
  });

  test('one machine leaving keeps the other working, with no flap in between', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'once';

    // Both live: the fleet reads the same twice — no order-dependent pick.
    const first = await fleet.userDO.deviceRuntimeStatus(fleet.workspace);
    const second = await fleet.userDO.deviceRuntimeStatus(fleet.workspace);
    expect(second.devices).toEqual(first.devices);

    await fleet.rig.close();

    // The mac keeps answering, named or not: with one machine live there is
    // nothing to be ambiguous about, so the unnamed call is it.
    const named = await fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['pwd'], { agentName: WORKSPACE, deviceId: fleet.macId });
    const unnamed = await fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['pwd'], { agentName: WORKSPACE });
    expect(JSON.parse(named ?? 'null')).toMatchObject({ stdout: `ran on ${fleet.macId}` });
    expect(JSON.parse(unnamed ?? 'null')).toMatchObject({ stdout: `ran on ${fleet.macId}` });
    expect(fleet.rig.frames.filter((f) => f.method === 'exec')).toHaveLength(0);

    // And the snapshot says exactly that: the rig is registered and offline,
    // the mac is the one live machine, and the one-machine fields describe it.
    const after = await fleet.userDO.deviceRuntimeStatus(fleet.workspace);
    expect(byName(after.devices, 'mrwhite@rig')).toMatchObject({ connected: false });
    expect(byName(after.devices, 'ashish@mac')).toMatchObject({ connected: true });
    expect(after.consentedRoot).toBe('/Users/ashish/work');
    // A command to the machine that left is a stated absence, not a re-route.
    await expect(fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['pwd'], { agentName: WORKSPACE, deviceId: fleet.rigId }))
      .rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(fleet.mac.frames.filter((f) => f.method === 'exec')).toHaveLength(2);
    await fleet.end();
  });

  test('the grant matrix holds per (workspace, device)', async () => {
    const fleet = await twoDaemons();

    // Grant the workspace on the MAC only, by answering its card "always".
    fleet.consentDecision = 'always';
    await fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['ls'], { agentName: WORKSPACE, deviceId: fleet.macId });
    expect(fleet.consentPrompts).toHaveLength(1);

    // The mac now runs without asking; the rig asks, and a refusal there is
    // the rig's alone.
    fleet.consentDecision = 'deny';
    await fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['ls'], { agentName: WORKSPACE, deviceId: fleet.macId });
    expect(fleet.consentPrompts).toHaveLength(1);
    await expect(fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['ls'], { agentName: WORKSPACE, deviceId: fleet.rigId }))
      .rejects.toThrow(DEVICE_CONSENT_DENIED);
    expect(fleet.consentPrompts).toHaveLength(2);
    expect(fleet.rig.frames.filter((f) => f.method === 'exec')).toHaveLength(0);
    expect(fleet.mac.frames.filter((f) => f.method === 'exec')).toHaveLength(2);

    // The snapshot says the same, per machine.
    const status = await fleet.userDO.deviceRuntimeStatus(fleet.workspace);
    expect(byName(status.devices, 'ashish@mac')?.granted).toBe(true);
    expect(byName(status.devices, 'mrwhite@rig')?.granted).toBe(false);

    // Revoking the mac's binding touches the mac only: it asks again, the rig
    // is exactly where it was.
    expect(await fleet.userDO.revokeDeviceConsent(fleet.owner, WORKSPACE, fleet.macId)).toEqual({ ok: true });
    await expect(fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['ls'], { agentName: WORKSPACE, deviceId: fleet.macId }))
      .rejects.toThrow(DEVICE_CONSENT_DENIED);
    expect(fleet.consentPrompts).toHaveLength(3);
    expect(await fleet.userDO.listDeviceConsents(fleet.owner)).toEqual([]);
    await fleet.end();
  });

  test('the file view scope is the named machine\'s own', async () => {
    const fleet = await twoDaemons();

    // Two machines, two rows, two switches. Both confined by default.
    expect(await fleet.userDO.getDeviceFileView(fleet.workspace, WORKSPACE, fleet.macId)).toEqual({ unconfined: false });
    // Asked about no machine while two are live: the closed answer, never a pick.
    expect(await fleet.userDO.getDeviceFileView(fleet.workspace, WORKSPACE)).toEqual({ unconfined: false });
    await fleet.end();
  });
});

describe('what the model is told', () => {
  /** The executor row plus the fleet, as the dynamic-context block renders
   *  them from a hub snapshot — the same two inputs both backends assemble
   *  (state/dynamic-context.ts reads the fleet off the transport's snapshot). */
  function context(status: DeviceStatus): DynamicContext {
    return {
      executors: [{
        name: 'laptop', kind: 'laptop', available: status.connected, configured: status.registered,
        active: status.connected, status: status.connected ? 'active' : 'disconnected',
      }],
      devices: status.devices,
    };
  }
  const render = (status: DeviceStatus): string => renderDynamicContextBlock(context(status)) ?? '';

  test('the fleet is named once, with platform, liveness, files and grant per machine', async () => {
    const fleet = await twoDaemons();
    fleet.consentDecision = 'always';
    await fleet.userDO.deviceRpc(fleet.workspace, 'exec', ['ls'], { agentName: WORKSPACE, deviceId: fleet.macId });

    const block = render(await fleet.userDO.deviceRuntimeStatus(fleet.workspace));

    expect(block).toContain("## Your user's machines (the `laptop` runtime)");
    expect(block).toContain('Several machines are connected: name the machine');
    expect(block).toContain('- ashish@mac (darwin): connected, files at /pc/ashish@mac, this workspace holds its grant');
    expect(block).toContain('- mrwhite@rig (linux): connected, files at /pc/mrwhite@rig, no grant yet for this workspace');
    // Each machine's own sandbox and toolchain, not the other's.
    expect(block).toContain('GPU: nvidia0');
    expect(block).toContain('agent home /home/mrwhite/.kinu/agents/workspace-a/home');
    expect(block).toContain('agent home /Users/ashish/.kinu/agents/workspace-a/home');
    expect(block).toContain('runs: javascript');
    // Each name appears in the roster exactly once — told once, not per row
    // of some other section.
    expect(block.split('ashish@mac (darwin)')).toHaveLength(2);
    expect(block.split('mrwhite@rig (linux)')).toHaveLength(2);
    // No id and no socket detail reaches the model.
    expect(block).not.toContain('dev-');
    await fleet.end();
  });

  test('two renders of one fleet are one block: the ledger does not flap', async () => {
    const fleet = await twoDaemons();
    const ledger = new DynamicContextLedger();
    const status = async () => fleet.userDO.deviceRuntimeStatus(fleet.workspace);
    const snapshot = async () => render(await status());

    const first = await snapshot();
    const second = await snapshot();
    expect(second).toBe(first);
    // The ledger's own rule — append only when the render differs — sees one
    // block across two steps of an unchanged fleet.
    ledger.weave([], context(await status()));
    ledger.weave([], context(await status()));
    expect(ledger.size).toBe(1);

    // A machine leaving IS a change, and is said once: the rig reads as
    // registered and offline, the mac keeps its line, and the doctrine drops
    // to the one-machine rule.
    await fleet.rig.close();
    const after = await snapshot();
    expect(after).not.toBe(first);
    expect(after).toContain('- mrwhite@rig (linux): registered, offline');
    expect(after).toContain('- ashish@mac (darwin): connected, files at /pc,');
    expect(after).toContain('One machine is connected');
    expect(await snapshot()).toBe(after);
    await fleet.end();
  });

  test('the roster and the refusal speak the same words', async () => {
    const fleet = await twoDaemons();
    const status = await fleet.userDO.deviceRuntimeStatus(fleet.workspace);
    // The ask a refused call carries names exactly the machines the roster
    // lists as connected, in the roster's order, with the same platforms —
    // fleet order (registration, newest first), the hub's own answer to
    // "which machines". Written from the snapshot's entries so the test
    // cannot hand-write the order wrong.
    const expected = `name the machine this command runs on — connected: ${
      connectedDevices(status.devices).map((d) => `${d.name} (${d.os})`).join(', ')
    }. Pass it as device: "<name>".`;
    expect(deviceFleetAsk(status.devices)).toBe(expected);
    // Both machines are named; their relative order is registration order
    // (created_at DESC, id ASC on ties), which is run-dependent and not the
    // contract — the contract is that roster and refusal speak the same words.
    expect(expected).toContain('mrwhite@rig (linux)');
    expect(expected).toContain('ashish@mac (darwin)');
    await fleet.end();
  });
});
