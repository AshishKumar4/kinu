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
  explore: '/mcts/:agentId',
  control: '/control',
  agentSettings: '/settings/:agentId',
  triggers: '/triggers/:agentId',
  /** The Drive's My stuff; a folder below it is `driveFolder`, and what is shared either way is `shared`. */
  drive: '/drive',
  /** The Drive below its root: `*` is the folder path, any depth. */
  driveFolder: '/drive/*',
  shared: '/shared',
  sharedBlueprint: '/shared/blueprint/:id',
  deploy: '/deploy',
  updates: '/updates',
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

    if (wanted.slice(0, -1).every((part, at) => part === segments[at])) return template;
  }

  return UNMATCHED_ROUTE;
}
