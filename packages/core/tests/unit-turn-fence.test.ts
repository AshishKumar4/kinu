/** The workspace's fence on an agent's turns (design v3 B): ordered by the agent's sequence, bounded, durable. */
import { describe, expect, test } from 'bun:test';
import { createTestActors, createTestSql } from '@kinu.run/test-utils';
import { initTurnFenceTable, TurnFences } from '../src/subordinates/turn-fence';
import type { TurnFacts } from '../src/orchestrator/turn-facts';

function fenced() {
  const { sql, execRaw } = createTestSql();
  const { main } = createTestActors(sql, execRaw);

  initTurnFenceTable(execRaw);

  // A fresh object over the same rows is the workspace after a reset.
  return { actor: main.actorId, fences: () => new TurnFences(sql) };
}

const LEARNING: TurnFacts = { continuity: 'conversation', evolutionEnabled: true, missionLabels: [] };

const NOT_LEARNING: TurnFacts = { ...LEARNING, evolutionEnabled: false };

describe('TurnFences', () => {
  test("an earlier turn's opening, delivered after a later turn opened, is refused before and after a reset", () => {
    const { actor, fences } = fenced();
    const first = { turnId: 't1', runId: 'r1', seq: 1 };

    expect(fences().open(actor, first)).toBe(true);
    expect(fences().open(actor, { turnId: 't2', runId: 'r2', seq: 2 })).toBe(true);
    expect(fences().open(actor, first)).toBe(false);
  });

  test('the same opening delivered again is refused, and a refused one changes nothing', () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 3 });
    expect(fences().open(actor, { turnId: 't1', runId: 'r1', seq: 3 })).toBe(false);
    expect(fences().open(actor, { turnId: 't0', runId: 'r0', seq: 2 })).toBe(false);
    expect(fences().ended(actor, 'r1')).toBe(true);
  });

  test("a run's recovery keeps the facts first offered it, across a reset; its Retry, a new run, is offered afresh", () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 1 });
    expect(fences().offer(actor, LEARNING)).toEqual(LEARNING);
    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 2 });
    expect(fences().offer(actor, NOT_LEARNING)).toEqual(LEARNING);

    expect(fences().ended(actor, 'r1')).toBe(true);
    fences().open(actor, { turnId: 't1', runId: 'r1-retry', seq: 3 });
    expect(fences().offer(actor, NOT_LEARNING)).toEqual(NOT_LEARNING);
  });

  test("an end delayed past a later opening, a later turn's or a Retry's, is not the open run's and ends nothing", () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 1 });
    fences().open(actor, { turnId: 't1', runId: 'r1-retry', seq: 2 });
    fences().offer(actor, LEARNING);
    expect(fences().ended(actor, 'r1')).toBe(false);
    fences().open(actor, { turnId: 't2', runId: 'r2', seq: 3 });
    expect(fences().ended(actor, 'r1-retry')).toBe(false);

    expect(fences().offer(actor, NOT_LEARNING)).toEqual(NOT_LEARNING);
    expect(fences().ended(actor, 'r2')).toBe(true);
  });
});
