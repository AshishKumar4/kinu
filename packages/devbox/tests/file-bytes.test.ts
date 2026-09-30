// Review 3f6, 2026-09-30: the sandbox file view read with no encoding, which this box answers as
// `Response.text()`, so a binary file lost its bytes. A read is exact only if every hop keeps
// them; the view and the adapter are tested in core and cf-backend, and this is the box's hop.
import { expect, test } from 'bun:test';
import { Devbox, harness } from './support/devbox-harness';

const PNG = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0xfe]);

test('a binary file reads back exactly as base64 and as a stream', async () => {
  const { box, container } = harness(Devbox);
  await box.start();
  container.binaryFiles.set('/workspace/logo.png', PNG);

  try {
    const read = await box.readFile('/workspace/logo.png', { encoding: 'base64' });
    const streamed = new Uint8Array(await new Response(await box.readFileStream('/workspace/logo.png')).arrayBuffer());

    expect({ read, streamed }).toEqual({ read: { content: Buffer.from(PNG).toString('base64'), encoding: 'base64' }, streamed: PNG });
  } finally { await box.destroy(); }
});
