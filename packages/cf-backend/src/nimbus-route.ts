/**
 * Workspace previews at `<port>-<capability-handle>-<token>-<workspace>.<PREVIEW_HOST_SUFFIX>`; the name routes to the Durable Object.
 * Needs both an HMAC token (HKDF subkey, verified before any object is touched) and the live port capability.
 * Guest code on a separate origin: the Kinu session and `x-kinu-*` headers are stripped; never add a path that restores them.
 */

import { workspaceAddressRefusal } from '@kinu.run/core';
import { previewHostSuffix } from '@kinu.run/core';
import { buildWorkspacePreviewHost, parseWorkspacePreviewLabel } from '@kinu.run/core';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { labelSigner } from '@kinu.run/core';
import { reoriginateRequest } from '@kinu.run/core';
import type { LabelSignerEnv, PreviewSuffixEnv, WorkspacePreviewUrl } from '@kinu.run/core';
import type { ObjectNamespace } from '@kinu.run/core';
import { PREVIEW_CAPABILITY_HANDLE_LENGTH } from './workspace-host';

const previewSigner = labelSigner('kinu.workspace-preview.salt', 'kinu.workspace-preview.v4');

export interface WorkspacePreviewHost {
  fetch(request: Request): Promise<Response>;
  routeWorkspacePreview(
    port: number, handle: string, request: Request, pathname: string,
  ): Promise<Response>;
}

export interface NimbusPreviewEnv<Id> extends PreviewSuffixEnv, LabelSignerEnv {
  OrchestratorAgent: ObjectNamespace<Id, WorkspacePreviewHost>;
}

export function nimbusPreviewConfigured(env: PreviewSuffixEnv & LabelSignerEnv): boolean {
  return previewHostSuffix(env) !== null && previewSigner.secrets(env).length > 0;
}

/** `v4`: a token keyed by the raw secret must not verify under the subkey. */
function previewMessage(workspace: string, port: number, handle: string): string {
  return `kinu:workspace-preview:v4:${workspace}:${port}:${handle}`;
}

/** A reason rather than a throw: without a preview host, or with a name a hostname label cannot carry, the port still works. */
export async function nimbusPreviewUrl(
  env: PreviewSuffixEnv & LabelSignerEnv,
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

  // The name passed the label grammar, so null is a fault.
  if (host === null) throw new Error(`the preview label for "${workspaceName}" did not fit a hostname`);

  return { url: `https://${host}/` };
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

  const stub = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspace));

  // `request.body` passes unwrapped so a fixed-length upload stays fixed-length.
  // A WebSocket upgrade uses `fetch`: a 101 cannot cross a Durable Object RPC boundary.
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

/** Reached only after {@link handleNimbusPreviewHostRequest} verified the signature; the object re-checks the capability. */
export const WORKSPACE_PREVIEW_PATH = '/_kinu/workspace-preview';
