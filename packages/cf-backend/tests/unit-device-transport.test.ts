// createHubDeviceTransport — the laptop runtime's cached/authoritative status
// over the user-level device hub. This is what beforeTurn refreshes so the
// turn's context reflects a device that connected mid-session.
import { describe, expect, test } from 'bun:test';
import {
  nextDeviceRequestId, isDeviceNotConnectedError, isWorkspaceUnattachedError,
  WORKSPACE_HAS_NO_OWNER, type DeviceStatus, type JsonValue,
} from '@kinu.run/core';
import {
  createHubDeviceTransport,
  type DeviceHubClient,
  type DeviceRpcOptions,
} from '../src/device-transport';
import type { UserCaller } from '../src/user/workspace-capability';

const FAKE_CALLER = { workspaceToken: 'pwc_test' } as const;
const caller = async () => FAKE_CALLER;

type RpcCall = [method: string, params: JsonValue[], opts: DeviceRpcOptions | undefined, caller: UserCaller];

function fakeHub(status: () => DeviceStatus): DeviceHubClient & { rpcCalls: RpcCall[] } {
  const rpcCalls: RpcCall[] = [];
  return {
    rpcCalls,
    deviceRuntimeStatus: async () => status(),
    deviceRpc: async (caller, method, params, opts) => {
      rpcCalls.push([method, params, opts, caller]);
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

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

describe('createHubDeviceTransport', () => {
  test('refreshStatus is authoritative: a device that connected mid-session becomes visible', async () => {
    let connected = false;
    const transport = createHubDeviceTransport({
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
    const transport = createHubDeviceTransport({
      hub: () => hub, agentName: 'agent-1', cliCwd: () => null,
      caller,
    });

    await transport.refreshStatus();
    expect(listCalls).toBe(1);
    transport.status();
    transport.status();
    expect(listCalls).toBe(1);          // fresh — no background re-check
    // Past the 5 s status TTL, on the wall clock: the transport reads the
    // platform clock directly, so nothing here advances it deterministically.
    // Measured 5.3 s on 2026-09-05.
    await sleep(5100);
    transport.status();                 // stale — kicks ONE background re-check
    transport.status();
    await sleep(50); // let the kicked re-check land
    expect(listCalls).toBe(2);
  // A wall-clock wait past a 5 s TTL; measured ~5.3 s in this tree.
  }, 15_000);

  test('no owner hub → the workspace is unattached, which is not an unlinked machine', async () => {
    // This pin said "rpc rejects with the connect guidance", and the guidance
    // was wrong: a null hub means the stub resolved off no owner id, so no hub
    // was asked and no device question was reached. Telling that owner to run
    // `kinu connect` sends them to re-link a machine they may already have
    // linked — which is what the first-run tier observed on a deployed build.
    const transport = createHubDeviceTransport({
      hub: () => null, agentName: 'agent-1', cliCwd: () => null,
      caller,
    });
    expect(await transport.refreshStatus()).toEqual({ connected: false, registered: false, toolchain: null });
    const refusal = transport.rpc('exec', ['ls']);
    await expect(refusal).rejects.toThrow(WORKSPACE_HAS_NO_OWNER);
    await expect(refusal).rejects.not.toThrow(/kinu connect/);
    // Handled identically by every caller — the plane is unavailable — and told
    // apart only where a person is being told what to do next.
    let unattached: Error | null = null;
    try { await transport.rpc('exec', ['ls']); }
    catch (caught) { unattached = caught instanceof Error ? caught : new Error(String(caught)); }
    expect(isDeviceNotConnectedError(unattached)).toBe(true);
    expect(isWorkspaceUnattachedError(unattached)).toBe(true);
    // The denominator: a hub that answers, with no device on it, is the OTHER
    // condition and must not read as unattached.
    const unlinked = createHubDeviceTransport({
      hub: () => fakeHub(() => NO_DEVICE), agentName: 'agent-1', cliCwd: () => null, caller,
    });
    let hubRefusal: Error | null = null;
    try { await unlinked.rpc('exec', ['ls']); }
    catch (caught) { hubRefusal = caught instanceof Error ? caught : new Error(String(caught)); }
    expect(isWorkspaceUnattachedError(hubRefusal)).toBe(false);
  });

  test('rpc outcomes re-seed the snapshot: success → connected, hub rejection → offline', async () => {
    let hubUp = true;
    const hub = fakeHub(() => NO_DEVICE);
    const failingHub: DeviceHubClient = {
      deviceRuntimeStatus: async () => NO_DEVICE,
      deviceRpc: async () => { throw new Error('no device connected'); },
      acknowledgeDeviceRequest: async () => { throw new Error('no device connected'); },
    };
    const transport = createHubDeviceTransport({
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
    await expect(transport.rpc('exec', ['echo hi'])).rejects.toThrow();
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
    const transport = createHubDeviceTransport({
      hub: () => hub, caller, agentName: 'agent-1', cliCwd: () => null,
    });

    await transport.refreshStatus();
    await transport.rpc('exec', ['echo hi']);

    // The call proves the socket is there and says nothing about the toolchain.
    // Re-seeding the snapshot from the call alone blanked the row the moment the
    // agent used the device, which is exactly when it needs the row.
    expect(transport.status().toolchain).toEqual(probed.toolchain);
  });

  test('the caller\'s request identity is forwarded, not dropped or replaced', async () => {
    // This seam is the one that could quietly lose the id: it rewrites `exec`
    // params for the CLI cwd and adds checkpoint hints. An id that does not
    // reach the hub is a command nothing can cancel.
    const hub = fakeHub(() => ({ connected: true, registered: true, toolchain: null }));
    const transport = createHubDeviceTransport({
      hub: () => hub, caller, agentName: 'agent-1', cliCwd: () => '/home/me/project',
    });
    const requestId = nextDeviceRequestId();

    await transport.rpc('exec', ['make'], { timeoutMs: 0, requestId });

    const [method, params, opts] = requiredCall(hub.rpcCalls, 0);
    expect(method).toBe('exec');
    expect(String(params[0])).toContain('make');
    expect(opts?.requestId).toBe(requestId);
    // A call that needs no cancellation handle sends none, and the tunnel mints
    // its own — one authority, not two.
    await transport.rpc('readFile', ['/home/me/project/readme.md']);
    expect(requiredCall(hub.rpcCalls, 1)[2]?.requestId).toBeUndefined();
  });

  test('mutating methods carry the pre-mutation checkpoint hint; reads do not', async () => {
    const hub = fakeHub(() => ({ connected: true, registered: true, toolchain: null }));
    const transport = createHubDeviceTransport({
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
    const unwired = createHubDeviceTransport({ hub: () => hub, caller, agentName: 'a', cliCwd: () => null });
    await unwired.rpc('exec', ['ls']);
    expect(requiredCall(hub.rpcCalls, 0)[2]?.checkpoint).toBeUndefined();

    const outsideTurn = createHubDeviceTransport({
      hub: () => hub, agentName: 'a', cliCwd: () => null, checkpointMeta: () => null,
      caller,
    });
    await outsideTurn.rpc('writeFile', ['/x', 'y']);
    expect(requiredCall(hub.rpcCalls, 1)[2]?.checkpoint).toBeUndefined();
  });

  test('exec calls are rewritten into the CLI-forwarded working directory', async () => {
    const hub = fakeHub(() => ({ connected: true, registered: true, toolchain: null }));
    const transport = createHubDeviceTransport({
      hub: () => hub, agentName: 'agent-1', cliCwd: () => "/home/u/my proj",
      caller,
    });
    await transport.rpc('exec', ['git status']);
    await transport.rpc('readFile', ['/tmp/a']);
    // The workspace identity reaches the hub with every call, not just the first.
    expect(hub.rpcCalls.map((c) => c[3])).toEqual([FAKE_CALLER, FAKE_CALLER]);
    expect(hub.rpcCalls[0]?.[1]).toEqual(["cd '/home/u/my proj' && git status"]);
    expect(hub.rpcCalls[1]?.[1]).toEqual(['/tmp/a']); // only exec is cwd-rewritten
  });

  // A workspace shared with a second human loses the device plane entirely at
  // the user hub. What the agent must see is "no device", not a crashed turn.
  test('a hub that refuses this workspace reads as no device, and calls surface the reason', async () => {
    const denial = () => { throw new Error('"device.rpc" is not available to a shared workspace.'); };
    const denying: DeviceHubClient = {
      deviceRuntimeStatus: async () => denial(),
      deviceRpc: async () => denial(),
      acknowledgeDeviceRequest: async () => denial(),
    };
    const transport = createHubDeviceTransport({
      hub: () => denying, caller, agentName: 'agent-1', cliCwd: () => null,
    });

    expect(await transport.refreshStatus()).toEqual({ connected: false, registered: false, toolchain: null });
    expect(transport.status()).toEqual({ connected: false, registered: false, toolchain: null });
    await expect(transport.rpc('exec', ['ls'])).rejects.toThrow('not available to a shared workspace');
  });

  test('a workspace with no capability token reads as no device rather than throwing at turn start', async () => {
    const transport = createHubDeviceTransport({
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
