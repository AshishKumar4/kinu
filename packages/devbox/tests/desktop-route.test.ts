// D70: the desktop route.
import { expect, test } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, harness } from './support/devbox-harness';

class DesktopBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override get previewHost(): string | undefined {
    return 'preview.test';
  }
}

const open = (headers: Record<string, string> = { upgrade: 'websocket', 'sec-websocket-protocol': 'binary' }) =>
  new Request('https://box/_devbox/desktop', { headers });

async function startedBox() {
  const made = harness(DesktopBox);
  await made.box.devboxStartup();

  return made;
}

test('an open starts the desktop first, then reaches its port with the subprotocol and an origin', async () => {
  const { box, container } = await startedBox();
  const reached: unknown[] = [];

  container.portAnswer = (port, request) => {
    reached.push({
      port, path: new URL(request.url).pathname, started: container.sequence.includes('desktop'),
      protocol: request.headers.get('sec-websocket-protocol'), origin: request.headers.get('origin') !== null,
    });

    return new Response('', { status: 200 });
  };

  expect((await box.fetch(open())).status).toBe(200);
  expect(reached).toEqual([{ port: 6080, path: '/websockify', started: true, protocol: 'binary', origin: true }]);
});

test('a desktop that does not start says why, and nothing reaches its port', async () => {
  const { box, container } = await startedBox();
  const reached: number[] = [];
  container.portAnswer = (port) => {
    reached.push(port);

    return new Response('', { status: 200 });
  };

  container.desktopStart = { stdout: '', stderr: '(EE) Fatal server error', exitCode: 1 };

  await expect(box.fetch(open())).rejects.toThrow('(EE) Fatal server error');
  expect(reached).toEqual([]);
});

test('the desktop is a WebSocket only, and starts nothing for anything else', async () => {
  const { box, container } = await startedBox();

  expect((await box.fetch(open({}))).status).toBe(426);
  expect(container.sequence.includes('desktop')).toBe(false);
});

test('the desktop\'s port is never a preview', async () => {
  const { box } = await startedBox();

  await expect(box.exposePort(6080, { hostname: 'preview.test' })).rejects.toThrow('6080');
  expect(await box.getExposedPorts('preview.test')).toEqual([]);
});
