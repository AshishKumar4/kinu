// The container's publisher as `publishCommand` ships it (D50): several parts are in flight at once, and they complete
// in order, so the object holds the archive. A publisher with one part in flight sends the next only after the store
// has answered the last, so the store never holds two.
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishCommand } from '../src/snapshot-chain';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}publish-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** A multipart store that counts the parts it holds at once: from a part's arrival to its answer. */
function countingStore() {
  const parts = new Map<number, Uint8Array>();
  let held = 0;
  let mostHeld = 0;
  let object: Uint8Array | undefined;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const part = url.searchParams.get('partNumber');

      if (request.method === 'POST' && url.searchParams.has('uploads')) {
        return new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>');
      }

      if (request.method === 'PUT' && part !== null) {
        held += 1;
        mostHeld = Math.max(mostHeld, held);
        const bytes = new Uint8Array(await request.arrayBuffer());
        parts.set(Number(part), bytes);
        held -= 1;

        return new Response(null, { headers: { etag: `"part-${part}"` } });
      }

      if (request.method === 'POST' && url.searchParams.has('uploadId')) {
        // Assembled only from a list naming every part once, in order, each with the etag its answer gave.
        const numbers = [...parts.keys()].sort((a, b) => a - b);
        const inOrder = numbers.map((number) => `<Part><PartNumber>${String(number)}</PartNumber><ETag>"part-${String(number)}"</ETag></Part>`);

        if (await request.text() === `<CompleteMultipartUpload>${inOrder.join('')}</CompleteMultipartUpload>`) {
          object = Buffer.concat(numbers.map((number) => parts.get(number) ?? new Uint8Array()));
        }

        return new Response('<CompleteMultipartUploadResult><ETag>"whole"</ETag></CompleteMultipartUploadResult>');
      }

      if (request.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(object?.byteLength ?? 0) } });

      return new Response(null, { status: 501 });
    },
  });

  return { origin: `http://127.0.0.1:${String(server.port)}`, mostHeld: () => mostHeld, object: () => object, stop: () => server.stop(true) };
}

/** The script `publishCommand` writes into the container, and the arguments it runs it with. */
function shipped(command: string) {
  const script = /printf %s '([^']+)' \| base64 -d/.exec(command)?.[1];
  const run = /bun '[^']+' '([^']+)' '([^']+)' ([\d ]+)\)/.exec(command);

  if (script === undefined || run === null) throw new Error(`publishCommand no longer has the shape this test reads: ${command.slice(0, 200)}`);

  return { script: atob(script), args: [run[1] ?? '', run[2] ?? '', ...(run[3] ?? '').trim().split(' ')] };
}

test('the publisher keeps several parts in flight and completes them in order', async () => {
  const store = countingStore();
  const archive = join(root, 'layer.sqsh');
  const bytes = randomBytes(6 * 5 * 1024 * 1024 + 12_345);
  writeFileSync(archive, bytes);
  const { script, args } = shipped(publishCommand({ archivePath: archive, objectUrl: `${store.origin}/BUCKET/boxes/test/layer.sqsh` }));
  writeFileSync(join(root, 'devbox-publish.mjs'), script);

  const child = Bun.spawn(['bun', join(root, 'devbox-publish.mjs'), ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  await store.stop();
  const landed = store.object();

  expect({ exitCode, stderr, stdout, mostHeld: store.mostHeld() > 1, landed: landed === undefined ? null : createHash('sha256').update(landed).digest('hex') })
    .toEqual({ exitCode: 0, stderr: '', stdout: `${String(bytes.byteLength)} "whole"`, mostHeld: true, landed: createHash('sha256').update(bytes).digest('hex') });
});
