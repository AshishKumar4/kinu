// Device protocol 5, end to end: the shipped daemon, spawned as itself, connects through the Worker's own `/pc/*` routes
// to a real UserDO. A machine's key is its credential (SECURITY-devices C3): a copy of device.json without device.key, or
// with another key, buys nothing; two holders of one key are found by the connect generation; and no URL or header of
// a connect carries the ticket (M1). An earlier protocol's device.json is refused, and `kinu update` enrols it again.
import { afterEach, describe, expect, test } from 'bun:test';
import { type Subprocess } from 'bun';
import { closeSync, copyFileSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { DEVICE_FRAMES } from '@kinu.run/core';
import { killAndAwaitExit, present, recordedIn } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { registerTestDevice, testDeviceKey, type TestDeviceKey } from './helpers/device-key';
import { startDeviceBridge, type DeviceBridge } from './helpers/device-bridge';

const DAEMON_PATH = join(import.meta.dir, '../../pc-agent/src/index.js');

const REPO_ROOT = resolve(import.meta.dir, '../../..');

/** The account every machine here belongs to; the harness's object is named by it, as a real account's is. */
const ACCOUNT = '0123456789abcdef0123456789abcdef';

/** The daemon's exit for a credential the hub will not take (`REJECTED_EXIT` in pc-agent). */
const REJECTED_EXIT = 4;

/** The header the upgrade names its account in, as the wire spells it (core `DEVICE_CONNECT_ACCOUNT_HEADER`). */
const ACCOUNT_HEADER = 'x-kinu-auth-account';

const DeviceConfigSchema = v.object({ user: v.string(), device: v.string(), origin: v.string(), root: v.string(), generation: v.number() });

interface Daemon {
  readonly home: string;
  readonly child: Subprocess<'ignore', number, number>;
  log(): string;
}

const daemons: Daemon[] = [];

const open: Array<{ harness: TestUserDO; bridge: DeviceBridge }> = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    daemon.child.kill('SIGKILL');
    await daemon.child.exited;
    // A daemon `kinu update` started is detached, and named by its pidfile alone.
    const started = recordedIn(join(daemon.home, 'pc-agent.pid'), daemon.home);

    if (started !== null) await killAndAwaitExit(started);
  }

  for (const { harness, bridge } of open.splice(0)) {
    await bridge.stop();
    await harness.joinFibers();
    harness.close();
  }
});

function account() {
  const harness = createTestUserDO({ durableObjectId: ACCOUNT });
  const bridge = startDeviceBridge(harness);

  open.push({ harness, bridge });

  return { harness, bridge };
}

/** A machine's ~/.kinu as `kinu connect` leaves it: device.json and, unless `key` is null, device.key. */
function machineHome(bridge: DeviceBridge, deviceId: string, key: TestDeviceKey | null, generation = 0): string {
  const home = scratchDir('device-key-home');

  writeFileSync(join(home, 'device.json'), JSON.stringify({ user: ACCOUNT, device: deviceId, origin: bridge.origin, root: home, generation }), { mode: 0o600 });

  if (key !== null) writeFileSync(join(home, 'device.key'), key.privateKeyPem, { mode: 0o600 });

  return home;
}

/** The daemon as `kinu connect` starts it, on `home`; its output goes to a file, never a pipe the runner would wait on. */
function startDaemon(home: string): Daemon {
  const logPath = join(home, 'pc-agent.log');
  const fd = openSync(logPath, 'a');

  const child = Bun.spawn({
    cmd: [process.execPath, DAEMON_PATH],
    env: { ...process.env, HOME: scratchDir('device-key-user'), KINU_HOME: home, KINU_INFLIGHT_ROOT: join(home, 'inflight') },
    stdout: fd, stderr: fd, stdin: 'ignore',
  });

  closeSync(fd);
  const daemon = { home, child, log: () => readFileSync(logPath, 'utf8') };

  daemons.push(daemon);

  return daemon;
}

/** `waited`, or a failure saying what `daemon` wrote, if the daemon exits first. */
async function within<T>(daemon: Daemon, waited: Promise<T>, what: string): Promise<T> {
  const first = await Promise.race([waited.then((value) => ({ value })), daemon.child.exited.then((code) => ({ code }))]);

  if ('code' in first) throw new Error(`${what}: the daemon exited ${String(first.code)} first. It wrote:\n${daemon.log().slice(-3000)}`);

  return first.value;
}

/** The daemon's exit code. A daemon that never exits holds the case open: its log, on the tier's timeout, says why. */
async function exitOf(daemon: Daemon): Promise<number> {
  return daemon.child.exited;
}

const isFrame = (type: string) => (frame: string) => frame.startsWith('{') && v.is(v.looseObject({ type: v.literal(type) }), JSON.parse(frame));

/** The device's committed generation, incident and revocation, as the account stores them. */
function stored(harness: TestUserDO, deviceId: string) {
  return v.parse(
    v.array(v.object({ connect_generation: v.number(), clone_detected_at: v.nullable(v.number()), revoked_at: v.nullable(v.number()) })),
    harness.sql.exec(`SELECT connect_generation, clone_detected_at, revoked_at FROM user_devices WHERE id = ?`, deviceId).toArray(),
  )[0];
}

function generationOnDisk(home: string): number {
  return v.parse(DeviceConfigSchema, JSON.parse(readFileSync(join(home, 'device.json'), 'utf8'))).generation;
}

/** A daemon connected on `home`, its first generation stored and committed. */
async function connected(bridge: DeviceBridge, home: string, socket: number): Promise<Daemon> {
  const daemon = startDaemon(home);

  await within(daemon, bridge.helloed(socket), 'the daemon saying HELLO');
  await within(daemon, bridge.heard(isFrame(DEVICE_FRAMES.generationAck)), 'the daemon answering its generation');

  return daemon;
}

describe('a connect carries its ticket in its first frame, and nothing secret anywhere else', () => {
  test('every request of a full connect, at the Worker and at the UserDO, names no ticket and no bearer in its URL or headers', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const { harness, bridge } = account();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio');
    const home = machineHome(bridge, deviceId, key);

    await connected(bridge, home, 0);
    const [ticket] = bridge.tickets;

    if (ticket === undefined) throw new Error('the Worker answered no connect ticket');
    // The first frame on the socket is AUTH, and it carries the ticket the Worker answered.
    const [first] = bridge.frames[0] ?? [];
    expect(v.parse(v.object({ type: v.string(), user: v.string(), ticket: v.string() }), JSON.parse(first ?? 'null')))
      .toEqual({ type: DEVICE_FRAMES.auth, user: ACCOUNT, ticket });

    // Every request: the challenge, the ticket exchange, and the upgrade as the Worker and then the UserDO got it.
    expect(bridge.seen.map((request) => `${request.at} ${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'worker POST /pc/connect-challenge', 'worker POST /pc/connect-ticket', 'worker GET /pc/connect', 'object GET /pc/connect',
    ]);

    for (const request of bridge.seen) {
      const exposed = [request.url, ...request.headers.map(([name, value]) => `${name}: ${value}`)];

      for (const secret of ['ticket=', 'pdt_', 'pct_', ticket, 'user=']) {
        expect({ request: request.url, secret, found: exposed.filter((line) => line.includes(secret)) }).toEqual({ request: request.url, secret, found: [] });
      }
    }

    // The upgrade is routed by the account's header, never a query.
    const upgrade = bridge.seen.filter((request) => new URL(request.url).pathname === '/pc/connect');
    const routedTo = (request: (typeof upgrade)[number]) => request.headers.find(([name]) => name === ACCOUNT_HEADER)?.[1];
    expect(upgrade.map((request) => [new URL(request.url).search, routedTo(request)])).toEqual([['', ACCOUNT], ['', ACCOUNT]]);

    // The machine stored the generation it was handed, and the hub committed it on the answer.
    expect(generationOnDisk(home)).toBe(1);
    expect(stored(harness, deviceId)).toEqual({ connect_generation: 1, clone_detected_at: null, revoked_at: null });
    expect(await harness.userDO.listDevices(await testOwner())).toMatchObject([{ id: deviceId, connected: true }]);
  });
});

describe('a device key is the credential, and device.json alone is not', () => {
  test('a copy of device.json without device.key is refused at the challenge and buys no ticket', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const { harness, bridge } = account();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio');
    const owners = machineHome(bridge, deviceId, key);

    await connected(bridge, owners, 0);
    // The copy is the owner's device.json as it is now, taken without its key.
    const copy = scratchDir('device-key-copy');
    copyFileSync(join(owners, 'device.json'), join(copy, 'device.json'));
    const thief = startDaemon(copy);

    expect(await exitOf(thief)).toBe(REJECTED_EXIT);
    expect(thief.log()).toContain('device credentials were rejected');
    expect(thief.log()).toContain('no device key');
    // One ticket was ever bought, by the owner's machine; the copy asked for none, and the machine is untouched.
    expect(bridge.tickets).toHaveLength(1);
    expect(bridge.seen.filter((request) => new URL(request.url).pathname === '/pc/connect-ticket')).toHaveLength(1);
    expect(stored(harness, deviceId)).toEqual({ connect_generation: 1, clone_detected_at: null, revoked_at: null });
    expect(await harness.userDO.listDevices(await testOwner())).toMatchObject([{ id: deviceId, connected: true }]);
  });

  test('a copy of device.json beside another key is refused: the signature is not the device\'s, and nothing is revoked', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const { harness, bridge } = account();
    const { deviceId } = await registerTestDevice(harness.userDO, 'studio');
    const forged = startDaemon(machineHome(bridge, deviceId, testDeviceKey()));

    expect(await exitOf(forged)).toBe(REJECTED_EXIT);
    expect(forged.log()).toContain('device credentials were rejected');
    expect(bridge.tickets).toEqual([]);
    expect(stored(harness, deviceId)).toEqual({ connect_generation: 0, clone_detected_at: null, revoked_at: null });
  });
});

describe('two holders of one key are found by the connect generation', () => {
  test('the second, on the generation the first moved past, revokes the device and both are told why', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const { harness, bridge } = account();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio');
    // Copied whole, key and all, before the owner's machine first connected.
    const owners = machineHome(bridge, deviceId, key);
    const copy = machineHome(bridge, deviceId, key);
    const owner = await connected(bridge, owners, 0);

    expect(stored(harness, deviceId).connect_generation).toBe(1);
    const clone = startDaemon(copy);

    expect(await exitOf(clone)).toBe(REJECTED_EXIT);
    expect(clone.log()).toContain('two machines used its key');
    expect(clone.log()).toContain('kinu connect');
    expect(stored(harness, deviceId)).toMatchObject({ clone_detected_at: expect.any(Number), revoked_at: expect.any(Number) });
    expect(await harness.userDO.listDevices(await testOwner())).toMatchObject([
      { id: deviceId, connected: false, revokedAt: expect.any(Number), cloneDetectedAt: expect.any(Number) },
    ]);

    // The hub cannot tell which machine is the owner's: the other one's socket is closed, and its next connect refused.
    expect(await exitOf(owner)).toBe(REJECTED_EXIT);
    expect(owner.log()).toContain('two machines used its key');
  });

  test('a machine that stored its generation and lost the answer connects on it, and the hub commits it first', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const { harness, bridge } = account();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio');
    const home = machineHome(bridge, deviceId, key);
    const first = await connected(bridge, home, 0);

    first.child.kill('SIGTERM');
    await exitOf(first);
    // The machine holds generation 1; the hub, as if the answer had gone down with the socket, still holds 0.
    harness.sql.exec(`UPDATE user_devices SET connect_generation = 0 WHERE id = ?`, deviceId);
    expect(generationOnDisk(home)).toBe(1);

    const again = startDaemon(home);

    await within(again, bridge.helloed(1), 'the daemon connecting again');
    await within(again, bridge.heard((frame) => frame.startsWith('{') && v.is(v.object({ type: v.literal(DEVICE_FRAMES.generationAck), generation: v.literal(2) }), JSON.parse(frame))), 'the second generation answered');
    expect(generationOnDisk(home)).toBe(2);
    expect(stored(harness, deviceId)).toEqual({ connect_generation: 2, clone_detected_at: null, revoked_at: null });
  });
});

describe('a machine linked on an earlier protocol', () => {
  test('is refused, on the machine and at the hub, and `kinu update` enrols it again with a new key that connects', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const harness = createTestUserDO({ durableObjectId: ACCOUNT });
    const session = 'ptc_session_of_this_cli';

    // The CLI's own routes, as the signed-in session reaches them: who it is, and the account's devices.
    const bridge = startDeviceBridge(harness, async (request) => {
      const { pathname } = new URL(request.url);

      if (request.headers.get('authorization') !== `Bearer ${session}`) return Response.json({ error: 'no session' }, { status: 401 });

      if (pathname === '/api/cli/me') return Response.json({ user: { id: ACCOUNT, email: 'owner@example.com' } });

      if (pathname === '/api/cli/devices' && request.method === 'GET') return Response.json(await harness.userDO.listDevices(await testOwner()));

      if (pathname !== '/api/cli/devices') return null;
      const asked = v.parse(v.object({ publicKey: v.string(), label: v.optional(v.string()), reenrol: v.optional(v.string()) }), await request.json());
      const { deviceId } = await harness.userDO.registerDevice(await testOwner(), { ...asked, origin: bridge.origin });

      return Response.json({ deviceId, userId: ACCOUNT, origin: bridge.origin }, { status: 201 });
    });

    open.push({ harness, bridge });
    const home = scratchDir('device-key-earlier');
    const earlier = { user: ACCOUNT, device: 'dev-earlier', token: `pdt_${'e'.repeat(43)}`, origin: bridge.origin, root: home };

    writeFileSync(join(home, 'device.json'), JSON.stringify(earlier), { mode: 0o600 });

    // The daemon this release ships will not run on it, and says what mends it.
    const refused = startDaemon(home);
    expect(await exitOf(refused)).toBe(1);
    expect(refused.log()).toContain('run: kinu update');

    // Its bearer, posted as the earlier daemon posts it, is refused at the hub in the same words.
    const bearer = await fetch(`${bridge.origin}/pc/connect-ticket`, { method: 'POST', body: JSON.stringify({ user: ACCOUNT, token: earlier.token }) });
    expect(bearer.status).toBe(401);
    expect(await bearer.text()).toContain('kinu update');

    // `kinu update` with no session says to connect; with one, it enrols the same device again and its daemon connects.
    const updated = Bun.spawn({
      cmd: [process.execPath, '-e', `
        import { reenrolEarlierDevice } from './packages/cli/src/device-connect.ts';
        const signedOut = await reenrolEarlierDevice(null);
        const signedIn = await reenrolEarlierDevice({ origin: ${JSON.stringify(bridge.origin)}, token: ${JSON.stringify(session)} });
        console.log(JSON.stringify({ signedOut, signedIn }));
        process.exit(0);
      `],
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: scratchDir('device-key-user'), KINU_HOME: home, KINU_INFLIGHT_ROOT: join(home, 'inflight') },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });

    const [stdout, stderr, code] = await Promise.all([new Response(updated.stdout).text(), new Response(updated.stderr).text(), updated.exited]);

    expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
    const outcome = v.parse(v.object({ signedOut: v.object({ kind: v.string(), message: v.string() }), signedIn: v.looseObject({ kind: v.string(), deviceId: v.string() }) }), JSON.parse(stdout));

    expect(outcome.signedOut.kind).toBe('needs-connect');
    expect(outcome.signedOut.message).toContain('kinu connect');
    expect(outcome.signedIn).toMatchObject({ kind: 'reenrolled', deviceId: 'dev-earlier' });

    // device.json holds no secret now, device.key is the machine's alone, and the hub holds its public half.
    const config = JSON.parse(readFileSync(join(home, 'device.json'), 'utf8'));
    expect(config).not.toHaveProperty('token');
    expect(v.parse(DeviceConfigSchema, config)).toMatchObject({ user: ACCOUNT, device: 'dev-earlier', root: home });
    expect(statSync(join(home, 'device.key')).mode & 0o777).toBe(0o600);
    const publicKey = present(createPublicKey(readFileSync(join(home, 'device.key'), 'utf8')).export({ format: 'jwk' }).x, 'the raw public key');
    expect(harness.sql.exec(`SELECT public_key FROM user_devices WHERE id = ?`, 'dev-earlier').toArray()).toEqual([{ public_key: publicKey }]);
    expect(await harness.userDO.listDevices(await testOwner())).toMatchObject([{ id: 'dev-earlier', connected: true }]);
  });
});
