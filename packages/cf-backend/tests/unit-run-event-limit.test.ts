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
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  getRunEvents, initRunEventTables, RunEventRecorder,
  RUN_EVENT_LIMIT_DEFAULT, RUN_EVENT_LIMIT_MAX, type RunEventQuery,
} from '@kinu.run/core';
import { makeSql, makeExecRaw } from '../../core/tests/helpers';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
// Dynamic on purpose: the route module resolves the Agent SDK at import time, so
// it may only load AFTER the stub is installed. Same seam as unit-sse-disconnect.
const { handleRunEventsRequest } = await import('../src/run-events-routes');

const SEEDED_EVENTS = 700;

/** A workspace whose `getRunEventsWire` is the production one: the boundary
 *  read-model over a real recorder, with no validation added by the test. */
function runEventsEnv() {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  const recorder = new RunEventRecorder(makeSql(db));
  for (let i = 0; i < SEEDED_EVENTS; i++) {
    recorder.emit('run-1', { type: 'error', message: `event ${i}` });
  }
  const stub = {
    async setName() {},
    async getRunEventsWire(runId: string, opts?: RunEventQuery) {
      return JSON.stringify(getRunEvents(recorder, runId, opts));
    },
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    OrchestratorAgent: { idFromName: (n: string) => n, get: () => stub },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  // SAFETY: this suite reaches only the locally constructed orchestrator
  // namespace and credential secret.
  const env = partialEnv as Env;
  return { env, stub };
}

async function eventsVia(env: Env, query: string): Promise<{ status: number; count: number }> {
  const res = await handleRunEventsRequest(new Request(
    `https://kinu.example.com/api/workspaces/jarvis/runs/run-1/events${query}`,
  ), env);
  if (!res) throw new Error('the route did not claim the request');
  const body: unknown = await res.json();
  return { status: res.status, count: Array.isArray(body) ? body.length : -1 };
}

describe('the run-events route closes `limit` before it can reach SQL', () => {
  test('a negative limit returns one event, not the whole run', async () => {
    const { env } = runEventsEnv();
    expect(await eventsVia(env, '?limit=-1')).toEqual({ status: 200, count: 1 });
    expect(await eventsVia(env, '?limit=-999999')).toEqual({ status: 200, count: 1 });
  });

  test('a negative limit stays bounded with a type filter as well', async () => {
    const { env } = runEventsEnv();
    expect(await eventsVia(env, '?limit=-1&types=error')).toEqual({ status: 200, count: 1 });
  });

  test('unparseable limit text means unstated and takes the default', async () => {
    const { env } = runEventsEnv();
    expect(await eventsVia(env, '?limit=abc'))
      .toEqual({ status: 200, count: RUN_EVENT_LIMIT_DEFAULT });
    expect(await eventsVia(env, '?limit=NaN'))
      .toEqual({ status: 200, count: RUN_EVENT_LIMIT_DEFAULT });
    expect(await eventsVia(env, '?limit=Infinity'))
      .toEqual({ status: 200, count: RUN_EVENT_LIMIT_DEFAULT });
  });

  test('a fractional limit truncates instead of failing the query', async () => {
    const { env } = runEventsEnv();
    expect(await eventsVia(env, '?limit=2.7')).toEqual({ status: 200, count: 2 });
  });

  test('an oversized limit clamps to the ceiling', async () => {
    const { env } = runEventsEnv();
    expect(await eventsVia(env, '?limit=1000000000'))
      .toEqual({ status: 200, count: RUN_EVENT_LIMIT_MAX });
  });

  test('a legitimate limit is still honoured exactly', async () => {
    const { env } = runEventsEnv();
    expect(await eventsVia(env, '?limit=37')).toEqual({ status: 200, count: 37 });
    expect(await eventsVia(env, '')).toEqual({ status: 200, count: RUN_EVENT_LIMIT_DEFAULT });
  });

  test('an unparseable or negative since reads from the start of the run', async () => {
    const { env } = runEventsEnv();
    expect(await eventsVia(env, '?since=abc&limit=3')).toEqual({ status: 200, count: 3 });
    expect(await eventsVia(env, '?since=-5&limit=3')).toEqual({ status: 200, count: 3 });
  });
});

describe('a direct RPC cannot ask for more than the route may', () => {
  test('the RPC applies the same bounds with no route in the path', async () => {
    const { stub } = runEventsEnv();
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
