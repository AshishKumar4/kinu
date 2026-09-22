// DeviceSocketHub behind the /pc/connect upgrade. Defends the WS-over-RPC break: workerd cannot
// serialize a WebSocket as a DO-RPC argument, so passing one 500s the tunnel on every connect.
import { describe, expect, test } from 'bun:test';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVICE_CONNECT_PATH, DEVICE_TERMINAL_PATH,
  DEVICE_PTY_INPUT, DEVICE_PTY_OPEN_METHOD,
  DEVICE_TOOLCHAIN_TTL_MS, DEVICE_TOKEN_ROTATION, DEVICE_TOKEN_ROTATION_ACK,
  DEVICE_UNKNOWN_METHOD, TOOLCHAIN_PROBE_BINARIES,
  type JsonValue,
} from '@kinu.run/core';
import * as v from 'valibot';
import { CAPABLE_HELLO, WORKSPACE } from './helpers/device-harness';
import { provisionTestWorkspace } from './helpers/user-do';
import {
  DeviceSocketHub,
  deviceIdFromSocket,
  type DeviceSocket,
  type DeviceSocketCtx,
} from '@kinu.run/core';

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
  test('accept marks the socket and reports liveness', () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const ws = fakeSocket();
    hub.accept('dev-a', ws);
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

    // Hibernation: in-memory hub state is gone, sockets survive on ctx.
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

/** The hub owns the toolchain probe: its answer describes one machine over one connection, the socket attachment's lifetime. */
describe('DeviceSocketHub toolchain probe', () => {
  const NOW = 1_700_000_000_000;

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
    // Names come from core's single table, shared with the CLI host row.
    const frame = answerLast(hub, ws, { result: { present: ['node', 'python3'] } });
    expect(frame.method).toBe('which');
    expect(frame.params[0]).toEqual([...TOOLCHAIN_PROBE_BINARIES]);

    expect(await probing).toEqual({
      present: ['javascript', 'python'],
      asked: ['javascript', 'typescript', 'python', 'npm', 'git'],
      probedAt: NOW,
    });
    // Measured absent (actionable); nothing was measured about docker or gpu.
    expect(hub.toolchain('dev-a', NOW)?.present).toEqual(['javascript', 'python']);

    expect(await hub.probeToolchain('dev-a', NOW)).not.toBeNull();
    expect(ws.sent).toHaveLength(1);
  });

  test('a daemon too old to answer is recorded as unable, never as a machine with nothing', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { error: 'unknown method: which' });

    // An empty answer would strip python from a machine that may well have it.
    expect(await probing).toBeNull();
    expect(hub.toolchain('dev-a', NOW)).toBeNull();

    expect(await hub.probeToolchain('dev-a', NOW + 1)).toBeNull();
    expect(ws.sent).toHaveLength(1);
  });

  test('the daemon speaks the frame types core names, since it cannot import them', () => {
    // The daemon is one dependency-free file that cannot import these constants, so every mirrored literal is pinned here.
    const daemon = readFileSync(join(import.meta.dir, '..', '..', 'pc-agent', 'src', 'index.js'), 'utf8');
    expect(daemon).toContain(`'${DEVICE_UNKNOWN_METHOD}: ' + method`);
    expect(daemon).toContain(`const TOKEN_ROTATION = '${DEVICE_TOKEN_ROTATION}'`);
    expect(daemon).toContain(`const TOKEN_ROTATION_ACK = '${DEVICE_TOKEN_ROTATION_ACK}'`);
  });

  test('a transient failure leaves the question open for the next turn', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { error: 'EIO reading /usr/bin' });
    expect(await probing).toBeNull();

    const reprobing = hub.probeToolchain('dev-a', NOW + 1);
    expect(ws.sent).toHaveLength(2);
    answerLast(hub, ws, { error: 'EIO reading /usr/bin' });
    expect(await reprobing).toBeNull();
  });

  test('an answer past its window is re-asked, not reused', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { result: { present: ['node'] } });
    await probing;

    // The agent can install toolchains via `exec`, so an answer is evidence only for a bounded time.
    const later = NOW + DEVICE_TOOLCHAIN_TTL_MS;
    expect(hub.toolchain('dev-a', later)).toBeNull();
    const reprobing = hub.probeToolchain('dev-a', later);
    expect(ws.sent).toHaveLength(2);
    answerLast(hub, ws, { result: { present: ['node'] } });
    expect(await reprobing).not.toBeNull();
  });

  test('an answer never outlives the machine that gave it', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { result: { present: ['node'] } });
    await probing;
    expect(hub.toolchain('dev-a', NOW)).not.toBeNull();

    // A different device can reconnect under the same row; recording on the socket, not SQL, keeps it from inheriting capabilities.
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
    const pcHandler = read('../core/src/http/pc-ingress.ts');
    // WebSockets are not RPC-serializable in workerd.
    expect(pcHandler).not.toContain('attachDeviceSocket');
    expect(pcHandler).not.toContain('WebSocketPair');
    expect(pcHandler).toContain('.fetch(request)');
  });

  test('the UserDO answers /pc/connect itself and verifies the ticket before upgrading', async () => {
    const harness = createTestUserDO();
    const { token } = await harness.userDO.registerDevice(await testOwner(), 'studio tower');
    const owner = await testOwner();

    const connect = (query: string, upgrade: boolean): Promise<Response> => harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_CONNECT_PATH}${query}`,
      upgrade ? { headers: { Upgrade: 'websocket' } } : {},
    ));

    expect((await connect('', false)).status).toBe(426);
    expect((await connect('', true)).status).toBe(401);
    expect((await connect('?ticket=pct_forged', true)).status).toBe(401);
    expect(harness.acceptedSockets).toHaveLength(0);

    const issued = await harness.userDO.issueDeviceConnectTicket(owner, token);

    if (!issued.ok || !issued.ticket) throw new Error('the owner could not mint a connect ticket');
    expect((await connect(`?ticket=${issued.ticket}`, true)).status).toBe(101);
    expect(harness.acceptedSockets).toHaveLength(1);

    expect('attachDeviceSocket' in harness.userDO).toBe(false);
    await harness.joinFibers();
    harness.close();
  });
});

describe('device links expire on an absolute window, renewed by rotation', () => {
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

  test('a freshly linked device carries a window, and USE alone does not extend it', async () => {
    const harness = createTestUserDO();
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'studio tower');
    expect(storedExpiry(harness, deviceId)).toBeGreaterThan(Date.now());

    // Anchored to the last rotation, not verification: an idle-sliding window kept a copied device.json alive indefinitely.
    const anchor = Date.now() + day;
    ageDevice(harness, deviceId, anchor);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token))
      .toEqual({ ok: true, deviceId, current: true });
    expect(storedExpiry(harness, deviceId)).toBe(anchor);
    harness.close();
  });

  test('a device that stopped connecting is refused and cannot mint a ticket', async () => {
    const harness = createTestUserDO();
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'device');
    ageDevice(harness, deviceId, Date.now() - day);

    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token)).toEqual({ ok: false });
    expect(await harness.userDO.issueDeviceConnectTicket(await testOwner(), token)).toEqual({ ok: false });
    harness.close();
  });

  test('a link made before the window existed is honoured until its next rotation', async () => {
    const harness = createTestUserDO();
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'studio tower');
    ageDevice(harness, deviceId, null);

    // A null window is "never measured", not "expired": it is stamped on the next daemon connect.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token))
      .toEqual({ ok: true, deviceId, current: true });
    expect(storedExpiry(harness, deviceId)).toBeNull();
    harness.close();
  });

  test('the listing reports the window so the owner can see a link about to lapse', async () => {
    const harness = createTestUserDO();
    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'device');
    ageDevice(harness, deviceId, 12345);
    expect(await harness.userDO.listDevices(await testOwner()))
      .toMatchObject([{ id: deviceId, expiresAt: 12345 }]);
    harness.close();
  });

  test('the runtime status separates "no device" from "registered but away", with nothing claimed', async () => {
    const harness = createTestUserDO();
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner()))
      .toEqual({ connected: false, registered: false, toolchain: null, devices: [] });

    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'studio tower');
    // `toolchain: null` offline, never an empty set (the model would read "runs nothing"); the row stays
    // named so the agent can ask for it.
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner())).toEqual({
      connected: false,
      registered: true,
      toolchain: null,
      devices: [{ id: deviceId, name: 'studio tower', os: null, hostname: null, connected: false }],
    });
    harness.close();
  });
});

/**
 * The daemon's bare `ping`/`pong` keepalive; unanswered, every device link drops periodically. A pasted
 * "ping" on a terminal pane must not be answered: the platform auto-response cannot tell the sockets apart.
 */
describe('the daemon keepalive, answered by the hub', () => {
  async function connectDevice(harness: TestUserDO) {
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'studio tower');
    const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), token);

    if (!issued.ok || !issued.ticket) throw new Error('the owner could not mint a connect ticket');

    const response = await harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`,
      { headers: { Upgrade: 'websocket' } },
    ));

    if (response.status !== 101) throw new Error(`the device upgrade was refused with ${response.status}`);

    const device = harness.acceptedSockets.at(-1);

    if (!device) throw new Error('the upgrade produced no socket');

    return { deviceId, device };
  }

  test('a device socket that pings is answered and stays connected', async () => {
    const harness = createTestUserDO();
    const { deviceId, device } = await connectDevice(harness);

    // The wire contract is the literal text frames, not our names.
    const before = device.sent.length;
    await harness.userDO.webSocketMessage(device.ws, 'ping');
    expect(device.sent.slice(before)).toEqual(['pong']);
    expect(device.ws.readyState).toBe(1);

    await harness.userDO.webSocketMessage(device.ws, 'ping');
    expect(device.sent.slice(before)).toEqual(['pong', 'pong']);
    expect(device.ws.readyState).toBe(1);
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner()))
      .toMatchObject({ connected: true, devices: [{ id: deviceId, connected: true }] });

    await harness.joinFibers();
    harness.close();
  });

  test('a pasted "ping" on a terminal pane is keystrokes, never an answered probe', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    const { device } = await connectDevice(harness);
    await harness.userDO.webSocketMessage(device.ws, JSON.stringify(CAPABLE_HELLO));
    harness.consentDecision = 'always';

    // The open frame is answered by hand: this socket pair has no far end.
    const opening = harness.userDO.openDeviceTerminal({ workspaceToken: workspace }, WORKSPACE, { cols: 80, rows: 24 });

    for (let turn = 0; turn < 100; turn += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      const openRaw = device.sent.find((raw) => raw.includes(`"${DEVICE_PTY_OPEN_METHOD}"`));

      if (openRaw) {
        const openId = v.parse(v.object({ id: v.string() }), JSON.parse(openRaw)).id;
        await harness.userDO.webSocketMessage(device.ws, JSON.stringify({ id: openId, result: {} }));
        break;
      }
    }

    const { session } = await opening;

    const paneUpgrade = await harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_TERMINAL_PATH}?session=${session}`,
      { headers: { Upgrade: 'websocket' } },
    ));

    expect(paneUpgrade.status).toBe(101);
    const pane = harness.acceptedSockets.at(-1);

    if (!pane) throw new Error('the pane upgrade produced no socket');

    expect(pane.sent).toEqual([JSON.stringify({ type: 'ready' })]);
    const framesBefore = device.sent.length;

    await harness.userDO.webSocketMessage(pane.ws, 'ping');
    expect(pane.sent).toEqual([JSON.stringify({ type: 'ready' })]);
    expect(device.sent.length).toBe(framesBefore);

    await harness.userDO.webSocketMessage(pane.ws, new TextEncoder().encode('ping'));

    expect(pane.sent).toEqual([JSON.stringify({ type: 'ready' })]);

    const typed = device.sent.slice(framesBefore).map((raw) => v.parse(
      v.object({ type: v.literal(DEVICE_PTY_INPUT), session: v.string(), data: v.string() }),
      JSON.parse(raw),
    ));

    expect(typed).toEqual([{ type: DEVICE_PTY_INPUT, session, data: 'cGluZw==' }]);

    await harness.joinFibers();
    harness.close();
  });
});
