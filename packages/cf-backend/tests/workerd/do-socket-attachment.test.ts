/**
 * Hibernatable sockets, executed: the device plane keeps its per-connection record in the socket attachment and finds
 * connections by tag. The bun fake's `deserializeAttachment()` always answers null, and no better fake can exist: the
 * runtime holds the attachment outside the isolate heap, which is what survives hibernation.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SocketDO } from './worker';

/** The client half is kept on a module-level set: workerd closes the connection (attachment included) when an
 *  unreferenced client end is collected, which shipped as a deploy flake. */
const clients = new Set<WebSocket>();

const connect = async (object: DurableObjectStub<SocketDO>, device: string) => {
  const response = await object.fetch(`https://user-do/?device=${device}`, {
    headers: { Upgrade: 'websocket' },
  });

  // Without this the tests below would pass on a hub that accepted nothing.
  expect(response.status).toBe(101);

  if (response.webSocket !== null) clients.add(response.webSocket);
};

describe('hibernatable socket attachments', () => {
  const open = (name: string) => env.SOCKET.get(env.SOCKET.idFromName(name));

  it('the record written on one invocation reads back on the next', async () => {
    const userDo = open('reads-back');
    await connect(userDo, 'device');

    // Two invocations, as production splits them: recorded on the asking turn, re-found by tag on every later one.
    await userDo.recordProbe('device', false);

    expect(await userDo.probeRecord('device')).toEqual({
      device: 'device',
      probe: { present: ['node', 'python3'], probedAt: 1 },
    });
  });

  it('a Set in the record survives as a Set and fails its own parse', async () => {
    const userDo = open('set-trap');
    await connect(userDo, 'device');

    await userDo.recordProbe('device', true);

    // An attachment is structured-cloned, not JSON-encoded, so a Set stays a Set and `v.array(v.string())` rejects it,
    // silently dropping the machine from the capability row. That is what `[...probe.present]` at `device-hub.ts:199` buys.
    expect(await userDo.isConnected('device')).toBe(true);
    expect(await userDo.probeRecord('device')).toBeNull();
  });

  it('each tag resolves to its own device, never a neighbour on the same object', async () => {
    // One UserDO owns all an owner's devices and `connectedDeviceId` walks them all: a mis-scoped tag answers with another machine.
    const userDo = open('two-devices');
    await connect(userDo, 'device');
    await connect(userDo, 'desktop');

    await userDo.recordProbe('device', false);
    await userDo.recordProbe('desktop', false);

    expect(await userDo.probeRecord('device')).toMatchObject({ device: 'device' });
    expect(await userDo.probeRecord('desktop')).toMatchObject({ device: 'desktop' });
  });

  it('a reset keeps what storage holds and drops what a field holds', async () => {
    const userDo = open('reset');
    await userDo.raise('consent-1');

    expect(await userDo.settled('consent-1')).toEqual({ inMemory: true, inStorage: true });

    await abortAllDurableObjects();
    await scheduler.wait(150);

    // `DeviceConsentRegistry` keeps the request as a SQL row and its resolvers in a field, so a reset drops the
    // subscribers and keeps the card; `waiting` stands in for that field.
    expect(await open('reset').settled('consent-1')).toEqual({
      inMemory: false,
      inStorage: true,
    });
  });
});
