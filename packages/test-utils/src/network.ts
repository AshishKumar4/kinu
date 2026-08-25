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

export interface MockFetchHandler {
  /** Pattern matched against the request URL — substring match. */
  match: string | RegExp | ((req: RecordedRequest) => boolean);
  /** Response to return. Status 200 by default. */
  respond: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | object;
  } | ((req: RecordedRequest, callIndex: number) => {
    status?: number;
    headers?: Record<string, string>;
    body?: string | object;
  });
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

export function createMockFetch(handlers: MockFetchHandler[]): MockFetchHandle {
  const requests: RecordedRequest[] = [];
  const handlerCallCount = new Map<MockFetchHandler, number>();

  const matches = (h: MockFetchHandler, req: RecordedRequest): boolean => {
    if (h.match instanceof RegExp) return h.match.test(req.url);
    if (isRequestMatcher(h.match)) return h.match(req);
    return req.url.includes(h.match);
  };

  const fetch = asFetchFunction(async (input, init) => {
    const url = input instanceof Request ? input.url
      : input instanceof URL ? input.toString()
      : input;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      copyHeaders(init.headers).forEach((v, k) => { headers[k] = v; });
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
    const responseText = v.safeParse(v.string(), resp.body);
    const bodyOut = resp.body === undefined ? ''
      : responseText.success ? responseText.output
      : JSON.stringify(resp.body);
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
// the tests used to absorb that rejection — which meant a provider that broke
// on the way back looked identical to one that worked. These are the smallest
// bodies each wire shape actually parses (measured against the installed SDK,
// not copied from the API reference), so a contract test can await the call and
// let any real failure through.

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
