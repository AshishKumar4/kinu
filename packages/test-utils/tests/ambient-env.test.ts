/**
 * The strip that keeps a signed-in shell out of the suites, and the wiring that
 * makes it actually happen.
 *
 * Both halves are here on purpose. The rule itself is pure and cheap to assert;
 * the part that broke was never the rule, it was that no rule existed and the
 * per-file blanks each covered a different subset. So the last two cases run the
 * preload module for real, with the credentials exported, and read back what a
 * test process would see — the same shape of proof as asserting a bunfig
 * pattern rather than trusting it.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import * as v from 'valibot';
import {
  AMBIENT_CREDENTIAL_ENV, LIVE_MODEL_ENV, stripAmbientCredentials,
} from '../src/ambient-env';

const repoRoot = resolve(import.meta.dir, '../../..');

const ChildEnvSchema = v.record(v.string(), v.string());

/** What `scripts/test-scratch-home.ts` leaves behind, run for real under `env`. */
function envAfterPreload(env: Record<string, string>) {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath, '-e',
      "import './scripts/test-scratch-home.ts';"
      + 'console.log(JSON.stringify(process.env));',
    ],
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`preload failed (${String(proc.exitCode)}): ${proc.stderr.toString()}`);
  }
  return v.parse(ChildEnvSchema, JSON.parse(proc.stdout.toString()));
}

const SIGNED_IN_SHELL = {
  KINU_ORIGIN: 'https://staging.kinu.run',
  KINU_TOKEN: 'ptc_ambient_from_a_previous_command',
};

describe('the rule', () => {
  test('every target the live-model resolver reads is a target the strip removes', () => {
    // Derived from one declaration rather than listed twice: a resolver taught a
    // new spelling gains the strip on the same commit. Cross-checked against
    // both halves so a flatten that silently dropped the arrays would fail.
    expect(AMBIENT_CREDENTIAL_ENV).toContain(LIVE_MODEL_ENV.origin);
    expect(AMBIENT_CREDENTIAL_ENV).toContain(LIVE_MODEL_ENV.token);
    for (const names of [LIVE_MODEL_ENV.gatewayURL, LIVE_MODEL_ENV.gatewayAuth, LIVE_MODEL_ENV.model]) {
      for (const name of names) expect(AMBIENT_CREDENTIAL_ENV).toContain(name);
    }
    // Enumerated, not counted: a bare length cannot say which name arrived or
    // left, and this set is the contract two runners depend on.
    expect([...AMBIENT_CREDENTIAL_ENV].sort()).toEqual([
      'AI_GATEWAY_AUTH', 'AI_GATEWAY_BASE_URL', 'AI_GATEWAY_MODEL',
      'KINU_AUTH', 'KINU_BASE_URL', 'KINU_MODEL', 'KINU_ORIGIN', 'KINU_TOKEN',
    ]);
  });

  test('it reports what it took and leaves everything else alone', () => {
    const env = { ...SIGNED_IN_SHELL, KINU_HOME: '/tmp/scratch', PATH: '/usr/bin' };
    expect([...stripAmbientCredentials(env)].sort()).toEqual(['KINU_ORIGIN', 'KINU_TOKEN']);
    expect(Object.keys(env).sort()).toEqual(['KINU_HOME', 'PATH']);
    expect(env.KINU_HOME).toBe('/tmp/scratch');
  });

  test('an exported-but-empty variable is removed, not left as an empty string', () => {
    // `KINU_BASE_URL=` is what someone trying to CLEAR the variable produces,
    // and an empty string is not absence: scripts/tbench-arm.sh refuses on
    // exactly this shape because the adapter resolves the empty value in
    // preference to its own default. Presence is the test, never truthiness.
    const env = { KINU_BASE_URL: '', KINU_AUTH: 'Bearer x' };
    expect([...stripAmbientCredentials(env)].sort()).toEqual(['KINU_AUTH', 'KINU_BASE_URL']);
    expect(Object.keys(env)).toEqual([]);
  });

  test('a clean environment is left untouched and reported as such', () => {
    const env = { PATH: '/usr/bin' };
    expect(stripAmbientCredentials(env)).toEqual([]);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('the wiring', () => {
  test('a test process started from a signed-in shell sees no credential', () => {
    // The whole point, proven by running the preload rather than by reading it.
    // Without the strip this returns the two values it was given.
    const env = envAfterPreload(SIGNED_IN_SHELL);
    for (const name of AMBIENT_CREDENTIAL_ENV) expect(env[name]).toBeUndefined();
    // And the isolation it already had is still in place, so this case cannot
    // pass by having broken the throwaway home instead.
    expect(env.KINU_HOME).toMatch(/kinu-test-home-/);
  });

  test('the eval tier keeps them, because it is the one that consented', () => {
    const env = envAfterPreload({ ...SIGNED_IN_SHELL, KINU_EVAL_LIVE: '1' });
    expect(env.KINU_ORIGIN).toBe(SIGNED_IN_SHELL.KINU_ORIGIN);
    expect(env.KINU_TOKEN).toBe(SIGNED_IN_SHELL.KINU_TOKEN);
  });
});
