/**
 * The hub pushes UPDATE on HELLO when the named build differs, the owner allows it, and the daemon
 * has not refused that build; a daemon naming no build keeps `daemon_outdated` and gets nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DEVICE_UPDATE, decodeJsonValue, type JsonValue } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_USER_ENV, type TestUserDO } from './helpers/user-do';
import { CAPABLE_HELLO } from './helpers/device-harness';
import { DEVICE_UPDATE_COPY } from '../src/hooks/use-device-roster';
import { pcRoutes } from '../src/pc-routes';
import { makeKv } from './helpers/kv';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';

const SERVED = '0.3.0+served1';

const LINUX_X64 = '/downloads/kinu-cli-linux-x64.tar.gz';

const CHECKSUM = 'a'.repeat(64);

/** The hub relays the build lane's signature and never mints one; the daemon verifies it. */
const SIGNATURE = 'c2ln'.repeat(21) + 'c2ln';

const REFUSAL = 'Bun 1.4.2 is required; installing it failed: permission denied';

const open: TestUserDO[] = [];

afterEach(() => {
  for (const harness of open.splice(0)) harness.close();
});

/** No served build when `served` is null. */
async function connected(served: string | null = SERVED): Promise<TestUserDO & { deviceId: string; token: string }> {
  const harness = createTestUserDO(served === null
    ? {}
    : { servedBuild: { version: served, checksums: { [LINUX_X64]: CHECKSUM }, signature: SIGNATURE } });

  open.push(harness);
  const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'studio');
  harness.attachDevice(deviceId);

  return Object.assign(harness, { deviceId, token });
}

const hello = (fields: Record<string, JsonValue>): JsonValue => ({ ...CAPABLE_HELLO, arch: 'x64', ...fields });

async function devices(harness: TestUserDO) {
  return harness.userDO.listDevices(await testOwner());
}

/** The runtime the refusing daemon ran on: the launcher's Bun before the pin moved. */
const REFUSED_ON = 'Bun 1.4.0';

async function refuse(harness: TestUserDO, token: string, version = SERVED, reason = REFUSAL): Promise<Response> {
  return pcRoutes.fetch(new Request('https://kinu.test/pc/update-refused', {
    method: 'POST',
    body: JSON.stringify({ user: '0123456789abcdef0123456789abcdef', token, version, runtime: REFUSED_ON, reason }),
  }), {
    ...TEST_USER_ENV,
    AUTH_KV: makeKv(),
    UserDO: { idFromName: (name: string) => name, get: () => harness.userDO },
  });
}

describe('a daemon reports why it cannot take a served build', () => {
  test('recording a refusal refreshes an open roster and emits the inspected device, version and reason', async () => {
    const refreshed: Array<{ workspace: string; update: string; updateRefusal: string | null }> = [];

    const harness = createTestUserDO({
      servedBuild: { version: SERVED, checksums: { [LINUX_X64]: CHECKSUM }, signature: SIGNATURE },
      deviceRosterMoved: async (workspace) => {
        const [row] = await devices(harness);

        if (row) refreshed.push({ workspace, update: row.update, updateRefusal: row.updateRefusal });

        return true;
      },
    });

    open.push(harness);
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'studio');
    harness.attachDevice(deviceId);
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    const workspaceToken = await provisionTestWorkspace(harness, 'watching-workspace');
    await harness.userDO.watchDeviceStatus({ workspaceToken }, true);

    const logger = createRecordingLogger();
    const restore = setDiagnosticsSink(logger);

    try {
      expect((await refuse(harness, token)).status).toBe(200);
      expect(refreshed).toEqual([{ workspace: 'watching-workspace', update: 'refused', updateRefusal: REFUSAL }]);
      expect(logger.emitted).toContainEqual({
        event: 'device.update_refused', code: null, cause: null,
        fields: { device: deviceId, version: SERVED, runtime: REFUSED_ON, reason: REFUSAL },
      });
    } finally {
      restore();
    }
  });

  test('the real refusal route records the reason on the device status and replaces its prior refusal', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));

    const response = await refuse(harness, harness.token, ` ${SERVED} `);
    expect(response.status).toBe(200);
    expect(decodeJsonValue({ value: await response.json() })).toEqual({ ok: true });
    expect((await devices(harness))[0]).toMatchObject({ update: 'refused', servedVersion: SERVED, updateRefusal: REFUSAL });

    const second = await refuse(harness, harness.token, SERVED, 'Bun install failed: no space left on device');
    expect(second.status).toBe(200);
    expect((await devices(harness))[0]).toMatchObject({ update: 'refused', updateRefusal: 'Bun install failed: no space left on device' });
    expect(harness.db.query('SELECT * FROM user_device_update_refusals').all()).toEqual([{
      device_id: harness.deviceId, version: SERVED, runtime: REFUSED_ON, reason: 'Bun install failed: no space left on device',
      refused_at: expect.any(Number),
    }]);
  });

  test('the hub stops re-pushing the refused release and resumes for a newer served build', async () => {
    const servedBuild = { version: SERVED, checksums: { [LINUX_X64]: CHECKSUM }, signature: SIGNATURE };
    const harness = createTestUserDO({ servedBuild });
    open.push(harness);
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'studio');
    harness.attachDevice(deviceId);
    const behind = hello({ version: '0.2.0+older', updateCheck: true });

    await harness.sendDeviceHello(behind);
    expect(harness.devicePushes).toHaveLength(1);
    expect(harness.devicePushes[0]).toMatchObject({ type: DEVICE_UPDATE, version: SERVED });
    expect((await refuse(harness, token)).status).toBe(200);

    await harness.sendDeviceHello(behind);
    expect(harness.devicePushes).toHaveLength(1);

    servedBuild.version = '0.3.1+newer';
    await harness.sendDeviceHello(behind);
    expect(harness.devicePushes).toHaveLength(2);
    expect(harness.devicePushes[1]).toMatchObject({ type: DEVICE_UPDATE, version: servedBuild.version });
    expect((await devices(harness))[0]).toMatchObject({ update: 'behind', servedVersion: servedBuild.version, updateRefusal: null });
  });

  test('a refusal holds while the daemon runs where it refused, and lapses when it reports another runtime', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    expect(harness.devicePushes).toHaveLength(1);
    expect((await refuse(harness, harness.token)).status).toBe(200);

    // The daemon that refused on 1.4.0, an older daemon that names no runtime, and the same runtime again.
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true, runtime: REFUSED_ON }));
    expect(harness.devicePushes).toHaveLength(1);
    expect((await devices(harness))[0]).toMatchObject({ update: 'refused', updateRefusal: REFUSAL });

    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true, runtime: 'Bun 1.4.2' }));
    expect(harness.devicePushes).toHaveLength(2);
    expect(harness.devicePushes[1]).toMatchObject({ type: DEVICE_UPDATE, version: SERVED });
    expect((await devices(harness))[0]).toMatchObject({ update: 'behind', updateRefusal: null });
  });

  test('a refusal affects only its device, not another machine behind the same release', async () => {
    const harness = await connected();
    const other = await harness.userDO.registerDevice(await testOwner(), 'other');
    harness.attachDaemon(other.deviceId);
    expect((await refuse(harness, harness.token)).status).toBe(200);

    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }), other.deviceId);
    expect(harness.devicePushes).toMatchObject([{ device: other.deviceId, type: DEVICE_UPDATE, version: SERVED }]);
    expect((await devices(harness)).find((row) => row.id === other.deviceId)).toMatchObject({ update: 'behind', updateRefusal: null });
  });

  test('a refused release remains refused after the UserDO reopens its stored device registry', async () => {
    const db = new Database(':memory:');
    const servedBuild = { version: SERVED, checksums: { [LINUX_X64]: CHECKSUM }, signature: SIGNATURE };

    try {
      const first = createTestUserDO({ storage: db, servedBuild });
      open.push(first);
      const { deviceId, token } = await first.userDO.registerDevice(await testOwner(), 'studio');
      first.attachDevice(deviceId);
      await first.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
      expect((await refuse(first, token)).status).toBe(200);
      first.close();

      const reopened = createTestUserDO({ storage: db, servedBuild });
      open.push(reopened);
      reopened.attachDevice(deviceId);
      expect((await devices(reopened))[0]).toMatchObject({ update: 'refused', updateRefusal: REFUSAL });
      await reopened.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
      expect(reopened.devicePushes).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('unreported, off, unstamped and current take precedence over a refusal of the served build', async () => {
    const harness = await connected();
    expect((await refuse(harness, harness.token)).status).toBe(200);

    for (const [fields, update] of [
      [{}, 'unreported'],
      [{ version: '0.2.0+older', updateCheck: false }, 'off'],
      [{ version: '0.2.0', updateCheck: true }, 'unstamped'],
      [{ version: SERVED, updateCheck: true }, 'current'],
    ] as const) {
      await harness.sendDeviceHello(hello(fields));
      expect((await devices(harness))[0]).toMatchObject({ update, updateRefusal: null });
    }
  });

  test('a well-shaped but unknown token earns 401 and records nothing', async () => {
    const harness = await connected();
    await harness.sendDeviceHello(hello({ version: '0.2.0+older', updateCheck: true }));
    expect((await refuse(harness, `pdt_${'w'.repeat(32)}`)).status).toBe(401);
    expect((await devices(harness))[0]).toMatchObject({ update: 'behind', updateRefusal: null });
  });

  test('a device token cannot bypass the UserDO caller capability gate', async () => {
    const harness = await connected();
    await expect(harness.userDO.recordDeviceUpdateRefusal({ ownerToken: '' }, harness.token, { version: SERVED, runtime: REFUSED_ON, reason: REFUSAL }))
      .rejects.toThrow('owner');
    expect(harness.db.query('SELECT * FROM user_device_update_refusals').all()).toEqual([]);
  });

  test('a revoked device token cannot record a refusal', async () => {
    const harness = await connected();
    // An incident retains the revoked row, so its hash still exists and the revocation gate must refuse it.
    harness.db.query('UPDATE user_devices SET unstopped_at = ? WHERE id = ?').run(Date.now(), harness.deviceId);
    await harness.userDO.revokeDevice(await testOwner(), harness.deviceId);
    expect((await devices(harness))[0]).toMatchObject({ id: harness.deviceId, revokedAt: expect.any(Number) });
    expect((await refuse(harness, harness.token)).status).toBe(401);
    expect(harness.db.query('SELECT * FROM user_device_update_refusals').all()).toEqual([]);
  });

  test('an expired device token cannot record a refusal', async () => {
    const harness = await connected();
    harness.db.query('UPDATE user_devices SET expires_at = ? WHERE id = ?').run(Date.now() - 1, harness.deviceId);
    expect((await refuse(harness, harness.token)).status).toBe(401);
    expect(harness.db.query('SELECT * FROM user_device_update_refusals').all()).toEqual([]);
  });
});

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
