/**
 * Preview-origin containment.
 *
 * A previewed app is HTML the agent wrote from sources it does not control. The
 * invariant under test is that it never runs as the Kinu app: not on the
 * app's origin and not with the app's session cookie. Cross-preview cookie-site
 * isolation remains an explicit deployment prerequisite below.
 *
 * Sandbox containers and Nimbus sessions both get a capability hostname per
 * exposed port, so each preview is its own origin and may keep it.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PREVIEW_SANDBOX,
  containPreviewResponse,
  extractPreviewUrl,
  isPreviewUrl,
  isPreviewHostRequest,
  previewHostSuffix,
} from '../src/lib/preview-origin';
import { appDocumentCsp, publicHtmlHeaders, withAppSecurityHeaders } from '../src/lib/security-headers';
import {
  CLI_APPROVAL_CSRF_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME, crossSiteRejection,
} from '../src/auth/session';
import {
  handleNimbusPreviewHostRequest,
  nimbusPreviewConfigured,
  nimbusPreviewUrl,
  WORKSPACE_PREVIEW_PATH,
} from '../src/nimbus-route';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { makeKv } from './helpers/kv';
import { sandboxPreviewExposures } from '../src/lib/preview-exposures';
import type { KvStore } from '../src/lib/kv';

// The SDK's entry point pulls in `cloudflare:workers`, which only exists inside
// workerd. proxyToSandbox is the seam the Worker delegates preview routing to,
// so standing in for it here leaves everything Kinu owns under test.
let sdkResponse: Response | null = null;
let sdkRequest: Request | null = null;
// Successive answers, for the one test shape a repair needs: a BEFORE and an
// AFTER. Empty means every forward gets `sdkResponse`.
let sdkQueue: Response[] = [];
let sdkForwards = 0;
// What the repair path did. `getSandbox` used to throw here because nothing in
// this suite reached it; the stale-preview repair does, and WHICH object it
// reaches is the property that matters most.
/** The options every Kinu callsite passes for one sandbox id; the repair must
 *  pass the same ones or the SDK drops in-flight requests for that id. */
interface SandboxLookupOptions {
  normalizeId: boolean;
  transport: string;
}
let repairs: Array<{ id: string; options: SandboxLookupOptions }> = [];
let repairFailure: Error | null = null;
// The recorder outlives this file (`mock.module` is process-wide), and a
// LATER file's forward must not read this suite's leftovers: a scripted null
// means "no exposed port" only while this suite is the caller.
let suiteDone = false;
afterAll(() => { suiteDone = true; });
// `mock.module` replaces the whole module for the rest of the run, so the stub
// keeps the REAL module for every export it does not fake — a hand-maintained
// export list here is drift: it omitted `streamFile` and turned every later
// file that binds it into a load-time SyntaxError.
import * as actualSandboxSdk from '@cloudflare/sandbox';
await mock.module('@cloudflare/sandbox', () => ({
  ...actualSandboxSdk,
  proxyToSandbox: async (request: Request) => {
    sdkRequest = request;
    sdkForwards += 1;
    // After this suite, a forward answers a neutral 204: the caller is another
    // file that never scripted anything here. Within the suite, a Response is
    // one-shot and the real SDK mints a new one per forward, so the recorder
    // hands out a CLONE and keeps the scripted original pristine — returning
    // the same instance twice arrives disturbed, which is what
    // unit-transport-security inherited under full-suite order. A scripted
    // null stays null: that is the SDK's own "no exposed port" answer.
    if (suiteDone) return new Response(null, { status: 204 });
    const scripted = sdkQueue.shift() ?? sdkResponse;
    return scripted === null ? null : scripted.clone();
  },
  Sandbox: class {},
  getSandbox: (_namespace: NonNullable<Env['Sandbox']>, id: string, options: SandboxLookupOptions) => ({
    ensureReady: async () => {
      repairs.push({ id, options });
      if (repairFailure) throw repairFailure;
    },
  }),
}));
const { SDK_FORWARD_FAILURE, SDK_STALE_PREVIEW, servePreviewRequest } =
  await import('../src/preview-proxy');

const root = join(import.meta.dir, '..');
const source = (path: string): string => readFileSync(join(root, path), 'utf8');

const APP = 'https://kinu.example.com';
const SUFFIX = 'previews.example';
/** The three parts of one exposed port, named because both the hostname under
 *  test and the published record are built from them. */
const PREVIEW_SANDBOX_ID = 'kinu-hello';
const PREVIEW_PORT = 8080;
const PREVIEW_TOKEN = 'p8080_ab12cd34';
const PREVIEW_HOST = `${String(PREVIEW_PORT)}-${PREVIEW_SANDBOX_ID}-${PREVIEW_TOKEN}.${SUFFIX}`;
const PREVIEW_URL = `https://${PREVIEW_HOST}/`;
const OWNER = '0123456789abcdef0123456789abcdef';

/**
 * The exposures this deployment has published.
 *
 * The rail proves every preview hostname against this record before the SDK may
 * resolve a container object, so a suite that forwards has to publish the port
 * it forwards for — through the real writer, exactly as the workspace's own
 * executor lane does when it exposes one. The refusal directions (a label
 * nobody minted, a guessed token, a withdrawn or revoked exposure) are proven
 * end to end against the real SDK in `unit-preview-forgery.test.ts`.
 */
const PREVIEW_STORE = makeKv();
await sandboxPreviewExposures(PREVIEW_STORE, PREVIEW_SANDBOX_ID).publish(PREVIEW_PORT, PREVIEW_TOKEN);

const ENV = {
  AUTH_KV: PREVIEW_STORE,
  CLI_PUBLIC_ORIGIN: APP,
  PREVIEW_HOST_SUFFIX: SUFFIX,
  CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
};

interface PreviewNimbusStub {
  fetch?(request: Request): Promise<Response>;
  routeWorkspacePreview?(
    port: number,
    handle: string,
    request: Request,
    pathname: string,
  ): Promise<Response>;
}

interface PreviewTestBindings {
  /** Where the published exposures live. Absent in the one case that proves the
   *  rail fails closed without it. */
  AUTH_KV?: KvStore;
  CLI_PUBLIC_ORIGIN?: string;
  PREVIEW_HOST_SUFFIX?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  /** Present only where a repair is expected to be possible: without the
   *  binding there is no container to re-drive, and the stale answer stands. */
  Sandbox?: object;
  OrchestratorAgent?: {
    idFromName(name: string): string;
    get(id: string): PreviewNimbusStub;
  };
}

function testEnv(bindings: PreviewTestBindings): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: Preview tests construct every preview binding their selected route
  // reads; the Sandbox SDK is mocked above and no other Env member is reached.
  return env as Env;
}

const NIMBUS_CAPABILITY = '0123456789abcdef01234567';
const configuredNimbusUrl = nimbusPreviewUrl(testEnv(ENV), 'hello', 4321, NIMBUS_CAPABILITY);
if (!configuredNimbusUrl) throw new Error('Nimbus preview test URL is not configured');
const NIMBUS_URL = configuredNimbusUrl;

async function serve(url: string, response: Response | null): Promise<Response> {
  sdkResponse = response;
  sdkRequest = null;
  sdkQueue = [];
  sdkForwards = 0;
  repairs = [];
  repairFailure = null;
  return servePreviewRequest(new Request(url), testEnv(ENV));
}

/** One request against a deployment that HAS a container, with successive SDK
 *  answers: the before and the after of a repair. */
async function serveWithRepair(
  request: Request,
  answers: Response[],
  failure: Error | null = null,
): Promise<Response> {
  sdkResponse = null;
  sdkRequest = null;
  sdkQueue = [...answers];
  sdkForwards = 0;
  repairs = [];
  repairFailure = failure;
  return servePreviewRequest(request, testEnv({ ...ENV, Sandbox: {} }));
}

function stalePreview(): Response {
  return new Response(SDK_STALE_PREVIEW.body, {
    status: SDK_STALE_PREVIEW.status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('preview sandbox policy', () => {
  test('every preview keeps its isolated origin', () => {
    expect(PREVIEW_SANDBOX).toContain('allow-same-origin');
    expect(PREVIEW_SANDBOX).toContain('allow-scripts');
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
    }));
    expect(contained.headers.get('content-security-policy')).toBe(`sandbox ${PREVIEW_SANDBOX}`);
  });

  test('a container cannot relax the sandbox through the proxy', () => {
    const contained = containPreviewResponse(new Response('body', {
      headers: { 'content-security-policy': 'sandbox allow-scripts allow-same-origin allow-top-navigation' },
    }));
    const csp = contained.headers.get('content-security-policy');
    expect(csp).toContain('allow-same-origin');
    expect(csp).not.toContain('allow-top-navigation');
  });

  test('a report-only CSP cannot survive alongside the sandbox directive', () => {
    const contained = containPreviewResponse(new Response('body', {
      headers: { 'content-security-policy-report-only': "default-src 'none'" },
    }));
    expect(contained.headers.get('content-security-policy-report-only')).toBeNull();
  });

  test('the proxy keeps host-only cookies and drops server-supplied Domain cookies', () => {
    const response = new Response('body');
    response.headers.append('set-cookie', 'sid=mine; Path=/; Secure; HttpOnly');
    response.headers.append('set-cookie', `shared=everywhere; Domain=.${SUFFIX}; Path=/`);
    const kept = containPreviewResponse(response).headers.getSetCookie();
    expect(kept).toEqual(['sid=mine; Path=/; Secure; HttpOnly']);
  });

  test('the port token lives in the hostname, so Referer is muzzled', () => {
    // The browser's default policy sends the origin cross-origin — and under
    // this scheme the origin is the credential.
    expect(containPreviewResponse(new Response('x')).headers.get('referrer-policy'))
      .toBe('no-referrer');
  });

  test('a WebSocket handshake passes through untouched', () => {
    const upgrade = new Response(null, { status: 101 });
    expect(containPreviewResponse(upgrade)).toBe(upgrade);
  });
});

describe('preview host resolution', () => {
  test('Nimbus advertises inbound networking only with a usable preview origin and signing secret', () => {
    expect(nimbusPreviewConfigured(testEnv(ENV))).toBe(true);
    expect(nimbusPreviewConfigured(testEnv({
      ...ENV,
      PREVIEW_HOST_SUFFIX: '',
    }))).toBe(false);
    expect(nimbusPreviewConfigured(testEnv({
      ...ENV,
      CREDENTIAL_ENCRYPTION_KEY: '',
    }))).toBe(false);
  });

  test('the configured zone is the suffix', () => {
    expect(previewHostSuffix(ENV)).toBe(SUFFIX);
    expect(previewHostSuffix({ ...ENV, PREVIEW_HOST_SUFFIX: `.${SUFFIX.toUpperCase()}.` })).toBe(SUFFIX);
  });

  test('production records that its current suffix is not a per-preview cookie-site boundary', () => {
    const wrangler = source('wrangler.jsonc');
    const configured = /"PREVIEW_HOST_SUFFIX":\s*"([^"]+)"/.exec(wrangler)?.[1];
    expect(configured).toBe('kinu.run');
    // Comment line wrapping is not the contract; the recorded prerequisite is.
    const prose = wrangler.replace(/^\s*\/\/ ?/gmu, '').replace(/\s+/gu, ' ');
    expect(prose).toContain('A PSL-backed suffix is required before this can be claimed');
  });

  test('unconfigured or unusable means no preview host at all', () => {
    expect(previewHostSuffix({ CLI_PUBLIC_ORIGIN: APP })).toBeNull();
    expect(previewHostSuffix({ ...ENV, PREVIEW_HOST_SUFFIX: '  ' })).toBeNull();
    // A single label would claim a whole TLD, the app's host included.
    expect(previewHostSuffix({ ...ENV, PREVIEW_HOST_SUFFIX: 'example' })).toBeNull();
    expect(previewHostSuffix({ ...ENV, PREVIEW_HOST_SUFFIX: 'bad host.example' })).toBeNull();
  });

  test('the app host can be the preview suffix without making the app a preview', () => {
    const env = testEnv({
      CLI_PUBLIC_ORIGIN: 'https://kinu.example.com',
      PREVIEW_HOST_SUFFIX: 'kinu.example.com',
    });
    expect(previewHostSuffix(env)).toBe('kinu.example.com');
    expect(isPreviewHostRequest(new URL('https://kinu.example.com/'), env)).toBe(false);
    expect(isPreviewHostRequest(
      new URL('https://8080-kinu-app-p8080_ab12cd34.kinu.example.com/'),
      env,
    )).toBe(true);
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
    const env = { CLI_PUBLIC_ORIGIN: 'https://kinu.example.com', PREVIEW_HOST_SUFFIX: 'example.com' };
    expect(isPreviewHostRequest(new URL('https://kinu.example.com/'), env)).toBe(false);
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

  test('strips Kinu credentials before the Sandbox SDK reaches guest code', async () => {
    sdkResponse = new Response(null, { status: 204 });
    sdkRequest = null;
    const res = await servePreviewRequest(new Request(PREVIEW_URL, {
      headers: {
        cookie: [
          `${SESSION_COOKIE_NAME}=owner`,
          'guest_session=guest',
          `${CLI_APPROVAL_CSRF_COOKIE_NAME}=csrf`,
          `${OAUTH_STATE_COOKIE_NAME}=handoff`,
        ].join('; '),
        authorization: `Bearer ptc_${OWNER}_${'a'.repeat(44)}`,
        'proxy-authorization': 'Basic c2VjcmV0',
        'x-kinu-user-id': OWNER,
        'x-kinu-auth-scope': 'owner',
        'x-kinu-internal-ticket': 'secret',
        'x-guest-header': 'kept',
      },
    }), testEnv(ENV));

    if (!sdkRequest) throw new Error('Sandbox preview request was not forwarded');
    expect(res.status).toBe(204);
    const forwarded: Request = sdkRequest;
    expect(forwarded.headers.get('cookie')).toBe('guest_session=guest');
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(forwarded.headers.get('proxy-authorization')).toBeNull();
    expect(forwarded.headers.get('x-kinu-user-id')).toBeNull();
    expect(forwarded.headers.get('x-kinu-auth-scope')).toBeNull();
    expect(forwarded.headers.get('x-kinu-internal-ticket')).toBeNull();
    expect(forwarded.headers.get('x-guest-header')).toBe('kept');
  });

  test('preserves guest-owned bearer auth for Sandbox apps', async () => {
    sdkResponse = new Response(null, { status: 204 });
    sdkRequest = null;
    await servePreviewRequest(new Request(PREVIEW_URL, {
      headers: { authorization: 'Bearer guest-token' },
    }), testEnv(ENV));
    if (!sdkRequest) throw new Error('Sandbox preview request was not forwarded');
    const forwarded: Request = sdkRequest;
    expect(forwarded.headers.get('authorization')).toBe('Bearer guest-token');
  });

  test('a host that resolves to no exposed port gets a 404, never the app', async () => {
    const res = await serve(`https://not-a-preview.${SUFFIX}/login`, null);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_A_PREVIEW' });
  });

  test('an unpublished label never reaches the SDK at all', async () => {
    // The label is well-formed and names a real container; what it does not
    // name is an exposure this deployment published. `sdkForwards` is the whole
    // assertion: `proxyToSandbox` is where a Durable Object gets resolved, so
    // not calling it is what makes a guess cost nothing.
    const res = await serve(`https://8080-${PREVIEW_SANDBOX_ID}-p8080_forged1.${SUFFIX}/`, null);
    expect(sdkForwards).toBe(0);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_NOT_EXPOSED' });
  });

  test('a published label still gets the object\'s own verdict, unchanged', async () => {
    // The two gates are independent, and this is the case where they disagree:
    // the exposure is published, and the container object nevertheless refuses
    // the token (its own store is the authority — a port unexposed inside the
    // object, or a record this deployment has not caught up with). The object's
    // answer is passed through rather than reinterpreted.
    const res = await serve(PREVIEW_URL, new Response(
      JSON.stringify({ error: 'Access denied', code: 'INVALID_TOKEN' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
    expect(sdkForwards).toBe(1);
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
    expect(proxy).toContain('proxyToSandbox(new Request(request');
    expect(proxy).toContain('sanitizePreviewRequestHeaders(request.headers)');
    expect(proxy).not.toContain('validatePortToken');
    expect(proxy).not.toContain('containerFetch');
  });
});

// KINU-035. A container recycle replaces the runtime that owned each port's
// activation, and the durable token survives it, so a preview URL that is still
// perfectly valid answers 410 until something re-exposes the port. Nothing did.
describe('repairing a stale preview', () => {
  test('a stale GET is repaired once and re-issued, and the visitor sees the app', async () => {
    const res = await serveWithRepair(new Request(PREVIEW_URL), [
      stalePreview(),
      new Response('<h1>hello</h1>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hello');
    expect(sdkForwards).toBe(2);
    // The object that ANSWERED the request, addressed the way every other Kinu
    // call site addresses it.
    expect(repairs).toEqual([
      { id: 'kinu-hello', options: { normalizeId: true, transport: 'rpc' } },
    ]);
  });

  test('the repaired answer still carries the preview containment headers', async () => {
    const res = await serveWithRepair(new Request(PREVIEW_URL), [
      stalePreview(),
      new Response('<h1>hello</h1>', { status: 200 }),
    ]);

    expect(res.headers.get('content-security-policy')).toBe(`sandbox ${PREVIEW_SANDBOX}`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('a second stale answer is returned as itself — one transition, not a budget', async () => {
    const res = await serveWithRepair(new Request(PREVIEW_URL), [stalePreview(), stalePreview()]);

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'STALE_PREVIEW_URL' });
    expect(sdkForwards).toBe(2);
    expect(repairs).toHaveLength(1);
  });

  test('a repair that cannot run leaves the stale answer exactly as it was', async () => {
    const res = await serveWithRepair(
      new Request(PREVIEW_URL),
      [stalePreview(), stalePreview()],
      new Error('this devbox has no attached work directory'),
    );

    expect(res.status).toBe(410);
    expect(repairs).toHaveLength(1);
  });

  test('a non-GET is never repaired: its body cannot be replayed', async () => {
    const res = await serveWithRepair(
      new Request(PREVIEW_URL, { method: 'POST', body: 'x' }),
      [stalePreview()],
    );

    expect(res.status).toBe(410);
    expect(sdkForwards).toBe(1);
    expect(repairs).toEqual([]);
  });

  test('an invalid token is never repaired — the 404 arm is unauthenticated', async () => {
    const res = await serveWithRepair(new Request(PREVIEW_URL), [
      new Response(JSON.stringify({ error: 'Access denied', code: 'INVALID_TOKEN' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      }),
    ]);

    expect(res.status).toBe(404);
    expect(repairs).toEqual([]);
  });

  test("an app's own 410 is not a stale preview", async () => {
    const res = await serveWithRepair(new Request(PREVIEW_URL), [
      new Response('this resource is gone', { status: 410 }),
    ]);

    expect(res.status).toBe(410);
    expect(await res.text()).toBe('this resource is gone');
    expect(repairs).toEqual([]);
  });

  test('a deployment with no container binding cannot repair, and says nothing else', async () => {
    const res = await serve(PREVIEW_URL, stalePreview());

    expect(res.status).toBe(410);
    expect(repairs).toEqual([]);
  });

  test("the SDK's stale-preview response is still the shape we match", () => {
    // The whole classification rests on this body. An upgrade that rewords it
    // must fail here rather than silently retiring the repair.
    const sdk = readFileSync(
      join(root, '../../node_modules/@cloudflare/sandbox/dist/sandbox-CPj2jsbz.js'),
      'utf8',
    );
    expect(sdk).toContain('Preview URL is stale because the sandbox runtime is not active');
    expect(sdk).toContain('STALE_PREVIEW_URL');
    expect(sdk).toContain('status: 410');
  });
});

describe('serving a Nimbus preview host', () => {
  test('routes all HTTP methods at the origin root without forwarding Kinu credentials', async () => {
    let forwarded: Request | null = null;
    let durableObjectName = '';
    let routedPort = 0;
    let routedCapability = '';
    let routedPath = '';
    const env = testEnv({
      ...ENV,
      OrchestratorAgent: {
        idFromName(name: string) { durableObjectName = name; return name; },
        get() {
          return {
            async routeWorkspacePreview(port: number, handle: string, request: Request, pathname: string) {
              routedPort = port;
              routedCapability = handle;
              routedPath = pathname;
              forwarded = request;
              return new Response(JSON.stringify({ ok: true }), {
                headers: { 'content-type': 'application/json' },
              });
            },
          };
        },
      },
    });
    const response = await handleNimbusPreviewHostRequest(new Request(`${NIMBUS_URL}api/items?x=1`, {
      method: 'POST',
      headers: {
        cookie: [
          `${SESSION_COOKIE_NAME}=owner`,
          'guest_session=guest',
          `${CLI_APPROVAL_CSRF_COOKIE_NAME}=csrf`,
          `${OAUTH_STATE_COOKIE_NAME}=handoff`,
        ].join('; '),
        authorization: `Bearer pta_${OWNER}_${'b'.repeat(44)}`,
        'proxy-authorization': 'Basic c2VjcmV0',
        'x-kinu-user-id': OWNER,
        'x-guest-header': 'kept',
      },
      body: 'payload',
    }), env);

    if (!response || !forwarded) throw new Error('Nimbus preview request was not forwarded');
    expect(response.status).toBe(200);
    // The workspace's OWN name: the Durable Object that holds the filesystem is
    // the OrchestratorAgent addressed by name, which is why the hostname carries
    // the name rather than a one-way digest a router could not invert.
    expect(durableObjectName).toBe('hello');
    expect(routedPort).toBe(4321);
    expect(routedCapability).toBe(NIMBUS_CAPABILITY.slice(0, 10));
    expect(routedPath).toBe('/api/items');
    const routed: Request = forwarded;
    expect(new URL(routed.url).pathname + new URL(routed.url).search).toBe('/api/items?x=1');
    expect(routed.method).toBe('POST');
    expect(await routed.text()).toBe('payload');
    expect(routed.headers.get('cookie')).toBe('guest_session=guest');
    expect(routed.headers.get('authorization')).toBeNull();
    expect(routed.headers.get('proxy-authorization')).toBeNull();
    expect(routed.headers.get('x-kinu-user-id')).toBeNull();
    expect(routed.headers.get('x-guest-header')).toBe('kept');
    expect(routed.headers.get('x-nimbus-base')).toBeNull();
  });

  test('passes guest-owned bearer auth into the capability-authenticated Nimbus RPC', async () => {
    let forwarded: Request | null = null;
    const env = testEnv({
      ...ENV,
      OrchestratorAgent: {
        idFromName(name: string) { return name; },
        get() {
          return {
            async routeWorkspacePreview(_port: number, _handle: string, request: Request) {
              forwarded = request;
              return new Response(null, { status: 204 });
            },
          };
        },
      },
    });
    const response = await handleNimbusPreviewHostRequest(new Request(`${NIMBUS_URL}private`, {
      headers: { authorization: 'Bearer guest-token' },
    }), env);
    if (!response || !forwarded) throw new Error('Nimbus request was not forwarded');
    expect(response.status).toBe(204);
    const routed: Request = forwarded;
    expect(routed.headers.get('authorization')).toBe('Bearer guest-token');
  });

  test('strips a CLI session bearer before forwarding to a guest app', async () => {
    let forwarded: Request | null = null;
    const env = testEnv({
      ...ENV,
      OrchestratorAgent: {
        idFromName(name: string) { return name; },
        get() {
          return {
            async routeWorkspacePreview(_port: number, _handle: string, request: Request) {
              forwarded = request;
              return new Response(null, { status: 204 });
            },
          };
        },
      },
    });
    // The other token kind the CLI authenticator routes; the POST case above
    // carries the scoped `pta_` kind. A device token is not a bearer format
    // and has no case here: the daemon presents it in a request body.
    const response = await handleNimbusPreviewHostRequest(new Request(`${NIMBUS_URL}private`, {
      headers: { authorization: `Bearer ptc_${OWNER}_${'c'.repeat(44)}` },
    }), env);
    if (!response || !forwarded) throw new Error('Nimbus request was not forwarded');
    expect(response.status).toBe(204);
    const routed: Request = forwarded;
    expect(routed.headers.get('authorization')).toBeNull();
  });

  test('routes a guest WebSocket through the capability-authenticated fetch boundary', async () => {
    let forwarded: Request | null = null;
    let rpcCalled = false;
    const env = testEnv({
      ...ENV,
      OrchestratorAgent: {
        idFromName(name: string) { return name; },
        get() {
          return {
            async fetch(request: Request) {
              forwarded = request;
              return new Response(null, { status: 204 });
            },
            async routeWorkspacePreview() {
              rpcCalled = true;
              return new Response(null, { status: 500 });
            },
          };
        },
      },
    });
    const response = await handleNimbusPreviewHostRequest(new Request(`${NIMBUS_URL}socket?channel=hmr`, {
      headers: {
        upgrade: 'websocket',
        authorization: 'Bearer guest-token',
        cookie: '__Host-kinu_session=owner; guest_session=guest',
        'x-nimbus-preview-capability': 'client-forgery',
      },
    }), env);

    if (!response || !forwarded) throw new Error('Nimbus WebSocket was not forwarded');
    expect(response.status).toBe(204);
    expect(rpcCalled).toBe(false);
    const routed: Request = forwarded;
    const routedUrl = new URL(routed.url);
    expect(routedUrl.pathname + routedUrl.search)
      .toBe(`${WORKSPACE_PREVIEW_PATH}/4321/${NIMBUS_CAPABILITY.slice(0, 10)}/socket?channel=hmr`);
    expect(routed.headers.get('authorization')).toBe('Bearer guest-token');
    expect(routed.headers.get('cookie')).toBe('guest_session=guest');
  });

  test('rejects a forged capability without touching Nimbus', async () => {
    let touched = false;
    const env = testEnv({
      ...ENV,
      OrchestratorAgent: {
        idFromName(name: string) { touched = true; return name; },
        get() { touched = true; return {}; },
      },
    });
    const labelEnd = NIMBUS_URL.indexOf(`.${SUFFIX}`);
    const forged = `${NIMBUS_URL.slice(0, labelEnd - 1)}a${NIMBUS_URL.slice(labelEnd)}`;
    const response = await handleNimbusPreviewHostRequest(new Request(forged), env);
    expect(response?.status).toBe(404);
    expect(touched).toBe(false);
  });
});

describe('what the app is willing to frame', () => {
  test('accepts a preview hostname', () => {
    expect(isPreviewUrl(PREVIEW_URL, SUFFIX)).toBe(true);
    expect(isPreviewUrl(`${PREVIEW_URL}index.html?x=1`, SUFFIX)).toBe(true);
    expect(isPreviewUrl(`https://80-kinu-hello-p80_ab12cd34.${SUFFIX}/`, SUFFIX)).toBe(true);
    expect(isPreviewUrl(PREVIEW_URL, null)).toBe(false);
  });

  test('rejects anything that is not one', () => {
    expect(isPreviewUrl(`http://${PREVIEW_HOST}/`, SUFFIX)).toBe(false);
    expect(isPreviewUrl(`https://user:pw@${PREVIEW_HOST}/`, SUFFIX)).toBe(false);
    // The label has to be the whole first label, not buried in a longer one.
    expect(isPreviewUrl(`https://evil.example/${PREVIEW_HOST}/`, SUFFIX)).toBe(false);
    expect(isPreviewUrl(`https://x8080-kinu-hello-tok.${SUFFIX}/`, SUFFIX)).toBe(false);
    expect(isPreviewUrl(`https://8080-kinu.${SUFFIX}/`, SUFFIX)).toBe(false);
    expect(isPreviewUrl('https://evil.example/', SUFFIX)).toBe(false);
    expect(isPreviewUrl('javascript:alert(1)', SUFFIX)).toBe(false);
    expect(isPreviewUrl('not a url', SUFFIX)).toBe(false);
    expect(isPreviewUrl(`https://0-kinu-hello-p0_ab12cd34.${SUFFIX}/`, SUFFIX)).toBe(false);
    expect(isPreviewUrl(`https://65536-kinu-hello-p65536_ab12cd34.${SUFFIX}/`, SUFFIX)).toBe(false);
    expect(isPreviewUrl('https://8080-kinu-phish-p8080_ab12cd34.evil.example/', SUFFIX)).toBe(false);
    expect(isPreviewUrl(`https://8080-kinu-phish-p8080_ab12cd34.nested.${SUFFIX}/`, SUFFIX)).toBe(false);
  });

  test('accepts isolated Nimbus capability hosts and rejects the removed app-host path', () => {
    expect(isPreviewUrl(NIMBUS_URL, SUFFIX)).toBe(true);
    expect(new URL(NIMBUS_URL).hostname.split('.')[0].length).toBeLessThanOrEqual(63);
    expect(isPreviewUrl(`${NIMBUS_URL}assets/app.js`, SUFFIX)).toBe(true);
    expect(isPreviewUrl(`${APP}/_nimbus/user_1/workspace/session-1/port/4321/`, SUFFIX)).toBe(false);
    const invalidPort = new URL(NIMBUS_URL);
    invalidPort.hostname = `0-${invalidPort.hostname.split('.')[0].split('-').slice(1).join('-')}.${SUFFIX}`;
    expect(isPreviewUrl(invalidPort.toString(), SUFFIX)).toBe(false);
    const tooLargePort = new URL(NIMBUS_URL);
    tooLargePort.hostname = `${(65_536).toString(36)}-${tooLargePort.hostname.split('.')[0].split('-').slice(1).join('-')}.${SUFFIX}`;
    expect(isPreviewUrl(tooLargePort.toString(), SUFFIX)).toBe(false);
  });

  test('tool output is scanned for preview URLs only', () => {
    expect(extractPreviewUrl(`server up at ${PREVIEW_URL} enjoy`, SUFFIX)).toBe(PREVIEW_URL);
    expect(extractPreviewUrl({ url: PREVIEW_URL }, SUFFIX)).toBe(PREVIEW_URL);
    expect(extractPreviewUrl('see https://evil.example/8080-a-b/', SUFFIX)).toBeNull();
    expect(extractPreviewUrl('nothing here', SUFFIX)).toBeNull();
    expect(extractPreviewUrl({ url: NIMBUS_URL }, SUFFIX)).toBe(NIMBUS_URL);
    expect(extractPreviewUrl('https://8080-kinu-phish-p8080_ab12cd34.evil.example/', SUFFIX)).toBeNull();
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
    expect(appDocumentCsp(new URL(APP), null)).toContain("connect-src 'self' wss://kinu.example.com");
  });

  // KaTeX_Size3-Regular.woff2 is under Vite's inline threshold, so the bundle
  // carries it as `data:font/woff2;base64,…`. Unset, `font-src` falls back to
  // `default-src 'self'` and the browser refuses it.
  test('the inlined maths font survives the font-src rule', () => {
    expect(appDocumentCsp(new URL(APP), null)).toContain("font-src 'self' data:");
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
  const cookie = { cookie: '__Host-kinu_session=abc' };
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
    expect(server).toContain('previewSuffixMetaName()');
    expect(server).toContain('new HTMLRewriter()');
  });

  test('the CSRF gate runs before any authenticated route', () => {
    expect(server).toContain('crossSiteRejection(request)');
    expect(server.indexOf('crossSiteRejection(request)'))
      .toBeLessThan(server.indexOf('handleUserRequest(authenticatedRequest'));
  });

  test('Nimbus previews route on the isolated host before app authentication', () => {
    expect(server).toContain('handleNimbusPreviewHostRequest(request, env)');
    expect(server.indexOf('handleNimbusPreviewHostRequest(request, env)'))
      .toBeLessThan(server.indexOf('authenticateRequest(request, env)'));
    expect(server).not.toContain('handleNimbusPreviewRequest');
  });

  test('production enables preview subdomains below the app host', () => {
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
    const appHost = new URL(vars.CLI_PUBLIC_ORIGIN).hostname;
    expect(suffix).toBe(appHost);
    expect(isPreviewHostRequest(new URL(vars.CLI_PUBLIC_ORIGIN), vars)).toBe(false);
    expect(isPreviewHostRequest(new URL(`https://probe.${suffix}`), vars)).toBe(true);
  });

  test('asset routing cannot bypass the host-aware preview gate', () => {
    const wrangler = source('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '');
    expect(wrangler).toMatch(/"run_worker_first"\s*:\s*true/);
    expect(wrangler).not.toContain('!/assets/*');
  });

  test('the live Outputs poll includes the canonical workspace and sandbox', () => {
    const hook = source('src/hooks/use-kinu.ts');
    expect(hook).toContain('["workspace", "sandbox"].map');
    expect(hook).toContain('reconcilePreviewPorts(previous, results)');
    expect(hook).toContain('setPreviewError(next.error)');
    expect(hook).toContain('generation !== exposedPortsRefreshGeneration.current');
    expect(hook).not.toContain('ignore transient');
    expect(source('src/orchestrator.ts')).toContain("provider.kind !== 'workspace'");
    expect(source('src/orchestrator.ts')).toContain('provider.listExposedPorts');
    expect(source('src/components/surfaces/OutputSurface.tsx')).toContain('<LoadFailure what="live previews"');
    expect(source('src/components/surfaces/OutputSurface.tsx')).toContain('<LoadFailure what="the latest change-set"');
  });
});
