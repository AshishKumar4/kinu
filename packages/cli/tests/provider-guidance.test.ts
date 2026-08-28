// Every CLI failure renders through guideFailure. What it must guarantee: a
// real message for any thrown shape, and the exact next command for the
// failure classes a user can actually do something about.
//
// KINU-043: the classification reads the FACTS the provider boundary preserved
// — the HTTP status and the provider's own code — and falls back to matching
// wording only when neither survived. The prose-only version sent a 402 to the
// credential hint on any gateway that phrased it without the word billing.
import { describe, expect, test } from 'bun:test';
import { APICallError } from '@ai-sdk/provider';
import { guideFailure } from '../src/provider-guidance';

function apiFailure(input: { statusCode?: number; responseBody?: string }): APICallError {
  return new APICallError({
    message: 'AI_APICallError',
    url: 'https://example.invalid/v1/chat/completions',
    requestBodyValues: {},
    ...input,
  });
}

describe('guideFailure', () => {
  test('digs the message out of a raw provider payload', () => {
    const guided = guideFailure({ cause: { error: { message: 'Your account is not active.', code: 'billing_not_active' } } });

    expect(guided.message).toContain('Your account is not active.');
    expect(guided.message).not.toContain('[object Object]');
  });

  test('points a credential rejection at provider connect', () => {
    expect(guideFailure({ cause: new Error('401 Unauthorized: invalid_api_key') }).hint)
      .toContain('kinu provider connect');
  });

  test('points a billing failure at the account, not at the credential', () => {
    const guided = guideFailure({ cause: 'Your account is not active. (billing_not_active)' });

    expect(guided.hint).toContain('billing or quota');
    expect(guided.hint).toContain('kinu provider');
  });

  test('points an unknown model at the model picker', () => {
    expect(guideFailure({ cause: new Error('The model `gpt-5.5` does not exist') }).hint).toContain('/model');
  });

  test('points a rate limit at retrying or switching', () => {
    expect(guideFailure({ cause: new Error('429 rate_limit_exceeded') }).hint).toMatch(/retry/i);
  });

  test('points a context overflow at a fresh session or a bigger model', () => {
    expect(guideFailure({ cause: new Error('maximum context length is 8192 tokens') }).hint).toContain('/model');
  });

  test('leaves an error that already names its own commands alone', () => {
    const own = 'No LLM configured.\n  Run kinu auth to use your Cloudflare AI, run kinu setup …';

    expect(guideFailure({ cause: new Error(own) }).hint).toBeUndefined();
  });

  test('adds no hint to a failure it cannot classify', () => {
    expect(guideFailure({ cause: new Error('workspace "jarvis" not found') })).toEqual({
      message: 'workspace "jarvis" not found',
    });
  });

  test('never renders an empty failure as nothing', () => {
    expect(guideFailure({ cause: new Error('') }).message).toBe('Error');
    expect(guideFailure({ cause: '   ' }).message).toBe('unknown provider error');
  });
});

describe('guideFailure reads the preserved facts', () => {
  test('a 402 goes to the account, not to the credential — with no billing word anywhere', () => {
    const guided = guideFailure({ cause: apiFailure({ statusCode: 402 }) });

    expect(guided.hint).toContain('billing or quota');
    expect(guided.message).not.toMatch(/billing/i);
  });

  test('a status alone is enough for every class it names', () => {
    expect(guideFailure({ cause: apiFailure({ statusCode: 401 }) }).hint).toContain('kinu provider connect');
    expect(guideFailure({ cause: apiFailure({ statusCode: 403 }) }).hint).toContain('kinu provider connect');
    expect(guideFailure({ cause: apiFailure({ statusCode: 404 }) }).hint).toContain('/model');
    expect(guideFailure({ cause: apiFailure({ statusCode: 429 }) }).hint).toMatch(/retry/i);
  });

  test("the provider's own code beats the status it arrives with", () => {
    // A context overflow is a 400 like any malformed request, so the status
    // alone would send the user off to fix their input.
    const guided = guideFailure({
      cause: apiFailure({
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { message: 'Request too large for this model', code: 'context_length_exceeded' },
        }),
      }),
    });

    expect(guided.hint).toContain('/model');
    expect(guided.hint).toContain('fresh session');
  });

  test('a status Kinu has no remedy for adds no hint and invents no words', () => {
    expect(guideFailure({ cause: apiFailure({ statusCode: 418 }) })).toEqual({
      message: 'AI_APICallError (HTTP 418)',
    });
  });

  test('the response body never reaches the user, whatever it carried', () => {
    const guided = guideFailure({ cause: apiFailure({
      statusCode: 502,
      responseBody: '<html>502 — upstream POST {"authorization":"Bearer sk-live-9f3"}</html>',
    }) });

    expect(guided.message).not.toContain('sk-live');
    expect(guided.message).not.toContain('authorization');
    expect(guided.message).toBe('AI_APICallError (HTTP 502)');
  });
});
