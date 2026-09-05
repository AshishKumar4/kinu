/**
 * The codemode sandbox's outbound egress: the third seam of the one
 * destination classifier.
 *
 * `execute_tools` programs are LLM-authored, and this repository treats them
 * that way everywhere else: the approval gate DENIES `169.254.169.254` in a
 * shell command on every executor, and the agent's own `web.fetch` refuses the
 * same destinations. The identical request as `fetch()` inside a program rode a
 * pass-through entrypoint that judged nothing, which is the one place the
 * project's rule — destination judgment is one judgment for the whole project —
 * did not hold.
 *
 * What is asserted here is the SEAM, not the classifier: the table itself is
 * `packages/core/tests/unit-egress-destination.test.ts`, and the container hop
 * holds its own copy of the destination list in
 * `unit-egress-interception.test.ts`. This file proves that the loopback
 * entrypoint asks, that a refusal never reaches the network, that a refusal
 * arrives as the failure shape the program's `fetch` turns into a rejection,
 * and that a redirect is not a way around the check.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asFetchFunction } from '@kinu.run/core';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordingLogger,
} from '@kinu.run/core/obs';
import { CodemodeEgress, EGRESS_FAILURE_HEADER } from '../src/codemode-egress';
/** The loopback entrypoint under test, outside workerd. Its fetch override
 *  reads no instance state, so an empty env and a bare execution context are
 *  the whole construction. */
const entryContext: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
};
const entry = new CodemodeEgress(entryContext, {});
const egressFetch = (url: string, init?: RequestInit): Promise<Response> =>
  entry.fetch(new Request(url, init));

const originalFetch = globalThis.fetch;
let logs: RecordingLogger;
/** Requests that reached the network. A refusal must leave this empty. */
let attempted: Request[] = [];

beforeEach(() => {
  logs = createRecordingLogger();
  setDiagnosticsSink(logs);
  attempted = [];
  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    attempted.push(request);
    return new Response('upstream', { status: 200 });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setDiagnosticsSink(createRecordingLogger());
});

/** Every family the classifier refuses, spelled the way a program would. The
 *  list is deliberately the same shape the container hop's suite holds: one
 *  seam per file, the same destinations. */
const REFUSED = [
  'http://169.254.169.254/latest/meta-data/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://metadata/computeMetadata/v1/',
  'http://localhost:8080/admin',
  'http://db.internal/dump',
  'http://app.localhost/',
  'http://127.0.0.1/',
  'http://10.0.0.1/',
  'http://172.16.4.2/',
  'http://192.168.1.1/',
  'http://100.64.0.1/',
  'http://0.0.0.0/',
  'http://[::1]/',
  'http://[fd00::1]/',
  'http://[fe80::1]/',
  'http://[::ffff:10.0.0.1]/',
  'http://2130706433/',
  'http://0x7f000001/',
  'http://127.1/',
];

describe('a program may not reach a destination no untrusted code may reach', () => {
  test.each(REFUSED)('refuses %s without touching the network', async (url) => {
    const response = await egressFetch(url);

    expect(response.status).toBe(403);
    expect(attempted).toEqual([]);
    // The marked failure is what `codemode-node-shim.ts createFetch` turns into
    // the rejection a Node program expects, so a refused fetch throws inside the
    // program instead of returning a body it might parse.
    expect(response.headers.get(EGRESS_FAILURE_HEADER)).toBe('1');
    expect(await response.json()).toMatchObject({ reason: 'denied' });
  });

  test('the refusal is reported with the host and the seam, and no URL', async () => {
    await egressFetch('http://169.254.169.254/latest/meta-data/?key=SECRET');

    const refusal = logs.emitted.find((line) => line.event === 'egress.private_destination');
    expect(refusal).toBeDefined();
    expect(refusal?.fields).toMatchObject({ host: '169.254.169.254', seam: 'codemode' });
    expect(JSON.stringify(refusal?.fields)).not.toContain('SECRET');
  });
});

describe('a public destination is still the program\'s own business', () => {
  test('is forwarded, and forwarded with redirects handed back', async () => {
    const response = await egressFetch('https://api.example.com/v1/things');

    expect(response.status).toBe(200);
    expect(attempted).toHaveLength(1);
    const sent = attempted[0];
    if (!sent) throw new Error('expected the request to reach the network');
    expect(sent.url).toBe('https://api.example.com/v1/things');
    // A hop the runtime follows never re-enters this handler, so a public host
    // answering 302 to a private address would reach it unjudged. The 3xx goes
    // back to the program, whose next fetch is judged like the first.
    expect(sent.redirect).toBe('manual');
  });

  test('a caller that refuses redirects outright keeps that mode', async () => {
    await egressFetch('https://api.example.com/', { redirect: 'error' });

    const sent = attempted[0];
    if (!sent) throw new Error('expected the request to reach the network');
    expect(sent.redirect).toBe('error');
  });

  test('a network failure arrives as the same marked failure', async () => {
    globalThis.fetch = asFetchFunction(async () => {
      throw new TypeError('getaddrinfo ENOTFOUND');
    });

    const response = await egressFetch('https://nowhere.invalid/');

    expect(response.status).toBe(502);
    expect(response.headers.get(EGRESS_FAILURE_HEADER)).toBe('1');
    expect(await response.text()).toContain('ENOTFOUND');
  });
});

describe('one judgment, three enforcement points', () => {
  test('every seam that lets untrusted code choose a destination asks the same function', () => {
    const read = (path: string): string =>
      readFileSync(join(import.meta.dir, '..', '..', path), 'utf8');
    // Removing the call from any one of these is how this defect happened the
    // first time: two of the three asked, and the third was a pass-through.
    expect(read('cf-backend/src/codemode-egress.ts')).toContain('refusedHostname(url.hostname)');
    expect(read('cf-backend/src/egress/outbound.ts')).toContain('refusedHostname(url.hostname)');
    expect(read('core/src/web/url-safety.ts')).toContain('refusedHostname(parsed.hostname)');
  });
});
