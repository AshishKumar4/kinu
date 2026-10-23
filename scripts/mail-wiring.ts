/**
 * A deployment's inbound mail as far as a check that may hold no address there can read it. The deployment's mail
 * domain hands its mail to Cloudflare Email Routing (MX); Email Routing hands each of the deployment's own addresses
 * (MAIL_ALIASES) to its Worker; the box each one reaches exists; and Email Sending has not suppressed it.
 *
 * Production lets the check hold no address (they are its operators' only), so this is how it checks inbound there.
 * Staging's check sends a message and reads it back (staging-mail-inbound.ts).
 */
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mailDeploymentAliases } from '../packages/core/src/mail/address';
import { parseJsonc } from './jsonc';

const WRANGLER = join(import.meta.dir, '../packages/cf-backend/wrangler.jsonc');

const RouteSchema = v.object({ pattern: v.string(), custom_domain: v.optional(v.boolean()), zone_name: v.optional(v.string()) });

const MailVarsSchema = v.looseObject({ EMAIL_DOMAIN: v.optional(v.string()), MAIL_ALIASES: v.optional(v.string()) });

const EnvSchema = v.looseObject({ name: v.optional(v.string()), routes: v.optional(v.array(RouteSchema)), vars: v.optional(MailVarsSchema) });

const WranglerSchema = v.looseObject({
  name: v.string(), routes: v.array(RouteSchema), vars: MailVarsSchema, env: v.optional(v.record(v.string(), EnvSchema)),
});

/** The deployment an origin names, as its Worker's config declares its mail. */
export interface DeploymentMail {
  /** The Worker Email Routing must hand its mail to. */
  readonly worker: string;
  readonly domain: string;
  readonly zone: string;
  /** Each own address's label, to the username whose box it reaches. */
  readonly aliases: ReadonlyMap<string, string>;
}

/**
 * The deployment serving `origin`: the Worker whose config routes the origin's host as a custom domain. That is the
 * top level (production) or one named environment, whose Worker wrangler calls `<name>-<env>`.
 */
export function deploymentMailOf(origin: string, source = readFileSync(WRANGLER, 'utf8')): DeploymentMail {
  const config = parseJsonc(source, WranglerSchema, WRANGLER);
  const host = new URL(origin).hostname;

  const deployments = [
    { worker: config.name, routes: config.routes, vars: config.vars },
    ...Object.entries(config.env ?? {}).map(([env, declared]) => ({ worker: declared.name ?? `${config.name}-${env}`, routes: declared.routes ?? [], vars: declared.vars ?? {} })),
  ];

  const serving = deployments.find((deployment) => deployment.routes.some((route) => route.custom_domain === true && route.pattern === host));

  if (serving === undefined) throw new Error(`no Worker in ${WRANGLER} serves ${host} as a custom domain`);
  const zone = serving.routes.find((route) => route.zone_name !== undefined)?.zone_name;
  const domain = serving.vars.EMAIL_DOMAIN;
  const aliases = mailDeploymentAliases(serving.vars.MAIL_ALIASES);

  if (zone === undefined || domain === undefined) throw new Error(`${serving.worker} declares no zone or no EMAIL_DOMAIN, so it takes no mail`);

  if (aliases === 'malformed') throw new Error(`${serving.worker}'s MAIL_ALIASES is not an object of labels to usernames`);

  return { worker: serving.worker, domain, zone, aliases };
}

/** What the check read of a deployment's inbound mail. */
export interface MailWiring {
  /** The mail domain's MX hosts, as DNS answers them. */
  readonly mx: readonly string[];
  /** Each own address, with the Workers the Email Routing rule that matches it hands its mail to (none for another action). */
  readonly routes: ReadonlyArray<{ readonly address: string; readonly workers: readonly string[] }>;
  /** Each own address, with the username it reaches and whether that box exists. */
  readonly targets: ReadonlyArray<{ readonly address: string; readonly username: string; readonly held: boolean }>;
  /** Each own address that Email Sending has suppressed after a bounce or complaint, from any sending domain. */
  readonly suppressed: readonly string[];
}

/** Email Routing's MX hosts (developers.cloudflare.com/email-routing, read 2026-10-20). */
const ROUTING_MX = /\.mx\.cloudflare\.net\.?$/u;

/** What keeps mail to the deployment's own addresses from arriving, one sentence each; none when it arrives. */
export function wiringProblems(deployment: DeploymentMail, wiring: MailWiring): readonly string[] {
  const problems: string[] = [];

  if (wiring.mx.length === 0 || !wiring.mx.every((host) => ROUTING_MX.test(host))) {
    problems.push(`${deployment.domain}'s MX (${wiring.mx.join(', ') || 'none'}) is not Cloudflare Email Routing's, so its mail goes elsewhere.`);
  }

  for (const { address, workers } of wiring.routes) {
    if (!workers.includes(deployment.worker)) {
      problems.push(`Email Routing hands ${address} to ${workers.join(', ') || 'no Worker'}, not ${deployment.worker}, so the deployment never reads it.`);
    }
  }

  for (const { address, username, held } of wiring.targets) {
    if (!held) problems.push(`${address} reaches ${username}, which has no box, so mail to it is refused.`);
  }

  for (const address of wiring.suppressed) {
    problems.push(`Email Sending has suppressed ${address} after a bounce or complaint, so sends to it are refused; lift it in the dashboard (Email, Email Sending, Suppression list).`);
  }

  return problems;
}

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

const ZonesSchema = v.object({ result: v.array(v.object({ id: v.string(), account: v.object({ id: v.string() }) })) });

const RuleSchema = v.object({
  enabled: v.boolean(),
  priority: v.optional(v.number()),
  matchers: v.array(v.object({ type: v.string(), field: v.optional(v.string()), value: v.optional(v.string()) })),
  actions: v.array(v.object({ type: v.string(), value: v.optional(v.array(v.string())) })),
});

type Rule = v.InferOutput<typeof RuleSchema>;

const MxSchema = v.object({ Answer: v.optional(v.array(v.object({ data: v.string() }))) });

const AvailabilitySchema = v.object({ refusal: v.nullable(v.string()) });

const SuppressionsSchema = v.object({ result: v.array(v.object({ email: v.string() })) });

/** One JSON read, its answer checked against `schema`; a refusal names what it was reading. */
async function readJson<T>(url: string, init: RequestInit, schema: v.GenericSchema<T>, reading: string): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) throw new Error(`reading ${reading}: ${String(response.status)} ${(await response.text()).slice(0, 300)}`);

  return v.parse(schema, await response.json());
}

/** The Workers a rule hands mail to: its `worker` actions' scripts. */
const workersOf = (rule: Rule | undefined): readonly string[] => rule?.actions.flatMap((action) => (action.type === 'worker' ? action.value ?? [] : [])) ?? [];

/**
 * Reads what `wiringProblems` judges. DNS from Cloudflare's resolver; Email Routing and Email Sending with `token`
 * (Email Routing read, Email Sending read); each box's existence from the deployment's own availability check, as
 * `headers` (the check's identity) may ask it.
 */
export async function readMailWiring(deployment: DeploymentMail, origin: string, headers: Record<string, string>, token: string): Promise<MailWiring> {
  const api = { headers: { authorization: `Bearer ${token}` } };
  const addresses = [...deployment.aliases].map(([label, username]) => ({ address: `${label}@${deployment.domain}`, username }));

  const mx = await readJson(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(deployment.domain)}&type=MX`, { headers: { accept: 'application/dns-json' } }, MxSchema, `${deployment.domain}'s MX`);

  const [zone] = (await readJson(`${CLOUDFLARE_API}/zones?name=${encodeURIComponent(deployment.zone)}`, api, ZonesSchema, `zone ${deployment.zone}`)).result;

  if (zone === undefined) throw new Error(`the token sees no zone ${deployment.zone}`);
  const rules = (await readJson(`${CLOUDFLARE_API}/zones/${zone.id}/email/routing/rules?per_page=50`, api, v.object({ result: v.array(RuleSchema) }), 'Email Routing rules')).result;
  const catchAll = (await readJson(`${CLOUDFLARE_API}/zones/${zone.id}/email/routing/rules/catch_all`, api, v.object({ result: RuleSchema }), 'the catch-all')).result;

  // Rules in Email Routing's order, lowest priority first; the catch-all where none matches.
  const ordered = rules.filter((rule) => rule.enabled).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  const routes = addresses.map(({ address }) => {
    const literal = ordered.find((rule) => rule.matchers.some((matcher) => matcher.type === 'literal' && matcher.field === 'to' && matcher.value?.toLowerCase() === address));

    return { address, workers: workersOf(literal ?? (catchAll.enabled ? catchAll : undefined)) };
  });

  const targets = await Promise.all(addresses.map(async ({ address, username }) => {
    const answer = await readJson(`${origin}/api/user/mail/address?username=${encodeURIComponent(username)}`, { headers }, AvailabilitySchema, `whether ${username} has a box`);

    return { address, username, held: answer.refusal === 'taken' };
  }));

  const suppressions = (await readJson(`${CLOUDFLARE_API}/accounts/${zone.account.id}/email/sending/suppressions?per_page=100`, api, SuppressionsSchema, 'Email Sending suppressions')).result;
  const suppressed = addresses.flatMap(({ address }) => (suppressions.some((entry) => entry.email.toLowerCase() === address) ? [address] : []));

  return { mx: (mx.Answer ?? []).map((answer) => answer.data.split(' ').at(-1) ?? ''), routes, targets, suppressed };
}
