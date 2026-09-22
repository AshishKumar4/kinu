/**
 * The admin control plane's outer gate, Cloudflare Access: real RS256 tokens against a real JWKS, with only
 * the certs fetch stubbed. Each forgery below is a real attack; the negative surface test pins that Access
 * covers `/control*` and `/api/control*` and nothing else, from both directions.
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
import { requestUrl } from '@kinu.run/core';

/** Spelled independently of the production constant, so a rename of the wire name fails here. */
const ASSERTION_HEADER = 'cf-access-jwt-assertion';

/** Distinct hostnames: production caches one key set per team origin for the life of the isolate. */
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

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });

  return { kid, privateKey, jwk: { ...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig' } };
}

/** `unpublished` is deliberately absent from every JWKS. */
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

  // The one stub; any other URL throws so a unit test never reaches the network.
  //
  const answerCerts = (input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    const match = Object.entries(sets).find(([certsUrl]) => certsUrl === url);

    if (match === undefined) throw new Error(`unexpected fetch in a unit test: ${url}`);
    const [, keys] = match;

    return Promise.resolve(new Response(JSON.stringify({ keys }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  };

  globalThis.fetch = Object.assign(answerCerts, {
    preconnect: (): void => { throw new Error('unexpected preconnect in a unit test'); },
  });
});

afterAll(() => { globalThis.fetch = realFetch; });

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
  const appClaims = { type: 'app', country: 'US' };
  const payload = claims.email === null ? appClaims : { ...appClaims, email: claims.email ?? OPERATOR };

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
    // The allowlist lowercases; a capitalized provider address must still match.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: '  OPS@Kinu.RUN ' })), ENV,
    );

    expect(answer.ok).toBe(true);

    if (!answer.ok) throw new Error('unreachable');
    expect(answer.access.email).toBe(OPERATOR);
  });

  test('no assertion header at all is refused as missing, not as invalid', async () => {
    // `access_missing` in volume means requests are reaching this origin around Access.
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
    // `CF_Authorization` is ambient on cross-site requests; only the header Access sets is read.
    const request = new Request('https://kinu.run/api/control/overview', {
      headers: { cookie: `CF_Authorization=${await token(ours)}` },
    });

    const answer = await verifyControlPlaneAccess(request, ENV);
    expect(answer.ok).toBe(false);

    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_missing');
  });

  test('a token signed by another Zero Trust organization is refused', async () => {
    // Anyone can mint a valid Access token for their own account, so a signature alone decides nothing.
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
    // Only the audience scopes a token to this application.
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
    const answer = await verifyControlPlaneAccess(assertedRequest(await token(rotated)), ENV);
    expect(answer.ok).toBe(false);

    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('access_invalid');
  });

  test('an unsigned or HS256-forged token is refused by the algorithm pin', async () => {
    // Algorithm confusion: HMAC over the published modulus. Only pinning RS256 stops it.
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
    // The documented service-token payload: no machine is an operator of this plane.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: null, sub: '' })), ENV,
    );

    expect(answer.ok).toBe(false);

    if (answer.ok) throw new Error('unreachable');
    // Refused for the missing claim, not the signature: "revoke a service token", not "forgery".
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
    // A 503 would tell a stranger the path exists.
    expect(adminDenialStatus('access_unconfigured')).toBe(404);
    expect(adminDenialMessage('access_unconfigured')).toBe('Not found');

    for (const denial of ['access_missing', 'access_invalid', 'access_no_email'] as const) {
      expect(adminDenialStatus(denial)).toBe(404);
      expect(adminDenialMessage(denial)).toBe('Not found');
    }
  });

  test('a team domain an operator pasted without a scheme still verifies a real token', async () => {
    // Asserted end to end: a wrong normalization gives a permanent 404 under a correct-looking config.
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
    // The value is both JWKS base and pinned issuer, so ambiguous configs fail closed.
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
    // 404 like every admin-existence refusal: confirming the path teaches a non-operator.
    expect(adminDenialStatus(answer.denial)).toBe(404);
  });

  test('the mismatch is decided before the step-up window, so a mismatch never reads as 403', async () => {
    // Order matters for the word: `stale_auth` says "sign in again", wrong for a mismatched pair.
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

  test('a deployment with no operators admits nobody even with a valid assertion', async () => {
    // No operators means unreachable whatever the outer gate says.
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
    // `DEV_USER_EMAIL` synthesizes a permanently-fresh identity; an allowlist match there would be unauthenticated authority.
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
      // The UI document isn't the admin API: `routes.ts` declines it for the SPA fallback, the gate still applies.
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
    // Each must keep working without Zero Trust: Access over any would gate the public product.
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
      // Access destinations are `kinu.run/control*`; a `startsWith` gate would 404 paths Access does not cover.
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
    // The Access check runs above `isPublicPath`; the two lists stay disjoint.
    for (const path of [
      '/api/health', '/login', '/logout', '/auth/github/callback', '/api/auth/session',
      '/pc/connect', '/pc/connect-ticket', '/assets/index-abc123.js',
    ]) {
      expect(isPublicPath(path)).toBe(true);
      expect(isControlPlaneSurface(path)).toBe(false);
    }

    for (const path of ['/control', '/control/users', '/api/control', '/api/control/overview']) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});
