/**
 * Sandbox container previews, served on the preview host.
 *
 * Routing is the @cloudflare/sandbox SDK's own: `exposePort` mints
 * `https://<port>-<sandbox>-<token>.<PREVIEW_HOST_SUFFIX>/` and
 * `proxyToSandbox` parses that hostname back into a sandbox, validates the
 * port's secret token inside the Durable Object, and forwards to the container
 * (WebSocket upgrades included). Kinu adds only what the SDK has no opinion
 * about: this host serves previews and nothing else, responses are contained
 * (lib/preview-origin.ts), and a failed forward gets a page a user can act on
 * instead of a bare `Proxy routing error`.
 */

import { proxyToSandbox } from "@cloudflare/sandbox";
import { escapeHtml } from "./lib/http";
import { containPreviewResponse } from "./lib/preview-origin";
import { sanitizePreviewRequestHeaders } from "./lib/preview-request";

/**
 * `proxyToSandbox` collapses every forwarding failure — overwhelmingly "the
 * container is not listening on port N" — into this one response. Matching it
 * is how the friendly page below gets shown; `unit-preview-origin.test.ts`
 * pins the shape so an SDK upgrade that changes it fails loudly.
 */
export const SDK_FORWARD_FAILURE = { status: 500, body: 'Proxy routing error' } as const;

/**
 * Serve a request that arrived on the preview host. Always answers: a hostname
 * that does not resolve to an exposed port gets a 404, never the app.
 */
export async function servePreviewRequest(request: Request, env: Env): Promise<Response> {
  const response = await proxyToSandbox(new Request(request, {
    headers: sanitizePreviewRequestHeaders(request.headers),
  }), env);
  if (!response) {
    return containPreviewResponse(new Response(
      JSON.stringify({ error: 'This host serves sandbox previews only.', code: 'NOT_A_PREVIEW' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
  }

  if (response.status === SDK_FORWARD_FAILURE.status
    && (await response.clone().text()) === SDK_FORWARD_FAILURE.body) {
    return renderNotReadyPage(new URL(request.url).hostname);
  }

  return containPreviewResponse(response);
}

/**
 * The container refused the connection. Nothing listening on the port is the
 * cause almost every time — the agent exposed it before starting a server —
 * so the page says how to fix that while naming the other possibility.
 */
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
  <p>Port <code>${safePort}</code> is exposed publicly but the container did not accept the connection.</p>
  <p>Usually that means nothing is listening on it yet: the agent exposed the port before starting a server. Ask the agent:</p>
  <pre>You exposed port ${safePort} but the container isn't serving anything on it. Start a SUPERVISED server first &mdash; in chat: <code>sandbox.startProcess("python3 -m http.server ${safePort} --directory /workspace/&lt;app&gt;")</code> for a static site, or <code>sandbox.startProcess("node server.js", {cwd:"/workspace/&lt;app&gt;"})</code> for Node &mdash; then call <code>sandbox.exposePort(${safePort})</code> again.</pre>
  <p class="hint">Supervised processes come back by themselves after a container restart; bare nohup jobs do not. If a supervised server was running, restart is already underway &mdash; refresh this page in a moment.</p>
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
