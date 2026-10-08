/** Route templates, so a client error report names the surface without leaking workspace names. `App.tsx`
 * reads its paths from here; the server validates reported routes against this set. */

/** Every path `App.tsx` routes; `home` is `/`. */
export const APP_ROUTES = {
  home: '/',
  userSettings: '/user/settings',
  welcome: '/welcome',
  workspaces: '/workspaces',
  plugins: '/plugins',
  devices: '/devices',
  userMcp: '/user/settings/mcp',
  workspace: '/workspace/:agentId',
  workspaceAgent: '/workspace/:agentId/agents/:subName',
  workspaceAgentPath: '/workspace/:agentId/agents/:subName/*',
  /** `overview`, `settings` or `new`: the workspace's own pages, under the bar the chats share. */
  workspaceView: '/workspace/:agentId/:view',
  explore: '/swarm/:agentId',
  control: '/control',
  drive: '/drive',
  /** The Drive below its root: `*` is the folder path, any depth. */
  driveFolder: '/drive/*',
  shared: '/shared',
  sharedBlueprint: '/shared/blueprint/:id',
  /** Where a person a live share names enters it: signed in, they are handed the share's ticket. */
  sharedLive: '/shared/live/:workspace/:share',
  deploy: '/deploy',
  updates: '/updates',
  /** Where a provider's sign-in ends in its helper window: it tells the tab that opened it, then closes. `?next=`
   *  is where that tab began, for a window the browser opened that cannot close itself. */
  connected: '/connected',
} as const;

type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES];

/** A path, not a word, so the field holds only paths. Reached by a 404 or a route missing from `APP_ROUTES`. */
const UNMATCHED_ROUTE = '/unmatched';

export type ReportedRoute = AppRoute | typeof UNMATCHED_ROUTE;

export const REPORTED_ROUTES: readonly ReportedRoute[] = [
  ...Object.values(APP_ROUTES),
  UNMATCHED_ROUTE,
];

/**
 * Segment match (react-router's rule for these paths); exact templates are order-independent and the
 * splat is tried last. Trailing slash dropped; callers pass `location.pathname`, never a query.
 */
export function routeTemplateOf(pathname: string): ReportedRoute {
  const segments = pathname.replace(/\/+$/u, '').split('/');
  const templates = Object.values(APP_ROUTES);

  for (const template of templates) {
    const wanted = template.replace(/\/+$/u, '').split('/');

    if (wanted.length !== segments.length || wanted.includes('*')) continue;

    if (wanted.every((part, at) => part.startsWith(':') || part === segments[at])) return template;
  }

  // Splats only after every exact template declined, so an exact page under a splat keeps its name.
  for (const template of templates) {
    const wanted = template.split('/');

    if (wanted.at(-1) !== '*' || segments.length <= wanted.length - 1) continue;

    if (wanted.slice(0, -1).every((part, at) => part.startsWith(':') || part === segments[at])) return template;
  }

  return UNMATCHED_ROUTE;
}
