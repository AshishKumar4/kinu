/**
 * The LOCAL peers of two bounded cloud reads, driven directly rather than
 * through a CLI spawn so the bound itself is what is observed.
 *
 * `--limit` on `kinu inspect timeline` and `kinu inspect memory` arrives via
 * `numberField`, so the value reaching these functions is whatever the operator
 * typed. `listLocalTimeline` bound it into three raw `LIMIT ?` statements plus a
 * tail slice, and `searchLocalMemory` into two. SQLite reads `LIMIT -1` as no
 * limit at all and rejects a fraction or `NaN` as a datatype mismatch, so the
 * same flag could either read whole tables or fail the command.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { RUN_TIMELINE_MAX, initWorkspaceSchema } from '@kinu.run/core';
import { makeWorkspaceSchemaSql } from '@kinu.run/cli-backend';
import { createTestActorsOver } from '@kinu.run/test-utils';
import { agentDir } from '../src/config';
import { listLocalTimeline, searchLocalMemory } from '../src/local-inspection';

// The process scratch KINU_HOME (scripts/test-scratch-home.ts, set by the
// preload before any module loads) IS this suite's home: `config.ts` resolves
// AGENT_HOME once at import time, and under one bun process another test file
// usually loads it first — a suite-private HOME set here would be ignored, and
// the seeded agent would land where `agentDbPath` never looks.
const AGENT = 'probe';
const AGENT_DIR = agentDir(AGENT);
const DB_PATH = join(AGENT_DIR, 'agent.db');

afterAll(() => rmSync(AGENT_DIR, { recursive: true, force: true }));

/** Rebuild the agent's database with `rows` rows in each timeline spine and in
 *  the memory index, so a bound is observable as a row count.
 *
 *  The schema is the SHIPPED one, and the rows belong to a REAL actor. Both
 *  halves are load-bearing: `evolution_events` is keyed `(actor_id, id)` and
 *  `listLocalTimeline` reads it `WHERE actor_id = ?` against the actor
 *  `openWorkspaceMainActor` resolves — so a hand-rolled table without the
 *  column, or rows written under no owner, contribute NOTHING to the fold and
 *  the bound under test silently reads one spine instead of two. */
function seed(rows: number): void {
  rmSync(AGENT_DIR, { recursive: true, force: true });
  mkdirSync(AGENT_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const { actorId } = createTestActorsOver(db, { name: AGENT }).main;
  for (let i = 0; i < rows; i++) {
    db.run('INSERT INTO agent_log (actor_id, id, kind, trace_id, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)',
      [actorId, `log-${i}`, 'step', `trace-${i}`, '{}', 1000 + i]);
    db.run('INSERT INTO evolution_events (actor_id, id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      [actorId, `ev-${i}`, 'note', `m${i}`, 1000 + i]);
    db.run('INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [`c-${i}`, `memory/n${i}.md`, 1, 2, `h${i}`, `wrangler staging note ${i}`, 1000 + i]);
  }
  db.close();
}

describe('listLocalTimeline closes the operator flag before it reaches SQL', () => {
  test('a negative limit reads one span, not two whole tables', () => {
    seed(30);
    // Two failures a raw -1 would cause at once: `LIMIT -1` on agent_log and
    // evolution_events reads everything, and `slice(0, -1)` then drops the LAST
    // row of whatever survived.
    expect(listLocalTimeline(AGENT, -1).length).toBe(1);
  });

  test('an unparseable limit means unstated and takes this surface default of 100', () => {
    // 80 agent_log + 80 evolution rows merge to 160 spans, so a default of 100
    // is observable and distinguishes it from the cloud peer's 200.
    seed(80);
    expect(listLocalTimeline(AGENT, Number.NaN).length).toBe(100);
    expect(listLocalTimeline(AGENT).length).toBe(100);
  });

  test('a fractional limit truncates instead of failing the command', () => {
    seed(30);
    expect(listLocalTimeline(AGENT, 2.7).length).toBe(2);
    expect(listLocalTimeline(AGENT, 0.5).length).toBe(1);
  });

  test('an oversized limit clamps to the ceiling shared with the cloud peer', () => {
    seed(300);
    expect(listLocalTimeline(AGENT, 1e9).length).toBe(RUN_TIMELINE_MAX);
  });

  test('a legitimate limit is honoured exactly', () => {
    seed(80);
    expect(listLocalTimeline(AGENT, 37).length).toBe(37);
  });
});

describe('searchLocalMemory closes the operator flag too', () => {
  test('a negative limit returns one row rather than the whole index', () => {
    seed(40);
    expect(searchLocalMemory(AGENT, 'wrangler', -1).length).toBe(1);
  });

  test('an unparseable or fractional limit does not fail the query', () => {
    seed(40);
    expect(searchLocalMemory(AGENT, 'wrangler', Number.NaN).length).toBe(10);
    expect(searchLocalMemory(AGENT, 'wrangler', 2.7).length).toBe(2);
  });

  test('a widened recall read is still allowed, since this surface has no ceiling', () => {
    // Validity only here, deliberately: an operator who asks a local memory
    // search to widen should get the wider read.
    seed(40);
    expect(searchLocalMemory(AGENT, 'wrangler', 40).length).toBe(40);
  });

  test('an empty query is answered before the bound is reached', () => {
    seed(5);
    expect(searchLocalMemory(AGENT, '   ', -1)).toEqual([]);
  });
});
