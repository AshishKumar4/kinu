/**
 * Forged sandbox previews, driven through the Worker entry against the REAL
 * Sandbox SDK.
 *
 * WHY THIS FILE EXISTS BESIDE `unit-preview-origin.test.ts`. That suite
 * replaces `proxyToSandbox` with a recorder, so everything it proves is about
 * the bytes Kinu adds around the SDK — containment, header stripping, the
 * stale-preview repair. What it cannot see is the act the SDK performs on
 * entry: `extractSandboxRoute` splits the hostname, and `getSandbox` resolves
 * the Durable Object (`getContainer` = `idFromName` then `get`) BEFORE the
 * port's token is looked at. The token travels onward as a header for the
 * object to check, so the object exists — and has run its constructor and its
 * init gate — by the time anyone knows the request was forged.
 *
 * The preview host is step 1 of the route table, ahead of authentication,
 * ahead of the CSRF gate and ahead of every ingress budget, and production
 * routes `*.kinu.run/*` here. So the ONLY place a guessed hostname can be
 * stopped is before `proxyToSandbox` is called, and the oracle for that is the
 * `Sandbox` namespace itself: a refusal that resolved no id created nothing.
 *
 * The namespace double records `idFromName`, which is the creation act — a
 * Durable Object comes into existence when a stub is used, and `KinuSandbox`
 * writes storage from its constructor (`packages/devbox/src/devbox.ts`
 * `blockConcurrencyWhile(#sweepUnknownSchedules)`) plus the SDK's own
 * constructor-time gate. Nothing here fakes the SDK: if a later change made
 * the real `proxyToSandbox` unreachable from this file, the positive control
 * ('a published preview still proxies') fails loudly rather than passing over
 * a stub that touches no namespace.
 */
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeKv, type FakeKv } from './helpers/kv';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { sandboxPreviewExposures } from '../src/lib/preview-exposures';

// Dynamic for the reason every cf-backend route suite loads the entry this way:
// the entry's module graph reaches `cloudflare:email` and `cloudflare:workers`
// through `agents`, and bun's preload shims have to be in place first.
const { default: worker } = await import('../src/server');

const APP = 'https://app.example';
const SUFFIX = 'previews.example';
/** The workspace whose container the forged labels aim at. */
const WORKSPACE = 'hello';
const SANDBOX_ID = `kinu-${WORKSPACE}`;
const PORT = 8080;
/** The shape `exposePort` mints: `p<port>_<random>`. */
const MINTED_TOKEN = 'p8080_ab12cd34';
const FORGED_TOKEN = 'p8080_deadbeef';

// Two cases pin the clock; the rest of the run must not inherit it.
afterAll(() => { setSystemTime(); });

interface SandboxProbe {
  /** Sandbox ids a request resolved a stub for. Empty is the contract for a
   *  refusal that created nothing. */
  readonly resolved: string[];
  /** Requests that reached the container object. */
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
    Sandbox: {
      idFromName(name: string) {
        resolved.push(name);
        return { name };
      },
      get(_id: { name: string }) {
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
  const partialCtx: Partial<ExecutionContext> = {};
  Object.assign(partialCtx, { waitUntil() {}, passThroughOnException() {} });
  return {
    resolved,
    forwarded,
    kv,
    // SAFETY: every member the preview rail reads is constructed above — the
    // two host vars, the preview secret, the published-exposure store, the
    // Sandbox namespace and the SPA fallback the rail never reaches. The rail
    // is step 1 of the route table, so nothing unassigned is reachable.
    env: view as Env,
    // SAFETY: both members of the entry's ExecutionContext contract.
    ctx: partialCtx as ExecutionContext,
  };
}

function previewUrl(label: string): string {
  return `https://${label}.${SUFFIX}/`;
}

/** The hostname a published exposure is reachable at. */
const MINTED_URL = previewUrl(`${String(PORT)}-${SANDBOX_ID}-${MINTED_TOKEN}`);

/** What the workspace's own executor lane does when it exposes a port: publish
 *  the exposure into the Worker's store, which is what the edge proves against.
 *  Driven through the real writer, so a change to either half is a red test. */
async function publishExposure(p: SandboxProbe): Promise<void> {
  await sandboxPreviewExposures(p.kv, SANDBOX_ID).publish(PORT, MINTED_TOKEN);
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
    // Nothing persisted, in the Worker's own store either: a guess costs one
    // read of a projection and leaves no state behind to grow.
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
    // The SDK admits any id up to 63 characters. This one is a legal SDK label
    // and not a Kinu container, so it is refused before any lookup.
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
    // SAFETY: copied from the env constructed by `probe`, minus the one binding
    // under test, so every member the rail reads is still present.
    const res = await worker.fetch(new Request(MINTED_URL), view as Env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_UNAVAILABLE' });
  });
});

describe('a preview this deployment published', () => {
  test('reaches the container it names, with no credentials of any kind', async () => {
    const p = probe();
    await publishExposure(p);

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(p.resolved).toEqual([SANDBOX_ID]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('container');
    // The real SDK ran: these are its own preview-proxy headers, carrying the
    // token onward for the object to validate.
    const forwarded = p.forwarded[0];
    if (!forwarded) throw new Error('expected the container to receive the request');
    expect(forwarded.headers.get('x-sandbox-preview-token')).toBe(MINTED_TOKEN);
    expect(forwarded.headers.get('x-sandbox-preview-port')).toBe(String(PORT));
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
    // What `destroyAgent` does before the container object's own token store is
    // deleted with it: one watermark, no enumeration.
    await sandboxPreviewExposures(p.kv, SANDBOX_ID).revokeAll();

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_NOT_EXPOSED' });
  });

  test('a workspace re-exposing a port after a destroy resolves again', async () => {
    const p = probe();
    // The clock is pinned across the two acts because the watermark's boundary
    // is INCLUSIVE: a record stamped in the same millisecond as a destroy reads
    // as revoked, which is the fail-closed side of that tie. Here the exposure
    // genuinely comes after, so it resolves.
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    await sandboxPreviewExposures(p.kv, SANDBOX_ID).revokeAll();
    setSystemTime(new Date('2026-03-01T12:00:01.000Z'));
    await publishExposure(p);

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(p.resolved).toEqual([SANDBOX_ID]);
    expect(res.status).toBe(200);
  });

  test('an exposure published as the workspace was destroyed does not survive it', async () => {
    const p = probe();
    // The other side of the same tie, and the reason it is inclusive.
    setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    await publishExposure(p);
    await sandboxPreviewExposures(p.kv, SANDBOX_ID).revokeAll();

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
  });
});

describe('the premise this gate rests on', () => {
  test('the SDK resolves the object before the token is judged', () => {
    const sdk = readFileSync(
      join(import.meta.dir, '../../../node_modules/@cloudflare/sandbox/dist/index.js'),
      'utf8',
    );
    const resolve = sdk.indexOf('getSandbox(env.Sandbox, sandboxId');
    const forward = sdk.indexOf('await sandbox.fetch(previewRequest)');
    expect(resolve).toBeGreaterThan(-1);
    expect(forward).toBeGreaterThan(resolve);
    // The token is not checked here at all: it is SET as a header for the
    // object to validate, which is why the object must already exist.
    expect(sdk).toContain('headers.set(PREVIEW_PROXY_TOKEN_HEADER, token)');
  });
});
