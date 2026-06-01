/**
 * Path-based preview proxy.
 *
 * The @cloudflare/sandbox SDK's built-in proxyToSandbox() requires a
 * custom domain with a wildcard DNS record so it can route
 * `PORT-SANDBOX-TOKEN.hostname` requests. The Proteus zone has no
 * wildcard CNAME (and the wrangler OAuth token lacks zone:write to
 * create one), so we route previews through a path prefix on the main
 * domain instead. Security is preserved: the sandbox DO still gates
 * access with validatePortToken.
 *
 * Path scheme (matches what exposeSandboxPort returns):
 *
 *   /_preview/<port>/<sandbox-id>/<token>/<rest...>
 *
 * The <rest...> portion (plus the query string) is forwarded to the
 * container at `http://localhost:<port>/<rest...>?<query>` via the
 * Sandbox DO's containerFetch method. WebSocket upgrades are forwarded
 * via sandbox.fetch() on a synthesized URL the SDK understands.
 */

import { getSandbox } from "@cloudflare/sandbox";

const PREFIX = "/_preview/";

interface PreviewRoute {
  port: number;
  sandboxId: string;
  token: string;
  /** Path inside the sandbox app, always starts with "/". */
  innerPath: string;
}

/**
 * Parse `/_preview/8080/proteus-express-e2e-abc/tok/<rest>` → components.
 * Returns null when the prefix doesn't match or fields are malformed.
 */
export function parsePreviewRoute(url: URL): PreviewRoute | null {
  if (!url.pathname.startsWith(PREFIX)) return null;
  const rest = url.pathname.slice(PREFIX.length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash === -1) return null;
  const portStr = rest.slice(0, firstSlash);
  if (!/^\d{4,5}$/.test(portStr)) return null;
  const port = Number.parseInt(portStr, 10);
  if (port < 1024 || port > 65535) return null;

  const afterPort = rest.slice(firstSlash + 1);
  const sandboxSlash = afterPort.indexOf("/");
  if (sandboxSlash === -1) return null;
  const sandboxId = afterPort.slice(0, sandboxSlash);
  if (!sandboxId || sandboxId.length > 128) return null;

  const afterSandbox = afterPort.slice(sandboxSlash + 1);
  const tokenSlash = afterSandbox.indexOf("/");
  // Tokens are [a-z0-9_]+, up to 63 chars (matches SDK constraints).
  let token: string;
  let innerPath: string;
  if (tokenSlash === -1) {
    token = afterSandbox;
    innerPath = "/";
  } else {
    token = afterSandbox.slice(0, tokenSlash);
    innerPath = "/" + afterSandbox.slice(tokenSlash + 1);
  }
  if (!/^[a-z0-9_]+$/i.test(token) || token.length === 0 || token.length > 63) return null;

  return { port, sandboxId, token, innerPath };
}

/**
 * Build the public URL an agent should hand out. The hostname is the
 * main site (no wildcard DNS needed), and the preview lives under
 * `/_preview/…`.
 */
export function buildPreviewUrl(hostname: string, route: Omit<PreviewRoute, "innerPath">): string {
  return `https://${hostname}${PREFIX}${route.port}/${route.sandboxId}/${route.token}/`;
}

/**
 * If `request` targets `/_preview/…`, validate the token with the
 * sandbox DO and forward to the container. Otherwise return null so
 * the Worker falls through to its normal routing.
 */
export async function proxyPreviewRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const route = parsePreviewRoute(url);
  if (!route) return null;

  const { port, sandboxId, token, innerPath } = route;

  // Re-use the SDK's getSandbox so we share the same DO namespacing
  // (normalizeId:true lower-cases the id for DNS compat; it's still
  // required here because the stored token was written by the same
  // DO instance).
  const sandbox = getSandbox(
    env.Sandbox as Parameters<typeof getSandbox>[0],
    sandboxId,
    { normalizeId: true },
  ) as unknown as SandboxRpcSurface;

  let valid: boolean;
  try {
    valid = await sandbox.validatePortToken(port, token);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `preview token check failed: ${(err as Error).message}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!valid) {
    return new Response(
      JSON.stringify({ error: "Access denied: Invalid token or port not exposed", code: "INVALID_TOKEN" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // WebSocket upgrade: the SDK only exposes a single entry point
  // (sandbox.fetch) that can switch ports via the URL; synthesize a
  // hostname the SDK understands and let it pass through.
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const wsUrl = new URL(request.url);
    wsUrl.pathname = innerPath;
    // The SDK's switchPort rewrites `:PORT` in the host; we build a
    // localhost URL because the DO's fetch() accepts it.
    const forwarded = new Request(`http://localhost:${port}${innerPath}${wsUrl.search}`, request);
    return await sandbox.fetch(forwarded);
  }

  const forwardedUrl = `http://localhost:${port}${innerPath}${url.search}`;
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Host", url.hostname);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  headers.set("X-Sandbox-Name", sandboxId);
  headers.set("X-Original-URL", request.url);

  const forwardedReq = new Request(forwardedUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    // @ts-expect-error — duplex is required by the runtime but not in lib.dom
    duplex: "half",
  });

  try {
    return await sandbox.containerFetch(forwardedReq, port);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    // The sandbox SDK surfaces "container is not listening" when the
    // exposed port has nothing serving it. Render a clear, actionable
    // page instead of dumping the raw error.
    if (/not listening/i.test(msg) || /ECONNREFUSED/i.test(msg)) {
      return renderNotListeningPage({ port, sandboxId, hostname: url.hostname });
    }
    return renderProxyErrorPage({ port, sandboxId, message: msg });
  }
}

// ── User-facing error pages ──────────────────────────────────────

function renderNotListeningPage(opts: {
  port: number; sandboxId: string; hostname: string;
}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Preview not ready · :${opts.port}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #0b0b0c; color: #e4e4e7;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 2rem;
  }
  .card {
    max-width: 640px; width: 100%;
    background: #18181b; border: 1px solid #27272a; border-radius: 12px;
    padding: 2rem; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; display: flex; align-items: center; gap: 0.5rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; }
  p { line-height: 1.6; color: #a1a1aa; font-size: 0.95rem; margin: 0.5rem 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #27272a; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.85em; }
  pre {
    background: #0a0a0b; border: 1px solid #27272a; border-radius: 6px;
    padding: 0.75rem 1rem; overflow-x: auto; font-size: 0.8rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #d4d4d8; white-space: pre-wrap; word-break: break-word;
  }
  .hint { color: #71717a; font-size: 0.85rem; margin-top: 1rem; }
  .meta { color: #52525b; font-size: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #27272a; }
  button {
    background: #3b82f6; color: white; border: 0; border-radius: 6px;
    padding: 0.5rem 1rem; font-size: 0.85rem; font-weight: 500; cursor: pointer;
    margin-top: 1rem;
  }
  button:hover { background: #2563eb; }
</style>
</head>
<body>
<div class="card">
  <h1><span class="dot"></span> Preview not ready</h1>
  <p>Port <code>${opts.port}</code> is exposed publicly but <strong>nothing is listening on it inside the sandbox container yet</strong>.</p>
  <p>This usually means the agent exposed the port before starting a server on it. Ask the agent:</p>
  <pre>You exposed port ${opts.port} but the container isn't serving anything on it. Please start a server first (e.g. <code>nohup python3 -m http.server ${opts.port} --directory /workspace/&lt;app&gt; &gt; /tmp/srv.log 2>&amp;1 &amp;</code> for static sites, or <code>nohup node server.js &gt; /tmp/srv.log 2&gt;&amp;1 &amp;</code> for Node), wait ~1s for it to bind, then verify with <code>sandbox.listPorts()</code>.</pre>
  <p class="hint">Once the agent starts a listener, refresh this page and the preview will appear.</p>
  <button onclick="location.reload()">Reload preview</button>
  <div class="meta">sandbox=${opts.sandboxId} · port=${opts.port}</div>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderProxyErrorPage(opts: { port: number; sandboxId: string; message: string }): Response {
  // Escape HTML in the message to prevent any reflected injection.
  const safeMsg = String(opts.message).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Preview error · :${opts.port}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #0b0b0c; color: #e4e4e7;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 2rem;
  }
  .card { max-width: 640px; background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin-right: 0.5rem; }
  pre { background: #0a0a0b; border: 1px solid #27272a; border-radius: 6px; padding: 0.75rem 1rem; overflow-x: auto; font-size: 0.8rem; color: #fca5a5; white-space: pre-wrap; word-break: break-word; }
  .meta { color: #52525b; font-size: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #27272a; }
</style>
</head>
<body>
<div class="card">
  <h1><span class="dot"></span> Preview proxy error</h1>
  <pre>${safeMsg}</pre>
  <div class="meta">sandbox=${opts.sandboxId} · port=${opts.port}</div>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Minimal surface of the Sandbox DO we depend on (avoid importing the class). */
interface SandboxRpcSurface {
  validatePortToken(port: number, token: string): Promise<boolean>;
  containerFetch(request: Request, port: number): Promise<Response>;
  fetch(request: Request): Promise<Response>;
}
