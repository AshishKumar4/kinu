// A provider failure reached the user as `[object Object]`.
//
// `streamText` routes provider failures into the stream as an `error` chunk
// whose payload is whatever the endpoint sent. The OpenAI-compatible provider
// forwards the parsed body verbatim — a PLAIN OBJECT, not an Error — and
// runChat rethrew it as `new Error(String(payload))`. Separately the SDK's
// default `onError` is `console.error(error)`, so the same failure was also
// dumped raw to the terminal next to our own rendering of it.
//
// These pin both: the thrown message carries the provider's words, and the
// turn does not write the payload to the console behind our back.
import { describe, test, expect, spyOn } from 'bun:test';
import type { ModelStreamPart } from '@proteus/test-utils';
import { describeProviderError, runChat } from '../src/index.ts';

/** OpenAI-shaped in-band stream failure: 200 OK, then an error object. */
function inBandErrorModel(error: unknown) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async () => ({
      stream: new ReadableStream<ModelStreamPart>({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'error', error } as ModelStreamPart);
          c.close();
        },
      }),
      response: { headers: {} },
    }),
  };
}

async function runToCompletion(model: unknown): Promise<void> {
  for await (const _ of runChat({
    model: model as never,
    system: 'sys',
    history: [{ role: 'user', content: 'go' }],
    tools: {} as never,
    maxSteps: 1,
  })) { /* drain */ }
}

describe('describeProviderError', () => {
  test('digs the message out of an OpenAI-shaped error object', () => {
    expect(describeProviderError({
      message: 'Your account is not active.',
      type: 'invalid_request_error',
      code: 'billing_not_active',
    })).toBe('Your account is not active. (billing_not_active)');
  });

  test('follows a nested error envelope', () => {
    expect(describeProviderError({ error: { error: { message: 'upstream refused' } } }))
      .toBe('upstream refused');
  });

  test('does not repeat a code the message already states', () => {
    expect(describeProviderError({ message: 'rate_limit_exceeded on this key', code: 'rate_limit_exceeded' }))
      .toBe('rate_limit_exceeded on this key');
  });

  test('keeps an Error message, and names the error when it has none', () => {
    expect(describeProviderError(new Error('boom'))).toBe('boom');
    expect(describeProviderError(new TypeError(''))).toBe('TypeError');
  });

  test('falls back to the JSON, never to [object Object]', () => {
    expect(describeProviderError({ status: 402, body: 'nope' })).toBe('{"status":402,"body":"nope"}');
    expect(describeProviderError({})).toBe('{}');
  });

  test('names the fields when JSON cannot serialize the payload', () => {
    const circular: Record<string, unknown> = { code: undefined };
    circular.self = circular;

    const described = describeProviderError(circular);

    expect(described).toContain('self');
    expect(described).not.toContain('[object Object]');
  });
});

describe('runChat provider failures', () => {
  test('rethrows a plain-object error chunk with the provider text, not [object Object]', async () => {
    const model = inBandErrorModel({
      message: 'Your account is not active.',
      type: 'invalid_request_error',
      code: 'billing_not_active',
    });

    const thrown = await runToCompletion(model).then(() => null, (err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Your account is not active.');
    expect((thrown as Error).message).not.toContain('[object Object]');
  });

  test('an Error payload is rethrown verbatim, so callers can still classify it', async () => {
    const cause = new Error('context length exceeded');
    const thrown = await runToCompletion(inBandErrorModel(cause)).then(() => null, (err: unknown) => err);

    expect(thrown).toBe(cause);
  });

  test('does not dump the raw payload to the console', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runToCompletion(inBandErrorModel({ message: 'nope', code: 'billing_not_active' })).catch(() => {});
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
