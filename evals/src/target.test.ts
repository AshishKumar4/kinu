import { describe, expect, test } from 'bun:test';
import { resolveEvalTarget } from './target';

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
