// Onboarding the deployment's mail domain (docs/MAIL.md §5), the same on kinu.run and on a self-host: Email Routing
// on the zone with a catch-all to this Worker, Email Sending for the domain and its DNS records, and `_dmarc` where
// the domain has none. A domain under its zone's apex is routed as a subdomain, which has no catch-all (Cloudflare's is
// the apex's alone): each of its addresses routes by a literal rule the deployment makes as it makes the address, with
// the token `mailRoutingStep` mints. Each call is made only when the deploy's token may; what it may not do is asked of the owner,
// named exactly, and the deployment goes on without mail rather than failing. Paths are those wrangler 4.x calls
// (`src/email-routing/*`) and the API reference names, read 2026-10-20: routing is enabled through its DNS (`/enable` is
// deprecated; the apex with no name, as kinu.run's was refused one), and a sending subdomain is named by its `tag`.
import { Cause, Effect } from 'effect';
import * as v from 'valibot';
import type { KinuError } from '../obs/index';
import { CloudflareApiError, cloudflareResult, readEnvelope, type CloudflareCall, type CloudflareTransport } from './cloudflare';
import type { DeployContext } from './context';
import { MAIL_ROUTING_SECRET, type DeployInputs } from './inputs';
import { instanceToken } from './instance-token';
import { mailRoutingGrant } from './mail-rules';
import type { DeployStep } from './steps';
import type { JsonObject } from '../utils/json';

/** Where DMARC reports go until the owner moves the policy past `p=none` (MAIL.md §5). */
function dmarcRecord(domain: string): string {
  return `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`;
}

const ZonesSchema = v.array(v.object({ id: v.string(), name: v.string() }));

const SendingDomainSchema = v.object({ tag: v.string(), name: v.string() });

const DnsRecordsSchema = v.array(v.object({
  id: v.optional(v.string()), type: v.string(), name: v.string(), content: v.string(), priority: v.optional(v.number()), ttl: v.optional(v.number()),
}));

type DnsRecord = v.InferOutput<typeof DnsRecordsSchema>[number];

/**
 * The call's answer, or null when the token may not make it: a refusal its scope explains, which the owner can do
 * themselves or widen the token for. Any other failure fails the step.
 */
async function allowed<Result>(transport: CloudflareTransport, call: CloudflareCall, schema: v.GenericSchema<Result>): Promise<Result | null> {
  const response = await transport.request(call);

  if (response.status === 401 || response.status === 403) return null;

  return readEnvelope(call.path, response, schema);
}

export interface MailZone {
  readonly id: string;
  readonly name: string;
}

/**
 * The account's zone the mail host is in: the host itself where it is a zone's apex, else the nearest zone above it.
 * Null where the token can read none. An apex is asked for once, as it always was.
 */
async function zoneOf(transport: CloudflareTransport, accountId: string, host: string): Promise<MailZone | null> {
  const labels = host.split('.');

  for (let at = 0; at < labels.length - 1; at += 1) {
    const name = labels.slice(at).join('.');
    const zones = await allowed(transport, { method: 'GET', path: `/zones?name=${encodeURIComponent(name)}&account.id=${accountId}` }, ZonesSchema);
    const zone = zones?.find((each) => each.name === name);

    if (zone !== undefined) return { id: zone.id, name: zone.name };
  }

  return null;
}

/**
 * A record's value as DNS means it. Email Sending lists an MX host with its root dot and a TXT in one quoted string; the
 * zone holds the MX without the dot and a TXT longer than 255 characters as several strings (measured on staging.kinu.run
 * and kinu.run, 2026-10-20).
 */
function recordValue(record: Pick<DnsRecord, 'type' | 'content'>): string {
  const value = record.content.trim();

  if (record.type === 'MX') return value.replace(/\.$/u, '').toLowerCase();

  if (record.type !== 'TXT' || !value.startsWith('"')) return value;

  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((part) => part[1] ?? '').join('');
}

/** Adds each record the zone does not hold yet; the records the token may not write are returned to ask for. */
async function ensureRecords(context: DeployContext, zone: string, records: readonly DnsRecord[]): Promise<DnsRecord[]> {
  const asked: DnsRecord[] = [];

  for (const record of records) {
    const held = await allowed(context.transport, {
      method: 'GET', path: `/zones/${zone}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}&per_page=100`,
    }, DnsRecordsSchema);

    if (held?.some((each) => recordValue(each) === recordValue(record)) === true) continue;

    const body: JsonObject = { type: record.type, name: record.name, content: record.content, ttl: 1 };

    if (record.priority !== undefined) body.priority = record.priority;

    const made = held === null ? null : await allowed(context.transport, { method: 'POST', path: `/zones/${zone}/dns_records`, body }, v.object({ id: v.string() }));

    if (made === null) asked.push(record);
  }

  return asked;
}

/**
 * DMARC is this step's decision where the domain had none, report-only to start (docs/MAIL.md §5): it replaces the
 * p=reject Sending writes with it. A domain's own DMARC, held before, is kept. Returns the record if the token may not.
 */
async function ownDmarc(context: DeployContext, zone: string, domain: string, before: readonly DnsRecord[] | null): Promise<DnsRecord[]> {
  const wanted = { type: 'TXT', name: `_dmarc.${domain}`, content: dmarcRecord(domain) };

  if (before === null) return [wanted];

  if (before.some((record) => recordValue(record).startsWith('v=DMARC1'))) return [];
  const now = await allowed(context.transport, { method: 'GET', path: `/zones/${zone}/dns_records?type=TXT&name=${encodeURIComponent(wanted.name)}&per_page=100` }, DnsRecordsSchema);
  const sendings = (now ?? []).find((record) => recordValue(record).startsWith('v=DMARC1') && record.id !== undefined);

  if (sendings === undefined) return ensureRecords(context, zone, [wanted]);

  if (recordValue(sendings) === wanted.content) return [];
  const patched = await allowed(context.transport, { method: 'PATCH', path: `/zones/${zone}/dns_records/${sendings.id ?? ''}`, body: { content: wanted.content } }, v.object({ id: v.string() }));

  return patched === null ? [wanted] : [];
}

/** The domain's sending subdomain: the one it has, else made now; null where the token may not. */
async function sendingDomain(context: DeployContext, zone: string, domain: string): Promise<v.InferOutput<typeof SendingDomainSchema> | null> {
  const held = await allowed(context.transport, { method: 'GET', path: `/zones/${zone}/email/sending/subdomains` }, v.array(SendingDomainSchema));

  if (held === null) return null;

  return held.find((each) => each.name === domain)
    ?? await allowed(context.transport, { method: 'POST', path: `/zones/${zone}/email/sending/subdomains`, body: { name: domain } }, SendingDomainSchema);
}

/** Cloudflare's name for the permission a subdomain's rules are made with (its permission groups, read 2026-10-21). */
const EMAIL_ROUTING_RULES_WRITE = 'Email Routing Rules Write';

/** A refusal the token's scope explains: the person did not grant it, and can, or can make the rules themselves. */
const scopeRefused = (failed: Cause.Cause<KinuError>): boolean => {
  const cause = Cause.squash(failed);

  return cause instanceof CloudflareApiError && (cause.status === 401 || cause.status === 403);
};

/** The zone the mail host is in, as the routing step found it, so the mail step asks for it no second time. */
const FACT_MAIL_ZONE = 'mail.zone';

/** The routing token this run minted, which the step after the promote keeps while it retires the ones before it. */
const FACT_MAIL_TOKEN = 'mail.token';

/** The zone a fact holds: `id name`, or empty where the host is in no zone this token can read. */
function factZone(held: string): MailZone | null {
  const [id = '', name = ''] = held.split(' ');

  return id === '' ? null : { id, name };
}

/** This deployment's routing tokens are named `<instance> mail <zone> <run tag> (Kinu)`: one each run, never rolled. */
const routingTokenPrefix = (inputs: DeployInputs): string => `${inputs.instanceName} mail `;

const ROUTING_TOKEN_SUFFIX = ' (Kinu)';

/**
 * Mail on a subdomain routes each address by a rule the deployment makes as it makes the address, so the run mints it a
 * token that may edit that zone's routing rules and nothing else, from the person's grant, and binds it with the zone,
 * this Worker and the domain as `KINU_MAIL_ROUTING`. Before the upload, which binds it. Each run mints its own, so the
 * running version keeps its token until this one is live (`mailRoutingRetiredStep`). Where Cloudflare will not mint it,
 * or the zone cannot be read, the grant holds no token and the deployment refuses addresses it could not route. An apex
 * needs none: its catch-all routes every address, and kinu.run's is untouched by this.
 */
export function mailRoutingStep(inputs: DeployInputs): DeployStep {
  return {
    id: 'mail-routing',
    title: "Mint the mail's routing token",
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const domain = inputs.mailDomain ?? '';

        if (domain === '') return 'No mail domain was given, so there is nothing to route.';
        const zone = yield* Effect.promise(async () => zoneOf(context.transport, inputs.accountId, domain));
        const grant = (zoneId: string, token: string | null) => mailRoutingGrant({ zone: zoneId, worker: inputs.instanceName, domain, token });

        context.facts.set(FACT_MAIL_ZONE, zone === null ? '' : `${zone.id} ${zone.name}`);

        // The mail step says what it needs; until then no address is given out that could not receive.
        if (zone === null) {
          yield* Effect.promise(async () => context.vault.write(MAIL_ROUTING_SECRET, grant('', null)));

          return `${domain} is in no zone this token can read.`;
        }

        if (zone.name === domain) return `${domain} is its zone's apex, whose catch-all routes every address.`;
        const name = `${routingTokenPrefix(inputs)}${zone.name} ${context.tag}${ROUTING_TOKEN_SUFFIX}`;

        const outcome = yield* instanceToken(context, {
          name, permission: EMAIL_ROUTING_RULES_WRITE, resource: `com.cloudflare.api.account.zone.${zone.id}`, secret: MAIL_ROUTING_SECRET, stored: (token) => grant(zone.id, token),
        }).pipe(Effect.catchCause((failed) => (scopeRefused(failed) ? Effect.succeed('refused' as const) : Effect.failCause(failed))));

        if (outcome === 'refused') {
          yield* Effect.promise(async () => context.vault.write(MAIL_ROUTING_SECRET, grant(zone.id, null)));
          context.note(`Mail on ${domain} routes each address by a rule of its own, which this deployment makes with a token it mints. `
            + 'Sign in again and allow "Email Routing Rules" and "API Tokens", then run the update; until then no address can be made.');

          return `No routing token: Cloudflare refused minting one for ${zone.name}.`;
        }

        context.facts.set(FACT_MAIL_TOKEN, name);

        if (outcome === 'kept') return `The routing token for ${domain} is held.`;

        return `${outcome === 'minted' ? 'Minted' : 'Rolled'} "${name}", which may edit ${zone.name}'s routing rules and nothing else.`;
      });
    },
  };
}

const TokensSchema = v.array(v.object({ id: v.string(), name: v.string() }));

const RulesSchema = v.object({
  id: v.string(),
  matchers: v.array(v.object({ type: v.string(), field: v.optional(v.string()), value: v.optional(v.string()) })),
  actions: v.array(v.object({ type: v.string(), value: v.optional(v.array(v.string())) })),
});

/** A rule's one literal address, and the Worker it sends to. */
function ruleOf(rule: v.InferOutput<typeof RulesSchema>) {
  const [matcher] = rule.matchers;
  const to = rule.matchers.length === 1 && matcher?.type === 'literal' ? matcher.value ?? '' : '';

  return { to, worker: rule.actions.find((action) => action.type === 'worker')?.value?.[0] };
}

/** In `zone`, the rules sending this Worker an address not at the mail domain now, deleted; null pages where refused. */
async function rulesElsewhere(context: DeployContext, zone: MailZone, inputs: DeployInputs): Promise<{ readonly rules: number; readonly refused: boolean }> {
  const domain = inputs.mailDomain ?? '';
  const path = `/zones/${zone.id}/email/routing/rules`;
  const listed: v.InferOutput<typeof RulesSchema>[] = [];

  for (let page = 1; ; page += 1) {
    const batch = await allowed(context.transport, { method: 'GET', path: `${path}?per_page=50&page=${String(page)}` }, v.array(RulesSchema));

    if (batch === null) return { rules: 0, refused: true };
    listed.push(...batch);

    if (batch.length < 50) break;
  }

  const elsewhere = listed.filter((rule) => {
    const { to, worker } = ruleOf(rule);

    return to !== '' && worker === inputs.instanceName && (domain === '' || !to.endsWith(`@${domain}`));
  });

  let refused = false;

  for (const rule of elsewhere) refused ||= (await allowed(context.transport, { method: 'DELETE', path: `${path}/${rule.id}` }, v.unknown())) === null;

  return { rules: elsewhere.length, refused };
}

/**
 * Once this version is live: the routing tokens of the runs before it deleted, and the rules this Worker held for any
 * address not at its mail domain now (one it moved from, in that zone or another), with the person's own grant. A run
 * that never went live leaves the running version's token and rules as they were. A refusal is asked of the owner.
 */
export function mailRoutingRetiredStep(inputs: DeployInputs): DeployStep {
  return {
    id: 'mail-routing-retired',
    title: 'Retire the mail routing this version replaced',
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.promise(async () => {
        const account = inputs.accountId;
        const domain = inputs.mailDomain ?? '';
        const kept = context.facts.get(FACT_MAIL_TOKEN) ?? '';

        const prefix = routingTokenPrefix(inputs);

        // Mail turned off retires nothing here: its former grant no longer matches, so nothing more is routed with it.
        if (domain === '') return 'No mail domain, so no routing to retire.';
        const tokens = await allowed(context.transport, { method: 'GET', path: `/accounts/${account}/tokens?per_page=50` }, TokensSchema);

        // A grant that may not read the tokens never minted one either: nothing of this deployment's is there to retire.
        if (tokens === null) return 'The account\'s tokens could not be read, so no earlier routing token was looked for.';
        const before = tokens.filter((token) => token.name !== kept && token.name.startsWith(prefix) && token.name.endsWith(ROUTING_TOKEN_SUFFIX));
        const current = factZone(context.facts.get(FACT_MAIL_ZONE) ?? '');

        // Only a deployment that routed by rules before has rules to retire: the zones its tokens were for, and this one.
        const zoneNames = new Set(before.length === 0 ? [] : [...before.map((token) => token.name.slice(prefix.length).split(' ')[0] ?? ''), ...current === null ? [] : [current.name]]);
        let rules = 0;
        let refused = false;

        for (const zoneName of zoneNames) {
          const zone = current?.name === zoneName ? current : await zoneOf(context.transport, account, zoneName);
          const retired = zone === null || zone.name !== zoneName ? { rules: 0, refused: false } : await rulesElsewhere(context, zone, inputs);

          rules += retired.rules;
          refused ||= retired.refused;
        }

        for (const token of before) refused ||= (await allowed(context.transport, { method: 'DELETE', path: `/accounts/${account}/tokens/${token.id}` }, v.unknown())) === null;

        if (refused) {
          context.note(`Some of the mail routing this version replaced could not be removed: delete the "${prefix}…" tokens other than this run's, `
            + `and the Email Routing rules sending addresses not at ${domain === '' ? 'any domain' : domain} to the Worker ${inputs.instanceName}.`);
        }

        return `${String(before.length)} earlier routing token(s) and ${String(rules)} rule(s) for another domain retired.`;
      });
    },
  };
}

const recordLine = (record: DnsRecord): string => `${record.type} ${record.name} ${record.priority === undefined ? '' : `${String(record.priority)} `}${record.content}`;

export function mailStep(inputs: DeployInputs) {
  return {
    id: 'mail',
    title: 'Onboard the mail domain',
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.promise(async () => {
        const domain = inputs.mailDomain ?? '';

        if (domain === '') return 'No mail domain was given, so this deployment has no mail addresses.';

        const found = context.facts.get(FACT_MAIL_ZONE);
        const zoned = found === undefined ? await zoneOf(context.transport, inputs.accountId, domain) : factZone(found);

        if (zoned === null) {
          context.note(`Mail needs ${domain} in a zone of this Cloudflare account, readable by the deploy's token. Add it, then run the update.`);

          return `Mail is off: ${domain} is in no zone this token can read.`;
        }

        const zone = zoned.id;
        const apex = zoned.name === domain;
        const asks: string[] = [];
        // An apex takes routing with no name, and its catch-all routes every address. A subdomain is named, and has no
        // catch-all: the apex's is the zone's own, never this step's to touch.
        const routed = await allowed(context.transport, { method: 'POST', path: `/zones/${zone}/email/routing/dns`, body: apex ? {} : { name: domain } }, v.unknown());

        const catchAll = routed === null || !apex ? routed : await allowed(context.transport, {
          method: 'PUT', path: `/zones/${zone}/email/routing/rules/catch_all`,
          body: { enabled: true, name: 'Kinu', matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [inputs.instanceName] }] },
        }, v.unknown());

        if (routed === null || catchAll === null) {
          asks.push(apex
            ? `In the dashboard, open ${domain}, then Email, then Email Routing: enable it, and set the catch-all to "Send to a Worker: ${inputs.instanceName}". `
              + 'Or give the deploy token the zone\'s "Email Routing Rules: Edit" and "Zone Settings: Edit".'
            : `In the dashboard, open ${zoned.name}, then Email, then Email Routing, then Settings: add ${domain} under Subdomains. `
              + 'Or give the deploy token the zone\'s "Zone Settings: Edit".');
        }

        const dmarcPath = `/zones/${zone}/dns_records?type=TXT&name=${encodeURIComponent(`_dmarc.${domain}`)}&per_page=100`;
        // Read before Sending is made: making it writes a DMARC of its own where the domain had none.
        const dmarcBefore = await allowed(context.transport, { method: 'GET', path: dmarcPath }, DnsRecordsSchema);
        const sending = await sendingDomain(context, zone, domain);
        const records = sending === null ? null : await allowed(context.transport, { method: 'GET', path: `/zones/${zone}/email/sending/subdomains/${sending.tag}/dns` }, DnsRecordsSchema);

        if (sending === null || records === null) {
          asks.push(`In the dashboard, open ${domain}, then Email, then Email Sending: enable it for ${domain} and add the records it lists. Sending needs Workers Paid.`);
        }

        const own = (records ?? []).filter((record) => record.name !== `_dmarc.${domain}`);
        const unwritten = [...await ensureRecords(context, zone, own), ...await ownDmarc(context, zone, domain, dmarcBefore)];

        if (unwritten.length > 0) asks.push(`Add these DNS records to ${domain}: ${unwritten.map(recordLine).join('; ')}.`);

        for (const ask of asks) context.note(ask);

        const routes = apex ? `routing to ${inputs.instanceName}` : `each address routed to ${inputs.instanceName} by a rule of its own`;

        return asks.length === 0
          ? `Mail onboarded on ${domain}: ${routes}, sending, and DMARC at p=none.`
          : `Mail on ${domain} needs ${String(asks.length)} thing${asks.length === 1 ? '' : 's'} from you; until then mail does not arrive or leave.`;
      });
    },
  };
}

export type MailPurpose = 'receive' | 'send' | 'sign' | 'report';

export interface MailRecord {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly purpose: MailPurpose;
}

/** What the mail step would write on a zone's apex, and what the zone already holds of it: read, never written. */
export interface MailPreview {
  readonly host: string;
  /** An MX the domain already has that points elsewhere: keep that mail on a subdomain, or stop. */
  readonly conflict: { readonly mx: string; readonly suggestion: string } | null;
  readonly writes: readonly MailRecord[];
  readonly kept: readonly MailRecord[];
}

const MailRecordSchema = v.object({ type: v.string(), name: v.string(), content: v.string(), purpose: v.picklist(['receive', 'send', 'sign', 'report']) });

export const MailPreviewSchema: v.GenericSchema<MailPreview> = v.object({
  host: v.string(),
  conflict: v.nullable(v.object({ mx: v.string(), suggestion: v.string() })),
  writes: v.array(MailRecordSchema),
  kept: v.array(MailRecordSchema),
});

/** Email Routing's own MX hosts (`route1.mx.cloudflare.net` …), which the step writes rather than meets. */
const ROUTING_MX = /\.mx\.cloudflare\.net$/u;

function purposeOf(record: Pick<DnsRecord, 'type' | 'content'>, routing: boolean): MailPurpose {
  const value = recordValue(record);

  if (record.type === 'MX') return routing ? 'receive' : 'send';

  if (value.startsWith('v=DKIM1')) return 'sign';

  return value.startsWith('v=DMARC1') ? 'report' : 'send';
}

/**
 * The same records the step reaches for `host`, the zone's apex unless it names a subdomain under it: Email Routing's
 * (`GET …/email/routing/dns`, the records it needs), the sending domain's when it exists (Cloudflare makes them with
 * it, so a domain not sending yet lists none), and DMARC where the domain has none. A read Cloudflare refuses fails the
 * preview in its words: a record it could not read is not absent.
 */
export function mailPreview(transport: CloudflareTransport, zone: MailZone, host = zone.name): Effect.Effect<MailPreview> {
  return Effect.promise(async () => {
    const read = async (type: string, name: string) => await cloudflareResult(transport, {
      method: 'GET', path: `/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=100`,
    }, DnsRecordsSchema);

    // Routing lists the apex's records; a subdomain it routes holds the same, under its own name (kinu.run and
    // staging.kinu.run, zone census 2026-10-20). Its `subdomain` query is deprecated, its answer unmodelled.
    const routing = (await cloudflareResult(transport, { method: 'GET', path: `/zones/${zone.id}/email/routing/dns` }, DnsRecordsSchema))
      .map((record) => (record.name === zone.name ? { ...record, name: host } : record));

    const sendings = await cloudflareResult(transport, { method: 'GET', path: `/zones/${zone.id}/email/sending/subdomains` }, v.array(SendingDomainSchema));
    const sending = sendings.find((each) => each.name === host);

    const sent = sending === undefined
      ? []
      : await cloudflareResult(transport, { method: 'GET', path: `/zones/${zone.id}/email/sending/subdomains/${sending.tag}/dns` }, DnsRecordsSchema);

    const asMail = (records: readonly DnsRecord[], routes: boolean): MailRecord[] => records
      .map((record) => ({ type: record.type, name: record.name, content: record.content, purpose: purposeOf(record, routes) }));

    const wanted = [...asMail(routing, true), ...asMail(sent.filter((record) => record.name !== `_dmarc.${host}`), false)];

    const writes: MailRecord[] = [];
    const kept: MailRecord[] = [];

    for (const record of wanted) {
      const held = await read(record.type, record.name);

      (held.some((each) => recordValue(each) === recordValue(record)) ? kept : writes).push(record);
    }

    const heldDmarc = (await read('TXT', `_dmarc.${host}`)).find((record) => recordValue(record).startsWith('v=DMARC1'));
    const dmarc: MailRecord = { type: 'TXT', name: `_dmarc.${host}`, content: heldDmarc === undefined ? dmarcRecord(host) : recordValue(heldDmarc), purpose: 'report' };

    (heldDmarc === undefined ? writes : kept).push(dmarc);

    const receiving = new Set(routing.filter((record) => record.type === 'MX').map(recordValue));
    const elsewhere = (await read('MX', host)).map(recordValue).find((mx) => !receiving.has(mx) && !ROUTING_MX.test(mx));

    return { host, conflict: elsewhere === undefined ? null : { mx: elsewhere, suggestion: `mail.${host}` }, writes, kept };
  });
}
