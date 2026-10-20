// Onboarding the deployment's mail domain (docs/MAIL.md §5), the same on kinu.run and on a self-host: Email Routing
// on the zone with a catch-all to this Worker, Email Sending for the domain and its DNS records, and `_dmarc` where
// the domain has none. Each call is made only when the deploy's token may; what it may not do is asked of the owner,
// named exactly, and the deployment goes on without mail rather than failing. Paths are those wrangler 4.x calls
// (`src/email-routing/*`) and the API reference names, read 2026-10-20: routing is enabled through its DNS (`/enable` is
// deprecated; the apex with no name, as kinu.run's was refused one), and a sending subdomain is named by its `tag`.
import { Effect } from 'effect';
import * as v from 'valibot';
import type { KinuError } from '../obs/index';
import { readEnvelope, type CloudflareCall } from './cloudflare';
import type { DeployContext } from './context';
import type { DeployInputs } from './inputs';
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
async function allowed<Result>(context: DeployContext, call: CloudflareCall, schema: v.GenericSchema<Result>): Promise<Result | null> {
  const response = await context.transport.request(call);

  if (response.status === 401 || response.status === 403) return null;

  return readEnvelope(call.path, response, schema);
}

/** The zone the mail domain is the apex of: Email Routing's catch-all exists only there. */
async function zoneOf(context: DeployContext, domain: string): Promise<string | null> {
  const zones = await allowed(context, { method: 'GET', path: `/zones?name=${encodeURIComponent(domain)}&account.id=${context.inputs.accountId}` }, ZonesSchema);

  return zones?.find((zone) => zone.name === domain)?.id ?? null;
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
    const held = await allowed(context, {
      method: 'GET', path: `/zones/${zone}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}&per_page=100`,
    }, DnsRecordsSchema);

    if (held?.some((each) => recordValue(each) === recordValue(record)) === true) continue;

    const body: JsonObject = { type: record.type, name: record.name, content: record.content, ttl: 1 };

    if (record.priority !== undefined) body.priority = record.priority;

    const made = held === null ? null : await allowed(context, { method: 'POST', path: `/zones/${zone}/dns_records`, body }, v.object({ id: v.string() }));

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
  const now = await allowed(context, { method: 'GET', path: `/zones/${zone}/dns_records?type=TXT&name=${encodeURIComponent(wanted.name)}&per_page=100` }, DnsRecordsSchema);
  const sendings = (now ?? []).find((record) => recordValue(record).startsWith('v=DMARC1') && record.id !== undefined);

  if (sendings === undefined) return ensureRecords(context, zone, [wanted]);

  if (recordValue(sendings) === wanted.content) return [];
  const patched = await allowed(context, { method: 'PATCH', path: `/zones/${zone}/dns_records/${sendings.id ?? ''}`, body: { content: wanted.content } }, v.object({ id: v.string() }));

  return patched === null ? [wanted] : [];
}

/** The domain's sending subdomain: the one it has, else made now; null where the token may not. */
async function sendingDomain(context: DeployContext, zone: string, domain: string): Promise<v.InferOutput<typeof SendingDomainSchema> | null> {
  const held = await allowed(context, { method: 'GET', path: `/zones/${zone}/email/sending/subdomains` }, v.array(SendingDomainSchema));

  if (held === null) return null;

  return held.find((each) => each.name === domain)
    ?? await allowed(context, { method: 'POST', path: `/zones/${zone}/email/sending/subdomains`, body: { name: domain } }, SendingDomainSchema);
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

        const zone = await zoneOf(context, domain);

        if (zone === null) {
          context.note(`Mail needs ${domain} as a zone in this Cloudflare account, readable by the deploy's token. Add it, then run the update.`);

          return `Mail is off: ${domain} is not a zone this token can read.`;
        }

        const asks: string[] = [];
        // The domain is its zone's apex, which routing takes with no name: `name` is for a subdomain, and the apex's is refused.
        const routed = await allowed(context, { method: 'POST', path: `/zones/${zone}/email/routing/dns`, body: {} }, v.unknown());

        const catchAll = routed === null ? null : await allowed(context, {
          method: 'PUT', path: `/zones/${zone}/email/routing/rules/catch_all`,
          body: { enabled: true, name: 'Kinu', matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [inputs.instanceName] }] },
        }, v.unknown());

        if (routed === null || catchAll === null) {
          asks.push(`In the dashboard, open ${domain}, then Email, then Email Routing: enable it, and set the catch-all to "Send to a Worker: ${inputs.instanceName}". `
            + 'Or give the deploy token the zone\'s "Email Routing Rules: Edit" and "Zone Settings: Edit".');
        }

        const dmarcPath = `/zones/${zone}/dns_records?type=TXT&name=${encodeURIComponent(`_dmarc.${domain}`)}&per_page=100`;
        // Read before Sending is made: making it writes a DMARC of its own where the domain had none.
        const dmarcBefore = await allowed(context, { method: 'GET', path: dmarcPath }, DnsRecordsSchema);
        const sending = await sendingDomain(context, zone, domain);
        const records = sending === null ? null : await allowed(context, { method: 'GET', path: `/zones/${zone}/email/sending/subdomains/${sending.tag}/dns` }, DnsRecordsSchema);

        if (sending === null || records === null) {
          asks.push(`In the dashboard, open ${domain}, then Email, then Email Sending: enable it for ${domain} and add the records it lists. Sending needs Workers Paid.`);
        }

        const own = (records ?? []).filter((record) => record.name !== `_dmarc.${domain}`);
        const unwritten = [...await ensureRecords(context, zone, own), ...await ownDmarc(context, zone, domain, dmarcBefore)];

        if (unwritten.length > 0) asks.push(`Add these DNS records to ${domain}: ${unwritten.map(recordLine).join('; ')}.`);

        for (const ask of asks) context.note(ask);

        return asks.length === 0
          ? `Mail onboarded on ${domain}: routing to ${inputs.instanceName}, sending, and DMARC at p=none.`
          : `Mail on ${domain} needs ${String(asks.length)} thing${asks.length === 1 ? '' : 's'} from you; until then mail does not arrive or leave.`;
      });
    },
  };
}
