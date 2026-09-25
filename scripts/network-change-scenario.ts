/**
 * A network change failing a page's module graph, and the harness's wait going on past it. Run by
 * flow-waits-ux.test.ts inside a user and network namespace of its own (lo and dummy0 up), so the change touches
 * nothing outside it.
 *
 * Chrome answers an address change by flushing its socket pools: a request already on a connection runs on, and one
 * still queued for a connection fails with net::ERR_NETWORK_CHANGED. A dev server's page queues most of its modules
 * behind HTTP/1.1's six connections to a host, which is how a container's veth failed a deploy's row on 2026-09-24.
 * So the entry imports ten modules and the first load holds each one: six hold the connections, four queue. Prints
 * how many loads the page took and why its script requests failed, as JSON.
 */
import type { HTTPRequest } from 'puppeteer';
import { withBrowser } from './live-app-harness';
import { recordDeadEnds, until } from './product-flows';

const MODULES = 10;

/** What Chrome holds open to one host over HTTP/1.1. */
const CONNECTIONS_PER_HOST = 6;

let loads = 0;

let held = 0;

const connectionsFull = Promise.withResolvers<void>();

const release = Promise.withResolvers<void>();

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === '/') {
      loads += 1;

      return new Response('<script type="module" src="/entry.js"></script>', { headers: { 'content-type': 'text/html' } });
    }

    if (path === '/entry.js') {
      const imports = Array.from({ length: MODULES }, (_, index) => `import './dep${String(index)}.js';`);

      return new Response(`${imports.join('\n')}\nwindow.__answered = true;`, { headers: { 'content-type': 'text/javascript' } });
    }

    if (loads === 1) {
      held += 1;

      if (held === CONNECTIONS_PER_HOST) connectionsFull.resolve();
      await release.promise;
    }

    return new Response('export {};', { headers: { 'content-type': 'text/javascript' } });
  },
});

async function addAddress(): Promise<void> {
  const ip = Bun.spawn(['ip', 'addr', 'add', '10.9.9.2/24', 'dev', 'dummy0'], { stdout: 'ignore', stderr: 'pipe' });
  const [said, code] = await Promise.all([new Response(ip.stderr).text(), ip.exited]);

  if (code !== 0) throw new Error(`ip addr add failed: ${said}`);
}

try {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    const reasons = new Set<string>();
    const queuedFailed = Promise.withResolvers<void>();

    page.on('requestfailed', (request: HTTPRequest) => {
      reasons.add(request.failure()?.errorText ?? 'no error text');
      queuedFailed.resolve();
    });
    await recordDeadEnds(page);

    // Settled at the end, however the reload ends it: the first document loads only once its module graph settles.
    const navigated = page.goto(`http://127.0.0.1:${String(server.port)}/`, { waitUntil: 'domcontentloaded' });
    const answered = until(page, 'the answer', 'window.__answered === true');

    await connectionsFull.promise;
    await addAddress();
    process.stderr.write('waiting for a queued module to fail\n');
    await queuedFailed.promise;
    release.resolve();
    await answered;
    await Promise.allSettled([navigated]);
    console.log(JSON.stringify({ loads, reasons: [...reasons] }));
  });
} finally {
  release.resolve();
  await server.stop(true);
}
