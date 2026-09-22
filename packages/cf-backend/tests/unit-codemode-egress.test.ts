/**
 * Codemode sandbox egress, the third seam of the one destination classifier: `eval` programs are LLM-authored, so their
 * `fetch()` must be judged like shell and `web.fetch`. Asserts the seam (the table lives in core's
 * unit-egress-destination.test.ts): the entrypoint asks, refusals never reach the network, and redirects do not bypass it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asFetchFunction } from '@kinu.run/core';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordingLogger,
} from '@kinu.run/core/obs';
import { CodemodeEgress, EGRESS_FAILURE_HEADER } from '../src/codemode-egress';
import { workerContext } from './helpers/bindings';

/** Its fetch override reads no instance state; `WorkerEntrypoint`'s constructor still takes the platform handle whole. */
const entry = new CodemodeEgress(workerContext(), {});

const egressFetch = (url: string, init?: RequestInit): Promise<Response> =>
  entry.fetch(new Request(url, init));

const originalFetch = globalThis.fetch;

let logs: RecordingLogger;

/** A refusal must leave this empty. */
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

/** Same shape as the container hop's suite: one seam per file, the same destinations. */
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
    // `codemode-node-shim.ts createFetch` turns this marked failure into a rejection, so a refused fetch throws in the program.
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
    // A followed hop never re-enters this handler, so a 302 to a private address would go unjudged:
    // the 3xx goes back to the program, whose next fetch is judged.
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

    // Two of the three asked and the third was a pass-through: each call is pinned.
    expect(read('cf-backend/src/codemode-egress.ts')).toContain('refusedHostname(url.hostname)');
    expect(read('cf-backend/src/egress/outbound.ts')).toContain('refusedHostname(url.hostname)');
    expect(read('core/src/web/url-safety.ts')).toContain('refusedHostname(parsed.hostname)');
  });
});
