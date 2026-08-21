/**
 * `/` for a visitor with no session.
 *
 * The page itself is `lib/public-pages.ts`. This decides who sees it: a request
 * that authenticates falls through to the SPA, and only a 401 gets the front
 * page. Anything else the session layer throws is a real failure and is not
 * answered with marketing.
 */

import { AuthError, authenticateRequest } from './auth/session';
import { buildCliInstallCommand } from './cli/install-command';
import { publicHtmlHeaders } from './lib/security-headers';
import { landingDocument } from './lib/public-pages';
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

  const headers = publicHtmlHeaders();
  if (request.method === 'HEAD') return new Response(null, { headers });
  const install = buildCliInstallCommand({ origin: url.origin });
  return new Response(landingDocument(install), { headers });
}
