/** Unminted preview hostnames must be refused before a native Durable Object lookup. */
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test';
import { makeKv, type FakeKv } from './helpers/kv';
import { workerContext } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { sandboxPreviewExposures, PREVIEW_ENTRY_PATH, VIEWER_EXCHANGE_PATH } from '@kinu.run/core';
import { mintViewerTicket, previewViewerKey, computerPreviewHandle, selfPreviewPass } from '../src/viewer-pass';

// Dynamic: the entry's graph reaches `cloudflare:email` and `cloudflare:workers` through `agents`,
// and bun's preload shims must be in place first.
const { default: worker } = await import('../src/server');

const APP = 'https://app.example';

const SUFFIX = 'previews.example';

const WORKSPACE = 'hello';

const SANDBOX_ID = `kinu-${WORKSPACE}`;

const PORT = 8080;

const OWNER = '0123456789abcdef0123456789abcdef';

/** The shape `exposePort` mints: `p<port>_<random>`. */
const MINTED_TOKEN = 'p8080_ab12cd34';

const FORGED_TOKEN = 'p8080_deadbeef';

// Two cases pin the clock; the rest of the run must not inherit it.
afterAll(() => { setSystemTime(); });

interface SandboxProbe {
  readonly resolved: string[];
  readonly forwarded: Request[];
  readonly kv: FakeKv;
  readonly env: Env;
  readonly ctx: ExecutionContext;
}

function probe(): SandboxProbe {
  const resolved: string[] = [];
  const forwarded: Request[] = [];
  const kv = makeKv();
  const view: Partial<Env> = {};
  Object.assign(view, {
    AUTH_KV: kv,
    CLI_PUBLIC_ORIGIN: APP,
    PREVIEW_HOST_SUFFIX: SUFFIX,
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    KinuDevbox: {
      getByName(name: string) {
        resolved.push(name);

        return {
          async fetch(request: Request) {
            forwarded.push(request);

            return new Response('<h1>container</h1>', {
              headers: { 'content-type': 'text/html' },
            });
          },
        };
      },
    },
    ASSETS: {
      fetch: async () => new Response('<!doctype html>', {
        headers: { 'content-type': 'text/html' },
      }),
    },
  });

  return {
    resolved,
    forwarded,
    kv,
    // SAFETY: every member the preview rail reads is constructed above; the rail is step 1 of the
    // route table, so nothing unassigned is reachable.
    env: view as Env,
    ctx: workerContext(),
  };
}

function previewUrl(label: string): string {
  return `https://${label}.${SUFFIX}/`;
}

const MINTED_URL = previewUrl(`${String(PORT)}-${SANDBOX_ID}-${MINTED_TOKEN}`);

/** Driven through the real exposure writer, so a change to either half is a red test. */
async function publishExposure(p: SandboxProbe): Promise<void> {
  await sandboxPreviewExposures(p.kv, SANDBOX_ID).publish(PORT, MINTED_TOKEN);
}

/** The workspace's own fetch of its computer's preview, carrying the pass it mints for itself. */
async function asTheWorkspace(p: SandboxProbe, url = MINTED_URL): Promise<Request> {
  const pass = await selfPreviewPass(p.env, WORKSPACE, new URL(url));

  if (pass === null) throw new Error('the workspace minted no pass for its own computer preview');

  // An accept header as every fetch sends one: bun, unlike workerd, keeps a request's headers when given an empty set.
  return new Request(url, { headers: { cookie: `${pass.name}=${pass.value}`, accept: '*/*' } });
}

describe('a preview hostname nobody minted', () => {
  test('resolves no Sandbox object and answers a definitive refusal', async () => {
    const p = probe();
    const before = p.kv.keys();

    const res = await worker.fetch(
      new Request(previewUrl(`${String(PORT)}-${SANDBOX_ID}-${FORGED_TOKEN}`)),
      p.env,
      p.ctx,
    );

    expect(p.resolved).toEqual([]);
    expect(p.forwarded).toEqual([]);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_NOT_EXPOSED' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    // A guess leaves no state behind to grow.
    expect(p.kv.keys()).toEqual(before);
  });

  test('a guessed token against a workspace that DOES have one is the same refusal', async () => {
    const p = probe();
    await publishExposure(p);

    const res = await worker.fetch(
      new Request(previewUrl(`${String(PORT)}-${SANDBOX_ID}-${FORGED_TOKEN}`)),
      p.env,
      p.ctx,
    );

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_NOT_EXPOSED' });
  });

  test('a published port does not admit a DIFFERENT port on the same box', async () => {
    const p = probe();
    await publishExposure(p);

    const res = await worker.fetch(
      new Request(previewUrl(`9090-${SANDBOX_ID}-${MINTED_TOKEN}`)),
      p.env,
      p.ctx,
    );

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
  });

  test('a sandbox id outside the shape this deployment mints is refused on sight', async () => {
    const p = probe();

    // A legal SDK label that is not a Kinu container: refused before any lookup.
    const res = await worker.fetch(
      new Request(previewUrl(`${String(PORT)}-someoneelses-box-${MINTED_TOKEN}`)),
      p.env,
      p.ctx,
    );

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_A_PREVIEW' });
  });

  test('with no store to prove a label against, the rail fails closed', async () => {
    const p = probe();
    const view: Partial<Env> = { ...p.env };
    delete view.AUTH_KV;
    // SAFETY: copied from the env `probe` constructs, minus the one binding under test.
    const res = await worker.fetch(new Request(MINTED_URL), view as Env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_UNAVAILABLE' });
  });
});

describe('a preview this deployment published', () => {
  test('is no bearer link: a page load with no pass is sent to the app to sign in, a script\'s request refused, the container untouched', async () => {
    const p = probe();
    await publishExposure(p);

    const page = await worker.fetch(new Request(MINTED_URL, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } }), p.env, p.ctx);
    const script = await worker.fetch(new Request(MINTED_URL, { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' } }), p.env, p.ctx);

    expect(page.status).toBe(303);
    const entry = new URL(page.headers.get('location') ?? '');
    expect([entry.origin, entry.pathname, entry.searchParams.get('to')]).toEqual([APP, PREVIEW_ENTRY_PATH, MINTED_URL]);
    expect(script.status).toBe(403);
    expect(p.resolved).toEqual([]);
  });

  test('reaches the container it names for the workspace\'s own fetch', async () => {
    const p = probe();
    await publishExposure(p);

    const res = await worker.fetch(await asTheWorkspace(p), p.env, p.ctx);

    expect(p.resolved).toEqual([SANDBOX_ID]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('container');
    // The pass is Kinu's: the app in the container never sees it.
    expect(p.forwarded[0]?.headers.get('cookie')).toBeNull();
  });

  test("the owner's ticket from the app becomes this host's cookie, which then opens the page; another host's ticket does not", async () => {
    const p = probe();
    await publishExposure(p);
    const key = previewViewerKey(PORT, await computerPreviewHandle(MINTED_TOKEN));
    const ticket = await mintViewerTicket(p.env, WORKSPACE, key, OWNER);
    const elsewhere = await mintViewerTicket(p.env, WORKSPACE, previewViewerKey(PORT, await computerPreviewHandle('p8080_other')), OWNER);

    const exchange = new URL(VIEWER_EXCHANGE_PATH, MINTED_URL);
    exchange.searchParams.set('next', '/dashboard');
    exchange.searchParams.set('ticket', elsewhere ?? '');
    expect((await worker.fetch(new Request(exchange), p.env, p.ctx)).status).toBe(404);

    exchange.searchParams.set('ticket', ticket ?? '');
    const exchanged = await worker.fetch(new Request(exchange), p.env, p.ctx);
    expect([exchanged.status, exchanged.headers.get('location')]).toEqual([303, new URL('/dashboard', MINTED_URL).href]);
    const cookie = (exchanged.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const page = await worker.fetch(new Request(new URL('/dashboard', MINTED_URL), { headers: { cookie, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' } }), p.env, p.ctx);
    expect(page.status).toBe(200);
    expect(p.resolved).toEqual([SANDBOX_ID]);
  });

  test('made a public link by its owner, it opens with no pass; exposed again, it is the owner\'s alone again', async () => {
    const p = probe();
    await publishExposure(p);
    const writer = sandboxPreviewExposures(p.kv, SANDBOX_ID);

    expect(await writer.setPublic(PORT, true)).toBe(true);
    expect((await worker.fetch(new Request(MINTED_URL), p.env, p.ctx)).status).toBe(200);
    expect(await writer.isPublic(PORT)).toBe(true);

    await writer.publish(PORT, MINTED_TOKEN);
    expect(await writer.isPublic(PORT)).toBe(false);
    expect((await worker.fetch(new Request(MINTED_URL), p.env, p.ctx)).status).toBe(403);

    await writer.withdraw(PORT);
    expect(await writer.setPublic(PORT, true)).toBe(false);
  });

  test('withdrawing the exposure stops the same URL at the edge', async () => {
    const p = probe();
    await publishExposure(p);
    await sandboxPreviewExposures(p.kv, SANDBOX_ID).withdraw(PORT);

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
  });

  test('destroying the workspace stops every URL it published', async () => {
    const p = probe();
    await publishExposure(p);
    await sandboxPreviewExposures(p.kv, SANDBOX_ID).revokeAll();

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_NOT_EXPOSED' });
  });

  test('a workspace re-exposing a port after a destroy resolves again', async () => {
    const p = probe();
    // The watermark boundary is inclusive: a record stamped in the destroy's millisecond reads as
    // revoked (fail-closed).
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    await sandboxPreviewExposures(p.kv, SANDBOX_ID).revokeAll();
    setSystemTime(new Date('2026-03-01T12:00:01.000Z'));
    await publishExposure(p);

    const res = await worker.fetch(await asTheWorkspace(p), p.env, p.ctx);

    expect(p.resolved).toEqual([SANDBOX_ID]);
    expect(res.status).toBe(200);
  });

  test('an exposure published as the workspace was destroyed does not survive it', async () => {
    const p = probe();
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    await publishExposure(p);
    await sandboxPreviewExposures(p.kv, SANDBOX_ID).revokeAll();

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
  });
});

describe('a preview host failure', () => {
  test('answers the route table\'s JSON failure, never an unhandled throw', async () => {
    const p = probe();
    Object.assign(p.kv, { get: async () => { throw new Error('KV read failed: storage node sk-live-SECRET unreachable'); } });

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(JSON.stringify(await res.json())).not.toContain('sk-live-SECRET');
    expect(p.resolved).toEqual([]);
  });
});
