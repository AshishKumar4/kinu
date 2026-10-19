/**
 * The tiers' MCP server behind OAuth: the expiring server (scripted-mcp.ts) at `/mcp/oauth/<ttl>`, whose access tokens
 * live `<ttl>` seconds and whose refresh tokens rotate. Each refresh answers a new pair, and a refresh token presented
 * twice revokes its grant, as RFC 9700 §4.14.2 tells a server to: a client that refreshes one grant twice at once
 * loses it, as it would at a real provider. A deployed case drives a product's connection through expiry and refresh
 * as often as it likes.
 *
 * Discovery (RFC 9728, RFC 8414) and registration (RFC 7591) are public, as a client reaches them before it holds
 * anything; authorizing needs the Worker's key, so only the tiers can mint a grant, and the code, the access token and
 * the refresh token are HMAC-signed with that key. A grant's generation is the one state (`GrantLedger`).
 */
import * as v from 'valibot';
import type { JsonValue } from '../packages/core/src/utils/json';
import { SCRIPTED_MCP_PATH, scriptedMcp, type McpAnswer } from './scripted-mcp';

/** Where the protected server is: `<path>/<ttl seconds>`. */
export const SCRIPTED_MCP_OAUTH_PATH = '/mcp/oauth';

export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';

const OAUTH_TOKEN_PATH = '/oauth/token';

const OAUTH_REGISTER_PATH = '/oauth/register';

const AUTHORIZATION_SERVER_METADATA = '/.well-known/oauth-authorization-server';

const PROTECTED_RESOURCE_METADATA = '/.well-known/oauth-protected-resource';

/** How long a code may wait for its exchange. */
const CODE_MS = 120_000;

/** Whether a grant's refresh token of `generation` is its current one: then the grant moves on, else it is revoked. */
export interface GrantLedger {
  rotate(grant: string, generation: number): Promise<'rotated' | 'reused'>;
}

export interface OAuthRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
  readonly now: number;
  readonly nonce: string;
  /** The Worker's key: what signs, and what authorizing asks for. */
  readonly key: string;
  /** Whether the request bore the key as its bearer. */
  readonly keyed: boolean;
  readonly ledger: GrantLedger;
}

const SignedSchema = v.variant('k', [
  v.object({ k: v.literal('code'), client: v.string(), redirect: v.string(), challenge: v.string(), resource: v.string(), exp: v.number() }),
  v.object({ k: v.literal('access'), grant: v.string(), gen: v.number(), resource: v.string(), exp: v.number() }),
  v.object({ k: v.literal('refresh'), grant: v.string(), gen: v.number(), resource: v.string() }),
]);

type Signed = v.InferOutput<typeof SignedSchema>;

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

async function mac(key: string, text: string): Promise<string> {
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${key}:oauth`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(text))));
}

async function sign(key: string, value: Signed): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(value)));

  return `${payload}.${await mac(key, payload)}`;
}

/** A token this server signed, or null for anything else. */
async function opened(key: string, token: string): Promise<Signed | null> {
  const [payload = '', signature = '', ...rest] = token.split('.');

  if (rest.length > 0 || signature !== await mac(key, payload)) return null;
  const json = atob(payload.replace(/-/gu, '+').replace(/_/gu, '/'));
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), SignedSchema), json);

  return parsed.success ? parsed.output : null;
}

const json = (status: number, value: JsonValue, headers: Readonly<Record<string, string>> = {}): McpAnswer => ({
  status, body: JSON.stringify(value), headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});

const oauthError = (status: number, error: string, description: string): McpAnswer => json(status, { error, error_description: description });

/** The access token's lifetime the resource path names, or null for a path that is no protected server. */
function ttlOf(path: string): number | null {
  const ttl = new RegExp(`^${SCRIPTED_MCP_OAUTH_PATH}/(\\d{1,5})$`, 'u').exec(path)?.[1];

  return ttl === undefined || Number(ttl) === 0 ? null : Number(ttl);
}

async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** A grant's pair of generation `gen`, the access token living as long as its resource's path says. */
async function tokens(request: Pick<OAuthRequest, 'key' | 'now'>, grant: { readonly id: string; readonly gen: number; readonly resource: string }): Promise<McpAnswer> {
  const ttl = ttlOf(new URL(grant.resource).pathname) ?? 60;
  const { id, gen, resource } = grant;

  return json(200, {
    access_token: await sign(request.key, { k: 'access', grant: id, gen, resource, exp: request.now + ttl * 1000 }),
    token_type: 'Bearer',
    expires_in: ttl,
    refresh_token: await sign(request.key, { k: 'refresh', grant: id, gen, resource }),
  });
}

async function exchange(request: OAuthRequest, form: URLSearchParams): Promise<McpAnswer> {
  const grantType = form.get('grant_type');

  if (grantType === 'authorization_code') {
    const code = await opened(request.key, form.get('code') ?? '');

    if (code?.k !== 'code' || code.exp < request.now) return oauthError(400, 'invalid_grant', 'the code is not one this server issued, or it expired');

    if (form.get('redirect_uri') !== code.redirect || form.get('client_id') !== code.client) return oauthError(400, 'invalid_grant', 'the code was issued to another client or redirect');

    if (await challengeOf(form.get('code_verifier') ?? '') !== code.challenge) return oauthError(400, 'invalid_grant', 'the code verifier does not match its challenge');

    return tokens(request, { id: `g${String(request.now)}-${request.nonce}`, gen: 0, resource: code.resource });
  }

  if (grantType === 'refresh_token') {
    const refresh = await opened(request.key, form.get('refresh_token') ?? '');

    if (refresh?.k !== 'refresh') return oauthError(400, 'invalid_grant', 'the refresh token is not one this server issued');

    if (await request.ledger.rotate(refresh.grant, refresh.gen) === 'reused') {
      return oauthError(400, 'invalid_grant', 'the refresh token was already used, so its grant is revoked');
    }

    return tokens(request, { id: refresh.grant, gen: refresh.gen + 1, resource: refresh.resource });
  }

  return oauthError(400, 'unsupported_grant_type', `no grant type ${String(grantType)}`);
}

async function authorize(request: OAuthRequest): Promise<McpAnswer> {
  if (!request.keyed) return json(401, { error: 'authorizing a grant here needs the Worker\'s key as the bearer' });
  const query = request.url.searchParams;
  const redirect = query.get('redirect_uri');
  const challenge = query.get('code_challenge');
  const resource = query.get('resource');

  if (query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256' || redirect === null || challenge === null) {
    return oauthError(400, 'invalid_request', 'an authorization asks for response_type=code with an S256 code_challenge and a redirect_uri');
  }

  if (resource === null || ttlOf(new URL(resource).pathname) === null) return oauthError(400, 'invalid_target', 'the resource names no protected server here');
  const code = await sign(request.key, { k: 'code', client: query.get('client_id') ?? '', redirect, challenge, resource, exp: request.now + CODE_MS });
  const to = new URL(redirect);

  to.searchParams.set('code', code);

  if (query.get('state') !== null) to.searchParams.set('state', query.get('state') ?? '');

  return { status: 302, body: null, headers: { location: to.toString() } };
}

/** The MCP call itself, once its access token is this server's, unexpired and for this resource. */
async function protectedMcp(request: OAuthRequest, ttl: number): Promise<McpAnswer> {
  const resource = `${request.url.origin}${SCRIPTED_MCP_OAUTH_PATH}/${String(ttl)}`;
  const bearer = /^Bearer (.+)$/u.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const access = await opened(request.key, bearer);

  if (access?.k !== 'access' || access.exp <= request.now || access.resource !== resource) {
    const metadata = `${request.url.origin}${PROTECTED_RESOURCE_METADATA}${SCRIPTED_MCP_OAUTH_PATH}/${String(ttl)}`;

    return json(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${metadata}"` });
  }

  return scriptedMcp({ method: request.method, session: request.headers.get('mcp-session-id'), body: request.body }, request.now, request.nonce);
}

/** The answer to an OAuth route of this server, or null for a path that is none of them. */
export async function scriptedOAuth(request: OAuthRequest): Promise<McpAnswer | null> {
  const path = request.url.pathname;
  const { origin } = request.url;

  if (path === AUTHORIZATION_SERVER_METADATA) {
    return json(200, {
      issuer: origin, authorization_endpoint: `${origin}${OAUTH_AUTHORIZE_PATH}`, token_endpoint: `${origin}${OAUTH_TOKEN_PATH}`,
      registration_endpoint: `${origin}${OAUTH_REGISTER_PATH}`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }

  if (path.startsWith(`${PROTECTED_RESOURCE_METADATA}${SCRIPTED_MCP_OAUTH_PATH}/`)) {
    const ttl = ttlOf(path.slice(PROTECTED_RESOURCE_METADATA.length));

    return ttl === null ? null : json(200, { resource: `${origin}${SCRIPTED_MCP_OAUTH_PATH}/${String(ttl)}`, authorization_servers: [origin], bearer_methods_supported: ['header'] });
  }

  if (path === OAUTH_REGISTER_PATH && request.method === 'POST') {
    const asked = v.safeParse(v.pipe(v.string(), v.parseJson(), v.looseObject({ redirect_uris: v.array(v.string()) })), request.body);

    if (!asked.success) return oauthError(400, 'invalid_client_metadata', 'a registration names its redirect_uris');

    return json(201, {
      ...asked.output, client_id: `c${String(request.now)}-${request.nonce}`, client_id_issued_at: Math.floor(request.now / 1000),
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
  }

  if (path === OAUTH_AUTHORIZE_PATH && request.method === 'GET') return authorize(request);

  if (path === OAUTH_TOKEN_PATH && request.method === 'POST') return exchange(request, new URLSearchParams(request.body));

  const ttl = ttlOf(path);

  return ttl === null ? null : protectedMcp(request, ttl);
}

/** Paths a request reaches without the Worker's key: everything a client does before and after a person authorizes. */
export function isPublicOAuthPath(path: string): boolean {
  return path === AUTHORIZATION_SERVER_METADATA || path.startsWith(PROTECTED_RESOURCE_METADATA) || path === OAUTH_REGISTER_PATH
    || path === OAUTH_TOKEN_PATH || ttlOf(path) !== null;
}

/** The unprotected expiring server answers 503 inside a `down=<from>-<until>` window (epoch ms) its URL names, so a case
 *  can make a server unreachable for exactly the span it measures, as an outage does. */
export function downFor(url: URL, now: number): McpAnswer | null {
  if (url.pathname !== SCRIPTED_MCP_PATH) return null;
  const window = /^(\d+)-(\d+)$/u.exec(url.searchParams.get('down') ?? '');

  if (window === null || now < Number(window[1]) || now >= Number(window[2])) return null;

  return { status: 503, body: JSON.stringify({ error: 'down for this window' }), headers: { 'content-type': 'application/json', 'retry-after': '1' } };
}
