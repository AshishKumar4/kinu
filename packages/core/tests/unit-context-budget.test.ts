// The turn's context budget — the cumulative cap that makes RLMEnv's
// "the root sees a bounded slice of output" mechanical rather than advisory,
// and the M1 trip counters that say how often real traffic crosses it.
// Behavior contract only: cap arithmetic, counter accounting, spill-address
// recognition, and the per-turn reset.

import { describe, expect, test } from 'bun:test';
import {
  TurnContextBudget,
  citesSpillAddress,
  SPILL_DIRS,
  DEFAULT_TURN_ADMIT_BUDGET_CHARS,
  TIGHTENED_RESULT_MAX_CHARS,
} from '../src/context-budget.js';

describe('TurnContextBudget', () => {
  test('the per-result cap is the configured one until the turn spends its admit budget', () => {
    const budget = new TurnContextBudget(1_000, 100);
    expect(budget.capFor(400)).toBe(400);
    budget.admit(400);
    expect(budget.capFor(400)).toBe(400);
    budget.admit(599);
    expect(budget.capFor(400)).toBe(400); // 999 < 1000 — still full fidelity
    budget.admit(1);
    expect(budget.capFor(400)).toBe(100); // spent → the floor
  });

  test('the floor never widens a caller that asked for something tighter', () => {
    const budget = new TurnContextBudget(10, 8_000);
    budget.admit(10);
    expect(budget.capFor(500)).toBe(500);
  });

  test('the defaults are three full-size results before the RLMEnv-style floor', () => {
    const budget = new TurnContextBudget();
    expect(DEFAULT_TURN_ADMIT_BUDGET_CHARS).toBe(120_000);
    expect(TIGHTENED_RESULT_MAX_CHARS).toBe(8_000);
    budget.admit(DEFAULT_TURN_ADMIT_BUDGET_CHARS - 1);
    expect(budget.capFor(40_000)).toBe(40_000);
    budget.admit(1);
    expect(budget.capFor(40_000)).toBe(TIGHTENED_RESULT_MAX_CHARS);
  });

  test('the snapshot counts admissions, omissions, per-producer trips, references and follow-ups', () => {
    const budget = new TurnContextBudget();
    expect(budget.active).toBe(false);
    budget.admit(120);
    budget.recordSpill({ producer: 'run', omitted: 900, referenced: true });
    budget.recordSpill({ producer: 'run', omitted: 100, referenced: false, tightened: true });
    budget.recordSpill({ producer: 'pasted_text', omitted: 50, referenced: true });
    budget.noteFollowUp();

    expect(budget.active).toBe(true);
    expect(budget.snapshot()).toEqual({
      admittedChars: 120,
      omittedChars: 1_050,
      trips: { run: 2, pasted_text: 1 },
      referenced: 2,
      tightened: 1,
      followUps: 1,
    });
  });

  test('reset clears the turn — a fresh turn starts at full fidelity', () => {
    const budget = new TurnContextBudget(100, 10);
    budget.admit(500);
    budget.recordSpill({ producer: 'web_fetch', omitted: 1, referenced: true });
    budget.noteFollowUp();
    budget.reset();
    expect(budget.active).toBe(false);
    expect(budget.capFor(40_000)).toBe(40_000);
    expect(budget.snapshot()).toEqual({
      admittedChars: 0, omittedChars: 0, trips: {}, referenced: 0, tightened: 0, followUps: 0,
    });
  });
});

describe('citesSpillAddress', () => {
  test('recognises every spill root — a read-back of any producer counts', () => {
    for (const dir of Object.values(SPILL_DIRS)) {
      expect(citesSpillAddress({ path: `${dir}/abc123.txt` })).toBe(true);
    }
  });

  test('finds the address anywhere in the arguments, including codemode source', () => {
    const code = `const t = await workspace.readFile('/${SPILL_DIRS.toolOutput}/x9.log');\n` +
      'const parts = t.match(/.{1,20000}/gs) ?? [];\n' +
      'return Promise.all(parts.map((p) => llm.query(`summarise: ${p}`)));';
    expect(citesSpillAddress({ code })).toBe(true);
    expect(citesSpillAddress(`read ${SPILL_DIRS.compaction}/sess/abc.md`)).toBe(true);
  });

  test('ordinary tool calls are not follow-ups', () => {
    expect(citesSpillAddress({ command: 'ls -la src' })).toBe(false);
    expect(citesSpillAddress({ path: '/local/notes.md' })).toBe(false);
    expect(citesSpillAddress(null)).toBe(false);
    expect(citesSpillAddress(undefined)).toBe(false);
  });

  test('an unserializable argument is not a follow-up rather than a throw', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(citesSpillAddress(cyclic)).toBe(false);
  });
});
