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

export async function serveApp(request: Request, env: AppShellEnv): Promise<Response> {
  const suffix = previewHostSuffix(env);
  const asset = await env.ASSETS.fetch(request);

  if (!asset.headers.get('content-type')?.includes('text/html')) return asset;
  // The page names the build that served it, from the stamp /api/health reads, so the two agree by construction.
  const build = await readBuildStamp(env, request.url);

  const named = new HTMLRewriter().on('head', {
    element(element) {
      if (suffix) element.append(`<meta name="${previewSuffixMetaName()}" content="${suffix}">`, { html: true });

      if (build !== null) element.append(`<meta name="${PAGE_BUILD_META}" content="${escapeHtml(build.sha)}">`, { html: true });
    },
  }).transform(asset);

  return withAppSecurityHeaders(
    named,
    new URL(request.url),
    suffix ? `https://*.${suffix}${previewPortSuffix(env)}` : null,
  );
}
