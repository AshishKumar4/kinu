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
    expect(fences().ended(actor, { runId: 'r1' })).toEqual({ seq: 3, turnId: 't1' });
  });

  test("a run's recovery keeps the facts first offered it, across a reset; its Retry, a new run, is offered afresh", () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 1 });
    expect(fences().offer(actor, { seq: 1 }, LEARNING)).toEqual(LEARNING);
    fences().open(actor, { turnId: 't1', runId: 'r1', seq: 2 });
    expect(fences().offer(actor, { seq: 2 }, NOT_LEARNING)).toEqual(LEARNING);

    expect(fences().ended(actor, { runId: 'r1' })).toEqual({ seq: 2, turnId: 't1' });
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
    expect(fences().ended(actor, { runId: 'r2' })).toEqual({ seq: 3, turnId: 't2' });
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

  test('Stop holds across a recovery of the stopped run: only new input or a Retry opens the agent again', () => {
    const { actor, fences } = fenced();

    fences().open(actor, { turnId: 'stopped-turn', runId: 'stopped-run', seq: 1 });
    fences().cancel(actor, Date.now());
    expect(fences().open(actor, { turnId: 'stopped-turn', runId: 'stopped-run', seq: 2 })).toBe(false);
    expect(fences().open(actor, { turnId: 'stopped-turn', runId: 'stopped-run-retry', seq: 3 })).toBe(true);
  });

  test("a later execution's opening is neither taken nor cleared by an earlier one's late end, whichever kind each is", () => {
    const { actor, fences } = fenced();
    const chat = { turnId: 'chat-turn', runId: 'chat-run', seq: 4 };
    const run = { turnId: 'node-task', runId: 'node-run', seq: 5 };

    // The run, minted after the chat turn's claim, opens after it; the chat turn's opening, delivered late, is refused.
    expect(fences().open(actor, chat)).toBe(true);
    expect(fences().open(actor, run)).toBe(true);
    expect(fences().open(actor, chat)).toBe(false);
    // The chat turn's end, told late, ends nothing of the run's; the run's own ends it.
    expect(fences().ended(actor, { runId: chat.runId })).toBeNull();
    expect(fences().row(actor)).toEqual({ ...run, live: true });
    expect(fences().ended(actor, { runId: run.runId })).toEqual({ seq: run.seq, turnId: run.turnId });

    // And the reverse: a chat turn after the run, whose late end ends nothing of the chat turn's.
    const next = { turnId: 'chat-next', runId: 'chat-next-run', seq: 6 };

    expect(fences().open(actor, next)).toBe(true);
    expect(fences().ended(actor, { runId: run.runId })).toBeNull();
    expect(fences().row(actor)).toEqual({ ...next, live: true });
  });

  test("a close is judged by the opening it names: its own runs after newer ones, another's or a newer one's runs nothing", () => {
    const { actor, fences } = fenced();
    const first = { turnId: 't1', runId: 'r1', seq: 1 };
    const second = { turnId: 't2', runId: 'r2', seq: 2 };

    fences().open(actor, first);
    fences().open(actor, second);

    expect(fences().closes(actor, first)).toBe(true);
    expect(fences().closes(actor, { ...first, runId: second.runId })).toBe(false);
    expect(fences().closes(actor, { turnId: 't9', runId: 'r9', seq: 9 })).toBe(false);
    // A repeat of its own close runs, as every close write is keyed on its execution; another's naming it still runs nothing.
    expect(fences().closes(actor, first)).toBe(true);
    expect(fences().closes(actor, { ...first, turnId: second.turnId })).toBe(false);
    expect(fences().closes(actor, { ...second, runId: first.runId })).toBe(false);
    // One never admitted, stopped or failed before its claim was bound, names no opening, and closes nothing of the fence.
    expect(fences().closes(actor, { turnId: 't3', runId: 'r3', seq: null })).toBe(true);
  });
});
