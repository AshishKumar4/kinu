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
import { stepCountIs } from 'ai';
import { describe, test, expect, spyOn } from 'bun:test';
import { APICallError, type LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describeProviderError, runChat } from '../src/index';

interface CircularProviderError {
  code: undefined;
  self?: CircularProviderError;
}

/** OpenAI-shaped in-band stream failure: 200 OK, then an error object. */
function inBandErrorModel<ErrorPayload>(error: ErrorPayload): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'error', error });
          c.close();
        },
      }),
      response: { headers: {} },
    }),
  });
}

async function runToCompletion(model: LanguageModel): Promise<void> {
  for await (const _ of runChat({
    model,
    system: 'sys',
    history: [{ role: 'user', content: 'go' }],
    tools: {},
    stopWhen: stepCountIs(1),
  })) { /* drain */ }
}

async function rejectionOf(action: () => Promise<void>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected Error rejection, received ${String(error)}`, { cause: error });
  }
  throw new Error('expected action to reject');
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

  test('keeps an AI SDK response body when its generic Error message carries no detail', () => {
    const error = new APICallError({
      message: 'AI_APICallError',
      url: 'https://example.invalid/v1/chat/completions',
      requestBodyValues: {},
      responseBody: '{"error":"models.dev provider was not found"}',
    });

    expect(describeProviderError(error)).toContain('models.dev provider was not found');
  });

  test('falls back to the JSON, never to [object Object]', () => {
    expect(describeProviderError({ status: 402, body: 'nope' })).toBe('{"status":402,"body":"nope"}');
    expect(describeProviderError({})).toBe('{}');
  });

  test('names the fields when JSON cannot serialize the payload', () => {
    const circular: CircularProviderError = { code: undefined };
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

    const thrown = await rejectionOf(() => runToCompletion(model));

    expect(thrown.message).toContain('Your account is not active.');
    expect(thrown.message).not.toContain('[object Object]');
  });

  test('an Error payload is rethrown verbatim, so callers can still classify it', async () => {
    const cause = new Error('context length exceeded');
    const thrown = await rejectionOf(() => runToCompletion(inBandErrorModel(cause)));

    expect(thrown).toBe(cause);
  });

  test('does not dump the raw payload to the console', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await rejectionOf(() => runToCompletion(inBandErrorModel({ message: 'nope', code: 'billing_not_active' })));
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
