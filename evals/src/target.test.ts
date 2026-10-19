import { describe, expect, test } from 'bun:test';
import { WORKER_VERSION_HEADER } from '@kinu.run/core';
import { buildChanged, deployedBuild, resolveEvalTarget } from './target';

describe('resolveEvalTarget', () => {
  test.each(['', '   '])('an explicitly blank origin %j is refused before resolving a secret', (origin) => {
    expect(() => resolveEvalTarget({ KINU_EVAL_ORIGIN: origin, KINU_EVAL_WEB_IDENTITY: 'secret' }))
      .toThrow(/KINU_EVAL_ORIGIN.*empty value/);
  });

  test('an origin outside the eval allowlist is refused before any trial spends', () => {
    expect(() => resolveEvalTarget({ KINU_EVAL_ORIGIN: 'https://example.com', KINU_EVAL_WEB_IDENTITY: 'secret' }))
      .toThrow(/not an eval target/);
  });

  test('the deployment resolves with its identity, and without one the refusal names the variable', () => {
    expect(resolveEvalTarget({ KINU_EVAL_WEB_IDENTITY: 'secret' }).origin).toBe('https://kinu.run');
    expect(() => resolveEvalTarget({})).toThrow(/KINU_EVAL_WEB_IDENTITY/);
  });

  test('each deployment resolves only with its own identity, never the other\'s secret', () => {
    const staging = 'https://staging.kinu.run';

    expect(resolveEvalTarget({ KINU_EVAL_ORIGIN: staging, KINU_EVAL_STAGING_WEB_IDENTITY: 'staging' }).identity)
      .toEqual({ kind: 'secret', secret: 'staging' });
    expect(() => resolveEvalTarget({ KINU_EVAL_ORIGIN: staging, KINU_EVAL_WEB_IDENTITY: 'production' }))
      .toThrow(/KINU_EVAL_STAGING_WEB_IDENTITY/);
    expect(() => resolveEvalTarget({ KINU_EVAL_STAGING_WEB_IDENTITY: 'staging' })).toThrow(/KINU_EVAL_WEB_IDENTITY/);
  });
});

// Staging, 2026-10-19 18:24-18:58Z: five Secret Change versions of one build reset every Durable Object under the rc22
// evals, and the trials read as the product losing its background jobs. The build stamp never moved; the version did.
describe('a trial\'s deployment, read at its start and its end', () => {
  test('a new Worker version of the same build is a change the trial names; the same version is none', async () => {
    let version = '2a9b190f-23b6-4f01-99f1-59138503c07d';

    const deployment = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true, build: { version: '0.2.0+2620e7c05', sha: '2620e7c05', builtAt: '2026-10-19T17:00:00Z' } }, {
        headers: { [WORKER_VERSION_HEADER]: version },
      }),
    });

    try {
      const target = { origin: deployment.url.origin };
      const before = await deployedBuild(target);

      expect(buildChanged(before, await deployedBuild(target))).toBeNull();
      version = '7c1d5e2a-9f04-4b8e-a3d1-0c2b6e5f8a91';
      const after = await deployedBuild(target);

      expect(before).toEqual({ sha: '2620e7c05', version: '2a9b190f-23b6-4f01-99f1-59138503c07d' });
      expect(buildChanged(before, after)).toContain('2a9b190f then 7c1d5e2a');
      expect(buildChanged(before, { sha: 'af8995c96', version: after.version })).toContain('2620e7c05 then af8995c96');
      // A deployment that names no version (a loopback one) is judged on its build alone.
      expect(buildChanged({ sha: '2620e7c05', version: null }, { sha: '2620e7c05', version: null })).toBeNull();
    } finally {
      await deployment.stop(true);
    }
  });
});
