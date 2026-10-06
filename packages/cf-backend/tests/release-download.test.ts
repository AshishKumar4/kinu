// A release artifact downloads as an updater fetches it, through the real `server.ts` entry: HEAD for its size, GET for
// its bytes, and the published checksum those bytes must match. Hono answers HEAD by running the GET route.
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { AssetFetcher } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { workerContext } from './helpers/bindings';

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), and the entry's DO graph reaches `cloudflare:*` modules.
const { default: worker } = await import('../src/server');

const ARTIFACT = 'kinu-worker-0.2.0+abc.tar.gz';

const BYTES = 'the worker bundle, as the release published it';

const DIGEST = createHash('sha256').update(BYTES).digest('hex');

/** The release bucket holding one artifact, and ASSETS publishing its checksum as the deploy does. */
function deployment(): Env {
  const object = () => ({ size: BYTES.length, etag: 'e1', httpEtag: '"e1"', uploaded: new Date(0), body: new Blob([BYTES]).stream() });

  const assets: AssetFetcher = {
    fetch: async (input) => (new URL(input instanceof Request ? input.url : String(input)).pathname === `/downloads/${ARTIFACT}.sha256`
      ? new Response(`${DIGEST}  ${ARTIFACT}\n`)
      : new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })),
  };

  const partialEnv: Partial<Env> = {};

  Object.assign(partialEnv, {
    RELEASES_BUCKET: { get: async () => object(), head: async () => ({ ...object(), body: undefined }) },
    ASSETS: assets,
  });

  // SAFETY: this fixture constructs the two bindings a download reads before it answers: the bucket and ASSETS.
  return partialEnv as Env;
}

test('a release artifact\'s HEAD names its size with no body, its GET carries those bytes, and they match its checksum', async () => {
  const env = deployment();
  const url = `https://app.example.com/downloads/${ARTIFACT}`;

  const head = await worker.fetch(new Request(url, { method: 'HEAD' }), env, workerContext());
  const get = await worker.fetch(new Request(url), env, workerContext());
  const checksum = await worker.fetch(new Request(`${url}.sha256`), env, workerContext());
  const body = await get.text();

  expect({
    head: { status: head.status, length: head.headers.get('content-length'), body: await head.text() },
    get: { status: get.status, length: body.length, digest: createHash('sha256').update(body).digest('hex') },
    checksum: { status: checksum.status, digest: (await checksum.text()).split(/\s+/u)[0] },
  }).toEqual({
    head: { status: 200, length: String(BYTES.length), body: '' },
    get: { status: 200, length: BYTES.length, digest: DIGEST },
    checksum: { status: 200, digest: DIGEST },
  });
});
