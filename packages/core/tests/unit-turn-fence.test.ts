/** The workspace's fence on an agent's turns (design v3 B): checked before it writes, kept as a tombstone, durable. */
import { describe, expect, test } from 'bun:test';
import { createTestActors, createTestSql } from '@kinu.run/test-utils';
import { initTurnFenceTable, TurnFences } from '../src/subordinates/turn-fence';
import type { TurnFacts } from '../src/orchestrator/turn-facts';

function fenced() {
  const { sql, execRaw } = createTestSql();
  const { main } = createTestActors(sql, execRaw);

  initTurnFenceTable(execRaw);

  // A fresh object over the same rows is the workspace after a reset.
  return { actor: main.actorId, fences: () => new TurnFences(sql), sql };
}

const LEARNING: TurnFacts = { continuity: 'conversation', evolutionEnabled: true, missionLabels: [] };

const NOT_LEARNING: TurnFacts = { ...LEARNING, evolutionEnabled: false };

describe('TurnFences', () => {
  test("an earlier turn's opening, delivered after a later turn opened, is refused before and after a reset", () => {
    const { actor, fences } = fenced();

    expect(fences().open(actor, 't1', 1)).toBe(true);
    expect(fences().open(actor, 't2', 1)).toBe(true);
    expect(fences().open(actor, 't1', 1)).toBe(false);
    expect(fences().open(actor, 't1', 2)).toBe(false);
  });

  test("a refused opening changes nothing: the later turn's fence still holds its epoch", () => {
    const { actor, fences } = fenced();

    fences().open(actor, 't1', 1);
    fences().open(actor, 't2', 3);
    expect(fences().open(actor, 't1', 9)).toBe(false);

    expect(fences().open(actor, 't2', 2)).toBe(false);
    expect(fences().open(actor, 't2', 3)).toBe(true);
  });

  test("a cancelled turn's opening is refused, whatever its epoch", () => {
    const { actor, fences, sql } = fenced();

    fences().open(actor, 't1', 1);
    // Stop's cutoff writes this (step 6); planted until it does.
    void sql`UPDATE actor_turn_fence SET cancelled_at = 1 WHERE actor_id = ${actor} AND turn_id = 't1'`;

    expect(fences().open(actor, 't1', 2)).toBe(false);
  });

  test('a preparation is offered the facts first offered, across a reset, until the turn settles', () => {
    const { actor, fences } = fenced();

    fences().open(actor, 't1', 1);
    expect(fences().offer(actor, 't1', LEARNING)).toEqual(LEARNING);
    expect(fences().offer(actor, 't1', NOT_LEARNING)).toEqual(LEARNING);
  });

  test("a settled turn's opening is refused at its epoch, and its retry, at the next, is a new execution", () => {
    const { actor, fences } = fenced();

    fences().open(actor, 't1', 1);
    fences().offer(actor, 't1', LEARNING);
    fences().settled(actor, 't1');

    expect(fences().open(actor, 't1', 1)).toBe(false);
    expect(fences().open(actor, 't1', 2)).toBe(true);
    expect(fences().offer(actor, 't1', NOT_LEARNING)).toEqual(NOT_LEARNING);
  });
});
