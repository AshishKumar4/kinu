// SDK audit (b), 2026-10-01: a preview reaches the port its Worker named, with that port's token only.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';

import { harness } from './support/devbox-harness';

class PreviewBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override get previewHost(): string | undefined {
    return 'preview.test';
  }
}

test('a preview answers its own port token only, and a visitor path naming another port stays a path', async () => {
  const { box, rows, container } = harness(PreviewBox);
  const reached: string[] = [];
  rows.set('devbox:port:5173', { port: 5173, name: 'web', token: 'tok5173', createdAt: 1 });
  rows.set('devbox:port:8080', { port: 8080, name: 'api', token: 'tok8080', createdAt: 1 });
  container.listening.add(5173);
  container.listening.add(8080);
  await box.devboxStartup();
  container.portAnswer = (port, request) => {
    reached.push(`${port} ${new URL(request.url).pathname}`);

    return new Response('', { status: 200 });
  };

  const status = async (path: string): Promise<number> => (await box.fetch(new Request(`https://box/_devbox/preview/${path}`))).status;

  expect({
    sameLength: await status('5173/tok5174/'),
    prefix: await status('5173/tok517/'),
    otherPort: await status('5173/tok8080/'),
    own: await status('5173/tok5173/'),
    smuggled: await status('5173/tok5173/_devbox/preview/8080/tok8080/x'),
    reached,
  }).toEqual({
    sameLength: 404, prefix: 404, otherPort: 404, own: 200, smuggled: 200,
    reached: ['5173 /', '5173 /_devbox/preview/8080/tok8080/x'],
  });
});

// Staging, 2026-10-08: a preview whose server was not up threw out of the box's fetch, an uncaught exception and a bare 500.
test('a preview whose server is not listening answers 502 in the platform\'s words, and throws nothing', async () => {
  const { box, rows, container } = harness(PreviewBox);
  rows.set('devbox:port:8001', { port: 8001, name: 'site', token: 'tok8001', createdAt: 1 });
  container.listening.add(8001);
  await box.devboxStartup();
  // The server went away after the port was exposed; the platform refuses the connection.
  container.portAnswer = (port) => { throw new Error(`The container is not listening in the TCP address 10.0.0.1:${String(port)}`); };

  const answer = await box.fetch(new Request('https://box/_devbox/preview/8001/tok8001/'));

  expect({ status: answer.status, said: await answer.text() }).toEqual({
    status: 502, said: expect.stringContaining('The container is not listening in the TCP address 10.0.0.1:8001'),
  });
});
