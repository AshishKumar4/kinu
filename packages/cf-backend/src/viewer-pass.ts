/**
 * The signed passes of Kinu's guest hosts, in one place: a workspace preview's URL token, and the viewer mechanism every
 * guest host signs its visitors in by. An app page that knows its visitor mints a five-minute ticket, and the host's
 * `VIEWER_EXCHANGE_PATH` turns it into the host-only `__Host-` viewer cookie. A live share keys its tickets and cookies
 * by its handle (`slate-share-route.ts`), a workspace preview by its port and capability handle (`nimbus-route.ts`).
 * Imports nothing of the Worker's routing, so the workspace's own fetches (`codemode-egress.ts`) can mint a pass.
 */

import { labelSigner, parseWorkspacePreviewLabel, previewHostSuffix, type LabelSignerEnv, type PreviewSuffixEnv } from '@kinu.run/core';

export const previewSigner = labelSigner('kinu.workspace-preview.salt', 'kinu.workspace-preview.v4');

/** Diverged from the share signer so a ticket, cookie or source hash never verifies as a share token. */
export const viewerSigner = labelSigner('kinu.slate-viewer.salt', 'kinu.slate-viewer.v1');

/** A guest host's visitor identity, set by its ticket exchange and scoped to that host: a live share's viewer, a preview's owner. */
export const VIEWER_COOKIE_NAME = '__Host-kinu_viewer';

const USER_ID_RE = /^[a-f0-9]{32}$/;

/** `v4`: a token keyed by the raw secret must not verify under the subkey. */
export function previewMessage(workspace: string, port: number, handle: string): string {
  return `kinu:workspace-preview:v4:${workspace}:${port}:${handle}`;
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

export async function mintViewerTicket(env: LabelSignerEnv, workspace: string, handle: string, userId: string): Promise<string | null> {
  if (!USER_ID_RE.test(userId)) return null;
  const secret = viewerSigner.secret(env);

  if (secret === undefined) return null;
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const sig = await viewerSigner.token(secret, ticketMessage(workspace, handle, userId, expiresAt));

  return `${userId}.${expiresAt}.${sig}`;
}

/** A public viewer's consent subject is its source hash, so `userId` is null for it. */
export async function viewerCookie(
  env: LabelSignerEnv, workspace: string, handle: string, cookieHeader: string | null,
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

export async function ticketUser(
  env: LabelSignerEnv, workspace: string, handle: string, ticket: string,
): Promise<{ userId: string; expiresAt: number } | null> {
  const [userId, expiresAtText, sig] = ticket.split('.');

  if (userId === undefined || expiresAtText === undefined || sig === undefined || !USER_ID_RE.test(userId)) return null;
  const expiresAt = Number(expiresAtText);

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  if (!await viewerSigner.verify(env, ticketMessage(workspace, handle, userId, expiresAt), sig)) return null;

  return { userId, expiresAt };
}

/** How long a viewer cookie lets its visitor back in without a new ticket. */
const VIEWER_COOKIE_LIFE_MS = 12 * 60 * 60 * 1000;

/** The viewer cookie's signed value, `subject.expiresAt.sig`, or null on a deployment with no signing secret. */
async function signedViewerCookie(
  env: LabelSignerEnv, scope: { readonly workspace: string; readonly handle: string; readonly subject: string; readonly consent?: boolean }, lifeMs = VIEWER_COOKIE_LIFE_MS,
): Promise<string | null> {
  const secret = viewerSigner.secret(env);

  if (secret === undefined) return null;
  const expiresAt = Date.now() + lifeMs;
  const sig = await viewerSigner.token(secret, (scope.consent === true ? consentMessage : cookieMessage)(scope.workspace, scope.handle, scope.subject, expiresAt));

  return `${scope.subject}.${expiresAt}.${sig}`;
}

/** Sets the viewer cookie on this host and sends its visitor on to `location`, a path on the same host. */
export async function viewerCookieResponse(
  env: LabelSignerEnv, scope: { readonly workspace: string; readonly handle: string; readonly subject: string; readonly consent?: boolean }, location: string,
): Promise<Response> {
  const value = await signedViewerCookie(env, scope);

  if (value === null) {
    return new Response('Share authentication is unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  return new Response(null, {
    status: 303,
    headers: {
      location,
      'set-cookie': `${VIEWER_COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(VIEWER_COOKIE_LIFE_MS / 1000)}`,
      'cache-control': 'no-store',
    },
  });
}

/** The viewer-cookie subject of the workspace's own browsers and fetches: no user id has this form. */
export const PREVIEW_SELF = 'workspace';

/** How long the workspace's own pass lasts: one screenshot, render or fetch. */
const SELF_PASS_LIFE_MS = 5 * 60 * 1000;

/** What a preview's viewer ticket and cookie are keyed by: a share handle never has this form (it holds no `-`). */
export function previewViewerKey(port: number, handle: string): string {
  return `p${String(port)}-${handle}`;
}

/** A hostname's preview, its signature verified: null for any other host or a forged one. */
export async function verifiedPreview(
  env: PreviewSuffixEnv & LabelSignerEnv, hostname: string,
): Promise<{ readonly port: number; readonly workspace: string; readonly handle: string } | null> {
  const suffix = previewHostSuffix(env);

  if (!suffix || !hostname.endsWith(`.${suffix}`)) return null;
  const preview = parseWorkspacePreviewLabel(hostname.slice(0, -suffix.length - 1));

  if (preview === null || !await previewSigner.verify(env, previewMessage(preview.workspace, preview.port, preview.handle), preview.token)) return null;

  return { port: preview.port, workspace: preview.workspace, handle: preview.handle };
}

/**
 * The cookie the workspace's own browser or fetch carries to one of its previews (`cookie` header form), or null for
 * any other URL. It names no person: the workspace asking for its own preview is its owner's authority already.
 */
export async function selfPreviewPass(
  env: PreviewSuffixEnv & LabelSignerEnv, workspace: string, url: URL,
): Promise<{ readonly name: string; readonly value: string } | null> {
  const preview = await verifiedPreview(env, url.hostname);

  if (preview === null || preview.workspace !== workspace) return null;
  const value = await signedViewerCookie(env, { workspace, handle: previewViewerKey(preview.port, preview.handle), subject: PREVIEW_SELF }, SELF_PASS_LIFE_MS);

  return value === null ? null : { name: VIEWER_COOKIE_NAME, value };
}
