/**
 * Defends: an enveloped `kinu inspect` read is silently left unformatted, since `printRows` parses
 * with `JsonArraySchema`. Checked on the real orchestrator's return values.
 */

import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JsonArraySchema } from '@kinu.run/core';
import { eventsOver, orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** Pinned, so an empty inventory and an agreeing one do not look alike. */
const ROW_READS = [
  'getExecutors',
  'getGepaRuns',
  'getHeadRuns',
  'getRunTimeline',
  'listRecentEvents',
] as const;

/** An allowlist: `schema_version`, `dedupe_key` and `reply_channel` stay inside the workspace. */
const EVENT_ROW_FIELDS = [
  'caused_by', 'id', 'ingress', 'payload', 'payload_visibility',
  'priority', 'received_at', 'trace_id', 'trust', 'variant',
] as const;

const SEEDED_AT = 1_700_000_000_000;

/** Populated, so the projection is proven too. */
function orchestratorWithOneEvent(): HarnessOrchestratorAgent {
  const { agent, db } = orchestratorHarness();
  eventsOver(db).publish({ descriptor: {
    ingress: 'chat_ws',
    variant: 'chat',
    payload: { text: 'a row to render' },
    operator_user_id: 'harness-owner',
    session_id: 'harness-session',
  }, now: SEEDED_AT });

  return agent;
}

describe('kinu inspect list reads', () => {
  test('every one of them answers with rows the formatter can parse', async () => {
    const agent = orchestratorWithOneEvent();

    // `satisfies`: keys must match the pinned inventory, and an enveloped read would not compile.
    const reads = {
      getExecutors: () => agent.getExecutors(),
      getGepaRuns: () => agent.getGepaRuns(),
      getHeadRuns: () => agent.getHeadRuns(),
      getRunTimeline: () => agent.getRunTimeline(),
      listRecentEvents: () => agent.listRecentEvents(),
    } satisfies Record<(typeof ROW_READS)[number], () => Promise<object[]>>;

    for (const [name, read] of Object.entries(reads)) {
      const parsed = v.safeParse(JsonArraySchema, await read());
      expect([name, parsed.success]).toEqual([name, true]);
    }
  });

  test('the events read keeps its ten-field projection on each row', async () => {
    const rows = await orchestratorWithOneEvent().listRecentEvents();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...EVENT_ROW_FIELDS]);
    expect(rows[0]).toMatchObject({ variant: 'chat', ingress: 'chat_ws', received_at: SEEDED_AT });
  });
});
