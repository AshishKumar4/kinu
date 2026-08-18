// DeviceSocketHub — the hibernation-aware device-socket lifecycle behind the
// /pc/connect upgrade (accept inside the DO, tag-based liveness, tunnel
// rebuild on wake). Regression coverage for the WS-over-RPC break: the
// upgrade path used to pass a WebSocket as a DO-RPC argument, which workerd
// cannot serialize, so the tunnel 500'd on every connect.
import { describe, expect, test } from 'bun:test';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVICE_TOOLCHAIN_TTL_MS, DEVICE_UNKNOWN_METHOD, TOOLCHAIN_PROBE_BINARIES,
  type JsonValue,
} from '@proteus/core';
import * as v from 'valibot';
import {
  DeviceSocketHub,
  deviceIdFromSocket,
  deviceTag,
  type DeviceSocket,
  type DeviceSocketCtx,
} from '../src/user/device-hub';

interface FakeSocket extends DeviceSocket {
  sent: string[];
  closed: Array<{ code?: number; reason?: string }>;
  readyState: number;
}

function fakeSocket(open = true): FakeSocket {
  let attachment: JsonValue | undefined;
  return {
    readyState: open ? 1 : 3,
    sent: [],
    closed: [],
    send(data: string) { this.sent.push(data); },
    close(code?: number, reason?: string) { this.closed.push({ code, reason }); this.readyState = 3; },
    serializeAttachment(value: JsonValue) { attachment = value; },
    deserializeAttachment() { return attachment; },
  };
}

/** Mimics DurableObjectState hibernatable-websocket bookkeeping. */
function fakeCtx(): DeviceSocketCtx & { accepted: Array<{ ws: FakeSocket; tags: string[] }> } {
  const accepted: Array<{ ws: FakeSocket; tags: string[] }> = [];
  return {
    accepted,
    acceptWebSocket(ws: FakeSocket, tags: string[]) { accepted.push({ ws, tags }); },
    getWebSockets(tag?: string) {
      return accepted.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws);
    },
  };
}

describe('DeviceSocketHub', () => {
  test('accept tags the socket as device:<id> and marks its attachment', () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const ws = fakeSocket();
    hub.accept('dev-a', ws);
    expect(ctx.accepted[0]?.tags).toEqual([deviceTag('dev-a')]);
    expect(deviceIdFromSocket(ws)).toBe('dev-a');
    expect(hub.isConnected('dev-a')).toBe(true);
    expect(hub.connectedDeviceId()).toBe('dev-a');
    expect(hub.connectedDeviceId('dev-a')).toBe('dev-a');
    expect(hub.connectedDeviceId('dev-other')).toBeNull();
  });

  test('agents-SDK sockets (no device attachment) are not treated as devices', () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const sdkSocket = fakeSocket();
    sdkSocket.serializeAttachment({ __pk: { id: 'conn-1', tags: [] } });
    ctx.acceptWebSocket(sdkSocket, ['conn-1']);
    expect(deviceIdFromSocket(sdkSocket)).toBeNull();
    expect(hub.connectedDeviceId()).toBeNull();
  });

  test('a reconnect replaces the previous socket for the same device', async () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const first = fakeSocket();
    const second = fakeSocket();
    hub.accept('dev-a', first);
    hub.accept('dev-a', second);
    expect(first.closed).toEqual([{ code: 1000, reason: 'replaced by a new connection' }]);
    expect(hub.liveSocket('dev-a')).toBe(second);
    const tunnel = hub.tunnel('dev-a');
    if (!tunnel) throw new Error('expected device tunnel');
    const pending = tunnel.rpc('exec', ['ls']);
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);
    const frame = v.parse(v.object({ id: v.string() }), JSON.parse(second.sent[0] ?? 'null'));
    hub.handleMessage('dev-a', JSON.stringify({ id: frame.id, result: 'ok' }));
    expect(await pending).toBe('ok');
  });

  test('a new hub over the same ctx rebuilds liveness + tunnel after a wake', async () => {
    const ctx = fakeCtx();
    const socket = fakeSocket();
    new DeviceSocketHub(ctx).accept('dev-a', socket);

    // Simulate hibernation: in-memory hub state is gone, sockets survive on ctx.
    const woken = new DeviceSocketHub(ctx);
    expect(woken.isConnected('dev-a')).toBe(true);
    expect(woken.connectedDeviceId()).toBe('dev-a');

    const tunnel = woken.tunnel('dev-a');
    if (!tunnel) throw new Error('expected restored device tunnel');
    const reply = tunnel.rpc('exec', ['echo hi']);
    const frame = v.parse(v.object({ id: v.string() }), JSON.parse(socket.sent[0] ?? 'null'));
    woken.handleMessage('dev-a', JSON.stringify({ id: frame.id, result: 'hi' }));
    expect(await reply).toBe('hi');
  });

  test('a socket close rejects its in-flight calls; liveness follows the socket', async () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const ws = fakeSocket();
    hub.accept('dev-a', ws);
    const tunnel = hub.tunnel('dev-a');
    if (!tunnel) throw new Error('expected device tunnel');
    const pending = tunnel.rpc('exec', ['sleep 99']);
    ws.readyState = 3;
    hub.handleClose('dev-a', ws);
    await expect(pending).rejects.toThrow('device tunnel not connected');
    expect(hub.isConnected('dev-a')).toBe(false);
    expect(hub.connectedDeviceId()).toBeNull();
  });

  test('a replaced socket\'s late close event does not tear down the new tunnel', async () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const first = fakeSocket();
    const second = fakeSocket();
    hub.accept('dev-a', first);
    hub.accept('dev-a', second); // closes `first`; its close event arrives later
    const tunnel = hub.tunnel('dev-a');
    if (!tunnel) throw new Error('expected replacement device tunnel');
    const pending = tunnel.rpc('exec', ['ls']);

    hub.handleClose('dev-a', first); // the late close for the replaced socket

    const frame = v.parse(v.object({ id: v.string() }), JSON.parse(second.sent[0] ?? 'null'));
    hub.handleMessage('dev-a', JSON.stringify({ id: frame.id, result: 'ok' }));
    expect(await pending).toBe('ok');
    expect(hub.isConnected('dev-a')).toBe(true);
  });

  test('close (revocation) closes every socket for the device', () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const ws = fakeSocket();
    hub.accept('dev-a', ws);
    hub.close('dev-a', 'device revoked');
    expect(ws.closed).toEqual([{ code: 1000, reason: 'device revoked' }]);
    expect(hub.isConnected('dev-a')).toBe(false);
  });
});

/**
 * The toolchain probe. The hub owns it because the answer describes ONE machine
 * over ONE connection, and that is exactly the socket attachment's lifetime.
 */
describe('DeviceSocketHub toolchain probe', () => {
  const NOW = 1_700_000_000_000;

  /** Answer the frame the hub just sent, as a daemon would. */
  function answerLast(hub: DeviceSocketHub, ws: FakeSocket, reply: Record<string, JsonValue>) {
    const raw = ws.sent[ws.sent.length - 1];
    const frame = v.parse(
      v.object({ id: v.string(), method: v.string(), params: v.array(v.unknown()) }),
      JSON.parse(raw ?? 'null'),
    );
    hub.handleMessage('dev-a', JSON.stringify({ id: frame.id, ...reply }));
    return frame;
  }

  function connected() {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const ws = fakeSocket();
    hub.accept('dev-a', ws);
    return { ctx, hub, ws };
  }

  test('asks the machine the shared question and turns its answer into evidence', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    // The names come from core's single table rather than a list the hub keeps:
    // one answer to "which binaries prove python", shared with the CLI host row.
    const frame = answerLast(hub, ws, { result: { present: ['node', 'python3'] } });
    expect(frame.method).toBe('which');
    expect(frame.params[0]).toEqual([...TOOLCHAIN_PROBE_BINARIES]);

    expect(await probing).toEqual({
      present: ['javascript', 'python'],
      asked: ['javascript', 'typescript', 'python', 'npm', 'git'],
      probedAt: NOW,
    });
    // `typescript`, `npm` and `git` were looked for and not found — measured
    // absent, which the row may act on. Nothing was measured about docker or gpu.
    expect(hub.toolchain('dev-a', NOW)?.present).toEqual(['javascript', 'python']);

    // Asked once: a second read serves the recorded answer, no second frame.
    expect(await hub.probeToolchain('dev-a', NOW)).not.toBeNull();
    expect(ws.sent).toHaveLength(1);
  });

  test('a daemon too old to answer is recorded as unable, never as a machine with nothing', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { error: 'unknown method: which' });

    // The failure mode this exists to prevent: an empty answer would strip
    // python from a machine that may well have it.
    expect(await probing).toBeNull();
    expect(hub.toolchain('dev-a', NOW)).toBeNull();

    // And it stops asking — the install will not grow the method mid-connection.
    expect(await hub.probeToolchain('dev-a', NOW + 1)).toBeNull();
    expect(ws.sent).toHaveLength(1);
  });

  test("the daemon's unknown-method reply is still the words core matches on", () => {
    // The daemon ships as one dependency-free file and cannot import the
    // constant, so the coupling is pinned here rather than left to drift.
    const daemon = readFileSync(join(import.meta.dir, '..', '..', 'pc-agent', 'src', 'index.js'), 'utf8');
    expect(daemon).toContain(`'${DEVICE_UNKNOWN_METHOD}: ' + method`);
  });

  test('a transient failure leaves the question open for the next turn', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { error: 'EIO reading /usr/bin' });
    expect(await probing).toBeNull();

    // Nothing durable was learned, so the next read asks again.
    void hub.probeToolchain('dev-a', NOW + 1);
    expect(ws.sent).toHaveLength(2);
  });

  test('an answer past its window is re-asked, not reused', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { result: { present: ['node'] } });
    await probing;

    // The agent can install a toolchain onto that machine through `exec`, so an
    // answer is evidence for a bounded time and then stops being one.
    const later = NOW + DEVICE_TOOLCHAIN_TTL_MS;
    expect(hub.toolchain('dev-a', later)).toBeNull();
    void hub.probeToolchain('dev-a', later);
    expect(ws.sent).toHaveLength(2);
  });

  test('an answer never outlives the machine that gave it', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { result: { present: ['node'] } });
    await probing;
    expect(hub.toolchain('dev-a', NOW)).not.toBeNull();

    // A DIFFERENT laptop can reconnect under the same device row. Recording the
    // answer on the socket rather than in SQL is what keeps it from inheriting
    // its predecessor's capabilities.
    hub.accept('dev-a', fakeSocket());
    expect(hub.toolchain('dev-a', NOW)).toBeNull();
  });

  test('an offline device is not asked at all', async () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    expect(await hub.probeToolchain('dev-a', NOW)).toBeNull();
    expect(hub.toolchain('dev-a', NOW)).toBeNull();
  });
});

describe('/pc/connect upgrade wiring', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');

  test('the worker forwards the upgrade Request to the UserDO instead of passing a WebSocket over RPC', () => {
    const pcHandler = read('src/pc-handler.ts');
    // WebSockets are not RPC-serializable in workerd — this exact pattern
    // 500'd every daemon connect in production.
    expect(pcHandler).not.toContain('attachDeviceSocket');
    expect(pcHandler).not.toContain('WebSocketPair');
    expect(pcHandler).toContain('.fetch(request)');
  });

  test('the UserDO intercepts /pc/connect and verifies the ticket inside its own fetch', () => {
    const userDO = read('src/user/user-do.ts');
    expect(userDO).toContain('DEVICE_CONNECT_PATH,'); // imported from @proteus/core — the single wire-path home
    expect(userDO).toContain('if (url.pathname === DEVICE_CONNECT_PATH) return this.acceptDeviceSocket(request, url)');
    expect(userDO).toContain('await this.verifyDeviceConnectTicket(await ownerCaller(this.env), ticket)');
    expect(userDO).toContain('return super.fetch(request)');
    expect(userDO).not.toContain('attachDeviceSocket');
  });
});

describe('device tokens expire on idleness', () => {
  const day = 24 * 60 * 60 * 1000;

  function ageDevice(harness: TestUserDO, deviceId: string, expiresAt: number | null): void {
    harness.db.prepare('UPDATE user_devices SET expires_at = ? WHERE id = ?').run(expiresAt, deviceId);
  }

  function storedExpiry(harness: TestUserDO, deviceId: string): number | null {
    const row = harness.db.prepare<{ e: number | null }, [string]>(
      'SELECT expires_at AS e FROM user_devices WHERE id = ?',
    ).get(deviceId);
    if (!row) throw new Error(`missing device ${deviceId}`);
    return row.e;
  }

  test('a freshly linked device carries a window, and using it pushes the window out', async () => {
    const harness = createTestUserDO();
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'laptop');
    expect(storedExpiry(harness, deviceId)).toBeGreaterThan(Date.now());

    ageDevice(harness, deviceId, Date.now() + day);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token)).toEqual({ ok: true, deviceId });
    const expiry = storedExpiry(harness, deviceId);
    expect(expiry).not.toBeNull();
    expect(expiry ?? 0).toBeGreaterThan(Date.now() + 100 * day);
    harness.close();
  });

  test('a device that stopped connecting is refused and cannot mint a ticket', async () => {
    const harness = createTestUserDO();
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'laptop');
    ageDevice(harness, deviceId, Date.now() - day);

    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token)).toEqual({ ok: false });
    expect(await harness.userDO.issueDeviceConnectTicket(await testOwner(), token)).toEqual({ ok: false });
    harness.close();
  });

  test('a link made before the window existed is stamped on next use, not locked out', async () => {
    const harness = createTestUserDO();
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'laptop');
    ageDevice(harness, deviceId, null);

    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token)).toEqual({ ok: true, deviceId });
    expect(storedExpiry(harness, deviceId)).toBeGreaterThan(Date.now());
    harness.close();
  });

  test('the listing reports the window so the owner can see a link about to lapse', async () => {
    const harness = createTestUserDO();
    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'laptop');
    ageDevice(harness, deviceId, 12345);
    expect(await harness.userDO.listDevices(await testOwner()))
      .toMatchObject([{ id: deviceId, expiresAt: 12345 }]);
    harness.close();
  });

  test('the runtime status separates "no device" from "registered but away", with nothing claimed', async () => {
    const harness = createTestUserDO();
    // Nothing registered: the agent's laptop row is not configured at all.
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner()))
      .toEqual({ connected: false, registered: false, toolchain: null });

    await harness.userDO.registerDevice(await testOwner(), 'laptop');
    // Registered and offline. `toolchain: null` is the honest answer for a
    // machine that is not there to be asked — never an empty capability set,
    // which would tell the model the user's laptop runs nothing.
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner()))
      .toEqual({ connected: false, registered: true, toolchain: null });
    harness.close();
  });
});
