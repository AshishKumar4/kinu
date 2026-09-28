/**
 * Analytics Engine SQL transport failure reasons: the reason string is all the metrics view shows for an empty panel,
 * so each failure names itself, and a rejected batch fill must not stay cached.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asFetchFunction } from '@kinu.run/core';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordingLogger,
} from '@kinu.run/core/obs';

import {
  runAnalyticsBatch, type AnalyticsSqlEnv,
} from '@kinu.run/core/control-plane';

const CONFIGURED: AnalyticsSqlEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  ANALYTICS_SQL_API_TOKEN: 'token',
};

/** A Map because `AnalyticsQuerySet` is one. */
const ONE: ReadonlyMap<string, string> = new Map([['ops', 'SELECT 1']]);

const originalFetch = globalThis.fetch;

let logs: RecordingLogger;

beforeEach(() => {
  logs = createRecordingLogger();
  setDiagnosticsSink(logs);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setDiagnosticsSink(createRecordingLogger());
});

function answering(status: number, body: string): void {
  globalThis.fetch = asFetchFunction(async () => new Response(body, { status }));
}

/** The `failed` reason, or a failure if the panel came back in any other state. */
async function reasonOf(env: AnalyticsSqlEnv = CONFIGURED): Promise<string> {
  const panels = await runAnalyticsBatch(env, ONE);
  const panel = panels.ops;

  if (panel === undefined) throw new Error('the batch produced no panel');

  if (panel.status !== 'failed') throw new Error(`the panel is ${panel.status}, not failed`);

  return panel.reason;
}

describe('an error response whose body is not the documented envelope', () => {
  test('the reason says so, instead of reporting a bare status code', async () => {
    // A proxy's own error page from an edge that never reached the API.
    const page = '<html><body>502 Bad Gateway</body></html>';
    answering(502, page);

    const reason = await reasonOf();
    expect(reason).toContain('502');
    expect(reason).toContain('not the documented error envelope');
    // The size distinguishes an empty body from HTML without logging either.
    expect(reason).toContain(String(page.length));
  });

  test('the decode failure is recorded with its class and the status it answered', async () => {
    answering(502, '<html>gateway</html>');
    await reasonOf();

    const line = logs.emitted.find(
      (emitted) => emitted.event === 'control_plane.analytics_error_body_unreadable',
    );

    expect(line).toBeDefined();
    // `bad_input`, not `unavailable`: a fleet query for platform faults must not return this line.
    expect(line?.code).toBe('bad_input');
    expect(line?.cause?.length ?? 0).toBeGreaterThan(0);
    expect(line?.fields).toMatchObject({ status: 502, bytes: 20 });
  });

  test('JSON that parses but is not the envelope is the same answer', async () => {
    // Valid JSON, wrong shape: a schema-tolerant decode would reduce it to `{}`.
    answering(500, '[1,2,3]');
    expect(await reasonOf()).toContain('not the documented error envelope');
  });
});

describe('an error response that IS the envelope', () => {
  test('Cloudflare’s own message is what the panel reports', async () => {
    answering(403, JSON.stringify({ errors: [{ message: 'Authentication error' }] }));

    expect(await reasonOf()).toBe('analytics API 403: Authentication error');
    expect(logs.emitted).toEqual([]);
  });

  test('an envelope carrying no message is a bare status, and NOT a decode failure', async () => {
    // Absent and unreadable are different answers.
    answering(404, JSON.stringify({ errors: [] }));

    expect(await reasonOf()).toBe('analytics API 404');
    expect(logs.emitted).toEqual([]);
  });
});
