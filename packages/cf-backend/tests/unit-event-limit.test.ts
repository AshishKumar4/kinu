// The KINU-N019 mechanism in the sibling `agent_log` read. The events route
// parsed `?limit=` with `parseInt` and forwarded it raw; the orchestrator
// defaulted it with `?? 100`, which catches null and undefined and nothing
// else. So `-1` reached SQLite as `LIMIT -1` — no limit at all — and one
// request read, valibot-parsed row by row and JSON-serialized the whole event
// history inside the Durable Object. `?limit=abc` parsed to NaN, which SQLite
// refuses as a datatype mismatch, so that request answered 500.
//
// Measured on this suite's storage, 700 rows seeded and a default page of
// 100: unbounded, `?limit=-1` returns 700 rows and `?limit=abc` returns 500.
//
// The object behind the route is a REAL `OrchestratorAgent` over its own
// bun:sqlite, seeded through `publish` — the only admitted author of an event
// row — because the defect was in what SQL did with the forwarded value. A
// counting stub would have agreed with the old code.
import { describe, test, expect } from 'bun:test';
import { boundEventQuery, type IngressDescriptor } from '@kinu.run/core';

/** The page policy ASKED OF THE PUBLIC SEAM rather than restated here: the
 *  route crosses `boundEventQuery`, so its answers ARE the default page and
 *  the untrusted ceiling this suite asserts the route holds to. */
const DEFAULT_PAGE = boundEventQuery().limit;

const UNTRUSTED_CEILING = boundEventQuery({ limit: Number.MAX_SAFE_INTEGER }).limit;

import { orchestratorHarness } from './helpers/actor-harness';
import type { HubEnv, HubResolver } from '../src/events/routes';

// Dynamic on purpose: the route module resolves the Agent SDK at import time,
// so it may only load AFTER `actor-harness` installs the stand-in. The static
// import above is the harness itself, which is what installs it.
const { handleHubRequest } = await import('../src/events/routes');

/** The workspace the harness names, which is also the path the route matches. */
const WORKSPACE = 'harness-actor';

/** Seeded past the untrusted ceiling, so an unbounded read is distinguishable
 *  from a clamped one AND from a full page. */
const SEEDED_EVENTS = 700;

/** Chat events, which carry no dedupe key, so all of them land. */
function chatDescriptor(text: string): IngressDescriptor {
  return {
    ingress: 'chat_ws', variant: 'chat',
    payload: { text }, operator_user_id: 'u', session_id: 's',
  };
}

/** A real workspace object, seeded past the ceiling, behind the resolver the
 *  route reaches it through. */
function seededWorkspace() {
  const harness = orchestratorHarness();

  for (let i = 0; i < SEEDED_EVENTS; i++) {
    harness.agent.publishHarnessEvent(chatDescriptor(`event ${i}`), 1000 + i);
  }

  return { resolveAgent: () => Promise.resolve(harness.agent), harness };
}

/** The events path reads no binding at all: the route secret is reached only
 *  when a trigger is created, and an absent one refuses with a 503 there. */
const NO_BINDING_READ: HubEnv = {};

async function eventsVia(
  resolveAgent: HubResolver, query: string,
): Promise<{ status: number; count: number }> {
  const res = await handleHubRequest(
    new Request(`https://kinu.example.com/api/workspaces/${WORKSPACE}/events${query}`),
    NO_BINDING_READ,
    WORKSPACE,
    resolveAgent,
  );

  if (!res) throw new Error('the route did not claim the request');
  const body: unknown = await res.json();

  return { status: res.status, count: Array.isArray(body) ? body.length : -1 };
}

/** Every query string the route must close, and the number of events it may
 *  answer with. One row is one test, so a failure still names its own case. */
const BOUNDED_QUERIES: readonly { readonly name: string; readonly query: string; readonly count: number }[] = [
  { name: 'a negative limit returns the default page, not the table', query: '?limit=-1', count: 1 },
  { name: 'a far more negative limit is bounded the same way', query: '?limit=-999999', count: 1 },
  { name: 'a negative limit stays bounded with a variant filter as well', query: '?limit=-1&variant=chat', count: 1 },
  { name: 'zero returns a row rather than reporting the log as empty', query: '?limit=0', count: 1 },
  // Not a 400. The run-event route already settled this question: absent and
  // unreadable are the same statement, and the route does not have to decide
  // what a garbage query string meant. Forwarded raw, each of these is a 500
  // from SQLite's datatype mismatch.
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
  // `listRecentEvents` is on the CLI RPC surface gated at `workspace.read`
  // (cli/rpc-gate.ts) and `listRecentEventsWire` is on the cross-DO surface
  // (rpc-surface.ts). Both reach the object with NO route in the path, which is
  // the bypass a route-only fix leaves open.
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
