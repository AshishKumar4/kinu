/**
 * The Analytics Engine SQL transport's FAILURE behaviour.
 *
 * Every arm here is one an operator meets and a live deployment will not
 * reproduce on demand: a token that never reached the API and came back as an
 * HTML error page, an API refusal carrying no message, and a batch fill that
 * rejects. All three used to reduce to the same two words on a panel — a status
 * code with nothing after it — or, for the third, to a cache entry that served
 * one transient fault for its whole thirty-second life.
 *
 * Driven through `runAnalyticsBatch` with `fetch` stubbed, because the reason
 * string IS the contract: it is the only thing the metrics view shows when a
 * panel has no rows, so what it says is the whole of what an operator has.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asFetchFunction } from '@kinu.run/core';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordingLogger,
} from '@kinu.run/core/obs';

import {
  clearAnalyticsCache, runAnalyticsBatch, type AnalyticsSqlEnv,
} from '../src/control-plane/analytics-sql';

const CONFIGURED: AnalyticsSqlEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  ANALYTICS_SQL_API_TOKEN: 'token',
};

/** A Map because `AnalyticsQuerySet` is one: the batch key is built from the
 *  same pairs, so the set and the key it is cached under cannot drift. */
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

/** One canned API answer for every query in the batch. */
function answering(status: number, body: string): void {
  globalThis.fetch = asFetchFunction(async () => new Response(body, { status }));
}

/** The `failed` reason for the single-panel batch, or a failure if the panel
 *  came back in any other state — a test that read `undefined` here would pass
 *  for a panel that never ran. */
async function reasonOf(env: AnalyticsSqlEnv = CONFIGURED): Promise<string> {
  const panels = await runAnalyticsBatch(env, ONE);
  const panel = panels.ops;
  if (panel === undefined) throw new Error('the batch produced no panel');
  if (panel.status !== 'failed') throw new Error(`the panel is ${panel.status}, not failed`);
  return panel.reason;
}

describe('an error response whose body is not the documented envelope', () => {
  test('the reason says so, instead of reporting a bare status code', async () => {
    // What an edge that never reached the API sends: a proxy's own error page.
    const page = '<html><body>502 Bad Gateway</body></html>';
    answering(502, page);

    const reason = await reasonOf();
    expect(reason).toContain('502');
    expect(reason).toContain('not the documented error envelope');
    // The size, because it is the one thing that distinguishes an empty body
    // from a page of HTML without printing either into a log line.
    expect(reason).toContain(String(page.length));
  });

  test('the decode failure is recorded with its class and the status it answered', async () => {
    answering(502, '<html>gateway</html>');
    await reasonOf();

    const line = logs.emitted.find(
      (emitted) => emitted.event === 'control_plane.analytics_error_body_unreadable',
    );
    expect(line).toBeDefined();
    // `bad_input` and not `unavailable`: at a decoder, an unrecognised failure
    // means the bytes are not the shape they were declared to be. A fleet query
    // for platform faults must not return this line.
    expect(line?.code).toBe('bad_input');
    expect(line?.cause?.length ?? 0).toBeGreaterThan(0);
    expect(line?.fields).toMatchObject({ status: 502, bytes: 20 });
  });

  test('JSON that parses but is not the envelope is the same answer', async () => {
    // The arm a schema-tolerant decode hid: valid JSON, wrong shape, which used
    // to reduce to the identical `{}` an envelope with no message produces.
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
    // The separation this whole arm exists for: absent and unreadable are now
    // different answers, so a clean refusal with nothing to say must not be
    // reported as a body nobody could read.
    answering(404, JSON.stringify({ errors: [] }));

    expect(await reasonOf()).toBe('analytics API 404');
    expect(logs.emitted).toEqual([]);
  });
});

describe('a batch fill that rejects', () => {
  /** An env whose first read throws, which is the shape of the programming
   *  error the fill's catch exists for: `analyticsMissingSettings` runs before
   *  `runAnalyticsSql`'s own try, so nothing below it can absorb this. */
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

    // Same key, same TTL window: a cached rejection would be handed straight
    // back without the fill running a second time.
    await expect(runAnalyticsBatch(env, ONE, 1_000)).rejects.toThrow();
    await expect(runAnalyticsBatch(env, ONE, 1_001)).rejects.toThrow();

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
