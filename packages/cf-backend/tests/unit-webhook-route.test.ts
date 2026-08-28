/**
 * The public webhook delivery route, and the capability that gates it.
 *
 * The defect this pins: `/api/workspaces/<name>/webhook/<trigger>` used to
 * resolve the Orchestrator stub for whatever name the caller typed, before
 * anything knew the workspace or the trigger existed. Naming one was enough to
 * ACTIVATE a persistent Durable Object, unauthenticated. The edge knock budget
 * priced that; it did not close it. So most assertions here are about what does
 * NOT happen: no object addressed, no budget spent, no body read, unless the URL
 * carries a capability this deployment minted.
 *
 * `activations` records every `idFromName`/`get` — exactly what `getAgentByName`
 * does to reach an object, so an empty list is proof none was touched. `AUTH_KV`
 * is a real KV double for the same reason: a refusal that spends a KV write has
 * still spent something a caller chose to make us spend.
 */
import { describe, expect, test } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { makeKv, type FakeKv } from './helpers/kv';
import { jsrpcStub } from './helpers/jsrpc-stub';
import {
  matchWebhookDeliveryPath, verifyWebhookRoute, webhookRoutePath,
} from '../src/events/webhook-route';

// The route's module graph reaches `cloudflare:email` through `agents`, so the
// stub has to be installed before it loads.
mockAgentsSdk();
const { handleWebhookDeliveryRequest, handleHubRequest } = await import('../src/events/routes');
const { default: worker } = await import('../src/server');

const ROUTE_SECRET = 'test-webhook-route-secret-0123456789';
const OTHER_SECRET = 'another-deployments-route-secret-0001';
const WORKSPACE = 'kinu-main';
/** A real ULID, the shape `TriggerRegistry.register` mints. */
const TRIGGER = '01HZY6QK9N4T7M2P8V3XABCDEF';
const SIBLING_TRIGGER = '01HZY6QK9N4T7M2P8V3XABCDEG';
const ORIGIN = 'https://app.example';

interface DeliveryProbe {
  /** Names the route resolved an Orchestrator stub for. */
  readonly activations: string[];
  /** Trigger ids the ingress was asked to accept a delivery for. */
  readonly deliveries: string[];
  /** Body text the ingress was handed, if it got that far. */
  bodyText: string | undefined;
}

interface Harness {
  readonly env: Env;
  readonly probe: DeliveryProbe;
  /** The knock budget's store, so a refusal that SPENT budget is visible: an
   *  empty key set is proof the ingress budget was never consulted. */
  readonly kv: FakeKv;
}

function harness(options: { secret?: string | null; reject?: boolean } = {}): Harness {
  const probe: DeliveryProbe = { activations: [], deliveries: [], bodyText: undefined };
  const agent = jsrpcStub({
    acceptWebhookDelivery: async (opts: { trigger_id: string; body_text: string }) => {
      probe.deliveries.push(opts.trigger_id);
      probe.bodyText = opts.body_text;
      return options.reject === true
        ? { status: 'rejected' as const, http_status: 401, reason: 'signature mismatch' }
        : { status: 'accepted' as const, event_id: 'evt_1', admitted: true };
    },
  });
  const kv = makeKv();
  // The doubles are deliberately NOT typed as the bindings they stand in for: a
  // fake `idFromName` returning the name can never satisfy `DurableObjectId`,
  // and `jsrpcStub`'s prototype-bound methods can never satisfy
  // `DurableObjectStub`. `Object.assign` is what lets the members land without
  // the type system adjudicating the fakes.
  const view: Partial<Env> = {};
  Object.assign(view, {
    AUTH_KV: kv,
    OrchestratorAgent: {
      idFromName: (name: string) => {
        probe.activations.push(`idFromName:${name}`);
        return name;
      },
      get: (name: string) => {
        probe.activations.push(`get:${name}`);
        return agent;
      },
    },
    WEBHOOK_ROUTE_SECRET: options.secret === undefined ? ROUTE_SECRET : options.secret ?? undefined,
  });
  // SAFETY: the delivery route reads exactly the three members constructed by
  // the `Object.assign` above — the knock budget's KV, the Orchestrator
  // namespace and the route secret — verified against the bodies of
  // `handleWebhookDeliveryRequest` and `handleWebhookDelivery`. Nothing
  // unassigned is reachable through this cast.
  return { env: view as Env, probe, kv };
}

function delivery(path: string, init: { method?: string; body?: BodyInit } = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: init.body ?? '{"hello":"world"}',
  });
}

function mintedPath(
  secret = ROUTE_SECRET, workspaceName = WORKSPACE, triggerId = TRIGGER,
): Promise<string> {
  return webhookRoutePath(secret, { workspaceName, triggerId });
}

describe('a minted route reaches the workspace', () => {
  test('delivery is accepted, and carries the trigger and body the URL brought', async () => {
    const { env, probe, kv } = harness();
    const body = JSON.stringify({ note: 'a build finished' });
    const request = delivery(await mintedPath(), { body });
    const response = await handleWebhookDeliveryRequest(request, env);

    expect(response?.status).toBe(202);
    expect(probe.activations).toEqual([`idFromName:${WORKSPACE}`, `get:${WORKSPACE}`]);
    expect(probe.deliveries).toEqual([TRIGGER]);
    expect(probe.bodyText).toBe(body);
    // The two witnesses every refusal below asserts the ABSENCE of. Read here on
    // the accepted path so neither can be silently vacuous: a `bodyUsed` that
    // never flips, or a budget that never records, would make those refusals
    // measure nothing.
    expect(request.bodyUsed).toBe(true);
    expect(kv.keys()).toHaveLength(1);
  });

  test('the route capability is not payload auth: the per-trigger gate still refuses', async () => {
    const { env, probe } = harness({ reject: true });
    const response = await handleWebhookDeliveryRequest(delivery(await mintedPath()), env);

    expect(response?.status).toBe(401);
    expect(probe.deliveries).toEqual([TRIGGER]);
  });
});

describe('no unminted route reaches a Durable Object', () => {
  /** Every refusal below must be this answer, and must cost nothing. */
  async function expectRefused(request: Request, { env, probe, kv }: Harness): Promise<void> {
    const response = await handleWebhookDeliveryRequest(request, env);

    expect(response?.status).toBe(404);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.text()).toBe('Not found');
    expect(probe.activations).toEqual([]);
    expect(probe.deliveries).toEqual([]);
    expect(request.bodyUsed).toBe(false);
    // The knock budget is downstream of the capability, so a refused caller
    // costs not even a KV write.
    expect(kv.keys()).toEqual([]);
  }

  test('an arbitrary valid-looking name and token', async () => {
    await expectRefused(
      delivery(`/api/workspaces/victim/webhook/${TRIGGER}/v1-${'a1b2c3d4'.repeat(4)}`),
      harness(),
    );
  });

  test('a capability minted for another workspace', async () => {
    const foreign = await mintedPath(ROUTE_SECRET, 'someone-else');
    await expectRefused(
      delivery(foreign.replace('/someone-else/', `/${WORKSPACE}/`)),
      harness(),
    );
  });

  test('a capability minted for another trigger in the same workspace', async () => {
    const sibling = await mintedPath(ROUTE_SECRET, WORKSPACE, SIBLING_TRIGGER);
    await expectRefused(delivery(sibling.replace(SIBLING_TRIGGER, TRIGGER)), harness());
  });

  test("a capability minted under another deployment's secret", async () => {
    await expectRefused(delivery(await mintedPath(OTHER_SECRET)), harness());
  });

  test('the unsigned URL the old route served', async () => {
    await expectRefused(delivery(`/api/workspaces/${WORKSPACE}/webhook/${TRIGGER}`), harness());
  });

  test('a name or trigger id outside the grammar that mints them', async () => {
    const minted = await mintedPath();
    for (const path of [
      minted.replace(`/${WORKSPACE}/`, `/${'w'.repeat(65)}/`),
      minted.replace(TRIGGER, 'not-a-ulid'),
      // `I`, `L`, `O` and `U` are excluded from Crockford base32 on purpose.
      minted.replace(TRIGGER, `${TRIGGER.slice(0, -1)}I`),
    ]) {
      await expectRefused(delivery(path), harness());
    }
  });

  test('a re-spelled capability: case, encoding, prefix, shape', async () => {
    const minted = await mintedPath();
    const token = minted.slice(minted.lastIndexOf('/v1-') + 4);
    const rewrites = {
      'upper-case token': minted.replace(token, token.toUpperCase()),
      'percent-escaped trigger': minted.replace(`/${TRIGGER}/`, `/%30${TRIGGER.slice(1)}/`),
      'percent-escaped workspace': minted.replace(`/${WORKSPACE}/`, `/%6B${WORKSPACE.slice(1)}/`),
      'no version prefix': minted.replace('/v1-', '/'),
      'wrong version prefix': minted.replace('/v1-', '/v2-'),
      'truncated token': minted.slice(0, -1),
      'one more hex char': `${minted}0`,
      'trailing slash': `${minted}/`,
      'extra segment': `${minted}/extra`,
      'token moved to the query': `${minted.slice(0, minted.lastIndexOf('/v1-'))}?t=${token}`,
    };

    for (const [what, path] of Object.entries(rewrites)) {
      const { env, probe } = harness();
      const request = delivery(path);
      const response = await handleWebhookDeliveryRequest(request, env);
      expect(response?.status, what).toBe(404);
      expect(probe.activations, what).toEqual([]);
      expect(request.bodyUsed, what).toBe(false);
    }
  });

  test('a deployment with no route secret fails closed on a URL it once minted', async () => {
    await expectRefused(delivery(await mintedPath()), harness({ secret: null }));
  });

  test('a blank route secret is not a secret', async () => {
    await expectRefused(delivery(await mintedPath('   ')), harness({ secret: '   ' }));
  });
});

describe('the delivery route claims exactly its own paths', () => {
  test('a wrong method is refused without addressing the workspace', async () => {
    const { env, probe } = harness();
    const request = delivery(await mintedPath(), { method: 'PUT' });
    const response = await handleWebhookDeliveryRequest(request, env);

    expect(response?.status).toBe(405);
    expect(probe.activations).toEqual([]);
    expect(request.bodyUsed).toBe(false);
  });

  test('a non-delivery path is left to the rest of the route table', async () => {
    const { env } = harness();
    for (const path of [
      `/api/workspaces/${WORKSPACE}/triggers`,
      `/api/workspaces/${WORKSPACE}/events`,
      '/api/health',
      '/webhook/anything',
    ]) {
      expect(await handleWebhookDeliveryRequest(delivery(path), env)).toBeNull();
    }
  });

  test('the authenticated hub router no longer serves delivery at all', async () => {
    const { env, probe } = harness();

    expect(await handleHubRequest(delivery(await mintedPath()), env, WORKSPACE)).toBeNull();
    expect(await handleHubRequest(
      delivery(`/api/workspaces/${WORKSPACE}/webhook/${TRIGGER}`), env, WORKSPACE,
    )).toBeNull();
    expect(probe.activations).toEqual([]);
  });
});

describe('trigger management reports what delivery hides', () => {
  function createRequest(): Request {
    return new Request(`${ORIGIN}/api/workspaces/${WORKSPACE}/triggers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kinu-auth-time': String(Date.now()) },
      body: JSON.stringify({ label: 'github', auth_mode: 'hmac' }),
    });
  }

  test('no route secret: creation reports the deployment, and registers nothing', async () => {
    const { env, probe } = harness({ secret: null });
    const response = await handleHubRequest(createRequest(), env, WORKSPACE);

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      error: expect.stringContaining('WEBHOOK_ROUTE_SECRET'),
    });
    expect(probe.deliveries).toEqual([]);
  });

  test('with a route secret the same request is not refused as unconfigured', async () => {
    const { env } = harness();
    const response = await handleHubRequest(createRequest(), env, WORKSPACE);

    expect(response?.status).not.toBe(503);
  });
});

describe('the builder and the matcher are one contract', () => {
  test('a minted path parses, verifies, and names the identity it was minted for', async () => {
    const match = matchWebhookDeliveryPath(await mintedPath());

    if (match?.kind !== 'signed') throw new Error('a minted path must parse as signed');
    expect(match.workspaceName).toBe(WORKSPACE);
    expect(match.triggerId).toBe(TRIGGER);
    expect(await verifyWebhookRoute(ROUTE_SECRET, match)).toBe(true);
    expect(await verifyWebhookRoute(OTHER_SECRET, match)).toBe(false);
  });

  test('minting is deterministic, so a listing and a creation hand out one URL', async () => {
    expect(await mintedPath()).toBe(await mintedPath());
  });

  test('the capability is a whole 128-bit lower-case hex token', async () => {
    expect(await mintedPath()).toMatch(
      new RegExp(`^/api/workspaces/${WORKSPACE}/webhook/${TRIGGER}/v1-[0-9a-f]{32}$`),
    );
  });

  test('one identity difference changes the token', async () => {
    const tokens = new Set([
      await mintedPath(ROUTE_SECRET, WORKSPACE, TRIGGER),
      await mintedPath(ROUTE_SECRET, WORKSPACE, SIBLING_TRIGGER),
      await mintedPath(ROUTE_SECRET, `${WORKSPACE}1`, TRIGGER),
      await mintedPath(OTHER_SECRET, WORKSPACE, TRIGGER),
    ]);
    expect(tokens.size).toBe(4);
  });

  /** The property that makes the identity grammar check sufficient rather than
   *  merely tidy: two identities whose concatenation collides must not share a
   *  capability. Held by the NUL delimiter, which no path segment can carry. */
  test('a colliding concatenation does not collide as a capability', async () => {
    const [left, right] = await Promise.all([
      webhookRoutePath(ROUTE_SECRET, { workspaceName: 'ab', triggerId: TRIGGER }),
      webhookRoutePath(ROUTE_SECRET, { workspaceName: 'a', triggerId: TRIGGER }),
    ]);
    expect(left.slice(left.lastIndexOf('/v1-'))).not.toBe(right.slice(right.lastIndexOf('/v1-')));
  });

  test('minting refuses an identity the product could not have issued', async () => {
    for (const identity of [
      { workspaceName: 'has/slash', triggerId: TRIGGER },
      { workspaceName: 'w'.repeat(65), triggerId: TRIGGER },
      { workspaceName: '', triggerId: TRIGGER },
      { workspaceName: WORKSPACE, triggerId: 'not-a-ulid' },
      { workspaceName: WORKSPACE, triggerId: '' },
    ]) {
      await expect(webhookRoutePath(ROUTE_SECRET, identity))
        .rejects.toThrow(/Cannot mint a webhook URL/);
    }
  });

  test('the token never carries the secret', async () => {
    expect(await mintedPath()).not.toContain(ROUTE_SECRET);
  });
});

/**
 * The wiring, through the real `server.ts` entry rather than the route module.
 * The ordering IS the property: delivery is served at step 7b, before the auth
 * gate, so the capability has to be what admits it — and an unsigned URL must
 * not fall through to the gate, the SPA fallback, or anything else that would
 * tell a caller more than 404 does.
 */
describe('the Worker entry serves delivery before the auth gate', () => {
  function entryHarness() {
    const { env, probe } = harness();
    const partialEnv: Partial<Env> = {};
    Object.assign(partialEnv, env, {
      CLI_PUBLIC_ORIGIN: ORIGIN,
      ASSETS: {
        fetch: async () => new Response('<!doctype html>', {
          headers: { 'content-type': 'text/html' },
        }),
      },
    });
    const partialCtx: Partial<ExecutionContext> = {};
    Object.assign(partialCtx, { waitUntil() {}, passThroughOnException() {} });
    // SAFETY: both members are constructed by the `Object.assign` above, and the
    // entry's own contract declares them — verified against `server.ts`'s route
    // table, which returns at step 7b for every request in this block.
    return { env: partialEnv as Env, ctx: partialCtx as ExecutionContext, probe };
  }

  test('a signed delivery is accepted with no session at all', async () => {
    const { env, ctx, probe } = entryHarness();
    const response = await worker.fetch(delivery(await mintedPath()), env, ctx);

    expect(response.status).toBe(202);
    expect(probe.deliveries).toEqual([TRIGGER]);
  });

  test('an unsigned delivery is 404 and never reaches the gate or the SPA', async () => {
    const { env, ctx, probe } = entryHarness();
    const response = await worker.fetch(
      delivery(`/api/workspaces/${WORKSPACE}/webhook/${TRIGGER}`), env, ctx,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('Not found');
    expect(probe.activations).toEqual([]);
  });
});
