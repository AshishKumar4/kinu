/**
 * The real Sandbox SDK resolves the Durable Object before checking the port token, and the preview
 * host precedes auth, CSRF and budgets: a guessed hostname must be refused before `proxyToSandbox`.
 * The oracle is the namespace's `idFromName`: a refusal that resolved no id created nothing.
 */
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeKv, type FakeKv } from './helpers/kv';
import { workerContext } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { sandboxPreviewExposures } from '@kinu.run/core';

// Dynamic: the entry's graph reaches `cloudflare:email` and `cloudflare:workers` through `agents`,
// and bun's preload shims must be in place first.
const { default: worker } = await import('../src/server');

const APP = 'https://app.example';

const SUFFIX = 'previews.example';

const WORKSPACE = 'hello';

const SANDBOX_ID = `kinu-${WORKSPACE}`;

const PORT = 8080;

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
  test('reaches the container it names, with no credentials of any kind', async () => {
    const p = probe();
    await publishExposure(p);

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

    expect(p.resolved).toEqual([SANDBOX_ID]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('container');
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

    const res = await worker.fetch(new Request(MINTED_URL), p.env, p.ctx);

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
    // The token is set as a header for the object to validate, so the object must already exist.
    expect(sdk).toContain('headers.set(PREVIEW_PROXY_TOKEN_HEADER, token)');
  });
});
