/**
 * Live slate shares on the share host.
 *
 * A shared slate is reachable at
 * `<handle>-<token>-<workspace>.<PREVIEW_HOST_SUFFIX>` — one hostname per
 * share, beside the workspace previews this route runs ahead of — and this
 * module is both halves of that: the URL a live share is handed, and the edge
 * that turns a request for one back into the Durable Object that owns the
 * workspace.
 *
 * WHAT AUTHENTICATES ONE. The label's `token` is an HMAC over
 * `kinu:slate-share:v1:${workspace}:${handle}` keyed by a subkey of the
 * user-plane secret only this module derives — checked HERE, before anything
 * touches a Durable Object, so a guessed hostname cannot make Kinu do work.
 * The handle itself is minted with the share row (`slates/live-shares.ts`);
 * revoking the share is what makes the address stop answering, which is what
 * makes "stop sharing" mean something.
 *
 * WHY A SUBKEY. `CREDENTIAL_ENCRYPTION_KEY` also seals every credential the
 * owner stores, and a signature keyed by the raw secret shares key material
 * with that cipher. HKDF with this module's own salt and info diverges a key
 * nothing else holds; the ticket and cookie signers diverge again from it, so
 * a share token, a viewer ticket and a viewer cookie are three values none of
 * which verifies as another.
 *
 * THE VIEWER COOKIE. A `users` share admits named accounts, and a viewer's
 * browser gets one through `VIEWER_EXCHANGE_PATH`: a signed ticket in the URL
 * — minted by the app host for the signed-in account — is exchanged for a
 * `__Host-` cookie scoped to this origin and this share. `__Host-` because a
 * viewer cookie must come from THIS origin alone: any other name a subdomain
 * could plant, and the ticket lives only in the redirect, never in a request
 * the share's own code sees. Twelve hours, not the ticket's five minutes: the
 * ticket authenticates once, the cookie is the session.
 *
 * A share serves agent-controlled guest code on a host that is a different
 * origin from the app, so the viewer cookie and every `x-kinu-*` header are
 * stripped on the way in — after the claim is read off the ORIGINAL headers —
 * and this must never become a path that puts them back.
 */

import {
  buildSlateShareHost, parseSlateShareLabel, previewHostSuffix, workspaceAddressRefusal,
  ingressAdmitted, labelSigner, reoriginateRequest, SHARE_VIEWER_REQUESTS_PER_MINUTE, type ShareViewerClaim, VIEWER_EXCHANGE_PATH,
} from '@kinu.run/core';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { VIEWER_COOKIE_NAME } from './auth/session';

/** The share signer: its own salt and info, so a share token verifies nowhere
 *  else (`lib/label-signer.ts` states the key discipline). */
const shareSigner = labelSigner('kinu.slate-share.salt', 'kinu.slate-share.v1');

/** The viewer signer, diverged from the share signer: it mints the exchange
 *  ticket, the viewer cookie and the anonymous source hash — three values,
 *  none of which verifies as a share token. */
const viewerSigner = labelSigner('kinu.slate-viewer.salt', 'kinu.slate-viewer.v1');

/** The orchestrator's internal fetch path for a WebSocket upgrade. */
export const SLATE_SHARE_PATH = '/_kinu/slate-share';


/** The Durable Object method a share request reaches. Declared here so the
 *  route holds the narrowest view of the orchestrator it needs. */
interface SlateShareHost {
  fetch(request: Request): Promise<Response>;
  routeSlateShare(handle: string, claim: ShareViewerClaim, request: Request, pathname: string): Promise<Response>;
}

const USER_ID_RE = /^[a-f0-9]{32}$/;

function shareMessage(workspace: string, handle: string): string {
  return `kinu:slate-share:v1:${workspace}:${handle}`;
}

function ticketMessage(workspace: string, handle: string, userId: string, expiresAt: number): string {
  return `kinu:viewer-ticket:v1:${workspace}:${handle}:${userId}:${expiresAt}`;
}

function cookieMessage(workspace: string, handle: string, subject: string, expiresAt: number): string {
  return `kinu:viewer-cookie:v1:${workspace}:${handle}:${subject}:${expiresAt}`;
}

/** The consent cookie's signed message, diverged from the identity one's: a
 *  cookie that says the viewer saw the consent page is a different claim than
 *  one that names them, and a stolen identity cookie must not mint the other. */
function consentMessage(workspace: string, handle: string, subject: string, expiresAt: number): string {
  return `kinu:viewer-consent:v1:${workspace}:${handle}:${subject}:${expiresAt}`;
}

/**
 * The public URL a live share is reachable at, or null where this deployment
 *  cannot mint one — no share host, no signing secret, or a workspace name the
 *  label cannot carry.
 */
export async function slateShareUrl(env: Env, workspace: string, handle: string): Promise<string | null> {
  const suffix = previewHostSuffix(env);

  if (suffix === null) return null;
  const secret = shareSigner.secrets(env)[0];

  if (secret === undefined) return null;

  if (workspaceAddressRefusal(workspace) !== null) return null;
  const token = await shareSigner.token(secret, shareMessage(workspace, handle));
  const host = buildSlateShareHost({ handle, token, workspace, suffix });

  return host === null ? null : `https://${host}/`;
}

/**
 * The five-minute ticket a named viewer's exchange URL carries:
 * `${userId}.${expiresAt}.${sig}` — the account it binds is part of the
 * signed message, so a ticket minted for one user admits nobody else.
 */
async function mintViewerTicket(env: Env, workspace: string, handle: string, userId: string): Promise<string | null> {
  if (!USER_ID_RE.test(userId)) return null;
  const secret = viewerSigner.secrets(env)[0];

  if (secret === undefined) return null;
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const sig = await viewerSigner.token(secret, ticketMessage(workspace, handle, userId, expiresAt));

  return `${userId}.${expiresAt}.${sig}`;
}

/** The exchange URL the app host hands a named viewer, or null where the
 *  deployment cannot sign one. */
export async function viewerEntryUrl(env: Env, workspace: string, handle: string, userId: string): Promise<string | null> {
  const base = await slateShareUrl(env, workspace, handle);

  if (base === null) return null;
  const ticket = await mintViewerTicket(env, workspace, handle, userId);

  return ticket === null ? null : `${base}${VIEWER_EXCHANGE_PATH.slice(1)}?ticket=${ticket}`;
}

/** The subject a viewer cookie minted for this workspace+handle names, and
 *  whether it is the consent-minted flavor: a ticket exchange mints the
 *  identity cookie, the consent page's button mints the consent one, and a
 *  share that reaches anything credentialed shows its consent page until the
 *  second arrives. `userId` is the subject only when it is one — a public
 *  viewer's consent subject is its source hash, which names no account.
 *  `null` for a cookie minted for another share, another workspace, or a dead
 *  expiry. */
async function viewerCookie(
  env: Env, workspace: string, handle: string, cookieHeader: string | null,
): Promise<{ userId: string | null; subject: string; consented: boolean } | null> {
  const value = cookieHeader?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${VIEWER_COOKIE_NAME}=`))
    ?.slice(VIEWER_COOKIE_NAME.length + 1);

  const [subject, expiresAtText, sig] = value?.split('.') ?? [];

  if (subject === undefined || expiresAtText === undefined || sig === undefined) return null;
  const expiresAt = Number(expiresAtText);

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  if (await viewerSigner.verify(env, cookieMessage(workspace, handle, subject, expiresAt), sig)) {
    return { userId: USER_ID_RE.test(subject) ? subject : null, subject, consented: false };
  }

  if (await viewerSigner.verify(env, consentMessage(workspace, handle, subject, expiresAt), sig)) {
    return { userId: USER_ID_RE.test(subject) ? subject : null, subject, consented: true };
  }

  return null;
}

/** The ticket a `?ticket=` carries, verified for THIS workspace and handle:
 *  a ticket minted for another share is a 404 here, and so is an expired one. */
async function ticketUser(
  env: Env, workspace: string, handle: string, ticket: string,
): Promise<{ userId: string; expiresAt: number } | null> {
  const [userId, expiresAtText, sig] = ticket.split('.');

  if (userId === undefined || expiresAtText === undefined || sig === undefined || !USER_ID_RE.test(userId)) return null;
  const expiresAt = Number(expiresAtText);

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  if (!await viewerSigner.verify(env, ticketMessage(workspace, handle, userId, expiresAt), sig)) return null;

  return { userId, expiresAt };
}

/** The anonymous opener's attribution: a hash of the source address, signed
 *  so a fabricated `source` names nobody else's. */
async function viewerSource(env: Env, request: Request): Promise<string> {
  const secret = viewerSigner.secrets(env)[0];

  // The caller reaches here only past the share-token check, which itself runs
  // under `secrets(env)` non-empty — a missing secret is a fault, not an answer.
  if (secret === undefined) throw new Error('viewer source signed with no secret');

  return viewerSigner.token(secret, `kinu:viewer-source:v1:${request.headers.get('cf-connecting-ip') ?? ''}`);
}

/**
 * Serve a request that arrived on a slate-share hostname, or answer `null` so
 *  the preview parser gets its turn.
 *
 * Runs BEFORE app authentication, beside the workspace previews (see
 * server.ts): a share host is not the app and must never be treated as one.
 */
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

  if (shareSigner.secrets(env).length === 0) {
    return new Response('Share authentication is unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  if (!await shareSigner.verify(env, shareMessage(workspace, handle), token)) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  // The exchange: a signed ticket becomes the identity cookie, and the
  // consent page's button becomes the consent cookie — the claim a
  // credentialed share actually gates on. Both mint over the subject the
  // request already proves: the ticket's account for one, the existing
  // cookie's subject (or, a public viewer's, its source hash) for the other.
  if (url.pathname === VIEWER_EXCHANGE_PATH) {
    const source = await viewerSource(env, request);
    const consent = url.searchParams.has('consent');
    const ticket = consent ? null : await ticketUser(env, workspace, handle, url.searchParams.get('ticket') ?? '');

    const subject = consent
      ? (await viewerCookie(env, workspace, handle, request.headers.get('cookie')))?.subject ?? source
      : ticket?.userId;

    if (subject === undefined) {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }

    // S2's request bound reaches the exchange too: a viewer hammering the
    // mint is a share route under load, counted under the same per-viewer key.
    if (env.AUTH_KV !== undefined
      && !await ingressAdmitted(env.AUTH_KV, 'slate-share', `${handle}:${subject}`, SHARE_VIEWER_REQUESTS_PER_MINUTE)) {
      return new Response('Too many requests', { status: 429, headers: { 'cache-control': 'no-store' } });
    }

    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;

    const secret = viewerSigner.secrets(env)[0];

    if (secret === undefined) {
      return new Response('Share authentication is unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
    }

    const sig = await viewerSigner.token(secret,
      (consent ? consentMessage : cookieMessage)(workspace, handle, subject, expiresAt));

    return new Response(null, {
      status: 303,
      headers: {
        location: '/',
        'set-cookie': `${VIEWER_COOKIE_NAME}=${subject}.${expiresAt}.${sig}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`,
        'cache-control': 'no-store',
      },
    });
  }

  // The claim is read off the ORIGINAL headers, before the sanitizer strips the
  // cookie: a viewer cookie minted for another share names nobody here.
  const cookie = await viewerCookie(env, workspace, handle, request.headers.get('cookie'));
  const claim: ShareViewerClaim = { userId: cookie?.userId ?? null, source: await viewerSource(env, request), consented: cookie?.consented === true };
  const headers = sanitizePreviewRequestHeaders(request.headers);
  headers.delete('x-nimbus-base');
  const stub: SlateShareHost = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspace));

  // A WebSocket upgrade goes through `fetch` because a 101 cannot cross a
  // Durable Object RPC boundary; everything else takes the RPC, which is one
  // fewer request construction and keeps the response typed.
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
}
