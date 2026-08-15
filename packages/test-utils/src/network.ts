// Mock fetch for provider contract tests.
//
// Lets a test:
//   1. assert what URL / headers / body the provider sent
//   2. control the response shape (200/401/etc.)
//   3. simulate refresh-on-401 flows by switching handlers between calls
import { asFetchFunction } from '@proteus/core';

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
    if (isString(h.match)) return req.url.includes(h.match);
    if (h.match instanceof RegExp) return h.match.test(req.url);
    return h.match(req);
  };

  const fetch = asFetchFunction(async (input, init) => {
    const url = isString(input) ? input
              : input instanceof URL ? input.toString()
              : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    }
    const body = isString(init?.body) ? init.body : undefined;
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
    const bodyOut = resp.body === undefined ? ''
      : isString(resp.body) ? resp.body
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
      if (isString(pattern)) return requests.filter(r => r.url.includes(pattern));
      return requests.filter(r => pattern.test(r.url));
    },
    reset() {
      requests.length = 0;
      handlerCallCount.clear();
    },
  };
}

type MockResponseFactory = Extract<MockFetchHandler['respond'], (...args: never[]) => object>;

function isResponder(value: MockFetchHandler['respond']): value is MockResponseFactory {
  return typeof value === 'function';
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === 'string';
}
