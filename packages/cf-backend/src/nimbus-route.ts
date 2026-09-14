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

import { workspaceAddressRefusal } from '@kinu.run/core';
import { previewHostSuffix } from '@kinu.run/core';
import { buildWorkspacePreviewHost, parseWorkspacePreviewLabel } from '@kinu.run/core';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { labelSigner } from '@kinu.run/core';
import { reoriginateRequest } from '@kinu.run/core';
import type { WorkspacePreviewUrl } from '@kinu.run/core';
import { PREVIEW_CAPABILITY_HANDLE_LENGTH } from './workspace-host';

/** The v4 preview signer: its own HKDF salt and info, so a preview token
 *  verifies nowhere else (`lib/label-signer.ts` states the key discipline). */
const previewSigner = labelSigner('kinu.workspace-preview.salt', 'kinu.workspace-preview.v4');

/** The Durable Object method a preview request reaches. Declared here so the
 *  route holds the narrowest view of the orchestrator it needs. */
interface WorkspacePreviewHost {
  fetch(request: Request): Promise<Response>;
  routeWorkspacePreview(
    port: number, handle: string, request: Request, pathname: string,
  ): Promise<Response>;
}

export function nimbusPreviewConfigured(env: Env): boolean {
  return previewHostSuffix(env) !== null && previewSigner.secrets(env).length > 0;
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
function previewMessage(workspace: string, port: number, handle: string): string {
  return `kinu:workspace-preview:v4:${workspace}:${port}:${handle}`;
}

/**
 * The public URL for one exposed workspace port, or the reason this
 * deployment cannot mint one for this workspace.
 *
 * A reason rather than a throw: a deployment with no preview host still runs
 * servers in its workspace, and the port surface reports why the URL is
 * unavailable instead of failing the exposure. The reason is per workspace
 * as well as per deployment, because the workspace-name grammar admits names
 * a hostname label cannot carry (core `preview/nimbus-preview-host.ts`), and a
 * workspace so named keeps every other port surface while its previews
 * report exactly that.
 */
export async function nimbusPreviewUrl(
  env: Env,
  workspaceName: string,
  port: number,
  capability: string,
): Promise<WorkspacePreviewUrl> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { unavailable: `${String(port)} is not a TCP port` };
  }

  if (!/^[a-f0-9]{24}$/.test(capability)) {
    return { unavailable: 'the port registry handed out a capability this deployment cannot sign' };
  }

  const suffix = previewHostSuffix(env);

  if (!suffix) return { unavailable: 'this deployment has no preview host (PREVIEW_HOST_SUFFIX is not set)' };
  const secret = previewSigner.secrets(env)[0];

  if (!secret) return { unavailable: 'this deployment has no preview signing secret (CREDENTIAL_ENCRYPTION_KEY is not set)' };
  const refusal = workspaceAddressRefusal(workspaceName);

  if (refusal !== null) return { unavailable: refusal };
  const handle = capability.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH);
  const token = await previewSigner.token(secret, previewMessage(workspaceName, port, handle));
  const host = buildWorkspacePreviewHost({ port, workspace: workspaceName, handle, token, suffix });

  // The name passed the label grammar above, so the label fits by the budget
  // that grammar was cut to; a null here is a fault in that arithmetic.
  if (host === null) throw new Error(`the preview label for "${workspaceName}" did not fit a hostname`);

  return { url: `https://${host}/` };
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

  if (previewSigner.secrets(env).length === 0) {
    return new Response('Preview authentication is unavailable.', {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }

  if (!await previewSigner.verify(env, previewMessage(workspace, port, handle), token)) {
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
