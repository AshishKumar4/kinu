/**
 * Live slate shares at `<handle>-<token>-<workspace>.<PREVIEW_HOST_SUFFIX>`. The token is an HMAC under an HKDF subkey
 * (the raw secret also seals credentials), verified before any Durable Object is touched.
 * The share host runs guest code, so the viewer cookie and `x-kinu-*` headers are stripped on the way in; never add a path that restores them.
 */

import {
  buildSlateShareHost, parseSlateShareLabel, previewHostSuffix, previewPortSuffix, workspaceAddressRefusal,
  ingressAdmitted, labelSigner, reoriginateRequest, SHARE_VIEWER_REQUESTS_PER_MINUTE, type ShareViewerClaim, VIEWER_EXCHANGE_PATH,
} from '@kinu.run/core';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { VIEWER_COOKIE_NAME } from './auth/session';

const shareSigner = labelSigner('kinu.slate-share.salt', 'kinu.slate-share.v1');

/** Diverged from the share signer so a ticket, cookie or source hash never verifies as a share token. */
const viewerSigner = labelSigner('kinu.slate-viewer.salt', 'kinu.slate-viewer.v1');

export const SLATE_SHARE_PATH = '/_kinu/slate-share';


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

/** Diverged from the identity cookie's message so one cookie never verifies as the other. */
function consentMessage(workspace: string, handle: string, subject: string, expiresAt: number): string {
  return `kinu:viewer-consent:v1:${workspace}:${handle}:${subject}:${expiresAt}`;
}

export async function slateShareUrl(env: Env, workspace: string, handle: string): Promise<string | null> {
  const suffix = previewHostSuffix(env);

  if (suffix === null) return null;
  const secret = shareSigner.secrets(env)[0];

  if (secret === undefined) return null;

  if (workspaceAddressRefusal(workspace) !== null) return null;
  const token = await shareSigner.token(secret, shareMessage(workspace, handle));
  const host = buildSlateShareHost({ handle, token, workspace, suffix });

  return host === null ? null : `https://${host}${previewPortSuffix(env)}/`;
}

async function mintViewerTicket(env: Env, workspace: string, handle: string, userId: string): Promise<string | null> {
  if (!USER_ID_RE.test(userId)) return null;
  const secret = viewerSigner.secrets(env)[0];

  if (secret === undefined) return null;
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const sig = await viewerSigner.token(secret, ticketMessage(workspace, handle, userId, expiresAt));

  return `${userId}.${expiresAt}.${sig}`;
}

export async function viewerEntryUrl(env: Env, workspace: string, handle: string, userId: string): Promise<string | null> {
  const base = await slateShareUrl(env, workspace, handle);

  if (base === null) return null;
  const ticket = await mintViewerTicket(env, workspace, handle, userId);

  return ticket === null ? null : `${base}${VIEWER_EXCHANGE_PATH.slice(1)}?ticket=${ticket}`;
}

/** A public viewer's consent subject is its source hash, so `userId` is null for it. */
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

async function viewerSource(env: Env, request: Request): Promise<string> {
  const secret = viewerSigner.secrets(env)[0];

  // Reached only after the share-token check, so a missing secret is a fault.
  if (secret === undefined) throw new Error('viewer source signed with no secret');

  return viewerSigner.token(secret, `kinu:viewer-source:v1:${request.headers.get('cf-connecting-ip') ?? ''}`);
}

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

  if (shareSigner.secrets(env).length === 0) {
    return new Response('Share authentication is unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  if (!await shareSigner.verify(env, shareMessage(workspace, handle), token)) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  // A ticket mints the identity cookie; the consent button mints the consent cookie over the already-proven subject.
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

  // Read the claim before the sanitizer strips the cookie.
  const cookie = await viewerCookie(env, workspace, handle, request.headers.get('cookie'));
  const claim: ShareViewerClaim = { userId: cookie?.userId ?? null, source: await viewerSource(env, request), consented: cookie?.consented === true };
  const headers = sanitizePreviewRequestHeaders(request.headers);
  headers.delete('x-nimbus-base');
  const stub: SlateShareHost = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspace));

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
}
