/**
 * Hibernatable sockets, executed. The device plane keeps its whole
 * per-connection record in the socket ATTACHMENT and looks connections up by
 * TAG, and neither of those is a thing `bun test` has.
 *
 * WHAT WE HAD BEFORE THIS FILE. Nothing that runs any of it. The fake socket the
 * bun suites and the gallery share makes `serializeAttachment` a no-op and
 * answers `deserializeAttachment()` with `null` unconditionally
 * (`gallery.tsx:315-317`). Every bun test over `DeviceSocketHub` therefore
 * observes a device plane where `probeRecord` is permanently null, so
 * `toolchain()` permanently answers "this machine has not told us"
 * (`device-hub.ts:132-136`) and `deviceIdFromSocket` permanently answers null
 * (`device-hub.ts:90-93`). Those are the failure states, passing as green.
 *
 * WHY IT CANNOT BE FIXED WITH A BETTER FAKE. The attachment is held by the
 * runtime OUTSIDE the isolate's heap, and being outside the heap is the entire
 * property production is buying: it is what lets a hibernated connection keep
 * its identity when the isolate holding it is gone. A fake that stored the
 * attachment in a JS field would be asserting the opposite of the thing under
 * test.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SocketDO } from './worker';

/** The upgrade `DeviceSocketHub.accept` answers (`device-hub.ts:106-113`). One
 *  per device, on whichever object the test is addressing. */
const connect = async (object: DurableObjectStub<SocketDO>, device: string) => {
  const response = await object.fetch(`https://user-do/?device=${device}`, {
    headers: { Upgrade: 'websocket' },
  });
  // Without this the tests below would pass on a hub that accepted nothing.
  expect(response.status).toBe(101);
};

describe('hibernatable socket attachments', () => {
  const open = (name: string) => env.SOCKET.get(env.SOCKET.idFromName(name));

  it('the record written on one invocation reads back on the next', async () => {
    const userDo = open('reads-back');
    await connect(userDo, 'laptop');

    // Two separate invocations: `recordProbe` writes, `probeRecord` re-finds the
    // socket by tag and parses. Production splits them exactly this way — the
    // probe is recorded on the turn that asked, and read on every later turn
    // that renders the capability row.
    await userDo.recordProbe('laptop', false);

    expect(await userDo.probeRecord('laptop')).toEqual({
      device: 'laptop',
      probe: { present: ['node', 'python3'], probedAt: 1 },
    });
  });

  it('a Set in the record survives as a Set and fails its own parse', async () => {
    const userDo = open('set-trap');
    await connect(userDo, 'laptop');

    await userDo.recordProbe('laptop', true);

    // An attachment is structured-cloned, not JSON-encoded, so the Set is still a
    // Set on the way back and `v.array(v.string())` rejects it. The connection is
    // UP and its own record reads as never-asked — so `toolchain()` answers null
    // (`device-hub.ts:132-136`), the capability row silently omits this machine
    // forever, and no error is raised anywhere. That is what the explicit
    // `[...probe.present]` at `device-hub.ts:199` is buying, and it is a
    // one-character edit away.
    expect(await userDo.isConnected('laptop')).toBe(true);
    expect(await userDo.probeRecord('laptop')).toBeNull();
  });

  it('each tag resolves to its own device, never a neighbour on the same object', async () => {
    // One UserDO owns every device an owner has attached, so the tag is the only
    // thing separating them. `connectedDeviceId` walks ALL of them
    // (`device-hub.ts:208-213`), which is why a mis-scoped tag would not fail —
    // it would answer with somebody else's machine.
    const userDo = open('two-devices');
    await connect(userDo, 'laptop');
    await connect(userDo, 'desktop');

    await userDo.recordProbe('laptop', false);
    await userDo.recordProbe('desktop', false);

    expect(await userDo.probeRecord('laptop')).toMatchObject({ device: 'laptop' });
    expect(await userDo.probeRecord('desktop')).toMatchObject({ device: 'desktop' });
  });

  it('a reset keeps what storage holds and drops what a field holds', async () => {
    const userDo = open('reset');
    await userDo.raise('consent-1');

    expect(await userDo.settled('consent-1')).toEqual({ inMemory: true, inStorage: true });

    await abortAllDurableObjects();
    await scheduler.wait(150);

    // The platform condition behind a limitation production already admits in
    // writing: `DeviceConsentRegistry.resolve` answers false for an id "from a
    // previous instance of this host" (`safety/device-consent.ts:162-163`),
    // because `waiting` is a field (`:135`) holding `settle` closures. The owner
    // answering a prompt raised before this line is silently dropped. Nothing
    // measured that this is what a reset does until this test.
    expect(await open('reset').settled('consent-1')).toEqual({
      inMemory: false,
      inStorage: true,
    });
  });
});
