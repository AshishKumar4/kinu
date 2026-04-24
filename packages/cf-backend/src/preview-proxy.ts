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
    return new Response(
      `preview proxy error: ${(err as Error).message}`,
      { status: 502 },
    );
  }
}

/** Minimal surface of the Sandbox DO we depend on (avoid importing the class). */
interface SandboxRpcSurface {
  validatePortToken(port: number, token: string): Promise<boolean>;
  containerFetch(request: Request, port: number): Promise<Response>;
  fetch(request: Request): Promise<Response>;
}
