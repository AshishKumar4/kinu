/**
 * Forged slate-share hostnames through the Worker entry. The rail precedes authentication, so the oracle is the
 * `OrchestratorAgent` namespace: a refusal resolved no id and created no object. The signer is real, not faked.
 */
import { describe, expect, test } from 'bun:test';
import { labelSigner } from '@kinu.run/core';
import { makeKv } from './helpers/kv';
import { workerContext } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import type { ShareViewerClaim } from '@kinu.run/core';

// Dynamic: the entry's graph reaches `cloudflare:email` and `cloudflare:workers` through `agents`, so bun's preload shims must load first.
const { default: worker } = await import('../src/server');

const APP = 'https://app.example';

const SUFFIX = 'previews.example';

const WORKSPACE = 'hello';

const HANDLE = '0123456789';

/** The same HKDF `slateShareUrl` uses, so the test mints a real token. */
const shareSigner = labelSigner('kinu.slate-share.salt', 'kinu.slate-share.v1');

async function mintedLabel(handle = HANDLE, workspace = WORKSPACE): Promise<string> {
  const token = await shareSigner.token(TEST_CREDENTIAL_ENCRYPTION_KEY, `kinu:slate-share:v1:${workspace}:${handle}`);

  return `${handle}-${token}-${workspace}`;
}

function shareUrl(label: string): string {
  return `https://${label}.${SUFFIX}/`;
}

interface ShareProbe {
  readonly resolved: string[];
  /** `(handle, claim, pathname)` triples the rail handed the object, with the reoriginated headers. */
  readonly routed: { handle: string; claim: ShareViewerClaim; pathname: string; headers: Headers }[];
  readonly forwarded: Request[];
  readonly env: Env;
  readonly ctx: ExecutionContext;
}

function probe(): ShareProbe {
  const resolved: string[] = [];
  const routed: ShareProbe['routed'] = [];
  const forwarded: Request[] = [];
  const kv = makeKv();
  const view: Partial<Env> = {};
  Object.assign(view, {
    AUTH_KV: kv,
    CLI_PUBLIC_ORIGIN: APP,
    PREVIEW_HOST_SUFFIX: SUFFIX,
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    OrchestratorAgent: {
      idFromName(name: string) {
        resolved.push(name);

        return { name };
      },
      get(_id: { name: string }) {
        return {
          async routeSlateShare(handle: string, claim: ShareViewerClaim, request: Request, pathname: string) {
            routed.push({ handle, claim, pathname, headers: request.headers });

            return new Response('share', { status: 200 });
          },
          async fetch(request: Request) {
            forwarded.push(request);

            return new Response('socket', { status: 101 });
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

  // SAFETY: every member the share rail reads is constructed above — the host
  // suffix, the signing secret and the OrchestratorAgent namespace. The rail is
  // step 1 of the route table, so nothing unassigned is reachable.
  return { resolved, routed, forwarded, env: view as Env, ctx: workerContext() };
}

describe('a share hostname nobody minted', () => {
  test('a handle outside the share shape resolves no object', async () => {
    const p = probe();
    const res = await worker.fetch(new Request(shareUrl('not-a-share-label')), p.env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a signed token for another share is the same refusal as a guessed one', async () => {
    const p = probe();
    const other = await mintedLabel('abcdef0123');
    const label = `${HANDLE}-${other.split('-')[1]}-${WORKSPACE}`;
    const res = await worker.fetch(new Request(shareUrl(label)), p.env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(p.routed).toEqual([]);
    expect(res.status).toBe(404);
  });

  test('a wrong token against a real handle never reaches the object', async () => {
    const p = probe();
    const res = await worker.fetch(new Request(shareUrl(`${HANDLE}-aaaaaaaaaaaaaaa-${WORKSPACE}`)), p.env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(404);
  });

  test('with no signing secret the rail answers 503, not a guess', async () => {
    const p = probe();
    const view: Partial<Env> = { ...p.env };
    delete view.CREDENTIAL_ENCRYPTION_KEY;

    // SAFETY: probe() constructed this Env wholesale - removing
    // CREDENTIAL_ENCRYPTION_KEY leaves every binding the rail reads present.
    const res = await worker.fetch(new Request(shareUrl(await mintedLabel())), view as Env, p.ctx);

    expect(p.resolved).toEqual([]);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('a share this deployment minted', () => {
  test('reaches the workspace object once, with the claim built at the edge', async () => {
    const p = probe();
    const res = await worker.fetch(new Request(shareUrl(await mintedLabel())), p.env, p.ctx);

    expect(res.status).toBe(200);
    expect(p.resolved).toEqual([WORKSPACE]);
    expect(p.routed).toHaveLength(1);
    expect(p.routed[0]?.handle).toBe(HANDLE);
    expect(p.routed[0]?.pathname).toBe('/');
    expect(p.routed[0]?.claim.userId).toBeNull();
    expect(p.routed[0]?.claim.source).toMatch(/^[a-z2-7]{15}$/);
  });

  test('a viewer cookie minted for ANOTHER share names nobody on this one', async () => {
    const p = probe();
    const viewerSigner = labelSigner('kinu.slate-viewer.salt', 'kinu.slate-viewer.v1');
    const userId = 'a'.repeat(32);
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    const sig = await viewerSigner.token(TEST_CREDENTIAL_ENCRYPTION_KEY, `kinu:viewer-cookie:v1:${WORKSPACE}:abcdef0123:${userId}:${expiresAt}`);

    const res = await worker.fetch(new Request(shareUrl(await mintedLabel()), {
      headers: { cookie: `__Host-kinu_viewer=${userId}.${expiresAt}.${sig}` },
    }), p.env, p.ctx);

    expect(res.status).toBe(200);
    expect(p.routed[0]?.claim.userId).toBeNull();
  });

  test('the forwarded request carries no cookie, x-kinu-* or x-nimbus-base', async () => {
    const p = probe();

    const res = await worker.fetch(new Request(shareUrl(await mintedLabel()), {
      headers: {
        cookie: '__Host-kinu_viewer=forged',
        'x-kinu-anything': 'forged',
        'x-nimbus-base': 'forged',
        'x-forwarded-for': '1.2.3.4',
      },
    }), p.env, p.ctx);

    expect(res.status).toBe(200);
    const seen = p.routed[0];

    expect(seen).toBeDefined();
    expect(seen?.headers.get('cookie')).toBeNull();
    expect(seen?.headers.get('x-kinu-anything')).toBeNull();
    expect(seen?.headers.get('x-nimbus-base')).toBeNull();
    expect(p.forwarded).toEqual([]);
  });
});
