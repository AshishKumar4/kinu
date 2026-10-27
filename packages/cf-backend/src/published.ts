/** What every response a published host serves carries, from whichever of the deployment's Workers answered it. */
import { hostOf, isPreviewHostRequest, WORKER_VERSION_HEADER, type PreviewHostEnv } from '@kinu.run/core';

export interface PublishedEnv extends PreviewHostEnv {
  readonly CF_VERSION_METADATA?: { readonly id: string };
}

/** Dev hosts (localhost, LAN) match neither and stay on plain HTTP. */
export function isPublishedHost(url: URL, env: PublishedEnv): boolean {
  if (isPreviewHostRequest(url, env)) return true;

  return url.hostname.toLowerCase() === hostOf(env.CLI_PUBLIC_ORIGIN);
}

/** Nothing upstream redirects: measured 2026-08-16, plain HTTP reached the Worker
 *  and `url.protocol` is the client-facing scheme (no `CF-Visitor` needed). */
export function httpsUpgrade(url: URL, env: PublishedEnv): Response | null {
  if (url.protocol !== 'http:' || !isPublishedHost(url, env)) return null;

  // Drop the port: other plaintext ports have no TLS counterpart on this zone.
  return Response.redirect(`https://${url.hostname}${url.pathname}${url.search}`, 301);
}

const HSTS = 'max-age=31536000; includeSubDomains';

/** HSTS, and the version that answered. `includeSubDomains`
 *  deliberately covers preview hosts (the zone cert has the wildcard); no `preload`. A new version reaches the edge
 *  over seconds, so the version a deploy's smoke test reads is the one that answered it, not the one it just uploaded
 *  (2026-10-08: 23 s after the deploy of b8340eebf, one of its requests was answered by the reset placeholder before
 *  it). A response the front Worker passed on from the main Worker keeps the main Worker's version, which made it.
 *  101 passes untouched: handshake headers are immutable. */
export function published(response: Response, url: URL, env: PublishedEnv): Response {
  if (url.protocol !== 'https:' || response.status === 101 || !isPublishedHost(url, env)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('strict-transport-security', HSTS);

  if (env.CF_VERSION_METADATA !== undefined && !headers.has(WORKER_VERSION_HEADER)) headers.set(WORKER_VERSION_HEADER, env.CF_VERSION_METADATA.id);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
