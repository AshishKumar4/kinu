/**
 * The hub pushes UPDATE on HELLO exactly when the named build differs from the served one and the owner
 * did not opt out; a daemon naming no build keeps `daemon_outdated` and gets nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DEVICE_UPDATE, type JsonValue } from '@kinu.run/core';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { CAPABLE_HELLO } from './helpers/device-harness';
import { DEVICE_UPDATE_COPY } from '../src/hooks/use-device-roster';

const SERVED = '0.3.0+served1';

const LINUX_X64 = '/downloads/kinu-cli-linux-x64.tar.gz';

const CHECKSUM = 'a'.repeat(64);

/** The hub relays the build lane's signature and never mints one; the daemon verifies it. */
const SIGNATURE = 'c2ln'.repeat(21) + 'c2ln';

const open: TestUserDO[] = [];

afterEach(() => {
  for (const harness of open.splice(0)) harness.close();
});

/** No served build when `served` is null. */
async function connected(served: string | null = SERVED): Promise<TestUserDO & { deviceId: string }> {
  const harness = createTestUserDO(served === null
    ? {}
    : { servedBuild: { version: served, checksums: { [LINUX_X64]: CHECKSUM }, signature: SIGNATURE } });

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
      checksums: { [LINUX_X64]: CHECKSUM },
      signature: SIGNATURE,
      device: harness.deviceId,
    }]);
  });

  test('a build that shipped no signature pushes nothing: the daemon would refuse it', async () => {
    const harness = createTestUserDO({ servedBuild: { version: SERVED, checksums: { [LINUX_X64]: CHECKSUM } } });
    open.push(harness);
    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'studio');
    harness.attachDevice(deviceId);
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    expect(harness.devicePushes).toEqual([]);
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

  test('a source install — a version with no build stamp — is left alone and read as a dev build', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0', updateCheck: true }));

    // An unstamped report is not a published build, so the hub must never push over it.
    expect(harness.devicePushes).toEqual([]);

    const [row] = await devices(harness);
    expect(row).toMatchObject({ version: '0.2.0', update: 'unstamped' });
    // The badge is the exported copy constant, never a page literal.
    expect(DEVICE_UPDATE_COPY).toHaveProperty('unstamped');
  });

  test('an owner opt-out on a source install still reads off — intent beats the build stamp', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0', updateCheck: false }));
    expect(harness.devicePushes).toEqual([]);
    const [row] = await devices(harness);
    expect(row?.update).toBe('off');
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

describe('a UserDO opened over storage from before the self-update lane', () => {
  // The shipped pre-lane user_devices DDL: `CREATE TABLE IF NOT EXISTS` in `initUserTables` is a no-op
  // on it, so the object runs against what a pre-lane account holds.
  const SHIPPED_USER_DEVICES = `
    CREATE TABLE IF NOT EXISTS user_devices (
      id              TEXT PRIMARY KEY,
      token_hash      TEXT NOT NULL,
      prev_token_hash TEXT,
      label           TEXT NOT NULL,
      os              TEXT,
      hostname        TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      connected_at    INTEGER,
      last_seen_at    INTEGER,
      expires_at      INTEGER,
      revoked_at      INTEGER,
      last_ip         TEXT,
      last_agent      TEXT,
      replaced_at     INTEGER,
      consented_root  TEXT,
      device_home     TEXT,
      sandbox_capability TEXT,
      sandbox_reason  TEXT,
      sandbox_detail  TEXT,
      sandbox_gpu     TEXT,
      agent_root      TEXT,
      tier            TEXT NOT NULL DEFAULT 'sandboxed',
      unstopped_at    INTEGER
    )
  `;

  test('HELLO records and Devices reads on storage whose user_devices has no build columns', async () => {
    const db = new Database(':memory:');
    db.run(SHIPPED_USER_DEVICES);

    const harness = createTestUserDO({ storage: db, servedBuild: { version: SERVED, checksums: { [LINUX_X64]: CHECKSUM }, signature: SIGNATURE } });
    open.push(harness);

    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'studio');
    harness.attachDevice(deviceId);

    // recordDeviceHello once named columns the old table never had; it writes its own table instead.
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));

    expect(harness.devicePushes).toEqual([{
      type: DEVICE_UPDATE,
      version: SERVED,
      urls: { tarball: LINUX_X64, checksum: `${LINUX_X64}.sha256` },
      sha256: CHECKSUM,
      checksums: { [LINUX_X64]: CHECKSUM },
      signature: SIGNATURE,
      device: deviceId,
    }]);

    const [row] = await devices(harness);
    expect(row).toMatchObject({ version: '0.2.0+older', servedVersion: SERVED, update: 'behind' });

    db.close();
  });

  test('the read model on storage that never heard a HELLO still answers unreported', async () => {
    const db = new Database(':memory:');
    db.run(SHIPPED_USER_DEVICES);

    const harness = createTestUserDO({ storage: db });
    open.push(harness);

    await harness.userDO.registerDevice(await testOwner(), 'studio');

    const [row] = await devices(harness);
    // No user_device_builds row: the LEFT JOIN absent row reads as a daemon that named nothing.
    expect(row).toMatchObject({ version: null, update: 'unreported' });

    db.close();
  });
});
