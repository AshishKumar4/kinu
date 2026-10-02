/**
 * What ends a harness wait before its condition holds: a failure the page shows, named beside what the wait was
 * for. On 2026-09-24 a sweep's Drive row waited 36 minutes on a Drive whose listing had failed, while the page said
 * why the whole time. Which words each failure display marks is the product's side, held by
 * packages/cf-backend/tests/unit-failure-marks.test.ts.
 */
import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { detach } from '@kinu.run/core/obs';
import type { ServerWebSocket } from 'bun';
import type { Browser, Page } from 'puppeteer';
import { join } from 'node:path';
import * as v from 'valibot';
import { runToExit } from '@kinu.run/test-utils';
import { withBrowser } from '../../scripts/live-app-harness';
import { frameLedger, HOST_NETWORK_CHANGED, hostNetworkChange, recordDeadEnds, settledAfter, until, waitOn } from '../../scripts/product-flows';

const NETWORK_CHANGE_SCENARIO = join(import.meta.dir, '..', '..', 'scripts', 'network-change-scenario.ts');

const UNSETTLED_PAGE_SCENARIO = join(import.meta.dir, '..', '..', 'scripts', 'fixtures', 'unsettled-page-scenario.ts');

const ScenarioSchema = v.object({ loads: v.number(), reasons: v.array(v.string()) });

/** The wait's condition, counting every poll of it, so a test can hold a failure in front of the wait first. */
const ANSWERED = '(window.__polls = (window.__polls ?? 0) + 1, window.__answered === true)';

const UNCONFIGURED = 'This deployment is not configured to serve signed-in users: CREDENTIAL_ENCRYPTION_KEY is not set.';

const OFFLINE = '<div class="p-notice-danger">Could not send to the turn: offline</div>';

/** A load that failed, as LoadFailure draws one. */
const LOAD_FAILED = `<div class="p-danger"><span data-failure>Could not load this folder: ${UNCONFIGURED}</span><button>Retry</button></div>`;

async function blankPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();

  page.setDefaultTimeout(0);
  await page.setContent('<main></main>');

  return page;
}

async function show(page: Page, markup: string, shown = true): Promise<void> {
  await page.evaluate((html, visible) => {
    const holder = document.createElement('div');

    holder.innerHTML = html;

    if (!visible) holder.style.display = 'none';
    document.body.append(holder);
  }, markup, shown);
}

/** Settles once two polls of the wait have read the page as it is now. */
async function polledTwice(page: Page): Promise<void> {
  const from = Number(await page.evaluate('window.__polls ?? 0'));

  await page.waitForFunction(`window.__polls >= ${String(from + 2)}`);
}

/** The wait for the answer, with `arrange` run while it is open and the answer given after: it settles as the
 *  wait did. */
async function answerWait(arrange: (page: Page) => Promise<void>): Promise<void> {
  return withBrowser(async (browser) => {
    const page = await blankPage(browser);
    const waited = until(page, 'the answer', ANSWERED);

    // A wait that ended stops polling, so `arrange` could wait on it forever: its end ends this too.
    await Promise.race([arrange(page), waited]);
    await page.evaluate('window.__answered = true');

    return waited;
  });
}

test('a failure the page shows ends the wait, naming what it waited for and the failure', async () => {
  await expect(answerWait(async (page) => {
    await show(page, LOAD_FAILED);
    await polledTwice(page);
  })).rejects.toThrow(`waiting for the answer, the page showed a notice: Could not load this folder: ${UNCONFIGURED}`);
});

test('a failure the page hides leaves the wait running', async () => {
  await answerWait(async (page) => {
    await show(page, OFFLINE, false);
    await polledTwice(page);
  });
});

test('a wait on a turn\'s socket ends on the failure its page shows', async () => {
  await withBrowser(async (browser) => {
    const page = await blankPage(browser);

    await show(page, OFFLINE);

    await expect(waitOn(page, 'the turn to close', new Promise<never>(() => undefined)))
      .rejects.toThrow('waiting for the turn to close, the page showed a notice: Could not send to the turn: offline');
  });
});

/** An app whose entry imports `/dep.js`; how many times its page was loaded. */
interface ModuleApp {
  readonly origin: string;
  loads(): number;
  stop(): Promise<void>;
}

/** A {@link ModuleApp} whose `/dep.js` is answered by `dep`. */
function moduleApp(dep: () => Response): ModuleApp {
  let loads = 0;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;

      if (path === '/') {
        loads += 1;

        return new Response('<script type="module" src="/entry.js"></script>', { headers: { 'content-type': 'text/html' } });
      }

      if (path === '/entry.js') {
        return new Response("import './dep.js';", { headers: { 'content-type': 'text/javascript' } });
      }

      return path === '/dep.js' ? dep() : new Response('not here', { status: 404 });
    },
  });

  return { origin: `http://127.0.0.1:${String(server.port)}`, loads: () => loads, stop: () => server.stop(true) };
}

test('a module the server fails leaves the page blank, named with its answer, and is not retried', async () => {
  // Vite answers a request for a dependency it re-bundled mid-run with 504 ("Outdated Optimize Dep").
  const app = moduleApp(() => new Response('outdated optimize dep', { status: 504 }));

  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();

      await recordDeadEnds(page);
      await page.goto(`${app.origin}/`, { waitUntil: 'load' });

      await expect(until(page, 'the answer', ANSWERED)).rejects.toThrow(`waiting for the answer, the page showed the app script `
        + `${app.origin}/entry.js failed to load, which leaves the page blank; its script requests failed: ${app.origin}/dep.js (HTTP 504)`);
    });
    expect(app.loads()).toBe(1);
  } finally {
    await app.stop();
  }
});

test('a module the network failed is named with the browser\'s error, and a failure that is not the host is not retried', async () => {
  const app = moduleApp(() => new Response('never sent'));

  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();

      await recordDeadEnds(page);
      await page.setRequestInterception(true);
      page.on('request', (request) => detach(Effect.promise(async () => {
        if (request.url().endsWith('/dep.js')) await request.abort('connectionreset');
        else await request.continue();
      })));
      await page.goto(`${app.origin}/`, { waitUntil: 'load' });

      await expect(until(page, 'the answer', ANSWERED)).rejects.toThrow(`${app.origin}/dep.js (net::ERR_CONNECTION_RESET)`);
    });
    expect(app.loads()).toBe(1);
  } finally {
    await app.stop();
  }
});

test('a module graph a network change failed is loaded again, once, and the wait goes on', async () => {
  // In a user and network namespace of its own: the address the scenario adds is a change Chrome sees there alone.
  const run = await runToExit(['unshare', '-rn', 'sh', '-c',
    'ip link set lo up && ip link add dummy0 type dummy && ip link set dummy0 up && exec "$0" "$1"',
    process.execPath, NETWORK_CHANGE_SCENARIO]);

  expect(run.exitCode, run.stderr).toBe(0);
  expect(v.parse(ScenarioSchema, JSON.parse(run.stdout))).toEqual({ loads: 2, reasons: [HOST_NETWORK_CHANGED] });
  expect(run.stderr).toContain(`the host's network changed while the page loaded (${HOST_NETWORK_CHANGED} on `);
});

test('only a module graph that the host\'s network change alone failed is the host\'s', () => {
  const changed = { at: 1, url: 'http://127.0.0.1:1/dep.js', reason: HOST_NETWORK_CHANGED };
  const cancelled = { at: 2, url: 'http://127.0.0.1:1/other.js', reason: 'net::ERR_ABORTED' };

  expect(hostNetworkChange([changed])).toEqual(changed);
  // A request the browser cancelled is an effect of the change, not a second cause.
  expect(hostNetworkChange([cancelled, changed])).toEqual(changed);
  expect(hostNetworkChange([changed, { at: 3, url: 'http://127.0.0.1:1/x.js', reason: 'HTTP 504' }])).toBeNull();
  expect(hostNetworkChange([{ at: 4, url: 'http://127.0.0.1:1/x.js', reason: 'net::ERR_CONNECTION_REFUSED' }])).toBeNull();
  expect(hostNetworkChange([cancelled])).toBeNull();
  expect(hostNetworkChange([])).toBeNull();
});

/**
 * 2026-09-30 (staging deploy of d59a30999): a row waited 480 s on a reloaded page that never went quiet, and the
 * kill named only the wait. Ended the way the row's bound ends it, the run names what the page kept sending.
 */
test('a wait on a page that never goes quiet, ended from outside, names what the page kept sending', async () => {
  const child = Bun.spawn(['bun', UNSETTLED_PAGE_SCENARIO], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let said = '';

  while (!said.includes('waiting')) {
    const read = await reader.read();

    if (read.done) break;
    said += new TextDecoder().decode(read.value);
  }

  child.kill('SIGTERM');
  await child.exited;
  const printed = await stderr;

  expect(printed).toContain('ended while waiting for an answer that never comes');
  expect(printed).toMatch(/requests: \/poll ×([2-9]|\d{2,})/u);
});

/**
 * A socket's own RPC ids restart with it, and a page that unloads leaves its last asks unanswered. On 2026-09-30 a
 * row restarted its ledger, reloaded the page, and waited 480 s on an ask the unloaded page's socket never answered.
 */
test('an ask whose socket closed unanswered does not hold the wait, and an id another socket reuses is its own', async () => {
  // Closes on anything but a snapshot without answering, as an unloading page's socket ends with its last ask open.
  const { server } = snapshotServer('close');

  try {
    await withBrowser(async (browser) => {
      const page = await blankPage(browser);
      await page.goto(`http://127.0.0.1:${String(server.port)}/`);
      const ledger = await frameLedger(page);

      await page.evaluate(async (url) => {
        const ask = (id: string, method: string) => new Promise<void>((resolve) => {
          const socket = new WebSocket(url);

          socket.onopen = () => { socket.send(JSON.stringify({ type: 'rpc', id, method })); };

          socket.onclose = () => { resolve(); };

          socket.onmessage = () => { socket.close(); };
        });

        await ask('7', 'listTurnFeedback');
        await ask('1', 'getWorkspaceSnapshot');
      }, `ws://127.0.0.1:${String(server.port)}/`);

      await settledAfter(page, ledger, 'getWorkspaceSnapshot');
      await ledger.stop();
    });
  } finally {
    await server.stop(true);
  }
});

/**
 * A socket server that answers only `getWorkspaceSnapshot`. Any other ask is left open: its socket is closed at once
 * (`close`), or kept and listed in `held` for the test to close.
 */
function snapshotServer(unanswered: 'close' | 'hold') {
  const held: ServerWebSocket[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, bun) {
      if (bun.upgrade(request)) return undefined;

      return new Response('<main></main>', { headers: { 'content-type': 'text/html' } });
    },
    websocket: {
      message(socket, raw) {
        const ask = v.parse(v.object({ id: v.string(), method: v.string() }), JSON.parse(String(raw)));

        if (ask.method === 'getWorkspaceSnapshot') socket.send(JSON.stringify({ type: 'rpc', id: ask.id, done: true, result: {} }));
        else if (unanswered === 'close') socket.close();
        else held.push(socket);
      },
    },
  });

  return { server, held };
}

/** Two live sockets reuse one RPC id: the answer on one says nothing about the ask still open on the other. */
test('the same RPC id asked on two live sockets stays open until its own socket answers or closes', async () => {
  const { server, held } = snapshotServer('hold');

  try {
    await withBrowser(async (browser) => {
      const page = await blankPage(browser);
      await page.goto(`http://127.0.0.1:${String(server.port)}/`);
      const ledger = await frameLedger(page);

      // The held socket asks first, the answered one second, both as id 5.
      await page.evaluate(async (url) => {
        const ask = (method: string, answered: boolean) => new Promise<void>((resolve) => {
          const socket = new WebSocket(url);

          socket.onopen = () => {
            socket.send(JSON.stringify({ type: 'rpc', id: '5', method }));

            if (!answered) resolve();
          };

          socket.onmessage = () => { resolve(); };
        });

        await ask('listTurnFeedback', false);
        await ask('getWorkspaceSnapshot', true);
      }, `ws://127.0.0.1:${String(server.port)}/`);

      // The ledger has heard the one answer, so what it says now is about the other ask.
      await ledger.received('rpc');
      expect(ledger.quiet()).toBe(false);

      for (const socket of held) socket.close();

      await settledAfter(page, ledger, 'getWorkspaceSnapshot');
      await ledger.stop();
    });
  } finally {
    await server.stop(true);
  }
});
