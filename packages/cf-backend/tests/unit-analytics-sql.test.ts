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
  clearAnalyticsCache, runAnalyticsBatch, type AnalyticsSqlEnv,
} from '@kinu.run/core/control-plane';

const CONFIGURED: AnalyticsSqlEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  ANALYTICS_SQL_API_TOKEN: 'token',
};

/** A Map because `AnalyticsQuerySet` is one, so the set and its cache key cannot drift. */
const ONE: ReadonlyMap<string, string> = new Map([['ops', 'SELECT 1']]);

const originalFetch = globalThis.fetch;

let logs: RecordingLogger;

beforeEach(() => {
  clearAnalyticsCache();
  logs = createRecordingLogger();
  setDiagnosticsSink(logs);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAnalyticsCache();
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

describe('a batch fill that rejects', () => {
  /** `analyticsMissingSettings` runs before `runAnalyticsSql`'s own try, so only the fill's catch can absorb this. */
  function poisoned() {
    let reads = 0;

    const env = {
      get CLOUDFLARE_ACCOUNT_ID(): string {
        reads += 1;
        throw new Error('the account id binding is not readable');
      },
      ANALYTICS_SQL_API_TOKEN: 'token',
    } satisfies AnalyticsSqlEnv;

    return { env, reads: () => reads };
  }

  test('the rejection reaches the caller classified, with the cause under it', async () => {
    const { env } = poisoned();
    await expect(runAnalyticsBatch(env, ONE)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'filling a control-plane analytics batch',
    });
  });

  test('the rejected fill is evicted, so the next open re-runs it', async () => {
    const { env, reads } = poisoned();

    // Same key within the TTL: a cached rejection would skip the fill.
    await expect(runAnalyticsBatch(env, ONE, 1_000)).rejects.toThrow('filling a control-plane analytics batch');
    await expect(runAnalyticsBatch(env, ONE, 1_001)).rejects.toThrow('filling a control-plane analytics batch');

    expect(reads()).toBe(2);
  });

  test('a batch that succeeded is still cached, so one open is one round trip', async () => {
    let calls = 0;
    globalThis.fetch = asFetchFunction(async () => {
      calls += 1;

      return new Response(JSON.stringify({ data: [{ n: 1 }] }), { status: 200 });
    });

    const first = await runAnalyticsBatch(CONFIGURED, ONE, 2_000);
    const second = await runAnalyticsBatch(CONFIGURED, ONE, 2_001);

    expect(first.ops).toEqual({ status: 'ok', rows: [{ n: 1 }] });
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });
});
