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

export async function handleLandingRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

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
