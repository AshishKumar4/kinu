import {
  previewHostSuffix, previewPortSuffix, previewSuffixMetaName, type PreviewPortEnv, type PreviewSuffixEnv,
} from '../preview/preview-origin';
import type { AssetFetcher } from './deployed-assets';
import { withAppSecurityHeaders } from './security-headers';

interface AppShellEnv extends PreviewSuffixEnv, PreviewPortEnv {
  readonly ASSETS: AssetFetcher;
}

/** The app's own faces: a slate's page, on a preview host, sets its text in them as the chat does. Public, credential-free. */
export const APP_FONTS_PATH = '/assets/fonts/';

/** What an app asset's response adds for another origin: only the faces are read cross-origin, by a slate's page. */
export function appAssetCorsHeaders(pathname: string): Readonly<Record<string, string>> {
  return pathname.startsWith(APP_FONTS_PATH) ? { 'access-control-allow-origin': '*' } : {};
}

export async function serveApp(request: Request, env: AppShellEnv): Promise<Response> {
  const suffix = previewHostSuffix(env);
  const asset = await env.ASSETS.fetch(request);

  const cors = Object.entries(appAssetCorsHeaders(new URL(request.url).pathname));

  if (cors.length > 0 && asset.ok) {
    const headers = new Headers(asset.headers);

    for (const [name, value] of cors) headers.set(name, value);

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
