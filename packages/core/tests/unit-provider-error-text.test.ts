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
import {
  describeProviderError, providerFailureFacts, toProviderError, runChat,
} from '../src/index';
import { KinuError } from '../src/obs/index';

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
    expect(describeProviderError({ cause: {
      message: 'Your account is not active.',
      type: 'invalid_request_error',
      code: 'billing_not_active',
    } })).toBe('Your account is not active. (billing_not_active)');
  });

  test('follows a nested error envelope', () => {
    expect(describeProviderError({ cause: { error: { error: { message: 'upstream refused' } } } }))
      .toBe('upstream refused');
  });

  test('does not repeat a code the message already states', () => {
    expect(describeProviderError({ cause: { message: 'rate_limit_exceeded on this key', code: 'rate_limit_exceeded' } }))
      .toBe('rate_limit_exceeded on this key');
  });

  test('keeps an Error message, and names the error when it has none', () => {
    expect(describeProviderError({ cause: new Error('boom') })).toBe('boom');
    expect(describeProviderError({ cause: new TypeError('') })).toBe('TypeError');
  });

  test('keeps an AI SDK response body when its generic Error message carries no detail', () => {
    const error = new APICallError({
      message: 'AI_APICallError',
      url: 'https://example.invalid/v1/chat/completions',
      requestBodyValues: {},
      responseBody: '{"error":"models.dev provider was not found"}',
    });

    expect(describeProviderError({ cause: error })).toContain('models.dev provider was not found');
  });

  // KINU-043. This used to assert `'{"status":402,"body":"nope"}'` — the whole
  // error object, stringified into the user's terminal. Whatever an SDK or a
  // gateway attached rode out with it, and a gateway attaches the request it
  // failed on. The keys are the diagnosis; the values are the leak.
  test('names the fields of an unrecognised payload instead of stringifying it', () => {
    expect(describeProviderError({ cause: { status: 402, body: 'nope' } }))
      .toBe('unrecognised provider error (fields: status, body) (HTTP 402)');
    expect(describeProviderError({ cause: { status: 402, body: 'nope' } })).not.toContain('nope');
    expect(describeProviderError({ cause: {} })).toBe('unrecognised provider error (fields: no fields)');
  });

  test('a response body that is not JSON is dropped, never printed', () => {
    const error = new APICallError({
      message: 'AI_APICallError',
      url: 'https://example.invalid/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 500,
      // What a gateway really answers when it fails before the model: an HTML
      // page, or its own echo of the request — headers included.
      responseBody: '<html><body>502 Bad Gateway — upstream POST body: {"api_key":"sk-live-9f3"}</body></html>',
    });

    const described = describeProviderError({ cause: error });
    expect(described).toBe('AI_APICallError (HTTP 500)');
    expect(described).not.toContain('sk-live');
    expect(described).not.toContain('<html>');
  });

  test('an empty Error message falls through to the error name, and an empty body does not displace it', () => {
    expect(describeProviderError({ cause: new TypeError('') })).toBe('TypeError');
    const blank = new APICallError({
      message: '',
      url: 'https://example.invalid/v1/chat/completions',
      requestBodyValues: {},
      responseBody: '""',
    });
    expect(describeProviderError({ cause: blank })).toBe('AI_APICallError');
  });

  test('the stable identifiers survive, so nothing downstream has to re-read the prose', () => {
    expect(providerFailureFacts({
      cause: {
        error: { message: 'Request too large', code: 'context_length_exceeded' },
        status: 400,
      },
    })).toEqual({
      message: 'Request too large',
      providerCode: 'context_length_exceeded',
      status: 400,
    });
    expect(providerFailureFacts({ cause: '  plain stream text  ' })).toEqual({ message: 'plain stream text' });
    expect(providerFailureFacts({ cause: undefined })).toEqual({ message: 'unknown provider error' });
  });

  test('a status classifies the failure without reading a single word of it', () => {
    const statusOnly = (statusCode: number): KinuError => toProviderError({
      doing: 'calling the model',
      cause: new APICallError({
        message: 'AI_APICallError',
        url: 'https://example.invalid/v1/chat/completions',
        requestBodyValues: {},
        statusCode,
      }),
    });
    expect(statusOnly(401).code).toBe('denied');
    expect(statusOnly(402).code).toBe('denied');
    expect(statusOnly(404).code).toBe('missing');
    expect(statusOnly(400).code).toBe('bad_input');
    expect(statusOnly(429).code).toBe('unavailable');
    expect(statusOnly(503).code).toBe('unavailable');
    expect(statusOnly(418).code).toBe('unavailable');
  });

  test('an already-classified cause keeps its class, and the raw failure stays on cause', () => {
    const cause = new KinuError('cancelled', 'the caller stopped the turn');
    const failure = toProviderError({ doing: 'calling the model', cause });
    expect(failure.code).toBe('cancelled');
    expect(failure.cause).toBe(cause);
  });

  test('names the fields when JSON cannot serialize the payload', () => {
    const circular: CircularProviderError = { code: undefined };
    circular.self = circular;

    const described = describeProviderError({ cause: circular });

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

  // KINU-043. This used to assert `expect(thrown).toBe(cause)` — the provider's
  // own object, rethrown untouched, which is how an APICallError reached the CLI
  // and the chat surface with its raw responseBody still attached while its
  // message said only "AI_APICallError". The reason now rides the message and
  // the raw failure rides `cause`.
  test('an Error payload crosses as a classified failure that still carries its text', async () => {
    const cause = new Error('context length exceeded');
    const thrown = await rejectionOf(() => runToCompletion(inBandErrorModel(cause)));

    expect(thrown).toBeInstanceOf(KinuError);
    expect(thrown.message).toContain('context length exceeded');
    expect(thrown.cause).toBe(cause);
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
