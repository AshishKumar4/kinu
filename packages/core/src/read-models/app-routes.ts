/** Route templates, so a client error report names the surface without leaking workspace names. `App.tsx`
 * reads its paths from here; the server validates reported routes against this set. */
import * as v from 'valibot';

/** Every path `App.tsx` routes; `home` is `/`. */
export const APP_ROUTES = {
  home: '/',
  /** A new workspace's mission, its own page: Home is the assistant's chat once the owner has one. */
  newWorkspace: '/new',
  userSettings: '/user/settings',
  welcome: '/welcome',
  workspaces: '/workspaces',
  plugins: '/plugins',
  devices: '/devices',
  mail: '/mail',
  userMcp: '/user/settings/mcp',
  workspace: '/workspace/:agentId',
  workspaceAgent: '/workspace/:agentId/agents/:subName',
  workspaceAgentPath: '/workspace/:agentId/agents/:subName/*',
  /** `overview`, `settings`, `new` or `desktop`: the workspace's own pages, under the bar the chats share. */
  workspaceView: '/workspace/:agentId/:view',
  swarm: '/swarm/:agentId',
  control: '/control',
  drive: '/drive',
  /** The Drive below its root: `*` is the folder path, any depth. */
  driveFolder: '/drive/*',
  /** The Drive's Slates: every slate across the owner's workspaces. */
  slates: '/slates',
  shared: '/shared',
  sharedBlueprint: '/shared/blueprint/:id',
  /** Where a person a live share names enters it: signed in, they are handed the share's ticket. */
  sharedLive: '/shared/live/:workspace/:share',
  /** One personal part of a shared slate, in the app's own frame inside the slate's page (`slatePartFramePath`). */
  liveSlatePart: '/s/:workspace/:slate/parts/:part',
  /** Apps and workspaces people listed for anyone to open or install, Kinu's own first. */
  explore: '/explore',
  /** One listed workspace blueprint: what it does, what is inside, what it needs, and Install. */
  exploreWorkspace: '/explore/workspaces/:blueprint',
  /** One listed slate: what it uses, what a fork gets, and Open, Fork, Star. */
  gallerySlate: '/gallery/:workspace/:slate',
  deploy: '/deploy',
  updates: '/updates',
  /** Where every connect run in a helper tab ends (`connectedPath`): it tells the tab that started it, then closes. */
  connected: '/connected',
} as const;

/**
 * What a connect's finish page tells the tab that started it, over the `CONNECT_CHANNEL` broadcast: the run it ends,
 * the service as the page names it ("Cloudflare", an MCP server's name), and why it did not connect, null when it did.
 * The run is the starting page's own unpredictable id, carried to the server with the connect's start and bound to its
 * OAuth state there, so a finish page that no callback reached names no run, and one run's end is no other run's.
 */
export const ConnectEndedSchema = v.object({ run: v.nullable(v.string()), service: v.string(), error: v.nullable(v.string()) });

export type ConnectEnded = v.InferOutput<typeof ConnectEndedSchema>;

/** A connect run's id as its start carries it to the server: unpredictable, so no other page or provider can name it. */
export const ConnectRunSchema = v.pipe(v.string(), v.uuid());

/** The same-origin broadcast a finish page answers on: it needs no opener, which a provider's pages may cut. */
export const CONNECT_CHANNEL = 'kinu-connected';

/** Connects a Cloudflare login's Workers AI to this account, for the run `beginConnect` began: a connect, never a
 *  sign-in, so a login under another email attaches here rather than signing in as another account. Cloudflare asks
 *  which login. The Worker's own tests start their connects here, so the address the button opens is the one proven. */
export function cloudflareConnectPath(run: string): string {
  return `/auth/cloudflare/start?${new URLSearchParams({ intent: 'connect', prompt: 'login', run }).toString()}`;
}

/** Where a connect ends, for every connect: the finish page, naming its run, the service and why it failed. */
export function connectedPath(ended: ConnectEnded): string {
  const query = new URLSearchParams({ service: ended.service });

  if (ended.run !== null) query.set('run', ended.run);

  if (ended.error !== null) query.set('error', ended.error.slice(0, 300));

  return `${APP_ROUTES.connected}?${query.toString()}`;
}

/** The finish page's own reading of its address, as `connectedPath` wrote it; a run that is no run's id is none. */
export function connectEndedOf(search: URLSearchParams): ConnectEnded {
  const run = v.safeParse(ConnectRunSchema, search.get('run'));

  return { run: run.success ? run.output : null, service: search.get('service') ?? 'the service', error: search.get('error') };
}

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
