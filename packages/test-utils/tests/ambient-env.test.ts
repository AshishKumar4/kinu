/**
 * The last cases run the preload for real with credentials exported and read back what a
 * test process sees.
 */

import { describe, expect, test } from 'bun:test';
import { join, basename, resolve } from 'node:path';
import * as v from 'valibot';
import {
  AMBIENT_CREDENTIAL_ENV, LIVE_MODEL_ENV, envObject, stripAmbientCredentials,
} from '../src/ambient-env';
import { SCRATCH_ROOT_PREFIX } from '../src/scratch';

const repoRoot = resolve(import.meta.dir, '../../..');

const ChildEnvSchema = v.record(v.string(), v.string());

/** What `scripts/test-scratch-home.ts` leaves behind, run for real under `env`. */
function envAfterPreload(env: Record<string, string>) {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath, '-e',
      "import { release } from './scripts/test-scratch-home.ts';"
      + 'console.log(JSON.stringify(process.env)); release();',
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
    // Derived from one declaration; cross-checked against both halves so a flatten that
    // dropped the arrays fails.
    expect(AMBIENT_CREDENTIAL_ENV).toContain(LIVE_MODEL_ENV.origin);
    expect(AMBIENT_CREDENTIAL_ENV).toContain(LIVE_MODEL_ENV.token);

    for (const names of [LIVE_MODEL_ENV.gatewayURL, LIVE_MODEL_ENV.gatewayAuth, LIVE_MODEL_ENV.model]) {
      for (const name of names) expect(AMBIENT_CREDENTIAL_ENV).toContain(name);
    }

    // Enumerated, not counted: this set is the contract two runners depend on.
    expect([...AMBIENT_CREDENTIAL_ENV].sort()).toEqual([
      'AI_GATEWAY_AUTH', 'AI_GATEWAY_BASE_URL', 'AI_GATEWAY_MODEL',
      'KINU_AUTH', 'KINU_BASE_URL', 'KINU_MODEL', 'KINU_ORIGIN', 'KINU_TOKEN',
    ]);
  });

  test('it reports what it took and leaves everything else alone', () => {
    const env = { ...SIGNED_IN_SHELL, KINU_HOME: '/tmp/scratch', PATH: '/usr/bin' };
    expect([...stripAmbientCredentials(envObject(env))].sort()).toEqual(['KINU_ORIGIN', 'KINU_TOKEN']);
    expect(Object.keys(env).sort()).toEqual(['KINU_HOME', 'PATH']);
    expect(env.KINU_HOME).toBe('/tmp/scratch');
  });

  test('an exported-but-empty variable is removed, not left as an empty string', () => {
    // An empty string is not absence (`scripts/tbench-arm.sh` refuses it too): presence is the
    // test, never truthiness.
    const env = { KINU_BASE_URL: '', KINU_AUTH: 'Bearer x' };
    expect([...stripAmbientCredentials(envObject(env))].sort()).toEqual(['KINU_AUTH', 'KINU_BASE_URL']);
    expect(Object.keys(env)).toEqual([]);
  });

  test('a clean environment is left untouched and reported as such', () => {
    const env = { PATH: '/usr/bin' };
    expect(stripAmbientCredentials(envObject(env))).toEqual([]);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('the wiring', () => {
  test.each(['', '/outside-test-home'])('the daemon inflight root ignores the inherited value %j', (inherited) => {
    const env = envAfterPreload({ KINU_INFLIGHT_ROOT: inherited });
    expect(env.KINU_INFLIGHT_ROOT).toBe(join(env.KINU_HOME, 'inflight'));
    expect(env.KINU_INFLIGHT_ROOT).not.toBe(inherited);
  });

  test('a test process started from a signed-in shell sees no credential', () => {
    const env = envAfterPreload(SIGNED_IN_SHELL);

    for (const name of AMBIENT_CREDENTIAL_ENV) expect(env[name]).toBeUndefined();
    // The throwaway home is `$TMPDIR/home`, and TMPDIR sits in the release-owned `kinu-scratch-` namespace.
    expect(basename(env.KINU_HOME)).toBe('home');
    expect(env.KINU_HOME).toBe(join(env.TMPDIR, 'home'));
    expect(basename(env.TMPDIR)).toStartWith(SCRATCH_ROOT_PREFIX);
  });

  test('the eval tier keeps them, because it is the one that consented', () => {
    const env = envAfterPreload({ ...SIGNED_IN_SHELL, KINU_EVAL_LIVE: '1' });
    expect(env.KINU_ORIGIN).toBe(SIGNED_IN_SHELL.KINU_ORIGIN);
    expect(env.KINU_TOKEN).toBe(SIGNED_IN_SHELL.KINU_TOKEN);
  });
});
