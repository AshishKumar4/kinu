/** The attribute the app shell marks a visitor's page with on its root (`serveApp` with `VISITOR_SHELL`). */
export const VISITOR_PAGE_ATTRIBUTE = 'data-visitor';

// Declared locally, as page-build.ts does: core compiles with and without DOM libs.
declare const document: { documentElement: { hasAttribute(name: string): boolean } } | undefined;

/** Whether the server served this page to someone signed out, on a route anyone may open. */
export function pageIsVisitors(): boolean {
  if (!('document' in globalThis) || document === undefined) return false;

  return document.documentElement.hasAttribute(VISITOR_PAGE_ATTRIBUTE);
}
