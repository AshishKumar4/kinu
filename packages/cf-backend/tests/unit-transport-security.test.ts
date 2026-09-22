import { describe, expect, test } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { workerContext, workerEnv } from './helpers/bindings';

/**
 * Transport security at the Worker entry. Measured 2026-08-16 on the production origin: cleartext
 * `/api/health` answered 200 and no HTTPS response carried HSTS; Cloudflare closes neither by default.
 * Through the real `server.ts` entry: redirect precedes the preview route, and the pin survives rewrites.
 */

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), and the entry's whole
// DO graph reaches `cloudflare:*` modules that exist only inside workerd.
const { default: worker } = await import('../src/server');

const APP_HOST = 'app.example.com';

/** The preview suffix is the app host (wrangler.jsonc PREVIEW_HOST_SUFFIX). */
const PREVIEW_HOST = `3000-workspace-tok.${APP_HOST}`;

/** Reachable over TLS but not claimed: upgrade and pin follow what this deployment declares. */
const FOREIGN_HOST = 'unrelated.example.net';

function harness(assetResponse: () => Response) {
  const assetRequests: string[] = [];

  const env = workerEnv({
    CLI_PUBLIC_ORIGIN: `https://${APP_HOST}`,
    PREVIEW_HOST_SUFFIX: APP_HOST,
    ASSETS: {
      fetch: async (input) => {
        assetRequests.push(new URL(input instanceof Request ? input.url : String(input)).pathname);

        return assetResponse();
      },
      connect: () => { throw new Error('ASSETS.connect: not reachable in this test'); },
    },
  });

  return { env, ctx: workerContext(), assetRequests };
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
    // Redirected before routing: no handler saw the cleartext request.
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
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers.get('strict-transport-security')).not.toContain('preload');
    expect(await response.text()).toBe('console.log(1)');
  });

  test('includeSubDomains reaches preview hosts, because they are subdomains of the app host', async () => {
    expect(PREVIEW_HOST.endsWith(`.${APP_HOST}`)).toBe(true);
    const { env, ctx } = harness(script);
    const response = await worker.fetch(new Request(`https://${PREVIEW_HOST}/`), env, ctx);
    expect(response.headers.get('strict-transport-security')).toContain('includeSubDomains');
  });

  test('a 101 upgrade is returned untouched', async () => {
    const upgrade = new Response(null, { status: 101 });
    const { env, ctx } = harness(() => upgrade);

    const response = await worker.fetch(
      new Request(`https://${APP_HOST}/assets/socket`), env, ctx,
    );

    // Identity, not equality: a WebSocket handshake does not survive being rebuilt.
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

    // Not a 301: the pin would outlive a claim this deployment never made.
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

    // Not status or body: unit-preview-origin.test.ts mocks `@cloudflare/sandbox` per test, so the branch
    // depends on file order; every branch returns through containPreviewResponse.
    expect(response.headers.get('content-security-policy')).toStartWith('sandbox ');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    // Never the SPA: the preview host must not reach app auth or app assets.
    expect(assetRequests).toEqual([]);
  });
});
