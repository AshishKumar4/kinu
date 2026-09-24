import { describe, expect, test } from 'bun:test';
import { resolveEvalTarget } from './target';

describe('resolveEvalTarget', () => {
  test('an origin outside the eval allowlist is refused before any trial spends', () => {
    expect(() => resolveEvalTarget({ KINU_EVAL_ORIGIN: 'https://example.com', KINU_EVAL_WEB_IDENTITY: 'secret' }))
      .toThrow(/not an eval target/);
  });

  test('the deployment resolves with its identity, and without one the refusal names the variable', () => {
    expect(resolveEvalTarget({ KINU_EVAL_WEB_IDENTITY: 'secret' }).origin).toBe('https://kinu.run');
    expect(() => resolveEvalTarget({})).toThrow(/KINU_EVAL_WEB_IDENTITY/);
  });
});
