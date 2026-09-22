/**
 * Sandbox previews on the preview host; routing and token validation are the @cloudflare/sandbox SDK's.
 * The label is proven against the published KV exposures first: `proxyToSandbox` creates a Durable Object per guessed hostname.
 */

import { getSandbox, proxyToSandbox, type SandboxEnv } from "@cloudflare/sandbox";
import { diagnostics, toKinuError } from "@kinu.run/core/obs";
import { escapeHtml } from "@kinu.run/core";
import { containPreviewResponse, sandboxPreviewLabelOf } from "@kinu.run/core";
import { isKinuSandboxId } from "@kinu.run/core";
import { sandboxPreviewExposed, type PreviewSuffixEnv } from "@kinu.run/core";
import type { KvStore } from "@kinu.run/agent-utils";
import { sanitizePreviewRequestHeaders } from "./lib/preview-request";
import type { KinuSandbox } from "./kinu-sandbox";
import { SANDBOX_TRANSPORT } from "./sandbox-exec-lane";

/** `proxyToSandbox`'s response for every forward failure; `unit-preview-origin.test.ts` pins the shape. */
const SDK_FORWARD_FAILURE = { status: 500, body: 'Proxy routing error' } as const;

/**
 * SDK answer for a valid port token whose exposure is not live (transcribed from `stalePreviewURLResponse`; pinned by the suite).
 * Safe to act on: the object only returns it after the token matched.
 */
const SDK_STALE_PREVIEW = {
  status: 410,
  body: JSON.stringify({
    error: 'Preview URL is stale because the sandbox runtime is not active',
    code: 'STALE_PREVIEW_URL',
  }),
} as const;

/** One refusal shape for every unserved hostname, so it is not an existence oracle. */
function refusePreview(code: string, error: string, status: number): Response {
  return containPreviewResponse(new Response(
    JSON.stringify({ error, code }),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  ));
}

/** `Sandbox` is optional: a deployment can omit the binding; the SDK accepts nothing narrower than the full namespace. */
export interface SandboxPreviewEnv extends PreviewSuffixEnv {
  Sandbox?: DurableObjectNamespace<KinuSandbox>;
  AUTH_KV?: KvStore;
}

/** Always answers; an unpublished hostname gets a 404, never the app and never a Durable Object. */
export async function servePreviewRequest(request: Request, env: SandboxPreviewEnv): Promise<Response> {
  const url = new URL(request.url);
  const label = sandboxPreviewLabelOf(url, env);

  // Refused on shape, before any lookup.
  if (label === null || !isKinuSandboxId(label.sandboxId)) {
    return refusePreview('NOT_A_PREVIEW', 'This host serves sandbox previews only.', 404);
  }

  // Fail closed.
  if (!env.AUTH_KV || !env.Sandbox) {
    return refusePreview('PREVIEW_UNAVAILABLE', 'Preview routing is unavailable.', 503);
  }

  const containers: SandboxEnv<KinuSandbox> = { Sandbox: env.Sandbox };

  if (!(await sandboxPreviewExposed(env.AUTH_KV, label))) {
    diagnostics.event('preview.unpublished_label', { sandboxId: label.sandboxId, port: label.port });

    return refusePreview(
      'PREVIEW_NOT_EXPOSED',
      'This preview is not exposed. Re-expose the port to publish it again.',
      404,
    );
  }

  const forward = (): Promise<Response | null> => proxyToSandbox(new Request(request, {
    headers: sanitizePreviewRequestHeaders(request.headers),
  }), containers);

  let response = await forward();

  if (!response) {
    return refusePreview('NOT_A_PREVIEW', 'This host serves sandbox previews only.', 404);
  }

  // One repair, one re-issue: the re-issue is the test of whether the repair worked; no retry loop.
  if (request.method === 'GET' && await isStalePreview(response)) {
    await repairStalePreview(label.sandboxId, containers);
    const reissued = await forward();

    if (reissued !== null) response = reissued;
  }

  if (response.status === SDK_FORWARD_FAILURE.status
    && (await response.clone().text()) === SDK_FORWARD_FAILURE.body) {
    return renderNotReadyPage(url.hostname);
  }

  return containPreviewResponse(response);
}

async function isStalePreview(response: Response): Promise<boolean> {
  return response.status === SDK_STALE_PREVIEW.status
    && (await response.clone().text()) === SDK_STALE_PREVIEW.body;
}

/**
 * `ensureReady` re-exposes each recorded port with its original token, so the same URL works; it is singleflight.
 * Best effort: a failure keeps the stale 410 for the visitor rather than a 500.
 */
async function repairStalePreview(sandboxId: string, env: SandboxEnv<KinuSandbox>): Promise<void> {
  try {
    // The SDK drops in-flight requests if an id's transport changes, so every call site passes SANDBOX_TRANSPORT.
    await getSandbox(env.Sandbox, sandboxId, {
      normalizeId: true, transport: SANDBOX_TRANSPORT,
    }).ensureReady();
  } catch (cause) {
    diagnostics.failure('preview.stale_repair_failed', toKinuError({
      doing: 'restoring the container behind a stale preview URL',
      cause,
      otherwise: 'unavailable',
    }), { sandboxId });
  }
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
  <p>Port <code>${safePort}</code> is public, but the container did not accept the connection.</p>
  <p>Usually nothing is listening on it yet: the agent exposed the port before it started a server. You can send the agent this:</p>
  <pre>You exposed port ${safePort}, but nothing in the container is serving on it. Start a supervised server first. For a static site: <code>sandbox.startProcess("python3 -m http.server ${safePort} --directory /workspace/&lt;app&gt;")</code>. For Node: <code>sandbox.startProcess("node server.js", {cwd:"/workspace/&lt;app&gt;"})</code>. Then call <code>sandbox.exposePort(${safePort})</code> again.</pre>
  <p class="hint">A supervised process comes back on its own after the container restarts; a bare nohup job does not. If a supervised server was running, it is already restarting, so reload this page in a moment.</p>
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
