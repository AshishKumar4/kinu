// Mail on a subdomain of its zone (docs/MAIL.md §5). Email Routing's catch-all is the apex's alone, and a subdomain's
// addresses route only by literal rules (developers.cloudflare.com/email-service/configuration/subdomains/, read
// 2026-10-21), so the deployment makes a rule for each address as it makes the address, and deletes the rules under a
// root as the root is retired. Its grant, minted by the deploy run (`mailRoutingStep`), names the zone, this Worker,
// and a token that may edit that zone's routing rules and nothing else. Nothing here disables a zone's routing, and
// `bearerTransport` refuses the call that would.
import { Cause, Effect } from 'effect';
import * as v from 'valibot';
import { diagnostics, KinuError } from '../obs/index';
import { CloudflareApiError, cloudflarePages, cloudflareResult, type CloudflareTransport } from './cloudflare';

export const MailRoutingGrantSchema = v.object({ zone: v.string(), worker: v.string(), token: v.string() });

export type MailRoutingGrant = v.InferOutput<typeof MailRoutingGrantSchema>;

/** The grant as its secret holds it. */
export function mailRoutingGrant(grant: MailRoutingGrant): string {
  return JSON.stringify(grant);
}

const RuleSchema = v.object({
  id: v.string(),
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
  /** `address` routed to this Worker by a rule of its own, made unless one is held. */
  routed(address: string): Effect.Effect<void, KinuError>;
  /**
   * Every address under `root` unrouted: its own and each box's under it (`agent.workspace.root@domain`). A grant
   * Cloudflare no longer honours leaves them to the Worker, which refuses mail for a retired root.
   */
  unrouted(root: string, domain: string): Effect.Effect<void, KinuError>;
}

export function mailRoutes(grant: MailRoutingGrant, transport: CloudflareTransport): MailRoutes {
  const path = `/zones/${grant.zone}/email/routing/rules`;
  const rules = Effect.promise(async () => cloudflarePages(transport, path, RuleSchema));

  return {
    routed: (address) => refused(`routing ${address}`, Effect.gen(function* () {
      const wanted = address.toLowerCase();
      const held = (yield* rules).find((rule) => literalTo(rule) === wanted);

      if (held !== undefined && workerOf(held) === grant.worker) return;

      if (held !== undefined) {
        return yield* Effect.fail(new KinuError('denied', `${address} already routes to ${workerOf(held) ?? 'something other than a Worker'}.`));
      }

      yield* Effect.promise(async () => cloudflareResult(transport, {
        method: 'POST', path,
        body: { name: `Kinu ${wanted}`, enabled: true, matchers: [{ type: 'literal', field: 'to', value: wanted }], actions: [{ type: 'worker', value: [grant.worker] }] },
      }, v.unknown()));
    })),

    unrouted: (root, domain) => refused(`unrouting ${root}@${domain}`, Effect.gen(function* () {
      const own = `${root}@${domain}`.toLowerCase();
      const under = (to: string | null) => to !== null && (to === own || to.endsWith(`.${own}`));
      const listed = yield* rules.pipe(Effect.map((all) => all.filter((rule) => under(literalTo(rule)) && workerOf(rule) === grant.worker)));

      for (const rule of listed) yield* Effect.promise(async () => cloudflareResult(transport, { method: 'DELETE', path: `${path}/${rule.id}` }, v.unknown()));
    }).pipe(Effect.catchCause((failed) => {
      const cause = Cause.squash(failed);

      if (!(cause instanceof CloudflareApiError) || (cause.status !== 401 && cause.status !== 403)) return Effect.failCause(failed);
      diagnostics.failure('mail.unroute_unhonoured', new KinuError('denied', `unrouting ${root}@${domain}: Cloudflare no longer honours the grant`, { cause }));

      return Effect.void;
    }))),
  };
}
