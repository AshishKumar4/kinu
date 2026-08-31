/**
 * The admin control plane's OUTER gate: Cloudflare Access.
 *
 * REAL RS256 TOKENS AGAINST A REAL JWKS, not a stubbed verifier. The whole value
 * of this gate is that it verifies rather than trusts, so a test that replaced
 * `jwtVerify` with a fake would assert the one thing that cannot go wrong. Every
 * token below is signed with a generated key pair, published through a stubbed
 * `fetch` at the team's `/cdn-cgi/access/certs`, and verified by the production
 * code path with nothing swapped out.
 *
 * WHAT THE FORGERIES ARE FOR. Each negative case is a real attack on a real
 * mistake somebody has shipped:
 *
 *   - no header: the origin is reachable around Access (a route added later, a
 *     misconfigured application), which is exactly the state "check the header is
 *     present" was supposed to catch and cannot.
 *   - `alg: HS256` over the published modulus: the classic algorithm-confusion
 *     forgery, and the reason `algorithms` is pinned rather than left open.
 *   - another organization's signature: a valid Access token, from a Zero Trust
 *     account that is not ours. Anyone can create one for free.
 *   - another application's audience: a valid token from OUR organization, minted
 *     for a different application. Within one org, this is what an unpinned `aud`
 *     admits.
 *   - expired and not-yet-valid: the window, from both ends.
 *   - `exp`/`nbf` omitted entirely: a claim validated only when present is a
 *     window the token gets to turn off.
 *   - a service-token shape: signed, in-audience, unexpired, and carrying no
 *     human at all.
 *
 * THE NEGATIVE SURFACE TEST IS NOT FILLER. Access covers `/control*` and
 * `/api/control*` and must cover nothing else: a host-wide application would put
 * an interactive corporate login in front of every preview URL an agent hands
 * out, the public landing page, `/api/feedback` and `/api/client-errors`. The
 * Worker's own idea of which paths need an assertion has to match that scope from
 * BOTH directions — too narrow leaves an admin route ungated, too wide answers a
 * permanent 404 on a path no assertion can ever be obtained for.
 */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { isPublicPath, type AuthIdentity } from '../src/auth/session';
import {
  isControlPlaneApiPath, isControlPlaneSurface, verifyControlPlaneAccess,
  type ControlPlaneAccessEnv,
} from '../src/control-plane/access-gate';
import {
  adminDenialMessage, adminDenialStatus, authorizeAdmin, isControlPlaneOperator,
} from '../src/control-plane/admin-caller';

/** The header Cloudflare Access sets, spelled independently of the production
 *  constant on purpose. A shared import would let a rename pass both sides; an
 *  independent literal pins the wire name Cloudflare fixed, so a change to it
 *  fails here. */
const ASSERTION_HEADER = 'cf-access-jwt-assertion';

/** Our organization, and a second one that is not ours. Distinct hostnames
 *  because the production module caches one key set PER TEAM ORIGIN for the life
 *  of the isolate — which is the behaviour under test in the "another
 *  organization" case, and would otherwise be defeated by both orgs sharing a
 *  cache slot. */
const TEAM = 'https://kinu.cloudflareaccess.com';
const OTHER_TEAM = 'https://someone-else.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const OTHER_AUD = 'b'.repeat(64);
const OPERATOR = 'ops@kinu.run';
const SECRET = 'control-plane-access-test-secret-0123456789';

const ENV: ControlPlaneAccessEnv = {
  CONTROL_PLANE_ACCESS_TEAM_DOMAIN: TEAM,
  CONTROL_PLANE_ACCESS_AUD: AUD,
};

/** One published signing key. `kid` is what a token's header points at, so a key
 *  the JWKS does not publish under that name is unresolvable — which is the
 *  rotated-key and unknown-key case. */
interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { kid, privateKey, jwk: { ...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig' } };
}

/** The keys each organization publishes. `unpublished` is generated like the
 *  others and deliberately absent from every JWKS. */
let ours: SigningKey;
let theirs: SigningKey;
let unpublished: SigningKey;
let rotated: SigningKey;
let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
  [ours, theirs, unpublished, rotated] = await Promise.all([
    signingKey('ours-1'), signingKey('theirs-1'), signingKey('never-published'),
    signingKey('ours-1'),
  ]);

  const sets = {
    [`${TEAM}/cdn-cgi/access/certs`]: [ours.jwk],
    [`${OTHER_TEAM}/cdn-cgi/access/certs`]: [theirs.jwk],
  } satisfies Record<string, readonly JWK[]>;

  realFetch = globalThis.fetch;
  // The ONE thing stubbed, and only the certs endpoint: everything else in this
  // file is production code. A request to any other URL throws rather than
  // answering, so a test that accidentally depends on the network fails loudly
  // instead of reaching Cloudflare from a unit suite.
  //
  // SAFETY: the cast is to the platform's own `fetch` type and nothing wider —
  // the real signature carries overloads and a `preconnect` member this stub
  // has no use for, and jose calls it with exactly `(url, init)`.
  const stub = ((input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    const match = Object.entries(sets).find(([certsUrl]) => certsUrl === url);
    if (match === undefined) throw new Error(`unexpected fetch in a unit test: ${url}`);
    const [, keys] = match;
    return Promise.resolve(new Response(JSON.stringify({ keys }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }) as typeof globalThis.fetch;
  globalThis.fetch = stub;
});

afterAll(() => { globalThis.fetch = realFetch; });

/** Claims the way Cloudflare Access mints them for an identity-based login —
 *  every field from the documented payload that this gate reads or requires. */
interface Claims {
  readonly email?: string | null;
  readonly sub?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly expiresIn?: number;
  readonly notBefore?: number;
  readonly omitExp?: boolean;
  readonly omitNbf?: boolean;
}

async function token(key: SigningKey, claims: Claims = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const identity = { type: 'app', country: 'US' };
  const payload = claims.email === null ? identity : { ...identity, email: claims.email ?? OPERATOR };
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .setIssuer(claims.issuer ?? TEAM)
    .setAudience(claims.audience ?? AUD)
    .setSubject(claims.sub ?? 'access-uuid-1')
    .setIssuedAt(now);
  if (claims.omitExp !== true) jwt = jwt.setExpirationTime(now + (claims.expiresIn ?? 3600));
  if (claims.omitNbf !== true) jwt = jwt.setNotBefore(now + (claims.notBefore ?? 0));
  return jwt.sign(key.privateKey);
}

/** A request as it arrives at the Worker: the assertion in the header Access
 *  sets, never a cookie. */
function assertedRequest(assertion: string | null, path = '/api/control/overview'): Request {
  return new Request(`https://kinu.run${path}`, {
    headers: assertion === null ? {} : { [ASSERTION_HEADER]: assertion },
  });
}

function identity(over: Partial<AuthIdentity> = {}): AuthIdentity {
  return {
    userId: 'a'.repeat(32), email: OPERATOR, sub: 'session-sub-1', provider: 'github',
    authTime: Date.now(), ...over,
  };
}

const ADMIN_ENV = { CREDENTIAL_ENCRYPTION_KEY: SECRET, CONTROL_PLANE_ADMINS: OPERATOR };

describe('the assertion is verified, never trusted', () => {
  test('a valid assertion yields the email and sub the identity provider verified', async () => {
    const answer = await verifyControlPlaneAccess(assertedRequest(await token(ours)), ENV);
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('unreachable');
    expect(answer.access).toEqual({ email: OPERATOR, sub: 'access-uuid-1' });
  });

  test('an email claim is normalized the way the allowlist is', async () => {
    // The allowlist lowercases; a provider that returns a capitalized address
    // would otherwise fail the Access-to-session equality for one operator and
    // not another.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: '  OPS@Kinu.RUN ' })), ENV,
    );
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('unreachable');
    expect(answer.access.email).toBe(OPERATOR);
  });

  test('no assertion header at all is refused as missing, not as invalid', async () => {
    // The two are different operator pages: `access_missing` in volume means
    // requests are reaching this origin around Access.
    const answer = await verifyControlPlaneAccess(assertedRequest(null), ENV);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_missing');
    expect(adminDenialStatus(answer.denial)).toBe(404);
    expect(adminDenialMessage(answer.denial)).toBe('Not found');
  });

  test('an empty assertion header is missing rather than invalid', async () => {
    const answer = await verifyControlPlaneAccess(assertedRequest('   '), ENV);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_missing');
  });

  test('the Access cookie is not a substitute for the assertion header', async () => {
    // `CF_Authorization` is ambient on every request the browser makes to this
    // origin, including a cross-site one. The header is set by Access itself on
    // requests it authorized, which is why it is the only thing read.
    const request = new Request('https://kinu.run/api/control/overview', {
      headers: { cookie: `CF_Authorization=${await token(ours)}` },
    });
    const answer = await verifyControlPlaneAccess(request, ENV);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_missing');
  });

  test('a token signed by another Zero Trust organization is refused', async () => {
    // A real, valid Access token — from an account that is not ours. Anyone can
    // create one, which is why a signature alone decides nothing.
    const foreign = await token(theirs, { issuer: OTHER_TEAM });
    const answer = await verifyControlPlaneAccess(assertedRequest(foreign), ENV);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('a token whose issuer is not the pinned team domain is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { issuer: OTHER_TEAM })), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('a token for another application in our own organization is refused', async () => {
    // Correctly signed by the right keys with the right issuer. Only the audience
    // scopes it to this application, and the admin plane is not every application.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { audience: OTHER_AUD })), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('a token signed by a key the JWKS does not publish is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(unpublished)), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('a token whose kid names a published key it was not signed with is refused', async () => {
    // The forgery that a `kid`-only check admits: the header points at a real
    // published key, and the signature is over a different private key entirely.
    const answer = await verifyControlPlaneAccess(assertedRequest(await token(rotated)), ENV);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('an unsigned or HS256-forged token is refused by the algorithm pin', async () => {
    // Algorithm confusion: the attacker HMACs the token with the public modulus
    // they read out of the JWKS. Only pinning RS256 stops it.
    const hmacKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JSON.stringify(ours.jwk)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ email: OPERATOR })
      .setProtectedHeader({ alg: 'HS256', kid: ours.kid })
      .setIssuer(TEAM).setAudience(AUD).setSubject('access-uuid-1')
      .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 3600)
      .sign(hmacKey);
    const answer = await verifyControlPlaneAccess(assertedRequest(forged), ENV);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('an expired assertion is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { expiresIn: -60 })), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('an assertion that is not yet valid is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { notBefore: 600 })), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('an assertion carrying no exp is refused rather than treated as eternal', async () => {
    // A claim validated only when present is a window the token turns off.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { omitExp: true })), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('an assertion carrying no nbf is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { omitNbf: true })), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('a service-token assertion is refused: no human, no operator', async () => {
    // Signed, in-audience, unexpired, `sub: ""` and no email — the documented
    // service-token payload. Step-up over a non-interactive credential means
    // nothing and no machine is an operator of this plane.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: null, sub: '' })), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    // Refused for the missing claim rather than the signature: the token is
    // genuine, and telling those two apart is the difference between "revoke a
    // service token" and "somebody is forging assertions".
    expect(answer.denial).toBe('access_invalid');
  });

  test('a verified token with an empty sub is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { sub: '' })), ENV,
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_no_email');
  });
});

describe('an unconfigured deployment has no admin plane', () => {
  test('no team domain is unconfigured, and never a pass', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours)),
      { CONTROL_PLANE_ACCESS_AUD: AUD },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_unconfigured');
  });

  test('no audience is unconfigured, because an unpinned aud is a weaker check', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours)),
      { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: TEAM },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_unconfigured');
  });

  test('an empty or blank var is unconfigured, not a wildcard', async () => {
    for (const env of [
      { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: '', CONTROL_PLANE_ACCESS_AUD: AUD },
      { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: TEAM, CONTROL_PLANE_ACCESS_AUD: '   ' },
      {},
    ]) {
      const answer = await verifyControlPlaneAccess(assertedRequest(await token(ours)), env);
      expect(answer.ok).toBe(false);
      if (answer.ok) throw new Error('unreachable');
      expect(answer.denial).toBe('access_unconfigured');
    }
  });

  test('unconfigured answers 404 and says nothing about the admin surface', () => {
    // A 503 here would be the one honest-looking answer that gives the game away:
    // it tells a stranger the path exists and something behind it is broken.
    expect(adminDenialStatus('access_unconfigured')).toBe(404);
    expect(adminDenialMessage('access_unconfigured')).toBe('Not found');
    // Indistinguishable from every other Access refusal on the wire.
    for (const denial of ['access_missing', 'access_invalid', 'access_no_email'] as const) {
      expect(adminDenialStatus(denial)).toBe(404);
      expect(adminDenialMessage(denial)).toBe('Not found');
    }
  });

  test('a team domain an operator pasted without a scheme still verifies a real token', async () => {
    // The two realistic shapes out of the dashboard. Getting these wrong produces
    // a JWKS URL that resolves nothing and an issuer that never equals the
    // token's — a permanent 404 under a correct-looking configuration. Asserted
    // end to end rather than against the normalizer, because the property is
    // "this config verifies a genuine assertion", not "this string comes out".
    for (const raw of ['kinu.cloudflareaccess.com', `${TEAM}/`, `  ${TEAM}  `]) {
      const answer = await verifyControlPlaneAccess(
        assertedRequest(await token(ours)),
        { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: raw, CONTROL_PLANE_ACCESS_AUD: AUD },
      );
      expect(answer.ok).toBe(true);
      if (!answer.ok) throw new Error(`unreachable for ${raw}`);
      expect(answer.access.email).toBe(OPERATOR);
    }
  });

  test('a team domain that is not an exact https origin is unconfigured', async () => {
    // The value becomes both the JWKS base and the pinned issuer, so a config
    // ambiguous about which origin it names is a config this must not use. Every
    // one of these fails CLOSED rather than being coerced into something that
    // half works.
    for (const raw of [
      'http://kinu.cloudflareaccess.com',
      `${TEAM}/cdn-cgi/access/certs`,
      `${TEAM}?x=1`,
      'https://user:pw@kinu.cloudflareaccess.com',
      'not a url',
      '',
      '   ',
    ]) {
      const answer = await verifyControlPlaneAccess(
        assertedRequest(await token(ours)),
        { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: raw, CONTROL_PLANE_ACCESS_AUD: AUD },
      );
      expect(answer.ok).toBe(false);
      if (answer.ok) throw new Error(`unreachable for ${raw}`);
      expect(answer.denial).toBe('access_unconfigured');
    }
  });
});

describe('the two gates are joined by the email, and both still apply', () => {
  test('a verified Access identity plus an allowlisted session authorizes, and carries both', async () => {
    const verified = await verifyControlPlaneAccess(assertedRequest(await token(ours)), ENV);
    if (!verified.ok) throw new Error('the fixture assertion should verify');
    const answer = authorizeAdmin(ADMIN_ENV, identity(), verified.access, { mutating: true });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('unreachable');
    expect(answer.admin.email).toBe(OPERATOR);
    expect(answer.admin.fresh).toBe(true);
    // The proof object carries the Access identity, which is what makes "both
    // gates were passed" a fact about the value rather than about a code path.
    expect(answer.admin.access).toEqual({ email: OPERATOR, sub: 'access-uuid-1' });
  });

  test('an Access identity that is not the session identity is refused', async () => {
    const verified = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: 'someone-else@kinu.run' })), ENV,
    );
    if (!verified.ok) throw new Error('the fixture assertion should verify');
    const answer = authorizeAdmin(ADMIN_ENV, identity(), verified.access, { mutating: false });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_mismatch');
    // 404, like every other admin-existence refusal: the caller passed Access but
    // is not this session's operator, and confirming the path teaches them that.
    expect(adminDenialStatus(answer.denial)).toBe(404);
  });

  test('the mismatch is decided before the step-up window, so a mismatch never reads as 403', async () => {
    // Order matters for the WORD, not the outcome. `stale_auth` answers 403 and
    // says "sign in again", which is the right thing to tell a recognized
    // operator and a misleading thing to tell a mismatched pair.
    const verified = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: 'someone-else@kinu.run' })), ENV,
    );
    if (!verified.ok) throw new Error('the fixture assertion should verify');
    const answer = authorizeAdmin(
      ADMIN_ENV, identity({ authTime: Date.now() - 6 * 60 * 1000 }), verified.access,
      { mutating: true },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_mismatch');
  });

  test('a staging-shaped deployment admits nobody even with a valid assertion', async () => {
    // `CONTROL_PLANE_ADMINS: ""` is staging's line, and it is the reason staging
    // needs no Access application: with no operators the plane is unreachable
    // whatever the outer gate says. Held here so the two are never conflated.
    const verified = await verifyControlPlaneAccess(assertedRequest(await token(ours)), ENV);
    if (!verified.ok) throw new Error('the fixture assertion should verify');
    const answer = authorizeAdmin(
      { CREDENTIAL_ENCRYPTION_KEY: SECRET, CONTROL_PLANE_ADMINS: '' },
      identity(), verified.access, { mutating: false },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('no_admins_configured');
  });

  test('a dev identity is refused even when Access verified the same address', async () => {
    // The staging trap, with the outer gate satisfied: `DEV_USER_EMAIL`
    // synthesizes one permanently-fresh identity for every request, so an
    // allowlist match there would be unauthenticated operator authority.
    const verified = await verifyControlPlaneAccess(assertedRequest(await token(ours)), ENV);
    if (!verified.ok) throw new Error('the fixture assertion should verify');
    const answer = authorizeAdmin(
      ADMIN_ENV, identity({ provider: 'dev' }), verified.access, { mutating: false },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('dev_identity');
  });

  test('the nav flag reads the allowlist and cannot be an authorization', () => {
    // It answers the one half a `/api/user/profile` request can be asked: that
    // request carries no assertion, because Access covers the control-plane paths
    // and nothing else.
    expect(isControlPlaneOperator(ADMIN_ENV, identity())).toBe(true);
    expect(isControlPlaneOperator(ADMIN_ENV, identity({ email: 'nobody@example.com' }))).toBe(false);
    expect(isControlPlaneOperator(ADMIN_ENV, identity({ provider: 'dev' }))).toBe(false);
    expect(isControlPlaneOperator(ADMIN_ENV, identity({ cliScopes: [] }))).toBe(false);
    expect(isControlPlaneOperator({ ...ADMIN_ENV, CONTROL_PLANE_ADMINS: '' }, identity())).toBe(false);
  });
});

describe('Access is scoped to the control plane and to nothing else', () => {
  test('the UI entry and everything under it need an assertion', () => {
    for (const path of ['/control', '/control/', '/control/users', '/control/workspaces/alpha']) {
      expect(isControlPlaneSurface(path)).toBe(true);
      // The UI document is NOT the admin API: `routes.ts` must decline it so the
      // SPA fallback serves the page, while the gate above still demands the
      // assertion for it.
      expect(isControlPlaneApiPath(path)).toBe(false);
    }
  });

  test('the admin API and everything under it need an assertion', () => {
    for (const path of ['/api/control', '/api/control/overview', '/api/control/users/abc']) {
      expect(isControlPlaneApiPath(path)).toBe(true);
      expect(isControlPlaneSurface(path)).toBe(true);
    }
  });

  test('NOTHING ELSE on this deployment needs an assertion', () => {
    // The negative half, and the reason the gate is two path tests rather than
    // one `startsWith('/control')`. Every entry here is a route that must keep
    // working for a user who has never heard of Zero Trust: an Access
    // application covering any of them would put a corporate login in front of
    // the public product.
    const outside = [
      '/',
      '/login',
      '/api/health',
      '/api/feedback',
      '/api/client-errors',
      '/api/user/profile',
      '/api/workspaces/alpha/files',
      '/agents/orchestrator-agent/alpha',
      '/mcp/v1/sse',
      '/downloads/kinu',
      '/assets/index-abc123.js',
      '/workspace/alpha',
      // Paths that merely BEGIN with the protected words. Access destinations are
      // `kinu.run/control*`, so a `startsWith` gate here would demand an
      // assertion for a path the application does not cover — a permanent 404
      // nobody can clear.
      '/controlpanel',
      '/control-plane',
      '/api/controlx',
      '/api/controllers/list',
    ];
    for (const path of outside) {
      expect(isControlPlaneSurface(path)).toBe(false);
      expect(isControlPlaneApiPath(path)).toBe(false);
    }
  });

  test('no path on the public bypass list is a control-plane surface', () => {
    // The bypass this gate now sits IN FRONT OF, pinned from the other side. The
    // Access check runs above `isPublicPath` precisely so a future entry there
    // cannot outrank it — and this holds the two lists disjoint so the question
    // never even arises.
    for (const path of [
      '/api/health', '/login', '/logout', '/auth/github/callback', '/api/auth/session',
      '/pc/connect', '/pc/connect-ticket', '/assets/index-abc123.js',
    ]) {
      expect(isPublicPath(path)).toBe(true);
      expect(isControlPlaneSurface(path)).toBe(false);
    }
    // And the control-plane surface is not on it, which is the direction that
    // would silently unprotect the admin plane.
    for (const path of ['/control', '/control/users', '/api/control', '/api/control/overview']) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});
