/**
 * A device command's output reaches its workspace through a function the workspace passed over DO RPC: the hub calls
 * that stub from its device-socket message handler, a later event than the call that received it, while the call is
 * still pending. Executed here because the bun fakes have no RPC to answer from.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

/** The client half is kept: workerd closes the connection when an unreferenced client end is collected. */
const clients = new Set<WebSocket>();

const ExecFrameSchema = v.object({ id: v.string(), method: v.string(), output: v.optional(v.boolean()) });

const BUILT = { stdout: 'building\nbuilt\n', stderr: 'warn\n', exitCode: 0 };

/** The daemon's name for the frame; unit-pc-agent-exec pins the daemon's frames reaching the hub's tunnel. */
const DEVICE_EXEC_OUTPUT = 'EXEC_OUT';

const chunk = (stream: 'stdout' | 'stderr', text: string) => ({ stream, data: btoa(text) });

/** The machine's end, as the daemon answers: a frame per window for a hub that asked, then the result. An older
 *  daemon sends no output; the asks are what each exec frame said about output. */
async function connectDevice(hub: string, daemon: 'current' | 'older' = 'current'): Promise<Array<boolean | undefined>> {
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

    if (frame.output.output === true && daemon === 'current') {
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

  it('answers from an older daemon, which sends no output', async () => {
    await connectDevice('hub-older', 'older');
    const workspace = env.DEVICE_OUTPUT_WORKSPACE_PROBE.get(env.DEVICE_OUTPUT_WORKSPACE_PROBE.idFromName('workspace-older'));

    expect(await workspace.watch('hub-older')).toEqual({ answer: BUILT, heard: [], unsent: 0 });
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
});
