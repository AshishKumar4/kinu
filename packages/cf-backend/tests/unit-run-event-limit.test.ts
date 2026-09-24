// KINU-N019: a negative `limit` reached SQLite as `LIMIT -1`, which SQLite reads as no limit. Checked against a
// real recorder over real SQLite; the stub's `getRunEvents` is the production body, so direct RPC is covered too.
import type { RunEventsResolver, RunEventsTarget } from '../src/run-events-routes';
import { serveFamily } from './helpers/api';
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

// Dynamic: the route module resolves the Agent SDK at import time, so it loads after the stub is installed.
const { runEventsRoutes } = await import('../src/run-events-routes');

const SEEDED_EVENTS = 700;

/** The production boundary read-model over a real recorder, with no validation added by the test. */
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
    async getRunEvents(runId: string, opts?: RunEventQuery) {
      return getRunEvents(recorder, runId, opts);
    },
  };

  return { resolveAgent: () => Promise.resolve(stub), stub };
}

async function eventsVia(
  resolveAgent: RunEventsResolver, query: string,
): Promise<{ status: number; count: number }> {
  const res = await serveFamily(runEventsRoutes(REAL_CLOCK, () => resolveAgent), { workspace: { name: 'jarvis' } })(new Request(
    `https://kinu.example.com/api/workspaces/jarvis/runs/run-1/events${query}`,
  ), {});

  if (!res) throw new Error('the route did not claim the request');
  const body: unknown = await res.json();

  return { status: res.status, count: Array.isArray(body) ? body.length : -1 };
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
      expect(await eventsVia(resolveAgent, bound.query)).toEqual({ status: 200, count: bound.count });
    });
  }
});

describe('a direct RPC cannot ask for more than the route may', () => {
  test('the RPC applies the same bounds with no route in the path', async () => {
    const { stub } = runEventsWorkspace();

    const countOf = async (opts: RunEventQuery): Promise<number> => (await stub.getRunEvents('run-1', opts)).length;

    // No route: the same query strings handed straight to the RPC.
    expect(await countOf({ limit: -1 })).toBe(1);
    expect(await countOf({ limit: Number.NaN })).toBe(RUN_EVENT_LIMIT_DEFAULT);
    expect(await countOf({ limit: 2.7 })).toBe(2);
    expect(await countOf({ limit: 1e9 })).toBe(RUN_EVENT_LIMIT_MAX);
    expect(await countOf({ limit: -1, types: ['error'] })).toBe(1);
    expect(await countOf({ since: Number.NaN, limit: 3 })).toBe(3);
  });
});
