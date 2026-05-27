// Pure URL parser for auth routes. Separated from routes.ts so unit tests can
// import this without pulling in `agents` (which transitively imports
// `cloudflare:email` and only resolves in a Worker runtime).
export const AUTH_PATH_PATTERN = /^\/api\/agents\/([^/]+)\/auth(\/.*)?$/;

export function parseAuthPath(pathname: string): { agentName: string; rest: string } | null {
  const m = pathname.match(AUTH_PATH_PATTERN);
  if (!m) return null;
  return { agentName: m[1], rest: m[2] ?? '' };
}
