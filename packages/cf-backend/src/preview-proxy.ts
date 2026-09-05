/**
 * Sandbox container previews, served on the preview host.
 *
 * Routing is the @cloudflare/sandbox SDK's own: `exposePort` mints
 * `https://<port>-<sandbox>-<token>.<PREVIEW_HOST_SUFFIX>/` and
 * `proxyToSandbox` parses that hostname back into a sandbox, validates the
 * port's secret token inside the Durable Object, and forwards to the container
 * (WebSocket upgrades included). Kinu adds only what the SDK has no opinion
 * about: this host serves previews and nothing else, responses are contained
 * (lib/preview-origin.ts), a failed forward gets a page a user can act on
 * instead of a bare `Proxy routing error`, and a preview whose exposure did not
 * survive a container recycle gets ONE repair.
 *
 * AND ONE THING THE SDK CANNOT DO FROM HERE: refuse a hostname nobody minted
 * before an object exists. `proxyToSandbox` resolves the sandbox id into a
 * Durable Object stub — the act that creates one — and only then hands the
 * token to that object to validate. This host is step 1 of the route table,
 * ahead of authentication, so an anonymous GET to a guessed hostname used to
 * instantiate a container object and its SQLite, once per guess. So the label
 * is proven against the exposures this deployment published
 * (lib/preview-exposures.ts) BEFORE the SDK is handed the request. That record
 * is a KV projection with no object behind a key: proving a forged label wrong
 * allocates nothing. The container object still validates the port token and
 * its runtime activation on every forward — this gate decides only whether the
 * question is asked at all.
 */

import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";
import { diagnostics, toKinuError } from "@kinu.run/core/obs";
import { escapeHtml } from "./lib/http";
import { containPreviewResponse, sandboxPreviewLabelOf } from "./lib/preview-origin";
import { isKinuSandboxId, sandboxPreviewExposed } from "./lib/preview-exposures";
import { sanitizePreviewRequestHeaders } from "./lib/preview-request";
import { SANDBOX_TRANSPORT } from "./sandbox-exec-lane";

/**
 * `proxyToSandbox` collapses every forwarding failure — overwhelmingly "the
 * container is not listening on port N" — into this one response. Matching it
 * is how the friendly page below gets shown; `unit-preview-origin.test.ts`
 * pins the shape so an SDK upgrade that changes it fails loudly.
 */
const SDK_FORWARD_FAILURE = { status: 500, body: 'Proxy routing error' } as const;

/**
 * The Durable Object's answer when the port token IS VALID but the exposure it
 * names is not live: the container is stopped or unhealthy, or the activation
 * belongs to a runtime generation that has been replaced
 * (`stalePreviewURLResponse` / `validatePreviewURLForRuntime` in the shipped
 * bundle). Transcribed from that method — a method, not an importable value,
 * so the transcription is pinned by the suite instead of the type checker.
 *
 * AUTHENTICATED BY CONSTRUCTION, and that is what makes it safe to act on: the
 * DO returns 404 `INVALID_TOKEN` for a token that does not match the port's
 * stored one, and only reaches this answer after the match. A request that
 * guessed a hostname cannot make Kinu touch a container.
 */
const SDK_STALE_PREVIEW = {
  status: 410,
  body: JSON.stringify({
    error: 'Preview URL is stale because the sandbox runtime is not active',
    code: 'STALE_PREVIEW_URL',
  }),
} as const;

/** One refusal shape for every hostname this host will not serve, so a forged
 *  label for a real workspace and one for a workspace that never existed are
 *  the same answer and neither is an existence oracle. */
function refusePreview(code: string, error: string, status: number): Response {
  return containPreviewResponse(new Response(
    JSON.stringify({ error, code }),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  ));
}

/**
 * Serve a request that arrived on the preview host. Always answers: a hostname
 * this deployment did not publish as an exposed port gets a 404, never the app,
 * and never a Durable Object.
 */
export async function servePreviewRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const label = sandboxPreviewLabelOf(url, env);
  // The whole preview subtree is claimed by this host, so most of what arrives
  // here is not a preview label at all: a bare guess, a scanner, a mistyped
  // hostname. Refused on shape, before any lookup.
  if (label === null || !isKinuSandboxId(label.sandboxId)) {
    return refusePreview('NOT_A_PREVIEW', 'This host serves sandbox previews only.', 404);
  }
  // Fail closed. Without the projection there is nothing to prove the label
  // against, and an unprovable label is exactly what must not reach the SDK.
  if (!env.AUTH_KV) {
    return refusePreview('PREVIEW_UNAVAILABLE', 'Preview routing is unavailable.', 503);
  }
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
  }), env);

  let response = await forward();
  // A published label the SDK will not route is a disagreement between the
  // projection and the object's own state, not a guess: the same refusal.
  if (!response) {
    return refusePreview('NOT_A_PREVIEW', 'This host serves sandbox previews only.', 404);
  }

  // ONE repair, then ONE re-issue. The count is structural rather than a retry
  // budget: a repair has exactly one before and one after, and the re-issue is
  // also the only honest test of whether the repair worked — the container's own
  // re-validation of the port token, not an inference from a lifecycle call
  // returning. A second stale answer means the exposure did not come back
  // (a server that no longer listens on the port is the usual reason), which is
  // the box's problem to report and not something more attempts reach.
  if (request.method === 'GET' && await isStalePreview(response)) {
    await repairStalePreview(label.sandboxId, env);
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
 * Re-drive the box that minted this preview URL, so the port comes back on its
 * STORED spec.
 *
 * `ensureReady` is the repair, whole: it starts a stopped container and awaits
 * the restoration that re-exposes each recorded port with the token its URL was
 * built on — which is why the same URL works afterwards rather than a new one
 * having to be handed out. It is singleflight on the box's own lifecycle
 * generation, so a page whose twenty assets all 410 at once joins one attempt
 * instead of starting twenty.
 *
 * Best effort, and deliberately silent to the visitor: a box that refuses to
 * become ready has already recorded why in its own incident ledger, and the
 * answer this visitor gets is the stale 410 either way. Turning a stale preview
 * into a 500 would lose the classification the caller needs.
 */
async function repairStalePreview(sandboxId: string, env: Env): Promise<void> {
  if (!env.Sandbox) return;
  try {
    // {@link SANDBOX_TRANSPORT}, the one value every Kinu getSandbox call site
    // passes: the SDK persists the transport and drops in-flight requests when
    // it changes mid-life for an id.
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
