import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  nextDeviceRequestId, isDeviceNotConnectedError, isWorkspaceUnattachedError,
  NO_DEVICE_CONNECTED, WORKSPACE_HAS_NO_OWNER, type DeviceStatus, type JsonValue,
} from '@kinu.run/core';
import {
  createHubDeviceTransport,
  type DeviceHubClient,
  type DeviceRpcOptions,
} from '@kinu.run/core';
import type { UserCaller } from '@kinu.run/core';
import { handClock } from '@kinu.run/test-utils';

const FAKE_CALLER = { workspaceToken: 'pwc_test' } as const;

const caller = async () => FAKE_CALLER;

type RpcCall = [method: string, params: JsonValue[], opts: DeviceRpcOptions | undefined, caller: UserCaller];

function fakeHub(status: () => DeviceStatus): DeviceHubClient & { rpcCalls: RpcCall[] } {
  const rpcCalls: RpcCall[] = [];

  return {
    rpcCalls,
    deviceRuntimeStatus: async () => status(),
    deviceRpc: async (rpcCaller, method, params, opts) => {
      rpcCalls.push([method, params, opts, rpcCaller]);

      return JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0 });
    },
    acknowledgeDeviceRequest: async () => {},
  };
}

const NO_DEVICE: DeviceStatus = { connected: false, registered: false, toolchain: null };

function requiredCall(calls: RpcCall[], index: number): RpcCall {
  const call = calls[index];

  if (!call) throw new Error(`expected RPC call ${index}`);

  return call;
}


describe('createHubDeviceTransport', () => {
  test('refreshStatus is authoritative: a device that connected mid-session becomes visible', async () => {
    let connected = false;

    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => fakeHub(() => ({ connected, registered: true, toolchain: null })),
      caller,
      agentName: 'agent-1',
      cliCwd: () => null,
    });

    expect((await transport.refreshStatus())).toEqual({ connected: false, registered: true, toolchain: null });
    connected = true; // the user runs `kinu connect` between turns
    expect((await transport.refreshStatus())).toEqual({ connected: true, registered: true, toolchain: null });
    expect(transport.status().connected).toBe(true);
  });

  test('status() serves the cached snapshot inside the TTL without re-querying the hub', async () => {
    let listCalls = 0;

    const hub: DeviceHubClient = {
      deviceRuntimeStatus: async () => {
        listCalls += 1;

        return { connected: true, registered: true, toolchain: null };
      },
      deviceRpc: async () => 'unused',
      acknowledgeDeviceRequest: async () => {},
    };

    const clock = handClock();
    // The caller is resolved synchronously in the kick; the hub list comes one await later.
    let callerCalls = 0;

    const transport = createHubDeviceTransport({
      clock,
      hub: () => hub, agentName: 'agent-1', cliCwd: () => null,
      caller: () => {
        callerCalls += 1;

        return caller();
      },
    });

    await transport.refreshStatus();
    expect(listCalls).toBe(1);
    transport.status();
    transport.status();
    expect(callerCalls).toBe(1);        // fresh — no background re-check
    // Past the status TTL, on the transport's own clock.
    clock.advance(5_100);
    transport.status();                 // stale — kicks ONE background re-check
    transport.status();
    // Read before `refreshStatus`, which would start its own re-check and hide a missing kick.
    expect(callerCalls).toBe(2);
    // `refreshStatus` dedupes against the in-flight re-check.
    await transport.refreshStatus();
    expect(listCalls).toBe(2);
    expect(callerCalls).toBe(2);
  });

  test('no owner hub → the workspace is unattached, which is not an unlinked machine', async () => {
    // A null hub means no owner id resolved; `kinu connect` guidance would be wrong.
    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => null, agentName: 'agent-1', cliCwd: () => null,
      caller,
    });

    expect(await transport.refreshStatus()).toEqual({ connected: false, registered: false, toolchain: null });
    const refusal = transport.rpc('exec', ['ls']);
    await expect(refusal).rejects.toThrow(WORKSPACE_HAS_NO_OWNER);
    await expect(refusal).rejects.not.toThrow(/kinu connect/);
    let unattached: Error | null = null;

    try { await transport.rpc('exec', ['ls']); }
    catch (caught) { unattached = caught instanceof Error ? caught : new Error(String(caught)); }

    expect(isDeviceNotConnectedError({ cause: unattached })).toBe(true);
    expect(isWorkspaceUnattachedError({ cause: unattached })).toBe(true);

    // A hub that answers with no device must not read as unattached.
    const unlinked = createHubDeviceTransport({
      clock,
      hub: () => fakeHub(() => NO_DEVICE), agentName: 'agent-1', cliCwd: () => null, caller,
    });

    let hubRefusal: Error | null = null;

    try { await unlinked.rpc('exec', ['ls']); }
    catch (caught) { hubRefusal = caught instanceof Error ? caught : new Error(String(caught)); }

    expect(isWorkspaceUnattachedError({ cause: hubRefusal })).toBe(false);
  });

  test('rpc outcomes re-seed the snapshot: success → connected, hub rejection → offline', async () => {
    let hubUp = true;
    const hub = fakeHub(() => NO_DEVICE);

    const failingHub: DeviceHubClient = {
      deviceRuntimeStatus: async () => NO_DEVICE,
      deviceRpc: async () => { throw new Error('no device connected'); },
      acknowledgeDeviceRequest: async () => { throw new Error('no device connected'); },
    };

    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => (hubUp ? hub : failingHub),
      caller,
      agentName: 'agent-1',
      cliCwd: () => null,
    });

    await transport.rpc('exec', ['echo hi']);
    expect(transport.status()).toEqual({ connected: true, registered: true, toolchain: null });
    expect(hub.rpcCalls[0]).toMatchObject([
      'exec', ['echo hi'], { agentName: 'agent-1', requestId: expect.stringMatching(/^rpc-/) }, FAKE_CALLER,
    ]);

    hubUp = false;
    await expect(transport.rpc('exec', ['echo hi'])).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(transport.status().connected).toBe(false);
    expect(transport.status().registered).toBe(true); // connectivity changed, registration didn't
  });

  test('a device call re-proves presence without discarding what the machine answered', async () => {
    const probed: DeviceStatus = {
      connected: true,
      registered: true,
      toolchain: { present: ['javascript'], asked: ['javascript', 'python'], probedAt: Date.now() },
    };

    const hub = fakeHub(() => probed);

    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => hub, caller, agentName: 'agent-1', cliCwd: () => null,
    });

    await transport.refreshStatus();
    await transport.rpc('exec', ['echo hi']);

    // A call proves the socket, not the toolchain: it must not re-seed the snapshot.
    expect(transport.status().toolchain).toEqual(probed.toolchain);
  });

  test('the caller\'s request identity is forwarded, not dropped or replaced', async () => {
    // This seam rewrites `exec` params; a lost id is a command nothing can cancel.
    const hub = fakeHub(() => ({ connected: true, registered: true, toolchain: null }));

    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => hub, caller, agentName: 'agent-1', cliCwd: () => '/home/me/project',
    });

    const requestId = nextDeviceRequestId();

    await transport.rpc('exec', ['make'], { timeoutMs: 0, requestId });

    const [method, params, opts] = requiredCall(hub.rpcCalls, 0);
    expect(method).toBe('exec');
    expect(v.parse(v.string(), params[0])).toContain('make');
    expect(opts?.requestId).toBe(requestId);
    // No handle sent: the tunnel mints its own.
    await transport.rpc('readFile', ['/home/me/project/readme.md']);
    expect(requiredCall(hub.rpcCalls, 1)[2]?.requestId).toBeUndefined();
  });

  test('mutating methods carry the pre-mutation checkpoint hint; reads do not', async () => {
    const hub = fakeHub(() => ({ connected: true, registered: true, toolchain: null }));

    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => hub,
      caller,
      agentName: 'agent-1',
      cliCwd: () => '/home/u/proj',
      checkpointMeta: () => ({ turnId: 'msg-42', sessionId: 'default' }),
    });

    await transport.rpc('exec', ['make build']);
    await transport.rpc('writeFile', ['/home/u/proj/a.txt', 'data']);
    await transport.rpc('readFile', ['/home/u/proj/a.txt']);

    expect(requiredCall(hub.rpcCalls, 0)[2]?.checkpoint).toEqual({
      agent: 'agent-1', turnId: 'msg-42', sessionId: 'default', dir: '/home/u/proj',
    });
    expect(requiredCall(hub.rpcCalls, 1)[2]?.checkpoint).toEqual({
      agent: 'agent-1', turnId: 'msg-42', sessionId: 'default', dir: null, // daemon derives from the path
    });
    expect(requiredCall(hub.rpcCalls, 2)[2]?.checkpoint).toBeUndefined();
  });

  test('no checkpoint hint outside a turn or when the meta seam is unwired', async () => {
    const hub = fakeHub(() => ({ connected: true, registered: true, toolchain: null }));
    const unwired = createHubDeviceTransport({ hub: () => hub, caller, agentName: 'a', cliCwd: () => null, clock: handClock() });
    await unwired.rpc('exec', ['ls']);
    expect(requiredCall(hub.rpcCalls, 0)[2]?.checkpoint).toBeUndefined();

    const clock = handClock();

    const outsideTurn = createHubDeviceTransport({
      clock,
      hub: () => hub, agentName: 'a', cliCwd: () => null, checkpointMeta: () => null,
      caller,
    });

    await outsideTurn.rpc('writeFile', ['/x', 'y']);
    expect(requiredCall(hub.rpcCalls, 1)[2]?.checkpoint).toBeUndefined();
  });

  test('exec calls are rewritten into the CLI-forwarded working directory', async () => {
    const hub = fakeHub(() => ({ connected: true, registered: true, toolchain: null }));

    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => hub, agentName: 'agent-1', cliCwd: () => "/home/u/my proj",
      caller,
    });

    await transport.rpc('exec', ['git status']);
    await transport.rpc('readFile', ['/tmp/a']);
    expect(hub.rpcCalls.map((c) => c[3])).toEqual([FAKE_CALLER, FAKE_CALLER]);
    expect(hub.rpcCalls[0]?.[1]).toEqual(["cd '/home/u/my proj' && git status"]);
    expect(hub.rpcCalls[1]?.[1]).toEqual(['/tmp/a']); // only exec is cwd-rewritten
  });

  // A workspace shared with a second human has no device plane: "no device", not a crash.
  test('a hub that refuses this workspace reads as no device, and calls surface the reason', async () => {
    const denial = () => { throw new Error('"device.rpc" is not available to a shared workspace.'); };

    const denying: DeviceHubClient = {
      deviceRuntimeStatus: async () => denial(),
      deviceRpc: async () => denial(),
      acknowledgeDeviceRequest: async () => denial(),
    };

    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => denying, caller, agentName: 'agent-1', cliCwd: () => null,
    });

    expect(await transport.refreshStatus()).toEqual({ connected: false, registered: false, toolchain: null });
    expect(transport.status()).toEqual({ connected: false, registered: false, toolchain: null });
    await expect(transport.rpc('exec', ['ls'])).rejects.toThrow('not available to a shared workspace');
  });

  test('a workspace with no capability token reads as no device rather than throwing at turn start', async () => {
    const clock = handClock();

    const transport = createHubDeviceTransport({
      clock,
      hub: () => fakeHub(() => ({ connected: true, registered: true, toolchain: null })),
      caller: async () => { throw new Error('This workspace has not been issued a capability token yet.'); },
      agentName: 'agent-1',
      cliCwd: () => null,
    });

    // beforeTurn awaits this on every turn; it must never be what fails a turn.
    expect(await transport.refreshStatus()).toEqual({ connected: false, registered: false, toolchain: null });
    await expect(transport.rpc('exec', ['ls'])).rejects.toThrow('capability token');
  });
});
