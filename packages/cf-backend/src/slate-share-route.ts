/**
 * Live slate shares at `<handle>-<token>-<workspace>.<PREVIEW_HOST_SUFFIX>`. The token is an HMAC under an HKDF subkey
 * (the raw secret also seals credentials), verified before any Durable Object is touched.
 * The share host runs guest code, so the viewer cookie and `x-kinu-*` headers are stripped on the way in; never add a path that restores them.
 *
 * Its viewers sign in by the viewer mechanism every guest host shares (`viewer-pass.ts`), keyed by the share's handle.
 */

import {
  objectNamed,
  buildSlateShareHost, liveSharePagePath, parseSlateShareLabel, previewHostSuffix, previewPortSuffix, workspaceAddressRefusal,
  ingressAdmitted, keptSlateContext, labelSigner, reoriginateRequest, SHARE_VIEWER_REQUESTS_PER_MINUTE, type ShareViewerClaim, VIEWER_EXCHANGE_PATH,
} from '@kinu.run/core';
import { Hono } from 'hono';
import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { rawPath, routeError, type FamilyEnv } from './api/context';
import { mintAnonymousSubject, ticketUser, viewerCookie, viewerCookieResponse, viewerSigner } from './viewer-pass';

const shareSigner = labelSigner('kinu.slate-share.salt', 'kinu.slate-share.v1');

export const SLATE_SHARE_PATH = '/_kinu/slate-share';


interface SlateShareHost {
  fetch(request: Request): Promise<Response>;
  routeSlateShare(handle: string, claim: ShareViewerClaim, request: Request, pathname: string): Promise<Response>;
}

function shareMessage(workspace: string, handle: string): string {
  return `kinu:slate-share:v1:${workspace}:${handle}`;
}


export async function slateShareUrl(env: Env, workspace: string, handle: string): Promise<string | null> {
  const suffix = previewHostSuffix(env);

  if (suffix === null) return null;
  const secret = shareSigner.secret(env);

  if (secret === undefined) return null;

  if (workspaceAddressRefusal(workspace) !== null) return null;
  const token = await shareSigner.token(secret, shareMessage(workspace, handle));
  const host = buildSlateShareHost({ handle, token, workspace, suffix });

  return host === null ? null : `https://${host}${previewPortSuffix(env)}/`;
}


/**
 * Kinu's own share page's origin, the one origin whose POST into a share's frame may say who its visitor is: an app's
 * page sends its own share host's, a sibling share host its own, and a page elsewhere its own (Chrome 157, measured
 * 2026-11-11 under Kinu's `strict-origin-when-cross-origin`: a form Kinu's page targets at the frame carries Kinu's
 * origin; `no-referrer` and `same-origin` would send `null`). Null where the deployment names no app origin.
 */
function kinuOrigin(env: Env): string | null {
  const origin = env.CLI_PUBLIC_ORIGIN;

  return origin === undefined || !URL.canParse(origin) ? null : new URL(origin).origin;
}

/** The app's page a `users` share is entered through: it signs its visitor in, then mints their ticket. */
export function liveShareEntryPage(env: Env, workspace: string, share: string): string | null {
  const origin = env.CLI_PUBLIC_ORIGIN;

  return origin === undefined || !URL.canParse(origin) ? null : new URL(liveSharePagePath(workspace, share), origin).toString();
}



function viewerSource(secret: string, request: Request): Promise<string> {
  return viewerSigner.token(secret, `kinu:viewer-source:v1:${request.headers.get('cf-connecting-ip') ?? ''}`);
}

interface VerifiedShare {
  readonly env: Env;
  readonly handle: string;
  readonly workspace: string;
  /** What a viewer's source is signed with. */
  readonly viewerSecret: string;
}

const shareHostRoutes = new Hono<FamilyEnv<VerifiedShare, object>>({ getPath: rawPath });

const NOT_FOUND = { status: 404, headers: { 'cache-control': 'no-store' } } as const;

/** Who the visitor becomes, and whether they saw the share's disclaimer: an exchange's answer, before its cookie. */
interface Exchanged {
  readonly subject: string;
  readonly consent: boolean;
  /** Whom its exchanges are counted against, where not the subject: where a new anonymous visitor comes from. */
  readonly admitAs?: string;
}

/** The identity cookie for `exchanged`, the visitor sent on to the slate's page as it was framed. */
async function exchangedTo(c: { readonly env: VerifiedShare }, request: Request, exchanged: Exchanged | null): Promise<Response> {
  const { env, handle, workspace } = c.env;

  if (exchanged === null) return new Response('Not found', NOT_FOUND);

  if (env.AUTH_KV !== undefined
    && !await ingressAdmitted(env.AUTH_KV, 'slate-share', `${handle}:${exchanged.admitAs ?? exchanged.subject}`, SHARE_VIEWER_REQUESTS_PER_MINUTE)) {
    return new Response('Too many requests', { status: 429, headers: { 'cache-control': 'no-store' } });
  }

  const kept = keptSlateContext(new URL(request.url));

  return await viewerCookieResponse(env, { workspace, handle, subject: exchanged.subject, consent: exchanged.consent }, kept === '' ? '/' : `/?${kept}`);
}

// The disclaimer's Continue, a link on this host's own page: consent over the subject the visitor already is, never a
// new one.
shareHostRoutes.get(VIEWER_EXCHANGE_PATH, async (c) => {
  const { env, handle, workspace, viewerSecret } = c.env;
  const request = c.req.raw;

  if (!new URL(request.url).searchParams.has('consent')) return new Response('Not found', NOT_FOUND);
  const held = await viewerCookie(env, workspace, handle, request.headers.get('cookie'));

  return await exchangedTo(c, request, { subject: held?.subject ?? await viewerSource(viewerSecret, request), consent: true });
});

// Who the visitor is changes only here, on a POST Kinu's own share page sends into the frame: a signed-in person's
// ticket, or the anonymous visitor its sheet's button made. Any other origin, the app's page on this very host among
// them, changes no one: a ticket a person minted for themself never becomes another browser's identity.
shareHostRoutes.post(VIEWER_EXCHANGE_PATH, async (c) => {
  const { env, handle, workspace, viewerSecret } = c.env;
  const request = c.req.raw;
  const origin = kinuOrigin(env);

  if (origin === null || request.headers.get('origin') !== origin) return new Response('Not found', NOT_FOUND);
  const form = await request.formData();
  const ticketed = form.get('ticket');

  if (typeof ticketed === 'string') {
    const ticket = await ticketUser(env, workspace, handle, ticketed);

    return await exchangedTo(c, request, ticket === null ? null : { subject: ticket.userId, consent: false });
  }

  if (form.get('anonymous') === null) return new Response('Not found', NOT_FOUND);
  // Continuing anonymously keeps who the visitor already is, signed in or anonymous, and their consent; only a visitor
  // known by nothing yet is given an id, which is bounded by where they come from, as every exchange of theirs is.
  const held = await viewerCookie(env, workspace, handle, request.headers.get('cookie'));
  const known = held !== null && (held.userId !== null || held.anonymous !== null) ? held.subject : null;

  return await exchangedTo(c, request, known === null
    ? { subject: mintAnonymousSubject(), consent: held?.consented === true, admitAs: await viewerSource(viewerSecret, request) }
    : { subject: known, consent: held?.consented === true });
});

/**
 * Whether a request acts (any method but GET, HEAD or OPTIONS, or a socket's upgrade) from anywhere but this share's own
 * origin. A viewer's cookie rides every same-site request, and every other share and preview host is same-site, so such
 * a request never carries the cookie's authority. One naming no origin is refused alike: absence grants nothing.
 */
function actsFromElsewhere(request: Request, url: URL): boolean {
  const acting = !['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.headers.get('upgrade')?.toLowerCase() === 'websocket';

  return acting && request.headers.get('origin') !== url.origin;
}

shareHostRoutes.all('*', async (c) => {
  const { env, handle, workspace, viewerSecret } = c.env;
  const request = c.req.raw;
  const url = new URL(request.url);
  // Read the claim before the sanitizer strips the cookie.
  const cookie = await viewerCookie(env, workspace, handle, request.headers.get('cookie'));

  if (cookie !== null && actsFromElsewhere(request, url)) {
    return new Response('A share acts on its viewer\'s behalf only from its own page', { status: 403, headers: { 'cache-control': 'no-store' } });
  }

  const claim: ShareViewerClaim = {
    userId: cookie?.userId ?? null, source: await viewerSource(viewerSecret, request), consented: cookie?.consented === true,
    ...(cookie !== null && cookie.anonymous !== null && { anonymous: cookie.anonymous }),
  };

  const headers = sanitizePreviewRequestHeaders(request.headers);
  headers.delete('x-nimbus-base');
  const stub: SlateShareHost = objectNamed(env.OrchestratorAgent, workspace);

  // A WebSocket upgrade uses `fetch`: a 101 cannot cross a Durable Object RPC boundary.
  if (headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const target = new URL(request.url);
    target.pathname = `${SLATE_SHARE_PATH}/${handle}/${encodeURIComponent(JSON.stringify(claim))}${url.pathname}`;

    return await stub.fetch(reoriginateRequest(request, target.toString(), { headers, redirect: request.redirect }));
  }

  return await stub.routeSlateShare(
    handle,
    claim,
    reoriginateRequest(request, request.url, { headers, redirect: request.redirect }),
    url.pathname,
  );
});

shareHostRoutes.onError(routeError);

/** Runs before app authentication; `null` hands the request to the preview parser. */
export async function handleSlateShareHostRequest(request: Request, env: Env): Promise<Response | null> {
  const suffix = previewHostSuffix(env);

  if (suffix === null) return null;
  const url = new URL(request.url);
  const suffixWithDot = `.${suffix}`;

  if (!url.hostname.endsWith(suffixWithDot)) return null;
  const label = url.hostname.slice(0, -suffixWithDot.length);
  const share = parseSlateShareLabel(label);

  if (share === null) return null;
  const { handle, token, workspace } = share;

  if (shareSigner.secret(env) === undefined) {
    return new Response('Share authentication is unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  if (!await shareSigner.verify(env, shareMessage(workspace, handle), token)) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  const viewerSecret = viewerSigner.secret(env);

  // Past the share-token check, so a missing secret is a fault.
  if (viewerSecret === undefined) return settle(Effect.die(new Error('viewer source signed with no secret')));

  return await shareHostRoutes.fetch(request, { env, handle, workspace, viewerSecret });
}
