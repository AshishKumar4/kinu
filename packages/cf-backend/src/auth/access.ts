// Cloudflare Access JWT verification.
//
// CF Access sits in front of the Worker and sets the `cf-access-jwt-assertion`
// header on every authenticated request. The JWT is signed with the team's
// keys at https://<team>.cloudflareaccess.com/cdn-cgi/access/certs (JWKS).
// Required claims: iss, aud, email, exp, iat, sub.
//
// Local dev: CF Access isn't in front of vite dev. If `env.DEV_USER_EMAIL` is
// set, we synthesize an AccessIdentity from that email, no JWT required. In
// production this var is unset, so the synthesis path is unreachable.

const JWKS_TTL_MS = 60 * 60 * 1000; // 1h — same as CF's recommended cache
let jwksCache: { keys: JsonWebKey[]; fetchedAt: number; teamDomain: string } | null = null;

export interface AccessIdentity {
  /** Stable user id derived from email (sha256 truncated). Use as UserDO name. */
  userId: string;
  /** Email from the JWT `email` claim. */
  email: string;
  /** IdP `sub` claim (Google/GitHub/etc. user id). For logging/audit. */
  sub: string;
  /** The team's domain (e.g. `myteam.cloudflareaccess.com`). */
  team: string;
}

export class AccessAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AccessAuthError';
  }
}

interface JwtHeader { alg: string; kid?: string; typ?: string; }
interface JwtPayload {
  iss?: string; aud?: string | string[]; exp?: number; iat?: number; nbf?: number;
  email?: string; sub?: string; identity_nonce?: string;
}

function b64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(s))) as T;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(hash);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

/** sha256(email) truncated to 32 hex chars — short enough for a DO name. */
export async function deriveUserId(email: string): Promise<string> {
  return (await sha256Hex(email.trim().toLowerCase())).slice(0, 32);
}

async function fetchJwks(teamDomain: string): Promise<JsonWebKey[]> {
  if (jwksCache && jwksCache.teamDomain === teamDomain && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new AccessAuthError(503, `JWKS fetch failed: ${res.status}`);
  const body = await res.json() as { keys?: JsonWebKey[] };
  if (!body.keys || !Array.isArray(body.keys)) throw new AccessAuthError(503, 'JWKS body malformed');
  jwksCache = { keys: body.keys, fetchedAt: Date.now(), teamDomain };
  return body.keys;
}

async function importJwk(jwk: JsonWebKey, alg: string): Promise<CryptoKey> {
  const algo = alg === 'RS256' || alg === 'RS512'
    ? { name: 'RSASSA-PKCS1-v1_5', hash: alg === 'RS512' ? 'SHA-512' : 'SHA-256' }
    : alg === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : null;
  if (!algo) throw new AccessAuthError(401, `Unsupported JWT alg: ${alg}`);
  return crypto.subtle.importKey('jwk', jwk, algo, false, ['verify']);
}

async function verifySignature(jwk: JsonWebKey, alg: string, signingInput: string, signature: Uint8Array): Promise<boolean> {
  const key = await importJwk(jwk, alg);
  const data = new TextEncoder().encode(signingInput);
  const algo = alg === 'RS256' || alg === 'RS512'
    ? { name: 'RSASSA-PKCS1-v1_5' }
    : { name: 'ECDSA', hash: 'SHA-256' };
  return crypto.subtle.verify(algo, key, signature, data);
}

export interface AccessVerifyOptions {
  teamDomain: string;
  /** The expected `aud` claim — the Access application's "Application Audience (AUD) Tag". */
  audience: string;
  /** Optional clock skew tolerance, default 10s. */
  clockSkewSec?: number;
}

/** Verify a CF Access JWT string. Throws AccessAuthError on any failure. */
export async function verifyAccessJwt(token: string, opts: AccessVerifyOptions): Promise<AccessIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessAuthError(401, 'Malformed JWT');
  const [hb64, pb64, sb64] = parts;

  let header: JwtHeader, payload: JwtPayload;
  try { header = b64urlDecodeJson<JwtHeader>(hb64); }
  catch { throw new AccessAuthError(401, 'JWT header decode failed'); }
  try { payload = b64urlDecodeJson<JwtPayload>(pb64); }
  catch { throw new AccessAuthError(401, 'JWT payload decode failed'); }

  if (!header.alg || !header.kid) throw new AccessAuthError(401, 'JWT header missing alg/kid');

  const now = Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSec ?? 10;
  if (typeof payload.exp !== 'number' || payload.exp + skew < now) throw new AccessAuthError(401, 'JWT expired');
  if (typeof payload.nbf === 'number' && payload.nbf - skew > now) throw new AccessAuthError(401, 'JWT not yet valid');
  if (payload.iss !== `https://${opts.teamDomain}`) throw new AccessAuthError(401, 'JWT issuer mismatch');

  const audMatch = Array.isArray(payload.aud)
    ? payload.aud.includes(opts.audience)
    : payload.aud === opts.audience;
  if (!audMatch) throw new AccessAuthError(401, 'JWT audience mismatch');

  if (typeof payload.email !== 'string' || !payload.email) throw new AccessAuthError(401, 'JWT missing email');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new AccessAuthError(401, 'JWT missing sub');

  const keys = await fetchJwks(opts.teamDomain);
  const jwk = keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk) throw new AccessAuthError(401, `No JWK for kid ${header.kid}`);

  const signature = b64urlDecode(sb64);
  const ok = await verifySignature(jwk, header.alg, `${hb64}.${pb64}`, signature);
  if (!ok) throw new AccessAuthError(401, 'JWT signature invalid');

  return {
    userId: await deriveUserId(payload.email),
    email: payload.email,
    sub: payload.sub,
    team: opts.teamDomain,
  };
}

/** Pull the JWT from request headers/cookies. CF Access sets either. */
export function readAccessToken(request: Request): string | null {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header;
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export interface AccessEnv {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  DEV_USER_EMAIL?: string;
}

/** Resolve the caller identity for a request.
 *
 *   - production: verify JWT, return AccessIdentity, or throw AccessAuthError
 *   - dev (DEV_USER_EMAIL set): synthesize identity, no JWT required
 *   - mis-configured (no team/aud, no dev email): throw 500
 */
export async function authenticateRequest(request: Request, env: AccessEnv): Promise<AccessIdentity> {
  if (env.DEV_USER_EMAIL && (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD)) {
    return {
      userId: await deriveUserId(env.DEV_USER_EMAIL),
      email: env.DEV_USER_EMAIL,
      sub: 'dev',
      team: 'dev',
    };
  }
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new AccessAuthError(500, 'CF Access not configured (CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD missing)');
  }
  const token = readAccessToken(request);
  if (!token) throw new AccessAuthError(401, 'No CF Access JWT in request');
  return verifyAccessJwt(token, {
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
    audience: env.CF_ACCESS_AUD,
  });
}

/** Public routes that bypass auth. Health check + sandbox preview proxy
 *  (which has its own token-in-URL auth). */
export function isPublicPath(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname.startsWith('/_preview/')) return true;
  if (pathname.startsWith('/pc/connect')) return true; // reverse-WS tunnel uses its own auth
  if (pathname.startsWith('/assets/')) return true;    // hashed static bundles
  return false;
}
