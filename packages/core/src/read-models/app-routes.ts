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
  /** `overview`, `settings`, `new` or `desktop`: the workspace's own pages, under the bar the chats share. */
  workspaceView: '/workspace/:agentId/:view',
  explore: '/swarm/:agentId',
  control: '/control',
  drive: '/drive',
  /** The Drive below its root: `*` is the folder path, any depth. */
  driveFolder: '/drive/*',
  /** The Drive's Slates: every slate across the owner's workspaces. */
  slates: '/slates',
  shared: '/shared',
  /** A shared slate, live: everyone it is shared with uses it together here. `?k=` the link's key. */
  liveSlate: '/s/:workspace/:slate',
  /** One part of a shared slate, in its own frame inside the slate's page. */
  liveSlatePart: '/s/:workspace/:slate/parts/:part',
  /** Slates people listed for anyone to use. */
  gallery: '/gallery',
  /** One listed slate: what it uses, what a fork gets, and Open, Fork, Star. */
  gallerySlate: '/gallery/:workspace/:slate',
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

/**
 * A path on `origin`, never the auth flow, that the browser still reads as one when it resolves it again. A parser
 * strips tab or newline (`/\t/evil.example` is another host) and reads a backslash as a slash, and a dot segment,
 * spelled or percent-encoded, normalizes `/a/..//evil.example` to `//evil.example`, another host too. The path is
 * also checked decoded, for whatever reads it next.
 */
export function sanitizeReturnTo(input: string, origin: string): string {
  const raw = input.trim();
  const here = new URL(origin).origin;

  // One leading slash, so the parse below is a path against `here` and cannot fail on a host it does not accept.
  if (!raw.startsWith('/') || raw.startsWith('//') || hasControlOrBackslash(raw)) return '/';
  const resolved = new URL(raw, here);
  const decoded = percentDecoded(resolved.pathname);

  if (!isOnePath(resolved.pathname) || !isOnePath(decoded) || decoded.includes('\\')) return '/';
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  const again = new URL(path, here);

  if (resolved.origin !== here || again.origin !== here || `${again.pathname}${again.search}${again.hash}` !== path) return '/';

  if (decoded.startsWith('/auth/') || decoded === '/login' || decoded === '/logout') return '/';

  return path;
}

/** A path with one leading slash and no dot segment to climb with. */
function isOnePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && path.split('/').every((segment) => segment !== '.' && segment !== '..');
}

/** A control character, or a backslash a URL parser reads as a slash. */
function hasControlOrBackslash(text: string): boolean {
  return Array.from(text, (ch) => ch.codePointAt(0) ?? 0).some((code) => code < 0x20 || code === 0x7f || code === 0x5c);
}

/** Each `%XX` as its byte; a malformed escape stays as written rather than throwing. */
function percentDecoded(text: string): string {
  return text.replace(/%([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
