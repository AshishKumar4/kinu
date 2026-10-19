/**
 * A PC's named terminal sessions through the owner's account object (1014-t): the daemon keeps them per workspace, so
 * every call carries the proven workspace; the strip reads them as the computer's rows; a pane opens its session by a
 * fresh single-use token, and its closing detaches the session on the machine rather than ending it.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { DEVICE_FRAMES, DEVICE_METHOD, DEVICE_TERMINAL_PATH, type JsonValue } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { deviceHarness, daemon, OTHER_WORKSPACE, WORKSPACE } from './helpers/device-harness';
import type { DeviceFrame } from './helpers/user-do';

const SHELL = { id: 'pty-shell', name: 'shell', cwd: '/home/ashish/project', open: true, running: null };

/** The daemon's side of the session calls: one workspace's sessions, and a terminal that opens at once. */
function sessionsDaemon(frame: DeviceFrame): JsonValue {
  if (frame.method === DEVICE_METHOD.ptyList) return [SHELL, { ...SHELL, id: 'pty-build', name: 'build', open: false }];

  if (frame.method === DEVICE_METHOD.ptyCreate) return { id: 'pty-new', name: 'shell 2', cwd: null };

  if (frame.method === DEVICE_METHOD.ptyRename) return { id: v.parse(v.string(), frame.params[0]), name: v.parse(v.string(), frame.params[1]), cwd: '/home/ashish/project' };

  if (frame.method === DEVICE_METHOD.ptyClose) return null;

  if (frame.method === DEVICE_METHOD.ptyOpen) return { session: v.parse(v.string(), frame.params[2]), pid: 4242, cols: 80, rows: 24, resumed: true };

  return daemon(frame);
}

async function granted() {
  const harness = await deviceHarness('ashish@studio', sessionsDaemon);

  harness.grantDevice(WORKSPACE, harness.deviceId);

  return harness;
}

describe("a PC's named sessions", () => {
  test("the strip reads the daemon's sessions as the computer's rows, asked for the proven workspace", async () => {
    const harness = await granted();
    const listed = await harness.userDO.listDeviceSessions(harness.workspace, WORKSPACE, harness.deviceId);
    const asked = present(harness.deviceFrames.find((frame) => frame.method === DEVICE_METHOD.ptyList), 'the list call');

    expect({ listed, workspace: asked.workspace }).toEqual({
      listed: [
        { ...SHELL, last: null, ports: [], branch: null, needsInput: false },
        { ...SHELL, id: 'pty-build', name: 'build', open: false, last: null, ports: [], branch: null, needsInput: false },
      ],
      workspace: WORKSPACE,
    });

    expect(await harness.userDO.openDeviceSession(harness.workspace, WORKSPACE, harness.deviceId)).toEqual({ id: 'pty-new', name: 'shell 2', cwd: '' });
    expect(await harness.userDO.renameDeviceSession(harness.workspace, WORKSPACE, harness.deviceId, { id: 'pty-build', name: 'dev server' }))
      .toEqual({ id: 'pty-build', name: 'dev server', cwd: '/home/ashish/project' });
    await harness.userDO.closeDeviceSession(harness.workspace, WORKSPACE, harness.deviceId, 'pty-build');
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_METHOD.ptyClose).map((frame) => frame.params)).toEqual([['pty-build']]);

    await harness.closeDeviceHarness();
  });

  test("a workspace the PC was not given lists nothing on it, and the daemon is asked nothing", async () => {
    const harness = await granted();
    const sent = harness.deviceFrames.length;

    await expect(harness.userDO.listDeviceSessions(harness.sibling, OTHER_WORKSPACE, harness.deviceId)).rejects.toThrow();
    expect(harness.deviceFrames.slice(sent)).toEqual([]);

    await harness.closeDeviceHarness();
  });

  test('a pane opens its session by a fresh token, and its closing detaches the session rather than ending it', async () => {
    const harness = await granted();
    const { session: token } = await harness.userDO.openDeviceTerminal(harness.workspace, WORKSPACE, { cols: 80, rows: 24 }, { device: harness.deviceId, session: 'pty-build' });
    const open = present(harness.deviceFrames.find((frame) => frame.method === DEVICE_METHOD.ptyOpen), 'the open call');

    expect({ params: open.params, requestId: open.id === token, token: token !== 'pty-build', workspace: open.workspace })
      .toEqual({ params: [80, 24, 'pty-build'], requestId: true, token: true, workspace: WORKSPACE });

    const upgrade = await harness.userDO.fetch(new Request(`https://kinu.example.com${DEVICE_TERMINAL_PATH}?session=${token}`, { headers: { Upgrade: 'websocket' } }));
    const pane = present(harness.acceptedSockets.at(-1), 'the pane');

    expect(upgrade.status).toBe(101);
    // The tab closes its socket: the platform reports it closed, then calls the object.
    pane.drop();
    await harness.userDO.webSocketClose(pane.ws, 1001, 'tab closed', true);
    await harness.joinFibers();

    expect({
      detached: harness.devicePushes.filter((push) => push.type === DEVICE_FRAMES.ptyDetach),
      cancelled: harness.deviceFrames.some((frame) => frame.method === DEVICE_METHOD.cancel),
    }).toEqual({ detached: [expect.objectContaining({ type: DEVICE_FRAMES.ptyDetach, session: 'pty-build' })], cancelled: false });

    await harness.closeDeviceHarness();
  });

  test('a second open of a session a pane holds is refused before the machine is asked', async () => {
    const harness = await granted();
    const target = { device: harness.deviceId, session: 'pty-build' };
    const { session: token } = await harness.userDO.openDeviceTerminal(harness.workspace, WORKSPACE, { cols: 80, rows: 24 }, target);

    await harness.userDO.fetch(new Request(`https://kinu.example.com${DEVICE_TERMINAL_PATH}?session=${token}`, { headers: { Upgrade: 'websocket' } }));
    await expect(harness.userDO.openDeviceTerminal(harness.workspace, WORKSPACE, { cols: 120, rows: 40 }, target)).rejects.toThrow('that terminal is already open in another tab');
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_METHOD.ptyOpen).length).toBe(1);

    await harness.closeDeviceHarness();
  });

  test("a pane that names no session opens the workspace's first", async () => {
    const harness = await granted();

    await harness.userDO.openDeviceTerminal(harness.workspace, WORKSPACE, { cols: 80, rows: 24 }, { device: harness.deviceId });
    const open = present(harness.deviceFrames.find((frame) => frame.method === DEVICE_METHOD.ptyOpen), 'the open call');

    expect(open.params).toEqual([80, 24, 'pty-shell']);

    await harness.closeDeviceHarness();
  });
});
