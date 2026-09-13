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
          await bucket.put('boxes/test/delta', incoming.body);
          return new Response('stored');
        });
      } catch (error) { return new Response(error.message, { status: 502 }); }
    } };
  `);
  const build = await Bun.build({ entrypoints: [entry], target: 'node', external: ['node:async_hooks'] });

  if (!build.success || build.outputs[0] === undefined) throw new Error(build.logs.map(String).join('\n'));

  const runtime = new Miniflare({ workers: [{ config: {
    name: 'publication-meter', type: 'worker', compatibilityDate: '2026-04-14', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.mjs', modulesRoot: '/', modules: { 'index.mjs': { type: 'esm', contents: await build.outputs[0].text() } } },
    env: { BUCKET: { type: 'r2', name: 'BUCKET' } },
  } }] });

  try {
    expect((await runtime.dispatchFetch('https://meter.invalid/?fail', { method: 'PUT', body: 'hello', headers: { 'content-length': '5' } })).status).toBe(502);
    expect((await runtime.dispatchFetch('https://meter.invalid/', { method: 'PUT', body: 'hello', headers: { 'content-length': '5' } })).status).toBe(200);
    const result = await (await runtime.dispatchFetch('https://meter.invalid/')).json();
    expect(result).toMatchObject({ body: 'hello', totals: { objectsPut: 2, bytesPut: 10, errors: [] } });
  } finally {
    await disposeMiniflare(runtime);
  }
});
