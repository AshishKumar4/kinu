/**
 * Does a request wait on a models.dev read another request started? Real workerd (miniflare) at the deployment's
 * compatibility date; the read is models-dev.ts's own `listModelsDevProviderModels`, bundled from this checkout into
 * `process.argv[2]`, against an outbound models.dev that answers only when told. Prints one JSON object for
 * `unit-models-dev-workerd.test.ts`. Every wait is on a condition: a read reaching models.dev, a client's answer. A
 * request that joins another's read never reaches models.dev, so under that defect this process waits for good, and
 * the ladder's silence bound names it.
 *   together: A's read is held, B asks; B's own read reaches models.dev; both are answered.
 *   cancel:   A's read is held, B asks and reads, A's client goes away; B is answered.
 *   after:    A's read is held and A's client goes away; C asks afresh, reads, and is answered.
 */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../../..', import.meta.url).pathname;

const dir = process.argv[2] ?? '';

if (dir === '') throw new Error('models-dev-workerd: pass the directory to build the probe Worker in');

const entry = join(dir, 'worker.ts');

writeFileSync(entry, `
import { listModelsDevProviderModels } from ${JSON.stringify(join(root, 'packages/core/src/providers/models-dev.ts'))};

export default {
  async fetch(): Promise<Response> {
    try {
      const models = await listModelsDevProviderModels('cloudflare-workers-ai', { fetch }, { ttlMs: 0 });

      return Response.json({ ok: true, models: models.length });
    } catch (error) {
      return Response.json({ ok: false, error: String(error) });
    }
  },
};
`);

buildSync({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: join(dir, 'worker.js'),
  conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:*'], logLevel: 'error',
});

const CATALOG = JSON.stringify({
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai', name: 'Workers AI',
    models: { '@cf/zai-org/glm-5.3': { id: '@cf/zai-org/glm-5.3', name: 'GLM', tool_call: true, limit: { context: 128_000, output: 8000 } } },
  },
});

interface Signal { readonly promise: Promise<void>; readonly resolve: () => void }

/** One signal per read that reaches models.dev, in order; each read is then held until its case resolves `held`. */
const arrivals: Signal[] = [];

let held: Signal = Promise.withResolvers<void>();

let reads = 0;

/** The signal of the `count`th read, made if none has asked for it yet. */
const arrival = (count: number): Signal => {
  while (arrivals.length < count) arrivals.push(Promise.withResolvers<void>());

  return arrivals[count - 1] ?? Promise.withResolvers<void>();
};

const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    name: 'probe', modulesRoot: dir,
    modules: [{ type: 'ESModule', path: join(dir, 'worker.js'), contents: readFileSync(join(dir, 'worker.js'), 'utf8') }],
    compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
    outboundService: async (request: Request) => {
      if (!request.url.includes('models.dev')) return new Response('no', { status: 404 });
      reads += 1;
      arrival(reads).resolve();
      await held.promise;

      return new Response(CATALOG, { headers: { 'content-type': 'application/json' } });
    },
  }],
}));

const url = await mf.ready;

/** A request's answer: its status and body, or status 0 when its client went away. */
interface Answer { readonly status: number; readonly body: string }

const ask = async (signal?: AbortSignal): Promise<Answer> => {
  const [answered] = await Promise.allSettled([fetch(new URL('/', url), { signal })]);

  return answered.status === 'fulfilled' ? { status: answered.value.status, body: await answered.value.text() } : { status: 0, body: String(answered.reason) };
};

/** Each case starts with nothing held and counts its own reads. */
async function run<T>(body: (read: (count: number) => Promise<void>) => Promise<T>): Promise<{ readonly result: T; readonly reads: number }> {
  held = Promise.withResolvers<void>();
  const before = reads;
  const result = await body(async (count) => arrival(before + count).promise);

  return { result, reads: reads - before };
}

const together = await run(async (read) => {
  const a = ask();

  await read(1);
  const b = ask();

  await read(2);
  held.resolve();

  return { a: (await a).status, b: (await b).status };
});

const cancel = await run(async (read) => {
  const cut = new AbortController();
  const a = ask(cut.signal);

  await read(1);
  const b = ask();

  await read(2);
  cut.abort();
  const gone = await a;

  held.resolve();

  return { a: gone.status, b: (await b).status };
});

const after = await run(async (read) => {
  const cut = new AbortController();
  const a = ask(cut.signal);

  await read(1);
  cut.abort();
  const gone = await a;
  const c = ask();

  await read(2);
  held.resolve();

  return { a: gone.status, c: (await c).status };
});

await mf.dispose();

console.log(JSON.stringify({ together, cancel, after }));
