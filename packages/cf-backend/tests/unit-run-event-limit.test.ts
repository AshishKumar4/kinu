// KINU-N019: a negative `limit` reached SQLite as `LIMIT -1`, which SQLite reads as no limit. Checked against a
// real recorder over real SQLite; the stub's `getRunEventText` is the production body, and the direct RPC's
// `getRunEvents` is checked on its own below.
import type { RunEventsResolver, RunEventsTarget } from '../src/run-events-routes';
import { serveFamily } from './helpers/api';
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  boundRunEventQuery, getRunEvents, getRunEventText, initRunEventTables, PLATFORM_CATALOG, RunEventRecorder,
  RUN_EVENT_LIMIT_MAX, type RunEventQuery,
} from '@kinu.run/core';
import { testActorHandle } from '@kinu.run/test-utils';
import { REAL_CLOCK } from '@kinu.run/core';
import { makeSql, makeExecRaw } from '../../core/tests/helpers';
import { mockAgentsSdk } from './helpers/agents-sdk';
import * as v from 'valibot';

mockAgentsSdk();

// Dynamic: the route module resolves the Agent SDK at import time, so it loads after the stub is installed.
const { runEventsRoutes } = await import('../src/run-events-routes');

const SEEDED_EVENTS = 700;

const RUN_EVENT_LIMIT_DEFAULT = boundRunEventQuery().limit;

const RUN_EVENT_PAGE_BYTES = PLATFORM_CATALOG['run_events.page_bytes'].limit.value;

/** The production boundary read-models over a real recorder, with no validation added by the test. `message`
 *  sizes each event; every page the object answers is kept, as the text it carried. */
function runEventsWorkspace(message: (i: number) => string = (i) => `event ${i}`) {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  const sql = makeSql(db);
  const recorder = new RunEventRecorder(sql, testActorHandle(sql));

  for (let i = 0; i < SEEDED_EVENTS; i++) {
    recorder.emit('run-1', { type: 'error', message: message(i) });
  }

  const pages: number[] = [];

  const stub: RunEventsTarget = {
    listRuns: () => { throw new Error('OrchestratorAgent.listRuns: not reachable in this test'); },
    async getRunEventText(runId: string, opts?: RunEventQuery) {
      const page = getRunEventText(recorder, runId, opts);
      pages.push(page.reduce((bytes, event) => bytes + Buffer.byteLength(event.payload), 0));

      return page;
    },
  };

  return { resolveAgent: () => Promise.resolve(stub), recorder, pages };
}

async function eventsVia(
  resolveAgent: RunEventsResolver, query: string,
): Promise<{ status: number; count: number; indices: number[] }> {
  const res = await serveFamily(runEventsRoutes(REAL_CLOCK, () => resolveAgent), { workspace: { name: 'jarvis' } })(new Request(
    `https://kinu.example.com/api/workspaces/jarvis/runs/run-1/events${query}`,
  ), {});

  if (!res) throw new Error('the route did not claim the request');
  const body: unknown = await res.json();
  const events = v.safeParse(v.array(v.object({ eventIndex: v.number() })), body);

  return {
    status: res.status,
    count: Array.isArray(body) ? body.length : -1,
    indices: events.success ? events.output.map((event) => event.eventIndex) : [],
  };
}

/** One row per test, so a failure names its own case. */
const BOUNDED_QUERIES: readonly { readonly name: string; readonly query: string; readonly count: number }[] = [
  { name: 'a negative limit returns one event, not the whole run', query: '?limit=-1', count: 1 },
  { name: 'a far more negative limit is bounded the same way', query: '?limit=-999999', count: 1 },
  { name: 'a negative limit stays bounded with a type filter as well', query: '?limit=-1&types=error', count: 1 },
  // Not a 400: absent and unreadable mean the same. Forwarded raw, each is a 500 from SQLite's datatype mismatch.
  { name: 'unparseable limit text means unstated and takes the default', query: '?limit=abc', count: RUN_EVENT_LIMIT_DEFAULT },
  { name: 'a literal NaN means unstated too', query: '?limit=NaN', count: RUN_EVENT_LIMIT_DEFAULT },
  { name: 'a literal Infinity means unstated too', query: '?limit=Infinity', count: RUN_EVENT_LIMIT_DEFAULT },
  { name: 'a fractional limit truncates instead of failing the query', query: '?limit=2.7', count: 2 },
  { name: 'an oversized limit clamps to the ceiling', query: '?limit=1000000000', count: RUN_EVENT_LIMIT_MAX },
  { name: 'a legitimate limit is still honoured exactly', query: '?limit=37', count: 37 },
  { name: 'no limit at all takes the default page', query: '', count: RUN_EVENT_LIMIT_DEFAULT },
  { name: 'an unparseable since reads from the start of the run', query: '?since=abc&limit=3', count: 3 },
  { name: 'a negative since reads from the start of the run', query: '?since=-5&limit=3', count: 3 },
];

describe('the run-events route closes `limit` before it can reach SQL', () => {
  for (const bound of BOUNDED_QUERIES) {
    test(bound.name, async () => {
      const { resolveAgent } = runEventsWorkspace();
      expect(await eventsVia(resolveAgent, bound.query)).toMatchObject({ status: 200, count: bound.count });
    });
  }
});

describe('the object answers the route in pages bounded by their stored text', () => {
  test('a full page of large events is joined from bounded pages, every event once and in order', async () => {
    // 700 events of about 4 KiB: a 500-event page is about 2 MB of text, eight times the page bound.
    const { resolveAgent, pages } = runEventsWorkspace((i) => `event ${i} ${'x'.repeat(4000)}`);

    const read = await eventsVia(resolveAgent, '?since=100&limit=500');

    expect(read).toMatchObject({ status: 200, count: 500 });
    expect(read.indices).toEqual(Array.from({ length: 500 }, (_, i) => 100 + i));
    expect(Math.max(...pages)).toBeLessThanOrEqual(RUN_EVENT_PAGE_BYTES);
  });

  test('an event larger than the bound still comes, alone in its page, and the reader passes it', async () => {
    const { resolveAgent, pages } = runEventsWorkspace((i) => (i === 3 ? 'x'.repeat(RUN_EVENT_PAGE_BYTES) : `event ${i}`));

    const read = await eventsVia(resolveAgent, '?since=0&limit=10');

    expect(read.indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pages.filter((bytes) => bytes > RUN_EVENT_PAGE_BYTES)).toHaveLength(1);
  });
});

describe('a follower resuming on a large ledger', () => {
  test('drains it in pages bounded by their text, each event once and in order, then closes at the run end', async () => {
    // A trial-sized backlog: 350 events of about 4 KiB past the follower's Last-Event-ID, one read today.
    const { resolveAgent, recorder, pages } = runEventsWorkspace((i) => `event ${i} ${'x'.repeat(4000)}`);
    recorder.emit('run-1', { type: 'run_end' });

    const res = await serveFamily(runEventsRoutes(REAL_CLOCK, () => resolveAgent), { workspace: { name: 'jarvis' } })(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream', { headers: { 'Last-Event-ID': '349' } },
    ), {});

    if (!res?.body) throw new Error('Expected an SSE response body');
    const ids = [...(await new Response(res.body).text()).matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));

    expect(ids).toEqual(Array.from({ length: SEEDED_EVENTS - 350 + 1 }, (_, i) => 350 + i));
    expect(Math.max(...pages)).toBeLessThanOrEqual(RUN_EVENT_PAGE_BYTES);
  });
});

describe('a direct RPC cannot ask for more than the route may', () => {
  test('the RPC applies the same bounds with no route in the path', async () => {
    const { recorder } = runEventsWorkspace();

    const countOf = async (opts: RunEventQuery): Promise<number> => getRunEvents(recorder, 'run-1', opts).length;

    // No route: the same query strings handed straight to the RPC.
    expect(await countOf({ limit: -1 })).toBe(1);
    expect(await countOf({ limit: Number.NaN })).toBe(RUN_EVENT_LIMIT_DEFAULT);
    expect(await countOf({ limit: 2.7 })).toBe(2);
    expect(await countOf({ limit: 1e9 })).toBe(RUN_EVENT_LIMIT_MAX);
    expect(await countOf({ limit: -1, types: ['error'] })).toBe(1);
    expect(await countOf({ since: Number.NaN, limit: 3 })).toBe(3);
  });
});
