/**
 * The door's paths, spelled once.
 *
 * Four readers: the client (`door.ts`) builds calls under `DEPLOY_API`, the
 * backend's route table answers them, its auth gate asks `isDeployPath` before
 * there is any identity to check, and the guided page is served at
 * `DEPLOY_PAGE_PATH`. A second spelling of any of them is a 404 or an open
 * surface that nobody sees until somebody's install.
 */

export const DEPLOY_API = '/api/deploy';

export const DEPLOY_PAGE_PATH = '/deploy';

/** Where Cloudflare sends the browser back to. A GET the browser navigates, so
 *  it carries no run key — what proves it is the browser that started the leg
 *  is the `__Host-kinu_deploy_state` cookie the authorize leg set. */
export const DEPLOY_CALLBACK_PATH = '/deploy/callback';

/** The paths the door owns: answered before the auth gate, and by the page
 *  itself before the login redirect. */
export function isDeployPath(pathname: string): boolean {
  return pathname === DEPLOY_PAGE_PATH
    || pathname.startsWith(`${DEPLOY_API}/`)
    || pathname === DEPLOY_CALLBACK_PATH;
}
