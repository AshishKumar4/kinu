// Mail on a subdomain of its zone (docs/MAIL.md §5): each address routes by a literal rule of its own, made as the
// address is and deleted as its root is retired; and nothing ever disables a zone's Email Routing.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { bearerTransport, mailRoutesOf, type CloudflareCall, type CloudflareHttpResponse, type MailRoutes, type MailRoutingEnv } from '../src/deploy/index';
import { settle } from '../src/obs/index';
import { parseJsonObject, type JsonValue } from '../src/utils/json';

const DOMAIN = 'mail.northwind.dev';

const WORKER = 'kinu-raman';

/** What a deployment on a subdomain holds, as the deploy run left it: its zone, its domain, its record, its token. */
const ROUTED: MailRoutingEnv = {
  KINU_MAIL_ZONE: 'zone-raman',
  EMAIL_DOMAIN: DOMAIN,
  KINU_MAIL_ROUTING_TOKEN: 'rules-token',
  KINU_DEPLOYMENT_RECORD: JSON.stringify({
    inputs: { accountId: '0'.repeat(32), instanceName: WORKER, address: { kind: 'workers-dev', hostname: '', zoneId: '' }, ownerEmail: 'priya@raman.dev', providerKeyNames: [], sandbox: false },
    address: `${WORKER}.raman.workers.dev`, version: '0.4.0', channelOrigin: 'https://kinu.run', clientId: 'client', deployedAt: '2026-10-21T00:00:00Z',
  }),
};

/** A rule as a POST or PUT asks for it: one literal address, one Worker. */
const AskedRule = v.object({
  matchers: v.tuple([v.object({ type: v.literal('literal'), field: v.literal('to'), value: v.string() })]),
  actions: v.tuple([v.object({ type: v.literal('worker'), value: v.tuple([v.string()]) })]),
});

interface HeldRule {
  readonly id: string;
  readonly to: string;
  readonly worker: string;
  enabled: boolean;
}

function literal(to: string, worker = WORKER) {
  return { matchers: [{ type: 'literal', field: 'to', value: to }], actions: [{ type: 'worker', value: [worker] }] };
}

/**
 * A zone's routing rules as the API lists, makes, turns on and deletes them, behind the deployment's own transport;
 * `cap` is the platform's 200 a domain.
 */
function rulesZone(cap = 200) {
  const calls: CloudflareCall[] = [];
  const rules = new Map<string, HeldRule>();
  let refuse: CloudflareHttpResponse | null = null;
  const ok = (result: JsonValue): CloudflareHttpResponse => ({ status: 200, body: { success: true, errors: [], result } });

  const answer = (call: CloudflareCall): CloudflareHttpResponse => {
    calls.push(call);

    if (refuse !== null) return refuse;
    const page = Number(/[?&]page=(\d+)/u.exec(call.path)?.[1] ?? '1');

    if (call.method === 'GET') return ok([...rules.values()].slice((page - 1) * 50, page * 50).map((rule) => ({ id: rule.id, enabled: rule.enabled, ...literal(rule.to, rule.worker) })));

    if (call.method === 'POST' && rules.size >= cap) return { status: 400, body: { success: false, errors: [{ code: 2020, message: 'Rule limit reached' }], result: null } };
    const held = rules.get(call.path.split('/').at(-1) ?? '');

    if (call.method === 'POST' || call.method === 'PUT') {
      const asked = v.parse(AskedRule, call.body);
      const id = held?.id ?? `rule-${String(rules.size + 1)}`;

      rules.set(id, { id, to: asked.matchers[0].value, worker: asked.actions[0].value[0], enabled: true });

      return ok({ id });
    }

    rules.delete(held?.id ?? '');

    return ok({});
  };

  // The deployment's own transport, as `mailRoutesOf` builds it, its fetch answered here.
  const fetched = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input).url);
    const path = `${url.pathname.replace(/^\/client\/v4/u, '')}${url.search}`;
    const method = v.parse(v.picklist(['GET', 'POST', 'PUT', 'DELETE']), init?.method ?? 'GET');
    const answered = answer(typeof init?.body === 'string' ? { method, path, body: parseJsonObject(init.body) } : { method, path });

    return Response.json(answered.body, { status: answered.status });
  }, { preconnect: fetch.preconnect });

  const routesFor = (env: MailRoutingEnv): MailRoutes | null => mailRoutesOf(env, fetched);

  return {
    calls, rules, routesFor,
    routes: () => present(routesFor(ROUTED)),
    refuseAll: (status: number) => { refuse = { status, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null } }; },
    addresses: () => [...rules.values()].map((rule) => rule.to),
  };
}

/** Routes a grant for this domain gives. */
function present(routes: MailRoutes | null): MailRoutes {
  if (routes === null) throw new Error('a grant for this domain gives routes');

  return routes;
}

describe('the rules a subdomain routes its addresses by', () => {
  test('an address is routed by a rule of its own, made once', async () => {
    const zone = rulesZone();

    await settle(zone.routes().routed(['Dana@mail.northwind.dev']));
    await settle(zone.routes().routed(['dana@mail.northwind.dev']));

    expect(zone.addresses()).toEqual(['dana@mail.northwind.dev']);
    expect(zone.calls.find((call) => call.method === 'POST')).toEqual({
      method: 'POST', path: '/zones/zone-raman/email/routing/rules',
      body: { name: 'Kinu dana@mail.northwind.dev', enabled: true, ...literal('dana@mail.northwind.dev') },
    });
  });

  test('the 201st address is refused in the platform\'s own words, and no cap of ours comes before it', async () => {
    const zone = rulesZone(200);
    const routes = zone.routes();

    for (let n = 1; n <= 200; n += 1) await settle(routes.routed([`agent${String(n)}.priya@mail.northwind.dev`]));

    await expect(settle(routes.routed(['dana@mail.northwind.dev']))).rejects.toMatchObject({
      code: 'denied', message: 'routing dana@mail.northwind.dev: Cloudflare answered: Rule limit reached',
    });
    expect(zone.rules.size).toBe(200);
  });

  test('a rule of its own that is off is turned on, not made twice', async () => {
    const zone = rulesZone();

    zone.rules.set('rule-off', { id: 'rule-off', to: 'dana@mail.northwind.dev', worker: WORKER, enabled: false });
    await settle(zone.routes().routed(['dana@mail.northwind.dev']));

    expect([...zone.rules.values()]).toEqual([{ id: 'rule-off', to: 'dana@mail.northwind.dev', worker: WORKER, enabled: true }]);
    expect(zone.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`)).toEqual(['PUT /zones/zone-raman/email/routing/rules/rule-off']);
  });

  test('an address another Worker routes is not taken from it', async () => {
    const zone = rulesZone();

    zone.rules.set('rule-staging', { id: 'rule-staging', to: 'eval@mail.northwind.dev', worker: 'kinu-staging', enabled: true });

    await expect(settle(zone.routes().routed(['eval@mail.northwind.dev']))).rejects.toMatchObject({
      code: 'denied', message: 'eval@mail.northwind.dev already routes to kinu-staging.',
    });
    expect(zone.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a retired root unroutes its own address and every box under it, and nothing of anyone else', async () => {
    const zone = rulesZone();
    const routes = zone.routes();

    await settle(routes.routed(['priya@mail.northwind.dev', 'ops.priya@mail.northwind.dev', 'triage.ops.priya@mail.northwind.dev', 'dana@mail.northwind.dev', 'xpriya@mail.northwind.dev'])
     );
    zone.rules.set('rule-other', { id: 'rule-other', to: 'priya@mail.northwind.dev', worker: 'kinu-staging', enabled: true });
    await settle(routes.unrouted('priya', DOMAIN));

    expect(zone.addresses()).toEqual(['dana@mail.northwind.dev', 'xpriya@mail.northwind.dev', 'priya@mail.northwind.dev']);
  });

  test('a grant Cloudflare no longer honours leaves the rules, and the retirement goes on', async () => {
    const zone = rulesZone();

    zone.refuseAll(403);

    expect(await settle(zone.routes().unrouted('priya', DOMAIN))).toBeUndefined();
  });
});

// Review, 2026-10-21: a deployment whose token Cloudflare would not mint took itself for an apex and gave out addresses
// that could not receive.
describe('what a deployment routes under', () => {
  test('no zone is an apex, or no mail: its catch-all routes every address, and nothing is made', () => {
    expect([mailRoutesOf({}), mailRoutesOf({ ...ROUTED, KINU_MAIL_ZONE: '' }), mailRoutesOf({ ...ROUTED, EMAIL_DOMAIN: '' })]).toEqual([null, null, null]);
  });

  test('a zone with no token refuses every new address in words that say what to do, and a retirement goes on', async () => {
    const zone = rulesZone();
    const routes = present(zone.routesFor({ ...ROUTED, KINU_MAIL_ROUTING_TOKEN: undefined }));

    await expect(settle(routes.routed(['dana@mail.northwind.dev']))).rejects.toMatchObject({
      code: 'unavailable', message: expect.stringContaining('Run the update and allow "Email Routing Rules"'),
    });
    expect(await settle(routes.unrouted('priya', DOMAIN))).toBeUndefined();
    expect(zone.calls).toEqual([]);
  });

  // Second review, 2026-10-21: a grant with no token lost its identity, so a deployment moved onto a subdomain without
  // one gave out the addresses it already had, unrouted, instead of refusing them.
  test('a zone with no token keeps its identity, so addresses last routed under another one are refused with the rest', async () => {
    const routes = present(rulesZone().routesFor({ ...ROUTED, KINU_MAIL_ROUTING_TOKEN: undefined }));

    expect(routes.under).toBe(present(rulesZone().routes()).under);
    expect(await settle(routes.routed([]))).toBeUndefined();
  });

  test('a zone with no record naming its Worker refuses every new address, as it cannot say where they go', async () => {
    const routes = present(rulesZone().routesFor({ ...ROUTED, KINU_DEPLOYMENT_RECORD: undefined }));

    await expect(settle(routes.routed(['dana@mail.northwind.dev']))).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('no self-deploy record') });
  });
});

// The lead's decision, 2026-10-21: `DELETE …/email/routing/dns` disables Email Routing for the whole zone and takes no
// subdomain, so on a shared zone it would turn off kinu.run's own mail. No code path may send it.
describe("a zone's Email Routing is never disabled", () => {
  test('the transport refuses the call before anything leaves', async () => {
    const sent: string[] = [];

    const fetched = Object.assign(async (input: RequestInfo | URL) => {
      sent.push(new Request(input).url);

      return new Response(JSON.stringify({ success: true, errors: [], result: {} }));
    }, { preconnect: fetch.preconnect });

    const transport = bearerTransport('rules-token', fetched);

    await expect(transport.request({ method: 'DELETE', path: '/zones/zone-raman/email/routing/dns' })).rejects.toThrow('never disables');
    await expect(transport.request({ method: 'DELETE', path: '/zones/zone-raman/email/routing/dns?name=mail.raman.dev' })).rejects.toThrow('never disables');
    expect(sent).toEqual([]);
  });

  test('retiring every address of a root deletes rules, never the routing', async () => {
    const zone = rulesZone();
    const routes = zone.routes();

    await settle(routes.routed(['priya@mail.northwind.dev']));
    await settle(routes.unrouted('priya', DOMAIN));

    expect(zone.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/zones/zone-raman/email/routing/rules/rule-1']);
  });
});
