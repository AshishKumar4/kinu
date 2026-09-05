/**
 * Workspace previews on the isolated preview host.
 *
 * A workspace's listening port is reachable at
 * `<port>-<capability-handle>-<token>-<workspace>.<PREVIEW_HOST_SUFFIX>`, and
 * this module is both halves of that: the URL an exposed port is handed, and the
 * edge that turns a request for one back into the Durable Object that owns the
 * workspace.
 *
 * WHY THE WORKSPACE NAME IS IN THE HOSTNAME. The workspace lives in its
 * OrchestratorAgent Durable Object, which is addressed by name — so the name is
 * what the router needs, and a one-way digest of it (which is what this label
 * carried while a second object owned the filesystem) is exactly what a router
 * cannot use. It is the same shape the sandbox container's previews already
 * have, where the SDK puts the sandbox id in the label.
 *
 * WHAT AUTHENTICATES ONE. Two independent things, and the request needs both:
 *
 *   - `token`, an HMAC over (workspace, port, capability handle) keyed by a
 *     subkey of the user-plane secret that only this module derives. Checked
 *     HERE, before anything touches a Durable Object, so a guessed hostname
 *     cannot make Kinu do work.
 *   - the capability, minted by the workspace's own port registry when the port
 *     was exposed. Only its first 10 characters travel in the hostname; the
 *     owning object compares them against the live capability and routes with
 *     the whole one. Unexposing a port mints a new capability, so old links stop
 *     resolving — which is what makes "stop sharing this" mean something.
 *
 * WHY A SUBKEY. `CREDENTIAL_ENCRYPTION_KEY` also seals every credential the
 * owner stores (`user/credential-envelope.ts`), and a signature keyed by the
 * raw secret shares key material with that cipher, so a weakness in either
 * construction would implicate the other. HKDF with this module's own salt
 * and info diverges a key nothing else holds; the envelope does the same on
 * its side. The secret's rotation list still applies, because the subkey is
 * derived from whichever secret is being tried.
 *
 * A preview is agent-controlled guest code on a host that is a different origin
 * from the app, so the browser's Kinu session and every `x-kinu-*` header are
 * stripped on the way in and this must never become a path that puts them back.
 */

import { previewHostSuffix } from './lib/preview-origin';
import { timingSafeEqual } from './lib/crypto';
import { buildWorkspacePreviewHost, parseWorkspacePreviewLabel } from './lib/nimbus-preview-host';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { reoriginateRequest } from './lib/http';
import { PREVIEW_CAPABILITY_HANDLE_LENGTH } from './workspace-host';

const HKDF_SALT = 'kinu.workspace-preview.salt';
const HKDF_INFO = 'kinu.workspace-preview.v4';

/** Signing keys, cached by secret. The derivation is deterministic over
 *  material the isolate already holds, so the cache adds no exposure and
 *  removes an HKDF from every preview request. */
const signingKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(secret: string): Promise<CryptoKey> {
  let pending = signingKeys.get(secret);
  if (!pending) {
    pending = (async () => {
      const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(HKDF_SALT), info: utf8(HKDF_INFO) },
        material,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    })();
    signingKeys.set(secret, pending);
  }
  return pending;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

/** The Durable Object method a preview request reaches. Declared here so the
 *  route holds the narrowest view of the orchestrator it needs. */
interface WorkspacePreviewHost {
  fetch(request: Request): Promise<Response>;
  routeWorkspacePreview(
    port: number, handle: string, request: Request, pathname: string,
  ): Promise<Response>;
}

function previewSecrets(env: Env): string[] {
  const current = env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!current) return [];
  const retired = (env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [current, ...retired];
}

export function nimbusPreviewConfigured(env: Env): boolean {
  return previewHostSuffix(env) !== null && previewSecrets(env).length > 0;
}

/**
 * The label's signature.
 *
 * `v4` because the key changed: `v3` was keyed by the raw user-plane secret,
 * and a token minted under it must not verify under the subkey. There is no
 * grace period, because a preview URL has no expiry of its own: the token is
 * a deterministic function of (workspace, port, handle), and the handle lives
 * as long as the port stays exposed. Every v3 URL therefore fails closed at
 * the edge from this build on, and the Ports surface mints v4 URLs from the
 * same still-live capabilities on its next listing.
 */
async function previewToken(secret: string, workspace: string, port: number, handle: string): Promise<string> {
  const digest = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    utf8(`kinu:workspace-preview:v4:${workspace}:${port}:${handle}`),
  );
  return base32(new Uint8Array(digest)).slice(0, 15);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase RFC-4648 base32 without padding — the alphabet a DNS label admits.
 *  Exported so a suite can spell a token the way the edge does. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let encoded = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += BASE32[(buffer << (5 - bits)) & 31];
  return encoded;
}

/**
 * The public URL for one exposed workspace port, or undefined when this
 * deployment cannot mint one.
 *
 * Undefined rather than a throw: a deployment with no preview host still runs
 * servers in its workspace, and the port surface says the URL is unavailable
 * instead of failing the exposure.
 */
export async function nimbusPreviewUrl(
  env: Env,
  workspaceName: string,
  port: number,
  capability: string,
): Promise<string | undefined> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (!/^[a-f0-9]{24}$/.test(capability)) return undefined;
  const suffix = previewHostSuffix(env);
  const secret = previewSecrets(env)[0];
  if (!suffix || !secret) return undefined;
  const handle = capability.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH);
  const token = await previewToken(secret, workspaceName, port, handle);
  const host = buildWorkspacePreviewHost({ port, workspace: workspaceName, handle, token, suffix });
  return host === null ? undefined : `https://${host}/`;
}

/**
 * Serve a request that arrived on a workspace-preview hostname, or answer
 * `null` so the container-preview router gets its turn.
 *
 * Runs BEFORE app authentication (see server.ts): a preview host is not the app
 * and must never be treated as one.
 */
export async function handleNimbusPreviewHostRequest(request: Request, env: Env): Promise<Response | null> {
  const suffix = previewHostSuffix(env);
  if (!suffix) return null;
  const url = new URL(request.url);
  const suffixWithDot = `.${suffix}`;
  if (!url.hostname.endsWith(suffixWithDot)) return null;
  const label = url.hostname.slice(0, -suffixWithDot.length);
  const preview = parseWorkspacePreviewLabel(label);
  if (!preview) return null;
  const { port, workspace, token, handle } = preview;
  const secrets = previewSecrets(env);
  if (secrets.length === 0) {
    return new Response('Preview authentication is unavailable.', {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
  const expected = await Promise.all(
    secrets.map((secret) => previewToken(secret, workspace, port, handle)),
  );
  if (!expected.some((candidate) => timingSafeEqual(token, candidate))) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  const headers = sanitizePreviewRequestHeaders(request.headers);
  headers.delete('x-nimbus-base');
  const stub: WorkspacePreviewHost = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(workspace),
  );
  // One construction policy, shared with container egress: `request.body` is
  // handed over unwrapped so a fixed-length upload stays fixed-length across the
  // hop. The headers are the SANITIZED set.
  //
  // A WebSocket upgrade goes through `fetch` because a 101 cannot cross a
  // Durable Object RPC boundary; everything else takes the RPC, which is one
  // fewer request construction and keeps the response typed.
  if (headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const target = new URL(request.url);
    target.pathname = `${WORKSPACE_PREVIEW_PATH}/${port}/${handle}${url.pathname}`;
    return await stub.fetch(reoriginateRequest(request, target.toString(), {
      headers, redirect: request.redirect,
    }));
  }
  return await stub.routeWorkspacePreview(
    port,
    handle,
    reoriginateRequest(request, request.url, { headers, redirect: request.redirect }),
    url.pathname,
  );
}

/**
 * The orchestrator's internal path for a preview WebSocket upgrade.
 *
 * Reachable only from {@link handleNimbusPreviewHostRequest}, which has already
 * verified the label's signature — and from nowhere else, because the app's own
 * routes never construct it and the preview host is not the app host. The
 * capability handle is re-checked inside the object regardless.
 */
export const WORKSPACE_PREVIEW_PATH = '/_kinu/workspace-preview';
