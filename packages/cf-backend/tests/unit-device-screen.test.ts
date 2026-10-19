/**
 * A PC's screen through the owner's account object (1014-t): opened only through `deviceRpc`, its bytes relayed unread
 * as binary messages on both sockets, each data frame on the device socket numbered by its stream, and every way a
 * stream ends reaching the other side. The daemon's frames are made by the daemon's own encoder.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import * as v from 'valibot';
import {
  DEVICE_CONNECT_PATH, DEVICE_FRAMES, DEVICE_METHOD, DEVICE_SCREEN_PATH, readScreenData, type JsonValue,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { CAPABLE_HELLO, createTestUserDO, provisionTestWorkspace, testOwner, type AcceptedSocket, type TestUserDO } from './helpers/user-do';

/** The daemon's screen module, CommonJS as the daemon runs it, read at its boundary. */
const DaemonScreenSchema = v.object({ screenFrames: v.pipe(v.function(), v.returns(v.array(v.instance(Uint8Array)))) });

const { screenFrames: daemonFrames } = v.parse(DaemonScreenSchema, createRequire(import.meta.url)('../../pc-agent/src/daemon/screen.js'));

function screenDataFrames(stream: number, bytes: Uint8Array): Uint8Array[] {
  return daemonFrames(stream, bytes);
}

const WORKSPACE = 'screen-workspace';

const READY = { state: 'ready', width: 1512, height: 982 } as const;

const ScreenOpenSchema = v.object({ id: v.string(), method: v.literal(DEVICE_METHOD.screenOpen), params: v.tuple([v.number()]) });

const ScreenCloseSchema = v.object({ type: v.literal(DEVICE_FRAMES.screenClose), stream: v.number() });

async function connectDevice(harness: TestUserDO, hello: JsonValue = { ...CAPABLE_HELLO, desktop: READY }) {
  const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'studio tower');
  const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), token);

  if (!issued.ok || !issued.ticket) throw new Error('the owner could not mint a connect ticket');

  const response = await harness.userDO.fetch(new Request(
    `https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`,
    { headers: { Upgrade: 'websocket' } },
  ));

  if (response.status !== 101) throw new Error(`the device upgrade was refused with ${response.status}`);
  const device = present(harness.acceptedSockets.at(-1), 'the device socket');

  await harness.userDO.webSocketMessage(device.ws, JSON.stringify(hello));

  return { deviceId, device };
}

/** Opens the screen as the route does, answering the daemon's side by hand: this socket pair has no far end. */
async function openScreen(harness: TestUserDO, device: AcceptedSocket, workspace: string, deviceId: string) {
  const from = device.sent.length;
  const opening = harness.userDO.openDeviceScreen({ workspaceToken: workspace }, WORKSPACE, deviceId);
  let stream: number | null = null;

  for (let turn = 0; turn < 100 && stream === null; turn += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const raw = device.sent.slice(from).find((sent) => sent.includes(`"${DEVICE_METHOD.screenOpen}"`));

    if (raw === undefined) continue;
    const open = v.parse(ScreenOpenSchema, JSON.parse(raw));

    stream = open.params[0];

    // The RFB version, sent before the viewer attaches, as a daemon sends it the moment its stream opens.
    for (const frame of screenDataFrames(stream, new TextEncoder().encode('RFB 003.008\n'))) await harness.userDO.webSocketMessage(device.ws, frame);
    await harness.userDO.webSocketMessage(device.ws, JSON.stringify({ id: open.id, result: { stream } }));
  }

  const { session } = await opening;

  return { session, stream: present(stream ?? undefined, 'the stream screenOpen named') };
}

async function attachViewer(harness: TestUserDO, session: string) {
  const response = await harness.userDO.fetch(new Request(
    `https://kinu.example.com${DEVICE_SCREEN_PATH}?session=${session}`,
    { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'binary' } },
  ));

  return { response, viewer: response.status === 101 ? present(harness.acceptedSockets.at(-1), 'the viewer socket') : null };
}

async function granted() {
  const harness = createTestUserDO();
  const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Screen workspace');
  const { deviceId, device } = await connectDevice(harness);

  harness.grantDevice(WORKSPACE, deviceId);

  return { harness, workspace, deviceId, device };
}

function text(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes);
}

describe("a PC's screen through the owner's account", () => {
  test('the screen crosses as binary both ways, unread, each device frame numbered by its stream', async () => {
    const { harness, workspace, deviceId, device } = await granted();
    const { session, stream } = await openScreen(harness, device, workspace, deviceId);
    const { response, viewer } = await attachViewer(harness, session);

    expect({ status: response.status, protocol: response.headers.get('Sec-WebSocket-Protocol') }).toEqual({ status: 101, protocol: 'binary' });
    // What the daemon sent before the viewer came, the viewer gets first.
    expect(present(viewer, 'the viewer').binary.map(text)).toEqual(['RFB 003.008\n']);

    const before = device.binary.length;
    await harness.userDO.webSocketMessage(present(viewer, 'the viewer').ws, new TextEncoder().encode('RFB 003.008\n'));
    const relayed = device.binary.slice(before).map((frame) => readScreenData(frame));

    expect(relayed.map((frame) => ({ stream: frame?.stream, bytes: text(frame?.bytes) }))).toEqual([{ stream, bytes: 'RFB 003.008\n' }]);

    // A frame wider than one tunnel message reaches the viewer whole, frame by frame.
    const big = new Uint8Array(70_000).fill(5);

    for (const frame of screenDataFrames(stream, big)) await harness.userDO.webSocketMessage(device.ws, frame);
    expect(present(viewer, 'the viewer').binary.slice(1).map((bytes) => bytes.byteLength)).toEqual([65_536, 4_464]);

    // A text message from a viewer is no RFB: it is dropped, and nothing reaches the PC.
    const quiet = device.binary.length;
    await harness.userDO.webSocketMessage(present(viewer, 'the viewer').ws, 'ping');
    expect({ binary: device.binary.length, sent: device.sent.at(-1)?.includes('ping') }).toEqual({ binary: quiet, sent: false });

    await harness.joinFibers();
    harness.close();
  });

  test("the PC closing its stream closes the viewer in the PC's words; the viewer closing closes the stream", async () => {
    const { harness, workspace, deviceId, device } = await granted();
    const first = await openScreen(harness, device, workspace, deviceId);
    const { viewer } = await attachViewer(harness, first.session);

    await harness.userDO.webSocketMessage(device.ws, JSON.stringify({ type: DEVICE_FRAMES.screenClose, stream: first.stream, reason: 'the screen opened in another tab' }));
    expect(present(viewer, 'the viewer').closed()).toEqual({ code: 1000, reason: 'the screen opened in another tab' });

    const second = await openScreen(harness, device, workspace, deviceId);
    const attached = present((await attachViewer(harness, second.session)).viewer, 'the second viewer');
    const sent = device.sent.length;

    await harness.userDO.webSocketClose(attached.ws, 1001, 'tab closed', true);
    expect(device.sent.slice(sent).map((raw) => v.parse(ScreenCloseSchema, JSON.parse(raw)))).toEqual([{ type: DEVICE_FRAMES.screenClose, stream: second.stream }]);

    await harness.joinFibers();
    harness.close();
  });

  test('a session attaches once; bytes for a stream nobody holds close it on the PC', async () => {
    const { harness, workspace, deviceId, device } = await granted();
    const { session, stream } = await openScreen(harness, device, workspace, deviceId);

    expect((await attachViewer(harness, session)).response.status).toBe(101);
    expect((await attachViewer(harness, session)).response.status).toBe(409);

    const sent = device.sent.length;

    for (const frame of screenDataFrames(stream + 1, new Uint8Array([1, 2, 3]))) await harness.userDO.webSocketMessage(device.ws, frame);
    expect(device.sent.slice(sent).map((raw) => v.parse(ScreenCloseSchema, JSON.parse(raw)))).toEqual([{ type: DEVICE_FRAMES.screenClose, stream: stream + 1 }]);

    await harness.joinFibers();
    harness.close();
  });

  test("the PC's socket dropping closes its viewer", async () => {
    const { harness, workspace, deviceId, device } = await granted();
    const { session } = await openScreen(harness, device, workspace, deviceId);
    const { viewer } = await attachViewer(harness, session);

    device.drop();
    await harness.userDO.webSocketClose(device.ws, 1006, '', false);
    expect(present(viewer, 'the viewer').closed()?.code).toBe(1000);

    await harness.joinFibers();
    harness.close();
  });

  test("a workspace without the PC's grant opens nothing on it", async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Screen workspace');
    const { deviceId, device } = await connectDevice(harness);

    await expect(harness.userDO.openDeviceScreen({ workspaceToken: workspace }, WORKSPACE, deviceId)).rejects.toThrow();
    expect(device.sent.some((raw) => raw.includes(`"${DEVICE_METHOD.screenOpen}"`))).toBe(false);

    await harness.joinFibers();
    harness.close();
  });

  test('the roster shows the screen the last HELLO reported; one the hub cannot read is none', async () => {
    const harness = createTestUserDO();
    const { device } = await connectDevice(harness);
    const desktop = async () => (await harness.userDO.listDevices(await testOwner()))[0]?.desktop;

    expect(await desktop()).toEqual(READY);

    await harness.userDO.webSocketMessage(device.ws, JSON.stringify({ ...CAPABLE_HELLO, desktop: { state: 'setup', detail: 'Install the Command Line Tools (xcode-select --install)' } }));
    expect(await desktop()).toEqual({ state: 'setup', detail: 'Install the Command Line Tools (xcode-select --install)' });

    await harness.userDO.webSocketMessage(device.ws, JSON.stringify({ ...CAPABLE_HELLO, desktop: { state: 'ready', width: 0, height: 982 } }));
    expect(await desktop()).toEqual({ state: 'none' });

    await harness.joinFibers();
    harness.close();
  });
});
