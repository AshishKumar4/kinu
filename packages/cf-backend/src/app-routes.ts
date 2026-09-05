/**
 * The SPA's path table.
 *
 * It exists because a browser render-failure report has to say WHERE it broke,
 * and `location.pathname` is not a thing that may be said: every path this app
 * routes but two carries a workspace name the owner chose, so a report keyed on
 * the raw path publishes account content into a log sink. The answer is the
 * TEMPLATE — `/workspace/:agentId`, never `/workspace/quarterly-billing-fix` —
 * which is a fixed vocabulary of nine strings and identifies the surface just as
 * precisely.
 *
 * `App.tsx` reads its `path` props from here rather than spelling them again,
 * and that direction is the whole point: a route added to the router without
 * being added here would report as {@link UNMATCHED_ROUTE}, and a hand-kept
 * second copy of a path list is the drift this file exists to make impossible.
 * The server validates a reported route against this same set, so the closed
 * vocabulary is also what stops an arbitrary string reaching Workers Logs.
 */

/**
 * Every path `App.tsx` routes, by the name the router knows it as. `home` is the
 * index route, which is `/`.
 */
export const APP_ROUTES = {
  home: '/',
  userSettings: '/user/settings',
  userMcp: '/user/settings/mcp',
  workspace: '/workspace/:agentId',
  workspaceAgent: '/workspace/:agentId/agents/:subName',
  explore: '/mcts/:agentId',
  control: '/control',
  agentSettings: '/settings/:agentId',
  triggers: '/triggers/:agentId',
} as const;

/** Internal: `ReportedRoute` is the type that leaves this module, and it is the
 *  one a report's field is typed by. */
type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES];

/**
 * What a path outside the table reports as.
 *
 * A path, never a word: it sits in the same field as the nine templates, and a
 * reader scanning that field should not have to know which values are paths and
 * which are prose. Reached by a 404 the SPA fallback served, and by a route
 * someone added to the router and not to `APP_ROUTES` — which is a finding
 * rather than a crash.
 */
const UNMATCHED_ROUTE = '/unmatched';

/** Everything the `route` field of a client report may hold. */
export type ReportedRoute = AppRoute | typeof UNMATCHED_ROUTE;

export const REPORTED_ROUTES: readonly ReportedRoute[] = [
  ...Object.values(APP_ROUTES),
  UNMATCHED_ROUTE,
];

/**
 * The template a pathname resolves to.
 *
 * Matched on segments rather than by regex: a `:param` segment matches anything
 * and a literal segment matches itself, which is react-router's own rule for the
 * paths this table holds (none uses a splat or an optional segment). No two
 * templates share a segment count and a first literal, so the scan cannot be
 * order-dependent.
 *
 * A trailing slash is dropped before the split so `/control/` and `/control`
 * are one route. Query strings never arrive here: the caller passes
 * `location.pathname`, and a search string is account content of exactly the
 * kind this function exists to keep out.
 */
export function routeTemplateOf(pathname: string): ReportedRoute {
  const segments = pathname.replace(/\/+$/u, '').split('/');
  for (const template of Object.values(APP_ROUTES)) {
    const wanted = template.replace(/\/+$/u, '').split('/');
    if (wanted.length !== segments.length) continue;
    if (wanted.every((part, at) => part.startsWith(':') || part === segments[at])) return template;
  }
  return UNMATCHED_ROUTE;
}
