// The release artifact route through the real `server.ts` entry: Hono answers HEAD by running the GET route.
import { expect, test } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { workerContext } from './helpers/bindings';

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), and the entry's DO graph reaches `cloudflare:*` modules.
const { default: worker } = await import('../src/server');

const ARTIFACT = 'kinu-worker-0.2.0+abc.tar.gz';

function bucket() {
  const reads = { get: 0, head: 0 };
  const object = { size: 3, etag: 'e1', httpEtag: '"e1"', uploaded: new Date(0), body: new Blob(['abc']).stream() };

  return {
    reads,
    store: {
      async get() {
        reads.get += 1;

        return object;
      },
      async head() {
        reads.head += 1;

        return { ...object, body: undefined };
      },
    },
  };
}

test('a HEAD for a release artifact reads its metadata and never its body', async () => {
  const { reads, store } = bucket();
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, { RELEASES_BUCKET: store });
  // SAFETY: this fixture constructs RELEASES_BUCKET, the one binding the release route reads before it answers.
  const env = partialEnv as Env;

  const head = await worker.fetch(new Request(`https://app.example.com/downloads/${ARTIFACT}`, { method: 'HEAD' }), env, workerContext());

  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe('3');
  expect(reads).toEqual({ get: 0, head: 1 });

  const get = await worker.fetch(new Request(`https://app.example.com/downloads/${ARTIFACT}`), env, workerContext());

  expect(await get.text()).toBe('abc');
  expect(reads).toEqual({ get: 1, head: 1 });
});
