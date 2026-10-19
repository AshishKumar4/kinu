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
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { rawPath, routeError, type FamilyEnv } from './api/context';
import { mintViewerTicket, ticketUser, viewerCookie, viewerCookieResponse, viewerSigner } from './viewer-pass';

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


export async function viewerEntryUrl(env: Env, workspace: string, handle: string, userId: string): Promise<string | null> {
  const base = await slateShareUrl(env, workspace, handle);

  if (base === null) return null;
  const ticket = await mintViewerTicket(env, workspace, handle, userId);

  return ticket === null ? null : `${base}${VIEWER_EXCHANGE_PATH.slice(1)}?ticket=${ticket}`;
}

/** The app's page a `users` share is entered through: it signs its visitor in, then mints their ticket. */
export function liveShareEntryPage(env: Env, workspace: string, share: string): string | null {
  const origin = env.CLI_PUBLIC_ORIGIN;

  return origin === undefined || !URL.canParse(origin) ? null : new URL(liveSharePagePath(workspace, share), origin).toString();
}



async function viewerSource(env: Env, request: Request): Promise<string> {
  const secret = viewerSigner.secret(env);

  // Reached only after the share-token check, so a missing secret is a fault.
  if (secret === undefined) throw new Error('viewer source signed with no secret');

  return viewerSigner.token(secret, `kinu:viewer-source:v1:${request.headers.get('cf-connecting-ip') ?? ''}`);
}

interface VerifiedShare {
  readonly env: Env;
  readonly handle: string;
  readonly workspace: string;
}

const shareHostRoutes = new Hono<FamilyEnv<VerifiedShare, object>>({ getPath: rawPath });

// A ticket mints the identity cookie; the consent button mints the consent cookie over the already-proven subject.
shareHostRoutes.all(VIEWER_EXCHANGE_PATH, async (c) => {
  const { env, handle, workspace } = c.env;
  const request = c.req.raw;
  const url = new URL(request.url);
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

  const kept = keptSlateContext(url);

  // On to the slate's page, framed as it was asked for.
  return await viewerCookieResponse(env, { workspace, handle, subject, consent }, kept === '' ? '/' : `/?${kept}`);
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
  const { env, handle, workspace } = c.env;
  const request = c.req.raw;
  const url = new URL(request.url);
  // Read the claim before the sanitizer strips the cookie.
  const cookie = await viewerCookie(env, workspace, handle, request.headers.get('cookie'));

  if (cookie !== null && actsFromElsewhere(request, url)) {
    return new Response('A share acts on its viewer\'s behalf only from its own page', { status: 403, headers: { 'cache-control': 'no-store' } });
  }

  const claim: ShareViewerClaim = { userId: cookie?.userId ?? null, source: await viewerSource(env, request), consented: cookie?.consented === true };
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

  return await shareHostRoutes.fetch(request, { env, handle, workspace });
}
