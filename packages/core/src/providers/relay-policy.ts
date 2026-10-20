// What the provider relay carries, read by both ends of the tunnel: the hub before it forwards a call to a machine
// (cf-backend user/devices.ts) and the machine's daemon before it fetches (pc-agent). No imports: the daemon loads it
// as it is.

/**
 * Each host's calls, `METHOD /path`: Codex on chatgpt.com, which refuses Kinu's cloud network, and the ChatGPT plan's API
 * on api.openai.com, which the machine's own sign-in carries.
 */
const RELAY_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'chatgpt.com': Object.freeze(['GET /backend-api/codex/models', 'POST /backend-api/codex/responses', 'GET /backend-api/wham/usage']),
  'api.openai.com': Object.freeze(['GET /v1/models', 'POST /v1/responses']),
});

/**
 * Why the relay refuses `method url`, or null where it carries it: https on a listed host's own port, with no user or
 * password in the URL, on one of that host's routes. A query string rides along; the path is matched as the URL parses it.
 */
export function relayRefusal(method: string, url: string): string | null {
  const target = URL.parse(url);

  if (target === null || !Object.hasOwn(RELAY_ROUTES, target.hostname)) return `the provider relay does not reach ${url}`;

  if (target.protocol !== 'https:' || target.port !== '' || target.username !== '' || target.password !== '') {
    return `the provider relay does not reach ${url}`;
  }

  return RELAY_ROUTES[target.hostname]?.includes(`${method} ${target.pathname}`) === true ? null : `the provider relay does not carry ${method} ${target.pathname}`;
}
