/**
 * Workspace previews at `<port>-<capability-handle>-<token>-<workspace>.<PREVIEW_HOST_SUFFIX>`; the name routes to the Durable Object.
 * Needs both an HMAC token (HKDF subkey, verified before any object is touched) and the live port capability.
 * Guest code on a separate origin: the Kinu session and `x-kinu-*` headers are stripped; never add a path that restores them.
 *
 * A preview opens only for its workspace's signed-in owner: a slate's calls run as the owner, so its URL is no bearer
 * link. The owner is signed in on a preview host as a live share's viewer is (`viewer-pass.ts`): the app's
 * `PREVIEW_ENTRY_PATH` knows its visitor, checks they own the workspace and mints a ticket, which the host's
 * `VIEWER_EXCHANGE_PATH` turns into its viewer cookie. The edge reads the cookie; the workspace compares its subject with
 * its owner. The workspace's own browsers and fetches carry a short pass whose subject is `PREVIEW_SELF`.
 */

import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import {
  objectNamed,
  escapeHtml, ingressAdmitted, PREVIEW_ENTRY_PATH, publicPage, SHARE_VIEWER_REQUESTS_PER_MINUTE, VIEWER_EXCHANGE_PATH, workspaceAddressRefusal,
} from '@kinu.run/core';
import { previewHostSuffix, previewPortSuffix } from '@kinu.run/core';
import { buildWorkspacePreviewHost, parseWorkspacePreviewLabel } from '@kinu.run/core';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { reoriginateRequest } from '@kinu.run/core';
import type { LabelSignerEnv, PreviewPortEnv, PreviewSuffixEnv, WorkspacePreviewUrl } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import type { ObjectNamespace } from '@kinu.run/core';
import { PREVIEW_CAPABILITY_HANDLE_LENGTH } from './workspace-host';
import {
  mintViewerTicket, PREVIEW_SELF, previewMessage, previewSigner, previewViewerKey, ticketUser, verifiedPreview, viewerCookie, viewerCookieResponse,
} from './viewer-pass';

export interface WorkspacePreviewHost {
  fetch(request: Request): Promise<Response>;
  routeWorkspacePreview(preview: PreviewVisit, request: Request): Promise<Response>;
  /** Whether `userId` owns the workspace, and whether `port` serves a slate: what the app's entry page tells its visitor. */
  previewAccess(userId: string, port: number): Promise<PreviewAccess>;
}

/** One request to a preview, as the edge verified it. */
export interface PreviewVisit {
  readonly port: number;
  readonly handle: string;
  readonly pathname: string;
  /** The subject of the visitor's verified viewer cookie for this preview, or null without one. */
  readonly viewer: string | null;
}

export interface PreviewAccess {
  readonly owned: boolean;
  readonly slate: boolean;
}

export interface NimbusPreviewEnv<Id> extends PreviewSuffixEnv, LabelSignerEnv {
  OrchestratorAgent: ObjectNamespace<Id, WorkspacePreviewHost>;
  /** Bounds each visitor's ticket exchanges, as on a live share's host. */
  AUTH_KV?: KvStore;
  /** The app's origin, where a preview's visitor is signed in. */
  CLI_PUBLIC_ORIGIN?: string;
}



/** What a preview tells a visitor it does not admit. */
export function previewRefusalText(slate: boolean): string {
  return slate ? "This slate isn't shared with you" : "This preview isn't shared with you";
}

/** A page load, which can be sent to sign in, rather than a script's request, which can only be refused. */
export function isNavigation(request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode');

  return mode === null ? request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html') : mode === 'navigate';
}

/** Where a visitor the preview does not know is sent: the app, which signs them in and sends its owner back. */
export function previewEntryUrl(env: { readonly CLI_PUBLIC_ORIGIN?: string }, preview: string): string | null {
  const origin = env.CLI_PUBLIC_ORIGIN;

  if (origin === undefined || !URL.canParse(origin)) return null;
  const entry = new URL(PREVIEW_ENTRY_PATH, origin);
  entry.searchParams.set('to', preview);

  return entry.toString();
}



/**
 * The app's {@link PREVIEW_ENTRY_PATH}, behind its sign-in: the workspace's owner is sent on to the preview with a
 * ticket for its host; anyone else is told the preview is not shared with them.
 */
export async function previewEntry<Id>(
  request: Request,
  env: PreviewSuffixEnv & LabelSignerEnv & { OrchestratorAgent: ObjectNamespace<Id, Pick<WorkspacePreviewHost, 'previewAccess'>> },
  userId: string,
): Promise<Response> {
  const to = new URL(request.url).searchParams.get('to');
  const target = to !== null && URL.canParse(to) ? new URL(to) : null;
  const preview = target === null ? null : await verifiedPreview(env, target.hostname);

  if (target === null || preview === null) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const stub = objectNamed(env.OrchestratorAgent, preview.workspace);
  const access = await stub.previewAccess(userId, preview.port);

  if (!access.owned) {
    // A computer's port is no slate's, whatever the workspace's own box serves at the same number.
    const text = previewRefusalText(access.slate && preview.kind === 'workspace');
    const html = publicPage({ title: text, body: `<main><section class="section"><h1>${escapeHtml(text)}</h1></section></main>` });

    return new Response(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }

  const ticket = await mintViewerTicket(env, preview.workspace, previewViewerKey(preview.port, preview.handle), userId);

  if (ticket === null) return new Response('Preview authentication is unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
  const exchange = new URL(VIEWER_EXCHANGE_PATH, target.origin);
  exchange.searchParams.set('ticket', ticket);
  exchange.searchParams.set('next', `${target.pathname}${target.search}`);

  return new Response(null, { status: 303, headers: { location: exchange.toString(), 'cache-control': 'no-store' } });
}

/**
 * Where on this host to go on to after the exchange, as the browser will read it: `next` resolved against the host,
 * kept only when it stays there, and answered absolute so no form of it (`//`, `/\\`, a tab or newline the parser drops)
 * can name another host.
 */
function sameHostTarget(next: string | null, origin: string): string {
  const resolved = next !== null && URL.canParse(next, origin) ? new URL(next, origin) : null;

  return resolved !== null && resolved.origin === origin ? resolved.href : `${origin}/`;
}

/**
 * A request the preview's own page or its owner's address bar makes, never one another site's page sends with the
 * owner's cookie. Every preview and share host is a sibling under one site, and a same-site request carries the cookie,
 * so the cookie alone cannot tell them apart; the browser's fetch metadata can. A page load opens the page, as any link
 * opens any site's. A browser too old to send fetch metadata marks its page loads alone with
 * `Upgrade-Insecure-Requests` (a script cannot add it without a preflight that names its origin), and names the page
 * behind its script, style and image loads in `Referer`, which the preview's `same-origin` policy keeps for its own
 * requests and no page can set: those of its own page are its, another site's are not. A socket, a script's request or
 * a form post must come from the preview itself, by its metadata or else its exact `Origin`. Only the workspace's own
 * server-side fetch (`self`) may send neither.
 */
export function ownRequest(request: Request, origin: string, self: boolean): boolean {
  const mode = request.headers.get('sec-fetch-mode');
  const site = request.headers.get('sec-fetch-site');
  const stated = request.headers.get('origin');
  const read = request.method === 'GET' || request.method === 'HEAD';
  const referer = request.headers.get('referer');
  const ownPage = referer !== null && URL.canParse(referer) && new URL(referer).origin === origin;
  const legacyLoad = site === null && stated === null && (request.headers.get('upgrade-insecure-requests') === '1' || ownPage);

  if (read && (mode === 'navigate' || legacyLoad)) return true;

  if (site !== null) return site === 'same-origin' || site === 'none';

  return stated === origin || (self && stated === null);
}

/**
 * The local dev server's preview zone (`vite dev`, `*.preview.localhost`): a name only this machine resolves, as the
 * dev identity's loopback is (`auth/session.ts`). Its app is `http://localhost`, another site, so no cookie its entry
 * mints is kept in the app's frame; the machine itself is the one asking, so every visit there is the workspace's own.
 */
function localDevPreview(suffix: string): boolean {
  return suffix === 'localhost' || suffix.endsWith('.localhost');
}

/** The preview host's ticket exchange: the owner's ticket becomes the host's viewer cookie, then their page. */
export async function exchangePreviewTicket(
  request: Request, env: LabelSignerEnv & { readonly AUTH_KV?: KvStore }, workspace: string, key: string,
): Promise<Response> {
  const url = new URL(request.url);
  const ticket = await ticketUser(env, workspace, key, url.searchParams.get('ticket') ?? '');

  if (ticket === null) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

  if (env.AUTH_KV !== undefined && !await ingressAdmitted(env.AUTH_KV, 'workspace-preview', `${key}:${ticket.userId}`, SHARE_VIEWER_REQUESTS_PER_MINUTE)) {
    return new Response('Too many requests', { status: 429, headers: { 'cache-control': 'no-store' } });
  }

  return await viewerCookieResponse(env, { workspace, handle: key, subject: ticket.userId }, sameHostTarget(url.searchParams.get('next'), url.origin));
}

export function nimbusPreviewConfigured(env: PreviewSuffixEnv & LabelSignerEnv): boolean {
  return previewHostSuffix(env) !== null && previewSigner.secret(env) !== undefined;
}


/** A reason rather than a throw: without a preview host, or with a name a hostname label cannot carry, the port still works. */
export function nimbusPreviewUrl(
  env: PreviewSuffixEnv & PreviewPortEnv & LabelSignerEnv,
  workspaceName: string,
  port: number,
  capability: string,
): Promise<WorkspacePreviewUrl> {
  return settle(Effect.gen(function* () {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { unavailable: `${String(port)} is not a TCP port` };
    }

    if (!/^[a-f0-9]{24}$/.test(capability)) {
      return { unavailable: 'the port registry handed out a capability this deployment cannot sign' };
    }

    const suffix = previewHostSuffix(env);

    if (!suffix) return { unavailable: 'this deployment has no preview host (PREVIEW_HOST_SUFFIX is not set)' };
    const secret = previewSigner.secret(env);

    if (!secret) return { unavailable: 'this deployment has no preview signing secret (CREDENTIAL_ENCRYPTION_KEY is not set)' };
    const refusal = workspaceAddressRefusal(workspaceName);

    if (refusal !== null) return { unavailable: refusal };
    const handle = capability.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH);
    const token = yield* Effect.promise(async () => previewSigner.token(secret, previewMessage(workspaceName, port, handle)));
    const host = buildWorkspacePreviewHost({ port, workspace: workspaceName, handle, token, suffix });

    // The name passed the label grammar, so null is a fault.
    if (host === null) return yield* Effect.die(new Error(`the preview label for "${workspaceName}" did not fit a hostname`));

    return { url: `https://${host}${previewPortSuffix(env)}/` };
  }));
}

/** Runs before app authentication; `null` hands the request to the container-preview router. */
export async function handleNimbusPreviewHostRequest<Id>(
  request: Request,
  env: NimbusPreviewEnv<Id>,
): Promise<Response | null> {
  const suffix = previewHostSuffix(env);

  if (!suffix) return null;
  const url = new URL(request.url);
  const suffixWithDot = `.${suffix}`;

  if (!url.hostname.endsWith(suffixWithDot)) return null;
  const label = url.hostname.slice(0, -suffixWithDot.length);
  const preview = parseWorkspacePreviewLabel(label);

  if (!preview) return null;
  const { port, workspace, token, handle } = preview;

  if (previewSigner.secret(env) === undefined) {
    return new Response('Preview authentication is unavailable.', {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }

  if (!await previewSigner.verify(env, previewMessage(workspace, port, handle), token)) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  const key = previewViewerKey(port, handle);

  if (url.pathname === VIEWER_EXCHANGE_PATH) return await exchangePreviewTicket(request, env, workspace, key);
  // Read before the sanitizer strips the cookie. A consent cookie is a live share's, never a preview's, and another
  // site's request names no one, whatever cookie it carries.
  const cookie = await viewerCookie(env, workspace, key, request.headers.get('cookie'));
  const signed = cookie === null || cookie.consented || !ownRequest(request, url.origin, cookie.subject === PREVIEW_SELF) ? null : cookie.subject;
  const viewer = localDevPreview(suffix) ? PREVIEW_SELF : signed;
  const headers = sanitizePreviewRequestHeaders(request.headers);
  headers.delete('x-nimbus-base');

  const stub = objectNamed(env.OrchestratorAgent, workspace);

  // `request.body` passes unwrapped so a fixed-length upload stays fixed-length.
  // A WebSocket upgrade uses `fetch`: a 101 cannot cross a Durable Object RPC boundary.
  if (headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const target = new URL(request.url);
    target.pathname = `${WORKSPACE_PREVIEW_PATH}/${port}/${handle}/${encodeURIComponent(viewer ?? '')}${url.pathname}`;

    return await stub.fetch(reoriginateRequest(request, target.toString(), {
      headers, redirect: request.redirect,
    }));
  }

  return await stub.routeWorkspacePreview(
    { port, handle, pathname: url.pathname, viewer },
    reoriginateRequest(request, request.url, { headers, redirect: request.redirect }),
  );
}

/** Reached only after {@link handleNimbusPreviewHostRequest} verified the signature; the object re-checks the capability. */
export const WORKSPACE_PREVIEW_PATH = '/_kinu/workspace-preview';
