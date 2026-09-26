/**
 * `POST /api/client-errors` writes to the operator's log sink on a browser's behalf.
 * Defends: anything other than a report reaching the sink, and release identity taken on the browser's word.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { asFetchFunction } from '@kinu.run/core';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import type { AuthIdentity } from '../src/auth/session';
import { clientErrorRoutes, type ClientErrorEnv } from '../src/client-error/route';
import { serveFamily } from './helpers/api';
import {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_ERROR_MAX_REQUEST_BYTES,
  CLIENT_CHAT_STREAM_FAILED,
  CLIENT_RENDER_FAILED,
  ClientReportSchema,
  fitClientErrorReport,
  type ClientErrorReport,
  type ReleaseMatch,
} from '@kinu.run/core';
import { pageDeployedBuildSha, reportChatStreamFailure, reportRenderFailure } from '@kinu.run/core';
import { readUIMessageStream, type UIMessageChunk } from 'ai';
import { APP_ROUTES, routeTemplateOf } from '@kinu.run/core';
import { requestUrl } from '@kinu.run/core';

const ORIGIN = 'https://kinu.example.com';

const URL_ = `${ORIGIN}${CLIENT_ERROR_ENDPOINT}`;

const STAMP = { version: '0.1.0+abc1234', sha: 'abc1234', builtAt: '2026-08-07T00:00:00.000Z' };

const SPA_SHELL = '<!doctype html>\n<html lang="en"><head><title>Kinu</title></head><body></body></html>';

const ME: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'ashish@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

/** `stamp: null` answers like the real `single-page-application` fallback (an undeployed bundle or `vite dev`). */
function envWithStamp(stamp: typeof STAMP | null): ClientErrorEnv {
  return {
    ASSETS: {
      async fetch(request: Request): Promise<Response> {
        if (stamp !== null && new URL(request.url).pathname === '/downloads/kinu-version.json') {
          return new Response(JSON.stringify(stamp), {
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(SPA_SHELL, { headers: { 'content-type': 'text/html' } });
      },
    },
  };
}

function report(over: Partial<ClientErrorReport> = {}): ClientErrorReport {
  return {
    event: CLIENT_RENDER_FAILED,
    release: STAMP.sha,
    route: APP_ROUTES.workspace,
    errorName: 'TypeError',
    stack: '    at ChatMessages (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)',
    componentStack: '    at ChatMessages (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)\n    at div',
    ...over,
  };
}

function post(body: string, init: RequestInit = {}): Request {
  return new Request(URL_, { method: 'POST', body, ...init });
}

/** The arms restate the contract's `ReleaseMatch` so the wire answer is pinned on its own terms. */
const AcceptedSchema = v.object({
  releaseMatch: v.picklist(['match', 'stale', 'unreported', 'undeployed'] as const),
});

async function verdict(response: Response): Promise<ReleaseMatch> {
  return v.parse(AcceptedSchema, await response.json()).releaseMatch;
}


async function send(
  body: string,
  identity: AuthIdentity | null = ME,
  stamp: typeof STAMP | null = STAMP,
): Promise<Response> {
  const response = await serveFamily(clientErrorRoutes, identity === null ? {} : { identity })(post(body), envWithStamp(stamp));

  if (!response) throw new Error('the route did not answer its own endpoint');

  return response;
}

async function recorded(
  body: string,
  stamp: typeof STAMP | null = STAMP,
): Promise<{ response: Response; lines: readonly RecordedLog[] }> {
  const logs = createRecordingLogger();
  setDiagnosticsSink(logs);
  const response = await send(body, ME, stamp);

  return { response, lines: logs.emitted };
}

afterEach(() => { setDiagnosticsSink(createRecordingLogger()); });

describe('routing', () => {
  test('another path is not this module’s business', async () => {
    expect(await serveFamily(clientErrorRoutes, { identity: ME })(new Request(`${ORIGIN}/api/other`, { method: 'POST' }), envWithStamp(STAMP))).toBeNull();
  });

  test('a GET of the endpoint is a 405, not the SPA', async () => {
    // Falling through would answer an API path with the app shell.
    const response = await serveFamily(clientErrorRoutes, { identity: ME })(new Request(URL_), envWithStamp(STAMP));

    expect(response?.status).toBe(405);
  });
});

describe('who may write to the log sink', () => {
  test('an unauthenticated report is refused by the route itself', async () => {
    // Guarded here too, not only by the app's session gate: a caller-only guard is one refactor from absent.
    const response = await send(JSON.stringify(report()), null);
    expect(response.status).toBe(401);
  });

  test('nothing is written when the caller is refused', async () => {
    const logs = createRecordingLogger();
    setDiagnosticsSink(logs);
    await send(JSON.stringify(report()), null);
    expect(logs.emitted).toEqual([]);
  });
});

describe('a body that is not a report', () => {
  test('bytes that are not JSON are a 400, never a throw', async () => {
    const response = await send('not json at all');
    expect(response.status).toBe(400);
  });

  test('a report missing the event name is refused', async () => {
    const { event: _event, ...withoutEvent } = report();
    const response = await send(JSON.stringify(withoutEvent));
    expect(response.status).toBe(400);
  });

  test('another event name cannot be written through this endpoint', async () => {
    const response = await send(JSON.stringify({ ...report(), event: 'turn.settled' }));
    expect(response.status).toBe(400);
  });

  test('a route outside the app’s own table is refused', async () => {
    const response = await send(JSON.stringify({ ...report(), route: '/workspace/acme-billing' }));
    expect(response.status).toBe(400);
  });

  test('an error name that is not an identifier is refused', async () => {
    const response = await send(JSON.stringify({
      ...report(), errorName: 'Cannot read properties of undefined',
    }));

    expect(response.status).toBe(400);
  });

  test('prose where a stack frame belongs is refused', async () => {
    // The frame grammar is a schema, not only a client filter: a hostile hand-built body is the threat model.
    const response = await send(JSON.stringify({
      ...report(),
      stack: 'TypeError: the user said "my api key is sk-live-9x2"\n    at f (https://h/a.js:1:2)',
    }));

    expect(response.status).toBe(400);
  });

  test('prose in the component stack is refused the same way', async () => {
    const response = await send(JSON.stringify({
      ...report(), componentStack: '    at Chat\nthe prompt was: draft the layoff email',
    }));

    expect(response.status).toBe(400);
  });

  test('a refused body writes nothing to the sink', async () => {
    const logs = createRecordingLogger();
    setDiagnosticsSink(logs);
    await send('not json at all');
    expect(logs.emitted.map((line) => line.event)).not.toContain(CLIENT_RENDER_FAILED);
  });
});

describe('the bound', () => {
  test('a body over the request bound is a 413', async () => {
    const frame = '    at f (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)';

    const huge = JSON.stringify({
      ...report(),
      stack: Array.from({ length: 400 }, () => frame).join('\n'),
    });

    expect(huge.length).toBeGreaterThan(CLIENT_ERROR_MAX_REQUEST_BYTES);
    expect((await send(huge)).status).toBe(413);
  });

  test('the bound is not the declared length', async () => {
    // `readBounded` counts arriving bytes, so a chunked body that declares nothing is still refused.
    const frame = '    at f (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)';

    const huge = JSON.stringify({
      ...report(),
      stack: Array.from({ length: 400 }, () => frame).join('\n'),
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });

    const response = await serveFamily(clientErrorRoutes, { identity: ME })(new Request(URL_, { method: 'POST', body: stream }), envWithStamp(STAMP));

    expect(response?.status).toBe(413);
  });
});

describe('the release the report is bound to', () => {
  test('a report from the live build is accepted and matched', async () => {
    const { response, lines } = await recorded(JSON.stringify(report()));
    expect(response.status).toBe(202);
    expect(await verdict(response)).toBe('match');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields.releaseMatch).toBe('match');
  });

  test('a stale tab’s report is LABELLED, not refused', async () => {
    // A page that rode through a deploy is the one failure mode nothing else reports; refusing it discards the evidence.
    const { response, lines } = await recorded(JSON.stringify(report({ release: 'deadbee' })));
    expect(response.status).toBe(202);
    expect(await verdict(response)).toBe('stale');
    expect(lines[0]?.fields).toMatchObject({
      releaseMatch: 'stale',
      release: STAMP.sha,
      reportedRelease: 'deadbee',
    });
  });

  test('the authoritative sha is the deployment’s own, never the reported one', async () => {
    const { lines } = await recorded(JSON.stringify(report({ release: 'deadbee' })));
    expect(lines[0]?.fields.release).toBe(STAMP.sha);
    expect(lines[0]?.fields.version).toBe(STAMP.version);
    expect(lines[0]?.fields.builtAt).toBe(STAMP.builtAt);
  });

  test('a page that could not identify its build says so', async () => {
    const { release: _release, ...anonymous } = report();
    const { lines } = await recorded(JSON.stringify(anonymous));
    expect(lines[0]?.fields.releaseMatch).toBe('unreported');
    expect(lines[0]?.fields.reportedRelease).toBe('');
  });

  test('a deployment with no build stamp cannot claim a mismatch', async () => {
    // `vite dev` publishes no stamp; reporting `stale` there would be fabricated on every local session.
    const { lines } = await recorded(JSON.stringify(report({ release: 'deadbee' })), null);
    expect(lines[0]?.fields.releaseMatch).toBe('undeployed');
    expect(lines[0]?.fields.release).toBe('');
  });
});

describe('what one accepted report writes', () => {
  test('the event name is the stable one a query is written against', async () => {
    const { lines } = await recorded(JSON.stringify(report()));
    expect(lines[0]?.event).toBe(CLIENT_RENDER_FAILED);
  });

  test('exactly the safe fields, and no others', async () => {
    // Asserted as a set: a field added later has to pass here, where "is that safe to log?" gets asked.
    const { lines } = await recorded(JSON.stringify(report()));
    expect(Object.keys(lines[0]?.fields ?? {}).sort()).toEqual([
      'builtAt', 'componentStack', 'errorName', 'release', 'releaseMatch',
      'reportedRelease', 'route', 'stack', 'version',
    ]);
  });

  test('the stack reaches the sink intact, so the coordinates survive', async () => {
    const sent = report();
    const { lines } = await recorded(JSON.stringify(sent));
    expect(lines[0]?.fields.stack).toBe(sent.stack);
    expect(lines[0]?.fields.componentStack).toBe(sent.componentStack);
  });

  test('the response is never cacheable', async () => {
    const { response } = await recorded(JSON.stringify(report()));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('the route a report is addressed by', () => {
  test('a workspace path reports as its template, not as the workspace', () => {
    expect(routeTemplateOf('/workspace/acme-billing-q3')).toBe(APP_ROUTES.workspace);
  });

  test('a nested agent path resolves to the deeper template', () => {
    expect(routeTemplateOf('/workspace/acme/agents/scout')).toBe(APP_ROUTES.workspaceAgent);
  });

  test('the index route resolves, with or without a trailing slash', () => {
    expect(routeTemplateOf('/')).toBe(APP_ROUTES.home);
    expect(routeTemplateOf('/control/')).toBe(APP_ROUTES.control);
  });

  test('a path the router does not know is a finding, not a leak', () => {
    expect(routeTemplateOf('/nope/acme-billing-q3')).toBe('/unmatched');
  });

  test('a static path is never mistaken for a parameterised one', () => {
    expect(routeTemplateOf('/user/settings')).toBe(APP_ROUTES.userSettings);
    expect(routeTemplateOf('/user/settings/mcp')).toBe(APP_ROUTES.userMcp);
  });
});

describe('the payload the browser builds', () => {
  const V8_STACK = [
    'TypeError: Cannot read properties of undefined (reading \'kind\') for coupon SAVE20',
    '    at applyCoupon (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)',
    '    at ChatMessages (https://kinu.example.com/assets/index-a1b2c3.js:1:9876)',
  ].join('\n');

  const COMPONENT_STACK = [
    '    at ChatMessages (https://kinu.example.com/assets/index-a1b2c3.js:1:9876)',
    '    at div',
    '    at ErrorBoundary (https://kinu.example.com/assets/index-a1b2c3.js:1:4444)',
  ].join('\n');

  const posts: { url: string; body: string }[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    posts.length = 0;
    Object.assign(globalThis, { location: { pathname: '/workspace/demo' } });
    globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);

      if (url.endsWith('/api/health')) throw new TypeError('offline');

      if (init?.method === 'POST') posts.push({ url, body: v.parse(v.string(), init.body ?? '') });

      return new Response('{}', { status: 202 });
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Reflect.deleteProperty(globalThis, 'location');
  });

  async function posted(error: Error, componentStack: string): Promise<ClientErrorReport> {
    await reportRenderFailure(error, componentStack, {
      release: await pageDeployedBuildSha(),
      route: routeTemplateOf(location.pathname),
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(CLIENT_ERROR_ENDPOINT);

    const sent = v.parse(ClientReportSchema, JSON.parse(posts[0].body));

    if (sent.event !== CLIENT_RENDER_FAILED) throw new Error(`a render failure was sent as ${sent.event}`);

    return sent;
  }

  function failedRender(): Error {
    const error = new TypeError('Cannot read properties of undefined (reading \'kind\') for coupon SAVE20');
    error.stack = V8_STACK;

    return error;
  }

  test('the message never leaves, in any field', async () => {
    // V8 puts `${name}: ${message}` on the first line of `stack`, which must not travel.
    const body = JSON.stringify(await posted(failedRender(), COMPONENT_STACK));
    expect(body).not.toContain('SAVE20');
    expect(body).not.toContain('Cannot read properties');
  });

  test('the error’s CLASS does travel, because that is the greppable part', async () => {
    expect((await posted(failedRender(), COMPONENT_STACK)).errorName).toBe('TypeError');
  });

  test('every frame the browser produced is kept, in order', async () => {
    expect((await posted(failedRender(), COMPONENT_STACK)).stack.split('\n')).toEqual([
      '    at applyCoupon (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)',
      '    at ChatMessages (https://kinu.example.com/assets/index-a1b2c3.js:1:9876)',
    ]);
  });

  test('React’s bare host frames are kept: the component path is the value', async () => {
    expect((await posted(failedRender(), COMPONENT_STACK)).componentStack.split('\n'))
      .toContain('    at div');
  });

  test('the report carries the route template, never the path', async () => {
    expect((await posted(new Error('x'), '')).route).toBe(APP_ROUTES.workspace);
  });

  test('a name assigned over the identifier shape falls back rather than travels', async () => {
    // Built at runtime so no credential-shaped literal sits in source for the push-time scanner.
    const syntheticToken = ['ptc', 'deadbeef'].join('_');
    const error = new Error('boom');
    error.name = `the user said: my token is ${syntheticToken}`;
    const sent = await posted(error, '');
    expect(sent.errorName).toBe('Error');
    expect(JSON.stringify(sent)).not.toContain(syntheticToken);
  });

  test('a page with no build identity still produces a report', async () => {
    const sent = await posted(new Error('x'), '');
    expect(sent.release).toBeUndefined();
    expect(sent.event).toBe(CLIENT_RENDER_FAILED);
  });

  test('the built payload is accepted by the route it is built for', async () => {
    const sent = await posted(failedRender(), COMPONENT_STACK);
    const { response } = await recorded(JSON.stringify(sent));
    expect(response.status).toBe(202);
  });
});

describe('fitting a report to the one bound', () => {
  const FRAME = '    at f (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)';

  function oversized(stackFrames: number, componentFrames: number): ClientErrorReport {
    return report({
      stack: Array.from({ length: stackFrames }, () => FRAME).join('\n'),
      componentStack: Array.from({ length: componentFrames }, () => FRAME).join('\n'),
    });
  }

  test('an ordinary report is not touched', () => {
    const small = report();
    expect(fitClientErrorReport(small)).toEqual(small);
  });
  test('an oversized report comes back inside the bound', () => {
    const fitted = fitClientErrorReport(oversized(400, 400));
    expect(new TextEncoder().encode(JSON.stringify(fitted)).byteLength)
      .toBeLessThanOrEqual(CLIENT_ERROR_MAX_REQUEST_BYTES);
  });

  test('the fixed fields are never what gets dropped', () => {
    const fitted = fitClientErrorReport(oversized(400, 400));
    expect(fitted.release).toBe(STAMP.sha);
    expect(fitted.errorName).toBe('TypeError');
    expect(fitted.route).toBe(APP_ROUTES.workspace);
    expect(fitted.event).toBe(CLIENT_RENDER_FAILED);
  });

  test('both stacks keep a share, so neither starves the other', () => {
    const fitted = fitClientErrorReport(oversized(400, 400));
    expect(fitted.stack.length).toBeGreaterThan(0);
    expect(fitted.componentStack.length).toBeGreaterThan(0);
  });

  test('the share is proportional to what each asked for', () => {
    const fitted = fitClientErrorReport(oversized(450, 50));
    expect(fitted.stack.length).toBeGreaterThan(fitted.componentStack.length * 4);
  });

  test('whole frames survive, never half of one', () => {
    // A partial frame would be refused by the route's schema, so truncation drops whole frames.
    const fitted = fitClientErrorReport(oversized(400, 400));

    for (const line of [...fitted.stack.split('\n'), ...fitted.componentStack.split('\n')]) {
      expect(line).toBe(FRAME);
    }
  });

  test('a fitted report is accepted by the route', async () => {
    const { response } = await recorded(JSON.stringify(fitClientErrorReport(oversized(400, 400))));
    expect(response.status).toBe(202);
  });

  test('non-ASCII frames are measured in bytes, not characters', () => {
    // Encoded bytes, not characters: multi-byte identifiers would pass the fit and be refused at the route.
    const wide = `    at Iñtërnâtiônàlizætiøn☃ (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)`;

    const fitted = fitClientErrorReport(report({
      stack: Array.from({ length: 400 }, () => wide).join('\n'),
    }));

    expect(new TextEncoder().encode(JSON.stringify(fitted)).byteLength)
      .toBeLessThanOrEqual(CLIENT_ERROR_MAX_REQUEST_BYTES);
  });
});

describe('a chat stream the tab could not read', () => {
  const posts: string[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    posts.length = 0;
    globalThis.fetch = asFetchFunction(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posts.push(v.parse(v.string(), init?.body ?? ''));

      return new Response('{}', { status: 202 });
    });
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  /** What `useChat` hands the page when the parts break the UI-message protocol, read by `ai`'s own reader. */
  async function protocolFailure(): Promise<Error> {
    const parts: UIMessageChunk[] = [
      { type: 'start' }, { type: 'start-step' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'the owner wrote SAVE20 here' },
    ];

    const stream = new ReadableStream<UIMessageChunk>({ start(c) { for (const part of parts) c.enqueue(part); c.close(); } });

    let failure: Error | null = null;

    for await (const _message of readUIMessageStream({ stream, onError: (error) => { failure = error instanceof Error ? error : null; } })) {
      void _message;
    }

    if (failure !== null) return failure;

    throw new Error('the reader accepted a delta for a part it never saw open');
  }

  // warm-forge-4d6acc02, 2026-09-25: an actor pane showed "Received reasoning-delta for missing reasoning part" and
  // the server logged nothing, so the part sequence that broke it could not be found.
  test('a protocol failure in an actor pane becomes one log line naming the pane and the part, never its text', async () => {
    await reportChatStreamFailure(await protocolFailure(), 'actor', { release: STAMP.sha, route: APP_ROUTES.workspace });

    expect(posts).toHaveLength(1);
    const { response, lines } = await recorded(posts[0] ?? '');

    expect(response.status).toBe(202);
    expect(lines.map((line) => line.event)).toEqual([CLIENT_CHAT_STREAM_FAILED]);
    expect(lines[0]?.fields).toMatchObject({
      pane: 'actor', errorName: 'AI_UIMessageStreamError', partType: 'reasoning-delta', partId: 'reasoning-0',
    });
    expect(JSON.stringify(lines)).not.toContain('SAVE20');
    expect(JSON.stringify(lines)).not.toContain('missing reasoning part');
  });

  // Review job 141: V8's stack opens with the message, and a message line shaped like a frame passed the filter.
  test('a message line shaped like a stack frame never reaches the log', async () => {
    const failure = new Error('the tool failed\nat main (file:///home/main/acme-payroll/salaries.js:3:9)');

    await reportChatStreamFailure(failure, 'root', { release: STAMP.sha, route: APP_ROUTES.workspace });
    await reportRenderFailure(failure, '', { release: STAMP.sha, route: APP_ROUTES.workspace });

    expect(posts).toHaveLength(2);

    for (const sent of posts) expect(sent).not.toContain('acme-payroll');
    expect(JSON.parse(posts[0] ?? '{}')).toMatchObject({ stack: expect.stringMatching(/unit-client-error-route/u) });
  });
});
