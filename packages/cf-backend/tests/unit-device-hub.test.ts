// DeviceSocketHub behind the /pc/connect upgrade. Defends the WS-over-RPC break: workerd cannot
// serialize a WebSocket as a DO-RPC argument, so passing one 500s the tunnel on every connect.
import { describe, expect, test } from 'bun:test';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import {
  DEVICE_CONNECT_PATH, DEVICE_CONNECT_SECRET, DEVICE_TERMINAL_PATH,
  DEVICE_TOOLCHAIN_TTL_MS, TOOLCHAIN_PROBE_BINARIES, TUNNEL_DISCONNECTED, DEVICE_FEATURES, DEVICE_PROTOCOL_VERSION,
  connectedDevices, type JsonValue, JsonValueSchema, DEVICE_ERRORS, DEVICE_FRAMES, DEVICE_METHOD,
  DEVICE_AUTH_DEADLINE_CLOSE, DEVICE_AUTH_DEADLINE_MS, DEVICE_CREDENTIALS_REJECTED_CLOSE, DEVICE_VERSION_REFUSAL_CLOSE,
} from '@kinu.run/core';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';
import { handClock, present } from '@kinu.run/test-utils';
import { buyTicket, connectTestDevice, handedSecret, openDeviceSocket, registerTestDevice } from './helpers/device-key';
import { CAPABLE_HELLO, WORKSPACE } from './helpers/device-harness';
import { provisionTestWorkspace } from './helpers/user-do';
import {
  DeviceSocketHub,
  DeviceTerminalHub,
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
    getTags(ws) { return accepted.find((s) => s.ws === ws)?.tags ?? []; },
  };
}

/** A daemon's socket as the account takes it: accepted before it says who it is, then bound as its AUTH binds it. */
function admitted(hub: DeviceSocketHub, deviceId: string, ws: DeviceSocket): void {
  hub.acceptUnauthenticated(ws);
  hub.admit(deviceId, ws);
}

/** A socket bound to `deviceId` out of band, as a duplicate a wake found would be: tagged as every device socket is. */
function stray(ctx: DeviceSocketCtx, ws: DeviceSocket, deviceId: string): void {
  ctx.acceptWebSocket(ws, ['device']);
  ws.serializeAttachment({ device: deviceId });
}

function connected() {
  const ctx = fakeCtx();
  const hub = new DeviceSocketHub(ctx);
  const ws = fakeSocket();
  admitted(hub, 'dev-a', ws);
  hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);

  return { ctx, hub, ws };
}

type PeerMessage = string | ArrayBuffer | ArrayBufferView;

/** The socket platform delivers bytes and a close code to the remote peer. */
function socketPeer(onMessage?: (data: PeerMessage) => void, open = true) {
  let attachment: unknown;
  const messages: PeerMessage[] = [];
  const readers: Array<ReturnType<typeof Promise.withResolvers<PeerMessage>>> = [];
  const closure = Promise.withResolvers<number | undefined>();

  const socket: DeviceSocket = {
    readyState: open ? 1 : 3,
    send(data) {
      const reader = readers.shift();

      if (reader) reader.resolve(data);
      else messages.push(data);
      onMessage?.(data);
    },
    close(code) { this.readyState = 3; closure.resolve(code); },
    serializeAttachment(value) { attachment = value; },
    deserializeAttachment() { return attachment; },
  };

  return {
    socket, closed: closure.promise,
    receive: async (): Promise<PeerMessage> => {
      const message = messages.shift();

      if (message !== undefined) return message;
      const reader = Promise.withResolvers<PeerMessage>();
      readers.push(reader);

      return reader.promise;
    },
  };
}

function peerContext(): DeviceSocketCtx {
  const accepted: Array<{ ws: DeviceSocket; tags: string[] }> = [];

  return {
    acceptWebSocket(ws, tags) { accepted.push({ ws, tags }); },
    getWebSockets(tag) { return accepted.filter((entry) => tag === undefined || entry.tags.includes(tag)).map((entry) => entry.ws); },
    getTags(ws) { return accepted.find((entry) => entry.ws === ws)?.tags ?? []; },
  };
}

function answeringPeer(deviceId: string, hub: () => DeviceSocketHub, result: JsonValue) {
  return socketPeer((data) => {
    const frame = v.parse(v.object({ id: v.string() }), JSON.parse(v.parse(v.string(), data)));
    hub().handleMessage(deviceId, JSON.stringify({ id: frame.id, result }));
  });
}

describe('DeviceSocketHub', () => {
  test('a daemon without the current protocol is refused before it can execute', async () => {
    const harness = createTestUserDO();

    try {
      const { deviceId } = await registerTestDevice(harness.userDO, 'old daemon');
      harness.attachDaemon(deviceId);
      await harness.sendDeviceHello({ ...CAPABLE_HELLO, protocolVersion: 0, features: [] }, deviceId);
      expect(connectedDevices((await harness.userDO.deviceRuntimeStatus(await testOwner())).devices)).toEqual([]);
    } finally {
      harness.close();
    }
  });
  test('accept marks the socket and reports liveness', () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const ws = fakeSocket();
    admitted(hub, 'dev-a', ws);
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
    admitted(hub, 'dev-a', first);
    admitted(hub, 'dev-a', second);
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
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

  test('a reconnect closes every older live peer and leaves another machine serving', async () => {
    const ctx = peerContext();
    const hub = new DeviceSocketHub(ctx);
    const first = answeringPeer('dev-a', () => hub, 'first daemon');
    const duplicate = answeringPeer('dev-a', () => hub, 'duplicate daemon');
    const replacement = answeringPeer('dev-a', () => hub, 'replacement daemon');
    const sibling = answeringPeer('dev-b', () => hub, 'other machine');

    admitted(hub, 'dev-a', first.socket);
    stray(ctx, duplicate.socket, 'dev-a');
    stray(ctx, socketPeer(undefined, false).socket, 'dev-a');
    admitted(hub, 'dev-b', sibling.socket);
    hub.hello('dev-b', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
    admitted(hub, 'dev-a', replacement.socket);
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);

    expect(await first.closed).toBe(1000);
    expect(await duplicate.closed).toBe(1000);
    expect(await present(hub.tunnel('dev-a'), 'the reconnected machine').rpc('exec', ['hostname'])).toBe('replacement daemon');
    expect(await present(hub.tunnel('dev-b'), 'the other machine').rpc('exec', ['hostname'])).toBe('other machine');
  });

  test('a new hub over the same ctx rebuilds liveness + tunnel after a wake', async () => {
    const ctx = fakeCtx();
    const socket = fakeSocket();
    admitted(new DeviceSocketHub(ctx), 'dev-a', socket);
    new DeviceSocketHub(ctx).hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);

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

  test('a HELLO on any protocol but this one is refused and closed, and a wake readmits nothing', async () => {
    // Only this protocol authenticates, so no earlier one is held open for an update push (device protocol 5).
    const ctx = peerContext();
    let hub = new DeviceSocketHub(ctx);
    const daemon = answeringPeer('dev-a', () => hub, { signedIn: false });
    admitted(hub, 'dev-a', daemon.socket);
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
    expect(await present(hub.tunnel('dev-a'), 'the serving daemon').rpc('exec', ['hostname'])).toEqual({ signedIn: false });

    expect(hub.hello('dev-a', DEVICE_PROTOCOL_VERSION - 1, DEVICE_FEATURES)).toBe('refused');
    expect(await daemon.closed).toBe(DEVICE_VERSION_REFUSAL_CLOSE);
    hub = new DeviceSocketHub(ctx);
    await expect(hub.chatgpt('dev-a', DEVICE_METHOD.chatgptStatus)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(hub.relay('dev-a', 'relay-after-wake', { method: 'GET', url: 'https://chatgpt.com/backend-api/models', headers: [], body: null }))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  test('a socket close rejects its in-flight calls; liveness follows the socket', async () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    const ws = fakeSocket();
    admitted(hub, 'dev-a', ws);
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
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
    admitted(hub, 'dev-a', first);
    admitted(hub, 'dev-a', second); // closes `first`; its close event arrives later
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
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
    admitted(hub, 'dev-a', ws);
    hub.close('dev-a', 'device revoked');
    expect(ws.closed).toEqual([{ code: 1000, reason: 'device revoked' }]);
    expect(hub.isConnected('dev-a')).toBe(false);
  });

  test('revocation closes every live peer of one machine while another still answers', async () => {
    const ctx = peerContext();
    const hub = new DeviceSocketHub(ctx);
    const first = answeringPeer('dev-a', () => hub, 'revoked machine');
    const duplicate = answeringPeer('dev-a', () => hub, 'duplicate daemon');
    const sibling = answeringPeer('dev-b', () => hub, 'other machine');
    admitted(hub, 'dev-a', first.socket);
    stray(ctx, duplicate.socket, 'dev-a');
    stray(ctx, socketPeer(undefined, false).socket, 'dev-a');
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
    admitted(hub, 'dev-b', sibling.socket);
    hub.hello('dev-b', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
    const revoked = present(hub.tunnel('dev-a'), 'the machine before revocation');
    expect(await revoked.rpc('exec', ['hostname'])).toBe('revoked machine');

    hub.close('dev-a', 'device revoked');
    expect(await first.closed).toBe(1000);
    expect(await duplicate.closed).toBe(1000);
    await expect(revoked.rpc('exec', ['hostname'])).rejects.toMatchObject({ code: 'unavailable' });
    expect(await present(hub.tunnel('dev-b'), 'the other machine').rpc('exec', ['hostname'])).toBe('other machine');
  });
});

describe('DeviceTerminalHub socket ownership', () => {
  test('distinct panes survive a wake, refuse a sibling attach and keep their own bytes', async () => {
    const ctx = peerContext();
    const hub = new DeviceSocketHub(ctx);
    const terminals = new DeviceTerminalHub(ctx, hub);
    let serving = terminals;

    const daemon = socketPeer((data) => {
      const input = v.parse(v.object({ type: v.literal(DEVICE_FRAMES.ptyInput), session: v.string(), data: v.string() }), JSON.parse(v.parse(v.string(), data)));
      serving.toPane('dev-a', input.session, Buffer.from(input.data, 'base64'));
    });

    const first = socketPeer();
    const second = socketPeer();
    admitted(hub, 'dev-a', daemon.socket);
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);

    terminals.register('token-a', { session: 'pty-a', device: 'dev-a', workspace: 'workspace-a' });
    terminals.register('token-b', { session: 'pty-b', device: 'dev-a', workspace: 'workspace-b' });
    terminals.attach('token-a', first.socket);
    terminals.attach('token-b', second.socket);
    expect([await first.receive(), await second.receive()].map((frame) => JSON.parse(v.parse(v.string(), frame)))).toMatchObject([{ type: 'ready' }, { type: 'ready' }]);

    serving = new DeviceTerminalHub(ctx, hub);
    await expect(Promise.resolve().then(() => serving.attach('token-a', socketPeer().socket))).rejects.toMatchObject({ code: 'missing' });
    const firstBytes = new Uint8Array([0, 255, 13]);
    const secondBytes = new Uint8Array([27, 91, 65]);
    serving.fromPane({ session: 'pty-a', device: 'dev-a', workspace: 'workspace-a' }, firstBytes);
    serving.fromPane({ session: 'pty-b', device: 'dev-a', workspace: 'workspace-b' }, secondBytes);
    expect(new Uint8Array(v.parse(v.instance(Uint8Array), await first.receive()))).toEqual(firstBytes);
    expect(new Uint8Array(v.parse(v.instance(Uint8Array), await second.receive()))).toEqual(secondBytes);

    serving.paneExit('dev-a', 'pty-a', 17);
    expect(JSON.parse(v.parse(v.string(), await first.receive()))).toMatchObject({ type: 'exit', exitCode: 17 });
    expect(await first.closed).toBe(1000);
    serving.fromPane({ session: 'pty-b', device: 'dev-a', workspace: 'workspace-b' }, secondBytes);
    expect(new Uint8Array(v.parse(v.instance(Uint8Array), await second.receive()))).toEqual(secondBytes);

    serving.endPane('dev-a', 'pty-b', 'device revoked');
    expect(JSON.parse(v.parse(v.string(), await second.receive()))).toMatchObject({ type: 'error' });
    expect(await second.closed).toBe(1000);
  });
});

/** A daemon's socket that records each frame the hub tells it. */
function toldDaemon() {
  const told: JsonValue[] = [];

  return { told, socket: socketPeer((data) => { told.push(v.parse(JsonValueSchema, JSON.parse(v.parse(v.string(), data)))); }).socket };
}

// 1014-t: a PC's terminal is a named session that outlives its pane. Its pane closing detaches it on the machine; a new
// token attaches the next pane to it; and its bytes reach only the device's own pane of that name.
describe('a named session on a device', () => {
  test('a pane closing detaches its session, and the next token attaches a new pane to it; one pane at a time', async () => {
    const ctx = peerContext();
    const hub = new DeviceSocketHub(ctx);
    const terminals = new DeviceTerminalHub(ctx, hub);
    const { told, socket } = toldDaemon();
    const shell = { session: 'pty-shell', device: 'dev-a', workspace: 'workspace-a' };

    admitted(hub, 'dev-a', socket);
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
    const firstPane = socketPeer();

    terminals.register('token-1', shell);
    terminals.attach('token-1', firstPane.socket);
    terminals.register('token-2', shell);
    expect(() => terminals.attach('token-2', socketPeer().socket)).toThrow('that terminal is already open in another tab');
    // The account object refuses such an open before it mints a token (unit-device-sessions); here the token goes.
    terminals.forget('token-2');

    terminals.paneClosed('dev-a', 'pty-shell', firstPane.socket);
    expect(told).toEqual([{ type: DEVICE_FRAMES.ptyDetach, session: 'pty-shell' }]);

    const next = socketPeer();

    // The first pane's socket is gone; the next token is minted, and the resumed session's kept output waits for it.
    ctx.getWebSockets(`terminal:dev-a:pty-shell`)[0]?.close(1000, 'gone');
    terminals.register('token-3', shell);
    terminals.toPane('dev-a', 'pty-shell', new Uint8Array(Buffer.from('kept output')));
    terminals.attach('token-3', next.socket);
    expect(JSON.parse(v.parse(v.string(), await next.receive()))).toMatchObject({ type: 'ready' });
    expect(Buffer.from(v.parse(v.instance(Uint8Array), await next.receive())).toString()).toBe('kept output');
  });

  test("a late close from a pane another has replaced leaves the session attached to the new one", async () => {
    const ctx = peerContext();
    const hub = new DeviceSocketHub(ctx);
    const terminals = new DeviceTerminalHub(ctx, hub);
    const { told, socket } = toldDaemon();
    const shell = { session: 'pty-shell', device: 'dev-a', workspace: 'workspace-a' };

    admitted(hub, 'dev-a', socket);
    hub.hello('dev-a', DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);
    terminals.register('token-old', shell);
    terminals.attach('token-old', socketPeer().socket);
    ctx.getWebSockets('terminal:dev-a:pty-shell')[0]?.close(1000, 'reconnected');
    terminals.register('token-new', shell);
    terminals.attach('token-new', socketPeer().socket);

    // The old pane's close callback runs only now.
    terminals.paneClosed('dev-a', 'pty-shell');
    expect(told).toEqual([]);
  });

  test("a device's bytes for its session never reach another device's pane of the same name", async () => {
    const ctx = peerContext();
    const terminals = new DeviceTerminalHub(ctx, new DeviceSocketHub(ctx));
    const mine = socketPeer();
    const seen: string[] = [];
    const other = socketPeer((data) => { seen.push(typeof data === 'string' ? data : Buffer.from(v.parse(v.instance(Uint8Array), data)).toString()); });

    terminals.register('token-a', { session: 'pty-shell', device: 'dev-a', workspace: 'workspace-a' });
    terminals.register('token-b', { session: 'pty-shell', device: 'dev-b', workspace: 'workspace-a' });
    terminals.attach('token-a', mine.socket);
    terminals.attach('token-b', other.socket);
    terminals.toPane('dev-a', 'pty-shell', new Uint8Array(Buffer.from('for dev-a')));

    expect(JSON.parse(v.parse(v.string(), await mine.receive()))).toMatchObject({ type: 'ready' });
    expect(Buffer.from(v.parse(v.instance(Uint8Array), await mine.receive())).toString()).toBe('for dev-a');
    expect(seen.filter((frame) => !frame.includes('ready'))).toEqual([]);
  });
});

// Production f9c17ac7b (2026-10-14): the shell's first bytes and its exit reached the hub before its pane attached
// and were dropped (`device.terminal_output_unclaimed`), so the pane opened blank, or closed without saying why.
describe('a device terminal before its pane attaches', () => {
  /** What a pane was sent, in order: a frame as its parsed type, bytes as text. */
  function pane() {
    const seen: string[] = [];
    const peer = socketPeer((data) => { seen.push(typeof data === 'string' ? v.parse(v.object({ type: v.string() }), JSON.parse(data)).type : Buffer.from(v.parse(v.instance(Uint8Array), data)).toString()); });

    return { ...peer, seen };
  }

  test('the pane gets what the shell drew first, then its end', async () => {
    const ctx = peerContext();
    const terminals = new DeviceTerminalHub(ctx, new DeviceSocketHub(ctx));
    const ended = pane();
    const drawn = pane();

    terminals.register('token-ended', { session: 'session-ended', device: 'dev-a', workspace: 'workspace-a' });
    terminals.toPane('dev-a', 'session-ended', new Uint8Array(Buffer.from('bwrap: it could not start')));
    terminals.paneExit('dev-a', 'session-ended', 1);
    terminals.attach('token-ended', ended.socket);
    expect(ended.seen).toEqual(['ready', 'bwrap: it could not start', 'exit']);
    expect(await ended.closed).toBe(1000);

    terminals.register('token-drawn', { session: 'session-drawn', device: 'dev-a', workspace: 'workspace-a' });
    terminals.toPane('dev-a', 'session-drawn', new Uint8Array(Buffer.from('user@machine:~$ ')));
    terminals.attach('token-drawn', drawn.socket);
    expect(drawn.seen).toEqual(['ready', 'user@machine:~$ ']);
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



  test('a transient failure leaves the question open for the next turn', async () => {
    const { hub, ws } = connected();

    const probing = hub.probeToolchain('dev-a', NOW);
    answerLast(hub, ws, { error: { code: 'io', message: 'EIO reading /usr/bin' } });
    expect(await probing).toBeNull();

    const reprobing = hub.probeToolchain('dev-a', NOW + 1);
    expect(ws.sent).toHaveLength(2);
    answerLast(hub, ws, { error: { code: 'io', message: 'EIO reading /usr/bin' } });
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
    admitted(hub, 'dev-a', fakeSocket());
    expect(hub.toolchain('dev-a', NOW)).toBeNull();
  });

  test('an offline device is not asked at all', async () => {
    const ctx = fakeCtx();
    const hub = new DeviceSocketHub(ctx);
    expect(await hub.probeToolchain('dev-a', NOW)).toBeNull();
    expect(hub.toolchain('dev-a', NOW)).toBeNull();
  });
});

describe('DeviceSocketHub Codex relay', () => {
  const RelayCallSchema = v.object({
    id: v.string(), method: v.literal(DEVICE_METHOD.codexRelay),
    params: v.tuple([v.object({ method: v.string(), url: v.string(), headers: v.array(v.tuple([v.string(), v.string()])), body: v.nullable(v.string()) })]),
  });

  const REQUEST = {
    method: 'POST', url: 'https://chatgpt.com/backend-api/codex/responses',
    headers: [['authorization', 'Bearer access-1']] satisfies [string, string][], body: '{"input":[]}',
  };

  function relayCall(ws: FakeSocket) {
    return v.parse(RelayCallSchema, JSON.parse(ws.sent[ws.sent.length - 1] ?? 'null'));
  }

  const encode = (text: string) => Buffer.from(text).toString('base64');

  test('the answer streams chunk by chunk while the machine is still fetching', async () => {
    const { hub, ws } = connected();
    const relaying = hub.relay('dev-a', 'relay-1', REQUEST);
    const call = relayCall(ws);

    expect(call.id).toBe('relay-1');
    expect(call.params[0]).toEqual(REQUEST);

    hub.handleMessage('dev-a', JSON.stringify({ type: DEVICE_FRAMES.relayHead, relay: 'relay-1', status: 200, headers: [['content-type', 'text/event-stream']] }));
    hub.handleMessage('dev-a', JSON.stringify({ type: DEVICE_FRAMES.relayBody, relay: 'relay-1', data: encode('data: one\n\n') }));
    const response = await relaying;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    if (response.body === null) throw new Error('a streamed answer arrived with no body');

    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n');

    hub.handleMessage('dev-a', JSON.stringify({ type: DEVICE_FRAMES.relayBody, relay: 'relay-1', data: encode('data: two\n\n') }));
    hub.handleMessage('dev-a', JSON.stringify({ id: 'relay-1', result: { bytes: 22 } }));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: two\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  test('a Stop tells the machine to drop the upstream call and fails the body', async () => {
    const { hub, ws } = connected();
    const relaying = hub.relay('dev-a', 'relay-2', REQUEST);
    hub.handleMessage('dev-a', JSON.stringify({ type: DEVICE_FRAMES.relayHead, relay: 'relay-2', status: 200, headers: [] }));
    const response = await relaying;

    const stopping = hub.cancelRelay('relay-2');
    expect(JSON.parse(ws.sent[ws.sent.length - 1] ?? 'null')).toEqual({ id: expect.any(String), method: DEVICE_METHOD.cancel, params: ['relay-2'] });
    const cancel = v.parse(v.object({ id: v.string() }), JSON.parse(ws.sent[ws.sent.length - 1] ?? 'null'));
    hub.handleMessage('dev-a', JSON.stringify({ id: cancel.id, result: { requestId: 'relay-2', cancelled: 'terminated' } }));
    await stopping;
    await expect(response.text()).rejects.toThrow('the caller stopped the request');
  });

  test('a machine that drops mid-answer fails the body, never ends it as if complete', async () => {
    const { hub, ws } = connected();
    const relaying = hub.relay('dev-a', 'relay-3', REQUEST);
    hub.handleMessage('dev-a', JSON.stringify({ type: DEVICE_FRAMES.relayHead, relay: 'relay-3', status: 200, headers: [] }));
    hub.handleMessage('dev-a', JSON.stringify({ type: DEVICE_FRAMES.relayBody, relay: 'relay-3', data: encode('data: half') }));
    const response = await relaying;

    ws.readyState = 3;
    hub.handleClose('dev-a', ws);
    await expect(response.text()).rejects.toThrow(TUNNEL_DISCONNECTED);
  });

  test('an error before any answer rejects the call with the machine\'s words', async () => {
    const { hub } = connected();
    const relaying = hub.relay('dev-a', 'relay-4', REQUEST);
    hub.handleMessage('dev-a', JSON.stringify({ id: 'relay-4', error: { code: 'io', message: 'chatgpt.com unreachable from this machine' } }));

    await expect(relaying).rejects.toThrow('chatgpt.com unreachable from this machine');
  });



  test('a reader that stops reading tells the machine to drop the upstream call', async () => {
    const { hub, ws } = connected();
    const relaying = hub.relay('dev-a', 'relay-6', REQUEST);
    hub.handleMessage('dev-a', JSON.stringify({ type: DEVICE_FRAMES.relayHead, relay: 'relay-6', status: 200, headers: [] }));
    const response = await relaying;

    const leaving = response.body?.cancel(new DOMException('the reader left', 'AbortError'));
    const cancel = v.parse(v.object({ id: v.string() }), JSON.parse(ws.sent[ws.sent.length - 1] ?? 'null'));
    hub.handleMessage('dev-a', JSON.stringify({ id: cancel.id, result: { requestId: 'relay-6', cancelled: 'terminated' } }));
    await leaving;
    expect(ws.sent.map((frame) => JSON.parse(frame))).toContainEqual({ id: expect.any(String), method: DEVICE_METHOD.cancel, params: ['relay-6'] });
    // What the machine sent before it heard is dropped, not written into a cancelled body.
    hub.handleMessage('dev-a', JSON.stringify({ type: DEVICE_FRAMES.relayBody, relay: 'relay-6', data: 'bGF0ZQ==' }));
    hub.handleMessage('dev-a', JSON.stringify({ id: 'relay-6', result: { bytes: 4 } }));
    expect(ws.sent.filter((frame) => frame.includes(DEVICE_METHOD.cancel))).toHaveLength(1);
  });



  test('no machine online picks none', () => {
    expect(new DeviceSocketHub(fakeCtx()).relayDevice()).toBeNull();
  });
});

/** The web asks each machine whether it holds a ChatGPT sign-in before routing the plan or listing its models. */
describe('DeviceSocketHub ChatGPT sign-in calls', () => {
  function answerLast(hub: DeviceSocketHub, ws: FakeSocket, reply: Record<string, JsonValue>) {
    const frame = v.parse(v.object({ id: v.string(), method: v.string() }), JSON.parse(ws.sent[ws.sent.length - 1] ?? 'null'));

    hub.handleMessage('dev-a', JSON.stringify({ id: frame.id, ...reply }));

    return frame;
  }

  test('a machine that fails to say is not signed in; a daemon without the calls is the same', async () => {
    const { hub, ws } = connected();

    const failing = hub.chatgpt('dev-a', DEVICE_METHOD.chatgptStatus);
    expect(answerLast(hub, ws, { error: { code: 'io', message: 'EIO reading pc-agent.chatgpt.json' } }).method).toBe('chatgptStatus');
    expect(await failing).toBeNull();

    const older = hub.chatgpt('dev-a', DEVICE_METHOD.chatgptStatus);
    answerLast(hub, ws, { error: { code: DEVICE_ERRORS.unknownMethod, message: 'unknown method: chatgptStatus' } });
    expect(await older).toBeNull();
  });

  // No deadline rides these calls: the machine's answer ends one, or the machine going.
  test('a machine that goes while it is asked is not signed in', async () => {
    const { hub, ws } = connected();
    const asked = hub.chatgpt('dev-a', DEVICE_METHOD.chatgptStatus);

    hub.handleClose('dev-a', ws);
    expect(await asked).toBeNull();
  });

  test('a sign-in the machine could not start keeps its failure', async () => {
    const { hub, ws } = connected();

    const starting = hub.chatgpt('dev-a', DEVICE_METHOD.chatgptSignIn).then(() => '', (...rejection: [unknown]) => renderThrownChain({ cause: rejection[0] }));
    answerLast(hub, ws, { error: { code: 'io', message: 'EADDRINUSE 127.0.0.1' } });

    expect(await starting).toContain('EADDRINUSE 127.0.0.1');
  });
});

describe('/pc/connect upgrade wiring', () => {
  test('the UserDO answers /pc/connect itself, and the socket it accepts serves nothing before AUTH', async () => {
    const harness = createTestUserDO();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio tower');

    const notUpgraded = await harness.userDO.fetch(new Request(`https://kinu.example.com${DEVICE_CONNECT_PATH}`));
    expect(notUpgraded.status).toBe(426);
    expect(harness.acceptedSockets).toHaveLength(0);

    // No ticket in the URL: the upgrade is accepted, and is no device's until its first frame says whose.
    const socket = await openDeviceSocket(harness);
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner())).toMatchObject({ devices: [{ id: deviceId, connected: false }] });

    const issued = await buyTicket(harness, deviceId, key, '');

    if (!issued.ok) throw new Error(`the device was refused a ticket: ${issued.refusal}`);
    await harness.userDO.webSocketMessage(socket.ws, JSON.stringify({ type: DEVICE_FRAMES.auth, user: harness.userDO.name, ticket: issued.ticket }));
    expect(socket.closed()).toBeNull();
    expect(handedSecret(socket)).toMatch(DEVICE_CONNECT_SECRET);
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner())).toMatchObject({ devices: [{ id: deviceId, connected: true }] });

    expect('attachDeviceSocket' in harness.userDO).toBe(false);
    await harness.joinFibers();
    harness.close();
  });

  test('a first frame that is no AUTH, or an AUTH whose ticket is forged, used or for another account, closes 4401', async () => {
    const harness = createTestUserDO();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio tower');
    const issued = await buyTicket(harness, deviceId, key, '');

    if (!issued.ok) throw new Error(`the device was refused a ticket: ${issued.refusal}`);
    const auth = (user: string, ticket: string) => JSON.stringify({ type: DEVICE_FRAMES.auth, user, ticket });

    const firstFrames = [
      JSON.stringify({ ...CAPABLE_HELLO }),
      'ping',
      auth(harness.userDO.name, `pct_${'f'.repeat(43)}`),
      auth('0123456789abcdef0123456789abcdef', issued.ticket),
    ];

    for (const frame of firstFrames) {
      const socket = await openDeviceSocket(harness);
      await harness.userDO.webSocketMessage(socket.ws, frame);
      expect({ frame, closed: socket.closed()?.code }).toEqual({ frame, closed: DEVICE_CREDENTIALS_REJECTED_CLOSE });
      expect(socket.sent).toEqual([]);
    }

    // The ticket spent on the first socket opens no second.
    const first = await openDeviceSocket(harness);
    await harness.userDO.webSocketMessage(first.ws, auth(harness.userDO.name, issued.ticket));
    expect(first.closed()).toBeNull();
    const second = await openDeviceSocket(harness);
    await harness.userDO.webSocketMessage(second.ws, auth(harness.userDO.name, issued.ticket));
    expect(second.closed()?.code).toBe(DEVICE_CREDENTIALS_REJECTED_CLOSE);
    await harness.joinFibers();
    harness.close();
  });

  test('a socket that sends no AUTH within the deadline closes 4408, and one that did is left alone', () => {
    const ctx = fakeCtx();
    const clock = handClock(1_000);
    const hub = new DeviceSocketHub(ctx, clock);
    const silent = fakeSocket();
    const authed = fakeSocket();

    hub.acceptUnauthenticated(silent);
    hub.acceptUnauthenticated(authed);
    clock.advance(DEVICE_AUTH_DEADLINE_MS - 1);
    hub.admit('dev-a', authed);
    expect(silent.closed).toEqual([]);

    clock.advance(1);
    expect(silent.closed).toEqual([{ code: DEVICE_AUTH_DEADLINE_CLOSE, reason: 'no AUTH frame arrived in time' }]);
    expect(authed.closed).toEqual([]);
    expect(hub.isConnected('dev-a')).toBe(true);
    // A wake loses the timer (its clock's never fire here); the deadline on the socket holds when its frame arrives.
    const late = fakeSocket();
    new DeviceSocketHub(ctx, handClock(clock.now())).acceptUnauthenticated(late);
    clock.advance(DEVICE_AUTH_DEADLINE_MS);
    expect(new DeviceSocketHub(ctx, clock).withinAuthDeadline(late)).toBe(false);
    expect(late.closed).toEqual([{ code: DEVICE_AUTH_DEADLINE_CLOSE, reason: 'no AUTH frame arrived in time' }]);
  });
});

describe('device links expire on an absolute window, renewed by each accepted connect', () => {
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

  test('a freshly linked device carries a window; a ticket alone does not extend it, an accepted connect does', async () => {
    const harness = createTestUserDO();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio tower');
    expect(storedExpiry(harness, deviceId)).toBeGreaterThan(Date.now());

    const anchor = Date.now() + day;
    ageDevice(harness, deviceId, anchor);
    expect(await buyTicket(harness, deviceId, key, '')).toMatchObject({ ok: true });
    expect(storedExpiry(harness, deviceId)).toBe(anchor);

    await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: true });
    expect(storedExpiry(harness, deviceId)).toBeGreaterThan(anchor + 100 * day);
    await harness.joinFibers();
    harness.close();
  });

  test('a device that stopped connecting is refused a ticket in words that say so', async () => {
    const harness = createTestUserDO();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'device');
    ageDevice(harness, deviceId, Date.now() - day);

    expect(await buyTicket(harness, deviceId, key, '')).toEqual({ ok: false, refusal: 'expired' });
    harness.close();
  });

  test('the listing reports the window so the owner can see a link about to lapse', async () => {
    const harness = createTestUserDO();
    const { deviceId } = await registerTestDevice(harness.userDO, 'device');
    ageDevice(harness, deviceId, 12345);
    expect(await harness.userDO.listDevices(await testOwner()))
      .toMatchObject([{ id: deviceId, expiresAt: 12345 }]);
    harness.close();
  });

  test('the runtime status separates "no device" from "registered but away", with nothing claimed', async () => {
    const harness = createTestUserDO();
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner())).toEqual({ devices: [] });

    const { deviceId } = await registerTestDevice(harness.userDO, 'studio tower');
    // No toolchain offline, never an empty set (the model would read "runs nothing"); the row stays named so the
    // agent can ask for it.
    expect(await harness.userDO.deviceRuntimeStatus(await testOwner())).toEqual({
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
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio tower');
    const device = await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: true });

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
      .toMatchObject({ devices: [{ id: deviceId, connected: true }] });

    await harness.joinFibers();
    harness.close();
  });

  test('a pasted "ping" on a terminal pane is keystrokes, never an answered probe', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    const { deviceId, device } = await connectDevice(harness);
    await harness.userDO.webSocketMessage(device.ws, JSON.stringify(CAPABLE_HELLO));
    harness.grantDevice(WORKSPACE, deviceId);

    // The open frame is answered by hand: this socket pair has no far end.
    const opening = harness.userDO.openDeviceTerminal({ workspaceToken: workspace }, WORKSPACE, { cols: 80, rows: 24 }, { session: 'pty-shell' });

    for (let turn = 0; turn < 100; turn += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      const openRaw = device.sent.find((raw) => raw.includes(`"${DEVICE_METHOD.ptyOpen}"`));

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
      v.object({ type: v.literal(DEVICE_FRAMES.ptyInput), session: v.string(), data: v.string() }),
      JSON.parse(raw),
    ));

    expect({ token: session.startsWith('pty-') && session !== 'pty-shell', typed }).toEqual({ token: true, typed: [{ type: DEVICE_FRAMES.ptyInput, session: 'pty-shell', data: 'cGluZw==' }] });

    await harness.joinFibers();
    harness.close();
  });
});
