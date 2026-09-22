/**
 * The production origin is read from `wrangler.jsonc`, not restated, so a moved deployment
 * fails here.
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
 * `CLI_PUBLIC_ORIGIN` is the origin the Worker hands every CLI. Matched on the key, not parsed:
 * the file is JSONC, and `unit-preview-origin.test.ts` and `scripts/infra-manifest.ts` do the same.
 */
const DEPLOYMENT_ORIGIN = ((): string => {
  const match = /"CLI_PUBLIC_ORIGIN":\s*"([^"]+)"/.exec(WRANGLER);

  if (!match?.[1]) throw new Error('wrangler.jsonc declares no CLI_PUBLIC_ORIGIN');

  return match[1];
})();

/** A foreign origin with a real hostname shape, not `example.com`. */
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

  // `workers_dev` is off, so the declared origin is the only name reaching the Worker;
  // `startsWith` or `includes` would pass every near-miss below.
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

    // The refusal names the variable and the one origin.
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

  // A blanked variable is a mistake, not the default (`scripts/tbench-arm.sh` refuses it too).
  test('an empty origin is refused, and the refusal names the variable', () => {
    const verdict = evalTargetVerdict('');
    expect(verdict.kind).toBe('refused');

    if (verdict.kind === 'refused') expect(verdict.reason).toContain(EVAL_IDENTITY_ENV.origin);
  });
});

/** Deployment URLs come from `cloudProxyBaseURL`, so moving the route fails these cases. */
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

  // The origin decides first: an allowed origin passes with or without the inference route.
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

  // Origin-first: an undeclared origin behind the inference route is refused, not read as a gateway.
  test('a host belonging to nobody here is refused when it wears the route', () => {
    const verdict = evalModelEndpointVerdict(cloudProxyBaseURL('https://attacker.example'));
    expect(verdict.kind).toBe('checked');

    if (verdict.kind === 'checked') expect(verdict.target.kind).toBe('refused');
  });

  // A gateway fronts a model and no deployment, so there is no origin to rule on; the last
  // case is not a URL.
  test.each([
    'https://gateway.ai.cloudflare.com/v1/acct-id/gw-name/workers-ai/v1',
    'https://api.openai.com/v1',
    'https://api.anthropic.com/v1',
    'staging.kinu.run',
  ])('%s fronts a model, not a deployment', (baseUrl) => {
    expect(evalModelEndpointVerdict(baseUrl)).toEqual({ kind: 'gateway' });
  });

  // Known boundary: a refused origin on another path reads as a gateway; `/api/cli/workspaces`
  // serves no completions.
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

  // An empty environment yields a skip, never a borrowed session.
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

  // A production-aimed credential is never a skip; a silent skip would hide that it did not run.
  test('a credential aimed at a foreign deployment is refused, not skipped', () => {
    const resolved = resolveEvalIdentity({
      [EVAL_IDENTITY_ENV.token]: 'pta_eval',
      [EVAL_IDENTITY_ENV.origin]: FOREIGN_ORIGIN,
    });

    expect(resolved.kind).toBe('refused');
  });

  // Absence is checked before the target, so the missing credential is what gets reported.
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

  test('a long subject still fits the product address grammar', () => {
    // The creation gate refuses over 31 chars or outside lowercase alphanumerics and hyphens.
    for (const name of [
      evalWorkspaceName('first-run-two-machines-fleet'),
      evalWorkspaceName('first-run-approve-clears-approve'),
      evalWorkspaceName('first-run-codemode-craft-craft'),
    ]) {
      expect(name.length).toBeLessThanOrEqual(31);
      expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/);
      expect(name.startsWith(EVAL_WORKSPACE_PREFIX)).toBe(true);
    }
  });

  test('two calls do not collide, so a suite can run twice', () => {
    const first = evalWorkspaceName('smoke');
    const second = evalWorkspaceName('smoke');
    expect(first).toMatch(new RegExp(`^${EVAL_WORKSPACE_PREFIX}smoke-[a-z0-9]{1,6}$`));
    expect(second).toMatch(new RegExp(`^${EVAL_WORKSPACE_PREFIX}smoke-[a-z0-9]{1,6}$`));
    expect(first).not.toBe(second);
  });
});

/** The constants above copy `wrangler.jsonc`; a rename there must fail here. */
describe('the eval facts match the deployment', () => {
  test('EVAL_DEPLOYMENT_ORIGIN is the origin wrangler hands its CLIs', () => {
    expect(WRANGLER).toContain(`"CLI_PUBLIC_ORIGIN": "${EVAL_DEPLOYMENT_ORIGIN}"`);
  });

  test('EVAL_SERVICE_EMAIL is the identity the deployment synthesizes for a secret-bearing request', () => {
    expect(WRANGLER).toContain(`"DEV_USER_EMAIL": "${EVAL_SERVICE_EMAIL}"`);
  });

  // `authenticateRequest` synthesizes DEV_USER_EMAIL only for DEV_IDENTITY_SECRET (auth/session.ts) and
  // the admin gate refuses `provider: 'dev'`; a second host would be a third door, so workers.dev stays off.
  test('the deployment has one origin: workers_dev is off', () => {
    expect(WRANGLER).toMatch(/"workers_dev":\s*false/);
    expect(WRANGLER).not.toContain('"env": {');
  });
});
