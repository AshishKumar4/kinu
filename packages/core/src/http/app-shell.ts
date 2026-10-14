import {
  previewHostSuffix, previewPortSuffix, previewSuffixMetaName, type PreviewPortEnv, type PreviewSuffixEnv,
} from '../preview/preview-origin';
import { readBuildStamp, type AssetFetcher } from './deployed-assets';
import { escapeHtml } from './http';
import { PAGE_BUILD_META } from '../web/page-build';
import { withAppSecurityHeaders } from './security-headers';

interface AppShellEnv extends PreviewSuffixEnv, PreviewPortEnv {
  readonly ASSETS: AssetFetcher;
}

/** A file the client build names by its content: `<name>-<8-char hash>.<ext>` directly under /assets/. */
const CONTENT_NAMED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/u;

/**
 * How long a browser keeps what the app's files answer: the one place that decides it; null keeps the assets service's
 * own answer (`max-age=0, must-revalidate`).
 * - The shell is never kept: Chrome answers Back and a restored session from its disk cache unasked under the assets'
 *   default `max-age=0, must-revalidate`, and under `no-cache`, so a workspace reopened that way ran whichever build
 *   last loaded at its address; under `no-store` it loads the current one (Chrome 2026-10-13, staging and a local
 *   server).
 * - A content-named file's bytes never change under that name, so it is kept and never asked for again: under the
 *   assets' answer a returning page revalidated each of its 65 modules through this Worker before it drew
 *   (cmp-kinu-ux2, 2026-10-13). Files kept under their own names (the fonts, the icon) keep that answer.
 */
function cachePolicy(pathname: string, status: number, html: boolean): string | null {
  if (html) return 'no-store';

  if (CONTENT_NAMED_ASSET.test(pathname) && (status === 200 || status === 304)) return 'public, max-age=31536000, immutable';

  return null;
}

/** `response` answered under its {@link cachePolicy}. */
function cached(response: Response, url: URL): Response {
  const policy = cachePolicy(url.pathname, response.status, response.headers.get('content-type')?.includes('text/html') ?? false);

  if (policy === null) return response;
  const headers = new Headers(response.headers);

  headers.set('cache-control', policy);

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function serveApp(request: Request, env: AppShellEnv): Promise<Response> {
  const suffix = previewHostSuffix(env);
  const asset = await env.ASSETS.fetch(request);
  const url = new URL(request.url);

  if (!asset.headers.get('content-type')?.includes('text/html')) return cached(asset, url);
  // The page names the build that served it, from the stamp /api/health reads, so the two agree by construction.
  const build = await readBuildStamp(env, request.url);

  const named = new HTMLRewriter().on('head', {
    element(element) {
      if (suffix) element.append(`<meta name="${previewSuffixMetaName()}" content="${suffix}">`, { html: true });

      if (build !== null) element.append(`<meta name="${PAGE_BUILD_META}" content="${escapeHtml(build.sha)}">`, { html: true });
    },
  }).transform(asset);

  return cached(withAppSecurityHeaders(named, url, suffix ? `https://*.${suffix}${previewPortSuffix(env)}` : null), url);
}
