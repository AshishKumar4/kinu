import {
  previewHostSuffix, previewPortSuffix, previewSuffixMetaName, type PreviewPortEnv, type PreviewSuffixEnv,
} from '../preview/preview-origin';
import type { AssetFetcher } from './deployed-assets';
import { withAppSecurityHeaders } from './security-headers';

interface AppShellEnv extends PreviewSuffixEnv, PreviewPortEnv {
  readonly ASSETS: AssetFetcher;
}

/** The app's own faces: a slate's page, on a preview host, sets its text in them as the chat does. Public, credential-free. */
const SHARED_FONTS = '/assets/fonts/';

export async function serveApp(request: Request, env: AppShellEnv): Promise<Response> {
  const suffix = previewHostSuffix(env);
  const asset = await env.ASSETS.fetch(request);

  if (new URL(request.url).pathname.startsWith(SHARED_FONTS) && asset.ok) {
    const headers = new Headers(asset.headers);
    headers.set('access-control-allow-origin', '*');

    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  }

  const configured = suffix && asset.headers.get('content-type')?.includes('text/html')
    ? new HTMLRewriter().on('head', {
        element(element) {
          element.append(`<meta name="${previewSuffixMetaName()}" content="${suffix}">`, { html: true });
        },
      }).transform(asset)
    : asset;

  return withAppSecurityHeaders(
    configured,
    new URL(request.url),
    suffix ? `https://*.${suffix}${previewPortSuffix(env)}` : null,
  );
}
