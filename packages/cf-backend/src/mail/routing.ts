/**
 * The deployment's mail routing grant (core deploy/mail-rules.ts): present where its mail is on a subdomain of its zone,
 * whose addresses route only by rules of their own. Absent on an apex, kinu.run's among them, whose catch-all routes
 * every address, so nothing is made or deleted there.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { bearerTransport, mailRoutes, MailRoutingGrantSchema, type MailRoutes } from '@kinu.run/core/deploy';
import { KinuError } from '@kinu.run/core/obs';

const GrantText = v.pipe(v.string(), v.parseJson(), MailRoutingGrantSchema);

/** Null without a grant. A grant that does not read as one refuses every address, rather than leave them unrouted. */
export function mailRoutesOf(env: Pick<Env, 'KINU_MAIL_ROUTING'>, fetchImpl: typeof fetch = fetch): MailRoutes | null {
  const held = env.KINU_MAIL_ROUTING ?? '';

  if (held === '') return null;
  const grant = v.safeParse(GrantText, held);

  if (grant.success) return mailRoutes(grant.output, bearerTransport(grant.output.token, fetchImpl));
  const unread = Effect.fail(new KinuError('unavailable', "This deployment's KINU_MAIL_ROUTING is not a routing grant, so no address can be routed."));

  return { routed: () => unread, unrouted: () => unread };
}
