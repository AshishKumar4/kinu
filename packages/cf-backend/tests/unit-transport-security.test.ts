import { describe, expect, test } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';

/**
 * Transport security at the Worker entry.
 *
 * Both gaps this covers were live against the then-production origin on
 * 2026-08-16: `http://<host>/api/health` answered 200 in cleartext, and no
 * HTTPS response carried `Strict-Transport-Security`. Cloudflare closes neither
 * by default — a zone has no "Always Use HTTPS" rule unless one is added, and a
 * Workers custom domain does not add one — so the Worker is the only place that
 * can, and these are the behaviours that prove it does.
 *
 * Everything here goes through the real `server.ts` fetch entry rather than the
 * helpers, because the ordering is the substance: the redirect has to happen
 * before the preview route, and the pin has to survive every route's own
 * response rewriting.
 */

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), and the entry's whole
// DO graph reaches `cloudflare:*` modules that exist only inside workerd.
const { default: worker } = await import('../src/server');

const APP_HOST = 'app.example.com';
/** Production shape: the preview suffix IS the app host, so every preview
 *  hostname is a strict subdomain of it (wrangler.jsonc PREVIEW_HOST_SUFFIX). */
const PREVIEW_HOST = `3000-workspace-tok.${APP_HOST}`;
/** Reachable over TLS but not claimed: neither the canonical origin nor under
 *  the preview suffix. Proves the upgrade and the pin follow what this
 *  deployment declares itself to be, not any host that arrives encrypted. */
const FOREIGN_HOST = 'unrelated.example.net';
const HSTS = 'max-age=31536000; includeSubDomains';

function harness(assetResponse: () => Response) {
  const assetRequests: string[] = [];
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    CLI_PUBLIC_ORIGIN: `https://${APP_HOST}`,
    PREVIEW_HOST_SUFFIX: APP_HOST,
    ASSETS: {
      fetch: async (request: Request) => {
        assetRequests.push(new URL(request.url).pathname);
        return assetResponse();
      },
    },
  });
  // SAFETY: this fixture constructs ASSETS, the only binding read by the
  // preview branch and the /assets/ public bypass these requests take.
  const env = partialEnv as Env;
  const partialCtx: Partial<ExecutionContext> = {};
  Object.assign(partialCtx, { waitUntil() {}, passThroughOnException() {} });
  // SAFETY: constructs both ExecutionContext methods; the routes under test
  // return before any handler calls either one.
  const ctx = partialCtx as ExecutionContext;
  return { env, ctx, assetRequests };
}

const script = () => new Response('console.log(1)', {
  headers: { 'content-type': 'application/javascript' },
});

describe('plain HTTP is redirected, not served', () => {
  test('301s to the same path and query on https, and serves nothing', async () => {
    const { env, ctx, assetRequests } = harness(script);
    const response = await worker.fetch(
      new Request(`http://${APP_HOST}/assets/main.js?v=2`), env, ctx,
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(`https://${APP_HOST}/assets/main.js?v=2`);
    // The point of redirecting before routing: the cleartext request never
    // reached a handler, so nothing was disclosed over it.
    expect(assetRequests).toEqual([]);
  });

  test('a preview host is upgraded on its own hostname, not diverted to the app', async () => {
    const { env, ctx, assetRequests } = harness(script);
    const response = await worker.fetch(
      new Request(`http://${PREVIEW_HOST}/index.html`), env, ctx,
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(`https://${PREVIEW_HOST}/index.html`);
    expect(assetRequests).toEqual([]);
  });

  test('a dev server on localhost is left on http', async () => {
    const { env, ctx, assetRequests } = harness(script);
    const response = await worker.fetch(
      new Request('http://localhost:5173/assets/main.js'), env, ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBeNull();
    expect(assetRequests).toEqual(['/assets/main.js']);
  });
});

describe('HTTPS responses are pinned', () => {
  test('the header is present, one year, and not preloaded', async () => {
    const { env, ctx } = harness(script);
    const response = await worker.fetch(
      new Request(`https://${APP_HOST}/assets/main.js`), env, ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBe(HSTS);
    expect(response.headers.get('strict-transport-security')).not.toContain('preload');
    expect(await response.text()).toBe('console.log(1)');
  });

  test('includeSubDomains reaches preview hosts, because they are subdomains of the app host', () => {
    expect(PREVIEW_HOST.endsWith(`.${APP_HOST}`)).toBe(true);
    expect(HSTS).toContain('includeSubDomains');
  });

  test('a 101 upgrade is returned untouched', async () => {
    const upgrade = new Response(null, { status: 101 });
    const { env, ctx } = harness(() => upgrade);
    const response = await worker.fetch(
      new Request(`https://${APP_HOST}/assets/socket`), env, ctx,
    );

    // Identity, not equality: a WebSocket handshake does not survive being
    // rebuilt into a new Response, so the pin must skip it entirely.
    expect(response).toBe(upgrade);
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('a host this deployment does not claim is left alone', () => {
  test('it is neither upgraded off cleartext nor pinned', async () => {
    const { env, ctx } = harness(script);
    const cleartext = await worker.fetch(
      new Request(`http://${FOREIGN_HOST}/assets/main.js`), env, ctx,
    );
    const secure = await worker.fetch(
      new Request(`https://${FOREIGN_HOST}/assets/main.js`), env, ctx,
    );

    // Not a 301: the redirect would send a browser to a hostname this
    // deployment never claimed, and the pin would outlive the claim by a year.
    expect(cleartext.status).toBe(200);
    expect(secure.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('the preview route still runs before app auth', () => {
  test('an https preview host reaches the preview branch, pinned and contained', async () => {
    const { env, ctx, assetRequests } = harness(script);
    const response = await worker.fetch(
      new Request(`https://${PREVIEW_HOST}/`), env, ctx,
    );

    // Not the status or body: `@cloudflare/sandbox` is mocked process-wide by
    // unit-preview-origin.test.ts, whose stub response is per-test mutable, so
    // which preview branch answers depends on file order. Every branch of
    // servePreviewRequest returns through containPreviewResponse, so
    // containment is the invariant worth asserting here.
    expect(response.headers.get('content-security-policy')).toStartWith('sandbox ');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toBe(HSTS);
    // Never the SPA: the preview host must not reach app auth or app assets.
    expect(assetRequests).toEqual([]);
  });
});
