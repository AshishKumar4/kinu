/**
 * A page that never goes quiet, and a wait on it ended from outside: run by tests/browser/flow-waits-ux.test.ts,
 * which sends SIGTERM once this prints `waiting`, as a row's silence bound does. The page fetches `/poll` in a loop,
 * so its wait for a quiet socket cannot settle; what the run prints when it is ended is the subject.
 */
import { releaseOnSignals } from '../../packages/test-utils/src/scratch';
import { withBrowser } from '../live-app-harness';
import { frameLedger, settledAfter, waitOn } from '../product-flows';

// As the test preload does for a row: the signal releases the holds, which print the open waits.
releaseOnSignals();

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    if (new URL(request.url).pathname === '/poll') return new Response('again');

    return new Response(
      '<script>const poll = () => fetch("/poll").then(() => requestAnimationFrame(poll)); poll();</script>',
      { headers: { 'content-type': 'text/html' } },
    );
  },
});

await withBrowser(async (browser) => {
  const page = await browser.newPage();

  page.setDefaultTimeout(0);
  const ledger = await frameLedger(page);

  await page.goto(`http://127.0.0.1:${String(server.port)}/`, { waitUntil: 'load' });
  // Told once the loop has repeated, so the account the ending prints has a count to show.
  await page.waitForResponse((response) => response.url().endsWith('/poll'));
  await page.waitForResponse((response) => response.url().endsWith('/poll'));
  process.stdout.write('waiting\n');
  await waitOn(page, 'an answer that never comes', settledAfter(page, ledger, 'neverAsked'));
});
