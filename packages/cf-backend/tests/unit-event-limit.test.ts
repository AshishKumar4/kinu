// KINU-N019 in the sibling `agent_log` read: a raw `?limit=-1` reached SQLite as `LIMIT -1` (unbounded)
// and `?limit=abc` as NaN (500). Measured on this suite's storage, 700 rows seeded: -1 returned 700, abc 500.
// A real `OrchestratorAgent` over bun:sqlite, because the defect was in what SQL did with the value.
import { describe, test, expect } from 'bun:test';
import { serveFamily } from './helpers/api';
import { boundEventQuery, type IngressDescriptor } from '@kinu.run/core';

/** Asked of `boundEventQuery` rather than restated here. */
const DEFAULT_PAGE = boundEventQuery().limit;

const UNTRUSTED_CEILING = boundEventQuery({ limit: Number.MAX_SAFE_INTEGER }).limit;

import { eventsOver, orchestratorHarness } from './helpers/actor-harness';
import type { HubEnv, HubResolver } from '../src/events/routes';

// Dynamic: the route module resolves the Agent SDK at import time, so it loads after `actor-harness`
// installs the stand-in.
const { hubRoutes } = await import('../src/events/routes');

const WORKSPACE = 'harness-actor';

/** Past the ceiling, so an unbounded read differs from both a clamped one and a full page. */
const SEEDED_EVENTS = 700;

/** Chat events carry no dedupe key, so all of them land. */
function chatDescriptor(text: string): IngressDescriptor {
  return {
    ingress: 'chat_ws', variant: 'chat',
    payload: { text }, operator_user_id: 'u', session_id: 's',
  };
}

function seededWorkspace() {
  const harness = orchestratorHarness();

  for (let i = 0; i < SEEDED_EVENTS; i++) {
    eventsOver(harness.db).publish({ descriptor: chatDescriptor(`event ${i}`), now: 1000 + i });
  }

  return { resolveAgent: () => Promise.resolve(harness.agent), harness };
}

/** The events path reads no binding; the route secret is reached only on trigger creation. */
const NO_BINDING_READ: HubEnv = {};

async function eventsVia(
  resolveAgent: HubResolver, query: string,
): Promise<{ status: number; count: number }> {
  const res = await serveFamily(hubRoutes(() => resolveAgent), { workspace: { name: WORKSPACE } })(new Request(`https://kinu.example.com/api/workspaces/${WORKSPACE}/events${query}`), NO_BINDING_READ);

  if (!res) throw new Error('the route did not claim the request');
  const body: unknown = await res.json();

  return { status: res.status, count: Array.isArray(body) ? body.length : -1 };
}

/** One row per test, so a failure names its own case. */
const BOUNDED_QUERIES: readonly { readonly name: string; readonly query: string; readonly count: number }[] = [
  { name: 'a negative limit returns the default page, not the table', query: '?limit=-1', count: 1 },
  { name: 'a far more negative limit is bounded the same way', query: '?limit=-999999', count: 1 },
  { name: 'a negative limit stays bounded with a variant filter as well', query: '?limit=-1&variant=chat', count: 1 },
  { name: 'zero returns a row rather than reporting the log as empty', query: '?limit=0', count: 1 },
  // Not a 400: as on the run-event route, absent and unreadable are the same statement.
  { name: 'unparseable limit text means unstated and answers 200 with the default', query: '?limit=abc', count: DEFAULT_PAGE },
  { name: 'a literal NaN means unstated too', query: '?limit=NaN', count: DEFAULT_PAGE },
  { name: 'a literal Infinity means unstated too', query: '?limit=Infinity', count: DEFAULT_PAGE },
  { name: 'an absurdly large limit clamps to the untrusted ceiling', query: '?limit=1000000000', count: UNTRUSTED_CEILING },
  { name: 'the largest safe integer clamps there too', query: `?limit=${Number.MAX_SAFE_INTEGER}`, count: UNTRUSTED_CEILING },
  { name: 'a fractional limit truncates instead of failing the query', query: '?limit=2.7', count: 2 },
  { name: 'a legitimate limit is still honoured exactly', query: '?limit=37', count: 37 },
  { name: 'no limit at all takes the default page', query: '', count: DEFAULT_PAGE },
  { name: 'an unparseable since reads from the start of the log', query: '?since=abc&limit=3', count: 3 },
  { name: 'a negative since reads from the start of the log', query: '?since=-5&limit=3', count: 3 },
];

describe('the events route closes `limit` before it can reach SQL', () => {
  for (const bound of BOUNDED_QUERIES) {
    test(bound.name, async () => {
      const { resolveAgent } = seededWorkspace();
      expect(await eventsVia(resolveAgent, bound.query)).toEqual({ status: 200, count: bound.count });
    });
  }
});

describe('a direct RPC cannot ask for more than the route may', () => {
  // `listRecentEvents` (CLI RPC, cli/rpc-gate.ts) and `listRecentEventsWire` (cross-DO, rpc-surface.ts)
  // reach the object with no route in the path, the bypass a route-only fix leaves open.
  test('the RPC applies the same bounds with no route in the path', async () => {
    const { harness } = seededWorkspace();

    const countOf = async (opts: { variant?: string; since?: number; limit?: number }) =>
      (await harness.agent.listRecentEvents(opts)).length;

    expect(await countOf({ limit: -1 })).toBe(1);
    expect(await countOf({ limit: -999999 })).toBe(1);
    expect(await countOf({ limit: 0 })).toBe(1);
    expect(await countOf({ limit: Number.NaN })).toBe(DEFAULT_PAGE);
    expect(await countOf({ limit: Number.POSITIVE_INFINITY })).toBe(DEFAULT_PAGE);
    expect(await countOf({})).toBe(DEFAULT_PAGE);
    expect(await countOf({ limit: 2.7 })).toBe(2);
    expect(await countOf({ limit: 1e9 })).toBe(UNTRUSTED_CEILING);
    expect(await countOf({ limit: -1, variant: 'chat' })).toBe(1);
    expect(await countOf({ since: Number.NaN, limit: 3 })).toBe(3);
  });

  test('the RPC carries the same ceiling', async () => {
    const { harness } = seededWorkspace();

    const countOf = async (opts: { limit?: number }): Promise<number> =>
      (await harness.agent.listRecentEvents(opts)).length;

    expect(await countOf({ limit: -1 })).toBe(1);
    expect(await countOf({ limit: 1e9 })).toBe(UNTRUSTED_CEILING);
  });
});
