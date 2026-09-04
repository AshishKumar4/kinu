// The KINU-N019 mechanism in the sibling `agent_log` read. The events route
// parsed `?limit=` with `parseInt` and forwarded it raw; the orchestrator
// defaulted it with `?? 100`, which catches null and undefined and nothing
// else. So `-1` reached SQLite as `LIMIT -1` — no limit at all — and one
// request read, valibot-parsed row by row and JSON-serialized the whole event
// history inside the Durable Object. `?limit=abc` parsed to NaN, which SQLite
// refuses as a datatype mismatch, so that request answered 500.
//
// Measured on this suite's storage before the fix, 700 rows seeded and a
// default page of 100: `?limit=-1` returned 700 rows and `?limit=abc` returned
// 500.
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
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

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

/** A real workspace object, seeded past the ceiling, behind a namespace double
 *  the route resolves through exactly the way production does. */
function seededWorkspace() {
  const harness = orchestratorHarness();
  for (let i = 0; i < SEEDED_EVENTS; i++) {
    harness.agent.publishHarnessEvent(chatDescriptor(`event ${i}`), 1000 + i);
  }
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: () => harness.agent,
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  // SAFETY: this suite reaches only the locally constructed orchestrator
  // namespace and credential secret.
  const env = partialEnv as Env;
  return { env, harness };
}

async function eventsVia(env: Env, query: string): Promise<{ status: number; count: number }> {
  const res = await handleHubRequest(
    new Request(`https://kinu.example.com/api/workspaces/${WORKSPACE}/events${query}`),
    env,
    WORKSPACE,
  );
  if (!res) throw new Error('the route did not claim the request');
  const body: unknown = await res.json();
  return { status: res.status, count: Array.isArray(body) ? body.length : -1 };
}

describe('the events route closes `limit` before it can reach SQL', () => {
  test('a negative limit returns the default page, not the table', async () => {
    const { env } = seededWorkspace();
    expect(await eventsVia(env, '?limit=-1')).toEqual({ status: 200, count: 1 });
    expect(await eventsVia(env, '?limit=-999999')).toEqual({ status: 200, count: 1 });
  });

  test('a negative limit stays bounded with a variant filter as well', async () => {
    const { env } = seededWorkspace();
    expect(await eventsVia(env, '?limit=-1&variant=chat')).toEqual({ status: 200, count: 1 });
  });

  test('zero returns a row rather than reporting the log as empty', async () => {
    const { env } = seededWorkspace();
    expect(await eventsVia(env, '?limit=0')).toEqual({ status: 200, count: 1 });
  });

  test('unparseable limit text means unstated and answers 200 with the default', async () => {
    // Not a 400. The run-event route already settled this question: absent and
    // unreadable are the same statement, and the route does not have to decide
    // what a garbage query string meant. Before the fix each of these was a 500
    // from SQLite's datatype mismatch.
    const { env } = seededWorkspace();
    expect(await eventsVia(env, '?limit=abc'))
      .toEqual({ status: 200, count: DEFAULT_PAGE });
    expect(await eventsVia(env, '?limit=NaN'))
      .toEqual({ status: 200, count: DEFAULT_PAGE });
    expect(await eventsVia(env, '?limit=Infinity'))
      .toEqual({ status: 200, count: DEFAULT_PAGE });
  });

  test('an absurdly large limit clamps to the untrusted ceiling', async () => {
    const { env } = seededWorkspace();
    expect(await eventsVia(env, '?limit=1000000000'))
      .toEqual({ status: 200, count: UNTRUSTED_CEILING });
    expect(await eventsVia(env, `?limit=${Number.MAX_SAFE_INTEGER}`))
      .toEqual({ status: 200, count: UNTRUSTED_CEILING });
  });

  test('a fractional limit truncates instead of failing the query', async () => {
    const { env } = seededWorkspace();
    expect(await eventsVia(env, '?limit=2.7')).toEqual({ status: 200, count: 2 });
  });

  test('a legitimate limit is still honoured exactly, and absence takes the default', async () => {
    const { env } = seededWorkspace();
    expect(await eventsVia(env, '?limit=37')).toEqual({ status: 200, count: 37 });
    expect(await eventsVia(env, ''))
      .toEqual({ status: 200, count: DEFAULT_PAGE });
  });

  test('an unparseable or negative since reads from the start of the log', async () => {
    const { env } = seededWorkspace();
    expect(await eventsVia(env, '?since=abc&limit=3')).toEqual({ status: 200, count: 3 });
    expect(await eventsVia(env, '?since=-5&limit=3')).toEqual({ status: 200, count: 3 });
  });
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

  test('the wire form carries the same ceiling', async () => {
    const { harness } = seededWorkspace();
    const countOf = async (opts: { limit?: number }): Promise<number> => {
      const parsed: unknown = JSON.parse(await harness.agent.listRecentEventsWire(opts));
      return Array.isArray(parsed) ? parsed.length : -1;
    };
    expect(await countOf({ limit: -1 })).toBe(1);
    expect(await countOf({ limit: 1e9 })).toBe(UNTRUSTED_CEILING);
  });
});
