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
import { cloudProxyBaseURL } from '@kinu.run/core';
import { LIVE_MODEL_ENV } from '../src/ambient-env';
import {
  EVAL_DEPLOYMENT_ORIGIN, EVAL_IDENTITY_ENV, EVAL_SERVICE_ACCOUNT, EVAL_SERVICE_EMAIL,
  EVAL_WORKSPACE_PREFIX, evalModelEndpointVerdict, evalTargetVerdict, evalWorkspaceName,
  refusedEvalEndpoint, resolveEvalIdentity,
} from '../src/eval-identity';

const WRANGLER = readFileSync(join(import.meta.dirname, '../../cf-backend/wrangler.jsonc'), 'utf8');

/**
 * The deployment's origin, taken from the deployment rather than from a
 * literal. `CLI_PUBLIC_ORIGIN` in `vars` is what the Worker tells every CLI to
 * talk to, which makes it the definition of "the origin". Matched on the key
 * rather than derived from a parse because the file is JSONC and every other
 * reader in the tree (`unit-preview-origin.test.ts`, `scripts/infra-manifest.ts`)
 * reads it the same way.
 */
const DEPLOYMENT_ORIGIN = ((): string => {
  const match = /"CLI_PUBLIC_ORIGIN":\s*"([^"]+)"/.exec(WRANGLER);

  if (!match?.[1]) throw new Error('wrangler.jsonc declares no CLI_PUBLIC_ORIGIN');

  return match[1];
})();

/** A deployment that is NOT ours, for the refused direction. A real hostname
 *  shape rather than `example.com`, so the refusal is exercised on the kind of
 *  origin a mistake would actually produce. */
const FOREIGN_ORIGIN = 'https://staging.kinu.run';

describe('the eval target allowlist — one deployment, or a loopback, nothing else', () => {
  test('the origin wrangler declares is the eval target, with and without a trailing slash', () => {
    expect(DEPLOYMENT_ORIGIN).toBe(EVAL_DEPLOYMENT_ORIGIN);
    expect(evalTargetVerdict(EVAL_DEPLOYMENT_ORIGIN)).toEqual({
      kind: 'allowed', origin: EVAL_DEPLOYMENT_ORIGIN, why: 'deployment',
    });
    expect(evalTargetVerdict(`${EVAL_DEPLOYMENT_ORIGIN}/`)).toEqual({
      kind: 'allowed', origin: EVAL_DEPLOYMENT_ORIGIN, why: 'deployment',
    });
  });

  // `workers_dev` is off, so the declared origin is the ONE name that reaches
  // the Worker. A near-miss — the same host under a different scheme, a
  // subdomain of it, a port, or a `workers.dev` label that merely contains it —
  // is a different deployment and gets no credit for looking similar.
  // `startsWith` or `includes` would pass every line below.
  test.each([
    'http://kinu.run',
    'https://kinu.run.evil.example',
    'https://evil.kinu.run',
    'https://kinu.run:8443',
    'https://staging.kinu.run',
    'https://kinu.ashishkmr472.workers.dev',
  ])('%s is not the deployment', (origin) => {
    const verdict = evalTargetVerdict(origin);
    expect(verdict.kind).toBe('refused');

    // The refusal names the variable and the one origin, or an operator's only
    // move is to delete the guard.
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toContain(EVAL_IDENTITY_ENV.origin);
      expect(verdict.reason).toContain(EVAL_DEPLOYMENT_ORIGIN);
    }
  });

  test.each([
    'http://localhost:5173',
    'http://127.0.0.1:8787',
    'http://[::1]:8787',
    'http://localhost',
  ])('%s is a local dev server', (origin) => {
    expect(evalTargetVerdict(origin)).toEqual({ kind: 'allowed', origin, why: 'local' });
  });

  test('a value that is not a URL is refused rather than parsed loosely', () => {
    const verdict = evalTargetVerdict('kinu.run');
    expect(verdict.kind).toBe('refused');

    if (verdict.kind === 'refused') expect(verdict.reason).toContain('not a URL');
  });

  // An explicitly blanked variable is a mistake, not a request for the default:
  // `scripts/tbench-arm.sh` refuses the same shape for the same reason — an
  // empty export overrides a default and then fails much later, far from cause.
  test('an empty origin is refused, and the refusal names the variable', () => {
    const verdict = evalTargetVerdict('');
    expect(verdict.kind).toBe('refused');

    if (verdict.kind === 'refused') expect(verdict.reason).toContain(EVAL_IDENTITY_ENV.origin);
  });
});

/**
 * A model endpoint arrives as a base URL, and the two variables that carry one
 * hold either shape. `.env.example` documents an AI Gateway;
 * `.github/workflows/eval.yml` held `secrets.EVAL_BASE_URL`, which could hold
 * either.
 *
 * Measured on 2026-08-21: with `KINU_BASE_URL` set to production's inference
 * route and `KINU_AUTH` set to a bearer, `resolveLLMConfig` returns
 * `{ name: 'workers-ai', baseURL: 'https://kinu.run/api/user/ai/v1',
 * Authorization: 'Bearer …' }`, and `resolveLiveModel` calls the same URL an
 * `ai-gateway` target. Neither checked an origin.
 *
 * Every deployment URL below is built by `cloudProxyBaseURL`, the one function
 * that builds that route, so moving the route fails these cases.
 */
describe('a model endpoint carrying a deployment gets target-checked', () => {
  test('a foreign origin behind the inference route is refused, naming the variable', () => {
    const verdict = evalModelEndpointVerdict(cloudProxyBaseURL(FOREIGN_ORIGIN));
    expect(verdict.kind).toBe('checked');

    if (verdict.kind !== 'checked') return;
    expect(verdict.target.kind).toBe('refused');

    if (verdict.target.kind === 'refused') {
      expect(verdict.target.reason).toContain(EVAL_IDENTITY_ENV.origin);
      expect(verdict.target.reason).toContain(FOREIGN_ORIGIN);
    }
  });

  // The ORIGIN decides first, so an allowed origin needs no path reasoning: the
  // deployment's URL is allowed whether it carries the inference route or not.
  test.each([
    cloudProxyBaseURL(EVAL_DEPLOYMENT_ORIGIN),
    `${EVAL_DEPLOYMENT_ORIGIN}/v1`,
  ])('%s is the allowed deployment', (baseUrl) => {
    expect(evalModelEndpointVerdict(baseUrl)).toEqual({
      kind: 'checked',
      target: { kind: 'allowed', origin: EVAL_DEPLOYMENT_ORIGIN, why: 'deployment' },
    });
  });

  test('a loopback dev server is local, on any path', () => {
    expect(evalModelEndpointVerdict('http://127.0.0.1:8787/v1')).toEqual({
      kind: 'checked',
      target: { kind: 'allowed', origin: 'http://127.0.0.1:8787', why: 'local' },
    });
  });

  // An undeclared origin bearing the inference route is refused, which is what
  // origin-first buys: a set of Kinu hosts would have read this as a gateway and
  // handed it the credential.
  test('a host belonging to nobody here is refused when it wears the route', () => {
    const verdict = evalModelEndpointVerdict(cloudProxyBaseURL('https://attacker.example'));
    expect(verdict.kind).toBe('checked');

    if (verdict.kind === 'checked') expect(verdict.target.kind).toBe('refused');
  });

  // A gateway fronts a model and no deployment, so it creates nothing and there
  // is no origin to rule on. Refusing one would break the path `.env.example`
  // documents and the tier uses for models the account proxy does not front.
  // The last case is not a URL, so it names no deployment either.
  test.each([
    'https://gateway.ai.cloudflare.com/v1/acct-id/gw-name/workers-ai/v1',
    'https://api.openai.com/v1',
    'https://api.anthropic.com/v1',
    'staging.kinu.run',
  ])('%s fronts a model, not a deployment', (baseUrl) => {
    expect(evalModelEndpointVerdict(baseUrl)).toEqual({ kind: 'gateway' });
  });

  // The boundary this leaves, stated rather than hidden: a refused origin on any
  // other path reads as a gateway. It is not reachable as a model endpoint —
  // `/api/cli/workspaces` serves no completions — and closing it would need the
  // list of Kinu hosts that origin-first exists to avoid.
  test('a refused origin on another path is not classified as a deployment', () => {
    expect(evalModelEndpointVerdict(`${FOREIGN_ORIGIN}/api/cli/workspaces`))
      .toEqual({ kind: 'gateway' });
  });
});

describe('refusedEvalEndpoint — the variable an operator has to fix', () => {
  test.each([...LIVE_MODEL_ENV.gatewayURL])('%s aimed at production is named', (variable) => {
    const refusal = refusedEvalEndpoint({ [variable]: cloudProxyBaseURL(FOREIGN_ORIGIN) });
    expect(refusal?.variable).toBe(variable);
    expect(refusal?.reason).toContain(FOREIGN_ORIGIN);
  });

  test('a gateway URL is not a refusal', () => {
    expect(refusedEvalEndpoint({
      [LIVE_MODEL_ENV.gatewayURL[0]]: 'https://gateway.ai.cloudflare.com/v1/a/b/workers-ai/v1',
    })).toBeNull();
  });

  test('an environment naming no endpoint refuses nothing', () => {
    expect(refusedEvalEndpoint({})).toBeNull();
  });
});

describe('resolveEvalIdentity — the credential is the eval service account or nothing', () => {
  test('a token with no origin runs against the deployment, as the eval service account', () => {
    const resolved = resolveEvalIdentity({ [EVAL_IDENTITY_ENV.token]: 'pta_eval' });
    expect(resolved).toEqual({
      kind: 'ready',
      identity: {
        origin: EVAL_DEPLOYMENT_ORIGIN,
        token: 'pta_eval',
        account: EVAL_SERVICE_ACCOUNT,
        why: 'deployment',
        describe: `${EVAL_SERVICE_ACCOUNT} @ ${EVAL_DEPLOYMENT_ORIGIN} (deployment)`,
      },
    });
  });

  // The whole point of the module: an empty environment yields a SKIP, never a
  // borrowed session. Before this, the same case reached into
  // `~/.kinu/config.json` and ran as the owner.
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
  test('a credential aimed at a foreign deployment is refused, not skipped', () => {
    const resolved = resolveEvalIdentity({
      [EVAL_IDENTITY_ENV.token]: 'pta_eval',
      [EVAL_IDENTITY_ENV.origin]: FOREIGN_ORIGIN,
    });

    expect(resolved.kind).toBe('refused');
  });

  // Absence is checked BEFORE the target, so a machine with no credential
  // reports the credential it lacks rather than an origin it was never going to
  // reach. Both are true; only one is actionable.
  test('no credential outranks a bad target', () => {
    expect(resolveEvalIdentity({ [EVAL_IDENTITY_ENV.origin]: FOREIGN_ORIGIN }).kind)
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
    const first = evalWorkspaceName('smoke');
    const second = evalWorkspaceName('smoke');
    expect(first).toMatch(new RegExp(`^${EVAL_WORKSPACE_PREFIX}smoke-[a-z0-9]{1,6}$`));
    expect(second).toMatch(new RegExp(`^${EVAL_WORKSPACE_PREFIX}smoke-[a-z0-9]{1,6}$`));
    expect(first).not.toBe(second);
  });
});

/**
 * The constants above are copies of facts that live in `wrangler.jsonc`. These
 * cases are what stops them becoming stale copies — the deployment is the source
 * of truth, and a rename there must fail here rather than quietly point the
 * evals at a Worker that no longer exists.
 */
describe('the eval facts match the deployment', () => {
  test('EVAL_DEPLOYMENT_ORIGIN is the origin wrangler hands its CLIs', () => {
    expect(WRANGLER).toContain(`"CLI_PUBLIC_ORIGIN": "${EVAL_DEPLOYMENT_ORIGIN}"`);
  });

  test('EVAL_SERVICE_EMAIL is the identity the deployment synthesizes for a secret-bearing request', () => {
    expect(WRANGLER).toContain(`"DEV_USER_EMAIL": "${EVAL_SERVICE_EMAIL}"`);
  });

  // `authenticateRequest` synthesizes DEV_USER_EMAIL only for a request that
  // presents DEV_IDENTITY_SECRET (auth/session.ts), and the admin gate refuses
  // every `provider: 'dev'` identity (control-plane/admin-caller.ts). Those two
  // are the locks; a second host would be a third door, so workers.dev stays off.
  test('the deployment has one origin: workers_dev is off', () => {
    expect(WRANGLER).toMatch(/"workers_dev":\s*false/);
    expect(WRANGLER).not.toContain('"env": {');
  });
});
