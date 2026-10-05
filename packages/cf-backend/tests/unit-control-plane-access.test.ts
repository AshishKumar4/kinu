/**
 * The admin control plane's outer gate, Cloudflare Access: real RS256 tokens against a real JWKS, with only
 * the certs fetch stubbed. Each forgery below is a real attack. Which paths Access gates is served in
 * `unit-worker-routes.test.ts`.
 */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { Result } from 'effect';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { AuthIdentity } from '../src/auth/session';
import {
  verifyControlPlaneAccess,
  type ControlPlaneAccessEnv,
} from '../src/control-plane/access-gate';
import {
  adminDenialAnswer, authorizeAdmin, isControlPlaneOperator,
} from '../src/control-plane/admin-caller';
import { requestUrl } from '@kinu.run/core';

/** As Cloudflare Access sends it ("Validate JWTs", Cloudflare One docs): the platform's spelling, not the
 *  product's, so a renamed wire name fails here and a case-sensitive read would too. */
const ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';

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
    expect(Result.isSuccess(answer)).toBe(true);

    if (Result.isFailure(answer)) throw new Error('unreachable');
    expect(answer.success).toEqual({ email: OPERATOR, sub: 'access-uuid-1' });
  });

  test('an email claim is normalized the way the allowlist is', async () => {
    // The allowlist lowercases; a capitalized provider address must still match.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: '  OPS@Kinu.RUN ' })), ENV,
    );

    expect(Result.isSuccess(answer)).toBe(true);

    if (Result.isFailure(answer)) throw new Error('unreachable');
    expect(answer.success.email).toBe(OPERATOR);
  });

  test('no assertion header at all is refused as missing, not as invalid', async () => {
    // `access_missing` in volume means requests are reaching this origin around Access.
    const answer = await verifyControlPlaneAccess(assertedRequest(null), ENV);
    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_missing');
    expect(adminDenialAnswer(answer.failure)).toEqual({ status: 404, message: 'Not found' });
  });

  test('an empty assertion header is missing rather than invalid', async () => {
    const answer = await verifyControlPlaneAccess(assertedRequest('   '), ENV);
    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_missing');
  });

  test('the Access cookie is not a substitute for the assertion header', async () => {
    // `CF_Authorization` is ambient on cross-site requests; only the header Access sets is read.
    const request = new Request('https://kinu.run/api/control/overview', {
      headers: { cookie: `CF_Authorization=${await token(ours)}` },
    });

    const answer = await verifyControlPlaneAccess(request, ENV);
    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_missing');
  });

  test('a token signed by another Zero Trust organization is refused', async () => {
    // Anyone can mint a valid Access token for their own account, so a signature alone decides nothing.
    const foreign = await token(theirs, { issuer: OTHER_TEAM });
    const answer = await verifyControlPlaneAccess(assertedRequest(foreign), ENV);
    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('a token whose issuer is not the pinned team domain is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { issuer: OTHER_TEAM })), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('a token for another application in our own organization is refused', async () => {
    // Only the audience scopes a token to this application.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { audience: OTHER_AUD })), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('a token signed by a key the JWKS does not publish is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(unpublished)), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('a token whose kid names a published key it was not signed with is refused', async () => {
    const answer = await verifyControlPlaneAccess(assertedRequest(await token(rotated)), ENV);
    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
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
    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('an expired assertion is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { expiresIn: -60 })), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('an assertion that is not yet valid is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { notBefore: 600 })), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('an assertion carrying no exp is refused rather than treated as eternal', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { omitExp: true })), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('an assertion carrying no nbf is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { omitNbf: true })), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_invalid');
  });

  test('a service-token assertion is refused: no human, no operator', async () => {
    // The documented service-token payload: no machine is an operator of this plane.
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: null, sub: '' })), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    // Refused for the missing claim, not the signature: "revoke a service token", not "forgery".
    expect(answer.failure).toBe('access_invalid');
  });

  test('a verified token with an empty sub is refused', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { sub: '' })), ENV,
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_no_email');
  });
});

describe('an unconfigured deployment has no admin plane', () => {
  test('no team domain is unconfigured, and never a pass', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours)),
      { CONTROL_PLANE_ACCESS_AUD: AUD },
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_unconfigured');
  });

  test('no audience is unconfigured, because an unpinned aud is a weaker check', async () => {
    const answer = await verifyControlPlaneAccess(
      assertedRequest(await token(ours)),
      { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: TEAM },
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_unconfigured');
  });

  test('an empty or blank var is unconfigured, not a wildcard', async () => {
    for (const env of [
      { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: '', CONTROL_PLANE_ACCESS_AUD: AUD },
      { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: TEAM, CONTROL_PLANE_ACCESS_AUD: '   ' },
      {},
    ]) {
      const answer = await verifyControlPlaneAccess(assertedRequest(await token(ours)), env);
      expect(Result.isFailure(answer)).toBe(true);

      if (Result.isSuccess(answer)) throw new Error('unreachable');
      expect(answer.failure).toBe('access_unconfigured');
    }
  });

  test('unconfigured answers 404 and says nothing about the admin surface', () => {
    // A 503 would tell a stranger the path exists.
    expect(adminDenialAnswer('access_unconfigured')).toEqual({ status: 404, message: 'Not found' });

    for (const denial of ['access_missing', 'access_invalid', 'access_no_email'] as const) {
      expect(adminDenialAnswer(denial)).toEqual({ status: 404, message: 'Not found' });
    }
  });

  test('a team domain an operator pasted without a scheme still verifies a real token', async () => {
    // Asserted end to end: a wrong normalization gives a permanent 404 under a correct-looking config.
    for (const raw of ['kinu.cloudflareaccess.com', `${TEAM}/`, `  ${TEAM}  `]) {
      const answer = await verifyControlPlaneAccess(
        assertedRequest(await token(ours)),
        { CONTROL_PLANE_ACCESS_TEAM_DOMAIN: raw, CONTROL_PLANE_ACCESS_AUD: AUD },
      );

      expect(Result.isSuccess(answer)).toBe(true);

      if (Result.isFailure(answer)) throw new Error(`unreachable for ${raw}`);
      expect(answer.success.email).toBe(OPERATOR);
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

      expect(Result.isFailure(answer)).toBe(true);

      if (Result.isSuccess(answer)) throw new Error(`unreachable for ${raw}`);
      expect(answer.failure).toBe('access_unconfigured');
    }
  });
});

describe('the two gates are joined by the email, and both still apply', () => {
  test('a verified Access identity plus an allowlisted session authorizes, and carries both', async () => {
    const verified = await verifyControlPlaneAccess(assertedRequest(await token(ours)), ENV);

    if (Result.isFailure(verified)) throw new Error('the fixture assertion should verify');
    const answer = authorizeAdmin(ADMIN_ENV, identity(), verified.success, { mutating: true });
    expect(Result.isSuccess(answer)).toBe(true);

    if (Result.isFailure(answer)) throw new Error('unreachable');
    expect(answer.success.email).toBe(OPERATOR);
    expect(answer.success.fresh).toBe(true);
    expect(answer.success.access).toEqual({ email: OPERATOR, sub: 'access-uuid-1' });
  });

  test('an Access identity that is not the session identity is refused', async () => {
    const verified = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: 'someone-else@kinu.run' })), ENV,
    );

    if (Result.isFailure(verified)) throw new Error('the fixture assertion should verify');
    const answer = authorizeAdmin(ADMIN_ENV, identity(), verified.success, { mutating: false });
    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_mismatch');
    // 404 like every admin-existence refusal: confirming the path teaches a non-operator.
    expect(adminDenialAnswer(answer.failure).status).toBe(404);
  });

  test('the mismatch is decided before the step-up window, so a mismatch never reads as 403', async () => {
    // Order matters for the word: `stale_auth` says "sign in again", wrong for a mismatched pair.
    const verified = await verifyControlPlaneAccess(
      assertedRequest(await token(ours, { email: 'someone-else@kinu.run' })), ENV,
    );

    if (Result.isFailure(verified)) throw new Error('the fixture assertion should verify');

    const answer = authorizeAdmin(
      ADMIN_ENV, identity({ authTime: Date.now() - 6 * 60 * 1000 }), verified.success,
      { mutating: true },
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('access_mismatch');
  });

  test('a deployment with no operators admits nobody even with a valid assertion', async () => {
    // No operators means unreachable whatever the outer gate says.
    const verified = await verifyControlPlaneAccess(assertedRequest(await token(ours)), ENV);

    if (Result.isFailure(verified)) throw new Error('the fixture assertion should verify');

    const answer = authorizeAdmin(
      { CREDENTIAL_ENCRYPTION_KEY: SECRET, CONTROL_PLANE_ADMINS: '' },
      identity(), verified.success, { mutating: false },
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('no_admins_configured');
  });

  test('a dev identity is refused even when Access verified the same address', async () => {
    // `DEV_USER_EMAIL` synthesizes a permanently-fresh identity; an allowlist match there would be unauthenticated authority.
    const verified = await verifyControlPlaneAccess(assertedRequest(await token(ours)), ENV);

    if (Result.isFailure(verified)) throw new Error('the fixture assertion should verify');

    const answer = authorizeAdmin(
      ADMIN_ENV, identity({ provider: 'dev' }), verified.success, { mutating: false },
    );

    expect(Result.isFailure(answer)).toBe(true);

    if (Result.isSuccess(answer)) throw new Error('unreachable');
    expect(answer.failure).toBe('dev_identity');
  });

  test('the nav flag reads the allowlist and cannot be an authorization', () => {
    expect(isControlPlaneOperator(ADMIN_ENV, identity())).toBe(true);
    expect(isControlPlaneOperator(ADMIN_ENV, identity({ email: 'nobody@example.com' }))).toBe(false);
    expect(isControlPlaneOperator(ADMIN_ENV, identity({ provider: 'dev' }))).toBe(false);
    expect(isControlPlaneOperator(ADMIN_ENV, identity({ cliScopes: [] }))).toBe(false);
    expect(isControlPlaneOperator({ ...ADMIN_ENV, CONTROL_PLANE_ADMINS: '' }, identity())).toBe(false);
  });
});
