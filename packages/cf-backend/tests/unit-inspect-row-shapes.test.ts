/**
 * One formatter, one shape — what every `kinu inspect` list read must answer
 * with.
 *
 * The CLI renders five lists (events, timeline, heads, gepa, executors) through
 * a single `printRows` in cli/src/commands/inspect.ts, which parses its input
 * with `JsonArraySchema`. A producer that answers with an ENVELOPE therefore
 * does not fail: it silently stops being formatted. `listRecentEvents` returned
 * `{ events: [...] }` while its four siblings returned bare arrays, so
 * `kinu inspect events` printed raw JSON against a cloud workspace and
 * formatted rows against a local one, and nothing was red.
 *
 * Nothing type-level would have caught it — the method declared no return type,
 * and the CLI parses the wire as `JsonValue`. So the agreement is checked where
 * it is actually decided: the real orchestrator's return VALUES, against the
 * same predicate the formatter applies to them.
 *
 * The producer list is read out of inspect.ts rather than typed here, so a
 * sixth list command cannot start using the formatter without this file naming
 * it.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { JsonArraySchema } from '@kinu/core';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const INSPECT_SOURCE = resolve(import.meta.dir, '../../cli/src/commands/inspect.ts');

/**
 * The cloud RPC names whose answer reaches `printRows`, read out of the
 * commands' own source.
 *
 * Every command in that file is written the same way: read, then print. So a
 * read belongs to the printer that comes next, and one command may have several
 * reads feeding one printer (a query/no-query pair). Attributing per FUNCTION
 * instead would be wrong: `gepa` reads a list and a single run, and only the
 * list is rows.
 *
 * The read's name is the argument after `target.cloudName`, which is how the
 * whole file spells `callAgentRpc`. Printer definitions sit below the last
 * command, so they claim no reads.
 */
const CLOUD_READ_OR_PRINTER = /target\.cloudName,\s*'([A-Za-z0-9_]+)'|print(Rows|Data|Json|Pretty)\(/g;

function cloudRowReads(source: string): string[] {
  const rowReads: string[] = [];
  let unprinted: string[] = [];
  for (const marker of source.matchAll(CLOUD_READ_OR_PRINTER)) {
    const [, readName, printer] = marker;
    if (readName !== undefined) {
      unprinted.push(readName);
      continue;
    }
    if (printer === 'Rows') rowReads.push(...unprinted);
    unprinted = [];
  }
  return rowReads.sort();
}

/**
 * Pinned, so that a derivation which has quietly stopped matching anything
 * reads as red rather than as "no producers to check" — an empty inventory and
 * an agreeing one must not look alike.
 */
const ROW_READS = [
  'getExecutors',
  'getGepaRuns',
  'getHeadRuns',
  'getRunTimeline',
  'listRecentEvents',
] as const;

/** The ten fields the events read publishes to the operator surfaces. The
 *  projection is an allowlist: `schema_version`, `dedupe_key` and
 *  `reply_channel` are the log's own plumbing and stay inside the workspace. */
const EVENT_ROW_FIELDS = [
  'caused_by', 'id', 'ingress', 'payload', 'payload_visibility',
  'priority', 'received_at', 'trace_id', 'trust', 'variant',
] as const;

const SEEDED_AT = 1_700_000_000_000;

/** A real orchestrator holding one event, so the reads below are exercised on a
 *  populated log — an envelope around an EMPTY list parses the same way as an
 *  envelope around rows, but only the populated case also proves the
 *  projection. */
function orchestratorWithOneEvent(): HarnessOrchestratorAgent {
  const { agent } = orchestratorHarness();
  agent.publishHarnessEvent({
    ingress: 'chat_ws',
    variant: 'chat',
    payload: { text: 'a row to render' },
    operator_user_id: 'harness-owner',
    session_id: 'harness-session',
  }, SEEDED_AT);
  return agent;
}

describe('kinu inspect list reads', () => {
  test('the formatter is fed by exactly the reads this gate exercises', () => {
    expect(cloudRowReads(readFileSync(INSPECT_SOURCE, 'utf8'))).toEqual([...ROW_READS]);
  });

  test('every one of them answers with rows the formatter can parse', async () => {
    const agent = orchestratorWithOneEvent();

    // `satisfies` rather than an annotation, so this carries BOTH halves of the
    // agreement: the key set is the pinned inventory, so a read added there has
    // to be called here, and `object[]` is the shape a row list has — which the
    // enveloped version of this read would not have compiled against.
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
    expect(Object.keys(rows[0]!).sort()).toEqual([...EVENT_ROW_FIELDS]);
    expect(rows[0]).toMatchObject({ variant: 'chat', ingress: 'chat_ws', received_at: SEEDED_AT });
  });
});
