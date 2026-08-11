/**
 * Preview-origin containment.
 *
 * A previewed app is HTML the agent wrote from sources it does not control. The
 * invariant under test is that it never runs as the Proteus app: not on the
 * app's origin, not with the app's session cookie, and not able to reach
 * another preview.
 *
 * Sandbox containers get a hostname per exposed port, so each preview is its
 * own origin and may keep it. Nimbus session content cannot move off the app's
 * host, so it stays opaque. containPreviewResponse takes which one it is.
 */
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PREVIEW_SANDBOX,
  containPreviewResponse,
  extractPreviewUrl,
  isPreviewUrl,
  isPreviewHostRequest,
  previewHostSuffix,
} from '../src/lib/preview-origin.js';
import { appDocumentCsp, publicHtmlHeaders, withAppSecurityHeaders } from '../src/lib/security-headers.js';
import { crossSiteRejection } from '../src/auth/session.js';

// The SDK's entry point pulls in `cloudflare:workers`, which only exists inside
// workerd. proxyToSandbox is the seam the Worker delegates preview routing to,
// so standing in for it here leaves everything Proteus owns under test.
let sdkResponse: Response | null = null;
mock.module('@cloudflare/sandbox', () => ({
  proxyToSandbox: async () => sdkResponse,
}));
const { SDK_FORWARD_FAILURE, servePreviewRequest } = await import('../src/preview-proxy.js');

const root = join(import.meta.dir, '..');
const source = (path: string): string => readFileSync(join(root, path), 'utf8');

const APP = 'https://proteus.example.com';
const SUFFIX = 'previews.example';
const PREVIEW_HOST = `8080-proteus-hello-p8080_ab12cd34.${SUFFIX}`;
const PREVIEW_URL = `https://${PREVIEW_HOST}/`;
const ENV = { CLI_PUBLIC_ORIGIN: APP, PREVIEW_HOST_SUFFIX: SUFFIX };

async function serve(url: string, response: Response | null): Promise<Response> {
  sdkResponse = response;
  return servePreviewRequest(new Request(url), ENV as unknown as Env);
}

describe('preview sandbox policy', () => {
  test('a preview on its own host keeps that origin; app-host content never does', () => {
    expect(PREVIEW_SANDBOX).toContain('allow-same-origin');
    expect(PREVIEW_SANDBOX).toContain('allow-scripts');

    const onAppHost = containPreviewResponse(new Response('x'), 'app-host');
    expect(onAppHost.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(onAppHost.headers.get('content-security-policy')).toContain('allow-scripts');
  });

  test('the iframe attribute is the shared policy, not a private copy', () => {
    const frame = source('src/components/PreviewFrame.tsx');
    expect(frame).toContain('sandbox={PREVIEW_SANDBOX}');
    expect(frame).not.toContain('allow-same-origin');
  });

  test('the policy is a response header, not only the iframe attribute', () => {
    // Users open preview URLs in new tabs, where the attribute does not exist.
    const contained = containPreviewResponse(new Response('<h1>hi</h1>', {
      headers: { 'content-type': 'text/html' },
    }), 'own-host');
    expect(contained.headers.get('content-security-policy')).toBe(`sandbox ${PREVIEW_SANDBOX}`);
  });

  test('a container cannot relax the sandbox through the proxy', () => {
    const contained = containPreviewResponse(new Response('body', {
      headers: { 'content-security-policy': 'sandbox allow-scripts allow-same-origin allow-top-navigation' },
    }), 'app-host');
    const csp = contained.headers.get('content-security-policy')!;
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-top-navigation');
  });

  test('a report-only CSP cannot survive alongside the sandbox directive', () => {
    const contained = containPreviewResponse(new Response('body', {
      headers: { 'content-security-policy-report-only': "default-src 'none'" },
    }), 'own-host');
    expect(contained.headers.get('content-security-policy-report-only')).toBeNull();
  });

  test('on the app host every container cookie is dropped', () => {
    const contained = containPreviewResponse(new Response('body', {
      headers: { 'set-cookie': '__Host-proteus_session=forged; Path=/; Secure' },
    }), 'app-host');
    expect(contained.headers.get('set-cookie')).toBeNull();
  });

  test('on its own host a preview keeps host-only cookies but cannot plant one across the suffix', () => {
    const response = new Response('body');
    response.headers.append('set-cookie', 'sid=mine; Path=/; Secure; HttpOnly');
    response.headers.append('set-cookie', `shared=everywhere; Domain=.${SUFFIX}; Path=/`);
    const kept = containPreviewResponse(response, 'own-host').headers.getSetCookie();
    expect(kept).toEqual(['sid=mine; Path=/; Secure; HttpOnly']);
  });

  test('the port token lives in the hostname, so Referer is muzzled', () => {
    // The browser's default policy sends the origin cross-origin — and under
    // this scheme the origin is the credential.
    expect(containPreviewResponse(new Response('x'), 'own-host').headers.get('referrer-policy'))
      .toBe('no-referrer');
  });

  test('a WebSocket handshake passes through untouched', () => {
    const upgrade = new Response(null, { status: 101 });
    expect(containPreviewResponse(upgrade, 'own-host')).toBe(upgrade);
  });
});

describe('preview host resolution', () => {
  test('the configured zone is the suffix', () => {
    expect(previewHostSuffix(ENV)).toBe(SUFFIX);
    expect(previewHostSuffix({ ...ENV, PREVIEW_HOST_SUFFIX: `.${SUFFIX.toUpperCase()}.` })).toBe(SUFFIX);
  });

  test('unconfigured, unusable, or the app itself means no preview host at all', () => {
    expect(previewHostSuffix({ CLI_PUBLIC_ORIGIN: APP })).toBeNull();
    expect(previewHostSuffix({ ...ENV, PREVIEW_HOST_SUFFIX: '  ' })).toBeNull();
    // A single label would claim a whole TLD, the app's host included.
    expect(previewHostSuffix({ ...ENV, PREVIEW_HOST_SUFFIX: 'example' })).toBeNull();
    expect(previewHostSuffix({ ...ENV, PREVIEW_HOST_SUFFIX: 'proteus.example.com' })).toBeNull();
  });

  test('everything under the suffix is preview territory, and the app never is', () => {
    expect(isPreviewHostRequest(new URL(PREVIEW_URL), ENV)).toBe(true);
    expect(isPreviewHostRequest(new URL(`https://${PREVIEW_HOST.toUpperCase()}/`), ENV)).toBe(true);
    // Not a well-formed preview label, but still not the app: it gets a 404.
    expect(isPreviewHostRequest(new URL(`https://anything.${SUFFIX}/`), ENV)).toBe(true);
    expect(isPreviewHostRequest(new URL(`https://${SUFFIX}/`), ENV)).toBe(false);
    expect(isPreviewHostRequest(new URL(`${APP}/`), ENV)).toBe(false);
  });

  test('an app hosted inside the preview zone is still served as the app', () => {
    // The suffix may legitimately be the app's own registrable domain.
    const env = { CLI_PUBLIC_ORIGIN: 'https://proteus.example.com', PREVIEW_HOST_SUFFIX: 'example.com' };
    expect(isPreviewHostRequest(new URL('https://proteus.example.com/'), env)).toBe(false);
    expect(isPreviewHostRequest(new URL('https://8080-a-b.example.com/'), env)).toBe(true);
  });

  test('with previews unconfigured no host is preview territory', () => {
    expect(isPreviewHostRequest(new URL(PREVIEW_URL), { CLI_PUBLIC_ORIGIN: APP })).toBe(false);
  });
});

describe('serving the preview host', () => {
  test('a container response is passed through, contained', async () => {
    const container = new Response('<h1>app</h1>', { headers: { 'content-type': 'text/html' } });
    container.headers.append('set-cookie', `tracker=1; Domain=.${SUFFIX}`);
    const res = await serve(PREVIEW_URL, container);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(`sandbox ${PREVIEW_SANDBOX}`);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('a host that resolves to no exposed port gets a 404, never the app', async () => {
    const res = await serve(`https://not-a-preview.${SUFFIX}/login`, null);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_A_PREVIEW' });
  });

  test('the SDK owns token validation, so a bad token never reaches here', async () => {
    // proxyToSandbox forwards to the Durable Object, which checks the port's
    // token before touching the container and answers 404 INVALID_TOKEN.
    const res = await serve(PREVIEW_URL, new Response(
      JSON.stringify({ error: 'Access denied', code: 'INVALID_TOKEN' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  test('a failed forward becomes a page the user can act on', async () => {
    const res = await serve(PREVIEW_URL, new Response(SDK_FORWARD_FAILURE.body, { status: SDK_FORWARD_FAILURE.status }));
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('Preview not ready');
    expect(html).toContain('8080');
    expect(res.headers.get('content-security-policy')).toBe(`sandbox ${PREVIEW_SANDBOX}`);
  });

  test("the SDK's forward-failure response is still the shape we match", () => {
    // If an upgrade renames it, the friendly page silently stops appearing.
    const sdk = readFileSync(join(root, '../../node_modules/@cloudflare/sandbox/dist/index.js'), 'utf8');
    expect(sdk.includes(SDK_FORWARD_FAILURE.body)).toBe(true);
  });

  test('the error page escapes what it echoes from the hostname', () => {
    expect(source('src/preview-proxy.ts')).toContain('escapeHtml(sandboxId)');
  });

  test('routing is the SDK\'s, not a second parser of our own', () => {
    const proxy = source('src/preview-proxy.ts');
    expect(proxy).toContain('proxyToSandbox(request, env)');
    expect(proxy).not.toContain('validatePortToken');
    expect(proxy).not.toContain('containerFetch');
  });
});

describe('what the app is willing to frame', () => {
  test('accepts a preview hostname', () => {
    expect(isPreviewUrl(PREVIEW_URL)).toBe(true);
    expect(isPreviewUrl(`${PREVIEW_URL}index.html?x=1`)).toBe(true);
  });

  test('rejects anything that is not one', () => {
    expect(isPreviewUrl(`http://${PREVIEW_HOST}/`)).toBe(false);
    expect(isPreviewUrl(`https://user:pw@${PREVIEW_HOST}/`)).toBe(false);
    // The label has to be the whole first label, not buried in a longer one.
    expect(isPreviewUrl(`https://evil.example/${PREVIEW_HOST}/`)).toBe(false);
    expect(isPreviewUrl(`https://x8080-proteus-hello-tok.${SUFFIX}/`)).toBe(false);
    expect(isPreviewUrl(`https://8080-proteus.${SUFFIX}/`)).toBe(false);
    expect(isPreviewUrl('https://evil.example/')).toBe(false);
    expect(isPreviewUrl('javascript:alert(1)')).toBe(false);
    expect(isPreviewUrl('not a url')).toBe(false);
  });

  test('tool output is scanned for preview URLs only', () => {
    expect(extractPreviewUrl(`server up at ${PREVIEW_URL} enjoy`)).toBe(PREVIEW_URL);
    expect(extractPreviewUrl({ url: PREVIEW_URL })).toBe(PREVIEW_URL);
    expect(extractPreviewUrl('see https://evil.example/8080-a-b/')).toBeNull();
    expect(extractPreviewUrl('nothing here')).toBeNull();
  });
});

describe('the app document policy', () => {
  test('authenticated app HTML carries a CSP', () => {
    const res = withAppSecurityHeaders(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      new URL(APP),
      `https://*.${SUFFIX}`,
    );
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('only preview hosts may be framed', () => {
    expect(appDocumentCsp(new URL(APP), `https://*.${SUFFIX}`))
      .toContain(`frame-src 'self' https://*.${SUFFIX}`);
    expect(appDocumentCsp(new URL(APP), null)).toContain("frame-src 'self'");
  });

  test('the app names the preview wildcard, not a single host', () => {
    expect(source('src/server.ts')).toContain('`https://*.${suffix}`');
  });

  test('the chat WebSocket survives the connect-src rule', () => {
    expect(appDocumentCsp(new URL(APP), null)).toContain("connect-src 'self' wss://proteus.example.com");
  });

  test('non-document responses are left alone', () => {
    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(withAppSecurityHeaders(json, new URL(APP), null)).toBe(json);
  });

  test('standalone pages keep their stricter policy', () => {
    const csp = publicHtmlHeaders()['content-security-policy'];
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain('https://static.cloudflareinsights.com');
  });
});

describe('CSRF on cookie-authenticated requests', () => {
  const cookie = { cookie: '__Host-proteus_session=abc' };
  const post = (headers: Record<string, string>) =>
    new Request(`${APP}/api/user/credentials/anthropic`, { method: 'POST', headers, body: '{}' });

  test('a same-origin write is allowed', () => {
    expect(crossSiteRejection(post({ ...cookie, origin: APP }))).toBeNull();
  });

  test('a write from a preview origin is rejected', () => {
    const res = crossSiteRejection(post({ ...cookie, origin: `https://${PREVIEW_HOST}` }));
    expect(res?.status).toBe(403);
  });

  test('a write with no Origin at all is rejected', () => {
    expect(crossSiteRejection(post({ ...cookie }))?.status).toBe(403);
  });

  test('Referer stands in when Origin is absent', () => {
    expect(crossSiteRejection(post({ ...cookie, referer: `${APP}/w/hello` }))).toBeNull();
    expect(crossSiteRejection(post({ ...cookie, referer: 'https://evil.example/x' }))?.status).toBe(403);
  });

  test('reads are not gated — the same-origin policy already covers them', () => {
    expect(crossSiteRejection(new Request(`${APP}/api/user/profile`, { headers: cookie }))).toBeNull();
  });

  test('a WebSocket upgrade is gated even though it is a GET', () => {
    const upgrade = (origin: string) => new Request(`${APP}/agents/orchestrator-agent/hello`, {
      headers: { ...cookie, origin, upgrade: 'websocket' },
    });
    expect(crossSiteRejection(upgrade(APP))).toBeNull();
    expect(crossSiteRejection(upgrade('https://evil.example'))?.status).toBe(403);
  });

  test('token-authenticated clients are unaffected', () => {
    // No session cookie means no ambient credential to abuse — the CLI posts
    // with a bearer token and no Origin header at all.
    expect(crossSiteRejection(post({ authorization: 'Bearer pta_x' }))).toBeNull();
  });
});

describe('worker wiring', () => {
  const server = source('src/server.ts');

  test('the preview host serves previews and nothing else', () => {
    expect(server).toContain('isPreviewHostRequest(url, env)');
    expect(server).toContain('return servePreviewRequest(request, env)');
    // Ahead of every other route, so nothing on that host can mint a session.
    expect(server.indexOf('isPreviewHostRequest(url, env)'))
      .toBeLessThan(server.indexOf('handlePcRequest(request, env)'));
  });

  test('no route on the app host serves previews any more', () => {
    // The path-style proxy bypassed the auth gate by design; nothing may.
    expect(source('src/auth/session.ts')).not.toContain('_preview');
    expect(server).not.toContain('_preview');
  });

  test('every asset response goes through the app document policy', () => {
    expect(server).toContain('serveApp(request, env)');
    expect(server).not.toContain('return env.ASSETS.fetch(request)');
    expect(server).not.toContain('await env.ASSETS.fetch(request), identity');
  });

  test('the CSRF gate runs before any authenticated route', () => {
    expect(server).toContain('crossSiteRejection(request)');
    expect(server.indexOf('crossSiteRejection(request)'))
      .toBeLessThan(server.indexOf('handleUserRequest(authenticatedRequest'));
  });

  test('Nimbus previews stay opaque on the app host', () => {
    expect(server).toContain("containPreviewResponse(nimbusResp, 'app-host')");
  });

  test('the configured preview suffix can never be the app host', () => {
    // Comments are stripped: the note above the var shows an example zone, and
    // it must not be mistaken for the configured one.
    const wrangler = source('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '');
    // Production is the first of each — the staging environment follows.
    const first = (key: string): string =>
      wrangler.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))![1];
    const vars = {
      PREVIEW_HOST_SUFFIX: first('PREVIEW_HOST_SUFFIX'),
      CLI_PUBLIC_ORIGIN: first('CLI_PUBLIC_ORIGIN'),
    };
    const suffix = previewHostSuffix(vars);
    expect(suffix === null || new URL(vars.CLI_PUBLIC_ORIGIN).hostname !== suffix).toBe(true);
  });
});
