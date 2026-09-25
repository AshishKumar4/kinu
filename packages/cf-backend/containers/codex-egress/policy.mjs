// What the container forwards, apart from the server so its unit test reads the same rules.

const ALLOWED_HOST = 'chatgpt.com';

// Mirrors core codexEgressAllowed; this copy is the one that holds for fetch and containerFetch.
const ALLOWED = new Set(['GET /backend-api/codex/models', 'POST /backend-api/codex/responses', 'GET /backend-api/wham/usage']);

export const TARGET_HEADER = 'x-kinu-target';

export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'host', 'content-length',
]);

/** Why `method target` is not forwarded, with its HTTP status; null when it is. */
export function refusal(method, target) {
  const url = URL.parse(String(target ?? ''));

  if (url === null || url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST || url.port !== '' || url.username !== '' || url.password !== '') {
    return { status: 403, text: 'target refused' };
  }

  if (method !== 'GET' && method !== 'POST') return { status: 405, text: 'method refused' };

  return ALLOWED.has(`${method} ${url.pathname}`) ? null : { status: 403, text: 'path refused' };
}

export function forwardedHeaders(incoming) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name.startsWith('cf-') || name.startsWith('x-kinu-') || name === 'x-forwarded-for') continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  return headers;
}
