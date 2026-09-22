// The per-turn context budget and M1 trip counters: counter accounting, spill-address recognition, per-turn reset.

import { describe, expect, test } from 'bun:test';
import {
  TurnContextBudget,
  citesSpillAddress,
  SPILL_DIRS,
} from '../src/context-budget';

describe('TurnContextBudget', () => {
  test('the snapshot counts admissions, omissions, per-producer trips, references and follow-ups', () => {
    const budget = new TurnContextBudget();
    expect(budget.active).toBe(false);
    budget.admit(120);
    budget.recordSpill({ producer: 'shell', omitted: 900, referenced: true });
    budget.recordSpill({ producer: 'shell', omitted: 100, referenced: false });
    budget.recordSpill({ producer: 'pasted_text', omitted: 50, referenced: true });
    budget.noteFollowUp();

    expect(budget.active).toBe(true);
    expect(budget.snapshot()).toEqual({
      admittedChars: 120,
      omittedChars: 1_050,
      trips: { shell: 2, pasted_text: 1 },
      referenced: 2,
      followUps: 1,
    });
  });

  test('a turn that only admitted small results is inactive in nothing but its spill counters', () => {
    // `active` gates the durable row: dropping a no-spill turn's admitted chars would lose every spill rate's denominator.
    const budget = new TurnContextBudget();
    budget.admit(40);
    expect(budget.active).toBe(true);
    expect(budget.snapshot()).toMatchObject({ admittedChars: 40, omittedChars: 0, trips: {} });
  });

  test('reset clears the turn', () => {
    const budget = new TurnContextBudget();
    budget.admit(500);
    budget.recordSpill({ producer: 'web_fetch', omitted: 1, referenced: true });
    budget.noteFollowUp();
    budget.reset();
    expect(budget.active).toBe(false);
    expect(budget.snapshot()).toEqual({
      admittedChars: 0, omittedChars: 0, trips: {}, referenced: 0, followUps: 0,
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
      'return Promise.all(parts.map((p) => agents.hire({ lifetime: "task", role: "task", mission: `summarise: ${p}` })));';

    expect(citesSpillAddress({ code })).toBe(true);
    expect(citesSpillAddress(`read ${SPILL_DIRS.compaction}/sess/abc.md`)).toBe(true);
  });

  test('ordinary tool calls are not follow-ups', () => {
    expect(citesSpillAddress({ command: 'ls -la src' })).toBe(false);
    expect(citesSpillAddress({ path: 'notes.md' })).toBe(false);
    expect(citesSpillAddress(null)).toBe(false);
    expect(citesSpillAddress(undefined)).toBe(false);
  });
});
