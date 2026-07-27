// DeviceSocketHub — the hibernation-aware device-socket lifecycle behind the
// /pc/connect upgrade (accept inside the DO, tag-based liveness, tunnel
// rebuild on wake). Regression coverage for the WS-over-RPC break: the
// upgrade path used to pass a WebSocket as a DO-RPC argument, which workerd
// cannot serialize, so the tunnel 500'd on every connect.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeviceSocketHub,
  deviceIdFromSocket,
  deviceTag,
  type DeviceSocket,
  type DeviceSocketCtx,
} from '../src/user/device-hub.js';

interface FakeSocket extends DeviceSocket {
  sent: string[];
  closed: Array<{ code?: number; reason?: string }>;
  readyState: number;
}

function fakeSocket(open = true): FakeSocket {
  let attachment: unknown;
  return {
    readyState: open ? 1 : 3,
    sent: [],
    closed: [],
    send(data: string) { this.sent.push(data); },
    close(code?: number, reason?: string) { this.closed.push({ code, reason }); this.readyState = 3; },
    serializeAttachment(value: unknown) { attachment = value; },
    deserializeAttachment() { return attachment; },
  };
}

/** Mimics DurableObjectState hibernatable-websocket bookkeeping. */
function fakeCtx(): DeviceSocketCtx & { accepted: Array<{ ws: FakeSocket; tags: string[] }> } {
  const accepted: Array<{ ws: FakeSocket; tags: string[] }> = [];
  return {
    accepted,
    acceptWebSocket(ws: DeviceSocket, tags: string[]) { accepted.push({ ws: ws as FakeSocket, tags }); },
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
    expect(ctx.accepted[0]!.tags).toEqual([deviceTag('dev-a')]);
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
    const pending = hub.tunnel('dev-a')!.rpc('exec', ['ls']);
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);
    const frame = JSON.parse(second.sent[0]!) as { id: string };
    hub.handleMessage('dev-a', JSON.stringify({ id: frame.id, result: 'ok' }));
    expect(await pending).toBe('ok');
  });

  test('a new hub over the same ctx rebuilds liveness + tunnel after a wake', async () => {
    const ctx = fakeCtx();
    new DeviceSocketHub(ctx).accept('dev-a', fakeSocket());

    // Simulate hibernation: in-memory hub state is gone, sockets survive on ctx.
    const woken = new DeviceSocketHub(ctx);
    expect(woken.isConnected('dev-a')).toBe(true);
    expect(woken.connectedDeviceId()).toBe('dev-a');

    const ws = woken.liveSocket('dev-a')!;
    const reply = woken.tunnel('dev-a')!.rpc('exec', ['echo hi']);
    const frame = JSON.parse((ws as FakeSocket).sent[0]!) as { id: string };
    woken.handleMessage('dev-a', JSON.stringify({ id: frame.id, result: 'hi' }));
    expect(await reply).toBe('hi');
  });

  test('a socket close rejects its in-flight calls; liveness follows the socket', async () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const ws = fakeSocket();
    hub.accept('dev-a', ws);
    const pending = hub.tunnel('dev-a')!.rpc('exec', ['sleep 99']);
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
    const pending = hub.tunnel('dev-a')!.rpc('exec', ['ls']);

    hub.handleClose('dev-a', first); // the late close for the replaced socket

    const frame = JSON.parse(second.sent[0]!) as { id: string };
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
    expect(userDO).toContain('await this.verifyDeviceConnectTicket(OWNER_SESSION, ticket)');
    expect(userDO).toContain('return super.fetch(request)');
    expect(userDO).not.toContain('attachDeviceSocket');
  });
});
