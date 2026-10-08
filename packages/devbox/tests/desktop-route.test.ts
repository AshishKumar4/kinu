// D70: the desktop route.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';

import { harness } from './support/devbox-harness';

class DesktopBox extends TestDevbox<unknown> {

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

  await expect(box.exposePort(6080, { hostname: 'preview.test' })).rejects.toMatchObject({ code: 'invalid-input' });
  expect(await box.getExposedPorts('preview.test')).toEqual([]);
});

// HiddenGrasshopper's review of 29de5aed3: core's exposeOn asks portToken first, which left a 6080 row that a
// restore then exposed and published, and a preview with no cookie reached the desktop's port.
test('the desktop\'s port mints no token, so nothing is left for a restore to expose', async () => {
  const { box, rows } = await startedBox();

  await expect(box.portToken(6080)).rejects.toMatchObject({ code: 'invalid-input' });
  expect(rows.has('devbox:port:6080')).toBe(false);
});

test('a stored 6080 row is never exposed on restore, nor served as a preview', async () => {
  const { box, rows, container } = harness(DesktopBox);
  const reached: number[] = [];

  rows.set('devbox:port:6080', { port: 6080, token: 'tok6080', createdAt: 1 });
  container.listening.add(6080);
  container.portAnswer = (port) => {
    reached.push(port);

    return new Response('', { status: 200 });
  };

  await box.devboxStartup();

  const preview = await box.fetch(new Request('https://box/_devbox/preview/6080/tok6080/websockify'));

  expect({ exposed: await box.getExposedPorts('preview.test'), status: preview.status, reached }).toEqual({ exposed: [], status: 404, reached: [] });
});
