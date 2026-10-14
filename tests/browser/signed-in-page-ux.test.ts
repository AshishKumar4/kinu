/**
 * A signed-in page holds a session cookie its origin scopes, never the dev identity's secret.
 *
 * 2026-10-14: `signedInPage` set the secret as a header on the whole page, so a slate's third-party subresources and
 * any socket to another origin carried it. It now exchanges the header once, on the app's origin, for the session any
 * sign-in mints (`POST /api/auth/dev-session`), and Chrome scopes that cookie as it scopes any. Measured before the fix
 * (Chrome, 2026-10-14): a page-wide header reached a foreign image and a foreign WebSocket; Fetch interception and CDP
 * request blocking reach no WebSocket, so no header can be kept from a foreign socket, and a cookie is the browser's
 * own per-origin credential.
 */
import { afterAll, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER } from '@kinu.run/core';
import { sessionCookie, SESSION_COOKIE_NAME } from '../../packages/cf-backend/src/auth/cookies';
import { signedInPage } from '../../evals/src/browser';
import { launchTestChrome } from '../../scripts/test-chrome';

const SECRET = 'the-deployment-secret';

const TOKEN = 'ps_user_the-session';

interface Heard {
  readonly at: string;
  readonly session: boolean;
  readonly secret: boolean;
}

/** One origin's server, recording what each request it answers carried. */
function receiver(page: (other: string) => string, heard: Heard[], name: string) {
  let other = '';

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, serving) {
      const url = new URL(request.url);
      const at = `${name}${url.pathname}`;

      if (url.pathname === '/favicon.ico') return new Response(null, { status: 404 });
      heard.push({
        at: request.method === 'POST' ? `${at} POST` : at,
        session: (request.headers.get('cookie') ?? '').includes(`${SESSION_COOKIE_NAME}=${TOKEN}`),
        secret: request.headers.get(DEV_IDENTITY_HEADER) === SECRET,
      });

      if (url.pathname === '/ws') return serving.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });

      if (url.pathname === '/api/auth/dev-session') {
        const held = request.method === 'POST' && request.headers.get(DEV_IDENTITY_HEADER) === SECRET
          && request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER) === 'scripted';

        return held
          ? Response.json({ user: null }, { headers: { 'set-cookie': sessionCookie({ token: TOKEN, issuedAt: 0, expiresAt: 60_000 }) } })
          : new Response('no dev identity', { status: 401 });
      }

      if (url.pathname === '/') return new Response(page(other), { headers: { 'content-type': 'text/html' } });

      return new Response(new Uint8Array([71, 73, 70]), { headers: { 'content-type': 'image/gif', 'access-control-allow-origin': '*' } });
    },
    websocket: { message() {} },
  });

  return { port: server.port, setOther: (to: string) => { other = to; }, stop: async () => server.stop(true) };
}

const heard: Heard[] = [];

const foreign = receiver(() => '', heard, 'foreign');

// The app on `localhost`, the foreign receiver on 127.0.0.1: two sites, as a deployment and a slate's CDN are.
const app = receiver((other) => `<!doctype html><img src="${other}/img"><script>
  window.opened = Promise.all([fetch('/api/read'), fetch('${other}/fetch').catch(() => null),
    ...['ws://' + location.host + '/ws', '${other.replace('http', 'ws')}/ws'].map((url) => new Promise((done) => {
      const socket = new WebSocket(url);
      socket.onopen = socket.onerror = () => done(null);
    }))]);
</script>`, heard, 'app');

const origin = `http://localhost:${String(app.port)}`;

app.setOther(`http://127.0.0.1:${String(foreign.port)}`);

const chrome = await launchTestChrome();

afterAll(async () => {
  await chrome.close();
  await Promise.all([app.stop(), foreign.stop()]);
});

/** What each request of a page that loads the app's own and a foreign origin's resources carried. */
async function load(page: Page): Promise<readonly Heard[]> {
  const from = heard.length;

  await page.goto(origin);
  await page.evaluate('window.opened');
  await page.close();

  return heard.slice(from).sort((a, b) => a.at.localeCompare(b.at));
}

test('a signed-in page sends its session to its own origin, HTTP and socket alike, and nothing to another', async () => {
  const before = heard.length;
  const page = await signedInPage(chrome.browser, { origin, identity: { kind: 'secret', secret: SECRET, account: 'scripted' } });
  const exchange = heard.slice(before);

  expect({ exchange, load: await load(page) }).toEqual({
    exchange: [{ at: 'app/api/auth/dev-session POST', session: false, secret: true }],
    load: [
      { at: 'app/', session: true, secret: false },
      { at: 'app/api/read', session: true, secret: false },
      { at: 'app/ws', session: true, secret: false },
      { at: 'foreign/fetch', session: false, secret: false },
      { at: 'foreign/img', session: false, secret: false },
      { at: 'foreign/ws', session: false, secret: false },
    ],
  });
});

test('a second page of the same identity signs in no second time, and a page outside it is signed out', async () => {
  const before = heard.length;
  const again = await load(await signedInPage(chrome.browser, { origin, identity: { kind: 'secret', secret: SECRET, account: 'scripted' } }));
  const outside = await load(await chrome.browser.newPage());

  expect({
    exchanges: heard.slice(before).filter((request) => request.at.endsWith('POST')).length,
    again: again.filter((request) => request.at.startsWith('app/')).map((request) => request.session),
    outside: outside.some((request) => request.session || request.secret),
  }).toEqual({ exchanges: 0, again: [true, true, true], outside: false });
});
