// Mail on a subdomain of its zone (docs/MAIL.md §5). Email Routing's catch-all is the apex's alone, and a subdomain's
// addresses route only by literal rules (developers.cloudflare.com/email-service/configuration/subdomains/, read
// 2026-10-21), so the deployment makes a rule for each address as it makes the address, and deletes the rules under a
// root as the root is retired. It reads what the deployment already holds: its zone (`KINU_MAIL_ZONE`, which the deploy
// run sets where the mail domain is a subdomain, empty on an apex), its mail domain (`EMAIL_DOMAIN`), its own Worker's
// name (the self-deploy record) and the token the run mints for that zone, which may edit its routing rules and nothing
// else (`KINU_MAIL_ROUTING_TOKEN`). Nothing here disables a zone's routing, and `bearerTransport` refuses the call that
// would.
import { Cause, Effect } from 'effect';
import * as v from 'valibot';
import { diagnostics, KinuError } from '../obs/index';
import { CloudflareApiError, bearerTransport, cloudflarePages, cloudflareResult, type CloudflareTransport } from './cloudflare';
import { DeploymentRecordSchema } from './inputs';

/** What the deployment holds that its routing reads. */
export interface MailRoutingEnv {
  readonly KINU_MAIL_ZONE?: string;
  readonly KINU_MAIL_ROUTING_TOKEN?: string;
  readonly KINU_DEPLOYMENT_RECORD?: string;
  readonly EMAIL_DOMAIN?: string;
}

const RecordText = v.pipe(v.string(), v.parseJson(), DeploymentRecordSchema);

interface MailRoutingGrant {
  readonly zone: string;
  readonly worker: string;
  readonly domain: string;
  readonly token: string;
}

const RuleSchema = v.object({
  id: v.string(),
  enabled: v.optional(v.boolean()),
  matchers: v.array(v.object({ type: v.string(), field: v.optional(v.string()), value: v.optional(v.string()) })),
  actions: v.array(v.object({ type: v.string(), value: v.optional(v.array(v.string())) })),
});

type Rule = v.InferOutput<typeof RuleSchema>;

/** The one address a rule matches, where it matches one. */
function literalTo(rule: Rule): string | null {
  const [matcher] = rule.matchers;

  if (rule.matchers.length !== 1 || matcher?.type !== 'literal' || matcher.field !== 'to') return null;

  return matcher.value?.toLowerCase() ?? null;
}

const workerOf = (rule: Rule): string | undefined => rule.actions.find((action) => action.type === 'worker')?.value?.[0];

/** Cloudflare's refusal as the call's, in its words: the 201st rule on a domain is refused this way. */
function refused<A>(doing: string, work: Effect.Effect<A, KinuError>): Effect.Effect<A, KinuError> {
  return work.pipe(Effect.catchCause((failed) => {
    const cause = Cause.squash(failed);

    if (!(cause instanceof CloudflareApiError)) return Effect.failCause(failed);

    return Effect.fail(new KinuError(cause.status >= 500 ? 'unavailable' : 'denied', `${doing}: Cloudflare answered: ${cause.detail}`, { cause }));
  }));
}

export interface MailRoutes {
  /** The grant these routes are made under, without its token: addresses routed under another are routed again. Empty
   *  for a grant that does not read as one. */
  readonly under: string;
  /** Each address routed to this Worker by a rule of its own: made where none is held, turned on where one is off. */
  routed(addresses: readonly string[]): Effect.Effect<void, KinuError>;
  /**
   * Every address under `root` unrouted: its own and each box's under it (`agent.workspace.root@domain`). A grant
   * Cloudflare no longer honours leaves them to the Worker, which refuses mail for a retired root.
   */
  unrouted(root: string, domain: string): Effect.Effect<void, KinuError>;
}

function routingRules(grant: MailRoutingGrant, transport: CloudflareTransport): MailRoutes {
  const path = `/zones/${grant.zone}/email/routing/rules`;
  const rules = Effect.promise(async () => cloudflarePages(transport, path, RuleSchema));
  const rule = (to: string) => ({ name: `Kinu ${to}`, enabled: true, matchers: [{ type: 'literal', field: 'to', value: to }], actions: [{ type: 'worker', value: [grant.worker] }] });

  const routedOne = (listed: readonly Rule[], address: string) => refused(`routing ${address}`, Effect.gen(function* () {
    const wanted = address.toLowerCase();
    const held = listed.find((each) => literalTo(each) === wanted);

    if (held !== undefined && workerOf(held) !== grant.worker) {
      return yield* Effect.fail(new KinuError('denied', `${address} already routes to ${workerOf(held) ?? 'something other than a Worker'}.`));
    }

    if (held?.enabled !== false && held !== undefined) return;

    // A rule of this Worker's that is off routes nothing: it is turned on, never made twice.
    yield* Effect.promise(async () => cloudflareResult(transport, held === undefined
      ? { method: 'POST', path, body: rule(wanted) }
      : { method: 'PUT', path: `${path}/${held.id}`, body: rule(wanted) }, v.unknown()));
  }));

  return {
    under: `${grant.zone} ${grant.domain}`,
    routed: (addresses) => (addresses.length === 0 ? Effect.void : Effect.gen(function* () {
      const listed = yield* refused(`routing ${addresses.join(', ')}`, rules);

      for (const address of addresses) yield* routedOne(listed, address);
    })),

    unrouted: (root, domain) => refused(`unrouting ${root}@${domain}`, Effect.gen(function* () {
      const own = `${root}@${domain}`.toLowerCase();
      const under = (to: string | null) => to !== null && (to === own || to.endsWith(`.${own}`));
      const listed = yield* rules.pipe(Effect.map((all) => all.filter((each) => under(literalTo(each)) && workerOf(each) === grant.worker)));

      for (const each of listed) yield* Effect.promise(async () => cloudflareResult(transport, { method: 'DELETE', path: `${path}/${each.id}` }, v.unknown()));
    }).pipe(Effect.catchCause((failed) => {
      const cause = Cause.squash(failed);

      if (!(cause instanceof CloudflareApiError) || (cause.status !== 401 && cause.status !== 403)) return Effect.failCause(failed);
      diagnostics.failure('mail.unroute_unhonoured', new KinuError('denied', `unrouting ${root}@${domain}: Cloudflare no longer honours the grant`, { cause }));

      return Effect.void;
    }))),
  };
}

/**
 * The deployment's routes. Null where its mail is on its zone's apex, or off: the catch-all routes every address, and
 * nothing is made or deleted (kinu.run's is one). On a subdomain without the token Cloudflare would not mint, or
 * without the record naming its Worker, every new address is refused rather than given out unable to receive; the
 * addresses already routed keep their rules, and a retirement goes on without deleting them, as for a grant Cloudflare
 * no longer honours.
 */
export function mailRoutesOf(env: MailRoutingEnv, fetchImpl: typeof fetch = fetch): MailRoutes | null {
  const zone = env.KINU_MAIL_ZONE ?? '';
  const domain = env.EMAIL_DOMAIN ?? '';

  if (zone === '' || domain === '') return null;
  const record = v.safeParse(RecordText, env.KINU_DEPLOYMENT_RECORD ?? '');
  const worker = record.success ? record.output.inputs.instanceName : '';
  const token = env.KINU_MAIL_ROUTING_TOKEN ?? '';

  if (worker !== '' && token !== '') return routingRules({ zone, worker, domain, token }, bearerTransport(token, fetchImpl));

  const unread = Effect.fail(new KinuError('unavailable', token === ''
    ? `Mail on ${domain} routes each address by a rule of its own, and Cloudflare would not mint this deployment the token to make one. Run the update and allow "Email Routing Rules".`
    : `Mail on ${domain} routes each address by a rule naming this deployment's Worker, and it holds no self-deploy record naming it.`));

  const kept = (root: string, domainOf: string) => Effect.sync(() => {
    diagnostics.failure('mail.unroute_unhonoured', new KinuError('denied', `unrouting ${root}@${domainOf}: this deployment cannot make or delete a rule`));
  });

  // Its identity kept: addresses last routed under another zone or domain are refused with the rest, not given out unrouted.
  return { under: `${zone} ${domain}`, routed: (addresses) => (addresses.length === 0 ? Effect.void : unread), unrouted: kept };
}
