// Every CLI failure renders through guideFailure. What it must guarantee: a
// real message for any thrown shape, and the exact next command for the
// failure classes a user can actually do something about.
import { describe, expect, test } from 'bun:test';
import { guideFailure } from '../src/provider-guidance';

describe('guideFailure', () => {
  test('digs the message out of a raw provider payload', () => {
    const guided = guideFailure({ error: { message: 'Your account is not active.', code: 'billing_not_active' } });

    expect(guided.message).toContain('Your account is not active.');
    expect(guided.message).not.toContain('[object Object]');
  });

  test('points a credential rejection at provider connect', () => {
    expect(guideFailure(new Error('401 Unauthorized: invalid_api_key')).hint)
      .toContain('kinu provider connect');
  });

  test('points a billing failure at the account, not at the credential', () => {
    const guided = guideFailure('Your account is not active. (billing_not_active)');

    expect(guided.hint).toContain('billing or quota');
    expect(guided.hint).toContain('kinu provider');
  });

  test('points an unknown model at the model picker', () => {
    expect(guideFailure(new Error('The model `gpt-5.5` does not exist')).hint).toContain('/model');
  });

  test('points a rate limit at retrying or switching', () => {
    expect(guideFailure(new Error('429 rate_limit_exceeded')).hint).toMatch(/retry/i);
  });

  test('points a context overflow at a fresh session or a bigger model', () => {
    expect(guideFailure(new Error('maximum context length is 8192 tokens')).hint).toContain('/model');
  });

  test('leaves an error that already names its own commands alone', () => {
    const own = 'No LLM configured.\n  Run kinu auth to use your Cloudflare AI, run kinu setup …';

    expect(guideFailure(new Error(own)).hint).toBeUndefined();
  });

  test('adds no hint to a failure it cannot classify', () => {
    expect(guideFailure(new Error('workspace "jarvis" not found'))).toEqual({
      message: 'workspace "jarvis" not found',
    });
  });

  test('never renders an empty failure as nothing', () => {
    expect(guideFailure(new Error('')).message).toBe('Error');
    expect(guideFailure('   ').message).toBe('unknown provider error');
  });
});
