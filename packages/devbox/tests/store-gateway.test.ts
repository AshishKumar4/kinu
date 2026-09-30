import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, type Response as MiniflareResponse } from 'miniflare';
import * as v from 'valibot';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { disposeMiniflare } from './support/miniflare-settle';
import { workerCompatibility } from '../../cf-backend/vite-agent-bundle';

// The gateway runs on workerd's own R2 binding: the S3 semantics it serves are the binding's.
// A route is rooted at its box's prefix (D46): the guest names keys under that root, and
// `box-1` is a string prefix of its sibling `box-10`, so a slip in the join would reach it.
const ROOT = 'boxes/box-1/';

const SIBLING = 'boxes/box-10/';

const HOST = 's3-route-1.sandbox.internal';

const store = 'http://' + HOST + '/WORKSPACES/';

let runtime: Miniflare;

let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), DEVBOX_SCRATCH_PREFIX));
  const entry = join(root, 'gateway.ts');
  writeFileSync(entry, `
    import { serveStore, storeSource } from ${JSON.stringify(new URL('../src/store-gateway.ts', import.meta.url).pathname)};
    import { settle } from ${JSON.stringify(new URL('../src/errors.ts', import.meta.url).pathname)};
    export default { async fetch(request, env) {
      const url = new URL(request.url);
      // The test reads and seeds the bucket around the gateway, as another box would.
      if (url.pathname === '/raw') {
        const key = url.searchParams.get('key');
        if (request.method === 'PUT') { await env.WORKSPACES.put(key, await request.arrayBuffer()); return new Response(null); }
        const listed = await env.WORKSPACES.list({ prefix: key ?? '' });
        return Response.json(listed.objects.map((o) => o.key));
      }
      const keyPrefix = request.headers.get('x-test-root') ?? ${JSON.stringify(ROOT)};
      const props = request.headers.get('x-test-deny') !== null
        ? { protocolVersion: 1, mode: 'deny', routeId: 'route-1' }
        : { protocolVersion: 1, mode: 'active', routeId: 'route-1', source: storeSource('WORKSPACES'), keyPrefix,
            access: request.headers.get('x-test-read-only') === null ? 'read-write' : 'read-only' };
      const target = new Request('http://' + (request.headers.get('x-test-host') ?? ${JSON.stringify(HOST)}) + url.pathname + url.search, request);
      return await settle(serveStore(target, props, (name) => name === 'WORKSPACES' ? env.WORKSPACES : undefined));
    } };
  `);
  const build = await Bun.build({ entrypoints: [entry], target: 'node', external: ['node:*', 'cloudflare:*'] });

  if (!build.success || build.outputs[0] === undefined) throw new Error(build.logs.map(String).join('\n'));
  runtime = new Miniflare({ workers: [{ config: {
    name: 'store-gateway', ...workerCompatibility,
    manifest: { mainModule: 'index.mjs', modulesRoot: '/', modules: { 'index.mjs': { type: 'esm', contents: await build.outputs[0].text() } } },
    env: { WORKSPACES: { type: 'r2', name: 'WORKSPACES' } },
  } }] });
});

afterAll(async () => {
  await disposeMiniflare(runtime);
  rmSync(root, { recursive: true, force: true });
});

/** `path` goes on the wire exactly as written: percent-encodings and dot segments reach the gateway. */
async function send(path: string, init: { method?: string; body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<MiniflareResponse> {
  const headers = { ...init.headers };

  if (init.body !== undefined) headers['content-length'] = String(init.body.byteLength);

  return await runtime.dispatchFetch(store + path, { method: init.method ?? 'GET', body: init.body, headers });
}

async function keysUnder(prefix: string): Promise<string[]> {
  return v.parse(v.array(v.string()), await (await runtime.dispatchFetch(`http://raw.test/raw?key=${encodeURIComponent(prefix)}`)).json());
}

async function seed(key: string): Promise<void> {
  await runtime.dispatchFetch(`http://raw.test/raw?key=${encodeURIComponent(key)}`, { method: 'PUT', body: 'the sibling box\'s bytes' });
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('a route roots every key at its box: written, read whole and by range, listed relative, deleted', async () => {
  const bytes = new Uint8Array(randomBytes(1_000_003));
  expect((await send('chain/base-1.sqsh', { method: 'PUT', body: bytes })).status).toBe(200);
  expect(await keysUnder('boxes/')).toEqual([`${ROOT}chain/base-1.sqsh`]);

  const head = await send('chain/base-1.sqsh', { method: 'HEAD' });
  expect({ status: head.status, length: head.headers.get('content-length') }).toEqual({ status: 200, length: '1000003' });
  expect(sha(new Uint8Array(await (await send('chain/base-1.sqsh')).arrayBuffer()))).toBe(sha(bytes));

  for (const [range, from, to] of [['bytes=4096-12287', 4096, 12288], ['bytes=999000-', 999_000, 1_000_003], ['bytes=-7', 999_996, 1_000_003]] as const) {
    const part = await send('chain/base-1.sqsh', { headers: { range } });
    expect({ status: part.status, contentRange: part.headers.get('content-range'), bytes: sha(new Uint8Array(await part.arrayBuffer())) })
      .toEqual({ status: 206, contentRange: `bytes ${from}-${to - 1}/1000003`, bytes: sha(bytes.slice(from, to)) });
  }

  const listed = await (await send('?prefix=&delimiter=%2F&max-keys=1000')).text();
  expect(listed).toContain('<CommonPrefixes><Prefix>chain/</Prefix></CommonPrefixes>');
  expect(listed).not.toContain('boxes/');
  const inside = await (await send('?list-type=2&prefix=chain%2F&max-keys=1000')).text();
  expect(inside).toContain('<Key>chain/base-1.sqsh</Key>');
  expect(inside).toContain('<Size>1000003</Size>');

  expect((await send('chain/base-1.sqsh', { method: 'DELETE' })).status).toBe(204);
  expect(await keysUnder('boxes/')).toEqual([]);
  // The mount root's own directory object, which s3fs asks for when it mounts the bucket root.
  expect([(await send('/', { method: 'HEAD' })).status, (await send('/', { method: 'PUT', body: new Uint8Array([1]) })).status]).toEqual([404, 400]);
});

test('whatever the guest sends, it names nothing outside its root', async () => {
  await seed(`${SIBLING}secret`);
  await seed('outside');
  const body = new Uint8Array([1, 2, 3]);

  // URL parsing resolves `..` and `%2E%2E` segments before the gateway sees the path, which then
  // names another bucket (403); a `/` the guest percent-encodes survives parsing and is refused (400).
  const escapes = {
    dotSegments: await send('../box-10/secret'),
    dotSegmentsPut: await send('chain/../../box-10/secret', { method: 'PUT', body }),
    encodedDots: await send('%2E%2E/box-10/secret', { method: 'DELETE' }),
    encodedSlashes: await send('..%2Fbox-10%2Fsecret'),
    encodedSlashesPut: await send('chain%2F..%2F..%2Fbox-10%2Fsecret', { method: 'PUT', body }),
    encodedBoth: await send('%2e%2e%2f%2e%2e%2foutside', { method: 'DELETE' }),
    absolute: await send('/boxes/box-10/secret'),
    absoluteEncoded: await send('%2Fboxes%2Fbox-10%2Fsecret', { method: 'DELETE' }),
    emptySegment: await send('chain//x', { method: 'PUT', body }),
    listDotSegments: await send('?prefix=..%2Fbox-10%2F'),
    listAbsolute: await send('?prefix=%2Fboxes%2F'),
  };

  expect(Object.fromEntries(Object.entries(escapes).map(([name, response]) => [name, response.status]))).toEqual({
    dotSegments: 403, dotSegmentsPut: 403, encodedDots: 403, encodedSlashes: 400, encodedSlashesPut: 400, encodedBoth: 400,
    absolute: 400, absoluteEncoded: 400, emptySegment: 400, listDotSegments: 400, listAbsolute: 400,
  });

  // The sibling's name is only a path under this root.
  expect((await send('0/secret')).status).toBe(404);
  expect((await send('box-10/secret')).status).toBe(404);
  expect((await send('0/secret', { method: 'DELETE' })).status).toBe(204);
  expect((await send('box-10/secret', { method: 'DELETE' })).status).toBe(204);

  const listed = await (await send('?prefix=&max-keys=1000')).text();
  expect(listed).not.toContain('secret');
  expect(listed).not.toContain('outside');
  expect(await keysUnder('')).toEqual(['boxes/box-10/secret', 'outside']);
});

test('a listing continues only inside its root, whatever token or marker it is handed', async () => {
  for (const key of ['a', 'b', 'c']) await seed(`${SIBLING}${key}`);
  await send('chain/x', { method: 'PUT', body: new Uint8Array([1]) });
  const sibling = await (await send('?list-type=2&prefix=&max-keys=1', { headers: { 'x-test-root': SIBLING } })).text();
  const token = sibling.split('<NextContinuationToken>')[1]?.split('</NextContinuationToken>')[0] ?? '';
  expect(token).not.toBe('');

  const handed = await (await send(`?list-type=2&prefix=&continuation-token=${encodeURIComponent(token)}`)).text();
  const marked = await (await send('?prefix=&marker=%2E%2E%2Fbox-10%2Fa')).text();

  for (const key of ['a', 'b', 'c', 'secret']) {
    expect(handed).not.toContain(`<Key>${key}</Key>`);
    expect(marked).not.toContain(`<Key>${key}</Key>`);
  }

  expect(marked).not.toContain('box-10');
  await send('chain/x', { method: 'DELETE' });
});

test('a route answers nothing outside the bucket, host and access S3Mounts recorded for it', async () => {
  const body = new Uint8Array([1, 2, 3]);

  const refusals = {
    otherBucket: await runtime.dispatchFetch('http://' + HOST + '/BACKUP_BUCKET/chain/x'),
    otherHost: await send('chain/x', { headers: { 'x-test-host': 's3-route-2.sandbox.internal' } }),
    revoked: await send('chain/x', { headers: { 'x-test-deny': '1' } }),
    readOnly: await send('chain/x', { method: 'PUT', body, headers: { 'x-test-read-only': '1' } }),
    unrooted: await send('chain/x', { headers: { 'x-test-root': 'boxes/box-1' } }),
    serverCopy: await send('chain/x', { method: 'PUT', body, headers: { 'x-amz-copy-source': '/WORKSPACES/chain/y' } }),
    listParts: await send('chain/x?uploadId=abc'),
    acl: await send('chain/x?acl'),
  };

  expect(Object.fromEntries(Object.entries(refusals).map(([name, response]) => [name, response.status]))).toEqual({
    otherBucket: 403, otherHost: 403, revoked: 403, readOnly: 403, unrooted: 500, serverCopy: 501, listParts: 501, acl: 501,
  });
  expect((await send('chain/x', { method: 'HEAD' })).status).toBe(404);
});
