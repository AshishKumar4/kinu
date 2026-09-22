// Mock fetch for provider contract tests.
//
// Lets a test:
//   1. assert what URL / headers / body the provider sent
//   2. control the response shape (200/401/etc.)
//   3. simulate refresh-on-401 flows by switching handlers between calls
import { asFetchFunction, copyHeaders } from '@kinu.run/core';
import * as v from 'valibot';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** What a handler answers with. Status 200 by default. */
export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** A string is sent verbatim; anything else is JSON-encoded. */
  body?: string | object;
}

export interface MockFetchHandler {
  /** Pattern matched against the request URL — substring match. */
  match: string | RegExp | ((req: RecordedRequest) => boolean);
  /** Response to return. */
  respond: MockResponse | ((req: RecordedRequest, callIndex: number) => MockResponse);
}

export interface MockFetchHandle {
  /** typeof globalThis.fetch — pass to createModel(...).deps.fetch */
  fetch: typeof globalThis.fetch;
  /** All recorded requests in order. */
  readonly requests: ReadonlyArray<RecordedRequest>;
  /** Find requests matching a substring or regex. */
  matching(pattern: string | RegExp): RecordedRequest[];
  /** Reset request log + handler call counters. */
  reset(): void;
}

/** The bytes a stubbed response carries: a string verbatim, anything else as
 *  JSON, and an absent body as nothing at all. */
function responseBody(resp: MockResponse): string {
  if (resp.body === undefined) return '';
  const text = v.safeParse(v.string(), resp.body);

  return text.success ? text.output : JSON.stringify(resp.body);
}

export function createMockFetch(handlers: MockFetchHandler[]): MockFetchHandle {
  const requests: RecordedRequest[] = [];
  const handlerCallCount = new Map<MockFetchHandler, number>();

  const matches = (h: MockFetchHandler, req: RecordedRequest): boolean => {
    if (h.match instanceof RegExp) return h.match.test(req.url);

    if (isRequestMatcher(h.match)) return h.match(req);

    return req.url.includes(h.match);
  };

  const fetch = asFetchFunction(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};

    if (init?.headers) {
      for (const [name, value] of copyHeaders(init.headers)) headers[name] = value;
    }

    const bodyParse = v.safeParse(v.string(), init?.body);
    const body = bodyParse.success ? bodyParse.output : undefined;
    const req: RecordedRequest = { url, method, headers };

    if (body !== undefined) req.body = body;
    requests.push(req);

    const handler = handlers.find(h => matches(h, req));

    if (!handler) {
      return new Response(
        JSON.stringify({ error: `MockFetch: no handler matched ${method} ${url}` }),
        { status: 500 },
      );
    }

    const callIndex = handlerCallCount.get(handler) ?? 0;
    handlerCallCount.set(handler, callIndex + 1);

    const resp = isResponder(handler.respond)
      ? handler.respond(req, callIndex)
      : handler.respond;

    const bodyOut = responseBody(resp);
    const responseHeaders = new Headers(resp.headers);

    if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', 'application/json');

    return new Response(bodyOut, {
      status: resp.status ?? 200,
      headers: responseHeaders,
    });
  });

  return {
    fetch,
    requests,
    matching(pattern) {
      if (pattern instanceof RegExp) return requests.filter(r => pattern.test(r.url));

      return requests.filter(r => r.url.includes(pattern));
    },
    reset() {
      requests.length = 0;
      handlerCallCount.clear();
    },
  };
}

// ── Complete provider responses ────────────────────────────────────────────
//
// A provider contract test asserts what went OUT, but it still has to let the
// call come back: a body the SDK cannot parse makes `generateText` reject, and
// a test that absorbs that rejection makes a provider that broke on the way
// back look identical to one that worked. These are the smallest bodies each
// wire shape actually parses (measured against the installed SDK, not copied
// from the API reference), so a contract test can await the call and let any
// real failure through.

/** OpenAI Responses API (`POST /v1/responses`) — the OpenAI and Codex surface. */
export const OPENAI_RESPONSES_BODY = {
  id: 'resp_mock',
  object: 'response',
  created_at: 1700000000,
  status: 'completed',
  model: 'mock-model',
  output: [{
    type: 'message',
    id: 'msg_mock',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'ok', annotations: [] }],
  }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
} as const;

/** models.dev OpenCode Go routing declaration, measured 2026-09-19. */
export const OPENCODE_GO_CATALOG = {
  'opencode-go': {
    id: 'opencode-go', npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/zen/go/v1',
    models: {
      'muse-spark-1.3-contributor': {
        id: 'muse-spark-1.3-contributor', tool_call: true, provider: { npm: '@ai-sdk/openai' },
      },
    },
  },
};

/** OpenAI-compatible chat completions — OpenRouter, Groq, every `openai-compat` endpoint. */
export const CHAT_COMPLETION_BODY = {
  id: 'chatcmpl_mock',
  object: 'chat.completion',
  created: 1700000000,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
} as const;

/** Anthropic Messages API (`POST /v1/messages`), non-streaming. */
export const ANTHROPIC_MESSAGE_BODY = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'mock-model',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
} as const;

type MockResponseFactory = Extract<MockFetchHandler['respond'], (...args: never[]) => object>;

type RequestMatcher = Extract<MockFetchHandler['match'], (...args: never[]) => boolean>;

function isRequestMatcher(value: MockFetchHandler['match']): value is RequestMatcher {
  return v.is(v.function(), value);
}

function isResponder(value: MockFetchHandler['respond']): value is MockResponseFactory {
  return v.is(v.function(), value);
}
