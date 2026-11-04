/**
 * A download that breaks off midway, served by real workerd (miniflare) over real HTTP to this process's fetch, the way
 * the deployment answers a client. The server is this checkout's `serveDownload` with the Worker's own framing
 * (`framedDownload`), bundled into `process.argv[2]`; its second chunk's read fails, as production's did ("Network
 * connection lost.", 2026-11-04). Prints one JSON object for `unit-file-download-workerd.test.ts`:
 *   whole:  a 15-byte file read whole.
 *   broken: the same file, its second read failing: what the client's read of the body did.
 */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../../..', import.meta.url).pathname;

const dir = process.argv[2] ?? '';

if (dir === '') throw new Error('file-download-workerd: pass the directory to build the probe Worker in');

const entry = join(dir, 'worker.ts');

writeFileSync(entry, `
import { serveDownload } from ${JSON.stringify(join(root, 'packages/core/src/read-models/file-transfer.ts'))};
import { fileResponseHeaders } from ${JSON.stringify(join(root, 'packages/core/src/http/http.ts'))};
import { framedDownload } from ${JSON.stringify(join(root, 'packages/cf-backend/src/api/context.ts'))};

const FILE = new TextEncoder().encode('KINU-EVERY-TOOL');

export default {
  async fetch(request: Request): Promise<Response> {
    const breaks = new URL(request.url).searchParams.has('broken');

    return await serveDownload({
      start: async () => ({ size: FILE.byteLength }),
      read: async (_transfer, offset, length) => {
        if (breaks && offset > 0) throw new Error('Network connection lost.');

        return FILE.slice(offset, offset + Math.min(length, 8));
      },
      abort: async () => {},
    }, (body, { size }) => framedDownload(fileResponseHeaders('/home/main/tools-probe.txt', false), body, size));
  },
};
`);

buildSync({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: join(dir, 'worker.js'),
  conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:*'], logLevel: 'error',
});

const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    name: 'probe', modulesRoot: dir,
    modules: [{ type: 'ESModule', path: join(dir, 'worker.js'), contents: readFileSync(join(dir, 'worker.js'), 'utf8') }],
    compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
  }],
}));

const url = await mf.ready;

/** The response's status, and its body as the client read it, or the read's refusal. */
const read = async (path: string): Promise<{ readonly status: number; readonly body: string | null; readonly refused: boolean }> => {
  const response = await fetch(new URL(path, url));
  const [body] = await Promise.allSettled([response.text()]);

  return { status: response.status, body: body.status === 'fulfilled' ? body.value : null, refused: body.status === 'rejected' };
};

const whole = await read('/');

const broken = await read('/?broken');

await mf.dispose();

console.log(JSON.stringify({ whole, broken }));
