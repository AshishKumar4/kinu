/** The meta the app shell names the build that served it in (`serveApp`). */
export const PAGE_BUILD_META = 'kinu-build';

// Declared locally, as preview-origin.ts does: core compiles with and without DOM libs.
declare const document: { querySelector(selectors: string): { content: string } | null } | undefined;

/**
 * The build that served this document, as its own head names it. A page the browser took from its cache names the
 * build it came from; a read of /api/health at load named the live one, so such a page never saw that it was stale.
 * Null when the build named none (`vite dev`).
 */
export function pageDeployedBuildSha(): string | null {
  if (!('document' in globalThis) || document === undefined) return null;

  return document.querySelector(`meta[name="${PAGE_BUILD_META}"]`)?.content ?? null;
}
