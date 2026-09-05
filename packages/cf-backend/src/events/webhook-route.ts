/**
 * The public webhook delivery path, and the capability that makes it public
 * without making a workspace name a door.
 *
 * A bare `/api/workspaces/<name>/webhook/<trigger>` is a string anyone can
 * type. Resolving the Orchestrator stub for that name before knowing whether
 * the workspace or the trigger exists lets an unauthenticated caller ACTIVATE
 * a persistent Durable Object for any name they like, at their chosen rate.
 * Nothing upstream can answer instead: the control-plane workspace index is
 * best-effort by design, and the owner's UserDO registry cannot be consulted
 * because the URL names no owner. Bounding the knock (`lib/ingress-budget.ts`)
 * prices that door; it does not close it.
 *
 * So the path carries the routing decision. Its last segment is
 * `v1-<32 lowercase hex>`: a truncated HMAC-SHA-256 over this workspace's and
 * this trigger's identity under `WEBHOOK_ROUTE_SECRET`, minted server-side when
 * the trigger is created, handed back by every authenticated listing, and
 * re-derived on every delivery. It is a ROUTE capability and nothing else —
 * once a request is inside the right workspace, the per-trigger HMAC / Bearer /
 * mTLS gate is what authenticates the payload.
 *
 * Stateless on purpose. The capability is a function of immutable route
 * identity, so it needs no table, no index, no owner lookup and no migration:
 * the URL this mints for an existing trigger row is the URL that row has.
 *
 * Three properties carry the whole thing, and each is checked on both sides:
 *
 *   1. The MAC input is unambiguous. Fields are separated by NUL, which no URL
 *      path segment can contain (the URL parser escapes it to `%00`), so no two
 *      identities share an input: ("ab","c") and ("a","bc") sign differently.
 *   2. The identity grammar is the product's own — `isWorkspaceName` and
 *      `isUlid`, the rules that issued the name and the trigger id. It is
 *      asserted where a URL is minted AND checked before any MAC is derived, so
 *      a capability cannot launder a slash or a control character into
 *      `idFromName`, whatever a future creation path allows.
 *   3. Nothing is decoded. Both grammars are URL-safe, so the segments the
 *      builder writes are the identity verbatim and the MAC covers the bytes on
 *      the wire. A re-spelled segment (`%6Aarvis` for `jarvis`) is a different
 *      string that fails the grammar and the comparison — refused rather than
 *      normalised, so there is exactly one URL per capability.
 *
 * What this does NOT do: expire, or notice revocation. A capability outlives
 * the trigger it was minted for, and a delivery to a revoked trigger is refused
 * by the trigger registry inside the workspace. Revoking one URL is revoking
 * its trigger; revoking every URL a deployment issued is rotating the secret.
 * The guarantee is narrower: only an identity this deployment minted for can
 * be addressed at all.
 */

import { isUlid } from '@kinu.run/core';
import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import { isWorkspaceName } from '../user/validate';

/** Domain separation, versioned in the label AND in the URL segment, so a
 *  future v2 shape can never be verified by the v1 derivation. */
const ROUTE_LABEL = 'kinu.webhook-route.v1';
const CAPABILITY_PREFIX = 'v1-';
/** 128 bits of a SHA-256 HMAC. Unguessable, and short enough to paste. */
const CAPABILITY_HEX_CHARS = 32;

export interface WebhookRouteEnv {
  WEBHOOK_ROUTE_SECRET?: string;
}

/** What an authenticated trigger surface reports when the deployment holds no
 *  route secret. Public delivery says nothing at all — it 404s. */
export const WEBHOOK_ROUTE_UNAVAILABLE =
  'Webhook delivery is not configured on this deployment: WEBHOOK_ROUTE_SECRET is not set. '
  + 'See docs/DEPLOYMENT.md.';

/** The route secret, or null when this deployment can neither sign nor verify a
 *  delivery URL. Trimmed because a secret pasted with a trailing newline is the
 *  same secret, and an untrimmed one would verify nothing it minted. */
export function webhookRouteSecret(env: WebhookRouteEnv): string | null {
  const secret = (env.WEBHOOK_ROUTE_SECRET ?? '').trim();
  return secret.length > 0 ? secret : null;
}

export interface WebhookRouteIdentity {
  readonly workspaceName: string;
  readonly triggerId: string;
}

/** A request under a workspace's `/webhook/` subtree. Anything in that subtree
 *  that is not a well-formed signed path is `malformed`, and both get the same
 *  answer from the route. */
export type WebhookRouteMatch = SignedWebhookRoute | { readonly kind: 'malformed' };

/** A delivery path whose shape and identity grammar hold — not yet a verified
 *  one. Only `verifyWebhookRoute` decides whether this deployment minted it. */
export interface SignedWebhookRoute extends WebhookRouteIdentity {
  readonly kind: 'signed';
  readonly capability: string;
}

const DELIVERY_SUBTREE = /^\/api\/workspaces\/[^/]+\/webhook(?:\/|$)/u;
const SIGNED_DELIVERY = new RegExp(
  `^/api/workspaces/([^/]+)/webhook/([^/]+)/${CAPABILITY_PREFIX}([0-9a-f]{${CAPABILITY_HEX_CHARS}})$`,
  'u',
);

/**
 * The one delivery-URL builder. Relative on purpose: the origin belongs to
 * whoever renders the URL, and it is not part of what the capability covers.
 *
 * Throws for an identity outside the grammar. A URL is a capability, and
 * minting one for a name the product could not have issued would be signing
 * whatever its caller was confused about.
 */
export async function webhookRoutePath(
  secret: string, identity: WebhookRouteIdentity,
): Promise<string> {
  if (!routableIdentity(identity)) {
    throw new Error(
      `Cannot mint a webhook URL for workspace "${identity.workspaceName}" and trigger `
      + `"${identity.triggerId}": not a workspace name and trigger id this deployment issues.`,
    );
  }
  const capability = await routeCapability(secret, identity);
  return `/api/workspaces/${identity.workspaceName}/webhook/${identity.triggerId}`
    + `/${CAPABILITY_PREFIX}${capability}`;
}

/** Null when the path is not a webhook delivery path at all, so the request
 *  carries on down the route table instead of being answered here. */
export function matchWebhookDeliveryPath(pathname: string): WebhookRouteMatch | null {
  if (!DELIVERY_SUBTREE.test(pathname)) return null;
  const signed = SIGNED_DELIVERY.exec(pathname);
  if (!signed) return { kind: 'malformed' };
  const route = {
    kind: 'signed',
    workspaceName: signed[1],
    triggerId: signed[2],
    capability: signed[3],
  } as const;
  return routableIdentity(route) ? route : { kind: 'malformed' };
}

/** Both digests are derived before either is compared, and the comparison is
 *  constant-time, so neither the branch order nor the timing carries a hint of
 *  how close a guess was. */
export async function verifyWebhookRoute(
  secret: string, route: SignedWebhookRoute,
): Promise<boolean> {
  return timingSafeEqual(route.capability, await routeCapability(secret, route));
}

function routableIdentity(identity: WebhookRouteIdentity): boolean {
  return isWorkspaceName(identity.workspaceName) && isUlid(identity.triggerId);
}

function routeCapability(secret: string, identity: WebhookRouteIdentity): Promise<string> {
  return hmacSha256Hex(
    secret, `${ROUTE_LABEL}\u0000${identity.workspaceName}\u0000${identity.triggerId}`,
  ).then((digest) => digest.slice(0, CAPABILITY_HEX_CHARS));
}
