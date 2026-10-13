// D60: a preview reaches the port its host names, with that port's token only. D86: the host is
// `<port>-<box name>-<token>.<previewHost>`, and the box serves it itself.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';

import { TEST_BOX_ID, boxState, fakeStorage, harness, type Harness } from './support/devbox-harness';

class PreviewBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override get previewHost(): string | undefined {
    return 'preview.test';
  }
}

/** A box under the default preview zone, which it reads from `DEVBOX_PREVIEW_HOST`. */
class ZoneBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

const OWN = `${TEST_BOX_ID}-tok5173.preview.test`;

test('a preview host answers its own box and port token only, and the visitor\'s path reaches the port as it is', async () => {
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

  const status = async (url: string): Promise<number> => (await box.fetch(new Request(url))).status;

  expect({
    sameLength: await status(`https://5173-${TEST_BOX_ID}-tok5174.preview.test/`),
    prefix: await status(`https://5173-${TEST_BOX_ID}-tok517.preview.test/`),
    otherPort: await status(`https://5173-${TEST_BOX_ID}-tok8080.preview.test/`),
    otherBox: await status('https://5173-another-box-tok5173.preview.test/'),
    own: await status(`https://5173-${OWN}/`),
    smuggled: await status(`https://5173-${OWN}/_devbox/preview/8080/tok8080/x`),
    terminal: await status(`https://5173-${OWN}/_devbox/terminal`),
    pathForm: await status('https://box/_devbox/preview/5173/tok5173/'),
    reached,
  }).toEqual({
    sameLength: 404, prefix: 404, otherPort: 404, otherBox: 404, own: 200, smuggled: 200, terminal: 200, pathForm: 404,
    reached: ['5173 /', '5173 /_devbox/preview/8080/tok8080/x', '5173 /_devbox/terminal'],
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

  const answer = await box.fetch(new Request(`https://8001-${TEST_BOX_ID}-tok8001.preview.test/`));

  expect({ status: answer.status, said: await answer.text() }).toEqual({
    status: 502, said: expect.stringContaining('The container is not listening in the TCP address 10.0.0.1:8001'),
  });
});

/** The same object woken by its id alone, as the golden wakes a waiting box: the platform gives it no name (L4). */
function wokenById({ state, env }: Harness<ZoneBox>): ZoneBox {
  const id = { toString: () => TEST_BOX_ID, equals: () => false };

  return new ZoneBox(Object.assign(Object.create(state), { id }), env);
}

test('a port is published under DEVBOX_PREVIEW_HOST at the box\'s name, which it keeps when woken by its id', async () => {
  const made = harness(ZoneBox);
  Object.assign(made.env, { DEVBOX_PREVIEW_HOST: 'preview.example.com' });
  made.container.listening.add(3000);
  await made.box.devboxStartup();

  const exposed = await made.box.exposePort(3000, { name: 'web' });

  expect(exposed.url).toMatch(new RegExp(`^https://3000-${TEST_BOX_ID}-[a-z0-9]{16}\\.preview\\.example\\.com$`));
  expect(await wokenById(made).getExposedPorts()).toEqual([{ port: 3000, name: 'web', url: exposed.url }]);
});

test('a port no host can name is refused before a token is minted', async () => {
  const offZone = harness(ZoneBox);
  const longest = harness(ZoneBox, 'a'.repeat(41));
  const tooLong = harness(ZoneBox, 'a'.repeat(42));
  const upper = harness(ZoneBox, 'Demo');
  const zone = { DEVBOX_PREVIEW_HOST: 'preview.example.com' };
  // Never reached by a name: made by its id alone.
  const unnamedRows = fakeStorage();
  const unnamed = new ZoneBox(boxState({ storage: unnamedRows.handle, id: TEST_BOX_ID, blockConcurrencyWhile: (closure) => closure() }), zone);

  for (const made of [longest, tooLong, upper]) Object.assign(made.env, zone);

  for (const made of [offZone, longest, tooLong, upper]) {
    made.container.listening.add(3000);
    await made.box.devboxStartup();
  }

  const tokens = (rows: Map<string, unknown>) => [...rows.keys()].filter((key) => key.startsWith('devbox:port:'));

  await expect(offZone.box.exposePort(3000)).rejects.toMatchObject({ code: 'configuration', message: expect.stringContaining('DEVBOX_PREVIEW_HOST') });
  await expect(offZone.box.portToken(3000)).rejects.toMatchObject({ code: 'configuration' });
  await expect(unnamed.exposePort(3000)).rejects.toMatchObject({ code: 'configuration', message: expect.stringContaining('getByName') });
  await expect(tooLong.box.exposePort(3000)).rejects.toMatchObject({ code: 'invalid-input', message: expect.stringContaining('63 characters') });
  await expect(upper.box.exposePort(3000)).rejects.toMatchObject({ code: 'invalid-input' });
  expect({
    longest: (await longest.box.exposePort(3000)).url.split('.')[0]?.length,
    minted: [offZone.rows, unnamedRows.rows, tooLong.rows, upper.rows].flatMap(tokens),
  }).toEqual({ longest: 'https://'.length + 63, minted: [] });
});
