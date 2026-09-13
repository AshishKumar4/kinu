import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';
import { DEVBOX_SCRATCH_PREFIX } from '../tests/support/scratch';
import { disposeMiniflare } from '../tests/support/miniflare-settle';

const scratch: string[] = [];

afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

async function meterRuntime(entry: string): Promise<Miniflare> {
  const build = await Bun.build({ entrypoints: [entry], target: 'node', external: ['node:*', 'cloudflare:*'] });

  if (!build.success || build.outputs[0] === undefined) throw new Error(build.logs.map(String).join('\n'));

  return new Miniflare({ workers: [{ config: {
    name: 'publication-meter', type: 'worker', compatibilityDate: '2026-04-14', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.mjs', modulesRoot: '/', modules: { 'index.mjs': { type: 'esm', contents: await build.outputs[0].text() } } },
    env: { BUCKET: { type: 'r2', name: 'BUCKET' } },
  } }] });
}

test('the R2 transport meter preserves streaming bodies and includes a failed PUT before its retry', async () => {
  const root = mkdtempSync(join(tmpdir(), DEVBOX_SCRATCH_PREFIX));
  scratch.push(root);
  const entry = join(root, 'worker.ts');
  const module = new URL('./publication-meter.ts', import.meta.url).pathname;
  const transport = new URL('./publication-transport.ts', import.meta.url).pathname;
  writeFileSync(entry, `
    import { publicationTotals } from ${JSON.stringify(module)};
    import { meterPublicationBucket, observePublicationRequest } from ${JSON.stringify(transport)};
    const window = { schema: 'devbox-publication-window/1', token: 'test', prefix: 'boxes/test/', openedAt: 0, closedAt: null, attempts: [] };
    export default { async fetch(request, env) {
      if (request.method === 'GET') {
        window.closedAt = Date.now();
        return Response.json({ window, totals: publicationTotals(window), body: await (await env.BUCKET.get('boxes/test/delta')).text() });
      }
      const target = Object.create(env.BUCKET);
      target.put = async (...args) => {
        const result = await env.BUCKET.put(...args);
        if (new URL(request.url).searchParams.has('fail')) throw new Error('lost PUT acknowledgement');
        return result;
      };
      const bucket = meterPublicationBucket(target, {
        async begin(key, operation, uploadId) {
          const id = String(window.attempts.length + 1);
          window.attempts.push({ id, key, operation, uploadId, startedAt: Date.now(), finishedAt: null, bytes: null, observedBytes: null, outcome: null, error: null, bodyError: null });
          return id;
        },
        async finish(id, result) { Object.assign(window.attempts.find(row => row.id === id), result, { finishedAt: Date.now() }); }
      });
      try {
        return await observePublicationRequest(request, async incoming => {
          // The SDK R2 bridge establishes its own fixed-length binding stream.
          const { readable, writable } = new FixedLengthStream(Number(incoming.headers.get('content-length')));
          const pipe = incoming.body.pipeTo(writable);
          await bucket.put('boxes/test/delta', readable);
          await pipe;
          return new Response('stored');
        });
      } catch (error) { return new Response(error.message, { status: 502 }); }
    } };
  `);
  const runtime = await meterRuntime(entry);

  try {
    expect((await runtime.dispatchFetch('https://meter.invalid/?fail', { method: 'PUT', body: 'hello', headers: { 'content-length': '5' }, signal: AbortSignal.timeout(2000) })).status).toBe(502);
    expect((await runtime.dispatchFetch('https://meter.invalid/', { method: 'PUT', body: 'hello', headers: { 'content-length': '5' }, signal: AbortSignal.timeout(2000) })).status).toBe(200);
    const result = await (await runtime.dispatchFetch('https://meter.invalid/')).json();
    expect(result).toMatchObject({ body: 'hello', totals: { objectsPut: 2, bytesPut: 10, errors: [] } });
  } finally {
    await disposeMiniflare(runtime);
  }
});

// Deployed 2026-09-13: p20260913101758's 4,198,400-byte single PUT stalled
// just like multipart. The previous test omitted the SDK's own stream bridge.
test('the installed SDK R2 proxy publishes single PUTs and multipart with the meter idle or active', async () => {
  const root = mkdtempSync(join(tmpdir(), DEVBOX_SCRATCH_PREFIX));
  scratch.push(root);
  const entry = join(root, 'sdk-worker.ts');
  const sdk = new URL('../../../node_modules/@cloudflare/sandbox/dist/index.js', import.meta.url).pathname;
  const transport = new URL('./publication-transport.ts', import.meta.url).pathname;
  writeFileSync(entry, `
    import { ContainerProxy } from ${JSON.stringify(sdk)};
    import { meterPublicationBucket, observePublicationRequest } from ${JSON.stringify(transport)};
    export class MeteredProxy extends ContainerProxy {
      constructor(ctx, env) {
        const bucket = meterPublicationBucket(env.BUCKET, {
          async begin() { return ctx.props.active ? crypto.randomUUID() : null; },
          async finish(id, result) { await env.BUCKET.put('receipts/' + id, JSON.stringify(result)); }
        });
        super(ctx, { ...env, BUCKET: bucket });
      }
      async fetch(request) {
        const headers = new Headers(request.headers);
        // Miniflare's external dispatcher rewrites the host and strips empty
        // Content-Length. Reconstruct the s3fs wire envelope at this boundary.
        const length = headers.get('x-probe-length');
        if (length !== null) headers.set('content-length', length);
        const incoming = new Request('http://r2.internal' + new URL(request.url).pathname + new URL(request.url).search,
          { method: request.method, headers, body: request.body });
        return await observePublicationRequest(incoming, next => super.fetch(next));
      }
    }
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/inspect') {
        const receipts = await env.BUCKET.list({ prefix: 'receipts/' });
        return Response.json({ direct: (await env.BUCKET.head('boxes/test/direct')).size,
          multipart: (await env.BUCKET.head('boxes/test/multipart')).size,
          receipts: await Promise.all(receipts.objects.map(async row => await (await env.BUCKET.get(row.key)).json())) });
      }
      return await new MeteredProxy({ props: {
        active: url.searchParams.has('active'), enableInternet: false, containerId: 'test', className: 'ContainerProxy',
        outboundByHostOverrides: { 'r2.internal': { method: 'r2EgressMount', params: {
          buckets: { BUCKET: { prefix: 'boxes/test', readOnly: false } }
        } } }
      } }, env).fetch(request);
    } };
  `);
  const runtime = await meterRuntime(entry);
  const partBytes = 5 * 1024 * 1024;

  try {
    for (const mode of ['', '&active=1']) {
      const send = async (path: string, method: string, bytes?: Uint8Array) => {
        const response = await runtime.dispatchFetch(`http://r2.internal/BUCKET/${path}${mode}`, {
          method, body: bytes, headers: bytes === undefined ? {} : { 'content-length': String(bytes.byteLength), 'x-probe-length': String(bytes.byteLength) },
          signal: AbortSignal.timeout(2000),
        });

        if (!response.ok) throw new Error(`SDK proxy ${response.status}: ${await response.text()}`);

        return response;
      };

      expect((await send('direct?probe=1', 'PUT', new Uint8Array(0))).status).toBe(200);
      expect((await send('direct?probe=1', 'PUT', new Uint8Array(4 * 1024 * 1024))).status).toBe(200);
      const opened = await send('multipart?uploads', 'POST');
      const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await opened.text())?.[1];
      expect(uploadId).toBeDefined();
      const upload = encodeURIComponent(uploadId ?? '');
      const part = await send(`multipart?uploadId=${upload}&partNumber=1`, 'PUT', new Uint8Array(partBytes));
      expect(part.status).toBe(200);
      const last = await send(`multipart?uploadId=${upload}&partNumber=2`, 'PUT', new Uint8Array(17));

      expect(last.status).toBe(200);

      const completion = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${part.headers.get('etag')}</ETag></Part>`
        + `<Part><PartNumber>2</PartNumber><ETag>${last.headers.get('etag')}</ETag></Part></CompleteMultipartUpload>`;

      expect((await send(`multipart?uploadId=${upload}`, 'POST', new TextEncoder().encode(completion))).status).toBe(200);
    }

    const inspection = await (await runtime.dispatchFetch('http://r2.internal/inspect')).json();
    expect(inspection).toMatchObject({ direct: 4 * 1024 * 1024, multipart: partBytes + 17 });
    expect(inspection).toHaveProperty('receipts.length', 5);
    expect(inspection).toHaveProperty('receipts', expect.arrayContaining(
      [0, 4 * 1024 * 1024, partBytes, 17].map(bytes => ({ bytes, observedBytes: bytes, bodyError: null, outcome: 'returned', error: null })),
    ));
  } finally {
    await runtime.dispose();
  }
});

test('the bench proxy flushes an under-threshold operation on success and failure', async () => {
  const root = mkdtempSync(join(tmpdir(), DEVBOX_SCRATCH_PREFIX));
  scratch.push(root);
  const entry = join(root, 'counter-worker.ts');
  const bench = new URL('./worker.ts', import.meta.url).pathname;
  writeFileSync(entry, `
    import { ContainerProxy } from ${JSON.stringify(bench)};
    const calls = {};
    const counter = {
      async beginPublicationAttempt() { return null; },
      async bump(batch) { for (const [key, count] of Object.entries(batch)) calls[key] = (calls[key] ?? 0) + count; }
    };
    export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === 'GET') return Response.json(calls);
      const bucket = Object.create(env.BUCKET);
      bucket.put = async (...args) => {
        const result = await env.BUCKET.put(...args);
        if (url.searchParams.has('fail')) throw new Error('lost acknowledgement');
        return result;
      };
      const proxy = new ContainerProxy({ props: {
        enableInternet: false, containerId: 'test', className: 'ContainerProxy',
        outboundByHostOverrides: { 'r2.internal': { method: 'r2EgressMount', params: {
          buckets: { BACKUP_BUCKET: { prefix: 'boxes/test', readOnly: false } }
        } } }
      } }, { BACKUP_BUCKET: bucket, BenchOpCounter: { idFromName() { return 'test'; }, get() { return counter; } } });
      try {
        return await proxy.fetch(new Request('http://r2.internal/BACKUP_BUCKET/data', {
          method: 'PUT', headers: { 'content-length': '5' }, body: request.body
        }));
      } catch (error) { return new Response(error.message, { status: 502 }); }
    } };
  `);
  const runtime = await meterRuntime(entry);

  try {
    expect((await runtime.dispatchFetch('https://meter.invalid/', { method: 'PUT', body: 'hello', signal: AbortSignal.timeout(2000) })).status).toBe(200);
    expect(await (await runtime.dispatchFetch('https://meter.invalid/')).json()).toMatchObject({ put: 1 });
    expect((await runtime.dispatchFetch('https://meter.invalid/?fail', { method: 'PUT', body: 'hello', signal: AbortSignal.timeout(2000) })).status).toBe(502);
    expect(await (await runtime.dispatchFetch('https://meter.invalid/')).json()).toMatchObject({ put: 2 });
  } finally {
    await runtime.dispose();
  }
});
