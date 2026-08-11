/**
 * Preview-origin containment.
 *
 * A previewed app is HTML the agent wrote from sources it does not control. The
 * invariant under test is that it never runs as the Proteus app: not on the
 * app's origin, not with `allow-same-origin`, and not able to ride the owner's
 * session cookie into `/api/user/*`.
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
  isolatedPreviewHost,
} from '../src/lib/preview-origin.js';
import { appDocumentCsp, publicHtmlHeaders, withAppSecurityHeaders } from '../src/lib/security-headers.js';
import { crossSiteRejection } from '../src/auth/session.js';

// The SDK's entry point pulls in `cloudflare:workers`, which only exists inside
// workerd. getSandbox() is a proxy onto the DO stub, so standing in for it at
// that seam leaves the proxy's own routing under test.
mock.module('@cloudflare/sandbox', () => ({
  getSandbox: (ns: { get: () => unknown }) => ns.get(),
}));
const { parsePreviewRoute, proxyPreviewRequest } = await import('../src/preview-proxy.js');

const root = join(import.meta.dir, '..');
const source = (path: string): string => readFileSync(join(root, path), 'utf8');

const APP = 'https://proteus.example.com';
const PREVIEW = 'previews.example.workers.dev';
const ISOLATED_ENV = { CLI_PUBLIC_ORIGIN: APP, PREVIEW_HOSTNAME: PREVIEW };
const SHARED_ENV = { CLI_PUBLIC_ORIGIN: APP, PREVIEW_HOSTNAME: 'proteus.example.com' };

const ROUTE = '/_preview/8080/proteus-hello/tok123/';

/** A Sandbox DO namespace whose stub answers the two RPCs the proxy uses. */
function sandboxNamespace(response: Response, valid = true) {
  const stub = {
    validatePortToken: async () => valid,
    containerFetch: async () => response,
    fetch: async () => response,
  };
  return { idFromName: (name: string) => name, get: () => stub } as unknown as Env['Sandbox'];
}

describe('preview sandbox policy', () => {
  test('previews never get allow-same-origin', () => {
    expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin');
    expect(PREVIEW_SANDBOX).toContain('allow-scripts');
  });

  test('the iframe attribute is the shared policy, not a private copy', () => {
    const frame = source('src/components/PreviewFrame.tsx');
    expect(frame).toContain('sandbox={PREVIEW_SANDBOX}');
    expect(frame).not.toContain('allow-same-origin');
  });

  test('a preview response is pinned to an opaque origin', () => {
    const contained = containPreviewResponse(new Response('<h1>hi</h1>', {
      headers: { 'content-type': 'text/html' },
    }));
    const csp = contained.headers.get('content-security-policy');
    expect(csp).toBe(`sandbox ${PREVIEW_SANDBOX}`);
    expect(csp).not.toContain('allow-same-origin');
  });

  test('a container cannot set cookies or relax the sandbox through the proxy', () => {
    const contained = containPreviewResponse(new Response('body', {
      headers: {
        'set-cookie': '__Host-proteus_session=forged; Path=/; Secure',
        'content-security-policy': "sandbox allow-scripts allow-same-origin",
      },
    }));
    expect(contained.headers.get('set-cookie')).toBeNull();
    expect(contained.headers.get('content-security-policy')).toBe(`sandbox ${PREVIEW_SANDBOX}`);
  });

  test('a WebSocket handshake passes through untouched', () => {
    const upgrade = new Response(null, { status: 101 });
    expect(containPreviewResponse(upgrade)).toBe(upgrade);
  });
});

describe('preview origin resolution', () => {
  test('a distinct preview host is reported as isolated', () => {
    expect(isolatedPreviewHost(ISOLATED_ENV)).toBe(PREVIEW);
  });

  test('sharing the app host is not isolation', () => {
    expect(isolatedPreviewHost(SHARED_ENV)).toBeNull();
    expect(isolatedPreviewHost({ CLI_PUBLIC_ORIGIN: APP })).toBeNull();
  });

  test('the preview host is recognised case-insensitively', () => {
    expect(isPreviewHostRequest(new URL(`https://${PREVIEW.toUpperCase()}${ROUTE}`), ISOLATED_ENV)).toBe(true);
    expect(isPreviewHostRequest(new URL(`${APP}${ROUTE}`), ISOLATED_ENV)).toBe(false);
    expect(isPreviewHostRequest(new URL(`${APP}${ROUTE}`), SHARED_ENV)).toBe(false);
  });
});

describe('the preview proxy', () => {
  test('refuses to serve a preview on the app origin', async () => {
    const env = { ...ISOLATED_ENV, Sandbox: sandboxNamespace(new Response('secret')) } as unknown as Env;
    const res = await proxyPreviewRequest(new Request(`${APP}${ROUTE}`), env);
    expect(res?.status).toBe(404);
    expect(await res!.json()).toMatchObject({ code: 'WRONG_PREVIEW_ORIGIN' });
  });

  test('serves the preview on the preview host, contained', async () => {
    const container = new Response('<h1>app</h1>', {
      headers: { 'content-type': 'text/html', 'set-cookie': 'a=b' },
    });
    const env = { ...ISOLATED_ENV, Sandbox: sandboxNamespace(container) } as unknown as Env;
    const res = await proxyPreviewRequest(new Request(`https://${PREVIEW}${ROUTE}`), env);
    expect(res?.status).toBe(200);
    expect(res!.headers.get('content-security-policy')).toBe(`sandbox ${PREVIEW_SANDBOX}`);
    expect(res!.headers.get('set-cookie')).toBeNull();
  });

  test('an invalid token is refused before the container is reached', async () => {
    const env = { ...ISOLATED_ENV, Sandbox: sandboxNamespace(new Response('secret'), false) } as unknown as Env;
    const res = await proxyPreviewRequest(new Request(`https://${PREVIEW}${ROUTE}`), env);
    expect(res?.status).toBe(404);
    expect(await res!.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  test('a sandbox id is charset-bound, so it cannot carry markup into the error pages', () => {
    expect(parsePreviewRoute(new URL(`${APP}/_preview/8080/ok-id_1/tok/`))?.sandboxId).toBe('ok-id_1');
    expect(parsePreviewRoute(new URL(`${APP}/_preview/8080/${encodeURIComponent('<script>x</script>')}/tok/`))).toBeNull();
  });

  test('preview error pages escape the sandbox id', () => {
    const proxy = source('src/preview-proxy.ts');
    expect(proxy).toContain('escapeHtml(opts.sandboxId)');
    expect(proxy).not.toContain('sandbox=${opts.sandboxId}');
  });
});

describe('what the app is willing to frame', () => {
  test('accepts a real preview route', () => {
    expect(isPreviewUrl(`https://${PREVIEW}${ROUTE}`)).toBe(true);
    expect(isPreviewUrl(`https://${PREVIEW}${ROUTE}index.html?x=1`)).toBe(true);
  });

  test('rejects anything that is not a preview route', () => {
    // `_preview` buried under some other path was the shape the old scan let
    // through, which put an arbitrary origin in the workspace iframe.
    expect(isPreviewUrl('https://evil.example/pretend/_preview/8080/x/tok/')).toBe(false);
    expect(isPreviewUrl('http://evil.example/_preview/8080/x/tok/')).toBe(false);
    expect(isPreviewUrl(`https://user:pw@${PREVIEW}${ROUTE}`)).toBe(false);
    expect(isPreviewUrl('https://evil.example/')).toBe(false);
    expect(isPreviewUrl('javascript:alert(1)')).toBe(false);
    expect(isPreviewUrl('not a url')).toBe(false);
  });

  test('tool output is scanned for preview routes only', () => {
    expect(extractPreviewUrl(`server up at https://${PREVIEW}${ROUTE} enjoy`)).toBe(`https://${PREVIEW}${ROUTE}`);
    expect(extractPreviewUrl({ url: `https://${PREVIEW}${ROUTE}` })).toBe(`https://${PREVIEW}${ROUTE}`);
    expect(extractPreviewUrl('see https://evil.example/x/_preview/8080/a/b/')).toBeNull();
    expect(extractPreviewUrl('nothing here')).toBeNull();
  });
});

describe('the app document policy', () => {
  test('authenticated app HTML carries a CSP', () => {
    const res = withAppSecurityHeaders(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      new URL(APP),
      `https://${PREVIEW}`,
    );
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('only the preview origin may be framed', () => {
    const csp = appDocumentCsp(new URL(APP), `https://${PREVIEW}`);
    expect(csp).toContain(`frame-src 'self' https://${PREVIEW}`);
    expect(appDocumentCsp(new URL(APP), null)).toContain("frame-src 'self'");
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

  test('a cross-origin write is rejected', () => {
    const res = crossSiteRejection(post({ ...cookie, origin: 'https://evil.example' }));
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
    // Ahead of every other route, so nothing on that host can mint a session.
    expect(server.indexOf('isPreviewHostRequest(url, env)'))
      .toBeLessThan(server.indexOf('handlePcRequest(request, env)'));
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

  test('Nimbus previews are contained too', () => {
    expect(server).toContain('containPreviewResponse(nimbusResp)');
  });

  test('production previews are configured on a separate origin', () => {
    // Comments are stripped: the note above the var shows the alternative
    // hostname, and it must not be mistaken for the configured one.
    const wrangler = source('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '');
    // Production is the first of each — the staging environment follows.
    const first = (key: string): string =>
      wrangler.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))![1];
    const vars = {
      PREVIEW_HOSTNAME: first('PREVIEW_HOSTNAME'),
      CLI_PUBLIC_ORIGIN: first('CLI_PUBLIC_ORIGIN'),
    };
    expect(isolatedPreviewHost(vars)).toBe(vars.PREVIEW_HOSTNAME);
  });
});
