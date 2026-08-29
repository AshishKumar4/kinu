/**
 * `POST /api/client-errors` — the browser render-failure endpoint.
 *
 * The endpoint writes into the operator's log sink, on behalf of a browser, so
 * the two things worth locking down are the two ways that goes wrong: something
 * OTHER than a report reaching the sink, and the release identity being taken on
 * the browser's word.
 *
 * So this suite is mostly refusals — no auth, wrong method, over the bound, off
 * the schema, prose where a stack frame belongs — plus the four release verdicts
 * and the exact field set one accepted report writes. The client half's own claim
 * (that a message, a path and a component label never enter the payload at all)
 * is asserted here too, through the pure builder, because it is the claim that
 * needs no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import type { AuthIdentity } from '../src/auth/session';
import { handleClientErrorRequest } from '../src/client-error/route';
import {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_ERROR_MAX_REQUEST_BYTES,
  CLIENT_RENDER_FAILED,
  fitClientErrorReport,
  RELEASE_MATCHES,
  reportBytes,
  type ClientErrorReport,
  type ReleaseMatch,
} from '../src/client-error/contract';
import { renderFailureReport } from '../src/client-error/report';
import { APP_ROUTES, UNMATCHED_ROUTE, routeTemplateOf } from '../src/app-routes';

const ORIGIN = 'https://kinu.example.com';
const URL_ = `${ORIGIN}${CLIENT_ERROR_ENDPOINT}`;

/** The build the fixture deployment serves. */
const STAMP = { version: '0.1.0+abc1234', sha: 'abc1234', builtAt: '2026-08-07T00:00:00.000Z' };
const SPA_SHELL = '<!doctype html>\n<html lang="en"><head><title>Kinu</title></head><body></body></html>';

const ME: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'ashish@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

/**
 * An ASSETS binding that publishes the build stamp, or — when `stamp` is null —
 * answers the way the real `single-page-application` fallback does, which is how
 * an undeployed bundle and a `vite dev` server look from in here.
 */
function envWithStamp(stamp: typeof STAMP | null): Env {
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
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
  });
  // SAFETY: the route reads only ASSETS.fetch, which this fixture constructs.
  return partialEnv as Env;
}

/** A well-formed report, with the fields each case varies overridden. */
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

/** The route's verdict, parsed rather than asserted: the response SHAPE is part
 *  of the contract, so a body that is not this is a failure here too. */
const AcceptedSchema = v.object({ releaseMatch: v.picklist(RELEASE_MATCHES) });

async function verdict(response: Response): Promise<ReleaseMatch> {
  return v.parse(AcceptedSchema, await response.json()).releaseMatch;
}

async function send(
  body: string,
  identity: AuthIdentity | null = ME,
  stamp: typeof STAMP | null = STAMP,
): Promise<Response> {
  const response = await handleClientErrorRequest(post(body), envWithStamp(stamp), identity);
  if (!response) throw new Error('the route did not answer its own endpoint');
  return response;
}

/** The one line an accepted report writes. */
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
    expect(await handleClientErrorRequest(
      new Request(`${ORIGIN}/api/other`, { method: 'POST' }), envWithStamp(STAMP), ME,
    )).toBeNull();
  });

  test('a GET of the endpoint is a 405, not the SPA', async () => {
    // Falling through would answer an API path with the app shell, which is the
    // defect /api/health's own suite exists to catch.
    const response = await handleClientErrorRequest(
      new Request(URL_), envWithStamp(STAMP), ME,
    );
    expect(response?.status).toBe(405);
  });
});

describe('who may write to the log sink', () => {
  test('an unauthenticated report is refused by the route itself', async () => {
    // Not merely by server.ts's gate: this route writes to the operator's logs,
    // and a guard performed only by the caller is one refactor from absent.
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
    // The log-injection case, and the reason the frame grammar is a schema and
    // not only a client-side filter: a hostile sender rebuilding the body by
    // hand is the whole threat model of an endpoint that writes to logs.
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
    // One frame repeated past the ceiling: every line is a legal frame, so the
    // refusal is the SIZE and not the shape.
    const frame = '    at f (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)';
    const huge = JSON.stringify({
      ...report(),
      stack: Array.from({ length: 400 }, () => frame).join('\n'),
    });
    expect(huge.length).toBeGreaterThan(CLIENT_ERROR_MAX_REQUEST_BYTES);
    expect((await send(huge)).status).toBe(413);
  });

  test('the bound is not the declared length', async () => {
    // `readBounded` counts arriving bytes, so a body that declares nothing —
    // which is every chunked sender — is still refused at the ceiling.
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
    const response = await handleClientErrorRequest(
      new Request(URL_, { method: 'POST', body: stream }), envWithStamp(STAMP), ME,
    );
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
    // The most interesting report this endpoint receives: a page that rode
    // through a deploy is running code the origin no longer serves, and its
    // stack cannot be reproduced against the live build. Refusing it would
    // discard the evidence for the one failure mode nothing else reports.
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
    // A `vite dev` server publishes no stamp. Reporting `stale` there would be a
    // fabricated finding on every local session.
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
    // The whole field set, asserted as a set: a field added here later has to
    // pass this test, which is where "is that safe to log?" gets asked.
    const { lines } = await recorded(JSON.stringify(report()));
    expect(Object.keys(lines[0]?.fields ?? {}).sort()).toEqual([
      'builtAt', 'componentStack', 'errorName', 'release', 'releaseMatch',
      'reportedRelease', 'route', 'stack', 'version',
    ]);
  });

  test('the stack reaches the sink intact, so the coordinates survive', async () => {
    // A report whose frames are dropped or rewritten on the way in cannot be
    // deobfuscated from source, which is the only reason to collect one.
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
    expect(routeTemplateOf('/nope/acme-billing-q3')).toBe(UNMATCHED_ROUTE);
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

  function built(): ClientErrorReport {
    const error = new TypeError('Cannot read properties of undefined (reading \'kind\') for coupon SAVE20');
    error.stack = V8_STACK;
    return renderFailureReport(error, COMPONENT_STACK, {
      release: STAMP.sha, route: APP_ROUTES.workspace,
    });
  }

  test('the message never leaves, in any field', () => {
    // V8 puts `${name}: ${message}` on the first line of `stack`, which is the
    // one line that must not travel.
    expect(JSON.stringify(built())).not.toContain('SAVE20');
    expect(JSON.stringify(built())).not.toContain('Cannot read properties');
  });

  test('the error’s CLASS does travel, because that is the greppable part', () => {
    expect(built().errorName).toBe('TypeError');
  });

  test('every frame the browser produced is kept, in order', () => {
    expect(built().stack.split('\n')).toEqual([
      '    at applyCoupon (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)',
      '    at ChatMessages (https://kinu.example.com/assets/index-a1b2c3.js:1:9876)',
    ]);
  });

  test('React’s bare host frames are kept: the component path is the value', () => {
    expect(built().componentStack.split('\n')).toContain('    at div');
  });

  test('a name assigned over the identifier shape falls back rather than travels', () => {
    // Built at runtime: exercises the production token pattern without placing
    // a credential-shaped literal in source (which the push-time scanner must
    // treat as real until proven otherwise).
    const syntheticToken = ['ptc', 'deadbeef'].join('_');
    const error = new Error('boom');
    error.name = `the user said: my token is ${syntheticToken}`;
    const sent = renderFailureReport(error, '', { release: null, route: APP_ROUTES.home });
    expect(sent.errorName).toBe('Error');
    expect(JSON.stringify(sent)).not.toContain(syntheticToken);
  });

  test('a page with no build identity still produces a report', () => {
    const sent = renderFailureReport(new Error('x'), '', { release: null, route: APP_ROUTES.home });
    expect(sent.release).toBeUndefined();
    expect(sent.event).toBe(CLIENT_RENDER_FAILED);
  });

  test('the built payload is accepted by the route it is built for', async () => {
    const { response } = await recorded(JSON.stringify(built()));
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
    expect(reportBytes(fitted)).toBeLessThanOrEqual(CLIENT_ERROR_MAX_REQUEST_BYTES);
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
    // Nine times as much stack as component path: the split has to reflect that,
    // or one long minified stack silently costs the whole component tree.
    const fitted = fitClientErrorReport(oversized(450, 50));
    expect(fitted.stack.length).toBeGreaterThan(fitted.componentStack.length * 4);
  });

  test('whole frames survive, never half of one', () => {
    // A byte slice can leave a partial frame, which the route's own schema then
    // refuses — a truncation that produces an unsendable report is worse than
    // one that drops a frame.
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
    // The bound is on encoded bytes. Counting characters would let a stack of
    // multi-byte identifiers pass the fit and be refused at the route.
    const wide = `    at Iñtërnâtiônàlizætiøn☃ (https://kinu.example.com/assets/index-a1b2c3.js:1:2345)`;
    const fitted = fitClientErrorReport(report({
      stack: Array.from({ length: 400 }, () => wide).join('\n'),
    }));
    expect(reportBytes(fitted)).toBeLessThanOrEqual(CLIENT_ERROR_MAX_REQUEST_BYTES);
  });
});
