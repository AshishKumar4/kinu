// KINU-N019: the run-events route clamped only the UPPER bound on `limit`, so a
// negative value crossed the object boundary and reached SQLite as `LIMIT -1` —
// which SQLite reads as no limit at all. One request then read, parsed and
// serialized a whole run's event history.
//
// The route is checked against a REAL recorder over real SQLite, not a counting
// stub, because the defect was in what SQL did with the forwarded value. The
// stub's `getRunEventsWire` is the production body of `OrchestratorAgent`'s —
// `getRunEvents(recorder, runId, opts)` and nothing else — so the direct-RPC
// cases below exercise the real boundary, which is the bypass a route-only fix
// leaves open.
import type { RunEventsResolver, RunEventsTarget } from '../src/run-events-routes';
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  getRunEvents, initRunEventTables, RunEventRecorder,
  RUN_EVENT_LIMIT_DEFAULT, RUN_EVENT_LIMIT_MAX, type RunEventQuery,
} from '@kinu.run/core';
import { testActorHandle } from '@kinu.run/test-utils';
import { REAL_CLOCK } from '@kinu.run/core';
import { makeSql, makeExecRaw } from '../../core/tests/helpers';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

// Dynamic on purpose: the route module resolves the Agent SDK at import time, so
// it may only load AFTER the stub is installed. Same seam as unit-sse-disconnect.
const { handleRunEventsRequest } = await import('../src/run-events-routes');

const SEEDED_EVENTS = 700;

/** A workspace whose `getRunEventsWire` is the production one: the boundary
 *  read-model over a real recorder, with no validation added by the test. */
function runEventsWorkspace() {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  const sql = makeSql(db);
  const recorder = new RunEventRecorder(sql, testActorHandle(sql));

  for (let i = 0; i < SEEDED_EVENTS; i++) {
    recorder.emit('run-1', { type: 'error', message: `event ${i}` });
  }

  const stub: RunEventsTarget = {
    listRuns: () => { throw new Error('OrchestratorAgent.listRuns: not reachable in this test'); },
    async getRunEventsWire(runId: string, opts?: RunEventQuery) {
      return JSON.stringify(getRunEvents(recorder, runId, opts));
    },
  };

  return { resolveAgent: () => Promise.resolve(stub), stub };
}

async function eventsVia(
  resolveAgent: RunEventsResolver, query: string,
): Promise<{ status: number; count: number }> {
  // The list route never polls, so the real pacing is never asked for a wait.
  const res = await handleRunEventsRequest(new Request(
    `https://kinu.example.com/api/workspaces/jarvis/runs/run-1/events${query}`,
  ), resolveAgent, REAL_CLOCK);

  if (!res) throw new Error('the route did not claim the request');
  const body: unknown = await res.json();

  return { status: res.status, count: Array.isArray(body) ? body.length : -1 };
}

/** Every query string the route must close, and the number of events it may
 *  answer with. One row is one test, so a failure still names its own case. */
const BOUNDED_QUERIES: readonly { readonly name: string; readonly query: string; readonly count: number }[] = [
  { name: 'a negative limit returns one event, not the whole run', query: '?limit=-1', count: 1 },
  { name: 'a far more negative limit is bounded the same way', query: '?limit=-999999', count: 1 },
  { name: 'a negative limit stays bounded with a type filter as well', query: '?limit=-1&types=error', count: 1 },
  // Not a 400: absent and unreadable are the same statement, so the route
  // never has to decide what a garbage query string meant. Forwarded raw,
  // each of these is a 500 from SQLite's datatype mismatch.
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
      expect(await eventsVia(resolveAgent, bound.query)).toEqual({ status: 200, count: bound.count });
    });
  }
});

describe('a direct RPC cannot ask for more than the route may', () => {
  test('the RPC applies the same bounds with no route in the path', async () => {
    const { stub } = runEventsWorkspace();

    const countOf = async (opts: RunEventQuery): Promise<number> => {
      const parsed: unknown = JSON.parse(await stub.getRunEventsWire('run-1', opts));

      return Array.isArray(parsed) ? parsed.length : -1;
    };

    // No route in this path — the same query strings a caller would smuggle
    // past it, handed straight to the RPC.
    expect(await countOf({ limit: -1 })).toBe(1);
    expect(await countOf({ limit: Number.NaN })).toBe(RUN_EVENT_LIMIT_DEFAULT);
    expect(await countOf({ limit: 2.7 })).toBe(2);
    expect(await countOf({ limit: 1e9 })).toBe(RUN_EVENT_LIMIT_MAX);
    expect(await countOf({ limit: -1, types: ['error'] })).toBe(1);
    expect(await countOf({ since: Number.NaN, limit: 3 })).toBe(3);
  });
});
