// The page's reads of a person's Cloudflare account (docs/SELF-DEPLOY-FLOW.md § 4, § 5): who they are, what the account
// holds, which Kinus it already runs, and the answers a run there starts from. Everything here reads, except
// `plannedRun`, which makes only what a run cannot begin without: a workers.dev subdomain, and the zone for a domain
// registered elsewhere.
import { Cause, Effect } from 'effect';
import * as v from 'valibot';
import { diagnostics, KinuError } from '../obs/index';
import { CloudflareApiError, cloudflarePages, cloudflareResult, type CloudflareTransport } from './cloudflare';
import { frontWorkerName } from './front';
import { CreditBalanceSchema, GatewayCreditsSchema, creditBalancePath, creditsOf, type GatewayCredits } from '../providers/gateway-credits';
import type { HttpGet } from './context';
import type { DeployChoice } from './door';
import {
  DEFAULT_INSTANCE_NAME, DEPLOYMENT_RECORD_SECRET, DEPLOYMENT_REFRESH_SECRET, DeployInputsSchema, FIRST_OWNER_LINK_SECRET,
  CREDITS_TOKEN_SECRET, GITHUB_APP_SECRETS, INSTANCE_NAME, MAIL_ROUTING_SECRET, MINTED_SECRETS,
  type DeployAddress, type DeployInputs,
} from './inputs';
import type { DeployPhaseId, DeployRunViewState } from './phases';
import { CloudflareWordsSchema, DeployNeedSchema, causeWords, heard, judgeRefusal, type CloudflareWords, type DeployNeed } from './refusals';
import { HealthAnswerSchema, UpdateOfferSchema, updateOffer, type UpdateBuild, type UpdateOffer } from './update';

export interface CloudflareUser {
  readonly id: string;
  readonly email: string;
}

const UserSchema = v.object({ id: v.pipe(v.string(), v.minLength(1)), email: v.string() });

const ChoiceSchema = v.object({ id: v.string(), name: v.string() });

const ChoicesSchema = v.array(ChoiceSchema);

export interface DeployZone {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'pending';
}

/** A zone with the nameservers Cloudflare assigned it: what a registrar elsewhere must be told. */
export interface DeployHeldZone extends DeployZone {
  readonly nameservers: readonly string[];
}

const ZoneSchema = v.object({ id: v.string(), name: v.string(), status: v.optional(v.string()), name_servers: v.optional(v.array(v.string())) });

export interface DeployPreflight {
  /** Null: the account has none yet, and the run makes one. */
  readonly workersSubdomain: string | null;
  /** Free in this account now; a run that finds it taken by then takes the next free one and says so. */
  readonly suggestedName: string;
  readonly r2: 'on' | 'off';
  /** Read from the Containers API (`workersPlan`); "unknown" when that read was refused for another reason. */
  readonly plan: 'free' | 'paid' | 'unknown';
  readonly zones: readonly DeployZone[];
  /** The plan first, and blocking; a run starts only on an account with none (deploy/routes.ts `beginRun`). */
  readonly needs: readonly DeployNeed[];
  /** What the deployment's web searches are paid from; null where Cloudflare would not say. Never a need: search is
   *  one of its tools, and a key of the person's own pays for it as well. */
  readonly credits: GatewayCredits | null;
  readonly checkedAt: string;
}

/** "yours": a zone of this account. "elsewhere": not one, so a run adds it as a zone and waits for its nameservers.
 *  Whether a name is free to buy needs Registrar's search, which is unmeasured (§ 11). */
export interface DeployDomain {
  readonly name: string;
  readonly state: 'yours' | 'elsewhere';
  readonly zone?: string;
  readonly status?: 'active' | 'pending';
}

/** A Kinu the account already runs: a Worker carrying the deployment record a run's handover writes, whichever door ran it. */
export interface DeployedKinu {
  readonly account: string;
  readonly name: string;
  readonly url: string;
  readonly update: UpdateOffer;
  /** Whether its GitHub plugin has a client of its own (`github-app.ts`). */
  readonly github: boolean;
}

const ZoneStatusSchema = v.picklist(['active', 'pending']);

export const DeployPreflightSchema: v.GenericSchema<DeployPreflight> = v.object({
  workersSubdomain: v.nullable(v.string()),
  suggestedName: v.string(),
  r2: v.picklist(['on', 'off']),
  plan: v.picklist(['free', 'paid', 'unknown']),
  zones: v.array(v.object({ id: v.string(), name: v.string(), status: ZoneStatusSchema })),
  needs: v.array(DeployNeedSchema),
  credits: v.nullable(GatewayCreditsSchema),
  checkedAt: v.string(),
});

export const DeployDomainsSchema: v.GenericSchema<readonly DeployDomain[]> = v.array(v.object({
  name: v.string(), state: v.picklist(['yours', 'elsewhere']), zone: v.optional(v.string()), status: v.optional(ZoneStatusSchema),
}));

/** `GET /api/deploy/session`: who is signed in, the run they left unfinished, and the Kinus their accounts run. */
export interface DeploySession {
  readonly signedIn: boolean;
  readonly email: string;
  readonly accounts: readonly DeployChoice[];
  readonly resume: { readonly runId: string; readonly account: string; readonly phase: DeployPhaseId; readonly state: DeployRunViewState } | null;
  readonly deployments: readonly DeployedKinu[];
  /** Accounts whose Kinus Cloudflare would not list, in its words. */
  readonly unreadable: readonly { readonly account: string; readonly words: CloudflareWords }[];
}

export const DeploySessionSchema: v.GenericSchema<DeploySession> = v.object({
  signedIn: v.boolean(),
  email: v.string(),
  accounts: ChoicesSchema,
  resume: v.nullable(v.object({
    runId: v.string(),
    account: v.string(),
    phase: v.picklist(['prepare', 'storage', 'upload', 'address', 'mail', 'check', 'live']),
    state: v.picklist(['running', 'paused', 'refused', 'live']),
  })),
  deployments: v.array(v.object({ account: v.string(), name: v.string(), url: v.string(), update: UpdateOfferSchema, github: v.boolean() })),
  unreadable: v.array(v.object({ account: v.string(), words: CloudflareWordsSchema })),
});

const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/u;

const ZONE_ID = /^[0-9a-f]{32}$/u;

const AccountIdSchema = v.pipe(v.string(), v.regex(ZONE_ID));

const HostSchema = v.pipe(v.string(), v.regex(DOMAIN));

const AddressAskSchema = v.variant('kind', [
  v.object({ kind: v.literal('workers') }),
  v.object({ kind: v.literal('domain'), zone: v.optional(v.pipe(v.string(), v.regex(ZONE_ID))), domain: v.optional(HostSchema), host: HostSchema }),
]);

type AddressAsk = v.InferOutput<typeof AddressAskSchema>;

const MailAskSchema = v.nullable(v.object({ host: HostSchema }));

/** What `POST /api/deploy/runs` takes from the page: a new Kinu, a change to one, or an update of one in place. */
export const DeployRunRequestSchema = v.variant('kind', [
  v.object({
    kind: v.literal('new'), account: AccountIdSchema, name: v.pipe(v.string(), v.regex(INSTANCE_NAME)),
    address: AddressAskSchema, computer: v.boolean(), mail: MailAskSchema,
  }),
  v.object({
    kind: v.literal('change'), account: AccountIdSchema, name: v.pipe(v.string(), v.regex(INSTANCE_NAME)),
    address: v.optional(AddressAskSchema), mail: v.optional(MailAskSchema), setupLink: v.optional(v.literal(true)),
  }),
  v.object({ kind: v.literal('update'), account: AccountIdSchema, name: v.pipe(v.string(), v.regex(INSTANCE_NAME)) }),
]);

export type DeployRunRequest = v.InferOutput<typeof DeployRunRequestSchema>;

/** A zone the run added and waits on: it deploys on workers.dev meanwhile, and moves onto `host` once the zone is active. */
export interface DeployPendingZone {
  readonly zoneId: string;
  readonly domain: string;
  readonly host: string;
  readonly nameservers: readonly string[];
}

/** What a run begins with: its answers, and how they came about. Held in the run's storage; no secret. */
export interface DeployRunPlan {
  readonly kind: 'new' | 'change' | 'update';
  readonly inputs: DeployInputs;
  /** The name asked for, when the run took the next free one instead; else empty. */
  readonly renamedFrom: string;
  readonly freshSetupLink: boolean;
  readonly pending: DeployPendingZone | null;
}

export const DeployRunPlanSchema: v.GenericSchema<DeployRunPlan> = v.object({
  kind: v.picklist(['new', 'change', 'update']),
  inputs: DeployInputsSchema,
  renamedFrom: v.string(),
  freshSetupLink: v.boolean(),
  pending: v.nullable(v.object({ zoneId: v.string(), domain: v.string(), host: v.string(), nameservers: v.array(v.string()) })),
});

export function cloudflareUser(transport: CloudflareTransport): Effect.Effect<CloudflareUser> {
  return Effect.promise(async () => cloudflareResult(transport, { method: 'GET', path: '/user' }, UserSchema));
}

export function accountChoices(transport: CloudflareTransport): Effect.Effect<readonly DeployChoice[]> {
  return Effect.promise(async () => cloudflarePages(transport, '/accounts', ChoiceSchema));
}

function zonesOf(transport: CloudflareTransport, account: string): Effect.Effect<readonly DeployZone[]> {
  return Effect.promise(async () => {
    const zones = await cloudflarePages(transport, `/zones?account.id=${account}`, ZoneSchema);

    return zones.map((zone) => heldZone(zone));
  });
}

export function zoneHeld(transport: CloudflareTransport, zoneId: string): Effect.Effect<DeployHeldZone> {
  return Effect.promise(async () => heldZone(await cloudflareResult(transport, { method: 'GET', path: `/zones/${zoneId}` }, ZoneSchema)));
}

/** Cloudflare's statuses beyond these two (`initializing`, `moved`) cannot serve a custom domain yet either. */
function heldZone(zone: v.InferOutput<typeof ZoneSchema>): DeployHeldZone {
  return { id: zone.id, name: zone.name, status: zone.status === 'active' ? 'active' : 'pending', nameservers: zone.name_servers ?? [] };
}

/** The domain as a zone of this account: the one it has, else added (`POST /zones`, which DNS write allows). */
function zoneAdded(transport: CloudflareTransport, account: string, domain: string): Effect.Effect<DeployHeldZone> {
  return Effect.promise(async () => {
    const held = await cloudflareResult(
      transport, { method: 'GET', path: `/zones?name=${encodeURIComponent(domain)}&account.id=${account}` }, v.array(ZoneSchema),
    );

    const found = held.find((zone) => zone.name === domain);

    if (found !== undefined) return heldZone(found);

    return heldZone(await cloudflareResult(
      transport, { method: 'POST', path: '/zones', body: { name: domain, account: { id: account }, type: 'full' } }, ZoneSchema,
    ));
  });
}

/** The script names in the account: a Worker's `id` is its name. */
function workerNames(transport: CloudflareTransport, account: string): Effect.Effect<readonly string[]> {
  return Effect.promise(async () => {
    const scripts = await cloudflareResult(transport, { method: 'GET', path: `/accounts/${account}/workers/scripts` }, v.array(v.object({ id: v.string() })));

    return scripts.map((script) => script.id);
  });
}

/** `wanted`, else `wanted-2`, `wanted-3` …: the first the account does not hold. */
/** A name free with its front's (front.ts): a deployment on its own domain is two Workers, and either may be made. */
function freeWorkerName(names: readonly string[], wanted: string): string {
  let candidate = wanted;

  for (let next = 2; names.includes(candidate) || names.includes(frontWorkerName(candidate)); next += 1) candidate = `${wanted}-${String(next)}`;

  return candidate;
}

/** Null when the account has none yet; Cloudflare answers that 404 (unmeasured: an empty name reads the same). */
function workersSubdomain(transport: CloudflareTransport, account: string): Effect.Effect<string | null> {
  const read = Effect.promise(async () => cloudflareResult(
    transport, { method: 'GET', path: `/accounts/${account}/workers/subdomain` }, v.object({ subdomain: v.nullish(v.string()) }),
  ));

  const none = (failed: Cause.Cause<KinuError>) => Cause.squash(failed) instanceof CloudflareApiError && v.is(v.object({ status: v.literal(404) }), Cause.squash(failed));

  return read.pipe(
    Effect.map((held) => (held.subdomain === undefined || held.subdomain === null || held.subdomain === '' ? null : held.subdomain)),
    Effect.catchCause((failed) => (none(failed) ? Effect.succeed(null) : Effect.failCause(failed))),
  );
}

/** A read whose refusal the catalog calls a need: that need. Any other refusal fails on as it came. */
function needOr<A>(read: Effect.Effect<A, KinuError>, account: string): Effect.Effect<{ readonly answer: A } | { readonly need: DeployNeed }, KinuError> {
  return read.pipe(
    Effect.map((answer) => ({ answer })),
    Effect.catchCause((failed) => {
      const judged = judgeRefusal(causeWords(failed), account);

      return 'need' in judged ? Effect.succeed({ need: judged.need }) : Effect.failCause(failed);
    }),
  );
}

/**
 * Workers Paid or Free, as Cloudflare's Containers answer says. Kinu needs Paid: its agents run in Dynamic Workers, which
 * Free refuses (10195 at the upload), and on Free Cloudflare refuses the Containers list, 401 with code 1000 ("Deploying
 * containers requires the Workers Paid plan", the owner's free account, 2026-10-21), the read this takes as the plan. On
 * Free it answers the plan need, in those words. Any other refusal, a sign-in without containers.write among them,
 * leaves the plan unknown: the upload then says it, if it must.
 */
export function workersPlan(transport: CloudflareTransport, account: string): Effect.Effect<{ readonly plan: DeployPreflight['plan']; readonly need: DeployNeed | null }> {
  return Effect.promise(async () => cloudflareResult(transport, { method: 'GET', path: `/accounts/${account}/containers/applications` }, v.unknown())).pipe(
    Effect.map(() => ({ plan: 'paid' as const, need: null })),
    Effect.catchCause((failed) => {
      const words = causeWords(failed);
      const judged = words.status === 401 && words.code === 1000 ? judgeRefusal(words, account) : null;

      return Effect.succeed(judged !== null && 'need' in judged ? { plan: 'free' as const, need: judged.need } : { plan: 'unknown' as const, need: null });
    }),
  );
}

/** The account's AI Gateway credits, or null for any refusal, as a sign-in without `aig.write` meets; its words logged. */
function gatewayCredits(transport: CloudflareTransport, account: string): Effect.Effect<GatewayCredits | null> {
  return Effect.promise(async () => cloudflareResult(transport, { method: 'GET', path: creditBalancePath(account) }, CreditBalanceSchema)).pipe(
    Effect.map(creditsOf),
    Effect.catchCause((failed) => {
      const words = causeWords(failed);

      diagnostics.event('deploy.credits_unread', { status: words.status ?? 0, code: words.code ?? 0, message: words.message });

      return Effect.succeed(null);
    }),
  );
}

/** The checklist of § 4, read together; none of it writes. A need is said once however many reads met it. */
export function preflight(transport: CloudflareTransport, account: string, now: number): Effect.Effect<DeployPreflight, KinuError> {
  return Effect.gen(function* () {
    // Six reads of one account, none waiting on another: asked at once, the page's check takes the slowest one's time.
    const { subdomain, names, r2, zones, planRead, credits } = yield* Effect.all({
      subdomain: needOr(workersSubdomain(transport, account), account),
      names: needOr(workerNames(transport, account), account),
      r2: needOr(Effect.promise(async () => cloudflareResult(
        transport, { method: 'GET', path: `/accounts/${account}/r2/buckets?per_page=1` }, v.unknown(),
      )), account),
      zones: needOr(zonesOf(transport, account), account),
      planRead: workersPlan(transport, account),
      credits: gatewayCredits(transport, account),
    }, { concurrency: 'unbounded' });

    const { plan, need: planNeed } = planRead;
    const needs = new Map<string, DeployNeed>();

    // A Free account is told first: nothing else it is asked to do lets Kinu run there.
    if (planNeed !== null) needs.set(planNeed.id, planNeed);

    for (const read of [subdomain, names, r2, zones]) {
      if ('need' in read && !needs.has(read.need.id)) needs.set(read.need.id, read.need);
    }

    return {
      workersSubdomain: 'answer' in subdomain ? subdomain.answer : null,
      // Free only as far as the account says: no name is suggested while its Workers cannot be listed.
      suggestedName: 'answer' in names ? freeWorkerName(names.answer, DEFAULT_INSTANCE_NAME) : '',
      r2: 'answer' in r2 ? 'on' : 'off',
      plan,
      zones: 'answer' in zones ? zones.answer : [],
      needs: [...needs.values()],
      credits,
      checkedAt: new Date(now).toISOString(),
    };
  });
}

/** What was typed, as a name: its URL's host as RFC 3986 bounds it, without scheme, sign-in, port, path or trailing dot. */
function typedDomain(query: string): string {
  const rest = query.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//u, '');
  const authority = rest.split(/[/?#]/u)[0] ?? '';

  return authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/u, '').replace(/\.$/u, '');
}

/** The account's zones the query names or sits under, and the query itself as "elsewhere" when no zone holds it. */
export function domainsMatching(transport: CloudflareTransport, account: string, query: string): Effect.Effect<readonly DeployDomain[]> {
  return Effect.gen(function* () {
    const typed = typedDomain(query);
    const zones = yield* zonesOf(transport, account);
    const under = (zone: DeployZone): boolean => typed === zone.name || typed.endsWith(`.${zone.name}`);

    const yours = zones
      .filter((zone) => typed === '' || zone.name.includes(typed) || under(zone))
      .map((zone): DeployDomain => ({ name: zone.name, state: 'yours', zone: zone.id, status: zone.status }));

    if (!DOMAIN.test(typed) || zones.some(under)) return yours;

    return [...yours, { name: typed, state: 'elsewhere' }];
  });
}

const BindingsSchema = v.object({
  bindings: v.optional(v.array(v.object({ type: v.string(), name: v.string(), text: v.optional(v.string()), class_name: v.optional(v.string()) }))),
});

type ScriptBinding = NonNullable<v.InferOutput<typeof BindingsSchema>['bindings']>[number];

/** `GET …/workers/scripts/{s}/settings` answers the script's bindings: plain-text vars with their text, secrets by name only. */
export function scriptBindings(transport: CloudflareTransport, account: string, script: string): Effect.Effect<readonly ScriptBinding[]> {
  return Effect.promise(async () => {
    const settings = await cloudflareResult(transport, { method: 'GET', path: `/accounts/${account}/workers/scripts/${script}/settings` }, BindingsSchema);

    return settings.bindings ?? [];
  });
}

export function varsOf(bindings: readonly ScriptBinding[]): ReadonlyMap<string, string> {
  return new Map(bindings.filter((binding) => binding.type === 'plain_text').map((binding) => [binding.name, binding.text ?? '']));
}

const madeByARun = (bindings: readonly ScriptBinding[]): boolean => bindings.some((binding) => binding.name === DEPLOYMENT_RECORD_SECRET);

/** Every Kinu in the account, with what it would be offered: its own build read off `/api/health`, beside `available`. */
export function deployedKinus(
  transport: CloudflareTransport,
  account: string,
  channel: { readonly http: HttpGet; readonly origin: string; readonly available: UpdateBuild | null },
): Effect.Effect<readonly DeployedKinu[]> {
  return Effect.gen(function* () {
    const names = yield* workerNames(transport, account);
    const settings = yield* Effect.forEach(names, (name) => scriptBindings(transport, account, name), { concurrency: 4 });

    const made = names.flatMap((name, at) => {
      const bindings = settings[at] ?? [];

      return madeByARun(bindings)
        ? [{ name, url: varsOf(bindings).get('CLI_PUBLIC_ORIGIN') ?? '', github: bindings.some((binding) => binding.name === GITHUB_APP_SECRETS.id) }]
        : [];
    });

    return yield* Effect.forEach(made, (kinu) => Effect.map(servedBuild(channel.http, kinu.url), (current): DeployedKinu => ({
      account,
      name: kinu.name,
      url: kinu.url,
      update: updateOffer({ current, available: channel.available, channelOrigin: channel.origin, owned: true }),
      github: kinu.github,
    })), { concurrency: 4 });
  });
}

/** The build a deployment answers `/api/health` with; null when it does not answer one. */
function servedBuild(http: HttpGet, url: string): Effect.Effect<UpdateBuild | null> {
  const read = Effect.promise(async () => {
    const response = await http(`${url}/api/health`);

    return response.ok ? v.parse(HealthAnswerSchema, await response.json()).build : null;
  });

  return Effect.map(heard(read), (answered) => ('answer' in answered ? answered.answer : null));
}

/** Names a run binds for itself; any other secret on the Worker is a provider key its owner gave. */
const RUN_SECRETS: readonly string[] = [...MINTED_SECRETS, FIRST_OWNER_LINK_SECRET, DEPLOYMENT_RECORD_SECRET, DEPLOYMENT_REFRESH_SECRET, MAIL_ROUTING_SECRET, CREDITS_TOKEN_SECRET];

/**
 * A deployment's answers, read back from the account rather than from its record (a secret, which Cloudflare never
 * answers): the vars a run derived from them (`derivedVar` in steps.ts), its Durable Object classes and its secrets'
 * names. Null when the Worker carries no deployment record, so no run made it.
 */
function deployedInputs(transport: CloudflareTransport, account: string, name: string): Effect.Effect<DeployInputs | null, KinuError> {
  return Effect.gen(function* () {
    const bindings = yield* scriptBindings(transport, account, name);

    if (!madeByARun(bindings)) return null;
    const vars = varsOf(bindings);
    const host = /^https:\/\/([a-z0-9.-]+)\/?$/u.exec(vars.get('CLI_PUBLIC_ORIGIN') ?? '')?.[1];

    if (host === undefined) return yield* new KinuError('bad_input', `${name} names no address of its own (CLI_PUBLIC_ORIGIN), so its answers cannot be read back.`);
    const address = yield* addressServing(transport, account, host);

    const read = v.safeParse(DeployInputsSchema, {
      accountId: account,
      instanceName: name,
      address,
      ownerEmail: (vars.get('CONTROL_PLANE_ADMINS') ?? '').split(',')[0]?.trim() ?? '',
      providerKeyNames: bindings.filter((binding) => binding.type === 'secret_text' && !RUN_SECRETS.includes(binding.name)).map((binding) => binding.name),
      sandbox: bindings.some((binding) => binding.type === 'durable_object_namespace' && binding.class_name === 'KinuDevbox'),
      mailDomain: vars.get('EMAIL_DOMAIN') ?? '',
      mailAccounts: vars.get('MAIL_ACCOUNTS') === 'everyone' ? 'everyone' : 'operators',
    });

    if (!read.success) return yield* new KinuError('bad_input', `${name}'s settings do not read back as a deployment: ${read.issues[0]?.message ?? 'unreadable'}.`);

    return read.output;
  });
}

/** workers.dev, or the account's zone the host sits in. */
function addressServing(transport: CloudflareTransport, account: string, host: string): Effect.Effect<DeployAddress, KinuError> {
  return Effect.gen(function* () {
    if (host.endsWith('.workers.dev')) return { kind: 'workers-dev', hostname: '', zoneId: '' };
    const zone = (yield* zonesOf(transport, account)).find((each) => host === each.name || host.endsWith(`.${each.name}`));

    if (zone === undefined) return yield* new KinuError('bad_input', `${host} is not in a zone of this account, so the deployment's address cannot be kept.`);

    return { kind: 'zone', hostname: host, zoneId: zone.id };
  });
}

/** The workers.dev subdomain a workers.dev address needs: the account's, else one made from its name. A refusal stands
 *  in Cloudflare's own words (its code reaches the catalog, 10063 among them), with no second guess at another name. */
function subdomainHeld(transport: CloudflareTransport, account: string): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const held = yield* workersSubdomain(transport, account);

    if (held !== null) return held;
    const named = yield* Effect.promise(async () => cloudflareResult(transport, { method: 'GET', path: `/accounts/${account}` }, v.object({ name: v.optional(v.string()) })));
    const slug = (named.name ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || DEFAULT_INSTANCE_NAME;

    const made = yield* Effect.promise(async () => cloudflareResult(
      transport, { method: 'PUT', path: `/accounts/${account}/workers/subdomain`, body: { subdomain: slug } }, v.object({ subdomain: v.string() }),
    ));

    return made.subdomain;
  });
}

/** Where the run will answer. A zone that is not active yet (or a domain added just now) is pending: the run deploys on
 *  workers.dev and moves onto the host once the zone is active. */
function addressFor(
  transport: CloudflareTransport,
  account: string,
  asked: AddressAsk,
): Effect.Effect<{ readonly address: DeployAddress; readonly pending: DeployPendingZone | null }, KinuError> {
  return Effect.gen(function* () {
    const workers: DeployAddress = { kind: 'workers-dev', hostname: '', zoneId: '' };

    if (asked.kind === 'workers') {
      yield* subdomainHeld(transport, account);

      return { address: workers, pending: null };
    }

    const zone = asked.zone === undefined
      ? yield* zoneAdded(transport, account, asked.domain ?? asked.host)
      : yield* zoneHeld(transport, asked.zone);

    if (asked.host !== zone.name && !asked.host.endsWith(`.${zone.name}`)) {
      return yield* new KinuError('bad_input', `${asked.host} is not on ${zone.name}.`);
    }

    if (zone.status === 'active') return { address: { kind: 'zone', hostname: asked.host, zoneId: zone.id }, pending: null };
    yield* subdomainHeld(transport, account);

    return { address: workers, pending: { zoneId: zone.id, domain: zone.name, host: asked.host, nameservers: zone.nameservers } };
  });
}

/**
 * The run a request asks for. A new Kinu takes the person's Cloudflare email as its owner's and the next free name if
 * its own was taken since preflight; a change or an update starts from the deployment's answers as the account holds
 * them, so the same plan runs over it with the root secrets kept.
 */
export function plannedRun(transport: CloudflareTransport, user: CloudflareUser, request: DeployRunRequest): Effect.Effect<DeployRunPlan, KinuError> {
  return Effect.gen(function* () {
    if (request.kind === 'new') {
      const name = freeWorkerName(yield* workerNames(transport, request.account), request.name);
      const placed = yield* addressFor(transport, request.account, request.address);

      const asked: DeployInputs = {
        accountId: request.account, instanceName: name, address: placed.address, ownerEmail: user.email,
        providerKeyNames: [], sandbox: request.computer, mailDomain: request.mail?.host ?? '',
      };

      const inputs = v.parse(DeployInputsSchema, asked);

      return { kind: 'new', inputs, renamedFrom: name === request.name ? '' : request.name, freshSetupLink: false, pending: placed.pending };
    }

    const held = yield* deployedInputs(transport, request.account, request.name);

    if (held === null) return yield* new KinuError('missing', `This account runs no Kinu named ${request.name} that the deploy flow made.`);

    if (request.kind === 'update') return { kind: 'update', inputs: held, renamedFrom: '', freshSetupLink: false, pending: null };
    const placed = request.address === undefined ? { address: held.address, pending: null } : yield* addressFor(transport, request.account, request.address);
    const mailDomain = request.mail === undefined ? held.mailDomain : request.mail?.host ?? '';

    return {
      kind: 'change',
      inputs: v.parse(DeployInputsSchema, { ...held, address: placed.address, mailDomain }),
      renamedFrom: '',
      freshSetupLink: request.setupLink === true,
      pending: placed.pending,
    };
  });
}
