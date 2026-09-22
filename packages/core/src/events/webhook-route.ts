/**
 * Signed webhook delivery path: last segment is `v1-<32 hex>`, a truncated HMAC over workspace
 * name and trigger id under `WEBHOOK_ROUTE_SECRET`, so an unauthenticated caller cannot activate a
 * DO for an arbitrary name. Stateless; does not expire or track revocation (rotate the secret).
 * MAC input is NUL-separated, identities are grammar-checked before any MAC, nothing is decoded.
 */

import { hmacSha256Hex, timingSafeEqual } from '../utils/crypto';
import { isUlid } from './hub/ulid';
import { isWorkspaceName } from '../identity/naming';

/** Versioned in the label and URL segment so a v2 shape never verifies under v1. */
const ROUTE_LABEL = 'kinu.webhook-route.v1';

const CAPABILITY_PREFIX = 'v1-';

const CAPABILITY_HEX_CHARS = 32;

export interface WebhookRouteEnv {
  WEBHOOK_ROUTE_SECRET?: string;
}

/** Public delivery 404s instead. */
export const WEBHOOK_ROUTE_UNAVAILABLE =
  'Webhook delivery is not configured on this deployment: WEBHOOK_ROUTE_SECRET is not set. '
  + 'See docs/DEPLOYMENT.md.';

/** Trimmed: a secret pasted with a trailing newline is the same secret. */
export function webhookRouteSecret(env: WebhookRouteEnv): string | null {
  const secret = (env.WEBHOOK_ROUTE_SECRET ?? '').trim();

  return secret.length > 0 ? secret : null;
}

export interface WebhookRouteIdentity {
  readonly workspaceName: string;
  readonly triggerId: string;
}

export type WebhookRouteMatch = SignedWebhookRoute | { readonly kind: 'malformed' };

/** Grammar holds but not yet verified; see `verifyWebhookRoute`. */
export interface SignedWebhookRoute extends WebhookRouteIdentity {
  readonly kind: 'signed';
  readonly capability: string;
}

const DELIVERY_SUBTREE = /^\/api\/workspaces\/[^/]+\/webhook(?:\/|$)/u;

const SIGNED_DELIVERY = new RegExp(
  `^/api/workspaces/([^/]+)/webhook/([^/]+)/${CAPABILITY_PREFIX}([0-9a-f]{${CAPABILITY_HEX_CHARS}})$`,
  'u',
);

/** Relative: the origin is not covered by the capability. Throws outside the identity grammar. */
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

/** Null when not under a `/webhook/` subtree, so routing continues. */
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
