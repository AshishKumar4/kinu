/**
 * `/` for a visitor with no session.
 *
 * The signed-out landing is a dedicated React entry. The Worker chooses who
 * sees it and streams the built asset. The browser derives its install command
 * from the request origin.
 */

import { AuthError, authenticateRequest } from './auth/session';
import { publicHtmlHeaders } from './lib/security-headers';
import { markDocument } from './lib/public-shell';

export async function handleLandingRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  // The favicon is generated from the same MARK_BODIES the pages render, so
  // the served icon cannot drift from the mark the code declares.
  if (url.pathname === '/assets/kinu-icon.svg') {
    return new Response(markDocument(), {
      headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600, must-revalidate' },
    });
  }
  if (url.pathname !== '/') return null;

  try {
    await authenticateRequest(request, env);
    return null;
  } catch (e) {
    if (!(e instanceof AuthError) || e.status !== 401) throw e;
  }

  const headers = new Headers(publicHtmlHeaders());
  if (request.method === 'HEAD') return new Response(null, { headers });

  const assetUrl = new URL('/landing.html', request.url);
  const asset = await env.ASSETS.fetch(assetUrl);
  if (!asset.ok) {
    throw new Error(`landing asset returned ${String(asset.status)}`);
  }
  headers.delete('content-length');
  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}
