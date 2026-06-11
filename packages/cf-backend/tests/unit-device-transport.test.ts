// createHubDeviceTransport — the laptop runtime's cached/authoritative status
// over the user-level device hub. This is what beforeTurn refreshes so the
// turn's context reflects a device that connected mid-session.
import { describe, expect, test } from 'bun:test';
import { createHubDeviceTransport, type DeviceHubClient } from '../src/device-transport.js';

function fakeHub(devices: () => Array<{ connected: boolean }>): DeviceHubClient & { rpcCalls: unknown[][] } {
  const rpcCalls: unknown[][] = [];
  return {
    rpcCalls,
    listDevices: async () => devices(),
    deviceRpc: async (method, params, opts) => {
      rpcCalls.push([method, params, opts]);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createHubDeviceTransport', () => {
  test('refreshStatus is authoritative: a device that connected mid-session becomes visible', async () => {
    let connected = false;
    const transport = createHubDeviceTransport({
      hub: () => fakeHub(() => [{ connected }]),
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
      agentName: 'agent-1',
      cliCwd: () => null,
      now: clock.now,
    });

    await transport.rpc('exec', ['echo hi']);
    expect(transport.status()).toEqual({ connected: true, registered: true });
    expect(hub.rpcCalls[0]).toEqual(['exec', ['echo hi'], { agentName: 'agent-1' }]);

    hubUp = false;
    await expect(transport.rpc('exec', ['echo hi'])).rejects.toThrow();
    expect(transport.status().connected).toBe(false);
    expect(transport.status().registered).toBe(true); // connectivity changed, registration didn't
  });

  test('exec calls are rewritten into the CLI-forwarded working directory', async () => {
    const hub = fakeHub(() => [{ connected: true }]);
    const transport = createHubDeviceTransport({
      hub: () => hub, agentName: 'agent-1', cliCwd: () => "/home/u/my proj",
    });
    await transport.rpc('exec', ['git status']);
    await transport.rpc('readFile', ['/tmp/a']);
    expect(hub.rpcCalls[0]?.[1]).toEqual(["cd '/home/u/my proj' && git status"]);
    expect(hub.rpcCalls[1]?.[1]).toEqual(['/tmp/a']); // only exec is cwd-rewritten
  });
});
