// DeviceSocketHub — the hibernation-aware device-socket lifecycle behind the
// /pc/connect upgrade (accept inside the DO, tag-based liveness, tunnel
// rebuild on wake). Regression coverage for the WS-over-RPC break: the
// upgrade path used to pass a WebSocket as a DO-RPC argument, which workerd
// cannot serialize, so the tunnel 500'd on every connect.
import { describe, expect, test } from 'bun:test';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from '@proteus/core';
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
});
