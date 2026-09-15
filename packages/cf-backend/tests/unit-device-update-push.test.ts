/**
 * The hub's half of the daemon self-update: the UPDATE frame a HELLO earns,
 * and the version the Devices read model shows for it.
 *
 * Driven through the real socket handler and the real `listDevices`, over a
 * harness whose `ASSETS` binding serves a build stamp and the artifacts'
 * checksums. The hub pushes exactly when the HELLO named a build that is not
 * the served one and the owner did not opt out; a daemon that named none
 * keeps the `daemon_outdated` reading and gets nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { DEVICE_UPDATE, type JsonValue } from '@kinu.run/core';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { CAPABLE_HELLO } from './helpers/device-harness';

const SERVED = '0.3.0+served1';

const LINUX_X64 = '/downloads/kinu-cli-linux-x64.tar.gz';

const CHECKSUM = 'a'.repeat(64);

const open: TestUserDO[] = [];

afterEach(() => {
  for (const harness of open.splice(0)) harness.close();
});

/** A registered device with the harness socket attached, on a deployment
 *  serving `SERVED` (or nothing, when `served` is null). */
async function connected(served: string | null = SERVED): Promise<TestUserDO & { deviceId: string }> {
  const harness = createTestUserDO(served === null
    ? {}
    : { servedBuild: { version: served, checksums: { [LINUX_X64]: CHECKSUM } } });

  open.push(harness);
  const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'studio');
  harness.attachDevice(deviceId);

  return Object.assign(harness, { deviceId });
}

const hello = (fields: Record<string, JsonValue>): JsonValue => ({ ...CAPABLE_HELLO, arch: 'x64', ...fields });

async function devices(harness: TestUserDO) {
  return harness.userDO.listDevices(await testOwner());
}

describe('the UPDATE frame a HELLO earns', () => {
  test('a daemon behind the served build gets one: the served version, its platform artifact, the checksum', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));

    expect(harness.devicePushes).toEqual([{
      type: DEVICE_UPDATE,
      version: SERVED,
      urls: { tarball: LINUX_X64, checksum: `${LINUX_X64}.sha256` },
      sha256: CHECKSUM,
      device: harness.deviceId,
    }]);
  });

  test('a daemon on the served build gets nothing', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: SERVED, updateCheck: true }));
    expect(harness.devicePushes).toEqual([]);
  });

  test('an owner who opted out gets nothing, however far behind', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.1.0+ancient', updateCheck: false }));
    expect(harness.devicePushes).toEqual([]);
  });

  test('a daemon that named no build is accepted, recorded as before, and gets nothing', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(CAPABLE_HELLO);
    expect(harness.devicePushes).toEqual([]);
    const [row] = await devices(harness);
    expect(row).toMatchObject({ hostname: 'studio', version: null, update: 'unreported', servedVersion: SERVED });
    // The sandbox verdict path is untouched: this daemon proved a sandbox.
    expect(row?.sandbox.capability).toBe('sandboxed');
  });

  test('a daemon with no sandbox field still reads daemon_outdated, version or not', async () => {
    const harness = await connected();
    await harness.sendDeviceHello({ type: 'HELLO', os: 'linux', hostname: 'old' });
    const [row] = await devices(harness);
    expect(row?.sandbox).toMatchObject({ capability: 'files_only', reason: 'daemon_outdated' });
    expect(harness.devicePushes).toEqual([]);
  });

  test('a platform no artifact is built for gets nothing', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true, arch: 'riscv64' }));
    expect(harness.devicePushes).toEqual([]);
  });

  test('a deployment that published no build stamp pushes nothing', async () => {
    const harness = await connected(null);
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    expect(harness.devicePushes).toEqual([]);
    const [row] = await devices(harness);
    expect(row).toMatchObject({ version: '0.2.0+older', servedVersion: null, update: 'current' });
  });

  test('a deployment with a stamp but no checksum for the artifact pushes nothing', async () => {
    const harness = createTestUserDO({ servedBuild: { version: SERVED } });
    open.push(harness);
    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'studio');
    harness.attachDevice(deviceId);
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    expect(harness.devicePushes).toEqual([]);
  });
});

describe('the Devices read model carries the version and the served build', () => {
  test('behind, current and off, each from what the daemon said and what is served', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    expect((await devices(harness))[0]).toMatchObject({ version: '0.2.0+older', servedVersion: SERVED, update: 'behind' });

    await harness.sendDeviceHello(hello({ version: SERVED, updateCheck: true }));
    expect((await devices(harness))[0]).toMatchObject({ version: SERVED, servedVersion: SERVED, update: 'current' });

    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: false }));
    expect((await devices(harness))[0]).toMatchObject({ version: '0.2.0+older', servedVersion: SERVED, update: 'off' });
  });

  test('a later HELLO without a version overwrites: the row says what THIS daemon said', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    await harness.sendDeviceHello(CAPABLE_HELLO);
    expect((await devices(harness))[0]).toMatchObject({ version: null, update: 'unreported' });
  });
});
