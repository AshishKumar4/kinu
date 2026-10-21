// Mail on a subdomain of its zone (docs/MAIL.md §5): each address routes by a literal rule of its own, made as the
// address is and deleted as its root is retired; and nothing ever disables a zone's Email Routing.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { bearerTransport, mailRoutes, type CloudflareCall, type CloudflareHttpResponse, type CloudflareTransport } from '../src/deploy/index';
import { settle } from '../src/obs/index';
import type { JsonValue } from '../src/utils/json';

const GRANT = { zone: 'zone-raman', worker: 'kinu-raman', token: 'rules-token' };

/** A rule as a POST asks for it: one literal address, one Worker. */
const AskedRule = v.object({
  matchers: v.tuple([v.object({ type: v.literal('literal'), field: v.literal('to'), value: v.string() })]),
  actions: v.tuple([v.object({ type: v.literal('worker'), value: v.tuple([v.string()]) })]),
});

interface HeldRule {
  readonly id: string;
  readonly to: string;
  readonly worker: string;
}

const listed = (rule: HeldRule) => ({ id: rule.id, ...literal(rule.to, rule.worker) });

function literal(to: string, worker = GRANT.worker) {
  return { matchers: [{ type: 'literal', field: 'to', value: to }], actions: [{ type: 'worker', value: [worker] }] };
}

/** A zone's routing rules as the API lists, makes and deletes them; `cap` is the platform's 200 a domain. */
function rulesZone(cap = 200) {
  const calls: CloudflareCall[] = [];
  const rules = new Map<string, HeldRule>();
  let refuse: CloudflareHttpResponse | null = null;
  const ok = (result: JsonValue): CloudflareHttpResponse => ({ status: 200, body: { success: true, errors: [], result } });

  const transport: CloudflareTransport = {
    request: async (call) => {
      calls.push(call);

      if (refuse !== null) return refuse;
      const page = Number(/[?&]page=(\d+)/u.exec(call.path)?.[1] ?? '1');

      if (call.method === 'GET') return ok([...rules.values()].slice((page - 1) * 50, page * 50).map(listed));

      if (call.method === 'POST' && rules.size >= cap) {
        return { status: 400, body: { success: false, errors: [{ code: 2020, message: 'Rule limit reached' }], result: null } };
      }

      if (call.method === 'POST') {
        const id = `rule-${String(rules.size + 1)}`;
        const asked = v.parse(AskedRule, call.body);

        rules.set(id, { id, to: asked.matchers[0].value, worker: asked.actions[0].value[0] });

        return ok({ id });
      }

      rules.delete(call.path.split('/').at(-1) ?? '');

      return ok({});
    },
    upload: async () => ok({}),
    put: async () => ok({}),
  };

  return {
    calls, rules, transport,
    refuseAll: (status: number) => { refuse = { status, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null } }; },
    addresses: () => [...rules.values()].map((rule) => rule.to),
  };
}

describe('the rules a subdomain routes its addresses by', () => {
  test('an address is routed by a rule of its own, made once', async () => {
    const zone = rulesZone();
    const routes = mailRoutes(GRANT, zone.transport);

    await settle(routes.routed('Dana@mail.northwind.dev'));
    await settle(routes.routed('dana@mail.northwind.dev'));

    expect(zone.addresses()).toEqual(['dana@mail.northwind.dev']);
    expect(zone.calls.find((call) => call.method === 'POST')).toEqual({
      method: 'POST', path: '/zones/zone-raman/email/routing/rules',
      body: { name: 'Kinu dana@mail.northwind.dev', enabled: true, ...literal('dana@mail.northwind.dev') },
    });
  });

  test('the 201st address is refused in the platform\'s own words, and no cap of ours comes before it', async () => {
    const zone = rulesZone(200);
    const routes = mailRoutes(GRANT, zone.transport);

    for (let n = 1; n <= 200; n += 1) await settle(routes.routed(`agent${String(n)}.priya@mail.northwind.dev`));

    await expect(settle(routes.routed('dana@mail.northwind.dev'))).rejects.toMatchObject({
      code: 'denied', message: 'routing dana@mail.northwind.dev: Cloudflare answered: Rule limit reached',
    });
    expect(zone.rules.size).toBe(200);
  });

  test('an address another Worker routes is not taken from it', async () => {
    const zone = rulesZone();

    zone.rules.set('rule-staging', { id: 'rule-staging', to: 'eval@mail.northwind.dev', worker: 'kinu-staging' });

    await expect(settle(mailRoutes(GRANT, zone.transport).routed('eval@mail.northwind.dev'))).rejects.toMatchObject({
      code: 'denied', message: 'eval@mail.northwind.dev already routes to kinu-staging.',
    });
    expect(zone.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a retired root unroutes its own address and every box under it, and nothing of anyone else', async () => {
    const zone = rulesZone();
    const routes = mailRoutes(GRANT, zone.transport);

    for (const address of ['priya@mail.northwind.dev', 'ops.priya@mail.northwind.dev', 'triage.ops.priya@mail.northwind.dev', 'dana@mail.northwind.dev', 'xpriya@mail.northwind.dev']) {
      await settle(routes.routed(address));
    }

    zone.rules.set('rule-other', { id: 'rule-other', to: 'priya@mail.northwind.dev', worker: 'kinu-staging' });
    await settle(routes.unrouted('priya', 'mail.northwind.dev'));

    expect(zone.addresses()).toEqual(['dana@mail.northwind.dev', 'xpriya@mail.northwind.dev', 'priya@mail.northwind.dev']);
  });

  test('a grant Cloudflare no longer honours leaves the rules, and the retirement goes on', async () => {
    const zone = rulesZone();

    zone.refuseAll(403);

    expect(await settle(mailRoutes(GRANT, zone.transport).unrouted('priya', 'mail.northwind.dev'))).toBeUndefined();
  });
});

// Main's decision, 2026-10-21: `DELETE …/email/routing/dns` disables Email Routing for the whole zone and takes no
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
    const routes = mailRoutes(GRANT, zone.transport);

    await settle(routes.routed('priya@mail.northwind.dev'));
    await settle(routes.unrouted('priya', 'mail.northwind.dev'));

    expect(zone.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/zones/zone-raman/email/routing/rules/rule-1']);
  });
});
