/**
 * Node-side Email Routing for the mail routing probe, installed as its `outboundService`: one zone's literal rules as
 * the API lists, makes and deletes them, and the platform's 200 a domain (developers.cloudflare.com/email-routing/limits/),
 * lowered by a test to reach it. Every call is kept; any other host or path throws, so a call no path of Kinu's should
 * make (a zone's routing disabled among them) is a finding, not a pass.
 */
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';

export const MAIL_RULES_ZONE = 'zone-northwind';

export const MAIL_RULES_WORKER = 'kinu-northwind';

export const MAIL_RULES_TOKEN = 'northwind-rules-token';

export const MAIL_RULES_DOMAIN = 'mail.northwind.dev';

export interface MailRulesState {
  readonly addresses: readonly string[];
  readonly calls: readonly string[];
}

const RULES = `https://api.cloudflare.com/client/v4/zones/${MAIL_RULES_ZONE}/email/routing/rules`;

const AskedRule = v.object({
  matchers: v.tuple([v.object({ type: v.literal('literal'), field: v.literal('to'), value: v.string() })]),
  actions: v.tuple([v.object({ type: v.literal('worker'), value: v.tuple([v.string()]) })]),
});

const rules = new Map<string, { to: string; worker: string }>();

const calls: string[] = [];

let cap = 200;

let made = 0;

/** A status the next listing is answered with, once, as Cloudflare rate-limits or refuses a token. */
let listRefused: number | null = null;

const answer = (result: JsonValue, status = 200) => Response.json({ success: status < 300, errors: status < 300 ? [] : [result], result: status < 300 ? result : null }, { status });

function control(url: URL): Response {
  if (url.pathname === '/reset') {
    rules.clear();
    calls.length = 0;
    cap = 200;
    made = 0;
    listRefused = null;
  }

  if (url.pathname === '/cap') cap = Number(url.searchParams.get('n'));

  if (url.pathname === '/refuse-list') listRefused = Number(url.searchParams.get('status'));

  return Response.json({ addresses: [...rules.values()].map((rule) => rule.to), calls: [...calls] } satisfies MailRulesState);
}

export async function mailRulesOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.host === 'mail-rules-control.invalid') return control(url);
  calls.push(`${request.method} ${url.pathname}${url.search}`);

  if (request.headers.get('authorization') !== `Bearer ${MAIL_RULES_TOKEN}` || !request.url.startsWith(RULES)) {
    throw new Error(`Unmatched test egress is disabled: ${request.method} ${request.url}`);
  }

  if (request.method === 'GET' && listRefused !== null) {
    const status = listRefused;

    listRefused = null;

    return answer({ code: 971, message: 'Please wait and consider throttling your request speed' }, status);
  }

  if (request.method === 'GET') {
    const page = Number(url.searchParams.get('page') ?? '1');
    const listed = [...rules].map(([id, rule]) => ({ id, matchers: [{ type: 'literal', field: 'to', value: rule.to }], actions: [{ type: 'worker', value: [rule.worker] }] }));

    return answer(listed.slice((page - 1) * 50, page * 50));
  }

  if (request.method === 'POST' && rules.size >= cap) return answer({ code: 2020, message: 'Rule limit reached' }, 400);

  if (request.method === 'POST') {
    const asked = v.parse(AskedRule, await request.json());
    const id = `rule-${String(made += 1)}`;

    rules.set(id, { to: asked.matchers[0].value, worker: asked.actions[0].value[0] });

    return answer({ id });
  }

  if (request.method === 'DELETE' && rules.delete(url.pathname.split('/').at(-1) ?? '')) return answer({});

  throw new Error(`Unmatched test egress is disabled: ${request.method} ${request.url}`);
}
