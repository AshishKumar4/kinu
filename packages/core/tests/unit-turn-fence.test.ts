/** The workspace's fence on an agent's turns (design v3 B): ordered by the agent's sequence, compared on every write. */
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
    expect(fences().ended(actor, { runId: 'r1' })).toEqual({ seq: 3 });
  });

  test("a run's recovery keeps the facts first offered it, across a reset; its Retry, a new run, is offered afresh", () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 1 });
    expect(fences().offer(actor, { seq: 1 }, LEARNING)).toEqual(LEARNING);
    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 2 });
    expect(fences().offer(actor, { seq: 2 }, NOT_LEARNING)).toEqual(LEARNING);

    expect(fences().ended(actor, { runId: 'r1' })).toEqual({ seq: 2 });
    fences().open(actor, { turnId: 't1', runId: 'r1-retry', seq: 3 });
    expect(fences().offer(actor, { seq: 3 }, NOT_LEARNING)).toEqual(NOT_LEARNING);
  });

  test("a preparation that finishes after a later opening offers nothing, and leaves the later one's offer to it", () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'rA', seq: 1 });
    fences().open(actor, { turnId: 't1', runId: 'rB', seq: 2 });

    expect(fences().offer(actor, { seq: 1 }, LEARNING)).toBeNull();
    expect(fences().offer(actor, { seq: 2 }, NOT_LEARNING)).toEqual(NOT_LEARNING);
  });

  test('an ended run is offered nothing, so a late preparation cannot refill it', () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 1 });
    fences().ended(actor, { runId: 'r1' });

    expect(fences().offer(actor, { seq: 1 }, LEARNING)).toBeNull();
    expect(fences().current(actor)).toBeNull();
  });

  test("an end delayed past a later opening, a later turn's or a Retry's, is not the open run's and ends nothing", () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 1 });
    fences().open(actor, { turnId: 't1', runId: 'r1-retry', seq: 2 });
    fences().offer(actor, { seq: 2 }, LEARNING);
    expect(fences().ended(actor, { runId: 'r1' })).toBeNull();
    fences().open(actor, { turnId: 't2', runId: 'r2', seq: 3 });
    expect(fences().ended(actor, { runId: 'r1-retry' })).toBeNull();

    expect(fences().offer(actor, { seq: 3 }, NOT_LEARNING)).toEqual(NOT_LEARNING);
    expect(fences().ended(actor, { runId: 'r2' })).toEqual({ seq: 3 });
    expect(fences().ended(actor, { runId: 'r2' })).toBeNull();
  });

  test('a lost end closes the opening seen open before the ask, and nothing a later opening put in its place', () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 1 });
    const seen = fences().current(actor);

    fences().open(actor, { turnId: 't1', runId: 'r1-retry', seq: 2 });

    expect(seen).toEqual({ seq: 1 });
    expect(fences().ended(actor, { seq: 1 })).toBeNull();
    expect(fences().current(actor)).toEqual({ seq: 2 });
  });

  test("an agent that never opened a turn here is unfenced: its end is applied as told", () => {
    const { actor, fences } = fenced();

    expect(fences().ended(actor, { runId: 'r1' })).toBe('unfenced');
  });
});
