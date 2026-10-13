/**
 * A device command's output reaches its workspace through a function the workspace passed over DO RPC: the hub calls
 * that stub from its device-socket message handler, a later event than the call that received it, while the call is
 * still pending. Executed here because the bun fakes have no RPC to answer from.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { DEVICE_FEATURES } from '@kinu.run/core';

/** The client half is kept: workerd closes the connection when an unreferenced client end is collected. */
const clients = new Set<WebSocket>();

const ExecFrameSchema = v.object({ id: v.string(), method: v.string(), output: v.optional(v.boolean()) });

const BUILT = { stdout: 'building\nbuilt\n', stderr: 'warn\n', exitCode: 0 };

/** The daemon's name for the frame; unit-pc-agent-exec pins the daemon's frames reaching the hub's tunnel. */
const DEVICE_EXEC_OUTPUT = 'EXEC_OUT';

const chunk = (stream: 'stdout' | 'stderr', text: string) => ({ stream, data: btoa(text) });

function closedSocket(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => { resolve({ code: event.code, reason: event.reason }); });
  });
}

/** The machine's end, as the daemon answers: a frame per window for a hub that asked, then the result. */
async function connectDevice(hub: string): Promise<Array<boolean | undefined>> {
  const asked: Array<boolean | undefined> = [];
  const object = env.DEVICE_OUTPUT_HUB_PROBE.get(env.DEVICE_OUTPUT_HUB_PROBE.idFromName(hub));
  const response = await object.fetch('https://hub/', { headers: { Upgrade: 'websocket' } });

  expect(response.status).toBe(101);
  const device = response.webSocket;

  if (device === null) throw new Error('the hub accepted no socket');
  device.accept();
  clients.add(device);

  device.addEventListener('message', (event) => {
    const frame = v.safeParse(ExecFrameSchema, JSON.parse(String(event.data)));

    if (!frame.success || frame.output.method !== 'exec') return;
    const request = frame.output.id;
    asked.push(frame.output.output);

    if (frame.output.output === true) {
      device.send(JSON.stringify({ type: DEVICE_EXEC_OUTPUT, request, chunks: [chunk('stdout', 'building\n')], dropped: 0 }));
      device.send(JSON.stringify({ type: DEVICE_EXEC_OUTPUT, request, chunks: [chunk('stderr', 'warn\n'), chunk('stdout', 'built\n')], dropped: 7 }));
    }

    device.send(JSON.stringify({ id: request, result: BUILT }));
  });

  return asked;
}

describe("a device command's output, over DO RPC", () => {
  it('reaches the workspace through the stub it passed, all of it before the answer', async () => {
    await connectDevice('hub-a');
    const workspace = env.DEVICE_OUTPUT_WORKSPACE_PROBE.get(env.DEVICE_OUTPUT_WORKSPACE_PROBE.idFromName('workspace-a'));

    expect(await workspace.watch('hub-a')).toEqual({
      answer: BUILT,
      heard: [
        { chunks: [chunk('stdout', 'building\n')], dropped: 0 },
        { chunks: [chunk('stderr', 'warn\n'), chunk('stdout', 'built\n')], dropped: 7 },
      ],
      unsent: 0,
    });
  });

  it('asks for none when nothing watches the call', async () => {
    const asked = await connectDevice('hub-unwatched');
    const workspace = env.DEVICE_OUTPUT_WORKSPACE_PROBE.get(env.DEVICE_OUTPUT_WORKSPACE_PROBE.idFromName('workspace-unwatched'));

    expect(await workspace.watch('hub-unwatched', 'none')).toEqual({ answer: BUILT, heard: [], unsent: 0 });
    expect(asked).toEqual([undefined]);
  });

  it('keeps the answer when the workspace cannot take the output, and logs each loss', async () => {
    const asked = await connectDevice('hub-reset');
    const workspace = env.DEVICE_OUTPUT_WORKSPACE_PROBE.get(env.DEVICE_OUTPUT_WORKSPACE_PROBE.idFromName('workspace-reset'));

    expect(await workspace.watch('hub-reset', 'reset')).toEqual({ answer: BUILT, heard: [], unsent: 2 });
    expect(asked).toEqual([true]);
  });

  it('keeps the working device after the platform refuses an attachment', async () => {
    await connectDevice('hub-attachment-refused');
    const object = env.DEVICE_OUTPUT_HUB_PROBE.get(env.DEVICE_OUTPUT_HUB_PROBE.idFromName('hub-attachment-refused'));

    await runInDurableObject(object, (instance) => {
      expect(() => instance.hello([...DEVICE_FEATURES, 'x'.repeat(32_768)])).toThrow();
    });

    const workspace = env.DEVICE_OUTPUT_WORKSPACE_PROBE.get(env.DEVICE_OUTPUT_WORKSPACE_PROBE.idFromName('workspace-attachment-refused'));
    expect(await workspace.watch('hub-attachment-refused', 'none')).toEqual({ answer: BUILT, heard: [], unsent: 0 });
  });

  it('replaces a real socket with the daemon close contract and routes only through its successor', async () => {
    const object = env.DEVICE_OUTPUT_HUB_PROBE.get(env.DEVICE_OUTPUT_HUB_PROBE.idFromName('hub-replacement'));
    const response = await object.fetch('https://hub/', { headers: { Upgrade: 'websocket' } });
    const first = response.webSocket;

    if (first === null) throw new Error('the first daemon was not accepted');
    first.accept();
    clients.add(first);

    const closed = closedSocket(first);

    await connectDevice('hub-replacement');
    expect((await closed).code).toBe(1000);

    const workspace = env.DEVICE_OUTPUT_WORKSPACE_PROBE.get(env.DEVICE_OUTPUT_WORKSPACE_PROBE.idFromName('workspace-replacement'));
    expect(await workspace.watch('hub-replacement', 'none')).toEqual({ answer: BUILT, heard: [], unsent: 0 });
  });

  it('finds separate real terminal panes from their attachments and keeps binary output and shell close semantics', async () => {
    await connectDevice('hub-terminal-panes');
    const object = env.DEVICE_OUTPUT_HUB_PROBE.get(env.DEVICE_OUTPUT_HUB_PROBE.idFromName('hub-terminal-panes'));
    const panes: WebSocket[] = [];

    for (const session of ['shell-a', 'shell-b']) {
      await object.registerTerminal(session);
      const response = await object.fetch(`https://hub/?session=${session}`, { headers: { Upgrade: 'websocket' } });
      const pane = response.webSocket;

      if (pane === null) throw new Error('the terminal pane was not accepted');
      pane.accept();
      pane.binaryType = 'arraybuffer';
      clients.add(pane);
      panes.push(pane);
    }

    const first = panes[0];
    const second = panes[1];

    const output = new Promise<Uint8Array>((resolve) => {
      first.addEventListener('message', (event) => { resolve(new Uint8Array(v.parse(v.instance(ArrayBuffer), event.data))); }, { once: true });
    });

    const bytes = new Uint8Array([0, 255, 13]);
    await object.terminalOutput('shell-a', bytes);
    expect(await output).toEqual(bytes);

    const exit = new Promise<string>((resolve) => {
      first.addEventListener('message', (event) => { resolve(String(event.data)); }, { once: true });
    });

    const closed = closedSocket(first);

    await object.terminalExit('shell-a', 17);
    expect(JSON.parse(await exit)).toEqual({ type: 'exit', exitCode: 17 });
    expect((await closed).code).toBe(1000);
    expect(second.readyState).toBe(WebSocket.OPEN);
  });
});
