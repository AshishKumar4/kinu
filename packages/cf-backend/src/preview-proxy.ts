/**
 * Native container previews: a published capability is checked before a DO is addressed, then its visitor. Like a
 * workspace preview (`nimbus-route.ts`), it opens for the workspace's signed-in owner and the workspace's own fetches,
 * by the viewer pass, unless the owner made it a public link; its URL alone is no bearer link.
 */
import { Effect } from "effect";
import { diagnostics, recording, settle } from "@kinu.run/core/obs";
import { escapeHtml, VIEWER_EXCHANGE_PATH } from "@kinu.run/core";
import { containPreviewResponse, sandboxPreviewLabelOf } from "@kinu.run/core";
import { workspaceOfSandbox } from "@kinu.run/core";
import { sandboxPreviewExposure, type LabelSignerEnv, type PreviewSuffixEnv } from "@kinu.run/core";
import type { KvStore } from "@kinu.run/agent-utils";
import { sanitizePreviewRequestHeaders } from "./lib/preview-request";
import { exchangePreviewTicket, isNavigation, ownRequest, previewEntryUrl, previewRefusalText } from "./nimbus-route";
import { computerPreviewHandle, PREVIEW_SELF, previewViewerKey, viewerCookie } from "./viewer-pass";


/** One refusal shape for every unserved hostname, so it is not an existence oracle. */
function refusePreview(code: string, error: string, status: number): Response {
  return containPreviewResponse(new Response(
    JSON.stringify({ error, code }),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  ));
}

/** A deployment can omit container previews entirely. */
export interface SandboxPreviewEnv extends PreviewSuffixEnv, LabelSignerEnv {
  KinuDevbox?: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  AUTH_KV?: KvStore;
  /** The app's origin, where a preview's visitor is signed in. */
  CLI_PUBLIC_ORIGIN?: string;
}

/** Always answers; an unpublished hostname gets a 404, never the app and never a Durable Object. */
export async function servePreviewRequest(request: Request, env: SandboxPreviewEnv): Promise<Response> {
  const url = new URL(request.url);
  const label = sandboxPreviewLabelOf(url, env);

  const workspace = label === null ? null : workspaceOfSandbox(label.sandboxId);

  // Refused on shape, before any lookup.
  if (label === null || workspace === null) {
    return refusePreview('NOT_A_PREVIEW', "This host serves previews of a workspace's computer only.", 404);
  }

  // Fail closed.
  if (!env.AUTH_KV || !env.KinuDevbox) {
    return refusePreview('PREVIEW_UNAVAILABLE', 'Preview routing is unavailable.', 503);
  }


  const exposure = await sandboxPreviewExposure(env.AUTH_KV, label);

  if (exposure === null) {
    diagnostics.event('preview.unpublished_label', { sandboxId: label.sandboxId, port: label.port });

    return refusePreview(
      'PREVIEW_NOT_EXPOSED',
      'This preview is not exposed. Re-expose the port to publish it again.',
      404,
    );
  }

  if (!exposure.public) {
    const key = previewViewerKey(label.port, await computerPreviewHandle(label.token));

    if (url.pathname === VIEWER_EXCHANGE_PATH) return containPreviewResponse(await exchangePreviewTicket(request, { ...env, AUTH_KV: env.AUTH_KV }, workspace, key));
    const refused = await unadmitted(request, env, { workspace, key, port: label.port });

    if (refused !== null) return containPreviewResponse(refused);
  }

  const devbox = env.KinuDevbox;

  // The box reads the port and token from the host, so the visitor's path reaches the port as it is (D60).
  return settle(Effect.catchCause(Effect.promise(async () => {
    const response = await devbox.getByName(label.sandboxId).fetch(new Request(request, {
      headers: sanitizePreviewRequestHeaders(request.headers),
    }));

    return containPreviewResponse(response);
  }), (failed) => Effect.as(recording({ doing: 'reaching the restored container preview', otherwise: 'unavailable' }, (failure) => {
    diagnostics.failure('preview.forward_failed', failure, { sandboxId: label.sandboxId, port: label.port });
  })(failed), renderNotReadyPage(url.hostname))));
}

/**
 * Null when the visitor is the workspace's owner, or the workspace itself, by a viewer cookie this host minted (only
 * after the app's entry checked its owner, or for the workspace's own fetch) and a request of this preview's own; a
 * page load without one is sent to the app to sign in, any other request refused.
 */
async function unadmitted(
  request: Request, env: SandboxPreviewEnv, preview: { readonly workspace: string; readonly key: string; readonly port: number },
): Promise<Response | null> {
  const origin = new URL(request.url).origin;
  const cookie = await viewerCookie(env, preview.workspace, preview.key, request.headers.get('cookie'));

  if (cookie !== null && !cookie.consented && ownRequest(request, origin, cookie.subject === PREVIEW_SELF)) return null;
  diagnostics.event('preview.route.refused', { port: preview.port, handle: 'computer', reason: cookie === null ? 'no-viewer' : 'not-owner', owner: '', detail: '' });
  const entry = cookie === null && isNavigation(request) ? previewEntryUrl(env, request.url) : null;
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

  // A page load is sent to the app, which signs its visitor in and sends the owner back; a script's request is refused.
  if (entry !== null) return new Response(null, { status: 303, headers: { ...headers, location: entry } });

  return new Response(previewRefusalText(false), { status: 403, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
}

function renderNotReadyPage(host: string): Response {
  // `<port>-<sandbox>-<token>.<suffix>` — name the first two, never the token.
  const label = host.slice(0, host.indexOf('.'));
  const firstHyphen = label.indexOf('-');
  const lastHyphen = label.lastIndexOf('-');
  const named = firstHyphen !== -1 && lastHyphen > firstHyphen;
  const safePort = escapeHtml(named ? label.slice(0, firstHyphen) : '');
  const sandboxId = named ? label.slice(firstHyphen + 1, lastHyphen) : '';
  const safeSandboxId = escapeHtml(sandboxId);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Preview not ready · :${safePort}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #1A1613; color: #F5EFE6;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 2rem;
  }
  .card {
    max-width: 640px; width: 100%;
    background: #241E18; border: 1px solid rgba(224, 164, 88, 0.14); border-radius: 12px;
    padding: 2rem; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; display: flex; align-items: center; gap: 0.5rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #D99A4E; }
  p { line-height: 1.6; color: #B6A893; font-size: 0.95rem; margin: 0.5rem 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #2E261E; color: #E8B97A; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.85em; }
  pre {
    background: #1f1a15; border: 1px solid rgba(224, 164, 88, 0.14); border-radius: 6px;
    padding: 0.75rem 1rem; overflow-x: auto; font-size: 0.8rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #d8cdb8; white-space: pre-wrap; word-break: break-word;
  }
  .hint { color: #7d7261; font-size: 0.85rem; margin-top: 1rem; }
  .meta { color: #7d7261; font-size: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid rgba(224, 164, 88, 0.14); }
  button {
    background: #E0A458; color: #2a1d0c; border: 0; border-radius: 6px;
    padding: 0.5rem 1rem; font-size: 0.85rem; font-weight: 600; cursor: pointer;
    margin-top: 1rem;
  }
  button:hover { background: #caa05a; }
</style>
</head>
<body>
<div class="card">
  <h1><span class="dot"></span> Preview not ready</h1>
  <p>Port <code>${safePort}</code> is public, but the computer did not accept the connection.</p>
  <p>Usually nothing is listening on it yet: the agent exposed the port before it started a server. You can send the agent this:</p>
  <pre>You exposed port ${safePort}, but nothing on your computer is serving on it. Start a supervised server first. For a static site: <code>computer.startProcess("python3 -m http.server ${safePort} --directory /workspace/&lt;app&gt;")</code>. For Node: <code>computer.startProcess("node server.js", {cwd:"/workspace/&lt;app&gt;"})</code>. Then call <code>computer.exposePort(${safePort})</code> again.</pre>
  <p class="hint">A supervised process comes back on its own after the computer restarts; a bare nohup job does not. If a supervised server was running, it is already restarting, so reload this page in a moment.</p>
  <button onclick="location.reload()">Reload preview</button>
  <div class="meta">sandbox=${safeSandboxId} · port=${safePort}</div>
</div>
</body>
</html>`;

  return containPreviewResponse(new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  }));
}
