// Mail on a subdomain of its zone (docs/MAIL.md §5). Email Routing's catch-all is the apex's alone, and a subdomain's
// addresses route only by literal rules (developers.cloudflare.com/email-service/configuration/subdomains/, read
// 2026-10-21), so the deployment makes a rule for each address as it makes the address, and deletes the rules under a
// root as the root is retired. Its grant, minted by the deploy run (`mailRoutingStep`), names the zone, this Worker,
// and a token that may edit that zone's routing rules and nothing else. Nothing here disables a zone's routing, and
// `bearerTransport` refuses the call that would.
import { Cause, Effect } from 'effect';
import * as v from 'valibot';
import { diagnostics, KinuError } from '../obs/index';
import { CloudflareApiError, bearerTransport, cloudflarePages, cloudflareResult, type CloudflareTransport } from './cloudflare';

/**
 * The zone, this Worker, the domain it was minted for, and the token; a null token where Cloudflare would not mint one,
 * so the deployment knows to refuse addresses it could not route rather than take itself for an apex.
 */
const MailRoutingGrantSchema = v.object({ zone: v.string(), worker: v.string(), domain: v.string(), token: v.nullable(v.string()) });

const GrantText = v.pipe(v.string(), v.parseJson(), MailRoutingGrantSchema);

type MailRoutingGrant = v.InferOutput<typeof MailRoutingGrantSchema>;

/** The grant as its secret holds it. */
export function mailRoutingGrant(grant: MailRoutingGrant): string {
  return JSON.stringify(grant);
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
  /** The grant these routes are made under, without its token: addresses routed under another are routed again. */
  readonly under: string;
  /** Each address routed to this Worker by a rule of its own: made where none is held, turned on where one is off. */
  routed(addresses: readonly string[]): Effect.Effect<void, KinuError>;
  /**
   * Every address under `root` unrouted: its own and each box's under it (`agent.workspace.root@domain`). A grant
   * Cloudflare no longer honours leaves them to the Worker, which refuses mail for a retired root.
   */
  unrouted(root: string, domain: string): Effect.Effect<void, KinuError>;
}

function routingRules(grant: MailRoutingGrant & { readonly token: string }, transport: CloudflareTransport): MailRoutes {
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
    under: `${grant.zone} ${grant.worker} ${grant.domain}`,
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
 * The deployment's routes for its mail `domain` from its `KINU_MAIL_ROUTING`. Null without one, or with one minted for
 * another domain: the domain is an apex, kinu.run's among them, whose catch-all routes every address. A grant that does
 * not read as one, or holds no token, refuses every new address rather than give out one that cannot receive; the
 * addresses already routed keep their rules, and a retirement goes on without deleting them, as for a grant Cloudflare
 * no longer honours.
 */
export function mailRoutesOf(held: string | undefined, domain: string, fetchImpl: typeof fetch = fetch): MailRoutes | null {
  if (held === undefined || held === '') return null;
  const grant = v.safeParse(GrantText, held);

  if (grant.success && grant.output.domain !== domain) return null;

  if (grant.success && grant.output.token !== null) return routingRules({ ...grant.output, token: grant.output.token }, bearerTransport(grant.output.token, fetchImpl));

  const unread = Effect.fail(new KinuError('unavailable', grant.success
    ? `Mail on ${domain} routes each address by a rule of its own, and Cloudflare would not mint this deployment the token to make one. Run the update and allow "Email Routing Rules".`
    : "This deployment's KINU_MAIL_ROUTING is not a routing grant, so no address can be routed."));

  const kept = (root: string, domainOf: string) => Effect.sync(() => {
    diagnostics.failure('mail.unroute_unhonoured', new KinuError('denied', `unrouting ${root}@${domainOf}: this deployment holds no routing token`));
  });

  return { under: '', routed: () => unread, unrouted: kept };
}
