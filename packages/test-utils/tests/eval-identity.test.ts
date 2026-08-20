/**
 * The two rules that decide whether an eval run may happen at all: whose
 * credential it uses, and which deployment it is allowed to touch.
 *
 * Both are written against a measured defect, not a hypothetical. On 2026-08-20
 * the owner's production account held 28 workspaces of which 23 were test
 * debris — twenty-two `drill*` rows and one `settle-probe` — because the eval
 * tier borrowed his signed-in session (`scripts/eval-credentials.ts`, before
 * this landed) and nothing anywhere asked whether the origin served real users.
 *
 * The target cases are the red-provable half: delete the allowlist arms from
 * `evalTargetVerdict` and `production origin is refused` fails, because the
 * production origin is read out of `wrangler.jsonc` rather than restated here.
 * That is deliberate — a test that hardcodes the hostname stops testing the
 * deployment the moment the deployment moves, which is exactly what this repo
 * is doing this week.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVAL_IDENTITY_ENV, EVAL_SERVICE_ACCOUNT, EVAL_SERVICE_EMAIL, EVAL_STAGING_ORIGIN,
  EVAL_WORKSPACE_PREFIX, evalTargetVerdict, evalWorkspaceName, resolveEvalIdentity,
} from '../src/eval-identity';

const WRANGLER = readFileSync(join(import.meta.dirname, '../../cf-backend/wrangler.jsonc'), 'utf8');

/**
 * Where `env.staging` begins, so production's own vars can be read without
 * catching staging's.
 *
 * Matched on the key rather than derived from a parse because the file is JSONC
 * and every other reader in the tree (`unit-preview-origin.test.ts`,
 * `scripts/infra-manifest.ts`) reads it the same way. A comment cannot forge
 * this needle: it carries the JSON punctuation.
 */
const STAGING_AT = WRANGLER.indexOf('"staging": {');

/**
 * The production origin, taken from the deployment rather than from a literal.
 *
 * `CLI_PUBLIC_ORIGIN` in the top-level `vars` block is what the Worker tells
 * every CLI to talk to, which makes it the definition of "the origin that
 * serves real users". Read out of the slice ABOVE `env.staging`, so this can
 * never quietly resolve to staging's own origin and pass vacuously.
 */
const PRODUCTION_ORIGIN = ((): string => {
  const match = /"CLI_PUBLIC_ORIGIN":\s*"([^"]+)"/.exec(WRANGLER.slice(0, STAGING_AT));
  if (!match?.[1]) throw new Error('wrangler.jsonc declares no production CLI_PUBLIC_ORIGIN');
  return match[1];
})();

describe('the eval target allowlist — a deployment serving real users is refused', () => {
  test('the production origin wrangler declares is NOT an eval target', () => {
    const origin = PRODUCTION_ORIGIN;
    // Vacuity guard: if production and staging ever spell the same origin, the
    // case below proves nothing and must say so rather than pass.
    expect(origin).not.toBe(EVAL_STAGING_ORIGIN);

    const verdict = evalTargetVerdict(origin, {});
    expect(verdict.kind).toBe('refused');
    // The refusal has to name the variable that makes it run, or an operator's
    // only move is to delete the guard.
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toContain(EVAL_IDENTITY_ENV.allowProd);
      expect(verdict.reason).toContain(origin);
    }
  });

  test('PROTEUS_EVAL_ALLOW_PROD=1 names the exception, and the verdict says so', () => {
    const verdict = evalTargetVerdict(PRODUCTION_ORIGIN, { [EVAL_IDENTITY_ENV.allowProd]: '1' });
    expect(verdict).toEqual({ kind: 'allowed', origin: PRODUCTION_ORIGIN, why: 'override' });
  });

  // Anything other than exactly "1" is not consent. A shell that exports the
  // variable empty, or to `0`, or to `false`, has not chosen production.
  test.each(['', '0', 'false', 'yes', ' '])('%s does not unlock production', (value) => {
    expect(evalTargetVerdict(PRODUCTION_ORIGIN, { [EVAL_IDENTITY_ENV.allowProd]: value }).kind)
      .toBe('refused');
  });

  test('the staging origin is allowed, with and without a trailing slash', () => {
    expect(evalTargetVerdict(EVAL_STAGING_ORIGIN, {}).kind).toBe('allowed');
    expect(evalTargetVerdict(`${EVAL_STAGING_ORIGIN}/`, {})).toEqual({
      kind: 'allowed', origin: EVAL_STAGING_ORIGIN, why: 'staging',
    });
  });

  // Both deployments run `workers_dev: false`, so the staging origin is the ONE
  // name that reaches the staging Worker. A near-miss — the same host under a
  // different scheme, a subdomain of it, or a `workers.dev` label that merely
  // contains it — is a different deployment and gets no credit for looking
  // similar. `startsWith` or `includes` would pass every line below.
  test.each([
    'http://staging.kinu.run',
    'https://staging.kinu.run.evil.example',
    'https://evil.staging.kinu.run',
    'https://staging.kinu.run:8443',
    'https://kinu-staging.ashishkmr472.workers.dev',
    'https://kinu.ashishkmr472.workers.dev',
  ])('%s is not the staging deployment', (origin) => {
    expect(evalTargetVerdict(origin, {}).kind).toBe('refused');
  });

  test.each([
    'http://localhost:5173',
    'http://127.0.0.1:8787',
    'http://[::1]:8787',
    'http://localhost',
  ])('%s is a local dev server', (origin) => {
    expect(evalTargetVerdict(origin, {})).toEqual({ kind: 'allowed', origin, why: 'local' });
  });

  test('a value that is not a URL is refused rather than parsed loosely', () => {
    const verdict = evalTargetVerdict('staging.kinu.run', {});
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') expect(verdict.reason).toContain('not a URL');
  });

  // An explicitly blanked variable is a mistake, not a request for the default:
  // `scripts/tbench-arm.sh` refuses the same shape for the same reason — an
  // empty export overrides a default and then fails much later, far from cause.
  test('an empty origin is refused, and the refusal names the variable', () => {
    const verdict = evalTargetVerdict('', {});
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') expect(verdict.reason).toContain(EVAL_IDENTITY_ENV.origin);
  });
});

describe('resolveEvalIdentity — the credential is the eval service account or nothing', () => {
  test('a token with no origin runs against staging, as the eval service account', () => {
    const resolved = resolveEvalIdentity({ [EVAL_IDENTITY_ENV.token]: 'pta_eval' });
    expect(resolved).toEqual({
      kind: 'ready',
      identity: {
        origin: EVAL_STAGING_ORIGIN,
        token: 'pta_eval',
        account: EVAL_SERVICE_ACCOUNT,
        why: 'staging',
        describe: `${EVAL_SERVICE_ACCOUNT} @ ${EVAL_STAGING_ORIGIN} (staging)`,
      },
    });
  });

  // The whole point of the module: an empty environment yields a SKIP, never a
  // borrowed session. Before this, the same case reached into
  // `~/.proteus/config.json` and ran as the owner.
  test('an empty environment is absent — no session is borrowed from anyone', () => {
    const resolved = resolveEvalIdentity({});
    expect(resolved.kind).toBe('absent');
    if (resolved.kind === 'absent') {
      expect(resolved.reason).toContain(EVAL_IDENTITY_ENV.token);
      expect(resolved.reason).toContain(EVAL_SERVICE_ACCOUNT);
    }
  });

  test('a blank token is not a credential', () => {
    expect(resolveEvalIdentity({ [EVAL_IDENTITY_ENV.token]: '   ' }).kind).toBe('absent');
  });

  // A credential aimed at production is never a skip. Someone meant this to
  // run, and a silent skip would leave them believing it had.
  test('a credential aimed at production is refused, not skipped', () => {
    const resolved = resolveEvalIdentity({
      [EVAL_IDENTITY_ENV.token]: 'pta_eval',
      [EVAL_IDENTITY_ENV.origin]: PRODUCTION_ORIGIN,
    });
    expect(resolved.kind).toBe('refused');
  });

  // Absence is checked BEFORE the target, so a machine with no credential
  // reports the credential it lacks rather than an origin it was never going to
  // reach. Both are true; only one is actionable.
  test('no credential outranks a bad target', () => {
    expect(resolveEvalIdentity({ [EVAL_IDENTITY_ENV.origin]: PRODUCTION_ORIGIN }).kind)
      .toBe('absent');
  });
});

describe('evalWorkspaceName — every row an eval leaves behind is attributable', () => {
  test('the name carries the prefix the cleanup command globs on', () => {
    expect(evalWorkspaceName('Live Smoke')).toMatch(
      new RegExp(`^${EVAL_WORKSPACE_PREFIX}live-smoke-[a-z0-9]{1,6}$`),
    );
  });

  test('two calls do not collide, so a suite can run twice', () => {
    expect(evalWorkspaceName('smoke')).not.toBe(evalWorkspaceName('smoke'));
  });
});

/**
 * The constants above are copies of facts that live in `wrangler.jsonc`. These
 * cases are what stops them becoming stale copies — the deployment is the source
 * of truth, and a rename there must fail here rather than quietly point the
 * evals at a Worker that no longer exists.
 */
describe('the staging facts match the staging deployment', () => {
  test('env.staging is found, so the production slice above it is a real slice', () => {
    expect(STAGING_AT).toBeGreaterThan(0);
  });

  test('EVAL_STAGING_ORIGIN is the origin env.staging hands its CLIs', () => {
    expect(WRANGLER.slice(STAGING_AT)).toContain(`"CLI_PUBLIC_ORIGIN": "${EVAL_STAGING_ORIGIN}"`);
  });

  test('EVAL_SERVICE_EMAIL is the identity staging synthesizes for every request', () => {
    expect(WRANGLER.slice(STAGING_AT)).toContain(`"DEV_USER_EMAIL": "${EVAL_SERVICE_EMAIL}"`);
  });

  // `authenticateRequest` treats DEV_USER_EMAIL as "skip the session check and
  // be this person" (auth/session.ts:93). In production that is an
  // unauthenticated login as a fixed user, so its ABSENCE there is the load-
  // bearing half of the same var.
  test('production sets no DEV_USER_EMAIL, so the bypass exists only on staging', () => {
    expect(WRANGLER.slice(0, STAGING_AT)).not.toContain('"DEV_USER_EMAIL"');
  });
});
