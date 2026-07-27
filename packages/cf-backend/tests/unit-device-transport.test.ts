// createHubDeviceTransport — the laptop runtime's cached/authoritative status
// over the user-level device hub. This is what beforeTurn refreshes so the
// turn's context reflects a device that connected mid-session.
import { describe, expect, test } from 'bun:test';
import { createHubDeviceTransport, type DeviceHubClient } from '../src/device-transport.js';

const FAKE_CALLER = { workspaceToken: 'pwc_test' } as const;
const caller = async () => FAKE_CALLER;

function fakeHub(devices: () => Array<{ connected: boolean }>): DeviceHubClient & { rpcCalls: unknown[][] } {
  const rpcCalls: unknown[][] = [];
  return {
    rpcCalls,
    listDevices: async () => devices(),
    deviceRpc: async (caller, method, params, opts) => {
      rpcCalls.push([method, params, opts, caller]);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

type RpcOpts = { agentName?: string; checkpoint?: { agent: string; turnId: string | null; sessionId: string | null; dir: string | null } };

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createHubDeviceTransport', () => {
  test('refreshStatus is authoritative: a device that connected mid-session becomes visible', async () => {
    let connected = false;
    const transport = createHubDeviceTransport({
      hub: () => fakeHub(() => [{ connected }]),
      caller,
      agentName: 'agent-1',
      cliCwd: () => null,
    });

    expect((await transport.refreshStatus())).toEqual({ connected: false, registered: true });
    connected = true; // the user runs `proteus connect` between turns
    expect((await transport.refreshStatus())).toEqual({ connected: true, registered: true });
    expect(transport.status().connected).toBe(true);
  });

  test('status() serves the cached snapshot inside the TTL without re-querying the hub', async () => {
    const clock = makeClock();
    let listCalls = 0;
    const hub: DeviceHubClient = {
      listDevices: async () => { listCalls += 1; return [{ connected: true }]; },
      deviceRpc: async () => 'unused',
    };
    const transport = createHubDeviceTransport({
      hub: () => hub, agentName: 'agent-1', cliCwd: () => null, now: clock.now,
      caller,
    });

    await transport.refreshStatus();
    expect(listCalls).toBe(1);
    transport.status();
    transport.status();
    expect(listCalls).toBe(1);          // fresh — no background re-check
    clock.advance(6_000);
    transport.status();                 // stale — kicks ONE background re-check
    transport.status();
    await Promise.resolve();
    expect(listCalls).toBe(2);
  });

  test('no owner hub → none state, and rpc rejects with the connect guidance', async () => {
    const transport = createHubDeviceTransport({
      hub: () => null, agentName: 'agent-1', cliCwd: () => null,
      caller,
    });
    expect(await transport.refreshStatus()).toEqual({ connected: false, registered: false });
    await expect(transport.rpc('exec', ['ls'])).rejects.toThrow(/no device connected/i);
  });

  test('rpc outcomes re-seed the snapshot: success → connected, hub rejection → offline', async () => {
    const clock = makeClock();
    let hubUp = true;
    const hub = fakeHub(() => []);
    const failingHub: DeviceHubClient = {
      listDevices: async () => [],
      deviceRpc: async () => { throw new Error('no device connected'); },
    };
    const transport = createHubDeviceTransport({
      hub: () => (hubUp ? hub : failingHub),
      caller,
      agentName: 'agent-1',
      cliCwd: () => null,
      now: clock.now,
    });

    await transport.rpc('exec', ['echo hi']);
    expect(transport.status()).toEqual({ connected: true, registered: true });
    expect(hub.rpcCalls[0]).toEqual(['exec', ['echo hi'], { agentName: 'agent-1' }, FAKE_CALLER]);

    hubUp = false;
    await expect(transport.rpc('exec', ['echo hi'])).rejects.toThrow();
    expect(transport.status().connected).toBe(false);
    expect(transport.status().registered).toBe(true); // connectivity changed, registration didn't
  });

  test('mutating methods carry the pre-mutation checkpoint hint; reads do not', async () => {
    const hub = fakeHub(() => [{ connected: true }]);
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

    const execOpts = hub.rpcCalls[0]?.[2] as RpcOpts;
    expect(execOpts.checkpoint).toEqual({
      agent: 'agent-1', turnId: 'msg-42', sessionId: 'default', dir: '/home/u/proj',
    });
    const writeOpts = hub.rpcCalls[1]?.[2] as RpcOpts;
    expect(writeOpts.checkpoint).toEqual({
      agent: 'agent-1', turnId: 'msg-42', sessionId: 'default', dir: null, // daemon derives from the path
    });
    const readOpts = hub.rpcCalls[2]?.[2] as RpcOpts;
    expect(readOpts.checkpoint).toBeUndefined();
  });

  test('no checkpoint hint outside a turn or when the meta seam is unwired', async () => {
    const hub = fakeHub(() => [{ connected: true }]);
    const unwired = createHubDeviceTransport({ hub: () => hub, caller, agentName: 'a', cliCwd: () => null });
    await unwired.rpc('exec', ['ls']);
    expect((hub.rpcCalls[0]?.[2] as RpcOpts).checkpoint).toBeUndefined();

    const outsideTurn = createHubDeviceTransport({
      hub: () => hub, agentName: 'a', cliCwd: () => null, checkpointMeta: () => null,
      caller,
    });
    await outsideTurn.rpc('writeFile', ['/x', 'y']);
    expect((hub.rpcCalls[1]?.[2] as RpcOpts).checkpoint).toBeUndefined();
  });

  test('exec calls are rewritten into the CLI-forwarded working directory', async () => {
    const hub = fakeHub(() => [{ connected: true }]);
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
      listDevices: async () => denial(),
      deviceRpc: async () => denial(),
    };
    const transport = createHubDeviceTransport({
      hub: () => denying, caller, agentName: 'agent-1', cliCwd: () => null,
    });

    expect(await transport.refreshStatus()).toEqual({ connected: false, registered: false });
    expect(transport.status()).toEqual({ connected: false, registered: false });
    await expect(transport.rpc('exec', ['ls'])).rejects.toThrow('not available to a shared workspace');
  });

  test('a workspace with no capability token reads as no device rather than throwing at turn start', async () => {
    const transport = createHubDeviceTransport({
      hub: () => fakeHub(() => [{ connected: true }]),
      caller: async () => { throw new Error('This workspace has not been issued a capability token yet.'); },
      agentName: 'agent-1',
      cliCwd: () => null,
    });

    // beforeTurn awaits this on every turn; it must never be what fails a turn.
    expect(await transport.refreshStatus()).toEqual({ connected: false, registered: false });
    await expect(transport.rpc('exec', ['ls'])).rejects.toThrow('capability token');
  });
});
